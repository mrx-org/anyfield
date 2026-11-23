// Builds every MCP App (one self-contained HTML file each) after the web app:
// one entry per app in src/mcp-app/<name>.ts, out as dist/<name>-app.html.
import { readdirSync, renameSync } from "node:fs";
import { build } from "vite";

const apps = readdirSync(new URL("../src/mcp-app/", import.meta.url))
  .filter((f) => f.endsWith(".ts") && f !== "summary.ts")
  .map((f) => f.slice(0, -3))
  .sort();

for (const app of apps) {
  process.env.APP = app;
  await build({ configFile: "vite.app.config.ts", logLevel: "warn" });
  renameSync("dist/mcp-app.html", `dist/${app}-app.html`);
  console.log(`MCP App ${app} → dist/${app}-app.html`);
}
