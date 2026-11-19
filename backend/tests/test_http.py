"""Login on demand on /mcp: only session management asks for a token."""

import json

import pytest
from fastmcp.server.auth.providers.jwt import StaticTokenVerifier
from starlette.testclient import TestClient

from anyfield.server import build, http_app
from anyfield.store import MemoryStore

TOKEN = "alice-token"
HEADERS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}


@pytest.fixture
def http(monkeypatch):
    monkeypatch.delenv("ANYFIELD_DEV_USER", raising=False)
    verifier = StaticTokenVerifier(
        {TOKEN: {"client_id": "c", "scopes": ["read:user"], "sub": "1", "login": "alice"}},
        required_scopes=["read:user"],
    )
    mcp = build(MemoryStore(), "http://testserver", auth=verifier)
    with TestClient(http_app(mcp)) as c:
        yield c


def rpc(http, method, params=None, token=None, headers=None):
    headers = dict(HEADERS, **(headers or {}), **({"Authorization": f"Bearer {token}"} if token else {}))
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    r = http.post("/mcp", content=json.dumps(body), headers=headers)
    if r.status_code != 200:
        return r, None
    text = r.text
    if text.startswith("event:") or "data:" in text:
        text = next(line[5:] for line in text.splitlines() if line.startswith("data:"))
    return r, json.loads(text)


def call(http, tool, token=None, **args):
    return rpc(http, "tools/call", {"name": tool, "arguments": args}, token)


def test_anonymous_can_list_tools(http):
    r, msg = rpc(http, "tools/list")
    assert r.status_code == 200
    assert "list_sessions" in {t["name"] for t in msg["result"]["tools"]}


def test_management_without_token_gets_oauth_challenge(http):
    r, _ = call(http, "list_sessions")
    assert r.status_code == 401
    assert r.headers["www-authenticate"].startswith("Bearer")


def test_invalid_token_is_rejected(http):
    r, _ = call(http, "get_state", token="nope", session_key="x")
    assert r.status_code == 401


def test_key_tools_work_anonymously(http):
    _, created = call(http, "create_session", token=TOKEN, name="geteilt")
    key = created["result"]["structuredContent"]["key"]
    r, moved = call(http, "move_fov", session_key=key, delta_mm=[0, 0, 5])
    assert r.status_code == 200 and not moved["result"].get("isError")
    assert moved["result"]["structuredContent"]["fov"]["center_mm"] == [0, 0, 5]
    _, listed = call(http, "list_sessions", token=TOKEN)
    assert [s["key"] for s in listed["result"]["structuredContent"]["result"]] == [key]


def test_web_routes(http):
    assert http.get("/health").json() == {"ok": True}
    assert http.get("/s/abc").status_code == 200


def test_authkit_provider_wiring():
    """The real provider: metadata points to AuthKit, the audience is our /mcp."""
    from anyfield.auth import authkit_auth

    auth = authkit_auth("https://testserver", "https://example.authkit.app")
    mcp = build(MemoryStore(), "https://testserver", auth=auth)
    with TestClient(http_app(mcp), base_url="https://testserver") as c:
        meta = c.get("/.well-known/oauth-protected-resource/mcp").json()
        assert meta["resource"] == "https://testserver/mcp"
        assert meta["authorization_servers"] == ["https://example.authkit.app/"]
        assert auth.token_verifier.audience == "https://testserver/mcp"
        r, _ = call(c, "create_session")
        assert r.status_code == 401 and "resource_metadata" in r.headers["www-authenticate"]
        r, _ = rpc(c, "tools/list")
        assert r.status_code == 200


def test_alias_host_redirects_pages_to_base_url():
    mcp = build(MemoryStore(), "https://testserver")
    with TestClient(http_app(mcp), base_url="https://alias.test") as c:
        r = c.get("/s/abc?x=1", follow_redirects=False)
        assert r.status_code == 308
        assert r.headers["location"] == "https://testserver/s/abc?x=1"


def test_forwarded_host_decides_redirect():
    """Behind the Cloudflare worker: Host is modal.run, X-Forwarded-Host the public
    host. No redirect then (else an endless loop), but a direct modal.run
    request, or one for another host, is sent to the public URL."""
    mcp = build(MemoryStore(), "https://app.anyfield.net")
    forwarded = {"x-forwarded-host": "app.anyfield.net", "x-forwarded-proto": "https"}
    with TestClient(http_app(mcp), base_url="http://anyfield-web.modal.test") as c:
        r = c.get("/s/abc", headers=forwarded, follow_redirects=False)
        assert r.status_code == 200
        r = c.get("/s/abc", headers={"x-forwarded-host": "other.test"}, follow_redirects=False)
        assert r.status_code == 308
        r = c.get("/s/abc?x=1", follow_redirects=False)
        assert r.status_code == 308
        assert r.headers["location"] == "https://app.anyfield.net/s/abc?x=1"


def test_forwarded_headers_set_public_url():
    """X-Forwarded-Host and -Proto reach `request.url` (first entry each)."""
    from starlette.applications import Starlette
    from starlette.middleware import Middleware
    from starlette.responses import PlainTextResponse
    from starlette.routing import Route

    from anyfield.server import ForwardedHeaders

    app = Starlette(
        routes=[Route("/", lambda request: PlainTextResponse(str(request.url)))],
        middleware=[Middleware(ForwardedHeaders)],
    )
    with TestClient(app, base_url="http://anyfield-web.modal.test") as c:
        headers = {"x-forwarded-host": "app.anyfield.net, proxy.test", "x-forwarded-proto": "https"}
        assert c.get("/?a=1", headers=headers).text == "https://app.anyfield.net/?a=1"
        assert c.get("/").text == "http://anyfield-web.modal.test/"


def test_protected_resource_behind_worker():
    """Resource metadata and audience are the public URL, also via modal.run."""
    from anyfield.auth import authkit_auth

    auth = authkit_auth("https://app.anyfield.net", "https://example.authkit.app")
    mcp = build(MemoryStore(), "https://app.anyfield.net", auth=auth)
    forwarded = {"x-forwarded-host": "app.anyfield.net", "x-forwarded-proto": "https"}
    with TestClient(http_app(mcp), base_url="http://anyfield-web.modal.test") as c:
        meta = c.get("/.well-known/oauth-protected-resource/mcp", headers=forwarded).json()
        assert meta["resource"] == "https://app.anyfield.net/mcp"
        assert auth.token_verifier.audience == "https://app.anyfield.net/mcp"
        r, _ = rpc(c, "tools/call", {"name": "list_sessions", "arguments": {}}, headers=forwarded)
        assert r.status_code == 401
        assert (
            "https://app.anyfield.net/.well-known/oauth-protected-resource/mcp"
            in r.headers["www-authenticate"]
        )
