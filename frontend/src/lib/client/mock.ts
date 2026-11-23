import { applyPatch, DEFAULT_STATE } from "../state/patch";
import type { Session, StatePatch, Vec3 } from "../types";
import { ToolCallError, type Transport } from "./transport";

/** In-memory stand-in for the server (tests, offline demos). Mirrors its tool semantics. */
export class MockTransport implements Transport {
  sessions = new Map<string, Session>();
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  constructor(initial: Partial<Session> = {}) {
    const s: Session = {
      key: "mock-key",
      name: "Mock",
      rev: 1,
      updated_at: 0,
      state: structuredClone(DEFAULT_STATE),
      web_url: "/s/mock-key",
      ...initial,
    };
    this.sessions.set(s.key, s);
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ name, args });
    if (name === "get_phantom_maps") {
      const phantom = args.sha256
        ? { sha256: args.sha256 as string, name: "cas.zip" }
        : args.collection
          ? { collection: args.collection as string, name: args.phantom as string }
          : { collection: "endres-brainweb-001", name: "subj04-3T-1mm.json" };
      const props = ["density", "T1", "T2"].map((k) => ({ key: k, label: k, unit: "", range: null, url: `https://gateway.test/files/${phantom.name}-${k}` }));
      const shape = args.matrix ?? [181, 217, 181];
      return { phantom, default: !args.collection && !args.sha256, shape, spacing_mm: [1, 1, 1], affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]], coarsening: 1, properties: props };
    }
    const s = this.sessions.get(args.session_key as string);
    if (!s) throw new ToolCallError(name, "Unknown session key.");
    switch (name) {
      case "get_state":
        return args.known_rev === s.rev ? { rev: s.rev, unchanged: true } : structuredClone(s);
      case "patch_state":
        if (args.expected_rev != null && args.expected_rev !== s.rev)
          throw new ToolCallError(name, `Conflict: session is at rev ${s.rev}, not ${args.expected_rev}. Re-read it.`);
        s.state = applyPatch(s.state, args.patch as StatePatch);
        s.rev += 1;
        return structuredClone(s);
      case "move_fov": {
        const [c, d] = [s.state.fov.center_mm, args.delta_mm as Vec3];
        s.state.fov.center_mm = [c[0] + d[0], c[1] + d[1], c[2] + d[2]];
        s.rev += 1;
        return { rev: s.rev, fov: s.state.fov, summary: "" };
      }
      default:
        throw new ToolCallError(name, `MockTransport: ${name} not implemented`);
    }
  }
}
