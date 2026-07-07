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
        micropip.install(['pypulseq==1.4.2.post2']),
        micropip.install('pynufft'),
    ]);
    try {
        await micropip.install('nibabel');
    } catch {
        /* Niivue can use magB64/phaseB64 */
    }

    if (isStale(gen)) return;

    const [plotUtilsCode, reconCode, psfCode] = await Promise.all([
        fetchPyModuleText('seq_plot_utils.py'),
        fetchPyModuleText('seq_check_web/seq_check_py_recon.py'),
        fetchPyModuleText('seq_check_web/seq_check_py_psf.py'),
    ]);

    if (isStale(gen)) return;

    await pyodide.runPythonAsync(`
import matplotlib as mpl
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
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
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
        if (!isStale(gen)) {
            post({
                type: 'result',
                id,
                gen,
                ok: false,
                error: e?.message || String(e),
            });
        }
    }
};
