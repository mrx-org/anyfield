import { mount } from "svelte";
import "../app.css";
import FovPlannerCompact from "./FovPlannerCompact.svelte";
import McpApp from "./McpApp.svelte";

mount(McpApp, { target: document.getElementById("app")!, props: { name: "anyfield-fov-planner", tool: FovPlannerCompact } });
