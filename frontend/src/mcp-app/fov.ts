import { mount } from "svelte";
import "../app.css";
import FovPlannerCompact from "./FovPlannerCompact.svelte";
import McpApp from "./McpApp.svelte";
import { fovSummary } from "./summary";

mount(McpApp, {
  target: document.getElementById("app")!,
  props: { name: "anyfield-fov-planner", toolName: "fov_planner", tool: FovPlannerCompact, summary: fovSummary },
});
