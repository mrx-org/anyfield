<script lang="ts">
  // The phantom preview: a large, square view of the chosen phantom and its tissues
  // (state field `tissues`, picked in the browser), with the property to pick (state
  // field `view`); the viewer picks its plane itself. Loads the phantom's maps only while it is shown. Standalone (open_phantom_preview) or nested in the browser.
  // With a `grid` (FOV + matrix), the maps are resliced onto that grid (nested in the FOV planner).
  import { phantomSource } from "../../phantom";
  import { MapsLoader } from "../../state/maps.svelte";
  import { DEFAULT_PHANTOM } from "../../state/patch";
  import type { Selection } from "../../state/selection";
  import type { PhantomChoice, ScanGrid } from "../../types";
  import PhantomViewer from "./PhantomViewer.svelte";

  let { sel, grid = null }: { sel: Selection; grid?: ScanGrid | null } = $props();

  // Several tissue clicks in a row (browser, AI) compute the maps once (each takes seconds)
  const LOAD_DELAY_MS = 400;
  // Every new grid is resliced by the gateway (seconds): only once the FOV rests
  const RESLICE_DELAY_MS = 800;

  // svelte-ignore state_referenced_locally
  const maps = new MapsLoader(sel.client);
  const phantom = $derived(sel.state?.phantom ?? null);
  const name = $derived((phantom ?? DEFAULT_PHANTOM).name.replace(/\.(json|zip)$/, ""));
  const shown = $derived(maps.property(sel.state?.view.property ?? "density"));
  /** Tissues chosen; null: all. */
  const chosen = $derived(sel.state?.tissues?.length ? sel.state.tissues : null);

  // The maps to load: phantom, tissues and grid together, so a new phantom never goes out
  // with the old one's tissues. The first request goes at once, later ones settle first.
  let request = $state<{ phantom: PhantomChoice | null; tissues: string[] | null; grid: ScanGrid | null } | null>(
    null,
  );
  // Not reactive: reading `request` here would re-run this effect on every request it sets
  let requested = false;
  $effect(() => {
    if (!sel.state) return;
    const next = $state.snapshot({ phantom, tissues: chosen, grid });
    if (!requested) {
      requested = true;
      request = next;
      return;
    }
    const t = setTimeout(() => (request = next), next.grid ? RESLICE_DELAY_MS : LOAD_DELAY_MS);
    return () => clearTimeout(t);
  });
  $effect(() => {
    if (request) maps.load(request.phantom, request.grid ?? undefined, request.tissues);
  });

  const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(2));
</script>

<div class="flex flex-col gap-2 p-2 text-sm text-text">
  <div class="flex items-baseline gap-2">
    <span class="truncate font-medium" title="{(phantom ?? DEFAULT_PHANTOM).name} ({phantomSource(phantom ?? DEFAULT_PHANTOM)})">
      {name}{#if !phantom}<span class="ml-1 text-xs font-normal text-muted">(Standard)</span>{/if}
    </span>
    {#if maps.loading}<span class="shrink-0 text-xs text-accent">wird vorbereitet …</span>{/if}
  </div>

  <PhantomViewer url={maps.loading ? null : (shown?.url ?? null)} range={shown?.range ?? null} />

  <select
    class="select text-xs"
    aria-label="Eigenschaft"
    value={shown?.key ?? ""}
    disabled={!maps.maps}
    onchange={(e) => sel.patch({ view: { property: e.currentTarget.value } })}
  >
    {#each maps.maps?.properties ?? [] as p (p.key)}<option value={p.key}>{p.label}</option>{/each}
  </select>

  {#if shown?.range}
    <span class="text-xs text-muted">{shown.label}: {fmt(shown.range[0])} … {fmt(shown.range[1])} {shown.unit}</span>
  {/if}
  {#if grid && maps.maps && maps.maps.coarsening > 1}
    <span class="text-xs text-muted">Im FOV-Raster, {maps.maps.coarsening}× vergröbert</span>
  {/if}
  {#if maps.error}<p class="text-xs text-error-500">{maps.error}</p>{/if}
  {#if sel.error}<p class="text-xs text-error-500">{sel.error}</p>{/if}
</div>
