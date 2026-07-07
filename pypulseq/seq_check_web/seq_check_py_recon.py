"""Pyodide helpers for seq_check_web: sim cache + windowed NUFFT recon (Fig 6)."""

_DCF_ITERS = 20
_DCF_EPS = 1e-6

# Module globals (Pyodide exec has no reliable __main__ for these helpers).
_sim_cache_py = None


def _kspace_cache_dict():
    try:
        import __main__ as main

        return getattr(main, "_kspace_cache", None)
    except Exception:
        return None


def _pipe_menon_dcf_pynufft(nufft_obj, n_samples, n_iter=_DCF_ITERS):
    from pynufft import NUFFT

    if n_samples < 1:
        raise ValueError("empty trajectory")
    y2k = nufft_obj._y2k_cpu
    k2y = nufft_obj._k2y_cpu
    w = np.ones(int(n_samples), dtype=np.complex64)
    for _ in range(int(n_iter)):
        gridded = y2k(w)
        back = k2y(gridded)
        w = w / np.maximum(np.abs(back), _DCF_EPS)
    return np.abs(w).astype(np.float32)


def recon_nufft_2d_adjoint(k_xy_1pm, signal_c64, n_pix, fov_m):
    from pynufft import NUFFT

    k_xy = np.asarray(k_xy_1pm, dtype=np.float64)
    sig = np.asarray(signal_c64, dtype=np.complex64).ravel()
    m = min(int(k_xy.shape[0]), int(sig.size))
    n_pix = int(n_pix)
    if m < 1 or n_pix < 1:
        return np.zeros((n_pix, n_pix), dtype=np.complex64)
    k2 = k_xy[:m, :2]
    sig = sig[:m]
    kmax = float(n_pix) / (2.0 * float(fov_m))
    om = np.stack(
        [
            (k2[:, 0] / kmax) * np.pi,
            (k2[:, 1] / kmax) * np.pi,
            np.zeros(m, dtype=np.float64),
        ],
        axis=1,
    )
    a = NUFFT()
    nx = ny = n_pix
    a.plan(om[:, :2], (nx, ny), (2 * nx, 2 * ny), (6, 6))
    dcf = _pipe_menon_dcf_pynufft(a, m)
    y = sig * dcf.astype(np.complex64, copy=False)
    rec = np.asarray(a.adjoint(y), dtype=np.complex64).reshape(nx, ny)
    return np.flip(rec, axis=(0, 1))


def recon_nufft_1d_adjoint(k_axis_1pm, signal_c64, res, fov_m):
    from pynufft import NUFFT

    k1 = np.asarray(k_axis_1pm, dtype=np.float64).reshape(-1)
    sig = np.asarray(signal_c64, dtype=np.complex64).reshape(-1)
    m = min(k1.size, sig.size)
    r = int(res)
    if m < 1 or r < 1:
        return np.zeros(max(r, 1), dtype=np.complex64)
    k1 = k1[:m]
    sig = sig[:m]
    kmax = float(r) / (2.0 * float(fov_m))
    om = (k1 / kmax) * np.pi
    om2 = np.stack([om, np.zeros(m, dtype=np.float64)], axis=1)
    a = NUFFT()
    a.plan(om2, (r,), (2 * r,), (6,))
    dcf = _pipe_menon_dcf_pynufft(a, m)
    y = sig * dcf.astype(np.complex64, copy=False)
    rec = np.asarray(a.adjoint(y), dtype=np.complex64).reshape(r)
    return np.flip(rec, axis=(0,))


def _fov_component_m(val):
    """Pulseq FOV is usually metres; values > 2 are treated as mm."""
    v = float(val)
    if v <= 0:
        return None
    if v > 2.0:
        v *= 0.001
    return v


def get_recon_meta_json():
    import json

    fov_x = fov_y = 0.256
    fov_z = 0.005
    nread = nphase = 256
    try:
        fd = seq.get_definition("FOV")
        if fd is None:
            fd = seq.get_definition("fov")
        if fd is not None and hasattr(fd, "__len__"):
            if len(fd) >= 1:
                fx = _fov_component_m(fd[0])
                if fx is not None:
                    fov_x = fx
            if len(fd) >= 2:
                fy = _fov_component_m(fd[1])
                if fy is not None:
                    fov_y = fy
            else:
                fov_y = fov_x
            if len(fd) >= 3:
                fz = _fov_component_m(fd[2])
                if fz is not None:
                    fov_z = fz
    except Exception:
        pass
    try:
        mv = seq.get_definition("Matrix") or seq.get_definition("matrix")
        if mv is not None and hasattr(mv, "__len__") and len(mv) >= 1:
            nread = int(mv[0])
            nphase = int(mv[1]) if len(mv) >= 2 else nread
    except Exception:
        pass
    return json.dumps(
        {
            "fov_m": fov_x,
            "fov_x_m": fov_x,
            "fov_y_m": fov_y,
            "fov_z_m": fov_z,
            "n_pix": nread,
            "n_phase": nphase,
        }
    )


