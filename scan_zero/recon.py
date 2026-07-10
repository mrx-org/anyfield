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

If **all** axes pass the Cartesian spacing test, reconstruction uses ``numpy.fft.ifftn``
on the **recon matrix** grid (``maskX×maskY×maskZ``). Samples with ``|n| > N/2`` on
any axis are **dropped** (central k-space crop) when acquisition resolution exceeds
the recon matrix — the recon matrix is the output grid, not the acquisition size.

For non-Cartesian trajectories, density compensation is applied before the
adjoint NUFFT using a short Pipe-Menon style fixed-point iteration on PyNUFFT's
interpolation / gridding operators. This stays general across radial / spiral
style trajectories while remaining Pyodide-friendly.
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
_DCF_ITERS = 20
_DCF_EPS = 1e-6


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
    """Cartesian spacing test on ``(k*FOV - offset)`` (integer grid); range not checked.

    Recon matrix size defines the output grid; out-of-range samples are cropped at scatter.
    ``n_len`` is kept for API compatibility with callers that pass recon ``nx/ny/nz``.
    """
    del n_len  # crop applied in scatter, not in detection
    if k_axis.size == 0:
        return True, 0.0
    d = k_axis.astype(np.float64, copy=False) * fov_m
    offset = _median_offset_n(d)
    d_adj = d - offset
    r = np.round(d_adj)
    if not np.all(np.abs(d_adj - r) <= tol):
        return False, offset
    return True, offset


def _axis_int_n(k: np.ndarray, fov_m: float, offset_n: float) -> np.ndarray:
    """Integer frequency index ``n = round(k*FOV - offset_n)``."""
    d_adj = k.astype(np.float64) * fov_m - offset_n
    return np.rint(d_adj).astype(np.int64)


