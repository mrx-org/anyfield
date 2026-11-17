"""Calls to the gateway: token exchange for a user, the visitor key without one."""

import httpx
import pytest
from fastmcp.exceptions import ToolError

from anyfield.gateway import ACCESS_TOKEN_TYPE, TOKEN_EXCHANGE, GatewayClient


def gateway(requests: list[httpx.Request], status: int = 200) -> GatewayClient:
    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        n = len(requests)
        return httpx.Response(status, json={"access_token": f"gw-{n}", "expires_in": 3600})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    return GatewayClient("https://gateway.test/", "secret", "visitor-key", http=http)


async def test_visitor_without_login():
    requests = []
    assert await gateway(requests).token(None) == "visitor-key"
    assert requests == []


async def test_user_token_is_exchanged_once():
    requests = []
    client = gateway(requests)
    assert await client.token("alice") == "gw-1"
    assert await client.token("alice") == "gw-1"
    assert await client.token("bob") == "gw-2"
    assert len(requests) == 2

    request = requests[0]
    assert str(request.url) == "https://gateway.test/token"
    assert request.headers["authorization"].startswith("Basic ")
    form = dict(httpx.QueryParams(request.content.decode()))
    assert form == {
        "grant_type": TOKEN_EXCHANGE,
        "subject_token": "alice",
        "subject_token_type": ACCESS_TOKEN_TYPE,
        "resource": "https://gateway.test/mcp",
    }


async def test_refused_exchange():
    with pytest.raises(ToolError):
        await gateway([], status=400).token("alice")


def test_from_env(monkeypatch):
    monkeypatch.delenv("ANYFIELD_CLIENT_SECRET", raising=False)
    assert GatewayClient.from_env() is None
    monkeypatch.setenv("ANYFIELD_CLIENT_SECRET", "s")
    monkeypatch.setenv("MRX_VISITOR_KEY", "v")
    assert GatewayClient.from_env().url == "https://mrx-org--mcp-gateway-func.modal.run"
