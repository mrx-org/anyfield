# SPEC: Scan Module

The Scan Module is a core component of the No-field Scanner lab. It manages the execution of simulations (scans) and provides a queue-based interface for tracking and viewing results.

## Overview
The module bridges the gap between **Planning** (Sequence Explorer/Niivue) and **Results** (NIfTI images). **SIM** jobs follow a "file-pair" style (NIfTI + optional `.seq` blob for the queue). **CROP** only adds a resampled NIfTI (`scan_<n>_crop.nii.gz`); it does not run the sequence function or persist a `.seq`.

## Architecture
- **Location**: `scan_zero/`
- **Class**: `ScanModule` (defined in `scan_module.js`)
- **Styles**: `scan_module.css`
- **Dependencies**: 
    - `event_hub.js` for inter-module communication.
    - `NiivueModule` (global instance `window.nvModule`) for image data and resampling logic.
    - `Pyodide` for running the simulation engine (Python).

## Key State
- `queue`: An array of `Job` objects representing past and current scans.
- `scanCounter`: A session-based integer that provides unique prefixes (1., 2., etc.) for scans.
- `currentSequence`: The sequence currently selected in the Sequence Explorer.
- `currentFov`: The FOV geometry (size, offset, rotation) received from Niivue.

## CROP (`runCropScan`)
1. **Trigger**: User clicks **CROP** (requires at least one volume in Niivue).
2. **No sequence run**: Does **not** call `SequenceExplorer.executeFunction`; no protocol snapshot for CROP.
3. **Python**: Resamples the first viewer volume (typically density) to the FOV mask (`run_resampling` / `run_resampling_serial3d_to_4d` in Pyodide).
4. **Output**: Blob URL for `scan_<n>_crop.nii.gz` only; `job.cropOnly` hides VIEW SEQ / download in the queue.

## SIM pipeline (`runSimPipeline`)
Uses `executeFunction` and prepares `/outputs/<baseName>.seq` for the external sim tools; queue items get VIEW SEQ / download where applicable.

**Order (FOV / grid contract):**
1. **`_prepareCurrentSeqForTools`** — silent `executeFunction` with `protocolName` (protocol snapshot + sequence build). Sequence Explorer emits **`sequence_fov_dims`** from **`seq.definitions` FOV** (m→mm) so Niivue FOV **size** matches the built Pulseq sequence.
2. **`captureFovSnapshot()`** — freeze FOV geometry for this job into `job.fovSnapshot` (`{ centerWorld, sizeMm, rotationDeg }` in RAS mm). Seq-authoritative size and user-authoritative offsets/rotations are both now on the sliders, so this is the correct capture moment.
3. **`generateFovMaskNiftiFromSnapshot(job.fovSnapshot, …)`** — build **both** phantom ref (`getPhantomMatrixDims`) and recon ref (`getReconMatrixDims`) up-front from the same frozen snapshot. Phantom and recon grids differ in matrix resolution but share identical mm box + world placement.
4. Resample phantom volumes to the phantom ref → conseq / trajex → sim tool → PyNUFFT on the recon ref.

**Why the snapshot:** the recon reference determines the output NIfTI's affine/zooms (see `run_sim_recon` in `scan_zero/recon.py`). Previously it was re-derived from live sliders *after* the long-running toolapi calls, so any FOV change in between (user input, `syncFovFromScanVolume` after a prior scan completing, `applySequenceFovDimensions` from a subsequent seq prep) desynced the recon grid from the phantom grid — signal encoded old FOV, output stamped with new affine. The per-job snapshot isolates each in-flight pipeline from later slider mutations. Because `centerWorld` is stored in absolute RAS mm, swapping the "selected" volume mid-pipeline does not shift the snapshot.

**PyNUFFT:** Implemented in **`scan_zero/recon.py`** (`run_sim_recon`). On SIM, the file is fetched and written to Pyodide as `/scan_zero/recon.py` once per session, then imported (keeps recon out of inline JS strings).

