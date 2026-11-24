"""Coverage for the result-NPZ decode that used to live in scan_zero/scan_module.js.

Until this file existed the decode had none at all. It was a template literal inside
`_parseHttpNpzForRecon`, ran on the main thread's Pyodide, and produced nested JS arrays
that were then shipped to the worker; a later change moved it into `recon.py` as
`inputs_from_npz` / `run_sim_recon_from_npz` so the compact bytes cross the boundary
once. These tests pin the semantics that port had to preserve, because the JS original
was only ever exercised end-to-end by two e2e tests:

  - `signal` is raveled, whatever shape it was stored in;
  - `ktraj` is transposed when it is stored as ``(3, N)``, and *not* when it is ``(3, 3)``;
  - a missing ky or kz column is zero-filled, so the recon always sees three columns;
  - an empty signal or trajectory is an error, not a recon that quietly produces noise;
  - Pyodide's buffer proxies are accepted as well as real ``bytes``.

`run_sim_recon` gained the ability to take the decoded arrays directly, so the last two
tests check that the pair-list callers it already had are unaffected and that the two
input shapes agree bit for bit.
"""
from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import nibabel as nib
import pytest

from scan_zero import recon
from conftest import make_ref_mask_nifti_bytes


def _npz_bytes(signal: np.ndarray, ktraj: np.ndarray) -> bytes:
    """A result payload in the gateway's own format (see tests/e2e/sim_gateway_stub.py)."""
    buf = io.BytesIO()
    np.savez(buf, signal=signal, ktraj=ktraj)
    return buf.getvalue()


class _FakeJsBuffer:
    """Stand-in for the ArrayBuffer proxy Pyodide hands to Python.

    The decode calls ``.to_py()`` when it is present; the real proxy returns a buffer,
    not a list, so that is what this returns.
    """

    def __init__(self, payload: bytes):
        self._payload = payload

    def to_py(self):
        return memoryview(self._payload)


def _radial_traj(n: int) -> np.ndarray:
    """Golden-angle radial k-space, i.e. deliberately not on a Cartesian grid.

    Same construction as the e2e stub's, for the same reason: a Cartesian trajectory is
    detected and scattered onto the recon grid, and that branch never reaches the
    `matrix` fallback the `kspace_log` test below is about.
    """
    i = np.arange(n)
    theta = i * np.pi * (3.0 - np.sqrt(5.0))
    radius = (i % 8) / 8.0 * 120.0  # 1/m
    return np.stack(
        [radius * np.cos(theta), radius * np.sin(theta), np.zeros(n)], axis=1
    ).astype(np.float32)


def test_inputs_from_npz_decodes_signal_and_trajectory():
    signal = np.array([1 + 2j, 3 - 4j, 5 + 0j], dtype=np.complex64)
    ktraj = np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0], [7.0, 8.0, 9.0]], dtype=np.float32)

    got_signal, got_traj = recon.inputs_from_npz(_npz_bytes(signal, ktraj))

    assert got_signal.dtype == np.complex64
    assert got_signal.shape == (3,)
    np.testing.assert_array_equal(got_signal, signal)
    assert got_traj.dtype == np.float32
    assert got_traj.shape == (3, 3)
    np.testing.assert_array_equal(got_traj, ktraj)


def test_inputs_from_npz_ravels_a_multidimensional_signal():
    """``signal`` is flattened rather than trusted to arrive 1-D.

    The gateway writes one flat array today, but the JS original raveled it and the
    recon indexes ``signal[:n]`` as samples, so a 2-D payload must not change meaning.
    """
    signal = np.arange(6, dtype=np.complex64).reshape(2, 3)
    ktraj = np.zeros((6, 3), dtype=np.float32)

    got_signal, _ = recon.inputs_from_npz(_npz_bytes(signal, ktraj))

    assert got_signal.shape == (6,)
    np.testing.assert_array_equal(got_signal, np.arange(6, dtype=np.complex64))


def test_inputs_from_npz_transposes_a_3_by_n_ktraj():
    """A ``(3, N)`` trajectory is axis-major and has to be transposed to sample-major."""
    signal = np.ones(5, dtype=np.complex64)
    ktraj = np.array(
        [
            [0.0, 1.0, 2.0, 3.0, 4.0],  # kx
            [10.0, 11.0, 12.0, 13.0, 14.0],  # ky
            [20.0, 21.0, 22.0, 23.0, 24.0],  # kz
        ],
        dtype=np.float32,
    )

    _, traj = recon.inputs_from_npz(_npz_bytes(signal, ktraj))

    assert traj.shape == (5, 3)
    np.testing.assert_array_equal(traj[0], [0.0, 10.0, 20.0])
    np.testing.assert_array_equal(traj[4], [4.0, 14.0, 24.0])


