/**
 * Pyodide in a Web Worker for the main app.
 *
 * Protocol is the one already proven in `pypulseq/seq_check_web/seq_check_py_worker.js`
 * rather than a new invention, with four additions that the main app needs and the
 * seq_check subapp did not:
 *
 *   - `installPackages`, because `pyodide.pyimport('micropip')` returns a live PyProxy
 *     and a PyProxy cannot cross a worker boundary. The caller sends a declarative
 *     spec and the install runs entirely in here.
 *   - Structured errors. Collapsing an exception to `e.message` loses `errno` and
 *     `name`, which the app's own `formatPyodideError` switches on, so errors travel
 *     as `{name, message, errno}` and the client rebuilds them.
 *   - Per-request progress messages, so a multi-second call can report intermediate
 *     state against the request that caused it instead of a global channel.
 *   - Transferable byte payloads in both directions, so signal/image/NIfTI buffers
 *     move instead of being structured-cloned.
 *
 * Every Python source is resolved against `import.meta.url`. Page-relative URLs
 * would resolve against this worker's own location, which is not where the app's
 * `.py` files live from the worker's point of view.
 */

import { loadPyodide } from 'https://cdn.jsdelivr.net/pyodide/v0.29.0/full/pyodide.mjs';

const PYODIDE_INDEX = 'https://cdn.jsdelivr.net/pyodide/v0.29.0/full/';
const APP_BASE = new URL('./', import.meta.url);

/** @type {import('pyodide').PyodideInterface | null} */
let pyodide = null;
let activeGen = 0;

function post(msg, transfer = []) {
    self.postMessage(msg, transfer);
}

function isStale(gen) {
    return gen != null && gen !== activeGen;
}

function isPyBytesLike(result) {
    if (result == null) return false;
    if (result instanceof ArrayBuffer || ArrayBuffer.isView(result)) return true;
    const t = result.type;
    return t === 'bytes' || t === 'bytearray' || t === 'memoryview';
}

/**
 * Flatten an exception into something structured-clone can carry without losing the
 * fields callers branch on. Pyodide's `ErrnoError` in particular is only
 * distinguishable by `name`/`errno`, and a bare `String(e)` throws that away.
 */
function serializeError(e) {
    if (e == null) return { name: 'Error', message: 'Unknown worker error' };
    return {
        name: typeof e.name === 'string' ? e.name : 'Error',
        message: e.message ? String(e.message) : String(e),
        errno: typeof e.errno === 'number' ? e.errno : undefined,
        pyType: typeof e.type === 'string' ? e.type : undefined,
        stack: typeof e.stack === 'string' ? e.stack : undefined,
    };
}

/** A byte view is only safe to transfer when it owns its whole backing buffer. */
function detachable(bytes) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // A view into the WASM heap would detach the heap out from under the interpreter.
    if (buf.byteOffset !== 0 || buf.byteLength !== buf.buffer.byteLength) {
        return new Uint8Array(buf);
    }
    return buf;
}

async function fetchPyModuleText(rel) {
    const url = new URL(rel, APP_BASE);
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    return res.text();
}

/**
 * @param {number} id
 * @param {number} gen
 * @param {string} phase
 * @param {object} [detail]
 */
function reportProgress(id, gen, phase, detail = {}) {
    post({ type: 'progress', id, gen, phase, ...detail });
}

async function handleInit(id, gen, opts = {}) {
    if (pyodide) {
        reportProgress(id, gen, 'pyodide-ready');
        return;
    }
    reportProgress(id, gen, 'pyodide-loading');
    pyodide = await loadPyodide({
        indexURL: opts.indexURL || PYODIDE_INDEX,
        stdout: (line) => post({ type: 'pyout', line }),
        stderr: (line) => post({ type: 'pyerr', line }),
    });
    if (isStale(gen)) return;
    reportProgress(id, gen, 'pyodide-ready');
}

