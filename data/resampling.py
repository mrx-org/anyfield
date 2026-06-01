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

# Bump when resampling logic changes (Niivue fetch cache-bust must match).
RESAMPLING_PY_VERSION = 4

# "footprint_mean": average trilinear samples over each output voxel support (downsampling).
# "center": legacy point sample at voxel index (integer i,j,k).
DEFAULT_SAMPLING_MODE = "footprint_mean"
# General (rotation-safe) quadrature: substeps per axis = clamp(ceil(span), 1, cap).
# The box-average converges quickly, so a small cap (8) matches the old 32-step output
# visually while running up to ~4x faster on thick slabs (the common nz=1 / thick-FOV case).
DEFAULT_MAX_SUBSTEPS = 8
DEFAULT_DOWNSAMPLE_THRESHOLD = 1.0


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


def _footprint_substeps(
    source_affine,
    reference_affine,
    max_substeps=8,
    threshold=1.0,
    source_zooms=None,
    reference_zooms=None,
):
    """Sub-voxel quadrature counts per reference axis (source-index span of one ref voxel)."""
    src_inv = np.linalg.inv(source_affine.astype(np.float64))
    vox_to_vox = src_inv @ reference_affine.astype(np.float64)
    steps = []
    for axis in range(3):
        span_affine = float(np.linalg.norm(vox_to_vox[:3, axis]))
        span_zoom = span_affine
        if (
            source_zooms is not None
            and reference_zooms is not None
            and axis < len(source_zooms)
            and axis < len(reference_zooms)
        ):
            src_z = max(float(source_zooms[axis]), 1e-8)
            span_zoom = float(reference_zooms[axis]) / src_z
        span = max(span_affine, span_zoom)
        if span <= threshold:
            steps.append(1)
        else:
            steps.append(int(min(max_substeps, max(1, int(np.ceil(span))))))
    return tuple(steps)


def _ref_plane_grids(ref_shape, k, ui, ni, uj, nj, uk, nk):
    """Reference index coords for one sub-sample through an XY plane at ref index k."""
    x_1d = np.arange(ref_shape[0], dtype=np.float32) - 0.5 + (ui + 0.5) / ni
    y_1d = np.arange(ref_shape[1], dtype=np.float32) - 0.5 + (uj + 0.5) / nj
    x_grid, y_grid = np.meshgrid(x_1d, y_1d, indexing='ij')
    z_val = np.float32(k) - 0.5 + (uk + 0.5) / nk
    z_grid = np.full_like(x_grid, z_val, dtype=np.float32)
    return x_grid, y_grid, z_grid


def _map_ref_grids_to_source(x_grid, y_grid, z_grid, vox_to_vox):
    coords = np.stack([x_grid, y_grid, z_grid, np.ones_like(x_grid, dtype=np.float32)], axis=-1)
    src = np.dot(coords.reshape(-1, 4), vox_to_vox.T)[:, :3]
    nx, ny = x_grid.shape
    return (
        src[:, 0].reshape(nx, ny),
        src[:, 1].reshape(nx, ny),
        src[:, 2].reshape(nx, ny),
    )


def _sample_ref_plane(source_data, vox_to_vox, ref_shape, k, substeps):
    """Trilinear sample one reference Z plane with optional footprint averaging."""
    st_i, st_j, st_k = substeps
    nx, ny = ref_shape[0], ref_shape[1]
    if st_i == st_j == st_k == 1:
        x_grid, y_grid = np.meshgrid(
            np.arange(nx, dtype=np.float32),
            np.arange(ny, dtype=np.float32),
            indexing='ij',
        )
        z_grid = np.full_like(x_grid, np.float32(k), dtype=np.float32)
        sc_x, sc_y, sc_z = _map_ref_grids_to_source(x_grid, y_grid, z_grid, vox_to_vox)
        return _trilinear_interpolate(source_data, sc_x, sc_y, sc_z)

    accum = np.zeros((nx, ny), dtype=np.float32)
    count = st_i * st_j * st_k
    for uk in range(st_k):
        for ui in range(st_i):
            for uj in range(st_j):
                x_grid, y_grid, z_grid = _ref_plane_grids(ref_shape, k, ui, st_i, uj, st_j, uk, st_k)
                sc_x, sc_y, sc_z = _map_ref_grids_to_source(x_grid, y_grid, z_grid, vox_to_vox)
                accum += _trilinear_interpolate(source_data, sc_x, sc_y, sc_z)
    return accum / count


