<script lang="ts">
  // The history tool: the tree of states of the session's project, newest first, as
  // a graph like `git log --graph`; every session a coloured marker at its state.
  // Undo, redo and a click on a state move only this session. With `sessions` (the
  // default; the website, the workspace) also: switch to another session of the
  // project, branch off a new one, rename or delete this one. Switching needs the
  // shell (`sel.navigate`); without it those controls are hidden too.
  import Redo2 from "@lucide/svelte/icons/redo-2";
  import GitBranch from "@lucide/svelte/icons/git-branch";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Trash from "@lucide/svelte/icons/trash";
  import Undo2 from "@lucide/svelte/icons/undo-2";
  import { onDestroy } from "svelte";
  import { m } from "../../../paraglide/messages.js";
  import { askConfirm, askText } from "../../dialog.svelte";
  import { actorName, childrenOf, graphRows } from "../../history";
  import { formatDateTime } from "../../i18n.svelte";
  import type { Selection } from "../../state/selection";
  import type { History, Session } from "../../types";

  let { sel, sessions: showSessions = true }: { sel: Selection; sessions?: boolean } = $props();

  const LANE = 14;
  const ROW = 30;
  const MID = ROW / 2;

  let history = $state<History | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);

  const key = $derived(sel.sessionKey);
  const graph = $derived(history ? graphRows(history.states) : null);
  const me = $derived(history?.sessions.find((s) => s.key === history?.session) ?? null);
  const atHead = $derived(history?.states.find((s) => s.hash === history?.head) ?? null);
  const canUndo = $derived(!!atHead?.parent);
  const canRedo = $derived(!!history && childrenOf(history.states, history.head).length > 0);
  // (a test host passes options as text)
  const switching = $derived(showSessions !== false && String(showSessions) !== "false" && !!sel.navigate);
  /** Sessions per state they are at. */
  const markers = $derived.by(() => {
    const out = new Map<string, History["sessions"]>();
    for (const s of history?.sessions ?? []) out.set(s.head, [...(out.get(s.head) ?? []), s]);
    return out;
  });

  async function load() {
    if (!key) return;
    try {
      history = await sel.client.getHistory(key, 300);
      error = null;
    } catch (e) {
      error = message(e);
    }
  }

  // Again whenever this session changes (here, by the AI, elsewhere), and now and
  // then for the other sessions of the project
  $effect(() => {
    void sel.rev;
    void load();
  });
  const timer = setInterval(() => void load(), 5000);
  onDestroy(() => clearInterval(timer));

  async function act(fn: () => Promise<Session | void>) {
    if (busy) return;
    busy = true;
    try {
      const r = await fn();
      if (r) sel.accept?.(r);
      await load();
    } catch (e) {
      error = message(e);
    } finally {
      busy = false;
    }
  }

  const undo = () => act(() => sel.client.undo(key!));
  const redo = () => act(() => sel.client.redo(key!));
  const goto = (hash: string) => (hash === history?.head ? undefined : act(() => sel.client.gotoState(key!, hash)));

  async function branch() {
    const name = await askText({
      title: m.history_branch(),
      input: me ? `${me.name} 2` : "",
      placeholder: m.history_new_name(),
      confirm: m.history_branch_ok(),
    });
    if (name === null) return;
    void act(async () => {
      const s = await sel.client.createSession(key!, name);
      sel.navigate?.(s.key);
    });
  }

  async function rename() {
    const name = await askText({ title: m.history_rename(), input: me?.name ?? "", placeholder: m.history_new_name(), confirm: m.app_rename() });
    if (name === null) return;
    void act(() => sel.client.renameSession(key!, name));
  }

  async function remove() {
    const ok = await askConfirm({
      title: m.history_delete(),
      message: m.history_confirm_delete({ name: me?.name ?? "" }),
      confirm: m.app_delete(),
      danger: true,
    });
    if (!ok) return;
    void act(async () => {
      const r = await sel.client.deleteSession(key!);
      if (r.next) sel.navigate?.(r.next.key);
    });
  }

  const label = (change: string[], root: boolean) => (change.length ? change.join(", ") : root ? m.history_start() : "–");
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
</script>

