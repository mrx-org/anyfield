<script lang="ts">
  // The file manager: the upload above the list of the user's files, each in the
  // frame of its own tool (file_upload, file_list). An upload reloads the list.
  import type { Selection } from "../../state/selection";
  import ToolFrame from "../ToolFrame.svelte";
  import FileList from "./FileList.svelte";
  import FileUpload from "./FileUpload.svelte";

  let { sel }: { sel: Selection } = $props();

  let reload = $state(0);
</script>

<div class="flex min-h-0 min-w-0 flex-col gap-2 p-1">
  <ToolFrame name="file_upload"><FileUpload {sel} onuploaded={() => reload++} /></ToolFrame>
  <ToolFrame name="file_list"><FileList {sel} {reload} /></ToolFrame>
</div>
