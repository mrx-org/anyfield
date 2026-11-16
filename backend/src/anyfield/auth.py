"""Login: GitHub OAuth, but only where it is needed.

Managing sessions (list, create, rename, delete) needs a GitHub login. Every
other tool needs only the session key, passed as a tool argument: whoever knows
it may use the session, so it can be shared.

Everything runs on the one endpoint `/mcp`. A request without a token passes,
unless it calls a tool in `LOGIN_TOOLS`: that one gets the 401 that makes an
MCP client start the OAuth flow. A request with a token is always checked.
"""

from __future__ import annotations

import json
import os
from typing import Any

import anyio
from cryptography.fernet import Fernet
from fastmcp.exceptions import ToolError
from fastmcp.server.auth import AuthProvider
from fastmcp.server.auth.jwt_issuer import derive_jwt_key
from fastmcp.server.auth.middleware import RequireAuthMiddleware
from fastmcp.server.auth.providers.github import GitHubProvider
from fastmcp.server.dependencies import get_access_token
from key_value.aio._utils.managed_entry import ManagedEntry
from key_value.aio.protocols import AsyncKeyValue
from key_value.aio.stores.base import BaseStore
from key_value.aio.wrappers.encryption import FernetEncryptionWrapper
from pydantic import BaseModel
from starlette.routing import Route
from starlette.types import ASGIApp, Message, Receive, Scope, Send

LOGIN_TOOLS = frozenset({"list_sessions", "create_session", "rename_session", "delete_session"})

# Enough to read the caller's GitHub user id
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
        raise ToolError("Login required: this tool needs a GitHub login (OAuth).")
    return user


def github_auth(base_url: str, client_storage: AsyncKeyValue | None = None) -> GitHubProvider:
    """Raises `KeyError` if the OAuth app's secrets are not set."""
    client_secret = os.environ["GITHUB_OAUTH_CLIENT_SECRET"]
    return GitHubProvider(
        client_id=os.environ["GITHUB_OAUTH_CLIENT_ID"],
        client_secret=client_secret,
        base_url=base_url,
        required_scopes=SCOPES,
        client_storage=client_storage,
        # Verifying a token costs GitHub API calls; without a cache on every request
        cache_ttl_seconds=300,
    )


class DictKeyValue(BaseStore):
    """fastmcp's OAuth state (client registrations, codes, tokens) in a Modal Dict,
    so that every container sees it. Same idea as `auth/oauth_store.py` in the
    mcp-gateway. Expired entries are dropped on read by `BaseStore`."""

    def __init__(self, dict_) -> None:
        super().__init__(stable_api=True)
        self.dict = dict_

    async def _get_managed_entry(self, *, key: str, collection: str) -> ManagedEntry | None:
        value = await self.dict.get.aio(f"{collection}:{key}")
        return None if value is None else self._serialization_adapter.load_json(json_str=value)

    async def _put_managed_entry(self, *, key: str, collection: str, managed_entry: ManagedEntry) -> None:
        value = self._serialization_adapter.dump_json(entry=managed_entry, key=key, collection=collection)
        await self.dict.put.aio(f"{collection}:{key}", value)

    async def _delete_managed_entry(self, *, key: str, collection: str) -> bool:
        return await self.dict.pop.aio(f"{collection}:{key}", None) is not None


def encrypted(store: AsyncKeyValue) -> AsyncKeyValue:
    """`store`, encrypted with a key derived from the OAuth client secret."""
    key = derive_jwt_key(
        high_entropy_material=os.environ["GITHUB_OAUTH_CLIENT_SECRET"], salt="anyfield-oauth-storage"
    )
    return FernetEncryptionWrapper(key_value=store, fernet=Fernet(key=key), raise_on_decryption_error=False)


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
    "DictKeyValue",
    "User",
    "current_user",
    "encrypted",
    "github_auth",
    "make_login_on_demand",
    "require_user",
]
