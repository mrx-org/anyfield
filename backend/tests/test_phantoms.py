"""Phantom tool: catalog, selection, display maps. The gateway is faked: it answers
like its bifti tools and records what it was asked."""

import numpy as np
import pytest
from fastmcp import Client
from fastmcp.exceptions import ToolError

from anyfield.models import Fov
from anyfield.phantoms import (
    DEFAULT_PHANTOM,
    CasFiles,
    Catalog,
    PhantomError,
    PhantomMaps,
    fov_affine,
    to_phantom_frame,
)
from anyfield.server import build
from anyfield.store import MemoryStore

GATEWAY = "https://gateway.test"
COLLECTIONS = {"collections": [{"name": "demo-001", "description": "Demo", "phantom_count": 2}]}
TREE = {
    "phantoms": [
        "shapes.json",
        {"group": "broken", "default": "broken.json", "phantoms": ["broken.json"]},
    ]
}
IDENTITY = [[2.0, 0.0, 0.0, -100.0], [0.0, 2.0, 0.0, -100.0], [0.0, 0.0, 2.0, -50.0]]
CAS_ZIP = "a" * 64
OLD_ZIP = "b" * 64
FILES = {
    "result": [
        {
            "name": "old.zip",
            "type": "application/zip",
            "hash": OLD_ZIP,
            "size": 10,
            "uploaded_at": "2026-11-01",
        },
        {
            "name": "map.nii.gz",
            "type": "application/x-nifti",
            "hash": "c" * 64,
            "size": 5,
            "uploaded_at": "2026-11-03",
        },
        {
            "name": "mine.zip",
            "type": "application/zip",
            "hash": CAS_ZIP,
            "size": 20,
            "uploaded_at": "2026-11-02",
        },
        {
            "name": "mine-again.zip",
            "type": "application/zip",
            "hash": CAS_ZIP,
            "size": 20,
            "uploaded_at": "2026-11-02",
        },
    ]
}


def maps_answer(name: str, affine=IDENTITY, affine_phantom=IDENTITY) -> dict:
    """Like `bifti_get_property_maps` on the phantom's own grid."""
    stem = name.removesuffix(".json")
    return {
        "shape": [100, 100, 50],
        "spacing_mm": [2.0, 2.0, 2.0],
        "affine": affine,
        "affine_phantom": affine_phantom,
        "patient_position": "FFS",
        "coarsening": 1,
        "properties": [
            {
                "key": k,
                "label": label,
                "unit": unit,
                "range": [0.0, 1.0],
                "url": f"{GATEWAY}/files/{stem}-{k}",
                "sha256": f"{stem}-{k}",
                "file_name": f"{stem}_{k}.nii.gz",
                "size": 1000,
            }
            for k, label, unit in [("density", "PD", "a.u."), ("T1", "T1", "s"), ("dB0", "dB0", "Hz")]
        ],
    }


class FakeGateway:
    def __init__(self):
        self.calls: list[tuple[str, dict]] = []

    async def __call__(self, tool, arguments):
        self.calls.append((tool, arguments))
        if tool == "bifti_list_collections":
            return COLLECTIONS
        if tool == "bifti_list_phantoms" and arguments["collection"] == "demo-001":
            return TREE
        if tool == "list_files":
            return FILES
        if tool == "bifti_list_tissues":
            return {"file_name": "x.json", "tissues": ["CSF", "GM", "WM"]}
        if tool == "bifti_get_property_maps":
            phantom = arguments["phantom"]
            name = phantom["file_name"] if "file_name" in phantom else f"cas-{phantom['sha256'][:4]}.json"
            if name == "broken.json":
                raise ToolError("MRX gateway, bifti_get_property_maps: download failed")
            answer = maps_answer(name)
            answer["tissues"] = arguments.get("tissues", ["CSF", "GM", "WM"])
            if "grid" in arguments:
                answer["affine"] = answer["affine_phantom"] = arguments["grid"]["affine"]
                answer["shape"] = arguments["grid"]["resolution"]
            return answer
        raise ToolError(f"MRX gateway, {tool}: unknown collection")

    def maps_calls(self) -> list[dict]:
        return [a for t, a in self.calls if t == "bifti_get_property_maps"]


@pytest.fixture
def gateway():
    return FakeGateway()


@pytest.fixture
async def client(gateway, as_user):
    as_user("alice")
    mcp = build(
        MemoryStore(),
        "https://anyfield.test",
        catalog=Catalog(gateway),
        maps=PhantomMaps(gateway),
        cas=CasFiles(gateway),
    )
    async with Client(mcp) as c:
        c.key = (await c.call_tool("create_session", {})).structured_content["key"]
        yield c


