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

/** HTML template builders for sequence explorer UI (single file, no extra modules). */
const SEQ_TEMPLATES = {
    showConsoleCheckbox() {
        return `<label style="display: flex; align-items: center; cursor: pointer; font-size: 0.875rem; color: var(--text); margin-left: auto;">
                <input type="checkbox" id="seq-show-console-checkbox" style="margin-right: 0.5rem; cursor: pointer; width: 1rem; height: 1rem;">
                <span>show console</span>
            </label>`;
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
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                            <div>
                            <h3 class="section-title" style="margin: 0;">Protocol</h3>
                                <div id="seq-current-name" style="font-size: 0.7rem; color: var(--muted); margin-top: 0.25rem; cursor: help;" title=""></div>
                            </div>
                            <div style="display: flex; gap: 0.5rem; align-items: center;">
                                <button id="seq-get-fov-btn" style="padding: 0.4rem 0.32rem; background: rgba(255, 255, 255, 0.08); color: var(--text, #ddd); border: 1px solid var(--border, #333); border-radius: 4px; cursor: pointer; font-size: 0.75rem; font-weight: 500;">↖ set FOV</button>
                                <button id="seq-edit-btn" style="padding: 0.4rem 0.32rem; background: rgba(255, 255, 255, 0.1); color: var(--text, #ddd); border: 1px solid var(--border, #333); border-radius: 4px; cursor: pointer; font-size: 0.875rem; font-weight: 500;">edit code</button>
                                <button id="seq-execute-btn" style="padding: 0.4rem 0.32rem; background: var(--accent); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.875rem; font-weight: 500;">plot seq</button>
                                <button id="seq-pop-btn" style="padding: 0.4rem 0.32rem; background: rgba(255, 255, 255, 0.1); color: var(--text, #ddd); border: 1px solid var(--border, #333); border-radius: 4px; cursor: pointer; font-size: 0.875rem; font-weight: 500;">pop seq</button>
                            </div>
                        </div>
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem; padding-top: 0.5rem; border-top: 1px solid var(--border);">
                            <label style="display: flex; align-items: center; cursor: pointer; font-size: 0.875rem; color: var(--text);">
                                <input type="checkbox" id="seq-dark-plot-checkbox" checked style="margin-right: 0.5rem; cursor: pointer; width: 1rem; height: 1rem;">
                                <span>Dark plot</span>
                            </label>
                            <select id="seq-plot-speed-selector" style="padding: 0.25rem; background: rgba(255, 255, 255, 0.08); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font-size: 0.75rem; cursor: pointer;">
                                <option value="full">Full plot</option>
                                <option value="fast">Fast plot</option>
                                <option value="faster" selected>Faster plot</option>
                            </select>
                        </div>
                        <div id="seq-error-display" class="seq-error-message" style="display: none;"></div>
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
    paramsSection() {
        return `<div id="seq-params-section">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                    <div>
                        <h3 class="section-title" style="margin: 0;">Protocol</h3>
                        <div id="seq-current-name" style="font-size: 0.7rem; color: var(--muted); margin-top: 0.25rem; cursor: help;" title=""></div>
                    </div>
                    <div style="display: flex; gap: 0.5rem; align-items: center;">
                    <button id="seq-get-fov-btn" class="btn btn-secondary btn-md">↖ set FOV</button>
                    <button id="seq-edit-btn" class="btn btn-secondary btn-md">edit code</button>
                    <button id="seq-execute-btn" class="btn btn-secondary btn-md">plot seq</button>
                    </div>
                </div>
                <div id="seq-error-display" class="seq-error-message" style="display: none;"></div>
                <div id="seq-params-controls"></div>
            </div>`;
    },
    plotSection() {
        return `<div id="seq-plot-output" class="seq-plot-container">
                <div id="seq-mpl-actual-target" class="mpl-figure-container">
                </div>
            </div>
            <div style="display: flex; align-items: center; justify-content: flex-end; margin-top: 0.5rem; padding: 0.5rem; background: rgba(0,0,0,0.2); border-radius: 4px;">
                <label style="display: flex; align-items: center; cursor: pointer; font-size: 0.875rem; color: var(--text); margin-right: 1rem;">
                    <input type="checkbox" id="seq-dark-plot-checkbox" checked style="margin-right: 0.5rem; cursor: pointer; width: 1rem; height: 1rem;">
                    <span>Dark plot</span>
                </label>
                <select id="seq-plot-speed-selector" style="padding: 0.25rem; background: rgba(255, 255, 255, 0.08); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font-size: 0.75rem; cursor: pointer;">
                    <option value="full">Full plot</option>
                    <option value="fast">Fast plot</option>
                    <option value="faster" selected>Faster plot</option>
                </select>
            </div>`;
    },
    treeHeading(showFilter, filterChecked) {
        const filterHtml = showFilter
            ? `<label style="display: flex; align-items: center; gap: 0.4rem; font-size: 0.75rem; color: var(--muted); cursor: pointer; user-select: none;">
                        <input type="checkbox" id="seq-filter-checkbox" ${filterChecked ? 'checked' : ''} style="width: 0.8rem; height: 0.8rem; margin: 0; cursor: pointer;">
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

export class SequenceExplorer {
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
        this._plotStackReady = null; // Promise: matplotlib + installOptimizedPlotFunction (set by bootstrap, non-blocking)
        
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
        const getFovBtn = this.paramsTarget.querySelector('#seq-get-fov-btn');
        if (getFovBtn) {
            getFovBtn.addEventListener('click', () => this.getFovFromSequence());
        }

    }

    renderPlot(target) {
        this.plotTarget = typeof target === 'string' ? document.getElementById(target) : target;
        if (!this.plotTarget) throw new Error(`Plot target not found: ${target}`);
        this.plotTarget.innerHTML = SEQ_TEMPLATES.plotSection();

        // Initialize plotting infrastructure for this target
        this.initPlottingInfrastructure();
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
        }
    }
    
    resolvePath(path) {
        // If it's a full URL or absolute path, return it as is
        if (path.includes('://') || path.startsWith('/')) {
            return path;
        }
        // Otherwise, prefix with basePath
        return this.config.basePath + path;
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
        
        const pyodide = this.config.pyodide;
        
        try {
            // Load and execute the standalone plot utils file
            const response = await fetch(this.resolvePath('seq_plot_utils.py?') + Date.now());
            const plotUtilsCode = await response.text();
            
            await pyodide.runPythonAsync(plotUtilsCode);
            await pyodide.runPythonAsync('patch_pypulseq()');
            
            console.log('Optimized seq_plot function installed successfully');
        } catch (error) {
            console.error('Error installing optimized plot function:', error);
            throw error;
        }
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
                errorDisplay.textContent = message;
                errorDisplay.style.display = 'block';
            } else if (type === 'success') {
                // Clear error display on success
                errorDisplay.style.display = 'none';
                errorDisplay.textContent = '';
            }
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
    
    async detectVersions() {
        if (!this.config.pyodide) {
            return;
        }
        
        const pyodide = this.config.pyodide;
        
        try {
            const pyodideVersion = pyodide.version || 'unknown';
            const versions = await pyodide.runPythonAsync(`
import json
import sys

versions = {}
versions['pyodide'] = ${JSON.stringify(pyodideVersion)}

try:
    import numpy
    versions['numpy'] = numpy.__version__
except:
    versions['numpy'] = 'unknown'

try:
    import matplotlib
    versions['matplotlib'] = matplotlib.__version__
except:
    versions['matplotlib'] = 'loading...'

try:
    import pypulseq
    versions['pypulseq'] = pypulseq.__version__
except:
    try:
        import pypulseq.version
        versions['pypulseq'] = pypulseq.version.__version__
    except:
        versions['pypulseq'] = 'unknown'

try:
    import mrseq
    # Try different ways to get mrseq version
    if hasattr(mrseq, '__version__'):
        versions['mrseq'] = mrseq.__version__
    elif hasattr(mrseq, 'version'):
        versions['mrseq'] = mrseq.version
    elif hasattr(mrseq, '__file__'):
        # Try to read version from package metadata
        import importlib.metadata
        try:
            versions['mrseq'] = importlib.metadata.version('mrseq')
        except:
            versions['mrseq'] = 'installed'
    else:
        versions['mrseq'] = 'installed'
except Exception as e:
    # If import fails, mrseq is not available
    versions['mrseq'] = 'not installed'

try:
    import ismrmrd
    versions['ismrmrd'] = ismrmrd.__version__
except:
    try:
        import importlib.metadata
        versions['ismrmrd'] = importlib.metadata.version('ismrmrd')
    except:
        versions['ismrmrd'] = 'unknown'

json.dumps(versions)
`);
            
            const versionData = JSON.parse(versions);
            const root = this.consoleTarget || this.container;
            const setVer = (id, val) => {
                const el = root ? root.querySelector(`#${id}`) : document.getElementById(id);
                if (el) el.textContent = val || 'unknown';
            };
            
            setVer('seq-pyodide-version', versionData.pyodide);
            setVer('seq-numpy-version', versionData.numpy);
            setVer('seq-matplotlib-version', versionData.matplotlib);
            setVer('seq-pypulseq-version', versionData.pypulseq);
            setVer('seq-mrseq-version', versionData.mrseq);
            setVer('seq-ismrmrd-version', versionData.ismrmrd);
        } catch (error) {
            console.warn('Failed to detect versions:', error);
        }
    }
    
    async loadSequences() {
        console.log('Loading sequences from', this.config.sources.length, 'sources...');
        this.showStatus('Loading sequences...', 'info');
        this.sequences = {};

        // Install all unique dependencies once before loading (simple batch; version conflicts possible across sources)
        if (this.config.pyodide) {
            const allDeps = [];
            for (const source of this.config.sources) {
                if (source.dependencies && source.dependencies.length > 0) {
                    for (const d of source.dependencies) allDeps.push(d);
                }
            }
            const seen = new Set();
            const uniqueDeps = allDeps.filter((d) => {
                const pkgName = typeof d === 'string' ? d.split(/[>=<!=]/)[0].trim() : (d.name || d);
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
        
        // Preload a built-in .seq file into the virtual filesystem for the Pulseq interpreter
        if (this.config.pyodide) {
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
            // Auto-select the first sequence on startup
            this.selectFirstSequence();
        } else {
            this.showStatus('No sequences found. Check console for errors.', 'error');
        }
    }

    /**
     * Preload a built-in single-slice Pulseq .seq file into the Pyodide virtual filesystem
     * and remember its path as the default for the seq_pulseq_interpreter.
     */
    async preloadBuiltinInterpreterSeq() {
        if (!this.config.pyodide) return;
        const pyodide = this.config.pyodide;
        if (!pyodide.FS) {
            console.warn('Pyodide FS not available to preload interpreter .seq file');
            return;
        }
        try {
            const url = this.resolvePath('built_in_seq/ute.seq') + '?t=' + Date.now();
            const response = await fetch(url);
            if (!response.ok) {
                console.warn('Failed to fetch built_in_seq/ute.seq for interpreter default:', response.status, response.statusText);
                return;
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
            const vfsPath = `${baseDir}/ute.seq`;
            pyodide.FS.writeFile(vfsPath, new Uint8Array(buffer), { encoding: 'binary' });
            this.defaultInterpreterSeqPath = vfsPath;
            console.log('Preloaded built-in interpreter .seq file at', vfsPath);
        } catch (e) {
            console.warn('Error preloading built-in interpreter .seq file:', e);
        }
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
        return source?.path ?? source?.seq_func_file ?? '';
    }

    /** @param {object} source - source object. Returns seq_func (call target). */
    getSourceBaseSequence(source) {
        return source?.seq_func ?? '';
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

    /**
     * Path to use for display name: for module sources, prefer fileName (full module path e.g. mrseq.scripts.radial_flash)
     * over source.path (package only e.g. mrseq.scripts) so we show "radial_flash" not "scripts".
     */
    getPathForDisplayName(fileName, source) {
        const base = source?.seq_func_file || source?.path || fileName || '';
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
    buildExecuteScript(options) {
        const { modulePath, functionName, argsDict, silent, themeCode, plotSpeed, debug = false } = options;
        const argsJson = JSON.stringify(argsDict);
        const execCall = `manager.execute_function(\n        module_path='${modulePath}',\n        function_name='${functionName}',\n        args_dict=${argsJson}\n    )`;
        const dbgStart = debug ? 'print("PYTHON (popup): Execution starting...")\n' : '';
        const dbgResult = debug ? '\n    print(f"PYTHON (popup): Result from execute_function: {result}")' : '';
        const dbgSeq = debug ? '\nprint(f"PYTHON (popup): Found sequence object: {seq is not None}")' : '';
        const dbgPatch = debug ? '\n    print("PYTHON (popup): Re-applying patches...")' : '';
        const plotBlock = debug
            ? `if seq is not None:\n    print(f"PYTHON (popup): Calling seq.plot(plot_speed='${plotSpeed}')")\n    plt.close('all')\n    seq.plot(plot_now=False, plot_speed="${plotSpeed}")\n    print("PYTHON (popup): Plot command finished, calling plt.show()")\n    plt.show()\n    print("PYTHON (popup): plt.show() returned")\nelse:\n    print("PYTHON ERROR (popup): No sequence found")`
            : `if seq is not None:\n    if not ${silent ? 'True' : 'False'}:\n        plt.close('all')\n        seq.plot(plot_now=False, plot_speed="${plotSpeed}")\n        plt.show()\n    else:\n        print("Sequence generated (silent mode)")\nelse:\n    print("No sequence found")`;

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

    selectFirstSequence() {
        // Find the first visible function item in the tree and select it
        const treeEl = this.treeTarget || (this.container ? this.container.querySelector('#seq-tree') : null);
        if (!treeEl) return;
        
        const firstItem = treeEl.querySelector('.seq-function-item');
        if (firstItem) {
            firstItem.click();
            console.log('Auto-selected first sequence:', firstItem.dataset.function);
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
        // Check if this is a user-edited file stored in Python memory
        if (source.isUserEdited && this.config.pyodide) {
            try {
                const code = await this.config.pyodide.runPythonAsync(`
import sys
import json

if hasattr(sys.modules['__main__'], '_user_edited_files'):
    files = sys.modules['__main__']._user_edited_files
    code = files.get('${source.path}', '')
    json.dumps(code)
else:
    json.dumps('')
`);
                const fileCode = JSON.parse(code);
                if (fileCode) {
                    const path = source.path || source.name;
                    let sourceWithModule = source;
                    if (path && (path.startsWith('user/seq/') || path.startsWith('user/prot/'))) {
                        const fullModulePath = path.replace(/\.py$/i, '').replace(/\//g, '.');
                        sourceWithModule = { ...source, fullModulePath };
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
        // Mirror built-in files into a package-like path for imports
        if (this.config.pyodide && source.path && source.path.startsWith('built_in_seq/')) {
            const fileBase = source.path.split('/').pop();
            await this.config.pyodide.runPythonAsync(`
import os
pkg_dir = '/built_in_seq'
if not os.path.exists(pkg_dir):
    os.makedirs(pkg_dir)
init_path = os.path.join(pkg_dir, '__init__.py')
if not os.path.exists(init_path):
    with open(init_path, 'w', encoding='utf-8') as f:
        f.write('')
with open(os.path.join(pkg_dir, '${fileBase}'), 'w', encoding='utf-8') as f:
    f.write(${JSON.stringify(code)})
`);
        }
        const path = source.path || source.name;
        let sourceToPass = source;
        if (path && (path.startsWith('built_in_seq/') || path.startsWith('user/seq/') || path.startsWith('user/prot/'))) {
            const fullModulePath = path.replace(/\.py$/i, '').replace(/\//g, '.');
            sourceToPass = { ...source, fullModulePath };
        }
        await this.parseFile(path, code, sourceToPass);
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
        
        const folderKey = (source.name || source.path || 'folder').replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/^_+|_+$/g, '') || 'folder';
        const modulePackageName = folderKey + '_examples';
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
        
        let loadedCount = 0;
        for (const file of files) {
            if (file.type === 'file' && fileFilter(file)) {
                try {
                    const fileResponse = await fetch(file.download_url);
                    if (fileResponse.ok) {
                        const code = await fileResponse.text();
                        if (this.config.pyodide) {
                            const vfsPath = `${moduleScriptsDir}/${file.name}`;
                            await this.config.pyodide.runPythonAsync(`
with open(${JSON.stringify(vfsPath)}, 'w', encoding='utf-8') as f:
    f.write(${JSON.stringify(code)})
`);
                        }
                        const fullModulePath = `${modulePackageName}.scripts.${file.name.replace(/\.py$/i, '')}`;
                        await this.parseFile(fullModulePath, code, { ...source, path: fullModulePath, filePath: file.path, fullModulePath });
                        loadedCount++;
                    } else {
                        console.warn(`Failed to fetch ${file.name}: ${fileResponse.status} ${fileResponse.statusText}`);
                    }
                } catch (error) {
                    console.warn(`Failed to load ${file.name}:`, error);
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
                // Load all modules in the package using SourceManager
                await this.ensureSourceManager();
                const result = await pyodide.runPythonAsync(`
import json
from seq_source_manager import SourceManager

manager = SourceManager()
all_functions = manager.get_functions_from_package('${modulePath}', filter_seq_prefix=False)
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
                    this.sequences[fileName] = { functions: [], source: { ...source, moduleName: moduleName, fullModulePath: fullModulePath } };
                }
                
                for (const func of functions) {
                    this.sequences[fileName].functions.push({
                        name: func.name,
                        doc: func.doc,
                        signature: func.signature,
                        source: { ...source, moduleName: moduleName, fullModulePath: fullModulePath }
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
        // For protocol files, enrich source with base sequence (seq_func_file, seq_func) from TOML
        // so that scanning the protocol again creates a new protocol that calls the same base (e.g. built-in)
        let sourceToStore = source;
        if (fileName.startsWith('user/prot/') && typeof code === 'string') {
            const tomlMatch = code.match(/_source_config_toml = """([\s\S]*?)"""/);
            if (tomlMatch) {
                try {
                    const tomlConfig = await this.parseTOMLConfig(tomlMatch[1]);
                    const meta = tomlConfig.metadata || {};
                    if (meta.kind === 'protocol' && (meta.seq_func_file || meta.seq_func)) {
                        sourceToStore = { ...source, seq_func_file: meta.seq_func_file || source?.seq_func_file, seq_func: meta.seq_func || source?.seq_func };
                    }
                } catch (e) {
                    // ignore TOML parse errors
                }
            }
        }
        if (!this.sequences[fileName]) {
            this.sequences[fileName] = { functions: [], source: sourceToStore, code: code };
        } else {
            this.sequences[fileName].functions = [];
            this.sequences[fileName].code = code;
            this.sequences[fileName].source = sourceToStore;
        }
        for (const func of functions) {
            this.sequences[fileName].functions.push({
                name: func.name,
                doc: func.doc || '',
                source: source
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
            const functions = fileData.functions.filter(f => {
                if (!this.filterSeqPrefix) {
                    return true;
                } else {
                    return f.name.startsWith('seq_') || f.name.startsWith('prot_') || f.name === 'main';
                }
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
                        <div style="display: flex; align-items: center; gap: 0.5rem; flex: 1;">
                            <span style="font-weight: 600;">${sourceName}</span>
                            ${typeInfo ? `<span style="font-size: 0.7rem; color: var(--muted); font-style: italic;">${typeInfo}</span>` : ''}
                        </div>
                    </div>
                    <div class="seq-source-items ${collapsedClass}" data-source="${sourceName}">
                        ${files.map(({ fileName, functions, source }) => {
                            const isProtocol = source?.itemKind === 'protocol' || (source?.path && source.path.startsWith('user/prot/'));
                            let displayFileName = fileName;
                            if (isProtocol) {
                                displayFileName = source?.displayName || this.getProtocolDisplayNameFromSeqFuncFile(this.getPathForDisplayName(fileName, source));
                                if (!displayFileName) {
                                    // Fallback: handle both path-style (user/prot/file.py) and module-style (user.prot.file) keys
                                    const pathOrModule = source?.path || fileName;
                                    if (pathOrModule.includes('.') && !pathOrModule.includes('/') && !pathOrModule.includes('\\')) {
                                        // Module path: strip .py then extract last segment (avoid "py" from extension)
                                        const withoutPy = pathOrModule.replace(/\.py$/i, '');
                                        displayFileName = withoutPy.split('.').pop();
                                    } else {
                                        // Path-style: extract filename
                                        displayFileName = pathOrModule.split('/').pop().replace(/\.py$/, '');
                                    }
                                }
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
                                // If key is a full module path (e.g. pypulseq_examples.scripts.foo), show only last segment (file:func)
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
                            return functions.map(func => `
                                <div class="seq-function-item" data-file="${fileName}" data-function="${func.name}" ${func.doc ? `title="${func.doc.replace(/"/g, '&quot;')}"` : ''}>
                                    <span class="seq-file-function-name">${isProtocol ? displayFileName : `${displayFileName}:${func.name}`}</span>
                                </div>
                            `).join('');
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
            header.addEventListener('click', () => {
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
        
        // Event listeners for function items (selection)
        treeEl.querySelectorAll('.seq-function-item').forEach(item => {
            item.addEventListener('click', () => {
                // Remove previous selection
                treeEl.querySelectorAll('.seq-function-item').forEach(i => i.classList.remove('selected'));
                
                // Add selection to clicked item
                item.classList.add('selected');
                
                const fileName = item.dataset.file;
                const functionName = item.dataset.function;
                const fileData = this.sequences[fileName];
                const func = fileData.functions.find(f => f.name === functionName);
                const src = fileData.source;
                const displayName = src?.displayName || this.getProtocolDisplayNameFromSeqFuncFile(this.getPathForDisplayName(fileName, src)) || (src?.path || fileName).split('/').pop().replace(/\.py$/, '');
                this.selectedSequence = { fileName, functionName, displayName, ...func, source: fileData.source };
                
                // Update sequence name display immediately
                this.updateSequenceNameDisplay();
                
                // Call callback if provided
                if (this.config.onSequenceSelect) {
                    this.config.onSequenceSelect(this.selectedSequence);
                }
                
                // Notify other modules via eventHub
                eventHub.emit('sequenceSelected', this.selectedSequence);
                
                // Load parameters for the selected function
                this.loadFunctionParameters(this.selectedSequence);
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
            if (source.dependencies && source.dependencies.length > 0) {
                const missing = source.dependencies.filter((pkg) => {
                    const pkgName = typeof pkg === 'string' ? pkg.split(/[>=<!=]/)[0].trim() : (pkg.name || pkg);
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
    
    updateSequenceNameDisplay() {
        const root = this.paramsTarget || this.container;
        const nameElement = root.querySelector('#seq-current-name');
        if (!nameElement) return;
        
        if (!this.selectedSequence) {
            nameElement.textContent = '';
            nameElement.title = '';
            return;
        }
        
        const { fileName, functionName, source } = this.selectedSequence;
        
        // Use source name from JSON configuration
        const origin = source?.name || 'unknown';
        
        // Determine path to display
        let pathToDisplay = fileName;
        if (source?.isUserEdited && source?.displayName) {
            // For user-edited files, use displayName
            pathToDisplay = source.displayName;
        } else if (source?.type === 'pyodide_module') {
            // For modules, use the module path
            pathToDisplay = source.module || source.fullModulePath || source.path || fileName;
        } else {
            // For files, use the file path (remove user/ prefix if present)
            pathToDisplay = fileName.replace(/^user\//, '');
        }
        
        if (pathToDisplay.endsWith('.py')) {
            pathToDisplay = pathToDisplay.slice(0, -3);
        }
        // If full module path (e.g. pypulseq_examples.scripts.foo), show only last segment
        if (pathToDisplay.includes('.') && !pathToDisplay.includes('/') && !pathToDisplay.includes('\\')) {
            pathToDisplay = pathToDisplay.split('.').pop();
        }
        const isProtocol = source?.itemKind === 'protocol' || (source?.path && source.path.startsWith('user/prot/'));
        if (isProtocol) {
            pathToDisplay = source?.displayName || this.getProtocolDisplayNameFromSeqFuncFile(this.getPathForDisplayName(fileName, source));
            if (!pathToDisplay) {
                // Fallback: handle both path-style (user/prot/file.py) and module-style (user.prot.file) keys
                const pathOrModule = source?.path || fileName;
                if (pathOrModule.includes('.') && !pathOrModule.includes('/') && !pathOrModule.includes('\\')) {
                    // Module path: strip .py then extract last segment (avoid "py" from extension)
                    const withoutPy = pathOrModule.replace(/\.py$/i, '');
                    pathToDisplay = withoutPy.split('.').pop();
                } else {
                    // Path-style: extract filename
                    pathToDisplay = pathOrModule.split('/').pop().replace(/\.py$/, '');
                }
            }
        }
        const displayName = isProtocol ? `${origin} / ${pathToDisplay}` : `${origin} / ${pathToDisplay}:${functionName}`;
        nameElement.textContent = displayName;
        
        // Get docstring for tooltip
        let docstring = this.selectedSequence?.doc || '';
        if (!docstring) {
            const fileData = this.sequences[fileName];
            if (fileData) {
                const func = fileData.functions.find(f => f.name === functionName);
                if (func && func.doc) {
                    docstring = func.doc;
                }
            }
        }
        
        // Set tooltip with docstring (or empty if none)
        nameElement.title = docstring || 'No docstring available';
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
            labelCell.textContent = param.name;
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
                    const fallbackPath = '/uploads/ute.seq';
                    input.value = this.defaultInterpreterSeqPath || fallbackPath;
                }
                wrapper.appendChild(input);
                if (param.type === 'file' && this.config.pyodide) {
                    const uploadBtn = document.createElement('button');
                    uploadBtn.type = 'button';
                    uploadBtn.className = "params-upload-btn";
                    uploadBtn.innerHTML = '<i class="bi bi-upload" aria-hidden="true"></i>';
                    uploadBtn.style.flexShrink = '0';
                    uploadBtn.style.padding = '0.25rem 0.5rem';
                    uploadBtn.style.fontSize = '0.75rem';
                    uploadBtn.style.cursor = 'pointer';
                    uploadBtn.title = 'Upload new .seq file.';
                    uploadBtn.addEventListener('click', () => {
                        const fileInput = document.createElement('input');
                        fileInput.type = 'file';
                        fileInput.accept = '.seq';
                        fileInput.style.display = 'none';
                        fileInput.onchange = async (e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            const pyodide = this.config.pyodide;
                            if (!pyodide?.FS) {
                                console.warn('Pyodide FS not available for upload');
                                return;
                            }
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
                            const reader = new FileReader();
                            reader.onload = (ev) => {
                                try {
                                    const buf = ev.target?.result;
                                    if (buf instanceof ArrayBuffer) {
                                        pyodide.FS.writeFile(vfsPath, new Uint8Array(buf), { encoding: 'binary' });
                                        input.value = vfsPath;
                                    }
                                } catch (writeErr) {
                                    console.error('Failed to write uploaded file to VFS:', writeErr);
                                }
                            };
                            reader.readAsArrayBuffer(file);
                            fileInput.remove();
                        };
                        document.body.appendChild(fileInput);
                        fileInput.click();
                    });
                    wrapper.appendChild(uploadBtn);
                }
                inputCell.appendChild(wrapper);
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
        
        // Edit button click handler (hover handled by CSS)
        const editBtn = root.querySelector('#seq-edit-btn');
        if (editBtn) {
            editBtn.onclick = () => this.showCodeEditor();
            // Remove any existing hover classes to use unified CSS hover
            editBtn.classList.remove('edit-btn-hover', 'edit-btn-normal');
        }
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
        if (protocolName) {
            await this.saveProtocolSnapshot(protocolName);
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
        const errorDisplay = paramsRoot.querySelector('#seq-error-display');
        if (errorDisplay) {
            errorDisplay.style.display = 'none';
            errorDisplay.textContent = '';
        }
        
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
            
            // Clear the container
            if (plotContainer) {
                plotContainer.innerHTML = '';
            }
            
            // Also remove any stray matplotlib figures from the document body
            document.querySelectorAll('div.ui-dialog, div[id^="matplotlib_"]').forEach(el => {
                if (!plotContainer?.contains(el) && !plotOutput?.contains(el)) {
                    el.remove();
                }
            });
            
            // Set matplotlib target
            if (plotContainer) {
                document.pyodideMplTarget = plotContainer;
                window.pyodideMplTarget = plotContainer;
            }
            
            // Get plot speed
            const plotSpeedSelector = plotRoot.querySelector('#seq-plot-speed-selector');
            const plotSpeed = plotSpeedSelector ? plotSpeedSelector.value : 'faster';
            
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
            if (source.dependencies && source.dependencies.length > 0) {
                this.showStatus('Installing dependencies...', 'info');
                await this.installDependencies(source.dependencies);
            }
            
            await this.ensureSourceManager();

            const sourceType = this.resolveSourceType(source);
            const useModulePath = source.fullModulePath || (sourceType === 'pyodide_module' ? (source.module || source.path) : null);
            if (!useModulePath) {
                throw new Error('Sequence has no module path; cannot execute.');
            }
            const modulePath = source.fullModulePath || source.module || source.path;
            const script = this.buildExecuteScript({ modulePath, functionName, argsDict, silent, themeCode, plotSpeed, debug: false });
            const result = await pyodide.runPythonAsync(script);

            // Parse result (SourceManager returns JSON string)
            const resultObj = JSON.parse(result);
            
            // Final sweep for any matplotlib figures that might have been created outside our container
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
            
            if (this.config.onFunctionExecute) {
                this.config.onFunctionExecute(this.selectedSequence, resultObj);
            }
            
            this.showStatus(resultObj.message || 'Function executed successfully', 'success');

            // If this was a scan-triggered silent execution, emit FOV dimensions to Niivue (seq -> Niivue only)
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
            // Extract the most useful error message from the stack trace
            let errorMsg = error.message || String(error);
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
        closeBtn.onclick = () => {
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
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
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
            const plotSpeedSelector = plotRoot ? plotRoot.querySelector('#seq-plot-speed-selector') : null;
            const plotSpeed = plotSpeedSelector?.value || 'faster';
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
            const script = this.buildExecuteScript({ modulePath, functionName, argsDict, silent, themeCode, plotSpeed, debug: true });
            const result = await pyodide.runPythonAsync(script);

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
        // Priority: 1) Current in-memory sources (most up-to-date), 2) sources_config.py file, 3) Default template
        let currentConfig = '';
        
        // First, try to convert current in-memory sources to Python (most current)
        if (this.config.sources.length > 0) {
            // Remove 'code' property from sources before serializing (code is stored separately)
            const sourcesWithoutCode = this.config.sources.map(source => {
                const { code, ...sourceWithoutCode } = source;
                return sourceWithoutCode;
            });
            const sourcesJson = JSON.stringify(sourcesWithoutCode, null, 2);
            currentConfig = `# Sources configuration for sequence explorer
# Define sources as a list of dictionaries

sources = ${sourcesJson.replace(/"([^"]+)":/g, "'$1':").replace(/true/g, 'True').replace(/false/g, 'False').replace(/null/g, 'None')}`;
            console.log('Loaded current in-memory sources into editor');
        } else {
            // If no sources in memory, try to load from file
            try {
                const response = await fetch(this.resolvePath('sources_config.py?') + Date.now()); // Add cache bust
                if (response.ok) {
                    currentConfig = await response.text();
                    console.log('Loaded sources_config.py from file');
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
                Define sources as a Python list. Each source should have: <code>type</code> ("file" | "folder" | "module"), <code>path</code>, optional <code>name</code> (tree label), <code>seq_func</code> (entry point), <code>dependencies</code>.
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
                 this.showStatus('Sources loaded successfully. Note: To persist, save sources_config.py manually.', 'success');
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
        
        await this.loadSequences();
        
        // Render the tree
        this.renderTree();
    }
    
    async getDefaultSourcesConfig() {
        // Try to load from sources_config.py file
        try {
            const response = await fetch(this.resolvePath('sources_config.py'));
            if (response.ok) {
                return await response.text();
            }
        } catch (e) {
            console.warn('Could not load sources_config.py:', e);
        }
        
        // Fallback template if file doesn't exist
        return `# Sources configuration for sequence explorer
# Each source: type ("file" | "folder" | "module"), path, optional name (tree label), seq_func (entry point), dependencies.

sources = [
    {
        'type': 'file',
        'name': 'Built-in',
        'path': 'built_in_seq/mr0_rare_2d_seq.py',
        'seq_func': 'seq_RARE_2D',
        'dependencies': ['pypulseq']
    }
]`;
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
            const func = source?.seq_func ?? functionName ?? 'main';
            return { seq_func_file: seqFuncFile, seq_func: func, type: 'module' };
        }
        const seqFuncFile = source?.seq_func_file ?? source?.path ?? fileName;
        const func = source?.seq_func ?? functionName ?? 'main';
        return { seq_func_file: seqFuncFile, seq_func: func, type: 'file' };
    }

    /**
     * Build the Python import statement for a sequence (used in protocol generation).
     * @param {{ seq_func_file: string, seq_func: string, type: string }} meta - from getSequenceMetadata
     * @returns {string} Python import statement
     */
    buildImportStatement(meta) {
        if (meta.type === 'module') {
            return `from ${meta.seq_func_file} import ${meta.seq_func}`;
        }
        const normPath = String(meta.seq_func_file).replace(/^\//, '');
        const slash = normPath.lastIndexOf('/');
        const importDir = slash >= 0 ? normPath.slice(0, slash) : '';
        const moduleName = (slash >= 0 ? normPath.slice(slash + 1) : normPath).replace(/\.py$/i, '');
        if (importDir === 'built_in_seq') {
            return `from built_in_seq.${moduleName} import ${meta.seq_func}`;
        }
        if (importDir) {
            return `import sys\nif '${importDir}' not in sys.path:\n    sys.path.insert(0, '${importDir}')\nfrom ${moduleName} import ${meta.seq_func}`;
        }
        return `from ${moduleName} import ${meta.seq_func}`;
    }

    /**
     * TOML preamble: only seq_func_file and seq_func (call target). No protocol file/name in TOML.
     * @param {object} [options] - Optional: { kind: 'sequence'|'protocol', seq_func_file: string, seq_func: string } for protocol call target
     */
    generateTOMLPreamble(fileName, source, functionName, options = {}) {
        const deps = source?.dependencies || [];
        const meta = this.getSequenceMetadata(fileName, source, functionName);
        const path = source?.path || '';
        const kind = options.kind ?? (path.startsWith('user/prot/') ? 'protocol' : 'sequence');
        const seqFuncFile = (kind === 'protocol' && options.seq_func_file != null) ? options.seq_func_file : meta.seq_func_file;
        const seqFunc = (kind === 'protocol' && options.seq_func != null) ? options.seq_func : meta.seq_func;

        const depsLines = deps.map(dep => {
            if (typeof dep === 'string') {
                if (dep.includes('>=') || dep.includes('==') || dep.includes('!=') || dep.includes('~=')) {
                    const parts = dep.match(/^([^>=!~]+)(.*)$/);
                    if (parts) {
                        return `    ${parts[1].trim()} = "${parts[2].trim()}"`;
                    }
                }
                return `    ${dep} = "*"`;
            } else if (typeof dep === 'object' && dep.name) {
                const version = dep.version || '*';
                return `    ${dep.name} = "${version}"`;
            }
            return `    ${dep} = "*"`;
        }).join('\n');

        return `# Source configuration (TOML format)
_source_config_toml = """
[dependencies]
${depsLines}

[metadata]
kind = "${kind}"
seq_func_file = "${seqFuncFile}"
seq_func = "${seqFunc}"
type = "${meta.type}"
"""

# Parse and use when needed:
# import tomli
# config = tomli.loads(_source_config_toml)
# deps = list(config['dependencies'].keys())

`;
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
    
    /**
     * Parse TOML preamble string via Python (tomllib/tomli). Requires Pyodide.
     * Expected TOML format: [dependencies] and [metadata] sections; metadata: kind, seq_func_file,
     * seq_func (call target), type; optional description (used for save and Save As default name).
     * @param {string} tomlString - Raw TOML string (e.g. from _source_config_toml in code)
     * @returns {Promise<{ dependencies: Object, metadata: Object }>}
     */
    async parseTOMLConfig(tomlString) {
        const pyodide = this.config?.pyodide;
        if (!pyodide) {
            throw new Error('Pyodide required to parse TOML');
        }
        // Pass TOML via globals to avoid embedding in code (backslashes/quotes would break json.loads)
        pyodide.globals.set('_toml_payload', tomlString);
        const result = await pyodide.runPythonAsync(`
from seq_source_manager import parse_toml_config
parse_toml_config(_toml_payload)
`);
        return JSON.parse(result);
    }

    async storeUserFile(path, code) {
        if (!this.config.pyodide) {
            throw new Error('Pyodide not available');
        }
        if (path.startsWith('user/seq/') || path.startsWith('user/prot/')) {
            await this.config.pyodide.runPythonAsync(`
import os
for d in ('user', 'user/seq', 'user/prot'):
    if not os.path.exists(d):
        os.makedirs(d)
    init_path = os.path.join(d, '__init__.py')
    if not os.path.exists(init_path):
        with open(init_path, 'w', encoding='utf-8') as f:
            f.write('')
`);
        }
        await this.config.pyodide.runPythonAsync(`
import sys
import os
if not hasattr(sys.modules['__main__'], '_user_edited_files'):
    sys.modules['__main__']._user_edited_files = {}
_code = ${JSON.stringify(code)}
sys.modules['__main__']._user_edited_files['${path}'] = _code
dir_path = os.path.dirname('${path}')
if dir_path and not os.path.exists(dir_path):
    os.makedirs(dir_path)
with open('${path}', 'w', encoding='utf-8') as f:
    f.write(_code)
`);
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

        // 2. Resolve call target (seq_func_file / seq_func = what we call; for protocols always the base)
        const { fileName, functionName: functionFromExplorer, source } = this.selectedSequence;
        const meta = this.getSequenceMetadata(fileName, source, functionFromExplorer);
        const isProtocol = source?.itemKind === 'protocol' || (source?.path && source.path.startsWith('user/prot/'));
        // For protocols, always use the base (source.seq_func_file / source.seq_func); otherwise meta can
        // point to the protocol itself (fullModulePath) and we'd generate invalid imports (e.g. from user.prot.1_prot_gre)
        const callTargetFile = isProtocol
            ? (source?.seq_func_file || meta.seq_func_file || source?.path || fileName)
            : (meta.seq_func_file || source?.seq_func_file || source?.path || fileName);
        const callTargetFunc = isProtocol
            ? (source?.seq_func || meta.seq_func || functionFromExplorer || 'main')
            : (meta.seq_func || source?.seq_func || functionFromExplorer || 'main');
        const callMeta = { seq_func_file: callTargetFile, seq_func: callTargetFunc, type: meta.type };
        const importStmt = this.buildImportStatement(callMeta);

        const paramStrs = Object.entries(params).map(([k, v]) => `${k}=${v}`);
        const signature = paramStrs.join(',\n    ');

        const shortName = callTargetFunc.startsWith('seq_')
            ? 'prot_' + callTargetFunc.slice(4)
            : (callTargetFunc.startsWith('prot_') ? callTargetFunc : 'prot_' + callTargetFunc);
        const filePrefix = (protocolName != null && protocolName !== true && String(protocolName).match(/^\d+$/))
            ? protocolName + '_'
            : '';
        const finalFileName = `user/prot/${filePrefix}${shortName}.py`;
        const safeFunctionName = shortName;

        const preamble = this.generateTOMLPreamble(fileName, source, functionFromExplorer, {
            kind: 'protocol',
            seq_func_file: callTargetFile,
            seq_func: callTargetFunc
        });
        const code = preamble + `
import numpy as np
import pypulseq as pp
${importStmt}

def ${safeFunctionName}(
    ${signature}
):
    kwargs = locals().copy()
    return ${callTargetFunc}(**kwargs)
`.trim();

        // 3. Save silently
        
        try {
            await this.storeUserFile(finalFileName, code);

            const protocolLabel = this.getProtocolDisplayNameFromSeqFuncFile(callTargetFile) || finalFileName.split('/').pop().replace(/\.py$/, '');
            const fullModulePath = finalFileName.replace(/\.py$/i, '').replace(/\//g, '.');
            const newSource = {
                name: 'User Protocols',
                itemKind: 'protocol',
                seq_func_file: callTargetFile,
                seq_func: callTargetFunc,
                type: 'file',
                path: finalFileName,
                fullModulePath: fullModulePath,
                description: 'Protocol Snapshot',
                isUserEdited: true,
                displayName: filePrefix ? filePrefix + protocolLabel : protocolLabel
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
        
        const { fileName, functionName } = this.selectedSequence;
        const source = this.selectedSequence.source;
        
        // Get FULL original code file (not just the function)
        const originalCode = await this.getOriginalCode(fileName, source);
        
        // Check if code already has TOML preamble (from previous edit)
        const hasTOML = originalCode.includes('_source_config_toml = """');
        
        let fullCode = originalCode;
        if (!hasTOML) {
            const preamble = this.generateTOMLPreamble(fileName, source, functionName);
            fullCode = preamble + originalCode;
        }
        
        // Create modal
        const modal = document.createElement('div');
        modal.className = 'seq-editor-modal';
        
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
        const seqFuncFile = source?.seq_func_file;
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
                const funcName = (underlyingSource?.seq_func ?? this.getSourceBaseSequence(underlyingSource)) || 'main';
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
        
        const saveAsBtn = document.createElement('button');
        saveAsBtn.className = 'btn btn-secondary btn-md';
        saveAsBtn.textContent = 'Save As...';
        
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn btn-secondary btn-md';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = () => modal.remove();
        
        buttonContainer.appendChild(loadOriginalBtn);
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
                matchBrackets: true
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
            
            // Extract TOML config from code (allow old minimal format)
            const tomlMatch = code.match(/_source_config_toml = """([\s\S]*?)"""/);
            if (!tomlMatch) {
                this.showStatus('TOML configuration not found in code', 'error');
                return false;
            }
            
            const tomlConfig = await this.parseTOMLConfig(tomlMatch[1]);
            const metadata = tomlConfig.metadata;
            const seqFunc = metadata.seq_func ?? functionName;
            const seqFuncFileFromMeta = metadata.seq_func_file ?? '';
            const deps = Object.keys(tomlConfig.dependencies).map(key => {
                const val = tomlConfig.dependencies[key];
                if (val === '*') return key;
                return `${key}${val}`;
            });

            const displayName = targetName || seqFuncFileFromMeta || metadata.name || `${fileName}_edited`;
            const sanitizedName = sanitizeFileName(displayName);
            if (/^\d+_/.test(sanitizedName)) {
                this.showReservedPrefixDialog();
                return false;
            }
            const baseFileName = sanitizedName.endsWith('.py') ? sanitizedName : `${sanitizedName}.py`;
            const userDir = savingProtocol ? 'user/prot' : 'user/seq';
            const finalFileName = `${userDir}/${baseFileName}`;

            const saveSource = { path: finalFileName, dependencies: deps };
            const preambleOptions = savingProtocol
                ? { kind: 'protocol', seq_func_file: seqFuncFileFromMeta || source?.seq_func_file, seq_func: metadata.seq_func ?? source?.seq_func }
                : { kind: 'sequence' };
            const preamble = this.generateTOMLPreamble(finalFileName, saveSource, seqFunc, preambleOptions);
            const tomlBlockRegex = /# Source configuration \(TOML format\)\n_source_config_toml = """[\s\S]*?"""\n\n(?:#.*\n)*\n*/;
            code = code.replace(tomlBlockRegex, preamble);

            const callTargetFile = savingProtocol ? (seqFuncFileFromMeta || source?.seq_func_file) : finalFileName;
            const callTargetFunc = savingProtocol ? (metadata.seq_func ?? source?.seq_func ?? seqFunc) : seqFunc;
            const fullModulePath = finalFileName.replace(/\.py$/i, '').replace(/\//g, '.');
            const newSource = {
                name: savingProtocol ? 'User Protocols' : 'User Refined Sequences',
                itemKind: savingProtocol ? 'protocol' : 'sequence',
                path: finalFileName,
                seq_func_file: callTargetFile,
                seq_func: callTargetFunc,
                type: 'file',
                fullModulePath,
                description: metadata.description || (savingProtocol ? 'User edited protocol' : 'User edited sequence'),
                dependencies: deps,
                isUserEdited: true,
                displayName: displayName
            };
            
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
                        const displayName = newSource?.displayName || this.getProtocolDisplayNameFromSeqFuncFile(this.getPathForDisplayName(finalFileName, newSource)) || (newSource?.path || finalFileName).split('/').pop().replace(/\.py$/, '');
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
            try {
                const code = editor.getValue();
                const tomlMatch = code.match(/_source_config_toml = """([\s\S]*?)"""/);
                if (tomlMatch) {
                    const tomlConfig = await this.parseTOMLConfig(tomlMatch[1]);
                    if (tomlConfig.metadata.seq_func_file) {
                        defaultName = tomlConfig.metadata.seq_func_file;
                    }
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
            defaultName = this.getProtocolDisplayNameFromSeqFuncFile(defaultName) || defaultName;

            const savingProtocolForDialog = source?.itemKind === 'protocol' || (source?.path && source.path.startsWith('user/prot/'));
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
        
        modal.onclick = (e) => {
            if (e.target === modal) modal.remove();
        };
        
        document.body.appendChild(modal);
        
        // Focus editor
        setTimeout(() => {
            if (editor.focus) editor.focus();
            if (editor.refresh) editor.refresh();
        }, 100);
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
