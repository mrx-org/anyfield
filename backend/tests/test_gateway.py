"""Calls to the gateway: token exchange at AuthKit for a user, the visitor key without one."""

from urllib.parse import parse_qs

import httpx
import pytest
from fastmcp.exceptions import ToolError

from anyfield.gateway import ACCESS_TOKEN_TYPE, TOKEN_EXCHANGE, GatewayClient


def gateway(requests: list[httpx.Request], status: int = 200, **kwargs) -> GatewayClient:
    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(status, json={"access_token": f"gw-{len(requests)}", "expires_in": 300})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    auth = {"authkit_domain": "https://auth.test/", "client_id": "client_1", "client_secret": "secret"}
    return GatewayClient("https://gateway.test/", "visitor-key", http=http, **(auth | kwargs))


async def test_visitor_without_login():
    requests = []
    assert await gateway(requests).token(None) == "visitor-key"
    assert requests == []


async def test_visitor_without_workos_client():
    requests = []
    assert await gateway(requests, client_secret=None).token("alice") == "visitor-key"
    assert requests == []


async def test_user_token_is_exchanged_once():
    requests = []
    client = gateway(requests)
    assert await client.token("alice") == "gw-1"
    assert await client.token("alice") == "gw-1"
    assert await client.token("bob") == "gw-2"
    assert len(requests) == 2

    request = requests[0]
    assert str(request.url) == "https://auth.test/oauth2/token"
    form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
    assert form == {
        "grant_type": TOKEN_EXCHANGE,
        "subject_token": "alice",
        "subject_token_type": ACCESS_TOKEN_TYPE,
        "resource": "https://gateway.test/mcp",
        "client_id": "client_1",
        "client_secret": "secret",
    }


async def test_refused_exchange_is_a_tool_error():
    with pytest.raises(ToolError, match="Token exchange"):
        await gateway([], status=400).token("alice")
