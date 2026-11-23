import { mount } from "svelte";
import "../app.css";
import FileList from "../lib/components/files/FileList.svelte";
import McpApp from "./McpApp.svelte";

mount(McpApp, {
  target: document.getElementById("app")!,
  props: { name: "anyfield-file-list", toolName: "file_list", tool: FileList },
});
