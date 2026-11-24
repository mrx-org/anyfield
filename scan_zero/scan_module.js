import { AppContext } from '../app_context.js';
import { eventHub } from '../event_hub.js';
import { isCompactLayout } from '../footer_cards.js';
import { isProUser } from '../pro_mode.js';
import { SequenceExplorer } from '../pypulseq/seq_explorer.js';
import { phantomFolderId } from './bifti_cache.js';
import {
    DEFAULT_SIM_BACKEND_ID,
    SIM_BACKENDS,
    formatSimBackendLabel,
    persistSimBackendCompareId,
    persistSimBackendId,
    persistHttpSimPruneOptions,
    readStoredHttpSimPruneOptions,
    readStoredSimBackendCompareId,
    readStoredSimBackendId,
    formatHttpSimPruneInput,
    resolveHttpSimBaseUrl,
    resolveSimBackendId,
    httpSimPruneFieldsHtml,
    simBackendRadioMatrixHtml,
} from './sim_backends.js';

const PIPELINE_STAGES = ['prep', 'conseq', 'trajex', 'sim', 'recon'];
/** User-facing queue caption for pipelineStage 0–4 (local / fallback). */
const PIPELINE_STAGE_CAPTIONS = ['seq', 'seq', 'obj', 'sim', 'reco'];
/**
 * Coarse order for HTTP queue abbreviations. Same-order labels may replace each other;
 * a lower order never overwrites a later one (avoids Queued flickering after resample).
 */
const STAGE_CAPTION_ORDER = {
    wake: 0, queue: 0, start: 0,
    seq: 1,
    load: 2, rsmp: 2, dl: 2, obj: 2,
    tbl: 3, sim: 3, fwd: 3, sig: 3,
    getk: 4,
    reco: 5,
};

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
 * The recon call `_reconstructJob` runs on the worker, reading the `sim_npz_bytes` /
 * `sim_ref_bytes` / `sim_output_mode` / `sim_matrix` / `sim_reco_out_path` globals.
 */
const RECON_PY_FROM_NPZ = `
_matrix = sim_matrix.to_py() if hasattr(sim_matrix, 'to_py') else sim_matrix
_matrix = list(_matrix) if _matrix else None
_out = sim_reco_out_path.to_py() if hasattr(sim_reco_out_path, 'to_py') else str(sim_reco_out_path)
_recon.run_sim_recon_from_npz(
    sim_npz_bytes,
    sim_ref_bytes,
    out_path=_out,
    output_mode=sim_output_mode,
    matrix=_matrix,
)
`;

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
 * @param explorer {object|null} SequenceExplorer, for the protocol name lookup;
 *   omit it and the title falls back to the filename.
 */
