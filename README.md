# Anyfield MRI scanner

*v2.2.3 — [release notes](release_notes.md)*

*Plan and run Pulseq MRI sequences in a virtual scanner environment.*

**[Open the scanner](https://mrx-org.github.io/anyfield/)** — runs in the browser, no install.

**[Open seq_check](https://mrx-org.github.io/anyfield/pypulseq/seq_check)** — runs in the browser, no install.


---

## What it does

Anyfield is a browser-based MRI workbench: pick or write a sequence, place the field of view on a phantom, simulate, and inspect reconstructed images — all without leaving the tab.

![Drag the FOV with Ctrl + left mouse](Tutorial_fov.gif)

*Ctrl + left mouse drag moves the slice box on the planning phantom.*

### Main features
- **FOV planning** — position and rotate the acquisition box on anatomical phantoms before you scan.
- **Sequence explorer** — Sequence from [PyPulseq](https://github.com/imr-framework/pypulseq), [mrseq](https://github.com/PTB-MR/mrseq), built-in sequences, and remote [Pulseq](https://pulseq.github.io) files
- **Editable protocols** - alter TE, TR resolution
- **Sequence analyisis** Plot waveforms and k-space interactively
- **In-browser simulation** — no installation required
- **Scan queue** — queue protocols, compare sequences/protocols side by side, export NIfTI.
- **Shareable links** — open a specific sequence or pass a full protocol capsule in the URL.

### Try it

- [TSE](https://mrx-org.github.io/anyfield/?s_category=builtin&s_file=mr0_tse_2d_seq&s_func=prot_TSE_2D)
- [TSE with asymmetric excitation for fat suppression](https://mrx-org.github.io/anyfield/?s_category=builtin&s_file=mr0_tse_2d_seq&s_func=prot_TSE_2D_asym_ex)
- [Remote `spiralTSE.seq` file](https://mrx-org.github.io/anyfield/?seq_url=https://raw.githubusercontent.com/pulseq-frame/test-seqs/refs/heads/main/spiral-TSE/ssTSE.seq)
- [mrseq spiral](https://mrx-org.github.io/anyfield/?s_category=mrseq&s_file=spiral_flash&s_func=main&sp_rf_flip_angle=5&sp_fov_xy=0.22)


## A few nice details

- Deep links use readable query params: `?s_category=anyseq&s_file=gre_seq&s_func=seq_gre`
- The dashed share icon copies a light link with your parameter overrides; the solid one embeds the full protocol.
- Protocol files are plain Python — portable with `uv run` or Google Colab. 

---

Part of the [mrx-org](https://github.com/mrx-org) ecosystem.
