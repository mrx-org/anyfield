"""Calls to the MRX gateway's tools, as the user who triggered them.

A logged-in user's token (audience anyfield) must not be passed on, so it is
exchanged at the gateway for a gateway token of the same user (RFC 8693) and
cached until shortly before it expires. Without a login - a shared session,
an MCP App - the call goes out as `visitor`, with the visitor key. See
`mcp-gateway/docs/security.md`, "Other resource servers".
"""

from __future__ import annotations

import hashlib
import os
import time
from typing import Any

import httpx
from fastmcp import Client
from fastmcp.exceptions import ToolError
from fastmcp.server.dependencies import get_access_token

from .auth import CLIENT_ID

GATEWAY_URL = "https://mrx-org--mcp-gateway-func.modal.run"
TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange"
ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token"

# An exchanged token is replaced this long before it expires
EXPIRY_MARGIN = 60  # seconds
MAX_CACHED = 1000


class GatewayClient:
    def __init__(
        self,
        url: str,
        client_secret: str,
        visitor_key: str,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        self.url = url.rstrip("/")
        self.client_secret = client_secret
        self.visitor_key = visitor_key
        self.http = http
        # sha256 of the user's token -> (gateway token, monotonic expiry)
        self._tokens: dict[str, tuple[str, float]] = {}

    @classmethod
    def from_env(cls) -> GatewayClient | None:
        """From the Modal secret `anyfield-gateway`; `None` where it is not set."""
        secret, visitor = os.environ.get("ANYFIELD_CLIENT_SECRET"), os.environ.get("MRX_VISITOR_KEY")
        if not secret or not visitor:
            return None
        return cls(os.environ.get("MRX_GATEWAY_URL", GATEWAY_URL), secret, visitor)

    async def token(self, user_token: str | None = None) -> str:
        """The bearer token for the gateway: the exchanged token of the user
        whose token this is, the visitor key without one."""
        if user_token is None:
            return self.visitor_key
        key = hashlib.sha256(user_token.encode()).hexdigest()
        now = time.monotonic()
        cached = self._tokens.get(key)
        if cached is not None and cached[1] > now:
            return cached[0]

        response = await self._post(
            f"{self.url}/token",
            data={
                "grant_type": TOKEN_EXCHANGE,
                "subject_token": user_token,
                "subject_token_type": ACCESS_TOKEN_TYPE,
                "resource": f"{self.url}/mcp",
            },
            auth=(CLIENT_ID, self.client_secret),
        )
        if response.status_code != 200:
            raise ToolError(f"MRX gateway refused the token exchange ({response.status_code}).")
        body = response.json()

        if len(self._tokens) >= MAX_CACHED:
            self._tokens = {k: v for k, v in self._tokens.items() if v[1] > now}
            if len(self._tokens) >= MAX_CACHED:
                self._tokens.clear()
        self._tokens[key] = (body["access_token"], now + int(body["expires_in"]) - EXPIRY_MARGIN)
        return body["access_token"]

    async def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        """Call a gateway tool for the caller of the current request (see
        `token`). Returns the tool's result; raises `ToolError` if it failed."""
        access = get_access_token()
        token = await self.token(access.token if access is not None else None)
        async with Client(f"{self.url}/mcp", auth=token) as client:
            return await client.call_tool(name, arguments or {})

    async def _post(self, url: str, **kwargs: Any) -> httpx.Response:
        if self.http is not None:
            return await self.http.post(url, **kwargs)
        async with httpx.AsyncClient(timeout=30) as http:
            return await http.post(url, **kwargs)
