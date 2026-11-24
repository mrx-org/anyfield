"""Cross-checks that the app's two recon call paths agree, now that they share a kernel.

`scan_zero/recon.py` ("A", the SIM pipeline) and
`pypulseq/seq_check_web/seq_check_py_recon.py` ("B", seq_check_web's Fig 6) used to
carry independent copies of the same Pipe-Menon DCF and adjoint NUFFT, which had
drifted into disagreeing about image orientation. Both now call
`scan_zero/recon_kernels.py`, so this file's job has changed: it no longer documents
a divergence, it *guarantees the absence of one*. If a future change reintroduces a
private copy on either side, these tests fail.

The orientation question that used to be open is decided: the scan_zero convention
(unflipped, centred point source at ``n // 2``) is the only one. B's images are
therefore mirrored in both axes relative to releases before the merge.

One difference remains by design: B normalises magnitude to [0, 1] and maps phase
onto [0, 1] for its Niivue-facing JSON payload, while A writes raw magnitude and
raw radians into a NIfTI. That is presentation, applied outside the recon, and
`test_value_ranges_differ_only_by_display_scaling` shows it changes nothing else.
"""
from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

import numpy as np
import nibabel as nib
import pytest
from pynufft import NUFFT

from scan_zero import recon, recon_kernels
from conftest import make_ref_mask_nifti_bytes

REPO_ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = REPO_ROOT / "pypulseq" / "seq_check_web" / "seq_check_py_recon.py"
KERNELS_DIR = REPO_ROOT / "scan_zero"


class _ExecedModule:
    """Attribute access onto the *live* exec namespace.

    Copied from test_seq_check_py_recon.py rather than imported: the tests directory
    is not a package, and duplicating ~15 lines is cheaper than coupling two test
    modules together.
    """

    def __init__(self, namespace: dict):
        self._ns = namespace

    def __getattr__(self, name):
        try:
            return self._ns[name]
        except KeyError as exc:
            raise AttributeError(name) from exc


@pytest.fixture
def recon_mod() -> _ExecedModule:
    # Same loading contract as seq_check_py_worker.js: fetched as text and exec'd,
    # with `recon_kernels` resolvable by flat name off sys.path.
    added = str(KERNELS_DIR) not in sys.path
    if added:
        sys.path.insert(0, str(KERNELS_DIR))
    try:
        namespace: dict = {}
        exec(compile(MODULE_PATH.read_text(), str(MODULE_PATH), "exec"), namespace)
    finally:
        if added:
            sys.path.remove(str(KERNELS_DIR))
    return _ExecedModule(namespace)


# Small on purpose: PyNUFFT planning dominates this file's runtime, and the
# conventions under test are size-independent.
N_PIX = 16
D_MM = 2.0
FOV_M = N_PIX * D_MM * 1e-3
KMAX = N_PIX / (2.0 * FOV_M)


def _radial_traj(n_spokes: int = 8, n_per_spoke: int = 17) -> np.ndarray:
    """Radial spokes through the k-space centre, in 1/m -- deliberately off-grid, so
    both paths take their NUFFT branch rather than any Cartesian shortcut."""
    angles = np.linspace(0, np.pi, n_spokes, endpoint=False)
    r = np.linspace(-1.0, 1.0, n_per_spoke)
    kx, ky = [], []
    for a in angles:
        kx.extend((r * KMAX * np.cos(a)).tolist())
        ky.extend((r * KMAX * np.sin(a)).tolist())
    return np.column_stack([kx, ky])


def _random_signal(n: int, seed: int) -> np.ndarray:
    """Asymmetric complex signal. Deliberately not a point source: a symmetric image
    would reconcile the two paths by accident and hide an orientation regression."""
    rng = np.random.default_rng(seed)
    return (rng.standard_normal(n) + 1j * rng.standard_normal(n)).astype(np.complex64)


