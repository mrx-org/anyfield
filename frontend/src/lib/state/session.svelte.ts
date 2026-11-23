import type { AnyfieldClient } from "../client/anyfield";
import type { Session, State, StatePatch } from "../types";
import { applyPatch, composePatch } from "./patch";
import type { Selection } from "./selection";

export interface SessionStoreOptions {
  /** Poll interval while the page is visible (ms). */
  pollMs?: number;
  /** Poll interval while hidden (ms). */
  hiddenPollMs?: number;
  /** Minimum time between commits while dragging (ms). */
  commitMs?: number;
}

/**
 * Client-side view of one session. The server owns the state; this keeps the
 * last confirmed copy, polls for changes from others (e.g. the AI), and applies
 * local edits optimistically: pending patches win over poll results until the
 * server has confirmed them.
 */
export class SessionStore implements Selection {
  server = $state<Session | null>(null);
  /** Patch not yet confirmed by the server (accumulated). */
  pending = $state<StatePatch | null>(null);
  error = $state<string | null>(null);
  readonly state: State | null = $derived(
    this.server ? (this.pending ? applyPatch(this.server.state, this.pending) : this.server.state) : null,
  );

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

  get sessionKey(): string {
    return this.key;
  }

  get rev(): number | null {
    return this.server?.rev ?? null;
  }

  /** Accept a newer server state (from a poll, a tool result or a commit). */
  accept(session: Session): void {
    if (this.server && session.rev < this.server.rev) return;
    this.server = session;
    this.error = null;
  }

  async refresh(): Promise<void> {
    try {
      const r = await this.client.getState(this.key, this.server?.rev);
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

  /** Change the state locally right away; commit to the server throttled. */
  patch(patch: StatePatch): void {
    if (!this.server) return;
    // Composed, not merged: a `null` (removed phantom, or the field of the other kind
    // of phantom) must stay in the patch, not vanish from it
    this.pending = composePatch(this.pending ? ($state.snapshot(this.pending) as StatePatch) : {}, patch);
    this.scheduleCommit();
  }

  private scheduleCommit(): void {
    if (this.commitTimer || this.inFlight) return;
    const wait = Math.max(0, this.lastCommit + this.opts.commitMs - Date.now());
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      void this.flush();
    }, wait);
  }

  private async flush(): Promise<void> {
    const sent = this.pending;
    if (!sent) return;
    this.inFlight = true;
    this.lastCommit = Date.now();
    try {
      const r = await this.client.patchState(this.key, $state.snapshot(sent) as StatePatch);
      this.accept(r);
      // Changed again while the request was out? Then keep it pending and send again.
      if (this.pending === sent) this.pending = null;
    } catch (e) {
      console.warn("anyfield: commit failed", e);
      this.pending = null; // fall back to the server's state
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.inFlight = false;
      if (this.pending) this.scheduleCommit();
    }
  }

  /** Send a patch now and wait for the server: its error is thrown, not kept. Local
   * edits still pending go first, so they are not lost or overtaken. */
  async commit(patch: StatePatch, expectedRev?: number): Promise<void> {
    await this.settled();
    const r = await this.client.patchState(this.key, patch, expectedRev);
    this.accept(r);
  }

  /** Resolves once no local edit is pending or in flight (for tests). */
  async settled(): Promise<void> {
    while (this.pending || this.inFlight || this.commitTimer) await new Promise((r) => setTimeout(r, 5));
  }
}
