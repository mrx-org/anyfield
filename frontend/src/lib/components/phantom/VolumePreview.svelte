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

  let canvas: HTMLCanvasElement;
  let nv: Niivue | null = null;
  let ready = $state(false);
  let loaded: string | null = null;

  onMount(async () => {
    nv = new Niivue({ backColor: [0.06, 0.07, 0.08, 1], show3Dcrosshair: false, crosshairWidth: 0, loadingText: "" });
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
