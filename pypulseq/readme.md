# PyPulseq web

A web-based interface for interactive MR sequence design using **Pyodide**, **pypulseq**, and **Matplotlib**. This describes the sequence explorer (`seq_explorer.js` / `seq_plot.js`) as hosted by the app at the repo root; the standalone prototype page it was originally written for is gone.

## General Implementation

1.  **Dynamic UI via `inspect`:** Python's `inspect.signature` automatically detects the arguments of the selected `seq_*` function, which are then dynamically mapped to HTML sliders, checkboxes, and text inputs.
2.  **Delayed Rendering:** Uses `seq.plot(plot_now=False)` followed by `plt.show()` to ensure the plotting loop doesn't block the main browser thread, keeping the UI responsive.
3.  **Interactive Mode:** `plt.ion()` enables the interactive zoom/pan features provided by the patched `WebAgg` backend in Pyodide 0.28.0+.
4.  **Dark Theme Toggle:** Checkbox to switch between dark theme (matches UI) and standard matplotlib styling.
5.  **Code Editor:** CodeMirror-based editor for live Python code editing with syntax highlighting, line numbers, and Monokai theme. Supports "Load Default" to restore original code.

## The Fuckery (Workarounds)
The Matplotlib `WebAgg` backend parents figures at `document.pyodideMplTarget ?? document.body`. Setting `document.pyodideMplTarget` and calling `plt.show()` still lands the figure in the target on the pinned Pyodide 0.29.0 wheel (with the expected `ui-dialog-titlebar` markup). Figures go to `<body>` only when the target is unset. The default plot path is ChartGPU (`plot_speed='chartgpu'`), which never rasterises matplotlib; the target and the sweeps below matter for `full` / `fast` / `faster` and the no-WebGPU fallback.


1.  **"UFO" Div Capture (MutationObserver):** A `MutationObserver` in `seq_explorer.js` watches for matplotlib figure divs appended to `<body>` and instantly "teleports" them into the intended `#seq-mpl-actual-target` container. `seq_plot.js` does a matching DOM sweep. These are still load-bearing in practice and should not be removed.
2.  **Backend Redirect:** `document.pyodideMplTarget` is matplotlib's real contract and is still set on the plot container before `plt.show()`. The write-only `window.pyodideMplTarget` twin was removed (`6d66997`) and was never read.

## Requirements
- Pyodide v0.29.0+
- pypulseq (installed via micropip)
- Matplotlib (wasm-compatible backend)
- NumPy, SciPy (dependencies)