<script lang="ts">
  // One level of a registry phantoms list: groups (collapsible) and phantom files.
  import type { PhantomTree } from "../../types";
  import Self from "./PhantomTreeNode.svelte";

  let {
    tree,
    selected,
    busy,
    onselect,
    depth = 0,
  }: {
    tree: PhantomTree;
    selected: string | null;
    busy: string | null;
    onselect: (name: string) => void;
    depth?: number;
  } = $props();

  let open = $state<Record<string, boolean>>({});
  const label = (name: string) => name.replace(/\.json$/, "");
</script>

<ul class="flex flex-col" style="padding-left: {depth ? 0.75 : 0}rem">
  {#each tree as entry (typeof entry === "string" ? entry : entry.group)}
    {#if typeof entry === "string"}
      <li>
        <button
          class="w-full truncate rounded px-2 py-0.5 text-left text-xs hover:bg-bg {selected === entry ? 'bg-bg text-accent' : ''}"
          disabled={busy !== null}
          onclick={() => onselect(entry)}
          title={entry}
        >
          {label(entry)}{#if busy === entry}<span class="ml-1 text-muted">· lädt …</span>{/if}
        </button>
      </li>
    {:else}
      <li>
        <button
          class="flex w-full items-center gap-1 px-2 py-0.5 text-left text-xs text-muted hover:text-text"
          onclick={() => (open[entry.group] = !open[entry.group])}
          aria-expanded={!!open[entry.group]}
        >
          <span class="w-3">{open[entry.group] ? "▾" : "▸"}</span>{entry.group}
          {#if entry.default}
            <span
              role="button"
              tabindex="0"
              class="ml-auto rounded px-1 text-[10px] hover:text-accent"
              title="Standard dieser Gruppe: {entry.default}"
              onclick={(e) => { e.stopPropagation(); if (busy === null) onselect(entry.default!); }}
              onkeydown={(e) => { if (e.key === "Enter" && busy === null) onselect(entry.default!); }}
            >Standard</span>
          {/if}
        </button>
        {#if open[entry.group]}
          <Self tree={entry.phantoms} {selected} {busy} {onselect} depth={depth + 1} />
        {/if}
      </li>
    {/if}
  {/each}
</ul>
