"""The tree of states of a project: pure functions, no I/O.

Every change of a session's state is a node `{parent, state, change, actor, time}`,
addressed by the hash over all of it (so the same state reached twice is two nodes).
A session points at a node (`head`). Changes are committed automatically; a change
by the same actor to the same keys within `MERGE_S` of the last one, while the head
is a leaf only this session points at, replaces the head instead of adding a node,
so that dragging the FOV box is one step of the history.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

MERGE_S = 5.0


def node_hash(parent: str | None, state: dict[str, Any], change: list[str], actor: str, time: float) -> str:
    """16 hex digits of the sha256 over the node's content (canonical JSON)."""
    body = json.dumps(
        {"parent": parent, "state": state, "change": change, "actor": actor, "time": time},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(body.encode()).hexdigest()[:16]


def changed_keys(old: dict[str, Any], new: dict[str, Any]) -> list[str]:
    """What differs, as dotted keys one level deep (`fov.center_mm`, `view.property`);
    the phantom, sequence and layout count as one key each."""
    out: list[str] = []
    for k in sorted(set(old) | set(new)):
        a, b = old.get(k), new.get(k)
        if a == b:
            continue
        if isinstance(a, dict) and isinstance(b, dict) and k not in ("phantom", "sequence", "layout"):
            out.extend(f"{k}.{sub}" for sub in sorted(set(a) | set(b)) if a.get(sub) != b.get(sub))
        else:
            out.append(k)
    return out


def newest(nodes: dict[str, Any], hashes: list[str]) -> str | None:
    """Of `hashes`, the node changed last (`nodes[h].time`)."""
    return max(hashes, key=lambda h: nodes[h].time, default=None)


def children(nodes: dict[str, Any], parent: str) -> list[str]:
    """The children of a node, oldest first."""
    return sorted((h for h, n in nodes.items() if n.parent == parent), key=lambda h: nodes[h].time)
