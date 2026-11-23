<script lang="ts">
  // The user's files as a table: download, name (click: name and hash to the chat),
  // type, size, uploaded. Every column sorts (click its header), a search field filters
  // by name and type. Narrow, the table scrolls sideways. With a session, a .zip can be
  // chosen as the session's phantom.
  // Bump `reload` to load the list again (e.g. after an upload). Opened again, the list
  // this client loaded last shows at once while the server's (cached a few minutes)
  // comes in.
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import Brain from "@lucide/svelte/icons/brain";
  import Download from "@lucide/svelte/icons/download";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import { filterFiles, formatSize, formatTime, sortFiles, type SortKey } from "../../files";
  import { phantomPatch } from "../../phantom";
  import type { Selection } from "../../state/selection";
  import type { UserFile } from "../../types";
  import FileName from "./FileName.svelte";

  let { sel, reload = 0 }: { sel: Selection; reload?: number } = $props();

  const COLUMNS: { key: SortKey; label: string }[] = [
    { key: "name", label: "Name" },
    { key: "type", label: "Typ" },
    { key: "size", label: "Größe" },
    { key: "uploaded_at", label: "Hochgeladen" },
  ];

  // svelte-ignore state_referenced_locally
  let files = $state<UserFile[] | null>(sel.client.lastFiles);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let query = $state("");
  let sortKey = $state<SortKey>("uploaded_at");
  let ascending = $state(false);

  const shown = $derived(files ? sortFiles(filterFiles(files, query), sortKey, ascending) : []);
  const chat = $derived(!!sel.client.transport.openLink);
  const phantomSha = $derived(sel.state?.phantom && "sha256" in sel.state.phantom ? sel.state.phantom.sha256 : null);

  async function load(refresh = false) {
    loading = true;
    error = null;
    try {
      files = await sel.client.listUserFiles(refresh);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  // First the server's list (cached there), after an upload the gateway's
  $effect(() => {
    void load(reload > 0);
  });

  function sortBy(key: SortKey) {
    if (sortKey === key) ascending = !ascending;
    else {
      sortKey = key;
      // Names A→Z, everything else largest/newest first
      ascending = key === "name" || key === "type";
    }
  }

  async function download(f: UserFile) {
    try {
      await sel.client.transport.openLink?.(f.url);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  const isZip = (f: UserFile) => f.name.toLowerCase().endsWith(".zip") || (f.type ?? "").includes("zip");
</script>

<!-- min-w-0 down to the table-wrap: flex items are otherwise as wide as the table,
     and nothing scrolls -->
<div class="flex min-h-0 min-w-0 flex-col gap-2 text-sm text-text">
  <div class="flex items-center gap-2">
    <input class="input min-w-0 flex-1 text-xs" type="search" placeholder="Suchen (Name, Typ)" bind:value={query} />
    <button
      type="button"
      class="btn-icon btn-icon-sm hover:preset-tonal shrink-0"
      aria-label="Liste neu laden"
      title="Liste neu laden"
      onclick={() => load(true)}
      disabled={loading}
    >
      <RefreshCw class="size-4 {loading ? 'animate-spin' : ''}" aria-hidden="true" />
    </button>
  </div>

  {#if error}<p class="text-xs text-error-500">{error}</p>{/if}

  {#if files && !files.length}
    <p class="p-2 text-xs text-muted">Noch keine Dateien.</p>
  {:else if files}
    <!-- Skeleton's table; table-wrap scrolls it sideways when it is too wide -->
    <div class="table-wrap min-h-0 min-w-0">
      <table class="table text-xs">
        <thead>
          <tr>
            <th class="w-0 p-1"><span class="sr-only">Download</span></th>
            {#each COLUMNS as c (c.key)}
              <th class="p-1 whitespace-nowrap">
                <button type="button" class="inline-flex items-center gap-0.5 hover:text-text" onclick={() => sortBy(c.key)}>
                  {c.label}
                  {#if sortKey === c.key}
                    {#if ascending}<ArrowUp class="size-3" aria-label="aufsteigend" />{:else}<ArrowDown class="size-3" aria-label="absteigend" />{/if}
                  {/if}
                </button>
              </th>
            {/each}
            {#if sel.sessionKey}<th class="w-0 p-1"><span class="sr-only">Als Phantom</span></th>{/if}
          </tr>
        </thead>
        <tbody>
          {#each shown as f (f.sha256)}
            <tr class="hover:preset-tonal">
              <td class="p-1">
                {#if chat}
                  <button type="button" class="btn-icon btn-icon-sm hover:preset-tonal" aria-label="{f.name} herunterladen" title="Herunterladen" onclick={() => download(f)}>
                    <Download class="size-4" aria-hidden="true" />
                  </button>
                {:else}
                  <a class="btn-icon btn-icon-sm hover:preset-tonal" href={f.url} download={f.name} aria-label="{f.name} herunterladen" title="Herunterladen">
                    <Download class="size-4" aria-hidden="true" />
                  </a>
                {/if}
              </td>
              <td class="max-w-64 p-1"><FileName client={sel.client} name={f.name} sha256={f.sha256} /></td>
              <td class="p-1 whitespace-nowrap text-muted">{f.type ?? "–"}</td>
              <td class="p-1 text-right whitespace-nowrap">{formatSize(f.size)}</td>
              <td class="p-1 whitespace-nowrap">{formatTime(f.uploaded_at)}</td>
              {#if sel.sessionKey}
                <td class="p-1">
                  {#if isZip(f)}
                    <button
                      type="button"
                      class="btn-icon btn-icon-sm {phantomSha === f.sha256 ? 'preset-filled-primary-500' : 'hover:preset-tonal'}"
                      aria-label="{f.name} als Phantom der Session wählen"
                      title={phantomSha === f.sha256 ? "Phantom der Session" : "Als Phantom der Session wählen"}
                      onclick={() => sel.patch({ phantom: phantomPatch({ sha256: f.sha256, name: f.name }), tissues: null })}
                    >
                      <Brain class="size-4" aria-hidden="true" />
                    </button>
                  {/if}
                </td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if query && !shown.length}<p class="p-2 text-xs text-muted">Keine Datei passt zur Suche.</p>{/if}
  {:else if loading}
    <p class="p-2 text-xs text-muted">Lade Dateien …</p>
  {/if}
</div>
