/**
 * Paper Plot layout geometry, SVG rendering, figure state, and colormaps.
 */
import { formatPanelLabel } from "./paper_plot_expr.js";

// ── Figure state (serializable) ──────────────────────────────────────────────

export const PAPER_PLOT_STATE_VERSION = 1;

export const DEFAULT_FIGURE_SIZE = Object.freeze({
  width: 920,
  height: 540,
  captionHeight: 72,
});

export const DEFAULT_PAPER_OPTIONS = Object.freeze({
  showColorbar: false,
  scanColormap: "gray",
  diffColormap: "bkr",
  linkPosition: false,
  linkClims: false,
  rowLinkPosition: [],
  rowLinkClims: [],
  showInlineInputs: false,
});

export function createPanelState(index) {
  return {
    index,
    label: formatPanelLabel(index),
    expr: "",
    isDiff: false,
    frame4D: 0,
    colormap: "",
    calMin: null,
    calMax: null,
    error: "",
    tooltip: "",
    captionDetail: "",
    volumeAspect: 1,
    sliceType: "axial",
  };
}

export function createDefaultFigureState(cols = 2, rows = 2) {
  const n = Math.max(1, cols * rows);
  return {
    version: PAPER_PLOT_STATE_VERSION,
    figure: { ...DEFAULT_FIGURE_SIZE },
    grid: { cols, rows },
    options: { ...DEFAULT_PAPER_OPTIONS },
    panels: Array.from({ length: n }, (_, i) => createPanelState(i)),
  };
}

export function cloneFigureState(state) {
  return JSON.parse(JSON.stringify(state));
}

export function ensurePanelCount(state) {
  const n = Math.max(1, state.grid.cols * state.grid.rows);
  const panels = Array.isArray(state.panels) ? state.panels.slice(0, n) : [];
  while (panels.length < n) panels.push(createPanelState(panels.length));
  state.panels = panels.map((p, i) => ({
    ...createPanelState(i),
    ...p,
    index: i,
    label: p?.label || formatPanelLabel(i),
  }));
  return state;
}

export function normalizeFigureState(raw) {
  const base = createDefaultFigureState();
  const rawOptions = raw?.options ?? {};
  const rows = Math.max(1, Math.min(2, Number(raw?.grid?.rows) || 2));
  const state = {
    version: PAPER_PLOT_STATE_VERSION,
    figure: { ...base.figure, ...(raw?.figure ?? {}) },
    grid: { ...base.grid, ...(raw?.grid ?? {}) },
    options: {
      showColorbar: rawOptions.showColorbar ?? base.options.showColorbar,
      scanColormap: rawOptions.scanColormap ?? base.options.scanColormap,
      diffColormap: rawOptions.diffColormap ?? base.options.diffColormap,
      linkPosition: rawOptions.linkPosition ?? base.options.linkPosition,
      linkClims: rawOptions.linkClims ?? base.options.linkClims,
      rowLinkPosition: Array.isArray(rawOptions.rowLinkPosition) ? rawOptions.rowLinkPosition.slice(0, rows) : [],
      rowLinkClims: Array.isArray(rawOptions.rowLinkClims) ? rawOptions.rowLinkClims.slice(0, rows) : [],
      showInlineInputs: rawOptions.showInlineInputs ?? base.options.showInlineInputs,
    },
    panels: Array.isArray(raw?.panels) ? raw.panels : base.panels,
  };
  state.grid.cols = Math.max(1, Math.min(3, Number(state.grid.cols) || 2));
  state.grid.rows = Math.max(1, Math.min(2, Number(state.grid.rows) || 2));
  while (state.options.rowLinkPosition.length < state.grid.rows) {
    state.options.rowLinkPosition.push(!!state.options.linkPosition);
  }
  while (state.options.rowLinkClims.length < state.grid.rows) {
    state.options.rowLinkClims.push(!!state.options.linkClims);
  }
  state.options.rowLinkPosition = state.options.rowLinkPosition.slice(0, state.grid.rows).map(Boolean);
  state.options.rowLinkClims = state.options.rowLinkClims.slice(0, state.grid.rows).map(Boolean);
  state.options.linkPosition = !!rawOptions.linkPosition;
  state.options.linkClims = !!rawOptions.linkClims;
  state.figure.width = Number(state.figure.width) || DEFAULT_FIGURE_SIZE.width;
  state.figure.height = Number(state.figure.height) || DEFAULT_FIGURE_SIZE.height;
  state.figure.captionHeight = Number(state.figure.captionHeight) || DEFAULT_FIGURE_SIZE.captionHeight;
  return ensurePanelCount(state);
}

