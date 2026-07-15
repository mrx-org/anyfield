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
"""2D cartesian GRE sequence (PyPulseq).

Self-describing script: deps + config in the PEP 723 block above.
Run with ``uv run gre_seq.py``, or just run the cell in Colab.
"""
# --- Notebook setup (Colab / Jupyter / JupyterLab / VS Code) ----------------
_ipython = globals().get('get_ipython', lambda: None)()  # detect nb
if _ipython is not None:
    _ipython.run_line_magic('pip', 'install -q numpy matplotlib pypulseq==1.4.2.post2')
# --- Notebook setup end -----------------------------------------------------

import numpy as np

import pypulseq as pp


def seq_gre(
    fov: tuple[float, float, float] = (220e-3, 220e-3, 3e-3),
    n_read: int = 96,
    n_phase: int = 96,
    flip_angle_deg: float = 4,
    tr: float = 12e-3,
    te: float | None = 5e-3,
    bandwidth_per_pixel: float = 347.0,
    rf_spoiling_inc: float = 84,
    experiment_id: str = 'gre',
    plot: bool = False,
    test_report: bool = False,
    write_seq: bool = False,
    seq_filename: str = 'gre_pypulseq.seq',
    timing_check: bool = True,
    paper_plot: bool = False,
) -> pp.Sequence:
    """Create a basic 2D cartesian gradient-echo (GRE) sequence.

    Parameters
    ----------
    plot : bool, optional
        Plot the sequence diagram. Default is False.
    test_report : bool, optional
        Print a test report. Default is False.
    write_seq : bool, optional
        Write the sequence to a .seq file. Default is False.
    seq_filename : str, optional
        Output filename for the .seq file. Default is 'gre_pypulseq.seq'.
    timing_check : bool, optional
        Run ``seq.check_timing()`` and print the result. Default is True.
    paper_plot : bool, optional
        Use ``seq.paper_plot()`` instead of ``seq.plot()`` when ``plot`` is True.
        Default is False.
    fov : tuple of float, optional
        Field of view in meters as ``(fov_x, fov_y, fov_z)``. For 2D sequences
        ``fov_z`` is the slice thickness. Default is ``(220e-3, 220e-3, 3e-3)``.
    n_read : int, optional
        Number of readout samples (PyPulseq ``n_x``). Default is 96.
    n_phase : int, optional
        Number of phase-encoding steps (PyPulseq ``n_y``). Default is 96.
    flip_angle_deg : float, optional
        Flip angle in degrees. Default is 4.
    tr : float, optional
        Repetition time in seconds. Default is 12e-3.
    te : float or None, optional
        Echo time in seconds. Use ``None`` for minimum TE. Default is 5e-3.
    bandwidth_per_pixel : float, optional
        Receiver bandwidth per pixel in Hz/pixel. ADC dwell is
        ``1 / (bandwidth_per_pixel * n_read)``, then aligned to the
        gradient and ADC rasters. Default is 347 (~30 µs dwell at ``n_read=96``).
    rf_spoiling_inc : float, optional
        RF spoiling increment in degrees. Default is 84.
    experiment_id : str, optional
        Sequence name stored in definitions. Default is 'gre'.

    Returns
    -------
    seq : pypulseq.Sequence
        The GRE sequence object.
    """
    fov_x, fov_y, fov_z = fov

    system = pp.Opts(
        max_grad=40,
        grad_unit='mT/m',
        max_slew=200,
        slew_unit='T/m/s',
        rf_ringdown_time=20e-6,
        rf_dead_time=100e-6,
        adc_dead_time=10e-6,
    )

    seq = pp.Sequence(system)

    rf, gz, _ = pp.make_sinc_pulse(
        flip_angle=np.deg2rad(flip_angle_deg),
        duration=3e-3,
        slice_thickness=fov_z,
        apodization=0.42,
        time_bw_product=4,
        system=system,
        return_gz=True,
        delay=system.rf_dead_time,
        use='excitation',
    )

    delta_kx = 1 / fov_x
    delta_ky = 1 / fov_y
    adc_dwell = 1.0 / (bandwidth_per_pixel * n_read)
    flat_time, adc_dwell = _find_gx_flat_time_on_adc_raster(
        n_read, adc_dwell, system.grad_raster_time, system.adc_raster_time,
    )
    gx = pp.make_trapezoid(
        channel='x', flat_area=n_read * delta_kx, flat_time=flat_time, system=system,
    )
    adc = pp.make_adc(num_samples=n_read, duration=gx.flat_time, delay=gx.rise_time, system=system)
    gx_pre = pp.make_trapezoid(
        channel='x', area=-gx.area / 2 - 0.5 * delta_kx, duration=1e-3, system=system,
    )
    gz_reph = pp.make_trapezoid(channel='z', area=-gz.area / 2, duration=1e-3, system=system)
    phase_areas = (np.arange(n_phase) - n_phase / 2) * delta_ky

    gx_spoil = pp.make_trapezoid(channel='x', area=2 * n_read * delta_kx, system=system)
    gz_spoil = pp.make_trapezoid(channel='z', area=4 / fov_z, system=system)

    min_te = float(
        (pp.calc_duration(gz, rf) - pp.calc_rf_center(rf)[0] - rf.delay)
        + pp.calc_duration(gx_pre)
        + pp.calc_duration(gx) / 2
        + pp.eps
    )
    grad_raster_time = float(seq.grad_raster_time)
    te_delay = 0.0 if te is None else (te := float(te),)[0]
   
    te_delay = float(np.ceil((te - min_te) / grad_raster_time) * grad_raster_time)
    if te_delay < 0.0:
        raise ValueError(
            'Not possible at this TE/TR. '
            f'minimum TE is {min_te * 1e3:.2f} ms (readout {float(flat_time) * 1e3:.2f} ms, '
            f'{float(bandwidth_per_pixel):.0f} Hz/px); requested TE is {te * 1e3:.2f} ms.'
        )
    te_used = min_te + te_delay

    min_tr = float(
        pp.calc_duration(gz, rf)
        + pp.calc_duration(gx_pre)
        + pp.calc_duration(gx)
        + te_delay
        + pp.calc_duration(gx_spoil, gz_spoil)
    )
    tr = float(tr)
    tr_delay = float(np.ceil((tr - min_tr) / grad_raster_time) * grad_raster_time)
    if tr_delay < 0.0:
        raise ValueError(
            'Not possible at this TE/TR. '
            f'minimum TR is {min_tr * 1e3:.2f} ms at TE {te_used * 1e3:.2f} ms; '
            f'requested TR is {tr * 1e3:.2f} ms.'
        )

    rf_phase = 0
    rf_inc = 0

    for i_phase in range(n_phase):
        rf.phase_offset = rf_phase / 180 * np.pi
        adc.phase_offset = rf_phase / 180 * np.pi
        rf_inc = divmod(rf_inc + rf_spoiling_inc, 360.0)[1]
        rf_phase = divmod(rf_phase + rf_inc, 360.0)[1]

        seq.add_block(rf, gz)
        gy_pre = pp.make_trapezoid(
            channel='y',
            area=phase_areas[i_phase],
            duration=pp.calc_duration(gx_pre),
            system=system,
        )
        seq.add_block(gx_pre, gy_pre, gz_reph)
        seq.add_block(pp.make_delay(te_delay))
        seq.add_block(gx, adc)
        gy_pre.amplitude = -gy_pre.amplitude
        seq.add_block(pp.make_delay(tr_delay), gx_spoil, gy_pre, gz_spoil)

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
            seq.plot(time_range=(0.0, tr), stacked=True, show_guides=True)

    seq.set_definition('name', experiment_id)
    seq.set_definition('fov', [fov_x, fov_y, fov_z])
    seq.set_definition('recon_matrix', [n_read, n_phase, 1])
    seq.set_definition('te', te_used)
    seq.set_definition('tr', tr)

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



main = seq_gre


if __name__ == '__main__':
    main(plot=False, paper_plot=False, write_seq=False)
