/**
 * Sequence Explorer Widget
 * A modular widget for exploring sequences/protocols organized by file
 * 
 * Usage:
 *   const explorer = new SequenceExplorer('container-id', {
 *     onlySeqPrefix: false,
 *     sources: [...],
 *     onSequenceSelect: (sequence) => { ... }
 *   });
 */

import { eventHub } from "../event_hub.js";
import { formatSimBackendLabel, SIM_BACKENDS } from "../scan_zero/sim_backends.js";
import {
    SEQ_DEFAULT_PLOT_SPEED,
    buildSeqPlotExecuteFragments,
    clearKspaceHostCache,
    disposeSeqChartGpuHost,
    releaseChartgpuPythonPayload,
    releaseKspaceCache,
    resolveSeqPlotSpeed,
    readSeqPlotTimeFromInputs,
    renderSeqChartGpuAfterPlot as mountChartGpuSequencePlot,
} from "./seq_plot.js";

function bindCodeEditorSelectAll(editor, rootEl) {
    const selectAll = () => {
        if (editor?.execCommand) {
            editor.focus();
            editor.execCommand('selectAll');
            return;
        }
        const ta = rootEl.querySelector('textarea');
        if (ta) {
            ta.focus();
            ta.select();
        }
    };

    rootEl.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'a') return;
        const cmInput = editor?.getInputField?.();
        const cmWrap = editor?.getWrapperElement?.();
        const inEditor = rootEl.contains(e.target)
            || (cmInput && document.activeElement === cmInput)
            || (cmWrap && cmWrap.contains(document.activeElement));
        if (!inEditor) return;
        e.preventDefault();
        e.stopPropagation();
        selectAll();
    }, true);

    if (editor?.execCommand) {
        editor.setOption('extraKeys', {
            ...(editor.getOption('extraKeys') || {}),
            'Ctrl-A': selectAll,
            'Cmd-A': selectAll,
        });
    }
}

/**
 * HTML template builders for sequence explorer UI (single file, no extra modules). */
const SEQ_TEMPLATES = {
    plotOptionCheckbox({ id, label, labelId = '', checked = true, title = '' } = {}) {
        const lid = labelId ? ` id="${labelId}"` : '';
        const tit = title ? ` title="${title.replace(/"/g, '&quot;')}"` : '';
        return `<label class="seq-plot-option-label"${lid}${tit}>
                    <input type="checkbox" id="${id}"${checked ? ' checked' : ''}>
                    <span>${label}</span>
                </label>`;
    },
    plotTimeRangeControls() {
        return `<span class="seq-plot-time-range" title="seq.plot time_range — seconds; stop may be inf (full sequence). Re-run plot seq to apply.">
                <span class="seq-plot-time-range-label">time_range</span>
                <input type="number" id="seq-plot-time-start" class="seq-plot-time-input" value="0" step="any" aria-label="time range start" />
                <input type="text" id="seq-plot-time-stop" class="seq-plot-time-input" value="inf" inputmode="decimal" aria-label="time range stop" />
            </span>`;
    },
    showConsoleCheckbox() {
        return `<label style="display: flex; align-items: center; cursor: pointer; font-size: 0.875rem; color: var(--text); margin-left: auto;">
                <input type="checkbox" id="seq-show-console-checkbox" style="margin-right: 0.5rem; cursor: pointer; width: 1rem; height: 1rem;">
                <span>show console</span>
            </label>`;
    },
    errorDisplay() {
        return `<div id="seq-error-display" class="seq-error-message" style="display: none;" role="alert">
                <div class="seq-error-text"></div>
                <button type="button" class="seq-error-dismiss" title="Dismiss" aria-label="Dismiss error"><i class="bi bi-x-lg" aria-hidden="true"></i></button>
            </div>`;
    },
    mainLayout(showConsoleHtml) {
        return `<div id="seq-plot-output" class="seq-plot-container">
                <div id="seq-mpl-actual-target" class="mpl-figure-container">
                </div>
            </div>
            <div class="seq-explorer-panes">
                <div class="seq-explorer-left-pane">
                    <div id="seq-explorer-section">
                        <div class="seq-explorer-controls" style="margin-bottom: 0.5rem; display: flex; justify-content: flex-end;">
                            ${showConsoleHtml}
                        </div>
                        <div id="seq-tree" class="seq-explorer-tree"></div>
                    </div>
                </div>
                <div class="seq-explorer-right-pane">
                    <div id="seq-params-section">
                        ${SEQ_TEMPLATES.protocolHeader({ popSeq: true })}
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem; padding-top: 0.5rem; border-top: 1px solid var(--border);">
                            ${SEQ_TEMPLATES.plotOptionCheckbox({ id: 'seq-dark-plot-checkbox', label: 'Dark plot' })}
                            ${SEQ_TEMPLATES.plotOptionCheckbox({
                                id: 'seq-show-kspace-checkbox',
                                label: 'Show k-space',
                                labelId: 'seq-show-kspace-label',
                                title: 'ChartGPU only: kx–ky and ky–kz follow waveform time zoom',
                            })}
                            ${SEQ_TEMPLATES.plotTimeRangeControls()}
                            <select id="seq-plot-speed-selector" style="padding: 0.25rem; background: rgba(255, 255, 255, 0.08); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font-size: 0.75rem; cursor: pointer;">
                                <option value="full">Full plot</option>
                                <option value="fast">Fast plot</option>
                                <option value="faster">Faster plot</option>
                                <option value="chartgpu" selected>ChartGPU</option>
                            </select>
                        </div>
                        ${SEQ_TEMPLATES.errorDisplay()}
                        <div id="seq-params-controls"></div>
                    </div>
                </div>
            </div>
            <div id="seq-console-section" class="console-section">
                <h2 class="section-title">
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" style="width: 1rem; height: 1rem; display: inline-block; vertical-align: middle; margin-right: 0.4rem;"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                    Console Output
                </h2>
                <div id="seq-console-output" class="console"></div>
                <div id="seq-package-versions" class="versions">
                    <span><strong>Pyodide:</strong> <span id="seq-pyodide-version">loading...</span></span>
                    <span><strong>NumPy:</strong> <span id="seq-numpy-version">loading...</span></span>
                    <span><strong>Matplotlib:</strong> <span id="seq-matplotlib-version">loading...</span></span>
                    <span><strong>PyPulseq:</strong> <span id="seq-pypulseq-version">loading...</span></span>
                    <span><strong>mrseq:</strong> <span id="seq-mrseq-version">loading...</span></span>
                    <span><strong>ISMRMRD:</strong> <span id="seq-ismrmrd-version">loading...</span></span>
                </div>
            </div>`;
    },
    mobileRunButtons() {
        return `<div id="seq-mobile-run-btns" class="seq-mobile-run-btns" aria-label="Run scan">
                    <div id="seq-mobile-pipeline-status" class="seq-mobile-pipeline-status" hidden aria-hidden="true"></div>
                    <div class="seq-mobile-run-btns-group">
                    <button id="seq-mobile-crop" type="button" class="scan-btn scan-btn-compact scan-btn-secondary" title="Resample first volume to FOV (crop to box)">CROP</button>
                    <button id="seq-mobile-scan" type="button" class="scan-btn scan-btn-compact" title="Run scan">SCAN<span class="icon">▶</span></button>
                    <button id="seq-mobile-scan-settings" type="button" class="scan-btn scan-btn-compact scan-btn-settings" title="Simulation backend" aria-label="Simulation backend"><i class="bi bi-gear" aria-hidden="true"></i></button>
                    </div>
                </div>`;
    },
    /** Protocol panel header: title + actions on one row; path + name on the line below. */
    protocolHeader({ btnClass = false, popSeq = false, mobileRun = false } = {}) {
        const btn = (id, label, primary = false) => btnClass
            ? `<button id="${id}" class="btn btn-secondary btn-md${primary ? ' seq-btn-primary' : ''}">${label}</button>`
            : `<button id="${id}" style="padding: 0.4rem 0.32rem; background: ${primary ? 'var(--accent)' : 'rgba(255, 255, 255, 0.08)'}; color: ${primary ? 'white' : 'var(--text, #ddd)'}; border: ${primary ? 'none' : '1px solid var(--border, #333)'}; border-radius: 4px; cursor: pointer; font-size: ${primary ? '0.875rem' : '0.75rem'}; font-weight: 500;">${label}</button>`;
        const shareBtn = btnClass
            ? `<button id="seq-share-btn" class="btn btn-secondary btn-md" title="share sequence protocol&#10;This will share the protocol including either sequence source code, or versioned dependency to the base sequence." aria-label="share sequence protocol"><i class="bi bi-share" aria-hidden="true"></i></button>`
            : `<button id="seq-share-btn" title="share sequence protocol&#10;This will share the protocol including either sequence source code, or versioned dependency to the base sequence." aria-label="share sequence protocol" style="padding: 0.28rem 0.38rem; background: rgba(255, 255, 255, 0.08); color: var(--text, #ddd); border: 1px solid var(--border, #333); border-radius: 4px; cursor: pointer; font-size: 0.75rem; font-weight: 500;"><i class="bi bi-share" aria-hidden="true"></i></button>`;
        const lightShareBtn = btnClass
            ? `<button id="seq-light-share-btn" class="btn btn-secondary btn-md" title="share temporary protocol&#10;This will share the protocol assuming underlying sequence stays the same. This might break when seq packages are updated." aria-label="share temporary protocol" style="border-style: dashed;"><i class="bi bi-share" aria-hidden="true" style="color: #7db7ff;"></i></button>`
            : `<button id="seq-light-share-btn" title="share temporary protocol&#10;This will share the protocol assuming underlying sequence stays the same. This might break when seq packages are updated." aria-label="share temporary protocol" style="padding: 0.28rem 0.38rem; background: rgba(255, 255, 255, 0.08); color: var(--text, #ddd); border: 1px dashed var(--border, #333); border-radius: 4px; cursor: pointer; font-size: 0.75rem; font-weight: 500;"><i class="bi bi-share" aria-hidden="true" style="color: #7db7ff;"></i></button>`;
        const actions = `
                    <div class="seq-params-header-actions">
                        <div class="seq-params-header-btns">
                            ${btn('seq-get-fov-btn', '↖ set FOV')}
                            ${btn('seq-edit-btn', 'edit code')}
                            ${btn('seq-execute-btn', 'plot seq', true)}
                            ${popSeq ? btn('seq-pop-btn', 'pop seq') : ''}
                        </div>
                        ${mobileRun ? SEQ_TEMPLATES.mobileRunButtons() : ''}
                    </div>`;
        return `<div class="seq-params-header">
                    <div class="seq-params-header-row">
                        <div style="display: flex; align-items: center; gap: 0.35rem;">
                            <h3 class="section-title" style="margin: 0;">Protocol</h3>
                            ${lightShareBtn}
                            ${shareBtn}
                        </div>
                        ${actions}
                    </div>
                    <div id="seq-current-name" class="seq-current-name" title=""></div>
                </div>`;
    },
    paramsSection() {
        return `<div id="seq-params-section">
                ${SEQ_TEMPLATES.protocolHeader({ btnClass: true, mobileRun: true })}
                ${SEQ_TEMPLATES.errorDisplay()}
                <div id="seq-params-controls"></div>
            </div>`;
    },
    plotSection() {
        return `<div id="seq-plot-output" class="seq-plot-container">
                <div id="seq-mpl-actual-target" class="mpl-figure-container">
                </div>
            </div>
            <div class="seq-plot-options-row" style="display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 0.5rem 0.75rem; margin-top: 0.5rem; padding: 0.5rem; background: rgba(0,0,0,0.2); border-radius: 4px;">
                ${SEQ_TEMPLATES.plotOptionCheckbox({ id: 'seq-dark-plot-checkbox', label: 'Dark plot' })}
                ${SEQ_TEMPLATES.plotOptionCheckbox({
                    id: 'seq-show-kspace-checkbox',
                    label: 'Show k-space',
                    labelId: 'seq-show-kspace-label',
                    title: 'ChartGPU only: kx–ky and ky–kz follow waveform time zoom',
                })}
                ${SEQ_TEMPLATES.plotTimeRangeControls()}
                <select id="seq-plot-speed-selector" style="padding: 0.25rem; background: rgba(255, 255, 255, 0.08); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font-size: 0.75rem; cursor: pointer;">
                    <option value="full">Full plot</option>
                    <option value="fast">Fast plot</option>
                    <option value="faster">Faster plot</option>
                    <option value="chartgpu" selected>ChartGPU</option>
                </select>
            </div>`;
    },
    treeHeading(showFilter, filterChecked) {
        const filterHtml = showFilter
            ? `<label class="seq-plot-option-label">
                        <input type="checkbox" id="seq-filter-checkbox" ${filterChecked ? 'checked' : ''}>
                        <span>Only seq_/prot_ or main</span>
                    </label>`
            : '';
        return `<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; flex-wrap: wrap; gap: 0.5rem;">
                <h3 class="section-title" style="margin: 0;">Sequences</h3>
                <div style="display: flex; align-items: center; gap: 0.75rem;">
                    ${filterHtml}
                    <button id="seq-add-sources-btn" class="btn btn-secondary btn-sm">
                        Add Sources
                    </button>
                </div>
            </div>`;
    }
};

export async function patchSequencePlotFromCode(pyodide, plotUtilsCode) {
    await pyodide.runPythonAsync(plotUtilsCode);
    await pyodide.runPythonAsync('patch_pypulseq()');
}

/** Fetch seq_plot_utils.py and patch pypulseq.Sequence.plot (blocks main thread while Python runs). */
export async function patchSequencePlot(pyodide, resolvePath) {
    const url = typeof resolvePath === 'function'
        ? resolvePath('seq_plot_utils.py')
        : 'pypulseq/seq_plot_utils.py';
    const response = await fetch(`${url}?${Date.now()}`);
    if (!response.ok) throw new Error(`Could not load seq_plot_utils.py: ${response.status}`);
    const plotUtilsCode = await response.text();
    await patchSequencePlotFromCode(pyodide, plotUtilsCode);
}

export class SequenceExplorer {
    /** Default plot speed (must match `SEQ_DEFAULT_PLOT_SPEED` and template `selected` option). */
    static DEFAULT_PLOT_SPEED = SEQ_DEFAULT_PLOT_SPEED;

    constructor(containerId, config = {}) {
        this.container = typeof containerId === 'string' 
            ? document.getElementById(containerId) 
            : containerId;
        
        // If containerId is provided but not found, throw error.
        // If containerId is null, we assume modular rendering via renderTree/Params/Plot.
        if (containerId !== null && !this.container) {
            throw new Error(`Container not found: ${containerId}`);
        }

        // Module slots
        this.treeTarget = null;
        this.paramsTarget = null;
        this.plotTarget = null;
        this.consoleTarget = null;
        
        // Determine base path from the module URL
        const moduleUrl = import.meta.url;
        const defaultBasePath = moduleUrl.substring(0, moduleUrl.lastIndexOf('/') + 1);
        
        // Configuration
        this.config = {
            basePath: config.basePath !== undefined ? config.basePath : defaultBasePath,
            onlySeqPrefix: config.onlySeqPrefix !== undefined ? config.onlySeqPrefix : true,
            sources: config.sources || [],
            onSequenceSelect: config.onSequenceSelect || null,
            onFunctionStart: config.onFunctionStart || null,
            onFunctionExecute: config.onFunctionExecute || null,
            pyodide: config.pyodide || null,
            showRefresh: config.showRefresh !== undefined ? config.showRefresh : true,
            showFilter: config.showFilter !== undefined ? config.showFilter : true,
            ...config
        };
        
        // State
        this.sequences = {}; // { fileName: { functions: [...], source: '...' } }
        this.selectedSequence = null;
        this.filterSeqPrefix = this.config.onlySeqPrefix;
        this.installedPackages = new Set(); // Track installed packages to avoid reinstalling
        this.defaultInterpreterSeqPath = null; // Preloaded default .seq path for interpreter
        this._plotStackReady = null; // Promise: plot patch complete (set by bootstrap; await before first plot)
        this._seqChartGpuDisconnect = null;
        this._seqChartGpuCharts = null;
        this._seqChartGpuDevice = null;
        this._seqChartGpuAdapter = null;
        /** @type {(() => void) | null} removes WebGPU device uncapturederror/lost listeners */
        this._seqChartGpuRemoveDeviceListeners = null;
        /** Full Python traceback from the last failed executeFunction (silent scan prep reads this). */
        this._lastExecutionError = null;
        
        // Initialize UI
        if (containerId) {
            this.render();
        }
        
        // Load sequences if sources are provided
        if (this.config.sources.length > 0) {
            this.loadSequences();
        }

        // Shared state bus
        eventHub.on('fov_changed', (data) => {
            const fovParams = ['fov_x', 'fov_y', 'fov_z', 'off_x', 'off_y', 'off_z', 'rot_x', 'rot_y', 'rot_z'];
            fovParams.forEach(p => {
                if (data[p] !== undefined) {
                    this.updateParamValue(p, data[p]);
                }
            });
        });
    }

    renderParams(target) {
        this.paramsTarget = typeof target === 'string' ? document.getElementById(target) : target;
        if (!this.paramsTarget) throw new Error(`Params target not found: ${target}`);
        this.paramsTarget.innerHTML = SEQ_TEMPLATES.paramsSection();

        // Bind events for the buttons in params section
        const executeBtn = this.paramsTarget.querySelector('#seq-execute-btn');
        if (executeBtn) {
            executeBtn.addEventListener('click', () => this.executeFunction());
        }
        const editBtn = this.paramsTarget.querySelector('#seq-edit-btn');
        if (editBtn) {
            editBtn.addEventListener('click', () => this.showCodeEditor());
        }
        const shareBtn = this.paramsTarget.querySelector('#seq-share-btn');
        if (shareBtn) {
            shareBtn.addEventListener('click', () => this.shareCurrentProtocol());
        }
        const lightShareBtn = this.paramsTarget.querySelector('#seq-light-share-btn');
        if (lightShareBtn) {
            lightShareBtn.addEventListener('click', () => this.shareCurrentLightLink());
        }
        const getFovBtn = this.paramsTarget.querySelector('#seq-get-fov-btn');
        if (getFovBtn) {
            getFovBtn.addEventListener('click', () => this.getFovFromSequence());
        }

        this.updateShareButtonVisibility();
        this._bindMobileScanButtons(this.paramsTarget);
        this._bindErrorDisplay(this.paramsTarget);
    }

    _bindMobileScanButtons(root) {
        const crop = root.querySelector('#seq-mobile-crop');
        const scan = root.querySelector('#seq-mobile-scan');
        const settings = root.querySelector('#seq-mobile-scan-settings');
        if (crop) crop.addEventListener('click', () => window.scanModule?.startCrop?.());
        if (scan) scan.addEventListener('click', () => window.scanModule?.startScan?.());
        if (settings) settings.addEventListener('click', () => window.scanModule?.openSimSettingsDialog?.());
    }

    async renderPlot(target) {
        this.plotTarget = typeof target === 'string' ? document.getElementById(target) : target;
        if (!this.plotTarget) throw new Error(`Plot target not found: ${target}`);
        await this.disposeSeqChartGpu();
        this.plotTarget.innerHTML = SEQ_TEMPLATES.plotSection();

        // Initialize plotting infrastructure for this target
        this.initPlottingInfrastructure();
        this.syncPlotSpeedKspaceCheckbox(this.plotTarget);
        const plotSpeedSel = this.plotTarget.querySelector('#seq-plot-speed-selector');
        if (plotSpeedSel) {
            plotSpeedSel.addEventListener('change', () => this.syncPlotSpeedKspaceCheckbox(this.plotTarget));
        }
    }

    updateParamValue(name, value) {
        // Try to find the input in paramsTarget first, then fall back to container
        const root = this.paramsTarget || this.container;
        const input = root.querySelector(`#seq-param-${name}`);
        if (input) {
            if (input.type === 'checkbox') {
                input.checked = !!value;
            } else {
                input.value = value;
            }
            // Trigger input event to ensure any internal state is updated
            input.dispatchEvent(new Event('input'));
            this._emitProtocolParamsChanged();
        }
    }

    _emitProtocolParamsChanged() {
        if (!this.selectedSequence) return;
        eventHub.emit('protocolParamsChanged', {
            fileName: this.selectedSequence.fileName,
            functionName: this.selectedSequence.functionName,
        });
    }

    _bindProtocolParamInput(input) {
        if (!input) return;
        const handler = () => this._emitProtocolParamsChanged();
        input.addEventListener('input', handler);
        input.addEventListener('change', handler);
    }
    
    resolvePath(path) {
        // If it's a full URL or absolute path, return it as is
        if (path.includes('://') || path.startsWith('/')) {
            return path;
        }
        // Otherwise, prefix with basePath
        return this.config.basePath + path;
    }

    /** Normalize a sequence file key to an absolute Pyodide VFS path. */
    vfsPath(fileName) {
        const p = String(fileName || '').replace(/\\/g, '/').replace(/^\/+/, '');
        return p ? `/${p}` : '/';
    }

    isUserArtifactPath(path) {
        const p = this.normalizeUserArtifactPath(path);
        return p.startsWith('user/seq/') || p.startsWith('user/prot/');
    }

    normalizeUserArtifactPath(path) {
        return String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    }

    getUserArtifactCodeFromCache(path) {
        const norm = this.normalizeUserArtifactPath(path);
        if (!this.isUserArtifactPath(norm)) return null;
        return this.sequences[norm]?.code || null;
    }

    async getUserArtifactCode(path) {
        const cached = this.getUserArtifactCodeFromCache(path);
        if (cached) return cached;
        const norm = this.normalizeUserArtifactPath(path);
        if (!this.config.pyodide || !this.isUserArtifactPath(norm)) return null;
        try {
            const result = await this.config.pyodide.runPythonAsync(`
import sys
import json
path = ${JSON.stringify(norm)}
code = ''
if hasattr(sys.modules['__main__'], '_user_edited_files'):
    code = sys.modules['__main__']._user_edited_files.get(path, '')
json.dumps(code)
`);
            const fileCode = JSON.parse(result);
            return fileCode || null;
        } catch (_) {
            return null;
        }
    }

    sourceIdentity(source) {
        const p = this.getSourcePath(source);
        if (p) return String(p).replace(/\\/g, '/');
        return JSON.stringify({
            type: source?.type || '',
            name: source?.name || '',
            module: source?.module || '',
            url: source?.url || '',
        });
    }

    dedupeSources(sources) {
        const seen = new Set();
        const out = [];
        for (const source of sources || []) {
            const id = this.sourceIdentity(source);
            if (!id || seen.has(id)) continue;
            seen.add(id);
            out.push(source);
        }
        return out;
    }

    /** Drop legacy browser persistence for user/prot and user/seq (session-only now). */
    clearLegacyUserArtifactStorage() {
        try {
            localStorage.removeItem('seq_explorer_user_files_v1');
            localStorage.removeItem('seq_explorer_user_sources_v1');
        } catch (_) { /* ignore */ }
    }

