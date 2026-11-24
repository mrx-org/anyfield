/**
 * Paper Plot launcher — isolated from main app bootstrap so a load failure
 * cannot break the scanner or leave a dead header button.
 */

import { isProUser } from "../pro_mode.js";

const MODULE_URL = "./paper_plot.js?v=54";

/** Lazily constructed on first launch; the module is only fetched on click. */
let paperPlot = null;

function bindLaunchButton() {
  const btn = document.getElementById("paper-plot-btn");
  if (!btn || !isProUser()) return;
  if (btn.dataset.paperPlotBound === "1") return;
  btn.dataset.paperPlotBound = "1";

  btn.addEventListener(
    "click",
    async (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.disabled = true;
      try {
        if (!paperPlot) {
          const mod = await import(MODULE_URL);
          paperPlot = new mod.PaperPlotModule();
          paperPlot.init();
        }
        await paperPlot.toggle();
      } catch (err) {
        console.error("[PaperPlot] launch failed:", err);
        alert(`Paper Plot failed to open.\n\n${err?.message || err}\n\nSee browser console (F12) for details.`);
      } finally {
        btn.disabled = false;
      }
    },
    true
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bindLaunchButton);
} else {
  bindLaunchButton();
}
