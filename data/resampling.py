"""
Nibabel-based resampling utilities for the Niivue browser app (Pyodide).

This file is loaded lazily on first use (resample-to-FOV or JSON execute),
so the expensive 'import nibabel' does not block the startup loading phase.
"""
import numpy as np
import nibabel as nib
import io
import os
import gc


def _trilinear_interpolate(data, cx, cy, cz, cval=0.0):
    """Trilinear interpolation (order=1, constant boundary) — pure numpy, no scipy."""
    sx, sy, sz = data.shape
    orig_shape = cx.shape
    cx = cx.ravel()
    cy = cy.ravel()
    cz = cz.ravel()

    x0 = np.floor(cx).astype(np.int32)
    y0 = np.floor(cy).astype(np.int32)
    z0 = np.floor(cz).astype(np.int32)
    x1 = x0 + 1
    y1 = y0 + 1
    z1 = z0 + 1

    wx = (cx - x0).astype(np.float32)
    wy = (cy - y0).astype(np.float32)
    wz = (cz - z0).astype(np.float32)

    def _get(xi, yi, zi):
        valid = (xi >= 0) & (xi < sx) & (yi >= 0) & (yi < sy) & (zi >= 0) & (zi < sz)
        xi_c = np.clip(xi, 0, sx - 1)
        yi_c = np.clip(yi, 0, sy - 1)
        zi_c = np.clip(zi, 0, sz - 1)
        vals = data[xi_c, yi_c, zi_c]
        return np.where(valid, vals, cval).astype(np.float32)

    out = (
        _get(x0, y0, z0) * (1 - wx) * (1 - wy) * (1 - wz) +
        _get(x1, y0, z0) *      wx  * (1 - wy) * (1 - wz) +
        _get(x0, y1, z0) * (1 - wx) *      wy  * (1 - wz) +
        _get(x1, y1, z0) *      wx  *      wy  * (1 - wz) +
        _get(x0, y0, z1) * (1 - wx) * (1 - wy) *      wz  +
        _get(x1, y0, z1) *      wx  * (1 - wy) *      wz  +
        _get(x0, y1, z1) * (1 - wx) *      wy  *      wz  +
        _get(x1, y1, z1) *      wx  *      wy  *      wz
    )
    return out.reshape(orig_shape)


def resample_to_reference(source_img, reference_img, order=1):
    source_data = source_img.get_fdata(dtype=np.float32)
    source_affine = source_img.affine.astype(np.float32)
    reference_affine = reference_img.affine.astype(np.float32)
    reference_shape = reference_img.shape[:3]

    extra_dims = source_data.shape[3:]
    output_shape = reference_shape + extra_dims
    resampled_data = np.zeros(output_shape, dtype=np.float32)

    source_affine_inv = np.linalg.inv(source_affine)
    vox_to_vox = source_affine_inv @ reference_affine

    for z in range(reference_shape[2]):
        x_grid, y_grid = np.meshgrid(
            np.arange(reference_shape[0], dtype=np.float32),
            np.arange(reference_shape[1], dtype=np.float32),
            indexing='ij'
        )
        z_grid = np.full_like(x_grid, z, dtype=np.float32)

        coords_slice = np.stack([x_grid, y_grid, z_grid, np.ones_like(x_grid)], axis=-1)
        coords_slice_flat = coords_slice.reshape(-1, 4)

        source_coords_slice = np.dot(coords_slice_flat, vox_to_vox.T)[:, :3]

        sc_x = source_coords_slice[:, 0].reshape(reference_shape[0], reference_shape[1])
        sc_y = source_coords_slice[:, 1].reshape(reference_shape[0], reference_shape[1])
        sc_z = source_coords_slice[:, 2].reshape(reference_shape[0], reference_shape[1])

        if not extra_dims:
            resampled_data[:, :, z] = _trilinear_interpolate(source_data, sc_x, sc_y, sc_z)
        else:
            for idx in np.ndindex(extra_dims):
                full_idx_src = (slice(None), slice(None), slice(None)) + idx
                full_idx_dst = (slice(None), slice(None), z) + idx
                resampled_data[full_idx_dst] = _trilinear_interpolate(
                    source_data[full_idx_src], sc_x, sc_y, sc_z
                )

    new_header = source_img.header.copy()
    resampled_img = nib.Nifti1Image(resampled_data, reference_affine, header=new_header)
    resampled_img.set_sform(reference_affine, code=2)
    resampled_img.set_qform(reference_affine, code=2)

    ref_zooms = reference_img.header.get_zooms()[:3]
    src_zooms = source_img.header.get_zooms()
    new_zooms = list(ref_zooms)
    if len(src_zooms) > 3:
        new_zooms.extend(src_zooms[3:])
    resampled_img.header.set_zooms(new_zooms)
    return resampled_img