    _bytesToBase64Url(bytes) {
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    _base64UrlToBytes(s) {
        const b64 = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
        const bin = atob(padded);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    }

    async _gzipString(text) {
        if (typeof CompressionStream !== 'function') {
            throw new Error('Protocol sharing requires a browser with CompressionStream support.');
        }
        const stream = new Blob([new TextEncoder().encode(text)])
            .stream()
            .pipeThrough(new CompressionStream('gzip'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    async _gunzipString(bytes) {
        if (typeof DecompressionStream !== 'function') {
            throw new Error('Shared protocol import requires a browser with DecompressionStream support.');
        }
        const stream = new Blob([bytes])
            .stream()
            .pipeThrough(new DecompressionStream('gzip'));
        return new TextDecoder().decode(await new Response(stream).arrayBuffer());
    }

    _sanitizeProtocolShareFilename(name) {
        let base = String(name || 'shared_protocol.py')
            .replace(/\\/g, '/')
            .split('/')
            .pop()
            .replace(/[<>:"/\\|?*]/g, '_')
            .replace(/\s+/g, '_')
            .replace(/^_+|_+$/g, '');
        if (!base) base = 'shared_protocol.py';
        if (!base.endsWith('.py')) base += '.py';
        if (!base.startsWith('prot_') && !/^\d+_prot_/.test(base)) base = `prot_${base}`;
        return `user/prot/${base}`;
    }

    async _validateSharedProtocolCode(code) {
        if (!this.extractTomlBlockFromCode(code)) throw new Error('Shared protocol has no PEP 723 script block.');
        const parsed = await this.parseCodeMetadata(code);
        if (parsed?.anyfield?.kind !== 'protocol') {
            throw new Error('Shared script is not an AnyField protocol.');
        }
        const fn = parsed?.anyfield?.prot_func;
        if (!fn || !String(fn).startsWith('prot_')) {
            throw new Error('Shared protocol entry must point to a prot_* function.');
        }
        return { parsed, functionName: fn };
    }

    async _makeProtocolSharePayload(fileName, code) {
        await this._validateSharedProtocolCode(code);
        const payload = {
            v: 1,
            kind: 'anyfield.protocol',
            filename: String(fileName || 'shared_protocol.py').replace(/\\/g, '/').split('/').pop(),
            code,
        };
        const gz = await this._gzipString(JSON.stringify(payload));
        return this._bytesToBase64Url(gz);
    }

    async importSharedProtocolPayload(encoded) {
        if (!encoded) return null;
        const payloadText = await this._gunzipString(this._base64UrlToBytes(encoded));
        const payload = JSON.parse(payloadText);
        if (payload?.v !== 1 || payload?.kind !== 'anyfield.protocol' || typeof payload.code !== 'string') {
            throw new Error('Unsupported shared protocol payload.');
        }
        const { functionName } = await this._validateSharedProtocolCode(payload.code);
        const finalFileName = this._sanitizeProtocolShareFilename(payload.filename);
        const tomlConfig = await this.parseCodeMetadata(payload.code);
        const source = {
            name: 'User Protocols',
            itemKind: 'protocol',
            type: 'file',
            path: finalFileName,
            fullModulePath: finalFileName.replace(/\.py$/i, '').replace(/\//g, '.'),
            description: 'Shared Protocol Capsule',
            isUserEdited: true,
            displayName: this.protocolDisplayNameFromPath(finalFileName),
            dependencies: tomlConfig.dependencies || [],
            micropip_no_deps: tomlConfig.micropip_no_deps || [],
            anyfield: tomlConfig.anyfield || {},
        };
        await this.storeUserFile(finalFileName, payload.code);
        const sourceIndex = this.config.sources.findIndex((s) => this.getSourcePath(s) === finalFileName);
        if (sourceIndex >= 0) this.config.sources[sourceIndex] = source;
        else this.config.sources.push(source);
        await this.parseFile(finalFileName, payload.code, source);
        this._sharedProtocolSelection = { fileName: finalFileName, functionName };
        return this._sharedProtocolSelection;
    }

    getSharedProtocolPayloadFromLocation() {
        const hash = String(window.location.hash || '').replace(/^#/, '');
        const hashParams = new URLSearchParams(hash);
        return hashParams.get('protocol_gz') || hashParams.get('compressed_prot') || '';
    }

    async importSharedProtocolFromLocation() {
        if (this._skipSharedImport) return false;
        const encoded = this.getSharedProtocolPayloadFromLocation();
        if (!encoded) return false;
        try {
            await this.importSharedProtocolPayload(encoded);
            this.showStatus('Imported shared protocol', 'success');
            return true;
        } catch (e) {
            console.error('Could not import shared protocol:', e);
            this.showStatus(`Could not import shared protocol: ${e.message}`, 'error');
            return false;
        }
    }

    buildCleanShareBaseUrl({ preservePro = true } = {}) {
        const url = new URL(window.location.href);
        const pro = url.searchParams.get('pro');
        url.search = '';
        url.hash = '';
        if (preservePro && pro) url.searchParams.set('pro', pro);
        return url;
    }

    /**
     * UI-faithful simulation state for sharing (both capsule + light URL): the active
     * bifti phantom id, sim backend, recon-grid FOV (`fov_affine` + `fov_matrix`) and the
     * scan-resolution bundle (`phantom_matrix` base, `phantom_oversample`, `recon_matrix`).
     * Reads the live viewer/scan modules; skips missing fields; null when nothing is available.
     */
    collectSimulationShareMeta() {
        const nvMod = window.nvModule;
        const scanModule = window.scanModule;
        const meta = {};
        try {
            const phantom = typeof scanModule?.getActiveBiftiId === 'function'
                ? scanModule.getActiveBiftiId()
                : (nvMod?.getActivePhantomGroup?.()?.biftiRegistryId ?? null);
            if (phantom) meta.phantom = String(phantom);
        } catch (_) { /* ignore */ }
        try {
            const backend = scanModule?.getSelectedSimBackendId?.();
            if (backend) meta.backend = backend;
        } catch (_) { /* ignore */ }
        try {
            const fov = nvMod?.getFovAffineShareMeta?.();
            if (fov?.fov_affine) {
                meta.fov_affine = fov.fov_affine;
                meta.fov_matrix = fov.fov_matrix;
            }
        } catch (_) { /* ignore */ }
        try {
            const res = nvMod?.getScanResolutionShareMeta?.();
            if (res) {
                if (res.phantom_matrix) meta.phantom_matrix = res.phantom_matrix;
                if (res.phantom_oversample) meta.phantom_oversample = res.phantom_oversample;
                if (res.recon_matrix) meta.recon_matrix = res.recon_matrix;
            }
        } catch (_) { /* ignore */ }
        return Object.keys(meta).length ? meta : null;
    }

    /** Map `collectSimulationShareMeta()` output into `{ simulation, recon }` TOML sections. */
    _shareMetaToTomlSections(meta) {
        if (!meta) return null;
        const simulation = {};
        if (meta.backend) simulation.backend = meta.backend;
        if (meta.phantom) simulation.phantom = meta.phantom;
        if (meta.fov_affine) simulation.fov_affine = meta.fov_affine;
        if (meta.fov_matrix) simulation.fov_matrix = meta.fov_matrix;
        if (meta.phantom_matrix) simulation.phantom_matrix = meta.phantom_matrix;
        if (meta.phantom_oversample) simulation.phantom_oversample = meta.phantom_oversample;
        const sections = {};
        if (Object.keys(simulation).length) sections.simulation = simulation;
        if (meta.recon_matrix) sections.recon = { matrix: meta.recon_matrix, method: 'anyfield-pynufft' };
        return Object.keys(sections).length ? sections : null;
    }

    /**
     * Normalize a shared simulation bundle (from a protocol's `[simulation]` block or from
     * URL params) into the flat share-meta shape used by `applySimulationStateFromMeta`.
     * `recon_matrix` is taken from `[recon].matrix` when not on the simulation block.
     */
    normalizeSharedSimMeta(simulation, recon) {
        if (!simulation && !recon) return null;
        const sim = simulation || {};
        const out = {};
        if (sim.backend != null) out.backend = String(sim.backend);
        if (sim.phantom != null) out.phantom = String(sim.phantom);
        if (Array.isArray(sim.fov_affine)) out.fov_affine = sim.fov_affine.map(Number);
        if (Array.isArray(sim.fov_matrix)) out.fov_matrix = sim.fov_matrix.map(Number);
        if (Array.isArray(sim.phantom_matrix)) out.phantom_matrix = sim.phantom_matrix.map(Number);
        if (Array.isArray(sim.phantom_oversample)) out.phantom_oversample = sim.phantom_oversample.map(Number);
        if (Array.isArray(sim.recon_matrix)) out.recon_matrix = sim.recon_matrix.map(Number);
        else if (recon && Array.isArray(recon.matrix)) out.recon_matrix = recon.matrix.map(Number);
        return Object.keys(out).length ? out : null;
    }

    /**
     * Apply a shared simulation-state bundle to the live viewer/scan modules: set the sim
     * backend, apply the scan-resolution sliders, (optionally) load the phantom by id, then
     * restore the FOV box (which needs a loaded reference volume). All steps are best-effort;
     * failures are surfaced via `showStatus` and do not abort the rest.
     * @param {object} sim flat share-meta (see `collectSimulationShareMeta`).
     * @param {object} [opts]
     * @param {boolean} [opts.loadPhantom=true] set false when the phantom is already loaded.
     */
    async applySimulationStateFromMeta(sim, { loadPhantom = true } = {}) {
        if (!sim || typeof sim !== 'object') return;
        const nvMod = window.nvModule;
        const scanModule = window.scanModule;
        if (sim.backend && typeof scanModule?.setSelectedSimBackendId === 'function') {
            const spec = SIM_BACKENDS[sim.backend];
            if (!spec) {
                console.warn('[share] ignoring unknown shared backend', sim.backend);
            } else if (spec.proOnly && !window.pro) {
                console.warn('[share] shared backend is pro-only; keeping current backend', sim.backend);
            } else {
                try {
                    scanModule.setSelectedSimBackendId(sim.backend);
                } catch (e) {
                    console.warn('[share] ignoring shared backend', sim.backend, e?.message || e);
                }
            }
        }
        // Scan-resolution BEFORE FOV so the recon grid matches fov_matrix.
        try {
            nvMod?.applyScanResolutionSettings?.(sim);
        } catch (e) {
            console.warn('[share] scan-resolution apply failed', e);
        }
        let haveVolume = !!nvMod?.nv?.volumes?.length;
        if (loadPhantom && sim.phantom && typeof nvMod?.loadPhantomFromCache === 'function') {
            try {
                await nvMod.loadPhantomFromCache(sim.phantom);
                haveVolume = true;
            } catch (e) {
                console.warn('[share] shared phantom cache load failed', sim.phantom, e);
                this.showStatus?.(`Shared phantom "${sim.phantom}" not found; keeping current phantom`, 'error');
                if (!haveVolume && typeof nvMod?.loadDefaultCachePhantom === 'function') {
                    try { await nvMod.loadDefaultCachePhantom(); haveVolume = true; } catch (_) { /* ignore */ }
                }
            }
        } else if (!loadPhantom && this._sharedPhantomPromise) {
            // index.html already kicked off the shared phantom load; wait so FOV has a reference volume.
            try { await this._sharedPhantomPromise; } catch (_) { /* ignore */ }
            haveVolume = !!nvMod?.nv?.volumes?.length;
        }
        if (haveVolume && Array.isArray(sim.fov_affine) && Array.isArray(sim.fov_matrix)
            && typeof nvMod?.applyFovFromAffine === 'function') {
            try {
                nvMod.applyFovFromAffine(sim.fov_affine, sim.fov_matrix);
            } catch (e) {
                console.warn('[share] FOV restore failed', e);
            }
        }
    }

    /** Approximate FOV size in mm from a flat 4×4 affine (row-major) + matrix ([nx,ny,nz]). */
    _fovMmFromAffineMatrix(affine, matrix) {
        if (!Array.isArray(affine) || affine.length < 12 || !Array.isArray(matrix) || matrix.length < 3) return null;
        const col = (c) => Math.hypot(Number(affine[c]), Number(affine[4 + c]), Number(affine[8 + c]));
        return [col(0) * Number(matrix[0]), col(1) * Number(matrix[1]), col(2) * Number(matrix[2])];
    }

    /**
     * Non-committing preview of a shared link for the startup confirmation dialog.
     * Returns null when no shared link (capsule hash or light-URL params) is present.
     * Capsule preview uses gunzip + `extractAnyfieldJsonFromCode` (pure JS, no Pyodide,
     * no `storeUserFile`), so nothing is imported until the user accepts.
     */
    async previewSharedImport() {
        const encoded = this.getSharedProtocolPayloadFromLocation();
        if (encoded) {
            try {
                const payloadText = await this._gunzipString(this._base64UrlToBytes(encoded));
                const payload = JSON.parse(payloadText);
                const code = typeof payload?.code === 'string' ? payload.code : '';
                const anyfield = code ? (this.extractAnyfieldJsonFromCode(code) || {}) : {};
                const sim = anyfield.simulation || {};
                const filename = this._sanitizeProtocolShareFilename(payload?.filename || 'shared_protocol.py');
                const simMeta = this.normalizeSharedSimMeta(anyfield.simulation, anyfield.recon);
                return {
                    source: 'capsule',
                    protocolName: this.protocolDisplayNameFromPath(filename) || filename,
                    sequenceName: this.getProtocolDisplayNameFromSeqFuncFile(anyfield.seq_func) || anyfield.prot_func || '',
                    phantom: sim.phantom || null,
                    backend: sim.backend || null,
                    fovMm: this._fovMmFromAffineMatrix(sim.fov_affine, sim.fov_matrix),
                    fov_matrix: Array.isArray(sim.fov_matrix) ? sim.fov_matrix : null,
                    phantom_matrix: Array.isArray(sim.phantom_matrix) ? sim.phantom_matrix : null,
                    phantom_oversample: Array.isArray(sim.phantom_oversample) ? sim.phantom_oversample : null,
                    recon_matrix: simMeta?.recon_matrix || null,
                    simMeta,
                };
            } catch (e) {
                console.warn('previewSharedImport: capsule decode failed', e);
                return null;
            }
        }
        const p = new URLSearchParams(window.location.search);
        const sFile = (p.get('s_file') || '').trim();
        const sFunc = (p.get('s_func') || '').trim();
        const sCat = (p.get('s_category') || '').trim();
        const phantom = (p.get('phantom') || '').trim();
        // Numeric arrays are shared as bare comma lists (see buildLightShareUrl / _formatShareNumberList).
        const parseArr = (k) => {
            const v = p.get(k);
            if (!v) return null;
            const nums = String(v).split(',').map(Number);
            return nums.length && nums.every(Number.isFinite) ? nums : null;
        };
        const fov_affine = parseArr('fov_affine');
        const fov_matrix = parseArr('fov_matrix');
        const phantom_matrix = parseArr('phantom_matrix');
        const phantom_oversample = parseArr('phantom_oversample');
        const recon_matrix = parseArr('recon_matrix');
        const hasShared = (sCat && sFile && sFunc) || !!phantom || !!fov_affine;
        if (!hasShared) return null;
        const simMeta = {};
        if (phantom) simMeta.phantom = phantom;
        if (fov_affine) simMeta.fov_affine = fov_affine;
        if (fov_matrix) simMeta.fov_matrix = fov_matrix;
        if (phantom_matrix) simMeta.phantom_matrix = phantom_matrix;
        if (phantom_oversample) simMeta.phantom_oversample = phantom_oversample;
        if (recon_matrix) simMeta.recon_matrix = recon_matrix;
        return {
            source: 'url',
            protocolName: sFile || '',
            sequenceName: sFunc || '',
            phantom: phantom || null,
            backend: null,
            fovMm: this._fovMmFromAffineMatrix(fov_affine, fov_matrix),
            fov_matrix,
            phantom_matrix,
            phantom_oversample,
            recon_matrix,
            simMeta: Object.keys(simMeta).length ? simMeta : null,
        };
    }

    /**
     * Startup confirmation modal summarizing a shared link. Resolves `'shared'` (accept) or
     * `'default'` (ignore shared, load defaults). Backdrop / Escape resolve `'default'`.
     * @param {object} summary from `previewSharedImport()`
     * @returns {Promise<'shared'|'default'>}
     */
    showSharedImportDialog(summary) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (choice) => {
                if (settled) return;
                settled = true;
                document.removeEventListener('keydown', onKey);
                overlay.remove();
                resolve(choice);
            };

            const fmtArr = (a) => (Array.isArray(a) ? `[${a.map((v) => Math.round(Number(v) * 100) / 100).join(', ')}]` : '—');
            const rows = [];
            if (summary.protocolName) rows.push(['Protocol', summary.protocolName]);
            if (summary.sequenceName) rows.push(['Sequence', summary.sequenceName]);
            if (summary.phantom) rows.push(['Phantom', summary.phantom]);
            if (summary.fovMm) {
                const size = summary.fovMm.map((v) => Math.round(v)).join(' × ');
                const mtx = Array.isArray(summary.fov_matrix) ? `, matrix ${summary.fov_matrix.join(' × ')}` : '';
                rows.push(['FOV', `${size} mm${mtx}`]);
            } else if (summary.fov_matrix) {
                rows.push(['FOV matrix', fmtArr(summary.fov_matrix)]);
            }
            if (summary.phantom_matrix) {
                let s = fmtArr(summary.phantom_matrix);
                if (summary.phantom_oversample) s += ` × oversample ${fmtArr(summary.phantom_oversample)}`;
                rows.push(['Phantom matrix', s]);
            }
            if (summary.recon_matrix) rows.push(['Recon matrix', fmtArr(summary.recon_matrix)]);
            if (summary.backend) rows.push(['Backend', formatSimBackendLabel(summary.backend)]);

            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10002;display:flex;align-items:center;justify-content:center;';

            const dialog = document.createElement('div');
            dialog.style.cssText = 'background:var(--bg,#1e1e1e);border:1px solid var(--border,#333);border-radius:8px;padding:1.5rem;min-width:360px;max-width:560px;max-height:80vh;overflow:auto;display:flex;flex-direction:column;box-shadow:0 4px 20px rgba(0,0,0,0.5);';

            const title = document.createElement('h3');
            title.textContent = 'Open shared link?';
            title.style.cssText = 'margin:0 0 0.5rem 0;color:var(--accent,#4a9eff);';

            const subtitle = document.createElement('div');
            subtitle.textContent = summary.source === 'capsule'
                ? 'A shared protocol capsule was detected. Load it, or start with the default?'
                : 'A shared link was detected. Load it, or start with the default?';
            subtitle.style.cssText = 'color:var(--text,#ddd);font-size:0.85rem;margin-bottom:1rem;opacity:0.85;';

            const table = document.createElement('div');
            table.style.cssText = 'display:grid;grid-template-columns:auto 1fr;gap:0.35rem 0.9rem;margin-bottom:1.25rem;color:var(--text,#ddd);font-size:0.88rem;';
            for (const [label, value] of rows) {
                const k = document.createElement('div');
                k.textContent = label;
                k.style.cssText = 'opacity:0.7;white-space:nowrap;';
                const v = document.createElement('div');
                v.textContent = value;
                v.style.cssText = 'word-break:break-word;';
                table.appendChild(k);
                table.appendChild(v);
            }
            if (!rows.length) {
                const none = document.createElement('div');
                none.textContent = 'No details available.';
                none.style.cssText = 'color:var(--text,#ddd);opacity:0.7;grid-column:1 / -1;';
                table.appendChild(none);
            }

            const buttonRow = document.createElement('div');
            buttonRow.style.cssText = 'display:flex;justify-content:flex-end;gap:0.5rem;';

            const defaultBtn = document.createElement('button');
            defaultBtn.type = 'button';
            defaultBtn.textContent = 'Load default';
            defaultBtn.className = 'btn btn-secondary btn-md';
            defaultBtn.onclick = () => finish('default');

            const sharedBtn = document.createElement('button');
            sharedBtn.type = 'button';
            sharedBtn.textContent = 'Load shared';
            sharedBtn.className = 'btn btn-secondary btn-md seq-btn-primary';
            sharedBtn.onclick = () => finish('shared');

            const onKey = (e) => { if (e.key === 'Escape') finish('default'); };
            document.addEventListener('keydown', onKey);
            overlay.addEventListener('click', (e) => { if (e.target === overlay) finish('default'); });

            buttonRow.appendChild(defaultBtn);
            buttonRow.appendChild(sharedBtn);
            dialog.appendChild(title);
            dialog.appendChild(subtitle);
            dialog.appendChild(table);
            dialog.appendChild(buttonRow);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            sharedBtn.focus();
        });
    }

    async shareCurrentProtocol() {
        if (!this.selectedSequence) {
            this.showStatus('Select a sequence or protocol before sharing', 'error');
            return null;
        }
        try {
            // Capsule sharing always snapshots the current params pane first. This avoids
            // sharing stale code when the user edited parameters without saving a protocol.
            const protocolPath = await this.saveProtocolSnapshot(true);
            if (!protocolPath) {
                this.showStatus('Could not create protocol capsule for sharing', 'error');
                return null;
            }
            // Embed the current phantom id + FOV + scan-resolution into the capsule's
            // [simulation]/[recon] metadata so the shared .py reproduces the full state,
            // even when no scan has been run yet (which would otherwise patch it).
            try {
                const sections = this._shareMetaToTomlSections(this.collectSimulationShareMeta());
                if (sections) await this.patchProtocolTomlSections(protocolPath, sections);
            } catch (metaErr) {
                console.warn('shareCurrentProtocol: could not embed simulation meta:', metaErr);
            }
            const code = this.sequences[protocolPath]?.code;
            if (!code) throw new Error(`No protocol code found for ${protocolPath}`);
            const encoded = await this._makeProtocolSharePayload(protocolPath, code);
            const url = this.buildCleanShareBaseUrl();
            const hashParams = new URLSearchParams();
            hashParams.set('protocol_gz', encoded);
            url.hash = hashParams.toString();
            const shareUrl = url.toString();
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(shareUrl);
                this.showStatus('Protocol share link copied to clipboard', 'success');
            } else {
                window.prompt('Copy protocol share link:', shareUrl);
                this.showStatus('Protocol share link ready', 'success');
            }
            return shareUrl;
        } catch (e) {
            console.error('Could not share protocol:', e);
            this.showStatus(`Could not share protocol: ${e.message}`, 'error');
            return null;
        }
    }

    _parseListParamValue(value) {
        if (Array.isArray(value)) return value;
        const s = String(value ?? '').trim();
        if (!s) return [];
        const npMatch = s.match(/^np\.array\(([\s\S]*)\)$/);
        const body = npMatch ? npMatch[1].trim() : s;
        try {
            return JSON.parse(body);
        } catch (_) {
            return body;
        }
    }

    _normalizeParamValueForShare(param, value) {
        if (value == null) return null;
        if (param.type === 'bool') return Boolean(value);
        if (param.type === 'int' || param.type === 'float') {
            const n = Number(value);
            return Number.isFinite(n) ? n : String(value).trim();
        }
        if (param.type === 'list' || param.type === 'ndarray') {
            return this._parseListParamValue(value);
        }
        if (param.type === 'str' || param.type === 'file' || param.type === 'url') {
            return String(value);
        }
        return Array.isArray(value) ? value : String(value).trim();
    }

    _readCurrentParamValue(param) {
        const root = this.paramsTarget || this.container;
        const input = root?.querySelector(`#seq-param-${param.name}`);
        if (!input) return { hasValue: false, value: null };
        if (param.type === 'bool') return { hasValue: true, value: input.checked };
        const raw = String(input.value ?? '').trim();
        if (raw === '') return { hasValue: false, value: null };
        return { hasValue: true, value: raw };
    }

    _paramShareValueEquals(a, b) {
        return JSON.stringify(a) === JSON.stringify(b);
    }

    collectChangedSeqParamsForShare() {
        const changed = {};
        for (const param of this.functionParams || []) {
            const current = this._readCurrentParamValue(param);
            if (!current.hasValue) continue;
            const currentNorm = this._normalizeParamValueForShare(param, current.value);
            const defaultNorm = this._normalizeParamValueForShare(param, param.default);
            if (!this._paramShareValueEquals(currentNorm, defaultNorm)) {
                changed[param.name] = currentNorm;
            }
        }
        return changed;
    }

    _formatSpParamValue(value) {
        if (Array.isArray(value)) return JSON.stringify(value);
        if (typeof value === 'boolean') return value ? 'true' : 'false';
        return String(value);
    }

    getLightShareTarget(sequence = this.selectedSequence) {
        if (!sequence) return null;
        const { fileName, functionName, source } = sequence;
        if (!functionName || source?.isUserEdited || source?.itemKind === 'protocol') return null;
        const path = String(source?.path || fileName || '').replace(/\\/g, '/');
        if (path.startsWith('user/seq/') || path.startsWith('user/prot/')) return null;
        const modulePath = String(source?.fullModulePath || source?.module || source?.path || fileName || '')
            .replace(/\\/g, '/')
            .replace(/\.py$/i, '');
        for (const cfg of this.config.sources || []) {
            if (cfg.type === 'folder') {
                const pkg = this.getFolderPackagePrefix(cfg);
                const needle = `${pkg}.scripts.`;
                const idx = modulePath.indexOf(needle);
                if (idx < 0) continue;
                const stem = modulePath.slice(idx + needle.length).split(/[/.]/)[0];
                if (!stem) continue;
                return { category: this.getSourceInitNamespace(cfg), stem, functionName };
            }
            if (cfg.type === 'module' || cfg.type === 'pyodide_module') {
                const modPath = String(cfg.path || cfg.name || '').replace(/\.py$/i, '');
                const needle = `${modPath}.`;
                const idx = modulePath.indexOf(needle);
                if (idx < 0) continue;
                const stem = modulePath.slice(idx + needle.length).split(/[/.]/)[0];
                if (!stem) continue;
                return { category: this.getSourceInitNamespace(cfg), stem, functionName };
            }
        }
        return null;
    }

    buildLightShareUrl(target) {
        const url = this.buildCleanShareBaseUrl();
        url.searchParams.set('s_category', target.category);
        url.searchParams.set('s_file', target.stem);
        url.searchParams.set('s_func', target.functionName);
        const changedParams = this.collectChangedSeqParamsForShare();
        for (const [name, value] of Object.entries(changedParams)) {
            url.searchParams.set(`sp_${name}`, this._formatSpParamValue(value));
        }
        // Phantom id + FOV + scan-resolution so the light link reproduces the full state.
        // Numeric arrays are emitted as bare comma lists (rounded to 4 decimals) and appended
        // manually so the commas stay readable (URLSearchParams would percent-encode them).
        const sim = this.collectSimulationShareMeta();
        const rawArrayParts = [];
        if (sim) {
            if (sim.phantom) url.searchParams.set('phantom', sim.phantom);
            const addArr = (key, arr) => {
                if (Array.isArray(arr) && arr.length) rawArrayParts.push(`${key}=${this._formatShareNumberList(arr)}`);
            };
            addArr('fov_affine', sim.fov_affine);
            addArr('fov_matrix', sim.fov_matrix);
            addArr('phantom_matrix', sim.phantom_matrix);
            addArr('phantom_oversample', sim.phantom_oversample);
            addArr('recon_matrix', sim.recon_matrix);
        }
        let result = url.toString();
        if (rawArrayParts.length) {
            result += (result.includes('?') ? '&' : '?') + rawArrayParts.join('&');
        }
        return result;
    }

    /** Comma-joined numbers rounded to 4 decimals (integers stay integral) for readable share URLs. */
    _formatShareNumberList(arr) {
        return arr.map((n) => {
            const num = Number(n);
            if (!Number.isFinite(num)) return '0';
            return String(Math.round(num * 1e4) / 1e4);
        }).join(',');
    }

    async shareCurrentLightLink() {
        const target = this.getLightShareTarget();
        if (!target) {
            this.showStatus('Light sharing is only available for configured sources', 'error');
            return null;
        }
        const shareUrl = this.buildLightShareUrl(target);
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(shareUrl);
                this.showStatus('Source share link copied to clipboard', 'success');
            } else {
                window.prompt('Copy source share link:', shareUrl);
                this.showStatus('Source share link ready', 'success');
            }
        } catch (e) {
            console.error('Could not copy source share link:', e);
            window.prompt('Copy source share link:', shareUrl);
        }
        return shareUrl;
    }

    /** Ensure a .py file exists on the VFS (absolute paths) before AST/noexec or import. */
    async ensureSequenceFileInVfs(fileName) {
        if (!this.config.pyodide || !fileName || !String(fileName).endsWith('.py')) return;
        const norm = String(fileName).replace(/\\/g, '/').replace(/^\/+/, '');
        const vfs = this.vfsPath(norm);
        const pyodide = this.config.pyodide;
        try {
            const exists = await pyodide.runPythonAsync(`
import os
os.path.exists(${JSON.stringify(vfs)})
`);
            if (exists) return;
        } catch (_) { /* check failed — try write below */ }
        const code = this.sequences[norm]?.code ?? this.sequences[fileName]?.code;
        if (code) {
            await this.mirrorLocalPythonModuleToPyodide(norm, code);
        }
    }
    
    render() {
        this.container.innerHTML = SEQ_TEMPLATES.mainLayout(SEQ_TEMPLATES.showConsoleCheckbox());
        const executeBtn = this.container.querySelector('#seq-execute-btn');
        if (executeBtn) {
            executeBtn.addEventListener('click', () => {
                this.executeFunction();
            });
        }
        const getFovBtn = this.container.querySelector('#seq-get-fov-btn');
        if (getFovBtn) {
            getFovBtn.addEventListener('click', () => {
                this.getFovFromSequence();
            });
        }
        
        const popBtn = this.container.querySelector('#seq-pop-btn');
        if (popBtn) {
            popBtn.addEventListener('click', () => {
                this.executeFunctionInPopup();
            });
        }

        this.syncPlotSpeedKspaceCheckbox(this.container);
        const plotSpeedSel = this.container.querySelector('#seq-plot-speed-selector');
        if (plotSpeedSel) {
            plotSpeedSel.addEventListener('change', () => this.syncPlotSpeedKspaceCheckbox(this.container));
        }
        
        // Show console checkbox event listener
        const showConsoleCheckbox = this.container.querySelector('#seq-show-console-checkbox');
        if (showConsoleCheckbox) {
            showConsoleCheckbox.addEventListener('change', (e) => {
                const consoleSection = this.container.querySelector('#seq-console-section');
                if (consoleSection) {
                    if (e.target.checked) {
                        consoleSection.classList.add('visible');
                    } else {
                        consoleSection.classList.remove('visible');
                    }
                }
            });
        }
        
        // Store function parameters
        this.functionParams = [];
        
        // Initialize plotting infrastructure
        this.initPlottingInfrastructure();
        this._bindErrorDisplay(this.container);
    }
    
    initPlottingInfrastructure() {
        const root = this.plotTarget || this.container;
        // Set up MutationObserver to catch matplotlib figures
        if (!this.plotObserver) {
            this.plotObserver = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType === 1) { // Element
                            const container = root.querySelector('#seq-mpl-actual-target');
                            if (!container) return;

                            // Check if this node or any of its children is a matplotlib canvas
                            const isMpl = node.querySelector('canvas') || node.classList.contains('ui-dialog') || (node.id && node.id.startsWith('matplotlib_'));
                            
                            if (isMpl && !container.contains(node)) {
                                console.log('Observer: Caught a matplotlib element, moving to target area.');
                                container.appendChild(node);
                                
                                // Hide the "No plots generated" message
                                const loadingMsg = container.querySelector('p');
                                if (loadingMsg) loadingMsg.remove();
                            }
                        }
                    });
                });
            });
            
            // Observe document.body for new matplotlib elements
            this.plotObserver.observe(document.body, { childList: true, subtree: false });
        }
    }
    
    getMatplotlibThemeCode() {
        const root = this.plotTarget || this.container;
        const darkPlotCheckbox = root ? root.querySelector('#seq-dark-plot-checkbox') : null;
        const useDarkTheme = darkPlotCheckbox ? darkPlotCheckbox.checked : true;
        
        if (useDarkTheme) {
            return `
plt.rcParams.update({
    'figure.figsize': [8, 2.8],
    'font.size': 8,
    'figure.facecolor': '#111a33',  # Match --panel color
    'axes.facecolor': '#111a33',
    'axes.edgecolor': (1.0, 1.0, 1.0, 0.12),  # Match --border (rgba normalized to 0-1)
    'axes.labelcolor': '#e8ecff',  # Match --text
    'text.color': '#e8ecff',
    'xtick.color': '#a9b3da',  # Match --muted
    'ytick.color': '#a9b3da',
    'grid.color': (1.0, 1.0, 1.0, 0.12),  # Match --border (rgba normalized to 0-1)
    'figure.edgecolor': '#111a33',
    'savefig.facecolor': '#111a33',
    'savefig.edgecolor': '#111a33'
})`;
        } else {
            return `
# Reset to standard matplotlib theme
plt.rcdefaults()
plt.rcParams['figure.figsize'] = [8, 2.8]
plt.rcParams['font.size'] = 8`;
        }
    }
    
    async installOptimizedPlotFunction() {
        if (!this.config.pyodide) {
            console.warn('Pyodide not available, cannot install optimized plot function');
            return;
        }
        try {
            await patchSequencePlot(this.config.pyodide, (p) => this.resolvePath(p));
        } catch (error) {
            console.error('Error installing optimized plot function:', error);
            throw error;
        }
    }

    /**
     * Tear down ChartGPU charts and shared WebGPU device (see seq_plot.js).
     */
    async disposeSeqChartGpu() {
        await disposeSeqChartGpuHost(this);
        clearKspaceHostCache(this);
        if (this.config.pyodide) {
            await releaseKspaceCache(this.config.pyodide);
        }
    }

    /**
     * Load ChartGPU stacked panels after Python seq.plot(..., plot_speed='chartgpu').
     */
    async renderSeqChartGpuAfterPlot(plotRoot, pyodide, plotContainer) {
        return mountChartGpuSequencePlot(this, plotRoot, pyodide, plotContainer);
    }

    /** Clears Pyodide ChartGPU payload cache (`seq_plot.js`). */
    async _releaseChartgpuPythonPayload(pyodide) {
        return releaseChartgpuPythonPayload(pyodide);
    }

    
    renderConsole(target) {
        this.consoleTarget = typeof target === 'string' ? document.getElementById(target) : target;
        if (!this.consoleTarget) throw new Error(`Console target not found: ${target}`);
        
        this.consoleTarget.innerHTML = `
            <div id="seq-console-section" class="console-section visible">
                <h2 class="section-title">
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" style="width: 1rem; height: 1rem; display: inline-block; vertical-align: middle; margin-right: 0.4rem;"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                    Console Output
                </h2>
                <div id="seq-console-output" class="console"></div>
                <div id="seq-package-versions" class="versions">
                    <span><strong>Pyodide:</strong> <span id="seq-pyodide-version">loading...</span></span>
                    <span><strong>NumPy:</strong> <span id="seq-numpy-version">loading...</span></span>
                    <span><strong>Matplotlib:</strong> <span id="seq-matplotlib-version">loading...</span></span>
                    <span><strong>PyPulseq:</strong> <span id="seq-pypulseq-version">loading...</span></span>
                    <span><strong>mrseq:</strong> <span id="seq-mrseq-version">loading...</span></span>
                    <span><strong>ISMRMRD:</strong> <span id="seq-ismrmrd-version">loading...</span></span>
                </div>
            </div>
        `;
    }

    /**
     * Show a modal explaining that filenames must not start with "number_" (e.g. 1_, 8_)
     * because that prefix is reserved for scan numbers in the scan and volume lists.
     */
    showReservedPrefixDialog() {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0, 0, 0, 0.7); z-index: 10002;
            display: flex; align-items: center; justify-content: center;
        `;
        const box = document.createElement('div');
        box.style.cssText = `
            background: var(--bg, #1e1e1e); border: 1px solid var(--border, #333);
            border-radius: 8px; padding: 1.25rem; max-width: 420px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
        `;
        const p = document.createElement('p');
        p.style.cssText = 'margin: 0 0 1rem 0; color: var(--text, #ddd); font-size: 0.9rem; line-height: 1.4;';
        p.textContent = 'Filenames cannot start with a number followed by an underscore (e.g. 1_, 8_). This prefix is reserved for scan numbers in the scan and volume lists (e.g. "8. protocol_name"). Please choose a different name.';
        const btn = document.createElement('button');
        btn.className = 'btn btn-secondary btn-md';
        btn.textContent = 'OK';
        btn.onclick = () => overlay.remove();
        box.appendChild(p);
        box.appendChild(btn);
        overlay.appendChild(box);
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
        document.body.appendChild(overlay);
    }

    showStatus(message, type = 'info') {
        // Log to browser console
        const prefix = type === 'error' ? '❌' : type === 'success' ? '✅' : 'ℹ️';
        console.log(`${prefix} [${type.toUpperCase()}] ${message}`);
        
        // Also log errors and warnings to UI console so user can see them
        if (type === 'error' || type === 'warn') {
            this.log(message, type);
        }
        
        // Show errors in the error display above parameters
        const root = this.paramsTarget || this.container;
        const errorDisplay = root ? root.querySelector('#seq-error-display') : null;
        if (errorDisplay) {
            if (type === 'error') {
                const textEl = errorDisplay.querySelector('.seq-error-text');
                if (textEl) textEl.textContent = message;
                else errorDisplay.textContent = message;
                errorDisplay.style.display = 'block';
                this._bindErrorDisplay(root);
            } else if (type === 'success') {
                this.clearErrorDisplay(root);
            }
        }
    }

    clearErrorDisplay(root = null) {
        const paramsRoot = root || this.paramsTarget || this.container;
        const errorDisplay = paramsRoot ? paramsRoot.querySelector('#seq-error-display') : null;
        if (!errorDisplay) return;
        errorDisplay.style.display = 'none';
        const textEl = errorDisplay.querySelector('.seq-error-text');
        if (textEl) textEl.textContent = '';
        else errorDisplay.textContent = '';
    }

    _bindErrorDisplay(root) {
        if (!root || root.dataset.seqErrorBound) return;
        const errorDisplay = root.querySelector('#seq-error-display');
        if (!errorDisplay) return;
        root.dataset.seqErrorBound = '1';
        const btn = errorDisplay.querySelector('.seq-error-dismiss');
        if (btn) {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.clearErrorDisplay(root);
            });
        }
    }
    
    log(msg, type = 'info') {
        const root = this.consoleTarget || this.container;
        const consoleEl = root ? root.querySelector('#seq-console-output') : null;
        
        const timestamp = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const colorClass = type === 'error' ? 'error' : (type === 'warn' ? 'warn' : 'info');
        
        if (consoleEl) {
            consoleEl.innerHTML += `<div style="margin-bottom: 0.25rem;"><span class="timestamp">[${timestamp}]</span> <span class="${colorClass}">${msg}</span></div>`;
            consoleEl.scrollTop = consoleEl.scrollHeight;
        }
        
        console.log(`[${type}] ${msg}`);
    }
    
    async loadSequences() {
        this.config.sources = this.dedupeSources(this.config.sources);
        console.log('Loading sequences from', this.config.sources.length, 'sources...');
        this.showStatus('Loading sequences...', 'info');
        this.sequences = {};

        // Install all unique dependencies once before loading (simple batch; version conflicts possible across sources)
        if (this.config.pyodide) {
            const allDeps = [];
            for (const source of this.config.sources) {
                for (const d of this.normalizeSourceDeps(source)) allDeps.push(d);
            }
            const seen = new Set();
            const uniqueDeps = allDeps.filter((d) => {
                const spec = typeof d === 'string' ? d : (d.name || '');
                const pkgName = String(spec).split(/[>=<!~]/)[0].trim();
                if (seen.has(pkgName)) return false;
                seen.add(pkgName);
                return true;
            });
            if (uniqueDeps.length > 0) {
                this.showStatus('Installing dependencies...', 'info');
                await this.installDependencies(uniqueDeps);
            }
        }

        // Load all sources in parallel for better performance
        const loadPromises = this.config.sources.map(async (source) => {
            try {
                console.log('Loading source:', source.name || source.path || source.type, source);
                await this.loadSource(source);
            } catch (error) {
                console.error(`Error loading source ${source.name || source.path || 'unknown'}:`, error);
                this.showStatus(`Error loading ${source.name || source.path || 'unknown'}: ${error.message}`, 'error');
            }
        });
        
        await Promise.all(loadPromises);
        await this.importSharedProtocolFromLocation();
        
        // Preload built-in epi_se_rs.seq unless ?seq_url= will supply the interpreter file
        if (this.config.pyodide && !(this.config.initialSeqUrl || '').trim()) {
            try {
                await this.preloadBuiltinInterpreterSeq();
            } catch (e) {
                console.warn('Failed to preload built-in interpreter .seq file:', e);
            }
        }
        
        this.renderTree();
        const totalFunctions = Object.values(this.sequences).reduce((sum, file) => sum + file.functions.length, 0);
        const fileCount = Object.keys(this.sequences).length;
        console.log(`Loaded ${totalFunctions} functions from ${fileCount} files`);
        if (totalFunctions > 0) {
            this.showStatus(`Loaded ${totalFunctions} functions from ${fileCount} files`, 'success');
            // Run selectInitialSequence in the background — parameter loading imports pypulseq
            // which takes several seconds, and we don't want to block the loader overlay on it.
            // The tree is already visible; the parameter panel will fill in asynchronously.
            Promise.resolve()
                .then(() => this.selectInitialSequence())
                .catch((err) => {
                    console.error('[init_prot] selectInitialSequence failed:', err);
                    this.selectFirstSequence();
                });
        } else {
            this.showStatus('No sequences found. Check console for errors.', 'error');
        }
    }

    /**
     * Fetch a remote .seq URL into Pyodide VFS under /uploads/.
     * @param {string} url
     * @param {string} [preferredName] optional filename (e.g. ute.seq)
     * @returns {Promise<string>} VFS path
     */
    async fetchSeqUrlToVfs(url, preferredName = null) {
        const pyodide = this.config.pyodide;
        if (!pyodide?.FS) throw new Error('Pyodide FS not available for .seq download');
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch .seq (${response.status} ${response.statusText})`);
        }
        const buffer = await response.arrayBuffer();
        const baseDir = '/uploads';
        try {
            if (!pyodide.FS.analyzePath(baseDir).exists) {
                pyodide.FS.mkdir(baseDir);
            }
        } catch (err) {
            if (err.code !== 'EEXIST') throw err;
        }
        let safeName = preferredName;
        if (!safeName) {
            try {
                const u = new URL(url);
                safeName = (u.pathname.split('/').pop() || '').trim();
            } catch (_) {
                safeName = '';
            }
        }
        safeName = String(safeName || 'remote.seq')
            .replace(/[/\\:?*[\]"]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '') || 'remote.seq';
        if (!safeName.toLowerCase().endsWith('.seq')) safeName += '.seq';
        const vfsPath = `${baseDir}/${safeName}`;
        pyodide.FS.writeFile(vfsPath, new Uint8Array(buffer), { encoding: 'binary' });
        return vfsPath;
    }

    /**
     * Preload a built-in single-slice Pulseq .seq file into the Pyodide virtual filesystem
     * and remember its path as the default for the seq_pulseq_interpreter.
     */
    async preloadBuiltinInterpreterSeq() {
        if (!this.config.pyodide) return;
        try {
            const url = this.resolvePath('built_in_seq/epi_se_rs.seq') + '?t=' + Date.now();
            const vfsPath = await this.fetchSeqUrlToVfs(url, 'epi_se_rs.seq');
            this.defaultInterpreterSeqPath = vfsPath;
            console.log('Preloaded built-in interpreter .seq file at', vfsPath);
        } catch (e) {
            console.warn('Error preloading built-in interpreter .seq file:', e);
        }
    }

    /**
     * Apply ?seq_url= after the Pulseq interpreter is selected: fetch into VFS and set seq_file param.
     */
    applyInitialSeqParams() {
        const overrides = this.config.initialSeqParams;
        if (!overrides || !this.functionParams) return;
        const root = this.paramsTarget || this.container;
        for (const param of this.functionParams) {
            if (!(param.name in overrides)) continue;
            const input = root.querySelector(`#seq-param-${param.name}`);
            if (!input) continue;
            const val = overrides[param.name];
            if (param.type === 'bool') {
                input.checked = Boolean(val);
            } else if (param.type === 'list' || param.type === 'ndarray') {
                input.value = JSON.stringify(val);
            } else {
                input.value = String(val);
            }
        }
    }

    async applyInitialSeqUrl() {
        const url = (this.config.initialSeqUrl || '').trim();
        if (!url) return;
        const fn = this.selectedSequence?.functionName;
        if (fn !== 'seq_pulseq_interpreter') {
            console.warn('[seq_url] ignored: selected function is not seq_pulseq_interpreter:', fn);
            return;
        }
        try {
            this.showStatus('Loading .seq from URL…', 'info');
            const vfsPath = await this.fetchSeqUrlToVfs(url);
            this.defaultInterpreterSeqPath = vfsPath;
            const input = (this.paramsTarget || this.container)?.querySelector('#seq-param-seq_file');
            if (input) input.value = vfsPath;
            this.showStatus(`Loaded .seq: ${vfsPath}`, 'success');
            console.log('[seq_url] applied', url, '→', vfsPath);
        } catch (e) {
            console.error('[seq_url] failed:', e);
            this.showStatus(`seq_url failed: ${e.message}`, 'error');
        }
    }

    /**
     * Write an uploaded .seq file into Pyodide VFS and return path.
     * @param {File} file
     * @returns {Promise<string|null>}
     */
    async writeUploadedSeqToVfs(file) {
        const pyodide = this.config.pyodide;
        if (!pyodide?.FS || !file) return null;
        const baseDir = '/uploads';
        try {
            if (!pyodide.FS.analyzePath(baseDir).exists) {
                pyodide.FS.mkdir(baseDir);
            }
        } catch (err) {
            if (err.code !== 'EEXIST') throw err;
        }
        const safeName = file.name
            .replace(/[/\\:?*\[\]"]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '') || 'uploaded.seq';
        const vfsPath = `${baseDir}/${safeName}`;
        const buffer = await file.arrayBuffer();
        pyodide.FS.writeFile(vfsPath, new Uint8Array(buffer), { encoding: 'binary' });
        return vfsPath;
    }

    /**
     * Return installed PyPulseq version if known.
     * Falls back to app-pinned version when the versions panel is not ready yet.
     * @returns {string}
     */
    getInstalledPyPulseqVersion() {
        const fallbackVersion = '1.5.0.post1';
        const root = this.consoleTarget || this.container || document;
        const versionEl = root ? root.querySelector('#seq-pypulseq-version') : null;
        const version = versionEl?.textContent?.trim();
        const normalize = (v) => String(v).replace(/\.post\d+$/i, '');
        if (!version || version === 'loading...' || version === 'unknown') {
            return normalize(fallbackVersion);
        }
        return normalize(version);
    }

    /** Full local PyPulseq label for UI notes (e.g. ``1.5.0post1``). */
    getLocalPyPulseqVersionLabel() {
        const fallbackVersion = '1.5.0.post1';
        const root = this.consoleTarget || this.container || document;
        const versionEl = root ? root.querySelector('#seq-pypulseq-version') : null;
        let version = versionEl?.textContent?.trim();
        if (!version || version === 'loading...' || version === 'unknown') {
            version = fallbackVersion;
        }
        return String(version).replace(/\.post(\d+)$/i, 'post$1');
    }

    /**
     * Resolve config type (file | folder | module) to internal loader type.
     * Config must set type; no inference.
     */
    resolveSourceType(source) {
        const configType = source?.type;
        const path = source?.path || source?.url || '';
        if (configType === 'module') return 'pyodide_module';
        if (configType === 'folder') return 'folder';
        if (configType === 'file') {
            if (typeof path === 'string' && path.startsWith('built_in_seq')) return 'built-in';
            if (typeof path !== 'string') return 'local_file';
            if (path.includes('://')) return 'remote_file';
            return 'local_file';
        }
        if (source?.isUserEdited && typeof path === 'string') {
            return path.includes('://') ? 'remote_file' : 'local_file';
        }
        throw new Error(`Source type required. Got: ${configType}. Use "file", "folder", or "module".`);
    }

    /** @param {object} source - source object */
    getSourcePath(source) {
        return source?.path ?? this.parseProtocolBase(source).module ?? '';
    }

    /** @param {object} source - source object. Returns seq_func (call target). */
    getSourceBaseSequence(source) {
        return this.parseProtocolBase(source).func || '';
    }

    /**
     * Derive protocol display name from seq_func_file: strip .py, then take part after last . or /.
     * @param {string} seqFuncFile - e.g. "mrseq.scripts.radial_flash" or "user/seq/seq_gre_4.py"
     * @returns {string} e.g. "radial_flash" or "seq_gre_4"
     */
    getProtocolDisplayNameFromSeqFuncFile(seqFuncFile) {
        let s = String(seqFuncFile || '').trim();
        if (s.endsWith('.py')) s = s.slice(0, -3);
        const lastDot = s.lastIndexOf('.');
        const lastSlash = s.lastIndexOf('/');
        const splitAt = Math.max(lastDot, lastSlash);
        const name = splitAt >= 0 ? s.slice(splitAt + 1) : s;
        // Return non-empty only so caller can fall back to path/fileName; avoid literal "protocol"
        return (name && name.trim()) ? name : '';
    }

    /** Scan index from protocol path prefix, e.g. `user/prot/2_prot_gre.py` → 2. */
    parseProtocolScanNumber(protocolPath) {
        const m = String(protocolPath || '').replace(/\\/g, '/').match(/^user\/prot\/(\d+)_/);
        return m ? Number(m[1]) : null;
    }

    /** Sequence stem after scan prefix, e.g. `user/prot/2_prot_gre.py` → `prot_gre`. */
    protocolSeqStemFromPath(protocolPath) {
        const base = String(protocolPath || '').replace(/\\/g, '/').split('/').pop().replace(/\.py$/i, '');
        const m = base.match(/^\d+_(.+)$/);
        return m ? m[1] : base;
    }

    /** User-facing label from protocol path stem only (no queue / NIfTI lookups). */
    protocolLabelFromPathStem(protocolPath) {
        return this.protocolSeqStemFromPath(protocolPath).replace(/^prot_/, '');
    }

    /**
     * User-facing protocol label from path: `2. gre` or `2. prot_tse_2d_flair`.
     * @param {string} protocolPath
     * @param {string} [nameOverride] - use only at snapshot save time before the file is indexed
     */
    protocolDisplayNameFromPath(protocolPath, nameOverride = null) {
        const n = this.parseProtocolScanNumber(protocolPath);
        if (n == null) {
            return this.protocolSeqStemFromPath(protocolPath) || '';
        }
        const label = nameOverride || this.protocolLabelFromPathStem(protocolPath);
        return label ? `${n}. ${label}` : String(n);
    }

    /** User label for a saved protocol path (without its scan-number prefix). */
    protocolUserLabelFromPath(protocolPath) {
        return this.protocolLabelFromPathStem(protocolPath);
    }

    /** Default scan name when deriving a new protocol from an existing numbered protocol (e.g. `3.gre`). */
    protocolDerivedDefaultName(protocolPath) {
        const parentScan = this.parseProtocolScanNumber(protocolPath);
        if (parentScan == null) return null;
        const label = this.protocolUserLabelFromPath(protocolPath);
        return label ? `${parentScan}.${label}` : String(parentScan);
    }

    /** Normalize a sequences key to a VFS-style path (user/prot/1_prot_gre.py). */
    _sequenceKeyToPath(key) {
        if (!key) return '';
        let s = key.includes('/') ? key : key.replace(/\./g, '/');
        if (!/\.py$/i.test(s)) s += '.py';
        return s;
    }

    /**
     * Canonical protocol file for scan N (`user/prot/N_*.py`).
     * One file per scan number; warns if multiple matches exist.
     */
    findProtocolPathForScanNumber(scanNumber) {
        if (scanNumber == null || scanNumber === '') return null;
        const n = Number(scanNumber);
        if (!Number.isFinite(n) || n < 1) return null;
        const prefix = `user/prot/${n}_`;
        const matches = [];
        for (const key of Object.keys(this.sequences)) {
            const path = this._sequenceKeyToPath(key);
            if (!path.startsWith(prefix) || !path.endsWith('.py')) continue;
            const fd = this.sequences[key];
            const isProtocol = fd?.source?.itemKind === 'protocol'
                || fd?.functions?.some((f) => f.name?.startsWith('prot_'));
            if (isProtocol) matches.push(path);
        }
        if (matches.length === 0) return null;
        matches.sort();
        if (matches.length > 1) {
            console.warn(
                `[seqExplorer] Multiple protocols for scan ${n}; using ${matches[0]} (${matches.length} total)`,
            );
        }
        return matches[0];
    }

    /** Display title for scan N from its protocol file (e.g. `18. prot_TSE_2D_FLAIR`). */
    getProtocolDisplayNameForScanNumber(scanNumber) {
        const path = this.findProtocolPathForScanNumber(scanNumber);
        if (!path) return null;
        const norm = path.replace(/\\/g, '/');
        let key = this.sequences[norm] ? norm : null;
        if (!key) {
            key = Object.keys(this.sequences).find((k) => this._sequenceKeyToPath(k) === norm) || null;
        }
        const fileData = key ? this.sequences[key] : null;
        if (fileData?.source?.displayName) return fileData.source.displayName;
        return this.protocolDisplayNameFromPath(norm);
    }

    /** Full protocol tooltip for scan N (underlying sequence, params, sim/recon). */
    getProtocolTooltipForScanNumber(scanNumber) {
        const path = this.findProtocolPathForScanNumber(scanNumber);
        if (!path) return null;
        return this.formatProtocolTooltip(path);
    }

    async _removeProtocolFileSilent(filePath) {
        const norm = String(filePath || '').replace(/\\/g, '/');
        if (!norm) return;
        if (this.config.pyodide) {
            try {
                await this.config.pyodide.runPythonAsync(`
import sys
if hasattr(sys.modules['__main__'], '_user_edited_files'):
    user_files = sys.modules['__main__']._user_edited_files
    if ${JSON.stringify(norm)} in user_files:
        del user_files[${JSON.stringify(norm)}]
`);
            } catch (_) { /* ignore */ }
        }
        const sourceIndex = this.config.sources.findIndex((s) => s.path === norm);
        if (sourceIndex >= 0) this.config.sources.splice(sourceIndex, 1);
        for (const key of Object.keys(this.sequences)) {
            if (this._sequenceKeyToPath(key) === norm) delete this.sequences[key];
        }
    }

    /** Keep a single `user/prot/N_*.py` per scan number. */
    async _purgeOtherProtocolsForScanNumber(scanNumber, keepPath) {
        const n = Number(scanNumber);
        if (!Number.isFinite(n)) return;
        const keep = String(keepPath || '').replace(/\\/g, '/');
        const toRemove = [];
        for (const key of Object.keys(this.sequences)) {
            const path = this._sequenceKeyToPath(key);
            if (path === keep || !path.endsWith('.py')) continue;
            if (this.parseProtocolScanNumber(path) !== n) continue;
            toRemove.push(path);
        }
        for (const path of toRemove) {
            await this._removeProtocolFileSilent(path);
        }
    }

    /**
     * Tooltip text: protocol file path, underlying sequence, and all parameter defaults.
     * @param {string} protocolPath - e.g. user/prot/1_prot_gre.py
     * @returns {string|null}
     */
    formatProtocolTooltip(protocolPath) {
        if (!protocolPath) return null;
        const norm = protocolPath.replace(/\\/g, '/');
        let key = this.sequences[norm] ? norm : null;
        if (!key) {
            key = Object.keys(this.sequences).find((k) => this._sequenceKeyToPath(k) === norm) || null;
        }
        const fileData = key ? this.sequences[key] : null;
        const code = fileData?.code;
        if (!code || typeof code !== 'string') return null;

        const lines = [];
        const src = fileData.source || {};
        const anyfield = src.anyfield || this.extractAnyfieldJsonFromCode(code) || {};
        const base = this.parseProtocolBase(src);
        if (base.func || base.module) {
            const seqLabel = this.getProtocolDisplayNameFromSeqFuncFile(base.module) || base.func || base.module;
            lines.push(`Sequence: ${seqLabel}`);
            if (base.module && base.module !== seqLabel) lines.push(`  ${base.module}`);
        }
        lines.push(`Protocol: ${norm}`);

        const simReconLines = this.formatSimulationReconTooltipLines(
            anyfield.simulation || {},
            anyfield.recon || {},
        );
        const pathLabel = this.protocolDisplayNameFromPath(norm);
        if (pathLabel) {
            lines.push(`Name: ${pathLabel}`);
        }

        // Target the protocol's entry function by name (anyfield.prot_func). Inline protocols embed
        // the base sequence source, which defines its own `prot_*` functions *before* the wrapper —
        // a generic first-match regex would show those stale base defaults instead of the run values.
        const entryFunc = anyfield.prot_func;
        const defRe = entryFunc
            ? new RegExp(`def\\s+(${entryFunc})\\s*\\(\\s*([\\s\\S]*?)\\)\\s*:`)
            : /def\s+(prot_\w+)\s*\(\s*([\s\S]*?)\)\s*:/;
        const defMatch = code.match(defRe);
        if (defMatch) {
            lines.push('');
            lines.push(`${defMatch[1]}:`);
            const paramsBody = defMatch[2].trim();
            if (!paramsBody) {
                lines.push('  (no parameters)');
            } else {
                paramsBody.split(',').forEach((chunk) => {
                    const p = chunk.trim();
                    if (p) lines.push(`  ${p}`);
                });
            }
        } else {
            lines.push('');
            lines.push(code.trim());
        }

        if (simReconLines.length) {
            lines.push('');
            lines.push(...simReconLines);
        }

        const TOOLTIP_MAX = 14000;
        const raw = lines.join('\n');
        if (raw.length > TOOLTIP_MAX) {
            return `${raw.slice(0, TOOLTIP_MAX)}\n… (${raw.length - TOOLTIP_MAX} more characters)`;
        }
        return raw;
    }

    /**
     * Path to use for display name: for module sources, prefer fileName (full module path e.g. mrseq.scripts.radial_flash)
     * over source.path (package only e.g. mrseq.scripts) so we show "radial_flash" not "scripts".
     */
    getPathForDisplayName(fileName, source) {
        const base = this.parseProtocolBase(source).module || source?.path || fileName || '';
        if (fileName && base && typeof base === 'string' && base.includes('.') && !base.includes('/') &&
            fileName.startsWith(base) && fileName.length > base.length) {
            return fileName;
        }
        return base;
    }

    /**
     * Build the Python script string for executing a sequence (module path only).
     * @param {{ modulePath: string, functionName: string, argsDict: object, silent: boolean, themeCode: string, plotSpeed: string, debug?: boolean }} options
     * @returns {string} Python script
     */
    /** Root that holds plot options (time_range, k-space, plot speed) — lab: plot pane; standalone: params pane. */
    getSeqPlotOptionsRoot() {
        return this.plotTarget || this.paramsTarget || this.container;
    }

    /** Read seq.plot time_range from UI (defaults 0, inf). Searches plot + params roots (lab vs standalone layout). */
    getSeqPlotTimeRange(root) {
        const roots = [];
        const add = (el) => {
            if (el && !roots.includes(el)) roots.push(el);
        };
        add(root);
        add(this.plotTarget);
        add(this.paramsTarget);
        add(this.container);
        for (const el of roots) {
            const startEl = el.querySelector('#seq-plot-time-start');
            const stopEl = el.querySelector('#seq-plot-time-stop');
            if (!startEl || !stopEl) continue;
            return readSeqPlotTimeFromInputs(startEl, stopEl);
        }
        return [0, Infinity];
    }

    /** Enable k-space checkbox only when ChartGPU plot speed is selected. */
    syncPlotSpeedKspaceCheckbox(root) {
        const el = root || this.paramsTarget || this.container;
        if (!el) return;
        const sel = el.querySelector('#seq-plot-speed-selector');
        const kspaceCb = el.querySelector('#seq-show-kspace-checkbox');
        const kspaceLbl = el.querySelector('#seq-show-kspace-label');
        if (!kspaceCb) return;
        const chartgpu = !sel || sel.value === 'chartgpu';
        kspaceCb.disabled = !chartgpu;
        if (kspaceLbl) {
            kspaceLbl.style.opacity = chartgpu ? '1' : '0.45';
            kspaceLbl.style.cursor = chartgpu ? 'pointer' : 'not-allowed';
        }
        if (!chartgpu) kspaceCb.checked = false;
    }

    buildExecuteScript(options) {
        const {
            modulePath,
            functionName,
            argsDict,
            silent,
            themeCode,
            plotSpeed,
            debug = false,
            showKspace = false,
            timeRange = [0, Infinity],
        } = options;
        const argsJson = JSON.stringify(argsDict);
        const execCall = `manager.execute_function(\n        module_path='${modulePath}',\n        function_name='${functionName}',\n        args_dict=${argsJson}\n    )`;
        const dbgStart = debug ? 'print("PYTHON (popup): Execution starting...")\n' : '';
        const dbgResult = debug ? '\n    print(f"PYTHON (popup): Result from execute_function: {result}")' : '';
        const dbgSeq = debug ? '\nprint(f"PYTHON (popup): Found sequence object: {seq is not None}")' : '';
        const dbgPatch = debug ? '\n    print("PYTHON (popup): Re-applying patches...")' : '';
        const { plotBlock, chartgpuClearPy } = buildSeqPlotExecuteFragments({
            silent,
            plotSpeed,
            debug,
            showKspace,
            timeRange,
        });

        return `
import json
import sys
import matplotlib.pyplot as plt
import __main__
import pypulseq as pp
from seq_source_manager import SourceManager
${dbgStart}# Configure matplotlib
plt.close('all')
plt.ion()
${themeCode}
${chartgpuClearPy}

_orig_plot, _orig_show = pp.Sequence.plot, plt.show
pp.Sequence.plot = plt.show = lambda *args, **kwargs: None

try:
    manager = SourceManager()
    result = ${execCall}${dbgResult}
finally:
    pp.Sequence.plot, plt.show = _orig_plot, _orig_show

seq = getattr(SourceManager, '_last_sequence', None)
${dbgSeq}

if hasattr(sys, '_pp_patch_func'):
    sys._pp_patch_func()${dbgPatch}

${plotBlock}

result
`.trim();
    }

    /** Default initial selection when ?init_prot= is absent (built-in GRE). */
    static DEFAULT_INIT_PROT = 'anyseq/gre_seq:seq_gre';

    /**
     * Parse init_prot token: namespace/file_stem:function_name
     * @param {string} token
     * @returns {{ namespace: string, fileStem: string, functionName: string } | null}
     */
    sanitizeSourceKey(name) {
        return String(name || 'folder').replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/^_+|_+$/g, '') || 'folder';
    }

    /** URL / init_prot namespace for a configured source (folder name or module first segment). */
    getSourceInitNamespace(source) {
        if (!source) return '';
        if (source.type === 'folder') return this.sanitizeSourceKey(source.name || source.path);
        if (source.type === 'module' || source.type === 'pyodide_module') {
            const path = String(source.path || source.name || '');
            return path.split('.')[0] || this.sanitizeSourceKey(source.name);
        }
        return '';
    }

    getInitProtNamespaces() {
        const out = new Set();
        for (const s of this.config.sources || []) {
            const ns = this.getSourceInitNamespace(s);
            if (ns) out.add(ns.toLowerCase());
        }
        return [...out];
    }

    findConfiguredSourceByNamespace(namespace) {
        const ns = String(namespace || '').toLowerCase();
        return (this.config.sources || []).find((s) => this.getSourceInitNamespace(s).toLowerCase() === ns) || null;
    }

    /** Python package prefix for a folder source: sources.toml name → e.g. anyseq, pypulseq_examples. */
    getFolderPackagePrefix(source) {
        return this.sanitizeSourceKey(source?.name || source?.path || 'folder');
    }

    /** Strip PEP 723, notebook guard, and AnyField metadata blocks from upstream script text. */
    stripAnyfieldFileWrappers(code) {
        return String(code || '')
            .replace(/^#.*coding[:=].*\n/i, '')
            .replace(/^# \/\/\/ script[\s\S]*?^# \/\/\/\s*\n*/m, '')
            .replace(/^# --- Notebook setup[\s\S]*?# --- Notebook setup end[^\n]*\n*/m, '')
            .replace(/^# --- AnyField metadata begin ---[\s\S]*?# --- AnyField metadata end ---\s*\n*/m, '')
            .trim();
    }

    /**
     * Replace upstream wrappers with registry PEP install headers from sources.toml.
     * Used for all folder [[sources]] loads (loadFolder).
     * @param {string} rawCode
     * @param {object} registrySource folder [[sources]] entry
     * @param {string} [fileName] optional file name for preamble generation
     */
    materializeFolderScript(rawCode, registrySource, fileName = '') {
        const body = this.stripAnyfieldFileWrappers(rawCode);
        const installSource = {
            dependencies: Array.isArray(registrySource?.dependencies) ? registrySource.dependencies.slice() : [],
            micropip_no_deps: Array.isArray(registrySource?.micropip_no_deps) ? registrySource.micropip_no_deps.slice() : [],
        };
        const { prefix } = this.buildInstallableFileShell(installSource);
        return (prefix + (body ? `${body}\n` : '')).trimEnd() + '\n';
    }

    parseInitProt(token) {
        const t = String(token || '').trim();
        const colon = t.lastIndexOf(':');
        if (colon <= 0) return null;
        const functionName = t.slice(colon + 1).trim();
        const left = t.slice(0, colon).trim();
        const slash = left.indexOf('/');
        if (slash <= 0) return null;
        const namespace = left.slice(0, slash).trim().toLowerCase();
        const fileStem = left.slice(slash + 1).trim();
        if (!namespace || !fileStem || !functionName) return null;
        const allowed = this.getInitProtNamespaces();
        if (!allowed.includes(namespace)) {
            console.warn('init_prot: unsupported namespace:', namespace, '(configured:', allowed.join(', '), ')');
            return null;
        }
        return { namespace, fileStem, functionName };
    }

    /**
     * Map init_prot namespace + file stem to this.sequences key.
     * Folder sources: <name>.scripts.<stem>. Module sources: <path>.<stem>.
     * @param {string} namespace
     * @param {string} fileStem
     * @returns {string|null}
     */
    resolveInitProtToSequenceKey(namespace, fileStem) {
        const source = this.findConfiguredSourceByNamespace(namespace);
        if (!source) return null;
        const norm = (k) => String(k || '').replace(/\\/g, '/');
        if (source.type === 'folder') {
            const pkg = this.getFolderPackagePrefix(source);
            const key = `${pkg}.scripts.${fileStem}`;
            if (this.sequences[key]) return key;
            const suffix = `.scripts.${fileStem}`;
            return Object.keys(this.sequences).find((k) => {
                const n = norm(k);
                return (
                    n === norm(key) ||
                    n.endsWith(suffix) ||
                    n.endsWith(`${suffix}.py`) ||
                    (n.includes('.scripts.') && n.split('.scripts.').pop()?.replace(/\.py$/i, '') === fileStem)
                );
            }) || null;
        }
        if (source.type === 'module' || source.type === 'pyodide_module') {
            const modPath = String(source.path || source.name || '').replace(/\.py$/i, '');
            const key = `${modPath}.${fileStem}`;
            if (this.sequences[key]) return key;
            const keys = Object.keys(this.sequences);
            const found = keys.find((k) => {
                const n = norm(k);
                return (
                    n === norm(key) ||
                    n.replace(/\.py$/i, '') === key ||
                    (n.includes(modPath) && n.endsWith(`.${fileStem}.py`)) ||
                    (n === `${fileStem}.py` && String(this.sequences[k]?.source?.fullModulePath || this.sequences[k]?.source?.path || '').includes(modPath))
                );
            });
            if (!found) {
                const modKeys = keys.filter((k) => {
                    const n = norm(k);
                    if (n.includes(modPath)) return true;
                    const src = this.sequences[k]?.source;
                    return String(src?.fullModulePath || src?.path || '').includes(modPath);
                });
                const stems = modKeys.map((k) => {
                    const m = norm(k).match(new RegExp(`${modPath.replace(/\./g, '\\.')}\\.(.+?)(?:\\.py)?$`, 'i'));
                    return m ? m[1] : norm(k).replace(/\.py$/i, '');
                });
                console.warn(
                    `[init_prot] ${namespace}: no module ${modPath}.${fileStem} — loaded stems sample:`,
                    stems.slice(0, 20)
                );
            }
            return found || null;
        }
        return null;
    }

    /**
     * Programmatically select a sequence like a tree click (updates tree highlight, params, eventHub).
     * @param {string} fileName - key in this.sequences
     * @param {string} functionName
     * @returns {Promise<boolean>}
     */
    async selectSequenceByFileAndFunction(fileName, functionName) {
        const fileData = this.sequences[fileName];
        if (!fileData) {
            console.warn('init_prot: no file', fileName);
            return false;
        }
        const func = fileData.functions.find((f) => f.name === functionName);
        if (!func) {
            console.warn('init_prot: no function', functionName, 'in', fileName);
            return false;
        }
        const treeEl = this.treeTarget || (this.container ? this.container.querySelector('#seq-tree') : null);
        if (treeEl) {
            treeEl.querySelectorAll('.seq-function-item').forEach((i) => i.classList.remove('selected'));
            const item = Array.from(treeEl.querySelectorAll('.seq-function-item')).find(
                (el) => el.dataset.file === fileName && el.dataset.function === functionName
            );
            if (item) item.classList.add('selected');
        }
        const src = fileData.source;
        const displayName = src?.displayName || '';
        this.selectedSequence = { fileName, functionName, displayName, ...func, source: fileData.source };
        this.updateSequenceNameDisplay();
        if (this.config.onSequenceSelect) {
            this.config.onSequenceSelect(this.selectedSequence);
        }
        eventHub.emit('sequenceSelected', this.selectedSequence);
        try {
            await this.loadFunctionParameters(this.selectedSequence);
        } catch (e) {
            console.error('[init_prot] loadFunctionParameters threw (selection will be treated as failed)', fileName, functionName, e);
            return false;
        }
        return true;
    }

    /**
     * After loadSequences: apply ?init_prot= or default built-in GRE; fallback to first item.
     */
    /**
     * Resolve the shared simulation-state bundle to apply after the initial selection:
     * URL-provided meta wins; otherwise the imported capsule protocol's own `[simulation]`
     * block (only when THAT protocol is the one selected, never a default's block).
     */
    _resolveInitialSharedSimMeta(fileName) {
        if (this._skipSharedImport) return null;
        if (this._pendingSharedSimMeta) return this._pendingSharedSimMeta;
        if (this._sharedProtocolSelection?.fileName && fileName === this._sharedProtocolSelection.fileName) {
            const anyfield = this.sequences[fileName]?.source?.anyfield;
            if (anyfield && (anyfield.simulation || anyfield.recon)) {
                return this.normalizeSharedSimMeta(anyfield.simulation, anyfield.recon);
            }
        }
        return null;
    }

    /** Apply shared sim state (phantom/backend/scan-res/FOV) after the initial sequence is selected. */
    async _applyInitialSharedSimMeta(fileName) {
        const sim = this._resolveInitialSharedSimMeta(fileName);
        if (!sim) return;
        try {
            await this.applySimulationStateFromMeta(sim, { loadPhantom: this._sharedPhantomAlreadyLoaded !== true });
        } catch (e) {
            console.warn('[share] applySimulationStateFromMeta failed:', e);
        }
    }

    async selectInitialSequence() {
        if (this._sharedProtocolSelection?.fileName && this._sharedProtocolSelection?.functionName) {
            const { fileName, functionName } = this._sharedProtocolSelection;
            if (await this.selectSequenceByFileAndFunction(fileName, functionName)) {
                console.log('[share] selected imported protocol', this._sharedProtocolSelection);
                await this._applyInitialSharedSimMeta(fileName);
                return;
            }
        }
        const raw = this.config.initialProt;
        const useExplicit = raw != null && String(raw).trim() !== '';
        const token = useExplicit ? String(raw).trim() : SequenceExplorer.DEFAULT_INIT_PROT;
        const allKeys = Object.keys(this.sequences);
        console.log('[init_prot] start', {
            useExplicit,
            token,
            initialProtRaw: raw,
            sequenceFileCount: allKeys.length,
            builtinLikeKeys: allKeys.filter((k) => String(k).replace(/\\/g, '/').includes('built_in_seq')),
        });
        const parsed = this.parseInitProt(token);
        if (!parsed) {
            console.warn('[init_prot] parse failed', { token });
            await this.tryFallbackInit(useExplicit, 'parse_failed');
            return;
        }
        let fileName = this.resolveInitProtToSequenceKey(parsed.namespace, parsed.fileStem);
        console.log('[init_prot] resolved', { parsed, fileName, found: !!fileName });
        if (!fileName && useExplicit) {
            console.warn('[init_prot] could not resolve file key for token', token, 'built_in candidates:', allKeys.filter((k) => String(k).includes('built_in')));
        }
        if (fileName) {
            const fds = this.sequences[fileName];
            const names = fds ? fds.functions.map((f) => f.name) : [];
            console.log('[init_prot] file entry', { fileName, functionCount: names.length, functionNames: names.slice(0, 20) });
        }
        if (fileName && await this.selectSequenceByFileAndFunction(fileName, parsed.functionName)) {
            console.log('[init_prot] OK selected', token);
            this.applyInitialSeqParams();
            await this.applyInitialSeqUrl();
            await this._applyInitialSharedSimMeta(fileName);
            return;
        }
        console.warn('[init_prot] primary selection failed → fallback', { token, fileName, wantedFunc: parsed.functionName });
        await this.tryFallbackInit(useExplicit, 'primary_failed');
    }

    /** Fallback: default protocol (GRE), then first tree item. */
    async tryFallbackInit(explicitInitFailed, reason = '') {
        const parsed = this.parseInitProt(SequenceExplorer.DEFAULT_INIT_PROT);
        const fbKey = parsed ? this.resolveInitProtToSequenceKey(parsed.namespace, parsed.fileStem) : null;
        const fbFn = parsed?.functionName;
        console.log('[init_prot] tryFallbackInit', { explicitInitFailed, reason, fbKey, fbFn, hasFile: fbKey ? !!this.sequences[fbKey] : false });
        if (fbKey && fbFn && await this.selectSequenceByFileAndFunction(fbKey, fbFn)) {
            if (explicitInitFailed) console.log('[init_prot] fell back to default', SequenceExplorer.DEFAULT_INIT_PROT);
            await this.applyInitialSeqUrl();
            await this._applyInitialSharedSimMeta(fbKey);
            return;
        }
        if (!fbKey || !fbFn) {
            console.warn('[init_prot] fallback: could not resolve', SequenceExplorer.DEFAULT_INIT_PROT);
        } else {
            const fds = this.sequences[fbKey];
            const hasFn = fds && fds.functions.some((f) => f.name === fbFn);
            console.warn('[init_prot] fallback: could not select default', { fbKey, fbFn, hasFn, funcNames: fds ? fds.functions.map((f) => f.name) : [] });
        }
        this.selectFirstSequence();
    }

    selectFirstSequence() {
        // Find the first visible function item in the tree and select it
        const treeEl = this.treeTarget || (this.container ? this.container.querySelector('#seq-tree') : null);
        if (!treeEl) {
            console.warn('[init_prot] selectFirstSequence: no #seq-tree (treeTarget unset?)');
            return;
        }

        const firstItem = treeEl.querySelector('.seq-function-item');
        if (firstItem) {
            firstItem.click();
            console.log('[init_prot] Auto-selected first sequence (fallback):', firstItem.dataset.file, firstItem.dataset.function);
        } else {
            console.warn('[init_prot] selectFirstSequence: no .seq-function-item in tree');
        }
    }
    
    async loadSource(source) {
        const sourceType = this.resolveSourceType(source);
        // Dependencies are installed once in loadSequences() and on demand (missing only) in loadParamsForSequence()
        if (sourceType === 'local_file' || sourceType === 'built-in') {
            await this.loadLocalFile(source);
        } else if (sourceType === 'remote_file') {
            // Generic remote file from any URL (GitHub raw, gist, or any other URL)
            await this.loadRemoteFile(source);
        } else if (sourceType === 'folder') {
            await this.loadFolder(source);
        } else if (sourceType === 'pyodide_module') {
            await this.loadPyodideModule(source);
        } else {
            throw new Error(`Unknown source type: ${sourceType}`);
        }
    }
    
    /**
     * Normalize a source's declared dependencies into installDependencies() input.
     * PEP 508 strings pass through; any package whose name is listed in the source's
     * `micropip_no_deps` is wrapped as { name: spec, deps: false } so micropip installs
     * it without resolving its dependencies (keeps the version pin). Legacy dict deps
     * pass through unchanged.
     * @param {{dependencies?: Array, micropip_no_deps?: string[]}} source
     * @returns {Array<string|{name:string,deps:false}>}
     */
    normalizeSourceDeps(source) {
        const deps = (source && source.dependencies) || [];
        const noDeps = new Set(((source && source.micropip_no_deps) || []).map((n) => String(n).trim()));
        return deps.map((d) => {
            if (d && typeof d === 'object') return d;
            const spec = String(d);
            const name = spec.split(/[>=<!~]/)[0].trim();
            return noDeps.has(name) ? { name: spec, deps: false } : spec;
        });
    }

    async installDependencies(dependencies) {
        if (!this.config.pyodide) {
            console.warn('Pyodide not available, cannot install dependencies');
            return;
        }
        
        const pyodide = this.config.pyodide;
        
        // Ensure micropip is loaded
        try {
            await pyodide.loadPackage('micropip');
        } catch (error) {
            console.warn('Failed to load micropip package:', error);
            // Try to import it anyway (might already be available)
        }
        
        let micropip;
        try {
            micropip = pyodide.pyimport('micropip');
        } catch (error) {
            // If import fails, try installing it via Python
            console.log('Installing micropip...');
            await pyodide.runPythonAsync(`
import micropip
`);
            micropip = pyodide.pyimport('micropip');
        }
        
        // Filter out already installed packages, but allow reinstallation if version is specified
        // This allows upgrading/downgrading packages like pypulseq
        const toInstall = dependencies.filter(pkg => {
            const pkgSpec = typeof pkg === 'string' ? pkg : (pkg.name || pkg);
            const pkgName = typeof pkg === 'string' ? pkgSpec.split(/[>=<!=]/)[0].trim() : pkgSpec;
            
            // If package is already installed, check if a version is specified
            if (this.installedPackages.has(pkgName)) {
                // If a version constraint is specified (e.g., "pypulseq>=1.4.0"), allow reinstallation
                if (typeof pkg === 'string' && /[>=<!=]/.test(pkg)) {
                    console.log(`Package ${pkgName} is installed but version constraint specified, will reinstall: ${pkg}`);
                    // Remove from installed set so it gets reinstalled
                    this.installedPackages.delete(pkgName);
                    return true;
                }
                // No version constraint, skip if already installed
                return false;
            }
            // Not installed, include it
            return true;
        });
        
        if (toInstall.length === 0) {
            console.log('All dependencies already installed');
            return;
        }
        
        const pkgNames = toInstall.map(pkg => typeof pkg === 'string' ? pkg.split(/[>=<!=]/)[0].trim() : (pkg.name || pkg));
        console.log(`Installing dependencies: ${pkgNames.join(', ')}`);
        this.showStatus(`Installing dependencies: ${pkgNames.join(', ')}...`, 'info');
        
        try {
            // Special handling for numpy version conflicts (e.g., for mrseq)
            const needsNumpyUpgrade = toInstall.some(pkg => {
                const pkgSpec = typeof pkg === 'string' ? pkg : (pkg.name || pkg);
                return pkgSpec.includes('numpy>=') || pkgSpec.includes('numpy==');
            });
            
            if (needsNumpyUpgrade) {
                try {
                    // Uninstall existing numpy first
                    await micropip.uninstall('numpy');
                    console.log('Uninstalled existing numpy');
                } catch (error) {
                    // numpy might not be installed, that's okay
                    console.log('No existing numpy to uninstall');
                }
            }
            
            // Install packages
            for (const pkg of toInstall) {
                const pkgSpec = typeof pkg === 'string' ? pkg : (pkg.name || pkg);
                const pkgName = pkgSpec.split(/[>=<!=]/)[0].trim();
                
                // Check if package needs to be upgraded/downgraded (version constraint specified)
                const needsReinstall = typeof pkg === 'string' && /[>=<!=]/.test(pkg);
                
                // If package is already installed and we need to reinstall (version constraint),
                // uninstall it first to ensure clean upgrade/downgrade
                if (needsReinstall) {
                    try {
                        await micropip.uninstall(pkgName);
                        console.log(`Uninstalled existing ${pkgName} for version upgrade/downgrade`);
                    } catch (error) {
                        // Package might not be installed, that's okay
                        console.log(`No existing ${pkgName} to uninstall`);
                    }
                }
                
                try {
                    if (typeof pkg === 'object' && pkg.deps === false) {
                        // Install without dependencies
                        await pyodide.runPythonAsync(`
import micropip
await micropip.install('${pkgSpec}', deps=False)
`);
                    } else {
                        // Normal install (micropip will handle version constraints)
                        await micropip.install(pkgSpec);
                    }
                    
                    this.installedPackages.add(pkgName);
                    console.log(`✓ Installed ${pkgName}${needsReinstall ? ' (upgraded/downgraded)' : ''}`);
                } catch (error) {
                    console.warn(`Failed to install ${pkgName}:`, error);
                    // Continue with other packages
                }
            }
            
            this.showStatus(`Installed ${pkgNames.length} package(s)`, 'success');
        } catch (error) {
            console.error('Error installing dependencies:', error);
            this.showStatus(`Error installing dependencies: ${error.message}`, 'error');
            throw error;
        }
    }
    
    async loadLocalFile(source) {
        const path = this.normalizeUserArtifactPath(source.path || source.name || '');
        if (this.isUserArtifactPath(path)) {
            const code = await this.getUserArtifactCode(path);
            if (!code) {
                throw new Error(`User artifact not found in browser storage: ${path}`);
            }
            const fullModulePath = source.fullModulePath || path.replace(/\.py$/i, '').replace(/\//g, '.');
            const sourceWithModule = { ...source, path, fullModulePath, isUserEdited: true };
            if (this.config.pyodide && path.endsWith('.py')) {
                await this.mirrorLocalPythonModuleToPyodide(path, code);
            }
            await this.parseFile(path, code, sourceWithModule);
            return;
        }

        // Check if this is a user-edited file stored in Python memory
        if (source.isUserEdited && this.config.pyodide) {
            try {
                const code = await this.config.pyodide.runPythonAsync(`
import sys
import json

if hasattr(sys.modules['__main__'], '_user_edited_files'):
    files = sys.modules['__main__']._user_edited_files
    code = files.get(${JSON.stringify(path)}, '')
    json.dumps(code)
else:
    json.dumps('')
`);
                const fileCode = JSON.parse(code);
                if (fileCode) {
                    let sourceWithModule = source;
                    if (path && path.endsWith('.py')) {
                        const fullModulePath = path.replace(/\.py$/i, '').replace(/\//g, '.');
                        sourceWithModule = { ...source, path, fullModulePath };
                    }
                    if (this.config.pyodide && path && path.endsWith('.py')) {
                        await this.mirrorLocalPythonModuleToPyodide(path, fileCode);
                    }
                    await this.parseFile(path, fileCode, sourceWithModule);
                    return;
                }
            } catch (e) {
                console.warn('Could not load from Python memory:', e);
            }
        }
        
        // Regular file loading
        const response = await fetch(this.resolvePath(source.path) + '?t=' + Date.now());
        if (!response.ok) throw new Error(`Failed to fetch ${source.path}`);
        const code = await response.text();
        // Mirror local Python files into Pyodide FS so module import works for parameter extraction/execution.
        if (this.config.pyodide && path && path.endsWith('.py')) {
            await this.mirrorLocalPythonModuleToPyodide(path, code);
            await this.mirrorRelativeLocalImports(path, code, new Set([path]));
        }
        let sourceToPass = source;
        if (path && path.endsWith('.py')) {
            const fullModulePath = path.replace(/\.py$/i, '').replace(/\//g, '.');
            sourceToPass = { ...source, fullModulePath };
        }
        await this.parseFile(path, code, sourceToPass);
    }

    async mirrorLocalPythonModuleToPyodide(filePath, code) {
        if (!this.config.pyodide || !filePath || !filePath.endsWith('.py')) return;
        const normPath = String(filePath).replace(/^\/+/, '');
        const parts = normPath.split('/').filter(Boolean);
        if (parts.length === 0) return;
        const fileBase = parts[parts.length - 1];
        const dirs = parts.slice(0, -1);
        let curr = '';
        const py = ['import os'];
        for (const d of dirs) {
            curr += `/${d}`;
            py.push(`os.makedirs(${JSON.stringify(curr)}, exist_ok=True)`);
            py.push(`init_path = os.path.join(${JSON.stringify(curr)}, '__init__.py')`);
            py.push(`if not os.path.exists(init_path):\n    with open(init_path, 'w', encoding='utf-8') as f:\n        f.write('')`);
        }
        const parentDir = dirs.length ? `/${dirs.join('/')}` : '/';
        py.push(`with open(os.path.join(${JSON.stringify(parentDir)}, ${JSON.stringify(fileBase)}), 'w', encoding='utf-8') as f:\n    f.write(${JSON.stringify(code)})`);
        await this.config.pyodide.runPythonAsync(py.join('\n'));
    }

    async mirrorRelativeLocalImports(filePath, code, visited, depth = 0) {
        if (!this.config.pyodide || depth > 2) return;
        const baseDir = String(filePath).replace(/\\/g, '/').replace(/\/[^/]*$/, '');
        const importRe = /^\s*from\s+\.(\w+)\s+import\s+|^\s*import\s+\.(\w+)/gm;
        const modules = new Set();
        let match;
        while ((match = importRe.exec(code)) !== null) {
            const mod = match[1] || match[2];
            if (mod) modules.add(mod);
        }
        for (const mod of modules) {
            const depPath = `${baseDir}/${mod}.py`;
            if (visited.has(depPath)) continue;
            visited.add(depPath);
            try {
                const resp = await fetch(this.resolvePath(depPath) + '?t=' + Date.now());
                if (!resp.ok) continue;
                const depCode = await resp.text();
                await this.mirrorLocalPythonModuleToPyodide(depPath, depCode);
                await this.mirrorRelativeLocalImports(depPath, depCode, visited, depth + 1);
            } catch (e) {
                console.warn('Could not mirror relative import dependency:', depPath, e);
            }
        }
    }
    
    async loadGitHubRaw(source) {
        console.log('Fetching GitHub raw file:', source.url);
        const response = await fetch(source.url);
        if (!response.ok) throw new Error(`Failed to fetch ${source.url}: ${response.status} ${response.statusText}`);
        const code = await response.text();
        const fileName = source.name || source.url.split('/').pop();
        console.log(`Loading external file ${fileName}, code length: ${code.length}`);
        if (this.config.pyodide) {
            await this.config.pyodide.runPythonAsync(`
import os
d = '/remote_modules'
if not os.path.exists(d):
    os.makedirs(d)
init_path = os.path.join(d, '__init__.py')
if not os.path.exists(init_path):
    with open(init_path, 'w', encoding='utf-8') as f:
        f.write('')
`);
            const vfsPath = `/remote_modules/${fileName}`;
            await this.config.pyodide.runPythonAsync(`
with open(${JSON.stringify(vfsPath)}, 'w', encoding='utf-8') as f:
    f.write(${JSON.stringify(code)})
`);
        }
        const moduleName = fileName.replace(/\.py$/i, '').replace(/\.ipynb$/i, '');
        const fullModulePath = `remote_modules.${moduleName}`;
        await this.parseFile(fullModulePath, code, { ...source, path: fullModulePath, fullModulePath });
    }
    
    async loadRemoteFile(source) {
        const url = source.url || source.path || '';
        if (!url) throw new Error('Remote file source must have url or path');
        console.log('Fetching remote file:', url);

        let fetchUrl = url;
        if (url.includes('github.com') && url.includes('/blob/')) {
            fetchUrl = url
                .replace('github.com', 'raw.githubusercontent.com')
                .replace('/blob/', '/');
            console.log('Converted GitHub blob URL to raw URL:', fetchUrl);
        }

        const response = await fetch(fetchUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch ${fetchUrl}: ${response.status} ${response.statusText}`);
        }

        let code = await response.text();
        let fileName = source.name || url.split('/').pop() || 'remote_file.py';
        
        // If it's a Jupyter notebook (.ipynb), convert it to Python code using SourceManager
        if (fileName.endsWith('.ipynb') || fetchUrl.endsWith('.ipynb')) {
            console.log('Detected Jupyter notebook, converting to Python...');
            try {
                if (this.config.pyodide) {
                    await this.ensureSourceManager();
                    const pyodide = this.config.pyodide;
                    code = await pyodide.runPythonAsync(`
import json
from seq_source_manager import SourceManager

manager = SourceManager()
python_code = manager.convert_notebook_to_python(${JSON.stringify(code)})
python_code
`);
                    // Change extension from .ipynb to .py
                    fileName = fileName.replace(/\.ipynb$/, '.py');
                    console.log(`Converted notebook to Python using SourceManager, code length: ${code.length}`);
                } else {
                    // Fallback: simple JavaScript conversion
                    const notebook = JSON.parse(code);
                    const codeCells = notebook.cells
                        .filter(cell => cell.cell_type === 'code')
                        .map(cell => {
                            let source = Array.isArray(cell.source) ? cell.source.join('') : cell.source;
                            const lines = source.split('\n')
                                .filter(line => {
                                    const trimmed = line.trim();
                                    return trimmed.length > 0 && 
                                           !trimmed.startsWith('!') && 
                                           !trimmed.startsWith('%') && 
                                           !trimmed.startsWith('?');
                                })
                                .map(line => line.replace(/\s*%\w+.*$/g, ''));
                            return lines.join('\n');
                        })
                        .filter(source => source.trim().length > 0);
                    code = codeCells.join('\n\n');
                    fileName = fileName.replace(/\.ipynb$/, '.py');
                }
            } catch (error) {
                console.warn('Failed to convert notebook, treating as plain text:', error);
            }
        }
        
        console.log(`Loading remote file ${fileName}, code length: ${code.length}`);
        if (this.config.pyodide) {
            await this.config.pyodide.runPythonAsync(`
import os
d = '/remote_modules'
if not os.path.exists(d):
    os.makedirs(d)
init_path = os.path.join(d, '__init__.py')
if not os.path.exists(init_path):
    with open(init_path, 'w', encoding='utf-8') as f:
        f.write('')
`);
            const vfsPath = `/remote_modules/${fileName}`;
            await this.config.pyodide.runPythonAsync(`
with open(${JSON.stringify(vfsPath)}, 'w', encoding='utf-8') as f:
    f.write(${JSON.stringify(code)})
`);
        }
        const moduleName = fileName.replace(/\.py$/i, '').replace(/\.ipynb$/i, '');
        const fullModulePath = `remote_modules.${moduleName}`;
        await this.parseFile(fullModulePath, code, { ...source, path: fullModulePath, fullModulePath });
    }
    
    async loadFolder(source) {
        const url = source.url || source.path || '';
        if (!url.startsWith('https://github.com/')) throw new Error('Folder source must have url or path with https://github.com/');
        let apiUrl = url.replace('https://github.com/', 'https://api.github.com/repos/');
        
        // Handle both /tree/ and /blob/ URLs
        if (apiUrl.includes('/tree/')) {
            const parts = apiUrl.split('/tree/');
            if (parts.length === 2) {
                const [repoPart, pathPart] = parts;
                const pathParts = pathPart.split('/');
                const branch = pathParts[0];
                const path = pathParts.slice(1).join('/');
                apiUrl = `${repoPart}/contents/${path}?ref=${branch}`;
            }
        } else if (apiUrl.includes('/blob/')) {
            // /blob/ URLs can point to files or folders
            // Format: /blob/branch/path/to/file_or_folder
            const parts = apiUrl.split('/blob/');
            if (parts.length === 2) {
                const [repoPart, pathPart] = parts;
                const pathParts = pathPart.split('/');
                const branch = pathParts[0];
                const path = pathParts.slice(1).join('/');
                // If path is empty, we're at the root - use empty string
                // Otherwise use the path
                apiUrl = path ? `${repoPart}/contents/${path}?ref=${branch}` : `${repoPart}/contents?ref=${branch}`;
            } else {
                // Fallback: remove /blob/ and assume last part is a file (old behavior)
                apiUrl = apiUrl.replace('/blob/', '/contents/').split('/').slice(0, -1).join('/');
            }
        } else {
            // If no /tree/ or /blob/, assume it's a direct path
            apiUrl = apiUrl + '/contents';
        }
        
        console.log('GitHub API URL:', apiUrl);
        const response = await fetch(apiUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch folder ${apiUrl}: ${response.status} ${response.statusText}`);
        }
        const files = await response.json();
        
        const modulePackageName = this.getFolderPackagePrefix(source);
        const moduleScriptsDir = `/${modulePackageName}/scripts`;
        if (this.config.pyodide) {
            await this.config.pyodide.runPythonAsync(`
import os
for d in ('/${modulePackageName}', '${moduleScriptsDir}'):
    if not os.path.exists(d):
        os.makedirs(d)
    init_path = os.path.join(d, '__init__.py')
    if not os.path.exists(init_path):
        with open(init_path, 'w', encoding='utf-8') as f:
            f.write('')
`);
        }
        
        const fileFilter = source.fileFilter || (file => file.name.endsWith('.py'));
        
        // Fetch all file contents in parallel
        const pyFiles = files.filter(f => f.type === 'file' && fileFilter(f));
        const fetched = (await Promise.all(
            pyFiles.map(async (file) => {
                try {
                    const r = await fetch(file.download_url);
                    if (!r.ok) {
                        console.warn(`Failed to fetch ${file.name}: ${r.status} ${r.statusText}`);
                        return null;
                    }
                    return { file, code: await r.text() };
                } catch (err) {
                    console.warn(`Failed to load ${file.name}:`, err);
                    return null;
                }
            })
        )).filter(Boolean);

        let loadedCount = 0;
        if (fetched.length > 0) {
            // Build module path maps up-front
            const entries = fetched.map(({ file, code }) => {
                const fullModulePath = `${modulePackageName}.scripts.${file.name.replace(/\.py$/i, '')}`;
                const vfsPath = `${moduleScriptsDir}/${file.name}`;
                const materialized = this.materializeFolderScript(code, source, file.name);
                return { file, code: materialized, fullModulePath, vfsPath };
            });

            if (this.config.pyodide) {
                // Single Python call: write all VFS files AND parse all functions
                const codeMap = {};
                const vfsPathMap = {};
                for (const { fullModulePath, vfsPath, code } of entries) {
                    codeMap[fullModulePath] = code;
                    vfsPathMap[fullModulePath] = vfsPath;
                }
                await this.ensureSourceManager();
                const batchResult = await this.config.pyodide.runPythonAsync(`
import json, os
from seq_source_manager import SourceManager, parse_script_metadata

_code_map = ${JSON.stringify(codeMap)}
_vfs_map  = ${JSON.stringify(vfsPathMap)}

for _mod, _vp in _vfs_map.items():
    os.makedirs(os.path.dirname(_vp), exist_ok=True)
    with open(_vp, 'w', encoding='utf-8') as _f:
        _f.write(_code_map[_mod])

_manager = SourceManager()
_results = {}
for _mod, _code in _code_map.items():
    _results[_mod] = {
        'functions': _manager.parse_file_functions(_code, filter_seq_prefix=False),
        'metadata': json.loads(parse_script_metadata(_code)),
    }
json.dumps(_results)
`);
                const allParsed = JSON.parse(batchResult);
                const folderDeps = [];
                for (const { file, code, fullModulePath } of entries) {
                    const parsed = allParsed[fullModulePath] || {};
                    const functions = parsed.functions || [];
                    const fileSource = {
                        ...source,
                        path: fullModulePath,
                        filePath: file.path,
                        fullModulePath,
                        origin: file.html_url || file.download_url || file.path,
                        downloadUrl: file.download_url || '',
                        dependencies: [...(source.dependencies || [])],
                        micropip_no_deps: [...(source.micropip_no_deps || [])],
                        anyfield: {},
                    };
                    for (const d of this.normalizeSourceDeps(fileSource)) folderDeps.push(d);
                    if (!this.sequences[fullModulePath]) {
                        this.sequences[fullModulePath] = {
                            functions: [],
                            source: fileSource,
                            code,
                        };
                    } else {
                        this.sequences[fullModulePath].functions = [];
                        this.sequences[fullModulePath].code = code;
                        this.sequences[fullModulePath].source = fileSource;
                    }
                    for (const func of functions) {
                        this.sequences[fullModulePath].functions.push({
                            name: func.name,
                            doc: func.doc || '',
                            source: fileSource,
                        });
                    }
                    console.log(`Parsed ${functions.length} functions from ${fullModulePath}`);
                    loadedCount++;
                }
                // Install per-file deps from registry (folder sources materialize PEP from sources.toml).
                if (folderDeps.length > 0) {
                    const seenDep = new Set();
                    const uniqFolderDeps = folderDeps.filter((d) => {
                        const spec = typeof d === 'string' ? d : (d.name || '');
                        const nm = String(spec).split(/[>=<!~]/)[0].trim();
                        if (seenDep.has(nm)) return false;
                        seenDep.add(nm);
                        return true;
                    });
                    try {
                        await this.installDependencies(uniqFolderDeps);
                    } catch (e) {
                        console.warn(`Failed installing deps for folder "${source.name || source.path}":`, e);
                    }
                }
            } else {
                // No pyodide: fall back to JS-side parsing is unavailable; just register stubs
                for (const { file, fullModulePath, code } of entries) {
                    if (!this.sequences[fullModulePath]) {
                        this.sequences[fullModulePath] = {
                            functions: [],
                            source: { ...source, path: fullModulePath, filePath: file.path, fullModulePath, origin: file.html_url || file.download_url || file.path, downloadUrl: file.download_url || '' },
                            code,
                        };
                    }
                    loadedCount++;
                }
            }
        }
        console.log(`Loaded ${loadedCount} files from folder "${source.name || source.path || source.url}"`);
    }
    
    async loadPyodideModule(source) {
        if (!this.config.pyodide) {
            throw new Error('Pyodide not available for module loading');
        }
        
        const pyodide = this.config.pyodide;
        const modulePath = source.module || source.path;
        const folderPath = source.folder || '';
        
        // Try to load without installing dependencies first
        // If it fails due to missing dependencies, we'll catch it and handle gracefully
        // Dependencies will be installed on-demand when functions are actually used
        
        // Check if this is a package submodule (e.g., mrseq.tests.scripts)
        // If so, load all modules in that package
        const isPackageSubmodule = modulePath.includes('.') && !modulePath.endsWith('.py');
        
        try {
            if (isPackageSubmodule) {
                // Load all modules in the package using SourceManager.
                // Use get_functions_from_package_noexec (AST-only) to avoid triggering
                // slow module-level imports (e.g. import pypulseq) during startup.
                await this.ensureSourceManager();
                const result = await pyodide.runPythonAsync(`
import json
from seq_source_manager import SourceManager

manager = SourceManager()
all_functions = manager.get_functions_from_package_noexec('${modulePath}')
json.dumps(all_functions)
`);
            
            const allFunctions = JSON.parse(result);
            if (allFunctions.error) {
                // Dependencies should already be installed by loadSource(), so this is a real error
                const errorMsg = allFunctions.error;
                console.error(`Failed to load module ${modulePath}: ${errorMsg}`);
                this.showStatus(`Error loading source "${source.name || source.path || source.url}": ${errorMsg}`, 'error');
                throw new Error(`Failed to load module ${modulePath}: ${errorMsg}`);
            }
            
            // Create a file entry for each module
            for (const [moduleName, moduleData] of Object.entries(allFunctions)) {
                const fileName = `${moduleName}.py`;
                const fullModulePath = moduleData.full_module_path;
                const functions = moduleData.functions;
                
                if (!this.sequences[fileName]) {
                    this.sequences[fileName] = { functions: [], source: { ...source, path: fullModulePath, moduleName: moduleName, fullModulePath: fullModulePath } };
                } else {
                    this.sequences[fileName].functions = [];
                    this.sequences[fileName].source = { ...source, path: fullModulePath, moduleName: moduleName, fullModulePath: fullModulePath };
                }
                
                for (const func of functions) {
                    this.sequences[fileName].functions.push({
                        name: func.name,
                        doc: func.doc,
                        signature: func.signature,
                        source: { ...source, path: fullModulePath, moduleName: moduleName, fullModulePath: fullModulePath }
                    });
                }
            }
        } else {
            // Single module loading (original behavior)
            const result = await pyodide.runPythonAsync(`
import inspect
import json
import importlib
import sys

def get_functions_from_module(module_path, folder_path=""):
    """Extract functions from a Python module."""
    try:
        # Import the module
        if folder_path:
            sys.path.insert(0, folder_path)
        
        module = importlib.import_module(module_path)
        
        functions = []
        for name in dir(module):
            if name.startswith('_'):
                continue
            obj = getattr(module, name)
            if inspect.isfunction(obj):
                functions.append({
                    'name': name,
                    'doc': inspect.getdoc(obj) or '',
                    'signature': str(inspect.signature(obj))
                })
        
        return json.dumps(functions)
    except Exception as e:
        return json.dumps({'error': str(e)})

get_functions_from_module('${modulePath}', '${folderPath}')
`);
            
            const functions = JSON.parse(result);
            if (functions.error) {
                // Dependencies should already be installed by loadSource(), so this is a real error
                const errorMsg = functions.error;
                console.error(`Failed to load module ${modulePath}: ${errorMsg}`);
                this.showStatus(`Error loading source "${source.name || source.path || source.url}": ${errorMsg}`, 'error');
                throw new Error(`Failed to load module ${modulePath}: ${errorMsg}`);
            }
            
            const fileName = source.name || source.path || modulePath;
            if (!this.sequences[fileName]) {
                this.sequences[fileName] = { functions: [], source: source };
            } else {
                this.sequences[fileName].functions = [];
                this.sequences[fileName].source = source;
            }
            
            for (const func of functions) {
                this.sequences[fileName].functions.push({
                    name: func.name,
                    doc: func.doc,
                    signature: func.signature,
                    source: source
                });
            }
        }
        } catch (error) {
            // Dependencies should already be installed by loadSource(), so this is a real error
            const errorMsg = error.message || String(error);
            console.error(`Failed to load module ${modulePath}: ${errorMsg}`);
            this.showStatus(`Error loading source "${source.name || source.path || source.url}": ${errorMsg}`, 'error');
            // Re-throw the error so it's properly handled by loadSequences()
            throw error;
        }
        
        this.renderTree();
    }
    
    async parseFile(fileName, code, source) {
        if (!this.config.pyodide) {
            throw new Error('Pyodide is required to parse sequence files');
        }
        await this.ensureSourceManager();
        const pyodide = this.config.pyodide;
        let result;
        try {
            result = await pyodide.runPythonAsync(`
import json
from seq_source_manager import SourceManager

manager = SourceManager()
functions = manager.parse_file_functions(${JSON.stringify(code)}, filter_seq_prefix=False)
json.dumps(functions)
`);
        } catch (err) {
            throw new Error(`Failed to parse ${fileName}: ${err.message}`);
        }
        const functions = JSON.parse(result);
        let sourceToStore = source;
        const isProtocolPath = String(fileName).replace(/\\/g, '/').startsWith('user/prot/');
        if (isProtocolPath && typeof code === 'string') {
            const parsedConfig = await this.parseScriptMetadata(code);
            if (!parsedConfig.anyfield?.prot_func) {
                console.warn(`Protocol ${fileName} is missing marked _anyfield_json with prot_func`);
            }
            sourceToStore = {
                ...source,
                itemKind: 'protocol',
                anyfield: parsedConfig.anyfield || {},
                dependencies: parsedConfig.dependencies || source?.dependencies || [],
                micropip_no_deps: parsedConfig.micropip_no_deps || source?.micropip_no_deps || [],
            };
            const displayName = source?.displayName || this.protocolDisplayNameFromPath(fileName);
            if (displayName) {
                sourceToStore = { ...sourceToStore, displayName };
            }
        } else if (typeof code === 'string') {
            try {
                const parsedConfig = await this.parseScriptMetadata(code);
                if (parsedConfig.anyfield && Object.keys(parsedConfig.anyfield).length) {
                    sourceToStore = {
                        ...source,
                        anyfield: parsedConfig.anyfield,
                        dependencies: parsedConfig.dependencies || source?.dependencies || [],
                        micropip_no_deps: parsedConfig.micropip_no_deps || source?.micropip_no_deps || [],
                    };
                }
            } catch (e) {
                // optional metadata for non-protocol files
            }
        }
        if (!this.sequences[fileName]) {
            this.sequences[fileName] = { functions: [], source: sourceToStore, code: code };
        } else {
            this.sequences[fileName].functions = [];
            this.sequences[fileName].code = code;
            this.sequences[fileName].source = sourceToStore;
        }
        let functionsToStore = functions;
        if (isProtocolPath) {
            const protocolFunc = this.getProtocolProtFunc(sourceToStore);
            const filtered = protocolFunc
                ? functions.filter((f) => f.name === protocolFunc)
                : functions.filter((f) => String(f.name || '').startsWith('prot_'));
            if (filtered.length) functionsToStore = filtered;
        }
        for (const func of functionsToStore) {
            this.sequences[fileName].functions.push({
                name: func.name,
                doc: func.doc || '',
                source: sourceToStore
            });
        }
        console.log(`Parsed ${this.sequences[fileName].functions.length} functions from ${fileName}`);
    }
    
    renderTree(target) {
        if (target) {
            this.treeTarget = typeof target === 'string' ? document.getElementById(target) : target;
        }
        const treeEl = this.treeTarget || this.container.querySelector('#seq-tree');
        if (!treeEl) return;

        console.log('Rendering tree. Filter enabled:', this.filterSeqPrefix, 'Total sequences:', Object.keys(this.sequences).length);
        
        const headingHtml = SEQ_TEMPLATES.treeHeading(this.config.showFilter, this.filterSeqPrefix);

        if (Object.keys(this.sequences).length === 0) {
            treeEl.innerHTML = headingHtml + '<div style="padding: 2rem; text-align: center; color: var(--muted);">No sequences loaded</div>';
            
            // Re-bind filter event even if empty
            if (this.config.showFilter) {
                const checkbox = treeEl.querySelector('#seq-filter-checkbox');
                if (checkbox) {
                    checkbox.addEventListener('change', (e) => {
                        this.filterSeqPrefix = e.target.checked;
                        this.renderTree();
                    });
                }
            }
            return;
        }
        
        // Group sequences by source name
        // All user-edited files go under "User Refined Sequences" or "User Protocols"
        const sourceGroups = {};
        
        for (const [fileName, fileData] of Object.entries(this.sequences)) {
            let sourceName = fileData.source?.name || fileData.source?.path || 'Unknown';
            if (fileData.source?.isUserEdited) {
                const isProtocol = fileData.source?.itemKind === 'protocol' ||
                    (fileData.source?.path && fileData.source.path.startsWith('user/prot/'));
                sourceName = isProtocol ? 'User Protocols' : 'User Refined Sequences';
            }
            
            if (!sourceGroups[sourceName]) {
                sourceGroups[sourceName] = [];
            }
            
            // Apply filter: if filter is enabled, only show seq_ or main functions
            const seenFunctions = new Set();
            const functions = fileData.functions.filter(f => {
                if (!this.filterSeqPrefix) {
                    return true;
                } else {
                    return f.name.startsWith('seq_') || f.name.startsWith('prot_') || f.name === 'main';
                }
            }).filter((f) => {
                const key = String(f.name || '');
                if (!key || seenFunctions.has(key)) return false;
                seenFunctions.add(key);
                return true;
            });
            
            if (functions.length > 0) {
                sourceGroups[sourceName].push({ fileName, functions, source: fileData.source });
            }
        }
        
        // Order of source names: follow config.sources, then User groups, then any remaining
        const sourceOrder = [];
        const seen = new Set();
        for (const s of this.config.sources) {
            const name = s?.name || s?.path || '';
            if (name && !seen.has(name)) {
                seen.add(name);
                sourceOrder.push(name);
            }
        }
        for (const name of ['User Refined Sequences', 'User Protocols']) {
            if (!seen.has(name) && sourceGroups[name]?.length) {
                seen.add(name);
                sourceOrder.push(name);
            }
        }
        for (const name of Object.keys(sourceGroups)) {
            if (!seen.has(name)) sourceOrder.push(name);
        }
        
        let html = '';
        let totalFunctions = 0;
        let displayedSources = 0;
        
        // Render each source group in config order
        for (const sourceName of sourceOrder) {
            const files = sourceGroups[sourceName];
            if (!files || files.length === 0) continue;
            if (files.length === 0) continue;
            
            displayedSources++;
            const sourceFunctionCount = files.reduce((sum, f) => sum + f.functions.length, 0);
            totalFunctions += sourceFunctionCount;
            
            // Get source info for header
            const firstFile = files[0];
            const source = firstFile.source;
            // Determine type/module info to display (hide for user-edited groups)
            let typeInfo = '';
            if (sourceName !== 'User Refined Sequences' && sourceName !== 'User Protocols') {
                if (source?.type === 'pyodide_module' && source?.module) {
                    // For module sources: show module path
                    typeInfo = source.module || source.path;
                } else if (source?.type) {
                    // For other sources: show type
                    typeInfo = source.type;
                }
            }
            
            // Get stored collapse state (default to collapsed if not set)
            const collapseStateKey = `seq-tree-collapse-${sourceName}`;
            const storedState = localStorage.getItem(collapseStateKey);
            const isCollapsed = storedState === null || storedState === 'collapsed';
            const collapsedClass = isCollapsed ? 'collapsed' : '';
            
            html += `
                <div class="seq-source-group">
                    <div class="seq-source-header ${collapsedClass}" data-source="${sourceName}">
                        <div style="display: flex; align-items: center; gap: 0.5rem; flex: 1; min-width: 0;">
                            <span style="font-weight: 600;">${sourceName}</span>
                            ${typeInfo ? `<span style="font-size: 0.7rem; color: var(--muted); font-style: italic;">${typeInfo}</span>` : ''}
                        </div>
                        ${sourceName === 'User Protocols' ? `<button type="button" class="seq-source-download-btn" data-action="download-protocols" title="Download all user protocols as .py files" aria-label="Download all user protocols"><i class="bi bi-download" aria-hidden="true"></i></button>` : ''}
                    </div>
                    <div class="seq-source-items ${collapsedClass}" data-source="${sourceName}">
                        ${files.map(({ fileName, functions, source }) => {
                            const isProtocol = source?.itemKind === 'protocol' || (source?.path && source.path.startsWith('user/prot/'));
                            let displayFileName = fileName;
                            if (isProtocol) {
                                displayFileName = source?.displayName || '';
                            } else if (source?.isUserEdited && source?.displayName) {
                                displayFileName = source.displayName;
                            } else if (fileName.startsWith('user/')) {
                                displayFileName = fileName.split('/').pop().replace(/\.py$/, '');
                            } else {
                                let shortFileName = fileName.split('/').pop().split('\\').pop();
                                if (shortFileName.endsWith('.py')) {
                                    const pyIndex = shortFileName.length - 3;
                                    const lastDotBeforePy = shortFileName.lastIndexOf('.', pyIndex - 1);
                                    if (lastDotBeforePy > 0) {
                                        shortFileName = shortFileName.substring(lastDotBeforePy + 1);
                                    }
                                }
                                // If key is a full module path (e.g. pypulseq.scripts.foo), show only last segment (file:func)
                                // Strip .py first so we don't get "py" as the segment
                                if (shortFileName.includes('.') && !shortFileName.includes('/') && !shortFileName.includes('\\')) {
                                    const withoutPy = shortFileName.replace(/\.py$/i, '');
                                    shortFileName = withoutPy.split('.').pop();
                                }
                                displayFileName = shortFileName;
                            }
                            if (displayFileName.endsWith('.py')) {
                                displayFileName = displayFileName.slice(0, -3);
                            }
                            return functions.map(func => {
                                // Protocols (prot_*) inherit from the seq_* above them; indent them
                                // slightly so the hierarchy is visible in the tree.
                                const isProtFunc = !isProtocol && /^(?:\d+_)?prot_/.test(String(func.name || ''));
                                return `
                                <div class="seq-function-item${isProtFunc ? ' is-prot-func' : ''}" data-file="${fileName}" data-function="${func.name}" ${func.doc ? `title="${func.doc.replace(/"/g, '&quot;')}"` : ''}>
                                    <span class="seq-file-function-name">${isProtocol ? displayFileName : `${displayFileName}:${func.name}`}</span>
                                </div>
                            `;
                            }).join('');
                        }).join('')}
                    </div>
                </div>
            `;
        }
        
        console.log(`Rendered ${displayedSources} sources with functions (${totalFunctions} total functions, filter: ${this.filterSeqPrefix ? 'ON' : 'OFF'})`);
        treeEl.innerHTML = headingHtml + html;
        
        // Add event listener for filter checkbox
        if (this.config.showFilter) {
            const checkbox = treeEl.querySelector('#seq-filter-checkbox');
            if (checkbox) {
                checkbox.addEventListener('change', (e) => {
                    this.filterSeqPrefix = e.target.checked;
                    this.renderTree();
                });
            }
        }
        
        // Add event listener for add sources button
        const addSourcesBtn = treeEl.querySelector('#seq-add-sources-btn');
        if (addSourcesBtn) {
            addSourcesBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showSourceEditor();
            });
        }
        
        // Event listeners for source headers (collapse/expand)
        treeEl.querySelectorAll('.seq-source-header').forEach(header => {
            header.addEventListener('click', (e) => {
                if (e.target.closest('.seq-source-download-btn')) return;
                const sourceName = header.dataset.source;
                const itemsEl = treeEl.querySelector(`.seq-source-items[data-source="${sourceName}"]`);
                const isCollapsed = header.classList.contains('collapsed');
                
                // Toggle state
                header.classList.toggle('collapsed');
                itemsEl.classList.toggle('collapsed');
                
                // Store state in localStorage
                const collapseStateKey = `seq-tree-collapse-${sourceName}`;
                const newIsCollapsed = header.classList.contains('collapsed');
                localStorage.setItem(collapseStateKey, newIsCollapsed ? 'collapsed' : 'expanded');
            });
        });

        treeEl.querySelectorAll('.seq-source-download-btn[data-action="download-protocols"]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                void this.downloadUserProtocols();
            });
        });
        
        // Event listeners for function items (selection)
        treeEl.querySelectorAll('.seq-function-item').forEach(item => {
            item.addEventListener('click', () => {
                const fileName = item.dataset.file;
                const functionName = item.dataset.function;
                void this.selectSequenceByFileAndFunction(fileName, functionName);
                if (typeof window.goToFooterCard === 'function') {
                    window.goToFooterCard(1);
                }
            });
        });
    }
    
    async loadFunctionParameters(sequence) {
        if (!this.config.pyodide) {
            console.warn('Pyodide not available, cannot extract parameters');
            return;
        }
        
        const root = this.paramsTarget || this.container;
        if (!root) return;
        
        const paramsSection = root.querySelector('#seq-params-section');
        const paramsControls = root.querySelector('#seq-params-controls');
        const executeBtn = root.querySelector('#seq-execute-btn');
        const editBtn = root.querySelector('#seq-edit-btn');
        const popBtn = root.querySelector('#seq-pop-btn');
        
        if (!paramsSection || !paramsControls || !executeBtn) return;
        
        // Enable/disable edit and pop buttons based on selection
        if (editBtn) {
            editBtn.disabled = !sequence;
        }
        if (popBtn) {
            popBtn.disabled = !sequence;
        }
        
        // Show loading state
        paramsControls.innerHTML = '<div style="padding: 1rem; text-align: center; color: var(--muted);">Loading parameters...</div>';
        // paramsSection is always visible now, no need to show/hide
        executeBtn.disabled = true;
        
        try {
            const pyodide = this.config.pyodide;
            const { fileName, functionName, source, doc } = sequence;
            
            console.log('Loading parameters for:', { fileName, functionName, sourceType: source.type, source, hasDoc: !!doc, docLength: doc?.length });
            
            // Install only missing dependencies (e.g. for sources added after initial load)
            const normDeps = this.normalizeSourceDeps(source);
            if (normDeps.length > 0) {
                const missing = normDeps.filter((pkg) => {
                    const spec = typeof pkg === 'string' ? pkg : (pkg.name || '');
                    const pkgName = String(spec).split(/[>=<!~]/)[0].trim();
                    return !this.installedPackages.has(pkgName);
                });
                if (missing.length > 0) {
                    this.showStatus('Installing dependencies...', 'info');
                    await this.installDependencies(missing);
                }
            }

            const sourceType = this.resolveSourceType(source);
            const useModulePath = source.fullModulePath || (sourceType === 'pyodide_module' ? (source.module || source.path) : null);
            if (!useModulePath) {
                throw new Error('Sequence has no module path; cannot load parameters.');
            }
            const modulePath = source.fullModulePath || source.module || source.path;
            await this.ensureSourceManager();

            // For file-type sources (built-in, private, user), use AST extraction to avoid
            // triggering 'import pypulseq' which takes ~11s cold.
            if (source.type === 'file' && fileName) {
                const fileData = this.sequences[fileName];
                const cachedCode = fileData?.code;
                let noexecResult;
                if (cachedCode) {
                    pyodide.globals.set('_param_extract_code', cachedCode);
                    noexecResult = await pyodide.runPythonAsync(`
import json
from seq_source_manager import SourceManager
manager = SourceManager()
_code = _param_extract_code.to_py() if hasattr(_param_extract_code, 'to_py') else str(_param_extract_code)
result = manager.extract_function_parameters_noexec(${JSON.stringify(this.vfsPath(fileName))}, ${JSON.stringify(functionName)}, code=_code)
json.dumps(result)
`);
                } else {
                    await this.ensureSequenceFileInVfs(fileName);
                    noexecResult = await pyodide.runPythonAsync(`
import json
from seq_source_manager import SourceManager
manager = SourceManager()
result = manager.extract_function_parameters_noexec(${JSON.stringify(this.vfsPath(fileName))}, ${JSON.stringify(functionName)})
json.dumps(result)
`);
                }
                const { params, doc } = JSON.parse(noexecResult);
                this.functionParams = params;
                if (doc && doc.trim()) {
                    this.selectedSequence.doc = doc;
                    const fileData = this.sequences[fileName];
                    if (fileData) {
                        const func = fileData.functions.find(f => f.name === functionName);
                        if (func) func.doc = doc;
                    }
                }
                this.renderParameterControls(params);
                executeBtn.disabled = false;
                return;
            }

            const paramsJson = await pyodide.runPythonAsync(`
import json
from seq_source_manager import SourceManager

manager = SourceManager()
params = manager.extract_function_parameters(
    module_path='${modulePath}',
    function_name='${functionName}'
)
json.dumps(params)
`);

            const params = JSON.parse(paramsJson);
            this.functionParams = params;
            
            // Always fetch docstring BEFORE rendering controls, so tooltips can use it
            // When we used module for params (fullModulePath or pyodide_module), fetch docstring via module
            if (useModulePath) {
                try {
                    const modulePath = source.fullModulePath || source.module || source.path;
                    console.log('Fetching docstring for module function:', { modulePath, functionName, source });
                    await this.ensureSourceManager();
                    const docResult = await pyodide.runPythonAsync(`
import inspect
import json
import importlib
import sys

_result = ''
try:
    module = importlib.import_module('${modulePath}')
    func = getattr(module, '${functionName}', None)
    if func is None:
        print(f"Function '${functionName}' not found in module '${modulePath}'", file=sys.stderr)
        _result = ''
    else:
        doc = inspect.getdoc(func)
        if doc:
            print(f"Found docstring for '${functionName}': {len(doc)} chars", file=sys.stderr)
            _result = doc
        else:
            print(f"No docstring found for '${functionName}'", file=sys.stderr)
            _result = ''
except Exception as e:
    print(f"Error fetching docstring: {e}", file=sys.stderr)
    import traceback
    traceback.print_exc()
    _result = ''

# Always return a valid JSON string
json.dumps(_result)
`);
                    const docstring = JSON.parse(docResult);
                    console.log('Fetched docstring result:', { modulePath, functionName, docLength: docstring?.length || 0, hasDoc: !!docstring, preview: docstring?.substring(0, 100) });
                    if (docstring && docstring.trim()) {
                        this.selectedSequence.doc = docstring;
                        // Also update the function in sequences for future reference
                        const fileData = this.sequences[fileName];
                        if (fileData) {
                            const func = fileData.functions.find(f => f.name === functionName);
                            if (func) {
                                func.doc = docstring;
                                console.log('Updated stored function docstring');
                            }
                        }
                    } else {
                        console.warn('No docstring found or docstring is empty');
                    }
                } catch (e) {
                    console.error('Could not fetch docstring for module function:', e);
                }
            } else {
                // For file-based sources, ensure docstring is available
                if (!this.selectedSequence.doc) {
                    const fileData = this.sequences[fileName];
                    if (fileData) {
                        const func = fileData.functions.find(f => f.name === functionName);
                        if (func && func.doc) {
                            this.selectedSequence.doc = func.doc;
                            console.log('Using stored docstring from file data');
                        }
                    }
                }
            }
            
            // Now render controls with the docstring available
            this.renderParameterControls(params);
            executeBtn.disabled = false;
            
        } catch (error) {
            console.error('Error loading function parameters:', error);
            paramsControls.innerHTML = `<div class="seq-error-message" style="display: block;">Error loading parameters: ${error.message}</div>`;
            executeBtn.disabled = true;
        }
    }
    
    /** Full path label for params header (e.g. built_in_seq/gre_seq). */
    _getSeqFilePathLabel(fileName, source) {
        let path = fileName || '';
        if (source?.path && source.type !== 'pyodide_module') {
            path = source.path;
        } else if (source?.type === 'pyodide_module' && !(String(fileName).includes('/') || String(fileName).includes('\\'))) {
            path = source.fullModulePath || source.module || fileName;
        }
        return String(path).replace(/^user\//, '').replace(/\\/g, '/').replace(/\.py$/i, '');
    }

    /** Short file stem matching the sequence tree (e.g. gre_seq). */
    _getSeqDisplayFileStem(fileName, source, isProtocol) {
        let displayFileName = fileName;
        if (isProtocol) {
            displayFileName = source?.displayName || '';
        } else if (source?.isUserEdited && source?.displayName) {
            displayFileName = source.displayName;
        } else if (fileName.startsWith('user/')) {
            displayFileName = fileName.split('/').pop().replace(/\.py$/, '');
        } else {
            let shortFileName = fileName.split('/').pop().split('\\').pop();
            if (shortFileName.endsWith('.py')) {
                const pyIndex = shortFileName.length - 3;
                const lastDotBeforePy = shortFileName.lastIndexOf('.', pyIndex - 1);
                if (lastDotBeforePy > 0) {
                    shortFileName = shortFileName.substring(lastDotBeforePy + 1);
                }
            }
            if (shortFileName.includes('.') && !shortFileName.includes('/') && !shortFileName.includes('\\')) {
                shortFileName = shortFileName.replace(/\.py$/i, '').split('.').pop();
            }
            displayFileName = shortFileName;
        }
        if (displayFileName.endsWith('.py')) {
            displayFileName = displayFileName.slice(0, -3);
        }
        return displayFileName;
    }

    updateShareButtonVisibility() {
        const root = this.paramsTarget || this.container;
        if (!root) return;
        const lightBtn = root.querySelector('#seq-light-share-btn');
        if (lightBtn) {
            lightBtn.style.display = this.getLightShareTarget() ? '' : 'none';
        }
    }

    updateSequenceNameDisplay() {
        const root = this.paramsTarget || this.container;
        const nameElement = root.querySelector('#seq-current-name');
        if (!nameElement) return;
        
        if (!this.selectedSequence) {
            nameElement.textContent = '';
            nameElement.title = '';
            this.updateShareButtonVisibility();
            return;
        }
        
        const { fileName, functionName, source } = this.selectedSequence;
        const isProtocol = source?.itemKind === 'protocol' || (source?.path && source.path.startsWith('user/prot/'));
        const pathLine = this._getSeqFilePathLabel(fileName, source);
        const stem = this._getSeqDisplayFileStem(fileName, source, isProtocol);
        const funcLine = isProtocol ? stem : `${stem}:${functionName}`;

        let docstring = this.selectedSequence?.doc || '';
        if (!docstring) {
            const fileData = this.sequences[fileName];
            if (fileData) {
                const func = fileData.functions.find(f => f.name === functionName);
                if (func?.doc) docstring = func.doc;
            }
        }
        nameElement.title = docstring || 'No docstring available';
        nameElement.replaceChildren();
        const pathEl = document.createElement('div');
        pathEl.className = 'seq-current-path';
        pathEl.textContent = pathLine;
        const funcEl = document.createElement('span');
        funcEl.className = 'seq-file-function-name';
        funcEl.textContent = funcLine;
        nameElement.append(pathEl, funcEl);
        this.updateShareButtonVisibility();
    }
    
    extractParameterDocs(docstring) {
        // Extract parameter descriptions from docstring
        // Supports multiple formats: Google, NumPy, Sphinx
        const paramDocs = {};
        if (!docstring) return paramDocs;
        
        const lines = docstring.split('\n');
        
        // Patterns for different docstring formats
        const patterns = [
            // Google style: param_name: description
            /^\s*(\w+)\s*:\s*(.+)$/,
            // NumPy style: param_name : type, description
            /^\s*(\w+)\s*:\s*[^,]+,\s*(.+)$/,
            // Sphinx style: :param param_name: description
            /^\s*:param\s+(\w+):\s*(.+)$/,
            // Alternative: Args: section with indented param_name: description
            /^\s+(\w+)\s*:\s*(.+)$/
        ];
        
        let inArgsSection = false;
        let currentParam = null;
        let currentDescription = [];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            
            // Check if we're entering an Args/Parameters section
            if (trimmed.toLowerCase().match(/^(args|parameters|arguments):?\s*$/)) {
                inArgsSection = true;
                // Skip separator lines like "----------"
                continue;
            }
            
            // Skip separator lines (dashes, underscores, etc.)
            if (trimmed.match(/^[-_=]+$/)) {
                continue;
            }
            
            // Check if we're leaving the Args section (new section)
            if (inArgsSection && trimmed.toLowerCase().match(/^(returns?|raises?|yields?|notes?|examples?):?\s*$/)) {
                // Save last parameter before leaving
                if (currentParam && currentDescription.length > 0) {
                    paramDocs[currentParam] = currentDescription.join(' ').trim();
                }
                inArgsSection = false;
                currentParam = null;
                currentDescription = [];
                continue;
            }
            
            if (inArgsSection) {
                // NumPy style: parameter name on its own line, description on next line(s)
                // Check if this is a parameter name (word at start of line, possibly indented)
                const paramNameMatch = line.match(/^\s*(\w+)\s*$/);
                if (paramNameMatch && !line.match(/^\s*\w+\s*:/)) {
                    // Save previous parameter if exists
                    if (currentParam && currentDescription.length > 0) {
                        paramDocs[currentParam] = currentDescription.join(' ').trim();
                    }
                    // Start new parameter
                    currentParam = paramNameMatch[1];
                    currentDescription = [];
                    continue;
                }
                
                // Check if this is a continuation of description (indented)
                if (currentParam && (line.startsWith('    ') || line.startsWith('\t'))) {
                    const desc = line.trim();
                    if (desc) {
                        currentDescription.push(desc);
                    }
                    continue;
                }
                
                // Try standard patterns (Google, Sphinx, etc.)
                for (const pattern of patterns) {
                    const match = trimmed.match(pattern);
                    if (match) {
                        // Save previous parameter if exists
                        if (currentParam && currentDescription.length > 0) {
                            paramDocs[currentParam] = currentDescription.join(' ').trim();
                        }
                        
                        const paramName = match[1];
                        const description = match[2] ? match[2].trim() : '';
                        if (description) {
                            paramDocs[paramName] = description;
                        } else {
                            currentParam = paramName;
                            currentDescription = [];
                        }
                        break;
                    }
                }
            }
        }
        
        // Save last parameter if still in progress
        if (inArgsSection && currentParam && currentDescription.length > 0) {
            paramDocs[currentParam] = currentDescription.join(' ').trim();
        }
        
        return paramDocs;
    }
    
    renderParameterControls(params) {
        const root = this.paramsTarget || this.container;
        const paramsControls = root.querySelector('#seq-params-controls');
        if (!paramsControls) return;
        
        // Get docstring from selected sequence
        let docstring = this.selectedSequence?.doc || '';
        
        // If no docstring, try to get it from the stored function data
        if (!docstring) {
            const { fileName, functionName } = this.selectedSequence;
            const fileData = this.sequences[fileName];
            if (fileData) {
                const func = fileData.functions.find(f => f.name === functionName);
                if (func && func.doc) {
                    docstring = func.doc;
                    // Update selectedSequence for consistency
                    this.selectedSequence.doc = docstring;
                }
            }
        }
        
        // Extract parameter-specific documentation
        const paramDocs = this.extractParameterDocs(docstring);
        
        // Clear and create container
        paramsControls.innerHTML = '';
        
        if (params.length === 0) {
            const noParamsDiv = document.createElement('div');
            noParamsDiv.className = "status-message";
            noParamsDiv.textContent = 'No parameters available for this sequence.';
            paramsControls.appendChild(noParamsDiv);
            this.updateSequenceNameDisplay();
            return;
        }
        
        const table = document.createElement('table');
        table.className = "params-table";
        
        params.forEach(param => {
            const row = document.createElement('tr');
            row.className = "params-table-row";
            
            // Label cell
            const labelCell = document.createElement('td');
            labelCell.className = "params-table-label-cell";
            if (param.type === 'file' && param.name === 'seq_file') {
                const currentLabel = document.createElement('div');
                currentLabel.className = 'seq-label-row seq-label-row-current';
                currentLabel.textContent = 'Current .seq-file';
                const newLabel = document.createElement('div');
                newLabel.className = 'seq-label-row seq-label-row-new';
                newLabel.textContent = 'New .seq-file';
                const noteLabel = document.createElement('div');
                noteLabel.className = 'seq-label-row seq-label-row-note';
                noteLabel.textContent = 'Note';
                labelCell.appendChild(currentLabel);
                labelCell.appendChild(newLabel);
                labelCell.appendChild(noteLabel);
            } else {
                labelCell.textContent = param.name;
            }
            if (paramDocs[param.name]) {
                labelCell.title = paramDocs[param.name];
            } else {
                labelCell.title = 'No description available';
            }
            row.appendChild(labelCell);
            
            // Input cell
            const inputCell = document.createElement('td');
            inputCell.className = "params-table-input-cell";
            
            let input;
            if (param.type === 'bool') {
                const label = document.createElement('label');
                label.className = "params-checkbox-label";
                input = document.createElement('input');
                input.type = 'checkbox';
                input.className = "params-checkbox";
                input.checked = param.default === true;
                label.appendChild(input);
                inputCell.appendChild(label);
            } else if (param.type === 'file' || param.type === 'url') {
                const wrapper = document.createElement('div');
                wrapper.className = "params-file-input-wrapper";
                wrapper.style.display = 'flex';
                wrapper.style.gap = '0.25rem';
                wrapper.style.alignItems = 'center';
                wrapper.style.flexDirection = 'column';
                wrapper.style.alignItems = 'stretch';
                input = document.createElement('input');
                input.type = 'text';
                input.className = "params-input";
                input.value = param.default !== null && param.default !== undefined ? String(param.default) : '';
                input.placeholder = param.type === 'file' ? 'Path or upload .seq' : 'URL';
                input.id = `seq-param-${param.name}`;
                // For the Pulseq interpreter, always prefer the preloaded built-in .seq file as default
                if (
                    param.type === 'file' &&
                    param.name === 'seq_file' &&
                    this.selectedSequence &&
                    (this.selectedSequence.functionName === 'seq_pulseq_interpreter' ||
                     this.selectedSequence.name === 'seq_pulseq_interpreter')
                ) {
                    const fallbackPath = '/uploads/epi_se_rs.seq';
                    input.value = this.defaultInterpreterSeqPath || fallbackPath;
                }
                wrapper.appendChild(input);
                if (param.type === 'file' && this.config.pyodide) {
                    const uploadBtn = document.createElement('button');
                    uploadBtn.type = 'button';
                    uploadBtn.className = "params-upload-btn";
                    uploadBtn.innerHTML = '<i class="bi bi-folder2-open" aria-hidden="true"></i>';
                    uploadBtn.style.flexShrink = '0';
                    uploadBtn.style.padding = '0.25rem 0.5rem';
                    uploadBtn.style.fontSize = '0.75rem';
                    uploadBtn.style.cursor = 'pointer';
                    uploadBtn.title = 'Choose .seq file.';
                    uploadBtn.addEventListener('click', () => {
                        const fileInput = document.createElement('input');
                        fileInput.type = 'file';
                        fileInput.accept = '.seq';
                        fileInput.style.display = 'none';
                        fileInput.onchange = async (e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            if (!this.config.pyodide?.FS) {
                                console.warn('Pyodide FS not available for upload');
                                return;
                            }
                            try {
                                const vfsPath = await this.writeUploadedSeqToVfs(file);
                                if (vfsPath) {
                                    input.value = vfsPath;
                                    this._emitProtocolParamsChanged();
                                }
                            } catch (writeErr) {
                                console.error('Failed to write uploaded file to VFS:', writeErr);
                            }
                            fileInput.remove();
                        };
                        document.body.appendChild(fileInput);
                        fileInput.click();
                    });
                    if (param.name === 'seq_file') {
                        uploadBtn.classList.add('seq-file-chooser-btn');
                        wrapper.dataset.hasSeqChooser = 'true';
                        wrapper._seqUploadBtn = uploadBtn;
                    } else {
                        wrapper.appendChild(uploadBtn);
                    }
                }
                inputCell.appendChild(wrapper);

                if (param.type === 'file' && param.name === 'seq_file') {
                    const uploadRow = document.createElement('div');
                    uploadRow.className = 'seq-upload-row';
                    const dropZone = document.createElement('div');
                    dropZone.className = 'seq-dropzone';
                    dropZone.textContent = 'drag & drop seq file here';
                    const setDragState = (isDragOver) => {
                        dropZone.classList.toggle('drag-over', isDragOver);
                    };
                    ['dragenter', 'dragover'].forEach((eventName) => {
                        dropZone.addEventListener(eventName, (evt) => {
                            evt.preventDefault();
                            evt.stopPropagation();
                            setDragState(true);
                        });
                    });
                    ['dragleave', 'dragend'].forEach((eventName) => {
                        dropZone.addEventListener(eventName, (evt) => {
                            evt.preventDefault();
                            evt.stopPropagation();
                            setDragState(false);
                        });
                    });
                    dropZone.addEventListener('drop', async (evt) => {
                        evt.preventDefault();
                        evt.stopPropagation();
                        setDragState(false);
                        const file = evt.dataTransfer?.files?.[0];
                        if (!file) return;
                        if (!file.name.toLowerCase().endsWith('.seq')) {
                            console.warn('Dropped file is not a .seq file:', file.name);
                            return;
                        }
                        if (!this.config.pyodide?.FS) {
                            console.warn('Pyodide FS not available for upload');
                            return;
                        }
                        try {
                            const vfsPath = await this.writeUploadedSeqToVfs(file);
                            if (vfsPath) {
                                input.value = vfsPath;
                            }
                        } catch (writeErr) {
                            console.error('Failed to handle dropped .seq file:', writeErr);
                        }
                    });
                    uploadRow.appendChild(dropZone);
                    const chooseLabel = document.createElement('span');
                    chooseLabel.className = 'seq-upload-or-label';
                    chooseLabel.textContent = 'or select file:';
                    uploadRow.appendChild(chooseLabel);
                    if (wrapper._seqUploadBtn) {
                        uploadRow.appendChild(wrapper._seqUploadBtn);
                    }
                    inputCell.appendChild(uploadRow);
                    const noteText = document.createElement('div');
                    noteText.className = 'seq-file-note';
                    noteText.textContent = `Local pypulseq version is ${this.getLocalPyPulseqVersionLabel()}`;
                    inputCell.appendChild(noteText);
                }
            } else {
                input = document.createElement('input');
                input.className = "params-input";
                
                if (param.type === 'int' || param.type === 'float') {
                    input.type = 'number';
                    input.step = param.type === 'int' ? '1' : 'any';
                    input.value = param.default !== null ? param.default : '';
                } else if (param.type === 'list' || param.type === 'ndarray') {
                    input.type = 'text';
                    input.value = JSON.stringify(param.default);
                } else {
                    input.type = 'text';
                    input.value = param.default !== null ? param.default : '';
                }
                
                inputCell.appendChild(input);
            }
            
            if (input.id !== `seq-param-${param.name}`) {
                input.id = `seq-param-${param.name}`;
            }
            
            if (paramDocs[param.name]) {
                input.title = paramDocs[param.name];
            } else {
                input.title = 'No description available';
            }

            this._bindProtocolParamInput(input);
            
            row.appendChild(inputCell);
            
            // Type tag cell
            const typeCell = document.createElement('td');
            typeCell.className = "params-table-type-cell";
            const typeTag = document.createElement('span');
            typeTag.className = "params-type-tag";
            typeTag.textContent = param.type;
            typeCell.appendChild(typeTag);
            row.appendChild(typeCell);
            
            table.appendChild(row);
        });
        
        paramsControls.appendChild(table);
        this.updateSequenceNameDisplay();
    }
    
    async executeFunction(silent = false, protocolName = null) {
        if (!this.selectedSequence || !this.config.pyodide) {
            console.warn('No function selected or Pyodide not available');
            return;
        }
        if (this._plotStackReady) {
            await this._plotStackReady;
        }

        // If a protocolName is provided, save a snapshot first
        this._lastProtocolSnapshotPath = null;
        if (protocolName) {
            this._lastProtocolSnapshotPath = await this.saveProtocolSnapshot(protocolName);
        }
        
        const paramsRoot = this.paramsTarget || this.container;
        const plotRoot = this.plotTarget || this.container;
        
        const executeBtn = paramsRoot.querySelector('#seq-execute-btn');
        if (!executeBtn) return;
        
        console.log('Execution started for sequence:', this.selectedSequence.fileName, silent ? '(silent)' : '');
        
        if (!silent && this.config.onFunctionStart) {
            this.config.onFunctionStart(this.selectedSequence);
        }

        executeBtn.disabled = true;
        executeBtn.textContent = silent ? 'Generating...' : 'Plotting...';
        
        // Clear any previous error display
        this._lastExecutionError = null;
        this.clearErrorDisplay(paramsRoot);
        
        try {
            const pyodide = this.config.pyodide;
            const { fileName, functionName, source } = this.selectedSequence;
            const argsDict = {};
            
            // Clear plot container and set up matplotlib target
            const plotOutput = plotRoot.querySelector('#seq-plot-output');
            let plotContainer = plotRoot.querySelector('#seq-mpl-actual-target');
            
            // Create container if it doesn't exist
            if (!plotContainer && plotOutput) {
                plotContainer = document.createElement('div');
                plotContainer.id = 'seq-mpl-actual-target';
                plotContainer.className = 'mpl-figure-container';
                plotOutput.appendChild(plotContainer);
            }
            
            // Clear plot container for visible plot seq only — silent SIM prep must not wipe ChartGPU.
            if (plotContainer && !silent) {
                await this.disposeSeqChartGpu();
                plotContainer.innerHTML = '';
            }
            
            // Also remove any stray matplotlib figures from the document body
            if (!silent) {
                document.querySelectorAll('div.ui-dialog, div[id^="matplotlib_"]').forEach(el => {
                    if (!plotContainer?.contains(el) && !plotOutput?.contains(el)) {
                        el.remove();
                    }
                });
            }
            
            // Set matplotlib target (visible plot seq only)
            if (plotContainer && !silent) {
                document.pyodideMplTarget = plotContainer;
                window.pyodideMplTarget = plotContainer;
            }
            
            // Get plot speed (ChartGPU → faster when WebGPU unavailable, e.g. mobile)
            const plotSpeedSelector = plotRoot.querySelector('#seq-plot-speed-selector');
            const plotSpeedRequested = plotSpeedSelector ? plotSpeedSelector.value : SEQ_DEFAULT_PLOT_SPEED;
            const resolvedPlot = resolveSeqPlotSpeed(plotSpeedRequested);
            let plotSpeed = resolvedPlot.plotSpeed;
            if (resolvedPlot.skippedChartGpu) {
                if (plotSpeedSelector) plotSpeedSelector.value = plotSpeed;
                this.syncPlotSpeedKspaceCheckbox(plotRoot);
                this.showStatus(`${resolvedPlot.reason} — using faster plot`, 'info');
            }
            const plotOptsRoot = this.getSeqPlotOptionsRoot();
            const showKspace =
                plotSpeed === 'chartgpu' &&
                !!plotOptsRoot?.querySelector('#seq-show-kspace-checkbox')?.checked;
            const timeRange = this.getSeqPlotTimeRange(plotOptsRoot);
            
            // Get theme code
            const themeCode = this.getMatplotlibThemeCode();
            
            // Build arguments dictionary (Python expression strings)
            if (this.functionParams) {
                this.functionParams.forEach(param => {
                    const input = paramsRoot.querySelector(`#seq-param-${param.name}`);
                    if (!input) return;
                    
                    let valExpr;
                    if (param.type === 'bool') {
                        valExpr = input.checked ? 'True' : 'False';
                    } else {
                        const inputValue = input.value.trim();
                        if (inputValue === '') {
                            return; // Skip empty values, use default
                        }
                        
                        if (param.type === 'int' || param.type === 'float') {
                            valExpr = inputValue;
                        } else                         if (param.type === 'list' || param.type === 'ndarray') {
                            valExpr = `np.array(${inputValue})`;
                        } else if (param.type === 'str' || param.type === 'file' || param.type === 'url') {
                            valExpr = `"${inputValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
                        } else {
                            valExpr = inputValue;
                        }
                    }
                    argsDict[param.name] = valExpr;
                });
            }
            console.log('Arguments built:', argsDict);
            
            // Install dependencies first if specified
            const execDeps = this.normalizeSourceDeps(source);
            if (execDeps.length > 0) {
                this.showStatus('Installing dependencies...', 'info');
                await this.installDependencies(execDeps);
            }
            
            await this.ensureSourceManager();

            if (fileName && this.isUserArtifactPath(fileName)) {
                await this.ensureSequenceFileInVfs(fileName);
            }

            const sourceType = this.resolveSourceType(source);
            const useModulePath = source.fullModulePath || (sourceType === 'pyodide_module' ? (source.module || source.path) : null);
            if (!useModulePath) {
                throw new Error('Sequence has no module path; cannot execute.');
            }
            const modulePath = source.fullModulePath || source.module || source.path;
            const script = this.buildExecuteScript({
                modulePath,
                functionName,
                argsDict,
                silent,
                themeCode,
                plotSpeed,
                debug: false,
                showKspace,
                timeRange,
            });
            const result = await pyodide.runPythonAsync(script);

            // Parse result (SourceManager returns JSON string)
            const resultObj = JSON.parse(result);

            if (plotSpeed === 'chartgpu' && !silent && plotContainer) {
                await this.renderSeqChartGpuAfterPlot(plotRoot, pyodide, plotContainer);
            }

            // Final sweep for any matplotlib figures that might have been created outside our container
            if (!silent) {
                setTimeout(() => {
                    // Re-query the container since it may have been recreated
                    const currentPlotContainer = plotRoot.querySelector('#seq-mpl-actual-target');
                    if (currentPlotContainer) {
                        // Check for matplotlib elements that ended up outside our container
                        document.querySelectorAll('div.ui-dialog, div[id^="matplotlib_"]').forEach(el => {
                            if (!currentPlotContainer.contains(el) && el !== currentPlotContainer && !plotRoot.contains(el)) {
                                console.log('Manual sweep: Found plot container outside target, moving it...');
                                currentPlotContainer.appendChild(el);
                            }
                        });
                    }
                }, 800);
            }
            
            if (this.config.onFunctionExecute) {
                this.config.onFunctionExecute(this.selectedSequence, resultObj);
            }
            
            if (!silent) {
                this.showStatus(resultObj.message || 'Function executed successfully', 'success');
            }
            this._lastExecutionError = null;

            // SIM prep: silent execute with protocolName — push Pulseq seq.definitions FOV (m → mm) to Niivue.
            // Scan pipeline runs this *before* generateFovMaskNifti() so mask voxel size × matrix matches seq FOV.
            if (silent && protocolName != null) {
                try {
                    const fovScript = `
import json
import __main__
from seq_source_manager import SourceManager

seq = getattr(SourceManager, '_last_sequence', None)
if seq is None and hasattr(__main__, 'seq'):
    seq = __main__.seq

fov_vals = None
if seq is not None:
    defs = getattr(getattr(seq, 'definitions', None), 'keys', lambda: [])()
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

out = None
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
        out = [float(v) * 1000.0 for v in vals]
    except Exception:
        out = None

json.dumps(out)
`.trim();

                    const fovResult = await pyodide.runPythonAsync(fovScript);
                    let fovMm = null;
                    try {
                        fovMm = JSON.parse(fovResult);
                    } catch (e) {
                        console.error('Failed to parse FOV JSON from Python (scan path):', e, fovResult);
                    }

                    if (Array.isArray(fovMm) && fovMm.length >= 2) {
                        const fovXmm = Number(fovMm[0]) || 0;
                        const fovYmm = Number(fovMm[1]) || 0;
                        const fovZmm = Number((fovMm.length >= 3 ? fovMm[2] : fovMm[1])) || 0;

                        eventHub.emit('sequence_fov_dims', {
                            fov_x_mm: fovXmm,
                            fov_y_mm: fovYmm,
                            fov_z_mm: fovZmm
                        });
                    }
                } catch (e) {
                    console.error('Error emitting FOV after scan execution:', e);
                }
            }

        } catch (error) {
            console.error('Error executing function:', error);
            const rawError = error.message || String(error);
            this._lastExecutionError = rawError;
            // Extract the most useful error message from the stack trace
            let errorMsg = rawError;
            // Try to extract the actual assertion/error message from pypulseq
            const assertMatch = errorMsg.match(/AssertionError: ([^\n]+)/);
            const runtimeMatch = errorMsg.match(/RuntimeError: Error executing function '[^']+': ([^\n]+)/);
            if (runtimeMatch) {
                errorMsg = runtimeMatch[1];
            } else if (assertMatch) {
                errorMsg = assertMatch[1];
            }
            // showStatus will log to UI console for errors
            this.showStatus(`Error: ${errorMsg}`, 'error');
        } finally {
            executeBtn.disabled = false;
            executeBtn.textContent = 'plot seq';
        }
    }

    /**
     * Run the current sequence with the current parameters and extract FOV from seq definitions.
     * Sends the FOV (in mm) to the Niivue app via eventHub without plotting.
     */
    async getFovFromSequence() {
        if (!this.selectedSequence || !this.config.pyodide) {
            console.warn('No function selected or Pyodide not available');
            return;
        }

        try {
            const pyodide = this.config.pyodide;

            // 1) Run the sequence once in silent mode using the same path as "plot seq"
            await this.executeFunction(true);

            // 2) After execution, read FOV from the last sequence object
            const script = `
import json
import __main__
from seq_source_manager import SourceManager

seq = getattr(SourceManager, '_last_sequence', None)
if seq is None and hasattr(__main__, 'seq'):
    seq = __main__.seq

fov_vals = None
if seq is not None:
    # Prefer seq.definitions keys if available, match case-insensitively on 'fov'
    defs = getattr(getattr(seq, 'definitions', None), 'keys', lambda: [])()
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

out = None
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
        out = [float(v) * 1000.0 for v in vals]
    except Exception:
        out = None

json.dumps(out)
`.trim();

            const result = await pyodide.runPythonAsync(script);
            let fovMm = null;
            try {
                fovMm = JSON.parse(result);
            } catch (e) {
                console.error('Failed to parse FOV JSON from Python:', e, result);
            }

            if (!Array.isArray(fovMm) || fovMm.length < 2) {
                this.showStatus('No FOV definition found in sequence.', 'warn');
                return;
            }

            const fovXmm = Number(fovMm[0]) || 0;
            const fovYmm = Number(fovMm[1]) || 0;
            const fovZmm = Number((fovMm.length >= 3 ? fovMm[2] : fovMm[1])) || 0;

            eventHub.emit('sequence_fov_dims', {
                fov_x_mm: fovXmm,
                fov_y_mm: fovYmm,
                fov_z_mm: fovZmm
            });

            this.showStatus(`FOV from sequence: ${fovXmm.toFixed(1)} x ${fovYmm.toFixed(1)} x ${fovZmm.toFixed(1)} mm`, 'info');
        } catch (error) {
            console.error('Error getting FOV from sequence:', error);
            this.showStatus(`Error getting FOV: ${error.message || error}`, 'error');
        }
    }
    
    async executeFunctionInPopup() {
        if (!this.selectedSequence || !this.config.pyodide) {
            console.warn('No function selected or Pyodide not available');
            return;
        }
        if (this._plotStackReady) {
            await this._plotStackReady;
        }

        const paramsRoot = this.paramsTarget || this.container;
        const plotRoot = this.plotTarget || this.container;
        
        const { fileName, functionName, source } = this.selectedSequence;
        
        // Create modal similar to editor modal
        const modal = document.createElement('div');
        modal.className = 'seq-editor-modal';
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            z-index: 10000;
            display: flex;
            justify-content: center;
            align-items: center;
        `;
        
        const modalContent = document.createElement('div');
        modalContent.className = 'seq-editor-container';
        modalContent.style.cssText = `
            background: var(--panel, #111a33);
            border-radius: 10px;
            width: 90%;
            max-width: 1200px;
            height: 85%;
            display: flex;
            flex-direction: column;
            box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
            border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
        `;
        
        const header = document.createElement('div');
        header.className = 'seq-editor-header';
        header.style.cssText = `
            padding: 1rem;
            background: var(--panel, #111a33);
            color: var(--text, #e8ecff);
            border-radius: 10px 10px 0 0;
            border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.12));
            display: flex;
            justify-content: space-between;
            align-items: center;
        `;
        
        const title = document.createElement('h2');
        title.textContent = `Sequence Plot: ${fileName}:${functionName}`;
        title.style.cssText = 'margin: 0; font-size: 1.1rem;';
        header.appendChild(title);
        
        const closeBtn = document.createElement('button');
        closeBtn.className = 'btn btn-secondary btn-md';
        closeBtn.textContent = 'Close';
        closeBtn.onclick = async () => {
            await this.disposeSeqChartGpu();
            // Clean up matplotlib target
            const plotOutput = plotRoot ? plotRoot.querySelector('#seq-plot-output') : null;
            if (plotOutput) {
                document.pyodideMplTarget = plotOutput;
                window.pyodideMplTarget = plotOutput;
            }
            modal.remove();
        };
        header.appendChild(closeBtn);
        
        const plotContainer = document.createElement('div');
        plotContainer.id = 'seq-popup-plot-container';
        plotContainer.style.cssText = `
            flex: 1;
            overflow: auto;
            padding: 1rem;
            background: var(--bg, #0b1020);
        `;
        
        // Create matplotlib target container (same structure as regular plot output)
        const mplTarget = document.createElement('div');
        mplTarget.id = 'seq-popup-mpl-target';
        mplTarget.className = 'mpl-figure-container';
        mplTarget.style.cssText = `
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
            width: 100%;
            min-height: 0;
            padding: 0.25rem;
        `;
        plotContainer.appendChild(mplTarget);
        
        modalContent.appendChild(header);
        modalContent.appendChild(plotContainer);
        modal.appendChild(modalContent);
        document.body.appendChild(modal);
        
        // Close modal when clicking outside
        modal.addEventListener('click', async (e) => {
            if (e.target === modal) {
                await this.disposeSeqChartGpu();
                const plotOutput = plotRoot ? plotRoot.querySelector('#seq-plot-output') : null;
                if (plotOutput) {
                    document.pyodideMplTarget = plotOutput;
                    window.pyodideMplTarget = plotOutput;
                }
                modal.remove();
            }
        });
        
        // Set matplotlib target to modal container
        document.pyodideMplTarget = mplTarget;
        window.pyodideMplTarget = mplTarget;
        
        try {
            const pyodide = this.config.pyodide;
            const argsDict = {};
            const plotOptsRoot = this.getSeqPlotOptionsRoot();
            const plotSpeedSelector = plotOptsRoot?.querySelector('#seq-plot-speed-selector');
            const plotSpeedRequested = plotSpeedSelector?.value || SEQ_DEFAULT_PLOT_SPEED;
            const resolvedPlot = resolveSeqPlotSpeed(plotSpeedRequested);
            let plotSpeed = resolvedPlot.plotSpeed;
            if (resolvedPlot.skippedChartGpu) {
                if (plotSpeedSelector) plotSpeedSelector.value = plotSpeed;
                this.syncPlotSpeedKspaceCheckbox(plotOptsRoot);
                this.showStatus(`${resolvedPlot.reason} — using faster plot`, 'info');
            }
            const showKspace =
                plotSpeed === 'chartgpu' &&
                !!plotOptsRoot?.querySelector('#seq-show-kspace-checkbox')?.checked;
            const timeRange = this.getSeqPlotTimeRange(plotOptsRoot);
            const darkPlotCheckbox = plotRoot ? plotRoot.querySelector('#seq-dark-plot-checkbox') : null;
            const darkPlot = darkPlotCheckbox?.checked ?? true;
            
            // Get theme code
            const themeCode = darkPlot ? `
plt.rcParams.update({
    'figure.figsize': [10, 4.0],
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
    'savefig.edgecolor': '#111a33'
})` : `
plt.rcdefaults()
plt.rcParams['figure.figsize'] = [10, 4.0]
plt.rcParams['font.size'] = 8`;
            
            // Build args dict from parameters
            const paramsControls = paramsRoot ? paramsRoot.querySelector('#seq-params-controls') : null;
            if (paramsControls && this.functionParams) {
                this.functionParams.forEach(param => {
                    const input = paramsControls.querySelector(`#seq-param-${param.name}`);
                    if (!input) return;
                    
                    let valExpr;
                    if (param.type === 'bool') {
                        valExpr = input.checked ? 'True' : 'False';
                    } else {
                        const inputValue = input.value.trim();
                        if (inputValue === '') {
                            return; // Skip empty values, use default
                        }
                        
                        if (param.type === 'int' || param.type === 'float') {
                            valExpr = inputValue;
                        } else                         if (param.type === 'list' || param.type === 'ndarray') {
                            valExpr = `np.array(${inputValue})`;
                        } else if (param.type === 'str' || param.type === 'file' || param.type === 'url') {
                            valExpr = `"${inputValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
                        } else {
                            valExpr = inputValue;
                        }
                    }
                    argsDict[param.name] = valExpr;
                });
            }
            
            const sourceType = this.resolveSourceType(source);
            const useModulePath = source.fullModulePath || (sourceType === 'pyodide_module' ? (source.module || source.path) : null);
            if (!useModulePath) {
                throw new Error('Sequence has no module path; cannot execute.');
            }
            const modulePath = source.fullModulePath || source.module || source.path;
            const script = this.buildExecuteScript({
                modulePath,
                functionName,
                argsDict,
                silent: false,
                themeCode,
                plotSpeed,
                debug: true,
                showKspace,
                timeRange,
            });
            const result = await pyodide.runPythonAsync(script);

            if (plotSpeed === 'chartgpu') {
                mplTarget.innerHTML = '';
                await this.renderSeqChartGpuAfterPlot(plotRoot, pyodide, mplTarget);
            }

            // Final sweep for any matplotlib figures
            setTimeout(() => {
                document.querySelectorAll('div.ui-dialog, div[id^="matplotlib_"], div:has(> canvas)').forEach(el => {
                    if (!mplTarget.contains(el) && el !== mplTarget) {
                        mplTarget.appendChild(el);
                    }
                });
            }, 800);

        } catch (error) {
            console.error('Error executing function in popup:', error);
            await this.disposeSeqChartGpu();
            let errorMsg = error.message || String(error);
            const assertMatch = errorMsg.match(/AssertionError: ([^\n]+)/);
            const runtimeMatch = errorMsg.match(/RuntimeError: Error executing function '[^']+': ([^\n]+)/);
            if (runtimeMatch) {
                errorMsg = runtimeMatch[1];
            } else if (assertMatch) {
                errorMsg = assertMatch[1];
            }
            
            const errorDiv = document.createElement('div');
            errorDiv.style.cssText = 'padding: 1rem; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.5); border-radius: 4px; color: #ef4444; margin: 1rem;';
            errorDiv.textContent = `Error: ${errorMsg}`;
            plotContainer.appendChild(errorDiv);
        }
    }
    
    getSelectedSequence() {
        return this.selectedSequence;
    }
    
    addSource(source) {
        this.config.sources.push(source);
        this.loadSource(source);
    }
    
    clearSequences() {
        this.sequences = {};
        this.selectedSequence = null;
        this.updateSequenceNameDisplay();
        
        // Notify other modules via eventHub
        eventHub.emit('sequenceSelected', null);
        
        this.renderTree();
    }
    
    async showSourceEditor() {
        // Create modal overlay
        const modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
        `;
        
        // Load current sources config
        // Priority: 1) Current in-memory sources (most up-to-date), 2) sources.toml file, 3) Default template
        let currentConfig = '';

        // First, convert current in-memory registry sources to TOML (most current)
        if (this.config.sources.length > 0) {
            // Strip runtime-only fields; keep registry shape only.
            const registrySources = this.config.sources.map((source) => {
                const { code, fullModulePath, filePath, anyfield, simulation, recon, isUserEdited, ...rest } = source;
                return rest;
            });
            currentConfig = this.sourcesToToml(registrySources);
            console.log('Loaded current in-memory sources into editor');
        } else {
            // If no sources in memory, try to load from file
            try {
                const response = await fetch(this.resolvePath('sources.toml?') + Date.now()); // Add cache bust
                if (response.ok) {
                    currentConfig = await response.text();
                    console.log('Loaded sources.toml from file');
                } else {
                    // File doesn't exist, use default template
                    currentConfig = await this.getDefaultSourcesConfig();
                    console.log('Using default template (no sources in memory and file not found)');
                }
            } catch (e) {
                console.warn('Could not load sources config file:', e);
                // Use default template as last resort
                currentConfig = await this.getDefaultSourcesConfig();
            }
        }
        
        // Create modal content
        const modalContent = document.createElement('div');
        modalContent.style.cssText = `
            background: var(--bg, #1e1e1e);
            border: 1px solid var(--border, #333);
            border-radius: 8px;
            padding: 1.5rem;
            max-width: 90vw;
            max-height: 90vh;
            width: 800px;
            display: flex;
            flex-direction: column;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
            overflow: hidden;
        `;
        
        const title = document.createElement('h2');
        title.textContent = 'Edit Sources Configuration';
        title.style.cssText = 'margin: 0 0 1rem 0; color: var(--accent, #4a9eff); font-size: 1.2rem;';
        
        const info = document.createElement('div');
        info.innerHTML = `
            <p style="margin: 0 0 1rem 0; color: var(--text-secondary, #aaa); font-size: 0.875rem;">
                Define sources as a TOML <code>[[sources]]</code> array. Each source should have: <code>type</code> ("file" | "folder" | "module"), <code>path</code>, optional <code>name</code> (tree label), <code>dependencies</code> (PEP 508 strings), <code>micropip_no_deps</code>.
            </p>
        `;
        
        // Create CodeMirror editor if available, otherwise use textarea
        let editor;
        const editorContainer = document.createElement('div');
        editorContainer.style.cssText = 'flex: 1; min-height: 400px; max-height: 60vh; margin-bottom: 1rem; position: relative; overflow: hidden;';
        
        if (window.CodeMirror) {
            // Create a textarea first (CodeMirror.fromTextArea pattern like in viewer.html)
            const textarea = document.createElement('textarea');
            textarea.value = currentConfig;
            editorContainer.appendChild(textarea);
            
            editor = CodeMirror.fromTextArea(textarea, {
                lineNumbers: true,
                mode: 'python',
                theme: 'monokai',
                indentUnit: 4,
                indentWithTabs: false,
                lineWrapping: true,
                styleActiveLine: true,
                matchBrackets: true
            });
            
            // Set height to fill container and enable scrolling
            editor.setSize('100%', '100%');
            editorContainer.style.border = '1px solid var(--border, #333)';
            editorContainer.style.borderRadius = '4px';
            // Ensure CodeMirror scrolls properly
            const cmWrapper = editorContainer.querySelector('.CodeMirror');
            if (cmWrapper) {
                cmWrapper.style.height = '100%';
                cmWrapper.style.maxHeight = '60vh';
                const cmScroller = cmWrapper.querySelector('.CodeMirror-scroll');
                if (cmScroller) {
                    cmScroller.style.maxHeight = '60vh';
                    cmScroller.style.overflow = 'auto';
                }
            }
        } else {
            const textarea = document.createElement('textarea');
            textarea.value = currentConfig;
            textarea.style.cssText = `
                width: 100%;
                height: 400px;
                max-height: 60vh;
                background: var(--bg-secondary, #252525);
                color: var(--text, #ddd);
                border: 1px solid var(--border, #333);
                border-radius: 4px;
                padding: 0.75rem;
                font-family: 'Courier New', monospace;
                font-size: 0.875rem;
                resize: vertical;
                overflow-y: auto;
            `;
            editorContainer.appendChild(textarea);
            editor = {
                getValue: () => textarea.value,
                setValue: (val) => { textarea.value = val; },
                focus: () => textarea.focus()
            };
        }
        
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = 'display: flex; gap: 0.5rem; justify-content: flex-end;';
        
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = 'padding: 0.5rem 1rem; background: #555; color: white; border: none; border-radius: 4px; cursor: pointer;';
        cancelBtn.onclick = () => modal.remove();
        
        const loadDefaultBtn = document.createElement('button');
        loadDefaultBtn.textContent = 'Load Default';
        loadDefaultBtn.style.cssText = 'padding: 0.5rem 1rem; background: rgba(255, 255, 255, 0.1); color: var(--text, #ddd); border: 1px solid var(--border, #333); border-radius: 4px; cursor: pointer;';
        loadDefaultBtn.onclick = async () => {
            const defaultConfig = await this.getDefaultSourcesConfig();
            if (editor.setValue) {
                editor.setValue(defaultConfig);
            } else if (editor.getValue) {
                // For textarea fallback
                const textarea = editorContainer.querySelector('textarea');
                if (textarea) textarea.value = defaultConfig;
            }
        };
        
        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn btn-secondary btn-md';
        saveBtn.textContent = 'Save & Reload';
        saveBtn.onclick = async () => {
             const configCode = editor.getValue();
             try {
                 await this.loadSourcesFromConfig(configCode);
                 modal.remove();
                 this.showStatus('Sources loaded successfully. Note: To persist, save sources.toml manually.', 'success');
             } catch (error) {
                 // Show detailed error message
                 const errorMsg = error.message || String(error);
                 // If it's a Python syntax error, show it more prominently
                 if (errorMsg.includes('syntax error') || errorMsg.includes('unmatched') || errorMsg.includes('SyntaxError')) {
                     alert(`Python Syntax Error:\n\n${errorMsg}\n\nPlease check your Python code for syntax errors (missing brackets, quotes, commas, etc.).`);
                 } else {
                     alert(`Error loading sources:\n\n${errorMsg}`);
                 }
                 console.error('Error loading sources:', error);
             }
         };
        
        buttonContainer.appendChild(cancelBtn);
        buttonContainer.appendChild(loadDefaultBtn);
        buttonContainer.appendChild(saveBtn);
        
        modalContent.appendChild(title);
        modalContent.appendChild(info);
        modalContent.appendChild(editorContainer);
        modalContent.appendChild(buttonContainer);
        modal.appendChild(modalContent);
        
        // Close on background click
        modal.onclick = (e) => {
            if (e.target === modal) modal.remove();
        };
        
        document.body.appendChild(modal);
        
        // Focus editor and refresh CodeMirror if needed
        setTimeout(() => {
            if (editor.focus) editor.focus();
            if (editor.refresh) editor.refresh();
        }, 100);
    }
    
    async ensureSourceManager() {
        // Ensure SourceManager is loaded and available in Pyodide
        if (!this.config.pyodide) {
            throw new Error('Pyodide not available');
        }
        
        const pyodide = this.config.pyodide;
        
        // Check if already loaded
        try {
            await pyodide.runPythonAsync('from seq_source_manager import SourceManager');
            return; // Already loaded
        } catch (e) {
            // Not loaded yet, continue to load it
        }
        
        // Try to fetch and execute it
        let sourceManagerCode = null;
        try {
            const response = await fetch(this.resolvePath('seq_source_manager.py?') + Date.now()); // Cache bust
            if (response.ok) {
                sourceManagerCode = await response.text();
            }
        } catch (e) {
            console.warn('Could not fetch seq_source_manager.py:', e);
            throw new Error('Failed to load seq_source_manager.py');
        }
        
        if (!sourceManagerCode) {
            throw new Error('seq_source_manager.py is empty or not found');
        }
        
        // Execute the source manager code to make it available
        await pyodide.runPythonAsync(`
import sys
from types import ModuleType

# Create a module for seq_source_manager
seq_source_manager = ModuleType('seq_source_manager')
sys.modules['seq_source_manager'] = seq_source_manager

# Execute the code in the module's namespace so classes are defined there
exec(${JSON.stringify(sourceManagerCode)}, seq_source_manager.__dict__)
`);
    }
    
    async loadDefaultSources() {
        const configCode = await this.getDefaultSourcesConfig();
        await this.loadSourcesFromConfig(configCode);
    }

    async loadSourcesFromConfig(configCode) {
        if (!this.config.pyodide) {
            throw new Error('Pyodide not available');
        }
        
        const pyodide = this.config.pyodide;
        
        // Ensure SourceManager is loaded
        await this.ensureSourceManager();
        
        // Load sources using Python
        let result;
        try {
            result = await pyodide.runPythonAsync(`
import json
import sys
from seq_source_manager import SourceManager

_result = None
try:
    manager = SourceManager()
    sources = manager.load_sources_config(${JSON.stringify(configCode)})
    
    # Convert to JSON for JavaScript
    _result = json.dumps(sources)
    print(f"Successfully loaded {len(sources)} sources", file=sys.stderr)
except Exception as e:
    print(f"Error in load_sources_config: {e}", file=sys.stderr)
    import traceback
    traceback.print_exc()
    # Return error as JSON
    _result = json.dumps({'error': str(e)})

# Always return something
_result if _result else json.dumps({'error': 'No result returned from Python code'})
`);
        } catch (error) {
            throw new Error(`Error loading sources: ${error.message}`);
        }
        
        // Parse result
        let sources;
        try {
            const parsed = JSON.parse(result);
            if (parsed.error) {
                throw new Error(parsed.error);
            }
            sources = parsed;
        } catch (e) {
            // If result is not JSON, it might be a direct error message
            throw new Error(`Failed to parse sources config: ${result}`);
        }
        
        // Clear existing sequences
        this.sequences = {};
        
        // Load sequences from all sources
        this.config.sources = sources;
        
        // loadSequences() already renders the tree and runs selectInitialSequence(); do not render again here or the tree is rebuilt and initial selection is lost.
        await this.loadSequences();
        this.clearLegacyUserArtifactStorage();
    }
    
    async getDefaultSourcesConfig() {
        // Try to load from sources.toml file
        try {
            const response = await fetch(this.resolvePath('sources.toml'));
            if (response.ok) {
                return await response.text();
            }
        } catch (e) {
            console.warn('Could not load sources.toml:', e);
        }

        // Fallback template if file doesn't exist
        return `# Sources configuration for the sequence explorer.
# Each [[sources]] entry sets: type ("file" | "folder" | "module"), path, optional
# name, dependencies (PEP 508 strings) and micropip_no_deps.

[[sources]]
type = "folder"
name = "anyseq"
path = "https://github.com/mrx-org/anyfield/tree/main/pypulseq/anyseq"
`;
    }

    /**
     * Serialize registry sources to sources.toml text ([[sources]] array of tables).
     * @param {Array<object>} sources
     * @returns {string}
     */
    sourcesToToml(sources) {
        const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const arr = (a) => '[' + a.map((x) => `"${esc(x)}"`).join(', ') + ']';
        const lines = ['# Sources configuration for the sequence explorer.', ''];
        for (const s of sources || []) {
            lines.push('[[sources]]');
            if (s.type) lines.push(`type = "${esc(s.type)}"`);
            if (s.name) lines.push(`name = "${esc(s.name)}"`);
            const p = s.path || s.url;
            if (p) lines.push(`path = "${esc(p)}"`);
            if (s.seq_func) lines.push(`seq_func = "${esc(s.seq_func)}"`);
            if (Array.isArray(s.dependencies) && s.dependencies.length) {
                const deps = s.dependencies
                    .map((d) => (typeof d === 'string' ? d : (d && d.name) || ''))
                    .filter(Boolean);
                if (deps.length) lines.push(`dependencies = ${arr(deps)}`);
            }
            if (Array.isArray(s.micropip_no_deps) && s.micropip_no_deps.length) {
                lines.push(`micropip_no_deps = ${arr(s.micropip_no_deps)}`);
            }
            lines.push('');
        }
        return lines.join('\n');
    }
    
    /**
     * Resolve seq_func_file (module path or file path) to the key used in this.sequences.
     * Protocols may store module path (e.g. built_in_seq.gre_seq); keys are often file paths (e.g. built_in_seq/gre_seq.py).
     * @param {string} seqFuncFile - seq_func_file from TOML (module path or file path)
     * @returns {string|null} key in this.sequences, or null if not found
     */
    resolveSequenceKey(seqFuncFile) {
        if (!seqFuncFile) return null;
        if (this.sequences[seqFuncFile]) return seqFuncFile;
        if (seqFuncFile.includes('.') && !seqFuncFile.endsWith('.py')) {
            const pathForm = seqFuncFile.replace(/\./g, '/') + '.py';
            if (this.sequences[pathForm]) return pathForm;
        }
        const found = Object.entries(this.sequences).find(([, fileData]) =>
            fileData?.source?.fullModulePath === seqFuncFile
        );
        return found ? found[0] : null;
    }

    /**
     * Get canonical sequence metadata: seq_func_file, seq_func (call target), type.
     * For protocols, source.seq_func_file / source.seq_func are the base we call.
     */
    getSequenceMetadata(fileName, source, functionName) {
        const normPath = String(source?.path || fileName || '').replace(/\\/g, '/');
        const isProtocol = source?.itemKind === 'protocol' || normPath.startsWith('user/prot/');
        if (isProtocol && source?.anyfield?.seq_func) {
            const base = this.parseProtocolBase(source);
            const modulePath = String(base.module || '').replace(/\.py$/i, '');
            const isModule = modulePath.includes('.') && !modulePath.includes('/');
            return {
                seq_func_file: modulePath,
                seq_func: base.func || functionName,
                type: isModule ? 'module' : 'file',
            };
        }
        const pathOrModule = source?.path || fileName;
        const isModule = !!(
            source?.fullModulePath ||
            (typeof pathOrModule === 'string' &&
                !pathOrModule.includes('/') &&
                !pathOrModule.endsWith('.py') &&
                pathOrModule.includes('.'))
        );
        if (isModule) {
            const seqFuncFile = (source?.fullModulePath || source?.module || pathOrModule || '').replace(/\.py$/i, '');
            const entryFunc = source?.anyfield?.seq_func
                ? this.parseEntrySpec(source.anyfield.seq_func).func
                : null;
            const func = entryFunc || functionName || 'main';
            return { seq_func_file: seqFuncFile, seq_func: func, type: 'module' };
        }
        const seqFuncFile = source?.path ?? fileName;
        const func = functionName ?? 'main';
        return { seq_func_file: seqFuncFile, seq_func: func, type: 'file' };
    }

    /**
     * Build the Python import statement for a sequence (used in protocol generation).
     * @param {{ seq_func_file: string, seq_func: string, type: string }} meta - from getSequenceMetadata
     * @returns {string} Python import statement
     */
    buildImportStatement(meta) {
        if (meta.type === 'module') {
            // Folder/module sources import via their loader-assigned dotted module path.
            return `from ${String(meta.seq_func_file).replace(/\.py$/i, '')} import ${meta.seq_func}`;
        }
        const normPath = String(meta.seq_func_file).replace(/^\//, '');
        const slash = normPath.lastIndexOf('/');
        const importDir = slash >= 0 ? normPath.slice(0, slash) : '';
        const moduleName = (slash >= 0 ? normPath.slice(slash + 1) : normPath).replace(/\.py$/i, '');
        if (importDir) {
            return `import sys\nif '${importDir}' not in sys.path:\n    sys.path.insert(0, '${importDir}')\nfrom ${moduleName} import ${meta.seq_func}`;
        }
        return `from ${moduleName} import ${meta.seq_func}`;
    }

    parseEntrySpec(entry) {
        const s = String(entry || '');
        const idx = s.lastIndexOf(':');
        if (idx < 0) return { module: '', func: s };
        return { module: s.slice(0, idx), func: s.slice(idx + 1) };
    }

    isPackageBackedProtocolBase(source) {
        if (source?.anyfield?.seq_definition) return source.anyfield.seq_definition === 'package';
        return source?.type === 'module' || source?.type === 'pyodide_module';
    }

    _stripTopLevelMainBlock(code) {
        const lines = String(code || '').split('\n');
        const start = lines.findIndex((line) => /^if\s+__name__\s*==\s*['"]__main__['"]\s*:/.test(line));
        if (start < 0) return lines.join('\n');
        let end = lines.length;
        for (let i = start + 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim()) continue;
            if (/^\S/.test(line)) {
                end = i;
                break;
            }
        }
        return lines.slice(0, start).concat(lines.slice(end)).join('\n');
    }

    getProtocolShellImportLines() {
        return ['import numpy as np', 'import pypulseq as pp'];
    }

    /** Remove imports the protocol shell already provides so inline origin embedding stays clean. */
    _stripShellImportsFromOriginatingBody(body, shellImportLines = this.getProtocolShellImportLines()) {
        let out = String(body || '');
        for (const line of shellImportLines) {
            const escaped = String(line).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            out = out.replace(new RegExp(`^${escaped}\\s*\\n?`, 'gm'), '');
        }
        return out.replace(/\n{3,}/g, '\n\n').trim();
    }

    buildInlineCapsuleBody(code, source, callTargetFile) {
        let body = this.stripAnyfieldFileWrappers(code);
        body = this._stripTopLevelMainBlock(body).trim();
        body = this._stripShellImportsFromOriginatingBody(body);
        const origin = source?.origin || source?.htmlUrl || source?.downloadUrl || source?.filePath || callTargetFile || 'unknown origin';
        return [
            `# --- inline defined sequence adapted from: ${origin} ---`,
            body,
            '# --- end inline defined sequence ---',
        ].join('\n');
    }

    async getInlineBaseCode(callTargetFile, fallbackFileName, fallbackSource) {
        const targetKey = this.resolveSequenceKey(callTargetFile);
        const targetCode = targetKey ? this.sequences[targetKey]?.code : null;
        if (targetCode) return targetCode;
        const fallbackIsProtocol = fallbackSource?.itemKind === 'protocol'
            || String(fallbackFileName || '').replace(/\\/g, '/').startsWith('user/prot/');
        const targetNorm = String(callTargetFile || '').replace(/\\/g, '/').replace(/\.py$/i, '');
        const fallbackNorm = String(fallbackFileName || '').replace(/\\/g, '/').replace(/\.py$/i, '');
        if (fallbackIsProtocol && targetNorm && targetNorm !== fallbackNorm) {
            throw new Error(`Could not resolve inline base source ${callTargetFile}; refusing to embed protocol ${fallbackFileName}`);
        }
        const fallbackKey = this.resolveSequenceKey(fallbackFileName) || fallbackFileName;
        const fallbackCode = this.sequences[fallbackKey]?.code || this.sequences[fallbackFileName]?.code;
        if (fallbackCode) return fallbackCode;
        return await this.getOriginalCode(fallbackFileName, fallbackSource);
    }

    resolveProtocolBaseEntry(fileName, source, callTargetFile, callTargetFunc) {
        let baseFile = callTargetFile;
        let baseFunc = callTargetFunc;
        let baseMode = source?.anyfield?.seq_definition || 'inline';
        let origin = source?.origin || source?.htmlUrl || source?.downloadUrl || source?.filePath || source?.anyfield?.seq_origin || null;
        const seen = new Set();
        for (let depth = 0; depth < 10; depth++) {
            const norm = String(baseFile || '').replace(/\\/g, '/').replace(/\.py$/i, '');
            if (!norm.startsWith('user/prot/')) break;
            if (seen.has(norm)) {
                throw new Error(`Protocol base cycle detected at ${norm}`);
            }
            seen.add(norm);
            const key = this.resolveSequenceKey(baseFile) || this.resolveSequenceKey(`${norm}.py`) || this.resolveSequenceKey(norm);
            const fileData = key ? this.sequences[key] : null;
            const anyfield = fileData?.source?.anyfield
                || (fileData?.code ? this.extractAnyfieldJsonFromCode(fileData.code) : null);
            if (!anyfield) {
                throw new Error(`Could not resolve previous protocol base ${baseFile}`);
            }
            const next = this.parseEntrySpec(anyfield.seq_func || '');
            if (!next.module || !next.func) {
                throw new Error(`Protocol ${baseFile} has no underlying seq_func metadata`);
            }
            baseFile = next.module;
            baseFunc = next.func;
            baseMode = anyfield.seq_definition || baseMode;
            origin = anyfield.seq_origin || origin;
        }
        return { callTargetFile: baseFile, callTargetFunc: baseFunc, baseMode, origin };
    }

    async pinBarePackageDependencies(deps) {
        if (!this.config?.pyodide || !Array.isArray(deps) || !deps.length) return deps || [];
        const bare = deps
            .filter((d) => typeof d === 'string' && /^[A-Za-z0-9_.-]+(\[[^\]]+\])?$/.test(d.trim()))
            .map((d) => d.trim());
        if (!bare.length) return deps;
        this.config.pyodide.globals.set('_anyfield_pin_names', bare);
        let versions = {};
        try {
            const result = await this.config.pyodide.runPythonAsync(`
import json
try:
    from importlib.metadata import version
except Exception:
    from importlib_metadata import version
_out = {}
for _name in list(_anyfield_pin_names):
    _pkg = _name.split('[', 1)[0]
    try:
        _out[_name] = version(_pkg)
    except Exception:
        pass
json.dumps(_out)
`);
            versions = JSON.parse(result || '{}');
        } catch (e) {
            console.warn('Could not pin package dependency versions:', e);
        }
        return deps.map((dep) => {
            if (typeof dep !== 'string') return dep;
            const name = dep.trim();
            return versions[name] ? `${name}==${versions[name]}` : dep;
        });
    }

    /**
     * Build the portable Colab/Jupyter pip-install guard for a generated file body.
     * No-op as a plain script; installs deps when run in an IPython kernel.
     * @param {Array<string|{name:string}>} deps
     * @returns {string} guard block (empty string if no deps)
     */
    buildNotebookInstallGuard(deps) {
        const names = (deps || [])
            .map((d) => (typeof d === 'string' ? d : (d && d.name) || ''))
            .filter(Boolean);
        if (!names.length) return '';
        return [
            '# --- Notebook setup (Colab / Jupyter / JupyterLab / VS Code) ---',
            "_ipython = globals().get('get_ipython', lambda: None)()  # detect nb",
            'if _ipython is not None:',
            `    _ipython.run_line_magic('pip', 'install -q ${names.join(' ')}')`,
            '# --- Notebook setup end ---',
            '',
        ].join('\n');
    }

    /**
     * Format a value for embedding in protocol TOML.
     * @param {unknown} value
     * @returns {string}
     */
    _formatTomlValue(value) {
        if (value == null) return '""';
        if (typeof value === 'boolean') return value ? 'true' : 'false';
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) return '0';
            return Number.isInteger(value) ? String(value) : String(value);
        }
        if (typeof value === 'string') {
            return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
        }
        if (Array.isArray(value)) {
            const inner = value.map((v) => this._formatTomlValue(v)).join(', ');
            return `[${inner}]`;
        }
        return `"${String(value)}"`;
    }

    /**
     * Build the inner TOML body of a PEP 723 script block (uncommented).
     * This block is install metadata only: requires-python, dependencies, and
     * `[tool.anyfield] micropip_no_deps` install hints. Scanner metadata is stored
     * separately in `_anyfield_json`.
     * @param {object} config
     * @returns {string}
     */
    buildSourceConfigToml(config = {}) {
        const lines = ['requires-python = ">=3.9"'];

        // Dependencies as a PEP 508 array.
        let deps = config.dependencies || [];
        if (!Array.isArray(deps)) {
            deps = Object.entries(deps).map(([n, v]) =>
                (v && v !== '*') ? `${n}${/^[<>=!~]/.test(String(v)) ? v : '==' + v}` : n);
        }
        lines.push(`dependencies = ${this._formatTomlValue(deps)}`);

        // [tool.anyfield] is only used for installer/runtime hints that belong
        // next to dependencies. Scanner metadata lives in `_anyfield_json`.
        const af = config.anyfield || {};
        const noDeps = config.micropip_no_deps || af.micropip_no_deps || [];
        if (Array.isArray(noDeps) && noDeps.length) {
            lines.push('', '[tool.anyfield]');
            lines.push(`micropip_no_deps = ${this._formatTomlValue(noDeps)}`);
        }
        return lines.join('\n').trimEnd();
    }

    /** Comment the inner TOML and wrap it as a PEP 723 `# /// script … # ///` block. */
    wrapTomlPreamble(tomlInner) {
        const commented = String(tomlInner)
            .split('\n')
            .map((l) => (l.length ? `# ${l}` : '#'))
            .join('\n');
        return `# /// script\n${commented}\n# ///\n\n`;
    }

    /** Extract and de-comment the inner TOML of the PEP 723 script block, or null. */
    extractTomlBlockFromCode(code) {
        if (!code || typeof code !== 'string') return null;
        const match = code.match(/^# \/\/\/ script\s*$([\s\S]*?)^# \/\/\/\s*$/m);
        if (!match) return null;
        return match[1]
            .split('\n')
            .filter((l) => l.startsWith('#'))
            .map((l) => (l.startsWith('# ') ? l.slice(2) : l.slice(1)))
            .join('\n')
            .trim();
    }

    extractAnyfieldJsonFromCode(code) {
        if (!code || typeof code !== 'string') return null;
        const marked = code.match(/# --- AnyField metadata begin ---([\s\S]*?)# --- AnyField metadata end ---/m);
        if (!marked) return null;
        const match = marked[1].match(/_anyfield_json\s*=\s*r'''([\s\S]*?)'''/m);
        if (!match) return null;
        return JSON.parse(match[1].trim());
    }

    formatAnyfieldJson(value) {
        return this._stringifyAnyfieldJson(value, 0);
    }

    _stringifyAnyfieldJson(value, depth) {
        const indent = '  '.repeat(depth);
        const inner = '  '.repeat(depth + 1);
        if (value === null || typeof value !== 'object') {
            return JSON.stringify(value);
        }
        if (Array.isArray(value)) {
            if (!value.length) return '[]';
            const allPrimitive = value.every((v) => v === null || typeof v !== 'object');
            if (allPrimitive) {
                return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
            }
            const items = value.map((v) => `${inner}${this._stringifyAnyfieldJson(v, depth + 1)}`);
            return `[\n${items.join(',\n')}\n${indent}]`;
        }
        const keys = Object.keys(value);
        if (!keys.length) return '{}';
        const lines = keys.map((k) => {
            const serialized = this._stringifyAnyfieldJson(value[k], depth + 1);
            return `${inner}${JSON.stringify(k)}: ${serialized}`;
        });
        return `{\n${lines.join(',\n')}\n${indent}}`;
    }

    buildAnyfieldJsonBlock(anyfield = {}) {
        const json = this.formatAnyfieldJson(anyfield);
        return `# --- AnyField metadata begin ---\n` +
            `_anyfield_json = r'''\n${json}\n'''\n` +
            `# --- AnyField metadata end ---\n\n`;
    }

    replaceAnyfieldJsonInCode(code, anyfield) {
        const block = this.buildAnyfieldJsonBlock(anyfield).trimEnd();
        const markedRe = /# --- AnyField metadata begin ---[\s\S]*?# --- AnyField metadata end ---/m;
        if (!markedRe.test(code)) {
            throw new Error('Protocol file is missing marked AnyField metadata block');
        }
        return code.replace(markedRe, block);
    }

    parseProtocolBase(source) {
        return this.parseEntrySpec(source?.anyfield?.seq_func || '');
    }

    getProtocolProtFunc(source) {
        return source?.anyfield?.prot_func || null;
    }

    isPackageProtocol(source) {
        return source?.anyfield?.seq_definition === 'package';
    }

    async parseScriptMetadata(code) {
        if (!this.config?.pyodide) {
            throw new Error('Pyodide required to parse script metadata');
        }
        await this.ensureSourceManager();
        this.config.pyodide.globals.set('_meta_code', code);
        const result = await this.config.pyodide.runPythonAsync(`
from seq_source_manager import parse_script_metadata
parse_script_metadata(_meta_code)
`);
        const parsed = JSON.parse(result);
        return {
            dependencies: parsed.dependencies || [],
            micropip_no_deps: parsed.micropip_no_deps || parsed.anyfield?.micropip_no_deps || [],
            anyfield: parsed.anyfield || {},
        };
    }

    async parseCodeMetadata(code) {
        return this.parseScriptMetadata(code);
    }

    async parsePepInstallConfig(tomlString) {
        const pyodide = this.config?.pyodide;
        if (!pyodide) {
            throw new Error('Pyodide required to parse TOML');
        }
        pyodide.globals.set('_toml_payload', tomlString);
        const result = await pyodide.runPythonAsync(`
from seq_source_manager import parse_metadata_toml
parse_metadata_toml(_toml_payload)
`);
        const parsed = JSON.parse(result);
        return {
            dependencies: parsed.dependencies || [],
            micropip_no_deps: parsed.micropip_no_deps || [],
        };
    }

    formatSimulationReconTooltipLines(simulation, recon) {
        const lines = [];
        if (simulation && Object.keys(simulation).length) {
            lines.push('Simulation:');
            if (simulation.backend != null) {
                lines.push(`  backend: ${formatSimBackendLabel(simulation.backend)}`);
            }
            if (simulation.phantom != null) lines.push(`  phantom: ${simulation.phantom}`);
            const base = Array.isArray(simulation.phantom_matrix) ? simulation.phantom_matrix : null;
            const os = Array.isArray(simulation.phantom_oversample) ? simulation.phantom_oversample : null;
            if (base) {
                lines.push(`  phantom_matrix: [${base.join(', ')}]`);
            }
            if (os) {
                lines.push(`  phantom_oversample: [${os.join(', ')}]`);
                if (base && base.length >= 3 && os.length >= 3) {
                    const eff = base.map((d, i) => Math.max(1, Math.round(Number(d) * Number(os[i]))));
                    lines.push(`  phantom_matrix (effective): [${eff.join(', ')}]`);
                }
            }
            if (Array.isArray(simulation.fov_matrix)) {
                lines.push(`  fov_matrix: [${simulation.fov_matrix.join(', ')}]`);
            }
        }
        if (recon && Object.keys(recon).length) {
            lines.push('Recon:');
            if (Array.isArray(recon.matrix)) lines.push(`  matrix: [${recon.matrix.join(', ')}]`);
            if (recon.method != null) lines.push(`  method: ${recon.method}`);
        }
        return lines;
    }

    async patchProtocolTomlSections(protocolPath, { simulation, recon } = {}) {
        if (!protocolPath) return false;
        const norm = String(protocolPath).replace(/\\/g, '/');
        let key = this.sequences[norm] ? norm : null;
        if (!key) {
            key = Object.keys(this.sequences).find((k) => this._sequenceKeyToPath(k) === norm) || null;
        }
        const fileData = key ? this.sequences[key] : null;
        let code = fileData?.code;
        if (!code && this.config.pyodide) {
            try {
                const vfs = this.vfsPath(norm);
                code = this.config.pyodide.FS.readFile(vfs, { encoding: 'utf8' });
            } catch (_) { /* ignore */ }
        }
        if (!code) {
            console.warn('patchProtocolTomlSections: no code for', norm);
            return false;
        }
        const anyfieldJson = fileData?.source?.anyfield || this.extractAnyfieldJsonFromCode(code);
        if (!anyfieldJson) {
            console.warn('patchProtocolTomlSections: no AnyField metadata in', norm);
            return false;
        }
        const patched = { ...anyfieldJson };
        if (simulation) patched.simulation = { ...(patched.simulation || {}), ...simulation };
        if (recon) patched.recon = { ...(patched.recon || {}), ...recon };
        const newCode = this.replaceAnyfieldJsonInCode(code, patched);
        await this.storeUserFile(norm, newCode);
        if (fileData) {
            fileData.code = newCode;
            if (fileData.source) fileData.source.anyfield = patched;
        }
        await this.mirrorLocalPythonModuleToPyodide(norm, newCode);
        return true;
    }

    /**
     * TOML preamble for sequence/protocol files (PEP 723 install metadata only).
     */
    generateTOMLPreamble(fileName, source, functionName, options = {}) {
        const deps = source?.dependencies || [];
        const depStrings = [];
        const noDeps = [];
        for (const dep of deps) {
            if (typeof dep === 'string') {
                depStrings.push(dep);
            } else if (dep && typeof dep === 'object' && dep.name) {
                depStrings.push(dep.version ? `${dep.name}${dep.version}` : dep.name);
                if (dep.deps === false) noDeps.push(String(dep.name).split(/[>=<!~]/)[0].trim());
            }
        }
        for (const n of (source?.micropip_no_deps || [])) {
            const nm = String(n).split(/[>=<!~]/)[0].trim();
            if (!noDeps.includes(nm)) noDeps.push(nm);
        }

        const tomlInner = this.buildSourceConfigToml({
            dependencies: depStrings,
            micropip_no_deps: noDeps,
        });
        return this.wrapTomlPreamble(tomlInner);
    }

    /**
     * PEP 723 preamble + notebook `%pip install` guard from install metadata.
     * Used when materializing folder scripts, saving protocols, and lazy editor prepend.
     * @param {{dependencies?: Array, micropip_no_deps?: string[]}} installSource
     * @returns {{ preamble: string, guard: string, prefix: string }}
     */
    buildInstallableFileShell(installSource = {}) {
        const preamble = this.generateTOMLPreamble('', installSource, 'main');
        const guard = this.buildNotebookInstallGuard(this.normalizeSourceDeps(installSource));
        const prefix = preamble + (guard ? `${guard}\n` : '');
        return { preamble, guard, prefix };
    }
    
    async getOriginalCode(fileName, source) {
        // Get the FULL original code file for the sequence
        const fileData = this.sequences[fileName];
        let originalCode = fileData?.code;
        
        if (!originalCode) {
            const path = source?.path || '';
            const isModule = source.type === 'module' || source.type === 'pyodide_module' || !!source.fullModulePath ||
                (typeof path === 'string' && !path.includes('/') && !path.endsWith('.py') && path.includes('.'));
            if (isModule && this.config.pyodide) {
                try {
                    const modulePath = source.fullModulePath || source.module || source.path;
                    
                    await this.ensureSourceManager();
                    // Get the full module source file
                    const sourceCode = await this.config.pyodide.runPythonAsync(`
import inspect
import json
import importlib
import os

_result = ''
try:
    module = importlib.import_module('${modulePath}')
    # Get the full module source file
    module_file = inspect.getfile(module)
    if os.path.exists(module_file):
        with open(module_file, 'r', encoding='utf-8') as f:
            _result = f.read()
    else:
        # Fallback: try to get source via inspect.getsource for the module itself
        try:
            _result = inspect.getsource(module)
        except:
            _result = ''
except Exception as e:
    _result = ''

json.dumps(_result)
`);
                    originalCode = JSON.parse(sourceCode);
                } catch (e) {
                    console.warn('Could not fetch full module source:', e);
                }
            }
            
            // If still no code, try to get from cached code in sequences
            if (!originalCode && fileData) {
                // For other source types, the code should already be in fileData.code
                // But if it's not, we might need to reload it
                console.warn('No code found for file:', fileName);
            }
            
            // Last resort: create a basic template
            if (!originalCode) {
                const functionName = this.selectedSequence?.functionName || 'main';
                originalCode = `def ${functionName}():\n    # Your code here\n    pass\n`;
            }
        }
        
        return originalCode;
    }
    async storeUserFile(path, code) {
        if (!this.config.pyodide) {
            throw new Error('Pyodide not available');
        }
        const normPath = this.normalizeUserArtifactPath(path);
        const codeToStore = code;
        if (this.isUserArtifactPath(normPath)) {
            await this.mirrorLocalPythonModuleToPyodide(normPath, codeToStore);
            await this.config.pyodide.runPythonAsync(`
import sys
if not hasattr(sys.modules['__main__'], '_user_edited_files'):
    sys.modules['__main__']._user_edited_files = {}
sys.modules['__main__']._user_edited_files[${JSON.stringify(normPath)}] = ${JSON.stringify(codeToStore)}
`);
            if (this.sequences[normPath]) this.sequences[normPath].code = codeToStore;
        }
    }
    
    async saveProtocolSnapshot(protocolName) {
        if (!this.selectedSequence) {
            console.warn('Cannot save protocol: No function selected');
            return null;
        }

        // 1. Gather Parameters
        const params = {};
        const paramsRoot = this.paramsTarget || this.container;
        
        if (this.functionParams) {
            this.functionParams.forEach(param => {
                const input = paramsRoot.querySelector(`#seq-param-${param.name}`);
                if (!input) return;
                
                let valExpr;
                if (param.type === 'bool') {
                    valExpr = input.checked ? 'True' : 'False';
                } else {
                    const inputValue = input.value.trim();
                    if (inputValue === '') return; // Use default
                    
                    if (param.type === 'int' || param.type === 'float') {
                        valExpr = inputValue;
                    } else if (param.type === 'list' || param.type === 'ndarray') {
                        valExpr = `np.array(${inputValue})`;
                    } else if (param.type === 'str' || param.type === 'file' || param.type === 'url') {
                        valExpr = `"${inputValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
                    } else {
                        valExpr = inputValue;
                    }
                }
                params[param.name] = valExpr;
            });
        }

        // 2. Resolve call target from anyfield.seq_func for protocols
        const { fileName, functionName: functionFromExplorer, source } = this.selectedSequence;
        const meta = this.getSequenceMetadata(fileName, source, functionFromExplorer);
        const isProtocol = source?.itemKind === 'protocol' || (source?.path && source.path.startsWith('user/prot/'));
        let callTargetFile;
        let callTargetFunc;
        if (isProtocol) {
            const base = this.parseProtocolBase(source);
            callTargetFile = base.module || meta.seq_func_file;
            callTargetFunc = base.func || meta.seq_func;
        } else {
            callTargetFile = meta.seq_func_file || source?.path || fileName;
            callTargetFunc = meta.seq_func || functionFromExplorer || 'main';
        }
        if (String(callTargetFunc).startsWith('prot_')) {
            const entryFunc = this.parseEntrySpec(source?.anyfield?.seq_func || '').func;
            if (entryFunc && entryFunc !== callTargetFunc) callTargetFunc = entryFunc;
        }
        const resolvedBase = isProtocol
            ? this.resolveProtocolBaseEntry(fileName, source, callTargetFile, callTargetFunc)
            : {
                callTargetFile,
                callTargetFunc,
                baseMode: this.isPackageBackedProtocolBase(source) ? 'package' : 'inline',
                origin: source?.origin || source?.htmlUrl || source?.downloadUrl || source?.filePath,
            };
        callTargetFile = resolvedBase.callTargetFile;
        callTargetFunc = resolvedBase.callTargetFunc;
        const capsuleMode = resolvedBase.baseMode === 'package' ? 'package' : 'inline';

        const paramStrs = Object.entries(params).map(([k, v]) => `${k}=${v}`);
        const signature = paramStrs.join(',\n    ');

        const pendingMeta = this._pendingProtocolMeta || {};
        const sourcePath = String(source?.path || fileName || '').replace(/\\/g, '/');
        // Base sequence stem (fallback when no user scan name is provided).
        const baseStem = callTargetFunc.startsWith('seq_')
            ? callTargetFunc.slice(4)
            : (callTargetFunc.startsWith('prot_') ? callTargetFunc.slice(5) : callTargetFunc);
        // Prefer scan-module draft name; for protocol-of-protocol keep parent scan in the stem (e.g. 3.gre).
        let scanLabel = String(pendingMeta.name || '').replace(/^\s*\d+\.\s*/, '').trim();
        if (!scanLabel && isProtocol && sourcePath.startsWith('user/prot/')) {
            scanLabel = this.protocolDerivedDefaultName(sourcePath) || scanLabel;
        }
        let stemSafe = scanLabel
            ? scanLabel.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase()
            : '';
        if (!stemSafe) stemSafe = baseStem;
        const shortName = 'prot_' + stemSafe;
        const filePrefix = (protocolName != null && protocolName !== true && String(protocolName).match(/^\d+$/))
            ? protocolName + '_'
            : '';
        const finalFileName = `user/prot/${filePrefix}${shortName}.py`;
        const safeFunctionName = shortName;
        const protocolDeps = capsuleMode === 'package'
            ? await this.pinBarePackageDependencies(source?.dependencies || [])
            : (source?.dependencies || []);
        const protocolSource = { ...source, dependencies: protocolDeps };
        const baseEntry = `${String(callTargetFile).replace(/\.py$/i, '')}:${callTargetFunc}`;
        const anyfieldMeta = {
            kind: 'protocol',
            prot_func: safeFunctionName,
            seq_definition: capsuleMode,
            seq_func: baseEntry,
        };
        const baseOrigin = resolvedBase.origin || source?.origin || source?.htmlUrl || source?.downloadUrl || source?.filePath;
        if (baseOrigin) anyfieldMeta.seq_origin = baseOrigin;
        const { prefix: installShell } = this.buildInstallableFileShell(protocolSource);
        const anyfieldBlock = this.buildAnyfieldJsonBlock(anyfieldMeta);
        const baseBinding = capsuleMode === 'package'
            ? `${this.buildImportStatement({ seq_func_file: callTargetFile, seq_func: callTargetFunc, type: meta.type })}\n_anyfield_base_callable = ${callTargetFunc}`
            : `${this.buildInlineCapsuleBody(await this.getInlineBaseCode(callTargetFile, fileName, source), { ...source, origin: baseOrigin }, callTargetFile)}\n\n_anyfield_base_callable = ${callTargetFunc}`;
        const shellImports = this.getProtocolShellImportLines().join('\n');
        const code = installShell + anyfieldBlock + `
${shellImports}
${baseBinding}

def ${safeFunctionName}(
    ${signature}
):
    kwargs = locals().copy()
    return _anyfield_base_callable(**kwargs)
`.trim();

        // 3. Save silently
        
        try {
            if (filePrefix) {
                await this._purgeOtherProtocolsForScanNumber(protocolName, finalFileName);
            }
            await this.storeUserFile(finalFileName, code);

            const displayName = this.protocolDisplayNameFromPath(finalFileName, scanLabel || pendingMeta.name);
            const fullModulePath = finalFileName.replace(/\.py$/i, '').replace(/\//g, '.');
            const newSource = {
                name: 'User Protocols',
                itemKind: 'protocol',
                anyfield: { ...anyfieldMeta },
                type: 'file',
                path: finalFileName,
                fullModulePath: fullModulePath,
                description: 'Protocol Snapshot',
                isUserEdited: true,
                displayName,
                // Carry the base's deps forward so re-deriving a protocol from this protocol
                // (and the saved file's own notebook guard) keeps the install lines.
                dependencies: protocolDeps,
                micropip_no_deps: source?.micropip_no_deps || [],
            };
            
            // Update config
            const sourceIndex = this.config.sources.findIndex(s => this.getSourcePath(s) === finalFileName);
            if (sourceIndex >= 0) {
                this.config.sources[sourceIndex] = newSource;
            } else {
                this.config.sources.push(newSource);
            }
            
            // Parse and refresh
            await this.parseFile(finalFileName, code, newSource);
            this.renderTree();
            console.log('Protocol snapshot saved:', shortName);
            return finalFileName;
            
        } catch (e) {
            console.error('Error saving protocol snapshot:', e);
            return null;
        }
    }


    async showCodeEditor() {
        if (!this.selectedSequence) {
            this.showStatus('Please select a function first', 'error');
            return;
        }

        document.querySelectorAll('.seq-editor-modal[data-editor="code"]').forEach((el) => el.remove());
        
        const { fileName, functionName } = this.selectedSequence;
        const source = this.selectedSequence.source;
        
        // Get FULL original code file (not just the function)
        const originalCode = await this.getOriginalCode(fileName, source);
        
        // Check if code already has a PEP 723 preamble (from previous edit)
        const hasTOML = !!this.extractTomlBlockFromCode(originalCode);
        
        let fullCode = originalCode;
        if (!hasTOML) {
            const { prefix } = this.buildInstallableFileShell(source);
            fullCode = prefix + originalCode;
        }
        
        // Create modal
        const modal = document.createElement('div');
        modal.className = 'seq-editor-modal';
        modal.dataset.editor = 'code';
        
        const modalContent = document.createElement('div');
        modalContent.className = 'seq-editor-container';
        
        const header = document.createElement('div');
        header.className = 'seq-editor-header';
        
        const title = document.createElement('h2');
        title.textContent = `Edit Code: ${fileName}:${functionName}`;
        header.appendChild(title);
        
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = 'display: flex; gap: 0.5rem; flex-wrap: wrap;';
        
        const isProtocol = source?.itemKind === 'protocol' || (source?.path && source.path.startsWith('user/prot/'));
        const seqFuncFile = isProtocol ? this.parseProtocolBase(source).module : null;
        if (isProtocol && seqFuncFile) {
            const editUnderlyingBtn = document.createElement('button');
            editUnderlyingBtn.className = 'btn btn-secondary btn-md';
            editUnderlyingBtn.textContent = 'Edit underlying sequence';
            editUnderlyingBtn.onclick = async () => {
                const key = this.resolveSequenceKey(seqFuncFile);
                const underlyingSource = (key && this.sequences[key]?.source) ?? this.config.sources.find(s => this.getSourcePath(s) === seqFuncFile);
                if (!underlyingSource) {
                    this.showStatus(`Could not resolve source for ${seqFuncFile}`, 'error');
                    return;
                }
                const funcName = this.parseProtocolBase(source).func
                    || this.getSourceBaseSequence(underlyingSource)
                    || 'main';
                const fileData = key ? this.sequences[key] : null;
                const func = fileData?.functions?.find(f => f.name === funcName) || fileData?.functions?.[0] || {};
                const displayName = this.getProtocolDisplayNameFromSeqFuncFile(this.getPathForDisplayName(key || seqFuncFile, underlyingSource)) || (underlyingSource?.path || seqFuncFile).split('/').pop().replace(/\.py$/, '');
                this.selectedSequence = { fileName: key || seqFuncFile, functionName: func.name || funcName, displayName, ...func, source: underlyingSource };
                modal.remove();
                await this.showCodeEditor();
            };
            buttonContainer.appendChild(editUnderlyingBtn);
        }
        
        const loadOriginalBtn = document.createElement('button');
        loadOriginalBtn.className = 'btn btn-secondary btn-md';
        loadOriginalBtn.textContent = 'Load Original';
        loadOriginalBtn.onclick = () => {
            if (editor) editor.setValue(fullCode);
        };

        const downloadPyBtn = document.createElement('button');
        downloadPyBtn.className = 'btn btn-secondary btn-md';
        downloadPyBtn.textContent = 'Download py';
        downloadPyBtn.onclick = () => {
            const code = editor.getValue();
            let downloadName = String(fileName || 'sequence').split('/').pop();
            if (!downloadName.endsWith('.py')) downloadName += '.py';
            const blob = new Blob([code], { type: 'text/x-python;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = downloadName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        };
        
        const saveAsBtn = document.createElement('button');
        saveAsBtn.className = 'btn btn-secondary btn-md';
        saveAsBtn.textContent = 'Save As...';
        
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn btn-secondary btn-md';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = () => modal.remove();
        
        buttonContainer.appendChild(loadOriginalBtn);
        buttonContainer.appendChild(downloadPyBtn);
        buttonContainer.appendChild(saveAsBtn);
        buttonContainer.appendChild(cancelBtn);
        header.appendChild(buttonContainer);
        
        const editorContainer = document.createElement('div');
        editorContainer.className = 'seq-editor-body';
        
        let editor;
        if (window.CodeMirror) {
            const textarea = document.createElement('textarea');
            textarea.value = fullCode;
            editorContainer.appendChild(textarea);
            
            editor = CodeMirror.fromTextArea(textarea, {
                lineNumbers: true,
                mode: 'python',
                theme: 'monokai',
                indentUnit: 4,
                indentWithTabs: false,
                lineWrapping: true,
                styleActiveLine: true,
                matchBrackets: true,
            });
            editor.setSize('100%', '100%');
        } else {
            const textarea = document.createElement('textarea');
            textarea.value = fullCode;
            textarea.style.cssText = `
                width: 100%;
                height: 100%;
                background: var(--bg-secondary, #252525);
                color: var(--text, #ddd);
                border: none;
                padding: 0.75rem;
                font-family: 'Courier New', monospace;
                font-size: 0.875rem;
                resize: none;
            `;
            editorContainer.appendChild(textarea);
            editor = {
                getValue: () => textarea.value,
                setValue: (val) => { textarea.value = val; },
                focus: () => textarea.focus(),
                refresh: () => {}
            };
        }
        
        // Helper function to sanitize filename
        const sanitizeFileName = (name) => {
            // Remove or replace invalid filename characters
            return name
                .replace(/[<>:"/\\|?*]/g, '_')  // Replace invalid chars with underscore
                .replace(/\s+/g, '_')           // Replace spaces with underscore
                .replace(/^\.+|\.+$/g, '')       // Remove leading/trailing dots
                .replace(/_{2,}/g, '_')          // Replace multiple underscores with single
                .toLowerCase();                   // Convert to lowercase
        };
        
        // Helper function to save (sequence or protocol; preserves parent kind)
        const savingProtocol = source?.itemKind === 'protocol' || (source?.path && source.path.startsWith('user/prot/'));
        const saveSequence = async (targetFileName, targetName, overwrite = false) => {
            let code = editor.getValue();
            if (!code.trim()) {
                this.showStatus('Code cannot be empty', 'error');
                return false;
            }
            
            // Extract PEP 723 config from code
            const tomlInner = this.extractTomlBlockFromCode(code);
            if (!tomlInner) {
                this.showStatus('PEP 723 configuration not found in code', 'error');
                return false;
            }
            
            const parsedMeta = await this.parseScriptMetadata(code);
            const anyfield = parsedMeta.anyfield || source?.anyfield || {};
            const deps = Array.isArray(parsedMeta.dependencies) ? parsedMeta.dependencies.slice() : [];
            const noDeps = Array.isArray(parsedMeta.micropip_no_deps) ? parsedMeta.micropip_no_deps.slice() : [];
            const baseEntry = savingProtocol ? this.parseProtocolBase({ anyfield }) : { module: '', func: functionName };
            const seqFunc = savingProtocol ? (anyfield.prot_func || functionName) : functionName;
            const seqFuncFileFromMeta = savingProtocol ? baseEntry.module : '';

            const nameForFile = targetName || seqFuncFileFromMeta || `${fileName}_edited`;
            const sanitizedName = sanitizeFileName(nameForFile);
            if (/^\d+_/.test(sanitizedName)) {
                this.showReservedPrefixDialog();
                return false;
            }
            const baseFileName = sanitizedName.endsWith('.py') ? sanitizedName : `${sanitizedName}.py`;
            const userDir = savingProtocol ? 'user/prot' : 'user/seq';
            const finalFileName = `${userDir}/${baseFileName}`;

            const displayName = savingProtocol
                ? (this.protocolDisplayNameFromPath(finalFileName) || targetName || seqFuncFileFromMeta || `${fileName}_edited`)
                : (targetName || seqFuncFileFromMeta || `${fileName}_edited`);

            const saveSource = { path: finalFileName, dependencies: deps, micropip_no_deps: noDeps };
            const { preamble } = this.buildInstallableFileShell(saveSource);
            const tomlBlockRegex = /^# \/\/\/ script[\s\S]*?^# \/\/\/\s*\n+/m;
            code = code.replace(tomlBlockRegex, preamble);

            const fullModulePath = finalFileName.replace(/\.py$/i, '').replace(/\//g, '.');
            const newSource = {
                name: savingProtocol ? 'User Protocols' : 'User Refined Sequences',
                itemKind: savingProtocol ? 'protocol' : 'sequence',
                path: finalFileName,
                anyfield: savingProtocol ? anyfield : (Object.keys(anyfield).length ? anyfield : undefined),
                type: 'file',
                fullModulePath,
                description: savingProtocol ? 'User edited protocol' : 'User edited sequence',
                dependencies: deps,
                micropip_no_deps: noDeps,
                isUserEdited: true,
                displayName: displayName
            };
            if (newSource.anyfield === undefined) delete newSource.anyfield;
            
            if (this.config.pyodide) {
                try {
                    // Store code in Python memory (with normalized TOML)
                    await this.storeUserFile(finalFileName, code);
                    
                    // Update or add source in config
                    const sourceIndex = this.config.sources.findIndex(s => this.getSourcePath(s) === finalFileName);
                    if (sourceIndex >= 0) {
                        // Update existing source
                        this.config.sources[sourceIndex] = newSource;
                    } else {
                        // Register as new source (even when overwrite=true but source wasn't in config)
                        this.config.sources.push(newSource);
                    }
                    
                    // Parse the file to extract all functions
                    await this.parseFile(finalFileName, code, newSource);
                    
                    // Update selected sequence
                    const fileData = this.sequences[finalFileName];
                    if (fileData && fileData.functions.length > 0) {
                        const func = fileData.functions.find(f => f.name === functionName) || fileData.functions[0];
                        const displayName = savingProtocol
                            ? newSource.displayName
                            : (newSource?.displayName || this.getProtocolDisplayNameFromSeqFuncFile(this.getPathForDisplayName(finalFileName, newSource)) || (newSource?.path || finalFileName).split('/').pop().replace(/\.py$/, ''));
                        this.selectedSequence = { 
                            fileName: finalFileName, 
                            functionName: func.name, 
                            displayName,
                            ...func,
                            source: newSource
                        };
                        this.updateSequenceNameDisplay();
                        
                        // Notify other modules via eventHub
                        eventHub.emit('sequenceSelected', this.selectedSequence);
                        
                        await this.loadFunctionParameters(this.selectedSequence);
                    }
                    
                    this.renderTree();
                    this.showStatus(savingProtocol ? 'Protocol saved and registered!' : 'Sequence saved and registered!', 'success');
                    return true;
                } catch (err) {
                    this.showStatus(`Error saving: ${err.message}`, 'error');
                    console.error('Error saving sequence:', err);
                    return false;
                }
            } else {
                this.showStatus('Pyodide not available', 'error');
                return false;
            }
        };
        
        // Save As handler (opens file browser dialog)
        saveAsBtn.onclick = async () => {
            let defaultName = fileName;
            const savingProtocolForDialog = source?.itemKind === 'protocol' || (source?.path && source.path.startsWith('user/prot/'));
            try {
                const code = editor.getValue();
                if (savingProtocolForDialog) {
                    defaultName = this.protocolSeqStemFromPath(fileName) || defaultName;
                } else {
                    const parsedMeta = await this.parseScriptMetadata(code);
                    const baseModule = this.parseProtocolBase({ anyfield: parsedMeta.anyfield || {} }).module;
                    if (baseModule) defaultName = baseModule;
                }
            } catch (e) {
                // Use fileName as fallback
            }

            if (defaultName.endsWith('.py')) {
                defaultName = defaultName.slice(0, -3);
            }
            if (defaultName.startsWith('user/')) {
                defaultName = defaultName.slice(5);
            }
            if (!savingProtocolForDialog) {
                defaultName = this.getProtocolDisplayNameFromSeqFuncFile(defaultName) || defaultName;
            }

            const userDirPrefix = savingProtocolForDialog ? 'user/prot/' : 'user/seq/';
            const allUserFiles = await this.getUserFiles();
            const existingFiles = allUserFiles.filter(f => f.path.startsWith(userDirPrefix));
            
            // Create dialog
            const dialog = document.createElement('div');
            dialog.style.cssText = `
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
            dialogTitle.textContent = savingProtocolForDialog ? 'Save As - User Protocols' : 'Save As - User Sequences';
            dialogTitle.style.cssText = 'margin: 0 0 1rem 0; color: var(--accent, #4a9eff);';
            
            // File list container
            const fileListContainer = document.createElement('div');
            fileListContainer.style.cssText = `
                max-height: 300px;
                overflow-y: auto;
                border: 1px solid var(--border, #333);
                border-radius: 4px;
                background: rgba(255, 255, 255, 0.04);
                margin-bottom: 1rem;
                padding: 0.5rem;
            `;
            
            const fileList = document.createElement('div');
            fileList.style.cssText = 'display: flex; flex-direction: column; gap: 0.25rem;';
            
            // Populate file list
            existingFiles.forEach(fileInfo => {
                const fileItem = document.createElement('div');
                fileItem.style.cssText = `
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 0.5rem;
                    border-radius: 4px;
                    cursor: pointer;
                    transition: background 0.2s;
                `;
                
                const fileNameSpan = document.createElement('span');
                fileNameSpan.textContent = fileInfo.displayName || fileInfo.name;
                fileNameSpan.style.cssText = 'color: var(--text, #ddd); font-size: 0.875rem; flex: 1;';
                
                const deleteBtn = document.createElement('button');
                deleteBtn.textContent = '×';
                deleteBtn.style.cssText = `
                    padding: 0.2rem 0.5rem;
                    background: rgba(239, 68, 68, 0.2);
                    color: #ef4444;
                    border: 1px solid #ef4444;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 1rem;
                    line-height: 1;
                    margin-left: 0.5rem;
                `;
                deleteBtn.onclick = async (e) => {
                    e.stopPropagation();
                    if (confirm(`Delete "${fileInfo.displayName || fileInfo.name}"?`)) {
                        await this.deleteUserFile(fileInfo.path);
                        dialog.remove();
                        // Reopen dialog to refresh list
                        saveAsBtn.click();
                    }
                };
                
                fileItem.onclick = () => {
                    let name = fileInfo.displayName || fileInfo.name;
                    if (name.endsWith('.py')) name = name.slice(0, -3);
                    input.value = name;
                    input.focus();
                    input.select();
                };
                
                fileItem.onmouseenter = () => {
                    fileItem.style.background = 'rgba(255, 255, 255, 0.1)';
                };
                fileItem.onmouseleave = () => {
                    fileItem.style.background = 'transparent';
                };
                
                fileItem.appendChild(fileNameSpan);
                fileItem.appendChild(deleteBtn);
                fileList.appendChild(fileItem);
            });
            
            if (existingFiles.length === 0) {
                const emptyMsg = document.createElement('div');
                emptyMsg.textContent = 'No saved files yet';
                emptyMsg.style.cssText = 'padding: 1rem; text-align: center; color: var(--muted); font-style: italic;';
                fileList.appendChild(emptyMsg);
            }
            
            fileListContainer.appendChild(fileList);
            
            const label = document.createElement('label');
            label.textContent = savingProtocolForDialog ? 'Protocol Name:' : 'Sequence Name:';
            label.style.cssText = 'display: block; margin-bottom: 0.5rem; color: var(--text, #ddd); font-size: 0.875rem;';
            
            const input = document.createElement('input');
            input.type = 'text';
            input.value = defaultName;
            input.style.cssText = `
                width: 100%;
                padding: 0.5rem;
                background: rgba(255, 255, 255, 0.1);
                color: var(--text, #ddd);
                border: 1px solid var(--border, #333);
                border-radius: 4px;
                font-size: 0.875rem;
                margin-bottom: 1rem;
                box-sizing: border-box;
            `;
            
            const buttonContainer = document.createElement('div');
            buttonContainer.style.cssText = 'display: flex; gap: 0.5rem; justify-content: flex-end;';
            
            const cancelDialogBtn = document.createElement('button');
            cancelDialogBtn.className = 'btn btn-secondary btn-md';
            cancelDialogBtn.textContent = 'Cancel';
            cancelDialogBtn.onclick = () => dialog.remove();
            
            const confirmBtn = document.createElement('button');
            confirmBtn.className = 'btn btn-secondary btn-md';
            confirmBtn.textContent = 'Save';
            
            confirmBtn.onclick = async () => {
                const newName = input.value.trim();
                if (!newName) {
                    alert('Please enter a name');
                    return;
                }
                const sanitizedName = sanitizeFileName(newName);
                if (/^\d+_/.test(sanitizedName)) {
                    this.showReservedPrefixDialog();
                    return;
                }
                // Check if file already exists
                const baseFileName = sanitizedName.endsWith('.py') ? sanitizedName : `${sanitizedName}.py`;
                const finalFileName = userDirPrefix + baseFileName;
                
                const fileExists = existingFiles.some(f => f.path === finalFileName);
                if (fileExists && !confirm(`File "${newName}" already exists. Overwrite?`)) {
                    return;
                }
                
                // Use the provided name as the filename (will be sanitized in saveSequence)
                const tempFileName = 'temp'; // Will be replaced with sanitized name
                
                confirmBtn.disabled = true;
                confirmBtn.textContent = 'Saving...';
                
                const success = await saveSequence(tempFileName, newName, fileExists);
                
                if (success) {
                    dialog.remove();
                    modal.remove();
                } else {
                    confirmBtn.disabled = false;
                    confirmBtn.textContent = 'Save';
                }
            };
            
            input.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    confirmBtn.click();
                } else if (e.key === 'Escape') {
                    cancelDialogBtn.click();
                }
            };
            
            buttonContainer.appendChild(cancelDialogBtn);
            buttonContainer.appendChild(confirmBtn);
            
            dialogContent.appendChild(dialogTitle);
            dialogContent.appendChild(fileListContainer);
            dialogContent.appendChild(label);
            dialogContent.appendChild(input);
            dialogContent.appendChild(buttonContainer);
            dialog.appendChild(dialogContent);
            
            document.body.appendChild(dialog);
            
            // Focus input and select text
            setTimeout(() => {
                input.focus();
                input.select();
            }, 100);
            
            // Close on background click
            dialog.onclick = (e) => {
                if (e.target === dialog) dialog.remove();
            };
        };
        
        modalContent.appendChild(header);
        modalContent.appendChild(editorContainer);
        modal.appendChild(modalContent);
        
        document.body.appendChild(modal);
        bindCodeEditorSelectAll(editor, modal);
        
        // Focus editor
        setTimeout(() => {
            if (editor.focus) editor.focus();
            if (editor.refresh) editor.refresh();
        }, 100);
    }
    
    async collectUserProtocolFiles() {
        const byPath = new Map();

        for (const [path, fileData] of Object.entries(this.sequences)) {
            const norm = String(path).replace(/\\/g, '/');
            if (norm.startsWith('user/prot/') && fileData?.code) {
                byPath.set(norm, fileData.code);
            }
        }

        if (this.config.pyodide) {
            try {
                const result = await this.config.pyodide.runPythonAsync(`
import sys
import json

files = {}
if hasattr(sys.modules['__main__'], '_user_edited_files'):
    for path, code in sys.modules['__main__']._user_edited_files.items():
        if path.startswith('user/prot/'):
            files[path] = code
json.dumps(files)
`);
                const pyFiles = JSON.parse(result);
                for (const [path, code] of Object.entries(pyFiles)) {
                    if (code && !byPath.has(path)) byPath.set(path, code);
                }
            } catch (e) {
                console.warn('Could not read user protocols from Pyodide memory:', e);
            }
        }

        return [...byPath.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([path, code]) => ({
                path,
                name: path.split('/').pop(),
                code,
            }));
    }

    _downloadTextFile(name, text) {
        const blob = new Blob([text], { type: 'text/x-python;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    async downloadUserProtocols() {
        const files = await this.collectUserProtocolFiles();
        if (!files.length) {
            this.showStatus('No user protocols to download', 'error');
            return;
        }

        if (files.length === 1) {
            this._downloadTextFile(files[0].name, files[0].code);
            this.showStatus(`Downloaded ${files[0].name}`, 'success');
            return;
        }

        try {
            const JSZip = (await import('https://esm.run/jszip@3.10.1')).default;
            const zip = new JSZip();
            const folder = zip.folder('user_protocols') || zip;
            for (const { name, code } of files) {
                folder.file(name, code);
            }
            const blob = await zip.generateAsync({ type: 'blob' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'user_protocols.zip';
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            this.showStatus(`Downloaded ${files.length} protocols`, 'success');
        } catch (e) {
            console.error('Protocol zip download failed, falling back to individual files:', e);
            for (const { name, code } of files) {
                this._downloadTextFile(name, code);
            }
            this.showStatus(`Downloaded ${files.length} protocols`, 'success');
        }
    }

    async getUserFiles() {
        // Get all user-edited files from Python memory only
        const files = [];
        
        // Get from Python memory
        if (this.config.pyodide) {
            try {
                const result = await this.config.pyodide.runPythonAsync(`
import sys
import json

files = {}
if hasattr(sys.modules['__main__'], '_user_edited_files'):
    user_files = sys.modules['__main__']._user_edited_files
    for path, code in user_files.items():
        if path.startswith('user/'):
            files[path] = code
json.dumps(list(files.keys()))
`);
                const pythonFiles = JSON.parse(result);
                for (const path of pythonFiles) {
                    // Get source info from config
                    const source = this.config.sources.find(s => s.path === path && s.isUserEdited);
                    files.push({
                        path: path,
                        name: path.split('/').pop(),
                        displayName: source?.displayName || path.split('/').pop().replace('.py', '')
                    });
                }
            } catch (e) {
                console.warn('Could not get files from Python memory:', e);
            }
        }
        
        // Sort by display name
        files.sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name));
        
        return files;
    }
    
    async deleteUserFile(filePath) {
        // Delete from Python memory
        if (this.config.pyodide) {
            try {
                await this.config.pyodide.runPythonAsync(`
import sys

if hasattr(sys.modules['__main__'], '_user_edited_files'):
    user_files = sys.modules['__main__']._user_edited_files
    if '${filePath}' in user_files:
        del user_files['${filePath}']
`);
            } catch (e) {
                console.warn('Could not delete from Python memory:', e);
            }
        }
        
        // Remove from sources config
        const sourceIndex = this.config.sources.findIndex(s => s.path === filePath);
        if (sourceIndex >= 0) {
            this.config.sources.splice(sourceIndex, 1);
        }
        
        // Remove from sequences
        if (this.sequences[filePath]) {
            delete this.sequences[filePath];
        }

        // Re-render tree
        this.renderTree();
        
        this.showStatus('File deleted', 'success');
    }
}

// Export for module systems and global window
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SequenceExplorer };
}
// Make available globally for script tag usage
if (typeof window !== 'undefined') {
    window.SequenceExplorer = SequenceExplorer;
}