export function updatePanelState(state, index, patch) {
  if (!state?.panels?.[index]) return null;
  state.panels[index] = {
    ...state.panels[index],
    ...patch,
    index,
    label: patch.label || state.panels[index].label || formatPanelLabel(index),
  };
  return state.panels[index];
}

export function serializeFigureState(state) {
  return JSON.stringify(normalizeFigureState(cloneFigureState(state)), null, 2);
}

export function deserializeFigureState(text) {
  return normalizeFigureState(JSON.parse(text));
}

export function validateFigureState(state) {
  const issues = [];
  if (!state?.grid) issues.push("Missing grid");
  if (!Array.isArray(state?.panels)) issues.push("Missing panels");
  const n = (state?.grid?.cols ?? 0) * (state?.grid?.rows ?? 0);
  if (n > 0 && state.panels?.length !== n) {
    issues.push(`Panel count ${state.panels.length} does not match grid ${n}`);
  }
  return { ok: issues.length === 0, issues };
}

// ── Colormaps ────────────────────────────────────────────────────────────────

export const DEFAULT_SCAN_COLORMAP = "gray";
export const DEFAULT_DIFF_COLORMAP = "bkr";

export const PAPER_COLORMAP_ORDER = Object.freeze([
  "gray",
  "viridis",
  "jet",
  "thermal",
  "winter",
  "bwr",
  "bkr",
]);

export const PAPER_CUSTOM_COLORMAPS = Object.freeze({
  thermal: {
    R: [0, 180, 255, 255, 255],
    G: [0, 0, 80, 200, 255],
    B: [0, 0, 0, 0, 255],
    I: [0, 64, 140, 200, 255],
  },
  bwr: {
    R: [0, 255, 255],
    G: [0, 255, 0],
    B: [255, 255, 0],
    I: [0, 127, 255],
    A: [255, 255, 255],
  },
  bkr: {
    R: [0, 0, 255],
    G: [0, 0, 0],
    B: [255, 0, 0],
    I: [0, 127, 255],
    A: [255, 255, 255],
  },
});

export function registerPaperPlotColormaps(nv) {
  if (!nv || typeof nv.addColormap !== "function") return;
  for (const [name, def] of Object.entries(PAPER_CUSTOM_COLORMAPS)) {
    nv.addColormap(name, def);
  }
}

export function resolvePaperColormapOptions(niivueNames, keepSelected = []) {
  const builtIn = new Set((niivueNames ?? []).map((n) => String(n)));
  const custom = new Set(Object.keys(PAPER_CUSTOM_COLORMAPS));
  const extra = keepSelected.filter(Boolean).map(String);
  const haveNiivueList = builtIn.size > 0;
  const list = [];

  for (const name of PAPER_COLORMAP_ORDER) {
    if (!haveNiivueList || custom.has(name) || builtIn.has(name)) list.push(name);
  }
  for (const name of extra) {
    if (!list.includes(name) && PAPER_COLORMAP_ORDER.includes(name)) list.push(name);
  }
  return list.length ? list : [DEFAULT_SCAN_COLORMAP, DEFAULT_DIFF_COLORMAP];
}

// ── Layout ───────────────────────────────────────────────────────────────────

export const GRID_PRESETS = Object.freeze([
  { label: "1x1", displayLabel: "1×1", cols: 1, rows: 1 },
  { label: "1x2", displayLabel: "1×2", cols: 1, rows: 2 },
  { label: "2x1", displayLabel: "2×1", cols: 2, rows: 1 },
  { label: "2x2", displayLabel: "2×2", cols: 2, rows: 2 },
  { label: "3x1", displayLabel: "3×1", cols: 3, rows: 1 },
]);

