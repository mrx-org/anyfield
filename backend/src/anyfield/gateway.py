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
from fastmcp import Client
from fastmcp.exceptions import ToolError
from fastmcp.server.dependencies import get_access_token

# The gateway's public URL (Cloudflare worker in front of Modal). `<GATEWAY_URL>/mcp`
# is also the resource (token audience) of exchanged tokens.
GATEWAY_URL = "https://mcp.anyfield.net"
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
        JSON); raises `ToolError` if it failed."""
        access = get_access_token()
        token = await self.token(access.token if access is not None else None)
        async with Client(f"{self.url}/mcp", auth=token) as client:
            result = await client.call_tool(name, arguments or {}, raise_on_error=False)
        text = "\n".join(getattr(c, "text", "") for c in result.content)
        if result.is_error:
            raise ToolError(f"MRX gateway, {name}: {text or 'failed'}")
        if result.structured_content is not None:
            return result.structured_content
        try:
            return json.loads(text)
        except ValueError:
            return text

    async def _post(self, url: str, **kwargs: Any) -> httpx.Response:
        if self.http is not None:
            return await self.http.post(url, **kwargs)
        async with httpx.AsyncClient(timeout=30) as http:
            return await http.post(url, **kwargs)
