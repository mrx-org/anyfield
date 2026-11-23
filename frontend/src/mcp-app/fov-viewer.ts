import { mount } from "svelte";
import "../app.css";
import FovViewer from "../lib/components/fov/FovViewer.svelte";
import McpApp from "./McpApp.svelte";
import { fovSummary } from "./summary";

mount(McpApp, {
  target: document.getElementById("app")!,
  props: { name: "anyfield-fov-viewer", toolName: "fov_viewer", tool: FovViewer, summary: fovSummary },
});
