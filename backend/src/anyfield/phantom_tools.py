"""Phantom tool: browse the BIfTI catalog (MRX gateway), choose a phantom and the
property (PD, T1, ...) it is shown with. With a session the choice is stored in
its state; without one it goes back to the chat. Independent of the FOV planner."""

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

from .models import PhantomChoice, Session, View
from .phantoms import PROPERTY_KEYS, Catalog, PhantomError, PhantomLibrary, stem

PHANTOM_APP_URI = "ui://anyfield/phantom-browser.html"
SessionKey = Annotated[str, Field(description="Key of the session (from create_session or a shared link)")]
OptionalSessionKey = Annotated[
    str | None,
    Field(
        description="Optional session key: store the choice in that session. Without one it goes back to the chat"
    ),
]
PropertyArg = Annotated[
    str, Field(description=f"Property to show: one of {', '.join(PROPERTY_KEYS)} (if the phantom has it)")
]
CollectionArg = Annotated[str, Field(description="Collection name from list_phantom_collections")]
PhantomArg = Annotated[
    str, Field(description="Phantom file name from list_phantoms, e.g. 'subj04-3T-1mm.json'")
]
DEFAULT_PROPERTIES = [{"key": "density", "label": "PD", "unit": "a.u.", "range": None}]


@dataclass
class Ctx:
    base_url: str
    change: Callable[..., Awaitable[Session]]
    public: Callable[[Session], dict[str, Any]]
    opened: Callable[[str | None], Awaitable[dict[str, Any]]]


async def check(catalog: Catalog, collection: str, name: str) -> None:
    """ToolError unless the phantom is in the catalog."""
    try:
        await catalog.check(collection, name)
    except PhantomError as e:
        raise ToolError(str(e)) from e


def map_url(base_url: str, collection: str | None, name: str, prop: str) -> str:
    if collection is None:
        return f"{base_url}/files/phantom.nii.gz"
    return f"{base_url}/files/phantoms/{quote(collection)}/{quote(stem(name))}/{prop}.nii.gz"


def register(
    mcp: FastMCP,
    ctx: Ctx,
    *,
    library: PhantomLibrary | None,
    catalog: Catalog,
    static_dir: Path | None,
) -> None:
    from .server import app_html

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
        collection: CollectionArg,
        path: Annotated[
            list[str] | None, Field(description="Optional group path, e.g. ['subj04', '3T 2 mm']")
        ] = None,
    ) -> list:
        """Phantoms of a collection: file names (e.g. 'subj04-3T-2mm.json') and nested
        groups ({group, default, phantoms}). Narrow large collections with `path`."""
        return await guard(catalog.phantoms(collection, path))

    @mcp.tool
    async def select_phantom(
        collection: CollectionArg, phantom: PhantomArg, session_key: OptionalSessionKey = None
    ) -> dict[str, Any]:
        """Choose a phantom of the catalog. With a session it becomes the session's
        phantom (state field `phantom`); the property shown stays. Returns the choice.
        Its maps and value ranges: get_phantom_maps."""
        choice = PhantomChoice(collection=collection, name=phantom)
        if session_key is None:
            await check(catalog, collection, phantom)
            return {"phantom": choice.model_dump()}
        session = await ctx.change(session_key, lambda st: st.model_copy(update={"phantom": choice}))
        return {"rev": session.rev, "phantom": choice.model_dump()}

    @mcp.tool
    async def set_phantom_property(session_key: SessionKey, property: PropertyArg) -> dict[str, Any]:
        """Show another property of the session's phantom (PD, T1, T2, T2', ADC, dB0, B1+ ...).
        Which ones a phantom has: get_phantom_maps."""
        session = await ctx.change(
            session_key, lambda st: st.model_copy(update={"view": View(property=property)})
        )
        return {"rev": session.rev, "view": session.state.view.model_dump()}

    @mcp.tool(annotations={"readOnlyHint": True})
    async def get_phantom_maps(
        collection: Annotated[
            str | None, Field(description="Collection; omit for the default phantom")
        ] = None,
        phantom: Annotated[str | None, Field(description="Phantom file name; omit for the default")] = None,
    ) -> dict[str, Any]:
        """Display maps of a phantom: one NIfTI per property (PD, T1, T2, ...; tissues
        combined), with label, unit, value range (2nd/98th percentile) and URL. The
        first call for a phantom prepares it, which can take up to a minute."""
        if collection is None or phantom is None:
            props = [{**p, "url": map_url(ctx.base_url, None, "", "density")} for p in DEFAULT_PROPERTIES]
            return {"phantom": None, "properties": props}
        if library is None:
            raise ToolError("Phantom maps are not available on this server.")
        await check(catalog, collection, phantom)
        try:
            meta = await library.ensure(collection, phantom)
        except PhantomError as e:
            raise ToolError(str(e)) from e
        except Exception as e:
            raise ToolError(f"Could not prepare phantom: {type(e).__name__}: {e}") from e
        props = [
            {**p, "url": map_url(ctx.base_url, collection, phantom, p["key"])} for p in meta["properties"]
        ]
        return {
            "phantom": {"collection": collection, "name": phantom},
            "shape": meta.get("shape"),
            "spacing_mm": meta.get("spacing_mm"),
            "properties": props,
        }

    @mcp.tool(app=AppConfig(resource_uri=PHANTOM_APP_URI), annotations={"readOnlyHint": True})
    async def open_phantom_browser(session_key: OptionalSessionKey = None) -> dict[str, Any]:
        """Show the interactive phantom browser (catalog, selection, preview). With a
        session the choice goes into the session; without one the user picks and the
        choice comes back to the chat. In clients without MCP Apps this returns the state."""
        return await ctx.opened(session_key)

    app_html(mcp, PHANTOM_APP_URI, "Phantom browser", "phantom-app.html", ctx.base_url, static_dir)

    @mcp.custom_route("/files/phantoms/{collection}/{name}/{prop}.nii.gz", methods=["GET"])
    async def phantom_file(request: Request) -> Response:
        p = request.path_params
        try:
            path = await library.ensure_visible(p["collection"], p["name"], p["prop"]) if library else None
        except PhantomError:
            path = None
        if path is None:
            return Response("Not found", status_code=404)
        # Prepared maps never change (registry phantoms are immutable)
        return FileResponse(
            path, media_type="application/gzip", headers={"Cache-Control": "public, max-age=86400"}
        )
