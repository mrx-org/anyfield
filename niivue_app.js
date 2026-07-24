import { Niivue, NVMesh, NVImage, SLICE_TYPE, MULTIPLANAR_TYPE, DRAG_MODE, SHOW_RENDER } from "https://unpkg.com/@niivue/niivue@0.65.0/dist/index.js";
import { eventHub } from "./event_hub.js";
import { formatScanDisplayTitle } from "./scan_zero/scan_module.js";
import { volumeIs4D, syncVolumeClimsToCurrent4DFrame, installFrameAwareContrastDrag, installFrameAwareBriConReset } from "./hist_panel/histogram-clim-panel.js";
import { DEFAULT_CACHE_PHANTOM_ID, BIFTI_CACHE_ADMIN_BASE, fetchCachedPhantomIds, downloadPhantomTarGz, normalizeCacheId, splitCacheId, phantomFolderId } from "./scan_zero/bifti_cache.js";

/**
 * Base URL for the bundled default nifti_phantom (JSON + NIfTIs).
 * In-repo bundle: `data/subj04-3T-1mm-tra/` (BrainWeb subj04, true 1 mm iso).
 * Override via `NiivueModule({ defaultPhantomBaseUrl })` or `window.NV_DEFAULT_PHANTOM_BASE`.
 */
export const DEFAULT_PHANTOM_REMOTE_BASE = "data/subj04-3T-1mm-tra/";

/** Must match `RESAMPLING_PY_VERSION` in data/resampling.py (cache-bust + reload). */
export const RESAMPLING_PY_VERSION = 4;

/** nifti_phantom_v1 property keys → sidebar label (density first in list order). */
const PHANTOM_NIFTI_PROP_CATALOG = [
  { keys: ["density"], label: "density" },
  { keys: ["dB0"], label: "dB0" },
  { keys: ["B1+"], label: "B1+" },
  { keys: ["B1-"], label: "B1-" },
  { keys: ["T1"], label: "T1" },
  { keys: ["T2"], label: "T2" },
  { keys: ["T2'"], label: "T2'" },
  { keys: ["ADC"], label: "ADC" },
];

function phantomExtractNiftiFileRef(val) {
  if (val == null || typeof val === "number") return null;
  if (typeof val === "string") {
    const m = val.match(/^(.+?)\[\d+\]$/);
    if (m) return m[1];
    if (/\.nii(\.gz)?$/i.test(val)) return val;
    return null;
  }
  if (typeof val === "object" && val.file) return phantomExtractNiftiFileRef(val.file);
  return null;
}

function phantomNiftiRefsFromProp(val) {
  if (val == null || typeof val === "number") return [];
  if (Array.isArray(val)) {
    const out = [];
    for (const item of val) {
      const ref = phantomExtractNiftiFileRef(item);
      if (ref) out.push(ref);
    }
    return out;
  }
  const ref = phantomExtractNiftiFileRef(val);
  return ref ? [ref] : [];
}

/**
 * From a nifti_phantom_v1 JSON, map each referenced NIfTI file to a property label
 * (density, dB0, B1+, …) and return load order (density first).
 * @returns {{ fileToLabel: Map<string, string>, order: string[] } | null}
 */
function phantomNiftiCatalogFromJson(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed?.tissues || typeof parsed.tissues !== "object") return null;

  const fileToLabel = new Map();
  const order = [];

  for (const { keys, label } of PHANTOM_NIFTI_PROP_CATALOG) {
    for (const tissue of Object.values(parsed.tissues)) {
      if (!tissue || typeof tissue !== "object") continue;
      for (const key of keys) {
        const refs = phantomNiftiRefsFromProp(tissue[key]);
        for (const fn of refs) {
          if (!fileToLabel.has(fn)) {
            fileToLabel.set(fn, label);
            order.push(fn);
          }
        }
      }
    }
  }

  return order.length ? { fileToLabel, order } : null;
}

export class NiivueModule {
  constructor(options = {}) {
    this.instanceId = Math.random().toString(36).substr(2, 5);
    this.canvasId = `gl-${Math.random().toString(36).substr(2, 9)}`;
    this.options = { ...options };
    this.nv = new Niivue({ 
      logging: false,
      loadingText: "Loading...",
      multiplanarLayout: 2, // MULTIPLANAR_TYPE.GRID
      fontMinPx: 11,
      fontSizeScaling: 0.4,
    });
    this.pyodide = options.pyodide || null;
    this._initPyodidePromise = null;
    
    // State properties
    this.fovMeshData = null;
    this.voxelSpacingMm = null;
    this.fullFovMm = null;
    this.fovMesh = null;
    this.currentAxCorSag = null;
    /** Pane (0=axial, 1=coronal, 2=sagittal) for active FOV rotate gesture; not overwritten by onLocationChange. */
    this.fovRotateAxCorSag = null;
    this.lastAzEl = null;
    this.savedDragMode = DRAG_MODE.contrast;
    this.isDraggingFov = false;
    this.isRotatingFov = false;
    this.isZooming2D = false;
    this.zoomStartMouseY = 0;
    this.zoomStartValue = 0;
    this.dragStartRotation = 0;
    this.dragStartAngle = 0;
    this.dragStartTileIndex = -1;
    this.dragStartMm = null;
    this.dragStartPx = null;
    this.dragStartOffsets = null;
    this.lastLocationVox = null;
    this.lastLocationMm = null;
    this.fovUpdatePending = false;
    this.isTwoFingerRotating = false;
    this.touchRotateStartAngle = 0;
    this.touchPendingFovDrag = false;
    this.touchStartX = 0;
    this.touchStartY = 0;
    this.twoFingerReleaseTime = 0;
    this.TWO_FINGER_COOLDOWN_MS = 300;

    // Elements (will be set in render methods)
    this.containerViewer = null;
    this.containerControls = null;
    this.canvas = null;
    this.crosshairIntensityEl = null;
    this.dirInput = null;
    this.btnDemo = null;
    this.showFov = null;
    this.sliceMM = null;
    this.radiological = null;
    this.showRender = null;
    this.showCrosshair = null;
    /** When checked (default), SIM scans run PyNUFFT recon; unchecked writes log|k|-space. */
    this.scanRecon = null;
    this.zoom2D = null;
    this.zoom2DVal = null;
    this.fovControls = null;
    this.fovX = null;
    this.fovY = null;
    this.fovZ = null;
    this.fovXVal = null;
    this.fovYVal = null;
    this.fovZVal = null;
    this.fovOffX = null;
    this.fovOffY = null;
    this.fovOffZ = null;
    this.fovOffXVal = null;
    this.fovOffYVal = null;
    this.fovOffZVal = null;
    this.fovRotX = null;
    this.fovRotY = null;
    this.fovRotZ = null;
    this.fovRotXVal = null;
    this.fovRotYVal = null;
    this.fovRotZVal = null;
    this.maskX = null;
    this.maskY = null;
    this.maskZ = null;
    this.maskXVal = null;
    this.maskYVal = null;
    this.maskZVal = null;
    this.phantomX = null;
    this.phantomY = null;
    this.phantomZ = null;
    this.phantomXVal = null;
    this.phantomYVal = null;
    this.phantomZVal = null;
    this.phantomOversampleInput = null;
    this.downloadFovMeshBtn = null;
    this.azVal = null;
    this.elVal = null;
    this.voxVal = null;
    this.mmVal = null;
    this.locStrVal = null;
    this.scanVolumeListContainer = null;
    this.phantomVolumeListContainer = null;
    this.btnAddFolder = null;
    this.resampleToFovBtn = null;
    /** @type {Promise<void> | null} */
    this._nibabelReadyPromise = null;
    this._nibabelLoadDone = false;
    this._pyodideQueue = [];
    this._pyodideDraining = false;
    this._pyodideDrainDepth = 0;
    this._resampleBusyCount = 0;

    /** Absolute `https://` (remote) or path relative to the page. Default: GitHub raw `DEFAULT_PHANTOM_REMOTE_BASE`. */
    this.defaultPhantomBaseUrl =
      options.defaultPhantomBaseUrl ??
      (typeof window !== "undefined" && window.NV_DEFAULT_PHANTOM_BASE
        ? String(window.NV_DEFAULT_PHANTOM_BASE)
        : DEFAULT_PHANTOM_REMOTE_BASE);
    this.FOV_RGBA255 = new Uint8Array([255, 220, 0, 255]);
    this.isInitialized = false;
    this.volumeGroups = [];
    this.jsonEditorCm = null;
    this.jsonTabCurrentName = null;
    /** Set when default phantom fetch finishes before shared Pyodide is attached (bootstrap sync). */
    this._pendingPhantomVfs = null;
    /** Phantom group ids explicitly expanded in the volume list (default: collapsed). */
    this.expandedGroups = new Set();
    this._initWaiters = [];
    this.selectedVolume = null; // Track which volume is selected for preview (pane B)
    this.compareVolume = null; // Volume shown in lazy compare pane C
  }

  waitForInit() {
    if (this.isInitialized) return Promise.resolve();
    return new Promise(resolve => this._initWaiters.push(resolve));
  }

  /**
   * Apply FOV dimensions coming from the sequence explorer (seq → Niivue, dimensions only).
   * Expects values in millimeters and only updates size X/Y/Z, leaving offsets and rotations untouched.
   */
  applySequenceFovDimensions(data) {
    if (!data || !this.fovX || !this.fovY || !this.fovZ || !this.fovXVal || !this.fovYVal || !this.fovZVal) return;
    const { fov_x_mm, fov_y_mm, fov_z_mm } = data;
    const setVal = (slider, numInput, mmVal) => {
      if (mmVal === undefined || mmVal === null || Number.isNaN(Number(mmVal))) return;
      const v = String(Math.round(Number(mmVal)));
      slider.value = v;
      numInput.value = v;
    };
    setVal(this.fovX, this.fovXVal, fov_x_mm);
    setVal(this.fovY, this.fovYVal, fov_y_mm);
    setVal(this.fovZ, this.fovZVal, fov_z_mm);
    this.rebuildFovLive(true);
  }

