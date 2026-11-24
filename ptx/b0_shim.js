/**
 * Second-order B0 shim insert.
 *
 * Filament model of a head-sized shim set through second order:
 * Z0 (Helmholtz), X/Y (Golay saddles), Z (Maxwell pair),
 * Z², ZX, ZY, X²−Y² and XY. The mapped field is Bz from Biot–Savart,
 * in relative units (each term's 98th percentile inside the head is 1
 * at current 1). Geometry is in metres, centered on the head.
 */

const R = 0.15;
const LOOP_N = 40;
const OUTSIDE = -1e6;

export const B0_OUTSIDE = OUTSIDE;

/** @type {{ id: string, label: string, order: number, loops: { pointsM: number[][], turn: number }[] }[]} */
export const SHIM_CHANNELS = [
  { id: "Z0", label: "Z0", order: 0, loops: helmholtz(R, R / 2) },
  { id: "X", label: "X", order: 1, loops: golay(0) },
  { id: "Y", label: "Y", order: 1, loops: golay(Math.PI / 2) },
  { id: "Z", label: "Z", order: 1, loops: maxwell(R) },
  { id: "Z2", label: "Z²", order: 2, loops: z2Loops(R) },
  { id: "ZX", label: "ZX", order: 2, loops: transverseQuad(0) },
  { id: "ZY", label: "ZY", order: 2, loops: transverseQuad(Math.PI / 2) },
  { id: "X2-Y2", label: "X²−Y²", order: 2, loops: azimuthQuad(0) },
  { id: "XY", label: "XY", order: 2, loops: azimuthQuad(Math.PI / 4) },
];

