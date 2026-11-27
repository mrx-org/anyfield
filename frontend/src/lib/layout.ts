// The workspace layout (state field `layout`) and its translation to and from
// dockview's serialized grid. Our form has fractions, dockview's pixels; dockview's
// grid alternates directions (a row holds columns, a column rows), so `normalize`
// merges a split into a parent split of the same direction, as the server does.
import type { SerializedDockview } from "dockview";
import type { Layout, LayoutNode, Panel, Split, Stack, StatePatch } from "./types";

export const isStack = (n: LayoutNode): n is Stack => "tabs" in n;

/** What `layout: null` stands for: the website's arrangement before there were layouts. */
export const DEFAULT_LAYOUT: Layout = {
  root: {
    split: "row",
    sizes: [0.22, 0.56, 0.22],
    children: [
      {
        split: "column",
        children: [{ tabs: [{ id: "phantom", tool: "phantom_browser" }] }, { tabs: [{ id: "sequence", tool: "sequence_browser" }] }],
      },
      { tabs: [{ id: "viewer", tool: "fov_viewer" }] },
      { tabs: [{ id: "planner", tool: "fov_planner" }] },
    ],
  },
};

/** The panels of a layout, in reading order (left to right, top to bottom). */
export function panelsOf(layout: Layout | null | undefined): Panel[] {
  const walk = (n: LayoutNode): Panel[] => (isStack(n) ? n.tabs : n.children.flatMap(walk));
  return layout?.root ? walk(layout.root) : [];
}

const round = (x: number) => Math.round(x * 1e4) / 1e4;

/** Sizes summing to 1, no split inside a split of the same direction, single children unwrapped. */
export function normalize(layout: Layout): Layout {
  const node = (n: LayoutNode): LayoutNode | null => {
    if (isStack(n)) return n.tabs.length ? { ...n } : null;
    const raw = n.sizes?.length === n.children.length ? n.sizes : n.children.map(() => 1);
    const kept: { child: LayoutNode; size: number }[] = [];
    n.children.forEach((c, i) => {
      const child = node(c);
      if (child && raw[i] > 0) kept.push({ child, size: raw[i] });
    });
    if (!kept.length) return null;
    if (kept.length === 1) return kept[0].child;
    const total = kept.reduce((s, k) => s + k.size, 0);
    const children: LayoutNode[] = [];
    const sizes: number[] = [];
    for (const { child, size } of kept) {
      if (!isStack(child) && child.split === n.split) {
        child.children.forEach((cc, j) => {
          children.push(cc);
          sizes.push((size / total) * (child.sizes?.[j] ?? 1 / child.children.length));
        });
      } else {
        children.push(child);
        sizes.push(size / total);
      }
    }
    return { split: n.split, children, sizes: sizes.map(round) };
  };
  return { root: layout.root ? node(layout.root) : null };
}

/** Same arrangement, sizes equal to within `tolerance` (pixels round them). */
export function sameLayout(a: Layout | null | undefined, b: Layout | null | undefined, tolerance = 0.01): boolean {
  const same = (x: LayoutNode | null | undefined, y: LayoutNode | null | undefined): boolean => {
    if (!x || !y) return !x && !y;
    if (isStack(x) || isStack(y)) {
      if (!isStack(x) || !isStack(y) || x.tabs.length !== y.tabs.length || (x.active ?? 0) !== (y.active ?? 0)) return false;
      return x.tabs.every((p, i) => {
        const q = y.tabs[i];
        return p.id === q.id && p.tool === q.tool && JSON.stringify(p.options ?? {}) === JSON.stringify(q.options ?? {});
      });
    }
    if (x.split !== y.split || x.children.length !== y.children.length) return false;
    const n = x.children.length;
    return x.children.every(
      (c, i) => same(c, y.children[i]) && Math.abs((x.sizes?.[i] ?? 1 / n) - (y.sizes?.[i] ?? 1 / n)) <= tolerance,
    );
  };
  return same(a?.root, b?.root);
}

const SPLIT_KEYS = ["split", "children", "sizes"];
const STACK_KEYS = ["tabs", "active"];

/** The state patch that makes `layout` the workspace's (null: back to the default). A
 * merge patch merges `root`, so the fields it lacks are removed explicitly (null). */
