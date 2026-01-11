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

class SequenceExplorer {
    constructor(containerId, config = {}) {
        this.container = typeof containerId === 'string' 
            ? document.getElementById(containerId) 
            : containerId;
        
        if (!this.container) {
            throw new Error(`Container not found: ${containerId}`);
        }
        
        // Configuration
        this.config = {
            onlySeqPrefix: config.onlySeqPrefix !== undefined ? config.onlySeqPrefix : false,
            sources: config.sources || [],
            onSequenceSelect: config.onSequenceSelect || null,
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
        this.render();
        
        // Load sequences if sources are provided
        if (this.config.sources.length > 0) {
            this.loadSequences();
        }
    }
    
    render() {
        const filterHtml = this.config.showFilter ? `
            <label>
                <input type="checkbox" id="seq-filter-checkbox" ${this.filterSeqPrefix ? 'checked' : ''}>
                <span>Only seq_ or main fcts</span>
            </label>
        ` : '';
        
        const refreshHtml = this.config.showRefresh ? `
            <button id="seq-refresh-btn" style="padding: 0.4rem 0.8rem; background: var(--accent); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.875rem;">
                Refresh
            </button>
        ` : '';
        
        this.container.innerHTML = `
            <div class="seq-explorer-controls">
                ${filterHtml}
                ${refreshHtml}
            </div>
            <div id="seq-status" class="status-message" style="display: none;"></div>
            <div id="seq-tree" class="seq-explorer-tree"></div>
            <div id="seq-params-section" style="display: none; margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border);">
                <h3 style="font-size: 0.9rem; font-weight: 600; color: var(--accent); margin-bottom: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em;">Parameters</h3>
                <div id="seq-params-controls" style="max-height: 40vh; overflow-y: auto; margin-bottom: 1rem;"></div>
                <button id="seq-execute-btn" style="width: 100%; padding: 0.5rem; background: var(--accent); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.875rem; font-weight: 500;">Execute Function</button>
            </div>
        `;
        
        // Event listeners
        if (this.config.showFilter) {
            const checkbox = this.container.querySelector('#seq-filter-checkbox');
            if (checkbox) {
                checkbox.addEventListener('change', (e) => {
                    this.filterSeqPrefix = e.target.checked;
                    this.renderTree();
                });
            }
        }
        
        if (this.config.showRefresh) {
            const refreshBtn = this.container.querySelector('#seq-refresh-btn');
            if (refreshBtn) {
                refreshBtn.addEventListener('click', () => {
                    this.loadSequences();
                });
            }
        }
        
        // Execute button event listener
        const executeBtn = this.container.querySelector('#seq-execute-btn');
        if (executeBtn) {
            executeBtn.addEventListener('click', () => {
                this.executeFunction();
            });
        }
        
        // Store function parameters
        this.functionParams = [];
    }
    
    showStatus(message, type = 'info') {
        const statusEl = this.container.querySelector('#seq-status');
        if (!statusEl) return;
        
        statusEl.textContent = message;
        statusEl.className = `status-message ${type}`;
        statusEl.style.display = 'block';
        
        if (type === 'success' || type === 'error') {
            setTimeout(() => {
                statusEl.style.display = 'none';
            }, 3000);
        }
    }
    
    async loadSequences() {
        console.log('Loading sequences from', this.config.sources.length, 'sources...');
        this.showStatus('Loading sequences...', 'info');
        this.sequences = {};
        
        for (const source of this.config.sources) {
            try {
                console.log('Loading source:', source.name || source.type, source);
                await this.loadSource(source);
            } catch (error) {
                console.error(`Error loading source ${source.name || 'unknown'}:`, error);
                this.showStatus(`Error loading ${source.name || 'unknown'}: ${error.message}`, 'error');
            }
        }
        
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
        // Install dependencies if specified and Pyodide is available
        if (source.dependencies && this.config.pyodide) {
            await this.installDependencies(source.dependencies);
        }
        
        if (source.type === 'local_file') {
            await this.loadLocalFile(source);
        } else if (source.type === 'github_raw') {
            await this.loadGitHubRaw(source);
        } else if (source.type === 'github_folder') {
            await this.loadGitHubFolder(source);
        } else if (source.type === 'pyodide_module') {
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
        
        // Filter out already installed packages
        const toInstall = dependencies.filter(pkg => {
            const pkgName = typeof pkg === 'string' ? pkg.split(/[>=<!=]/)[0].trim() : (pkg.name || pkg);
            return !this.installedPackages.has(pkgName);
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
                
                if (this.installedPackages.has(pkgName)) {
                    continue;
                }
                
                try {
                    if (typeof pkg === 'object' && pkg.deps === false) {
                        // Install without dependencies
                        await pyodide.runPythonAsync(`
import micropip
await micropip.install('${pkgSpec}', deps=False)
`);
                    } else {
                        // Normal install
                        await micropip.install(pkgSpec);
                    }
                    
                    this.installedPackages.add(pkgName);
                    console.log(`✓ Installed ${pkgName}`);
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
        const response = await fetch(source.path);
        if (!response.ok) throw new Error(`Failed to fetch ${source.path}`);
        const code = await response.text();
        this.parseFile(source.name || source.path, code, source);
    }
    
    async loadGitHubRaw(source) {
        console.log('Fetching GitHub raw file:', source.url);
        const response = await fetch(source.url);
        if (!response.ok) throw new Error(`Failed to fetch ${source.url}: ${response.status} ${response.statusText}`);
        const code = await response.text();
        const fileName = source.name || source.url.split('/').pop();
        console.log(`Parsing file ${fileName}, code length: ${code.length}`);
        this.parseFile(fileName, code, source);
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
            apiUrl = apiUrl.replace('/blob/', '/contents/').split('/').slice(0, -1).join('/');
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
        
        for (const file of files) {
            if (file.type === 'file' && fileFilter(file)) {
                try {
                    const fileResponse = await fetch(file.download_url);
                    if (fileResponse.ok) {
                        const code = await fileResponse.text();
                        this.parseFile(file.name, code, { ...source, filePath: file.path });
                        // Store code for later use
                        if (!this.sequences[file.name]) {
                            this.sequences[file.name] = { functions: [], source: { ...source, filePath: file.path }, code: code };
                        } else {
                            this.sequences[file.name].code = code;
                        }
                    }
                } catch (error) {
                    console.warn(`Failed to load ${file.name}:`, error);
                }
            }
        }
    }
    
    async loadPyodideModule(source) {
        if (!this.config.pyodide) {
            throw new Error('Pyodide not available for module loading');
        }
        
        const pyodide = this.config.pyodide;
        const modulePath = source.module;
        const folderPath = source.folder || '';
        
        // Check if this is a package submodule (e.g., mrseq.tests.scripts)
        // If so, load all modules in that package
        const isPackageSubmodule = modulePath.includes('.') && !modulePath.endsWith('.py');
        
        if (isPackageSubmodule) {
            // Load all modules in the package
            const result = await pyodide.runPythonAsync(`
import inspect
import json
import importlib
import sys
import pkgutil
import os

def get_functions_from_package(package_path):
    """Extract functions from all modules in a package."""
    try:
        # Import the package
        package = importlib.import_module(package_path)
        package_path_obj = package.__path__ if hasattr(package, '__path__') else None
        
        all_functions = {}
        
        # Iterate through all modules in the package
        if package_path_obj:
            for importer, modname, ispkg in pkgutil.iter_modules(package_path_obj, package_path + '.'):
                if ispkg:
                    continue  # Skip subpackages
                try:
                    module = importlib.import_module(modname)
                    # Use the full module name (e.g., 'mrseq.scripts.t1_inv_rec_gre_single_line')
                    # but also get the basename for the file display name
                    module_basename = os.path.basename(modname)
                    
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
                    
                    if functions:
                        # Store with basename as key, but include full modname
                        all_functions[module_basename] = {
                            'functions': functions,
                            'full_module_path': modname
                        }
                except Exception as e:
                    print(f"Warning: Could not load module {modname}: {e}", file=sys.stderr)
                    continue
        else:
            # If it's not a package, try to import it as a module
            module = importlib.import_module(package_path)
            module_name = os.path.basename(package_path)
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
            if functions:
                all_functions[module_name] = functions
        
        return json.dumps(all_functions)
    except Exception as e:
        return json.dumps({'error': str(e)})

get_functions_from_package('${modulePath}')
`);
            
            const allFunctions = JSON.parse(result);
            if (allFunctions.error) {
                throw new Error(allFunctions.error);
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
                    if (!this.filterSeqPrefix || func.name.startsWith('seq_') || func.name === 'main') {
                        this.sequences[fileName].functions.push({
                            name: func.name,
                            doc: func.doc,
                            signature: func.signature,
                            source: { ...source, moduleName: moduleName, fullModulePath: fullModulePath }
                        });
                    }
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
                throw new Error(functions.error);
            }
            
            const fileName = source.name || modulePath;
            if (!this.sequences[fileName]) {
                this.sequences[fileName] = { functions: [], source: source };
            }
            
            for (const func of functions) {
                if (!this.filterSeqPrefix || func.name.startsWith('seq_')) {
                    this.sequences[fileName].functions.push({
                        name: func.name,
                        doc: func.doc,
                        signature: func.signature,
                        source: source
                    });
                }
            }
        }
        
        this.renderTree();
    }
    
    parseFile(fileName, code, source) {
        // Parse Python code to extract functions
        if (!this.config.pyodide) {
            // Fallback: simple regex parsing (less accurate)
            this.parseFileRegex(fileName, code, source);
            return;
        }
        
        // Use Pyodide to parse AST
        const pyodide = this.config.pyodide;
        pyodide.runPythonAsync(`
import ast
import json

code = ${JSON.stringify(code)}

try:
    tree = ast.parse(code)
    functions = []
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef):
            func_name = node.name
            func_doc = ast.get_docstring(node) or ''
            functions.append({
                'name': func_name,
                'doc': func_doc
            })
    result = json.dumps(functions)
except Exception as e:
    result = json.dumps({'error': str(e)})

result
`).then(result => {
            const functions = JSON.parse(result);
            if (functions.error) {
                console.warn(`Error parsing ${fileName}:`, functions.error);
                this.parseFileRegex(fileName, code, source);
                return;
            }
            
            if (!this.sequences[fileName]) {
                this.sequences[fileName] = { functions: [], source: source, code: code };
            } else {
                this.sequences[fileName].code = code;
            }
            
            for (const func of functions) {
                if (!this.filterSeqPrefix || func.name.startsWith('seq_')) {
                    this.sequences[fileName].functions.push({
                        name: func.name,
                        doc: func.doc,
                        source: source
                    });
                }
            }
            
            this.renderTree();
        }).catch(err => {
            console.warn(`Pyodide parsing failed for ${fileName}, using regex:`, err);
            this.parseFileRegex(fileName, code, source);
        });
    }
    
    parseFileRegex(fileName, code, source) {
        // Simple regex-based function extraction (fallback)
        const functionRegex = /^def\s+(\w+)\s*\([^)]*\)\s*:/gm;
        const matches = [...code.matchAll(functionRegex)];
        
            if (!this.sequences[fileName]) {
                this.sequences[fileName] = { functions: [], source: source, code: code };
            } else {
                this.sequences[fileName].code = code;
            }
            
            for (const match of matches) {
                const funcName = match[1];
                if (!this.filterSeqPrefix || funcName.startsWith('seq_') || funcName === 'main') {
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
            }
            
            this.renderTree();
    }
    
    renderTree() {
        const treeEl = this.container.querySelector('#seq-tree');
        if (!treeEl) return;
        
        if (Object.keys(this.sequences).length === 0) {
            treeEl.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--muted);">No sequences loaded</div>';
            return;
        }
        
        let html = '';
        for (const [fileName, fileData] of Object.entries(this.sequences)) {
            const functions = fileData.functions.filter(f => 
                !this.filterSeqPrefix || f.name.startsWith('seq_') || f.name === 'main'
            );
            
            if (functions.length === 0) continue;
            
            html += `
                <div class="seq-file-group">
                    <div class="seq-file-header" data-file="${fileName}">
                        <span>${fileName}</span>
                        <span style="font-size: 0.75rem; color: var(--muted);">${functions.length} function${functions.length !== 1 ? 's' : ''}</span>
                    </div>
                    <div class="seq-file-functions" data-file="${fileName}">
                        ${functions.map(func => `
                            <div class="seq-function-item" data-file="${fileName}" data-function="${func.name}">
                                <div class="seq-function-name">${func.name}</div>
                                ${func.doc ? `<div class="seq-function-doc">${func.doc.substring(0, 100)}${func.doc.length > 100 ? '...' : ''}</div>` : ''}
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        }
        
        treeEl.innerHTML = html;
        
        // Event listeners for file headers (collapse/expand)
        treeEl.querySelectorAll('.seq-file-header').forEach(header => {
            header.addEventListener('click', () => {
                const fileName = header.dataset.file;
                const functionsEl = treeEl.querySelector(`.seq-file-functions[data-file="${fileName}"]`);
                header.classList.toggle('collapsed');
                functionsEl.classList.toggle('collapsed');
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
                
                this.selectedSequence = { fileName, functionName, ...func };
                
                // Call callback if provided
                if (this.config.onSequenceSelect) {
                    this.config.onSequenceSelect(this.selectedSequence);
                }
                
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
        
        const paramsSection = this.container.querySelector('#seq-params-section');
        const paramsControls = this.container.querySelector('#seq-params-controls');
        const executeBtn = this.container.querySelector('#seq-execute-btn');
        
        if (!paramsSection || !paramsControls || !executeBtn) return;
        
        // Show loading state
        paramsControls.innerHTML = '<div style="padding: 1rem; text-align: center; color: var(--muted);">Loading parameters...</div>';
        paramsSection.style.display = 'block';
        executeBtn.disabled = true;
        
        try {
            const pyodide = this.config.pyodide;
            const { fileName, functionName, source } = sequence;
            
            console.log('Loading parameters for:', { fileName, functionName, sourceType: source.type, source });
            
            // Install dependencies first if specified
            if (source.dependencies && source.dependencies.length > 0) {
                this.showStatus('Installing dependencies...', 'info');
                await this.installDependencies(source.dependencies);
            }
            
            // Extract parameters based on source type
            let paramsJson;
            
            if (source.type === 'local_file' || source.type === 'github_raw' || source.type === 'github_folder') {
                // For file-based sources, get the code (use cached if available)
                const fileData = this.sequences[fileName];
                console.log('File data:', { fileName, hasFileData: !!fileData, hasCode: !!fileData?.code, sequencesKeys: Object.keys(this.sequences) });
                
                let code = fileData?.code;
                if (!code) {
                    if (source.type === 'local_file') {
                        code = await (await fetch(source.path)).text();
                    } else if (source.type === 'github_raw') {
                        code = await (await fetch(source.url)).text();
                    } else {
                        // github_folder - code should be cached from loadGitHubFolder
                        // Try to find it in sequences by checking all files
                        const allFiles = Object.keys(this.sequences);
                        console.warn(`Code not cached for ${fileName}. Available files:`, allFiles);
                        throw new Error(`Code not found for ${fileName}. File may not have been loaded from folder yet. Available files: ${allFiles.join(', ')}`);
                    }
                }
                
                paramsJson = await pyodide.runPythonAsync(`
import inspect
import json
import numpy as np
import __main__
import sys
import ast
from types import ModuleType

# Mock missing modules to prevent import errors during parameter extraction
try:
    import pypulseq
except ImportError:
    pp_mock = ModuleType('pypulseq')
    sys.modules['pypulseq'] = pp_mock

try:
    import mrseq
except ImportError:
    mrseq_mock = ModuleType('mrseq')
    sys.modules['mrseq'] = mrseq_mock

try:
    import ismrmrd
except ImportError:
    ismrmrd_mock = ModuleType('ismrmrd')
    sys.modules['ismrmrd'] = ismrmrd_mock

code = ${JSON.stringify(code)}

# Try to extract function signature directly from AST first (doesn't require execution)
func_found = False
params = []

try:
    tree = ast.parse(code)
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == '${functionName}':
            # Found the function in AST, extract signature
            sig_params = []
            num_args = len(node.args.args)
            num_defaults = len(node.args.defaults)
            default_start_idx = num_args - num_defaults
            
            for arg_index, arg in enumerate(node.args.args):
                param_name = arg.arg
                if param_name == 'system':
                    continue
                # Try to get default value
                val = None
                if arg_index >= default_start_idx:
                    default_val = node.args.defaults[arg_index - default_start_idx]
                    # Try to evaluate default value
                    try:
                        # Use ast.literal_eval for simple literals
                        val = ast.literal_eval(default_val)
                    except:
                        # For complex expressions, try to get a string representation
                        # For complex expressions, we can't easily evaluate them
                        # Just set to None and let the user provide a value
                        val = None
                
                type_name = type(val).__name__ if val is not None else 'None'
                if isinstance(val, (list, tuple)):
                    type_name = 'list'
                elif isinstance(val, str) and val.startswith('['):
                    type_name = 'list'
                sig_params.append({'name': param_name, 'default': val, 'type': type_name})
            
            params = sig_params
            func_found = True
            break
except Exception as e:
    # AST parsing failed, try execution method
    import traceback
    print(f"AST parsing failed: {e}", file=sys.stderr)
    traceback.print_exc()

# If AST method didn't work, try execution method
if not func_found:
    try:
        # Create a clean namespace for execution
        exec_globals = {'__name__': '__main__', '__builtins__': __builtins__}
        exec_globals.update(__main__.__dict__)
        
        # Execute the code
        try:
            exec(code, exec_globals)
        except Exception as exec_err:
            # If execution fails, try to continue - function might still be defined
            print(f"Warning during code execution: {exec_err}", file=sys.stderr)
        
        # Get the function from the execution namespace
        func = exec_globals.get('${functionName}', None)
        
        # Also check __main__ in case it was set there
        if func is None:
            func = getattr(__main__, '${functionName}', None)
        
        # If still not found, try executing in __main__ directly
        if func is None:
            try:
                # Set __name__ to trigger if __name__ == '__main__' blocks
                __main__.__name__ = '__main__'
                exec(code, __main__.__dict__)
                func = getattr(__main__, '${functionName}', None)
            except Exception as e2:
                print(f"Warning during second execution attempt: {e2}", file=sys.stderr)
        
        if func is None:
            # Last resort: search all defined functions in the namespace
            all_funcs = {k: v for k, v in exec_globals.items() if inspect.isfunction(v)}
            if '${functionName}' in all_funcs:
                func = all_funcs['${functionName}']
            else:
                # List available functions for debugging
                available = [k for k in all_funcs.keys() if not k.startswith('_')]
                raise AttributeError(f"Function '${functionName}' not found in code. Available functions: {available}")
        
        # Extract parameters using inspect
        sig = inspect.signature(func)
        for name, p in sig.parameters.items():
            if name == 'system': continue
            d = p.default
            val = d
            type_name = type(d).__name__
            if isinstance(d, np.ndarray):
                val = d.tolist()
                type_name = 'ndarray'
            elif isinstance(d, (tuple, list)):
                val = list(d)
                type_name = 'list'
            elif d is inspect._empty:
                val = None
                type_name = 'None'
            params.append({'name': name, 'default': val, 'type': type_name})
    except Exception as e:
        raise AttributeError(f"Could not extract parameters for '${functionName}': {e}")

json.dumps(params)
`);
            } else if (source.type === 'pyodide_module') {
                // For module-based sources
                const modulePath = source.fullModulePath || source.module;
                paramsJson = await pyodide.runPythonAsync(`
import inspect
import json
import numpy as np
import importlib
import sys
from types import ModuleType

# Mock missing modules if needed (only if not installed)
try:
    import pypulseq
except ImportError:
    pp_mock = ModuleType('pypulseq')
    sys.modules['pypulseq'] = pp_mock

try:
    import mrseq
except ImportError:
    mrseq_mock = ModuleType('mrseq')
    sys.modules['mrseq'] = mrseq_mock

# Import the module
if '${source.folder || ''}':
    sys.path.insert(0, '${source.folder || ''}')
try:
    module = importlib.import_module('${modulePath}')
except ImportError as e:
    raise ImportError(f"Failed to import module '${modulePath}': {e}. Make sure dependencies are installed.")

func = getattr(module, '${functionName}', None)
if func is None:
    raise AttributeError("Function '${functionName}' not found in module '${modulePath}'")

# Extract parameters
sig = inspect.signature(func)
params = []
for name, p in sig.parameters.items():
    if name == 'system': continue
    d = p.default
    val = d
    type_name = type(d).__name__
    if isinstance(d, np.ndarray):
        val = d.tolist()
        type_name = 'ndarray'
    elif isinstance(d, (tuple, list)):
        val = list(d)
        type_name = 'list'
    elif d is inspect._empty:
        val = None
        type_name = 'None'
    params.append({'name': name, 'default': val, 'type': type_name})

json.dumps(params)
`);
            } else {
                throw new Error(`Cannot extract parameters for source type: ${source.type}`);
            }
            
            const params = JSON.parse(paramsJson);
            this.functionParams = params;
            this.renderParameterControls(params);
            executeBtn.disabled = false;
            
        } catch (error) {
            console.error('Error loading function parameters:', error);
            paramsControls.innerHTML = `<div style="padding: 1rem; text-align: center; color: #ef4444;">Error loading parameters: ${error.message}</div>`;
            executeBtn.disabled = true;
        }
    }
    
    renderParameterControls(params) {
        const paramsControls = this.container.querySelector('#seq-params-controls');
        if (!paramsControls) return;
        
        if (params.length === 0) {
            paramsControls.innerHTML = '<div style="padding: 1rem; text-align: center; color: var(--muted);">No parameters</div>';
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
        
        paramsControls.innerHTML = '';
        paramsControls.appendChild(table);
    }
    
    async executeFunction() {
        if (!this.selectedSequence || !this.config.pyodide) {
            console.warn('No function selected or Pyodide not available');
            return;
        }
        
        const executeBtn = this.container.querySelector('#seq-execute-btn');
        if (!executeBtn) return;
        
        executeBtn.disabled = true;
        executeBtn.textContent = 'Executing...';
        
        try {
            const pyodide = this.config.pyodide;
            const { fileName, functionName, source } = this.selectedSequence;
            
            // Build arguments from parameter inputs
            const pyArgs = [];
            if (this.functionParams) {
                this.functionParams.forEach(param => {
                    const input = this.container.querySelector(`#seq-param-${param.name}`);
                    if (!input) return;
                    
                    let val;
                    if (param.type === 'bool') {
                        val = input.checked ? 'True' : 'False';
                        pyArgs.push(`${param.name}=${val}`);
                    } else {
                        const inputValue = input.value.trim();
                        if (inputValue === '') {
                            return; // Skip empty values, use default
                        }
                        
                        if (param.type === 'int' || param.type === 'float') {
                            val = inputValue;
                        } else if (param.type === 'list' || param.type === 'ndarray') {
                            val = `np.array(${inputValue})`;
                        } else if (param.type === 'str') {
                            val = `"${inputValue}"`;
                        } else {
                            val = inputValue;
                        }
                        pyArgs.push(`${param.name}=${val}`);
                    }
                });
            }
            
            // Install dependencies first if specified
            if (source.dependencies && source.dependencies.length > 0) {
                this.showStatus('Installing dependencies...', 'info');
                await this.installDependencies(source.dependencies);
            }
            
            // Execute the function
            let pythonCode;
            if (source.type === 'local_file' || source.type === 'github_raw' || source.type === 'github_folder') {
                // Get the code (use cached if available)
                const fileData = this.sequences[fileName];
                let code = fileData?.code;
                if (!code) {
                    code = source.type === 'local_file' 
                        ? await (await fetch(source.path)).text()
                        : await (await fetch(source.url)).text();
                }
                
                pythonCode = `
import __main__
import numpy as np
import sys
import importlib

# Remove any mock modules that might interfere with real imports
# Mocks are simple ModuleType objects without proper attributes
# Real modules have submodules and proper structure
for module_name in ['pypulseq', 'mrseq', 'ismrmrd']:
    if module_name in sys.modules:
        mod = sys.modules[module_name]
        # Check if it's a mock (simple ModuleType without __file__ or proper structure)
        is_mock = (
            hasattr(mod, '__class__') and 
            mod.__class__.__name__ == 'ModuleType' and
            not hasattr(mod, '__file__') and
            len(dir(mod)) < 10  # Mocks have very few attributes
        )
        if is_mock:
            del sys.modules[module_name]
            # Also remove any submodules
            keys_to_remove = [k for k in list(sys.modules.keys()) if k.startswith(module_name + '.')]
            for k in keys_to_remove:
                del sys.modules[k]

# Force reimport of packages to ensure real modules are loaded
# This is important because mocks might have been created during parameter extraction
try:
    if 'pypulseq' not in sys.modules or not hasattr(sys.modules.get('pypulseq', None), 'opts'):
        # Remove if exists and reimport
        if 'pypulseq' in sys.modules:
            del sys.modules['pypulseq']
        # Remove all pypulseq submodules
        for key in list(sys.modules.keys()):
            if key.startswith('pypulseq.'):
                del sys.modules[key]
        # Try to import the real pypulseq
        try:
            import pypulseq
            # Verify it's the real one by checking for opts
            if not hasattr(pypulseq, 'opts'):
                raise ImportError("pypulseq is not properly installed")
        except ImportError:
            print("Warning: pypulseq not available", file=sys.stderr)
except Exception as e:
    print(f"Warning during pypulseq import: {e}", file=sys.stderr)

# Execute the code to make the function available
code = ${JSON.stringify(code)}
try:
    # Set __name__ to trigger if __name__ == '__main__' blocks
    __main__.__name__ = '__main__'
    exec(code, __main__.__dict__)
except Exception as e:
    raise RuntimeError(f"Failed to execute code: {e}")

# Call the function
result = __main__.${functionName}(${pyArgs.join(', ')})
print(f"Function executed successfully. Result type: {type(result).__name__}")
"SUCCESS"
`;
            } else if (source.type === 'pyodide_module') {
                const modulePath = source.fullModulePath || source.module;
                pythonCode = `
import importlib
import sys
import numpy as np

# Remove any mock modules
for module_name in ['pypulseq', 'mrseq', 'ismrmrd']:
    if module_name in sys.modules:
        mod = sys.modules[module_name]
        is_mock = (
            hasattr(mod, '__class__') and 
            mod.__class__.__name__ == 'ModuleType' and
            not hasattr(mod, '__file__') and
            len(dir(mod)) < 10
        )
        if is_mock:
            del sys.modules[module_name]
            keys_to_remove = [k for k in list(sys.modules.keys()) if k.startswith(module_name + '.')]
            for k in keys_to_remove:
                del sys.modules[k]

# Import the module
if '${source.folder || ''}':
    sys.path.insert(0, '${source.folder || ''}')
try:
    module = importlib.import_module('${modulePath}')
except ImportError as e:
    raise ImportError(f"Failed to import module '${modulePath}': {e}. Make sure dependencies are installed.")

func = getattr(module, '${functionName}', None)
if func is None:
    raise AttributeError("Function '${functionName}' not found in module '${modulePath}'")

# Call the function
result = func(${pyArgs.join(', ')})
print(f"Function executed successfully. Result type: {type(result).__name__}")
"SUCCESS"
`;
            } else {
                throw new Error(`Cannot execute function for source type: ${source.type}`);
            }
            
            const result = await pyodide.runPythonAsync(pythonCode);
            
            if (this.config.onFunctionExecute) {
                this.config.onFunctionExecute(this.selectedSequence, result);
            }
            
            this.showStatus('Function executed successfully', 'success');
            
        } catch (error) {
            console.error('Error executing function:', error);
            this.showStatus(`Error: ${error.message}`, 'error');
        } finally {
            executeBtn.disabled = false;
            executeBtn.textContent = 'Execute Function';
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
        this.renderTree();
    }
}

// Predefined load scripts
const LoadScripts = {
    mrseq: {
        name: 'mrseq',
        type: 'pyodide_module',
        module: 'mrseq.scripts',
        description: 'Load sequences from installed mrseq package (mrseq.scripts)',
        dependencies: ['numpy>=2.0.0', 'pypulseq', { name: 'mrseq', deps: false }, 'ismrmrd']
    },
    pypulseq_examples: {
        name: 'pypulseq_examples',
        type: 'github_folder',
        url: 'https://github.com/imr-framework/pypulseq/tree/master/examples/scripts',
        description: 'Load examples from pypulseq repository',
        dependencies: ['pypulseq']
    },
    local_file: (path, name, dependencies = []) => ({
        name: name || path,
        type: 'local_file',
        path: path,
        dependencies: dependencies,
        description: `Load from local file: ${path}`
    }),
    github_raw: (url, name, dependencies = []) => ({
        name: name || url.split('/').pop(),
        type: 'github_raw',
        url: url,
        dependencies: dependencies,
        description: `Load from GitHub raw: ${url}`
    }),
    // Helper to create mrseq source with dependencies (uses installed package)
    mrseq_with_deps: {
        name: 'mrseq',
        type: 'pyodide_module',
        module: 'mrseq.scripts',
        description: 'Load sequences from installed mrseq package (with dependencies)',
        dependencies: [
            'numpy>=2.0.0',
            'pypulseq',
            { name: 'mrseq', deps: false }, // Install without dependency checks
            'ismrmrd'
        ]
    }
};

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SequenceExplorer, LoadScripts };
}
