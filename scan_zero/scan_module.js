import { eventHub } from '../event_hub.js';

/** toolapi-wasm WebSocket URLs (same path `/tool`, different host). */
export const TOOL_CONSEQ = 'wss://tool-conseq.fly.dev/tool';
export const TOOL_TRAJEX = 'wss://tool-trajex.fly.dev/tool';
export const TOOL_RAPISIM = 'wss://tool-rapisim.fly.dev/tool';
export const TOOL_MR0SIM = 'wss://tool-mr0sim.fly.dev/tool';

/**
 * ScanModule - Handles the scanning simulation queue
 * Borrows resampling logic from NiivueModule for a "Fake Scan"
 */
export class ScanModule {
    constructor() {
        this.container = null;
        this.queue = [];
        this.currentSequence = null;
        this.currentFov = null;
        this.scanCounter = 0;
        this._toolApiCall = null;
        /** Set during runSimPipeline for _toolOnMessage tagging */
        this._simPipelineJob = null;

        this.setupEventListeners();
    }

    setupEventListeners() {
        // Listen for sequence selection from SeqExplorer
        eventHub.on('sequenceSelected', (data) => {
            this.currentSequence = data;
            console.log("ScanModule: Received Sequence", data.name);
            this.updateHeader();
        });
        
        // Listen for FOV changes from NiivueModule
        eventHub.on('fov_changed', (data) => {
            this.currentFov = data;
        });
    }

    render(containerId) {
        this.container = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
        if (!this.container) return;

        this.container.innerHTML = `
            <div class="scan-module">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
                    <h3 class="section-title" style="margin: 0;">RUN</h3>
                </div>
                <div class="scan-header" style="display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem;">
                    <button id="btn-start-cut" class="scan-btn" title="Resample first volume to FOV (fake scan)">
                        CUT
                    </button>
                    <button id="btn-start-sim-mr0" class="scan-btn" title="MR0 (tool-mr0sim)">
                        SCAN<span class="icon">▶</span> 
                    </button>
                    <button id="btn-start-sim-fast" class="scan-btn" title="Rapisim (tool-rapisim)">
                         SCAN<span class="icon">▶▶</span>
                    </button>
                    <div class="active-info">
                        Ready: <span id="ready-seq-name">${this.currentSequence ? (this.currentSequence.displayName || this.currentSequence.name) : 'None'}</span>
                    </div>
                </div>
                <div class="scan-queue" id="scan-queue-list">
                    <div class="queue-empty">Queue is empty</div>
                </div>
            </div>
        `;

        this.container.querySelector('#btn-start-cut').onclick = () => this.startScan();
        this.container.querySelector('#btn-start-sim-mr0').onclick = () => this.startSimMr0();
        this.container.querySelector('#btn-start-sim-fast').onclick = () => this.startSimFast();
        
        // Make this instance available globally for UI callbacks if needed
        window.scanModule = this;
    }

    updateHeader() {
        if (!this.container) return;
        const el = this.container.querySelector('#ready-seq-name');
        if (el) el.textContent = this.currentSequence ? (this.currentSequence.displayName || this.currentSequence.name) : 'None';
    }

    async startScan() {
        // CUT = resample current viewer volume to FOV mask only (no seq execution / no .seq artifact)
        const nvMod = window.nvModule;
        if (!nvMod || !nvMod.nv?.volumes?.length) {
            alert("No volume loaded in Niivue.");
            return;
        }

        this.scanCounter++;
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const baseName = `scan_${this.scanCounter}_cut`;

        const job = {
            id: 'job_' + now.getTime(),
            scanNumber: this.scanCounter,
            baseName: baseName,
            name: "cut",
            protocol: "CUT (FOV)",
            cutOnly: true,
            status: 'pending',
            timestamp: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
            niftiUrl: null,
            seqUrl: null,
            error: null
        };

        this.queue.unshift(job); // Add to top of queue
        this.updateQueueUI();
        
        await this.runFakeScan(job);
    }

    _enqueueSimJob({ baseSuffix, queueName, protocol, simToolUrl, simLogLabel, noSignalName }) {
        this.scanCounter++;
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const seqSafeName = ((this.currentSequence.displayName || this.currentSequence.name) || "Sim").replace(/\s+/g, '_');
        const baseName = `scan_${this.scanCounter}_${seqSafeName}_${baseSuffix}`;
        const job = {
            id: 'job_' + now.getTime(),
            scanNumber: this.scanCounter,
            baseName,
            name: `${(this.currentSequence.displayName || this.currentSequence.name) || "Untitled"} (${queueName})`,
            protocol,
            simToolUrl,
            simLogLabel,
            noSignalName,
            status: 'pending',
            timestamp: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
            niftiUrl: null,
            seqUrl: null,
            error: null,
        };
        this.queue.unshift(job);
        this.updateQueueUI();
        return job;
    }

    async startSimFast() {
        if (!this.currentSequence) {
            alert("Please select a sequence in the Explorer first.");
            return;
        }
        const nvMod = window.nvModule;
        if (!nvMod || !nvMod.nv?.volumes?.length) {
            alert("No volume loaded in Niivue.");
            return;
        }
        if (!nvMod.pyodide) {
            alert("Python (Pyodide) is not ready.");
            return;
        }
        const job = this._enqueueSimJob({
            baseSuffix: 'simfast',
            queueName: 'SCAN▶▶ ',
            protocol: 'SIM▶▶ (rapisim)',
            simToolUrl: TOOL_RAPISIM,
            simLogLabel: 'SCAN ▶▶ ',
            noSignalName: 'Rapisim',
        });
        await this.runSimPipeline(job);
    }