def run_resampling(source_bytes, reference_bytes):
    # Allow callers that already converted JS buffers (e.g. serial 4D helper).
    if hasattr(source_bytes, 'to_py'):
        source_bytes = source_bytes.to_py()
    if hasattr(reference_bytes, 'to_py'):
        reference_bytes = reference_bytes.to_py()
    source_fh = nib.FileHolder(fileobj=io.BytesIO(source_bytes))
    source_img = nib.Nifti1Image.from_file_map({'header': source_fh, 'image': source_fh})
    ref_fh = nib.FileHolder(fileobj=io.BytesIO(reference_bytes))
    ref_img = nib.Nifti1Image.from_file_map({'header': ref_fh, 'image': ref_fh})
    resampled_img = resample_to_reference(source_img, ref_img, order=1)
    # Robust path in Pyodide: write canonical .nii then read bytes back.
    # This avoids malformed in-memory returns observed with large 4D volumes.
    out_path = '/tmp/__resampled_tmp.nii'
    nib.save(resampled_img, out_path)
    return out_path


def run_resampling_serial3d_to_4d(source_bytes, reference_bytes):
    """4D path with lower peak RAM: no full-volume float32 copy, no list+stack of frames.
    Spills source to /tmp so raw .nii can use mmap; gzip still benefits from pre-allocated output."""
    if hasattr(source_bytes, 'to_py'):
        source_bytes = source_bytes.to_py()
    if hasattr(reference_bytes, 'to_py'):
        reference_bytes = reference_bytes.to_py()
    ref_fh = nib.FileHolder(fileobj=io.BytesIO(reference_bytes))
    ref_img = nib.Nifti1Image.from_file_map({'header': ref_fh, 'image': ref_fh})

    raw = bytes(source_bytes)
    is_gz = len(raw) > 2 and raw[0] == 0x1F and raw[1] == 0x8B
    spill = '/tmp/__rs_4d_src.nii.gz' if is_gz else '/tmp/__rs_4d_src.nii'
    with open(spill, 'wb') as f:
        f.write(raw)
    del raw
    gc.collect()

    mmap_mode = None if is_gz else 'r'
    try:
        try:
            source_img = nib.load(spill, mmap_mode=mmap_mode)
        except (TypeError, ValueError, AttributeError):
            source_img = nib.load(spill)
        sh = source_img.shape
        if len(sh) < 4 or int(sh[3]) <= 1:
            del source_img
            gc.collect()
            with open(spill, 'rb') as f:
                flat = f.read()
            return run_resampling(flat, reference_bytes)

        frames = int(sh[3])
        src_zooms = list(source_img.header.get_zooms())
        frame_header = source_img.header.copy()

        frame_data = np.asarray(source_img.dataobj[..., 0], dtype=np.float32)
        frame_img0 = nib.Nifti1Image(frame_data, source_img.affine, header=frame_header)
        frame_img0.set_sform(source_img.get_sform(), code=int(source_img.header['sform_code']))
        frame_img0.set_qform(source_img.get_qform(), code=int(source_img.header['qform_code']))
        res0 = resample_to_reference(frame_img0, ref_img, order=1)
        r0 = res0.get_fdata(dtype=np.float32)
        out_shape = r0.shape[:3]
        out_data = np.empty(out_shape + (frames,), dtype=np.float32)
        out_data[..., 0] = r0
        del frame_data, frame_img0, res0, r0
        gc.collect()

        for t in range(1, frames):
            frame_data = np.asarray(source_img.dataobj[..., t], dtype=np.float32)
            frame_img = nib.Nifti1Image(frame_data, source_img.affine, header=frame_header)
            frame_img.set_sform(source_img.get_sform(), code=int(source_img.header['sform_code']))
            frame_img.set_qform(source_img.get_qform(), code=int(source_img.header['qform_code']))
            resampled_frame = resample_to_reference(frame_img, ref_img, order=1)
            out_data[..., t] = resampled_frame.get_fdata(dtype=np.float32)
            del frame_data, frame_img, resampled_frame
            if (t & 0x3) == 0:
                gc.collect()

        del source_img
        gc.collect()
    finally:
        try:
            os.unlink(spill)
        except OSError:
            pass

    out_header = frame_header.copy()
    out_img = nib.Nifti1Image(out_data, ref_img.affine, header=out_header)
    out_img.set_sform(ref_img.affine, code=2)
    out_img.set_qform(ref_img.affine, code=2)
    ref_zooms = ref_img.header.get_zooms()[:3]
    dt = src_zooms[3] if len(src_zooms) > 3 else 1.0
    out_img.header.set_zooms((ref_zooms[0], ref_zooms[1], ref_zooms[2], dt))
    out_path = '/tmp/__resampled_tmp.nii'
    nib.save(out_img, out_path)
    return out_path
