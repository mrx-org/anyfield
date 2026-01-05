# PyPulseq web

A web-based interface for interactive MR sequence design using **Pyodide**, **pypulseq**, and **Matplotlib**.

## General Implementation

1.  **Dynamic UI via `inspect`:** Python's `inspect.signature` automatically detects the arguments of `seq_RARE_2D`, which are then dynamically mapped to HTML sliders, checkboxes, and text inputs.
2.  **Delayed Rendering:** Uses `seq.plot(plot_now=False)` followed by `plt.show()` to ensure the plotting loop doesn't block the main browser thread, keeping the UI responsive.
3.  **Interactive Mode:** `plt.ion()` enables the interactive zoom/pan features provided by the patched `WebAgg` backend in Pyodide 0.28.0+.
4.  **Dark Theme Toggle:** Checkbox to switch between dark theme (matches UI) and standard matplotlib styling.
5.  **Code Editor:** CodeMirror-based editor for live Python code editing with syntax highlighting, line numbers, and Monokai theme. Supports "Load Default" to restore original code.

## The Fuckery (Workarounds)
In Pyodide v0.29.0+, `document.pyodideMplTarget` is deprecated and no longer works. The Matplotlib `WebAgg` backend appends figure divs directly to the end of the `<body>` instead of respecting any target container.


1.  **"UFO" Div Capture (MutationObserver):** A `MutationObserver` watches for matplotlib figure divs appended to `<body>` and instantly "teleports" them into the intended `#plot-output` container. This is the primary workaround since the target mechanism no longer functions.
2.  **Backend Redirects (Legacy):** Both `document.pyodideMplTarget` and `window.pyodideMplTarget` are still set for compatibility, but they are effectively ignored in v0.29.0+.

## Requirements
- Pyodide v0.29.0+
- pypulseq (installed via micropip)
- Matplotlib (wasm-compatible backend)
- NumPy, SciPy (dependencies)