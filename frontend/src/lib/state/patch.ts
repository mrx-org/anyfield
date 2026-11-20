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
  return { ...next, phantom: next.phantom ?? null };
}

export const DEFAULT_STATE: State = {
  phantom: null,
  view: { property: "density", plane: "tra", tissues: null },
  fov: { center_mm: [0, 0, 0], rotation_deg: [0, 0, 0], size_mm: [200, 200, 100] },
  matrix: [128, 128, 1],
};

/** What `phantom: null` stands for (the backend's `DEFAULT_PHANTOM`). */
export const DEFAULT_PHANTOM: CatalogPhantom = { collection: "endres-brainweb-001", name: "subj04-3T-1mm.json" };
