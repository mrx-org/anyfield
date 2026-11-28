/**
 * 8-channel pTx B1+ on a BIfTI voxel grid.
 *
 * Coil: stadium triangular TxRx head array (Giannakopoulos et al., MRM 2026,
 * doi:10.1002/mrm.70269), conductor centerlines from the published mesh.
 * Field: Biot–Savart of unit loop current, optional 7 T tissue retardation.
 * Output is relative B1+ (median of the CP drive inside the head is 1).
 */

/** 7 T proton frequency and a brain-average permittivity. k is rad/m. */
export const FREQ_HZ = 297.2e6;
export const TISSUE_EPS = 51;
export const TISSUE_K = (2 * Math.PI * FREQ_HZ * Math.sqrt(TISSUE_EPS)) / 299792458;

const R_MIN_MM = 6;
const OUTSIDE_PHASE = -100;

export function wrapDeg(d) {
  let x = d % 360;
  if (x > 180) x -= 360;
  if (x <= -180) x += 360;
  return x;
}

export function cpPhasesDeg(channels) {
  const a0 = channels[0].azimuthDeg;
  return channels.map((ch, i) => (i === 0 ? 0 : wrapDeg(-ch.azimuthDeg + a0)));
}

export function cp2PhasesDeg(channels) {
  const a0 = channels[0].azimuthDeg;
  return channels.map((ch, i) => (i === 0 ? 0 : wrapDeg(-2 * ch.azimuthDeg + 2 * a0)));
}

function worldAt(affine, i, j, k) {
  return [
    affine[0] * i + affine[1] * j + affine[2] * k + affine[3],
    affine[4] * i + affine[5] * j + affine[6] * k + affine[7],
    affine[8] * i + affine[9] * j + affine[10] * k + affine[11],
  ];
}

/**
 * Sum positive frames of a Niivue volume into one density map (x fastest).
 * @returns {{ nx: number, ny: number, nz: number, density: Float32Array, affine: number[] }}
 */
export function densityFromVolume(vol, affine) {
  const hdr = vol?.hdr || vol?.header || {};
  const dims = hdr.dims || vol.dims;
  if (!dims || !vol?.img) throw new Error("Phantom volume has no voxel data");
  const nx = dims[1] | 0;
  const ny = dims[2] | 0;
  const nz = dims[3] | 0;
  const rank = dims[0] | 0;
  const nt = rank >= 4 ? Math.max(1, dims[4] | 0) : 1;
  const nxyz = nx * ny * nz;
  let slope = Number(hdr.scl_slope);
  let inter = Number(hdr.scl_inter);
  if (!Number.isFinite(slope) || slope === 0) slope = 1;
  if (!Number.isFinite(inter)) inter = 0;
  const img = vol.img;
  const density = new Float32Array(nxyz);
  const scale = slope !== 1 || inter !== 0;
  for (let t = 0; t < nt; t++) {
    const off = t * nxyz;
    if (off >= img.length) break;
    const n = Math.min(nxyz, img.length - off);
    for (let i = 0; i < n; i++) {
      let v = img[off + i];
      if (scale) v = v * slope + inter;
      if (v > 0 && Number.isFinite(v)) density[i] += v;
    }
  }
  return { nx, ny, nz, density, affine };
}

function chooseStride(nx, ny, nz) {
  const n = nx * ny * nz;
  let stride = 1;
  while (stride < 6 && n / (stride * stride * stride) > 160000) stride++;
  return stride;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[i];
}

function loopSegmentsMm(pointsM) {
  const n = pointsM.length;
  const seg = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const a = pointsM[i];
    const b = pointsM[(i + 1) % n];
    const ax = a[0] * 1000, ay = a[1] * 1000, az = a[2] * 1000;
    const bx = b[0] * 1000, by = b[1] * 1000, bz = b[2] * 1000;
    const o = i * 6;
    seg[o] = bx - ax;
    seg[o + 1] = by - ay;
    seg[o + 2] = bz - az;
    seg[o + 3] = (ax + bx) * 0.5;
    seg[o + 4] = (ay + by) * 0.5;
    seg[o + 5] = (az + bz) * 0.5;
  }
  return seg;
}

