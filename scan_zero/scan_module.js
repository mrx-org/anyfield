import { eventHub } from '../event_hub.js';
import { SequenceExplorer } from '../pypulseq/seq_explorer.js';
import { phantomFolderId } from './bifti_cache.js';
import {
    DEFAULT_SIM_BACKEND_ID,
    SIM_BACKENDS,
    SIM_BACKEND_OPTIONS,
    formatSimBackendLabel,
} from './sim_backends.js';

/** toolapi-wasm WebSocket URLs (same path `/tool`, different host). */
export const TOOL_CONSEQ = 'wss://tool-conseq.fly.dev/tool';
export const TOOL_TRAJEX = 'wss://tool-trajex.fly.dev/tool';
export const TOOL_RAPISIM = 'wss://tool-rapisim.fly.dev/tool';
export const TOOL_MR0SIM = 'wss://tool-mr0sim.fly.dev/tool';
export const TOOL_MR0SIM_T4 = 'wss://mzaiss--tool-mr0sim-modal-serve-t4.modal.run/tool';
/** Modal HTTP gateway (tool-mr0sim-modal_http); worker chosen per job (`cpu` / `t4` / `a10g` / `a100`). */
export const TOOL_MR0SIM_HTTP_MODAL =
    'https://mzaiss--tool-mr0sim-modal-http-gateway.modal.run';
/** Local dev only — set `window.ANYFIELD_HTTP_SIM_URL` to this to use local server. */
export const TOOL_MR0SIM_HTTP = 'http://127.0.0.1:8080';

export {
    DEFAULT_SIM_BACKEND_ID,
    SIM_BACKENDS,
    SIM_BACKEND_OPTIONS,
    formatSimBackendLabel,
} from './sim_backends.js';

function defaultHttpSimBaseUrl() {
    if (typeof window !== 'undefined' && window.ANYFIELD_HTTP_SIM_URL) {
        return String(window.ANYFIELD_HTTP_SIM_URL).replace(/\/$/, '');
    }
    return TOOL_MR0SIM_HTTP_MODAL;
}

const TOOL_FLY_HOSTS = [TOOL_CONSEQ, TOOL_TRAJEX, TOOL_RAPISIM, TOOL_MR0SIM].map(
    (url) => new URL(url).hostname,
);

const PIPELINE_STAGES = ['prep', 'conseq', 'trajex', 'sim', 'recon'];

/** Ring fill angles (deg): stages 1+2 → 60; sim 60–315; recon 315–330 */
const PIPELINE_DEG = {
    prep: 15,
    conseq: 30,
    trajex: 60,
    simStart: 60,
    simSpan: 255,
    reconEnd: 330,
};

/** Map pipeline stage + optional sim fraction to ring fill angle. */
function pipelineProgressDeg(stage, simProgress = 0, reconDone = false) {
    const s = Math.max(0, Math.min(4, Number(stage) || 0));
    const sim = Math.max(0, Math.min(1, Number(simProgress) || 0));
    if (s >= 4) {
        return reconDone
            ? PIPELINE_DEG.reconEnd
            : PIPELINE_DEG.simStart + PIPELINE_DEG.simSpan;
    }
    if (s >= 3) return PIPELINE_DEG.simStart + sim * PIPELINE_DEG.simSpan;
    if (s >= 2) return PIPELINE_DEG.trajex;
    if (s >= 1) return PIPELINE_DEG.conseq;
    return PIPELINE_DEG.prep;
}

/** Weight bands within the sim arc (fraction 0–1 of 60°–315°). */
const SIM_PROGRESS_BANDS = {
    scan: [0.0, 0.15],
    build: [0.15, 0.42],
    phantom: [0.42, 0.52],
    exec: [0.52, 0.98],
};

function simBandFrac(band, local) {
    const [lo, hi] = SIM_PROGRESS_BANDS[band] || [0, 1];
    const t = Math.max(0, Math.min(1, Number(local) || 0));
    return lo + t * (hi - lo);
}

/**
 * Map mr0sim progress strings to [0, 1] over the sim arc.
 * Handles batched "scanned N/M events", "built N/M repetitions", etc.
 */
function parseMr0SimProgressMessage(msg) {
    const s = String(msg || '').trim();
    if (!s) return null;

    let m = s.match(/scanned\s+(\d+)\s*\/\s*(\d+)\s+events/i);
    if (m) {
        const den = parseInt(m[2], 10);
        if (den > 0) return simBandFrac('scan', parseInt(m[1], 10) / den);
    }

    m = s.match(/built\s+(\d+)\s*\/\s*(\d+)\s+repetitions/i);
    if (m) {
        const den = parseInt(m[2], 10);
        if (den > 0) return simBandFrac('build', parseInt(m[1], 10) / den);
    }

    if (/building\s+\d+\s+repetitions/i.test(s)) return simBandFrac('build', 0);

    if (/convert seq:\s*done/i.test(s)) return simBandFrac('build', 1);

    if (/Converting Phantom|convert phantom/i.test(s)) return simBandFrac('phantom', 0);
    if (/pd\s*=\s*torch\.Size/i.test(s)) return simBandFrac('phantom', 0.6);

    if (/Simulating signal/i.test(s)) return { frac: simBandFrac('exec', 0), indeterminate: true };
    if (/execute_graph/i.test(s)) return { frac: simBandFrac('exec', 0.85), indeterminate: false };

    m = s.match(/(\d+(?:\.\d+)?)\s*%/);
    if (m) return Math.min(1, Math.max(0, parseFloat(m[1]) / 100));

    m = s.match(/(\d+)\s*\/\s*(\d+)/);
    if (m) {
        const den = parseInt(m[2], 10);
        if (den > 0) return simBandFrac('exec', parseInt(m[1], 10) / den);
    }

    return null;
}

/** Max concurrent toolapi WebSocket calls (global across queued SCAN jobs). */
const MAX_CONCURRENT_TOOL_WS = 2;

/** HTTP (Modal) job reaper tuning — poll many in-flight jobs at once, retry transient failures. */
const HTTP_POLL_MS = 2000;
/** Consecutive poll failures tolerated before an in-flight HTTP job is marked failed. */
const HTTP_POLL_MAX_FAILS = 6;
/** Network retry attempts for submit / status / result fetches (handles Modal cold starts). */
const HTTP_FETCH_RETRIES = 4;
/** Per-request timeouts (ms). Submit carries the .seq upload; status is tiny; result is the NPZ. */
const HTTP_SUBMIT_TIMEOUT_MS = 90000;
const HTTP_STATUS_TIMEOUT_MS = 20000;
const HTTP_RESULT_TIMEOUT_MS = 120000;
/** HTTP statuses worth retrying (transient gateway / overload / cold start). */
const HTTP_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Stable recon method tag stored in protocol TOML `[recon]`. */
export const RECON_METHOD = 'anyfield-pynufft';

/**
 * Scan index from a loaded scan NIfTI name, e.g. `scan_18_foo.nii.gz` → 18.
 */
export function parseScanNumberFromVolumeName(volName) {
    const m = String(volName || '').match(/^scan_(\d+)(?:_|\.)/i);
    return m ? Number(m[1]) : null;
}

/**
 * Human scan title from protocol file for scan N, e.g. `18. prot_TSE_2D_FLAIR`.
 * Falls back to queue draft name or volume filename when no protocol exists yet.
 */