/**
 * Install packages worker-side. `spec.load` goes through `loadPackage` (Pyodide's own
 * bundled wheels); `spec.micropip` entries go through micropip, whose PyProxy never
 * leaves this thread.
 *
 * @param {{ load?: string[], micropip?: Array<{ name: string, deps?: boolean, optional?: boolean }> }} spec
 */
async function handleInstallPackages(id, gen, spec = {}) {
    if (!pyodide) throw new Error('Pyodide not initialized');
    const load = Array.isArray(spec.load) ? spec.load : [];
    const viaMicropip = Array.isArray(spec.micropip) ? spec.micropip : [];

    if (load.length) {
        reportProgress(id, gen, 'loadPackage', { packages: load });
        await pyodide.loadPackage(load, { checkIntegrity: false });
        if (isStale(gen)) return { installed: [], skipped: [] };
    }

    const installed = [];
    const skipped = [];
    for (const entry of viaMicropip) {
        const name = typeof entry === 'string' ? entry : entry?.name;
        if (!name) continue;
        const deps = typeof entry === 'object' && entry.deps === false ? false : true;
        reportProgress(id, gen, 'micropip', { package: name });
        try {
            // Kept as Python so the PyProxy is created and released inside the worker.
            await pyodide.runPythonAsync(
                `import micropip\nawait micropip.install(${JSON.stringify(name)}, deps=${deps ? 'True' : 'False'})`,
            );
            installed.push(name);
        } catch (e) {
            // `optional` exists for packages the caller has a fallback for (the
            // seq_check worker treats nibabel this way).
            if (typeof entry === 'object' && entry.optional) {
                skipped.push({ name, error: serializeError(e).message });
            } else {
                throw e;
            }
        }
        if (isStale(gen)) break;
    }
    return { installed, skipped };
}

/**
 * Fetch app `.py` sources and exec them, each into its own module namespace so they
 * don't collide in `__main__` the way the main thread's `exec(compile(...))` blocks do.
 *
 * @param {Array<{ path: string, as?: string, preamble?: string }>} modules
 */
async function handleLoadPyModules(id, gen, modules = []) {
    if (!pyodide) throw new Error('Pyodide not initialized');
    const loaded = [];
    for (const mod of modules) {
        if (!mod?.path) continue;
        reportProgress(id, gen, 'py-module', { path: mod.path });
        const text = await fetchPyModuleText(mod.path);
        if (isStale(gen)) break;
        // `vfs` overrides the write path so app sources under pypulseq/*.py do not
        // become a namespace package that shadows the installed `pypulseq` once
        // execute_function puts `/` on sys.path.
        const vfsPath = String(mod.vfs || `/${mod.path}`).replace(/\/{2,}/g, '/');
        const dir = vfsPath.slice(0, vfsPath.lastIndexOf('/'));
        if (dir && dir !== '/') {
            try {
                pyodide.FS.mkdirTree(dir);
            } catch {
                /* already there */
            }
        }
        pyodide.FS.writeFile(vfsPath, text);
        if (mod.as) {
            pyodide.globals.set('__anyfield_src', text);
            pyodide.globals.set('__anyfield_path', vfsPath);
            await pyodide.runPythonAsync(`
import types as __anyfield_types
${mod.as} = __anyfield_types.ModuleType(${JSON.stringify(mod.as)})
${mod.as}.__dict__["__file__"] = __anyfield_path
${mod.preamble || ''}
exec(compile(__anyfield_src, __anyfield_path, "exec"), ${mod.as}.__dict__)
del __anyfield_src, __anyfield_path
`);
        }
        loaded.push(vfsPath);
    }
    return { loaded };
}

/**
 * @param {Record<string, unknown> | null} globals Set immediately before the run, in
 *   this same message. A caller that needs several inputs must pass them here rather
 *   than as separate `globalsSet` calls: the client serialises *messages*, not groups
 *   of them, so two concurrent callers' `globalsSet` calls interleave on the chain and
 *   the second one's inputs win for both.
 */
