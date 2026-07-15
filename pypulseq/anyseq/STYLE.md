# anyseq style guide

PyPulseq [example script conventions](https://github.com/imr-framework/pypulseq/blob/master/examples/scripts/STYLE_GUIDE.md) are primary. anyseq adds a few rules for Anyfield integration.

## Entry points

- Sequence builders: `seq_<name>()` (e.g. `seq_gre`)
- Optional alias: `main = seq_<name>` for PyPulseq/mrseq parity
- Protocol presets: `prot_<name>()` wrapping a `seq_*` function

## Function signature

1. Control flags first: `plot`, `test_report`, `write_seq`, `seq_filename`, `timing_check`
2. Bare `*` separator
3. Keyword-only sequence parameters with type hints
4. Numpy-style docstring

## Naming

- Counts: `n_read`, `n_phase`, `n_part` (equivalent to PyPulseq `n_x` / `n_y` for Cartesian 2D)
- Timing: lowercase `tr`, `te`, `te_delay`, `tr_delay`
- Flip angles: `flip_angle_deg` (degrees at the API; use `np.deg2rad` internally)
- FOV: `fov` as `tuple[float, float, float]` — ``(fov_x, fov_y, fov_z)``; for 2D, ``fov_z`` is slice thickness

Deprecated FAU/PyPulseq aliases (`Nread`, `alpha`, `TR`, `fov_xy`, …) are accepted via `**legacy_kwargs` with `DeprecationWarning`.

## Definitions (anyseq schema)

Use snake_case keys aligned with Python naming:

```python
seq.set_definition('name', experiment_id)
seq.set_definition('fov', [fov_x, fov_y, fov_z])
seq.set_definition('recon_matrix', [n_read, n_phase, 1])
```

## Reference implementation

See `gre_seq.py`.
