# Sequence Explorer Specification

## Intent
In-browser Python environment for executing PyPulseq scripts and visualizing MRI sequence waveforms.

## Core Functionality
- **Execution**: Pyodide-powered Python runtime for local sequence generation.
- **Silent Execution**: Support for background sequence generation (without mode switching or plotting) for simulation workflows.
- **Dynamic UI**: Automatic generation of input controls from Python function signatures.
- **Plotting**: Default **ChartGPU** WebGPU stack for RF / gradients / ADC waveforms (`plot_speed='chartgpu'`); Matplotlib modes remain via selector (`full` / `fast` / `faster`). **Details:** [SPEC_seq_plot.md](SPEC_seq_plot.md).
- **Integration**: Synchronizes internal sequence parameters with scanner FOV events and emits `sequenceSelected` for other modules.
- **Editor**: Built-in CodeMirror instance for live sequence logic modification.

## Modular API
- **Class**: `SequenceExplorer`
- **Parts**:
  - `renderTree(target)`: Sequence database / file tree.
  - `renderParams(target)`: Dynamic protocol parameter inputs.
  - `renderPlot(target)`: Waveform output pane (ChartGPU default; matplotlib when another plot speed is selected).
- **Key Methods**:
  - `executeFunction(silent)`: Executes the current sequence with optional UI suppression.

---

## Cases

### 1. Source registry (`sources.toml`)

The registry is **`pypulseq/sources.toml`**. Default entries:

| `name` | `type` | Role |
|--------|--------|------|
| `anyseq` | folder | Built-in sequences from `mrx-org/anyfield/pypulseq/anyseq` |
| `builtin` | folder | Interpreter / built-in seq helpers from `built_in_seq` |
| `mrseq.scripts` | module | Installed `mrseq` package scripts |
| `pypulseq_examples` | folder | Upstream PyPulseq example scripts (GitHub) |
| `MRzero` | file | MRzero playground notebook |

Parsed by `SourceManager.load_sources_config` via `tomllib`.

Each `[[sources]]` entry sets:

- `type` — `"file" | "folder" | "module"`
- `path` — local path, GitHub tree URL, raw URL, or dotted module path
- `name` — tree label, **`s_category` / `init_prot` namespace**, and **VFS import prefix** for folder sources (e.g. `anyseq` → `anyseq.scripts.gre_seq`)
- `dependencies` — PEP 508 install strings (**required** for folder and module sources)
- `micropip_no_deps` — packages installed with micropip `deps=False`

**Folder sources (registry-owned install headers):** Upstream `.py` files may be plain PyPulseq (no PEP/Colab/AnyField wrappers). On `loadFolder()`, the explorer:

1. Fetches raw upstream text from GitHub
2. **Strips** any accidental PEP 723, notebook guard, or `_anyfield_json` blocks
3. **Materializes** PEP 723 + notebook guard from the folder entry's `dependencies` / `micropip_no_deps` (`materializeFolderScript`)
4. Writes the materialized file to VFS and caches it on `sequences[].code`
5. Sets per-file `source.dependencies` from the **registry only** (`source.anyfield = {}` for base sequences)

Micropip installs from `sources.toml` at startup (`loadSequences`) and again per folder if needed. PEP in the cached file matches the registry (for `uv run` / Colab if copied out of the app).

**Module sources (`mrseq.scripts`):** No VFS materialization; registry `dependencies` attach to each discovered function. Installed wheel files are AST-scanned without import.

**First-party artifacts (`user/prot/*`, fixtures):** Loaded via `parseFile`, not `loadFolder`. File-owned PEP + marked `_anyfield_json` are preserved as-is.

**Naming collision:** Folder `name` must not equal an installed PyPI top-level package (e.g. do **not** use `name = "pypulseq"` — use `pypulseq_examples`). Otherwise `import pypulseq.scripts.foo` resolves to the library, not VFS.

### 2. File metadata standard

Two tiers:

