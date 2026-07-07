/**
 * Windowed NUFFT recon in Niivue (4D NIfTI: frame 0 magnitude, frame 1 phase).
 */

import {
    Niivue,
    SLICE_TYPE,
    MULTIPLANAR_TYPE,
    SHOW_RENDER,
} from 'https://unpkg.com/@niivue/niivue@0.65.0/dist/index.js';
import {
    installFrameAwareContrastDrag,
    syncVolumeClimsToCurrent4DFrame,
    volumeIs4D,
} from '../../hist_panel/histogram-clim-panel.js';

function volumeFrameCount(vol) {
    if (vol.nFrame4D != null && vol.nFrame4D > 1) return vol.nFrame4D;
    const d = vol.hdr?.dims;
    return d && d[4] > 1 ? d[4] : 1;
}

/** NIfTI dim[3] (z); 2D recon uses nz=1 — use axial view, not multiplanar. */
function volumeNz(vol) {
    const d = vol.hdr?.dims;
    if (!d || d.length < 4) return 1;
    const nz = d[3] | 0;
    return nz > 0 ? nz : 1;
}

async function waitForVolumeImg(vol, maxMs = 10000) {
    const t0 = performance.now();
    while (performance.now() - t0 < maxMs) {
        if (vol?.img?.length > 0) return true;
        await new Promise((r) => requestAnimationFrame(r));
    }
    return false;
}

export class SeqCheckNiivue {
    /**
     * @param {HTMLElement} containerEl
     * @param {{ modeEl?: HTMLElement | null, prevBtn?: HTMLButtonElement | null, nextBtn?: HTMLButtonElement | null }} [nav]
     */
    constructor(containerEl, nav = {}) {
        this.containerEl = containerEl;
        this._frameModeEl = nav.modeEl ?? null;
        this._prevBtn = nav.prevBtn ?? null;
        this._nextBtn = nav.nextBtn ?? null;
        this.nv = null;
        this._canvasEl = null;
        this._blobUrl = null;
        this._keyCleanup = null;
        this._navCleanup = null;
        this._frameLabel = null;
        this._lastNz = 1;
        this._curFrame = 0;
        this._activeVol = null;
    }

    _revokeBlob() {
        if (this._blobUrl) {
            try {
                URL.revokeObjectURL(this._blobUrl);
            } catch (_) {
                /* ignore */
            }
            this._blobUrl = null;
        }
    }

    _unbindKeys() {
        if (this._keyCleanup) {
            try {
                this._keyCleanup();
            } catch (_) {
                /* ignore */
            }
            this._keyCleanup = null;
        }
    }

    _unbindNav() {
        if (this._navCleanup) {
            try {
                this._navCleanup();
            } catch (_) {
                /* ignore */
            }
            this._navCleanup = null;
        }
    }

    _setNavEnabled(enabled) {
        if (!enabled) {
            if (this._prevBtn) this._prevBtn.disabled = true;
            if (this._nextBtn) this._nextBtn.disabled = true;
            return;
        }
        this._updateNavButtons();
    }

    _updateNavButtons() {
        const vol = this._activeVol ?? this.nv?.volumes?.[0];
        const enabled = !!(vol && volumeIs4D(vol) && volumeFrameCount(vol) > 1);
        if (!this._prevBtn && !this._nextBtn) return;
        if (!enabled) {
            if (this._prevBtn) this._prevBtn.disabled = true;
            if (this._nextBtn) this._nextBtn.disabled = true;
            return;
        }
        const n = volumeFrameCount(vol);
        if (this._prevBtn) this._prevBtn.disabled = this._curFrame <= 0;
        if (this._nextBtn) this._nextBtn.disabled = this._curFrame >= n - 1;
    }

    _updateFrameLabel(frameIdx) {
        this._curFrame = frameIdx;
        if (this._frameModeEl) {
            this._frameModeEl.textContent = frameIdx === 0 ? 'magnitude' : 'phase';
        }
        this._updateNavButtons();
        if (!this._frameLabel) return;
        const thin = this._lastNz <= 1;
        const viewHint = thin ? 'axial · V → 3D' : 'multiplanar + 3D · V';
        this._frameLabel.textContent = viewHint;
    }

