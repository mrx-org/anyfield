"""The anyfield MCP server: small UI tools (phantom, FOV planner), optionally
bound to a session whose state is a small JSON. Browser, MCP App and AI all use
the same tools. Session management needs a login, the rest a session key."""

from __future__ import annotations

import asyncio
import time
from collections import defaultdict
from collections.abc import Callable
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import urlsplit

from fastmcp import FastMCP
from fastmcp.apps.config import AppConfig, ResourceCSP
from fastmcp.exceptions import ToolError
from pydantic import Field, ValidationError
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from starlette.routing import Mount
from starlette.staticfiles import StaticFiles
from starlette.types import ASGIApp, Receive, Scope, Send

from . import fov as fov_ops
from . import phantom_tools
from .auth import AuthProvider, make_login_on_demand, require_user
from .gateway import GATEWAY_URL, GatewayClient
from .models import PhantomChoice, Session, State, Vec3, merge_patch, new_key
from .phantoms import PROPERTY_KEYS, CasFiles, Catalog, PhantomMaps
from .store import SessionStore

FOV_APP_URI = "ui://anyfield/fov-planner.html"
MAX_SESSIONS_PER_USER = 200
MAX_MATRIX = 1024

SessionKey = Annotated[str, Field(description="Key of the session (from create_session or a shared link)")]
OptionalSessionKey = Annotated[
    str | None,
    Field(
        description="Optional session key: store the choice in that session. Without one it goes back to the chat"
    ),
]
Vec3Arg = Annotated[list[float], Field(min_length=3, max_length=3)]
ExpectedRev = Annotated[
    int | None, Field(description="Optional: fail instead of overwriting if the session changed since")
]