def _in_recon_index_range(n: np.ndarray, n_len: int) -> np.ndarray:
    """True where integer index ``n`` lies in the centered recon grid ``[-N/2, N/2]``."""
    lo, hi = _centered_int_range(n_len)
    return (n >= lo) & (n <= hi)


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
        crop = ""
        if ok and (nmin < lo or nmax > hi):
            crop = ", crop"
        line_parts.append("%s:%s n=%d..%d recon[%d,%d]%s" % (name, st, nmin, nmax, lo, hi, crop))
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
    True if samples lie on a centered Cartesian grid (integer ``k * FOV`` spacing).
    Recon matrix may crop a larger acquisition grid (see ``_scatter_cartesian_kspace``).
    """
    ok, _ = _per_axis_cartesian_and_offsets(
        tr, fov_x_m, fov_y_m, fov_z_m, nx, ny, nz, tol
    )
    return bool(all(ok))


def _scatter_cartesian_kspace(
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
    """Scatter ``signal_1d`` onto recon-grid k-space; crop samples outside recon range."""
    ox, oy, oz = offset_n if offset_n is not None else (0.0, 0.0, 0.0)
    ksp = np.zeros((nx, ny, nz), dtype=np.complex128)
    kx = tr[:, 0].astype(np.float64, copy=False)
    ky = tr[:, 1].astype(np.float64, copy=False)
    kz = tr[:, 2].astype(np.float64, copy=False) if tr.shape[1] >= 3 else np.zeros(tr.shape[0], dtype=np.float64)

    n_samp = min(int(signal_1d.shape[0]), int(tr.shape[0]))
    nx_n = _axis_int_n(kx[:n_samp], fov_x_m, ox)
    ny_n = _axis_int_n(ky[:n_samp], fov_y_m, oy)
    nz_n = _axis_int_n(kz[:n_samp], fov_z_m, oz)
    keep = (
        _in_recon_index_range(nx_n, nx)
        & _in_recon_index_range(ny_n, ny)
        & _in_recon_index_range(nz_n, nz)
    )
    n_kept = int(np.count_nonzero(keep))
    if n_kept < n_samp:
        _log_recon(
            "[recon] k-space crop to recon grid %dx%dx%d: kept %d / %d samples"
            % (nx, ny, nz, n_kept, n_samp)
        )
    if n_kept == 0:
        _log_recon("[recon] k-space crop: no samples in recon grid")
        return ksp.astype(np.complex64)

    ix = (nx_n[keep] % nx).astype(np.intp)
    iy = (ny_n[keep] % ny).astype(np.intp)
    iz = (nz_n[keep] % nz).astype(np.intp)
    sig = signal_1d[:n_samp][keep].astype(np.complex128, copy=False)
    np.add.at(ksp, (ix, iy, iz), sig)
    return ksp.astype(np.complex64)


def _save_image_mag_phase_nifti(
    reco: np.ndarray,
    ref_img: nib.Nifti1Image,
    out_path: str,
    dx_mm: float,
    dy_mm: float,
    dz_mm: float,
) -> str:
    """Write 4D NIfTI: frame 0 = |img|, frame 1 = angle(img) in radians."""
    mag3d = np.ascontiguousarray(np.abs(reco).astype(np.float32))
    phase3d = np.ascontiguousarray(np.angle(reco).astype(np.float32))
    vol4d = np.stack([mag3d, phase3d], axis=-1)
    out = nib.Nifti1Image(vol4d, ref_img.affine)
    out.header.set_zooms((dx_mm, dy_mm, dz_mm, 1.0))
    out.set_sform(ref_img.affine, code=2)
    out.set_qform(ref_img.affine, code=2)
    nib.save(out, out_path)
    return out_path


def _compute_pipe_menon_dcf(a: NUFFT, n_samples: int, n_iter: int = _DCF_ITERS) -> np.ndarray:
    """Fixed-point Pipe-Menon DCF using PyNUFFT interpolation operators."""
    if n_samples < 1:
        raise ValueError("Cannot compute DCF for empty trajectory.")
    try:
        y2k = a._y2k_cpu
        k2y = a._k2y_cpu
    except AttributeError as exc:
        raise RuntimeError("PyNUFFT interpolation operators unavailable for DCF.") from exc

    w = np.ones(int(n_samples), dtype=np.complex64)
    for _ in range(int(n_iter)):
        gridded = y2k(w)
        back = k2y(gridded)
        w = w / np.maximum(np.abs(back), _DCF_EPS)
    return np.abs(w).astype(np.float32)


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

    ``fftshift`` centers DC on the FOV-mask voxel grid (PyNUFFT adjoint leaves the same
    unshifted order; both paths converge after shift before NIfTI export).
    """
    ksp = _scatter_cartesian_kspace(
        signal_1d,
        tr,
        nx,
        ny,
        nz,
        fov_x_m,
        fov_y_m,
        fov_z_m,
        offset_n=offset_n,
    )
    reco = np.fft.ifftn(ksp, norm="ortho")
    reco = np.fft.fftshift(reco, axes=(0, 1, 2))
    return reco.astype(np.complex64)


def _kspace_log_volume(
    signal: np.ndarray,
    tr_np: np.ndarray | None,
    axis_ok: tuple[bool, bool, bool] | None,
    offsets_xyz: tuple[float, float, float],
    nx: int,
    ny: int,
    nz: int,
    fov_x_m: float,
    fov_y_m: float,
    fov_z_m: float,
    dx_mm: float,
    dy_mm: float,
    dz_mm: float,
    matrix: Sequence[int] | None,
) -> tuple[np.ndarray, tuple[float, float, float]]:
    """Build ``log(abs(kspace)+1)`` on recon grid (Cartesian) or acquisition matrix fallback."""
    if tr_np is not None and axis_ok is not None and all(axis_ok):
        n_cart = min(int(signal.size), int(tr_np.shape[0]))
        ksp = _scatter_cartesian_kspace(
            signal[:n_cart],
            tr_np[:n_cart],
            nx,
            ny,
            nz,
            fov_x_m,
            fov_y_m,
            fov_z_m,
            offset_n=offsets_xyz,
        )
        vol = np.log(np.abs(ksp) + 1.0).astype(np.float32)
        vol = np.fft.fftshift(vol, axes=(0, 1, 2))
        _log_recon(
            "[recon] k-space debug: Cartesian scatter + central crop + log(abs(k)+1) on recon grid %dx%dx%d"
            % (nx, ny, nz)
        )
        return vol, (dx_mm, dy_mm, dz_mm)

    if matrix is not None and len(matrix) >= 2:
        nr = max(1, int(matrix[0]))
        np_ = max(1, int(matrix[1]))
        nz_m = max(1, int(matrix[2])) if len(matrix) >= 3 else 1
        n_fit = nr * np_ * nz_m
        n = min(int(signal.size), n_fit)
        vol = np.log(np.abs(signal[:n]) + 1.0).astype(np.float32)
        if n < n_fit:
            pad = np.zeros(n_fit - n, dtype=np.float32)
            vol = np.concatenate([vol, pad], axis=0)
        vol = vol.reshape(nr, np_, nz_m, order="C")
        zooms = (
            (fov_x_m / nr) * 1e3 if fov_x_m > 0 else dx_mm,
            (fov_y_m / np_) * 1e3 if fov_y_m > 0 else dy_mm,
            (fov_z_m / nz_m) * 1e3 if fov_z_m > 0 else dz_mm,
        )
        _log_recon(
            "[recon] k-space debug: matrix reshape %dx%dx%d + log(abs(k)+1) (non-Cartesian fallback)"
            % (nr, np_, nz_m)
        )
        return vol, zooms

    vol = np.log(np.abs(signal) + 1.0).astype(np.float32).reshape(1, -1, 1)
    _log_recon("[recon] k-space debug: 1xN strip + log(abs(k)+1) (no Cartesian grid / matrix)")
    return vol, (dx_mm, dy_mm, dz_mm)


