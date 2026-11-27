import { mount } from "svelte";
import "../app.css";
import Workspace from "../lib/components/workspace/Workspace.svelte";
import McpApp from "./McpApp.svelte";
import { workspaceSummary } from "./summary";

mount(McpApp, {
  target: document.getElementById("app")!,
  props: { name: "anyfield-workspace", toolName: "workspace", tool: Workspace, summary: workspaceSummary },
});
