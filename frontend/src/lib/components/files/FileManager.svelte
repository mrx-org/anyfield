<script lang="ts">
  // The file manager: the upload above the list of the user's files. An upload
  // reloads the list.
  import type { Selection } from "../../state/selection";
  import FileList from "./FileList.svelte";
  import FileUpload from "./FileUpload.svelte";

  let { sel }: { sel: Selection } = $props();

  let reload = $state(0);
</script>

<div class="flex min-h-0 min-w-0 flex-col gap-3 p-1">
  <FileUpload {sel} onuploaded={() => reload++} />
  <FileList {sel} {reload} />
</div>
