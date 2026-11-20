<script lang="ts">
  // The phantom preview: a large, square view of the chosen phantom, with the plane
  // and the property to pick (state field `view`). Loads the phantom's maps only
  // while it is shown. Standalone (open_phantom_preview) or nested in the browser.
  import { phantomSource } from "../../phantom";
  import { MapsLoader } from "../../state/maps.svelte";
  import { DEFAULT_PHANTOM } from "../../state/patch";
  import type { Selection } from "../../state/selection";
  import type { Plane } from "../../types";
  import VolumePreview from "./VolumePreview.svelte";

  let { sel }: { sel: Selection } = $props();

  const PLANES: { key: Plane; label: string }[] = [
    { key: "tra", label: "Transversal" },
    { key: "cor", label: "Koronal" },
    { key: "sag", label: "Sagittal" },
    { key: "3d", label: "3D" },
  ];

  // svelte-ignore state_referenced_locally
  const maps = new MapsLoader(sel.client);
  const phantom = $derived(sel.state?.phantom ?? null);
  const name = $derived((phantom ?? DEFAULT_PHANTOM).name.replace(/\.(json|zip)$/, ""));
  const shown = $derived(maps.property(sel.state?.view.property ?? "density"));
  const plane = $derived(sel.state?.view.plane ?? "tra");

  $effect(() => {
    if (sel.state) maps.load(phantom);
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

  <VolumePreview url={maps.loading ? null : (shown?.url ?? null)} range={shown?.range ?? null} {plane} class="" />

  <div class="grid grid-cols-2 gap-2">
    <select
      class="select text-xs"
      aria-label="Ansicht"
      value={plane}
      onchange={(e) => sel.patch({ view: { plane: e.currentTarget.value as Plane } })}
    >
      {#each PLANES as p (p.key)}<option value={p.key}>{p.label}</option>{/each}
    </select>
    <select
      class="select text-xs"
      aria-label="Eigenschaft"
      value={shown?.key ?? ""}
      disabled={!maps.maps}
      onchange={(e) => sel.patch({ view: { property: e.currentTarget.value } })}
    >
      {#each maps.maps?.properties ?? [] as p (p.key)}<option value={p.key}>{p.label}</option>{/each}
    </select>
  </div>

  {#if shown?.range}
    <span class="text-xs text-muted">{shown.label}: {fmt(shown.range[0])} … {fmt(shown.range[1])} {shown.unit}</span>
  {/if}
  {#if maps.error}<p class="text-xs text-error-500">{maps.error}</p>{/if}
  {#if sel.error}<p class="text-xs text-error-500">{sel.error}</p>{/if}
</div>
