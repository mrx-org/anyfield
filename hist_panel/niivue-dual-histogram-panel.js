/**
 * Overlay histogram + shared window (cal_min / cal_max) for two Niivue preview volumes.
 */

import {
  computeLogHistogramBins,
  computeSlabDataRange,
  expandHistAxisRange,
  syncVolumeClimsToCurrent4DFrame,
  volumeIs4D,
  voxelBufferForDisplayedLayer,
} from "./niivue-histogram-panel.js";
import { promptClimEdit } from "./clim-edit-dialog.js";

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
  barColorA: "rgba(91, 164, 230, 0.45)",
  barColorB: "rgba(230, 170, 60, 0.45)",
  tickColor: "#666",
  tickFont: "9px system-ui",
  handleLabelFont: "bold 8px system-ui",
  windowShadeColor: "rgba(255,255,255,0.04)",
  inputDecimals: 2,
  handleLabelDecimals: 2,
  axisTickDecimals: 2,
});

/**
 * @param {object} config
 * @param {() => { vol: object, nv: object, label: string } | null} config.getSourceA
 * @param {() => { vol: object, nv: object, label: string } | null} config.getSourceB
 * @param {HTMLCanvasElement} config.histogramCanvas
 * @param {HTMLInputElement | null | undefined} [config.climMinInput]
 * @param {HTMLInputElement | null | undefined} [config.climMaxInput]
 * @param {boolean} [config.useRobustAxis=true]
 * @param {Partial<typeof defaultStyle>} [config.style]
 */
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

  const hCtx = hCanvas.getContext("2d", { alpha: true, desynchronized: true });
  const offBars = document.createElement("canvas");
  const offBarsCtx = offBars.getContext("2d", { alpha: true });

  let plotL, plotR, plotT, plotB, plotW, plotH, cssW = 300, cssH = 64;
  let backingDpr = 1;
  let frameId = 0;
  let dragging = null;

  function primaryVolume() {
    const a = getSourceA()?.vol;
    if (a?.img) return a;
    return getSourceB()?.vol ?? null;
  }

  function readClimFromVolumes() {
    const vol = primaryVolume();
    if (!vol) return;
    calMin = vol.cal_min;
    calMax = vol.cal_max;
  }

  function recomputeAxisAndBars() {
    const srcA = getSourceA();
    const srcB = getSourceB();
    const vols = [srcA?.vol, srcB?.vol].filter((v) => v?.img);
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
    const axisPad = Number(S.axisPadding);
    const pad = Number.isFinite(axisPad) && axisPad >= 0 ? axisPad : 0.15;
    const expanded = expandHistAxisRange(axisMin, axisMax, pad);
    gMin = expanded.gMin;
    gMax = expanded.gMax;
    gRange = gMax - gMin || 1;

    barA.fill(0);
    barB.fill(0);
    logMax = 1;

    if (srcA?.vol?.img) {
      const view = voxelBufferForDisplayedLayer(srcA.vol);
      const r = computeLogHistogramBins(srcA.vol, view, S, BINS, gMin, gMax, barA);
      logMax = Math.max(logMax, r.logMax);
    }
    if (srcB?.vol?.img) {
      const view = voxelBufferForDisplayedLayer(srcB.vol);
      const r = computeLogHistogramBins(srcB.vol, view, S, BINS, gMin, gMax, barB);
      logMax = Math.max(logMax, r.logMax);
    }
    if (logMax === 0) logMax = 1;
    histStaticDirty = true;
    return true;
  }

  function syncInputs() {
    if (!inMin || !inMax) return;
    inMin.value = calMin.toFixed(S.inputDecimals);
    inMax.value = calMax.toFixed(S.inputDecimals);
  }

  /** @returns {boolean} false when canvas is not laid out yet (e.g. hidden in module-cache). */
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

    const drawBars = (barH, color) => {
      offBarsCtx.fillStyle = color;
      for (let i = 0; i < BINS; i++) {
        const bh = (barH[i] / logMax) * plotH;
        if (bh > 0) offBarsCtx.fillRect(plotL + i * barW, plotB - bh, barW + 0.5, bh);
      }
    };
    drawBars(barA, S.barColorA);
    drawBars(barB, S.barColorB);

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

  function drawClimLine(val, color) {
    const x = valToPx(val);
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

  function applyClimToNiivueInstances() {
    if (calMin > calMax) [calMin, calMax] = [calMax, calMin];
    applyingFromPanel = true;
    try {
      for (const getter of [getSourceA, getSourceB]) {
        const src = getter();
        if (!src?.vol || !src.nv) continue;
        src.vol.cal_min = calMin;
        src.vol.cal_max = calMax;
        if (typeof src.nv.updateGLVolume === "function") src.nv.updateGLVolume();
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

  if (inMin && inMax) {
    inMin.addEventListener("change", commitMin);
    inMax.addEventListener("change", commitMax);
    inMin.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.target.blur();
        commitMin();
      }
    });
    inMax.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.target.blur();
        commitMax();
      }
    });
  }

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
      hCanvas.setPointerCapture(e.pointerId);
      hCanvas.style.cursor = "grabbing";
    }
  };
  const onPointerMove = (e) => {
    if (!dragging) {
      hCanvas.style.cursor = hitTest(cssX(e)) ? "ew-resize" : "default";
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
      /* */
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
        title: "Preview / compare window",
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

  const frameHooks = [];
  function install4DFrameHooks() {
    for (const getter of [getSourceA, getSourceB]) {
      const src = getter();
      if (!src?.nv || !src?.vol || !volumeIs4D(src.vol) || src.nv._dualHistFrameHook) continue;
      src.nv._dualHistFrameHook = true;
      const prev = src.nv.onFrameChange;
      const volRef = src.vol;
      const nvRef = src.nv;
      src.nv.onFrameChange = (changedVol, frameIdx) => {
        if (typeof prev === "function") prev(changedVol, frameIdx);
        if (changedVol !== volRef) return;
        syncVolumeClimsToCurrent4DFrame(volRef, nvRef);
        readClimFromVolumes();
        recomputeAxisAndBars();
        syncInputs();
        draw();
      };
      frameHooks.push({ nv: src.nv, prev });
    }
  }
  install4DFrameHooks();

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

  function refresh() {
    install4DFrameHooks();
    const hadData = recomputeAxisAndBars();
    readClimFromVolumes();
    syncInputs();
    draw();
    return hadData;
  }

  function syncClimFromVolumes() {
    if (applyingFromPanel) return;
    readClimFromVolumes();
    syncInputs();
    if (frameId) cancelAnimationFrame(frameId);
    frameId = 0;
    histStaticDirty = true;
    draw();
  }

  recomputeAxisAndBars();
  readClimFromVolumes();
  syncInputs();

  function dispose() {
    if (inMin && inMax) {
      inMin.removeEventListener("change", commitMin);
      inMax.removeEventListener("change", commitMax);
    }
    hCanvas.removeEventListener("pointerdown", onPointerDown);
    hCanvas.removeEventListener("pointermove", onPointerMove);
    hCanvas.removeEventListener("pointerup", endHistDrag);
    hCanvas.removeEventListener("pointercancel", endHistDrag);
    hCanvas.removeEventListener("dblclick", onDblClick);
    for (const { nv: nvInst, prev } of frameHooks) {
      nvInst.onFrameChange = prev;
      delete nvInst._dualHistFrameHook;
    }
    ro.disconnect();
    if (resizeRaf !== null) cancelAnimationFrame(resizeRaf);
    if (frameId) cancelAnimationFrame(frameId);
  }

  return { dispose, refresh, syncClimFromVolumes, isApplyingFromPanel: () => applyingFromPanel };
}
