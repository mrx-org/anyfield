# Niivue Component Specification

## Intent
Modular medical imaging component for 3D/orthographic NIfTI visualization and interactive scanner Field of View (FOV) planning.

## Core Functionality
- **Visualization**: WebGL-accelerated volume rendering with crosshair-synchronized slices.
- **FOV Planning**: Interactive 3D box manipulation to define physical scanner coordinates (size, offset, rotation).
- **Coordinate Math**: Logic for voxel-to-world (mm) mapping using NIfTI Q-form/S-form headers.
- **Shared State**: Emits real-time `fov_changed` events via a central hub.
- **Volume Management**: Session-aware volume list with reverse chronological ordering, unique numbering, and Title+Meta styling.
- **Visual Feedback**: Green pulse highlight on the viewer and volume list when new data is added.
- **Interactions**: 
  - Standardized mouse gestures: Ctrl+Left (Move FOV), Ctrl+Right (Rotate FOV), Ctrl+Scroll (Resize FOV), Ctrl+Middle Drag (Zoom).
  - Automatic mode switching to "Planning" on any viewer interaction.

## Coordinate System & Affine Handling
- **Affine source**: `getVolumeInfo(targetVol?)` is the single source of truth for volume metadata (dims, affine, header). All code paths use this instead of parsing `hdr.affine` independently.
- **Nested array flattening**: NIfTI `hdr.affine` is a nested 4x4 array (length 4). `getVolumeInfo` flattens it to a row-major 16-element array so all downstream consumers (`voxelToWorldFactory`, `getFovGeometry`, `getVolumeNifti`, etc.) work correctly.
- **Voxel spacing**: Estimated from the affine by measuring world-space distance between adjacent voxels, not from `pixDims` (which can be inconsistent after reorientation).
- **Transform factory**: `voxToMmFactory(vol, affine)` prefers Niivue's `vol.vox2mm` when available, falling back to affine-based math. `worldMmToFovOffset` inverts this by probing the forward transform at 4 points, guaranteeing self-consistency.

## FOV Offset Convention
- **Offset = displacement in mm from the NIfTI grid center voxel.** When offset is (0, 0, 0), the FOV is centered at voxel `((dx-1)/2, (dy-1)/2, (dz-1)/2)`.
- **Click-to-offset pipeline**: Screen click -> RAS world mm (via Niivue slice geometry) -> voxel (via probe-and-invert) -> offset `(vx - centerVox) * spacing`.
- **FOV mesh**: Built by `getFovGeometry()` which transforms FOV corner voxels to world coordinates using `voxToMmFactory`. The mesh is displayed as a semi-transparent overlay in the 3D/slice views.

## Default phantom (lab shell)
- **Bundled path**: `data/bundled_phantoms/brain_default_1mm_gz/` (`brain_default.json` + PD / dB0 / B1+ NIfTIs). Same content can be mirrored from `data/tool_phantomlib_flyio/` (that tree may be a nested git repo). Loaded on startup via `loadBundledDefaultPhantom()` (see `index.html`). **Default phantom** button reloads the same bundle after `resetViewer()`.
- **`.gitignore`**: `*.nii.gz` is ignored except the three default-phantom files (explicit `!` rules).

## Phantom Load Reset Flow
Loading a new phantom (Default phantom, Add Folder, or file-with-JSON) triggers a full reset:
1. **Confirmation dialog**: Warns the user that all volumes, scans, and masks will be removed.
2. **`resetViewer()`**: Removes FOV mesh, clears all Niivue volumes, resets internal state (volumeGroups, spacing, fullFovMm, etc.).
3. **Load new data**: Via `loadBundledDefaultPhantom`, `loadUrl`, or `loadMultiPhantomFromFiles`.
4. **`refreshFovForNewVolume()`**: Re-reads volume info from the new phantom, recalculates voxel spacing and full FOV extent, resets offset sliders to (0, 0, 0) (centered), enables FOV checkbox, triggers mesh rebuild and debug panel update.

## FOV Export
- **Download FOV + NIfTI**: Exports RAS and LPS STL meshes of the FOV box, a binary FOV mask NIfTI (with rotated affine matching the FOV orientation), and the current primary volume as NIfTI. Both sform and qform are set identically (code=2).
- **Resample to FOV**: Uses Pyodide (SciPy `map_coordinates` + nibabel) to resample current volume(s) onto the FOV mask grid. Supports multi-phantom groups (resamples each volume in the group). Results are added to the volume list.
- **Robust output path**: Python writes a temporary `.nii` in Pyodide VFS; JS reads it via `pyodide.FS.readFile(...)`, validates NIfTI magic, then loads into Niivue.
- **4D handling**: Serial 3D→4D resampling spills the source to `/tmp` (raw `.nii` uses mmap), pulls **one time frame at a time** via `dataobj[..., t]`, and writes into a **pre-allocated** 4D array (avoids a full-volume `get_fdata()` plus a list of all resampled frames before `np.stack`). Peak RAM is lower in Pyodide; gzip sources may still fully decompress. Huge FOV × many dynamics can still hit browser `MemoryError`.
- **Cleanup & diagnostics**: Temporary VFS files are deleted after read (`FS.unlink`). Verbose resample logs are opt-in via `debugResampleToFov`; serial mode can be disabled with `resampleSerial3D: false`.

