/**
 * seq_check_web — upload .seq, ChartGPU waveforms + k-space, optional sim + NUFFT recon.
 * Serve from 22_niivue: python -u -m http.server 8765 → /pypulseq/seq_check_web/seq_check_wip.html
 */

import {
    clearKspaceHostCache,
    disposeSeqChartGpuHost,
    getSeqPlotMatplotlibThemePy,
    isWebGpuAvailable,
    renderSeqChartGpuAfterPlot,
    resolveSeqPlotWantsDark,
    SEQ_CHARTGPU_FALLBACK_PLOT_SPEED,
    setupSeqCheckKspacePanels,
    refreshKspaceForSeqWindow,
    getTimeWindowFromZoom,
} from '../seq_plot.js';
import { fetchSimCacheFromEvents } from './seq_check_wip_sim.js';
import { fetchPsfTrajexBundle, runConseq } from './seq_check_psf_trajex.js';
import { trajIndicesForAdcTimeWindow } from './seq_check_adc_window.js';
import { createFig6ReconController, renderFig6SimKspace } from './seq_check_fig6.js';

const GRE_EXAMPLE_SEQ_URL =
    'https://raw.githubusercontent.com/pulseq-frame/test-seqs/refs/heads/main/pypulseq/1.4.0/gre.seq';

/** Short status lines for the header (no toolapi / Pyodide jargon). */
const LOAD_STATUS = {
    backend: 'Starting backend…',
    ready: 'Ready — upload a .seq or GRE example',
    queued: 'Queued — waiting for backend',
    read: 'Reading sequence…',
    traj: 'Computing trajectories…',
    sim: 'Running simulation…',
    psf: 'Computing PSF…',
    plot: 'Drawing waveforms…',
    kspace: 'Drawing k-space…',
    gre: 'Loading GRE example…',
};
import { renderFig4Comparison, readGridMetaFromSeq, gridMetaToUiValues, parseGridMetaFromUi } from './seq_check_fig4.js';
import { initSeqCheckEmptyLayout } from './seq_check_layout.js';
import { bindPsfScaleControls, disposePsfCharts, disposePsfSignalChart, renderPsfCharts, renderPsfUnencodedSignals } from './seq_check_psf.js';
import { createSeqCheckPyClient } from './seq_check_py_client.js';

