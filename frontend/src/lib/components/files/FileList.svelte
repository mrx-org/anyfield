<script lang="ts">
  // The user's files as a table: download, name, type, size, uploaded. Every column
  // sorts (click its header), a search field filters by name and type, a dropdown next
  // to it shows all files or only the bifti phantoms. Narrow, the table scrolls sideways.
  // Options (MCP tool open_file_list, or set by a parent): `mode` fixes the dropdown
  // (bifti: no type column), `download` the download buttons.
  // Clicking a name: `"name": <sha256>` to the chat (website: copied, with a notice);
  // with a session in bifti mode instead the file becomes the session's phantom (its
  // button filled). `select` (the phantom browser) picks the phantom also into a local
  // selection.
  // Bump `reload` to load the list again (e.g. after an upload). Opened again, the list
  // this client loaded last shows at once while the server's (cached a few minutes)
  // comes in.
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import Download from "@lucide/svelte/icons/download";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import { FILE_MODES, filterFiles, formatSize, formatTime, sortFiles, type FileMode, type SortKey } from "../../files";
  import { isCas, phantomPatch } from "../../phantom";
  import type { Selection } from "../../state/selection";
  import type { UserFile } from "../../types";
  import FileName from "./FileName.svelte";

  let {
    sel,
    reload = 0,
    mode: fixedMode,
    download: showDownload = true,
    select,
  }: {
    sel: Selection;
    reload?: number;
    /** Fixed: the dropdown is disabled (bifti: no type column). */
    mode?: FileMode | null;
    /** Show the download buttons. */
    download?: boolean;
    /** A click in bifti mode picks the phantom, also without a session (default: with one). */
    select?: boolean;
  } = $props();

  const ALL_COLUMNS: { key: SortKey; label: string }[] = [
    { key: "name", label: "Name" },
    { key: "type", label: "Typ" },
    { key: "size", label: "Größe" },
    { key: "uploaded_at", label: "Hochgeladen" },
  ];
  const columns = $derived(fixedMode === "bifti" ? ALL_COLUMNS.filter((c) => c.key !== "type") : ALL_COLUMNS);

  let files = $state<UserFile[] | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let query = $state("");
  let chosenMode = $state<FileMode>("all");
  const mode = $derived(fixedMode ?? chosenMode);
  /** What a click on a name does. */
  const click = $derived(mode === "bifti" && (select ?? !!sel.sessionKey) ? "phantom" : "chat");
  const phantomSha = $derived(sel.state?.phantom && isCas(sel.state.phantom) ? sel.state.phantom.sha256 : null);

  function pick(f: UserFile) {
    if (f.sha256 === phantomSha) return;
    // Another phantom has other tissues: back to all of them
    sel.patch({ phantom: phantomPatch({ sha256: f.sha256, name: f.name }), tissues: null });
  }
  let sortKey = $state<SortKey>("uploaded_at");
  let ascending = $state(false);

  const shown = $derived(sortFiles(filterFiles(files ?? [], query), sortKey, ascending));
  const chat = $derived(!!sel.client.transport.openLink);

  // The list of the mode (filtered by the server, list_user_files)
  async function load(refresh = false) {
    const m = mode;
    loading = true;
    error = null;
    try {
      const listed = await sel.client.listUserFiles(m, refresh);
      if (m === mode) files = listed;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  // On a new mode: the list loaded last for it at once, then the server's (cached
  // there); after an upload the gateway's
  $effect(() => {
    files = sel.client.lastFiles.get(mode) ?? null;
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

</script>

<!-- min-w-0 down to the table-wrap: flex items are otherwise as wide as the table,
     and nothing scrolls -->
<div class="flex min-h-0 min-w-0 flex-col gap-2 text-sm text-text">
  <div class="flex items-center gap-2">
    <input class="input min-w-0 flex-1 text-xs" type="search" placeholder="Suchen (Name, Typ)" bind:value={query} />
    <select
      class="select w-auto shrink-0 text-xs"
      aria-label="Modus"
      value={mode}
      disabled={!!fixedMode}
      onchange={(e) => (chosenMode = e.currentTarget.value as FileMode)}
    >
      {#each FILE_MODES as m (m.key)}<option value={m.key}>{m.label}</option>{/each}
    </select>
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
    <!-- Skeleton's table; table-wrap scrolls it, sideways when it is too wide and down
         past a fixed height (rem, not vh: an MCP App's iframe grows with its content,
         so vh would grow with it and the list would get endless again) -->
    <div class="table-wrap max-h-[28rem] min-h-0 min-w-0">
      <table class="table text-xs">
        <thead>
          <tr>
            {#if showDownload}<th class="sticky top-0 z-10 w-0 bg-bg px-2 py-1 text-left"><span class="sr-only">Download</span></th>{/if}
            {#each columns as c (c.key)}
              <th class="sticky top-0 z-10 bg-bg px-2 py-1 text-left whitespace-nowrap">
                <button type="button" class="inline-flex items-center gap-0.5 hover:text-text" onclick={() => sortBy(c.key)}>
                  {c.label}
                  {#if sortKey === c.key}
                    {#if ascending}<ArrowUp class="size-3" aria-label="aufsteigend" />{:else}<ArrowDown class="size-3" aria-label="absteigend" />{/if}
                  {/if}
                </button>
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each shown as f (f.sha256)}
            <tr>
              {#if showDownload}
                            <td class="px-2 py-1">
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
              {/if}
              <td class="max-w-64 px-2 py-1">
                {#if click === "phantom"}
                  <button
                    type="button"
                    class="btn btn-sm max-w-full justify-start {f.sha256 === phantomSha ? 'preset-filled-primary-500' : 'preset-tonal'}"
                    title="Als Phantom wählen"
                    aria-pressed={f.sha256 === phantomSha}
                    onclick={() => pick(f)}><span class="truncate">{f.name}</span></button
                  >
                {:else}
                  <FileName client={sel.client} name={f.name} sha256={f.sha256} />
                {/if}
              </td>
              {#if fixedMode !== "bifti"}<td class="px-2 py-1 whitespace-nowrap text-muted">{f.type ?? "–"}</td>{/if}
              <td class="px-2 py-1 whitespace-nowrap">{formatSize(f.size)}</td>
              <td class="px-2 py-1 whitespace-nowrap">{formatTime(f.uploaded_at)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if !shown.length}
      <p class="p-2 text-xs text-muted">{mode === "bifti" && !query ? "Keine BIfTIs." : "Keine Datei passt zur Suche."}</p>
    {/if}
  {:else if loading}
    <p class="p-2 text-xs text-muted">Lade Dateien …</p>
  {/if}
</div>
