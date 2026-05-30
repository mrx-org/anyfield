/**
 * Histogram + cal_min / cal_max UI for Niivue (single module).
 * - promptClimEdit modal
 * - attachNiivueHistogramPanel (main viewer)
 * - attachDualNiivueHistogramPanel (preview + compare)
 * - MainHistogramController / PreviewJointHistogramController
 */

// ── Clim edit dialog ─────────────────────────────────────────────────────────

/** @returns {Promise<{ calMin: number, calMax: number } | null>} */
export function promptClimEdit({ calMin, calMax, decimals = 2, title = "Intensity window" }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "clim-edit-dialog-overlay";
    overlay.innerHTML = `
      <div class="clim-edit-dialog" role="dialog" aria-label="${title}">
        <div class="clim-edit-dialog-title"></div>
        <div class="clim-edit-dialog-fields">
          <label class="clim-edit-field clim-edit-min"><span>Min</span><input type="number" step="any" class="clim-edit-in-min" /></label>
          <label class="clim-edit-field clim-edit-max"><span>Max</span><input type="number" step="any" class="clim-edit-in-max" /></label>
        </div>
        <div class="clim-edit-dialog-actions">
          <button type="button" class="btn clim-edit-cancel">Cancel</button>
          <button type="button" class="btn primary clim-edit-ok">Apply</button>
        </div>
      </div>`;
    overlay.querySelector(".clim-edit-dialog-title").textContent = title;

    const inMin = overlay.querySelector(".clim-edit-in-min");
    const inMax = overlay.querySelector(".clim-edit-in-max");
    inMin.value = Number(calMin).toFixed(decimals);
    inMax.value = Number(calMax).toFixed(decimals);

    const finish = (ok) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      if (!ok) {
        resolve(null);
        return;
      }
      const mn = parseFloat(inMin.value);
      const mx = parseFloat(inMax.value);
      resolve(Number.isFinite(mn) && Number.isFinite(mx) ? { calMin: mn, calMax: mx } : null);
    };
    const onKey = (e) => {
      if (e.key === "Escape") finish(false);
      if (e.key === "Enter") finish(true);
    };

    overlay.querySelector(".clim-edit-cancel").onclick = () => finish(false);
    overlay.querySelector(".clim-edit-ok").onclick = () => finish(true);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(false);
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    inMin.focus();
    inMin.select();
  });
}

// ── Volume / histogram utilities ─────────────────────────────────────────────

/** @typedef {'currentFrame' | 'allFrames'} HistogramMode */

export function volumeIs4D(volume) {
  if (volume.nFrame4D != null && volume.nFrame4D > 1) return true;
  const d = volume.hdr?.dims;
  return !!(d && d[4] != null && d[4] > 1);
}

export function getNVox3D(volume) {
  if (volume.nVox3D) return volume.nVox3D;
  const d = volume.hdr?.dims;
  return !d || d.length < 4 ? 0 : d[1] * d[2] * d[3];
}

export function voxelBufferForDisplayedLayer(volume) {
  const img = volume.img;
  if (!img) throw new Error("volume has no img buffer");
  const nVox = getNVox3D(volume);
  if (!nVox) return img;
  const nFr =
    volume.nFrame4D ??
    (img.length >= nVox ? Math.max(1, Math.floor(img.length / nVox)) : 1);
  if (nFr <= 1) return img;
  const fi = Math.min(Math.max(0, volume.frame4D ?? 0), nFr - 1);
  const start = fi * nVox;
  return img.subarray(start, Math.min(start + nVox, img.length));
}

export function voxelBufferAllFrames(volume) {
  const img = volume.img;
  if (!img) throw new Error("volume has no img buffer");
  const nVox = getNVox3D(volume);
  if (!nVox) return img;
  const nFr = volume.nFrame4D ?? Math.max(1, Math.floor(img.length / nVox));
  if (nFr <= 1) return img;
  return img.subarray(0, Math.min(img.length, nVox * nFr));
}

export function expandHistAxisRange(lo, hi, pad = 0.15) {
  const span = hi - lo || 1;
  const p = Number.isFinite(pad) ? pad : 0.15;
  return { gMin: lo - span * p, gMax: hi + span * p };
}

export function computeSlabDataRange(vol, useRobustFallback = true) {
  if (!vol?.img) return { lo: 0, hi: 1 };
  const view = voxelBufferForDisplayedLayer(vol);
  let lo = Infinity;
  let hi = -Infinity;
  const stride = Math.max(1, Math.floor(view.length / 400_000));
  for (let i = 0; i < view.length; i += stride) {
    const v = vol.intensityRaw2Scaled(view[i]);
    if (Number.isFinite(v)) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (Number.isFinite(lo) && Number.isFinite(hi) && lo < hi) return { lo, hi };
  if (useRobustFallback) {
    return {
      lo: Number.isFinite(vol.robust_min) ? vol.robust_min : vol.global_min,
      hi: Number.isFinite(vol.robust_max) ? vol.robust_max : vol.global_max,
    };
  }
  return { lo: vol.global_min, hi: vol.global_max };
}

export function computeSlabRobustClims(vol, lowPct = 0.02, highPct = 0.98) {
  const view = voxelBufferForDisplayedLayer(vol);
  const samples = [];
  const stride = Math.max(1, Math.floor(view.length / 400_000));
  for (let i = 0; i < view.length; i += stride) {
    const v = vol.intensityRaw2Scaled(view[i]);
    if (Number.isFinite(v)) samples.push(v);
  }
  if (!samples.length) return { calMin: vol.cal_min, calMax: vol.cal_max };
  samples.sort((a, b) => a - b);
  const lo = samples[Math.floor(samples.length * lowPct)] ?? samples[0];
  const hi =
    samples[Math.min(samples.length - 1, Math.floor(samples.length * highPct))] ??
    samples[samples.length - 1];
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) {
    return { calMin: vol.cal_min, calMax: vol.cal_max };
  }
  return { calMin: lo, calMax: hi };
}

