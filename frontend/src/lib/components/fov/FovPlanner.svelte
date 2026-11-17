<script lang="ts">
  // The FOV planning tool: viewer + controls (FOV box and scan matrix). Bound to a
  // Selection, so it works on a session, locally in an MCP App, and on the website.
  import { MapsLoader } from "../../state/maps.svelte";
  import type { Selection } from "../../state/selection";
  import FovPanel from "./FovPanel.svelte";
  import FovViewer from "./FovViewer.svelte";

  let { sel, compact = false }: { sel: Selection; compact?: boolean } = $props();
  // svelte-ignore state_referenced_locally
  const maps = new MapsLoader(sel.client);
  const shown = $derived(maps.property(sel.state?.view.property ?? "density"));

  $effect(() => {
    if (sel.state) maps.load(sel.state.phantom);
  });
</script>

<div class="flex h-full w-full {compact ? 'flex-col' : 'flex-col md:flex-row'} bg-bg text-text">
  <div class="min-h-0 flex-1 {compact ? 'min-h-72' : 'min-h-96'}">
    {#if sel.state}
      <FovViewer fov={sel.state.fov} phantomUrl={maps.loading ? null : (shown?.url ?? null)} range={shown?.range ?? null} />
    {:else if sel.error}
      <p class="p-4 text-red-400">{sel.error}</p>
    {:else}
      <p class="p-4 text-muted">Lade Session …</p>
    {/if}
  </div>
  {#if sel.state}
    <aside class="{compact ? 'border-t' : 'border-t md:w-72 md:border-l md:border-t-0'} overflow-y-auto border-border bg-panel p-3">
      <FovPanel
        fov={sel.state.fov}
        matrix={sel.state.matrix}
        onfov={(c) => sel.patch({ fov: c })}
        onmatrix={(m) => sel.patch({ matrix: m })}
      />
      {#if sel.error || maps.error}
        <p class="mt-3 text-xs text-red-400">{sel.error ?? maps.error}</p>
      {/if}
    </aside>
  {/if}
</div>
