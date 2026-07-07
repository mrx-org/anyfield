/**
 * Fig 7 — PSF line profiles (Pyodide NUFFT + ChartGPU).
 */

import {
    attachChartGpuPlaneInteraction,
    CHARTGPU_MODULE_URL,
    disposeKspaceKySlot,
    KSPACE_GRID,
    normalizeChartGpuSeries,
    planeViewFromChartOptions,
    seqChartGpuLabTheme,
} from '../seq_plot.js';
import { PSF_TISSUES } from './seq_check_psf_trajex.js';
import { gridMetaToPsfGridJson } from './seq_check_fig4.js';

const TISSUE_COLOR_BY_NAME = {
    Fat: '#808080',
    'Gray Matter': '#00e5ff',
    'White Matter': '#ffb300',
    CSF: '#ea80fc',
};
const TISSUE_PLOT_ORDER = ['Fat', 'Gray Matter', 'White Matter', 'CSF'];
const PSF_TISSUE_LINE_WIDTH = 4;
const PSF_SIGNAL_LINE_WIDTH = 3.5;
const PSF_TISSUE_LINE_OPACITY = 0.7;
const IDEAL_COLOR = '#f5f7ff';

function tissueColor(name) {
    return TISSUE_COLOR_BY_NAME[name] ?? '#ffffff';
}

function sortTissuesByPlotOrder(items) {
    const rank = new Map(TISSUE_PLOT_ORDER.map((name, i) => [name, i]));
    return [...items].sort(
        (a, b) => (rank.get(a.name) ?? 99) - (rank.get(b.name) ?? 99),
    );
}

function lineSeries(x, y, color, name, width = 2, opacity = PSF_TISSUE_LINE_OPACITY) {
    return {
        type: 'line',
        name,
        data: xyPairs(x, y),
        color,
        lineStyle: { color, width, opacity },
        sampling: 'none',
        visible: true,
    };
}

/** Extra bottom margin for x-axis label on PSF panels. */
const PSF_GRID = { ...KSPACE_GRID, bottom: 44 };

