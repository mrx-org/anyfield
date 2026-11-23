import pytest
from fastmcp.exceptions import ToolError


async def call(client, tool, **args):
    return (await client.call_tool(tool, args)).structured_content


async def test_session_lifecycle(client, as_user):
    as_user("alice")
    s = await call(client, "create_session", name="Kopf")
    assert len(s["key"]) >= 20 and s["name"] == "Kopf" and s["rev"] == 1
    assert s["web_url"].endswith(f"/s/{s['key']}")

    listed = (await call(client, "list_sessions"))["result"]
    assert [x["key"] for x in listed] == [s["key"]]

    renamed = await call(client, "rename_session", session_key=s["key"], name="Knie")
    assert renamed["name"] == "Knie" and renamed["rev"] == 2

    await client.call_tool("delete_session", {"session_key": s["key"]})
    assert (await call(client, "list_sessions"))["result"] == []
    with pytest.raises(ToolError, match="Unknown session key"):
        await client.call_tool("get_state", {"session_key": s["key"]})


async def test_management_needs_login(client, as_user):
    as_user(None)
    with pytest.raises(ToolError, match="Login required"):
        await client.call_tool("create_session", {})
    with pytest.raises(ToolError, match="Login required"):
        await client.call_tool("list_sessions", {})


async def test_only_owner_renames_and_deletes(client, as_user):
    as_user("alice")
    s = await call(client, "create_session")
    as_user("bob")
    for tool, args in [("rename_session", {"name": "x"}), ("delete_session", {})]:
        with pytest.raises(ToolError, match="Only the owner"):
            await client.call_tool(tool, {"session_key": s["key"], **args})
    assert (await call(client, "list_sessions"))["result"] == []


async def test_session_tools_need_only_the_key(client, as_user):
    as_user("alice")
    key = (await call(client, "create_session"))["key"]
    as_user(None)
    session = await call(client, "get_state", session_key=key)
    assert session["state"]["fov"]["size_mm"] == [200.0, 200.0, 100.0]
    assert session["state"]["phantom"] is None and session["state"]["matrix"] == [128, 128, 1]

    r = await call(client, "set_fov", session_key=key, center_mm=[1, 2, 3], size_mm=[100, 120, 5])
    assert r["fov"]["center_mm"] == [1.0, 2.0, 3.0] and r["rev"] == 2
    r = await call(client, "move_fov", session_key=key, delta_mm=[0, 0, 10])
    assert r["fov"]["center_mm"] == [1.0, 2.0, 13.0]
    r = await call(client, "rotate_fov", session_key=key, delta_deg=[0, 0, 200])
    assert r["fov"]["rotation_deg"] == [0.0, 0.0, -160.0]
    assert "size (100, 120, 5) mm" in r["summary"]


async def test_get_state_unchanged(client, as_user):
    as_user("alice")
    key = (await call(client, "create_session"))["key"]
    assert await call(client, "get_state", session_key=key, known_rev=1) == {"rev": 1, "unchanged": True}
    await call(client, "move_fov", session_key=key, delta_mm=[1, 0, 0])
    assert (await call(client, "get_state", session_key=key, known_rev=1))["rev"] == 2


async def test_fov_validation_and_conflicts(client, as_user):
    as_user("alice")
    key = (await call(client, "create_session"))["key"]
    with pytest.raises(ToolError, match="size_mm"):
        await client.call_tool("set_fov", {"session_key": key, "size_mm": [0, 10, 10]})
    with pytest.raises(ToolError, match="Conflict"):
        await client.call_tool("move_fov", {"session_key": key, "delta_mm": [1, 0, 0], "expected_rev": 7})


async def test_fov_planner_is_an_app(client):
    tools = {t.name: t for t in await client.list_tools()}
    ui = tools["open_fov_planner"].meta["ui"]
    assert ui["resourceUri"] == "ui://anyfield/fov-planner.html"
    resources = {str(r.uri): r for r in await client.list_resources()}
    res = resources["ui://anyfield/fov-planner.html"]
    assert res.mime_type.startswith("text/html")
    assert res.meta["ui"]["csp"]["connectDomains"] == [
        "https://anyfield.test",
        "https://mcp.anyfield.net",
    ]


async def test_patch_state(client, as_user):
    as_user("alice")
    key = (await call(client, "create_session"))["key"]
    r = await call(
        client,
        "patch_state",
        session_key=key,
        patch={"view": {"property": "T1"}, "matrix": [256, 256, 3], "fov": {"rotation_deg": [0, 0, 190]}},
    )
    st = r["state"]
    assert (
        r["rev"] == 2 and st["view"] == {"property": "T1", "tissues": None} and st["matrix"] == [256, 256, 3]
    )
    assert st["fov"]["rotation_deg"] == [0.0, 0.0, -170.0]  # normalized like set_fov
    assert st["fov"]["size_mm"] == [200.0, 200.0, 100.0]  # merged, not replaced

    for patch, msg in [
        ({"matrix": [0, 1, 1]}, "matrix"),
        ({"view": {"property": "nope"}}, "Unknown property"),
        ({"fov": {"size_mm": [0, 1, 1]}}, "size_mm"),
        ({"bogus": 1}, "bogus"),
    ]:
        with pytest.raises(ToolError, match=msg):
            await client.call_tool("patch_state", {"session_key": key, "patch": patch})
    assert (await call(client, "get_state", session_key=key))["rev"] == 2


async def test_open_without_session(client):
    r = await call(client, "open_fov_planner")
    assert r["key"] is None and r["state"]["fov"]["size_mm"] == [200.0, 200.0, 100.0]
