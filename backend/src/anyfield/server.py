"""The anyfield MCP server: small UI tools (phantom, FOV planner), optionally
bound to a session whose state is a small JSON. Browser, MCP App and AI all use
the same tools. Session management needs a login, the rest a session key."""

from __future__ import annotations

import time
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

from . import file_tools, phantom_tools, seq_tools
from . import fov as fov_ops
from . import layout as layout_ops
from . import settings as user_settings
from .args import ExpectedRev, OptionalSessionKey, SessionKey, Vec3Arg
from .auth import AuthProvider, make_login_on_demand, require_user
from .file_tools import UserFiles
from .gateway import GATEWAY_URL, GatewayClient
from .models import Layout, PhantomChoice, Project, Session, State, Vec3, merge_patch
from .phantoms import PROPERTY_KEYS, Catalog, PhantomMaps
from .projects import Projects
from .sequences import SequenceCatalog
from .store import SessionStore

FOV_APP_URI = "ui://anyfield/fov-planner.html"
FOV_VIEWER_APP_URI = "ui://anyfield/fov-viewer.html"
STATE_APP_URI = "ui://anyfield/state.html"
HISTORY_APP_URI = "ui://anyfield/history.html"
WORKSPACE_APP_URI = "ui://anyfield/workspace.html"
WORKSPACE_DESCRIPTION = (
    "Show anyfield's workspace: several tools in panels (tabs, side by side or one above "
    "the other) that the user arranges, adds and closes; e.g. to present a result with the "
    "viewer and the planner side by side. The arrangement is the state field `layout` (null: "
    'the default one): {"root": node}, a node is a split {"split": "row"|"column", '
    '"children": [nodes], "sizes": [fractions]} or a stack of tabs {"tabs": [{"id"?, "tool", '
    '"options"?}], "active": index}. Tools: '
    + ", ".join(layout_ops.TOOLS)
    + ' (their open_* tool without `open_`; options as there, e.g. file_list {"mode": '
    '"sequence"}). Panel ids are given by the server if left out. With a session set it with '
    'patch_state {"layout": ...}; without one the arrangement the user ends up with comes back '
    "to the chat. In clients without MCP Apps this returns the state."
)
MAX_PROJECTS_PER_USER = 200
MAX_MATRIX = 1024
# The page is checked on every load (it names the assets of the current build); the
# assets have the hash of their content in their name, so they never change.
PAGE_CACHE = {"Cache-Control": "no-cache"}
ASSET_CACHE = {"Cache-Control": "public, max-age=31536000, immutable"}


