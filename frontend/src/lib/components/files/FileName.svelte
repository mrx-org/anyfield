<script lang="ts">
  // A file's name as a button: in a chat it sends `"name": <sha256>` there (so the
  // user and the AI get the hash without a copy button); elsewhere it copies that line.
  // A notice bottom right (Toaster) says it worked, or why not.
  import type { AnyfieldClient } from "../../client/anyfield";
  import { fileLine } from "../../files";
  import { toaster } from "../../toast";

  let { client, name, sha256 }: { client: AnyfieldClient; name: string; sha256: string } = $props();

  const chat = $derived(!!client.transport.sendToChat);

  async function hand() {
    const line = fileLine(name, sha256);
    try {
      if (client.transport.sendToChat) await client.transport.sendToChat(line);
      else await navigator.clipboard.writeText(line);
      toaster.success({ title: chat ? "In den Chat gesendet" : "Kopiert", description: line });
    } catch (e) {
      toaster.error({ title: chat ? "Nicht gesendet" : "Nicht kopiert", description: e instanceof Error ? e.message : String(e) });
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
</button>
