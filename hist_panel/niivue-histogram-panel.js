import { promptClimEdit } from "./clim-edit-dialog.js";

/**
 * Reusable histogram + window (cal_min / cal_max) UI for Niivue volumes.
 * Peer dependency: a Niivue instance with `volumes[].img` populated after load.
 *
 * For 4D data, pass optional `histogramModeSelect` + `histogramModeRow` to choose
 * “current 3D frame” vs “all frames” and to follow Niivue’s time frame (`onFrameChange`).
 */

/** @typedef {'currentFrame' | 'allFrames'} HistogramMode */

/**
 * @param {object} volume — NVImage
 * @returns {boolean}
 */
export function volumeIs4D(volume) {
  if (volume.nFrame4D != null && volume.nFrame4D > 1) return true;
  const d = volume.hdr?.dims;
  if (d && d[4] != null && d[4] > 1) return true;
  return false;
}

/**
 * @param {object} volume
 * @returns {number}
 */
export function getNVox3D(volume) {
  if (volume.nVox3D) return volume.nVox3D;
  const d = volume.hdr?.dims;
  if (!d || d.length < 4) return 0;
  return d[1] * d[2] * d[3];
}

/**
 * Same 3D slab Niivue uses for the **current** `frame4D` (including frame 0).
 */
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
  const end = Math.min(start + nVox, img.length);
  return img.subarray(start, end);
}

/** All concatenated 3D volumes (typical 4D NIfTI layout). */
export function voxelBufferAllFrames(volume) {
  const img = volume.img;
  if (!img) throw new Error("volume has no img buffer");
  const nVox = getNVox3D(volume);
  if (!nVox) return img;
  const nFr = volume.nFrame4D ?? Math.max(1, Math.floor(img.length / nVox));
  if (nFr <= 1) return img;
  const len = Math.min(img.length, nVox * nFr);
  return img.subarray(0, len);
}

/** Widen histogram x-axis by `pad` fraction of span on each side (default ±15% → 30% total). */
export function expandHistAxisRange(lo, hi, pad = 0.15) {
  const span = hi - lo || 1;
  const p = Number.isFinite(pad) ? pad : 0.15;
  return { gMin: lo - span * p, gMax: hi + span * p };
}

/** Min/max scaled intensity on the currently displayed 3D slab (fallback: robust/global). */
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
  if (Number.isFinite(lo) && Number.isFinite(hi) && lo < hi) {
    return { lo, hi };
  }
  if (useRobustFallback) {
    const rLo =
      Number.isFinite(vol.robust_min) ? vol.robust_min : vol.global_min;
    const rHi =
      Number.isFinite(vol.robust_max) ? vol.robust_max : vol.global_max;
    return { lo: rLo, hi: rHi };
  }
  return { lo: vol.global_min, hi: vol.global_max };
}

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
  /** 4D “all frames” stacked bars: hsla opacity for each colored segment (default solid). */
  multiFrameStackAlpha: 1,
  tickColor: "#666",
  tickFont: "9px system-ui",
  handleLabelFont: "bold 8px system-ui",
  windowShadeColor: "rgba(255,255,255,0.04)",
  inputDecimals: 2,
  handleLabelDecimals: 2,
  axisTickDecimals: 2,
});

/** Robust min/max from the current displayed 3D slab (2nd–98th percentile). */
export function computeSlabRobustClims(vol, lowPct = 0.02, highPct = 0.98) {
  const view = voxelBufferForDisplayedLayer(vol);
  const samples = [];
  const stride = Math.max(1, Math.floor(view.length / 400_000));
  for (let i = 0; i < view.length; i += stride) {
    const v = vol.intensityRaw2Scaled(view[i]);
    if (Number.isFinite(v)) samples.push(v);
  }
  if (!samples.length) {
    return { calMin: vol.cal_min, calMax: vol.cal_max };
  }
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

/**
 * Align volume cal_min/cal_max with the active 4D frame and refresh the GPU texture.
 * @param {object} vol — NVImage
 * @param {object} [nv] — Niivue instance
 */
export function syncVolumeClimsToCurrent4DFrame(vol, nv) {
  if (!vol?.img) {
    return { calMin: vol?.cal_min ?? 0, calMax: vol?.cal_max ?? 1 };
  }

  if (volumeIs4D(vol)) {
    if (typeof vol.calMinMax === "function") {
      try {
        vol.calMinMax(vol.frame4D ?? 0);
      } catch {
        try {
          vol.calMinMax();
        } catch {
          const r = computeSlabRobustClims(vol);
          vol.cal_min = r.calMin;
          vol.cal_max = r.calMax;
        }
      }
    } else {
      const r = computeSlabRobustClims(vol);
      vol.cal_min = r.calMin;
      vol.cal_max = r.calMax;
    }
  }

  if (nv?.updateGLVolume) nv.updateGLVolume();
  nv?.drawScene?.();
  return { calMin: vol.cal_min, calMax: vol.cal_max };
}

/** Golden-angle hue separation for stacked frame layers. */
function hueForFrameIndex(frameIndex) {
  return ((frameIndex * 137.508) % 360 + 360) % 360;
}

/**
 * @param {object} vol
 * @param {Float32Array} voxelView
 * @param {typeof defaultStyle} S
 * @param {number} BINS
 * @param {number} gMin
 * @param {number} gMax
 * @param {Float32Array} barHOut — length BINS, reused (log₁₀(count+1) per bin)
 */
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
  if (logMax === 0) logMax = 1;
  return { histStride, nTot, logMax };
}