  async confirmPhantomReset() {
    if (!this.nv.volumes?.length) return true;
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:10000;';
      const box = document.createElement('div');
      box.style.cssText = 'background:#1e1e2e;color:#ccc;padding:20px 28px;border-radius:8px;max-width:360px;text-align:center;font-family:sans-serif;';
      box.innerHTML = `<p style="margin:0 0 16px;font-size:14px;">Loading a new phantom removes <b>all</b> volumes, scans, and masks from the viewer.</p>
        <div style="display:flex;gap:10px;justify-content:center;">
          <button id="_prc" style="padding:6px 18px;border:none;border-radius:4px;background:#e06c75;color:#fff;cursor:pointer;">Proceed</button>
          <button id="_pcc" style="padding:6px 18px;border:none;border-radius:4px;background:#555;color:#ccc;cursor:pointer;">Cancel</button>
        </div>`;
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      box.querySelector('#_prc').onclick = () => { document.body.removeChild(overlay); resolve(true); };
      box.querySelector('#_pcc').onclick = () => { document.body.removeChild(overlay); resolve(false); };
      overlay.addEventListener('click', (e) => { if (e.target === overlay) { document.body.removeChild(overlay); resolve(false); } });
    });
  }

  resetViewer() {
    if (this.fovMesh) { this.nv.removeMesh(this.fovMesh); this.fovMesh = null; }
    this.fovMeshData = null;
    if (this.showFov) this.showFov.checked = false;
    while (this.nv.volumes.length) this.nv.removeVolume(this.nv.volumes[0]);
    this.volumeGroups = [];
    this.selectedVolume = null;
    this.compareVolume = null;
    this.lastLocationMm = null;
    this.lastLocationVox = null;
    this.voxelSpacingMm = null;
    this.fullFovMm = null;
    this.updateVolumeList();
    this.nv.drawScene();
  }

  refreshFovForNewVolume() {
    const info = this.getVolumeInfo();
    if (!info?.dim3) return;
    this.voxelSpacingMm = this.estimateVoxelSpacingMm(info);
    const [dx, dy, dz] = info.dim3;
    this.fullFovMm = [dx * this.voxelSpacingMm[0], dy * this.voxelSpacingMm[1], dz * this.voxelSpacingMm[2]];
    const sr = (s, n, mm, def) => { s.min = n.min = "1"; s.max = n.max = "600"; s.step = n.step = "1"; s.value = n.value = def ? String(def) : String(Math.round(mm)); };
    sr(this.fovX, this.fovXVal, this.fullFovMm[0], 220); sr(this.fovY, this.fovYVal, this.fullFovMm[1], 220); sr(this.fovZ, this.fovZVal, this.fullFovMm[2], 10);
    const so = (s, n) => { s.min = n.min = "-500"; s.max = n.max = "500"; s.step = n.step = "0.1"; s.value = n.value = "0"; };
    so(this.fovOffX, this.fovOffXVal); so(this.fovOffY, this.fovOffYVal); so(this.fovOffZ, this.fovOffZVal);
    this.syncFovLabels();
    if (this.showFov) this.showFov.checked = true;
    this.requestFovUpdate();
    this.updateDebugInfo();
  }

  renderViewer(target) {
    this.containerViewer = typeof target === 'string' ? document.getElementById(target) : target;
    if (!this.containerViewer) throw new Error(`Viewer target not found: ${target}`);

    this.containerViewer.classList.add('niivue-app', 'viewer-column-stack');
    this.containerViewer.innerHTML = `
      <div class="viewer-stack-body" style="flex:1;min-height:0;display:flex;flex-direction:column;">
      <div class="viewer standalone-viewer" style="flex:1;min-height:0;position:relative;">
        <canvas id="${this.canvasId}"></canvas>
        <div class="crosshair-intensity viewer-canvas-overlay viewer-canvas-overlay--tl" id="crosshairIntensity-${this.instanceId}">—</div>
        <div class="viewer-hint viewer-canvas-overlay viewer-canvas-overlay--tr">CTRL + mouse to change FoV</div>
      </div>
      </div>
    `;

    this.canvas = this.containerViewer.querySelector(`#${this.canvasId}`);
    this.crosshairIntensityEl = this.containerViewer.querySelector(`#crosshairIntensity-${this.instanceId}`);
    
    // Attach Niivue after small delay to ensure canvas is ready
    setTimeout(() => this.initNiivue(), 10);
  }

  renderControls(target, useTabs = false) {
    this.containerControls = typeof target === 'string' ? document.getElementById(target) : target;
    if (!this.containerControls) throw new Error(`Controls target not found: ${target}`);

    this.containerControls.classList.add('niivue-app');
    
    if (!useTabs) {
      this.containerControls.innerHTML = `
        <div class="options-grid standalone-controls">
          ${this._getPanelScansHtml()}${this._getPanelPhantomsHtml()}
          ${this._getPanelViewHtml()}
          <div class="panel-flat">
            ${this._getPanelFovHtml(true)}
            <div style="margin-top: 12px; border-top: 1px solid var(--border); padding-top: 12px;">
                ${this._getPanelExportHtml(true)}
            </div>
          </div>
        </div>
      `;
    } else {
      this.containerControls.innerHTML = `
        <div class="tabbed-controls">
          <div class="tabs-header">
            <button class="tab-btn active" data-tab="scans">SCANS</button>
            <button class="tab-btn" data-tab="phantoms">PHANTOMS</button>
            <button class="tab-btn" data-tab="fov">FOV</button>
            <button class="tab-btn" data-tab="view">OPTIONS</button>
          </div>
          <div class="tabs-content">
            <div class="tab-pane active" id="tab-scans-${this.instanceId}">${this._getPanelScansHtml()}</div>
            <div class="tab-pane" id="tab-phantoms-${this.instanceId}">${this._getPanelPhantomsHtml()}</div>
            <div class="tab-pane" id="tab-fov-${this.instanceId}">
                <div class="panel-flat">
                    ${this._getPanelFovHtml(true)}
                    <div style="margin-top: 12px; border-top: 1px solid var(--border); padding-top: 12px;">
                        ${this._getPanelExportHtml(true)}
                    </div>
                </div>
            </div>
            <div class="tab-pane" id="tab-view-${this.instanceId}">${this._getPanelViewHtml()}</div>
          </div>
        </div>
      `;
      
      const buttons = this.containerControls.querySelectorAll('.tab-btn');
      const panes = this.containerControls.querySelectorAll('.tab-pane');
      const tabsContent = this.containerControls.querySelector('.tabs-content');
      const scansBtn = this.containerControls.querySelector('.tab-btn[data-tab="scans"]');
      if (scansBtn) {
        if (!scansBtn.dataset.fullLabel) scansBtn.dataset.fullLabel = scansBtn.textContent || 'SCANS';
        if (!scansBtn.dataset.collapsedLabel) scansBtn.dataset.collapsedLabel = 'S';
      }
      buttons.forEach(btn => {
        btn.onclick = () => {
          if (window.viewManager && window.viewManager.currentMode !== 'planning') {
            window.viewManager.setMode('planning');
          }
          const slotSidebar = this.containerControls.closest('#slot-sidebar');
          const labGrid = this.containerControls.closest('.lab-grid');
          const wasActive = btn.classList.contains('active');
          const isScans = btn.dataset.tab === 'scans';
          if (wasActive && isScans) {
            const willCollapse = !(slotSidebar && slotSidebar.classList.contains('sidebar-collapsed'));
            if (tabsContent) tabsContent.classList.toggle('panel-collapsed');
            if (slotSidebar) slotSidebar.classList.toggle('sidebar-collapsed');
            if (labGrid) labGrid.classList.toggle('sidebar-collapsed');
            if (scansBtn) {
              scansBtn.textContent = willCollapse
                ? (scansBtn.dataset.collapsedLabel || 'S')
                : (scansBtn.dataset.fullLabel || 'SCANS');
            }
            return;
          }
          if (tabsContent) tabsContent.classList.remove('panel-collapsed');
          if (slotSidebar) slotSidebar.classList.remove('sidebar-collapsed');
          if (labGrid) labGrid.classList.remove('sidebar-collapsed');
          if (scansBtn) {
            scansBtn.textContent = scansBtn.dataset.fullLabel || 'SCANS';
          }
          buttons.forEach(b => b.classList.remove('active'));
          panes.forEach(p => p.classList.remove('active'));
          btn.classList.add('active');
          const tab = btn.dataset.tab;
          this.containerControls.querySelector(`#tab-${tab}-${this.instanceId}`).classList.add('active');
          if (tab === 'phantoms' && this.jsonEditorCm) this.jsonEditorCm.refresh();
        };
      });
    }

    this.bindControlElements();
    this.setupEventListeners();
    if ((this.containerControls || document).querySelector(`#json-editor-${this.instanceId}`)) this.initJsonEditor();
    // Do not auto-initialize Pyodide here; let the bootstrap process handle it
    // or call it manually if needed.
  }

  _getPanelScansHtml() {
    return `
        <div id="panel-scans-${this.instanceId}" class="panel-flat" style="display: flex; flex-direction: column; height: 100%; box-sizing: border-box; overflow: hidden;">
          <div id="scan-volume-list-${this.instanceId}" style="display: flex; flex-direction: column; gap: 4px; flex: 1; overflow-y: auto;"></div>
        </div>
    `;
  }

  _getPanelPhantomsHtml() {
    return `
        <div id="panel-phantoms-${this.instanceId}" class="panel-flat" style="display: flex; flex-direction: column; height: 100%; box-sizing: border-box; overflow: hidden;">
          <div class="row" style="display: flex; flex-direction: column; gap: 4px; flex-shrink: 0;">
            <div style="display: flex; gap: 4px; flex-wrap: wrap;">
              <button id="btn-add-folder-${this.instanceId}" class="btn btn-secondary btn-sm btn-flex" title="Browse phantoms on the Modal cache">Add BIfTI</button>
              <button id="load-demo-${this.instanceId}" class="btn btn-secondary btn-sm btn-flex" title="Reload default cache phantom (brainweb-20-v2/subj04-3T-1mm-tra)">Default phantom</button>
            </div>
          </div>
          <div id="phantom-volume-list-${this.instanceId}" style="margin-top: 6px; display: flex; flex-direction: column; gap: 4px; flex: 0 0 auto; max-height: 90px; overflow-y: auto; border-top: 1px solid var(--border); padding-top: 4px;"></div>
          <div class="json-tab-panel" style="display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; margin-top: 8px; border-top: 1px solid var(--border); padding-top: 8px;">
            <select id="json-config-select-${this.instanceId}" class="json-config-select" style="margin-bottom: 6px; flex-shrink: 0;"></select>
            <div class="row json-tab-actions" style="flex-shrink: 0; gap: 6px; margin-bottom: 6px; display: flex; flex-wrap: wrap; align-items: center; width: 100%;">
              <button type="button" id="json-save-${this.instanceId}" class="btn btn-secondary btn-sm" title="Save (update in VFS)">Save</button>
              <button type="button" id="json-save-as-${this.instanceId}" class="btn btn-secondary btn-sm" title="Save as new config in VFS">Save As</button>
              <button type="button" id="json-revert-${this.instanceId}" class="btn btn-secondary btn-sm" title="Reload current file (discard unsaved edits)">Revert</button>
              <span id="json-tab-status-${this.instanceId}" class="json-tab-status" style="flex: 1; min-width: 0;"></span>
              ${typeof window !== 'undefined' && window.pro ? `<button type="button" id="json-execute-${this.instanceId}" class="btn btn-primary btn-sm" title="Execute JSON phantom config" style="margin-left: auto;">Execute</button>` : ''}
            </div>
            <div id="json-editor-wrap-${this.instanceId}" class="json-editor-wrap" style="flex: 1; min-height: 120px; display: flex; flex-direction: column; overflow: hidden;">
              <textarea id="json-editor-${this.instanceId}" class="json-editor" placeholder="Add a folder with JSON + NIfTIs to see configs." style="flex: 1; min-height: 0; font-size: 11px;"></textarea>
            </div>
          </div>
        </div>
    `;
  }

  _getPanelViewHtml() {
    const showFovChecked = this.options.showFovDefault !== false;
    return `
        <div class="panel-flat">
          <h3 class="panel-title">OPTIONS</h3>
          <div class="row" style="grid-template-columns: 1fr 1fr; gap: 4px;">
            <label class="toggle"><input id="showFov-${this.instanceId}" type="checkbox" ${showFovChecked ? 'checked' : ''} /> FOV Box</label>
            <label class="toggle"><input id="sliceMM-${this.instanceId}" type="checkbox" /> Slice MM</label>
            <label class="toggle"><input id="radiological-${this.instanceId}" type="checkbox" /> Radio.</label>
            <label class="toggle"><input id="showRender-${this.instanceId}" type="checkbox" checked /> 3D Render</label>
            <label class="toggle"><input id="showCrosshair-${this.instanceId}" type="checkbox" checked /> Crosshair</label>
            <label class="toggle"><input id="compactMode-${this.instanceId}" type="checkbox" /> Compact</label>
          </div>
          <div class="row" style="grid-template-columns: 1fr; gap: 4px; margin-top: 4px;">
            <label class="toggle"><input id="scanRecon-${this.instanceId}" type="checkbox" checked /> recon</label>
          </div>
          <div class="sliderGroup" style="margin-top: 8px;">
            <div class="sliderRow">
              <div>Zoom 2D</div>
              <div class="input-sync">
                <input id="zoom2DVal-${this.instanceId}" type="number" class="num-input" step="0.05" />
                <input id="zoom2D-${this.instanceId}" type="range" min="0.2" max="2.0" step="0.05" value="0.9" />
              </div>
            </div>
          </div>
          <div class="hint">
            Ctrl+Left: Move FOV<br>
            Ctrl+Right: Rotate FOV<br>
            Ctrl+Scroll: Resize FOV<br>
            Ctrl+Middle: Zoom<br>
            Left/Right: 4D frame (when volume has 4D)
          </div>
          ${typeof window !== 'undefined' && window.pro ? `<div id="debugInfo-${this.instanceId}" class="hint" style="font-family:monospace;font-size:10px;white-space:pre;line-height:1.4;margin-top:4px;color:#aaa;"></div>` : ''}
        </div>
    `;
  }

  initJsonEditor() {
    const root = this.containerControls || document;
    const textarea = root.querySelector(`#json-editor-${this.instanceId}`);
    const wrap = root.querySelector(`#json-editor-wrap-${this.instanceId}`);
    const saveBtn = root.querySelector(`#json-save-${this.instanceId}`);
    const saveAsBtn = root.querySelector(`#json-save-as-${this.instanceId}`);
    const revertBtn = root.querySelector(`#json-revert-${this.instanceId}`);
    if (!textarea || !wrap) return;
    if (window.CodeMirror) {
      this.jsonEditorCm = window.CodeMirror.fromTextArea(textarea, {
        mode: 'application/json',
        theme: 'monokai',
        lineNumbers: false,
        lineWrapping: true,
        readOnly: false,
        indentUnit: 2,
      });
      this.jsonEditorCm.setSize('100%', '100%');
      wrap.querySelector('.CodeMirror')?.style?.setProperty('min-height', '120px');
    }
    const execBtn = root.querySelector(`#json-execute-${this.instanceId}`);
    if (execBtn) execBtn.addEventListener('click', () => this.handleJsonExecute());
    if (saveBtn) saveBtn.addEventListener('click', () => this.handleJsonSave());
    if (saveAsBtn) saveAsBtn.addEventListener('click', () => this.handleJsonSaveAs());
    if (revertBtn) revertBtn.addEventListener('click', () => this.handleJsonRevert());
  }

  getJsonEditorValue() {
    if (this.jsonEditorCm) return this.jsonEditorCm.getValue();
    const root = this.containerControls || document;
    const el = root.querySelector(`#json-editor-${this.instanceId}`);
    return el ? el.value : '';
  }

  setJsonEditorValue(value) {
    const str = value != null ? String(value) : '';
    if (this.jsonEditorCm) {
      this.jsonEditorCm.setValue(str);
      this.jsonEditorCm.clearHistory();
    } else {
      const root = this.containerControls || document;
      const el = root.querySelector(`#json-editor-${this.instanceId}`);
      if (el) el.value = str;
    }
  }

  setJsonTabStatus(msg) {
    const root = this.containerControls || document;
    const el = root.querySelector(`#json-tab-status-${this.instanceId}`);
    if (el) el.textContent = msg || '';
  }

  /** Basename of the JSON config for a volume group (matches JSON tab / VFS keys). */
  _groupJsonFileName(group) {
    if (!group) return null;
    if (group.jsonFileName) return group.jsonFileName;
    const jn = group.jsonName;
    if (!jn || String(jn).endsWith('_resampled') || String(jn).endsWith('_averaged')) return null;
    return `${jn}.json`;
  }

  _volumeGroupMatchesJsonFile(group, jsonFileName) {
    if (!group || !jsonFileName) return false;
    const want = String(jsonFileName).toLowerCase();
    if (group.jsonFileName && String(group.jsonFileName).toLowerCase() === want) return true;
    const derived = group.jsonName ? `${group.jsonName}.json`.toLowerCase() : '';
    return derived === want;
  }

  _isDerivativePhantomGroup(group) {
    const jn = String(group?.jsonName || '');
    return jn.endsWith('_resampled') || jn.endsWith('_averaged') || jn.endsWith('_executed');
  }

  _niftiNamesForPhantomGroup(group) {
    const names = new Set();
    for (const v of group?.volumes || []) {
      const n = v?.name;
      if (n && /\.nii(\.gz)?$/i.test(n)) names.add(String(n).replace(/^\/+/, ""));
    }
    const raw = group?.jsonContent;
    if (raw) {
      const re = /[\w+.-]+\.nii(?:\.gz)?/gi;
      let m;
      while ((m = re.exec(String(raw)))) names.add(m[0]);
    }
    return names;
  }

  _removePhantomGroup(group) {
    if (!group) return;
    const jsonFn = this._groupJsonFileName(group);
    const ids = new Set([group.id]);
    if (jsonFn && !this._isDerivativePhantomGroup(group)) {
      for (const g of this.volumeGroups) {
        if (g.id !== group.id && this._volumeGroupMatchesJsonFile(g, jsonFn) && this._isDerivativePhantomGroup(g)) {
          ids.add(g.id);
        }
      }
    }
    const niftiNames = new Set();
    for (const g of this.volumeGroups) {
      if (!ids.has(g.id)) continue;
      for (const n of this._niftiNamesForPhantomGroup(g)) niftiNames.add(n);
    }
    for (const g of this.volumeGroups) {
      if (!ids.has(g.id)) continue;
      g.volumes.forEach((v) => this.nv.removeVolume(v));
    }
    this.volumeGroups = this.volumeGroups.filter((g) => !ids.has(g.id));
    const stillNeeded = new Set();
    for (const g of this.volumeGroups) {
      for (const v of g.volumes || []) {
        const n = v?.name;
        if (n && /\.nii(\.gz)?$/i.test(n)) stillNeeded.add(String(n).replace(/^\/+/, ""));
      }
    }
    const jsonStillUsed = jsonFn && this.volumeGroups.some((g) => this._volumeGroupMatchesJsonFile(g, jsonFn));
    if (this.pyodide) {
      for (const name of niftiNames) {
        if (stillNeeded.has(name)) continue;
        for (const p of [`/phantom/${name}`, `/phantom/averaged/${name}`]) {
          try { this.pyodide.FS.unlink(p); } catch (_) {}
        }
      }
      if (jsonFn && !jsonStillUsed) {
        try { this.pyodide.FS.unlink(`/phantom/${jsonFn}`); } catch (_) {}
      }
    }
    if (jsonFn && !jsonStillUsed && this.jsonTabCurrentName === jsonFn) {
      this.jsonTabCurrentName = null;
    }
  }

  /** First loaded phantom group used by resample / SIM (not executed / resampled derivatives). */
  getActivePhantomGroup() {
    return this.volumeGroups?.find(
      (g) => g.volumes?.length
        && !String(g.jsonName || '').endsWith('_resampled')
        && !String(g.jsonName || '').endsWith('_averaged'),
    ) ?? null;
  }

  /**
   * Latest JSON for SIM / execute: same file as the active phantom group, preferring
   * editor (when that file is selected) then VFS (after Save) then in-memory cache.
   */
  getPhantomJsonContent(group) {
    const g = group ?? this.getActivePhantomGroup();
    if (!g) return null;
    const fn = this._groupJsonFileName(g);
    if (!fn) return g.jsonContent != null ? String(g.jsonContent) : null;

    if (this.jsonTabCurrentName === fn) {
      const fromEditor = this.getJsonEditorValue();
      if (String(fromEditor).trim()) return fromEditor;
    }

    if (this.pyodide) {
      try {
        const vfs = this.pyodide.FS.readFile(`/phantom/${fn}`, { encoding: 'utf8' });
        if (String(vfs).trim()) return vfs;
      } catch (_) { /* no VFS copy yet */ }
    }

    return g.jsonContent != null ? String(g.jsonContent) : null;
  }

  /** Return JSON text by filename, preferring editor (if selected) then VFS then in-memory groups. */
  getJsonContentByFileName(jsonFileName) {
    const fn = jsonFileName != null ? String(jsonFileName).trim() : "";
    if (!fn) return null;

    if (this.jsonTabCurrentName === fn) {
      const fromEditor = this.getJsonEditorValue();
      if (String(fromEditor).trim()) return fromEditor;
    }

    if (this.pyodide) {
      try {
        const vfs = this.pyodide.FS.readFile(`/phantom/${fn}`, { encoding: 'utf8' });
        if (String(vfs).trim()) return vfs;
      } catch (_) { /* no VFS copy */ }
    }

    const g = this.volumeGroups?.find((vg) => this._volumeGroupMatchesJsonFile(vg, fn) && vg.jsonContent != null);
    if (g) return String(g.jsonContent);
    return null;
  }

  /**
   * JSON config chosen for SIM: active JSON-tab selection if available, otherwise the
   * active phantom group's own JSON.
   */
  getSelectedJsonForSim(group) {
    const g = group ?? this.getActivePhantomGroup();
    if (!g) return { fileName: null, content: null };

    const activeName = this.jsonTabCurrentName ? String(this.jsonTabCurrentName).trim() : "";
    if (activeName) {
      const activeContent = this.getJsonContentByFileName(activeName);
      if (String(activeContent || "").trim()) {
        return { fileName: activeName, content: String(activeContent) };
      }
    }

    const fallbackName = this._groupJsonFileName(g);
    return {
      fileName: fallbackName,
      content: this.getPhantomJsonContent(g),
    };
  }

  /** Keep scan/sim pipeline (uses volumeGroups[].jsonContent) aligned with VFS / editor. */
  _syncJsonContentToVolumeGroups(jsonFileName, raw) {
    if (!jsonFileName || raw == null) return;
    const s = String(raw);
    for (const g of this.volumeGroups) {
      if (this._volumeGroupMatchesJsonFile(g, jsonFileName)) g.jsonContent = s;
    }
  }

  handleJsonSave() {
    const raw = this.getJsonEditorValue();
    if (!raw.trim()) {
      this.setJsonTabStatus('Editor is empty.');
      return;
    }
    try {
      JSON.parse(raw);
    } catch (e) {
      this.setJsonTabStatus('Could not be saved, fix JSON.');
      return;
    }
    const name = this.jsonTabCurrentName;
    if (!name) {
      this.setJsonTabStatus('No config selected. Click a filename in the list first.');
      return;
    }
    if (!this.pyodide) {
      this.setJsonTabStatus('Pyodide not ready.');
      return;
    }
    try {
      this.pyodide.FS.writeFile(`/phantom/${name}`, raw);
      this._syncJsonContentToVolumeGroups(name, raw);
      this.setJsonTabStatus('Saved.');
    } catch (e) {
      this.setJsonTabStatus(`Save failed: ${e.message}`);
    }
  }

  handleJsonSaveAs() {
    const raw = this.getJsonEditorValue();
    if (!raw.trim()) {
      this.setJsonTabStatus('Editor is empty.');
      return;
    }
    try {
      JSON.parse(raw);
    } catch (e) {
      this.setJsonTabStatus('Could not be saved, fix JSON.');
      return;
    }
    if (!this.pyodide) {
      this.setJsonTabStatus('Pyodide not ready.');
      return;
    }
    const base = (this.jsonTabCurrentName || 'config').replace(/\.json$/i, '');
    const suggested = `${base}_copy.json`;
    this._showSaveAsPrompt(suggested, (fileName) => {
      if (!fileName) return;
      try {
        this.pyodide.FS.writeFile(`/phantom/${fileName}`, raw);
        this._syncJsonContentToVolumeGroups(fileName, raw);
        this.updateJsonTab();
        this.setJsonTabStatus(`Saved as ${fileName}.`);
      } catch (e) {
        this.setJsonTabStatus(`Save failed: ${e.message}`);
      }
    });
  }

  _showSaveAsPrompt(suggested, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'json-saveas-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:10000;';
    const box = document.createElement('div');
    box.className = 'json-saveas-dialog';
    box.style.cssText = 'background:var(--bg-panel);border:1px solid var(--border);border-radius:8px;padding:16px;min-width:280px;box-shadow:0 8px 32px rgba(0,0,0,0.4);';
    const label = document.createElement('label');
    label.style.cssText = 'display:block;font-size:12px;color:var(--muted);margin-bottom:6px;';
    label.textContent = 'Save as (filename in list):';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = suggested;
    input.style.cssText = 'width:100%;box-sizing:border-box;padding:8px;margin-bottom:12px;background:rgba(255,255,255,0.06);border:1px solid var(--border);color:var(--text);border-radius:4px;font-size:13px;';
    input.placeholder = 'e.g. phantom_copy.json';
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-secondary';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn primary';
    ok.textContent = 'OK';
    const finish = (value) => {
      overlay.remove();
      onConfirm(value);
    };
    cancel.onclick = () => finish(null);
    ok.onclick = () => {
      const name = input.value.trim();
      if (!name) return;
      const fileName = name.endsWith('.json') ? name : `${name}.json`;
      finish(fileName);
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') ok.click();
      if (e.key === 'Escape') cancel.click();
    };
    btnRow.appendChild(cancel);
    btnRow.appendChild(ok);
    box.appendChild(label);
    box.appendChild(input);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    overlay.onclick = (e) => { if (e.target === overlay) finish(null); };
    document.body.appendChild(overlay);
    input.focus();
    input.select();
  }

  handleJsonRevert() {
    const name = this.jsonTabCurrentName;
    if (!name) {
      this.setJsonTabStatus('No file selected.');
      return;
    }
    if (!this.pyodide) {
      this.setJsonTabStatus('Pyodide not ready.');
      return;
    }
    try {
      const content = this.pyodide.FS.readFile(`/phantom/${name}`, { encoding: 'utf8' });
      this.setJsonEditorValue(content);
      this._syncJsonContentToVolumeGroups(name, content);
      this.setJsonTabStatus('Reverted to saved version.');
    } catch (e) {
      this.setJsonTabStatus(`Revert failed: ${e.message}`);
    }
  }

  async handleJsonExecute(jsonName) {
    const name = jsonName ?? this.jsonTabCurrentName;
    if (!name) { this.setJsonTabStatus('No JSON selected.'); return; }
    if (!this.pyodide) { this.setJsonTabStatus('Pyodide not ready.'); return; }
    try {
      this.pyodide.FS.mkdirTree('/phantom');
      this.pyodide.FS.mkdirTree('/phantom/averaged');
    } catch (_) {}
    // Sync JSON to VFS (Execute reads /phantom/<name>); editor may be empty while volumeGroups still hold text
    let jsonBody = this.getJsonEditorValue();
    if (!String(jsonBody).trim()) {
      const g = this.volumeGroups.find((vg) => vg.jsonFileName === name && vg.jsonContent != null);
      if (g) jsonBody = String(g.jsonContent);
    }
    if (!String(jsonBody).trim()) {
      this.setJsonTabStatus('No JSON text to execute. Reload the phantom or paste JSON.');
      return;
    }
    try {
      this.pyodide.FS.writeFile(`/phantom/${name}`, jsonBody);
      this._syncJsonContentToVolumeGroups(name, jsonBody);
    } catch (e) {
      this.setJsonTabStatus(`Could not write JSON to VFS: ${e.message}`);
      return;
    }
    this.setJsonTabStatus('Executing...');
    try {
      const baseName = name.replace(/\.json$/i, '');
      // Remove any previous executed/averaged group for this json
      const prevGroups = this.volumeGroups.filter(g => g.jsonFileName === name && (g.jsonName?.endsWith("_executed") || g.jsonName?.endsWith("_averaged")));
      for (const g of prevGroups) {
        g.volumes.forEach(v => { try { this.nv.removeVolume(v); } catch (_) {} });
      }
      this.volumeGroups = this.volumeGroups.filter(g => !(g.jsonFileName === name && (g.jsonName?.endsWith("_executed") || g.jsonName?.endsWith("_averaged"))));

      const outPaths = await this.enqueuePyodideTask(
        `json-exec-${name}`,
        "json-execute",
        async () => {
          await this._ensureNibabelReady();
          const result = await this.pyodide.runPythonAsync(
            `execute_phantom(${JSON.stringify(name)}, phantom_dir='/phantom', out_dir=None, averaged_dir='/phantom/averaged', write_executed=False, write_averaged=True, density_nan_threshold=0.01)`
          );
          return result.toJs ? result.toJs() : Array.from(result);
        },
      );

      const groupId = "g-exec-" + Math.random().toString(36).substr(2, 5);
      const groupVolumes = [];
      let i = 0;
      for (const path of outPaths) {
        const bytes = this.pyodide.FS.readFile(path);
        const url = URL.createObjectURL(new Blob([bytes]));
        const volName = path.split('/').pop();
        const added = await this.nv.addVolumesFromUrl([{
          url, name: volName, colormap: 'gray', opacity: i === 0 ? 1.0 : 0
        }]);
        if (added?.length) { added[0]._groupId = groupId; groupVolumes.push(added[0]); }
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        i++;
      }
      this.volumeGroups.push({
        id: groupId,
        jsonName: baseName + "_averaged",
        volumes: groupVolumes,
        jsonFileName: name
      });
      this.updateVolumeList();
      this.setJsonTabStatus(`Done — ${groupVolumes.length} maps loaded.`);
    } catch (e) {
      console.error(e);
      this.setJsonTabStatus(`Error: ${e.message}`);
    }
  }

  _getPanelFovHtml(noContainer = false) {
    const content = `
          <h3 class="panel-title">FOV Protocol</h3>
          <div class="sliderGroup" id="fovControls-${this.instanceId}">
            <div class="sliderRow">
              <div>Size X (mm)</div>
              <div class="input-sync">
                <input id="fovXVal-${this.instanceId}" type="number" class="num-input" step="1" />
                <input id="fovX-${this.instanceId}" type="range" min="1" max="600" step="1" value="220" />
              </div>
            </div>
            <div class="sliderRow">
              <div>Size Y (mm)</div>
              <div class="input-sync">
                <input id="fovYVal-${this.instanceId}" type="number" class="num-input" step="1" />
                <input id="fovY-${this.instanceId}" type="range" min="1" max="600" step="1" value="220" />
              </div>
            </div>
            <div class="sliderRow">
              <div>Size Z (mm)</div>
              <div class="input-sync">
                <input id="fovZVal-${this.instanceId}" type="number" class="num-input" step="1" />
                <input id="fovZ-${this.instanceId}" type="range" min="1" max="600" step="1" value="10" />
              </div>
            </div>
            <div class="sliderRow" style="margin-top: 2px; border-top: 1px solid var(--border); padding-top: 2px;">
              <div>Off X (mm)</div>
              <div class="input-sync">
                <input id="fovOffXVal-${this.instanceId}" type="number" class="num-input" step="0.1" />
                <input id="fovOffX-${this.instanceId}" type="range" min="-100" max="100" step="0.1" value="0" />
              </div>
            </div>
            <div class="sliderRow">
              <div>Off Y (mm)</div>
              <div class="input-sync">
                <input id="fovOffYVal-${this.instanceId}" type="number" class="num-input" step="0.1" />
                <input id="fovOffY-${this.instanceId}" type="range" min="-100" max="100" step="0.1" value="0" />
              </div>
            </div>
            <div class="sliderRow">
              <div>Off Z (mm)</div>
              <div class="input-sync">
                <input id="fovOffZVal-${this.instanceId}" type="number" class="num-input" step="0.1" />
                <input id="fovOffZ-${this.instanceId}" type="range" min="-100" max="100" step="0.1" value="0" />
              </div>
            </div>
            <div class="sliderRow" style="margin-top: 2px; border-top: 1px solid var(--border); padding-top: 2px;">
              <div>Rot X (deg)</div>
              <div class="input-sync">
                <input id="fovRotXVal-${this.instanceId}" type="number" class="num-input" step="1" />
                <input id="fovRotX-${this.instanceId}" type="range" min="-180" max="180" step="1" value="0" />
              </div>
            </div>
            <div class="sliderRow">
              <div>Rot Y (deg)</div>
              <div class="input-sync">
                <input id="fovRotYVal-${this.instanceId}" type="number" class="num-input" step="1" />
                <input id="fovRotY-${this.instanceId}" type="range" min="-180" max="180" step="1" value="0" />
              </div>
            </div>
            <div class="sliderRow">
              <div>Rot Z (deg)</div>
              <div class="input-sync">
                <input id="fovRotZVal-${this.instanceId}" type="number" class="num-input" step="1" />
                <input id="fovRotZ-${this.instanceId}" type="range" min="-180" max="180" step="1" value="0" />
              </div>
            </div>
          </div>
    `;
    return noContainer ? content : `<div class="panel-flat">${content}</div>`;
  }

  _getPanelExportHtml(noContainer = false) {
    const content = `
          <h3 class="panel-title">Recon Matrix</h3>
          <div class="sliderGroup">
            <div class="sliderRow">
              <div>Recon X</div>
              <div class="input-sync">
                <input id="maskXVal-${this.instanceId}" type="number" class="num-input" step="1" />
                <input id="maskX-${this.instanceId}" type="range" min="16" max="512" step="1" value="128" />
              </div>
            </div>
            <div class="sliderRow">
              <div>Recon Y</div>
              <div class="input-sync">
                <input id="maskYVal-${this.instanceId}" type="number" class="num-input" step="1" />
                <input id="maskY-${this.instanceId}" type="range" min="16" max="512" step="1" value="128" />
              </div>
            </div>
            <div class="sliderRow">
              <div>Recon Z</div>
              <div class="input-sync">
                <input id="maskZVal-${this.instanceId}" type="number" class="num-input" step="1" value="1" />
                <input id="maskZ-${this.instanceId}" type="range" min="1" max="512" step="1" value="1" />
              </div>
            </div>
          </div>
          <h3 class="panel-title" style="margin-top: 12px;">Phantom Matrix</h3>
          <div class="sliderGroup">
            <div class="sliderRow">
              <div>Phantom X</div>
              <div class="input-sync">
                <input id="phantomXVal-${this.instanceId}" type="number" class="num-input" step="1" />
                <input id="phantomX-${this.instanceId}" type="range" min="16" max="512" step="1" value="128" />
              </div>
            </div>
            <div class="sliderRow">
              <div>Phantom Y</div>
              <div class="input-sync">
                <input id="phantomYVal-${this.instanceId}" type="number" class="num-input" step="1" />
                <input id="phantomY-${this.instanceId}" type="range" min="16" max="512" step="1" value="128" />
              </div>
            </div>
            <div class="sliderRow">
              <div>Phantom Z</div>
              <div class="input-sync">
                <input id="phantomZVal-${this.instanceId}" type="number" class="num-input" step="1" value="1" />
                <input id="phantomZ-${this.instanceId}" type="range" min="1" max="512" step="1" value="1" />
              </div>
            </div>
            <div class="phantom-oversample-row">
              <label for="phantomOversample-${this.instanceId}">Phantom FOV oversampling</label>
              <input id="phantomOversample-${this.instanceId}" type="text" class="oversample-input mono" value="[2,2,1]" spellcheck="false" title="Sim-only scale [sx,sy,sz]: matrix and FOV mm for phantom resampling (UI box unchanged)" />
            </div>
          </div>
          <div class="row" style="margin-top: 12px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
            <button id="downloadFovMesh-${this.instanceId}" class="btn btn-secondary btn-md" type="button">
              Download FOV + NIfTI
            </button>
            <button id="resampleToFov-${this.instanceId}" class="btn btn-secondary btn-md" type="button" disabled title="Wait for Pyodide to load...">
              Resample to FOV
            </button>
          </div>
    `;
    return noContainer ? content : `<div class="panel-flat">${content}</div>`;
  }

  renderFull(container) {
    const root = typeof container === 'string' ? document.getElementById(container) : container;
    if (!root) throw new Error(`Full container target not found: ${container}`);

    root.classList.add('niivue-app');
    root.innerHTML = `
      <div class="layout standalone-layout">
        <div id="controls-slot-${this.instanceId}" class="standalone-sidebar"></div>
        <div id="viewer-slot-${this.instanceId}"></div>
      </div>
    `;

    this.renderViewer(`viewer-slot-${this.instanceId}`);
    this.renderControls(`controls-slot-${this.instanceId}`, true);
  }

  bindControlElements() {
    const root = this.containerControls || document;
    const qs = (id) => root.querySelector(`#${id}-${this.instanceId}`);
    this.btnDemo = qs("load-demo");
    this.showFov = qs("showFov");
    this.sliceMM = qs("sliceMM");
    this.radiological = qs("radiological");
    this.showRender = qs("showRender");
    this.showCrosshair = qs("showCrosshair");
    this.scanRecon = qs("scanRecon");
    this.compactMode = qs("compactMode");
    this.zoom2D = qs("zoom2D");
    this.zoom2DVal = qs("zoom2DVal");
    this.fovControls = qs("fovControls");
    this.fovX = qs("fovX");
    this.fovY = qs("fovY");
    this.fovZ = qs("fovZ");
    this.fovXVal = qs("fovXVal");
    this.fovYVal = qs("fovYVal");
    this.fovZVal = qs("fovZVal");
    this.fovOffX = qs("fovOffX");
    this.fovOffY = qs("fovOffY");
    this.fovOffZ = qs("fovOffZ");
    this.fovOffXVal = qs("fovOffXVal");
    this.fovOffYVal = qs("fovOffYVal");
    this.fovOffZVal = qs("fovOffZVal");
    this.fovRotX = qs("fovRotX");
    this.fovRotY = qs("fovRotY");
    this.fovRotZ = qs("fovRotZ");
    this.fovRotXVal = qs("fovRotXVal");
    this.fovRotYVal = qs("fovRotYVal");
    this.fovRotZVal = qs("fovRotZVal");
    this.maskX = qs("maskX");
    this.maskY = qs("maskY");
    this.maskZ = qs("maskZ");
    this.maskXVal = qs("maskXVal");
    this.maskYVal = qs("maskYVal");
    this.maskZVal = qs("maskZVal");
    this.phantomX = qs("phantomX");
    this.phantomY = qs("phantomY");
    this.phantomZ = qs("phantomZ");
    this.phantomXVal = qs("phantomXVal");
    this.phantomYVal = qs("phantomYVal");
    this.phantomZVal = qs("phantomZVal");
    this.phantomOversampleInput = qs("phantomOversample");
    this.debugInfo = qs("debugInfo");
    this.downloadFovMeshBtn = qs("downloadFovMesh");
    this.azVal = qs("azVal");
    this.elVal = qs("elVal");
    this.voxVal = qs("voxVal");
    this.mmVal = qs("mmVal");
    this.locStrVal = qs("locStrVal");
    this.scanVolumeListContainer = qs("scan-volume-list");
    this.phantomVolumeListContainer = qs("phantom-volume-list");
    this.btnAddFolder = qs("btn-add-folder");
    this.dirInput = qs("dir");
    this.resampleToFovBtn = qs("resampleToFov");
  }

  triggerHighlight() {
    const target = this.containerViewer ? this.containerViewer.querySelector('.viewer') : null;
    if (!target) return;
    
    target.classList.remove('highlight-add');
    void target.offsetWidth; // Force reflow
    target.classList.add('highlight-add');
  }

  showJsonChoiceDialog(jsonFiles, niftiFiles) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "json-choice-overlay";
      overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999;";
      const box = document.createElement("div");
      box.className = "json-choice-dialog";
      box.style.cssText = "background:var(--bg-panel);border:1px solid var(--border);border-radius:8px;padding:16px;min-width:280px;max-width:400px;box-shadow:0 8px 32px rgba(0,0,0,0.4);";
      const title = document.createElement("div");
      title.style.cssText = "font-weight:600;margin-bottom:12px;color:var(--text);";
      title.textContent = "Choose phantom configuration";
      const hint = document.createElement("div");
      hint.style.cssText = "font-size:11px;color:var(--muted);margin-bottom:12px;";
      hint.textContent = `${niftiFiles.length} NIfTI file(s) found. Select which JSON to use:`;
      const list = document.createElement("div");
      list.style.cssText = "display:flex;flex-direction:column;gap:6px;margin-bottom:16px;max-height:200px;overflow-y:auto;";
      jsonFiles.forEach((f) => {
        const btn = document.createElement("button");
        btn.className = "btn";
        btn.style.cssText = "text-align:left;padding:10px 12px;justify-content:flex-start;";
        btn.textContent = f.name;
        btn.onclick = () => {
          overlay.remove();
          resolve(f);
        };
        list.appendChild(btn);
      });
      const footer = document.createElement("div");
      footer.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";
      const cancel = document.createElement("button");
      cancel.className = "btn btn-secondary";
      cancel.textContent = "Cancel";
      cancel.onclick = () => {
        overlay.remove();
        resolve(null);
      };
      footer.appendChild(cancel);
      box.appendChild(title);
      box.appendChild(hint);
      box.appendChild(list);
      box.appendChild(footer);
      overlay.appendChild(box);
      overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(null); } };
      document.body.appendChild(overlay);
    });
  }

  async initNiivue() {
    if (!this.canvas) return;
    
    this.nv.opts.multiplanarShowRender = SHOW_RENDER.ALWAYS;
    if (this.showRender) this.showRender.checked = true;
    this.nv.scene.pan2Dxyzmm[3] = 0.9;
    
    await this.nv.attachTo(this.canvasId);
    installFrameAwareContrastDrag(this.nv);
    installFrameAwareBriConReset(this.nv);
    this.nv.opts.fontMinPx = 11;
    this.nv.opts.fontSizeScaling = 0.4;
    if (typeof this.nv.textSizePoints === "function") this.nv.textSizePoints();

    try {
      this.nv.setSliceType(SLICE_TYPE.MULTIPLANAR);
      this.nv.setMultiplanarLayout(MULTIPLANAR_TYPE.GRID); 
      if (this.sliceMM) this.nv.setSliceMM(this.sliceMM.checked);
      if (this.radiological) this.radiological.checked = this.nv.getRadiologicalConvention();
    } catch (e) {
      console.warn("Failed to set MULTIPLANAR slice type", e);
    }

    this.nv.onAzimuthElevationChange = (azimuth, elevation) => {
      const az = Number(azimuth);
      const el = Number(elevation);
      if (this.azVal && Number.isFinite(az)) this.azVal.textContent = az.toFixed(1);
      if (this.elVal && Number.isFinite(el)) this.elVal.textContent = el.toFixed(1);
    };

    this.nv.onLocationChange = (data) => {
      try {
        const vox = data?.vox;
        const mm = data?.mm;
        const str = data?.str ?? data?.string ?? data?.text ?? null;
        if (typeof data?.axCorSag === "number") this.currentAxCorSag = data.axCorSag;
        
        if (this.voxVal) {
          if ((Array.isArray(vox) || ArrayBuffer.isView(vox)) && vox.length >= 3) {
            this.voxVal.textContent = `${Number(vox[0]).toFixed(1)}, ${Number(vox[1]).toFixed(1)}, ${Number(vox[2]).toFixed(1)}`;
          } else {
            this.voxVal.textContent = "—";
          }
        }
        
        if (this.mmVal) {
          if ((Array.isArray(mm) || ArrayBuffer.isView(mm)) && mm.length >= 3) {
            this.mmVal.textContent = `${Number(mm[0]).toFixed(1)}, ${Number(mm[1]).toFixed(1)}, ${Number(mm[2]).toFixed(1)}`;
          } else {
            this.mmVal.textContent = "—";
          }
        }
        
        if (this.locStrVal) this.locStrVal.textContent = str ? String(str) : "—";

        // Store coordinates for FOV positioning
        if ((Array.isArray(vox) || ArrayBuffer.isView(vox)) && vox.length >= 3) {
          this.lastLocationVox = [Number(vox[0]), Number(vox[1]), Number(vox[2])];
        }
        if ((Array.isArray(mm) || ArrayBuffer.isView(mm)) && mm.length >= 3) {
          this.lastLocationMm = [Number(mm[0]), Number(mm[1]), Number(mm[2])];
        }

        // Update crosshair intensity (bottom-left overlay)
        this.updateCrosshairIntensity(data);
        this.updateDebugInfo();
      } catch (e) { console.warn("onLocationChange handler failed", e); }
    };

    this.canvas.addEventListener("mousedown", (e) => this.handleMouseDown(e), { capture: true });
    window.addEventListener("mousemove", (e) => this.handleMouseMove(e));
    window.addEventListener("mouseup", () => this.handleMouseUp());
    this.canvas.addEventListener("wheel", (e) => this.handleWheel(e), { passive: false, capture: true });
    
    // Touch events for FOV manipulation (when FOV visible):
    // - Single finger: drag FOV position
    // - Two fingers: rotate FOV (twist gesture)
    this.canvas.addEventListener("touchstart", (e) => {
        if (!this.showFov?.checked) return;
        
        if (e.touches.length === 1) {
            // Single finger: wait for movement before starting FOV drag so double-tap can be detected
            // Skip if we're in cooldown after a two-finger release (avoids leftover finger triggering drag)
            const inCooldown = (Date.now() - this.twoFingerReleaseTime) < this.TWO_FINGER_COOLDOWN_MS;
            if (!inCooldown) {
                const touch = e.touches[0];
                this.touchPendingFovDrag = true;
                this.touchStartX = touch.clientX;
                this.touchStartY = touch.clientY;
            }
        } else if (e.touches.length === 2) {
            // Two fingers = FOV rotation; clear single-finger state so leftover finger doesn't start drag
            this.touchPendingFovDrag = false;
            e.preventDefault();
            if (window.viewManager && window.viewManager.currentMode !== 'planning') {
                window.viewManager.setMode('planning');
            }
            this.savedDragMode = this.nv.opts.dragMode;
            this.nv.opts.dragMode = DRAG_MODE.callbackOnly;
            
            // Calculate midpoint for determining which slice we're on
            const t1 = e.touches[0], t2 = e.touches[1];
            const midX = (t1.clientX + t2.clientX) / 2;
            const midY = (t1.clientY + t2.clientY) / 2;
            this.dragStartTileIndex = this.updateViewFromMouse({ clientX: midX, clientY: midY });
            this.fovRotateAxCorSag = this._paneFromScreenSliceTile(this.dragStartTileIndex) ?? this.currentAxCorSag;
            
            // Calculate initial angle between the two touch points
            this.touchRotateStartAngle = Math.atan2(t2.clientY - t1.clientY, t2.clientX - t1.clientX);
            
            // Get current rotation value based on slice orientation
            let startVal = 0;
            const pane = this.fovRotateAxCorSag;
            if (pane === 0) startVal = Number(this.fovRotZ.value);
            else if (pane === 1) startVal = Number(this.fovRotY.value);
            else startVal = Number(this.fovRotX.value);
            this.dragStartRotation = startVal;
            
            this.isRotatingFov = true;
            this.isTwoFingerRotating = true;
        }
    }, { passive: false, capture: true });
    
    const TOUCH_DRAG_THRESHOLD_PX = 10;
    window.addEventListener("touchmove", (e) => {
        if (!this.showFov?.checked) return;
        
        const inCooldown = (Date.now() - this.twoFingerReleaseTime) < this.TWO_FINGER_COOLDOWN_MS;
        if (this.touchPendingFovDrag && e.touches.length === 1 && !inCooldown) {
            const touch = e.touches[0];
            const dx = touch.clientX - this.touchStartX;
            const dy = touch.clientY - this.touchStartY;
            if (Math.sqrt(dx * dx + dy * dy) >= TOUCH_DRAG_THRESHOLD_PX) {
                this.touchPendingFovDrag = false;
                this.handleMouseDown({
                    clientX: this.touchStartX,
                    clientY: this.touchStartY,
                    button: 0,
                    ctrlKey: true,
                    preventDefault: () => e.preventDefault(),
                    stopPropagation: () => e.stopPropagation(),
                    stopImmediatePropagation: () => e.stopImmediatePropagation()
                });
                e.preventDefault();
                this.handleMouseMove({
                    clientX: touch.clientX,
                    clientY: touch.clientY,
                    preventDefault: () => {},
                    stopPropagation: () => {}
                });
            }
        } else if (this.isDraggingFov && e.touches.length === 1) {
            // Single finger drag (already started)
            const touch = e.touches[0];
            e.preventDefault();
            this.handleMouseMove({
                clientX: touch.clientX,
                clientY: touch.clientY,
                preventDefault: () => {},
                stopPropagation: () => {}
            });
        } else if (this.isTwoFingerRotating && e.touches.length === 2) {
            // Two finger rotation
            e.preventDefault();
            const t1 = e.touches[0], t2 = e.touches[1];
            const currentAngle = Math.atan2(t2.clientY - t1.clientY, t2.clientX - t1.clientX);
            let deltaRad = currentAngle - this.touchRotateStartAngle;
            
            // Normalize to -PI to PI
            while (deltaRad <= -Math.PI) deltaRad += 2 * Math.PI;
            while (deltaRad > Math.PI) deltaRad -= 2 * Math.PI;
            
            let deltaDeg = deltaRad * (180 / Math.PI);
            // Touch: coronal pane needs opposite twist sense vs mouse (Ctrl+right uses getMouseAngle convention).
            const pane = this.fovRotateAxCorSag;
            const rotSign = pane === 1 ? 1 : -1;
            let finalRot = this.dragStartRotation + rotSign * deltaDeg;
            
            // Normalize rotation to -180 to 180
            const norm = (v) => {
                let n = v % 360;
                if (n > 180) n -= 360;
                if (n < -180) n += 360;
                return n;
            };
            
            if (pane === 0) this.fovRotZ.value = String(norm(finalRot).toFixed(1));
            else if (pane === 1) this.fovRotY.value = String(norm(finalRot).toFixed(1));
            else this.fovRotX.value = String(norm(finalRot).toFixed(1));
            this.rebuildFovLive();
        }
    }, { passive: false });
    
    window.addEventListener("touchend", (e) => {
        if (this.isDraggingFov && !this.isTwoFingerRotating) {
            this.handleMouseUp();
            this.touchPendingFovDrag = false;
        }
        if (this.isTwoFingerRotating && e.touches.length < 2) {
            this.isTwoFingerRotating = false;
            this.isRotatingFov = false;
            this.fovRotateAxCorSag = null;
            this.nv.opts.dragMode = this.savedDragMode;
            this.twoFingerReleaseTime = Date.now();
            this.syncFovLabels();
        }
    });

    // Capture phase: block Niivue dblclick → resetBriCon (robust min/max reset).
    this.canvas.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.toggleMaximize();
    }, true);
    
    // Double-tap detection for touch (only when touch was a tap, not a drag)
    let lastTapTime = 0;
    this.canvas.addEventListener("touchend", (e) => {
        if (e.touches.length === 0 && e.changedTouches.length === 1) {
            const now = Date.now();
            const inCooldown = (now - this.twoFingerReleaseTime) < this.TWO_FINGER_COOLDOWN_MS;
            if (this.touchPendingFovDrag && !inCooldown) {
                if (now - lastTapTime < 300 && now - lastTapTime > 50 && !this.isTwoFingerRotating) {
                    this.toggleMaximize();
                }
                lastTapTime = now;
            }
            this.touchPendingFovDrag = false;
        }
    });

    setInterval(() => this.updateAngles(), 200);
    this.isInitialized = true;
    this._initWaiters.forEach(resolve => resolve());
    this._initWaiters = [];
    setTimeout(() => this.emitViewOptions(), 100);
  }

  emitViewOptions() {
    if (this.sliceMM && this.radiological && this.showRender && this.showCrosshair) {
      eventHub.emit('viewOptionsChange', {
        sliceMM: this.sliceMM.checked,
        radiological: this.radiological.checked,
        showRender: this.showRender.checked,
        showCrosshair: this.showCrosshair.checked
      });
    }
  }

  /** Toggle maximize this viewer (hide the other viewer) */
  toggleMaximize() {
    eventHub.emit('toggleViewerMaximize', { containerId: this.containerViewer?.id });
  }

  async initPyodide() {
    if (this._initPyodidePromise) return this._initPyodidePromise;
    this._initPyodidePromise = (async () => {
    try {
      if (!this.pyodide) {
        if (typeof loadPyodide === 'undefined') {
          console.warn("loadPyodide not found. Python resampling will not be available.");
          if (this.pyodideStatus) this.pyodideStatus.textContent = "Python (Pyodide): unavailable";
          return;
        }
        if (this.pyodideStatus) this.pyodideStatus.textContent = "Python (Pyodide): loading core...";
        this.pyodide = await loadPyodide();
        if (this.pyodideStatus) this.pyodideStatus.textContent = "Python (Pyodide): loading numpy...";
        await this.pyodide.loadPackage(["numpy", "micropip"]);
      } else {
        if (this.pyodideStatus) this.pyodideStatus.textContent = "Python (Pyodide): ready (shared)";
      }
      
      // Nibabel import and resampling/execute_json setup deferred to first use
      // via _ensureNibabelReady() — avoids blocking startup with slow 'import nibabel'.
      if (this.pyodideStatus) this.pyodideStatus.textContent = "Python (Pyodide): ready";
      if (this.resampleToFovBtn) {
        this.resampleToFovBtn.disabled = false;
        this.resampleToFovBtn.title = "Resample current volume to match FOV grid";
      }
    } catch (e) {
      this._initPyodidePromise = null; // allow retry on failure
      console.error(e);
      if (this.pyodideStatus) this.pyodideStatus.textContent = "Python (Pyodide): error " + e.message;
    }
    })();
    return this._initPyodidePromise;
  }

  isResampleBusy() {
    return this._resampleBusyCount > 0;
  }

  /** Global wait cursor while footprint resampling runs on the main thread. */
  _setResampleBusy(active) {
    const wasBusy = this._resampleBusyCount > 0;
    this._resampleBusyCount += active ? 1 : -1;
    if (this._resampleBusyCount < 0) this._resampleBusyCount = 0;
    const busy = this._resampleBusyCount > 0;
    if (typeof document !== "undefined" && wasBusy !== busy) {
      document.documentElement.classList.toggle("resample-busy", busy);
    }
  }

  /** Safe token for per-job Pyodide /tmp paths. */
  sanitizePyodideJobId(jobId) {
    const s = String(jobId ?? "").trim();
    if (!s) return "default";
    const out = [];
    for (const ch of s) {
      if (/[a-zA-Z0-9_-]/.test(ch)) out.push(ch);
      else if (".:/\\".includes(ch)) out.push("_");
    }
    const token = out.join("").slice(0, 64);
    return token || "default";
  }

  /** Per-job resample output / 4D spill paths (see data/resampling.py). */
  resampleTempPaths(jobId, suffix = "") {
    const base = this.sanitizePyodideJobId(jobId);
    const suf = suffix ? `_${suffix}` : "";
    return {
      outPath: `/tmp/__rs_${base}${suf}.nii`,
      spillPath: `/tmp/__rs_4d_${base}${suf}.nii`,
      spillPathGz: `/tmp/__rs_4d_${base}${suf}.nii.gz`,
    };
  }

  simStagingPath(jobId) {
    return `/tmp/__sim_staging_${this.sanitizePyodideJobId(jobId)}`;
  }

  simReconOutPath(jobId) {
    return `/tmp/__sim_reco_${this.sanitizePyodideJobId(jobId)}.nii`;
  }

  /**
   * FIFO queue for Pyodide work (resample, nibabel bootstrap, recon, JSON execute).
   * CROP/SCAN clicks enqueue; no button disable required.
   */
  enqueuePyodideTask(taskId, label, fn) {
    const id = this.sanitizePyodideJobId(taskId || `task_${Date.now()}`);
    return new Promise((resolve, reject) => {
      this._pyodideQueue.push({
        taskId: id,
        label: label || "pyodide",
        fn,
        resolve,
        reject,
      });
      void this._drainPyodideQueue();
    });
  }

  async _drainPyodideQueue() {
    if (this._pyodideDraining) return;
    this._pyodideDraining = true;
    while (this._pyodideQueue.length > 0) {
      const task = this._pyodideQueue.shift();
      this._pyodideDrainDepth += 1;
      try {
        const result = await task.fn();
        task.resolve(result);
      } catch (e) {
        console.warn(`[Pyodide queue] ${task.label} (${task.taskId}) failed:`, e);
        task.reject(e);
      } finally {
        this._pyodideDrainDepth -= 1;
      }
    }
    this._pyodideDraining = false;
  }

  /** Read NIfTI bytes from a resampling return value and unlink the temp file. */
  readResampleOutputPath(outPathRes) {
    const outPathRaw = (outPathRes && outPathRes.toJs) ? outPathRes.toJs() : outPathRes;
    const outPath = String(outPathRaw);
    if (outPathRaw?.destroy) outPathRaw.destroy();
    if (outPathRes?.destroy) outPathRes.destroy();
    let bytes;
    try {
      bytes = this.pyodide.FS.readFile(outPath);
    } finally {
      try { this.pyodide.FS.unlink(outPath); } catch (_) {}
    }
    return { outPath, bytes };
  }

  formatPyodideError(e) {
    if (e?.errno === 44 || e?.name === "ErrnoError") {
      return "Pyodide temp file missing (FS race). If this persists, retry once; avoid overlapping resample jobs.";
    }
    return e?.message || String(e);
  }

  async _bootstrapNibabelAndScripts() {
    if (!this.pyodide) throw new Error("Pyodide not initialised");
    if (this._nibabelLoadDone && this._resamplingLoadedVersion === RESAMPLING_PY_VERSION) {
      return;
    }
    if (this.pyodideStatus) this.pyodideStatus.textContent = "Python: loading nibabel...";
    const resamplingBase = this.options.resamplingScriptUrl || "data/resampling.py";
    const resamplingUrl = `${resamplingBase}${resamplingBase.includes("?") ? "&" : "?"}v=${RESAMPLING_PY_VERSION}`;
    const executeJsonUrl = this.options.executeJsonScriptUrl || "data/execute_json.py";
    const [resamplingResp, execResp] = await Promise.all([
      fetch(resamplingUrl, { cache: "no-store" }),
      fetch(executeJsonUrl, { cache: "no-store" }),
      this.pyodide.runPythonAsync(`import micropip\nawait micropip.install('nibabel')`),
    ]);
    if (!resamplingResp.ok) throw new Error(`Could not load ${resamplingUrl}: ${resamplingResp.status}`);
    if (!execResp.ok) throw new Error(`Could not load ${executeJsonUrl}: ${execResp.status}`);
    const [resamplingCode, executeJsonCode] = await Promise.all([
      resamplingResp.text(),
      execResp.text(),
    ]);
    await this.pyodide.runPythonAsync(resamplingCode);
    await this.pyodide.runPythonAsync(executeJsonCode);
    this._resamplingLoadedVersion = RESAMPLING_PY_VERSION;
    this._nibabelLoadDone = true;
    if (this.pyodideStatus) this.pyodideStatus.textContent = "Python (Pyodide): ready";
  }

  /**
   * Lazily loads nibabel + resampling + execute_json (deduped; safe inside enqueuePyodideTask).
   */
  _ensureNibabelReady() {
    if (this._nibabelLoadDone && this._resamplingLoadedVersion === RESAMPLING_PY_VERSION) {
      return Promise.resolve();
    }
    if (this._nibabelReadyPromise) {
      return this._nibabelReadyPromise;
    }
    const loadFn = async () => {
      try {
        await this._bootstrapNibabelAndScripts();
      } catch (e) {
        this._nibabelLoadDone = false;
        this._resamplingLoadedVersion = null;
        if (this.pyodideStatus) {
          this.pyodideStatus.textContent = "Python (Pyodide): error " + (e.message || e);
        }
        throw e;
      }
    };
    const started = this._pyodideDrainDepth > 0
      ? loadFn()
      : this.enqueuePyodideTask("__nibabel__", "nibabel-ready", loadFn);
    this._nibabelReadyPromise = started.catch((e) => {
      this._nibabelReadyPromise = null;
      throw e;
    });
    return this._nibabelReadyPromise;
  }

  async populatePyodideVFS(niftiFiles, jsonFiles) {
    await this.initPyodide();
    this.pyodide.runPython(`
import os, shutil
if os.path.exists('/phantom'): shutil.rmtree('/phantom')
os.makedirs('/phantom')
os.makedirs('/phantom/averaged', exist_ok=True)
`);
    for (const f of niftiFiles) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      this.pyodide.FS.writeFile(`/phantom/${f.name}`, bytes);
    }
    for (const f of jsonFiles) {
      const text = await f.text();
      this.pyodide.FS.writeFile(`/phantom/${f.name}`, text);
    }
  }

  setupEventListeners() {
    if (this.btnAddFolder) {
      this.btnAddFolder.addEventListener("click", () => this.showCachePhantomDialog());
    }

    this.showFov.addEventListener("change", () => this.requestFovUpdate());
    this.sliceMM.addEventListener("change", () => {
      this.nv.setSliceMM(this.sliceMM.checked);
      this.emitViewOptions();
    });
    this.radiological.addEventListener("change", () => {
      this.nv.setRadiologicalConvention(this.radiological.checked);
      this.emitViewOptions();
    });
    this.showRender.addEventListener("change", () => { 
      this.nv.opts.multiplanarShowRender = this.showRender.checked ? SHOW_RENDER.ALWAYS : SHOW_RENDER.NEVER; 
      this.nv.drawScene(); 
      this.emitViewOptions();
    });
    this.showCrosshair.addEventListener("change", () => {
      this.nv.setCrosshairWidth(this.showCrosshair.checked ? 1 : 0);
      this.emitViewOptions();
    });
    if (this.compactMode) {
      this.compactMode.addEventListener("change", () => {
        const shell = document.querySelector(".lab-shell");
        if (shell) shell.classList.toggle("compact-mode", this.compactMode.checked);
      });
    }

    this.bindBiDirectional(this.zoom2D, this.zoom2DVal, () => { 
      const pan = this.nv.scene.pan2Dxyzmm; 
      this.nv.setPan2Dxyzmm([pan[0], pan[1], pan[2], parseFloat(this.zoom2D.value)]); 
      this.syncFovLabels(); 
    });
    this.bindBiDirectional(this.fovX, this.fovXVal, () => this.rebuildFovLive(true));
    this.bindBiDirectional(this.fovY, this.fovYVal, () => this.rebuildFovLive(true));
    this.bindBiDirectional(this.fovZ, this.fovZVal, () => this.rebuildFovLive(true));
    this.bindBiDirectional(this.fovOffX, this.fovOffXVal, () => this.rebuildFovLive(true));
    this.bindBiDirectional(this.fovOffY, this.fovOffYVal, () => this.rebuildFovLive(true));
    this.bindBiDirectional(this.fovOffZ, this.fovOffZVal, () => this.rebuildFovLive(true));
    this.bindBiDirectional(this.fovRotX, this.fovRotXVal, () => this.rebuildFovLive(true));
    this.bindBiDirectional(this.fovRotY, this.fovRotYVal, () => this.rebuildFovLive(true));
    this.bindBiDirectional(this.fovRotZ, this.fovRotZVal, () => this.rebuildFovLive(true));
    this.bindBiDirectional(this.maskX, this.maskXVal, () => this.syncFovLabels());
    this.bindBiDirectional(this.maskY, this.maskYVal, () => this.syncFovLabels());
    this.bindBiDirectional(this.maskZ, this.maskZVal, () => this.syncFovLabels());
    this.bindBiDirectional(this.phantomX, this.phantomXVal, () => this.syncFovLabels());
    this.bindBiDirectional(this.phantomY, this.phantomYVal, () => this.syncFovLabels());
    this.bindBiDirectional(this.phantomZ, this.phantomZVal, () => this.syncFovLabels());
    this.syncFovLabels();

    this.downloadFovMeshBtn.addEventListener("click", () => this.handleDownloadFovMesh());
    this.resampleToFovBtn.addEventListener("click", () => this.handleResampleToFov());
    this.btnDemo.onclick = async () => {
      if (!await this.confirmPhantomReset()) return;
      this.resetViewer();
      try {
        await this.loadDefaultCachePhantom();
      } catch (e) {
        console.error("Default cache phantom load failed:", e);
        alert(`Default phantom load failed: ${e?.message || e}`);
      }
      this.updateJsonTab();
    };

    // Listen for FOV updates coming from the sequence explorer (seq → Niivue, dimensions only)
    eventHub.on('sequence_fov_dims', (data) => this.applySequenceFovDimensions(data));
  }

  // --- Logic methods (unmodified from original) ---

  affineColToRowMajor(colMajor) {
      return [
          colMajor[0], colMajor[4], colMajor[8], colMajor[12],
          colMajor[1], colMajor[5], colMajor[9], colMajor[13],
          colMajor[2], colMajor[6], colMajor[10], colMajor[14],
          colMajor[3], colMajor[7], colMajor[11], colMajor[15],
      ];
  }

  setNiftiQform(niftiBytes, affineRowMajor, qformCode = 2, sformCode = 2) {
      const view = new DataView(niftiBytes.buffer, niftiBytes.byteOffset, niftiBytes.byteLength);
      const littleEndian = true;
      for (let i = 0; i < 12; i++) {
          view.setFloat32(280 + i * 4, affineRowMajor[i], littleEndian);
      }
      view.setInt16(254, sformCode, littleEndian);
      const m = [
          [affineRowMajor[0], affineRowMajor[1], affineRowMajor[2]],
          [affineRowMajor[4], affineRowMajor[5], affineRowMajor[6]],
          [affineRowMajor[8], affineRowMajor[9], affineRowMajor[10]]
      ];
      const sx = Math.sqrt(m[0][0]**2 + m[1][0]**2 + m[2][0]**2);
      const sy = Math.sqrt(m[0][1]**2 + m[1][1]**2 + m[2][1]**2);
      const sz = Math.sqrt(m[0][2]**2 + m[1][2]**2 + m[2][2]**2);
      view.setFloat32(80, sx, littleEndian);
      view.setFloat32(84, sy, littleEndian);
      view.setFloat32(88, sz, littleEndian);
      const R = [
          [m[0][0]/sx, m[0][1]/sy, m[0][2]/sz],
          [m[1][0]/sx, m[1][1]/sy, m[1][2]/sz],
          [m[2][0]/sx, m[2][1]/sy, m[2][2]/sz]
      ];
      let det = R[0][0]*(R[1][1]*R[2][2] - R[1][2]*R[2][1]) - 
                R[0][1]*(R[1][0]*R[2][2] - R[1][2]*R[2][0]) + 
                R[0][2]*(R[1][0]*R[2][1] - R[1][1]*R[2][0]);
      let qfac = 1.0;
      if (det < 0) {
          qfac = -1.0;
          R[0][2] = -R[0][2];
          R[1][2] = -R[1][2];
          R[2][2] = -R[2][2];
      }
      view.setFloat32(76, qfac, littleEndian);
      let qw, qx, qy, qz;
      let tr = R[0][0] + R[1][1] + R[2][2];
      if (tr > 0) {
          let s = Math.sqrt(tr + 1.0) * 2;
          qw = 0.25 * s;
          qx = (R[2][1] - R[1][2]) / s;
          qy = (R[0][2] - R[2][0]) / s;
          qz = (R[1][0] - R[0][1]) / s;
      } else if ((R[0][0] > R[1][1]) && (R[0][0] > R[2][2])) {
          let s = Math.sqrt(1.0 + R[0][0] - R[1][1] - R[2][2]) * 2;
          qw = (R[2][1] - R[1][2]) / s;
          qx = 0.25 * s;
          qy = (R[0][1] + R[1][0]) / s;
          qz = (R[0][2] + R[2][0]) / s;
      } else if (R[1][1] > R[2][2]) {
          let s = Math.sqrt(1.0 + R[1][1] - R[0][0] - R[2][2]) * 2;
          qw = (R[0][2] - R[2][0]) / s;
          qx = (R[0][1] + R[1][0]) / s;
          qy = 0.25 * s;
          qz = (R[1][2] + R[2][1]) / s;
      } else {
          let s = Math.sqrt(1.0 + R[2][2] - R[0][0] - R[1][1]) * 2;
          qw = (R[1][0] - R[0][1]) / s;
          qx = (R[0][2] + R[2][0]) / s;
          qy = (R[1][2] + R[2][1]) / s;
          qz = 0.25 * s;
      }
      if (qw < 0) { qx=-qx; qy=-qy; qz=-qz; }
      view.setInt16(252, qformCode, littleEndian);
      view.setFloat32(256, qx, littleEndian);
      view.setFloat32(260, qy, littleEndian);
      view.setFloat32(264, qz, littleEndian);
      view.setFloat32(268, affineRowMajor[3], littleEndian);
      view.setFloat32(272, affineRowMajor[7], littleEndian);
      view.setFloat32(276, affineRowMajor[11], littleEndian);
      return niftiBytes;
  }

  updateCrosshairIntensity(data) {
    const { vol } = this.getVolumeForIntensity();
    updateCrosshairIntensityOverlay(this.crosshairIntensityEl, this.nv, data, vol);
  }

  /** Re-fire location callback after volume list changes (keeps intensity overlay in sync). */
  refreshCrosshairIntensityOverlay() {
    if (!this.nv?.volumes?.length) {
      if (this.crosshairIntensityEl) this.crosshairIntensityEl.textContent = "—";
      return;
    }
    const ax = typeof this.currentAxCorSag === "number" && Number.isFinite(this.currentAxCorSag)
      ? this.currentAxCorSag
      : NaN;
    refreshCrosshairIntensityForNv(this.nv, ax);
  }

  readAnglesBestEffort() {
    const candidates = [
      [this.nv?.opts?.renderAzimuth, this.nv?.opts?.renderElevation],
      [this.nv?.opts?.azimuth, this.nv?.opts?.elevation],
      [this.nv?.scene?.renderAzimuth, this.nv?.scene?.renderElevation],
      [this.nv?.scene?.azimuth, this.nv?.scene?.elevation],
      [this.nv?.scene?.cameraAzimuth, this.nv?.scene?.cameraElevation],
    ];
    for (const [a, e] of candidates) {
      const az = Number(a);
      const el = Number(e);
      if (Number.isFinite(az) && Number.isFinite(el)) return [az, el];
    }
    return null;
  }

  updateAngles() {
    const pair = this.readAnglesBestEffort();
    if (!pair) return;
    const [az, el] = pair;
    if (!this.lastAzEl || az !== this.lastAzEl[0] || el !== this.lastAzEl[1]) {
      if (this.azVal) this.azVal.textContent = az.toFixed(1);
      if (this.elVal) this.elVal.textContent = el.toFixed(1);
      this.lastAzEl = [az, el];
    }
  }

  handleMouseDown(e) {
         if (window.viewManager && window.viewManager.currentMode !== 'planning') {
            window.viewManager.setMode('planning');
         }

         // Ctrl + Middle Mouse Drag: Zoom
         if (e.ctrlKey && e.button === 1) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            this.savedDragMode = this.nv.opts.dragMode;
            this.nv.opts.dragMode = DRAG_MODE.callbackOnly;
            this.isZooming2D = true;
            this.zoomStartMouseY = e.clientY;
            this.zoomStartValue = Number(this.zoom2D.value);
            this.zoomStartPan = [...this.nv.scene.pan2Dxyzmm];
            return;
         }

         // Ctrl + Mouse Drag: FOV Actions
         if (e.ctrlKey) {
            e.preventDefault();
            this.savedDragMode = this.nv.opts.dragMode;
            this.nv.opts.dragMode = DRAG_MODE.callbackOnly;
            if (e.button === 2) {
                this.dragStartTileIndex = this.updateViewFromMouse(e);
                this.fovRotateAxCorSag = this._paneFromScreenSliceTile(this.dragStartTileIndex) ?? this.currentAxCorSag;
                this.isRotatingFov = true;
                let startVal = 0;
                const pane = this.fovRotateAxCorSag;
                if (pane === 0) startVal = Number(this.fovRotZ.value);
                else if (pane === 1) startVal = Number(this.fovRotY.value);
                else startVal = Number(this.fovRotX.value);
                this.dragStartRotation = startVal;
                this.dragStartAngle = this.getMouseAngle(e);
            } else if (e.button === 0) {
                this.dragStartTileIndex = this.updateViewFromMouse(e);
                this.isDraggingFov = true;
                const rect = this.canvas.getBoundingClientRect();
                const dpr = window.devicePixelRatio || 1;
                this.dragStartPx = [(e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr];
                const centerOffsets = this.getOffsetsForCenterAtClick(e, this.dragStartTileIndex);
                if (centerOffsets) {
                    this.fovOffX.value = String(centerOffsets[0].toFixed(1));
                    this.fovOffY.value = String(centerOffsets[1].toFixed(1));
                    this.fovOffZ.value = String(centerOffsets[2].toFixed(1));
                    this.syncFovLabels();
                    this.rebuildFovLive();
                }
                this.dragStartOffsets = [Number(this.fovOffX.value), Number(this.fovOffY.value), Number(this.fovOffZ.value)];
            }
         }
  }

    handleMouseMove(e) {
         if (this.isZooming2D) {
            e.preventDefault();
            e.stopPropagation();
            const dy = e.clientY - this.zoomStartMouseY;
            let newVal = this.zoomStartValue - (dy / 200);
            newVal = Math.max(0.2, Math.min(2.0, newVal));
            this.zoom2D.value = String(newVal.toFixed(2));
            
            // Use the snapshotted pan to prevent the object from moving while zooming
            const pan = this.zoomStartPan || [0, 0, 0, 0];
            this.nv.setPan2Dxyzmm([pan[0], pan[1], pan[2], newVal]);
            
            this.syncFovLabels();
            this.rebuildFovLive();
            return;
         }
         if (this.isDraggingFov && this.dragStartOffsets && this.dragStartPx) {
            e.preventDefault();
            e.stopPropagation();
            const slice = this.nv.screenSlices?.[this.dragStartTileIndex];
            if (!slice?.leftTopWidthHeight || !slice?.fovMM) return;
            const rect = this.canvas.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            const currPx = [(e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr];
            const dxPx = currPx[0] - this.dragStartPx[0];
            const dyPx = currPx[1] - this.dragStartPx[1];
            const ltwh = slice.leftTopWidthHeight;
            const mmPerPxX = slice.fovMM[0] / Math.abs(ltwh[2]) || 0;
            const mmPerPxY = slice.fovMM[1] / Math.abs(ltwh[3]) || 0;
            let d0 = dxPx * mmPerPxX;
            let d1 = -dyPx * mmPerPxY;
            if (ltwh[2] < 0) d0 = -d0;
            let dx = 0, dy = 0, dz = 0;
            if (slice.axCorSag === 0) { dx = d0; dy = d1; }
            else if (slice.axCorSag === 1) { dx = d0; dz = d1; }
            else { dy = d0; dz = d1; }
            this.fovOffX.value = String((this.dragStartOffsets[0] + dx).toFixed(1));
            this.fovOffY.value = String((this.dragStartOffsets[1] + dy).toFixed(1));
            this.fovOffZ.value = String((this.dragStartOffsets[2] + dz).toFixed(1));
            this.rebuildFovLive();
         } else if (this.isRotatingFov) {
             e.preventDefault();
             e.stopPropagation();
             const currAngle = this.getMouseAngle(e);
             let deltaRad = currAngle - this.dragStartAngle;
             while (deltaRad <= -Math.PI) deltaRad += 2 * Math.PI;
             while (deltaRad > Math.PI) deltaRad -= 2 * Math.PI;
             let deltaDeg = deltaRad * (180 / Math.PI);
             if (e.shiftKey) deltaDeg *= 0.1;
             let finalRot = this.dragStartRotation - deltaDeg;
             const norm = (v) => {
                 let n = v % 360;
                 if (n > 180) n -= 360;
                 if (n < -180) n += 360;
                 return n;
             };
             const pane = this.fovRotateAxCorSag;
             if (pane === 0) this.fovRotZ.value = String(norm(finalRot).toFixed(1));
             else if (pane === 1) this.fovRotY.value = String(norm(finalRot).toFixed(1));
             else this.fovRotX.value = String(norm(finalRot).toFixed(1));
             this.rebuildFovLive();
         }
  }

  handleMouseUp() {
         if (this.isZooming2D) { 
            this.isZooming2D = false; 
            this.zoomStartPan = null;
            this.nv.opts.dragMode = this.savedDragMode;
            this.syncFovLabels(); 
         }
         if (this.isDraggingFov) { this.isDraggingFov = false; this.nv.opts.dragMode = this.savedDragMode;this.syncFovLabels(); }
         if (this.isRotatingFov) {
            this.isRotatingFov = false;
            this.fovRotateAxCorSag = null;
            this.nv.opts.dragMode = this.savedDragMode;
            this.syncFovLabels();
         }
  }

  handleWheel(e) {
          if (window.viewManager && window.viewManager.currentMode !== 'planning') {
              window.viewManager.setMode('planning');
          }

          if (e.ctrlKey) {
              e.preventDefault();
              e.stopPropagation();
              this.updateViewFromMouse(e);
              if (this.currentAxCorSag === null) return;
              const delta = e.deltaY > 0 ? -10 : 10; 
              let targetInput = null;
              if (this.currentAxCorSag === 0) targetInput = this.fovY;
              else if (this.currentAxCorSag === 1) targetInput = this.fovX;
              else if (this.currentAxCorSag === 2) targetInput = this.fovZ;
              if (targetInput) {
                  let newVal = Number(targetInput.value) + delta;
                  newVal = Math.max(Number(targetInput.min), Math.min(Number(targetInput.max), newVal));
                  targetInput.value = String(newVal);
                  this.rebuildFovLive();
              }
          }
  }

  updateViewFromMouse(e) {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const x = (e.clientX - rect.left) * dpr;
      const y = (e.clientY - rect.top) * dpr;
      for (let i = 0; i < this.nv.screenSlices.length; i++) {
          const s = this.nv.screenSlices[i];
          if (!s.leftTopWidthHeight) continue;
          const [L, T, W, H] = s.leftTopWidthHeight;
          if (x >= L && x <= (L + W) && y >= T && y <= (T + H)) {
              this.currentAxCorSag = s.axCorSag;
              return i;
          }
      }
      return -1;
  }

  /** 0=axial→Z rot, 1=coronal→Y, 2=sagittal→X; null if tile index invalid. */
  _paneFromScreenSliceTile(tileIndex) {
    if (tileIndex < 0) return null;
    const s = this.nv?.screenSlices?.[tileIndex];
    return typeof s?.axCorSag === "number" ? s.axCorSag : null;
  }

  getMouseMm(e, tileIndex = -1) {
      if (!this.nv.volumes?.length) return null;
      try {
          const rect = this.canvas.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          let frac;
          if (tileIndex >= 0) {
                 const dpr = window.devicePixelRatio || 1;
                 const sx = x * dpr;
                 const sy = y * dpr;
                 const slice = this.nv.screenSlices[tileIndex];
                 if (!slice || !slice.leftTopWidthHeight || slice.AxyzMxy.length < 4) return null;
                 const ltwh = slice.leftTopWidthHeight;
                 let fX = (sx - ltwh[0]) / ltwh[2];
                 const fY = 1.0 - (sy - ltwh[1]) / ltwh[3];
                 if (ltwh[2] < 0) fX = 1.0 - fX;
                 let xyzMM = [
                     slice.leftTopMM[0] + fX * slice.fovMM[0],
                     slice.leftTopMM[1] + fY * slice.fovMM[1],
                     0
                 ];
                 const v = slice.AxyzMxy;
                 xyzMM[2] = v[2] + v[4] * (xyzMM[1] - v[1]) - v[3] * (xyzMM[0] - v[0]);
                 let rasMM;
                 if (slice.axCorSag === 1) rasMM = [xyzMM[0], xyzMM[2], xyzMM[1]];
                 else if (slice.axCorSag === 2) rasMM = [xyzMM[2], xyzMM[0], xyzMM[1]];
                 else rasMM = xyzMM;
                 const vol = this.nv.volumes[0];
                 frac = vol.convertMM2Frac(rasMM, this.nv.opts.isSliceMM);
          } else {
                 frac = this.nv.canvasPos2frac([x, y]); 
          }
          if (!frac || (tileIndex < 0 && frac[0] < 0)) return null; 
          const { vol, dim3, affine } = this.getVolumeInfo();
          if (!dim3) return null;
          const vx = frac[0] * dim3[0];
          const vy = frac[1] * dim3[1];
          const vz = frac[2] * dim3[2];
          const vox2mm = this.voxToMmFactory(vol, affine);
          return vox2mm(vx, vy, vz);
      } catch(e) { return null; }
  }

  /** Returns FOV offsets [offX, offY, offZ] to center the FOV on the point under the mouse. */
  getOffsetsForCenterAtClick(e, tileIndex) {
      if (!this.nv.volumes?.length || tileIndex < 0) return null;
      try {
          // Compute world mm directly from mouse position and slice info
          const rect = this.canvas.getBoundingClientRect();
          const dpr = window.devicePixelRatio || 1;
          const sx = (e.clientX - rect.left) * dpr;
          const sy = (e.clientY - rect.top) * dpr;
          const slice = this.nv.screenSlices[tileIndex];
          if (!slice?.leftTopWidthHeight || !slice.AxyzMxy || slice.AxyzMxy.length < 5) {
              // Fallback to cached location
              if (this.lastLocationMm && this.lastLocationMm.length >= 3) {
                  const off = this.worldMmToFovOffset(this.lastLocationMm);
                  return off ?? [...this.lastLocationMm];
              }
              return null;
          }
          const ltwh = slice.leftTopWidthHeight;
          let fX = (sx - ltwh[0]) / ltwh[2];
          const fY = 1.0 - (sy - ltwh[1]) / ltwh[3];
          if (ltwh[2] < 0) fX = 1.0 - fX;
          let xyzMM = [
              slice.leftTopMM[0] + fX * slice.fovMM[0],
              slice.leftTopMM[1] + fY * slice.fovMM[1],
              0
          ];
          const v = slice.AxyzMxy;
          xyzMM[2] = v[2] + v[4] * (xyzMM[1] - v[1]) - v[3] * (xyzMM[0] - v[0]);
          let rasMM;
          if (slice.axCorSag === 1) rasMM = [xyzMM[0], xyzMM[2], xyzMM[1]];      // Coronal
          else if (slice.axCorSag === 2) rasMM = [xyzMM[2], xyzMM[0], xyzMM[1]]; // Sagittal
          else rasMM = xyzMM;                                                     // Axial

          const off = this.worldMmToFovOffset(rasMM);
          return off ?? rasMM;
      } catch (err) {
          console.warn("[FOV DEBUG] getOffsetsForCenterAtClick error:", err);
          return null;
      }
  }

  /** Map RAS world mm to this app's volume-relative FOV offset convention.
   *  Probes the same voxToMmFactory that getFovGeometry uses to stay perfectly self-consistent. */
  worldMmToFovOffset(rasMM) {
      const { vol, dim3, affine } = this.getVolumeInfo();
      if (!vol || !dim3 || !rasMM || rasMM.length < 3) return null;
      const [dx, dy, dz] = dim3;
      const spacing = this.voxelSpacingMm ?? [1, 1, 1];
      try {
          const vox2mm = this.voxToMmFactory(vol, affine);
          const o  = vox2mm(0, 0, 0);
          const ex = vox2mm(1, 0, 0);
          const ey = vox2mm(0, 1, 0);
          const ez = vox2mm(0, 0, 1);
          const a=ex[0]-o[0], b=ey[0]-o[0], c=ez[0]-o[0];
          const d=ex[1]-o[1], e=ey[1]-o[1], f=ez[1]-o[1];
          const g=ex[2]-o[2], h=ey[2]-o[2], k=ez[2]-o[2];
          const det = a*(e*k-f*h) - b*(d*k-f*g) + c*(d*h-e*g);
          if (Math.abs(det) < 1e-12) return null;
          const inv = 1 / det;
          const w = [rasMM[0]-o[0], rasMM[1]-o[1], rasMM[2]-o[2]];
          const vx = ((e*k-f*h)*w[0] + (c*h-b*k)*w[1] + (b*f-c*e)*w[2]) * inv;
          const vy = ((f*g-d*k)*w[0] + (a*k-c*g)*w[1] + (c*d-a*f)*w[2]) * inv;
          const vz = ((d*h-e*g)*w[0] + (b*g-a*h)*w[1] + (a*e-b*d)*w[2]) * inv;
          const cVx = (dx - 1) / 2, cVy = (dy - 1) / 2, cVz = (dz - 1) / 2;
          return [
              (vx - cVx) * spacing[0],
              (vy - cVy) * spacing[1],
              (vz - cVz) * spacing[2]
          ];
      } catch (_) {
          return null;
      }
  }

  getMouseAngle(e) {
      const frac = this.nv.scene.crosshairPos;
      const tileInfo = this.nv.frac2canvasPosWithTile(frac, this.currentAxCorSag);
      if (!tileInfo) return 0;
      const canvasPos = tileInfo.pos;
      const rect = this.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const pivotX = rect.left + (canvasPos[0] / dpr);
      const pivotY = rect.top + (canvasPos[1] / dpr);
      let angle = Math.atan2(e.clientY - pivotY, e.clientX - pivotX);
      if (this.currentAxCorSag === 1) angle = -angle;
      if (this.radiological.checked) {
          if (this.currentAxCorSag === 0 || this.currentAxCorSag === 1) angle = -angle;
      }
      return angle;
  }

  voxelToWorldFactory(affine) {
    if (typeof affine === "function") {
      return (x, y, z) => {
        const out = affine(x, y, z);
        return (Array.isArray(out) || ArrayBuffer.isView(out)) && out.length >= 3 ? [out[0], out[1], out[2]] : [x, y, z];
      };
    }
    if (Array.isArray(affine) || ArrayBuffer.isView(affine)) {
      if (affine.length >= 16) {
        const m = affine;
        const tCol = Math.hypot(m[12] ?? 0, m[13] ?? 0, m[14] ?? 0);
        const tRow = Math.hypot(m[3] ?? 0, m[7] ?? 0, m[11] ?? 0);
        if (tCol > tRow * 2) {
          return (x, y, z) => [ m[0]*x + m[4]*y + m[8]*z + m[12], m[1]*x + m[5]*y + m[9]*z + m[13], m[2]*x + m[6]*y + m[10]*z + m[14] ];
        }
        return (x, y, z) => [ m[0]*x + m[1]*y + m[2]*z + m[3], m[4]*x + m[5]*y + m[6]*z + m[7], m[8]*x + m[9]*y + m[10]*z + m[11] ];
      }
    }
    return (x, y, z) => [x, y, z];
  }

  worldToVoxelFactory(affine) {
    if (!affine || affine.length < 16) return (x, y, z) => [x, y, z];
    const m = affine;
    const tCol = Math.hypot(m[12] ?? 0, m[13] ?? 0, m[14] ?? 0);
    const tRow = Math.hypot(m[3] ?? 0, m[7] ?? 0, m[11] ?? 0);
    if (tCol > tRow * 2) {
      const r00 = m[0], r10 = m[1], r20 = m[2], r01 = m[4], r11 = m[5], r21 = m[6], r02 = m[8], r12 = m[9], r22 = m[10];
      const tx = m[12], ty = m[13], tz = m[14];
      const det = r00 * (r11 * r22 - r21 * r12) - r01 * (r10 * r22 - r20 * r12) + r02 * (r10 * r21 - r20 * r11);
      if (Math.abs(det) < 1e-12) return (x, y, z) => [x, y, z];
      const inv = 1 / det;
      const i00 = (r11 * r22 - r21 * r12) * inv, i10 = (r21 * r02 - r01 * r22) * inv, i20 = (r01 * r12 - r11 * r02) * inv;
      const i01 = (r20 * r12 - r10 * r22) * inv, i11 = (r00 * r22 - r20 * r02) * inv, i21 = (r10 * r02 - r00 * r12) * inv;
      const i02 = (r10 * r21 - r20 * r11) * inv, i12 = (r20 * r01 - r00 * r21) * inv, i22 = (r00 * r11 - r10 * r01) * inv;
      const ox = -(i00 * tx + i01 * ty + i02 * tz), oy = -(i10 * tx + i11 * ty + i12 * tz), oz = -(i20 * tx + i21 * ty + i22 * tz);
      return (x, y, z) => [i00 * x + i01 * y + i02 * z + ox, i10 * x + i11 * y + i12 * z + oy, i20 * x + i21 * y + i22 * z + oz];
    }
    const r00 = m[0], r01 = m[1], r02 = m[2], r10 = m[4], r11 = m[5], r12 = m[6], r20 = m[8], r21 = m[9], r22 = m[10];
    const tx = m[3], ty = m[7], tz = m[11];
    const det = r00 * (r11 * r22 - r21 * r12) - r01 * (r10 * r22 - r20 * r12) + r02 * (r10 * r21 - r20 * r11);
    if (Math.abs(det) < 1e-12) return (x, y, z) => [x, y, z];
    const inv = 1 / det;
    const i00 = (r11 * r22 - r21 * r12) * inv, i01 = (r21 * r02 - r01 * r22) * inv, i02 = (r01 * r12 - r11 * r02) * inv;
    const i10 = (r20 * r12 - r10 * r22) * inv, i11 = (r00 * r22 - r20 * r02) * inv, i12 = (r10 * r02 - r00 * r12) * inv;
    const i20 = (r10 * r21 - r20 * r11) * inv, i21 = (r20 * r01 - r00 * r21) * inv, i22 = (r00 * r11 - r10 * r01) * inv;
    const ox = -(i00 * tx + i10 * ty + i20 * tz), oy = -(i01 * tx + i11 * ty + i21 * tz), oz = -(i02 * tx + i12 * ty + i22 * tz);
    return (x, y, z) => [i00 * x + i10 * y + i20 * z + ox, i01 * x + i11 * y + i21 * z + oy, i02 * x + i12 * y + i22 * z + oz];
  }

  nii2fovbox(affine, dims) {
    if (!affine || !dims || dims.length < 3) return [];
    const [nx, ny, nz] = [Number(dims[0]), Number(dims[1]), Number(dims[2])];
    const vox2world = this.voxelToWorldFactory(affine);
    // Voxel **face** bounds in continuous index space (−½ … n−½), not voxel-center corners (0 … n−1).
    // Center-to-center edges underestimate extent by one voxel step → FOV sliders shrank after each sync.
    const corners = [
      [-0.5, -0.5, -0.5],
      [nx - 0.5, -0.5, -0.5],
      [-0.5, ny - 0.5, -0.5],
      [-0.5, -0.5, nz - 0.5],
      [nx - 0.5, ny - 0.5, -0.5],
      [nx - 0.5, -0.5, nz - 0.5],
      [-0.5, ny - 0.5, nz - 0.5],
      [nx - 0.5, ny - 0.5, nz - 0.5],
    ];
    return corners.map(([x, y, z]) => vox2world(x, y, z));
  }

  affineToFovParams(scanAffine, scanDims, refAffine, refDims, refSpacing) {
    if (!scanAffine || !scanDims || scanDims.length < 3 || !refAffine || !refDims || refDims.length < 3) return null;
    const [dx, dy, dz] = [Number(refDims[0]), Number(refDims[1]), Number(refDims[2])];
    const refCenter = [(dx - 1) / 2, (dy - 1) / 2, (dz - 1) / 2];
    const spacing = refSpacing && refSpacing.length >= 3 ? refSpacing : [1, 1, 1];
    const worldPts = this.nii2fovbox(scanAffine, scanDims);
    if (worldPts.length !== 8) return null;
    const world2vox = this.worldToVoxelFactory(refAffine);
    const voxPts = worldPts.map(p => world2vox(p[0], p[1], p[2]));
    const center = [0, 0, 0];
    for (const p of voxPts) { center[0] += p[0]; center[1] += p[1]; center[2] += p[2]; }
    center[0] /= 8; center[1] /= 8; center[2] /= 8;
    const e01 = [voxPts[1][0] - voxPts[0][0], voxPts[1][1] - voxPts[0][1], voxPts[1][2] - voxPts[0][2]];
    const e02 = [voxPts[2][0] - voxPts[0][0], voxPts[2][1] - voxPts[0][1], voxPts[2][2] - voxPts[0][2]];
    const e03 = [voxPts[3][0] - voxPts[0][0], voxPts[3][1] - voxPts[0][1], voxPts[3][2] - voxPts[0][2]];
    const len = (v) => Math.hypot(v[0], v[1], v[2]);
    const sizeVox = [len(e01), len(e02), len(e03)];
    const sizeMm = [sizeVox[0] * spacing[0], sizeVox[1] * spacing[1], sizeVox[2] * spacing[2]];
    const offsetVox = [center[0] - refCenter[0], center[1] - refCenter[1], center[2] - refCenter[2]];
    const offsetMm = [offsetVox[0] * spacing[0], offsetVox[1] * spacing[1], offsetVox[2] * spacing[2]];
    const ax = (v) => { const l = len(v); return l > 1e-6 ? [v[0] / l, v[1] / l, v[2] / l] : [1, 0, 0]; };
    const r0 = ax(e01), r1 = ax(e02), r2 = ax(e03);
    const R = [r0[0], r1[0], r2[0], r0[1], r1[1], r2[1], r0[2], r1[2], r2[2]];
    const sy = -R[2];
    const cy = Math.sqrt(1 - sy * sy) || 1e-6;
    const rotX = Math.atan2(R[5] / cy, R[8] / cy) * (180 / Math.PI);
    const rotY = Math.asin(Math.max(-1, Math.min(1, sy))) * (180 / Math.PI);
    const rotZ = Math.atan2(R[3] / cy, R[0] / cy) * (180 / Math.PI);
    return { sizeMm, offsetMm, rotationDeg: [-rotX, -rotY, rotZ] };
  }

  getVolumeInfo() {
    const vol = this.nv.volumes?.[0];
    const hdr = vol?.hdr ?? vol?.header ?? null;
    const dimRaw = hdr?.dims ?? hdr?.dim ?? vol?.dims ?? vol?.dim ?? null;
    let dim3 = null;
    if (Array.isArray(dimRaw)) {
      if (dimRaw.length >= 4) dim3 = [dimRaw[1], dimRaw[2], dimRaw[3]];
      else if (dimRaw.length === 3) dim3 = [dimRaw[0], dimRaw[1], dimRaw[2]];
    }
    let affine = hdr?.affine ?? vol?.affine ?? vol?.matRAS ?? vol?.mat?.affine ?? null;
    if (Array.isArray(affine) && affine.length < 16 && Array.isArray(affine[0])) {
      affine = [
        affine[0][0],affine[0][1],affine[0][2],affine[0][3],
        affine[1][0],affine[1][1],affine[1][2],affine[1][3],
        affine[2][0],affine[2][1],affine[2][2],affine[2][3],
        affine[3][0],affine[3][1],affine[3][2],affine[3][3]
      ];
    }
    return { vol, hdr, dim3, affine };
  }

  /**
   * Reference volume for mapping a scan NIfTI's bounding box into FOV slider space.
   * Prefer first non-scan (phantom) so SIM/CROP outputs align with planning grid; else volumes[0].
   */
  getReferenceVolumeInfoForFovSync() {
    const list = this.nv?.volumes;
    if (!list?.length) return null;
    const vol = list.find((v) => !(v.name && v.name.startsWith("scan_"))) ?? list[0];
    const hdr = vol?.hdr ?? vol?.header ?? null;
    const dimRaw = hdr?.dims ?? hdr?.dim ?? vol?.dims ?? vol?.dim ?? null;
    let dim3 = null;
    if (Array.isArray(dimRaw)) {
      if (dimRaw.length >= 4) dim3 = [dimRaw[1], dimRaw[2], dimRaw[3]];
      else if (dimRaw.length === 3) dim3 = [dimRaw[0], dimRaw[1], dimRaw[2]];
    }
    let affine = hdr?.affine ?? vol?.affine ?? vol?.matRAS ?? vol?.mat?.affine ?? null;
    if (Array.isArray(affine) && affine.length < 16 && Array.isArray(affine[0])) {
      affine = [
        affine[0][0], affine[0][1], affine[0][2], affine[0][3],
        affine[1][0], affine[1][1], affine[1][2], affine[1][3],
        affine[2][0], affine[2][1], affine[2][2], affine[2][3],
        affine[3][0], affine[3][1], affine[3][2], affine[3][3],
      ];
    }
    return { vol, hdr, dim3, affine };
  }

  /** First non-scan volume for CROP / resample source (not volumes[0] if a scan is loaded). */
  getPhantomVolumeForResample() {
    const list = this.nv?.volumes;
    if (!list?.length) return null;
    return list.find((v) => !(v.name && v.name.startsWith("scan_"))) ?? list[0];
  }

  _resampleSamplingOptions() {
    const mode = this.options.resampleSamplingMode ?? "footprint_mean";
    const maxSub = Math.max(1, Math.round(Number(this.options.resampleMaxSubsteps ?? 8)));
    return { mode, maxSub };
  }

  _volumeUsesSerial3DTo4D(vol) {
    const hdr = vol?.hdr ?? vol?.header;
    const dims = hdr?.dims ?? hdr?.dim ?? vol?.dims ?? [];
    return (
      this.options.resampleSerial3D !== false
      && (dims[0] || 3) >= 4
      && Number(dims[4] || 1) > 1
    );
  }

  /**
   * Run Pyodide resampling; expects source_bytes + reference_bytes globals set.
   * When not already inside enqueuePyodideTask, enqueues automatically.
   * @param {object} [opts]
   * @param {string} [opts.jobId]
   * @param {string} [opts.suffix] — disambiguate multiple volumes in one job (e.g. SIM)
   */
  async runPyodideResampling(vol, opts = {}) {
    const run = () => this._runPyodideResamplingCore(vol, opts);
    if (this._pyodideDrainDepth > 0) return run();
    const taskId = opts.jobId || `rs_${Date.now()}`;
    return this.enqueuePyodideTask(taskId, "resample", run);
  }

  async _runPyodideResamplingCore(vol, { jobId, suffix } = {}) {
    this._setResampleBusy(true);
    try {
      await this._ensureNibabelReady();
      this._setResamplePyodideOptions();
      const paths = this.resampleTempPaths(jobId, suffix);
      const { mode, maxSub } = this._resampleSamplingOptions();
      const useSerial3DTo4D = this._volumeUsesSerial3DTo4D(vol);
      const pyFn = useSerial3DTo4D ? "run_resampling_serial3d_to_4d" : "run_resampling";
      const jid = JSON.stringify(this.sanitizePyodideJobId(jobId));
      const suf = JSON.stringify(suffix || "");
      const py = `${pyFn}(source_bytes, reference_bytes, ${JSON.stringify(mode)}, ${maxSub}, out_path=${JSON.stringify(paths.outPath)}, job_id=${jid}, suffix=${suf})`;
      return await this.pyodide.runPythonAsync(py);
    } finally {
      this._setResampleBusy(false);
    }
  }

  /**
   * Set FOV sliders + mesh from a queue scan volume's qform/sform (same as clicking the scan row).
   * Call when selecting a scan from the queue so VIEW SCAN matches volume-list behavior.
   */
  syncFovFromScanVolume(vol) {
    if (!vol?.name?.startsWith("scan_")) return;
    const scanHdr = vol?.hdr ?? vol?.header ?? null;
    const scanAffine = scanHdr?.affine ?? vol?.affine ?? vol?.matRAS ?? null;
    const scanDimRaw = scanHdr?.dims ?? scanHdr?.dim ?? vol?.dims ?? vol?.dim ?? null;
    let scanDims = null;
    if (Array.isArray(scanDimRaw)) {
      if (scanDimRaw.length >= 4) scanDims = [scanDimRaw[1], scanDimRaw[2], scanDimRaw[3]];
      else if (scanDimRaw.length === 3) scanDims = scanDimRaw;
    }
    if (!scanAffine || !scanDims) return;
    this.applyFovFromAffine(scanAffine, scanDims);
  }

  /**
   * Set the FOV sliders + mesh from a NIfTI-style affine + matrix dims.
   * Reusable core of `syncFovFromScanVolume`: also used to restore a shared FOV
   * (recon-grid `fov_affine` + `fov_matrix`) via the same proven inverse
   * (`affineToFovParams`). Requires a reference (phantom) volume to be loaded.
   * @param {number[]|number[][]} affine 4×4 (flat 16 or nested 3×4/4×4) RAS+ affine.
   * @param {number[]} dims [nx, ny, nz] matrix of the affine's grid.
   * @returns {boolean} true when the sliders were updated.
   */
  applyFovFromAffine(affine, dims) {
    const ref = this.getReferenceVolumeInfoForFovSync();
    if (!ref?.vol || !ref?.dim3 || !ref?.affine) return false;
    if (!affine || !Array.isArray(dims) || dims.length < 3) return false;

    this.voxelSpacingMm = this.estimateVoxelSpacingMm(ref);

    // Niivue / NIfTI often use nz=0 for "2D" volumes; FOV box math needs a true 3D extent (singleton z=1).
    const nx = Math.max(1, Math.floor(Number(dims[0])) || 1);
    const ny = Math.max(1, Math.floor(Number(dims[1])) || 1);
    let nz = Math.floor(Number(dims[2]));
    if (!Number.isFinite(nz) || nz < 1) nz = 1;
    const gridDims = [nx, ny, nz];

    const flat = (a) =>
      Array.isArray(a) && a.length < 16 && Array.isArray(a[0])
        ? [
            a[0][0], a[0][1], a[0][2], a[0][3],
            a[1][0], a[1][1], a[1][2], a[1][3],
            a[2][0], a[2][1], a[2][2], a[2][3],
            (a[3]?.[0]) ?? 0, (a[3]?.[1]) ?? 0, (a[3]?.[2]) ?? 0, (a[3]?.[3]) ?? 1,
          ]
        : a;
    const params = this.affineToFovParams(flat(affine), gridDims, ref.affine, ref.dim3, this.voxelSpacingMm);
    if (params && this.fovX && this.fovOffX && this.fovRotX) {
      this.fovX.value = String(Math.round(params.sizeMm[0]));
      this.fovY.value = String(Math.round(params.sizeMm[1]));
      this.fovZ.value = String(Math.round(params.sizeMm[2]));
      this.fovOffX.value = String(Number(params.offsetMm[0]).toFixed(1));
      this.fovOffY.value = String(Number(params.offsetMm[1]).toFixed(1));
      this.fovOffZ.value = String(Number(params.offsetMm[2]).toFixed(1));
      this.fovRotX.value = String(Math.round(params.rotationDeg[0]));
      this.fovRotY.value = String(Math.round(params.rotationDeg[1]));
      this.fovRotZ.value = String(Math.round(params.rotationDeg[2]));
      if (this.showFov) this.showFov.checked = true;
      this.rebuildFovLive(true);
      return true;
    }
    return false;
  }

  /** Row-major flat 16 (4×4) from a 3×4 affine (`getResliceToFromFovSnapshot().affine`). */
  _flattenAffine3x4ToFlat16(affine3x4) {
    if (!Array.isArray(affine3x4) || affine3x4.length !== 3) {
      throw new Error('_flattenAffine3x4ToFlat16: expected 3×4 affine');
    }
    return [
      ...affine3x4[0],
      ...affine3x4[1],
      ...affine3x4[2],
      0, 0, 0, 1,
    ];
  }

  /**
   * UI-faithful, NON-oversampled FOV for sharing: the recon-grid affine + matrix.
   * `fov_affine` (flat 16) + `fov_matrix` ([nx,ny,nz]) round-trip through
   * `applyFovFromAffine` -> `affineToFovParams` to restore the FOV box.
   * @returns {{ fov_affine: number[], fov_matrix: number[] }|null}
   */
  getFovAffineShareMeta() {
    try {
      const snapshot = this.captureFovSnapshot();
      const reconMatrix = this.getReconMatrixDims();
      const reslice = this.getResliceToFromFovSnapshot(snapshot, reconMatrix);
      return {
        fov_affine: this._flattenAffine3x4ToFlat16(reslice.affine),
        fov_matrix: reslice.resolution,
      };
    } catch (_) {
      return null;
    }
  }

  /** Volume and dim3 to use for crosshair intensity: selected volume, or first visible, or [0]. */
  getVolumeForIntensity() {
    const list = this.nv?.volumes;
    if (!list?.length) return { vol: null, dim3: null };
    let vol = null;
    if (this.selectedVolume && list.includes(this.selectedVolume)) {
      vol = this.selectedVolume;
    } else {
      const visible = list.find((v) => v.opacity > 0);
      vol = visible ?? list[0];
    }
    const hdr = vol?.hdr ?? vol?.header ?? null;
    const dimRaw = hdr?.dims ?? hdr?.dim ?? vol?.dims ?? vol?.dim ?? null;
    let dim3 = null;
    if (Array.isArray(dimRaw)) {
      if (dimRaw.length >= 4) dim3 = [dimRaw[1], dimRaw[2], dimRaw[3]];
      else if (dimRaw.length === 3) dim3 = [dimRaw[0], dimRaw[1], dimRaw[2]];
    }
    return { vol, dim3 };
  }

  estimateVoxelSpacingMm({ vol, hdr, dim3, affine }) {
    const vox2world = this.voxelToWorldFactory(affine);
    const w000 = vox2world(0, 0, 0);
    const w100 = vox2world(1, 0, 0);
    const w010 = vox2world(0, 1, 0);
    const w001 = vox2world(0, 0, 1);
    if (!w000 || !w100 || !w010 || !w001) {
      const pix = hdr?.pixDims ?? vol?.pixDims ?? [1, 1, 1, 1];
      return [Number(pix[1]), Number(pix[2]), Number(pix[3])];
    }
    const sx = Math.hypot(w100[0]-w000[0], w100[1]-w000[1], w100[2]-w000[2]);
    const sy = Math.hypot(w010[0]-w000[0], w010[1]-w000[1], w010[2]-w000[2]);
    const sz = Math.hypot(w001[0]-w000[0], w001[1]-w000[1], w001[2]-w000[2]);
    return [sx || 1, sy || 1, sz || 1];
  }

  voxToMmFactory(vol, affine) {
    // Use affine-based transform - vol.vox2mm can have issues
    const affineTransform = this.voxelToWorldFactory(affine);
    if (typeof vol?.vox2mm === "function") {
      return (x, y, z) => {
        try {
          const out = vol.vox2mm([x, y, z]);
          if ((Array.isArray(out) || ArrayBuffer.isView(out)) && out.length >= 3) {
            return [Number(out[0]), Number(out[1]), Number(out[2])];
          }
        } catch (e) {
          // Fall through to affine transform
        }
        const w = affineTransform(x, y, z);
        return [Number(w[0]), Number(w[1]), Number(w[2])];
      };
    }
    return affineTransform;
  }

  getFovGeometry() {
    const { vol, dim3, affine } = this.getVolumeInfo();
    if (!vol || !dim3) throw new Error("No volume loaded.");
    const [dx, dy, dz] = dim3;
    const spacing = this.voxelSpacingMm ?? [1, 1, 1];
    const sxMm = spacing[0], syMm = spacing[1], szMm = spacing[2];
    const fovMmX = Number(this.fovX.value), fovMmY = Number(this.fovY.value), fovMmZ = Number(this.fovZ.value);
    const offMmX = Number(this.fovOffX.value), offMmY = Number(this.fovOffY.value), offMmZ = Number(this.fovOffZ.value);
    const rotX = Number(this.fovRotX.value), rotY = Number(this.fovRotY.value), rotZ = Number(this.fovRotZ.value);
    const cx = (dx-1)/2 + offMmX/sxMm;
    const cy = (dy-1)/2 + offMmY/syMm;
    const cz = (dz-1)/2 + offMmZ/szMm;
    const fovLenVoxX = fovMmX / sxMm, fovLenVoxY = fovMmY / syMm, fovLenVoxZ = fovMmZ / szMm;
    
    const toRad = (d) => (d * Math.PI) / 180;
    const rX = toRad(rotX), rY = toRad(rotY), rZ = toRad(rotZ);
    const cX = Math.cos(rX), sX = Math.sin(rX), cY = Math.cos(rY), sY = Math.sin(rY), cZ = Math.cos(rZ), sZ = Math.sin(rZ);

    const rotate = (p) => {
        let [x, y, z] = p;
        let y1 = y * cX - z * sX, z1 = y * sX + z * cX; y = y1; z = z1;
        let x2 = x * cY + z * sY, z2 = -x * sY + z * cY; x = x2; z = z2;
        let x3 = x * cZ - y * sZ, y3 = x * sZ + y * cZ; x = x3; y = y3;
        return [x, y, z];
    };
    
    const dxV = fovLenVoxX / 2, dyV = fovLenVoxY / 2, dzV = fovLenVoxZ / 2;
    const vox2mmDef = this.voxToMmFactory(vol, affine);
    const fovCenterWorldDef = vox2mmDef(cx, cy, cz);
    
    const vertsVox = [], tris = [];
    const addTube = (cMin, cMax) => {
         const vLocal = [ [cMin[0], cMin[1], cMin[2]], [cMax[0], cMin[1], cMin[2]], [cMax[0], cMax[1], cMin[2]], [cMin[0], cMax[1], cMin[2]], [cMin[0], cMin[1], cMax[2]], [cMax[0], cMin[1], cMax[2]], [cMax[0], cMax[1], cMax[2]], [cMin[0], cMax[1], cMax[2]] ];
         const base = vertsVox.length / 3;
         for (const p of vLocal) { const rot = rotate(p); vertsVox.push(rot[0] + cx, rot[1] + cy, rot[2] + cz); }
         const f = [ [0,1,2],[0,2,3], [4,6,5],[4,7,6], [0,4,5],[0,5,1], [3,2,6],[3,6,7], [0,3,7],[0,7,4], [1,5,6],[1,6,2] ];
         for (const t of f) tris.push(base + t[0], base + t[1], base + t[2]);
    };

    const x0 = -dxV, x1 = dxV, y0 = -dyV, y1 = dyV, z0 = -dzV, z1 = dzV;
    const ht = 0.375;
    addTube([x0, y0-ht, z0-ht], [x1, y0+ht, z0+ht]); addTube([x0, y1-ht, z0-ht], [x1, y1+ht, z0+ht]); addTube([x0, y0-ht, z1-ht], [x1, y0+ht, z1+ht]); addTube([x0, y1-ht, z1-ht], [x1, y1+ht, z1+ht]);
    addTube([x0-ht, y0, z0-ht], [x0+ht, y1, z0+ht]); addTube([x1-ht, y0, z0-ht], [x1+ht, y1, z0+ht]); addTube([x0-ht, y0, z1-ht], [x0+ht, y1, z1+ht]); addTube([x1-ht, y0, z1-ht], [x1+ht, y1, z1+ht]);
    addTube([x0-ht, y0-ht, z0], [x0+ht, y0+ht, z1]); addTube([x1-ht, y0-ht, z0], [x1+ht, y0+ht, z1]); addTube([x0-ht, y1-ht, z0], [x0+ht, y1+ht, z1]); addTube([x1-ht, y1-ht, z0], [x1+ht, y1+ht, z1]);
    const hct = 0.2;
    addTube([x0, y0-hct, -hct], [x1, y0+hct, hct]); addTube([x0, y1-hct, -hct], [x1, y1+hct, hct]); addTube([x0-hct, y0, -hct], [x0+hct, y1, hct]); addTube([x1-hct, y0, -hct], [x1+hct, y1, hct]);
    addTube([x0, -hct, -hct], [x1, hct, hct]); addTube([-hct, y0, -hct], [hct, y1, hct]);

    const vertsWorld = new Float32Array(vertsVox.length);
    for (let i = 0; i < vertsVox.length; i += 3) {
      const out = vox2mmDef(vertsVox[i], vertsVox[i+1], vertsVox[i+2]);
      vertsWorld[i] = out[0]; vertsWorld[i+1] = out[1]; vertsWorld[i+2] = out[2];
    }
    this.fovMeshData = { vertsWorld, tris: new Uint32Array(tris), centerWorld: fovCenterWorldDef, sizeMm: [fovMmX, fovMmY, fovMmZ], rotationDeg: [rotX, rotY, rotZ] };
    
    // Emit FOV change event
    eventHub.emit('fov_changed', {
        fov_x: fovMmX,
        fov_y: fovMmY,
        fov_z: fovMmZ,
        off_x: offMmX,
        off_y: offMmY,
        off_z: offMmZ,
        rot_x: rotX,
        rot_y: rotY,
        rot_z: rotZ
    });

    return this.fovMeshData;
  }

  updateFovMesh() {
     if (!this.showFov.checked || !this.nv.volumes?.length) { if (this.fovMesh) { this.nv.removeMesh(this.fovMesh); this.fovMesh = null; } return; }
     try {
        const geometry = this.getFovGeometry();
        if (!this.fovMesh) {
            this.fovMesh = new NVMesh(geometry.vertsWorld, geometry.tris, "FOV", this.FOV_RGBA255, 1.0, true, this.nv.gl);
            this.nv.addMesh(this.fovMesh);
        } else {
            this.fovMesh.pts = geometry.vertsWorld;
            if (typeof this.fovMesh.updateMesh === 'function') this.fovMesh.updateMesh(this.nv.gl);
        }
        this.nv.drawScene();
        this.updateDebugInfo();
     } catch(e) { console.error("FOV Update failed", e); }
  }

  requestFovUpdate() {
    if (this.fovUpdatePending) return;
    this.fovUpdatePending = true;
    requestAnimationFrame(() => { this.fovUpdatePending = false; this.updateFovMesh(); });
  }

  syncFovLabels() {
    if (!this.fovXVal) return;
    this.fovXVal.value = Math.round(Number(this.fovX.value)); this.fovYVal.value = Math.round(Number(this.fovY.value)); this.fovZVal.value = Math.round(Number(this.fovZ.value));
    this.fovOffXVal.value = Number(this.fovOffX.value).toFixed(1); this.fovOffYVal.value = Number(this.fovOffY.value).toFixed(1); this.fovOffZVal.value = Number(this.fovOffZ.value).toFixed(1);
    this.fovRotXVal.value = Math.round(Number(this.fovRotX.value)); this.fovRotYVal.value = Math.round(Number(this.fovRotY.value)); this.fovRotZVal.value = Math.round(Number(this.fovRotZ.value));
    this.maskXVal.value = Math.round(Number(this.maskX.value)); this.maskYVal.value = Math.round(Number(this.maskY.value)); this.maskZVal.value = Math.round(Number(this.maskZ.value));
    if (this.phantomXVal && this.phantomYVal && this.phantomZVal) {
      this.phantomXVal.value = Math.round(Number(this.phantomX.value));
      this.phantomYVal.value = Math.round(Number(this.phantomY.value));
      this.phantomZVal.value = Math.round(Number(this.phantomZ.value));
    }
    this.zoom2DVal.value = parseFloat(this.zoom2D.value).toFixed(2);
  }

  getReconMatrixDims() {
    return [
      Math.max(1, Math.round(Number(this.maskX?.value) || 1)),
      Math.max(1, Math.round(Number(this.maskY?.value) || 1)),
      Math.max(1, Math.round(Number(this.maskZ?.value) || 1)),
    ];
  }

  /** True when SIM pipeline should PyNUFFT-recon (default); false → log|k|-space NIfTI. */
  isScanReconEnabled() {
    return this.scanRecon?.checked !== false;
  }

  getPhantomMatrixDims() {
    return [
      Math.max(1, Math.round(Number(this.phantomX?.value) || 1)),
      Math.max(1, Math.round(Number(this.phantomY?.value) || 1)),
      Math.max(1, Math.round(Number(this.phantomZ?.value) || 1)),
    ];
  }

  /** Parse `[sx,sy,sz]` integer scale factors for sim phantom grid (default `[2,2,1]`). */
  parsePhantomOversampleFactors(raw) {
    const fallback = [2, 2, 1];
    const s = String(raw ?? "").trim();
    if (!s) return fallback;
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed) && parsed.length >= 3) {
        return parsed.slice(0, 3).map((v) => Math.max(1, Math.round(Number(v) || 1)));
      }
    } catch (_) { /* fall through */ }
    const m = s.match(/\[?\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]?/);
    if (m) return [m[1], m[2], m[3]].map((n) => Math.max(1, Math.round(Number(n))));
    return fallback;
  }

  getPhantomOversampleFactors() {
    return this.parsePhantomOversampleFactors(this.phantomOversampleInput?.value ?? "[2,2,1]");
  }

  /** Phantom matrix for SIM resampling (UI sliders × oversampling). */
  getSimPhantomMatrixDims(factors = null) {
    const f = factors ?? this.getPhantomOversampleFactors();
    const base = this.getPhantomMatrixDims();
    return base.map((d, i) => Math.max(1, Math.round(d * f[i])));
  }

  /**
   * UI-faithful scan-resolution bundle for sharing (mirrors the sliders, not the sequence):
   * `phantom_matrix` is the BASE phantom matrix, `phantom_oversample` the factors, and
   * `recon_matrix` the recon grid. The effective/oversampled grid is derived when needed.
   * @returns {{ phantom_matrix: number[], phantom_oversample: number[], recon_matrix: number[] }}
   */
  getScanResolutionShareMeta() {
    return {
      phantom_matrix: this.getPhantomMatrixDims(),
      phantom_oversample: this.getPhantomOversampleFactors(),
      recon_matrix: this.getReconMatrixDims(),
    };
  }

  /**
   * Apply a shared scan-resolution bundle to the sliders (base phantom matrix, oversample,
   * recon matrix). Missing fields are ignored. Updates labels + FOV mask via the usual sync.
   */
  applyScanResolutionSettings(meta) {
    if (!meta || typeof meta !== 'object') return;
    const setXYZ = (els, vals) => {
      if (!Array.isArray(vals) || vals.length < 3) return;
      els.forEach((el, i) => {
        if (el) el.value = String(Math.max(1, Math.round(Number(vals[i]) || 1)));
      });
    };
    setXYZ([this.phantomX, this.phantomY, this.phantomZ], meta.phantom_matrix);
    setXYZ([this.maskX, this.maskY, this.maskZ], meta.recon_matrix);
    if (meta.phantom_oversample && this.phantomOversampleInput) {
      const f = this.parsePhantomOversampleFactors(
        Array.isArray(meta.phantom_oversample) ? JSON.stringify(meta.phantom_oversample) : meta.phantom_oversample,
      );
      this.phantomOversampleInput.value = JSON.stringify(f);
    }
    this.syncFovLabels();
    this.rebuildFovLive(true);
  }

  /** Scale frozen FOV mm box for sim phantom ref; recon keeps the UI snapshot. */
  applyPhantomOversampleToSnapshot(snapshot, factors = null) {
    const f = factors ?? this.getPhantomOversampleFactors();
    if (!snapshot?.centerWorld || !snapshot?.sizeMm || !snapshot?.rotationDeg) {
      throw new Error("applyPhantomOversampleToSnapshot: invalid snapshot");
    }
    if (f[0] === 1 && f[1] === 1 && f[2] === 1) return snapshot;
    return {
      centerWorld: [...snapshot.centerWorld],
      sizeMm: snapshot.sizeMm.map((s, i) => Number(s) * f[i]),
      rotationDeg: [...snapshot.rotationDeg],
    };
  }

  rebuildFovLive(forceSync = false) {
    if (forceSync) this.syncFovLabels();
    if (this.showFov && this.showFov.checked && this.nv.volumes?.length) this.requestFovUpdate();
    this.updateDebugInfo();
  }

  updateDebugInfo() {
    if (!this.debugInfo) return;
    try {
      const { vol, dim3, affine } = this.getVolumeInfo();
      if (!vol || !dim3) { this.debugInfo.textContent = "No volume loaded"; return; }
      const [dx, dy, dz] = dim3;
      const sp = this.voxelSpacingMm ?? [1, 1, 1];
      const f = (v) => v != null ? v.map(n => Number(n).toFixed(1)).join(', ') : '—';
      const f2 = (v) => v != null ? v.map(n => Number(n).toFixed(2)).join(', ') : '—';

      // vox2mm used by getFovGeometry (may prefer vol.vox2mm over hdr.affine)
      const v2mm = this.voxToMmFactory(vol, affine);
      const niiOrigin = v2mm(0, 0, 0);
      const niiCenter = v2mm((dx-1)/2, (dy-1)/2, (dz-1)/2);

      // hdr.affine translation (raw NIfTI origin)
      const hdr = vol?.hdr ?? vol?.header;
      let hdrTrans = null;
      if (hdr?.affine) {
        const a = hdr.affine;
        hdrTrans = Array.isArray(a[0]) ? [a[0][3], a[1][3], a[2][3]] : (a.length >= 16 ? [a[3], a[7], a[11]] : null);
      }

      // matRAS translation (Niivue internal, typically stripped)
      let matRASTrans = null;
      if (vol.matRAS && vol.matRAS.length >= 16) {
        const m = vol.matRAS;
        matRASTrans = [m[3], m[7], m[11]];
      }

      // Niivue display-space: probe vol.vox2mm directly if available
      let nvOrigin = null, nvCenter = null;
      if (typeof vol.vox2mm === 'function') {
        try {
          const o = vol.vox2mm([0, 0, 0]);
          if (o?.length >= 3) nvOrigin = [o[0], o[1], o[2]];
          const c = vol.vox2mm([(dx-1)/2, (dy-1)/2, (dz-1)/2]);
          if (c?.length >= 3) nvCenter = [c[0], c[1], c[2]];
        } catch(_) {}
      }

      // FOV state
      const fovCenter = this.fovMeshData?.centerWorld;
      const fovSize = [this.fovX?.value, this.fovY?.value, this.fovZ?.value].map(Number);
      const fovOff = [this.fovOffX?.value, this.fovOffY?.value, this.fovOffZ?.value].map(Number);
      const fovRot = [this.fovRotX?.value, this.fovRotY?.value, this.fovRotZ?.value].map(Number);

      // Cursor
      const curMm = this.lastLocationMm;
      const curVox = this.lastLocationVox;

      const lines = [
        `── Volume ──`,
        `Dims:        ${dx}×${dy}×${dz}`,
        `Spacing:     ${sp.map(s=>s.toFixed(2)).join(', ')}`,
        `hdr.affine t:${hdrTrans ? ' '+f(hdrTrans) : ' —'}`,
        `matRAS t:    ${matRASTrans ? f2(matRASTrans) : '—'}`,
        `vox2mm(0):   ${nvOrigin ? f(nvOrigin) : f(niiOrigin)}${nvOrigin ? ' (vol)' : ' (aff)'}`,
        `vox2mm(ctr): ${nvCenter ? f(nvCenter) : f(niiCenter)}${nvCenter ? ' (vol)' : ' (aff)'}`,
        `── FOV ──`,
        `Size:        ${f(fovSize)} mm`,
        `Offset:      ${f(fovOff)} mm`,
        `Rotation:    ${f(fovRot)}°`,
        `Center world:${fovCenter ? ' '+f(fovCenter) : ' —'}`,
        `── Cursor ──`,
        `mm:          ${f(curMm)}`,
        `vox:         ${f(curVox)}`,
      ];
      this.debugInfo.textContent = lines.join('\n');
    } catch (_) {
      this.debugInfo.textContent = "debug info error";
    }
  }

  bindBiDirectional(slider, numInput, callback) {
    if (!slider || !numInput) return;
    slider.addEventListener("input", () => { numInput.value = slider.value; if (callback) callback(); });
    numInput.addEventListener("input", () => { if (numInput.value !== "") { slider.value = numInput.value; if (callback) callback(); } });
  }

  /**
   * Snapshot the current FOV geometry as a JSON-serializable object (pure read, no side effects).
   * Used by the SIM pipeline to freeze FOV placement at scan-start so subsequent slider changes
   * (user input, `syncFovFromScanVolume`, `applySequenceFovDimensions` during a later scan) cannot
   * misalign the phantom resample and recon reference of an in-flight job.
   * `centerWorld` is absolute RAS mm and therefore independent of which volume is later selected.
   */
  captureFovSnapshot() {
    const { vol, dim3, affine } = this.getVolumeInfo();
    if (!vol || !dim3) throw new Error("captureFovSnapshot: no volume loaded.");
    const [dx, dy, dz] = dim3;
    const spacing = this.voxelSpacingMm ?? [1, 1, 1];
    const sxMm = spacing[0], syMm = spacing[1], szMm = spacing[2];
    const fovMmX = Number(this.fovX.value), fovMmY = Number(this.fovY.value), fovMmZ = Number(this.fovZ.value);
    const offMmX = Number(this.fovOffX.value), offMmY = Number(this.fovOffY.value), offMmZ = Number(this.fovOffZ.value);
    const rotX = Number(this.fovRotX.value), rotY = Number(this.fovRotY.value), rotZ = Number(this.fovRotZ.value);
    const cx = (dx-1)/2 + offMmX/sxMm;
    const cy = (dy-1)/2 + offMmY/syMm;
    const cz = (dz-1)/2 + offMmZ/szMm;
    const vox2mmDef = this.voxToMmFactory(vol, affine);
    const centerWorld = vox2mmDef(cx, cy, cz);
    return {
      centerWorld: [Number(centerWorld[0]), Number(centerWorld[1]), Number(centerWorld[2])],
      sizeMm: [fovMmX, fovMmY, fovMmZ],
      rotationDeg: [rotX, rotY, rotZ],
    };
  }

  /**
   * Build a binary FOV mask NIfTI directly from a captured snapshot (no slider / volume reads).
   * Shared core of `generateFovMaskNifti`; lets the SIM pipeline produce phantom and recon refs
   * at different matrix resolutions from the same frozen geometry.
   */
  generateFovMaskNiftiFromSnapshot(snapshot, matrixDims = null) {
    if (!snapshot || !snapshot.centerWorld || !snapshot.sizeMm || !snapshot.rotationDeg) {
      throw new Error("generateFovMaskNiftiFromSnapshot: invalid snapshot");
    }
    const fovCenterWorld = snapshot.centerWorld;
    const fovSizeMm = snapshot.sizeMm;
    const fovRotDeg = snapshot.rotationDeg;
    const mDims = Array.isArray(matrixDims) && matrixDims.length >= 3
      ? [
          Math.max(1, Math.round(Number(matrixDims[0]) || 1)),
          Math.max(1, Math.round(Number(matrixDims[1]) || 1)),
          Math.max(1, Math.round(Number(matrixDims[2]) || 1)),
        ]
      : this.getReconMatrixDims();
    const vSpacing = [fovSizeMm[0]/mDims[0], fovSizeMm[1]/mDims[1], fovSizeMm[2]/mDims[2]];
    const toRad = (d) => (d * Math.PI) / 180;
    const rX = toRad(fovRotDeg[0]), rY = toRad(fovRotDeg[1]), rZ = toRad(fovRotDeg[2]);
    const cX = Math.cos(rX), sX = Math.sin(rX), cY = Math.cos(rY), sY = Math.sin(rY), cZ = Math.cos(rZ), sZ = Math.sin(rZ);
    const R = [ [cZ*cY, cZ*sY*sX-sZ*cX, cZ*sY*cX+sZ*sX], [sZ*cY, sZ*sY*sX+cZ*cX, sZ*sY*cX-cZ*sX], [-sY, cY*sX, cY*cX] ];
    const h = [fovSizeMm[0]/2, fovSizeMm[1]/2, fovSizeMm[2]/2];
    const local_0 = [-h[0]+vSpacing[0]/2, -h[1]+vSpacing[1]/2, -h[2]+vSpacing[2]/2];
    const rasOrigin = [ R[0][0]*local_0[0]+R[0][1]*local_0[1]+R[0][2]*local_0[2]+fovCenterWorld[0], R[1][0]*local_0[0]+R[1][1]*local_0[1]+R[1][2]*local_0[2]+fovCenterWorld[1], R[2][0]*local_0[0]+R[2][1]*local_0[1]+R[2][2]*local_0[2]+fovCenterWorld[2] ];
    const affineRow = [ R[0][0]*vSpacing[0], R[0][1]*vSpacing[1], R[0][2]*vSpacing[2], rasOrigin[0], R[1][0]*vSpacing[0], R[1][1]*vSpacing[1], R[1][2]*vSpacing[2], rasOrigin[1], R[2][0]*vSpacing[0], R[2][1]*vSpacing[1], R[2][2]*vSpacing[2], rasOrigin[2], 0, 0, 0, 1 ];
    const maskData = new Uint8Array(mDims[0]*mDims[1]*mDims[2]).fill(1);
    let niftiBytes = NVImage.createNiftiArray(mDims, vSpacing, affineRow, 2, maskData);
    return this.setNiftiQform(niftiBytes, affineRow, 2);
  }

  /**
   * Bifti ``reslice_to`` grid matching `generateFovMaskNiftiFromSnapshot` (mm, RAS+).
   * @returns {{ resolution: [number, number, number], affine: number[][] }}
   */
  getResliceToFromFovSnapshot(snapshot, matrixDims = null) {
    if (!snapshot || !snapshot.centerWorld || !snapshot.sizeMm || !snapshot.rotationDeg) {
      throw new Error("getResliceToFromFovSnapshot: invalid snapshot");
    }
    const fovCenterWorld = snapshot.centerWorld;
    const fovSizeMm = snapshot.sizeMm;
    const fovRotDeg = snapshot.rotationDeg;
    const mDims = Array.isArray(matrixDims) && matrixDims.length >= 3
      ? [
          Math.max(1, Math.round(Number(matrixDims[0]) || 1)),
          Math.max(1, Math.round(Number(matrixDims[1]) || 1)),
          Math.max(1, Math.round(Number(matrixDims[2]) || 1)),
        ]
      : this.getReconMatrixDims();
    const vSpacing = [fovSizeMm[0] / mDims[0], fovSizeMm[1] / mDims[1], fovSizeMm[2] / mDims[2]];
    const toRad = (d) => (d * Math.PI) / 180;
    const rX = toRad(fovRotDeg[0]), rY = toRad(fovRotDeg[1]), rZ = toRad(fovRotDeg[2]);
    const cX = Math.cos(rX), sX = Math.sin(rX), cY = Math.cos(rY), sY = Math.sin(rY), cZ = Math.cos(rZ), sZ = Math.sin(rZ);
    const R = [
      [cZ * cY, cZ * sY * sX - sZ * cX, cZ * sY * cX + sZ * sX],
      [sZ * cY, sZ * sY * sX + cZ * cX, sZ * sY * cX - cZ * sX],
      [-sY, cY * sX, cY * cX],
    ];
    const h = [fovSizeMm[0] / 2, fovSizeMm[1] / 2, fovSizeMm[2] / 2];
    const local_0 = [-h[0] + vSpacing[0] / 2, -h[1] + vSpacing[1] / 2, -h[2] + vSpacing[2] / 2];
    const rasOrigin = [
      R[0][0] * local_0[0] + R[0][1] * local_0[1] + R[0][2] * local_0[2] + fovCenterWorld[0],
      R[1][0] * local_0[0] + R[1][1] * local_0[1] + R[1][2] * local_0[2] + fovCenterWorld[1],
      R[2][0] * local_0[0] + R[2][1] * local_0[1] + R[2][2] * local_0[2] + fovCenterWorld[2],
    ];
    return {
      resolution: [mDims[0], mDims[1], mDims[2]],
      affine: [
        [R[0][0] * vSpacing[0], R[0][1] * vSpacing[1], R[0][2] * vSpacing[2], rasOrigin[0]],
        [R[1][0] * vSpacing[0], R[1][1] * vSpacing[1], R[1][2] * vSpacing[2], rasOrigin[1]],
        [R[2][0] * vSpacing[0], R[2][1] * vSpacing[1], R[2][2] * vSpacing[2], rasOrigin[2]],
      ],
    };
  }

  /**
   * Binary mask NIfTI for the current FOV box + chosen grid.
   * Goes through `getFovGeometry()` (which also refreshes the 3D FOV mesh data and emits
   * `fov_changed`) to preserve the side effects legacy callers expect, then delegates to
   * `generateFovMaskNiftiFromSnapshot`.
   */
  generateFovMaskNifti(matrixDims = null) {
    const geometry = this.getFovGeometry();
    const snapshot = {
      centerWorld: [geometry.centerWorld[0], geometry.centerWorld[1], geometry.centerWorld[2]],
      sizeMm: [geometry.sizeMm[0], geometry.sizeMm[1], geometry.sizeMm[2]],
      rotationDeg: [geometry.rotationDeg[0], geometry.rotationDeg[1], geometry.rotationDeg[2]],
    };
    return this.generateFovMaskNiftiFromSnapshot(snapshot, matrixDims);
  }

  getVolumeNifti(vol) {
    const hdr = vol.hdr ?? vol.header;
    const dims = hdr?.dims ?? hdr?.dim ?? vol.dims ?? [0,0,0,0];
    const rank = dims[0] || 3;
    const niftiDims = []; for (let i=1; i<=rank; i++) niftiDims.push(dims[i]);
    const pixDims = hdr?.pixDims ?? hdr?.pixDim ?? vol.pixDims ?? [1,1,1,1];
    let affineRow = null;
    if (hdr?.affine) {
        const a = hdr.affine;
        if (Array.isArray(a)) affineRow = a.length === 16 ? [...a] : [a[0][0],a[0][1],a[0][2],a[0][3], a[1][0],a[1][1],a[1][2],a[1][3], a[2][0],a[2][1],a[2][2],a[2][3], a[3][0],a[3][1],a[3][2],a[3][3]];
    }
    if (!affineRow) affineRow = this.affineColToRowMajor(vol.matRAS);
    const sx = Math.hypot(affineRow[0], affineRow[4], affineRow[8]), sy = Math.hypot(affineRow[1], affineRow[5], affineRow[9]), sz = Math.hypot(affineRow[2], affineRow[6], affineRow[10]);
    const finalPixDims = [sx, sy, sz]; for (let i=4; i<=rank; i++) finalPixDims.push(pixDims[i] || 1.0);
    let niftiBytes = NVImage.createNiftiArray(niftiDims, finalPixDims, affineRow, hdr?.datatypeCode ?? 16, vol.img);
    return this.setNiftiQform(niftiBytes, affineRow, 2);
  }

  async downloadVolume(vol) {
    try {
      let bytes = this.getVolumeNifti(vol);
      const fname = vol.name || "volume.nii";
      const useGz = fname.endsWith(".gz");
      if (useGz) {
        const blob = new Blob([bytes]);
        const stream = blob.stream().pipeThrough(new CompressionStream("gzip"));
        bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      }
      const downloadName = useGz ? fname : fname + (fname.endsWith(".nii") ? "" : ".nii");
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
      const a = document.createElement("a"); a.href = url; a.download = downloadName;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) { console.error(e);}
  }

  async downloadGroupAsZip(group) {
    try {
      const folderName = group.jsonName;
      const JSZip = (await import("https://esm.run/jszip@3.10.1")).default;
      const zip = new JSZip();
      const subfolder = zip.folder(folderName);
      if (group.jsonContent && group.jsonFileName) {
        subfolder.file(group.jsonFileName, group.jsonContent);
      }
      for (const vol of group.volumes) {
        let bytes = this.getVolumeNifti(vol);
        const fname = vol.name || "volume.nii";
        if (fname.endsWith(".gz")) {
          const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
          bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        }
        subfolder.file(fname, bytes);
      }
      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `${folderName}.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      console.error(e);
      if (group.jsonContent && group.jsonFileName) {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([group.jsonContent]));
        a.download = group.jsonFileName;
        a.click();
      }
      group.volumes.forEach(v => this.downloadVolume(v));
    }
  }

  handleDownloadFovMesh() {
    try {
      if (!this.fovMeshData) {return; }
      const geometry = this.fovMeshData;
      const downloadTextFile = (name, text) => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text])); a.download = name; a.click(); };
      const toStl = (v, t) => {
          let lines = [`solid fov`];
          const normal = (a, b, c) => { const ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2],nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx,len=Math.hypot(nx,ny,nz)||1; return [nx/len,ny/len,nz/len]; };
          for (let i=0; i<t.length; i+=3) { const a=[v[t[i]*3],v[t[i]*3+1],v[t[i]*3+2]],b=[v[t[i+1]*3],v[t[i+1]*3+1],v[t[i+1]*3+2]],c=[v[t[i+2]*3],v[t[i+2]*3+1],v[t[i+2]*3+2]],n=normal(a,b,c); lines.push(`facet normal ${n[0]} ${n[1]} ${n[2]}`,` outer loop`,`  vertex ${a[0]} ${a[1]} ${a[2]}`,`  vertex ${b[0]} ${b[1]} ${b[2]}`,`  vertex ${c[0]} ${c[1]} ${c[2]}`,` endloop`,`endfacet`); }
          lines.push(`endsolid fov`); return lines.join("\n");
      };
      downloadTextFile("fov-box-ras.stl", toStl(geometry.vertsWorld, geometry.tris));
      const vLps = new Float32Array(geometry.vertsWorld); for(let i=0;i<vLps.length;i+=3){ vLps[i]=-vLps[i]; vLps[i+1]=-vLps[i+1]; }
      downloadTextFile("fov-box-lps.stl", toStl(vLps, geometry.tris));
      const maskBytes = this.generateFovMaskNifti(this.getPhantomMatrixDims());
      const maskUrl = URL.createObjectURL(new Blob([maskBytes]));
      const maskLink = document.createElement("a"); maskLink.href = maskUrl; maskLink.download = "fov-mask.nii"; maskLink.click();
      if (this.nv.volumes?.length) setTimeout(() => this.downloadVolume(this.nv.volumes[0]), 300);
    } catch (e) { console.error(e);}
  }

  /** NIfTI-1 magic at byte offset 344 should be `n+1` + NUL (0x6E 0x2B 0x31 0x00). */
  _niftiMagicAt344(u8) {
    try {
      if (!u8 || u8.byteLength < 348) {
        return { ok: false, reason: u8 ? "too_short" : "missing", len: u8?.byteLength ?? 0 };
      }
      const a = u8[344], b = u8[345], c = u8[346], d = u8[347];
      const ascii = String.fromCharCode(a, b, c);
      const ok = ascii === "n+1" && d === 0;
      return { ok, at344: [a, b, c, d], ascii: ok ? "n+1\\0" : `${ascii}\\x${d.toString(16)}` };
    } catch (e) {
      return { ok: false, reason: "error", error: String(e) };
    }
  }

  /**
   * Console diagnostics for Resample to FOV (phantom-dependent failures).
   * @param {"reference"|"source"|"output"} kind
   */
  _logResampleToFov(kind, label, details) {
    if (this.options.debugResampleToFov !== true) return;
    console.log(`[resampleToFov] ${kind} ${label}`, details);
  }

  /** Push resample options into Pyodide globals for data/resampling.py. */
  _setResamplePyodideOptions() {
    if (!this.pyodide) return;
    const { mode, maxSub } = this._resampleSamplingOptions();
    this.pyodide.globals.set("resample_sampling_mode", mode);
    this.pyodide.globals.set("resample_max_substeps", maxSub);
  }

  async handleResampleToFov() {
    if (!this.pyodide || !this.nv.volumes?.length) return;
    const taskId = `resample-fov-${Date.now()}`;
    try {
      const debugResample = this.options.debugResampleToFov === true;
      this.resampleToFovBtn.disabled = true;
      await this.enqueuePyodideTask(taskId, "resample-fov", async () => {
      this._setResamplePyodideOptions();
      const ref = this.generateFovMaskNifti(this.getPhantomMatrixDims());
      this.pyodide.globals.set("reference_bytes", ref);
      if (debugResample) {
        this._logResampleToFov("reference", "FoV mask", {
          byteLength: ref?.byteLength,
          magic344: this._niftiMagicAt344(ref),
        });
      }

      if (this.volumeGroups?.length > 0) {
        const newGroups = [];
        for (let gi = 0; gi < this.volumeGroups.length; gi++) {
          const group = this.volumeGroups[gi];
          const newVolumes = [];
          const pdIdx = group.volumes.findIndex(v => /_PD\.nii(\.gz)?$/i.test(v?.name || ""));
          const defaultVisibleIdx = pdIdx >= 0 ? pdIdx : 0;
          for (let i = 0; i < group.volumes.length; i++) {
            const vol = group.volumes[i];
            const volName = vol.name || "vol";
            const hdr = vol.hdr ?? vol.header;
            const dims = hdr?.dims ?? hdr?.dim ?? vol.dims ?? [];
            const useSerial3DTo4D = (this.options.resampleSerial3D !== false && (dims[0] || 3) >= 4 && Number(dims[4] || 1) > 1);
            const nFrames = useSerial3DTo4D
              ? Number(dims[4] || 1)
              : 1;
            const src = this.getVolumeNifti(vol);
            if (debugResample) {
              const img = vol.img;
              const imgLen = img?.length ?? img?.byteLength ?? null;
              this._logResampleToFov("source", `${volName}${useSerial3DTo4D ? " [serial3d->4d]" : ""}`, {
                group: group.jsonName,
                index: i,
                dims: dims ? Array.from(dims) : null,
                datatypeCode: hdr?.datatypeCode,
                imgType: img?.constructor?.name,
                imgLen,
                srcByteLength: src?.byteLength,
                srcMagic344: this._niftiMagicAt344(src),
              });
            }
            this.pyodide.globals.set("source_bytes", src);
            const res = await this.runPyodideResampling(vol, { jobId: taskId, suffix: `g${gi}v${i}` });
              const { outPath, bytes: outU8 } = this.readResampleOutputPath(res);
              const outMagic = this._niftiMagicAt344(outU8);
              if (debugResample) {
                this._logResampleToFov("output", `${volName}${useSerial3DTo4D ? " [serial3d->4d]" : ""}`, {
                  group: group.jsonName,
                  outType: outU8?.constructor?.name,
                  outPath,
                  outByteLength: outU8?.byteLength,
                  outMagic344: outMagic,
                });
              }
              if (!outMagic.ok) {
                throw new Error(`Resample output is not valid NIfTI for ${volName} (path: ${outPath})`);
              }
              const url = URL.createObjectURL(new Blob([outU8]));
              const name = volName;
              const visible = i === defaultVisibleIdx;
              const added = await this.nv.addVolumesFromUrl([{
                url, name, colormap: "gray", opacity: visible ? 1.0 : 0
              }]);
              if (added?.length) newVolumes.push(added[0]);
              setTimeout(() => URL.revokeObjectURL(url), 30000);
          }
          const groupId = "g-" + Math.random().toString(36).substr(2, 9);
          const folderName = group.jsonName + "_resampled";
          newGroups.push({
            id: groupId,
            jsonName: folderName,
            volumes: newVolumes,
            jsonContent: group.jsonContent,
            jsonFileName: group.jsonFileName || group.jsonName + ".json"
          });
        }
        this.volumeGroups.push(...newGroups);
      } else {
        const vol = this.nv.volumes[0];
        const volName = vol.name || "vol";
        const hdr = vol.hdr ?? vol.header;
        const dims = hdr?.dims ?? hdr?.dim ?? vol.dims ?? [];
        const useSerial3DTo4D = (this.options.resampleSerial3D !== false && (dims[0] || 3) >= 4 && Number(dims[4] || 1) > 1);
        const nFrames = useSerial3DTo4D
          ? Number(dims[4] || 1)
          : 1;
        const src = this.getVolumeNifti(vol);
        if (debugResample) {
          const img = vol.img;
          const imgLen = img?.length ?? img?.byteLength ?? null;
          this._logResampleToFov("source", `${volName}${useSerial3DTo4D ? " [serial3d->4d]" : ""}`, {
            dims: dims ? Array.from(dims) : null,
            datatypeCode: hdr?.datatypeCode,
            imgType: img?.constructor?.name,
            imgLen,
            srcByteLength: src?.byteLength,
            srcMagic344: this._niftiMagicAt344(src),
          });
        }
        this.pyodide.globals.set("source_bytes", src);
        const res = await this.runPyodideResampling(vol, { jobId: taskId, suffix: "v0" });
          const { outPath, bytes: outU8 } = this.readResampleOutputPath(res);
          const outMagic = this._niftiMagicAt344(outU8);
          if (debugResample) {
            this._logResampleToFov("output", `${volName}${useSerial3DTo4D ? " [serial3d->4d]" : ""}`, {
              outType: outU8?.constructor?.name,
              outPath,
              outByteLength: outU8?.byteLength,
              outMagic344: outMagic,
            });
          }
          if (!outMagic.ok) {
            throw new Error(`Resample output is not valid NIfTI for ${volName} (path: ${outPath})`);
          }
          const url = URL.createObjectURL(new Blob([outU8]));
          const name = (vol.name || "vol").replace(/\.nii(\.gz)?$/, "") + "_resampled.nii";
          const opacity = 1.0;
          await this.nv.addVolumesFromUrl([{ url, name, colormap: "gray", opacity }]);
          setTimeout(() => URL.revokeObjectURL(url), 30000);
      }
      });
      this.updateVolumeList();
      this.triggerHighlight();
    } catch (e) { console.error(e);} finally { this.resampleToFovBtn.disabled = false; }
  }

  /** Let the phantom list grow when a group is expanded so sub-phantoms are not clipped. */
  _syncPhantomVolumeListHeight() {
    const el = this.phantomVolumeListContainer;
    if (!el) return;
    if (this.expandedGroups.size > 0) {
      el.style.maxHeight = "none";
      el.style.overflowY = "visible";
    } else {
      el.style.maxHeight = "90px";
      el.style.overflowY = "auto";
    }
  }

  updateVolumeList() {
    const scanEl = this.scanVolumeListContainer;
    const phantomEl = this.phantomVolumeListContainer;
    if (!scanEl && !phantomEl) return;
    if (scanEl) scanEl.innerHTML = "";
    if (phantomEl) phantomEl.innerHTML = "";
    const volSet = new Set(this.nv.volumes);
    this.volumeGroups = this.volumeGroups.filter(g => {
      g.volumes = g.volumes.filter(v => volSet.has(v));
      return g.volumes.length > 0;
    });
    const groupVolSet = new Set();
    this.volumeGroups.forEach(g => g.volumes.forEach(v => groupVolSet.add(v)));
    const phantoms = [];
    const scans = [];
    this.nv.volumes.forEach((vol, index) => {
      if (vol.name && vol.name.startsWith('scan_')) {
        scans.push({ vol, index });
      } else if (!groupVolSet.has(vol)) {
        phantoms.push({ vol, index });
      }
    });

    const createRow = (vol, originalIndex, opts = {}) => {
      const { noDownload, noRemove, noCheckbox, noMeta, shortTitle } = opts;
      const row = document.createElement("div");
      row.className = "volume-row";
      const isScan = vol.name && vol.name.startsWith('scan_');
      const isMask = vol.name?.toLowerCase().includes("mask");
      const isSelected = this.selectedVolume === vol;
      const isCompare = this.compareVolume === vol;
      if (isScan) row.classList.add('scan-item');
      else if (isMask) row.classList.add('mask-item');
      if (isSelected) row.classList.add('selected');
      if (isCompare) row.classList.add('compare-selected');
      let protocolTooltip = "";
      if (isScan && typeof window !== "undefined" && window.scanModule?.getProtocolTooltipForVolume) {
        protocolTooltip = window.scanModule.getProtocolTooltipForVolume(vol) || "";
        if (protocolTooltip) row.classList.add("has-protocol-tooltip");
      }

      if (!noCheckbox) {
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = vol.opacity > 0;
        cb.onclick = (e) => e.stopPropagation();
        cb.onchange = (e) => {
          e.stopPropagation();
          const newOpacity = cb.checked ? (vol.opacity === 0 ? 1 : vol.opacity) : 0;
          if (cb.checked && !isScan) {
            this.nv.volumes.forEach((v, idx) => {
              if (idx === originalIndex) return;
              if (!v.name?.startsWith('scan_')) this.nv.setOpacity(idx, 0);
            });
          }
          this.nv.setOpacity(originalIndex, newOpacity);
          this.updateVolumeList();
          this.updatePreviewFromSelection();
        };
        row.appendChild(cb);
      }

      const info = document.createElement("div");
      info.className = "volume-row-info";
      let titleText = vol.name || `Vol ${originalIndex + 1}`;
      let metaText = "Imported Phantom";
      if (isScan) {
        titleText = window.scanModule?.getScanDisplayTitle(vol)
          ?? formatScanDisplayTitle(vol.name);
        metaText = "";
      } else if (shortTitle) {
        if (vol._phantomLabel) {
          titleText = vol._phantomLabel;
        } else if (vol.name) {
          const m = vol.name.match(/_([^_.]+)\.nii(\.gz)?$/i);
          titleText = m ? m[1] : vol.name.replace(/\.nii(\.gz)?$/i, '').replace(/.*_/, '') || vol.name;
        }
      }
      let dimTooltip = "";
      try {
        const hdr = vol.hdr ?? vol.header ?? null;
        const dimRaw = hdr?.dims ?? hdr?.dim ?? vol.dims ?? vol.dim ?? null;
        const pixRaw = hdr?.pixDims ?? hdr?.pixDim ?? vol.pixDims ?? null;
        let matrixStr = "";
        let resolutionStr = "";
        if (Array.isArray(dimRaw) && dimRaw.length >= 4) {
          const nx = dimRaw[1], ny = dimRaw[2], nz = dimRaw[3];
          matrixStr = `${nx}×${ny}×${nz}`;
          const nt = dimRaw[4] ?? 1;
          if (nt && nt > 1) matrixStr += `×${nt}`;
        }
        if (Array.isArray(pixRaw) && pixRaw.length >= 4) {
          const sx = Number(pixRaw[1]), sy = Number(pixRaw[2]), sz = Number(pixRaw[3]);
          if (Number.isFinite(sx) && Number.isFinite(sy) && Number.isFinite(sz)) {
            resolutionStr = `${Number(sx).toFixed(2)}×${Number(sy).toFixed(2)}×${Number(sz).toFixed(2)} mm`;
          }
        }
        const lines = [titleText];
        if (matrixStr) lines.push(matrixStr);
        if (resolutionStr) lines.push(resolutionStr);
        if (lines.length > 1) dimTooltip = lines.join("\n");
      } catch (_) {}
      const title = document.createElement("div");
      title.className = "volume-row-title";
      title.textContent = titleText;
      if (protocolTooltip) {
        const tipParts = [protocolTooltip];
        if (dimTooltip) tipParts.push("", "— volume —", dimTooltip);
        row.title = tipParts.join("\n");
      } else if (dimTooltip) {
        title.title = dimTooltip;
      }
      info.appendChild(title);
      if (!noMeta) {
        const meta = document.createElement("div");
        meta.className = "volume-row-meta";
        meta.textContent = metaText;
        info.appendChild(meta);
      }
      row.appendChild(info);

      const actions = document.createElement("div");
      actions.className = "volume-row-actions";
      if (!noDownload) {
        const dl = document.createElement("button");
        dl.innerHTML = "<i class=\"bi bi-download\" aria-hidden=\"true\"></i>";
        dl.className = "btn volume-row-btn";
        dl.onclick = (e) => { e.stopPropagation(); this.downloadVolume(vol); };
        actions.appendChild(dl);
      }
      if (!noRemove) {
        const rm = document.createElement("button");
        rm.innerHTML = "<i class=\"bi bi-x-lg\" aria-hidden=\"true\"></i>";
        rm.className = "btn volume-row-btn";
        rm.onclick = (e) => {
          e.stopPropagation();
          if (this.selectedVolume === vol) this.selectedVolume = null;
          this.nv.removeVolume(vol);
          this.updateVolumeList();
          this.updatePreviewFromSelection();
        };
        actions.appendChild(rm);
      }
      row.appendChild(actions);

      if (!noCheckbox) {
        row.onclick = (e) => {
          if (e.target === row.querySelector('input[type="checkbox"]') || e.target.closest('button')) return;
          if (e.ctrlKey || e.metaKey) {
            const url = vol.sourceUrl || vol.url;
            if (url) {
              e.preventDefault();
              this.loadCompareFromVolume(vol);
            }
            return;
          }
          if (!isScan) return;
          if (window.viewManager?.currentMode !== 'planning') {
            window.viewManager.setMode('planning');
          }
          this.selectedVolume = this.selectedVolume === vol ? null : vol;
          this.updateVolumeList();
          this.updatePreviewFromSelection();
          if (this.selectedVolume === vol) {
            this.syncFovFromScanVolume(vol);
          }
        };
      }
      return row;
    };

    const createGroupRow = (group) => {
      const expanded = this.expandedGroups.has(group.id);
      const row = document.createElement("div");
      row.className = "volume-row volume-group-parent";
      // Native tooltip: phantom JSON (truncated — very long configs would overwhelm the UI / browser)
      const JSON_TOOLTIP_MAX = 14000;
      if (group.jsonContent) {
        row.classList.add("has-json-tooltip");
        const raw = String(group.jsonContent);
        row.title =
          raw.length > JSON_TOOLTIP_MAX
            ? `${raw.slice(0, JSON_TOOLTIP_MAX)}\n… (${raw.length - JSON_TOOLTIP_MAX} more characters — PHANTOMS editor for full file)`
            : raw;
      } else if (group.jsonFileName) {
        row.title = `No JSON text in memory (${group.jsonFileName})`;
      }
      const toggle = document.createElement("span");
      toggle.className = "group-toggle";
      toggle.textContent = expanded ? "▼" : "▶";
      toggle.style.cssText = "cursor:pointer;margin-right:4px;font-size:10px;";
      const info = document.createElement("div");
      info.className = "volume-row-info";
      const title = document.createElement("div");
      title.className = "volume-row-title";
      title.textContent = group.jsonName;
      const meta = document.createElement("div");
      meta.className = "volume-row-meta";
      meta.textContent = `${group.volumes.length} sub-phantoms`;
      info.appendChild(title);
      info.appendChild(meta);
      const actions = document.createElement("div");
      actions.className = "volume-row-actions";
      const dl = document.createElement("button");
      dl.innerHTML = "<i class=\"bi bi-download\" aria-hidden=\"true\"></i>";
      dl.className = "btn volume-row-btn";
      dl.title = "Download as zip (folder + JSON + NIfTIs)";
      dl.onclick = (e) => {
        e.stopPropagation();
        this.downloadGroupAsZip(group);
      };
      const rm = document.createElement("button");
      rm.innerHTML = "<i class=\"bi bi-x-lg\" aria-hidden=\"true\"></i>";
      rm.className = "btn volume-row-btn";
      rm.onclick = (e) => {
        e.stopPropagation();
        this._removePhantomGroup(group);
        this.updateVolumeList();
        this.updatePreviewFromSelection();
      };
      actions.appendChild(dl);
      actions.appendChild(rm);
      row.appendChild(toggle);
      row.appendChild(info);
      row.appendChild(actions);
      toggle.onclick = (e) => {
        e.stopPropagation();
        if (this.expandedGroups.has(group.id)) this.expandedGroups.delete(group.id);
        else this.expandedGroups.add(group.id);
        this.updateVolumeList();
      };
      return row;
    };

    const createSubRow = (vol, originalIndex) => {
      const row = createRow(vol, originalIndex, { noDownload: true, noRemove: true, noMeta: true, shortTitle: true });
      row.classList.add("volume-group-sub");
      row.style.marginLeft = "16px";
      return row;
    };

    if (phantomEl && (phantoms.length > 0 || this.volumeGroups.length > 0)) {
      this.volumeGroups.forEach(group => {
        phantomEl.appendChild(createGroupRow(group));
        const expanded = this.expandedGroups.has(group.id);
        if (expanded) {
          group.volumes.forEach(vol => {
            const idx = this.nv.volumes.indexOf(vol);
            if (idx >= 0) phantomEl.appendChild(createSubRow(vol, idx));
          });
        }
      });
      phantoms.forEach(p => phantomEl.appendChild(createRow(p.vol, p.index)));
    }
    this._syncPhantomVolumeListHeight();

    if (scanEl) {
      if (scans.length > 0) {
        [...scans].reverse().forEach(s => scanEl.appendChild(createRow(s.vol, s.index)));
      } else {
        const empty = document.createElement("div");
        empty.className = "scan-volume-list-empty";
        empty.textContent = 'Scan list is empty.\nChoose a sequence,\nAdjust the protocol,\nPosition and rotate the FOV\nwith CTRL+ mouse L+R,\nPress scan';
        scanEl.appendChild(empty);
      }
    }

    this.updateJsonTab();
    if (typeof window !== "undefined") window.mainHist?.scheduleRefresh?.();
    this.refreshCrosshairIntensityOverlay();
  }

  /** JSON text still in memory on volume groups when /phantom was never filled (default bundle). */
  _jsonConfigsFromVolumeGroups() {
    const map = new Map();
    for (const g of this.volumeGroups) {
      if (g.jsonContent == null || String(g.jsonContent).trim() === "") continue;
      const fn = g.jsonFileName || (g.jsonName ? `${g.jsonName}.json` : null);
      if (!fn || !fn.toLowerCase().endsWith(".json")) continue;
      if (!map.has(fn)) map.set(fn, String(g.jsonContent));
    }
    return map;
  }

  updateJsonTab() {
    const root = this.containerControls || document;
    const sel = root.querySelector(`#json-config-select-${this.instanceId}`);
    if (!sel) return;

    let jsonNames = [];
    if (this.pyodide) {
      try {
        jsonNames = this.pyodide.FS.readdir("/phantom").filter((f) => f.endsWith(".json"));
      } catch (_) {}
    }
    const fromGroups = jsonNames.length === 0 ? this._jsonConfigsFromVolumeGroups() : null;

    if (jsonNames.length === 0 && fromGroups?.size) {
      jsonNames = [...fromGroups.keys()].sort();
    }

    sel.innerHTML = "";
    jsonNames.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    });

    if (jsonNames.length === 0) {
      this.jsonTabCurrentName = null;
      this.setJsonEditorValue("");
      return;
    }

    const pick = this.jsonTabCurrentName && jsonNames.includes(this.jsonTabCurrentName)
      ? this.jsonTabCurrentName
      : jsonNames[0];
    sel.value = pick;
    this.jsonTabCurrentName = pick;
    const content = fromGroups
      ? fromGroups.get(pick)
      : this.pyodide.FS.readFile(`/phantom/${pick}`, { encoding: "utf8" });
    this.setJsonEditorValue(content ?? "");

    sel.onchange = () => this.switchActivePhantomConfig(sel.value);
  }

  updatePreviewFromSelection() {
    if (!window.scanPreview) return;
    
    // Show the selected scan in preview (regardless of checked/visibility state)
    if (this.selectedVolume && this.selectedVolume.sourceUrl) {
      window.scanPreview.loadSingleScan(this.selectedVolume.sourceUrl, this.selectedVolume.name);
    } else {
      // No selection, clear preview
      window.scanPreview.loadSingleScan(null, null);
    }
  }

  /** Lazy compare pane C: Ctrl+click list or Ctrl+VIEW SCAN */
  async loadCompareFromVolume(vol) {
    if (!vol || !window.scanCompare) return;
    const url = vol.sourceUrl || vol.url;
    if (!url) return;
    await window.scanCompare.loadFromVolume(vol);
  }

  /**
   * Fetch bundled nifti_phantom_v1 folder (JSON + NIfTIs) and load like Add (json/nii).
   * Base URL may be absolute (GitHub raw) or relative to the current page.
   */
  /** Load the fixed default phantom (`DEFAULT_CACHE_PHANTOM_ID`) from the Modal cache. */
  async loadDefaultCachePhantom() {
    return this.loadPhantomFromCache(DEFAULT_CACHE_PHANTOM_ID);
  }

  /** Back-compat alias: startup / "Default phantom" button now load from the cache. */
  async loadBundledDefaultPhantom() {
    return this.loadDefaultCachePhantom();
  }

  /**
   * Load a phantom from the cache admin download URL (`{collection}/{name}/download`),
   * extract the `.tar.gz`, and show it in Niivue. Tags the group with `biftiRegistryId`
   * (the scan-ready id used by Modal HTTP sim).
   * @param {string} phantomId — e.g. `brainweb-20-v2/subj04-3T-1mm-tra`
   */
  async loadPhantomFromCache(phantomId) {
    await this.waitForInit();
    const id = normalizeCacheId(phantomId);
    if (!id) throw new Error("loadPhantomFromCache: empty phantom id");
    const { folderId, name: folderName, config } = splitCacheId(id);
    // Download is folder-based (all JSON configs + shared NIfTIs); the id's optional
    // third segment selects which JSON config is active for scanning.
    const tarBytes = new Uint8Array(await downloadPhantomTarGz(id));
    const { jsonFiles, niftiFiles } = await this._extractPhantomTarGz(tarBytes, id);
    if (!jsonFiles.length || niftiFiles.length === 0) {
      throw new Error(`Phantom "${id}": archive missing JSON or NIfTIs`);
    }
    const jsonFile = this._pickConfigJsonFile(jsonFiles, folderName, config);
    // The scan id is exactly what was requested (the server accepts it directly). The default
    // JSON (mapping to the 2-segment folder id) is `{folderName}.json` when present, else the
    // file loaded for a folder/default request.
    const scanId = id;
    const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
    const defaultJsonName = jsonFiles.find((f) => eq(f.name, `${folderName}.json`))?.name
      ?? (config ? null : jsonFile.name);
    if (this.pyodide) {
      await this.populatePyodideVFS(niftiFiles, jsonFiles);
      this._pendingPhantomVfs = null;
    } else {
      this._pendingPhantomVfs = { jsonFile, jsonFiles, niftiFiles };
    }
    try {
      await this.loadMultiPhantomFromFiles(jsonFile, niftiFiles, {
        biftiRegistryId: scanId,
        folderId,
        configFiles: { folderId, jsonFiles, niftiFiles, defaultJsonName },
      });
    } catch (e) {
      this._pendingPhantomVfs = null;
      throw e;
    }
    this.jsonTabCurrentName = jsonFile.name;
    this.updateJsonTab();
  }

  /** Pick the active JSON config: `{config}.json` when requested, else the folder default `{name}.json`. */
  _pickConfigJsonFile(jsonFiles, folderName, config) {
    const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
    const want = config ? `${config}.json` : `${folderName}.json`;
    return jsonFiles.find((f) => eq(f.name, want))
      ?? jsonFiles.find((f) => eq(f.name, `${folderName}.json`))
      ?? jsonFiles[0];
  }

  /**
   * Map a folder + JSON filename to a scan-ready id shape. Kept for callers that need a
   * display/share stem; HTTP SCAN must not use invented 3-segment ids for local-only
   * Save-as configs — those go as `phantom.config` with `phantom.id` = folder id.
   * Default config → two-segment folder id; alternate → `{folderId}/{stem}`.
   */
  _configScanId(folderId, jsonFileName, defaultJsonName = null) {
    const stem = String(jsonFileName || "").replace(/\.json$/i, "");
    if (!stem) return folderId;
    if (defaultJsonName && String(jsonFileName).toLowerCase() === String(defaultJsonName).toLowerCase()) {
      return folderId;
    }
    const folderName = String(folderId).split("/")[1] || "";
    if (!defaultJsonName && folderName && stem.toLowerCase() === folderName.toLowerCase()) {
      return folderId;
    }
    return `${folderId}/${stem}`;
  }

  /**
   * Switch the active phantom JSON config (from the config `<select>`): update the editor
   * and the group's inline JSON identity (`jsonFileName` / `jsonContent`). Keeps
   * `biftiRegistryId` as the cached folder id (or originally loaded cache id) so HTTP SCAN
   * posts a registry-known `phantom.id`; the chosen/edited JSON is sent as `phantom.config`.
   * Do not invent 3-segment ids like `user/…/…_copy` for Save-as configs that only exist
   * locally. NIfTIs are shared across configs, so volumes are not re-fetched.
   */
  switchActivePhantomConfig(jsonFileName) {
    const fn = String(jsonFileName || "").trim();
    if (!fn) return;
    // Read the target config from VFS / in-memory groups — not via the editor, which still
    // holds the previously-selected config's text at this point.
    let text = null;
    if (this.pyodide) {
      try { text = this.pyodide.FS.readFile(`/phantom/${fn}`, { encoding: "utf8" }); } catch (_) { /* no VFS copy */ }
    }
    if (text == null) text = this._jsonConfigsFromVolumeGroups().get(fn) ?? null;
    this.jsonTabCurrentName = fn;
    this.setJsonEditorValue(text ?? "");
    const g = this.getActivePhantomGroup();
    if (!g) return;
    const folderId = g.folderId || (g.biftiRegistryId ? phantomFolderId(g.biftiRegistryId) : null);
    if (folderId) {
      g.folderId = folderId;
      // Cache download + HTTP sim resolve NIfTIs by folder; local/_copy stems stay in json*.
      g.biftiRegistryId = folderId;
    }
    g.jsonFileName = fn;
    g.jsonName = fn.replace(/\.json$/i, "");
    if (text != null && String(text).trim()) g.jsonContent = String(text);
    this.updateVolumeList?.();
  }

  /**
   * Extract a phantom `.tar.gz` (browser-fetched bytes) into JSON + NIfTI `File`s via Pyodide.
   * Download must use JS `fetch` — Pyodide urllib cannot open https URLs in the browser.
   * @param {Uint8Array} tarBytes
   * @param {string} id — scan-ready id (for error messages)
   */
  async _extractPhantomTarGz(tarBytes, id) {
    await this.initPyodide();
    this.pyodide.globals.set("_bifti_tar_bytes", tarBytes);
    let membersPy;
    try {
      membersPy = await this.pyodide.runPythonAsync(`
import io, gzip, tarfile
_raw = _bifti_tar_bytes.to_py() if hasattr(_bifti_tar_bytes, 'to_py') else _bifti_tar_bytes
_raw = bytes(_raw)
try:
    _buf = gzip.decompress(_raw)
except OSError:
    _buf = _raw
_out = []
with tarfile.open(fileobj=io.BytesIO(_buf), mode='r:*') as tf:
    for m in tf.getmembers():
        if not m.isfile():
            continue
        name = m.name
        base = name.split('/')[-1]
        if not base or base.startswith('.') or '__MACOSX' in name:
            continue
        low = base.lower()
        if low.endswith('.json') or low.endswith('.nii') or low.endswith('.nii.gz'):
            data = tf.extractfile(m).read()
            depth = name.count('/')
            _out.append((base, low.endswith('.json'), depth, data))
_out
`);
    } catch (e) {
      const msg = typeof this.formatPyodideError === "function" ? this.formatPyodideError(e) : (e?.message || String(e));
      throw new Error(`Phantom "${id}": ${msg}`);
    }
    const members = (membersPy && membersPy.toJs) ? membersPy.toJs() : membersPy;
    if (membersPy?.destroy) membersPy.destroy();

    const jsonEntries = [];
    const niftiFiles = [];
    for (const entry of members) {
      const [base, isJson, depth, data] = entry;
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      const file = new File([bytes], base, { type: "application/octet-stream" });
      if (isJson) jsonEntries.push({ file, depth });
      else niftiFiles.push(file);
    }
    if (jsonEntries.length === 0) {
      throw new Error(`Phantom "${id}": no JSON found in archive`);
    }
    // A cached folder may carry several JSON configs sharing the same NIfTIs (shallowest first).
    jsonEntries.sort((a, b) => a.depth - b.depth);
    const jsonFiles = jsonEntries.map((e) => e.file);
    return { jsonFiles, jsonFile: jsonFiles[0], niftiFiles };
  }

  /**
   * Modal cache picker: fetch the scan-ready phantom list and let the user choose one.
   * Loading replaces all volumes (same reset semantics as "Add BIfTI"/"Default phantom").
   */
  async showCachePhantomDialog() {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "json-choice-overlay";
      overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999;";
      const box = document.createElement("div");
      box.className = "json-choice-dialog";
      box.style.cssText = "background:var(--bg-panel);border:1px solid var(--border);border-radius:8px;padding:20px;min-width:520px;max-width:720px;width:min(720px,92vw);box-shadow:0 8px 32px rgba(0,0,0,0.4);";
      const title = document.createElement("div");
      title.style.cssText = "font-weight:600;margin-bottom:6px;color:var(--text);font-size:15px;";
      title.textContent = "Add BIfTI — phantom cache";
      const hint = document.createElement("div");
      hint.style.cssText = "font-size:12px;color:var(--muted);margin-bottom:12px;";
      hint.textContent = "Loading a phantom replaces all volumes, scans, and masks in the viewer.";
      const list = document.createElement("div");
      list.style.cssText = "display:flex;flex-direction:column;gap:3px;margin-bottom:14px;max-height:min(720px,78vh);overflow-y:auto;min-height:80px;";
      const status = document.createElement("div");
      status.style.cssText = "font-size:11px;color:var(--muted);margin-bottom:10px;";
      status.textContent = "Fetching phantom list…";
      const footer = document.createElement("div");
      footer.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:8px;";
      const adminLink = document.createElement("a");
      adminLink.href = BIFTI_CACHE_ADMIN_BASE;
      adminLink.target = "_blank";
      adminLink.rel = "noopener noreferrer";
      adminLink.textContent = "Add phantoms on cache admin ↗";
      adminLink.style.cssText = "font-size:11px;color:var(--accent, #4a9eff);text-decoration:none;";
      const rightActions = document.createElement("div");
      rightActions.style.cssText = "display:flex;align-items:center;gap:8px;";
      const refresh = document.createElement("button");
      refresh.className = "btn btn-secondary";
      refresh.textContent = "Refresh";
      const cancel = document.createElement("button");
      cancel.className = "btn btn-secondary";
      cancel.textContent = "Cancel";

      const close = (result) => { overlay.remove(); resolve(result); };
      cancel.onclick = () => close(null);
      overlay.onclick = (e) => { if (e.target === overlay) close(null); };
      footer.appendChild(adminLink);
      rightActions.appendChild(refresh);
      rightActions.appendChild(cancel);
      footer.appendChild(rightActions);
      box.appendChild(title);
      box.appendChild(hint);
      box.appendChild(status);
      box.appendChild(list);
      box.appendChild(footer);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      const pick = async (id) => {
        if (!await this.confirmPhantomReset()) return;
        status.textContent = `Loading ${id}…`;
        list.querySelectorAll("button").forEach((b) => (b.disabled = true));
        try {
          this.resetViewer();
          await this.loadPhantomFromCache(id);
          this.updateJsonTab();
          close(id);
        } catch (e) {
          console.error("Cache phantom load failed:", e);
          status.textContent = e?.message || String(e);
          list.querySelectorAll("button").forEach((b) => (b.disabled = false));
        }
      };

      const loadList = () => {
        list.innerHTML = "";
        refresh.disabled = true;
        status.textContent = "Fetching phantom list…";
        fetchCachedPhantomIds()
        .then((ids) => {
          if (!overlay.isConnected) return;
          if (!ids.length) {
            status.textContent = "No phantoms on the cache yet. Use the cache admin to add one.";
            return;
          }
          // Group scan ids by folder (first two segments): the 2-segment id is the default
          // config; any 3-segment ids are alternate configs sharing the same folder/NIfTIs.
          const folders = new Map();
          ids.forEach((id) => {
            let folderId, config;
            try { ({ folderId, config } = splitCacheId(id)); }
            catch (_) { folderId = id; config = null; }
            if (!folders.has(folderId)) folders.set(folderId, []);
            folders.get(folderId).push({ id, config });
          });
          status.textContent = `${folders.size} phantom(s) available:`;
          for (const [folderId, variants] of folders) {
            const hasDefault = variants.some((v) => !v.config);
            const defaultId = hasDefault ? folderId : variants[0].id;
            const group = document.createElement("div");
            group.style.cssText = "display:flex;flex-direction:column;gap:4px;";

            const rowMain = document.createElement("div");
            rowMain.style.cssText = "display:flex;align-items:stretch;gap:4px;";

            const btn = document.createElement("button");
            btn.className = "btn";
            btn.style.cssText = "flex:1;text-align:left;padding:5px 12px;justify-content:flex-start;font-family:monospace;font-size:12px;line-height:1.3;";
            btn.textContent = folderId;
            btn.onclick = () => pick(defaultId);
            rowMain.appendChild(btn);

            if (variants.length > 1) {
              const toggle = document.createElement("button");
              toggle.className = "btn btn-secondary";
              toggle.style.cssText = "flex:0 0 auto;padding:4px 8px;font-size:11px;min-width:7.5em;line-height:1.3;";
              toggle.setAttribute("aria-expanded", "false");
              const setToggleLabel = (open) => {
                toggle.textContent = open
                  ? `▾ ${variants.length} configs`
                  : `▸ ${variants.length} configs`;
                toggle.setAttribute("aria-expanded", open ? "true" : "false");
              };
              setToggleLabel(false);

              const configs = document.createElement("div");
              configs.style.cssText = "display:none;flex-wrap:wrap;gap:4px;padding:2px 0 4px 14px;";
              variants
                .slice()
                .sort((a, b) => (a.config ? 1 : 0) - (b.config ? 1 : 0))
                .forEach(({ id, config }) => {
                  const chip = document.createElement("button");
                  chip.className = "btn btn-secondary";
                  chip.style.cssText = "padding:2px 8px;font-family:monospace;font-size:11px;line-height:1.3;";
                  chip.textContent = config || "(default)";
                  chip.onclick = () => pick(id);
                  configs.appendChild(chip);
                });

              toggle.onclick = (e) => {
                e.stopPropagation();
                const open = configs.style.display === "none";
                configs.style.display = open ? "flex" : "none";
                setToggleLabel(open);
              };

              rowMain.appendChild(toggle);
              group.appendChild(rowMain);
              group.appendChild(configs);
            } else {
              group.appendChild(rowMain);
            }
            list.appendChild(group);
          }
        })
        .catch((e) => {
          if (!overlay.isConnected) return;
          console.error("Cache list failed:", e);
          status.textContent = `Could not fetch phantom list: ${e?.message || e}`;
        })
        .finally(() => {
          if (overlay.isConnected) refresh.disabled = false;
        });
      };
      refresh.onclick = loadList;
      loadList();
    });
  }

  async loadMultiPhantomFromFiles(jsonFile, niftiFiles, options = {}) {
    await this.waitForInit();
    const biftiRegistryId = options.biftiRegistryId ? normalizeCacheId(options.biftiRegistryId) : null;
    try {
      const jsonText = await jsonFile.text();
      const niftiCatalog = phantomNiftiCatalogFromJson(jsonText);
      let fileList = null;
      try {
        const parsed = JSON.parse(jsonText);
        if (Array.isArray(parsed)) {
          fileList = parsed.filter(s => typeof s === "string" && /\.nii(\.gz)?$/i.test(s));
        } else if (parsed && typeof parsed === "object") {
          const arr = parsed.phantoms || parsed.files || parsed.volumes;
          if (Array.isArray(arr)) {
            fileList = arr.filter(s => typeof s === "string" && /\.nii(\.gz)?$/i.test(s));
          }
        }
      } catch (_) {}
      const nameMap = new Map(niftiFiles.map(f => [f.name, f]));
      let ordered;
      if (niftiCatalog) {
        ordered = niftiCatalog.order.map(n => nameMap.get(n)).filter(Boolean);
        const used = new Set(ordered.map(f => f.name));
        for (const f of niftiFiles) {
          if (!used.has(f.name)) ordered.push(f);
        }
      } else if (fileList) {
        ordered = fileList.map(n => nameMap.get(n)).filter(Boolean);
      } else {
        ordered = [...niftiFiles].sort((a, b) => a.name.localeCompare(b.name));
      }
      if (ordered.length === 0) {
        return;
      }
      const groupId = "g-" + Math.random().toString(36).substr(2, 9);
      const jsonName = jsonFile.name.replace(/\.json$/i, "");
      if (!niftiCatalog) {
        // Legacy: ensure *_PD.nii volume is first when filename carries the suffix
        const pdIdx = ordered.findIndex(f => /_PD\.nii(\.gz)?$/i.test(f.name));
        if (pdIdx > 0) {
          const [pdFile] = ordered.splice(pdIdx, 1);
          ordered.unshift(pdFile);
        }
      }
      const defaultVisibleIdx = 0;
      const groupVolumes = [];
      for (let i = 0; i < ordered.length; i++) {
        const f = ordered[i];
        const u = URL.createObjectURL(f);
        const added = await this.nv.addVolumesFromUrl([{
          url: u,
          name: f.name,
          colormap: "gray",
          opacity: i === defaultVisibleIdx ? 1.0 : 0
        }]);
        if (added?.length) {
          added[0].sourceUrl = u;
          added[0]._groupId = groupId;
          added[0]._sourceFile = f;
          if (niftiCatalog?.fileToLabel.has(f.name)) {
            added[0]._phantomLabel = niftiCatalog.fileToLabel.get(f.name);
          }
          groupVolumes.push(added[0]);
        }
        setTimeout(() => URL.revokeObjectURL(u), 30000);
      }
      this.volumeGroups.push({ id: groupId, jsonName, volumes: groupVolumes, jsonContent: jsonText, jsonFileName: jsonFile.name, biftiRegistryId, folderId: options.folderId ?? null, configFiles: options.configFiles ?? null });
      this.refreshFovForNewVolume();
      this.updateVolumeList();
      this.updatePreviewFromSelection();
      this.triggerHighlight();
    } catch (e) {
      console.error(e);
    }
  }

  /**
   * @param {string} url
   * @param {string} [name]
   * @param {boolean} [isAdding=false]
   * @param {boolean} [syncFovOnScan=true] When loading a `scan_*` volume, also sync the FOV
   *   sliders/mesh from its header. Default `true` preserves behavior for user-initiated imports
   *   (drag-drop, file picker, deep-link). Set to `false` for auto-load right after a scan completes
   *   so the user's in-progress FOV planning is not overwritten (see `ScanModule.loadJob`).
   */
  async loadUrl(url, name, isAdding = false, syncFovOnScan = true) {
    await this.waitForInit();
    try {
      
      const isScan = name && name.startsWith('scan_');
      const isMask = name?.toLowerCase().includes("mask");

      let addedVolumes = [];
      if (!isAdding && !isScan && !isMask) {
          addedVolumes = await this.nv.addVolumesFromUrl([{ url, name: name??"vol", colormap: "gray", opacity: 1.0 }]);
      } else {
          // Scans, Masks, or explicit additions
          addedVolumes = await this.nv.addVolumesFromUrl([{ url, name: name??"vol", colormap: isMask?"red":"gray", opacity: isMask?0.8:0.5, cal_min: isMask?0.5:undefined, cal_max: isMask?1:undefined }]);
      }

      // Tag with source URL for syncing to preview
      if (addedVolumes && addedVolumes.length > 0) {
        addedVolumes.forEach(v => v.sourceUrl = url);
      } else {
        // Fallback for older Niivue or if it returns nothing
        const v = this.nv.volumes.find(v => v.name === (name??"vol"));
        if (v) v.sourceUrl = url;
      }

      if (!isAdding || this.nv.volumes.length === 1) {
          this.refreshFovForNewVolume();
      }
      this.updateVolumeList(); 
      
      // If a scan was loaded, select it and optionally sync FOV from its header.
      // Auto-load after completion passes `syncFovOnScan=false` so the user's in-progress
      // FOV planning survives the arrival of the scan result.
      if (isScan) {
          const loadedVol = this.nv.volumes.find(v => v.name === (name??"vol"));
          if (loadedVol) {
              this.selectedVolume = loadedVol;
              this.updateVolumeList(); // Re-render to show selection
              if (syncFovOnScan) {
                  this.syncFovFromScanVolume(loadedVol);
              }
          }
      }
      
      this.updatePreviewFromSelection();
      this.triggerHighlight();
      if (typeof window !== "undefined") window.mainHist?.scheduleRefresh?.();
    } catch (e) {
      console.error(e);
    }
  }
}

