<script lang="ts">
  // The page's question dialog (lib/dialog.svelte.ts), Skeleton's Dialog; mounted once
  // per page. Enter confirms, Escape or a click outside cancels. `grow` (MCP Apps): while
  // a dialog is open the page is at least as tall as the dialog (and a margin), so that a
  // chat, which sizes the app's iframe to its content, makes room for it; a page that is
  // tall enough stays as it is.
  import X from "@lucide/svelte/icons/x";
  import { Dialog, Portal } from "@skeletonlabs/skeleton-svelte";
  import { m } from "../../paraglide/messages.js";
  import { dialogs } from "../dialog.svelte";

  let { grow = false }: { grow?: boolean } = $props();

  const d = $derived(dialogs.current);
  let text = $state("");
  let field = $state<HTMLInputElement>();
  /** Height of the open dialog (px). */
  let height = $state(0);

  $effect(() => {
    if (!grow || !d || !height) return;
    // + the dialog's padding and border, and the margin around it (p-4 each)
    document.body.style.minHeight = `${height + 72}px`;
    return () => {
      document.body.style.minHeight = "";
    };
  });

  // A new question: its text in the field, focused and selected
  $effect(() => {
    if (!d) return;
    text = d.input ?? "";
    queueMicrotask(() => field?.select());
  });

  const answer = () => d?.resolve(d.input !== undefined ? text : "");
  const cancel = () => d?.resolve(null);
</script>

<Dialog open={!!d} onOpenChange={(e) => !e.open && cancel()}>
  <Portal>
    <Dialog.Backdrop class="fixed inset-0 z-50 bg-white/50 dark:bg-black/50" />
    <Dialog.Positioner class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <Dialog.Content class="card flex w-full max-w-sm flex-col gap-3 border border-border bg-bg p-4 text-sm text-text shadow-xl">
        {#if d}
          <div class="flex flex-col gap-3" bind:clientHeight={height}>
          <header class="flex items-center gap-2">
            <Dialog.Title class="font-semibold">{d.title}</Dialog.Title>
            <Dialog.CloseTrigger class="btn-icon btn-icon-sm hover:preset-tonal ml-auto" aria-label={m.common_close()}>
              <X class="size-4" aria-hidden="true" />
            </Dialog.CloseTrigger>
          </header>
          {#if d.message}<Dialog.Description class="text-muted">{d.message}</Dialog.Description>{/if}
          <!-- No <form>: a sandboxed iframe (MCP App) without allow-forms never submits it -->
          {#if d.input !== undefined}
            <input
              bind:this={field}
              bind:value={text}
              class="input"
              placeholder={d.placeholder}
              aria-label={d.title}
              onkeydown={(e) => {
                if (e.key === "Enter" && !e.isComposing) {
                  e.preventDefault();
                  answer();
                }
              }}
            />
          {/if}
          <div class="flex justify-end gap-2">
            <button type="button" class="btn btn-sm preset-tonal" onclick={cancel}>{m.common_cancel()}</button>
            <button type="button" class="btn btn-sm {d.danger ? 'preset-filled-error-500' : 'preset-filled-primary-500'}" onclick={answer}>
              {d.confirm ?? m.common_ok()}
            </button>
          </div>
          </div>
        {/if}
      </Dialog.Content>
    </Dialog.Positioner>
  </Portal>
</Dialog>
