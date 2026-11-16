<script lang="ts">
  // Small single-plane NiiVue view of one volume (e.g. the selected phantom map).
  import { Niivue, SLICE_TYPE } from "@niivue/niivue";
  import { onMount } from "svelte";

  let { url, range = null }: { url: string | null; range?: [number, number] | null } = $props();

  let canvas: HTMLCanvasElement;
  let nv: Niivue | null = null;
  let ready = $state(false);
  let loaded: string | null = null;

  onMount(async () => {
    nv = new Niivue({ backColor: [0.06, 0.07, 0.08, 1], show3Dcrosshair: false, crosshairWidth: 0, loadingText: "" });
    await nv.attachToCanvas(canvas);
    nv.setSliceType(SLICE_TYPE.AXIAL);
    ready = true;
  });

  $effect(() => {
    if (!ready || !nv || !url || url === loaded) return;
    loaded = url;
    const opts = range ? { cal_min: range[0], cal_max: range[1] } : {};
    void nv.loadVolumes([{ url, name: url.split("/").pop() ?? "map.nii.gz", ...opts }]);
  });
</script>

<div class="relative aspect-square w-full max-w-72 self-center">
  <canvas bind:this={canvas} class="absolute inset-0 h-full w-full"></canvas>
</div>