async function ensurePsfPyModule(pyClient) {
    const url = new URL('./seq_check_py_psf.py', import.meta.url);
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Failed to fetch PSF module: ${res.status}`);
    const code = await res.text();
    await pyClient.runPython(`import numpy as np\n${code}`);
}

function parseHandoffPayload(raw) {
    if (!raw) return null;
    try {
        const obj = JSON.parse(raw);
        if (typeof obj === 'string') return obj;
        if (obj?.seqText && typeof obj.seqText === 'string') return obj.seqText;
        if (obj?.base64 && typeof obj.base64 === 'string') return atob(obj.base64);
    } catch {
        /* plain text or base64 below */
    }
    try {
        const decoded = atob(raw);
        if (decoded.includes('ADC') || decoded.includes('BLOCK')) return decoded;
    } catch {
        /* ignore */
    }
    return raw;
}

export async function bootSeqCheckApp(root = document) {
    const statusEl = root.getElementById('status');
    const fileInput = root.getElementById('seq-file');
    const uploadSeqBtn = root.getElementById('btn-upload-seq');
    const greExampleBtn = root.getElementById('btn-gre-example');
    const waveformsEl = root.getElementById('seq-waveforms');
    const kspaceEl = root.getElementById('kspace-xy');
    const kspaceYzEl = root.getElementById('kspace-yz');
    const reconNiivueEl = root.getElementById('recon-niivue');
    const reconMetaEl = root.getElementById('recon-meta');
    const reconFramePrev = root.getElementById('recon-frame-prev');
    const reconFrameNext = root.getElementById('recon-frame-next');
    const reconFrameMode = root.getElementById('recon-frame-mode');
    const fig4El = root.getElementById('fig4-kspace');
    const fig6KspaceEl = root.getElementById('fig6-sim-kspace');
    const psfSignalEl = root.getElementById('psf-signal-chart');
    const psfChartsEl = root.getElementById('psf-charts');
    const psfScaleRowEl = root.getElementById('psf-scale-row');
    const psfMetaEl = root.getElementById('psf-meta');
    const chkDarkSeqPlot = root.getElementById('chkDarkSeqPlot');
    const chkRainbowAdc = root.getElementById('chkRainbowAdc');
    const chkDynamicRecon = root.getElementById('chkDynamicRecon');
    const gridFovXmm = root.getElementById('grid-fov-x-mm');
    const gridFovYmm = root.getElementById('grid-fov-y-mm');
    const gridNx = root.getElementById('grid-nx');
    const gridNy = root.getElementById('grid-ny');
    const gridFovHint = root.getElementById('grid-fov-hint');
    const gridMatrixHint = root.getElementById('grid-matrix-hint');
    const gridInputs = [gridFovXmm, gridFovYmm, gridNx, gridNy];

    /** @type {import('./seq_check_py_client.js').SeqCheckPyClient | null} */
    let pyClient = null;
    /** @type {ReturnType<import('./seq_check_py_client.js').SeqCheckPyClient['getBridge']> | null} */
    let py = null;
    let fig6Recon = null;
    /** @type {{ text: string, displayName: string } | null} */
    let pendingSeq = null;
    let processingSeq = false;

    const host = {
        _kspaceChart: null,
        _kspaceYzChart: null,
        _seqDispTimeRange: null,
        _seqZoomKspaceCleanup: null,
        _kspaceInteractionCleanup: null,
        _kspaceAxisView: null,
        _kspaceSeriesBase: null,
        _lastKspacePayload: null,
        _kspaceYzAxisView: null,
        _kspaceYzSeriesBase: null,
        _lastKspaceYzPayload: null,
        _kspaceYzInteractionCleanup: null,
        _kspaceCache: null,
        _simCache: null,
        _lastSeqText: null,
        _rainbowAdc: false,
        _seqDarkPlot: true,
        _loadGen: 0,
        _gridMeta: null,
        _gridMetaFromSeq: null,
    };

    /** @type {keyof typeof LOAD_STATUS | ''} */
    let loadStatusPhase = '';

    function setStatus(msg, isError = false) {
        if (!statusEl) return;
        statusEl.textContent = msg;
        statusEl.classList.toggle('error', isError);
    }

    function setLoadPhase(phase) {
        const msg = LOAD_STATUS[phase];
        if (!msg) return;
        loadStatusPhase = phase;
        setStatus(msg);
    }

    /** Remote/tool progress only updates status before waveform plot starts. */
    function setLoadPhaseIfEarly(phase) {
        if (loadStatusPhase === 'plot' || loadStatusPhase === 'kspace') return;
        setLoadPhase(phase);
    }

    function setSeqLoadButtonsReady(ready) {
        const enabled = ready && !processingSeq;
        if (fileInput) fileInput.disabled = !enabled;
        if (uploadSeqBtn) {
            uploadSeqBtn.classList.toggle('btn--disabled', !enabled);
            uploadSeqBtn.setAttribute('aria-disabled', enabled ? 'false' : 'true');
        }
        if (greExampleBtn) greExampleBtn.disabled = !enabled;
    }

    setSeqLoadButtonsReady(true);
    setLoadPhase('backend');
    bindPsfScaleControls(host, root);
    initSeqCheckEmptyLayout({
        waveformsEl,
        kspaceEl,
        kspaceYzEl,
        fig6KspaceEl,
        reconNiivueEl,
        fig4El,
        psfSignalEl,
        psfChartsEl,
    });

    function setGridInputsEnabled(enabled) {
        for (const el of gridInputs) {
            if (el) el.disabled = !enabled;
        }
    }

    function populateGridInputs(gridMeta) {
        if (!gridMeta) return;
        const ui = gridMetaToUiValues(gridMeta);
        if (gridFovXmm) gridFovXmm.value = ui.fovXmm;
        if (gridFovYmm) gridFovYmm.value = ui.fovYmm;
        if (gridNx) gridNx.value = ui.nx;
        if (gridNy) gridNy.value = ui.ny;
    }

    function updateGridLineHints(fromSeq) {
        if (gridFovHint) {
            if (fromSeq?.fov_source !== 'seq FOV definition') {
                gridFovHint.hidden = false;
                gridFovHint.textContent =
                    '— [FOV] not found in seq definitions; using default (256 mm) or override';
            } else {
                gridFovHint.hidden = true;
                gridFovHint.textContent = '';
            }
        }
        if (gridMatrixHint) {
            if (fromSeq?.matrix_source !== 'seq Matrix definition') {
                gridMatrixHint.hidden = false;
                gridMatrixHint.textContent =
                    '— [Matrix] not found in seq definitions; using default (256×256) or override';
            } else {
                gridMatrixHint.hidden = true;
                gridMatrixHint.textContent = '';
            }
        }
    }

    function clearGridLineHints() {
        if (gridFovHint) {
            gridFovHint.hidden = true;
            gridFovHint.textContent = '';
        }
        if (gridMatrixHint) {
            gridMatrixHint.hidden = true;
            gridMatrixHint.textContent = '';
        }
    }

    function readGridInputsUi() {
        return {
            fovXmm: gridFovXmm?.value ?? '',
            fovYmm: gridFovYmm?.value ?? '',
            nx: gridNx?.value ?? '',
            ny: gridNy?.value ?? '',
        };
    }

    async function refreshFig4() {
        if (!fig4El || !host._kspaceCache || !host._gridMeta) return;
        try {
            await renderFig4Comparison(
                host,
                fig4El,
                host._kspaceCache,
                host._simCache,
                host._gridMeta,
            );
        } catch (e) {
            console.error(e);
        }
    }

    async function refreshPsfFromGrid() {
        if (!host._psfBundle || !host._gridMeta || !py || !psfChartsEl) return;
        try {
            await renderPsfCharts(
                host,
                psfChartsEl,
                py,
                psfMetaEl,
                psfScaleRowEl,
                root,
                host._gridMeta,
            );
        } catch (e) {
            console.error(e);
        }
    }

    async function applyGridFromInputs() {
        if (!host._gridMetaFromSeq || !host._kspaceCache) return;
        const meta = parseGridMetaFromUi(host._gridMetaFromSeq, readGridInputsUi());
        if (!meta) return;
        host._gridMeta = meta;
        await refreshFig4();
        await refreshPsfFromGrid();
    }

    function bindGridMetaControls() {
        const onEdit = () => {
            void applyGridFromInputs();
        };
        for (const el of gridInputs) {
            el?.addEventListener('change', onEdit);
            el?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    onEdit();
                }
            });
        }
    }

    bindGridMetaControls();
    setGridInputsEnabled(false);

    function logKspace(label, data) {
        console.log(`[seq_check] ${label}`, data);
    }

    async function rerenderSeqWaveformsOnly() {
        if (!py || !host._lastSeqText || !waveformsEl || processingSeq) return;
        const wantsDark = resolveSeqPlotWantsDark(host, null);
        const themePy = getSeqPlotMatplotlibThemePy(wantsDark);
        const waveformPlotSpeed = isWebGpuAvailable()
            ? 'chartgpu'
            : SEQ_CHARTGPU_FALLBACK_PLOT_SPEED;
        const mplShow =
            waveformPlotSpeed === SEQ_CHARTGPU_FALLBACK_PLOT_SPEED ? '\nplt.show()' : '';
        await disposeSeqChartGpuHost(host);
        try {
            await py.runPythonAsync(`
import matplotlib.pyplot as plt
plt.close('all')
${themePy}
seq.plot(plot_now=False, plot_speed='${waveformPlotSpeed}')${mplShow}
`);
            if (waveformPlotSpeed === 'chartgpu') {
                await renderSeqChartGpuAfterPlot(host, null, py, waveformsEl);
            }
        } catch (e) {
            console.error(e);
            waveformsEl.innerHTML = `<div class="seq-chartgpu-fallback error">${e?.message || e}</div>`;
        }
    }

    chkDarkSeqPlot?.addEventListener('change', () => {
        host._seqDarkPlot = !!chkDarkSeqPlot.checked;
        void rerenderSeqWaveformsOnly();
    });

    chkRainbowAdc?.addEventListener('change', () => {
        host._rainbowAdc = !!chkRainbowAdc.checked;
        if (host._kspaceCache && host._seqDispTimeRange) {
            void refreshKspaceForSeqWindow(host);
        }
    });

    function isDynamicRecon() {
        return !!chkDynamicRecon?.checked;
    }

    function refreshNiivueLayout() {
        requestAnimationFrame(() => {
            fig6Recon?.niivue?.nv?.resize?.();
            fig6Recon?.niivue?.nv?.drawScene?.();
        });
    }

    chkDynamicRecon?.addEventListener('change', () => {
        if (!isDynamicRecon() || !host._simCache || !host._seqDispTimeRange) return;
        const win = getFig6TimeWindow();
        if (win) void refreshFig6Dynamic(win);
    });

    /** Waveform zoom window, or full sequence display range. */
    function getFig6TimeWindow() {
        const z = getTimeWindowFromZoom(host);
        if (z) return z;
        const dr = host._seqDispTimeRange;
        if (dr?.length >= 2) return { tLo: dr[0], tHi: dr[1] };
        return null;
    }

    async function initPythonWorker() {
        pyClient = await createSeqCheckPyClient({
            onLog: (msg) => {
                if (processingSeq || pendingSeq || !msg) return;
                if (/pyodide|installing|loading/i.test(msg)) setLoadPhase('backend');
            },
        });
        py = pyClient.getBridge();
        await ensurePsfPyModule(pyClient);
        fig6Recon = createFig6ReconController({
            pyodide: py,
            pyClient,
            niivueContainer: reconNiivueEl,
            metaEl: reconMetaEl,
            reconNav: {
                prevBtn: reconFramePrev,
                nextBtn: reconFrameNext,
                modeEl: reconFrameMode,
            },
        });
    }

    async function flushPendingSeq() {
        if (!pendingSeq?.text?.trim() || !pyClient?.ready || !py) return;
        const { text, displayName } = pendingSeq;
        pendingSeq = null;
        await processSeqText(text, displayName);
    }

    async function queueOrProcessSeqText(seqText, displayName = 'upload.seq') {
        if (!seqText?.trim()) return;
        if (pyClient?.ready && py) {
            await processSeqText(seqText, displayName);
            return;
        }
        pendingSeq = { text: seqText, displayName };
        setLoadPhase('queued');
    }

    function isPyStaleError(e) {
        return e?.message === 'Stale Pyodide request';
    }

    async function installPsfBundleInPyodide(bundle) {
        if (!pyClient) return;
        await pyClient.globalsSet('_psf_kspace_json', JSON.stringify(bundle.kspace));
        await pyClient.globalsSet('_psf_tissues_json', JSON.stringify(bundle.tissues));
        const info = await py.runPythonAsync(
            'set_psf_bundle_py(_psf_kspace_json, _psf_tissues_json)',
        );
        logKspace('PSF trajex bundle', JSON.parse(String(info)));
    }

    async function installSimCacheInPyodide(sim) {
        if (!pyClient) return;
        await pyClient.globalsSet('_wip_traj_json', JSON.stringify(sim.traj));
        await pyClient.globalsSet('_wip_sig_json', JSON.stringify(sim.signal));
        const kc = host._kspaceCache;
        await pyClient.globalsSet(
            '_wip_kspace_adc_json',
            kc
                ? JSON.stringify({
                      t_adc: kc.t_adc ?? [],
                      kx_adc: kc.kx_adc ?? [],
                      ky_adc: kc.ky_adc ?? [],
                  })
                : '',
        );
        const raw = await py.runPythonAsync(
            'set_sim_cache_py(_wip_traj_json, _wip_sig_json, _wip_kspace_adc_json)',
        );
        const info = JSON.parse(String(raw));
        logKspace('sim cache in Pyodide', info);
    }

    /** Sim + Pyodide recon need pypulseq t_adc / kx_adc from _kspaceCache. */
    async function syncSimCacheAfterKspace(gen) {
        if (!isLoadCurrent(gen) || !host._simCache || !host._kspaceCache?.t_adc?.length) {
            return;
        }
        await installSimCacheInPyodide(host._simCache);
        await tryRefreshFig6(gen);
        await tryRenderFig4(gen);
    }

    function isLoadCurrent(gen) {
        return gen === host._loadGen;
    }

    function fig6RowIndicesForWindow(tLo, tHi) {
        return trajIndicesForAdcTimeWindow(host._simCache, host._kspaceCache, { tLo, tHi });
    }

    async function refreshFig6Recon(tLo, tHi) {
        if (!fig6Recon) return;
        const rowIdx = fig6RowIndicesForWindow(tLo, tHi);
        if (!rowIdx?.length) {
            const msg = 'NUFFT: no ADC samples in time window';
            if (reconMetaEl) {
                reconMetaEl.hidden = false;
                reconMetaEl.textContent = msg;
            }
            if (reconNiivueEl) {
                reconNiivueEl.innerHTML = `<div class="seq-chartgpu-fallback">${msg}</div>`;
            }
            return;
        }
        if (reconMetaEl) {
            reconMetaEl.hidden = true;
            reconMetaEl.textContent = '';
        }
        await fig6Recon.refresh({ tLo, tHi, rowIndices: rowIdx });
    }

    /** Fig 6 k-space + Niivue recon for current waveform zoom (only when Dynamic recon is on). */
    async function refreshFig6Dynamic({ tLo, tHi }) {
        if (!host._simCache) return;
        const win = { tLo, tHi };
        if (fig6KspaceEl) {
            await renderFig6SimKspace(host, fig6KspaceEl, host._simCache, host._kspaceCache, win);
        }
        if (isDynamicRecon()) {
            await refreshFig6Recon(tLo, tHi);
        }
    }

    /** Fig 6 k-space + NUFFT for a time window (initial load always runs recon). */
    async function refreshFig6Initial({ tLo, tHi }) {
        if (!host._simCache) return;
        const win = { tLo, tHi };
        if (fig6KspaceEl) {
            await renderFig6SimKspace(host, fig6KspaceEl, host._simCache, host._kspaceCache, win);
        }
        await refreshFig6Recon(tLo, tHi);
    }

    async function tryRenderFig4(gen) {
        if (!isLoadCurrent(gen) || !fig4El || !host._kspaceCache || !host._gridMeta) {
            return;
        }
        await refreshFig4();
    }

    async function tryRefreshFig6(gen) {
        if (!isLoadCurrent(gen) || !host._simCache || !host._seqDispTimeRange || !fig6Recon) return;
        const win = getFig6TimeWindow();
        if (!win) return;
        await refreshFig6Initial(win);
    }

    async function processSeqText(seqText, displayName = 'upload.seq') {
        if (!pyClient?.ready || !py || !seqText?.trim()) return;

        processingSeq = true;
        host._lastSeqText = seqText;
        host._loadGen = pyClient.bumpGeneration();
        const gen = host._loadGen;
        host._gridMeta = null;
        host._gridMetaFromSeq = null;
        setGridInputsEnabled(false);
        if (gridFovXmm) gridFovXmm.value = '';
        if (gridFovYmm) gridFovYmm.value = '';
        if (gridNx) gridNx.value = '';
        if (gridNy) gridNy.value = '';
        clearGridLineHints();
        setSeqLoadButtonsReady(false);
        setLoadPhase('read');
        try {
            await py.runPythonAsync('_psf_bundle_py = None');
        } catch (e) {
            if (!isPyStaleError(e)) {
                /* psf module may not be loaded yet */
            }
        }
        host._rainbowAdc = !!chkRainbowAdc?.checked;
        host._seqDarkPlot = chkDarkSeqPlot ? !!chkDarkSeqPlot.checked : true;
        if (host._seqZoomKspaceCleanup) {
            try {
                host._seqZoomKspaceCleanup();
            } catch {
                /* ignore */
            }
            host._seqZoomKspaceCleanup = null;
        }
        await disposeSeqChartGpuHost(host);
        disposePsfSignalChart(host);
        disposePsfCharts(host);
        initSeqCheckEmptyLayout(
            {
                waveformsEl,
                kspaceEl,
                kspaceYzEl,
                fig6KspaceEl,
                reconNiivueEl,
                fig4El,
                psfSignalEl,
                psfChartsEl,
            },
            { resetRecon: false },
        );
        if (psfMetaEl) {
            psfMetaEl.hidden = true;
            psfMetaEl.textContent = '';
        }
        if (reconMetaEl) {
            reconMetaEl.hidden = true;
            reconMetaEl.textContent = '';
        }
        clearKspaceHostCache(host);
        host._simCache = null;

        const vfsPath = '/upload.seq';
        await pyClient.fsWrite(vfsPath, seqText);

        setLoadPhaseIfEarly('traj');
        const conseqPromise = runConseq(seqText, () => {});

        const simPromise = conseqPromise
            .then((events) => {
                if (isLoadCurrent(gen)) setLoadPhaseIfEarly('sim');
                return fetchSimCacheFromEvents(events, () => {});
            })
            .then((sim) => {
                if (!isLoadCurrent(gen)) return;
                host._simCache = sim;
            })
            .catch((e) => {
                if (!isLoadCurrent(gen) || isPyStaleError(e)) return;
                console.error(e);
                if (reconMetaEl) {
                    reconMetaEl.hidden = false;
                    reconMetaEl.textContent = `Sim failed: ${e?.message || e}`;
                }
            });

        try {
            const seqReadyPromise = py.runPythonAsync(`
import pypulseq as pp
seq = pp.Sequence()
seq.read('${vfsPath}')
`);

            const gridMetaPromise = seqReadyPromise.then(async () => {
                const gridMeta = await readGridMetaFromSeq(py);
                if (!isLoadCurrent(gen)) return null;
                host._gridMetaFromSeq = { ...gridMeta };
                host._gridMeta = { ...gridMeta };
                populateGridInputs(gridMeta);
                updateGridLineHints(gridMeta);
                setGridInputsEnabled(true);
                return gridMeta;
            });

            const kspacePromise = seqReadyPromise.then(async () => {
                await py.runPythonAsync('ensure_kspace_cache(seq)');
                const cacheJson = await py.runPythonAsync(
                    'import json; export_kspace_cache_json()',
                );
                if (!isLoadCurrent(gen)) return;
                host._kspaceCache = JSON.parse(String(cacheJson));
                if (host._kspaceCache?.error) {
                    throw new Error(host._kspaceCache.error);
                }
                logKspace('k-space cache', host._kspaceCache.meta);
            });

            // PSF + sim + k-space run while ChartGPU seq.plot / waveform render is in flight.
            const psfPromise = Promise.all([conseqPromise, gridMetaPromise])
                .then(async ([events, gridMeta]) => {
                    if (!gridMeta || !isLoadCurrent(gen)) return null;
                    if (isLoadCurrent(gen)) setLoadPhaseIfEarly('psf');
                    return fetchPsfTrajexBundle(
                        seqText,
                        {
                            fov: [gridMeta.fov_x, gridMeta.fov_y, gridMeta.fov_z ?? 0.005],
                            res: [gridMeta.Nx, gridMeta.Ny, gridMeta.Nz ?? 1],
                        },
                        () => {},
                        events,
                    );
                })
                .then(async (bundle) => {
                    if (!bundle || !isLoadCurrent(gen)) return;
                    host._psfBundle = bundle;
                    if (psfSignalEl) {
                        await renderPsfUnencodedSignals(host, psfSignalEl, bundle);
                    }
                    await installPsfBundleInPyodide(bundle);
                    if (psfChartsEl) {
                        await renderPsfCharts(
                            host,
                            psfChartsEl,
                            py,
                            psfMetaEl,
                            psfScaleRowEl,
                            root,
                            host._gridMeta,
                        );
                    }
                })
                .catch((e) => {
                    if (!isLoadCurrent(gen) || isPyStaleError(e)) return;
                    console.error(e);
                    host._psfBundle = null;
                    disposePsfSignalChart(host);
                    if (psfSignalEl) {
                        psfSignalEl.innerHTML = `<div class="seq-chartgpu-fallback">PSF trajex failed: ${e?.message || e}</div>`;
                        psfSignalEl.parentElement?.querySelector('.psf-signal-legend')?.remove();
                    }
                    if (psfMetaEl) {
                        psfMetaEl.hidden = false;
                        psfMetaEl.textContent = `PSF trajex failed: ${e?.message || e}`;
                    }
                });

            const waveformPromise = seqReadyPromise.then(async () => {
                if (!isLoadCurrent(gen)) return;
                setLoadPhase('plot');
                const waveformPlotSpeed = isWebGpuAvailable()
                    ? 'chartgpu'
                    : SEQ_CHARTGPU_FALLBACK_PLOT_SPEED;
                const mplShow =
                    waveformPlotSpeed === SEQ_CHARTGPU_FALLBACK_PLOT_SPEED ? '\nplt.show()' : '';
                const themePy = getSeqPlotMatplotlibThemePy(resolveSeqPlotWantsDark(host, null));
                await py.runPythonAsync(`
import matplotlib.pyplot as plt
plt.close('all')
${themePy}
seq.plot(plot_now=False, plot_speed='${waveformPlotSpeed}')${mplShow}
`);
                if (!isLoadCurrent(gen)) return;
                if (waveformPlotSpeed === 'chartgpu') {
                    await renderSeqChartGpuAfterPlot(host, null, py, waveformsEl);
                }
            });

            await Promise.all([waveformPromise, kspacePromise]);
            if (!isLoadCurrent(gen)) return;

            if (!host._seqDispTimeRange && host._kspaceCache?.meta?.disp_range_s) {
                host._seqDispTimeRange = host._kspaceCache.meta.disp_range_s;
            }

            setLoadPhase('kspace');
            await setupSeqCheckKspacePanels(host, py, kspaceEl, kspaceYzEl, {
                onAfterWindowRefresh: async ({ tLo, tHi }) => {
                    await refreshFig6Dynamic({ tLo, tHi });
                },
            });

            await Promise.allSettled([simPromise, psfPromise, gridMetaPromise]);
            await tryRenderFig4(gen);
            if (isLoadCurrent(gen)) {
                await syncSimCacheAfterKspace(gen);
                await tryRefreshFig6(gen);
                refreshNiivueLayout();
                loadStatusPhase = '';
                setStatus(`Done — ${displayName}`);
            }
        } catch (e) {
            if (isPyStaleError(e) || !isLoadCurrent(gen)) return;
            console.error(e);
            loadStatusPhase = '';
            setStatus(`Failed — ${e?.message || e}`, true);
            if (waveformsEl) {
                waveformsEl.innerHTML = `<div class="seq-chartgpu-fallback error">${e?.message || e}</div>`;
            }
        } finally {
            processingSeq = false;
            setSeqLoadButtonsReady(!!pyClient?.ready);
        }
    }

    async function processSeqFile(file) {
        if (!file) return;
        const buf = await file.arrayBuffer();
        const seqText = new TextDecoder().decode(new Uint8Array(buf));
        await queueOrProcessSeqText(seqText, file.name);
    }

    fileInput?.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (file) void processSeqFile(file);
        fileInput.value = '';
    });

    greExampleBtn?.addEventListener('click', async () => {
        if (processingSeq) return;
        setLoadPhase('gre');
        try {
            const res = await fetch(GRE_EXAMPLE_SEQ_URL);
            if (!res.ok) {
                throw new Error(`HTTP ${res.status} ${res.statusText}`);
            }
            const seqText = await res.text();
            await queueOrProcessSeqText(seqText, 'gre.seq');
        } catch (e) {
            console.error(e);
            setStatus(`GRE failed — ${e?.message || e}`, true);
        }
    });

    void (async () => {
        try {
            await initPythonWorker();
            if (!pendingSeq) {
                setLoadPhase('ready');
            }
            await flushPendingSeq();
        } catch (e) {
            console.error(e);
            pendingSeq = null;
            setSeqLoadButtonsReady(false);
            loadStatusPhase = '';
            setStatus(`Backend failed — ${e?.message || e}`, true);
        }
    })();

    const seqId = new URLSearchParams(window.location.search).get('seqId');
    if (seqId) {
        const raw = localStorage.getItem(`seq_handoff:${seqId}`);
        const seqText = parseHandoffPayload(raw);
        if (seqText?.trim()) {
            void queueOrProcessSeqText(seqText, `handoff:${seqId}`);
        }
    }

    return {
        host,
        pyClient: () => pyClient,
        py: () => py,
        processSeqFile,
        processSeqText,
        queueOrProcessSeqText,
    };
}