export function syncVolumeClimsToCurrent4DFrame(vol, nv, frameIdxOverride = null) {
  if (!vol?.img) return { calMin: vol?.cal_min ?? 0, calMax: vol?.cal_max ?? 1 };
  const hasOverride = Number.isFinite(frameIdxOverride);
  const targetFrame = hasOverride ? Math.max(0, Math.floor(frameIdxOverride)) : (vol.frame4D ?? 0);
  if (volumeIs4D(vol)) {
    // Deterministic per-frame clims: avoid depending on Niivue internals that can
    // keep frame-0 style clims on some 4D datasets.
    vol.frame4D = targetFrame;
    const frameRange = computeSlabDataRange(vol, false);
    if (Number.isFinite(frameRange.lo) && Number.isFinite(frameRange.hi) && frameRange.lo < frameRange.hi) {
      vol.cal_min = frameRange.lo;
      vol.cal_max = frameRange.hi;
    } else {
      const r = computeSlabRobustClims(vol);
      vol.cal_min = r.calMin;
      vol.cal_max = r.calMax;
    }
  }
  nv?.updateGLVolume?.();
  nv?.drawScene?.();
  return { calMin: vol.cal_min, calMax: vol.cal_max };
}

/**
 * Niivue right-drag contrast (`calculateNewRange`) indexes img as 3D without a 4D
 * frame offset, so it always samples frame 0. Temporarily point vol.img at the
 * active frame slab during the calculation, then restore the full buffer.
 */
export function installFrameAwareContrastDrag(nv) {
  if (!nv || nv._frameAwareRangeHook || typeof nv.calculateNewRange !== "function") return;
  nv._frameAwareRangeHook = true;
  const origCalcRange = nv.calculateNewRange.bind(nv);
  nv.calculateNewRange = (opts = {}) => {
    const volIdx = opts.volIdx ?? 0;
    const vol = nv.volumes?.[volIdx];
    if (vol?.img && volumeIs4D(vol)) {
      const nVox = getNVox3D(vol);
      const nFr = vol.nFrame4D ?? (nVox > 0 ? Math.max(1, Math.floor(vol.img.length / nVox)) : 1);
      const fi = Math.min(Math.max(0, vol.frame4D ?? 0), Math.max(0, nFr - 1));
      const start = fi * nVox;
      if (nVox > 0 && fi > 0 && start + nVox <= vol.img.length) {
        const savedImg = vol.img;
        vol.img = savedImg.subarray(start, start + nVox);
        try {
          return origCalcRange(opts);
        } finally {
          vol.img = savedImg;
        }
      }
    }
    return origCalcRange(opts);
  };
}

export function computeLogHistogramBins(vol, voxelView, S, BINS, gMin, gMax, barHOut) {
  const gRange = gMax - gMin || 1;
  const invBin = BINS / gRange;
  const rawBins = new Float32Array(BINS);
  const nTot = voxelView.length;
  const histStride =
    nTot <= S.histMaxFullScanVoxels ? 1 : Math.ceil(nTot / S.histMaxFullScanVoxels);
  for (let i = 0; i < nTot; i += histStride) {
    const raw = voxelView[i];
    if (!Number.isFinite(raw)) continue;
    const v = vol.intensityRaw2Scaled(raw);
    if (!Number.isFinite(v)) continue;
    let b = ((v - gMin) * invBin) | 0;
    if (b >= BINS) b = BINS - 1;
    else if (b < 0) b = 0;
    rawBins[b]++;
  }
  let logMax = 0;
  for (let i = 0; i < BINS; i++) {
    const h = Math.log10(rawBins[i] + 1);
    barHOut[i] = h;
    if (h > logMax) logMax = h;
  }
  return { histStride, nTot, logMax: logMax || 1 };
}

// ── Shared canvas / interaction helpers ──────────────────────────────────────

const defaultStyle = Object.freeze({
  bins: 256,
  histMaxFullScanVoxels: 12_000_000,
  padLeft: 6,
  padRight: 6,
  padTop: 4,
  padBottom: 14,
  axisPadding: 0.15,
  lineGrabPx: 10,
  minColor: "#5ba4e6",
  maxColor: "#e05555",
  barColor: "rgba(100,100,180,0.50)",
  barColorA: "rgba(91, 164, 230, 0.45)",
  barColorB: "rgba(230, 170, 60, 0.45)",
  multiFrameStackAlpha: 1,
  tickColor: "#666",
  tickFont: "9px system-ui",
  handleLabelFont: "bold 8px system-ui",
  windowShadeColor: "rgba(255,255,255,0.04)",
  inputDecimals: 2,
  handleLabelDecimals: 2,
  axisTickDecimals: 2,
});

function hueForFrameIndex(frameIndex) {
  return ((frameIndex * 137.508) % 360 + 360) % 360;
}

function createPlotLayout(hCanvas, hCtx, S) {
  let plotL, plotR, plotT, plotB, plotW, plotH, cssW = 300, cssH = 64, backingDpr = 1;
  const getPlot = () => ({ plotL, plotR, plotT, plotB, plotW, plotH, cssW, cssH, backingDpr });
  const calcLayout = () => {
    const rect = hCanvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      cssW = 0;
      cssH = 0;
      return false;
    }
    const dpr = window.devicePixelRatio || 1;
    backingDpr = dpr;
    hCanvas.width = rect.width * dpr;
    hCanvas.height = rect.height * dpr;
    hCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    plotL = S.padLeft;
    plotR = rect.width - S.padRight;
    plotT = S.padTop;
    plotB = rect.height - S.padBottom;
    plotW = plotR - plotL;
    plotH = plotB - plotT;
    cssW = rect.width;
    cssH = rect.height;
    return true;
  };
  const valToPx = (v, gMin, gRange) => plotL + ((v - gMin) / gRange) * plotW;
  const pxToVal = (px, gMin, gMax, gRange) =>
    Math.max(gMin, Math.min(gMax, gMin + ((px - plotL) / plotW) * gRange));
  return { calcLayout, getPlot, valToPx, pxToVal };
}

