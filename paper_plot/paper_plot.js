/**
 * Paper Plot — figure builder overlay.
 */
import {
  GRID_PRESETS,
  MAX_COLS,
  MAX_ROWS,
  computeGridLayout,
  computePanelContentLayout,
  computePackedContentLayouts,
  getStageTransform,
  mapSvgToCssRect,
  createDefaultFigureState,
  deserializeFigureState,
  ensurePanelCount,
  serializeFigureState,
  validateFigureState,
  DEFAULT_DIFF_COLORMAP,
  DEFAULT_SCAN_COLORMAP,
  PAPER_COLORMAP_ORDER,
  resolvePaperColormapOptions,
  promptClimEdit,
  SVG_NS,
  appendCaption,
  appendImage,
  appendPanelExportChrome,
  appendPanelLabel,
  appendVerticalColorbar,
  appendRect,
  measureExportCaption,
  createPanelChrome,
  createSvgRoot,
  setSvgRootSize,
  updatePanelChrome,
} from "./paper_plot_figure.js";
import { PaperPanel } from "./paper_plot_panel.js";
import { PaperPlotSync, capturePanelAtNativeResolution } from "./paper_plot_sync.js";
import {
  buildScanLabelRefs,
  getPanelCaptionDetail,
  getProtocolTooltipForScanNumber,
  parsePanelExpr,
} from "./paper_plot_expr.js";

export class PaperPlotModule {
  constructor() {
    this.state = createDefaultFigureState();
    this.open = false;
    /** @type {PaperPanel[]} */
    this.panels = [];
    this.selectedPanel = null;
    this.sync = new PaperPlotSync(this);

    this.overlay = null;
    this.railList = null;
    this.stageEl = null;
    this.htmlLayer = null;
    this.svgRoot = null;
    this.captionEl = null;
    this.layoutPaneEl = null;
    this.layoutPreviewEl = null;
    this._svgGroups = [];
    this._cssLoaded = false;
    this._overlayReady = false;
    this._lastGridCols = 0;
    this._lastGridRows = 0;
    this._colormapNames = PAPER_COLORMAP_ORDER.slice();
    this._niivueColormapNames = null;
    this._climDialogOpening = false;
    this.scanColormapSelect = null;
    this.diffColormapSelect = null;
  }

  get cols() {
    return this.state.grid.cols;
  }

  get rows() {
    return this.state.grid.rows;
  }

  get showColorbar() {
    return this.state.options.showColorbar;
  }

  get scanColormap() {
    return this.state.options.scanColormap;
  }

  get diffColormap() {
    return this.state.options.diffColormap;
  }

  get figure() {
    return this.state.figure;
  }

