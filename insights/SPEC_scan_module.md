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
- `draftJob`: Live row at the top of the queue while a sequence is selected; holds editable scan name and protocol label until **SCAN**.

## Draft row and protocol naming

When a sequence is selected, `_onSequenceSelected` creates `draftJob` with:

- **`userName`** — editable scan label (used in `job.name`, NIfTI/`.seq` basename, protocol save). Defaults via `_defaultDraftName`:
  - **Numbered protocol** (`user/prot/3_prot_gre.py`): `{parentScan}.{label}` → e.g. `3.gre` (not just `gre`)
  - **Other sequences**: display name with leading `N. ` stripped
- **`protocolLabel`** — read-only meta line under the draft title (`_draftProtocolLabel`): underlying file stem or `stem:function`

The draft row shows **`{scanCounter+1}.`** as a fixed prefix and the editable name beside it, e.g. **`4.`** + **`3.gre`** → queue title **`4. 3.gre`** after SCAN.

On SIM, `_prepareCurrentSeqForTools` sets `seqExplorer._pendingProtocolMeta = { scanNumber, name }` then calls `executeFunction(true, scanNumber)`. `saveProtocolSnapshot` writes `user/prot/<scan>_<stem>.py` (e.g. `4_prot_3_gre.py`) and display name **`4. 3.gre`** via `protocolDisplayNameFromPath`.

## CROP (`runCropScan`)
1. **Trigger**: User clicks **CROP** (requires at least one volume in Niivue).
2. **No sequence run**: Does **not** call `SequenceExplorer.executeFunction`; no protocol snapshot for CROP.
3. **Python**: Resamples the first viewer volume (typically density) to the FOV mask (`run_resampling` / `run_resampling_serial3d_to_4d` in Pyodide).
4. **Output**: Blob URL for `scan_<n>_crop.nii.gz` only; `job.cropOnly` hides VIEW SEQ / download in the queue.

## SIM pipeline (`runSimPipeline`)
Uses `executeFunction` and prepares `/outputs/<baseName>.seq` for the external sim tools; queue items get VIEW SEQ / download where applicable.

**Order (FOV / grid contract):**
1. **`_prepareCurrentSeqForTools`** (Pyodide `sim-seq` task) — silent `executeFunction` with `protocolName` (protocol snapshot + sequence build). Sequence Explorer emits **`sequence_fov_dims`** from **`seq.definitions` FOV** (m→mm) so Niivue FOV **size** matches the built Pulseq sequence; produces **`seqText`** for conseq.
2. **`captureFovSnapshot()`** — freeze FOV geometry for this job into `job.fovSnapshot` (`{ centerWorld, sizeMm, rotationDeg }` in RAS mm). Seq-authoritative size and user-authoritative offsets/rotations are both now on the sliders, so this is the correct capture moment.
3. **`generateFovMaskNiftiFromSnapshot(job.fovSnapshot, …)`** — build **both** phantom ref (`getPhantomMatrixDims` × oversample) and recon ref (`getReconMatrixDims`) from the frozen snapshot (main thread).
4. **Prepare (parallel):** **`conseq(seqText)`** ∥ **Pyodide resample all phantom volumes + `_convertResampledGroupToToolPhantom`** (`sim-phantom` task). Either leg failing aborts the job with a combined error message.
5. **Simulate (parallel):** **`trajex(events)`** ∥ **sim backend** (`sequence` + encoded phantom). Recon requires **both** trajectory and signal.
6. **PyNUFFT recon** (Pyodide `sim-recon` task) on `reconRef` from step 3.

**Tool API call policy (design contract):**
- **Prepare:** `conseq` (Fly) runs **in parallel** with Pyodide footprint resample + phantom convert (after seq execute + FOV snapshot).
- **Simulate:** `trajex` and (`tool-mr0sim` or `tool-rapisim`) run **in parallel** after `conseq` and phantom are both ready; recon still needs trajectory + signal.
- At most **`MAX_CONCURRENT_TOOL_WS` (2)** open tool WebSockets globally across queued jobs (`_acquireToolSlot` in `scan_module.js`).
- Parallel legs use `Promise.allSettled`; failures report which leg failed (`conseq`, `phantom resample`, `trajex`, or sim channel).
- Each stage is still one WebSocket per call (separate progress logs per tool channel).

**Why the snapshot:** the recon reference determines the output NIfTI's affine/zooms (see `run_sim_recon` in `scan_zero/recon.py`). Previously it was re-derived from live sliders *after* the long-running toolapi calls, so any FOV change in between (user input, `syncFovFromScanVolume` after a prior scan completing, `applySequenceFovDimensions` from a subsequent seq prep) desynced the recon grid from the phantom grid — signal encoded old FOV, output stamped with new affine. The per-job snapshot isolates each in-flight pipeline from later slider mutations. Because `centerWorld` is stored in absolute RAS mm, swapping the "selected" volume mid-pipeline does not shift the snapshot.

**PyNUFFT:** Implemented in **`scan_zero/recon.py`** (`run_sim_recon`). On SIM, the file is fetched and written to Pyodide as `/scan_zero/recon.py` once per session, then imported (keeps recon out of inline JS strings).

