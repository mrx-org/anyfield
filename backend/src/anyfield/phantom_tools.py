"""Phantom tool: browse the BIfTI catalog (MRX gateway), choose a phantom and the
property (PD, T1, ...) it is shown with. With a session the choice is stored in
its state; without one it goes back to the chat. Independent of the FOV planner."""

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
from .models import Fov, PhantomChoice, Session, View
from .phantoms import DEFAULT_PHANTOM, PROPERTY_KEYS, Catalog, PhantomError, PhantomMaps, public_maps

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
        """Show the interactive phantom browser (catalog, selection, preview). With a
        session the choice goes into the session; without one the user picks and the
        choice comes back to the chat. In clients without MCP Apps this returns the state."""
        return await ctx.opened(session_key)

    app_html(mcp, PHANTOM_APP_URI, "Phantom browser", "phantom-app.html", ctx.base_url, static_dir)
