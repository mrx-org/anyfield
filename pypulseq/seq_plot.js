/**
 * Sequence waveform plotting: ChartGPU (`seq.plot(..., plot_speed='chartgpu')`) bridge and
 * Pyodide `seq.plot` script fragments. Chart/WebGPU state lives on the explorer `host` (`host._seqChartGpu*`).
 */

export const SEQ_DEFAULT_PLOT_SPEED = 'chartgpu';

/** Pinned ChartGPU ESM (see insights/SPEC_seq_plot.md). */
export const CHARTGPU_MODULE_URL = 'https://esm.sh/chartgpu@0.3.2?target=es2022';

/** Lab shell sidebar / scan list surface (`--bg-elevated` in index.html). */
export const LAB_SHELL_BG_ELEVATED = '#0f1424';

/**
 * ChartGPU dark theme aligned with niivue lab shell (not ChartGPU default purple tint).
 * @param {Record<string, unknown> | undefined} preset `darkTheme` from chartgpu
 * @param {number} [fontSize]
 */
export function seqChartGpuLabTheme(preset, fontSize = 10) {
    const base = preset && typeof preset === 'object' ? preset : {};
    return {
        ...base,
        backgroundColor: LAB_SHELL_BG_ELEVATED,
        gridLineColor: 'rgba(255, 255, 255, 0.08)',
        axisLineColor: 'rgba(255, 255, 255, 0.1)',
        axisTickColor: 'rgba(255, 255, 255, 0.1)',
        fontSize,
    };
}

/**
 * Tear down ChartGPU charts and shared WebGPU device created for sequence plots.
 */
const KSPACE_TIME_MARGIN_S = 1e-6;
export const KSPACE_GRID = { left: 60, right: 12, top: 8, bottom: 52 };
const KSPACE_COLOR_LINE = '#ff0000';
const KSPACE_COLOR_MARKER = '#00e5ff';
const KSPACE_LINE_WIDTH = 3;
const KSPACE_ZOOM_DEBOUNCE_MS = 120;

function isShowKspaceChecked(plotRoot) {
    const local = plotRoot?.querySelector('#seq-show-kspace-checkbox');
    if (local) return !!local.checked && !local.disabled;
    const global = document.getElementById('seq-show-kspace-checkbox');
    return !!global?.checked && !global.disabled;
}

function detachSeqZoomKspaceListener(host) {
    if (host._seqZoomKspaceCleanup) {
        try {
            host._seqZoomKspaceCleanup();
        } catch (e) {
            /* ignore */
        }
        host._seqZoomKspaceCleanup = null;
    }
}

/** Per-panel kx–ky ChartGPU state (`xy` = seq_check side panel; other slots e.g. `fig4`). */
function getKspaceKySlot(host, slot = 'xy') {
    if (slot === 'xy') {
        return {
            getChart: () => host._kspaceChart,
            setChart: (c) => {
                host._kspaceChart = c;
            },
            getCleanup: () => host._kspaceInteractionCleanup,
            setCleanup: (f) => {
                host._kspaceInteractionCleanup = f;
            },
            getAxisView: () => host._kspaceAxisView,
            setAxisView: (v) => {
                host._kspaceAxisView = v;
            },
            clearAxisView: () => {
                host._kspaceAxisView = null;
            },
            clearSeriesBase: () => {
                host._kspaceSeriesBase = null;
            },
            getSeriesBase: () => host._kspaceSeriesBase,
            setSeriesBase: (v) => {
                host._kspaceSeriesBase = v;
            },
            getLastPayload: () => host._lastKspacePayload,
            setLastPayload: (p) => {
                host._lastKspacePayload = p;
            },
            clearLastPayload: () => {
                host._lastKspacePayload = null;
            },
        };
    }
    if (!host._kspaceKySlots) host._kspaceKySlots = {};
    const box = host._kspaceKySlots[slot] || (host._kspaceKySlots[slot] = {});
    return {
        getChart: () => box.chart,
        setChart: (c) => {
            box.chart = c;
        },
        getCleanup: () => box.cleanup,
        setCleanup: (f) => {
            box.cleanup = f;
        },
        getAxisView: () => box.axisView,
        setAxisView: (v) => {
            box.axisView = v;
        },
        clearAxisView: () => {
            box.axisView = null;
        },
        clearSeriesBase: () => {
            box.seriesBase = null;
        },
        getSeriesBase: () => box.seriesBase,
        setSeriesBase: (v) => {
            box.seriesBase = v;
        },
        getLastPayload: () => box.lastPayload,
        setLastPayload: (p) => {
            box.lastPayload = p;
        },
        clearLastPayload: () => {
            box.lastPayload = null;
        },
    };
}

export function disposeKspaceKySlot(host, slot = 'xy') {
    const s = getKspaceKySlot(host, slot);
    const cleanup = s.getCleanup();
    if (cleanup) {
        try {
            cleanup();
        } catch (e) {
            /* ignore */
        }
        s.setCleanup(null);
    }
    const chart = s.getChart();
    if (chart) {
        try {
            chart.dispose();
        } catch (e) {
            /* ignore */
        }
        s.setChart(null);
    }
    s.clearAxisView();
    s.clearSeriesBase();
    s.clearLastPayload();
}

function disposeKspaceCharts(host) {
    disposeKspaceKySlot(host, 'xy');
    if (host._kspaceKySlots) {
        for (const key of Object.keys(host._kspaceKySlots)) {
            disposeKspaceKySlot(host, key);
        }
        host._kspaceKySlots = null;
    }
    if (host._kspaceYzInteractionCleanup) {
        try {
            host._kspaceYzInteractionCleanup();
        } catch (e) {
            /* ignore */
        }
        host._kspaceYzInteractionCleanup = null;
    }
    if (host._kspaceYzChart) {
        try {
            host._kspaceYzChart.dispose();
        } catch (e) {
            /* ignore */
        }
        host._kspaceYzChart = null;
    }
    host._kspaceAxisView = null;
    host._kspaceYzAxisView = null;
    host._kspaceYzSeriesBase = null;
    host._lastKspaceYzPayload = null;
}

/** Drop JS k-space time series (not called by chart dispose — see seq_check / setupKspacePanels). */
export function clearKspaceHostCache(host) {
    if (!host) return;
    host._kspaceCache = null;
    host._seqDispTimeRange = null;
}

export async function disposeSeqChartGpuHost(host) {
    detachSeqZoomKspaceListener(host);
    disposeKspaceCharts(host);
    if (host._seqChartGpuDisconnect) {
        try {
            host._seqChartGpuDisconnect();
        } catch (e) {
            /* ignore */
        }
        host._seqChartGpuDisconnect = null;
    }
    if (typeof host._seqChartGpuRemoveDeviceListeners === 'function') {
        try {
            host._seqChartGpuRemoveDeviceListeners();
        } catch (e) {
            /* ignore */
        }
        host._seqChartGpuRemoveDeviceListeners = null;
    }
    if (Array.isArray(host._seqChartGpuCharts)) {
        for (const c of host._seqChartGpuCharts) {
            try {
                c.dispose();
            } catch (e) {
                /* ignore */
            }
        }
    }
    host._seqChartGpuCharts = null;
    if (host._seqChartGpuDevice) {
        try {
            host._seqChartGpuDevice.destroy();
        } catch (e) {
            /* ignore */
        }
    }
    host._seqChartGpuDevice = null;
    host._seqChartGpuAdapter = null;
    host._seqChartZoomPadFraction = 0;
}

/**
 * Normalize series objects from Python JSON for ChartGPU.create (camelCase, scatter sizes).
 * @param {unknown[]} seriesIn
 */
export function normalizeChartGpuSeries(seriesIn) {
    if (!Array.isArray(seriesIn)) return [];
    return seriesIn.map((s) => {
        if (!s || typeof s !== 'object') return { type: 'line', data: [] };
        const out = { type: s.type || 'line', data: [] };
        let raw = s.data || [];
        if (typeof s.xyBase64 === 'string' && s.xyBase64.length > 0) {
            try {
                raw = chartGpuB64ToFloat32Interleaved(s.xyBase64);
            } catch (e) {
                console.warn('ChartGPU xyBase64 decode failed:', e);
                raw = [];
            }
        }
        if (s.style && typeof s.style === 'object') {
            out.style = { ...s.style };
            if (out.style.size != null && s.type === 'scatter') {
                out.symbolSize = s.symbolSize ?? out.style.size;
                delete out.style.size;
            }
        }
        if (s.symbolSize != null) out.symbolSize = s.symbolSize;
        if (s.name != null) out.name = s.name;
        if (s.visible === false) out.visible = false;
        if (s.sampling != null) out.sampling = s.sampling;
        out.data = chartGpuSeriesDataToInterleavedF32(raw);
        return out;
    });
}

/**
 * Decode payload `xyBase64` (little-endian float32 interleaved x,y,…) from Python.
 * @param {string} b64
 * @returns {Float32Array}
 */
export function chartGpuB64ToFloat32Interleaved(b64) {
    const binary = atob(b64);
    const n = binary.length;
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = binary.charCodeAt(i);
    const floatCount = bytes.byteLength >> 2;
    return new Float32Array(bytes.buffer, bytes.byteOffset, floatCount);
}

/**
 * After JSON.parse, pack plain [[x,y],…] / {x,y} series into interleaved Float32Array so nested
 * arrays can be GC'd before ChartGPU.upload (ChartGPU InterleavedXYData).
 * @param {unknown} data
 * @returns {unknown}
 */
