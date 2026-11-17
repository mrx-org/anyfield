"""Phantom tool: browse the BIfTI catalog and choose a session's phantom and the
property (PD, T1, ...) it is shown with. Independent of the FOV planner; both
read the same session."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import quote

from fastmcp import FastMCP
from fastmcp.apps.config import AppConfig
from fastmcp.exceptions import ToolError
from pydantic import Field
from starlette.requests import Request
from starlette.responses import FileResponse, Response

from .models import PhantomSel, Session
from .phantoms import PROPERTY_KEYS, Catalog, PhantomError, PhantomLibrary, stem

PHANTOM_APP_URI = "ui://anyfield/phantom-browser.html"
SessionKey = Annotated[str, Field(description="Key of the session (from create_session or a shared link)")]
PropertyArg = Annotated[
    str, Field(description=f"Property to show: one of {', '.join(PROPERTY_KEYS)} (if the phantom has it)")
]


@dataclass
class Ctx:
    base_url: str
    load: Callable[[str], Awaitable[Session]]
    save: Callable[[Session], Awaitable[Session]]
    public: Callable[[Session], dict[str, Any]]
    locks: Any


def public(sel: PhantomSel, base_url: str) -> dict[str, Any]:
    """The phantom part of a session's state, with the URL of the shown map
    (None while loading or after an error)."""
    url = None
    if sel.status == "ready":
        if sel.collection is None:
            url = f"{base_url}/files/phantom.nii.gz"
        else:
            url = f"{base_url}/files/phantoms/{quote(sel.collection)}/{quote(stem(sel.name))}/{sel.property}.nii.gz"
    return {**sel.model_dump(), "url": url}


def register(
    mcp: FastMCP,
    ctx: Ctx,
    *,
    library: PhantomLibrary | None,
    catalog: Catalog,
    static_dir: Path | None,
) -> None:
    from .server import app_html

    def need_library() -> PhantomLibrary:
        if library is None:
            raise ToolError("Phantom library not available on this server.")
        return library

    async def guard(coro):
        try:
            return await coro
        except PhantomError as e:
            raise ToolError(str(e)) from e

    @mcp.tool(annotations={"readOnlyHint": True})
    async def list_phantom_collections() -> list[dict[str, Any]]:
        """Phantom collections of the BIfTI registry (from the MRX gateway): name
        (`collection`), description and number of phantoms."""
        return await guard(catalog.collections())

    @mcp.tool(annotations={"readOnlyHint": True})
    async def list_phantoms(
        collection: Annotated[str, Field(description="Collection name from list_phantom_collections")],
        path: Annotated[
            list[str] | None, Field(description="Optional group path, e.g. ['subj04', '3T 2 mm']")
        ] = None,
    ) -> list:
        """Phantoms of a collection: file names (e.g. 'subj04-3T-2mm.json') and nested
        groups ({group, default, phantoms}). Narrow large collections with `path`."""
        return await guard(catalog.phantoms(collection, path))

    @mcp.tool
    async def select_phantom(
        session_key: SessionKey,
        collection: Annotated[str, Field(description="Collection name from list_phantom_collections")],
        phantom: Annotated[str, Field(description="Phantom file name from list_phantoms")],
        property: PropertyArg = "density",
    ) -> dict[str, Any]:
        """Use a phantom from the catalog in the session. The first use of a phantom
        downloads and prepares it, which can take up to a minute; the session shows
        status 'loading' meanwhile. Returns the session's phantom state."""
        lib = need_library()
        await guard(catalog.check(collection, phantom))
        meta = await lib.meta(collection, phantom)
        async with ctx.locks[session_key]:
            session = await ctx.load(session_key)
            session.phantom = PhantomSel(
                collection=collection, name=phantom, property=property, status="loading", properties=[]
            )
            if meta is not None:
                _ready(session.phantom, meta)
            session = await ctx.save(session)
        if meta is None:
            try:
                meta = await lib.ensure(collection, phantom)
                error = None
            except Exception as e:  # noqa: BLE001 - any failure is reported in the session
                error = f"{type(e).__name__}: {e}"
            async with ctx.locks[session_key]:
                session = await ctx.load(session_key)
                sel = session.phantom
                if sel.collection == collection and sel.name == phantom and sel.status == "loading":
                    if error:
                        sel.status, sel.error = "error", error
                    else:
                        _ready(sel, meta)
                    session = await ctx.save(session)
        result = public(session.phantom, ctx.base_url)
        if result["status"] == "error":
            raise ToolError(f"Could not load phantom: {result['error']}")
        return result

    @mcp.tool
    async def set_phantom_property(session_key: SessionKey, property: PropertyArg) -> dict[str, Any]:
        """Show another property of the session's phantom (PD, T1, T2, T2', ADC, dB0, B1+ ...)."""
        async with ctx.locks[session_key]:
            session = await ctx.load(session_key)
            keys = [p["key"] for p in session.phantom.properties]
            if property not in keys:
                raise ToolError(f"This phantom has no {property!r}. Available: {', '.join(keys)}")
            session.phantom.property = property
            session = await ctx.save(session)
        return public(session.phantom, ctx.base_url)

    @mcp.tool(app=AppConfig(resource_uri=PHANTOM_APP_URI), annotations={"readOnlyHint": True})
    async def open_phantom_browser(session_key: SessionKey) -> dict[str, Any]:
        """Show the interactive phantom browser of a session (catalog, selection,
        preview). In clients without MCP Apps this returns the session state."""
        return ctx.public(await ctx.load(session_key))

    app_html(mcp, PHANTOM_APP_URI, "Phantom browser", "phantom-app.html", ctx.base_url, static_dir)

    @mcp.custom_route("/files/phantoms/{collection}/{name}/{prop}.nii.gz", methods=["GET"])
    async def phantom_file(request: Request) -> Response:
        p = request.path_params
        try:
            path = await need_library().ensure_visible(p["collection"], p["name"], p["prop"])
        except (PhantomError, ToolError):
            path = None
        if path is None:
            return Response("Not found", status_code=404)
        # Prepared maps never change (registry phantoms are immutable)
        return FileResponse(
            path, media_type="application/gzip", headers={"Cache-Control": "public, max-age=86400"}
        )


def _ready(sel: PhantomSel, meta: dict[str, Any]) -> None:
    sel.status, sel.error = "ready", None
    sel.properties = meta["properties"]
    keys = [p["key"] for p in sel.properties]
    if sel.property not in keys:
        sel.property = "density"
