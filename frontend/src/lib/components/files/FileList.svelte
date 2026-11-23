<script lang="ts">
  // The user's files as a table: download, name (click: name and hash to the chat),
  // type, size, uploaded. Every column sorts (click its header), a search field filters
  // by name and type, a dropdown next to it shows all files or only the bifti
  // phantoms. Narrow, the table scrolls sideways.
  // Bump `reload` to load the list again (e.g. after an upload). Opened again, the list
  // this client loaded last shows at once while the server's (cached a few minutes)
  // comes in.
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import Download from "@lucide/svelte/icons/download";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import { FILE_MODES, filterFiles, formatSize, formatTime, isBifti, sortFiles, type FileMode, type SortKey } from "../../files";
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
  let mode = $state<FileMode>("all");
  let sortKey = $state<SortKey>("uploaded_at");
  let ascending = $state(false);

  const inMode = $derived(files ? (mode === "bifti" ? files.filter(isBifti) : files) : []);
  const shown = $derived(sortFiles(filterFiles(inMode, query), sortKey, ascending));
  const chat = $derived(!!sel.client.transport.openLink);

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

</script>

<!-- min-w-0 down to the table-wrap: flex items are otherwise as wide as the table,
     and nothing scrolls -->
<div class="flex min-h-0 min-w-0 flex-col gap-2 text-sm text-text">
  <div class="flex items-center gap-2">
    <input class="input min-w-0 flex-1 text-xs" type="search" placeholder="Suchen (Name, Typ)" bind:value={query} />
    <select class="select w-auto shrink-0 text-xs" aria-label="Modus" bind:value={mode}>
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
            <th class="sticky top-0 z-10 w-0 bg-bg px-2 py-1 text-left"><span class="sr-only">Download</span></th>
            {#each COLUMNS as c (c.key)}
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
            <tr class="hover:preset-tonal">
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
              <td class="max-w-64 px-2 py-1"><FileName client={sel.client} name={f.name} sha256={f.sha256} /></td>
              <td class="px-2 py-1 whitespace-nowrap text-muted">{f.type ?? "–"}</td>
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
