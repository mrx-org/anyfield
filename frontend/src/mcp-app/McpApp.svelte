<script lang="ts">
  // Shell of every anyfield MCP App: connects to the host and binds `tool` to a
  // Selection. With a `session_key` in the tool call: the session (shared with
  // the website and the AI). Without: a local selection; every change updates
  // the chat's model context, and "In den Chat" sends the choice as a message.
  // The app is as tall as its content: the SDK reports that height to the host
  // (`ui/notifications/size-changed`, autoResize). Only a height or maxHeight the
  // host gives (`containerDimensions`) limits it; then the content scrolls inside.
  import { App, applyHostFonts, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
  import { onDestroy, type Component } from "svelte";
  import { AnyfieldClient } from "../lib/client/anyfield";
  import { McpAppTransport } from "../lib/client/mcp-app";
  import ToolFrame from "../lib/components/ToolFrame.svelte";
  import { LocalSelection } from "../lib/state/local.svelte";
  import type { Selection } from "../lib/state/selection";
  import { SessionStore } from "../lib/state/session.svelte";
  import { setDark } from "../lib/theme.svelte";
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
    /** Gets the Selection and the tool call's other arguments as props (its options). */
    tool: Component<{ sel: Selection } & Record<string, unknown>>;
    /** What goes back to the chat without a session; none: the tool needs no footer
     * (e.g. the file tools, which talk to the chat themselves). */
    summary?: (state: State) => string;
  } = $props();

  // svelte-ignore state_referenced_locally
  const app = new App({ name, version: "0.1.0" });
  const client = new AnyfieldClient(new McpAppTransport(app));
  let sel = $state<Selection | null>(null);
  /** The tool call's arguments but the session key: options of the tool (e.g. mode). */
  let options = $state<Record<string, unknown>>({});
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
      if (!summary) return;
      app.updateModelContext({ content: [{ type: "text", text: summary(state) }] }).catch(() => {});
    });
  }

  async function sendToChat() {
    if (!sel?.state || !summary) return;
    const r = await app.sendMessage({ role: "user", content: [{ type: "text", text: summary(sel.state) }] });
    sent = !r.isError;
  }

  // Register before connect(): the host may send these right after the handshake.
  // Without a session the local selection starts from the tool result's state (e.g.
  // the phantom the preview was opened for), so it opens only once that arrives.
  app.ontoolinput = (params) => {
    const { session_key: _, ...rest } = params.arguments ?? {};
    options = rest;
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
  // Blend into the chat: its light/dark and, where it sends them, its colours and fonts
  // (app.css maps them onto our tokens; the background stays transparent). Until the
  // host says, the system's light/dark.
  setDark(matchMedia("(prefers-color-scheme: dark)").matches);
  function applyHost(ctx: Partial<McpUiHostContext> | undefined) {
    if (!ctx) return;
    if (ctx.theme) setDark(ctx.theme === "dark");
    if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
    if (ctx.containerDimensions) container = ctx.containerDimensions;
  }
  app.onhostcontextchanged = applyHost;
  app.connect().then(
    () => applyHost(app.getHostContext()),
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
      <div class="min-h-0 min-w-0 flex-1 overflow-y-auto"><Tool {sel} {...options} /></div>
      {#if !sel.sessionKey && summary}
        <footer class="flex items-center gap-2 border-t border-border bg-panel px-3 py-2 text-xs">
          <span class="min-w-0 flex-1 truncate text-muted" title={sel.state ? summary(sel.state) : ""}>
            {sel.state ? summary(sel.state) : ""}
          </span>
          <button class="btn btn-sm preset-filled-primary-500 shrink-0" onclick={sendToChat}>
            {sent ? "Gesendet" : "In den Chat"}
          </button>
        </footer>
      {/if}
    {:else}
      <p class="p-4 text-sm text-muted">{error ?? "Warte auf Tool-Aufruf …"}</p>
    {/if}
  </ToolFrame>
</div>
