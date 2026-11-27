import type { CatalogPhantom, State, StatePatch } from "../types";

/** RFC 7386 JSON Merge Patch: objects merge, null removes, the rest replaces. */
export function mergePatch<T>(target: T, patch: unknown): T {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch as T;
  const out: Record<string, unknown> =
    target !== null && typeof target === "object" && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (v !== undefined) out[k] = mergePatch(out[k], v);
  }
  return out as T;
}

/**
 * One merge patch with the effect of `first`, then `second`. Unlike `mergePatch`
 * it keeps the `null`s: they still have to remove fields on the server.
 */
export function composePatch<T>(first: T, second: unknown): T {
  if (second === null || typeof second !== "object" || Array.isArray(second)) return second as T;
  const out: Record<string, unknown> =
    first !== null && typeof first === "object" && !Array.isArray(first) ? { ...(first as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(second)) {
    if (v === null) out[k] = null;
    else if (v !== undefined) {
      // After a removal (null) the object goes as it is. It then merges onto the server's
      // field instead of replacing it, so it must null what it removes (phantomPatch does).
      const before = out[k];
      out[k] = before === null && typeof v === "object" && !Array.isArray(v) ? v : composePatch(before, v);
    }
  }
  return out as T;
}

/** A state with a patch applied; a removed phantom is the default (null). */
export function applyPatch(state: State, patch: StatePatch): State {
  const next = mergePatch(state, patch);
  return { ...next, phantom: next.phantom ?? null, tissues: next.tissues ?? null, sequence: next.sequence ?? null };
}

export const DEFAULT_STATE: State = {
  phantom: null,
  tissues: null,
  view: { property: "density" },
  fov: { center_mm: [0, 0, 0], rotation_deg: [0, 0, 0], size_mm: [200, 200, 100] },
  matrix: [128, 128, 1],
  sequence: null,
};

/** What `phantom: null` stands for (the backend's `DEFAULT_PHANTOM`). */
export const DEFAULT_PHANTOM: CatalogPhantom = { collection: "endres-brainweb-001", name: "subj04-3T-1mm.json" };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The merge patch that turns `from` into `to`: changed values (arrays whole), `null`
 * for fields `to` lacks (removed: back to their default), nothing for equal ones.
 * Both must be objects.
 */
export function diffPatch(from: Record<string, unknown>, to: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(from)) if (!(k in to) && from[k] !== null) out[k] = null;
  for (const [k, v] of Object.entries(to)) {
    const before = from[k];
    if (isObject(before) && isObject(v)) {
      const d = diffPatch(before, v);
      if (Object.keys(d).length) out[k] = d;
    } else if (JSON.stringify(before) !== JSON.stringify(v)) {
      // An object over something else goes whole; null over a value removes it
      out[k] = v;
    }
  }
  return out;
}
