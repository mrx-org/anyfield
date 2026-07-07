/**
 * Fig 4 — ADC k-space: trajex vs reference (left), pypulseq vs reference (right).
 */

import { disposeKspaceKySlot, renderKspaceChartGpu } from '../seq_plot.js';

const REF_STYLE = { kspaceColor: '#888888', symbol: 'cross', symbolSize: 1 };
const TRAJEX_STYLE = { kspaceColor: '#00e5ff', symbol: 'circle', symbolSize: 0.5 };
const PP_STYLE = { kspaceColor: '#ff69b4', symbol: 'circle', symbolSize: 0.5 };

/**
 * Build expected Cartesian ADC grid in 1/m from FOV and matrix.
 * @param {{ fov_x: number, fov_y: number, Nx: number, Ny: number }} p
 */
export function buildExpectedAdcGrid(p) {
    const { fov_x: fx, fov_y: fy, Nx, Ny } = p;
    if (!(fx > 0 && fy > 0 && Nx > 0 && Ny > 0)) return [];
    const kxIdx =
        Nx % 2 === 0
            ? Array.from({ length: Nx }, (_, i) => i - Nx / 2)
            : Array.from({ length: Nx }, (_, i) => i - Math.floor(Nx / 2));
    const kyIdx =
        Ny % 2 === 0
            ? Array.from({ length: Ny }, (_, i) => i - Ny / 2)
            : Array.from({ length: Ny }, (_, i) => i - Math.floor(Ny / 2));
    const pts = [];
    for (const iy of kyIdx) {
        for (const ix of kxIdx) {
            pts.push([ix / fx, iy / fy]);
        }
    }
    return pts;
}

/**
 * Human-readable description of the expected reference grid: where FOV came from
 * and how the matrix size was estimated.
 * @param {{ fov_x: number, fov_y: number, Nx: number, Ny: number, fov_source?: string, matrix_source?: string }} p
 */
function describeReferenceGrid(p) {
    const fovX = Number.isFinite(p.fov_x) ? (p.fov_x * 1000).toFixed(0) : '?';
    const fovY = Number.isFinite(p.fov_y) ? (p.fov_y * 1000).toFixed(0) : '?';
    const fovSrc =
        p.fov_source === 'seq FOV definition'
            ? 'seq [FOV]'
            : p.fov_source === 'user override'
              ? 'user override'
              : 'default (no [FOV])';
    const matSrc =
        p.matrix_source === 'seq Matrix definition'
            ? 'seq [Matrix]'
            : p.matrix_source === 'user override'
              ? 'user override'
              : 'default (no [Matrix])';
    const dk = `Δk = 1/FOV; extent ±N/2·Δk`;
    return (
        `Reference grid: FOV ${fovX}×${fovY} mm from ${fovSrc}, ` +
        `matrix ${p.Nx}×${p.Ny} from ${matSrc}. ${dk}.`
    );
}

const FOV_BOX_STYLE = {
    kspaceRole: 'fov-box',
    color: 'rgba(255, 255, 255, 0.7)',
    lineStyle: { color: 'rgba(255, 255, 255, 0.7)', width: 1.5, opacity: 1 },
    showSymbol: false,
};

/** Outer k-space rectangle for expected Cartesian ADC grid (matches buildExpectedAdcGrid). */
function expectedFovRectSeries(p) {
    const { fov_x: fx, fov_y: fy, Nx, Ny } = p;
    if (!(fx > 0 && fy > 0 && Nx > 0 && Ny > 0)) return null;
    const kxLo = (Nx % 2 === 0 ? -Nx / 2 : -Math.floor(Nx / 2)) / fx;
    const kxHi = (Nx % 2 === 0 ? Nx / 2 - 1 : Math.floor(Nx / 2)) / fx;
    const kyLo = (Ny % 2 === 0 ? -Ny / 2 : -Math.floor(Ny / 2)) / fy;
    const kyHi = (Ny % 2 === 0 ? Ny / 2 - 1 : Math.floor(Ny / 2)) / fy;
    return {
        type: 'line',
        name: 'expected FOV',
        data: [
            [kxLo, kyLo],
            [kxHi, kyLo],
            [kxHi, kyHi],
            [kxLo, kyHi],
            [kxLo, kyLo],
        ],
        ...FOV_BOX_STYLE,
    };
}

function scatterSeries(data, style) {
    if (!data?.length) return null;
    return {
        type: 'scatter',
        data,
        kspaceRole: 'adc',
        ...style,
    };
}

function refSeries(expPts) {
    return scatterSeries(expPts, REF_STYLE);
}

