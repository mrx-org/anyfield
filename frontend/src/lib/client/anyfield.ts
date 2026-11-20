import { phantomArgs, phantomKey } from "../phantom";
import type { CasPhantomEntry, FovChange, PhantomChoice, PhantomCollection, PhantomMaps, PhantomTree, ScanGrid, Session, SessionSummary, StatePatch, Vec3 } from "../types";
import type { Transport } from "./transport";

export type SessionPoll = Session | { rev: number; unchanged: true };

/** Typed wrappers for the anyfield MCP tools. */
export class AnyfieldClient {
  private maps = new Map<string, Promise<PhantomMaps>>();

  constructor(readonly transport: Transport) {}

  private call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.transport.callTool(name, args) as Promise<T>;
  }

  // Session management (needs a login)
  listSessions = () => this.call<SessionSummary[]>("list_sessions");
  createSession = (name?: string) => this.call<Session>("create_session", name ? { name } : {});
  renameSession = (key: string, name: string) => this.call<Session>("rename_session", { session_key: key, name });
  deleteSession = (key: string) => this.call<string>("delete_session", { session_key: key });

  // Session state (session key only)
  getState = (key: string, knownRev?: number) =>
    this.call<SessionPoll>("get_state", { session_key: key, ...(knownRev !== undefined ? { known_rev: knownRev } : {}) });
  patchState = (key: string, patch: StatePatch) => this.call<Session>("patch_state", { session_key: key, patch });
  moveFov = (key: string, delta_mm: Vec3) => this.call<FovChange>("move_fov", { session_key: key, delta_mm });

  // Phantoms (BIfTI catalog from the gateway)
  listPhantomCollections = () => this.call<PhantomCollection[]>("list_phantom_collections");
  listPhantoms = (collection: string, path?: string[]) =>
    this.call<PhantomTree>("list_phantoms", { collection, ...(path ? { path } : {}) });
  /** The caller's bifti .zip files in the gateway's CAS. */
  listCasPhantoms = () => this.call<CasPhantomEntry[]>("list_cas_phantoms");

  /**
   * Maps of a phantom (null: the default), from the gateway. With `grid` resliced
   * onto the planned scan grid. Maps on the phantom's own grid are cached per
   * phantom; computing new ones can take a minute.
   */
  getPhantomMaps(phantom: PhantomChoice | null, grid?: ScanGrid): Promise<PhantomMaps> {
    const args = {
      ...(phantom ? phantomArgs(phantom) : {}),
      ...(grid ? { fov: grid.fov, matrix: grid.matrix } : {}),
    };
    if (grid) return this.call<PhantomMaps>("get_phantom_maps", args);
    const id = phantom ? phantomKey(phantom) : "";
    let p = this.maps.get(id);
    if (!p) {
      p = this.call<PhantomMaps>("get_phantom_maps", args);
      p.catch(() => this.maps.delete(id));
      this.maps.set(id, p);
    }
    return p;
  }
}