function drawAxisTicks(ctx, S, plot, gMin, gMax) {
  const { plotL, plotR, plotB } = plot;
  ctx.fillStyle = S.tickColor;
  ctx.font = S.tickFont;
  ctx.textBaseline = "top";
  const tickY = plotB + 3;
  ctx.textAlign = "left";
  ctx.fillText(gMin.toFixed(S.axisTickDecimals), plotL, tickY);
  ctx.textAlign = "center";
  ctx.fillText(((gMin + gMax) / 2).toFixed(S.axisTickDecimals), (plotL + plotR) / 2, tickY);
  ctx.textAlign = "right";
  ctx.fillText(gMax.toFixed(S.axisTickDecimals), plotR, tickY);
}

function drawClimLine(hCtx, S, valToPx, plot, val, color, gMin, gRange) {
  const { plotL, plotR, plotT, plotB } = plot;
  const x = valToPx(val, gMin, gRange);
  if (x < plotL - 2 || x > plotR + 2) return;
  const label = val.toFixed(S.handleLabelDecimals);
  const tickLen = 4;

  hCtx.strokeStyle = color;
  hCtx.lineWidth = 1.5;
  hCtx.beginPath();
  hCtx.moveTo(x, plotT);
  hCtx.lineTo(x, plotB);
  hCtx.stroke();

  hCtx.fillStyle = color;
  hCtx.beginPath();
  hCtx.moveTo(x, plotT);
  hCtx.lineTo(x - 4, plotT - 1);
  hCtx.lineTo(x + 4, plotT - 1);
  hCtx.closePath();
  hCtx.fill();
  hCtx.beginPath();
  hCtx.moveTo(x, plotB);
  hCtx.lineTo(x, plotB + tickLen);
  hCtx.stroke();

  hCtx.font = S.handleLabelFont;
  hCtx.textBaseline = "top";
  hCtx.textAlign = "center";
  let tx = x;
  const halfW = (hCtx.measureText(label).width || 24) / 2;
  if (tx - halfW < plotL) tx = plotL + halfW;
  if (tx + halfW > plotR) tx = plotR - halfW;
  hCtx.fillText(label, tx, plotB + tickLen + 2);
}

function syncClimInputs(inMin, inMax, calMin, calMax, S) {
  if (!inMin || !inMax) return;
  inMin.value = calMin.toFixed(S.inputDecimals);
  inMax.value = calMax.toFixed(S.inputDecimals);
}

function bindClimInputs(inMin, inMax, getClim, setClim, applyClim) {
  if (!inMin || !inMax) return () => {};
  const commitMin = () => {
    const v = parseFloat(inMin.value);
    if (isFinite(v)) {
      setClim({ ...getClim(), calMin: v });
      applyClim();
    }
  };
  const commitMax = () => {
    const v = parseFloat(inMax.value);
    if (isFinite(v)) {
      setClim({ ...getClim(), calMax: v });
      applyClim();
    }
  };
  const onEnter = (commit) => (e) => {
    if (e.key === "Enter") {
      e.target.blur();
      commit();
    }
  };
  inMin.addEventListener("change", commitMin);
  inMax.addEventListener("change", commitMax);
  const onMinKey = onEnter(commitMin);
  const onMaxKey = onEnter(commitMax);
  inMin.addEventListener("keydown", onMinKey);
  inMax.addEventListener("keydown", onMaxKey);
  return () => {
    inMin.removeEventListener("change", commitMin);
    inMax.removeEventListener("change", commitMax);
    inMin.removeEventListener("keydown", onMinKey);
    inMax.removeEventListener("keydown", onMaxKey);
  };
}

function attachClimInteraction(hCanvas, {
  S, inMin, inMax, blurExtra, getClim, setClim, applyClim, syncInputs, valToPx, pxToVal, getAxis, dblTitle,
}) {
  let dragging = null;
  let dblClickOpening = false;
  const cssX = (e) => e.clientX - hCanvas.getBoundingClientRect().left;
  const hitTest = (cx) => {
    const { calMin, calMax } = getClim();
    const { gMin, gMax, gRange } = getAxis();
    const dMin = Math.abs(cx - valToPx(calMin, gMin, gRange));
    const dMax = Math.abs(cx - valToPx(calMax, gMin, gRange));
    const best = dMin <= dMax ? "min" : "max";
    const dist = Math.min(dMin, dMax);
    if (dist > S.lineGrabPx) {
      if (dMin <= S.lineGrabPx) return "min";
      if (dMax <= S.lineGrabPx) return "max";
      return null;
    }
    return best;
  };

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    dragging = hitTest(cssX(e));
    if (!dragging) return;
    e.preventDefault();
    inMin?.blur?.();
    inMax?.blur?.();
    blurExtra?.();
    hCanvas.setPointerCapture(e.pointerId);
    hCanvas.style.cursor = "grabbing";
  };
  const onPointerMove = (e) => {
    if (!dragging) {
      hCanvas.style.cursor = hitTest(cssX(e)) ? "ew-resize" : "default";
      return;
    }
    e.preventDefault();
    const { gMin, gMax, gRange } = getAxis();
    const val = pxToVal(cssX(e), gMin, gMax, gRange);
    const c = getClim();
    setClim(dragging === "min" ? { ...c, calMin: val } : { ...c, calMax: val });
    applyClim();
  };
  const endHistDrag = (e) => {
    if (dragging === null) return;
    dragging = null;
    hCanvas.style.cursor = "default";
    try {
      if (e?.pointerId != null) hCanvas.releasePointerCapture(e.pointerId);
    } catch {
      /* */
    }
    syncInputs();
  };
  const onDblClick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragging || dblClickOpening) return;
    dblClickOpening = true;
    try {
      const { calMin, calMax } = getClim();
      const next = await promptClimEdit({
        calMin,
        calMax,
        decimals: S.handleLabelDecimals,
        title: dblTitle,
      });
      if (!next) return;
      setClim(next);
      applyClim();
    } finally {
      dblClickOpening = false;
    }
  };

  hCanvas.addEventListener("pointerdown", onPointerDown);
  hCanvas.addEventListener("pointermove", onPointerMove);
  hCanvas.addEventListener("pointerup", endHistDrag);
  hCanvas.addEventListener("pointercancel", endHistDrag);
  hCanvas.addEventListener("dblclick", onDblClick);

  return () => {
    hCanvas.removeEventListener("pointerdown", onPointerDown);
    hCanvas.removeEventListener("pointermove", onPointerMove);
    hCanvas.removeEventListener("pointerup", endHistDrag);
    hCanvas.removeEventListener("pointercancel", endHistDrag);
    hCanvas.removeEventListener("dblclick", onDblClick);
  };
}

