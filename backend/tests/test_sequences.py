"""Sequence tool: sources (placeholders until the gateway lists them), selection
of a source sequence or a CAS file, the sequence browser app."""

import pytest
from fastmcp import Client
from fastmcp.exceptions import ToolError

from anyfield.file_tools import UserFiles
from anyfield.server import build
from anyfield.store import MemoryStore

SEQ = "d" * 64
PY = "e" * 64


class FakeGateway:
    async def __call__(self, tool, arguments):
        if tool == "list_files":
            return {
                "result": [
                    {"name": "my.seq", "hash": SEQ, "uploaded_at": "2026-11-02"},
                    {"name": "mine.py", "hash": PY, "uploaded_at": "2026-11-01"},
                    {"name": "x.zip", "hash": "f" * 64, "uploaded_at": "2026-11-03"},
                ]
            }
        raise ToolError(tool)


@pytest.fixture
async def client(as_user):
    as_user("alice")
    mcp = build(MemoryStore(), "https://anyfield.test", files=UserFiles(FakeGateway(), "https://gw.test"))
    async with Client(mcp) as c:
        c.key = (await c.call_tool("create_project", {})).structured_content["key"]
        yield c


async def call(c, tool, **args):
    r = (await c.call_tool(tool, args)).structured_content
    return r["result"] if isinstance(r, dict) and set(r) == {"result"} else r


async def test_sources_are_the_v3_ones_with_dummy_files(client):
    sources = await call(client, "list_sequence_sources")
    assert [s["source"] for s in sources] == [
        "anyseq",
        "builtin",
        "mrseq.sequences",
        "pypulseq_examples",
        "MRzero",
        "Educational",
    ]
    files = await call(client, "list_sequences", source="anyseq")
    assert [f["name"] for f in files] == ["backend_not_ready_dummy.py"]
    assert files[0]["url"].startswith("https://backend-not-ready.invalid/")
    assert (await call(client, "list_sequences", source="MRzero"))[0]["type"] == "ipynb"
    module = (await call(client, "list_sequences", source="mrseq.sequences"))[0]
    assert module["type"] == "module" and module["url"] == "mrseq.sequences.backend_not_ready_dummy"
    with pytest.raises(ToolError, match="Unknown sequence source"):
        await call(client, "list_sequences", source="nope")


async def test_select_a_source_sequence(client):
    alone = await call(
        client, "select_sequence", source="anyseq", name="backend_not_ready_dummy.py", func="dummy_seq_tse"
    )
    assert alone["sequence"]["func"] == "dummy_seq_tse" and alone["sequence"]["type"] == "py"
    r = await call(
        client,
        "select_sequence",
        session_key=client.key,
        source="anyseq",
        name="backend_not_ready_dummy.py",
        func="dummy_seq_gre",
    )
    state = (await call(client, "get_state", session_key=client.key))["state"]
    assert (
        state["sequence"]
        == r["sequence"]
        == {
            "source": "anyseq",
            "type": "py",
            "url": "https://backend-not-ready.invalid/anyseq/backend_not_ready_dummy.py",
            "name": "backend_not_ready_dummy.py",
            "func": "dummy_seq_gre",
        }
    )
    with pytest.raises(ToolError, match="no sequence function"):
        await call(client, "select_sequence", source="anyseq", name="backend_not_ready_dummy.py", func="x")
    with pytest.raises(ToolError, match="No file"):
        await call(client, "select_sequence", source="anyseq", name="gre.py", func="seq_gre")


async def test_patch_state_checks_source_sequences(client):
    bad = {"source": "anyseq", "type": "py", "url": "https://elsewhere/x.py", "name": "x.py", "func": "f"}
    with pytest.raises(ToolError, match="No file"):
        await call(client, "patch_state", session_key=client.key, patch={"sequence": bad})
    r = await call(client, "patch_state", session_key=client.key, patch={"sequence": None})
    assert r["state"]["sequence"] is None


async def test_select_a_cas_sequence(client):
    r = await call(client, "select_sequence", session_key=client.key, sha256=SEQ)
    assert r["sequence"] == {"sha256": SEQ, "type": "seq", "name": "my.seq", "func": None}
    r = await call(client, "select_sequence", sha256=PY, func="seq_mine")
    assert r["sequence"]["type"] == "py" and r["sequence"]["name"] == "mine.py"
    with pytest.raises(ToolError, match="give no function"):
        await call(client, "select_sequence", sha256=SEQ, func="f")
    with pytest.raises(ToolError, match="give `name`"):
        await call(client, "select_sequence", sha256="0" * 64)
    with pytest.raises(ToolError, match="no sequence file"):
        await call(client, "select_sequence", sha256="0" * 64, name="x.zip")


async def test_sequence_files_of_the_user(client):
    files = await call(client, "list_user_files", mode="sequence")
    assert [f["name"] for f in files] == ["my.seq", "mine.py"]


async def test_sequence_browser_is_an_app(client):
    tool = next(t for t in await client.list_tools() if t.name == "open_sequence_browser")
    assert tool.meta["ui"]["resourceUri"] == "ui://anyfield/sequence-browser.html"
    r = await call(client, "open_sequence_browser", session_key=client.key)
    assert r["key"] == client.key and r["state"]["sequence"] is None