/** Format number with 4 significant digits (12 → "12.00", 12.123 → "12.12"). */
export function formatSigFigs4(val) {
  if (val === 0 || !Number.isFinite(val)) return String(val);
  return Number(val).toPrecision(4);
}

/** Get voxel intensity at voxel indices [i, j, k]. Returns null if no volume or out of bounds. */
export function getIntensityAtVox(vol, vox, dim3) {
  if (!vol || !dim3 || dim3.length < 3) return null;
  const nx = dim3[0], ny = dim3[1], nz = dim3[2];
  const ix = Math.round(Number(vox[0]));
  const iy = Math.round(Number(vox[1]));
  const iz = Math.round(Number(vox[2]));
  if (ix < 0 || ix >= nx || iy < 0 || iy >= ny || iz < 0 || iz >= nz) return null;
  const frame = vol.frame4D ?? 0;
  return Number(vol.getValue(ix, iy, iz, frame));
}

export function dim3FromVolume(vol) {
  const hdr = vol?.hdr ?? vol?.header ?? null;
  const dimRaw = hdr?.dims ?? hdr?.dim ?? vol?.dims ?? vol?.dim ?? null;
  if (!Array.isArray(dimRaw)) return null;
  if (dimRaw.length >= 4) return [dimRaw[1], dimRaw[2], dimRaw[3]];
  if (dimRaw.length === 3) return [dimRaw[0], dimRaw[1], dimRaw[2]];
  return null;
}

