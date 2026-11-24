/**
 * Application bootstrap: build the module graph, then bring Pyodide up behind it.
 *
 * Two phases, and the split is the point. Pyodide plus its packages costs several
 * seconds, so `pyodidePromise` is started first and deliberately *not* awaited:
 * the whole UI is constructed and shown against it, and only the work that
 * genuinely needs Python (the sequence sources) waits. `/phantom` lives on
 * `ctx.pyWorker`, not this interpreter.
 *
 * Every module is built with the shared `AppContext` and each one is published
 * onto it as soon as it exists. The modules reference each other cyclically and
 * only ever read their slots lazily -- inside a method or a handler, never at
 * construction time -- which is what makes a registry that is still half-empty
 * during construction safe. See `app_context.js`.
 *
 * The one `window.*` the app publishes is `window.anyfield`, the context itself,
 * as a debug/e2e seam. No app code reads it.
 */

import { NiivueModule, ScanPreviewModule, ComparePane } from './niivue_app.js';
import { MainHistogramController, PreviewJointHistogramController } from './hist_panel/histogram-clim-panel.js';
import { SequenceExplorer, patchSequencePlotFromCode } from './pypulseq/seq_explorer.js';
import { ScanModule } from './scan_zero/scan_module.js?v=14';
import { AppContext, setAppContext } from './app_context.js';
import { initFooterCards } from './footer_cards.js';
import { PyWorkerHost } from './py_worker_host.js';
import { ViewManager } from './view_manager.js';

// URL flags: ?pro=1 pro/debug; readable deep link ?s_category=&s_file=&s_func= or legacy ?init_prot=; ?seq_url= remote .seq
const urlParams = new URLSearchParams(window.location.search);
// This regex matches more than it appears to -- `(^1) | (true) | (yes$)` -- and is kept
// that way on purpose; see pro_mode.js and insights/SPEC_no_field.md. The `.pro-user`
// class is load-bearing CSS, so this write stays even though every read goes through
// isProUser().
window.pro = /^1|true|yes$/i.test(urlParams.get('pro') || '');
document.documentElement.classList.toggle('pro-user', window.pro);
const sCat = (urlParams.get('s_category') || '').trim();
const sFile = (urlParams.get('s_file') || '').trim();
const sFunc = (urlParams.get('s_func') || '').trim();
const hasSplitInit = sCat !== '' && sFile !== '' && sFunc !== '';
const initialProtFromSplit = hasSplitInit ? `${sCat}/${sFile}:${sFunc}` : undefined;
const initialProtRaw = urlParams.get('init_prot');
const initialProtFromLegacy =
    initialProtRaw != null && String(initialProtRaw).trim() !== '' ? String(initialProtRaw).trim() : undefined;
const initialSeqUrl = (urlParams.get('seq_url') || '').trim();
let initialSeqParams = null;
for (const [key, val] of urlParams) {
    if (!key.startsWith('sp_')) continue;
    if (!initialSeqParams) initialSeqParams = {};
    const name = key.slice(3);
    let parsed;
    if (val === 'true') parsed = true;
    else if (val === 'false') parsed = false;
    else if (val.startsWith('[')) { try { parsed = JSON.parse(val); } catch(e) { parsed = val; } }
    else parsed = isNaN(val) || val === '' ? val : Number(val);
    initialSeqParams[name] = parsed;
}
let initialProt = initialProtFromSplit ?? initialProtFromLegacy;
if (initialSeqUrl && !initialProt) {
    initialProt = 'anyseq/seq_pulseq_interpreter:seq_pulseq_interpreter';
}