def resample_to_reference(
    source_img,
    reference_img,
    order=1,
    sampling_mode=None,
    max_substeps=None,
    downsample_threshold=None,
):
    """
    Resample source onto the reference grid.

    sampling_mode:
      - "footprint_mean" (default): average over each output voxel footprint when
        reference voxels are coarser than source sampling (thick-slab / partial volume).
      - "center": legacy point sample at integer ref indices (i, j, k).
    """
    del order  # kept for API compatibility; interpolation is always trilinear here

    if sampling_mode is None:
        sampling_mode = DEFAULT_SAMPLING_MODE
    if max_substeps is None:
        max_substeps = DEFAULT_MAX_SUBSTEPS
    if downsample_threshold is None:
        downsample_threshold = DEFAULT_DOWNSAMPLE_THRESHOLD

    source_data = source_img.get_fdata(dtype=np.float32)
    source_affine = source_img.affine.astype(np.float64)
    reference_affine = reference_img.affine.astype(np.float64)
    reference_shape = reference_img.shape[:3]

    extra_dims = source_data.shape[3:]
    output_shape = reference_shape + extra_dims
    resampled_data = np.zeros(output_shape, dtype=np.float32)

    source_affine_inv = np.linalg.inv(source_affine)
    vox_to_vox = (source_affine_inv @ reference_affine).astype(np.float32)

    use_footprint = sampling_mode == "footprint_mean"
    src_zooms = source_img.header.get_zooms()[:3]
    ref_zooms = reference_img.header.get_zooms()[:3]
    substeps = (
        _footprint_substeps(
            source_affine,
            reference_affine,
            max_substeps,
            downsample_threshold,
            src_zooms,
            ref_zooms,
        )
        if use_footprint
        else (1, 1, 1)
    )

    for z in range(reference_shape[2]):
        if not extra_dims:
            resampled_data[:, :, z] = _sample_ref_plane(
                source_data, vox_to_vox, reference_shape, z, substeps
            )
        else:
            for idx in np.ndindex(extra_dims):
                full_idx_src = (slice(None), slice(None), slice(None)) + idx
                full_idx_dst = (slice(None), slice(None), z) + idx
                resampled_data[full_idx_dst] = _sample_ref_plane(
                    source_data[full_idx_src], vox_to_vox, reference_shape, z, substeps
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


def _get_pyodide_option(name, default):
    """Read optional value injected via pyodide.globals.set(...) before run_resampling."""
    import sys
    main = sys.modules.get("__main__")
    if main is not None and hasattr(main, name):
        val = getattr(main, name)
        if val is not None:
            return val
    return default


def _resolve_sampling_kwargs():
    mode = str(_get_pyodide_option("resample_sampling_mode", DEFAULT_SAMPLING_MODE))
    max_sub = int(_get_pyodide_option("resample_max_substeps", DEFAULT_MAX_SUBSTEPS))
    return mode, max_sub


def _sanitize_job_id(job_id):
    """Safe token for /tmp filenames (one job may run many resample passes with suffix)."""
    if job_id is None:
        return "default"
    s = str(job_id).strip()
    if not s:
        return "default"
    out = []
    for ch in s:
        if ch.isalnum() or ch in "-_":
            out.append(ch)
        elif ch in ".:/\\":
            out.append("_")
    token = "".join(out)[:64] or "default"
    return token


def _resample_temp_paths(job_id=None, suffix=None):
    base = _sanitize_job_id(job_id)
    suf = f"_{suffix}" if suffix else ""
    return {
        "out": f"/tmp/__rs_{base}{suf}.nii",
        "spill": f"/tmp/__rs_4d_{base}{suf}.nii",
        "spill_gz": f"/tmp/__rs_4d_{base}{suf}.nii.gz",
    }


def run_resampling(
    source_bytes,
    reference_bytes,
    sampling_mode=None,
    max_substeps=None,
    out_path=None,
    job_id=None,
    suffix=None,
):
    # Allow callers that already converted JS buffers (e.g. serial 4D helper).
    if hasattr(source_bytes, 'to_py'):
        source_bytes = source_bytes.to_py()
    if hasattr(reference_bytes, 'to_py'):
        reference_bytes = reference_bytes.to_py()
    if hasattr(sampling_mode, 'to_py'):
        sampling_mode = sampling_mode.to_py()
    if hasattr(max_substeps, 'to_py'):
        max_substeps = max_substeps.to_py()
    source_fh = nib.FileHolder(fileobj=io.BytesIO(source_bytes))
    source_img = nib.Nifti1Image.from_file_map({'header': source_fh, 'image': source_fh})
    ref_fh = nib.FileHolder(fileobj=io.BytesIO(reference_bytes))
    ref_img = nib.Nifti1Image.from_file_map({'header': ref_fh, 'image': ref_fh})
    if sampling_mode is None or max_substeps is None:
        resolved_mode, resolved_max = _resolve_sampling_kwargs()
        if sampling_mode is None:
            sampling_mode = resolved_mode
        if max_substeps is None:
            max_substeps = resolved_max
    sampling_mode = str(sampling_mode)
    max_substeps = int(max_substeps)
    substeps = _footprint_substeps(
        source_img.affine,
        ref_img.affine,
        max_substeps,
        DEFAULT_DOWNSAMPLE_THRESHOLD,
        source_img.header.get_zooms()[:3],
        ref_img.header.get_zooms()[:3],
    )
    print(
        f"[resampling v{RESAMPLING_PY_VERSION}] mode={sampling_mode} "
        f"substeps={substeps} ref_shape={ref_img.shape[:3]} "
        f"ref_zooms={tuple(round(float(z), 4) for z in ref_img.header.get_zooms()[:3])}"
    )
    resampled_img = resample_to_reference(
        source_img,
        ref_img,
        sampling_mode=sampling_mode,
        max_substeps=max_substeps,
    )
    # Robust path in Pyodide: write canonical .nii then read bytes back.
    # This avoids malformed in-memory returns observed with large 4D volumes.
    if out_path is None:
        out_path = _resample_temp_paths(job_id, suffix)["out"]
    nib.save(resampled_img, out_path)
    return out_path


def run_resampling_serial3d_to_4d(
    source_bytes,
    reference_bytes,
    sampling_mode=None,
    max_substeps=None,
    out_path=None,
    job_id=None,
    suffix=None,
):
    """4D path with lower peak RAM: no full-volume float32 copy, no list+stack of frames.
    Spills source to /tmp so raw .nii can use mmap; gzip still benefits from pre-allocated output."""
    if hasattr(source_bytes, 'to_py'):
        source_bytes = source_bytes.to_py()
    if hasattr(reference_bytes, 'to_py'):
        reference_bytes = reference_bytes.to_py()
    if hasattr(sampling_mode, 'to_py'):
        sampling_mode = sampling_mode.to_py()
    if hasattr(max_substeps, 'to_py'):
        max_substeps = max_substeps.to_py()
    ref_fh = nib.FileHolder(fileobj=io.BytesIO(reference_bytes))
    ref_img = nib.Nifti1Image.from_file_map({'header': ref_fh, 'image': ref_fh})
    if sampling_mode is None or max_substeps is None:
        resolved_mode, resolved_max = _resolve_sampling_kwargs()
        if sampling_mode is None:
            sampling_mode = resolved_mode
        if max_substeps is None:
            max_substeps = resolved_max
    sampling_mode = str(sampling_mode)
    max_substeps = int(max_substeps)

    paths = _resample_temp_paths(job_id, suffix)
    if out_path is None:
        out_path = paths["out"]
    raw = bytes(source_bytes)
    is_gz = len(raw) > 2 and raw[0] == 0x1F and raw[1] == 0x8B
    spill = paths["spill_gz"] if is_gz else paths["spill"]
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
            return run_resampling(
                flat,
                reference_bytes,
                sampling_mode,
                max_substeps,
                out_path=out_path,
                job_id=job_id,
                suffix=suffix,
            )

        frames = int(sh[3])
        src_zooms = list(source_img.header.get_zooms())
        frame_header = source_img.header.copy()

        frame_data = np.asarray(source_img.dataobj[..., 0], dtype=np.float32)
        frame_img0 = nib.Nifti1Image(frame_data, source_img.affine, header=frame_header)
        frame_img0.set_sform(source_img.get_sform(), code=int(source_img.header['sform_code']))
        frame_img0.set_qform(source_img.get_qform(), code=int(source_img.header['qform_code']))
        res0 = resample_to_reference(
            frame_img0,
            ref_img,
            sampling_mode=sampling_mode,
            max_substeps=max_substeps,
        )
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
            resampled_frame = resample_to_reference(
                frame_img,
                ref_img,
                sampling_mode=sampling_mode,
                max_substeps=max_substeps,
            )
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
    nib.save(out_img, out_path)
    return out_path