/** Resolve volume + 3D dims for crosshair intensity (preview: first volume; main: selected/visible). */
export function getVolumeForIntensityFromNv(nv, preferVol = null) {
  const list = nv?.volumes;
  if (!list?.length) return { vol: null, dim3: null };
  let vol = null;
  if (preferVol && list.includes(preferVol)) {
    vol = preferVol;
  } else {
    vol = list.find((v) => v.opacity > 0) ?? list[0];
  }
  return { vol, dim3: dim3FromVolume(vol) };
}

/** Intensity at crosshair for the given volume (or first visible volume on nv). */
export function intensityFromLocationData(nv, data, preferVol = null) {
  const { vol, dim3 } = getVolumeForIntensityFromNv(nv, preferVol);
  if (!vol) return null;

  const values = data?.values;
  if (Array.isArray(values) && values.length) {
    const entry = values.find((e) => e.id != null && e.id === vol.id)
      ?? values.find((e) => e.name && e.name === vol.name);
    if (entry != null && Number.isFinite(entry.value)) return entry.value;
  }

  const mm = data?.mm;
  if ((Array.isArray(mm) || ArrayBuffer.isView(mm)) && mm.length >= 3 && typeof vol.mm2vox === "function") {
    return getIntensityAtVox(vol, vol.mm2vox(mm), dim3);
  }

  const vox = data?.vox;
  if ((Array.isArray(vox) || ArrayBuffer.isView(vox)) && vox.length >= 3) {
    return getIntensityAtVox(vol, vox, dim3);
  }
  return null;
}