| Tier | Examples | PEP 723 | Notebook guard | `_anyfield_json` |
|------|----------|---------|----------------|------------------|
| **Registry folder / module bases** | anyseq, builtin, pypulseq_examples, mrseq | Materialized at load (folders) or registry-only (modules) | Materialized at load (folders) | No |
| **First-party protocols / fixtures** | `user/prot/*`, smoke tests | Yes | Yes | Yes (marked block, required for protocols) |

Generated protocol capsules always use the **full hybrid** format below.

**PEP 723 install block** (install metadata only; no scanner fields in TOML):
```python
# /// script
# requires-python = ">=3.9"
# dependencies = ["numpy", "pypulseq==1.4.2.post2"]
#
# [tool.anyfield]
# micropip_no_deps = ["pypulseq"]
# ///
```

**Notebook setup guard:**
```python
# --- Notebook setup (Colab / Jupyter / JupyterLab / VS Code) ---
_ipython = globals().get('get_ipython', lambda: None)()
if _ipython is not None:
    _ipython.run_line_magic('pip', 'install -q numpy pypulseq==1.4.2.post2')
# --- Notebook setup end ---
```

**AnyField runtime metadata block** (protocols and fixtures only; no `anyfield_config()` helper):
```python
# --- AnyField metadata begin ---
_anyfield_json = r'''
{
  "kind": "protocol",
  "prot_func": "prot_gre",
  "seq_definition": "inline",
  "seq_func": "anyseq.scripts.gre_seq:seq_gre",
  "simulation": {
    "backend": "mr0sim",
    "phantom": "brainweb-20-v2/subj04-3T-1mm-tra",
    "fov_affine": [2.5, 0, 0, -80, 0, 2.5, 0, -80, 0, 0, 2.5, -80, 0, 0, 0, 1],
    "fov_matrix": [64, 64, 1],
    "phantom_matrix": [64, 64, 1],
    "phantom_oversample": [2, 2, 1]
  },
  "recon": {
    "matrix": [8, 8, 1],
    "method": "anyfield-pynufft"
  }
}
'''
# --- AnyField metadata end ---
```

`[simulation]` block is **UI-faithful and provenance-only** (the sim consumes the affine from the live submit payload, not this block). All values mirror the viewer sliders:
- `phantom`: bifti cache id (`collection/name`).
- `fov_affine` (flat row-major 4×4) + `fov_matrix` (`[nx,ny,nz]`, the recon grid): the **NON-oversampled** FOV box; restored on shared-link load via `applyFovFromAffine` → `affineToFovParams`.
- `phantom_matrix`: the **BASE** phantom matrix (matches the sliders); `phantom_oversample`: the oversample factors. The effective/oversampled grid is derived (`phantom_matrix × phantom_oversample`) only when needed (e.g. tooltip).
- Removed vs. legacy: `phantom_fov_affine` (oversampled) and the effective/oversampled `phantom_matrix`. Old files still carry `phantom_fov_affine`; the tooltip no longer renders it, and `phantom_matrix` is treated as the base only when `phantom_oversample` is present.

JSON formatting: **arrays of primitives** (e.g. `fov_affine`, `fov_matrix`, `phantom_matrix`, `phantom_oversample`, `recon.matrix`) are written **on one line**; nested objects remain indented (`formatAnyfieldJson` / `_stringifyAnyfieldJson`).

Protocols always call a base sequence via `_anyfield_base_callable`. Package-backed protocols import a versioned package dependency; non-package protocols inline the base sequence source (wrappers stripped before embed).

### 2a. Metadata parse and cache

- **Authoritative parse:** Python `parse_script_metadata(code)` at `loadFolder`, `parseFile`, share import
- **Runtime cache:** `source.anyfield` (+ `source.dependencies`) on each sequence/protocol entry
- **Hot paths** (tooltips, chain walk, share validation): read **`source.anyfield`** first
- **Sync fallback:** `extractAnyfieldJsonFromCode()` — marked block only (~15 lines), when cache absent

