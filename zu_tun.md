## Todo

# Definitly at some point

-- revisit PSF and FOV and traj calculation especially regarding nyquist freq... unclear what exact nyquist shoudl be used regarding different spoilngs.. NYQUIST_SCALE = 1.5 seesm to work ok

-- add full report

-- add "share" link to protocol/ui

-- add phantom and fov and maybe prot setting to url

-- [DONE v1.0.0] crop for large slices is wrong, it takes the center slice and does not interpolate.
   summary:
   - Problem: CROP / Resample-to-FOV / SCAN resampled every output voxel by a single trilinear
     sample at the voxel center. For thick FOV slabs (esp. matrix Z = 1, or small Z like 2)
     the result was a sharp center slice — no averaging over the slab — so changing FOV Z mm
     looked identical instead of blurring/partial-volume averaging the contained voxels.
   - Background: this is "conservative regridding" (volume/footprint-weighted resampling),
     standard in climate/geo tools (ESMF/xESMF), but NOT in nibabel/nilearn/ITK, which all do
     point interpolation by default. So a custom resampler was needed.
   - Fix: added `footprint_mean` mode in `data/resampling.py` (now the default). Each output
     voxel averages trilinear sub-samples taken across its full physical footprint, mapped
     through the FULL affine — so it is general and stays correct for rotated/oblique slices.
   - General approach with fewer substeps: substeps per axis = clamp(ceil(span), 1, cap),
     where span = how many source voxels one reference voxel covers along that axis.
     The box-average converges quickly, so the cap was lowered from 32 to **8 substeps per axis**.
     This matches the old 32-step output visually while running up to ~4x faster on thick slabs
     (the common nz=1 / thick-FOV case). Axes that are not downsampled use 1 substep (unchanged).
   - Wiring: `RESAMPLING_PY_VERSION` bumped (cache-bust + reload of the Python file); options
     `resampleSamplingMode` ("footprint_mean" | "center") and `resampleMaxSubsteps` (default 8)
     are threaded from `niivue_app.js` into Pyodide for CROP, Resample-to-FOV, and SCAN.
   - Possible further speedups (future ideas):

     | Option | Speedup | Exact under rotation? | Effort |
     |---|---|---|---|
     | 1 Fewer substeps (DONE v1.0.0: cap 32→8) | ~5× | Yes | Trivial |
     | 2 Separable coords (per-axis coordinate construction) | small | Yes | Low |
     | 3 Batched interp (all substeps in one interpolation call) | modest | Yes | Low |
     | 4 Prefilter (integral image box filter + single sample) | large, thickness-independent | Approx | Medium |
     | 5 SciPy `map_coordinates` (compiled, if payload acceptable) | large constant | Yes | Low code / heavy payload |

-- save and load fov + phantom from/to seq file
   mini-plan:
   1) write metadata into `seq.definitions` on scan prep with `anyfield_` prefix (e.g. `anyfield_fov_affine_ras_4x4`, `anyfield_phantom_json_name`, optional `anyfield_phantom_hash`).
   2) keep affine as one-line numeric list (row-major 4x4) for robust cross-tool parsing.
   3) on load/view-seq, parse definitions and restore Niivue FOV box + select/match phantom group.
   4) if phantom is missing locally, show warning + keep geometry restore (graceful fallback).


-- in seq_plot .py/.js is a "monkey patch" of seq.calculate_kspace as PyPulseq’s Sequence.calculate_kspace() returns k-trajectory values but, in the public API you use, it does not reliably expose a per-column time array aligned with k_traj. This shoudl be remobved once pypulseq fixes it online.

-- image scaling is somehow weird, try gre 128 and gre 130, very different image intensties. probably due to nuuft/fft recon dcf, partially was fixed already. residual difference is design as signal changes with numer of phantom voxels.


-- speedup at startup: prebundle Pyodide (custom build or pre-built wheels for pypulseq/nibabel). [burden is high because you need a reproducible build pipeline, wheel compatibility checks for Pyodide/Python versions, larger artifact management, and ongoing maintenance whenever Pyodide or deps update.] (benefit: ++, burden: +++)
-- add a Service Worker for caching Pyodide/WASM/assets on repeat visits. [watchouts: stale cache + dev confusion; use versioned cache names, network-first for HTML, cache-first for immutable wasm/wheels, and an easy dev bypass.] (benefit: +++, burden: ++)
-- self-host Pyodide/WASM/package assets (instead of relying only on CDN) for more stable startup. [host `pyodide.js`, `.wasm`, and wheels on your own static host and point `indexURL` there; GitHub Pages works for static files, or use your own server/CDN for more control.] (benefit: ++, burden: +)



# Probably at some point

-- add seq.sound() ( wait for approved PR) (benefit: +, burden: +)
-- move Pyodide work to a Web Worker so long simulations do not block the UI. (benefit: +++, burden: +++)
-- add tool backend pre-warm/retry handling to reduce Fly websocket cold-start failures. (benefit: ++, burden: +)
-- reduce heavy tool payload/response transfer where possible (e.g., conseq/traj data paths). (benefit: ++, burden: ++)