/** @param {number[][][]} pointSets */
function sharedBounds(pointSets) {
    let kxLo = Infinity;
    let kxHi = -Infinity;
    let kyLo = Infinity;
    let kyHi = -Infinity;
    let n = 0;
    for (const pts of pointSets) {
        for (const p of pts) {
            const a = p[0];
            const b = p[1];
            if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
            n++;
            if (a < kxLo) kxLo = a;
            if (a > kxHi) kxHi = a;
            if (b < kyLo) kyLo = b;
            if (b > kyHi) kyHi = b;
        }
    }
    if (!n) return { kxBounds: null, kyBounds: null };
    return { kxBounds: [kxLo, kxHi], kyBounds: [kyLo, kyHi] };
}

function disposeFig4Slots(host) {
    disposeKspaceKySlot(host, 'fig4-trajex');
    disposeKspaceKySlot(host, 'fig4-pp');
}

/**
 * @param {*} host
 * @param {HTMLElement} containerEl
 * @param {*} kspaceCache from calculate_kspace
 * @param {{ traj: number[][], nSamples: number }} simCache
 * @param {{ fov_x: number, fov_y: number, Nx: number, Ny: number }} gridMeta
 */
export async function renderFig4Comparison(host, containerEl, kspaceCache, simCache, gridMeta) {
    if (!containerEl) return;
    disposeFig4Slots(host);
    containerEl.innerHTML = '';

    if (!kspaceCache) {
        containerEl.innerHTML = '<div class="seq-chartgpu-fallback">No calculate_kspace cache.</div>';
        return;
    }

    const kxA = kspaceCache.kx_adc || [];
    const kyA = kspaceCache.ky_adc || [];
    const ppPts = [];
    for (let i = 0; i < kxA.length; i++) {
        if (Number.isFinite(kxA[i]) && Number.isFinite(kyA[i])) {
            ppPts.push([kxA[i], kyA[i] ?? 0]);
        }
    }
    const pdgPts = [];
    if (simCache?.traj) {
        for (const t of simCache.traj) {
            if (Number.isFinite(t[0]) && Number.isFinite(t[1])) pdgPts.push([t[0], t[1]]);
        }
    }
    const expPts = buildExpectedAdcGrid(gridMeta);
    const fovBox = expectedFovRectSeries(gridMeta);
    const bounds = sharedBounds([expPts, pdgPts, ppPts]);

    const refInfo = describeReferenceGrid(gridMeta);
    const wrap = document.createElement('div');
    wrap.className = 'fig4-split';
    wrap.innerHTML = `
        <div class="fig4-panel">
            <div class="fig4-panel-title">PDG extracted k-space vs expected reference (gray)</div>
            <div class="fig4-panel-subtitle">${refInfo}</div>
            <div class="fig4-chart-mount plot-chart-square plot-panel-mount" data-fig4="trajex"></div>
        </div>
        <div class="fig4-panel">
            <div class="fig4-panel-title">pypulseq calculate_kspace vs reference</div>
            <div class="fig4-panel-subtitle">${refInfo}</div>
            <div class="fig4-chart-mount plot-chart-square plot-panel-mount" data-fig4="pp"></div>
        </div>
    `;
    containerEl.appendChild(wrap);

    const trajexMount = wrap.querySelector('[data-fig4="trajex"]');
    const ppMount = wrap.querySelector('[data-fig4="pp"]');
    const ctx =
        host._seqChartGpuDevice && host._seqChartGpuAdapter
            ? { adapter: host._seqChartGpuAdapter, device: host._seqChartGpuDevice }
            : undefined;

    const trajexSeries = [refSeries(expPts), scatterSeries(pdgPts, TRAJEX_STYLE), fovBox].filter(Boolean);
    if (!trajexSeries.length) {
        trajexMount.innerHTML =
            '<div class="seq-chartgpu-fallback">No reference grid (check FOV/Matrix on sequence).</div>';
    } else {
        if (!pdgPts.length) {
            const title = trajexMount.parentElement?.querySelector('.fig4-panel-title');
            if (title) {
                title.textContent = 'Expected reference only (sim off)';
            }
        }
        await renderKspaceChartGpu(
            host,
            trajexMount,
            ctx,
            { series: trajexSeries, ...bounds },
            { slot: 'fig4-trajex', interact: true },
        );
    }

    const ppSeries = [refSeries(expPts), scatterSeries(ppPts, PP_STYLE), fovBox].filter(Boolean);
    if (!ppSeries.length) {
        ppMount.innerHTML = '<div class="seq-chartgpu-fallback">No pypulseq ADC k-space points.</div>';
    } else {
        await renderKspaceChartGpu(
            host,
            ppMount,
            ctx,
            { series: ppSeries, ...bounds },
            { slot: 'fig4-pp', interact: true },
        );
    }
}

