import { mount } from "svelte";
import "../app.css";
import PhantomBrowser from "../lib/components/phantom/PhantomBrowser.svelte";
import McpApp from "./McpApp.svelte";
import { phantomSummary } from "./summary";

mount(McpApp, {
  target: document.getElementById("app")!,
  props: { name: "anyfield-phantom-browser", tool: PhantomBrowser, summary: phantomSummary, height: 640 },
});
