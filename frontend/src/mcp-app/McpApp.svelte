<script lang="ts">
  // Shell of every anyfield MCP App: connects to the host, takes the session key
  // from the tool call that opened the app and hands a SessionStore to `tool`.
  // All calls go through the host's connection.
  import { App } from "@modelcontextprotocol/ext-apps";
  import { onDestroy, type Component } from "svelte";
  import { AnyfieldClient } from "../lib/client/anyfield";
  import { McpAppTransport } from "../lib/client/mcp-app";
  import { SessionStore } from "../lib/state/session.svelte";
  import type { SessionState } from "../lib/types";

  let { name, tool, height = 560 }: { name: string; tool: Component<{ store: SessionStore }>; height?: number } = $props();

  // svelte-ignore state_referenced_locally
  const app = new App({ name, version: "0.1.0" });
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

  const Tool = $derived(tool);
</script>

<div class="w-full" style="height: {height}px">
  {#if store}
    <Tool {store} />
  {:else}
    <p class="p-4 text-sm text-muted">{error ?? "Warte auf Session …"}</p>
  {/if}
</div>