export const MAX_COLS = 3;
export const MAX_ROWS = 2;

export function clampGrid(cols, rows) {
  return {
    cols: Math.min(MAX_COLS, Math.max(1, Number(cols) || 1)),
    rows: Math.min(MAX_ROWS, Math.max(1, Number(rows) || 1)),
  };
}

export function computeGridLayout(state) {
  const { cols, rows } = clampGrid(state.grid.cols, state.grid.rows);
  const figure = state.figure;
  const pad = 4;
  const gap = 4;
  const cellW = (figure.width - pad * 2 - gap * (cols - 1)) / cols;
  const cellH = (figure.height - pad * 2 - gap * (rows - 1)) / rows;
  const exprH = state.options.showInlineInputs ? 22 : 0;
  const imageH = cellH - exprH;
  const layouts = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = pad + c * (cellW + gap);
      const y = pad + r * (cellH + gap);
      layouts.push({
        x,
        y,
        w: cellW,
        h: cellH,
        imageRect: { x, y: y + exprH, w: cellW, h: imageH },
        exprH,
      });
    }
  }
  return layouts;
}

export function computePanelContentLayout(cellLayout, panelState, options) {
  if (!cellLayout) return null;
  const aspect = Number(panelState?.volumeAspect) > 0 ? Number(panelState.volumeAspect) : 1;
  const ir = cellLayout.imageRect;
  const exprH = ir.y - cellLayout.y;
  const colorbarW = options.showColorbar ? 12 : 0;
  const colorbarGap = options.showColorbar ? 4 : 0;
  const colorbarLabelW = options.showColorbar ? 34 : 0;
  const hasVolume = !!panelState?.expr && !panelState?.error;

  let w;
  let h;
  if (hasVolume) {
    h = ir.h;
    w = h * aspect;
    if (w > ir.w) {
      w = ir.w;
      h = w / aspect;
    }
  } else {
    w = ir.w * 0.7;
    h = ir.h;
  }

  const slotW = w + colorbarGap + colorbarW + colorbarLabelW;
  const slotH = exprH + h;
  const slotX = cellLayout.x + (cellLayout.w - slotW) / 2;
  const slotY = cellLayout.y;
  const imageY = cellLayout.y + exprH;
  const imageX = slotX;

  return {
    x: slotX,
    y: slotY,
    w: slotW,
    h: slotH,
    slotRect: { x: imageX, y: slotY, w, h: slotH },
    imageRect: { x: imageX, y: imageY, w, h },
    colorbarRect: colorbarW > 0
      ? { x: imageX + w + colorbarGap, y: imageY + h * 0.15, w: colorbarW, h: h * 0.7 }
      : null,
  };
}

function panelShowsColorbar(index, cols, options) {
  if (!options.showColorbar) return false;
  const row = Math.floor(index / cols);
  const rowLinked = !!options.linkClims || !!options.rowLinkClims?.[row];
  if (!rowLinked) return true;
  return index % cols === cols - 1;
}

function shiftRect(rect, dx, dy) {
  if (!rect) return null;
  return { ...rect, x: rect.x + dx, y: rect.y + dy };
}

function shiftContentLayout(layout, dx, dy) {
  return {
    ...layout,
    x: layout.x + dx,
    y: layout.y + dy,
    imageRect: shiftRect(layout.imageRect, dx, dy),
    colorbarRect: shiftRect(layout.colorbarRect, dx, dy),
    slotRect: shiftRect(layout.slotRect, dx, dy),
  };
}

