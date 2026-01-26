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
        
        this.paramsTarget.innerHTML = `
            <div id="seq-params-section">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                    <div>
                        <h3 class="section-title" style="margin: 0;">Protocol</h3>
                        <div id="seq-current-name" style="font-size: 0.7rem; color: var(--muted); margin-top: 0.25rem; cursor: help;" title=""></div>
                    </div>
                    <div style="display: flex; gap: 0.5rem; align-items: center;">
                        <button id="seq-edit-btn" class="btn">edit seq</button>
                        <button id="seq-execute-btn" class="btn primary">plot seq</button>
                    </div>
                </div>
                <div id="seq-error-display" style="display: none; margin-bottom: 0.75rem; padding: 0.5rem 0.75rem; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.5); border-radius: 4px; color: #ef4444; font-size: 0.8rem; word-break: break-word;"></div>
                <div id="seq-params-controls"></div>
            </div>
        `;

        // Bind events for the buttons in params section
        const executeBtn = this.paramsTarget.querySelector('#seq-execute-btn');
        if (executeBtn) {
            executeBtn.addEventListener('click', () => this.executeFunction());
        }
        const editBtn = this.paramsTarget.querySelector('#seq-edit-btn');
        if (editBtn) {
            editBtn.addEventListener('click', () => this.showCodeEditor());
        }
    }

    renderPlot(target) {
        this.plotTarget = typeof target === 'string' ? document.getElementById(target) : target;
        if (!this.plotTarget) throw new Error(`Plot target not found: ${target}`);
        
        this.plotTarget.innerHTML = `
            <div id="seq-plot-output" class="seq-plot-container">
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
            </div>
        `;

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
        const showConsoleHtml = `
            <label style="display: flex; align-items: center; cursor: pointer; font-size: 0.875rem; color: var(--text); margin-left: auto;">
                <input type="checkbox" id="seq-show-console-checkbox" style="margin-right: 0.5rem; cursor: pointer; width: 1rem; height: 1rem;">
                <span>show console</span>
            </label>
        `;
        
        this.container.innerHTML = `
            <div id="seq-plot-output" class="seq-plot-container">
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
                                <button id="seq-edit-btn" style="padding: 0.4rem 0.32rem; background: rgba(255, 255, 255, 0.1); color: var(--text, #ddd); border: 1px solid var(--border, #333); border-radius: 4px; cursor: pointer; font-size: 0.875rem; font-weight: 500;">edit seq</button>
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
                        <div id="seq-error-display" style="display: none; margin-bottom: 0.75rem; padding: 0.5rem 0.75rem; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.5); border-radius: 4px; color: #ef4444; font-size: 0.8rem; word-break: break-word;"></div>
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
            </div>
        `;
        
        // Execute button event listener
        const executeBtn = this.container.querySelector('#seq-execute-btn');
        if (executeBtn) {
            executeBtn.addEventListener('click', () => {
                this.executeFunction();
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
import matplotlib
import matplotlib.pyplot as plt
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
    versions['matplotlib'] = matplotlib.__version__
except:
    versions['matplotlib'] = 'unknown'

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
        
        // Load all sources in parallel for better performance
        const loadPromises = this.config.sources.map(async (source) => {
            try {
                console.log('Loading source:', source.name || source.type, source);
                await this.loadSource(source);
            } catch (error) {
                console.error(`Error loading source ${source.name || 'unknown'}:`, error);
                this.showStatus(`Error loading ${source.name || 'unknown'}: ${error.message}`, 'error');
            }
        });
        
        await Promise.all(loadPromises);
        
        this.renderTree();
        const totalFunctions = Object.values(this.sequences).reduce((sum, file) => sum + file.functions.length, 0);
        const fileCount = Object.keys(this.sequences).length;
        console.log(`Loaded ${totalFunctions} functions from ${fileCount} files`);
        if (totalFunctions > 0) {
            this.showStatus(`Loaded ${totalFunctions} functions from ${fileCount} files`, 'success');
        } else {
            this.showStatus('No sequences found. Check console for errors.', 'error');
        }
    }
    
    async loadSource(source) {
        // Install dependencies BEFORE loading the source
        // This ensures that configured sources can be loaded properly
        // Dependencies are only installed for sources that are actually in the config
        if (source.dependencies && source.dependencies.length > 0 && this.config.pyodide) {
            console.log(`Installing dependencies for source "${source.name}":`, source.dependencies);
            this.showStatus(`Installing dependencies for ${source.name}...`, 'info');
            await this.installDependencies(source.dependencies);
        }
        
        if (source.type === 'local_file' || source.type === 'built-in') {
            await this.loadLocalFile(source);
        } else if (source.type === 'github_raw') {
            await this.loadGitHubRaw(source);
        } else if (source.type === 'remote_file') {
            // Generic remote file from any URL (GitHub raw, gist, or any other URL)
            await this.loadRemoteFile(source);
        } else if (source.type === 'github_folder') {
            await this.loadGitHubFolder(source);
        } else if (source.type === 'pyodide_module') {
            // Dependencies are now installed above, so the module should load successfully
            await this.loadPyodideModule(source);
        } else if (source.type === 'custom') {
            await source.loader(this);
        } else {
            throw new Error(`Unknown source type: ${source.type}`);
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
                    // Use code from Python memory
                    await this.parseFile(source.name || source.path, fileCode, source);
                    return;
                }
            } catch (e) {
                console.warn('Could not load from Python memory, trying localStorage:', e);
            }
            
            // Fallback to localStorage
            const storageKey = `seq_user_edited_${source.path}`;
            const stored = localStorage.getItem(storageKey);
            if (stored) {
                try {
                    const data = JSON.parse(stored);
                    if (data.code) {
                        await this.parseFile(source.name || source.path, data.code, source);
                        return;
                    }
                } catch (e) {
                    console.warn('Could not parse stored code:', e);
                }
            }
        }
        
        // Regular file loading
        const response = await fetch(this.resolvePath(source.path));
        if (!response.ok) throw new Error(`Failed to fetch ${source.path}`);
        const code = await response.text();
        await this.parseFile(source.name || source.path, code, source);
    }
    
    async loadGitHubRaw(source) {
        console.log('Fetching GitHub raw file:', source.url);
        const response = await fetch(source.url);
        if (!response.ok) throw new Error(`Failed to fetch ${source.url}: ${response.status} ${response.statusText}`);
        const code = await response.text();
        const fileName = source.name || source.url.split('/').pop();
        console.log(`Parsing file ${fileName}, code length: ${code.length}`);
        await this.parseFile(fileName, code, source);
    }
    
    async loadRemoteFile(source) {
        // Generic remote file loader - works with any URL (GitHub raw, gist, pastebin, etc.)
        console.log('Fetching remote file:', source.url);
        
        // If it's a GitHub blob URL, convert it to raw URL
        let fetchUrl = source.url;
        if (source.url.includes('github.com') && source.url.includes('/blob/')) {
            // Convert GitHub blob URL to raw URL
            // https://github.com/user/repo/blob/branch/path/file.py -> https://raw.githubusercontent.com/user/repo/branch/path/file.py
            fetchUrl = source.url
                .replace('github.com', 'raw.githubusercontent.com')
                .replace('/blob/', '/');
            console.log('Converted GitHub blob URL to raw URL:', fetchUrl);
        }
        
        const response = await fetch(fetchUrl);
        if (!response.ok) {
            throw new Error(`Failed to fetch ${fetchUrl}: ${response.status} ${response.statusText}`);
        }
        
        let code = await response.text();
        let fileName = source.name || source.url.split('/').pop() || 'remote_file.py';
        
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
        
        console.log(`Parsing remote file ${fileName}, code length: ${code.length}`);
        await this.parseFile(fileName, code, source);
    }
    
    async loadGitHubFolder(source) {
        // Use GitHub API to list files in folder
        // Convert GitHub URL to API URL
        // https://github.com/user/repo/tree/branch/path -> https://api.github.com/repos/user/repo/contents/path?ref=branch
        let apiUrl = source.url.replace('https://github.com/', 'https://api.github.com/repos/');
        
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
        
        // Filter for Python files if specified
        const fileFilter = source.fileFilter || (file => file.name.endsWith('.py'));
        
        let loadedCount = 0;
        for (const file of files) {
            if (file.type === 'file' && fileFilter(file)) {
                try {
                    const fileResponse = await fetch(file.download_url);
                    if (fileResponse.ok) {
                        const code = await fileResponse.text();
                        // Store code first
                        if (!this.sequences[file.name]) {
                            this.sequences[file.name] = { functions: [], source: { ...source, filePath: file.path }, code: code };
                        } else {
                            this.sequences[file.name].code = code;
                            // Update source info but keep existing functions if any
                            this.sequences[file.name].source = { ...source, filePath: file.path };
                        }
                        // Parse functions from the code - await to ensure it completes
                        await this.parseFile(file.name, code, { ...source, filePath: file.path });
                        loadedCount++;
                    } else {
                        console.warn(`Failed to fetch ${file.name}: ${fileResponse.status} ${fileResponse.statusText}`);
                    }
                } catch (error) {
                    console.warn(`Failed to load ${file.name}:`, error);
                }
            }
        }
        console.log(`Loaded ${loadedCount} files from GitHub folder "${source.name}"`);
    }
    
    async loadPyodideModule(source) {
        if (!this.config.pyodide) {
            throw new Error('Pyodide not available for module loading');
        }
        
        const pyodide = this.config.pyodide;
        const modulePath = source.module;
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
                this.showStatus(`Error loading source "${source.name}": ${errorMsg}`, 'error');
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
                this.showStatus(`Error loading source "${source.name}": ${errorMsg}`, 'error');
                throw new Error(`Failed to load module ${modulePath}: ${errorMsg}`);
            }
            
            const fileName = source.name || modulePath;
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
            this.showStatus(`Error loading source "${source.name}": ${errorMsg}`, 'error');
            // Re-throw the error so it's properly handled by loadSequences()
            throw error;
        }
        
        this.renderTree();
    }
    
    async parseFile(fileName, code, source) {
        // Parse Python code to extract functions using SourceManager
        if (!this.config.pyodide) {
            // Fallback: simple regex parsing (less accurate)
            this.parseFileRegex(fileName, code, source);
            return;
        }
        
        try {
            await this.ensureSourceManager();
            const pyodide = this.config.pyodide;
            
            // Use SourceManager to parse functions (don't filter - store all functions)
            const result = await pyodide.runPythonAsync(`
import json
from seq_source_manager import SourceManager

manager = SourceManager()
functions = manager.parse_file_functions(${JSON.stringify(code)}, filter_seq_prefix=False)
json.dumps(functions)
`);
            
            const functions = JSON.parse(result);
            
            if (!this.sequences[fileName]) {
                this.sequences[fileName] = { functions: [], source: source, code: code };
            } else {
                // Clear existing functions and update code (for overwrite scenario)
                this.sequences[fileName].functions = [];
                this.sequences[fileName].code = code;
                this.sequences[fileName].source = source;
            }
            
            // Store all functions (filtering happens during rendering)
            for (const func of functions) {
                this.sequences[fileName].functions.push({
                    name: func.name,
                    doc: func.doc || '',
                    source: source
                });
            }
            
            console.log(`Parsed ${this.sequences[fileName].functions.length} functions from ${fileName}`);
        } catch (err) {
            console.warn(`SourceManager parsing failed for ${fileName}, using regex:`, err);
            this.parseFileRegex(fileName, code, source);
        }
    }
    
    parseFileRegex(fileName, code, source) {
        // Simple regex-based function extraction (fallback)
        const functionRegex = /^def\s+(\w+)\s*\([^)]*\)\s*:/gm;
        const matches = [...code.matchAll(functionRegex)];
        
        if (!this.sequences[fileName]) {
            this.sequences[fileName] = { functions: [], source: source, code: code };
        } else {
            // Clear existing functions and update code (for overwrite scenario)
            this.sequences[fileName].functions = [];
            this.sequences[fileName].code = code;
            this.sequences[fileName].source = source;
        }
        
        // Don't filter during parsing - store all functions, filter during rendering
        for (const match of matches) {
            const funcName = match[1];
            // Try to extract docstring
            const funcStart = match.index;
            const funcCode = code.substring(funcStart, funcStart + 500);
            const docMatch = funcCode.match(/"""(.*?)"""/s) || funcCode.match(/'''(.*?)'''/s);
            
            this.sequences[fileName].functions.push({
                name: funcName,
                doc: docMatch ? docMatch[1].trim() : '',
                source: source
            });
        }
        
        // Don't render tree here - it will be called after all sources are loaded
    }
    
    renderTree(target) {
        if (target) {
            this.treeTarget = typeof target === 'string' ? document.getElementById(target) : target;
        }
        const treeEl = this.treeTarget || this.container.querySelector('#seq-tree');
        if (!treeEl) return;
        
        console.log('Rendering tree. Filter enabled:', this.filterSeqPrefix, 'Total sequences:', Object.keys(this.sequences).length);
        
        let headingHtml = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; flex-wrap: wrap; gap: 0.5rem;">
                <h3 class="section-title" style="margin: 0;">Sequences</h3>
                <div style="display: flex; align-items: center; gap: 0.75rem;">
                    ${this.config.showFilter ? `
                    <label style="display: flex; align-items: center; gap: 0.4rem; font-size: 0.75rem; color: var(--muted); cursor: pointer; user-select: none;">
                        <input type="checkbox" id="seq-filter-checkbox" ${this.filterSeqPrefix ? 'checked' : ''} style="width: 0.8rem; height: 0.8rem; margin: 0; cursor: pointer;">
                        <span>Only seq_ or main</span>
                    </label>
                    ` : ''}
                    <button id="seq-add-sources-btn" class="btn primary" style="padding: 0.2rem 0.5rem; font-size: 0.7rem; height: auto;">
                        Add Sources
                    </button>
                </div>
            </div>
        `;

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
        // All user-edited files go under "User Refined"
        const sourceGroups = {};
        
        for (const [fileName, fileData] of Object.entries(this.sequences)) {
            // Group all user-edited files under "User Refined"
            let sourceName = fileData.source?.name || 'Unknown';
            if (fileData.source?.isUserEdited) {
                sourceName = 'User Refined';
            }
            
            if (!sourceGroups[sourceName]) {
                sourceGroups[sourceName] = [];
            }
            
            // Apply filter: if filter is enabled, only show seq_ or main functions
            const functions = fileData.functions.filter(f => {
                if (!this.filterSeqPrefix) {
                    return true;
                } else {
                    return f.name.startsWith('seq_') || f.name === 'main';
                }
            });
            
            if (functions.length > 0) {
                sourceGroups[sourceName].push({ fileName, functions, source: fileData.source });
            }
        }
        
        let html = '';
        let totalFunctions = 0;
        let displayedSources = 0;
        
        // Render each source group
        for (const [sourceName, files] of Object.entries(sourceGroups)) {
            if (files.length === 0) continue;
            
            displayedSources++;
            const sourceFunctionCount = files.reduce((sum, f) => sum + f.functions.length, 0);
            totalFunctions += sourceFunctionCount;
            
            // Get source info for header
            const firstFile = files[0];
            const source = firstFile.source;
            // Determine type/module info to display
            // For "User Refined" group, don't show type info
            let typeInfo = '';
            if (sourceName !== 'User Refined') {
                if (source?.type === 'pyodide_module' && source?.module) {
                    // For module sources: show module path
                    typeInfo = source.module;
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
                            // For user-edited files, use displayName if available
                            let displayFileName = fileName;
                            if (source?.isUserEdited && source?.displayName) {
                                displayFileName = source.displayName;
                            } else {
                                // Extract just the basename (filename without path or module prefix)
                                // Handle both file paths (with / or \) and module paths (with .)
                                let shortFileName = fileName;
                                
                                // Remove path separators first (including user/ prefix)
                                shortFileName = shortFileName.split('/').pop().split('\\').pop();
                                
                                // For module-based sources, remove module prefix (everything before last dot before .py)
                                // e.g., "mrseq.scripts.t1_inv_rec_gre_single_line.py" -> "t1_inv_rec_gre_single_line.py"
                                if (shortFileName.endsWith('.py')) {
                                    // Find the last dot before .py
                                    const pyIndex = shortFileName.length - 3; // index of 'p' in '.py'
                                    const lastDotBeforePy = shortFileName.lastIndexOf('.', pyIndex - 1);
                                    if (lastDotBeforePy > 0) {
                                        // Extract just the filename part (after last dot before .py)
                                        shortFileName = shortFileName.substring(lastDotBeforePy + 1);
                                    }
                                }
                                displayFileName = shortFileName;
                            }
                            
                            // Remove .py extension for display
                            if (displayFileName.endsWith('.py')) {
                                displayFileName = displayFileName.slice(0, -3);
                            }
                            
                            return functions.map(func => `
                                <div class="seq-function-item" data-file="${fileName}" data-function="${func.name}" ${func.doc ? `title="${func.doc.replace(/"/g, '&quot;')}"` : ''}>
                                    <span class="seq-file-function-name">${displayFileName}:${func.name}</span>
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
                
                this.selectedSequence = { fileName, functionName, ...func, source: fileData.source };
                
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
            
            // Install dependencies first if specified
            if (source.dependencies && source.dependencies.length > 0) {
                this.showStatus('Installing dependencies...', 'info');
                await this.installDependencies(source.dependencies);
            }
            
            // Extract parameters based on source type
            let paramsJson;
            
            if (source.type === 'local_file' || source.type === 'built-in' || source.type === 'github_raw' || source.type === 'remote_file' || source.type === 'github_folder') {
                // For file-based sources, get the code (use cached if available)
                const fileData = this.sequences[fileName];
                console.log('File data:', { fileName, hasFileData: !!fileData, hasCode: !!fileData?.code, sequencesKeys: Object.keys(this.sequences) });
                
                let code = fileData?.code;
                if (!code) {
                    if (source.type === 'local_file' || source.type === 'built-in') {
                        code = await (await fetch(this.resolvePath(source.path))).text();
                    } else if (source.type === 'github_raw' || source.type === 'remote_file') {
                        // For remote_file, convert GitHub blob URLs to raw if needed
                        let fetchUrl = source.url;
                        if (source.type === 'remote_file' && source.url.includes('github.com') && source.url.includes('/blob/')) {
                            fetchUrl = source.url
                                .replace('github.com', 'raw.githubusercontent.com')
                                .replace('/blob/', '/');
                        }
                        code = await (await fetch(fetchUrl)).text();
                    } else {
                        // github_folder - code should be cached from loadGitHubFolder
                        // Try to find it in sequences by checking all files
                        const allFiles = Object.keys(this.sequences);
                        console.warn(`Code not cached for ${fileName}. Available files:`, allFiles);
                        throw new Error(`Code not found for ${fileName}. File may not have been loaded from folder yet. Available files: ${allFiles.join(', ')}`);
                    }
                }
                
                // Use SourceManager to extract parameters
                await this.ensureSourceManager();
                paramsJson = await pyodide.runPythonAsync(`
import json
from seq_source_manager import SourceManager

manager = SourceManager()
params = manager.extract_function_parameters(
    module_path=None,
    function_name='${functionName}',
    code=${JSON.stringify(code)}
)
json.dumps(params)
`);
            } else if (source.type === 'pyodide_module') {
                // For module-based sources
                const modulePath = source.fullModulePath || source.module;
                await this.ensureSourceManager();
                paramsJson = await pyodide.runPythonAsync(`
import json
from seq_source_manager import SourceManager

manager = SourceManager()
params = manager.extract_function_parameters(
    module_path='${modulePath}',
    function_name='${functionName}',
    code=None
)
json.dumps(params)
`);
            } else {
                throw new Error(`Cannot extract parameters for source type: ${source.type}`);
            }
            
            const params = JSON.parse(paramsJson);
            this.functionParams = params;
            
            // Always fetch docstring BEFORE rendering controls, so tooltips can use it
            // For file sources, docstring should already be in the code/selectedSequence
            if (source.type === 'pyodide_module') {
                try {
                    const modulePath = source.fullModulePath || source.module;
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
            paramsControls.innerHTML = `<div style="padding: 1rem; text-align: center; color: #ef4444;">Error loading parameters: ${error.message}</div>`;
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
            pathToDisplay = source.module || source.fullModulePath || fileName;
        } else {
            // For files, use the file path (remove user/ prefix if present)
            pathToDisplay = fileName.replace(/^user\//, '');
        }
        
        // Remove .py extension if present
        if (pathToDisplay.endsWith('.py')) {
            pathToDisplay = pathToDisplay.slice(0, -3);
        }
        
        const displayName = `${origin} / ${pathToDisplay}:${functionName}`;
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
            noParamsDiv.style.cssText = 'padding: 1rem; text-align: center; color: var(--muted);';
            noParamsDiv.textContent = 'No parameters';
            paramsControls.appendChild(noParamsDiv);
            
            // Update sequence name display with docstring tooltip
            this.updateSequenceNameDisplay();
            return;
        }
        
        const table = document.createElement('table');
        table.style.width = '100%';
        table.style.borderCollapse = 'collapse';
        
        params.forEach(param => {
            const row = document.createElement('tr');
            row.style.borderBottom = '1px solid var(--border)';
            
            // Label cell
            const labelCell = document.createElement('td');
            labelCell.textContent = param.name;
            labelCell.style.padding = '0.4rem 0.5rem';
            labelCell.style.fontSize = '0.8rem';
            labelCell.style.fontWeight = '500';
            labelCell.style.color = 'var(--muted)';
            labelCell.style.width = '40%';
            row.appendChild(labelCell);
            
            // Input cell
            const inputCell = document.createElement('td');
            inputCell.style.padding = '0.4rem 0.5rem';
            inputCell.style.width = '50%';
            
            let input;
            if (param.type === 'bool') {
                const label = document.createElement('label');
                label.style.display = 'flex';
                label.style.alignItems = 'center';
                label.style.cursor = 'pointer';
                input = document.createElement('input');
                input.type = 'checkbox';
                input.checked = param.default === true;
                input.style.marginRight = '0.5rem';
                label.appendChild(input);
                inputCell.appendChild(label);
            } else {
                input = document.createElement('input');
                input.style.width = '100%';
                input.style.padding = '0.3rem 0.5rem';
                input.style.border = '1px solid var(--border)';
                input.style.borderRadius = '4px';
                input.style.background = 'rgba(255, 255, 255, 0.08)';
                input.style.color = 'var(--text)';
                input.style.fontSize = '0.8rem';
                
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
            
            input.id = `seq-param-${param.name}`;
            
            // Add tooltip with parameter description if available
            if (paramDocs[param.name]) {
                input.title = paramDocs[param.name];
                // Also add to the label for better UX
                labelCell.title = paramDocs[param.name];
            } else {
                // Add "No description available" if no docstring
                input.title = 'No description available';
                labelCell.title = 'No description available';
            }
            
            row.appendChild(inputCell);
            
            // Type tag cell
            const typeCell = document.createElement('td');
            typeCell.style.padding = '0.4rem 0.5rem';
            typeCell.style.width = '10%';
            typeCell.style.textAlign = 'right';
            const typeTag = document.createElement('span');
            typeTag.textContent = param.type;
            typeTag.style.fontSize = '0.7rem';
            typeTag.style.background = 'rgba(255, 255, 255, 0.08)';
            typeTag.style.color = 'var(--muted)';
            typeTag.style.padding = '0.1rem 0.3rem';
            typeTag.style.borderRadius = '4px';
            typeTag.style.border = '1px solid var(--border)';
            typeCell.appendChild(typeTag);
            row.appendChild(typeCell);
            
            table.appendChild(row);
        });
        
        paramsControls.appendChild(table);
        
        // Update sequence name display with docstring tooltip
        this.updateSequenceNameDisplay();
        
        // Edit button is now in the header, set up its event handler
        const editBtn = root.querySelector('#seq-edit-btn');
        if (editBtn) {
            editBtn.onclick = () => this.showCodeEditor();
            editBtn.onmouseover = () => {
                editBtn.style.background = 'rgba(255, 255, 255, 0.15)';
            };
            editBtn.onmouseout = () => {
                editBtn.style.background = 'rgba(255, 255, 255, 0.1)';
            };
        }
    }
    
    async executeFunction(silent = false) {
        if (!this.selectedSequence || !this.config.pyodide) {
            console.warn('No function selected or Pyodide not available');
            return;
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
                        } else if (param.type === 'list' || param.type === 'ndarray') {
                            valExpr = `np.array(${inputValue})`;
                        } else if (param.type === 'str') {
                            valExpr = `"${inputValue}"`;
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
            
            // Use SourceManager to execute the function
            await this.ensureSourceManager();
            
            let result;
            if (source.type === 'local_file' || source.type === 'built-in' || source.type === 'github_raw' || source.type === 'remote_file' || source.type === 'github_folder') {
                // Get the code (use cached if available)
                const fileData = this.sequences[fileName];
                let code = fileData?.code;
                if (!code) {
                    if (source.type === 'local_file' || source.type === 'built-in') {
                        code = await (await fetch(this.resolvePath(source.path))).text();
                    } else if (source.type === 'github_raw' || source.type === 'remote_file') {
                        let fetchUrl = source.url;
                        if (source.type === 'remote_file' && source.url.includes('github.com') && source.url.includes('/blob/')) {
                            fetchUrl = source.url
                                .replace('github.com', 'raw.githubusercontent.com')
                                .replace('/blob/', '/');
                        }
                        code = await (await fetch(fetchUrl)).text();
                    } else {
                        code = fileData?.code;
                    }
                }
                
                result = await pyodide.runPythonAsync(`
import json
import sys
import matplotlib.pyplot as plt
import __main__
import pypulseq as pp
from seq_source_manager import SourceManager

# Configure matplotlib
plt.close('all')
plt.ion()
${themeCode}

# Temporarily disable plotting during code execution to prevent hanging
# (user code may have seq.plot() in if __name__ == "__main__" blocks)
_orig_plot, _orig_show = pp.Sequence.plot, plt.show
pp.Sequence.plot = plt.show = lambda *args, **kwargs: None

try:
    # Execute the function
    manager = SourceManager()
    result = manager.execute_function(
        module_path=None,
        function_name='${functionName}',
        code=${JSON.stringify(code)},
        args_dict=${JSON.stringify(argsDict)}
    )
finally:
    # Restore plotting functions
    pp.Sequence.plot, plt.show = _orig_plot, _orig_show

# Get sequence from SourceManager._last_sequence (stored by execute_function)
seq = getattr(SourceManager, '_last_sequence', None)

# Ensure pypulseq is patched (SourceManager re-imports may have lost it)
if hasattr(sys, '_pp_patch_func'):
    sys._pp_patch_func()

# Plot if sequence found
if seq is not None:
    if not ${silent ? 'True' : 'False'}:
        plt.close('all')
        seq.plot(plot_now=False, plot_speed="${plotSpeed}")
        plt.show()
    else:
        print("Sequence generated (silent mode)")
else:
    print("No sequence found")

result
`);
            } else if (source.type === 'pyodide_module') {
                const modulePath = source.fullModulePath || source.module;
                result = await pyodide.runPythonAsync(`
import json
import sys
import matplotlib.pyplot as plt
import __main__
import pypulseq as pp
from seq_source_manager import SourceManager

# Configure matplotlib
plt.close('all')
plt.ion()
${themeCode}

# Temporarily disable plotting during code execution to prevent hanging
_orig_plot, _orig_show = pp.Sequence.plot, plt.show
pp.Sequence.plot = plt.show = lambda *args, **kwargs: None

try:
    # Execute the function
    manager = SourceManager()
    result = manager.execute_function(
        module_path='${modulePath}',
        function_name='${functionName}',
        code=None,
        args_dict=${JSON.stringify(argsDict)}
    )
finally:
    # Restore plotting functions
    pp.Sequence.plot, plt.show = _orig_plot, _orig_show

# Get sequence from SourceManager._last_sequence (stored by execute_function)
seq = getattr(SourceManager, '_last_sequence', None)

# Ensure pypulseq is patched (SourceManager re-imports may have lost it)
if hasattr(sys, '_pp_patch_func'):
    sys._pp_patch_func()

# Plot if sequence found
if seq is not None:
    if not ${silent ? 'True' : 'False'}:
        plt.close('all')
        seq.plot(plot_now=False, plot_speed="${plotSpeed}")
        plt.show()
    else:
        print("Sequence generated (silent mode)")
else:
    print("No sequence found")

result
`);
            } else {
                throw new Error(`Cannot execute function for source type: ${source.type}`);
            }
            
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
    
    async executeFunctionInPopup() {
        if (!this.selectedSequence || !this.config.pyodide) {
            console.warn('No function selected or Pyodide not available');
            return;
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
        closeBtn.textContent = 'Close';
        closeBtn.style.cssText = 'padding: 0.4rem 0.8rem; background: #555; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.875rem;';
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
                        } else if (param.type === 'list' || param.type === 'ndarray') {
                            valExpr = `np.array(${inputValue})`;
                        } else if (param.type === 'str') {
                            valExpr = `"${inputValue}"`;
                        } else {
                            valExpr = inputValue;
                        }
                    }
                    argsDict[param.name] = valExpr;
                });
            }
            
            // Get code
            const fileData = this.sequences[fileName];
            const code = fileData?.code;
            
            let result;
            if (source.type === 'local_file' || source.type === 'built-in' || source.type === 'github_raw' || source.type === 'remote_file' || source.type === 'github_folder') {
                result = await pyodide.runPythonAsync(`
import json
import sys
import matplotlib.pyplot as plt
import __main__
import pypulseq as pp
from seq_source_manager import SourceManager

print("PYTHON (popup): Execution starting...")
# Configure matplotlib
plt.close('all')
plt.ion()
${themeCode}

# Temporarily disable plotting during code execution to prevent hanging
_orig_plot, _orig_show = pp.Sequence.plot, plt.show
pp.Sequence.plot = plt.show = lambda *args, **kwargs: None

try:
    # Execute the function
    print(f"PYTHON (popup): Calling manager.execute_function for ${functionName}")
    manager = SourceManager()
    result = manager.execute_function(
        module_path=None,
        function_name='${functionName}',
        code=${JSON.stringify(code)},
        args_dict=${JSON.stringify(argsDict)}
    )
    print(f"PYTHON (popup): Result from execute_function: {result}")
finally:
    # Restore plotting functions
    pp.Sequence.plot, plt.show = _orig_plot, _orig_show

# Get sequence from SourceManager._last_sequence (stored by execute_function)
seq = getattr(SourceManager, '_last_sequence', None)
print(f"PYTHON (popup): Found sequence object: {seq is not None}")

# Ensure pypulseq is patched (SourceManager re-imports may have lost it)
if hasattr(sys, '_pp_patch_func'):
    print("PYTHON (popup): Re-applying patches...")
    sys._pp_patch_func()

# Plot if sequence found
if seq is not None:
    print(f"PYTHON (popup): Calling seq.plot(plot_speed='${plotSpeed}')")
    plt.close('all')
    seq.plot(plot_now=False, plot_speed="${plotSpeed}")
    print("PYTHON (popup): Plot command finished, calling plt.show()")
    plt.show()
    print("PYTHON (popup): plt.show() returned")
else:
    print("PYTHON ERROR (popup): No sequence found")

result
`);
            } else if (source.type === 'pyodide_module') {
                const modulePath = source.fullModulePath || source.module;
                result = await pyodide.runPythonAsync(`
import json
import sys
import matplotlib.pyplot as plt
import __main__
import pypulseq as pp
from seq_source_manager import SourceManager

# Configure matplotlib
plt.close('all')
plt.ion()
${themeCode}

# Temporarily disable plotting during code execution to prevent hanging
_orig_plot, _orig_show = pp.Sequence.plot, plt.show
pp.Sequence.plot = plt.show = lambda *args, **kwargs: None

try:
    # Execute the function
    manager = SourceManager()
    result = manager.execute_function(
        module_path='${modulePath}',
        function_name='${functionName}',
        code=None,
        args_dict=${JSON.stringify(argsDict)}
    )
finally:
    # Restore plotting functions
    pp.Sequence.plot, plt.show = _orig_plot, _orig_show

# Get sequence from SourceManager._last_sequence (stored by execute_function)
seq = getattr(SourceManager, '_last_sequence', None)

# Ensure pypulseq is patched (SourceManager re-imports may have lost it)
if hasattr(sys, '_pp_patch_func'):
    sys._pp_patch_func()

# Plot if sequence found
if seq is not None:
    if not ${silent ? 'True' : 'False'}:
        plt.close('all')
        seq.plot(plot_now=False, plot_speed="${plotSpeed}")
        plt.show()
    else:
        print("Sequence generated (silent mode)")
else:
    print("No sequence found")

result
`);
            } else {
                throw new Error(`Cannot execute function for source type: ${source.type}`);
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
                Define sources as a Python list. Each source should have: <code>name</code>, <code>type</code>, 
                <code>module</code> (for pyodide_module), <code>url</code> (for github), <code>path</code> (for built-in/local_file), 
                and <code>dependencies</code> array.
            </p>
        `;
        
        // Create CodeMirror editor if available, otherwise use textarea
        let editor;
        const editorContainer = document.createElement('div');
        editorContainer.style.cssText = 'flex: 1; min-height: 400px; max-height: 60vh; margin-bottom: 1rem; position: relative; overflow: hidden;';
        
        if (window.CodeMirror) {
            // Create a textarea first (CodeMirror.fromTextArea pattern like in index.html)
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
        saveBtn.textContent = 'Save & Reload';
        saveBtn.style.cssText = 'padding: 0.5rem 1rem; background: var(--accent, #4a9eff); color: white; border: none; border-radius: 4px; cursor: pointer;';
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
# Define sources as a list of dictionaries

sources = [
    {
        'name': 'RARE 2D (Playground)',
        'type': 'built-in',
        'path': 'built-in-seq/mr0_rare_2d_seq.py',
        'dependencies': ['pypulseq']
    }
]`;
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
# Define sources as a list of dictionaries

sources = [
    {
        'name': 'RARE 2D (Playground)',
        'type': 'built-in',
        'path': 'built-in-seq/mr0_rare_2d_seq.py',
        'dependencies': ['pypulseq']
    }
]`;
    }
    
    generateTOMLPreamble(fileName, source) {
        // Generate TOML preamble with dependencies
        const deps = source.dependencies || [];
        
        // Format dependencies for TOML
        const depsLines = deps.map(dep => {
            if (typeof dep === 'string') {
                // Handle version constraints: "numpy>=2.0.0" -> 'numpy = ">=2.0.0"'
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
name = "${fileName}"
type = "user"
description = "User adjusted file"
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
            // For module sources, get the full module source file
            if (source.type === 'pyodide_module' && this.config.pyodide) {
                try {
                    const modulePath = source.fullModulePath || source.module;
                    
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
    
    parseTOMLConfig(tomlString) {
        // Simple TOML parser for our specific format (or use a library)
        // For now, extract dependencies manually
        const deps = {};
        const metadata = {};
        
        const lines = tomlString.split('\n');
        let inDependencies = false;
        let inMetadata = false;
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === '[dependencies]') {
                inDependencies = true;
                inMetadata = false;
                continue;
            }
            if (trimmed === '[metadata]') {
                inDependencies = false;
                inMetadata = true;
                continue;
            }
            if (trimmed.startsWith('[') || trimmed === '') continue;
            
            const match = trimmed.match(/^(\w+)\s*=\s*"?(.*?)"?$/);
            if (match) {
                const key = match[1];
                const value = match[2].replace(/^"|"$/g, '');
                if (inDependencies) {
                    deps[key] = value;
                } else if (inMetadata) {
                    metadata[key] = value;
                }
            }
        }
        
        return { dependencies: deps, metadata };
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
            // Add TOML preamble if not present
            const preamble = this.generateTOMLPreamble(fileName, source);
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
        title.textContent = `Edit Sequence: ${fileName}:${functionName}`;
        header.appendChild(title);
        
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = 'display: flex; gap: 0.5rem;';
        
        const loadOriginalBtn = document.createElement('button');
        loadOriginalBtn.textContent = 'Load Original';
        loadOriginalBtn.style.cssText = 'padding: 0.4rem 0.8rem; background: rgba(255, 255, 255, 0.1); color: var(--text, #ddd); border: 1px solid var(--border, #333); border-radius: 4px; cursor: pointer; font-size: 0.875rem;';
        loadOriginalBtn.onclick = () => {
            if (editor) editor.setValue(fullCode);
        };
        
        const saveAsBtn = document.createElement('button');
        saveAsBtn.textContent = 'Save As...';
        saveAsBtn.style.cssText = 'padding: 0.4rem 0.8rem; background: var(--accent, #4a9eff); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.875rem; font-weight: 500;';
        
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = 'padding: 0.4rem 0.8rem; background: #555; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.875rem;';
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
        
        // Helper function to save sequence
        const saveSequence = async (targetFileName, targetName, overwrite = false) => {
            const code = editor.getValue();
            if (!code.trim()) {
                this.showStatus('Code cannot be empty', 'error');
                return false;
            }
            
            // Extract TOML config from code
            const tomlMatch = code.match(/_source_config_toml = """([\s\S]*?)"""/);
            if (!tomlMatch) {
                this.showStatus('TOML configuration not found in code', 'error');
                return false;
            }
            
            const tomlConfig = this.parseTOMLConfig(tomlMatch[1]);
            const metadata = tomlConfig.metadata;
            const deps = Object.keys(tomlConfig.dependencies).map(key => {
                const val = tomlConfig.dependencies[key];
                if (val === '*') return key;
                return `${key}${val}`;
            });
            
            // Use targetName as the display name and filename
            const displayName = targetName || metadata.name || `${fileName}_edited`;
            // Sanitize the name for use as filename
            const sanitizedName = sanitizeFileName(displayName);
            const baseFileName = sanitizedName.endsWith('.py') ? sanitizedName : `${sanitizedName}.py`;
            // Store user-edited files in user/ directory to avoid conflicts
            const finalFileName = `user/${baseFileName}`;
            
            // Update TOML metadata with the display name
            metadata.name = displayName;
            
            const newSource = {
                name: 'User Refined',  // All user-edited files grouped under "User Refined"
                type: 'local_file',
                path: finalFileName,
                description: metadata.description || 'User edited sequence',
                dependencies: deps,
                isUserEdited: true,
                displayName: displayName  // Store the original display name
            };
            
            if (this.config.pyodide) {
                try {
                    // Store code in Python memory
                    await this.config.pyodide.runPythonAsync(`
import sys

if not hasattr(sys.modules['__main__'], '_user_edited_files'):
    sys.modules['__main__']._user_edited_files = {}
sys.modules['__main__']._user_edited_files['${finalFileName}'] = ${JSON.stringify(code)}
`);
                    
                    // Store in localStorage
                    const storageKey = `seq_user_edited_${finalFileName}`;
                    localStorage.setItem(storageKey, JSON.stringify({
                        code: code,
                        source: newSource,
                        timestamp: new Date().toISOString()
                    }));
                    
                    // Update or add source in config
                    const sourceIndex = this.config.sources.findIndex(s => s.path === finalFileName);
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
                        this.selectedSequence = { 
                            fileName: finalFileName, 
                            functionName: func.name, 
                            ...func,
                            source: newSource
                        };
                        this.updateSequenceNameDisplay();
                        
                        // Notify other modules via eventHub
                        eventHub.emit('sequenceSelected', this.selectedSequence);
                        
                        await this.loadFunctionParameters(this.selectedSequence);
                    }
                    
                    this.renderTree();
                    this.showStatus('Sequence saved and registered!', 'success');
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
            // Extract current name from TOML or use fileName as default
            let defaultName = fileName;
            try {
                const code = editor.getValue();
                const tomlMatch = code.match(/_source_config_toml = """([\s\S]*?)"""/);
                if (tomlMatch) {
                    const tomlConfig = this.parseTOMLConfig(tomlMatch[1]);
                    if (tomlConfig.metadata.name) {
                        defaultName = tomlConfig.metadata.name;
                    }
                }
            } catch (e) {
                // Use fileName as fallback
            }
            
            // Remove .py extension and user/ prefix if present
            if (defaultName.endsWith('.py')) {
                defaultName = defaultName.slice(0, -3);
            }
            if (defaultName.startsWith('user/')) {
                defaultName = defaultName.slice(5);
            }
            
            // Get all existing user files
            const existingFiles = await this.getUserFiles();
            
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
            dialogTitle.textContent = 'Save As - User Files';
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
                    input.value = fileInfo.displayName || fileInfo.name;
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
            label.textContent = 'Sequence Name:';
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
            cancelDialogBtn.textContent = 'Cancel';
            cancelDialogBtn.style.cssText = 'padding: 0.4rem 0.8rem; background: #555; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.875rem;';
            cancelDialogBtn.onclick = () => dialog.remove();
            
            const confirmBtn = document.createElement('button');
            confirmBtn.textContent = 'Save';
            confirmBtn.style.cssText = 'padding: 0.4rem 0.8rem; background: var(--accent, #4a9eff); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.875rem; font-weight: 500;';
            
            confirmBtn.onclick = async () => {
                const newName = input.value.trim();
                if (!newName) {
                    alert('Please enter a name');
                    return;
                }
                
                // Check if file already exists
                const sanitizedName = sanitizeFileName(newName);
                const baseFileName = sanitizedName.endsWith('.py') ? sanitizedName : `${sanitizedName}.py`;
                const finalFileName = `user/${baseFileName}`;
                
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
        // Get all user-edited files from both Python memory and localStorage
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
        
        // Get from localStorage
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('seq_user_edited_user/')) {
                try {
                    const data = JSON.parse(localStorage.getItem(key));
                    if (data && data.source) {
                        const path = data.source.path;
                        if (!files.find(f => f.path === path)) {
                            files.push({
                                path: path,
                                name: path.split('/').pop(),
                                displayName: data.source.displayName || path.split('/').pop().replace('.py', '')
                            });
                        }
                    }
                } catch (e) {
                    console.warn('Could not parse localStorage item:', key, e);
                }
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
        
        // Delete from localStorage
        const storageKey = `seq_user_edited_${filePath}`;
        localStorage.removeItem(storageKey);
        
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