export function updateCrosshairIntensityOverlay(el, nv, data, preferVol = null) {
  if (!el) return;
  try {
    const val = intensityFromLocationData(nv, data, preferVol);
    el.textContent = (val === null || Number.isNaN(val)) ? "—" : formatSigFigs4(val);
  } catch {
    el.textContent = "—";
  }
}

export function refreshCrosshairIntensityForNv(nv, axCorSag = NaN) {
  if (!nv?.createOnLocationChange || !nv.volumes?.length) return;
  const ax = Number.isFinite(axCorSag)
    ? axCorSag
    : (typeof nv.opts?.sliceType === "number" && nv.opts.sliceType < SLICE_TYPE.RENDER
      ? nv.opts.sliceType
      : 0);
  try {
    nv.createOnLocationChange(ax);
  } catch (e) {
    console.warn("refreshCrosshairIntensityForNv failed", e);
  }
}

/** Sync options for scan preview (B) ↔ compare (C) panes */
const PREVIEW_CROSSHAIR_WIDTH = 0.35;

const PREVIEW_PANE_SYNC_OPTS = {
  '2d': true,
  '3d': false,
  crosshair: true,
  sliceType: true,
  zoomPan: true,
  // Clims are recomputed per 4D frame (mag vs phase); avoid broadcast overwriting them.
  cal_min: false,
  cal_max: false,
  gamma: true,
};