export function computePackedContentLayouts(cellLayouts, panelStates, state) {
  const { cols, rows } = clampGrid(state.grid.cols, state.grid.rows);
  const base = cellLayouts.map((cell, i) =>
    computePanelContentLayout(cell, panelStates[i], {
      ...state.options,
      showColorbar: panelShowsColorbar(i, cols, state.options),
    })
  );
  const gap = state.options.panelGap ?? 4;
  const rowGap = state.options.rowGap ?? 4;
  const packed = base.slice();
  const rowHeights = [];

  for (let r = 0; r < rows; r++) {
    const start = r * cols;
    const row = base.slice(start, start + cols).filter(Boolean);
    const totalW = row.reduce((sum, item) => sum + item.w, 0) + gap * Math.max(0, row.length - 1);
    let x = (state.figure.width - totalW) / 2;
    const rowH = row.reduce((mx, item) => Math.max(mx, item.h), 0);
    rowHeights.push(rowH);
    for (let c = 0; c < row.length; c++) {
      const idx = start + c;
      const dx = x - base[idx].x;
      packed[idx] = shiftContentLayout(base[idx], dx, 0);
      x += base[idx].w + gap;
    }
  }

  const totalH = rowHeights.reduce((sum, h) => sum + h, 0) + rowGap * Math.max(0, rows - 1);
  let y = Math.max(0, (state.figure.height - totalH) / 2);
  for (let r = 0; r < rows; r++) {
    const start = r * cols;
    for (let c = 0; c < cols; c++) {
      const idx = start + c;
      if (!packed[idx]) continue;
      const dy = y - packed[idx].y;
      packed[idx] = shiftContentLayout(packed[idx], 0, dy);
    }
    y += rowHeights[r] + rowGap;
  }

  return fitPackedContentLayouts(packed, state.figure);
}

function scaleLayoutRect(rect, cx, cy, scale, targetCx, targetCy) {
  if (!rect) return null;
  return {
    x: targetCx + (rect.x - cx) * scale,
    y: targetCy + (rect.y - cy) * scale,
    w: rect.w * scale,
    h: rect.h * scale,
  };
}

/** Uniformly scale/center packed panels when colorbars make rows wider than the figure. */
export function fitPackedContentLayouts(packed, figure, pad = 4) {
  const items = packed.filter(Boolean);
  if (!items.length) return packed;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const item of items) {
    minX = Math.min(minX, item.x);
    minY = Math.min(minY, item.y);
    maxX = Math.max(maxX, item.x + item.w);
    maxY = Math.max(maxY, item.y + item.h);
  }

  const contentW = Math.max(1, maxX - minX);
  const contentH = Math.max(1, maxY - minY);
  const availW = Math.max(1, figure.width - pad * 2);
  const availH = Math.max(1, figure.height - pad * 2);
  const scale = Math.min(1, availW / contentW, availH / contentH);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const targetCx = figure.width / 2;
  const targetCy = figure.height / 2;

  return packed.map((layout) => {
    if (!layout) return layout;
    const main = scaleLayoutRect(layout, cx, cy, scale, targetCx, targetCy);
    return {
      ...layout,
      x: main.x,
      y: main.y,
      w: main.w,
      h: main.h,
      slotRect: scaleLayoutRect(layout.slotRect, cx, cy, scale, targetCx, targetCy),
      imageRect: scaleLayoutRect(layout.imageRect, cx, cy, scale, targetCx, targetCy),
      colorbarRect: scaleLayoutRect(layout.colorbarRect, cx, cy, scale, targetCx, targetCy),
    };
  });
}

export function getStageTransform(stageEl, svgRoot, figure) {
  if (!stageEl || !svgRoot) return null;
  const stageRect = stageEl.getBoundingClientRect();
  const svgRect = svgRoot.getBoundingClientRect();
  if (svgRect.width < 2 || svgRect.height < 2) return null;
  return {
    scaleX: svgRect.width / figure.width,
    scaleY: svgRect.height / figure.height,
    offX: svgRect.left - stageRect.left,
    offY: svgRect.top - stageRect.top,
  };
}

export function mapSvgToCssRect(rect, transform) {
  return {
    left: transform.offX + rect.x * transform.scaleX,
    top: transform.offY + rect.y * transform.scaleY,
    width: rect.w * transform.scaleX,
    height: rect.h * transform.scaleY,
  };
}

// ── SVG renderer ─────────────────────────────────────────────────────────────

export const SVG_NS = "http://www.w3.org/2000/svg";

export function createSvgRoot({ width, height, className = "" }) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  if (className) svg.classList.add(className);
  return svg;
}

export function setSvgRootSize(svg, { width, height }) {
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
}

