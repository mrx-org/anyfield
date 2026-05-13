# Sequence plot specification (Matplotlib + ChartGPU)

## Intent

Document how **MRI sequence waveforms** are plotted from Pyodide: `seq.plot(...)` in Python, optional **ChartGPU** JSON export for WebGPU rendering in the browser, and the JS module that owns ChartGPU wiring. The Sequence Explorer UI and Scan Module consume this; orchestration of tree/params/editor stays in [SPEC_seq_exp.md](SPEC_seq_exp.md).

## Default and UI

- **Default plot speed:** `chartgpu` (constant `SEQ_DEFAULT_PLOT_SPEED` in `pypulseq/seq_plot.js`, mirrored on `SequenceExplorer.DEFAULT_PLOT_SPEED` in `pypulseq/seq_explorer.js` for callers such as `scan_zero/scan_module.js`).
- **Selector values:** `chartgpu` plus Matplotlib modes `full` / `fast` / `faster` (see Sequence Explorer templates and execute script).

## Python (`pypulseq/seq_plot_utils.py`)

- **Entry:** `plot(..., plot_speed: str = 'chartgpu', ...)` (and related helpers used by the patched `seq.plot` path in the app).
- **Matplotlib:** For `plot_speed` in `full` / `fast` / `faster`, rendering uses matplotlib as today (`plt.show()` in the execute script when not chartgpu).
- **ChartGPU export:** For `plot_speed == 'chartgpu'`:
  - Builds in-memory panel/series data and stores it on **`__main__._chartgpu_last_payload`** via `build_chartgpu_payload` (see implementation for panel layout, tab10-style colors, optional `xyBase64` float32 interleaved encoding for large series).
  - **No** `plt.show()` for that branch in the injected execute script.
- **JS bridge:**
  - `get_chartgpu_payload_json()` — serializes the last payload for `pyodide.runPython` / `runPythonAsync` from JS.
  - `clear_chartgpu_payload()` — clears `__main__._chartgpu_last_payload` to drop large buffers after render or on failure.

## JavaScript module (`pypulseq/seq_plot.js`)

Single module for **ChartGPU + `seq.plot` script fragments**. Chart/WebGPU handles and disconnect callbacks live on the explorer **`host`** (typically the `SequenceExplorer` instance): `host._seqChartGpu*`.

### Pinned dependency

- **ChartGPU ESM:** `CHARTGPU_MODULE_URL` inside `seq_plot.js` (currently `chartgpu@0.3.2` via `esm.sh` with `target=es2022`). Bump version only with a quick smoke test (create, dispose, zoom, pan).

### Public exports (contract for `seq_explorer.js` and tests)

| Export | Role |
|--------|------|
| `SEQ_DEFAULT_PLOT_SPEED` | `'chartgpu'` — default speed string. |
| `disposeSeqChartGpuHost(host)` | Async teardown: disconnect crosshair/sync, remove device listeners, dispose charts, destroy WebGPU device; clear host fields. |
| `releaseChartgpuPythonPayload(pyodide)` | Calls `clear_chartgpu_payload()` in Python. |
| `renderSeqChartGpuAfterPlot(host, plotRoot, pyodide, plotContainer)` | Main path: parse payload JSON, `requestAdapter` / `requestDevice`, build six panel hosts, `ChartGPU.create`, shared theme, lockstep x-zoom, optional plain left-drag pan, fallbacks on GPU loss / errors. |
| `buildSeqPlotExecuteFragments({ silent, plotSpeed, debug })` | Returns `{ plotBlock, chartgpuClearPy }` — Python source embedded in `buildExecuteScript`: chartgpu vs matplotlib branches + pre-run clear of stale payload when `plotSpeed === 'chartgpu'`. |
| `normalizeChartGpuSeries`, `chartGpuB64ToFloat32Interleaved`, `chartGpuSeriesDataToInterleavedF32` | Payload normalization / decoding for ChartGPU. |
| `formatYTick3SigDigits` | Y tick formatter (three significant digits). |
| `chartGpuYAnchorForExtentHelper`, `chartGpuWithSharedXExtentSeries` | Shared global **x** span across panels without pinning `xAxis.min`/`max` for tick math (invisible helper line `__seqXExtent__`). |