Legacy paths removed: `sources_config.py`, PEP scanner fields in TOML (`entry`, sim/recon in PEP), `anyfield_config()` emission, unmarked JSON fallbacks.

### 3. Tree organization

- **User Refined**: user-edited **sequences** (saved under `user/seq/`).
- **User Protocols**: user-saved **protocols** (saved under `user/prot/`).
- Other groups by source `name` (e.g. anyseq, mrseq.scripts).

### 4. Virtual filesystem layout (Pyodide)

All in-memory paths used for loading and saving. **Every loaded sequence is stored under a package layout** so it can be imported as a module (see §4a).

- **`user/seq/`** — User-edited sequences only. Save As (from the editor) shows and overwrites only files here. Treated as package `user.seq` for imports; each sequence has **`fullModulePath`** (e.g. `user.seq.foo`).
- **`user/prot/`** — User-saved protocols only. Treated as package `user.prot` for imports; each protocol has **`fullModulePath`** (e.g. `user.prot.prot_gre`). Set when saving a protocol snapshot and when loading from `user/prot/`.
- **`/remote_modules/`** — Single files fetched from a URL (GitHub raw, remote file, MRzero notebook, etc.) are written only here (no separate `remote/` cache). Sequence key is **`fullModulePath`** (e.g. `remote_modules.foo`).
- **`/<name>/scripts/`** — Files from a folder source are written under `/<name>/scripts/` (e.g. `/anyseq/scripts/`, `/pypulseq_examples/scripts/`). Sequence key is **`fullModulePath`** (e.g. `anyseq.scripts.gre_seq`, `pypulseq_examples.scripts.write_epi`).

Built-in sequences are fetched from GitHub (`anyseq`, `builtin` folder sources) and materialized into VFS as above. The Save As dialog lists only `user/seq/` or `user/prot/` so loaded registry files do not appear there.

**Session-only user artifacts:** `user/seq/` and `user/prot/` exist only for the current browser session (Pyodide VFS + in-memory). A full reload starts a fresh scanner — no `localStorage` restore. To keep protocols: **Download** (tree menu) or **Share** (`#protocol_gz` URL). Cross-session restore from disk is deferred.

#### 4a. Unified module model (all seq funcs as modules)

**Intent:** `sources.toml` only describes *where* to get code (`type`, `path`/`url`). At runtime, **every loaded sequence function is always used as a module** — i.e. we always call with `module_path` and `function_name`, never with raw `code`.

**Benefits:**
- **Single code path** for parameter extraction and execution: no branching on “file vs module”.
- **Faster inspect:** `importlib.import_module(module_path)` then `inspect.signature(getattr(module, function_name))`. No `exec(code)` of the full file; `if __name__ == '__main__':` blocks do not run on import.
- **Predictable behavior:** No accidental execution of script blocks; same semantics for built-ins, folder, remote, and user files.

**Implementation outline:**
- Each **loader** (built-in file, folder, remote file, local/user file) must:
  1. Fetch or read the code from the configured path/url (unchanged).
  2. Write files into a VFS directory that is a valid Python package (with `__init__.py` where needed), e.g. `/anyseq/scripts/`, `/pypulseq_examples/scripts/`, `/remote_modules/`, `/user/seq/`, `/user/prot/`.
  3. Set **`fullModulePath`** (e.g. `anyseq.scripts.gre_seq`, `pypulseq_examples.scripts.write_epi`, `user.seq.foo`, `user.prot.prot_gre`) for each discovered sequence/protocol and attach it to the source/sequence metadata. The sequence key in the explorer is `fullModulePath` for folder and remote; for user files it is path or `fullModulePath` as set by the loader.
- **Parameter loading** and **execution** use only the module path: `extract_function_parameters(module_path, function_name)` and `execute_function(module_path, function_name, args_dict)`. There is no `code` argument or fallback; if `fullModulePath` is missing, the UI throws a clear error (e.g. "Sequence has no module path; cannot load parameters."). All loaders must provide `fullModulePath`.
- Protocol generation and import statements use the same module path (e.g. `from anyseq.scripts.gre_seq import seq_gre`).