function attachHistResize(hCanvas, callback) {
  let resizeRaf = null;
  const ro = new ResizeObserver(() => {
    if (resizeRaf !== null) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      callback();
    });
  });
  ro.observe(hCanvas);
  return () => {
    ro.disconnect();
    if (resizeRaf !== null) cancelAnimationFrame(resizeRaf);
  };
}

function updateHistogramRowVisibility(volume, rowEl, selectEl) {
  if (!rowEl) return;
  const show = volumeIs4D(volume);
  rowEl.style.display = show ? "flex" : "none";
  if (selectEl) selectEl.disabled = !show;
}

// ── Single-volume histogram panel ────────────────────────────────────────────

export function attachNiivueHistogramPanel(config) {
  const {
    niivue: nv,
    volumeIndex = 0,
    histogramCanvas: hCanvas,
    climMinInput: inMin,
    climMaxInput: inMax,
    statusElement = null,
    style: stylePartial = {},
    initialHistogramMode = "currentFrame",
    histogramModeSelect = null,
    histogramModeRow = null,
    useRobustAxis = false,
    syncClimsOn4DFrame = true,
  } = config;

  if (!nv?.volumes?.length || !nv.volumes[volumeIndex]) {
    throw new Error("Niivue has no volume at volumeIndex");
  }

  const S = { ...defaultStyle, ...stylePartial };
  const BINS = S.bins >>> 0;
  if (!BINS) throw new Error("style.bins must be positive");
  const vol = nv.volumes[volumeIndex];

  let histogramMode = initialHistogramMode === "allFrames" ? "allFrames" : "currentFrame";
  const rawMin = useRobustAxis && Number.isFinite(vol.robust_min) ? vol.robust_min : vol.global_min;
  const rawMax = useRobustAxis && Number.isFinite(vol.robust_max) ? vol.robust_max : vol.global_max;
  const { gMin, gMax } = expandHistAxisRange(rawMin, rawMax, S.axisPadding);
  const gRange = gMax - gMin || 1;
  const getAxis = () => ({ gMin, gMax, gRange });

  const barH = new Float32Array(BINS);
  let logMax = 1;
  let lastHistStride = 1;
  let lastNTot = 0;
  let histStaticDirty = true;
  let perFrameBarH = null;
  let use4DStackedHistogram = false;
  let calMin = vol.cal_min;
  let calMax = vol.cal_max;
  let frameId = 0;

  const hCtx = hCanvas.getContext("2d", { alpha: true, desynchronized: true });
  const offBars = document.createElement("canvas");
  const offBarsCtx = offBars.getContext("2d", { alpha: true });
  const layout = createPlotLayout(hCanvas, hCtx, S);
  const { getPlot, valToPx, pxToVal } = layout;
  const calcLayout = () => {
    if (!layout.calcLayout()) return false;
    histStaticDirty = true;
    return true;
  };

  const getClim = () => ({ calMin, calMax });
  const setClim = ({ calMin: mn, calMax: mx }) => {
    calMin = mn;
    calMax = mx;
  };
  const syncInputs = () => syncClimInputs(inMin, inMax, calMin, calMax, S);

  function voxelSourceForMode() {
    return histogramMode === "allFrames" ? voxelBufferAllFrames(vol) : voxelBufferForDisplayedLayer(vol);
  }

  function recomputeHistogramBars() {
    const img = vol.img;
    const nVox = getNVox3D(vol);
    const nFrDeclared = vol.nFrame4D ?? (nVox > 0 && img ? Math.floor(img.length / nVox) : 1);
    const nFr =
      nVox > 0 && img ? Math.min(Math.max(1, nFrDeclared), Math.ceil(img.length / nVox)) : 1;

    use4DStackedHistogram =
      histogramMode === "allFrames" && volumeIs4D(vol) && nFr > 1 && nVox > 0 && img;

    if (!use4DStackedHistogram) {
      perFrameBarH = null;
      const r = computeLogHistogramBins(vol, voxelSourceForMode(), S, BINS, gMin, gMax, barH);
      logMax = r.logMax;
      lastHistStride = r.histStride;
      lastNTot = r.nTot;
      histStaticDirty = true;
      return;
    }

    perFrameBarH = new Array(nFr);
    let sumNTot = 0;
    let stride0 = 1;
    for (let f = 0; f < nFr; f++) {
      const start = f * nVox;
      if (start >= img.length) break;
      const row = new Float32Array(BINS);
      const r = computeLogHistogramBins(vol, img.subarray(start, Math.min(start + nVox, img.length)), S, BINS, gMin, gMax, row);
      perFrameBarH[f] = row;
      sumNTot += r.nTot;
      stride0 = r.histStride;
    }
    lastHistStride = stride0;
    lastNTot = sumNTot;
    logMax = 1;
    histStaticDirty = true;
  }

  function writeStatus() {
    if (!statusElement) return;
    const scanNote = lastHistStride === 1 ? "full scan (scaled)" : `stride ${lastHistStride} (scaled)`;
    const modeNote =
      histogramMode === "allFrames"
        ? " · 4D: all frames"
        : ` · 4D: frame ${(vol.frame4D ?? 0) + 1}/${vol.nFrame4D ?? 1} (current)`;
    const stackNote =
      use4DStackedHistogram && perFrameBarH
        ? ` · ${perFrameBarH.length}-frame stacked (y = Σ log bins / global max)`
        : "";
    statusElement.textContent =
      `${lastNTot.toLocaleString()} voxels binned · ${scanNote}${volumeIs4D(vol) ? modeNote : ""}${stackNote} · range ${gMin.toFixed(1)}–${gMax.toFixed(1)} (scaled)`;
  }

  function redrawHistStaticBacking() {
    if (!histStaticDirty) return;
    const plot = getPlot();
    if (plot.cssW <= 0 || plot.cssH <= 0) return;
    histStaticDirty = false;
    offBars.width = hCanvas.width;
    offBars.height = hCanvas.height;
    if (offBars.width <= 0 || offBars.height <= 0) {
      histStaticDirty = true;
      return;
    }
    offBarsCtx.setTransform(plot.backingDpr, 0, 0, plot.backingDpr, 0, 0);
    const barW = plot.plotW / BINS;

    if (use4DStackedHistogram && perFrameBarH?.length) {
      const alpha = typeof S.multiFrameStackAlpha === "number" ? S.multiFrameStackAlpha : 1;
      let globalStackMax = 0;
      for (let i = 0; i < BINS; i++) {
        let s = 0;
        for (let f = 0; f < perFrameBarH.length; f++) s += perFrameBarH[f][i];
        if (s > globalStackMax) globalStackMax = s;
      }
      if (globalStackMax <= 0) globalStackMax = 1;
      const scale = plot.plotH / globalStackMax;
      for (let i = 0; i < BINS; i++) {
        let cum = 0;
        for (let f = 0; f < perFrameBarH.length; f++) {
          const segPx = perFrameBarH[f][i] * scale;
          if (segPx <= 0) continue;
          cum += segPx;
          offBarsCtx.fillStyle = `hsla(${hueForFrameIndex(f)}, 72%, 52%, ${alpha})`;
          offBarsCtx.fillRect(plot.plotL + i * barW, plot.plotB - cum, barW + 0.5, segPx);
        }
      }
    } else {
      offBarsCtx.fillStyle = S.barColor;
      for (let i = 0; i < BINS; i++) {
        const bh = (barH[i] / logMax) * plot.plotH;
        if (bh > 0) offBarsCtx.fillRect(plot.plotL + i * barW, plot.plotB - bh, barW + 0.5, bh);
      }
    }
    drawAxisTicks(offBarsCtx, S, plot, gMin, gMax);
  }

  function draw() {
    if (!calcLayout()) return;
    redrawHistStaticBacking();
    const plot = getPlot();
    if (hCanvas.width <= 0 || offBars.width <= 0) return;
    hCtx.setTransform(plot.backingDpr, 0, 0, plot.backingDpr, 0, 0);
    hCtx.clearRect(0, 0, plot.cssW, plot.cssH);
    hCtx.drawImage(offBars, 0, 0, plot.cssW, plot.cssH);
    hCtx.fillStyle = S.windowShadeColor;
    hCtx.fillRect(valToPx(calMin, gMin, gRange), plot.plotT, valToPx(calMax, gMin, gRange) - valToPx(calMin, gMin, gRange), plot.plotH);
    drawClimLine(hCtx, S, valToPx, plot, calMin, S.minColor, gMin, gRange);
    drawClimLine(hCtx, S, valToPx, plot, calMax, S.maxColor, gMin, gRange);
  }

  function scheduleGpuAndRedraw() {
    if (frameId) return;
    frameId = requestAnimationFrame(() => {
      frameId = 0;
      syncInputs();
      nv.updateGLVolume();
      draw();
    });
  }

  function applyClim() {
    if (calMin > calMax) [calMin, calMax] = [calMax, calMin];
    vol.cal_min = calMin;
    vol.cal_max = calMax;
    scheduleGpuAndRedraw();
  }

  recomputeHistogramBars();
  updateHistogramRowVisibility(vol, histogramModeRow, histogramModeSelect);
  if (histogramModeSelect) histogramModeSelect.value = histogramMode;
  syncInputs();
  writeStatus();

  const unbindInputs = bindClimInputs(inMin, inMax, getClim, setClim, applyClim);
  const unbindInteraction = attachClimInteraction(hCanvas, {
    S,
    inMin,
    inMax,
    blurExtra: () => histogramModeSelect?.blur?.(),
    getClim,
    setClim,
    applyClim,
    syncInputs,
    valToPx,
    pxToVal,
    getAxis,
    dblTitle: "Intensity window",
  });
  const unbindResize = attachHistResize(hCanvas, draw);

  const prevOnFrameChange = nv.onFrameChange;
  nv.onFrameChange = (changedVol, _frameIdx) => {
    prevOnFrameChange?.(changedVol, _frameIdx);
    if (changedVol !== vol || histogramMode !== "currentFrame" || !volumeIs4D(vol)) return;
    if (syncClimsOn4DFrame) {
      const effectiveFrameIdx = Number.isFinite(_frameIdx) ? _frameIdx : (changedVol?.frame4D ?? vol?.frame4D ?? 0);
      ({ calMin, calMax } = syncVolumeClimsToCurrent4DFrame(vol, nv, effectiveFrameIdx));
    } else {
      calMin = vol.cal_min;
      calMax = vol.cal_max;
    }
    recomputeHistogramBars();
    syncInputs();
    draw();
  };

  const onModeChange = () => {
    if (!histogramModeSelect) return;
    histogramMode = histogramModeSelect.value === "allFrames" ? "allFrames" : "currentFrame";
    recomputeHistogramBars();
    histStaticDirty = true;
    draw();
    writeStatus();
  };
  histogramModeSelect?.addEventListener("change", onModeChange);
  draw();

  return {
    dispose() {
      nv.onFrameChange = prevOnFrameChange;
      histogramModeSelect?.removeEventListener("change", onModeChange);
      unbindInputs();
      unbindInteraction();
      unbindResize();
      if (frameId) cancelAnimationFrame(frameId);
    },
    getHistogramMode: () => histogramMode,
    setHistogramMode(m) {
      histogramMode = m === "allFrames" ? "allFrames" : "currentFrame";
      if (histogramModeSelect) histogramModeSelect.value = histogramMode;
      recomputeHistogramBars();
      histStaticDirty = true;
      draw();
      writeStatus();
    },
    syncClimFromVolume() {
      calMin = vol.cal_min;
      calMax = vol.cal_max;
      syncInputs();
      if (frameId) cancelAnimationFrame(frameId);
      frameId = 0;
      draw();
    },
    getClim: () => ({ calMin, calMax }),
  };
}

