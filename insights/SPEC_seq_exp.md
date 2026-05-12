# Sequence Explorer Specification

## Intent
In-browser Python environment for executing PyPulseq scripts and visualizing MRI sequence waveforms.

## Core Functionality
- **Execution**: Pyodide-powered Python runtime for local sequence generation.
- **Silent Execution**: Support for background sequence generation (without mode switching or plotting) for simulation workflows.
- **Dynamic UI**: Automatic generation of input controls from Python function signatures.
- **Plotting**: Default **ChartGPU** WebGPU stack for RF / gradients / ADC waveforms (`plot_speed='chartgpu'`); Matplotlib modes remain via selector (`full` / `fast` / `faster`, see §8).
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

### 1. Web Scraping and sources_config

This is what the sources_config.py does. We scrape:
- pypulseq examples from GitHub folder
- mrseq sequences from the mrseq module
- MRzero sequences from the playground (GitHub folder)
- specific .py files from GitHub or a remote website
- sequences from a local folder (built-in), e.g. served from localhost

All of them are loaded in the seq explorer and mirrored into the local Pyodide structure so they can be remixed. For remixing and playback, each file carries a **mini TOML** header (see below). Config sources use `type` ("file" | "folder" | "module"), `path` (or `url`), optional `name` (tree label), **`seq_func`** (entry-point function; legacy: `base_sequence`), and `dependencies`.

### 2. Mini TOML in each file

Each sequence or protocol file has a header that describes dependencies and metadata. With this header, the app can install deps, resolve imports, and run the file.

**TOML schema (single source of truth):**
- **`[dependencies]`**: package specs (e.g. `pypulseq = "*"`).
- **`[metadata]`**:
  - **`kind`**: `"sequence"` | `"protocol"` — whether this file is a sequence or a protocol wrapper.
  - **`seq_func_file`**: path/module of the **sequence we use** (call target). For a sequence file = this file; for a protocol = the file we import from and call.
  - **`seq_func`**: name of the **function we call** (call target). For a sequence = this file’s function; for a protocol = the base sequence (e.g. `seq_gre`, `main`). Protocol files do **not** store their own name in TOML.
  - **`type`**: `"file"` | `"module"` (loader type).

**Example — sequence file:**
```python
# Source configuration (TOML format)
_source_config_toml = """
[dependencies]
    pypulseq = "*"

[metadata]
kind = "sequence"
seq_func_file = "built_in_seq/mr0_rare_2d_seq.py"
seq_func = "seq_RARE_2D"
type = "file"
"""
```

**Example — protocol file (wraps a sequence; TOML only describes the call target):**
```python
# Source configuration (TOML format)
_source_config_toml = """
[dependencies]
    pypulseq = "*"

[metadata]
kind = "protocol"
seq_func_file = "built_in_seq/gre_seq.py"
seq_func = "seq_gre"
type = "file"
"""
# ... import and def prot_gre(...): return seq_gre(**kwargs)
```

Protocols always call the base sequence (`seq_*` or `main`). Saving a protocol from an existing protocol still generates code that calls the original base, not a `prot_*` function.

### 3. Tree organization

- **User Refined**: user-edited **sequences** (saved under `user/seq/`).
- **User Protocols**: user-saved **protocols** (saved under `user/prot/`).
- Other groups by source `name` (e.g. Built-in, mrseq.scripts).

### 4. Virtual filesystem layout (Pyodide)

All in-memory paths used for loading and saving. **Every loaded sequence is stored under a package layout** so it can be imported as a module (see §4a).

- **`user/seq/`** — User-edited sequences only. Save As (from the editor) shows and overwrites only files here. Treated as package `user.seq` for imports; each sequence has **`fullModulePath`** (e.g. `user.seq.foo`).
- **`user/prot/`** — User-saved protocols only. Treated as package `user.prot` for imports; each protocol has **`fullModulePath`** (e.g. `user.prot.prot_gre`). Set when saving a protocol snapshot and when loading from `user/prot/`.
- **`/remote_modules/`** — Single files fetched from a URL (GitHub raw, remote file, MRzero notebook, etc.) are written only here (no separate `remote/` cache). Sequence key is **`fullModulePath`** (e.g. `remote_modules.foo`).
- **`/<package>_examples/scripts/`** — Files from a folder source (e.g. pypulseq examples, MRzero playground) are written only under this package path (no separate `folder/<sourceKey>/` cache). Sequence key is **`fullModulePath`** (e.g. `pypulseq_examples.scripts.gre`).

Built-in sequences are mirrored under **`/built_in_seq/`** (filesystem root) for imports (`built_in_seq.gre_seq`, etc.). The Save As dialog lists only `user/seq/` or `user/prot/` so loaded pypulseq/MRzero files do not appear there.

#### 4a. Unified module model (all seq funcs as modules)

**Intent:** Config (JSON / sources_config) only describes *where* to get code (`type`, `path`/`url`). At runtime, **every loaded sequence function is always used as a module** — i.e. we always call with `module_path` and `function_name`, never with raw `code`.

**Benefits:**
- **Single code path** for parameter extraction and execution: no branching on “file vs module”.
- **Faster inspect:** `importlib.import_module(module_path)` then `inspect.signature(getattr(module, function_name))`. No `exec(code)` of the full file; `if __name__ == '__main__':` blocks do not run on import.
- **Predictable behavior:** No accidental execution of script blocks; same semantics for built-ins, folder, remote, and user files.

