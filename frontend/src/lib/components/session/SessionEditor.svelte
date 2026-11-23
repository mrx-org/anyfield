<script lang="ts">
  // The session's state as JSON to edit. "Update" sends what changed against the
  // loaded state (a merge patch, only if the session is still at the loaded revision);
  // if it does not validate, the server's message shows and the text stays. "Reload"
  // drops the edits and loads the current state. A warning on "Reload" says the
  // session has changed since it was loaded (by the AI, another tool or browser).
  // Bound to a Selection like every tool; the session (polled) or a local selection.
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Save from "@lucide/svelte/icons/save";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import { diffPatch } from "../../state/patch";
  import type { Selection } from "../../state/selection";
  import type { State, StatePatch } from "../../types";
  import JsonEditor from "./JsonEditor.svelte";

  let { sel }: { sel: Selection } = $props();

  /** What the text was loaded from. */
  let base = $state<{ rev: number | null; state: State; text: string } | null>(null);
  let text = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);
  let saved = $state<string | null>(null);

  const dirty = $derived(!!base && text !== base.text);
  const outdated = $derived(!!base && !!sel.state && JSON.stringify(sel.state) !== JSON.stringify(base.state));

  function load() {
    if (!sel.state) return;
    const state = $state.snapshot(sel.state) as State;
    const t = JSON.stringify(state, null, 2);
    base = { rev: sel.rev, state, text: t };
    text = t;
    error = null;
  }

  // The first state that arrives
  $effect(() => {
    if (!base && sel.state) load();
  });

  async function update() {
    if (!base) return;
    error = null;
    saved = null;
    let edited: unknown;
    try {
      edited = JSON.parse(text);
    } catch (e) {
      error = `Kein gültiges JSON: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    if (edited === null || typeof edited !== "object" || Array.isArray(edited)) {
      error = "Der Zustand muss ein JSON-Objekt sein.";
      return;
    }
    const patch = diffPatch(base.state as unknown as Record<string, unknown>, edited as Record<string, unknown>);
    if (!Object.keys(patch).length) {
      saved = "Keine Änderung.";
      return;
    }
    busy = true;
    try {
      await sel.commit(patch as StatePatch, base.rev ?? undefined);
      load();
      saved = sel.rev !== null ? `Gespeichert (rev ${sel.rev}).` : "Übernommen.";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function reload() {
    saved = null;
    load();
  }
</script>

<div class="flex h-full min-h-0 flex-col gap-2 p-1 text-sm text-text">
  {#if base}
    <!-- A new editor per load: a reload to the same text still drops the edits -->
    {#key base}
      <JsonEditor value={base.text} onchange={(t) => (text = t)} class="min-h-64 flex-1" />
    {/key}
    {#if error}
      <p class="whitespace-pre-wrap text-xs text-error-500" role="alert">{error}</p>
    {:else if saved}
      <p class="text-xs text-success-500">{saved}</p>
    {/if}
    <div class="flex items-center gap-2">
      <span class="text-xs text-muted">
        {base.rev !== null ? `rev ${base.rev}` : "lokal"}{dirty ? " · bearbeitet" : ""}
      </span>
      <button
        type="button"
        class="btn btn-sm preset-tonal ml-auto"
        onclick={reload}
        disabled={busy}
        title={outdated ? "Die Session hat sich seit dem Laden geändert" : "Änderungen verwerfen und neu laden"}
      >
        {#if outdated}
          <TriangleAlert class="size-4 text-warning-500" aria-label="Session geändert" />
        {:else}
          <RefreshCw class="size-4" aria-hidden="true" />
        {/if}
        Reload
      </button>
      <button type="button" class="btn btn-sm preset-filled-primary-500" onclick={update} disabled={busy || !dirty}>
        <Save class="size-4" aria-hidden="true" />
        Update
      </button>
    </div>
  {:else if sel.error}
    <p class="p-4 text-error-500">{sel.error}</p>
  {:else}
    <p class="p-4 text-muted">Lade Session …</p>
  {/if}
</div>
