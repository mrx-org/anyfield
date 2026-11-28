"""Phantom tools: browse the BIfTI catalog and the caller's phantoms in the CAS
(MRX gateway) and choose a phantom (browser), and view it (preview: property). With a session the choice is stored in its state; without one it goes
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
from .args import OptionalSessionKey, SessionKey
from .file_tools import UserFiles
from .models import CasPhantom, Fov, Phantom, PhantomChoice, Session, State, View
from .phantoms import (
    DEFAULT_PHANTOM,
    PROPERTY_KEYS,
    Catalog,
    PhantomError,
    PhantomMaps,
    public_maps,
)

PHANTOM_APP_URI = "ui://anyfield/phantom-browser.html"
PREVIEW_APP_URI = "ui://anyfield/phantom-preview.html"
PropertyArg = Annotated[
    str, Field(description=f"Property to show: one of {', '.join(PROPERTY_KEYS)} (if the phantom has it)")
]
CollectionArg = Annotated[
    str | None, Field(description="Registry phantom: collection name from list_phantom_collections")
]
# `collection` + `name` or `sha256` + `name`: the fields of the state's `phantom`
NameArg = Annotated[
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
        "(a .zip from list_user_files, an upload or bifti_get_phantom)"
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
    name: str | None,
    sha256: str | None,
    files: UserFiles | None = None,
) -> Phantom | None:
    """The phantom the arguments name: a CAS phantom (`sha256`, `name` its
    optional display name), a registry phantom (`collection` and `name`, checked
    against the catalog) or `None` for none at all. ToolError for anything else."""
    if sha256 is not None:
        if collection is not None:
            raise ToolError("Give either sha256 (CAS phantom) or collection and name, not both.")
        h = sha256.lower()
        try:
            CasPhantom(sha256=h, name="check")
        except ValidationError as e:
            raise ToolError("sha256 must be the 64 hex digits of a file in the CAS.") from e
        return CasPhantom(sha256=h, name=name or await cas_name(files, h))
    if collection is None and name is None:
        return None
    if collection is None or name is None:
        raise ToolError("Give both collection and name (or sha256 for a phantom in the CAS).")
    await check(catalog, collection, name)
    return PhantomChoice(collection=collection, name=name)


async def cas_name(files: UserFiles | None, sha256: str) -> str:
    """The file name of a CAS phantom, from the caller's files; the shortened hash if
    it is not among them (e.g. someone else's, or the gateway does not list files)."""
    try:
        for entry in await files.list(mode="bifti") if files else []:
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
    files: UserFiles,
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
        session_key: OptionalSessionKey = None,
        collection: CollectionArg = None,
        name: NameArg = None,
        sha256: Sha256Arg = None,
        tissues: Annotated[
            list[str] | None,
            Field(
                description="The phantom's tissues to view (and later simulate), names from "
                "list_phantom_tissues (e.g. ['GM', 'WM']); [] or omitted: all"
            ),
        ] = None,
    ) -> dict[str, Any]:
        """Choose a phantom and its tissues: one of the catalog (`collection` and
        `name`) or one in the CAS (`sha256`, optionally `name` as its display name),
        as in the state's `phantom`. With a session it becomes the session's phantom (state fields `phantom`
        and `tissues`), and everyone with the session key sees it; the view stays.
        Another phantom without `tissues` gets all its tissues. With a session, only
        `tissues` changes the tissues of the session's phantom. Returns the choice.
        Its maps and value ranges: get_phantom_maps. The default phantom:
        patch_state {"phantom": null}."""
        choice = await resolve(catalog, collection, name, sha256, files)
        if choice is None and (session_key is None or tissues is None):
            raise ToolError("Give collection and phantom, or sha256 for a phantom in the CAS.")
        if session_key is None:
            return {"phantom": choice.model_dump(), "tissues": State(tissues=tissues).tissues}

        def update(st: State) -> State:
            changes: dict[str, Any] = {} if choice is None else {"phantom": choice}
            if tissues is not None:
                changes["tissues"] = tissues
            return State.model_validate({**st.model_dump(), **changes})

        session = await ctx.change(session_key, update)
        st = session.state
        return {
            "rev": session.rev,
            "phantom": st.phantom.model_dump() if st.phantom else None,
            "tissues": st.tissues,
        }

    @mcp.tool(annotations={"readOnlyHint": True})
    async def list_phantom_tissues(
        collection: CollectionArg = None, name: NameArg = None, sha256: Sha256Arg = None
    ) -> dict[str, Any]:
        """The tissues of a phantom (sorted names, e.g. GM, WM, CSF), to choose which
        ones the maps combine (get_phantom_maps, select_phantom `tissues`). The
        phantom as in get_phantom_maps; without one the default phantom. The first
        call for a large phantom can take a while."""
        choice = await resolve(catalog, collection, name, sha256, files) or DEFAULT_PHANTOM
        return {"phantom": choice.model_dump(), "tissues": await guard(maps.tissues(choice))}

    @mcp.tool
    async def set_phantom_property(session_key: SessionKey, property: PropertyArg) -> dict[str, Any]:
        """The property all viewers of the session show (state field `view.property`):
        PD, T1, T2, T2', ADC, dB0, B1+ ... (which ones a phantom has: get_phantom_maps).
        The plane (tra, cor, sag, 3D) each viewer picks itself; the tissues belong to
        the phantom (select_phantom)."""

        def update(st: State) -> State:
            return st.model_copy(
                update={"view": View.model_validate({**st.view.model_dump(), "property": property})}
            )

        session = await ctx.change(session_key, update)
        return {"rev": session.rev, "view": session.state.view.model_dump()}

    @mcp.tool(annotations={"readOnlyHint": True})
    async def get_phantom_maps(
        collection: CollectionArg = None,
        name: NameArg = None,
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
        catalog (`collection`, `name`), one in the CAS (`sha256`) or, without
        either, the default one (endres-brainweb-001 / subj04-3T-1mm.json). With `fov` the
        maps are on the scan grid (FOV and matrix), as the planned scan would see
        the phantom. The first call for a phantom or grid can take up to a minute."""
        chosen = await resolve(catalog, collection, name, sha256, files)
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
        name: NameArg = None,
        sha256: Sha256Arg = None,
        property: Annotated[
            str | None,
            Field(description=f"Without a session: property to start with ({', '.join(PROPERTY_KEYS)})"),
        ] = None,
        tissues: Annotated[
            list[str] | None,
            Field(
                description="Without a session: tissues to start with (list_phantom_tissues); omit for all"
            ),
        ] = None,
    ) -> dict[str, Any]:
        """Show the phantom preview: a large view of a phantom, with the plane (tra,
        cor, sag, 3D, chosen by the user) and the property (PD, T1, T2, ...) to pick.
        With a session: the session's phantom, tissues and view (state field `view`),
        the property edited there; leave out the other arguments.
        Without a session: a quick look at any phantom - give `collection` and
        `name` (from list_phantoms) or `sha256` (a phantom in the CAS), optionally
        the property to start with and the tissues to show; the view the user ends up
        with comes back to the chat.
        In clients without MCP Apps this returns the state."""
        if session_key is not None:
            if any(v is not None for v in (collection, name, sha256, property, tissues)):
                raise ToolError(
                    "With a session the preview shows the session's phantom and view: leave out "
                    "collection, name, sha256, property and tissues (change them with select_phantom "
                    "and set_phantom_property)."
                )
            return await ctx.opened(session_key)
        if property is not None and property not in PROPERTY_KEYS:
            raise ToolError(f"Unknown property {property!r}. Known: {', '.join(PROPERTY_KEYS)}")
        choice = await resolve(catalog, collection, name, sha256, files)
        if choice is None:
            raise ToolError(
                "Without a session give collection and phantom (from list_phantoms), or sha256 "
                "for a phantom in the CAS."
            )
        view = View(**({"property": property} if property is not None else {}))
        state = State(phantom=choice, tissues=tissues, view=view)
        return {"key": None, "state": state.model_dump()}

    app_html(mcp, PHANTOM_APP_URI, "Phantom browser", "phantom-app.html", ctx.base_url, static_dir)
    app_html(mcp, PREVIEW_APP_URI, "Phantom preview", "phantom-preview-app.html", ctx.base_url, static_dir)
