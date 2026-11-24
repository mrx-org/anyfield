"""Regression coverage for pypulseq/seq_check_web/seq_check_py_recon.py.

This module used to hold the repo's *second* NUFFT/DCF recon. It no longer does:
the maths comes from scan_zero/recon_kernels.py, and what remains here is
selection (the sim cache, the ADC time-window mapping) plus the JSON payload the
JS side consumes. So these tests now split in two — the selection logic, which is
this module's own and unchanged, and the recon adapters, which are pinned only to
confirm they delegate and to record the *user-visible* consequence of the merge.

That consequence: the old copy ended with ``np.flip(..., axis=(0, 1))`` and
scan_zero's did not. The scan_zero convention won (unflipped, centred source at
``n // 2``), so **Fig 6's images are mirrored in both axes relative to earlier
releases**. The one-pixel centre offset this file used to document separately was
never independent — it fell out of that same flip on an even-length axis.

Magnitude/phase normalisation to [0, 1] is still done here, in the JSON adapter
rather than in the recon: it is a display concern for the Niivue-facing payload
and does not change the image (test_recon_equivalence.py asserts the frames match
scan_zero's to one float32 ulp once the scaling is undone).

Note this file cannot be ``import``ed: it is fetched as *text* and exec'd into a
Pyodide namespace, with a pypulseq ``Sequence`` injected as ``seq`` for the
definition-reading helpers. It imports numpy itself now, but still needs
``recon_kernels`` importable by flat name, which the worker arranges by staging it
onto the VFS with its directory on ``sys.path``. The ``recon_mod`` fixture
reproduces that contract.
"""
from __future__ import annotations

import ast
import base64
import json
import sys
from pathlib import Path

import numpy as np
import nibabel as nib
import pytest

from scan_zero import recon_kernels

REPO_ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = REPO_ROOT / "pypulseq" / "seq_check_web" / "seq_check_py_recon.py"
KERNELS_DIR = REPO_ROOT / "scan_zero"


class _ExecedModule:
    """Attribute access onto the *live* exec namespace.

    Deliberately not a SimpleNamespace/copy: several helpers mutate module
    globals (``global _sim_cache_py``), and tests must observe those writes.
    """

    def __init__(self, namespace: dict):
        self._ns = namespace

    def __getattr__(self, name):
        try:
            return self._ns[name]
        except KeyError as exc:
            raise AttributeError(name) from exc

    def set_global(self, name, value):
        self._ns[name] = value


class _StubSeq:
    """Minimal stand-in for a pypulseq Sequence, which only ``get_definition``
    is used for by the ``seq``-reading helpers."""

    def __init__(self, definitions: dict):
        self._definitions = definitions

    def get_definition(self, key):
        return self._definitions.get(key)


@pytest.fixture
def recon_mod() -> _ExecedModule:
    # Function-scoped: _sim_cache_py is module-global mutable state, so each test
    # gets a fresh namespace rather than leaking a cache between tests.
    #
    # No `np` is injected: the module imports numpy itself now. What it does need is
    # `recon_kernels` resolvable by flat name, which is what the worker's sys.path
    # entry provides in the browser.
    added = str(KERNELS_DIR) not in sys.path
    if added:
        sys.path.insert(0, str(KERNELS_DIR))
    try:
        namespace: dict = {}
        code = compile(MODULE_PATH.read_text(), str(MODULE_PATH), "exec")
        exec(code, namespace)
    finally:
        if added:
            sys.path.remove(str(KERNELS_DIR))
    return _ExecedModule(namespace)


