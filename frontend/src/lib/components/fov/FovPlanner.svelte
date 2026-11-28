<script lang="ts">
  // The FOV planner: sliders for the FOV box (position, rotation, size) and its matrix,
  // i.e. an affine with a grid. At the top, the phantom preview resliced onto that grid folds
  // out; folded (the default, per view) it is not rendered and the gateway reslices nothing.
  // The box is drawn and dragged in the visual FOV planner (FovViewer).
  // Bound to a Selection, so it works on a session, locally in an MCP App, and on the website.
  import { m } from "../../../paraglide/messages.js";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import { Collapsible } from "@skeletonlabs/skeleton-svelte";
  import type { Selection } from "../../state/selection";
  import ToolFrame from "../ToolFrame.svelte";
  import PhantomPreview from "../phantom/PhantomPreview.svelte";
  import FovPanel from "./FovPanel.svelte";

  let { sel }: { sel: Selection } = $props();

  /** Preview folded out: per view (device), not in the state. */
  let previewOpen = $state(false);
</script>

<div class="flex h-full flex-col gap-3 overflow-y-auto p-3 text-sm text-text">
  {#if sel.state}
    <Collapsible open={previewOpen} onOpenChange={(d) => (previewOpen = d.open)}>
      <Collapsible.Trigger class="btn btn-sm preset-outlined-surface-300-700 w-full justify-start text-xs">
        <ChevronRight class="size-4 transition-transform {previewOpen ? 'rotate-90' : ''}" aria-hidden="true" />
        {m.fov_preview_resampled()}
      </Collapsible.Trigger>
      <Collapsible.Content class="mt-2">
        <!-- Only rendered while open: folded, nothing is resliced -->
        {#if previewOpen}
          <ToolFrame name="phantom_preview">
            <PhantomPreview {sel} grid={{ fov: sel.state.fov, matrix: sel.state.matrix }} />
          </ToolFrame>
        {/if}
      </Collapsible.Content>
    </Collapsible>
    <FovPanel
      fov={sel.state.fov}
      matrix={sel.state.matrix}
      onfov={(c) => sel.patch({ fov: c })}
      onmatrix={(m) => sel.patch({ matrix: m })}
    />
  {:else if sel.error}
    <p class="text-error-500">{sel.error}</p>
  {:else}
    <p class="text-muted">{m.common_loading_session()}</p>
  {/if}
  {#if sel.state && sel.error}<p class="text-xs text-error-500">{sel.error}</p>{/if}
</div>
