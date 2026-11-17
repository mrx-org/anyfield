<script lang="ts">
  // The phantom tool: browse the BIfTI catalog (gateway), pick a phantom and the
  // property it is shown with. Bound to a Selection: a session or local (MCP App
  // without session, result back to the chat).
  import { onMount } from "svelte";
  import { MapsLoader } from "../../state/maps.svelte";
  import type { Selection } from "../../state/selection";
  import type { PhantomCollection, PhantomTree } from "../../types";
  import PhantomTreeNode from "./PhantomTreeNode.svelte";
  import VolumePreview from "./VolumePreview.svelte";

  let { sel, preview = true }: { sel: Selection; preview?: boolean } = $props();

  let collections = $state<PhantomCollection[] | null>(null);
  let trees = $state<Record<string, PhantomTree>>({});
  let openCollection = $state<string | null>(null);
  let loadError = $state<string | null>(null);
  // svelte-ignore state_referenced_locally
  const maps = new MapsLoader(sel.client);

  const phantom = $derived(sel.state?.phantom ?? null);
  const property = $derived(sel.state?.view.property ?? "density");
  const shown = $derived(maps.property(property));

  $effect(() => {
    if (sel.state) maps.load(phantom);
  });

  onMount(async () => {
    try {
      collections = await sel.client.listPhantomCollections();
      if (phantom) await toggle(phantom.collection);
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
  });

  async function toggle(collection: string) {
    openCollection = openCollection === collection ? null : collection;
    if (openCollection && !trees[collection]) {
      try {
        trees[collection] = await sel.client.listPhantoms(collection);
      } catch (e) {
        loadError = e instanceof Error ? e.message : String(e);
      }
    }
  }

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
      {#if maps.error}<p class="text-xs text-red-400">{maps.error}</p>{/if}
      <div class="flex flex-wrap gap-1">
        {#each maps.maps?.properties ?? [] as p (p.key)}
          <button
            class="rounded border px-2 py-0.5 text-xs {p.key === shown?.key ? 'border-accent text-accent' : 'border-border text-muted hover:text-text'}"
            onclick={() => sel.patch({ view: { property: p.key } })}
            title="{p.label} ({p.unit})"
          >{p.label}</button>
        {/each}
      </div>
      {#if shown?.range}
        <span class="text-xs text-muted">{shown.label}: {fmt(shown.range[0])} … {fmt(shown.range[1])} {shown.unit}</span>
      {/if}
      {#if preview}<VolumePreview url={maps.loading ? null : (shown?.url ?? null)} range={shown?.range ?? null} />{/if}
    {/if}
    {#if sel.error}<p class="text-xs text-red-400">{sel.error}</p>{/if}
  </section>

  <section class="flex flex-col gap-1">
    <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">Katalog</h2>
    {#if loadError}<p class="text-xs text-red-400">{loadError}</p>{/if}
    {#if collections === null && !loadError}<p class="text-xs text-muted">Lade Katalog …</p>{/if}
    {#each collections ?? [] as c (c.collection)}
      <div class="rounded border border-border">
        <button class="flex w-full items-baseline gap-2 px-2 py-1.5 text-left" onclick={() => toggle(c.collection)} aria-expanded={openCollection === c.collection}>
          <span class="truncate font-medium" title={c.collection}>{c.collection}</span>
          <span class="ml-auto shrink-0 text-xs text-muted">{c.phantom_count}</span>
        </button>
        {#if openCollection === c.collection}
          <div class="flex flex-col gap-1 border-t border-border px-2 py-1.5">
            <p class="text-xs text-muted">{c.description}</p>
            {#if trees[c.collection]}
              <PhantomTreeNode
                tree={trees[c.collection]}
                selected={phantom?.collection === c.collection ? phantom.name : null}
                busy={maps.loading ? (phantom?.name ?? null) : null}
                onselect={(name) => sel.patch({ phantom: { collection: c.collection, name } })}
              />
            {:else}
              <p class="text-xs text-muted">Lade …</p>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </section>
</div>
