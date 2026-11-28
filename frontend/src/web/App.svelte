<script lang="ts">
  // Standalone web app: `/` lists your sessions (login), `/s/{key}` opens one.
  import X from "@lucide/svelte/icons/x";
  import { Dialog, Portal } from "@skeletonlabs/skeleton-svelte";
  import { onMount } from "svelte";
  import { AnyfieldClient } from "../lib/client/anyfield";
  import { LoginRedirect, McpHttpTransport } from "../lib/client/mcp-http";
  import SessionEditor from "../lib/components/session/SessionEditor.svelte";
  import FileManager from "../lib/components/files/FileManager.svelte";
  import Workspace from "../lib/components/workspace/Workspace.svelte";
  import { LocalSelection } from "../lib/state/local.svelte";
  import ToolFrame from "../lib/components/ToolFrame.svelte";
  import Toaster from "../lib/components/Toaster.svelte";
  import { toaster } from "../lib/toast";
  import { SessionStore } from "../lib/state/session.svelte";
  import type { SessionSummary } from "../lib/types";
  import { formatDateTime, i18n } from "../lib/i18n.svelte";
  import { m } from "../paraglide/messages.js";

  const transport = new McpHttpTransport();
  const client = new AnyfieldClient(transport);

  let path = $state(location.pathname);
  let sessions = $state<SessionSummary[] | null>(null);
  let error = $state<string | null>(null);
  let keyInput = $state("");
  let loggedIn = $state(transport.loggedIn);
  let showState = $state(false);
  let showFiles = $state(false);

  const sessionKey = $derived(path.match(/^\/s\/([^/]+)/)?.[1] ?? null);
  let store = $state<SessionStore | null>(null);
  // The file manager needs a Selection: the session's (a .zip can become its
  // phantom), else a local one
  const filesSel = $derived(store ?? new LocalSelection(client));

  $effect(() => {
    if (!sessionKey) return;
    const s = new SessionStore(client, sessionKey);
    store = s;
    s.start();
    return () => s.stop();
  });

  function go(to: string) {
    history.pushState(null, "", to);
    path = to;
  }

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    error = null;
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof LoginRedirect)) error = e instanceof Error ? e.message : String(e);
    }
  }

  const loadSessions = () => run(async () => {
    sessions = await client.listSessions();
    loggedIn = transport.loggedIn;
  });

  async function create() {
    const s = await run(() => client.createSession(`Session ${formatDateTime(new Date())}`));
    if (s) go(`/s/${s.key}`);
  }

  async function rename(s: SessionSummary) {
    const name = prompt(m.app_new_name(), s.name);
    if (name) await run(() => client.renameSession(s.key, name).then(loadSessions));
  }

  async function remove(s: SessionSummary) {
    if (confirm(m.app_confirm_delete({ name: s.name }))) await run(() => client.deleteSession(s.key).then(loadSessions));
  }

  function logout() {
    transport.logout();
    loggedIn = false;
    sessions = null;
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(location.href);
      toaster.success({ title: m.app_link_copied(), description: location.href });
    } catch (e) {
      toaster.error({ title: m.common_not_copied(), description: e instanceof Error ? e.message : String(e) });
    }
  }

  onMount(() => {
    const onPop = () => (path = location.pathname);
    addEventListener("popstate", onPop);
    void run(async () => {
      await transport.completeLogin();
      path = location.pathname;
      loggedIn = transport.loggedIn;
      if (loggedIn && !sessionKey) await loadSessions();
    });
    return () => removeEventListener("popstate", onPop);
  });
</script>