function updateHistogramRowVisibility(volume, rowEl, selectEl) {
  if (!rowEl) return;
  const show = volumeIs4D(volume);
  rowEl.style.display = show ? "flex" : "none";
  if (selectEl) selectEl.disabled = !show;
}

/**
 * @param {object} config
 * @param {object} config.niivue — Niivue instance (scene with volumes loaded).
 * @param {number} [config.volumeIndex=0]
 * @param {HTMLCanvasElement} config.histogramCanvas
 * @param {HTMLInputElement | null | undefined} [config.climMinInput] — optional; omit to use canvas tick labels only
 * @param {HTMLInputElement | null | undefined} [config.climMaxInput]
 * @param {HTMLElement | null | undefined} [config.statusElement] — optional footer text.
 * @param {Partial<typeof defaultStyle>} [config.style]
 * @param {HistogramMode} [config.initialHistogramMode='currentFrame']
 * @param {HTMLSelectElement | null | undefined} [config.histogramModeSelect] — 4D mode picker.
 * @param {HTMLElement | null | undefined} [config.histogramModeRow] — shown only for 4D volumes.
 * @param {boolean} [config.useRobustAxis=false] — use robust_min/max for histogram axis when set.
 * @param {boolean} [config.syncClimsOn4DFrame=true] — recalc clims when 4D frame changes.
 * @returns {{ dispose(): void, getHistogramMode(): HistogramMode, setHistogramMode(m: HistogramMode): void, syncClimFromVolume(): void, getClim(): { calMin: number, calMax: number } }}
 */
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

  /** @type {HistogramMode} */
  let histogramMode =
    initialHistogramMode === "allFrames" ? "allFrames" : "currentFrame";

  function voxelSourceForMode() {
    return histogramMode === "allFrames"
      ? voxelBufferAllFrames(vol)
      : voxelBufferForDisplayedLayer(vol);
  }

  const rawMin =
    useRobustAxis && Number.isFinite(vol.robust_min) ? vol.robust_min : vol.global_min;
  const rawMax =
    useRobustAxis && Number.isFinite(vol.robust_max) ? vol.robust_max : vol.global_max;
  const axisPad = typeof S.axisPadding === "number" ? S.axisPadding : 0.15;
  const expanded = expandHistAxisRange(rawMin, rawMax, axisPad);
  const gMin = expanded.gMin;
  const gMax = expanded.gMax;
  const gRange = gMax - gMin || 1;

  const barH = new Float32Array(BINS);
  let logMax = 1;
  let lastHistStride = 1;
  let lastNTot = 0;
  let histStaticDirty = true;

  /** @type {Float32Array[] | null} */
  let perFrameBarH = null;
  /** 4D + “all frames”: multi-color stacked bars per bin (Σ log-count height normalized globally). */
  let use4DStackedHistogram = false;

  function recomputeHistogramBars() {
    const img = vol.img;
    const nVox = getNVox3D(vol);
    const nFrDeclared = vol.nFrame4D ?? (nVox > 0 && img ? Math.floor(img.length / nVox) : 1);
    const nFr =
      nVox > 0 && img
        ? Math.min(Math.max(1, nFrDeclared), Math.ceil(img.length / nVox))
        : 1;

    use4DStackedHistogram =
      histogramMode === "allFrames" && volumeIs4D(vol) && nFr > 1 && nVox > 0 && img;

    if (!use4DStackedHistogram) {
      perFrameBarH = null;
      const view = voxelSourceForMode();
      const r = computeLogHistogramBins(vol, view, S, BINS, gMin, gMax, barH);
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
      const end = Math.min(start + nVox, img.length);
      const slab = img.subarray(start, end);
      const row = new Float32Array(BINS);
      const r = computeLogHistogramBins(vol, slab, S, BINS, gMin, gMax, row);
      perFrameBarH[f] = row;
      sumNTot += r.nTot;
      stride0 = r.histStride;
    }
    lastHistStride = stride0;
    lastNTot = sumNTot;
    logMax = 1;
    histStaticDirty = true;
  }

  recomputeHistogramBars();
  updateHistogramRowVisibility(vol, histogramModeRow, histogramModeSelect);

  if (histogramModeSelect) {
    histogramModeSelect.value = histogramMode;
  }

  let calMin = vol.cal_min;
  let calMax = vol.cal_max;

  const hCtx = hCanvas.getContext("2d", { alpha: true, desynchronized: true });
  const offBars = document.createElement("canvas");
  const offBarsCtx = offBars.getContext("2d", { alpha: true });

  let plotL, plotR, plotT, plotB, plotW, plotH, cssW = 300, cssH = 64;
  let backingDpr = 1;

  function syncInputs() {
    if (!inMin || !inMax) return;
    inMin.value = calMin.toFixed(S.inputDecimals);
    inMax.value = calMax.toFixed(S.inputDecimals);
  }
  syncInputs();

  function writeStatus() {
    if (!statusElement) return;
    const scanNote =
      lastHistStride === 1 ? "full scan (scaled)" : `stride ${lastHistStride} (scaled)`;
    const modeNote =
      histogramMode === "allFrames"
        ? " · 4D: all frames"
        : ` · 4D: frame ${(vol.frame4D ?? 0) + 1}/${vol.nFrame4D ?? 1} (current)`;
    const fourD = volumeIs4D(vol) ? modeNote : "";
    const stackNote =
      use4DStackedHistogram && perFrameBarH
        ? ` · ${perFrameBarH.length}-frame stacked (y = Σ log bins / global max)`
        : "";
    statusElement.textContent =
      `${lastNTot.toLocaleString()} voxels binned · ${scanNote}${fourD}${stackNote} · range ${gMin.toFixed(1)}–${gMax.toFixed(1)} (scaled)`;
  }
  writeStatus();

  /** @returns {boolean} false when canvas has no layout yet. */
  function calcLayout() {
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
    histStaticDirty = true;
    return true;
  }

  function valToPx(v) {
    return plotL + ((v - gMin) / gRange) * plotW;
  }

  function pxToVal(px) {
    let v = gMin + ((px - plotL) / plotW) * gRange;
    return Math.max(gMin, Math.min(gMax, v));
  }

  function redrawHistStaticBacking() {
    if (!histStaticDirty || cssW <= 0 || cssH <= 0) return;
    histStaticDirty = false;
    offBars.width = hCanvas.width;
    offBars.height = hCanvas.height;
    if (offBars.width <= 0 || offBars.height <= 0) {
      histStaticDirty = true;
      return;
    }
    offBarsCtx.setTransform(backingDpr, 0, 0, backingDpr, 0, 0);
    const barW = plotW / BINS;

    if (use4DStackedHistogram && perFrameBarH && perFrameBarH.length > 0) {
      const nLayers = perFrameBarH.length;
      const alpha =
        typeof S.multiFrameStackAlpha === "number" ? S.multiFrameStackAlpha : 1;
      let globalStackMax = 0;
      for (let i = 0; i < BINS; i++) {
        let s = 0;
        for (let f = 0; f < nLayers; f++) s += perFrameBarH[f][i];
        if (s > globalStackMax) globalStackMax = s;
      }
      if (globalStackMax <= 0) globalStackMax = 1;
      const scale = plotH / globalStackMax;
      for (let i = 0; i < BINS; i++) {
        let cumFromBottom = 0;
        for (let f = 0; f < nLayers; f++) {
          const segPx = perFrameBarH[f][i] * scale;
          if (segPx <= 0) continue;
          cumFromBottom += segPx;
          const yTop = plotB - cumFromBottom;
          const hu = hueForFrameIndex(f);
          offBarsCtx.fillStyle = `hsla(${hu}, 72%, 52%, ${alpha})`;
          offBarsCtx.fillRect(plotL + i * barW, yTop, barW + 0.5, segPx);
        }
      }
    } else {
      offBarsCtx.fillStyle = S.barColor;
      for (let i = 0; i < BINS; i++) {
        const bh = (barH[i] / logMax) * plotH;
        offBarsCtx.fillRect(plotL + i * barW, plotB - bh, barW + 0.5, bh);
      }
    }
    offBarsCtx.fillStyle = S.tickColor;
    offBarsCtx.font = S.tickFont;
    offBarsCtx.textBaseline = "top";
    const tickY = plotB + 3;
    offBarsCtx.textAlign = "left";
    offBarsCtx.fillText(gMin.toFixed(S.axisTickDecimals), plotL, tickY);
    offBarsCtx.textAlign = "center";
    offBarsCtx.fillText(((gMin + gMax) / 2).toFixed(S.axisTickDecimals), (plotL + plotR) / 2, tickY);
    offBarsCtx.textAlign = "right";
    offBarsCtx.fillText(gMax.toFixed(S.axisTickDecimals), plotR, tickY);
  }

  function draw() {
    if (!calcLayout()) return;
    redrawHistStaticBacking();
    if (hCanvas.width <= 0 || hCanvas.height <= 0 || offBars.width <= 0 || offBars.height <= 0) {
      return;
    }
    hCtx.setTransform(backingDpr, 0, 0, backingDpr, 0, 0);
    hCtx.clearRect(0, 0, cssW, cssH);
    hCtx.drawImage(offBars, 0, 0, cssW, cssH);

    const x0 = valToPx(calMin);
    const x1 = valToPx(calMax);
    hCtx.fillStyle = S.windowShadeColor;
    hCtx.fillRect(x0, plotT, x1 - x0, plotH);

    drawClimLine(calMin, S.minColor);
    drawClimLine(calMax, S.maxColor);
  }

  function drawClimLine(val, color) {
    const x = valToPx(val);
    if (x < plotL - 2 || x > plotR + 2) return;
    const label = val.toFixed(S.handleLabelDecimals);
    const tickLen = 4;

    hCtx.strokeStyle = color;
    hCtx.lineWidth = 1.5;
    hCtx.setLineDash([]);
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

    hCtx.fillStyle = color;
    hCtx.font = S.handleLabelFont;
    hCtx.textBaseline = "top";
    hCtx.textAlign = "center";
    let tx = x;
    const pad = 2;
    const halfW = (hCtx.measureText(label).width || 24) / 2;
    if (tx - halfW < plotL) tx = plotL + halfW;
    if (tx + halfW > plotR) tx = plotR - halfW;
    hCtx.fillText(label, tx, plotB + tickLen + pad);
  }

  let frameId = 0;

  function scheduleGpuAndRedraw() {
    if (frameId) return;
    frameId = requestAnimationFrame(() => {
      frameId = 0;
      syncInputs();
      nv.updateGLVolume();
      draw();
    });
  }

  function drawHistogramOnly() {
    histStaticDirty = true;
    draw();
    writeStatus();
  }

  function applyClim() {
    if (calMin > calMax) [calMin, calMax] = [calMax, calMin];
    vol.cal_min = calMin;
    vol.cal_max = calMax;
    scheduleGpuAndRedraw();
  }

  const commitMin = () => {
    const v = parseFloat(inMin.value);
    if (isFinite(v)) {
      calMin = v;
      applyClim();
    }
  };
  const commitMax = () => {
    const v = parseFloat(inMax.value);
    if (isFinite(v)) {
      calMax = v;
      applyClim();
    }
  };
  const onMinKeydown = (e) => {
    if (e.key === "Enter") {
      e.target.blur();
      commitMin();
    }
  };
  const onMaxKeydown = (e) => {
    if (e.key === "Enter") {
      e.target.blur();
      commitMax();
    }
  };

  if (inMin && inMax) {
    inMin.addEventListener("change", commitMin);
    inMax.addEventListener("change", commitMax);
    inMin.addEventListener("keydown", onMinKeydown);
    inMax.addEventListener("keydown", onMaxKeydown);
  }

  let dragging = null;

  function cssX(e) {
    const r = hCanvas.getBoundingClientRect();
    return e.clientX - r.left;
  }

  function hitTest(cx) {
    const dMin = Math.abs(cx - valToPx(calMin));
    const dMax = Math.abs(cx - valToPx(calMax));
    const best = dMin <= dMax ? "min" : "max";
    const dist = Math.min(dMin, dMax);
    if (dist > S.lineGrabPx) {
      if (dMin <= S.lineGrabPx) return "min";
      if (dMax <= S.lineGrabPx) return "max";
      return null;
    }
    return best;
  }

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    dragging = hitTest(cssX(e));
    if (dragging) {
      e.preventDefault();
      inMin?.blur?.();
      inMax?.blur?.();
      histogramModeSelect?.blur?.();
      hCanvas.setPointerCapture(e.pointerId);
      hCanvas.style.cursor = "grabbing";
    }
  };

  const onPointerMove = (e) => {
    if (!dragging) {
      const hit = hitTest(cssX(e));
      hCanvas.style.cursor = hit ? "ew-resize" : "default";
      return;
    }
    e.preventDefault();
    const val = pxToVal(cssX(e));
    if (dragging === "min") calMin = val;
    else calMax = val;
    applyClim();
  };

  const endHistDrag = (e) => {
    if (dragging === null) return;
    dragging = null;
    hCanvas.style.cursor = "default";
    try {
      if (e?.pointerId != null) hCanvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    syncInputs();
  };

  hCanvas.addEventListener("pointerdown", onPointerDown);
  hCanvas.addEventListener("pointermove", onPointerMove);
  hCanvas.addEventListener("pointerup", endHistDrag);
  hCanvas.addEventListener("pointercancel", endHistDrag);

  let dblClickOpening = false;
  const onDblClick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragging || dblClickOpening) return;
    dblClickOpening = true;
    try {
      const next = await promptClimEdit({
        calMin,
        calMax,
        decimals: S.handleLabelDecimals,
        title: "Intensity window",
      });
      if (!next) return;
      calMin = next.calMin;
      calMax = next.calMax;
      applyClim();
    } finally {
      dblClickOpening = false;
    }
  };
  hCanvas.addEventListener("dblclick", onDblClick);

  const prevOnFrameChange = nv.onFrameChange;
  const onFrameChange = (changedVol, _frameIdx) => {
    if (typeof prevOnFrameChange === "function") {
      prevOnFrameChange(changedVol, _frameIdx);
    }
    if (changedVol !== vol || histogramMode !== "currentFrame") return;
    if (!volumeIs4D(vol)) return;
    if (syncClimsOn4DFrame) {
      const synced = syncVolumeClimsToCurrent4DFrame(vol, nv);
      calMin = synced.calMin;
      calMax = synced.calMax;
    } else {
      calMin = vol.cal_min;
      calMax = vol.cal_max;
    }
    recomputeHistogramBars();
    syncInputs();
    draw();
  };
  nv.onFrameChange = onFrameChange;

  const onModeChange = () => {
    if (!histogramModeSelect) return;
    const v = histogramModeSelect.value;
    histogramMode = v === "allFrames" ? "allFrames" : "currentFrame";
    recomputeHistogramBars();
    drawHistogramOnly();
  };
  if (histogramModeSelect) {
    histogramModeSelect.addEventListener("change", onModeChange);
  }

  let resizeRaf = null;
  const ro = new ResizeObserver(() => {
    if (resizeRaf !== null) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      calcLayout();
      draw();
    });
  });
  ro.observe(hCanvas);

  draw();

  function getHistogramMode() {
    return histogramMode;
  }

  function setHistogramMode(m) {
    histogramMode = m === "allFrames" ? "allFrames" : "currentFrame";
    if (histogramModeSelect) histogramModeSelect.value = histogramMode;
    recomputeHistogramBars();
    drawHistogramOnly();
  }

  function syncClimFromVolume() {
    calMin = vol.cal_min;
    calMax = vol.cal_max;
    syncInputs();
    if (frameId) cancelAnimationFrame(frameId);
    frameId = 0;
    draw();
  }

  function dispose() {
    nv.onFrameChange = prevOnFrameChange;
    if (histogramModeSelect) {
      histogramModeSelect.removeEventListener("change", onModeChange);
    }
    if (inMin && inMax) {
      inMin.removeEventListener("change", commitMin);
      inMax.removeEventListener("change", commitMax);
      inMin.removeEventListener("keydown", onMinKeydown);
      inMax.removeEventListener("keydown", onMaxKeydown);
    }
    hCanvas.removeEventListener("pointerdown", onPointerDown);
    hCanvas.removeEventListener("pointermove", onPointerMove);
    hCanvas.removeEventListener("pointerup", endHistDrag);
    hCanvas.removeEventListener("pointercancel", endHistDrag);
    hCanvas.removeEventListener("dblclick", onDblClick);
    ro.disconnect();
    if (resizeRaf !== null) cancelAnimationFrame(resizeRaf);
    if (frameId) cancelAnimationFrame(frameId);
    frameId = 0;
  }

  return {
    dispose,
    getHistogramMode,
    setHistogramMode,
    syncClimFromVolume,
    getClim: () => ({ calMin, calMax }),
  };
}

export { defaultStyle };

