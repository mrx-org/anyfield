<script lang="ts">
  // MCP App (ui://anyfield/fov-planner.html): opened by the tool `open_fov_planner`.
  // The session key comes from the tool's arguments; all calls go through the host.
  import { App } from "@modelcontextprotocol/ext-apps";
  import { onDestroy } from "svelte";
  import { AnyfieldClient } from "../lib/client/anyfield";
  import { McpAppTransport } from "../lib/client/mcp-app";
  import FovPlanner from "../lib/components/fov/FovPlanner.svelte";
  import { SessionStore } from "../lib/state/session.svelte";
  import type { SessionState } from "../lib/types";

  const app = new App({ name: "anyfield-fov-planner", version: "0.1.0" });
  const client = new AnyfieldClient(new McpAppTransport(app));
  let store = $state<SessionStore | null>(null);
  let error = $state<string | null>(null);

  function open(key: string) {
    if (store?.key === key) return;
    store?.stop();
    store = new SessionStore(client, key);
    store.start();
  }

  // Register before connect(): the host may send these right after the handshake.
  app.ontoolinput = (params) => {
    const key = params.arguments?.session_key;
    if (typeof key === "string") open(key);
  };
  app.ontoolresult = (result) => {
    const state = result.structuredContent as SessionState | undefined;
    if (state?.key) {
      open(state.key);
      store?.accept(state);
    } else if (result.isError) {
      error = result.content?.map((c) => ("text" in c ? c.text : "")).join("\n") || "Fehler";
    }
  };
  app.connect().catch((e) => (error = String(e)));

  onDestroy(() => store?.stop());
</script>

<div class="h-[560px] w-full">
  {#if store}
    <FovPlanner {store} compact />
  {:else}
    <p class="p-4 text-sm text-muted">{error ?? "Warte auf Session …"}</p>
  {/if}
</div>
