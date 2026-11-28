"""Where projects, their nodes and sessions live: entries `p:<id>` (project),
`n:<project>:<hash>` (node), `s:<key>` (session), `o:<owner>` (the owner's project ids),
`u:<user>` (the user's settings).

`MemoryStore` for tests and local runs. `ModalStore` on Modal: a Modal Dict as
the fast store every container sees, plus a Volume as durable copy, because a
Dict entry expires after 7 days without reads or writes.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any, Protocol

from .migrations import migrate_json
from .models import Node, Project, Session

log = logging.getLogger(__name__)


class Entries:
    """Typed access on top of raw entries (`_get`, `_put`; None deletes). A session
    of an older schema is migrated when read; entries the migration adds (its
    project and root node) are written unless they exist (migrations.py)."""

    async def _get(self, entry: str) -> str | None:
        raise NotImplementedError

    async def _put(self, entry: str, raw: str | None) -> None:
        raise NotImplementedError

    async def get(self, key: str) -> Session | None:
        raw = await self._get(f"s:{key}")
        if raw is None:
            return None
        migrated = migrate_json(raw)
        if migrated is not None:
            raw, extra = migrated
            for entry, value in extra.items():
                if await self._get(entry) is None:
                    await self._put(entry, value)
            await self._put(f"s:{key}", raw)
        return Session.model_validate_json(raw)

    async def put(self, session: Session) -> None:
        await self._put(f"s:{session.key}", session.model_dump_json())

    async def delete(self, key: str) -> None:
        await self._put(f"s:{key}", None)

    async def get_project(self, project_id: str) -> Project | None:
        raw = await self._get(f"p:{project_id}")
        return None if raw is None else Project.model_validate_json(raw)

    async def put_project(self, project: Project) -> None:
        await self._put(f"p:{project.id}", project.model_dump_json())

    async def delete_project(self, project_id: str) -> None:
        await self._put(f"p:{project_id}", None)

    async def get_node(self, project_id: str, h: str) -> Node | None:
        raw = await self._get(f"n:{project_id}:{h}")
        return None if raw is None else Node.model_validate_json(raw)

    async def put_node(self, project_id: str, node: Node) -> None:
        await self._put(f"n:{project_id}:{node.hash}", node.model_dump_json())

    async def delete_node(self, project_id: str, h: str) -> None:
        await self._put(f"n:{project_id}:{h}", None)

    async def get_settings(self, user: str):
        from .settings import UserSettings

        raw = await self._get(f"u:{user}")
        return None if raw is None else UserSettings.model_validate_json(raw)

    async def put_settings(self, user: str, settings) -> None:
        await self._put(f"u:{user}", settings.model_dump_json())

    async def owned_by(self, owner: str) -> list[str]:
        """The ids of the owner's projects."""
        raw = await self._get(f"o:{owner}")
        return [] if raw is None else json.loads(raw)

    async def set_owned_by(self, owner: str, ids: list[str]) -> None:
        await self._put(f"o:{owner}", json.dumps(ids))


class SessionStore(Protocol):
    async def get(self, key: str) -> Session | None: ...
    async def put(self, session: Session) -> None: ...
    async def delete(self, key: str) -> None: ...
    async def get_project(self, project_id: str) -> Project | None: ...
    async def put_project(self, project: Project) -> None: ...
    async def delete_project(self, project_id: str) -> None: ...
    async def get_node(self, project_id: str, h: str) -> Node | None: ...
    async def put_node(self, project_id: str, node: Node) -> None: ...
    async def delete_node(self, project_id: str, h: str) -> None: ...
    async def get_settings(self, user: str) -> Any: ...
    async def put_settings(self, user: str, settings: Any) -> None: ...
    async def owned_by(self, owner: str) -> list[str]: ...
    async def set_owned_by(self, owner: str, ids: list[str]) -> None: ...


class MemoryStore(Entries):
    def __init__(self) -> None:
        self.entries: dict[str, str] = {}

    async def _get(self, entry: str) -> str | None:
        return self.entries.get(entry)

    async def _put(self, entry: str, raw: str | None) -> None:
        if raw is None:
            self.entries.pop(entry, None)
        else:
            self.entries[entry] = raw


class ModalStore(Entries):
    """The entries in a Modal Dict.

    Every write also goes to `<root>/<entry>.json` on the Volume, at most every
    `flush_s` seconds per entry (an FOV drag is ~10 writes per second). A Dict
    miss falls back to the Volume and refills the Dict.
    """

    def __init__(self, dict_, volume, root: Path, flush_s: float = 5.0) -> None:
        self.dict = dict_
        self.volume = volume
        self.root = root
        self.flush_s = flush_s
        self._dirty: dict[str, str | None] = {}
        self._flush_task: asyncio.Task | None = None

    async def _get(self, entry: str) -> str | None:
        raw = await self.dict.get.aio(entry)
        if raw is None:
            raw = await asyncio.to_thread(self._read_durable, entry)
            if raw is not None:
                await self.dict.put.aio(entry, raw)
        return raw

    async def _put(self, entry: str, raw: str | None) -> None:
        if raw is None:
            await self.dict.pop.aio(entry, None)
        else:
            await self.dict.put.aio(entry, raw)
        self._dirty[entry] = raw
        if self._flush_task is None or self._flush_task.done():
            self._flush_task = asyncio.create_task(self._flush_later())

    async def _flush_later(self) -> None:
        await asyncio.sleep(self.flush_s)
        await self.flush()

    async def flush(self) -> None:
        dirty, self._dirty = self._dirty, {}
        if dirty:
            await asyncio.to_thread(self._write_durable, dirty)

    def _path(self, entry: str) -> Path:
        return self.root / f"{entry.replace(':', '_')}.json"

    def _read_durable(self, entry: str) -> str | None:
        try:
            self.volume.reload()
        except Exception:  # reload fails while files are open; the read may still work
            log.debug("volume reload failed", exc_info=True)
        path = self._path(entry)
        return path.read_text() if path.exists() else None

    def _write_durable(self, dirty: dict[str, str | None]) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        for entry, raw in dirty.items():
            path = self._path(entry)
            if raw is None:
                path.unlink(missing_ok=True)
            else:
                path.write_text(raw)
        self.volume.commit()
