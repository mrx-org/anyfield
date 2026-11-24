"""Regression coverage for scan_zero/recon.py before it moves into the Web Worker.

These pin down the two reconstruction paths (centered-Cartesian ifftn scatter vs
PyNUFFT + Pipe-Menon DCF) and the k-space debug output mode, so the worker
migration / recon consolidation can be checked
against a known-good baseline instead of eyeballed.

``run_sim_recon`` actually has four reconstruction branches, and the later tests
in this file cover the remaining two: the synthetic-ω / zero-kxy fallback (the
``if reco is None:`` block) and the 3-D NUFFT plan taken when ``nz > 1``. Because
every branch ends with a ``[recon] transform used: ...`` line, the tests that care
which branch ran assert on that captured line rather than inferring it from the
numbers.
"""
from __future__ import annotations

import sys
import types
from pathlib import Path

import numpy as np
import nibabel as nib
import pytest

from scan_zero import recon, recon_kernels
from conftest import make_ref_mask_nifti_bytes

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_recon_py_loads_under_the_browser_exec_contract():
    """recon.py must import cleanly with NO package context.

    The app does not import this module -- `scan_module.js` fetches it as text and
    execs it into a throwaway `types.ModuleType`, so `__package__` is unset and any
    relative import raises ImportError. Every other test in this file imports it as
    `scan_zero.recon`, where relative imports work fine, so nothing else here can
    catch a regression in the loading contract the browser actually uses.

    This is not hypothetical: an import-based suite can stay green while this
    path is broken.
    """
    module_dir = REPO_ROOT / "scan_zero"
    src = (module_dir / "recon.py").read_text()
    mod = types.ModuleType("_scan_recon_live")
    mod.__dict__["__file__"] = "/scan_zero/recon.py"

    # Mirrors the loader putting the module's own directory on sys.path so the flat
    # `recon_kernels` name resolves.
    added = str(module_dir) not in sys.path
    if added:
        sys.path.insert(0, str(module_dir))
    try:
        exec(compile(src, "/scan_zero/recon.py", "exec"), mod.__dict__)
    finally:
        if added:
            sys.path.remove(str(module_dir))
        sys.modules.pop("recon_kernels", None)

    assert callable(mod.__dict__["run_sim_recon"])
    assert "output_mode" in src  # the staleness check the loader itself performs


def _fft_bin_indices(n: int) -> np.ndarray:
    """Integer frequency bins in numpy's own fftn index order (0..N/2-1, -N/2..-1)."""
    return np.rint(np.fft.fftfreq(n) * n).astype(np.int64)


def _build_cartesian_traj_and_signal(target: np.ndarray, fov_x_m: float, fov_y_m: float):
    """Exact k-space samples of ``target`` at every grid point, in an order that
    round-trips through recon.run_sim_recon's Cartesian scatter path."""
    nx, ny = target.shape
    ksp_full = np.fft.fftn(target, norm="ortho")
    nvals_x = _fft_bin_indices(nx)
    nvals_y = _fft_bin_indices(ny)

    kx, ky, sig = [], [], []
    for ix, nvx in enumerate(nvals_x):
        for iy, nvy in enumerate(nvals_y):
            kx.append(nvx / fov_x_m)
            ky.append(nvy / fov_y_m)
            sig.append(ksp_full[ix, iy])

    traj = np.column_stack([kx, ky]).tolist()
    signal_pairs = [[complex(s).real, complex(s).imag] for s in sig]
    return traj, signal_pairs


def test_run_sim_recon_cartesian_round_trip(tmp_path):
    """Exact centered-Cartesian samples of a known image must reconstruct fftshift(image)."""
    nx, ny, nz = 8, 8, 1
    dx_mm = dy_mm = dz_mm = 4.0
    ref_bytes = make_ref_mask_nifti_bytes(tmp_path, nx, ny, nz, dx_mm, dy_mm, dz_mm)

    fov_x_m = nx * dx_mm * 1e-3
    fov_y_m = ny * dy_mm * 1e-3

    rng = np.random.default_rng(0)
    target = (rng.standard_normal((nx, ny)) + 1j * rng.standard_normal((nx, ny)))
    target = target.astype(np.complex128)

    traj, signal_pairs = _build_cartesian_traj_and_signal(target, fov_x_m, fov_y_m)

    out_path = tmp_path / "recon_out.nii"
    result_path = recon.run_sim_recon(signal_pairs, traj, ref_bytes, out_path=str(out_path))

    out_img = nib.load(result_path)
    vol = out_img.get_fdata(dtype=np.float32)  # (nx, ny, nz, 2): mag, phase
    assert vol.shape == (nx, ny, nz, 2)
    mag = vol[:, :, 0, 0]
    phase = vol[:, :, 0, 1]

    expected = np.fft.fftshift(target)
    np.testing.assert_allclose(mag, np.abs(expected), atol=1e-3)

    significant = np.abs(expected) > 1e-2
    phase_err = np.angle(np.exp(1j * (phase[significant] - np.angle(expected[significant]))))
    np.testing.assert_allclose(phase_err, 0.0, atol=1e-2)