async function handleRunPython(id, gen, code, globals = null) {
    if (!pyodide) throw new Error('Pyodide not initialized');
    if (globals) {
        for (const [key, value] of Object.entries(globals)) {
            pyodide.globals.set(key, value);
        }
    }
    const result = await pyodide.runPythonAsync(code);
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
        return { bytes: buf, __transfer: [buf.buffer] };
    }
    let value = null;
    if (result !== undefined && result !== null) {
        try {
            value = result.toString();
        } catch {
            value = String(result);
        } finally {
            // runPythonAsync hands back a PyProxy for non-primitives; without this
            // the object leaks for the lifetime of the worker.
            if (typeof result?.destroy === 'function') {
                try {
                    result.destroy();
                } catch {
                    /* already destroyed */
                }
            }
        }
    }
    return { value };
}

function handleGlobalsSet(id, gen, key, value) {
    if (!pyodide) throw new Error('Pyodide not initialized');
    pyodide.globals.set(key, value);
    return { value: null };
}

function handleFsWrite(id, gen, path, data) {
    if (!pyodide) throw new Error('Pyodide not initialized');
    const dir = String(path).slice(0, String(path).lastIndexOf('/'));
    if (dir && dir !== '/') {
        try {
            pyodide.FS.mkdirTree(dir);
        } catch {
            /* already there */
        }
    }
    // An ArrayBuffer arrives here when the caller transferred rather than cloned.
    const payload = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    pyodide.FS.writeFile(path, payload);
    return { value: null };
}

function handleFsRead(id, gen, path, opts = {}) {
    if (!pyodide) throw new Error('Pyodide not initialized');
    const buf = detachable(pyodide.FS.readFile(path));
    if (opts.unlink) {
        try {
            pyodide.FS.unlink(path);
        } catch {
            /* unlink is best-effort */
        }
    }
    return { bytes: buf, __transfer: [buf.buffer] };
}

function handleFsUnlink(id, gen, path) {
    if (!pyodide) throw new Error('Pyodide not initialized');
    try {
        pyodide.FS.unlink(path);
    } catch {
        /* absent is the desired end state either way */
    }
    return { value: null };
}

function handleFsReaddir(id, gen, path) {
    if (!pyodide) throw new Error('Pyodide not initialized');
    const names = pyodide.FS.readdir(path).filter((n) => n !== '.' && n !== '..');
    return { value: names };
}

function bytesFromTransfer(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data instanceof Uint8Array) return data;
    return new Uint8Array(data || []);
}

/**
 * gzip/tar a phantom archive onto `/phantom`, then return COPIES of the written
 * members (transferable). The VFS copies stay; Niivue never reads `/phantom`.
 */