def build(
    store: SessionStore,
    base_url: str,
    *,
    auth: AuthProvider | None = None,
    static_dir: Path | None = None,
    catalog: Catalog | None = None,
    maps: PhantomMaps | None = None,
    cas: CasFiles | None = None,
    gateway: GatewayClient | None = None,
) -> FastMCP:
    """`gateway` serves the phantom catalog, CAS phantoms and maps; tests pass
    `catalog`, `cas` and `maps` instead."""
    base_url = base_url.rstrip("/")
    call = gateway.call_tool if gateway else None
    catalog = catalog or Catalog(call)
    maps = maps or PhantomMaps(call)
    cas = cas or CasFiles(call)
    mcp = FastMCP(
        "anyfield",
        instructions=(
            "anyfield is the user interface for planning virtual MRI scans: small tools to choose a "
            "phantom, view it and plan the field of view (FOV). Every UI tool works without a session "
            "(the user's choice comes back to the chat) or with a `session_key`: then the choice is "
            "stored in the session's state, a small JSON (`get_state`, `patch_state`), and the user "
            "sees changes in the browser within a second, and vice versa. Managing sessions "
            "(list/create/rename/delete) needs a login; all other tools only need the session key. "
            "Coordinates are world RAS in mm."
        ),
        auth=auth,
    )
    locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    def public(s: Session) -> dict[str, Any]:
        return {
            "key": s.key,
            "name": s.name,
            "rev": s.rev,
            "updated_at": s.updated_at,
            "state": s.state.model_dump(),
            "web_url": f"{base_url}/s/{s.key}",
        }

    async def load(key: str) -> Session:
        session = await store.get(key)
        if session is None:
            raise ToolError("Unknown session key.")
        return session

    async def save(session: Session) -> Session:
        session.rev += 1
        session.updated_at = time.time()
        await store.put(session)
        return session

    async def checked(old: State, new: State) -> State:
        """Validate a new state against the old one: FOV limits, known phantom and property."""
        try:
            fov = fov_ops.set_fov(new.fov, new.fov.center_mm, new.fov.rotation_deg, new.fov.size_mm)
        except ValueError as e:
            raise ToolError(str(e)) from e
        if any(not (1 <= m <= MAX_MATRIX) for m in new.matrix):
            raise ToolError(f"matrix values must be in [1, {MAX_MATRIX}]")
        # A CAS phantom needs no check: its hash is the permission
        if isinstance(new.phantom, PhantomChoice) and new.phantom != old.phantom:
            await phantom_tools.check(catalog, new.phantom.collection, new.phantom.name)
        if new.view.property not in PROPERTY_KEYS:
            raise ToolError(f"Unknown property {new.view.property!r}. Known: {', '.join(PROPERTY_KEYS)}")
        return new.model_copy(update={"fov": fov})

    async def change(
        session_key: str, fn: Callable[[State], State], expected_rev: int | None = None
    ) -> Session:
        """Apply `fn` to a session's state (validated), atomically per session."""
        async with locks[session_key]:
            session = await load(session_key)
            if expected_rev is not None and expected_rev != session.rev:
                raise ToolError(f"Conflict: session is at rev {session.rev}, not {expected_rev}. Re-read it.")
            try:
                new = fn(session.state.model_copy(deep=True))
            except (ValueError, ValidationError) as e:
                raise ToolError(str(e)) from e
            session.state = await checked(session.state, new)
            return await save(session)

    async def owned(key: str) -> Session:
        user = require_user()
        session = await load(key)
        if session.owner != user.id:
            raise ToolError("Only the owner of a session may rename or delete it.")
        return session

    # --- Session management (login required, see auth.LOGIN_TOOLS) ---------

    @mcp.tool(annotations={"readOnlyHint": True})
    async def list_sessions() -> list[dict[str, Any]]:
        """List the sessions of the logged-in user, most recently changed first."""
        user = require_user()
        sessions = [s for s in [await store.get(k) for k in await store.owned_by(user.id)] if s]
        sessions.sort(key=lambda s: s.updated_at, reverse=True)
        return [{"key": s.key, "name": s.name, "updated_at": s.updated_at, "rev": s.rev} for s in sessions]

    @mcp.tool
    async def create_session(name: str = "New session") -> dict[str, Any]:
        """Create a session owned by the logged-in user. Returns its key: anybody who
        has the key can open and change the session, so it can be shared."""
        user = require_user()
        keys = await store.owned_by(user.id)
        if len(keys) >= MAX_SESSIONS_PER_USER:
            raise ToolError(f"At most {MAX_SESSIONS_PER_USER} sessions per user. Delete some first.")
        session = Session(key=new_key(), name=name.strip() or "New session", owner=user.id)
        await save(session)
        await store.set_owned_by(user.id, [*keys, session.key])
        return public(session)

    @mcp.tool
    async def rename_session(session_key: SessionKey, name: str) -> dict[str, Any]:
        """Rename a session of the logged-in user."""
        async with locks[session_key]:
            session = await owned(session_key)
            session.name = name.strip() or session.name
            return public(await save(session))

    @mcp.tool(annotations={"destructiveHint": True})
    async def delete_session(session_key: SessionKey) -> str:
        """Delete a session of the logged-in user. Its key stops working."""
        async with locks[session_key]:
            session = await owned(session_key)
            await store.delete(session.key)
            keys = await store.owned_by(session.owner)
            await store.set_owned_by(session.owner, [k for k in keys if k != session.key])
        return f"Deleted session '{session.name}'."

    # --- Session state (session key only) ------------------------------------

    @mcp.tool(annotations={"readOnlyHint": True})
    async def get_state(
        session_key: SessionKey,
        known_rev: Annotated[
            int | None, Field(description="Last revision the caller has; if unchanged, only {rev, unchanged}")
        ] = None,
    ) -> dict[str, Any]:
        """A session: name, revision, its state (phantom, view, fov, matrix) and the
        link to open it in the browser."""
        session = await load(session_key)
        if known_rev is not None and known_rev == session.rev:
            return {"rev": session.rev, "unchanged": True}
        return public(session)

    @mcp.tool
    async def patch_state(
        session_key: SessionKey,
        patch: Annotated[
            dict[str, Any],
            Field(
                description="JSON Merge Patch (RFC 7386) on the state, e.g. "
                '{"view": {"property": "T1"}, "matrix": [256, 256, 1]}; '
                '{"phantom": null} selects the default phantom'
            ),
        ],
        expected_rev: ExpectedRev = None,
    ) -> dict[str, Any]:
        """Change several parts of a session's state at once. Returns the session."""
        session = await change(
            session_key,
            lambda st: State.model_validate(merge_patch(st.model_dump(), patch)),
            expected_rev,
        )
        return public(session)

    # --- FOV planner ---------------------------------------------------------

    async def change_fov(session_key: str, fn, expected_rev: int | None) -> dict[str, Any]:
        session = await change(
            session_key, lambda st: st.model_copy(update={"fov": fn(st.fov)}), expected_rev
        )
        fov = session.state.fov
        return {"rev": session.rev, "fov": fov.model_dump(), "summary": fov_ops.describe(fov)}

    @mcp.tool
    async def set_fov(
        session_key: SessionKey,
        center_mm: Annotated[Vec3Arg | None, Field(description="Center (x, y, z) in world mm")] = None,
        rotation_deg: Annotated[
            Vec3Arg | None, Field(description="Rotation about x, then y, then z, in degrees")
        ] = None,
        size_mm: Annotated[
            Vec3Arg | None, Field(description="Edge lengths (x, y, z) of the box in mm")
        ] = None,
        expected_rev: ExpectedRev = None,
    ) -> dict[str, Any]:
        """Set the field of view (absolute). Fields left out stay as they are."""
        return await change_fov(
            session_key,
            lambda f: fov_ops.set_fov(f, _v(center_mm), _v(rotation_deg), _v(size_mm)),
            expected_rev,
        )

    @mcp.tool
    async def move_fov(
        session_key: SessionKey,
        delta_mm: Annotated[Vec3Arg, Field(description="Shift (x, y, z) in world mm")],
        expected_rev: ExpectedRev = None,
    ) -> dict[str, Any]:
        """Shift the field of view by a vector in world coordinates."""
        return await change_fov(session_key, lambda f: fov_ops.move_fov(f, _v(delta_mm)), expected_rev)

    @mcp.tool
    async def rotate_fov(
        session_key: SessionKey,
        delta_deg: Annotated[Vec3Arg, Field(description="Degrees added to the rotation about x, y, z")],
        expected_rev: ExpectedRev = None,
    ) -> dict[str, Any]:
        """Rotate the field of view: adds to its rotation angles."""
        return await change_fov(session_key, lambda f: fov_ops.rotate_fov(f, _v(delta_deg)), expected_rev)

    @mcp.tool(app=AppConfig(resource_uri=FOV_APP_URI), annotations={"readOnlyHint": True})
    async def open_fov_planner(session_key: OptionalSessionKey = None) -> dict[str, Any]:
        """Show the interactive FOV planner (phantom with the FOV box and the scan
        matrix). With a session it edits the session's FOV; without one the user
        plans locally and sends the result back to the chat. In clients without
        MCP Apps this returns the state and the web link."""
        return await opened(session_key)

    async def opened(session_key: str | None) -> dict[str, Any]:
        if session_key:
            return public(await load(session_key))
        return {"key": None, "state": State().model_dump()}

    app_html(mcp, FOV_APP_URI, "FOV planner", "fov-app.html", base_url, static_dir)

    # --- Phantoms (BIfTI): a separate tool ----------------------------------

    phantom_tools.register(
        mcp,
        phantom_tools.Ctx(base_url=base_url, change=change, public=public, opened=opened),
        catalog=catalog,
        maps=maps,
        cas=cas,
        static_dir=static_dir,
    )

    # --- HTTP routes ----------------------------------------------------------

    @mcp.custom_route("/health", methods=["GET"])
    async def health(_: Request) -> Response:
        return JSONResponse({"ok": True})

    base_host = urlsplit(base_url).netloc

    async def index(request: Request) -> Response:
        # Login only works on the base URL: it is the token audience, and the
        # browser's origin must be allowed at AuthKit. Send other hosts (the
        # modal.run URL) there. The host is the public one (`ForwardedHeaders`),
        # so requests through the Cloudflare worker are not redirected again.
        if request.url.netloc != base_host:
            target = base_url + request.url.path + (f"?{request.url.query}" if request.url.query else "")
            return RedirectResponse(target, status_code=308)
        page = static_dir / "index.html" if static_dir else None
        if page and page.exists():
            return FileResponse(page)
        return HTMLResponse("<!doctype html><p>anyfield: frontend not built.</p>")

    mcp.custom_route("/", methods=["GET"])(index)
    mcp.custom_route("/s/{key}", methods=["GET"])(index)
    mcp._anyfield_static_dir = static_dir  # read by http_app below
    return mcp


