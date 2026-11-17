"""Login: through the MRX gateway, but only where it is needed.

The gateway is the authorization server (GitHub login); anyfield has no OAuth
app of its own. Its tokens carry anyfield's `/mcp` as audience, and anyfield
checks them by introspection at the gateway with its client credentials (see
`mcp-gateway/docs/security.md`, "Other resource servers"). The same
credentials exchange a user's token for a gateway token (`gateway.py`).

Managing sessions (list, create, rename, delete) needs a login. Every other
tool needs only the session key, passed as a tool argument: whoever knows it
may use the session, so it can be shared.

Everything runs on the one endpoint `/mcp`. A request without a token passes,
unless it calls a tool in `LOGIN_TOOLS`: that one gets the 401 that makes an
MCP client start the OAuth flow. A request with a token is always checked.
"""

from __future__ import annotations

import json
import os
from typing import Any

import anyio
from fastmcp.exceptions import ToolError
from fastmcp.server.auth import AuthProvider, RemoteAuthProvider
from fastmcp.server.auth.middleware import RequireAuthMiddleware
from fastmcp.server.auth.providers.introspection import IntrospectionTokenVerifier
from fastmcp.server.dependencies import get_access_token
from pydantic import AnyHttpUrl, BaseModel
from starlette.routing import Route
from starlette.types import ASGIApp, Message, Receive, Scope, Send

# anyfield's client at the gateway
CLIENT_ID = "anyfield"

LOGIN_TOOLS = frozenset({"list_sessions", "create_session", "rename_session", "delete_session"})

# What the gateway grants: enough to read the caller's GitHub user id
SCOPES = ["read:user"]


class User(BaseModel):
    id: str
    login: str | None = None


def current_user() -> User | None:
    token = get_access_token()
    if token is None or not token.claims.get("sub"):
        # Only `python -m anyfield` (in memory, no OAuth) sets this; never on Modal
        dev_user = os.environ.get("ANYFIELD_DEV_USER")
        return User(id=dev_user, login=dev_user) if dev_user else None
    return User(id=str(token.claims["sub"]), login=token.claims.get("login"))


def require_user() -> User:
    user = current_user()
    if user is None:
        raise ToolError("Login required: this tool needs a GitHub login (OAuth, through the MRX gateway).")
    return user


def gateway_auth(base_url: str, gateway_url: str, client_secret: str) -> RemoteAuthProvider:
    """Tokens from the gateway at `gateway_url`, checked there by introspection.
    `client_secret` is anyfield's at the gateway (`ANYFIELD_CLIENT_SECRET`)."""
    gateway_url = gateway_url.rstrip("/")
    verifier = IntrospectionTokenVerifier(
        introspection_url=f"{gateway_url}/introspect",
        client_id=CLIENT_ID,
        client_secret=client_secret,
        required_scopes=SCOPES,
        # An introspection reaches GitHub through the gateway; without a cache on every request
        cache_ttl_seconds=300,
    )
    return RemoteAuthProvider(
        token_verifier=verifier,
        authorization_servers=[AnyHttpUrl(gateway_url)],
        base_url=base_url,
        resource_name="anyfield",
    )


class LoginOnDemand:
    """Wraps fastmcp's `RequireAuthMiddleware` on `/mcp` so that only
    `LOGIN_TOOLS` calls and requests that carry a token go through it."""

    def __init__(self, require_auth: RequireAuthMiddleware) -> None:
        self.require_auth = require_auth
        self.inner: ASGIApp = require_auth.app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or _has_auth_header(scope):
            await self.require_auth(scope, receive, send)
            return
        body, replay = await _buffer_body(receive)
        target = self.require_auth if _calls_login_tool(body) else self.inner
        await target(scope, replay, send)


def make_login_on_demand(app: Any, mcp_path: str = "/mcp") -> None:
    """Replace the strict auth on `mcp_path` in an app from `FastMCP.http_app`."""
    for route in app.routes:
        if (
            isinstance(route, Route)
            and route.path == mcp_path
            and isinstance(route.app, RequireAuthMiddleware)
        ):
            route.app = LoginOnDemand(route.app)
            return
    raise RuntimeError(f"No auth-protected route at {mcp_path}")


def _has_auth_header(scope: Scope) -> bool:
    return any(name.lower() == b"authorization" for name, _ in scope.get("headers", []))


async def _buffer_body(receive: Receive) -> tuple[bytes, Receive]:
    chunks: list[bytes] = []
    more = True
    while more:
        message = await receive()
        if message["type"] != "http.request":
            break
        chunks.append(message.get("body", b""))
        more = message.get("more_body", False)
    body = b"".join(chunks)
    sent = False

    async def replay() -> Message:
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        # After the body: wait like a real connection does until it closes
        await anyio.sleep_forever()
        return {"type": "http.disconnect"}

    return body, replay


def _calls_login_tool(body: bytes) -> bool:
    try:
        payload = json.loads(body) if body else None
    except ValueError:
        return False
    messages = payload if isinstance(payload, list) else [payload]
    return any(
        isinstance(m, dict)
        and m.get("method") == "tools/call"
        and isinstance(m.get("params"), dict)
        and m["params"].get("name") in LOGIN_TOOLS
        for m in messages
    )


__all__ = [
    "CLIENT_ID",
    "LOGIN_TOOLS",
    "AuthProvider",
    "User",
    "current_user",
    "gateway_auth",
    "make_login_on_demand",
    "require_user",
]
