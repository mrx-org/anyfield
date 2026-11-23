import type { Fov, Vec3 } from "../types";

export type Mat3 = [Vec3, Vec3, Vec3];

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Rotation matrix for `rotation_deg`: about x first, then y, then z (R = Rz·Ry·Rx), as on the server and in v3. */
export function rotationMatrix([ax, ay, az]: Vec3): Mat3 {
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(rad(ax)), Math.sin(rad(ax)), Math.cos(rad(ay)), Math.sin(rad(ay)), Math.cos(rad(az)), Math.sin(rad(az))];
  return [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ];
}

export function apply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

/** Matrix product a·b. */
export function multiply(a: Mat3, b: Mat3): Mat3 {
  const r = (i: number, j: number) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
  return [
    [r(0, 0), r(0, 1), r(0, 2)],
    [r(1, 0), r(1, 1), r(1, 2)],
    [r(2, 0), r(2, 1), r(2, 2)],
  ];
}

const deg = (r: number) => (r * 180) / Math.PI;

/** `rotation_deg` (about x, then y, then z) of a rotation matrix; the inverse of `rotationMatrix`.
 * In gimbal lock (y = ±90°) the x angle is 0. */
export function eulerFromMatrix(m: Mat3): Vec3 {
  const sy = Math.max(-1, Math.min(1, -m[2][0]));
  const ay = Math.asin(sy);
  if (Math.abs(sy) > 1 - 1e-9) return [0, deg(ay), deg(Math.atan2(-m[0][1], m[1][1]))];
  return [deg(Math.atan2(m[2][1], m[2][2])), deg(ay), deg(Math.atan2(m[1][0], m[0][0]))];
}

/** The rotation `rotation_deg` followed by a turn of `angle` degrees about world axis
 * `axis` (0: x, 1: y, 2: z), as `rotation_deg` again. */
export function rotateAboutWorldAxis(rotation: Vec3, axis: 0 | 1 | 2, angle: number): Vec3 {
  const turn: Vec3 = [0, 0, 0];
  turn[axis] = angle;
  return eulerFromMatrix(multiply(rotationMatrix(turn), rotationMatrix(rotation)));
}

/** Index of the box axis (0: x, 1: y, 2: z of the FOV) that points most along world axis `world`. */
export function boxAxisAlong(rotation: Vec3, world: 0 | 1 | 2): 0 | 1 | 2 {
  const row = rotationMatrix(rotation)[world].map(Math.abs);
  return row.indexOf(Math.max(...row)) as 0 | 1 | 2;
}

/** Box point in FOV coordinates (mm, relative to the center) → world mm. */
export function fovToWorld(fov: Fov, local: Vec3): Vec3 {
  const r = apply(rotationMatrix(fov.rotation_deg), local);
  return [r[0] + fov.center_mm[0], r[1] + fov.center_mm[1], r[2] + fov.center_mm[2]];
}

/** The 8 corners of the FOV box in world mm. */
export function fovCorners(fov: Fov): Vec3[] {
  const [hx, hy, hz] = fov.size_mm.map((s) => s / 2);
  const out: Vec3[] = [];
  for (const z of [-hz, hz]) for (const y of [-hy, hy]) for (const x of [-hx, hx]) out.push(fovToWorld(fov, [x, y, z]));
  return out;
}

const CUBE_TRIS = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2];

/**
 * Wireframe mesh of the FOV box (world mm): a thin square tube along each of
 * the 12 edges, plus a cross in the central slice plane (as in v3).
 */
export function fovMesh(fov: Fov, edgeMm = 0.8, crossMm = 0.4): { pts: Float32Array; tris: Uint32Array } {
  const pts: number[] = [];
  const tris: number[] = [];
  const [hx, hy, hz] = fov.size_mm.map((s) => s / 2);
  const tube = (min: Vec3, max: Vec3) => {
    const base = pts.length / 3;
    const corners: Vec3[] = [
      [min[0], min[1], min[2]], [max[0], min[1], min[2]], [max[0], max[1], min[2]], [min[0], max[1], min[2]],
      [min[0], min[1], max[2]], [max[0], min[1], max[2]], [max[0], max[1], max[2]], [min[0], max[1], max[2]],
    ];
    for (const c of corners) pts.push(...fovToWorld(fov, c));
    for (const i of CUBE_TRIS) tris.push(base + i);
  };
  const edges = (t: number, zs: number[]) => {
    for (const z of zs) {
      for (const y of [-hy, hy]) tube([-hx, y - t, z - t], [hx, y + t, z + t]);
      for (const x of [-hx, hx]) tube([x - t, -hy, z - t], [x + t, hy, z + t]);
    }
  };
  const e = edgeMm / 2;
  edges(e, [-hz, hz]);
  for (const x of [-hx, hx]) for (const y of [-hy, hy]) tube([x - e, y - e, -hz], [x + e, y + e, hz]);
  const c = crossMm / 2;
  edges(c, [0]);
  tube([-hx, -c, -c], [hx, c, c]);
  tube([-c, -hy, -c], [c, hy, c]);
  return { pts: new Float32Array(pts), tris: new Uint32Array(tris) };
}
