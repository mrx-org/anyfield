import type { FovChange, SessionState, SessionSummary, Vec3 } from "../types";
import type { Transport } from "./transport";

export type SessionPoll = SessionState | { rev: number; unchanged: true };

/** Typed wrappers for the anyfield MCP tools. */
export class AnyfieldClient {
  constructor(readonly transport: Transport) {}

  private call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.transport.callTool(name, args) as Promise<T>;
  }

  // Session management (needs a GitHub login)
  listSessions = () => this.call<SessionSummary[]>("list_sessions");
  createSession = (name?: string) => this.call<SessionState>("create_session", name ? { name } : {});
  renameSession = (key: string, name: string) => this.call<SessionState>("rename_session", { session_key: key, name });
  deleteSession = (key: string) => this.call<string>("delete_session", { session_key: key });

  // Session tools (session key only)
  getSession = (key: string, knownRev?: number) =>
    this.call<SessionPoll>("get_session", { session_key: key, ...(knownRev !== undefined ? { known_rev: knownRev } : {}) });
  setFov = (key: string, fov: { center_mm?: Vec3; rotation_deg?: Vec3; size_mm?: Vec3 }) =>
    this.call<FovChange>("set_fov", { session_key: key, ...fov });
  moveFov = (key: string, delta_mm: Vec3) => this.call<FovChange>("move_fov", { session_key: key, delta_mm });
  rotateFov = (key: string, delta_deg: Vec3) => this.call<FovChange>("rotate_fov", { session_key: key, delta_deg });
}