// ── Dual-volume histogram panel ──────────────────────────────────────────────

export function attachDualNiivueHistogramPanel(config) {
  const {
    getSourceA,
    getSourceB,
    histogramCanvas: hCanvas,
    climMinInput: inMin,
    climMaxInput: inMax,
    useRobustAxis = true,
    style: stylePartial = {},
  } = config;

  const S = { ...defaultStyle, ...stylePartial };
  const BINS = S.bins >>> 0;
  const barA = new Float32Array(BINS);
  const barB = new Float32Array(BINS);
  let logMax = 1;
  let gMin = 0;
  let gMax = 1;
  let gRange = 1;
  let calMin = 0;
  let calMax = 1;
  let histStaticDirty = true;
  let applyingFromPanel = false;
  let frameId = 0;

  const hCtx = hCanvas.getContext("2d", { alpha: true, desynchronized: true });
  const offBars = document.createElement("canvas");
  const offBarsCtx = offBars.getContext("2d", { alpha: true });
  const layout = createPlotLayout(hCanvas, hCtx, S);
  const { getPlot, valToPx, pxToVal } = layout;
  const calcLayout = () => {
    if (!layout.calcLayout()) return false;
    histStaticDirty = true;
    return true;
  };
  const getAxis = () => ({ gMin, gMax, gRange });
  const getClim = () => ({ calMin, calMax });
  const setClim = ({ calMin: mn, calMax: mx }) => {
    calMin = mn;
    calMax = mx;
  };
  const syncInputs = () => syncClimInputs(inMin, inMax, calMin, calMax, S);

  function primaryVolume() {
    return getSourceA()?.vol?.img ? getSourceA().vol : getSourceB()?.vol ?? null;
  }

  function readClimFromVolumes() {
    const vol = primaryVolume();
    if (vol) {
      calMin = vol.cal_min;
      calMax = vol.cal_max;
    }
  }

  function recomputeAxisAndBars() {
    const vols = [getSourceA()?.vol, getSourceB()?.vol].filter((v) => v?.img);
    if (!vols.length) {
      gMin = 0;
      gMax = 1;
      gRange = 1;
      barA.fill(0);
      barB.fill(0);
      logMax = 1;
      histStaticDirty = true;
      return false;
    }

    let axisMin = Infinity;
    let axisMax = -Infinity;
    for (const v of vols) {
      const { lo, hi } = computeSlabDataRange(v, useRobustAxis);
      axisMin = Math.min(axisMin, lo);
      axisMax = Math.max(axisMax, hi);
    }
    if (!Number.isFinite(axisMin) || !Number.isFinite(axisMax) || axisMin >= axisMax) {
      axisMin = vols[0].global_min;
      axisMax = vols[0].global_max;
    }
    ({ gMin, gMax } = expandHistAxisRange(axisMin, axisMax, S.axisPadding));
    gRange = gMax - gMin || 1;

    barA.fill(0);
    barB.fill(0);
    logMax = 1;
    for (const [getter, bar] of [
      [getSourceA, barA],
      [getSourceB, barB],
    ]) {
      const src = getter();
      if (!src?.vol?.img) continue;
      const r = computeLogHistogramBins(src.vol, voxelBufferForDisplayedLayer(src.vol), S, BINS, gMin, gMax, bar);
      logMax = Math.max(logMax, r.logMax);
    }
    if (logMax === 0) logMax = 1;
    histStaticDirty = true;
    return true;
  }

  function redrawHistStaticBacking() {
    if (!histStaticDirty) return;
    const plot = getPlot();
    if (plot.cssW <= 0 || plot.cssH <= 0) return;
    histStaticDirty = false;
    offBars.width = hCanvas.width;
    offBars.height = hCanvas.height;
    if (offBars.width <= 0 || offBars.height <= 0) {
      histStaticDirty = true;
      return;
    }
    offBarsCtx.setTransform(plot.backingDpr, 0, 0, plot.backingDpr, 0, 0);
    const barW = plot.plotW / BINS;
    const drawBars = (barH, color) => {
      offBarsCtx.fillStyle = color;
      for (let i = 0; i < BINS; i++) {
        const bh = (barH[i] / logMax) * plot.plotH;
        if (bh > 0) offBarsCtx.fillRect(plot.plotL + i * barW, plot.plotB - bh, barW + 0.5, bh);
      }
    };
    drawBars(barA, S.barColorA);
    drawBars(barB, S.barColorB);
    drawAxisTicks(offBarsCtx, S, plot, gMin, gMax);
  }

  function draw() {
    if (!calcLayout()) return;
    redrawHistStaticBacking();
    const plot = getPlot();
    if (hCanvas.width <= 0 || offBars.width <= 0) return;
    hCtx.setTransform(plot.backingDpr, 0, 0, plot.backingDpr, 0, 0);
    hCtx.clearRect(0, 0, plot.cssW, plot.cssH);
    hCtx.drawImage(offBars, 0, 0, plot.cssW, plot.cssH);
    hCtx.fillStyle = S.windowShadeColor;
    hCtx.fillRect(valToPx(calMin, gMin, gRange), plot.plotT, valToPx(calMax, gMin, gRange) - valToPx(calMin, gMin, gRange), plot.plotH);
    drawClimLine(hCtx, S, valToPx, plot, calMin, S.minColor, gMin, gRange);
    drawClimLine(hCtx, S, valToPx, plot, calMax, S.maxColor, gMin, gRange);
  }

  function applyClimToNiivueInstances() {
    if (calMin > calMax) [calMin, calMax] = [calMax, calMin];
    applyingFromPanel = true;
    try {
      for (const getter of [getSourceA, getSourceB]) {
        const src = getter();
        if (!src?.vol || !src.nv) continue;
        src.vol.cal_min = calMin;
        src.vol.cal_max = calMax;
        src.nv.updateGLVolume?.();
        src.nv.drawScene?.();
      }
    } finally {
      applyingFromPanel = false;
    }
  }

  function scheduleRedraw() {
    if (frameId) return;
    frameId = requestAnimationFrame(() => {
      frameId = 0;
      syncInputs();
      applyClimToNiivueInstances();
      draw();
    });
  }

  function applyClim() {
    if (calMin > calMax) [calMin, calMax] = [calMax, calMin];
    scheduleRedraw();
  }

  const frameHooks = [];
  function install4DFrameHooks() {
    for (const getter of [getSourceA, getSourceB]) {
      const src = getter();
      if (!src?.nv || src.nv._dualHistFrameHook) continue;
      src.nv._dualHistFrameHook = true;
      const prev = src.nv.onFrameChange;
      const nvRef = src.nv;
      src.nv.onFrameChange = (changedVol, frameIdx) => {
        prev?.(changedVol, frameIdx);
        // Resolve the live volume for this nv every time: a volume captured at
        // install can go stale when a new scan is loaded into the same nv, which
        // would otherwise leave windowing/histogram stuck on the first scan's frame 0.
        const liveVol = nvRef.volumes?.[0] ?? null;
        if (!liveVol || changedVol !== liveVol || !volumeIs4D(liveVol)) return;
        const effectiveFrameIdx = Number.isFinite(frameIdx)
          ? frameIdx
          : (changedVol?.frame4D ?? liveVol.frame4D ?? 0);
        syncVolumeClimsToCurrent4DFrame(liveVol, nvRef, effectiveFrameIdx);
        readClimFromVolumes();
        recomputeAxisAndBars();
        syncInputs();
        draw();
      };
      frameHooks.push({ nv: src.nv, prev });
    }
  }

  readClimFromVolumes();
  syncInputs();
  install4DFrameHooks();

  const unbindInputs = bindClimInputs(inMin, inMax, getClim, setClim, applyClim);
  const unbindInteraction = attachClimInteraction(hCanvas, {
    S,
    inMin,
    inMax,
    getClim,
    setClim,
    applyClim,
    syncInputs,
    valToPx,
    pxToVal,
    getAxis,
    dblTitle: "Preview / compare window",
  });
  const unbindResize = attachHistResize(hCanvas, draw);

  return {
    dispose() {
      unbindInputs();
      unbindInteraction();
      unbindResize();
      for (const { nv: nvInst, prev } of frameHooks) {
        nvInst.onFrameChange = prev;
        delete nvInst._dualHistFrameHook;
      }
      if (frameId) cancelAnimationFrame(frameId);
    },
    refresh() {
      install4DFrameHooks();
      recomputeAxisAndBars();
      readClimFromVolumes();
      syncInputs();
      draw();
    },
    syncClimFromVolumes() {
      if (applyingFromPanel) return;
      readClimFromVolumes();
      syncInputs();
      if (frameId) cancelAnimationFrame(frameId);
      frameId = 0;
      histStaticDirty = true;
      draw();
    },
    isApplyingFromPanel: () => applyingFromPanel,
  };
}

