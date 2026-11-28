<script lang="ts">
  // Standalone web app: `/` lists your projects with their sessions (login), `/s/{key}`
  // opens a session.
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
  import Dialogs from "../lib/components/Dialogs.svelte";
  import Toaster from "../lib/components/Toaster.svelte";
  import { askConfirm, askText } from "../lib/dialog.svelte";
  import { toaster } from "../lib/toast";
  import { SessionStore } from "../lib/state/session.svelte";
  import type { ProjectSummary } from "../lib/types";
  import { formatDateTime, i18n } from "../lib/i18n.svelte";
  import { m } from "../paraglide/messages.js";

  const transport = new McpHttpTransport();
  const client = new AnyfieldClient(transport);

  let path = $state(location.pathname);
  let projects = $state<ProjectSummary[] | null>(null);
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
    // The history tool switches to another session of the project: open its page
    s.navigate = (key) => go(`/s/${key}`);
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

  // A project without sessions gets one from the server (`default`)
  const loadProjects = () => run(async () => {
    projects = await client.listProjects();
    loggedIn = transport.loggedIn;
  });

  async function create() {
    const s = await run(() => client.createProject(`${m.app_new_project()} ${formatDateTime(new Date())}`));
    if (s) go(`/s/${s.key}`);
  }

  async function rename(p: ProjectSummary) {
    const name = await askText({ title: m.app_rename_project(), input: p.name, placeholder: m.app_new_name(), confirm: m.app_rename() });
    if (name) await run(() => client.renameProject(p.id, name).then(loadProjects));
  }

  async function remove(p: ProjectSummary) {
    const ok = await askConfirm({
      title: m.app_delete_project(),
      message: m.app_confirm_delete_project({ name: p.name }),
      confirm: m.app_delete(),
      danger: true,
    });
    if (ok) await run(() => client.deleteProject(p.id).then(loadProjects));
  }

  function logout() {
    transport.logout();
    loggedIn = false;
    projects = null;
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
      if (loggedIn && !sessionKey) await loadProjects();
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
      <span class="truncate">{store.server?.project.name ?? "…"}</span>
      <span class="text-muted">/</span>
      {#if store.server}<span class="size-2.5 shrink-0 rounded-full" style="background: {store.server.color}" aria-hidden="true"></span>{/if}
      <span class="truncate">{store.server?.name ?? "…"}</span>
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
      <Dialog.Backdrop class="fixed inset-0 z-50 bg-white/50 dark:bg-black/50" />
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
    <!-- The state editor (MCP tool open_state) as a modal; opened fresh each time -->
    <Dialog open={showState} onOpenChange={(e) => (showState = e.open)}>
      <Portal>
        <Dialog.Backdrop class="fixed inset-0 z-50 bg-white/50 dark:bg-black/50" />
        <Dialog.Positioner class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Content class="card flex h-[80vh] w-full max-w-2xl flex-col gap-2 border border-border bg-bg p-3 shadow-xl">
            <header class="flex items-center">
              <Dialog.Title class="text-sm font-semibold">{m.app_session_state()}</Dialog.Title>
              <Dialog.CloseTrigger class="btn-icon btn-icon-sm hover:preset-tonal ml-auto" aria-label={m.common_close()}>
                <X class="size-4" aria-hidden="true" />
              </Dialog.CloseTrigger>
            </header>
            {#if showState}
              <ToolFrame name="state" class="min-h-0 flex-1"><SessionEditor sel={store} /></ToolFrame>
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
          <h2 class="text-sm font-semibold uppercase tracking-wide text-muted">{m.app_my_projects()}</h2>
          {#if loggedIn}<button class="btn btn-sm hover:preset-tonal ml-auto text-xs" onclick={logout}>{m.app_logout()}</button>{/if}
        </div>
        {#if projects === null}
          <button class="btn preset-outlined-surface-300-700 self-start" onclick={loadProjects}>
            {m.app_login()}
          </button>
        {:else}
          <!-- Each project with its sessions (newest first) -->
          <ul class="flex flex-col gap-2">
            {#each projects as p (p.id)}
              <li class="card flex flex-col gap-1 border border-border p-2">
                <div class="flex items-center gap-2">
                  <span class="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                  <span class="text-xs text-muted">{formatDateTime(new Date(p.updated_at * 1000))}</span>
                  <button class="btn btn-sm hover:preset-tonal text-xs" onclick={() => rename(p)}>{m.app_rename()}</button>
                  <button class="btn btn-sm hover:preset-tonal-error text-xs" onclick={() => remove(p)}>{m.app_delete()}</button>
                </div>
                <ul class="flex flex-col">
                  {#each p.sessions as s (s.key)}
                    <li>
                      <a
                        class="flex items-center gap-2 rounded px-2 py-1 text-sm hover:preset-tonal"
                        href="/s/{s.key}"
                        onclick={(e) => { e.preventDefault(); go(`/s/${s.key}`); }}
                      >
                        <span class="size-2.5 shrink-0 rounded-full" style="background: {s.color}" aria-hidden="true"></span>
                        <span class="min-w-0 flex-1 truncate">{s.name}</span>
                        <span class="text-xs text-muted">{formatDateTime(new Date(s.updated_at * 1000))}</span>
                      </a>
                    </li>
                  {/each}
                </ul>
              </li>
            {:else}
              <li class="text-muted">{m.app_no_projects()}</li>
            {/each}
          </ul>
          <button class="btn preset-filled-primary-500 self-start" onclick={create}>{m.app_new_project()}</button>
        {/if}
      </section>

      {#if error}<p class="text-sm text-red-400">{error}</p>{/if}
    </main>
  {/if}
</div>
{/key}
<Toaster />
<Dialogs />
