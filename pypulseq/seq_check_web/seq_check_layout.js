/**
 * Empty panel shells shown before / between .seq loads (sim layout always visible).
 */

import { appendPsfLegend } from './seq_check_psf.js';

const EMPTY_HINT = 'Upload a .seq file or run GRE example.';

function fallback(msg) {
    return `<div class="seq-chartgpu-fallback">${msg}</div>`;
}

export function mountEmptyFig4Shell(containerEl) {
    if (!containerEl) return;
    containerEl.innerHTML = `
        <div class="fig4-split">
            <div class="fig4-panel">
                <div class="fig4-panel-title">PDG extracted k-space vs expected reference (gray)</div>
                <div class="fig4-chart-mount plot-chart-square plot-panel-mount">${fallback(EMPTY_HINT)}</div>
            </div>
            <div class="fig4-panel">
                <div class="fig4-panel-title">pypulseq calculate_kspace vs reference</div>
                <div class="fig4-chart-mount plot-chart-square plot-panel-mount">${fallback(EMPTY_HINT)}</div>
            </div>
        </div>`;
}

export function mountEmptyPsfShell(containerEl) {
    if (!containerEl) return;
    const wrap = document.createElement('div');
    wrap.className = 'psf-split';
    for (const axis of ['X', 'Y', 'Z']) {
        const col = document.createElement('div');
        col.className = 'psf-panel';
        const title = document.createElement('div');
        title.className = 'psf-panel-title';
        title.textContent = `PSF ${axis}`;
        const mount = document.createElement('div');
        mount.className = 'psf-chart-mount plot-panel-mount';
        mount.innerHTML = fallback(EMPTY_HINT);
        col.appendChild(title);
        col.appendChild(mount);
        wrap.appendChild(col);
    }
    containerEl.innerHTML = '';
    containerEl.appendChild(wrap);
    // Reserve the legend row so the section height matches the rendered charts (which append the
    // same legend) — prevents the layout below from jumping when PSF finishes loading.
    appendPsfLegend(containerEl);
}

export function mountEmptyPsfSignalShell(containerEl) {
    if (!containerEl) return;
    containerEl.innerHTML = fallback(EMPTY_HINT);
    const parent = containerEl.parentElement;
    const oldLeg = parent?.querySelector('.psf-signal-legend');
    if (oldLeg) oldLeg.remove();
}

/**
 * @param {{
 *   waveformsEl?: HTMLElement | null,
 *   kspaceEl?: HTMLElement | null,
 *   kspaceYzEl?: HTMLElement | null,
 *   fig6KspaceEl?: HTMLElement | null,
 *   reconNiivueEl?: HTMLElement | null,
 *   fig4El?: HTMLElement | null,
 *   psfSignalEl?: HTMLElement | null,
 *   psfChartsEl?: HTMLElement | null,
 * }} panels
 * @param {{ resetRecon?: boolean }} [opts]
 */
export function initSeqCheckEmptyLayout(panels, opts = {}) {
    const { waveformsEl, kspaceEl, kspaceYzEl, fig6KspaceEl, reconNiivueEl, fig4El, psfSignalEl, psfChartsEl } =
        panels;
    const resetRecon = opts.resetRecon !== false;
    if (waveformsEl) waveformsEl.innerHTML = fallback(EMPTY_HINT);
    if (kspaceEl) {
        kspaceEl.className = 'plot-chart-square plot-panel-mount';
        kspaceEl.innerHTML = fallback(EMPTY_HINT);
    }
    if (kspaceYzEl) {
        kspaceYzEl.className = 'plot-chart-square plot-panel-mount';
        kspaceYzEl.innerHTML = fallback(EMPTY_HINT);
    }
    if (fig6KspaceEl) {
        fig6KspaceEl.className = 'plot-chart-square plot-panel-mount';
        fig6KspaceEl.innerHTML = fallback(
            'Simulated k-space appears after you upload a .seq or run GRE example.',
        );
    }
    if (
        resetRecon &&
        reconNiivueEl &&
        !reconNiivueEl.querySelector('canvas') &&
        !reconNiivueEl.querySelector('.seq-chartgpu-fallback')
    ) {
        reconNiivueEl.innerHTML = fallback(
            'NUFFT recon of simulated k-space appears after you upload a .seq or run GRE example.',
        );
    }
    mountEmptyFig4Shell(fig4El);
    mountEmptyPsfSignalShell(psfSignalEl);
    mountEmptyPsfShell(psfChartsEl);
}
