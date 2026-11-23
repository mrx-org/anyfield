import { mount } from "svelte";
import "../app.css";
import FileUpload from "../lib/components/files/FileUpload.svelte";
import McpApp from "./McpApp.svelte";

mount(McpApp, {
  target: document.getElementById("app")!,
  props: { name: "anyfield-file-upload", toolName: "file_upload", tool: FileUpload },
});