let _previewPeerSyncGuard = false;

function getPreviewPeerNv(sourceNv) {
  const preview = window.scanPreview?.nv;
  const compare = window.scanCompare?.module?.nv;
  if (!preview || !compare || !sourceNv) return null;
  if (sourceNv === preview) return compare;
  if (sourceNv === compare) return preview;
  return null;
}

/** Refresh preview/compare histogram UI after layout resize; keep existing cal_min/cal_max. */
export function syncPreviewViewerClims() {
  window.jointHist?.refresh?.();
}

/** Step 4D frame on preview B and synced compare C (Niivue default needs cursor-in-bounds). */
function stepPreviewPanesFrame4D(sourceNv, delta) {
  if (!sourceNv?.volumes?.length) return false;
  const srcVol = sourceNv.volumes[0];
  if (!volumeIs4D(srcVol)) return false;

  const nFr = srcVol.nFrame4D
    ?? (srcVol.hdr?.dims?.[4] > 1 ? srcVol.hdr.dims[4] : 1);
  if (!nFr || nFr <= 1) return false;

  const cur = srcVol.frame4D ?? 0;
  const next = (cur + delta + nFr) % nFr;

  const targets = [sourceNv];
  const peer = getPreviewPeerNv(sourceNv);
  if (peer?.volumes?.length) targets.push(peer);

  _previewPeerSyncGuard = true;
  try {
    for (const nv of targets) {
      const vol = nv.volumes[0];
      if (!vol || !volumeIs4D(vol)) continue;
      if (typeof nv.setFrame4D === "function") {
        nv.setFrame4D(vol.id, next);
      } else {
        vol.frame4D = next;
        nv.updateGLVolume?.();
      }
    }
    for (const nv of targets) {
      const vol = nv.volumes[0];
      if (!vol || !volumeIs4D(vol)) continue;
      syncVolumeClimsToCurrent4DFrame(vol, nv, next);
      nv.drawScene?.();
      refreshCrosshairIntensityForNv(nv);
    }
    window.jointHist?.refresh?.();
  } finally {
    _previewPeerSyncGuard = false;
  }
  return true;
}