    async startSimMr0() {
        if (!this.currentSequence) {
            alert("Please select a sequence in the Explorer first.");
            return;
        }
        const nvMod = window.nvModule;
        if (!nvMod || !nvMod.nv?.volumes?.length) {
            alert("No volume loaded in Niivue.");
            return;
        }
        if (!nvMod.pyodide) {
            alert("Python (Pyodide) is not ready.");
            return;
        }
        const job = this._enqueueSimJob({
            baseSuffix: 'sim_mr0',
            queueName: 'SIM▶',
            protocol: 'SIM▶ (MR0)',
            simToolUrl: TOOL_MR0SIM,
            simLogLabel: 'SIM▶',
            noSignalName: 'MR0 sim',
        });
        await this.runSimPipeline(job);
    }

    async runFakeScan(job) {
        // Borrow logic from window.nvModule (NiivueModule instance)
        const nvMod = window.nvModule;
        
        if (!nvMod) {
            job.status = 'error';
            job.error = "Niivue module not found";
            this.updateQueueUI();
            return;
        }

        if (nvMod.nv.volumes.length === 0) {
            job.status = 'error';
            job.error = "No FOV volume defined in viewer";
            this.updateQueueUI();
            return;
        }

        if (!nvMod.pyodide) {
            job.status = 'error';
            job.error = "Python (Pyodide) not ready";
            this.updateQueueUI();
            return;
        }

        job.status = 'scanning';
        this.updateQueueUI();

        try {
            // Fake delay to simulate acquisition time
            await new Promise(r => setTimeout(r, 2000));

            // Borrowing logic from niivue_app.js handleResampleToFov()
            // 1. Get current volume as NIfTI bytes
            const srcBytes = nvMod.getVolumeNifti(nvMod.nv.volumes[0]);
            
            // 2. Generate target FOV mask as NIfTI bytes
            const refBytes = nvMod.generateFovMaskNifti();

            // 3. Set bytes in Pyodide globals
            nvMod.pyodide.globals.set("source_bytes", srcBytes);
            nvMod.pyodide.globals.set("reference_bytes", refBytes);

            await nvMod.initPyodide();
            // 4) run_resampling* returns a VFS path string, not raw bytes — read file (same as SIM / Resample to FOV)
            const v0 = nvMod.nv.volumes[0];
            const hdr = v0.hdr ?? v0.header;
            const dims = hdr?.dims ?? hdr?.dim ?? v0.dims ?? [];
            const useSerial3DTo4D = (nvMod.options.resampleSerial3D !== false && (dims[0] || 3) >= 4 && Number(dims[4] || 1) > 1);
            let res = await nvMod.pyodide.runPythonAsync(
                useSerial3DTo4D
                    ? `run_resampling_serial3d_to_4d(source_bytes, reference_bytes)`
                    : `run_resampling(source_bytes, reference_bytes)`
            );
            const outPathRaw = (res && res.toJs) ? res.toJs() : res;
            const outPath = String(outPathRaw);
            if (outPathRaw?.destroy) outPathRaw.destroy();
            if (res?.destroy) res.destroy();
            const niftiBytes = nvMod.pyodide.FS.readFile(outPath);
            try { nvMod.pyodide.FS.unlink(outPath); } catch (_) {}

            job.niftiUrl = URL.createObjectURL(new Blob([niftiBytes], {type: "application/octet-stream"}));

            job.status = 'done';
            this.loadJob(job.id);
            
        } catch (e) {
            console.error("Scan simulation failed:", e);
            job.status = 'error';
            job.error = e.message;
        }

        this.updateQueueUI();
    }

    async _ensureToolApi() {
        if (this._toolApiCall) return this._toolApiCall;
        const { default: init, call } = await import('https://unpkg.com/toolapi-wasm@0.4.5/toolapi_wasm.js');
        await init();
        this._toolApiCall = call;
        return call;
    }

    _toolOnMessage(msg) {
        const tag = this._simPipelineJob?.simLogLabel || 'SIM';
        console.log(`${tag} tool:`, msg);
        return true;
    }

    _trajectoryFromResult(result) {
        if (!result) return null;
        if (result.Ok !== undefined) result = result.Ok;
        if (result.Error) return null;
        if (result.Trajectory) result = result.Trajectory;
        const out = [];
        const toArr = (x) => Array.isArray(x) ? x : (x && x.length !== undefined) ? Array.from(x) : [];
        const tl = result.TypedList;
        if (tl?.Vec4 && (Array.isArray(tl.Vec4) || typeof tl.Vec4.length === 'number')) {
            const arr = Array.isArray(tl.Vec4) ? tl.Vec4 : Array.from(tl.Vec4);
            for (const v of arr) {
                out.push([Number(v.k_x ?? v[0] ?? v.x ?? 0), Number(v.k_y ?? v[1] ?? v.y ?? 0), Number(v.k_z ?? v[2] ?? v.z ?? 0)]);
            }
            return out.length ? out : null;
        }
        if (tl) {
            const kx = toArr(tl.k_x ?? tl.kx ?? tl[0]);
            const ky = toArr(tl.k_y ?? tl.ky ?? tl[1]);
            const kz = toArr(tl.k_z ?? tl.kz ?? tl[2]);
            if (kx.length || ky.length) {
                const n = Math.max(kx.length, ky.length, kz.length);
                for (let i = 0; i < n; i++) out.push([Number(kx[i] || 0), Number(ky[i] || 0), Number(kz[i] || 0)]);
                return out.length ? out : null;
            }
        }
        return null;
    }

