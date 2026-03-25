# Niivue minimal app (zero-install)

**Version:** `v0.1.2`

This is a **minimal Niivue viewer** implemented as a single `viewer.html` file.

## Run (recommended)
Browsers often block ES module imports when opening files directly, so run a tiny local web server:
```powershell
python -u -m http.server 8000
```
Then open `http://localhost:8000` 

For more insights see insights SPEC_no_field.md

## Release notes

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