def test_inputs_from_npz_leaves_a_3_by_3_ktraj_alone():
    """The ``shape[1] != 3`` half of the transpose guard, which is load-bearing.

    Three samples of three columns is already sample-major, and a ``(3, 3)`` array is
    ambiguous with the axis-major layout. The original resolved it in favour of
    sample-major; transposing would silently swap kx and kz for that one size.
    """
    signal = np.ones(3, dtype=np.complex64)
    ktraj = np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0], [7.0, 8.0, 9.0]], dtype=np.float32)

    _, traj = recon.inputs_from_npz(_npz_bytes(signal, ktraj))

    np.testing.assert_array_equal(traj, ktraj)


def test_inputs_from_npz_zero_fills_a_missing_kz_column():
    """A 2-D acquisition stores only kx/ky; the recon reads three columns regardless."""
    signal = np.ones(4, dtype=np.complex64)
    ktraj = np.array([[1.0, 2.0], [3.0, 4.0], [5.0, 6.0], [7.0, 8.0]], dtype=np.float32)

    _, traj = recon.inputs_from_npz(_npz_bytes(signal, ktraj))

    assert traj.shape == (4, 3)
    np.testing.assert_array_equal(traj[:, :2], ktraj)
    np.testing.assert_array_equal(traj[:, 2], np.zeros(4, dtype=np.float32))


def test_inputs_from_npz_zero_fills_a_missing_ky_column_too():
    """The single-column case the JS padded as well, kept for symmetry with it."""
    signal = np.ones(2, dtype=np.complex64)
    ktraj = np.array([[1.0], [2.0]], dtype=np.float32)

    _, traj = recon.inputs_from_npz(_npz_bytes(signal, ktraj))

    assert traj.shape == (2, 3)
    np.testing.assert_array_equal(traj, [[1.0, 0.0, 0.0], [2.0, 0.0, 0.0]])


def test_inputs_from_npz_rejects_an_empty_trajectory():
    """The JS raised ``"<tag>: HTTP result has no trajectory."`` here; keep it loud."""
    signal = np.ones(4, dtype=np.complex64)
    ktraj = np.zeros((0, 3), dtype=np.float32)

    with pytest.raises(ValueError, match="no trajectory"):
        recon.inputs_from_npz(_npz_bytes(signal, ktraj))


def test_inputs_from_npz_rejects_an_empty_signal():
    signal = np.zeros(0, dtype=np.complex64)
    ktraj = np.zeros((4, 3), dtype=np.float32)

    with pytest.raises(ValueError, match="no signal"):
        recon.inputs_from_npz(_npz_bytes(signal, ktraj))


def test_inputs_from_npz_reports_the_trajectory_first():
    """Both empty: the trajectory is named, as it was in the JS check order.

    Only one message reaches the console, so which of the two it is matters for anyone
    reading a failed scan.
    """
    payload = _npz_bytes(np.zeros(0, dtype=np.complex64), np.zeros((0, 3), dtype=np.float32))

    with pytest.raises(ValueError, match="no trajectory"):
        recon.inputs_from_npz(payload)


def test_inputs_from_npz_rejects_a_non_2d_ktraj():
    """A 1-D ``ktraj`` used to raise ``IndexError`` from ``ktraj[i, 0]``; say why instead."""
    payload = _npz_bytes(np.ones(3, dtype=np.complex64), np.arange(3, dtype=np.float32))

    with pytest.raises(ValueError, match="must be 2-D"):
        recon.inputs_from_npz(payload)


@pytest.mark.parametrize("wrap", [bytes, bytearray, list, tuple, _FakeJsBuffer])
def test_inputs_from_npz_accepts_the_buffer_types_pyodide_produces(wrap):
    """The tolerance the JS template literal had, kept verbatim.

    `npz_bytes` arrives as a JS ``ArrayBuffer`` proxy in the browser (hence ``to_py()``)
    and as real bytes in tests; a list/tuple of byte values is the third shape the
    original handled and is cheap to keep accepting.
    """
    signal = np.array([1 + 1j, 2 - 2j], dtype=np.complex64)
    ktraj = np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]], dtype=np.float32)
    payload = _npz_bytes(signal, ktraj)

    got_signal, got_traj = recon.inputs_from_npz(wrap(payload))

    np.testing.assert_array_equal(got_signal, signal)
    np.testing.assert_array_equal(got_traj, ktraj)


def test_run_sim_recon_from_npz_writes_a_nifti(tmp_path: Path):
    """End to end: NPZ bytes in, a real image NIfTI on disk out."""
    nx, ny, nz = 8, 8, 1
    dx_mm = dy_mm = dz_mm = 4.0
    ref_bytes = make_ref_mask_nifti_bytes(tmp_path, nx, ny, nz, dx_mm, dy_mm, dz_mm)

    n = 64
    traj = _radial_traj(n)
    px_m, py_m = 0.004, -0.004
    phase = 2 * np.pi * (traj[:, 0] * px_m + traj[:, 1] * py_m)
    signal = np.exp(-1j * phase).astype(np.complex64)

    out_path = tmp_path / "from_npz.nii"
    result_path = recon.run_sim_recon_from_npz(
        _npz_bytes(signal, traj), ref_bytes, out_path=str(out_path)
    )

    assert result_path == str(out_path)
    vol = nib.load(result_path).get_fdata(dtype=np.float32)
    assert vol.shape == (nx, ny, nz, 2)  # frame 0 = |img|, frame 1 = phase
    assert np.all(np.isfinite(vol))
    assert vol[:, :, 0, 0].max() > 0


