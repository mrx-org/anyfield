<script lang="ts">
  // The visual FOV planner: the phantom with the FOV box on top. Wide, it shows the
  // 2×2 grid (three planes and 3D); narrow, one plane with a switch above it (per
  // viewer, not in the state). Tissues and property follow the state (`tissues`,
  // `view.property`, the property picked in any viewer), as in the phantom preview. The sliders are the FOV planner (FovPlanner).
  // Bound to a Selection, so it works on a session, locally in an MCP App, and on the website.
  import { MapsLoader } from "../../state/maps.svelte";
  import type { Selection } from "../../state/selection";
  import PhantomViewer from "../phantom/PhantomViewer.svelte";

  let { sel }: { sel: Selection } = $props();

  // svelte-ignore state_referenced_locally
  const maps = new MapsLoader(sel.client);

  $effect(() => {
    if (sel.state) maps.load(sel.state.phantom, undefined, sel.state.tissues ?? null);
  });
</script>

<div class="flex h-full min-h-64 flex-col gap-1 text-sm text-text">
  {#if sel.state}
    <PhantomViewer
      maps={maps.maps}
      loading={maps.loading}
      property={sel.state.view.property}
      onproperty={(property) => sel.patch({ view: { property } })}
      fov={sel.state.fov}
      layout="auto"
      class="min-h-0 w-full flex-1"
      viewClass="min-h-0 w-full flex-1"
    />
  {:else if sel.error}
    <p class="p-4 text-error-500">{sel.error}</p>
  {:else}
    <p class="p-4 text-muted">Lade Session …</p>
  {/if}
  {#if maps.loading}<p class="text-xs text-accent">Phantom wird vorbereitet …</p>{/if}
  {#if sel.state && (sel.error || maps.error)}
    <p class="text-xs text-error-500">{sel.error ?? maps.error}</p>
  {/if}
</div>
