<script lang="ts">
  // The sequence browser: a tab per sequence source (list_sequence_sources) with its
  // files and their sequence functions as a tree, and a tab for the user's sequence
  // files in the gateway's CAS (file_list fixed to sequences). Picking a function (or
  // a .seq file) makes it the sequence (state field `sequence`).
  // The sources and their files will come from a tool of the MRX gateway; until then
  // the server lists placeholders (dummy files). The preview (duration, parameters)
  // comes with that tool too: folded out it says so for now.
  // Bound to a Selection: a session or local (MCP App without session, result back
  // to the chat).
  import {
    Collapsible,
    Tabs,
    TreeView,
    createTreeViewCollection,
  } from "@skeletonlabs/skeleton-svelte";
  import { onMount } from "svelte";
  import { isCasSequence, sameSequence, sequenceLabel, sequencePatch, sequenceSource } from "../../sequence";
  import type { Selection } from "../../state/selection";
  import type { SequenceChoice, SequenceFile, SequenceSource } from "../../types";
  import FileList from "../files/FileList.svelte";
  import ToolFrame from "../ToolFrame.svelte";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import X from "@lucide/svelte/icons/x";

  let { sel }: { sel: Selection } = $props();

  /** A tree node: a file of a source (branch, unless it is a sequence itself) or a function in it. */
  interface Node {
    id: string;
    name: string;
    kind: "root" | "file" | "func";
    file?: SequenceFile;
    func?: string;
    children?: Node[];
  }

  /** Value of the CAS tab (no source name starts with "@"). */
  const CAS = "@cas";
  let sources = $state<SequenceSource[] | null>(null);
  let sourcesError = $state<string | null>(null);
  /** Files per source, loaded when its tab is first shown. */
  let files = $state<Record<string, SequenceFile[]>>({});
  let filesError = $state<Record<string, string>>({});
  let query = $state("");
  let expanded = $state<string[]>([]);
  /** Preview folded out: per view (device), not in the state. */
  let previewOpen = $state(false);
  /** Open tab: a source or the CAS; follows the sequence chosen (here, by the AI, elsewhere). */
  let tab = $state<string>("");
  let shownFor: string | null = null;

  const current = $derived<SequenceChoice | null>(sel.state?.sequence ?? null);
  const currentTab = $derived(current ? (isCasSequence(current) ? CAS : current.source) : null);

  onMount(async () => {
    try {
      sources = await sel.client.listSequenceSources();
      if (!tab) tab = currentTab ?? sources[0]?.source ?? CAS;
    } catch (e) {
      sourcesError = message(e);
      tab = CAS;
    }
  });

  // Whenever another sequence is chosen, open the tab it comes from (once per change)
  $effect(() => {
    const id = current ? `${currentTab}|${sequenceLabel(current)}` : null;
    if (!id || id === shownFor) return;
    shownFor = id;
    tab = currentTab!;
  });

  // The files of the shown source, once
  $effect(() => {
    const source = tab;
    if (!source || source === CAS || files[source] || filesError[source]) return;
    sel.client.listSequences(source).then(
      (listed) => {
        files = { ...files, [source]: listed };
        // Open every file: a source holds few, and the functions are what one picks
        expanded = [...new Set([...expanded, ...listed.filter((f) => f.functions.length).map((f) => fileId(source, f))])];
      },
      (e) => (filesError = { ...filesError, [source]: message(e) }),
    );
  });

  const fileId = (source: string, f: SequenceFile) => `${source}|${f.url}`;

  /** The tree of a source's files, narrowed to what matches the search. */
  function treeOf(source: string, listed: SequenceFile[], q: string) {
    const needle = q.trim().toLowerCase();
    const children: Node[] = [];
    for (const f of listed) {
      const fileHit = !needle || f.name.toLowerCase().includes(needle);
      const funcs = fileHit ? f.functions : f.functions.filter((fn) => fn.toLowerCase().includes(needle));
      if (!fileHit && !funcs.length) continue;
      const id = fileId(source, f);
      children.push({
        id,
        name: f.name,
        kind: "file",
        file: f,
        children: f.functions.length
          ? funcs.map((fn) => ({ id: `${id}|${fn}`, name: fn, kind: "func" as const, file: f, func: fn }))
          : undefined,
      });
    }
    return createTreeViewCollection<Node>({
      nodeToValue: (n) => n.id,
      nodeToString: (n) => n.name,
      rootNode: { id: "root", name: "", kind: "root", children },
    });
  }

  const tree = $derived(tab && tab !== CAS && files[tab] ? treeOf(tab, files[tab], query) : null);
  const selected = $derived(
    current && !isCasSequence(current)
      ? [current.func ? `${current.source}|${current.url}|${current.func}` : `${current.source}|${current.url}`]
      : [],
  );

  function choose(source: string, n: Node) {
    if (!n.file) return;
    // A file with functions is picked by one of them; a .seq file is a sequence itself
    if (n.kind === "file" && n.file.functions.length) return;
    const choice: SequenceChoice = { source, type: n.file.type, url: n.file.url, name: n.file.name, func: n.func ?? null };
    if (sameSequence(choice, current)) return;
    sel.patch({ sequence: sequencePatch(choice) });
  }

  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
</script>

