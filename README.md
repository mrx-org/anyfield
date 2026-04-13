# Niivue minimal app (zero-install)

**Version:** `v0.2.0`

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

For more insights see insights SPEC_no_field.md

## Release notes


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