def test_run_sim_recon_cartesian_point_source_location(tmp_path):
    """Sanity check independent of the round-trip math: a single k-space point source
    (all samples equal magnitude/phase, i.e. a delta in image space at a known pixel)
    reconstructs to a peak at the expected (fftshift-mapped) pixel."""
    nx, ny, nz = 8, 8, 1
    dx_mm = dy_mm = dz_mm = 4.0
    ref_bytes = make_ref_mask_nifti_bytes(tmp_path, nx, ny, nz, dx_mm, dy_mm, dz_mm)
    fov_x_m = nx * dx_mm * 1e-3
    fov_y_m = ny * dy_mm * 1e-3

    target = np.zeros((nx, ny), dtype=np.complex128)
    px, py = 3, 5
    target[px, py] = 1.0

    traj, signal_pairs = _build_cartesian_traj_and_signal(target, fov_x_m, fov_y_m)
    out_path = tmp_path / "recon_out.nii"
    result_path = recon.run_sim_recon(signal_pairs, traj, ref_bytes, out_path=str(out_path))

    vol = nib.load(result_path).get_fdata(dtype=np.float32)
    mag = vol[:, :, 0, 0]
    peak = np.unravel_index(np.argmax(mag), mag.shape)
    expected_peak = ((px + nx // 2) % nx, (py + ny // 2) % ny)
    assert peak == expected_peak


def test_run_sim_recon_non_cartesian_fallback_is_finite_and_peaks_near_source(tmp_path):
    """Non-Cartesian (radial-ish) trajectory must take the PyNUFFT + DCF path and
    still produce a finite image with the point source roughly in the right place."""
    nx, ny, nz = 16, 16, 1
    dx_mm = dy_mm = dz_mm = 2.0
    ref_bytes = make_ref_mask_nifti_bytes(tmp_path, nx, ny, nz, dx_mm, dy_mm, dz_mm)
    fov_x_m = nx * dx_mm * 1e-3
    fov_y_m = ny * dy_mm * 1e-3
    kmax_x = nx / (2.0 * fov_x_m)
    kmax_y = ny / (2.0 * fov_y_m)

    # Radial spokes through k-space center -- deliberately not on the Cartesian grid.
    n_spokes = 32
    n_per_spoke = 33
    angles = np.linspace(0, np.pi, n_spokes, endpoint=False)
    r = np.linspace(-1.0, 1.0, n_per_spoke)
    kx, ky = [], []
    for a in angles:
        kx.extend((r * kmax_x * np.cos(a)).tolist())
        ky.extend((r * kmax_y * np.sin(a)).tolist())
    traj = np.column_stack([kx, ky])

    px_m, py_m = 0.003, -0.002  # small off-center point source, in meters
    phase = 2 * np.pi * (traj[:, 0] * px_m + traj[:, 1] * py_m)
    signal = np.exp(-1j * phase)
    signal_pairs = np.column_stack([signal.real, signal.imag]).tolist()

    out_path = tmp_path / "recon_out.nii"
    result_path = recon.run_sim_recon(
        signal_pairs, traj.tolist(), ref_bytes, out_path=str(out_path)
    )

    vol = nib.load(result_path).get_fdata(dtype=np.float32)
    assert vol.shape == (nx, ny, nz, 2)
    assert np.all(np.isfinite(vol))
    mag = vol[:, :, 0, 0]
    assert mag.max() > 0

    peak_ix, peak_iy = np.unravel_index(np.argmax(mag), mag.shape)
    expected_ix = nx / 2 + px_m / (dx_mm * 1e-3)
    expected_iy = ny / 2 + py_m / (dy_mm * 1e-3)
    assert abs(peak_ix - expected_ix) <= 1.5
    assert abs(peak_iy - expected_iy) <= 1.5


def test_run_sim_recon_kspace_log_mode(tmp_path):
    nx, ny, nz = 8, 8, 1
    dx_mm = dy_mm = dz_mm = 4.0
    ref_bytes = make_ref_mask_nifti_bytes(tmp_path, nx, ny, nz, dx_mm, dy_mm, dz_mm)
    fov_x_m = nx * dx_mm * 1e-3
    fov_y_m = ny * dy_mm * 1e-3

    target = np.ones((nx, ny), dtype=np.complex128)
    traj, signal_pairs = _build_cartesian_traj_and_signal(target, fov_x_m, fov_y_m)

    out_path = tmp_path / "kspace_log.nii"
    result_path = recon.run_sim_recon(
        signal_pairs, traj, ref_bytes, out_path=str(out_path), output_mode="kspace_log"
    )
    vol = nib.load(result_path).get_fdata(dtype=np.float32)
    assert vol.shape == (nx, ny, nz)
    assert np.all(vol >= 0.0)  # log(abs(k)+1) is non-negative by construction


@pytest.mark.parametrize(
    ("k_axis", "fov_m", "n_len", "expected_ok"),
    [
        (np.array([-2.0, -1.0, 0.0, 1.0]), 1.0, 4, True),  # integer k*FOV
        (np.array([-2.1, -1.0, 0.0, 1.0]), 1.0, 4, False),  # one sample off-grid
        (np.array([]), 1.0, 4, True),  # empty axis is trivially "Cartesian"
    ],
)
def test_axis_cartesian_after_offset(k_axis, fov_m, n_len, expected_ok):
    ok, _offset = recon._axis_cartesian_after_offset(k_axis, fov_m, n_len, recon._GRID_TOL)
    assert ok is expected_ok


def test_centered_int_range_even_vs_odd():
    assert recon._centered_int_range(8) == (-4, 4)
    assert recon._centered_int_range(7) == (-3, 3)


def test_scatter_cartesian_kspace_drops_out_of_range_samples(tmp_path):
    nx, ny, nz = 4, 4, 1
    fov_m = 1.0
    # n=-3 is outside [-2, 2] for nx=4 and must be cropped, not aliased in.
    tr = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [-3.0, 0.0, 0.0]])
    signal = np.array([1.0 + 0j, 2.0 + 0j, 99.0 + 0j], dtype=np.complex64)
    ksp = recon._scatter_cartesian_kspace(signal, tr, nx, ny, nz, fov_m, fov_m, fov_m)
    assert ksp[0, 0, 0] == pytest.approx(1.0 + 0j)
    assert ksp[1, 0, 0] == pytest.approx(2.0 + 0j)
    assert np.sum(np.abs(ksp)) == pytest.approx(3.0)  # the n=-3 sample was dropped, not aliased