### 5. Protocol generation and FOV sync

Protocol files are generated with:
- A PEP 723 header for install metadata only: `dependencies` plus `[tool.anyfield] micropip_no_deps` hints for Pyodide.
- The portable Colab/Jupyter install guard in the body (built from the protocol's dependencies).
- A marked `_anyfield_json` block (`# --- AnyField metadata begin ---` ... `# --- AnyField metadata end ---`) with scanner/runtime metadata: `kind`, `prot_func`, `seq_definition = "package" | "inline"`, `seq_func = "module:callable"`, `simulation`, `recon`, and optional `seq_origin`.
- Package-backed bases (e.g. `mrseq`) keep an import wrapper and pin bare package dependencies to the installed version when saving.
- Non-package bases (folder/raw/local sources such as `anyseq` or pypulseq examples) are frozen inline into the protocol body, then `def prot_*(...): return _anyfield_base_callable(**kwargs)` forwards parameters. The generated protocol is standalone for UV/Colab as long as its package dependencies install.

**Automatic protocol on SIM:** The Scan Module calls `executeFunction(silent=true, protocolName)` with the scan number as `protocolName`. The Sequence Explorer creates a protocol snapshot with a scan-number prefix (e.g. `user/prot/4_prot_3_gre.py`, display **`4. 3.gre`**) and registers it under User Protocols; the protocol always calls the **base sequence** (after resolving protocol-of-protocol chains).

**Protocol-of-protocol naming:** When the selected sequence is already a numbered protocol (`user/prot/3_prot_gre.py`), the Scan Module draft defaults the **name** to `{parentScan}.{label}` (e.g. `3.gre`), shown in the queue row as **`4. 3.gre`** (next scan number + draft name). `saveProtocolSnapshot` uses the same stem for the filename prefix (`4_prot_3_gre.py`). Helpers: `protocolDerivedDefaultName`, `protocolUserLabelFromPath`.

**FOV from Pulseq (authoritative for mm size):** After a successful silent execute with `protocolName`, the explorer reads **`seq.definitions['FOV']`** from the last built sequence (`SourceManager._last_sequence` / `__main__.seq`), converts **m → mm**, and emits **`sequence_fov_dims`** on the event hub. Niivue applies this to the FOV **size** sliders (`applySequenceFovDimensions`). **Why:** the sequence run defines the true acquisition FOV; traj / k-space and recon must use the same physical extent. **Mask matrix (X/Y/Z), offsets, and rotation** remain whatever the user set in the FOV tab — only the **mm box size** is overwritten from the sequence.

**Order with SIM (fixes mesh vs recon mismatch):** `runSimPipeline` must call this silent execute **before** `generateFovMaskNifti()`. If the mask is built with old slider FOV and the sequence later pushes different mm values, the ref grid and PyNUFFT output no longer match the yellow box until `loadJob` resyncs — that looked like grow/shrink. With seq-first order, mask + recon + on-screen FOV stay aligned.

**Manual sync:** **`getFovFromSequence()`** still exists for explicitly re-running the sequence and pushing FOV without starting a full SIM job.

**Protocol source enrichment:** When parsing protocol files (`user/prot/...`), `parseFile` runs `parse_script_metadata` and stores **`source.anyfield`** (canonical cache). Tree filter uses `prot_func` from JSON. Inline capsules expose only their `prot_func` in the tree and call their originating base through `_anyfield_base_callable`. `resolveProtocolBaseEntry` walks `seq_func` chains for protocol-of-protocol.

**Re-scanning protocols:** Re-scanning a package protocol creates a new protocol that calls the same package base. Re-scanning an inline capsule creates a new inline capsule from the selected protocol file, preserving standalone behavior.

**Sharing / receiving protocols:** The params header includes two share actions. The dashed share icon is a light source link and is only visible for configured `sources.toml` sequences (`anyseq`, `mrseq`, `pypulseq_examples`, …); it copies `?s_category=...&s_file=...&s_func=...` plus changed-only `sp_<param>=...` overrides from the current params pane. `s_category` matches the source `name` in `sources.toml`. The solid share icon first snapshots the current params pane into a protocol capsule, gzip-compresses JSON `{ v, kind, filename, code }`, base64url-encodes it, and writes `#protocol_gz=...` into a share URL. On startup, `#protocol_gz` is imported before normal `init_prot` selection: the protocol is stored under `user/prot/`, parsed, rendered, and selected (session only). It is not auto-run. `init_prot` / `s_category` links remain selector-only links for existing configured sources.

### 6. Parameter inspection and protocol arguments

**Intent:** The UI builds dynamic parameter controls from the **base sequence**’s function signature. When executing or when saving a protocol, we need to turn UI values into Python argument expressions that the base sequence accepts.

**Inspection (Python, `seq_source_manager.py`) — inspect only:**
- Parameters are extracted via **inspect only**: get the function (by importing the module), then `inspect.signature(func)` and each parameter's default. No AST path; one code path, real runtime types and defaults.
- **Resolving the function (unified module model, §4a):** All loaded sequences and protocols have a `fullModulePath`. We always use **`importlib.import_module(module_path)`** then **`getattr(module, function_name)`**. No `exec(code)`; if `module_path` is missing, Python raises `ValueError("module_path must be provided")`. The JS throws a user-facing error when `fullModulePath` is absent (e.g. for protocols, ensure it is set when saving and when loading from `user/prot/` or `user/seq/`).
- **Type normalization:** All extracted types are normalized before sending to the frontend:
  - `tuple` and `list` → stored as **type `'list'`**, value converted to a list (so the sequence’s `fov: tuple = (256e-3, 256e-3, 3e-3)` becomes type `'list'` and default `[0.256, 0.256, 0.003]`).
  - `np.ndarray` → **type `'ndarray'`**, value as list (`.tolist()`).
  - Other types → type is `type(default).__name__` (e.g. `'int'`, `'float'`, `'bool'`, `'str'`), or `'None'` if no default.
- Runs when the user selects a sequence in the UI (once per selection). Cost is dominated by import/exec; `inspect.signature()` is negligible. Signature types (e.g. tuple) are normalized to list/ndarray in the UI.

**Protocol argument generation (JS, `seq_explorer.js`):**
- When building the protocol file or the execute script, UI values are turned into Python expression strings:
  - `bool` → `'True'` / `'False'`.
  - `int` / `float` → value as-is (literal).
  - `list` or `ndarray` → **`np.array(${inputValue})`**, where `inputValue` is the text field content (e.g. `[0.256, 0.256, 0.003]` or `256e-3, 256e-3, 3e-3`). So the **protocol** always passes an array for these, even if the sequence signature was `tuple`.
  - `str` → value in double quotes.
  - Other / unknown → value as raw expression.
- Result: in “edit sequence” the user sees `fov: tuple = (256e-3, 256e-3, 3e-3)`; in the generated protocol they see `fov= np.array([...])`. The base sequence typically accepts both tuple and array, but the representation is inconsistent.

**Possible improvements (for a later revision):**
- Preserve **tuple** as a distinct type in extraction and in the UI (e.g. type `'tuple'`), and in the protocol generate `tuple(...)` or `(a, b, c)` instead of `np.array(...)` when the sequence parameter is typed as tuple.
- Or document that we intentionally normalize to list/ndarray and always pass `np.array(...)` so the base sequence receives a numpy array regardless of signature style.
- Optionally use **annotation** from the source (e.g. `fov: tuple`) when AST/inspect can provide it, so the UI and protocol generator can match the sequence’s declared type.

### 7. seq_pulseq_interpreter

**Intent:** Allow loading a Pulseq `.seq` file (from upload or from a path/URL) and using it as the current sequence for plot and scan, without a separate “interpreter” code path. Integrates with the existing inspect → params → execute flow.

**Approach:** A built-in sequence `seq_pulseq_interpreter(filename=...)` that reads the given path with `pypulseq.Sequence().read(filename)` and returns the sequence. Standard parameter inspection then exposes a single `filename` parameter. A **special parameter type** (`'file'` or `'url'`) is used so the UI can render an upload control in addition to a text field.

**Python (anyseq sequence):**
- The file `anyseq/seq_pulseq_interpreter.py` carries a PEP 723 header and:
  - `def seq_pulseq_interpreter(seq_file: Annotated[str, "file"] = "epi_se_rs.seq"):` (or type alias `SeqFile = Annotated[str, "file"]`).
  - Implementation: `seq = pp.Sequence(); seq.read(seq_file); return seq`.
- It lives in the `anyseq/` folder and is discovered via the `anyseq` GitHub folder source (no separate registration).

**Type detection (Python, `seq_source_manager.py`):**
- In `extract_function_parameters`, after deriving `type_name` from the default value, **optionally** inspect the parameter’s annotation.
- If the annotation is `typing.Annotated[...]` (use `get_origin` and `get_args`), and the metadata (second element of `get_args`) is the string `"file"` or `"url"`, set `type_name = 'file'` or `'url'` instead of `'str'`.
- No other inspect logic changes; only this override for annotated params.

**Param UI (JS, `seq_explorer.js`):**
- In `renderParameterControls`, for `param.type === 'file'` or `param.type === 'url'`: render a **text input** (path/URL) plus an **upload button** (for `'file'`). On file selection: write the file to the Pyodide VFS (e.g. `/uploads/`), ensure the directory exists, and set the text input’s value to that VFS path. The value passed to execute is always a string (path or URL).
- In all places that build Python argument expressions from params (executeFunction, protocol save, TOML/save): treat `'file'` and `'url'` like `'str'` (quoted string).

**VFS and protocols:**
- Uploaded files live in session-scoped VFS (e.g. `/uploads/`). Temporary VFS is acceptable; no persistence required.
- Protocols that wrap `seq_pulseq_interpreter` store the `filename` argument as a string (the path or URL). The protocol thus “links” to the seq file via that string. Same session: path still valid; new session: user can re-upload or use a server URL if supported.

**Scan integration:** Execution runs `seq_pulseq_interpreter(seq_file=...)`; the returned sequence is stored in `__main__.seq` and `SourceManager._last_sequence` as for any other sequence. The **Scan Module** treats the interpreter specially when saving the job’s `.seq` file: instead of calling `seq.write()`, it **copies the original** user-specified `.seq` file (path from the `seq_file` param) to `/outputs/scan_[N]_[TS]_[Name].seq`. That way VIEW SEQ and Download always have a valid file (no dependence on pypulseq write/read round-trip).

### 8. ChartGPU plot mode (`plot_speed='chartgpu'`, **default** in UI + `seq_plot` default)

**Full specification:** [SPEC_seq_plot.md](SPEC_seq_plot.md) (Python `seq_plot_utils.py`, JS module `seq_plot.js`, CSS, zoom/pan/sync, pinned ChartGPU version, failure modes, Scan Module notes).

**One-line summary:** Python exports a JSON payload after `seq.plot(..., plot_speed='chartgpu')`; `seq_plot.js` loads ChartGPU over WebGPU, renders six stacked panels, syncs zoom/crosshair, and tears down via `disposeSeqChartGpuHost`; Matplotlib modes remain for other `plot_speed` values.

---

*Parse and use when needed (Python side, `seq_source_manager.py`):*
```python
# from seq_source_manager import parse_script_metadata
# meta = json.loads(parse_script_metadata(code))
# deps = meta['dependencies']              # PEP 508 array from PEP 723
# anyfield = meta['anyfield']              # parsed _anyfield_json + install hints
# prot_func = anyfield.get('prot_func')    # protocol callable in this file
# seq_func = anyfield.get('seq_func')      # underlying "module:callable"
```
