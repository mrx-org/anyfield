/**
 * Paper Plot launcher — isolated from main app bootstrap so a load failure
 * cannot break the scanner or leave a dead header button.
 */

const MODULE_URL = "./paper_plot.js?v=54";

function isProUser() {
  if (typeof window !== "undefined" && window.pro) return true;
  if (typeof window === "undefined" || !window.location?.search) return false;
  return /^1|true|yes$/i.test(new URLSearchParams(window.location.search).get("pro") || "");
}

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
        if (!window.paperPlot) {
          const mod = await import(MODULE_URL);
          window.paperPlot = new mod.PaperPlotModule();
          window.paperPlot.init();
        }
        await window.paperPlot.toggle();
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
