import { mount } from "svelte";
import "../app.css";
import PhantomPreview from "../lib/components/phantom/PhantomPreview.svelte";
import McpApp from "./McpApp.svelte";
import { previewSummary } from "./summary";

mount(McpApp, {
  target: document.getElementById("app")!,
  props: { name: "anyfield-phantom-preview", toolName: "phantom_preview", tool: PhantomPreview, summary: previewSummary },
});