    /** nz=1: full axial slice (Niivue’s 2D mode). nz>1: multiplanar grid + render. */
    _applyViewForVolume(vol) {
        if (!this.nv || !vol) return;
        const nz = volumeNz(vol);
        this._lastNz = nz;
        try {
            if (nz <= 1) {
                this.nv.opts.multiplanarShowRender = SHOW_RENDER.NEVER;
                this.nv.setSliceType(SLICE_TYPE.AXIAL);
            } else {
                this.nv.opts.multiplanarShowRender = SHOW_RENDER.ALWAYS;
                this.nv.setSliceType(SLICE_TYPE.MULTIPLANAR);
                this.nv.setMultiplanarLayout(MULTIPLANAR_TYPE.GRID);
            }
        } catch (e) {
            console.warn('[seq_check] view setup failed:', e);
        }
    }

    _resetSceneView() {
        if (!this.nv?.scene) return;
        if (this.nv.scene.crosshairPos) {
            this.nv.scene.crosshairPos = [0.5, 0.5, 0.5];
        }
        const p = this.nv.scene.pan2Dxyzmm;
        if (p && p.length >= 4) {
            p[0] = 0;
            p[1] = 0;
            p[2] = 0;
            p[3] = 0.9;
        }
    }

    async _refreshNvLayout() {
        await new Promise((r) => requestAnimationFrame(r));
        await new Promise((r) => requestAnimationFrame(r));
        if (!this.nv) return;
        try {
            if (typeof this.nv.resize === 'function') {
                this.nv.resize();
            } else if (typeof this.nv.resizeListener === 'function') {
                this.nv.resizeListener();
            }
        } catch (_) {
            /* ignore */
        }
        this._resetSceneView();
        this.nv.drawScene?.();
    }

    async _ensureNv() {
        if (this.nv) return;
        if (!this.containerEl) return;

        this.containerEl.innerHTML = '';
        this.containerEl.tabIndex = 0;
        this.containerEl.style.outline = 'none';

        const label = document.createElement('div');
        label.className = 'seq-check-niivue-hint';
        label.style.cssText =
            'font-size:0.72rem;color:#a9b3da;padding:0.2rem 0.35rem;flex:0 0 auto';
        label.textContent = 'V → 3D render';
        this._frameLabel = label;

        const canvas = document.createElement('canvas');
        canvas.className = 'seq-check-niivue-canvas';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.minHeight = '180px';
        canvas.style.display = 'block';
        canvas.style.flex = '1 1 auto';
        this._canvasEl = canvas;

        const stack = document.createElement('div');
        stack.className = 'seq-check-niivue-stack';
        stack.style.cssText =
            'display:flex;flex-direction:column;height:100%;min-height:0;width:100%';
        stack.appendChild(label);
        stack.appendChild(canvas);
        this.containerEl.appendChild(stack);

        this.nv = new Niivue({
            isResizeCanvas: true,
            logging: false,
            backColor: [0.04, 0.06, 0.12, 1],
            isRadiologicalConvention: false,
            sliceType: SLICE_TYPE.AXIAL,
            multiplanarShowRender: SHOW_RENDER.NEVER,
            show3Dcrosshair: true,
            isOrientCube: true,
        });
        await this.nv.attachToCanvas(canvas);
        installFrameAwareContrastDrag(this.nv);
    }

    _niiBytes(out) {
        if (out.niiB64) {
            return Uint8Array.from(atob(out.niiB64), (c) => c.charCodeAt(0));
        }
        return null;
    }

    _apply4DFrame(vol, frameIdx) {
        const nFr = volumeFrameCount(vol);
        const frame = Math.min(Math.max(0, frameIdx | 0), Math.max(0, nFr - 1));
        if (nFr <= 1) return frame;

        if (typeof this.nv.setFrame4D === 'function' && vol.id != null) {
            this.nv.setFrame4D(vol.id, frame);
        } else {
            vol.frame4D = frame;
        }

        if (volumeIs4D(vol) && vol.img?.length) {
            syncVolumeClimsToCurrent4DFrame(vol, this.nv, frame);
            // Normalized mag / wrapped phase in [0, 1] from Pyodide.
            if (frame === 0) {
                vol.cal_min = 0;
                vol.cal_max = 1;
            }
        } else {
            this.nv.updateGLVolume?.();
            this.nv.drawScene?.();
        }
        return frame;
    }