def _recon_a_2d(traj: np.ndarray, signal: np.ndarray) -> np.ndarray:
    """A's adjoint for a single-slice 2D problem, squeezed to (nx, ny).

    ``omega_scale_z`` is what run_sim_recon would pass, but it is inert here: a
    2-column trajectory leaves kz unset, so A zeroes omega_z and takes its 2D-plan
    branch -- the same plan B asks for.
    """
    kmax_z = 1.0 / (2.0 * (D_MM * 1e-3))
    reco, dcf = recon._recon_full_nufft(
        signal, traj, N_PIX, N_PIX, 1, KMAX, KMAX, kmax_z, apply_dcf=True
    )
    assert dcf is not None
    return reco[:, :, 0]


# --------------------------------------------------------------------------
# There is one kernel, and both sides use it
# --------------------------------------------------------------------------


def test_both_paths_use_the_same_dcf_and_adjoint(recon_mod):
    """Neither module may hold a private copy of the DCF or the adjoint NUFFT.

    This is the structural guarantee the merge bought. Asserted by source file
    rather than by object identity, because the flat ``recon_kernels`` name B uses
    and the ``scan_zero.recon_kernels`` name A uses are two sys.modules entries for
    one file.
    """
    kernel_file = str(KERNELS_DIR / "recon_kernels.py")
    assert recon_kernels.nufft_adjoint.__code__.co_filename == kernel_file
    assert recon_kernels.pipe_menon_dcf.__code__.co_filename == kernel_file
    assert recon_mod.nufft_adjoint.__code__.co_filename == kernel_file
    # A re-exports the kernel's DCF under its historical private name.
    assert recon._compute_pipe_menon_dcf.__code__.co_filename == kernel_file


def test_pipe_menon_dcf_rejects_empty_trajectories():
    """One implementation, so one error contract: ValueError for an empty
    trajectory, and a named RuntimeError rather than a bare AttributeError when
    PyNUFFT's private interpolation operators are missing.

    The operators matter because ``_y2k_cpu`` / ``_k2y_cpu`` could disappear on a
    PyNUFFT upgrade, and A's callers already rely on not seeing AttributeError.
    """
    traj = _radial_traj(n_spokes=2, n_per_spoke=5)
    om = np.stack(
        [recon_kernels.omega_from_k(traj[:, 0], KMAX), recon_kernels.omega_from_k(traj[:, 1], KMAX)],
        axis=1,
    )
    plan = NUFFT()
    plan.plan(om, (N_PIX, N_PIX), (2 * N_PIX, 2 * N_PIX), (6, 6))

    for n_samples in (0, -1):
        with pytest.raises(ValueError):
            recon_kernels.pipe_menon_dcf(plan, n_samples)

    with pytest.raises(RuntimeError, match="interpolation operators unavailable"):
        recon_kernels.pipe_menon_dcf(object(), 4)


def test_dcf_weights_downweight_the_oversampled_centre():
    """Radial sampling is densest at k=0, so the weights there must be smallest --
    the property the whole DCF exists to provide, now asserted in one place."""
    traj = _radial_traj()
    om = np.stack(
        [recon_kernels.omega_from_k(traj[:, 0], KMAX), recon_kernels.omega_from_k(traj[:, 1], KMAX)],
        axis=1,
    )
    plan = NUFFT()
    plan.plan(om, (N_PIX, N_PIX), (2 * N_PIX, 2 * N_PIX), (6, 6))

    dcf = recon_kernels.pipe_menon_dcf(plan, traj.shape[0])
    assert dcf.dtype == np.float32
    assert np.all(np.isfinite(dcf)) and np.all(dcf > 0)

    radius = np.hypot(traj[:, 0], traj[:, 1])
    centre = dcf[radius < 0.1 * KMAX]
    edge = dcf[radius > 0.9 * KMAX]
    assert centre.mean() < edge.mean()


# --------------------------------------------------------------------------
# The two paths now produce the same image
# --------------------------------------------------------------------------


def test_full_nufft_outputs_agree(recon_mod):
    """The plain "are these the same function?" question, asked with no correction
    applied. It used to be an xfail: B ended with ``np.flip(..., axis=(0, 1))`` and A
    did not, so 100% of elements mismatched.

    Exact equality rather than a tolerance, because both sides now run the same
    arithmetic in the same order. If that stops being true the merge premise has
    changed, and this should say so loudly rather than absorb it into a tolerance.
    """
    traj = _radial_traj()
    signal = _random_signal(traj.shape[0], seed=20240815)

    out_a = _recon_a_2d(traj, signal)
    out_b = recon_mod.recon_nufft_2d_adjoint(traj, signal, N_PIX, FOV_M)

    assert out_a.shape == out_b.shape == (N_PIX, N_PIX)
    assert out_a.dtype == out_b.dtype == np.complex64
    np.testing.assert_array_equal(out_b, out_a)