def _adc_index_range(t_adc, t_lo, t_hi, margin=1e-6):
    ta = np.asarray(t_adc, dtype=np.float64).ravel()
    n = int(ta.size)
    if n < 1:
        return 0, -1
    t_lo = float(t_lo)
    t_hi = float(t_hi)
    if t_hi < t_lo:
        t_lo, t_hi = t_hi, t_lo
    t_min = t_lo - float(margin)
    t_max = t_hi + float(margin)
    i_lo = int(np.searchsorted(ta, t_min, side="left"))
    i_lo = min(i_lo, n - 1)
    i_hi = int(np.searchsorted(ta, t_max, side="right")) - 1
    if i_hi < i_lo:
        return i_lo, i_lo - 1
    return i_lo, i_hi


def _map_adc_indices_to_traj(a_lo, a_hi, traj, kx_adc, ky_adc, n_adc_lines=None):
    traj = np.asarray(traj, dtype=np.float64)
    n_traj = int(traj.shape[0])
    if n_traj < 1 or a_hi < a_lo:
        return np.array([], dtype=np.int64)

    kx_adc = np.asarray(kx_adc if kx_adc is not None else [], dtype=np.float64).ravel()
    ky_adc = np.asarray(ky_adc if ky_adc is not None else [], dtype=np.float64).ravel()
    n_kx = int(kx_adc.size)
    if n_kx > 0 and ky_adc.size > 0:
        n_kx = min(n_kx, int(ky_adc.size))
    n_adc = int(n_adc_lines) if n_adc_lines is not None else n_kx

    if n_adc > 0 and n_traj == n_adc:
        a_lo = max(0, int(a_lo))
        a_hi = min(int(a_hi), n_adc - 1)
        if a_hi < a_lo:
            return np.array([], dtype=np.int64)
        return np.arange(a_lo, a_hi + 1, dtype=np.int64)

    if n_kx > 0 and kx_adc.size >= 1 and ky_adc.size >= 1:
        kx = traj[:, 0]
        ky = traj[:, 1] if traj.shape[1] >= 2 else np.zeros(n_traj, dtype=np.float64)
        out = []
        j_hi = min(int(a_hi), n_kx - 1)
        for j in range(max(0, int(a_lo)), j_hi + 1):
            kx_t = float(kx_adc[j])
            ky_t = float(ky_adc[j]) if j < ky_adc.size else 0.0
            if not (np.isfinite(kx_t) and np.isfinite(ky_t)):
                continue
            d = (kx - kx_t) ** 2 + (ky - ky_t) ** 2
            out.append(int(np.argmin(d)))
        if not out:
            return np.array([], dtype=np.int64)
        return np.asarray(out, dtype=np.int64)

    denom = max(1, n_adc - 1) if n_adc > 1 else max(1, a_hi - a_lo)
    out = []
    for j in range(int(a_lo), int(a_hi) + 1):
        if n_traj == 1:
            out.append(0)
            continue
        u = float(j) / float(denom) if n_adc > 1 else float(j - a_lo) / float(max(1, a_hi - a_lo))
        out.append(int(np.round(u * float(n_traj - 1))))
    return np.asarray(out, dtype=np.int64)


def _adc_arrays_for_window(cache):
    """Prefer live pypulseq k-space cache (same source as JS Fig 6)."""
    kc = _kspace_cache_dict()
    if kc is not None:
        ta = np.asarray(kc.get("t_adc") if kc.get("t_adc") is not None else [], dtype=np.float64).ravel()
        kx = np.asarray(kc.get("kx_adc") if kc.get("kx_adc") is not None else [], dtype=np.float64).ravel()
        ky = np.asarray(kc.get("ky_adc") if kc.get("ky_adc") is not None else [], dtype=np.float64).ravel()
        if ta.size > 0:
            m = int(min(ta.size, kx.size if kx.size else ta.size, ky.size if ky.size else ta.size))
            return ta[:m], kx[:m], ky[:m]
    ta = np.asarray(cache.get("t_adc") if cache.get("t_adc") is not None else [], dtype=np.float64).ravel()
    kx = np.asarray(cache.get("kx_adc") if cache.get("kx_adc") is not None else [], dtype=np.float64).ravel()
    ky = np.asarray(cache.get("ky_adc") if cache.get("ky_adc") is not None else [], dtype=np.float64).ravel()
    m = int(min(ta.size, kx.size if kx.size else ta.size, ky.size if ky.size else ta.size))
    if m > 0:
        return ta[:m], kx[:m], ky[:m]
    return ta, kx, ky