def _cartesian_traj(n_pix: int, fov_m: float) -> np.ndarray:
    """Full centred Cartesian k-space grid, as an (N, 2) trajectory in 1/m."""
    lin = (np.arange(n_pix) - n_pix // 2) / fov_m
    kx, ky = np.meshgrid(lin, lin, indexing="ij")
    return np.column_stack([kx.ravel(), ky.ravel()])


def _point_source_signal(traj: np.ndarray, off_x_m: float, off_y_m: float) -> np.ndarray:
    phase = 2 * np.pi * (traj[:, 0] * off_x_m + traj[:, 1] * off_y_m)
    return np.exp(-1j * phase).astype(np.complex64)


# --------------------------------------------------------------------------
# Loading contract
# --------------------------------------------------------------------------


def test_module_imports_numpy_itself(recon_mod):
    """The module imports numpy at top level instead of relying on the worker
    injecting an ``np`` global.

    The worker still prepends ``import numpy as np`` for the psf module that shares
    the namespace, so the old contract holds either way -- but this module no longer
    depends on it. The fixture injects nothing, so a helper that does arithmetic
    working at all is the assertion: it would have raised NameError before.
    """
    assert "import numpy as np" in MODULE_PATH.read_text()
    np.testing.assert_allclose(recon_mod._json_float_list([1.0, "x", None]), [1.0])


# --------------------------------------------------------------------------
# FOV / geometry helpers
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (0.256, 0.256),  # already metres
        (256.0, 0.256),  # millimetres -> metres
        (2.0, 2.0),  # boundary: <= 2 is left as metres
        (2.5, 0.0025),  # just past the boundary -> treated as mm
        (0.0, None),  # non-positive is rejected, not clamped
        (-1.0, None),
    ],
)
def test_fov_component_m_mm_heuristic(recon_mod, value, expected):
    assert recon_mod._fov_component_m(value) == expected


def test_recon_nifti_geometry_spacing_and_slice_thickness(recon_mod):
    geo = recon_mod._recon_nifti_geometry(64, 32, 1, 0.256, 0.128, 0.005)
    assert geo["dims"] == [64, 32, 1, 2]
    assert geo["dx_mm"] == pytest.approx(4.0)  # 256 mm / 64
    assert geo["dy_mm"] == pytest.approx(4.0)  # 128 mm / 32
    # nz == 1 means the single z voxel spans the whole sequence FOV_z.
    assert geo["dz_mm"] == pytest.approx(5.0)
    assert geo["slice_thickness_mm"] == pytest.approx(geo["dz_mm"])
    assert geo["fov_x_mm"] == pytest.approx(256.0)


def test_recon_nifti_geometry_fallbacks(recon_mod):
    # fov_y <= 0 falls back to fov_x ...
    assert recon_mod._recon_nifti_geometry(64, 64, 1, 0.256, 0.0, 0.005)["dy_mm"] == (
        pytest.approx(4.0)
    )
    # ... and fov_z <= 0 falls back to a 5 mm default slice.
    assert recon_mod._recon_nifti_geometry(64, 64, 1, 0.256, 0.256, 0.0)["dz_mm"] == (
        pytest.approx(5.0)
    )


# --------------------------------------------------------------------------
# get_recon_meta_json -- reads the injected `seq` global
# --------------------------------------------------------------------------


def test_get_recon_meta_json_metres_definitions(recon_mod):
    recon_mod.set_global("seq", _StubSeq({"FOV": [0.256, 0.128, 0.005], "Matrix": [128, 64]}))
    meta = json.loads(recon_mod.get_recon_meta_json())
    assert meta == {
        "fov_m": 0.256,
        "fov_x_m": 0.256,
        "fov_y_m": 0.128,
        "fov_z_m": 0.005,
        "n_pix": 128,
        "n_phase": 64,
    }


def test_get_recon_meta_json_converts_millimetre_definitions(recon_mod):
    recon_mod.set_global("seq", _StubSeq({"FOV": [256.0, 128.0, 5.0], "Matrix": [128]}))
    meta = json.loads(recon_mod.get_recon_meta_json())
    assert meta["fov_x_m"] == pytest.approx(0.256)
    assert meta["fov_y_m"] == pytest.approx(0.128)
    assert meta["fov_z_m"] == pytest.approx(0.005)
    # A 1-element Matrix makes the phase count mirror the readout count.
    assert meta["n_pix"] == 128
    assert meta["n_phase"] == 128