**Implementation outline:**
- Each **loader** (built-in file, folder, remote file, local/user file) must:
  1. Fetch or read the code from the configured path/url (unchanged).
  2. Write files into a VFS directory that is a valid Python package (with `__init__.py` where needed), e.g. `/built_in_seq/`, `/pypulseq_examples/scripts/`, `/remote_modules/`, `/user/seq/`, `/user/prot/`.
  3. Set **`fullModulePath`** (e.g. `built_in_seq.gre_seq`, `pypulseq_examples.scripts.gre`, `user.seq.foo`, `user.prot.prot_gre`) for each discovered sequence/protocol and attach it to the source/sequence metadata. The sequence key in the explorer is `fullModulePath` for folder and remote; for built-in and user it is path or `fullModulePath` as set by the loader.
- **Parameter loading** and **execution** use only the module path: `extract_function_parameters(module_path, function_name)` and `execute_function(module_path, function_name, args_dict)`. There is no `code` argument or fallback; if `fullModulePath` is missing, the UI throws a clear error (e.g. "Sequence has no module path; cannot load parameters."). All loaders must provide `fullModulePath`.
- Protocol generation and import statements use the same module path (e.g. `from built_in_seq.gre_seq import seq_gre`).

### 5. Protocol generation and FOV sync

Protocol files are generated with:
- TOML header with `kind = "protocol"`, `seq_func_file` and `seq_func` set to the **call target** (the base sequence), plus dependencies.
- An import for the base sequence and a `def prot_*(...): return seq_func(**kwargs)` that forwards parameters. No protocol file path or `prot_*` name is written into the TOML.

**Automatic protocol on SIM:** The Scan Module calls `executeFunction(silent=true, protocolName)` with the scan number as `protocolName`. The Sequence Explorer creates a protocol snapshot with a scan-number prefix (e.g. `1_prot_gre.py`) and registers it under User Protocols; the protocol always calls the **base sequence**.

**FOV from Pulseq (authoritative for mm size):** After a successful silent execute with `protocolName`, the explorer reads **`seq.definitions['FOV']`** from the last built sequence (`SourceManager._last_sequence` / `__main__.seq`), converts **m → mm**, and emits **`sequence_fov_dims`** on the event hub. Niivue applies this to the FOV **size** sliders (`applySequenceFovDimensions`). **Why:** the sequence run defines the true acquisition FOV; traj / k-space and recon must use the same physical extent. **Mask matrix (X/Y/Z), offsets, and rotation** remain whatever the user set in the FOV tab — only the **mm box size** is overwritten from the sequence.

**Order with SIM (fixes mesh vs recon mismatch):** `runSimPipeline` must call this silent execute **before** `generateFovMaskNifti()`. If the mask is built with old slider FOV and the sequence later pushes different mm values, the ref grid and PyNUFFT output no longer match the yellow box until `loadJob` resyncs — that looked like grow/shrink. With seq-first order, mask + recon + on-screen FOV stay aligned.

**Manual sync:** **`getFovFromSequence()`** still exists for explicitly re-running the sequence and pushing FOV without starting a full SIM job.

**Protocol source enrichment:** When parsing protocol files (`user/prot/...`), the stored source is enriched with `seq_func_file` and `seq_func` from the file’s TOML. That way the base sequence is known even after reload, so re-scanning or loading the protocol later still resolves the correct call target.

**Re-scanning protocols:** Re-scanning an existing protocol (e.g. `1_prot_gre`) creates a new numbered protocol (e.g. `2_prot_gre`) that calls the **same base sequence** (e.g. built-in `seq_gre`), not the previous protocol. This applies to built-in, folder, and module-derived protocols alike.

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

**Python (built-in sequence):**
- Add a built-in file (e.g. `built_in_seq/seq_pulseq_interpreter.py`) with a TOML header and:
  - `def seq_pulseq_interpreter(filename: Annotated[str, "file"] = "fn.seq"):` (or type alias `SeqFile = Annotated[str, "file"]`).
  - Implementation: `seq = pp.Sequence(); seq.read(filename); return seq`.
- Add this file to `sources_config.py` like other built-in sequences.

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

- **Python:** `pypulseq/seq_plot_utils.py` — payload via `build_chartgpu_payload` / `get_chartgpu_payload_json()` after `seq.plot(..., plot_speed='chartgpu')` (no `plt.show()` for that path).
- **JS/CSS:** `pypulseq/seq_explorer.js` (`renderSeqChartGpuAfterPlot`, dispose, execute-script branch), `pypulseq/seq_explorer.css` (`.seq-chartgpu-*`). Dynamic import URL and ChartGPU version are pinned in JS.
- **Behavior (short):** WebGPU required; six stacked charts; `connectCharts` crosshair sync + lockstep x-zoom; plain left-drag pan (move threshold); tooltips off; shared x span uses an invisible extent line (`__seqXExtent__`) so value-axis ticks still follow zoom (see comments there — explicit `xAxis.min`/`max` pins tick domain in ChartGPU).

**ChartGPU upstream docs (for the next agent):** repo [ChartGPU/ChartGPU](https://github.com/ChartGPU/ChartGPU) — especially [`docs/api/options.md`](https://github.com/ChartGPU/ChartGPU/blob/main/docs/api/options.md), [`docs/api/chart.md`](https://github.com/ChartGPU/ChartGPU/blob/main/docs/api/chart.md), [`docs/api/interaction.md`](https://github.com/ChartGPU/ChartGPU/blob/main/docs/api/interaction.md), [`docs/api/annotations.md`](https://github.com/ChartGPU/ChartGPU/blob/main/docs/api/annotations.md); guides under [`docs/guides/`](https://github.com/ChartGPU/ChartGPU/tree/main/docs/guides).

---

*Parse and use when needed:*
```python
# import tomli
# config = tomli.loads(_source_config_toml)
# deps = list(config['dependencies'].keys())
```
