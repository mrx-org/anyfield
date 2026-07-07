"""Pyodide PSF profiles (Fig 7): trajex signal=True per tissue + 1D adjoint NUFFT (seq_check.py)."""

_PSF_RES = 10000
_PSF_FOV_M = 0.01

# Module global: trajex PSF bundle from JS (not rapisim sim signal).
_psf_bundle_py = None


def _fov_res_from_grid_json(grid_json):
    import json

    if not grid_json:
        return None
    o = json.loads(grid_json)
    if not o:
        return None
    fov_x = float(o.get("fov_x_m") or o.get("fov_m"))
    fov_y = float(o.get("fov_y_m") or fov_x)
    fov_z = float(o.get("fov_z_m") or 0.005)
    n_pix = int(o["n_pix"])
    n_phase = int(o.get("n_phase") or n_pix)
    nz = int(o.get("nz") or 1)
    if fov_x <= 0 or fov_y <= 0 or n_pix < 1 or n_phase < 1:
        raise ValueError("invalid PSF grid override")
    return (
        [fov_x, fov_y, fov_z],
        [n_pix, n_phase, nz],
    )


def _seq_fov_res():
    import json

    meta = json.loads(get_recon_meta_json())
    fov = [
        float(meta.get("fov_x_m") or meta["fov_m"]),
        float(meta.get("fov_y_m") or meta["fov_m"]),
        float(meta.get("fov_z_m") or 0.005),
    ]
    res = [int(meta["n_pix"]), int(meta.get("n_phase") or meta["n_pix"]), 1]
    try:
        mv = seq.get_definition("Matrix") or seq.get_definition("matrix")
        if mv is not None and hasattr(mv, "__len__"):
            if len(mv) >= 2:
                res[1] = int(mv[1])
            if len(mv) >= 3 and int(mv[2]) > 0:
                res[2] = int(mv[2])
    except Exception:
        pass
    return fov, res


def set_psf_bundle_py(kspace_json, tissues_json):
    """Load PSF bundle from fetchPsfTrajexBundle (k-space Nx4, per-tissue trajex signal)."""
    import json

    global _psf_bundle_py

    kspace = np.asarray(json.loads(kspace_json), dtype=np.float64)
    if kspace.ndim != 2 or kspace.shape[1] < 4:
        raise ValueError("kspace must be Nx4 [kx, ky, kz, tau]")
    tissues_in = json.loads(tissues_json)
    tau = kspace[:, 3]
    psf_tensors = []
    tissue_names = []
    for t in tissues_in:
        name = str(t.get("name", "tissue"))
        t2d = float(t.get("T2dash", 0.1))
        sig = np.asarray(t["signal"], dtype=np.float64)
        if sig.ndim != 2 or sig.shape[1] < 2:
            raise ValueError("tissue signal must be Nx2 re,im")
        n = min(kspace.shape[0], sig.shape[0])
        s = (sig[:n, 0] + 1j * sig[:n, 1]).astype(np.complex64)
        s = s * np.exp(-np.abs(tau[:n]) / t2d).astype(np.complex64)
        psf_tensors.append(s)
        tissue_names.append(name)

    _psf_bundle_py = {
        "kspace": kspace.astype(np.float32),
        "psf_tensors": psf_tensors,
        "tissue_names": tissue_names,
    }
    return json.dumps({"n": int(kspace.shape[0]), "tissues": len(tissue_names)})


def _psf_nufft_1d(signal, kspace_axis, res, fov):
    k_ax = np.asarray(kspace_axis, dtype=np.float64).reshape(-1)
    sig = np.asarray(signal, dtype=np.complex64).reshape(-1)
    reco = recon_nufft_1d_adjoint(k_ax, sig, int(res), float(fov))
    peak_reco = float(np.max(np.abs(reco)))
    peak_sig = float(np.max(np.abs(sig)))
    if peak_reco > 0 and peak_sig > 0:
        reco = reco / peak_reco * peak_sig
    return reco


def _fwhm_mm(x_mm, y_abs):
    x_mm = np.asarray(x_mm, dtype=np.float64).reshape(-1)
    y_abs = np.asarray(y_abs, dtype=np.float64).reshape(-1)
    if x_mm.size == 0 or y_abs.size == 0:
        return float("nan")
    max_idx = int(np.argmax(y_abs))
    max_y = float(y_abs[max_idx])
    if max_y <= 0:
        return float("nan")
    half_level = max_y / 2.0
    left_idx = max_idx
    while left_idx > 0 and y_abs[left_idx] >= half_level:
        left_idx -= 1
    if left_idx == 0 and y_abs[left_idx] >= half_level:
        left_x = float(x_mm[0])
    else:
        x1, x2 = float(x_mm[left_idx]), float(x_mm[left_idx + 1])
        y1, y2 = float(y_abs[left_idx]), float(y_abs[left_idx + 1])
        left_x = x1 if y2 == y1 else x1 + (half_level - y1) * (x2 - x1) / (y2 - y1)
    right_idx = max_idx
    last = int(y_abs.size - 1)
    while right_idx < last and y_abs[right_idx] >= half_level:
        right_idx += 1
    if right_idx == last and y_abs[right_idx] >= half_level:
        right_x = float(x_mm[last])
    else:
        x1, x2 = float(x_mm[right_idx - 1]), float(x_mm[right_idx])
        y1, y2 = float(y_abs[right_idx - 1]), float(y_abs[right_idx])
        right_x = x2 if y2 == y1 else x1 + (half_level - y1) * (x2 - x1) / (y2 - y1)
    return float(abs(right_x - left_x))


