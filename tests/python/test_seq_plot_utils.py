"""Characterisation coverage for pypulseq/seq_plot_utils.py.

This is the other half of the sequence-build path: it walks a built sequence's
blocks, turns them into waveform segments, and either exports a ChartGPU payload
for JS to render or draws a matplotlib figure. It had no tests, and it is the
module a future `Agg`-plus-PNG switch will have to
change, so these tests pin **current** behaviour, quirks included. Anything that
looks wrong is marked `CHARACTERISATION:` and reported rather than fixed.

Two things about reaching it from the host.

*It cannot be imported.* `import matplotlib.pyplot`, `from pypulseq import
calc_rf_center, get_supported_labels` and `from pypulseq.Sequence import parula`
all run at module top level. matplotlib is now a real dev dependency
(`requirements-dev.txt`) and is used for real here, under the `Agg` backend.
pypulseq is deliberately *not* installed: the repo's own `pypulseq/`
directory is a namespace package, and a regular `pypulseq` on `sys.path` would win
against it and break `import pypulseq.seq_source_manager`
(see `test_seq_source_manager.py`). So the three pypulseq names are supplied by
the narrow stubs below, and every test that leans on one says so.

*The sequence is duck-typed.* `collect_seq_waveform_data` and
`ensure_kspace_cache` only ever reach for `self.system.gamma`, `block_events`,
`block_durations`, `get_block()` and `calculate_kspace()`, all via plain attribute
access. `FakeSeq` is therefore a faithful double rather than a stub of anything
under test -- no pypulseq needed for the waveform walk itself.
"""
from __future__ import annotations

import json
import math
import sys
import types
from pathlib import Path

import numpy as np
import pytest

import matplotlib

matplotlib.use("Agg")  # the interactive webagg backend needs a browser DOM.

import matplotlib as mpl  # noqa: E402
from matplotlib.colors import ListedColormap  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = REPO_ROOT / "pypulseq" / "seq_plot_utils.py"

# Verbatim from pypulseq 1.5's `get_supported_labels()`. Order matters: the
# collector indexes `label_store.values()` positionally, so `label_idx_to_plot`
# is an index into this exact tuple.
SUPPORTED_LABELS = (
    "SLC", "SEG", "REP", "AVG", "SET", "ECO", "PHS", "LIN", "PAR", "NAV", "REV",
    "SMS", "REF", "IMA", "NOISE", "PMC", "NOPOS", "NOROT", "NOSCL", "ONCE", "TRID",
)

# Distinguishable stand-in for pypulseq's parula colormap. Tests assert the
# *index mapping* against this table, never a real parula colour.
STUB_PARULA_COLORS = [
    (1.0, 0.0, 0.0, 1.0),
    (0.0, 1.0, 0.0, 1.0),
    (0.0, 0.0, 1.0, 1.0),
    (1.0, 1.0, 0.0, 1.0),
]


def _stub_calc_rf_center(rf):
    """Peak-magnitude sample, which is what pypulseq returns for the symmetric
    pulses the shipped sequences use. Only the plumbing around it is asserted."""
    index = int(np.argmax(np.abs(rf.signal)))
    return float(rf.t[index]), index


def _install_pypulseq_stubs() -> dict:
    pp = types.ModuleType("pypulseq")
    pp.__path__ = []
    pp.calc_rf_center = _stub_calc_rf_center
    pp.get_supported_labels = lambda: SUPPORTED_LABELS

    sequence = types.ModuleType("pypulseq.Sequence")
    sequence.__path__ = []
    parula = types.ModuleType("pypulseq.Sequence.parula")
    parula.main = lambda n: ListedColormap(STUB_PARULA_COLORS[:n] or STUB_PARULA_COLORS)
    sequence.parula = parula
    pp.Sequence = sequence

    names = {
        "pypulseq": pp,
        "pypulseq.Sequence": sequence,
        "pypulseq.Sequence.parula": parula,
    }
    saved = {name: sys.modules.get(name) for name in names}
    sys.modules.update(names)
    return saved


@pytest.fixture(scope="module")
def plot_utils():
    """The module, `exec`'d into a namespace the way `patchSequencePlot()` does.

    The pypulseq stubs are removed again once the module body has run: the
    resulting namespace holds direct references to `calc_rf_center`,
    `get_supported_labels` and `parula`, so nothing later depends on
    `sys.modules`. That keeps the stub from leaking into any other test module,
    whatever order the suite runs in.
    """
    saved = _install_pypulseq_stubs()
    try:
        namespace: dict = {"__name__": "seq_plot_utils"}
        code = compile(MODULE_PATH.read_text(), str(MODULE_PATH), "exec")
        exec(code, namespace)
    finally:
        for name, previous in saved.items():
            if previous is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous
    return types.SimpleNamespace(**namespace)


@pytest.fixture(autouse=True)
def restore_global_state():
    """Payload exporters write into `__main__`; snapshot `rcParams` too so a
    leak cannot poison later tests even though `seq_plot` now restores them."""
    import __main__

    watched = ("lines.linewidth", "font.size", "path.simplify", "path.simplify_threshold")
    saved_rc = {key: mpl.rcParams[key] for key in watched}
    sentinel = object()
    saved_main = {
        name: getattr(__main__, name, sentinel)
        for name in ("_chartgpu_last_payload", "_chartgpu_last_xy", "_kspace_cache")
    }
    try:
        yield
    finally:
        for key, value in saved_rc.items():
            mpl.rcParams[key] = value
        for name, value in saved_main.items():
            if value is sentinel:
                if hasattr(__main__, name):
                    delattr(__main__, name)
            else:
                setattr(__main__, name, value)
        import matplotlib.pyplot as plt

        plt.close("all")


# ---------------------------------------------------------------------------
# Sequence doubles
# ---------------------------------------------------------------------------


class Obj:
    """Attribute bag. The module reads everything with `getattr`, so this is
    exactly as much sequence as the code can observe."""

    def __init__(self, **attrs):
        self.__dict__.update(attrs)


class FakeSeq:
    def __init__(self, blocks, durations, gamma=42.576e6):
        assert len(blocks) == len(durations)
        self.system = Obj(gamma=gamma, max_slew=1.0e5)
        self._blocks = list(blocks)
        self.block_events = {i + 1: None for i in range(len(blocks))}
        self.block_durations = {i + 1: d for i, d in enumerate(durations)}
        self.grad_raster_time = 10e-6
        self.rf_raster_time = 1e-6

    def get_block(self, counter):
        return self._blocks[counter - 1]


def make_adc(num_samples=4, delay=0.0, dwell=1e-3, phase_offset=0.0, freq_offset=0.0):
    return Obj(
        num_samples=num_samples,
        delay=delay,
        dwell=dwell,
        phase_offset=phase_offset,
        freq_offset=freq_offset,
    )


def make_rf(signal, t=None, delay=0.0, phase_offset=0.0, freq_offset=0.0):
    signal = np.asarray(signal, dtype=complex)
    if t is None:
        t = np.arange(signal.size, dtype=float) * 1e-4
    return Obj(
        t=np.asarray(t, dtype=float),
        signal=signal,
        delay=delay,
        phase_offset=phase_offset,
        freq_offset=freq_offset,
    )


def make_trap(amplitude=1e5, delay=0.0, rise_time=1e-4, flat_time=1e-3, fall_time=1e-4):
    return Obj(
        type="trap",
        amplitude=amplitude,
        delay=delay,
        rise_time=rise_time,
        flat_time=flat_time,
        fall_time=fall_time,
    )


def make_arbitrary_grad(tt, waveform, delay=0.0, shape_dur=None, first=0.0, last=0.0):
    tt = np.asarray(tt, dtype=float)
    return Obj(
        type="grad",
        tt=tt,
        waveform=np.asarray(waveform, dtype=float),
        delay=delay,
        shape_dur=float(tt[-1]) if shape_dur is None else shape_dur,
        first=first,
        last=last,
    )


