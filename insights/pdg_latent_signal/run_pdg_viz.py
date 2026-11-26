"""Build FLASH and TSE from the MRzero playground, compute their PDGs, render all views.

    pip install MRzeroCore "pypulseq==1.5.0post1"
    python run_pdg_viz.py [--phantom numerical_brain_cropped.mat] [--out figures]

Run it from a separate environment: this repo's own ``pypulseq/`` folder is a
namespace package and shadows an installed pypulseq when run from the repo root.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import warnings

import numpy as np
import torch
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import SymLogNorm

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import MRzeroCore as mr0  # noqa: E402
import pdg_viz as pv  # noqa: E402
from seqs import seq_flash, seq_tse  # noqa: E402

warnings.filterwarnings("ignore", category=UserWarning)

# MRzero-Core documentation/src/state_selection.md
TISSUES = {
    "wm": {"T1": 0.83, "T2": 0.075, "T2dash": 0.18, "D": 0.65},
    "gm": {"T1": 1.56, "T2": 0.083, "T2dash": 0.32, "D": 0.83},
    "csf": {"T1": 4.16, "T2": 1.65, "T2dash": 0.059, "D": 3.19},
    "fat": {"T1": 0.37, "T2": 0.125, "T2dash": 0.012, "D": 0.1},
}

# graph settings exactly as in the playground notebooks
CASES = {
    "flash": dict(builder=seq_flash, N=64, max_state_count=200, min_state_mag=1e-3,
                  title="FLASH 2D, 64x64, FA 10 deg, TR 10.6 ms, RF spoiling 117 deg"),
    "tse": dict(builder=seq_tse, N=42, max_state_count=2000, min_state_mag=1e-4,
                title="TSE 2D, 42x42, 90/120 deg, ESP 7.5 ms, 2 shots, linear order"),
}
MIN_EMITTED = MIN_LATENT = 1e-2


def _save(fig, path, **kw):
    """Save, close, and store as a 256-colour palette PNG (about 3x smaller)."""
    from PIL import Image

    fig.savefig(path, **kw)
    plt.close(fig)
    Image.open(path).convert("RGB").quantize(256, method=Image.Quantize.MEDIANCUT).save(
        path, optimize=True)


def run_case(name, cfg, phantom, out):
    seq, meta = cfg["builder"]()
    seq_path = os.path.join(out, f"{name}.seq")
    seq.write(seq_path)
    seq0 = mr0.Sequence.import_file(seq_path)
    data = phantom.interpolate(cfg["N"], cfg["N"], 1).build()
    mean = {k: float(torch.mean(getattr(data, k))) for k in ("T1", "T2", "T2dash", "D")}

    graph = mr0.compute_graph(seq0, data, cfg["max_state_count"], cfg["min_state_mag"])
    table = pv.PDGTable.from_graph(graph, seq0, **mean)

    tissue_tables = {}
    for tname, p in TISSUES.items():
        g = mr0.compute_graph_ext(seq0, p["T1"], p["T2"], p["T2dash"], p["D"],
                                  cfg["max_state_count"], cfg["min_state_mag"],
                                  data.nyquist.tolist(), data.size.tolist(), data.avg_B1_trig)
        tissue_tables[tname] = pv.PDGTable.from_graph(g, seq0, **p)
    sens = {tname: pv.relaxation_sensitivity(seq0, data, p, cfg["max_state_count"],
                                             cfg["min_state_mag"], min_emitted=MIN_EMITTED)
            for tname, p in TISSUES.items()}
    return seq0, data, graph, table, tissue_tables, sens, mean


def fig_baseline(graphs, out):
    fig, axs = plt.subplots(1, 3, figsize=(18, 4.6))
    for ax, (name, g, dephasing) in zip(axs, [("FLASH", graphs["flash"], "tau"),
                                              ("TSE", graphs["tse"], "tau"),
                                              ("TSE", graphs["tse"], "k_x")]):
        plt.sca(ax)
        g.plot(dephasing=dephasing, color="latent signal")
        ax.set_title(f"{name}: graph.plot(dephasing='{dephasing}', color='latent signal')",
                     fontsize=10)
    fig.tight_layout()
    _save(fig, os.path.join(out, "fig01_baseline.png"), dpi=100)

def fig_phase(name, table, cfg, out):
    zoom = (1, 8)
    fig = plt.figure(figsize=(17, 8.8))
    gs = fig.add_gridspec(2, 2, width_ratios=[1.7, 1], hspace=0.42, wspace=0.12)
    ax = fig.add_subplot(gs[0, :])
    pv.plot_phase_diagram(table, ax, axis="k_x", threshold=MIN_LATENT, max_points=12)
    ax.set_title(f"{cfg['title']}: latent-weighted phase diagram, k_x", fontsize=11, pad=22)
    ax = fig.add_subplot(gs[1, 0])
    pv.plot_phase_diagram(table, ax, axis="k_x", threshold=MIN_LATENT, rep_range=zoom,
                          colorbar=False, legend=False)
    ax.set_title(f"zoom: repetitions {zoom[0]}-{zoom[1]} (k_x)", fontsize=10)
    ax = fig.add_subplot(gs[1, 1])
    pv.plot_phase_diagram(table, ax, axis="tau", threshold=MIN_LATENT, rep_range=zoom,
                          colorbar=False, legend=False)
    ax.set_title(f"zoom: repetitions {zoom[0]}-{zoom[1]} (tau)", fontsize=10)
    _save(fig, os.path.join(out, f"fig02_phase_diagram_{name}.png"), dpi=100,
                bbox_inches="tight")

def fig_budget(name, table, cfg, out):
    fig, axs = plt.subplots(1, 3, figsize=(17, 4.8), gridspec_kw={"width_ratios": [2.2, 1.2, 1]})
    pv.plot_budget(table, axs, axis="k_x", min_emitted=MIN_EMITTED, min_latent=MIN_LATENT)
    axs[0].set_title(f"{cfg['title']}\nwhat execute_graph does with each state", fontsize=10,
                     pad=20)
    axs[1].set_title("states per repetition", fontsize=10)
    axs[2].set_title("states kept vs. threshold", fontsize=10)
    fig.tight_layout()
    _save(fig, os.path.join(out, f"fig03_budget_{name}.png"), dpi=100)

def fig_fingerprint(name, table, mean, cfg, out):
    spec = pv.relaxation_spectrum(table, mean["T1"], mean["T2"], MIN_EMITTED)
    fp = pv.fingerprint(spec)
    ky = pv.readout_ky(table, MIN_EMITTED)
    fig = plt.figure(figsize=(17, 7.5))
    gs = fig.add_gridspec(2, 3, width_ratios=[1, 1, 1.15], hspace=0.35, wspace=0.5)
    pv.plot_relaxation_map(spec, fig.add_subplot(gs[:, 0]), "t2", signed=True,
                           title="signal share by pathway TE (time transverse)")
    ax = fig.add_subplot(gs[:, 1])
    im = pv.plot_relaxation_map(spec, ax, "t1s", signed=True,
                                title="signal share by time stored in dephased z")
    cb = fig.colorbar(im, ax=ax, pad=0.02)
    cb.set_label("signed fraction of readout signal")
    fig.text(0.5, 0.005, "red: pathway adds to the echo   blue: pathway cancels part of it",
             ha="center", fontsize=9)
    pv.plot_fingerprint(table, fp, ky, axs=[fig.add_subplot(gs[0, 2]), fig.add_subplot(gs[1, 2])])
    fig.suptitle(f"{cfg['title']}: relaxation fingerprint of every readout (mean tissue "
                 f"T1={mean['T1']*1e3:.0f} ms, T2={mean['T2']*1e3:.0f} ms)", fontsize=11)
    _save(fig, os.path.join(out, f"fig04_fingerprint_{name}.png"), dpi=100, bbox_inches="tight")
    return spec, fp, ky


def tissue_amps(tissue_tables):
    return {tname: pv.echo_amplitude(t, TISSUES[tname]["T2"], TISSUES[tname]["T2dash"],
                                     MIN_EMITTED)[1]
            for tname, t in tissue_tables.items()}


def fig_tissue(name, tissue_tables, amps, cfg, ky, out):
    fig, axs = plt.subplots(1, 2, figsize=(17, 5), gridspec_kw={"width_ratios": [1, 1.25]})
    pv.plot_tissue_curves(amps, ky, axs[0], title="echo amplitude per readout, one prepass per tissue")
    pv.plot_tissue_rgb(tissue_tables, axs[1], axis="k_x")
    axs[1].set_title("latent signal per tissue as RGB (R = WM, G = GM, B = CSF); "
                     "brightness = log10 latent from 1e-3 to 1", fontsize=10)
    fig.suptitle(cfg["title"], fontsize=11)
    fig.tight_layout()
    _save(fig, os.path.join(out, f"fig05_tissue_{name}.png"), dpi=100)

def fig_compass(results, out):
    fig, axs = plt.subplots(1, 2, figsize=(15, 6.2))
    for ax, name in zip(axs, ("flash", "tse")):
        r = results[name]
        pv.plot_compass(r["sens"], r["ky"], ax, tissues=("wm", "gm", "csf", "fat"),
                        title=CASES[name]["title"], breaks=pv.train_breaks(r["fp"]))
    lim_x = [min(a.get_xlim()[0] for a in axs), max(a.get_xlim()[1] for a in axs)]
    lim_y = [min(a.get_ylim()[0] for a in axs), max(a.get_ylim()[1] for a in axs)]
    for a in axs:
        a.set_xlim(lim_x)
        a.set_ylim(lim_y)
    fig.suptitle("contrast compass: every readout by its T1 and T2 weighting exponent "
                 "(dot size grows towards the k-space centre)", fontsize=11)
    fig.tight_layout()
    _save(fig, os.path.join(out, "fig06_compass.png"), dpi=100)

def fig_dashboard(name, table, tissue_tables, spec, fp, ky, amps, sens, cfg, out):
    fig = plt.figure(figsize=(19, 10))
    gs = fig.add_gridspec(2, 3, width_ratios=[1.6, 1, 1], hspace=0.38, wspace=0.42)
    ax = fig.add_subplot(gs[0, :2])
    pv.plot_phase_diagram(table, ax, axis="k_x", threshold=MIN_LATENT,
                          rep_range=(1, min(12, table.rep.max())))
    ax.set_title("A  how echoes form: latent-weighted phase diagram (first 12 repetitions)",
                 fontsize=10, loc="left", pad=22)
    ax = fig.add_subplot(gs[0, 2])
    pv.plot_compass(sens, ky, ax, tissues=("wm", "gm", "csf"), breaks=pv.train_breaks(fp))
    ax.set_title("B  contrast compass (star = k-space centre)", fontsize=10, loc="left")
    ax = fig.add_subplot(gs[1, 0])
    pv.plot_tissue_curves(amps, ky, ax)
    ax.set_title("C  tissue signal along the acquisition (per-tissue prepass)", fontsize=10,
                 loc="left")
    ax = fig.add_subplot(gs[1, 1])
    im = pv.plot_relaxation_map(spec, ax, "t2", signed=True)
    x = np.arange(len(fp["rep"]))
    ax.plot(x, fp["te_eff"] * 1e3, "-", color="k", lw=1.2, label="TE_eff = -dlnS/dR2")
    ax.legend(fontsize=7, loc="upper left")
    fig.colorbar(im, ax=ax, pad=0.02).set_label("signed fraction")
    ax.set_title("D  where each readout's signal comes from (pathway TE;\n"
                 "    red adds, blue cancels)", fontsize=10, loc="left")
    ax = fig.add_subplot(gs[1, 2])
    pv.plot_tissue_rgb(tissue_tables, ax, axis="k_x", s=8)
    ax.set_title("E  which tissue needs which state (latent RGB)", fontsize=10, loc="left")
    fig.suptitle(f"{cfg['title']}: PDG at first sight", fontsize=12)
    _save(fig, os.path.join(out, f"fig07_dashboard_{name}.png"), dpi=100, bbox_inches="tight")

def fig_truncation(phantom, out, settings=((200, 1e-3), (2000, 1e-5))):
    """FLASH pathway map at a converged prepass budget and what the notebook's
    budget gets wrong: per-readout pathway difference and echo amplitude."""
    cfg = CASES["flash"]
    seq0 = mr0.Sequence.import_file(os.path.join(out, "flash.seq"))
    data = phantom.interpolate(cfg["N"], cfg["N"], 1).build()
    mean = {k: float(torch.mean(getattr(data, k))) for k in ("T1", "T2", "T2dash", "D")}
    fig, axs = plt.subplots(1, 3, figsize=(17, 5), gridspec_kw={"width_ratios": [1, 1, 1.1]})
    amps, sigs, specs, n = {}, {}, {}, {}
    for msc, msm in settings:
        g = mr0.compute_graph(seq0, data, msc, msm)
        t = pv.PDGTable.from_graph(g, seq0, **mean)
        specs[msc] = pv.relaxation_spectrum(t, mean["T1"], mean["T2"], MIN_EMITTED)
        n[msc] = t.n
        amps[msc] = pv.echo_amplitude(t, mean["T2"], mean["T2dash"], MIN_EMITTED)[1]
        sigs[msc] = mr0.execute_graph(g, seq0, data, MIN_EMITTED, MIN_LATENT,
                                      print_progress=False)
    (a, msm_a), (b, msm_b) = settings
    im = pv.plot_relaxation_map(specs[b], axs[0], "t2", signed=True)
    fig.colorbar(im, ax=axs[0], pad=0.02).set_label("signed fraction (red adds, blue cancels)")
    axs[0].set_title(f"converged: compute_graph(seq, data, {b}, {msm_b:g}), {n[b]} states",
                     fontsize=10)
    bins, img_b = pv.relaxation_image(specs[b], "t2", signed=True)
    _, img_a = pv.relaxation_image(specs[a], "t2", bins=bins, signed=True)
    diff = np.ma.masked_inside(img_a - img_b, -1e-4, 1e-4)
    x = np.arange(diff.shape[1] + 1) - 0.5
    im = axs[1].pcolormesh(x, bins * 1e3, diff, cmap="PuOr_r", shading="flat",
                           norm=SymLogNorm(linthresh=1e-3, vmin=-0.1, vmax=0.1))
    fig.colorbar(im, ax=axs[1], pad=0.02).set_label(f"{a}-state minus {b}-state fraction")
    worst = int(np.argmax(np.abs(img_a - img_b).sum(0)))
    axs[1].set_title(f"notebook budget ({a}, {msm_a:g}, {n[a]} states) minus converged;\n"
                     f"worst readout {worst}: {100 * np.abs(img_a - img_b)[:, worst].sum():.1f} %"
                     " of its signal re-attributed", fontsize=10)
    axs[1].set_xlabel("readout #")
    for ax in axs[:2]:
        ax.set_ylim(0, 120)
    axs[0].set_ylabel("time transverse = pathway TE [ms]")
    ax = axs[2]
    ax.plot(100 * (amps[a] / amps[b] - 1), "k.-", lw=0.8)
    ax.axhline(0, color="0.5", lw=0.6)
    ax.set_xlabel("readout #")
    ax.set_ylabel(f"echo amplitude, {a} vs {b} states [% deviation]")
    err = float((sigs[a] - sigs[b]).abs().norm() / sigs[b].abs().norm())
    ax.set_title(f"execute_graph signal: {100 * err:.2f} % relative L2 error", fontsize=10)
    ax.grid(alpha=0.3)
    fig.suptitle("FLASH: is the prepass budget large enough? Pathway difference shows which "
                 "coherences a smaller graph misses or misplaces", fontsize=11, y=1.04)
    fig.tight_layout()
    _save(fig, os.path.join(out, "fig08_flash_truncation.png"), dpi=100, bbox_inches="tight")
    return err


def fig_rf_spoiling(phantom, out, increments=(0, 50, 117, 150)):
    """FLASH pathway-TE map for several RF spoiling increments (converged prepass)."""
    cfg = CASES["flash"]
    data = phantom.interpolate(cfg["N"], cfg["N"], 1).build()
    mean = {k: float(torch.mean(getattr(data, k))) for k in ("T1", "T2", "T2dash", "D")}
    fig, axs = plt.subplots(1, len(increments), figsize=(4.3 * len(increments) + 1, 4.6),
                            sharey=True)
    leak = {}
    for ax, inc in zip(axs, increments):
        seq, _ = seq_flash(rf_spoiling_inc=float(inc))
        path = os.path.join(out, "_flash_spoil.seq")
        seq.write(path)
        seq0 = mr0.Sequence.import_file(path)
        g = mr0.compute_graph(seq0, data, 2000, 1e-5)
        t = pv.PDGTable.from_graph(g, seq0, **mean)
        spec = pv.relaxation_spectrum(t, mean["T1"], mean["T2"], MIN_EMITTED)
        im = pv.plot_relaxation_map(spec, ax, "t2", signed=True)
        ax.set_ylim(0, 150)
        old = []
        for r in sorted(spec)[20:]:
            t2, _, w = spec[r]
            u, inv = np.unique(np.round(t2, 4), return_inverse=True)
            per_te = np.bincount(inv, weights=w)
            old.append(np.abs(per_te[u > 6e-3]).sum() / w.sum())
        leak[inc] = float(np.mean(old))
        ax.set_title(f"RF increment {inc} deg: older coherences\ncarry {100 * leak[inc]:.0f} % "
                     "(mean |share|, readouts 20+)", fontsize=10)
        if ax is not axs[0]:
            ax.set_ylabel("")
    os.remove(path)
    fig.colorbar(im, ax=axs, pad=0.01).set_label("signed fraction (red adds, blue cancels)")
    fig.suptitle("FLASH: which old transverse coherences leak into each readout, per RF "
                 "spoiling increment", fontsize=11, y=1.06)
    _save(fig, os.path.join(out, "fig09_flash_rf_spoiling.png"), dpi=100, bbox_inches="tight")
    return leak


def summary(table, fp, ky, amps, sens):
    cls = table.classify(MIN_EMITTED, MIN_LATENT)
    nz = table.typ != 2
    c = int(np.nanargmin(np.abs(ky)))
    f = lambda a: [None if not np.isfinite(v) else float(v) for v in a]  # noqa: E731
    return {
        "states": int(nz.sum()),
        "plus_states": int((table.typ == 0).sum()),
        "z_states": int((table.typ == 1).sum()),
        "class_counts": {pv.CLASS_NAMES[k]: int(((cls == k) & nz).sum()) for k in range(4)},
        "readouts": int(len(fp["rep"])),
        "k_center_readout": c,
        "te_eff_center_ms": float(fp["te_eff"][c] * 1e3),
        "te_prim_center_ms": float(fp["te_prim"][c] * 1e3),
        "ste_frac_center": float(fp["ste_frac"][c]),
        "te_eff_ms": f(fp["te_eff"] * 1e3),
        "te_prim_ms": f(fp["te_prim"] * 1e3),
        "ste_frac": f(fp["ste_frac"]),
        "ky": f(ky),
        "amp_center": {k: float(v[c]) for k, v in amps.items()},
        "amps": {k: f(v) for k, v in amps.items()},
        "weighting_center": {k: {p: float(s[p][c]) for p in ("T1", "T2", "T2dash")}
                             for k, s in sens.items()},
        "weighting": {k: {p: f(s[p]) for p in ("T1", "T2", "T2dash")} for k, s in sens.items()},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--phantom", default="numerical_brain_cropped.mat")
    ap.add_argument("--out", default=os.path.join(HERE, "figures"))
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    if not os.path.exists(args.phantom):
        from urllib.request import urlretrieve
        urlretrieve(mr0.util.DEFAULT_PHANTOM_URL, args.phantom)
    phantom = mr0.VoxelGridPhantom.load_mat(args.phantom)

    graphs, results, extra = {}, {}, {}
    for name, cfg in CASES.items():
        seq0, data, graph, table, tissue_tables, sens, mean = run_case(name, cfg, phantom, args.out)
        graphs[name] = graph
        fig_phase(name, table, cfg, args.out)
        fig_budget(name, table, cfg, args.out)
        spec, fp, ky = fig_fingerprint(name, table, mean, cfg, args.out)
        amps = tissue_amps(tissue_tables)
        fig_tissue(name, tissue_tables, amps, cfg, ky, args.out)
        fig_dashboard(name, table, tissue_tables, spec, fp, ky, amps, sens, cfg, args.out)
        results[name] = summary(table, fp, ky, amps, sens)
        results[name]["mean_tissue"] = mean
        extra[name] = {"sens": sens, "ky": ky, "fp": fp}
    fig_baseline(graphs, args.out)
    fig_compass(extra, args.out)
    results["flash"]["truncation_signal_error"] = fig_truncation(phantom, args.out)
    results["flash"]["rf_spoiling_leak"] = fig_rf_spoiling(phantom, args.out)
    with open(os.path.join(args.out, "summary.json"), "w") as f:
        json.dump(results, f, indent=1)
    for name, r in results.items():
        print(name, json.dumps({k: v for k, v in r.items()
                                if not isinstance(v, list) and k not in ("amps", "weighting")},
                               indent=None))


if __name__ == "__main__":
    main()