function decodeF32(b64) {
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

function xyPairs(x, y) {
    const n = Math.min(x.length, y.length);
    const pts = [];
    for (let i = 0; i < n; i++) {
        const xv = x[i];
        const yv = y[i];
        if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue;
        pts.push([xv, yv]);
    }
    return pts;
}

function applyPsfSeriesStyle(series, rawSeries) {
    for (let i = 0; i < series.length; i++) {
        const src = rawSeries[i];
        if (src.color) series[i].color = src.color;
        const opacity = src.name === 'Ideal |sinc|' ? 1 : PSF_TISSUE_LINE_OPACITY;
        series[i].lineStyle = { ...(src.lineStyle || {}), color: src.color, opacity };
        series[i].sampling = 'none';
    }
}

function ymaxInXWindow(x, seriesList, xLo, xHi) {
    let ymax = 0;
    for (const y of seriesList) {
        const n = Math.min(x.length, y.length);
        for (let i = 0; i < n; i++) {
            const xv = x[i];
            const yv = y[i];
            if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue;
            if (xv < xLo || xv > xHi) continue;
            if (yv > ymax) ymax = yv;
        }
    }
    return ymax > 0 ? ymax * 1.1 : 1;
}

function normByMax(y) {
    let peak = 0;
    for (let i = 0; i < y.length; i++) {
        const v = y[i];
        if (Number.isFinite(v) && v > peak) peak = v;
    }
    if (peak <= 0) return y;
    const out = new Float32Array(y.length);
    for (let i = 0; i < y.length; i++) out[i] = y[i] / peak;
    return out;
}

function profileY(tissue, normalized) {
    if (normalized) {
        return tissue.yNormB64
            ? decodeF32(tissue.yNormB64)
            : normByMax(decodeF32(tissue.yB64));
    }
    return decodeF32(tissue.yB64);
}

function idealY(panel, normalized) {
    if (normalized) {
        return panel.idealNormB64
            ? decodeF32(panel.idealNormB64)
            : normByMax(decodeF32(panel.idealB64));
    }
    return decodeF32(panel.idealB64);
}

function psfYAxisName(normalized) {
    return normalized ? '|PSF| / max' : '|PSF|';
}

export function getPsfScaleMode(root) {
    const checked = root?.querySelector('input[name="psfScale"]:checked');
    return checked?.value === 'absolute' ? 'absolute' : 'normalized';
}

export function bindPsfScaleControls(host, root) {
    if (host._psfScaleBound || !root) return;
    host._psfScaleBound = true;
    for (const inp of root.querySelectorAll('input[name="psfScale"]')) {
        inp.addEventListener('change', () => {
            if (!inp.checked) return;
            host._psfScaleMode = inp.value === 'absolute' ? 'absolute' : 'normalized';
            applyPsfScaleToCharts(host);
        });
    }
}

function buildPsfSeries(panel, scaleMode) {
    const normalized = scaleMode !== 'absolute';
    const x = decodeF32(panel.xMmB64);
    const ideal = idealY(panel, normalized);
    const tissueYs = panel.tissues.map((t) => profileY(t, normalized));

    const tissueEntries = panel.tissues.map((t, i) => ({
        name: t.name,
        y: tissueYs[i],
    }));
    const rawSeries = [lineSeries(x, ideal, IDEAL_COLOR, 'Ideal |sinc|', 2.25, 1)];
    for (const t of sortTissuesByPlotOrder(tissueEntries)) {
        rawSeries.push(
            lineSeries(x, t.y, tissueColor(t.name), t.name, PSF_TISSUE_LINE_WIDTH),
        );
    }
    const series = normalizeChartGpuSeries(rawSeries);
    applyPsfSeriesStyle(series, rawSeries);
    return { x, ideal, tissueYs, series, normalized };
}

function ymaxForSeries(seriesIn) {
    let ymax = 0;
    for (const s of seriesIn) {
        const d = s.data;
        if (ArrayBuffer.isView(d)) {
            for (let i = 1; i < d.length; i += 2) {
                const v = d[i];
                if (Number.isFinite(v) && v > ymax) ymax = v;
            }
        } else if (Array.isArray(d)) {
            for (const p of d) {
                if (p == null) continue;
                const v = Array.isArray(p) ? p[1] : p.y;
                if (Number.isFinite(v) && v > ymax) ymax = v;
            }
        }
    }
    return ymax > 0 ? ymax * 1.08 : 1;
}

function chartGpuCtx(host) {
    return host._seqChartGpuDevice && host._seqChartGpuAdapter
        ? { adapter: host._seqChartGpuAdapter, device: host._seqChartGpuDevice }
        : undefined;
}

function applyPsfChartView(chart, view, series, axisName, normalized = false) {
    if (!chart || chart.disposed || !view) return;
    const prev = chart.options && typeof chart.options === 'object' ? chart.options : {};
    try {
        chart.setOption({
            ...prev,
            animation: false,
            legend: prev.legend ?? { show: false },
            grid: PSF_GRID,
            tooltip: prev.tooltip ?? { show: true },
            xAxis: {
                ...(prev.xAxis || {}),
                name: `${axisName} [mm]`,
                min: view.xMin,
                max: view.xMax,
            },
            yAxis: {
                ...(prev.yAxis || {}),
                name: psfYAxisName(normalized),
                min: view.yMin,
                max: view.yMax,
            },
            series,
        });
        if (typeof chart.resize === 'function') chart.resize();
    } catch (e) {
        console.warn('PSF chart setOption:', e);
    }
}

/** ADC index with kx–ky closest to origin (shared k-space from PSF trajex bundle). */
function adcIndexClosestToKOrigin(kspace) {
    if (!kspace?.length) return null;
    let bestIdx = null;
    let bestDist = Infinity;
    for (let i = 0; i < kspace.length; i++) {
        const kx = kspace[i][0];
        const ky = kspace[i][1];
        if (!Number.isFinite(kx) || !Number.isFinite(ky)) continue;
        const d = kx * kx + ky * ky;
        if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
        }
    }
    return bestIdx;
}

