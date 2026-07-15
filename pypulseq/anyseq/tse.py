# -*- coding: utf-8 -*-
# /// script
# requires-python = ">=3.9"
# dependencies = [
#     "numpy",
#     "matplotlib",
#     "pypulseq==1.4.2.post2",
# ]
#
# [tool.anyfield]
# micropip_no_deps = ["pypulseq"]
# ///
"""2D multi-shot TSE sequence (PyPulseq).

Self-describing script: deps + config in the PEP 723 block above.
Run with ``uv run tse.py``, or just run the cell in Colab.
"""
# --- Notebook setup (Colab / Jupyter / JupyterLab / VS Code) ----------------
_ipython = globals().get('get_ipython', lambda: None)()  # detect nb
if _ipython is not None:
    _ipython.run_line_magic('pip', 'install -q numpy matplotlib pypulseq==1.4.2.post2')
# --- Notebook setup end -----------------------------------------------------

import numpy as np
import pypulseq as pp


def seq_tse_2d(
    fov: tuple[float, float, float] = (200e-3, 200e-3, 8e-3),
    n_read: int = 128,
    n_phase: int = 128,
    flip_angle_deg: float = 90,
    refocus_flip_angle_deg: float = 120,
    tr: float = 5.0,
    te: float = 5e-3,
    experiment_id: str = 'tse_2d',
    ti: float = 0.0,
    pe_order: str = 'linear',
    read_spoil: float = 2,
    phase_encoding_on: bool = True,
    readout_on: bool = True,
    shots: int = 10,
    dummy_shots: int = 1,
    dummy_ref: int = 1,
    bandwidth_per_pixel: float = 390.6,
    te_asym_ms: float = 0.0,
    plot: bool = False,
    test_report: bool = False,
    write_seq: bool = False,
    seq_filename: str = 'tse_2d.seq',
    timing_check: bool = True,
    paper_plot: bool = False,
) -> pp.Sequence:
    """Create a 2D multi-shot turbo spin-echo (TSE) sequence.

    Parameters
    ----------
    plot : bool, optional
        Plot the sequence diagram. Default is False.
    test_report : bool, optional
        Print a test report. Default is False.
    write_seq : bool, optional
        Write the sequence to a .seq file. Default is False.
    seq_filename : str, optional
        Output filename for the .seq file. Default is 'tse_2d.seq'.
    timing_check : bool, optional
        Run ``seq.check_timing()`` and print the result. Default is True.
    paper_plot : bool, optional
        Use ``seq.paper_plot()`` instead of ``seq.plot()`` when ``plot`` is True.
        Default is False.
    fov : tuple of float, optional
        Field of view in meters as ``(fov_x, fov_y, fov_z)``. For 2D sequences
        ``fov_z`` is the slice thickness. Default is ``(200e-3, 200e-3, 8e-3)``.
    n_read : int, optional
        Number of readout samples. Default is 128.
    n_phase : int, optional
        Number of phase-encoding steps. Default is 128.
    flip_angle_deg : float, optional
        Excitation flip angle in degrees. Default is 90.
    refocus_flip_angle_deg : float, optional
        Refocusing flip angle in degrees. Default is 120.
    tr : float, optional
        Repetition time in seconds. Default is 5.0.
    te : float, optional
        Echo spacing in seconds (effective TE is ``2 * (min_echo + te_delay)``).
        Default is 5e-3.
    experiment_id : str, optional
        Sequence name stored in definitions. Default is 'tse_2d'.
    ti : float, optional
        Inversion time in seconds for FLAIR; 0 disables. Default is 0.0.
    pe_order : str, optional
        Phase-encoding order: ``'linear'`` or ``'centric'``. Default is 'linear'.
    read_spoil : float, optional
        Readout spoiling factor. Default is 2.
    phase_encoding_on : bool, optional
        Enable phase-encoding gradients. Default is True.
    readout_on : bool, optional
        Enable readout gradients. Default is True.
    shots : int, optional
        Number of acquisition shots. Default is 10.
    dummy_shots : int, optional
        Extra dummy shots without ADC. Default is 1.
    dummy_ref : int, optional
        Leading dummy refocusing pulses per shot segment. Default is 1.
    bandwidth_per_pixel : float, optional
        Receiver bandwidth per pixel in Hz/pixel. ADC dwell is
        ``1 / (bandwidth_per_pixel * n_read)``, then aligned to the
        gradient and ADC rasters. Default is 390.6 (~20 µs dwell at ``n_read=128``).
    te_asym_ms : float, optional
        Extra delay after excitation before the first refocus, in milliseconds.
        Use 0 for symmetric excitation. Default is 0.0.

    Returns
    -------
    seq : pypulseq.Sequence
        The TSE sequence object.
    """
    fov_x, fov_y, fov_z = fov

    system = pp.Opts(
        max_grad=40,
        grad_unit='mT/m',
        max_slew=200,
        slew_unit='T/m/s',
        rf_ringdown_time=20e-6,
        rf_dead_time=100e-6,
        adc_dead_time=20e-6,
        grad_raster_time=10e-6,
    )

    seq = pp.Sequence(system)
    grad_raster_time = float(seq.grad_raster_time)

    te_val = float(te)
    tr_val = float(tr)
    te_asymmetry_val = float(max(0.0, te_asym_ms)) * 1e-3

    rf1, gz1, gzr1 = pp.make_sinc_pulse(
        flip_angle=np.deg2rad(flip_angle_deg),
        phase_offset=90 * np.pi / 180,
        duration=1e-3,
        slice_thickness=fov_z,
        apodization=0.5,
        time_bw_product=4,
        system=system,
        return_gz=True,
    )

    rf2, gz2, _ = pp.make_sinc_pulse(
        flip_angle=np.deg2rad(refocus_flip_angle_deg),
        duration=1e-3,
        slice_thickness=fov_z,
        apodization=0.5,
        time_bw_product=4,
        system=system,
        return_gz=True,
    )

    g_flag = (int(readout_on), int(phase_encoding_on))

    adc_dwell = 1.0 / (bandwidth_per_pixel * n_read)
    flat_time, adc_dwell = _find_gx_flat_time_on_adc_raster(
        n_read, adc_dwell, system.grad_raster_time, system.adc_raster_time,
    )
    gx = pp.make_trapezoid(
        channel='x',
        flat_area=n_read / fov_x * g_flag[0],
        flat_time=flat_time,
        system=system,
    )
    adc = pp.make_adc(
        num_samples=n_read,
        duration=gx.flat_time,
        phase_offset=90 * np.pi / 180,
        delay=gx.rise_time,
        system=system,
    )
    gx_pre0 = pp.make_trapezoid(
        channel='x', area=+((1.0 + read_spoil) * gx.area / 2), duration=1.5e-3, system=system,
    )
    gx_prewinder = pp.make_trapezoid(
        channel='x', area=+(read_spoil * gx.area / 2), duration=1e-3, system=system,
    )
    gp = pp.make_trapezoid(channel='y', area=0 / fov_y, duration=1e-3, system=system)
    rf_prep = pp.make_block_pulse(flip_angle=180 * np.pi / 180, duration=1e-3, system=system)

    if phase_encoding_on:
        if pe_order == 'centric':
            phenc = np.asarray(
                [i // 2 if i % 2 == 0 else -(i + 1) // 2 for i in range(n_phase)],
            ) / fov_y
        else:
            phenc = np.arange(-n_phase // 2, n_phase // 2) / fov_y
    else:
        phenc = np.zeros((n_phase,))

    min_echo = (
        pp.calc_duration(gz2) + pp.calc_duration(gx) + 2 * pp.calc_duration(gp)
    ) / 2
    min_echo = float(np.round(min_echo / grad_raster_time) * grad_raster_time)

    te_delay = float(np.round(max(0.0, te_val / 2 - min_echo) / grad_raster_time) * grad_raster_time)
    te_asymmetry_val = float(np.round(te_asymmetry_val / grad_raster_time) * grad_raster_time)
    te_effective = 2 * (min_echo + te_delay)

    if te_delay == 0:
        print('echo time set to minTE [ms]', te_effective * 1000)
    else:
        print('TE [ms]', te_effective * 1000)
    if te_asymmetry_val > 0:
        print('asymmetric excitation te_asym_ms [ms]', te_asymmetry_val * 1000)

    tr_delay = 0.0
    if dummy_shots + shots > 1:
        tr_delay = tr_val - (n_phase // shots) * te_val
        if tr_delay < 0.0:
            raise ValueError(
                'Not possible at this TE/TR. '
                f'minimum TR is {(n_phase // shots) * te_val:.3f} s for '
                f'{n_phase // shots} echoes at TE {te_val * 1e3:.2f} ms; '
                f'requested TR is {tr_val:.3f} s.'
            )

    for shot in range(-dummy_shots, shots):
        if ti > 0:
            seq.add_block(rf_prep)
            seq.add_block(pp.make_delay(ti))
            seq.add_block(gx_pre0)

        seq.add_block(rf1, gz1)
        seq.add_block(gx_pre0, gzr1)

        pre_ref_delay = (
            (min_echo + te_delay)
            - pp.calc_duration(gz1)
            - pp.calc_duration(gx_pre0)
            + te_asymmetry_val
        )
        if pre_ref_delay < 0.0:
            raise ValueError(
                'Not possible at this TE/TR. '
                f'pre-refocusing delay is {pre_ref_delay * 1e3:.3f} ms; '
                f'increase TE or reduce te_asym_ms.'
            )
        seq.add_block(pp.make_delay(pre_ref_delay))

        if shot < 0:
            phenc_dum = np.zeros(n_phase // shots + dummy_ref)
        else:
            phenc_dum = np.concatenate([np.repeat(np.nan, dummy_ref), phenc[shot::shots]])

        for encoding in phenc_dum:
            dum_ref_flag = 0
            if np.isnan(encoding):
                encoding = 1e-8
                dum_ref_flag = 1

            gp = pp.make_trapezoid(channel='y', area=+encoding, duration=1e-3, system=system)
            gp_ = pp.make_trapezoid(channel='y', area=-encoding, duration=1e-3, system=system)

            seq.add_block(rf2, gz2)
            seq.add_block(pp.make_delay(te_delay))
            seq.add_block(gx_prewinder, gp)

            if shot < 0 or dum_ref_flag:
                seq.add_block(gx)
            else:
                seq.add_block(adc, gx)
            seq.add_block(gx_prewinder, gp_)
            seq.add_block(pp.make_delay(te_delay))

        seq.add_block(pp.make_delay(round(tr_delay, 5)))

    if timing_check:
        ok, error_report = seq.check_timing()
        if ok:
            print('Timing check passed successfully')
        else:
            print('Timing check failed. Error listing follows:')
            [print(e) for e in error_report]

    if test_report:
        print(seq.test_report())

    if plot:
        if paper_plot:
            seq.paper_plot()
        else:
            seq.plot(stacked=True, show_guides=True)

    seq.set_definition('name', experiment_id)
    seq.set_definition('fov', [fov_x, fov_y, fov_z])
    seq.set_definition('recon_matrix', [n_read, n_phase, 1])
    seq.set_definition('te', te_effective)
    seq.set_definition('tr', tr_val)

    if write_seq:
        seq.write(seq_filename)

    return seq


def _find_gx_flat_time_on_adc_raster(
    n_readout: int,
    adc_dwell_time: float,
    grad_raster_time: float,
    adc_raster_time: float,
    max_m: int = 10000,
    tol: float = 1e-9,
) -> tuple[float, float]:
    """Return readout flat time (gradient raster) and ADC dwell (ADC raster)."""
    raster_time_ratio = (n_readout * adc_raster_time) / grad_raster_time
    start_m = int(max(np.floor(adc_dwell_time / adc_raster_time), 1))

    adc_dwell_time_smaller: float | None = None
    for m in np.arange(start_m, 1, -1):
        k = m * raster_time_ratio
        if np.isclose(k, np.round(k), atol=tol):
            adc_dwell_time_smaller = float(m * adc_raster_time)
            break

    adc_dwell_time_larger: float | None = None
    for n in range(start_m, max_m):
        j = n * raster_time_ratio
        if np.isclose(j, np.round(j), atol=tol):
            adc_dwell_time_larger = float(n * adc_raster_time)
            break

    if adc_dwell_time_larger is None and adc_dwell_time_smaller is None:
        raise ValueError('No adc_dwell_time found within search range.')

    if adc_dwell_time_smaller is None:
        adc_dwell_time = adc_dwell_time_larger
    elif adc_dwell_time_larger is None:
        adc_dwell_time = adc_dwell_time_smaller
    elif np.abs(adc_dwell_time - adc_dwell_time_smaller) < np.abs(adc_dwell_time - adc_dwell_time_larger):
        adc_dwell_time = adc_dwell_time_smaller
    else:
        adc_dwell_time = adc_dwell_time_larger

    return adc_dwell_time * n_readout, adc_dwell_time


main = seq_tse_2d


def prot_tse_2d(
    fov: tuple[float, float, float] = (200e-3, 200e-3, 8e-3),
    n_read: int = 128,
    n_phase: int = 128,
    flip_angle_deg: float = 90,
    refocus_flip_angle_deg: float = 120,
    tr: float = 5.0,
    te: float = 5e-3,
    experiment_id: str = 'tse_2d',
    ti: float = 0.0,
    pe_order: str = 'linear',
    read_spoil: float = 2,
    phase_encoding_on: bool = True,
    readout_on: bool = True,
    shots: int = 10,
    dummy_shots: int = 1,
    dummy_ref: int = 1,
    bandwidth_per_pixel: float = 390.6,
    te_asym_ms: float = 0.0,
) -> pp.Sequence:
    return seq_tse_2d(
        fov=fov,
        n_read=n_read,
        n_phase=n_phase,
        flip_angle_deg=flip_angle_deg,
        refocus_flip_angle_deg=refocus_flip_angle_deg,
        tr=tr,
        te=te,
        experiment_id=experiment_id,
        ti=ti,
        pe_order=pe_order,
        read_spoil=read_spoil,
        phase_encoding_on=phase_encoding_on,
        readout_on=readout_on,
        shots=shots,
        dummy_shots=dummy_shots,
        dummy_ref=dummy_ref,
        bandwidth_per_pixel=bandwidth_per_pixel,
        te_asym_ms=te_asym_ms,
    )


def prot_tse_2d_flair(
    fov: tuple[float, float, float] = (200e-3, 200e-3, 8e-3),
    n_read: int = 128,
    n_phase: int = 128,
    flip_angle_deg: float = 90,
    refocus_flip_angle_deg: float = 120,
    tr: float = 8.0,
    te: float = 5e-3,
    experiment_id: str = 'tse_2d',
    ti: float = 2.3,
    pe_order: str = 'linear',
    read_spoil: float = 2,
    phase_encoding_on: bool = True,
    readout_on: bool = True,
    shots: int = 10,
    dummy_shots: int = 1,
    dummy_ref: int = 1,
    bandwidth_per_pixel: float = 390.6,
    te_asym_ms: float = 0.0,
) -> pp.Sequence:
    return seq_tse_2d(
        fov=fov,
        n_read=n_read,
        n_phase=n_phase,
        flip_angle_deg=flip_angle_deg,
        refocus_flip_angle_deg=refocus_flip_angle_deg,
        tr=tr,
        te=te,
        experiment_id=experiment_id,
        ti=ti,
        pe_order=pe_order,
        read_spoil=read_spoil,
        phase_encoding_on=phase_encoding_on,
        readout_on=readout_on,
        shots=shots,
        dummy_shots=dummy_shots,
        dummy_ref=dummy_ref,
        bandwidth_per_pixel=bandwidth_per_pixel,
        te_asym_ms=te_asym_ms,
    )


def prot_tse_2d_asym_ex(
    fov: tuple[float, float, float] = (200e-3, 200e-3, 8e-3),
    n_read: int = 128,
    n_phase: int = 128,
    flip_angle_deg: float = 90,
    refocus_flip_angle_deg: float = 120,
    tr: float = 5.0,
    te: float = 5e-3,
    experiment_id: str = 'tse_2d_asym_ex',
    ti: float = 0.0,
    pe_order: str = 'linear',
    read_spoil: float = 2,
    phase_encoding_on: bool = True,
    readout_on: bool = True,
    shots: int = 10,
    dummy_shots: int = 1,
    dummy_ref: int = 1,
    bandwidth_per_pixel: float = 390.6,
    te_asym_ms: float = 0.65,
) -> pp.Sequence:
    """TSE with asymmetric excitation enabled by default (``te_asym_ms = 0.65``)."""
    return seq_tse_2d(
        fov=fov,
        n_read=n_read,
        n_phase=n_phase,
        flip_angle_deg=flip_angle_deg,
        refocus_flip_angle_deg=refocus_flip_angle_deg,
        tr=tr,
        te=te,
        experiment_id=experiment_id,
        ti=ti,
        pe_order=pe_order,
        read_spoil=read_spoil,
        phase_encoding_on=phase_encoding_on,
        readout_on=readout_on,
        shots=shots,
        dummy_shots=dummy_shots,
        dummy_ref=dummy_ref,
        bandwidth_per_pixel=bandwidth_per_pixel,
        te_asym_ms=te_asym_ms,
    )


if __name__ == '__main__':
    main(plot=False, paper_plot=False, write_seq=False)
