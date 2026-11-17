"""BIfTI phantoms: the catalog (from the MRX gateway), and display maps of a phantom.

A phantom's tissues are combined into one map per property (density-weighted
means), so a viewer can show "T1" or "dB0" of the whole phantom. Computing them
means downloading the phantom from Zenodo and loading it with `bifti`, which
takes from seconds to a minute; the result is stored once per phantom and
shared by every session (`PhantomLibrary`).

The maps will come from the gateway too (MRX-73); until then they are computed here.
"""

from __future__ import annotations

import asyncio
import json
import math
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import nibabel as nib
import numpy as np

# Larger phantoms are shown on a coarser grid (e.g. 0.5 mm brains at 2 mm).
MAX_DISPLAY_VOXELS = 8_000_000

_SAFE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+\- ]*$")


@dataclass(frozen=True)
class Property:
    key: str  # file name and API value
    label: str
    unit: str


PROPERTIES = [
    Property("density", "PD", "a.u."),
    Property("T1", "T1", "s"),
    Property("T2", "T2", "s"),
    Property("T2dash", "T2'", "s"),
    Property("ADC", "ADC", "10⁻³ mm²/s"),
    Property("dB0", "dB0", "Hz"),
    Property("B1plus", "B1+", "rel"),
    Property("B1minus", "B1−", "rel"),
]
PROPERTY_KEYS = [p.key for p in PROPERTIES]


class PhantomError(ValueError):
    pass


def safe_part(s: str) -> str:
    """A path component from a registry name, or PhantomError."""
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


class Catalog:
    """The phantom catalog, from the gateway's bifti tools (`bifti_list_collections`,
    `bifti_list_phantoms`). `call(tool, arguments)` calls a gateway tool, e.g.
    `GatewayClient.call_tool`. Answers are cached for `ttl_s`: the registry
    changes rarely and is the same for every user."""

    def __init__(
        self, call: Callable[[str, dict[str, Any]], Awaitable[Any]] | None, ttl_s: float = 600
    ) -> None:
        self._call = call
        self.ttl_s = ttl_s
        self._cache: dict[str, tuple[float, Any]] = {}

    async def _cached(self, key: str, tool: str, arguments: dict[str, Any]) -> Any:
        hit = self._cache.get(key)
        if hit is not None and time.monotonic() - hit[0] < self.ttl_s:
            return hit[1]
        if self._call is None:
            raise PhantomError("The phantom catalog (MRX gateway) is not available on this server.")
        value = await self._call(tool, arguments)
        self._cache[key] = (time.monotonic(), value)
        return value

    async def collections(self) -> list[dict[str, Any]]:
        """`{collection, description, phantom_count}` per collection."""
        data = await self._cached("collections", "bifti_list_collections", {})
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
        tree = await self._cached(
            f"phantoms:{collection}", "bifti_list_phantoms", {"collection": collection, "path": []}
        )
        return subtree(tree.get("phantoms", []), path or [])

    async def check(self, collection: str, name: str) -> None:
        if name not in flatten(await self.phantoms(collection)):
            raise PhantomError(f"No phantom {name!r} in {collection!r}")


# --- Display maps ---------------------------------------------------------------


def stem(name: str) -> str:
    return safe_part(name.removesuffix(".json"))


def display_grid(config, base_dir: Path):
    """`config.reslice_to`, coarsened if the phantom has more than MAX_DISPLAY_VOXELS."""
    from bifti import ResliceTo

    if config.reslice_to is not None:
        affine = np.asarray(config.reslice_to.affine, dtype=float)
        shape = list(config.reslice_to.resolution)
    else:
        first = next(iter(config.tissues.values()))
        img = nib.load(base_dir / first.density.file_name.name)
        affine, shape = img.affine[:3], list(img.shape[:3])
    n = math.prod(shape)
    if n <= MAX_DISPLAY_VOXELS:
        return config.reslice_to
    f = math.ceil((n / MAX_DISPLAY_VOXELS) ** (1 / 3))
    new = affine.copy()
    new[:, :3] *= f
    new[:, 3] = affine @ np.array([(f - 1) / 2] * 3 + [1.0])
    return ResliceTo(affine=new.tolist(), resolution=[math.ceil(s / f) for s in shape])