def test_get_recon_meta_json_defaults_when_definitions_missing(recon_mod):
    recon_mod.set_global("seq", _StubSeq({}))
    meta = json.loads(recon_mod.get_recon_meta_json())
    assert meta["fov_x_m"] == pytest.approx(0.256)
    assert meta["fov_y_m"] == pytest.approx(0.256)
    assert meta["fov_z_m"] == pytest.approx(0.005)
    assert meta["n_pix"] == 256


def test_get_recon_meta_json_survives_a_broken_seq(recon_mod):
    """Definition lookups are individually wrapped in try/except, so a Sequence
    that raises must degrade to defaults rather than propagate."""

    class _Exploding:
        def get_definition(self, key):
            raise RuntimeError("boom")

    recon_mod.set_global("seq", _Exploding())
    meta = json.loads(recon_mod.get_recon_meta_json())
    assert meta["fov_x_m"] == pytest.approx(0.256)
    assert meta["n_pix"] == 256


# --------------------------------------------------------------------------
# ADC window -> trajectory index mapping
# --------------------------------------------------------------------------


def test_adc_index_range_selects_inclusive_window(recon_mod):
    t_adc = np.array([0.0, 1.0, 2.0, 3.0, 4.0])
    assert recon_mod._adc_index_range(t_adc, 1.0, 3.0) == (1, 3)


def test_adc_index_range_normalises_reversed_bounds(recon_mod):
    t_adc = np.array([0.0, 1.0, 2.0, 3.0, 4.0])
    assert recon_mod._adc_index_range(t_adc, 3.0, 1.0) == (1, 3)


def test_adc_index_range_empty_input_is_empty_range(recon_mod):
    lo, hi = recon_mod._adc_index_range(np.array([]), 0.0, 1.0)
    assert hi < lo  # sentinel for "nothing selected"


def test_adc_index_range_window_past_the_end_clamps_to_last_sample(recon_mod):
    """A window entirely beyond the last ADC time does NOT come back empty: i_lo
    is clamped to ``n - 1``, so the final sample is still selected. Pinned
    because it is surprising, and because any merged recon must decide
    deliberately whether to keep this clamp or return an empty selection."""
    t_adc = np.array([0.0, 1.0, 2.0])
    assert recon_mod._adc_index_range(t_adc, 10.0, 20.0) == (2, 2)


def test_map_adc_indices_one_to_one_when_counts_match(recon_mod):
    """When there is exactly one trajectory row per ADC sample, the mapping is
    the identity over the window (no nearest-neighbour search)."""
    traj = np.zeros((5, 3))
    idx = recon_mod._map_adc_indices_to_traj(
        1, 3, traj, np.zeros(5), np.zeros(5), n_adc_lines=5
    )
    np.testing.assert_array_equal(idx, [1, 2, 3])


def test_map_adc_indices_uses_nearest_kspace_point_when_counts_differ(recon_mod):
    """Counts differ, so each ADC sample's (kx, ky) is matched to its closest
    trajectory row."""
    traj = np.array([[0.0, 0.0], [10.0, 0.0], [20.0, 0.0], [30.0, 0.0]])
    kx_adc = np.array([19.5, 0.2])  # nearest rows 2 then 0
    ky_adc = np.array([0.0, 0.0])
    idx = recon_mod._map_adc_indices_to_traj(0, 1, traj, kx_adc, ky_adc, n_adc_lines=2)
    np.testing.assert_array_equal(idx, [2, 0])


