"""FLASH and multi-shot TSE builders, taken from the MRzero-Core playground.

Sources (MRsources/MRzero-Core, documentation/playground_mr0):
  - mr0_FLASH_2D_seq.ipynb           -> seq_flash()
  - mr0_TSE_2D_multi_shot_seq.ipynb  -> seq_tse()

Only the signatures were flattened to plain floats (degrees, seconds); the
block structure, timing and phase cycling are unchanged so the graphs match
the ones the notebooks plot.
"""
from __future__ import annotations

import numpy as np
import pypulseq as pp


def _system():
    return pp.Opts(
        max_grad=28, grad_unit="mT/m", max_slew=150, slew_unit="T/m/s",
        rf_ringdown_time=20e-6, rf_dead_time=100e-6,
        adc_dead_time=20e-6, grad_raster_time=10e-6,
    )


def seq_flash(fov=(200e-3, 200e-3, 8e-3), Nread=64, Nphase=64, FA_deg=10.0,
              slice_thickness=8e-3, dwell=10e-5, rf_spoiling_inc=117.0,
              spoil_area_factor=1.5):
    """2D RF- and gradient-spoiled FLASH (mr0_FLASH_2D_seq.ipynb)."""
    system = _system()
    seq = pp.Sequence()
    seq.set_definition("name", "FLASH_2D")
    seq.set_definition("fov", list(fov))
    seq.set_definition("matrix", [Nread, Nphase, 1])

    rf1, _, _ = pp.make_sinc_pulse(
        flip_angle=FA_deg * np.pi / 180, duration=1e-3,
        slice_thickness=slice_thickness, apodization=0.5, time_bw_product=4,
        system=system, return_gz=True)
    gx = pp.make_trapezoid(channel="x", flat_area=Nread / fov[0],
                           flat_time=Nread * dwell, system=system)
    adc = pp.make_adc(num_samples=Nread, duration=Nread * dwell, phase_offset=0,
                      delay=gx.rise_time, system=system)
    gx_pre = pp.make_trapezoid(channel="x", area=-gx.area / 2, duration=1e-3,
                               system=system)
    gx_spoil = pp.make_trapezoid(channel="x", area=spoil_area_factor * gx.area,
                                 duration=2e-3, system=system)

    rf_phase, rf_inc = 0.0, 0.0
    phenc = np.arange(-Nphase // 2, Nphase // 2, 1) / fov[1]
    for ii in range(Nphase):
        rf1.phase_offset = rf_phase / 180 * np.pi
        adc.phase_offset = rf_phase / 180 * np.pi
        rf_inc = divmod(rf_inc + rf_spoiling_inc, 360.0)[1]
        rf_phase = divmod(rf_phase + rf_inc, 360.0)[1]

        seq.add_block(rf1)
        gp = pp.make_trapezoid(channel="y", area=phenc[ii], duration=1e-3, system=system)
        seq.add_block(gx_pre, gp)
        seq.add_block(adc, gx)
        gp = pp.make_trapezoid(channel="y", area=-phenc[ii], duration=1e-3, system=system)
        seq.add_block(gx_spoil, gp)

    return seq, {"ky": phenc, "kind": "FLASH", "FA": FA_deg}


def seq_tse(fov=(200e-3, 200e-3, 8e-3), Nread=42, Nphase=42, FA_deg=90.0,
            FA_ref_deg=120.0, TR=5.0, TE=5e-3, slice_thickness=8e-3, TI_s=0.0,
            PEtype="linear", r_spoil=2, shots=2, dumshots=0, dumref=1,
            dwell=50e-6 * 2):
    """2D multi-shot TSE (mr0_TSE_2D_multi_shot_seq.ipynb)."""
    system = _system()
    seq = pp.Sequence(system)

    rf1, gz1, gzr1 = pp.make_sinc_pulse(
        flip_angle=FA_deg * np.pi / 180, phase_offset=90 * np.pi / 180, duration=1e-3,
        slice_thickness=slice_thickness, apodization=0.5, time_bw_product=4,
        system=system, return_gz=True)
    rf2, gz2, _ = pp.make_sinc_pulse(
        flip_angle=FA_ref_deg * np.pi / 180, duration=1e-3,
        slice_thickness=slice_thickness, apodization=0.5, time_bw_product=4,
        system=system, return_gz=True)

    gx = pp.make_trapezoid(channel="x", rise_time=0.5 * dwell, flat_area=Nread / fov[0],
                           flat_time=Nread * dwell, system=system)
    adc = pp.make_adc(num_samples=Nread, duration=Nread * dwell,
                      phase_offset=90 * np.pi / 180, delay=0, system=system)
    gx_pre0 = pp.make_trapezoid(channel="x", area=+((1.0 + r_spoil) * gx.area / 2),
                                duration=1.5e-3, system=system)
    gx_prewinder = pp.make_trapezoid(channel="x", area=+(r_spoil * gx.area / 2),
                                     duration=1e-3, system=system)
    gp = pp.make_trapezoid(channel="y", area=0, duration=1e-3, system=system)
    rf_prep = pp.make_block_pulse(flip_angle=np.pi, duration=1e-3, system=system)

    if PEtype == "centric":
        phenc = np.asarray([i // 2 if i % 2 == 0 else -(i + 1) // 2
                            for i in range(Nphase)]) / fov[0]
    else:
        phenc = np.arange(-Nphase // 2, Nphase // 2) / fov[0]

    minTE2 = (pp.calc_duration(gz2) + pp.calc_duration(gx) + 2 * pp.calc_duration(gp)) / 2
    minTE2 = round(minTE2 / 10e-5) * 10e-5
    TEd = round(max(0, (TE / 2 - minTE2)) / 10e-5) * 10e-5
    TE_eff = 2 * (minTE2 + TEd)

    TRd = 0.0
    if dumshots + shots > 1:
        TRd = TR - Nphase // shots * TE_eff

    ky_order = []
    for shot in range(-dumshots, shots):
        if TI_s > 0:
            seq.add_block(rf_prep)
            seq.add_block(pp.make_delay(TI_s))
            seq.add_block(gx_pre0)

        seq.add_block(rf1, gz1)
        seq.add_block(gx_pre0, gzr1)
        seq.add_block(pp.make_delay((minTE2 + TEd) - pp.calc_duration(gz1)
                                    - pp.calc_duration(gx_pre0)))

        if shot < 0:
            phenc_dum = np.zeros(Nphase // shots + dumref)
        else:
            phenc_dum = np.concatenate([np.repeat(np.nan, dumref), phenc[shot::shots]])

        for encoding in phenc_dum:
            dum_ref_flag = 0
            if np.isnan(encoding):
                encoding, dum_ref_flag = 1e-8, 1
            gp = pp.make_trapezoid(channel="y", area=+encoding, duration=1e-3, system=system)
            gp_ = pp.make_trapezoid(channel="y", area=-encoding, duration=1e-3, system=system)

            seq.add_block(rf2, gz2)
            if TEd > 0:
                seq.add_block(pp.make_delay(TEd))
            seq.add_block(gx_prewinder, gp)
            if shot < 0 or dum_ref_flag:
                seq.add_block(gx)
            else:
                seq.add_block(adc, gx)
                ky_order.append(encoding)
            seq.add_block(gx_prewinder, gp_)
            if TEd > 0:
                seq.add_block(pp.make_delay(TEd))
        if TRd > 0:
            seq.add_block(pp.make_delay(round(float(TRd), 5)))

    seq.set_definition("name", "TSE_2D")
    seq.set_definition("fov", list(fov))
    seq.set_definition("matrix", [Nread, Nphase, 1])
    return seq, {"ky": np.asarray(ky_order), "kind": "TSE", "TE": TE_eff,
                 "FA": FA_deg, "FA_ref": FA_ref_deg, "shots": shots}
