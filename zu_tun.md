## Todo

# Definitly at some point

-- add full report

-- add "share" link to protocol/ui

-- add phantom and fov and maybe prot setting to url

-- save and load fov + phantom from/to seq file
   mini-plan:
   1) write metadata into `seq.definitions` on scan prep with `anyfield_` prefix (e.g. `anyfield_fov_affine_ras_4x4`, `anyfield_phantom_json_name`, optional `anyfield_phantom_hash`).
   2) keep affine as one-line numeric list (row-major 4x4) for robust cross-tool parsing.
   3) on load/view-seq, parse definitions and restore Niivue FOV box + select/match phantom group.
   4) if phantom is missing locally, show warning + keep geometry restore (graceful fallback).



-- speedup at startup: prebundle Pyodide (custom build or pre-built wheels for pypulseq/nibabel). [burden is high because you need a reproducible build pipeline, wheel compatibility checks for Pyodide/Python versions, larger artifact management, and ongoing maintenance whenever Pyodide or deps update.] (benefit: ++, burden: +++)
-- add a Service Worker for caching Pyodide/WASM/assets on repeat visits. [watchouts: stale cache + dev confusion; use versioned cache names, network-first for HTML, cache-first for immutable wasm/wheels, and an easy dev bypass.] (benefit: +++, burden: ++)
-- self-host Pyodide/WASM/package assets (instead of relying only on CDN) for more stable startup. [host `pyodide.js`, `.wasm`, and wheels on your own static host and point `indexURL` there; GitHub Pages works for static files, or use your own server/CDN for more control.] (benefit: ++, burden: +)



# Probably at some point

-- add seq.sound() ( wait for approved PR) (benefit: +, burden: +)
-- move Pyodide work to a Web Worker so long simulations do not block the UI. (benefit: +++, burden: +++)
-- add tool backend pre-warm/retry handling to reduce Fly websocket cold-start failures. (benefit: ++, burden: +)
-- reduce heavy tool payload/response transfer where possible (e.g., conseq/traj data paths). (benefit: ++, burden: ++)

