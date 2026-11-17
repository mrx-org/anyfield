"""Phantom tool: catalog, selection, display maps. Uses the `shapes` phantom from
the bifti examples (mrx-org/bifti-phantoms, python/bifti/examples/data, MIT)
instead of downloading from Zenodo."""

import asyncio
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest
from fastmcp import Client
from fastmcp.exceptions import ToolError
from starlette.testclient import TestClient

from anyfield.phantoms import (
    Catalog,
    PhantomError,
    PhantomLibrary,
    compute_maps,
    display_grid,
    prepare_from_json,
)
from anyfield.server import build, http_app
from anyfield.store import MemoryStore

DATA = Path(__file__).parent / "data"
COLLECTIONS = {"collections": [{"name": "demo-001", "description": "Demo", "phantom_count": 2}]}
TREE = {
    "phantoms": [
        "shapes.json",
        {"group": "broken", "default": "broken.json", "phantoms": ["broken.json"]},
    ]
}


def fake_catalog() -> Catalog:
    """Answers like the gateway's bifti tools."""

    async def call(tool, arguments):
        if tool == "bifti_list_collections":
            return COLLECTIONS
        if tool == "bifti_list_phantoms" and arguments["collection"] == "demo-001":
            return TREE
        raise ToolError(f"MRX gateway, {tool}: unknown collection")

    return Catalog(call)


@pytest.fixture
def library(tmp_path):
    calls = []

    async def prepare(collection, name):
        calls.append(name)
        await asyncio.sleep(0.05)
        if name == "broken.json":
            raise RuntimeError("download failed")
        return prepare_from_json(DATA / name, tmp_path / collection / name.removesuffix(".json"))

    lib = PhantomLibrary(tmp_path, prepare)
    lib.calls = calls
    return lib


@pytest.fixture
async def client(library, as_user):
    as_user("alice")
    mcp = build(MemoryStore(), "https://anyfield.test", library=library, catalog=fake_catalog())
    async with Client(mcp) as c:
        c.key = (await c.call_tool("create_session", {})).structured_content["key"]
        yield c


async def call(c, tool, **args):
    return (await c.call_tool(tool, args)).structured_content


def test_maps_are_density_weighted():
    from bifti import NumpyPhantom

    phantom = NumpyPhantom.load(DATA / "shapes.json")
    maps = compute_maps(phantom)
    rho = {n: t.density for n, t in phantom.tissues.items()}
    total = sum(rho.values())
    i = np.unravel_index(np.argmax(rho["disk"] / np.maximum(total, 1e-9)), total.shape)
    assert maps["density"][i] == pytest.approx(total[i])
    want_t1 = sum(rho[n][i] * float(np.asarray(t.T1)[i]) for n, t in phantom.tissues.items()) / total[i]
    assert maps["T1"][i] == pytest.approx(want_t1)
    assert "B1plus" in maps and "B1minus" not in maps  # B1- is the default (1) everywhere


