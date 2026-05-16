import base64
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


def _encode_xy_interleaved_f32_b64(xy: np.ndarray) -> str:
    """Little-endian float32 x,y,x,y… as base64 (compact ChartGPU bridge; avoids huge JSON nested lists)."""
    a = np.asarray(xy, dtype=np.float64)
    if a.ndim == 2 and a.shape[1] == 2:
        flat = a.astype(np.float32, copy=False).ravel()
    elif a.ndim == 1:
        flat = a.astype(np.float32, copy=False)
    else:
        flat = np.reshape(a, (-1, 2)).astype(np.float32, copy=False).ravel()
    return base64.b64encode(flat.tobytes()).decode('ascii')


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


def _segments_to_line_series_tab10_chartgpu(segments, line_width: float = 0.6):
    """One ChartGPU line per segment (tab10 by segment index); interleaved f32 via xyBase64 (no cross-segment merge)."""
    series = []
    for i, seg in enumerate(segments):
        if seg is None or len(seg) == 0:
            continue
        c = _MPL_TAB10[i % len(_MPL_TAB10)]
        arr = np.asarray(seg, dtype=np.float64)
        if arr.ndim != 2 or arr.shape[1] < 2:
            continue
        series.append(
            {
                'type': 'line',
                'xyBase64': _encode_xy_interleaved_f32_b64(arr[:, :2]),
                'style': {'color': c, 'lineWidth': line_width},
            }
        )
    return series


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

    adc_series = []
    if data['adc_times']:
        all_adc_t = np.concatenate(data['adc_times'])
        adc_xy = np.column_stack([all_adc_t, np.zeros_like(all_adc_t)]).astype(np.float64, copy=False)
        adc_series.append(
            {
                'type': 'scatter',
                'xyBase64': _encode_xy_interleaved_f32_b64(adc_xy),
                'style': {'color': adc_red},
                'symbolSize': 2,
            }
        )

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
                xy = np.asarray(pts, dtype=np.float64)
                adc_label_series.append(
                    {
                        'type': 'scatter',
                        'xyBase64': _encode_xy_interleaved_f32_b64(xy),
                        'style': {'color': lbl_color},
                        'symbolSize': 1.5,
                    }
                )

    adc_series.extend(adc_label_series)

    rf_mag_series = _segments_to_line_series_tab10_chartgpu(data['rf_mag_segments'], lw)

    rf_phase_series = _segments_to_line_series_tab10_chartgpu(data['rf_phase_segments'], lw)
    if data['adc_phases']:
        all_t = np.concatenate([t for t, _ in data['adc_phases']])
        all_p = np.concatenate([p for _, p in data['adc_phases']])
        rf_phase_series.append(
            {
                'type': 'scatter',
                'xyBase64': _encode_xy_interleaved_f32_b64(np.column_stack([all_t, all_p]).astype(np.float64, copy=False)),
                'style': {'color': phase_marker},
                'symbolSize': 0.85,
            }
        )
    if data['rf_phase_center_times']:
        rf_phase_series.append(
            {
                'type': 'scatter',
                'xyBase64': _encode_xy_interleaved_f32_b64(
                    np.column_stack(
                        [np.asarray(data['rf_phase_center_times'], dtype=np.float64), np.asarray(data['rf_phase_center_vals'], dtype=np.float64)]
                    )
                ),
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
                'series': _segments_to_line_series_tab10_chartgpu(data['grad_segments'][x], lw),
                'x': common_x,
            }
        )

    placeholder = {
        'type': 'line',
        'xyBase64': _encode_xy_interleaved_f32_b64(np.array([[x0, 0.0], [x1, 0.0]], dtype=np.float64)),
        'style': {'color': '#7f7f7f', 'lineWidth': 0.5},
    }
    return {
        'version': 3,
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


def clear_chartgpu_payload():
    """Drop exported payload on the Python side after the browser has consumed it (lower Pyodide heap)."""
    import __main__

    setattr(__main__, '_chartgpu_last_payload', None)


def _patch_calculate_kspace():
    """Monkey-patch Sequence.calculate_kspace to stash per-column times on seq._t_ktraj."""
    import pypulseq
    from pypulseq import eps as _eps

    if getattr(pypulseq.Sequence, '_kspace_t_patch_done', False):
        return

    _orig = pypulseq.Sequence.calculate_kspace

    def _patched(self, trajectory_delay=0, gradient_offset=0):
        result = _orig(self, trajectory_delay, gradient_offset)

        total_duration = sum(self.block_durations.values())
        t_excitation, _fp_excitation, t_refocusing, _ = self.rf_times()
        t_adc, _ = self.adc_times()
        gw_pp = self.get_gradients(trajectory_delay, gradient_offset)
        ng = len(gw_pp)

        tc = []
        for i in range(ng):
            if gw_pp[i] is None:
                continue
            gm = gw_pp[i].antiderivative()
            tc.append(gm.x)
            ii = np.flatnonzero(np.abs(gm.c[0, :]) > 1e-7 * self.system.max_slew)
            if ii.shape[0] == 0:
                continue
            starts = np.int64(np.floor((gm.x[ii] + _eps) / self.grad_raster_time))
            ends = np.int64(np.ceil((gm.x[ii + 1] - _eps) / self.grad_raster_time))
            lengths = ends - starts + 1
            inds = np.ones((lengths).sum())
            start_inds = np.cumsum(np.concatenate(([0], lengths[:-1])))
            inds[start_inds] = np.concatenate(([starts[0]], np.diff(starts) - lengths[:-1] + 1))
            tc.append(np.cumsum(inds) * self.grad_raster_time)
        if tc != []:
            tc = np.concatenate(tc)

        t_acc = 1e-10
        t_acc_inv = 1 / t_acc
        t_ktraj = t_acc * np.unique(
            np.round(
                t_acc_inv
                * np.array(
                    [
                        *tc,
                        0,
                        *np.asarray(t_excitation) - 2 * self.rf_raster_time,
                        *np.asarray(t_excitation) - self.rf_raster_time,
                        *t_excitation,
                        *np.asarray(t_refocusing) - self.rf_raster_time,
                        *t_refocusing,
                        *t_adc,
                        total_duration,
                    ]
                )
            )
        )
        self._t_ktraj = t_ktraj
        return result

    pypulseq.Sequence.calculate_kspace = _patched
    pypulseq.Sequence._kspace_t_patch_done = True


def ensure_kspace_cache(seq, time_range=(0, np.inf)):
    """Build __main__._kspace_cache after calculate_kspace (requires _patch_calculate_kspace)."""
    import __main__

    k_traj_adc, k_traj, _, _, t_adc = seq.calculate_kspace()
    k_traj = np.asarray(k_traj)
    n = int(k_traj.shape[1]) if k_traj.ndim >= 2 else 0
    t_ktraj = np.asarray(getattr(seq, '_t_ktraj', np.zeros(0)), dtype=np.float64)
    n_t = int(t_ktraj.size)
    len_mismatch_fixed = False
    if n > 0 and n_t != n:
        len_mismatch_fixed = True
        total_dur = float(sum(seq.block_durations.values()))
        t_ktraj = np.linspace(0.0, total_dur, n, dtype=np.float64)
    kx_g = np.asarray(k_traj[0, :], dtype=np.float64) if n > 0 and k_traj.shape[0] >= 1 else np.zeros(0)
    ky_g = np.asarray(k_traj[1, :], dtype=np.float64) if n > 0 and k_traj.shape[0] >= 2 else np.zeros(0)
    kz_g = np.asarray(k_traj[2, :], dtype=np.float64) if n > 0 and k_traj.shape[0] >= 3 else np.zeros(n, dtype=np.float64)
    ta = None
    kx_a = ky_a = kz_a = None
    if t_adc is not None:
        ta = np.asarray(t_adc, dtype=np.float64).ravel()
        if k_traj_adc is not None:
            k_traj_adc = np.asarray(k_traj_adc)
            if k_traj_adc.ndim >= 2 and k_traj_adc.shape[1] > 0:
                m = min(ta.size, int(k_traj_adc.shape[1]))
                ta = ta[:m]
                kx_a = np.asarray(k_traj_adc[0, :m], dtype=np.float64)
                if k_traj_adc.shape[0] >= 2:
                    ky_a = np.asarray(k_traj_adc[1, :m], dtype=np.float64)
                if k_traj_adc.shape[0] >= 3:
                    kz_a = np.asarray(k_traj_adc[2, :m], dtype=np.float64)
    if kz_a is None:
        kz_a = np.zeros_like(kx_a) if kx_a is not None else None
    total_duration = float(sum(seq.block_durations.values()))
    data = collect_seq_waveform_data(seq, str(), time_range, 's', 'kHz/m', 100)
    disp_lo, disp_hi = data['disp_range']
    __main__._kspace_cache = {
        't_ktraj': t_ktraj,
        'kx_grad': kx_g,
        'ky_grad': ky_g,
        'kz_grad': kz_g,
        't_adc': ta,
        'kx_adc': kx_a,
        'ky_adc': ky_a,
        'kz_adc': kz_a,
        'total_duration_s': total_duration,
        'disp_range_s': [float(disp_lo), float(disp_hi)],
        't_ktraj_len_mismatch_fixed': len_mismatch_fixed,
        'k_traj_shape': list(k_traj.shape) if k_traj.size else [],
    }


def _tolist_json_safe(arr):
    """JSON cannot encode NaN/Inf; use null so JS can skip with Number.isFinite."""
    a = np.asarray(arr, dtype=np.float64).ravel()
    return [float(x) if np.isfinite(x) else None for x in a]


def export_kspace_cache_json():
    """Export k-space cache to plain JSON lists for JS time-window filtering."""
    import __main__

    c = getattr(__main__, '_kspace_cache', None)
    if c is None:
        return json.dumps({'error': 'no _kspace_cache'})
    ta = c.get('t_adc')
    kx_a = c.get('kx_adc')
    ky_a = c.get('ky_adc')
    kz_a = c.get('kz_adc')
    if ta is None:
        ta = np.zeros(0, dtype=np.float64)
    else:
        ta = np.asarray(ta, dtype=np.float64).ravel()
    kx_a = np.asarray(kx_a, dtype=np.float64).ravel() if kx_a is not None else np.zeros(0, dtype=np.float64)
    ky_a = np.asarray(ky_a, dtype=np.float64).ravel() if ky_a is not None else np.zeros(0, dtype=np.float64)
    kz_a = np.asarray(kz_a, dtype=np.float64).ravel() if kz_a is not None else np.zeros(0, dtype=np.float64)
    m = int(min(ta.size, kx_a.size, ky_a.size))
    ta, kx_a, ky_a = ta[:m], kx_a[:m], ky_a[:m]
    kz_a = kz_a[:m] if kz_a.size >= m else np.zeros(m, dtype=np.float64)
    t_g = np.asarray(c['t_ktraj'], dtype=np.float64)
    kx_g = np.asarray(c['kx_grad'], dtype=np.float64)
    ky_g = np.asarray(c['ky_grad'], dtype=np.float64)
    kz_g = np.asarray(c.get('kz_grad', np.zeros_like(kx_g)), dtype=np.float64)
    return json.dumps(
        {
            'meta': {
                'total_duration_s': c.get('total_duration_s'),
                'disp_range_s': c.get('disp_range_s'),
                'k_traj_shape': c.get('k_traj_shape'),
                'n_adc': m,
                'n_traj': int(t_g.size),
            },
            't_adc': _tolist_json_safe(ta),
            'kx_adc': _tolist_json_safe(kx_a),
            'ky_adc': _tolist_json_safe(ky_a),
            'kz_adc': _tolist_json_safe(kz_a),
            't_ktraj': _tolist_json_safe(t_g),
            'kx_grad': _tolist_json_safe(kx_g),
            'ky_grad': _tolist_json_safe(ky_g),
            'kz_grad': _tolist_json_safe(kz_g),
        }
    )


def clear_kspace_cache():
    import __main__

    setattr(__main__, '_kspace_cache', None)


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
        max_points_per_block = 10000000
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

    _patch_calculate_kspace()

    print('Optimized seq_plot patched into Sequence.plot()')
