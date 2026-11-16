// MCP App: one self-contained HTML file (hosts load it into a sandboxed iframe
// that may not fetch scripts or styles), served as resource ui://anyfield/fov-planner.html.
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [svelte(), tailwindcss(), viteSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: { input: "fov-app.html" },
  },
});
