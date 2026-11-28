<script lang="ts">
  // Shell of every anyfield MCP App: connects to the host and binds `tool` to a
  // Selection. With a `session_key` in the tool call: the session (shared with
  // the website and the AI). Without: a local selection; every change updates
  // the chat's model context, and "In den Chat" sends the choice as a message.
  // The app is as tall as its content: the SDK reports that height to the host
  // (`ui/notifications/size-changed`, autoResize). Only a height or maxHeight the
  // host gives (`containerDimensions`) limits it; then the content scrolls inside.
  // Language, colour theme, light/dark, chat colours: the user's settings
  // (get_user_settings), else the chat's language and light/dark, the browser's, English.
  import { App, applyHostFonts, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
  import { onDestroy, type Component } from "svelte";
  import { AnyfieldClient } from "../lib/client/anyfield";
  import { McpAppTransport } from "../lib/client/mcp-app";
  import ToolFrame from "../lib/components/ToolFrame.svelte";
  import Dialogs from "../lib/components/Dialogs.svelte";
  import Toaster from "../lib/components/Toaster.svelte";
  import { LocalSelection } from "../lib/state/local.svelte";
  import type { Selection } from "../lib/state/selection";
  import { SessionStore } from "../lib/state/session.svelte";
  import type { Session, State } from "../lib/types";
  import { i18n } from "../lib/i18n.svelte";
  import { applyPrefs, chatTheme, loadPrefs, prefs } from "../lib/settings.svelte";
  import { m } from "../paraglide/messages.js";

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
  // Everything towards the chat goes through the transport, as in the components
  // svelte-ignore state_referenced_locally
  const transport = new McpAppTransport(app, name);
  const client = new AnyfieldClient(transport);
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

  applyPrefs();

  function openSession(key: string) {
    if (sel?.sessionKey === key) return;
    if (sel instanceof SessionStore) sel.stop();
    const store = new SessionStore(client, key);
    // The history tool switches sessions: in the chat, this app shows the other one
    store.navigate = openSession;
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
      transport.setChatContext(summary(state)).catch(() => {});
    });
  }

  async function sendToChat() {
    if (!sel?.state || !summary) return;
    try {
      await transport.sendToChat(summary(sel.state));
      sent = true;
    } catch {
      sent = false;
    }
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
      error = result.content?.map((c) => ("text" in c ? c.text : "")).join("\n") || "Error";
    } else if (r?.key) {
      openSession(r.key);
      if (sel instanceof SessionStore) sel.accept(r as Session);
    } else {
      openLocal(r?.state);
    }
  };
  // The chat's language and light/dark (used where the user's settings leave them open)
  // and, where it sends them, its colours and fonts (with the setting "chat colours").
  function applyHost(ctx: Partial<McpUiHostContext> | undefined) {
    if (!ctx) return;
    if (ctx.locale !== undefined || ctx.theme !== undefined) {
      prefs.host = {
        locale: ctx.locale ?? prefs.host.locale,
        dark: ctx.theme ? ctx.theme === "dark" : prefs.host.dark,
      };
      applyPrefs();
    }
    // The chat's colours: only used with the setting "chat colours" (app.css, chat-theme)
    if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    if (ctx.styles?.css?.fonts && chatTheme()) applyHostFonts(ctx.styles.css.fonts);
    if (ctx.containerDimensions) container = ctx.containerDimensions;
  }
  app.onhostcontextchanged = applyHost;
  app.connect().then(
    () => {
      applyHost(app.getHostContext());
      void loadPrefs(client, false);
    },
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
      <!-- Messages read the locale when called: a new language renders the tool anew -->
      {#key i18n.locale}<div class="min-h-0 min-w-0 flex-1 overflow-y-auto"><Tool {sel} {...options} /></div>{/key}
      {#if !sel.sessionKey && summary}
        <footer class="flex items-center gap-2 border-t border-border bg-panel px-3 py-2 text-xs">
          <span class="min-w-0 flex-1 truncate text-muted" title={sel.state ? summary(sel.state) : ""}>
            {sel.state ? summary(sel.state) : ""}
          </span>
          <button class="btn btn-sm preset-filled-primary-500 shrink-0" onclick={sendToChat}>
            {sent ? m.mcp_sent() : m.mcp_send()}
          </button>
        </footer>
      {/if}
    {:else}
      <p class="p-4 text-sm text-muted">{error ?? m.mcp_waiting()}</p>
    {/if}
  </ToolFrame>
</div>
<Toaster />
<Dialogs grow />
