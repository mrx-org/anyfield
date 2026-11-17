<script lang="ts">
  // The FOV planning tool: viewer + controls (FOV box and scan matrix), and a preview
  // of the phantom resliced onto the planned scan grid. Bound to a Selection, so it
  // works on a session, locally in an MCP App, and on the website.
  import { MapsLoader } from "../../state/maps.svelte";
  import type { Selection } from "../../state/selection";
  import type { ScanGrid } from "../../types";
  import VolumePreview from "../phantom/VolumePreview.svelte";
  import FovPanel from "./FovPanel.svelte";
  import FovViewer from "./FovViewer.svelte";

  let { sel, compact = false }: { sel: Selection; compact?: boolean } = $props();
  // svelte-ignore state_referenced_locally
  const maps = new MapsLoader(sel.client);
  // svelte-ignore state_referenced_locally
  const resliced = new MapsLoader(sel.client);
  const property = $derived(sel.state?.view.property ?? "density");
  const shown = $derived(maps.property(property));
  const reslicedShown = $derived(resliced.property(property));

  // Every new grid is computed by the gateway (seconds): only once the FOV rests.
  const RESLICE_DELAY_MS = 800;
  let grid = $state<ScanGrid | null>(null);

  $effect(() => {
    if (sel.state) maps.load(sel.state.phantom);
  });

  $effect(() => {
    if (!sel.state) return;
    const next = $state.snapshot({ fov: sel.state.fov, matrix: sel.state.matrix });
    const t = setTimeout(() => (grid = next), RESLICE_DELAY_MS);
    return () => clearTimeout(t);
  });

  $effect(() => {
    if (sel.state && grid) resliced.load(sel.state.phantom, grid);
  });
</script>

<div class="flex h-full w-full {compact ? 'flex-col' : 'flex-col md:flex-row'} bg-bg text-text">
  <div class="min-h-0 flex-1 {compact ? 'min-h-72' : 'min-h-96'}">
    {#if sel.state}
      <FovViewer fov={sel.state.fov} phantomUrl={maps.loading ? null : (shown?.url ?? null)} range={shown?.range ?? null} />
    {:else if sel.error}
      <p class="p-4 text-error-500">{sel.error}</p>
    {:else}
      <p class="p-4 text-muted">Lade Session …</p>
    {/if}
  </div>
  {#if sel.state}
    <aside class="{compact ? 'border-t' : 'border-t md:w-72 md:border-l md:border-t-0'} flex flex-col gap-4 overflow-y-auto border-border bg-panel p-3">
      <FovPanel
        fov={sel.state.fov}
        matrix={sel.state.matrix}
        onfov={(c) => sel.patch({ fov: c })}
        onmatrix={(m) => sel.patch({ matrix: m })}
      />
      <section class="flex flex-col gap-1.5">
        <h3 class="flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
          Im Scan-Raster
          {#if resliced.loading}<span class="font-normal normal-case tracking-normal text-accent">berechne …</span>{/if}
        </h3>
        <VolumePreview url={reslicedShown?.url ?? null} range={reslicedShown?.range ?? null} />
        {#if resliced.maps && resliced.maps.coarsening > 1}
          <span class="text-xs text-muted">Vorschau {resliced.maps.coarsening}× vergröbert</span>
        {/if}
        {#if resliced.error}<p class="text-xs text-error-500">{resliced.error}</p>{/if}
      </section>
      {#if sel.error || maps.error}
        <p class="text-xs text-error-500">{sel.error ?? maps.error}</p>
      {/if}
    </aside>
  {/if}
</div>
