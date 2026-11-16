/// <reference types="vitest/config" />
// Web app (standalone): served by the backend at / and /s/{key}.
// `pnpm dev` proxies /mcp, /files and the OAuth routes to a backend
// (`ANYFIELD_BACKEND`, default: `uv run python -m anyfield` on port 8765).
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const backend = process.env.ANYFIELD_BACKEND ?? "http://127.0.0.1:8765";
const proxied = ["/mcp", "/files", "/authorize", "/token", "/register", "/auth", "/consent", "/.well-known"];

export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: Object.fromEntries(proxied.map((p) => [p, { target: backend, changeOrigin: true }])) },
  test: { environment: "node" },
});
