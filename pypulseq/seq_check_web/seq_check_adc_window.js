/**
 * ADC time-window selection (pypulseq t_adc) → trajex/sim sample indices.
 * Matches seq_plot.js k-space reference panels.
 */

import { indexRangeForTimeWindow } from '../seq_plot.js';

/**
 * @param {number[]} tAdc
 * @param {number} tLo
 * @param {number} tHi
 */
export function adcIndexRangeInTimeWindow(tAdc, tLo, tHi) {
    return indexRangeForTimeWindow(tAdc, tLo, tHi);
}

/**
 * Map ADC line indices [aLo..aHi] to trajex row indices in simCache.traj.
 *
 * @param {{ traj: number[][] }} simCache
 * @param {{ t_adc?: number[], kx_adc?: number[], ky_adc?: number[] } | null} kspaceCache
 * @param {number} aLo
 * @param {number} aHi
 * @returns {number[]}
 */
export function mapAdcIndicesToTraj(simCache, kspaceCache, aLo, aHi) {
    const traj = simCache?.traj;
    const nTraj = traj?.length ?? 0;
    if (!nTraj || aHi < aLo) return [];

    const tAdc = kspaceCache?.t_adc;
    const nAdc = tAdc?.length ?? 0;
    if (nTraj === nAdc && nAdc > 0) {
        const out = [];
        for (let j = aLo; j <= aHi; j++) out.push(j);
        return out;
    }

    const kxA = kspaceCache?.kx_adc;
    const kyA = kspaceCache?.ky_adc;
    const m = Math.min(nAdc, kxA?.length ?? 0, kyA?.length ?? 0);
    if (m > 0 && kxA && kyA) {
        const out = [];
        const jHi = Math.min(aHi, m - 1);
        for (let j = Math.max(0, aLo); j <= jHi; j++) {
            const kxT = kxA[j];
            const kyT = kyA[j] ?? 0;
            if (!Number.isFinite(kxT) || !Number.isFinite(kyT)) continue;
            let best = -1;
            let bestD = Infinity;
            for (let i = 0; i < nTraj; i++) {
                const kx = traj[i][0];
                const ky = traj[i][1] ?? 0;
                if (!Number.isFinite(kx) || !Number.isFinite(ky)) continue;
                const d = (kx - kxT) ** 2 + (ky - kyT) ** 2;
                if (d < bestD) {
                    bestD = d;
                    best = i;
                }
            }
            if (best >= 0) out.push(best);
        }
        return out;
    }

    const denom = Math.max(1, nAdc > 0 ? nAdc - 1 : aHi - aLo);
    const out = [];
    for (let j = aLo; j <= aHi; j++) {
        if (nTraj === 1) {
            out.push(0);
            continue;
        }
        const u = nAdc > 0 ? j / denom : (j - aLo) / Math.max(1, aHi - aLo);
        out.push(Math.min(nTraj - 1, Math.round(u * (nTraj - 1))));
    }
    return out;
}

/**
 * @param {{ traj: number[][], signal: number[][] }} simCache
 * @param {{ t_adc?: number[], kx_adc?: number[], ky_adc?: number[] } | null} kspaceCache
 * @param {{ tLo: number, tHi: number } | null} window
 * @returns {number[] | null} null = no window filter (all traj rows)
 */
export function trajIndicesForAdcTimeWindow(simCache, kspaceCache, window) {
    if (!window) return null;
    const tAdc = kspaceCache?.t_adc;
    if (!tAdc?.length) return null;
    const { iLo: aLo, iHi: aHi } = adcIndexRangeInTimeWindow(tAdc, window.tLo, window.tHi);
    return mapAdcIndicesToTraj(simCache, kspaceCache, aLo, aHi);
}
