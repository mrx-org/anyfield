// MCP Apps: each one self-contained HTML file (hosts load it into a sandboxed
// iframe that may not fetch scripts or styles), served as a ui:// resource.
// Build one with `APP=fov` or `APP=phantom` (see package.json "build").
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const app = process.env.APP ?? "fov";

export default defineConfig({
  plugins: [svelte(), tailwindcss(), viteSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: { input: `${app}-app.html` },
  },
});
