import type { AnyfieldClient } from "../client/anyfield";
import type { State, StatePatch } from "../types";
import { applyPatch, DEFAULT_STATE } from "./patch";
import type { Selection } from "./selection";

/** A selection that lives only in this view (MCP App without a session). */
export class LocalSelection implements Selection {
  state = $state<State>(structuredClone(DEFAULT_STATE));
  error = $state<string | null>(null);
  readonly sessionKey = null;

  constructor(
    readonly client: AnyfieldClient,
    initial?: State,
    /** Called after every change, e.g. to update the chat's model context. */
    private onchange?: (state: State) => void,
  ) {
    if (initial) this.state = structuredClone(initial);
  }

  patch(patch: StatePatch): void {
    this.state = applyPatch($state.snapshot(this.state) as State, patch);
    this.onchange?.($state.snapshot(this.state) as State);
  }
}
