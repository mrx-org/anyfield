"""History of a project: automatic commits (merged within 5 s), undo/redo, jumps,
branching sessions, a session `default` where a project would have none."""

import pytest
from fastmcp.exceptions import ToolError

from anyfield import projects as projects_mod


async def call(c, tool, **args):
    r = (await c.call_tool(tool, args)).structured_content
    return r["result"] if isinstance(r, dict) and set(r) == {"result"} else r


@pytest.fixture
def clock(monkeypatch):
    """Time that only moves when told to."""
    now = [1000.0]
    monkeypatch.setattr(projects_mod.time, "time", lambda: now[0])
    return now


@pytest.fixture
async def key(client, as_user, clock):
    as_user("alice")
    return (await call(client, "create_project", name="P"))["key"]


async def history(c, key):
    return await call(c, "get_history", session_key=key)


async def test_same_change_within_5_s_is_one_state(client, key, clock):
    for x in (1, 2, 3):
        clock[0] += 1
        await call(client, "set_fov", session_key=key, center_mm=[x, 0, 0])
    h = await history(client, key)
    assert h["total"] == 2  # root + one FOV move
    assert h["states"][0]["change"] == ["fov.center_mm"] and h["leaves"] == [h["head"]]
    # after a pause, or another key: a new state
    clock[0] += 6
    await call(client, "set_fov", session_key=key, center_mm=[9, 0, 0])
    clock[0] += 1
    await call(client, "set_phantom_property", session_key=key, property="T1")
    h = await history(client, key)
    assert [s["change"] for s in h["states"]] == [["view.property"], ["fov.center_mm"], ["fov.center_mm"], []]


async def test_nothing_changed_is_no_state(client, key):
    await call(client, "patch_state", session_key=key, patch={"matrix": [128, 128, 1]})
    assert (await history(client, key))["total"] == 1


async def test_undo_redo_and_branches(client, key, clock):
    for x in (1, 2, 3):
        clock[0] += 10
        await call(client, "set_fov", session_key=key, center_mm=[x, 0, 0])
    r = await call(client, "undo", session_key=key, steps=2)
    assert r["state"]["fov"]["center_mm"] == [1.0, 0.0, 0.0]
    r = await call(client, "redo", session_key=key)
    assert r["state"]["fov"]["center_mm"] == [2.0, 0.0, 0.0]
    await call(client, "undo", session_key=key)
    # a change after an undo branches off
    clock[0] += 10
    await call(client, "set_fov", session_key=key, center_mm=[7, 0, 0])
    h = await history(client, key)
    assert h["total"] == 5 and len(h["leaves"]) == 2
    # redo at the fork follows the branch the session came back from
    await call(client, "undo", session_key=key)
    r = await call(client, "redo", session_key=key)
    assert r["state"]["fov"]["center_mm"] == [7.0, 0.0, 0.0]
    # undo stops at the root
    r = await call(client, "undo", session_key=key, steps=100)
    assert r["head"] == h["states"][-1]["hash"]
    # any state, and any state's content without going there
    old = next(s for s in h["states"] if s["change"] and s["parent"] == h["states"][-1]["hash"])
    seen = await call(client, "get_state", session_key=key, at=old["hash"])
    assert seen["state"]["fov"]["center_mm"] == [1.0, 0.0, 0.0]
    r = await call(client, "goto_state", session_key=key, state=old["hash"])
    assert r["head"] == old["hash"]
    with pytest.raises(ToolError, match="Unknown state"):
        await call(client, "goto_state", session_key=key, state="nope")


async def test_sessions_branch_off_and_run_independently(client, key, clock):
    clock[0] += 10
    await call(client, "set_fov", session_key=key, center_mm=[1, 0, 0])
    b = await call(client, "create_session", session_key=key, name="Versuch")
    assert (
        b["key"] != key
        and b["name"] == "Versuch"
        and b["head"] == (await call(client, "get_state", session_key=key))["head"]
    )
    assert b["color"] != (await call(client, "get_state", session_key=key))["color"]
    clock[0] += 10
    await call(client, "set_fov", session_key=b["key"], center_mm=[5, 0, 0])
    assert (await call(client, "get_state", session_key=key))["state"]["fov"]["center_mm"] == [1.0, 0.0, 0.0]
    h = await history(client, key)
    assert {s["name"] for s in h["sessions"]} == {"default", "Versuch"}
    # A head another session points at is never merged away
    clock[0] += 1
    await call(client, "set_fov", session_key=key, center_mm=[2, 0, 0])
    clock[0] += 1
    c = await call(client, "create_session", session_key=key)
    await call(client, "set_fov", session_key=key, center_mm=[3, 0, 0])
    assert (await call(client, "get_state", session_key=c["key"]))["state"]["fov"]["center_mm"] == [
        2.0,
        0.0,
        0.0,
    ]
    listed = await call(client, "list_sessions", session_key=key)
    assert len(listed["sessions"]) == 3
    renamed = await call(client, "rename_session", session_key=c["key"], name="drei")
    assert renamed["name"] == "drei"


async def test_deleting_the_last_session_creates_a_default_one(client, key, clock, as_user):
    clock[0] += 10
    await call(client, "set_fov", session_key=key, center_mm=[4, 0, 0])
    newest = (await history(client, key))["head"]
    r = await call(client, "delete_session", session_key=key)
    nxt = r["next"]
    assert nxt["name"] == "default" and nxt["key"] != key and nxt["head"] == newest
    with pytest.raises(ToolError, match="Unknown session key"):
        await call(client, "get_state", session_key=key)
    projects = await call(client, "list_projects")
    assert [s["key"] for s in projects[0]["sessions"]] == [nxt["key"]]


async def test_history_app_and_the_actor(client, key):
    tool = next(t for t in await client.list_tools() if t.name == "open_history")
    assert tool.meta["ui"]["resourceUri"] == "ui://anyfield/history.html"
    assert "sessions" in tool.inputSchema["properties"]
    await call(client, "set_fov", session_key=key, center_mm=[1, 0, 0])
    actor = (await history(client, key))["states"][0]["actor"]
    assert actor.startswith("mcp") and "alice" in actor  # the in-memory client's name, the login


async def test_the_actor_from_the_request_meta(client, key, clock):
    clock[0] += 1
    await client.call_tool(
        "set_fov", {"session_key": key, "center_mm": [1, 0, 0]}, meta={"anyfield/client": "anyfield-web"}
    )
    assert (await history(client, key))["states"][0]["actor"].startswith("anyfield-web")
