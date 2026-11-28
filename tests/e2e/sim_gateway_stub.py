"""Answer the Modal HTTP sim gateway's job protocol from memory, without simulating.

`DEFAULT_SIM_BACKEND_ID` in scan_zero/sim_backends.js is `pdgo1_t4`, whose
`transport` is `'http'`, so the whole remote half of a scan is three plain HTTP calls
against `TOOL_PDGO1_HTTP` (see `_httpSubmitJob` / `_httpGetStatus` /
`_httpFetchResultNpz`). That makes the scan pipeline drivable with `page.route()` alone --
no WebSocket interception, and no GPU.

    POST {base}/v1/jobs              multipart: seq blob + options JSON  -> {"job_id": ...}
    GET  {base}/v1/jobs/{id}         -> {"status": "done", ...}
    GET  {base}/v1/jobs/{id}/result  -> raw .npz bytes (signal + ktraj)

The status reply goes straight to `done` on the first poll: `_httpPollOnce` treats any other
value as still-running, so a queued/running phase would only add wall time to the test
without covering a branch the finished path does not already reach.

Unmatched paths on that host are recorded and answered with an obviously-broken status,
the same contract as github_stub.py -- if the app starts calling something new on the
gateway, the test says so instead of silently reaching Modal.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from playwright.sync_api import Page, Route

# scan_zero/sim_backends.js: TOOL_PDGO1_HTTP, the httpBaseUrl of pdgo1_t4
# (DEFAULT_SIM_BACKEND_ID). `_getHttpSimBaseUrl` uses the job's own gateway unless
# window.ANYFIELD_HTTP_SIM_URL overrides it.
GATEWAY_BASE = "https://mzaiss--pdgo1-gateway.modal.run"

JOB_ID = "e2e-sim-job"

# The page is on 127.0.0.1, so a fulfilled cross-origin response still faces the normal
# CORS check.
CORS_HEADERS = {"access-control-allow-origin": "*"}
JSON_CONTENT_TYPE = "application/json; charset=utf-8"
NPZ_CONTENT_TYPE = "application/octet-stream"

# Not a real HTTP status: an unmatched gateway path must not look like anything
# _httpFetchWithRetry knows how to retry.
UNMATCHED_STATUS = 599


@dataclass
class SimGatewayStub:
    """What the gateway was asked for, in order, plus anything it could not answer."""

    requests: list[str] = field(default_factory=list)
    unmatched: list[str] = field(default_factory=list)
    # Raw multipart bodies of the submits, kept as bytes: the `seq` part is a binary blob,
    # so decoding the whole body as text is not safe.
    submit_bodies: list[bytes] = field(default_factory=list)

    def unmatched_report(self) -> str:
        return "\n  ".join(self.unmatched)


def install_sim_gateway_stub(page: Page, result_npz: bytes) -> SimGatewayStub:
    """Route the sim gateway for one page, answering every job with `result_npz`.

    Installed per page rather than per context: the result bytes are the test's own
    payload, and nothing else in a boot touches this host.
    """
    stub = SimGatewayStub()

    def handler(route: Route) -> None:
        request = route.request
        path = request.url[len(GATEWAY_BASE):].split("?")[0]
        stub.requests.append(f"{request.method} {path}")

        if request.method == "POST" and path == "/v1/jobs":
            # The `options` part carries the phantom id and worker choice; recorded so a
            # test can assert the submission was built, not just that a POST happened.
            stub.submit_bodies.append(request.post_data_buffer or b"")
            route.fulfill(
                status=200,
                headers={**CORS_HEADERS, "content-type": JSON_CONTENT_TYPE},
                body=f'{{"job_id": "{JOB_ID}"}}',
            )
            return
        if request.method == "GET" and path == f"/v1/jobs/{JOB_ID}":
            route.fulfill(
                status=200,
                headers={**CORS_HEADERS, "content-type": JSON_CONTENT_TYPE},
                body='{"status": "done", "message": "finished"}',
            )
            return
        if request.method == "GET" and path == f"/v1/jobs/{JOB_ID}/result":
            route.fulfill(
                status=200,
                headers={**CORS_HEADERS, "content-type": NPZ_CONTENT_TYPE},
                body=result_npz,
            )
            return

        stub.unmatched.append(f"{request.method} {request.url}")
        route.fulfill(
            status=UNMATCHED_STATUS,
            headers={**CORS_HEADERS, "content-type": "text/plain; charset=utf-8"},
            body=(
                f"tests/e2e/sim_gateway_stub.py does not answer {request.method} {path}. "
                "The e2e suite must not reach the Modal sim gateway: extend the stub."
            ),
        )

    page.route(f"{GATEWAY_BASE}/**", handler)
    return stub