export function formatScanDisplayTitle(volName, job = null, explorer = null) {
    if (job?.cropOnly && job.scanNumber != null) {
        return `${job.scanNumber}. crop`;
    }
    const n = job?.scanNumber ?? parseScanNumberFromVolumeName(volName);
    if (n != null && typeof explorer?.getProtocolDisplayNameForScanNumber === 'function') {
        const fromProtocol = explorer.getProtocolDisplayNameForScanNumber(n);
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

/**
 * ScanModule - Handles the scanning simulation queue
 * Borrows resampling logic from NiivueModule for FOV crop (no sequence run)
 */
export class ScanModule {
    constructor(ctx = null) {
        /** Shared module registry; own empty one when hosted standalone. */
        this.ctx = ctx ?? new AppContext();
        this.container = null;
        this.queue = [];
        this.currentSequence = null;
        this.currentFov = null;
        this.scanCounter = 0;
        /** Live protocol being edited in col-params; shown as top queue row until SCAN. */
        this.draftJob = null;
        this._scanBackendId = readStoredSimBackendId();
        this._compareBackendId = readStoredSimBackendCompareId();

        this.setupEventListeners();
    }

    _resolveBackendId(backendId) {
        return resolveSimBackendId(backendId, DEFAULT_SIM_BACKEND_ID);
    }

    getSelectedSimBackendId() {
        if (!isProUser()) return DEFAULT_SIM_BACKEND_ID;
        return this._resolveBackendId(this._scanBackendId);
    }

    getCompareSimBackendId() {
        return this._resolveBackendId(this._compareBackendId);
    }

    setSlotBackend(slot, backendId) {
        if (!isProUser()) return;
        const id = this._resolveBackendId(backendId);
        if (slot === 'compare') {
            this._compareBackendId = id;
            persistSimBackendCompareId(id);
        } else {
            this._scanBackendId = id;
            persistSimBackendId(id);
        }
        this._syncScanControlLabels();
    }

    setSelectedSimBackendId(backendId) {
        this.setSlotBackend('scan', backendId);
    }

    bindSimBackendRadios(root) {
        const scope = root && root.querySelectorAll ? root : document;
        scope.querySelectorAll('.sim-backend-radio').forEach((el) => {
            if (el.dataset.bound === '1') return;
            el.dataset.bound = '1';
            el.addEventListener('change', () => {
                if (!el.checked) return;
                this.setSlotBackend(el.dataset.slot === 'compare' ? 'compare' : 'scan', el.value);
            });
        });
        this._syncSimBackendRadios();
    }

    _syncSimBackendRadios() {
        const scan = this.getSelectedSimBackendId();
        const compare = this.getCompareSimBackendId();
        document.querySelectorAll('.sim-backend-radio').forEach((el) => {
            const want = el.dataset.slot === 'compare' ? compare : scan;
            el.checked = el.value === want;
        });
    }

    _syncScanControlLabels() {
        const scanTitle = `Run scan (${formatSimBackendLabel(this.getSelectedSimBackendId())})`;
        for (const sel of ['#btn-start-scan', '#seq-mobile-scan']) {
            const btn = document.querySelector(sel);
            if (btn) btn.title = scanTitle;
        }
        const compareTitle = `Run scan ▶▶ (${formatSimBackendLabel(this.getCompareSimBackendId())})`;
        for (const sel of ['#btn-start-scan-compare', '#seq-mobile-scan-compare']) {
            const btn = document.querySelector(sel);
            if (btn) btn.title = compareTitle;
        }
        this._syncSimBackendRadios();
    }

    /**
     * Read the `matrix` definition out of a job's prepared `.seq` on the VFS.
     *
     * A step of its own rather than part of `_reconstructJob`: it is the only piece of the recon
     * that needs the `.seq` bytes and pypulseq, so keeping it out lets the recon take `matrix`
     * as plain data — a recon running off the main thread would otherwise have to be shipped
     * the sequence and have pypulseq installed just to recover three integers.
     *
     * Tolerant, as it was inside the recon: no path, a path absent from the VFS, or any pypulseq
     * failure all yield null. Only `kspace_log` output consults it (recon.py's non-Cartesian
     * reshape fallback), so null is invisible in the default image mode.
     *
     * @param {object} job
     * @param {object} nvMod
     * @returns {Promise<number[]|null>} `[nx, ny, nz]`, or null when unavailable
     */
    async _readSeqMatrixDefinition(job, nvMod) {
        return nvMod.enqueuePyodideTask(job.id, 'sim-seq-matrix', async () => {
            nvMod.pyodide.globals.set('sim_seq_path', job.vfsSeqPath || '');
            const matrixRes = await nvMod.pyodide.runPythonAsync(`
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
_matrix
`);
            const matrix = matrixRes?.toJs ? matrixRes.toJs() : matrixRes;
            if (matrixRes?.destroy) matrixRes.destroy();
            return matrix ?? null;
        });
    }

    /**
     * Reconstruct one job's raw signal into NIfTI bytes, and clean the file out of the
     * worker's VFS afterwards.
     *
     * `opts.npzBytes` is the remote gateway's result `.npz`, still undecoded. `recon.py`
     * opens it worker-side, so the compact bytes are the only thing that crosses the
     * boundary; decoding first would build tens of thousands of small JS arrays on the
     * main thread and then structured-clone them all across. The buffer is copied rather
     * than transferred: detaching a caller's ArrayBuffer out from under it is a surprise
     * the saved copy does not pay for.
     *
     * Runs on the shared Pyodide worker (`ctx.pyWorker`), which is what keeps a
     * multi-second NUFFT off the main thread. Three consequences worth knowing:
     *
     *   - It no longer goes through `nvMod.enqueuePyodideTask`. That queue exists to
     *     serialise work against the *main thread's* interpreter, and holding it here
     *     would re-serialise the recon against resample and Execute for no reason. The
     *     worker client serialises its own requests.
     *   - Packages and `recon.py` are not fetched and staged per recon any more; the
     *     worker is warmed once at startup (`py_worker_host.js`). `_ensureNibabelReady()`
     *     is therefore not called from this path -- the main thread still needs it for
     *     resample and Execute.
     *   - The inputs travel as one `runPython({ globals })` message rather than six
     *     separate sets, because two jobs finishing together would otherwise interleave
     *     their globals. `outPath` is per-job, so the read after the run is unambiguous
     *     even if another recon's run lands between them.
     *
     * @param {{ npzBytes: ArrayBuffer, reconRef: unknown, useRecon: boolean,
     *           matrix: number[]|null, outPath: string, logTag: string }} opts —
     *   `matrix` from `_readSeqMatrixDefinition`
     * @returns {Promise<Uint8Array>} raw bytes of the written NIfTI
     */
    async _reconstructJob(opts) {
        const { npzBytes, reconRef, useRecon, matrix, outPath, logTag } = opts;
        const t0 = performance.now();
        const host = this.ctx?.pyWorker;
        if (!host) {
            throw new Error('Recon needs ctx.pyWorker, which bootstrap did not build.');
        }
        const py = await host.ready();
        const recoPath = await py.runPython(
            RECON_PY_FROM_NPZ,
            {
                globals: {
                    sim_npz_bytes: npzBytes,
                    sim_ref_bytes: reconRef,
                    sim_output_mode: useRecon ? 'image' : 'kspace_log',
                    // An empty list, never null, for "no matrix definition": Pyodide surfaces
                    // JS null as pyodide.ffi.JsNull rather than None, which passes recon.py's
                    // `matrix is not None` guard and then raises TypeError in len().
                    sim_matrix: matrix ?? [],
                    sim_reco_out_path: outPath,
                },
            },
        );
        const bytes = await py.fsRead(String(recoPath || outPath), { unlink: true });
        console.log(
            `[${logTag}] ${useRecon ? 'PyNUFFT recon' : 'k-space log'}: ${(performance.now() - t0).toFixed(0)}ms`,
        );
        return bytes;
    }

    setupEventListeners() {
        eventHub.on('fov_changed', (data) => {
            this.currentFov = data;
        });
    }

    _defaultDraftName(seq) {
        const explorer = this.ctx.explorer;
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
        const explorer = this.ctx.explorer;
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

    /** Called by the sequence explorer when the selection changes; null clears the draft. */
    onSequenceSelected(data) {
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
            this.ctx.explorer?.showReservedPrefixDialog?.();
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
                this.ctx.explorer?.showReservedPrefixDialog?.();
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
                <div class="scan-header">
                    <div class="scan-header-row">
                    ${isProUser() ? `
                    <button id="btn-start-crop" class="scan-btn scan-btn-secondary" title="Resample first volume to FOV (crop to box)">
                        CROP
                    </button>
                    ` : ''}
                    <button id="btn-start-scan" class="scan-btn scan-btn-primary" title="Run scan">
                        SCAN<span class="icon">▶</span>
                    </button>
                    <button id="btn-start-scan-compare" class="scan-btn scan-btn-primary" title="Run compare scan">
                        SCAN<span class="icon">▶▶</span>
                    </button>
                    ${isProUser() ? `
                    <button id="btn-scan-settings" type="button" class="scan-btn scan-btn-settings" title="Simulation backend" aria-label="Simulation backend">
                        <i class="bi bi-gear" aria-hidden="true"></i>
                    </button>
                    ` : ''}
                    </div>
                </div>
                <div class="scan-queue" id="scan-queue-list">
                    <div class="queue-empty">Queue is empty</div>
                </div>
            </div>
        `;

        const cropBtn = this.container.querySelector('#btn-start-crop');
        if (cropBtn) cropBtn.onclick = () => this.startCrop();
        this.container.querySelector('#btn-start-scan').onclick = () => this.startScan();
        const compareBtn = this.container.querySelector('#btn-start-scan-compare');
        if (compareBtn) compareBtn.onclick = () => this.startScanCompare();
        const settingsBtn = this.container.querySelector('#btn-scan-settings');
        if (settingsBtn) settingsBtn.onclick = () => this.openSimSettingsDialog();
        this.bindSimBackendRadios(this.container);

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
        dialogContent.className = 'sim-settings-dialog';
        dialogContent.style.cssText = `
            background: var(--bg, #1e1e1e);
            border: 1px solid var(--border, #333);
            border-radius: 8px;
            padding: 1.5rem;
            min-width: 420px;
            max-width: 560px;
            max-height: 80vh;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
        `;

        const dialogTitle = document.createElement('h3');
        dialogTitle.textContent = 'Simulation backend';
        dialogTitle.style.cssText = 'margin: 0 0 1rem 0; color: var(--accent, #4a9eff);';

        const matrixWrap = document.createElement('div');
        matrixWrap.style.cssText = 'margin-bottom: 1.15rem; overflow: auto;';
        matrixWrap.innerHTML = simBackendRadioMatrixHtml();

        const pruneWrap = document.createElement('div');
        pruneWrap.innerHTML = httpSimPruneFieldsHtml();

        const buttonRow = document.createElement('div');
        buttonRow.style.cssText = 'display: flex; justify-content: flex-end;';

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.textContent = 'Close';
        closeBtn.className = 'btn btn-secondary btn-md seq-btn-primary';

        const close = () => overlay.remove();
        closeBtn.onclick = close;
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close();
        });

        buttonRow.appendChild(closeBtn);
        dialogContent.appendChild(dialogTitle);
        dialogContent.appendChild(matrixWrap);
        dialogContent.appendChild(pruneWrap);
        dialogContent.appendChild(buttonRow);
        overlay.appendChild(dialogContent);
        document.body.appendChild(overlay);
        this.bindSimBackendRadios(matrixWrap);
        this.bindHttpSimPruneFields(pruneWrap);
    }

    bindHttpSimPruneFields(root) {
        if (!root) return;
        const commit = (input) => {
            const key = input.dataset.pruneKey;
            if (!key) return;
            const next = persistHttpSimPruneOptions({
                ...readStoredHttpSimPruneOptions(),
                [key]: input.value,
            });
            input.value = formatHttpSimPruneInput(key, next[key]);
        };
        root.querySelectorAll('.sim-prune-input').forEach((input) => {
            input.addEventListener('change', () => commit(input));
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    input.blur();
                }
            });
        });
    }

    _getActiveScanJob() {
        return this.queue.find((j) => j.status === 'scanning') || null;
    }

    /**
     * Disable buttons that call Pyodide *outside* the task queue (Get FOV, CROP) while any scan is
     * in flight. plot seq stays available: scan prep executes on the worker, and plot seq's
     * main-thread path waits on the same queue instead of being locked out for the whole remote
     * simulation.
     */
    _syncScanBusyUi() {
        const busy = this.queue.some((j) => j.status === 'scanning');
        const selectors = [
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
        if (!isCompactLayout()) {
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
        const nvMod = this.ctx.nv;
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
                useGpu: backend.useGpu === true,
                transport: backend.transport,
                httpBaseUrl: backend.httpBaseUrl || null,
                worker: backend.worker || null,
                forwardBackend: backend.forwardBackend || null,
                accuracy: backend.accuracy,
                recon: backend.recon,
                exactTrajectories: backend.exactTrajectories === true,
                ...readStoredHttpSimPruneOptions(),
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
        const resolvedId = isProUser()
            ? (backendId || this.getSelectedSimBackendId())
            : DEFAULT_SIM_BACKEND_ID;
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
        const nvMod = this.ctx.nv;
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
        // Await only prep + submit (reads live UI in order, freezes per-job seq + FOV), then
        // poll + recon run in the background so many scans overlap on the Modal worker pool.
        // See runHttpSimPipeline → _httpPrepareAndSubmit + _pumpHttpReaper.
        await this._httpPrepareAndSubmit(job);
        void this._pumpHttpReaper();
    }

    async startScanCompare() {
        if (!isProUser()) return;
        return this.startScan(this.getCompareSimBackendId());
    }

    async startSimFast() {
        return this.startScan('modal_http_t4');
    }

    async startSimModalCpu() {
        return this.startScan('modal_http_cpu');
    }

    async startSimHttp() {
        return this.startScan('modal_http');
    }

    async runCropScan(job) {
        // Borrow logic from this.ctx.nv (NiivueModule instance)
        const nvMod = this.ctx.nv;
        
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

            this._revokeJobObjectUrl(job.niftiUrl);
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

    _pipelineStageCaption(job) {
        if (job?.cropOnly) return 'crop';
        if (job?.stageCaption) return job.stageCaption;
        const s = Math.max(0, Math.min(4, Number(job?.pipelineStage) || 0));
        return PIPELINE_STAGE_CAPTIONS[s] || 'seq';
    }

    _syncPipelineStageCaption(job) {
        if (!job?.id || !this.container) return;
        const el = this.container.querySelector(`.queue-item[data-id="${CSS.escape(job.id)}"] .scan-pipeline-stage`);
        if (!el) return;
        el.textContent = this._pipelineStageCaption(job);
        if (job.stageCaptionDetail) el.title = job.stageCaptionDetail;
        else el.removeAttribute('title');
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
        if (!job?.scanNumber || !this.ctx.explorer) return;
        const protocolPath = this.ctx.explorer.findProtocolPathForScanNumber(job.scanNumber);
        if (!protocolPath) return;
        const sim = job.simulation || {};
        const simulation = {
            backend: sim.backendId || DEFAULT_SIM_BACKEND_ID,
            phantom: phantomName || 'unknown',
        };
        if (fovAffine) simulation.fov_affine = fovAffine;
        if (fovMatrix) simulation.fov_matrix = fovMatrix;
        if (phantomMatrix) simulation.phantom_matrix = phantomMatrix;
        if (phantomOversample) simulation.phantom_oversample = phantomOversample;
        if (sim.min_state_mag != null) simulation.min_state_mag = sim.min_state_mag;
        if (sim.max_state_count != null) simulation.max_state_count = sim.max_state_count;
        if (sim.min_emitted_signal != null) simulation.min_emitted_signal = sim.min_emitted_signal;
        if (sim.min_latent_signal != null) simulation.min_latent_signal = sim.min_latent_signal;
        await this.ctx.explorer.patchProtocolTomlSections(protocolPath, {
            simulation,
            recon: {
                matrix: reconMatrix,
                method: RECON_METHOD,
            },
        });
    }

    /** Scan-ready bifti cache id of the active phantom group (or null). Public wrapper. */
    getActiveBiftiId() {
        const nvMod = this.ctx.nv;
        const group = typeof nvMod?.getActivePhantomGroup === 'function'
            ? nvMod.getActivePhantomGroup()
            : null;
        return this._resolveBiftiId(group);
    }

    async _prepareCurrentSeqForTools(job) {
        const _t = (label) => console.log(`[SEQ-PREP] ${label}: ${performance.now().toFixed(1)}ms`);
        _t('start');
        if (this.ctx.explorer) {
            this.ctx.explorer._pendingProtocolMeta = {
                scanNumber: job.scanNumber,
                name: job.name,
            };
            await this.ctx.explorer.executeFunction(true, job.scanNumber);
            this.ctx.explorer._pendingProtocolMeta = null;
        }
        if (this.ctx.explorer?._lastExecutionError) {
            throw new Error(this.ctx.explorer._lastExecutionError);
        }
        _t('after executeFunction');
        const nvMod = this.ctx.nv;
        const harvest = this.ctx.explorer?._lastHarvest;
        const seqBytes = harvest?.seqBytes instanceof Uint8Array
            ? harvest.seqBytes
            : (harvest?.seqBytes instanceof ArrayBuffer ? new Uint8Array(harvest.seqBytes) : null);
        if (!seqBytes || !seqBytes.byteLength) {
            throw new Error("Could not prepare .seq file for simulation.");
        }
        const vfsPath = `/outputs/${job.baseName}.seq`;
        try {
            nvMod.pyodide.FS.mkdirTree('/outputs');
        } catch {
            /* already there */
        }
        nvMod.pyodide.FS.writeFile(vfsPath, seqBytes);
        job.vfsSeqPath = vfsPath;
        _t('after harvested seq write (main VFS)');
        const text = new TextDecoder('utf-8').decode(seqBytes);
        _t(`after TextDecoder (${(text.length / 1024).toFixed(1)}KB)`);
        if (!text.trim()) {
            throw new Error("Prepared .seq file is empty. Run/plot the sequence in the explorer so seq.write() produces content, or use a valid .seq path for the interpreter.");
        }
        return text;
    }

    _getHttpSimBaseUrl(job) {
        return resolveHttpSimBaseUrl(job?.simulation?.httpBaseUrl);
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

    /**
     * Map remote job status → short queue abbreviation.
     * More specific than seq/obj/sim/reco so wake / resample / forward are distinct.
     */
    _httpRemoteStageCaption(status) {
        if (!status || typeof status !== 'object') return null;
        const explicit = String(status.stage || status.phase || status.step || '').toLowerCase();
        const msg = String(status.message || '').toLowerCase();
        const st = String(status.status || '').toLowerCase();
        const work = `${explicit} ${msg}`.trim();

        if (/resamp|reslice|footprint|fov resample/.test(work)) return 'rsmp';
        if (/zenodo|download/.test(work)) return 'dl';
        if (/loading phantom|load(ing)? phantom|convert(ing)? phantom|\bphantom\b|\bbifti\b/.test(work)
            && !/execute|forward|simulat/.test(work)) return 'load';
        if (/imported sequence|import(ing)? sequence|convert seq|\bimport\b/.test(work)) return 'seq';
        if (/pdg2 tables|building .{0,24}tables|building pdg/.test(work)) return 'tbl';
        if (/returning signal|return(ing)? signal/.test(work)) return 'sig';
        if (/forward done|cuda forward|pdg_forward/.test(work)) return 'fwd';
        if (/execute_graph|simulat|scanned\s+\d|forward|\bpdg\b/.test(work)) return 'sim';
        if (/reco|recon/.test(work)) return 'reco';
        if (/^seq$|\bseq\b/.test(explicit) || /\bseq\b/.test(msg)) return 'seq';
        if (status.repetition != null && status.total != null) return 'sim';
        if (/queued|waiting/.test(work) || (st === 'queued' && !work)) return 'queue';
        if ((/\bstart(ing)?\b/.test(work) || st === 'starting') && !/execute|simulat|forward|resamp/.test(work)) {
            return 'start';
        }
        if (st === 'done' || /\bcomplete\b/.test(msg)) return 'getk';
        return null;
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
        const remote = this._httpRemoteStageCaption(status);
        if (remote) {
            const prev = STAGE_CAPTION_ORDER[job.stageCaption] ?? -1;
            const next = STAGE_CAPTION_ORDER[remote] ?? -1;
            if (next >= prev) {
                const detail = String(status.message || status.status || '').trim();
                if (detail) job.stageCaptionDetail = detail;
                if (remote !== job.stageCaption) job.stageCaption = remote;
                this._syncPipelineStageCaption(job);
            }
        }
        const frac = this._parseHttpJobProgress(status);
        if (frac != null) {
            job.simProgressTarget = Math.max(job.simProgressTarget ?? 0, frac);
            this._ensureSimProgressAnimator(job);
        }
        if (status?.message || status?.status || status?.stage) {
            console.log(`${logTag} [http]`, status.stage || '', status.message || status.status);
        }
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
        if (!resp.ok) return { ok: false };
        return await resp.json();
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
        const nvMod = this.ctx.nv;
        const simLogTag = this._jobSimLogTag(job);
        const httpBase = this._getHttpSimBaseUrl(job);
        job.httpBaseUrl = httpBase;
        job.abortSim = false;
        job.status = 'scanning';
        job.pipelineStage = 0;
        job.stageCaption = 'seq';
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
            if (job.simulation?.forwardBackend) {
                options.backend = job.simulation.forwardBackend;
            }
            if (job.simulation?.accuracy != null) {
                options.accuracy = job.simulation.accuracy;
            }
            if (job.simulation?.recon != null) {
                options.recon = job.simulation.recon;
            }
            if (job.simulation?.min_state_mag != null) {
                options.min_state_mag = job.simulation.min_state_mag;
            }
            if (job.simulation?.max_state_count != null) {
                options.max_state_count = job.simulation.max_state_count;
            }
            if (job.simulation?.min_emitted_signal != null) {
                options.min_emitted_signal = job.simulation.min_emitted_signal;
            }
            if (job.simulation?.min_latent_signal != null) {
                options.min_latent_signal = job.simulation.min_latent_signal;
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
            job.stageCaption = 'wake';
            job.stageCaptionDetail = 'Waiting for simulation server';
            this._syncPipelineStageCaption(job);
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
     * Phases D–F for one finished job: fetch NPZ → PyNUFFT recon on the worker → finalize.
     * Runs detached from the poll loop.
     *
     * Orchestration only: the compute steps it drives (`_readSeqMatrixDefinition`,
     * `_reconstructJob`) take and return data, so job state, staging, the viewer load and
     * the error path all live here. The result NPZ is not decoded on the way past — it goes
     * to `_reconstructJob` as bytes and is decoded inside the worker.
     * @param {object} job
     */
    async _httpFinishJob(job) {
        const nvMod = this.ctx.nv;
        const _tFinish = performance.now();
        try {
            if (job.abortSim) throw new Error('user stopped');
            this._stopSimProgressAnimator(job);
            job.simProgressTarget = 1;
            job.simDisplayProgress = 1;
            job.simProgress = 1;
            this._setPipelineStage(job, 3);

            const npzBytes = await this._httpFetchResultNpz(job.httpBaseUrl, job.httpJobId);
            const reconRef = nvMod.generateFovMaskNiftiFromSnapshot(job.fovSnapshot, job.reconMatrix);

            // Sampled after the result fetch, not before it: this reads the live recon checkbox,
            // so hoisting it above a multi-second fetch would change which setting wins.
            const useRecon = typeof nvMod.isScanReconEnabled === 'function'
                ? nvMod.isScanReconEnabled()
                : nvMod.scanRecon?.checked !== false;
            const recoOutPath = typeof nvMod.simReconOutPath === 'function'
                ? nvMod.simReconOutPath(job.id)
                : '/tmp/__sim_pipeline_reco.nii';
            job.reconDone = false;
            job.stageCaption = 'reco';
            this._setPipelineStage(job, 4);
            const seqMatrix = await this._readSeqMatrixDefinition(job, nvMod);
            const recoBytes = await this._reconstructJob({
                npzBytes,
                reconRef,
                useRecon,
                matrix: seqMatrix,
                outPath: recoOutPath,
                logTag: 'HTTP',
            });
            job.reconDone = true;
            this._setPipelineStage(job, 4);

            this._revokeJobObjectUrl(job.niftiUrl);
            this._revokeJobObjectUrl(job.seqUrl);
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
        this._syncPipelineStageCaption(job);
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
                    <div class="item-title">${this._escapeHtml(formatScanDisplayTitle(`${job.baseName}.nii.gz`, job, this.ctx.explorer))}</div>
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
                        <div class="scan-pipeline-stage"${job.stageCaptionDetail ? ` title="${this._escapeAttr(job.stageCaptionDetail)}"` : ''}>${this._escapeHtml(this._pipelineStageCaption(job))}</div>
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

    /**
     * True if a viewer volume or an in-progress download <a> still fetches `url`.
     * loadUrl tags the volume with sourceUrl, and preview/compare re-fetch from it.
     */
    _jobObjectUrlStillHeld(url) {
        const nvs = [
            this.ctx.nv?.nv,
            this.ctx.scanPreview?.nv,
            this.ctx.scanCompare?.module?.nv,
        ];
        for (const nv of nvs) {
            const vols = nv?.volumes;
            if (!vols) continue;
            for (const vol of vols) {
                if ((vol.sourceUrl || vol.url) === url) return true;
            }
        }
        const links = document.getElementsByTagName('a');
        for (const a of links) {
            if (a.href === url) return true;
        }
        return false;
    }

    /** Revoke a createObjectURL result unless a viewer or download link still holds it. */
    _revokeJobObjectUrl(url) {
        if (!url || !String(url).startsWith('blob:')) return;
        if (this._jobObjectUrlStillHeld(url)) return;
        try {
            URL.revokeObjectURL(url);
        } catch (_) { /* already revoked or not a blob URL */ }
    }

    /** Drop job.niftiUrl / job.seqUrl, revoking any blob that nothing still displays. */
    _releaseJobObjectUrls(job) {
        if (!job) return;
        this._revokeJobObjectUrl(job.niftiUrl);
        this._revokeJobObjectUrl(job.seqUrl);
        job.niftiUrl = null;
        job.seqUrl = null;
    }

    removeJob(jobId) {
        const index = this.queue.findIndex(j => j.id === jobId);
        if (index !== -1) {
            this._releaseJobObjectUrls(this.queue[index]);
            this.queue.splice(index, 1);
            this.updateQueueUI();
        }
    }

    async downloadSeq(jobId) {
        const job = this.queue.find(j => j.id === jobId);
        if (!job || !job.vfsSeqPath) return;

        try {
            const nvMod = this.ctx.nv;
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
        if (job?.status === 'done' && this.ctx.scanCompare) {
            await this.ctx.scanCompare.loadFromJob(job);
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
        return formatScanDisplayTitle(vol.name, this.getJobForVolume(vol), this.ctx.explorer);
    }

    /** Native tooltip: full protocol parameters for a scan volume row. */
    getProtocolTooltipForVolume(vol) {
        const n = parseScanNumberFromVolumeName(vol?.name);
        if (n == null) return null;
        return this.ctx.explorer?.getProtocolTooltipForScanNumber?.(n) ?? null;
    }

    /** Tooltip for scan N via protocol file (used by paper plot and volume list). */
    getProtocolTooltipForScanNumber(scanNumber) {
        return this.ctx.explorer?.getProtocolTooltipForScanNumber?.(scanNumber) ?? null;
    }

    async loadJob(jobId, syncFov = true) {
        const job = this.queue.find(j => j.id === jobId);
        if (job && job.status === 'done' && this.ctx.nv) {
            // Planning view only on explicit VIEW SCAN (syncFov=true). Auto-load after SCAN/CROP
            // keeps the current mode (e.g. plot.seq) so the user switches manually.
            if (syncFov && this.ctx.viewManager && this.ctx.viewManager.currentMode !== 'planning') {
                this.ctx.viewManager.setMode('planning');
            }

            const nvMod = this.ctx.nv;
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
        if (this.ctx.viewManager) {
            this.ctx.viewManager.setMode('sequence');
            
            // 2. Prepare the plot container (borrowed from SequenceExplorer)
            if (this.ctx.explorer) {
                const explorer = this.ctx.explorer;
                const plotRoot = explorer.plotTarget || explorer.container;
                const plotContainer = plotRoot.querySelector('#seq-mpl-actual-target');

                // 3. Run Python to read and plot the specific .seq file (ChartGPU or matplotlib per selector)
                const py = this.ctx.nv?.pyodide;
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
