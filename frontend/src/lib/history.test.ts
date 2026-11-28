import { describe, expect, it } from "vitest";
import { graphRows } from "./history";
import type { HistoryState } from "./types";

const s = (hash: string, parent: string | null): HistoryState => ({ hash, parent, change: [], actor: "", time: 0 });

describe("graphRows", () => {
  it("puts a line in one lane", () => {
    const { rows, lanes } = graphRows([s("c", "b"), s("b", "a"), s("a", null)]);
    expect(lanes).toBe(1);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows[2].below).toEqual([]);
  });

  it("gives a branch its own lane until it meets its parent", () => {
    // a ← b ← c (main), b ← d (branch, newest)
    const { rows, lanes } = graphRows([s("d", "b"), s("c", "b"), s("b", "a"), s("a", null)]);
    expect(lanes).toBe(2);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 0]);
    // at b both lanes end in it
    expect(rows[2].above).toEqual([
      { from: 0, to: 0 },
      { from: 1, to: 0 },
    ]);
    expect(rows[2].below).toEqual([0]);
  });
});