/** Push slice layout, clims, and scene sync from sourceNv → peer (both directions via broadcastTo). */
export function pushPreviewStateFrom(sourceNv) {
  if (_previewPeerSyncGuard || !sourceNv) return;
  const peer = getPreviewPeerNv(sourceNv);
  if (!peer) return;
  _previewPeerSyncGuard = true;
  try {
    if (sourceNv.volumes.length && peer.volumes.length) {
      peer.volumes[0].cal_min = sourceNv.volumes[0].cal_min;
      peer.volumes[0].cal_max = sourceNv.volumes[0].cal_max;
      if (typeof peer.updateGLVolume === 'function') peer.updateGLVolume();
    }
    peer.opts.multiplanarShowRender = SHOW_RENDER.NEVER;
    peer.setSliceType(sourceNv.opts.sliceType);
    if (sourceNv.opts.sliceType === SLICE_TYPE.MULTIPLANAR) {
      peer.setMultiplanarLayout(MULTIPLANAR_TYPE.GRID);
    }
    if (typeof sourceNv.sync === 'function') sourceNv.sync();
    const w = sourceNv.opts.crosshairWidth ?? PREVIEW_CROSSHAIR_WIDTH;
    peer.opts.crosshairWidth = w;
    peer.setCrosshairWidth(w);
    peer.drawScene();
    if (typeof window !== "undefined") window.jointHist?.refresh?.();
  } finally {
    _previewPeerSyncGuard = false;
  }
}

