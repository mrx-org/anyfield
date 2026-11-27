import { mount } from "svelte";
import "../app.css";
import SequenceBrowser from "../lib/components/sequence/SequenceBrowser.svelte";
import McpApp from "./McpApp.svelte";
import { sequenceSummary } from "./summary";

mount(McpApp, {
  target: document.getElementById("app")!,
  props: { name: "anyfield-sequence-browser", toolName: "sequence_browser", tool: SequenceBrowser, summary: sequenceSummary },
});
