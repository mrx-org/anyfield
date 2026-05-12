import json
import math
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.collections as mcollections
import matplotlib.colors as mcolors
import matplotlib as mpl
from pypulseq import calc_rf_center, get_supported_labels
from pypulseq.Sequence import parula


def cumsum(*args):
    """Helper function for cumulative sum"""
    return np.cumsum([0] + list(args))


def decimate(t, y, max_pts):
    if len(t) <= max_pts:
        return t, y
    step = len(t) // max_pts
    indices = np.arange(0, len(t), step)
    return t[indices], y[indices]


def collect_seq_waveform_data(
    self,
    label: str,
    time_range,
    time_disp: str,
    grad_disp: str,
    max_points_per_block: int,
):
    """
    Walk sequence blocks and collect waveform segments (same logic as matplotlib seq_plot).
    Returns a dict of numpy structures for plotting or JSON export.
    """
    valid_time_units = ['s', 'ms', 'us']
    valid_grad_units = ['kHz/m', 'mT/m']
    valid_labels = get_supported_labels()

    t_factor = [1, 1e3, 1e6][valid_time_units.index(time_disp)]
    g_factor = [1e-3, 1e3 / self.system.gamma][valid_grad_units.index(grad_disp)]

    t0 = 0
    label_idx_to_plot = []
    label_legend_to_plot = []
    label_store = {lbl: 0 for lbl in valid_labels}
    for i, lbl in enumerate(valid_labels):
        if lbl in label.upper():
            label_idx_to_plot.append(i)
            label_legend_to_plot.append(lbl)

    rf_mag_segments, rf_phase_segments = [], []
    grad_segments = [[], [], []]
    adc_times, adc_phases, label_points = [], [], []
    rf_phase_center_times, rf_phase_center_vals = [], []

    for block_counter in self.block_events:
        block = self.get_block(block_counter)
        block_dur = self.block_durations[block_counter]

        if t0 + block_dur < time_range[0]:
            t0 += block_dur
            continue
        if t0 > time_range[1]:
            break

        block_label = getattr(block, 'label', None)
        block_adc = getattr(block, 'adc', None)
        block_rf = getattr(block, 'rf', None)

        if block_label:
            for item in block_label:
                itype = getattr(item, 'type', None)
                if itype == 'labelinc':
                    label_store[item.label] += item.value
                elif itype is not None:
                    label_store[item.label] = item.value

        if block_adc:
            adc = block_adc
            t_indices = np.linspace(0, adc.num_samples - 1, min(adc.num_samples, max_points_per_block), dtype=int)
            t = adc.delay + (t_indices + 0.5) * adc.dwell
            t_scaled = t_factor * (t0 + t)
            adc_times.append(t_scaled)

            phase_factor = np.exp(1j * adc.phase_offset) * np.exp(1j * 2 * np.pi * t * adc.freq_offset)
            adc_phases.append((t_scaled, np.angle(phase_factor)))

            if label_idx_to_plot:
                arr_label_store = list(label_store.values())
                lbl_vals = np.array([arr_label_store[i] for i in label_idx_to_plot])
                t_center = t_factor * (t0 + adc.delay + (adc.num_samples - 1) / 2 * adc.dwell)
                label_points.append((t_center, lbl_vals))

        if block_rf:
            rf = block_rf
            tc, ic = calc_rf_center(rf)
            time, signal = rf.t, rf.signal

            if abs(signal[0]) != 0 or abs(signal[-1]) != 0:
                time, signal = time.copy(), signal.copy()
                if abs(signal[0]) != 0:
                    signal = np.concatenate(([0], signal))
                    time = np.concatenate(([time[0]], time))
                    ic += 1
                if abs(signal[-1]) != 0:
                    signal = np.concatenate((signal, [0]))
                    time = np.concatenate((time, [time[-1]]))

            t_plot, s_plot = decimate(time, signal, max_points_per_block)
            rf_time_scaled = t_factor * (t0 + t_plot + rf.delay)
            rf_mag_segments.append(np.column_stack([rf_time_scaled, np.abs(s_plot)]))

            rf_phase_factor = np.exp(1j * rf.phase_offset) * np.exp(1j * 2 * math.pi * t_plot * rf.freq_offset)
            rf_phase_segments.append(np.column_stack([rf_time_scaled, np.angle(s_plot * rf_phase_factor)]))

            rf_phase_center_times.append(t_factor * (t0 + tc + rf.delay))
            idx_safe = min(ic, len(rf.signal) - 1)
            rf_phase_center_vals.append(
                np.angle(
                    rf.signal[idx_safe]
                    * np.exp(1j * rf.phase_offset)
                    * np.exp(1j * 2 * math.pi * rf.t[idx_safe] * rf.freq_offset)
                )
            )

        grads = [getattr(block, 'gx', None), getattr(block, 'gy', None), getattr(block, 'gz', None)]
        for x, grad in enumerate(grads):
            gtype = getattr(grad, 'type', None)
            if gtype == 'grad':
                tt, wf = getattr(grad, 'tt', None), getattr(grad, 'waveform', None)
                if tt is not None and wf is not None and len(tt) == len(wf):
                    tt_dec, wf_dec = decimate(tt, wf, max_points_per_block)
                    time = grad.delay + np.concatenate([[0], tt_dec, [grad.shape_dur]])
                    waveform = g_factor * np.concatenate([[grad.first], wf_dec, [grad.last]])
                else:
                    time, waveform = grad.delay + np.array([0, grad.shape_dur]), g_factor * np.array([grad.first, grad.last])

                if len(time) == len(waveform):
                    grad_segments[x].append(np.column_stack([t_factor * (t0 + time), waveform]))
            elif gtype is not None:
                time = np.array(
                    [
                        0,
                        grad.delay,
                        grad.delay + grad.rise_time,
                        grad.delay + grad.rise_time + grad.flat_time,
                        grad.delay + grad.rise_time + grad.flat_time + grad.fall_time,
                    ]
                )
                waveform = g_factor * grad.amplitude * np.array([0, 0, 1, 1, 0])
                if len(time) == len(waveform):
                    grad_segments[x].append(np.column_stack([t_factor * (t0 + time), waveform]))

        t0 += block_dur

    tr1 = float(time_range[0])
    tr2 = float(min(t0, time_range[1])) if np.isfinite(time_range[1]) else float(t0)
    disp_range = (t_factor * tr1, t_factor * tr2)
    # Ensure display x-max covers every emitted sample (same t-axis for ADC / RF / grads in ChartGPU).
    x_max_disp = float(disp_range[1])
    for segs in (rf_mag_segments, rf_phase_segments):
        for seg in segs:
            if seg is not None and len(seg) > 0:
                x_max_disp = max(x_max_disp, float(np.max(seg[:, 0])))
    for g in grad_segments:
        for seg in g:
            if seg is not None and len(seg) > 0:
                x_max_disp = max(x_max_disp, float(np.max(seg[:, 0])))
    for tarr in adc_times:
        if len(tarr) > 0:
            x_max_disp = max(x_max_disp, float(np.max(tarr)))
    for t_arr, _ in adc_phases:
        if len(t_arr) > 0:
            x_max_disp = max(x_max_disp, float(np.max(t_arr)))
    for t_center, _ in label_points:
        x_max_disp = max(x_max_disp, float(t_center))
    for tv in rf_phase_center_times:
        x_max_disp = max(x_max_disp, float(tv))
    disp_range = (float(disp_range[0]), max(float(disp_range[1]), x_max_disp))

    return {
        't_factor': t_factor,
        'g_factor': g_factor,
        't_end': float(t0),
        'time_disp': time_disp,
        'grad_disp': grad_disp,
        'disp_range': disp_range,
        'label_idx_to_plot': label_idx_to_plot,
        'label_legend_to_plot': label_legend_to_plot,
        'rf_mag_segments': rf_mag_segments,
        'rf_phase_segments': rf_phase_segments,
        'grad_segments': grad_segments,
        'adc_times': adc_times,
        'adc_phases': adc_phases,
        'label_points': label_points,
        'rf_phase_center_times': rf_phase_center_times,
        'rf_phase_center_vals': rf_phase_center_vals,
    }


