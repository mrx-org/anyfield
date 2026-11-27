import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, fromDockview, layoutPatch, normalize, panelsOf, sameLayout, toDockview, withPanel } from "./layout";
import { applyPatch, DEFAULT_STATE } from "./state/patch";
import type { Layout } from "./types";

const title = (t: string) => t;

describe("dockview round trip", () => {
  it("keeps arrangement, sizes and active tabs", () => {
    const layout: Layout = {
      root: {
        split: "row",
        sizes: [0.25, 0.75],
        children: [
          { tabs: [{ id: "a", tool: "phantom_browser" }, { id: "b", tool: "file_list", options: { mode: "sequence" } }], active: 1 },
          { split: "column", sizes: [0.4, 0.6], children: [{ tabs: [{ id: "c", tool: "fov_viewer" }] }, { tabs: [{ id: "d", tool: "fov_planner" }] }] },
        ],
      },
    };
    const json = toDockview(layout, 1000, 800, title);
    expect(json.grid.orientation).toBe("HORIZONTAL");
    expect(json.panels.b.params).toEqual({ options: { mode: "sequence" } });
    const back = fromDockview(json);
    expect(sameLayout(back, layout)).toBe(true);
    expect(back).toEqual(layout);
  });

  it("handles a single stack, a column root and the default", () => {
    for (const layout of [
      { root: { tabs: [{ id: "x", tool: "session" }] } },
      { root: { split: "column" as const, children: [{ tabs: [{ id: "x", tool: "session" }] }, { tabs: [{ id: "y", tool: "file_upload" }] }] } },
      DEFAULT_LAYOUT,
    ]) {
      expect(sameLayout(fromDockview(toDockview(layout, 640, 480, title)), layout)).toBe(true);
    }
    expect(fromDockview(toDockview({ root: null }, 640, 480, title))).toEqual({ root: null });
  });
});

describe("normalize", () => {
  it("merges same-direction splits and unwraps single children", () => {
    const n = normalize({
      root: {
        split: "row",
        children: [
          { tabs: [{ id: "a", tool: "x" }] },
          { split: "row", children: [{ tabs: [{ id: "b", tool: "x" }] }, { split: "column", children: [{ tabs: [{ id: "c", tool: "x" }] }] }] },
        ],
      },
    });
    expect(n.root).toEqual({
      split: "row",
      children: [{ tabs: [{ id: "a", tool: "x" }] }, { tabs: [{ id: "b", tool: "x" }] }, { tabs: [{ id: "c", tool: "x" }] }],
      sizes: [0.5, 0.25, 0.25],
    });
  });
});

describe("layoutPatch", () => {
  it("replaces a split root by a stack", () => {
    const withSplit = applyPatch(DEFAULT_STATE, { layout: layoutPatch(DEFAULT_LAYOUT) });
    expect(withSplit.layout).toEqual(DEFAULT_LAYOUT);
    const stack: Layout = { root: { tabs: [{ id: "x", tool: "session" }] } };
    expect(applyPatch(withSplit, { layout: layoutPatch(stack) }).layout).toEqual(stack);
    expect(applyPatch(withSplit, { layout: layoutPatch(null) }).layout).toBeNull();
  });
});

describe("withPanel", () => {
  it("adds a tab to the first stack and shows it", () => {
    const l = withPanel(DEFAULT_LAYOUT, { id: "n", tool: "session" });
    expect(panelsOf(l).map((p) => p.id)).toEqual(["phantom", "n", "sequence", "viewer", "planner"]);
    expect(withPanel({ root: null }, { id: "n", tool: "session" })).toEqual({ root: { tabs: [{ id: "n", tool: "session" }] } });
  });
});
