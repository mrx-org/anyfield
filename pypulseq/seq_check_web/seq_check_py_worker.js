/**
 * Pyodide in a Web Worker for seq_check_web (all Python: pypulseq, NUFFT, PSF, ChartGPU export).
 */

import { loadPyodide } from 'https://cdn.jsdelivr.net/pyodide/v0.29.0/full/pyodide.mjs';

const PYODIDE_INDEX = 'https://cdn.jsdelivr.net/pyodide/v0.29.0/full/';
const PYPULSEQ_BASE = new URL('../', import.meta.url);

/** @type {import('pyodide').PyodideInterface | null} */
let pyodide = null;
/** @type {number} */
let activeGen = 0;

async function fetchPyModuleText(rel) {
    const url = new URL(rel, PYPULSEQ_BASE);
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    return res.text();
}

function post(msg, transfer = []) {
    self.postMessage(msg, transfer);
}

/** A byte view is only safe to transfer when it owns its whole backing buffer. */
function detachable(bytes) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // A view into the WASM heap would detach the heap out from under the interpreter.
    const heap = pyodide && pyodide._module && pyodide._module.HEAPU8;
    if (heap && buf.buffer === heap.buffer) {
        return new Uint8Array(buf);
    }
    if (buf.byteOffset !== 0 || buf.byteLength !== buf.buffer.byteLength) {
        return new Uint8Array(buf);
    }
    return buf;
}

function isPyBytesLike(result) {
    if (result == null) return false;
    if (result instanceof ArrayBuffer || ArrayBuffer.isView(result)) return true;
    const t = result.type;
    return t === 'bytes' || t === 'bytearray' || t === 'memoryview';
}

function isStale(gen) {
    return gen != null && gen !== activeGen;
}

async function handleInit(gen) {
    post({ type: 'log', gen, msg: 'Loading Pyodide...' });
    pyodide = await loadPyodide({
        indexURL: PYODIDE_INDEX,
        stdout: (t) => post({ type: 'pyout', line: t }),
        stderr: (t) => post({ type: 'pyerr', line: t }),
    });

    if (isStale(gen)) return;

    post({ type: 'log', gen, msg: 'Installing packages...' });
    await pyodide.loadPackage(['numpy', 'matplotlib', 'micropip'], { checkIntegrity: false });
    const micropip = pyodide.pyimport('micropip');
    await Promise.all([
        micropip.install(['pypulseq==1.5.0.post1']),
        micropip.install('pynufft'),
    ]);
    try {
        await micropip.install('nibabel');
    } catch {
        /* Niivue can use magB64/phaseB64 */
    }

    if (isStale(gen)) return;

    const [plotUtilsCode, reconCode, psfCode, reconKernelsCode] = await Promise.all([
        fetchPyModuleText('seq_plot_utils.py'),
        fetchPyModuleText('seq_check_web/seq_check_py_recon.py'),
        fetchPyModuleText('seq_check_web/seq_check_py_psf.py'),
        // Shared with the main app's SIM pipeline; seq_check_py_recon.py imports it
        // rather than carrying its own copy of the DCF and adjoint NUFFT.
        fetchPyModuleText('../scan_zero/recon_kernels.py'),
    ]);

    if (isStale(gen)) return;

    pyodide.FS.mkdirTree('/scan_zero');
    pyodide.FS.writeFile('/scan_zero/recon_kernels.py', reconKernelsCode);
    await pyodide.runPythonAsync(`
import sys
if "/scan_zero" not in sys.path:
    sys.path.insert(0, "/scan_zero")
`);

    await pyodide.runPythonAsync(`
import matplotlib as mpl
# Worker has no DOM; WebAgg fails at import (from js import document).
# ChartGPU export never rasterises a figure; the no-WebGPU path returns an Agg PNG.
mpl.use('Agg')
import matplotlib.pyplot as plt
mpl.rcParams.update({
    'figure.facecolor': '#0f1424',
    'axes.facecolor': '#0f1424',
    'axes.edgecolor': (1.0, 1.0, 1.0, 0.12),
    'axes.labelcolor': '#e8ecff',
    'text.color': '#e8ecff',
    'xtick.color': '#a9b3da',
    'ytick.color': '#a9b3da',
    'grid.color': (1.0, 1.0, 1.0, 0.12),
})
plt.ion()
`);

    await pyodide.runPythonAsync(
        plotUtilsCode.replace("adc_red = '#ff0000'", "adc_red = '#ff69b4'"),
    );
    await pyodide.runPythonAsync('patch_pypulseq()');
    await pyodide.runPythonAsync(`import numpy as np\n${reconCode}\n${psfCode}`);
}

