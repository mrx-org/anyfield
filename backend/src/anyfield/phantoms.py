"""BIfTI phantoms, all from the MRX gateway: the catalog (`bifti_list_collections`,
`bifti_list_phantoms`) and the display maps of a phantom (`bifti_get_property_maps`).
anyfield keeps no phantom data of its own; it only shows what the gateway returns.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import Awaitable, Callable
from typing import Any

import numpy as np

from .fov import rotation_matrix
from .models import Fov, Int3, PhantomChoice

# What `phantom: null` in the state stands for
DEFAULT_PHANTOM = PhantomChoice(collection="endres-brainweb-001", name="subj04-3T-1mm.json")

# Property keys of `bifti_get_property_maps`, in display order
PROPERTY_KEYS = ["density", "T1", "T2", "T2dash", "ADC", "dB0", "B1plus", "B1minus"]

_SAFE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+\- ]*$")

Call = Callable[[str, dict[str, Any]], Awaitable[Any]]


class PhantomError(ValueError):
    pass


def safe_part(s: str) -> str:
    """A registry name, or PhantomError."""
    if not _SAFE.match(s) or ".." in s:
        raise PhantomError(f"Invalid name: {s!r}")
    return s


def flatten(phantoms: list) -> list[str]:
    out: list[str] = []
    for entry in phantoms:
        out.extend([entry] if isinstance(entry, str) else flatten(entry.get("phantoms", [])))
    return out


def subtree(phantoms: list, path: list[str]) -> list:
    for group in path:
        match = [e for e in phantoms if isinstance(e, dict) and e.get("group") == group]
        if not match:
            raise PhantomError(f"No group {group!r}")
        phantoms = match[0].get("phantoms", [])
    return phantoms


class _Cached:
    """Gateway answers cached for `ttl_s`, with concurrent identical calls merged."""

    def __init__(self, call: Call | None, ttl_s: float) -> None:
        self._call = call
        self.ttl_s = ttl_s
        self._cache: dict[str, tuple[float, Any]] = {}
        self._pending: dict[str, asyncio.Task] = {}

    async def _cached(self, tool: str, arguments: dict[str, Any]) -> Any:
        key = json.dumps([tool, arguments], sort_keys=True)
        hit = self._cache.get(key)
        if hit is not None and time.monotonic() - hit[0] < self.ttl_s:
            return hit[1]
        if self._call is None:
            raise PhantomError("The MRX gateway is not available on this server.")
        if key not in self._pending:
            self._pending[key] = asyncio.ensure_future(self._call(tool, arguments))
        try:
            value = await self._pending[key]
        finally:
            self._pending.pop(key, None)
        self._cache[key] = (time.monotonic(), value)
        return value


class Catalog(_Cached):
    """The phantom catalog. `call(tool, arguments)` calls a gateway tool, e.g.
    `GatewayClient.call_tool`. The registry changes rarely and is the same for
    every user, so answers are cached for 10 minutes."""

    def __init__(self, call: Call | None, ttl_s: float = 600) -> None:
        super().__init__(call, ttl_s)

    async def collections(self) -> list[dict[str, Any]]:
        """`{collection, description, phantom_count}` per collection."""
        data = await self._cached("bifti_list_collections", {})
        return [
            {
                "collection": c["name"],
                "description": c.get("description", ""),
                "phantom_count": c.get("phantom_count", 0),
            }
            for c in data.get("collections", [])
        ]

    async def phantoms(self, collection: str, path: list[str] | None = None) -> list:
        safe_part(collection)
        tree = await self._cached("bifti_list_phantoms", {"collection": collection, "path": []})
        return subtree(tree.get("phantoms", []), path or [])

    async def check(self, collection: str, name: str) -> None:
        if name not in flatten(await self.phantoms(collection)):
            raise PhantomError(f"No phantom {name!r} in {collection!r}")


# --- Display maps ---------------------------------------------------------------


def fov_affine(fov: Fov, matrix: Int3) -> np.ndarray:
    """Voxel-to-world affine (4x4) of the scan grid: `matrix` voxels filling the FOV
    box, the last column the centre of voxel (0, 0, 0)."""
    r = rotation_matrix(fov.rotation_deg)
    size = np.asarray(fov.size_mm, dtype=float)
    voxel = size / np.asarray(matrix, dtype=float)
    a = np.eye(4)
    a[:3, :3] = r * voxel  # column j: step along voxel axis j
    a[:3, 3] = np.asarray(fov.center_mm) + r @ (voxel / 2 - size / 2)
    return a


def _square(rows: list[list[float]]) -> np.ndarray:
    return np.vstack([np.asarray(rows, dtype=float), [0.0, 0.0, 0.0, 1.0]])


def to_phantom_frame(native: dict[str, Any], world: np.ndarray) -> list[list[float]]:
    """A grid in the maps' (scanner) frame, rotated back into the phantom's RAS+
    frame, which is what the gateway takes as `grid`. `native` is the maps
    result on the phantom's own grid: it has the same grid in both frames."""
    scanner, phantom = _square(native["affine"]), _square(native["affine_phantom"])
    to_scanner = scanner @ np.linalg.inv(phantom)
    rows = (np.linalg.inv(to_scanner) @ world)[:3]
    # Rounded, so that the same FOV always gives the same call (and gateway memo)
    return [[round(float(v), 6) + 0.0 for v in row] for row in rows]


class PhantomMaps(_Cached):
    """Display maps of a phantom from the gateway: one NIfTI per property (tissues
    combined), with label, unit, value range and a URL any browser may load. The
    gateway remembers computed maps; answers are cached here for 10 minutes."""

    def __init__(self, call: Call | None, ttl_s: float = 600) -> None:
        super().__init__(call, ttl_s)

    async def get(self, choice: PhantomChoice, grid: list[list[float]] | None = None, matrix=None):
        args: dict[str, Any] = {"collection": choice.collection, "phantom": {"file_name": choice.name}}
        if grid is not None:
            args["grid"] = {"affine": grid, "resolution": list(matrix)}
        return await self._cached("bifti_get_property_maps", args)

    async def on_fov(self, choice: PhantomChoice, fov: Fov, matrix: Int3) -> dict[str, Any]:
        """The maps resampled onto the planned scan grid (FOV and matrix)."""
        native = await self.get(choice)
        return await self.get(choice, to_phantom_frame(native, fov_affine(fov, matrix)), matrix)


def public_maps(raw: dict[str, Any], choice: PhantomChoice, default: bool) -> dict[str, Any]:
    """What `get_phantom_maps` returns: the grid and per property what a viewer needs."""
    keep = ("key", "label", "unit", "range", "url")
    return {
        "phantom": choice.model_dump(),
        "default": default,
        "shape": raw.get("shape"),
        "spacing_mm": raw.get("spacing_mm"),
        "affine": raw.get("affine"),
        "coarsening": raw.get("coarsening", 1),
        "properties": [{k: p.get(k) for k in keep} for p in raw.get("properties", [])],
    }