def compute_maps(phantom) -> dict[str, np.ndarray]:
    """One map per property: total density, density-weighted means of the rest.
    Infinite values (bifti's default for T1, T2, T2') count as 0. B1 maps are the
    magnitude of the channel mean. B1+/B1− are left out where they are uniformly 1
    (the default)."""
    tissues = list(phantom.tissues.values())
    total = sum(t.density for t in tissues)
    inside = total > 0
    norm = np.where(inside, total, 1.0)

    def weighted(values) -> np.ndarray:
        acc = sum(
            t.density * np.nan_to_num(v, posinf=0.0, neginf=0.0) for t, v in zip(tissues, values, strict=True)
        )
        return np.where(inside, acc / norm, 0.0)

    maps = {"density": total}
    for key, attr in [("T1", "T1"), ("T2", "T2"), ("T2dash", "T2dash"), ("ADC", "ADC"), ("dB0", "dB0")]:
        maps[key] = weighted([getattr(t, attr) for t in tissues])
    for key, attr in [("B1plus", "B1_tx"), ("B1minus", "B1_rx")]:
        m = weighted([np.abs(np.asarray(getattr(t, attr)).mean(axis=0)) for t in tissues])
        if not np.allclose(m[inside], 1.0):
            maps[key] = m
    return maps


def prepare(collection: str, name: str, out_root: Path, cache_root: Path) -> dict[str, Any]:
    """Download a phantom, compute its display maps and write them to
    `out_root/<collection>/<stem>/<property>.nii.gz` plus `meta.json`."""
    import bifti.registry

    bifti.registry.CACHE = cache_root  # where it downloads to; module-level setting
    json_path = bifti.registry.load_registry_phantom(safe_part(collection), safe_part(name))
    return prepare_from_json(json_path, out_root / safe_part(collection) / stem(name))


def prepare_from_json(json_path: Path, out_dir: Path) -> dict[str, Any]:
    """Display maps of a phantom on disk (see `prepare`)."""
    from bifti import BiftiPhantom, NumpyPhantom, to_scanner_affine

    config = BiftiPhantom.load(json_path)
    config.reslice_to = display_grid(config, json_path.parent)
    phantom = NumpyPhantom.load_from_config(config, base_dir=json_path.parent)
    first = next(iter(phantom.tissues.values()))
    affine = to_scanner_affine(first.affine, config.patient)
    maps = compute_maps(phantom)

    out_dir.mkdir(parents=True, exist_ok=True)
    props = []
    for p in PROPERTIES:
        if p.key not in maps:
            continue
        data = maps[p.key].astype(np.float32)
        img = nib.Nifti1Image(data, affine)
        img.set_data_dtype(np.int16)  # scaled by nibabel: half the size of float32
        img.header.set_xyzt_units("mm")
        nib.save(img, out_dir / f"{p.key}.nii.gz")
        values = data[maps["density"] > 0]
        lo, hi = np.percentile(values, [2, 98]).tolist() if values.size else [0.0, 1.0]
        props.append({"key": p.key, "label": p.label, "unit": p.unit, "range": [lo, hi]})
    spacing = np.linalg.norm(affine[:3, :3], axis=0).round(4).tolist()
    meta = {"shape": list(maps["density"].shape), "spacing_mm": spacing, "properties": props}
    (out_dir / "meta.json").write_text(json.dumps(meta))
    return meta


class PhantomLibrary:
    """Prepared phantoms under `root`. `prepare` computes a missing one (on Modal:
    a separate function with more memory, writing to the same Volume); `reload`
    makes files written elsewhere visible."""

    def __init__(
        self,
        root: Path,
        prepare: Callable[[str, str], Awaitable[dict[str, Any]]],
        reload: Callable[[], None] | None = None,
    ) -> None:
        self.root = root
        self._prepare = prepare
        self._reload = reload
        self._pending: dict[tuple[str, str], asyncio.Task] = {}

    def dir(self, collection: str, name: str) -> Path:
        return self.root / safe_part(collection) / stem(name)

    def file(self, collection: str, name: str, prop: str) -> Path:
        if prop not in PROPERTY_KEYS:
            raise PhantomError(f"Unknown property {prop!r}")
        return self.dir(collection, name) / f"{prop}.nii.gz"

    async def meta(self, collection: str, name: str, *, reload: bool = True) -> dict[str, Any] | None:
        path = self.dir(collection, name) / "meta.json"
        if not path.exists() and reload and self._reload:
            await asyncio.to_thread(self._reload)
        return json.loads(path.read_text()) if path.exists() else None

    async def ensure(self, collection: str, name: str) -> dict[str, Any]:
        meta = await self.meta(collection, name)
        if meta is not None:
            return meta
        key = (collection, name)
        if key not in self._pending:
            self._pending[key] = asyncio.create_task(self._prepare(collection, name))
        try:
            return await self._pending[key]
        finally:
            self._pending.pop(key, None)

    async def ensure_visible(self, collection: str, name: str, prop: str) -> Path | None:
        path = self.file(collection, name, prop)
        if not path.exists() and self._reload:
            await asyncio.to_thread(self._reload)
        return path if path.exists() else None


def local_library(root: Path) -> PhantomLibrary:
    """Prepares in this process (tests, the in-memory test server)."""

    async def run(collection: str, name: str) -> dict[str, Any]:
        return await asyncio.to_thread(prepare, collection, name, root, root / "_downloads")

    return PhantomLibrary(root, run)
