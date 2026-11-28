<script lang="ts">
  // Histogram of the shown property (log counts) with the window on top: two lines,
  // min (blue) and max (red), dragged with the mouse or a finger. Below it, the window
  // and the value range as text. Only draws; the viewer owns the window.
  import { m } from "../../../paraglide/messages.js";
  import { formatNumber, formatSignificant } from "../../i18n.svelte";
  import { onMount } from "svelte";

  let {
    bins,
    axis,
    window: win,
    onwindow,
    label,
    unit,
  }: {
    /** Bar heights 0..1 over `axis` (see `logHistogram`); null: none (yet). */
    bins: Float32Array | null;
    /** The value range the bins span. */
    axis: [number, number];
    /** The window shown (NiiVue's cal_min, cal_max). */
    window: [number, number];
    /** A line was dragged: the new window, min ≤ max. */
    onwindow: (w: [number, number]) => void;
    label: string;
    unit: string;
  } = $props();

  const MIN_COLOR = "#5ba4e6";
  const MAX_COLOR = "#e05555";
  /** How close (CSS px) the pointer must come to a line to grab it. */
  const GRAB_PX = 10;
  const PAD_X = 5;

  const fmt = (v: number) => (Math.abs(v) >= 100 ? formatNumber(v, 0) : Math.abs(v) >= 1 ? formatNumber(v, 2) : formatSignificant(v, 2));

  let canvas: HTMLCanvasElement;
  let w = $state(0);
  let h = $state(0);
  let dragging: "min" | "max" | null = null;
  let hover = $state(false);

  onMount(() => {
    const ro = new ResizeObserver(([e]) => {
      w = e.contentRect.width;
      h = e.contentRect.height;
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  });

  const span = $derived(axis[1] - axis[0] || 1);
  const toPx = (v: number) => PAD_X + ((v - axis[0]) / span) * (w - 2 * PAD_X);
  const toVal = (px: number) => Math.min(axis[1], Math.max(axis[0], axis[0] + ((px - PAD_X) / (w - 2 * PAD_X)) * span));

  $effect(() => {
    const ctx = canvas.getContext("2d");
    if (!ctx || w <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // The bars take the text colour of the canvas (text-muted): right in light and dark
    const style = getComputedStyle(canvas);
    const [lo, hi] = [toPx(win[0]), toPx(win[1])];
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = style.color;
    ctx.fillRect(lo, 0, hi - lo, h);
    ctx.globalAlpha = 0.7;
    if (bins) {
      const bw = (w - 2 * PAD_X) / bins.length;
      for (let i = 0; i < bins.length; i++) {
        const bh = bins[i] * (h - 2);
        if (bh > 0) ctx.fillRect(PAD_X + i * bw, h - bh, bw + 0.5, bh);
      }
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.5;
    for (const [x, color] of [
      [lo, MIN_COLOR],
      [hi, MAX_COLOR],
    ] as const) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  });

  const x = (e: PointerEvent) => e.clientX - canvas.getBoundingClientRect().left;

  /** The line near `px`, the nearer one if both are. */
  function grab(px: number): "min" | "max" | null {
    const dMin = Math.abs(px - toPx(win[0]));
    const dMax = Math.abs(px - toPx(win[1]));
    if (Math.min(dMin, dMax) > GRAB_PX) return null;
    // Lines on top of each other: the side the pointer is on
    if (dMin === dMax) return px < toPx(win[0]) ? "min" : "max";
    return dMin < dMax ? "min" : "max";
  }

  function onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    dragging = grab(x(e));
    if (!dragging) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
  }

  function onMove(e: PointerEvent) {
    if (!dragging) {
      hover = grab(x(e)) !== null;
      return;
    }
    const v = toVal(x(e));
    let next: [number, number] = dragging === "min" ? [v, win[1]] : [win[0], v];
    if (next[0] > next[1]) {
      // Dragged past the other line: they swap roles
      next = [next[1], next[0]];
      dragging = dragging === "min" ? "max" : "min";
    }
    onwindow(next);
  }

  function onUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  }
</script>

<div class="flex flex-col gap-0.5">
  <canvas
    bind:this={canvas}
    class="h-10 w-full touch-none text-muted {hover ? 'cursor-ew-resize' : ''}"
    aria-label={m.hist_aria({ label, min: fmt(win[0]), max: fmt(win[1]) })}
    onpointerdown={onDown}
    onpointermove={onMove}
    onpointerup={onUp}
    onpointercancel={onUp}
    onpointerleave={() => (hover = false)}
  ></canvas>
  <span class="text-xs text-muted">
    {label}: <span style="color: {MIN_COLOR}">{fmt(win[0])}</span> … <span style="color: {MAX_COLOR}">{fmt(win[1])}</span>
    {unit} <span class="opacity-70">({m.hist_range({ min: fmt(axis[0]), max: fmt(axis[1]) })})</span>
  </span>
</div>