def test_centred_point_source_lands_on_the_same_pixel(recon_mod):
    """Both put a centred source at ``n // 2``.

    Before the merge B put it at ``n // 2 - 1``, which was documented as a divergence
    independent of the orientation flip. It was not: ``np.flip`` on an even-length
    axis maps ``n // 2`` to ``n - 1 - n // 2``, so removing the flip fixed both at
    once. Kept as a regression test because it is the cheapest way to catch a flip
    creeping back in.
    """
    traj = _radial_traj()
    signal = np.ones(traj.shape[0], dtype=np.complex64)

    out_a = _recon_a_2d(traj, signal)
    out_b = recon_mod.recon_nufft_2d_adjoint(traj, signal, N_PIX, FOV_M)

    peak_a = np.unravel_index(np.argmax(np.abs(out_a)), out_a.shape)
    peak_b = np.unravel_index(np.argmax(np.abs(out_b)), out_b.shape)
    assert peak_a == peak_b == (N_PIX // 2, N_PIX // 2)


# --------------------------------------------------------------------------
# Output geometry -- inherited affine vs computed affine
# --------------------------------------------------------------------------


def _run_a_to_nifti(tmp_path: Path, nx: int, ny: int, nz: int, dz_mm: float) -> nib.Nifti1Image:
    ref_bytes = make_ref_mask_nifti_bytes(tmp_path, nx, ny, nz, D_MM, D_MM, dz_mm)
    traj = _radial_traj(n_spokes=6, n_per_spoke=13)
    signal = _random_signal(traj.shape[0], seed=99)
    pairs = np.column_stack([signal.real, signal.imag]).tolist()
    out_path = tmp_path / f"a_{nx}x{ny}x{nz}.nii"
    return nib.load(
        recon.run_sim_recon(pairs, traj.tolist(), ref_bytes, out_path=str(out_path))
    )


def test_single_slice_geometry_agrees_despite_different_derivations(recon_mod, tmp_path):
    """A takes its affine and zooms from the caller-supplied reference mask; B
    computes them from FOV / matrix. For the single-slice case the two unrelated
    derivations land on the same numbers, so neither has to change.
    """
    dz_mm = 5.0
    img_a = _run_a_to_nifti(tmp_path, N_PIX, N_PIX, 1, dz_mm)

    geo = recon_mod._write_recon_nifti_4d(
        np.zeros((N_PIX, N_PIX), dtype=np.float32),
        np.zeros((N_PIX, N_PIX), dtype=np.float32),
        FOV_M,
        FOV_M,
        dz_mm * 1e-3,
        str(tmp_path / "b.nii"),
    )
    img_b = nib.load(str(tmp_path / "b.nii"))

    assert img_a.shape == img_b.shape == (N_PIX, N_PIX, 1, 2)
    assert img_a.header.get_zooms()[:3] == pytest.approx((D_MM, D_MM, dz_mm))
    assert (geo["dx_mm"], geo["dy_mm"], geo["dz_mm"]) == pytest.approx((D_MM, D_MM, dz_mm))
    np.testing.assert_allclose(img_a.affine, img_b.affine)
    np.testing.assert_allclose(img_a.affine, np.diag([D_MM, D_MM, dz_mm, 1.0]))


def test_b_writer_is_two_dimensional_by_design(recon_mod, tmp_path):
    """B's NIfTI writer only ever emits one slice, and gives that slice the whole
    sequence FOV_z as its thickness.

    This is not the same kind of divergence as the orientation flip was: Fig 6
    reconstructs a 2-D window, so a slice count above one has no meaning there. It is
    pinned rather than fixed because its own ``_recon_nifti_geometry`` helper *does*
    handle multi-slice correctly and agrees with A -- so anyone extending Fig 6 to 3-D
    needs to pass the slice count into the writer, not invent a spacing formula.
    """
    nz, dz_mm = 3, 2.0
    fov_z_m = nz * dz_mm * 1e-3

    helper = recon_mod._recon_nifti_geometry(N_PIX, N_PIX, nz, FOV_M, FOV_M, fov_z_m)
    assert helper["dz_mm"] == pytest.approx(dz_mm)
    assert helper["dims"][2] == nz

    writer = recon_mod._write_recon_nifti_4d(
        np.zeros((N_PIX, N_PIX), dtype=np.float32),
        np.zeros((N_PIX, N_PIX), dtype=np.float32),
        FOV_M,
        FOV_M,
        fov_z_m,
        str(tmp_path / "b_multi.nii"),
    )
    assert writer["dims"][2] == 1
    assert writer["dz_mm"] == pytest.approx(nz * dz_mm)

    # A, given a 3-slice reference mask, emits 3 slices at the mask's thickness.
    img_a = _run_a_to_nifti(tmp_path, N_PIX, N_PIX, nz, dz_mm)
    assert img_a.shape[2] == nz
    assert img_a.header.get_zooms()[2] == pytest.approx(dz_mm)


# --------------------------------------------------------------------------
# Value ranges -- the one remaining, deliberate difference
# --------------------------------------------------------------------------


def _decode_f32(b64: str) -> np.ndarray:
    return np.frombuffer(base64.b64decode(b64), dtype=np.float32)


def test_value_ranges_differ_only_by_display_scaling(recon_mod, tmp_path):
    """B's JSON payload carries magnitude divided by its own peak and phase mapped
    onto [0, 1]; A's NIfTI carries raw magnitude and raw radians.

    Undo that scaling and the frames match to one float32 ulp -- no flip needed any
    more. So the normalisation is display-only, it lives in B's JSON adapter rather
    than in the recon, and the two paths reconstruct the same image.
    """
    traj = _radial_traj()
    signal = _random_signal(traj.shape[0], seed=4242)
    pairs = np.column_stack([signal.real, signal.imag]).tolist()

    ref_bytes = make_ref_mask_nifti_bytes(tmp_path, N_PIX, N_PIX, 1, D_MM, D_MM, D_MM)
    vol = nib.load(
        recon.run_sim_recon(
            pairs, traj.tolist(), ref_bytes, out_path=str(tmp_path / "a_values.nii")
        )
    ).get_fdata(dtype=np.float32)
    mag_a = vol[:, :, 0, 0]
    phase_a = vol[:, :, 0, 1]

    recon_mod.set_sim_cache_py(
        np.column_stack([traj, np.zeros(traj.shape[0])]).tolist(), pairs
    )
    meta = {
        "fov_m": FOV_M,
        "fov_x_m": FOV_M,
        "fov_y_m": FOV_M,
        "fov_z_m": 0.005,
        "n_pix": N_PIX,
    }
    out = json.loads(
        recon_mod._recon_nufft_from_traj_indices(list(range(traj.shape[0])), meta=meta)
    )
    assert out["ok"] is True
    mag_b = _decode_f32(out["magB64"]).reshape(N_PIX, N_PIX)
    phase_b = _decode_f32(out["phaseB64"]).reshape(N_PIX, N_PIX)

    # B: magnitude peaks at exactly 1, phase confined to the unit interval.
    assert mag_b.max() == pytest.approx(1.0)
    assert mag_b.min() >= 0.0
    assert 0.0 <= phase_b.min() and phase_b.max() <= 1.0

    # A: no normalisation at all, and phase still in radians. Asserted as a bound
    # rather than an exact value -- the adjoint's absolute scale is PyNUFFT's business.
    assert 0.0 < mag_a.max() < 0.1
    assert -np.pi <= phase_a.min() < 0.0 < phase_a.max() <= np.pi
    assert phase_a.max() > 1.0  # impossible on B's [0, 1] scale

    np.testing.assert_allclose(mag_b, mag_a / mag_a.max(), atol=1.2e-7)
    np.testing.assert_allclose(phase_b, (phase_a + np.pi) / (2.0 * np.pi), atol=1.2e-7)