def _segments_to_line_series(segments, color: str, width: float = 1.0):
    series = []
    for seg in segments:
        if seg is None or len(seg) == 0:
            continue
        series.append({'type': 'line', 'data': np.asarray(seg).tolist(), 'style': {'color': color, 'lineWidth': width}})
    return series


# Matplotlib default tab10 (CSS hex) — matches ``plot_speed='fast'`` where each ``plot()`` advances the cycle.
_MPL_TAB10 = [
    '#1f77b4',
    '#ff7f0e',
    '#2ca02c',
    '#d62728',
    '#9467bd',
    '#8c564b',
    '#e377c2',
    '#7f7f7f',
    '#bcbd22',
    '#17becf',
]


def _segments_to_line_series_tab10(segments, line_width: float = 0.6):
    """One tab10 color per segment (matplotlib fast / standard decimated plot)."""
    series = []
    for i, seg in enumerate(segments):
        if seg is None or len(seg) == 0:
            continue
        c = _MPL_TAB10[i % len(_MPL_TAB10)]
        series.append({'type': 'line', 'data': np.asarray(seg).tolist(), 'style': {'color': c, 'lineWidth': line_width}})
    return series


def build_chartgpu_payload(data, is_dark: bool):
    """Build JSON-serializable dict for browser ChartGPU from collect_seq_waveform_data output.

    Colors follow matplotlib ``plot_speed='fast'``: tab10 per RF/gradient segment, ADC ``r``,
    phase markers ``yellow``/``black`` (dark/light), label markers on ADC use parula (same as mpl).
    """
    # mpl fast: phase_marker_color = 'yellow' if is_dark else 'black'
    phase_marker = '#ffff00' if is_dark else '#000000'
    # mpl scatter ADC: c='r'
    adc_red = '#ff0000'
    lw = 0.6

    x0, x1 = data['disp_range']
    common_x = {'min': x0, 'max': x1}

    adc_scatter = []
    if data['adc_times']:
        all_adc_t = np.concatenate(data['adc_times'])
        adc_scatter = [[float(t), 0.0] for t in all_adc_t]

    adc_label_series = []
    if data['label_points'] and data['label_legend_to_plot']:
        n_lbl = len(data['label_legend_to_plot'])
        p = parula.main(n_lbl + 1)
        label_colors = p(np.arange(n_lbl))
        for label_idx, label_name in enumerate(data['label_legend_to_plot']):
            pts = []
            for t_center, lbl_vals in data['label_points']:
                if label_idx < len(lbl_vals):
                    pts.append([float(t_center), float(lbl_vals[label_idx])])
            if pts:
                rgba = np.asarray(label_colors[label_idx]).ravel()
                lbl_color = mcolors.to_hex(rgba[:3])
                adc_label_series.append(
                    {'type': 'scatter', 'data': pts, 'style': {'color': lbl_color}, 'symbolSize': 1.5}
                )

    adc_series = _segments_to_line_series([], adc_red, lw)
    if adc_scatter:
        adc_series.append({'type': 'scatter', 'data': adc_scatter, 'style': {'color': adc_red}, 'symbolSize': 2})
    adc_series.extend(adc_label_series)

    rf_mag_series = _segments_to_line_series_tab10(data['rf_mag_segments'], lw)

    rf_phase_series = _segments_to_line_series_tab10(data['rf_phase_segments'], lw)
    if data['adc_phases']:
        all_t = np.concatenate([t for t, _ in data['adc_phases']])
        all_p = np.concatenate([p for _, p in data['adc_phases']])
        rf_phase_series.append(
            {
                'type': 'scatter',
                'data': np.column_stack([all_t, all_p]).tolist(),
                'style': {'color': phase_marker},
                'symbolSize': 0.85,
            }
        )
    if data['rf_phase_center_times']:
        rf_phase_series.append(
            {
                'type': 'scatter',
                'data': np.column_stack([np.asarray(data['rf_phase_center_times']), np.asarray(data['rf_phase_center_vals'])]).tolist(),
                'style': {'color': phase_marker},
                'symbolSize': 2.25,
            }
        )

    grad_panels = []
    grad_plot_labels = ['x', 'y', 'z']
    for x in range(3):
        grad_panels.append(
            {
                'title': f'G{grad_plot_labels[x]} ({data["grad_disp"]})',
                'series': _segments_to_line_series_tab10(data['grad_segments'][x], lw),
                'x': common_x,
            }
        )

    placeholder = {'type': 'line', 'data': [[x0, 0.0], [x1, 0.0]], 'style': {'color': '#7f7f7f', 'lineWidth': 0.5}}
    return {
        'version': 1,
        'isDark': is_dark,
        'timeUnit': data['time_disp'],
        'gradUnit': data['grad_disp'],
        'xRange': [x0, x1],
        'panels': [
            {'title': 'ADC', 'series': adc_series if adc_series else [placeholder], 'x': common_x},
            {'title': 'RF mag (Hz)', 'series': rf_mag_series or [placeholder], 'x': common_x},
            {'title': 'RF/ADC ph (rad)', 'series': rf_phase_series or [placeholder], 'x': common_x},
            *grad_panels,
        ],
    }


