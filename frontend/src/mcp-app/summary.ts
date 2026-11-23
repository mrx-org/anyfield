import { isCas } from "../lib/phantom";
import type { PhantomChoice, State, Vec3 } from "../lib/types";

const v = (x: Vec3) => `(${x.map((n) => Math.round(n * 10) / 10).join(", ")})`;

const describe = (p: PhantomChoice | null) =>
  !p
    ? "the default phantom (subj04-3T-1mm.json, collection endres-brainweb-001)"
    : isCas(p)
      ? `${p.name} (in the CAS, sha256 ${p.sha256})`
      : `${p.name} (collection ${p.collection})`;

/** What the phantom browser hands back to the chat. */
export function phantomSummary(s: State): string {
  const name = describe(s.phantom);
  return `Chosen phantom: ${name}.`;
}

/** What the phantom preview hands back to the chat. */
export function previewSummary(s: State): string {
  const name = describe(s.phantom);
  const tissues = s.view.tissues?.length ? `tissues ${s.view.tissues.join(", ")}` : "all tissues";
  return `Phantom preview of ${name}: property ${s.view.property}, ${tissues}.`;
}

/** What the FOV planner hands back to the chat. */
export function fovSummary(s: State): string {
  const f = s.fov;
  return (
    `Planned FOV: center ${v(f.center_mm)} mm, rotation ${v(f.rotation_deg)}°, size ${v(f.size_mm)} mm, ` +
    `matrix ${s.matrix.join("×")}.`
  );
}
