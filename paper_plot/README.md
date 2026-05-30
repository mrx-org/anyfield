# Paper Plot (pro)

**Paper Plot** is a multi-panel figure builder for publication-style layouts. Open it from the grid icon in the header (**pro only** — add `?pro=1` to the URL, same flag as **SCAN▶▶** and debug UI).

- **Panels**: Choose a grid (1×1 … 3×1, 2×2, etc.). Each panel takes a scan expression (`4`, `4.phase`) or a diff (`1-2`, `|1-2|`).
- **Scan rail**: Click a completed scan to assign it to the selected panel.
- **Layout**: Link 4D frame / crosshair position and color limits globally or per row; optional vertical colorbars (one per row when clims are linked).
- **Colormaps**: Scan panels default to **gray**; diff panels to **bkr**. Double-click a colorbar to edit min/max (same dialog as the main histogram).
- **Caption**: Auto-generated from protocol tooltips; diff panels cross-reference other panels where possible.
- **Export**: **Download SVG** — native-resolution panel images, black figure stage, caption block.

Lazy-loaded via `launch.js` so a load failure does not break the main scanner.

## Module layout

| File | Role |
|------|------|
| `launch.js` | Header button bootstrap; dynamic import |
| `paper_plot.js` | Main overlay, export, debug checks |
| `paper_plot_figure.js` | Grid layout, SVG chrome, figure state, colormaps |
| `paper_plot_expr.js` | Scan/diff expressions, captions |
| `paper_plot_panel.js` | Per-panel Niivue viewer |
| `paper_plot_niivue.js` | Volume/clim helpers (self-contained) |
| `paper_plot_sync.js` | Link position/clims; native-res capture |
| `paper_plot.css` | Overlay styles |
