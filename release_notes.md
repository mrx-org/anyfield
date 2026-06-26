# Release notes

## v2.1.1

- **Protocol tooltip fix** — scan tooltips now read the protocol's entry function (`anyfield.prot_func`) instead of the first `def prot_*`, so inline protocols show the actual run parameters rather than the embedded base sequence defaults.

## v2.1.0

- **Default phantom** — Switched to BIfTI phantoms https://github.com/mrx-org/bifti-phantoms BrainWeb **subj04-3T-1mm-tra** (true 1 mm iso, resampled from orihinal bifti)
- **Single SCAN + backend picker** — RUN tab and mobile footer use one **SCAN▶** button plus a gear **Simulation backend** dialog (pro) instead of separate MR0 / GPU buttons. Choice persists in `localStorage`.
- **Sim backend registry** — `scan_zero/sim_backends.js` centralizes Fly WebSocket and Modal HTTP backends (mr0 CPU, mr0r, Modal CPU / T4 / A10 / A100); queue meta and tooltips show the selected backend label.
- **Modal HTTP simulation** — new `runHttpSimPipeline`: upload `.seq` to the Modal HTTP gateway, poll remote MRzeroCore progress, download NPZ, local PyNUFFT recon. Supports bifti registry phantoms via `reslice_to` grid from `getResliceToFromFovSnapshot`.
- **Phantom sidebar labels** — nifti_phantom_v1 JSON drives load order and per-volume labels (density, dB0, B1+, …) instead of raw filenames.
- **Protocol-driven scan titles** — SCANS list, preview **B**, and Paper Plot use `N. <protocol stem>` from `user/prot/N_*.py` (e.g. `18. prot_TSE_2D_FLAIR`), not queue draft names. Saving a protocol purges duplicate files for the same scan number.
- **Pipeline progress** — HTTP jobs map remote status messages to the ring progress arc; sim stage uses banded fractions with smoother animation during long runs.

## v2.0.0

- **Protocol file standard** — saved protocols use a three-layer format: PEP 723 (`dependencies`, `[tool.anyfield] micropip_no_deps`) for `uv run` and Pyodide; a Colab/Jupyter `%pip` guard; and a marked `_anyfield_json` block for scanner metadata (`prot_func`, `seq_func`, `simulation`, `recon`).
- **Source registry** — `pypulseq/sources.toml` replaces `sources_config.py`; folder sources materialize install headers from the registry at load time.
- **Metadata model** — canonical runtime metadata in `source.anyfield`; legacy TOML-in-PEP paths and `anyfield_config()` removed.
- **README** — concise landing page; full version history moved to this file.

## v1.3.0

- added cancel buttons

## v1.2.1

- **SIM pipeline overlap**: After seq prep + FOV snapshot, **`conseq` runs in parallel** with Pyodide footprint resample and phantom conversion; **`trajex` and sim (MR0/Rapisim) run in parallel** once both are ready. Recon still waits for trajectory + signal.
- **Tool WebSocket cap**: At most **2** concurrent toolapi connections globally (`MAX_CONCURRENT_TOOL_WS`) so many queued SCANs do not overwhelm Fly backends.
- **Clearer SIM errors**: Parallel stages use `Promise.allSettled`; failures name the leg (`conseq`, `phantom resample`, `trajex`, or sim channel) and empty trajectory/signal are reported separately.

## v1.2.0

- **Pyodide resampling queue**: CROP, SCAN prep, Resample-to-FOV, and JSON execute share a FIFO Pyodide task queue so overlapping runs no longer race on `/tmp` or `micropip` (fixes intermittent `Errno 44` / missing temp file on double-click or parallel jobs).
- **Per-job temp paths**: Resample output and 4D spill files use `job.id` (and per-volume suffix for SIM) instead of a single global `/tmp/__resampled_tmp.nii`.
- **SIM recon path fix**: Per-job recon output path via `sim_reco_out_path` (fixed `NameError` from a `sim_recon_out_path` typo in the Pyodide recon snippet).
- **UX**: Removed the cosmetic 2 s delay before CROP resampling; **wait cursor** (`cursor: wait`) on the whole page while footprint resampling runs on the main thread.

