"""Regression coverage for data/resampling.py before it moves into the Web Worker.

Covers the pure trilinear kernel, the footprint_mean vs center sampling modes
(the resample-to-FOV feature), and the public run_resampling entry
point against the real checked-in single-slice phantom fixture.
"""
from __future__ import annotations

import numpy as np
import nibabel as nib
import pytest

from data import resampling
from conftest import make_ref_mask_nifti_bytes, load_nifti_any, read_nifti_bytes_decompressed


def test_trilinear_interpolate_exact_at_grid_points():
    data = np.arange(2 * 2 * 2, dtype=np.float32).reshape(2, 2, 2)
    cx, cy, cz = np.meshgrid(
        np.arange(2, dtype=np.float32),
        np.arange(2, dtype=np.float32),
        np.arange(2, dtype=np.float32),
        indexing="ij",
    )
    out = resampling._trilinear_interpolate(data, cx, cy, cz)
    np.testing.assert_allclose(out, data)


def test_trilinear_interpolate_midpoint_is_average_of_corners():
    data = np.zeros((2, 2, 2), dtype=np.float32)
    data[1, 1, 1] = 8.0  # only one corner non-zero
    cx = np.array([[[0.5]]], dtype=np.float32)
    cy = np.array([[[0.5]]], dtype=np.float32)
    cz = np.array([[[0.5]]], dtype=np.float32)
    out = resampling._trilinear_interpolate(data, cx, cy, cz)
    # trilinear weight for the (1,1,1) corner at the exact center is 1/8
    np.testing.assert_allclose(out, np.array([[[1.0]]]))


def test_trilinear_interpolate_out_of_bounds_uses_constant_value():
    data = np.ones((2, 2, 2), dtype=np.float32)
    cx = np.array([[[-5.0]]], dtype=np.float32)
    cy = np.array([[[0.0]]], dtype=np.float32)
    cz = np.array([[[0.0]]], dtype=np.float32)
    out = resampling._trilinear_interpolate(data, cx, cy, cz, cval=-1.0)
    assert out[0, 0, 0] == -1.0


def _make_source_img(nx, ny, nz, dx_mm, value_fn):
    data = np.zeros((nx, ny, nz), dtype=np.float32)
    for i in range(nx):
        for j in range(ny):
            for k in range(nz):
                data[i, j, k] = value_fn(i, j, k)
    affine = np.diag([dx_mm, dx_mm, dx_mm, 1.0]).astype(np.float64)
    img = nib.Nifti1Image(data, affine)
    img.header.set_zooms((dx_mm, dx_mm, dx_mm))
    return img


def test_resample_to_reference_identity_grid_reproduces_source():
    """Resampling onto the exact same grid should return (numerically) the same data."""
    src = _make_source_img(4, 4, 1, 2.0, lambda i, j, k: float(i * 4 + j))
    out = resampling.resample_to_reference(src, src, sampling_mode="center")
    np.testing.assert_allclose(out.get_fdata(dtype=np.float32), src.get_fdata(dtype=np.float32))


def test_resample_to_reference_footprint_mean_conserves_total_on_downsample():
    """Downsampling with footprint_mean should preserve the mean value (mass-conserving
    average), unlike 'center' point-sampling which can miss most of the source signal
    entirely when the signal doesn't happen to sit at the reference voxel's exact center."""
    nx = 8
    src = _make_source_img(nx, nx, 1, 1.0, lambda i, j, k: 64.0 if (i, j) == (0, 0) else 0.0)

    # Reference grid: 1 voxel exactly covering the whole 8x8 source FOV (thick-slab
    # average). Translation aligns the reference voxel's center with the source's
    # center (world 3.5) -- without it the two grids don't actually overlap.
    ref_affine = np.eye(4)
    ref_affine[0, 0] = nx * 1.0
    ref_affine[1, 1] = nx * 1.0
    ref_affine[2, 2] = 1.0
    ref_affine[0, 3] = (nx - 1) / 2.0
    ref_affine[1, 3] = (nx - 1) / 2.0
    ref_data = np.zeros((1, 1, 1), dtype=np.float32)
    ref_img = nib.Nifti1Image(ref_data, ref_affine)
    ref_img.header.set_zooms((nx * 1.0, nx * 1.0, 1.0))

    out_mean = resampling.resample_to_reference(
        src, ref_img, sampling_mode="footprint_mean", max_substeps=8
    )
    val_mean = float(out_mean.get_fdata(dtype=np.float32)[0, 0, 0])
    # footprint_mean's 8x8 sub-grid lands exactly on all 64 source voxels here,
    # so it exactly recovers the true mean: 64.0 / 64 voxels = 1.0.
    assert val_mean == pytest.approx(1.0, abs=1e-5)

    out_center = resampling.resample_to_reference(src, ref_img, sampling_mode="center")
    val_center = float(out_center.get_fdata(dtype=np.float32)[0, 0, 0])
    # 'center' only trilinearly samples around the single reference-voxel center
    # (source index ~3.5, 3.5) -- nowhere near the (0, 0) hotspot -- so it misses
    # the signal entirely.
    assert val_center == pytest.approx(0.0, abs=1e-5)


def test_run_resampling_end_to_end_with_real_phantom_pd_map(tmp_path, single_slice_phantom_dir):
    source_path = single_slice_phantom_dir / "brain_default_PD.nii.gz"
    # run_resampling() never gzip-decompresses internally -- it expects raw
    # single-file NIfTI bytes (see conftest.read_nifti_bytes_decompressed).
    source_bytes = read_nifti_bytes_decompressed(source_path)

    source_img = load_nifti_any(source_path)
    nx, ny, nz = source_img.shape[:3]
    src_zooms = source_img.header.get_zooms()[:3]

    # Reference grid: half resolution (downsample by 2x in-plane).
    ref_nx, ref_ny = max(1, nx // 2), max(1, ny // 2)
    ref_dx, ref_dy = src_zooms[0] * (nx / ref_nx), src_zooms[1] * (ny / ref_ny)
    ref_bytes = make_ref_mask_nifti_bytes(
        tmp_path, ref_nx, ref_ny, nz, ref_dx, ref_dy, src_zooms[2], name="ref.nii"
    )

    out_path = tmp_path / "resampled.nii"
    result_path = resampling.run_resampling(
        source_bytes, ref_bytes, sampling_mode="footprint_mean", out_path=str(out_path)
    )

    out_img = nib.load(result_path)
    assert out_img.shape[:3] == (ref_nx, ref_ny, nz)
    out_data = out_img.get_fdata(dtype=np.float32)
    assert np.all(np.isfinite(out_data))
    assert out_data.max() > 0  # real phantom PD map is not all-zero