def _recon_full_nufft(
    signal_1d: np.ndarray,
    tr: np.ndarray,
    nx: int,
    ny: int,
    nz: int,
    omega_scale_x: float,
    omega_scale_y: float,
    omega_scale_z: float,
    apply_dcf: bool = False,
) -> tuple[np.ndarray, np.ndarray | None]:
    """PyNUFFT adjoint using a 2D plan for singleton-z and 3D otherwise."""
    kxy = tr[:, :2]
    kz_col = tr[:, 2].astype(np.float64) if tr.shape[1] >= 3 else None
    oz = np.zeros(kxy.shape[0], dtype=np.float64)
    if kz_col is not None and omega_scale_z > 1e-30:
        oz = (kz_col / omega_scale_z) * np.pi
    om2 = np.stack(
        [
            (kxy[:, 0] / omega_scale_x) * np.pi,
            (kxy[:, 1] / omega_scale_y) * np.pi,
        ],
        axis=-1,
    )
    om = np.column_stack([om2[:, 0], om2[:, 1], oz])
    n = min(signal_1d.size, om.shape[0])
    signal_n = signal_1d[:n].astype(np.complex64, copy=False)
    om_n = om[:n]
    a = NUFFT()
    use_2d_plan = int(nz) == 1 and (
        kz_col is None or not np.any(np.abs(kz_col[:n]) > 1e-18)
    )
    if use_2d_plan:
        a.plan(om_n[:, :2], (nx, ny), (2 * nx, 2 * ny), (6, 6))
    else:
        kz_plan = max(2 * nz, 4)
        a.plan(om_n, (nx, ny, nz), (2 * nx, 2 * ny, kz_plan), (4, 4, 4))
    dcf: np.ndarray | None = None
    if apply_dcf:
        dcf = _compute_pipe_menon_dcf(a, n)
        signal_n = signal_n * dcf.astype(np.complex64, copy=False)
    reco = a.adjoint(signal_n)
    if use_2d_plan:
        reco = np.asarray(reco).reshape(nx, ny, 1)
    else:
        reco = np.asarray(reco).reshape(nx, ny, nz)
    return reco.astype(np.complex64), dcf


def _to_py_list(x: Any) -> Any:
    if hasattr(x, "to_py"):
        return x.to_py()
    return x