## Debug Panel
A live debug info panel (in the FOV tab hint area) shows:
- Volume dims, spacing, `hdr.affine` translation, `matRAS` translation
- `vox2mm(0)` and `vox2mm(center)` to verify affine correctness
- FOV size, offset, rotation, world center
- Cursor position in mm and voxel coordinates

## Modular API
- **Class**: `NiivueModule`
- **Parts**: 
  - `renderViewer(target)`: The WebGL canvas and status overlay.
  - `renderControls(target)`: Compact tabbed UI (VIEWER, OPTIONS, FOV).
- **Key Methods**:
  - `getVolumeInfo(targetVol?)`: Single source of truth for volume metadata with affine flattening.
  - `loadUrl(url, name, isAdding)`: Robust additive or destructive volume loading with initialization queuing.
  - `confirmPhantomReset()` / `resetViewer()` / `refreshFovForNewVolume()`: Full phantom switch lifecycle.
  - `getFovGeometry()`: Computes FOV mesh vertices, center, size, and rotation in world coordinates.
  - `worldMmToFovOffset(rasMM)`: Converts a world-space click position to FOV offset values.
  - `generateFovMaskNifti()`: Creates a binary NIfTI mask matching the current FOV box.
  - `triggerHighlight()`: Triggers the green visual feedback animation.
  - `updateVolumeList()`: Rebuilds the synchronized management UI.

## RUN bar: CUT / > SIM / >> SIM (`scan_zero/scan_module.js`)
- **Buttons**: **CUT** — resample first viewer volume to the FOV mask only (`runFakeScan`): no `executeFunction`, no `.seq` on disk/VFS, queue shows **VIEW SCAN** only (no VIEW SEQ / download). **> SIM** (left) → `wss://tool-mr0sim.fly.dev/tool`. **>> SIM** (right) → `wss://tool-rapisim.fly.dev/tool`. Same `Dict` payload: `sequence` + `phantom`. Shared implementation: `runSimPipeline(job)` with `job.simToolUrl` (`TOOL_MR0SIM` / `TOOL_RAPISIM` exported from the module).
- **FOV contract**: The Pulseq `.seq` should match the **viewer FOV tab** (mm box, rotation, mask X/Y/Z). Recon grid comes from `generateFovMaskNifti()`, not `seq.definitions`. Trajex k (1/m): **kmax = N/(2·FOV)** per axis; PyNUFFT **ω = (k/kmax)·π**.
- **Flow**: Resample maps to FOV **in memory / `/tmp/__sim_phantom_staging` only** (no extra Niivue volumes, no long-lived `/phantom` copies for resampled maps) → conseq / trajex → chosen sim tool → PyNUFFT → magnitude NIfTI saved as **3D** `(nx, ny, nz)` on the **same grid as the FOV mask** (`generateFovMaskNifti`): 2D readout fills one slice (`z = (nz-1)//2`); future 3D recon can assign the full `mag3d`. Output uses a **fresh** NIfTI header from the array + mask voxel sizes (`set_zooms`), not a blind `header.copy()`, so `dim[]`/`nz` stay consistent for Niivue and `syncFovFromScanVolume`. **CUT** only resamples the first viewer volume for the queue; it does not run this pipeline.

## Phantom JSON Execution (viewer)
- **JSON tab** (only when using `viewer.html`): Lists JSON phantom config filenames from the current session; selecting one shows its content in a CodeMirror editor. Buttons: **Save** / **Save As** / **Revert** (in VFS), **Execute** (runs phantom and loads result into the viewer).
- **Add Folder**: User selects a folder; all NIfTIs and JSONs are uploaded to Pyodide's VFS under `/phantom`. The chosen JSON's NIfTIs are loaded into Niivue (same as Add File). If multiple JSONs exist, a dialog picks which config is active. The user can then open the **JSON** tab and click **Execute** to build averaged maps (not automatic).
- **Execute**: Calls the same logic as the standalone `data/execute_json.py` inside Pyodide: `write_executed=False`, `write_averaged=True`, output to `/phantom/averaged`. Produces 3D density-weighted averaged maps (density, T1, T2, T2', ADC, dB0, B1+, B1-) with NaN where total density <= threshold (default 0.01). Resulting NIfTIs are read from VFS and loaded into Niivue as one volume group (label `*_averaged`).
- **Single source of truth**: Phantom execution logic lives in `data/execute_json.py`; the viewer fetches and runs that script in Pyodide, so CLI and browser stay in sync.
