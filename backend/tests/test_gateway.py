"""Calls to the gateway: token exchange at AuthKit for a user, the visitor key without one."""

import json
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


def gateway_answering(answer, requests: list[httpx.Request]) -> GatewayClient:
    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return answer(request)

    http = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    return GatewayClient("https://gateway.test", "visitor-key", http=http)


async def test_call_tool_is_one_request():
    """One stateless tools/call (no initialize, no tools/list), SSE answer."""
    requests = []

    def answer(request):
        body = {
            "jsonrpc": "2.0",
            "id": 1,
            "result": {"content": [], "structuredContent": {"collections": []}},
        }
        sse = f"event: message\ndata: {json.dumps(body)}\n\n"
        return httpx.Response(200, text=sse, headers={"content-type": "text/event-stream"})

    client = gateway_answering(answer, requests)
    assert await client.call_tool("bifti_list_collections") == {"collections": []}
    assert len(requests) == 1
    sent = json.loads(requests[0].content)
    assert sent["method"] == "tools/call" and sent["params"] == {
        "name": "bifti_list_collections",
        "arguments": {},
    }
    assert requests[0].headers["authorization"] == "Bearer visitor-key"


async def test_call_tool_text_and_errors():
    def text(request):
        result = {"content": [{"type": "text", "text": '{"a": 1}'}]}
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": result})

    assert await gateway_answering(text, []).call_tool("t") == {"a": 1}

    def tool_error(request):
        result = {"isError": True, "content": [{"type": "text", "text": "unknown collection"}]}
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": result})

    with pytest.raises(ToolError, match="unknown collection"):
        await gateway_answering(tool_error, []).call_tool("t")
    with pytest.raises(ToolError, match="HTTP 401"):
        await gateway_answering(lambda r: httpx.Response(401), []).call_tool("t")