export function layoutPatch(layout: Layout | null): StatePatch["layout"] {
  if (!layout) return null;
  if (!layout.root) return { root: null };
  const root: Record<string, unknown> = { ...layout.root };
  for (const k of [...SPLIT_KEYS, ...STACK_KEYS]) if (!(k in root) || root[k] === undefined) root[k] = null;
  return { root };
}

/** A new panel id, unique in `layout`. */
export function newPanelId(layout: Layout | null | undefined): string {
  const taken = new Set(panelsOf(layout).map((p) => p.id));
  let id: string;
  do id = `p${Math.random().toString(16).slice(2, 8)}`;
  while (taken.has(id));
  return id;
}

/** `layout` with `panel` added as a tab of its first stack (or as the only one). */
export function withPanel(layout: Layout | null | undefined, panel: Panel): Layout {
  const add = (n: LayoutNode): [LayoutNode, boolean] => {
    if (isStack(n)) return [{ tabs: [...n.tabs, panel], active: n.tabs.length }, true];
    let done = false;
    const children = n.children.map((c) => {
      if (done) return c;
      const [next, added] = add(c);
      done = added;
      return next;
    });
    return [{ ...n, children }, done];
  };
  return layout?.root ? { root: add(layout.root)[0] } : { root: { tabs: [panel] } };
}

// --- dockview ------------------------------------------------------------------

type Orientation = "HORIZONTAL" | "VERTICAL";
type GridNode = SerializedDockview["grid"]["root"];

/** Our layout as dockview's serialized grid, for a container of `width` × `height` px. */
export function toDockview(layout: Layout, width: number, height: number, title: (tool: string) => string): SerializedDockview {
  const panels: SerializedDockview["panels"] = {};
  let groups = 0;
  const leaf = (s: Stack, size: number): GridNode => {
    for (const p of s.tabs) panels[p.id] = { id: p.id, contentComponent: p.tool, title: title(p.tool), params: { options: p.options ?? {} } };
    const active = s.tabs[Math.min(s.active ?? 0, s.tabs.length - 1)];
    return { type: "leaf", size, data: { id: `g${++groups}`, views: s.tabs.map((p) => p.id), activeView: active.id } };
  };
  // A split along its direction: each child gets its fraction of the extent along it
  const branch = (n: Split, w: number, h: number, size: number): GridNode => {
    const along = n.split === "row" ? w : h;
    const data = n.children.map((c, i) => {
      const part = along * (n.sizes?.[i] ?? 1 / n.children.length);
      const [cw, ch] = n.split === "row" ? [part, h] : [w, part];
      return isStack(c) ? leaf(c, part) : branch(c, cw, ch, part);
    });
    return { type: "branch", size, data };
  };
  const root = layout.root;
  const orientation: Orientation = root && !isStack(root) && root.split === "column" ? "VERTICAL" : "HORIZONTAL";
  const gridRoot: GridNode = !root
    ? { type: "branch", size: height, data: [] }
    : isStack(root)
      ? { type: "branch", size: height, data: [leaf(root, width)] }
      : branch(root, width, height, orientation === "HORIZONTAL" ? height : width);
  return { grid: { root: gridRoot, width, height, orientation: orientation as SerializedDockview["grid"]["orientation"] }, panels };
}

/** dockview's serialized grid in our form (normalized). */
export function fromDockview(json: SerializedDockview): Layout {
  const node = (n: GridNode, orientation: Orientation): LayoutNode | null => {
    if (n.type === "leaf") {
      const g = n.data as { views: string[]; activeView?: string };
      const tabs: Panel[] = g.views.map((id) => {
        const p = json.panels[id];
        const options = (p?.params?.options ?? {}) as Record<string, unknown>;
        return { id, tool: p?.contentComponent ?? "", ...(Object.keys(options).length ? { options } : {}) };
      });
      if (!tabs.length) return null;
      const active = Math.max(0, g.views.indexOf(g.activeView ?? ""));
      return active ? { tabs, active } : { tabs };
    }
    const next: Orientation = orientation === "HORIZONTAL" ? "VERTICAL" : "HORIZONTAL";
    const kids = (n.data as GridNode[]).map((c) => ({ child: node(c, next), size: c.size ?? 1 }));
    const kept = kids.filter((k): k is { child: LayoutNode; size: number } => k.child !== null);
    return kept.length
      ? { split: orientation === "HORIZONTAL" ? "row" : "column", children: kept.map((k) => k.child), sizes: kept.map((k) => k.size) }
      : null;
  };
  return normalize({ root: node(json.grid.root, json.grid.orientation as Orientation) });
}
