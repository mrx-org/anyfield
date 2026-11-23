import { mount } from "svelte";
import "../app.css";
import SessionEditor from "../lib/components/session/SessionEditor.svelte";
import McpApp from "./McpApp.svelte";
import { stateSummary } from "./summary";

mount(McpApp, {
  target: document.getElementById("app")!,
  props: { name: "anyfield-session", toolName: "session", tool: SessionEditor, summary: stateSummary },
});
