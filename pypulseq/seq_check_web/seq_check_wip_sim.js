/**
 * seq_check's simulated k-space and PSF, from one PDGv2 Modal HTTP gateway job.
 *
 * The gateway simulates the uploaded `.seq` on a cached BIfTI phantom and returns signal
 * and trajectory together (`signal` + `ktraj` in the result `.npz`). The job's `psf`
 * option adds one dominant-state (trajex-like) signal per PSF tissue on that same
 * trajectory (`psf_signal`), so the PSF needs no separate call either. The phantom grid is
 * brainweb subj04's central axial slice at 2.5 mm, the same grid the retired Fly.io
 * phantomlib served.
 */

import { DEFAULT_CACHE_PHANTOM_ID } from '../../scan_zero/bifti_cache.js';
import { resolveHttpSimBaseUrl, SIM_BACKENDS } from '../../scan_zero/sim_backends.js';

const SIM_BACKEND = SIM_BACKENDS.pdgv2_t4;
const SIM_LABEL = SIM_BACKEND.label;
const PHANTOM_RES = [72, 87, 1];
const PHANTOM_AFFINE = [
    [2.5, 0.0, 0.0, -90.0],
    [0.0, 2.5, 0.0, -108.75],
    [0.0, 0.0, 2.5, -1.25],
];

/** Applied to res/(2·fov) per axis before the PSF (relaxes the in-simulator Nyquist cutoff). */
const NYQUIST_SCALE_FACTOR = 1.5;

/** Same tissues / T1,T2,T2' as seq_check.py get_or_compute_psf_bundle. */
export const PSF_TISSUES = [
    { name: 'Gray Matter', T1: 1.56, T2: 0.083, T2dash: 0.32 },
    { name: 'White Matter', T1: 0.83, T2: 0.075, T2dash: 0.18 },
    { name: 'CSF', T1: 4.16, T2: 1.65, T2dash: 0.059 },
    /** brain_default phantom; the PSF uses T1/T2/T2′ only (no dB0 shift). */
    { name: 'Fat', T1: 0.37, T2: 0.125, T2dash: 0.012 },
];

const POLL_MS = 2000;
/** Gives up on a job that never finishes (Modal cold start + queue + sim). */
const JOB_TIMEOUT_MS = 10 * 60 * 1000;
const NPZ_VFS_PATH = '/tmp/seq_check_sim.npz';

/** Decodes the result `.npz` on the seq_check worker; the last expression is the JSON reply. */
const DECODE_NPZ_PY = `
import json
import numpy as np
_d = np.load(${JSON.stringify(NPZ_VFS_PATH)})
_s = np.asarray(_d["signal"]).ravel()
_k = np.asarray(_d["ktraj"], dtype=np.float64)
if _k.ndim == 2 and _k.shape[0] in (3, 4) and _k.shape[1] not in (3, 4):
    _k = _k.T
_n = int(min(_s.size, _k.shape[0]))
_t = np.zeros((_k.shape[0], 4))
_t[:, :min(4, _k.shape[1])] = _k[:, :4]
_psf = None
if "psf_signal" in _d.files:
    _ps = np.asarray(_d["psf_signal"])
    _psf = {
        "names": [str(x) for x in _d["psf_tissue_names"]],
        "signal": [np.stack([p.real, p.imag], axis=1).tolist() for p in _ps],
        "nyquist": np.asarray(_d["psf_nyquist"], dtype=np.float64).tolist(),
    }
json.dumps({
    "traj": _t[:_n].tolist(),
    "signal": np.stack([_s.real[:_n], _s.imag[:_n]], axis=1).tolist(),
    "psf_kspace": _t.tolist(),
    "psf": _psf,
})
`;

async function readJson(resp, what) {
    if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new Error(`${what} failed (${resp.status}): ${detail}`);
    }
    return resp.json();
}

