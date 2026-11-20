<script lang="ts">
  // Square NiiVue view of one volume (e.g. a phantom map): one plane or a 3D rendering.
  import { Niivue, SLICE_TYPE } from "@niivue/niivue";
  import { onMount } from "svelte";
  import { niftiName } from "../../state/maps.svelte";
  import type { Plane } from "../../types";

  let {
    url,
    range = null,
    plane = "tra",
    class: cls = "max-w-72",
  }: { url: string | null; range?: [number, number] | null; plane?: Plane; class?: string } = $props();

  const SLICE: Record<Plane, SLICE_TYPE> = {
    tra: SLICE_TYPE.AXIAL,
    cor: SLICE_TYPE.CORONAL,
    sag: SLICE_TYPE.SAGITTAL,
    "3d": SLICE_TYPE.RENDER,
  };

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

  let canvas: HTMLCanvasElement;
  let nv: Niivue | null = null;
  let ready = $state(false);
  let loaded: string | null = null;

  onMount(async () => {
    // The page's background (transparent comes out black)
    nv = new Niivue({ backColor: pageBackground(), show3Dcrosshair: false, crosshairWidth: 0, loadingText: "" });
    await nv.attachToCanvas(canvas);
    ready = true;
  });

  $effect(() => {
    if (ready && nv) nv.setSliceType(SLICE[plane]);
  });

  $effect(() => {
    if (!ready || !nv || !url || url === loaded) return;
    loaded = url;
    const opts = range ? { cal_min: range[0], cal_max: range[1] } : {};
    void nv.loadVolumes([{ url, name: niftiName(url), ...opts }]);
  });
</script>

<div class="relative aspect-square w-full self-center {cls}">
  <canvas bind:this={canvas} class="absolute inset-0 h-full w-full"></canvas>
</div>
