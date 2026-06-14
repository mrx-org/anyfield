/**
 * Link position (3D crosshair + 4D frame) and link clims across paper plot panels.
 */

const POSITION_SYNC_OPTS = {
  "2d": true,
  "3d": false,
  crosshair: true,
  sliceType: true,
  zoomPan: false,
  cal_min: false,
  cal_max: false,
  gamma: false,
};

export class PaperPlotSync {
  /** @param {import('./paper_plot.js').PaperPlotModule} module */
  constructor(module) {
    this.module = module;
    this.linkPosition = false;
    this.linkClims = false;
    this._guard = false;
    this._broadcastPairs = [];
  }

  setLinkPosition(on) {
    this.linkPosition = !!on;
    this._rewireBroadcast();
  }

  setLinkClims(on) {
    this.linkClims = !!on;
  }

  /** @param {import('./paper_plot_panel.js').PaperPanel} panel */
  attachPanel(panel) {
    if (!panel?.nv) return;

    const nv = panel.nv;
    const prevFrame = nv.onFrameChange;
    nv.onFrameChange = (changedVol, frameIdx) => {
      prevFrame?.(changedVol, frameIdx);
      const rowLinked = this.module.isRowLinkPosition(this.module.getPanelRow(panel));
      if (this._guard || !this.linkPosition || (!this.module.state.options.linkPosition && !rowLinked)) return;
      this._guard = true;
      try {
        const idx = Number.isFinite(frameIdx) ? frameIdx : changedVol?.frame4D ?? 0;
        this._syncFrameFrom(panel, idx);
      } finally {
        this._guard = false;
      }
    };

    panel._onClimApplied = () => {
      this.module.refreshPanelChrome(panel);
      if (this._guard || !this.linkClims) return;
      this.pushClimsFrom(panel);
    };
  }

  /** @param {import('./paper_plot_panel.js').PaperPanel} source */
  pushClimsFrom(source) {
    const row = this.module.getPanelRow(source);
    const linkAll = !!this.module.state.options.linkClims;
    if (!linkAll && !this.module.isRowLinkClims(row)) return;
    source.captureRuntimeState?.();
    const { calMin, calMax } = source.state ?? {};
    if (!Number.isFinite(calMin) || !Number.isFinite(calMax)) return;

    this._guard = true;
    try {
      for (const p of this.module.panels) {
        if (p === source || !p.nv?.volumes?.length) continue;
        if (!linkAll && this.module.getPanelRow(p) !== row) continue;
        const vol = p.nv.volumes[0];
        vol.cal_min = calMin;
        vol.cal_max = calMax;
        p.updateState?.({ calMin, calMax });
        p.nv.updateGLVolume?.();
        p.nv.drawScene?.();
        this.module.refreshPanelChrome(p);
      }
    } finally {
      this._guard = false;
    }
  }

  /** @param {import('./paper_plot_panel.js').PaperPanel} source */
  _syncFrameFrom(source, frameIdx) {
    const row = this.module.getPanelRow(source);
    const linkAll = !!this.module.state.options.linkPosition;
    for (const p of this.module.panels) {
      if (p === source) continue;
      if (!linkAll && this.module.getPanelRow(p) !== row) continue;
      const vol = p.nv?.volumes?.[0];
      if (!vol) continue;
      // Diff volumes are now 4D, so frame navigation is just a frame change (no rebuild).
      p.setFrame4D?.(frameIdx);
    }
  }

  _rewireBroadcast() {
    for (const { a, b } of this._broadcastPairs) {
      try {
        a?.nv?.unbroadcastFrom?.(b?.nv);
      } catch (_) {}
    }
    this._broadcastPairs = [];

    if (!this.linkPosition) return;

    const live = this.module.panels.filter((p) => p.nv?.volumes?.length);
    for (let i = 0; i < live.length; i++) {
      for (let j = 0; j < live.length; j++) {
        if (i === j) continue;
        const a = live[i];
        const b = live[j];
        const linkAll = !!this.module.state.options.linkPosition;
        if (!linkAll && !this.module.isRowLinkPosition(this.module.getPanelRow(a))) continue;
        if (!linkAll && this.module.getPanelRow(a) !== this.module.getPanelRow(b)) continue;
        if (typeof a.nv.broadcastTo === "function") {
          a.nv.broadcastTo(b.nv, POSITION_SYNC_OPTS);
          this._broadcastPairs.push({ a, b });
        }
      }
    }
  }