/**
 * Simulate `seqText` and return its k-space trajectory, signal and PSF bundle.
 *
 * @param {string} seqText raw .seq file content
 * @param {import('./seq_check_py_client.js').SeqCheckPyClient} pyClient decodes the `.npz`
 * @param {{ fov: number[], res: number[] }} psfGrid recon grid the PSF is computed for (m, voxels)
 * @param {(msg: string) => void} [onMessage]
 * @param {() => boolean} [isCurrent] false once the user loaded another sequence; the job is aborted
 * @returns {Promise<{ traj: number[][], signal: number[][], nSamples: number, phantom: string,
 *   simBackend: string, psfBundle: { kspace: number[][], tissues: object[], nyquist: number[], source: string } | null }>}
 *   `traj` / `psfBundle.kspace` rows are `[kx, ky, kz, tau]` (1/m, s); signal rows are `[re, im]`.
 *   PSF tissue signals already include the T2′ decay. `psfBundle` is null if the gateway
 *   returned no `psf_signal`.
 */
export async function fetchSimCache(seqText, pyClient, psfGrid, onMessage = () => {}, isCurrent = () => true) {
    const base = resolveHttpSimBaseUrl(SIM_BACKEND.httpBaseUrl);
    const options = {
        exact_trajectories: SIM_BACKEND.exactTrajectories,
        worker: SIM_BACKEND.worker,
        backend: SIM_BACKEND.forwardBackend,
        accuracy: SIM_BACKEND.accuracy,
        phantom: {
            type: 'bifti',
            id: DEFAULT_CACHE_PHANTOM_ID,
            res: PHANTOM_RES,
            affine: PHANTOM_AFFINE,
        },
        psf: {
            res: psfGrid.res,
            fov: psfGrid.fov,
            tissues: PSF_TISSUES,
            nyquist_scale: NYQUIST_SCALE_FACTOR,
        },
    };
    const form = new FormData();
    form.append('seq', new Blob([seqText], { type: 'application/octet-stream' }), 'upload.seq');
    form.append('options', JSON.stringify(options));

    onMessage(`${SIM_LABEL}: submitting…`);
    const { job_id: jobId } = await readJson(
        await fetch(`${base}/v1/jobs`, { method: 'POST', body: form }),
        'sim submit',
    );

    const t0 = performance.now();
    for (;;) {
        if (!isCurrent()) {
            fetch(`${base}/v1/jobs/${jobId}/abort`, { method: 'POST' }).catch(() => {});
            throw new Error('Stale Pyodide request');
        }
        const status = await readJson(await fetch(`${base}/v1/jobs/${jobId}`), 'sim status');
        const st = String(status.status || '').toLowerCase();
        if (st === 'done') break;
        if (st === 'failed' || st === 'aborted') {
            throw new Error(status.error || status.message || `simulation ${st}`);
        }
        if (performance.now() - t0 > JOB_TIMEOUT_MS) {
            throw new Error(`simulation timed out after ${JOB_TIMEOUT_MS / 60000} min`);
        }
        if (status.message) onMessage(`${SIM_LABEL}: ${status.message}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }

    const resp = await fetch(`${base}/v1/jobs/${jobId}/result`);
    if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new Error(`sim result fetch failed (${resp.status}): ${detail}`);
    }
    await pyClient.fsWrite(NPZ_VFS_PATH, new Uint8Array(await resp.arrayBuffer()));
    const decoded = JSON.parse(String(await pyClient.runPython(DECODE_NPZ_PY)));
    const { traj, signal, psf } = decoded;

    onMessage(`sim done · ${traj.length} samples`);
    return {
        traj,
        signal,
        nSamples: traj.length,
        phantom: `${DEFAULT_CACHE_PHANTOM_ID} (${PHANTOM_RES.join('×')})`,
        simBackend: SIM_LABEL,
        psfBundle: psf
            ? {
                kspace: decoded.psf_kspace,
                tissues: psf.names.map((name, i) => ({ name, signal: psf.signal[i] })),
                nyquist: psf.nyquist,
                source: `${SIM_LABEL} psf (dominant-state trajex)`,
            }
            : null,
    };
}
