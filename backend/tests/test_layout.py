"""Workspace layout (state field `layout`): checked and normalized on every change."""

import pytest
from fastmcp import Client
from fastmcp.exceptions import ToolError

from anyfield.server import build
from anyfield.store import MemoryStore


@pytest.fixture
async def client(as_user):
    as_user("alice")
    async with Client(build(MemoryStore(), "https://anyfield.test")) as c:
        c.key = (await c.call_tool("create_project", {})).structured_content["key"]
        yield c


async def patch(c, layout):
    r = await c.call_tool("patch_state", {"session_key": c.key, "patch": {"layout": layout}})
    return r.structured_content["state"]["layout"]


def stack(*tools, **extra):
    return {"tabs": [{"tool": t} if isinstance(t, str) else t for t in tools], **extra}


async def test_default_is_null(client):
    r = await client.call_tool("get_state", {"session_key": client.key})
    assert r.structured_content["state"]["layout"] is None


async def test_ids_sizes_and_options_are_normalized(client):
    layout = await patch(
        client,
        {
            "root": {
                "split": "row",
                "sizes": [1, 3],
                "children": [
                    stack(
                        "phantom_browser",
                        {"id": "list", "tool": "file_list", "options": {"mode": "sequence"}},
                    ),
                    stack("fov_viewer"),
                ],
            }
        },
    )
    root = layout["root"]
    assert root["sizes"] == [0.25, 0.75]
    tabs = root["children"][0]["tabs"]
    assert tabs[1] == {"id": "list", "tool": "file_list", "options": {"mode": "sequence"}}
    assert tabs[0]["id"] and tabs[0]["id"] != "list"
    assert root["children"][1]["tabs"][0]["id"]
    # Stored as normalized: patching it again changes nothing
    assert await patch(client, layout) == layout


async def test_same_direction_splits_are_flattened(client):
    layout = await patch(
        client,
        {
            "root": {
                "split": "row",
                "children": [
                    stack("phantom_browser"),
                    {"split": "row", "children": [stack("fov_viewer"), stack("fov_planner")]},
                ],
            }
        },
    )
    root = layout["root"]
    assert [c["tabs"][0]["tool"] for c in root["children"]] == [
        "phantom_browser",
        "fov_viewer",
        "fov_planner",
    ]
    assert root["sizes"] == [0.5, 0.25, 0.25]


async def test_an_empty_workspace(client):
    assert await patch(client, {"root": None}) == {"root": None}


@pytest.mark.parametrize(
    ("root", "message"),
    [
        (stack("workspace"), "Unknown tool"),
        (stack({"tool": "file_list", "options": {"mode": "x"}}), "Options of file_list"),
        (stack({"tool": "fov_viewer", "options": {"x": 1}}), "Options of fov_viewer"),
        (stack({"id": "a", "tool": "fov_viewer"}, {"id": "a", "tool": "fov_planner"}), "used twice"),
        (stack("fov_viewer", active=1), "no tab"),
        (
            {"split": "row", "sizes": [1], "children": [stack("fov_viewer"), stack("fov_planner")]},
            "needs 2 sizes",
        ),
        (
            {"split": "row", "sizes": [1, 0], "children": [stack("fov_viewer"), stack("fov_planner")]},
            "greater than 0",
        ),
        ({"split": "row", "children": [stack("fov_viewer")]}, "at least 2"),
        ({"tabs": []}, "at least 1"),
    ],
)
async def test_invalid_layouts_are_rejected(client, root, message):
    with pytest.raises(ToolError, match=message):
        await patch(client, {"root": root})


async def test_too_many_panels(client):
    with pytest.raises(ToolError, match="At most 24"):
        await patch(client, {"root": stack(*["fov_viewer"] * 25)})


async def test_open_workspace(client):
    tool = next(t for t in await client.list_tools() if t.name == "open_workspace")
    assert tool.meta["ui"]["resourceUri"] == "ui://anyfield/workspace.html"
    assert "phantom_browser" in tool.description
    r = (
        await client.call_tool("open_workspace", {"layout": {"root": stack("fov_viewer")}})
    ).structured_content
    assert r["key"] is None and r["state"]["layout"]["root"]["tabs"][0]["tool"] == "fov_viewer"
    with pytest.raises(ToolError, match="Unknown tool"):
        await client.call_tool("open_workspace", {"layout": {"root": stack("nope")}})
    with pytest.raises(ToolError, match="patch_state"):
        await client.call_tool("open_workspace", {"session_key": client.key, "layout": {"root": None}})
    r = (await client.call_tool("open_workspace", {"session_key": client.key})).structured_content
    assert r["key"] == client.key