@pytest.fixture
def simple_seq():
    """One RF-plus-slice-select block, then one readout block with an ADC, an
    arbitrary Gx and a LIN label -- the smallest thing that lights up every
    branch of the collector at once."""
    rf_block = Obj(rf=make_rf([0.0, 1.0, 0.0]), gz=make_trap())
    readout = Obj(
        adc=make_adc(),
        gx=make_arbitrary_grad([0.0, 1e-4, 2e-4], [0.0, 1e5, 0.0]),
        label=[Obj(type="labelset", label="LIN", value=3)],
    )
    return FakeSeq([rf_block, readout], [1e-3, 5e-3])


def _decode_xy(series, xy_blob) -> np.ndarray:
    off = int(series["xyOff"])
    length = int(series["xyLen"])
    raw = memoryview(xy_blob)[off : off + length]
    return np.frombuffer(raw, dtype="<f4").reshape(-1, 2)


# ---------------------------------------------------------------------------
# Loading contract
# ---------------------------------------------------------------------------


def test_module_loads_by_exec_into_a_namespace(plot_utils):
    """`patchSequencePlot()` fetches this file as text and hands it to
    `runPythonAsync`, so it is `exec`'d into `__main__` with no package context.
    A relative import here would break the browser silently."""
    for name in ("collect_seq_waveform_data", "build_chartgpu_payload", "seq_plot"):
        assert callable(getattr(plot_utils, name))


def test_module_cannot_be_imported_on_the_host():
    """Recorded as a fact, not a wish: this is why the fixture stubs pypulseq.

    The bare import fails on the *first* missing browser-side dependency. With
    matplotlib now installed that is pypulseq, whose namespace-package form in
    this repo has no `calc_rf_center`.
    """
    import importlib

    with pytest.raises(ImportError):
        importlib.import_module("pypulseq.seq_plot_utils")


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def test_cumsum_prepends_a_zero(plot_utils):
    assert plot_utils.cumsum(1, 2, 3).tolist() == [0, 1, 3, 6]
    assert plot_utils.cumsum().tolist() == [0]


def test_decimate_passes_short_input_through_unchanged(plot_utils):
    t = np.arange(5)
    out_t, out_y = plot_utils.decimate(t, t * 2, 5)
    assert out_t is t
    assert np.array_equal(out_y, t * 2)


def test_decimate_can_return_more_points_than_asked_for(plot_utils):
    """CHARACTERISATION: the step is `len(t) // max_pts` and the stride is applied
    with `arange`, so 10 points capped at 3 come back as 4. Harmless for plotting,
    but it means `max_points_per_block` is an approximate ceiling, not a limit."""
    t = np.arange(10)
    out_t, out_y = plot_utils.decimate(t, t, 3)
    assert out_t.tolist() == [0, 3, 6, 9]
    assert out_y.tolist() == [0, 3, 6, 9]


def test_decimate_raises_when_asked_for_zero_points(plot_utils):
    """CHARACTERISATION: `len(t) // 0`. `seq_plot` only forwards a positive int,
    so 0 never reaches `decimate` from there."""
    with pytest.raises(ZeroDivisionError):
        plot_utils.decimate(np.arange(4), np.arange(4), 0)


def test_encode_xy_interleaved_round_trips_as_little_endian_float32(plot_utils):
    xy = np.array([[0.0, 1.0], [2.0, 3.0]])
    decoded = np.frombuffer(plot_utils._encode_xy_interleaved_f32(xy), dtype="<f4")
    assert decoded.tolist() == [0.0, 1.0, 2.0, 3.0]


def test_encode_xy_interleaved_flattens_a_one_dimensional_input(plot_utils):
    decoded = np.frombuffer(
        plot_utils._encode_xy_interleaved_f32(np.array([1.0, 2.0, 3.0])),
        dtype="<f4",
    )
    assert decoded.tolist() == [1.0, 2.0, 3.0]


def test_encode_xy_interleaved_reshapes_a_wider_array(plot_utils):
    decoded = np.frombuffer(plot_utils._encode_xy_interleaved_f32(np.zeros((2, 3))), dtype="<f4")
    assert decoded.size == 6


def test_encode_xy_interleaved_rejects_an_odd_element_count(plot_utils):
    with pytest.raises(ValueError, match="cannot reshape"):
        plot_utils._encode_xy_interleaved_f32(np.zeros((3, 3)))


def test_encode_xy_interleaved_loses_float64_precision(plot_utils):
    """Recorded because it is the compact-bridge trade-off the worker migration inherits: the
    payload is float32, so k-space times in seconds keep ~7 significant digits."""
    decoded = np.frombuffer(
        plot_utils._encode_xy_interleaved_f32(np.array([[1e-9, 1.0 / 3.0]])),
        dtype="<f4",
    )
    assert float(decoded[1]) != 1.0 / 3.0
    assert float(decoded[1]) == pytest.approx(1.0 / 3.0, rel=1e-6)


def test_tolist_json_safe_replaces_non_finite_values_with_none(plot_utils):
    assert plot_utils._tolist_json_safe([1.0, np.nan, np.inf, -np.inf, 2.5]) == [
        1.0,
        None,
        None,
        None,
        2.5,
    ]


def test_tolist_json_safe_flattens_and_produces_valid_json(plot_utils):
    values = plot_utils._tolist_json_safe(np.array([[1.0, np.nan], [3.0, 4.0]]))
    assert values == [1.0, None, 3.0, 4.0]
    assert json.loads(json.dumps(values)) == values


# ---------------------------------------------------------------------------
# Segment-to-series conversion
# ---------------------------------------------------------------------------


def test_segments_to_line_series_emits_plain_nested_lists(plot_utils):
    series = plot_utils._segments_to_line_series([np.array([[0.0, 1.0], [2.0, 3.0]])], "#abcdef", 2.0)
    assert series == [
        {
            "type": "line",
            "data": [[0.0, 1.0], [2.0, 3.0]],
            "style": {"color": "#abcdef", "lineWidth": 2.0},
        }
    ]


@pytest.mark.parametrize("empty", [None, [], np.zeros((0, 2))])
def test_segments_to_line_series_skips_empty_segments(plot_utils, empty):
    assert plot_utils._segments_to_line_series([empty], "#000000") == []


def test_segments_to_line_series_tab10_cycles_colours_by_index(plot_utils):
    segments = [np.array([[float(i), 0.0]]) for i in range(11)]
    series = plot_utils._segments_to_line_series_tab10(segments)
    assert series[0]["style"]["color"] == "#1f77b4"
    assert series[10]["style"]["color"] == "#1f77b4"
    assert series[1]["style"]["color"] == "#ff7f0e"


def test_segments_to_line_series_tab10_chartgpu_keeps_the_colour_index_of_skipped_segments(
    plot_utils,
):
    """Deliberate, and worth pinning: the colour index is the position in the
    original list, so a dropped segment still consumes its tab10 slot. That is
    what keeps ChartGPU's colours matching `plot_speed='fast'`, where every
    `plot()` call advances matplotlib's own cycle including the empty ones."""
    segments = [np.zeros((0, 2)), np.array([[0.0, 0.0], [1.0, 1.0]])]
    series = plot_utils._segments_to_line_series_tab10_chartgpu(segments)
    assert len(series) == 1
    assert series[0]["style"]["color"] == "#ff7f0e"


def test_segments_to_line_series_tab10_chartgpu_drops_a_one_dimensional_segment(plot_utils):
    """CHARACTERISATION: the ChartGPU variant guards on `ndim != 2 or shape[1] < 2`
    and the matplotlib variant does not, so the same malformed segment is silently
    dropped from the payload but still handed to `data` in the mpl path."""
    segment = np.array([1.0, 2.0])
    assert plot_utils._segments_to_line_series_tab10_chartgpu([segment]) == []
    assert plot_utils._segments_to_line_series_tab10([segment])[0]["data"] == [1.0, 2.0]


# ---------------------------------------------------------------------------
# collect_seq_waveform_data -- the block walk
# ---------------------------------------------------------------------------


