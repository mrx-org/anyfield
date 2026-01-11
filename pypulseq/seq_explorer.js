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
        
        const addSourcesHtml = `
            <button id="seq-add-sources-btn" style="padding: 0.4rem 0.8rem; background: var(--accent); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.875rem; margin-left: 0.5rem;">
                Add Sources
            </button>
        `;
        
        this.container.innerHTML = `
            <div class="seq-explorer-controls">
                ${filterHtml}
                ${refreshHtml}
                ${addSourcesHtml}
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
                // Ensure checkbox state matches filter state
                checkbox.checked = this.filterSeqPrefix;
                checkbox.addEventListener('change', (e) => {
                    this.filterSeqPrefix = e.target.checked;
                    console.log('Filter changed:', this.filterSeqPrefix ? 'Only seq_ or main' : 'All functions');
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
        
        // Add Sources button
        const addSourcesBtn = this.container.querySelector('#seq-add-sources-btn');
        if (addSourcesBtn) {
            addSourcesBtn.addEventListener('click', () => {
                this.showSourceEditor();
            });
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
        // Install dependencies BEFORE loading the source
        // This ensures that configured sources can be loaded properly
        // Dependencies are only installed for sources that are actually in the config
        if (source.dependencies && source.dependencies.length > 0 && this.config.pyodide) {
            console.log(`Installing dependencies for source "${source.name}":`, source.dependencies);
            this.showStatus(`Installing dependencies for ${source.name}...`, 'info');
            await this.installDependencies(source.dependencies);
        }
        
        if (source.type === 'local_file') {
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
        const response = await fetch(source.path);
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
        
        // If it's a Jupyter notebook (.ipynb), convert it to Python code
        if (fileName.endsWith('.ipynb') || fetchUrl.endsWith('.ipynb')) {
            console.log('Detected Jupyter notebook, converting to Python...');
            try {
                const notebook = JSON.parse(code);
                // Extract code from all code cells
                const codeCells = notebook.cells
                    .filter(cell => cell.cell_type === 'code')
                    .map(cell => {
                        // Join source lines (can be array of strings or single string)
                        let source = Array.isArray(cell.source) 
                            ? cell.source.join('') 
                            : cell.source;
                        
                        // Clean up Colab/notebook-specific commands
                        // Remove shell commands (!), magic commands (%), and help commands (?)
                        const lines = source.split('\n');
                        const cleanedLines = lines
                            .filter(line => {
                                const trimmed = line.trim();
                                // Skip empty lines, shell commands, magic commands, and help commands
                                return trimmed.length > 0 && 
                                       !trimmed.startsWith('!') && 
                                       !trimmed.startsWith('%') && 
                                       !trimmed.startsWith('?');
                            })
                            .map(line => {
                                // Remove inline magic commands (e.g., "code %matplotlib inline")
                                return line.replace(/\s*%\w+.*$/g, '');
                            });
                        
                        return cleanedLines.join('\n');
                    })
                    .filter(source => source.trim().length > 0); // Remove empty cells
                
                code = codeCells.join('\n\n');
                // Change extension from .ipynb to .py
                fileName = fileName.replace(/\.ipynb$/, '.py');
                console.log(`Converted notebook to Python: ${codeCells.length} code cells, ${code.length} characters`);
            } catch (error) {
                console.warn('Failed to parse notebook as JSON, treating as plain text:', error);
                // If JSON parsing fails, try to clean the raw text anyway
                if (code.includes('!') || code.includes('%')) {
                    console.log('Cleaning notebook-like commands from raw text...');
                    const lines = code.split('\n');
                    code = lines
                        .filter(line => {
                            const trimmed = line.trim();
                            return trimmed.length > 0 && 
                                   !trimmed.startsWith('!') && 
                                   !trimmed.startsWith('%') && 
                                   !trimmed.startsWith('?');
                        })
                        .map(line => line.replace(/\s*%\w+.*$/g, ''))
                        .join('\n');
                }
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
        // Parse Python code to extract functions
        if (!this.config.pyodide) {
            // Fallback: simple regex parsing (less accurate)
            this.parseFileRegex(fileName, code, source);
            return;
        }
        
        // Use Pyodide to parse AST
        const pyodide = this.config.pyodide;
        return pyodide.runPythonAsync(`
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
            
            // Don't filter during parsing - store all functions, filter during rendering
            for (const func of functions) {
                this.sequences[fileName].functions.push({
                    name: func.name,
                    doc: func.doc,
                    source: source
                });
            }
            
            // Don't render tree here - it will be called after all sources are loaded
            console.log(`Parsed ${this.sequences[fileName].functions.length} functions from ${fileName}`);
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
    
    renderTree() {
        const treeEl = this.container.querySelector('#seq-tree');
        if (!treeEl) return;
        
        console.log('Rendering tree. Filter enabled:', this.filterSeqPrefix, 'Total sequences:', Object.keys(this.sequences).length);
        
        if (Object.keys(this.sequences).length === 0) {
            treeEl.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--muted);">No sequences loaded</div>';
            return;
        }
        
        let html = '';
        let totalFunctions = 0;
        let displayedFiles = 0;
        
        for (const [fileName, fileData] of Object.entries(this.sequences)) {
            // Apply filter: if filter is enabled, only show seq_ or main functions
            // If filter is disabled, show all functions
            const functions = fileData.functions.filter(f => {
                if (!this.filterSeqPrefix) {
                    // Filter disabled: show all
                    return true;
                } else {
                    // Filter enabled: only show seq_ or main
                    return f.name.startsWith('seq_') || f.name === 'main';
                }
            });
            
            totalFunctions += fileData.functions.length;
            
            if (functions.length === 0) continue;
            
            displayedFiles++;
            
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
        
        console.log(`Rendered ${displayedFiles} files with functions (${totalFunctions} total functions, filter: ${this.filterSeqPrefix ? 'ON' : 'OFF'})`);
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
            
            if (source.type === 'local_file' || source.type === 'github_raw' || source.type === 'remote_file' || source.type === 'github_folder') {
                // For file-based sources, get the code (use cached if available)
                const fileData = this.sequences[fileName];
                console.log('File data:', { fileName, hasFileData: !!fileData, hasCode: !!fileData?.code, sequencesKeys: Object.keys(this.sequences) });
                
                let code = fileData?.code;
                if (!code) {
                    if (source.type === 'local_file') {
                        code = await (await fetch(source.path)).text();
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
            if (source.type === 'local_file' || source.type === 'github_raw' || source.type === 'remote_file' || source.type === 'github_folder') {
                // Get the code (use cached if available)
                const fileData = this.sequences[fileName];
                let code = fileData?.code;
                if (!code) {
                    if (source.type === 'local_file') {
                        code = await (await fetch(source.path)).text();
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
                        // github_folder - code should be cached
                        code = fileData?.code;
                    }
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
            const sourcesJson = JSON.stringify(this.config.sources, null, 2);
            currentConfig = `# Sources configuration for sequence explorer
# Define sources as a list of dictionaries

sources = ${sourcesJson.replace(/"([^"]+)":/g, "'$1':").replace(/true/g, 'True').replace(/false/g, 'False').replace(/null/g, 'None')}`;
            console.log('Loaded current in-memory sources into editor');
        } else {
            // If no sources in memory, try to load from file
            try {
                const response = await fetch('sources_config.py?' + Date.now()); // Add cache bust
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
        `;
        
        const title = document.createElement('h2');
        title.textContent = 'Edit Sources Configuration';
        title.style.cssText = 'margin: 0 0 1rem 0; color: var(--accent, #4a9eff); font-size: 1.2rem;';
        
        const info = document.createElement('div');
        info.innerHTML = `
            <p style="margin: 0 0 1rem 0; color: var(--text-secondary, #aaa); font-size: 0.875rem;">
                Define sources as a Python list. Each source should have: <code>name</code>, <code>type</code>, 
                <code>module</code> (for pyodide_module), <code>url</code> (for github), <code>path</code> (for local_file), 
                and <code>dependencies</code> array.
            </p>
        `;
        
        // Create CodeMirror editor if available, otherwise use textarea
        let editor;
        const editorContainer = document.createElement('div');
        editorContainer.style.cssText = 'flex: 1; min-height: 400px; margin-bottom: 1rem; position: relative;';
        
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
            
            // Set height to fill container
            editor.setSize('100%', '100%');
            editorContainer.style.border = '1px solid var(--border, #333)';
            editorContainer.style.borderRadius = '4px';
        } else {
            const textarea = document.createElement('textarea');
            textarea.value = currentConfig;
            textarea.style.cssText = `
                width: 100%;
                height: 400px;
                background: var(--bg-secondary, #252525);
                color: var(--text, #ddd);
                border: 1px solid var(--border, #333);
                border-radius: 4px;
                padding: 0.75rem;
                font-family: 'Courier New', monospace;
                font-size: 0.875rem;
                resize: vertical;
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
            const response = await fetch('sources_config.py');
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
        'type': 'local_file',
        'path': 'mr0_rare_2d_seq.py',
        'dependencies': ['pypulseq']
    }
]`;
    }
    
    async loadSourcesFromConfig(configCode) {
        if (!this.config.pyodide) {
            throw new Error('Pyodide not available');
        }
        
        const pyodide = this.config.pyodide;
        
        // First, ensure seq_source_manager is available
        // Try to fetch and execute it
        let sourceManagerCode = null;
        try {
            const response = await fetch('seq_source_manager.py');
            if (response.ok) {
                sourceManagerCode = await response.text();
            }
        } catch (e) {
            console.warn('Could not fetch seq_source_manager.py, using inline version:', e);
        }
        
        // If fetch failed, use inline version
        if (!sourceManagerCode) {
            sourceManagerCode = `"""
Python-based source manager for sequence explorer.
Handles cloning, inspecting, and extracting sequences from various sources.
"""
import json
import inspect
import importlib
import pkgutil
import os
import sys
from types import ModuleType
from pathlib import Path


class SourceManager:
    """Manages sequence sources and their extraction."""
    
    def __init__(self, pyodide=None):
        self.pyodide = pyodide
        self.sources = []
        self.sequences = {}
        
    def load_sources_config(self, config_path_or_code):
        """
        Load sources from a Python file or JSON string.
        
        Args:
            config_path_or_code: Path to Python file, or Python code string, or JSON string
            
        Returns:
            List of source dictionaries
        """
        if isinstance(config_path_or_code, str):
            # Check if it's JSON
            if config_path_or_code.strip().startswith('{') or config_path_or_code.strip().startswith('['):
                try:
                    return json.loads(config_path_or_code)
                except json.JSONDecodeError:
                    pass
            
            # Try as Python code
            try:
                # First, try to compile to catch syntax errors early
                try:
                    compile(config_path_or_code, '<config>', 'exec')
                except SyntaxError as syn_err:
                    # Provide helpful syntax error message with line number
                    line_num = syn_err.lineno or 'unknown'
                    line_text = syn_err.text or ''
                    raise ValueError(f"Python syntax error at line {line_num}: {syn_err.msg}\\nLine: {line_text.strip()}")
                
                # Execute in a clean namespace
                namespace = {}
                exec(config_path_or_code, namespace)
                
                # Look for sources variable or get_sources function
                if 'sources' in namespace:
                    return namespace['sources']
                elif 'get_sources' in namespace:
                    return namespace['get_sources']()
                else:
                    raise ValueError("Python config must define 'sources' list or 'get_sources()' function")
            except ValueError:
                # Re-raise ValueError as-is (already has good message)
                raise
            except Exception as e:
                raise ValueError(f"Failed to parse config: {type(e).__name__}: {e}")
        else:
            raise ValueError("Config must be a string (Python code or JSON)")
    
    def add_source(self, source):
        """Add a source to the manager."""
        self.sources.append(source)
    
    def get_functions_from_package(self, package_path, filter_seq_prefix=False):
        """
        Extract functions from all modules in a package.
        
        Args:
            package_path: Python package path (e.g., 'mrseq.scripts')
            filter_seq_prefix: If True, only return functions starting with 'seq_' or named 'main'
            
        Returns:
            Dictionary mapping module names to their functions
        """
        try:
            package = importlib.import_module(package_path)
            package_path_obj = package.__path__ if hasattr(package, '__path__') else None
            
            all_functions = {}
            
            if package_path_obj:
                for importer, modname, ispkg in pkgutil.iter_modules(package_path_obj, package_path + '.'):
                    if ispkg:
                        continue
                    
                    try:
                        module = importlib.import_module(modname)
                        module_basename = os.path.basename(modname)
                        
                        functions = []
                        for name in dir(module):
                            if name.startswith('_'):
                                continue
                            
                            obj = getattr(module, name)
                            if inspect.isfunction(obj):
                                # Apply filter
                                if filter_seq_prefix and not (name.startswith('seq_') or name == 'main'):
                                    continue
                                
                                functions.append({
                                    'name': name,
                                    'doc': inspect.getdoc(obj) or '',
                                    'signature': str(inspect.signature(obj))
                                })
                        
                        if functions:
                            all_functions[module_basename] = {
                                'functions': functions,
                                'full_module_path': modname
                            }
                    except Exception as e:
                        print(f"Warning: Could not load module {modname}: {e}", file=sys.stderr)
                        continue
            else:
                # Single module
                module = importlib.import_module(package_path)
                module_name = os.path.basename(package_path)
                functions = []
                for name in dir(module):
                    if name.startswith('_'):
                        continue
                    obj = getattr(module, name)
                    if inspect.isfunction(obj):
                        if filter_seq_prefix and not (name.startswith('seq_') or name == 'main'):
                            continue
                        functions.append({
                            'name': name,
                            'doc': inspect.getdoc(obj) or '',
                            'signature': str(inspect.signature(obj))
                        })
                if functions:
                    all_functions[module_name] = {
                        'functions': functions,
                        'full_module_path': package_path
                    }
            
            return all_functions
        except Exception as e:
            return {'error': str(e)}
    
    def parse_file_functions(self, code, filter_seq_prefix=False):
        """
        Parse Python code and extract function definitions.
        
        Args:
            code: Python source code string
            filter_seq_prefix: If True, only return functions starting with 'seq_' or named 'main'
            
        Returns:
            List of function dictionaries
        """
        import ast
        
        functions = []
        
        try:
            tree = ast.parse(code)
            for node in ast.walk(tree):
                if isinstance(node, ast.FunctionDef):
                    func_name = node.name
                    
                    # Apply filter
                    if filter_seq_prefix and not (func_name.startswith('seq_') or func_name == 'main'):
                        continue
                    
                    # Extract docstring
                    docstring = ast.get_docstring(node) or ''
                    
                    # Build signature string
                    args = []
                    for arg in node.args.args:
                        arg_str = arg.arg
                        if arg.annotation:
                            try:
                                arg_str += f": {ast.unparse(arg.annotation)}"
                            except:
                                pass
                        args.append(arg_str)
                    
                    # Handle defaults
                    defaults = node.args.defaults
                    if defaults:
                        for i, default in enumerate(defaults):
                            idx = len(args) - len(defaults) + i
                            try:
                                default_val = ast.unparse(default)
                                args[idx] += f" = {default_val}"
                            except:
                                pass
                    
                    signature = f"({', '.join(args)})"
                    
                    functions.append({
                        'name': func_name,
                        'doc': docstring,
                        'signature': signature
                    })
        except SyntaxError as e:
            # Fallback to regex or execution-based extraction
            import re
            # Simple regex fallback
            pattern = r'def\s+(\\w+)\\s*\\([^)]*\\)\\s*:'
            for match in re.finditer(pattern, code):
                func_name = match.group(1)
                if filter_seq_prefix and not (func_name.startswith('seq_') or func_name == 'main'):
                    continue
                functions.append({
                    'name': func_name,
                    'doc': '',
                    'signature': match.group(0)
                })
        
        return functions
    
    def extract_function_parameters(self, module_path, function_name, code=None):
        """
        Extract parameters from a function using inspect or AST.
        
        Args:
            module_path: Full module path (e.g., 'mrseq.scripts.t1_inv_rec_gre_single_line')
            function_name: Name of the function
            code: Optional source code (for file-based sources)
            
        Returns:
            List of parameter dictionaries
        """
        import numpy as np
        
        try:
            # Try to import and inspect
            if module_path:
                module = importlib.import_module(module_path)
                func = getattr(module, function_name)
            elif code:
                # Execute code and extract function
                namespace = {}
                exec(code, namespace)
                func = namespace.get(function_name)
                if not func:
                    raise AttributeError(f"Function '{function_name}' not found in code")
            else:
                raise ValueError("Either module_path or code must be provided")
            
            sig = inspect.signature(func)
            params = []
            for name, p in sig.parameters.items():
                if name == 'system':
                    continue
                
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
                
                params.append({
                    'name': name,
                    'default': val,
                    'type': type_name
                })
            
            return params
        except Exception as e:
            raise Exception(f"Failed to extract parameters: {e}")
    
    def load_source(self, source, filter_seq_prefix=False):
        """
        Load sequences from a source.
        
        Args:
            source: Source dictionary with type, path, etc.
            filter_seq_prefix: Whether to filter for seq_ or main functions
            
        Returns:
            Dictionary of sequences (filename -> {functions, source, code})
        """
        sequences = {}
        
        if source['type'] == 'pyodide_module':
            # Load from installed package
            all_functions = self.get_functions_from_package(
                source['module'],
                filter_seq_prefix=filter_seq_prefix
            )
            
            if 'error' in all_functions:
                raise Exception(all_functions['error'])
            
            for module_name, module_data in all_functions.items():
                fileName = f"{module_name}.py"
                sequences[fileName] = {
                    'functions': module_data['functions'],
                    'source': {**source, 'moduleName': module_name, 'fullModulePath': module_data['full_module_path']},
                    'code': None  # Not available for module sources
                }
        
        elif source['type'] in ['local_file', 'github_raw']:
            # For file-based sources, code should be provided
            # This would be handled by JavaScript fetching the file
            # Python would then parse it
            pass
        elif source['type'] == 'github_folder':
            # GitHub folders are handled by JavaScript (fetching via API)
            # Python can parse the files once they're fetched
            pass
        
        return sequences
`;
        }
        
        // Execute the source manager code to make it available
        // We need to execute it in the module's namespace so the class is defined there
        await pyodide.runPythonAsync(`
import sys
from types import ModuleType

# Create a module for seq_source_manager
seq_source_manager = ModuleType('seq_source_manager')
sys.modules['seq_source_manager'] = seq_source_manager

# Execute the code in the module's namespace so classes are defined there
exec(${JSON.stringify(sourceManagerCode)}, seq_source_manager.__dict__)
`);
        
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
            console.error('Error executing Python code to load sources:', error);
            throw new Error(`Failed to load sources: ${error.message}`);
        }
        
        if (!result || result === 'undefined' || result === undefined || result === null) {
            console.error('Python returned undefined/null. Full error:', result);
            throw new Error('Python code did not return a valid result. Check console for Python errors.');
        }
        
        console.log('Python result type:', typeof result, 'value:', result);
        
        let sources;
        try {
            sources = JSON.parse(result);
        } catch (parseError) {
            console.error('Failed to parse Python result as JSON:', result);
            throw new Error(`Failed to parse Python result as JSON: ${parseError.message}. Result was: ${result}`);
        }
        
        // Check if Python returned an error
        if (sources && typeof sources === 'object' && sources.error) {
            throw new Error(`Python error: ${sources.error}`);
        }
        
        // Ensure sources is an array
        if (!Array.isArray(sources)) {
            console.error('Sources is not an array:', sources);
            throw new Error(`Expected sources to be an array, got ${typeof sources}`);
        }
        console.log('Loaded sources from config:', sources);
        console.log('Number of sources:', sources.length);
        
        // Validate that sources is an array
        if (!Array.isArray(sources)) {
            throw new Error(`Expected sources to be an array, got ${typeof sources}`);
        }
        
        this.config.sources = sources;
        this.sequences = {};
        await this.loadSequences();
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
