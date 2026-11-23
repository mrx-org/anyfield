<script lang="ts">
  // Upload into the user's files: drop files on the box or click it to pick them.
  // Each file goes straight to the gateway (AnyfieldClient.uploadFile), with its
  // progress; afterwards its name (click: name and hash to the chat) and hash. In a
  // chat the model is told about the uploads too. `onuploaded` fires per file.
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import Upload from "@lucide/svelte/icons/upload";
  import { FileUpload } from "@skeletonlabs/skeleton-svelte";
  import { fileLine, formatSize } from "../../files";
  import type { Selection } from "../../state/selection";
  import FileName from "./FileName.svelte";

  let { sel, onuploaded }: { sel: Selection; onuploaded?: (sha256: string) => void } = $props();

  type Item = { id: number; name: string; size: number; progress: number; sha256?: string; error?: string };
  let items = $state<Item[]>([]);
  let next = 0;

  function accept(files: File[]) {
    for (const file of files) void upload(file);
  }

  async function upload(file: File) {
    const id = next++;
    items = [{ id, name: file.name, size: file.size, progress: 0 }, ...items];
    const item = () => items.find((i) => i.id === id)!;
    try {
      const sha256 = await sel.client.uploadFile(file, (p) => (item().progress = p));
      item().sha256 = sha256;
      item().progress = 1;
      onuploaded?.(sha256);
      const done = items.filter((i) => i.sha256).map((i) => fileLine(i.name, i.sha256!));
      sel.client.transport.setChatContext?.(`Files the user uploaded (name: sha256):\n${done.join("\n")}`).catch(() => {});
    } catch (e) {
      item().error = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<div class="flex flex-col gap-2 text-sm text-text">
  <FileUpload maxFiles={100} onFileAccept={(d) => accept(d.files)}>
    <FileUpload.Dropzone
      class="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded border-2 border-dashed border-border p-4 text-center text-muted hover:border-accent hover:text-text"
    >
      <Upload class="size-6" aria-hidden="true" />
      <span>Dateien hierher ziehen oder klicken zum Auswählen</span>
    </FileUpload.Dropzone>
    <FileUpload.HiddenInput />
  </FileUpload>

  {#if items.length}
    <ul class="flex flex-col gap-1">
      {#each items as item (item.id)}
        <li class="flex flex-col gap-0.5 text-xs">
          <div class="flex items-center gap-2">
            <div class="min-w-0 flex-1">
              {#if item.sha256}
                <FileName client={sel.client} name={item.name} sha256={item.sha256} />
              {:else}
                <span class="truncate">{item.name}</span>
              {/if}
            </div>
            <span class="shrink-0 text-muted">{formatSize(item.size)}</span>
          </div>
          {#if item.error}
            <span class="flex items-center gap-1 text-error-500"><CircleAlert class="size-3" aria-hidden="true" />{item.error}</span>
          {:else if item.sha256}
            <span class="truncate font-mono text-[10px] text-muted">{item.sha256}</span>
          {:else}
            <progress class="progress h-1" value={item.progress} max="1"></progress>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