## v1.1.0

- **Scan queue draft row**: A preparing row at the top of the scan queue mirrors the protocol being edited — editable name, then **SCAN** — without starting the pipeline until you click run.
- **User protocols (session-only)**: SIM snapshots under `user/prot/` last for the current session only; reload clears them. Use **Download** or `#protocol_gz` share to keep a protocol.
- **Clean scan naming**: Display titles use `N. name` (e.g. `1. gre_seq`) everywhere — SCANS list, preview **B**, and compare **C**. Output files are `scan_<n>_<name>.nii.gz` / `.seq` (no timestamp suffixes or backend tags like `_sim_mr0`).
- **Protocol TOML**: Saved protocols embed `[simulation]` (backend, phantom, FOV affine/matrix) and `[recon]` (matrix, method) in the `.py` preamble; pulse params stay in the Python body. Scan number and user label are **not** duplicated in TOML — they come from `user/prot/<n>_*.py` and `scan_<n>_*.nii.gz`.
- **Sim backend metadata**: MR0 vs Rapisim tracked via `[simulation].backend` in TOML instead of filename suffixes.

## v1.0.0

- **Slab-correct FOV resampling (CROP / Resample-to-FOV / SCAN)**: Previously each output voxel was a single trilinear sample at the voxel center, so thick FOV slabs (especially matrix **Z = 1**, or small Z like 2) produced a sharp center slice and ignored the voxels inside the slab — changing **FOV Z** looked identical instead of averaging. Resampling now defaults to **`footprint_mean`**: each output voxel averages trilinear sub-samples over its full physical footprint. This is "conservative regridding" (volume-weighted), which nibabel/nilearn/ITK do **not** provide out of the box.
- **General + rotation-safe**: sub-samples are placed in the reference voxel grid and mapped through the **full affine**, so oblique/rotated FOV boxes stay correct.
- **Fewer substeps (perf)**: substeps per axis = `clamp(ceil(span), 1, cap)`; the cap was lowered from 32 to **12 per axis**. The box-average converges quickly, so output matches the 32-step result visually while running up to ~4x faster on thick slabs. Axes that are not downsampled use 1 substep (unchanged).
- **Options**: `resampleSamplingMode` (`"footprint_mean"` | `"center"` legacy) and `resampleMaxSubsteps` (default `12`); `RESAMPLING_PY_VERSION` cache-busts and reloads the Pyodide resampling module.

## v0.9.1

- **Paper Plot**: Niivue/clim helpers merged into `paper_plot_figure.js`; no longer imports `hist_panel/histogram-clim-panel.js`.
- **Histogram**: Restored `installFrameAwareContrastDrag` export for 4D contrast drag in the main viewer.

## v0.9.0

- **Paper Plot (experimental)**: New full-screen figure builder — multi-panel Niivue viewers, scan/diff expressions, row/global linking, SVG export, auto captions, curated colormaps. Header grid button.

## v0.8.1

- **Mobile / Compact footer**: Compact **CROP** / **SCAN▶** / **SCAN▶▶** under Protocol; pipeline ring + greyed buttons while a scan runs (desktop RUN unchanged). Footer tab **scans**; picking a sequence jumps to **prot**.
- **UI polish**: Multi-line empty SCANS hint; preview crosshair / labels; removed main viewer status overlay; JSON Save → SIM uses fresh editor content; startup loader no longer blocked on plot patch.

## v0.8.0

