<script lang="ts">
  // A file's name as a button: in a chat it sends `"name": <sha256>` there (so the
  // user and the AI get the hash without a copy button); elsewhere it copies that line.
  import Check from "@lucide/svelte/icons/check";
  import type { AnyfieldClient } from "../../client/anyfield";
  import { fileLine } from "../../files";

  let { client, name, sha256 }: { client: AnyfieldClient; name: string; sha256: string } = $props();

  let done = $state<string | null>(null);
  let error = $state<string | null>(null);
  const chat = $derived(!!client.transport.sendToChat);

  async function hand() {
    const line = fileLine(name, sha256);
    error = null;
    try {
      if (client.transport.sendToChat) await client.transport.sendToChat(line);
      else await navigator.clipboard.writeText(line);
      done = chat ? "Gesendet" : "Kopiert";
      setTimeout(() => (done = null), 1500);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<button
  type="button"
  class="btn btn-sm preset-tonal max-w-full justify-start"
  title={chat ? "Name und Hash in den Chat senden" : "Name und Hash kopieren"}
  onclick={hand}
>
  <span class="truncate">{name || sha256.slice(0, 12)}</span>
  {#if done}
    <span class="inline-flex shrink-0 items-center gap-0.5 text-xs text-success-500">
      <Check class="size-3" aria-hidden="true" />{done}
    </span>
  {/if}
</button>
{#if error}<span class="text-xs text-error-500">{error}</span>{/if}
