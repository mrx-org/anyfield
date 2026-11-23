import { describe, expect, it } from "vitest";
import type { Fov, Vec3 } from "../types";
import { boxAxisAlong, eulerFromMatrix, fovCorners, fovMesh, fovToWorld, rotateAboutWorldAxis, rotationMatrix } from "./fov";

const close = (a: Vec3, b: Vec3) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));
const fov = (o: Partial<Fov> = {}): Fov => ({ center_mm: [0, 0, 0], rotation_deg: [0, 0, 0], size_mm: [200, 100, 10], ...o });

describe("FOV geometry", () => {
  it("identity without rotation", () => {
    close(fovToWorld(fov({ center_mm: [1, 2, 3] }), [10, 0, 0]), [11, 2, 3]);
  });

  it("rotates about x first, then z (as v3)", () => {
    // x 90°: y → z; then z 90°: x → y. Point (0,1,0) → (0,0,1) → (0,0,1)
    close(fovToWorld(fov({ rotation_deg: [90, 0, 90] }), [0, 1, 0]), [0, 0, 1]);
    // (1,0,0) → (1,0,0) → (0,1,0)
    close(fovToWorld(fov({ rotation_deg: [90, 0, 90] }), [1, 0, 0]), [0, 1, 0]);
  });

  it("rotation matrices are orthonormal", () => {
    const m = rotationMatrix([13, -47, 101]);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) expect(m[0][i] * m[0][j] + m[1][i] * m[1][j] + m[2][i] * m[2][j]).toBeCloseTo(i === j ? 1 : 0, 12);
  });

  it("corners span the size", () => {
    const c = fovCorners(fov({ center_mm: [5, 0, 0] }));
    expect(c).toHaveLength(8);
    close(c[0], [-95, -50, -5]);
    close(c[7], [105, 50, 5]);
  });

  it("mesh is a set of closed tubes", () => {
    const { pts, tris } = fovMesh(fov());
    expect(pts.length % 24).toBe(0); // 8 vertices × 3 per tube
    expect(tris.length / 36).toBe(pts.length / 24); // 12 triangles per tube
    expect(Math.max(...tris)).toBe(pts.length / 3 - 1);
  });
});

describe("rotations for the mouse", () => {
  const sameRotation = (a: Vec3, b: Vec3) => {
    const [ma, mb] = [rotationMatrix(a), rotationMatrix(b)];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(ma[i][j]).toBeCloseTo(mb[i][j], 9);
  };

  it("finds the angles of a matrix again", () => {
    for (const r of [[0, 0, 0], [13, -47, 101], [-170, 30, -20], [45, 89, 10]] as Vec3[]) sameRotation(eulerFromMatrix(rotationMatrix(r)), r);
    close(eulerFromMatrix(rotationMatrix([13, -47, 101])), [13, -47, 101]);
  });

  it("handles gimbal lock", () => {
    sameRotation(eulerFromMatrix(rotationMatrix([30, 90, 10])), [30, 90, 10]);
    sameRotation(eulerFromMatrix(rotationMatrix([30, -90, 10])), [30, -90, 10]);
  });

  it("turns about the world axis, also for a box that is turned already", () => {
    close(rotateAboutWorldAxis([0, 0, 0], 2, 30), [0, 0, 30]);
    // Box turned 90° about x: its y points along world z. A turn about world z
    // then moves its x axis in the axial plane, wherever its own axes point.
    const r = rotateAboutWorldAxis([90, 0, 0], 2, 90);
    close(fovToWorld(fov({ rotation_deg: r }), [1, 0, 0]), [0, 1, 0]);
    close(fovToWorld(fov({ rotation_deg: r }), [0, 1, 0]), [0, 0, 1]);
  });

  it("finds the box axis along a world axis", () => {
    expect(boxAxisAlong([0, 0, 0], 1)).toBe(1);
    expect(boxAxisAlong([0, 0, 90], 1)).toBe(0); // box x now points along world y
    expect(boxAxisAlong([90, 0, 0], 2)).toBe(1); // box y now points along world z
  });
});
