## Todo

-- clean up and make (new) bifti and mrzerocloud packages (pyiodide able)
use them to call all related things

-- add a breast bifti, and startup bifti picker

-- -- move Pyodide work to a Web Worker so long simulations do not block the UI. (benefit: +++, burden: +++)
add a Web Worker for caching Pyodide/WASM/assets on repeat visits. [watchouts: stale cache + dev confusion; use versioned cache names, network-first for HTML, cache-first for immutable wasm/wheels, and an easy dev bypass.] (benefit: +++, burden: ++)
Move JS to py in webworker again, using actual MRZerocloud from 1.

-- revisit PSF and FOV and traj calculation especially regarding nyquist freq... unclear what exact nyquist shoudl be used regarding different spoilngs.. NYQUIST_SCALE = 1.5 seesm to work ok

-- add seq_check report

-- add phantom and fov and maybe prot setting to url, read it from prot file on request

-- in seq_plot .py/.js is a "monkey patch" of seq.calculate_kspace as PyPulseq’s Sequence.calculate_kspace() returns k-trajectory values but, in the public API you use, it does not reliably expose a per-column time array aligned with k_traj. This shoudl be remobved once pypulseq fixes it online. is fixed in pp 1.5.2 i think

-- image scaling is somehow weird, try gre 128 and gre 130, very different image intensties. probably due to nuuft/fft recon dcf, partially was fixed already. residual difference is design as signal changes with numer of phantom voxels.

-- speedup at startup: prebundle Pyodide (custom build or pre-built wheels for pypulseq/nibabel). [burden is high because you need a reproducible build pipeline, wheel compatibility checks for Pyodide/Python versions, larger artifact management, and ongoing maintenance whenever Pyodide or deps update.] (benefit: ++, burden: +++)

-- self-host Pyodide/WASM/package assets (instead of relying only on CDN) for more stable startup. [host `pyodide.js`, `.wasm`, and wheels on your own static host and point `indexURL` there; GitHub Pages works for static files, or use your own server/CDN for more control.] (benefit: ++, burden: +)

# Probably at some point

-- add seq.sound() ( wait for approved PR) (benefit: +, burden: +)
-- move recon to cloud
