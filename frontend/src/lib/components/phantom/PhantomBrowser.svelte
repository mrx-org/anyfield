<script lang="ts">
  // The phantom browser: browse the BIfTI catalog (gateway) and pick a phantom.
  // Bound to a Selection: a session or local (MCP App without session, result back
  // to the chat). The phantom preview folds out below the choice; folded (the
  // default) it is not rendered, so changing the phantom loads no maps here.
  import {
    Collapsible,
    TreeView,
    createTreeViewCollection,
    type TreeViewRootProps,
  } from "@skeletonlabs/skeleton-svelte";
  import { onMount } from "svelte";
  import { DEFAULT_PHANTOM } from "../../state/patch";
  import type { Selection } from "../../state/selection";
  import type { PhantomChoice, PhantomCollection, PhantomTree } from "../../types";
  import ToolFrame from "../ToolFrame.svelte";
  import PhantomPreview from "./PhantomPreview.svelte";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";

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
  const selected = $derived(current ? find(tree.rootNode.children ?? [], current).map((n) => n.id) : []);
  let revealed: string | null = null;

  // Whenever another phantom is chosen (here, by the AI, on another device), open the tree to it.
  $effect(() => {
    if (loaded && current) void reveal(current);
  });

  onMount(async () => {
    try {
      tree = catalog((await sel.client.listPhantomCollections()).map(collectionNode));
      loaded = true;
    } catch (e) {
      loadError = message(e);
    }
  });

  async function reveal(choice: PhantomChoice) {
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
  function find(nodes: Node[], choice: PhantomChoice): Node[] {
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
    if (phantom?.collection === collection && phantom.name === name) return;
    sel.patch({ phantom: { collection, name } });
  }

  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
</script>

<div class="flex h-full flex-col gap-3 overflow-y-auto p-3 text-sm text-text">
  <section class="flex flex-col gap-2">
    <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">Phantom</h2>
    {#if sel.state}
      <div class="flex items-baseline gap-2">
        <span class="truncate font-medium" title={current?.name}>
          {current?.name.replace(/\.json$/, "")}{#if !phantom}<span
              class="ml-1 text-xs font-normal text-muted">(Standard)</span>{/if}
        </span>
      </div>
      {#if current}<span class="-mt-1 text-xs text-muted">{current.collection}</span>{/if}
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
    {#if sel.error}<p class="text-xs text-error-500">{sel.error}</p>{/if}
  </section>

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
      <TreeView.Label class="text-xs font-semibold uppercase tracking-wide text-muted">Katalog</TreeView.Label>
      <TreeView.Tree class="w-full text-xs">
        {#each tree.rootNode.children ?? [] as node, index (node.id)}
          {@render treeNode(node, [index])}
        {/each}
      </TreeView.Tree>
    </TreeView>
  </section>
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
