<script lang="ts">
  // NiiVue view of one volume (e.g. a phantom map), the one viewer of all tools.
  // Two independent options: the layout (one plane, the 2×2 grid of three planes and
  // 3D, or chosen by the width) and the FOV box on top (none when `fov` is null).
  // While one plane is shown, the viewer picks it itself (a switch above it): the
  // plane is per viewer, not in the state.
  import { MULTIPLANAR_TYPE, NVMesh, Niivue, SHOW_RENDER, SLICE_TYPE } from "@niivue/niivue";
  import { SegmentedControl } from "@skeletonlabs/skeleton-svelte";
  import { onMount } from "svelte";
  import { fovMesh } from "../../geometry/fov";
  import { niftiName } from "../../state/maps.svelte";
  import type { Fov, Plane } from "../../types";

  export type Layout = "single" | "grid" | "auto";

  let {
    url,
    range = null,
    layout = "single",
    plane = $bindable("tra"),
    fov = null,
    class: cls = "w-full self-center",
    viewClass = "aspect-square w-full",
  }: {
    url: string | null;
    range?: [number, number] | null;
    /** `auto`: the grid from `GRID_MIN_WIDTH_PX` on, below it one plane. */
    layout?: Layout;
    /** The plane while one plane is shown; the switch above the view changes it. */
    plane?: Plane;
    /** The FOV box to draw; null: none. */
    fov?: Fov | null;
    /** The whole viewer, with the switch. */
    class?: string;
    /** The view itself (e.g. square, or filling the height). */
    viewClass?: string;
  } = $props();

  /** From this width on (CSS px), `auto` shows the grid: each tile is then ~240 px. */
  const GRID_MIN_WIDTH_PX = 480;
  const PLANES: { key: Plane; label: string }[] = [
    { key: "tra", label: "Tra" },
    { key: "cor", label: "Kor" },
    { key: "sag", label: "Sag" },
    { key: "3d", label: "3D" },
  ];
  const SLICE: Record<Plane, SLICE_TYPE> = {
    tra: SLICE_TYPE.AXIAL,
    cor: SLICE_TYPE.CORONAL,
    sag: SLICE_TYPE.SAGITTAL,
    "3d": SLICE_TYPE.RENDER,
  };
  const FOV_RGBA = new Uint8Array([245, 165, 36, 255]);

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
    const opts = range ? { cal_min: range[0], cal_max: range[1] } : {};
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
  {#if single}
    <SegmentedControl value={plane} onValueChange={(d) => d.value && (plane = d.value as Plane)}>
      <SegmentedControl.Control class="w-full">
        <SegmentedControl.Indicator />
        {#each PLANES as p (p.key)}
          <SegmentedControl.Item value={p.key} class="flex-1 text-xs">
            <SegmentedControl.ItemText>{p.label}</SegmentedControl.ItemText>
            <SegmentedControl.ItemHiddenInput />
          </SegmentedControl.Item>
        {/each}
      </SegmentedControl.Control>
    </SegmentedControl>
  {/if}
  <div class="relative {viewClass}">
    <canvas bind:this={canvas} class="absolute inset-0 h-full w-full"></canvas>
    {#if loadError}
      <p class="absolute inset-x-0 top-2 text-center text-xs text-error-500">Viewer: {loadError}</p>
    {/if}
  </div>
</div>