async def call(c, tool, **args):
    return (await c.call_tool(tool, args)).structured_content


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


async def test_select_phantom_in_session(client):
    s = await call(client, "get_state", session_key=client.key)
    assert s["state"]["phantom"] is None

    r = await call(
        client, "select_phantom", session_key=client.key, collection="demo-001", phantom="shapes.json"
    )
    assert r == {"rev": 2, "phantom": {"collection": "demo-001", "name": "shapes.json"}, "tissues": None}
    r = await call(client, "set_phantom_view", session_key=client.key, property="dB0")
    assert r["view"] == {"property": "dB0"}
    s = await call(client, "get_state", session_key=client.key)
    assert s["state"]["phantom"]["name"] == "shapes.json" and s["state"]["view"]["property"] == "dB0"

    r = await call(client, "patch_state", session_key=client.key, patch={"phantom": None})
    assert r["state"]["phantom"] is None


async def test_select_phantom_without_session(client):
    r = await call(client, "select_phantom", collection="demo-001", phantom="shapes.json")
    assert r == {"phantom": {"collection": "demo-001", "name": "shapes.json"}, "tissues": None}


async def test_unknown_phantom_is_rejected(client):
    for args in [
        {"collection": "demo-001", "phantom": "../../etc.json"},
        {"session_key": client.key, "collection": "demo-001", "phantom": "x.json"},
    ]:
        with pytest.raises(ToolError, match="No phantom"):
            await client.call_tool("select_phantom", args)
    with pytest.raises(ToolError, match="No phantom"):
        await client.call_tool(
            "patch_state",
            {"session_key": client.key, "patch": {"phantom": {"collection": "demo-001", "name": "x.json"}}},
        )
    with pytest.raises(ToolError, match="No phantom"):
        await client.call_tool("get_phantom_maps", {"collection": "demo-001", "phantom": "x.json"})


async def test_phantom_maps_from_gateway(client, gateway):
    r = await call(client, "get_phantom_maps", collection="demo-001", phantom="shapes.json")
    assert r["phantom"] == {"collection": "demo-001", "name": "shapes.json"} and r["default"] is False
    assert [p["key"] for p in r["properties"]] == ["density", "T1", "dB0"]
    # Passed through: the URL is the gateway's, only what a viewer needs is kept
    assert r["properties"][0] == {
        "key": "density",
        "label": "PD",
        "unit": "a.u.",
        "range": [0.0, 1.0],
        "url": f"{GATEWAY}/files/shapes-density",
    }
    assert r["shape"] == [100, 100, 50] and r["spacing_mm"] == [2.0, 2.0, 2.0]
    assert gateway.maps_calls() == [{"collection": "demo-001", "phantom": {"file_name": "shapes.json"}}]

    await call(client, "get_phantom_maps", collection="demo-001", phantom="shapes.json")
    assert len(gateway.maps_calls()) == 1  # cached


async def test_default_phantom_maps(client, gateway):
    r = await call(client, "get_phantom_maps")
    assert r["default"] is True and r["phantom"] == DEFAULT_PHANTOM.model_dump()
    assert r["phantom"] == {"collection": "endres-brainweb-001", "name": "subj04-3T-1mm.json"}
    assert r["properties"][0]["url"] == f"{GATEWAY}/files/subj04-3T-1mm-density"
    with pytest.raises(ToolError, match="both"):
        await client.call_tool("get_phantom_maps", {"collection": "demo-001"})


async def test_failed_phantom_is_reported(client):
    with pytest.raises(ToolError, match="download failed"):
        await client.call_tool("get_phantom_maps", {"collection": "demo-001", "phantom": "broken.json"})


async def test_maps_on_the_fov(client, gateway):
    fov = {"center_mm": [0, 0, 10], "rotation_deg": [0, 0, 0], "size_mm": [200, 200, 100]}
    r = await call(client, "get_phantom_maps", fov=fov, matrix=[100, 100, 1])
    assert r["shape"] == [100, 100, 1]
    grid_call = gateway.maps_calls()[-1]
    assert grid_call["grid"] == {
        "affine": [[2.0, 0.0, 0.0, -99.0], [0.0, 2.0, 0.0, -99.0], [0.0, 0.0, 100.0, 10.0]],
        "resolution": [100, 100, 1],
    }
    with pytest.raises(ToolError, match="matrix"):
        await client.call_tool("get_phantom_maps", {"fov": fov, "matrix": [0, 1, 1]})
    with pytest.raises(ToolError, match="size_mm"):
        await client.call_tool("get_phantom_maps", {"fov": {**fov, "size_mm": [0, 1, 1]}})


