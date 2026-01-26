import { Niivue, NVMesh, NVImage, SLICE_TYPE, DRAG_MODE, SHOW_RENDER } from "https://unpkg.com/@niivue/niivue@0.65.0/dist/index.js";
import { eventHub } from "./event_hub.js";

export class NiivueModule {
  constructor(options = {}) {
    this.instanceId = Math.random().toString(36).substr(2, 5);
    this.canvasId = `gl-${Math.random().toString(36).substr(2, 9)}`;
    this.options = options;
    this.nv = new Niivue({ logging: false });
    this.pyodide = options.pyodide || null;
    
    // State properties
    this.fovMeshData = null;
    this.voxelSpacingMm = null;
    this.fullFovMm = null;
    this.fovMesh = null;
    this.isAddingVolume = false;
    this.currentAxCorSag = null;
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
    this.dragStartOffsets = null;
    this.fovUpdatePending = false;

    // Elements (will be set in render methods)
    this.containerViewer = null;
    this.containerControls = null;
    this.canvas = null;
    this.statusOverlay = null;
    this.statusText = null;
    this.fileInput = null;
    this.btnDemo = null;
    this.showFov = null;
    this.sliceMM = null;
    this.radiological = null;
    this.showRender = null;
    this.showCrosshair = null;
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
    this.downloadFovMeshBtn = null;
    this.azVal = null;
    this.elVal = null;
    this.voxVal = null;
    this.mmVal = null;
    this.locStrVal = null;
    this.volumeListContainer = null;
    this.btnNewFile = null;
    this.btnAddFile = null;
    this.resampleToFovBtn = null;
    
    this.DEMO_URL = "https://niivue.github.io/niivue-demo-images/mni152.nii.gz";
    this.FOV_RGBA255 = new Uint8Array([255, 220, 0, 255]);
    this.isInitialized = false;
    this._initWaiters = [];
  }

  waitForInit() {
    if (this.isInitialized) return Promise.resolve();
    return new Promise(resolve => this._initWaiters.push(resolve));
  }