async function handleExtractAndPopulatePhantom(id, gen, tarBytes) {
    if (!pyodide) throw new Error('Pyodide not initialized');
    const raw = bytesFromTransfer(tarBytes);
    const tarPath = '/tmp/__phantom.tar.gz';
    pyodide.FS.writeFile(tarPath, raw);
    reportProgress(id, gen, 'extract-phantom');
    let listingRaw;
    try {
        listingRaw = await pyodide.runPythonAsync(`
import gzip, io, json, os, shutil, tarfile
_tar_path = ${JSON.stringify(tarPath)}
with open(_tar_path, "rb") as _f:
    _raw = _f.read()
try:
    _buf = gzip.decompress(_raw)
except OSError:
    _buf = _raw
if os.path.exists("/phantom"):
    shutil.rmtree("/phantom")
os.makedirs("/phantom")
os.makedirs("/phantom/averaged", exist_ok=True)
_out = []
with tarfile.open(fileobj=io.BytesIO(_buf), mode="r:*") as tf:
    for m in tf.getmembers():
        if not m.isfile():
            continue
        name = m.name
        base = name.split("/")[-1]
        if not base or base.startswith(".") or "__MACOSX" in name:
            continue
        low = base.lower()
        if low.endswith(".json") or low.endswith(".nii") or low.endswith(".nii.gz"):
            data = tf.extractfile(m).read()
            with open("/phantom/" + base, "wb") as dest:
                dest.write(data)
            _out.append({"name": base, "json": low.endswith(".json"), "depth": name.count("/")})
json.dumps(_out)
`);
    } finally {
        try {
            pyodide.FS.unlink(tarPath);
        } catch {
            /* temp file is gone either way */
        }
    }
    const listing = JSON.parse(String(listingRaw || '[]'));
    if (typeof listingRaw?.destroy === 'function') {
        try {
            listingRaw.destroy();
        } catch {
            /* already destroyed */
        }
    }
    const jsonEntries = [];
    const niftiFiles = [];
    const transfer = [];
    for (const item of listing) {
        const buf = detachable(pyodide.FS.readFile(`/phantom/${item.name}`));
        const rec = { name: item.name, bytes: buf };
        if (item.json) jsonEntries.push({ rec, depth: item.depth });
        else niftiFiles.push(rec);
        transfer.push(buf.buffer);
    }
    jsonEntries.sort((a, b) => a.depth - b.depth);
    return {
        value: {
            jsonFiles: jsonEntries.map((e) => e.rec),
            niftiFiles,
        },
        __transfer: transfer,
    };
}

/**
 * Write `/phantom/<jsonName>` and run `execute_json.execute_phantom`. Averaged
 * maps stay on the VFS (e2e lists `/phantom/averaged`); copies come back here.
 */
async function handleExecutePhantom(id, gen, jsonName, jsonBody) {
    if (!pyodide) throw new Error('Pyodide not initialized');
    const name = String(jsonName || '');
    if (!name) throw new Error('executePhantom: jsonName is required');
    try {
        pyodide.FS.mkdirTree('/phantom');
        pyodide.FS.mkdirTree('/phantom/averaged');
    } catch {
        /* already there */
    }
    if (jsonBody != null) {
        pyodide.FS.writeFile(`/phantom/${name}`, String(jsonBody));
    }
    reportProgress(id, gen, 'execute-phantom', { jsonName: name });
    const result = await pyodide.runPythonAsync(`
import json as __anyfield_json
__anyfield_paths = execute_json.execute_phantom(
    ${JSON.stringify(name)},
    phantom_dir='/phantom',
    out_dir=None,
    averaged_dir='/phantom/averaged',
    write_executed=False,
    write_averaged=True,
    density_nan_threshold=0.01,
)
__anyfield_json.dumps(list(__anyfield_paths))
`);
    const paths = JSON.parse(String(result || '[]'));
    if (typeof result?.destroy === 'function') {
        try {
            result.destroy();
        } catch {
            /* already destroyed */
        }
    }
    const files = [];
    const transfer = [];
    for (const path of paths) {
        const p = String(path);
        const buf = detachable(pyodide.FS.readFile(p));
        files.push({ name: p.split('/').pop(), path: p, bytes: buf });
        transfer.push(buf.buffer);
    }
    return { value: { files }, __transfer: transfer };
}

function readHarvestFile(path) {
    try {
        const buf = detachable(pyodide.FS.readFile(path));
        try {
            pyodide.FS.unlink(path);
        } catch {
            /* temp file is gone either way */
        }
        return buf;
    } catch {
        return new Uint8Array(0);
    }
}

/**
 * One-message silent / ChartGPU execute + harvest. SourceManager lives as the
 * `seq_source_manager` global from loadPyModules (`as: 'seq_source_manager'`).
 *
 * @param {object} spec
 */
