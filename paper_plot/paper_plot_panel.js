/**
 * Single paper-plot panel: expression input and Niivue viewer.
 */
import {
  Niivue,
  SLICE_TYPE,
  DRAG_MODE,
  SHOW_RENDER,
} from "https://unpkg.com/@niivue/niivue@0.65.0/dist/index.js";
import {
  installFrameAwareContrastDrag,
  registerPaperPlotColormaps,
  syncVolumeClimsToCurrent4DFrame,
  updatePanelState,
  volumeIs4D,
} from "./paper_plot_figure.js";
import {
  getAxialAspectRatio,
  getPanelCaptionDetail,
  resolvePanelLoad,
  revokeBlobUrl,
} from "./paper_plot_expr.js";

const PAPER_NV_OPTS = {
  logging: false,
  loadingText: "",
  dragMode: DRAG_MODE.contrast,
  show3Dcrosshair: false,
  isOrientCube: false,
  crosshairWidth: 0,
  isOrientationTextVisible: false,
};

export class PaperPanel {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {number} opts.index
   * @param {string} opts.label
   * @param {HTMLElement} opts.slotEl
   * @param {import('./paper_plot.js').PaperPlotModule} opts.module
   */
  constructor(opts) {
    this.id = opts.id;
    this.index = opts.index;
    this.state = opts.state;
    this.label = opts.state?.label;
    this.module = opts.module;
    this.slotEl = opts.slotEl;
    this.expr = this.state?.expr || "";
    this.isDiff = !!this.state?.isDiff;
    this.frame4D = this.state?.frame4D || 0;
    this._blobUrl = null;
    this._loadGen = 0;

    this.nv = null;
    this.canvas = null;
    this.exprInput = null;
    this.errorEl = null;
    this.viewerEl = null;
    this.viewerHostEl = null;
    this.contentLayout = null;
    this.svgBorder = null;
    this.layoutExprInput = null;
    this._onClimApplied = null;
    this._climEventHooksInstalled = false;
  }

  updateState(patch) {
    this.state = updatePanelState(this.module.state, this.index, patch) ?? this.state;
    this.label = this.state.label;
    this.expr = this.state.expr;
    this.isDiff = !!this.state.isDiff;
    this.frame4D = this.state.frame4D ?? 0;
    if (Object.prototype.hasOwnProperty.call(patch, "expr")) {
      if (this.exprInput && this.exprInput.value !== this.state.expr) this.exprInput.value = this.state.expr;
      if (this.layoutExprInput && this.layoutExprInput.value !== this.state.expr) {
        this.layoutExprInput.value = this.state.expr;
      }
    }
    return this.state;
  }

