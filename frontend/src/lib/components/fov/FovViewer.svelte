<script lang="ts">
  // The visual FOV planner: the phantom with the FOV box on top, edited with the mouse
  // (Ctrl + drag and wheel, see PhantomViewer). Wide, it shows the 2×2 grid (three planes
  // and 3D); narrow, one plane with a dropdown above it (per viewer, not in the state).
  // Tissues and property follow the state (`tissues`, `view.property`), as in the
  // phantom preview. The sliders are the FOV planner (FovPlanner).
  // Bound to a Selection, so it works on a session, locally in an MCP App, and on the website.
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import { MapsLoader } from "../../state/maps.svelte";
  import { DEFAULT_STATE } from "../../state/patch";
  import type { Selection } from "../../state/selection";
  import type { Vec3 } from "../../types";
  import PhantomViewer from "../phantom/PhantomViewer.svelte";

  let { sel }: { sel: Selection } = $props();

  // svelte-ignore state_referenced_locally
  const maps = new MapsLoader(sel.client);

  $effect(() => {
    if (sel.state) maps.load(sel.state.phantom, undefined, sel.state.tissues ?? null);
  });

  const v = (x: Vec3, digits = 0) => x.map((n) => n.toFixed(digits)).join(" / ");
</script>

<div class="flex h-full min-h-64 flex-col gap-1 text-sm text-text">
  {#if sel.state}
    {@const fov = sel.state.fov}
    <PhantomViewer
      maps={maps.maps}
      loading={maps.loading}
      property={sel.state.view.property}
      onproperty={(property) => sel.patch({ view: { property } })}
      {fov}
      onfov={(change) => sel.patch({ fov: change })}
      layout="auto"
      class="min-h-0 w-full flex-1"
      viewClass="min-h-72 w-full flex-1"
    />
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted">
      <span title="Mitte (mm)">Pos {v(fov.center_mm, 1)}</span>
      <span title="Rotation um x, y, z (°)">Rot {v(fov.rotation_deg, 1)}</span>
      <span title="Größe (mm)">Größe {v(fov.size_mm)}</span>
      <button
        type="button"
        class="btn btn-sm preset-outlined-surface-300-700 ml-auto px-2 py-0.5 font-sans text-xs"
        onclick={() => sel.patch({ fov: DEFAULT_STATE.fov })}
      >
        <RotateCcw class="size-3.5" aria-hidden="true" />
        Zurücksetzen
      </button>
    </div>
    <p class="text-xs text-muted">Strg + ziehen: verschieben · Strg + Rechtsklick ziehen: drehen (Shift: fein) · Strg + Mausrad: Größe (Shift: 1 mm)</p>
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