async function handleExecuteAndHarvest(id, gen, spec = {}) {
    if (!pyodide) throw new Error('Pyodide not initialized');
    const modulePath = String(spec.modulePath || '');
    const functionName = String(spec.functionName || '');
    if (!modulePath || !functionName) {
        throw new Error('executeAndHarvest: modulePath and functionName are required');
    }
    reportProgress(id, gen, 'execute-and-harvest', { functionName });

    const specJson = JSON.stringify({
        modulePath,
        functionName,
        argsDict: spec.argsDict && typeof spec.argsDict === 'object' ? spec.argsDict : {},
        silent: !!spec.silent,
        plotSpeed: spec.plotSpeed || 'chartgpu',
        showKspace: !!spec.showKspace,
        timeRange: encodeHarvestTimeRange(spec.timeRange),
        timeUnit: spec.timeUnit || 's',
        gradUnit: spec.gradUnit || 'kHz/m',
        theme: spec.theme || 'dark',
        sourceSeqPath: spec.sourceSeqPath || null,
    });

    const metaRaw = await pyodide.runPythonAsync(`
import json
import os
import shutil
import sys
import time as _time
import matplotlib as mpl
mpl.use('Agg')
import matplotlib.pyplot as plt
import __main__
import pypulseq as pp

_spec = json.loads(${JSON.stringify(specJson)})
_module_path = _spec['modulePath']
_function_name = _spec['functionName']
_args_dict = _spec.get('argsDict') or {}
_silent = bool(_spec.get('silent'))
_plot_speed = _spec.get('plotSpeed') or 'chartgpu'
_show_kspace = bool(_spec.get('showKspace'))
_time_unit = _spec.get('timeUnit') or 's'
_grad_unit = _spec.get('gradUnit') or 'kHz/m'
_theme = _spec.get('theme') or 'dark'
_source_seq_path = _spec.get('sourceSeqPath')

def _tbound(v, default):
    if v == 'inf':
        return float('inf')
    if v == '-inf':
        return float('-inf')
    if v is None:
        return default
    return float(v)

_tr = _spec.get('timeRange') or [0, 'inf']
_t0 = _tbound(_tr[0] if len(_tr) > 0 else 0, 0.0)
_t1 = _tbound(_tr[1] if len(_tr) > 1 else 'inf', float('inf'))
_pre_exec_mtime = _time.time() - 2.0

if _theme == 'light':
    plt.rcdefaults()
    plt.rcParams['figure.figsize'] = [8, 2.8]
    plt.rcParams['font.size'] = 8
else:
    plt.rcParams.update({
        'figure.figsize': [8, 2.8],
        'font.size': 8,
        'figure.facecolor': '#111a33',
        'axes.facecolor': '#111a33',
        'axes.edgecolor': (1.0, 1.0, 1.0, 0.12),
        'axes.labelcolor': '#e8ecff',
        'text.color': '#e8ecff',
        'xtick.color': '#a9b3da',
        'ytick.color': '#a9b3da',
        'grid.color': (1.0, 1.0, 1.0, 0.12),
        'figure.edgecolor': '#111a33',
        'savefig.facecolor': '#111a33',
        'savefig.edgecolor': '#111a33',
    })

_do_plot = (not _silent) and _plot_speed == 'chartgpu'
if _do_plot:
    setattr(__main__, '_chartgpu_last_payload', None)
    setattr(__main__, '_chartgpu_last_xy', None)
    seq_plot_utils.clear_kspace_cache()

_orig_plot, _orig_show = pp.Sequence.plot, plt.show
pp.Sequence.plot = plt.show = lambda *args, **kwargs: None
try:
    _manager = seq_source_manager.SourceManager()
    _result_s = _manager.execute_function(
        module_path=_module_path,
        function_name=_function_name,
        args_dict=_args_dict,
    )
finally:
    pp.Sequence.plot, plt.show = _orig_plot, _orig_show

try:
    _result_obj = json.loads(_result_s) if isinstance(_result_s, str) else {'result': 'SUCCESS', 'message': str(_result_s)}
except Exception:
    _result_obj = {'result': 'SUCCESS', 'message': str(_result_s)}

seq = getattr(seq_source_manager.SourceManager, '_last_sequence', None)
if seq is None:
    seq = getattr(__main__, 'seq', None)

if hasattr(sys, '_pp_patch_func'):
    sys._pp_patch_func()

if seq is not None and _do_plot:
    plt.close('all')
    seq.plot(plot_now=False, plot_speed='chartgpu', time_range=(_t0, _t1), time_disp=_time_unit, grad_disp=_grad_unit)
    if _show_kspace:
        seq_plot_utils.ensure_kspace_cache(seq, time_range=(_t0, _t1))

fov_mm = None
if seq is not None:
    defs = getattr(getattr(seq, 'definitions', None), 'keys', lambda: [])()
    fov_vals = None
    for k in defs:
        try:
            key_str = str(k)
        except Exception:
            continue
        if key_str.lower() == 'fov':
            try:
                _val = seq.get_definition(k)
            except Exception:
                _val = None
            if _val is not None:
                fov_vals = _val
                break
    if fov_vals is not None:
        try:
            vals = list(fov_vals)
        except TypeError:
            vals = [fov_vals]
        if len(vals) == 1:
            vals = [vals[0], vals[0], vals[0]]
        elif len(vals) == 2:
            vals = [vals[0], vals[1], vals[1]]
        elif len(vals) >= 3:
            vals = [vals[0], vals[1], vals[2]]
        try:
            fov_mm = [float(v) * 1000.0 for v in vals]
        except Exception:
            fov_mm = None

matrix = None
if seq is not None:
    try:
        _m = seq.get_definition('matrix')
        if _m is not None:
            _mv = list(_m)
            matrix = [int(_mv[0]), int(_mv[1]), int(_mv[2]) if len(_mv) > 2 else 1]
    except Exception:
        matrix = None

_seq_path = '/tmp/__eah_seq.seq'
os.makedirs('/tmp', exist_ok=True)
_seq_ok = False
if _source_seq_path is not None and os.path.exists(_source_seq_path):
    shutil.copy2(_source_seq_path, _seq_path)
    _seq_ok = True
else:
    _wrote_path = None
    for _dir in ('/home/pyodide/output', '/home/pyodide'):
        if not os.path.isdir(_dir):
            continue
        try:
            _candidates = [
                (_mt, os.path.join(_dir, _f))
                for _f in os.listdir(_dir)
                if _f.endswith('.seq')
                for _mt in [os.path.getmtime(os.path.join(_dir, _f))]
                if _mt >= _pre_exec_mtime
            ]
        except Exception:
            _candidates = []
        if _candidates:
            _candidates.sort(reverse=True)
            _wrote_path = _candidates[0][1]
            break
    if _wrote_path:
        shutil.copy2(_wrote_path, _seq_path)
        _seq_ok = True
    elif seq is not None:
        seq.write(_seq_path)
        _seq_ok = True

_chartgpu_obj = None
if _do_plot:
    _cg = seq_plot_utils.get_chartgpu_payload_json()
    if _cg not in (None, 'null'):
        try:
            _chartgpu_obj = json.loads(_cg)
        except Exception:
            _chartgpu_obj = None
    _xy = seq_plot_utils.get_chartgpu_payload_xy()
    with open('/tmp/__eah_xy.bin', 'wb') as _f:
        _f.write(_xy or b'')
else:
    with open('/tmp/__eah_xy.bin', 'wb') as _f:
        _f.write(b'')

_kspace_obj = None
if _show_kspace and _do_plot:
    try:
        _kspace_obj = json.loads(seq_plot_utils.export_kspace_cache_json())
    except Exception:
        _kspace_obj = None

json.dumps({
    'result': _result_obj,
    'fovMm': fov_mm,
    'matrix': matrix,
    'chartgpuJson': _chartgpu_obj,
    'kspaceJson': _kspace_obj,
    'seqOk': _seq_ok,
})
`);

    let meta = {};
    try {
        meta = JSON.parse(String(metaRaw || '{}'));
    } finally {
        if (typeof metaRaw?.destroy === 'function') {
            try {
                metaRaw.destroy();
            } catch {
                /* already destroyed */
            }
        }
    }

    const seqBytes = readHarvestFile('/tmp/__eah_seq.seq');
    const chartgpuXy = readHarvestFile('/tmp/__eah_xy.bin');
    const transfer = [];
    if (seqBytes.byteLength) transfer.push(seqBytes.buffer);
    if (chartgpuXy.byteLength) transfer.push(chartgpuXy.buffer);

    return {
        value: {
            result: meta.result ?? null,
            seqBytes,
            fovMm: meta.fovMm ?? null,
            matrix: meta.matrix ?? null,
            chartgpuJson: meta.chartgpuJson ?? null,
            chartgpuXy,
            kspaceJson: meta.kspaceJson ?? null,
        },
        __transfer: transfer,
    };
}

