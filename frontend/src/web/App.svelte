<script lang="ts">
  // Standalone web app: `/` lists your sessions (login), `/s/{key}` opens one.
  import { onMount } from "svelte";
  import { AnyfieldClient } from "../lib/client/anyfield";
  import { LoginRedirect, McpHttpTransport } from "../lib/client/mcp-http";
  import FovPlanner from "../lib/components/fov/FovPlanner.svelte";
  import PhantomBrowser from "../lib/components/phantom/PhantomBrowser.svelte";
  import ToolFrame from "../lib/components/ToolFrame.svelte";
  import { SessionStore } from "../lib/state/session.svelte";
  import type { SessionSummary } from "../lib/types";

  const transport = new McpHttpTransport();
  const client = new AnyfieldClient(transport);

  let path = $state(location.pathname);
  let sessions = $state<SessionSummary[] | null>(null);
  let error = $state<string | null>(null);
  let keyInput = $state("");
  let loggedIn = $state(transport.loggedIn);
  let copied = $state(false);
  let showState = $state(false);

  const sessionKey = $derived(path.match(/^\/s\/([^/]+)/)?.[1] ?? null);
  let store = $state<SessionStore | null>(null);

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
    const s = await run(() => client.createSession(`Session ${new Date().toLocaleString("de-DE")}`));
    if (s) go(`/s/${s.key}`);
  }

  async function rename(s: SessionSummary) {
    const name = prompt("Neuer Name", s.name);
    if (name) await run(() => client.renameSession(s.key, name).then(loadSessions));
  }

  async function remove(s: SessionSummary) {
    if (confirm(`Session „${s.name}“ löschen?`)) await run(() => client.deleteSession(s.key).then(loadSessions));
  }

  function logout() {
    transport.logout();
    loggedIn = false;
    sessions = null;
  }

  async function copyLink() {
    await navigator.clipboard.writeText(location.href);
    copied = true;
    setTimeout(() => (copied = false), 1500);
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

<div class="flex h-full flex-col">
  <header class="flex items-center gap-3 border-b border-border bg-panel px-4 py-2 text-sm">
    <button class="font-semibold" onclick={() => go("/")}>anyfield</button>
    {#if store && sessionKey}
      <span class="text-muted">/</span>
      <span>{store.server?.name ?? "…"}</span>
      <button class="ml-auto text-muted hover:text-text" onclick={() => (showState = !showState)} aria-expanded={showState}>
        Zustand (JSON)
      </button>
      <button class="rounded border border-border px-2 py-0.5 hover:bg-bg" onclick={copyLink}>
        {copied ? "Kopiert" : "Link kopieren"}
      </button>
    {/if}
  </header>

  {#if sessionKey && store}
    <!-- Two independent tools on the same session, side by side -->
    <main class="flex min-h-0 flex-1 flex-col lg:flex-row">
      <section class="max-h-[45vh] shrink-0 p-1 lg:max-h-none lg:w-80" aria-label="Phantom">
        <ToolFrame name="phantom_browser" class="h-full"><PhantomBrowser sel={store} /></ToolFrame>
      </section>
      <section class="min-h-0 flex-1 p-1" aria-label="FOV-Planung">
        <ToolFrame name="fov_planner" class="h-full"><FovPlanner sel={store} /></ToolFrame>
      </section>
      {#if showState}
        <section class="max-h-[40vh] shrink-0 overflow-auto border-t border-border bg-panel p-3 lg:max-h-none lg:w-80 lg:border-l lg:border-t-0" aria-label="Zustand">
          <p class="mb-2 text-xs text-muted">Session-Zustand, rev {store.server?.rev ?? "–"}{store.pending ? " (Änderung wird gespeichert …)" : ""}</p>
          <pre class="whitespace-pre-wrap break-all font-mono text-xs">{JSON.stringify(store.state, null, 2)}</pre>
        </section>
      {/if}
    </main>
  {:else}
    <main class="mx-auto flex w-full max-w-xl flex-col gap-6 p-6">
      <section class="flex flex-col gap-2">
        <h2 class="text-sm font-semibold uppercase tracking-wide text-muted">Session öffnen</h2>
        <form class="flex gap-2" onsubmit={(e) => { e.preventDefault(); if (keyInput.trim()) go(`/s/${keyInput.trim()}`); }}>
          <input bind:value={keyInput} placeholder="Session-Key" class="flex-1 rounded border border-border bg-bg px-2 py-1" />
          <button class="rounded bg-accent px-3 py-1 font-medium text-black">Öffnen</button>
        </form>
      </section>

      <section class="flex flex-col gap-2">
        <div class="flex items-center">
          <h2 class="text-sm font-semibold uppercase tracking-wide text-muted">Meine Sessions</h2>
          {#if loggedIn}<button class="ml-auto text-xs text-muted hover:text-text" onclick={logout}>Abmelden</button>{/if}
        </div>
        {#if sessions === null}
          <button class="self-start rounded border border-border px-3 py-1 hover:bg-panel" onclick={loadSessions}>
            Anmelden
          </button>
        {:else}
          <ul class="flex flex-col divide-y divide-border rounded border border-border">
            {#each sessions as s (s.key)}
              <li class="flex items-center gap-2 px-3 py-2">
                <a class="flex-1 hover:text-accent" href="/s/{s.key}" onclick={(e) => { e.preventDefault(); go(`/s/${s.key}`); }}>{s.name}</a>
                <span class="text-xs text-muted">{new Date(s.updated_at * 1000).toLocaleString("de-DE")}</span>
                <button class="text-xs text-muted hover:text-text" onclick={() => rename(s)}>Umbenennen</button>
                <button class="text-xs text-muted hover:text-red-400" onclick={() => remove(s)}>Löschen</button>
              </li>
            {:else}
              <li class="px-3 py-2 text-muted">Noch keine Sessions.</li>
            {/each}
          </ul>
          <button class="self-start rounded bg-accent px-3 py-1 font-medium text-black" onclick={create}>Neue Session</button>
        {/if}
      </section>

      {#if error}<p class="text-sm text-red-400">{error}</p>{/if}
    </main>
  {/if}
</div>