/**
 * Build per-channel complex B1+ on a coarse lattice of the phantom grid.
 * Yields once per channel so the UI can paint.
 */
export async function buildChannelBasis({
  nx, ny, nz, affine, density, channels, kPerM = 0, onProgress,
}) {
  const stride = chooseStride(nx, ny, nz);
  const nxyz = nx * ny * nz;
  const samples = [];
  const step = Math.max(1, Math.floor(nxyz / 80000));
  for (let i = 0; i < nxyz; i += step) {
    const v = density[i];
    if (v > 0) samples.push(v);
  }
  samples.sort((a, b) => a - b);
  const p98 = percentile(samples, 0.98);
  const thr = p98 > 0 ? p98 * 0.05 : 0;

  const mask = new Uint8Array(nxyz);
  let sx = 0, sy = 0, sz = 0, sw = 0;
  let i0 = nx, i1 = -1, j0 = ny, j1 = -1, k0 = nz, k1 = -1;
  let nMask = 0;
  const comStep = 2;
  for (let k = 0; k < nz; k++) {
    const kbase = k * nx * ny;
    for (let j = 0; j < ny; j++) {
      const row = kbase + j * nx;
      for (let i = 0; i < nx; i++) {
        const idx = row + i;
        if (!(density[idx] > thr)) continue;
        mask[idx] = 1;
        nMask++;
        if (i < i0) i0 = i;
        if (i > i1) i1 = i;
        if (j < j0) j0 = j;
        if (j > j1) j1 = j;
        if (k < k0) k0 = k;
        if (k > k1) k1 = k;
        if ((i % comStep) === 0 && (j % comStep) === 0 && (k % comStep) === 0) {
          const w = density[idx];
          const p = worldAt(affine, i, j, k);
          sx += p[0] * w;
          sy += p[1] * w;
          sz += p[2] * w;
          sw += w;
        }
      }
    }
  }
  if (!(sw > 0) || nMask === 0) {
    throw new Error("Phantom density is empty — load a BIfTI phantom first");
  }
  const com = [sx / sw, sy / sw, sz / sw];

  const cnx = Math.ceil(nx / stride);
  const cny = Math.ceil(ny / stride);
  const cnz = Math.ceil(nz / stride);
  const cn = cnx * cny * cnz;
  const coarseMask = new Uint8Array(cn);
  const half = (stride - 1) / 2;
  const ic0 = Math.max(0, Math.floor(i0 / stride) - 1);
  const ic1 = Math.min(cnx - 1, Math.floor(i1 / stride) + 1);
  const jc0 = Math.max(0, Math.floor(j0 / stride) - 1);
  const jc1 = Math.min(cny - 1, Math.floor(j1 / stride) + 1);
  const kc0 = Math.max(0, Math.floor(k0 / stride) - 1);
  const kc1 = Math.min(cnz - 1, Math.floor(k1 / stride) + 1);

  const xs = new Float32Array(cn);
  const ys = new Float32Array(cn);
  const zs = new Float32Array(cn);
  let comSlot = 0;
  let comDist = Infinity;
  for (let kc = kc0; kc <= kc1; kc++) {
    const k = Math.min(nz - 1, kc * stride + half);
    for (let jc = jc0; jc <= jc1; jc++) {
      const j = Math.min(ny - 1, jc * stride + half);
      for (let ic = ic0; ic <= ic1; ic++) {
        const i = Math.min(nx - 1, ic * stride + half);
        const fi = (k | 0) * nx * ny + (j | 0) * nx + (i | 0);
        if (!mask[fi]) continue;
        const slot = (kc * cny + jc) * cnx + ic;
        coarseMask[slot] = 1;
        const p = worldAt(affine, i, j, k);
        xs[slot] = p[0] - com[0];
        ys[slot] = p[1] - com[1];
        zs[slot] = p[2] - com[2];
        const d = xs[slot] * xs[slot] + ys[slot] * ys[slot] + zs[slot] * zs[slot];
        if (d < comDist) {
          comDist = d;
          comSlot = slot;
        }
      }
    }
  }

  const kPerMm = kPerM / 1000;
  const useWave = kPerMm > 0;
  const re = [];
  const im = [];
  const rmin2 = R_MIN_MM * R_MIN_MM;

  for (let c = 0; c < channels.length; c++) {
    const seg = loopSegmentsMm(channels[c].pointsM);
    const nSeg = seg.length / 6;
    const br = new Float32Array(cn);
    const bi = new Float32Array(cn);
    for (let slot = 0; slot < cn; slot++) {
      if (!coarseMask[slot]) continue;
      const px = xs[slot], py = ys[slot], pz = zs[slot];
      let bxr = 0, bxi = 0, byr = 0, byi = 0;
      for (let s = 0; s < nSeg; s++) {
        const o = s * 6;
        const dlx = seg[o], dly = seg[o + 1], dlz = seg[o + 2];
        const rx = px - seg[o + 3];
        const ry = py - seg[o + 4];
        const rz = pz - seg[o + 5];
        const r2raw = rx * rx + ry * ry + rz * rz;
        const r2 = r2raw < rmin2 ? rmin2 : r2raw;
        const r = Math.sqrt(r2);
        const invR3 = 1 / (r2 * r);
        const cx = (dly * rz - dlz * ry) * invR3;
        const cy = (dlz * rx - dlx * rz) * invR3;
        let cs = 1, sn = 0;
        if (useWave) {
          const kr = kPerMm * r;
          cs = Math.cos(kr);
          sn = Math.sin(kr);
        }
        bxr += cx * cs;
        bxi += -cx * sn;
        byr += cy * cs;
        byi += -cy * sn;
      }
      // B1+ = (Bx - i By) / 2
      br[slot] = 0.5 * (bxr + byi);
      bi[slot] = 0.5 * (bxi - byr);
    }
    re.push(br);
    im.push(bi);
    if (onProgress) onProgress(c + 1, channels.length);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  // Scale so the circularly-polarized drive has median |B1+| = 1 inside the head.
  const phases = cpPhasesDeg(channels);
  const mags = [];
  for (let slot = 0; slot < cn; slot++) {
    if (!coarseMask[slot]) continue;
    let r = 0, ii = 0;
    for (let c = 0; c < channels.length; c++) {
      const ph = phases[c] * Math.PI / 180;
      const wr = Math.cos(ph), wi = Math.sin(ph);
      r += wr * re[c][slot] - wi * im[c][slot];
      ii += wr * im[c][slot] + wi * re[c][slot];
    }
    mags.push(Math.hypot(r, ii));
  }
  mags.sort((a, b) => a - b);
  const median = percentile(mags, 0.5);
  const scale = median > 1e-20 ? 1 / median : 1;
  for (let c = 0; c < channels.length; c++) {
    const br = re[c], bi = im[c];
    for (let slot = 0; slot < cn; slot++) {
      br[slot] *= scale;
      bi[slot] *= scale;
    }
  }

  return {
    nx, ny, nz, stride, cnx, cny, cnz,
    mask, coarseMask, re, im,
    com, comSlot, nMask, thr, kPerM, scale,
  };
}

/** Phases (deg, relative to channel 0) that align every channel at the head center. */
export function centerShimPhasesDeg(basis) {
  const slot = basis.comSlot;
  const a0 = Math.atan2(basis.im[0][slot], basis.re[0][slot]);
  return basis.re.map((br, c) => {
    if (c === 0) return 0;
    const ph = Math.atan2(basis.im[c][slot], br[c]);
    return wrapDeg((-ph + a0) * 180 / Math.PI);
  });
}

/**
 * Weighted sum of the 8 channels → full-grid magnitude and phase (radians).
 * Phase is 0 at the head center. Outside the head, phase is a sentinel (-100)
 * and magnitude is 0.
 */
export function combineBasis(basis, weights, { constantPower = true } = {}) {
  const { nx, ny, nz, stride, cnx, cny, cnz, mask, re, im, comSlot } = basis;
  const nch = Math.min(weights.length, re.length);
  const nxyz = nx * ny * nz;
  let power = 0;
  for (let c = 0; c < nch; c++) power += weights[c].mag * weights[c].mag;
  const ps = constantPower && power > 0 ? Math.sqrt(nch / power) : 1;
  const wr = new Float32Array(nch);
  const wi = new Float32Array(nch);
  for (let c = 0; c < nch; c++) {
    const ph = (weights[c].phaseDeg || 0) * Math.PI / 180;
    const m = (weights[c].mag || 0) * ps;
    wr[c] = m * Math.cos(ph);
    wi[c] = m * Math.sin(ph);
  }

  const cn = cnx * cny * cnz;
  const cre = new Float32Array(cn);
  const cim = new Float32Array(cn);
  for (let slot = 0; slot < cn; slot++) {
    if (!basis.coarseMask[slot]) continue;
    let r = 0, ii = 0;
    for (let c = 0; c < nch; c++) {
      r += wr[c] * re[c][slot] - wi[c] * im[c][slot];
      ii += wr[c] * im[c][slot] + wi[c] * re[c][slot];
    }
    cre[slot] = r;
    cim[slot] = ii;
  }

  const phi0 = Math.atan2(cim[comSlot] || 0, cre[comSlot] || 0);
  const c0 = Math.cos(-phi0), s0 = Math.sin(-phi0);
  for (let slot = 0; slot < cn; slot++) {
    if (!basis.coarseMask[slot]) continue;
    const r = cre[slot], ii = cim[slot];
    cre[slot] = r * c0 - ii * s0;
    cim[slot] = r * s0 + ii * c0;
  }

  const mag = new Float32Array(nxyz);
  const phase = new Float32Array(nxyz);
  phase.fill(OUTSIDE_PHASE);
  const half = (stride - 1) / 2;
  const inv = 1 / stride;
  const umax = cnx - 1, vmax = cny - 1, wmax = cnz - 1;
  let sum = 0, sum2 = 0, n = 0, peak = 0;
  const pct = [];
  for (let k = 0; k < nz; k++) {
    let kc = Math.round((k - half) * inv);
    if (kc < 0) kc = 0;
    else if (kc > wmax) kc = wmax;
    const kbase = k * nx * ny;
    const kOff = kc * cny;
    for (let j = 0; j < ny; j++) {
      let jc = Math.round((j - half) * inv);
      if (jc < 0) jc = 0;
      else if (jc > vmax) jc = vmax;
      const row = kbase + j * nx;
      const jOff = (kOff + jc) * cnx;
      for (let i = 0; i < nx; i++) {
        const idx = row + i;
        if (!mask[idx]) continue;
        let ic = Math.round((i - half) * inv);
        if (ic < 0) ic = 0;
        else if (ic > umax) ic = umax;
        const slot = jOff + ic;
        const r = cre[slot];
        const ii = cim[slot];
        const m = Math.hypot(r, ii);
        mag[idx] = m;
        phase[idx] = Math.atan2(ii, r);
        sum += m;
        sum2 += m * m;
        n++;
        if (m > peak) peak = m;
        if ((n & 31) === 0) pct.push(m);
      }
    }
  }
  pct.sort((a, b) => a - b);
  const mean = n ? sum / n : 0;
  const variance = n ? Math.max(0, sum2 / n - mean * mean) : 0;
  const cov = mean > 1e-8 ? Math.sqrt(variance) / mean : 0;
  return {
    mag,
    phase,
    mean,
    cov,
    peak,
    p98: percentile(pct, 0.98) || peak || 1,
    n,
  };
}

export const OUTSIDE_PHASE_SENTINEL = OUTSIDE_PHASE;
