import type { State, Vec3 } from "../lib/types";

const v = (x: Vec3) => `(${x.map((n) => Math.round(n * 10) / 10).join(", ")})`;

/** What the phantom browser hands back to the chat. */
export function phantomSummary(s: State): string {
  const p = s.phantom;
  const name = p ? `${p.name} (collection ${p.collection})` : "the default phantom (subj04-3T-1mm.json, collection endres-brainweb-001)";
  return `Chosen phantom: ${name}.`;
}

const PLANES = { tra: "transversal", cor: "coronal", sag: "sagittal", "3d": "3D rendering" };

/** What the phantom preview hands back to the chat. */
export function previewSummary(s: State): string {
  const p = s.phantom;
  const name = p ? `${p.name} (collection ${p.collection})` : "the default phantom (subj04-3T-1mm.json)";
  return `Phantom preview of ${name}: property ${s.view.property}, ${PLANES[s.view.plane]} view.`;
}

/** What the FOV planner hands back to the chat. */
export function fovSummary(s: State): string {
  const f = s.fov;
  return (
    `Planned FOV: center ${v(f.center_mm)} mm, rotation ${v(f.rotation_deg)}°, size ${v(f.size_mm)} mm, ` +
    `matrix ${s.matrix.join("×")}.`
  );
}