    _signalFromResult(result) {
        if (!result) return null;
        if (result.Ok !== undefined) result = result.Ok;
        if (result.Error) return null;
        const toArr = (x) => Array.isArray(x) ? x : (x != null && typeof x.length === 'number' ? Array.from(x) : []);
        const tl = result.TypedList;
        if (tl) {
            const c = tl.Complex;
            if (c) {
                let real = c.real ?? c.Real;
                let imag = c.imag ?? c.Imag;
                if (c.Float && (Array.isArray(c.Float) || typeof c.Float.length === 'number')) {
                    const fa = toArr(c.Float);
                    if (fa.length >= 2) {
                        real = real ?? fa[0];
                        imag = imag ?? fa[1];
                    }
                }
                const r = toArr(real), im = toArr(imag);
                const n = Math.max(r.length, im.length);
                if (n > 0) {
                    const out = new Array(n);
                    for (let i = 0; i < n; i++) out[i] = [Number(r[i] || 0), Number(im[i] || 0)];
                    return out;
                }
                // Array-like complex values: [{Real,Imag}, ...] or [[r,i], ...]
                if (typeof c.length === 'number' && c.length > 0) {
                    const arr = toArr(c);
                    const out = [];
                    for (let i = 0; i < arr.length; i++) {
                        const it = arr[i];
                        const re = it != null && typeof it === 'object' ? (it.Real ?? it.real ?? it[0]) : (typeof it === 'number' ? it : undefined);
                        const imv = it != null && typeof it === 'object' ? (it.Imag ?? it.imag ?? it[1]) : 0;
                        if (re !== undefined) out.push([Number(re), Number(imv ?? 0)]);
                    }
                    if (out.length > 0) return out;
                }
            }
            // Some encoders put real/imag at TypedList top-level.
            const rTop = tl.real ?? tl.Real;
            const iTop = tl.imag ?? tl.Imag;
            if (rTop != null && iTop != null) {
                const r = toArr(rTop), im = toArr(iTop);
                const n = Math.max(r.length, im.length);
                if (n > 0) {
                    const out = new Array(n);
                    for (let i = 0; i < n; i++) out[i] = [Number(r[i] || 0), Number(im[i] || 0)];
                    return out;
                }
            }
            // TypedList as flat or object list.
            if (typeof tl.length === 'number' && tl.length > 0) {
                const arr = toArr(tl);
                const first = arr[0];
                if (typeof first === 'number') {
                    // Interleaved [r0,i0,r1,i1,...]
                    let out = [];
                    for (let i = 0; i + 1 < arr.length; i += 2) out.push([Number(arr[i] || 0), Number(arr[i + 1] || 0)]);
                    if (out.length > 0) return out;
                    // Split [r..., i...]
                    const half = Math.floor(arr.length / 2);
                    if (half > 0) {
                        out = [];
                        for (let i = 0; i < half; i++) out.push([Number(arr[i] || 0), Number(arr[half + i] || 0)]);
                        if (out.length > 0) return out;
                    }
                }
                if (first != null && typeof first === 'object') {
                    const out = [];
                    for (let i = 0; i < arr.length; i++) {
                        const it = arr[i];
                        const re = it.Real ?? it.real ?? it[0];
                        const imv = it.Imag ?? it.imag ?? it[1];
                        if (re !== undefined && imv !== undefined) out.push([Number(re), Number(imv)]);
                    }
                    if (out.length > 0) return out;
                }
            }
        }
        // List of complex values: [{Complex:[r,i]}, ...] or [[r,i], ...]
        if (result.List && Array.isArray(result.List)) {
            const out = [];
            for (const item of result.List) {
                if (item && item.Complex) {
                    const c = item.Complex;
                    const re = Array.isArray(c) ? c[0] : (c.real ?? c.Real ?? 0);
                    const imv = Array.isArray(c) ? c[1] : (c.imag ?? c.Imag ?? 0);
                    out.push([Number(re), Number(imv)]);
                } else if (Array.isArray(item) && item.length >= 2) {
                    out.push([Number(item[0] || 0), Number(item[1] || 0)]);
                } else if (typeof item === 'number') {
                    out.push([Number(item), 0]);
                }
            }
            if (out.length > 0) return out;
        }
        return null;
    }

    /**
     * Plain phantom dict from Pyodide (shape/affine/data volumes) must match toolapi 0.4.5 wire format:
     * - Root: Value::SegmentedPhantom → { SegmentedPhantom: { tissues, b1_tx, b1_rx } }
     * - Volume.data: toolapi TypedList::Float (not Value) → { Float: number[] } only — no TypedList wrapper
     *   (WASM rejects `TypedList` here: data field deserializes as TypedList enum, not Value.)
     * See toolapi value::structured::{Volume, SegmentedPhantom, PhantomTissue}.
     */
    _typedListFloat(arr) {
        const src = Array.isArray(arr) ? arr : (arr != null && typeof arr.length === 'number' ? Array.from(arr) : []);
        return { Float: src.map((x) => Number(x)) };
    }

    _normalizeShape3(s) {
        const a = Array.isArray(s) ? s.map((x) => Number(x)) : [];
        if (a.length === 3) return a;
        if (a.length === 2) return [a[0], a[1], 1];
        if (a.length === 1) return [a[0], 1, 1];
        if (a.length > 3) return [a[0], a[1], a[2]];
        throw new Error(`Invalid volume shape (need 1–3 dims): ${JSON.stringify(s)}`);
    }

    _encodeToolapiVolume(vol) {
        if (!vol || typeof vol !== 'object') throw new Error('encodeToolapiVolume: invalid volume');
        const shape = this._normalizeShape3(vol.shape);
        const aff = vol.affine;
        if (!Array.isArray(aff) || aff.length !== 3) throw new Error('encodeToolapiVolume: affine must be 3×4');
        const affine = aff.map((row) => {
            if (!Array.isArray(row) || row.length !== 4) throw new Error('encodeToolapiVolume: affine row must have 4 floats');
            return row.map((x) => Number(x));
        });
        return {
            shape,
            affine,
            data: this._typedListFloat(vol.data),
        };
    }