function encodeHarvestTimeRange(tr) {
    const encode = (t, fallback) => {
        if (t === Infinity) return 'inf';
        if (t === -Infinity) return '-inf';
        if (typeof t === 'number' && Number.isFinite(t)) return t;
        return fallback;
    };
    if (!Array.isArray(tr) || tr.length < 2) return [0, 'inf'];
    return [encode(tr[0], 0), encode(tr[1], 'inf')];
}

const HANDLERS = {
    init: (msg) => handleInit(msg.id, msg.gen, msg.opts),
    installPackages: (msg) => handleInstallPackages(msg.id, msg.gen, msg.spec),
    loadPyModules: (msg) => handleLoadPyModules(msg.id, msg.gen, msg.modules),
    runPython: (msg) => handleRunPython(msg.id, msg.gen, msg.code, msg.globals),
    globalsSet: (msg) => handleGlobalsSet(msg.id, msg.gen, msg.key, msg.value),
    fsWrite: (msg) => handleFsWrite(msg.id, msg.gen, msg.path, msg.data),
    fsRead: (msg) => handleFsRead(msg.id, msg.gen, msg.path, msg.opts),
    fsUnlink: (msg) => handleFsUnlink(msg.id, msg.gen, msg.path),
    fsReaddir: (msg) => handleFsReaddir(msg.id, msg.gen, msg.path),
    extractAndPopulatePhantom: (msg) => handleExtractAndPopulatePhantom(msg.id, msg.gen, msg.tarBytes),
    executePhantom: (msg) => handleExecutePhantom(msg.id, msg.gen, msg.jsonName, msg.jsonBody),
    executeAndHarvest: (msg) => handleExecuteAndHarvest(msg.id, msg.gen, msg.spec || msg),
};

self.onmessage = async (ev) => {
    const msg = ev.data || {};
    const { id, type, gen } = msg;

    try {
        if (type === 'setGen') {
            activeGen = msg.gen ?? 0;
            post({ type: 'result', id, gen: activeGen, ok: true });
            return;
        }

        const handler = HANDLERS[type];
        if (!handler) {
            post({
                type: 'result',
                id,
                gen,
                ok: false,
                error: { name: 'TypeError', message: `Unknown RPC type: ${type}` },
            });
            return;
        }

        if (isStale(gen)) {
            post({ type: 'result', id, gen, stale: true });
            return;
        }

        const out = (await handler(msg)) || {};
        if (isStale(gen)) {
            post({ type: 'result', id, gen, stale: true });
            return;
        }
        const transfer = out.__transfer || [];
        delete out.__transfer;
        post({ type: 'result', id, gen, ok: true, ...out }, transfer);
    } catch (e) {
        // Always send a terminal reply, even once the generation has moved on: the
        // client chains each request off the previous one, so a request that never
        // settles wedges the queue for the rest of the session.
        post({
            type: 'result',
            id,
            gen,
            ok: false,
            stale: isStale(gen),
            error: serializeError(e),
        });
    }
};