# --------------------------------------------------------------------------
# Branch 3 (synthetic ω / zero-kxy fallback) and branch 4 (3-D NUFFT plan).
# --------------------------------------------------------------------------

TRANSFORM_LINE = "[recon] transform used:"
CARTESIAN_WITNESS = "kx=FFT, ky=FFT, kz=FFT"
FULL_NUFFT_WITNESS = "pynufft joint 3D NUFFT + Pipe-Menon density compensation"
SYNTHETIC_WITNESS = "pynufft synthetic ω trajectory"
ZERO_KXY_WITNESS = "pynufft fallback synthetic ω / zero-kxy trajectory"


def _transform_line(capsys) -> str:
    """The single ``[recon] transform used: ...`` line from the most recent recon.

    recon.py logs exactly one of these per call, on every branch, so it is the
    cheapest reliable witness for *which* branch ran.
    """
    lines = [ln for ln in capsys.readouterr().out.splitlines() if ln.startswith(TRANSFORM_LINE)]
    assert len(lines) == 1, f"expected one transform line, got {lines}"
    return lines[0]


def _build_cartesian_traj_and_signal_3d(
    target: np.ndarray, fov_x_m: float, fov_y_m: float, fov_z_m: float
):
    """3-D sibling of ``_build_cartesian_traj_and_signal``: exact k-space samples of a
    3-D ``target`` at every grid point of the recon matrix."""
    nx, ny, nz = target.shape
    ksp_full = np.fft.fftn(target, norm="ortho")
    nvals_x = _fft_bin_indices(nx)
    nvals_y = _fft_bin_indices(ny)
    nvals_z = _fft_bin_indices(nz)

    kx, ky, kz, sig = [], [], [], []
    for ix, nvx in enumerate(nvals_x):
        for iy, nvy in enumerate(nvals_y):
            for iz, nvz in enumerate(nvals_z):
                kx.append(nvx / fov_x_m)
                ky.append(nvy / fov_y_m)
                kz.append(nvz / fov_z_m)
                sig.append(ksp_full[ix, iy, iz])

    traj = np.column_stack([kx, ky, kz]).tolist()
    signal_pairs = [[complex(s).real, complex(s).imag] for s in sig]
    return traj, signal_pairs