function buildK0MarkerAnnotations(adcIndex) {
    if (adcIndex == null || !Number.isFinite(adcIndex)) return [];
    return [
        {
            id: '__psfK0Marker__',
            type: 'lineX',
            x: adcIndex,
            layer: 'aboveSeries',
            style: { color: 'rgba(255, 255, 255, 0.55)', lineWidth: 1.5, lineDash: [4, 4] },
        },
    ];
}

function applyPsfSignalChartView(chart, view, series, annotations = []) {
    if (!chart || chart.disposed || !view) return;
    const prev = chart.options && typeof chart.options === 'object' ? chart.options : {};
    try {
        chart.setOption({
            ...prev,
            animation: false,
            legend: prev.legend ?? { show: false },
            grid: PSF_SIGNAL_GRID,
            tooltip: prev.tooltip ?? { show: true },
            xAxis: {
                ...(prev.xAxis || {}),
                name: 'index',
                min: view.xMin,
                max: view.xMax,
            },
            yAxis: {
                ...(prev.yAxis || {}),
                name: '|signal|',
                min: view.yMin,
                max: view.yMax,
            },
            annotations,
            series,
        });
        if (typeof chart.resize === 'function') chart.resize();
    } catch (e) {
        console.warn('PSF signal chart setOption:', e);
    }
}

function attachPsfSignalChartInteraction(host, mountEl, chart, series, initialView, k0AdcIndex) {
    const slot = 'psf-signal';
    if (!host._kspaceKySlots) host._kspaceKySlots = {};
    const box = host._kspaceKySlots[slot] || (host._kspaceKySlots[slot] = {});
    if (box.cleanup) {
        try {
            box.cleanup();
        } catch {
            /* ignore */
        }
        box.cleanup = null;
    }
    box.chart = chart;
    box.seriesBase = series;
    box.axisView = initialView;
    box.k0Annotations = buildK0MarkerAnnotations(k0AdcIndex);
    box.cleanup = attachChartGpuPlaneInteraction(
        mountEl,
        chart,
        {
            isChartOk: () => chart && !chart.disposed,
            getView: () => box.axisView,
            setView: (v) => {
                box.axisView = v;
            },
            ensureView: () => {
                if (!box.axisView) {
                    box.axisView = planeViewFromChartOptions(chart) || initialView;
                }
                return box.axisView;
            },
            applyView: (c, v) =>
                applyPsfSignalChartView(c, v, box.seriesBase, box.k0Annotations),
        },
        PSF_SIGNAL_GRID,
        { xOnly: true },
    );
}

function attachPsfChartInteraction(host, mountEl, chart, slot, series, axisName, initialView) {
    if (!host._kspaceKySlots) host._kspaceKySlots = {};
    const box = host._kspaceKySlots[slot] || (host._kspaceKySlots[slot] = {});
    if (box.cleanup) {
        try {
            box.cleanup();
        } catch {
            /* ignore */
        }
        box.cleanup = null;
    }
    box.chart = chart;
    box.seriesBase = series;
    box.axisView = initialView;
    box.cleanup = attachChartGpuPlaneInteraction(
        mountEl,
        chart,
        {
            isChartOk: () => chart && !chart.disposed,
            getView: () => box.axisView,
            setView: (v) => {
                box.axisView = v;
            },
            ensureView: () => {
                if (!box.axisView) {
                    box.axisView = planeViewFromChartOptions(chart) || initialView;
                }
                return box.axisView;
            },
            applyView: (c, v) =>
                applyPsfChartView(c, v, box.seriesBase, axisName, box.psfNormalized),
        },
        PSF_GRID,
        { xOnly: true },
    );
}

function viewForPsfPanel(x, ideal, tissueYs, series, zoomXlimMm, normalized) {
    const yMax = ymaxInXWindow(x, [ideal, ...tissueYs], -zoomXlimMm, zoomXlimMm);
    const yMaxFallback = ymaxForSeries(series);
    let yHi = yMax > 0 ? yMax : yMaxFallback;
    if (normalized) yHi = 1.08;
    return {
        xMin: -zoomXlimMm,
        xMax: zoomXlimMm,
        yMin: 0,
        yMax: yHi > 0 ? yHi : 1,
    };
}

