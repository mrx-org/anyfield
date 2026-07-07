/**
 * Fig 6 — sim k-space coverage + windowed NUFFT recon (Niivue mag/phase).
 */

import { SeqCheckNiivue } from './seq_check_niivue.js';
import { trajIndicesForAdcTimeWindow } from './seq_check_adc_window.js';
import { colormapHex, disposeKspaceKySlot, renderKspaceChartGpu } from '../seq_plot.js';

/** ADC scatter color by log-magnitude: 'viridis' | 'parula' */
const FIG6_MAG_COLORMAP = 'viridis';

/**
 * @param {{ traj: number[][], signal: number[][], nSamples: number }} simCache
 * @param {{ t_adc?: number[], kx_adc?: number[], ky_adc?: number[] } | null} kspaceCache
 * @param {{ tLo: number, tHi: number } | null} [window]
 */
function buildFig6KspacePayload(simCache, kspaceCache, window = null) {
    const traj = simCache.traj;
    const sig = simCache.signal;
    const n = Math.min(traj.length, sig.length);
    const rowIdx = window ? trajIndicesForAdcTimeWindow(simCache, kspaceCache, window) : null;
    const pts = [];
    const colors = [];
    let kxLo = Infinity;
    let kxHi = -Infinity;
    let kyLo = Infinity;
    let kyHi = -Infinity;
    const visit = (i) => {
        if (i < 0 || i >= n) return;
        const kx = traj[i][0];
        const ky = traj[i][1] ?? 0;
        if (!Number.isFinite(kx) || !Number.isFinite(ky)) return;
        const re = sig[i][0];
        const im = sig[i][1];
        const mag = Math.log(Math.hypot(re, im) + 1);
        pts.push([kx, ky]);
        colors.push(mag);
        if (kx < kxLo) kxLo = kx;
        if (kx > kxHi) kxHi = kx;
        if (ky < kyLo) kyLo = ky;
        if (ky > kyHi) kyHi = ky;
    };
    if (rowIdx?.length) {
        for (const i of rowIdx) visit(i);
    } else if (!window) {
        for (let i = 0; i < n; i++) visit(i);
    }
    if (!pts.length) return null;
    let cmin = colors[0];
    let cmax = colors[0];
    for (const c of colors) {
        if (c < cmin) cmin = c;
        if (c > cmax) cmax = c;
    }
    const span = cmax - cmin || 1;
    const nBins = 32;
    const bins = Array.from({ length: nBins }, () => []);
    const binMag = Array.from({ length: nBins }, () => []);
    for (let i = 0; i < pts.length; i++) {
        const t = (colors[i] - cmin) / span;
        const bi = Math.min(nBins - 1, Math.floor(t * nBins));
        bins[bi].push(pts[i]);
        binMag[bi].push(colors[i]);
    }
    const series = [];
    for (let bi = 0; bi < nBins; bi++) {
        if (!bins[bi].length) continue;
        let mAvg = 0;
        for (const m of binMag[bi]) mAvg += m;
        mAvg /= binMag[bi].length;
        const tColor = (mAvg - cmin) / span;
        series.push({
            type: 'scatter',
            data: bins[bi],
            kspaceRole: 'adc',
            kspaceColor: colormapHex(tColor, FIG6_MAG_COLORMAP),
            symbol: 'circle',
            symbolSize: 3,
        });
    }
    return {
        series,
        kxBounds: [kxLo, kxHi],
        kyBounds: [kyLo, kyHi],
    };
}

/**
 * @param {*} host
 * @param {HTMLElement} containerEl
 * @param {{ traj: number[][], signal: number[][], nSamples: number }} simCache
 * @param {{ t_adc?: number[], kx_adc?: number[], ky_adc?: number[] } | null} kspaceCache
 * @param {{ tLo: number, tHi: number } | null} [window]
 */
export async function renderFig6SimKspace(host, containerEl, simCache, kspaceCache, window = null) {
    disposeKspaceKySlot(host, 'fig6');
    if (!containerEl || !simCache?.traj?.length) {
        containerEl.innerHTML = '<div class="seq-chartgpu-fallback">No sim k-space data.</div>';
        return;
    }
    if (!navigator.gpu) {
        containerEl.innerHTML = '<div class="seq-chartgpu-fallback">WebGPU required.</div>';
        return;
    }
    const payload = buildFig6KspacePayload(simCache, kspaceCache, window);
    if (!payload?.series?.length) {
        containerEl.innerHTML =
            '<div class="seq-chartgpu-fallback">No sim ADC points in this time window.</div>';
        return;
    }
    const ctx =
        host._seqChartGpuDevice && host._seqChartGpuAdapter
            ? { adapter: host._seqChartGpuAdapter, device: host._seqChartGpuDevice }
            : undefined;
    await renderKspaceChartGpu(host, containerEl, ctx, payload, {
        slot: 'fig6',
        interact: true,
    });
}

function showReconPanelMessage(containerEl, msg) {
    if (!containerEl) return;
    containerEl.innerHTML = `<div class="seq-chartgpu-fallback">${msg}</div>`;
}

export function createFig6ReconController({ pyodide, pyClient, niivueContainer, metaEl, reconNav }) {
    const niivue = new SeqCheckNiivue(niivueContainer, reconNav);
    let draining = false;
    /** @type {{ tLo: number, tHi: number, rowIndices?: number[] } | null} */
    let pending = null;

    async function drainRefresh() {
        if (!pyodide || draining) return;
        draining = true;
        try {
            while (pending) {
                const { tLo: t0, tHi: t1, rowIndices } = pending;
                pending = null;
                let outJson;
                if (rowIndices?.length && pyClient) {
                    await pyClient.globalsSet(
                        '_fig6_recon_idx_json',
                        JSON.stringify(rowIndices),
                    );
                    outJson = await pyodide.runPythonAsync(
                        'recon_nufft_indices_json(_fig6_recon_idx_json)',
                    );
                } else if (rowIndices?.length) {
                    outJson = await pyodide.runPythonAsync(
                        `recon_nufft_indices_json(${JSON.stringify(rowIndices)})`,
                    );
                } else {
                    outJson = await pyodide.runPythonAsync(
                        `recon_nufft_window_json(${t0}, ${t1})`,
                    );
                }
                const out = JSON.parse(String(outJson));
                if (!out.ok) {
                    const reason = out.reason || 'no data';
                    showReconPanelMessage(niivueContainer, `NUFFT: ${reason}`);
                    if (metaEl) {
                        metaEl.hidden = false;
                        metaEl.textContent = `NUFFT: ${reason}`;
                    }
                    continue;
                }
                await niivue.showRecon(out);
                if (metaEl) {
                    if (out.niiError) {
                        metaEl.hidden = false;
                        metaEl.textContent = `nii: ${out.niiError}`;
                    } else {
                        metaEl.hidden = true;
                        metaEl.textContent = '';
                    }
                }
            }
        } catch (e) {
            console.error(e);
            showReconPanelMessage(niivueContainer, `NUFFT error: ${e?.message || e}`);
            if (metaEl) {
                metaEl.hidden = false;
                metaEl.textContent = `NUFFT error: ${e?.message || e}`;
            }
        } finally {
            draining = false;
            if (pending) void drainRefresh();
        }
    }

    return {
        niivue,
        refresh({ tLo, tHi, rowIndices }) {
            pending = { tLo, tHi, rowIndices };
            return drainRefresh();
        },
        dispose() {
            niivue.dispose();
        },
    };
}