    _encodeSegmentedPhantomForToolapi(plain) {
        if (!plain || typeof plain !== 'object') throw new Error('encodeSegmentedPhantomForToolapi: invalid phantom');
        const tissuesIn = plain.tissues || {};
        const tissues = {};
        for (const [name, t] of Object.entries(tissuesIn)) {
            if (!t || typeof t !== 'object') continue;
            tissues[name] = {
                density: this._encodeToolapiVolume(t.density),
                db0: this._encodeToolapiVolume(t.db0),
                t1: Number(t.t1),
                t2: Number(t.t2),
                t2dash: Number(t.t2dash),
                adc: Number(t.adc),
            };
        }
        const b1_tx = (plain.b1_tx || []).map((v) => this._encodeToolapiVolume(v));
        const b1_rx = (plain.b1_rx || []).map((v) => this._encodeToolapiVolume(v));
        return { SegmentedPhantom: { tissues, b1_tx, b1_rx } };
    }

    async _prepareCurrentSeqForTools(job) {
        if (window.seqExplorer) {
            await window.seqExplorer.executeFunction(true, this.scanCounter);
        }
        const nvMod = window.nvModule;
        const isInterpreter = this.currentSequence && (this.currentSequence.functionName === 'seq_pulseq_interpreter');
        let sourceSeqPath = null;
        if (isInterpreter && window.seqExplorer) {
            const paramsRoot = window.seqExplorer.paramsTarget || window.seqExplorer.container;
            const input = paramsRoot ? paramsRoot.querySelector('#seq-param-seq_file') : null;
            if (input && input.value && input.value.trim()) sourceSeqPath = input.value.trim();
        }
        const sourceSeqPathPy = sourceSeqPath != null ? JSON.stringify(sourceSeqPath) : 'None';
        const saveResult = await nvMod.pyodide.runPythonAsync(`
import os, shutil, __main__
from seq_source_manager import SourceManager
os.makedirs('/outputs', exist_ok=True)
vfs_path = '/outputs/${job.baseName}.seq'
source_seq_path = ${sourceSeqPathPy}
_final_status = "no_sequence"
if source_seq_path is not None and os.path.exists(source_seq_path):
    shutil.copy2(source_seq_path, vfs_path)
    _final_status = "success"
else:
    seq = getattr(SourceManager, '_last_sequence', None) or getattr(__main__, 'seq', None)
    if seq:
        seq.write(vfs_path)
        _final_status = "success"
_final_status
        `);
        if (saveResult === "success") {
            job.vfsSeqPath = `/outputs/${job.baseName}.seq`;
            // Must return file text as last expression — bare f.read() inside `with` does not propagate to JS.
            const seqPy = await nvMod.pyodide.runPythonAsync(`
with open('${job.vfsSeqPath}', 'r', encoding='utf-8', errors='ignore') as f:
    _sim_seq_text = f.read()
_sim_seq_text
            `);
            const seqText = (seqPy && seqPy.toJs) ? seqPy.toJs() : seqPy;
            if (seqPy?.destroy) seqPy.destroy();
            const text = String(seqText || "").trim();
            if (!text) {
                throw new Error("Prepared .seq file is empty. Run/plot the sequence in the explorer so seq.write() produces content, or use a valid .seq path for the interpreter.");
            }
            return text;
        }
        throw new Error("Could not prepare .seq file for simulation.");
    }

