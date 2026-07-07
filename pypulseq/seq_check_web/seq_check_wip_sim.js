/**
 * MR sim via toolapi-wasm — same approach as the Fly.io demo pages:
 *   https://tool-rapisim.fly.dev/  and  https://tool-mr0sim.fly.dev/
 *
 * Uses toolapi-wasm@0.4.5 (unpkg CDN) to call the Fly.io tool pipeline:
 *   conseq → phantomlib + (rapisim | mr0sim) + trajex
 * All in the browser over WebSocket, no Python proxy needed.
 */

import init, { call } from 'https://unpkg.com/toolapi-wasm@0.4.5/toolapi_wasm.js';
import { runConseq } from './seq_check_psf_trajex.js';

const CONSEQ_ADDR = 'wss://tool-conseq.fly.dev/tool';
const TRAJEX_ADDR = 'wss://tool-trajex.fly.dev/tool';
/** Modal-hosted mr0sim on a T4 GPU (same toolapi protocol as the Fly mr0sim tool). */
const MR0SIM_T4_ADDR = 'wss://mzaiss--tool-mr0sim-modal-serve-t4.modal.run/tool';
const PHANTOMLIB_ADDR = 'wss://tool-phantomlib-flyio.fly.dev/tool';

let wasmReady = false;

/** Initialize toolapi-wasm (idempotent). */
export async function initToolApi() {
    if (!wasmReady) {
        await init();
        wasmReady = true;
    }
}

function buildPhantomInput() {
    return {
        Dict: {
            subject: { Int: 4 },
            res_x: { Int: 72 },
            res_y: { Int: 87 },
            res_z: { Int: 1 },
            affine: {
                List: [
                    { List: [{ Float: 2.5 }, { Float: 0.0 }, { Float: 0.0 }, { Float: -90.0 }] },
                    { List: [{ Float: 0.0 }, { Float: 2.5 }, { Float: 0.0 }, { Float: -108.75 }] },
                    { List: [{ Float: 0.0 }, { Float: 0.0 }, { Float: 2.5 }, { Float: -1.25 }] },
                ],
            },
        },
    };
}

/**
 * Extract complex signal from sim result.
 * rapisim returns TypedList.Complex; mr0sim may return List of Complex or TypedList.Complex.
 */
function extractSignal(result) {
    try {
        return result.List.map((x) => x.Complex);
    } catch {
        return result.TypedList.Complex;
    }
}

async function fetchPhantom(onMessage) {
    return call(PHANTOMLIB_ADDR, buildPhantomInput(), (msg) => {
        onMessage('phantomlib: ' + msg);
        return true;
    });
}

/**
 * Sim + ADC trajex from precomputed conseq events (skips conseq).
 *
 * seq_check always simulates on the Modal T4 GPU (`mr0sim`); the sim backend is fixed (no selector).
 *
 * @param {*} events InstantSeqEvent list from conseq
 * @param {(msg: string) => void} [onMessage]
 * @param {*} [phantomResult] optional pre-fetched phantom
 */
export async function fetchSimCacheFromEvents(
    events,
    onMessage = () => {},
    phantomResult = null,
) {
    await initToolApi();

    const simAddr = MR0SIM_T4_ADDR;
    const simLabel = 'mr0 T4 (Modal)';

    if (!events?.length) throw new Error('conseq returned no events');

    if (!phantomResult) {
        onMessage('phantomlib…');
        phantomResult = await fetchPhantom(onMessage);
    }

    // Phase 2: sim + trajex in parallel
    // trajex params match seq_check.py: T1=1.0, T2=0.1, min_mag=1e-4
    onMessage(`${simLabel} + trajex…`);
    const [simResult, trajexResult] = await Promise.all([
        call(
            simAddr,
            {
                Dict: {
                    sequence: { TypedList: { InstantSeqEvent: events } },
                    phantom: phantomResult,
                },
            },
            (msg) => { onMessage(simLabel + ': ' + msg); return true; },
        ),
        call(
            TRAJEX_ADDR,
            {
                Dict: {
                    sequence: { TypedList: { InstantSeqEvent: events } },
                    t1: { Float: 1.0 },
                    t2: { Float: 0.1 },
                    min_mag: { Float: 1e-4 },
                },
            },
            (msg) => { onMessage('trajex: ' + msg); return true; },
        ),
    ]);

    const signal = extractSignal(simResult);
    const trajectory = trajexResult.TypedList.Vec4;

    const nSamples = Math.min(signal.length, trajectory.length);

    // Normalize to [[kx, ky, kz], …] and [[re, im], …]
    const traj = [];
    const sig = [];
    for (let i = 0; i < nSamples; i++) {
        const t = trajectory[i];
        const kx = Array.isArray(t) ? t[0] : (t[0] ?? t.kx ?? t.k_x ?? 0);
        const ky = Array.isArray(t) ? t[1] : (t[1] ?? t.ky ?? t.k_y ?? 0);
        const kz = Array.isArray(t) ? t[2] : (t[2] ?? t.kz ?? t.k_z ?? 0);
        const tau = Array.isArray(t) ? (t[3] ?? 0) : (t.tau ?? t[3] ?? 0);
        traj.push([kx, ky, kz, tau]);

        const s = signal[i];
        const re = Array.isArray(s) ? s[0] : (s.re ?? s[0] ?? 0);
        const im = Array.isArray(s) ? s[1] : (s.im ?? s[1] ?? 0);
        sig.push([re, im]);
    }

    onMessage(`sim done · ${nSamples} samples`);
    return {
        traj,
        signal: sig,
        nSamples,
        phantom: 'brainweb-subj04 (72×87×1)',
        simBackend: `${simLabel}+trajex (toolapi-wasm)`,
    };
}

/**
 * Run the full sim pipeline (conseq + phantomlib, then sim + trajex).
 *
 * @param {string} seqText  raw .seq file content
 * @param {(msg: string) => void} [onMessage]
 */
export async function fetchSimCache(seqText, onMessage = () => {}) {
    await initToolApi();
    onMessage('conseq + phantomlib…');
    const [events, phantomResult] = await Promise.all([
        runConseq(seqText, (msg) => onMessage(msg)),
        fetchPhantom(onMessage),
    ]);
    return fetchSimCacheFromEvents(events, onMessage, phantomResult);
}
