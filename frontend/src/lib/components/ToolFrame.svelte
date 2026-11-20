<script lang="ts">
  // Frame around one anyfield tool, labelled with the MCP tool that opens it
  // without `open_` (e.g. `phantom_browser`), so it is clear which tool is on screen.
  // Skeleton's `fieldset`/`legend`, with less padding than the default.
  import type { Snippet } from "svelte";

  let { name, class: cls = "", children }: { name: string; class?: string; children: Snippet } = $props();
</script>

<fieldset class="fieldset flex min-h-0 min-w-0 flex-col p-1 {cls}">
  <legend class="legend px-1 font-mono text-[10px] leading-none text-muted">{name}</legend>
  {@render children()}
</fieldset>