def test_collect_returns_the_documented_key_set(plot_utils, simple_seq):
    data = plot_utils.collect_seq_waveform_data(simple_seq, "", (0, np.inf), "s", "kHz/m", 100)
    assert set(data) == {
        "t_factor",
        "g_factor",
        "t_end",
        "time_disp",
        "grad_disp",
        "disp_range",
        "label_idx_to_plot",
        "label_legend_to_plot",
        "rf_mag_segments",
        "rf_phase_segments",
        "grad_segments",
        "adc_times",
        "adc_phases",
        "label_points",
        "rf_phase_center_times",
        "rf_phase_center_vals",
    }
    assert data["t_end"] == pytest.approx(6e-3)
    assert data["disp_range"] == (0.0, pytest.approx(6e-3))
    assert len(data["grad_segments"]) == 3


def test_collect_scales_time_and_gradients_by_the_display_units(plot_utils, simple_seq):
    ms = plot_utils.collect_seq_waveform_data(simple_seq, "", (0, np.inf), "ms", "kHz/m", 100)
    assert ms["t_factor"] == 1e3
    assert ms["g_factor"] == 1e-3
    assert ms["t_end"] == pytest.approx(6e-3), "t_end stays in seconds, unscaled"
    assert ms["disp_range"][1] == pytest.approx(6.0)

    mt = plot_utils.collect_seq_waveform_data(simple_seq, "", (0, np.inf), "us", "mT/m", 100)
    assert mt["t_factor"] == 1e6
    assert mt["g_factor"] == pytest.approx(1e3 / simple_seq.system.gamma)


def test_collect_requires_system_gamma_even_for_khz_per_metre(plot_utils, simple_seq):
    """CHARACTERISATION: `g_factor` is selected by indexing a two-element list, so
    `1e3 / self.system.gamma` is evaluated whichever unit was asked for. A leaner
    sequence proxy sent across a worker boundary has to carry `system.gamma` even
    in the default `kHz/m` mode, where the value is discarded."""
    del simple_seq.system.gamma
    with pytest.raises(AttributeError, match="gamma"):
        plot_utils.collect_seq_waveform_data(simple_seq, "", (0, np.inf), "s", "kHz/m", 100)


@pytest.mark.parametrize("bad_unit", ["ns", "S", ""])
def test_collect_rejects_an_unknown_time_unit_with_a_bare_value_error(
    plot_utils, simple_seq, bad_unit
):
    """`seq_plot` validates units before calling this, but `ensure_kspace_cache`
    and any direct caller do not, and `list.index` raises without saying what
    was wrong."""
    with pytest.raises(ValueError, match="is not in list"):
        plot_utils.collect_seq_waveform_data(simple_seq, "", (0, np.inf), bad_unit, "kHz/m", 100)


def test_collect_fails_on_a_null_label(plot_utils, simple_seq):
    """CHARACTERISATION -- a JS-boundary shape.

    `label` is used as `label.upper()`, so `None` (and `pyodide.ffi.JsNull`,
    which is likewise not a string) raises AttributeError from inside the block
    walk rather than being rejected up front. `seq_plot` defaults it to `str()`
    and every call site in the tree passes a string, so this is reachable only
    if a worker RPC forwards an absent label as null.
    """
    with pytest.raises(AttributeError, match="'NoneType' object has no attribute 'upper'"):
        plot_utils.collect_seq_waveform_data(simple_seq, None, (0, np.inf), "s", "kHz/m", 100)


def test_collect_matches_labels_by_substring_and_ignores_case(plot_utils, simple_seq):
    """The label argument is a free-text haystack: every supported label that is a
    *substring* of `label.upper()` is plotted. That is what makes the comma-joined
    form `'LIN,SLC'` work, and it is why indices come back in supported-label
    order rather than in the order asked for."""
    data = plot_utils.collect_seq_waveform_data(simple_seq, "lin,slc", (0, np.inf), "s", "kHz/m", 100)
    assert data["label_legend_to_plot"] == ["SLC", "LIN"]
    assert data["label_idx_to_plot"] == [
        SUPPORTED_LABELS.index("SLC"),
        SUPPORTED_LABELS.index("LIN"),
    ]


def test_collect_matches_a_label_hidden_inside_an_unrelated_word(plot_utils, simple_seq):
    """CHARACTERISATION: the substring rule has no word boundaries, so asking for
    `'REFERENCE'` silently enables the `REF` label."""
    data = plot_utils.collect_seq_waveform_data(
        simple_seq, "reference", (0, np.inf), "s", "kHz/m", 100
    )
    assert data["label_legend_to_plot"] == ["REF"]


def test_collect_plots_no_labels_for_an_empty_label_string(plot_utils, simple_seq):
    data = plot_utils.collect_seq_waveform_data(simple_seq, "", (0, np.inf), "s", "kHz/m", 100)
    assert data["label_idx_to_plot"] == []
    assert data["label_points"] == []


def test_collect_tracks_labelset_and_labelinc_across_blocks(plot_utils):
    adc = make_adc(num_samples=1, dwell=1e-4)
    blocks = [
        Obj(adc=adc, label=[Obj(type="labelset", label="LIN", value=5)]),
        Obj(adc=adc, label=[Obj(type="labelinc", label="LIN", value=2)]),
        Obj(adc=adc, label=[Obj(type="labelinc", label="LIN", value=2)]),
    ]
    seq = FakeSeq(blocks, [1e-3, 1e-3, 1e-3])
    data = plot_utils.collect_seq_waveform_data(seq, "LIN", (0, np.inf), "s", "kHz/m", 100)
    assert [int(vals[0]) for _, vals in data["label_points"]] == [5, 7, 9]


def test_collect_treats_an_unsupported_label_asymmetrically(plot_utils):
    """CHARACTERISATION: `label_store` is pre-seeded from `get_supported_labels()`
    and then indexed directly. `labelset` *assigns*, so an unsupported label name
    is silently accepted as a new key; `labelinc` does `+=` and raises KeyError.
    So the same unknown label either works or aborts the whole plot depending on
    which of the two block-label types carried it."""
    def seq_with(label_type):
        block = Obj(
            adc=make_adc(num_samples=1),
            label=[Obj(type=label_type, label="NOPE", value=1)],
        )
        return FakeSeq([block], [1e-3])

    data = plot_utils.collect_seq_waveform_data(
        seq_with("labelset"), "LIN", (0, np.inf), "s", "kHz/m", 100
    )
    assert data["label_legend_to_plot"] == ["LIN"]

    with pytest.raises(KeyError, match="NOPE"):
        plot_utils.collect_seq_waveform_data(
            seq_with("labelinc"), "LIN", (0, np.inf), "s", "kHz/m", 100
        )


def test_collect_ignores_a_label_item_without_a_type(plot_utils):
    block = Obj(adc=make_adc(num_samples=1), label=[Obj(label="LIN", value=9)])
    data = plot_utils.collect_seq_waveform_data(
        FakeSeq([block], [1e-3]), "LIN", (0, np.inf), "s", "kHz/m", 100
    )
    assert [int(vals[0]) for _, vals in data["label_points"]] == [0]


def test_collect_places_adc_samples_at_dwell_centres(plot_utils):
    seq = FakeSeq([Obj(adc=make_adc(num_samples=4, delay=0.0, dwell=1e-3))], [4e-3])
    data = plot_utils.collect_seq_waveform_data(seq, "", (0, np.inf), "s", "kHz/m", 100)
    assert data["adc_times"][0].tolist() == pytest.approx([0.5e-3, 1.5e-3, 2.5e-3, 3.5e-3])


def test_collect_handles_an_adc_with_no_samples(plot_utils):
    seq = FakeSeq([Obj(adc=make_adc(num_samples=0))], [1e-3])
    data = plot_utils.collect_seq_waveform_data(seq, "", (0, np.inf), "s", "kHz/m", 100)
    assert data["adc_times"][0].size == 0
    assert data["adc_phases"][0][0].size == 0


def test_collect_reports_adc_phase_from_the_offsets(plot_utils):
    adc = make_adc(num_samples=1, dwell=1e-3, phase_offset=math.pi / 2, freq_offset=0.0)
    seq = FakeSeq([Obj(adc=adc)], [1e-3])
    data = plot_utils.collect_seq_waveform_data(seq, "", (0, np.inf), "s", "kHz/m", 100)
    _times, phases = data["adc_phases"][0]
    assert phases.tolist() == pytest.approx([math.pi / 2])