def app_html(mcp: FastMCP, uri: str, name: str, file: str, base_url: str, static_dir: Path | None) -> None:
    """Register an MCP App's HTML (a single-file build in `static_dir`) as resource `uri`."""

    @mcp.resource(
        uri,
        name=name,
        app=AppConfig(
            csp=ResourceCSP(connect_domains=[base_url, GATEWAY_URL], resource_domains=[base_url, GATEWAY_URL])
        ),
    )
    def html() -> str:
        path = static_dir / file if static_dir else None
        if path and path.exists():
            return path.read_text()
        return f"<!doctype html><p>{name} not built (frontend/dist missing).</p>"


def http_app(mcp: FastMCP):
    """ASGI app: `/mcp` (login on demand), OAuth routes, web app."""
    app = mcp.http_app(path="/mcp", stateless_http=True, middleware=_middleware())
    if mcp.auth is not None:
        make_login_on_demand(app, "/mcp")
    static_dir = getattr(mcp, "_anyfield_static_dir", None)
    if static_dir and (static_dir / "assets").exists():
        app.routes.append(Mount("/assets", StaticFiles(directory=static_dir / "assets")))
    return app


def _v(v: list[float] | None) -> Vec3 | None:
    return None if v is None else (v[0], v[1], v[2])


class ForwardedHeaders:
    """Behind the Cloudflare worker, requests arrive for the modal.run host.
    Take the public host from X-Forwarded-Host, else X-Original-Host, and the
    scheme from X-Forwarded-Proto (first line and entry each), so `request.url`
    and everything built from it shows the public URL. Without the headers
    nothing changes.

    Modal's proxy drops X-Forwarded-Host/-Proto (scheme is https there anyway),
    so the worker must also send X-Original-Host."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in ("http", "websocket"):
            headers: dict[bytes, bytes] = {}
            for k, v in scope["headers"]:
                headers.setdefault(k.lower(), v)
            host = _first(headers.get(b"x-forwarded-host")) or _first(headers.get(b"x-original-host"))
            proto = _first(headers.get(b"x-forwarded-proto"))
            if host or proto:
                scope = dict(scope)
                if host:
                    scope["headers"] = [(k, v) for k, v in scope["headers"] if k.lower() != b"host"]
                    scope["headers"].append((b"host", host.encode("latin-1")))
                if proto:
                    ws = scope["type"] == "websocket"
                    scope["scheme"] = {"https": "wss" if ws else "https", "http": "ws" if ws else "http"}.get(
                        proto.lower(), scope.get("scheme", "http")
                    )
        await self.app(scope, receive, send)


def _first(value: bytes | None) -> str:
    return value.decode("latin-1").split(",")[0].strip() if value else ""


def _middleware() -> list[Middleware]:
    return [
        Middleware(ForwardedHeaders),
        Middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_methods=["GET", "POST", "OPTIONS", "DELETE"],
            allow_headers=["*"],
            expose_headers=["Mcp-Session-Id", "WWW-Authenticate"],
        ),
    ]
