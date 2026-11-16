<script lang="ts">
  // Phantom in NiiVue (three planes + 3D) with the FOV box as mesh on top.
  import { NVMesh, Niivue, SHOW_RENDER, SLICE_TYPE } from "@niivue/niivue";
  import { onDestroy, onMount } from "svelte";
  import { fovMesh } from "../../geometry/fov";
  import type { Fov } from "../../types";

  let { fov, phantomUrl }: { fov: Fov | null; phantomUrl: string } = $props();

  let canvas: HTMLCanvasElement;
  let nv: Niivue | null = null;
  let mesh: NVMesh | null = null;
  let ready = $state(false);
  let loadError = $state<string | null>(null);
  const FOV_RGBA = new Uint8Array([245, 165, 36, 255]);

  onMount(async () => {
    try {
      nv = new Niivue({
        backColor: [0.06, 0.07, 0.08, 1],
        show3Dcrosshair: true,
        isOrientCube: true,
        multiplanarShowRender: SHOW_RENDER.ALWAYS,
        // Project the whole box onto every 2D view, not only what crosses the slice
        meshThicknessOn2D: Infinity,
        crosshairWidth: 0.5,
        crosshairColor: [1, 0.2, 0.2, 0.6],
        loadingText: "Lade Phantom...",
      });
      await nv.attachToCanvas(canvas);
      nv.setSliceType(SLICE_TYPE.MULTIPLANAR);
      await nv.loadVolumes([{ url: phantomUrl, name: "phantom.nii.gz" }]);
      ready = true;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
  });

  onDestroy(() => {
    mesh = null;
    nv = null;
  });

  $effect(() => {
    if (!ready || !nv || !fov) return;
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

<div class="relative h-full w-full min-h-64">
  <canvas bind:this={canvas} class="absolute inset-0 h-full w-full"></canvas>
  {#if loadError}
    <p class="absolute inset-x-0 top-2 text-center text-sm text-red-400">Viewer: {loadError}</p>
  {/if}
</div>
