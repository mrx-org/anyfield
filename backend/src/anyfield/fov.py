"""FOV operations: pure functions on `Fov`, used by the tools."""

from __future__ import annotations

import math

import numpy as np

from .models import Fov, Vec3

MAX_SIZE_MM = 600.0


def rotation_matrix(rotation_deg: Vec3) -> np.ndarray:
    """Rotation about x first, then y, then z: R = Rz·Ry·Rx (as in the frontend and v3)."""
    ax, ay, az = (math.radians(a) for a in rotation_deg)
    cx, sx, cy, sy, cz, sz = (
        math.cos(ax),
        math.sin(ax),
        math.cos(ay),
        math.sin(ay),
        math.cos(az),
        math.sin(az),
    )
    rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return rz @ ry @ rx


def normalize_angle(deg: float) -> float:
    """To (-180, 180]."""
    a = (deg + 180.0) % 360.0 - 180.0
    return 180.0 if a == -180.0 else a


def _vec(v: Vec3 | list[float]) -> Vec3:
    if len(v) != 3:
        raise ValueError("expected 3 values (x, y, z)")
    return (float(v[0]), float(v[1]), float(v[2]))


def set_fov(
    fov: Fov,
    center_mm: Vec3 | None = None,
    rotation_deg: Vec3 | None = None,
    size_mm: Vec3 | None = None,
) -> Fov:
    size = _vec(size_mm) if size_mm is not None else fov.size_mm
    if any(not (0 < s <= MAX_SIZE_MM) for s in size):
        raise ValueError(f"size_mm must be in (0, {MAX_SIZE_MM:g}] mm")
    rot = _vec(rotation_deg) if rotation_deg is not None else fov.rotation_deg
    return Fov(
        center_mm=_vec(center_mm) if center_mm is not None else fov.center_mm,
        rotation_deg=tuple(normalize_angle(a) for a in rot),
        size_mm=size,
    )


def move_fov(fov: Fov, delta_mm: Vec3) -> Fov:
    d = _vec(delta_mm)
    c = fov.center_mm
    return set_fov(fov, center_mm=(c[0] + d[0], c[1] + d[1], c[2] + d[2]))


def rotate_fov(fov: Fov, delta_deg: Vec3) -> Fov:
    d = _vec(delta_deg)
    r = fov.rotation_deg
    return set_fov(fov, rotation_deg=(r[0] + d[0], r[1] + d[1], r[2] + d[2]))


def describe(fov: Fov) -> str:
    def f(v: Vec3) -> str:
        return "(" + ", ".join(f"{x:g}" for x in v) + ")"

    return f"FOV center {f(fov.center_mm)} mm, rotation {f(fov.rotation_deg)}°, size {f(fov.size_mm)} mm"