  buildDom() {
    this.slotEl.className = "paper-panel-slot";
    this.slotEl.innerHTML = `
      <div class="paper-panel-expr-row">
        <span class="paper-panel-letter">${this.state.label}</span>
        <input type="text" class="paper-panel-expr" placeholder="scan # or 1-2" spellcheck="false" />
      </div>
      <div class="paper-panel-body viewer-column-stack">
        <div class="paper-panel-viewer-host">
          <div class="paper-panel-viewer">
            <canvas class="paper-panel-canvas"></canvas>
          </div>
        </div>
      </div>
      <div class="paper-panel-error" hidden></div>
    `;
    this.exprInput = this.slotEl.querySelector(".paper-panel-expr");
    this.exprInput.value = this.state.expr || "";
    this.viewerHostEl = this.slotEl.querySelector(".paper-panel-viewer-host");
    this.viewerEl = this.slotEl.querySelector(".paper-panel-viewer");
    this.canvas = this.slotEl.querySelector(".paper-panel-canvas");
    this.errorEl = this.slotEl.querySelector(".paper-panel-error");
    this.exprInput.addEventListener("change", () => this.applyExpr(this.exprInput.value));
    this.exprInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.applyExpr(this.exprInput.value);
      }
    });

    this.slotEl.addEventListener("mousedown", () => this.module.selectPanel(this));
  }

  async initNiivue() {
    if (this.nv) return;
    this.nv = new Niivue({ ...PAPER_NV_OPTS });
    await this.nv.attachToCanvas(this.canvas);
    this.nv.opts.multiplanarShowRender = SHOW_RENDER.NEVER;
    this.nv.setSliceType(SLICE_TYPE.AXIAL);
    this.nv.opts.crosshairWidth = 0;
    this.nv.opts.isOrientationTextVisible = false;
    if (typeof this.nv.setCrosshairWidth === "function") {
      this.nv.setCrosshairWidth(0);
    }
    if (typeof this.nv.setCornerOrientationText === "function") {
      this.nv.setCornerOrientationText(false);
    }

    this.canvas.tabIndex = 0;
    this.canvas.addEventListener("keydown", (e) => this._onKey(e), true);

    this.module.sync.attachPanel(this);
    this._installClimEventHooks();
    installFrameAwareContrastDrag(this.nv);
    registerPaperPlotColormaps(this.nv);
    this.module.registerColormapNames(this.nv.colormaps?.() ?? this.nv.colorMaps?.());
    this.applyColorbarVisibility();
  }

  _colormapForPanel() {
    return this.state.isDiff ? this.module.diffColormap : this.module.scanColormap;
  }

  applyColormap(name) {
    const vol = this.nv?.volumes?.[0];
    if (!vol) return;
    const cmap = name || this._colormapForPanel();
    if (typeof this.nv.setColormap === "function") {
      this.nv.setColormap(vol.id, cmap);
    } else {
      vol.colormap = cmap;
      this.nv.updateGLVolume?.();
    }
    this.nv.drawScene?.();
    this.updateState({ colormap: cmap });
    this.module.refreshPanelChrome(this);
  }

  applyClims({ calMin, calMax }) {
    const vol = this.nv?.volumes?.[0];
    if (!vol || !Number.isFinite(calMin) || !Number.isFinite(calMax)) return;
    vol.cal_min = calMin;
    vol.cal_max = calMax;
    this.nv.updateGLVolume?.();
    this.nv.drawScene?.();
    this.updateState({ calMin, calMax });
    this.module.refreshPanelChrome(this);
    this._onClimApplied?.();
  }

  applyColorbarVisibility() {
    if (!this.nv) return;
    // Paper Plot draws its own vertical SVG colorbar so live view and SVG export match.
    this.nv.opts.isColorbar = false;
    const vol = this.nv.volumes?.[0];
    if (vol) vol.colorbarVisible = false;
    this.nv.drawScene?.();
    this.syncLayout();
  }

  syncLayout() {
    this.module._syncHtmlPositions();
  }

  _onKey(e) {
    if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.code !== "ArrowLeft" && e.code !== "ArrowRight") return;
    if (!this.nv?.volumes?.length) return;
    const vol = this.nv.volumes[0];
    if (!volumeIs4D(vol)) return;
    const nFr = vol.nFrame4D ?? (vol.hdr?.dims?.[4] > 1 ? vol.hdr.dims[4] : 1);
    if (!nFr || nFr <= 1) return;
    const delta = e.code === "ArrowRight" ? 1 : -1;
    const cur = vol.frame4D ?? 0;
    const next = (cur + delta + nFr) % nFr;
    this.setFrame4D(next);
    this.captureRuntimeState();
    if (this.state.isDiff && this.module.sync.linkPosition) {
      this.module.sync._syncFrameFrom(this, next);
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  setFrame4D(frameIdx) {
    const vol = this.nv?.volumes?.[0];
    if (!vol) return;
    const nFr = vol.nFrame4D ?? (vol.hdr?.dims?.[4] > 1 ? vol.hdr.dims[4] : 1);
    const frame = Math.min(Math.max(0, Number(frameIdx) || 0), Math.max(0, nFr - 1));
    if (typeof this.nv.setFrame4D === "function") {
      this.nv.setFrame4D(vol.id, frame);
    } else {
      vol.frame4D = frame;
      this.nv.updateGLVolume?.();
    }
    syncVolumeClimsToCurrent4DFrame(vol, this.nv, frame);
    this.updateState({ frame4D: frame });
    this.nv.drawScene?.();
  }

  setSelected(on) {
    this.slotEl.classList.toggle("paper-panel-selected", !!on);
  }

  setExpr(expr, apply = true) {
    this.exprInput.value = expr;
    if (this.layoutExprInput && this.layoutExprInput.value !== String(expr ?? "")) {
      this.layoutExprInput.value = expr;
    }
    if (apply) return this.applyExpr(expr);
    this.updateState({ expr: String(expr ?? "").trim() });
    return Promise.resolve();
  }

  async applyExpr(expr) {
    const cleanExpr = String(expr ?? "").trim();
    if (this.layoutExprInput && this.layoutExprInput.value !== cleanExpr) this.layoutExprInput.value = cleanExpr;
    this.updateState({ expr: cleanExpr, error: "" });
    const gen = ++this._loadGen;
    this.setError("");

    if (!cleanExpr) {
      await this.clearVolume();
      return;
    }

    await this.initNiivue();
    const spec = await resolvePanelLoad(cleanExpr, this.frame4D);
    if (gen !== this._loadGen) return;

    if (spec.error) {
      this.setError(spec.error);
      this.updateState({ error: spec.error, isDiff: spec.isDiff, captionDetail: "", tooltip: "" });
      await this.clearVolume(false);
      this.updateState({ error: spec.error, expr: cleanExpr, isDiff: spec.isDiff });
      return;
    }

    if (this._blobUrl) {
      revokeBlobUrl(this._blobUrl);
      this._blobUrl = null;
    }

    this.updateState({
      expr: cleanExpr,
      isDiff: spec.isDiff,
      error: "",
      colormap: this._colormapForPanel(),
      tooltip: this.module.getPanelTooltip(this),
      captionDetail: getPanelCaptionDetail(cleanExpr),
    });
    if (spec.isDiff && spec.url.startsWith("blob:")) {
      this._blobUrl = spec.url;
    }

    while (this.nv.volumes.length > 0) {
      this.nv.removeVolume(this.nv.volumes[0]);
    }
    await this.nv.addVolumesFromUrl([
      {
        url: spec.url,
        name: spec.name,
        colormap: this._colormapForPanel(),
        opacity: 1,
      },
    ]);

    const vol = this.nv.volumes[0];
    if (vol) {
      vol.sourceUrl = spec.url;
      if (spec.isDiff && Number.isFinite(spec.calMin) && Number.isFinite(spec.calMax)) {
        vol.cal_min = spec.calMin;
        vol.cal_max = spec.calMax;
      }
      if (!spec.isDiff && volumeIs4D(vol)) {
        const fr = spec.frame4D ?? 0;
        if (typeof this.nv.setFrame4D === "function") {
          this.nv.setFrame4D(vol.id, fr);
        } else {
          vol.frame4D = fr;
        }
        syncVolumeClimsToCurrent4DFrame(vol, this.nv, fr);
        this.updateState({ frame4D: fr });
      }
      this.updateState({
        volumeAspect: getAxialAspectRatio(vol),
        calMin: Number.isFinite(vol.cal_min) ? vol.cal_min : null,
        calMax: Number.isFinite(vol.cal_max) ? vol.cal_max : null,
      });
    }

    this.applyColormap(this._colormapForPanel());
    this.applyColorbarVisibility();
    this.nv.drawScene();
    this._wrapClimApply();
    this.syncLayout();
    this.slotEl.title = this.state.expr ? this.module.getPanelTooltip(this) : "";
    this.module.updateCaption();
    this.module.autosaveLayout();
    this.module.sync.refreshBroadcast();
  }

  async reloadAtFrame(frame4D) {
    if (!this.state.isDiff || !this.state.expr) return;
    this.updateState({ frame4D });
    await this.applyExpr(this.state.expr);
  }

  async clearVolume(keepExpr = true) {
    if (!keepExpr) this.updateState({ expr: "" });
    if (this._blobUrl) {
      revokeBlobUrl(this._blobUrl);
      this._blobUrl = null;
    }
    this.updateState({ isDiff: false, error: "", volumeAspect: 1, calMin: null, calMax: null });
    if (this.nv) {
      while (this.nv.volumes.length > 0) {
        this.nv.removeVolume(this.nv.volumes[0]);
      }
      this.nv.drawScene();
    }
    this.syncLayout();
    this.slotEl.title = "";
    this.module.updateCaption();
    this.module.autosaveLayout();
    this.module.sync.refreshBroadcast();
  }

  _wrapClimApply() {
    const vol = this.nv?.volumes?.[0];
    if (!vol) return;
    const nv = this.nv;
    const orig = nv.updateGLVolume?.bind(nv);
    if (!orig || nv._paperPlotClimHook) return;
    nv._paperPlotClimHook = true;
    nv.updateGLVolume = (...args) => {
      const r = orig(...args);
      if (!this.module.sync._guard) {
        this.captureRuntimeState();
        this._onClimApplied?.();
      }
      return r;
    };
  }

  _installClimEventHooks() {
    const nv = this.nv;
    if (!nv || this._climEventHooksInstalled) return;
    this._climEventHooksInstalled = true;

    const notify = () => {
      if (this.module.sync._guard) return;
      this.captureRuntimeState();
      this._onClimApplied?.();
    };

    const prevMouseUp = nv.onMouseUp;
    nv.onMouseUp = (...args) => {
      prevMouseUp?.(...args);
      notify();
    };

    const prevIntensity = nv.onIntensityChange;
    nv.onIntensityChange = (...args) => {
      prevIntensity?.(...args);
      notify();
    };
  }

  setError(msg) {
    if (!this.errorEl) return;
    this.updateState({ error: msg || "" });
    if (msg) {
      this.errorEl.hidden = false;
      this.errorEl.textContent = msg;
    } else {
      this.errorEl.hidden = true;
      this.errorEl.textContent = "";
    }
  }

  resize() {
    this.syncLayout();
  }

  captureRuntimeState() {
    const vol = this.nv?.volumes?.[0];
    this.updateState({
      expr: this.exprInput?.value?.trim?.() ?? this.state.expr,
      isDiff: this.state.isDiff,
      frame4D: vol?.frame4D ?? this.state.frame4D ?? 0,
      calMin: Number.isFinite(vol?.cal_min) ? vol.cal_min : this.state.calMin,
      calMax: Number.isFinite(vol?.cal_max) ? vol.cal_max : this.state.calMax,
      volumeAspect: vol ? getAxialAspectRatio(vol) : this.state.volumeAspect,
      colormap: vol?.colormap || this.state.colormap || this._colormapForPanel(),
      tooltip: this.state.expr ? this.module.getPanelTooltip(this) : "",
      captionDetail: this.state.expr ? getPanelCaptionDetail(this.state.expr) : "",
    });
    return this.state;
  }

  dispose() {
    if (this._blobUrl) {
      revokeBlobUrl(this._blobUrl);
      this._blobUrl = null;
    }
    if (this.nv) {
      while (this.nv.volumes.length > 0) {
        this.nv.removeVolume(this.nv.volumes[0]);
      }
      this.nv = null;
    }
  }
}
