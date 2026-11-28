import { mount } from "svelte";
import "../app.css";
import History from "../lib/components/history/History.svelte";
import McpApp from "./McpApp.svelte";

mount(McpApp, {
  target: document.getElementById("app")!,
  props: { name: "anyfield-history", toolName: "history", tool: History },
});
