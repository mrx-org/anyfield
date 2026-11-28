"""The workspace layout (state field `layout`): which tools the workspace shows and
how they are arranged. A tree of splits (row: side by side, column: one above the
other, sizes as fractions) and stacks of tabs, each tab a panel showing one tool
with its display options. No pixels: the same layout fits every screen.

`normalize` checks a layout and brings it into its canonical form: known tools and
options, unique panel ids (missing ones are given), sizes summing to 1, no split
inside a split of the same direction (the UI's grid alternates directions).
"""

from __future__ import annotations

import secrets
from typing import Any

from pydantic import BaseModel, ConfigDict, ValidationError

from .file_tools import FileMode
from .models import Layout, Panel, Split, Stack

MAX_PANELS = 24
MAX_DEPTH = 6


class _FileListOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: FileMode | None = None
    download: bool | None = None


class _HistoryOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sessions: bool | None = None


class _NoOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")


# The tools a panel can show (their names without `open_`) and their options. The
# workspace itself is none of them: it does not nest.
TOOLS: dict[str, type[BaseModel]] = {
    "phantom_browser": _NoOptions,
    "phantom_preview": _NoOptions,
    "fov_planner": _NoOptions,
    "fov_viewer": _NoOptions,
    "sequence_browser": _NoOptions,
    "file_upload": _NoOptions,
    "file_list": _FileListOptions,
    "file_manager": _NoOptions,
    "state": _NoOptions,
    "history": _HistoryOptions,
}


class LayoutError(ValueError):
    pass


def normalize(layout: Layout) -> Layout:
    """The layout checked and in canonical form, or LayoutError."""
    if layout.root is None:
        return layout
    ids = {p.id for p in panels(layout.root) if p.id}
    seen: set[str] = set()
    root = _node(layout.root, None, 1, ids, seen)
    if len(seen) > MAX_PANELS:
        raise LayoutError(f"At most {MAX_PANELS} panels.")
    return Layout(root=root)


def panels(node: Split | Stack) -> list[Panel]:
    if isinstance(node, Stack):
        return list(node.tabs)
    return [p for child in node.children for p in panels(child)]


def _node(
    node: Split | Stack, parent: str | None, depth: int, ids: set[str], seen: set[str]
) -> Split | Stack:
    if depth > MAX_DEPTH:
        raise LayoutError(f"Layout nested deeper than {MAX_DEPTH}.")
    if isinstance(node, Stack):
        if not (0 <= node.active < len(node.tabs)):
            raise LayoutError(f"active {node.active} is no tab of the stack (0..{len(node.tabs) - 1}).")
        return Stack(tabs=[_panel(p, ids, seen) for p in node.tabs], active=node.active)
    n = len(node.children)
    sizes = node.sizes if node.sizes is not None else [1.0] * n
    if len(sizes) != n:
        raise LayoutError(f"A split with {n} children needs {n} sizes, not {len(sizes)}.")
    if any(s <= 0 for s in sizes):
        raise LayoutError("Sizes must be greater than 0.")
    total = sum(sizes)
    children: list[Split | Stack] = []
    fractions: list[float] = []
    for child, size in zip(node.children, sizes, strict=True):
        c = _node(child, node.split, depth + 1, ids, seen)
        if isinstance(c, Split) and c.split == node.split:
            # Same direction as this split: its children join this one
            children.extend(c.children)
            fractions.extend(size / total * s for s in c.sizes or [])
        else:
            children.append(c)
            fractions.append(size / total)
    return Split(split=node.split, children=children, sizes=[round(f, 6) for f in fractions])


def _panel(p: Panel, ids: set[str], seen: set[str]) -> Panel:
    model = TOOLS.get(p.tool)
    if model is None:
        raise LayoutError(f"Unknown tool {p.tool!r}. Known: {', '.join(TOOLS)}")
    try:
        options: dict[str, Any] = model.model_validate(p.options).model_dump(exclude_none=True)
    except ValidationError as e:
        raise LayoutError(f"Options of {p.tool}: {e.errors()[0]['msg']} ({p.options})") from e
    pid = p.id
    if pid is None:
        while (pid := f"p{secrets.token_hex(3)}") in ids:
            pass
        ids.add(pid)
    if pid in seen:
        raise LayoutError(f"Panel id {pid!r} is used twice.")
    seen.add(pid)
    return Panel(id=pid, tool=p.tool, options=options)
