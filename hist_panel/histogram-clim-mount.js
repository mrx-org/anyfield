/**

 * Mount histogram clim UI for main viewer (A) and preview/compare joint row (B+C).

 */



import { attachNiivueHistogramPanel } from "./niivue-histogram-panel.js";

import { attachDualNiivueHistogramPanel } from "./niivue-dual-histogram-panel.js";



export function createClimHistPanelElement(idSuffix = "") {

  const root = document.createElement("div");

  root.className = "clim-hist-panel";

  root.innerHTML = `<canvas class="hist-canvas" data-role="histCanvas"></canvas>`;

  if (idSuffix) root.id = `clim-hist-${idSuffix}`;

  return {

    root,

    histCanvas: root.querySelector('[data-role="histCanvas"]'),

  };

}



/**

 * Keep histogram clim handles in sync when Niivue changes windowing (right-drag, menus, sync).

 * @param {object} nv — Niivue instance

 * @param {() => void} syncFn

 * @param {{ shouldSkip?: () => boolean }} [opts]

 */

export function installClimHistSyncHooks(nv, syncFn, opts = {}) {

  if (!nv || nv._climHistSyncHook) return;

  nv._climHistSyncHook = true;

  const shouldSkip = opts.shouldSkip ?? (() => false);



  let syncRaf = 0;

  const scheduleSync = () => {

    if (shouldSkip()) return;

    if (syncRaf) return;

    syncRaf = requestAnimationFrame(() => {

      syncRaf = 0;

      if (!shouldSkip()) syncFn();

    });

  };



  const prevIntensity = nv.onIntensityChange;

  nv.onIntensityChange = (...args) => {

    if (typeof prevIntensity === "function") prevIntensity(...args);

    scheduleSync();

  };



  const prevMouseUp = nv.onMouseUp;

  nv.onMouseUp = (...args) => {

    if (typeof prevMouseUp === "function") prevMouseUp(...args);

    scheduleSync();

  };



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



/** Histogram for main viewer A — tracks getVolumeForIntensity(). */

export class MainHistogramController {

  constructor(nvModule) {

    this.nvModule = nvModule;

    this.panel = null;

    this._boundVolume = null;

    this._raf = null;

    const ui = createClimHistPanelElement("main");

    this.ui = ui;

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

    installClimHistSyncHooks(nv, () => {

      if (this.panel) this.panel.syncClimFromVolume();

    });

  }



  _volumeIndex() {

    const { vol } = this.nvModule.getVolumeForIntensity();

    if (!vol?.img) return -1;

    const idx = this.nvModule.nv.volumes.indexOf(vol);

    return idx;

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

    if (this.panel) {

      this.panel.dispose();

      this.panel = null;

    }

    this._boundVolume = null;

  }



  dispose() {

    if (this._raf) cancelAnimationFrame(this._raf);

    this._disposePanel();

    this.ui.root.remove();

  }

}



/** Joint histogram under preview B (+ optional compare C). */

export class PreviewJointHistogramController {

  constructor() {

    this.panel = null;

    const ui = createClimHistPanelElement("preview-joint");

    this.ui = ui;

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

    this._installPreviewHooks();

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

        if (!vol?.img) return null;

        return { vol, nv: mod.nv, label: mod.currentScanName || "Preview" };

      },

      getSourceB: () => {

        const cmp = window.scanCompare;

        if (!cmp?.isReady) return null;

        const vol = cmp.module?.nv?.volumes?.[0];

        if (!vol?.img) return null;

        return { vol, nv: cmp.module.nv, label: cmp.module?.currentScanName || "Compare" };

      },

      histogramCanvas: this.ui.histCanvas,

      useRobustAxis: true,

      style: { axisPadding: 0.15 },

    });

  }



  installPreviewHooks() {

    this._installPreviewHooks();

  }



  _installPreviewHooks() {

    for (const key of ["scanPreview", "scanCompare"]) {

      const mod = key === "scanPreview" ? window.scanPreview : window.scanCompare?.module;

      const nv = mod?.nv;

      if (!nv) continue;

      installClimHistSyncHooks(

        nv,

        () => this.panel?.syncClimFromVolumes?.(),

        { shouldSkip: () => this.panel?.isApplyingFromPanel?.() ?? false }

      );

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

    if (this.panel) {

      this.panel.dispose();

      this.panel = null;

    }

    this.ui.root.remove();

  }

}


