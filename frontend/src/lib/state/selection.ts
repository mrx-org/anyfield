import type { AnyfieldClient } from "../client/anyfield";
import type { State, StatePatch } from "../types";

/**
 * What a tool component is bound to: the current choices and a way to change
 * them. Components never know where the state lives:
 * - SessionStore: a session on the server (shared with the AI and other browsers),
 * - LocalSelection: only in this view (MCP App without session); the result goes
 *   back to the chat.
 */
export interface Selection {
  readonly client: AnyfieldClient;
  /** Current state, local edits included; null until loaded. */
  readonly state: State | null;
  readonly error: string | null;
  /** Session key, or null for a local selection. */
  readonly sessionKey: string | null;
  /** Revision of the session's state; null for a local selection. */
  readonly rev: number | null;
  /** Change the state at once (merge patch); a session commits it in the background. */
  patch(patch: StatePatch): void;
  /** Change the state and wait for the result: rejects with the server's message if it
   * does not validate, or (with `expectedRev`) if the session has changed since. */
  commit(patch: StatePatch, expectedRev?: number): Promise<void>;
}