<div class="flex h-full flex-col gap-3 overflow-y-auto p-3 text-sm text-text">
  {#if sel.state}
    <Collapsible open={previewOpen} onOpenChange={(d) => (previewOpen = d.open)}>
      <Collapsible.Trigger class="btn btn-sm preset-outlined-surface-300-700 w-full justify-start text-xs">
        <ChevronRight class="size-4 transition-transform {previewOpen ? 'rotate-90' : ''}" aria-hidden="true" />
        Vorschau
      </Collapsible.Trigger>
      <Collapsible.Content class="mt-2">
        {#if previewOpen}
          <p class="rounded border border-dashed border-border p-3 text-xs text-muted">
            Dauer, Parameter und Waveforms der Sequenz: kommen mit dem Sequenz-Tool des MRX-Gateways.
          </p>
        {/if}
      </Collapsible.Content>
    </Collapsible>
  {/if}

  <section class="flex flex-col gap-2">
    <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">Sequenz</h2>
    {#if current}
      <div class="flex items-center gap-2">
        <div class="flex min-w-0 flex-1 flex-col">
          <span class="truncate font-medium" title={sequenceLabel(current)}>{current.func ?? current.name}</span>
          <span class="truncate text-xs text-muted" title={isCasSequence(current) ? current.sha256 : current.url}>
            {sequenceSource(current)} · {current.name}
          </span>
        </div>
        <button
          type="button"
          class="btn-icon btn-icon-sm hover:preset-tonal shrink-0"
          aria-label="Sequenz abwählen"
          title="Sequenz abwählen"
          onclick={() => sel.patch({ sequence: null })}
        >
          <X class="size-4" aria-hidden="true" />
        </button>
      </div>
    {:else if sel.state}
      <span class="text-xs text-muted">Keine gewählt.</span>
    {/if}
    {#if sel.error}<p class="text-xs text-error-500">{sel.error}</p>{/if}
  </section>

  {#if sourcesError}<p class="text-xs text-error-500">{sourcesError}</p>{/if}
  {#if !sources && !sourcesError}<p class="text-xs text-muted">Lade Quellen …</p>{/if}

  {#if tab}
    <Tabs value={tab} onValueChange={(d) => (tab = d.value)}>
      <!-- One tab per source: narrow, the row scrolls sideways -->
      <Tabs.List class="overflow-x-auto text-xs whitespace-nowrap">
        {#each sources ?? [] as s (s.source)}
          <Tabs.Trigger value={s.source} title={s.description ?? s.origin}>{s.source}</Tabs.Trigger>
        {/each}
        <Tabs.Trigger value={CAS} title="Deine Sequenzdateien (.seq, .py, .ipynb)">CAS</Tabs.Trigger>
        <Tabs.Indicator />
      </Tabs.List>
      {#each sources ?? [] as s (s.source)}
        <Tabs.Content value={s.source}>
          {#if tab === s.source}
            <section class="flex flex-col gap-1">
              <span class="truncate text-xs text-muted" title={s.origin}>{s.description ?? s.origin}</span>
              <input class="input text-xs" type="search" placeholder="Suchen (Datei, Funktion)" bind:value={query} />
              {#if filesError[s.source]}<p class="text-xs text-error-500">{filesError[s.source]}</p>{/if}
              {#if tree}
                {#if !tree.rootNode.children?.length}
                  <p class="p-2 text-xs text-muted">{query ? "Nichts passt zur Suche." : "Keine Sequenzen."}</p>
                {/if}
                <TreeView
                  collection={tree}
                  expandedValue={expanded}
                  onExpandedChange={(d) => (expanded = d.expandedValue)}
                  selectedValue={selected}
                  onSelectionChange={(d) => {
                    const n = d.selectedNodes[0];
                    if (n) choose(s.source, n);
                  }}
                >
                  <TreeView.Tree class="w-full text-xs">
                    {#each tree.rootNode.children ?? [] as node, index (node.id)}
                      {@render treeNode(node, [index])}
                    {/each}
                  </TreeView.Tree>
                </TreeView>
              {:else if !filesError[s.source]}
                <p class="text-xs text-muted">Lade Sequenzen …</p>
              {/if}
            </section>
          {/if}
        </Tabs.Content>
      {/each}
      <Tabs.Content value={CAS}>
        <!-- The user's sequence files: file_list, fixed to sequences, a click picks the
             file (also without a session); it loads when the tab is first shown -->
        {#if tab === CAS}
          <ToolFrame name="file_list"><FileList {sel} mode="sequence" download={false} select /></ToolFrame>
        {/if}
      </Tabs.Content>
    </Tabs>
  {/if}
</div>

{#snippet treeNode(node: Node, indexPath: number[])}
  <TreeView.NodeProvider value={{ node, indexPath }}>
    {#if node.children}
      <TreeView.Branch>
        <TreeView.BranchControl class="py-1">
          <TreeView.BranchIndicator />
          <TreeView.BranchText class="min-w-0 flex-1" title={node.file?.url}>
            <span class="truncate text-muted">{node.name}</span>
          </TreeView.BranchText>
        </TreeView.BranchControl>
        <TreeView.BranchContent>
          <TreeView.BranchIndentGuide />
          {#each node.children as child, childIndex (child.id)}
            {@render treeNode(child, [...indexPath, childIndex])}
          {/each}
        </TreeView.BranchContent>
      </TreeView.Branch>
    {:else}
      <TreeView.Item class="truncate py-1 data-selected:preset-tonal-primary" title={node.file?.url}>
        {node.name}
      </TreeView.Item>
    {/if}
  </TreeView.NodeProvider>
{/snippet}
