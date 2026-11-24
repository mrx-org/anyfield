"""Reconstruction kernels shared by the app's two recon call paths.

`scan_zero/recon.py` (the SIM pipeline) and
`pypulseq/seq_check_web/seq_check_py_recon.py` (seq_check_web's Fig 6 window) each
carried their own copy of the same Pipe-Menon density compensation and the same
adjoint NUFFT. The copies were byte-for-byte equivalent in their arithmetic — see
`tests/python/test_recon_equivalence.py`, which asserts the DCF weights are
bit-identical — so they live here once instead of twice.

Dependencies are deliberately **numpy and pynufft only, no nibabel**. seq_check_web's
worker treats nibabel as optional (it falls back to handing raw arrays to Niivue as
base64), so a nibabel import at this level would make the whole kernel unavailable
on a path that does not need it. NIfTI writing stays in the callers.
"""
from __future__ import annotations

import numpy as np
from pynufft import NUFFT

DCF_ITERS = 20
DCF_EPS = 1e-6

# Interpolator width. PyNUFFT cost grows as J**ndim, so 3-D planning uses the
# narrower kernel that both original implementations already used.
_INTERP_LOW_DIM = 6
_INTERP_3D = 4


def pipe_menon_dcf(plan: NUFFT, n_samples: int, n_iter: int = DCF_ITERS) -> np.ndarray:
    """Fixed-point Pipe-Menon density compensation weights for a planned trajectory.

    Uses PyNUFFT's interpolation/gridding operators directly, which keeps this
    general across radial and spiral trajectories while staying Pyodide-friendly.

    `_y2k_cpu` / `_k2y_cpu` are private to PyNUFFT and could disappear on an
    upgrade, so their absence is reported as a `RuntimeError` naming the cause
    rather than as a bare `AttributeError`.
    """
    if n_samples < 1:
        raise ValueError("Cannot compute DCF for empty trajectory.")
    try:
        y2k = plan._y2k_cpu
        k2y = plan._k2y_cpu
    except AttributeError as exc:
        raise RuntimeError("PyNUFFT interpolation operators unavailable for DCF.") from exc

    w = np.ones(int(n_samples), dtype=np.complex64)
    for _ in range(int(n_iter)):
        gridded = y2k(w)
        back = k2y(gridded)
        w = w / np.maximum(np.abs(back), DCF_EPS)
    return np.abs(w).astype(np.float32)


def default_plan_params(shape: tuple[int, ...]) -> tuple[tuple[int, ...], tuple[int, ...]]:
    """Oversampled grid and interpolator width for an output `shape`.

    The z axis floors at 4 because a thin slab (nz of 1 or 2) would otherwise get an
    oversampled grid too small for the interpolator to sit in.
    """
    ndim = len(shape)
    if ndim == 3:
        nx, ny, nz = (int(v) for v in shape)
        return (2 * nx, 2 * ny, max(2 * nz, 4)), (_INTERP_3D,) * 3
    return tuple(2 * int(v) for v in shape), (_INTERP_LOW_DIM,) * ndim


def nufft_adjoint(
    om: np.ndarray,
    signal: np.ndarray,
    shape: tuple[int, ...],
    *,
    apply_dcf: bool = False,
    oversample: tuple[int, ...] | None = None,
    interp: tuple[int, ...] | None = None,
) -> tuple[np.ndarray, np.ndarray | None]:
    """Adjoint (gridding) NUFFT of `signal` sampled at `om`, onto a grid of `shape`.

    Parameters
    ----------
    om
        Sample locations in radians, shape ``(M,)`` for 1-D or ``(M, ndim)``. Callers
        map their own k (1/m) to radians, since the scaling is a property of the
        acquisition rather than of the transform.
    signal
        Complex samples. Truncated to ``min(len(signal), len(om))``; the two can
        legitimately differ when a caller windows one but not the other.
    shape
        Output grid, 1-D to 3-D.
    apply_dcf
        Weight samples by `pipe_menon_dcf` before the adjoint. Off by default
        because the Cartesian paths must not be weighted.

    Returns
    -------
    (reco, dcf)
        `reco` has exactly `shape`. `dcf` is None unless `apply_dcf`.

    No orientation flip is applied: the output follows the unflipped convention of
    `numpy.fft`, with a centred point source landing on ``n // 2``.
    """
    shape = tuple(int(v) for v in shape)
    om = np.asarray(om, dtype=np.float64)
    if om.ndim == 1:
        om = om.reshape(-1, 1)
    sig = np.asarray(signal, dtype=np.complex64).ravel()

    n = int(min(sig.size, om.shape[0]))
    if n < 1:
        raise ValueError("Cannot reconstruct from an empty trajectory or signal.")
    om_n = om[:n]
    sig_n = sig[:n]

    if oversample is None or interp is None:
        default_over, default_interp = default_plan_params(shape)
        oversample = oversample or default_over
        interp = interp or default_interp

    plan = NUFFT()
    plan.plan(om_n, shape, tuple(oversample), tuple(interp))

    dcf = None
    if apply_dcf:
        dcf = pipe_menon_dcf(plan, n)
        sig_n = sig_n * dcf.astype(np.complex64, copy=False)

    reco = np.asarray(plan.adjoint(sig_n)).reshape(shape)
    return reco.astype(np.complex64), dcf


def omega_from_k(
    k: np.ndarray,
    kmax: float,
) -> np.ndarray:
    """Map k (1/m) onto PyNUFFT's [-pi, pi] omega for one axis.

    A `kmax` at or below zero yields zeros, which is how a caller expresses "this
    axis is not sampled" (a 2-D acquisition's z axis, for instance).
    """
    k = np.asarray(k, dtype=np.float64)
    if not np.isfinite(kmax) or kmax <= 1e-30:
        return np.zeros(k.shape, dtype=np.float64)
    return (k / float(kmax)) * np.pi
