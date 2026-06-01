import { eventHub } from '../event_hub.js';
import { SequenceExplorer } from '../pypulseq/seq_explorer.js';

/** toolapi-wasm WebSocket URLs (same path `/tool`, different host). */
export const TOOL_CONSEQ = 'wss://tool-conseq.fly.dev/tool';
export const TOOL_TRAJEX = 'wss://tool-trajex.fly.dev/tool';
export const TOOL_RAPISIM = 'wss://tool-rapisim.fly.dev/tool';
export const TOOL_MR0SIM = 'wss://tool-mr0sim.fly.dev/tool';

const TOOL_FLY_HOSTS = [TOOL_CONSEQ, TOOL_TRAJEX, TOOL_RAPISIM, TOOL_MR0SIM].map(
    (url) => new URL(url).hostname,
);

const PIPELINE_STAGES = ['prep', 'conseq', 'trajex', 'sim', 'recon'];

/** Max concurrent toolapi WebSocket calls (global across queued SCAN jobs). */
const MAX_CONCURRENT_TOOL_WS = 2;

/** Stable recon method tag stored in protocol TOML `[recon]`. */
export const RECON_METHOD = 'anyfield-pynufft';

/**
 * Human scan title: `1. gre_seq` from queue job or `scan_<n>_<name>.nii.gz`.
 */
export function formatScanDisplayTitle(volName, job = null) {
    if (job?.scanNumber != null && job?.name != null && String(job.name).trim()) {
        return `${job.scanNumber}. ${job.name}`;
    }
    const m = String(volName || '').match(/^scan_(\d+)_(.*)\.nii(\.gz)?$/i);
    if (m) {
        return `${m[1]}. ${m[2].replace(/\.nii.*/, '')}`;
    }
    return String(volName || '').replace(/\.nii(\.gz)?$/i, '');
}

/** Sim backend registry — stable ids for TOML `[simulation].backend`. */
export const SIM_BACKENDS = {
    mr0sim: {
        id: 'mr0sim',
        label: 'MR0',
        toolUrl: TOOL_MR0SIM,
        reconBackend: 'mr0',
        proOnly: false,
    },
    rapisim: {
        id: 'rapisim',
        label: 'Rapisim',
        toolUrl: TOOL_RAPISIM,
        reconBackend: 'rapisim',
        proOnly: true,
    },
};

/** Footer swipe layout (viewport ≤768px or OPTIONS → Compact). */
export function isCompactFooterLayout() {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 768px)').matches ||
        !!document.querySelector('.lab-shell')?.classList.contains('compact-mode');
}

/** True when URL has ?pro=1 (or true/yes); matches index.html `window.pro`. */
export function isProUser() {
    if (typeof window !== 'undefined' && window.pro) return true;
    if (typeof window === 'undefined' || !window.location?.search) return false;
    return /^1|true|yes$/i.test(new URLSearchParams(window.location.search).get('pro') || '');
}

/**
 * ScanModule - Handles the scanning simulation queue
 * Borrows resampling logic from NiivueModule for FOV crop (no sequence run)
 */
export class ScanModule {
    constructor() {
        this.container = null;
        this.queue = [];
        this.currentSequence = null;
        this.currentFov = null;
        this.scanCounter = 0;
        /** Live protocol being edited in col-params; shown as top queue row until SCAN. */
        this.draftJob = null;
        this._toolApiCall = null;
        /** Set during runSimPipeline for per-tool WebSocket log tagging */
        this._simPipelineJob = null;
        this._toolWsInflight = 0;
        this._toolWsWaiters = [];

        this.setupEventListeners();
    }

    /** Fetch `scan_zero/recon.py` and stage in Pyodide (source passed to Python via global). */
    async _ensureSimReconPy(nvMod) {
        const url = new URL("./recon.py", import.meta.url);
        url.searchParams.set("_", String(Date.now()));
        const text = await (await fetch(url, { cache: "no-store" })).text();
        if (!text.includes("output_mode")) {
            throw new Error("Fetched scan_zero/recon.py is stale (missing output_mode). Hard-refresh the page.");
        }
        const py = nvMod.pyodide;
        py.FS.mkdirTree("/scan_zero");
        py.FS.writeFile("/scan_zero/recon.py", text);
        py.globals.set("sim_recon_py_source", text);
    }

    setupEventListeners() {
        eventHub.on('sequenceSelected', (data) => {
            this._onSequenceSelected(data);
        });

        eventHub.on('fov_changed', (data) => {
            this.currentFov = data;
        });
    }

    _defaultDraftName(seq) {
        return (seq?.displayName || seq?.name || 'Untitled').trim() || 'Untitled';
    }

    _draftProtocolLabel(seq) {
        if (!seq) return '';
        const explorer = window.seqExplorer;
        const { fileName, functionName, source } = seq;
        if (explorer && typeof explorer._getSeqDisplayFileStem === 'function') {
            const isProtocol = source?.itemKind === 'protocol'
                || (source?.path && source.path.startsWith('user/prot/'));
            const stem = explorer._getSeqDisplayFileStem(fileName, source, isProtocol)
                || this._defaultDraftName(seq);
            return isProtocol ? stem : `${stem}:${functionName}`;
        }
        return `${this._defaultDraftName(seq)}:${functionName || ''}`;
    }

    /** Filesystem-safe segment for scan_<n>_<part>_*.nii.gz / .seq (scan number stays unique). */
    _sanitizeScanBaseNamePart(name) {
        let s = String(name || 'scan')
            .replace(/[<>:"/\\|?*]/g, '_')
            .replace(/\s+/g, '_')
            .replace(/^\.+|\.+$/g, '')
            .replace(/_{2,}/g, '_')
            .replace(/^[\d]+_/, 'scan_');
        if (!s) s = 'scan';
        return s.slice(0, 48);
    }

    _hasReservedScanPrefix(name) {
        return /^\d+_/.test(String(name || '').trim());
    }

    _escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/"/g, '&quot;');
    }

    _onSequenceSelected(data) {
        this.currentSequence = data;
        if (!data) {
            this.draftJob = null;
        } else {
            this.draftJob = {
                id: 'draft',
                status: 'draft',
                fileName: data.fileName,
                functionName: data.functionName,
                userName: this._defaultDraftName(data),
                protocolLabel: this._draftProtocolLabel(data),
            };
        }
        if (this.container) this.updateQueueUI();
    }

    /** Validate draft name before SCAN; returns trimmed label or null if invalid. */
    _getValidatedDraftName() {
        if (!this.draftJob) return null;
        const raw = String(this.draftJob.userName || '').trim();
        const label = raw || this._defaultDraftName(this.currentSequence);
        if (this._hasReservedScanPrefix(label)) {
            window.seqExplorer?.showReservedPrefixDialog?.();
            return null;
        }
        this.draftJob.userName = label;
        return label;
    }

    _draftRowHtml() {
        const d = this.draftJob;
        if (!d) return '';
        const nextNum = this.scanCounter + 1;
        const name = d.userName || this._defaultDraftName(this.currentSequence);
        const meta = this._escapeHtml(d.protocolLabel || '');
        return `
            <div class="queue-item status-draft" data-id="draft">
                <div class="item-main">
                    <div class="item-title draft-item-title">
                        <span class="draft-scan-num">${nextNum}.</span>
                        <input type="text" class="draft-name-input" value="${this._escapeHtml(name)}" spellcheck="false" aria-label="Scan name" title="Name for the next scan (used in NIfTI and .seq filenames)" />
                    </div>
                    <div class="item-meta draft-protocol-meta">${meta}</div>
                </div>
            </div>`;
    }

    _bindDraftNameInput(list) {
        const input = list.querySelector('.draft-name-input');
        if (!input || !this.draftJob) return;
        input.oninput = () => {
            this.draftJob.userName = input.value;
        };
        input.onblur = () => {
            let val = input.value.trim();
            if (!val) val = this._defaultDraftName(this.currentSequence);
            if (this._hasReservedScanPrefix(val)) {
                window.seqExplorer?.showReservedPrefixDialog?.();
                val = this._defaultDraftName(this.currentSequence);
            }
            this.draftJob.userName = val;
            input.value = val;
        };
    }

    _bindQueueItemActions(list) {
        list.querySelectorAll('.view-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const jobId = btn.closest('.queue-item').dataset.id;
                if (e.ctrlKey || e.metaKey) {
                    this.loadJobToCompare(jobId);
                } else {
                    this.loadJob(jobId);
                }
            };
        });

