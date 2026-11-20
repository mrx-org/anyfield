"""Phantom tools: browse the BIfTI catalog and the caller's phantoms in the CAS
(MRX gateway) and choose a phantom (browser), and view it (preview: plane and
property). With a session the choice is stored in its state; without one it goes
back to the chat. Independent of the FOV planner."""

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
from .models import CasPhantom, Fov, Phantom, PhantomChoice, Plane, Session, State, View
from .phantoms import (
    DEFAULT_PHANTOM,
    PROPERTY_KEYS,
    CasFiles,
    Catalog,
    PhantomError,
    PhantomMaps,
    public_maps,
)

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
CollectionArg = Annotated[
    str | None, Field(description="Registry phantom: collection name from list_phantom_collections")
]
PhantomArg = Annotated[
    str | None,
    Field(
        description="Registry phantom: file name from list_phantoms, e.g. 'subj04-3T-1mm.json'. "
        "With `sha256`: optional display name of the CAS phantom"
    ),
]
Sha256Arg = Annotated[
    str | None,
    Field(
        description="CAS phantom: hash of a bifti .zip in the CAS "
        "(from list_cas_phantoms, an upload or bifti_get_phantom)"
    ),
]
TissuesArg = Annotated[
    list[str] | None,
    Field(description="Tissues to combine, names from list_phantom_tissues (e.g. ['GM']); omit for all"),
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


async def resolve(
    catalog: Catalog,
    collection: str | None,
    phantom: str | None,
    sha256: str | None,
    cas: CasFiles | None = None,
) -> Phantom | None:
    """The phantom the arguments name: a CAS phantom (`sha256`, `phantom` its
    optional display name), a registry phantom (`collection` and `phantom`, checked
    against the catalog) or `None` for none at all. ToolError for anything else."""
    if sha256 is not None:
        if collection is not None:
            raise ToolError("Give either sha256 (CAS phantom) or collection and phantom, not both.")
        h = sha256.lower()
        try:
            CasPhantom(sha256=h, name="check")
        except ValidationError as e:
            raise ToolError("sha256 must be the 64 hex digits of a file in the CAS.") from e
        return CasPhantom(sha256=h, name=phantom or await cas_name(cas, h))
    if collection is None and phantom is None:
        return None
    if collection is None or phantom is None:
        raise ToolError("Give both collection and phantom (or sha256 for a phantom in the CAS).")
    await check(catalog, collection, phantom)
    return PhantomChoice(collection=collection, name=phantom)


async def cas_name(cas: CasFiles | None, sha256: str) -> str:
    """The file name of a CAS phantom, from the caller's files; the shortened hash if
    it is not among them (e.g. someone else's, or the gateway does not list files)."""
    try:
        for entry in await cas.phantoms() if cas else []:
            if entry["sha256"] == sha256 and entry["name"]:
                return entry["name"]
    except (PhantomError, ToolError):
        pass
    return f"{sha256[:12]}….zip"


def register(
    mcp: FastMCP,
    ctx: Ctx,
    *,
    catalog: Catalog,
    maps: PhantomMaps,
    cas: CasFiles,
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

    @mcp.tool(annotations={"readOnlyHint": True})
    async def list_cas_phantoms() -> list[dict[str, Any]]:
        """The caller's phantoms in the gateway's CAS (uploads and bifti_get_phantom
        results): the bifti .zip files among their files, newest first, each with
        `sha256`, `name`, `size` and `uploaded_at`. Choose one with select_phantom
        (`sha256`); a zip that is no phantom fails when its maps are loaded."""
        return await guard(cas.phantoms())

    @mcp.tool
    async def select_phantom(
        collection: CollectionArg = None,
        phantom: PhantomArg = None,
        sha256: Sha256Arg = None,
        session_key: OptionalSessionKey = None,
    ) -> dict[str, Any]:
        """Choose a phantom: one of the catalog (`collection` and `phantom`) or one in
        the CAS (`sha256`, optionally `phantom` as its display name). With a session it
        becomes the session's phantom (state field `phantom`), and everyone with the
        session key sees it; the view stays. Returns the choice. Its maps and value
        ranges: get_phantom_maps. The default phantom: patch_state {"phantom": null}."""
        choice = await resolve(catalog, collection, phantom, sha256, cas)
        if choice is None:
            raise ToolError("Give collection and phantom, or sha256 for a phantom in the CAS.")
        if session_key is None:
            return {"phantom": choice.model_dump()}
        session = await ctx.change(session_key, lambda st: st.model_copy(update={"phantom": choice}))
        return {"rev": session.rev, "phantom": choice.model_dump()}

    @mcp.tool(annotations={"readOnlyHint": True})
    async def list_phantom_tissues(
        collection: CollectionArg = None, phantom: PhantomArg = None, sha256: Sha256Arg = None
    ) -> dict[str, Any]:
        """The tissues of a phantom (sorted names, e.g. GM, WM, CSF), to choose which
        ones the maps combine (get_phantom_maps, set_phantom_view `tissues`). The
        phantom as in get_phantom_maps; without one the default phantom. The first
        call for a large phantom can take a while."""
        choice = await resolve(catalog, collection, phantom, sha256, cas) or DEFAULT_PHANTOM
        return {"phantom": choice.model_dump(), "tissues": await guard(maps.tissues(choice))}

    @mcp.tool
    async def set_phantom_view(
        session_key: SessionKey,
        property: PropertyArg | None = None,
        plane: Annotated[
            Plane | None,
            Field(description="tra (transversal), cor (coronal), sag (sagittal) or 3d (rendering)"),
        ] = None,
        tissues: Annotated[
            list[str] | None,
            Field(
                description="Tissues the maps combine, names from list_phantom_tissues "
                "(e.g. ['GM', 'WM']); [] for all of them"
            ),
        ] = None,
    ) -> dict[str, Any]:
        """How the phantom preview shows the session's phantom: the property (PD, T1,
        T2, T2', ADC, dB0, B1+ ...; which ones a phantom has: get_phantom_maps), the
        plane and the tissues combined. Fields left out stay as they are. Choosing
        another phantom resets the tissues to all. The FOV planner always shows PD of
        all tissues."""
        changes = {k: v for k, v in {"property": property, "plane": plane}.items() if v is not None}
        if tissues is not None:
            changes["tissues"] = tissues

        def update(st: State) -> State:
            return st.model_copy(update={"view": View.model_validate({**st.view.model_dump(), **changes})})

        session = await ctx.change(session_key, update)
        return {"rev": session.rev, "view": session.state.view.model_dump()}

    @mcp.tool(annotations={"readOnlyHint": True})
    async def get_phantom_maps(
        collection: CollectionArg = None,
        phantom: PhantomArg = None,
        sha256: Sha256Arg = None,
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
        tissues: TissuesArg = None,
    ) -> dict[str, Any]:
        """Display maps of a phantom from the MRX gateway: one NIfTI per property (PD,
        T1, T2, ...; its tissues combined, all or those in `tissues`) with label, unit, value range (2nd/98th
        percentile) and a URL that loads without login. The phantom: one of the
        catalog (`collection`, `phantom`), one in the CAS (`sha256`) or, without
        either, the default one (endres-brainweb-001 / subj04-3T-1mm.json). With `fov` the
        maps are on the scan grid (FOV and matrix), as the planned scan would see
        the phantom. The first call for a phantom or grid can take up to a minute."""
        chosen = await resolve(catalog, collection, phantom, sha256, cas)
        choice = chosen or DEFAULT_PHANTOM
        try:
            if fov is None:
                raw = await maps.get(choice, tissues=tissues or None)
            else:
                f = Fov.model_validate(fov)
                f = fov_ops.set_fov(f, f.center_mm, f.rotation_deg, f.size_mm)
                m = tuple(matrix or (128, 128, 1))
                if any(not (1 <= v <= MAX_MATRIX) for v in m):
                    raise ToolError(f"matrix values must be in [1, {MAX_MATRIX}]")
                raw = await maps.on_fov(choice, f, m, tissues or None)
        except (ValueError, ValidationError) as e:
            raise ToolError(str(e)) from e
        return public_maps(raw, choice, default=chosen is None)

    @mcp.tool(app=AppConfig(resource_uri=PHANTOM_APP_URI), annotations={"readOnlyHint": True})
    async def open_phantom_browser(session_key: OptionalSessionKey = None) -> dict[str, Any]:
        """Show the interactive phantom browser (catalog and the user's CAS phantoms,
        selection, with the phantom preview to fold out). With a session the choice goes into the session; without
        one the user picks and the choice comes back to the chat. In clients without
        MCP Apps this returns the state."""
        return await ctx.opened(session_key)

    @mcp.tool(app=AppConfig(resource_uri=PREVIEW_APP_URI), annotations={"readOnlyHint": True})
    async def open_phantom_preview(
        session_key: OptionalSessionKey = None,
        collection: CollectionArg = None,
        phantom: PhantomArg = None,
        sha256: Sha256Arg = None,
        property: Annotated[
            str | None,
            Field(description=f"Without a session: property to start with ({', '.join(PROPERTY_KEYS)})"),
        ] = None,
        plane: Annotated[
            Plane | None, Field(description="Without a session: tra, cor, sag or 3d to start with")
        ] = None,
        tissues: Annotated[
            list[str] | None,
            Field(
                description="Without a session: tissues to start with (list_phantom_tissues); omit for all"
            ),
        ] = None,
    ) -> dict[str, Any]:
        """Show the phantom preview: a large view of a phantom, with the plane (tra,
        cor, sag, 3D), the property (PD, T1, T2, ...) and the tissues to pick.
        With a session: the session's phantom and view (state field `view`), edited
        there; leave out the other arguments.
        Without a session: a quick look at any phantom - give `collection` and
        `phantom` (from list_phantoms) or `sha256` (a phantom in the CAS), optionally
        the property, plane and tissues to start with; the view the user ends up with comes
        back to the chat.
        In clients without MCP Apps this returns the state."""
        if session_key is not None:
            if any(v is not None for v in (collection, phantom, sha256, property, plane, tissues)):
                raise ToolError(
                    "With a session the preview shows the session's phantom and view: leave out "
                    "collection, phantom, sha256, property, plane and tissues (change them with select_phantom "
                    "and set_phantom_view)."
                )
            return await ctx.opened(session_key)
        if property is not None and property not in PROPERTY_KEYS:
            raise ToolError(f"Unknown property {property!r}. Known: {', '.join(PROPERTY_KEYS)}")
        choice = await resolve(catalog, collection, phantom, sha256, cas)
        if choice is None:
            raise ToolError(
                "Without a session give collection and phantom (from list_phantoms), or sha256 "
                "for a phantom in the CAS."
            )
        view = View(
            **{
                k: v
                for k, v in {"property": property, "plane": plane, "tissues": tissues}.items()
                if v is not None
            }
        )
        state = State(phantom=choice, view=view)
        return {"key": None, "state": state.model_dump()}

    app_html(mcp, PHANTOM_APP_URI, "Phantom browser", "phantom-app.html", ctx.base_url, static_dir)
    app_html(mcp, PREVIEW_APP_URI, "Phantom preview", "phantom-preview-app.html", ctx.base_url, static_dir)