// ── Mount helpers & controllers ──────────────────────────────────────────────

export function createClimHistPanelElement(idSuffix = "") {
  const root = document.createElement("div");
  root.className = "clim-hist-panel";
  root.innerHTML = `<canvas class="hist-canvas" data-role="histCanvas"></canvas>`;
  if (idSuffix) root.id = `clim-hist-${idSuffix}`;
  return { root, histCanvas: root.querySelector('[data-role="histCanvas"]') };
}

export function installClimHistSyncHooks(nv, syncFn, opts = {}) {
  if (!nv || nv._climHistSyncHook) return;
  nv._climHistSyncHook = true;
  const shouldSkip = opts.shouldSkip ?? (() => false);
  let syncRaf = 0;
  const scheduleSync = () => {
    if (shouldSkip() || syncRaf) return;
    syncRaf = requestAnimationFrame(() => {
      syncRaf = 0;
      if (!shouldSkip()) syncFn();
    });
  };
  const chain = (key) => {
    const prev = nv[key];
    nv[key] = (...args) => {
      prev?.(...args);
      scheduleSync();
    };
  };
  chain("onIntensityChange");
  chain("onMouseUp");
  if (typeof nv.updateGLVolume === "function" && !nv._climHistUpdateGLHook) {
    nv._climHistUpdateGLHook = true;
    const orig = nv.updateGLVolume.bind(nv);
    nv.updateGLVolume = (...args) => {
      const r = orig(...args);
      scheduleSync();
      return r;
    };
  }
}

