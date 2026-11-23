<script lang="ts">
  // NiiVue view of a phantom's maps, the one viewer of all tools.
  // Two independent options: the layout (one plane, the 2×2 grid of three planes and
  // 3D, or chosen by the width) and the FOV box on top (none when `fov` is null).
  // Above the view: the property shown (PD, T1, ...; state field `view.property`, the
  // same in all viewers, so it comes in and goes out through `onproperty`) and, while
  // one plane is shown, the plane (per viewer, not in the state).
  // With `onfov`, the box is edited with the mouse in the 2D tiles: Ctrl (or Cmd) +
  // left drag moves the box with the mouse in the tile's plane (held where it was
  // grabbed), Ctrl + right drag turns it about the tile's normal (Shift: finer),
  // Ctrl + wheel resizes the box axis along the tile's vertical (by how far the wheel
  // turns, ~2 mm per notch; Shift: finer). Without Ctrl, NiiVue handles the mouse.
  import { MULTIPLANAR_TYPE, NVMesh, Niivue, SHOW_RENDER, SLICE_TYPE } from "@niivue/niivue";
  import { onMount } from "svelte";
  import { boxAxisAlong, fovMesh, rotateAboutWorldAxis } from "../../geometry/fov";
  import { niftiName } from "../../state/maps.svelte";
  import type { Fov, PhantomMaps, Plane, Vec3 } from "../../types";

  export type Layout = "single" | "grid" | "auto";

  let {
    maps,
    loading = false,
    property,
    onproperty,
    layout = "single",
    plane = $bindable("tra"),
    fov = null,
    onfov,
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
    /** Given: the box can be edited with the mouse (Ctrl + drag or wheel), changes go out here. */
    onfov?: (change: Partial<Fov>) => void;
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
  let view: HTMLDivElement;
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
    // Capture on the parent: before NiiVue's own listeners on the canvas
    view.addEventListener("mousedown", onDown, { capture: true });
    view.addEventListener("wheel", onWheel, { capture: true, passive: false });
    view.addEventListener("contextmenu", onContextMenu, { capture: true });
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
      view.removeEventListener("mousedown", onDown, { capture: true });
      view.removeEventListener("wheel", onWheel, { capture: true });
      view.removeEventListener("contextmenu", onContextMenu, { capture: true });
      endDrag();
      cancelAnimationFrame(frame);
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

  // --- Editing the FOV box with the mouse -------------------------------------------

  /** Per 2D tile (axCorSag 0: axial, 1: coronal, 2: sagittal): its world axes
   * (horizontal, vertical), its normal, and the turn about the normal (+1/-1) that
   * moves the horizontal axis towards the vertical one. */
  const TILE = [
    { axes: [0, 1], normal: 2, turn: 1 },
    { axes: [0, 2], normal: 1, turn: -1 },
    { axes: [1, 2], normal: 0, turn: 1 },
  ] as const;
  const MAX_SIZE_MM = 600;
  const MM_PER_WHEEL_PX = 0.02;

  type Hit = { mm: Vec3; tile: number; axCorSag: 0 | 1 | 2 };
  type Drag =
    | { kind: "move"; tile: number; axCorSag: 0 | 1 | 2; center: Vec3; grab: Vec3 }
    | { kind: "rotate"; tile: number; axCorSag: 0 | 1 | 2; center: Vec3; rotation: Vec3; angle: number };
  let drag: Drag | null = null;

  /** The world point under the mouse in a 2D tile (`tile`: only that one), or null. */
  function hit(e: MouseEvent, tile = -1): Hit | null {
    if (!nv) return null;
    const rect = canvas.getBoundingClientRect();
    const dpr = nv.uiData.dpr ?? window.devicePixelRatio ?? 1;
    const r = nv.screenXY2mm((e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr, tile);
    if (!Number.isFinite(r[0])) return null;
    const axCorSag = nv.screenSlices[r[3]]?.axCorSag;
    if (axCorSag !== 0 && axCorSag !== 1 && axCorSag !== 2) return null;
    return { mm: [r[0], r[1], r[2]], tile: r[3], axCorSag };
  }

  const editing = (e: MouseEvent) => !!onfov && !!fov && (e.ctrlKey || e.metaKey);

  /** Angle (rad) of `mm` about `center` in the tile's plane. */
  function angleIn(axCorSag: 0 | 1 | 2, center: Vec3, mm: Vec3): number {
    const [h, v] = TILE[axCorSag].axes;
    return Math.atan2(mm[v] - center[v], mm[h] - center[h]);
  }

  // Changes go out at most once per frame (a drag fires far more mouse events)
  let pending: Partial<Fov> | null = null;
  let frame = 0;
  function send(change: Partial<Fov>) {
    pending = { ...pending, ...change };
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const c = pending;
      pending = null;
      if (c) onfov?.(c);
    });
  }

  const round = (v: number, step: number) => Math.round(v / step) * step;

  function onDown(e: MouseEvent) {
    if (!editing(e) || !fov || (e.button !== 0 && e.button !== 2)) return;
    const p = hit(e);
    if (!p) return; // 3D tile or outside: NiiVue's
    e.preventDefault();
    e.stopPropagation();
    const center = [...fov.center_mm] as Vec3;
    if (e.button === 0) {
      drag = { kind: "move", tile: p.tile, axCorSag: p.axCorSag, center, grab: p.mm };
    } else {
      const rotation = [...fov.rotation_deg] as Vec3;
      drag = { kind: "rotate", tile: p.tile, axCorSag: p.axCorSag, center, rotation, angle: angleIn(p.axCorSag, center, p.mm) };
    }
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", endDrag, true);
    apply(e, p);
  }

  function onMove(e: MouseEvent) {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    const p = hit(e, drag.tile);
    if (p) apply(e, p);
  }

  function apply(e: MouseEvent, p: Hit) {
    if (!drag) return;
    if (drag.kind === "move") {
      // The box moves as far as the mouse, in the tile's plane; its depth stays
      const c = [...drag.center] as Vec3;
      for (const a of TILE[drag.axCorSag].axes) c[a] = round(drag.center[a] + p.mm[a] - drag.grab[a], 0.1);
      send({ center_mm: c });
    } else {
      let d = angleIn(drag.axCorSag, drag.center, p.mm) - drag.angle;
      d = Math.atan2(Math.sin(d), Math.cos(d)); // to (-pi, pi]
      const deg = ((d * 180) / Math.PI) * (e.shiftKey ? 0.1 : 1);
      const t = TILE[drag.axCorSag];
      const r = rotateAboutWorldAxis(drag.rotation, t.normal, t.turn * deg);
      send({ rotation_deg: r.map((v) => round(v, 0.1)) as Vec3 });
    }
  }

  function endDrag() {
    if (!drag) return;
    drag = null;
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("mouseup", endDrag, true);
  }

  function onWheel(e: WheelEvent) {
    if (!editing(e) || !fov) return;
    const p = hit(e);
    if (!p) return;
    e.preventDefault(); // also the browser's Ctrl + wheel zoom
    e.stopPropagation();
    // Shift turns the wheel sideways in some browsers; deltaMode 1 counts lines, not pixels
    const px = (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 800 : 1);
    if (!px) return;
    // A mouse wheel notch is ~100 px: ~2 mm, Shift ~0.2 mm; a touchpad scrolls finer
    const mm = -px * MM_PER_WHEEL_PX * (e.shiftKey ? 0.1 : 1);
    const i = boxAxisAlong(fov.rotation_deg, TILE[p.axCorSag].axes[1]);
    const size = [...fov.size_mm] as Vec3;
    size[i] = Math.min(MAX_SIZE_MM, Math.max(1, round(size[i] + mm, 0.1)));
    send({ size_mm: size });
  }

  function onContextMenu(e: MouseEvent) {
    if (editing(e)) e.preventDefault();
  }
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
  <div bind:this={view} class="relative {viewClass}">
    <canvas bind:this={canvas} class="absolute inset-0 h-full w-full"></canvas>
    {#if loadError}
      <p class="absolute inset-x-0 top-2 text-center text-xs text-error-500">Viewer: {loadError}</p>
    {/if}
  </div>
  {#if shown?.range}
    <span class="text-xs text-muted">{shown.label}: {fmt(shown.range[0])} … {fmt(shown.range[1])} {shown.unit}</span>
  {/if}
</div>