function applyPsfScaleToCharts(host) {
    const jobs = host._psfPanelJobs;
    const zoomXlimMm = host._psfZoomXlimMm;
    if (!jobs?.length || zoomXlimMm == null) return;
    const scaleMode = host._psfScaleMode || 'normalized';
    for (const job of jobs) {
        const { chart, panel, axis, mountEl } = job;
        if (!chart || chart.disposed) continue;
        const { x, ideal, tissueYs, series, normalized } = buildPsfSeries(panel, scaleMode);
        const view = viewForPsfPanel(x, ideal, tissueYs, series, zoomXlimMm, normalized);
        const slot = `psf-${axis.toLowerCase()}`;
        const box = host._kspaceKySlots?.[slot];
        if (box) {
            box.seriesBase = series;
            box.axisView = view;
            box.psfNormalized = normalized;
        }
        applyPsfChartView(chart, view, series, axis, normalized);
    }
}

async function renderPsfPanel(host, mountEl, panel, zoomXlimMm, scaleMode) {
    const { x, ideal, tissueYs, series, normalized } = buildPsfSeries(panel, scaleMode);
    const initialView = viewForPsfPanel(x, ideal, tissueYs, series, zoomXlimMm, normalized);

    const mod = await import(/* @vite-ignore */ CHARTGPU_MODULE_URL);
    const ChartGPU = mod.ChartGPU;
    const theme = seqChartGpuLabTheme(mod.darkTheme, 10);
    const slot = `psf-${panel.axis.toLowerCase()}`;
    disposeKspaceKySlot(host, slot);
    mountEl.innerHTML = '';

    const chart = await ChartGPU.create(
        mountEl,
        {
            theme,
            animation: false,
            legend: { show: false },
            grid: PSF_GRID,
            xAxis: {
                name: `${panel.axis} [mm]`,
                min: initialView.xMin,
                max: initialView.xMax,
            },
            yAxis: {
                name: psfYAxisName(normalized),
                min: initialView.yMin,
                max: initialView.yMax,
            },
            tooltip: { show: true },
            series,
        },
        chartGpuCtx(host),
    );
    const box = host._kspaceKySlots?.[slot];
    if (box) box.psfNormalized = normalized;
    attachPsfChartInteraction(host, mountEl, chart, slot, series, panel.axis, initialView);
    return chart;
}

export function appendPsfLegend(containerEl) {
    const leg = document.createElement('div');
    leg.className = 'psf-legend';
    const items = [
        { color: IDEAL_COLOR, label: 'Ideal |sinc|' },
        ...PSF_TISSUES.map((t) => ({
            color: tissueColor(t.name),
            label: t.name,
        })),
    ];
    for (const { color, label } of items) {
        const span = document.createElement('span');
        span.className = 'psf-legend-item';
        span.innerHTML = `<i style="background:${color}"></i>${label}`;
        leg.appendChild(span);
    }
    containerEl.appendChild(leg);
}

const PSF_SIGNAL_GRID = { ...KSPACE_GRID, bottom: 44 };

/** Match set_psf_bundle_py: complex trajex signal × exp(−|τ|/T2′), magnitude. */
function buildPsfInputMagnitudes(bundle) {
    const kspace = bundle?.kspace;
    if (!kspace?.length || !bundle?.tissues?.length) return null;

    const tissues = [];
    for (let ti = 0; ti < bundle.tissues.length; ti++) {
        const tissue = bundle.tissues[ti];
        const t2d = Number(tissue.T2dash);
        if (!(t2d > 0)) continue;
        const adcIdx = [];
        const mags = [];
        const n = Math.min(kspace.length, tissue.signal?.length ?? 0);
        for (let i = 0; i < n; i++) {
            const tau = kspace[i][3];
            const re = tissue.signal[i][0];
            const im = tissue.signal[i][1];
            if (!Number.isFinite(re) || !Number.isFinite(im)) continue;
            const tauVal = Number.isFinite(tau) ? tau : 0;
            adcIdx.push(i);
            mags.push(Math.hypot(re, im) * Math.exp(-Math.abs(tauVal) / t2d));
        }
        if (adcIdx.length) {
            tissues.push({ name: tissue.name, adcIdx, mags, nSamples: n });
        }
    }
    return tissues.length ? tissues : null;
}

