"""
PyNUFFT reconstruction for the SIM pipeline (runs inside Pyodide).

Output grid and world space follow the reference FOV mask NIfTI from
``generateFovMaskNifti``; trajectory k (1/m) is mapped to ω for pynufft.

When k-space is on a **centered Cartesian** grid (``k * FOV`` is integer within
tolerance, matching k from ``-kmax`` to ``kmax`` with ``kmax = N/(2*FOV)``), the
adjoint is implemented as scatter into Cartesian k-space + ``ifftn`` instead
of a NUFFT (see MRpro-style FFT vs nuFFT classification).

For even ``N``, symmetric sampling may include ``k*FOV = ±N/2`` (both Nyquist
aliases); the integer range therefore allows ``n`` in ``[-N/2, N/2]`` inclusive.
Bins use ``n % N`` (``+N/2`` and ``-N/2`` map to the same Nyquist bin).

Per-axis ``offset_n = median(k*FOV - round(k*FOV))`` removes a global k-space shift
(linear phase in image domain) before testing ``n`` on-grid.

If **all** axes pass the Cartesian test, reconstruction uses ``numpy.fft.ifftn``;
otherwise joint 3D PyNUFFT is used for the whole volume (no per-axis mixing).
"""
from __future__ import annotations

import io
from typing import Any, Sequence, Union

import nibabel as nib
import numpy as np
from pynufft import NUFFT

# Default output path in Pyodide FS (caller may change later if needed)
DEFAULT_OUT_PATH = "/tmp/__sim_pipeline_reco.nii"

# Match MRpro ``grid_detection_tolerance`` on dimensionless index ``k * FOV``.
_GRID_TOL = 1e-3


def _log_recon(msg: str) -> None:
    """Print recon diagnostics (visible in Pyodide / console without logging setup)."""
    print(msg, flush=True)


def _median_offset_n(d: np.ndarray) -> float:
    """Median fractional part of ``d`` vs nearest integer; removes global shift in ``n``."""
    if d.size == 0:
        return 0.0
    return float(np.median(d - np.round(d)))


