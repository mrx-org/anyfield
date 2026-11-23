import { mount } from "svelte";
import "../app.css";
import FileManager from "../lib/components/files/FileManager.svelte";
import McpApp from "./McpApp.svelte";

mount(McpApp, {
  target: document.getElementById("app")!,
  props: { name: "anyfield-file-manager", toolName: "file_manager", tool: FileManager },
});