def test_collect_expands_a_trapezoid_to_five_points(plot_utils):
    trap = make_trap(amplitude=1e5, delay=1e-4, rise_time=1e-4, flat_time=1e-3, fall_time=2e-4)
    seq = FakeSeq([Obj(gy=trap)], [2e-3])
    data = plot_utils.collect_seq_waveform_data(seq, "", (0, np.inf), "s", "kHz/m", 100)
    segment = data["grad_segments"][1][0]
    assert segment[:, 0].tolist() == pytest.approx([0.0, 1e-4, 2e-4, 1.2e-3, 1.4e-3])
    assert segment[:, 1].tolist() == pytest.approx([0.0, 0.0, 100.0, 100.0, 0.0])


def test_collect_brackets_an_arbitrary_gradient_with_first_and_last(plot_utils):
    grad = make_arbitrary_grad([0.0, 1e-4, 2e-4], [0.0, 1e5, 0.0], first=-1e4, last=2e4)
    seq = FakeSeq([Obj(gz=grad)], [1e-3])
    data = plot_utils.collect_seq_waveform_data(seq, "", (0, np.inf), "s", "kHz/m", 100)
    segment = data["grad_segments"][2][0]
    assert segment[:, 0].tolist() == pytest.approx([0.0, 0.0, 1e-4, 2e-4, 2e-4])
    assert segment[:, 1].tolist() == pytest.approx([-10.0, 0.0, 100.0, 0.0, 20.0])


def test_collect_falls_back_to_two_points_when_the_waveform_length_disagrees(plot_utils):
    """A `grad`-type gradient whose `tt` and `waveform` lengths differ degrades to
    a straight first-to-last line rather than raising."""
    grad = make_arbitrary_grad([0.0, 1e-4, 2e-4], [0.0, 1e5], shape_dur=2e-4, first=0.0, last=5e4)
    seq = FakeSeq([Obj(gx=grad)], [1e-3])
    data = plot_utils.collect_seq_waveform_data(seq, "", (0, np.inf), "s", "kHz/m", 100)
    segment = data["grad_segments"][0][0]
    assert segment[:, 0].tolist() == pytest.approx([0.0, 2e-4])
    assert segment[:, 1].tolist() == pytest.approx([0.0, 50.0])


def test_collect_ignores_a_gradient_with_no_type(plot_utils):
    seq = FakeSeq([Obj(gx=Obj(amplitude=1e5))], [1e-3])
    data = plot_utils.collect_seq_waveform_data(seq, "", (0, np.inf), "s", "kHz/m", 100)
    assert data["grad_segments"] == [[], [], []]


def test_collect_pads_an_rf_pulse_that_does_not_start_or_end_at_zero(plot_utils):
    rf = make_rf([1.0, 2.0, 1.0])
    seq = FakeSeq([Obj(rf=rf)], [1e-3])
    data = plot_utils.collect_seq_waveform_data(seq, "", (0, np.inf), "s", "kHz/m", 100)
    magnitudes = data["rf_mag_segments"][0][:, 1]
    assert magnitudes.tolist() == pytest.approx([0.0, 1.0, 2.0, 1.0, 0.0])
    assert rf.signal.size == 3, "the caller's rf must not be mutated"


def test_collect_leaves_an_already_zero_terminated_rf_pulse_alone(plot_utils):
    seq = FakeSeq([Obj(rf=make_rf([0.0, 1.0, 0.0]))], [1e-3])
    data = plot_utils.collect_seq_waveform_data(seq, "", (0, np.inf), "s", "kHz/m", 100)
    assert data["rf_mag_segments"][0][:, 1].tolist() == pytest.approx([0.0, 1.0, 0.0])


def test_collect_reads_the_rf_phase_centre_at_the_peak_after_padding(plot_utils):
    """Phase-centre index stays on the original pulse after plot-only zero-padding.

    Prepending a leading zero used to bump `ic` as if it indexed the padded
    array, then the marker still read `rf.signal[ic]` (unpadded), so the value
    came from one sample past the peak. The peak here is the imaginary sample
    at index 1 (phase pi/2); the following real sample is phase 0.
    """
    rf = make_rf([0.5, 1.0j, 0.2, 0.0])
    seq = FakeSeq([Obj(rf=rf)], [1e-3])
    data = plot_utils.collect_seq_waveform_data(seq, "", (0, np.inf), "s", "kHz/m", 100)
    assert data["rf_phase_center_vals"] == pytest.approx([math.pi / 2])
    assert np.angle(rf.signal[1]) == pytest.approx(math.pi / 2), "the peak's own phase"


def test_collect_offsets_rf_by_its_delay(plot_utils):
    seq = FakeSeq([Obj(rf=make_rf([0.0, 1.0, 0.0], delay=5e-4))], [2e-3])
    data = plot_utils.collect_seq_waveform_data(seq, "", (0, np.inf), "s", "kHz/m", 100)
    assert data["rf_mag_segments"][0][:, 0].tolist() == pytest.approx([5e-4, 6e-4, 7e-4])
    assert data["rf_phase_center_times"] == pytest.approx([6e-4])


def test_collect_skips_blocks_before_the_window_but_keeps_the_clock(plot_utils):
    """Blocks are dropped only when they end *strictly* before the window starts,
    so the block whose end coincides with the start boundary is still emitted --
    which is why samples before `time_range[0]` show up in the payload."""
    blocks = [Obj(adc=make_adc(num_samples=1, dwell=1e-4)) for _ in range(3)]
    seq = FakeSeq(blocks, [1e-3, 1e-3, 1e-3])
    data = plot_utils.collect_seq_waveform_data(seq, "", (2e-3, np.inf), "s", "kHz/m", 100)
    assert [float(t[0]) for t in data["adc_times"]] == pytest.approx([1.05e-3, 2.05e-3])
    assert data["t_end"] == pytest.approx(3e-3), "t_end is the full sequence duration"


def test_collect_stops_at_the_end_of_the_window(plot_utils):
    blocks = [Obj(adc=make_adc(num_samples=1, dwell=1e-4)) for _ in range(3)]
    seq = FakeSeq(blocks, [1e-3, 1e-3, 1e-3])
    data = plot_utils.collect_seq_waveform_data(seq, "", (0, 1.5e-3), "s", "kHz/m", 100)
    assert len(data["adc_times"]) == 2, "the block containing t=1.5ms is still emitted whole"
    assert data["t_end"] == pytest.approx(2e-3), "the walk stopped early, so t_end is partial"
    assert data["disp_range"] == (0.0, pytest.approx(1.5e-3))


def test_collect_widens_disp_range_to_cover_every_emitted_sample(plot_utils):
    """The reason the payload's x-range is not just the requested window: ADC, RF
    and gradients share one t-axis in ChartGPU, so samples emitted past the
    window edge would be clipped out of view."""
    seq = FakeSeq([Obj(adc=make_adc(num_samples=4, dwell=1e-3))], [4e-3])
    data = plot_utils.collect_seq_waveform_data(seq, "", (0, 1e-3), "s", "kHz/m", 100)
    assert data["disp_range"][1] == pytest.approx(3.5e-3)


def test_collect_handles_an_empty_sequence(plot_utils):
    data = plot_utils.collect_seq_waveform_data(FakeSeq([], []), "", (0, np.inf), "s", "kHz/m", 100)
    assert data["t_end"] == 0.0
    assert data["disp_range"] == (0.0, 0.0)
    assert data["rf_mag_segments"] == []
    assert data["adc_times"] == []


def test_collect_handles_a_block_with_nothing_in_it(plot_utils):
    data = plot_utils.collect_seq_waveform_data(
        FakeSeq([Obj()], [1e-3]), "", (0, np.inf), "s", "kHz/m", 100
    )
    assert data["t_end"] == pytest.approx(1e-3)
    assert data["grad_segments"] == [[], [], []]


# ---------------------------------------------------------------------------
# build_chartgpu_payload -- the JSON that crosses to ChartGPU
# ---------------------------------------------------------------------------


