/**
 * Sequence waveform plotting: ChartGPU (`seq.plot(..., plot_speed='chartgpu')`) bridge and
 * Pyodide `seq.plot` script fragments. Chart/WebGPU state lives on the explorer `host` (`host._seqChartGpu*`).
 */

export const SEQ_DEFAULT_PLOT_SPEED = 'chartgpu';

/** Pinned ChartGPU ESM (see insights/SPEC_seq_plot.md). */
const CHARTGPU_MODULE_URL = 'https://esm.sh/chartgpu@0.3.2?target=es2022';

/**
 * Tear down ChartGPU charts and shared WebGPU device created for sequence plots.
 */
export async function disposeSeqChartGpuHost(host) {
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
    plotContainer.innerHTML = `
<div id="seq-chartgpu-stack" class="seq-chartgpu-stack">
</div>`;
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
        theme = { ...base, fontSize: CHARTGPU_SEQ_FONT_PX };
    } else {
        theme = wantsDarkResolved ? 'dark' : 'light';
    }
    // ChartGPU default minSpan is dataset-derived (larger N → smaller minSpan). Gradient panels
    // have many more x samples than ADC/RF, so default zoom limits differ per row. One explicit
    // minSpan keeps max zoom-in identical across all six charts (and matches lockstep setZoomRange).
    const ZOOM_MIN_SPAN = 0.008;
    /** Slider ~25% shorter than a typical default (~24px → 18px; ECharts-style `height`). */
    const CHARTGPU_SLIDER_H = 18;

    // Align all rows to the same x span without xAxis.min/max: ChartGPU uses explicit min/max
    // for value-axis *tick* domain, so zoom does not refresh tick labels. Instead, append an
    // invisible two-point line at the exported global [xMin,xMax] so auto x-bounds match while
    // ticks still derive from the visible zoom window (see createRenderCoordinator non-time branch).
    let sharedXExtent = null;
    {
        const xrPanel = panels[0] && panels[0].x;
        const xrFlat = payload.xRange;
        if (xrPanel && Number.isFinite(xrPanel.min) && Number.isFinite(xrPanel.max) && xrPanel.max > xrPanel.min) {
            sharedXExtent = { min: xrPanel.min, max: xrPanel.max };
        } else if (
            Array.isArray(xrFlat) &&
            xrFlat.length >= 2 &&
            Number.isFinite(xrFlat[0]) &&
            Number.isFinite(xrFlat[1]) &&
            xrFlat[1] > xrFlat[0]
        ) {
            sharedXExtent = { min: xrFlat[0], max: xrFlat[1] };
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
            ? { left: 60, right: 6, top: 4, bottom: 50 }
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
    const anchor = charts[charts.length - 1] || charts[0];
    let z0 = null;
    try {
        z0 = anchor?.getZoomRange?.();
    } catch (e) {
        /* ignore */
    }
    if (z0 && charts.length > 0) {
        doBroadcastZoomToAll(z0.start, z0.end);
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
    await releaseChartgpuPythonPayload(pyodide);
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
    const { silent, plotSpeed, debug = false } = opts;
    const plotBlockChartgpu = debug
        ? `if seq is not None:\n    print(f"PYTHON (popup): Calling seq.plot(plot_speed='chartgpu')")\n    plt.close('all')\n    seq.plot(plot_now=False, plot_speed="chartgpu")\n    print("PYTHON (popup): ChartGPU export done (no plt.show)")\nelse:\n    print("PYTHON ERROR (popup): No sequence found")`
        : `if seq is not None:\n    if not ${silent ? 'True' : 'False'}:\n        plt.close('all')\n        seq.plot(plot_now=False, plot_speed="chartgpu")\n    else:\n        print("Sequence generated (silent mode)")\nelse:\n    print("No sequence found")`;

    const plotBlockMpl = debug
        ? `if seq is not None:\n    print(f"PYTHON (popup): Calling seq.plot(plot_speed='${plotSpeed}')")\n    plt.close('all')\n    seq.plot(plot_now=False, plot_speed="${plotSpeed}")\n    print("PYTHON (popup): Plot command finished, calling plt.show()")\n    plt.show()\n    print("PYTHON (popup): plt.show() returned")\nelse:\n    print("PYTHON ERROR (popup): No sequence found")`
        : `if seq is not None:\n    if not ${silent ? 'True' : 'False'}:\n        plt.close('all')\n        seq.plot(plot_now=False, plot_speed="${plotSpeed}")\n        plt.show()\n    else:\n        print("Sequence generated (silent mode)")\nelse:\n    print("No sequence found")`;

    const plotBlock = plotSpeed === 'chartgpu' ? plotBlockChartgpu : plotBlockMpl;

    const chartgpuClearPy =
        plotSpeed === 'chartgpu'
            ? 'import __main__\nsetattr(__main__, \'_chartgpu_last_payload\', None)\n'
            : '';
    return { plotBlock, chartgpuClearPy };
}
