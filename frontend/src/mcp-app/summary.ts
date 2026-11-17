import type { State, Vec3 } from "../lib/types";

const v = (x: Vec3) => `(${x.map((n) => Math.round(n * 10) / 10).join(", ")})`;

/** What the phantom browser hands back to the chat. */
export function phantomSummary(s: State): string {
  const p = s.phantom;
  const name = p ? `${p.name} (collection ${p.collection})` : "the default phantom (subj04-3T-1mm.json, collection endres-brainweb-001)";
  return `Chosen phantom: ${name}, shown property: ${s.view.property}.`;
}

/** What the FOV planner hands back to the chat. */
export function fovSummary(s: State): string {
  const f = s.fov;
  return (
    `Planned FOV: center ${v(f.center_mm)} mm, rotation ${v(f.rotation_deg)}°, size ${v(f.size_mm)} mm, ` +
    `matrix ${s.matrix.join("×")}.`
  );
}
