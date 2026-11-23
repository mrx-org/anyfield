import { phantomArgs, phantomKey } from "../phantom";
import type { FileMode } from "../files";
import type { FovChange, PhantomChoice, PhantomCollection, PhantomMaps, PhantomTree, ScanGrid, Session, SessionSummary, StatePatch, UserFile, Vec3 } from "../types";
import type { Transport } from "./transport";

export type SessionPoll = Session | { rev: number; unchanged: true };

/** Typed wrappers for the anyfield MCP tools. */
export class AnyfieldClient {
  private maps = new Map<string, Promise<PhantomMaps>>();
  private tissues = new Map<string, Promise<string[]>>();

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
  /** With `expectedRev`: only if the session is still at that revision (else an error). */
  patchState = (key: string, patch: StatePatch, expectedRev?: number) =>
    this.call<Session>("patch_state", { session_key: key, patch, ...(expectedRev !== undefined ? { expected_rev: expectedRev } : {}) });
  moveFov = (key: string, delta_mm: Vec3) => this.call<FovChange>("move_fov", { session_key: key, delta_mm });

  // The user's files in the gateway's storage
  /** The last list this client loaded per mode: shown at once while a new one loads. */
  lastFiles = new Map<FileMode, UserFile[]>();
  /** `mode` bifti: only the phantoms. `refresh`: past the server's cache of a few
   * minutes (after an upload, reload). */
  async listUserFiles(mode: FileMode = "all", refresh = false): Promise<UserFile[]> {
    const files = await this.call<UserFile[]>("list_user_files", { mode, ...(refresh ? { refresh } : {}) });
    this.lastFiles.set(mode, files);
    return files;
  }
  createFileUploadUrl = (fileName: string) =>
    this.call<{ url: string; expires_in: number | null }>("create_file_upload_url", { file_name: fileName });

  /** Upload a file straight to the gateway (not through MCP); resolves with its sha256. */
  async uploadFile(file: File, onprogress?: (fraction: number) => void): Promise<string> {
    const { url } = await this.createFileUploadUrl(file.name);
    // XHR, not fetch: only XHR reports upload progress. POST, not PUT: the gateway's
    // CORS allows no PUT from a browser.
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      if (file.type) xhr.setRequestHeader("Content-Type", file.type);
      xhr.upload.onprogress = (e) => e.lengthComputable && onprogress?.(e.loaded / e.total);
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve(xhr.responseText.trim())
          : reject(new Error(`Upload fehlgeschlagen (${xhr.status}): ${xhr.responseText || xhr.statusText}`));
      xhr.onerror = () => reject(new Error("Upload fehlgeschlagen (Netzwerk)."));
      xhr.send(file);
    });
  }

  // Phantoms (BIfTI catalog from the gateway)
  listPhantomCollections = () => this.call<PhantomCollection[]>("list_phantom_collections");
  listPhantoms = (collection: string, path?: string[]) =>
    this.call<PhantomTree>("list_phantoms", { collection, ...(path ? { path } : {}) });
  /** The caller's bifti .zip files in the gateway's CAS. */

  /** The tissue names of a phantom (null: the default), cached per phantom. */
  listTissues(phantom: PhantomChoice | null): Promise<string[]> {
    const id = phantom ? phantomKey(phantom) : "";
    let p = this.tissues.get(id);
    if (!p) {
      p = this.call<{ tissues: string[] }>("list_phantom_tissues", phantom ? phantomArgs(phantom) : {}).then(
        (r) => r.tissues,
      );
      p.catch(() => this.tissues.delete(id));
      this.tissues.set(id, p);
    }
    return p;
  }

  /**
   * Maps of a phantom (null: the default), from the gateway. With `grid` resliced
   * onto the planned scan grid. Maps on the phantom's own grid are cached per
   * phantom; computing new ones can take a minute.
   */
  getPhantomMaps(phantom: PhantomChoice | null, grid?: ScanGrid, tissues?: string[] | null): Promise<PhantomMaps> {
    const args = {
      ...(phantom ? phantomArgs(phantom) : {}),
      ...(grid ? { fov: grid.fov, matrix: grid.matrix } : {}),
      ...(tissues?.length ? { tissues } : {}),
    };
    if (grid) return this.call<PhantomMaps>("get_phantom_maps", args);
    const id = `${phantom ? phantomKey(phantom) : ""}|${tissues?.length ? [...tissues].sort().join(",") : ""}`;
    let p = this.maps.get(id);
    if (!p) {
      p = this.call<PhantomMaps>("get_phantom_maps", args);
      p.catch(() => this.maps.delete(id));
      this.maps.set(id, p);
    }
    return p;
  }
}
