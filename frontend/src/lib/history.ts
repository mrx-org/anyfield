// The history tree as rows of a graph, like `git log --graph`: newest first, each
// state in a lane (column); a lane runs down to the state's parent. Pure, for the
// history tool to draw.
import type { HistoryState } from "./types";

export interface GraphRow {
  state: HistoryState;
  /** The state's lane. */
  lane: number;
  /** Lanes coming in from above: each runs to `lane` (it ends here) or straight on. */
  above: { from: number; to: number }[];
  /** Lanes going on below this row (to the parents further down). */
  below: number[];
}

/** Rows for `states` (newest first, as get_history returns them). */
export function graphRows(states: HistoryState[]): { rows: GraphRow[]; lanes: number } {
  // Per lane the state it waits for (the parent of the state above), or null if free
  let lanes: (string | null)[] = [];
  let width = 0;
  const rows: GraphRow[] = [];
  for (const state of states) {
    const waiting = lanes.flatMap((h, i) => (h === state.hash ? [i] : []));
    let lane = waiting[0] ?? lanes.indexOf(null);
    if (lane === -1) lane = lanes.length;
    const above = lanes.flatMap((h, i) => (h === null ? [] : [{ from: i, to: h === state.hash ? lane : i }]));
    const next = [...lanes];
    for (const i of waiting) next[i] = null;
    next[lane] = state.parent;
    while (next.length && next[next.length - 1] === null) next.pop();
    lanes = next;
    width = Math.max(width, lane + 1, lanes.length);
    rows.push({ state, lane, above, below: lanes.flatMap((h, i) => (h === null ? [] : [i])) });
  }
  return { rows, lanes: width };
}

/** The children of a state among `states`. */
export const childrenOf = (states: HistoryState[], hash: string) => states.filter((s) => s.parent === hash);

/** The client part of an actor (`anyfield-web (alice@x)` → `anyfield-web`). */
export const actorName = (actor: string) => actor.replace(/\s*\(.*\)$/, "") || "?";
