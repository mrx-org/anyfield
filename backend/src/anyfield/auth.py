"""Login: WorkOS AuthKit, but only where it is needed.

AuthKit is the authorization server (GitHub or e-mail login); anyfield is only
a resource server. It checks the AuthKit JWT (JWKS) and its audience, which is
anyfield's `/mcp` URL (a Resource Indicator in WorkOS). A user is the token's
`sub` (WorkOS user id).

Managing projects (list, create, rename, delete) needs a login. Every other
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
from fastmcp.server.auth import AuthProvider
from fastmcp.server.auth.middleware import RequireAuthMiddleware
from fastmcp.server.auth.providers.workos import AuthKitProvider
from fastmcp.server.dependencies import get_access_token
from pydantic import BaseModel
from starlette.routing import Route
from starlette.types import ASGIApp, Message, Receive, Scope, Send

LOGIN_TOOLS = frozenset({"list_projects", "create_project", "rename_project", "delete_project"})


class User(BaseModel):
    id: str
    login: str | None = None


def current_user() -> User | None:
    token = get_access_token()
    if token is None or not token.claims.get("sub"):
        # Only `python -m anyfield` (in memory, no OAuth) sets this; never on Modal
        dev_user = os.environ.get("ANYFIELD_DEV_USER")
        return User(id=dev_user, login=dev_user) if dev_user else None
    return User(id=str(token.claims["sub"]), login=token.claims.get("email"))


def require_user() -> User:
    user = current_user()
    if user is None:
        raise ToolError("Login required: this tool needs a login (OAuth).")
    return user


def authkit_auth(base_url: str, authkit_domain: str | None = None) -> AuthKitProvider:
    """Tokens from AuthKit with audience `<base_url>/mcp`. The domain defaults to
    `WORKOS_AUTHKIT_DOMAIN` (Modal secret `workos-anyfield`)."""
    return AuthKitProvider(
        authkit_domain=authkit_domain or os.environ["WORKOS_AUTHKIT_DOMAIN"],
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
    "LOGIN_TOOLS",
    "AuthProvider",
    "User",
    "authkit_auth",
    "current_user",
    "make_login_on_demand",
    "require_user",
]
