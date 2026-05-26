# Niivue minimal app (zero-install)

**Version:** `v0.6.1`

This is a **minimal Niivue viewer** implemented as a single `viewer.html` file.

## Run (recommended)
Browsers often block ES module imports when opening files directly, so run a tiny local web server:
```powershell
python -u -m http.server 8000
```
Then open `http://localhost:8000` (main **Any-Field Scanner** UI: `index.html`).

### Deep links (initial sequence)

**Readable (recommended):** three query parameters — category (namespace), file stem, function name:

```text
http://localhost:8000/?s_category=<ns>&s_file=<stem>&s_func=<name>
```

Example: pypulseq `write_epi` / `main`:

`http://localhost:8000/?s_category=pypulseq&s_file=write_epi&s_func=main`

Use the real file stem (no `.py`) and the exact Python function name. Namespaces:

| Namespace (`s_category`) | Meaning |
|--------------------------|---------|
| `builtin`  | `pypulseq/built_in_seq/<stem>.py` |
| `mrseq`    | `mrseq.scripts.<stem>` — `<stem>` is the **module name** (e.g. `radial_flash` from `radial_flash.py` in [mrseq/scripts](https://github.com/PTB-MR/mrseq/tree/main/src/mrseq/scripts)) |
| `pypulseq` | `pypulseq_examples.scripts.<stem>` from the GitHub examples source in `sources_config.py` |

If **all three** of `s_category`, `s_file`, and `s_func` are present and non-empty, they are combined as `namespace/file_stem:function_name` for startup. Otherwise **`init_prot`** is used if set (legacy, single encoded token).

**Legacy `init_prot`:** `?init_prot=<token>` with `token` = `namespace/file_stem:function_name`. Encode the whole token with `encodeURIComponent` if you build it in code:

```js
const token = 'pypulseq/write_epi:main';
const url = `http://localhost:8000/?init_prot=${encodeURIComponent(token)}`;
```

**More examples (readable params; local server on port 8000):**

1. Pulseq interpreter  
   `http://localhost:8000/?s_category=builtin&s_file=seq_pulseq_interpreter&s_func=seq_pulseq_interpreter`

2. TSE asymmetric protocol  
   `http://localhost:8000/?s_category=builtin&s_file=mr0_tse_2d_seq&s_func=prot_TSE_2D_asym_ex`

3. Built-in GRE  
   `http://localhost:8000/?s_category=builtin&s_file=gre_seq&s_func=seq_gre`

4. mrseq `radial_flash` / `main`  
   `http://localhost:8000/?s_category=mrseq&s_file=radial_flash&s_func=main`

5. pypulseq `write_radial_gre` / `main`  
   `http://localhost:8000/?s_category=pypulseq&s_file=write_radial_gre&s_func=main`

If no deep link is given, the app starts with the built-in Pulseq interpreter selection.

### Remote `.seq` file (`seq_url`)

Load a Pulseq `.seq` from an HTTPS URL into the interpreter (browser `fetch`; host must allow CORS):

```text
http://localhost:8000/?seq_url=<encodeURIComponent(https://raw.githubusercontent.com/.../my.seq)>
```

e.g. 

```text
http://localhost:8000/?seq_url=https://raw.githubusercontent.com/pulseq-frame/test-seqs/refs/heads/main/spiral-TSE/ssTSE.seq
```

`seq_url` alone selects **builtin / seq_pulseq_interpreter / seq_pulseq_interpreter** automatically.

Combine with an explicit protocol deep link:

```text
http://localhost:8000/?s_category=builtin&s_file=seq_pulseq_interpreter&s_func=seq_pulseq_interpreter&seq_url=<encoded-url>
```

For more insights see insights SPEC_no_field.md

## Release notes


**v0.6.1**
- **Rapisim button (pro only)**: **SCAN▶▶** (tool-rapisim) is hidden unless the app is opened with `?pro=1` (same flag as the JSON tab and debug UI).
- **SIM phantom (NIfTI JSON)**: SCAN conversion follows the [NIfTI phantom spec](https://mrsources.github.io/MRzero-Core/nifti-spec.html)—spatial per-tissue **dB0** from file refs and `{file, func}` mappings (e.g. fat chemical shift), full-grid **B1±** maps (not masked to a single tissue), and **T1/T2/ADC** as constants or density-weighted means when map-backed.
- **Asymmetric TSE/RARE**: fixed default **dTE** in built-in asymmetric protocols.

**v0.6.0**
- **`seq_url` deep link**: `?seq_url=` fetches a remote `.seq` into the Pulseq interpreter (optional with `s_category` / `s_file` / `s_func`); `seq_url` alone auto-selects the interpreter.
- **Rapisim spiral / NUFFT recon**: non-Cartesian recon conjugates k-space before PyNUFFT adjoint (`_backend_kspace_fix`); Cartesian still uses `fftn` vs `ifftn`.
- Added warmup for API calls and earlier toolapi load.

**v0.5.0**
- **Phantom FOV oversampling**: FOV tab input `[sx,sy,sz]` (default `[1,1,1]`) scales sim phantom matrix and FOV mm without changing the on-screen FOV box or recon grid.

**v0.4.2**
- **Rapisim recon orientation (temporary)**: Cartesian recon for **SCAN▶▶** (rapisim) uses `fftn` instead of `ifftn`; non-Cartesian uses conjugated k-space before NUFFT — until MR0 and rapisim agree on k-space sign convention.
- **User protocols**: Fixed loading saved protocols from the sequence tree (`user/prot/…`) — parameters and execute no longer fail with `VFS file not found`; protocol source is restored from in-memory code, mirrored to the Pyodide VFS with absolute paths, and persisted in `localStorage` across reloads.

**v0.4.1**
- **Fix rotated FOV sim**: Oblique FOV boxes (coronal, sagittal, arbitrary rotation) now produce correct simulations. The phantom affine sent to sim backends is stripped to a pure diagonal (voxel sizes only, no rotation), matching the sim's axis-aligned assumption. Previously the sim read voxel sizes from the affine diagonal, which gave wrong values for rotated grids (e.g. 0.035mm instead of 2mm).

**v0.4.0**
- **Recon / k-space toggle**: OPTIONS **recon** checkbox (default on); unchecked writes `log(abs(k)+1)` for k-space debug instead of image recon.
- **Recon matrix = central k-space crop**: Cartesian scans crop acquisition samples to the recon grid when `Nread×Nphase` exceeds mask matrix size (fixes empty recon/k-space for oversampled sequences).
- **4D scan output**: Image recon NIfTIs are `(nx, ny, nz, 2)` — frame 0 = magnitude, frame 1 = phase `[rad]` (Left/Right in Niivue).

**v0.3.1**
- **Histogram windowing (Planning)**: Clim histogram under main viewer **A**; joint overlay histogram under preview **B** / compare **C** with shared min/max; tick labels, double-click edit dialog, 4D frame ↔ clims sync; preview/compare pane accent borders.

**v0.3.0**
- **Planning compare pane (C)**: Lazy third Niivue (slice-only, no 3D render) to the right of scan preview **B**; **Ctrl+click** a volume or **Ctrl+VIEW SCAN** opens it; **Ctrl+double-click** on **C** tears down the instance and hides the pane to save GPU memory.
- **B ↔ C sync**: Bidirectional crosshair, window/level (clims), slice layout (including multiplanar grid via **V** on either pane); re-sync when **B** or **C** loads a new volume.
- **Scan preview (B)**: Dedicated slice-only viewer for the latest/selected scan; auto-updates after SIM/CROP completion without overwriting in-progress FOV on auto-load.

**v0.2.2**
- **ChartGPU** as the default sequence waveform plot (WebGPU); Matplotlib modes remain in the plot-speed selector.
- Shared x-axis alignment across stacked panels without freezing zoom ticks (invisible extent helper); lockstep zoom, crosshair sync, and custom left-drag pan in the sequence explorer.

**v0.2.1**
- faster startup and loading flow
- fixed FOV consistency in scan pipeline using frozen `fovSnapshot` geometry
- changed urls consitently to anyfield


**v0.2.0**
- introduced links for initial protocols
- added builtin TSE

**v0.1.3**
- renamed to Any-Field Scanner
- fixed json execute

**v0.1.2**
- fixed pynufft recon + simple density compensation
- still blurry but roughly functional


**v0.1.1**
- MRzero simulation call fixed; reconstruction logic moved into maintainable `scan_zero/recon.py` and integrated from `scan_zero/scan_module.js`; `insights/SPEC_scan_module.md` updated accordingly.
- Niivue UI: default **Mask Z** numeric field set to `1` so it matches the slider default (`niivue_app.js`).


**v0.1.0**
first normal > and fast >> sim. 