def test_build_chartgpu_payload_shape_and_panel_order(plot_utils, simple_seq):
    data = plot_utils.collect_seq_waveform_data(simple_seq, "", (0, np.inf), "s", "kHz/m", 100)
    payload, _xy_blob = plot_utils.build_chartgpu_payload(data, False)
    assert payload["version"] == 4
    assert payload["isDark"] is False
    assert payload["timeUnit"] == "s"
    assert payload["gradUnit"] == "kHz/m"
    assert payload["xRange"] == [data["disp_range"][0], data["disp_range"][1]]
    assert [panel["title"] for panel in payload["panels"]] == [
        "ADC",
        "RF mag (Hz)",
        "RF/ADC ph (rad)",
        "Gx (kHz/m)",
        "Gy (kHz/m)",
        "Gz (kHz/m)",
    ]
    for panel in payload["panels"]:
        assert panel["x"] == {"min": payload["xRange"][0], "max": payload["xRange"][1]}


def test_build_chartgpu_payload_is_json_serialisable(plot_utils, simple_seq):
    data = plot_utils.collect_seq_waveform_data(simple_seq, "LIN", (0, np.inf), "s", "kHz/m", 100)
    payload, xy_blob = plot_utils.build_chartgpu_payload(data, True)
    assert json.loads(json.dumps(payload))["version"] == 4
    assert isinstance(xy_blob, (bytes, bytearray))
    assert len(xy_blob) % 4 == 0
    assert "xyBase64" not in json.dumps(payload)


def test_build_chartgpu_payload_gives_every_empty_panel_a_placeholder(plot_utils):
    """The grey placeholder line exists so ChartGPU has something to scale an
    empty panel against. ADC, RF magnitude, RF phase, and the three gradient
    axes all get it via `series or [placeholder]` when they have no series.
    """
    data = plot_utils.collect_seq_waveform_data(
        FakeSeq([Obj()], [1e-3]), "", (0, np.inf), "s", "kHz/m", 100
    )
    payload, xy_blob = plot_utils.build_chartgpu_payload(data, False)

    assert len(payload["panels"]) == 6
    for panel in payload["panels"]:
        assert len(panel["series"]) == 1
        assert panel["series"][0]["style"] == {"color": "#7f7f7f", "lineWidth": 0.5}
        # A flat line spanning the panel's x-range.
        corners = _decode_xy(panel["series"][0], xy_blob)
        assert corners[:, 1].tolist() == [0.0, 0.0]
        assert corners[:, 0].tolist() == pytest.approx([0.0, 1e-3], rel=1e-6)


def test_build_chartgpu_payload_puts_adc_marks_on_the_zero_line(plot_utils):
    seq = FakeSeq([Obj(adc=make_adc(num_samples=2, dwell=1e-3))], [2e-3])
    data = plot_utils.collect_seq_waveform_data(seq, "", (0, np.inf), "s", "kHz/m", 100)
    payload, xy_blob = plot_utils.build_chartgpu_payload(data, False)
    adc = payload["panels"][0]["series"][0]
    assert adc["type"] == "scatter"
    assert adc["style"] == {"color": "#ff0000"}
    assert adc["symbolSize"] == 2
    assert "xyBase64" not in adc
    assert adc["xyLen"] % 4 == 0
    assert adc["xyOff"] % 4 == 0
    assert _decode_xy(adc, xy_blob)[:, 1].tolist() == [0.0, 0.0]


@pytest.mark.parametrize("is_dark, expected", [(True, "#ffff00"), (False, "#000000")])
def test_build_chartgpu_payload_switches_phase_marker_colour_with_the_theme(
    plot_utils, simple_seq, is_dark, expected
):
    data = plot_utils.collect_seq_waveform_data(simple_seq, "", (0, np.inf), "s", "kHz/m", 100)
    payload, _xy_blob = plot_utils.build_chartgpu_payload(data, is_dark)
    phase_series = payload["panels"][2]["series"]
    assert [s["style"]["color"] for s in phase_series if s["type"] == "scatter"] == [
        expected,
        expected,
    ]


def test_build_chartgpu_payload_emits_one_label_scatter_per_requested_label(plot_utils):
    """Colour comes from `parula.main(n + 1)` indexed by label position. The
    palette here is the stub's, so what this pins is the index mapping."""
    adc = make_adc(num_samples=1, dwell=1e-4)
    label = [Obj(type="labelset", label="LIN", value=3), Obj(type="labelset", label="SLC", value=7)]
    seq = FakeSeq([Obj(adc=adc, label=label)], [1e-3])
    data = plot_utils.collect_seq_waveform_data(seq, "LIN,SLC", (0, np.inf), "s", "kHz/m", 100)
    payload, xy_blob = plot_utils.build_chartgpu_payload(data, False)

    label_series = payload["panels"][0]["series"][1:]
    assert len(label_series) == 2
    assert [s["symbolSize"] for s in label_series] == [1.5, 1.5]
    assert _decode_xy(label_series[0], xy_blob)[0, 1] == pytest.approx(7.0), "SLC sorts first"
    assert _decode_xy(label_series[1], xy_blob)[0, 1] == pytest.approx(3.0)
    assert [s["style"]["color"] for s in label_series] == [
        mpl.colors.to_hex(STUB_PARULA_COLORS[0][:3]),
        mpl.colors.to_hex(STUB_PARULA_COLORS[1][:3]),
    ]


def test_build_chartgpu_payload_needs_both_label_points_and_a_legend(plot_utils, simple_seq):
    """Label scatters are gated on `label_points` *and* `label_legend_to_plot`, so
    label values collected without a legend produce no series at all -- only the
    red ADC marks remain on the ADC panel."""
    data = plot_utils.collect_seq_waveform_data(simple_seq, "", (0, np.inf), "s", "kHz/m", 100)
    data["label_points"] = [(1.0, np.array([2.0]))]
    assert data["label_legend_to_plot"] == []
    payload, _xy_blob = plot_utils.build_chartgpu_payload(data, False)
    assert [s["style"]["color"] for s in payload["panels"][0]["series"]] == ["#ff0000"]


def test_build_chartgpu_payload_carries_rf_phase_centre_markers(plot_utils):
    seq = FakeSeq([Obj(rf=make_rf([0.0, 1.0, 0.0]))], [1e-3])
    data = plot_utils.collect_seq_waveform_data(seq, "", (0, np.inf), "s", "kHz/m", 100)
    payload, xy_blob = plot_utils.build_chartgpu_payload(data, False)
    centres = [s for s in payload["panels"][2]["series"] if s.get("symbolSize") == 2.25]
    assert len(centres) == 1
    assert _decode_xy(centres[0], xy_blob).shape == (1, 2)


def test_build_chartgpu_payload_uses_the_gradient_unit_in_panel_titles(plot_utils, simple_seq):
    data = plot_utils.collect_seq_waveform_data(simple_seq, "", (0, np.inf), "s", "mT/m", 100)
    payload, _xy_blob = plot_utils.build_chartgpu_payload(data, False)
    assert [p["title"] for p in payload["panels"][3:]] == [
        "Gx (mT/m)",
        "Gy (mT/m)",
        "Gz (mT/m)",
    ]


# ---------------------------------------------------------------------------
# The __main__ payload handoff
# ---------------------------------------------------------------------------


def test_get_chartgpu_payload_json_returns_the_string_null_when_unset(plot_utils):
    """`seq_plot.js` feeds this straight to `JSON.parse`, so the absent case has
    to be the four characters `null` rather than an empty string."""
    import __main__

    __main__._chartgpu_last_payload = None
    assert plot_utils.get_chartgpu_payload_json() == "null"
    del __main__._chartgpu_last_payload
    assert plot_utils.get_chartgpu_payload_json() == "null"


def test_get_chartgpu_payload_json_serialises_the_stored_payload(plot_utils):
    import __main__

    __main__._chartgpu_last_payload = {"version": 3, "panels": []}
    assert json.loads(plot_utils.get_chartgpu_payload_json()) == {"version": 3, "panels": []}


def test_clear_chartgpu_payload_sets_none_rather_than_deleting(plot_utils):
    import __main__

    __main__._chartgpu_last_payload = {"version": 4}
    __main__._chartgpu_last_xy = b"\x00\x01"
    plot_utils.clear_chartgpu_payload()
    assert __main__._chartgpu_last_payload is None
    assert __main__._chartgpu_last_xy is None