**MR0 compatibility fix:** The in-app translated phantom path now resolves `B1+` / `B1-` robustly across all tissue entries (not only the first tissue) and guarantees non-empty TX/RX map lists with fallback `1.0` maps if needed. This keeps `(▶)` / tool-mr0sim on the same local phantom conversion path as `(▶▶)` / rapisim, without a separate debug button.

## NIfTI -> toolapi phantom conversion
- **Source**: Resampled NIfTI volumes are staged in Pyodide temp FS (`/tmp/__sim_phantom_staging`) together with the active phantom JSON.
- **Loader behavior**: JSON tissue refs like `file.nii.gz[idx]` are resolved; each referenced 3D map is loaded from the staged files (4D inputs split by index). Misnamed plain `.nii` files with `.nii.gz` extension are handled via a temporary fallback load path.
- **Per-tissue fields**: For each tissue, conversion creates `density` and `db0` as full `Volume` grids, plus scalar `t1`, `t2`, `t2dash`, `adc` (density-weighted averages when properties are map-backed).
- **B1 handling**: `b1_tx`/`b1_rx` are built from `B1+`/`B1-` entries (searched across tissues); if missing/empty, fallback constant maps are inserted so toolapi payloads are never TX/RX-empty.
- **Wire format**: JS encodes the plain dict to toolapi `SegmentedPhantom` with `Volume.data` serialized as `TypedList::Float` (`{ Float: [...] }`) to match toolapi-wasm expectations.

## Interface & Workflow
- **CROP Button**: Resample-to-FOV only (see above).
- **MR0 button** (**SCAN▶** in the bar): uses the in-app translated/resampled phantom path (with robust B1 TX/RX handling); queue/protocol label **`(▶)`**.
- **Rapisim button** (**SCAN▶▶**): queue/protocol label **`(▶▶)`**.
- **Queue Item**: Shows the job number, label, and 24h timestamp (`${scanNumber}. ${name}`). **CROP** jobs use label **`crop`**. **SIM** jobs use the sequence display name plus **`(▶)`** (MR0) or **`(▶▶)`** (rapisim) in the title; `job.protocol` matches **`(▶)`** / **`(▶▶)`**.
- **Visual Feedback**: Uses a color-coded left border (Green: Done, Yellow: Scanning, Red: Error).
- **Actions**:
    - **VIEW SCAN**: Loads the NIfTI into Niivue, hides other scans, switches to **Planning Mode**, and syncs the FOV sliders/mesh to the scan's affine (`loadJob(jobId)`, default `syncFov=true`).
    - **VIEW SEQ** / **Download (↓)**: Shown for SIM (and any future jobs with `vfsSeqPath` / `seqUrl`), not for CROP (`cropOnly`).
    - **Remove (×)**: Deletes the job from the session queue.

**Auto-load after completion (`loadJob(jobId, false)`):** CROP and SIM pipelines call `loadJob` with `syncFov=false` so the user's in-progress FOV planning (slice positioning for the next scan) is *not* overwritten by the just-completed scan's affine. The flag is threaded through to `nvMod.loadUrl(..., syncFovOnScan=false)` so Niivue's internal per-scan FOV sync (the `if (isScan) syncFovFromScanVolume(...)` path in `loadUrl`) is also skipped. The volume is still selected, opacity updated, and preview refreshed; only the FOV sliders/mesh are left untouched. Explicit **VIEW SCAN** clicks remain default `syncFov=true` (both `loadUrl` and `loadJob` sync).

## Integration Points (eventHub)
- `sequenceSelected`: Updates the "Ready" sequence name.
- `fov_changed`: Syncs internal FOV geometry for the next scan.
- `loadJob`: Interacts with `window.viewManager` to ensure the correct mode is active.

## Layout Configuration
In the `index.html` Lab Shell, the module is integrated into the 3-column footer:
```css
/* Layout in index.html */
grid-template-columns: 1fr 0.8fr 1.5fr; /* Tree | Scan | Params */
```
