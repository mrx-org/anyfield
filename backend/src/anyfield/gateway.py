"""Calls to the MRX gateway's tools, as the user who triggered them.

A logged-in user's token has anyfield as audience and must not be passed on.
It is exchanged at AuthKit for a gateway token of the same user (RFC 8693,
`act.sub` = anyfield's client id) and cached until shortly before it expires.
Without a login - a shared session, the in-memory test server - the call goes
out as `visitor`, with the visitor key. See `docs/security.md` in the
mcp-gateway, section "anyfield".
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from typing import Any

import httpx
from fastmcp.exceptions import ToolError
from fastmcp.server.dependencies import get_access_token

GATEWAY_URL = "https://mrx-org--mcp-gateway-func.modal.run"
TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange"
ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token"

# An exchanged token is replaced this long before it expires (AuthKit: 5 min)
EXPIRY_MARGIN = 30  # seconds
MAX_CACHED = 1000


class GatewayClient:
    def __init__(
        self,
        url: str,
        visitor_key: str,
        *,
        authkit_domain: str | None = None,
        client_id: str | None = None,
        client_secret: str | None = None,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        self.url = url.rstrip("/")
        self.visitor_key = visitor_key
        self.authkit_domain = authkit_domain.rstrip("/") if authkit_domain else None
        self.client_id = client_id
        self.client_secret = client_secret
        self.http = http
        # sha256 of the user's token -> (gateway token, monotonic expiry)
        self._tokens: dict[str, tuple[str, float]] = {}

    @classmethod
    def from_env(cls) -> GatewayClient | None:
        """From the Modal secrets `mrx-visitor` and `workos-anyfield`; `None`
        without a visitor key. Without the WorkOS client, every call goes out
        as `visitor`."""
        visitor = os.environ.get("MRX_VISITOR_KEY")
        if not visitor:
            return None
        return cls(
            os.environ.get("MRX_GATEWAY_URL", GATEWAY_URL),
            visitor,
            authkit_domain=os.environ.get("WORKOS_AUTHKIT_DOMAIN"),
            client_id=os.environ.get("WORKOS_CLIENT_ID"),
            client_secret=os.environ.get("WORKOS_CLIENT_SECRET"),
        )

    async def token(self, user_token: str | None = None) -> str:
        """The bearer token for the gateway: the exchanged token of the user
        whose token this is, the visitor key without one."""
        if user_token is None or not (self.authkit_domain and self.client_id and self.client_secret):
            return self.visitor_key
        key = hashlib.sha256(user_token.encode()).hexdigest()
        now = time.monotonic()
        cached = self._tokens.get(key)
        if cached is not None and cached[1] > now:
            return cached[0]

        response = await self._post(
            f"{self.authkit_domain}/oauth2/token",
            data={
                "grant_type": TOKEN_EXCHANGE,
                "subject_token": user_token,
                "subject_token_type": ACCESS_TOKEN_TYPE,
                "resource": f"{self.url}/mcp",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            },
        )
        if response.status_code != 200:
            raise ToolError(f"Token exchange for the MRX gateway failed ({response.status_code}).")
        body = response.json()

        if len(self._tokens) >= MAX_CACHED:
            self._tokens = {k: v for k, v in self._tokens.items() if v[1] > now}
            if len(self._tokens) >= MAX_CACHED:
                self._tokens.clear()
        expires_in = int(body.get("expires_in", 300))
        self._tokens[key] = (body["access_token"], now + max(expires_in - EXPIRY_MARGIN, 0))
        return body["access_token"]

    async def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        """Call a gateway tool for the caller of the current request (see
        `token`). Returns the tool's structured result (or its text parsed as
        JSON); raises `ToolError` if it failed.

        One plain JSON-RPC `tools/call`: the gateway is stateless, so there is
        no session to open. (fastmcp's `Client` would send `initialize` and,
        to check the output schema, `tools/list` before every call.)"""
        access = get_access_token()
        token = await self.token(access.token if access is not None else None)
        response = await self._post(
            f"{self.url}/mcp",
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments or {}},
            },
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json, text/event-stream"},
        )
        if response.status_code != 200:
            raise ToolError(f"MRX gateway, {name}: HTTP {response.status_code}")
        message = _jsonrpc_message(response)
        if "error" in message:
            raise ToolError(f"MRX gateway, {name}: {message['error'].get('message', 'failed')}")
        result = message.get("result", {})
        text = "\n".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")
        if result.get("isError"):
            raise ToolError(f"MRX gateway, {name}: {text or 'failed'}")
        if result.get("structuredContent") is not None:
            return result["structuredContent"]
        try:
            return json.loads(text)
        except ValueError:
            return text

    async def _post(self, url: str, **kwargs: Any) -> httpx.Response:
        if self.http is not None:
            return await self.http.post(url, **kwargs)
        # Long timeout: gateway tools can compute for minutes
        async with httpx.AsyncClient(timeout=httpx.Timeout(600, connect=30)) as http:
            return await http.post(url, **kwargs)


def _jsonrpc_message(response: httpx.Response) -> dict[str, Any]:
    """The JSON-RPC response from a streamable-HTTP answer (plain JSON or SSE)."""
    if response.headers.get("content-type", "").startswith("text/event-stream"):
        for line in response.text.splitlines():
            if line.startswith("data:"):
                message = json.loads(line[5:])
                if "id" in message:
                    return message
        raise ToolError("MRX gateway: no response in the event stream")
    return response.json()
