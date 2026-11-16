import type { Fov, SessionState, Vec3 } from "../types";
import { ToolCallError, type Transport } from "./transport";

/** In-memory stand-in for the server (tests, offline demos). Mirrors its tool semantics. */
export class MockTransport implements Transport {
  sessions = new Map<string, SessionState>();
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  constructor(initial: Partial<SessionState> = {}) {
    const s: SessionState = {
      key: "mock-key",
      name: "Mock",
      rev: 1,
      owner_login: "mock",
      updated_at: 0,
      fov: { center_mm: [0, 0, 0], rotation_deg: [0, 0, 0], size_mm: [200, 200, 100] },
      phantom: { collection: null, name: "default", property: "density", status: "ready", error: null, properties: [{ key: "density", label: "PD", unit: "a.u.", range: null }], url: "/files/phantom.nii.gz" },
      phantom_url: "/files/phantom.nii.gz",
      web_url: "/s/mock-key",
      ...initial,
    };
    this.sessions.set(s.key, s);
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ name, args });
    const s = this.sessions.get(args.session_key as string);
    if (!s) throw new ToolCallError(name, "Unknown session key.");
    const change = (fov: Fov) => {
      s.fov = fov;
      s.rev += 1;
      return { rev: s.rev, fov: s.fov, summary: "" };
    };
    const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    switch (name) {
      case "get_session":
        return args.known_rev === s.rev ? { rev: s.rev, unchanged: true } : structuredClone(s);
      case "set_fov":
        return change({ ...s.fov, ...(pick(args, ["center_mm", "rotation_deg", "size_mm"]) as Partial<Fov>) });
      case "move_fov":
        return change({ ...s.fov, center_mm: add(s.fov.center_mm, args.delta_mm as Vec3) });
      case "rotate_fov":
        return change({ ...s.fov, rotation_deg: add(s.fov.rotation_deg, args.delta_deg as Vec3) });
      case "select_phantom": {
        const props = ["density", "T1", "T2"].map((k) => ({ key: k, label: k, unit: "", range: null }));
        s.phantom = { collection: args.collection as string, name: args.phantom as string, property: (args.property as string) ?? "density", status: "ready", error: null, properties: props, url: `/files/phantoms/${args.collection}/${args.phantom}/density.nii.gz` };
        s.phantom_url = s.phantom.url;
        s.rev += 1;
        return structuredClone(s.phantom);
      }
      case "set_phantom_property":
        s.phantom = { ...s.phantom, property: args.property as string, url: `${s.phantom.url?.replace(/[^/]+\.nii\.gz$/, "")}${args.property}.nii.gz` };
        s.phantom_url = s.phantom.url;
        s.rev += 1;
        return structuredClone(s.phantom);
      default:
        throw new ToolCallError(name, `MockTransport: ${name} not implemented`);
    }
  }
}

function pick(o: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
}
