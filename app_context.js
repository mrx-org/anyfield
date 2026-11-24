/**
 * Shared handle on the app's long-lived module instances.
 *
 * This replaces the `window.nvModule` / `window.seqExplorer` / … globals that the
 * modules used to reach each other through. It is a **mutable** bag of slots, and
 * that is deliberate rather than lazy: the modules form reference cycles (the
 * sequence explorer and the scan module each need the other) and `viewManager` is
 * constructed last but needed by modules constructed first, so no acyclic
 * "pass the dependency to the constructor" arrangement exists. What makes it safe
 * is that every consumer reads its slot lazily, from inside a method or an event
 * handler, never at construction time.
 *
 * Bootstrap creates one instance before it builds anything and fills each slot as
 * that module comes up. Modules receive the same instance and keep it as
 * `this.ctx`.
 *
 * The standalone `viewer.html` constructs a single module with no context. It gets
 * its own empty instance, so slot reads yield `null` there — exactly what the
 * `window.*` reads used to yield on that page.
 */
export class AppContext {
    constructor() {
        /** @type {import('./niivue_app.js').NiivueModule | null} main viewer + phantom/Pyodide host */
        this.nv = null;
        /** @type {import('./pypulseq/seq_explorer.js').SequenceExplorer | null} */
        this.explorer = null;
        /** @type {import('./scan_zero/scan_module.js').ScanModule | null} */
        this.scan = null;
        /** @type {import('./niivue_app.js').ScanPreviewModule | null} preview pane (pane A) */
        this.scanPreview = null;
        /** @type {import('./niivue_app.js').ComparePane | null} compare pane (pane B); `.module` appears on activation */
        this.scanCompare = null;
        /** @type {import('./hist_panel/histogram-clim-panel.js').MainHistogramController | null} */
        this.mainHist = null;
        /** @type {import('./hist_panel/histogram-clim-panel.js').PreviewJointHistogramController | null} */
        this.jointHist = null;
        /** @type {object | null} `ViewManager` — layout/mode owner, built last by bootstrap */
        this.viewManager = null;
        /** @type {import('./py_worker_host.js').PyWorkerHost | null} off-main-thread Python */
        this.pyWorker = null;
    }
}

let published = null;

/**
 * Publish the context for entry points that load outside bootstrap's module scope.
 *
 * Only `paper_plot/` needs this. It is mounted from its own `<script type="module">`
 * tag so that a failure to load the (large, pro-only) plot code cannot take the
 * scanner down with it, which also means it never sees bootstrap's `ctx` binding.
 * Prefer constructor injection everywhere else — this is a single-writer registry,
 * not a general-purpose service locator.
 */
export function setAppContext(ctx) {
    published = ctx;
}

/** The published context, or null before bootstrap has run. */
export function getAppContext() {
    return published;
}