def build(
    store: SessionStore,
    base_url: str,
    *,
    auth: AuthProvider | None = None,
    static_dir: Path | None = None,
    catalog: Catalog | None = None,
    maps: PhantomMaps | None = None,
    gateway: GatewayClient | None = None,
    files: UserFiles | None = None,
    sequences: SequenceCatalog | None = None,
) -> FastMCP:
    """`gateway` serves the phantom catalog, CAS phantoms, maps and the user's
    files; tests pass `catalog`, `maps` and `files` instead. `sequences`: the
    sequence sources (placeholders until the gateway lists them)."""
    base_url = base_url.rstrip("/")
    call = gateway.call_tool if gateway else None
    catalog = catalog or Catalog(call)
    maps = maps or PhantomMaps(call)
    files = files or UserFiles(call, gateway.url if gateway else GATEWAY_URL)
    sequences = sequences or SequenceCatalog()
    mcp = FastMCP(
        "anyfield",
        instructions=(
            "anyfield is the user interface for planning virtual MRI scans: small tools to choose a "
            "phantom, view it, plan the field of view (FOV) and choose a sequence. Every UI tool works "
            "without a session (the user's choice comes back to the chat) or with a `session_key`: then the choice is "
            "stored in the session's state, a small JSON (`get_state`, `patch_state`), and the user "
            "sees changes in the browser within a second, and vice versa. A session belongs to a project "
            "and points into its history, a tree of states: every change is committed automatically "
            "(undo, redo, goto_state, get_history; create_session branches off). Managing projects "
            "(list/create/rename/delete) needs a login; all other tools only need the session key. "
            "Coordinates are world RAS in mm."
        ),
        auth=auth,
    )
    projects = Projects(store)

    def public(s: Session, project: Project | None = None) -> dict[str, Any]:
        return {
            "key": s.key,
            "name": s.name,
            "color": s.color,
            "project": {"id": s.project, "name": project.name} if project else {"id": s.project},
            "head": s.head,
            "rev": s.rev,
            "updated_at": s.updated_at,
            "state": s.state.model_dump(),
            "web_url": f"{base_url}/s/{s.key}",
        }

    async def load(key: str) -> Session:
        return await projects.session(key)

    async def full(s: Session) -> dict[str, Any]:
        """The session with its project's name."""
        return public(s, await store.get_project(s.project))

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
        # Another phantom has other tissues: unless they were chosen with it, show all
        if new.phantom != old.phantom and new.tissues == old.tissues:
            new = new.model_copy(update={"tissues": None})
        if new.view.property not in PROPERTY_KEYS:
            raise ToolError(f"Unknown property {new.view.property!r}. Known: {', '.join(PROPERTY_KEYS)}")
        await seq_tools.check(sequences, old, new)
        if new.layout is not None and new.layout != old.layout:
            try:
                new = new.model_copy(update={"layout": layout_ops.normalize(new.layout)})
            except layout_ops.LayoutError as e:
                raise ToolError(str(e)) from e
        return new.model_copy(update={"fov": fov})

    async def change(
        session_key: str, fn: Callable[[State], State], expected_rev: int | None = None
    ) -> Session:
        """Apply `fn` to a session's state (validated) and commit it to the project's
        history (projects.Projects.change)."""
        return await projects.change(session_key, fn, checked, expected_rev)

    async def owned(project_id: str) -> Project:
        user = require_user()
        project = await projects.project(project_id)
        if project.owner != user.id:
            raise ToolError("Only the owner of a project may rename or delete it.")
        return project

    def project_summary(p: Project) -> dict[str, Any]:
        sessions = sorted(p.sessions.items(), key=lambda kv: kv[1].updated_at, reverse=True)
        return {
            "id": p.id,
            "name": p.name,
            "updated_at": p.updated_at,
            "sessions": [
                {
                    "key": k,
                    "name": r.name,
                    "color": r.color,
                    "updated_at": r.updated_at,
                    "web_url": f"{base_url}/s/{k}",
                }
                for k, r in sessions
            ],
        }

    # --- Projects (login required, see auth.LOGIN_TOOLS) ----------------------

    @mcp.tool(annotations={"readOnlyHint": True})
    async def list_projects() -> list[dict[str, Any]]:
        """List the projects of the logged-in user, most recently changed first, each with
        its sessions (key, name, color; most recently changed first). A project without
        a session gets one (`default`, on its newest state)."""
        user = require_user()
        found = [p for p in [await store.get_project(i) for i in await store.owned_by(user.id)] if p]
        found = [await projects.ensure_session(p) for p in found]
        found.sort(key=lambda p: p.updated_at, reverse=True)
        return [project_summary(p) for p in found]

    @mcp.tool
    async def create_project(name: str = "New project") -> dict[str, Any]:
        """Create a project owned by the logged-in user, with one session `default`.
        Returns that session: its key opens it and every other tool takes it; anybody
        who has the key can open and change the session, so it can be shared."""
        user = require_user()
        ids = await store.owned_by(user.id)
        if len(ids) >= MAX_PROJECTS_PER_USER:
            raise ToolError(f"At most {MAX_PROJECTS_PER_USER} projects per user. Delete some first.")
        project, session = await projects.create_project(name.strip() or "New project", user.id)
        await store.set_owned_by(user.id, [*ids, project.id])
        return public(session, project)

    @mcp.tool
    async def rename_project(
        project_id: Annotated[str, Field(description="Project id (list_projects)")], name: str
    ) -> dict[str, Any]:
        """Rename a project of the logged-in user."""
        async with projects.lock(project_id):
            project = await owned(project_id)
            project.name = name.strip() or project.name
            project.updated_at = time.time()
            await store.put_project(project)
        return project_summary(project)

    @mcp.tool(annotations={"destructiveHint": True})
    async def delete_project(
        project_id: Annotated[str, Field(description="Project id (list_projects)")],
    ) -> str:
        """Delete a project of the logged-in user with all its states and sessions: their
        keys stop working."""
        async with projects.lock(project_id):
            project = await owned(project_id)
            await projects.delete_project(project)
            ids = await store.owned_by(project.owner)
            await store.set_owned_by(project.owner, [i for i in ids if i != project.id])
        return f"Deleted project '{project.name}'."

    # --- Sessions of a project (session key only) -----------------------------

    @mcp.tool(annotations={"readOnlyHint": True})
    async def list_sessions(session_key: SessionKey) -> dict[str, Any]:
        """The project of a session and all its sessions (key, name, color), most recently
        changed first."""
        s = await load(session_key)
        return project_summary(await projects.ensure_session(await projects.project(s.project)))

    @mcp.tool
    async def create_session(
        session_key: SessionKey,
        name: Annotated[str | None, Field(description="Name of the new session")] = None,
        at: Annotated[
            str | None,
            Field(description="State (hash from get_history) to start at; default: where this session is"),
        ] = None,
    ) -> dict[str, Any]:
        """Branch off: a new session of the same project that starts at a state of its
        history and then goes on independently (its own undo/redo). Returns it with
        its own key."""
        s = await projects.branch(session_key, at, name)
        return await full(s)

    @mcp.tool
    async def rename_session(session_key: SessionKey, name: str) -> dict[str, Any]:
        """Rename a session."""
        return await full(await projects.rename_session(session_key, name))

    @mcp.tool(annotations={"destructiveHint": True})
    async def delete_session(session_key: SessionKey) -> dict[str, Any]:
        """Delete a session: its key stops working, the states of the project stay.
        Returns the session to go on with (`next`): the project's most recently changed
        one, or, if this was the last, a new session `default` on the newest state."""
        project, nxt = await projects.delete_session(session_key)
        return {"deleted": session_key, "next": public(nxt, project) if nxt else None}

    # --- History of a session's project ---------------------------------------

    @mcp.tool(annotations={"readOnlyHint": True})
    async def get_history(
        session_key: SessionKey,
        limit: Annotated[
            int, Field(ge=1, le=5000, description="At most this many states, newest first")
        ] = 200,
    ) -> dict[str, Any]:
        """The tree of states of the session's project, newest first: per state its
        `hash`, `parent`, `change` (the keys that changed, e.g. fov.center_mm), `actor`
        and `time`; the `leaves` (ends of branches) and the `sessions` with the state
        each is at (`head`). This session is `session`. Changes are committed
        automatically (several of the same change in a row are one state)."""
        s = await load(session_key)
        p = await projects.project(s.project)
        nodes = sorted(p.nodes.items(), key=lambda kv: kv[1].time, reverse=True)[:limit]
        return {
            "project": {"id": p.id, "name": p.name},
            "session": s.key,
            "head": s.head,
            "states": [{"hash": h, **n.model_dump()} for h, n in nodes],
            "total": len(p.nodes),
            "leaves": p.leaves,
            "sessions": [
                {"key": k, "name": r.name, "color": r.color, "head": r.head}
                for k, r in sorted(p.sessions.items(), key=lambda kv: kv[1].updated_at, reverse=True)
            ],
        }

    @mcp.tool
    async def undo(
        session_key: SessionKey, steps: Annotated[int, Field(ge=1, le=1000)] = 1
    ) -> dict[str, Any]:
        """Undo: move the session back `steps` states in its history. Nothing is lost:
        redo goes forward again; a change after an undo starts a new branch."""
        return await full(await projects.undo(session_key, steps))

    @mcp.tool
    async def redo(
        session_key: SessionKey, steps: Annotated[int, Field(ge=1, le=1000)] = 1
    ) -> dict[str, Any]:
        """Redo: move the session forward `steps` states (at a branch: the one it came
        back from, else the newest)."""
        return await full(await projects.redo(session_key, steps))

    @mcp.tool
    async def goto_state(
        session_key: SessionKey,
        state: Annotated[str, Field(description="Hash of a state of the project (get_history)")],
    ) -> dict[str, Any]:
        """Move the session to any state of its project's history (other sessions stay)."""
        return await full(await projects.goto(session_key, state))

    @mcp.tool(app=AppConfig(resource_uri=HISTORY_APP_URI), annotations={"readOnlyHint": True})
    async def open_history(
        session_key: SessionKey,
        sessions: Annotated[
            bool,
            Field(
                description="Let the user switch to another session of the project and branch off. "
                "False keeps the user on this session, e.g. so that they see what you see"
            ),
        ] = True,
    ) -> dict[str, Any]:
        """Show the history of the session's project as a tree, the sessions as coloured
        markers: undo, redo, a click jumps to a state; with `sessions` also switching to
        another session and branching off. In clients without MCP Apps this returns
        the session."""
        return await opened(session_key)

    app_html(mcp, HISTORY_APP_URI, "History", "history-app.html", base_url, static_dir)

    # --- Session state (session key only) ------------------------------------

    @mcp.tool(annotations={"readOnlyHint": True})
    async def get_state(
        session_key: SessionKey,
        known_rev: Annotated[
            int | None, Field(description="Last revision the caller has; if unchanged, only {rev, unchanged}")
        ] = None,
        at: Annotated[
            str | None,
            Field(
                description="Hash of an earlier state (get_history): return that state instead, without going there"
            ),
        ] = None,
    ) -> dict[str, Any]:
        """A session: name, its project, revision, the state it is at (`head`) with the
        state itself (phantom, view, fov, matrix, sequence, layout) and the link to
        open it in the browser. With `at`: any state of the project's history."""
        session = await load(session_key)
        if at is not None:
            node = await projects.node(session.project, at)
            return {
                "hash": node.hash,
                "parent": node.parent,
                "change": node.change,
                "actor": node.actor,
                "time": node.time,
                "state": node.state.model_dump(),
            }
        if known_rev is not None and known_rev == session.rev:
            return {"rev": session.rev, "unchanged": True}
        return await full(session)

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
        """Change several parts of a session's state at once (a new state in its history).
        Returns the session."""
        session = await change(
            session_key,
            lambda st: State.model_validate(merge_patch(st.model_dump(), patch)),
            expected_rev,
        )
        return await full(session)

    @mcp.tool(app=AppConfig(resource_uri=STATE_APP_URI), annotations={"readOnlyHint": True})
    async def open_state(session_key: SessionKey) -> dict[str, Any]:
        """Show the session's state as JSON for the user to edit: "Update" sends the
        changes (patch_state, rejected with the reason if they do not validate or the
        session changed meanwhile), "Reload" drops them and loads the current state.
        In clients without MCP Apps this returns the session and the web link."""
        return await opened(session_key)

    app_html(mcp, STATE_APP_URI, "State", "state-app.html", base_url, static_dir)

    # --- Workspace: several tools in panels ---------------------------------

    @mcp.tool(
        app=AppConfig(resource_uri=WORKSPACE_APP_URI),
        annotations={"readOnlyHint": True},
        description=WORKSPACE_DESCRIPTION,
    )
    async def open_workspace(
        session_key: OptionalSessionKey = None,
        layout: Annotated[
            dict[str, Any] | None,
            Field(
                description="Without a session: the layout to start with (as the state field "
                "`layout`). With a session leave it out: the session's layout is shown, change it "
                "with patch_state"
            ),
        ] = None,
    ) -> dict[str, Any]:
        # Description: WORKSPACE_DESCRIPTION (it names the tools)
        if session_key is not None:
            if layout is not None:
                raise ToolError("With a session the workspace shows its layout: set it with patch_state.")
            return await opened(session_key)
        state = State()
        if layout is not None:
            try:
                state.layout = layout_ops.normalize(Layout.model_validate(layout))
            except (layout_ops.LayoutError, ValidationError) as e:
                raise ToolError(str(e)) from e
        return {"key": None, "state": state.model_dump()}

    app_html(mcp, WORKSPACE_APP_URI, "Workspace", "workspace-app.html", base_url, static_dir)

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
        """Show the FOV planner: sliders for the FOV box (position, rotation, size)
        and its matrix, with a preview of the phantom resliced onto that grid to fold
        out. With a session it edits the session's FOV; without one the user plans
        locally and sends the result back to the chat. In clients without MCP Apps
        this returns the state and the web link."""
        return await opened(session_key)

    @mcp.tool(app=AppConfig(resource_uri=FOV_VIEWER_APP_URI), annotations={"readOnlyHint": True})
    async def open_fov_viewer(session_key: OptionalSessionKey = None) -> dict[str, Any]:
        """Show the visual FOV planner: the phantom with the FOV box, which the user
        moves, turns and resizes with the mouse (Ctrl + drag, Ctrl + right drag,
        Ctrl + wheel). With a session it edits the session's FOV; without one the user
        plans locally and sends the result back to the chat. The sliders are
        open_fov_planner. In clients without MCP Apps this returns the state and the web link."""
        return await opened(session_key)

    async def opened(session_key: str | None) -> dict[str, Any]:
        """What every open_* tool returns (the app opens on it): with a session the
        session (`key`, `name`, `rev`, `state`, `web_url`, ...), without one `key: None`
        and the `state` to start from. A tool adds its own data under its own key
        (e.g. `files`)."""
        if session_key:
            return await full(await load(session_key))
        return {"key": None, "state": State().model_dump()}

    app_html(mcp, FOV_APP_URI, "FOV planner", "fov-app.html", base_url, static_dir)
    app_html(mcp, FOV_VIEWER_APP_URI, "FOV viewer", "fov-viewer-app.html", base_url, static_dir)

    # --- Phantoms (BIfTI): a separate tool ----------------------------------

    file_tools.register(mcp, files, opened=opened, base_url=base_url, static_dir=static_dir)

    phantom_tools.register(
        mcp,
        phantom_tools.Ctx(base_url=base_url, change=change, public=public, opened=opened),
        catalog=catalog,
        maps=maps,
        files=files,
        static_dir=static_dir,
    )

    seq_tools.register(
        mcp,
        phantom_tools.Ctx(base_url=base_url, change=change, public=public, opened=opened),
        catalog=sequences,
        files=files,
        static_dir=static_dir,
    )

    user_settings.register(mcp, store)

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
            return FileResponse(page, headers=PAGE_CACHE)
        return HTMLResponse("<!doctype html><p>anyfield: frontend not built.</p>", headers=PAGE_CACHE)

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
        app.routes.append(Mount("/assets", ImmutableFiles(directory=static_dir / "assets")))
    return app


class ImmutableFiles(StaticFiles):
    """Static files cached for good (the build hashes their names); a missing one is not."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        if response.status_code in (200, 304):
            response.headers.update(ASSET_CACHE)
        return response


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