def _traj_indices_for_adc_window(t_lo, t_hi, cache):
    ta, kx_adc, ky_adc = _adc_arrays_for_window(cache)
    if ta.size < 1:
        return np.array([], dtype=np.int64)
    a_lo, a_hi = _adc_index_range(ta, t_lo, t_hi)
    return _map_adc_indices_to_traj(
        a_lo,
        a_hi,
        cache["traj"],
        kx_adc,
        ky_adc,
        n_adc_lines=int(ta.size),
    )


def _json_float_list(arr):
    out = []
    for x in arr or []:
        if x is None:
            continue
        try:
            v = float(x)
        except (TypeError, ValueError):
            continue
        if np.isfinite(v):
            out.append(v)
    return np.asarray(out, dtype=np.float64)


def set_sim_cache_py(traj_json, signal_json, kspace_adc_json=None):
    import json

    global _sim_cache_py

    traj = json.loads(traj_json) if isinstance(traj_json, str) else traj_json
    sig = json.loads(signal_json) if isinstance(signal_json, str) else signal_json
    t = np.asarray(traj, dtype=np.float64)
    if t.ndim != 2 or t.shape[1] < 2:
        raise ValueError("traj must be Nx3")
    s = np.asarray(sig, dtype=np.float64)
    if s.ndim != 2 or s.shape[1] < 2:
        raise ValueError("signal must be Nx2 re,im")
    n = min(t.shape[0], s.shape[0])
    t = t[:n]
    s = s[:n]

    ta = kx_a = ky_a = np.array([], dtype=np.float64)
    if kspace_adc_json:
        ks = (
            json.loads(kspace_adc_json)
            if isinstance(kspace_adc_json, str)
            else kspace_adc_json
        )
        if isinstance(ks, dict):
            ta = _json_float_list(ks.get("t_adc"))
            kx_a = _json_float_list(ks.get("kx_adc"))
            ky_a = _json_float_list(ks.get("ky_adc"))

    if ta.size < 1:
        c = _kspace_cache_dict() or {}
        ta_raw = c.get("t_adc")
        ta = np.asarray(ta_raw if ta_raw is not None else [], dtype=np.float64).ravel()
        kx_a = np.asarray(c.get("kx_adc") if c.get("kx_adc") is not None else [], dtype=np.float64).ravel()
        ky_a = np.asarray(c.get("ky_adc") if c.get("ky_adc") is not None else [], dtype=np.float64).ravel()

    m = int(min(ta.size, kx_a.size if kx_a.size else ta.size, ky_a.size if ky_a.size else ta.size))
    if m > 0 and kx_a.size > 0 and ky_a.size > 0:
        ta, kx_a, ky_a = ta[:m], kx_a[:m], ky_a[:m]
    elif m > 0:
        ta = ta[:m]
    _sim_cache_py = {
        "traj": t,
        "signal": (s[:, 0] + 1j * s[:, 1]).astype(np.complex64),
        "t_adc": ta,
        "kx_adc": kx_a,
        "ky_adc": ky_a,
        "n_traj": int(n),
        "n_adc": int(ta.size),
    }
    return json.dumps(
        {
            "n_traj": int(n),
            "n_adc": int(ta.size),
            "t_adc": ta.astype(float).tolist(),
        }
    )


def _recon_nifti_geometry(nx, ny, nz, fov_x_m, fov_y_m, fov_z_m):
    """
    Effective NIfTI spacing (mm), matching scan_zero / Niivue convention.
    nz=1: one z voxel spans the full sequence FOV_z → slice thickness = FOV_z.
    """
    fov_x_m = float(fov_x_m)
    fov_y_m = float(fov_y_m) if float(fov_y_m) > 0 else fov_x_m
    fov_z_m = float(fov_z_m)
    if fov_z_m <= 0:
        fov_z_m = 0.005
    nz = max(1, int(nz))
    dx_mm = (fov_x_m / float(nx)) * 1000.0
    dy_mm = (fov_y_m / float(ny)) * 1000.0
    dz_mm = (fov_z_m / float(nz)) * 1000.0
    return {
        "dims": [nx, ny, nz, 2],
        "dx_mm": dx_mm,
        "dy_mm": dy_mm,
        "dz_mm": dz_mm,
        "fov_x_mm": fov_x_m * 1000.0,
        "fov_y_mm": fov_y_m * 1000.0,
        "fov_z_mm": fov_z_m * 1000.0,
        "slice_thickness_mm": dz_mm,
    }