function norm(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Circle of `radius` metres about `center`, right-handed about `normal`. */
function circle(center, normal, radius, n = LOOP_N) {
  const nn = norm(normal);
  const ref = Math.abs(nn[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = norm(cross(ref, nn));
  const v = cross(nn, u);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    pts.push([
      center[0] + radius * (c * u[0] + s * v[0]),
      center[1] + radius * (c * u[1] + s * v[1]),
      center[2] + radius * (c * u[2] + s * v[2]),
    ]);
  }
  return pts;
}

function loop(pointsM, turn = 1) {
  return { pointsM, turn };
}

/** Uniform Bz. Two coaxial loops, same current. */
function helmholtz(radius, z) {
  return [
    loop(circle([0, 0, z], [0, 0, 1], radius), 1),
    loop(circle([0, 0, -z], [0, 0, 1], radius), 1),
  ];
}

/** Linear Z. Maxwell pair: opposite currents, separation √3 R. */
function maxwell(radius) {
  const z = radius * Math.sqrt(3) / 2;
  return [
    loop(circle([0, 0, z], [0, 0, 1], radius), 1),
    loop(circle([0, 0, -z], [0, 0, 1], radius), -1),
  ];
}

/** On-axis field of a same-current loop pair at ±z, in arbitrary units. */
function loopPairAxis(radius, zLoop, z) {
  const r2 = radius * radius;
  const dz1 = z - zLoop;
  const dz2 = z + zLoop;
  return r2 / Math.pow(r2 + dz1 * dz1, 1.5) + r2 / Math.pow(r2 + dz2 * dz2, 1.5);
}

/**
 * Z². Inner pair sets the curvature; the outer pair is wound to cancel
 * the uniform field at the origin (the ratio is the on-axis Helmholtz
 * formula). Overall sign puts positive current on +2z²−x²−y².
 */
function z2Loops(radius) {
  const inner = 0.40 * radius;
  const outer = 0.95 * radius;
  const k = loopPairAxis(radius, inner, 0) / loopPairAxis(radius, outer, 0);
  return [
    loop(circle([0, 0, inner], [0, 0, 1], radius), -1),
    loop(circle([0, 0, -inner], [0, 0, 1], radius), -1),
    loop(circle([0, 0, outer], [0, 0, 1], radius), k),
    loop(circle([0, 0, -outer], [0, 0, 1], radius), k),
  ];
}

/** Saddle on a cylinder. Arc half-angle `arc`, axial extent z0..z1, centered at phi. */
function saddle(phi, arc, z0, z1, radius) {
  const nArc = 14;
  const nAx = 8;
  const pts = [];
  const phis = [];
  for (let i = 0; i <= nArc; i++) phis.push(phi - arc + (2 * arc * i) / nArc);
  const at = (p, z) => [radius * Math.cos(p), radius * Math.sin(p), z];
  for (let i = 0; i <= nArc; i++) pts.push(at(phis[i], z1));
  const phiEnd = phis[phis.length - 1];
  for (let i = 1; i <= nAx; i++) pts.push(at(phiEnd, z1 + (z0 - z1) * i / nAx));
  for (let i = nArc - 1; i >= 0; i--) pts.push(at(phis[i], z0));
  const phi0 = phis[0];
  for (let i = 1; i < nAx; i++) pts.push(at(phi0, z0 + (z1 - z0) * i / nAx));
  return pts;
}

/**
 * Linear X (phi0=0) or Y (phi0=π/2).
 * Four 120° Golay saddles. The lower pair is wound so the azimuthal
 * current is even in z, and the back pair is reversed so it follows cos φ.
 * A saddle that spans +z and −z cannot do this: its Bz is odd in z.
 */
function golay(phi0) {
  const arc = (120 * Math.PI) / 180 / 2;
  const gap = 0.02;
  const h = 0.11;
  return [
    loop(saddle(phi0, arc, gap, gap + h, R), -1),
    loop(saddle(phi0, arc, -(gap + h), -gap, R), 1),
    loop(saddle(phi0 + Math.PI, arc, gap, gap + h, R), 1),
    loop(saddle(phi0 + Math.PI, arc, -(gap + h), -gap, R), -1),
  ];
}

/**
 * ZX (phi0=0) or ZY (phi0=π/2).
 * Two full-length saddles on opposite sides, opposite current.
 * Bz is odd in z and odd in the transverse axis.
 */
function transverseQuad(phi0) {
  const arc = (120 * Math.PI) / 180 / 2;
  const h = 0.12;
  return [
    loop(saddle(phi0, arc, -h, h, R), 1),
    loop(saddle(phi0 + Math.PI, arc, -h, h, R), -1),
  ];
}

/**
 * X²−Y² (phi0=0) or XY (phi0=π/4).
 * Eight saddles: four azimuths, split above and below so Bz is even in z,
 * with alternating current (cos 2φ).
 */
function azimuthQuad(phi0) {
  const arc = (40 * Math.PI) / 180;
  const gap = 0.015;
  const h = 0.1;
  const loops = [];
  for (let k = 0; k < 4; k++) {
    const phi = phi0 + (k * Math.PI) / 2;
    const sign = k % 2 === 0 ? -1 : 1;
    loops.push(loop(saddle(phi, arc, gap, gap + h, R), sign));
    loops.push(loop(saddle(phi, arc, -(gap + h), -gap, R), -sign));
  }
  return loops;
}

function bzOfLoops(loops, x, y, z) {
  let bz = 0;
  const rmin2 = 4 * 4;
  for (const lp of loops) {
    const pts = lp.pointsM;
    const n = pts.length;
    const turn = lp.turn;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const ax = a[0] * 1000;
      const ay = a[1] * 1000;
      const az = a[2] * 1000;
      const bx = b[0] * 1000;
      const by = b[1] * 1000;
      const bz1 = b[2] * 1000;
      const dlx = bx - ax;
      const dly = by - ay;
      const dlz = bz1 - az;
      const mx = (ax + bx) * 0.5;
      const my = (ay + by) * 0.5;
      const mz = (az + bz1) * 0.5;
      const rx = x - mx;
      const ry = y - my;
      const rz = z - mz;
      const r2raw = rx * rx + ry * ry + rz * rz;
      const r2 = r2raw < rmin2 ? rmin2 : r2raw;
      const inv = 1 / (r2 * Math.sqrt(r2));
      bz += turn * (dlx * ry - dly * rx) * inv;
    }
  }
  return bz;
}

/** Bz (relative, unscaled) of one channel at a point in mm, coil centered at the origin. */
export function channelBz(channel, x, y, z) {
  return bzOfLoops(channel.loops, x, y, z);
}

function chooseStride(nx, ny, nz) {
  const n = nx * ny * nz;
  let stride = 1;
  while (stride < 6 && n / (stride * stride * stride) > 160000) stride++;
  return stride;
}

function worldAt(affine, i, j, k) {
  return [
    affine[0] * i + affine[1] * j + affine[2] * k + affine[3],
    affine[4] * i + affine[5] * j + affine[6] * k + affine[7],
    affine[8] * i + affine[9] * j + affine[10] * k + affine[11],
  ];
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[i];
}

/**
 * Per-channel Bz on the same coarse head lattice the B1 basis uses.
 * Each map is scaled so its 98th percentile of |Bz| inside the head is 1.
 */
export async function buildB0Basis({ nx, ny, nz, affine, density, onProgress }) {
  const stride = chooseStride(nx, ny, nz);
  const nxyz = nx * ny * nz;
  const samples = [];
  const step = Math.max(1, Math.floor(nxyz / 80000));
  for (let i = 0; i < nxyz; i += step) {
    const v = density[i];
    if (v > 0) samples.push(v);
  }
  samples.sort((a, b) => a - b);
  const p98d = percentile(samples, 0.98);
  const thr = p98d > 0 ? p98d * 0.05 : 0;

  const mask = new Uint8Array(nxyz);
  let sx = 0, sy = 0, sz = 0, sw = 0;
  let i0 = nx, i1 = -1, j0 = ny, j1 = -1, k0 = nz, k1 = -1;
  let nMask = 0;
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
        if ((i & 1) === 0 && (j & 1) === 0 && (k & 1) === 0) {
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
  if (!(sw > 0) || nMask === 0) throw new Error("Phantom density is empty — load a BIfTI phantom first");
  const com = [sx / sw, sy / sw, sz / sw];

  const cnx = Math.ceil(nx / stride);
  const cny = Math.ceil(ny / stride);
  const cnz = Math.ceil(nz / stride);
  const cn = cnx * cny * cnz;
  const coarseMask = new Uint8Array(cn);
  const half = (stride - 1) / 2;
  const xs = new Float32Array(cn);
  const ys = new Float32Array(cn);
  const zs = new Float32Array(cn);
  const ic0 = Math.max(0, Math.floor(i0 / stride) - 1);
  const ic1 = Math.min(cnx - 1, Math.floor(i1 / stride) + 1);
  const jc0 = Math.max(0, Math.floor(j0 / stride) - 1);
  const jc1 = Math.min(cny - 1, Math.floor(j1 / stride) + 1);
  const kc0 = Math.max(0, Math.floor(k0 / stride) - 1);
  const kc1 = Math.min(cnz - 1, Math.floor(k1 / stride) + 1);
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
      }
    }
  }

  const maps = [];
  for (let c = 0; c < SHIM_CHANNELS.length; c++) {
    const br = new Float32Array(cn);
    const mags = [];
    for (let slot = 0; slot < cn; slot++) {
      if (!coarseMask[slot]) continue;
      const v = bzOfLoops(SHIM_CHANNELS[c].loops, xs[slot], ys[slot], zs[slot]);
      br[slot] = v;
      mags.push(Math.abs(v));
    }
    mags.sort((a, b) => a - b);
    const p98 = percentile(mags, 0.98);
    const scale = p98 > 1e-20 ? 1 / p98 : 1;
    for (let slot = 0; slot < cn; slot++) br[slot] *= scale;
    maps.push(br);
    if (onProgress) onProgress(c + 1, SHIM_CHANNELS.length);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return { nx, ny, nz, stride, cnx, cny, cnz, mask, coarseMask, maps, com, nMask };
}