def test_fov_affine_rotated():
    fov = Fov(center_mm=(10, 20, 30), rotation_deg=(0, 0, 90), size_mm=(100, 50, 10))
    a = fov_affine(fov, (50, 25, 1))
    assert np.allclose(np.linalg.norm(a[:3, :3], axis=0), [2, 2, 10])  # voxel sizes
    # The grid's centre (voxel (24.5, 12, 0)) is the FOV's centre
    assert np.allclose(a @ [24.5, 12, 0, 1], [10, 20, 30, 1])
    assert np.allclose(a[:3, 0], [0, 2, 0])  # voxel x runs along world y after 90° about z


def test_grid_is_rotated_back_into_the_phantom_frame():
    # Phantom lies rotated by 180° about z in the scanner (e.g. head first instead of feet first)
    flip = np.diag([-1.0, -1.0, 1.0, 1.0])
    phantom = np.vstack([IDENTITY, [0, 0, 0, 1]])
    native = {"affine": (flip @ phantom)[:3].tolist(), "affine_phantom": IDENTITY}
    world = np.eye(4)
    world[:3, 3] = [5, 6, 7]
    grid = np.vstack([to_phantom_frame(native, world), [0, 0, 0, 1]])
    assert np.allclose(grid, flip @ world)
    # Without a patient rotation the grid is passed unchanged
    same = {"affine": IDENTITY, "affine_phantom": IDENTITY}
    assert np.allclose(to_phantom_frame(same, world), world[:3])


async def test_phantom_browser_is_an_app(client):
    tools = {t.name: t for t in await client.list_tools()}
    assert tools["open_phantom_browser"].meta["ui"]["resourceUri"] == "ui://anyfield/phantom-browser.html"
    assert tools["open_phantom_preview"].meta["ui"]["resourceUri"] == "ui://anyfield/phantom-preview.html"


async def test_phantom_preview_without_session_needs_a_phantom(client):
    with pytest.raises(ToolError, match="give collection and phantom"):
        await call(client, "open_phantom_preview")
    with pytest.raises(ToolError, match="No phantom"):
        await call(client, "open_phantom_preview", collection="demo-001", phantom="nope.json")
    with pytest.raises(ToolError, match="Unknown property"):
        await call(client, "open_phantom_preview", collection="demo-001", phantom="shapes.json", property="x")

    r = await call(
        client,
        "open_phantom_preview",
        collection="demo-001",
        phantom="shapes.json",
        property="T2",
    )
    assert r["key"] is None
    assert r["state"]["phantom"] == {"collection": "demo-001", "name": "shapes.json"}
    assert r["state"]["view"] == {"property": "T2"} and r["state"]["tissues"] is None


async def test_phantom_preview_with_session_shows_the_session(client):
    r = await call(client, "open_phantom_preview", session_key=client.key)
    assert r["key"] == client.key
    with pytest.raises(ToolError, match="leave out"):
        await call(client, "open_phantom_preview", session_key=client.key, phantom="shapes.json")


async def test_cas_phantoms_are_the_zips_of_the_callers_files(client):
    r = await client.call_tool("list_cas_phantoms", {})
    phantoms = r.structured_content["result"]
    # Only zips, each hash once, newest first
    assert [(p["sha256"], p["name"]) for p in phantoms] == [(CAS_ZIP, "mine.zip"), (OLD_ZIP, "old.zip")]


async def test_select_a_cas_phantom_in_a_session(client, gateway):
    r = await call(client, "select_phantom", session_key=client.key, sha256=CAS_ZIP, phantom="mine.zip")
    assert r["phantom"] == {"sha256": CAS_ZIP, "name": "mine.zip"}
    s = await call(client, "get_state", session_key=client.key)
    assert s["state"]["phantom"] == {"sha256": CAS_ZIP, "name": "mine.zip"}

    maps = await call(client, "get_phantom_maps", sha256=CAS_ZIP)
    assert maps["phantom"]["sha256"] == CAS_ZIP and maps["default"] is False
    # The bifti tool gets the hash only, no collection
    assert gateway.maps_calls()[-1] == {"phantom": {"sha256": CAS_ZIP}}

    await call(
        client, "get_phantom_maps", sha256=CAS_ZIP, fov={"size_mm": [100, 100, 10]}, matrix=[64, 64, 1]
    )
    assert gateway.maps_calls()[-1]["phantom"] == {"sha256": CAS_ZIP} and "grid" in gateway.maps_calls()[-1]