<div class="flex h-full min-h-0 flex-col gap-2 p-2 text-sm text-text">
  <div class="flex flex-wrap items-center gap-1">
    <button type="button" class="btn-icon btn-icon-sm hover:preset-tonal" aria-label={m.history_undo()} title={m.history_undo()} disabled={!canUndo || busy} onclick={undo}>
      <Undo2 class="size-4" aria-hidden="true" />
    </button>
    <button type="button" class="btn-icon btn-icon-sm hover:preset-tonal" aria-label={m.history_redo()} title={m.history_redo()} disabled={!canRedo || busy} onclick={redo}>
      <Redo2 class="size-4" aria-hidden="true" />
    </button>
    {#if switching && history}
      <span class="ml-2 size-3 shrink-0 rounded-full" style="background: {me?.color ?? 'transparent'}" aria-hidden="true"></span>
      <select
        class="select min-w-0 flex-1 py-0.5 text-xs"
        aria-label={m.history_session()}
        value={history.session}
        onchange={(e) => sel.navigate?.(e.currentTarget.value)}
      >
        {#each history.sessions as s (s.key)}<option value={s.key}>{s.name}</option>{/each}
      </select>
      <button type="button" class="btn-icon btn-icon-sm hover:preset-tonal" aria-label={m.history_branch()} title={m.history_branch()} disabled={busy} onclick={branch}>
        <GitBranch class="size-4" aria-hidden="true" />
      </button>
      <button type="button" class="btn-icon btn-icon-sm hover:preset-tonal" aria-label={m.history_rename()} title={m.history_rename()} disabled={busy} onclick={rename}>
        <Pencil class="size-4" aria-hidden="true" />
      </button>
      <button type="button" class="btn-icon btn-icon-sm hover:preset-tonal-error" aria-label={m.history_delete()} title={m.history_delete()} disabled={busy} onclick={remove}>
        <Trash class="size-4" aria-hidden="true" />
      </button>
    {:else if me}
      <span class="ml-2 size-3 shrink-0 rounded-full" style="background: {me.color}" aria-hidden="true"></span>
      <span class="truncate text-xs">{me.name}</span>
    {/if}
  </div>

  {#if error}<p class="text-xs text-error-500">{error}</p>{/if}

  {#if !key}
    <p class="text-xs text-muted">{m.workspace_needs_session({ tool: "history" })}</p>
  {:else if !history || !graph}
    <p class="text-xs text-muted">{m.history_loading()}</p>
  {:else}
    <ol class="min-h-0 flex-1 overflow-auto">
      {#each graph.rows as row (row.state.hash)}
        {@const here = markers.get(row.state.hash) ?? []}
        {@const current = row.state.hash === history.head}
        {@const x = (lane: number) => LANE / 2 + lane * LANE}
        <li>
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded px-1 text-left text-xs hover:preset-tonal {current ? 'preset-tonal-primary' : ''}"
            style="height: {ROW}px"
            title={m.history_goto()}
            aria-current={current}
            onclick={() => goto(row.state.hash)}
          >
            <!-- The graph: lanes from above (ending here or going on), this state, lanes below -->
            <svg class="shrink-0 text-muted" width={graph.lanes * LANE} height={ROW} aria-hidden="true">
              {#each row.above as l (l.from)}
                <line x1={x(l.from)} y1="0" x2={x(l.to)} y2={l.to === row.lane ? MID : ROW / 2} stroke="currentColor" stroke-width="1.5" />
                {#if l.to !== row.lane}<line x1={x(l.from)} y1={MID} x2={x(l.from)} y2={ROW} stroke="currentColor" stroke-width="1.5" />{/if}
              {/each}
              {#if row.state.parent}<line x1={x(row.lane)} y1={MID} x2={x(row.lane)} y2={ROW} stroke="currentColor" stroke-width="1.5" />{/if}
              <circle
                cx={x(row.lane)}
                cy={MID}
                r={current ? 5.5 : here.length ? 4.5 : 3}
                fill={here[0]?.color ?? "currentColor"}
                stroke={current ? "var(--color-text)" : "none"}
                stroke-width="1.5"
              />
            </svg>
            <span class="min-w-0 flex-1 truncate font-mono" title={row.state.change.join(", ")}>{label(row.state.change, !row.state.parent)}</span>
            {#each here as s (s.key)}
              <span class="shrink-0 truncate rounded px-1.5 py-0.5 text-[10px] text-white" style="background: {s.color}; max-width: 8rem" title={s.name}>{s.name}</span>
            {/each}
            <span class="shrink-0 truncate text-muted" style="max-width: 8rem" title={row.state.actor}>{actorName(row.state.actor)}</span>
            <span class="shrink-0 text-muted">{formatDateTime(new Date(row.state.time * 1000))}</span>
          </button>
        </li>
      {/each}
    </ol>
    {#if history.total > history.states.length}
      <p class="text-xs text-muted">{m.history_more({ count: history.total - history.states.length })}</p>
    {/if}
  {/if}
</div>
