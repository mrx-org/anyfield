<script lang="ts">
  // The phantom tool: browse the BIfTI catalog (gateway), pick a phantom and the
  // property it is shown with. Bound to a Selection: a session or local (MCP App
  // without session, result back to the chat).
  import { TreeView, createTreeViewCollection, type TreeViewRootProps } from "@skeletonlabs/skeleton-svelte";
  import { onMount } from "svelte";
  import { MapsLoader } from "../../state/maps.svelte";
  import type { Selection } from "../../state/selection";
  import type { PhantomChoice, PhantomCollection, PhantomTree } from "../../types";
  import VolumePreview from "./VolumePreview.svelte";

  let { sel, preview = true }: { sel: Selection; preview?: boolean } = $props();

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
  // svelte-ignore state_referenced_locally
  const maps = new MapsLoader(sel.client);

  const phantom = $derived(sel.state?.phantom ?? null);
  const property = $derived(sel.state?.view.property ?? "density");
  const shown = $derived(maps.property(property));
  const selected = $derived(phantom ? find(tree.rootNode.children ?? [], phantom).map((n) => n.id) : []);

  $effect(() => {
    if (sel.state) maps.load(phantom);
  });

  onMount(async () => {
    try {
      const collections = await sel.client.listPhantomCollections();
      const nodes = collections.map(collectionNode);
      // Open the chosen phantom's collection right away, with the path to it expanded.
      const open = phantom && nodes.find((n) => n.collection === phantom.collection);
      if (open) {
        open.children = phantomNodes(open.collection, await sel.client.listPhantoms(open.collection));
        expanded = [open.id, ...(pathTo(open.children, phantom.name) ?? [])];
      }
      tree = catalog(nodes);
      loaded = true;
    } catch (e) {
      loadError = message(e);
    }
  });

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
    if (!name || maps.loading) return;
    if (phantom?.collection === collection && phantom.name === name) return;
    sel.patch({ phantom: { collection, name } });
  }

  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(2));
</script>

<div class="flex h-full flex-col gap-3 overflow-y-auto bg-panel p-3 text-sm text-text">
  <section class="flex flex-col gap-2">
    <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">Phantom</h2>
    {#if sel.state}
      <div class="flex items-baseline gap-2">
        <span class="truncate font-medium" title={phantom?.name}>
          {phantom ? phantom.name.replace(/\.json$/, "") : "Standard (BrainWeb subj04, 2 mm)"}
        </span>
        {#if maps.loading}<span class="text-xs text-accent">wird vorbereitet …</span>{/if}
      </div>
      {#if phantom}<span class="-mt-1 text-xs text-muted">{phantom.collection}</span>{/if}
      {#if maps.error}<p class="text-xs text-error-500">{maps.error}</p>{/if}
      <div class="flex flex-wrap gap-1">
        {#each maps.maps?.properties ?? [] as p (p.key)}
          <button
            class="chip text-xs {p.key === shown?.key ? 'preset-filled-primary-500' : 'preset-outlined-surface-300-700'}"
            onclick={() => sel.patch({ view: { property: p.key } })}
            title="{p.label} ({p.unit})"
            aria-pressed={p.key === shown?.key}
          >{p.label}</button>
        {/each}
      </div>
      {#if shown?.range}
        <span class="text-xs text-muted">{shown.label}: {fmt(shown.range[0])} … {fmt(shown.range[1])} {shown.unit}</span>
      {/if}
      {#if preview}<VolumePreview url={maps.loading ? null : (shown?.url ?? null)} range={shown?.range ?? null} />{/if}
    {/if}
    {#if sel.error}<p class="text-xs text-error-500">{sel.error}</p>{/if}
  </section>

  <section class="flex flex-col gap-1">
    {#if loadError}<p class="text-xs text-error-500">{loadError}</p>{/if}
    {#if !loaded && !loadError}<p class="text-xs text-muted">Lade Katalog …</p>{/if}
    <TreeView
      collection={tree}
      {loadChildren}
      onLoadChildrenComplete={(d) => (tree = d.collection)}
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
          <TreeView.BranchIndicator class="hidden animate-spin data-loading:inline">⟳</TreeView.BranchIndicator>
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
              disabled={maps.loading}
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
        {#if maps.loading && phantom?.collection === node.collection && phantom.name === node.file}
          <span class="ml-1 text-muted">· lädt …</span>
        {/if}
      </TreeView.Item>
    {/if}
  </TreeView.NodeProvider>
{/snippet}