    /**
     * Build rapisim phantom dict from resampled NIfTI bytes in a temp FS folder only (no Niivue, no /phantom).
     * @param {{ jsonName?: string, jsonFileName?: string, jsonContent?: string, resampledEntries: { name: string, bytes: Uint8Array }[] }} spec
     */
    async _convertResampledGroupToToolPhantom(nvMod, spec) {
        await nvMod.initPyodide();
        const STAGING = "/tmp/__sim_phantom_staging";
        const stagingPy = JSON.stringify(STAGING);
        await nvMod.pyodide.runPythonAsync(`
import os, shutil
_p = ${stagingPy}
if os.path.exists(_p):
    shutil.rmtree(_p)
os.makedirs(_p, exist_ok=True)
`);
        const { jsonName, jsonFileName, jsonContent, resampledEntries } = spec;
        if (!resampledEntries?.length) throw new Error("_convertResampledGroupToToolPhantom: no resampledEntries");
        for (const ent of resampledEntries) {
            const baseName = String(ent.name || "vol.nii").replace(/^\/+/, "").replace(/\.\.\//g, "");
            if (!baseName) continue;
            const u8 = ent.bytes instanceof Uint8Array ? ent.bytes : new Uint8Array(ent.bytes);
            nvMod.pyodide.FS.writeFile(`${STAGING}/${baseName}`, u8);
        }
        const jsonFn = jsonFileName || `${jsonName || "phantom"}.json`;
        if (jsonContent != null && jsonContent !== "") {
            nvMod.pyodide.FS.writeFile(`${STAGING}/${jsonFn}`, typeof jsonContent === "string" ? jsonContent : String(jsonContent));
        }
        nvMod.pyodide.globals.set("sim_json_name", jsonFn);
        nvMod.pyodide.globals.set("sim_phantom_base", STAGING);
        let phantomObj;
        try {
            phantomObj = await nvMod.pyodide.runPythonAsync(`
import json, numpy as np, nibabel as nib, re, tempfile, os
from nibabel.filebasedimages import ImageFileError
cfg_name = sim_json_name.to_py() if hasattr(sim_json_name, 'to_py') else sim_json_name
base = sim_phantom_base.to_py() if hasattr(sim_phantom_base, 'to_py') else str(sim_phantom_base)
with open(os.path.join(base, cfg_name), 'r', encoding='utf-8') as f:
    cfg = json.load(f)
cache = {}
def parse_ref(s):
    m = re.match(r"^(.+)\\[(\\d+)\\]$", s)
    if not m: raise ValueError(f'Invalid ref: {s}')
    return m.group(1), int(m.group(2))
def load4d(fn):
    if fn in cache: return cache[fn]
    path = base + '/' + fn
    try:
        img = nib.load(path)
    except ImageFileError as e:
        # Plain NIfTI sometimes wrongly named *.nii.gz (not gzip)
        if "not a gzip file" in str(e).lower() and str(fn).lower().endswith(".nii.gz"):
            with open(path, "rb") as src, tempfile.NamedTemporaryFile(suffix=".nii", delete=False) as tmp:
                tmp.write(src.read())
                tmp_path = tmp.name
            img = nib.load(tmp_path)
        else:
            raise
    dat = img.get_fdata()
    if dat.ndim == 3: dat = dat[..., np.newaxis]
    cache[fn] = (img.affine, dat)
    return cache[fn]
def make_vol(arr, aff):
    return {
        "shape": list(arr.shape),
        "affine": aff[:3,:4].tolist(),
        "data": np.asarray(arr, dtype=np.float64).ravel(order='C').tolist()
    }
tissues = {}
first = None
for n,t in cfg.get('tissues',{}).items():
    if first is None: first = t
    dfn,didx = parse_ref(t['density'])
    aff,d4 = load4d(dfn); dens = d4[:,:,:,didx]
    def prop(k,default):
        p = t.get(k, default)
        if isinstance(p,(int,float)): return float(p)
        if isinstance(p,str):
            fn,idx = parse_ref(p); _,v4 = load4d(fn); vv = v4[:,:,:,idx].ravel(order='C'); dd=dens.ravel(order='C'); s=float(dd.sum()); return float((dd*vv).sum()/s) if s>0 else float(default)
        return float(default)
    tissues[n] = {
        "density": make_vol(dens, aff),
        "db0": make_vol(np.ones_like(dens)*prop('dB0', 1.0), aff),
        "t1": prop('T1', float('inf')),
        "t2": prop('T2', float('inf')),
        "t2dash": prop("T2'", float('inf')),
        "adc": prop('ADC', 0.0),
    }
b1_tx=[]; b1_rx=[]
if first:
    for p in first.get('B1+', [1.0]):
        if isinstance(p,(int,float)):
            arr=np.ones_like(dens)*float(p); v=make_vol(arr, aff); b1_tx.append(v)
    for p in first.get('B1-', [1.0]):
        if isinstance(p,(int,float)):
            arr=np.ones_like(dens)*float(p); v=make_vol(arr, aff); b1_rx.append(v)
{"tissues": tissues, "b1_tx": b1_tx, "b1_rx": b1_rx}
        `);
        } finally {
            try {
                await nvMod.pyodide.runPythonAsync(`
import os, shutil
_p = ${stagingPy}
if os.path.exists(_p):
    shutil.rmtree(_p)
`);
            } catch (_) { /* ignore */ }
        }
        const out = (phantomObj && phantomObj.toJs) ? phantomObj.toJs() : phantomObj;
        if (phantomObj?.destroy) phantomObj.destroy();
        return out;
    }

    /**
     * Shared pipeline: resample phantom → conseq / trajex → rapisim or tool-mr0sim → PyNUFFT → queue result.
     * @param {object} job — must include simToolUrl, simLogLabel, noSignalName (from _enqueueSimJob).
     */
    async runSimPipeline(job) {
        const nvMod = window.nvModule;
        const simToolUrl = job.simToolUrl || TOOL_RAPISIM;
        this._simPipelineJob = job;
        job.status = 'scanning';
        this.updateQueueUI();
        try {
            // FOV contract: **Pulseq seq.definitions FOV** (m) is authoritative for physical size (mm).
            // Sequence must run *before* generateFovMaskNifti() so executeFunction can emit sequence_fov_dims
            // and the viewer FOV sliders update first; mask grid (mask X/Y/Z), offsets, rotation stay as in UI.
            // Resampling + PyNUFFT ref then match the same geometry the user sees after seq sync.
            // Ensure run_resampling / run_resampling_serial3d_to_4d are defined.
            await nvMod.initPyodide();
            const activeGroup = nvMod.volumeGroups?.find(g => g.volumes?.length && !String(g.jsonName || '').endsWith('_resampled') && !String(g.jsonName || '').endsWith('_averaged'));
            if (!activeGroup) throw new Error("No phantom group with JSON found. Load phantom via Add Folder/Add File first.");

            // 1) Silent seq execute + protocol snapshot + sequence_fov_dims → Niivue FOV mm from seq.definitions
            const seqText = await this._prepareCurrentSeqForTools(job);

            // 2) Ref mask / grid from viewer (now includes seq FOV mm on sliders)
            const resampledEntries = [];
            const ref = nvMod.generateFovMaskNifti();
            nvMod.pyodide.globals.set("reference_bytes", ref);
            for (const vol of activeGroup.volumes) {
                const hdr = vol.hdr ?? vol.header;
                const dims = hdr?.dims ?? hdr?.dim ?? vol.dims ?? [];
                const useSerial3DTo4D = (nvMod.options.resampleSerial3D !== false && (dims[0] || 3) >= 4 && Number(dims[4] || 1) > 1);
                const src = nvMod.getVolumeNifti(vol);
                nvMod.pyodide.globals.set("source_bytes", src);
                let res = await nvMod.pyodide.runPythonAsync(
                    useSerial3DTo4D
                        ? `run_resampling_serial3d_to_4d(source_bytes, reference_bytes)`
                        : `run_resampling(source_bytes, reference_bytes)`
                );
                const outPathRaw = (res && res.toJs) ? res.toJs() : res;
                const outPath = String(outPathRaw);
                if (outPathRaw?.destroy) outPathRaw.destroy();
                if (res?.destroy) res.destroy();
                const outU8 = nvMod.pyodide.FS.readFile(outPath);
                try { nvMod.pyodide.FS.unlink(outPath); } catch (_) {}
                resampledEntries.push({ name: vol.name, bytes: new Uint8Array(outU8) });
            }
            if (!resampledEntries.length) throw new Error("Resampling failed: no volumes produced.");

            // 3) Phantom dict for toolapi (temp FS dir, deleted after)
            const phantomPayload = await this._convertResampledGroupToToolPhantom(nvMod, {
                jsonName: activeGroup.jsonName,
                jsonFileName: activeGroup.jsonFileName,
                jsonContent: activeGroup.jsonContent,
                resampledEntries,
            });

            // 4) JS tools: conseq + trajex + sim backend (rapisim or tool-mr0sim)
            const call = await this._ensureToolApi();
            const seq = await call(TOOL_CONSEQ, { Dict: { seq_file: { Str: seqText }, exact_trajectory: { Bool: false } } }, (m) => this._toolOnMessage(m));
            if (seq?.Error || seq?.err) throw new Error(seq.Error || seq.err || 'conseq failed');
            const ev = seq?.TypedList?.InstantSeqEvent;
            const events = ev
                ? { TypedList: { InstantSeqEvent: ev } }
                : seq;
            const phantomForSim = this._encodeSegmentedPhantomForToolapi(phantomPayload);
            const [trajResult, signalResult] = await Promise.all([
                call(TOOL_TRAJEX, { Dict: { sequence: events, t1: { Float: 1.0 }, t2: { Float: 0.1 }, min_mag: { Float: 0.001 } } }, (m) => this._toolOnMessage(m)),
                call(simToolUrl, { Dict: { sequence: seq, phantom: phantomForSim } }, (m) => this._toolOnMessage(m)),
            ]);
            const traj = this._trajectoryFromResult(trajResult);
            const signal = this._signalFromResult(signalResult);
            if (!signal?.length) throw new Error(`${job.noSignalName || 'Simulation'} returned no signal.`);

            // 5) PyNUFFT recon: output size & world space = ref mask; om = k_phys * voxel_size (rad/m · m)
            await nvMod.pyodide.loadPackage(["micropip"]);
            await nvMod.pyodide.runPythonAsync(`
import micropip
try:
    import pynufft  # noqa
except Exception:
    await micropip.install('pynufft')
            `);
            nvMod.pyodide.globals.set("sim_signal_pairs", signal);
            nvMod.pyodide.globals.set("sim_traj_points", traj || []);
            nvMod.pyodide.globals.set("sim_ref_bytes", ref);
            const recoPathRes = await nvMod.pyodide.runPythonAsync(`
import numpy as np, nibabel as nib, io
from pynufft import NUFFT
raw = sim_signal_pairs.to_py() if hasattr(sim_signal_pairs, 'to_py') else sim_signal_pairs
traj = sim_traj_points.to_py() if hasattr(sim_traj_points, 'to_py') else sim_traj_points
signal = np.array([complex(float(r), float(i)) for r,i in raw], dtype=np.complex64).ravel()
ref_bytes = sim_ref_bytes.to_py() if hasattr(sim_ref_bytes, 'to_py') else sim_ref_bytes
ref_fh = nib.FileHolder(fileobj=io.BytesIO(ref_bytes))
ref_img = nib.Nifti1Image.from_file_map({'header': ref_fh, 'image': ref_fh})
# Full 3D FOV grid (same as generateFovMaskNifti). If nz_ref>1 and traj is 2D, use 3D NUFFT with ω_z=0 (kz zero-fill).
shp = tuple(int(x) for x in ref_img.shape)
if len(shp) == 2:
    nx, ny, nz_ref = shp[0], shp[1], 1
elif len(shp) >= 3:
    nx, ny, nz_ref = shp[0], shp[1], max(1, shp[2])
else:
    nx, ny, nz_ref = int(ref_img.shape[0]), int(ref_img.shape[1]), 1
zooms_full = list(ref_img.header.get_zooms())
while len(zooms_full) < 3:
    zooms_full.append(zooms_full[-1] if zooms_full else 1.0)
dx_mm = float(zooms_full[0]) if zooms_full[0] and float(zooms_full[0]) > 0 else 1.0
dy_mm = float(zooms_full[1]) if len(zooms_full) > 1 and zooms_full[1] and float(zooms_full[1]) > 0 else dx_mm
dz_mm = float(zooms_full[2]) if len(zooms_full) > 2 and zooms_full[2] and float(zooms_full[2]) > 0 else 1.0
dx_m = dx_mm * 1e-3
dy_m = dy_mm * 1e-3
dz_m = dz_mm * 1e-3
fov_x_m = nx * dx_m
fov_y_m = ny * dy_m
fov_z_m = max(nz_ref, 1) * dz_m
kmax_x = nx / (2.0 * fov_x_m)
kmax_y = ny / (2.0 * fov_y_m)
kmax_z = max(nz_ref, 1) / (2.0 * fov_z_m) if fov_z_m > 1e-30 else 1.0
nz_use = max(int(nz_ref), 1)
# Always 3-column ω + 3D NUFFT grid (nz_use==1 → singleton z) so output is never “2D NIfTI”; avoids FOV/view glitches.
om = None
if traj and len(traj) > 0:
    t = np.asarray(traj, dtype=np.float64)
    if t.ndim == 2 and t.shape[1] >= 2:
        kxy = t[:, :2]
        kz_col = t[:, 2].astype(np.float64) if t.shape[1] >= 3 else None
        if kmax_x > 1e-30 and kmax_y > 1e-30 and np.abs(kxy).max() > 1e-18:
            oz = np.zeros(kxy.shape[0], dtype=np.float64)
            if kz_col is not None and kmax_z > 1e-30:
                oz = (kz_col / kmax_z) * np.pi
            om2 = np.stack([
                (kxy[:, 0] / kmax_x) * np.pi,
                (kxy[:, 1] / kmax_y) * np.pi,
            ], axis=-1)
            om = np.column_stack([om2[:, 0], om2[:, 1], oz])
if om is None:
    kx = np.linspace(-np.pi, np.pi, nx, endpoint=False)
    ky = np.linspace(-np.pi, np.pi, ny, endpoint=False)
    kxg, kyg = np.meshgrid(kx, ky, indexing='xy')
    kzg = np.zeros_like(kxg, dtype=np.float64)
    om = np.stack([kxg.ravel(), kyg.ravel(), kzg.ravel()], axis=-1)
n = min(signal.size, om.shape[0]); signal = signal[:n]; om = om[:n]
A = NUFFT()
Kz = max(2 * nz_use, 4)
A.plan(om, (nx, ny, nz_use), (2 * nx, 2 * ny, Kz), (8, 8, 8))
reco = A.adjoint(signal).reshape(nx, ny, nz_use)
mag3d = np.abs(reco).astype(np.float32)
# Flip voxel data on all axes for display alignment; affine unchanged (same world↔index as ref mask).
mag3d = np.ascontiguousarray(np.flip(mag3d, axis=(0, 1, 2)))
# Compensate ~1-voxel shift (NUFFT / grid centering vs NIfTI voxel centers): roll +1 along each dim.
for _ax in (0, 1, 2):
    mag3d = np.roll(mag3d, 1, axis=_ax)
mag3d = np.ascontiguousarray(mag3d)
# Fresh header from array shape + mask zooms (avoids 2D / nz=0 dim[] from stale header.copy()).
out = nib.Nifti1Image(np.asarray(mag3d, dtype=np.float32), ref_img.affine)
out.header.set_zooms((dx_mm, dy_mm, dz_mm))
out.set_sform(ref_img.affine, code=2)
out.set_qform(ref_img.affine, code=2)
out_path = '/tmp/__sim_pipeline_reco.nii'
nib.save(out, out_path)
out_path
            `);
            const recoPath = (recoPathRes && recoPathRes.toJs) ? recoPathRes.toJs() : recoPathRes;
            if (recoPathRes?.destroy) recoPathRes.destroy();
            const recoBytes = nvMod.pyodide.FS.readFile(String(recoPath));
            try { nvMod.pyodide.FS.unlink(String(recoPath)); } catch (_) {}

            // 6) show in Niivue (scan-like naming/path)
            job.niftiUrl = URL.createObjectURL(new Blob([recoBytes], { type: "application/octet-stream" }));
            job.seqUrl = URL.createObjectURL(new Blob([seqText], { type: "text/plain" }));
            job.status = 'done';
            this.loadJob(job.id);
        } catch (e) {
            console.error(`${job.simLogLabel || 'SIM'} failed:`, e);
            job.status = 'error';
            job.error = e.message;
        } finally {
            this._simPipelineJob = null;
        }
        this.updateQueueUI();
    }

    updateQueueUI() {
        if (!this.container) return;
        const list = this.container.querySelector('#scan-queue-list');
        if (!list) return;
        
        if (this.queue.length === 0) {
            list.innerHTML = '<div class="queue-empty">Queue is empty</div>';
            return;
        }

        list.innerHTML = this.queue.map(job => `
            <div class="queue-item status-${job.status}" data-id="${job.id}">
                <div class="item-main">
                    <div class="item-title">${job.scanNumber}. ${job.name}</div>
                    <div class="item-meta">${job.timestamp}</div>
                </div>
                <div class="item-actions">
                    ${job.status === 'scanning' ? '<div class="scan-spinner"></div>' : ''}
                    ${job.status === 'done' ? `
                        <div class="action-row">
                            <button class="view-btn">VIEW SCAN</button>
                            ${job.cutOnly ? '' : '<button class="view-seq-btn">VIEW SEQ</button>'}
                        </div>
                        <div class="action-row small-btns">
                            ${job.cutOnly ? '' : '<button class="dl-seq-btn" title="Download .seq file"><i class="bi bi-download" aria-hidden="true"></i></button>'}
                            <button class="remove-job-btn" title="Remove scan"><i class="bi bi-x-lg" aria-hidden="true"></i></button>
                        </div>
                    ` : ''}
                    ${job.status === 'error' ? `
                        <div class="action-row small-btns">
                            <span class="error-icon" title="${job.error}">⚠</span>
                            <button class="remove-job-btn" title="Remove scan"><i class="bi bi-x-lg" aria-hidden="true"></i></button>
                        </div>
                    ` : ''}
                </div>
            </div>
        `).join('');

        // Bind clicks for VIEW buttons
        list.querySelectorAll('.view-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const jobId = btn.closest('.queue-item').dataset.id;
                this.loadJob(jobId);
            };
        });

