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

import math

import numpy as np

import pypulseq as pp


def seq_gre(
    fov_xy: tuple = (220e-3, 220e-3),                  # Define FOV and resolution
    slice_thickness: float = 3e-3,        # slice
    Nread: int = 96,
    Nphase: int = 96,
    alpha: float = 4,                    # flip angle
    TR: float = 12e-3,                    # Repetition time
    TE: float = 5e-3,                     # Echo time
    dwell: float = 30e-6,                 # ADC dwell time [s]; flat_time = Nread*dwell
    rf_spoiling_inc: float = 84 ,         # RF spoiling increment
    plot: bool = False,
    write_seq: bool = False,
    seq_filename: str = 'gre_pypulseq.seq',
    paper_plot: bool = False,
):
    """
    Generate a gradient-recalled echo (GRE) MRI pulse sequence using PyPulseq.

    Parameters
    ----------
    fov_xy : float, optional
        Field of view in meters (default: 256e-3).
    Nx : int, optional
        Number of samples in the readout (default: 64).
    Ny : int, optional
        Number of phase-encoding steps (default: 64).
    alpha : float, optional
        Flip angle in degrees (default: 10).
    slice_thickness : float, optional
        Slice thickness in meters (default: 3e-3).
    TR : float, optional
        Repetition time in seconds (default: 12e-3).
    TE : float, optional
        Echo time in seconds (default: 5e-3).
    rf_spoiling_inc : float, optional
        RF spoiling increment in degrees (default: 117).
    plot : bool, optional
        If True, display a plot of the sequence (default: False).
    write_seq : bool, optional
        If True, write the sequence to file (default: False).
    seq_filename : str, optional
        Filename for output pulseq file (default: 'gre_pypulseq.seq').
    paper_plot : bool, optional
        If True, generate a paper-style plot (default: False).

    Returns
    -------
    seq : pypulseq.Sequence
        The generated PyPulseq Sequence object.
    system : pypulseq.Opts
        The sequence system/gradient limits used.

    Notes
    -----
    This function creates a basic 2D cartesian GRE sequence using PyPulseq, including
    RF excitation, slice selection, readout gradients, phase encoding, gradient spoilers,
    and optional RF spoiling, plotting, and exporting.

    Examples
    --------
    >>> seq, system = seq_gre(fov=220e-3, Nx=128, Ny=128, alpha=15)
    """

    # ======
    # SETUP
    # ======
    # Create a new sequence object

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

    # ======
    # CREATE EVENTS
    # ======
    rf, gz, _ = pp.make_sinc_pulse(
        flip_angle=alpha * math.pi / 180,
        duration=3e-3,
        slice_thickness=slice_thickness,
        apodization=0.42,
        time_bw_product=4,
        system=system,
        return_gz=True,
        delay=system.rf_dead_time,
        use='excitation',
    )
    # Define other gradients and ADC events
    delta_kx = 1 / fov_xy[0]
    delta_ky = 1 / fov_xy[1]
    # Readout defined by the ADC dwell: flat_time = Nread*dwell. Round dwell to the
    # gradient raster so flat_time is valid on both the gradient and ADC rasters (no
    # "adc dwell RASTER" timing errors); the k-step per sample stays exactly delta_kx.
    dwell = max(
        system.grad_raster_time,
        round(dwell / system.grad_raster_time) * system.grad_raster_time,
    )
    flat_time = Nread * dwell
    gx = pp.make_trapezoid(channel='x', flat_area=Nread * delta_kx, flat_time=flat_time, system=system)
    adc = pp.make_adc(num_samples=Nread, duration=gx.flat_time, delay=gx.rise_time, system=system)

    gx_pre = pp.make_trapezoid(channel='x', area=-gx.area / 2-0.5*delta_kx, duration=1e-3, system=system)
    gz_reph = pp.make_trapezoid(channel='z', area=-gz.area / 2, duration=1e-3, system=system)
    phase_areas = (np.arange(Nphase) - Nphase / 2) * delta_ky

    # gradient spoiling
    gx_spoil = pp.make_trapezoid(channel='x', area=2 * Nread * delta_kx, system=system)
    gz_spoil = pp.make_trapezoid(channel='z', area=4 / slice_thickness, system=system)

    # Calculate timing
    delay_TE = (
        math.ceil(
            (
                TE
                - (pp.calc_duration(gz, rf) - pp.calc_rf_center(rf)[0] - rf.delay)
                - pp.calc_duration(gx_pre)
                - pp.calc_duration(gx) / 2
                - pp.eps
            )
            / seq.grad_raster_time
        )
        * seq.grad_raster_time
    )
    delay_TR = (
        np.ceil(
            (TR - pp.calc_duration(gz, rf) - pp.calc_duration(gx_pre) - pp.calc_duration(gx) - delay_TE)
            / seq.grad_raster_time
        )
        * seq.grad_raster_time
    )

    assert np.all(delay_TE >= 0)
    assert np.all(delay_TR >= pp.calc_duration(gx_spoil, gz_spoil))

    rf_phase = 0
    rf_inc = 0

    # ======
    # CONSTRUCT SEQUENCE
    # ======
    # Loop over phase encodes and define sequence blocks
    for i in range(Nphase):
        rf.phase_offset = rf_phase / 180 * np.pi
        adc.phase_offset = rf_phase / 180 * np.pi
        rf_inc = divmod(rf_inc + rf_spoiling_inc, 360.0)[1]
        rf_phase = divmod(rf_phase + rf_inc, 360.0)[1]

        seq.add_block(rf, gz)
        gy_pre = pp.make_trapezoid(
            channel='y',
            area=phase_areas[i],
            duration=pp.calc_duration(gx_pre),
            system=system,
        )
        seq.add_block(gx_pre, gy_pre, gz_reph)
        seq.add_block(pp.make_delay(delay_TE))
        seq.add_block(gx, adc)
        gy_pre.amplitude = -gy_pre.amplitude
        seq.add_block(pp.make_delay(delay_TR), gx_spoil, gy_pre, gz_spoil)

    # Check whether the timing of the sequence is correct
    ok, error_report = seq.check_timing()
    if ok:
        print('Timing check passed successfully')
    else:
        print('Timing check failed. Error listing follows:')
        [print(e) for e in error_report]

    # ======
    # VISUALIZATION
    # ======
    if plot:
        if paper_plot:
            seq.paper_plot()
        else:
            seq.plot(time_range=(0.0, TR), stacked=True, show_guides=True)

    seq.calculate_kspace()

    # Very optional slow step, but useful for testing during development e.g. for the real TE, TR or for staying within
    # slew-rate limits
    rep = seq.test_report()
    print(rep)

    # Prepare the sequence output for the scanner
    seq.set_definition(key='FOV', value=[fov_xy[0], fov_xy[1], slice_thickness])
    seq.set_definition(key='Name', value='gre')

    # =========
    # WRITE .SEQ
    # =========
    if write_seq:
        seq.write(seq_filename)

    return seq


if __name__ == '__main__':
    seq = seq_gre(plot=False, paper_plot=False, write_seq=False)
