/**
 * Small modal to edit cal_min / cal_max (double-click on histogram).
 * @param {{ calMin: number, calMax: number, decimals?: number, title?: string }} opts
 * @returns {Promise<{ calMin: number, calMax: number } | null>}
 */
export function promptClimEdit(opts) {
  const { calMin, calMax, decimals = 2, title = "Intensity window" } = opts;

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "clim-edit-dialog-overlay";
    overlay.innerHTML = `
      <div class="clim-edit-dialog" role="dialog" aria-label="${title}">
        <div class="clim-edit-dialog-title">${title}</div>
        <div class="clim-edit-dialog-fields">
          <label class="clim-edit-field clim-edit-min">
            <span>Min</span>
            <input type="number" step="any" class="clim-edit-in-min" />
          </label>
          <label class="clim-edit-field clim-edit-max">
            <span>Max</span>
            <input type="number" step="any" class="clim-edit-in-max" />
          </label>
        </div>
        <div class="clim-edit-dialog-actions">
          <button type="button" class="btn clim-edit-cancel">Cancel</button>
          <button type="button" class="btn primary clim-edit-ok">Apply</button>
        </div>
      </div>
    `;
    overlay.querySelector(".clim-edit-dialog-title").textContent = title;

    const inMin = overlay.querySelector(".clim-edit-in-min");
    const inMax = overlay.querySelector(".clim-edit-in-max");
    inMin.value = Number(calMin).toFixed(decimals);
    inMax.value = Number(calMax).toFixed(decimals);

    const finish = (ok) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      if (!ok) {
        resolve(null);
        return;
      }
      const mn = parseFloat(inMin.value);
      const mx = parseFloat(inMax.value);
      if (!Number.isFinite(mn) || !Number.isFinite(mx)) {
        resolve(null);
        return;
      }
      resolve({ calMin: mn, calMax: mx });
    };

    const onKey = (e) => {
      if (e.key === "Escape") finish(false);
      if (e.key === "Enter") finish(true);
    };

    overlay.querySelector(".clim-edit-cancel").onclick = () => finish(false);
    overlay.querySelector(".clim-edit-ok").onclick = () => finish(true);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(false);
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    inMin.focus();
    inMin.select();
  });
}
