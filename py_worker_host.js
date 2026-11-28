/**
 * The app's one Pyodide worker, and the promise that says it is usable.
 *
 * There is deliberately a single worker for all of the off-main-thread Python work
 * rather than one per feature: Pyodide costs several seconds and tens of megabytes to
 * start, and the packages overlap almost completely. Callers that need it await
 * `ready()`; the warm-up is started once and every caller gets the same promise.
 *
 * The warm-up runs at startup as fire-and-forget work (`startWarmUp`), because the
 * cost it exists to hide is the *first* scan's package install -- micropip fetching
 * pynufft, scipy and nibabel, plus pypulseq for silent / ChartGPU execute. Boot must
 * not wait for it, and a scan that arrives before it finishes must join the same
 * promise instead of starting a second install; both fall out of there being one
 * promise and `ready()` being what the recon / execute path awaits.
 *
 * A failed warm-up clears the promise so the next `ready()` retries rather than
 * serving a permanently rejected one. The worker itself is left in place: a partial
 * package install is idempotent to repeat, whereas respawning would also discard the
 * Pyodide runtime that did succeed.
 */

import { AnyfieldPyClient } from './anyfield_py_client.js';

/**
 * What the worker is warmed with.
 *
 * `load` goes through Pyodide's own bundled wheels; `micropip` entries are fetched
 * from PyPI. numpy and nibabel are what `scan_zero/recon.py` imports at module level,
 * and pynufft is what `scan_zero/recon_kernels.py` imports (pulling scipy as a
 * dependency, which is why this is the slow part).
 *
 * Note this is narrower than the main thread's `_ensureNibabelReady()`, which also
 * loads `data/resampling.py`. Resample still runs on the main thread. Execute and
 * `/phantom` live here, so warm-up loads `data/execute_json.py` as `execute_json`.
 */
const WARM_UP_SPEC = {
    packages: {
        // matplotlib is required before seq_plot_utils exec (it imports pyplot).
        // Worker has no document; Agg is set in the seq_plot_utils preamble.
        load: ['numpy', 'micropip', 'matplotlib'],
        micropip: [
            { name: 'nibabel' },
            { name: 'pynufft' },
            { name: 'pypulseq==1.5.0.post1', deps: false },
        ],
    },
    modules: [
        // Written to the VFS only. recon.py imports it by flat name, so it just has to
        // exist on sys.path -- see the import fallback at the top of recon.py.
        { path: 'scan_zero/recon_kernels.py' },
        {
            path: 'scan_zero/recon.py',
            as: '_recon',
            preamble: 'import sys\nif "/scan_zero" not in sys.path:\n    sys.path.insert(0, "/scan_zero")',
        },
        { path: 'data/execute_json.py', as: 'execute_json' },
        {
            path: 'pypulseq/seq_source_manager.py',
            as: 'seq_source_manager',
            vfs: '/seq_source_manager.py',
            preamble: 'import sys\nsys.modules["seq_source_manager"] = seq_source_manager',
        },
        {
            path: 'pypulseq/seq_plot_utils.py',
            as: 'seq_plot_utils',
            vfs: '/seq_plot_utils.py',
            preamble: 'import sys\nsys.modules["seq_plot_utils"] = seq_plot_utils\nimport matplotlib as mpl\nmpl.use("Agg")',
        },
    ],
};

/**
 * Replaces the "is the fetched copy stale?" string sniffing that the main thread's
 * `_ensureSimReconPy` did on every recon. Asking the loaded function for its own
 * signature is a stronger check than looking for a substring in the source, and it
 * runs once per worker instead of once per scan.
 *
 * `run_sim_recon_from_npz` is checked here too, so a stale copy fails loudly at warm-up
 * rather than as an AttributeError in the middle of the first HTTP scan.
 */