    _stepFrame(delta) {
        const vol = this._activeVol ?? this.nv?.volumes?.[0];
        if (!vol || !volumeIs4D(vol) || volumeFrameCount(vol) <= 1) return;
        const n = volumeFrameCount(vol);
        const next = Math.min(n - 1, Math.max(0, this._curFrame + delta));
        if (next === this._curFrame) return;
        const frame = this._apply4DFrame(vol, next);
        this._updateFrameLabel(frame);
        this.nv?.drawScene?.();
    }

    _bindMagPhaseFrameKeys(vol) {
        this._unbindKeys();
        this._unbindNav();
        this._activeVol = vol;

        if (!volumeIs4D(vol) || volumeFrameCount(vol) <= 1) {
            this._setNavEnabled(false);
            if (this._frameModeEl) this._frameModeEl.textContent = 'magnitude';
            if (this._frameLabel) this._frameLabel.textContent = '';
            return;
        }

        this._setNavEnabled(true);
        let cur = vol.frame4D ?? 0;
        this._updateFrameLabel(cur);

        const onKey = (e) => {
            if (e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return;
            if (!this.nv?.volumes?.[0]) return;
            e.preventDefault();
            const delta = e.code === 'ArrowRight' ? 1 : -1;
            this._stepFrame(delta);
        };

        this.containerEl.addEventListener('keydown', onKey);
        this._keyCleanup = () => this.containerEl.removeEventListener('keydown', onKey);

        const onPrev = () => this._stepFrame(-1);
        const onNext = () => this._stepFrame(1);
        if (this._prevBtn) {
            this._prevBtn.addEventListener('click', onPrev);
        }
        if (this._nextBtn) {
            this._nextBtn.addEventListener('click', onNext);
        }
        this._navCleanup = () => {
            this._prevBtn?.removeEventListener('click', onPrev);
            this._nextBtn?.removeEventListener('click', onNext);
        };
    }

    async _loadNiftiInNiivue(bytes) {
        await this._ensureNv();
        if (!this.nv) throw new Error('Niivue not initialized');

        this._revokeBlob();
        this._blobUrl = URL.createObjectURL(
            new Blob([bytes], { type: 'application/octet-stream' }),
        );

        while (this.nv.volumes?.length) {
            this.nv.removeVolume(this.nv.volumes[0]);
        }

        const added = await this.nv.addVolumesFromUrl([
            {
                url: this._blobUrl,
                name: 'recon_window.nii.gz',
                colormap: 'gray',
                opacity: 1,
            },
        ]);

        const vol = added?.[0] ?? this.nv.volumes?.[0];
        if (!vol) throw new Error('No volume after load');

        const imgReady = await waitForVolumeImg(vol);
        if (!imgReady) {
            throw new Error('Volume image buffer not ready');
        }

        const hdrFr = vol.hdr?.dims?.[4];
        if ((!vol.nFrame4D || vol.nFrame4D < 2) && hdrFr > 1) {
            vol.nFrame4D = hdrFr;
        }

        this._applyViewForVolume(vol);
        if (volumeNz(vol) <= 1 && typeof this.nv.setSliceMM === 'function') {
            this.nv.setSliceMM(true);
        }
        this._resetSceneView();

        if (volumeIs4D(vol)) {
            const fr = this._apply4DFrame(vol, 0);
            vol.cal_min = 0;
            vol.cal_max = 1;
            this.nv.updateGLVolume?.();
            this._bindMagPhaseFrameKeys(vol);
            this._updateFrameLabel(fr);
            this.containerEl.focus({ preventScroll: true });
        } else {
            vol.cal_min = 0;
            vol.cal_max = 1;
            this._unbindKeys();
            this._unbindNav();
            this._setNavEnabled(false);
            this._activeVol = vol;
            if (this._frameModeEl) this._frameModeEl.textContent = 'magnitude';
            if (this._frameLabel) this._frameLabel.textContent = '';
            this.nv.updateGLVolume?.();
            this.nv.drawScene?.();
        }

        await this._refreshNvLayout();
        setTimeout(() => {
            if (this.nv?.volumes?.[0] === vol) {
                this._applyViewForVolume(vol);
                this._resetSceneView();
                this.nv?.drawScene?.();
            }
        }, 120);
    }

    dispose() {
        this._unbindKeys();
        this._unbindNav();
        this._setNavEnabled(false);
        this._activeVol = null;
        this._revokeBlob();
        if (this.nv) {
            try {
                while (this.nv.volumes?.length) {
                    this.nv.removeVolume(this.nv.volumes[0]);
                }
            } catch (_) {
                /* ignore */
            }
            this.nv = null;
        }
        this._canvasEl = null;
        if (this.containerEl) this.containerEl.innerHTML = '';
        this._frameLabel = null;
    }

    /**
     * @param {{ ok?: boolean, niiPath?: string, niiB64?: string, niiError?: string, nFrame4D?: number, magB64?: string, phaseB64?: string, nx?: number, ny?: number }} out
     */
    async showRecon(out) {
        if (!this.containerEl || !out?.ok) return;

        const bytes = this._niiBytes(out);
        if (bytes?.length) {
            try {
                await this._loadNiftiInNiivue(bytes);
                return;
            } catch (e) {
                console.warn('Niivue NIfTI load failed, canvas fallback:', e, out.niiError || '');
            }
        } else if (out.niiError) {
            console.warn('NIfTI not built:', out.niiError);
        }

        if (out.magB64 && out.nx && out.ny) {
            this._showCanvasFallback(out);
        }
    }

    /** @param {{ magB64?: string, phaseB64?: string, nx?: number, ny?: number }} out */
    _showCanvasFallback(out) {
        const nx = out.nx || 0;
        const ny = out.ny || 0;
        if (!out.magB64 || !nx || !ny) return;

        this._unbindKeys();
        this._revokeBlob();
        this.nv = null;
        this._canvasEl = null;
        this.containerEl.innerHTML = '';

        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:220px;background:#0a0e1a';
        const cap = document.createElement('div');
        cap.style.cssText = 'font-size:0.72rem;color:#a9b3da;padding:0.25rem 0.4rem';
        cap.textContent = 'Niivue unavailable — magnitude (top) / phase (bottom)';
        const canvas = document.createElement('canvas');
        canvas.className = 'seq-check-recon-canvas';
        canvas.style.flex = '1 1 auto';
        canvas.style.width = '100%';
        wrap.appendChild(cap);
        wrap.appendChild(canvas);
        this.containerEl.appendChild(wrap);

        const mag = this._decodeF32(out.magB64);
        const phase = out.phaseB64 ? this._decodeF32(out.phaseB64) : null;
        const w = Math.max(1, canvas.clientWidth || nx);
        const h = Math.max(180, Math.floor(w * 0.55));
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const half = Math.floor(h / 2);
        ctx.fillStyle = '#0a0e1a';
        ctx.fillRect(0, 0, w, h);
        this._blitGray(ctx, mag, nx, ny, 0, 0, w, half);
        if (phase) {
            this._blitGray(ctx, phase, nx, ny, 0, half, w, half);
        }
    }

    _decodeF32(b64) {
        const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    }

    _blitGray(ctx, f32, nx, ny, dx, dy, dw, dh) {
        const off = document.createElement('canvas');
        off.width = nx;
        off.height = ny;
        const octx = off.getContext('2d');
        if (!octx) return;
        const img = octx.createImageData(nx, ny);
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const v = Math.min(255, Math.round(f32[j * nx + i] * 255));
                const p = (j * nx + i) * 4;
                img.data[p] = v;
                img.data[p + 1] = v;
                img.data[p + 2] = v;
                img.data[p + 3] = 255;
            }
        }
        octx.putImageData(img, 0, 0);
        const scale = Math.min(dw / nx, dh / ny);
        const bw = nx * scale;
        const bh = ny * scale;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(off, 0, 0, nx, ny, dx + (dw - bw) / 2, dy + (dh - bh) / 2, bw, bh);
    }
}