**Protocol metadata patch:** After silent execute, `patchProtocolTomlSections` merges simulation/recon into the saved protocol's marked `_anyfield_json` block (compact primitive arrays on one line).

**MR0 compatibility fix:** The in-app translated phantom path now resolves `B1+` / `B1-` robustly across all tissue entries (not only the first tissue) and guarantees non-empty TX/RX map lists with fallback `1.0` maps if needed. This keeps `(▶)` / tool-mr0sim on the same local phantom conversion path as `(▶▶)` / rapisim, without a separate debug button.

## NIfTI -> toolapi phantom conversion
- **Source**: Resampled NIfTI volumes are staged in Pyodide temp FS (`/tmp/__sim_phantom_staging`) together with the active phantom JSON.
- **Loader behavior**: JSON tissue refs like `file.nii.gz[idx]` are resolved; each referenced 3D map is loaded from the staged files (4D inputs split by index). Misnamed plain `.nii` files with `.nii.gz` extension are handled via a temporary fallback load path.
- **Per-tissue fields**: All JSON property forms go through `resolve_vol` (scalar, NIfTI ref, `{file, func}` — same as `execute_json._resolve`). `density` and `db0` are full `Volume` grids; `t1`, `t2`, `t2dash`, `adc` are toolapi scalars via density-weighted mean of the resolved 3D map when map-backed.
- **B1 handling**: `b1_tx`/`b1_rx` load full-grid maps via `_load_prop_map` (no single-tissue density mask); lists come from the first non-empty tissue `B1+`/`B1-`. Per-tissue `dB0` uses `resolve_vol` (map × tissue density mask). Fallback `1.0` maps if TX/RX would be empty.
- **Wire format**: JS encodes the plain dict to toolapi `SegmentedPhantom` with `Volume.data` serialized as `TypedList::Float` (`{ Float: [...] }`) to match toolapi-wasm expectations.

## Rotated FOV and the sim coordinate contract

The sim pipeline supports oblique (coronal, sagittal, arbitrary) FOV boxes. Understanding how coordinates flow through the pipeline is critical:

1. **Reslice**: `generateFovMaskNiftiFromSnapshot` builds a NIfTI whose voxel grid is aligned with the FOV box. For a coronal FOV, voxel axis 0 might map to world X while axis 1 maps to world Z. The **data matrix** is in the FOV-native frame; the NIfTI **affine** encodes the rotation back to world (RAS) space.

2. **Phantom for sim — diagonal affine**: The sim backends (rapisim, tool-mr0sim) treat the phantom as an axis-aligned box scaled by voxel sizes read from the affine. They do **not** extract column norms; they read the affine diagonal directly. Therefore `make_vol` in `_convertResampledGroupToToolPhantom` strips the rotation and builds a pure diagonal affine: `diag(vox_x, vox_y, vox_z, 1)` where `vox_i = ‖column_i‖` of the original affine. This ensures the sim always sees correct voxel dimensions regardless of FOV rotation.

3. **Trajectory**: `trajex` computes k-space from the sequence gradient waveforms (physical Gx/Gy/Gz channels). Since the sim maps gradient X → voxel axis 0, Y → axis 1, Z → axis 2 (axis-aligned assumption), the trajectory is already in the same frame as the sim's encoding. No rotation of the trajectory is needed.

4. **Recon**: Receives `reconRef` (with the **full rotated affine**). Extracts grid shape and voxel sizes (zooms) for FOV/kmax computation — these are correct regardless of rotation. Reconstructs in the sim's axis-aligned frame. The output NIfTI is stamped with the original rotated affine so Niivue displays the image at the correct world-space position and orientation.

## Interface & Workflow
- **CROP Button**: Resample-to-FOV only (see above).
- **MR0 button** (**SCAN▶** in the bar): uses the in-app translated/resampled phantom path (with robust B1 TX/RX handling); queue/protocol label **`(▶)`**.
- **Rapisim button** (**SCAN▶▶**): queue/protocol label **`(▶▶)`**.
- **Queue Item**: Shows the job number, label, and 24h timestamp (`${scanNumber}. ${name}`). **CROP** jobs use label **`crop`**. **SIM** jobs use the sequence display name plus **`(▶)`** (MR0) or **`(▶▶)`** (rapisim) in the title; `job.protocol` matches **`(▶)`** / **`(▶▶)`**.
- **Visual Feedback**: Uses a color-coded left border (Green: Done, Yellow: Scanning, Red: Error).
- **Actions**:
    - **VIEW SCAN**: Loads the NIfTI into Niivue (pane **A**), hides other scans, switches to **Planning Mode**, updates scan preview (**B**), and syncs the FOV sliders/mesh to the scan's affine (`loadJob(jobId)`, default `syncFov=true`). Tooltip notes Ctrl variant.
    - **Ctrl+VIEW SCAN**: Same job volume on **A** if not already loaded; opens **compare pane C** only via `loadJobToCompare` (does not change B selection or FOV sync behavior beyond ensuring the volume exists on A).
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