function buildUnencodedSignalSeries(bundle) {
    const tissues = buildPsfInputMagnitudes(bundle);
    if (!tissues) return null;

    const rawSeries = sortTissuesByPlotOrder(tissues).map((t) =>
        lineSeries(t.adcIdx, t.mags, tissueColor(t.name), t.name, PSF_SIGNAL_LINE_WIDTH),
    );
    const series = normalizeChartGpuSeries(rawSeries);
    applyPsfSeriesStyle(series, rawSeries);
    return { series, tissues };
}

function appendPsfSignalLegend(containerEl) {
    const leg = document.createElement('div');
    leg.className = 'psf-legend';
    for (let i = 0; i < PSF_TISSUES.length; i++) {
        const span = document.createElement('span');
        span.className = 'psf-legend-item';
        const label = PSF_TISSUES[i].name;
        const color = tissueColor(label);
        span.innerHTML = `<i style="background:${color}"></i>${label}`;
        leg.appendChild(span);
    }
    containerEl.appendChild(leg);
}

function viewForUnencodedSignals(tissues, series) {
    let nSamples = 0;
    let yMax = 0;
    for (const t of tissues) {
        nSamples = Math.max(nSamples, t.nSamples ?? 0);
        for (let i = 0; i < t.adcIdx.length; i++) {
            const y = t.mags[i];
            if (Number.isFinite(y) && y > yMax) yMax = y;
        }
    }
    const xMax = nSamples > 0 ? nSamples - 1 : 1;
    const yHi = ymaxForSeries(series);
    return {
        xMin: 0,
        xMax,
        yMin: 0,
        yMax: yHi > 0 ? yHi : 1,
    };
}

export function disposePsfSignalChart(host) {
    if (host._psfSignalChart) {
        try {
            host._psfSignalChart.dispose();
        } catch {
            /* ignore */
        }
        host._psfSignalChart = null;
    }
    disposeKspaceKySlot(host, 'psf-signal');
    host._psfSignalTissues = null;
}

export async function renderPsfUnencodedSignals(host, containerEl, bundle) {
    if (!containerEl) return;
    disposePsfSignalChart(host);
    containerEl.innerHTML = '';

    if (!bundle) {
        containerEl.innerHTML = '<div class="seq-chartgpu-fallback">Unencoded signals appear after PSF trajex finishes.</div>';
        return;
    }

    const built = buildUnencodedSignalSeries(bundle);
    if (!built) {
        containerEl.innerHTML = '<div class="seq-chartgpu-fallback">No PSF signal samples.</div>';
        return;
    }

    if (!navigator.gpu) {
        containerEl.innerHTML = '<div class="seq-chartgpu-fallback">WebGPU required for signal chart.</div>';
        return;
    }

    const { series, tissues } = built;
    const view = viewForUnencodedSignals(tissues, series);
    const k0AdcIndex = adcIndexClosestToKOrigin(bundle.kspace);
    const k0Annotations = buildK0MarkerAnnotations(k0AdcIndex);

    const mod = await import(/* @vite-ignore */ CHARTGPU_MODULE_URL);
    const ChartGPU = mod.ChartGPU;
    const theme = seqChartGpuLabTheme(mod.darkTheme, 10);
    disposeKspaceKySlot(host, 'psf-signal');

    const chart = await ChartGPU.create(
        containerEl,
        {
            theme,
            animation: false,
            legend: { show: false },
            grid: PSF_SIGNAL_GRID,
            xAxis: {
                name: 'index',
                min: view.xMin,
                max: view.xMax,
            },
            yAxis: {
                name: '|signal|',
                min: view.yMin,
                max: view.yMax,
            },
            tooltip: { show: true },
            annotations: k0Annotations,
            series,
        },
        chartGpuCtx(host),
    );

    host._psfSignalChart = chart;
    host._psfSignalTissues = tissues;
    attachPsfSignalChartInteraction(host, containerEl, chart, series, view, k0AdcIndex);

    const parent = containerEl.parentElement;
    parent?.querySelector('.psf-signal-legend')?.remove();
    if (parent) {
        const legWrap = document.createElement('div');
        legWrap.className = 'psf-signal-legend';
        appendPsfSignalLegend(legWrap);
        parent.appendChild(legWrap);
    }

    await refreshPsfChartLayouts([chart]);
}

