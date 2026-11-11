import { NVImage, NVMesh } from "https://unpkg.com/@niivue/niivue@0.65.0/dist/index.js";
import {
  TISSUE_K,
  OUTSIDE_PHASE_SENTINEL,
  buildChannelBasis,
  centerShimPhasesDeg,
  combineBasis,
  cpPhasesDeg,
  cp2PhasesDeg,
  densityFromVolume,
  wrapDeg,
} from "./ptx_b1.js";

const COLORS = ["#5eead4", "#67e8f9", "#93c5fd", "#c4b5fd", "#f0abfc", "#fda4af", "#fdba74", "#fde047"];
const CX = 110;
const CY = 110;
const RING = 74;
const COIL_TUBE_MM = 3;
const COIL_TUBE_SIDES = 6;
/** How far from the current slice a coil triangle still draws. The 3D panel shows the whole array. */
const COIL_SLICE_MM = 6;

function hexRgba(hex) {
  const n = parseInt(hex.slice(1), 16);
  return new Uint8Array([(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]);
}

function v3norm(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

function v3cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Closed-loop tube in world mm. Coil points are meters; `com` is the head center in mm. */
function coilTube(pointsM, com, radius, sides) {
  const n = pointsM.length;
  const centers = pointsM.map((p) => [p[0] * 1000 + com[0], p[1] * 1000 + com[1], p[2] * 1000 + com[2]]);
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < n; i++) {
    const a = centers[i];
    const b = centers[(i + 1) % n];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const plane = v3norm([nx, ny, nz]);
  const pts = new Float32Array(n * sides * 3);
  const tris = new Uint32Array(n * sides * 6);
  let tp = 0;
  let tt = 0;
  for (let i = 0; i < n; i++) {
    const prev = centers[(i - 1 + n) % n];
    const next = centers[(i + 1) % n];
    const tangent = v3norm([next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]]);
    const dot = plane[0] * tangent[0] + plane[1] * tangent[1] + plane[2] * tangent[2];
    let normal = v3norm([
      plane[0] - tangent[0] * dot,
      plane[1] - tangent[1] * dot,
      plane[2] - tangent[2] * dot,
    ]);
    if (!Number.isFinite(normal[0])) {
      const ref = Math.abs(tangent[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      normal = v3norm(v3cross(tangent, ref));
    }
    const binormal = v3norm(v3cross(tangent, normal));
    for (let s = 0; s < sides; s++) {
      const ang = (s / sides) * Math.PI * 2;
      const c = Math.cos(ang) * radius;
      const sn = Math.sin(ang) * radius;
      const o = centers[i];
      pts[tp++] = o[0] + normal[0] * c + binormal[0] * sn;
      pts[tp++] = o[1] + normal[1] * c + binormal[1] * sn;
      pts[tp++] = o[2] + normal[2] * c + binormal[2] * sn;
    }
  }
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    for (let s = 0; s < sides; s++) {
      const s2 = (s + 1) % sides;
      const a = i * sides + s;
      const b = i * sides + s2;
      const c = i2 * sides + s;
      const d = i2 * sides + s2;
      tris[tt++] = a; tris[tt++] = c; tris[tt++] = b;
      tris[tt++] = b; tris[tt++] = c; tris[tt++] = d;
    }
  }
  return { pts, tris };
}

/**
 * Left-sidebar pTx steering for the 8-channel stadium triangular array.
 * Magnitude and phase of the combined B1+ are shown on the preview viewers.
 */
export class PtxPanel {
  constructor(nvMod) {
    this.nvMod = nvMod;
    this.root = null;
    this.channels = [];
    this.mags = [];
    this.phases = [];
    this.constantPower = true;
    this.tissuePhase = true;
    this.preset = "cp";
    this.selected = 0;
    this.active = false;
    this.ownsPreview = false;
    this.weOpenedCompare = false;
    this.basis = null;
    this.basisKey = "";
    this._building = null;
    this._pendingShow = null;
    this._showing = false;
    this._drag = null;
    this.showCoil = true;
    this.coilMeshes = null;
    this._coilKey = "";
    this._meshClip = null;
  }

  mount(root) {
    this.root = root;
    root.innerHTML = `
      <div class="ptx-panel">
        <p class="ptx-note">8Tx stadium triangular head array
          (<a href="https://doi.org/10.1002/mrm.70269" target="_blank" rel="noopener">MRM 2026</a>).
          Magnitude and phase relative to Tx1, drawn on the loaded BIfTI grid.</p>
        <div class="ptx-presets" role="group" aria-label="Drive presets">
          <button type="button" data-preset="cp" title="Circularly polarized, phase = −azimuth">CP</button>
          <button type="button" data-preset="center" title="Align every channel at the head center">Center</button>
          <button type="button" data-preset="cp2" title="Second-order CP, null near the center">CP2</button>
          <button type="button" data-preset="equal" title="All phases equal">0°</button>
        </div>
        <div class="ptx-ring-wrap">
          <svg id="ptx-ring" viewBox="0 0 220 220" role="img" aria-label="Eight transmit channels around the head"></svg>
        </div>
        <div class="ptx-options">
          <label><input type="checkbox" id="ptx-power" checked> Constant transmit power</label>
          <label title="Retarded phase at 7 T in brain tissue. Off is quasi-static."><input type="checkbox" id="ptx-wave" checked> 7 T tissue phase</label>
          <label title="Draw the eight loops on the phantom viewer"><input type="checkbox" id="ptx-coil" checked> Show coil</label>
        </div>
        <div class="ptx-channels" id="ptx-channels"></div>
        <div class="ptx-stats" id="ptx-stats">CoV —</div>
        <div class="ptx-status" id="ptx-status">Load a BIfTI phantom, then open this tab.</div>
      </div>
    `;
    this.statsEl = root.querySelector("#ptx-stats");
    this.statusEl = root.querySelector("#ptx-status");
    this.svg = root.querySelector("#ptx-ring");
    root.querySelectorAll(".ptx-presets button").forEach((btn) => {
      btn.addEventListener("click", () => this.applyPreset(btn.dataset.preset));
    });
    root.querySelector("#ptx-power").addEventListener("change", (e) => {
      this.constantPower = e.target.checked;
      this.scheduleRedraw();
    });
    root.querySelector("#ptx-wave").addEventListener("change", (e) => {
      this.tissuePhase = e.target.checked;
      this.basis = null;
      this.basisKey = "";
      if (this.active) this.refresh();
    });
    root.querySelector("#ptx-coil").addEventListener("change", (e) => {
      this.showCoil = e.target.checked;
      this.updateCoilMeshes();
    });
    this.svg.addEventListener("pointerdown", (e) => this._onPointerDown(e));
    this.svg.addEventListener("dblclick", (e) => {
      const g = e.target.closest?.("[data-ch]");
      if (!g) return;
      e.preventDefault();
      this.solo(Number(g.dataset.ch));
    });
    this._loadCoil();
  }

  async _loadCoil() {
    try {
      const url = new URL("./stadium_triangular_8tx.json", import.meta.url);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Coil geometry HTTP ${res.status}`);
      const doc = await res.json();
      this.channels = doc.channels || [];
      this.mags = this.channels.map(() => 1);
      this.phases = cpPhasesDeg(this.channels);
      this._renderChannels();
      this._renderRing();
      this._markPreset("cp");
      if (this.active) this.refresh();
    } catch (e) {
      this.setStatus(e.message || String(e), true);
    }
  }

  _renderChannels() {
    const host = this.root.querySelector("#ptx-channels");
    host.innerHTML = "";
    this.channels.forEach((ch, i) => {
      const row = document.createElement("div");
      row.className = "ptx-ch" + (i === this.selected ? " selected" : "");
      row.style.setProperty("--ch", COLORS[i % COLORS.length]);
      row.innerHTML = `
        <button type="button" class="ptx-solo" title="This channel only" data-solo="${i}">${ch.id}</button>
        <div class="ptx-ch-name">Tx${ch.id}<small>${ch.label}</small></div>
        <input type="range" class="ptx-mag" min="0" max="1" step="0.01" value="${this.mags[i]}" aria-label="Tx${ch.id} magnitude" title="Magnitude">
        <span class="ptx-read ptx-mag-read">${Number(this.mags[i]).toFixed(2)}</span>
        <input type="range" class="ptx-ph" min="-180" max="180" step="1" value="${this.phases[i]}" ${i === 0 ? "disabled" : ""} aria-label="Tx${ch.id} relative phase" title="Phase relative to Tx1">
        <span class="ptx-read ptx-ph-read">${Math.round(this.phases[i])}°</span>
      `;
      row.querySelector("[data-solo]").addEventListener("click", () => this.solo(i));
      row.querySelector(".ptx-mag").addEventListener("input", (e) => {
        this.mags[i] = Number(e.target.value);
        row.querySelector(".ptx-mag-read").textContent = this.mags[i].toFixed(2);
        this.preset = "";
        this._markPreset("");
        this._renderRing();
        this.scheduleRedraw();
      });
      const ph = row.querySelector(".ptx-ph");
      ph.addEventListener("input", (e) => {
        if (i === 0) return;
        this.phases[i] = Number(e.target.value);
        row.querySelector(".ptx-ph-read").textContent = `${Math.round(this.phases[i])}°`;
        this.preset = "";
        this._markPreset("");
        this.selected = i;
        this._renderRing();
        this.scheduleRedraw();
      });
      row.addEventListener("pointerdown", () => { this.selected = i; this._markSelected(); });
      host.appendChild(row);
    });
  }

  _syncChannelReadouts() {
    const rows = this.root.querySelectorAll(".ptx-ch");
    rows.forEach((row, i) => {
      const mag = row.querySelector(".ptx-mag");
      const ph = row.querySelector(".ptx-ph");
      if (mag && document.activeElement !== mag) mag.value = String(this.mags[i]);
      if (ph && document.activeElement !== ph) ph.value = String(this.phases[i]);
      row.querySelector(".ptx-mag-read").textContent = Number(this.mags[i]).toFixed(2);
      row.querySelector(".ptx-ph-read").textContent = `${Math.round(this.phases[i])}°`;
      row.classList.toggle("selected", i === this.selected);
    });
  }

  _markSelected() {
    this.root.querySelectorAll(".ptx-ch").forEach((row, i) => {
      row.classList.toggle("selected", i === this.selected);
    });
    this._renderRing();
  }

  _markPreset(name) {
    this.preset = name;
    this.root.querySelectorAll(".ptx-presets button").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.preset === name);
    });
  }

  _renderRing() {
    if (!this.svg || !this.channels.length) return;
    const parts = [];
    parts.push(`<circle cx="${CX}" cy="${CY}" r="28" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1"/>`);
    parts.push(`<text x="${CX}" y="18" text-anchor="middle" fill="#a9b3da" font-size="11">A</text>`);
    parts.push(`<text x="${CX}" y="214" text-anchor="middle" fill="#a9b3da" font-size="11">P</text>`);
    parts.push(`<text x="12" y="${CY + 4}" text-anchor="middle" fill="#a9b3da" font-size="11">L</text>`);
    parts.push(`<text x="208" y="${CY + 4}" text-anchor="middle" fill="#a9b3da" font-size="11">R</text>`);
    this.channels.forEach((ch, i) => {
      const phi = ch.azimuthDeg * Math.PI / 180;
      const x = CX - Math.cos(phi) * RING;
      const y = CY + Math.sin(phi) * RING;
      const rad = this.phases[i] * Math.PI / 180;
      const nx = x - Math.sin(rad) * 12;
      const ny = y - Math.cos(rad) * 12;
      const col = COLORS[i % COLORS.length];
      const mag = Math.max(0, Math.min(1, this.mags[i]));
      const sw = i === this.selected ? 2.5 : 1.25;
      parts.push(`<g data-ch="${i}" style="cursor:${i === 0 ? "default" : "grab"}">`);
      parts.push(`<circle cx="${x}" cy="${y}" r="16" fill="rgba(10,14,26,0.9)" stroke="${col}" stroke-width="${sw}"/>`);
      parts.push(`<circle cx="${x}" cy="${y}" r="${(3 + 10 * mag).toFixed(2)}" fill="${col}" fill-opacity="${0.25 + 0.55 * mag}" stroke="none" pointer-events="none"/>`);
      parts.push(`<line x1="${x}" y1="${y}" x2="${nx.toFixed(2)}" y2="${ny.toFixed(2)}" stroke="${col}" stroke-width="2" stroke-linecap="round" pointer-events="none"/>`);
      parts.push(`<text x="${x}" y="${y + 3.5}" text-anchor="middle" fill="#e8ecff" font-size="9" pointer-events="none">${ch.id}</text>`);
      parts.push(`</g>`);
    });
    this.svg.innerHTML = parts.join("");
  }

  _onPointerDown(e) {
    const g = e.target.closest?.("[data-ch]");
    if (!g) return;
    const i = Number(g.dataset.ch);
    this.selected = i;
    this._markSelected();
    if (i === 0) return;
    this._drag = i;
    this._onMove = (ev) => this._setPhaseFromEvent(i, ev);
    this._onUp = () => {
      window.removeEventListener("pointermove", this._onMove);
      window.removeEventListener("pointerup", this._onUp);
      this._drag = null;
    };
    window.addEventListener("pointermove", this._onMove);
    window.addEventListener("pointerup", this._onUp);
    this._setPhaseFromEvent(i, e);
  }

  _setPhaseFromEvent(i, e) {
    const g = this.svg.querySelector(`[data-ch="${i}"] circle`);
    if (!g) return;
    const r = g.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    this.phases[i] = wrapDeg(Math.atan2(-dx, -dy) * 180 / Math.PI);
    this.preset = "";
    this._markPreset("");
    this._syncChannelReadouts();
    this._renderRing();
    this.scheduleRedraw();
  }

  applyPreset(name) {
    if (!this.channels.length) return;
    this.mags = this.channels.map(() => 1);
    if (name === "cp") this.phases = cpPhasesDeg(this.channels);
    else if (name === "cp2") this.phases = cp2PhasesDeg(this.channels);
    else if (name === "equal") this.phases = this.channels.map(() => 0);
    else if (name === "center") {
      if (!this.basis) {
        this.setStatus("Center shim waits for the B1 maps.");
        this.refresh();
        this._pendingPreset = "center";
        return;
      }
      this.phases = centerShimPhasesDeg(this.basis);
    }
    this.phases[0] = 0;
    this._markPreset(name);
    this._syncChannelReadouts();
    this._renderRing();
    this.scheduleRedraw();
  }

  solo(i) {
    this.mags = this.mags.map((_, j) => (j === i ? 1 : 0));
    this.selected = i;
    this.preset = "";
    this._markPreset("");
    this._syncChannelReadouts();
    this._renderRing();
    this.scheduleRedraw();
  }

  setStatus(text, isError = false) {
    if (!this.statusEl) return;
    this.statusEl.textContent = text || "";
    this.statusEl.classList.toggle("error", !!isError);
  }

  onShow() {
    this.active = true;
    this.refresh();
  }

  onHide() {
    if (!this.active && !this.ownsPreview) return;
    this.active = false;
    this.ownsPreview = false;
    this._pendingShow = null;
    if (this.weOpenedCompare && window.scanCompare?.deactivate) {
      window.scanCompare.deactivate();
      this.weOpenedCompare = false;
    }
    this.nvMod?.updatePreviewFromSelection?.();
  }

  notifyVolumes() {
    const key = this._volumeKey();
    if (key === this._volKey) return;
    this._volKey = key;
    this.basis = null;
    this.basisKey = "";
    this._clearCoilMeshes();
    if (this.active) this.refresh();
  }

  _volumeKey() {
    const info = this.nvMod?.getReferenceVolumeInfoForFovSync?.();
    const vol = info?.vol;
    if (!vol?.img || !info.dim3) return "";
    const d = info.dim3.join("x");
    return `${vol.id || vol.name || "vol"}:${d}:${vol.img.length}:${this.tissuePhase ? "k" : "0"}`;
  }

  scheduleRedraw() {
    clearTimeout(this._debounce);
    this._debounce = setTimeout(() => {
      if (this.active) this.redraw();
    }, 50);
  }

  async refresh() {
    if (!this.channels.length) return;
    try {
      await this.ensureBasis();
      if (this._pendingPreset === "center" && this.basis) {
        this._pendingPreset = "";
        this.applyPreset("center");
        return;
      }
      await this.redraw();
    } catch (e) {
      console.error(e);
      this.setStatus(e.message || String(e), true);
    }
  }

  async ensureBasis() {
    const key = this._volumeKey();
    if (!key) {
      this.setStatus("Load a BIfTI phantom to map B1+.");
      return;
    }
    if (this.basis && this.basisKey === key) return;
    if (this._building) {
      await this._building;
      if (this.basis && this.basisKey === key) return;
    }
    const info = this.nvMod.getReferenceVolumeInfoForFovSync();
    if (!info?.affine || info.affine.length < 12) {
      throw new Error("Phantom affine is missing");
    }
    const grid = densityFromVolume(info.vol, info.affine);
    this.setStatus("Computing 8-channel B1+ on the phantom grid…");
    const kPerM = this.tissuePhase ? TISSUE_K : 0;
    this._building = buildChannelBasis({
      ...grid,
      channels: this.channels,
      kPerM,
      onProgress: (done, total) => this.setStatus(`Channel ${done} / ${total}`),
    });
    try {
      this.basis = await this._building;
      this.basisKey = key;
      this._focused = false;
      this.updateCoilMeshes();
      this.setStatus("B1+ ready. Drag a knob. Quasi-static model, not full-wave.");
    } finally {
      this._building = null;
    }
  }

  async redraw() {
    if (!this.active || !this.basis) return;
    const weights = this.channels.map((_, i) => ({
      mag: this.mags[i],
      phaseDeg: i === 0 ? 0 : this.phases[i],
    }));
    const field = combineBasis(this.basis, weights, { constantPower: this.constantPower });
    const covPct = (field.cov * 100).toFixed(0);
    if (this.statsEl) {
      this.statsEl.textContent = `CoV ${covPct}% · mean ${field.mean.toFixed(2)} · p98 ${field.p98.toFixed(2)}`;
    }
    this.updateCoilMeshes();
    const affine = this.nvMod.getReferenceVolumeInfoForFovSync().affine;
    const dims = [this.basis.nx, this.basis.ny, this.basis.nz];
    const calMin = Math.max(0.02, field.p98 * 0.04);
    const calMax = Math.max(calMin + 0.05, field.p98);
    this._enqueueShow({ mag: field.mag, phase: field.phase, affine, dims, calMin, calMax });
  }

  _encode(affine, dims, data) {
    const pix = [
      Math.hypot(affine[0], affine[4], affine[8]) || 1,
      Math.hypot(affine[1], affine[5], affine[9]) || 1,
      Math.hypot(affine[2], affine[6], affine[10]) || 1,
    ];
    let bytes = NVImage.createNiftiArray(dims, pix, affine, 16, data);
    if (this.nvMod.setNiftiQform) bytes = this.nvMod.setNiftiQform(bytes, affine, 2);
    return bytes;
  }

  _enqueueShow(job) {
    this._pendingShow = job;
    if (this._showing) return;
    this._showing = true;
    const pump = async () => {
      while (this._pendingShow && this.active) {
        const next = this._pendingShow;
        this._pendingShow = null;
        try {
          await this._showPair(next);
        } catch (e) {
          console.error(e);
          this.setStatus(e.message || String(e), true);
        }
      }
      this._showing = false;
      if (this._pendingShow && this.active) {
        this._showing = true;
        pump();
      }
    };
    pump();
  }

  async _showPair(job) {
    const preview = window.scanPreview;
    const compare = window.scanCompare;
    if (!preview?.loadNiftiBytes || !compare?.ensureInitialized) {
      this.setStatus("Viewers are not ready yet.");
      return;
    }
    if (window.viewManager && window.viewManager.currentMode !== "planning") {
      window.viewManager.setMode("planning");
    }
    const wasActive = !!compare.isActive;
    await compare.ensureInitialized();
    if (!wasActive) this.weOpenedCompare = true;
    if (!this.active) return;
    this.ownsPreview = true;
    if (this._canReplace(preview.nv, job.mag) && this._canReplace(compare.module.nv, job.phase)) {
      this._replaceVolume(preview.nv, job.mag, job.calMin, job.calMax);
      this._replaceVolume(compare.module.nv, job.phase, -Math.PI, Math.PI);
    } else {
      const magBytes = this._encode(job.affine, job.dims, job.mag);
      const phaseBytes = this._encode(job.affine, job.dims, job.phase);
      await preview.loadNiftiBytes(magBytes, "bifti_B1_mag.nii", {
        skipPeerSync: true,
        colormap: "warm",
        calMin: job.calMin,
        calMax: job.calMax,
        colormapType: 1,
        label: "B1+ magnitude",
      });
      await compare.module.loadNiftiBytes(phaseBytes, "bifti_B1_phase.nii", {
        skipPeerSync: true,
        colormap: "hsv",
        calMin: -Math.PI,
        calMax: Math.PI,
        colormapType: 1,
        label: "B1+ phase",
      });
    }
    // Sentinel outside the head stays hidden: transparent below cal_min.
    this._applyCal(preview.nv, job.calMin, job.calMax);
    this._applyCal(compare.module.nv, -Math.PI, Math.PI);
    if (!this._focused) {
      this._focusHead(preview.nv);
      this._focusHead(compare.module.nv);
      this._focused = true;
    }
    preview.nv?.resizeListener?.();
    compare.module.nv?.resizeListener?.();
  }

  _clearCoilMeshes() {
    const nv = this.nvMod?.nv;
    if (nv && this.coilMeshes?.length) {
      for (const mesh of this.coilMeshes) {
        try { nv.removeMesh(mesh); } catch (e) { console.warn(e); }
      }
      if (this._meshClip != null && typeof nv.setMeshThicknessOn2D === "function") {
        nv.setMeshThicknessOn2D(this._meshClip);
      }
    }
    this._meshClip = null;
    this.coilMeshes = null;
    this._coilKey = "";
  }

  updateCoilMeshes() {
    const nv = this.nvMod?.nv;
    if (!this.showCoil || !nv?.gl || !this.basis?.com || !this.channels.length || !nv.volumes?.length) {
      if (this.coilMeshes) {
        this._clearCoilMeshes();
        nv?.drawScene?.();
      }
      return;
    }
    const com = this.basis.com;
    const key = `${com[0].toFixed(2)},${com[1].toFixed(2)},${com[2].toFixed(2)}:${this.channels.length}`;
    if (this._coilKey !== key || !this.coilMeshes) {
      this._clearCoilMeshes();
      if (this._meshClip == null) this._meshClip = nv.opts.meshThicknessOn2D;
      if (typeof nv.setMeshThicknessOn2D === "function") nv.setMeshThicknessOn2D(COIL_SLICE_MM);
      this.coilMeshes = this.channels.map((ch, i) => {
        const { pts, tris } = coilTube(ch.pointsM, com, COIL_TUBE_MM, COIL_TUBE_SIDES);
        const mesh = new NVMesh(pts, tris, `Tx${ch.id} ${ch.label}`, hexRgba(COLORS[i]), 1, true, nv.gl);
        mesh.colorbarVisible = false;
        nv.addMesh(mesh);
        return mesh;
      });
      this._coilKey = key;
    }
    this.coilMeshes.forEach((mesh, i) => {
      const mag = Math.max(0, Math.min(1, this.mags[i] ?? 1));
      mesh.opacity = 0.25 + 0.75 * mag;
    });
    nv.drawScene();
  }

  _canReplace(nv, data) {
    const img = nv?.volumes?.[0]?.img;
    return img instanceof Float32Array && img.length === data?.length;
  }

  _replaceVolume(nv, data, calMin, calMax) {
    const vol = nv.volumes[0];
    vol.img = data;
    vol.cal_min = calMin;
    vol.cal_max = calMax;
    vol.colormapType = 1;
    vol._ptxIndependentCal = true;
    nv.updateGLVolume?.();
  }

  _focusHead(nv) {
    const mm = this.basis?.com;
    if (!nv?.volumes?.[0] || !mm || typeof nv.mm2frac !== "function") return;
    nv.scene.crosshairPos = nv.mm2frac(mm, 0, true);
    nv.drawScene?.();
  }

  _applyCal(nv, calMin, calMax) {
    const vol = nv?.volumes?.[0];
    if (!vol) return;
    vol.cal_min = calMin;
    vol.cal_max = calMax;
    vol.colormapType = 1;
    vol._ptxIndependentCal = true;
    nv.updateGLVolume?.();
    nv.drawScene?.();
  }
}

export { OUTSIDE_PHASE_SENTINEL };