def test_large_phantoms_are_shown_coarser(monkeypatch):
    from bifti import BiftiPhantom

    import anyfield.phantoms as ph

    monkeypatch.setattr(ph, "MAX_DISPLAY_VOXELS", 40 * 32 * 4 // 8)
    grid = display_grid(BiftiPhantom.load(DATA / "shapes.json"), DATA)
    assert grid.resolution == [20, 16, 2]
    assert np.allclose(np.asarray(grid.affine)[:, :3], np.diag([6.0, 6.0, 10.0]))


def test_prepared_files(tmp_path):
    meta = prepare_from_json(DATA / "shapes.json", tmp_path / "out")
    assert meta["shape"] == [40, 32, 4] and meta["spacing_mm"] == [3.0, 3.0, 5.0]
    img = nib.load(tmp_path / "out" / "T1.nii.gz")
    assert img.shape == (40, 32, 4) and img.get_data_dtype() == np.int16
    keys = [p["key"] for p in meta["properties"]]
    assert keys[0] == "density" and "dB0" in keys


async def test_catalog_tools(client):
    cols = await call(client, "list_phantom_collections")
    assert cols["result"] == [{"collection": "demo-001", "description": "Demo", "phantom_count": 2}]
    tree = (await call(client, "list_phantoms", collection="demo-001", path=["broken"]))["result"]
    assert tree == ["broken.json"]
    with pytest.raises(ToolError, match="unknown collection"):
        await client.call_tool("list_phantoms", {"collection": "nope"})


async def test_catalog_without_gateway():
    with pytest.raises(PhantomError, match="not available"):
        await Catalog(None).collections()


async def test_select_phantom_prepares_once(client, library):
    s = await call(client, "get_session", session_key=client.key)
    assert s["phantom"]["collection"] is None and s["phantom_url"].endswith("/files/phantom.nii.gz")

    r = await call(
        client, "select_phantom", session_key=client.key, collection="demo-001", phantom="shapes.json"
    )
    assert r["status"] == "ready" and r["property"] == "density"
    assert r["url"] == "https://anyfield.test/files/phantoms/demo-001/shapes/density.nii.gz"

    r = await call(client, "set_phantom_property", session_key=client.key, property="dB0")
    assert r["url"].endswith("/dB0.nii.gz")
    with pytest.raises(ToolError, match="no 'B1minus'"):
        await client.call_tool("set_phantom_property", {"session_key": client.key, "property": "B1minus"})

    await call(client, "select_phantom", session_key=client.key, collection="demo-001", phantom="shapes.json")
    assert library.calls == ["shapes.json"]  # prepared once, then reused


async def test_select_shows_loading_then_ready(client):
    task = asyncio.create_task(
        client.call_tool(
            "select_phantom",
            {"session_key": client.key, "collection": "demo-001", "phantom": "shapes.json", "property": "T2"},
        )
    )
    await asyncio.sleep(0.02)
    s = await call(client, "get_session", session_key=client.key)
    assert s["phantom"]["status"] == "loading" and s["phantom_url"] is None
    await task
    s = await call(client, "get_session", session_key=client.key)
    assert s["phantom"]["status"] == "ready" and s["phantom"]["property"] == "T2"


async def test_failed_phantom_is_reported(client):
    with pytest.raises(ToolError, match="download failed"):
        await client.call_tool(
            "select_phantom", {"session_key": client.key, "collection": "demo-001", "phantom": "broken.json"}
        )
    s = await call(client, "get_session", session_key=client.key)
    assert s["phantom"]["status"] == "error"


async def test_unknown_phantom_is_rejected(client):
    with pytest.raises(ToolError, match="No phantom"):
        await client.call_tool(
            "select_phantom",
            {"session_key": client.key, "collection": "demo-001", "phantom": "../../etc.json"},
        )


async def test_phantom_browser_is_an_app(client):
    tools = {t.name: t for t in await client.list_tools()}
    assert tools["open_phantom_browser"].meta["ui"]["resourceUri"] == "ui://anyfield/phantom-browser.html"


def test_map_files_are_served(library, tmp_path):
    prepare_from_json(DATA / "shapes.json", tmp_path / "demo-001" / "shapes")
    mcp = build(MemoryStore(), "http://testserver", library=library, catalog=fake_catalog())
    with TestClient(http_app(mcp)) as c:
        r = c.get("/files/phantoms/demo-001/shapes/T1.nii.gz")
        assert r.status_code == 200 and r.content[:2] == b"\x1f\x8b"
        assert c.get("/files/phantoms/demo-001/shapes/nope.nii.gz").status_code == 404
        assert c.get("/files/phantoms/demo-001/other/T1.nii.gz").status_code == 404
        assert c.get("/files/phantoms/..%2F..%2Fx/shapes/T1.nii.gz").status_code == 404