def _synthetic_omega_grid(nx: int, ny: int) -> np.ndarray:
    """The (nx*ny, 3) ω meshgrid recon.py builds when it has no usable trajectory.

    Mirrors the ``linspace(-pi, pi, N, endpoint=False)`` / ``meshgrid(..., indexing="xy")``
    construction verbatim so tests can reproduce the fallback's own sampling order.
    """
    kx = np.linspace(-np.pi, np.pi, nx, endpoint=False)
    ky = np.linspace(-np.pi, np.pi, ny, endpoint=False)
    kxg, kyg = np.meshgrid(kx, ky, indexing="xy")
    kzg = np.zeros_like(kxg, dtype=np.float64)
    return np.stack([kxg.ravel(), kyg.ravel(), kzg.ravel()], axis=-1)


def _adjoint_2d(om_xy: np.ndarray, signal: np.ndarray, nx: int, ny: int) -> np.ndarray:
    """Unweighted PyNUFFT adjoint with the same 2-D plan parameters recon.py uses.

    Planned by hand rather than through ``recon_kernels.nufft_adjoint`` so this stays
    an independent reference instead of checking the kernel against itself.
    """
    a = recon_kernels.NUFFT()
    a.plan(om_xy, (nx, ny), (2 * nx, 2 * ny), (6, 6))
    return np.asarray(a.adjoint(signal.astype(np.complex64))).reshape(nx, ny)


def _kooshball_traj_3d(kmax_x, kmax_y, kmax_z, n_spokes=24, n_per_spoke=11) -> np.ndarray:
    """Genuinely 3-D non-Cartesian spokes (golden-angle directions through k-space
    center), with |kz| well away from any integer ``kz * FOV_z``."""
    gi = np.arange(n_spokes) + 0.5
    cos_t = 1.0 - 2.0 * gi / n_spokes
    sin_t = np.sqrt(np.clip(1.0 - cos_t**2, 0.0, 1.0))
    phi = np.pi * (1.0 + 5.0**0.5) * gi
    r = np.linspace(-1.0, 1.0, n_per_spoke)

    kx, ky, kz = [], [], []
    for c, s, ph in zip(cos_t, sin_t, phi):
        kx.extend((r * kmax_x * s * np.cos(ph)).tolist())
        ky.extend((r * kmax_y * s * np.sin(ph)).tolist())
        kz.extend((r * kmax_z * c).tolist())
    return np.column_stack([kx, ky, kz])


@pytest.mark.parametrize("traj_points", [[], None])
def test_run_sim_recon_no_trajectory_uses_synthetic_omega_grid(tmp_path, capsys, traj_points):
    """With no trajectory the recon still produces a valid image, via a synthetic ω
    meshgrid rather than the caller's k-space.

    Both ``[]`` and ``None`` reach this path: the guard is ``if traj and len(traj) > 0``,
    so anything falsy short-circuits before ``len()`` is called and never raises. The
    resulting image is exactly the unweighted 2-D adjoint on that meshgrid, which is
    what pins the fallback's plan parameters (6x6 interpolator, 2x oversampling) and
    its lack of density compensation.
    """
    nx, ny, nz = 8, 8, 1
    dx_mm = dy_mm = dz_mm = 4.0
    ref_bytes = make_ref_mask_nifti_bytes(tmp_path, nx, ny, nz, dx_mm, dy_mm, dz_mm)

    rng = np.random.default_rng(11)
    signal = (rng.standard_normal(nx * ny) + 1j * rng.standard_normal(nx * ny)).astype(
        np.complex64
    )
    signal_pairs = np.column_stack([signal.real, signal.imag]).tolist()

    out_path = tmp_path / "no_traj.nii"
    result_path = recon.run_sim_recon(
        signal_pairs, traj_points, ref_bytes, out_path=str(out_path)
    )
    assert SYNTHETIC_WITNESS in _transform_line(capsys)

    vol = nib.load(result_path).get_fdata(dtype=np.float32)
    assert vol.shape == (nx, ny, nz, 2)
    assert np.all(np.isfinite(vol))
    assert vol[:, :, 0, 0].max() > 0

    om = _synthetic_omega_grid(nx, ny)
    expected = _adjoint_2d(om[:, :2], signal, nx, ny)
    np.testing.assert_allclose(vol[:, :, 0, 0], np.abs(expected), rtol=1e-5, atol=1e-6)


