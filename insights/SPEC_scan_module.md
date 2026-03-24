# SPEC: Scan Module

The Scan Module is a core component of the No-field Scanner lab. It manages the execution of simulations (scans) and provides a queue-based interface for tracking and viewing results.

## Overview
The module bridges the gap between **Planning** (Sequence Explorer/Niivue) and **Results** (NIfTI images). **SIM** jobs follow a "file-pair" style (NIfTI + optional `.seq` blob for the queue). **CUT** only adds a resampled NIfTI (`scan_<n>_cut.nii.gz`); it does not run the sequence function or persist a `.seq`.

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

## CUT (`runFakeScan`)
1. **Trigger**: User clicks **CUT** (requires at least one volume in Niivue).
2. **No sequence run**: Does **not** call `SequenceExplorer.executeFunction`; no protocol snapshot for CUT.
3. **Python**: Resamples the first viewer volume (typically density) to the FOV mask (`run_resampling` / `run_resampling_serial3d_to_4d` in Pyodide).
4. **Output**: Blob URL for `scan_<n>_cut.nii.gz` only; `job.cutOnly` hides VIEW SEQ / download in the queue.

## SIM pipeline (`runSimPipeline`)
Uses `executeFunction` and prepares `/outputs/<baseName>.seq` for the external sim tools; queue items get VIEW SEQ / download where applicable.

**Order (FOV / grid contract):**
1. **`_prepareCurrentSeqForTools`** — silent `executeFunction` with `protocolName` (protocol snapshot + sequence build). Sequence Explorer emits **`sequence_fov_dims`** from **`seq.definitions` FOV** (m→mm) so Niivue FOV **size** matches the built Pulseq sequence.
2. **`generateFovMaskNifti()`** — ref mask and voxel grid **after** seq FOV is on the sliders; matrix dimensions, offset, rotation still come from the FOV tab UI.
3. Resample phantom volumes to that ref → conseq / trajex → sim tool → PyNUFFT on the **same** ref grid.

**PyNUFFT:** Implemented in **`scan_zero/recon.py`** (`run_sim_recon`). On SIM, the file is fetched and written to Pyodide as `/scan_zero/recon.py` once per session, then imported (keeps recon out of inline JS strings).

**MR0 compatibility fix:** The in-app translated phantom path now resolves `B1+` / `B1-` robustly across all tissue entries (not only the first tissue) and guarantees non-empty TX/RX map lists with fallback `1.0` maps if needed. This keeps `SCAN▶` (`tool-mr0sim`) on the same local phantom conversion path as `SCAN▶▶` (rapisim), without a separate debug button.

If step 2 ran before step 1, recon used a stale FOV while the UI later jumped to seq FOV — yellow box and NIfTI appeared to shrink or grow until queue load resynced.

## NIfTI -> toolapi phantom conversion
- **Source**: Resampled NIfTI volumes are staged in Pyodide temp FS (`/tmp/__sim_phantom_staging`) together with the active phantom JSON.
- **Loader behavior**: JSON tissue refs like `file.nii.gz[idx]` are resolved; each referenced 3D map is loaded from the staged files (4D inputs split by index). Misnamed plain `.nii` files with `.nii.gz` extension are handled via a temporary fallback load path.
- **Per-tissue fields**: For each tissue, conversion creates `density` and `db0` as full `Volume` grids, plus scalar `t1`, `t2`, `t2dash`, `adc` (density-weighted averages when properties are map-backed).
- **B1 handling**: `b1_tx`/`b1_rx` are built from `B1+`/`B1-` entries (searched across tissues); if missing/empty, fallback constant maps are inserted so toolapi payloads are never TX/RX-empty.
- **Wire format**: JS encodes the plain dict to toolapi `SegmentedPhantom` with `Volume.data` serialized as `TypedList::Float` (`{ Float: [...] }`) to match toolapi-wasm expectations.

## Interface & Workflow
- **CUT Button**: Resample-to-FOV only (see above).
- **MR0 Button**: **`SCAN▶`** uses the in-app translated/resampled phantom path (with robust B1 TX/RX handling).
- **Queue Item**: Shows the job number, label, and 24h timestamp (`${scanNumber}. ${name}`). **CUT** jobs always use label **`cut`** (e.g. `1. cut`, `2. cut`); SIM jobs use the sequence-derived name.
- **Visual Feedback**: Uses a color-coded left border (Green: Done, Yellow: Scanning, Red: Error).
- **Actions**:
    - **VIEW SCAN**: Loads the NIfTI into Niivue, hides other scans, and switches to **Planning Mode**.
    - **VIEW SEQ** / **Download (↓)**: Shown for SIM (and any future jobs with `vfsSeqPath` / `seqUrl`), not for CUT (`cutOnly`).
    - **Remove (×)**: Deletes the job from the session queue.

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