export function appendRect(parent, rect, attrs = {}) {
  const r = document.createElementNS(SVG_NS, "rect");
  r.setAttribute("x", String(rect.x));
  r.setAttribute("y", String(rect.y));
  r.setAttribute("width", String(rect.w));
  r.setAttribute("height", String(rect.h));
  for (const [k, v] of Object.entries(attrs)) r.setAttribute(k, String(v));
  parent.appendChild(r);
  return r;
}

export function appendText(parent, x, y, text, attrs = {}) {
  const t = document.createElementNS(SVG_NS, "text");
  t.setAttribute("x", String(x));
  t.setAttribute("y", String(y));
  t.setAttribute("font-family", "system-ui,sans-serif");
  for (const [k, v] of Object.entries(attrs)) t.setAttribute(k, String(v));
  t.textContent = text ?? "";
  parent.appendChild(t);
  return t;
}

export function createPanelChrome(svgRoot, layout, panelState, theme = "screen") {
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "paper-svg-panel");
  const border = appendRect(g, layout, {
    fill: "none",
    stroke: theme === "print" ? "#333" : "#555",
    "stroke-width": "1",
    class: "paper-svg-border",
  });
  const title = appendText(g, layout.x + 4, layout.y + 14, panelState.label, {
    fill: theme === "print" ? "#222" : "#ccc",
    "font-size": theme === "print" ? "24" : "22",
    class: "paper-svg-title",
  });
  const colorbar = document.createElementNS(SVG_NS, "g");
  colorbar.setAttribute("class", "paper-svg-colorbar");
  g.appendChild(colorbar);
  svgRoot.appendChild(g);
  return { g, border, title, colorbar };
}

export function updatePanelChrome(chrome, layout, panelState, options = {}) {
  if (!chrome || !layout) return;
  chrome.border?.setAttribute("x", String(layout.x));
  chrome.border?.setAttribute("y", String(layout.y));
  chrome.border?.setAttribute("width", String(layout.w));
  chrome.border?.setAttribute("height", String(layout.h));
  const labelRect = layout.imageRect ?? layout;
  chrome.title?.setAttribute("x", String(labelRect.x + 5));
  chrome.title?.setAttribute("y", String(labelRect.y + 24));
  if (chrome.title) chrome.title.textContent = panelState.label;
  if (chrome.colorbar) {
    while (chrome.colorbar.firstChild) chrome.colorbar.removeChild(chrome.colorbar.firstChild);
    if (options.showColorbar && layout.colorbarRect) {
      appendVerticalColorbar(chrome.colorbar, layout.colorbarRect, panelState, {
        theme: "screen",
        panelIndex: options.panelIndex,
        onColorbarDblClick: options.onColorbarDblClick,
      });
    }
  }
}

export function appendPanelExportChrome(parent, layout, panelState, options = {}) {
  appendRect(parent, layout, {
    fill: "none",
    stroke: options.showPanelBoxes ? "#333" : "none",
    "stroke-width": "1",
  });
}

export function appendPanelLabel(parent, imageRect, panelState, opts = {}) {
  const theme = opts.theme ?? "screen";
  const pad = 5;
  const fontSize = theme === "print" ? 24 : 22;
  const isExport = theme === "export";

  if (!isExport) {
    const bg = appendRect(parent, { x: imageRect.x, y: imageRect.y, w: 42, h: 30 }, {
      fill: theme === "print" ? "#ffffff" : "#000000",
      "fill-opacity": theme === "print" ? "0.72" : "0.45",
    });
    bg.setAttribute("rx", "2");
  }

  const fill = isExport || theme === "screen" ? "#fff" : "#111";
  appendText(parent, imageRect.x + pad, imageRect.y + fontSize + 1, panelState.label, {
    fill,
    "font-size": String(fontSize),
    "font-weight": "700",
  });
}