def test_map_adc_indices_skips_non_finite_adc_coordinates(recon_mod):
    # traj rows deliberately != n_adc_lines, otherwise the one-to-one branch wins
    # and the nearest-neighbour code (the part under test) is never reached.
    traj = np.array([[0.0, 0.0], [10.0, 0.0], [20.0, 0.0]])
    kx_adc = np.array([np.nan, 9.9])
    ky_adc = np.array([0.0, 0.0])
    idx = recon_mod._map_adc_indices_to_traj(0, 1, traj, kx_adc, ky_adc, n_adc_lines=2)
    np.testing.assert_array_equal(idx, [1])


def test_map_adc_indices_proportional_fallback_without_kspace(recon_mod):
    """No ADC k-space coordinates at all -> spread the window proportionally
    across the trajectory."""
    traj = np.zeros((11, 2))
    idx = recon_mod._map_adc_indices_to_traj(0, 4, traj, None, None, n_adc_lines=5)
    # index 1 is 2, not 3, because np.round uses banker's rounding on the exact
    # half (0.25 * 10 == 2.5 -> 2). Pinned so a merge doesn't quietly change it.
    np.testing.assert_array_equal(idx, [0, 2, 5, 8, 10])


def test_map_adc_indices_empty_when_window_inverted(recon_mod):
    traj = np.zeros((4, 2))
    idx = recon_mod._map_adc_indices_to_traj(3, 2, traj, np.zeros(4), np.zeros(4))
    assert idx.size == 0


# --------------------------------------------------------------------------
# _json_float_list sanitising
# --------------------------------------------------------------------------


def test_json_float_list_drops_none_unparseable_and_non_finite(recon_mod):
    out = recon_mod._json_float_list(
        [1.0, None, "2.5", "abc", float("nan"), float("inf"), -float("inf"), 3]
    )
    np.testing.assert_allclose(out, [1.0, 2.5, 3.0])


def test_json_float_list_handles_none_input(recon_mod):
    assert recon_mod._json_float_list(None).size == 0


# --------------------------------------------------------------------------
# set_sim_cache_py
# --------------------------------------------------------------------------


def test_set_sim_cache_py_builds_complex_signal_and_reports_counts(recon_mod):
    traj = [[0.0, 0.0, 0.0], [1.0, 2.0, 0.0], [3.0, 4.0, 0.0]]
    signal = [[1.0, 0.0], [0.0, 2.0], [-1.0, -1.0]]
    kspace_adc = {"t_adc": [0.0, 1.0, 2.0], "kx_adc": [0.0, 1.0, 3.0], "ky_adc": [0.0, 2.0, 4.0]}

    summary = json.loads(
        recon_mod.set_sim_cache_py(json.dumps(traj), json.dumps(signal), json.dumps(kspace_adc))
    )
    assert summary["n_traj"] == 3
    assert summary["n_adc"] == 3
    assert summary["t_adc"] == [0.0, 1.0, 2.0]

    cache = recon_mod._sim_cache_py
    assert cache["signal"].dtype == np.complex64
    np.testing.assert_allclose(cache["signal"], [1 + 0j, 0 + 2j, -1 - 1j])


def test_set_sim_cache_py_accepts_already_parsed_objects(recon_mod):
    """Callers may pass live objects instead of JSON strings."""
    summary = json.loads(
        recon_mod.set_sim_cache_py([[0.0, 0.0, 0.0], [1.0, 1.0, 0.0]], [[1.0, 0.0], [0.0, 1.0]])
    )
    assert summary["n_traj"] == 2


def test_set_sim_cache_py_truncates_to_the_shorter_of_traj_and_signal(recon_mod):
    traj = [[0.0, 0.0, 0.0], [1.0, 1.0, 0.0], [2.0, 2.0, 0.0]]
    signal = [[1.0, 0.0], [0.0, 1.0]]
    summary = json.loads(recon_mod.set_sim_cache_py(traj, signal))
    assert summary["n_traj"] == 2
    assert recon_mod._sim_cache_py["traj"].shape[0] == 2