def test_run_sim_recon_no_trajectory_truncates_signal_to_omega_grid(tmp_path, capsys):
    """The synthetic-ω path silently reconciles signal length against the ω grid, in
    both directions, via ``n = min(signal.size, om.shape[0])``.

    FINDING (pinned, not fixed): an over-length signal is truncated to ``nx*ny``
    with no warning -- samples past the grid are dropped and the output is bit-identical
    to the exact-length case. An under-length signal is also accepted, but ``om[:n]``
    takes the *first* n rows of a meshgrid raveled in "xy" order, i.e. the lowest-ky
    rows only. Half a signal therefore reconstructs from the negative-ky half of
    k-space rather than a centered subset -- asymmetric, but finite and non-crashing.
    """
    nx, ny, nz = 8, 8, 1
    dx_mm = dy_mm = dz_mm = 4.0
    ref_bytes = make_ref_mask_nifti_bytes(tmp_path, nx, ny, nz, dx_mm, dy_mm, dz_mm)

    rng = np.random.default_rng(12)
    n_grid = nx * ny
    full = (rng.standard_normal(n_grid + 7) + 1j * rng.standard_normal(n_grid + 7)).astype(
        np.complex64
    )

    def _run(sig, name):
        pairs = np.column_stack([sig.real, sig.imag]).tolist()
        path = recon.run_sim_recon(pairs, [], ref_bytes, out_path=str(tmp_path / name))
        assert SYNTHETIC_WITNESS in _transform_line(capsys)
        return nib.load(path).get_fdata(dtype=np.float32)

    exact = _run(full[:n_grid], "exact.nii")
    over = _run(full, "over.nii")
    np.testing.assert_array_equal(over, exact)  # the 7 extra samples were dropped silently

    n_half = n_grid // 2
    under = _run(full[:n_half], "under.nii")
    assert under.shape == (nx, ny, nz, 2)
    assert np.all(np.isfinite(under))

    om = _synthetic_omega_grid(nx, ny)
    assert np.all(om[:n_half, 1] < 0.0)  # only negative-ky rows survive the truncation
    expected = _adjoint_2d(om[:n_half, :2], full[:n_half], nx, ny)
    np.testing.assert_allclose(under[:, :, 0, 0], np.abs(expected), rtol=1e-5, atol=1e-6)


def test_run_sim_recon_all_zero_kxy_trajectory_takes_cartesian_branch(tmp_path, capsys):
    """An all-zero trajectory does NOT reach the zero-kxy fallback -- it takes the
    Cartesian ifftn branch.

    This is the non-obvious part of the control flow: the fallback's comment advertises a
    "zero kxy" case, but zero k is trivially on-grid (``k*FOV = 0`` is an integer on
    every axis), so ``all(axis_ok)`` is True and the dispatcher never reaches the
    non-Cartesian ``elif`` at all. Every sample lands in the DC bin, so the image is
    uniform with magnitude ``|sum(signal)| / sqrt(nx*ny*nz)`` (ifftn with norm="ortho").
    """
    nx, ny, nz = 8, 8, 1
    dx_mm = dy_mm = dz_mm = 4.0
    ref_bytes = make_ref_mask_nifti_bytes(tmp_path, nx, ny, nz, dx_mm, dy_mm, dz_mm)

    rng = np.random.default_rng(13)
    signal = rng.standard_normal(16) + 1j * rng.standard_normal(16)
    signal_pairs = np.column_stack([signal.real, signal.imag]).tolist()
    traj = np.zeros((16, 3)).tolist()

    out_path = tmp_path / "zero_traj.nii"
    result_path = recon.run_sim_recon(signal_pairs, traj, ref_bytes, out_path=str(out_path))
    assert CARTESIAN_WITNESS in _transform_line(capsys)

    vol = nib.load(result_path).get_fdata(dtype=np.float32)
    assert vol.shape == (nx, ny, nz, 2)
    mag = vol[:, :, 0, 0]
    expected_mag = abs(complex(np.sum(signal.astype(np.complex64)))) / np.sqrt(nx * ny * nz)
    np.testing.assert_allclose(mag, expected_mag, rtol=1e-5, atol=1e-6)


