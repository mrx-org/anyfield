<script lang="ts">
  // Shell of every anyfield MCP App: connects to the host and binds `tool` to a
  // Selection. With a `session_key` in the tool call: the session (shared with
  // the website and the AI). Without: a local selection; every change updates
  // the chat's model context, and "In den Chat" sends the choice as a message.
  // The app is as tall as its content: the SDK reports that height to the host
  // (`ui/notifications/size-changed`, autoResize). Only a height or maxHeight the
  // host gives (`containerDimensions`) limits it; then the content scrolls inside.
  import { App, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
  import { onDestroy, type Component } from "svelte";
  import { AnyfieldClient } from "../lib/client/anyfield";
  import { McpAppTransport } from "../lib/client/mcp-app";
  import ToolFrame from "../lib/components/ToolFrame.svelte";
  import { LocalSelection } from "../lib/state/local.svelte";
  import type { Selection } from "../lib/state/selection";
  import { SessionStore } from "../lib/state/session.svelte";
  import type { Session, State } from "../lib/types";

  let {
    name,
    toolName,
    tool,
    summary,
  }: {
    name: string;
    /** Shown on the frame: the MCP tool that opens this app, without `open_`. */
    toolName: string;
    tool: Component<{ sel: Selection }>;
    summary: (state: State) => string;
  } = $props();

  // svelte-ignore state_referenced_locally
  const app = new App({ name, version: "0.1.0" });
  const client = new AnyfieldClient(new McpAppTransport(app));
  let sel = $state<Selection | null>(null);
  let error = $state<string | null>(null);
  let sent = $state(false);
  let container = $state<McpUiHostContext["containerDimensions"]>(undefined);
  /** The host's limit on our height, as inline style ("" = as tall as the content). */
  const sizeStyle = $derived(
    container && "height" in container
      ? `height: ${container.height}px`
      : container?.maxHeight
        ? `max-height: ${container.maxHeight}px`
        : "",
  );

  function openSession(key: string) {
    if (sel?.sessionKey === key) return;
    if (sel instanceof SessionStore) sel.stop();
    const store = new SessionStore(client, key);
    store.start();
    sel = store;
  }

  function openLocal(initial?: State) {
    if (sel instanceof LocalSelection) {
      if (initial) sel.state = structuredClone(initial);
      return;
    }
    sel = new LocalSelection(client, initial, (state) => {
      sent = false;
      app.updateModelContext({ content: [{ type: "text", text: summary(state) }] }).catch(() => {});
    });
  }

  async function sendToChat() {
    if (!sel?.state) return;
    const r = await app.sendMessage({ role: "user", content: [{ type: "text", text: summary(sel.state) }] });
    sent = !r.isError;
  }

  // Register before connect(): the host may send these right after the handshake.
  // Without a session the local selection starts from the tool result's state (e.g.
  // the phantom the preview was opened for), so it opens only once that arrives.
  app.ontoolinput = (params) => {
    const key = params.arguments?.session_key;
    if (typeof key === "string" && key) openSession(key);
  };
  app.ontoolresult = (result) => {
    const r = result.structuredContent as (Partial<Session> & { state?: State }) | undefined;
    if (result.isError) {
      error = result.content?.map((c) => ("text" in c ? c.text : "")).join("\n") || "Fehler";
    } else if (r?.key) {
      openSession(r.key);
      if (sel instanceof SessionStore) sel.accept(r as Session);
    } else {
      openLocal(r?.state);
    }
  };
  app.onhostcontextchanged = (ctx) => {
    if (ctx.containerDimensions) container = ctx.containerDimensions;
  };
  app.connect().then(
    () => (container = app.getHostContext()?.containerDimensions),
    (e) => (error = String(e)),
  );

  onDestroy(() => {
    if (sel instanceof SessionStore) sel.stop();
  });

  const Tool = $derived(tool);
</script>

<div class="flex w-full flex-col p-1" style={sizeStyle}>
  <ToolFrame name={toolName} class="flex-1">
    {#if sel}
      <div class="min-h-0 flex-1 overflow-y-auto"><Tool {sel} /></div>
      {#if !sel.sessionKey}
        <footer class="flex items-center gap-2 border-t border-border bg-panel px-3 py-2 text-xs">
          <span class="min-w-0 flex-1 truncate text-muted" title={sel.state ? summary(sel.state) : ""}>
            {sel.state ? summary(sel.state) : ""}
          </span>
          <button class="shrink-0 rounded bg-accent px-3 py-1 font-medium text-black" onclick={sendToChat}>
            {sent ? "Gesendet" : "In den Chat"}
          </button>
        </footer>
      {/if}
    {:else}
      <p class="p-4 text-sm text-muted">{error ?? "Warte auf Tool-Aufruf …"}</p>
    {/if}
  </ToolFrame>
</div>