export class MainHistogramController {
  constructor(nvModule) {
    this.nvModule = nvModule;
    this.panel = null;
    this._boundVolume = null;
    this._raf = null;
    this.ui = createClimHistPanelElement("main");
  }

  get element() {
    return this.ui.root;
  }

  attachToContainer(viewerContainer) {
    if (!viewerContainer) return;
    viewerContainer.classList.add("viewer-column-stack");
    if (!viewerContainer.querySelector(".clim-hist-panel")) {
      viewerContainer.appendChild(this.ui.root);
    }
    this._hookNiivue();
    this.refresh();
  }

  _hookNiivue() {
    const nv = this.nvModule?.nv;
    if (!nv) return;
    installClimHistSyncHooks(nv, () => this.panel?.syncClimFromVolume());
  }

  _volumeIndex() {
    const volumes = this.nvModule?.nv?.volumes ?? [];
    if (!volumes.length) return -1;

    // Pane A histogram must stay anchored to the active phantom, not to selected scans.
    const phantomVol = volumes.find((v) => {
      const name = String(v?.name ?? "").toLowerCase();
      const isScan = name.startsWith("scan_");
      const isMask = name.includes("mask");
      return !!v?.img && !isScan && !isMask;
    });
    if (phantomVol) return volumes.indexOf(phantomVol);

    // Fallback to previous behavior when no phantom is available.
    const { vol } = this.nvModule.getVolumeForIntensity();
    if (!vol?.img) return -1;
    return volumes.indexOf(vol);
  }