        list.querySelectorAll('.view-seq-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const jobId = btn.closest('.queue-item').dataset.id;
                this.viewSeq(jobId);
            };
        });

        // Bind clicks for Download/Remove buttons
        list.querySelectorAll('.dl-seq-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const jobId = btn.closest('.queue-item').dataset.id;
                this.downloadSeq(jobId);
            };
        });

        list.querySelectorAll('.remove-job-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const jobId = btn.closest('.queue-item').dataset.id;
                this.removeJob(jobId);
            };
        });
    }

    removeJob(jobId) {
        const index = this.queue.findIndex(j => j.id === jobId);
        if (index !== -1) {
            this.queue.splice(index, 1);
            this.updateQueueUI();
        }
    }

    async downloadSeq(jobId) {
        const job = this.queue.find(j => j.id === jobId);
        if (!job || !job.vfsSeqPath) return;

        try {
            const nvMod = window.nvModule;
            if (!nvMod || !nvMod.pyodide) return;

            // Read the file from Pyodide VFS using Python bytes conversion
            const result = await nvMod.pyodide.runPythonAsync(`
import os
path = '${job.vfsSeqPath}'
data = None
if os.path.exists(path):
    with open(path, 'rb') as f:
        data = f.read()
data
            `);

            if (result) {
                // Ensure we convert from PyProxy to Uint8Array if necessary
                const bytes = (result.toJs) ? result.toJs() : result;
                if (result.destroy) result.destroy();
                
                const blob = new Blob([bytes], { type: 'application/octet-stream' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${job.baseName}.seq`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 100);
            } else {
                console.warn("ScanModule: No data returned from Python for download.");
            }
        } catch (e) {
            console.error("Failed to download .seq file:", e);
            alert("Failed to download sequence file.");
        }
    }

    async loadJob(jobId) {
        const job = this.queue.find(j => j.id === jobId);
        if (job && job.status === 'done' && window.nvModule) {
            // Switch to planning mode if we are in sequence mode
            if (window.viewManager && window.viewManager.currentMode !== 'planning') {
                window.viewManager.setMode('planning');
            }

            const nvMod = window.nvModule;
            const targetName = job.baseName + ".nii.gz";
            
            // 1. Check if already loaded
            let volumeIndex = nvMod.nv.volumes.findIndex(v => v.name === targetName);
            
            if (volumeIndex === -1) {
                // 2. Load if not found
                console.log("ScanModule: Loading NIfTI for the first time:", targetName);
                await nvMod.loadUrl(job.niftiUrl, targetName, true);
                // Re-find the index after loading
                volumeIndex = nvMod.nv.volumes.findIndex(v => v.name === targetName);
            } else {
                console.log("ScanModule: Volume already loaded, switching focus to:", targetName);
            }

            // 3. Set opacity: 1 for this one, 0 for all other SCANS, keep PHANTOMS as they are
            if (volumeIndex !== -1) {
                const targetVol = nvMod.nv.volumes[volumeIndex];
                
                nvMod.nv.volumes.forEach((vol, idx) => {
                    const isTargetScan = idx === volumeIndex;
                    const isOtherScan = vol.name && vol.name.startsWith('scan_') && idx !== volumeIndex;
                    
                    if (isTargetScan) {
                        nvMod.nv.setOpacity(idx, 1.0);
                    } else if (isOtherScan) {
                        nvMod.nv.setOpacity(idx, 0);
                    }
                    // Phantoms (non-scan names) are left untouched
                });
                
                // 4. Select this volume for preview
                nvMod.selectedVolume = targetVol;
                
                // 5. Update the volume list UI checkboxes
                if (typeof nvMod.updateVolumeList === 'function') {
                    nvMod.updateVolumeList();
                }
                
                // 6. Update preview (will show selected volume if it's checked)
                if (typeof nvMod.updatePreviewFromSelection === 'function') {
                    nvMod.updatePreviewFromSelection();
                }

                // Match volume-list scan click: FOV box from this scan's NIfTI (CUT + SIM)
                if (typeof nvMod.syncFovFromScanVolume === 'function') {
                    nvMod.syncFovFromScanVolume(targetVol);
                }
            }
        }
    }

    viewSeq(jobId) {
        const job = this.queue.find(j => j.id === jobId);
        if (!job || job.status !== 'done') return;

        if (!job.vfsSeqPath) {
            alert("No pulse sequence file was saved for this scan. (Ensure you 'plot seq' before scanning)");
            return;
        }

        // 1. Switch mode to sequence
        if (window.viewManager) {
            window.viewManager.setMode('sequence');
            
            // 2. Prepare the plot container (borrowed from SequenceExplorer)
            if (window.seqExplorer) {
                const explorer = window.seqExplorer;
                const plotRoot = explorer.plotTarget || explorer.container;
                let plotContainer = plotRoot.querySelector('#seq-mpl-actual-target');
                
                if (plotContainer) {
                    plotContainer.innerHTML = '';
                    document.pyodideMplTarget = plotContainer;
                    window.pyodideMplTarget = plotContainer;
                }

                // 3. Run Python to read and plot the specific .seq file
                const py = window.nvModule.pyodide;
                if (py) {
                    py.runPythonAsync(`
import pypulseq as pp
import matplotlib.pyplot as plt
import sys
import os

# Ensure pypulseq is patched for the optimized plot function
if hasattr(sys, '_pp_patch_func'):
    sys._pp_patch_func()

plt.close('all')
seq = pp.Sequence()
try:
    path = '${job.vfsSeqPath}'
    print(f"Loading sequence from: {path}")
    if os.path.exists(path):
        seq.read(path)
        # Configure plot (match explorer theme)
        seq.plot(plot_now=False, plot_speed="faster")
        plt.show()
        print("Sequence plot complete.")
    else:
        print(f"Error: File {path} not found in VFS")
except Exception as e:
    print(f"Error reading/plotting seq file: {e}")
                    `);
                }
            }
        }
    }
}