def test_run_sim_recon_zero_kxy_with_offgrid_kz_discards_the_trajectory(tmp_path, capsys):
    """The only reachable way into the zero-kxy fallback: zero kx/ky with an *off-grid*
    kz, which makes the kz axis non-Cartesian while ``|kxy|.max()`` stays below 1e-18.

    FINDING (pinned, not fixed): the fallback then throws the trajectory away entirely.
    Its inner ``if kmax_x > 1e-30 ... and abs(kxy).max() > 1e-18`` block, which would
    have built ω from the real kz column, is dead code -- reaching ``reco is None`` with
    a trajectory present *requires* that same condition to be False. So ``om`` is always
    the synthetic meshgrid here and the kz information is silently dropped: the output
    is bit-identical to passing no trajectory at all. Only the log line distinguishes
    the two ("fallback synthetic ω / zero-kxy" vs plain "synthetic ω").
    """
    nx, ny, nz = 8, 8, 1
    dx_mm = dy_mm = dz_mm = 4.0
    ref_bytes = make_ref_mask_nifti_bytes(tmp_path, nx, ny, nz, dx_mm, dy_mm, dz_mm)

    rng = np.random.default_rng(14)
    signal = rng.standard_normal(16) + 1j * rng.standard_normal(16)
    signal_pairs = np.column_stack([signal.real, signal.imag]).tolist()

    traj = np.zeros((16, 3))
    traj[:, 2] = np.linspace(-1.0, 1.0, 16) * 37.3  # kz * FOV_z is nowhere near integer

    with_kz = nib.load(
        recon.run_sim_recon(
            signal_pairs, traj.tolist(), ref_bytes, out_path=str(tmp_path / "kz.nii")
        )
    ).get_fdata(dtype=np.float32)
    assert ZERO_KXY_WITNESS in _transform_line(capsys)

    without_traj = nib.load(
        recon.run_sim_recon(
            signal_pairs, [], ref_bytes, out_path=str(tmp_path / "none.nii")
        )
    ).get_fdata(dtype=np.float32)
    assert SYNTHETIC_WITNESS in _transform_line(capsys)

    assert with_kz.shape == (nx, ny, nz, 2)
    assert np.all(np.isfinite(with_kz))
    np.testing.assert_array_equal(with_kz, without_traj)


def test_synthetic_omega_fallback_applies_no_density_compensation(tmp_path, capsys):
    """The two NUFFT branches disagree about density compensation: the full-NUFFT branch
    weights the signal with Pipe-Menon DCF, the synthetic-ω fallback does not.

    This asymmetry is current behaviour, pinned rather than endorsed. A future unification
    of the two paths may well want DCF applied on both (or neither); this test is what
    will fail loudly when that happens, so the change is a deliberate decision rather
    than an accident of the refactor.

    Two halves. On a real radial trajectory the DCF materially changes the *shape* of the
    reconstruction, so branch 2's weighting is not cosmetic. On the synthetic ω grid the
    weights come out uniform (the grid is uniformly dense by construction), so skipping
    them costs a global scale factor of roughly 4x rather than a shape change -- the
    fallback's output matches the unweighted adjoint exactly, and the weighted adjoint is
    that same image scaled by the constant weight.
    """
    nx, ny, nz = 8, 8, 1
    dx_mm = dy_mm = dz_mm = 4.0
    ref_bytes = make_ref_mask_nifti_bytes(tmp_path, nx, ny, nz, dx_mm, dy_mm, dz_mm)
    fov_x_m = nx * dx_mm * 1e-3
    fov_y_m = ny * dy_mm * 1e-3
    kmax_x = nx / (2.0 * fov_x_m)
    kmax_y = ny / (2.0 * fov_y_m)

    angles = np.linspace(0, np.pi, 8, endpoint=False)
    r = np.linspace(-1.0, 1.0, 17)
    kx, ky = [], []
    for a in angles:
        kx.extend((r * kmax_x * np.cos(a)).tolist())
        ky.extend((r * kmax_y * np.sin(a)).tolist())
    traj = np.column_stack([kx, ky, np.zeros(len(kx))])

    phase = 2 * np.pi * (traj[:, 0] * 0.003 + traj[:, 1] * -0.002)
    radial_signal = np.exp(-1j * phase).astype(np.complex64)

    plain, dcf_none = recon._recon_full_nufft(
        radial_signal, traj, nx, ny, nz, kmax_x, kmax_y, kmax_x, apply_dcf=False
    )
    weighted, dcf = recon._recon_full_nufft(
        radial_signal, traj, nx, ny, nz, kmax_x, kmax_y, kmax_x, apply_dcf=True
    )
    assert dcf_none is None
    assert dcf is not None and dcf.shape == (traj.shape[0],)

    def _unit(x):
        m = np.abs(x)
        return m / m.max()

    shape_change = np.linalg.norm(_unit(plain) - _unit(weighted)) / np.linalg.norm(
        _unit(weighted)
    )
    assert shape_change > 0.1  # radial DCF is not a mere rescale

    rng = np.random.default_rng(15)
    signal = (rng.standard_normal(nx * ny) + 1j * rng.standard_normal(nx * ny)).astype(
        np.complex64
    )
    signal_pairs = np.column_stack([signal.real, signal.imag]).tolist()
    fallback = nib.load(
        recon.run_sim_recon(signal_pairs, [], ref_bytes, out_path=str(tmp_path / "fb.nii"))
    ).get_fdata(dtype=np.float32)
    assert SYNTHETIC_WITNESS in _transform_line(capsys)

    om = _synthetic_omega_grid(nx, ny)
    a = recon_kernels.NUFFT()
    a.plan(om[:, :2], (nx, ny), (2 * nx, 2 * ny), (6, 6))
    unweighted = np.asarray(a.adjoint(signal)).reshape(nx, ny)
    np.testing.assert_allclose(
        fallback[:, :, 0, 0], np.abs(unweighted), rtol=1e-5, atol=1e-6
    )

    grid_dcf = recon._compute_pipe_menon_dcf(a, om.shape[0])
    assert np.ptp(grid_dcf) < 1e-4  # uniform grid -> uniform weights
    w = float(np.mean(grid_dcf))
    assert w < 0.5  # so the omission is a ~4x scale error, not negligible
    grid_weighted = np.asarray(a.adjoint(signal * grid_dcf.astype(np.complex64))).reshape(
        nx, ny
    )
    np.testing.assert_allclose(
        np.abs(grid_weighted), w * fallback[:, :, 0, 0], rtol=1e-4, atol=1e-6
    )


