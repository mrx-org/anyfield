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

## SIM pipeline (Modal HTTP gateway)
Every SIM backend is a Modal HTTP gateway (`transport: 'http'` in `sim_backends.js`). Uses `executeFunction` and prepares `/outputs/<baseName>.seq` for the gateway; queue items get VIEW SEQ / download where applicable.

**Order (FOV / grid contract):**
1. **`_prepareCurrentSeqForTools`** (Pyodide `sim-seq` task) — silent `executeFunction` with `protocolName` (protocol snapshot + sequence build, on the Pyodide worker). Sequence Explorer emits **`sequence_fov_dims`** from **`seq.definitions` FOV** (m→mm) so Niivue FOV **size** matches the built Pulseq sequence; produces the `.seq` bytes that are uploaded.
2. **`captureFovSnapshot()`** — freeze FOV geometry for this job into `job.fovSnapshot` (`{ centerWorld, sizeMm, rotationDeg }` in RAS mm). Seq-authoritative size and user-authoritative offsets/rotations are both now on the sliders, so this is the correct capture moment.
3. **Phantom spec** — the active phantom must be a cached BIfTI (`options.phantom = { type: 'bifti', id, res, affine, config? }`); `res` / `affine` come from the frozen snapshot (× phantom oversample), and edited JSON sidecars travel as `config`.
4. **Submit** (`_httpPrepareAndSubmit`) — `.seq` + options (worker, forward backend, accuracy, prune settings) to `{gateway}/v1`. Only prep + submit are awaited; `_pumpHttpReaper` then polls every in-flight job, so many scans overlap on the Modal worker pool.
5. **Finish** (`_httpFinishJob`) — fetch the result `.npz` and run the **PyNUFFT recon** on the Pyodide worker (`_reconstructJob`) against the recon ref built from the snapshot (`generateFovMaskNiftiFromSnapshot`, `getReconMatrixDims`).

**Why the snapshot:** the recon reference determines the output NIfTI's affine/zooms (see `run_sim_recon_from_npz` in `scan_zero/recon.py`). Previously it was re-derived from live sliders *after* the long-running remote simulation, so any FOV change in between (user input, `syncFovFromScanVolume` after a prior scan completing, `applySequenceFovDimensions` from a subsequent seq prep) desynced the recon grid from the phantom grid — signal encoded old FOV, output stamped with new affine. The per-job snapshot isolates each in-flight pipeline from later slider mutations. Because `centerWorld` is stored in absolute RAS mm, swapping the "selected" volume mid-pipeline does not shift the snapshot.

**PyNUFFT:** Implemented in **`scan_zero/recon.py`** (`run_sim_recon_from_npz`), kernels in `scan_zero/recon_kernels.py`. Loaded once when the Pyodide worker warms up (`py_worker_host.js`).

**Protocol metadata patch:** After silent execute, `patchProtocolTomlSections` merges simulation/recon into the saved protocol's marked `_anyfield_json` block (compact primitive arrays on one line).

## Rotated FOV and the sim coordinate contract

The sim pipeline supports oblique (coronal, sagittal, arbitrary) FOV boxes. Understanding how coordinates flow through the pipeline is critical:

1. **Reslice**: `generateFovMaskNiftiFromSnapshot` builds a NIfTI whose voxel grid is aligned with the FOV box. For a coronal FOV, voxel axis 0 might map to world X while axis 1 maps to world Z. The **data matrix** is in the FOV-native frame; the NIfTI **affine** encodes the rotation back to world (RAS) space.

2. **Phantom**: the gateway resamples the cached BIfTI phantom onto the FOV-aligned grid it is sent (`options.phantom.res` / `affine` from the same snapshot), so the simulation runs in the FOV-native frame.

3. **Recon**: Receives `reconRef` (with the **full rotated affine**). Extracts grid shape and voxel sizes (zooms) for FOV/kmax computation — these are correct regardless of rotation. Reconstructs in the sim's axis-aligned frame. The output NIfTI is stamped with the original rotated affine so Niivue displays the image at the correct world-space position and orientation.

## Interface & Workflow
- **CROP Button**: Resample-to-FOV only (see above).
- **SCAN▶**: runs simulation on the scan backend. Every page load starts on **`pdgo1_t4`** (PDGo1 T4, CUDA PDG v8); non-pro users always get it. In pro mode the gear can switch it for the current session.
- **SCAN▶▶** (pro): runs the same scan on the compare backend; every page load starts on **`pdgv2_t4`**. The gear **Simulation backend** dialog assigns both slots (session only, not persisted, so pro and non-pro start from the same defaults) and the PDG prune settings (persisted in `localStorage`). Shared links / protocol TOML `[simulation].backend` still apply when loading a share; the retired ids `mr0sim` / `rapisim` resolve to mr0 T4 (`modal_http_t4`).
- **Backend registry**: `scan_zero/sim_backends.js` — Modal HTTP gateways: mr0 (CPU / T4 / A10 / A100), PDGv2 (T4 / A10), and PDGo1 (T4 / A10; CUDA PDG v8 with off-resonant shaped RF pulses).
- **Queue Item**: Shows the job number, label, and 24h timestamp (`${scanNumber}. ${name}`). **CROP** jobs use label **`crop`**. While scanning, a short stage caption (`wake`, `seq`, `load`, `sim`, `reco`, …) follows the gateway's status.
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