/**
 * Read FOV/matrix from Pyodide seq object.
 * @param {*} pyodide
 */
export async function readGridMetaFromSeq(pyodide) {
    const json = await pyodide.runPythonAsync(`
import json
fov_x, fov_y, fov_z, Nx, Ny, Nz = 0.256, 0.256, 0.005, 256, 256, 1
fov_source = 'default'
matrix_source = 'default'

def _fov_m(val):
    v = float(val)
    if v <= 0:
        return None
    if v > 2.0:
        v *= 0.001
    return v

try:
    fd = seq.get_definition('FOV')
    if fd is None:
        fd = seq.get_definition('fov')
    if fd is not None and len(fd) >= 1:
        fx = _fov_m(fd[0])
        if fx is not None:
            fov_x = fx
            fov_source = 'seq FOV definition'
    if fd is not None and len(fd) >= 2:
        fy = _fov_m(fd[1])
        if fy is not None:
            fov_y = fy
    if fd is not None and len(fd) >= 3:
        fz = _fov_m(fd[2])
        if fz is not None:
            fov_z = fz
except Exception:
    pass
try:
    mv = seq.get_definition('Matrix') or seq.get_definition('matrix')
    if mv is not None and len(mv) >= 1:
        Nx = int(mv[0])
        Ny = int(mv[1]) if len(mv) >= 2 else Nx
        Nz = int(mv[2]) if len(mv) >= 3 and int(mv[2]) > 0 else 1
        matrix_source = 'seq Matrix definition'
except Exception:
    pass
json.dumps({'fov_x': fov_x, 'fov_y': fov_y, 'fov_z': fov_z, 'Nx': Nx, 'Ny': Ny, 'Nz': Nz,
            'fov_source': fov_source, 'matrix_source': matrix_source})
`);
    return JSON.parse(String(json));
}

/** @param {number} m FOV component in metres */
export function formatFovMm(m) {
    const mm = Number(m) * 1000;
    if (!Number.isFinite(mm)) return '';
    return mm >= 100 ? mm.toFixed(0) : mm.toFixed(3);
}

/** @param {{ fov_x: number, fov_y: number, fov_z?: number, Nx: number, Ny: number, Nz?: number }} gridMeta */
export function gridMetaToPsfGridJson(gridMeta) {
    return JSON.stringify({
        fov_x_m: gridMeta.fov_x,
        fov_y_m: gridMeta.fov_y,
        fov_z_m: gridMeta.fov_z ?? 0.005,
        n_pix: gridMeta.Nx,
        n_phase: gridMeta.Ny,
        nz: gridMeta.Nz ?? 1,
    });
}

/** @param {{ fov_x: number, fov_y: number, Nx: number, Ny: number }} gridMeta */
export function gridMetaToUiValues(gridMeta) {
    return {
        fovXmm: formatFovMm(gridMeta.fov_x),
        fovYmm: formatFovMm(gridMeta.fov_y),
        nx: String(gridMeta.Nx ?? ''),
        ny: String(gridMeta.Ny ?? ''),
    };
}

/**
 * Merge UI values into seq-derived grid meta.
 * @param {{ fov_x: number, fov_y: number, Nx: number, Ny: number, fov_source?: string, matrix_source?: string }} base
 * @param {{ fovXmm?: string, fovYmm?: string, nx?: string, ny?: string }} ui
 */
export function parseGridMetaFromUi(base, ui) {
    const fov_x = parseFloat(String(ui.fovXmm ?? '')) / 1000;
    const fov_y = parseFloat(String(ui.fovYmm ?? '')) / 1000;
    const Nx = parseInt(String(ui.nx ?? ''), 10);
    const Ny = parseInt(String(ui.ny ?? ''), 10);
    if (!(fov_x > 0 && fov_y > 0 && Nx > 0 && Ny > 0)) return null;

    const unchanged =
        Math.abs(fov_x - base.fov_x) < 1e-12 &&
        Math.abs(fov_y - base.fov_y) < 1e-12 &&
        Nx === base.Nx &&
        Ny === base.Ny;

    return {
        ...base,
        fov_x,
        fov_y,
        Nx,
        Ny,
        fov_source: unchanged ? base.fov_source : 'user override',
        matrix_source: unchanged ? base.matrix_source : 'user override',
    };
}