- **Sidebar: SCANS / PHANTOMS**: Replaced the old VIEWER + optional JSON tab with **SCANS** (recon volumes only) and **PHANTOMS** (load controls, phantom list, JSON editor). Default tab is **SCANS**; collapsed sidebar shows **S**. Tab order: SCANS → PHANTOMS → FOV → OPTIONS.
- **Phantom JSON UI**: Config picker is a compact **dropdown** (dark-themed). Save / Save As / Revert always visible; **Execute** (averaged maps) is **pro only** (`?pro=1`). JSON for **SCAN▶** / **SCAN▶▶** follows the selected config (editor → VFS → cache).
- **Load phantoms**: Removed **Add File**; folder picker is **Add (json/nii)**. **Default phantom** unchanged.
- **Delete phantom group**: Removing a main phantom also drops linked `*_averaged` / `*_resampled` groups and deletes that bundle's **`.json` and `.nii`** from Pyodide `/phantom/` (and `/phantom/averaged/` where present).
- **Tool API**: SIM runs **conseq → trajex → mr0sim/rapisim** sequentially (one WebSocket per stage; no parallel `Promise.all`).

## v0.7.2

- **Sequence parameter deep links**: URL params prefixed with `sp_` pre-fill sequence parameters on load — supports float (`&sp_dTE=0.0007`), int (`&sp_Nfe=128`), bool (`&sp_use_fat=true`), list/ndarray (`&sp_fov=[0.2,0.2,0.01]`), string.
- **Fix mrseq deep link**: `?s_category=mrseq&s_file=<stem>&s_func=<fn>` now correctly resolves mrseq sequences whose keys are stored as stem-only (e.g. `spiral_flash.py`) rather than full module path.

## v0.7.1

- **JSON Save → SIM**: Saving a phantom JSON config in the JSON tab now updates what **SCAN▶** / **SCAN▶▶** use. SIM previously kept the in-memory `jsonContent` from load time; it now resolves the latest text via editor (when that file is selected), Pyodide `/phantom/` VFS (after Save), then the cached copy.
- **JSON sync**: Save / Save As / Revert / Execute update all matching volume groups (`jsonFileName` or `jsonName.json`), not only an exact `jsonFileName` match.

## v0.7.0

- **Scan volume tooltips**: Hover a scan in the volume list to see the full protocol snapshot (underlying sequence, `user/prot/N_*.py`, and all parameter defaults used for that run).
- **B / C volume-list highlights**: Scan rows use **blue** when loaded in preview **B** (click or VIEW SCAN) and **yellow** when loaded in compare **C** (Ctrl+click / Ctrl+VIEW SCAN); neutral border when not active in either pane.
- **B / C viewer pulse**: Load flash on preview **B** and compare **C** uses matching blue/yellow fade (pane **A** stays green); static accent borders on B/C aligned to the same colors.
- **Phantom groups**: Multi-phantom folders in the volume list start **collapsed** (▶) by default.

## v0.6.1