def test_run_sim_recon_from_npz_kspace_log_uses_the_matrix(tmp_path: Path):
    """The mode the e2e scan tests run in, at unit level.

    `kspace_log` with a non-Cartesian trajectory reshapes the samples into the `.seq`'s
    `matrix`, so ``log(abs(signal) + 1)`` of an ``exp(i/(N-1)) - 1`` ramp is an exact
    0..1 ramp in acquisition order. That pins the complex decode, the sample order and
    the reshape together — the same property test_scan.py checks through the browser.
    """
    nx, ny, nz = 16, 16, 1
    dx_mm = dy_mm = dz_mm = 2.0
    ref_bytes = make_ref_mask_nifti_bytes(tmp_path, nx, ny, nz, dx_mm, dy_mm, dz_mm)

    matrix = [8, 8, 1]
    n = matrix[0] * matrix[1]
    i = np.arange(n)
    signal = ((np.exp(i / (n - 1)) - 1.0) * np.exp(1j * 0.3 * i)).astype(np.complex64)

    out_path = tmp_path / "kspace_log_from_npz.nii"
    result_path = recon.run_sim_recon_from_npz(
        _npz_bytes(signal, _radial_traj(n)),
        ref_bytes,
        out_path=str(out_path),
        output_mode="kspace_log",
        matrix=matrix,
    )

    vol = nib.load(result_path).get_fdata(dtype=np.float32)
    assert vol.shape == tuple(matrix)
    expected = (i / (n - 1)).reshape(matrix[0], matrix[1])
    np.testing.assert_allclose(vol[:, :, 0], expected, atol=1e-5)


def test_run_sim_recon_takes_decoded_arrays_and_pair_lists_identically(tmp_path: Path):
    """The added capability in `run_sim_recon`, checked against what it already accepted.

    `run_sim_recon_from_npz` hands over a complex64 array and a float32 ``(N, 3)`` array
    rather than expanding both back into nested lists. The two must be the same recon:
    the trajectory guard in particular used to be ``if traj and len(traj) > 0``, which
    raises on any array with more than one element.
    """
    nx, ny, nz = 8, 8, 1
    dx_mm = dy_mm = dz_mm = 4.0
    ref_bytes = make_ref_mask_nifti_bytes(tmp_path, nx, ny, nz, dx_mm, dy_mm, dz_mm)

    n = 48
    traj = _radial_traj(n)
    rng = np.random.default_rng(28)
    signal = (rng.standard_normal(n) + 1j * rng.standard_normal(n)).astype(np.complex64)

    from_arrays = nib.load(
        recon.run_sim_recon(signal, traj, ref_bytes, out_path=str(tmp_path / "arrays.nii"))
    ).get_fdata(dtype=np.float32)
    from_lists = nib.load(
        recon.run_sim_recon(
            np.column_stack([signal.real, signal.imag]).tolist(),
            traj.astype(np.float64).tolist(),
            ref_bytes,
            out_path=str(tmp_path / "lists.nii"),
        )
    ).get_fdata(dtype=np.float32)

    np.testing.assert_array_equal(from_arrays, from_lists)


def test_run_sim_recon_still_accepts_a_single_sample_trajectory(tmp_path: Path):
    """The one-element edge of the trajectory guard, for both input shapes.

    ``if traj`` on a one-element array is legal but means "is that element nonzero",
    so a single all-zero sample would have been read as "no trajectory". The size-based
    test used now does not have that reading, and a 1x3 list never did.
    """
    nx, ny, nz = 4, 4, 1
    ref_bytes = make_ref_mask_nifti_bytes(tmp_path, nx, ny, nz, 4.0, 4.0, 4.0)
    signal = np.array([1 + 0j], dtype=np.complex64)
    traj = np.zeros((1, 3), dtype=np.float32)

    as_array = nib.load(
        recon.run_sim_recon(signal, traj, ref_bytes, out_path=str(tmp_path / "one_arr.nii"))
    ).get_fdata(dtype=np.float32)
    as_list = nib.load(
        recon.run_sim_recon(
            [[1.0, 0.0]], [[0.0, 0.0, 0.0]], ref_bytes, out_path=str(tmp_path / "one_lst.nii")
        )
    ).get_fdata(dtype=np.float32)

    np.testing.assert_array_equal(as_array, as_list)
