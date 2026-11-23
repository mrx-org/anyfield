<script lang="ts">
  // The phantom browser: browse the BIfTI catalog or the phantoms in the gateway's
  // CAS and pick one. The CAS tab lists the caller's .zip files plus the chosen CAS
  // phantom, so whoever opens a shared session sees it even if it is not theirs.
  // Bound to a Selection: a session or local (MCP App without session, result back
  // to the chat). The phantom preview folds out at the top; folded (the
  // default) it is not rendered, so changing the phantom loads no maps here.
  import {
    Collapsible,
    Tabs,
    TreeView,
    createTreeViewCollection,
    type TreeViewRootProps,
  } from "@skeletonlabs/skeleton-svelte";
  import { onMount } from "svelte";
  import { isCas, phantomPatch, phantomSource } from "../../phantom";
  import { DEFAULT_PHANTOM } from "../../state/patch";
  import type { Selection } from "../../state/selection";
  import type { CasPhantomEntry, CatalogPhantom, PhantomCollection, PhantomTree } from "../../types";
  import ToolFrame from "../ToolFrame.svelte";
  import PhantomPreview from "./PhantomPreview.svelte";
  import TissueMenu from "./TissueMenu.svelte";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";

  let { sel }: { sel: Selection } = $props();

  /** A catalog node: a collection (children loaded on expand), a group or a phantom file. */
  interface Node {
    id: string;
    name: string;
    kind: "root" | "collection" | "group" | "phantom";
    collection: string;
    /** Phantom: its file name. Group: the file of its default phantom. */
    file?: string;
    description?: string;
    children?: Node[];
    childrenCount?: number;
  }

  const catalog = (children: Node[]) =>
    createTreeViewCollection<Node>({
      nodeToValue: (n) => n.id,
      nodeToString: (n) => n.name,
      rootNode: { id: "root", name: "", kind: "root", collection: "", children },
    });

  let tree = $state(catalog([]));
  let loaded = $state(false);
  let expanded = $state<string[]>([]);
  let loadError = $state<string | null>(null);
  /** Preview folded out: per view (device), not in the state. */
  let previewOpen = $state(false);

  const phantom = $derived(sel.state?.phantom ?? null);
  // The phantom chosen: for `phantom: null` the default one
  const current = $derived(sel.state ? (phantom ?? DEFAULT_PHANTOM) : null);
  const currentCas = $derived(current && isCas(current) ? current : null);
  const currentCatalog = $derived(current && !isCas(current) ? current : null);
  const selected = $derived(currentCatalog ? find(tree.rootNode.children ?? [], currentCatalog).map((n) => n.id) : []);
  let revealed: string | null = null;

  /** Open tab: per view, follows the kind of phantom chosen (here, by the AI, elsewhere). */
  let tab = $state<"catalog" | "cas">("catalog");
  let casList = $state<CasPhantomEntry[] | null>(null);
  let casLoading = $state(false);
  let casError = $state<string | null>(null);
  // The CAS phantom chosen comes first, also when it is not among the caller's files
  const casShown = $derived.by(() => {
    const own = casList ?? [];
    if (!currentCas || own.some((e) => e.sha256 === currentCas.sha256)) return own;
    return [{ ...currentCas, size: null, uploaded_at: null }, ...own];
  });
  let kindShown: string | null = null;

  // Whenever another phantom is chosen (here, by the AI, on another device), open the tree to it.
  $effect(() => {
    if (loaded && currentCatalog) void reveal(currentCatalog);
  });

  // ... and the tab of its kind, once per change of kind
  $effect(() => {
    if (!current) return;
    const kind = isCas(current) ? "cas" : "catalog";
    if (kind === kindShown) return;
    kindShown = kind;
    tab = kind;
  });

  // The CAS list loads when its tab is first shown
  $effect(() => {
    if (tab === "cas" && casList === null && !casLoading && !casError) void loadCas();
  });

  async function loadCas() {
    casLoading = true;
    casError = null;
    try {
      casList = await sel.client.listCasPhantoms();
    } catch (e) {
      casError = message(e);
    } finally {
      casLoading = false;
    }
  }

  onMount(async () => {
    try {
      tree = catalog((await sel.client.listPhantomCollections()).map(collectionNode));
      loaded = true;
    } catch (e) {
      loadError = message(e);
    }
  });

  async function reveal(choice: CatalogPhantom) {
    const id = `${choice.collection}/${choice.name}`;
    if (revealed === id) return;
    revealed = id;
    const collectionOf = () => (tree.rootNode.children ?? []).find((n) => n.collection === choice.collection);
    let node = collectionOf();
    if (!node) return;
    try {
      if (!node.children) {
        const children = phantomNodes(node.collection, await sel.client.listPhantoms(node.collection));
        // A new node, not a mutated one: the keyed {#each} only re-renders a node
        // whose object changed. Take the tree as it is now (other collections may
        // have loaded meanwhile).
        node = { ...(collectionOf() ?? node), children };
        const loadedNode = node;
        tree = catalog((tree.rootNode.children ?? []).map((n) => (n.id === loadedNode.id ? loadedNode : n)));
      }
      const path = [node.id, ...(pathTo(node.children ?? [], choice.name) ?? [])];
      expanded = [...new Set([...expanded, ...path])];
      loadError = null;
    } catch (e) {
      loadError = message(e);
      // Not revealed: the next run of the effect (state changed) tries again
      if (revealed === id) revealed = null;
    }
  }

  function collectionNode(c: PhantomCollection): Node {
    return {
      id: `c:${c.collection}`,
      name: c.collection,
      kind: "collection",
      collection: c.collection,
      description: c.description,
      childrenCount: c.phantom_count,
    };
  }

  function phantomNodes(collection: string, entries: PhantomTree, path = ""): Node[] {
    return entries.map((e) =>
      typeof e === "string"
        ? { id: `p:${collection}/${path}${e}`, name: e.replace(/\.json$/, ""), kind: "phantom", collection, file: e }
        : {
            id: `g:${collection}/${path}${e.group}`,
            name: e.group,
            kind: "group",
            collection,
            file: e.default,
            children: phantomNodes(collection, e.phantoms, `${path}${e.group}/`),
          },
    );
  }

  /** The phantom nodes for a choice (a file may appear in several groups). */
  function find(nodes: Node[], choice: CatalogPhantom): Node[] {
    return nodes.flatMap((n) =>
      n.kind === "phantom" && n.collection === choice.collection && n.file === choice.name
        ? [n]
        : find(n.children ?? [], choice),
    );
  }

  /** Ids of the groups leading to the first phantom with this file name. */
  function pathTo(nodes: Node[], file: string): string[] | null {
    for (const n of nodes) {
      if (n.kind === "phantom" && n.file === file) return [];
      const below = n.children ? pathTo(n.children, file) : null;
      if (below) return [n.id, ...below];
    }
    return null;
  }

  const loadChildren: TreeViewRootProps<Node>["loadChildren"] = async ({ node }) =>
    node.kind === "collection" ? phantomNodes(node.collection, await sel.client.listPhantoms(node.collection)) : [];

  function choose(name: string | undefined, collection: string) {
    if (!name) return;
    if (currentCatalog === phantom && phantom?.collection === collection && phantom.name === name) return;
    // Another phantom has other tissues: back to all of them
    sel.patch({ phantom: phantomPatch({ collection, name }), tissues: null });
  }

  function chooseCas(entry: CasPhantomEntry) {
    if (currentCas?.sha256 === entry.sha256) return;
    sel.patch({ phantom: phantomPatch({ sha256: entry.sha256, name: entry.name }), tissues: null });
  }

  const size = (n: number | null) =>
    n === null ? "" : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} kB` : `${n} B`;

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
        <!-- Only rendered while open: folded, the preview loads nothing -->
        {#if previewOpen}<ToolFrame name="phantom_preview"><PhantomPreview {sel} /></ToolFrame>{/if}
      </Collapsible.Content>
    </Collapsible>
  {/if}
  <section class="flex flex-col gap-2">
    <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">Phantom</h2>
    {#if sel.state}
      <div class="flex items-baseline gap-2">
        <span class="truncate font-medium" title={current?.name}>
          {current?.name.replace(/\.(json|zip)$/, "")}{#if !phantom}<span
              class="ml-1 text-xs font-normal text-muted">(Standard)</span>{/if}
        </span>
      </div>
      {#if current}<span class="-mt-1 truncate text-xs text-muted" title={currentCas?.sha256}>{phantomSource(current)}</span>{/if}
      <TissueMenu {sel} />
    {/if}
    {#if sel.error}<p class="text-xs text-error-500">{sel.error}</p>{/if}
  </section>

  <Tabs value={tab} onValueChange={(d) => (tab = d.value as "catalog" | "cas")}>
    <Tabs.List class="text-xs">
      <Tabs.Trigger value="catalog">Katalog</Tabs.Trigger>
      <Tabs.Trigger value="cas">CAS</Tabs.Trigger>
      <Tabs.Indicator />
    </Tabs.List>
  <Tabs.Content value="catalog">
  <section class="flex flex-col gap-1">
    {#if loadError}<p class="text-xs text-error-500">{loadError}</p>{/if}
    {#if !loaded && !loadError}<p class="text-xs text-muted">Lade Katalog …</p>{/if}
    <TreeView
      collection={tree}
      {loadChildren}
      onLoadChildrenComplete={(d) => {
        tree = d.collection;
        loadError = null;
      }}
      onLoadChildrenError={(d) => (loadError = d.nodes.map((n) => message(n.error)).join("\n"))}
      expandedValue={expanded}
      onExpandedChange={(d) => (expanded = d.expandedValue)}
      selectedValue={selected}
      onSelectionChange={(d) => {
        const n = d.selectedNodes[0];
        if (n?.kind === "phantom") choose(n.file, n.collection);
      }}
    >
      <TreeView.Tree class="w-full text-xs">
        {#each tree.rootNode.children ?? [] as node, index (node.id)}
          {@render treeNode(node, [index])}
        {/each}
      </TreeView.Tree>
    </TreeView>
  </section>
  </Tabs.Content>
  <Tabs.Content value="cas">
    <section class="flex flex-col gap-1 text-xs">
      <div class="flex items-center gap-2">
        <span class="flex-1 text-muted">Phantome (bifti .zip) in deinen Dateien</span>
        <button class="btn-icon btn-icon-sm" title="Aktualisieren" aria-label="Aktualisieren" disabled={casLoading} onclick={loadCas}>
          <RefreshCw class="size-4 {casLoading ? 'animate-spin' : ''}" />
        </button>
      </div>
      {#if casError}<p class="text-error-500">{casError}</p>{/if}
      {#if casLoading && casList === null}<p class="text-muted">Lade CAS …</p>{/if}
      <ul class="flex flex-col">
        {#each casShown as e (e.sha256)}
          <li>
            <button
              class="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left hover:preset-tonal {currentCas?.sha256 === e.sha256 ? 'preset-tonal-primary' : ''}"
              title="{e.name} · sha256 {e.sha256}"
              aria-pressed={currentCas?.sha256 === e.sha256}
              onclick={() => chooseCas(e)}
            >
              <span class="min-w-0 flex-1 truncate">{e.name}</span>
              <span class="shrink-0 text-muted">{e.uploaded_at === null ? "aus der Session" : size(e.size)}</span>
            </button>
          </li>
        {:else}
          {#if casList !== null}<li class="px-2 py-1 text-muted">Keine Phantome im CAS.</li>{/if}
        {/each}
      </ul>
    </section>
  </Tabs.Content>
  </Tabs>
</div>

{#snippet treeNode(node: Node, indexPath: number[])}
  <TreeView.NodeProvider value={{ node, indexPath }}>
    {#if node.children || node.childrenCount}
      <TreeView.Branch>
        <TreeView.BranchControl class="py-1">
          <TreeView.BranchIndicator class="data-loading:hidden" />
          <!-- Same size as the chevron (size-4), so the row keeps its height while loading -->
          <TreeView.BranchIndicator class="hidden data-loading:inline-flex">
            <LoaderCircle class="size-4 animate-spin" />
          </TreeView.BranchIndicator>
          <TreeView.BranchText class="min-w-0 flex-1" title={node.description ?? node.name}>
            <span class="truncate {node.kind === 'collection' ? 'font-medium' : 'text-muted'}">{node.name}</span>
            {#if node.kind === "collection"}
              <span class="ml-auto shrink-0 text-muted">{node.childrenCount}</span>
            {/if}
          </TreeView.BranchText>
          {#if node.kind === "group" && node.file}
            <button
              class="btn btn-sm ml-auto px-1 py-0 text-[10px] text-muted hover:text-accent"
              title="Standard dieser Gruppe: {node.file}"
              onclick={(e) => {
                e.stopPropagation();
                choose(node.file, node.collection);
              }}
              onkeydown={(e) => e.stopPropagation()}
            >Standard</button>
          {/if}
        </TreeView.BranchControl>
        <TreeView.BranchContent>
          <TreeView.BranchIndentGuide />
          {#each node.children ?? [] as child, childIndex (child.id)}
            {@render treeNode(child, [...indexPath, childIndex])}
          {/each}
        </TreeView.BranchContent>
      </TreeView.Branch>
    {:else}
      <TreeView.Item class="truncate py-1 data-selected:preset-tonal-primary" title={node.file}>
        {node.name}
      </TreeView.Item>
    {/if}
  </TreeView.NodeProvider>
{/snippet}
