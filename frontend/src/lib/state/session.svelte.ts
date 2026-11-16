import type { AnyfieldClient } from "../client/anyfield";
import type { Fov, SessionState } from "../types";

export interface SessionStoreOptions {
  /** Poll interval while the page is visible (ms). */
  pollMs?: number;
  /** Poll interval while hidden (ms). */
  hiddenPollMs?: number;
  /** Minimum time between FOV commits while dragging (ms). */
  commitMs?: number;
}

/**
 * Client-side view of one session. The server owns the state; this keeps the
 * last confirmed copy, polls for changes from others (e.g. the AI), and applies
 * local edits optimistically: a pending FOV wins over poll results until the
 * server has confirmed it.
 */
export class SessionStore {
  server = $state<SessionState | null>(null);
  pendingFov = $state<Fov | null>(null);
  error = $state<string | null>(null);
  readonly fov: Fov | null = $derived(this.pendingFov ?? this.server?.fov ?? null);

  private timer: ReturnType<typeof setTimeout> | null = null;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCommit = 0;
  private inFlight = false;
  private stopped = true;
  private opts: Required<SessionStoreOptions>;

  constructor(
    readonly client: AnyfieldClient,
    readonly key: string,
    opts: SessionStoreOptions = {},
  ) {
    this.opts = { pollMs: 500, hiddenPollMs: 5000, commitMs: 100, ...opts };
  }

  /** Accept a newer server state (from a poll, a tool result or a commit). */
  accept(state: SessionState): void {
    if (this.server && state.rev < this.server.rev) return;
    this.server = state;
    this.error = null;
  }

  async refresh(): Promise<void> {
    try {
      const r = await this.client.getSession(this.key, this.server?.rev);
      if (!("unchanged" in r)) this.accept(r);
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      await this.refresh();
      if (this.stopped) return;
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      this.timer = setTimeout(loop, hidden ? this.opts.hiddenPollMs : this.opts.pollMs);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Change the FOV locally right away; commit to the server throttled. */
  editFov(change: Partial<Fov>): void {
    const base = this.fov;
    if (!base) return;
    this.pendingFov = { ...base, ...change };
    this.scheduleCommit();
  }

  private scheduleCommit(): void {
    if (this.commitTimer || this.inFlight) return;
    const wait = Math.max(0, this.lastCommit + this.opts.commitMs - Date.now());
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      void this.commit();
    }, wait);
  }

  private async commit(): Promise<void> {
    const sent = this.pendingFov;
    if (!sent) return;
    this.inFlight = true;
    this.lastCommit = Date.now();
    try {
      const r = await this.client.setFov(this.key, $state.snapshot(sent));
      if (this.server && r.rev > this.server.rev) this.server = { ...this.server, rev: r.rev, fov: r.fov };
      // Changed again while the request was out? Then keep it pending and send again.
      if (this.pendingFov === sent) this.pendingFov = null;
      this.error = null;
    } catch (e) {
      console.warn("anyfield: FOV commit failed", e);
      this.pendingFov = null; // fall back to the server's state
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.inFlight = false;
      if (this.pendingFov) this.scheduleCommit();
    }
  }

  /** Collection + phantom being selected by this client (preparing can take a minute). */
  selecting = $state<{ collection: string; name: string } | null>(null);

  async selectPhantom(collection: string, name: string): Promise<void> {
    this.selecting = { collection, name };
    await this.act(() => this.client.selectPhantom(this.key, collection, name, this.server?.phantom.property));
    this.selecting = null;
  }

  setPhantomProperty(property: string): Promise<void> {
    return this.act(() => this.client.setPhantomProperty(this.key, property));
  }

  /** Run a tool call, then re-read the session; an error stays visible after the refresh. */
  private async act(fn: () => Promise<unknown>): Promise<void> {
    let error: string | null = null;
    try {
      await fn();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    await this.refresh();
    if (error) this.error = error;
  }

  /** Resolves once no local edit is pending or in flight (for tests). */
  async settled(): Promise<void> {
    while (this.pendingFov || this.inFlight || this.commitTimer) await new Promise((r) => setTimeout(r, 5));
  }
}
