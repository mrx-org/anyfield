"""Sequence tools: browse the sequence sources and the caller's sequence files in the
CAS and choose a sequence (sequence browser). With a session the choice is stored in
its state (`sequence`); without one it goes back to the chat.

The sources and their sequences will come from a tool of the MRX gateway, which does
not exist yet: until then `SequenceCatalog` lists placeholders (sequences.py). The
preview (duration, parameters) comes with that tool too."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any

from fastmcp import FastMCP
from fastmcp.apps.config import AppConfig
from fastmcp.exceptions import ToolError
from pydantic import Field, ValidationError

from .args import LocaleArg, OptionalSessionKey
from .file_tools import UserFiles
from .models import CasSequence, Sequence, State
from .phantom_tools import Ctx
from .phantoms import PhantomError
from .sequences import SequenceCatalog, SequenceError, cas_type

SEQUENCE_APP_URI = "ui://anyfield/sequence-browser.html"

SourceArg = Annotated[str | None, Field(description="Sequence source, from list_sequence_sources")]
SeqNameArg = Annotated[
    str | None,
    Field(
        description="File name: in `source` from list_sequences; with `sha256` the optional "
        "display name of the CAS file (its extension tells .seq, .py or .ipynb)"
    ),
]
FuncArg = Annotated[
    str | None,
    Field(
        description="Sequence function in the file (list_sequences `functions`); "
        "none for a .seq file or a file with a single one"
    ),
]
SeqSha256Arg = Annotated[
    str | None,
    Field(description="CAS sequence: hash of a .seq, .py or .ipynb file (list_user_files mode='sequence')"),
]


async def resolve(
    catalog: SequenceCatalog,
    files: UserFiles | None,
    source: str | None,
    name: str | None,
    func: str | None,
    sha256: str | None,
) -> Sequence:
    """The sequence the arguments name: one of a source (`source`, `name`, `func`,
    checked against the source's list) or a file in the CAS (`sha256`). ToolError
    for anything else."""
    try:
        if sha256 is not None:
            if source is not None:
                raise ToolError("Give either sha256 (CAS file) or source and name, not both.")
            h = sha256.lower()
            file_name = name or await cas_name(files, h)
            if func is not None and cas_type(file_name) == "seq":
                raise ToolError(f"{file_name!r} is a sequence itself: give no function.")
            try:
                return CasSequence(sha256=h, type=cas_type(file_name), name=file_name, func=func)
            except ValidationError as e:
                raise ToolError("sha256 must be the 64 hex digits of a file in the CAS.") from e
        if source is None or name is None:
            raise ToolError("Give source and name (from list_sequences), or sha256 for a file in the CAS.")
        return await catalog.resolve(source, name, func)
    except SequenceError as e:
        raise ToolError(str(e)) from e


async def cas_name(files: UserFiles | None, sha256: str) -> str:
    """The name of a CAS sequence file, from the caller's files (it tells the kind of
    file); ToolError if it is not among them: then the name must be given."""
    try:
        for entry in await files.list(mode="sequence") if files else []:
            if entry["sha256"] == sha256 and entry["name"]:
                return entry["name"]
    except (PhantomError, ToolError):
        pass
    raise ToolError("Not among your sequence files: give `name` (e.g. 'my.seq') with the sha256.")


def register(
    mcp: FastMCP,
    ctx: Ctx,
    *,
    catalog: SequenceCatalog,
    files: UserFiles,
    static_dir: Path | None,
) -> None:
    from .server import app_html

    async def guard(coro):
        try:
            return await coro
        except SequenceError as e:
            raise ToolError(str(e)) from e

    @mcp.tool(annotations={"readOnlyHint": True})
    async def list_sequence_sources() -> list[dict[str, Any]]:
        """Where sequences come from: `source` (its name), `type` (folder, file or module:
        a Python package), `origin` (URL or module path) and `description`. NOT READY:
        the MRX gateway's tool for this does not exist yet; until then the sources'
        contents are dummies (names with 'dummy' / 'not_ready')."""
        return await guard(catalog.sources())

    @mcp.tool(annotations={"readOnlyHint": True})
    async def list_sequences(source: Annotated[str, Field(description="From list_sequence_sources")]) -> list:
        """The sequence files of a source: `name`, `type` (seq, py, ipynb, module), `url`
        (where it lives; for a module its dotted path) and `functions` (its sequence
        functions, none for .seq). NOT READY: until the MRX gateway has a tool for this,
        every source lists one dummy file (backend_not_ready_dummy)."""
        return await guard(catalog.sequences(source))

    @mcp.tool
    async def select_sequence(
        session_key: OptionalSessionKey = None,
        source: SourceArg = None,
        name: SeqNameArg = None,
        func: FuncArg = None,
        sha256: SeqSha256Arg = None,
    ) -> dict[str, Any]:
        """Choose a sequence: one of a source (`source`, `name` and `func` from
        list_sequences) or a file in the CAS (`sha256`, optionally `name`; `func` for a
        .py/.ipynb file). With a session it becomes the session's sequence (state field
        `sequence`), and everyone with the session key sees it. Returns the choice.
        None at all: patch_state {"sequence": null}. Its parameters and duration come
        later with the MRX gateway."""
        choice = await resolve(catalog, files, source, name, func, sha256)
        if session_key is None:
            return {"sequence": choice.model_dump()}
        session = await ctx.change(session_key, lambda st: st.model_copy(update={"sequence": choice}))
        seq = session.state.sequence
        return {"rev": session.rev, "sequence": seq.model_dump() if seq else None}

    @mcp.tool(app=AppConfig(resource_uri=SEQUENCE_APP_URI), annotations={"readOnlyHint": True})
    async def open_sequence_browser(
        session_key: OptionalSessionKey = None, locale: LocaleArg = None
    ) -> dict[str, Any]:
        """Show the interactive sequence browser: a tab per sequence source and one for
        the user's sequence files in the CAS, to pick a sequence (file and function).
        With a session the choice goes into the session; without one it comes back to
        the chat. NOT READY: the sources list dummies until the MRX gateway lists them.
        In clients without MCP Apps this returns the state."""
        return await ctx.opened(session_key)

    app_html(mcp, SEQUENCE_APP_URI, "Sequence browser", "sequence-browser-app.html", ctx.base_url, static_dir)


async def check(catalog: SequenceCatalog, old: State, new: State) -> None:
    """ToolError unless a newly chosen source sequence is one of its source (a CAS
    file needs no check: its hash is the permission)."""
    seq = new.sequence
    if seq is None or isinstance(seq, CasSequence) or seq == old.sequence:
        return
    try:
        await catalog.check(seq)
    except SequenceError as e:
        raise ToolError(str(e)) from e
