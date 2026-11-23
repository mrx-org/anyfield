<script lang="ts">
  // NiiVue view of a phantom's maps, the one viewer of all tools.
  // Two independent options: the layout (one plane, the 2×2 grid of three planes and
  // 3D, or chosen by the width) and the FOV box on top (none when `fov` is null).
  // Above the view: the property shown (PD, T1, ...; state field `view.property`, the
  // same in all viewers, so it comes in and goes out through `onproperty`) and, while
  // one plane is shown, the plane (per viewer, not in the state).
  import { MULTIPLANAR_TYPE, NVMesh, Niivue, SHOW_RENDER, SLICE_TYPE } from "@niivue/niivue";
  import { onMount } from "svelte";
  import { fovMesh } from "../../geometry/fov";
  import { niftiName } from "../../state/maps.svelte";
  import type { Fov, PhantomMaps, Plane } from "../../types";

  export type Layout = "single" | "grid" | "auto";

  let {
    maps,
    loading = false,
    property,
    onproperty,
    layout = "single",
    plane = $bindable("tra"),
    fov = null,
    class: cls = "w-full self-center",
    viewClass = "aspect-square w-full",
  }: {
    /** The maps to show; null: none (yet). */
    maps: PhantomMaps | null;
    /** New maps are on their way: the old ones stay until they are there. */
    loading?: boolean;
    /** Key of the property shown; a phantom without it shows its first map (PD). */
    property: string;
    /** The user picked another property. */
    onproperty: (key: string) => void;
    /** `auto`: the grid from `GRID_MIN_WIDTH_PX` on, below it one plane. */
    layout?: Layout;
    /** The plane while one plane is shown; the dropdown above the view changes it. */
    plane?: Plane;
    /** The FOV box to draw; null: none. */
    fov?: Fov | null;
    /** The whole viewer, with the dropdowns. */
    class?: string;
    /** The view itself (e.g. square, or filling the height). */
    viewClass?: string;
  } = $props();

  /** From this width on (CSS px), `auto` shows the grid: each tile is then ~240 px. */
  const GRID_MIN_WIDTH_PX = 480;
  const PLANES: { key: Plane; label: string }[] = [
    { key: "tra", label: "Transversal" },
    { key: "cor", label: "Koronal" },
    { key: "sag", label: "Sagittal" },
    { key: "3d", label: "3D" },
  ];
  const SLICE: Record<Plane, SLICE_TYPE> = {
    tra: SLICE_TYPE.AXIAL,
    cor: SLICE_TYPE.CORONAL,
    sag: SLICE_TYPE.SAGITTAL,
    "3d": SLICE_TYPE.RENDER,
  };
  const FOV_RGBA = new Uint8Array([245, 165, 36, 255]);

  const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(2));

  /** The body's background colour as RGBA in 0..1, for NiiVue. A 2D canvas turns
   * any CSS colour (rgb, oklch, ...) into RGB. */
  function pageBackground(): [number, number, number, number] {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return [0, 0, 0, 1];
    ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return [r / 255, g / 255, b / 255, 1];
  }

  let box: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let nv: Niivue | null = null;
  let mesh: NVMesh | null = null;
  let ready = $state(false);
  let loaded: string | null = null;
  let loadError = $state<string | null>(null);
  let width = $state(0);
  const shown = $derived(maps?.properties.find((p) => p.key === property) ?? maps?.properties[0] ?? null);
  const url = $derived(loading ? null : (shown?.url ?? null));
  const range = $derived(shown?.range ?? null);
  const single = $derived(layout === "single" || (layout === "auto" && width < GRID_MIN_WIDTH_PX));

  onMount(() => {
    const ro = new ResizeObserver(([e]) => (width = e.contentRect.width));
    ro.observe(box);
    nv = new Niivue({
      // The page's background (transparent comes out black)
      backColor: pageBackground(),
      show3Dcrosshair: false,
      multiplanarLayout: MULTIPLANAR_TYPE.GRID,
      multiplanarShowRender: SHOW_RENDER.ALWAYS,
      // Project the whole box onto every 2D view, not only what crosses the slice
      meshThicknessOn2D: Infinity,
      crosshairColor: [1, 0.2, 0.2, 0.6],
      loadingText: "",
    });
    nv.attachToCanvas(canvas).then(
      () => (ready = true),
      (e) => (loadError = e instanceof Error ? e.message : String(e)),
    );
    return () => {
      ro.disconnect();
      mesh = null;
      nv = null;
    };
  });

  // In the grid the crosshair shows where the three planes cut; one plane needs none
  $effect(() => {
    if (!ready || !nv) return;
    nv.setCrosshairWidth(single ? 0 : 0.5);
    nv.setSliceType(single ? SLICE[plane] : SLICE_TYPE.MULTIPLANAR);
  });

  // A new URL (other phantom, property or grid) replaces the volume. While maps are
  // prepared the URL is null and the old one stays.
  $effect(() => {
    if (!ready || !nv || !url || url === loaded) return;
    loaded = url;
    const r = $state.snapshot(range);
    const opts = r ? { cal_min: r[0], cal_max: r[1] } : {};
    nv.loadVolumes([{ url, name: niftiName(url), ...opts }])
      .then(() => {
        loadError = null;
        nv?.drawScene();
      })
      .catch((e) => (loadError = e instanceof Error ? e.message : String(e)));
  });

  $effect(() => {
    if (!ready || !nv) return;
    if (!fov) {
      if (mesh) nv.removeMesh(mesh);
      mesh = null;
      nv.drawScene();
      return;
    }
    const { pts, tris } = fovMesh(fov);
    if (!mesh || mesh.pts.length !== pts.length) {
      if (mesh) nv.removeMesh(mesh);
      mesh = new NVMesh(pts, tris, "FOV", FOV_RGBA, 1, true, nv.gl);
      nv.addMesh(mesh);
    } else {
      mesh.pts = pts;
      mesh.updateMesh(nv.gl);
    }
    nv.drawScene();
  });
</script>

<div bind:this={box} class="flex flex-col gap-1 {cls}">
  <div class="flex items-center gap-1">
    {#if single}
      <select
        class="select min-w-0 flex-1 text-xs"
        aria-label="Ebene"
        value={plane}
        onchange={(e) => (plane = e.currentTarget.value as Plane)}
      >
        {#each PLANES as p (p.key)}<option value={p.key}>{p.label}</option>{/each}
      </select>
    {/if}
    <select
      class="select min-w-0 flex-1 text-xs"
      aria-label="Eigenschaft"
      value={shown?.key ?? ""}
      disabled={!maps}
      onchange={(e) => onproperty(e.currentTarget.value)}
    >
      {#each maps?.properties ?? [] as p (p.key)}<option value={p.key}>{p.label}</option>{/each}
    </select>
  </div>
  <div class="relative {viewClass}">
    <canvas bind:this={canvas} class="absolute inset-0 h-full w-full"></canvas>
    {#if loadError}
      <p class="absolute inset-x-0 top-2 text-center text-xs text-error-500">Viewer: {loadError}</p>
    {/if}
  </div>
  {#if shown?.range}
    <span class="text-xs text-muted">{shown.label}: {fmt(shown.range[0])} … {fmt(shown.range[1])} {shown.unit}</span>
  {/if}
</div>