const ASSERT_RECON_LOADED = `
import inspect
if not hasattr(_recon, "run_sim_recon"):
    raise RuntimeError("scan_zero/recon.py loaded but defines no run_sim_recon")
if "output_mode" not in inspect.signature(_recon.run_sim_recon).parameters:
    raise RuntimeError("scan_zero/recon.py is stale (run_sim_recon has no output_mode)")
if not hasattr(_recon, "run_sim_recon_from_npz"):
    raise RuntimeError("scan_zero/recon.py is stale (no run_sim_recon_from_npz)")
if not hasattr(execute_json, "execute_phantom"):
    raise RuntimeError("data/execute_json.py loaded but defines no execute_phantom")
if not hasattr(seq_source_manager, "SourceManager"):
    raise RuntimeError("seq_source_manager loaded but defines no SourceManager")
if not hasattr(seq_plot_utils, "patch_pypulseq"):
    raise RuntimeError("seq_plot_utils loaded but defines no patch_pypulseq")
seq_plot_utils.patch_pypulseq()
from seq_plot_utils import (
    get_chartgpu_payload_json,
    get_chartgpu_payload_xy,
    ensure_kspace_cache,
    export_kspace_cache_json,
    clear_kspace_cache,
    clear_chartgpu_payload,
)
"ok"
`;

export class PyWorkerHost {
    constructor() {
        /** @type {AnyfieldPyClient | null} */
        this._client = null;
        /** @type {Promise<AnyfieldPyClient> | null} */
        this._init = null;
        /** @type {Promise<AnyfieldPyClient> | null} */
        this._ready = null;
        /** @type {() => void} */
        this._markWarmUpRequested = () => {};
        this._warmUpRequested = new Promise((resolve) => {
            this._markWarmUpRequested = resolve;
        });
    }

    /**
     * Resolves once something has asked for the warm-up: `startWarmUp` after boot, or an
     * earlier plot / scan via `ready()`. Work that only *adds* to the warm worker (extra
     * source packages) waits on this, so queuing it during boot does not start the warm-up
     * there and compete with the boot it is meant to stay out of.
     * @returns {Promise<void>}
     */
    afterWarmUpRequested() {
        return this._warmUpRequested;
    }

    /**
     * Pyodide is loaded (stdlib gzip/tar). Boot extract awaits this so it does
     * not sit behind micropip / pynufft.
     * @returns {Promise<AnyfieldPyClient>}
     */
    whenInit() {
        if (!this._init) {
            this._init = this._initRuntime().catch((e) => {
                this._init = null;
                throw e;
            });
        }
        return this._init;
    }

    /**
     * The shared warm-up promise, started on first call. Packages + recon +
     * execute_json + pypulseq / seq_source_manager / seq_plot_utils. Execute awaits this.
     * @returns {Promise<AnyfieldPyClient>}
     */
    ready() {
        this._markWarmUpRequested();
        if (!this._ready) {
            this._ready = this._warmUp().catch((e) => {
                this._ready = null;
                throw e;
            });
        }
        return this._ready;
    }

    /**
     * Begin the warm-up without waiting for it, for bootstrap. Reports a failure here
     * rather than leaving an unhandled rejection; the retry lives in `ready()`, so a
     * warm-up that fails at boot costs the first scan its install time and nothing
     * else.
     */
    startWarmUp() {
        void this.ready().catch((e) => {
            console.warn('[py worker] warm-up failed; a later scan will retry:', e);
        });
    }

    /** True once the worker is warm, for status display. Never throws. */
    isReady() {
        return !!this._client?.ready;
    }

    async _initRuntime() {
        if (!this._client) this._client = AnyfieldPyClient.create();
        const client = this._client;
        await client.initRuntime({
            onProgress: (msg) => {
                if (msg?.phase) console.log(`[py worker] ${msg.phase}`, msg.package || msg.path || '');
            },
        });
        return client;
    }

    async _warmUp() {
        const t0 = performance.now();
        const client = await this.whenInit();
        await client.init({
            ...WARM_UP_SPEC,
            onProgress: (msg) => {
                if (msg?.phase) console.log(`[py worker] ${msg.phase}`, msg.package || msg.path || '');
            },
        });
        await client.runPython(ASSERT_RECON_LOADED);
        console.log(`[py worker] warm: ${(performance.now() - t0).toFixed(0)}ms`);
        return client;
    }

    /** Drop the worker entirely. Only for teardown; `ready()` would build a new one. */
    terminate() {
        this._client?.terminate();
        this._client = null;
        this._init = null;
        this._ready = null;
    }
}