function colorStopsForMap(name) {
  const key = String(name || "gray").toLowerCase();
  if (key === "bwr") {
    return [
      ["0%", "#0000ff"],
      ["50%", "#ffffff"],
      ["100%", "#ff0000"],
    ];
  }
  if (key === "bkr") {
    return [
      ["0%", "#0000ff"],
      ["50%", "#000000"],
      ["100%", "#ff0000"],
    ];
  }
  if (key === "winter") {
    return [
      ["0%", "#000080"],
      ["50%", "#0080ff"],
      ["100%", "#80ffff"],
    ];
  }
  if (key === "jet") {
    return [
      ["0%", "#00007f"],
      ["25%", "#0000ff"],
      ["50%", "#00ffff"],
      ["75%", "#ffff00"],
      ["100%", "#7f0000"],
    ];
  }
  if (key === "thermal") {
    return [
      ["0%", "#000000"],
      ["25%", "#4b0082"],
      ["50%", "#ff4500"],
      ["75%", "#ffd700"],
      ["100%", "#ffffff"],
    ];
  }
  if (key === "viridis") {
    return [
      ["0%", "#440154"],
      ["35%", "#31688e"],
      ["70%", "#35b779"],
      ["100%", "#fde725"],
    ];
  }
  if (key.includes("hot") || key.includes("thermal")) {
    return [
      ["0%", "#000"],
      ["35%", "#c00000"],
      ["70%", "#ffff00"],
      ["100%", "#fff"],
    ];
  }
  return [["0%", "#000"], ["100%", "#fff"]];
}

export function appendVerticalColorbar(parent, rect, panelState, opts = {}) {
  const theme = opts.theme ?? "screen";
  const id = `paper-cbar-${Math.random().toString(36).slice(2)}`;
  const defs = document.createElementNS(SVG_NS, "defs");
  const grad = document.createElementNS(SVG_NS, "linearGradient");
  grad.setAttribute("id", id);
  grad.setAttribute("x1", "0");
  grad.setAttribute("x2", "0");
  grad.setAttribute("y1", "1");
  grad.setAttribute("y2", "0");
  for (const [offset, color] of colorStopsForMap(panelState.colormap)) {
    const stop = document.createElementNS(SVG_NS, "stop");
    stop.setAttribute("offset", offset);
    stop.setAttribute("stop-color", color);
    grad.appendChild(stop);
  }
  defs.appendChild(grad);
  parent.appendChild(defs);

  appendRect(parent, rect, {
    fill: `url(#${id})`,
    stroke: theme === "export" || theme === "screen" ? "#888" : "#222",
    "stroke-width": "0.6",
  });

  const min = Number.isFinite(panelState.calMin) ? panelState.calMin : null;
  const max = Number.isFinite(panelState.calMax) ? panelState.calMax : null;
  if (min == null || max == null) return;
  const fill = theme === "export" || theme === "screen" ? "#fff" : "#111";
  appendText(parent, rect.x + rect.w + 2, rect.y + 5, max.toFixed(2), {
    fill,
    "font-size": "16",
  });
  appendText(parent, rect.x + rect.w + 2, rect.y + rect.h, min.toFixed(2), {
    fill,
    "font-size": "16",
  });

  if (opts.panelIndex != null && theme !== "export") {
    const labelW = opts.labelW ?? 42;
    const hit = appendRect(
      parent,
      { x: rect.x, y: rect.y, w: rect.w + labelW, h: rect.h },
      {
        fill: "transparent",
        stroke: "none",
        class: "paper-svg-colorbar-hit",
        "data-panel-index": String(opts.panelIndex),
      }
    );
    hit.setAttribute("title", "Double-click to edit color limits");
    if (typeof opts.onColorbarDblClick === "function") {
      hit.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        opts.onColorbarDblClick(opts.panelIndex, e);
      });
    }
  }
}

export function appendCaption(parent, text, figureHeight, opts = {}) {
  const theme = opts.theme ?? "print";
  const fill = theme === "export" ? "#fff" : "#111";
  const lines = String(text ?? "").split(/\r?\n/);
  const lineHeight = opts.lineHeight ?? 14;
  const padTop = opts.padTop ?? 20;
  const g = document.createElementNS(SVG_NS, "g");
  for (let i = 0; i < lines.length; i++) {
    appendText(g, 12, figureHeight + padTop + i * lineHeight, lines[i], {
      fill,
      "font-size": "11",
    });
  }
  parent.appendChild(g);
  return g;
}

