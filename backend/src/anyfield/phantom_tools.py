"""Phantom tools: browse the BIfTI catalog (MRX gateway) and choose a phantom
(browser), and view it (preview: plane and property). With a session the choice
is stored in its state; without one it goes back to the chat. Independent of the
FOV planner."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any

from fastmcp import FastMCP
from fastmcp.apps.config import AppConfig
from fastmcp.exceptions import ToolError
from pydantic import Field, ValidationError

from . import fov as fov_ops
from .models import Fov, PhantomChoice, Plane, Session, State, View
from .phantoms import DEFAULT_PHANTOM, PROPERTY_KEYS, Catalog, PhantomError, PhantomMaps, public_maps

PHANTOM_APP_URI = "ui://anyfield/phantom-browser.html"
PREVIEW_APP_URI = "ui://anyfield/phantom-preview.html"
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
MAX_MATRIX = 1024


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


def register(
    mcp: FastMCP,
    ctx: Ctx,
    *,
    catalog: Catalog,
    maps: PhantomMaps,
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
    async def set_phantom_view(
        session_key: SessionKey,
        property: PropertyArg | None = None,
        plane: Annotated[
            Plane | None,
            Field(description="tra (transversal), cor (coronal), sag (sagittal) or 3d (rendering)"),
        ] = None,
    ) -> dict[str, Any]:
        """How the phantom preview shows the session's phantom: the property (PD, T1,
        T2, T2', ADC, dB0, B1+ ...; which ones a phantom has: get_phantom_maps) and the
        plane. Fields left out stay as they are. The FOV planner always shows PD."""
        changes = {k: v for k, v in {"property": property, "plane": plane}.items() if v is not None}
        session = await ctx.change(
            session_key, lambda st: st.model_copy(update={"view": st.view.model_copy(update=changes)})
        )
        return {"rev": session.rev, "view": session.state.view.model_dump()}

    @mcp.tool(annotations={"readOnlyHint": True})
    async def get_phantom_maps(
        collection: Annotated[
            str | None, Field(description="Collection; omit for the default phantom")
        ] = None,
        phantom: Annotated[str | None, Field(description="Phantom file name; omit for the default")] = None,
        fov: Annotated[
            dict[str, Any] | None,
            Field(
                description="Optional FOV {center_mm, rotation_deg, size_mm} as in the state: "
                "resample the maps onto the planned scan grid (reslicing)"
            ),
        ] = None,
        matrix: Annotated[
            list[int] | None,
            Field(min_length=3, max_length=3, description="Scan matrix for `fov`, default [128, 128, 1]"),
        ] = None,
    ) -> dict[str, Any]:
        """Display maps of a phantom from the MRX gateway: one NIfTI per property (PD,
        T1, T2, ...; tissues combined) with label, unit, value range (2nd/98th
        percentile) and a URL that loads without login. Without a phantom: the
        default phantom (endres-brainweb-001 / subj04-3T-1mm.json). With `fov` the
        maps are on the scan grid (FOV and matrix), as the planned scan would see
        the phantom. The first call for a phantom or grid can take up to a minute."""
        if (collection is None) != (phantom is None):
            raise ToolError("Give both collection and phantom, or neither for the default phantom.")
        choice = PhantomChoice(collection=collection, name=phantom) if collection else DEFAULT_PHANTOM
        if collection is not None:
            await check(catalog, collection, phantom)
        try:
            if fov is None:
                raw = await maps.get(choice)
            else:
                f = Fov.model_validate(fov)
                f = fov_ops.set_fov(f, f.center_mm, f.rotation_deg, f.size_mm)
                m = tuple(matrix or (128, 128, 1))
                if any(not (1 <= v <= MAX_MATRIX) for v in m):
                    raise ToolError(f"matrix values must be in [1, {MAX_MATRIX}]")
                raw = await maps.on_fov(choice, f, m)
        except (ValueError, ValidationError) as e:
            raise ToolError(str(e)) from e
        return public_maps(raw, choice, default=collection is None)

    @mcp.tool(app=AppConfig(resource_uri=PHANTOM_APP_URI), annotations={"readOnlyHint": True})
    async def open_phantom_browser(session_key: OptionalSessionKey = None) -> dict[str, Any]:
        """Show the interactive phantom browser (catalog and selection, with the phantom
        preview to fold out). With a session the choice goes into the session; without
        one the user picks and the choice comes back to the chat. In clients without
        MCP Apps this returns the state."""
        return await ctx.opened(session_key)

    @mcp.tool(app=AppConfig(resource_uri=PREVIEW_APP_URI), annotations={"readOnlyHint": True})
    async def open_phantom_preview(
        session_key: OptionalSessionKey = None,
        collection: Annotated[
            str | None, Field(description="Without a session: collection of the phantom to show")
        ] = None,
        phantom: Annotated[
            str | None, Field(description="Without a session: phantom file name, e.g. 'subj04-3T-1mm.json'")
        ] = None,
        property: Annotated[
            str | None,
            Field(description=f"Without a session: property to start with ({', '.join(PROPERTY_KEYS)})"),
        ] = None,
        plane: Annotated[
            Plane | None, Field(description="Without a session: tra, cor, sag or 3d to start with")
        ] = None,
    ) -> dict[str, Any]:
        """Show the phantom preview: a large view of a phantom, with the plane (tra,
        cor, sag, 3D) and the property (PD, T1, T2, ...) to pick.
        With a session: the session's phantom and view (state field `view`), edited
        there; leave out the other arguments.
        Without a session: a quick look at any phantom of the catalog - give
        `collection` and `phantom` (from list_phantoms), optionally the property and
        plane to start with; the view the user ends up with comes back to the chat.
        In clients without MCP Apps this returns the state."""
        if session_key is not None:
            if any(v is not None for v in (collection, phantom, property, plane)):
                raise ToolError(
                    "With a session the preview shows the session's phantom and view: leave out "
                    "collection, phantom, property and plane (change them with select_phantom and "
                    "set_phantom_view)."
                )
            return await ctx.opened(session_key)
        if collection is None or phantom is None:
            raise ToolError("Without a session give collection and phantom (from list_phantoms).")
        if property is not None and property not in PROPERTY_KEYS:
            raise ToolError(f"Unknown property {property!r}. Known: {', '.join(PROPERTY_KEYS)}")
        await check(catalog, collection, phantom)
        view = View(**{k: v for k, v in {"property": property, "plane": plane}.items() if v is not None})
        state = State(phantom=PhantomChoice(collection=collection, name=phantom), view=view)
        return {"key": None, "state": state.model_dump()}

    app_html(mcp, PHANTOM_APP_URI, "Phantom browser", "phantom-app.html", ctx.base_url, static_dir)
    app_html(mcp, PREVIEW_APP_URI, "Phantom preview", "phantom-preview-app.html", ctx.base_url, static_dir)