export async function bootstrap() {
    try {
        // Prefetch plot utils while Pyodide downloads (patch runs inside pyodidePromise, under loader).
        const plotUtilsFetch = fetch(`pypulseq/seq_plot_utils.py?${Date.now()}`).then(async (r) => {
            if (!r.ok) throw new Error(`seq_plot_utils.py: ${r.status}`);
            return r.text();
        });

        // A. START PYODIDE & PACKAGES IN BACKGROUND (do not await)
        const pyodidePromise = (async () => {
            const py = await loadPyodide({
                indexURL: "https://cdn.jsdelivr.net/pyodide/v0.29.0/full/",
            });
            await py.loadPackage(['numpy', 'micropip', 'matplotlib', 'scipy']);
            const plotUtilsCode = await plotUtilsFetch;
            // Pin pypulseq for reproducible .seq format and API.
            // deps=False: numpy already loaded; matplotlib/scipy loaded on demand — skips ~3s of transitive dep downloads.
            await py.runPythonAsync(`
import micropip
await micropip.install('pypulseq==1.5.0.post1', deps=False)
`);
            await patchSequencePlotFromCode(py, plotUtilsCode);
            return py;
        })();

        // B. FAST PATH: show sidebar + main (Niivue) immediately
        // One shared registry, filled in as each module comes up. The modules
        // reference each other cyclically and only ever read their slots lazily,
        // so the slots may still be null while construction is in progress.
        const ctx = new AppContext();
        setAppContext(ctx);
        ctx.pyWorker = new PyWorkerHost();

        // The promise, not just the eventual value: anything that awaits initPyodide()
        // before the assignment in the tail below would otherwise start a second
        // interpreter of its own. See NiivueModule.initPyodide.
        const nvModule = new NiivueModule({ ctx, pyodidePromise });
        ctx.nv = nvModule;
        nvModule.renderViewer('nv-viewer-container');
        nvModule.renderControls('nv-controls-container', true);

        const explorer = new SequenceExplorer(null, {
            ctx,
            sources: [],
            initialProt,
            initialSeqUrl,
            initialSeqParams,
            onFunctionStart: () => {
                ctx.viewManager?.setMode('sequence');
            }
        });
        ctx.explorer = explorer;
        explorer._plotStackReady = pyodidePromise;
        explorer.renderTree('seq-tree-container');
        explorer.renderParams('seq-params-container');
        await explorer.renderPlot('seq-plot-container');

        const scanModule = new ScanModule(ctx);
        ctx.scan = scanModule;
        scanModule.render('scan-module-container');

        const scanPreview = new ScanPreviewModule({ ctx, role: 'preview', labelDefault: 'Scan Preview' });
        ctx.scanPreview = scanPreview;
        scanPreview.render('nv-scan-preview-container');

        const scanCompare = new ComparePane(ctx);
        ctx.scanCompare = scanCompare;

        const mainHist = new MainHistogramController(nvModule, ctx);
        ctx.mainHist = mainHist;
        mainHist.attachToContainer(document.getElementById('nv-viewer-container'));
        const jointHist = new PreviewJointHistogramController(scanPreview, scanCompare, ctx);
        ctx.jointHist = jointHist;
        jointHist.attachToJointRow(document.getElementById('nv-joint-hist-row'));

        const configPromise = explorer.getDefaultSourcesConfig();

        const viewManager = new ViewManager(nvModule, explorer, scanModule, scanPreview, ctx);
        ctx.viewManager = viewManager;
        viewManager.setMode('planning');
        viewManager.bindViewModeButtons();

        // Shared-link gating: if a capsule/URL share is present, confirm before applying it.
        // Resolves the user's choice; must complete before loadSourcesFromConfig (import) runs.
        const sharedGateReady = (async () => {
            let preview = null;
            try {
                preview = await explorer.previewSharedImport();
            } catch (e) {
                console.warn('previewSharedImport failed:', e);
            }
            if (!preview) return { accepted: false, preview: null };
            let choice = 'default';
            try {
                choice = await explorer.showSharedImportDialog(preview);
            } catch (e) {
                console.warn('showSharedImportDialog failed:', e);
            }
            if (choice === 'shared') {
                // URL-sourced meta is applied by selectInitialSequence via _pendingSharedSimMeta;
                // capsule meta is read from the imported protocol's own [simulation] block.
                if (preview.source === 'url' && preview.simMeta) {
                    explorer._pendingSharedSimMeta = preview.simMeta;
                }
                return { accepted: true, preview };
            }
            // Load default: ignore shared import AND the shared sequence/params in the URL.
            explorer._skipSharedImport = true;
            explorer.config.initialProt = undefined;
            explorer.config.initialSeqParams = null;
            return { accepted: false, preview };
        })();

        const mainViewerEl = document.getElementById('nv-viewer-container');
        if (mainViewerEl) mainViewerEl.classList.add('viewer-waiting-demo');
        // Wait for the gate so we don't load the default phantom then replace it with the shared one.
        const phantomReady = sharedGateReady.then(({ accepted, preview }) => {
            if (accepted && preview?.phantom) {
                // The shared phantom is loaded by selectInitialSequence (applySimulationStateFromMeta).
                if (mainViewerEl) mainViewerEl.classList.remove('viewer-waiting-demo');
                return;
            }
            return nvModule.loadDefaultCachePhantom().finally(() => {
                if (mainViewerEl) mainViewerEl.classList.remove('viewer-waiting-demo');
            });
        }).catch((err) => {
            console.error('Default phantom load failed:', err);
            if (mainViewerEl) mainViewerEl.classList.remove('viewer-waiting-demo');
        });

        // Debug / e2e seam: the module registry, for inspecting app state from the
        // console or from tests/e2e. Deliberately the ONLY window global the app
        // publishes -- no app code reads it, everything goes through the injected
        // context instead.
        window.anyfield = ctx;

        // Footer listeners (footer stays hidden until Pyodide ready)
        initFooterCards();

        // Start with sidebar collapsed on mobile
        (function initMobileSidebarCollapsed() {
            if (!window.matchMedia('(max-width: 768px)').matches) return;
            const labGrid = document.querySelector('.lab-grid');
            const slotSidebar = document.getElementById('slot-sidebar');
            const tabsContent = document.querySelector('.tabs-content');
            const scansBtn = document.querySelector('.tab-btn[data-tab="scans"]');
            if (labGrid && slotSidebar) {
                labGrid.classList.add('sidebar-collapsed');
                slotSidebar.classList.add('sidebar-collapsed');
                if (tabsContent) tabsContent.classList.add('panel-collapsed');
                if (scansBtn) {
                    scansBtn.textContent = scansBtn.dataset.collapsedLabel || 'S';
                }
            }
        })();

        // Swipe left on sidebar to collapse, swipe right to expand (mobile)
        (function initSidebarSwipe() {
            const sidebar = document.getElementById('slot-sidebar');
            if (!sidebar) return;
            let startX = 0;
            const threshold = 50;
            sidebar.addEventListener('touchstart', (e) => {
                if (!window.matchMedia('(max-width: 768px)').matches) return;
                startX = e.touches[0].clientX;
            }, { passive: true });
            sidebar.addEventListener('touchend', (e) => {
                if (!window.matchMedia('(max-width: 768px)').matches) return;
                const endX = e.changedTouches[0].clientX;
                const delta = startX - endX;
                const btn = sidebar.querySelector('.tab-btn[data-tab="scans"]');
                const labGrid = sidebar.closest('.lab-grid');
                const tabsContent = sidebar.querySelector('.tabs-content');
                if (!btn || !labGrid || !btn.classList.contains('active')) return;
                if (delta > threshold) {
                    if (!labGrid.classList.contains('sidebar-collapsed')) {
                        labGrid.classList.add('sidebar-collapsed');
                        sidebar.classList.add('sidebar-collapsed');
                        if (tabsContent) tabsContent.classList.add('panel-collapsed');
                        btn.textContent = btn.dataset.collapsedLabel || 'S';
                    }
                } else if (delta < -threshold) {
                    if (labGrid.classList.contains('sidebar-collapsed')) {
                        labGrid.classList.remove('sidebar-collapsed');
                        sidebar.classList.remove('sidebar-collapsed');
                        if (tabsContent) tabsContent.classList.remove('panel-collapsed');
                        btn.textContent = btn.dataset.fullLabel || 'SCANS';
                    }
                }
            }, { passive: true });
        })();

        // C. WHEN PYODIDE IS READY: finish setup, then hide loader and show footer
        function hideLoaderAndShowFooter() {
            const loaderEl = document.getElementById('loader');
            const footerWrapper = document.querySelector('.footer-wrapper');
            if (loaderEl) loaderEl.classList.add('hidden');
            if (footerWrapper) footerWrapper.classList.remove('footer-pending');
        }

        pyodidePromise.then(async (pyodide) => {
            nvModule.pyodide = pyodide;
            explorer.config.pyodide = pyodide;
            const configCode = await configPromise;
            // Ensure the shared-link decision (skip/import + pending meta) is settled before
            // loadSourcesFromConfig triggers importSharedProtocolFromLocation / selectInitialSequence.
            await sharedGateReady;
            await Promise.all([
                nvModule.initPyodide(),
                explorer.loadSourcesFromConfig(configCode),
            ]);
            nvModule.updateJsonTab();
            hideLoaderAndShowFooter();
            // Warm the Python worker only now. Its slow part is micropip fetching
            // pynufft, scipy and nibabel, and starting it any earlier would compete for
            // bandwidth with the very boot it exists to stay out of the way of. A scan
            // still cannot arrive before this, since it needs a sequence selected first
            // -- and if one does, it joins this same promise rather than installing twice.
            ctx.pyWorker.startWarmUp();
            // Default phantom fetch/render may still finish in background
            phantomReady.catch(() => {});
        }).catch(async (e) => {
            console.error("Pyodide/background setup failed:", e);
            hideLoaderAndShowFooter();
        });

    } catch (e) {
        console.error("Bootstrap failed:", e);
    }
}