async function refreshPsfChartLayouts(charts) {
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    for (const chart of charts) {
        try {
            if (chart && typeof chart.resize === 'function') chart.resize();
        } catch {
            /* ignore */
        }
    }
}

/**
 * @param {*} host
 * @param {HTMLElement} containerEl
 * @param {import('pyodide').PyodideInterface} pyodide
 * @param {HTMLElement | null} metaEl
 * @param {HTMLElement | null} scaleRowEl
 * @param {Document | ShadowRoot} root
 */
export function disposePsfCharts(host) {
    if (host._psfCharts?.length) {
        for (const c of host._psfCharts) {
            try {
                c.dispose();
            } catch {
                /* ignore */
            }
        }
    }
    host._psfCharts = [];
    host._psfPanelJobs = [];
    for (const ax of ['x', 'y', 'z']) {
        disposeKspaceKySlot(host, `psf-${ax}`);
    }
}

export async function renderPsfCharts(host, containerEl, pyodide, metaEl, scaleRowEl, root, gridMeta = null) {
    if (!containerEl || !pyodide) return;
    disposePsfCharts(host);
    containerEl.innerHTML = '';

    if (!navigator.gpu) {
        containerEl.innerHTML = '<div class="seq-chartgpu-fallback">WebGPU required for PSF charts.</div>';
        return;
    }

    let out;
    try {
        const gridJson = gridMeta ? gridMetaToPsfGridJson(gridMeta) : null;
        const pyCall = gridJson
            ? `import json; compute_psf_json(${JSON.stringify(gridJson)})`
            : 'import json; compute_psf_json()';
        const raw = await pyodide.runPythonAsync(pyCall);
        out = JSON.parse(String(raw));
    } catch (e) {
        containerEl.innerHTML = `<div class="seq-chartgpu-fallback">PSF error: ${e?.message || e}</div>`;
        if (metaEl) metaEl.textContent = '';
        return;
    }

    if (!out.ok) {
        containerEl.innerHTML = `<div class="seq-chartgpu-fallback">${out.reason || 'PSF unavailable'}</div>`;
        if (metaEl) {
            metaEl.hidden = false;
            metaEl.textContent = out.reason || '';
        }
        return;
    }

    const zoomXlimMm = out.zoomXlimMm ?? out.xlimMm ?? 5;
    host._psfZoomXlimMm = zoomXlimMm;
    host._psfScaleMode = root ? getPsfScaleMode(root) : 'normalized';
    if (scaleRowEl) scaleRowEl.hidden = false;

    const wrap = document.createElement('div');
    wrap.className = 'psf-split';
    const panelJobs = [];

    for (const panel of out.panels) {
        const col = document.createElement('div');
        col.className = 'psf-panel';
        const title = document.createElement('div');
        title.className = 'psf-panel-title';
        title.textContent = `PSF ${panel.axis} (±${zoomXlimMm.toFixed(1)} mm · drag/wheel on x only)`;
        const mount = document.createElement('div');
        mount.className = 'psf-chart-mount';
        col.appendChild(title);
        col.appendChild(mount);
        wrap.appendChild(col);
        panelJobs.push({ mount, panel });
    }

    containerEl.appendChild(wrap);
    appendPsfLegend(containerEl);

    const charts = [];
    const panelJobsStored = [];
    for (const { mount, panel } of panelJobs) {
        try {
            const chart = await renderPsfPanel(host, mount, panel, zoomXlimMm, host._psfScaleMode);
            charts.push(chart);
            panelJobsStored.push({ mount, panel, chart, axis: panel.axis, mountEl: mount });
        } catch (e) {
            console.error(e);
            mount.innerHTML = `<div class="seq-chartgpu-fallback">ChartGPU failed (${panel.axis})</div>`;
        }
    }

    host._psfCharts = charts;
    host._psfPanelJobs = panelJobsStored;
    await refreshPsfChartLayouts(charts);

    if (metaEl) {
        metaEl.hidden = true;
        metaEl.textContent = '';
    }
}