def test_get_chartgpu_payload_xy_returns_empty_bytes_when_unset(plot_utils):
    import __main__

    __main__._chartgpu_last_xy = None
    assert plot_utils.get_chartgpu_payload_xy() == b""
    del __main__._chartgpu_last_xy
    assert plot_utils.get_chartgpu_payload_xy() == b""


def test_get_chartgpu_payload_xy_returns_the_stored_blob(plot_utils):
    import __main__

    __main__._chartgpu_last_xy = b"\x00\x01\x02\x03"
    assert plot_utils.get_chartgpu_payload_xy() == b"\x00\x01\x02\x03"


def test_build_chartgpu_payload_offsets_round_trip_to_interleaved_f32(plot_utils, simple_seq):
    """Offsets + blob reconstruct the same little-endian f32 interleaved samples the
    old ``xyBase64`` series carried — one concatenated buffer, not per-series strings."""
    data = plot_utils.collect_seq_waveform_data(simple_seq, "LIN", (0, np.inf), "s", "kHz/m", 100)
    payload, xy_blob = plot_utils.build_chartgpu_payload(data, False)
    slices = []
    for panel in payload["panels"]:
        for series in panel["series"]:
            assert "xyBase64" not in series
            assert series["xyOff"] % 4 == 0
            assert series["xyLen"] % 4 == 0
            decoded = _decode_xy(series, xy_blob)
            assert decoded.ndim == 2 and decoded.shape[1] == 2
            slices.append((series["xyOff"], series["xyLen"], decoded))
    assert slices, "expected at least one series"
    # Re-encoding each slice independently must match the blob window.
    for off, length, decoded in slices:
        rebuilt = plot_utils._encode_xy_interleaved_f32(decoded.astype(np.float64))
        assert rebuilt == bytes(xy_blob[off : off + length])


# ---------------------------------------------------------------------------
# The k-space cache -- one of the things the worker migration must harvest atomically
# ---------------------------------------------------------------------------


class KSpaceSeq(FakeSeq):
    """Adds the `calculate_kspace()` contract `ensure_kspace_cache` consumes.

    Also duck-typed: the real thing is pypulseq's method plus the `_t_ktraj`
    attribute that `_patch_calculate_kspace` monkey-patches onto it.
    """

    def __init__(self, blocks, durations, k_traj, k_traj_adc, t_adc, t_ktraj=None):
        super().__init__(blocks, durations)
        self._k_traj = k_traj
        self._k_traj_adc = k_traj_adc
        self._t_adc = t_adc
        self._t_ktraj = t_ktraj

    def calculate_kspace(self):
        # The real `_t_ktraj` is stashed by the patched method as a side effect of
        # the call, so set it here rather than in __init__.
        if self._t_ktraj is None:
            del self._t_ktraj
        else:
            self._t_ktraj = np.asarray(self._t_ktraj, dtype=float)
        return self._k_traj_adc, self._k_traj, None, None, self._t_adc


def _kspace_seq(**overrides):
    n = 6
    defaults = dict(
        blocks=[Obj(adc=make_adc(num_samples=3, dwell=1e-3))],
        durations=[6e-3],
        k_traj=np.vstack([np.arange(n, dtype=float), np.arange(n, dtype=float) * 2]),
        k_traj_adc=np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]]),
        t_adc=np.array([0.0, 1e-3, 2e-3]),
        t_ktraj=np.linspace(0.0, 6e-3, n),
    )
    defaults.update(overrides)
    return KSpaceSeq(**defaults)


def test_ensure_kspace_cache_populates_every_documented_key(plot_utils):
    import __main__

    plot_utils.ensure_kspace_cache(_kspace_seq())
    cache = __main__._kspace_cache
    assert set(cache) == {
        "t_ktraj",
        "kx_grad",
        "ky_grad",
        "kz_grad",
        "t_adc",
        "kx_adc",
        "ky_adc",
        "kz_adc",
        "total_duration_s",
        "disp_range_s",
        "t_ktraj_len_mismatch_fixed",
        "k_traj_shape",
    }
    assert cache["k_traj_shape"] == [2, 6]
    assert cache["total_duration_s"] == pytest.approx(6e-3)
    assert cache["t_ktraj_len_mismatch_fixed"] is False
    assert cache["kx_grad"].tolist() == [0.0, 1.0, 2.0, 3.0, 4.0, 5.0]
    assert cache["kz_grad"].tolist() == [0.0] * 6, "absent third row is zero-filled"
    assert cache["kx_adc"].tolist() == [1.0, 2.0, 3.0]
    assert cache["kz_adc"].tolist() == [0.0, 0.0, 0.0]


def test_ensure_kspace_cache_substitutes_a_linear_time_axis_on_a_length_mismatch(plot_utils):
    import __main__

    plot_utils.ensure_kspace_cache(_kspace_seq(t_ktraj=np.array([0.0, 1e-3])))
    cache = __main__._kspace_cache
    assert cache["t_ktraj_len_mismatch_fixed"] is True
    assert cache["t_ktraj"].tolist() == pytest.approx(np.linspace(0.0, 6e-3, 6).tolist())


def test_ensure_kspace_cache_tolerates_a_missing_t_ktraj_attribute(plot_utils):
    """Which is what happens when `_patch_calculate_kspace` never ran -- the
    fallback linear axis is used instead of raising."""
    import __main__

    plot_utils.ensure_kspace_cache(_kspace_seq(t_ktraj=None))
    assert __main__._kspace_cache["t_ktraj_len_mismatch_fixed"] is True
    assert __main__._kspace_cache["t_ktraj"].size == 6


def test_ensure_kspace_cache_truncates_adc_arrays_to_the_shorter_of_the_two(plot_utils):
    import __main__

    plot_utils.ensure_kspace_cache(
        _kspace_seq(t_adc=np.array([0.0, 1e-3, 2e-3, 3e-3]), k_traj_adc=np.array([[1.0, 2.0]]))
    )
    cache = __main__._kspace_cache
    assert cache["t_adc"].tolist() == [0.0, 1e-3]
    assert cache["kx_adc"].tolist() == [1.0, 2.0]
    assert cache["ky_adc"] is None, "a single-row k_traj_adc leaves ky unset"


def test_ensure_kspace_cache_keeps_a_three_row_trajectory(plot_utils):
    import __main__

    n = 4
    plot_utils.ensure_kspace_cache(
        _kspace_seq(
            k_traj=np.vstack([np.arange(n, dtype=float)] * 3),
            k_traj_adc=np.vstack([np.arange(3, dtype=float)] * 3),
            t_ktraj=np.linspace(0.0, 6e-3, n),
        )
    )
    cache = __main__._kspace_cache
    assert cache["kz_grad"].tolist() == [0.0, 1.0, 2.0, 3.0]
    assert cache["kz_adc"].tolist() == [0.0, 1.0, 2.0]


def test_ensure_kspace_cache_stores_none_for_all_adc_arrays_without_t_adc(plot_utils):
    import __main__

    plot_utils.ensure_kspace_cache(_kspace_seq(t_adc=None))
    cache = __main__._kspace_cache
    assert cache["t_adc"] is None
    assert cache["kx_adc"] is None and cache["ky_adc"] is None and cache["kz_adc"] is None


def test_ensure_kspace_cache_produces_ragged_gradient_arrays_for_a_one_row_trajectory(plot_utils):
    """CHARACTERISATION -- looks wrong, pinned as-is.

    `kx_grad`/`ky_grad` fall back to `np.zeros(0)` when their row is absent while
    `kz_grad` falls back to `np.zeros(n)`. A one-row trajectory therefore yields
    kx and kz of length n but ky of length 0. `export_kspace_cache_json` passes
    all three straight through, so JS zipping them by index gets three arrays of
    two different lengths.
    """
    import __main__

    n = 4
    plot_utils.ensure_kspace_cache(
        _kspace_seq(k_traj=np.arange(n, dtype=float).reshape(1, n), t_ktraj=np.linspace(0, 6e-3, n))
    )
    cache = __main__._kspace_cache
    assert cache["kx_grad"].size == n
    assert cache["ky_grad"].size == 0
    assert cache["kz_grad"].size == n

    exported = json.loads(plot_utils.export_kspace_cache_json())
    assert len(exported["kx_grad"]) == n
    assert len(exported["ky_grad"]) == 0
    assert len(exported["kz_grad"]) == n


