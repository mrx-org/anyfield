"""Migrations of stored sessions: old schema versions to the current one.

Every stored session carries `version` (missing: 0). Each step turns the raw JSON
of one version into the next; steps work on plain dicts, never on the models,
so they stay valid when the models change later.

When the session schema changes:
1. Raise `SCHEMA_VERSION` by one.
2. Add a step `_vN_to_vN+1` to `STEPS` (raw dict in, raw dict out; no I/O).
3. Add a test with a session as it was stored before (tests/test_migrations.py).

A step may add entries of other kinds (e.g. v2 → v3 turns one session into a
project, its root node and a session): it returns them under `EXTRA` (entry key →
raw dict), and whoever migrates writes them unless they exist already.

`migrate_modal_store` runs at container start (modal_app.web) and rewrites every
session in the Dict and on the Volume once; a marker in the Dict makes later starts
skip it. The store also migrates each session it reads (`migrate_json`), for
sessions that containers with older code write during a deploy.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

SCHEMA_VERSION = 3
MARKER = "meta:schema_version"
EXTRA = "_extra"

Raw = dict[str, Any]


def _v0_to_v1(s: Raw) -> Raw:
    """`view.plane` is gone (each viewer picks its plane)."""
    state = dict(s.get("state") or {})
    view = dict(state.get("view") or {})
    view.pop("plane", None)
    state["view"] = view
    return {**s, "state": state}


def _v1_to_v2(s: Raw) -> Raw:
    """`view.tissues` is now `state.tissues`, next to the phantom: the tissues belong
    to the phantom that is viewed (and later simulated), not to a view."""
    state = dict(s.get("state") or {})
    view = dict(state.get("view") or {})
    if "tissues" in view:
        state.setdefault("tissues", view.pop("tissues"))
    state["view"] = view
    return {**s, "state": state}


def _v2_to_v3(s: Raw) -> Raw:
    """A session becomes a project with a tree of states: the project (same id as the
    old key, so the owner's list of keys is now the list of project ids) with the
    session's state as its root node, and a session `default` under the old key that
    points at it. The JSON editor tool `session` is now `state` (layout panels)."""
    state = dict(s.get("state") or {})
    layout = state.get("layout")
    if isinstance(layout, dict):
        state["layout"] = json.loads(json.dumps(layout).replace('"tool": "session"', '"tool": "state"'))
    key = s["key"]
    t = s.get("updated_at") or s.get("created_at") or 0.0
    # Frozen copy of history.node_hash at schema version 3
    body = {"parent": None, "state": state, "change": [], "actor": "migration", "time": t}
    h = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:16]
    node = {"version": 3, "hash": h, **body}
    project = {
        "version": 3,
        "id": key,
        "name": s.get("name") or "Project",
        "owner": s.get("owner"),
        "created_at": s.get("created_at") or t,
        "updated_at": t,
        "nodes": {h: {"parent": None, "change": [], "actor": "migration", "time": t}},
        "leaves": [h],
        "sessions": {key: {"name": "default", "color": "#3b82f6", "head": h, "updated_at": t}},
    }
    session = {
        "version": 3,
        "key": key,
        "project": key,
        "name": "default",
        "color": "#3b82f6",
        "created_at": s.get("created_at") or t,
        "updated_at": t,
        "rev": s.get("rev", 0),
        "head": h,
        "state": state,
        "redo": {},
    }
    return {**session, EXTRA: {f"p:{key}": project, f"n:{key}:{h}": node}}


STEPS: dict[int, Callable[[Raw], Raw]] = {0: _v0_to_v1, 1: _v1_to_v2, 2: _v2_to_v3}


def migrate(s: Raw) -> Raw:
    """A stored session (raw dict) in the current schema version; entries a step adds
    come under `EXTRA`."""
    version = s.get("version", 0)
    if version > SCHEMA_VERSION:
        raise ValueError(f"session version {version} is newer than this code ({SCHEMA_VERSION})")
    extra: dict[str, Raw] = {}
    while version < SCHEMA_VERSION:
        s = STEPS[version](s)
        extra.update(s.pop(EXTRA, {}))
        version += 1
    return {**s, "version": version, **({EXTRA: extra} if extra else {})}


def migrate_json(raw: str) -> tuple[str, dict[str, str]] | None:
    """`raw` migrated and the entries the steps added (entry key → JSON), or None if
    it is current already."""
    s = json.loads(raw)
    if s.get("version", 0) == SCHEMA_VERSION:
        return None
    m = migrate(s)
    extra = m.pop(EXTRA, {})
    return json.dumps(m), {k: json.dumps(v) for k, v in extra.items()}


def migrate_modal_store(dict_: Any, volume: Any, root: Path) -> int:
    """Migrate all sessions (`s:<key>`) in the Modal Dict and on the Volume
    (`<root>/s_<key>.json`) once per schema version. Returns how many entries changed.
    Safe if several containers run it at once: each step is a pure function of the
    stored JSON, so they all write the same."""
    if dict_.get(MARKER) == SCHEMA_VERSION:
        return 0
    changed = 0
    for key in list(dict_.keys()):
        if not key.startswith("s:"):
            continue
        raw = dict_.get(key)
        new = migrate_json(raw) if raw is not None else None
        if new is not None:
            for entry, value in new[1].items():
                if dict_.get(entry) is None:
                    dict_.put(entry, value)
            dict_.put(key, new[0])
            changed += 1
    try:
        volume.reload()
    except Exception:  # reload fails while files are open; reading may still work
        log.debug("volume reload failed", exc_info=True)
    files = sorted(root.glob("s_*.json")) if root.exists() else []
    for path in files:
        new = migrate_json(path.read_text())
        if new is not None:
            for entry, value in new[1].items():
                extra_path = root / f"{entry.replace(':', '_')}.json"
                if not extra_path.exists():
                    extra_path.write_text(value)
            path.write_text(new[0])
            changed += 1
    if files:
        volume.commit()
    dict_.put(MARKER, SCHEMA_VERSION)
    log.info("migrated %d stored session entries to schema version %d", changed, SCHEMA_VERSION)
    return changed