def compute_psf_json(grid_json=None):
    import base64
    import json

    global _psf_bundle_py

    if _psf_bundle_py is None:
        return json.dumps(
            {
                "ok": False,
                "reason": "PSF trajex bundle missing (re-upload .seq)",
            }
        )

    b = _psf_bundle_py
    kspace = np.asarray(b["kspace"], dtype=np.float64)
    psf_tensors = b["psf_tensors"]
    tissue_names = b["tissue_names"]
    n = int(kspace.shape[0])
    if n < 8 or len(psf_tensors) < 1:
        return json.dumps({"ok": False, "reason": "too few PSF samples"})

    fov, res = _fov_res_from_grid_json(grid_json) or _seq_fov_res()
    psf_res = int(_PSF_RES)
    psf_fov_m = float(_PSF_FOV_M)
    xlim_mm = psf_fov_m * 500.0
    fwhm_sinc = 1.20671
    panels = []
    metrics = []

    for axis in range(3):
        axis_fov = float(fov[axis])
        res_axis = int(res[axis])
        if axis_fov <= 0 or res_axis < 1:
            continue
        xaxis = np.linspace(-axis_fov / 2.0, axis_fov / 2.0, psf_res + 1, dtype=np.float64)[1:]
        x_norm = xaxis * float(res_axis) / axis_fov
        ideal = np.abs(np.sinc(x_norm)).astype(np.float32)
        ideal_peak = float(np.max(ideal))
        ideal_norm = (
            (ideal / ideal_peak).astype(np.float32) if ideal_peak > 0 else ideal.copy()
        )
        x_mm = (xaxis * 1000.0).astype(np.float32)
        tissues = []
        ksp = kspace
        for n_idx, psf in enumerate(psf_tensors):
            tname = tissue_names[n_idx] if n_idx < len(tissue_names) else f"Tissue {n_idx}"
            prof = _psf_nufft_1d(psf, ksp[:, axis], psf_res, axis_fov)
            y_abs = np.abs(prof).astype(np.float32)
            y_peak = float(np.max(y_abs))
            y_norm = (
                (y_abs / y_peak).astype(np.float32) if y_peak > 0 else y_abs.copy()
            )
            fwhm_val = _fwhm_mm(x_mm, y_abs)
            res_mm = fwhm_val / fwhm_sinc if np.isfinite(fwhm_val) and fwhm_val > 0 else float("nan")
            mat_eff = float("nan")
            if np.isfinite(res_mm) and res_mm > 0:
                mat_eff = (axis_fov * 1000.0) / res_mm
            tissues.append(
                {
                    "name": tname,
                    "yB64": base64.b64encode(y_abs.tobytes()).decode("ascii"),
                    "yNormB64": base64.b64encode(y_norm.tobytes()).decode("ascii"),
                    "fwhm_mm": fwhm_val,
                    "res_mm": res_mm,
                    "effective_matrix_size": mat_eff,
                }
            )
            metrics.append(
                {
                    "axis": "XYZ"[axis],
                    "tissue_name": tname,
                    "fwhm_mm": fwhm_val,
                    "res_mm": res_mm,
                    "effective_matrix_size": mat_eff,
                }
            )
        panels.append(
            {
                "axis": "XYZ"[axis],
                "xMmB64": base64.b64encode(x_mm.tobytes()).decode("ascii"),
                "idealB64": base64.b64encode(ideal.tobytes()).decode("ascii"),
                "idealNormB64": base64.b64encode(ideal_norm.tobytes()).decode("ascii"),
                "xFullMinMm": float(x_mm[0]),
                "xFullMaxMm": float(x_mm[-1]),
                "tissues": tissues,
            }
        )

    if not panels:
        return json.dumps({"ok": False, "reason": "invalid FOV/matrix for PSF"})

    return json.dumps(
        {
            "ok": True,
            "n": n,
            "psfRes": psf_res,
            "zoomXlimMm": xlim_mm,
            "xlimMm": xlim_mm,
            "source": "trajex signal=True",
            "panels": panels,
            "metrics": metrics,
        }
    )
