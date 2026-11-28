<script lang="ts">
  // NiiVue view of a phantom's maps, the one viewer of all tools.
  // Two independent options: the layout (one plane, the 2×2 grid of three planes and
  // 3D, or chosen by the width) and the FOV box on top (none when `fov` is null).
  // Above the view: the property shown (PD, T1, ...; state field `view.property`, the
  // same in all viewers, so it comes in and goes out through `onproperty`) and, while
  // one plane is shown, the plane (per viewer, not in the state). Below it: the
  // histogram of the shown property with the window (per viewer, not in the state;
  // a new volume starts at the property's value range). Dragging its lines or NiiVue's
  // right-drag windowing changes it, the other follows.
  // With `onfov`, the box is edited with the mouse in the 2D tiles: Ctrl (or Cmd) +
  // left drag moves the box with the mouse in the tile's plane (held where it was
  // grabbed), Ctrl + right drag turns it about the tile's normal (Shift: finer),
  // Ctrl + wheel resizes the box axis along the tile's vertical (by how far the wheel
  // turns, ~2 mm per notch; Shift: finer). Without Ctrl, NiiVue handles the mouse.
  // On touch screens a toggle above the view hands the fingers to the box: one finger
  // moves it, two fingers turn it (after a few degrees) and, spread along a box axis,
  // resize that axis (the axes turn with the box while turning).
  import { m } from "../../../paraglide/messages.js";
  import Info from "@lucide/svelte/icons/info";
  import Move from "@lucide/svelte/icons/move";
  import { MULTIPLANAR_TYPE, NVMesh, Niivue, SHOW_RENDER, SLICE_TYPE } from "@niivue/niivue";
  import { Popover, Portal } from "@skeletonlabs/skeleton-svelte";
  import { onMount } from "svelte";
  import Histogram from "./Histogram.svelte";
  import { boxAxisAlong, fovMesh, rotateAboutWorldAxis, rotationMatrix } from "../../geometry/fov";
  import { logHistogram } from "../../histogram";
  import { niftiName } from "../../state/maps.svelte";
  import { cssRgba, theme } from "../../theme.svelte";
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
  const PLANES: { key: Plane; label: () => string }[] = [
    { key: "tra", label: m.viewer_tra },
    { key: "cor", label: m.viewer_cor },
    { key: "sag", label: m.viewer_sag },
    { key: "3d", label: () => "3D" },
  ];
  const SLICE: Record<Plane, SLICE_TYPE> = {
    tra: SLICE_TYPE.AXIAL,
    cor: SLICE_TYPE.CORONAL,
    sag: SLICE_TYPE.SAGITTAL,
    "3d": SLICE_TYPE.RENDER,
  };
  const FOV_RGBA = new Uint8Array([245, 165, 36, 255]);

  /** The page's background (in an MCP App: the chat's) as RGBA for NiiVue. WebGL
   * cannot show the chat through it: transparent comes out black. */
  function pageBackground(): [number, number, number, number] {
    const [r, g, b] = cssRgba("var(--color-bg)");
    return [r, g, b, 1];
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
  /** Histogram of the loaded volume: bar heights over `axis`, and the window. */
  let hist = $state<{ bins: Float32Array; axis: [number, number]; label: string; unit: string } | null>(null);
  let win = $state<[number, number]>([0, 1]);
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
    view.addEventListener("touchstart", onTouch, { capture: true, passive: false });
    view.addEventListener("touchmove", onTouch, { capture: true, passive: false });
    view.addEventListener("touchend", onTouch, { capture: true, passive: false });
    view.addEventListener("touchcancel", onTouch, { capture: true, passive: false });
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
    // NiiVue's own windowing (right drag) moves the histogram's lines
    nv.onIntensityChange = (v) => (win = [v.cal_min ?? win[0], v.cal_max ?? win[1]]);
    nv.attachToCanvas(canvas).then(
      () => (ready = true),
      (e) => (loadError = e instanceof Error ? e.message : String(e)),
    );
    return () => {
      ro.disconnect();
      view.removeEventListener("mousedown", onDown, { capture: true });
      view.removeEventListener("wheel", onWheel, { capture: true });
      view.removeEventListener("contextmenu", onContextMenu, { capture: true });
      for (const t of ["touchstart", "touchmove", "touchend", "touchcancel"] as const)
        view.removeEventListener(t, onTouch, { capture: true });
      endDrag();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(windowFrame);
      mesh = null;
      nv = null;
    };
  });

  // Light/dark or the chat's colours changed: the view follows
  $effect(() => {
    void theme.version;
    if (!ready || !nv) return;
    nv.opts.backColor = pageBackground();
    nv.drawScene();
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
    const { label, unit } = shown ?? { label: "", unit: "" };
    nv.loadVolumes([{ url, name: niftiName(url), ...opts }])
      .then(() => {
        loadError = null;
        const vol = nv?.volumes[0];
        if (vol?.img) {
          const axis: [number, number] = r ?? [vol.global_min ?? 0, vol.global_max ?? 1];
          const bins = logHistogram(vol.img, axis[0], axis[1], 256, 2_000_000, (v) => vol.intensityRaw2Scaled(v));
          hist = { bins, axis, label, unit };
          win = [vol.cal_min ?? axis[0], vol.cal_max ?? axis[1]];
        }
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

  // The histogram's lines set NiiVue's window, at most once per frame
  let windowFrame = 0;
  function setWindow(w: [number, number]) {
    win = w;
    if (windowFrame) return;
    windowFrame = requestAnimationFrame(() => {
      windowFrame = 0;
      const vol = nv?.volumes[0];
      if (!nv || !vol) return;
      vol.cal_min = win[0];
      vol.cal_max = win[1];
      nv.updateGLVolume();
    });
  }

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
  function hit(e: { clientX: number; clientY: number }, tile = -1): Hit | null {
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

  function apply(e: { shiftKey: boolean }, p: Hit) {
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

  // --- Editing the FOV box with the fingers ------------------------------------------

  /** A touch screen (also a laptop with one): show the toggle that hands the fingers to the box. */
  const touchScreen = typeof window !== "undefined" && window.matchMedia("(any-pointer: coarse)").matches;
  /** Fingers edit the box instead of NiiVue (per viewer, off at first). */
  let touchEdit = $state(false);
  /** Degrees two fingers must turn before the box turns: a pinch alone always turns a little. */
  const TURN_DEAD_ZONE_DEG = 5;

  /** mm the fingers must spread along a box axis before that axis changes: spreading
   * along one axis always wobbles the other a little. */
  const SIZE_DEAD_ZONE_MM = 3;

  type Vec2 = [number, number];
  /** One box axis lying in the tile's plane, as the pinch sees it. */
  type PinchAxis = {
    index: 0 | 1 | 2; // box axis (FOV x, y, z)
    dir: Vec2; // its direction in the tile's plane (h, v), unit, at the start
    spread: number; // the fingers' distance along it at the start, mm
    offset: number; // the dead zone already used up (0 until the axis moves)
  };
  type Pinch = {
    tile: number;
    axCorSag: 0 | 1 | 2;
    rotation: Vec3;
    size: Vec3;
    angle: number; // of the line between the fingers, in the tile's plane
    turning: boolean;
    axes: PinchAxis[];
  };
  let pinch: Pinch | null = null;

  /** The two fingers in world mm (in `tile`, or wherever the first one is), or null. */
  function fingers(e: TouchEvent, tile = -1): [Hit, Hit] | null {
    const a = hit(e.touches[0], tile);
    const b = a ? hit(e.touches[1], a.tile) : null;
    return a && b ? [a, b] : null;
  }

  /** From finger `a` to finger `b` in the tile's plane (h, v), mm. */
  function between(axCorSag: 0 | 1 | 2, a: Vec3, b: Vec3): Vec2 {
    const [h, v] = TILE[axCorSag].axes;
    return [b[h] - a[h], b[v] - a[v]];
  }

  const along = (f: Vec2, dir: Vec2) => Math.abs(f[0] * dir[0] + f[1] * dir[1]);
  const turn2 = ([x, y]: Vec2, rad: number): Vec2 => [x * Math.cos(rad) - y * Math.sin(rad), x * Math.sin(rad) + y * Math.cos(rad)];

  /** The two box axes that lie (most) in the tile's plane, with their directions in it. */
  function planeAxes(axCorSag: 0 | 1 | 2, rotation: Vec3): { index: 0 | 1 | 2; dir: Vec2 }[] {
    const [h, v] = TILE[axCorSag].axes;
    const m = rotationMatrix(rotation); // column i: box axis i in world
    const first = boxAxisAlong(rotation, h);
    const rest = ([0, 1, 2] as const).filter((i) => i !== first);
    const second = Math.abs(m[v][rest[0]]) >= Math.abs(m[v][rest[1]]) ? rest[0] : rest[1];
    return [first, second].map((index) => {
      const x = m[h][index];
      const y = m[v][index];
      const n = Math.hypot(x, y) || 1;
      return { index, dir: [x / n, y / n] as Vec2 };
    });
  }

  function startPinch(e: TouchEvent) {
    const f = fingers(e);
    if (!f || !fov) return;
    const [a, b] = f;
    const rotation = [...fov.rotation_deg] as Vec3;
    const fb = between(a.axCorSag, a.mm, b.mm);
    pinch = {
      tile: a.tile,
      axCorSag: a.axCorSag,
      rotation,
      size: [...fov.size_mm] as Vec3,
      angle: angleIn(a.axCorSag, a.mm, b.mm),
      turning: false,
      axes: planeAxes(a.axCorSag, rotation).map((x) => ({ ...x, spread: along(fb, x.dir), offset: 0 })),
    };
  }

  function movePinch(e: TouchEvent) {
    if (!pinch) return;
    const f = fingers(e, pinch.tile);
    if (!f) return;
    const [a, b] = f;
    const t = TILE[pinch.axCorSag];
    let d = angleIn(pinch.axCorSag, a.mm, b.mm) - pinch.angle;
    d = (Math.atan2(Math.sin(d), Math.cos(d)) * 180) / Math.PI;
    if (!pinch.turning && Math.abs(d) > TURN_DEAD_ZONE_DEG) {
      // Turn from here on, without the jump of the dead zone
      pinch.turning = true;
      pinch.angle += (Math.sign(d) * TURN_DEAD_ZONE_DEG * Math.PI) / 180;
      d -= Math.sign(d) * TURN_DEAD_ZONE_DEG;
    }
    const turned = pinch.turning ? d : 0;
    const change: Partial<Fov> = {};
    if (pinch.turning) {
      change.rotation_deg = rotateAboutWorldAxis(pinch.rotation, t.normal, t.turn * turned).map((v) => round(v, 0.1)) as Vec3;
    }
    // Spreading along a box axis resizes that axis by as much as the fingers spread
    // along it. The axes turn with the box, so turning the fingers alone resizes nothing.
    const fb = between(pinch.axCorSag, a.mm, b.mm);
    const size = [...pinch.size] as Vec3;
    for (const x of pinch.axes) {
      const grow = along(fb, turn2(x.dir, (turned * Math.PI) / 180)) - x.spread;
      if (!x.offset && Math.abs(grow) > SIZE_DEAD_ZONE_MM) x.offset = Math.sign(grow) * SIZE_DEAD_ZONE_MM;
      if (!x.offset) continue;
      size[x.index] = Math.min(MAX_SIZE_MM, Math.max(1, round(pinch.size[x.index] + grow - x.offset, 0.1)));
    }
    change.size_mm = size;
    send(change);
  }

  function onTouch(e: TouchEvent) {
    if (!touchEdit || !onfov || !fov) return;
    e.preventDefault(); // no scrolling, no synthetic mouse events
    e.stopPropagation(); // and nothing for NiiVue
    const n = e.touches.length;
    if (e.type === "touchstart") {
      drag = null;
      pinch = null;
      if (n === 1) {
        const p = hit(e.touches[0]);
        if (p) drag = { kind: "move", tile: p.tile, axCorSag: p.axCorSag, center: [...fov.center_mm] as Vec3, grab: p.mm };
      } else if (n === 2) {
        startPinch(e);
      }
    } else if (e.type === "touchmove") {
      if (drag?.kind === "move" && n === 1) {
        const p = hit(e.touches[0], drag.tile);
        if (p) apply(e, p);
      } else if (pinch && n === 2) {
        movePinch(e);
      }
    } else {
      // A finger lifted: the gesture ends; the next touch starts a new one
      drag = null;
      pinch = null;
    }
  }
</script>

<div bind:this={box} class="flex flex-col gap-1 {cls}">
  <div class="flex items-center gap-1">
    {#if single}
      <select
        class="select min-w-0 flex-1 text-xs"
        aria-label={m.viewer_plane()}
        value={plane}
        onchange={(e) => (plane = e.currentTarget.value as Plane)}
      >
        {#each PLANES as p (p.key)}<option value={p.key}>{p.label()}</option>{/each}
      </select>
    {/if}
    <select
      class="select min-w-0 flex-1 text-xs"
      aria-label={m.viewer_property()}
      value={shown?.key ?? ""}
      disabled={!maps}
      onchange={(e) => onproperty(e.currentTarget.value)}
    >
      {#each maps?.properties ?? [] as p (p.key)}<option value={p.key}>{p.label}</option>{/each}
    </select>
    {#if onfov && touchScreen}
      <button
        type="button"
        class="btn-icon btn-icon-sm shrink-0 {touchEdit ? 'preset-filled-primary-500' : 'hover:preset-tonal'}"
        aria-label={m.viewer_touch_edit()}
        aria-pressed={touchEdit}
        title={m.viewer_touch_edit()}
        onclick={() => (touchEdit = !touchEdit)}
      >
        <Move class="size-4" aria-hidden="true" />
      </button>
    {/if}
    {#if onfov}
      <!-- How to edit the box: behind a button, the view stays free of text -->
      <Popover>
        <Popover.Trigger class="btn-icon btn-icon-sm hover:preset-tonal shrink-0" aria-label={m.viewer_help()}>
          <Info class="size-4" aria-hidden="true" />
        </Popover.Trigger>
        <Portal>
          <Popover.Positioner>
            <Popover.Content class="card max-w-72 space-y-2 bg-surface-100-900 p-3 text-xs shadow-xl">
              <Popover.Title class="font-semibold">{m.viewer_help_title()}</Popover.Title>
              <Popover.Description>
                <ul class="space-y-1">
                  <li><b>{m.help_move_key()}</b> {m.help_move()}</li>
                  <li><b>{m.help_rotate_key()}</b> {m.help_rotate_fine()}</li>
                  <li><b>{m.help_size_key()}</b> {m.help_size_fine()}</li>
                </ul>
                <p class="mt-2 text-muted">{m.help_without_ctrl()}</p>
                {#if touchScreen}
                  <p class="mt-2 font-semibold">{m.help_touch()}</p>
                  <ul class="space-y-1">
                    <li><b>{m.help_one_finger_key()}</b> {m.help_move()}</li>
                    <li><b>{m.help_turn_key()}</b> {m.help_turn()}</li>
                    <li><b>{m.help_spread_key()}</b> {m.help_spread()}</li>
                  </ul>
                {/if}
              </Popover.Description>
            </Popover.Content>
          </Popover.Positioner>
        </Portal>
      </Popover>
    {/if}
  </div>
  <div bind:this={view} class="relative {viewClass} {touchEdit ? 'touch-none' : ''}">
    <canvas bind:this={canvas} class="absolute inset-0 h-full w-full"></canvas>
    {#if loadError}
      <p class="absolute inset-x-0 top-2 text-center text-xs text-error-500">Viewer: {loadError}</p>
    {/if}
  </div>
  {#if hist}
    <Histogram bins={hist.bins} axis={hist.axis} window={win} onwindow={setWindow} label={hist.label} unit={hist.unit} />
  {/if}
</div>