  refresh() {
    const nv = this.nvModule?.nv;
    if (!nv?.volumes?.length) {
      this._disposePanel();
      this.ui.root.style.visibility = "hidden";
      return;
    }
    const idx = this._volumeIndex();
    if (idx < 0) {
      this._disposePanel();
      this.ui.root.style.visibility = "hidden";
      return;
    }
    const vol = nv.volumes[idx];
    this.ui.root.style.visibility = "";
    if (this.panel && this._boundVolume === vol) {
      this.panel.syncClimFromVolume();
      return;
    }
    this._disposePanel();
    this._boundVolume = vol;
    try {
      this.panel = attachNiivueHistogramPanel({
        niivue: nv,
        volumeIndex: idx,
        histogramCanvas: this.ui.histCanvas,
        useRobustAxis: true,
        syncClimsOn4DFrame: true,
      });
    } catch (e) {
      console.warn("Main histogram:", e);
      this.panel = null;
    }
  }

  scheduleRefresh() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this.refresh();
    });
  }

  _disposePanel() {
    this.panel?.dispose();
    this.panel = null;
    this._boundVolume = null;
  }

  dispose() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._disposePanel();
    this.ui.root.remove();
  }
}

export class PreviewJointHistogramController {
  constructor() {
    this.panel = null;
    this.ui = createClimHistPanelElement("preview-joint");
  }

  get element() {
    return this.ui.root;
  }

  attachToJointRow(jointRowEl) {
    if (!jointRowEl) return;
    if (!jointRowEl.querySelector(".clim-hist-panel")) {
      jointRowEl.appendChild(this.ui.root);
    }
    this._ensurePanel();
    this.installPreviewHooks();
    this.scheduleRefresh();
  }

  scheduleRefresh() {
    requestAnimationFrame(() => this.refresh());
  }

  _ensurePanel() {
    if (this.panel) return;
    this.panel = attachDualNiivueHistogramPanel({
      getSourceA: () => {
        const mod = window.scanPreview;
        const vol = mod?.nv?.volumes?.[0];
        return vol?.img ? { vol, nv: mod.nv, label: mod.currentScanName || "Preview" } : null;
      },
      getSourceB: () => {
        const cmp = window.scanCompare;
        if (!cmp?.isReady) return null;
        const vol = cmp.module?.nv?.volumes?.[0];
        return vol?.img ? { vol, nv: cmp.module.nv, label: cmp.module?.currentScanName || "Compare" } : null;
      },
      histogramCanvas: this.ui.histCanvas,
      useRobustAxis: true,
      style: { axisPadding: 0.15 },
    });
  }

  installPreviewHooks() {
    for (const key of ["scanPreview", "scanCompare"]) {
      const mod = key === "scanPreview" ? window.scanPreview : window.scanCompare?.module;
      const nv = mod?.nv;
      if (!nv) continue;
      installClimHistSyncHooks(nv, () => this.panel?.syncClimFromVolumes?.(), {
        shouldSkip: () => this.panel?.isApplyingFromPanel?.() ?? false,
      });
    }
  }

  refresh() {
    this._ensurePanel();
    this.panel?.refresh?.();
  }

  syncFromVolumes() {
    this.panel?.syncClimFromVolumes?.();
  }

  dispose() {
    this.panel?.dispose();
    this.panel = null;
    this.ui.root.remove();
  }
}

export { defaultStyle };
