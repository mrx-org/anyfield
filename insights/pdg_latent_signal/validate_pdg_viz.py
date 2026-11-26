"""Check the identities pdg_viz relies on, for the FLASH and TSE graphs.

    python validate_pdg_viz.py [--phantom numerical_brain_cropped.mat]

1. latent_signal is reproduced from the edges (what analyze_graph propagates)
2. the relaxation-path dicts sum to prepass_mag
3. the signal-weighted mean pathway TE equals -dlnS/dR2 from finite differences
"""
from __future__ import annotations

import argparse
import os
import sys
import tempfile
import warnings

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import MRzeroCore as mr0  # noqa: E402
import pdg_viz as pv  # noqa: E402
from seqs import seq_flash, seq_tse  # noqa: E402

warnings.filterwarnings("ignore", category=UserWarning)


def check(name, builder, N, msc, msm, phantom):
    seq, _ = builder()
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, f"{name}.seq")
        seq.write(path)
        seq0 = mr0.Sequence.import_file(path)
    data = phantom.interpolate(N, N, 1).build()
    p = {k: float(torch.mean(getattr(data, k))) for k in ("T1", "T2", "T2dash", "D")}
    g = mr0.compute_graph(seq0, data, msc, msm)
    t = pv.PDGTable.from_graph(g, seq0, **p)

    lat = t.emitted.copy()
    np.maximum.at(lat, t.e_parent, t.e_carried)
    err_lat = np.abs(lat - t.latent)[t.typ != 2].max()

    end, _ = pv.relaxation_paths(t, p["T1"], p["T2"])
    sums = np.array([sum(e.values()) for e in end])
    big = np.abs(t.mag) > 1e-3
    err_mag = np.median(np.abs(sums - t.mag)[big] / np.abs(t.mag)[big])

    fp = pv.fingerprint(pv.relaxation_spectrum(t, p["T1"], p["T2"]))
    eps = 0.01
    amp = {}
    for s in (+1, -1):
        q = dict(p, T2=p["T2"] / (1 + s * eps))
        gq = mr0.compute_graph_ext(seq0, q["T1"], q["T2"], q["T2dash"], q["D"], msc, msm,
                                   data.nyquist.tolist(), data.size.tolist(), data.avg_B1_trig)
        amp[s] = pv.echo_amplitude(pv.PDGTable.from_graph(gq, seq0, **q), q["T2"], q["T2dash"])[1]
    te_fd = -(np.log(amp[1]) - np.log(amp[-1])) / (2 * eps / p["T2"])
    err_te = np.abs(te_fd - fp["te_eff"])

    print(f"{name}: latent max err {err_lat:.1e} | path-sum median rel err {err_mag:.1e} | "
          f"TE_eff vs -dlnS/dR2: median rel err {np.median(err_te / te_fd):.1e}, "
          f"max abs err {err_te.max() * 1e3:.3f} ms")
    assert err_lat < 1e-6
    assert err_mag < 1e-3
    assert np.all(err_te < 0.01 * np.abs(te_fd) + 5e-5)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--phantom", default="numerical_brain_cropped.mat")
    args = ap.parse_args()
    if not os.path.exists(args.phantom):
        from urllib.request import urlretrieve
        urlretrieve(mr0.util.DEFAULT_PHANTOM_URL, args.phantom)
    phantom = mr0.VoxelGridPhantom.load_mat(args.phantom)
    check("flash", seq_flash, 64, 2000, 1e-5, phantom)
    check("tse", seq_tse, 42, 2000, 1e-4, phantom)
    print("ok")


if __name__ == "__main__":
    main()
