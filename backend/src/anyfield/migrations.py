"""Migrations of stored sessions: old schema versions to the current one.

Every stored session carries `version` (missing: 0). Each step turns the raw JSON
of one version into the next; steps work on plain dicts, never on the models,
so they stay valid when the models change later.

When the session schema changes:
1. Raise `SCHEMA_VERSION` by one.
2. Add a step `_vN_to_vN+1` to `STEPS` (raw dict in, raw dict out; no I/O).
3. Add a test with a session as it was stored before (tests/test_migrations.py).

`migrate_modal_store` runs at container start (modal_app.web) and rewrites every
session in the Dict and on the Volume once; a marker in the Dict makes later starts
skip it. The store also migrates each session it reads (`migrate_json`), for
sessions that containers with older code write during a deploy.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

SCHEMA_VERSION = 1
MARKER = "meta:schema_version"

Raw = dict[str, Any]


def _v0_to_v1(s: Raw) -> Raw:
    """`view.plane` is gone (each viewer picks its plane)."""
    state = dict(s.get("state") or {})
    view = dict(state.get("view") or {})
    view.pop("plane", None)
    state["view"] = view
    return {**s, "state": state}


STEPS: dict[int, Callable[[Raw], Raw]] = {0: _v0_to_v1}


def migrate(s: Raw) -> Raw:
    """A stored session (raw dict) in the current schema version."""
    version = s.get("version", 0)
    if version > SCHEMA_VERSION:
        raise ValueError(f"session version {version} is newer than this code ({SCHEMA_VERSION})")
    while version < SCHEMA_VERSION:
        s = STEPS[version](s)
        version += 1
    return {**s, "version": version}


def migrate_json(raw: str) -> str | None:
    """`raw` migrated, or None if it is current already."""
    s = json.loads(raw)
    if s.get("version", 0) == SCHEMA_VERSION:
        return None
    return json.dumps(migrate(s))


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
            dict_.put(key, new)
            changed += 1
    try:
        volume.reload()
    except Exception:  # reload fails while files are open; reading may still work
        log.debug("volume reload failed", exc_info=True)
    files = sorted(root.glob("s_*.json")) if root.exists() else []
    for path in files:
        new = migrate_json(path.read_text())
        if new is not None:
            path.write_text(new)
            changed += 1
    if files:
        volume.commit()
    dict_.put(MARKER, SCHEMA_VERSION)
    log.info("migrated %d stored session entries to schema version %d", changed, SCHEMA_VERSION)
    return changed
