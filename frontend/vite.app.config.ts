// MCP Apps: each one self-contained HTML file (hosts load it into a sandboxed
// iframe that may not fetch scripts or styles), served as a ui:// resource.
// One template (mcp-app.html) for all: `APP=<name>` builds src/mcp-app/<name>.ts
// into dist/mcp-app.html. scripts/build-apps.mjs (pnpm build) builds every app and
// renames each to dist/<name>-app.html.
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const app = process.env.APP;
if (!app) throw new Error("Set APP to the MCP App to build, e.g. APP=fov (see scripts/build-apps.mjs)");

/** The template with the app's name in it (written as dist/mcp-app.html; the build
 * script renames it to <name>-app.html). */
function appTemplate(name: string): Plugin {
  return {
    name: "anyfield-app-template",
    transformIndexHtml: { order: "pre", handler: (html) => html.replaceAll("%APP%", name) },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), svelte(), viteSingleFile(), appTemplate(app)],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: { input: "mcp-app.html" },
  },
});
