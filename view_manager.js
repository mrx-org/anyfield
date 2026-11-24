/**
 * Pane layout: which module occupies which slot, and how the three viewers share
 * the main column.
 *
 * The app has no router and no framework. `setMode()` empties the five slot
 * elements and re-appends the module containers cached in `#module-cache`, which
 * is why the containers are created once in the HTML and moved rather than
 * rebuilt -- a Niivue canvas does not survive being re-parented by innerHTML.
 *
 * Reads its collaborators from the `AppContext` it is given (`ctx.scanCompare`,
 * `ctx.mainHist`) and takes the three it needs before the context is fully
 * populated (`nvModule`, `seqExplorer`, `scanModule`, `scanPreview`) as
 * constructor arguments, matching the progressive-construction order in
 * `app_bootstrap.js`.
 */

import { ComparePane, syncPreviewViewerClims } from './niivue_app.js';

export class ViewManager {
    constructor(nvModule, seqExplorer, scanModule, scanPreview, ctx = null) {
        this.nv = nvModule;
        this.seq = seqExplorer;
        this.scan = scanModule;
        this.preview = scanPreview;
        /** Shared module registry, for the panes built after this one. */
        this.ctx = ctx;
        this.currentMode = null;
        this.maximizedViewer = null; // null | nvViewer | nvScanPreview | nvCompare
        this.compareActive = false;
        this.slots = {
            sidebar: document.getElementById('slot-sidebar'),
            main: document.getElementById('slot-main'),
            tree: document.getElementById('col-tree'),
            scan: document.getElementById('col-scan'),
            params: document.getElementById('col-params')
        };
        this.cache = {
            nvViewer: document.getElementById('nv-viewer-container'),
            nvPreviewBcStack: document.getElementById('nv-preview-bc-stack'),
            nvScanPreview: document.getElementById('nv-scan-preview-container'),
            nvCompare: document.getElementById('nv-compare-container'),
            nvControls: document.getElementById('nv-controls-container'),
            seqTree: document.getElementById('seq-tree-container'),
            seqParams: document.getElementById('seq-params-container'),
            seqPlot: document.getElementById('seq-plot-container'),
            scanModule: document.getElementById('scan-module-container')
        };
    }

    bindViewModeButtons() {
        document.getElementById('view-mode-planning-btn')?.addEventListener('click', () => {
            if (this.compareActive) this.deactivateCompareColumn();
            this.setMode('planning');
        });
        document.getElementById('view-mode-compare-btn')?.addEventListener('click', () => {
            this.setMode('planning');
            this.activateCompareColumn();
        });
        document.getElementById('view-mode-sequence-btn')?.addEventListener('click', () => {
            if (this.currentMode !== 'sequence') {
                this.setMode('sequence');
            }
            this.seq?.executeFunction?.();
        });
        this.syncViewModeButtons();
    }

    syncViewModeButtons() {
        const planningBtn = document.getElementById('view-mode-planning-btn');
        const compareBtn = document.getElementById('view-mode-compare-btn');
        const sequenceBtn = document.getElementById('view-mode-sequence-btn');
        const compare = !!this.compareActive;
        planningBtn?.classList.toggle('is-active', this.currentMode === 'planning' && !compare);
        compareBtn?.classList.toggle('is-active', this.currentMode === 'planning' && compare);
        sequenceBtn?.classList.toggle('is-active', this.currentMode === 'sequence');
    }

    toggleViewerMaximize(containerId) {
        if (this.currentMode !== 'planning') return;

        // Determine which viewer was double-tapped
        let tappedViewer = null;
        if (containerId === 'nv-viewer-container') tappedViewer = 'nvViewer';
        else if (containerId === 'nv-scan-preview-container') tappedViewer = 'nvScanPreview';
        else if (containerId === 'nv-compare-container') tappedViewer = 'nvCompare';
        else return;

        // Toggle logic
        if (this.maximizedViewer === tappedViewer) {
            // Already maximized - restore both
            this.maximizedViewer = null;
        } else {
            // Maximize the tapped viewer
            this.maximizedViewer = tappedViewer;
        }

        // Apply the layout
        this.applyViewerLayout();
    }

    activateCompareColumn() {
        this.compareActive = true;
        this.maximizedViewer = null;
        const compare = this.cache.nvCompare;
        const main = this.slots.main;
        if (compare) {
            compare.classList.remove('compare-pane-hidden');
            compare.style.display = 'flex';
            compare.style.flex = '1';
            compare.style.minWidth = '0';
            compare.style.minHeight = '0';
        }
        if (main) main.classList.add('has-compare-pane');
        ComparePane.ensureEmptyPlaceholder(compare);
        if (this.currentMode === 'planning') {
            this.applyViewerLayout();
        }
        this.syncViewModeButtons();
    }

    deactivateCompareColumn() {
        this.compareActive = false;
        if (this.maximizedViewer === 'nvCompare') {
            this.maximizedViewer = null;
        }
        const compare = this.cache.nvCompare;
        if (compare) {
            compare.classList.add('compare-pane-hidden');
            compare.style.display = 'none';
        }
        this.slots.main?.classList.remove('has-compare-pane');
        if (this.currentMode === 'planning') {
            this.applyViewerLayout();
        }
        this.syncViewModeButtons();
    }