def test_run_sim_recon_3d_nufft_nz_gt_1_peaks_near_source(tmp_path, capsys):
    """A genuinely 3-D non-Cartesian trajectory takes the full-NUFFT branch with the 3-D
    plan ((nx, ny, nz) with a (4, 4, 4) interpolator) and localises a point source in all
    three axes.

    Every other test in this file uses nz=1, so this is the only coverage of the 3-D
    plan. The tolerance is deliberately loose -- the point is to catch major breakage
    (wrong reshape order, collapsed z, transposed axes) rather than to assert sub-voxel
    accuracy from 264 samples.
    """
    nx, ny, nz = 8, 8, 4
    dx_mm = dy_mm = dz_mm = 4.0
    ref_bytes = make_ref_mask_nifti_bytes(tmp_path, nx, ny, nz, dx_mm, dy_mm, dz_mm)
    fov_x_m = nx * dx_mm * 1e-3
    fov_y_m = ny * dy_mm * 1e-3
    fov_z_m = nz * dz_mm * 1e-3
    kmax_x = nx / (2.0 * fov_x_m)
    kmax_y = ny / (2.0 * fov_y_m)
    kmax_z = nz / (2.0 * fov_z_m)

    traj = _kooshball_traj_3d(kmax_x, kmax_y, kmax_z)
    assert np.abs(traj[:, 2]).max() > 1e-18  # 3-D plan requires a live kz column

    px_m, py_m, pz_m = 0.004, -0.008, 0.004  # off-center in every axis
    phase = 2 * np.pi * (traj[:, 0] * px_m + traj[:, 1] * py_m + traj[:, 2] * pz_m)
    signal = np.exp(-1j * phase)
    signal_pairs = np.column_stack([signal.real, signal.imag]).tolist()

    out_path = tmp_path / "recon3d.nii"
    result_path = recon.run_sim_recon(
        signal_pairs, traj.tolist(), ref_bytes, out_path=str(out_path)
    )
    assert FULL_NUFFT_WITNESS in _transform_line(capsys)

    vol = nib.load(result_path).get_fdata(dtype=np.float32)
    assert vol.shape == (nx, ny, nz, 2)
    assert np.all(np.isfinite(vol))
    mag = vol[:, :, :, 0]
    assert mag.max() > 0

    peak_ix, peak_iy, peak_iz = np.unravel_index(np.argmax(mag), mag.shape)
    assert abs(peak_ix - (nx / 2 + px_m / (dx_mm * 1e-3))) <= 1.5
    assert abs(peak_iy - (ny / 2 + py_m / (dy_mm * 1e-3))) <= 1.5
    assert abs(peak_iz - (nz / 2 + pz_m / (dz_mm * 1e-3))) <= 1.5


