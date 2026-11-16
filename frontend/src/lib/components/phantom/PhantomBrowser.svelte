<script lang="ts">
  // The phantom tool: browse the BIfTI catalog, pick the session's phantom and
  // the property it is shown with. Works standalone, as MCP App and next to
  // the FOV planner.
  import { onMount } from "svelte";
  import type { SessionStore } from "../../state/session.svelte";
  import type { PhantomCollection, PhantomTree } from "../../types";
  import PhantomTreeNode from "./PhantomTreeNode.svelte";
  import VolumePreview from "./VolumePreview.svelte";

  let { store, preview = true }: { store: SessionStore; preview?: boolean } = $props();

  let collections = $state<PhantomCollection[] | null>(null);
  let trees = $state<Record<string, PhantomTree>>({});
  let openCollection = $state<string | null>(null);
  let loadError = $state<string | null>(null);

  const phantom = $derived(store.server?.phantom ?? null);
  const shown = $derived(phantom?.properties.find((p) => p.key === phantom.property) ?? null);
  const busyName = $derived(store.selecting?.name ?? (phantom?.status === "loading" ? phantom.name : null));

  onMount(async () => {
    try {
      collections = await store.client.listPhantomCollections();
      const current = phantom?.collection;
      if (current) await toggle(current);
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
  });

  async function toggle(collection: string) {
    openCollection = openCollection === collection ? null : collection;
    if (openCollection && !trees[collection]) {
      try {
        trees[collection] = await store.client.listPhantoms(collection);
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
    {#if phantom}
      <div class="flex items-baseline gap-2">
        <span class="truncate font-medium" title={phantom.name}>
          {phantom.collection ? phantom.name.replace(/\.json$/, "") : "Standard (BrainWeb subj04, 2 mm)"}
        </span>
        {#if phantom.status === "loading"}<span class="text-xs text-accent">wird vorbereitet …</span>{/if}
      </div>
      {#if phantom.collection}<span class="-mt-1 text-xs text-muted">{phantom.collection}</span>{/if}
      {#if phantom.status === "error"}<p class="text-xs text-red-400">{phantom.error}</p>{/if}
      <div class="flex flex-wrap gap-1">
        {#each phantom.properties as p (p.key)}
          <button
            class="rounded border px-2 py-0.5 text-xs {p.key === phantom.property ? 'border-accent text-accent' : 'border-border text-muted hover:text-text'}"
            onclick={() => store.setPhantomProperty(p.key)}
            title="{p.label} ({p.unit})"
          >{p.label}</button>
        {/each}
      </div>
      {#if shown?.range}
        <span class="text-xs text-muted">{shown.label}: {fmt(shown.range[0])} … {fmt(shown.range[1])} {shown.unit}</span>
      {/if}
      {#if preview}<VolumePreview url={phantom.url} range={shown?.range ?? null} />{/if}
    {/if}
    {#if store.error}<p class="text-xs text-red-400">{store.error}</p>{/if}
  </section>

  <section class="flex flex-col gap-1">
    <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">Katalog</h2>
    {#if loadError}<p class="text-xs text-red-400">{loadError}</p>{/if}
    {#if collections === null && !loadError}<p class="text-xs text-muted">Lade Katalog …</p>{/if}
    {#each collections ?? [] as c (c.collection)}
      <div class="rounded border border-border">
        <button class="flex w-full items-baseline gap-2 px-2 py-1.5 text-left" onclick={() => toggle(c.collection)} aria-expanded={openCollection === c.collection}>
          <span class="font-medium">{c.label}</span>
          <span class="ml-auto shrink-0 text-xs text-muted">{c.phantom_count}</span>
        </button>
        {#if openCollection === c.collection}
          <div class="flex flex-col gap-1 border-t border-border px-2 py-1.5">
            <p class="text-xs text-muted">{c.description}</p>
            <p class="text-[11px] text-muted">
              {c.authors.join("; ")} · {c.license}
              {#if c.doi} · <a class="underline hover:text-text" href="https://doi.org/{c.doi}" target="_blank" rel="noreferrer">DOI</a>{/if}
            </p>
            {#if trees[c.collection]}
              <PhantomTreeNode
                tree={trees[c.collection]}
                selected={phantom?.collection === c.collection ? phantom.name : null}
                busy={busyName}
                onselect={(name) => store.selectPhantom(c.collection, name)}
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