export function chartGpuSeriesDataToInterleavedF32(data) {
    if (data == null) return [];
    if (ArrayBuffer.isView(data)) {
        const len = data.length;
        if (len >= 2 && len % 2 === 0) return data;
        return data;
    }
    if (typeof data === 'object' && !Array.isArray(data) && data.x != null && data.y != null) {
        const xs = data.x;
        const ys = data.y;
        const nx = typeof xs.length === 'number' ? xs.length : 0;
        const ny = typeof ys.length === 'number' ? ys.length : 0;
        const n = Math.min(nx, ny);
        if (n === 0) return new Float32Array(0);
        const out = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) {
            out[i * 2] = Number(xs[i]);
            out[i * 2 + 1] = Number(ys[i]);
        }
        return out;
    }
    if (!Array.isArray(data)) return data;
    if (data.length === 0) return new Float32Array(0);

    let maxTuple = 2;
    for (let i = 0; i < Math.min(data.length, 4096); i++) {
        const p = data[i];
        if (p == null) return data;
        if (Array.isArray(p)) {
            if (p.length > maxTuple) maxTuple = p.length;
        } else if (typeof p === 'object') {
            const sz = p.size != null ? 3 : p.z != null ? 3 : 2;
            if (sz > maxTuple) maxTuple = sz;
        }
    }
    if (maxTuple > 2) return data;

    const out = new Float32Array(data.length * 2);
    for (let i = 0; i < data.length; i++) {
        const p = data[i];
        if (p == null) return data;
        let x;
        let y;
        if (Array.isArray(p)) {
            x = Number(p[0]);
            y = Number(p[1]);
        } else if (typeof p === 'object') {
            x = Number(p.x);
            y = Number(p.y);
        } else {
            return data;
        }
        const xNum = typeof x === 'number' ? x : NaN;
        const yNum = typeof y === 'number' ? y : NaN;
        const xOk = Number.isFinite(xNum) || Number.isNaN(xNum);
        const yOk = Number.isFinite(yNum) || Number.isNaN(yNum);
        if (!xOk || !yOk) return data;
        out[i * 2] = xNum;
        out[i * 2 + 1] = yNum;
    }
    return out;
}

/**
 * ChartGPU y-axis tick labels: three significant digits (stable across RF vs gradient scales).
 * @param {number} v
 * @returns {string | null}
 */
export function formatYTick3SigDigits(v) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
    const n = Number(v);
    if (n === 0) return '0';
    return n.toPrecision(3);
}

/**
 * Pick a finite y for the invisible shared-x-extent helper line (must sit inside real y span
 * so auto y-bounds are not distorted). Uses the first finite y found in panel series data.
 * @param {unknown[]} seriesArr normalized ChartGPU series
 * @returns {number}
 */
export function chartGpuYAnchorForExtentHelper(seriesArr) {
    if (!Array.isArray(seriesArr)) return 0;
    for (const s of seriesArr) {
        if (!s || typeof s !== 'object' || s.name === '__seqXExtent__') continue;
        const data = s.data;
        if (!data) continue;
        if (ArrayBuffer.isView(data)) {
            const len = data.length;
            for (let j = 1; j < Math.min(len, 512); j += 2) {
                const y = data[j];
                if (Number.isFinite(y)) return y;
            }
        } else if (Array.isArray(data)) {
            for (let j = 0; j < Math.min(data.length, 256); j++) {
                const p = data[j];
                if (p == null) continue;
                let y;
                if (Array.isArray(p) && p.length >= 2) y = p[1];
                else if (typeof p === 'object' && Number.isFinite(p.y)) y = p.y;
                if (Number.isFinite(y)) return y;
            }
        } else if (typeof data === 'object' && data.y != null) {
            const ys = data.y;
            const len = typeof ys.length === 'number' ? ys.length : 0;
            for (let j = 0; j < Math.min(len, 256); j++) {
                const y = ys[j];
                if (Number.isFinite(y)) return y;
            }
        }
    }
    return 0;
}

/**
 * Append an invisible line so ChartGPU's global x bounds match the sequence window on every
 * panel without setting xAxis.min/max (which pins value-axis ticks to the full span in ChartGPU).
 * @param {unknown[]} seriesArr
 * @param {number} xMin
 * @param {number} xMax
 * @param {number} yAnchor
 */
/**
 * Extra x-axis span (fraction of sequence length per side) so wheel zoom-out can show margins.
 * ChartGPU max zoom-out is 0–100% of the data domain; padding widens that domain.
 */
export const SEQ_CHARTGPU_ZOOM_PAD_FRACTION = 0.4;

/** @param {number} padFraction per-side padding as a fraction of sequence span */
export function seqChartGpuInitialZoomPct(padFraction) {
    const f = Number(padFraction);
    if (!Number.isFinite(f) || f <= 0) return { start: 0, end: 100 };
    const denom = 1 + 2 * f;
    return { start: (f / denom) * 100, end: ((1 + f) / denom) * 100 };
}

/** @param {number} xMin @param {number} xMax @param {number} padFraction */
export function chartGpuPaddedXBounds(xMin, xMax, padFraction = SEQ_CHARTGPU_ZOOM_PAD_FRACTION) {
    const span = xMax - xMin;
    const f = Number.isFinite(padFraction) ? padFraction : 0;
    const pad =
        Number.isFinite(span) && span > 0 ? span * f : f > 0 ? Math.max(Math.abs(xMax - xMin), 0.01) * f : 0;
    return { min: xMin - pad, max: xMax + pad };
}

export function chartGpuWithSharedXExtentSeries(seriesArr, xMin, xMax, yAnchor) {
    const base = Array.isArray(seriesArr) ? [...seriesArr] : [];
    base.push({
        type: 'line',
        name: '__seqXExtent__',
        data: new Float32Array([xMin, yAnchor, xMax, yAnchor]),
        visible: false,
        sampling: 'none',
    });
    return base;
}

export async function releaseChartgpuPythonPayload(pyodide) {
    if (!pyodide) return;
    try {
        await pyodide.runPythonAsync('clear_chartgpu_payload()');
    } catch (e) {
        /* ignore */
    }
}

export async function releaseKspaceCache(pyodide) {
    if (!pyodide) return;
    try {
        await pyodide.runPythonAsync('clear_kspace_cache()');
    } catch (e) {
        /* ignore */
    }
}

function lowerBoundTime(arr, t) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid] < t) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function upperBoundTime(arr, t) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid] <= t) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

export function indexRangeForTimeWindow(tArr, tLo, tHi, margin = KSPACE_TIME_MARGIN_S) {
    const n = tArr.length;
    if (!n) return { iLo: 0, iHi: -1 };
    const tMin = tLo - margin;
    const tMax = tHi + margin;
    const iLo = Math.min(n - 1, lowerBoundTime(tArr, tMin));
    const iHi = upperBoundTime(tArr, tMax) - 1;
    if (iHi < iLo) return { iLo, iHi: iLo - 1 };
    return { iLo, iHi };
}

function seqZoomToTimeWindow(host, zoomPct) {
    const [t0, t1] = host._seqDispTimeRange || [0, 1];
    const padFrac = host._seqChartZoomPadFraction || 0;
    const seqSpan = t1 - t0;
    const pad =
        Number.isFinite(seqSpan) && seqSpan > 0
            ? seqSpan * padFrac
            : padFrac > 0
              ? 0.01
              : 0;
    const xLo = t0 - pad;
    const xSpan = t1 + pad - xLo || 1;
    const start = Number(zoomPct?.start ?? 0);
    const end = Number(zoomPct?.end ?? 100);
    return {
        tLo: xLo + (start / 100) * xSpan,
        tHi: xLo + (end / 100) * xSpan,
    };
}