    applyViewerLayout() {
        const viewer = this.cache.nvViewer;
        const bcStack = this.cache.nvPreviewBcStack;
        const preview = this.cache.nvScanPreview;
        const compare = this.cache.nvCompare;
        const three = this.compareActive;
        const border = '1px solid var(--border)';

        const showCol = (el, flexGrow = '1') => {
            if (!el) return;
            el.style.display = 'flex';
            el.style.flex = flexGrow;
            el.style.minWidth = '0';
            el.style.minHeight = '0';
            el.style.flexDirection = 'column';
        };
        const hideCol = (el) => {
            if (el) el.style.display = 'none';
        };
        const showInner = (el) => {
            if (!el) return;
            el.style.display = 'flex';
            el.style.flex = '1';
            el.style.minWidth = '0';
            el.style.minHeight = '0';
            el.style.flexDirection = 'column';
        };
        const hideInner = (el) => {
            if (el) el.style.display = 'none';
        };

        if (this.maximizedViewer === 'nvViewer') {
            showCol(viewer);
            hideCol(bcStack);
        } else if (this.maximizedViewer === 'nvScanPreview') {
            hideCol(viewer);
            showCol(bcStack);
            showInner(preview);
            hideInner(compare);
            if (bcStack) bcStack.style.borderLeft = 'none';
        } else if (this.maximizedViewer === 'nvCompare') {
            hideCol(viewer);
            showCol(bcStack);
            hideInner(preview);
            showInner(compare);
            ComparePane.ensureEmptyPlaceholder(compare);
            if (compare) compare.style.borderLeft = 'none';
            if (bcStack) bcStack.style.borderLeft = 'none';
        } else {
            showCol(viewer);
            showCol(bcStack, three ? '2' : '1');
            if (bcStack) bcStack.style.borderLeft = border;
            showInner(preview);
            if (three) {
                showInner(compare);
                if (compare) {
                    compare.classList.remove('compare-pane-hidden');
                    compare.style.borderLeft = border;
                    ComparePane.ensureEmptyPlaceholder(compare);
                }
            } else {
                hideInner(compare);
                if (compare) compare.classList.add('compare-pane-hidden');
            }
        }

        setTimeout(() => {
            if (this.nv?.nv && viewer?.style.display !== 'none') {
                this.nv.nv.resizeListener();
            }
            if (this.preview?.nv && preview?.style.display !== 'none') {
                this.preview.nv.resizeListener();
            }
            const cmpNv = this.ctx?.scanCompare?.module?.nv;
            if (cmpNv && compare?.style.display !== 'none') {
                cmpNv.resizeListener();
            }
            syncPreviewViewerClims(this.ctx);
            this.ctx?.mainHist?.scheduleRefresh?.();
        }, 50);
    }

    moveToSlot(moduleName, slotName) {
        const content = this.cache[moduleName];
        const slot = this.slots[slotName];
        if (content && slot) {
            slot.appendChild(content);
        }
    }

    setMode(mode, autoPlot = false) {
        console.log('Switching to mode:', mode);
        this.currentMode = mode;

        // Clear slots
        this.slots.sidebar.innerHTML = '';
        this.slots.main.innerHTML = '';
        this.slots.tree.innerHTML = '';
        this.slots.scan.innerHTML = '';
        this.slots.params.innerHTML = '';

        // Always fixed parts
        this.moveToSlot('nvControls', 'sidebar');
        this.moveToSlot('seqTree', 'tree');
        this.moveToSlot('scanModule', 'scan');
        this.moveToSlot('seqParams', 'params');

        if (mode === 'planning') {
            this.slots.main.style.display = 'flex';
            this.slots.main.style.flexDirection = 'row';
            this.slots.main.classList.add('planning-hist-visible');
            this.moveToSlot('nvViewer', 'main');
            this.moveToSlot('nvPreviewBcStack', 'main');
            this.slots.main.classList.remove('scrollable');
            this.applyViewerLayout();
        } else if (mode === 'sequence') {
            this.slots.main.classList.remove('planning-hist-visible');
            // Reset maximize state when leaving planning mode
            this.maximizedViewer = null;
            // Full width for sequence plot
            this.slots.main.style.display = '';
            this.slots.main.style.flexDirection = '';
            this.moveToSlot('seqPlot', 'main');
            this.slots.main.classList.add('scrollable');

            // Trigger plot if requested and not already plotting
            if (autoPlot && this.seq && this.seq.selectedSequence) {
                this.seq.executeFunction();
            }
        }

        // Notify Niivue to resize
        if (this.nv && this.nv.nv) {
            setTimeout(() => {
                this.nv.nv.resizeListener();
                // Force grid layout again after resize
                if (typeof this.nv.nv.setMultiplanarLayout === 'function') {
                    this.nv.nv.setMultiplanarLayout(2); // GRID
                }
            }, 50);
        }
        if (this.preview && this.preview.nv) {
            setTimeout(() => {
                this.preview.nv.resizeListener();
            }, 50);
        }
        this.syncViewModeButtons();
    }
}
