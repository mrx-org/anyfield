<script lang="ts">
  // The page's notices (lib/toast.ts), Skeleton's Toast; mounted once per page.
  import { Toast } from "@skeletonlabs/skeleton-svelte";
  import { toaster } from "../toast";
</script>

<Toast.Group {toaster}>
  {#snippet children(toast)}
    <Toast {toast} class="card preset-filled-surface-100-900 border border-border text-xs shadow-xl">
      <Toast.Message>
        <Toast.Title class="font-semibold">{toast.title}</Toast.Title>
        {#if toast.description}<Toast.Description class="max-w-72 truncate text-muted">{toast.description}</Toast.Description>{/if}
      </Toast.Message>
    </Toast>
  {/snippet}
</Toast.Group>