def _centered_int_range(n_len: int) -> tuple[int, int]:
    """Inclusive range of integer frequency indices n = k * FOV (centered DFT).

    For **even** ``n_len``, allow ``n = ±N/2`` (symmetric ``±kmax`` trajectories
    often include ``k*FOV = +N/2`` on the readout axis). That value aliases
    ``-N/2`` under ``n % n_len`` in ``_recon_cartesian_ifft``.
    """
    if n_len % 2 == 0:
        return -n_len // 2, n_len // 2
    return -(n_len // 2), n_len // 2


def _axis_cartesian_after_offset(
    k_axis: np.ndarray,
    fov_m: float,
    n_len: int,
    tol: float,
) -> tuple[bool, float]:
    """Cartesian test on ``(k*FOV - offset)`` with ``offset = median(d - round(d))``."""
    if k_axis.size == 0:
        return True, 0.0
    d = k_axis.astype(np.float64, copy=False) * fov_m
    offset = _median_offset_n(d)
    d_adj = d - offset
    r = np.round(d_adj)
    if not np.all(np.abs(d_adj - r) <= tol):
        return False, offset
    lo, hi = _centered_int_range(n_len)
    if not np.all((r >= lo) & (r <= hi)):
        return False, offset
    return True, offset


def _log_traj_and_detection(
    tr: np.ndarray,
    fov_x_m: float,
    fov_y_m: float,
    fov_z_m: float,
    nx: int,
    ny: int,
    nz: int,
    kmax_x: float,
    kmax_y: float,
    kmax_z: float,
    tol: float,
    axis_ok: tuple[bool, bool, bool],
    offsets: tuple[float, float, float],
) -> None:
    """Print compact per-axis grid detection (``n_adj = k*FOV - offset``)."""
    n_row, n_col = int(tr.shape[0]), int(tr.shape[1])
    ox, oy, oz = offsets
    _log_recon(
        "[recon] grids: N=%d, nx=%d ny=%d nz=%d, tol=%g, "
        "FOV_m=(%.6g, %.6g, %.6g), kmax(1/m)=(%.6g, %.6g, %.6g), "
        "median_offset_n=(%.6g, %.6g, %.6g)"
        % (n_row, nx, ny, nz, tol, fov_x_m, fov_y_m, fov_z_m, kmax_x, kmax_y, kmax_z, ox, oy, oz)
    )
    axes = (
        ("kx", tr[:, 0], fov_x_m, nx, axis_ok[0], ox),
        ("ky", tr[:, 1], fov_y_m, ny, axis_ok[1], oy),
        (
            "kz",
            tr[:, 2] if n_col >= 3 else np.zeros(n_row, dtype=np.float64),
            fov_z_m,
            nz,
            axis_ok[2],
            oz,
        ),
    )
    line_parts: list[str] = []
    for name, k_axis, fov_m, n_len, ok, off in axes:
        if k_axis.size == 0:
            line_parts.append("%s:empty" % name)
            continue
        d = k_axis.astype(np.float64, copy=False) * fov_m
        d_adj = d - off
        r = np.round(d_adj)
        lo, hi = _centered_int_range(n_len)
        nmin = int(np.min(r))
        nmax = int(np.max(r))
        st = "Cartesian" if ok else "non-Cartesian"
        line_parts.append("%s:%s n=%d..%d allow[%d,%d]" % (name, st, nmin, nmax, lo, hi))
    _log_recon("[recon]   " + " | ".join(line_parts))


def _per_axis_cartesian_and_offsets(
    tr: np.ndarray,
    fov_x_m: float,
    fov_y_m: float,
    fov_z_m: float,
    nx: int,
    ny: int,
    nz: int,
    tol: float,
) -> tuple[tuple[bool, bool, bool], tuple[float, float, float]]:
    """Per-axis Cartesian flags and median ``offset_n`` per axis (see ``_axis_cartesian_after_offset``)."""
    if tr.ndim != 2 or tr.shape[1] < 2:
        return (False, False, False), (0.0, 0.0, 0.0)
    kx = tr[:, 0]
    ky = tr[:, 1]
    kz = tr[:, 2] if tr.shape[1] >= 3 else np.zeros(tr.shape[0], dtype=np.float64)
    okx, ox = _axis_cartesian_after_offset(kx, fov_x_m, nx, tol)
    oky, oy = _axis_cartesian_after_offset(ky, fov_y_m, ny, tol)
    okz, oz = _axis_cartesian_after_offset(kz, fov_z_m, nz, tol)
    return (okx, oky, okz), (ox, oy, oz)


def _is_centered_cartesian(
    tr: np.ndarray,
    fov_x_m: float,
    fov_y_m: float,
    fov_z_m: float,
    nx: int,
    ny: int,
    nz: int,
    tol: float = _GRID_TOL,
) -> bool:
    """
    True if all samples lie on the centered Cartesian grid:
    ``k * FOV`` is (approximately) integer and within the valid index range.
    """
    ok, _ = _per_axis_cartesian_and_offsets(
        tr, fov_x_m, fov_y_m, fov_z_m, nx, ny, nz, tol
    )
    return bool(all(ok))


def _axis_bins(k: np.ndarray, fov_m: float, offset_n: float, n_len: int) -> np.ndarray:
    """FFT bin indices for ``n_adj = k*FOV - offset_n`` (centered DFT, ``% n_len``)."""
    d_adj = k.astype(np.float64) * fov_m - offset_n
    return (np.rint(d_adj).astype(np.int64) % n_len).astype(np.intp)


def _recon_cartesian_ifft(
    signal_1d: np.ndarray,
    tr: np.ndarray,
    nx: int,
    ny: int,
    nz: int,
    fov_x_m: float,
    fov_y_m: float,
    fov_z_m: float,
    offset_n: tuple[float, float, float] | None = None,
) -> np.ndarray:
    """
    Scatter ``signal_1d`` onto centered Cartesian k-space bins, then ``ifftn``.

    Integer bin index ``n_adj = k * FOV - offset_n`` maps to numpy's unshifted FFT order via
    ``i = n % N`` (same convention as ``numpy.fft``).

    ``fftshift`` is applied on the image so DC / anatomy align with display (PyNUFFT adjoint
    was already effectively centered; raw ``ifftn`` leaves energy in array corners).
    """
    ox, oy, oz = offset_n if offset_n is not None else (0.0, 0.0, 0.0)
    ksp = np.zeros((nx, ny, nz), dtype=np.complex128)
    kx = tr[:, 0].astype(np.float64, copy=False)
    ky = tr[:, 1].astype(np.float64, copy=False)
    kz = tr[:, 2].astype(np.float64, copy=False) if tr.shape[1] >= 3 else np.zeros(tr.shape[0], dtype=np.float64)

    n_samp = min(int(signal_1d.shape[0]), int(tr.shape[0]))
    ix = _axis_bins(kx[:n_samp], fov_x_m, ox, nx)
    iy = _axis_bins(ky[:n_samp], fov_y_m, oy, ny)
    iz = _axis_bins(kz[:n_samp], fov_z_m, oz, nz)
    sig = signal_1d[:n_samp].astype(np.complex128, copy=False)
    np.add.at(ksp, (ix, iy, iz), sig)
    reco = np.fft.ifftn(ksp, norm="ortho")
    reco = np.fft.fftshift(reco, axes=(0, 1, 2))
    return reco.astype(np.complex64)


def _recon_full_nufft(
    signal_1d: np.ndarray,
    tr: np.ndarray,
    nx: int,
    ny: int,
    nz: int,
    kmax_x: float,
    kmax_y: float,
    kmax_z: float,
) -> np.ndarray:
    """Joint 3D PyNUFFT adjoint (all axes non-Cartesian or synthetic ω)."""
    kxy = tr[:, :2]
    kz_col = tr[:, 2].astype(np.float64) if tr.shape[1] >= 3 else None
    oz = np.zeros(kxy.shape[0], dtype=np.float64)
    if kz_col is not None and kmax_z > 1e-30:
        oz = (kz_col / kmax_z) * np.pi
    om2 = np.stack(
        [
            (kxy[:, 0] / kmax_x) * np.pi,
            (kxy[:, 1] / kmax_y) * np.pi,
        ],
        axis=-1,
    )
    om = np.column_stack([om2[:, 0], om2[:, 1], oz])
    n = min(signal_1d.size, om.shape[0])
    signal_n = signal_1d[:n]
    om_n = om[:n]
    a = NUFFT()
    kz_plan = max(2 * nz, 4)
    a.plan(om_n, (nx, ny, nz), (2 * nx, 2 * ny, kz_plan), (8, 8, 8))
    return a.adjoint(signal_n).reshape(nx, ny, nz)


def _to_py_list(x: Any) -> Any:
    if hasattr(x, "to_py"):
        return x.to_py()
    return x


def run_sim_recon(
    signal_pairs: Sequence[Sequence[float]],
    traj_points: Union[Sequence[Sequence[float]], Any],
    ref_bytes: Union[bytes, Any],
    out_path: str = DEFAULT_OUT_PATH,
) -> str:
    """
    Gridding adjoint (NUFFT) magnitude recon on the ref mask grid.

    Parameters
    ----------
    signal_pairs
        List of [real, imag] per sample (from tool sim).
    traj_points
        Array-like (N, 2+) with kx, ky in 1/m; optional column for kz.
    ref_bytes
        Raw bytes of binary FOV mask NIfTI (reference geometry).
    out_path
        Where to write float32 magnitude NIfTI.

    Returns
    -------
    str
        Path written (same as ``out_path``).
    """
    raw = _to_py_list(signal_pairs)
    traj = _to_py_list(traj_points)
    rb = _to_py_list(ref_bytes)
    if isinstance(rb, (bytes, bytearray, memoryview)):
        ref_bytes = bytes(rb)
    elif isinstance(rb, (list, tuple)):
        ref_bytes = bytes(rb)
    else:
        # Pyodide / buffer edge cases
        ref_bytes = bytes(rb)

    signal = np.array(
        [complex(float(r), float(i)) for r, i in raw],
        dtype=np.complex64,
    ).ravel()

    ref_fh = nib.FileHolder(fileobj=io.BytesIO(ref_bytes))
    ref_img = nib.Nifti1Image.from_file_map({"header": ref_fh, "image": ref_fh})

    # Full 3D FOV grid (same as generateFovMaskNifti). If nz_ref>1 and traj is 2D,
    # use 3D NUFFT with ω_z=0 (kz zero-fill).
    shp = tuple(int(x) for x in ref_img.shape)
    if len(shp) == 2:
        nx, ny, nz_ref = shp[0], shp[1], 1
    elif len(shp) >= 3:
        nx, ny, nz_ref = shp[0], shp[1], max(1, shp[2])
    else:
        nx, ny, nz_ref = int(ref_img.shape[0]), int(ref_img.shape[1]), 1

    zooms_full = list(ref_img.header.get_zooms())
    while len(zooms_full) < 3:
        zooms_full.append(zooms_full[-1] if zooms_full else 1.0)
    dx_mm = float(zooms_full[0]) if zooms_full[0] and float(zooms_full[0]) > 0 else 1.0
    dy_mm = (
        float(zooms_full[1])
        if len(zooms_full) > 1 and zooms_full[1] and float(zooms_full[1]) > 0
        else dx_mm
    )
    dz_mm = (
        float(zooms_full[2])
        if len(zooms_full) > 2 and zooms_full[2] and float(zooms_full[2]) > 0
        else 1.0
    )
    dx_m = dx_mm * 1e-3
    dy_m = dy_mm * 1e-3
    dz_m = dz_mm * 1e-3
    fov_x_m = nx * dx_m
    fov_y_m = ny * dy_m
    fov_z_m = max(nz_ref, 1) * dz_m
    kmax_x = nx / (2.0 * fov_x_m)
    kmax_y = ny / (2.0 * fov_y_m)
    kmax_z = max(nz_ref, 1) / (2.0 * fov_z_m) if fov_z_m > 1e-30 else 1.0
    nz_use = max(int(nz_ref), 1)

    tr_np: np.ndarray | None = None
    if traj and len(traj) > 0:
        t0 = np.asarray(traj, dtype=np.float64)
        if t0.ndim == 2 and t0.shape[1] >= 2:
            tr_np = t0

    axis_ok: tuple[bool, bool, bool] | None = None
    offsets_xyz: tuple[float, float, float] = (0.0, 0.0, 0.0)
    if tr_np is not None:
        axis_ok, offsets_xyz = _per_axis_cartesian_and_offsets(
            tr_np, fov_x_m, fov_y_m, fov_z_m, nx, ny, nz_use, tol=_GRID_TOL
        )
        okx, oky, okz = axis_ok
        _log_recon(
            "[recon] detection (median k*FOV offset), tol=%g, grid nx=%d ny=%d nz=%d: "
            "kx=%s, ky=%s, kz=%s"
            % (
                _GRID_TOL,
                nx,
                ny,
                nz_use,
                "Cartesian" if okx else "non-Cartesian",
                "Cartesian" if oky else "non-Cartesian",
                "Cartesian" if okz else "non-Cartesian",
            )
        )
        _log_traj_and_detection(
            tr_np,
            fov_x_m,
            fov_y_m,
            fov_z_m,
            nx,
            ny,
            nz_use,
            kmax_x,
            kmax_y,
            kmax_z,
            _GRID_TOL,
            axis_ok,
            offsets_xyz,
        )
    else:
        _log_recon(
            "[recon] trajectory: missing or invalid shape; using synthetic ω grid; "
            "per-axis k-grid detection skipped"
        )

    reco: np.ndarray | None = None
    if tr_np is not None and axis_ok is not None and all(axis_ok):
        n_cart = min(int(signal.size), int(tr_np.shape[0]))
        reco = _recon_cartesian_ifft(
            signal[:n_cart],
            tr_np[:n_cart],
            nx,
            ny,
            nz_use,
            fov_x_m,
            fov_y_m,
            fov_z_m,
            offset_n=offsets_xyz,
        )
        _log_recon(
            "[recon] transform used: kx=FFT, ky=FFT, kz=FFT "
            "(numpy.fft.ifftn — Cartesian scatter + separable FFT; median offset_n applied per axis)"
        )

    elif tr_np is not None and axis_ok is not None and not all(axis_ok):
        if kmax_x > 1e-30 and kmax_y > 1e-30 and np.abs(tr_np[:, :2]).max() > 1e-18:
            n_full = min(int(signal.size), int(tr_np.shape[0]))
            reco = _recon_full_nufft(
                signal[:n_full],
                tr_np[:n_full],
                nx,
                ny,
                nz_use,
                kmax_x,
                kmax_y,
                kmax_z,
            )
            _log_recon(
                "[recon] transform used: kx=PyNUFFT, ky=PyNUFFT, kz=PyNUFFT "
                "(pynufft joint 3D NUFFT — not all axes on Cartesian grid after offset)"
            )

    if reco is None:
        # Synthetic ω grid (no trajectory or zero kxy fallback).
        om: np.ndarray | None = None
        if tr_np is not None:
            kxy = tr_np[:, :2]
            kz_col = tr_np[:, 2].astype(np.float64) if tr_np.shape[1] >= 3 else None
            if kmax_x > 1e-30 and kmax_y > 1e-30 and np.abs(kxy).max() > 1e-18:
                oz = np.zeros(kxy.shape[0], dtype=np.float64)
                if kz_col is not None and kmax_z > 1e-30:
                    oz = (kz_col / kmax_z) * np.pi
                om2 = np.stack(
                    [
                        (kxy[:, 0] / kmax_x) * np.pi,
                        (kxy[:, 1] / kmax_y) * np.pi,
                    ],
                    axis=-1,
                )
                om = np.column_stack([om2[:, 0], om2[:, 1], oz])
        if om is None:
            kx = np.linspace(-np.pi, np.pi, nx, endpoint=False)
            ky = np.linspace(-np.pi, np.pi, ny, endpoint=False)
            kxg, kyg = np.meshgrid(kx, ky, indexing="xy")
            kzg = np.zeros_like(kxg, dtype=np.float64)
            om = np.stack([kxg.ravel(), kyg.ravel(), kzg.ravel()], axis=-1)

        n = min(signal.size, om.shape[0])
        signal_n = signal[:n]
        om_n = om[:n]

        a = NUFFT()
        kz_plan = max(2 * nz_use, 4)
        a.plan(om_n, (nx, ny, nz_use), (2 * nx, 2 * ny, kz_plan), (8, 8, 8))
        reco = a.adjoint(signal_n).reshape(nx, ny, nz_use)
        if axis_ok is not None:
            _log_recon(
                "[recon] transform used: kx=PyNUFFT, ky=PyNUFFT, kz=PyNUFFT "
                "(pynufft joint 3D — fallback synthetic ω or zero-kxy trajectory)"
            )
        else:
            _log_recon(
                "[recon] transform used: kx=PyNUFFT, ky=PyNUFFT, kz=PyNUFFT "
                "(pynufft joint 3D; synthetic ω trajectory)"
            )
    mag3d = np.abs(reco).astype(np.float32)

    # Flip voxel data on all axes for display alignment; affine unchanged.
    mag3d = np.ascontiguousarray(np.flip(mag3d, axis=(0, 1, 2)))
    # Compensate ~1-voxel shift (NUFFT / grid centering vs NIfTI voxel centers).
    for _ax in (0, 1, 2):
        mag3d = np.roll(mag3d, 1, axis=_ax)
    mag3d = np.ascontiguousarray(mag3d)

    out = nib.Nifti1Image(np.asarray(mag3d, dtype=np.float32), ref_img.affine)
    out.header.set_zooms((dx_mm, dy_mm, dz_mm))
    out.set_sform(ref_img.affine, code=2)
    out.set_qform(ref_img.affine, code=2)
    nib.save(out, out_path)
    return out_path