@pytest.mark.parametrize(
    ("traj", "signal"),
    [
        ([0.0, 1.0, 2.0], [[1.0, 0.0]]),  # traj not 2D
        ([[0.0]], [[1.0, 0.0]]),  # traj too narrow
        ([[0.0, 0.0, 0.0]], [1.0]),  # signal not Nx2
    ],
)
def test_set_sim_cache_py_rejects_malformed_shapes(recon_mod, traj, signal):
    with pytest.raises(ValueError):
        recon_mod.set_sim_cache_py(traj, signal)


# --------------------------------------------------------------------------
# NUFFT adjoint recon -- the scan_zero orientation convention
# --------------------------------------------------------------------------


def test_recon_nufft_2d_adjoint_centred_source_peaks_at_centre(recon_mod):
    """A centred point source peaks at ``n // 2``, matching scan_zero/recon.py.

    This used to be ``n // 2 - 1``. Dropping the trailing flip moved it, because
    ``np.flip`` on an even-length axis maps ``n // 2`` to ``n - 1 - n // 2``. The
    two implementations now agree by construction -- they call the same kernel.
    """
    n_pix, fov_m = 16, 0.032
    traj = _cartesian_traj(n_pix, fov_m)
    rec = recon_mod.recon_nufft_2d_adjoint(traj, _point_source_signal(traj, 0.0, 0.0), n_pix, fov_m)

    assert rec.shape == (n_pix, n_pix)
    assert rec.dtype == np.complex64
    peak = np.unravel_index(np.argmax(np.abs(rec)), rec.shape)
    assert peak == (n_pix // 2, n_pix // 2)


@pytest.mark.parametrize(("off_x_px", "off_y_px"), [(3, 0), (0, 3), (-2, 4)])
def test_recon_nufft_2d_adjoint_displacement_is_not_mirrored(recon_mod, off_x_px, off_y_px):
    """A source displaced by ``+d`` pixels appears at ``n // 2 + d``.

    The previous behaviour mirrored displacement (``n // 2 - 1 - d``). Pinned in
    this direction because it is the user-visible half of the orientation change:
    Fig 6's images are mirrored in both axes relative to earlier releases.
    """
    n_pix, fov_m = 16, 0.032
    dx_m = fov_m / n_pix
    traj = _cartesian_traj(n_pix, fov_m)
    signal = _point_source_signal(traj, off_x_px * dx_m, off_y_px * dx_m)

    rec = recon_mod.recon_nufft_2d_adjoint(traj, signal, n_pix, fov_m)
    peak = np.unravel_index(np.argmax(np.abs(rec)), rec.shape)

    assert peak == (n_pix // 2 + off_x_px, n_pix // 2 + off_y_px)


def test_recon_nufft_2d_adjoint_truncates_to_shortest_input(recon_mod):
    n_pix, fov_m = 8, 0.016
    traj = _cartesian_traj(n_pix, fov_m)
    signal = _point_source_signal(traj, 0.0, 0.0)[: traj.shape[0] // 2]
    rec = recon_mod.recon_nufft_2d_adjoint(traj, signal, n_pix, fov_m)
    assert rec.shape == (n_pix, n_pix)
    assert np.all(np.isfinite(rec))


@pytest.mark.parametrize(("n_samples", "n_pix"), [(0, 8), (4, 0)])
def test_recon_nufft_2d_adjoint_degenerate_inputs_return_zeros(recon_mod, n_samples, n_pix):
    traj = np.zeros((n_samples, 2))
    signal = np.zeros(n_samples, dtype=np.complex64)
    rec = recon_mod.recon_nufft_2d_adjoint(traj, signal, n_pix, 0.016)
    assert rec.shape == (n_pix, n_pix)
    assert not np.any(rec)


@pytest.mark.parametrize("off_px", [0, 3, -4])
def test_recon_nufft_1d_adjoint_uses_the_same_unflipped_convention(recon_mod, off_px):
    """The 1-D projection recon follows the same convention as the 2-D one, so the
    two views of the same window cannot disagree about which way is which."""
    res, fov_m = 16, 0.032
    dx_m = fov_m / res
    k_axis = (np.arange(res) - res // 2) / fov_m
    signal = np.exp(-1j * 2 * np.pi * k_axis * (off_px * dx_m)).astype(np.complex64)

    rec = recon_mod.recon_nufft_1d_adjoint(k_axis, signal, res, fov_m)

    assert rec.shape == (res,)
    assert int(np.argmax(np.abs(rec))) == res // 2 + off_px


def test_recon_nufft_1d_adjoint_degenerate_input_returns_zeros(recon_mod):
    rec = recon_mod.recon_nufft_1d_adjoint(np.array([]), np.array([], dtype=np.complex64), 8, 0.016)
    assert rec.shape == (8,)
    assert not np.any(rec)


def test_module_carries_no_recon_maths_of_its_own(recon_mod):
    """This module must hold no second copy of the DCF or the adjoint NUFFT.

    Checked structurally rather than behaviourally, because behaviour cannot
    distinguish "delegates to the kernel" from "reimplements it identically" -- and
    an identical reimplementation is exactly what drifted last time. Read from the
    AST rather than grepped, so prose in the docstring explaining the old flip
    doesn't count as the flip itself.
    """
    tree = ast.parse(MODULE_PATH.read_text())

    imported_from_kernels = {
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module == "recon_kernels"
        for alias in node.names
    }
    assert {"nufft_adjoint", "omega_from_k"} <= imported_from_kernels

    attrs = {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
    assert "_y2k_cpu" not in attrs  # the DCF iteration's private PyNUFFT handles
    assert "flip" not in attrs  # the orientation divergence is gone
    called = {
        n.func.id for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
    }
    assert "NUFFT" not in called  # no plan is built here any more

    # And the adapter's kernel really is the file scan_zero imports, not a lookalike.
    # Compared by source file rather than by identity: the flat `recon_kernels` name
    # this module uses and the `scan_zero.recon_kernels` name the tests use are two
    # sys.modules entries for one file, so the function objects differ.
    assert (
        recon_mod.nufft_adjoint.__code__.co_filename
        == recon_kernels.nufft_adjoint.__code__.co_filename
        == str(KERNELS_DIR / "recon_kernels.py")
    )


# --------------------------------------------------------------------------
# NIfTI writing
# --------------------------------------------------------------------------


def test_write_recon_nifti_4d_shape_and_zooms(recon_mod, tmp_path):
    nx, ny = 8, 4
    mag = np.linspace(0, 1, nx * ny, dtype=np.float32).reshape(nx, ny)
    phase = np.zeros((nx, ny), dtype=np.float32)
    out = tmp_path / "recon.nii"

    geo = recon_mod._write_recon_nifti_4d(mag, phase, 0.256, 0.128, 0.005, str(out))

    img = nib.load(str(out))
    assert img.shape == (nx, ny, 1, 2)
    vol = img.get_fdata(dtype=np.float32)
    np.testing.assert_allclose(vol[:, :, 0, 0], mag, atol=1e-6)
    np.testing.assert_allclose(vol[:, :, 0, 1], phase, atol=1e-6)
    zooms = img.header.get_zooms()
    assert zooms[0] == pytest.approx(geo["dx_mm"])
    assert zooms[1] == pytest.approx(geo["dy_mm"])
    assert zooms[2] == pytest.approx(geo["dz_mm"])


def test_write_recon_nifti_4d_rejects_mismatched_mag_phase(recon_mod, tmp_path):
    with pytest.raises(ValueError):
        recon_mod._write_recon_nifti_4d(
            np.zeros((4, 4), dtype=np.float32),
            np.zeros((4, 5), dtype=np.float32),
            0.256,
            0.256,
            0.005,
            str(tmp_path / "bad.nii"),
        )


# --------------------------------------------------------------------------
# End-to-end JSON entry points (divergence 3: normalised value ranges)
# --------------------------------------------------------------------------


def _decode_f32(b64: str) -> np.ndarray:
    return np.frombuffer(base64.b64decode(b64), dtype=np.float32)


def test_recon_nufft_indices_json_normalises_magnitude_and_phase(recon_mod, tmp_path, monkeypatch):
    """The JSON entry point returns magnitude scaled to a [0, 1] peak and phase
    rescaled from radians into [0, 1]. scan_zero/recon.py emits raw magnitude
    and raw radians, so the merge must pick one and adapt its callers."""
    monkeypatch.chdir(tmp_path)  # _recon_nufft_from_traj_indices writes /recon_window.nii.gz

    n_pix, fov_m = 16, 0.032
    traj = _cartesian_traj(n_pix, fov_m)
    signal = _point_source_signal(traj, 3 * fov_m / n_pix, 0.0)

    recon_mod.set_sim_cache_py(
        np.column_stack([traj, np.zeros(traj.shape[0])]).tolist(),
        np.column_stack([signal.real, signal.imag]).tolist(),
    )
    meta = {"fov_m": fov_m, "fov_x_m": fov_m, "fov_y_m": fov_m, "fov_z_m": 0.005, "n_pix": n_pix}
    all_indices = list(range(traj.shape[0]))

    out = json.loads(
        recon_mod._recon_nufft_from_traj_indices(all_indices, meta=meta)
    )

    assert out["ok"] is True
    assert (out["nx"], out["ny"], out["nZ"], out["nFrame4D"]) == (n_pix, n_pix, 1, 2)
    assert out["n"] == len(all_indices)

    mag = _decode_f32(out["magB64"])
    phase01 = _decode_f32(out["phaseB64"])
    assert mag.size == n_pix * n_pix
    assert phase01.size == n_pix * n_pix
    assert mag.max() == pytest.approx(1.0)
    assert mag.min() >= 0.0
    assert phase01.min() >= 0.0 and phase01.max() <= 1.0

    # Same unflipped convention as the array-level API, seen through the JSON path.
    peak = np.unravel_index(np.argmax(mag.reshape(n_pix, n_pix)), (n_pix, n_pix))
    assert peak == (n_pix // 2 + 3, n_pix // 2)


def test_recon_nufft_indices_json_accepts_a_json_string(recon_mod, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    n_pix, fov_m = 8, 0.016
    traj = _cartesian_traj(n_pix, fov_m)
    signal = _point_source_signal(traj, 0.0, 0.0)
    recon_mod.set_sim_cache_py(
        np.column_stack([traj, np.zeros(traj.shape[0])]).tolist(),
        np.column_stack([signal.real, signal.imag]).tolist(),
    )
    recon_mod.set_global("seq", _StubSeq({"FOV": [fov_m, fov_m, 0.005], "Matrix": [n_pix]}))

    out = json.loads(recon_mod.recon_nufft_indices_json(json.dumps(list(range(traj.shape[0])))))
    assert out["ok"] is True
    assert out["nx"] == n_pix


def test_recon_entry_points_report_missing_cache(recon_mod):
    assert json.loads(recon_mod.recon_nufft_window_json(0.0, 1.0)) == {
        "ok": False,
        "reason": "no sim cache",
    }
    assert json.loads(recon_mod.recon_nufft_indices_json("[]"))["ok"] is False


def test_recon_nufft_from_traj_indices_reports_empty_window(recon_mod):
    recon_mod.set_sim_cache_py([[0.0, 0.0, 0.0]], [[1.0, 0.0]])
    out = json.loads(recon_mod._recon_nufft_from_traj_indices([], meta={"fov_m": 0.2, "n_pix": 8}))
    assert out["ok"] is False
    assert out["n"] == 0


def test_recon_nufft_from_traj_indices_drops_out_of_range_indices(recon_mod):
    """Indices outside the trajectory are filtered rather than wrapping around."""
    recon_mod.set_sim_cache_py([[0.0, 0.0, 0.0]], [[1.0, 0.0]])
    out = json.loads(
        recon_mod._recon_nufft_from_traj_indices([99, -5], meta={"fov_m": 0.2, "n_pix": 8})
    )
    assert out["ok"] is False
    assert out["n"] == 0


def test_recon_nufft_window_json_selects_by_adc_time(recon_mod, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    n_pix, fov_m = 8, 0.016
    traj = _cartesian_traj(n_pix, fov_m)
    n = traj.shape[0]
    signal = _point_source_signal(traj, 0.0, 0.0)
    t_adc = np.linspace(0.0, 1.0, n)

    recon_mod.set_sim_cache_py(
        np.column_stack([traj, np.zeros(n)]).tolist(),
        np.column_stack([signal.real, signal.imag]).tolist(),
        {"t_adc": t_adc.tolist(), "kx_adc": traj[:, 0].tolist(), "ky_adc": traj[:, 1].tolist()},
    )
    recon_mod.set_global("seq", _StubSeq({"FOV": [fov_m, fov_m, 0.005], "Matrix": [n_pix]}))

    full = json.loads(recon_mod.recon_nufft_window_json(0.0, 1.0))
    half = json.loads(recon_mod.recon_nufft_window_json(0.0, 0.5))

    assert full["ok"] is True and half["ok"] is True
    # A narrower time window must use strictly fewer ADC samples.
    assert half["n"] < full["n"]


def test_recon_nufft_window_json_normalises_reversed_time_bounds(recon_mod, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    n_pix, fov_m = 8, 0.016
    traj = _cartesian_traj(n_pix, fov_m)
    n = traj.shape[0]
    signal = _point_source_signal(traj, 0.0, 0.0)
    recon_mod.set_sim_cache_py(
        np.column_stack([traj, np.zeros(n)]).tolist(),
        np.column_stack([signal.real, signal.imag]).tolist(),
        {"t_adc": np.linspace(0.0, 1.0, n).tolist()},
    )
    recon_mod.set_global("seq", _StubSeq({"FOV": [fov_m, fov_m, 0.005], "Matrix": [n_pix]}))

    forward = json.loads(recon_mod.recon_nufft_window_json(0.2, 0.8))
    reversed_ = json.loads(recon_mod.recon_nufft_window_json(0.8, 0.2))
    assert forward["n"] == reversed_["n"]


def test_recon_nufft_json_degrades_when_nifti_write_fails(recon_mod):
    """The NIfTI side-car is written to the hardcoded absolute path
    ``/recon_window.nii.gz``, which is only writable inside Pyodide's virtual
    filesystem -- on a real OS it raises. The array payload must still come back
    intact, with the failure surfaced in ``niiError`` rather than thrown.

    (The happy path for the writer itself is covered directly by
    test_write_recon_nifti_4d_shape_and_zooms.)
    """
    n_pix, fov_m = 8, 0.016
    traj = _cartesian_traj(n_pix, fov_m)
    signal = _point_source_signal(traj, 0.0, 0.0)
    recon_mod.set_sim_cache_py(
        np.column_stack([traj, np.zeros(traj.shape[0])]).tolist(),
        np.column_stack([signal.real, signal.imag]).tolist(),
    )
    meta = {"fov_m": fov_m, "fov_x_m": fov_m, "fov_y_m": fov_m, "fov_z_m": 0.005, "n_pix": n_pix}

    out = json.loads(
        recon_mod._recon_nufft_from_traj_indices(list(range(traj.shape[0])), meta=meta)
    )

    assert out["ok"] is True
    assert out["niiError"] is not None
    assert out["niiB64"] is None
    assert _decode_f32(out["magB64"]).size == n_pix * n_pix
