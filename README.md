# Niivue minimal app (zero-install)

This is a **minimal Niivue viewer** implemented as a single `index.html` file.

## Run (recommended)

Browsers often block ES module imports when opening files directly, so run a tiny local web server:

```powershell
cd "G:\Meine Ablage\FAU\MRzero_group_folder\22_niivue"
python -u -m http.server 8000
```

Then open `http://localhost:8000` in your browser.

## Use

- Click **Load demo (MNI152)** to fetch a sample volume.
- Or upload your own **`.nii` / `.nii.gz`** via the file picker.

## Notes

- Niivue is imported from the CDN `unpkg` (`@niivue/niivue@0.65.0`).
- If you want a **React/Vite** version instead, tell me and I’ll scaffold it (that will require `npm install`, i.e. downloading packages).


