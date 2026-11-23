// Light or dark, and the page's colours, as reactive state: an MCP App takes both from
// the chat (McpApp.svelte), so they can change while a tool is open. Components that
// cannot use CSS (CodeMirror's theme, NiiVue's WebGL background) read them here.

class Theme {
  /** <html> has the class "dark". */
  dark = $state(true);
  /** Bumped on every change of <html>'s class or style (e.g. the chat's colours). */
  version = $state(0);

  constructor() {
    if (typeof document === "undefined") return;
    const html = document.documentElement;
    const read = () => {
      this.dark = html.classList.contains("dark");
      this.version++;
    };
    read();
    new MutationObserver(read).observe(html, { attributes: true, attributeFilter: ["class", "style"] });
  }
}

export const theme = new Theme();

/** Light or dark for the whole page (Skeleton's pairings follow the class "dark"). */
export function setDark(dark: boolean) {
  const html = document.documentElement;
  html.classList.toggle("dark", dark);
  html.style.colorScheme = dark ? "dark" : "light";
}

/** A CSS colour (also `var(...)`, `light-dark(...)`, oklch) as RGBA in 0..1, for WebGL. */
export function cssRgba(color: string): [number, number, number, number] {
  const probe = document.createElement("div");
  probe.style.cssText = `position:absolute;visibility:hidden;background-color:${color}`;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).backgroundColor;
  probe.remove();
  // A 2D canvas turns any CSS colour into RGB bytes
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return [0, 0, 0, 1];
  ctx.fillStyle = resolved;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255, a / 255];
}