        list.querySelectorAll('.view-seq-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const jobId = btn.closest('.queue-item').dataset.id;
                this.viewSeq(jobId);
            };
        });

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

    render(containerId) {
        this.container = typeof containerId === 'string' ? document.getElementById(containerId) : containerId;
        if (!this.container) return;

        this.container.innerHTML = `
            <div class="scan-module">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
                    <h3 class="section-title" style="margin: 0;">RUN</h3>
                </div>
                <div class="scan-header" style="display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem;">
                    ${isProUser() ? `
                    <button id="btn-start-crop" class="scan-btn" title="Resample first volume to FOV (crop to box)">
                        CROP
                    </button>
                    ` : ''}
                    <button id="btn-start-sim-mr0" class="scan-btn" title="MR0 (tool-mr0sim)">
                        SCAN<span class="icon">▶</span> 
                    </button>
                    ${isProUser() ? `
                    <button id="btn-start-sim-fast" class="scan-btn" title="Rapisim (tool-rapisim)">
                         SCAN<span class="icon">▶▶</span>
                    </button>
                    ` : ''}
                </div>
                <div class="scan-queue" id="scan-queue-list">
                    <div class="queue-empty">Queue is empty</div>
                </div>
            </div>
        `;

        const cropBtn = this.container.querySelector('#btn-start-crop');
        if (cropBtn) cropBtn.onclick = () => this.startCrop();
        this.container.querySelector('#btn-start-sim-mr0').onclick = () => this.startSimMr0();
        const fastBtn = this.container.querySelector('#btn-start-sim-fast');
        if (fastBtn) fastBtn.onclick = () => this.startSimFast();
        
        // Make this instance available globally for UI callbacks if needed
        window.scanModule = this;
        this._syncMobileScanControls();
    }

    _getActiveScanJob() {
        return this.queue.find((j) => j.status === 'scanning') || null;
    }

    _syncMobileScanControls() {
        const wrap = document.getElementById('seq-mobile-run-btns');
        if (!wrap) return;
        const statusSlot = wrap.querySelector('#seq-mobile-pipeline-status');
        if (!isCompactFooterLayout()) {
            wrap.classList.remove('is-busy');
            wrap.querySelectorAll('.scan-btn-compact').forEach((btn) => {
                btn.disabled = false;
            });
            if (statusSlot) {
                statusSlot.innerHTML = '';
                statusSlot.hidden = true;
                statusSlot.setAttribute('aria-hidden', 'true');
            }
            return;
        }
        const active = this._getActiveScanJob();
        const busy = !!active;
        wrap.classList.toggle('is-busy', busy);
        wrap.querySelectorAll('.scan-btn-compact').forEach((btn) => {
            btn.disabled = busy;
        });
        if (!statusSlot) return;
        if (!busy) {
            statusSlot.innerHTML = '';
            statusSlot.hidden = true;
            statusSlot.setAttribute('aria-hidden', 'true');
            return;
        }
        statusSlot.hidden = false;
        statusSlot.setAttribute('aria-hidden', 'false');
        const s = active.pipelineStage ?? 0;
        const crop = !!active.cropOnly;
        let ring = statusSlot.querySelector('.scan-pipeline-progress');
        if (!ring) {
            statusSlot.innerHTML = this._pipelineProgressHtml(s, crop);
            return;
        }
        ring.style.setProperty('--stage', s);
        ring.dataset.stage = String(s);
        ring.classList.toggle('is-crop', crop);
        const label = crop ? 'crop' : PIPELINE_STAGES[s];
        ring.title = label;
        ring.setAttribute('aria-valuenow', String(s));
        ring.setAttribute('aria-label', label);
    }

    async startCrop() {
        if (!isProUser()) return;
        // CROP = resample current viewer volume to FOV mask only (no seq execution / no .seq artifact)
        const nvMod = window.nvModule;
        if (!nvMod || !nvMod.nv?.volumes?.length) {
            alert("No volume loaded in Niivue.");
            return;
        }

        this.scanCounter++;
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const baseName = `scan_${this.scanCounter}_crop`;

        const job = {
            id: 'job_' + now.getTime(),
            scanNumber: this.scanCounter,
            baseName: baseName,
            name: "crop",
            protocol: "CROP (FOV)",
            cropOnly: true,
            status: 'pending',
            timestamp: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
            niftiUrl: null,
            seqUrl: null,
            error: null
        };

        this.queue.unshift(job); // Add to top of queue
        this.updateQueueUI();
        
        await this.runCropScan(job);
    }

    _enqueueSimJob({ backendId, userName }) {
        const backend = SIM_BACKENDS[backendId];
        if (!backend) throw new Error(`Unknown sim backend: ${backendId}`);
        this.scanCounter++;
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const displayLabel = userName
            || this.draftJob?.userName
            || this._defaultDraftName(this.currentSequence);
        const nameSafe = this._sanitizeScanBaseNamePart(displayLabel);
        const baseName = `scan_${this.scanCounter}_${nameSafe}`;
        const job = {
            id: 'job_' + now.getTime(),
            scanNumber: this.scanCounter,
            baseName,
            name: displayLabel,
            simulation: {
                backendId: backend.id,
                backendLabel: backend.label,
                toolUrl: backend.toolUrl,
                reconBackend: backend.reconBackend,
            },
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
        if (!isProUser()) return;
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
        const userName = this._getValidatedDraftName();
        if (!userName) return;
        const job = this._enqueueSimJob({ backendId: 'rapisim', userName });
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
        const userName = this._getValidatedDraftName();
        if (!userName) return;
        const job = this._enqueueSimJob({ backendId: 'mr0sim', userName });
        await this.runSimPipeline(job);
    }

    async runCropScan(job) {
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
        job.pipelineStage = 0;
        this.updateQueueUI();

        try {
            const srcVol = typeof nvMod.getPhantomVolumeForResample === "function"
                ? nvMod.getPhantomVolumeForResample()
                : nvMod.nv.volumes[0];
            if (!srcVol) throw new Error("No phantom volume available for CROP.");
            const refBytes = nvMod.generateFovMaskNifti(nvMod.getPhantomMatrixDims());

            await nvMod.initPyodide();
            const niftiBytes = await nvMod.enqueuePyodideTask(job.id, "crop", async () => {
                const srcBytes = nvMod.getVolumeNifti(srcVol);
                nvMod.pyodide.globals.set("source_bytes", srcBytes);
                nvMod.pyodide.globals.set("reference_bytes", refBytes);
                nvMod._setResamplePyodideOptions();
                const res = await nvMod.runPyodideResampling(srcVol, { jobId: job.id, suffix: "crop" });
                return nvMod.readResampleOutputPath(res).bytes;
            });

            job.niftiUrl = URL.createObjectURL(new Blob([niftiBytes], {type: "application/octet-stream"}));

            job.status = 'done';
            // Auto-load: don't resync FOV — preserve any in-progress FOV planning the user is doing
            // for the next scan. Explicit VIEW SCAN clicks still sync (default `syncFov=true`).
            this.loadJob(job.id, false);
            
        } catch (e) {
            console.error("Scan simulation failed:", e);
            job.status = 'error';
            job.error = typeof nvMod?.formatPyodideError === "function"
                ? nvMod.formatPyodideError(e)
                : (e.message || String(e));
        }

        this.updateQueueUI();
    }

    /**
     * Wake Fly tool machines (HTTP) and preload toolapi-wasm. Fire-and-forget; does not block bootstrap.
     */
    prewarmToolBackends() {
        for (const host of TOOL_FLY_HOSTS) {
            fetch(`https://${host}/`, { mode: 'no-cors', cache: 'no-store' }).catch(() => {});
        }
        this._ensureToolApi().catch((err) => {
            console.warn('ScanModule: toolapi preload failed:', err);
        });
    }

    async _ensureToolApi() {
        if (this._toolApiCall) return this._toolApiCall;
        const { default: init, call } = await import('https://unpkg.com/toolapi-wasm@0.4.5/toolapi_wasm.js');
        await init();
        this._toolApiCall = call;
        return call;
    }

    /** Short label for a tool WebSocket host, e.g. `tool-trajex.fly.dev` → `trajex`. */
    _toolChannelFromUrl(url) {
        try {
            const host = new URL(url).hostname;
            const m = host.match(/^tool-([^.]+)/);
            return m ? m[1] : host;
        } catch (_) {
            return String(url);
        }
    }

    /** Progress callback for one tool WebSocket session (separate channel per call). */
    _toolOnMessageFor(channel) {
        const tag = this._simPipelineJob ? this._jobSimLogTag(this._simPipelineJob) : 'SIM';
        const ch = channel || 'tool';
        return (msg) => {
            console.log(`${tag} [${ch}]`, msg);
            return true;
        };
    }

    async _acquireToolSlot() {
        if (this._toolWsInflight < MAX_CONCURRENT_TOOL_WS) {
            this._toolWsInflight += 1;
            return;
        }
        await new Promise((resolve) => this._toolWsWaiters.push(resolve));
        this._toolWsInflight += 1;
    }

    _releaseToolSlot() {
        this._toolWsInflight = Math.max(0, this._toolWsInflight - 1);
        const next = this._toolWsWaiters.shift();
        if (next) next();
    }

    /** Extract toolapi error string from a result dict, if any. */
    _toolErrorMessage(result) {
        if (!result) return null;
        const r = result.Ok !== undefined ? result.Ok : result;
        if (r?.Error) return String(r.Error);
        if (r?.err) return String(r.err);
        if (result?.Error) return String(result.Error);
        if (result?.err) return String(result.err);
        return null;
    }

    _assertToolOk(channel, result) {
        const msg = this._toolErrorMessage(result);
        if (msg) throw new Error(`${channel} failed: ${msg}`);
        return result;
    }

    /**
     * Build one error message when Promise.allSettled parallel tool/pyodide legs fail.
     * @param {string} stageLabel
     * @param {Array<{ label: string, settled: PromiseSettledResult }>} legs
     */
    _parallelStageError(stageLabel, legs) {
        const parts = [];
        for (const { label, settled } of legs) {
            if (settled.status === 'rejected') {
                const e = settled.reason;
                parts.push(`${label}: ${e?.message || String(e)}`);
            } else {
                const toolMsg = this._toolErrorMessage(settled.value);
                if (toolMsg) parts.push(`${label}: ${toolMsg}`);
            }
        }
        if (!parts.length) return `${stageLabel} failed`;
        return `${stageLabel} failed — ${parts.join('; ')}`;
    }

    /**
     * One toolapi-wasm request = one WebSocket to `url` (slot-limited globally).
     */
    async _callTool(url, input, channel) {
        await this._acquireToolSlot();
        const call = await this._ensureToolApi();
        const label = channel || this._toolChannelFromUrl(url);
        console.log(`${this._simPipelineJob ? this._jobSimLogTag(this._simPipelineJob) : 'SIM'} [${label}] ws open → ${url}`);
        try {
            return await call(url, input, this._toolOnMessageFor(label));
        } finally {
            console.log(`${this._simPipelineJob ? this._jobSimLogTag(this._simPipelineJob) : 'SIM'} [${label}] ws closed`);
            this._releaseToolSlot();
        }
    }

    /**
     * Resample phantom volumes to FOV + build toolapi phantom dict (Pyodide queue).
     */
    async _simPhantomResampleAndConvert(nvMod, job, activeGroup, phantomRef, simLogTag) {
        nvMod._setResamplePyodideOptions();
        const resampledEntries = [];
        nvMod.pyodide.globals.set("reference_bytes", phantomRef);
        let volIdx = 0;
        for (const vol of activeGroup.volumes) {
            const src = nvMod.getVolumeNifti(vol);
            nvMod.pyodide.globals.set("source_bytes", src);
            const res = await nvMod.runPyodideResampling(vol, {
                jobId: job.id,
                suffix: `v${volIdx++}`,
            });
            const { bytes: outU8 } = nvMod.readResampleOutputPath(res);
            resampledEntries.push({ name: vol.name, bytes: new Uint8Array(outU8) });
        }
        if (!resampledEntries.length) throw new Error("Resampling failed: no volumes produced.");

        const selectedJson = typeof nvMod.getSelectedJsonForSim === 'function'
            ? nvMod.getSelectedJsonForSim(activeGroup)
            : null;
        const phantomJsonFileName = selectedJson?.fileName
            || activeGroup.jsonFileName
            || (activeGroup.jsonName ? `${activeGroup.jsonName}.json` : null);
        const phantomJsonContent = selectedJson?.content != null
            ? selectedJson.content
            : (typeof nvMod.getPhantomJsonContent === 'function'
                ? nvMod.getPhantomJsonContent(activeGroup)
                : activeGroup.jsonContent);
        return this._convertResampledGroupToToolPhantom(nvMod, {
            jsonName: activeGroup.jsonName,
            jsonFileName: phantomJsonFileName,
            jsonContent: phantomJsonContent,
            resampledEntries,
            jobId: job.id,
        });
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

    _jobSimLogTag(job) {
        return job?.simulation?.backendLabel || job?.simulation?.backendId || 'SIM';
    }

    _jobMetaLine(job) {
        const parts = [job.timestamp];
        if (job.simulation?.backendLabel) parts.push(job.simulation.backendLabel);
        return parts.join(' · ');
    }

    async _affineFromNiftiBytes(nvMod, bytes) {
        const run = async () => {
            await nvMod._ensureNibabelReady();
            const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
            nvMod.pyodide.globals.set('_nifti_bytes_for_affine', u8);
            const result = await nvMod.pyodide.runPythonAsync(`
import io, json
import nibabel as nib
_b = _nifti_bytes_for_affine.to_py()
_buf = io.BytesIO(bytes(_b))
_fh = nib.FileHolder(fileobj=_buf)
img = nib.Nifti1Image.from_file_map({"header": _fh, "image": _fh})
aff = img.affine.reshape(-1).tolist()
json.dumps([float(x) for x in aff])
            `);
            return JSON.parse(result);
        };
        if (nvMod._pyodideDrainDepth > 0) return run();
        return nvMod.enqueuePyodideTask("affine", "nifti-affine", run);
    }

    async _patchProtocolSimulationToml(job, { phantomRef, phantomMatrix, reconMatrix, phantomName }) {
        if (!job?.protocolPath || !window.seqExplorer) return;
        const sim = job.simulation || {};
        await window.seqExplorer.patchProtocolTomlSections(job.protocolPath, {
            simulation: {
                backend: sim.backendId || 'mr0sim',
                phantom: phantomName || 'unknown',
                phantom_fov_affine: await this._affineFromNiftiBytes(window.nvModule, phantomRef),
                phantom_matrix: phantomMatrix,
            },
            recon: {
                matrix: reconMatrix,
                method: RECON_METHOD,
            },
        });
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
        const _t = (label) => console.log(`[SEQ-PREP] ${label}: ${performance.now().toFixed(1)}ms`);
        _t('start');
        if (window.seqExplorer) {
            window.seqExplorer._pendingProtocolMeta = {
                scanNumber: job.scanNumber,
                name: job.name,
            };
            await window.seqExplorer.executeFunction(true, job.scanNumber);
            if (window.seqExplorer._lastProtocolSnapshotPath) {
                job.protocolPath = window.seqExplorer._lastProtocolSnapshotPath;
            }
            window.seqExplorer._pendingProtocolMeta = null;
        }
        _t('after executeFunction');
        const nvMod = window.nvModule;
        const isInterpreter = this.currentSequence && (this.currentSequence.functionName === 'seq_pulseq_interpreter');
        let sourceSeqPath = null;
        if (isInterpreter && window.seqExplorer) {
            const paramsRoot = window.seqExplorer.paramsTarget || window.seqExplorer.container;
            const input = paramsRoot ? paramsRoot.querySelector('#seq-param-seq_file') : null;
            if (input && input.value && input.value.trim()) sourceSeqPath = input.value.trim();
        }
        const sourceSeqPathPy = sourceSeqPath != null ? JSON.stringify(sourceSeqPath) : 'None';
        // Record time just before executeFunction so we can detect .seq files written by the sequence
        // script itself (e.g. mrseq writes to /home/pyodide/output/ internally).  We pass this as a
        // Pyodide global so the Python snippet below can skip a second seq.write() and just copy.
        const preExecTimeSec = (Date.now() / 1000) - 2; // 2s buffer for clock skew
        nvMod.pyodide.globals.set('_pre_exec_mtime', preExecTimeSec);
        const saveResult = await nvMod.pyodide.runPythonAsync(`
import os, shutil, __main__, time as _time
from seq_source_manager import SourceManager
os.makedirs('/outputs', exist_ok=True)
vfs_path = '/outputs/${job.baseName}.seq'
source_seq_path = ${sourceSeqPathPy}
_final_status = "no_sequence"
if source_seq_path is not None and os.path.exists(source_seq_path):
    shutil.copy2(source_seq_path, vfs_path)
    _final_status = "success"
else:
    # If the sequence script (e.g. mrseq) already wrote a .seq file during executeFunction,
    # copy it instead of calling seq.write() again — avoids a second ~14s serialisation.
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
        _t0 = _time.perf_counter()
        shutil.copy2(_wrote_path, vfs_path)
        _t1 = _time.perf_counter()
        _size = os.path.getsize(vfs_path)
        print(f"[SEQ-PREP] copy from script output ({os.path.basename(_wrote_path)}): {(_t1-_t0)*1000:.1f}ms, {_size/1024:.1f}KB", flush=True)
        _final_status = "success"
    else:
        seq = getattr(SourceManager, '_last_sequence', None) or getattr(__main__, 'seq', None)
        if seq:
            _t0 = _time.perf_counter()
            seq.write(vfs_path)
            _t1 = _time.perf_counter()
            _size = os.path.getsize(vfs_path)
            print(f"[SEQ-PREP] seq.write(): {(_t1-_t0)*1000:.1f}ms, {_size/1024:.1f}KB", flush=True)
            _final_status = "success"
_final_status
        `);
        _t('after seq.write (Python)');
        if (saveResult === "success") {
            job.vfsSeqPath = `/outputs/${job.baseName}.seq`;
            // Read as bytes — Pyodide transfers bytes as a shared ArrayBuffer (zero-copy),
            // whereas reading as str copies every character through the WASM boundary.
            const seqPy = await nvMod.pyodide.runPythonAsync(`
with open('${job.vfsSeqPath}', 'rb') as f:
    _sim_seq_bytes = f.read()
_sim_seq_bytes
            `);
            _t('after VFS read (Python→JS boundary)');
            const bytes = (seqPy && seqPy.toJs) ? seqPy.toJs() : seqPy;
            _t('after toJs()');
            if (seqPy?.destroy) seqPy.destroy();
            const text = (bytes instanceof Uint8Array)
                ? new TextDecoder('utf-8').decode(bytes)
                : String(bytes || '');
            _t(`after TextDecoder (${(text.length/1024).toFixed(1)}KB)`);
            if (!text.trim()) {
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
    async _convertResampledGroupToToolPhantom(nvMod, spec, jobId = null) {
        await nvMod.initPyodide();
        const STAGING = typeof nvMod.simStagingPath === "function"
            ? nvMod.simStagingPath(jobId || spec.jobId || "sim")
            : "/tmp/__sim_phantom_staging";
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
import json, numpy as np, nibabel as nib, re, tempfile, os, shutil
from nibabel.filebasedimages import ImageFileError
cfg_name = sim_json_name.to_py() if hasattr(sim_json_name, 'to_py') else sim_json_name
base = sim_phantom_base.to_py() if hasattr(sim_phantom_base, 'to_py') else str(sim_phantom_base)
with open(os.path.join(base, cfg_name), 'r', encoding='utf-8') as f:
    cfg = json.load(f)
cache = {}
def parse_ref(s):
    m = re.match(r"^(.+)\\[(\\d+)\\]$", str(s).strip())
    if not m: raise ValueError(f'Invalid ref: {s}')
    return m.group(1), int(m.group(2))
def _collect_nifti_refs(val, out):
    if isinstance(val, str) and '[' in val:
        try:
            out.add(parse_ref(val)[0])
        except ValueError:
            pass
    elif isinstance(val, dict) and 'file' in val:
        _collect_nifti_refs(val['file'], out)
    elif isinstance(val, list):
        for item in val:
            _collect_nifti_refs(item, out)
def _ensure_staged_nifti(fname):
    dst = os.path.join(base, fname)
    if os.path.isfile(dst):
        return
    src = os.path.join('/phantom', fname)
    if os.path.isfile(src):
        os.makedirs(os.path.dirname(dst) or base, exist_ok=True)
        shutil.copy2(src, dst)
_ref_names = set()
for _t in cfg.get('tissues', {}).values():
    if isinstance(_t, dict):
        for _k, _v in _t.items():
            _collect_nifti_refs(_v, _ref_names)
for _fn in _ref_names:
    _ensure_staged_nifti(_fn)
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
    vox = np.sqrt((aff[:3,:3]**2).sum(axis=0))
    diag_aff = np.diag([float(vox[0]), float(vox[1]), float(vox[2]), 1.0])
    return {
        "shape": list(arr.shape),
        "affine": diag_aff[:3,:4].tolist(),
        "data": np.asarray(arr, dtype=np.float64).ravel(order='C').tolist()
    }
def _load_prop_map(prop_val, shape, prop_name):
    """Load 3D map from constant / file_ref / mapping (no tissue mask)."""
    if isinstance(prop_val, (int, float)):
        return np.full(shape, float(prop_val), dtype=np.float64)
    if isinstance(prop_val, str):
        fn, idx = parse_ref(prop_val)
        _, v4 = load4d(fn)
        x = np.asarray(v4[:, :, :, idx], dtype=np.float64)
        if x.shape != shape:
            raise ValueError(
                f'{prop_name} map {prop_val!r} shape {x.shape} != grid shape {shape}'
            )
        return x
    if isinstance(prop_val, dict):
        fn, idx = parse_ref(prop_val['file'])
        _, v4 = load4d(fn)
        x = np.asarray(v4[:, :, :, idx], dtype=np.float64)
        if x.shape != shape:
            raise ValueError(
                f'{prop_name} file {prop_val.get("file")!r} shape {x.shape} != grid shape {shape}'
            )
        x_min = float(x.min())
        x_max = float(x.max())
        x_mean = float(x.mean())
        x_std = float(x.std())
        vol = eval(
            prop_val['func'],
            {'__builtins__': {}},
            {'x': x, 'x_min': x_min, 'x_max': x_max, 'x_mean': x_mean, 'x_std': x_std},
        )
        vol = np.asarray(vol, dtype=np.float64)
        if vol.shape != shape:
            raise ValueError(
                f'{prop_name} func result shape {vol.shape} != grid shape {shape}'
            )
        return vol
    raise ValueError(f'Unsupported {prop_name} type: {type(prop_val)}')
def resolve_vol(prop_val, dens, prop_name='property'):
    """Per-tissue 3D property masked by that tissue's density."""
    mask = dens > 0
    if isinstance(prop_val, (int, float)):
        out = np.zeros(dens.shape, dtype=np.float64)
        out[mask] = float(prop_val)
        return out
    vol = _load_prop_map(prop_val, dens.shape, prop_name)
    return np.where(mask, vol, 0.0)
def prop_scalar(prop_val, default, prop_name):
    """Scalar for toolapi (T1, T2, …): constant or PD-weighted mean in tissue."""
    if isinstance(prop_val, (int, float)):
        return float(prop_val)
    if isinstance(prop_val, str):
        fn, idx = parse_ref(prop_val)
        _, v4 = load4d(fn)
        vv = np.asarray(v4[:, :, :, idx], dtype=np.float64).ravel(order='C')
        dd = dens.ravel(order='C')
        s = float(dd.sum())
        return float((dd * vv).sum() / s) if s > 0 else float(default)
    if isinstance(prop_val, dict):
        vol = _load_prop_map(prop_val, dens.shape, prop_name)
        dd = dens.ravel(order='C')
        vv = vol.ravel(order='C')
        s = float(dd.sum())
        return float((dd * vv).sum() / s) if s > 0 else float(default)
    return float(default)
tissues = {}
first = None
all_tissues = list(cfg.get('tissues', {}).values())
ref_shape = None
ref_aff = None
for n,t in cfg.get('tissues',{}).items():
    if first is None: first = t
    dfn,didx = parse_ref(t['density'])
    aff,d4 = load4d(dfn); dens = d4[:,:,:,didx]
    if ref_shape is None:
        ref_shape = dens.shape
        ref_aff = aff
    tissues[n] = {
        "density": make_vol(dens, aff),
        "db0": make_vol(resolve_vol(t.get('dB0', 0.0), dens, 'dB0'), aff),
        "t1": prop_scalar(t.get('T1', float('inf')), float('inf'), 'T1'),
        "t2": prop_scalar(t.get('T2', float('inf')), float('inf'), 'T2'),
        "t2dash": prop_scalar(t.get("T2'", float('inf')), float('inf'), "T2'"),
        "adc": prop_scalar(t.get('ADC', 0.0), 0.0, 'ADC'),
    }
b1_tx=[]; b1_rx=[]
def _first_nonempty_b1(key):
    # Prefer first non-empty tissue-level B1 list across all tissues.
    for tt in all_tissues:
        if not isinstance(tt, dict):
            continue
        vals = tt.get(key, None)
        if isinstance(vals, list) and len(vals) > 0:
            return vals
    return None
tx_vals = _first_nonempty_b1('B1+')
rx_vals = _first_nonempty_b1('B1-')
if tx_vals is None and first:
    tx_vals = first.get('B1+', [1.0])
if rx_vals is None and first:
    rx_vals = first.get('B1-', [1.0])
def b1_channel_vol(p, label):
    # B1 maps are global (not masked to one tissue); see nifti_phantom_v1 spec.
    if isinstance(p, (int, float)):
        return make_vol(np.ones(ref_shape, dtype=np.float64) * float(p), ref_aff)
    return make_vol(_load_prop_map(p, ref_shape, label), ref_aff)
for p in (tx_vals or [1.0]):
    b1_tx.append(b1_channel_vol(p, 'B1+'))
for p in (rx_vals or [1.0]):
    b1_rx.append(b1_channel_vol(p, 'B1-'))
# MR0SIM expects at least one TX map; keep parity with phantomlib-style defaults.
if len(b1_tx) == 0:
    b1_tx.append(make_vol(np.ones(ref_shape, dtype=np.float64), ref_aff))
# Also keep RX non-empty for robustness.
if len(b1_rx) == 0:
    b1_rx.append(make_vol(np.ones(ref_shape, dtype=np.float64), ref_aff))
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
     * @param {object} job — must include simulation.toolUrl (from _enqueueSimJob).
     */
    async runSimPipeline(job) {
        const nvMod = window.nvModule;
        const simToolUrl = job.simulation?.toolUrl || TOOL_RAPISIM;
        const simLogTag = this._jobSimLogTag(job);
        this._simPipelineJob = job;
        job.status = 'scanning';
        job.pipelineStage = 0;
        this.updateQueueUI();
        const _tPipeline = performance.now();
        try {
            // FOV contract: **Pulseq seq.definitions FOV** (m) is authoritative for physical size (mm).
            // Sequence must run *before* generateFovMaskNifti() so executeFunction can emit sequence_fov_dims
            // and the viewer FOV sliders update first; mask grid (mask X/Y/Z), offsets, rotation stay as in UI.
            // Resampling + PyNUFFT ref then match the same geometry the user sees after seq sync.
            // Ensure run_resampling / run_resampling_serial3d_to_4d are defined.
            await nvMod.initPyodide();
            const activeGroup = typeof nvMod.getActivePhantomGroup === 'function'
                ? nvMod.getActivePhantomGroup()
                : nvMod.volumeGroups?.find(g => g.volumes?.length && !String(g.jsonName || '').endsWith('_resampled') && !String(g.jsonName || '').endsWith('_averaged'));
            if (!activeGroup) throw new Error("No phantom group with JSON found. Load phantom via Add (json/nii) first.");

            const _tSeq = performance.now();
            const seqText = await nvMod.enqueuePyodideTask(job.id, "sim-seq", async () => {
                await nvMod._ensureNibabelReady();
                const _t0 = performance.now();
                const text = await this._prepareCurrentSeqForTools(job);
                console.log(`[SIM] _prepareCurrentSeqForTools: ${(performance.now() - _t0).toFixed(0)}ms, seqText ${(text.length / 1024).toFixed(1)}KB`);
                return text;
            });
            console.log(`[SIM] sim-seq: ${(performance.now() - _tSeq).toFixed(0)}ms`);

            job.fovSnapshot = nvMod.captureFovSnapshot();
            console.log(`[${simLogTag}] fovSnapshot:`, job.fovSnapshot);

            const phantomOversample = nvMod.getPhantomOversampleFactors();
            job.phantomOversample = phantomOversample;
            const phantomFovSnapshot = nvMod.applyPhantomOversampleToSnapshot(job.fovSnapshot, phantomOversample);
            const phantomMatrix = nvMod.getSimPhantomMatrixDims(phantomOversample);
            const reconMatrix = nvMod.getReconMatrixDims();
            const phantomRef = nvMod.generateFovMaskNiftiFromSnapshot(
                phantomFovSnapshot,
                phantomMatrix,
            );
            const reconRef = nvMod.generateFovMaskNiftiFromSnapshot(job.fovSnapshot, reconMatrix);

            try {
                await this._patchProtocolSimulationToml(job, {
                    phantomRef,
                    phantomMatrix,
                    reconMatrix,
                    phantomName: activeGroup.jsonName || activeGroup.jsonFileName || 'unknown',
                });
            } catch (tomlErr) {
                console.warn(`[${simLogTag}] protocol TOML simulation/recon patch failed:`, tomlErr);
            }

            // conseq (Fly) ∥ footprint resample + phantom convert (Pyodide queue)
            const _tParallelPrep = performance.now();
            const [conseqSettled, phantomSettled] = await Promise.allSettled([
                this._callTool(
                    TOOL_CONSEQ,
                    { Dict: { seq_file: { Str: seqText }, exact_trajectory: { Bool: false } } },
                    'conseq',
                ),
                nvMod.enqueuePyodideTask(job.id, "sim-phantom", () =>
                    this._simPhantomResampleAndConvert(nvMod, job, activeGroup, phantomRef, simLogTag),
                ),
            ]);
            const prepLegs = [
                { label: 'conseq', settled: conseqSettled },
                { label: 'phantom resample', settled: phantomSettled },
            ];
            const prepFail = prepLegs.filter((leg) =>
                leg.settled.status === 'rejected' || this._toolErrorMessage(leg.settled.value),
            );
            if (prepFail.length) {
                throw new Error(this._parallelStageError('Prepare (conseq ∥ resample)', prepLegs));
            }
            const seq = this._assertToolOk('conseq', conseqSettled.value);
            const phantomPayload = phantomSettled.value;
            console.log(`[SIM] conseq ∥ phantom resample: ${(performance.now() - _tParallelPrep).toFixed(0)}ms`);
            this._setPipelineStage(job, 1);

            const ev = seq?.TypedList?.InstantSeqEvent;
            const events = ev
                ? { TypedList: { InstantSeqEvent: ev } }
                : seq;
            const phantomForSim = this._encodeSegmentedPhantomForToolapi(phantomPayload);
            const simChannel = String(simToolUrl || '').includes('rapisim') ? 'rapisim' : 'mr0sim';

            // trajex ∥ sim (after conseq + phantom; recon needs both)
            this._setPipelineStage(job, 2);
            const _tParallelSim = performance.now();
            const [trajSettled, simSettled] = await Promise.allSettled([
                this._callTool(
                    TOOL_TRAJEX,
                    { Dict: { sequence: events, t1: { Float: 1.0 }, t2: { Float: 0.1 }, min_mag: { Float: 0.001 } } },
                    'trajex',
                ),
                this._callTool(
                    simToolUrl,
                    { Dict: { sequence: seq, phantom: phantomForSim } },
                    simChannel,
                ),
            ]);
            const simLegs = [
                { label: 'trajex', settled: trajSettled },
                { label: simChannel, settled: simSettled },
            ];
            const simFail = simLegs.filter((leg) =>
                leg.settled.status === 'rejected' || this._toolErrorMessage(leg.settled.value),
            );
            if (simFail.length) {
                throw new Error(this._parallelStageError('Simulate (trajex ∥ sim)', simLegs));
            }
            const trajResult = trajSettled.value;
            const signalResult = simSettled.value;
            console.log(`[SIM] trajex ∥ ${simChannel}: ${(performance.now() - _tParallelSim).toFixed(0)}ms`);

            const traj = this._trajectoryFromResult(trajResult);
            const signal = this._signalFromResult(signalResult);
            if (!traj?.length) {
                throw new Error(`${simLogTag}: trajex returned no trajectory (k-space path empty).`);
            }
            if (!signal?.length) {
                throw new Error(`${simLogTag}: ${simChannel} returned no signal.`);
            }
            this._setPipelineStage(job, 3);

            // 5) PyNUFFT recon: reconRef was built up-front from the same frozen fovSnapshot as
            // the phantom ref (step 2); no late re-read of the live FOV sliders here.

            // 6) Recon or k-space debug (scan_zero/recon.py run_sim_recon)
            const useRecon = typeof nvMod.isScanReconEnabled === 'function'
                ? nvMod.isScanReconEnabled()
                : nvMod.scanRecon?.checked !== false;
            const _t6 = performance.now();
            const simBackend = job.simulation?.reconBackend
                || (String(simToolUrl || '').includes('rapisim') ? 'rapisim' : 'mr0');
            const recoOutPath = typeof nvMod.simReconOutPath === "function"
                ? nvMod.simReconOutPath(job.id)
                : "/tmp/__sim_pipeline_reco.nii";
            const recoBytes = await nvMod.enqueuePyodideTask(job.id, "sim-recon", async () => {
                await nvMod.pyodide.loadPackage(["micropip"]);
                await nvMod.pyodide.runPythonAsync(`
import micropip
try:
    import pynufft  # noqa
except Exception:
    await micropip.install('pynufft')
                `);
                await this._ensureSimReconPy(nvMod);
                nvMod.pyodide.globals.set("sim_signal_pairs", signal);
                nvMod.pyodide.globals.set("sim_traj_points", traj || []);
                nvMod.pyodide.globals.set("sim_ref_bytes", reconRef);
                nvMod.pyodide.globals.set("sim_output_mode", useRecon ? "image" : "kspace_log");
                nvMod.pyodide.globals.set("sim_seq_path", job.vfsSeqPath || "");
                nvMod.pyodide.globals.set("sim_backend", simBackend);
                nvMod.pyodide.globals.set("sim_reco_out_path", recoOutPath);
                const recoPathRes = await nvMod.pyodide.runPythonAsync(`
import types
_matrix = None
_seq_path = sim_seq_path.to_py() if hasattr(sim_seq_path, 'to_py') else sim_seq_path
if _seq_path:
    try:
        import os
        import pypulseq as pp
        _p = str(_seq_path)
        if os.path.exists(_p):
            _seq = pp.Sequence()
            _seq.read(_p)
            _m = _seq.get_definition('matrix')
            if _m is not None:
                _matrix = [int(_m[0]), int(_m[1]), int(_m[2]) if len(_m) > 2 else 1]
    except Exception:
        pass
_src = sim_recon_py_source.to_py() if hasattr(sim_recon_py_source, 'to_py') else str(sim_recon_py_source)
if "output_mode" not in _src:
    raise RuntimeError("sim_recon_py_source is stale (missing output_mode)")
_recon = types.ModuleType("_scan_recon_live")
_recon.__dict__["__file__"] = "/scan_zero/recon.py"
exec(compile(_src, "/scan_zero/recon.py", "exec"), _recon.__dict__)
_backend = sim_backend.to_py() if hasattr(sim_backend, 'to_py') else str(sim_backend)
_out = sim_reco_out_path.to_py() if hasattr(sim_reco_out_path, 'to_py') else str(sim_reco_out_path)
_recon.run_sim_recon(
    sim_signal_pairs,
    sim_traj_points,
    sim_ref_bytes,
    out_path=_out,
    output_mode=sim_output_mode,
    matrix=_matrix,
    sim_backend=_backend,
)
                `);
                const recoPath = (recoPathRes && recoPathRes.toJs) ? recoPathRes.toJs() : recoPathRes;
                if (recoPathRes?.destroy) recoPathRes.destroy();
                const path = String(recoPath || recoOutPath);
                const bytes = nvMod.pyodide.FS.readFile(path);
                try { nvMod.pyodide.FS.unlink(path); } catch (_) {}
                return bytes;
            });
            console.log(`[SIM] ${useRecon ? 'PyNUFFT recon' : 'k-space log'}: ${(performance.now()-_t6).toFixed(0)}ms`);
            this._setPipelineStage(job, 4);

            // 7) show in Niivue (scan-like naming/path)
            job.niftiUrl = URL.createObjectURL(new Blob([recoBytes], { type: "application/octet-stream" }));
            job.seqUrl = URL.createObjectURL(new Blob([seqText], { type: "text/plain" }));
            job.status = 'done';
            console.log(`[SIM] *** TOTAL pipeline: ${(performance.now()-_tPipeline).toFixed(0)}ms ***`);
            // Auto-load: don't resync FOV — preserve any in-progress FOV planning the user is doing
            // for the next scan. Explicit VIEW SCAN clicks still sync (default `syncFov=true`).
            this.loadJob(job.id, false);
        } catch (e) {
            console.error(`[${simLogTag}] failed:`, e);
            job.status = 'error';
            job.error = typeof nvMod?.formatPyodideError === "function"
                ? nvMod.formatPyodideError(e)
                : (e.message || String(e));
        } finally {
            this._simPipelineJob = null;
        }
        this.updateQueueUI();
    }

    /** 0=⅛ queued; stages 1–4 advance when conseq/trajex/sim/recon each finish */
    _setPipelineStage(job, stage) {
        if (!job) return;
        const s = Math.max(0, Math.min(4, Number(stage) || 0));
        job.pipelineStage = s;
        const el = this.container?.querySelector(`.queue-item[data-id="${job.id}"] .scan-pipeline-progress`);
        if (el) {
            el.style.setProperty('--stage', s);
            el.dataset.stage = String(s);
            const label = PIPELINE_STAGES[s];
            el.title = label;
            el.setAttribute('aria-valuenow', String(s));
            el.setAttribute('aria-label', label);
        } else {
            this.updateQueueUI();
        }
        if (job.status === 'scanning') this._syncMobileScanControls();
    }

    _pipelineProgressHtml(stage = 0, crop = false) {
        const s = Math.max(0, Math.min(4, Number(stage) || 0));
        const label = crop ? 'crop' : PIPELINE_STAGES[s];
        return `<div class="scan-pipeline-progress${crop ? ' is-crop' : ''}" style="--stage:${s}" data-stage="${s}" title="${label}" role="progressbar" aria-valuemin="0" aria-valuemax="4" aria-valuenow="${s}" aria-label="${label}"></div>`;
    }

    updateQueueUI() {
        if (!this.container) return;
        const list = this.container.querySelector('#scan-queue-list');
        if (!list) return;

        const focusedDraft = list.querySelector('.draft-name-input:focus');
        const draftSelStart = focusedDraft?.selectionStart;
        const draftSelEnd = focusedDraft?.selectionEnd;
        const draftInputValue = focusedDraft?.value;

        if (this.queue.length === 0 && !this.draftJob) {
            list.innerHTML = '<div class="queue-empty">Queue is empty</div>';
            this._syncMobileScanControls();
            return;
        }

        let html = this.draftJob ? this._draftRowHtml() : '';
        html += this.queue.map(job => `
            <div class="queue-item status-${job.status}" data-id="${job.id}">
                <div class="item-main">
                    <div class="item-title">${job.scanNumber}. ${job.name}</div>
                    <div class="item-meta">${this._escapeHtml(this._jobMetaLine(job))}</div>
                </div>
                <div class="item-actions">
                    ${job.status === 'scanning'
                        ? this._pipelineProgressHtml(job.pipelineStage ?? 0, !!job.cropOnly)
                        : ''}
                    ${job.status === 'done' ? `
                        <div class="action-row">
                            <button class="view-btn" title="View on main + preview (B). Ctrl+click: compare pane (C).">VIEW SCAN</button>
                            ${job.cropOnly ? '' : '<button class="view-seq-btn">VIEW SEQ</button>'}
                        </div>
                        <div class="action-row small-btns">
                            ${job.cropOnly ? '' : '<button class="dl-seq-btn" title="Download .seq file"><i class="bi bi-download" aria-hidden="true"></i></button>'}
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
        list.innerHTML = html;

        this._bindDraftNameInput(list);
        if (focusedDraft && draftInputValue !== undefined) {
            const newInput = list.querySelector('.draft-name-input');
            if (newInput) {
                newInput.value = draftInputValue;
                if (this.draftJob) this.draftJob.userName = draftInputValue;
                newInput.focus();
                try {
                    newInput.setSelectionRange(draftSelStart, draftSelEnd);
                } catch (_) {}
            }
        }

        this._bindQueueItemActions(list);
        this._syncMobileScanControls();
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

    /**
     * Focus a completed job's scan volume.
     * @param {string} jobId
     * @param {boolean} [syncFov=true] Whether to also sync the FOV sliders/mesh from the scan's affine.
     *   Default `true` matches the old behavior (explicit **VIEW SCAN** click expects the FOV box to
     *   follow the scan). Auto-load right after completion passes `false` so the user's in-progress
     *   FOV planning (slice positioning for the next scan) is preserved.
     */
    /** Ctrl+VIEW SCAN: lazy compare pane C only (does not change B selection). */
    async loadJobToCompare(jobId) {
        const job = this.queue.find(j => j.id === jobId);
        if (job?.status === 'done' && window.scanCompare) {
            await window.scanCompare.loadFromJob(job);
        }
    }

    /** Match a loaded scan NIfTI volume to its queue job (by baseName). */
    getJobForVolume(vol) {
        if (!vol?.name?.startsWith('scan_')) return null;
        const base = vol.name.replace(/\.nii(\.gz)?$/i, '');
        return this.queue.find((j) => j.baseName === base) || null;
    }

    /** Volume list / preview overlay title, e.g. `1. gre_seq`. */
    getScanDisplayTitle(vol) {
        if (!vol?.name) return '';
        return formatScanDisplayTitle(vol.name, this.getJobForVolume(vol));
    }

    /** Native tooltip: full protocol parameters for a scan volume row. */
    getProtocolTooltipForVolume(vol) {
        const explorer = window.seqExplorer;
        if (!explorer) return null;
        const job = this.getJobForVolume(vol);
        const protocolPath = job?.protocolPath
            || (job?.scanNumber != null ? explorer.findProtocolPathForScanNumber(job.scanNumber) : null)
            || (() => {
                const m = vol?.name?.match(/^scan_(\d+)_/);
                return m ? explorer.findProtocolPathForScanNumber(m[1]) : null;
            })();
        if (!protocolPath) return null;
        return explorer.formatProtocolTooltip(protocolPath);
    }

    async loadJob(jobId, syncFov = true) {
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
                // 2. Load if not found.
                // Pass `syncFovOnScan=syncFov` so auto-load (`syncFov=false`) does NOT let
                // `loadUrl` internally overwrite the user's in-progress FOV planning.
                console.log("ScanModule: Loading NIfTI for the first time:", targetName);
                await nvMod.loadUrl(job.niftiUrl, targetName, true, syncFov);
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

                // Match volume-list scan click: FOV box from this scan's NIfTI (CROP + SIM).
                // Skipped on auto-load after scan completion (`syncFov=false`) so the user's
                // in-progress FOV planning for the next scan is not overwritten.
                if (syncFov && typeof nvMod.syncFovFromScanVolume === 'function') {
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
                const plotContainer = plotRoot.querySelector('#seq-mpl-actual-target');

                // 3. Run Python to read and plot the specific .seq file (ChartGPU or matplotlib per selector)
                const py = window.nvModule.pyodide;
                if (py) {
                    const plotSpeed =
                        plotRoot.querySelector('#seq-plot-speed-selector')?.value ||
                        SequenceExplorer.DEFAULT_PLOT_SPEED;
                    const plotBlock =
                        plotSpeed === 'chartgpu'
                            ? `        seq.plot(plot_now=False, plot_speed="chartgpu")`
                            : `        seq.plot(plot_now=False, plot_speed="${plotSpeed}")
        plt.show()`;
                    void (async () => {
                        try {
                            if (plotContainer) {
                                await explorer.disposeSeqChartGpu();
                                plotContainer.innerHTML = '';
                                document.pyodideMplTarget = plotContainer;
                                window.pyodideMplTarget = plotContainer;
                            }
                            await py.runPythonAsync(`
import pypulseq as pp
import matplotlib.pyplot as plt
import sys
import os

if hasattr(sys, '_pp_patch_func'):
    sys._pp_patch_func()

plt.close('all')
seq = pp.Sequence()
try:
    path = '${job.vfsSeqPath}'
    print(f"Loading sequence from: {path}")
    if os.path.exists(path):
        seq.read(path)
${plotBlock}
        print("Sequence plot complete.")
    else:
        print(f"Error: File {path} not found in VFS")
except Exception as e:
    print(f"Error reading/plotting seq file: {e}")
                            `);
                            if (plotSpeed === 'chartgpu' && plotContainer) {
                                await explorer.renderSeqChartGpuAfterPlot(plotRoot, py, plotContainer);
                            }
                        } catch (e) {
                            console.error('viewSeq plot failed:', e);
                            try {
                                await explorer.disposeSeqChartGpu();
                            } catch (_) {
                                /* ignore */
                            }
                        }
                    })();
                }
            }
        }
    }
}