def test_export_kspace_cache_json_reports_an_absent_cache_in_band(plot_utils):
    import __main__

    __main__._kspace_cache = None
    assert json.loads(plot_utils.export_kspace_cache_json()) == {"error": "no _kspace_cache"}


def test_export_kspace_cache_json_shape(plot_utils):
    plot_utils.ensure_kspace_cache(_kspace_seq())
    exported = json.loads(plot_utils.export_kspace_cache_json())
    assert set(exported) == {
        "meta",
        "t_adc",
        "kx_adc",
        "ky_adc",
        "kz_adc",
        "t_ktraj",
        "kx_grad",
        "ky_grad",
        "kz_grad",
    }
    assert exported["meta"] == {
        "total_duration_s": pytest.approx(6e-3),
        "disp_range_s": [0.0, pytest.approx(6e-3)],
        "k_traj_shape": [2, 6],
        "n_adc": 3,
        "n_traj": 6,
    }
    assert exported["t_adc"] == pytest.approx([0.0, 1e-3, 2e-3])


def test_export_kspace_cache_json_nulls_non_finite_samples(plot_utils):
    """The counterpart of the `json.dumps(Infinity)` hazard in
    `seq_source_manager`: here non-finite values are deliberately mapped to null
    so `JSON.parse` succeeds and JS can filter with `Number.isFinite`."""
    import __main__

    plot_utils.ensure_kspace_cache(_kspace_seq())
    __main__._kspace_cache["kx_grad"] = np.array([1.0, np.nan, np.inf, 4.0, 5.0, 6.0])
    exported = json.loads(plot_utils.export_kspace_cache_json())
    assert exported["kx_grad"] == [1.0, None, None, 4.0, 5.0, 6.0]


def test_export_kspace_cache_json_drops_adc_times_when_the_trajectory_is_missing(plot_utils):
    """CHARACTERISATION: `m = min(t_adc, kx_adc, ky_adc)` and absent arrays become
    `zeros(0)`, so a cache holding ADC times but no ADC trajectory exports
    `n_adc: 0` and empty lists rather than the times it does have."""
    import __main__

    plot_utils.ensure_kspace_cache(_kspace_seq())
    __main__._kspace_cache["kx_adc"] = None
    exported = json.loads(plot_utils.export_kspace_cache_json())
    assert exported["meta"]["n_adc"] == 0
    assert exported["t_adc"] == []


def test_export_kspace_cache_json_raises_without_t_ktraj(plot_utils):
    """CHARACTERISATION: `c['t_ktraj']` is a direct subscript while every other
    read uses `.get`, so a partially built cache raises KeyError instead of
    returning the in-band error above."""
    import __main__

    __main__._kspace_cache = {"kx_grad": np.zeros(2), "ky_grad": np.zeros(2)}
    with pytest.raises(KeyError, match="t_ktraj"):
        plot_utils.export_kspace_cache_json()


def test_clear_kspace_cache_sets_none_rather_than_deleting(plot_utils):
    import __main__

    plot_utils.ensure_kspace_cache(_kspace_seq())
    plot_utils.clear_kspace_cache()
    assert __main__._kspace_cache is None


# ---------------------------------------------------------------------------
# seq_plot -- dispatch, validation, and the matplotlib fallback
# ---------------------------------------------------------------------------


def test_seq_plot_chartgpu_exports_a_payload_and_draws_nothing(plot_utils, simple_seq, capsys):
    import __main__
    import matplotlib.pyplot as plt

    __main__._chartgpu_last_payload = None
    __main__._chartgpu_last_xy = None
    assert plot_utils.seq_plot(simple_seq, plot_speed="chartgpu", plot_now=False) is None
    assert __main__._chartgpu_last_payload["version"] == 4
    assert isinstance(__main__._chartgpu_last_xy, (bytes, bytearray))
    assert len(__main__._chartgpu_last_xy) % 4 == 0
    assert plt.get_fignums() == []
    assert "Exporting sequence waveforms for ChartGPU" in capsys.readouterr().out


def test_seq_plot_defaults_to_chartgpu(plot_utils, simple_seq):
    import __main__
    import matplotlib.pyplot as plt

    __main__._chartgpu_last_payload = None
    __main__._chartgpu_last_xy = None
    plot_utils.seq_plot(simple_seq, plot_now=False)
    assert __main__._chartgpu_last_payload is not None
    assert plot_utils.get_chartgpu_payload_xy() == __main__._chartgpu_last_xy
    assert plot_utils.get_chartgpu_payload_xy() != b""
    assert plt.get_fignums() == []


