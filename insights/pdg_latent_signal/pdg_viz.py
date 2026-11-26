"""Alternative views of an MRzero phase distribution graph (PDG).

``mr0.Graph.plot()`` scatters every + state at (repetition, end-of-repetition
dephasing) and colours it by log10(latent_signal). This module turns the graph
into flat arrays (``PDGTable``) and offers views that answer sequence and
contrast questions directly:

- ``plot_phase_diagram``   latent-weighted extended-phase-graph (EPG) diagram
- ``plot_budget``          what ``execute_graph`` will actually simulate
- ``relaxation_spectrum``  exact split of each readout into T2 / T1-storage times
- ``plot_relaxation_map``  signed pathway-TE (or storage-time) map per readout
- ``plot_fingerprint``     effective TE / stimulated-echo share per readout
- ``plot_tissue_*``        per-tissue prepasses: contrast and tissue-specific states
- ``plot_compass``         T1 vs T2 weighting per readout from finite differences

Metric definitions follow MRzero-Core ``src/pre_pass.rs``:
  signal          sum over ADC samples of |mag| * exp(-|tau|/T2') * (1+|k|)^-2.2 * nyquist
  emitted_signal  signal / max(signal of the same repetition)
  latent_signal   max(own emitted, max over children of child.latent * contrib/max_contrib)
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.collections import LineCollection
from matplotlib.colors import LogNorm, ListedColormap, SymLogNorm
from matplotlib.lines import Line2D
from matplotlib.patches import Patch

TYPES = ("+", "z", "z0")
RELATIONS = ("++", "+z", "z+", "zz", "-+", "-z")
AXES = {"k_x": 0, "k_y": 1, "k_z": 2, "tau": 3}
AXIS_UNIT = {"k_x": "1/m", "k_y": "1/m", "k_z": "1/m", "tau": "ms"}


@dataclass
class SeqTiming:
    """Per-repetition timing, indexed like ``graph`` (entry 0 is the initial z0)."""
    dur: np.ndarray
    angle_deg: np.ndarray
    phase_deg: np.ndarray
    has_adc: np.ndarray
    t_adc: np.ndarray            # ADC centre, seconds after the pulse (nan: no ADC)
    adc_span: np.ndarray         # (n, 2) first/last ADC sample time after the pulse
    g_cum: list                  # (events + 1, 4) cumulative [gx, gy, gz, t] per rep
    t_start: np.ndarray          # absolute pulse time of each repetition

    @classmethod
    def from_seq(cls, seq) -> "SeqTiming":
        n = len(seq) + 1
        dur = np.zeros(n)
        angle = np.zeros(n)
        phase = np.zeros(n)
        has_adc = np.zeros(n, bool)
        t_adc = np.full(n, np.nan)
        span = np.full((n, 2), np.nan)
        g_cum = [np.zeros((1, 4))]
        for r, rep in enumerate(seq, start=1):
            dt = rep.event_time.detach().cpu().numpy().astype(float)
            gm = rep.gradm.detach().cpu().numpy().astype(float)
            adc = rep.adc_usage.detach().cpu().numpy() > 0
            cum = np.vstack([np.zeros((1, 4)), np.cumsum(np.c_[gm, dt], 0)])
            g_cum.append(cum)
            dur[r] = dt.sum()
            angle[r] = float(rep.pulse.angle) * 180 / np.pi
            phase[r] = float(rep.pulse.phase) * 180 / np.pi
            if adc.any():
                has_adc[r] = True
                t_samples = cum[1:, 3][adc]
                t_adc[r] = t_samples.mean()
                span[r] = t_samples[0], t_samples[-1]
        t_start = np.concatenate([[0.0], np.cumsum(dur[1:])])[:n]
        return cls(dur, angle, phase, has_adc, t_adc, span, g_cum, t_start)

    def k_at_adc(self, r: int) -> np.ndarray:
        """Gradient moment from the pulse to the ADC centre of repetition r."""
        cum = self.g_cum[r]
        i = np.searchsorted(cum[:, 3], self.t_adc[r])
        i = min(max(i, 1), len(cum) - 1)
        a, b = cum[i - 1], cum[i]
        w = 0.0 if b[3] == a[3] else (self.t_adc[r] - a[3]) / (b[3] - a[3])
        return a + w * (b - a)


@dataclass
class PDGTable:
    """Flat, numpy view of a ``mr0.Graph`` plus its sequence timing."""
    timing: SeqTiming
    rep: np.ndarray
    typ: np.ndarray              # index into TYPES
    k_end: np.ndarray            # (n, 4) prepass_kt_vec, end of repetition
    k_start: np.ndarray          # (n, 4) right after the pulse
    mag: np.ndarray              # prepass_mag (complex), end of repetition
    mag_start: np.ndarray        # sum of ancestor contributions, right after the pulse
    signal: np.ndarray
    emitted: np.ndarray
    latent: np.ndarray
    latent_un: np.ndarray
    e_child: np.ndarray
    e_parent: np.ndarray
    e_rel: np.ndarray            # index into RELATIONS
    e_rot: np.ndarray            # complex rotation factor
    e_carried: np.ndarray        # child.latent * contrib / max_contrib (what analyze_graph propagates)
    params: dict = field(default_factory=dict)

    @property
    def n(self) -> int:
        return len(self.rep)

    @classmethod
    def from_graph(cls, graph, seq, **params) -> "PDGTable":
        timing = SeqTiming.from_seq(seq)
        row_of = {}
        rows = []
        for r, states in enumerate(graph):
            for s in states:
                row_of[id(s)] = len(rows)
                rows.append((r, s))
        n = len(rows)
        rep = np.fromiter((r for r, _ in rows), int, n)
        typ = np.fromiter((TYPES.index(s.dist_type) for _, s in rows), int, n)
        k_end = np.array([s.prepass_kt_vec for _, s in rows], float).reshape(n, 4)
        mag = np.array([complex(s.prepass_mag) for _, s in rows])
        signal = np.array([s.signal for _, s in rows], float)
        emitted = np.array([s.emitted_signal for _, s in rows], float)
        latent = np.array([s.latent_signal for _, s in rows], float)
        latent_un = np.array([s.latent_signal_unormalized for _, s in rows], float)

        k_start = k_end.copy()
        plus = typ == 0
        for r in np.unique(rep[plus]):
            sel = plus & (rep == r)
            k_start[sel] -= timing.g_cum[r][-1]

        ec, ep, er, eo = [], [], [], []
        for i, (r, s) in enumerate(rows):
            for rel, anc, rot in s.ancestors:
                ec.append(i)
                ep.append(row_of[id(anc)])
                er.append(RELATIONS.index(rel))
                eo.append(complex(rot))
        ec, ep, er = np.asarray(ec, int), np.asarray(ep, int), np.asarray(er, int)
        eo = np.asarray(eo, complex)
        conj = np.isin(er, [4, 5])
        contrib_c = eo * np.where(conj, np.conj(mag[ep]), mag[ep])
        mag_start = np.zeros(n, complex)
        np.add.at(mag_start, ec, contrib_c)
        mag_start[rep == 0] = mag[rep == 0]
        contrib = np.abs(contrib_c)
        max_contrib = np.zeros(n)
        np.maximum.at(max_contrib, ec, contrib)
        # z0 also receives regrowth (1 - E1), which competes in max_contrib
        z0 = np.where(typ == 2)[0]
        T1 = params.get("T1")
        if T1:
            regrow = 1 - np.exp(-timing.dur[rep[z0]] / T1)
            max_contrib[z0] = np.maximum(max_contrib[z0], regrow)
        carried = latent[ec] * contrib / np.where(max_contrib[ec] > 0, max_contrib[ec], 1)
        return cls(timing, rep, typ, k_end, k_start, mag, mag_start, signal, emitted, latent,
                   latent_un, ec, ep, er, eo, carried, dict(params))

    def k_adc(self) -> np.ndarray:
        """Dephasing of + states at the ADC centre of their repetition (nan otherwise)."""
        out = np.full((self.n, 4), np.nan)
        for r in np.where(self.timing.has_adc)[0]:
            sel = (self.rep == r) & (self.typ == 0)
            out[sel] = self.k_start[sel] + self.timing.k_at_adc(r)
        return out

    def classify(self, min_emitted=1e-2, min_latent=1e-2) -> np.ndarray:
        """What ``execute_graph`` does with each state.

        0 dead      latent == 0: no path to any readout
        1 pruned    0 < latent < min_latent: skipped by execute_graph
        2 carried   simulated, not measured (emitted < min_emitted or z state)
        3 measured  + state that enters the signal equation
        z0 states are always simulated and reported as 2.
        """
        cls = np.where(self.latent <= 0, 0, np.where(self.latent < min_latent, 1, 2))
        cls[(self.typ == 0) & (cls == 2) & (self.emitted >= min_emitted)] = 3
        cls[self.typ == 2] = 2
        return cls


# --------------------------------------------------------------------------
# Relaxation-history decomposition
# --------------------------------------------------------------------------

def relaxation_paths(table: PDGTable, T1: float, T2: float, dt_q: float = 1e-4,
                     prune: float = 1e-7):
    """Split every state's magnetisation by its relaxation history.

    Each state's magnetisation is a sum of pathways. A pathway starts as
    regrown (or initial) longitudinal magnetisation and then spends ``t2``
    seconds as a + state (T2 decay) and ``t1s`` seconds stored as a dephased
    z state (T1 decay, the stimulated-echo memory). Time spent in the
    longitudinal pool z0 is not counted, but histories flow through it: a +
    state that is back at k = 0, tau = 0 at a pulse feeds z0 and keeps its
    T2 history. Returns ``(end, start)``: per row a dict
    ``{(t2 / dt_q, t1s / dt_q): complex}`` at the end of the repetition, and
    for + states the same right after the pulse.

    The per-repetition decay of a state is taken from the prepass itself
    (``mag / mag_start``), so k-dependent diffusion is included and the dicts
    sum to ``prepass_mag``. ``T1``/``T2`` are only the fallback where the
    ancestor contributions cancel, and give z0's regrowth 1 - exp(-T/T1).
    """
    tm = table.timing
    order = np.argsort(table.rep, kind="stable")
    by_child = defaultdict(list)
    for j in range(len(table.e_child)):
        by_child[table.e_child[j]].append(j)
    end = [None] * table.n
    start = [None] * table.n
    for i in order:
        r, t = table.rep[i], table.typ[i]
        if r == 0:
            end[i] = {(0, 0): table.mag[i]}
            continue
        acc = defaultdict(complex)
        for j in by_child[i]:
            p = table.e_parent[j]
            rot = table.e_rot[j]
            conj = RELATIONS[table.e_rel[j]][0] == "-"
            for key, c in end[p].items():
                acc[key] += rot * (np.conj(c) if conj else c)
        T = tm.dur[r]
        q = int(round(T / dt_q))
        if t == 2:
            r1 = np.exp(-T / T1)
            z0 = {k: c * r1 for k, c in acc.items() if abs(c * r1) > prune}
            z0[(0, 0)] = z0.get((0, 0), 0j) + (1 - r1)
            end[i] = z0
            continue
        f = np.exp(-T / (T2 if t == 0 else T1))
        direct = table.mag_start[i]
        if abs(direct) > 1e-12:
            ratio = table.mag[i] / direct
            if abs(ratio.imag) < 1e-3 * abs(ratio) and 0 <= ratio.real <= 1.0001:
                f = ratio.real
        if t == 0:
            start[i] = {k: c for k, c in acc.items() if abs(c) > prune}
            end[i] = {(a + q, b): c * f for (a, b), c in acc.items() if abs(c * f) > prune}
        else:
            end[i] = {(a, b + q): c * f for (a, b), c in acc.items() if abs(c * f) > prune}
    return end, start


def relaxation_spectrum(table: PDGTable, T1: float, T2: float, min_emitted=1e-2,
                        dt_q: float = 1e-4):
    """Measured signal of every readout, split by (T2 time, T1-storage time).

    Returns ``{rep: (t2_seconds, t1s_seconds, weight)}``. Within a state all
    pathways share k and tau, so they add coherently; each is projected on the
    state's total phase, which makes the weights of a state sum to its
    ``signal``. ``t2`` is counted up to the ADC centre, i.e. it is the
    pathway's echo time.
    """
    _, start = relaxation_paths(table, T1, T2, dt_q)
    tm = table.timing
    out = {}
    for r in np.where(tm.has_adc)[0]:
        sel = np.where((table.rep == r) & (table.typ == 0) & (table.emitted >= min_emitted))[0]
        t2s, t1s, ws = [], [], []
        for i in sel:
            if not start[i]:
                continue
            keys = np.array(list(start[i].keys()), float).reshape(-1, 2)
            vals = np.array(list(start[i].values()), complex)
            total = vals.sum()
            if abs(total) == 0:
                continue
            proj = np.real(vals * np.conj(total) / abs(total))
            proj = proj / proj.sum() * table.signal[i]
            t2s.append(keys[:, 0] * dt_q + tm.t_adc[r])
            t1s.append(keys[:, 1] * dt_q)
            ws.append(proj)
        if ws:
            out[r] = (np.concatenate(t2s), np.concatenate(t1s), np.concatenate(ws))
    return out


def _weighted_median(v, w):
    w = np.clip(w, 0, None)
    if w.sum() <= 0:
        return np.nan
    o = np.argsort(v)
    c = np.cumsum(w[o])
    return v[o][np.searchsorted(c, 0.5 * c[-1])]


def fingerprint(spectrum: dict, store_min: float = 1e-4):
    """Per-readout summary of ``relaxation_spectrum``.

    Returns dict of arrays over readouts:

    te_eff    signal-weighted mean pathway TE. Since S(T2) = sum_k w_k exp(-t2_k/T2),
              this is exactly -d ln S / d(1/T2): the TE a pure spin echo would
              need to have the same T2 sensitivity.
    te_med    weighted median (robust when RF spoiling leaves many small
              pathways of both signs)
    te_dom    pathway TE carrying the largest share, dom_frac that share
    te_prim   primary echo: longest never-stored pathway with >= 5 % share
              (the nominal TE of a spin-echo train, the FID TE of a GRE)
    ste_frac  share stored as dephased z magnetisation at least once
              (stimulated-echo type), t1s_eff its mean storage time
    """
    reps = sorted(spectrum)
    keys = ("total", "te_eff", "te_med", "te_dom", "dom_frac", "te_prim", "ste_frac", "t1s_eff")
    res = {k: np.full(len(reps), np.nan) for k in keys}
    res["rep"] = np.asarray(reps)
    for n, r in enumerate(reps):
        t2, t1, w = spectrum[r]
        tot = w.sum()
        res["total"][n] = tot
        if tot <= 0:
            continue
        res["te_eff"][n] = (w * t2).sum() / tot
        res["te_med"][n] = _weighted_median(t2, w)
        u, inv = np.unique(np.round(t2, 5), return_inverse=True)
        per_te = np.bincount(inv, weights=w)
        res["te_dom"][n] = u[np.argmax(per_te)]
        res["dom_frac"][n] = per_te.max() / tot
        fresh = t1 <= store_min
        uf, invf = np.unique(np.round(t2[fresh], 5), return_inverse=True)
        per_f = np.bincount(invf, weights=w[fresh]) if fresh.any() else np.zeros(0)
        big = uf[per_f >= 0.05 * tot]
        res["te_prim"][n] = big.max() if len(big) else res["te_dom"][n]
        st = t1 > store_min
        stored = w[st].sum()
        res["ste_frac"][n] = stored / tot
        res["t1s_eff"][n] = (w[st] * t1[st]).sum() / stored if stored > 1e-3 * tot else np.nan
    return res


# --------------------------------------------------------------------------
# Plots
# --------------------------------------------------------------------------

def split_cmap(vmin, threshold, cmap="viridis", n=256):
    """Log colour map that turns grey below ``threshold``: pruned states read as grey."""
    frac = np.log(threshold / vmin) / np.log(1.0 / vmin)
    nb = int(round(frac * n))
    greys = plt.get_cmap("Greys")(np.linspace(0.25, 0.5, max(nb, 1)))[:nb]
    cols = plt.get_cmap(cmap)(np.linspace(0.1, 1.0, n - nb))
    return ListedColormap(np.vstack([greys, cols]))


def _mark_long_reps(ax, tm, reps, factor=5.0):
    med = np.median(tm.dur[1:])
    for r in reps:
        if tm.dur[r] > factor * med:
            ax.text(r - 0.5, 0.98, f"{tm.dur[r]:.2f} s\nrep.", transform=ax.get_xaxis_transform(),
                    ha="center", va="top", fontsize=7, color="0.3",
                    bbox=dict(fc="white", ec="none", alpha=0.8, pad=1))


def plot_phase_diagram(table: PDGTable, ax=None, axis="k_x", metric="latent",
                       threshold=1e-2, floor_decades=2, show_z=True, show_jumps=True,
                       rep_range=None, cmap="viridis", max_points=24, colorbar=True,
                       legend=True):
    """Latent-weighted EPG diagram: every relevant state as its k(t) trajectory.

    + states are solid lines that follow the gradient moments inside their
    repetition, z states are dashed (k frozen). Refocusing edges (k -> -k) are
    drawn as thin jumps at the pulse. Only states with ``metric >= threshold
    * 10**-floor_decades`` are drawn; colour and line width encode the metric.
    The colour map turns grey below ``threshold``, so everything in colour is
    what ``execute_graph`` simulates. Readout windows are shaded and the echo
    positions (k crossing 0 inside the ADC) are marked.
    """
    ax = ax or plt.gca()
    tm = table.timing
    ia = AXES[axis]
    scale = 1e3 if axis == "tau" else 1.0
    val = {"latent": table.latent, "emitted": table.emitted,
           "latent_global": table.latent_un / max(table.latent_un.max(), 1e-30)}[metric]
    vmin = threshold * 10.0 ** -floor_decades
    keep = val >= vmin
    if rep_range is not None:
        keep &= (table.rep >= rep_range[0]) & (table.rep <= rep_range[1])
    norm = LogNorm(vmin=vmin, vmax=1.0)
    cm = split_cmap(vmin, threshold, cmap)

    def style(v):
        lv = np.clip(norm(v), 0, 1)
        return cm(lv), 0.4 + 2.6 * lv ** 1.5

    segs, cols, lws = [], [], []
    zsegs, zcols, zlws = [], [], []
    for i in np.where(keep & (table.typ == 0))[0]:
        r = table.rep[i]
        cum = tm.g_cum[r]
        idx = np.unique(np.linspace(0, len(cum) - 1, min(max_points, len(cum))).astype(int))
        k = (table.k_start[i, ia] + cum[idx, ia]) * scale
        x = r - 1 + cum[idx, 3] / max(tm.dur[r], 1e-12)
        segs.append(np.c_[x, k])
        c, w = style(val[i])
        cols.append(c)
        lws.append(w)
    if show_z:
        for i in np.where(keep & (table.typ == 1))[0]:
            r = table.rep[i]
            k = table.k_end[i, ia] * scale
            zsegs.append([(r - 1, k), (r, k)])
            c, w = style(val[i])
            zcols.append(c)
            zlws.append(w)
    if zsegs:
        ax.add_collection(LineCollection(zsegs, colors=zcols, linewidths=np.asarray(zlws) * 0.8,
                                         linestyles=(0, (2, 1.5)), alpha=0.9, zorder=2))
    if segs:
        lw = np.asarray(lws)
        o = np.argsort(lw)
        ax.add_collection(LineCollection([segs[j] for j in o], colors=[cols[j] for j in o],
                                         linewidths=lw[o], zorder=3, capstyle="round"))
    if show_jumps:
        sel = (keep[table.e_child] & (table.e_carried >= vmin)
               & np.isin(table.e_rel, [4, 5]))
        jumps = []
        jc = []
        for j in np.where(sel)[0]:
            p, c = table.e_parent[j], table.e_child[j]
            x0 = table.rep[c] - 1
            jumps.append([(x0, table.k_end[p, ia] * scale), (x0, -table.k_end[p, ia] * scale)])
            jc.append(cm(np.clip(norm(table.e_carried[j]), 0, 1)))
        if jumps:
            ax.add_collection(LineCollection(jumps, colors=jc, linewidths=0.6, alpha=0.6, zorder=1))

    reps = np.arange(1, len(tm.dur))
    if rep_range is not None:
        reps = reps[(reps >= rep_range[0]) & (reps <= rep_range[1])]
    for r in reps:
        if tm.has_adc[r]:
            a, b = tm.adc_span[r] / tm.dur[r]
            ax.axvspan(r - 1 + a, r - 1 + b, color="0.85", lw=0, zorder=0)
    # echo markers: measured + states whose k(axis) crosses 0 during the readout
    if axis != "tau":
        kad = table.k_adc()
        em = np.where(keep & (table.typ == 0) & (table.emitted >= threshold)
                      & tm.has_adc[table.rep])[0]
        for i in em:
            r = table.rep[i]
            ax.plot(r - 1 + tm.t_adc[r] / tm.dur[r], kad[i, ia] * scale, "o",
                    ms=2 + 5 * table.emitted[i], mfc="none", mec="crimson", mew=0.8, zorder=4)

    ax.autoscale_view()
    lo = reps.min() - 1 if len(reps) else 0
    hi = reps.max() if len(reps) else 1
    ax.set_xlim(lo, hi)
    _mark_long_reps(ax, tm, reps)
    ax.axhline(0, color="0.5", lw=0.5, zorder=0)
    ax.set_xlabel("repetition (time inside each repetition stretched to unit width)")
    ax.set_ylabel(f"{axis} [{AXIS_UNIT[axis]}]")
    if colorbar:
        sm = plt.cm.ScalarMappable(norm=norm, cmap=cm)
        cb = plt.colorbar(sm, ax=ax, pad=0.01)
        cb.set_label({"latent": "latent signal", "emitted": "emitted signal",
                      "latent_global": "latent signal, unnormalised / global max"}[metric]
                     + "  (red line: threshold)")
        cb.ax.axhline(threshold, color="crimson", lw=1.5)
    if legend:
        handles = [Line2D([], [], color="0.2", lw=2, label="+ state (transverse)"),
                   Line2D([], [], color="0.2", lw=1.2, ls=(0, (2, 1.5)), label="z state (stored)"),
                   Line2D([], [], color="0.2", lw=0.6, label="refocusing jump k -> -k"),
                   Line2D([], [], ls="", marker="o", mfc="none", mec="crimson",
                          label="measured echo"),
                   Patch(color="0.85", label="ADC window"),
                   Line2D([], [], color="0.6", lw=2, label="grey: below min_latent (pruned)")]
        if not show_z:
            handles.pop(1)
        ax.legend(handles=handles, loc="lower left", bbox_to_anchor=(0, 1.0), ncol=6,
                  fontsize=7, frameon=False, borderaxespad=0.2)
    return ax


CLASS_NAMES = ("dead (latent = 0)", "pruned (< min_latent)", "simulated, not measured",
               "measured")
CLASS_COLORS = ("#d9d9d9", "#f4a582", "#92c5de", "#0571b0")


def plot_budget(table: PDGTable, axs=None, axis="k_x", min_emitted=1e-2, min_latent=1e-2):
    """Threshold-aware view of the graph.

    Left: + states above the zero line, z states mirrored below it (y = |k|),
    coloured by what ``execute_graph`` does with them. Right: state count per
    repetition per class, and how many states each threshold would keep.
    """
    if axs is None:
        fig, axs = plt.subplots(1, 3, figsize=(16, 4.5), gridspec_kw={"width_ratios": [2.2, 1.2, 1]})
    cls = table.classify(min_emitted, min_latent)
    ia = AXES[axis]
    scale = 1e3 if axis == "tau" else 1.0
    cmap = ListedColormap(CLASS_COLORS)
    ax = axs[0]
    for t, sign, mk in ((0, 1, "o"), (1, -1, "s")):
        sel = table.typ == t
        o = np.argsort(cls[sel])
        y = np.abs(table.k_end[sel, ia])[o] * scale * sign
        size = np.where(cls[sel][o] == 0, 3, 10)
        ax.scatter(table.rep[sel][o], y, c=cls[sel][o], cmap=cmap, vmin=-0.5, vmax=3.5,
                   s=size, marker=mk, lw=0)
    ax.axhline(0, color="k", lw=0.6)
    ax.set_xlabel("repetition")
    ax.set_ylabel(f"|{axis}| [{AXIS_UNIT[axis]}]   (+ states up, z states down)")
    ax.legend(handles=[Patch(color=c, label=n) for c, n in zip(CLASS_COLORS, CLASS_NAMES)],
              fontsize=7, loc="lower left", bbox_to_anchor=(0, 1.0), ncol=4, frameon=False,
              borderaxespad=0.2)

    ax = axs[1]
    reps = np.arange(table.rep.max() + 1)
    bottom = np.zeros(len(reps))
    for c in (3, 2, 1, 0):
        cnt = np.bincount(table.rep[(cls == c) & (table.typ != 2)], minlength=len(reps))
        ax.bar(reps, cnt, bottom=bottom, width=1.0, color=CLASS_COLORS[c], lw=0)
        bottom += cnt
    ax.set_xlabel("repetition")
    ax.set_ylabel("states per repetition")
    ax.set_xlim(0.5, reps[-1] + 0.5)

    ax = axs[2]
    thr = np.logspace(-6, 0, 121)
    for t, ls, name in ((0, "-", "+"), (1, "--", "z")):
        v = table.latent[table.typ == t]
        ax.plot(thr, [(v >= x).sum() for x in thr], ls, color="k", label=f"{name} states kept")
    emit = table.emitted[table.typ == 0]
    ax.plot(thr, [(emit >= x).sum() for x in thr], ":", color=CLASS_COLORS[3],
            label="+ states measured")
    ax.axvline(min_latent, color="crimson", lw=1)
    ax.set_xscale("log")
    ax.set_xlabel("threshold (min_latent / min_emitted)")
    ax.set_ylabel("states kept (whole sequence)")
    ax.legend(fontsize=7)
    ax.grid(alpha=0.3, which="both")
    return axs


def relaxation_image(spectrum: dict, which="t2", bins=None, signed=False):
    """(bins, image) behind :func:`plot_relaxation_map`; columns are readouts."""
    reps = sorted(spectrum)
    col = {"t2": 0, "t1s": 1}[which]
    allv = np.concatenate([spectrum[r][col] for r in reps])
    allw = np.concatenate([spectrum[r][2] for r in reps])
    if bins is None:
        # pathway times are sums of repetition durations: put one bin on each
        # distinct value that carries signal, so the grid does not alias
        u = np.unique(np.round(allv[allw > 1e-4 * allw.max()], 4))
        hi = np.quantile(allv[allw > 0], 0.999) if (allw > 0).any() else 1.0
        u = u[u <= hi * 1.001]
        if 1 < len(u) <= 400:
            mid = (u[1:] + u[:-1]) / 2
            step = np.diff(u).min()
            bins = np.concatenate([[u[0] - step / 2], mid, [u[-1] + step / 2]])
        else:
            bins = np.linspace(0, max(hi, 1e-3) * 1.05, 80)
    img = np.zeros((len(bins) - 1, len(reps)))
    for n, r in enumerate(reps):
        v, w = spectrum[r][col], spectrum[r][2]
        v = np.clip(v, bins[0], bins[-1] - 1e-12)
        if signed:
            h, _ = np.histogram(v, bins, weights=w)
            img[:, n] = h / max(w.sum(), 1e-30)
        else:
            h, _ = np.histogram(v, bins, weights=np.clip(w, 0, None))
            img[:, n] = h / max(np.clip(w, 0, None).sum(), 1e-30)
    return bins, img


def plot_relaxation_map(spectrum: dict, ax, which="t2", bins=None, title=None,
                        unit_ms=True, cmap="magma_r", signed=False):
    """Readout x (T2 time | storage time) image of the measured signal fraction.

    ``signed=True`` keeps the sign of each pathway's projected contribution
    (red adds to the echo, blue cancels part of it) on a diverging symlog
    scale. RF spoiling shows up as bands of both signs that beat across the
    readouts; it suppresses old coherences by cancellation, not by removing
    them. In a CPMG train with refocusing angle a > 90 deg, pathways that stay
    stored through a pulse pick up cos(a) < 0 and enter blue.
    """
    bins, img = relaxation_image(spectrum, which, bins, signed)
    f = 1e3 if unit_ms else 1
    x = np.arange(img.shape[1] + 1) - 0.5
    if signed:
        img = np.ma.masked_inside(img, -1e-3, 1e-3)
        im = ax.pcolormesh(x, bins * f, img, cmap="RdBu_r", shading="flat",
                           norm=SymLogNorm(linthresh=1e-3, vmin=-1, vmax=1))
    else:
        img = np.ma.masked_less(img, 1e-3)
        im = ax.pcolormesh(x, bins * f, img, cmap=cmap, norm=LogNorm(vmin=1e-3, vmax=1),
                           shading="flat")
    ax.set_xlabel("readout #")
    ax.set_ylabel({"t2": "time transverse = pathway TE [ms]",
                   "t1s": "time stored as dephased z [ms]"}[which])
    if title:
        ax.set_title(title, fontsize=10)
    return im


def plot_fingerprint(table: PDGTable, fp: dict, ky=None, axs=None, spectrum=None):
    """Effective TE, stimulated-echo share and k-space position per readout."""
    if axs is None:
        fig, axs = plt.subplots(2, 1, figsize=(10, 6), sharex=True)
    x = np.arange(len(fp["rep"]))
    ax = axs[0]
    ax.plot(x, fp["te_eff"] * 1e3, "-", color="k",
            label="TE_eff = -dlnS/dR2 (weighted mean pathway TE)")
    ax.plot(x, fp["te_prim"] * 1e3, ".", color="crimson", ms=4,
            label="primary echo TE (longest unstored pathway)")
    if ky is not None and len(ky) == len(x):
        c = int(np.nanargmin(np.abs(ky)))
        ax.axvline(c, color="tab:blue", lw=1)
        ax.annotate(f"k-space centre\nTE_eff = {fp['te_eff'][c]*1e3:.1f} ms\n"
                    f"primary echo {fp['te_prim'][c]*1e3:.1f} ms",
                    (c, fp["te_eff"][c] * 1e3), xytext=(8, -34), textcoords="offset points",
                    fontsize=8, color="tab:blue")
    ax.set_ylabel("TE [ms]")
    ax.legend(fontsize=7, loc="upper left")
    ax.grid(alpha=0.3)
    ax = axs[1]
    ax.bar(x, fp["ste_frac"] * 100, color="tab:orange", width=0.8,
           label="share via dephased z storage (stimulated-echo type)")
    ax.set_ylabel("stored share [%]")
    ax.set_xlabel("readout #")
    ax.grid(alpha=0.3)
    if ky is not None and len(ky) == len(x):
        ax2 = ax.twinx()
        ax2.plot(x, ky, "-", color="tab:blue", lw=1)
        ax2.set_ylabel("k_y of readout [1/m]", color="tab:blue")
        ax.axvline(int(np.nanargmin(np.abs(ky))), color="tab:blue", lw=1)
    ax.legend(fontsize=7, loc="upper left")
    return axs


def relaxation_sensitivity(seq, data, params: dict, max_state_count=200, min_state_mag=1e-4,
                           eps=0.02, min_emitted=1e-2, keys=("T1", "T2", "T2dash")):
    """d ln(echo amplitude) / d ln(param) per readout, by central differences.

    Each derivative costs two extra prepasses (``compute_graph_ext``), which
    run in milliseconds. The exponents are "% signal change per % parameter change":
      T2:     TE_eff / T2 (> 0); 0 means no T2 weighting
      T1:     < 0 saturation-type T1 weighting (longer T1 -> less signal),
              > 0 stimulated-echo storage or inversion-type gain
      T2dash: |tau| at the echo / T2'; ~0 for spin echoes
    """
    import MRzeroCore as mr0

    def amp(p):
        g = mr0.compute_graph_ext(seq, p["T1"], p["T2"], p["T2dash"], p["D"], max_state_count,
                                  min_state_mag, data.nyquist.tolist(), data.size.tolist(),
                                  data.avg_B1_trig)
        t = PDGTable.from_graph(g, seq, **p)
        return echo_amplitude(t, p["T2"], p["T2dash"], min_emitted)[1]

    out = {"amp": amp(params)}
    for key in keys:
        up, dn = dict(params), dict(params)
        up[key] *= 1 + eps
        dn[key] *= 1 - eps
        with np.errstate(divide="ignore", invalid="ignore"):
            out[key] = (np.log(amp(up)) - np.log(amp(dn))) / (np.log1p(eps) - np.log1p(-eps))
    return out


def train_breaks(fp: dict, drop=0.5):
    """Readout indices that start a new echo train (primary TE falls back)."""
    te = fp["te_prim"]
    return np.where(te[1:] < drop * te[:-1])[0] + 1


def plot_compass(sens: dict, ky, ax, tissues=None, title=None, breaks=()):
    """Contrast compass: every readout placed by its T1 and T2 weighting exponent.

    x = -dlnS/dlnT1 (T1 weighting: 0 none, 1 full saturation-type),
    y = dlnS/dlnT2 (T2 weighting, = TE_eff/T2). One trace per tissue, readouts
    in acquisition order, the k-space centre readout as a star. Where the stars
    sit is the image contrast; how far a trace wanders is the k-space
    modulation (blurring / ghosting) of that tissue.
    """
    tissues = tissues or list(sens)
    c = int(np.nanargmin(np.abs(ky)))
    w = np.abs(ky) / max(np.nanmax(np.abs(ky)), 1e-12)
    edges = [0, *breaks, len(ky)]
    markers = "o^sDv"
    for name in tissues:
        s = sens[name]
        x, y = -s["T1"], s["T2"]
        col = TISSUE_COLORS.get(name, "k")
        for n, (a, b) in enumerate(zip(edges[:-1], edges[1:])):
            ax.plot(x[a:b], y[a:b], "-", color=col, lw=0.7, alpha=0.5)
            ax.scatter(x[a:b], y[a:b], s=8 + 30 * (1 - w[a:b]) ** 4, color=col,
                       marker=markers[n % len(markers)], lw=0, alpha=0.7)
        ax.plot(x[c], y[c], "*", ms=16, mfc=col, mec="k", mew=0.8,
                label=f"{name.upper()}  T1w {x[c]:.2f}  T2w {y[c]:.2f}")
    if len(edges) > 2:
        ax.text(0.99, 0.02, "  ".join(f"{markers[n % len(markers)]} train {n + 1}"
                                      for n in range(len(edges) - 1)),
                transform=ax.transAxes, ha="right", va="bottom", fontsize=7, color="0.3")
    ax.axhline(0, color="0.6", lw=0.6)
    ax.axvline(0, color="0.6", lw=0.6)
    ax.set_xlabel("T1 weighting  -dlnS/dlnT1   (> 0: longer T1 -> darker)")
    ax.set_ylabel("T2 weighting  dlnS/dlnT2  = TE_eff / T2")
    ax.legend(fontsize=7, loc="best", title="star = k-space centre", title_fontsize=7)
    ax.grid(alpha=0.3)
    if title:
        ax.set_title(title, fontsize=10)
    return ax


def match_states(tables: dict, axis_keys=(0, 1, 2, 3), tol=(0.5, 0.5, 0.5, 2e-5)):
    """Match states across graphs of the same sequence by (rep, type, rounded kt)."""
    keys = {}
    for name, t in tables.items():
        q = np.round(t.k_end[:, list(axis_keys)] / np.asarray(tol)).astype(np.int64)
        keys[name] = [(int(r), int(ty), *map(int, k)) for r, ty, k in zip(t.rep, t.typ, q)]
    union = sorted(set().union(*[set(k) for k in keys.values()]))
    index = {k: i for i, k in enumerate(union)}
    return union, {n: np.array([index[k] for k in ks]) for n, ks in keys.items()}


def plot_tissue_rgb(tables: dict, ax, axis="k_x", channels=("wm", "gm", "csf"),
                    metric="latent", vmin=1e-3, s=14, threshold=1e-2):
    """Each state coloured by its latent signal in three tissues (RGB).

    White: every tissue needs the state. A pure hue: only that tissue keeps a
    path from this state to a readout. Uses (rep, |k|) with + states up and z
    states down like ``plot_budget``. The box lists how many states each
    tissue keeps at ``threshold`` and how many the union needs, which is what
    ``compute_graph(..., tissues=...)`` builds.
    """
    union, idx = match_states({c: tables[c] for c in channels})
    n = len(union)
    rgb = np.zeros((n, 3))
    need = np.zeros((n, len(channels)), bool)
    for ch, name in enumerate(channels):
        t = tables[name]
        v = {"latent": t.latent, "emitted": t.emitted}[metric]
        lv = np.clip((np.log10(np.maximum(v, 1e-30)) - np.log10(vmin)) / -np.log10(vmin), 0, 1)
        np.maximum.at(rgb[:, ch], idx[name], np.sqrt(lv))
        need[idx[name][(v >= threshold) & (t.typ != 2)], ch] = True
    rep = np.array([u[0] for u in union])
    typ = np.array([u[1] for u in union])
    ia = AXES[axis]
    kval = np.zeros(n)
    for name in channels:
        t = tables[name]
        kval[idx[name]] = t.k_end[:, ia]
    scale = 1e3 if axis == "tau" else 1.0
    show = rgb.max(1) > 0
    bright = rgb.sum(1)
    o = np.argsort(bright[show])
    y = np.abs(kval) * scale * np.where(typ == 0, 1, -1)
    ax.set_facecolor("black")
    ax.scatter(rep[show][o], y[show][o], c=rgb[show][o], s=s, lw=0, marker="s")
    ax.axhline(0, color="0.4", lw=0.5)
    ax.set_xlabel("repetition")
    ax.set_ylabel(f"|{axis}| [{AXIS_UNIT[axis]}]   (+ up, z down)")
    names = [c.upper() for c in channels]
    ax.legend(handles=[Patch(color=c, label=f"{l} only") for c, l in
                       zip(("red", "lime", "dodgerblue"), names)] +
              [Patch(color="white", label="all tissues")],
              fontsize=7, loc="upper left", ncol=4, facecolor="0.15", labelcolor="white")
    counts = [f"{nm}: {need[:, ch].sum()}" for ch, nm in enumerate(names)]
    only = [f"{nm} only: {(need[:, ch] & ~np.delete(need, ch, 1).any(1)).sum()}"
            for ch, nm in enumerate(names)]
    ax.text(0.99, 0.02, f"states with latent >= {threshold:g}\n" + "   ".join(counts)
            + f"\nunion: {need.any(1).sum()}   " + "   ".join(only),
            transform=ax.transAxes, ha="right", va="bottom", fontsize=7, color="white",
            bbox=dict(fc="0.15", ec="0.4", lw=0.5))
    return ax


def echo_amplitude(table: PDGTable, T2: float, T2dash: float, min_emitted=1e-2,
                   k_tol=(2.0, 2.0, 2.0, 2e-4)):
    """Echo amplitude per readout, without the prepass's (1+|k|)^-2.2 factor.

    The prepass ``signal`` multiplies by (1+|k|)^-2.2 over the full k vector,
    phase encoding included, so it mostly tracks where the readout sits in
    k-space. For contrast this uses |magnetisation| of the measured states at
    the ADC centre instead (T2 decay to the ADC centre, T2' from tau). States
    closer than ``k_tol`` (the prepass grid splits one echo into neighbours)
    add coherently, distinct echoes add in magnitude. MRzero stores + states
    scaled by 1/sqrt(2) (``execute_graph`` multiplies by sqrt(2)); the result
    is rescaled to units of M0, so a fresh FID reads sin(FA).
    """
    tm = table.timing
    kad = table.k_adc()
    reps = np.where(tm.has_adc)[0]
    out = np.zeros(len(reps))
    for n, r in enumerate(reps):
        sel = np.where((table.rep == r) & (table.typ == 0) & (table.emitted >= min_emitted))[0]
        if len(sel) == 0:
            continue
        m = (np.sqrt(2) * table.mag_start[sel] * np.exp(-tm.t_adc[r] / T2)
             * np.exp(-np.abs(kad[sel, 3]) / T2dash))
        key = np.round(kad[sel] / np.asarray(k_tol)).astype(np.int64)
        _, grp = np.unique(key, axis=0, return_inverse=True)
        coh = np.zeros(grp.max() + 1, complex)
        np.add.at(coh, grp.ravel(), m)
        out[n] = np.abs(coh).sum()
    return reps, out


def readout_ky(table: PDGTable, min_emitted=1e-2):
    """k_y at the ADC centre of the strongest measured state of each readout."""
    kad = table.k_adc()
    reps = np.where(table.timing.has_adc)[0]
    ky = np.full(len(reps), np.nan)
    for n, r in enumerate(reps):
        sel = np.where((table.rep == r) & (table.typ == 0))[0]
        if len(sel):
            ky[n] = kad[sel[np.argmax(table.emitted[sel])], 1]
    return ky


TISSUE_COLORS = {"wm": "tab:red", "gm": "tab:green", "csf": "tab:blue", "fat": "tab:olive",
                 "mean": "k"}


def plot_tissue_curves(amps: dict, ky, ax, title=None, pairs=(("wm", "gm"), ("gm", "csf"))):
    """Echo amplitude per readout for each tissue; contrast at the k-space centre."""
    x = np.arange(len(ky))
    c = int(np.nanargmin(np.abs(ky)))
    for name, a in amps.items():
        ax.plot(x, a, "-", color=TISSUE_COLORS.get(name, None), lw=1.5 if name != "mean" else 1,
                ls="-" if name != "mean" else ":", label=name.upper())
    ax.axvline(c, color="0.3", lw=1, ls="--")
    lines = [f"k-space centre = readout {c}"]
    for a, b in pairs:
        if a in amps and b in amps and amps[b][c] > 0:
            lines.append(f"{a.upper()}/{b.upper()} = {amps[a][c] / amps[b][c]:.2f}")
    ax.text(0.02, 0.03, "\n".join(lines), transform=ax.transAxes, va="bottom", fontsize=8,
            bbox=dict(fc="white", ec="0.8", lw=0.5))
    ax.set_xlabel("readout #")
    ax.set_ylabel("echo amplitude |M_xy| at ADC [M0]")
    ax.legend(fontsize=7, loc="upper right")
    ax.grid(alpha=0.3)
    if title:
        ax.set_title(title, fontsize=10)
    return ax
