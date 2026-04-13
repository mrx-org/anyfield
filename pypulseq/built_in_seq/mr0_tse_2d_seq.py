# -*- coding: utf-8 -*-
"""2D multi-shot TSE sequence (PyPulseq), MRzero-style."""
import numpy as np
import pypulseq as pp


def seq_TSE_2D(
    fov=(200e-3, 200e-3, 8e-3),
    Nread=42,
    Nphase=42,
    FA=90 * np.pi / 180,
    FA_ref=120 * np.pi / 180,
    TR=5.0,
    TE=5e-3,
    slice_thickness=8e-3,
    experiment_id='TSE_2D',
    system=None,
    TI_s=0,
    PEtype='linear',
    r_spoil=2,
    PE_grad_on=True,
    RO_grad_on=True,
    shots=2,
    dumshots=0,
    dumref=1,
    dwell=50e-6 * 2,
    dTE=0.0,
):
    """
    2D TSE multi-shot sequence following MRzero standard.

    Args:
        fov: tuple (fx, fy, fz) in meters; fx/fy used for read/phase, fz for slice definition.
        Nread: frequency encoding steps.
        Nphase: phase encoding steps.
        FA: float — excitation flip angle [rad].
        FA_ref: float — refocusing flip angle [rad].
        TR: float — repetition time [s].
        TE: float — echo spacing / effective TE [s].
        slice_thickness: slice thickness [m].
        experiment_id: sequence name for definitions.
        system: optional pp.Opts; default limits if None.
        TI_s: inversion time for FLAIR [s]; 0 disables.
        PEtype: 'linear' or 'centric' phase order.
        r_spoil: read spoiling factor.
        PE_grad_on / RO_grad_on: enable gradients.
        shots: number of acquisition shots.
        dumshots: extra dummy shots (no ADC).
        dumref: leading dummy refocusing pulses per shot segment.
        dwell: ADC dwell time [s].
        dTE: asymmetric excitation [s]. Extra delay after excitation before the first refocus; use 0 for symmetric
            excitation (same role as acqP.dTE / RARE dTE).

    Returns:
        pp.Sequence
    """
    if system is None:
        system = pp.Opts(
            max_grad=28, grad_unit='mT/m', max_slew=150, slew_unit='T/m/s',
            rf_ringdown_time=20e-6, rf_dead_time=100e-6,
            adc_dead_time=20e-6, grad_raster_time=10e-6
        )

    seq = pp.Sequence(system)

    FA_val = float(FA)
    FA_ref_val = float(FA_ref)
    TE_val = float(TE)
    TR_val = float(TR)

    rf1, gz1, gzr1 = pp.make_sinc_pulse(
        flip_angle=FA_val, phase_offset=90 * np.pi / 180, duration=1e-3,
        slice_thickness=slice_thickness, apodization=0.5, time_bw_product=4,
        system=system, return_gz=True)

    rf2, gz2, _ = pp.make_sinc_pulse(
        flip_angle=FA_ref_val, duration=1e-3,
        slice_thickness=slice_thickness, apodization=0.5, time_bw_product=4,
        system=system, return_gz=True)

    G_flag = (int(RO_grad_on), int(PE_grad_on))

    gx = pp.make_trapezoid(
        channel='x', rise_time=0.5 * dwell,
        flat_area=Nread / fov[0] * G_flag[0], flat_time=Nread * dwell, system=system)
    adc = pp.make_adc(
        num_samples=Nread, duration=Nread * dwell, phase_offset=90 * np.pi / 180,
        delay=0 * gx.rise_time, system=system)
    gx_pre0 = pp.make_trapezoid(
        channel='x', area=+((1.0 + r_spoil) * gx.area / 2), duration=1.5e-3, system=system)
    gx_prewinder = pp.make_trapezoid(
        channel='x', area=+(r_spoil * gx.area / 2), duration=1e-3, system=system)
    gp = pp.make_trapezoid(channel='y', area=0 / fov[1], duration=1e-3, system=system)
    rf_prep = pp.make_block_pulse(flip_angle=180 * np.pi / 180, duration=1e-3, system=system)

    if PE_grad_on:
        if PEtype == 'centric':
            phenc = np.asarray(
                [i // 2 if i % 2 == 0 else -(i + 1) // 2 for i in range(Nphase)]) / fov[1]
        else:
            phenc = np.arange(-Nphase // 2, Nphase // 2) / fov[1]
    else:
        phenc = np.zeros((Nphase,))

    minTE2 = (pp.calc_duration(gz2) + pp.calc_duration(gx) + 2 * pp.calc_duration(gp)) / 2
    minTE2 = round(minTE2 / 10e-5) * 10e-5

    TEd = round(max(0, (TE_val / 2 - minTE2)) / 10e-5) * 10e-5

    dTE_val = round(max(0.0, float(dTE)) / 10e-5) * 10e-5

    if TEd == 0:
        print('echo time set to minTE [ms]', 2 * (minTE2 + TEd) * 1000)
    else:
        print('TE [ms]', 2 * (minTE2 + TEd) * 1000)
    if dTE_val > 0:
        print('asymmetric excitation dTE [ms]', dTE_val * 1000)

    TRd = 0.0
    if dumshots + shots > 1:
        TRd = TR_val - (Nphase // shots) * TE_val

    for shot in range(-dumshots, shots):
        if TI_s > 0:
            seq.add_block(rf_prep)
            seq.add_block(pp.make_delay(TI_s))
            seq.add_block(gx_pre0)

        seq.add_block(rf1, gz1)
        seq.add_block(gx_pre0, gzr1)

        pre_ref_delay = (
            (minTE2 + TEd) - pp.calc_duration(gz1) - pp.calc_duration(gx_pre0) + dTE_val)
        seq.add_block(pp.make_delay(pre_ref_delay))

        if shot < 0:
            phenc_dum = np.zeros(Nphase // shots + dumref)
        else:
            phenc_dum = np.concatenate([np.repeat(np.nan, dumref), phenc[shot::shots]])

        for _ii, encoding in enumerate(phenc_dum):
            dum_ref_flag = 0
            if np.isnan(encoding):
                encoding = 1e-8
                dum_ref_flag = 1

            gp = pp.make_trapezoid(channel='y', area=+encoding, duration=1e-3, system=system)
            gp_ = pp.make_trapezoid(channel='y', area=-encoding, duration=1e-3, system=system)

            seq.add_block(rf2, gz2)
            seq.add_block(pp.make_delay(TEd))
            seq.add_block(gx_prewinder, gp)

            if shot < 0 or dum_ref_flag:
                seq.add_block(gx)
            else:
                seq.add_block(adc, gx)
            seq.add_block(gx_prewinder, gp_)
            seq.add_block(pp.make_delay(TEd))
        seq.add_block(pp.make_delay(round(TRd, 5)))

    seq.set_definition('name', experiment_id)
    seq.set_definition('fov', [fov[0], fov[1], fov[2]])
    seq.set_definition('matrix', [Nread, Nphase, 1])

    return seq


# Backward compatibility with Colab notebook name
seq_TSE_2D_multi_shot = seq_TSE_2D


if __name__ == '__main__':
    experiment_id = 'TSE_2D'
    fov_xy = 200e-3
    slice_thickness = 8e-3
    base_resolution = 42
    Nread = base_resolution
    Nphase = base_resolution
    TE_ms = 5
    TE = TE_ms * 1e-3
    TR = 5.0
    TI_s = 0
    FA = 90 * np.pi / 180
    FA_ref = 120 * np.pi / 180
    PEtype = 'linear'
    r_spoil = 2
    PE_grad_on = True
    RO_grad_on = True
    shots = 2
    dumshots = 0
    dumref = 1
    dwell = 50e-6 * 2

    seq = seq_TSE_2D(
        fov=(fov_xy, fov_xy, slice_thickness),
        Nread=Nread,
        Nphase=Nphase,
        FA=FA,
        FA_ref=FA_ref,
        TR=TR,
        TE=TE,
        slice_thickness=slice_thickness,
        experiment_id=experiment_id,
        TI_s=TI_s,
        PEtype=PEtype,
        r_spoil=r_spoil,
        PE_grad_on=PE_grad_on,
        RO_grad_on=RO_grad_on,
        shots=shots,
        dumshots=dumshots,
        dumref=dumref,
        dwell=dwell,
    )


def prot_TSE_2D(
    fov=(200e-3, 200e-3, 8e-3),
    Nread=42,
    Nphase=42,
    FA=90 * np.pi / 180,
    FA_ref=120 * np.pi / 180,
    TR=5.0,
    TE=5e-3,
    slice_thickness=8e-3,
    experiment_id='TSE_2D',
    system=None,
    TI_s=0,
    PEtype='linear',
    r_spoil=2,
    PE_grad_on=True,
    RO_grad_on=True,
    shots=2,
    dumshots=0,
    dumref=1,
    dwell=50e-6 * 2,
    dTE=0.0,
):
    kwargs = locals().copy()
    return seq_TSE_2D(**kwargs)


def prot_TSE_2D_asym_ex(
    fov=(200e-3, 200e-3, 8e-3),
    Nread=128,
    Nphase=128,
    FA=90 * np.pi / 180,
    FA_ref=120 * np.pi / 180,
    TR=5.0,
    TE=5e-3,
    slice_thickness=8e-3,
    experiment_id='TSE_2D_asym_ex',
    system=None,
    TI_s=0,
    PEtype='linear',
    r_spoil=2,
    PE_grad_on=True,
    RO_grad_on=True,
    shots=10,
    dumshots=0,
    dumref=1,
    dwell=50e-6 * 2,
    dTE=0.0087,
):
    """Same as prot_TSE_2D but with asymmetric excitation enabled by default (dTE = 0.0087 s)."""
    kwargs = locals().copy()
    return seq_TSE_2D(**kwargs)
