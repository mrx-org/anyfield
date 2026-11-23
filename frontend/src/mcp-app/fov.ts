import { mount } from "svelte";
import "../app.css";
import FovPlanner from "../lib/components/fov/FovPlanner.svelte";
import McpApp from "./McpApp.svelte";
import { fovSummary } from "./summary";

mount(McpApp, {
  target: document.getElementById("app")!,
  props: { name: "anyfield-fov-planner", toolName: "fov_planner", tool: FovPlanner, summary: fovSummary },
});
