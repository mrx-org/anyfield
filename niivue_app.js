import { Niivue, NVMesh, NVImage, SLICE_TYPE, DRAG_MODE, SHOW_RENDER } from "https://unpkg.com/@niivue/niivue@0.65.0/dist/index.js";

export async function initNiivueApp(containerId, options = {}) {
  const container = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
  if (!container) throw new Error(`Container not found: ${containerId}`);

  const canvasId = `gl-${Math.random().toString(36).substr(2, 9)}`;
  const instanceId = Math.random().toString(36).substr(2, 5);
  
  container.classList.add('niivue-app');
  container.innerHTML = `
    <div class="layout">
      <div class="viewer">
        <canvas id="${canvasId}"></canvas>
        <div class="status" id="statusOverlay-${instanceId}">idle</div>
      </div>

      <div class="options-grid">
        <!-- Pane 1: Load file/demo + Status + Note -->
        <div class="panel">
          <h1>Volume Source</h1>
          <div class="row" style="display: flex; flex-direction: column; gap: 8px;">
            <div style="display: flex; gap: 8px;">
              <button id="btn-new-file-${instanceId}" class="btn primary" style="flex: 1;">New File</button>
              <button id="btn-add-file-${instanceId}" class="btn" style="flex: 1;">Add File</button>
              <input id="file-${instanceId}" type="file" accept=".nii,.nii.gz,.gz" style="display: none;" />
            </div>
          <button id="load-demo-${instanceId}" class="btn primary">Load demo (MNI152)</button>
            </div>
          <div id="volume-list-${instanceId}" style="margin-top: 12px; display: flex; flex-direction: column; gap: 4px; max-height: 150px; overflow-y: auto; border-top: 1px solid var(--border); padding-top: 8px;">
            <!-- Volume checkboxes will be added here -->
            </div>
          <div class="stateBox">
            <div class="stateRow">
              <div class="stateKey">Status</div>
              <div class="stateVal auto-wrap" id="statusText-${instanceId}">idle</div>
            </div>
            <div class="stateRow">
              <div class="stateKey">Rotation</div>
              <div class="stateVal">az=<span id="azVal-${instanceId}">—</span>°, el=<span id="elVal-${instanceId}">—</span>°</div>
            </div>
            <div class="stateRow">
              <div class="stateKey">Slices (vox)</div>
              <div class="stateVal"><span id="voxVal-${instanceId}">—</span></div>
            </div>
            <div class="stateRow">
              <div class="stateKey">Location (mm)</div>
              <div class="stateVal"><span id="mmVal-${instanceId}">—</span></div>
            </div>
          </div>
          <div class="kv">
            <div><strong>Note:</strong> Niivue via CDN (unpkg).</div>
            <div style="border-top: 1px solid var(--border); margin-top: 4px; padding-top: 4px;">
              <strong>Info:</strong>
              <div id="locStrVal-${instanceId}" class="stateVal auto-wrap" style="margin-top: 2px;">—</div>
            </div>
          </div>
        </div>

        <!-- Pane 2: Checkboxes and Zoom -->
        <div class="panel">
          <h1>View Options</h1>
          <div class="row" style="grid-template-columns: 1fr 1fr; gap: 4px;">
            <label class="toggle"><input id="showFov-${instanceId}" type="checkbox" checked /> FOV Box</label>
            <label class="toggle"><input id="sliceMM-${instanceId}" type="checkbox" /> Slice MM</label>
            <label class="toggle"><input id="radiological-${instanceId}" type="checkbox" /> Radio.</label>
            <label class="toggle"><input id="showRender-${instanceId}" type="checkbox" checked /> 3D Render</label>
            <label class="toggle"><input id="showCrosshair-${instanceId}" type="checkbox" checked /> Crosshair</label>
          </div>
          <div class="sliderGroup" style="margin-top: 8px;">
            <div class="sliderRow">
              <div>Zoom 2D</div>
              <div class="input-sync">
                <input id="zoom2DVal-${instanceId}" type="number" class="num-input" step="0.05" />
                <input id="zoom2D-${instanceId}" type="range" min="0.2" max="2.0" step="0.05" value="0.9" />
            </div>
            </div>
          </div>
          <div class="hint">
            Ctrl+Left: Move FOV<br>
            Ctrl+Right: Rotate FOV<br>
            Ctrl+Scroll: Resize FOV
          </div>
        </div>

        <!-- Pane 3: FOV size, offset, and rotation sliders -->
        <div class="panel">
          <h1>FOV Parameters</h1>
          <div class="sliderGroup" id="fovControls-${instanceId}">
            <div class="sliderRow">
              <div>Size X (mm)</div>
              <div class="input-sync">
                <input id="fovXVal-${instanceId}" type="number" class="num-input" step="1" />
                <input id="fovX-${instanceId}" type="range" min="1" max="600" step="1" value="220" />
              </div>
            </div>
            <div class="sliderRow">
              <div>Size Y (mm)</div>
              <div class="input-sync">
                <input id="fovYVal-${instanceId}" type="number" class="num-input" step="1" />
                <input id="fovY-${instanceId}" type="range" min="1" max="600" step="1" value="220" />
              </div>
            </div>
            <div class="sliderRow">
              <div>Size Z (mm)</div>
              <div class="input-sync">
                <input id="fovZVal-${instanceId}" type="number" class="num-input" step="1" />
                <input id="fovZ-${instanceId}" type="range" min="1" max="600" step="1" value="100" />
              </div>
            </div>
            <div class="sliderRow" style="margin-top: 2px; border-top: 1px solid var(--border); padding-top: 2px;">
              <div>Off X (mm)</div>
              <div class="input-sync">
                <input id="fovOffXVal-${instanceId}" type="number" class="num-input" step="0.1" />
                <input id="fovOffX-${instanceId}" type="range" min="-100" max="100" step="0.1" value="0" />
              </div>
            </div>
            <div class="sliderRow">
              <div>Off Y (mm)</div>
              <div class="input-sync">
                <input id="fovOffYVal-${instanceId}" type="number" class="num-input" step="0.1" />
                <input id="fovOffY-${instanceId}" type="range" min="-100" max="100" step="0.1" value="0" />
              </div>
            </div>
            <div class="sliderRow">
              <div>Off Z (mm)</div>
              <div class="input-sync">
                <input id="fovOffZVal-${instanceId}" type="number" class="num-input" step="0.1" />
                <input id="fovOffZ-${instanceId}" type="range" min="-100" max="100" step="0.1" value="0" />
              </div>
            </div>
            <div class="sliderRow" style="margin-top: 2px; border-top: 1px solid var(--border); padding-top: 2px;">
              <div>Rot X (deg)</div>
              <div class="input-sync">
                <input id="fovRotXVal-${instanceId}" type="number" class="num-input" step="1" />
                <input id="fovRotX-${instanceId}" type="range" min="-180" max="180" step="1" value="0" />
              </div>
            </div>
            <div class="sliderRow">
              <div>Rot Y (deg)</div>
              <div class="input-sync">
                <input id="fovRotYVal-${instanceId}" type="number" class="num-input" step="1" />
                <input id="fovRotY-${instanceId}" type="range" min="-180" max="180" step="1" value="0" />
              </div>
            </div>
            <div class="sliderRow">
              <div>Rot Z (deg)</div>
              <div class="input-sync">
                <input id="fovRotZVal-${instanceId}" type="number" class="num-input" step="1" />
                <input id="fovRotZ-${instanceId}" type="range" min="-180" max="180" step="1" value="0" />
            </div>
          </div>
        </div>
        </div>

        <!-- Pane 4: FOV mask matrix size and Download button -->
        <div class="panel">
          <h1>Export & Mask</h1>
          <div class="sliderGroup">
            <div class="sliderRow">
              <div>Mask X</div>
              <div class="input-sync">
                <input id="maskXVal-${instanceId}" type="number" class="num-input" step="1" />
                <input id="maskX-${instanceId}" type="range" min="16" max="512" step="1" value="128" />
            </div>
          </div>
            <div class="sliderRow">
              <div>Mask Y</div>
              <div class="input-sync">
                <input id="maskYVal-${instanceId}" type="number" class="num-input" step="1" />
                <input id="maskY-${instanceId}" type="range" min="16" max="512" step="1" value="128" />
          </div>
          </div>
            <div class="sliderRow">
              <div>Mask Z</div>
              <div class="input-sync">
                <input id="maskZVal-${instanceId}" type="number" class="num-input" step="1" />
                <input id="maskZ-${instanceId}" type="range" min="1" max="512" step="1" value="1" />
          </div>
        </div>
          </div>
          <div class="row" style="margin-top: 12px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
            <button id="downloadFovMesh-${instanceId}" class="btn primary" type="button">
              Download FOV + NIfTI
            </button>
            <button id="resampleToFov-${instanceId}" class="btn" type="button" disabled title="Wait for Pyodide to load...">
              Resample to FOV
            </button>
        </div>
          <div id="pyodideStatus-${instanceId}" style="font-size: 10px; color: var(--muted); margin-top: 4px; text-align: center;">
            Python (Pyodide): loading...
          </div>
      </div>
      </div>
    </div>
  `;

  const qs = (id) => container.querySelector(`#${id}-${instanceId}`);

  const DEMO_URL = "https://niivue.github.io/niivue-demo-images/mni152.nii.gz";

  const statusText = qs("statusText");
  const statusOverlay = qs("statusOverlay");
  const fileInput = qs("file");
  const btnDemo = qs("load-demo");
  const showFov = qs("showFov");
  const sliceMM = qs("sliceMM");
  const radiological = qs("radiological");
  const showRender = qs("showRender");
  const showCrosshair = qs("showCrosshair");
  const zoom2D = qs("zoom2D");
  const zoom2DVal = qs("zoom2DVal");
  const fovControls = qs("fovControls");
  const fovX = qs("fovX");
  const fovY = qs("fovY");
  const fovZ = qs("fovZ");
  const fovXVal = qs("fovXVal");
  const fovYVal = qs("fovYVal");
  const fovZVal = qs("fovZVal");
  const fovOffX = qs("fovOffX");
  const fovOffY = qs("fovOffY");
  const fovOffZ = qs("fovOffZ");
  const fovOffXVal = qs("fovOffXVal");
  const fovOffYVal = qs("fovOffYVal");
  const fovOffZVal = qs("fovOffZVal");
  const fovRotX = qs("fovRotX");
  const fovRotY = qs("fovRotY");
  const fovRotZ = qs("fovRotZ");
  const fovRotXVal = qs("fovRotXVal");
  const fovRotYVal = qs("fovRotYVal");
  const fovRotZVal = qs("fovRotZVal");
  const maskX = qs("maskX");
  const maskY = qs("maskY");
  const maskZ = qs("maskZ");
  const maskXVal = qs("maskXVal");
  const maskYVal = qs("maskYVal");
  const maskZVal = qs("maskZVal");
  const downloadFovMesh = qs("downloadFovMesh");
  const azVal = qs("azVal");
  const elVal = qs("elVal");
  const voxVal = qs("voxVal");
  const mmVal = qs("mmVal");
  const locStrVal = qs("locStrVal");
  const volumeListContainer = qs("volume-list");

  const btnNewFile = qs("btn-new-file");
  const btnAddFile = qs("btn-add-file");
  let isAddingVolume = false;

  const resampleToFovBtn = qs("resampleToFov");
  const pyodideStatus = qs("pyodideStatus");
  let pyodide = options.pyodide || null;

  async function initPyodide() {
    try {
      if (!pyodide) {
        pyodideStatus.textContent = "Python (Pyodide): loading core...";
        pyodide = await loadPyodide();
        pyodideStatus.textContent = "Python (Pyodide): loading numpy/scipy...";
        await pyodide.loadPackage(["numpy", "scipy", "micropip"]);
        pyodideStatus.textContent = "Python (Pyodide): installing nibabel...";
        await pyodide.runPythonAsync(`
          import micropip
          await micropip.install('nibabel')
        `);
      } else {
        pyodideStatus.textContent = "Python (Pyodide): ready (shared)";
      }
      
      // Always inject the resampling function (even if shared, to ensure it exists in the namespace)
      await pyodide.runPythonAsync(`
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
      
      pyodideStatus.textContent = "Python (Pyodide): ready";
      resampleToFovBtn.disabled = false;
      resampleToFovBtn.title = "Resample current volume to match FOV grid";
    } catch (e) {
      console.error(e);
      pyodideStatus.textContent = "Python (Pyodide): error " + e.message;
    }
  }
  initPyodide();

  btnNewFile.addEventListener("click", () => {
    isAddingVolume = false;
    fileInput.click();
  });

  btnAddFile.addEventListener("click", () => {
    isAddingVolume = true;
    fileInput.click();
  });


  function affineColToRowMajor(colMajor) {
      return [
          colMajor[0], colMajor[4], colMajor[8], colMajor[12],
          colMajor[1], colMajor[5], colMajor[9], colMajor[13],
          colMajor[2], colMajor[6], colMajor[10], colMajor[14],
          colMajor[3], colMajor[7], colMajor[11], colMajor[15],
      ];
  }

  function setNiftiQform(niftiBytes, affineRowMajor, qformCode = 2, sformCode = 2) {
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

  function setStatus(s) {
    statusText.textContent = s;
    statusOverlay.textContent = s;
  }

  const nv = new Niivue({ logging: false });
  nv.setMultiplanarLayout(3); 
  nv.opts.multiplanarShowRender = SHOW_RENDER.ALWAYS;
  showRender.checked = true;
  nv.scene.pan2Dxyzmm[3] = 0.9;
  
  setStatus("initializing…");
  const canvas = container.querySelector(`#${canvasId}`);
  if (!canvas) {
    console.error(`Canvas element #${canvasId} not found in container:`, container);
    throw new Error(`Required canvas element #${canvasId} missing from Niivue container.`);
  }
  
  await nv.attachTo(canvasId);
  
  try {
    nv.setSliceType(SLICE_TYPE.MULTIPLANAR);
    nv.setSliceMM(sliceMM.checked);
    radiological.checked = nv.getRadiologicalConvention();
  } catch (e) {
    console.warn("Failed to set MULTIPLANAR slice type", e);
  }

  nv.onAzimuthElevationChange = (azimuth, elevation) => {
    const az = Number(azimuth);
    const el = Number(elevation);
    if (Number.isFinite(az)) azVal.textContent = az.toFixed(1);
    if (Number.isFinite(el)) elVal.textContent = el.toFixed(1);
  };

  function readAnglesBestEffort() {
    const candidates = [
      [nv?.opts?.renderAzimuth, nv?.opts?.renderElevation],
      [nv?.opts?.azimuth, nv?.opts?.elevation],
      [nv?.scene?.renderAzimuth, nv?.scene?.renderElevation],
      [nv?.scene?.azimuth, nv?.scene?.elevation],
      [nv?.scene?.cameraAzimuth, nv?.scene?.cameraElevation],
    ];
    for (const [a, e] of candidates) {
      const az = Number(a);
      const el = Number(e);
      if (Number.isFinite(az) && Number.isFinite(el)) return [az, el];
    }
    return null;
  }

  let lastAzEl = null;
  setInterval(() => {
    const pair = readAnglesBestEffort();
    if (!pair) return;
    const [az, el] = pair;
    if (!lastAzEl || az !== lastAzEl[0] || el !== lastAzEl[1]) {
      azVal.textContent = az.toFixed(1);
      elVal.textContent = el.toFixed(1);
      lastAzEl = [az, el];
    }
  }, 200);

  let isDraggingFov = false;
  let isRotatingFov = false;
  let isZooming2D = false;
  let zoomStartMouseY = 0;
  let zoomStartValue = 0;
  let dragStartRotation = 0;
  let dragStartAngle = 0;
  let dragStartTileIndex = -1;
  let dragStartMm = null;
  let dragStartOffsets = null;
  let currentAxCorSag = null; 
  let savedDragMode = DRAG_MODE.contrast;

  nv.onLocationChange = (data) => {
    try {
      const vox = data?.vox;
      const mm = data?.mm;
      const str = data?.str ?? data?.string ?? data?.text ?? null;
      if (typeof data?.axCorSag === "number") currentAxCorSag = data.axCorSag;
      if ((Array.isArray(vox) || ArrayBuffer.isView(vox)) && vox.length >= 3) {
        voxVal.textContent = `${Number(vox[0]).toFixed(1)}, ${Number(vox[1]).toFixed(1)}, ${Number(vox[2]).toFixed(1)}`;
      } else {
        voxVal.textContent = "—";
      }
      if ((Array.isArray(mm) || ArrayBuffer.isView(mm)) && mm.length >= 3) {
        mmVal.textContent = `${Number(mm[0]).toFixed(1)}, ${Number(mm[1]).toFixed(1)}, ${Number(mm[2]).toFixed(1)}`;
      } else {
        mmVal.textContent = "—";
      }
      locStrVal.textContent = str ? String(str) : "—";
    } catch (e) { console.warn("onLocationChange handler failed", e); }
  };

  function updateViewFromMouse(e) {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const x = (e.clientX - rect.left) * dpr;
      const y = (e.clientY - rect.top) * dpr;
      for (let i = 0; i < nv.screenSlices.length; i++) {
          const s = nv.screenSlices[i];
          if (!s.leftTopWidthHeight) continue;
          const [L, T, W, H] = s.leftTopWidthHeight;
          if (x >= L && x <= (L + W) && y >= T && y <= (T + H)) {
              currentAxCorSag = s.axCorSag;
              return i;
          }
      }
      return -1;
  }

  function getMouseMm(e, tileIndex = -1) {
      if (!nv.volumes?.length) return null;
      try {
          const rect = canvas.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          let frac;
          if (tileIndex >= 0) {
                 const dpr = window.devicePixelRatio || 1;
                 const sx = x * dpr;
                 const sy = y * dpr;
                 const slice = nv.screenSlices[tileIndex];
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
                 const vol = nv.volumes[0];
                 frac = vol.convertMM2Frac(rasMM, nv.opts.isSliceMM);
          } else {
                 frac = nv.canvasPos2frac([x, y]); 
          }
          if (!frac || (tileIndex < 0 && frac[0] < 0)) return null; 
          const { vol, dim3, affine } = getVolumeInfo();
          if (!dim3) return null;
          const vx = frac[0] * dim3[0];
          const vy = frac[1] * dim3[1];
          const vz = frac[2] * dim3[2];
          const vox2mm = voxToMmFactory(vol, affine);
          return vox2mm(vx, vy, vz);
      } catch(e) { return null; }
  }

  function getMouseAngle(e) {
      const frac = nv.scene.crosshairPos;
      const tileInfo = nv.frac2canvasPosWithTile(frac, currentAxCorSag);
      if (!tileInfo) return 0;
      const canvasPos = tileInfo.pos;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const pivotX = rect.left + (canvasPos[0] / dpr);
      const pivotY = rect.top + (canvasPos[1] / dpr);
      let angle = Math.atan2(e.clientY - pivotY, e.clientX - pivotX);
      if (currentAxCorSag === 1) angle = -angle;
      if (radiological.checked) {
          if (currentAxCorSag === 0 || currentAxCorSag === 1) angle = -angle;
      }
      return angle;
  }

  canvas.addEventListener("mousedown", (e) => {
         if (e.button === 1) {
            e.preventDefault();
            isZooming2D = true;
            zoomStartMouseY = e.clientY;
            zoomStartValue = Number(zoom2D.value);
            setStatus("Zooming 2D...");
            return;
         }
         if (e.ctrlKey) {
            e.preventDefault();
            savedDragMode = nv.opts.dragMode;
            nv.opts.dragMode = DRAG_MODE.callbackOnly;
            if (e.button === 2) {
                dragStartTileIndex = updateViewFromMouse(e);
                isRotatingFov = true;
                let startVal = 0;
                if (currentAxCorSag === 0) startVal = Number(fovRotZ.value);
                else if (currentAxCorSag === 1) startVal = Number(fovRotY.value);
                else startVal = Number(fovRotX.value);
                dragStartRotation = startVal;
                dragStartAngle = getMouseAngle(e);
                setStatus("Rotating FOV...");
            } else if (e.button === 0) {
                dragStartTileIndex = updateViewFromMouse(e);
                isDraggingFov = true;
                dragStartMm = getMouseMm(e, dragStartTileIndex); 
                dragStartOffsets = [Number(fovOffX.value), Number(fovOffY.value), Number(fovOffZ.value)];
                setStatus("Dragging FOV...");
            }
         }
  }, { capture: true });

  window.addEventListener("mousemove", (e) => {
         if (isZooming2D) {
            const dy = e.clientY - zoomStartMouseY;
            let newVal = zoomStartValue - (dy / 200);
            newVal = Math.max(0.2, Math.min(2.0, newVal));
            zoom2D.value = String(newVal.toFixed(2));
            const pan = nv.scene.pan2Dxyzmm;
            nv.setPan2Dxyzmm([pan[0], pan[1], pan[2], newVal]);
            syncFovLabels();
            rebuildFovLive();
            return;
         }
         if (isDraggingFov && dragStartOffsets) {
            const currMm = getMouseMm(e, dragStartTileIndex);
            if (currMm && dragStartMm) {
               const dx = currMm[0] - dragStartMm[0];
               const dy = currMm[1] - dragStartMm[1];
               const dz = currMm[2] - dragStartMm[2];
               fovOffX.value = String((dragStartOffsets[0] + dx).toFixed(1));
               fovOffY.value = String((dragStartOffsets[1] + dy).toFixed(1));
               fovOffZ.value = String((dragStartOffsets[2] + dz).toFixed(1));
               rebuildFovLive();
            }
         } else if (isRotatingFov) {
             const currAngle = getMouseAngle(e);
             let deltaRad = currAngle - dragStartAngle;
             while (deltaRad <= -Math.PI) deltaRad += 2 * Math.PI;
             while (deltaRad > Math.PI) deltaRad -= 2 * Math.PI;
             let deltaDeg = deltaRad * (180 / Math.PI);
             if (e.shiftKey) deltaDeg *= 0.1;
             let finalRot = dragStartRotation - deltaDeg;
             const norm = (v) => {
                 let n = v % 360;
                 if (n > 180) n -= 360;
                 if (n < -180) n += 360;
                 return n;
             };
             if (currentAxCorSag === 0) fovRotZ.value = String(norm(finalRot).toFixed(1));
             else if (currentAxCorSag === 1) fovRotY.value = String(norm(finalRot).toFixed(1));
             else fovRotX.value = String(norm(finalRot).toFixed(1));
             rebuildFovLive();
         }
  });

  window.addEventListener("mouseup", () => {
         if (isZooming2D) { isZooming2D = false; setStatus("Zoom 2D finished"); syncFovLabels(); }
         if (isDraggingFov) { isDraggingFov = false; nv.opts.dragMode = savedDragMode; setStatus("FOV Drag finished"); syncFovLabels(); }
         if (isRotatingFov) { isRotatingFov = false; nv.opts.dragMode = savedDragMode; setStatus("FOV Rotate finished"); syncFovLabels(); }
  });

  canvas.addEventListener("wheel", (e) => {
          if (e.ctrlKey) {
              e.preventDefault();
              updateViewFromMouse(e);
              if (currentAxCorSag === null) return;
              const delta = e.deltaY > 0 ? -10 : 10; 
              let targetInput = null;
              if (currentAxCorSag === 0) targetInput = fovY;
              else if (currentAxCorSag === 1) targetInput = fovX;
              else if (currentAxCorSag === 2) targetInput = fovZ;
              if (targetInput) {
                  let newVal = Number(targetInput.value) + delta;
                  newVal = Math.max(Number(targetInput.min), Math.min(Number(targetInput.max), newVal));
                  targetInput.value = String(newVal);
                  rebuildFovLive();
                  setStatus(`Resized FOV: ${newVal} mm`);
              }
          }
  }, { passive: false, capture: true });

  setStatus("ready");

  const FOV_RGBA255 = new Uint8Array([255, 220, 0, 255]);
  let fovMesh = null;
  let voxelSpacingMm = null;
  let fullFovMm = null;
  let fovMeshData = null;

  function voxelToWorldFactory(affine) {
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

  function getVolumeInfo() {
    const vol = nv.volumes?.[0];
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

  function estimateVoxelSpacingMm({ vol, hdr, dim3, affine }) {
    const vox2world = voxelToWorldFactory(affine);
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

  function voxToMmFactory(vol, affine) {
    if (typeof vol?.vox2mm === "function") {
      return (x, y, z) => {
        try {
          const out = vol.vox2mm([x, y, z]);
          if ((Array.isArray(out) || ArrayBuffer.isView(out)) && out.length >= 3) return [Number(out[0]), Number(out[1]), Number(out[2])];
        } catch (e) {}
        const w = voxelToWorldFactory(affine)(x, y, z);
        return [Number(w[0]), Number(w[1]), Number(w[2])];
      };
    }
    return voxelToWorldFactory(affine);
  }

  function getFovGeometry() {
    const { vol, dim3, affine } = getVolumeInfo();
    if (!vol || !dim3) throw new Error("No volume loaded.");
    const [dx, dy, dz] = dim3;
    const spacing = voxelSpacingMm ?? [1, 1, 1];
    const sxMm = spacing[0], syMm = spacing[1], szMm = spacing[2];
    const fovMmX = Number(fovX.value), fovMmY = Number(fovY.value), fovMmZ = Number(fovZ.value);
    const offMmX = Number(fovOffX.value), offMmY = Number(fovOffY.value), offMmZ = Number(fovOffZ.value);
    const rotX = Number(fovRotX.value), rotY = Number(fovRotY.value), rotZ = Number(fovRotZ.value);
    const fullMm = fullFovMm ?? [dx * sxMm, dy * syMm, dz * szMm];
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
    const vox2mmDef = voxToMmFactory(vol, affine);
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
    fovMeshData = { vertsWorld, tris: new Uint32Array(tris), centerWorld: fovCenterWorldDef, sizeMm: [fovMmX, fovMmY, fovMmZ], rotationDeg: [rotX, rotY, rotZ] };
    return fovMeshData;
  }

  function updateFovMesh() {
     if (!showFov.checked || !nv.volumes?.length) { if (fovMesh) { nv.removeMesh(fovMesh); fovMesh = null; } return; }
     try {
        const geometry = getFovGeometry();
        if (!fovMesh) {
            fovMesh = new NVMesh(geometry.vertsWorld, geometry.tris, "FOV", FOV_RGBA255, 1.0, true, nv.gl);
            nv.addMesh(fovMesh);
        } else {
            fovMesh.pts = geometry.vertsWorld;
            if (typeof fovMesh.updateMesh === 'function') fovMesh.updateMesh(nv.gl);
        }
        nv.drawScene();
     } catch(e) { console.error("FOV Update failed", e); }
  }

  let fovUpdatePending = false;
  function requestFovUpdate() {
    if (fovUpdatePending) return;
    fovUpdatePending = true;
    requestAnimationFrame(() => { fovUpdatePending = false; updateFovMesh(); });
  }

  showFov.addEventListener("change", requestFovUpdate);
  sliceMM.addEventListener("change", () => nv.setSliceMM(sliceMM.checked));
  radiological.addEventListener("change", () => nv.setRadiologicalConvention(radiological.checked));
  showRender.addEventListener("change", () => { nv.opts.multiplanarShowRender = showRender.checked ? SHOW_RENDER.ALWAYS : SHOW_RENDER.NEVER; nv.drawScene(); });
  showCrosshair.addEventListener("change", () => nv.setCrosshairWidth(showCrosshair.checked ? 1 : 0));

  function syncFovLabels() {
    fovXVal.value = Math.round(Number(fovX.value)); fovYVal.value = Math.round(Number(fovY.value)); fovZVal.value = Math.round(Number(fovZ.value));
    fovOffXVal.value = Number(fovOffX.value).toFixed(1); fovOffYVal.value = Number(fovOffY.value).toFixed(1); fovOffZVal.value = Number(fovOffZ.value).toFixed(1);
    fovRotXVal.value = Math.round(Number(fovRotX.value)); fovRotYVal.value = Math.round(Number(fovRotY.value)); fovRotZVal.value = Math.round(Number(fovRotZ.value));
    maskXVal.value = Math.round(Number(maskX.value)); maskYVal.value = Math.round(Number(maskY.value)); maskZVal.value = Math.round(Number(maskZ.value));
    zoom2DVal.value = parseFloat(zoom2D.value).toFixed(2);
  }

  function rebuildFovLive(forceSync = false) {
    if (forceSync) syncFovLabels();
    if (showFov.checked && nv.volumes?.length) requestFovUpdate();
  }

  function bindBiDirectional(slider, numInput, callback) {
    slider.addEventListener("input", () => { numInput.value = slider.value; if (callback) callback(); });
    numInput.addEventListener("input", () => { if (numInput.value !== "") { slider.value = numInput.value; if (callback) callback(); } });
  }

  bindBiDirectional(zoom2D, zoom2DVal, () => { const pan = nv.scene.pan2Dxyzmm; nv.setPan2Dxyzmm([pan[0], pan[1], pan[2], parseFloat(zoom2D.value)]); syncFovLabels(); });
  bindBiDirectional(fovX, fovXVal, () => rebuildFovLive(true));
  bindBiDirectional(fovY, fovYVal, () => rebuildFovLive(true));
  bindBiDirectional(fovZ, fovZVal, () => rebuildFovLive(true));
  bindBiDirectional(fovOffX, fovOffXVal, () => rebuildFovLive(true));
  bindBiDirectional(fovOffY, fovOffYVal, () => rebuildFovLive(true));
  bindBiDirectional(fovOffZ, fovOffZVal, () => rebuildFovLive(true));
  bindBiDirectional(fovRotX, fovRotXVal, () => rebuildFovLive(true));
  bindBiDirectional(fovRotY, fovRotYVal, () => rebuildFovLive(true));
  bindBiDirectional(fovRotZ, fovRotZVal, () => rebuildFovLive(true));
  bindBiDirectional(maskX, maskXVal, syncFovLabels);
  bindBiDirectional(maskY, maskYVal, syncFovLabels);
  bindBiDirectional(maskZ, maskZVal, syncFovLabels);
  syncFovLabels();

  function generateFovMaskNifti() {
    const geometry = getFovGeometry();
    const fovCenterWorld = geometry.centerWorld, fovSizeMm = geometry.sizeMm, fovRotDeg = geometry.rotationDeg;
    const mDims = [Number(maskX.value), Number(maskY.value), Number(maskZ.value)];
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
    return setNiftiQform(niftiBytes, affineRow, 2);
  }

  function getVolumeNifti(vol) {
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
    if (!affineRow) affineRow = affineColToRowMajor(vol.matRAS);
    const sx = Math.hypot(affineRow[0], affineRow[4], affineRow[8]), sy = Math.hypot(affineRow[1], affineRow[5], affineRow[9]), sz = Math.hypot(affineRow[2], affineRow[6], affineRow[10]);
    const finalPixDims = [sx, sy, sz]; for (let i=4; i<=rank; i++) finalPixDims.push(pixDims[i] || 1.0);
    let niftiBytes = NVImage.createNiftiArray(niftiDims, finalPixDims, affineRow, hdr?.datatypeCode ?? 16, vol.img);
    return setNiftiQform(niftiBytes, affineRow, 2);
  }

  function downloadVolume(vol) {
    try {
      const bytes = getVolumeNifti(vol);
      const url = URL.createObjectURL(new Blob([bytes], {type: "application/octet-stream"}));
      const a = document.createElement("a"); a.href = url;
      const fname = vol.name || "volume.nii"; a.download = fname.endsWith(".gz") ? fname : fname + (fname.endsWith(".nii") ? "" : ".nii");
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
      setStatus(`Downloaded: ${a.download}`);
    } catch (e) { console.error(e); setStatus(`Download error: ${e.message}`); }
  }

  downloadFovMesh.addEventListener("click", () => {
    try {
      if (!fovMeshData) { setStatus("No FOV data yet"); return; }
      const geometry = fovMeshData;
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
      const maskBytes = generateFovMaskNifti();
      const maskUrl = URL.createObjectURL(new Blob([maskBytes]));
      const maskLink = document.createElement("a"); maskLink.href = maskUrl; maskLink.download = "fov-mask.nii"; maskLink.click();
      if (nv.volumes?.length) setTimeout(() => downloadVolume(nv.volumes[0]), 300);
      setStatus("Downloading STL + mask + volume...");
    } catch (e) { console.error(e); setStatus(`Error: ${e.message}`); }
  });

  resampleToFovBtn.addEventListener("click", async () => {
    if (!pyodide || !nv.volumes?.length) return;
    try {
      resampleToFovBtn.disabled = true; setStatus("Resampling...");
      const src = getVolumeNifti(nv.volumes[0]), ref = generateFovMaskNifti();
      pyodide.globals.set("source_bytes", src); pyodide.globals.set("reference_bytes", ref);
      let res = await pyodide.runPythonAsync(`run_resampling(source_bytes, reference_bytes)`);
      const bytes = (res && res.toJs) ? res.toJs() : res; if(res.destroy) res.destroy();
      const url = URL.createObjectURL(new Blob([bytes]));
      const name = (nv.volumes[0].name || "vol").replace(/\.nii(\.gz)?$/, "") + "_resampled.nii";
      await nv.addVolumesFromUrl([{ url, name, colormap: "gray", opacity: 1.0 }]);
      updateVolumeList(); setStatus(`✓ Resampled: ${name}`);
    } catch (e) { console.error(e); setStatus(`Error: ${e.message}`); } finally { resampleToFovBtn.disabled = false; }
  });

  function updateVolumeList() {
    volumeListContainer.innerHTML = "";
    nv.volumes.forEach((vol, index) => {
      const row = document.createElement("div"); row.className = "toggle"; row.style.justifyContent="space-between"; row.style.background="rgba(255,255,255,0.03)"; row.style.padding="4px"; row.style.borderRadius="4px";
      const left = document.createElement("div"); left.style.display="flex"; left.style.gap="8px"; left.style.alignItems="center"; left.style.overflow="hidden";
      const cb = document.createElement("input"); cb.type="checkbox"; cb.checked=vol.opacity>0; cb.onchange=()=>nv.setOpacity(index, cb.checked?(vol.opacity===0?1:vol.opacity):0);
      const name = document.createElement("span"); name.textContent=vol.name||`Vol ${index+1}`; name.style.fontSize="11px"; name.style.textOverflow="ellipsis"; name.style.overflow="hidden";
      const actions = document.createElement("div"); actions.style.display="flex"; actions.style.gap="4px";
      const dl = document.createElement("button"); dl.innerHTML="↓"; dl.className="btn"; dl.style.padding="0 6px"; dl.onclick=()=>downloadVolume(vol);
      const rm = document.createElement("button"); rm.textContent="×"; rm.className="btn"; rm.style.padding="0 6px"; rm.onclick=()=>{nv.removeVolume(vol); updateVolumeList();};
      left.appendChild(cb); left.appendChild(name); row.appendChild(left); actions.appendChild(dl); actions.appendChild(rm); row.appendChild(actions);
      volumeListContainer.appendChild(row);
    });
  }

  async function loadUrl(url, name, isAdding = false) {
    try {
      setStatus(`loading: ${name??url}`);
      if (isAdding) {
          const isMask = name?.toLowerCase().includes("mask");
          await nv.addVolumesFromUrl([{ url, name: name??"vol", colormap: isMask?"red":"gray", opacity: isMask?0.8:0.5, cal_min: isMask?0.5:undefined, cal_max: isMask?1:undefined }]);
      } else {
          await nv.loadVolumes([{ url, name: name??"vol" }]);
      }
      if (!isAdding || nv.volumes.length === 1) {
          const info = getVolumeInfo();
          voxelSpacingMm = estimateVoxelSpacingMm(info);
          if (info.dim3) {
              const [dx, dy, dz] = info.dim3;
              fullFovMm = [dx*voxelSpacingMm[0], dy*voxelSpacingMm[1], dz*voxelSpacingMm[2]];
              const sr = (s,n,mm,def) => { s.min=n.min="1"; s.max=n.max="600"; s.step=n.step="1"; s.value=n.value=def?String(def):String(Math.round(mm)); };
              sr(fovX,fovXVal,fullFovMm[0],220); sr(fovY,fovYVal,fullFovMm[1],220); sr(fovZ,fovZVal,fullFovMm[2],100);
              const so = (s,n) => { s.min=n.min="-500"; s.max=n.max="500"; s.step=n.step="0.1"; s.value=n.value="0"; };
              so(fovOffX,fovOffXVal); so(fovOffY,fovOffYVal); so(fovOffZ,fovOffZVal);
          }
      }
      syncFovLabels(); updateFovMesh(); updateVolumeList(); setStatus(`loaded: ${name??url}`);
    } catch (e) { setStatus(`Error: ${e.message}`); }
  }

  btnDemo.onclick = () => loadUrl(DEMO_URL, "mni152.nii.gz");
  fileInput.onchange = (e) => { const f=e.target.files?.[0]; if(f){ const u=URL.createObjectURL(f); loadUrl(u, f.name, isAddingVolume).finally(()=>{ setTimeout(()=>URL.revokeObjectURL(u),30000); e.target.value=""; }); } };
  
  return { nv, loadUrl, setStatus };
}