  renderViewer(target) {
    this.containerViewer = typeof target === 'string' ? document.getElementById(target) : target;
    if (!this.containerViewer) throw new Error(`Viewer target not found: ${target}`);

    this.containerViewer.classList.add('niivue-app');
    this.containerViewer.innerHTML = `
      <div class="viewer standalone-viewer">
        <canvas id="${this.canvasId}"></canvas>
        <div class="status" id="statusOverlay-${this.instanceId}">idle</div>
      </div>
    `;

    this.canvas = this.containerViewer.querySelector(`#${this.canvasId}`);
    this.statusOverlay = this.containerViewer.querySelector(`#statusOverlay-${this.instanceId}`);
    
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
          ${this._getPanelSourceHtml()}
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
            <button class="tab-btn active" data-tab="source">VIEWER</button>
            <button class="tab-btn" data-tab="view">OPTIONS</button>
            <button class="tab-btn" data-tab="fov">FOV</button>
          </div>
          <div class="tabs-content">
            <div class="tab-pane active" id="tab-source-${this.instanceId}">${this._getPanelSourceHtml()}</div>
            <div class="tab-pane" id="tab-view-${this.instanceId}">${this._getPanelViewHtml()}</div>
            <div class="tab-pane" id="tab-fov-${this.instanceId}">
                <div class="panel-flat">
                    ${this._getPanelFovHtml(true)}
                    <div style="margin-top: 12px; border-top: 1px solid var(--border); padding-top: 12px;">
                        ${this._getPanelExportHtml(true)}
                    </div>
                </div>
            </div>
          </div>
        </div>
      `;
      
      // Bind tab switching
      const buttons = this.containerControls.querySelectorAll('.tab-btn');
      const panes = this.containerControls.querySelectorAll('.tab-pane');
      buttons.forEach(btn => {
        btn.onclick = () => {
          if (window.viewManager && window.viewManager.currentMode !== 'planning') {
            window.viewManager.setMode('planning');
          }
          buttons.forEach(b => b.classList.remove('active'));
          panes.forEach(p => p.classList.remove('active'));
          btn.classList.add('active');
          const tab = btn.dataset.tab;
          this.containerControls.querySelector(`#tab-${tab}-${this.instanceId}`).classList.add('active');
        };
      });
    }

    this.bindControlElements();
    this.setupEventListeners();
    // Do not auto-initialize Pyodide here; let the bootstrap process handle it
    // or call it manually if needed.
  }

  _getPanelSourceHtml() {
    return `
        <div id="panel-viewer-controls-${this.instanceId}" class="panel-flat" style="display: flex; flex-direction: column; height: 100%; box-sizing: border-box; overflow: hidden;">
          <h3 class="panel-title">VIEWER</h3>
          <div class="row" style="display: flex; flex-direction: column; gap: 4px; flex-shrink: 0;">
            <div style="display: flex; gap: 4px;">
              <button id="btn-add-file-${this.instanceId}" class="btn primary" style="flex: 1; padding: 4px 2px;">Add File</button>
              <button id="load-demo-${this.instanceId}" class="btn primary" style="flex: 1; padding: 4px 2px;">Load demo</button>
              <input id="file-${this.instanceId}" type="file" accept=".nii,.nii.gz,.gz" style="display: none;" />
            </div>
          </div>
          <div id="volume-list-${this.instanceId}" style="margin-top: 6px; display: flex; flex-direction: column; gap: 4px; flex: 1; overflow-y: auto; border-top: 1px solid var(--border); padding-top: 4px;">
            <!-- Volume checkboxes will be added here -->
          </div>
        </div>
    `;
  }

  _getPanelViewHtml() {
    return `
        <div class="panel-flat">
          <h3 class="panel-title">OPTIONS</h3>
          <div class="row" style="grid-template-columns: 1fr 1fr; gap: 4px;">
            <label class="toggle"><input id="showFov-${this.instanceId}" type="checkbox" checked /> FOV Box</label>
            <label class="toggle"><input id="sliceMM-${this.instanceId}" type="checkbox" /> Slice MM</label>
            <label class="toggle"><input id="radiological-${this.instanceId}" type="checkbox" /> Radio.</label>
            <label class="toggle"><input id="showRender-${this.instanceId}" type="checkbox" checked /> 3D Render</label>
            <label class="toggle"><input id="showCrosshair-${this.instanceId}" type="checkbox" checked /> Crosshair</label>
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
            Ctrl+Middle: Zoom
          </div>
        </div>
    `;
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
          <h3 class="panel-title">Export & Mask</h3>
          <div class="sliderGroup">
            <div class="sliderRow">
              <div>Mask X</div>
              <div class="input-sync">
                <input id="maskXVal-${this.instanceId}" type="number" class="num-input" step="1" />
                <input id="maskX-${this.instanceId}" type="range" min="16" max="512" step="1" value="128" />
              </div>
            </div>
            <div class="sliderRow">
              <div>Mask Y</div>
              <div class="input-sync">
                <input id="maskYVal-${this.instanceId}" type="number" class="num-input" step="1" />
                <input id="maskY-${this.instanceId}" type="range" min="16" max="512" step="1" value="128" />
              </div>
            </div>
            <div class="sliderRow">
              <div>Mask Z</div>
              <div class="input-sync">
                <input id="maskZVal-${this.instanceId}" type="number" class="num-input" step="1" />
                <input id="maskZ-${this.instanceId}" type="range" min="1" max="512" step="1" value="1" />
              </div>
            </div>
          </div>
          <div class="row" style="margin-top: 12px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
            <button id="downloadFovMesh-${this.instanceId}" class="btn primary" type="button">
              Download FOV + NIfTI
            </button>
            <button id="resampleToFov-${this.instanceId}" class="btn" type="button" disabled title="Wait for Pyodide to load...">
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
      <div class="layout">
        <div id="viewer-slot-${this.instanceId}"></div>
        <div id="controls-slot-${this.instanceId}"></div>
      </div>
    `;

    this.renderViewer(`viewer-slot-${this.instanceId}`);
    this.renderControls(`controls-slot-${this.instanceId}`);
  }

  bindControlElements() {
    const root = this.containerControls || document;
    const qs = (id) => root.querySelector(`#${id}-${this.instanceId}`);
    this.statusText = qs("statusText");
    this.fileInput = qs("file");
    this.btnDemo = qs("load-demo");
    this.showFov = qs("showFov");
    this.sliceMM = qs("sliceMM");
    this.radiological = qs("radiological");
    this.showRender = qs("showRender");
    this.showCrosshair = qs("showCrosshair");
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
    this.downloadFovMeshBtn = qs("downloadFovMesh");
    this.azVal = qs("azVal");
    this.elVal = qs("elVal");
    this.voxVal = qs("voxVal");
    this.mmVal = qs("mmVal");
    this.locStrVal = qs("locStrVal");
    this.volumeListContainer = qs("volume-list");
    this.btnAddFile = qs("btn-add-file");
    this.resampleToFovBtn = qs("resampleToFov");
  }

  triggerHighlight() {
    const target = this.containerViewer ? this.containerViewer.querySelector('.viewer') : null;
    if (!target) return;
    
    target.classList.remove('highlight-add');
    void target.offsetWidth; // Force reflow
    target.classList.add('highlight-add');
  }

  async initNiivue() {
    if (!this.canvas) return;
    
    this.nv.setMultiplanarLayout(3); 
    this.nv.opts.multiplanarShowRender = SHOW_RENDER.ALWAYS;
    if (this.showRender) this.showRender.checked = true;
    this.nv.scene.pan2Dxyzmm[3] = 0.9;
    
    this.setStatus("initializing…");
    await this.nv.attachTo(this.canvasId);
    
    try {
      this.nv.setSliceType(SLICE_TYPE.MULTIPLANAR);
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
      } catch (e) { console.warn("onLocationChange handler failed", e); }
    };

    this.canvas.addEventListener("mousedown", (e) => this.handleMouseDown(e), { capture: true });
    window.addEventListener("mousemove", (e) => this.handleMouseMove(e));
    window.addEventListener("mouseup", () => this.handleMouseUp());
    this.canvas.addEventListener("wheel", (e) => this.handleWheel(e), { passive: false, capture: true });

    setInterval(() => this.updateAngles(), 200);
    this.setStatus("ready");
    this.isInitialized = true;
    this._initWaiters.forEach(resolve => resolve());
    this._initWaiters = [];
  }

  async initPyodide() {
    try {
      if (!this.pyodide) {
        if (typeof loadPyodide === 'undefined') {
          console.warn("loadPyodide not found. Python resampling will not be available.");
          if (this.pyodideStatus) this.pyodideStatus.textContent = "Python (Pyodide): unavailable";
          return;
        }
        if (this.pyodideStatus) this.pyodideStatus.textContent = "Python (Pyodide): loading core...";
        this.pyodide = await loadPyodide();
        if (this.pyodideStatus) this.pyodideStatus.textContent = "Python (Pyodide): loading numpy/scipy...";
        await this.pyodide.loadPackage(["numpy", "scipy", "micropip"]);
        if (this.pyodideStatus) this.pyodideStatus.textContent = "Python (Pyodide): installing nibabel...";
        await this.pyodide.runPythonAsync(`
          import micropip
          await micropip.install('nibabel')
        `);
      } else {
        if (this.pyodideStatus) this.pyodideStatus.textContent = "Python (Pyodide): ready (shared)";
      }
      
      await this.pyodide.runPythonAsync(`
import numpy as np
import nibabel as nib
from scipy.ndimage import map_coordinates
import io

def resample_to_reference(source_img, reference_img, order=3):
    source_data = source_img.get_fdata(dtype=np.float32)
    source_affine = source_img.affine.astype(np.float32)
    reference_affine = reference_img.affine.astype(np.float32)
    reference_shape = reference_img.shape[:3]
    
    extra_dims = source_data.shape[3:]
    output_shape = reference_shape + extra_dims
    resampled_data = np.zeros(output_shape, dtype=np.float32)
    
    source_affine_inv = np.linalg.inv(source_affine)
    vox_to_vox = source_affine_inv @ reference_affine
    
    for z in range(reference_shape[2]):
        x_grid, y_grid = np.meshgrid(
            np.arange(reference_shape[0], dtype=np.float32),
            np.arange(reference_shape[1], dtype=np.float32),
            indexing='ij'
        )
        z_grid = np.full_like(x_grid, z, dtype=np.float32)
        
        coords_slice = np.stack([x_grid, y_grid, z_grid, np.ones_like(x_grid)], axis=-1)
        coords_slice_flat = coords_slice.reshape(-1, 4)
        
        source_coords_slice = np.dot(coords_slice_flat, vox_to_vox.T)[:, :3]
        
        sc_x = source_coords_slice[:, 0].reshape(reference_shape[0], reference_shape[1])
        sc_y = source_coords_slice[:, 1].reshape(reference_shape[0], reference_shape[1])
        sc_z = source_coords_slice[:, 2].reshape(reference_shape[0], reference_shape[1])
        
        if not extra_dims:
            resampled_data[:, :, z] = map_coordinates(
                source_data,
                [sc_x, sc_y, sc_z],
                order=order, mode='constant', cval=0.0, prefilter=False
            )
        else:
            for idx in np.ndindex(extra_dims):
                full_idx_src = (slice(None), slice(None), slice(None)) + idx
                full_idx_dst = (slice(None), slice(None), z) + idx
                resampled_data[full_idx_dst] = map_coordinates(
                    source_data[full_idx_src],
                    [sc_x, sc_y, sc_z],
                    order=order, mode='constant', cval=0.0, prefilter=False
                )
    
    new_header = source_img.header.copy()
    resampled_img = nib.Nifti1Image(resampled_data, reference_affine, header=new_header)
    resampled_img.set_sform(reference_affine, code=2)
    resampled_img.set_qform(reference_affine, code=2)
    
    ref_zooms = reference_img.header.get_zooms()[:3]
    src_zooms = source_img.header.get_zooms()
    new_zooms = list(ref_zooms)
    if len(src_zooms) > 3:
        new_zooms.extend(src_zooms[3:])
    resampled_img.header.set_zooms(new_zooms)
    return resampled_img

def run_resampling(source_bytes, reference_bytes):
    source_bytes = source_bytes.to_py()
    reference_bytes = reference_bytes.to_py()
    source_fh = nib.FileHolder(fileobj=io.BytesIO(source_bytes))
    source_img = nib.Nifti1Image.from_file_map({'header': source_fh, 'image': source_fh})
    ref_fh = nib.FileHolder(fileobj=io.BytesIO(reference_bytes))
    ref_img = nib.Nifti1Image.from_file_map({'header': ref_fh, 'image': ref_fh})
    resampled_img = resample_to_reference(source_img, ref_img, order=1)
    out_fh = io.BytesIO()
    resampled_img.to_file_map({'header': nib.FileHolder(fileobj=out_fh), 'image': nib.FileHolder(fileobj=out_fh)})
    return out_fh.getvalue()
      `);
      
      if (this.pyodideStatus) this.pyodideStatus.textContent = "Python (Pyodide): ready";
      if (this.resampleToFovBtn) {
        this.resampleToFovBtn.disabled = false;
        this.resampleToFovBtn.title = "Resample current volume to match FOV grid";
      }
    } catch (e) {
      console.error(e);
      if (this.pyodideStatus) this.pyodideStatus.textContent = "Python (Pyodide): error " + e.message;
    }
  }

  setupEventListeners() {
    this.btnAddFile.addEventListener("click", () => {
      this.isAddingVolume = true;
      this.fileInput.click();
    });

    this.showFov.addEventListener("change", () => this.requestFovUpdate());
    this.sliceMM.addEventListener("change", () => this.nv.setSliceMM(this.sliceMM.checked));
    this.radiological.addEventListener("change", () => this.nv.setRadiologicalConvention(this.radiological.checked));
    this.showRender.addEventListener("change", () => { 
      this.nv.opts.multiplanarShowRender = this.showRender.checked ? SHOW_RENDER.ALWAYS : SHOW_RENDER.NEVER; 
      this.nv.drawScene(); 
    });
    this.showCrosshair.addEventListener("change", () => this.nv.setCrosshairWidth(this.showCrosshair.checked ? 1 : 0));

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
    this.syncFovLabels();

    this.downloadFovMeshBtn.addEventListener("click", () => this.handleDownloadFovMesh());
    this.resampleToFovBtn.addEventListener("click", () => this.handleResampleToFov());
    this.btnDemo.onclick = () => this.loadUrl(this.DEMO_URL, "mni152.nii.gz", true);
    this.fileInput.onchange = (e) => { 
      const f=e.target.files?.[0]; 
      if(f){ 
        const u=URL.createObjectURL(f); 
        this.loadUrl(u, f.name, this.isAddingVolume).finally(()=>{ 
          setTimeout(()=>URL.revokeObjectURL(u),30000); 
          e.target.value=""; 
        }); 
      } 
    };
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

  setStatus(s) {
    if (this.statusText) this.statusText.textContent = s;
    if (this.statusOverlay) this.statusOverlay.textContent = s;
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
            this.setStatus("Zooming 2D...");
            return;
         }

         // Ctrl + Mouse Drag: FOV Actions
         if (e.ctrlKey) {
            e.preventDefault();
            this.savedDragMode = this.nv.opts.dragMode;
            this.nv.opts.dragMode = DRAG_MODE.callbackOnly;
            if (e.button === 2) {
                this.dragStartTileIndex = this.updateViewFromMouse(e);
                this.isRotatingFov = true;
                let startVal = 0;
                if (this.currentAxCorSag === 0) startVal = Number(this.fovRotZ.value);
                else if (this.currentAxCorSag === 1) startVal = Number(this.fovRotY.value);
                else startVal = Number(this.fovRotX.value);
                this.dragStartRotation = startVal;
                this.dragStartAngle = this.getMouseAngle(e);
                this.setStatus("Rotating FOV...");
            } else if (e.button === 0) {
                this.dragStartTileIndex = this.updateViewFromMouse(e);
                this.isDraggingFov = true;
                this.dragStartMm = this.getMouseMm(e, this.dragStartTileIndex); 
                this.dragStartOffsets = [Number(this.fovOffX.value), Number(this.fovOffY.value), Number(this.fovOffZ.value)];
                this.setStatus("Dragging FOV...");
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
         if (this.isDraggingFov && this.dragStartOffsets) {
            e.preventDefault();
            e.stopPropagation();
            const currMm = this.getMouseMm(e, this.dragStartTileIndex);
            if (currMm && this.dragStartMm) {
               const dx = currMm[0] - this.dragStartMm[0];
               const dy = currMm[1] - this.dragStartMm[1];
               const dz = currMm[2] - this.dragStartMm[2];
               this.fovOffX.value = String((this.dragStartOffsets[0] + dx).toFixed(1));
               this.fovOffY.value = String((this.dragStartOffsets[1] + dy).toFixed(1));
               this.fovOffZ.value = String((this.dragStartOffsets[2] + dz).toFixed(1));
               this.rebuildFovLive();
            }
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
             if (this.currentAxCorSag === 0) this.fovRotZ.value = String(norm(finalRot).toFixed(1));
             else if (this.currentAxCorSag === 1) this.fovRotY.value = String(norm(finalRot).toFixed(1));
             else this.fovRotX.value = String(norm(finalRot).toFixed(1));
             this.rebuildFovLive();
         }
  }

  handleMouseUp() {
         if (this.isZooming2D) { 
            this.isZooming2D = false; 
            this.zoomStartPan = null;
            this.nv.opts.dragMode = this.savedDragMode;
            this.setStatus("Zoom 2D finished"); 
            this.syncFovLabels(); 
         }
         if (this.isDraggingFov) { this.isDraggingFov = false; this.nv.opts.dragMode = this.savedDragMode; this.setStatus("FOV Drag finished"); this.syncFovLabels(); }
         if (this.isRotatingFov) { this.isRotatingFov = false; this.nv.opts.dragMode = this.savedDragMode; this.setStatus("FOV Rotate finished"); this.syncFovLabels(); }
  }

  handleWheel(e) {
          if (window.viewManager && window.viewManager.currentMode !== 'planning') {
              window.viewManager.setMode('planning');
          }

          if (e.ctrlKey) {
              e.preventDefault();
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
                  this.setStatus(`Resized FOV: ${newVal} mm`);
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

  getVolumeInfo() {
    const vol = this.nv.volumes?.[0];
    const hdr = vol?.hdr ?? vol?.header ?? null;
    const dimRaw = hdr?.dims ?? hdr?.dim ?? vol?.dims ?? vol?.dim ?? null;
    let dim3 = null;
    if (Array.isArray(dimRaw)) {
      if (dimRaw.length >= 4) dim3 = [dimRaw[1], dimRaw[2], dimRaw[3]];
      else if (dimRaw.length === 3) dim3 = [dimRaw[0], dimRaw[1], dimRaw[2]];
    }
    const affine = hdr?.affine ?? vol?.affine ?? vol?.matRAS ?? vol?.mat?.affine ?? null;
    return { vol, hdr, dim3, affine };
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
    if (typeof vol?.vox2mm === "function") {
      return (x, y, z) => {
        try {
          const out = vol.vox2mm([x, y, z]);
          if ((Array.isArray(out) || ArrayBuffer.isView(out)) && out.length >= 3) return [Number(out[0]), Number(out[1]), Number(out[2])];
        } catch (e) {}
          const w = this.voxelToWorldFactory(affine)(x, y, z);
        return [Number(w[0]), Number(w[1]), Number(w[2])];
      };
    }
    return this.voxelToWorldFactory(affine);
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
    const fullMm = this.fullFovMm ?? [dx * sxMm, dy * syMm, dz * szMm];
    const baseFOVoffsetMm = [-fullMm[0]/2, -fullMm[1]/2, -fullMm[2]/2];
    const cx = (dx-1)/2 + (offMmX + baseFOVoffsetMm[0])/sxMm;
    const cy = (dy-1)/2 + (offMmY + baseFOVoffsetMm[1])/syMm;
    const cz = (dz-1)/2 + (offMmZ + baseFOVoffsetMm[2])/szMm;
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
    this.zoom2DVal.value = parseFloat(this.zoom2D.value).toFixed(2);
  }

  rebuildFovLive(forceSync = false) {
    if (forceSync) this.syncFovLabels();
    if (this.showFov && this.showFov.checked && this.nv.volumes?.length) this.requestFovUpdate();
  }

  bindBiDirectional(slider, numInput, callback) {
    if (!slider || !numInput) return;
    slider.addEventListener("input", () => { numInput.value = slider.value; if (callback) callback(); });
    numInput.addEventListener("input", () => { if (numInput.value !== "") { slider.value = numInput.value; if (callback) callback(); } });
  }

  generateFovMaskNifti() {
    const geometry = this.getFovGeometry();
    const fovCenterWorld = geometry.centerWorld, fovSizeMm = geometry.sizeMm, fovRotDeg = geometry.rotationDeg;
    const mDims = [Number(this.maskX.value), Number(this.maskY.value), Number(this.maskZ.value)];
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

  downloadVolume(vol) {
    try {
      const bytes = this.getVolumeNifti(vol);
      const url = URL.createObjectURL(new Blob([bytes], {type: "application/octet-stream"}));
      const a = document.createElement("a"); a.href = url;
      const fname = vol.name || "volume.nii"; a.download = fname.endsWith(".gz") ? fname : fname + (fname.endsWith(".nii") ? "" : ".nii");
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
      this.setStatus(`Downloaded: ${a.download}`);
    } catch (e) { console.error(e); this.setStatus(`Download error: ${e.message}`); }
  }

  handleDownloadFovMesh() {
    try {
      if (!this.fovMeshData) { this.setStatus("No FOV data yet"); return; }
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
      const maskBytes = this.generateFovMaskNifti();
      const maskUrl = URL.createObjectURL(new Blob([maskBytes]));
      const maskLink = document.createElement("a"); maskLink.href = maskUrl; maskLink.download = "fov-mask.nii"; maskLink.click();
      if (this.nv.volumes?.length) setTimeout(() => this.downloadVolume(this.nv.volumes[0]), 300);
      this.setStatus("Downloading STL + mask + volume...");
    } catch (e) { console.error(e); this.setStatus(`Error: ${e.message}`); }
  }

  async handleResampleToFov() {
    if (!this.pyodide || !this.nv.volumes?.length) return;
    try {
      this.resampleToFovBtn.disabled = true; this.setStatus("Resampling...");
      const src = this.getVolumeNifti(this.nv.volumes[0]), ref = this.generateFovMaskNifti();
      this.pyodide.globals.set("source_bytes", src); this.pyodide.globals.set("reference_bytes", ref);
      let res = await this.pyodide.runPythonAsync(`run_resampling(source_bytes, reference_bytes)`);
      const bytes = (res && res.toJs) ? res.toJs() : res; if(res.destroy) res.destroy();
      const url = URL.createObjectURL(new Blob([bytes]));
      const name = (this.nv.volumes[0].name || "vol").replace(/\.nii(\.gz)?$/, "") + "_resampled.nii";
      await this.nv.addVolumesFromUrl([{ url, name, colormap: "gray", opacity: 1.0 }]);
      this.updateVolumeList(); 
      this.triggerHighlight();
      this.setStatus(`✓ Resampled: ${name}`);
    } catch (e) { console.error(e); this.setStatus(`Error: ${e.message}`); } finally { this.resampleToFovBtn.disabled = false; }
  }

  updateVolumeList() {
    if (!this.volumeListContainer) return;
    this.volumeListContainer.innerHTML = "";
    
    // Reverse order to match scan order (newest on top)
    const reversedVolumes = [...this.nv.volumes].reverse();
    const reversedIndices = this.nv.volumes.map((_, i) => i).reverse();

    reversedVolumes.forEach((vol, i) => {
      const originalIndex = reversedIndices[i];
      const row = document.createElement("div"); 
      row.className = "volume-row";
      row.style.background = "rgba(255,255,255,0.03)";
      row.style.border = "1px solid rgba(255,255,255,0.08)";
      row.style.padding = "4px 8px";
      row.style.borderRadius = "4px";
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.gap = "8px";
      row.style.marginBottom = "4px";
      row.style.cursor = "pointer";

      // 1. Checkbox (similar to scan list)
      const cb = document.createElement("input"); 
      cb.type = "checkbox"; 
      cb.checked = vol.opacity > 0; 
      cb.onchange = (e) => {
          e.stopPropagation();
          this.nv.setOpacity(originalIndex, cb.checked ? (vol.opacity === 0 ? 1 : vol.opacity) : 0);
      };

      // 2. Info container (title + meta)
      const info = document.createElement("div");
      info.style.flex = "1";
      info.style.display = "flex";
      info.style.flexDirection = "column";
      info.style.overflow = "hidden";

      let titleText = vol.name || `Vol ${originalIndex + 1}`;
      let metaText = "Imported File";

      // Try to parse scan filename: scan_NUMBER_YYYY-MM-DD_HH-mm-ss_SequenceName.nii.gz
      const scanMatch = titleText.match(/^scan_(\d+)_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})_(.*)\.nii/);
      if (scanMatch) {
          const scanNum = scanMatch[1];
          const timeStr = scanMatch[3].replace(/-/g, ':');
          titleText = `${scanNum}. ${scanMatch[4].replace(/\.nii.*/, '')}`;
          metaText = timeStr;
          row.style.borderLeft = "3px solid #22c55e"; // Match SCAN module "done" color
      } else if (titleText.toLowerCase().includes("mask")) {
          row.style.borderLeft = "3px solid #3b82f6"; // Primary blue for masks
      } else {
          row.style.borderLeft = "3px solid transparent";
      }

      const title = document.createElement("div");
      title.textContent = titleText;
      title.style.fontSize = "12px";
      title.style.fontWeight = "500";
      title.style.whiteSpace = "nowrap";
      title.style.overflow = "hidden";
      title.style.textOverflow = "ellipsis";

      const meta = document.createElement("div");
      meta.textContent = metaText;
      meta.style.fontSize = "10px";
      meta.style.color = "var(--muted)";
      meta.style.marginTop = "1px";
      meta.style.opacity = "0.8";

      info.appendChild(title);
      info.appendChild(meta);

      // 3. Actions
      const actions = document.createElement("div");
      actions.style.display = "flex";
      actions.style.gap = "4px";
      actions.style.alignItems = "center";

      const dl = document.createElement("button"); 
      dl.innerHTML = "↓"; 
      dl.className = "btn"; 
      dl.style.padding = "2px 6px"; 
      dl.style.fontSize = "10px";
      dl.style.height = "20px";
      dl.onclick = (e) => { e.stopPropagation(); this.downloadVolume(vol); };

      const rm = document.createElement("button"); 
      rm.textContent = "×"; 
      rm.className = "btn"; 
      rm.style.padding = "2px 6px"; 
      rm.style.fontSize = "10px";
      rm.style.height = "20px";
      rm.onclick = (e) => { e.stopPropagation(); this.nv.removeVolume(vol); this.updateVolumeList(); };

      row.appendChild(cb);
      row.appendChild(info);
      actions.appendChild(dl);
      actions.appendChild(rm);
      row.appendChild(actions);

      // Make row clickable to toggle checkbox, but ignore if clicking buttons or checkbox directly
      row.onclick = (e) => {
          if (e.target === cb || e.target.closest('button')) return;
          cb.checked = !cb.checked;
          this.nv.setOpacity(originalIndex, cb.checked ? (vol.opacity === 0 ? 1 : vol.opacity) : 0);
      };

      this.volumeListContainer.appendChild(row);
    });
  }

  async loadUrl(url, name, isAdding = false) {
    await this.waitForInit();
    try {
      this.setStatus(`loading: ${name??url}`);
      if (isAdding) {
          const isMask = name?.toLowerCase().includes("mask");
          await this.nv.addVolumesFromUrl([{ url, name: name??"vol", colormap: isMask?"red":"gray", opacity: isMask?0.8:0.5, cal_min: isMask?0.5:undefined, cal_max: isMask?1:undefined }]);
      } else {
          await this.nv.loadVolumes([{ url, name: name??"vol" }]);
      }
      if (!isAdding || this.nv.volumes.length === 1) {
          const info = this.getVolumeInfo();
          this.voxelSpacingMm = this.estimateVoxelSpacingMm(info);
          if (info.dim3) {
              const [dx, dy, dz] = info.dim3;
              this.fullFovMm = [dx*this.voxelSpacingMm[0], dy*this.voxelSpacingMm[1], dz*this.voxelSpacingMm[2]];
              const sr = (s,n,mm,def) => { s.min=n.min="1"; s.max=n.max="600"; s.step=n.step="1"; s.value=n.value=def?String(def):String(Math.round(mm)); };
              sr(this.fovX,this.fovXVal,this.fullFovMm[0],220); sr(this.fovY,this.fovYVal,this.fullFovMm[1],220); sr(this.fovZ,this.fovZVal,this.fullFovMm[2],10);
              const so = (s,n) => { s.min=n.min="-500"; s.max=n.max="500"; s.step=n.step="0.1"; s.value=n.value="0"; };
              so(this.fovOffX,this.fovOffXVal); so(this.fovOffY,this.fovOffYVal); so(this.fovOffZ,this.fovOffZVal);
          }
      }
      this.syncFovLabels(); this.updateFovMesh(); this.updateVolumeList(); 
      this.triggerHighlight();
      this.setStatus(`loaded: ${name??url}`);
    } catch (e) { this.setStatus(`Error: ${e.message}`); }
  }
}

// For backward compatibility or standalone use
export async function initNiivueApp(containerId, options = {}) {
  const module = new NiivueModule(options);
  module.renderFull(containerId);
  // Do not await initPyodide here, it can run in background
  module.initPyodide();
  // Load demo volume on startup
  module.loadUrl(module.DEMO_URL, "mni152.nii.gz", true);
  return { nv: module.nv, loadUrl: module.loadUrl.bind(module), setStatus: module.setStatus.bind(module) };
}