async function handleRunPython(id, gen, code) {
    if (!pyodide) throw new Error('Pyodide not initialized');
    if (isStale(gen)) {
        post({ type: 'result', id, gen, stale: true });
        return;
    }
    const result = await pyodide.runPythonAsync(code);
    if (isStale(gen)) {
        post({ type: 'result', id, gen, stale: true });
        return;
    }
    if (isPyBytesLike(result)) {
        let jsBytes = result;
        if (typeof result.toJs === 'function') {
            try {
                jsBytes = result.toJs();
            } finally {
                if (typeof result.destroy === 'function') {
                    try {
                        result.destroy();
                    } catch {
                        /* already destroyed */
                    }
                }
            }
        }
        const buf = detachable(jsBytes || new Uint8Array(0));
        post({ type: 'result', id, gen, ok: true, bytes: buf }, [buf.buffer]);
        return;
    }
    let value = null;
    if (result !== undefined && result !== null) {
        try {
            value = result.toString();
        } catch {
            value = String(result);
        }
    }
    post({ type: 'result', id, gen, ok: true, value });
}

async function handleGlobalsSet(id, gen, key, value) {
    if (!pyodide) throw new Error('Pyodide not initialized');
    if (isStale(gen)) {
        post({ type: 'result', id, gen, stale: true });
        return;
    }
    pyodide.globals.set(key, value);
    post({ type: 'result', id, gen, ok: true, value: null });
}

async function handleFsWrite(id, gen, path, data) {
    if (!pyodide) throw new Error('Pyodide not initialized');
    if (isStale(gen)) {
        post({ type: 'result', id, gen, stale: true });
        return;
    }
    pyodide.FS.writeFile(path, data);
    post({ type: 'result', id, gen, ok: true, value: null });
}

async function handleFsRead(id, gen, path) {
    if (!pyodide) throw new Error('Pyodide not initialized');
    if (isStale(gen)) {
        post({ type: 'result', id, gen, stale: true });
        return;
    }
    const bytes = pyodide.FS.readFile(path);
    let buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // Only ever transfer a buffer this view owns outright. FS.readFile hands back
    // a fresh allocation today, but transferring a view *into* the WASM heap
    // would detach the heap out from under the interpreter.
    if (buf.byteOffset !== 0 || buf.byteLength !== buf.buffer.byteLength) {
        buf = new Uint8Array(buf);
    }
    post({ type: 'result', id, gen, ok: true, bytes: buf }, [buf.buffer]);
}

self.onmessage = async (ev) => {
    const msg = ev.data || {};
    const { id, type, gen } = msg;

    try {
        if (type === 'setGen') {
            activeGen = msg.gen ?? 0;
            post({ type: 'result', id, gen: activeGen, ok: true });
            return;
        }

        if (type === 'init') {
            await handleInit(gen);
            if (isStale(gen)) {
                post({ type: 'result', id, gen, stale: true });
                return;
            }
            post({ type: 'result', id, gen, ok: true, ready: true });
            return;
        }

        if (type === 'runPython') {
            await handleRunPython(id, gen, msg.code);
            return;
        }

        if (type === 'globalsSet') {
            await handleGlobalsSet(id, gen, msg.key, msg.value);
            return;
        }

        if (type === 'fsWrite') {
            await handleFsWrite(id, gen, msg.path, msg.data);
            return;
        }

        if (type === 'fsRead') {
            await handleFsRead(id, gen, msg.path);
            return;
        }

        post({ type: 'result', id, gen, ok: false, error: `Unknown RPC type: ${type}` });
    } catch (e) {
        // Always send a terminal reply, even once the generation has moved on.
        // The client queues each request off the previous one, so a request that
        // never settles wedges the queue for the rest of the session.
        post({
            type: 'result',
            id,
            gen,
            ok: false,
            stale: isStale(gen),
            error: e?.message || String(e),
        });
    }
};