def get_chartgpu_payload_json():
    import __main__

    p = getattr(__main__, '_chartgpu_last_payload', None)
    if p is None:
        return 'null'
    return json.dumps(p)


def seq_plot(
    self,
    label: str = str(),
    show_blocks: bool = False,
    save: bool = False,
    time_range=(0, np.inf),
    time_disp: str = 's',
    grad_disp: str = 'kHz/m',
    plot_now: bool = True,
    max_points_per_block: int = 100,
    plot_speed: str = 'chartgpu',
) -> None:
    """
    Waveform plot: Matplotlib (full / fast / faster) or ChartGPU JSON export (`plot_speed='chartgpu'`, default).
    """
    is_dark = mpl.rcParams.get('text.color') in ['white', '#e5e7eb', '#ffffff', '#e8ecff']

    use_line_collection = plot_speed == 'faster'

    if plot_speed == 'full':
        max_points_per_block = 10000000
        print('PYTHON: Using full resolution plot in single figure')
        rf_color = phase_color = None
        grad_colors = [None, None, None]
    elif plot_speed == 'faster':
        max_points_per_block = 100
        print('PYTHON: Using optimized seq_plot (LineCollection + aggressive Decimation)')
        rf_color = 'orange'
        phase_color = 'yellow' if is_dark else 'black'
        grad_colors = ['#ffb3d9', '#99ccff', '#99ff99'] if is_dark else ['#ff69b4', '#0000ff', '#00ff00']
    elif plot_speed == 'chartgpu':
        max_points_per_block = 100
        print('PYTHON: Exporting sequence waveforms for ChartGPU (no matplotlib figure)')
        rf_color = phase_color = None
        grad_colors = [None, None, None]
    else:
        max_points_per_block = 100
        print('PYTHON: Using fast seq_plot (Standard Plot + Decimation, no LineCollection)')
        rf_color = phase_color = None
        grad_colors = [None, None, None]

    valid_time_units = ['s', 'ms', 'us']
    valid_grad_units = ['kHz/m', 'mT/m']

    if not all(isinstance(x, (int, float)) for x in time_range) or len(time_range) != 2:
        raise ValueError('Invalid time range')
    if time_disp not in valid_time_units:
        raise ValueError('Unsupported time unit')
    if grad_disp not in valid_grad_units:
        raise ValueError('Unsupported gradient unit')

    data = collect_seq_waveform_data(self, label, time_range, time_disp, grad_disp, max_points_per_block)

    if plot_speed == 'chartgpu':
        import __main__

        __main__._chartgpu_last_payload = build_chartgpu_payload(data, is_dark)
        if save:
            print('PYTHON: ChartGPU export ignores save=True')
        return

    mpl.rcParams['lines.linewidth'] = 0.6
    mpl.rcParams['font.size'] = 8
    mpl.rcParams['path.simplify'] = True
    mpl.rcParams['path.simplify_threshold'] = 1.0

    fig = plt.figure(figsize=(8, 5.6))
    sp1 = fig.add_subplot(611)
    sp2 = fig.add_subplot(612, sharex=sp1)
    sp3 = fig.add_subplot(613, sharex=sp1)
    fig_subplots = [
        fig.add_subplot(614, sharex=sp1),
        fig.add_subplot(615, sharex=sp1),
        fig.add_subplot(616, sharex=sp1),
    ]

    label_idx_to_plot = data['label_idx_to_plot']
    label_legend_to_plot = data['label_legend_to_plot']
    if label_idx_to_plot:
        p = parula.main(len(label_idx_to_plot) + 1)
        label_colors_to_plot = p(np.arange(len(label_idx_to_plot)))
        cycler = mpl.cycler(color=label_colors_to_plot)
        sp1.set_prop_cycle(cycler)

    rf_mag_segments = data['rf_mag_segments']
    rf_phase_segments = data['rf_phase_segments']
    grad_segments = data['grad_segments']
    adc_times = data['adc_times']
    adc_phases = data['adc_phases']
    label_points = data['label_points']
    rf_phase_center_times = data['rf_phase_center_times']
    rf_phase_center_vals = data['rf_phase_center_vals']

    if use_line_collection:
        if rf_mag_segments:
            sp2.add_collection(mcollections.LineCollection(rf_mag_segments, colors=rf_color, linewidths=0.6))
        if rf_phase_segments:
            sp3.add_collection(mcollections.LineCollection(rf_phase_segments, colors=phase_color, linewidths=0.6))
        for x in range(3):
            if grad_segments[x]:
                fig_subplots[x].add_collection(mcollections.LineCollection(grad_segments[x], colors=grad_colors[x], linewidths=0.6))
    else:
        for seg in rf_mag_segments:
            sp2.plot(seg[:, 0], seg[:, 1], linewidth=0.6)
        for seg in rf_phase_segments:
            sp3.plot(seg[:, 0], seg[:, 1], linewidth=0.6)
        for x in range(3):
            for seg in grad_segments[x]:
                fig_subplots[x].plot(seg[:, 0], seg[:, 1], linewidth=0.6)

    if adc_times:
        all_adc_t = np.concatenate(adc_times)
        sp1.scatter(all_adc_t, np.zeros_like(all_adc_t), c='r', marker='x', s=7, linewidths=0.5)
    if adc_phases:
        all_t = np.concatenate([t for t, _ in adc_phases])
        all_p = np.concatenate([p for _, p in adc_phases])
        phase_marker_color = phase_color if use_line_collection else ('yellow' if is_dark else 'black')
        sp3.scatter(all_t, all_p, c=phase_marker_color, marker='.', s=0.2, linewidths=0)

    if label_points and label_idx_to_plot:
        label_handles = []
        for label_idx, label_name in enumerate(label_legend_to_plot):
            label_data = [(t_center, lbl_vals[label_idx]) for t_center, lbl_vals in label_points if label_idx < len(lbl_vals)]
            if label_data:
                lx, ly = zip(*label_data)
                label_handles.append(sp1.scatter(lx, ly, marker='.', s=20, label=label_name))
        if label_handles:
            sp1.legend(label_handles, label_legend_to_plot, loc='upper left')

    if rf_phase_center_times:
        rf_center_color = phase_color if use_line_collection else ('yellow' if is_dark else 'black')
        sp3.scatter(rf_phase_center_times, rf_phase_center_vals, c=rf_center_color, marker='x', s=20, linewidths=1.5)

    grad_plot_labels = ['x', 'y', 'z']
    sp1.set_ylabel('ADC')
    sp2.set_ylabel('RF mag (Hz)')
    sp3.set_ylabel('RF/ADC ph (rad)')
    for x in range(3):
        fig_subplots[x].set_ylabel(f'G{grad_plot_labels[x]} ({grad_disp})')
    fig_subplots[-1].set_xlabel(f't ({time_disp})')

    disp_range = np.array([data['disp_range'][0], data['disp_range'][1]])
    for sp in [sp1, sp2, sp3, *fig_subplots]:
        sp.set_xlim(disp_range)
        sp.grid(True, alpha=0.3)
        sp.autoscale(enable=True, axis='y')
        sp.xaxis.set_major_locator(mpl.ticker.MaxNLocator(nbins=6))
        if sp != fig_subplots[-1]:
            plt.setp(sp.get_xticklabels(), visible=False)

    fig.tight_layout()
    if save:
        fig.savefig('seq_plot.jpg')
    if plot_now:
        plt.show()


def patch_pypulseq():
    import __main__
    import sys

    __main__.seq_plot = seq_plot

    sys._pp_patch_func = patch_pypulseq

    import pypulseq as pp

    for target in [
        pp,
        sys.modules.get('pypulseq.sequence.sequence'),
        sys.modules.get('pypulseq.Sequence.Sequence'),
    ]:
        if target and hasattr(target, 'Sequence'):
            S = getattr(target, 'Sequence')
            if hasattr(S, 'plot'):
                if not hasattr(S, '_orig_plot'):
                    S._orig_plot = S.plot
                S.plot = seq_plot

    try:
        if hasattr(pp, 'Sequence'):
            if not hasattr(pp.Sequence, '_orig_plot'):
                pp.Sequence._orig_plot = pp.Sequence.plot
            pp.Sequence.plot = seq_plot
    except Exception:
        pass

    print('Optimized seq_plot patched into Sequence.plot()')