def test_seq_plot_chartgpu_ignores_save(plot_utils, simple_seq, tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    plot_utils.seq_plot(simple_seq, plot_speed="chartgpu", plot_now=False, save=True)
    assert list(tmp_path.iterdir()) == []
    assert "ChartGPU export ignores save=True" in capsys.readouterr().out


@pytest.mark.parametrize(
    "plot_speed, banner",
    [
        ("full", "Using full resolution plot in single figure"),
        ("fast", "Using fast seq_plot (Standard Plot + Decimation, no LineCollection)"),
        ("faster", "Using optimized seq_plot (LineCollection + aggressive Decimation)"),
    ],
)
def test_seq_plot_matplotlib_modes_build_a_six_panel_figure(
    plot_utils, simple_seq, capsys, plot_speed, banner
):
    """A future `Agg`-and-PNG switch for the worker migration replaces the tail of
    this path, so pin the figure it produces today: six stacked axes with the
    documented y-labels and a shared x-limit."""
    import matplotlib.pyplot as plt

    plot_utils.seq_plot(simple_seq, plot_speed=plot_speed, plot_now=False)
    assert banner in capsys.readouterr().out

    figures = plt.get_fignums()
    assert len(figures) == 1
    axes = plt.figure(figures[0]).get_axes()
    assert [ax.get_ylabel() for ax in axes] == [
        "ADC",
        "RF mag (Hz)",
        "RF/ADC ph (rad)",
        "Gx (kHz/m)",
        "Gy (kHz/m)",
        "Gz (kHz/m)",
    ]
    assert axes[-1].get_xlabel() == "t (s)"
    assert axes[0].get_xlim() == pytest.approx((0.0, 6e-3))


def test_seq_plot_treats_an_unknown_plot_speed_as_fast(plot_utils, simple_seq, capsys):
    """CHARACTERISATION: there is no validation of `plot_speed`, so a typo falls
    into the `else` branch and silently renders the decimated matplotlib plot
    instead of the requested one."""
    import matplotlib.pyplot as plt

    plot_utils.seq_plot(simple_seq, plot_speed="chartgpuu", plot_now=False)
    assert "Using fast seq_plot" in capsys.readouterr().out
    assert len(plt.get_fignums()) == 1


def test_seq_plot_honours_a_positive_max_points_per_block(plot_utils, simple_seq):
    """A positive int is used as-is; None / unused keep the plot_speed default
    (10_000_000 for chartgpu, so no decimation on this short sequence).
    """
    import __main__

    def adc_count(max_points):
        __main__._chartgpu_last_payload = None
        __main__._chartgpu_last_xy = None
        kwargs = dict(plot_speed="chartgpu", plot_now=False)
        if max_points is not Ellipsis:
            kwargs["max_points_per_block"] = max_points
        plot_utils.seq_plot(simple_seq, **kwargs)
        adc = __main__._chartgpu_last_payload["panels"][0]["series"][0]
        return _decode_xy(adc, __main__._chartgpu_last_xy).shape[0]

    assert adc_count(1) == 1
    assert adc_count(100) == 4
    assert adc_count(10_000_000) == 4
    assert adc_count(None) == 4
    assert adc_count(Ellipsis) == 4  # argument omitted: chartgpu default
    assert adc_count(0) == 4  # not a positive int → plot_speed default
    assert adc_count(-5) == 4


def test_seq_plot_writes_a_jpg_into_the_current_directory_when_saving(
    plot_utils, simple_seq, tmp_path, monkeypatch
):
    """The filename is hardcoded and relative, so in the browser it lands in the
    Pyodide VFS cwd -- the same pattern as `seq_check_py_recon.py`'s hardcoded
    `/recon_window.nii.gz`."""
    monkeypatch.chdir(tmp_path)
    plot_utils.seq_plot(simple_seq, plot_speed="fast", plot_now=False, save=True)
    assert [p.name for p in tmp_path.iterdir()] == ["seq_plot.jpg"]


def test_seq_plot_restores_global_rcparams(plot_utils, simple_seq):
    """The matplotlib path sets four `mpl.rcParams` entries for the figure and
    restores them afterwards. The ChartGPU path must not leak them either."""
    mpl.rcParams["lines.linewidth"] = 3.0
    mpl.rcParams["font.size"] = 20
    mpl.rcParams["path.simplify"] = False
    mpl.rcParams["path.simplify_threshold"] = 0.25

    plot_utils.seq_plot(simple_seq, plot_speed="fast", plot_now=False)
    assert mpl.rcParams["lines.linewidth"] == 3.0
    assert mpl.rcParams["font.size"] == 20
    assert mpl.rcParams["path.simplify"] is False
    assert mpl.rcParams["path.simplify_threshold"] == 0.25

    plot_utils.seq_plot(simple_seq, plot_speed="chartgpu", plot_now=False)
    assert mpl.rcParams["lines.linewidth"] == 3.0
    assert mpl.rcParams["font.size"] == 20
    assert mpl.rcParams["path.simplify"] is False
    assert mpl.rcParams["path.simplify_threshold"] == 0.25


def test_seq_plot_reads_the_theme_from_rcparams(plot_utils, simple_seq):
    """`is_dark` is inferred from `text.color`, which `seq_explorer.js` sets from
    its `themeCode` fragment before every execute. Any other value reads as
    light."""
    import __main__

    for color, expected in (("#e5e7eb", True), ("white", True), ("black", False), ("#123456", False)):
        with mpl.rc_context({"text.color": color}):
            __main__._chartgpu_last_payload = None
            plot_utils.seq_plot(simple_seq, plot_speed="chartgpu", plot_now=False)
            assert __main__._chartgpu_last_payload["isDark"] is expected


@pytest.mark.parametrize("time_range", [(0,), (0, 1, 2), "ab", (0, "1")])
def test_seq_plot_rejects_a_malformed_time_range(plot_utils, simple_seq, time_range):
    with pytest.raises(ValueError, match="Invalid time range"):
        plot_utils.seq_plot(simple_seq, plot_speed="chartgpu", plot_now=False, time_range=time_range)


def test_seq_plot_accepts_numpy_integer_and_float_time_ranges(plot_utils, simple_seq):
    """A worker passes `time_range` as data, so numpy integer scalars must be
    accepted the same way as Python int/float and `np.float64`.

    The old guard was `isinstance(x, (int, float))`: `np.float64` subclasses
    `float` and passed, but `np.int64` does not subclass `int`. Array-valued
    bounds are still rejected by type (not by truthiness — a 2x2 array would
    raise an ambiguous-truth ValueError if the guard used `if x`).
    """
    import __main__

    for time_range in (
        np.array([0, 10]),
        np.array([0.0, 10.0]),
        (np.int64(0), np.int64(10)),
        (np.float64(0.0), np.float64(10.0)),
        (0, np.int64(10)),
    ):
        __main__._chartgpu_last_payload = None
        __main__._chartgpu_last_xy = None
        plot_utils.seq_plot(
            simple_seq, plot_speed="chartgpu", plot_now=False, time_range=time_range
        )
        assert __main__._chartgpu_last_payload["version"] == 4
        assert isinstance(__main__._chartgpu_last_xy, (bytes, bytearray))
        assert len(__main__._chartgpu_last_xy) % 4 == 0

    with pytest.raises(ValueError, match="Invalid time range"):
        plot_utils.seq_plot(
            simple_seq,
            plot_speed="chartgpu",
            plot_now=False,
            time_range=np.array([[0, 1], [2, 3]]),
        )


def test_seq_plot_accepts_booleans_as_a_time_range(plot_utils, simple_seq):
    """CHARACTERISATION: `bool` is a subclass of `int`, so `(True, False)` passes
    validation and then silently plots nothing, because the window it describes
    is [1, 0]."""
    import __main__

    __main__._chartgpu_last_payload = None
    plot_utils.seq_plot(
        simple_seq, plot_speed="chartgpu", plot_now=False, time_range=(True, False)
    )
    assert __main__._chartgpu_last_payload["panels"][0]["series"][0]["style"]["color"] == "#7f7f7f"


def test_seq_plot_rejects_unknown_display_units(plot_utils, simple_seq):
    with pytest.raises(ValueError, match="Unsupported time unit"):
        plot_utils.seq_plot(simple_seq, plot_speed="chartgpu", plot_now=False, time_disp="ns")
    with pytest.raises(ValueError, match="Unsupported gradient unit"):
        plot_utils.seq_plot(simple_seq, plot_speed="chartgpu", plot_now=False, grad_disp="T/m")


def test_seq_plot_prints_its_banner_before_validating(plot_utils, simple_seq, capsys):
    """CHARACTERISATION: the `plot_speed` dispatch (and its `print`) runs ahead of
    the argument checks, so the console claims a plot is being produced and then
    the call raises."""
    with pytest.raises(ValueError):
        plot_utils.seq_plot(simple_seq, plot_speed="chartgpu", plot_now=False, time_disp="ns")
    assert "Exporting sequence waveforms for ChartGPU" in capsys.readouterr().out


def test_seq_plot_draws_labels_with_a_legend(plot_utils):
    import matplotlib.pyplot as plt

    adc = make_adc(num_samples=1, dwell=1e-4)
    label = [Obj(type="labelset", label="LIN", value=3), Obj(type="labelset", label="SLC", value=7)]
    seq = FakeSeq([Obj(adc=adc, label=label)], [1e-3])
    plot_utils.seq_plot(seq, label="LIN,SLC", plot_speed="fast", plot_now=False)
    adc_axis = plt.figure(plt.get_fignums()[0]).get_axes()[0]
    legend = adc_axis.get_legend()
    assert legend is not None
    assert [t.get_text() for t in legend.get_texts()] == ["SLC", "LIN"]


def test_seq_plot_handles_an_empty_sequence_in_every_mode(plot_utils):
    """A build that produced no blocks must not crash the plot -- the failure
    would otherwise surface as a stack trace in the sequence console."""
    import __main__
    import matplotlib.pyplot as plt

    empty = FakeSeq([], [])
    __main__._chartgpu_last_payload = None
    plot_utils.seq_plot(empty, plot_speed="chartgpu", plot_now=False)
    assert __main__._chartgpu_last_payload["xRange"] == [0.0, 0.0]
    for plot_speed in ("full", "fast", "faster"):
        plt.close("all")
        # An empty sequence gives disp_range == (0, 0), which matplotlib widens
        # itself with a warning rather than refusing the limits.
        with pytest.warns(UserWarning, match="identical low and high xlims"):
            plot_utils.seq_plot(empty, plot_speed=plot_speed, plot_now=False)
        assert len(plt.figure(plt.get_fignums()[0]).get_axes()) == 6


# ---------------------------------------------------------------------------
# Patching -- browser-only, recorded rather than tested
# ---------------------------------------------------------------------------


def test_patch_pypulseq_needs_a_real_pypulseq(plot_utils):
    """Recorded as the boundary of what is host-testable.

    `patch_pypulseq` and `_patch_calculate_kspace` reach into the installed
    `pypulseq` package to replace `Sequence.plot` and `Sequence.calculate_kspace`
    and to import `pypulseq.eps`. Against the repo's namespace package neither
    finds anything, so a host test could only ever assert against a stub of the
    thing being patched. Both are therefore browser-only; the k-space attribute
    they install (`seq._t_ktraj`) is covered instead through
    `ensure_kspace_cache`, which reads it by `getattr`.
    """
    import pypulseq

    assert not hasattr(pypulseq, "Sequence")
    with pytest.raises(ImportError):
        plot_utils._patch_calculate_kspace()
