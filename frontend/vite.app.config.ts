// MCP Apps: each one self-contained HTML file (hosts load it into a sandboxed
// iframe that may not fetch scripts or styles), served as a ui:// resource.
// Build one with `APP=fov`, `APP=fov-viewer`, `APP=phantom`, `APP=phantom-preview`, `APP=session`, `APP=file-upload`, `APP=file-list` or `APP=file-manager` (see package.json "build").
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const app = process.env.APP ?? "fov";

export default defineConfig({
  plugins: [tailwindcss(), svelte(), viteSingleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: { input: `${app}-app.html` },
  },
});