def test_run_sim_recon_3d_cartesian_round_trip(tmp_path, capsys):
    """The Cartesian ifftn branch with nz > 1 must reconstruct fftshift(image) exactly.

    The 3-D NUFFT test above can only assert a tolerance on the peak location; this one
    gives the 3-D output grid an exact expected value, so an axis swap or a wrong z
    fftshift in the refactor shows up as a numeric failure rather than a near-miss.
    """
    nx, ny, nz = 8, 8, 4
    dx_mm = dy_mm = dz_mm = 4.0
    ref_bytes = make_ref_mask_nifti_bytes(tmp_path, nx, ny, nz, dx_mm, dy_mm, dz_mm)

    fov_x_m = nx * dx_mm * 1e-3
    fov_y_m = ny * dy_mm * 1e-3
    fov_z_m = nz * dz_mm * 1e-3

    rng = np.random.default_rng(0)
    target = rng.standard_normal((nx, ny, nz)) + 1j * rng.standard_normal((nx, ny, nz))
    target = target.astype(np.complex128)

    traj, signal_pairs = _build_cartesian_traj_and_signal_3d(
        target, fov_x_m, fov_y_m, fov_z_m
    )

    out_path = tmp_path / "recon3d_cart.nii"
    result_path = recon.run_sim_recon(signal_pairs, traj, ref_bytes, out_path=str(out_path))
    assert CARTESIAN_WITNESS in _transform_line(capsys)

    vol = nib.load(result_path).get_fdata(dtype=np.float32)
    assert vol.shape == (nx, ny, nz, 2)
    mag = vol[:, :, :, 0]
    phase = vol[:, :, :, 1]

    expected = np.fft.fftshift(target)
    np.testing.assert_allclose(mag, np.abs(expected), atol=1e-3)

    significant = np.abs(expected) > 1e-2
    phase_err = np.angle(np.exp(1j * (phase[significant] - np.angle(expected[significant]))))
    np.testing.assert_allclose(phase_err, 0.0, atol=1e-2)


@pytest.mark.parametrize(
    ("nz", "kz_kind", "expected_nd"),
    [
        (1, "zero", (8, 8)),  # both conditions hold -> cheap 2-D plan
        (1, "none", (8, 8)),  # a 2-column trajectory counts as zero kz
        (1, "nonzero", (8, 8, 1)),  # singleton z but live kz -> 3-D plan anyway
        (2, "zero", (8, 8, 2)),  # nz > 1 alone forces the 3-D plan
    ],
)
def test_recon_full_nufft_plan_selection_2d_vs_3d(monkeypatch, nz, kz_kind, expected_nd):
    """``_recon_full_nufft`` picks the 2-D plan only when ``int(nz) == 1`` AND no
    ``|kz| > 1e-18``; both boundaries of that predicate are pinned here.

    The returned array cannot witness the choice on its own (with nz=1 both plans reshape
    to (nx, ny, 1)), so the test records the actual ``NUFFT.plan`` arguments. That also
    pins the interpolator sizes -- (6, 6) for 2-D vs (4, 4, 4) for 3-D -- and the
    ``kz_plan = max(2*nz, 4)`` oversampling floor.

    The spy goes on ``recon_kernels``, since that is where the plan is now built;
    ``recon.py`` decides only the shape it asks for. So this deliberately asserts
    across the layer boundary -- it is the parameters the two layers agree on that
    matter, not which file constructs the object.
    """
    nx, ny = 8, 8
    calls: list[tuple] = []

    class _PlanSpy(recon_kernels.NUFFT):
        def plan(self, om, Nd, Kd, Jd, *args, **kwargs):
            calls.append((np.asarray(om).shape, tuple(Nd), tuple(Kd), tuple(Jd)))
            return super().plan(om, Nd, Kd, Jd, *args, **kwargs)

    monkeypatch.setattr(recon_kernels, "NUFFT", _PlanSpy)

    n_samp = 40
    rng = np.random.default_rng(16)
    kx = rng.uniform(-100.0, 100.0, n_samp)
    ky = rng.uniform(-100.0, 100.0, n_samp)
    if kz_kind == "none":
        traj = np.column_stack([kx, ky])
    elif kz_kind == "zero":
        traj = np.column_stack([kx, ky, np.zeros(n_samp)])
    else:
        traj = np.column_stack([kx, ky, rng.uniform(-100.0, 100.0, n_samp)])

    signal = np.ones(n_samp, dtype=np.complex64)
    reco, dcf = recon._recon_full_nufft(
        signal, traj, nx, ny, nz, 125.0, 125.0, 125.0, apply_dcf=True
    )

    om_shape, nd, kd, jd = calls[-1]
    assert len(calls) == 1
    assert nd == expected_nd
    if len(expected_nd) == 2:
        assert (om_shape, kd, jd) == ((n_samp, 2), (16, 16), (6, 6))
    else:
        assert (om_shape, kd, jd) == ((n_samp, 3), (16, 16, max(2 * nz, 4)), (4, 4, 4))
    assert reco.shape == (nx, ny, nz)
    assert dcf is not None and dcf.shape == (n_samp,)