/** HSV hue in [0,1] → hex color (ADC time rainbow). */
export function hsvToHex(h, s = 1, v = 1) {
    const hh = ((h % 1) + 1) % 1;
    const i = Math.floor(hh * 6);
    const f = hh * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    let r = 0;
    let g = 0;
    let b = 0;
    switch (i % 6) {
        case 0:
            r = v;
            g = t;
            b = p;
            break;
        case 1:
            r = q;
            g = v;
            b = p;
            break;
        case 2:
            r = p;
            g = v;
            b = t;
            break;
        case 3:
            r = p;
            g = q;
            b = v;
            break;
        case 4:
            r = t;
            g = p;
            b = v;
            break;
        case 5:
            r = v;
            g = p;
            b = q;
            break;
        default:
            break;
    }
    const toHex = (x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Matplotlib-style stops [t, [r,g,b]] with t in [0, 1]. */
const COLORMAP_STOPS = {
    viridis: [
        [0, [68, 1, 84]],
        [0.25, [59, 82, 139]],
        [0.5, [33, 145, 140]],
        [0.75, [94, 201, 98]],
        [1, [253, 231, 37]],
    ],
    parula: [
        [0, [53, 42, 135]],
        [0.2, [15, 92, 221]],
        [0.4, [0, 181, 206]],
        [0.6, [0, 200, 122]],
        [0.8, [162, 252, 60]],
        [1, [248, 230, 32]],
    ],
};

/**
 * Sample viridis or parula at t in [0, 1] (for ChartGPU scatter kspaceColor).
 * @param {number} t
 * @param {'viridis' | 'parula'} [name]
 */
export function colormapHex(t, name = 'viridis') {
    const stops = COLORMAP_STOPS[name] || COLORMAP_STOPS.viridis;
    const x = Math.min(1, Math.max(0, Number(t) || 0));
    let i = 0;
    while (i < stops.length - 1 && stops[i + 1][0] < x) i++;
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[Math.min(i + 1, stops.length - 1)];
    const u = t1 > t0 ? (x - t0) / (t1 - t0) : 0;
    const r = Math.round(c0[0] + u * (c1[0] - c0[0]));
    const g = Math.round(c0[1] + u * (c1[1] - c0[1]));
    const b = Math.round(c0[2] + u * (c1[2] - c0[2]));
    const h = (n) => n.toString(16).padStart(2, '0');
    return `#${h(r)}${h(g)}${h(b)}`;
}

function isRainbowAdcForHost(host) {
    return !!host?._rainbowAdc;
}

/** @param {*} host @returns {{ tLo: number, tHi: number } | null} */
export function getTimeWindowFromZoom(host) {
    const charts = host._seqChartGpuCharts;
    if (!charts?.length || !host._seqDispTimeRange) return null;
    const anchor = charts[charts.length - 1];
    let z = { start: 0, end: 100 };
    try {
        z = anchor.getZoomRange() || z;
    } catch (_) {
        /* ignore */
    }
    return seqZoomToTimeWindow(host, z);
}

function buildKspaceSlice(cache, tLo, tHi, plane = 'xy', opts = {}) {
    if (tHi < tLo) {
        const s = tLo;
        tLo = tHi;
        tHi = s;
    }
    const empty = { series: [], bounds: [null, null] };
    if (!cache || cache.error) return empty;

    const tTraj = cache.t_ktraj || [];
    const tAdc = cache.t_adc || [];
    const aG = plane === 'xy' ? cache.kx_grad || [] : cache.ky_grad || [];
    const bG = plane === 'xy' ? cache.ky_grad || [] : cache.kz_grad || [];
    const aA = plane === 'xy' ? cache.kx_adc || [] : cache.ky_adc || [];
    const bA = plane === 'xy' ? cache.ky_adc || [] : cache.kz_adc || [];

    const series = [];
    const allA = [];
    const allB = [];

    const nTraj = aG.length;
    if (nTraj >= 2 && tTraj.length === nTraj) {
        const { iLo, iHi } = indexRangeForTimeWindow(tTraj, tLo, tHi);
        const trajData = [];
        for (let i = iLo; i <= iHi; i++) {
            const a = aG[i];
            const b = bG[i] ?? 0;
            if (!Number.isFinite(a) || !Number.isFinite(b)) {
                if (trajData.length > 0 && trajData[trajData.length - 1] !== null) {
                    trajData.push(null);
                }
                continue;
            }
            trajData.push([a, b]);
            allA.push(a);
            allB.push(b);
        }
        if (trajData.length >= 2) {
            series.push({
                type: 'line',
                data: trajData,
                kspaceRole: 'traj',
                sampling: 'none',
            });
        }
    }

    const nAdc = aA.length;
    if (nAdc > 0 && tAdc.length === nAdc) {
        const { iLo: aLo, iHi: aHi } = indexRangeForTimeWindow(tAdc, tLo, tHi);
        const adcPts = [];
        for (let i = aLo; i <= aHi; i++) {
            const a = aA[i];
            const b = bA[i] ?? 0;
            if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
            adcPts.push([a, b]);
            allA.push(a);
            allB.push(b);
        }
        if (adcPts.length > 0) {
            const rainbowAdc = !!opts.rainbowAdc;
            if (rainbowAdc) {
                const nBins = Math.min(48, Math.max(8, Math.ceil(adcPts.length / 24)));
                const bins = Array.from({ length: nBins }, () => []);
                const denom = Math.max(1, nAdc - 1);
                for (let i = aLo; i <= aHi; i++) {
                    const a = aA[i];
                    const b = bA[i] ?? 0;
                    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
                    const tNorm = Math.max(0, Math.min(1, i / denom));
                    const bin = Math.min(nBins - 1, Math.floor(tNorm * nBins));
                    bins[bin].push([a, b]);
                }
                for (let bi = 0; bi < nBins; bi++) {
                    if (!bins[bi].length) continue;
                    series.push({
                        type: 'scatter',
                        data: bins[bi],
                        kspaceRole: 'adc',
                        kspaceColor: hsvToHex(bi / Math.max(1, nBins - 1)),
                        symbol: 'circle',
                        symbolSize: 3,
                        sampling: 'none',
                    });
                }
            } else {
                series.push({
                    type: 'scatter',
                    data: adcPts,
                    kspaceRole: 'adc',
                    symbol: 'circle',
                    symbolSize: 3,
                    sampling: 'none',
                });
            }
        }
    }

    let aBounds = null;
    let bBounds = null;
    if (allA.length) {
        let aMin = allA[0];
        let aMax = allA[0];
        let bMin = allB[0];
        let bMax = allB[0];
        for (let i = 1; i < allA.length; i++) {
            if (allA[i] < aMin) aMin = allA[i];
            if (allA[i] > aMax) aMax = allA[i];
            if (allB[i] < bMin) bMin = allB[i];
            if (allB[i] > bMax) bMax = allB[i];
        }
        aBounds = [aMin, aMax];
        bBounds = [bMin, bMax];
    }
    return { series, bounds: [aBounds, bBounds] };
}

export function buildKspacePayloadTime(cache, tLo, tHi, hostOrOpts = null) {
    const opts =
        hostOrOpts && typeof hostOrOpts === 'object' && '_rainbowAdc' in hostOrOpts
            ? { rainbowAdc: isRainbowAdcForHost(hostOrOpts) }
            : hostOrOpts && typeof hostOrOpts === 'object'
              ? hostOrOpts
              : {};
    const r = buildKspaceSlice(cache, tLo, tHi, 'xy', opts);
    return { series: r.series, kxBounds: r.bounds[0], kyBounds: r.bounds[1] };
}

export function buildKspaceYzPayloadTime(cache, tLo, tHi, hostOrOpts = null) {
    const opts =
        hostOrOpts && typeof hostOrOpts === 'object' && '_rainbowAdc' in hostOrOpts
            ? { rainbowAdc: isRainbowAdcForHost(hostOrOpts) }
            : hostOrOpts && typeof hostOrOpts === 'object'
              ? hostOrOpts
              : {};
    const r = buildKspaceSlice(cache, tLo, tHi, 'yz', opts);
    return { series: r.series, kyBounds: r.bounds[0], kzBounds: r.bounds[1] };
}

export function normalizeKspaceChartGpuSeries(seriesIn) {
    const normalized = normalizeChartGpuSeries(seriesIn);
    return normalized.map((s, i) => {
        const src = seriesIn[i];
        if (src?.kspaceRole === 'adc' || src?.type === 'scatter') {
            const adcColor = src?.kspaceColor || KSPACE_COLOR_MARKER;
            return {
                ...s,
                type: 'scatter',
                color: adcColor,
                symbol: src?.symbol ?? 'circle',
                symbolSize: s.symbolSize ?? src?.symbolSize ?? 3,
                sampling: 'none',
            };
        }
        return {
            ...s,
            color: KSPACE_COLOR_LINE,
            lineStyle: { color: KSPACE_COLOR_LINE, width: KSPACE_LINE_WIDTH },
            sampling: 'none',
        };
    });
}

function boundsToPlaneAxisView(xBounds, yBounds, padFrac = 0.08) {
    if (!xBounds || !yBounds) return null;
    let x0 = Number(xBounds[0]);
    let x1 = Number(xBounds[1]);
    let y0 = Number(yBounds[0]);
    let y1 = Number(yBounds[1]);
    if (![x0, x1, y0, y1].every(Number.isFinite)) return null;
    if (x1 <= x0) {
        const c = 0.5 * (x0 + x1);
        const half = Math.max(Math.abs(c), 1) * 1e-3;
        x0 = c - half;
        x1 = c + half;
    }
    if (y1 <= y0) {
        const c = 0.5 * (y0 + y1);
        const half = Math.max((x1 - x0) * 0.02, 1e-3);
        y0 = c - half;
        y1 = c + half;
    }
    const dx = (x1 - x0) * padFrac || 1e-6;
    const dy = (y1 - y0) * padFrac || 1e-6;
    return { xMin: x0 - dx, xMax: x1 + dx, yMin: y0 - dy, yMax: y1 + dy };
}

function ensureKspaceAxisView(host, payload, slot = 'xy') {
    const s = getKspaceKySlot(host, slot);
    const cur = s.getAxisView();
    if (cur) return cur;
    const v = boundsToPlaneAxisView(payload?.kxBounds ?? null, payload?.kyBounds ?? null);
    if (v) s.setAxisView(v);
    return v;
}

function ensureKspaceYzAxisView(host, payload) {
    if (host._kspaceYzAxisView) return host._kspaceYzAxisView;
    const v = boundsToPlaneAxisView(payload?.kyBounds ?? null, payload?.kzBounds ?? null);
    if (v) host._kspaceYzAxisView = v;
    return v;
}

function kspaceAxisTickFormatter(span) {
    const abs = Math.abs(span);
    if (abs >= 1e6) return (v) => `${(v / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return (v) => `${(v / 1e3).toFixed(2)}k`;
    if (abs >= 1) return (v) => v.toFixed(2);
    if (abs >= 1e-3) return (v) => v.toFixed(4);
    return (v) => v.toExponential(2);
}

function planeAxisChartOptions(view, xName, yName) {
    const xAxis = { name: xName };
    const yAxis = { name: yName };
    if (view) {
        const spanX = view.xMax - view.xMin;
        const spanY = view.yMax - view.yMin;
        xAxis.min = view.xMin;
        xAxis.max = view.xMax;
        yAxis.min = view.yMin;
        yAxis.max = view.yMax;
        xAxis.tickFormatter = kspaceAxisTickFormatter(spanX);
        yAxis.tickFormatter = kspaceAxisTickFormatter(spanY);
    } else {
        yAxis.autoBounds = 'visible';
    }
    return { xAxis, yAxis };
}

function applyPlaneChartView(chart, view, seriesBase, xName, yName) {
    if (!chart || chart.disposed || !view) return;
    if (!Array.isArray(seriesBase) || !seriesBase.length) return;
    const axisPatch = planeAxisChartOptions(view, xName, yName);
    const prev = chart.options && typeof chart.options === 'object' ? chart.options : {};
    try {
        chart.setOption({
            ...prev,
            animation: false,
            legend: prev.legend ?? { show: false },
            grid: prev.grid ?? KSPACE_GRID,
            tooltip: prev.tooltip ?? { show: true },
            ...axisPatch,
            series: seriesBase,
        });
        if (typeof chart.resize === 'function') chart.resize();
    } catch (err) {
        console.warn('k-space chart setOption:', err);
    }
}

function planeGridFractionFromEvent(chart, containerEl, ev, grid = KSPACE_GRID) {
    const canvas = containerEl.querySelector('canvas');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const plotW = rect.width - grid.left - grid.right;
    const plotH = rect.height - grid.top - grid.bottom;
    if (!(plotW > 0 && plotH > 0)) return null;
    let ht = { isInGrid: false };
    try {
        ht = chart.hitTest(ev);
    } catch (_) {
        /* ignore */
    }
    if (ht.isInGrid && Number.isFinite(ht.gridX) && Number.isFinite(ht.gridY)) {
        return {
            fx: Math.min(1, Math.max(0, ht.gridX / plotW)),
            fy: Math.min(1, Math.max(0, 1 - ht.gridY / plotH)),
        };
    }
    const cx = ev.clientX - rect.left - grid.left;
    const cy = ev.clientY - rect.top - grid.top;
    if (cx < 0 || cy < 0 || cx > plotW || cy > plotH) return null;
    return {
        fx: Math.min(1, Math.max(0, cx / plotW)),
        fy: Math.min(1, Math.max(0, 1 - cy / plotH)),
    };
}

export function planeViewFromChartOptions(chart) {
    const o = chart?.options;
    const xa = o?.xAxis;
    const ya = o?.yAxis;
    if (
        xa?.min == null ||
        xa?.max == null ||
        ya?.min == null ||
        ya?.max == null ||
        !(xa.max > xa.min) ||
        !(ya.max > ya.min)
    ) {
        return null;
    }
    return { xMin: xa.min, xMax: xa.max, yMin: ya.min, yMax: ya.max };
}

function zoomPlaneAxisView(view, factor, centerFrac) {
    const fx = centerFrac?.fx ?? 0.5;
    const fy = centerFrac?.fy ?? 0.5;
    const spanX = view.xMax - view.xMin;
    const spanY = view.yMax - view.yMin;
    const newSpanX = Math.max(spanX * factor, 1e-12);
    const newSpanY = Math.max(spanY * factor, 1e-12);
    const xAt = view.xMin + fx * spanX;
    const yAt = view.yMin + fy * spanY;
    return {
        xMin: xAt - fx * newSpanX,
        xMax: xAt + (1 - fx) * newSpanX,
        yMin: yAt - fy * newSpanY,
        yMax: yAt + (1 - fy) * newSpanY,
    };
}

function panPlaneAxisView(view, dx, dy) {
    return {
        xMin: view.xMin + dx,
        xMax: view.xMax + dx,
        yMin: view.yMin + dy,
        yMax: view.yMax + dy,
    };
}

function zoomPlaneAxisViewXOnly(view, factor, centerFrac) {
    const fx = centerFrac?.fx ?? 0.5;
    const spanX = view.xMax - view.xMin;
    const newSpanX = Math.max(spanX * factor, 1e-12);
    const xAt = view.xMin + fx * spanX;
    return {
        xMin: xAt - fx * newSpanX,
        xMax: xAt + (1 - fx) * newSpanX,
        yMin: view.yMin,
        yMax: view.yMax,
    };
}

function panPlaneAxisViewXOnly(view, dx) {
    return {
        xMin: view.xMin + dx,
        xMax: view.xMax + dx,
        yMin: view.yMin,
        yMax: view.yMax,
    };
}

/**
 * Wheel zoom + left-drag pan on a ChartGPU value-axis chart (k-space planes, PSF profiles, …).
 * @param {HTMLElement} containerEl
 * @param {*} chart
 * @param {*} plane { isChartOk, getView, setView, ensureView, applyView }
 * @param {{ left: number, right: number, top: number, bottom: number }} [grid]
 * @param {{ xOnly?: boolean }} [opts] If true, wheel/drag affect x-axis only (PSF profiles).
 * @returns {() => void} cleanup
 */
export function attachChartGpuPlaneInteraction(containerEl, chart, plane, grid = KSPACE_GRID, opts = {}) {
    const xOnly = !!opts.xOnly;
    const canvas = () => containerEl.querySelector('canvas');
    const plotSize = () => {
        const c = canvas();
        if (!c) return { w: 0, h: 0 };
        const rect = c.getBoundingClientRect();
        return {
            w: rect.width - grid.left - grid.right,
            h: rect.height - grid.top - grid.bottom,
        };
    };
    const onWheel = (e) => {
        if (!plane.isChartOk()) return;
        const frac = planeGridFractionFromEvent(chart, containerEl, e, grid);
        if (!frac) return;
        e.preventDefault();
        e.stopPropagation();
        let view = plane.getView();
        if (!view) view = plane.ensureView();
        if (!view) view = planeViewFromChartOptions(chart);
        if (!view) return;
        plane.setView(view);
        const factor = e.deltaY < 0 ? 0.88 : 1.12;
        plane.setView(
            xOnly ? zoomPlaneAxisViewXOnly(view, factor, frac) : zoomPlaneAxisView(view, factor, frac),
        );
        plane.applyView(chart, plane.getView());
    };
    const DRAG_THRESHOLD = 4;
    let pan = null;
    const stopPan = () => {
        pan = null;
        window.removeEventListener('pointermove', onPanMove);
        window.removeEventListener('pointerup', stopPan);
        window.removeEventListener('pointercancel', stopPan);
    };
    const onPanMove = (ev) => {
        if (!pan || !plane.isChartOk()) return;
        if (ev.pointerId !== pan.pointerId) return;
        const dx = ev.clientX - pan.startX;
        const dy = ev.clientY - pan.startY;
        if (pan.phase === 'pending') {
            if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
            pan.phase = 'active';
            const c = canvas();
            if (c) {
                try {
                    c.setPointerCapture(ev.pointerId);
                } catch (_) {
                    /* ignore */
                }
            }
            ev.preventDefault();
        }
        if (pan.phase !== 'active') return;
        const rawDx = ev.clientX - pan.lastX;
        const rawDy = ev.clientY - pan.lastY;
        pan.lastX = ev.clientX;
        pan.lastY = ev.clientY;
        if (!Number.isFinite(rawDx) || !Number.isFinite(rawDy)) return;
        if (rawDx === 0 && rawDy === 0) return;
        ev.preventDefault();
        let view = plane.getView();
        if (!view) view = plane.ensureView() || planeViewFromChartOptions(chart);
        if (!view) return;
        const { w, h } = plotSize();
        if (!(w > 0 && h > 0)) return;
        const spanX = view.xMax - view.xMin;
        const spanY = view.yMax - view.yMin;
        const ddx = (-rawDx / w) * spanX;
        const ddy = xOnly ? 0 : (rawDy / h) * spanY;
        plane.setView(
            xOnly ? panPlaneAxisViewXOnly(view, ddx) : panPlaneAxisView(view, ddx, ddy),
        );
        plane.applyView(chart, plane.getView());
    };
    const onPointerDown = (ev) => {
        if (!plane.isChartOk()) return;
        if (ev.button !== 0 || ev.shiftKey) return;
        const frac = planeGridFractionFromEvent(chart, containerEl, ev, grid);
        if (!frac) return;
        stopPan();
        pan = {
            phase: 'pending',
            startX: ev.clientX,
            startY: ev.clientY,
            lastX: ev.clientX,
            lastY: ev.clientY,
            pointerId: ev.pointerId,
        };
        window.addEventListener('pointermove', onPanMove);
        window.addEventListener('pointerup', stopPan);
        window.addEventListener('pointercancel', stopPan);
    };
    containerEl.addEventListener('wheel', onWheel, { passive: false });
    containerEl.addEventListener('pointerdown', onPointerDown);
    return () => {
        stopPan();
        containerEl.removeEventListener('wheel', onWheel);
        containerEl.removeEventListener('pointerdown', onPointerDown);
    };
}

function attachKspacePlaneInteraction(containerEl, chart, plane) {
    return attachChartGpuPlaneInteraction(containerEl, chart, plane, KSPACE_GRID);
}

function attachKspaceKySlotInteraction(host, containerEl, chart, slot = 'xy') {
    const s = getKspaceKySlot(host, slot);
    const prev = s.getCleanup();
    if (prev) {
        try {
            prev();
        } catch (_) {
            /* ignore */
        }
        s.setCleanup(null);
    }
    s.setCleanup(
        attachKspacePlaneInteraction(containerEl, chart, {
            isChartOk: () => {
                const c = s.getChart();
                return c && !c.disposed;
            },
            getView: () => s.getAxisView(),
            setView: (v) => s.setAxisView(v),
            ensureView: () => {
                const payload = s.getLastPayload();
                if (payload) ensureKspaceAxisView(host, payload, slot);
                return s.getAxisView();
            },
            applyView: (c, v) => {
                const series = s.getSeriesBase();
                applyPlaneChartView(c, v, series, 'kx (1/m)', 'ky (1/m)');
            },
        }),
    );
}

function attachKspaceInteraction(host, containerEl, chart) {
    attachKspaceKySlotInteraction(host, containerEl, chart, 'xy');
}

function attachKspaceYzInteraction(host, containerEl, chart) {
    if (host._kspaceYzInteractionCleanup) {
        try {
            host._kspaceYzInteractionCleanup();
        } catch (_) {
            /* ignore */
        }
        host._kspaceYzInteractionCleanup = null;
    }
    host._kspaceYzInteractionCleanup = attachKspacePlaneInteraction(containerEl, chart, {
        isChartOk: () => host._kspaceYzChart && !host._kspaceYzChart.disposed,
        getView: () => host._kspaceYzAxisView,
        setView: (v) => {
            host._kspaceYzAxisView = v;
        },
        ensureView: () => ensureKspaceYzAxisView(host, host._lastKspaceYzPayload),
        applyView: (c, v) => applyPlaneChartView(c, v, host._kspaceYzSeriesBase, 'ky (1/m)', 'kz (1/m)'),
    });
}

/**
 * @param {*} host
 * @param {HTMLElement} containerEl
 * @param {*} ctx WebGPU context
 * @param {*} payload
 * @param {{ slot?: string, interact?: boolean }} [renderOpts] `slot` defaults to `xy` (zoom-linked panel)
 */
export async function renderKspaceChartGpu(host, containerEl, ctx, payload, renderOpts = {}) {
    const slot = renderOpts.slot || 'xy';
    const interact = renderOpts.interact !== false;
    const s = getKspaceKySlot(host, slot);

    const prevCleanup = s.getCleanup();
    if (prevCleanup) {
        try {
            prevCleanup();
        } catch (_) {
            /* ignore */
        }
        s.setCleanup(null);
    }
    const prevChart = s.getChart();
    if (prevChart) {
        try {
            prevChart.dispose();
        } catch (_) {
            /* ignore */
        }
        s.setChart(null);
    }
    s.clearAxisView();
    s.clearSeriesBase();
    containerEl.innerHTML = '';
    if (!payload?.series?.length) {
        containerEl.innerHTML =
            '<div class="seq-chartgpu-fallback">No k-space data in this time window.</div>';
        return;
    }
    const mod = await import(/* @vite-ignore */ CHARTGPU_MODULE_URL);
    const ChartGPU = mod.ChartGPU;
    const theme = seqChartGpuLabTheme(mod.darkTheme, 10);
    const seriesBase = normalizeKspaceChartGpuSeries(payload.series);
    s.setSeriesBase(seriesBase);
    s.setLastPayload(payload);
    const axisView = ensureKspaceAxisView(host, payload, slot);
    const axisOpts = planeAxisChartOptions(axisView, 'kx (1/m)', 'ky (1/m)');
    try {
        const chart = await ChartGPU.create(
            containerEl,
            {
                theme,
                animation: false,
                legend: { show: false },
                grid: KSPACE_GRID,
                ...axisOpts,
                tooltip: { show: true },
                series: seriesBase,
            },
            ctx,
        );
        s.setChart(chart);
        if (interact) {
            attachKspaceKySlotInteraction(host, containerEl, chart, slot);
        }
    } catch (e) {
        console.error(e);
        containerEl.innerHTML =
            '<div class="seq-chartgpu-fallback">ChartGPU failed to render k-space (kx–ky).</div>';
    }
}

export async function renderKspaceYzChart(host, containerEl, ctx, tLo, tHi, payloadOverride) {
    if (host._kspaceYzInteractionCleanup) {
        try {
            host._kspaceYzInteractionCleanup();
        } catch (_) {
            /* ignore */
        }
        host._kspaceYzInteractionCleanup = null;
    }
    if (host._kspaceYzChart) {
        try {
            host._kspaceYzChart.dispose();
        } catch (_) {
            /* ignore */
        }
        host._kspaceYzChart = null;
    }
    host._kspaceYzAxisView = null;
    host._kspaceYzSeriesBase = null;
    containerEl.innerHTML = '';
    const payload = payloadOverride ?? buildKspaceYzPayloadTime(host._kspaceCache, tLo, tHi, host);
    if (!payload.series.length) {
        containerEl.innerHTML =
            '<div class="seq-chartgpu-fallback">No ky–kz data in this time window.</div>';
        return;
    }
    const mod = await import(/* @vite-ignore */ CHARTGPU_MODULE_URL);
    const ChartGPU = mod.ChartGPU;
    const theme = seqChartGpuLabTheme(mod.darkTheme, 10);
    host._kspaceYzSeriesBase = normalizeKspaceChartGpuSeries(payload.series);
    host._lastKspaceYzPayload = payload;
    const axisView = ensureKspaceYzAxisView(host, payload);
    const axisOpts = planeAxisChartOptions(axisView, 'ky (1/m)', 'kz (1/m)');
    try {
        host._kspaceYzChart = await ChartGPU.create(
            containerEl,
            {
                theme,
                animation: false,
                legend: { show: false },
                grid: KSPACE_GRID,
                ...axisOpts,
                tooltip: { show: true },
                series: host._kspaceYzSeriesBase,
            },
            ctx,
        );
        attachKspaceYzInteraction(host, containerEl, host._kspaceYzChart);
    } catch (e) {
        console.error(e);
        containerEl.innerHTML =
            '<div class="seq-chartgpu-fallback">ChartGPU failed to render k-space (ky–kz).</div>';
    }
}

export async function refreshKspaceForSeqWindow(host) {
    if (!host._kspaceCache || !host._seqDispTimeRange) return;
    const charts = host._seqChartGpuCharts;
    if (!charts?.length) return;
    const win = getTimeWindowFromZoom(host);
    if (!win) return;
    const { tLo, tHi } = win;
    const payload = buildKspacePayloadTime(host._kspaceCache, tLo, tHi, host);
    if (!payload?.series?.length) {
        host._lastKspacePayload = payload;
        if (host._kspaceChart && !host._kspaceChart.disposed) {
            try {
                host._kspaceChart.setOption({
                    ...planeAxisChartOptions(host._kspaceAxisView, 'kx (1/m)', 'ky (1/m)'),
                    series: [],
                });
            } catch (_) {
                /* ignore */
            }
        }
        return;
    }
    host._kspaceSeriesBase = normalizeKspaceChartGpuSeries(payload.series);
    host._lastKspacePayload = payload;
    if (!host._kspaceAxisView) ensureKspaceAxisView(host, payload);
    if (host._kspaceChart && !host._kspaceChart.disposed) {
        applyPlaneChartView(host._kspaceChart, host._kspaceAxisView, host._kspaceSeriesBase, 'kx (1/m)', 'ky (1/m)');
    }
    const yzPayload = buildKspaceYzPayloadTime(host._kspaceCache, tLo, tHi, host);
    host._kspaceYzSeriesBase = normalizeKspaceChartGpuSeries(yzPayload.series);
    host._lastKspaceYzPayload = yzPayload;
    if (!host._kspaceYzAxisView) ensureKspaceYzAxisView(host, yzPayload);
    if (host._kspaceYzChart && !host._kspaceYzChart.disposed && yzPayload.series.length) {
        applyPlaneChartView(
            host._kspaceYzChart,
            host._kspaceYzAxisView,
            host._kspaceYzSeriesBase,
            'ky (1/m)',
            'kz (1/m)',
        );
    }
}

/**
 * @param {*} host
 * @param {{ onAfterWindowRefresh?: (w: { tLo: number, tHi: number }) => void | Promise<void> }} [options]
 */
export function attachSeqZoomToKspaceSync(host, options = {}) {
    const { onAfterWindowRefresh } = options;
    detachSeqZoomKspaceListener(host);
    const charts = host._seqChartGpuCharts;
    if (!charts?.length || !host._seqDispTimeRange) return;
    let debounce = 0;
    const onZoom = () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
            void (async () => {
                await refreshKspaceForSeqWindow(host);
                if (onAfterWindowRefresh) {
                    const w = getTimeWindowFromZoom(host);
                    if (w) await onAfterWindowRefresh(w);
                }
            })();
        }, KSPACE_ZOOM_DEBOUNCE_MS);
    };
    const unsubs = [];
    for (const c of charts) {
        c.on('zoomRangeChange', onZoom);
        unsubs.push(() => {
            try {
                c.off('zoomRangeChange', onZoom);
            } catch (_) {
                /* ignore */
            }
        });
    }
    host._seqZoomKspaceCleanup = () => {
        clearTimeout(debounce);
        for (const u of unsubs) u();
        host._seqZoomKspaceCleanup = null;
    };
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            void (async () => {
                await refreshKspaceForSeqWindow(host);
                if (onAfterWindowRefresh) {
                    const w = getTimeWindowFromZoom(host);
                    if (w) await onAfterWindowRefresh(w);
                }
            })();
        });
    });
}

/**
 * seq_check_web: mount kx–ky / ky–kz panels and wire zoom sync.
 * @param {*} host
 * @param {*} pyodide
 * @param {HTMLElement} kxyEl
 * @param {HTMLElement} kyzEl
 * @param {{ onAfterWindowRefresh?: Function }} [options]
 */
export async function setupSeqCheckKspacePanels(host, pyodide, kxyEl, kyzEl, options = {}) {
    if (!host._kspaceCache || !host._seqDispTimeRange) {
        console.warn('[seq_check] k-space panels skipped:', {
            hasCache: !!host._kspaceCache,
            hasDispRange: !!host._seqDispTimeRange,
        });
        return;
    }
    const [t0, t1] = host._seqDispTimeRange;
    const ctx =
        host._seqChartGpuDevice && host._seqChartGpuAdapter
            ? { adapter: host._seqChartGpuAdapter, device: host._seqChartGpuDevice }
            : undefined;
    const kPayload = buildKspacePayloadTime(host._kspaceCache, t0, t1, host);
    await renderKspaceChartGpu(host, kxyEl, ctx, kPayload);
    await renderKspaceYzChart(host, kyzEl, ctx, t0, t1);
    attachSeqZoomToKspaceSync(host, options);
}

/** Display time span [t0, t1] in seconds from ChartGPU export (before payload is dropped for GC). */
export function extractSeqDispTimeRange(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const xr = payload.xRange;
    if (Array.isArray(xr) && xr.length >= 2 && Number.isFinite(xr[0]) && Number.isFinite(xr[1])) {
        return [xr[0], xr[1]];
    }
    const p0 = payload.panels?.[0]?.x;
    if (p0 && Number.isFinite(p0.min) && Number.isFinite(p0.max) && p0.max > p0.min) {
        return [p0.min, p0.max];
    }
    return null;
}

async function setupKspacePanels(host, plotRoot, pyodide, plotContainer, seqDispTimeRange) {
    if (!isShowKspaceChecked(plotRoot)) return;
    if (!seqDispTimeRange) return;
    host._seqDispTimeRange = seqDispTimeRange;

    let cacheJson;
    try {
        cacheJson = await pyodide.runPythonAsync('import json; export_kspace_cache_json()');
    } catch (e) {
        console.error('k-space cache export failed:', e);
        return;
    }
    host._kspaceCache = JSON.parse(String(cacheJson));
    if (host._kspaceCache?.error) {
        const [ktr0, ktr1] = host._seqDispTimeRange || [0, 60];
        try {
            await pyodide.runPythonAsync(`
from seq_source_manager import SourceManager
import __main__
seq = getattr(SourceManager, '_last_sequence', None)
if seq is None:
    seq = getattr(__main__, 'seq', None)
if seq is not None:
    ensure_kspace_cache(seq, time_range=(${ktr0}, ${ktr1}))
`);
            cacheJson = await pyodide.runPythonAsync('import json; export_kspace_cache_json()');
            host._kspaceCache = JSON.parse(String(cacheJson));
        } catch (e) {
            console.error('k-space cache build failed:', e);
            return;
        }
        if (host._kspaceCache?.error) {
            console.warn('k-space cache:', host._kspaceCache.error);
            return;
        }
    }

    const [t0, t1] = host._seqDispTimeRange;
    const ctx =
        host._seqChartGpuDevice && host._seqChartGpuAdapter
            ? { adapter: host._seqChartGpuAdapter, device: host._seqChartGpuDevice }
            : undefined;

    const kxyEl = plotContainer.querySelector('#seq-kspace-xy');
    const kyzEl = plotContainer.querySelector('#seq-kspace-yz');
    if (!kxyEl || !kyzEl) return;

    const kPayload = buildKspacePayloadTime(host._kspaceCache, t0, t1);
    await renderKspaceChartGpu(host, kxyEl, ctx, kPayload);
    await renderKspaceYzChart(host, kyzEl, ctx, t0, t1);
    attachSeqZoomToKspaceSync(host);
}

/**
 * Load ChartGPU and render stacked panels from Python export (plot_speed chartgpu).
 * @param {*} host SequenceExplorer instance (mutated: `_seqChartGpu*` fields).
 * @param {HTMLElement | null} plotRoot
 * @param {*} pyodide
 * @param {HTMLElement} plotContainer mount for #seq-chartgpu-stack
 */
export async function renderSeqChartGpuAfterPlot(host, plotRoot, pyodide, plotContainer) {
    await disposeSeqChartGpuHost(host);
    const darkCb = plotRoot?.querySelector('#seq-dark-plot-checkbox');
    const showKspace = isShowKspaceChecked(plotRoot);
    const wantsDark = darkCb ? darkCb.checked : true;

    if (!navigator.gpu) {
        plotContainer.innerHTML =
            '<div class="seq-chartgpu-fallback">WebGPU is required for ChartGPU (e.g. Chrome 113+, Edge 113+, Safari 18+). This browser does not expose <code>navigator.gpu</code>.</div>';
        return;
    }

    let jsonStr;
    try {
        jsonStr = await pyodide.runPythonAsync('get_chartgpu_payload_json()');
    } catch (e) {
        console.error('ChartGPU payload fetch failed:', e);
        plotContainer.innerHTML =
            '<div class="seq-chartgpu-fallback">Could not read ChartGPU export from Python (is seq_plot_utils loaded?).</div>';
        return;
    }

    let payload;
    try {
        payload = jsonStr === 'null' ? null : JSON.parse(jsonStr);
    } catch (e) {
        plotContainer.innerHTML = '<div class="seq-chartgpu-fallback">Invalid ChartGPU JSON from Python.</div>';
        return;
    }
    jsonStr = null;

    if (!payload || !Array.isArray(payload.panels) || payload.panels.length === 0) {
        plotContainer.innerHTML =
            '<div class="seq-chartgpu-fallback">No sequence data to plot (ChartGPU export empty or sequence missing).</div>';
        return;
    }

    let ChartGPU;
    let createPipelineCache;
    let connectCharts;
    let darkTheme;
    let lightTheme;
    try {
        const mod = await import(/* @vite-ignore */ CHARTGPU_MODULE_URL);
        ChartGPU = mod.ChartGPU;
        createPipelineCache = mod.createPipelineCache;
        connectCharts = mod.connectCharts;
        darkTheme = mod.darkTheme;
        lightTheme = mod.lightTheme;
    } catch (e) {
        console.error('ChartGPU import failed:', e);
        plotContainer.innerHTML =
            '<div class="seq-chartgpu-fallback">Failed to load ChartGPU from CDN (esm.sh). Check network or try another plot mode.</div>';
        await releaseChartgpuPythonPayload(pyodide);
        return;
    }

    if (!ChartGPU || typeof ChartGPU.create !== 'function') {
        plotContainer.innerHTML = '<div class="seq-chartgpu-fallback">ChartGPU module did not export ChartGPU.create.</div>';
        await releaseChartgpuPythonPayload(pyodide);
        return;
    }

    try {
    plotContainer.innerHTML = showKspace
        ? `<div class="seq-plot-with-kspace">
<div class="seq-plot-col-waveforms">
<div id="seq-chartgpu-stack" class="seq-chartgpu-stack"></div>
</div>
<aside class="seq-plot-col-kspace">
<div id="seq-kspace-xy" class="seq-kspace-panel"></div>
<div id="seq-kspace-yz" class="seq-kspace-panel"></div>
</aside>
</div>`
        : `<div id="seq-chartgpu-stack" class="seq-chartgpu-stack"></div>`;
    const stack = plotContainer.querySelector('#seq-chartgpu-stack');
    const panels = payload.panels;
    const n = panels.length;
    const hosts = [];
    for (let i = 0; i < n; i++) {
        const h = document.createElement('div');
        h.className = 'seq-chartgpu-panel';
        h.id = `seq-chartgpu-panel-${i}`;
        stack.appendChild(h);
        hosts.push(h);
    }

    // Omit powerPreference: on Windows Chromium ignores it and logs a warning (crbug.com/369219127).
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        plotContainer.innerHTML =
            '<div class="seq-chartgpu-fallback">WebGPU adapter could not be created (GPU busy or blocked). Retry or switch plot mode. For large sequences, try a <strong>shorter sequence</strong> or a <strong>limited time range</strong> (when your code supports it).</div>';
        await releaseChartgpuPythonPayload(pyodide);
        return;
    }
    const device = await adapter.requestDevice();
    host._seqChartGpuAdapter = adapter;
    host._seqChartGpuDevice = device;
    const pipelineCache = typeof createPipelineCache === 'function' ? createPipelineCache(device) : undefined;

    const wantsDarkResolved = payload.isDark !== undefined ? payload.isDark : wantsDark;
    /** Default ChartGPU theme uses 12px; titles use ic(fontSize) and stay slightly larger. */
    const CHARTGPU_SEQ_FONT_PX = 10;
    let theme;
    if (darkTheme && lightTheme && typeof darkTheme === 'object' && typeof lightTheme === 'object') {
        const base = wantsDarkResolved ? darkTheme : lightTheme;
        theme = wantsDarkResolved
            ? seqChartGpuLabTheme(base, CHARTGPU_SEQ_FONT_PX)
            : { ...base, fontSize: CHARTGPU_SEQ_FONT_PX };
    } else {
        theme = wantsDarkResolved ? 'dark' : 'light';
    }
    // ChartGPU default minSpan is dataset-derived (larger N → smaller minSpan). Gradient panels
    // have many more x samples than ADC/RF, so default zoom limits differ per row. One explicit
    // minSpan keeps max zoom-in identical across all six charts (and matches lockstep setZoomRange).
    const ZOOM_MIN_SPAN = 0.008;
    /** Time slider height (ECharts-style `height`). */
    const CHARTGPU_SLIDER_H = 8;
    /** Bottom grid margin for x-axis labels + slider (paired with CHARTGPU_SLIDER_H). */
    const CHARTGPU_BOTTOM_GRID = 23;

    // Align all rows to the same x span without xAxis.min/max: ChartGPU uses explicit min/max
    // for value-axis *tick* domain, so zoom does not refresh tick labels. Instead, append an
    // invisible two-point line at a padded [xMin,xMax] so wheel zoom-out can show margins beyond
    // the sequence; initial zoom is set to the unpadded display window (see seqChartGpuInitialZoomPct).
    let sharedXExtent = null;
    {
        const xrPanel = panels[0] && panels[0].x;
        const xrFlat = payload.xRange;
        let xMin;
        let xMax;
        if (xrPanel && Number.isFinite(xrPanel.min) && Number.isFinite(xrPanel.max) && xrPanel.max > xrPanel.min) {
            xMin = xrPanel.min;
            xMax = xrPanel.max;
        } else if (
            Array.isArray(xrFlat) &&
            xrFlat.length >= 2 &&
            Number.isFinite(xrFlat[0]) &&
            Number.isFinite(xrFlat[1]) &&
            xrFlat[1] > xrFlat[0]
        ) {
            xMin = xrFlat[0];
            xMax = xrFlat[1];
        }
        if (xMin !== undefined && xMax !== undefined) {
            const padded = chartGpuPaddedXBounds(xMin, xMax, SEQ_CHARTGPU_ZOOM_PAD_FRACTION);
            sharedXExtent = { min: padded.min, max: padded.max };
            host._seqChartZoomPadFraction = SEQ_CHARTGPU_ZOOM_PAD_FRACTION;
        } else {
            host._seqChartZoomPadFraction = 0;
        }
    }

    /** ChartGPU background grid: vertical line count (evenly spaced in plot; not axis ticks). */
    const CHARTGPU_GRID_LINES_VERTICAL = 5;

    const chartCreatePromises = [];
    /** Full ChartGPU.create options per panel; setOption replaces the whole config (see chartgpu source). */
    const chartUserOpts = [];
    const ctx = pipelineCache ? { adapter, device, pipelineCache } : { adapter, device };
    for (let i = 0; i < n; i++) {
        const panel = panels[i];
        const isBottom = i === n - 1;
        let series = normalizeChartGpuSeries(panel.series);
        if (sharedXExtent) {
            const yAnchor = chartGpuYAnchorForExtentHelper(series);
            series = chartGpuWithSharedXExtentSeries(
                series,
                sharedXExtent.min,
                sharedXExtent.max,
                yAnchor,
            );
        }
        const dataZoom = isBottom
            ? [
                  { type: 'inside', minSpan: ZOOM_MIN_SPAN },
                  { type: 'slider', minSpan: ZOOM_MIN_SPAN, height: CHARTGPU_SLIDER_H },
              ]
            : [{ type: 'inside', minSpan: ZOOM_MIN_SPAN }];
        const xAxis = isBottom
            ? { name: `t (${payload.timeUnit || ''})` }
            : { tickFormatter: () => null, tickLength: 0 };
        // ChartGPU defaults use top/bottom 40px each — with ~90px-tall panes the plot grid
        // collapses (~12px). Tight margins + extra bottom on last row for x-axis + slider.
        // Left margin ~20% wider than 50px; bottom margin trimmed slightly when slider is shorter.
        const grid = isBottom
            ? { left: 60, right: 6, top: 4, bottom: CHARTGPU_BOTTOM_GRID }
            : { left: 60, right: 6, top: 4, bottom: 4 };
        const opts = {
            theme,
            animation: false,
            legend: { show: false },
            grid,
            gridLines: { vertical: { count: CHARTGPU_GRID_LINES_VERTICAL } },
            // Bottom chart: full x-axis title + ticks. Upper charts: no x tick labels (shared time axis).
            xAxis,
            yAxis: {
                name: panel.title || '',
                tickFormatter: formatYTick3SigDigits,
            },
            dataZoom,
            tooltip: { show: false },
            series,
        };
        chartUserOpts.push(opts);
        chartCreatePromises.push(ChartGPU.create(hosts[i], opts, ctx));
    }
    const seqDispTimeRange = extractSeqDispTimeRange(payload);
    if (seqDispTimeRange) host._seqDispTimeRange = seqDispTimeRange;
    payload = null;
    const settled = await Promise.allSettled(chartCreatePromises);
    const charts = [];
    for (let si = 0; si < settled.length; si++) {
        const r = settled[si];
        if (r.status !== 'fulfilled') {
            for (const c of charts) {
                try {
                    c.dispose();
                } catch (_) {
                    /* ignore */
                }
            }
            console.error('ChartGPU.create failed:', r.reason);
            await disposeSeqChartGpuHost(host);
            await releaseChartgpuPythonPayload(pyodide);
            plotContainer.innerHTML =
                '<div class="seq-chartgpu-fallback">ChartGPU failed to build one or more waveform panels. Try another plot mode or reload the page. For large sequences, try a <strong>shorter sequence</strong> or a <strong>limited time range</strong> (when your code supports it).</div>';
            return;
        }
        charts.push(r.value);
    }
    host._seqChartGpuCharts = charts;

    let gpuSessionDead = false;
    let zoomRaf = 0;
    /** @type {{ start: number; end: number } | null} */
    let pendingZoom = null;

    const failChartGpuSession = async (reason, detail) => {
        if (gpuSessionDead) return;
        gpuSessionDead = true;
        if (zoomRaf) {
            cancelAnimationFrame(zoomRaf);
            zoomRaf = 0;
        }
        pendingZoom = null;
        const detailStr =
            detail != null && typeof detail === 'object' && 'message' in detail
                ? String(detail.message)
                : String(detail ?? '');
        if (reason === 'device-lost') {
            console.warn('[seq ChartGPU] session ended (device lost):', detailStr || '(no message)');
        } else {
            console.error('[seq ChartGPU] session ended:', reason, detail);
        }
        try {
            await disposeSeqChartGpuHost(host);
        } catch (e) {
            /* ignore */
        }
        if (plotContainer?.isConnected) {
            plotContainer.innerHTML =
                '<div class="seq-chartgpu-fallback">WebGPU closed the chart session (driver stress or validation). Use <strong>plot seq</strong> again or switch plot mode. If this keeps happening, try a <strong>shorter sequence</strong> or plotting only a <strong>limited time range</strong> (when your code supports it).</div>';
        }
        await releaseChartgpuPythonPayload(pyodide);
    };

    let lostCbActive = true;
    const onGpuUncaptured = (ev) => {
        try {
            ev?.preventDefault?.();
        } catch (_) {
            /* ignore */
        }
        const err = ev?.error;
        console.error('WebGPU uncapturederror:', err);
        void failChartGpuSession('uncapturederror', err);
    };
    device.addEventListener('uncapturederror', onGpuUncaptured);
    device.lost.then(
        (info) => {
            if (!lostCbActive) return;
            lostCbActive = false;
            const msg = info && typeof info.message === 'string' ? info.message : String(info ?? '');
            void failChartGpuSession('device-lost', msg);
        },
        () => {},
    );
    host._seqChartGpuRemoveDeviceListeners = () => {
        lostCbActive = false;
        try {
            device.removeEventListener('uncapturederror', onGpuUncaptured);
        } catch (_) {
            /* ignore */
        }
    };

    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    for (const c of charts) {
        try {
            c.resize();
        } catch (e) {
            /* ignore */
        }
    }

    let disconnectCrosshair = null;
    if (typeof connectCharts === 'function' && charts.length > 1) {
        try {
            disconnectCrosshair = connectCharts(charts, {
                syncCrosshair: true,
                syncZoom: false,
            });
        } catch (e) {
            console.warn('connectCharts failed:', e);
        }
    }

    const SEQ_ZOOM_SYNC = Symbol('seqExplorerChartGpuZoomLockstep');
    const zoomUnsubs = [];
    const doBroadcastZoomToAll = (start, end) => {
        if (gpuSessionDead) return;
        for (const c of charts) {
            if (c.disposed) continue;
            let cur = null;
            try {
                cur = c.getZoomRange();
            } catch (e) {
                /* ignore */
                continue;
            }
            if (
                cur &&
                Math.abs(cur.start - start) < 1e-4 &&
                Math.abs(cur.end - end) < 1e-4
            ) {
                continue;
            }
            try {
                c.setZoomRange(start, end, SEQ_ZOOM_SYNC);
            } catch (e) {
                /* ignore */
            }
        }
    };
    const scheduleBroadcastZoomToAll = (start, end) => {
        if (gpuSessionDead) return;
        pendingZoom = { start, end };
        if (!zoomRaf) {
            zoomRaf = requestAnimationFrame(() => {
                zoomRaf = 0;
                if (gpuSessionDead || !pendingZoom) return;
                const z = pendingZoom;
                pendingZoom = null;
                doBroadcastZoomToAll(z.start, z.end);
            });
        }
    };
    const onZoomRangeChange = (payload) => {
        try {
            if (gpuSessionDead) return;
            if (payload.source === SEQ_ZOOM_SYNC) return;
            if (payload.sourceKind === 'auto-scroll') return;
            const start = Number(payload.start);
            const end = Number(payload.end);
            if (!Number.isFinite(start) || !Number.isFinite(end)) return;
            scheduleBroadcastZoomToAll(start, end);
        } catch (e) {
            console.warn('zoomRangeChange handler:', e);
        }
    };
    for (const c of charts) {
        c.on('zoomRangeChange', onZoomRangeChange);
        zoomUnsubs.push(() => {
            try {
                c.off('zoomRangeChange', onZoomRangeChange);
            } catch (e) {
                /* ignore */
            }
        });
    }
    if (charts.length > 0) {
        const initZoom = seqChartGpuInitialZoomPct(host._seqChartZoomPadFraction || 0);
        doBroadcastZoomToAll(initZoom.start, initZoom.end);
    }

    // ChartGPU 0.3.x only pans x-zoom with Shift+left or middle button. Add plain left-drag pan
    // after a small move threshold so tiny jitters do not start a pan.
    const leftDragPanRemoves = [];
    {
        const DRAG_THRESHOLD = 5;
        const panState = {
            phase: 'idle',
            chartIdx: 0,
            startClientX: 0,
            startClientY: 0,
            lastClientX: 0,
            pointerId: -1,
            captureEl: null,
            didPan: false,
        };

        const removeWindowPanListeners = () => {
            window.removeEventListener('pointermove', onPanPointerMove);
            window.removeEventListener('pointerup', stopLeftPan);
            window.removeEventListener('pointercancel', stopLeftPan);
        };

        const applyPanDeltaPx = (rawD, chartIdx) => {
            if (gpuSessionDead) return;
            if (!Number.isFinite(rawD) || rawD === 0) return;
            const anchorCh = charts[chartIdx] || charts[0];
            if (!anchorCh || anchorCh.disposed) return;
            const cnv = panState.captureEl;
            if (!cnv) return;
            const gr = chartUserOpts[chartIdx]?.grid || {};
            const rect = cnv.getBoundingClientRect();
            const plotW = rect.width - (gr.left || 0) - (gr.right || 0);
            if (!(plotW > 0)) return;
            let cur = null;
            try {
                cur = anchorCh.getZoomRange();
            } catch (e) {
                return;
            }
            if (!cur) return;
            const span = cur.end - cur.start;
            if (!Number.isFinite(span) || span <= 0) return;
            const P = -(rawD / plotW) * span;
            if (!Number.isFinite(P) || P === 0) return;
            let ns = cur.start + P;
            let ne = cur.end + P;
            if (ns < 0) {
                ne -= ns;
                ns = 0;
            }
            if (ne > 100) {
                const over = ne - 100;
                ns -= over;
                ne = 100;
            }
            if (ns < 0) ns = 0;
            if (ne <= ns) ne = Math.min(100, ns + span);
            scheduleBroadcastZoomToAll(ns, ne);
        };

        const stopLeftPan = () => {
            if (panState.phase === 'active' && panState.captureEl && panState.pointerId >= 0) {
                try {
                    panState.captureEl.releasePointerCapture(panState.pointerId);
                } catch (_) {
                    /* ignore */
                }
            }
            removeWindowPanListeners();
            panState.phase = 'idle';
            panState.captureEl = null;
            panState.pointerId = -1;
            panState.didPan = false;
        };

        const onPanPointerMove = (ev) => {
            if (panState.phase === 'idle' || ev.pointerId !== panState.pointerId) return;
            if (panState.phase === 'pending') {
                const dx = ev.clientX - panState.startClientX;
                const dy = ev.clientY - panState.startClientY;
                if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
                panState.phase = 'active';
                try {
                    panState.captureEl.setPointerCapture(ev.pointerId);
                } catch (_) {
                    /* ignore */
                }
                ev.preventDefault();
                const catchUp = ev.clientX - panState.startClientX;
                panState.lastClientX = ev.clientX;
                applyPanDeltaPx(catchUp, panState.chartIdx);
                panState.didPan = true;
                return;
            }
            if (panState.phase === 'active') {
                const rawD = ev.clientX - panState.lastClientX;
                panState.lastClientX = ev.clientX;
                if (!Number.isFinite(rawD) || rawD === 0) return;
                ev.preventDefault();
                applyPanDeltaPx(rawD, panState.chartIdx);
                panState.didPan = true;
            }
        };

        for (let i = 0; i < n; i++) {
            const canvas = hosts[i].querySelector('canvas');
            if (!canvas) continue;
            const onDown = (ev) => {
                if (gpuSessionDead) return;
                if (ev.button !== 0 || ev.shiftKey) return;
                const c = charts[i];
                if (!c || c.disposed) return;
                let ht = { isInGrid: false };
                try {
                    ht = c.hitTest(ev);
                } catch (e) {
                    return;
                }
                if (!ht.isInGrid) return;
                const gr = chartUserOpts[i]?.grid || {};
                const rect = canvas.getBoundingClientRect();
                const plotW = rect.width - (gr.left || 0) - (gr.right || 0);
                if (!(plotW > 0)) return;
                stopLeftPan();
                panState.phase = 'pending';
                panState.chartIdx = i;
                panState.startClientX = ev.clientX;
                panState.startClientY = ev.clientY;
                panState.lastClientX = ev.clientX;
                panState.pointerId = ev.pointerId;
                panState.captureEl = canvas;
                panState.didPan = false;
                window.addEventListener('pointermove', onPanPointerMove);
                window.addEventListener('pointerup', stopLeftPan);
                window.addEventListener('pointercancel', stopLeftPan);
            };
            canvas.addEventListener('pointerdown', onDown);
            leftDragPanRemoves.push(() => canvas.removeEventListener('pointerdown', onDown));
        }
        leftDragPanRemoves.push(stopLeftPan);
    }

    host._seqChartGpuDisconnect = () => {
        if (zoomRaf) {
            cancelAnimationFrame(zoomRaf);
            zoomRaf = 0;
        }
        pendingZoom = null;
        for (const fn of leftDragPanRemoves) {
            try {
                fn();
            } catch (e) {
                /* ignore */
            }
        }
        if (disconnectCrosshair) {
            try {
                disconnectCrosshair();
            } catch (e) {
                /* ignore */
            }
        }
        for (const u of zoomUnsubs) {
            try {
                u();
            } catch (e) {
                /* ignore */
            }
        }
    };
    await setupKspacePanels(host, plotRoot, pyodide, plotContainer, seqDispTimeRange);
    await releaseChartgpuPythonPayload(pyodide);
    await releaseKspaceCache(pyodide);
    } catch (renderErr) {
        console.error('ChartGPU render failed:', renderErr);
        await disposeSeqChartGpuHost(host);
        await releaseChartgpuPythonPayload(pyodide);
        plotContainer.innerHTML =
            '<div class="seq-chartgpu-fallback">ChartGPU failed to initialize (WebGPU or library error). Try another plot mode or reload the page. For large sequences, try a <strong>shorter sequence</strong> or a <strong>limited time range</strong> (when your code supports it).</div>';
    }
}

/**
 * Python fragments for `seq.plot` inside `buildExecuteScript` (chartgpu vs matplotlib).
 * @param {{ silent: boolean, plotSpeed: string, debug?: boolean }} opts
 * @returns {{ plotBlock: string, chartgpuClearPy: string }}
 */
export function buildSeqPlotExecuteFragments(opts) {
    const { silent, plotSpeed, debug = false, showKspace = false, timeRange = [0, 100] } = opts;
    let t0 = Number(timeRange[0]);
    let t1 = Number(timeRange[1]);
    if (!Number.isFinite(t0)) t0 = 0;
    if (!Number.isFinite(t1)) t1 = 100;
    const timeRangePy = `time_range=(${t0}, ${t1})`;
    const kspaceAfterPlot =
        showKspace && !silent
            ? `\n        ensure_kspace_cache(seq, ${timeRangePy})`
            : '';
    const plotBlockChartgpu = debug
        ? `if seq is not None:\n    print(f"PYTHON (popup): Calling seq.plot(plot_speed='chartgpu')")\n    plt.close('all')\n    seq.plot(plot_now=False, plot_speed="chartgpu", ${timeRangePy})\n    print("PYTHON (popup): ChartGPU export done (no plt.show)")${kspaceAfterPlot}\nelse:\n    print("PYTHON ERROR (popup): No sequence found")`
        : `if seq is not None:\n    if not ${silent ? 'True' : 'False'}:\n        plt.close('all')\n        seq.plot(plot_now=False, plot_speed="chartgpu", ${timeRangePy})${kspaceAfterPlot}\n    else:\n        print("Sequence generated (silent mode)")\nelse:\n    print("No sequence found")`;

    const plotBlockMpl = debug
        ? `if seq is not None:\n    print(f"PYTHON (popup): Calling seq.plot(plot_speed='${plotSpeed}')")\n    plt.close('all')\n    seq.plot(plot_now=False, plot_speed="${plotSpeed}", ${timeRangePy})\n    print("PYTHON (popup): Plot command finished, calling plt.show()")\n    plt.show()\n    print("PYTHON (popup): plt.show() returned")\nelse:\n    print("PYTHON ERROR (popup): No sequence found")`
        : `if seq is not None:\n    if not ${silent ? 'True' : 'False'}:\n        plt.close('all')\n        seq.plot(plot_now=False, plot_speed="${plotSpeed}", ${timeRangePy})\n        plt.show()\n    else:\n        print("Sequence generated (silent mode)")\nelse:\n    print("No sequence found")`;

    const plotBlock = plotSpeed === 'chartgpu' ? plotBlockChartgpu : plotBlockMpl;

    const chartgpuClearPy =
        plotSpeed === 'chartgpu'
            ? 'import __main__\nsetattr(__main__, \'_chartgpu_last_payload\', None)\nclear_kspace_cache()\n'
            : '';
    return { plotBlock, chartgpuClearPy };
}
