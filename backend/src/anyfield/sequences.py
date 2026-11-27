"""Sequence sources: where sequences come from (folders on GitHub, single files,
Python packages, as in v3's `sources.toml`) and the sequences in them (files and
their sequence functions).

Listing them means fetching repositories, parsing Python files and notebooks and
importing packages: a job for a tool of the MRX gateway, like the BIfTI catalog.
That tool does not exist yet. Until then `SequenceCatalog` answers with
placeholders in the shape the gateway is to return: the v3 sources, each with one
dummy file whose name says it is not real. Swap `_sources` and `_sequences` for
gateway calls (`_Cached`, as in phantoms.py) once the tool is there.
"""

from __future__ import annotations

from typing import Any

from .models import SeqType, SourceSequence

# Placeholder until the gateway lists the sources: v3's `pypulseq/sources.toml`
PLACEHOLDER_SOURCES: list[dict[str, Any]] = [
    {
        "source": "anyseq",
        "type": "folder",
        "origin": "https://github.com/mrx-org/anyfield/tree/main/pypulseq/anyseq",
        "description": "anyfield's own sequences (GRE, TSE, ...)",
    },
    {
        "source": "builtin",
        "type": "folder",
        "origin": "https://github.com/mrx-org/anyfield/tree/main/pypulseq/built_in_seq",
        "description": "Built-in helpers, e.g. the .seq interpreter",
    },
    {
        "source": "mrseq.sequences",
        "type": "module",
        "origin": "mrseq.sequences",
        "description": "PTB mrseq, as a Python package",
    },
    {
        "source": "pypulseq_examples",
        "type": "folder",
        "origin": "https://github.com/imr-framework/pypulseq/tree/master/examples/scripts",
        "description": "Examples of PyPulseq",
    },
    {
        "source": "MRzero",
        "type": "file",
        "origin": "https://raw.githubusercontent.com/MRsources/MRzero-Core/refs/heads/main/"
        "documentation/playground_mr0/mr0_EPI_2D_seq.ipynb",
        "description": "MRzero playground notebook",
    },
    {
        "source": "Educational",
        "type": "folder",
        "origin": "https://github.com/magdamd/MuT",
        "description": "Educational sequences (magdamd/MuT)",
    },
]
PLACEHOLDER_FILE = "backend_not_ready_dummy"
PLACEHOLDER_FUNCTIONS = ["dummy_seq_gre", "dummy_seq_tse"]


class SequenceError(ValueError):
    pass


def _placeholder_files(source: dict[str, Any]) -> list[dict[str, Any]]:
    """One dummy file per source, of the kind the source holds; its URL is on a
    reserved, never resolving domain (.invalid)."""
    name = source["source"]
    if source["type"] == "module":
        kind, file, url = "module", PLACEHOLDER_FILE, f"{source['origin']}.{PLACEHOLDER_FILE}"
    else:
        kind = "ipynb" if source["type"] == "file" else "py"
        file = f"{PLACEHOLDER_FILE}.{kind}"
        url = f"https://backend-not-ready.invalid/{name}/{file}"
    return [{"name": file, "type": kind, "url": url, "functions": list(PLACEHOLDER_FUNCTIONS)}]


class SequenceCatalog:
    """The sequence sources and their sequences (placeholders until the gateway
    has a tool for them, see the module docstring)."""

    async def sources(self) -> list[dict[str, Any]]:
        """`{source, type, origin, description}` per source; `type` is folder, file or module."""
        return [dict(s) for s in PLACEHOLDER_SOURCES]

    async def sequences(self, source: str) -> list[dict[str, Any]]:
        """The files of a source: `{name, type, url, functions}`. `type` is py, ipynb,
        seq or module; `url` says where the file lives (for a module its dotted path);
        `functions` are its sequence functions (none for a .seq file)."""
        for s in PLACEHOLDER_SOURCES:
            if s["source"] == source:
                return _placeholder_files(s)
        known = ", ".join(s["source"] for s in PLACEHOLDER_SOURCES)
        raise SequenceError(f"Unknown sequence source {source!r}. Known: {known}")

    async def resolve(self, source: str, name: str, func: str | None) -> SourceSequence:
        """The sequence `func` of file `name` in `source`, or SequenceError. Without
        `func`, a file with exactly one function means that one."""
        files = await self.sequences(source)
        match = [f for f in files if f["name"] == name]
        if not match:
            raise SequenceError(f"No file {name!r} in sequence source {source!r}.")
        f = match[0]
        functions: list[str] = f["functions"]
        if func is None and len(functions) == 1:
            func = functions[0]
        if functions and func not in functions:
            raise SequenceError(f"{name!r} has no sequence function {func!r}. It has: {', '.join(functions)}")
        if not functions and func is not None:
            raise SequenceError(f"{name!r} is a sequence itself: give no function.")
        return SourceSequence(source=source, type=f["type"], url=f["url"], name=name, func=func)

    async def check(self, choice: SourceSequence) -> None:
        """SequenceError unless `choice` is a sequence of its source as listed."""
        if await self.resolve(choice.source, choice.name, choice.func) != choice:
            raise SequenceError(f"{choice.name!r} in {choice.source!r} is not at {choice.url!r}.")


def cas_type(name: str) -> SeqType:
    """The kind of a sequence file in the CAS, from its name; SequenceError if it is none."""
    lower = name.lower()
    for ext, kind in ((".seq", "seq"), (".py", "py"), (".ipynb", "ipynb")):
        if lower.endswith(ext):
            return kind
    raise SequenceError(f"{name!r} is no sequence file (.seq, .py or .ipynb).")
