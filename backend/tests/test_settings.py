"""User settings: stored per logged-in user, nothing for the visitor."""

import pytest
from fastmcp.exceptions import ToolError


async def call(c, tool, **args):
    return (await c.call_tool(tool, args)).structured_content


async def test_settings_per_user(client, as_user):
    as_user("alice")
    assert await call(client, "get_user_settings") == {
        "saved": True, "locale": None, "theme": None, "mode": None, "chat_theme": None,
    }  # fmt: skip
    r = await call(client, "set_user_settings", locale="de", theme="rose", mode="dark", chat_theme=False)
    assert r["saved"] and r["theme"] == "rose"
    r = await call(client, "set_user_settings", mode="light")  # the others stay
    assert (r["locale"], r["theme"], r["mode"], r["chat_theme"]) == ("de", "rose", "light", False)
    r = await call(client, "set_user_settings", reset=["theme", "chat_theme"])
    assert r["theme"] is None and r["chat_theme"] is None and r["locale"] == "de"
    as_user("bob")
    assert (await call(client, "get_user_settings"))["locale"] is None
    as_user("alice")
    assert (await call(client, "get_user_settings"))["mode"] == "light"


async def test_the_visitor_saves_nothing(client, as_user):
    as_user(None)
    r = await call(client, "set_user_settings", locale="fr")
    assert r["saved"] is False and "Not saved" in r["warning"]
    assert (await call(client, "get_user_settings"))["locale"] is None


async def test_unknown_values_are_refused(client, as_user):
    as_user("alice")
    with pytest.raises(ToolError):
        await call(client, "set_user_settings", theme="neon")
    with pytest.raises(ToolError):
        await call(client, "set_user_settings", locale="pt")


async def test_app_tools_take_no_locale_anymore(client):
    for t in await client.list_tools():
        assert "locale" not in t.input_schema.get("properties", {}) or t.name == "set_user_settings", t.name