def run_sim_recon(
    signal_pairs: Sequence[Sequence[float]],
    traj_points: Union[Sequence[Sequence[float]], Any],
    ref_bytes: Union[bytes, Any],
    out_path: str = DEFAULT_OUT_PATH,
    output_mode: str = "image",
    matrix: Sequence[int] | None = None,
) -> str:
    """
    Gridding adjoint (NUFFT) magnitude recon on the ref mask grid, or k-space debug output.

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
    output_mode
        ``"image"`` (default): PyNUFFT / IFFT recon magnitude.
        ``"kspace_log"``: ``log(abs(kspace)+1)`` on recon grid or acquisition matrix.
    matrix
        Optional ``[Nread, Nphase, nz]`` from seq definitions (non-Cartesian fallback).

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

    if output_mode == "kspace_log":
        vol, zooms = _kspace_log_volume(
            signal,
            tr_np,
            axis_ok,
            offsets_xyz,
            nx,
            ny,
            nz_use,
            fov_x_m,
            fov_y_m,
            fov_z_m,
            dx_mm,
            dy_mm,
            dz_mm,
            matrix,
        )
        vol = np.ascontiguousarray(vol)
        out = nib.Nifti1Image(vol, ref_img.affine)
        out.header.set_zooms(zooms)
        out.set_sform(ref_img.affine, code=2)
        out.set_qform(ref_img.affine, code=2)
        nib.save(out, out_path)
        return out_path

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
            "(numpy.fft.ifftn — Cartesian scatter + central crop to recon grid + separable FFT)"
        )

    elif tr_np is not None and axis_ok is not None and not all(axis_ok):
        if kmax_x > 1e-30 and kmax_y > 1e-30 and np.abs(tr_np[:, :2]).max() > 1e-18:
            n_full = min(int(signal.size), int(tr_np.shape[0]))
            _log_recon(
                "[recon] omega-scale target kmax: (%.6g, %.6g, %.6g) 1/m"
                % (kmax_x, kmax_y, kmax_z)
            )
            reco, dcf = _recon_full_nufft(
                signal[:n_full],
                tr_np[:n_full],
                nx,
                ny,
                nz_use,
                kmax_x,
                kmax_y,
                kmax_z,
                apply_dcf=True,
            )
            if dcf is None:
                raise RuntimeError("Pipe-Menon DCF failed to produce weights.")
            _log_recon(
                "[recon] dcf: method=pipe-menon iters=%d mean=%.4g range=[%.4g, %.4g]"
                % (
                    _DCF_ITERS,
                    float(np.mean(dcf)),
                    float(np.min(dcf)),
                    float(np.max(dcf)),
                )
            )
            _log_recon(
                "[recon] transform used: kx=PyNUFFT, ky=PyNUFFT, kz=PyNUFFT "
                "(pynufft joint 3D NUFFT + Pipe-Menon density compensation)"
            )

    if reco is None:
        # Synthetic ω grid (no trajectory or zero kxy fallback).
        om: np.ndarray | None = None
        use_2d_plan = int(nz_use) == 1
        if tr_np is not None:
            kxy = tr_np[:, :2]
            kz_col = tr_np[:, 2].astype(np.float64) if tr_np.shape[1] >= 3 else None
            if kmax_x > 1e-30 and kmax_y > 1e-30 and np.abs(kxy).max() > 1e-18:
                oz = np.zeros(kxy.shape[0], dtype=np.float64)
                if kz_col is not None and kmax_z > 1e-30:
                    oz = (kz_col / kmax_z) * np.pi
                    use_2d_plan = not np.any(np.abs(kz_col) > 1e-18) and int(nz_use) == 1
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
        signal_n = signal[:n].astype(np.complex64, copy=False)
        om_n = om[:n]

        a = NUFFT()
        if use_2d_plan:
            a.plan(om_n[:, :2], (nx, ny), (2 * nx, 2 * ny), (6, 6))
            reco = np.asarray(a.adjoint(signal_n)).reshape(nx, ny, 1)
        else:
            kz_plan = max(2 * nz_use, 4)
            a.plan(om_n, (nx, ny, nz_use), (2 * nx, 2 * ny, kz_plan), (4, 4, 4))
            reco = np.asarray(a.adjoint(signal_n)).reshape(nx, ny, nz_use)
        _fallback_note = (
            "pynufft fallback synthetic ω / zero-kxy trajectory"
            if axis_ok is not None
            else "pynufft synthetic ω trajectory"
        )
        _log_recon(
            "[recon] transform used: kx=PyNUFFT, ky=PyNUFFT, kz=PyNUFFT (%s)"
            % _fallback_note
        )
    _log_recon("[recon] output: 4D NIfTI frame 0 = |img|, frame 1 = angle(img) [rad]")
    return _save_image_mag_phase_nifti(reco, ref_img, out_path, dx_mm, dy_mm, dz_mm)
