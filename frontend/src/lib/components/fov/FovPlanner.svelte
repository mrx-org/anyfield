<script lang="ts">
  // The FOV planning tool: viewer + controls for one session. Self-contained,
  // so it works standalone, as MCP App and later inside the full anyfield UI.
  import type { SessionStore } from "../../state/session.svelte";
  import FovPanel from "./FovPanel.svelte";
  import FovViewer from "./FovViewer.svelte";

  let { store, compact = false }: { store: SessionStore; compact?: boolean } = $props();
</script>

<div class="flex h-full w-full {compact ? 'flex-col' : 'flex-col md:flex-row'} bg-bg text-text">
  <div class="min-h-0 flex-1 {compact ? 'min-h-72' : 'min-h-96'}">
    {#if store.server}
      <FovViewer fov={store.fov} phantomUrl={store.server.phantom_url} />
    {:else if store.error}
      <p class="p-4 text-red-400">{store.error}</p>
    {:else}
      <p class="p-4 text-muted">Lade Session …</p>
    {/if}
  </div>
  {#if store.fov}
    <aside class="{compact ? 'border-t' : 'border-t md:w-72 md:border-l md:border-t-0'} overflow-y-auto border-border bg-panel p-3">
      <FovPanel fov={store.fov} onchange={(c) => store.editFov(c)} />
      {#if store.error && store.server}
        <p class="mt-3 text-xs text-red-400">{store.error}</p>
      {/if}
    </aside>
  {/if}
</div>