def _write_recon_nifti_4d(mag01, phase01, fov_x_m, fov_y_m, fov_z_m, path):
    """4D NIfTI (nx, ny, 1, 2): frame 0 = mag, frame 1 = phase [0,1]. Spacing in mm (RAS diagonal)."""
    import nibabel as nib

    mag01 = np.ascontiguousarray(np.asarray(mag01, dtype=np.float32))
    phase01 = np.ascontiguousarray(np.asarray(phase01, dtype=np.float32))
    if mag01.ndim != 2 or phase01.shape != mag01.shape:
        raise ValueError("mag and phase must be 2D with same shape")
    nx, ny = int(mag01.shape[0]), int(mag01.shape[1])
    nz = 1
    geo = _recon_nifti_geometry(nx, ny, nz, fov_x_m, fov_y_m, fov_z_m)
    vol = np.zeros((nx, ny, nz, 2), dtype=np.float32)
    vol[:, :, 0, 0] = mag01
    vol[:, :, 0, 1] = phase01
    affine = np.diag([geo["dx_mm"], geo["dy_mm"], geo["dz_mm"], 1.0]).astype(np.float64)
    img = nib.Nifti1Image(vol, affine)
    hdr = img.header
    hdr.set_data_dtype(np.float32)
    hdr.set_zooms((geo["dx_mm"], geo["dy_mm"], geo["dz_mm"], 1.0))
    img.set_qform(affine, code=2)
    img.set_sform(affine, code=2)
    hdr["cal_min"] = 0.0
    hdr["cal_max"] = 1.0
    hdr["descrip"] = b"seq_check NUFFT f0=mag f1=phase 2D"
    hdr["intent_code"] = 0
    nib.save(img, path)
    return geo


def _recon_nufft_from_traj_indices(idx, meta=None):
    import base64
    import json

    global _sim_cache_py

    if meta is None:
        meta = json.loads(get_recon_meta_json())
    c = _sim_cache_py
    if c is None:
        return json.dumps({"ok": False, "reason": "no sim cache"})
    idx = np.asarray(idx, dtype=np.int64).ravel()
    n_traj = int(np.asarray(c["traj"]).shape[0])
    if idx.size < 1:
        return json.dumps({"ok": False, "reason": "no ADC samples in time window", "n": 0})
    idx = idx[(idx >= 0) & (idx < n_traj)]
    n = int(idx.size)
    if n < 1:
        return json.dumps({"ok": False, "reason": "no ADC samples in time window", "n": 0})
    traj = np.asarray(c["traj"], dtype=np.float64)[idx]
    sig = np.asarray(c["signal"], dtype=np.complex64).ravel()[idx]
    fov_x = float(meta.get("fov_x_m") or meta["fov_m"])
    rec = recon_nufft_2d_adjoint(traj, sig, int(meta["n_pix"]), fov_x)
    mag = np.abs(rec).astype(np.float32)
    phase = np.angle(rec).astype(np.float32)
    mmax = float(np.max(mag)) if mag.size else 0.0
    if mmax > 0:
        mag = mag / mmax
    phase01 = (phase + np.pi) / (2.0 * np.pi)
    nx, ny = int(rec.shape[0]), int(rec.shape[1])
    mag_r = np.asarray(mag, dtype=np.float32).ravel()
    phase_r = np.asarray(phase01, dtype=np.float32).ravel()
    out = {
        "ok": True,
        "n": n,
        "nx": nx,
        "ny": ny,
        "nFrame4D": 2,
        "nZ": 1,
        "niftiGeo": None,
        "magB64": base64.b64encode(mag_r.tobytes()).decode("ascii"),
        "phaseB64": base64.b64encode(phase_r.tobytes()).decode("ascii"),
        "niiPath": None,
        "niiB64": None,
        "niiError": None,
    }
    nii_path = "/recon_window.nii.gz"
    try:
        geo = _write_recon_nifti_4d(
            mag,
            phase01,
            fov_x,
            float(meta.get("fov_y_m") or fov_x),
            float(meta.get("fov_z_m") or 0.005),
            nii_path,
        )
        out["niftiGeo"] = geo
        out["niiPath"] = nii_path
        with open(nii_path, "rb") as fh:
            out["niiB64"] = base64.b64encode(fh.read()).decode("ascii")
    except Exception as e:
        out["niiError"] = str(e)
    return json.dumps(out)


def recon_nufft_window_json(t_lo, t_hi):
    global _sim_cache_py

    c = _sim_cache_py
    if c is None:
        import json

        return json.dumps({"ok": False, "reason": "no sim cache"})
    t_lo = float(t_lo)
    t_hi = float(t_hi)
    if t_hi < t_lo:
        t_lo, t_hi = t_hi, t_lo
    idx = _traj_indices_for_adc_window(t_lo, t_hi, c)
    return _recon_nufft_from_traj_indices(idx)


def recon_nufft_indices_json(indices_json):
    """NUFFT on explicit trajex row indices (same selection as JS Fig 6)."""
    import json

    if isinstance(indices_json, str):
        idx = json.loads(indices_json)
    else:
        idx = indices_json
    return _recon_nufft_from_traj_indices(idx)