export function formatScanDisplayTitle(volName, job = null) {
    if (job?.cropOnly && job.scanNumber != null) {
        return `${job.scanNumber}. crop`;
    }
    const n = job?.scanNumber ?? parseScanNumberFromVolumeName(volName);
    if (n != null && typeof window !== 'undefined' && window.seqExplorer?.getProtocolDisplayNameForScanNumber) {
        const fromProtocol = window.seqExplorer.getProtocolDisplayNameForScanNumber(n);
        if (fromProtocol) return fromProtocol;
    }
    if (job?.scanNumber != null && job?.name) {
        return `${job.scanNumber}. ${job.name}`;
    }
    const m = String(volName || '').match(/^scan_(\d+)_(.*)\.nii(\.gz)?$/i);
    if (m) {
        return `${m[1]}. ${m[2].replace(/\.nii.*/, '')}`;
    }
    return String(volName || '').replace(/\.nii(\.gz)?$/i, '');
}

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
        this._selectedSimBackendId = DEFAULT_SIM_BACKEND_ID;

        this.setupEventListeners();
    }

    getSelectedSimBackendId() {
        const id = this._selectedSimBackendId || DEFAULT_SIM_BACKEND_ID;
        return SIM_BACKENDS[id] ? id : DEFAULT_SIM_BACKEND_ID;
    }

    setSelectedSimBackendId(backendId) {
        const id = String(backendId || '').trim();
        if (!SIM_BACKENDS[id]) throw new Error(`Unknown sim backend: ${backendId}`);
        this._selectedSimBackendId = id;
        this._syncScanControlLabels();
    }

    _syncScanControlLabels() {
        const title = `Run scan (${formatSimBackendLabel(this.getSelectedSimBackendId())})`;
        for (const sel of ['#btn-start-scan', '#seq-mobile-scan']) {
            const btn = document.querySelector(sel);
            if (btn) btn.title = title;
        }
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
        const explorer = window.seqExplorer;
        const path = String(seq?.source?.path || seq?.fileName || '').replace(/\\/g, '/');
        const isProtocol = seq?.source?.itemKind === 'protocol' || path.startsWith('user/prot/');
        if (isProtocol && explorer?.protocolDerivedDefaultName) {
            const derived = explorer.protocolDerivedDefaultName(path);
            if (derived) return derived;
        }
        // Strip any leading "N. " scan-number prefix so the editable name doesn't carry the
        // queue number (that is shown separately) and doesn't leak into output filenames.
        const raw = (seq?.displayName || seq?.name || 'Untitled').trim();
        return raw.replace(/^\s*\d+\.\s*/, '').trim() || 'Untitled';
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
            .replace(/^\s*\d+\.\s*/, '')      // drop leading "N. " scan-number prefix
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

    _escapeAttr(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/\n/g, '&#10;');
    }

    _jobErrorTooltip(job) {
        if (job?.status !== 'error') return '';
        return job.errorDetail || job.error || 'error';
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

        list.querySelectorAll('.cancel-sim-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const jobId = btn.closest('.queue-item').dataset.id;
                this.cancelSim(jobId);
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
                <div class="scan-header scan-header-row">
                    ${isProUser() ? `
                    <button id="btn-start-crop" class="scan-btn scan-btn-secondary" title="Resample first volume to FOV (crop to box)">
                        CROP
                    </button>
                    ` : ''}
                    <button id="btn-start-scan" class="scan-btn scan-btn-primary" title="Run scan">
                        SCAN<span class="icon">▶</span>
                    </button>
                    ${isProUser() ? `
                    <button id="btn-scan-settings" type="button" class="scan-btn scan-btn-settings" title="Simulation backend" aria-label="Simulation backend">
                        <i class="bi bi-gear" aria-hidden="true"></i>
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
        this.container.querySelector('#btn-start-scan').onclick = () => this.startScan();
        const settingsBtn = this.container.querySelector('#btn-scan-settings');
        if (settingsBtn) settingsBtn.onclick = () => this.openSimSettingsDialog();

        // Make this instance available globally for UI callbacks if needed
        window.scanModule = this;
        this._syncScanControlLabels();
        this._syncMobileScanControls();
    }

    openSimSettingsDialog() {
        if (!isProUser()) return;

        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            z-index: 10001;
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        const dialogContent = document.createElement('div');
        dialogContent.style.cssText = `
            background: var(--bg, #1e1e1e);
            border: 1px solid var(--border, #333);
            border-radius: 8px;
            padding: 1.5rem;
            min-width: 500px;
            max-width: 600px;
            max-height: 80vh;
            display: flex;
            flex-direction: column;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
        `;

        const dialogTitle = document.createElement('h3');
        dialogTitle.textContent = 'Simulation backend';
        dialogTitle.style.cssText = 'margin: 0 0 1rem 0; color: var(--accent, #4a9eff);';

        const optionsWrap = document.createElement('div');
        optionsWrap.style.cssText = `
            display: flex;
            flex-direction: column;
            gap: 0.65rem;
            margin-bottom: 1.25rem;
        `;

        const selectedId = this.getSelectedSimBackendId();
        const radioName = `sim-backend-${Date.now()}`;
        for (const opt of SIM_BACKEND_OPTIONS) {
            const row = document.createElement('label');
            row.style.cssText = `
                display: flex;
                align-items: center;
                gap: 0.6rem;
                padding: 0.45rem 0.55rem;
                border-radius: 4px;
                cursor: pointer;
                color: var(--text, #ddd);
                font-size: 0.9rem;
            `;
            row.addEventListener('mouseenter', () => {
                row.style.background = 'rgba(255, 255, 255, 0.06)';
            });
            row.addEventListener('mouseleave', () => {
                row.style.background = 'transparent';
            });

            const input = document.createElement('input');
            input.type = 'radio';
            input.name = radioName;
            input.value = opt.id;
            input.checked = opt.id === selectedId;
            input.style.cssText = 'accent-color: var(--accent, #4a9eff);';

            const text = document.createElement('span');
            text.textContent = opt.label;

            row.appendChild(input);
            row.appendChild(text);
            optionsWrap.appendChild(row);
        }

        const buttonRow = document.createElement('div');
        buttonRow.style.cssText = 'display: flex; justify-content: flex-end; gap: 0.5rem;';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.className = 'btn btn-secondary btn-md';

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.textContent = 'Save';
        saveBtn.className = 'btn btn-secondary btn-md seq-btn-primary';

        const close = () => overlay.remove();
        cancelBtn.onclick = close;
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close();
        });
        saveBtn.onclick = () => {
            const picked = optionsWrap.querySelector(`input[name="${radioName}"]:checked`);
            if (picked?.value) this.setSelectedSimBackendId(picked.value);
            close();
        };

        buttonRow.appendChild(cancelBtn);
        buttonRow.appendChild(saveBtn);
        dialogContent.appendChild(dialogTitle);
        dialogContent.appendChild(optionsWrap);
        dialogContent.appendChild(buttonRow);
        overlay.appendChild(dialogContent);
        document.body.appendChild(overlay);
    }

    _getActiveScanJob() {
        return this.queue.find((j) => j.status === 'scanning') || null;
    }

    /**
     * Disable buttons that call Pyodide *outside* the task queue (plot seq, Get FOV, CROP) while any
     * scan is in flight. Their direct `executeFunction` / resample calls would otherwise race the
     * background recon for the single-threaded Pyodide interpreter. SCAN stays enabled — its prep is
     * routed through `enqueuePyodideTask`, so rapid scanning is safe.
     */
    _syncScanBusyUi() {
        const busy = this.queue.some((j) => j.status === 'scanning');
        const selectors = [
            '#seq-execute-btn',
            '#seq-get-fov-btn',
            '#btn-start-crop',
            '#seq-mobile-crop',
        ];
        for (const sel of selectors) {
            document.querySelectorAll(sel).forEach((btn) => {
                btn.disabled = busy;
                btn.classList.toggle('is-pyodide-busy', busy);
            });
        }
    }

    _syncMobileScanControls() {
        this._syncScanBusyUi();
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
        let ring = statusSlot.querySelector('.scan-pipeline-progress');
        if (!ring) {
            statusSlot.innerHTML = this._pipelineProgressHtml(active);
            ring = statusSlot.querySelector('.scan-pipeline-progress');
        }
        if (ring) this._applyPipelineRing(ring, active);
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
                useGpu: backend.useGpu === true,
                transport: backend.transport || 'ws',
                httpBaseUrl: backend.httpBaseUrl || null,
                worker: backend.worker || null,
                exactTrajectories: backend.exactTrajectories === true,
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

    async startScan(backendId = null) {
        const resolvedId = backendId || this.getSelectedSimBackendId();
        const backend = SIM_BACKENDS[resolvedId];
        if (!backend) throw new Error(`Unknown sim backend: ${resolvedId}`);
        if (backend.proOnly && !isProUser()) {
            alert('This simulation backend is available in pro mode only.');
            return;
        }
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
        const job = this._enqueueSimJob({ backendId: resolvedId, userName });
        if (backend.transport === 'http') {
            // Phase 1 model: await only prep + submit (reads live UI in order, freezes per-job
            // seq + FOV), then poll + recon run in the background so many scans overlap on the
            // Modal worker pool. See runHttpSimPipeline → _httpPrepareAndSubmit + _pumpHttpReaper.
            await this._httpPrepareAndSubmit(job);
            void this._pumpHttpReaper();
        } else {
            await this.runSimPipeline(job);
        }
    }

    async startSimFast() {
        return this.startScan('modal_http_t4');
    }

    async startSimModalCpu() {
        return this.startScan('modal_http_cpu');
    }

    async startSimMr0() {
        return this.startScan('mr0sim');
    }

    async startSimHttp() {
        return this.startScan('modal_http');
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
        const { default: init, call } = await import('https://unpkg.com/toolapi@0.5.2/toolapi.js');
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

    /** Progress callback for mr0sim/rapisim; return false to abort the server sim. */
    _simOnMessage(job, channel) {
        const tag = this._jobSimLogTag(job);
        const ch = channel || 'sim';
        return (msg) => {
            if (job.abortSim) return false;
            console.log(`${tag} [${ch}]`, msg);
            if ((job.pipelineStage ?? 0) < 3) return true;

            const parsed = parseMr0SimProgressMessage(msg);
            if (parsed == null) return true;

            const frac = typeof parsed === 'object' ? parsed.frac : parsed;
            const indeterminate = typeof parsed === 'object' && parsed.indeterminate;
            if (indeterminate) job._simIndeterminate = true;
            if (indeterminate === false) job._simIndeterminate = false;

            job.simProgressTarget = Math.max(job.simProgressTarget ?? 0, frac);
            job.simProgress = job.simProgressTarget;
            this._ensureSimProgressAnimator(job);
            return true;
        };
    }

    _simProgressForDisplay(job) {
        return job?.simDisplayProgress ?? job?.simProgressTarget ?? job?.simProgress ?? 0;
    }

    _stopSimProgressAnimator(job) {
        if (!job) return;
        if (job._simProgressAnimId) {
            cancelAnimationFrame(job._simProgressAnimId);
            job._simProgressAnimId = null;
        }
        job._simIndeterminate = false;
    }

    _ensureSimProgressAnimator(job) {
        if (!job || job._simProgressAnimId) return;
        job.simDisplayProgress = job.simDisplayProgress ?? 0;
        job.simProgressTarget = job.simProgressTarget ?? 0;

        const tick = () => {
            job._simProgressAnimId = null;
            if ((job.pipelineStage ?? 0) !== 3 || job.status !== 'scanning') {
                return;
            }

            let target = job.simProgressTarget ?? 0;
            if (job._simIndeterminate && target < SIM_PROGRESS_BANDS.exec[1] - 0.02) {
                target = Math.min(SIM_PROGRESS_BANDS.exec[1] - 0.02, target + 0.0012);
                job.simProgressTarget = target;
            }

            let display = job.simDisplayProgress ?? 0;
            const delta = target - display;
            if (Math.abs(delta) > 0.00005) {
                const step = Math.sign(delta) * Math.min(Math.abs(delta), 0.018);
                display = Math.max(0, Math.min(1, display + step));
                job.simDisplayProgress = display;
                job.simProgress = display;
                for (const el of this._pipelineRingElements(job)) {
                    this._applyPipelineRing(el, job);
                }
            }

            if (Math.abs((job.simProgressTarget ?? 0) - display) > 0.00005 || job._simIndeterminate) {
                job._simProgressAnimId = requestAnimationFrame(tick);
            }
        };
        job._simProgressAnimId = requestAnimationFrame(tick);
    }

    _pipelineRingLabel(job) {
        if (job?.cropOnly) return 'crop';
        const s = job?.pipelineStage ?? 0;
        if (s >= 3 && s < 4) {
            const pct = Math.round(this._simProgressForDisplay(job) * 100);
            return pct > 0 && pct < 100 ? `sim ${pct}%` : PIPELINE_STAGES[s];
        }
        return PIPELINE_STAGES[s] || 'prep';
    }

    _applyPipelineRing(el, job) {
        if (!el || !job) return;
        const s = job.pipelineStage ?? 0;
        const simFrac = s >= 3 && s < 4 ? this._simProgressForDisplay(job) : (job.simProgress ?? 0);
        const deg = pipelineProgressDeg(s, simFrac, !!job.reconDone);
        const crop = !!job.cropOnly;
        const label = this._pipelineRingLabel(job);
        el.style.setProperty('--progress-deg', `${deg}deg`);
        el.dataset.stage = String(s);
        el.dataset.simProgress = String(simFrac);
        el.classList.toggle('is-crop', crop);
        el.classList.toggle('is-sim-running', s === 3 && job.status === 'scanning');
        el.title = label;
        el.setAttribute('aria-valuenow', String(Math.round(deg)));
        el.setAttribute('aria-valuemax', '330');
        el.setAttribute('aria-label', label);
    }

    _pipelineRingElements(job) {
        if (!job?.id) return [];
        const els = [];
        const queueEl = this.container?.querySelector(
            `.queue-item[data-id="${job.id}"] .scan-pipeline-progress`,
        );
        if (queueEl) els.push(queueEl);
        const mobileEl = document.querySelector('#seq-mobile-pipeline-status .scan-pipeline-progress');
        const active = this._getActiveScanJob();
        if (active?.id === job.id && mobileEl) els.push(mobileEl);
        return els;
    }

    _schedulePipelineRingUpdate(job) {
        if (!job) return;
        for (const el of this._pipelineRingElements(job)) {
            this._applyPipelineRing(el, job);
        }
        if (job.status === 'scanning') this._syncMobileScanControls();
    }

    /** mr0sim/rapisim call; abort via onMessage returning false when job.abortSim is set. */
    async _callToolSim(url, input, channel, job) {
        return await this._callTool(url, input, channel, this._simOnMessage(job, channel));
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
     * @param {Function|null} [onMessage] — optional progress callback; default logs only.
     */
    async _callTool(url, input, channel, onMessage = null) {
        await this._acquireToolSlot();
        const call = await this._ensureToolApi();
        const label = channel || this._toolChannelFromUrl(url);
        console.log(`${this._simPipelineJob ? this._jobSimLogTag(this._simPipelineJob) : 'SIM'} [${label}] ws open → ${url}`);
        try {
            return await call(url, input, onMessage || this._toolOnMessageFor(label));
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
        return formatSimBackendLabel(job?.simulation?.backendId)
            || job?.simulation?.backendLabel
            || 'SIM';
    }

    _jobMetaLine(job) {
        const parts = [job.timestamp];
        const backendLabel = job.simulation?.backendId
            ? formatSimBackendLabel(job.simulation.backendId)
            : job.simulation?.backendLabel;
        if (backendLabel) parts.push(backendLabel);
        if (job.status === 'error' && job.error) {
            const firstLine = String(job.error).split('\n')[0];
            parts.push(firstLine.length > 72 ? `${firstLine.slice(0, 69)}...` : firstLine);
        }
        return parts.join(' · ');
    }

    /** Row-major 4×4 from `getResliceToFromFovSnapshot().affine` (3×4) for protocol TOML. */
    _flattenFovAffineForToml(affine3x4) {
        if (!Array.isArray(affine3x4) || affine3x4.length !== 3) {
            throw new Error('_flattenFovAffineForToml: expected 3×4 affine');
        }
        return [
            ...affine3x4[0],
            ...affine3x4[1],
            ...affine3x4[2],
            0, 0, 0, 1,
        ];
    }

    /**
     * Patch the protocol `.py` `[simulation]` / `[recon]` metadata with a UI-faithful,
     * NON-oversampled snapshot: `fov_affine` + `fov_matrix` (recon grid), the BASE
     * `phantom_matrix` and `phantom_oversample` (mirroring the sliders). The effective
     * oversampled grid is derived (base × oversample) only when a tooltip needs it.
     * This block is metadata/provenance only (the sim consumes the live submit payload).
     */
    async _patchProtocolSimulationToml(job, { fovAffine, fovMatrix, phantomMatrix, phantomOversample, reconMatrix, phantomName }) {
        if (!job?.scanNumber || !window.seqExplorer) return;
        const protocolPath = window.seqExplorer.findProtocolPathForScanNumber(job.scanNumber);
        if (!protocolPath) return;
        const sim = job.simulation || {};
        const simulation = {
            backend: sim.backendId || 'mr0sim',
            phantom: phantomName || 'unknown',
        };
        if (fovAffine) simulation.fov_affine = fovAffine;
        if (fovMatrix) simulation.fov_matrix = fovMatrix;
        if (phantomMatrix) simulation.phantom_matrix = phantomMatrix;
        if (phantomOversample) simulation.phantom_oversample = phantomOversample;
        await window.seqExplorer.patchProtocolTomlSections(protocolPath, {
            simulation,
            recon: {
                matrix: reconMatrix,
                method: RECON_METHOD,
            },
        });
    }

    /** Scan-ready bifti cache id of the active phantom group (or null). Public wrapper. */
    getActiveBiftiId() {
        const nvMod = window.nvModule;
        const group = typeof nvMod?.getActivePhantomGroup === 'function'
            ? nvMod.getActivePhantomGroup()
            : null;
        return this._resolveBiftiId(group);
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
            window.seqExplorer._pendingProtocolMeta = null;
        }
        if (window.seqExplorer?._lastExecutionError) {
            throw new Error(window.seqExplorer._lastExecutionError);
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

    _getHttpSimBaseUrl(job) {
        const fromJob = job?.simulation?.httpBaseUrl;
        if (fromJob) return String(fromJob).replace(/\/$/, '');
        return defaultHttpSimBaseUrl();
    }

    /**
     * Cached bifti folder/scan id for remote HTTP phantom load (no local upload).
     * Always the two-segment folder id (`collection/name`) when known — never a local-only
     * Save-as stem like `user/…/…_copy`. Tissue/config edits travel separately as
     * `phantom.config` via `_resolvePhantomConfigForHttp`. Must match an entry from
     * `GET /v1/cache` so `options.phantom.id` is accepted by the sim gateway.
     */
    _resolveBiftiId(group) {
        if (!group) return null;
        if (group.folderId) return String(group.folderId);
        if (group.biftiRegistryId) {
            try {
                return phantomFolderId(group.biftiRegistryId);
            } catch (_) {
                return String(group.biftiRegistryId);
            }
        }
        return null;
    }

    /**
     * Current (possibly edited) nifti_phantom_v1 JSON for the active group, parsed to an object so
     * the Modal server applies tissue edits on top of the registry NIfTIs. Returns null if no valid
     * JSON is available (server then falls back to the registry sidecar).
     */
    _resolvePhantomConfigForHttp(nvMod, group, simLogTag) {
        try {
            const raw = typeof nvMod.getPhantomJsonContent === 'function'
                ? nvMod.getPhantomJsonContent(group)
                : (group?.jsonContent != null ? String(group.jsonContent) : null);
            if (!raw || !String(raw).trim()) return null;
            return JSON.parse(raw);
        } catch (e) {
            console.warn(`[${simLogTag}] phantom JSON parse failed; server will use registry sidecar:`, e);
            return null;
        }
    }

    _parseHttpJobProgress(status) {
        const msg = String(status?.message || '').trim();
        const rep = status?.repetition;
        const total = status?.total;
        if (rep != null && total != null && total > 0) {
            return simBandFrac('exec', Number(rep) / Number(total));
        }
        const parsed = parseMr0SimProgressMessage(msg);
        if (parsed != null) {
            if (typeof parsed === 'object') return parsed.frac;
            return parsed;
        }
        if (/phantom|reslice|bifti|zenodo/i.test(msg)) return simBandFrac('phantom', 0.35);
        if (/import|sequence|convert seq/i.test(msg)) return simBandFrac('build', 0.25);
        if (/trajectory|k-space/i.test(msg)) return simBandFrac('exec', 0.05);
        return null;
    }

    _applyHttpJobProgress(job, status, logTag) {
        const frac = this._parseHttpJobProgress(status);
        if (frac == null) return;
        job.simProgressTarget = Math.max(job.simProgressTarget ?? 0, frac);
        this._ensureSimProgressAnimator(job);
        console.log(`${logTag} [http]`, status.message || status.status);
    }

    /**
     * fetch() with timeout + bounded retry on network errors and transient 429/5xx.
     * Non-retryable responses (e.g. 4xx) are returned as-is for the caller to inspect `.ok`.
     * @param {string} url
     * @param {RequestInit | (() => RequestInit)} optionsOrFactory — a factory is called per attempt
     *   so a fresh body (e.g. FormData) is built for each retry.
     */
    async _httpFetchWithRetry(url, optionsOrFactory = {}, { tries = HTTP_FETCH_RETRIES, timeoutMs = 30000, label = 'request' } = {}) {
        let lastErr = null;
        for (let attempt = 1; attempt <= tries; attempt++) {
            const options = typeof optionsOrFactory === 'function' ? optionsOrFactory() : optionsOrFactory;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const resp = await fetch(url, { ...options, signal: controller.signal });
                clearTimeout(timer);
                if (resp.ok) return resp;
                if (HTTP_RETRY_STATUSES.has(resp.status) && attempt < tries) {
                    const detail = await resp.text().catch(() => '');
                    lastErr = new Error(`${label} HTTP ${resp.status}: ${detail.slice(0, 200)}`);
                } else {
                    return resp; // non-retryable (e.g. 4xx) or last attempt → caller checks .ok
                }
            } catch (e) {
                clearTimeout(timer);
                lastErr = e;
                if (attempt >= tries) break;
            }
            const backoff = Math.min(8000, 600 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 300);
            await new Promise((r) => setTimeout(r, backoff));
        }
        throw lastErr || new Error(`${label} failed after ${tries} attempts`);
    }

    async _httpSubmitJob(baseUrl, seqBytes, seqFilename, options, fovReferenceBytes = null) {
        const buildInit = () => {
            const form = new FormData();
            form.append('seq', new Blob([seqBytes], { type: 'application/octet-stream' }), seqFilename);
            form.append('options', JSON.stringify(options));
            if (fovReferenceBytes) {
                form.append(
                    'fov_reference',
                    new Blob([fovReferenceBytes], { type: 'application/octet-stream' }),
                    'fov_reference.nii',
                );
            }
            return { method: 'POST', body: form };
        };
        const resp = await this._httpFetchWithRetry(`${baseUrl}/v1/jobs`, buildInit, {
            timeoutMs: HTTP_SUBMIT_TIMEOUT_MS,
            label: 'job submit',
        });
        if (!resp.ok) {
            const detail = await resp.text().catch(() => '');
            if (resp.status === 400) {
                throw new Error(
                    `HTTP job submit rejected (400): ${detail}. `
                    + 'The phantom id may not be on the cache — add it via the cache admin, then retry.',
                );
            }
            throw new Error(`HTTP job submit failed (${resp.status}): ${detail}`);
        }
        const data = await resp.json();
        if (!data?.job_id) throw new Error('HTTP job submit: missing job_id');
        return data.job_id;
    }

    /** Single tolerant status poll. Throws only on a genuine HTTP/network error (caller counts these). */
    async _httpGetStatus(baseUrl, jobId) {
        const resp = await this._httpFetchWithRetry(`${baseUrl}/v1/jobs/${jobId}`, {}, {
            tries: 2,
            timeoutMs: HTTP_STATUS_TIMEOUT_MS,
            label: 'job status',
        });
        if (!resp.ok) {
            const detail = await resp.text().catch(() => '');
            throw new Error(`HTTP job poll failed (${resp.status}): ${detail}`);
        }
        return await resp.json();
    }

    async _httpFetchResultNpz(baseUrl, jobId) {
        const resp = await this._httpFetchWithRetry(`${baseUrl}/v1/jobs/${jobId}/result`, {}, {
            timeoutMs: HTTP_RESULT_TIMEOUT_MS,
            label: 'result fetch',
        });
        if (!resp.ok) {
            const detail = await resp.text().catch(() => '');
            throw new Error(`HTTP result fetch failed (${resp.status}): ${detail}`);
        }
        return await resp.arrayBuffer();
    }

    async _httpHealth(baseUrl) {
        const resp = await fetch(`${baseUrl}/v1/health`);
        if (!resp.ok) return { ok: false, cuda: false };
        return await resp.json();
    }

    async _parseHttpNpzForRecon(nvMod, npzBytes) {
        nvMod.pyodide.globals.set('http_npz_bytes', npzBytes);
        const pairsPy = await nvMod.pyodide.runPythonAsync(`
import io
import numpy as np
_buf = http_npz_bytes.to_py() if hasattr(http_npz_bytes, 'to_py') else http_npz_bytes
if isinstance(_buf, (list, tuple)):
    _buf = bytes(_buf)
data = np.load(io.BytesIO(_buf))
signal = np.asarray(data['signal']).ravel()
ktraj = np.asarray(data['ktraj'], dtype=np.float32)
if ktraj.ndim == 2 and ktraj.shape[0] == 3 and ktraj.shape[1] != 3:
    ktraj = ktraj.T
sig_pairs = [[float(np.real(x)), float(np.imag(x))] for x in signal]
traj_pts = []
for i in range(ktraj.shape[0]):
    kx = float(ktraj[i, 0])
    ky = float(ktraj[i, 1] if ktraj.shape[1] > 1 else 0.0)
    kz = float(ktraj[i, 2] if ktraj.shape[1] > 2 else 0.0)
    traj_pts.append([kx, ky, kz])
(sig_pairs, traj_pts)
        `);
        const out = (pairsPy && pairsPy.toJs) ? pairsPy.toJs() : pairsPy;
        if (pairsPy?.destroy) pairsPy.destroy();
        return { signalPairs: out[0], trajPoints: out[1] };
    }

    /**
     * HTTP full pipeline (back-compat wrapper): prep + submit (awaited), then background poll + recon.
     * Prefer calling `_httpPrepareAndSubmit` + `_pumpHttpReaper` directly (as `startScan` does).
     * @param {object} job — simulation.transport === 'http' (from _enqueueSimJob modal_http).
     */
    async runHttpSimPipeline(job) {
        await this._httpPrepareAndSubmit(job);
        void this._pumpHttpReaper();
    }

    /**
     * Phase A + B: build the .seq from the *current* UI, freeze this job's FOV snapshot, then submit
     * to the Modal gateway. Awaited by `startScan` so each rapid click materialises its own setup in
     * order before the user can edit the next one. Poll + recon (phases C–F) run later in the reaper.
     * @param {object} job
     */
    async _httpPrepareAndSubmit(job) {
        const nvMod = window.nvModule;
        const simLogTag = this._jobSimLogTag(job);
        const httpBase = this._getHttpSimBaseUrl(job);
        job.httpBaseUrl = httpBase;
        job.abortSim = false;
        job.status = 'scanning';
        job.pipelineStage = 0;
        job.error = null;
        job.reconDone = false;
        job._reconStarted = false;
        job._pollFails = 0;
        job._tSubmittedAt = performance.now();
        this.updateQueueUI();
        this._syncScanBusyUi();
        try {
            await nvMod.initPyodide();
            const activeGroup = typeof nvMod.getActivePhantomGroup === 'function'
                ? nvMod.getActivePhantomGroup()
                : nvMod.volumeGroups?.find(g => g.volumes?.length
                    && !String(g.jsonName || '').endsWith('_resampled')
                    && !String(g.jsonName || '').endsWith('_averaged'));
            if (!activeGroup) throw new Error("No phantom group found. Load a phantom via Add BIfTI first.");

            const biftiId = this._resolveBiftiId(activeGroup);
            if (!biftiId) {
                throw new Error(
                    'HTTP SCAN needs a cache phantom. Load one via "Add BIfTI" (or upload it to the '
                    + 'cache admin as user/… first), then retry.',
                );
            }

            const _tSeq = performance.now();
            const seqText = await nvMod.enqueuePyodideTask(job.id, 'sim-seq', async () => {
                return await this._prepareCurrentSeqForTools(job);
            });
            console.log(`[HTTP] sim-seq: ${(performance.now() - _tSeq).toFixed(0)}ms`);

            const seqBytes = job.vfsSeqPath
                ? nvMod.pyodide.FS.readFile(job.vfsSeqPath)
                : new TextEncoder().encode(seqText);
            const seqFilename = job.vfsSeqPath
                ? job.vfsSeqPath.split('/').pop()
                : `${job.baseName}.seq`;

            // FOV after seq: executeFunction may sync Pulseq FOV → viewer sliders.
            job.fovSnapshot = nvMod.captureFovSnapshot();
            const phantomOversample = nvMod.getPhantomOversampleFactors();
            job.phantomOversample = phantomOversample;
            const phantomFovSnapshot = nvMod.applyPhantomOversampleToSnapshot(job.fovSnapshot, phantomOversample);
            const phantomMatrix = nvMod.getSimPhantomMatrixDims(phantomOversample);
            const phantomMatrixBase = nvMod.getPhantomMatrixDims();
            const reconMatrix = nvMod.getReconMatrixDims();
            const phantomReslice = nvMod.getResliceToFromFovSnapshot(phantomFovSnapshot, phantomMatrix);
            // UI-faithful (non-oversampled) recon-grid affine for the shared/provenance metadata.
            const fovReslice = nvMod.getResliceToFromFovSnapshot(job.fovSnapshot, reconMatrix);
            const fovAffineFlat = this._flattenFovAffineForToml(fovReslice.affine);

            // Freeze everything the background reaper needs for phases C–F onto the job.
            job.reconMatrix = reconMatrix;
            job.seqText = seqText;

            const phantomSpec = {
                type: 'bifti',
                id: biftiId,
                res: phantomReslice.resolution,
                affine: phantomReslice.affine,
            };
            // Send the current (possibly edited) JSON sidecar so tissue scalars / func / B1 / mapping
            // edits are honored remotely. NIfTI voxel data still comes from the registry download
            // (filename refs in the JSON must match the registry files).
            const phantomConfig = this._resolvePhantomConfigForHttp(nvMod, activeGroup, simLogTag);
            if (phantomConfig) phantomSpec.config = phantomConfig;
            const options = {
                exact_trajectories: job.simulation?.exactTrajectories !== false,
                phantom: phantomSpec,
            };
            const modalWorker = job.simulation?.worker;
            if (modalWorker) {
                options.worker = modalWorker;
            } else if (job.simulation?.useGpu === true) {
                options.use_gpu = true;
            }

            void this._patchProtocolSimulationToml(job, {
                fovAffine: fovAffineFlat,
                fovMatrix: reconMatrix,
                phantomMatrix: phantomMatrixBase,
                phantomOversample,
                reconMatrix,
                phantomName: biftiId,
            }).catch((tomlErr) => {
                console.warn(`[${simLogTag}] protocol TOML simulation/recon patch failed:`, tomlErr);
            });

            this._setPipelineStage(job, 3);
            job.simProgress = 0;
            job.simProgressTarget = 0;
            job.simDisplayProgress = 0;
            job._simIndeterminate = false;
            this._ensureSimProgressAnimator(job);

            if (job.abortSim) throw new Error('user stopped');
            const _tSubmit = performance.now();
            const httpJobId = await this._httpSubmitJob(httpBase, seqBytes, seqFilename, options);
            job.httpJobId = httpJobId;
            console.log(`[HTTP] submit ${httpJobId}: ${(performance.now() - _tSubmit).toFixed(0)}ms`);
            // Job now in flight on Modal; _pumpHttpReaper drives polling + recon.
        } catch (e) {
            if (job.abortSim) {
                job.status = 'error';
                job.error = 'user stopped';
            } else {
                console.error('HTTP scan submit failed:', e);
                job.status = 'error';
                job.error = typeof nvMod?.formatPyodideError === 'function'
                    ? nvMod.formatPyodideError(e)
                    : (e.message || String(e));
            }
            this._stopSimProgressAnimator(job);
        }
        this.updateQueueUI();
        this._syncScanBusyUi();
    }

    /**
     * Background loop: poll every in-flight HTTP job concurrently and, as each finishes, kick its
     * fetch + recon (which serialises through the Pyodide queue). Many sims run in parallel on the
     * Modal worker pool while local recon stays single-threaded. Self-terminates when nothing is
     * left to poll; `startScan` re-pumps it whenever a new job is submitted.
     */
    async _pumpHttpReaper() {
        if (this._httpReaperRunning) return;
        this._httpReaperRunning = true;
        try {
            while (true) {
                const inflight = this.queue.filter((j) =>
                    j.simulation?.transport === 'http'
                    && j.httpJobId
                    && !j.abortSim
                    && !j._reconStarted
                    && j.status === 'scanning'
                    && (j.pipelineStage ?? 0) === 3);
                if (!inflight.length) break;
                await Promise.allSettled(inflight.map((j) => this._httpPollOnce(j)));
                await new Promise((r) => setTimeout(r, HTTP_POLL_MS));
            }
        } finally {
            this._httpReaperRunning = false;
        }
    }

    /** One tolerant status poll for a single job; launches recon (detached) when the job is done. */
    async _httpPollOnce(job) {
        if (job.abortSim || job.status !== 'scanning' || job._reconStarted) return;
        let status;
        try {
            status = await this._httpGetStatus(job.httpBaseUrl, job.httpJobId);
        } catch (e) {
            job._pollFails = (job._pollFails || 0) + 1;
            if (job._pollFails >= HTTP_POLL_MAX_FAILS) {
                this._failHttpJob(job, `Lost connection to simulation server: ${e?.message || e}`);
            }
            return;
        }
        job._pollFails = 0;
        this._applyHttpJobProgress(job, status, this._jobSimLogTag(job));
        const st = status.status;
        if (st === 'failed') {
            this._failHttpJob(job, status.error || status.message || 'HTTP simulation failed');
            return;
        }
        if (st === 'aborted') {
            this._failHttpJob(job, 'Job aborted');
            return;
        }
        if (st === 'done') {
            job._reconStarted = true;
            void this._httpFinishJob(job); // detached: fetch + recon must not block other jobs' polls
        }
    }

    /** Mark an in-flight HTTP job as failed (network give-up, server failure, or abort). */
    _failHttpJob(job, message) {
        if (job.status === 'done' || job.status === 'error') return;
        job.status = 'error';
        job.error = message;
        this._stopSimProgressAnimator(job);
        this.updateQueueUI();
        this._syncScanBusyUi();
    }

    /**
     * Phases D–F for one finished job: fetch NPZ → local PyNUFFT recon (Pyodide-serialised) → finalize.
     * Runs detached from the poll loop; recon ordering is handled by `enqueuePyodideTask`.
     * @param {object} job
     */
    async _httpFinishJob(job) {
        const nvMod = window.nvModule;
        const simLogTag = this._jobSimLogTag(job);
        const _tFinish = performance.now();
        try {
            if (job.abortSim) throw new Error('user stopped');
            this._stopSimProgressAnimator(job);
            job.simProgressTarget = 1;
            job.simDisplayProgress = 1;
            job.simProgress = 1;
            this._setPipelineStage(job, 3);

            const npzBytes = await this._httpFetchResultNpz(job.httpBaseUrl, job.httpJobId);
            const { signalPairs, trajPoints } = await nvMod.enqueuePyodideTask(job.id, 'http-npz', () =>
                this._parseHttpNpzForRecon(nvMod, npzBytes),
            );

            if (!trajPoints?.length) throw new Error(`${simLogTag}: HTTP result has no trajectory.`);
            if (!signalPairs?.length) throw new Error(`${simLogTag}: HTTP result has no signal.`);

            const reconRef = nvMod.generateFovMaskNiftiFromSnapshot(job.fovSnapshot, job.reconMatrix);

            const useRecon = typeof nvMod.isScanReconEnabled === 'function'
                ? nvMod.isScanReconEnabled()
                : nvMod.scanRecon?.checked !== false;
            const recoOutPath = typeof nvMod.simReconOutPath === 'function'
                ? nvMod.simReconOutPath(job.id)
                : '/tmp/__sim_pipeline_reco.nii';
            job.reconDone = false;
            this._setPipelineStage(job, 4);
            const _tRecon = performance.now();
            const recoBytes = await nvMod.enqueuePyodideTask(job.id, 'sim-recon', async () => {
                await nvMod._ensureNibabelReady();
                await nvMod.pyodide.loadPackage(['micropip']);
                await nvMod.pyodide.runPythonAsync(`
import micropip
try:
    import pynufft  # noqa
except Exception:
    await micropip.install('pynufft')
                `);
                await this._ensureSimReconPy(nvMod);
                nvMod.pyodide.globals.set('sim_signal_pairs', signalPairs);
                nvMod.pyodide.globals.set('sim_traj_points', trajPoints);
                nvMod.pyodide.globals.set('sim_ref_bytes', reconRef);
                nvMod.pyodide.globals.set('sim_output_mode', useRecon ? 'image' : 'kspace_log');
                nvMod.pyodide.globals.set('sim_seq_path', job.vfsSeqPath || '');
                nvMod.pyodide.globals.set('sim_reco_out_path', recoOutPath);
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
_out = sim_reco_out_path.to_py() if hasattr(sim_reco_out_path, 'to_py') else str(sim_reco_out_path)
_recon.run_sim_recon(
    sim_signal_pairs,
    sim_traj_points,
    sim_ref_bytes,
    out_path=_out,
    output_mode=sim_output_mode,
    matrix=_matrix,
)
                `);
                const recoPath = (recoPathRes && recoPathRes.toJs) ? recoPathRes.toJs() : recoPathRes;
                if (recoPathRes?.destroy) recoPathRes.destroy();
                const path = String(recoPath || recoOutPath);
                const bytes = nvMod.pyodide.FS.readFile(path);
                try { nvMod.pyodide.FS.unlink(path); } catch (_) {}
                return bytes;
            });
            console.log(`[HTTP] ${useRecon ? 'PyNUFFT recon' : 'k-space log'}: ${(performance.now() - _tRecon).toFixed(0)}ms`);
            job.reconDone = true;
            this._setPipelineStage(job, 4);

            job.niftiUrl = URL.createObjectURL(new Blob([recoBytes], { type: 'application/octet-stream' }));
            job.seqUrl = URL.createObjectURL(new Blob([job.seqText || ''], { type: 'text/plain' }));
            job.status = 'done';
            console.log(`[HTTP] *** TOTAL pipeline: ${(performance.now() - (job._tSubmittedAt ?? _tFinish)).toFixed(0)}ms ***`);
            // Focus the latest finished scan: load every completed result into the viewer + SCANS
            // list. syncFov=false keeps the user's in-progress FOV planning intact.
            this.loadJob(job.id, false);
        } catch (e) {
            if (job.abortSim) {
                job.status = 'error';
                job.error = 'user stopped';
            } else {
                console.error('HTTP scan failed:', e);
                job.status = 'error';
                job.error = typeof nvMod?.formatPyodideError === 'function'
                    ? nvMod.formatPyodideError(e)
                    : (e.message || String(e));
            }
        } finally {
            this._stopSimProgressAnimator(job);
        }
        this.updateQueueUI();
        this._syncScanBusyUi();
    }

    /**
     * Shared pipeline: resample phantom → conseq / trajex → rapisim or tool-mr0sim → PyNUFFT → queue result.
     * @param {object} job — must include simulation.toolUrl (from _enqueueSimJob).
     */
    async runSimPipeline(job) {
        const nvMod = window.nvModule;
        const simToolUrl = job.simulation?.toolUrl || TOOL_MR0SIM_T4;
        const simLogTag = this._jobSimLogTag(job);
        this._simPipelineJob = job;
        job.abortSim = false;
        job.status = 'scanning';
        job.pipelineStage = 0;
        job.error = null;
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
            const phantomMatrixBase = nvMod.getPhantomMatrixDims();
            const reconMatrix = nvMod.getReconMatrixDims();
            const phantomRef = nvMod.generateFovMaskNiftiFromSnapshot(
                phantomFovSnapshot,
                phantomMatrix,
            );
            const reconRef = nvMod.generateFovMaskNiftiFromSnapshot(job.fovSnapshot, reconMatrix);
            // UI-faithful (non-oversampled) recon-grid affine for the shared/provenance metadata.
            const fovReslice = nvMod.getResliceToFromFovSnapshot(job.fovSnapshot, reconMatrix);

            try {
                await this._patchProtocolSimulationToml(job, {
                    fovAffine: this._flattenFovAffineForToml(fovReslice.affine),
                    fovMatrix: reconMatrix,
                    phantomMatrix: phantomMatrixBase,
                    phantomOversample,
                    reconMatrix,
                    phantomName: this.getActiveBiftiId() || activeGroup.jsonName || activeGroup.jsonFileName || 'unknown',
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
            job.simProgress = 0;
            job.simProgressTarget = 0;
            job.simDisplayProgress = 0;
            job._simIndeterminate = false;
            this._setPipelineStage(job, 3);
            this._ensureSimProgressAnimator(job);
            const _tParallelSim = performance.now();
            const simDict = { sequence: seq, phantom: phantomForSim };
            if (job.simulation?.useGpu) {
                simDict.use_gpu = { Bool: true };
            }
            const [trajSettled, simSettled] = await Promise.allSettled([
                this._callTool(
                    TOOL_TRAJEX,
                    { Dict: { sequence: events, t1: { Float: 1.0 }, t2: { Float: 0.1 }, min_mag: { Float: 0.001 } } },
                    'trajex',
                ),
                this._callToolSim(
                    simToolUrl,
                    { Dict: simDict },
                    simChannel,
                    job,
                ),
            ]);
            if (job.abortSim) throw new Error('user stopped');
            const simLegs = [
                { label: 'trajex', settled: trajSettled },
                { label: simChannel, settled: simSettled },
            ];
            const simFail = simLegs.filter((leg) =>
                leg.settled.status === 'rejected' || this._toolErrorMessage(leg.settled.value),
            );
            if (simFail.length) {
                if (job.abortSim) throw new Error('user stopped');
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
            if (job.abortSim) throw new Error('user stopped');
            this._stopSimProgressAnimator(job);
            job.simProgressTarget = 1;
            job.simDisplayProgress = 1;
            job.simProgress = 1;
            this._setPipelineStage(job, 3);
            const useRecon = typeof nvMod.isScanReconEnabled === 'function'
                ? nvMod.isScanReconEnabled()
                : nvMod.scanRecon?.checked !== false;
            const _t6 = performance.now();
            const recoOutPath = typeof nvMod.simReconOutPath === "function"
                ? nvMod.simReconOutPath(job.id)
                : "/tmp/__sim_pipeline_reco.nii";
            job.reconDone = false;
            this._setPipelineStage(job, 4);
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
_out = sim_reco_out_path.to_py() if hasattr(sim_reco_out_path, 'to_py') else str(sim_reco_out_path)
_recon.run_sim_recon(
    sim_signal_pairs,
    sim_traj_points,
    sim_ref_bytes,
    out_path=_out,
    output_mode=sim_output_mode,
    matrix=_matrix,
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
            job.reconDone = true;
            this._setPipelineStage(job, 4);

            if (job.abortSim) throw new Error('user stopped');

            // 7) show in Niivue (scan-like naming/path)
            job.niftiUrl = URL.createObjectURL(new Blob([recoBytes], { type: "application/octet-stream" }));
            job.seqUrl = URL.createObjectURL(new Blob([seqText], { type: "text/plain" }));
            job.status = 'done';
            console.log(`[SIM] *** TOTAL pipeline: ${(performance.now()-_tPipeline).toFixed(0)}ms ***`);
            // Auto-load: don't resync FOV — preserve any in-progress FOV planning the user is doing
            // for the next scan. Explicit VIEW SCAN clicks still sync (default `syncFov=true`).
            this.loadJob(job.id, false);
        } catch (e) {
            if (job.abortSim) {
                console.warn(`[${simLogTag}] stopped by user`);
                job.status = 'error';
                job.error = 'user stopped';
            } else {
                console.error(`[${simLogTag}] failed:`, e);
                job.status = 'error';
                job.error = typeof nvMod?.formatPyodideError === "function"
                    ? nvMod.formatPyodideError(e)
                    : (e.message || String(e));
            }
        } finally {
            this._stopSimProgressAnimator(job);
            this._simPipelineJob = null;
        }
        this.updateQueueUI();
    }

    /** Update discrete pipeline stage; sim sub-progress uses _ensureSimProgressAnimator. */
    _setPipelineStage(job, stage) {
        if (!job) return;
        const prev = job.pipelineStage ?? 0;
        const s = Math.max(0, Math.min(4, Number(stage) || 0));
        job.pipelineStage = s;
        if (s < 3) {
            job.simProgress = 0;
            job.simProgressTarget = 0;
            job.simDisplayProgress = 0;
            this._stopSimProgressAnimator(job);
        }
        if (prev === 3 && s !== 3) this._stopSimProgressAnimator(job);
        if ((s === 3 && prev !== 3) || (prev === 3 && s !== 3)) {
            this.updateQueueUI();
            if (job.status === 'scanning') this._syncMobileScanControls();
            return;
        }
        const rings = this._pipelineRingElements(job);
        if (rings.length) {
            for (const el of rings) this._applyPipelineRing(el, job);
        } else {
            this.updateQueueUI();
        }
        if (job.status === 'scanning') this._syncMobileScanControls();
    }

    _pipelineProgressHtml(job, crop = false) {
        const j = job && typeof job === 'object' ? job : { pipelineStage: job ?? 0, simProgress: 0, reconDone: false };
        const s = Math.max(0, Math.min(4, Number(j.pipelineStage) || 0));
        const simFrac = s >= 3 && s < 4
            ? (j.simDisplayProgress ?? j.simProgressTarget ?? j.simProgress ?? 0)
            : (j.simProgress ?? 0);
        const deg = pipelineProgressDeg(s, simFrac, !!j.reconDone);
        const isCrop = crop || !!j.cropOnly;
        const label = isCrop ? 'crop' : PIPELINE_STAGES[s];
        const simRunning = s === 3 && j.status === 'scanning';
        return `<div class="scan-pipeline-progress${isCrop ? ' is-crop' : ''}${simRunning ? ' is-sim-running' : ''}" style="--progress-deg:${deg}deg" data-stage="${s}" data-sim-progress="${simFrac}" title="${label}" role="progressbar" aria-valuemin="0" aria-valuemax="330" aria-valuenow="${Math.round(deg)}" aria-label="${label}"></div>`;
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
                    <div class="item-title">${this._escapeHtml(formatScanDisplayTitle(`${job.baseName}.nii.gz`, job))}</div>
                    <div class="item-meta"${job.status === 'error' ? ` title="${this._escapeAttr(this._jobErrorTooltip(job))}"` : ''}>${this._escapeHtml(this._jobMetaLine(job))}</div>
                </div>
                <div class="item-actions">
                    ${job.status === 'scanning' ? `
                        <div class="action-row small-btns">
                            ${!job.cropOnly && (job.pipelineStage ?? 0) === 3 ? `
                                <button type="button" class="cancel-sim-btn" title="Stop simulation" aria-label="Stop simulation"><i class="bi bi-stop-fill" aria-hidden="true"></i></button>
                            ` : ''}
                            ${this._pipelineProgressHtml(job, !!job.cropOnly)}
                        </div>
                    ` : ''}
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
                        <div class="action-row${!job.cropOnly && job.vfsSeqPath ? '' : ' small-btns'}">
                            ${!job.cropOnly && job.vfsSeqPath ? `
                                <button class="view-seq-btn">VIEW SEQ</button>
                            ` : ''}
                            <span class="error-icon" title="${this._escapeAttr(this._jobErrorTooltip(job))}">⚠</span>
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

    cancelSim(jobId) {
        const job = this.queue.find((j) => j.id === jobId);
        if (!job || job.cropOnly || (job.pipelineStage ?? 0) !== 3) return;
        if (job.status !== 'scanning' && !(job.status === 'error' && job.abortSim)) return;
        job.abortSim = true;
        if (job.httpJobId && job.httpBaseUrl) {
            fetch(`${job.httpBaseUrl}/v1/jobs/${job.httpJobId}/abort`, { method: 'POST' }).catch(() => {});
        }
        job.status = 'error';
        job.error = 'user stopped';
        this._stopSimProgressAnimator(job);
        this.updateQueueUI();
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
        const n = parseScanNumberFromVolumeName(vol?.name);
        if (n == null) return null;
        return window.seqExplorer?.getProtocolTooltipForScanNumber?.(n) ?? null;
    }

    /** Tooltip for scan N via protocol file (used by paper plot and volume list). */
    getProtocolTooltipForScanNumber(scanNumber) {
        return window.seqExplorer?.getProtocolTooltipForScanNumber?.(scanNumber) ?? null;
    }

    async loadJob(jobId, syncFov = true) {
        const job = this.queue.find(j => j.id === jobId);
        if (job && job.status === 'done' && window.nvModule) {
            // Planning view only on explicit VIEW SCAN (syncFov=true). Auto-load after SCAN/CROP
            // keeps the current mode (e.g. plot.seq) so the user switches manually.
            if (syncFov && window.viewManager && window.viewManager.currentMode !== 'planning') {
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
        if (!job || (job.status !== 'done' && job.status !== 'error')) return;

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
                    const timeRange =
                        typeof explorer.getSeqPlotTimeRange === 'function'
                            ? explorer.getSeqPlotTimeRange(plotRoot)
                            : [0, Infinity];
                    const t0 =
                        timeRange[0] === Infinity
                            ? 'float("inf")'
                            : timeRange[0] === -Infinity
                              ? 'float("-inf")'
                              : String(timeRange[0]);
                    const t1 =
                        timeRange[1] === Infinity
                            ? 'float("inf")'
                            : timeRange[1] === -Infinity
                              ? 'float("-inf")'
                              : String(timeRange[1]);
                    const timeRangePy = `time_range=(${t0}, ${t1})`;
                    const plotBlock =
                        plotSpeed === 'chartgpu'
                            ? `        seq.plot(plot_now=False, plot_speed="chartgpu", ${timeRangePy})`
                            : `        seq.plot(plot_now=False, plot_speed="${plotSpeed}", ${timeRangePy})
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