  init() {
    if (!this._cssLoaded) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "paper_plot/paper_plot.css?v=6";
      document.head.appendChild(link);
      this._cssLoaded = true;
    }
  }

  async toggle() {
    if (this._isVisible()) {
      this.close();
      return;
    }
    // Recover from stale open flag (e.g. partial failed show).
    this.open = false;
    await this.show();
  }

  _isVisible() {
    if (!this.overlay) return false;
    return !this.overlay.hidden && !this.overlay.hasAttribute("hidden");
  }

  async show() {
    if (!this._overlayReady) await this._buildOverlay();
    this.overlay.hidden = false;
    this.overlay.removeAttribute("hidden");
    document.body.classList.add("paper-plot-open");
    this.syncControlsFromState();
    this.refreshScanRail();

    const gridChanged =
      this.panels.length === 0 ||
      this._lastGridCols !== this.cols ||
      this._lastGridRows !== this.rows;

    if (gridChanged) {
      this.setGrid(this.cols, this.rows);
      this._lastGridCols = this.cols;
      this._lastGridRows = this.rows;
    } else {
      for (const p of this.panels) p.resize();
      this.sync.refreshBroadcast();
    }

    if (this._stageRo && this.stageEl) this._stageRo.observe(this.stageEl);
    requestAnimationFrame(() => this._syncHtmlPositions());
    this.open = true;
  }

  close() {
    this.open = false;
    if (this.overlay) {
      this.overlay.hidden = true;
      this.overlay.setAttribute("hidden", "");
    }
    document.body.classList.remove("paper-plot-open");
  }

  async _buildOverlay() {
    this.overlay = document.createElement("div");
    this.overlay.id = "paper-plot-overlay";
    this.overlay.hidden = true;
    this.overlay.innerHTML = `
      <div class="paper-plot-shell">
        <div class="paper-plot-header" role="banner">
          <div class="paper-plot-header-row">
            <div class="paper-plot-header-title">Paper Plot</div>
            <button type="button" class="paper-plot-close" id="paper-plot-close" title="Close">✕</button>
          </div>
        </div>
        <div class="paper-plot-body">
          <aside class="paper-plot-rail">
            <div class="paper-plot-rail-title">Scans</div>
            <div class="paper-plot-rail-hint">Click to assign to selected panel</div>
            <div class="paper-plot-rail-list" id="paper-plot-rail-list"></div>
          </aside>
          <div class="paper-plot-stage-column">
            <div class="paper-plot-layout-pane" id="paper-plot-layout-pane">
              <div class="paper-plot-layout-controls">
                <span class="paper-plot-toolbar-label">Layout</span>
                <div class="paper-plot-grid-btns" id="paper-plot-grid-btns"></div>
              </div>
              <div class="paper-plot-layout-matrix">
                <div class="paper-plot-layout-preview" id="paper-plot-layout-preview"></div>
                <div class="paper-layout-row paper-plot-global-link-row">
                  <div class="paper-layout-row-spacer" aria-hidden="true"></div>
                  <div class="paper-plot-global-link-controls paper-layout-row-links">
                    <span class="paper-row-link-word">Link all:</span>
                    <label class="paper-plot-check paper-row-link-inline"><input type="checkbox" id="paper-link-all-position" /><span>4D dims</span></label>
                    <label class="paper-plot-check paper-row-link-inline"><input type="checkbox" id="paper-link-all-clims" /><span>color lims</span></label>
                  </div>
                </div>
              </div>
              <div class="paper-plot-display-controls">
                <label class="paper-plot-check"><input type="checkbox" id="paper-show-colorbar" /> Colorbar</label>
                <label class="paper-plot-select-label">
                  Scan cmap
                  <select id="paper-scan-colormap" class="paper-plot-colormap-select"></select>
                </label>
                <label class="paper-plot-select-label">
                  Diff cmap
                  <select id="paper-diff-colormap" class="paper-plot-colormap-select"></select>
                </label>
                <span class="paper-plot-toolbar-sep" aria-hidden="true"></span>
                <button type="button" class="paper-plot-export" id="paper-plot-export">Download SVG</button>
              </div>
            </div>
            <div class="paper-plot-stage-wrap">
              <div class="paper-plot-stage" id="paper-plot-stage">
                <div class="paper-plot-html-layer" id="paper-plot-html-layer"></div>
              </div>
            </div>
            <div class="paper-plot-caption-wrap">
              <div class="paper-plot-caption" id="paper-plot-caption">Figure 1:</div>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(this.overlay);

    this.railList = this.overlay.querySelector("#paper-plot-rail-list");
    this.stageEl = this.overlay.querySelector("#paper-plot-stage");
    this.htmlLayer = this.overlay.querySelector("#paper-plot-html-layer");
    this.captionEl = this.overlay.querySelector("#paper-plot-caption");
    this.layoutPaneEl = this.overlay.querySelector("#paper-plot-layout-pane");
    this.layoutPreviewEl = this.overlay.querySelector("#paper-plot-layout-preview");

    const gridBtns = this.overlay.querySelector("#paper-plot-grid-btns");
    for (const p of GRID_PRESETS) {
      if (p.cols > MAX_COLS || p.rows > MAX_ROWS) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "paper-plot-grid-btn";
      b.textContent = p.displayLabel ?? p.label;
      b.dataset.cols = String(p.cols);
      b.dataset.rows = String(p.rows);
      b.addEventListener("click", () => this.setGrid(p.cols, p.rows));
      gridBtns.appendChild(b);
    }

    this.scanColormapSelect = this.overlay.querySelector("#paper-scan-colormap");
    this.diffColormapSelect = this.overlay.querySelector("#paper-diff-colormap");
    this._populateColormapSelects(resolvePaperColormapOptions(null, [this.scanColormap, this.diffColormap]));
    this.scanColormapSelect.value = this.scanColormap;
    this.diffColormapSelect.value = this.diffColormap;

    this.overlay.querySelector("#paper-show-colorbar").addEventListener("change", (e) => {
      this.setShowColorbar(e.target.checked);
    });
    this.scanColormapSelect.addEventListener("change", (e) => {
      this.setScanColormap(e.target.value);
    });
    this.diffColormapSelect.addEventListener("change", (e) => {
      this.setDiffColormap(e.target.value);
    });
    this.overlay.querySelector("#paper-link-all-position").addEventListener("change", (e) => {
      this.setAllRowLinkPosition(e.target.checked);
    });
    this.overlay.querySelector("#paper-link-all-clims").addEventListener("change", (e) => {
      this.setAllRowLinkClims(e.target.checked);
    });
    this.overlay.querySelector("#paper-plot-export").addEventListener("click", () => this.exportSvg());
    this.overlay.querySelector("#paper-plot-close").addEventListener("click", () => this.close());

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.open && !this._climDialogOpening) this.close();
    });

    window.addEventListener("resize", () => {
      if (this.open) this._syncHtmlPositions();
    });

    if (typeof ResizeObserver !== "undefined") {
      this._stageRo = new ResizeObserver(() => {
        if (this.open) this._syncHtmlPositions();
      });
    }

    const svg = createSvgRoot({ width: this.figure.width, height: this.figure.height, className: "paper-plot-svg-root" });
    this.stageEl.appendChild(svg);
    this.svgRoot = svg;
    this._overlayReady = true;
  }

  _panelChromeOptions(panel) {
    return {
      ...this.state.options,
      panelIndex: panel.index,
      onColorbarDblClick: (idx) => this.openPanelClimDialog(this.panels[idx]),
    };
  }

  async openPanelClimDialog(panel) {
    if (!panel?.nv?.volumes?.length || this._climDialogOpening) return;
    panel.captureRuntimeState?.();
    const { calMin, calMax } = panel.state ?? {};
    if (!Number.isFinite(calMin) || !Number.isFinite(calMax)) return;

    this._climDialogOpening = true;
    this.selectPanel(panel);
    try {
      const next = await promptClimEdit({
        calMin,
        calMax,
        decimals: 2,
        title: `${panel.state.label} intensity window`,
        container: this.overlay ?? document.body,
        zIndex: 25000,
      });
      if (!next) return;
      panel.applyClims(next);
      this.autosaveLayout();
    } finally {
      this._climDialogOpening = false;
    }
  }

  _populateColormapSelects(names) {
    const list = names?.length
      ? names
      : resolvePaperColormapOptions(this._niivueColormapNames, [this.scanColormap, this.diffColormap]);
    this._colormapNames = list;
    for (const sel of [this.scanColormapSelect, this.diffColormapSelect]) {
      if (!sel) continue;
      sel.innerHTML = list.map((n) => `<option value="${this._escapeAttr(n)}">${n}</option>`).join("");
    }
    if (this.scanColormapSelect) {
      if (!list.includes(this.scanColormap)) {
        const keepDefault =
          this.scanColormap === DEFAULT_SCAN_COLORMAP && !this._niivueColormapNames?.length;
        if (!keepDefault) {
          this.state.options.scanColormap = list.includes(DEFAULT_SCAN_COLORMAP)
            ? DEFAULT_SCAN_COLORMAP
            : (list[0] ?? DEFAULT_SCAN_COLORMAP);
        }
      }
      if (list.includes(this.scanColormap)) this.scanColormapSelect.value = this.scanColormap;
    }
    if (this.diffColormapSelect) {
      if (!list.includes(this.diffColormap)) {
        const keepDefault =
          this.diffColormap === DEFAULT_DIFF_COLORMAP && !this._niivueColormapNames?.length;
        if (!keepDefault) {
          this.state.options.diffColormap = list.includes(DEFAULT_DIFF_COLORMAP)
            ? DEFAULT_DIFF_COLORMAP
            : (list[0] ?? DEFAULT_DIFF_COLORMAP);
        }
      }
      if (list.includes(this.diffColormap)) this.diffColormapSelect.value = this.diffColormap;
    }
  }

  registerColormapNames(names) {
    if (!names?.length) return;
    this._niivueColormapNames = names;
    this._populateColormapSelects(
      resolvePaperColormapOptions(names, [this.scanColormap, this.diffColormap])
    );
    for (const p of this.panels) {
      if (!p.nv?.volumes?.length) continue;
      p.applyColormap(p.isDiff ? this.diffColormap : this.scanColormap);
    }
  }

  ensureRowLinkArrays() {
    const opts = this.state.options;
    if (!Array.isArray(opts.rowLinkPosition)) opts.rowLinkPosition = [];
    if (!Array.isArray(opts.rowLinkClims)) opts.rowLinkClims = [];
    while (opts.rowLinkPosition.length < this.rows) opts.rowLinkPosition.push(!!opts.linkPosition);
    while (opts.rowLinkClims.length < this.rows) opts.rowLinkClims.push(!!opts.linkClims);
    opts.rowLinkPosition = opts.rowLinkPosition.slice(0, this.rows).map(Boolean);
    opts.rowLinkClims = opts.rowLinkClims.slice(0, this.rows).map(Boolean);
    opts.linkPosition = !!opts.linkPosition;
    opts.linkClims = !!opts.linkClims;
  }

  getPanelRow(panelOrIndex) {
    const index = typeof panelOrIndex === "number" ? panelOrIndex : panelOrIndex?.index;
    return Math.floor((Number(index) || 0) / this.cols);
  }

  isRowLinkPosition(row) {
    return !!this.state.options.rowLinkPosition?.[row];
  }

  isRowLinkClims(row) {
    return !!this.state.options.rowLinkClims?.[row];
  }

  hasAnyRowLinkPosition() {
    return this.state.options.rowLinkPosition?.some(Boolean);
  }

  setRowLinkPosition(row, on) {
    this.ensureRowLinkArrays();
    this.state.options.rowLinkPosition[row] = !!on;
    this.state.options.linkPosition = false;
    this.sync.setLinkPosition(this.hasAnyRowLinkPosition());
    this.syncControlsFromState();
    this.autosaveLayout();
  }

  setRowLinkClims(row, on) {
    this.ensureRowLinkArrays();
    this.state.options.rowLinkClims[row] = !!on;
    this.state.options.linkClims = false;
    this.sync.setLinkClims(this.state.options.rowLinkClims.some(Boolean));
    this.recomputePanelLayouts();
    this.syncControlsFromState();
    this.autosaveLayout();
  }

  setAllRowLinkPosition(on) {
    this.state.options.rowLinkPosition = Array.from({ length: this.rows }, () => !!on);
    this.state.options.linkPosition = !!on;
    this.sync.setLinkPosition(!!on);
    this.syncControlsFromState();
    this.autosaveLayout();
  }

  setAllRowLinkClims(on) {
    this.state.options.rowLinkClims = Array.from({ length: this.rows }, () => !!on);
    this.state.options.linkClims = !!on;
    this.sync.setLinkClims(!!on);
    this.recomputePanelLayouts();
    this.syncControlsFromState();
    this.autosaveLayout();
  }

  getRecentScanNumbers() {
    const seen = new Set();
    const nums = [];
    const add = (num) => {
      const n = Number(num);
      if (!Number.isFinite(n) || seen.has(n)) return;
      seen.add(n);
      nums.push(n);
    };

    const nv = window.nvModule?.nv;
    if (nv?.volumes?.length) {
      for (const v of nv.volumes) {
        const m = String(v?.name ?? "").match(/^scan_(\d+)/i);
        if (m) add(parseInt(m[1], 10));
      }
    }

    const queue = window.scanModule?.queue ?? [];
    for (const j of queue) {
      if (j.status === "done") add(j.scanNumber);
    }

    return nums.sort((a, b) => b - a);
  }

  recentScanExprs(count, repeatLatest = true) {
    const nums = this.getRecentScanNumbers();
    if (!nums.length) return [];
    return Array.from({ length: count }, (_, i) => {
      const n = nums[i] ?? (repeatLatest ? nums[0] : null);
      return n == null ? "" : String(n);
    });
  }

  seedPanelExpressions(count, previousExprs = []) {
    const recent = this.recentScanExprs(count, true);
    const hasPrevious = previousExprs.some((expr) => String(expr ?? "").trim());
    for (let i = 0; i < count; i++) {
      const prev = hasPrevious ? String(previousExprs[i] ?? "").trim() : "";
      const expr = prev || recent[i] || "";
      this.state.panels[i].expr = expr;
      if (!expr) {
        this.state.panels[i].captionDetail = "";
        this.state.panels[i].tooltip = "";
      }
    }
  }

  setShowColorbar(on) {
    this.state.options.showColorbar = !!on;
    for (const p of this.panels) p.applyColorbarVisibility();
    this._syncHtmlPositions();
    this.autosaveLayout();
  }

  setScanColormap(name) {
    this.state.options.scanColormap = String(name || DEFAULT_SCAN_COLORMAP);
    if (this.scanColormapSelect) this.scanColormapSelect.value = this.scanColormap;
    for (const p of this.panels) {
      if (p.nv?.volumes?.length && !p.isDiff) p.applyColormap(this.scanColormap);
    }
    this.autosaveLayout();
  }

  setDiffColormap(name) {
    this.state.options.diffColormap = String(name || DEFAULT_DIFF_COLORMAP);
    if (this.diffColormapSelect) this.diffColormapSelect.value = this.diffColormap;
    for (const p of this.panels) {
      if (p.nv?.volumes?.length && p.isDiff) p.applyColormap(this.diffColormap);
    }
    this.autosaveLayout();
  }

  recomputePanelLayouts() {
    if (!this.panels.length) return;
    const layouts = computeGridLayout(this.state);
    for (let i = 0; i < this.panels.length; i++) {
      const old = this.panels[i].layout;
      if (!old) continue;
      this.panels[i].layout = { ...old, ...layouts[i] };
    }
    this._syncHtmlPositions();
  }

  setGrid(cols, rows, opts = {}) {
    if (!this.svgRoot) {
      console.warn("PaperPlot setGrid: svgRoot not ready");
      return;
    }
    const {
      preserveExisting = true,
      autoFill = true,
      loadExpressions = true,
    } = opts;
    const previousExprs = preserveExisting
      ? this.state.panels.map((p) => String(p?.expr ?? "").trim())
      : [];
    cols = Math.min(MAX_COLS, Math.max(1, cols));
    rows = Math.min(MAX_ROWS, Math.max(1, rows));
    this.state.grid.cols = cols;
    this.state.grid.rows = rows;
    this.ensureRowLinkArrays();
    this._lastGridCols = cols;
    this._lastGridRows = rows;
    ensurePanelCount(this.state);
    if (autoFill) this.seedPanelExpressions(cols * rows, previousExprs);
    setSvgRootSize(this.svgRoot, this.figure);

    for (const p of this.panels) p.dispose();
    this.panels = [];
    this.selectedPanel = null;
    this.htmlLayer.innerHTML = "";
    this._svgGroups.forEach((g) => g.remove());
    this._svgGroups = [];

    const n = cols * rows;
    const layout = computeGridLayout(this.state);

    for (let i = 0; i < n; i++) {
      const slot = document.createElement("div");
      slot.dataset.panelIndex = String(i);
      this.htmlLayer.appendChild(slot);

      const panelState = this.state.panels[i];
      const panel = new PaperPanel({
        id: `paper-panel-${i}`,
        index: i,
        state: panelState,
        slotEl: slot,
        module: this,
      });
      panel.buildDom();
      this.panels.push(panel);

      const L = layout[i];
      const chrome = createPanelChrome(this.svgRoot, L, panelState, "screen");
      panel.svgBorder = chrome.border;
      panel.svgTitle = chrome.title;
      panel.svgChrome = chrome;
      panel.layout = L;
      panel.contentLayout = null;
      this._svgGroups.push(chrome.g);
    }

    this.buildLayoutPreview();
    if (this.panels.length) this.selectPanel(this.panels[0]);
    this._syncHtmlPositions();
    this._updateGridBtnActive();
    this.updateCaption();
    if (loadExpressions) this.loadPanelExpressions();
    this.autosaveLayout();
  }

  loadPanelExpressions() {
    for (const panel of this.panels) {
      const expr = panel.state.expr?.trim?.();
      if (!expr) continue;
      panel.setExpr(expr).catch?.((e) => console.warn("Paper panel load:", e));
    }
  }

  computePanelContentLayout(panel) {
    return computePanelContentLayout(panel.layout, panel.state, this.state.options);
  }

  computeAllContentLayouts() {
    const cellLayouts = this.panels.map((p) => p.layout);
    return computePackedContentLayouts(cellLayouts, this.state.panels, this.state);
  }

  buildLayoutPreview() {
    if (!this.layoutPreviewEl) return;
    this.ensureRowLinkArrays();
    this.layoutPreviewEl.innerHTML = "";
    for (let row = 0; row < this.rows; row++) {
      const rowEl = document.createElement("div");
      rowEl.className = "paper-layout-row";

      const cells = document.createElement("div");
      cells.className = "paper-layout-row-cells";
      cells.style.gridTemplateColumns = `repeat(${this.cols}, minmax(59px, 1fr))`;

      const start = row * this.cols;
      for (let c = 0; c < this.cols; c++) {
        const panel = this.panels[start + c];
        if (!panel) continue;
        const item = document.createElement("label");
        item.className = "paper-layout-mini-cell";
        item.dataset.panelIndex = String(panel.index);
        item.innerHTML = `
          <span class="paper-layout-mini-label">${panel.state.label}</span>
          <input type="text" class="paper-layout-mini-input" placeholder="scan # or 1-2" spellcheck="false" />
        `;
        const input = item.querySelector(".paper-layout-mini-input");
        input.value = panel.state.expr || "";
        input.addEventListener("focus", () => this.selectPanel(panel));
        input.addEventListener("change", () => panel.setExpr(input.value));
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            panel.setExpr(input.value);
            input.blur();
          }
        });
        panel.layoutExprInput = input;
        item.addEventListener("mousedown", () => this.selectPanel(panel));
        cells.appendChild(item);
      }

      const links = document.createElement("div");
      links.className = "paper-layout-row-links";
      links.innerHTML = `
        <span class="paper-row-link-word">Link row:</span>
        <label class="paper-plot-check paper-row-link-inline"><input type="checkbox" class="paper-row-link-position" data-row="${row}" /><span>4D dims</span></label>
        <label class="paper-plot-check paper-row-link-inline"><input type="checkbox" class="paper-row-link-clims" data-row="${row}" /><span>color lims</span></label>
      `;
      links.querySelector(".paper-row-link-position").checked = this.isRowLinkPosition(row);
      links.querySelector(".paper-row-link-clims").checked = this.isRowLinkClims(row);
      links.querySelector(".paper-row-link-position").addEventListener("change", (e) => {
        this.setRowLinkPosition(row, e.target.checked);
      });
      links.querySelector(".paper-row-link-clims").addEventListener("change", (e) => {
        this.setRowLinkClims(row, e.target.checked);
      });

      rowEl.appendChild(cells);
      rowEl.appendChild(links);
      this.layoutPreviewEl.appendChild(rowEl);
    }
    this.updateLayoutPreviewSelection();
  }

  updateLayoutPreviewSelection() {
    this.layoutPreviewEl?.querySelectorAll(".paper-layout-mini-cell").forEach((el) => {
      el.classList.toggle("selected", Number(el.dataset.panelIndex) === this.selectedPanel?.index);
    });
  }

  syncPanelLayout(panel, scaleX, scaleY, offX, offY) {
    const content = panel._pendingContentLayout ?? this.computePanelContentLayout(panel);
    if (!content) return;
    panel.contentLayout = content;

    const slotRect = content.slotRect ?? content;
    const cssRect = mapSvgToCssRect(slotRect, { scaleX, scaleY, offX, offY });
    panel.slotEl.style.left = `${cssRect.left}px`;
    panel.slotEl.style.top = `${cssRect.top}px`;
    panel.slotEl.style.width = `${cssRect.width}px`;
    panel.slotEl.style.height = `${cssRect.height}px`;

    const viewerHPx = content.imageRect.h * scaleY;
    if (panel.viewerHostEl) {
      panel.viewerHostEl.style.width = "100%";
      panel.viewerHostEl.style.height = `${viewerHPx}px`;
    }
    if (panel.viewerEl) {
      panel.viewerEl.style.width = "100%";
      panel.viewerEl.style.height = "100%";
    }

    if (this.showColorbar && panel.nv?.volumes?.length) {
      panel.captureRuntimeState?.();
    }

    updatePanelChrome(panel.svgChrome, content, panel.state, this._panelChromeOptions(panel));

    panel.nv?.resizeListener?.();
  }

  /** Redraw SVG colorbar (gradient + min/max labels) from live Niivue state. */
  refreshPanelChrome(panel) {
    if (!panel?.svgChrome) return;
    const content = panel.contentLayout ?? this.computePanelContentLayout(panel);
    if (!content) return;
    if (panel.nv?.volumes?.length) panel.captureRuntimeState?.();
    updatePanelChrome(panel.svgChrome, content, panel.state, this._panelChromeOptions(panel));
  }

  _syncHtmlPositions() {
    if (!this.stageEl || !this.panels.length || !this.svgRoot) return;
    const transform = getStageTransform(this.stageEl, this.svgRoot, this.figure);
    if (!transform) {
      requestAnimationFrame(() => this._syncHtmlPositions());
      return;
    }

    const contentLayouts = this.computeAllContentLayouts();
    for (const panel of this.panels) {
      panel._pendingContentLayout = contentLayouts[panel.index];
      this.syncPanelLayout(panel, transform.scaleX, transform.scaleY, transform.offX, transform.offY);
      panel._pendingContentLayout = null;
    }
  }

  _updateGridBtnActive() {
    const btns = this.overlay?.querySelectorAll(".paper-plot-grid-btn");
    btns?.forEach((b) => {
      b.classList.toggle("active", Number(b.dataset.cols) === this.cols && Number(b.dataset.rows) === this.rows);
    });
  }

  getPanelTooltip(panel) {
    if (!panel?.state?.expr) return "";
    return panel.state.tooltip || getPanelCaptionDetail(panel.state.expr);
  }

  updateCaption() {
    if (!this.captionEl) return;
    const parts = [];
    const panelEntries = this.panels.map((p) => ({
      expr: p.state?.expr ?? "",
      label: p.state?.label ?? "",
    }));

    for (let i = 0; i < this.panels.length; i++) {
      const p = this.panels[i];
      if (!p.state?.expr?.trim()) continue;
      const detail = getPanelCaptionDetail(p.state.expr, {
        scanLabelRefs: buildScanLabelRefs(panelEntries, i),
      });
      if (!detail) continue;
      if (detail.includes("\n")) {
        const lines = detail.split("\n");
        parts.push(`${p.state.label} ${lines[0]}\n${lines.slice(1).join("\n")}`);
      } else {
        parts.push(`${p.state.label} ${detail}`);
      }
    }
    this.captionEl.textContent = parts.length
      ? `Figure 1:\n${parts.join("\n\n")}`
      : "Figure 1:";
  }

  selectPanel(panel) {
    this.selectedPanel = panel;
    for (const p of this.panels) p.setSelected(p === panel);
    this.updateLayoutPreviewSelection();
  }

  refreshScanRail() {
    if (!this.railList) return;
    const items = [];
    const nv = window.nvModule?.nv;
    if (nv?.volumes?.length) {
      for (const v of nv.volumes) {
        const name = String(v?.name ?? "");
        if (!name.startsWith("scan_")) continue;
        const m = name.match(/^scan_(\d+)/i);
        const num = m ? parseInt(m[1], 10) : null;
        if (num == null) continue;
        items.push({ num, label: name.replace(/\.nii(\.gz)?$/i, ""), sourceUrl: v.sourceUrl, tooltip: getProtocolTooltipForScanNumber(num) });
      }
    }
    items.sort((a, b) => b.num - a.num);

    if (!items.length) {
      const queue = window.scanModule?.queue ?? [];
      for (const j of queue) {
        if (j.status !== "done") continue;
        items.push({
          num: j.scanNumber,
          label: `${j.scanNumber}. ${j.name || "scan"}`,
          sourceUrl: j.niftiUrl,
          tooltip: getProtocolTooltipForScanNumber(j.scanNumber),
        });
      }
      items.sort((a, b) => b.num - a.num);
    }

    if (!items.length) {
      this.railList.innerHTML = `<div class="paper-plot-rail-empty">No scans yet.<br/>Run a simulation first.</div>`;
      return;
    }

    this.railList.innerHTML = items
      .map((it) => {
        const tip = it.tooltip ? ` title="${this._escapeAttr(it.tooltip)}"` : "";
        return `<button type="button" class="paper-plot-rail-item has-protocol-tooltip"${tip} data-scan="${it.num}">${it.num}. ${this._shortName(it.label)}</button>`;
      })
      .join("");

    this.railList.querySelectorAll(".paper-plot-rail-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const num = btn.dataset.scan;
        if (this.selectedPanel) {
          this.selectedPanel.setExpr(num);
        }
      });
    });
  }

  _shortName(label) {
    const s = String(label);
    const m = s.match(/^(scan_\d+)_?(.*)$/i);
    if (m && m[2]) return m[2].replace(/_/g, " ").slice(0, 40);
    return s.replace(/^scan_(\d+)_?/i, "").replace(/_/g, " ").slice(0, 40) || s;
  }

  _escapeAttr(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/\n/g, "&#10;");
  }

  _captionExportText() {
    return this.captionEl?.textContent?.trim() || "Figure 1:";
  }

  syncControlsFromState() {
    const q = (id) => this.overlay?.querySelector(id);
    const colorbar = q("#paper-show-colorbar");
    this.ensureRowLinkArrays();
    const linkPosition = q("#paper-link-all-position");
    const linkClims = q("#paper-link-all-clims");
    if (colorbar) colorbar.checked = this.showColorbar;
    if (linkPosition) linkPosition.checked = !!this.state.options.linkPosition;
    if (linkClims) linkClims.checked = !!this.state.options.linkClims;
    if (this.scanColormapSelect) this.scanColormapSelect.value = this.scanColormap;
    if (this.diffColormapSelect) this.diffColormapSelect.value = this.diffColormap;
    this.sync.setLinkPosition(this.hasAnyRowLinkPosition());
    this.sync.setLinkClims(this.state.options.rowLinkClims.some(Boolean));
    this.layoutPreviewEl?.querySelectorAll(".paper-row-link-position").forEach((el) => {
      el.checked = this.isRowLinkPosition(Number(el.dataset.row));
    });
    this.layoutPreviewEl?.querySelectorAll(".paper-row-link-clims").forEach((el) => {
      el.checked = this.isRowLinkClims(Number(el.dataset.row));
    });
    this._updateGridBtnActive();
  }

  autosaveLayout() {
    try {
      localStorage.setItem("paperPlot:lastLayout", serializeFigureState(this.state));
    } catch (_) {}
  }

  downloadLayoutJson() {
    this.captureRuntimeState();
    const blob = new Blob([serializeFigureState(this.state)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "paper_plot_layout.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async loadLayoutJsonFile(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const state = deserializeFigureState(text);
      await this.applyFigureState(state);
    } catch (e) {
      alert(`Could not load Paper Plot layout.\n\n${e?.message || e}`);
    }
  }

  async applyFigureState(state) {
    const validation = validateFigureState(state);
    if (!validation.ok) throw new Error(validation.issues.join("\n"));
    const savedPanels = state.panels.map((p) => ({ expr: p.expr, frame4D: p.frame4D }));
    this.state = state;
    this.syncControlsFromState();
    this.setGrid(this.state.grid.cols, this.state.grid.rows, {
      preserveExisting: false,
      autoFill: false,
      loadExpressions: false,
    });
    for (const panel of this.panels) {
      const saved = savedPanels[panel.index] ?? {};
      const expr = saved.expr;
      if (expr) await panel.applyExpr(expr);
      if (Number.isFinite(saved.frame4D) && saved.frame4D > 0) {
        panel.setFrame4D(saved.frame4D);
      }
    }
    this.updateCaption();
    this.autosaveLayout();
  }

  captureRuntimeState() {
    for (const p of this.panels) p.captureRuntimeState?.();
    return this.state;
  }

  exportSvg() {
    this.captureRuntimeState();
    this._syncHtmlPositions();
    const ns = "http://www.w3.org/2000/svg";
    const captionText = this._captionExportText();
    const captionBlock = measureExportCaption(captionText);
    const totalH = this.figure.height + captionBlock.height;
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    svg.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
    svg.setAttribute("viewBox", `0 0 ${this.figure.width} ${totalH}`);
    svg.setAttribute("width", String(this.figure.width));
    svg.setAttribute("height", String(totalH));
    svg.style.background = "#ffffff";

    appendRect(svg, { x: 0, y: 0, w: this.figure.width, h: this.figure.height }, { fill: "#000000" });
    appendRect(
      svg,
      { x: 0, y: this.figure.height, w: this.figure.width, h: captionBlock.height },
      { fill: "#ffffff" }
    );

    for (const panel of this.panels) {
      const L = panel.layout;
      if (!L) continue;
      const content = panel.contentLayout ?? this.computeAllContentLayouts()[panel.index] ?? this.computePanelContentLayout(panel);
      const chrome = content ?? L;

      const g = document.createElementNS(ns, "g");
      appendPanelExportChrome(g, chrome, panel.state, this.state.options);

      if (panel.nv?.volumes?.length) {
        const ir = content?.imageRect ?? L.imageRect;
        if (ir) {
          const imgUrl = capturePanelAtNativeResolution(panel);
          if (imgUrl) {
            appendImage(g, ir, imgUrl);
          }
        }
      }

      if (this.showColorbar && content?.colorbarRect) {
        appendVerticalColorbar(g, content.colorbarRect, panel.state, { theme: "export" });
      }

      if (content?.imageRect) {
        appendPanelLabel(g, content.imageRect, panel.state, { theme: "export" });
      }

      svg.appendChild(g);
    }

    appendCaption(svg, captionText, this.figure.height, { theme: "print" });

    this._syncHtmlPositions();

    const xml = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "paper_figure.svg";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

// ── Dev checks (console: runPaperPlotDebugChecks()) ─────────────────────────

function _debugAssert(name, condition, details = "") {
  if (!condition) throw new Error(`${name}${details ? `: ${details}` : ""}`);
}

export function runPaperPlotDebugChecks() {
  const checks = [];
  const record = (name, fn) => {
    try {
      fn();
      checks.push({ name, ok: true });
    } catch (e) {
      checks.push({ name, ok: false, error: e.message || String(e) });
    }
  };

  record("expression parsing", () => {
    _debugAssert("plain scan", parsePanelExpr("4")?.scanNum === 4);
    _debugAssert("phase scan", parsePanelExpr("4.phase")?.phase === true);
    _debugAssert("diff", parsePanelExpr("4-2")?.type === "diff");
    _debugAssert("abs diff", parsePanelExpr("|4-2|")?.abs === true);
    _debugAssert("invalid", parsePanelExpr("abc") === null);
  });

  record("layout geometry", () => {
    const state = createDefaultFigureState(2, 2);
    const cells = computeGridLayout(state);
    _debugAssert("cell count", cells.length === 4);
    const content = computePanelContentLayout(cells[0], { expr: "1", volumeAspect: 1 }, state.options);
    _debugAssert("content exists", !!content);
    _debugAssert("image square-ish", Math.abs(content.imageRect.w - content.imageRect.h) < 1e-6);
  });

  record("diff caption cross-refs", () => {
    const panels = [
      { expr: "1", label: "a)" },
      { expr: "2", label: "b)" },
      { expr: "1-2", label: "c)" },
    ];
    const refs = buildScanLabelRefs(panels, 2);
    const detail = getPanelCaptionDetail("1-2", { scanLabelRefs: refs });
    _debugAssert("uses panel labels", detail.includes("Sequence: a)") && detail.includes("Reference: b)"));
    _debugAssert("indented lines", detail.includes("   Sequence:") && detail.includes("   Reference:"));
  });

  record("diff caption fallback", () => {
    const detail = getPanelCaptionDetail("3-4", { scanLabelRefs: new Map() });
    _debugAssert("full protocol fallback", detail.includes("   Sequence:") && detail.includes("   Reference:"));
    _debugAssert("no cross-ref", !detail.includes("Sequence: a)"));
  });

  record("state roundtrip", () => {
    const state = createDefaultFigureState(2, 2);
    state.panels[0].expr = "1";
    const parsed = deserializeFigureState(serializeFigureState(state));
    const validation = validateFigureState(parsed);
    _debugAssert("valid state", validation.ok, validation.issues.join("; "));
    _debugAssert("expr preserved", parsed.panels[0].expr === "1");
    _debugAssert("panel count", parsed.panels.length === 4);
  });

  return {
    ok: checks.every((c) => c.ok),
    checks,
  };
}

if (typeof window !== "undefined") {
  window.runPaperPlotDebugChecks = runPaperPlotDebugChecks;
}
