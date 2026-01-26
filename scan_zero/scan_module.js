import { eventHub } from '../event_hub.js';

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
                <div class="scan-header">
                    <button id="btn-start-scan" class="scan-btn">
                        <span class="icon">▶</span> SCAN
                    </button>
                    <div class="active-info">
                        Ready: <span id="ready-seq-name">${this.currentSequence ? this.currentSequence.name : 'None'}</span>
                    </div>
                </div>
                <div class="scan-queue" id="scan-queue-list">
                    <div class="queue-empty">Queue is empty</div>
                </div>
            </div>
        `;

        this.container.querySelector('#btn-start-scan').onclick = () => this.startScan();
        
        // Make this instance available globally for UI callbacks if needed
        window.scanModule = this;
    }

    updateHeader() {
        if (!this.container) return;
        const el = this.container.querySelector('#ready-seq-name');
        if (el) el.textContent = this.currentSequence ? this.currentSequence.name : 'None';
    }

    async startScan() {
        if (!this.currentSequence) {
            alert("Please select a sequence in the Explorer first.");
            return;
        }

        // 1. Trigger sequence execution to ensure SourceManager has the latest data
        // We use silent=true to prevent mode switching and plotting during the scan process
        if (window.seqExplorer) {
            try {
                console.log("ScanModule: Triggering sequence execution (silent) for:", this.currentSequence.name);
                const result = await window.seqExplorer.executeFunction(true);
                console.log("ScanModule: Sequence execution result:", result);
            } catch (e) {
                console.error("Sequence execution failed before scan:", e);
                alert("Failed to generate sequence. Check the console for errors.");
                return;
            }
        }

        this.scanCounter++;
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const ts = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
        const seqSafeName = (this.currentSequence.name || "Scan").replace(/\s+/g, '_');
        const baseName = `scan_${this.scanCounter}_${ts}_${seqSafeName}`;

        const job = {
            id: 'job_' + now.getTime(),
            scanNumber: this.scanCounter,
            baseName: baseName,
            name: this.currentSequence.name || "Untitled Scan",
            protocol: "Standard Protocol",
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
            
            // 4. Run the resampling script that was already initialized in NiivueModule
            let res = await nvMod.pyodide.runPythonAsync(`run_resampling(source_bytes, reference_bytes)`);
            const niftiBytes = (res && res.toJs) ? res.toJs() : res;
            if (res && res.destroy) res.destroy();

            // 5. Save the actual .seq file to the virtual filesystem
            const saveResult = await nvMod.pyodide.runPythonAsync(`
import os
import sys
import __main__
from seq_source_manager import SourceManager

# Ensure output directory exists in the root of the virtual filesystem
if not os.path.exists('/outputs'):
    os.makedirs('/outputs')

# Try to get sequence from SourceManager or __main__
seq = getattr(SourceManager, '_last_sequence', None)
if not seq and hasattr(__main__, 'seq'):
    seq = __main__.seq

_final_status = "no_sequence"
if seq:
    # Use absolute path for the virtual filesystem
    vfs_path = os.path.join('/outputs', '${job.baseName}.seq')
    try:
        seq.write(vfs_path)
        print(f"Successfully saved sequence to {vfs_path}")
        _final_status = "success"
    except Exception as e:
        print(f"Error writing .seq file: {e}")
        _final_status = f"error: {e}"
else:
    print("Warning: No sequence object found in memory to save.")

_final_status
            `);
            
            console.log("ScanModule: Python save result:", saveResult);
            
            if (saveResult === "success") {
                job.vfsSeqPath = `/outputs/${job.baseName}.seq`;
            } else {
                console.warn("ScanModule: Could not save .seq file. Python returned:", saveResult);
                // We'll still allow the scan to finish, but VIEW SEQ will be limited
            }

            // 6. Create URLs for the results
            job.niftiUrl = URL.createObjectURL(new Blob([niftiBytes], {type: "application/octet-stream"}));
            
            // Create a fake .seq file for the "File-Pair" logic
            const seqContent = `# Pulseq file for ${job.name}\n# Based on ${this.currentSequence.fileName || 'unknown'}\n# FOV Parameters: ${JSON.stringify(this.currentFov || {})}`;
            job.seqUrl = URL.createObjectURL(new Blob([seqContent], {type: "text/plain"}));

            job.status = 'done';
            
            // 7. Auto-trigger VIEW SCAN after scan is complete
            this.loadJob(job.id);
            
        } catch (e) {
            console.error("Scan simulation failed:", e);
            job.status = 'error';
            job.error = e.message;
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
                            <button class="view-seq-btn">VIEW SEQ</button>
                        </div>
                        <div class="action-row small-btns">
                            <button class="dl-seq-btn" title="Download .seq file">↓</button>
                            <button class="remove-job-btn" title="Remove scan">×</button>
                        </div>
                    ` : ''}
                    ${job.status === 'error' ? `
                        <div class="action-row small-btns">
                            <span class="error-icon" title="${job.error}">⚠</span>
                            <button class="remove-job-btn" title="Remove scan">×</button>
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

            // 3. Set opacity: 1 for this one, 0 for all others
            if (volumeIndex !== -1) {
                nvMod.nv.volumes.forEach((vol, idx) => {
                    nvMod.nv.setOpacity(idx, idx === volumeIndex ? 1.0 : 0);
                });
                
                // 4. Update the volume list UI checkboxes
                if (typeof nvMod.updateVolumeList === 'function') {
                    nvMod.updateVolumeList();
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