export const EXPORT_CAPTION_LINE_HEIGHT = 14;
export const EXPORT_CAPTION_PAD_TOP = 20;
export const EXPORT_CAPTION_PAD_BOTTOM = 12;

export function measureExportCaption(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const lineCount = Math.max(1, lines.length);
  return {
    lineCount,
    height: EXPORT_CAPTION_PAD_TOP + lineCount * EXPORT_CAPTION_LINE_HEIGHT + EXPORT_CAPTION_PAD_BOTTOM,
  };
}

export function appendImage(parent, rect, href) {
  const img = document.createElementNS(SVG_NS, "image");
  img.setAttribute("x", String(rect.x));
  img.setAttribute("y", String(rect.y));
  img.setAttribute("width", String(rect.w));
  img.setAttribute("height", String(rect.h));
  img.setAttribute("href", href);
  img.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", href);
  parent.appendChild(img);
  return img;
}

// ── Niivue volume helpers (no hist_panel dependency) ─────────────────────────

/** @returns {Promise<{ calMin: number, calMax: number } | null>} */
export function promptClimEdit({
  calMin,
  calMax,
  decimals = 2,
  title = "Intensity window",
  container = document.body,
  zIndex,
}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "clim-edit-dialog-overlay";
    if (Number.isFinite(zIndex)) overlay.style.zIndex = String(zIndex);
    overlay.innerHTML = `
      <div class="clim-edit-dialog" role="dialog" aria-label="${title}">
        <div class="clim-edit-dialog-title"></div>
        <div class="clim-edit-dialog-fields">
          <label class="clim-edit-field clim-edit-min"><span>Min</span><input type="number" step="any" class="clim-edit-in-min" /></label>
          <label class="clim-edit-field clim-edit-max"><span>Max</span><input type="number" step="any" class="clim-edit-in-max" /></label>
        </div>
        <div class="clim-edit-dialog-actions">
          <button type="button" class="btn clim-edit-cancel">Cancel</button>
          <button type="button" class="btn primary clim-edit-ok">Apply</button>
        </div>
      </div>`;
    overlay.querySelector(".clim-edit-dialog-title").textContent = title;

    const inMin = overlay.querySelector(".clim-edit-in-min");
    const inMax = overlay.querySelector(".clim-edit-in-max");
    inMin.value = Number(calMin).toFixed(decimals);
    inMax.value = Number(calMax).toFixed(decimals);

    const finish = (ok) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      if (!ok) {
        resolve(null);
        return;
      }
      const mn = parseFloat(inMin.value);
      const mx = parseFloat(inMax.value);
      resolve(Number.isFinite(mn) && Number.isFinite(mx) ? { calMin: mn, calMax: mx } : null);
    };
    const onKey = (e) => {
      if (e.key === "Escape") finish(false);
      if (e.key === "Enter") finish(true);
    };

    overlay.querySelector(".clim-edit-cancel").onclick = () => finish(false);
    overlay.querySelector(".clim-edit-ok").onclick = () => finish(true);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(false);
    });
    document.addEventListener("keydown", onKey);
    container.appendChild(overlay);
    inMin.focus();
    inMin.select();
  });
}

export function volumeIs4D(volume) {
  if (volume.nFrame4D != null && volume.nFrame4D > 1) return true;
  const d = volume.hdr?.dims;
  return !!(d && d[4] != null && d[4] > 1);
}

export function getNVox3D(volume) {
  if (volume.nVox3D) return volume.nVox3D;
  const d = volume.hdr?.dims;
  return !d || d.length < 4 ? 0 : d[1] * d[2] * d[3];
}

export function voxelBufferForDisplayedLayer(volume) {
  const img = volume.img;
  if (!img) throw new Error("volume has no img buffer");
  const nVox = getNVox3D(volume);
  if (!nVox) return img;
  const nFr =
    volume.nFrame4D ??
    (img.length >= nVox ? Math.max(1, Math.floor(img.length / nVox)) : 1);
  if (nFr <= 1) return img;
  const fi = Math.min(Math.max(0, volume.frame4D ?? 0), nFr - 1);
  const start = fi * nVox;
  return img.subarray(start, Math.min(start + nVox, img.length));
}