/** Signed ΔB0 on the full phantom grid. Outside the head the value is B0_OUTSIDE. */
export function combineB0(basis, currents) {
  const { nx, ny, nz, stride, cnx, cny, cnz, mask, coarseMask, maps } = basis;
  const cn = cnx * cny * cnz;
  const acc = new Float32Array(cn);
  for (let c = 0; c < maps.length; c++) {
    const w = currents[c] || 0;
    if (!w) continue;
    const src = maps[c];
    for (let slot = 0; slot < cn; slot++) {
      if (coarseMask[slot]) acc[slot] += w * src[slot];
    }
  }
  const field = new Float32Array(nx * ny * nz);
  const abs = [];
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  const half = (stride - 1) / 2;
  for (let k = 0; k < nz; k++) {
    const kc = Math.max(0, Math.min(cnz - 1, Math.round((k - half) / stride)));
    for (let j = 0; j < ny; j++) {
      const jc = Math.max(0, Math.min(cny - 1, Math.round((j - half) / stride)));
      const row = k * nx * ny + j * nx;
      for (let i = 0; i < nx; i++) {
        const idx = row + i;
        if (!mask[idx]) {
          field[idx] = OUTSIDE;
          continue;
        }
        const ic = Math.max(0, Math.min(cnx - 1, Math.round((i - half) / stride)));
        const slot = (kc * cny + jc) * cnx + ic;
        const v = coarseMask[slot] ? acc[slot] : 0;
        field[idx] = v;
        const a = Math.abs(v);
        abs.push(a);
        sum += v;
        sum2 += v * v;
        n++;
      }
    }
  }
  abs.sort((a, b) => a - b);
  const mean = n ? sum / n : 0;
  const variance = n ? Math.max(0, sum2 / n - mean * mean) : 0;
  return {
    field,
    mean,
    std: Math.sqrt(variance),
    p98: percentile(abs, 0.98),
    n,
  };
}