export function linkScanPreviewPanes(previewNv, compareNv) {
  if (!previewNv || !compareNv) return;
  previewNv.broadcastTo(compareNv, PREVIEW_PANE_SYNC_OPTS);
  compareNv.broadcastTo(previewNv, PREVIEW_PANE_SYNC_OPTS);
  previewNv.readyForSync = true;
  compareNv.readyForSync = true;
}

export function unlinkScanPreviewPanes(previewNv, compareNv) {
  if (previewNv?.otherNV) {
    previewNv.otherNV = previewNv.otherNV.filter((nv) => nv !== compareNv);
    if (previewNv.otherNV.length === 0) previewNv.otherNV = null;
  }
  if (compareNv?.otherNV) {
    compareNv.otherNV = compareNv.otherNV.filter((nv) => nv !== previewNv);
    if (compareNv.otherNV.length === 0) compareNv.otherNV = null;
  }
}

export function installPreviewSyncHooks(nv) {
  if (!nv || nv._previewSyncHooksInstalled) return;
  nv._previewSyncHooksInstalled = true;
  installFrameAwareContrastDrag(nv);
  installFrameAwareBriConReset(nv);
  const prevLoc = nv.onLocationChange;
  nv.onLocationChange = (data) => {
    if (typeof prevLoc === 'function') prevLoc(data);
    if (_previewPeerSyncGuard || !getPreviewPeerNv(nv)) return;
    _previewPeerSyncGuard = true;
    try {
      if (typeof nv.sync === 'function') nv.sync();
    } finally {
      _previewPeerSyncGuard = false;
    }
  };
  const prevMouseUp = nv.onMouseUp;
  nv.onMouseUp = (...args) => {
    if (typeof prevMouseUp === "function") prevMouseUp(...args);
    if (!_previewPeerSyncGuard && getPreviewPeerNv(nv)) pushPreviewStateFrom(nv);
    if (!window.jointHist?.panel?.isApplyingFromPanel?.()) {
      window.jointHist?.syncFromVolumes?.();
    }
  };
  const prevIntensity = nv.onIntensityChange;
  nv.onIntensityChange = (...args) => {
    if (typeof prevIntensity === "function") prevIntensity(...args);
    if (!_previewPeerSyncGuard && getPreviewPeerNv(nv)) pushPreviewStateFrom(nv);
    if (!window.jointHist?.panel?.isApplyingFromPanel?.()) {
      window.jointHist?.syncFromVolumes?.();
    }
  };
  const prevFrameChange = nv.onFrameChange;
  nv.onFrameChange = (changedVol, frameIdx) => {
    if (typeof prevFrameChange === "function") prevFrameChange(changedVol, frameIdx);
    const vol = nv.volumes?.[0];
    if (!vol || changedVol !== vol || !volumeIs4D(vol)) return;
    const fi = Number.isFinite(frameIdx) ? frameIdx : (vol.frame4D ?? 0);
    syncVolumeClimsToCurrent4DFrame(vol, nv, fi);
    if (!window.jointHist?.panel?.isApplyingFromPanel?.()) {
      window.jointHist?.refresh?.();
    }
  };
}

/** After B or C loads a volume: re-sync clims + slice/crosshair (B view is default after C load). */
export function syncPreviewPanesAfterLoad(loadedRole) {
  const previewNv = window.scanPreview?.nv;
  const compareNv = window.scanCompare?.module?.nv;
  if (!previewNv || !compareNv) return;
  const sourceNv = loadedRole === 'compare' ? previewNv : previewNv;
  pushPreviewStateFrom(sourceNv);
  if (typeof window !== "undefined") window.jointHist?.refresh?.();
}

/**
 * ScanPreviewModule - A lightweight, view-only Niivue instance for scan previews
 * Slice-only (no 3D volume render) to reduce GPU memory vs the main viewer.
 */
export class ScanPreviewModule {
  constructor(options = {}) {
    this.role = options.role || 'preview';
    this.labelDefault = options.labelDefault || (this.role === 'compare' ? 'Compare' : 'Scan Preview');
    this.hintText = options.hint ?? (this.role === 'compare' ? '' : '←/→ 4D frame');
    this.viewerClass = this.role === 'compare'
      ? 'viewer scan-preview-viewer compare-preview-viewer'
      : 'viewer scan-preview-viewer';
    this.instanceId = (this.role === 'compare' ? 'compare-' : 'preview-') + Math.random().toString(36).substr(2, 5);
    this.canvasId = `gl-${this.role}-${Math.random().toString(36).substr(2, 9)}`;
    this.nv = new Niivue({
      logging: false,
      loadingText: "Press scan.",
      sliceType: SLICE_TYPE.AXIAL,
      multiplanarShowRender: SHOW_RENDER.NEVER,
      viewModeHotKey: "", // disable Niivue V cycle (includes SLICE_TYPE.RENDER)
      show3Dcrosshair: false,
      isOrientCube: false,
      fontMinPx: 11,
      fontSizeScaling: 0.4,
    });
    this._previewViewKeyLast = 0;
    this.container = null;
    this.canvas = null;
    this.crosshairIntensityEl = null;
    this.currentScanName = null;
    this.isInitialized = false;
    this._isSyncing = false;
    this._initWaiters = [];
  }

  waitForInit() {
    if (this.isInitialized) return Promise.resolve();
    return new Promise(resolve => this._initWaiters.push(resolve));
  }

  render(target) {
    this.container = typeof target === 'string' ? document.getElementById(target) : target;
    if (!this.container) throw new Error(`Preview target not found: ${target}`);

    this.container.classList.add('niivue-app', 'viewer-column-stack');
    this.container.innerHTML = `
      <div class="viewer-stack-body" style="flex:1;min-height:0;display:flex;flex-direction:column;">
      <div class="${this.viewerClass}" style="flex:1;min-height:0;position:relative;background:black;">
        <canvas id="${this.canvasId}"></canvas>
        <div class="crosshair-intensity viewer-canvas-overlay viewer-canvas-overlay--tl" id="crosshairIntensity-${this.instanceId}">—</div>
        <div class="preview-label viewer-canvas-overlay viewer-canvas-overlay--bl">${this.labelDefault}</div>
        ${this.hintText ? `<div class="preview-hint viewer-canvas-overlay viewer-canvas-overlay--tr">${this.hintText}</div>` : ''}
      </div>
      </div>
    `;

    this.canvas = this.container.querySelector(`#${this.canvasId}`);
    this.crosshairIntensityEl = this.container.querySelector(`#crosshairIntensity-${this.instanceId}`);

    setTimeout(() => this.initNiivue(), 10);
  }

  updateCrosshairIntensity(data) {
    updateCrosshairIntensityOverlay(this.crosshairIntensityEl, this.nv, data);
  }

  refreshCrosshairIntensityOverlay() {
    if (!this.nv?.volumes?.length) {
      if (this.crosshairIntensityEl) this.crosshairIntensityEl.textContent = "—";
      return;
    }
    refreshCrosshairIntensityForNv(this.nv);
  }

  applyViewOptions(opts) {
    if (!this.nv) return;
    if (opts.sliceMM !== undefined) this.nv.setSliceMM(opts.sliceMM);
    if (opts.radiological !== undefined) this.nv.setRadiologicalConvention(opts.radiological);
    // Preview stays slice-only; do not mirror main viewer 3D render toggle.
    if (opts.showCrosshair !== undefined) {
      const w = opts.showCrosshair ? PREVIEW_CROSSHAIR_WIDTH : 0;
      this.nv.opts.crosshairWidth = w;
      this.nv.setCrosshairWidth(w);
    }
    this.nv.drawScene();
  }

  _applyPreviewCrosshairStyle() {
    if (!this.nv) return;
    this.nv.opts.crosshairColor = [0.2, 0.8, 0.2, 0.5];
    const show = window.nvModule?.showCrosshair?.checked !== false;
    const w = show ? PREVIEW_CROSSHAIR_WIDTH : 0;
    this.nv.opts.crosshairWidth = w;
    this.nv.setCrosshairWidth(w);
  }

  async initNiivue() {
    try {
      await this.nv.attachToCanvas(this.canvas);
      this.nv.opts.multiplanarShowRender = SHOW_RENDER.NEVER;
      this.nv.opts.fontMinPx = 11;
      this.nv.opts.fontSizeScaling = 0.4;
      if (typeof this.nv.textSizePoints === "function") this.nv.textSizePoints();
      this.nv.setSliceType(SLICE_TYPE.AXIAL);

      this._applyPreviewCrosshairStyle();

      this.nv.onLocationChange = (data) => this.updateCrosshairIntensity(data);

      eventHub.on('viewOptionsChange', (opts) => this.applyViewOptions(opts));
      installPreviewSyncHooks(this.nv);
      window.jointHist?.installPreviewHooks?.();
      this.canvas.addEventListener("keydown", (e) => this._onPreviewViewKey(e), true);

      // Capture phase: block Niivue dblclick → resetBriCon (robust frame-0 window).
      this.canvas.addEventListener("dblclick", (e) => {
        if (this.role === 'compare' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          window.scanCompare?.deactivate?.();
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        this.toggleMaximize();
      }, true);
      
      // Double-tap detection for touch
      let lastTapTime = 0;
      this.canvas.addEventListener("touchend", (e) => {
        if (e.touches.length === 0 && e.changedTouches.length === 1) {
          const now = Date.now();
          if (now - lastTapTime < 300 && now - lastTapTime > 50) {
            this.toggleMaximize();
          }
          lastTapTime = now;
        }
      });
      
      this.nv.drawScene();
      
      this.isInitialized = true;
      this._initWaiters.forEach(fn => fn());
      this._initWaiters = [];
      console.log("ScanPreviewModule initialized");
    } catch (e) {
      console.error("ScanPreviewModule init failed:", e);
    }
  }
  
  /** Cycle axial → coronal → sagittal → multiplanar (no 3D render). */
  _cyclePreviewSliceView() {
    const nv = this.nv;
    const now = Date.now();
    if (now - this._previewViewKeyLast <= nv.opts.keyDebounceTime) return;
    this._previewViewKeyLast = now;
    nv.opts.multiplanarShowRender = SHOW_RENDER.NEVER;
    const cur = nv.opts.sliceType >= SLICE_TYPE.RENDER ? SLICE_TYPE.AXIAL : nv.opts.sliceType;
    const next = (cur + 1) % SLICE_TYPE.RENDER;
    if (next === SLICE_TYPE.MULTIPLANAR) {
      nv.setMultiplanarLayout(MULTIPLANAR_TYPE.GRID);
    }
    nv.setSliceType(next);
    nv.drawScene();
    if (window.scanCompare?.isReady) {
      pushPreviewStateFrom(nv);
    }
  }

  _onPreviewViewKey(e) {
    if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
      const delta = e.code === "ArrowRight" ? 1 : -1;
      if (stepPreviewPanesFrame4D(this.nv, delta)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
    if (e.code !== "KeyV") return;
    e.preventDefault();
    this._cyclePreviewSliceView();
  }

  /** Toggle maximize this viewer (hide the other viewer) */
  toggleMaximize() {
    eventHub.emit('toggleViewerMaximize', { containerId: this.container?.id });
  }

  triggerHighlight() {
    const target = this.container ? this.container.querySelector('.viewer') : null;
    if (!target) return;
    
    target.classList.remove('highlight-add');
    void target.offsetWidth; // Force reflow
    target.classList.add('highlight-add');
  }

  async loadSingleScan(url, name) {
    await this.waitForInit();
    if (this._isSyncing) return;
    this._isSyncing = true;
    
    try {
      // Remove all existing volumes
      while (this.nv.volumes.length > 0) {
        this.nv.removeVolume(this.nv.volumes[0]);
      }
      
      if (!url) {
        this.currentScanName = null;
        this.updateLabel("No Scan Visible");
        this.nv.drawScene();
        this.updateCrosshairIntensity(null);
        return;
      }
      
      // Load the single scan
      await this.nv.addVolumesFromUrl([{ 
        url, 
        name: name ?? "scan", 
        colormap: "gray", 
        opacity: 1.0,
        trustCalMinMax: false,
        percentileFrac: 0.02,
      }]);

      const vol = this.nv.volumes[0];
      if (vol) syncVolumeClimsToCurrent4DFrame(vol, this.nv);
      
      this.currentScanName = name;
      this.nv.drawScene();
      this.refreshCrosshairIntensityOverlay();

      const labelName = this._shortScanLabel(name);
      this.updateLabel(labelName);
      
      // Trigger highlight effect when scan is loaded
      this.triggerHighlight();
      
      console.log("ScanPreviewModule loaded:", name);
      if (window.scanCompare?.isReady) {
        setTimeout(() => syncPreviewPanesAfterLoad(this.role), 0);
      } else {
        window.jointHist?.refresh?.();
      }
    } catch (e) {
      console.error("ScanPreviewModule load failed:", e);
    } finally {
      this._isSyncing = false;
    }
  }

  updateLabel(text) {
    const label = this.container?.querySelector('.preview-label');
    if (label) label.textContent = text || this.labelDefault;
  }

  /** e.g. `scan_1_gre_seq.nii.gz` → `1. gre_seq` (matches SCANS volume list) */
  _shortScanLabel(name) {
    const job = typeof window !== 'undefined' && window.scanModule?.getJobForVolume
      ? window.scanModule.getJobForVolume({ name })
      : null;
    return formatScanDisplayTitle(name, job);
  }
}

/**
 * Lazy compare pane (C): no WebGL until first Ctrl+load. Synced from scan preview (B).
 */
export class ComparePane {
  static ensureEmptyPlaceholder(container) {
    if (!container) return;
    if (container.querySelector('.viewer.compare-preview-viewer')) return;
    if (container.querySelector('.compare-pane-placeholder')) return;
    const el = document.createElement('div');
    el.className = 'compare-pane-placeholder';
    el.setAttribute('aria-hidden', 'true');
    el.textContent = 'Ctrl+click on a scan item to activate';
    container.appendChild(el);
  }

  constructor() {
    this.module = null;
    this._initPromise = null;
    this.isActive = false;
  }

  get isReady() {
    return !!this.module?.isInitialized;
  }

  async ensureInitialized() {
    if (this.module?.isInitialized) return this.module;
    if (this._initPromise) {
      await this._initPromise;
      return this.module;
    }
    this._initPromise = this._doInit();
    await this._initPromise;
    return this.module;
  }

  async _doInit() {
    try {
      await window.scanPreview?.waitForInit?.();
      if (window.viewManager?.activateCompareColumn) {
        window.viewManager.activateCompareColumn();
      }
      this.module = new ScanPreviewModule({
        role: 'compare',
        labelDefault: 'Compare',
        hint: 'Ctrl+dbl-click close',
      });
      this.module.render('nv-compare-container');
      await this.module.waitForInit();
      window.jointHist?.installPreviewHooks?.();
      const previewNv = window.scanPreview?.nv;
      const compareNv = this.module.nv;
      if (previewNv && compareNv) {
        linkScanPreviewPanes(previewNv, compareNv);
        installPreviewSyncHooks(previewNv);
        installPreviewSyncHooks(compareNv);
        pushPreviewStateFrom(previewNv);
      }
      setTimeout(() => {
        this.module?.nv?.resizeListener?.();
        window.viewManager?.applyViewerLayout?.();
        if (previewNv && compareNv) pushPreviewStateFrom(previewNv);
        window.jointHist?.refresh?.();
      }, 80);
      this.isActive = true;
      return this.module;
    } catch (e) {
      console.error('ComparePane init failed:', e);
      this._initPromise = null;
      throw e;
    }
  }

  async loadFromVolume(vol) {
    if (!vol) return;
    let url = vol.sourceUrl || vol.url;
    if (!url && window.nvModule?.nv?.mediaUrlMap) {
      url = window.nvModule.nv.mediaUrlMap.get(vol);
    }
    if (!url) {
      console.warn('ComparePane: volume has no URL — load it on the main viewer first');
      return;
    }
    if (window.viewManager?.currentMode !== 'planning') {
      window.viewManager?.setMode('planning');
    }
    await this.ensureInitialized();
    await this.module.loadSingleScan(url, vol.name);
    if (window.nvModule) {
      window.nvModule.compareVolume = vol;
      window.nvModule.updateVolumeList?.();
    }
  }

  async loadFromJob(job) {
    if (!job?.niftiUrl || !window.nvModule) return;
    if (window.viewManager?.currentMode !== 'planning') {
      window.viewManager?.setMode('planning');
    }
    const nvMod = window.nvModule;
    const targetName = job.baseName + '.nii.gz';
    let idx = nvMod.nv.volumes.findIndex((v) => v.name === targetName);
    if (idx === -1) {
      await nvMod.loadUrl(job.niftiUrl, targetName, true, false);
      idx = nvMod.nv.volumes.findIndex((v) => v.name === targetName);
    }
    if (idx === -1) return;
    await this.loadFromVolume(nvMod.nv.volumes[idx]);
  }

  /** Tear down compare Niivue (C) and hide the pane until next Ctrl+load. */
  deactivate() {
    const previewNv = window.scanPreview?.nv;
    const compareNv = this.module?.nv;

    if (previewNv && compareNv) {
      unlinkScanPreviewPanes(previewNv, compareNv);
    }

    if (compareNv) {
      while (compareNv.volumes.length > 0) {
        compareNv.removeVolume(compareNv.volumes[0]);
      }
      if (typeof compareNv.cleanup === 'function') {
        compareNv.cleanup();
      }
    }

    const container = document.getElementById('nv-compare-container');
    if (container) {
      container.innerHTML = '';
      container.classList.add('compare-pane-hidden');
    }

    this.module = null;
    this._initPromise = null;
    this.isActive = false;

    if (window.nvModule) {
      window.nvModule.compareVolume = null;
      if (typeof window.nvModule.updateVolumeList === 'function') {
        window.nvModule.updateVolumeList();
      }
    }

    if (window.viewManager?.deactivateCompareColumn) {
      window.viewManager.deactivateCompareColumn();
    }
    window.jointHist?.refresh?.();
  }
}

// For backward compatibility or standalone use
export async function initNiivueApp(containerId, options = {}) {
  const module = new NiivueModule({ showFovDefault: false, ...options });
  module.renderFull(containerId);
  // Do not await initPyodide here, it can run in background
  module.initPyodide();
  module.loadDefaultCachePhantom().catch((e) => console.warn("Default cache phantom:", e));
  return {
    nv: module.nv,
    loadUrl: module.loadUrl.bind(module),
    loadDefaultCachePhantom: module.loadDefaultCachePhantom.bind(module),
    loadPhantomFromCache: module.loadPhantomFromCache.bind(module),
    loadBundledDefaultPhantom: module.loadBundledDefaultPhantom.bind(module),
  };
}