### Explorer integration (`pypulseq/seq_explorer.js`)

- Imports the symbols above; **`disposeSeqChartGpu`** / **`renderSeqChartGpuAfterPlot`** delegate to `disposeSeqChartGpuHost` / `mountChartGpuSequencePlot` (import alias) so instance methods stay stable for external callers.
- **`buildExecuteScript`** uses `buildSeqPlotExecuteFragments` for the `seq.plot` / payload-clear snippets.

### Scan Module (`scan_zero/scan_module.js`)

- Uses `SequenceExplorer.DEFAULT_PLOT_SPEED` and, for silent/view-seq style runs, duplicates the chartgpu `seq.plot(...)` string inline next to `disposeSeqChartGpu` / `renderSeqChartGpuAfterPlot`. If execute-script semantics change, keep this path aligned (or refactor to one helper later).

## CSS (`pypulseq/seq_explorer.css`)

- **Stack:** `.seq-chartgpu-stack`, `.seq-chartgpu-panel` (grid / flex height, last row for x-axis + slider).
- **Fallback:** `.seq-chartgpu-fallback` when WebGPU or ChartGPU init fails.
- **MPL container:** rules under `#seq-plot-output` / `.mpl-figure-container` that reserve space when the stack replaces a matplotlib figure.

## Interaction (zoom / pan / sync)

- **Six charts** share one logical **time** axis: `connectCharts` (crosshair) plus **`zoomRangeChange`** handlers broadcast `setZoomRange` to all charts with a private `SEQ_ZOOM_SYNC` source token to avoid feedback loops.
- **Zoom limit:** `dataZoom` uses a shared **`ZOOM_MIN_SPAN`** constant in `seq_plot.js` (currently **0.008**): minimum visible window as a **fraction of the full** exported time range \([t_{\min}, t_{\max}]\) (ChartGPU/ECharts-style `minSpan`). So the narrowest view is about **0.8%** of the sequence duration on screen; previously **0.08** (~8%) allowed less zoom-in on long sequences.
- **Pan:** ChartGPU 0.3.x defaults may require Shift+middle for some pans; the module adds **plain left-drag** pan on the bottom chart beyond a small move threshold, then broadcasts the new range.
- **Tooltips:** disabled for sequence plots (performance/clarity).

## Failure modes

- **No adapter / no device:** User-facing fallback HTML in the plot container; Python payload released.
- **`uncapturederror` / `device.lost`:** Session marked dead; charts disposed; reconnect guidance via fallback messaging where implemented.
- **Large sequences:** Heavier GPU memory and decode cost; copy in `seq_plot.js` suggests shorter sequences or time-limited export when supported upstream.

## Upstream ChartGPU

Repo [ChartGPU/ChartGPU](https://github.com/ChartGPU/ChartGPU) — useful references: [`docs/api/options.md`](https://github.com/ChartGPU/ChartGPU/blob/main/docs/api/options.md), [`docs/api/chart.md`](https://github.com/ChartGPU/ChartGPU/blob/main/docs/api/chart.md), [`docs/api/interaction.md`](https://github.com/ChartGPU/ChartGPU/blob/main/docs/api/interaction.md), [`docs/api/annotations.md`](https://github.com/ChartGPU/ChartGPU/blob/main/docs/api/annotations.md), and guides under [`docs/guides/`](https://github.com/ChartGPU/ChartGPU/tree/main/docs/guides).

---

*Related:* [SPEC_seq_exp.md](SPEC_seq_exp.md) (explorer shell, TOML, FOV, protocols). *Implementation:* `pypulseq/seq_plot_utils.py`, `pypulseq/seq_plot.js`, `pypulseq/seq_explorer.js`, `pypulseq/seq_explorer.css`.
