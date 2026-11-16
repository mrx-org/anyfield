"""The anyfield MCP server: session management (GitHub login) and session tools
(session key as argument). Browser, MCP App and AI all use these same tools."""

from __future__ import annotations

import asyncio
import time
from collections import defaultdict
from pathlib import Path
from typing import Annotated, Any

from fastmcp import FastMCP
from fastmcp.apps.config import AppConfig, ResourceCSP
from fastmcp.exceptions import ToolError
from pydantic import Field
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, Response
from starlette.routing import Mount
from starlette.staticfiles import StaticFiles

from . import fov as fov_ops
from . import phantom_tools
from .auth import AuthProvider, make_login_on_demand, require_user
from .models import Session, Vec3, new_key
from .phantoms import Catalog, PhantomLibrary
from .store import SessionStore

DATA_DIR = Path(__file__).parent / "data"
PHANTOM_FILE = DATA_DIR / "phantom_pd_2mm.nii.gz"
FOV_APP_URI = "ui://anyfield/fov-planner.html"
MAX_SESSIONS_PER_USER = 200

SessionKey = Annotated[str, Field(description="Key of the session (from create_session or a shared link)")]
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
    library: PhantomLibrary | None = None,
    catalog: Catalog | None = None,
) -> FastMCP:
    base_url = base_url.rstrip("/")
    mcp = FastMCP(
        "anyfield",
        instructions=(
            "anyfield plans virtual MRI scans. Work happens in sessions, identified by a session key. "
            "Managing sessions (list/create/rename/delete) needs a GitHub login; all other tools only "
            "need the session key. The user and you share the session: changes you make appear in "
            "the user's browser within a second, and vice versa. Coordinates are world RAS in mm."
        ),
        auth=auth,
    )
    locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    def public(s: Session) -> dict[str, Any]:
        return {
            "key": s.key,
            "name": s.name,
            "rev": s.rev,
            "owner_login": s.owner_login,
            "updated_at": s.updated_at,
            "fov": s.fov.model_dump(),
            "phantom": (phantom := phantom_tools.public(s.phantom, base_url)),
            "phantom_url": phantom["url"],
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
        session = Session(
            key=new_key(), name=name.strip() or "New session", owner=user.id, owner_login=user.login
        )
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

    # --- Session tools (session key only) ----------------------------------

    @mcp.tool(annotations={"readOnlyHint": True})
    async def get_session(
        session_key: SessionKey,
        known_rev: Annotated[
            int | None, Field(description="Last revision the caller has; if unchanged, only {rev, unchanged}")
        ] = None,
    ) -> dict[str, Any]:
        """Current state of a session: name, revision, FOV, phantom URL and the
        link to open it in the browser."""
        session = await load(session_key)
        if known_rev is not None and known_rev == session.rev:
            return {"rev": session.rev, "unchanged": True}
        return public(session)

    async def change_fov(session_key: str, change, expected_rev: int | None) -> dict[str, Any]:
        async with locks[session_key]:
            session = await load(session_key)
            if expected_rev is not None and expected_rev != session.rev:
                raise ToolError(f"Conflict: session is at rev {session.rev}, not {expected_rev}. Re-read it.")
            try:
                session.fov = change(session.fov)
            except ValueError as e:
                raise ToolError(str(e)) from e
            session = await save(session)
        return {"rev": session.rev, "fov": session.fov.model_dump(), "summary": fov_ops.describe(session.fov)}

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

    # --- MCP App ------------------------------------------------------------

    @mcp.tool(app=AppConfig(resource_uri=FOV_APP_URI), annotations={"readOnlyHint": True})
    async def open_fov_planner(session_key: SessionKey) -> dict[str, Any]:
        """Show the interactive FOV planner of a session (phantom with the FOV box).
        In clients without MCP Apps this returns the session state and its web link."""
        return public(await load(session_key))

    app_html(mcp, FOV_APP_URI, "FOV planner", "fov-app.html", base_url, static_dir)

    # --- Phantoms (BIfTI): a separate tool ----------------------------------

    phantom_tools.register(
        mcp,
        phantom_tools.Ctx(base_url=base_url, load=load, save=save, public=public, locks=locks),
        library=library,
        catalog=catalog or Catalog(),
        static_dir=static_dir,
    )

    # --- HTTP routes ----------------------------------------------------------

    @mcp.custom_route("/files/phantom.nii.gz", methods=["GET"])
    async def phantom(_: Request) -> Response:
        return FileResponse(
            PHANTOM_FILE, media_type="application/gzip", headers={"Cache-Control": "max-age=3600"}
        )

    @mcp.custom_route("/health", methods=["GET"])
    async def health(_: Request) -> Response:
        return JSONResponse({"ok": True})

    async def index(_: Request) -> Response:
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
        app=AppConfig(csp=ResourceCSP(connect_domains=[base_url], resource_domains=[base_url])),
    )
    def html() -> str:
        path = static_dir / file if static_dir else None
        if path and path.exists():
            return path.read_text()
        return f"<!doctype html><p>{name} not built (frontend/dist missing).</p>"


def http_app(mcp: FastMCP):
    """ASGI app: `/mcp` (login on demand), OAuth routes, files, web app."""
    app = mcp.http_app(path="/mcp", stateless_http=True, middleware=_middleware())
    if mcp.auth is not None:
        make_login_on_demand(app, "/mcp")
    static_dir = getattr(mcp, "_anyfield_static_dir", None)
    if static_dir and (static_dir / "assets").exists():
        app.routes.append(Mount("/assets", StaticFiles(directory=static_dir / "assets")))
    return app


def _v(v: list[float] | None) -> Vec3 | None:
    return None if v is None else (v[0], v[1], v[2])


def _middleware() -> list[Middleware]:
    return [
        Middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_methods=["GET", "POST", "OPTIONS", "DELETE"],
            allow_headers=["*"],
            expose_headers=["Mcp-Session-Id", "WWW-Authenticate"],
        )
    ]