<!-- Messages read the locale when called: a new language renders everything anew -->
{#key i18n.locale}
<div class="flex h-full flex-col">
  <header class="flex items-center gap-3 border-b border-border bg-panel px-4 py-2 text-sm">
    <button class="btn btn-sm px-1 font-semibold hover:preset-tonal" onclick={() => go("/")}>anyfield</button>
    {#if store && sessionKey}
      <span class="text-muted">/</span>
      <span>{store.server?.name ?? "…"}</span>
      <button class="btn btn-sm hover:preset-tonal ml-auto" onclick={() => (showState = true)} aria-haspopup="dialog">
        {m.app_state_json()}
      </button>
    {/if}
    <button class="btn btn-sm hover:preset-tonal {store && sessionKey ? '' : 'ml-auto'}" onclick={() => (showFiles = true)} aria-haspopup="dialog">
      {m.app_files()}
    </button>
    {#if store && sessionKey}
      <button class="btn btn-sm preset-outlined-surface-300-700" onclick={copyLink}>
        {m.app_copy_link()}
      </button>
    {/if}
  </header>

  <!-- The file manager (MCP tool open_file_manager) as a modal: the user's files -->
  <Dialog open={showFiles} onOpenChange={(e) => (showFiles = e.open)}>
    <Portal>
      <Dialog.Backdrop class="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm" />
      <Dialog.Positioner class="fixed inset-0 z-50 flex items-center justify-center p-4">
        <Dialog.Content class="card flex max-h-[85vh] w-full max-w-3xl flex-col gap-2 overflow-hidden border border-border bg-bg p-3 shadow-xl">
          <header class="flex items-center">
            <Dialog.Title class="text-sm font-semibold">{m.app_files()}</Dialog.Title>
            <Dialog.CloseTrigger class="btn-icon btn-icon-sm hover:preset-tonal ml-auto" aria-label={m.common_close()}>
              <X class="size-4" aria-hidden="true" />
            </Dialog.CloseTrigger>
          </header>
          {#if showFiles}
            <!-- As tall as its content (the list scrolls itself); scrolls only if the
                 window is lower than that. Not flex-1: from a height of 0 it stays 0 -->
            <div class="min-h-0 overflow-auto">
              <ToolFrame name="file_manager"><FileManager sel={filesSel} /></ToolFrame>
            </div>
          {/if}
        </Dialog.Content>
      </Dialog.Positioner>
    </Portal>
  </Dialog>

  {#if sessionKey && store}
    <!-- The session editor (MCP tool open_session) as a modal; opened fresh each time -->
    <Dialog open={showState} onOpenChange={(e) => (showState = e.open)}>
      <Portal>
        <Dialog.Backdrop class="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm" />
        <Dialog.Positioner class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Content class="card flex h-[80vh] w-full max-w-2xl flex-col gap-2 border border-border bg-bg p-3 shadow-xl">
            <header class="flex items-center">
              <Dialog.Title class="text-sm font-semibold">{m.app_session_state()}</Dialog.Title>
              <Dialog.CloseTrigger class="btn-icon btn-icon-sm hover:preset-tonal ml-auto" aria-label={m.common_close()}>
                <X class="size-4" aria-hidden="true" />
              </Dialog.CloseTrigger>
            </header>
            {#if showState}
              <ToolFrame name="session" class="min-h-0 flex-1"><SessionEditor sel={store} /></ToolFrame>
            {/if}
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog>
    <!-- The workspace: the session's tools in panels, arranged as its `layout` says -->
    <main class="min-h-0 flex-1 p-1">
      <ToolFrame name="workspace" class="h-full">
        {#key store}<Workspace sel={store} />{/key}
      </ToolFrame>
    </main>
  {:else}
    <main class="mx-auto flex w-full max-w-xl flex-col gap-6 p-6">
      <section class="flex flex-col gap-2">
        <h2 class="text-sm font-semibold uppercase tracking-wide text-muted">{m.app_open_session()}</h2>
        <form class="flex gap-2" onsubmit={(e) => { e.preventDefault(); if (keyInput.trim()) go(`/s/${keyInput.trim()}`); }}>
          <input bind:value={keyInput} placeholder={m.app_session_key()} class="input flex-1" />
          <button class="btn preset-filled-primary-500">{m.app_open()}</button>
        </form>
      </section>

      <section class="flex flex-col gap-2">
        <div class="flex items-center">
          <h2 class="text-sm font-semibold uppercase tracking-wide text-muted">{m.app_my_sessions()}</h2>
          {#if loggedIn}<button class="btn btn-sm hover:preset-tonal ml-auto text-xs" onclick={logout}>{m.app_logout()}</button>{/if}
        </div>
        {#if sessions === null}
          <button class="btn preset-outlined-surface-300-700 self-start" onclick={loadSessions}>
            {m.app_login()}
          </button>
        {:else}
          <ul class="flex flex-col divide-y divide-border rounded border border-border">
            {#each sessions as s (s.key)}
              <li class="flex items-center gap-2 px-3 py-2">
                <a class="flex-1 hover:text-accent" href="/s/{s.key}" onclick={(e) => { e.preventDefault(); go(`/s/${s.key}`); }}>{s.name}</a>
                <span class="text-xs text-muted">{formatDateTime(new Date(s.updated_at * 1000))}</span>
                <button class="btn btn-sm hover:preset-tonal text-xs" onclick={() => rename(s)}>{m.app_rename()}</button>
                <button class="btn btn-sm hover:preset-tonal-error text-xs" onclick={() => remove(s)}>{m.app_delete()}</button>
              </li>
            {:else}
              <li class="px-3 py-2 text-muted">{m.app_no_sessions()}</li>
            {/each}
          </ul>
          <button class="btn preset-filled-primary-500 self-start" onclick={create}>{m.app_new_session()}</button>
        {/if}
      </section>

      {#if error}<p class="text-sm text-red-400">{error}</p>{/if}
    </main>
  {/if}
</div>
{/key}
<Toaster />