- **Rapisim button (pro only)**: **SCAN▶▶** (tool-rapisim) is hidden unless the app is opened with `?pro=1` (same flag as the JSON tab and debug UI).
- **SIM phantom (NIfTI JSON)**: SCAN conversion follows the [NIfTI phantom spec](https://mrsources.github.io/MRzero-Core/nifti-spec.html)—spatial per-tissue **dB0** from file refs and `{file, func}` mappings (e.g. fat chemical shift), full-grid **B1±** maps (not masked to a single tissue), and **T1/T2/ADC** as constants or density-weighted means when map-backed.
- **Asymmetric TSE/RARE**: fixed default **dTE** in built-in asymmetric protocols.

## v0.6.0

- **`seq_url` deep link**: `?seq_url=` fetches a remote `.seq` into the Pulseq interpreter (optional with `s_category` / `s_file` / `s_func`); `seq_url` alone auto-selects the interpreter.
- **Rapisim spiral / NUFFT recon**: non-Cartesian recon conjugates k-space before PyNUFFT adjoint (`_backend_kspace_fix`); Cartesian still uses `fftn` vs `ifftn`.
- Added warmup for API calls and earlier toolapi load.

## v0.5.1

- **Fix phantom zip download**: `.nii.gz` volumes were written uncompressed into the zip archive. They are now gzip-compressed before packing, matching the single-file download behaviour.

## v0.5.0

- **Phantom FOV oversampling**: FOV tab input `[sx,sy,sz]` (default `[1,1,1]`) scales sim phantom matrix and FOV mm without changing the on-screen FOV box or recon grid.

## v0.4.2

- **Rapisim recon orientation (temporary)**: Cartesian recon for **SCAN▶▶** (rapisim) uses `fftn` instead of `ifftn`; non-Cartesian uses conjugated k-space before NUFFT — until MR0 and rapisim agree on k-space sign convention.
- **User protocols**: Fixed loading saved protocols from the sequence tree (`user/prot/…`) — parameters and execute no longer fail with `VFS file not found`; protocol source is restored from in-memory code, mirrored to the Pyodide VFS with absolute paths, and persisted in `localStorage` across reloads.

## v0.4.1

- **Fix rotated FOV sim**: Oblique FOV boxes (coronal, sagittal, arbitrary rotation) now produce correct simulations. The phantom affine sent to sim backends is stripped to a pure diagonal (voxel sizes only, no rotation), matching the sim's axis-aligned assumption. Previously the sim read voxel sizes from the affine diagonal, which gave wrong values for rotated grids (e.g. 0.035mm instead of 2mm).

## v0.4.0

- **Recon / k-space toggle**: OPTIONS **recon** checkbox (default on); unchecked writes `log(abs(k)+1)` for k-space debug instead of image recon.
- **Recon matrix = central k-space crop**: Cartesian scans crop acquisition samples to the recon grid when `Nread×Nphase` exceeds mask matrix size (fixes empty recon/k-space for oversampled sequences).
- **4D scan output**: Image recon NIfTIs are `(nx, ny, nz, 2)` — frame 0 = magnitude, frame 1 = phase `[rad]` (Left/Right in Niivue).

## v0.3.1

- **Histogram windowing (Planning)**: Clim histogram under main viewer **A**; joint overlay histogram under preview **B** / compare **C** with shared min/max; tick labels, double-click edit dialog, 4D frame ↔ clims sync; preview/compare pane accent borders.

## v0.3.0

- **Planning compare pane (C)**: Lazy third Niivue (slice-only, no 3D render) to the right of scan preview **B**; **Ctrl+click** a volume or **Ctrl+VIEW SCAN** opens it; **Ctrl+double-click** on **C** tears down the instance and hides the pane to save GPU memory.
- **B ↔ C sync**: Bidirectional crosshair, window/level (clims), slice layout (including multiplanar grid via **V** on either pane); re-sync when **B** or **C** loads a new volume.
- **Scan preview (B)**: Dedicated slice-only viewer for the latest/selected scan; auto-updates after SIM/CROP completion without overwriting in-progress FOV on auto-load.

## v0.2.2

- **ChartGPU** as the default sequence waveform plot (WebGPU); Matplotlib modes remain in the plot-speed selector.
- Shared x-axis alignment across stacked panels without freezing zoom ticks (invisible extent helper); lockstep zoom, crosshair sync, and custom left-drag pan in the sequence explorer.

## v0.2.1

- faster startup and loading flow
- fixed FOV consistency in scan pipeline using frozen `fovSnapshot` geometry
- changed urls consistently to anyfield

## v0.2.0

- introduced links for initial protocols
- added builtin TSE

## v0.1.3

- renamed to Any-Field Scanner
- fixed json execute

## v0.1.2

- fixed pynufft recon + simple density compensation
- still blurry but roughly functional

## v0.1.1

- MRzero simulation call fixed; reconstruction logic moved into maintainable `scan_zero/recon.py` and integrated from `scan_zero/scan_module.js`; `insights/SPEC_scan_module.md` updated accordingly.
- Niivue UI: default **Mask Z** numeric field set to `1` so it matches the slider default (`niivue_app.js`).

## v0.1.0

first normal > and fast >> sim.