async def test_cas_phantom_arguments_are_checked(client):
    with pytest.raises(ToolError, match="64 hex digits"):
        await call(client, "select_phantom", sha256="nope")
    with pytest.raises(ToolError, match="not both"):
        await call(client, "select_phantom", sha256=CAS_ZIP, collection="demo-001", phantom="shapes.json")
    r = await call(client, "select_phantom", sha256=CAS_ZIP.upper())
    assert r["phantom"]["sha256"] == CAS_ZIP and r["phantom"]["name"] == "mine.zip"


async def test_cas_phantom_in_patch_state_and_preview(client):
    r = await call(
        client, "patch_state", session_key=client.key, patch={"phantom": {"sha256": CAS_ZIP, "name": "x.zip"}}
    )
    assert r["state"]["phantom"] == {"sha256": CAS_ZIP, "name": "x.zip"}

    r = await call(client, "open_phantom_preview", sha256=CAS_ZIP, property="T1")
    assert r["state"]["phantom"]["sha256"] == CAS_ZIP and r["state"]["view"]["property"] == "T1"


async def test_tissues_of_a_phantom(client, gateway):
    r = await call(client, "list_phantom_tissues", collection="demo-001", phantom="shapes.json")
    assert r["tissues"] == ["CSF", "GM", "WM"]
    r = await call(client, "list_phantom_tissues", sha256=CAS_ZIP)
    assert r["phantom"]["sha256"] == CAS_ZIP
    assert gateway.calls[-1] == ("bifti_list_tissues", {"phantom": {"sha256": CAS_ZIP}})


async def test_maps_of_some_tissues(client, gateway):
    maps = await call(
        client, "get_phantom_maps", collection="demo-001", phantom="shapes.json", tissues=["WM", "GM"]
    )
    assert gateway.maps_calls()[-1]["tissues"] == ["GM", "WM"] and maps["tissues"] == ["GM", "WM"]
    # None given (or an empty list): all tissues, the gateway gets no `tissues`
    await call(client, "get_phantom_maps", collection="demo-001", phantom="shapes.json", tissues=[])
    assert "tissues" not in gateway.maps_calls()[-1]


async def test_tissues_of_the_chosen_phantom(client):
    # Only tissues: those of the session's phantom
    r = await call(client, "select_phantom", session_key=client.key, tissues=["WM", "GM", "GM"])
    assert r["phantom"] is None and r["tissues"] == ["GM", "WM"]
    await call(client, "set_phantom_view", session_key=client.key, property="T2")
    s = await call(client, "get_state", session_key=client.key)
    assert s["state"]["tissues"] == ["GM", "WM"]  # the view leaves them alone
    r = await call(client, "select_phantom", session_key=client.key, tissues=[])
    assert r["tissues"] is None  # all

    await call(client, "select_phantom", session_key=client.key, tissues=["GM"])
    await call(client, "select_phantom", session_key=client.key, sha256=CAS_ZIP)
    s = await call(client, "get_state", session_key=client.key)
    assert s["state"]["tissues"] is None  # another phantom: all its tissues

    r = await call(client, "select_phantom", session_key=client.key, sha256=CAS_ZIP, tissues=["CSF"])
    assert r["tissues"] == ["CSF"]  # chosen with it
    r = await call(client, "select_phantom", collection="demo-001", phantom="shapes.json", tissues=["WM"])
    assert r == {"phantom": {"collection": "demo-001", "name": "shapes.json"}, "tissues": ["WM"]}
    with pytest.raises(ToolError, match="Give collection"):
        await call(client, "select_phantom", tissues=["WM"])  # without a session: a phantom too

    # Chosen together with the phantom, they stay
    r = await call(
        client,
        "patch_state",
        session_key=client.key,
        patch={
            "phantom": {"collection": "demo-001", "name": "shapes.json", "sha256": None},
            "tissues": ["GM"],
        },
    )
    assert r["state"]["tissues"] == ["GM"]


async def test_a_cas_phantom_without_a_name_gets_its_file_name(client):
    r = await call(client, "open_phantom_preview", sha256=CAS_ZIP)
    assert r["state"]["phantom"]["name"] == "mine.zip"  # from the caller's files
    r = await call(client, "select_phantom", sha256="d" * 64)
    assert r["phantom"]["name"] == "dddddddddddd….zip"  # not among them: the hash
