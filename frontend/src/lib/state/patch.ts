import type { PhantomChoice, State, StatePatch } from "../types";

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

/** A state with a patch applied; a removed phantom is the default (null). */
export function applyPatch(state: State, patch: StatePatch): State {
  const next = mergePatch(state, patch);
  return { ...next, phantom: next.phantom ?? null };
}

export const DEFAULT_STATE: State = {
  phantom: null,
  view: { property: "density", plane: "tra" },
  fov: { center_mm: [0, 0, 0], rotation_deg: [0, 0, 0], size_mm: [200, 200, 100] },
  matrix: [128, 128, 1],
};

/** What `phantom: null` stands for (the backend's `DEFAULT_PHANTOM`). */
export const DEFAULT_PHANTOM: PhantomChoice = { collection: "endres-brainweb-001", name: "subj04-3T-1mm.json" };
