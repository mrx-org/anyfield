from fastmcp import Client

from anyfield.file_tools import UserFiles
from anyfield.server import build
from anyfield.store import MemoryStore

GATEWAY = "https://gw.test"


class FakeGateway:
    def __init__(self):
        self.calls = []

    async def __call__(self, name, args):
        self.calls.append((name, args))
        if name == "list_files":
            return {
                "result": [
                    {
                        "name": "a.zip",
                        "type": "application/zip",
                        "hash": "aa",
                        "size": 3,
                        "uploaded_at": "2026-11-20T10:00:00+00:00",
                    },
                    {
                        "name": "b.seq",
                        "type": "text/plain",
                        "hash": "bb",
                        "size": 5,
                        "uploaded_at": "2026-11-22T10:00:00+00:00",
                    },
                    {"name": "a again.zip", "hash": "aa", "uploaded_at": "2026-11-21T10:00:00+00:00"},
                ]
            }
        if name == "create_upload_url":
            return {"url": f"{GATEWAY}/upload/tok", "expires_in": 600}
        raise AssertionError(name)


async def call(c, tool, **args):
    return (await c.call_tool(tool, args)).structured_content


async def test_file_tools():
    gw = FakeGateway()
    mcp = build(MemoryStore(), "https://anyfield.test", files=UserFiles(gw, GATEWAY))
    async with Client(mcp) as c:
        files = (await call(c, "list_user_files"))["result"]
        assert [f["sha256"] for f in files] == ["bb", "aa"]  # newest first, one row per hash
        assert files[0]["url"] == f"{GATEWAY}/files/bb"
        biftis = (await call(c, "list_user_files", mode="bifti"))["result"]
        assert [f["sha256"] for f in biftis] == ["aa"]
        lists = sum(1 for c in gw.calls if c[0] == "list_files")
        await call(c, "list_user_files")  # cached
        assert sum(1 for c in gw.calls if c[0] == "list_files") == lists
        await call(c, "list_user_files", refresh=True)
        assert sum(1 for c in gw.calls if c[0] == "list_files") == lists + 1

        up = await call(c, "create_file_upload_url", file_name="x.zip")
        assert up == {"url": f"{GATEWAY}/upload/tok", "expires_in": 600}
        assert gw.calls[-1] == ("create_upload_url", {"file_name": "x.zip"})

        tools = {t.name: t for t in await c.list_tools()}
        resources = {str(r.uri) for r in await c.list_resources()}
        for tool, app in [
            ("open_file_upload", "file-upload"),
            ("open_file_list", "file-list"),
            ("open_file_manager", "file-manager"),
        ]:
            assert tools[tool].meta["ui"]["resourceUri"] == f"ui://anyfield/{app}.html"
            assert f"ui://anyfield/{app}.html" in resources
        assert len((await call(c, "open_file_manager"))["files"]) == 2

        r = await call(c, "open_file_list", mode="bifti", download=False)
        assert [f["name"] for f in r["files"]] == ["a.zip"] and "key" not in r


async def test_file_list_with_a_session(as_user):
    as_user("alice")
    mcp = build(MemoryStore(), "https://anyfield.test", files=UserFiles(FakeGateway(), GATEWAY))
    async with Client(mcp) as c:
        key = (await call(c, "create_session"))["key"]
        r = await call(c, "open_file_list", session_key=key, mode="bifti")
        # The session for the app (a click makes a bifti its phantom), and the files
        assert r["key"] == key and "state" in r and len(r["files"]) == 1