function computeSlabDataRange(vol, useRobustFallback = true) {
  if (!vol?.img) return { lo: 0, hi: 1 };
  const view = voxelBufferForDisplayedLayer(vol);
  let lo = Infinity;
  let hi = -Infinity;
  const stride = Math.max(1, Math.floor(view.length / 400_000));
  for (let i = 0; i < view.length; i += stride) {
    const v = vol.intensityRaw2Scaled(view[i]);
    if (Number.isFinite(v)) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (Number.isFinite(lo) && Number.isFinite(hi) && lo < hi) return { lo, hi };
  if (useRobustFallback) {
    return {
      lo: Number.isFinite(vol.robust_min) ? vol.robust_min : vol.global_min,
      hi: Number.isFinite(vol.robust_max) ? vol.robust_max : vol.global_max,
    };
  }
  return { lo: vol.global_min, hi: vol.global_max };
}

function computeSlabRobustClims(vol, lowPct = 0.02, highPct = 0.98) {
  const view = voxelBufferForDisplayedLayer(vol);
  const samples = [];
  const stride = Math.max(1, Math.floor(view.length / 400_000));
  for (let i = 0; i < view.length; i += stride) {
    const v = vol.intensityRaw2Scaled(view[i]);
    if (Number.isFinite(v)) samples.push(v);
  }
  if (!samples.length) return { calMin: vol.cal_min, calMax: vol.cal_max };
  samples.sort((a, b) => a - b);
  const lo = samples[Math.floor(samples.length * lowPct)] ?? samples[0];
  const hi =
    samples[Math.min(samples.length - 1, Math.floor(samples.length * highPct))] ??
    samples[samples.length - 1];
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) {
    return { calMin: vol.cal_min, calMax: vol.cal_max };
  }
  return { calMin: lo, calMax: hi };
}

export function syncVolumeClimsToCurrent4DFrame(vol, nv, frameIdxOverride = null) {
  if (!vol?.img) return { calMin: vol?.cal_min ?? 0, calMax: vol?.cal_max ?? 1 };
  const hasOverride = Number.isFinite(frameIdxOverride);
  const targetFrame = hasOverride ? Math.max(0, Math.floor(frameIdxOverride)) : (vol.frame4D ?? 0);
  if (volumeIs4D(vol)) {
    vol.frame4D = targetFrame;
    const frameRange = computeSlabDataRange(vol, false);
    if (Number.isFinite(frameRange.lo) && Number.isFinite(frameRange.hi) && frameRange.lo < frameRange.hi) {
      vol.cal_min = frameRange.lo;
      vol.cal_max = frameRange.hi;
    } else {
      const r = computeSlabRobustClims(vol);
      vol.cal_min = r.calMin;
      vol.cal_max = r.calMax;
    }
  }
  nv?.updateGLVolume?.();
  nv?.drawScene?.();
  return { calMin: vol.cal_min, calMax: vol.cal_max };
}

/** Patch Niivue contrast drag so 4D volumes use the active frame, not frame 0. */
export function installFrameAwareContrastDrag(nv) {
  if (!nv || nv._frameAwareRangeHook || typeof nv.calculateNewRange !== "function") return;
  nv._frameAwareRangeHook = true;
  const origCalcRange = nv.calculateNewRange.bind(nv);
  nv.calculateNewRange = (opts = {}) => {
    const volIdx = opts.volIdx ?? 0;
    const vol = nv.volumes?.[volIdx];
    if (vol?.img && volumeIs4D(vol)) {
      const nVox = getNVox3D(vol);
      const nFr = vol.nFrame4D ?? (nVox > 0 ? Math.max(1, Math.floor(vol.img.length / nVox)) : 1);
      const fi = Math.min(Math.max(0, vol.frame4D ?? 0), Math.max(0, nFr - 1));
      const start = fi * nVox;
      if (nVox > 0 && fi > 0 && start + nVox <= vol.img.length) {
        const savedImg = vol.img;
        vol.img = savedImg.subarray(start, start + nVox);
        try {
          return origCalcRange(opts);
        } finally {
          vol.img = savedImg;
        }
      }
    }
    return origCalcRange(opts);
  };
}