  refreshBroadcast() {
    this._rewireBroadcast();
  }

  dispose() {
    this._rewireBroadcast();
  }
}

const MAX_EXPORT_PX = 2048;

/** In-plane matrix size for axial export (NIfTI dims[1] × dims[2]). */
export function nativeVolumePixelSize(vol) {
  const dims = vol?.hdr?.dims ?? vol?.dims;
  if (!dims || dims.length < 3) return null;
  const w = Math.round(Number(dims[1]) || 0);
  const h = Math.round(Number(dims[2]) || 0);
  if (w < 1 || h < 1) return null;
  return {
    w: Math.min(MAX_EXPORT_PX, w),
    h: Math.min(MAX_EXPORT_PX, h),
  };
}

function saveInlineSize(el) {
  if (!el) return null;
  return {
    width: el.style.width,
    height: el.style.height,
  };
}

function restoreInlineSize(el, saved) {
  if (!el || !saved) return;
  if (saved.width) el.style.width = saved.width;
  else el.style.removeProperty("width");
  if (saved.height) el.style.height = saved.height;
  else el.style.removeProperty("height");
}

function forceCanvasBackingStore(nv, canvas, w, h) {
  if (!nv || !canvas || w < 1 || h < 1) return;
  canvas.width = w;
  canvas.height = h;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  nv.resizeListener?.();
}

/**
 * Render the panel at native volume matrix resolution, capture PNG, restore live layout.
 * @param {import('./paper_plot_panel.js').PaperPanel} panel
 * @returns {string|null}
 */
export function capturePanelAtNativeResolution(panel) {
  const nv = panel?.nv;
  if (!nv?.volumes?.length) return null;

  const target = nativeVolumePixelSize(nv.volumes[0]);
  if (!target) return captureWebGLCanvas(nv);

  const canvas = nv.gl?.canvas ?? panel.canvas;
  if (!canvas) return null;

  const saved = {
    host: saveInlineSize(panel.viewerHostEl),
    viewer: saveInlineSize(panel.viewerEl),
  };

  const px = `${target.w}px`;
  const py = `${target.h}px`;
  if (panel.viewerHostEl) {
    panel.viewerHostEl.style.width = px;
    panel.viewerHostEl.style.height = py;
  }
  if (panel.viewerEl) {
    panel.viewerEl.style.width = px;
    panel.viewerEl.style.height = py;
  }

  forceCanvasBackingStore(nv, canvas, target.w, target.h);
  nv.drawScene?.();

  const imgUrl = captureWebGLCanvas(nv);

  restoreInlineSize(panel.viewerHostEl, saved.host);
  restoreInlineSize(panel.viewerEl, saved.viewer);
  nv.resizeListener?.();
  nv.drawScene?.();

  return imgUrl;
}

export function captureWebGLCanvas(nv) {
  const gl = nv?.gl;
  const canvas = gl?.canvas;
  if (!gl || !canvas?.width || !canvas?.height) return null;
  const w = canvas.width;
  const h = canvas.height;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");
  const imgData = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = ((h - 1 - y) * w + x) * 4;
      const dst = (y * w + x) * 4;
      imgData.data[dst] = buf[src];
      imgData.data[dst + 1] = buf[src + 1];
      imgData.data[dst + 2] = buf[src + 2];
      imgData.data[dst + 3] = buf[src + 3];
    }
  }
  ctx.putImageData(imgData, 0, 0);
  return out.toDataURL("image/png");
}
