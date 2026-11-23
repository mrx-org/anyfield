"""Where sessions live.

`MemoryStore` for tests and local runs. `ModalStore` on Modal: a Modal Dict as
the fast store every container sees, plus a Volume as durable copy, because a
Dict entry expires after 7 days without reads or writes.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Protocol

from .migrations import migrate_json
from .models import Session

log = logging.getLogger(__name__)


def load_session(raw: str) -> Session:
    """A stored session, migrated to the current schema if it is older (migrations.py)."""
    return Session.model_validate_json(migrate_json(raw) or raw)


class SessionStore(Protocol):
    async def get(self, key: str) -> Session | None: ...
    async def put(self, session: Session) -> None: ...
    async def delete(self, key: str) -> None: ...
    async def owned_by(self, owner: str) -> list[str]: ...
    async def set_owned_by(self, owner: str, keys: list[str]) -> None: ...


class MemoryStore:
    def __init__(self) -> None:
        self.sessions: dict[str, str] = {}
        self.owners: dict[str, list[str]] = {}

    async def get(self, key: str) -> Session | None:
        raw = self.sessions.get(key)
        return None if raw is None else load_session(raw)

    async def put(self, session: Session) -> None:
        self.sessions[session.key] = session.model_dump_json()

    async def delete(self, key: str) -> None:
        self.sessions.pop(key, None)

    async def owned_by(self, owner: str) -> list[str]:
        return list(self.owners.get(owner, []))

    async def set_owned_by(self, owner: str, keys: list[str]) -> None:
        self.owners[owner] = list(keys)


class ModalStore:
    """Dict entries `s:<key>` (session JSON) and `o:<owner>` (list of keys).

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

    async def get(self, key: str) -> Session | None:
        raw = await self._get(f"s:{key}")
        return None if raw is None else load_session(raw)

    async def put(self, session: Session) -> None:
        await self._put(f"s:{session.key}", session.model_dump_json())

    async def delete(self, key: str) -> None:
        await self._put(f"s:{key}", None)

    async def owned_by(self, owner: str) -> list[str]:
        raw = await self._get(f"o:{owner}")
        return [] if raw is None else json.loads(raw)

    async def set_owned_by(self, owner: str, keys: list[str]) -> None:
        await self._put(f"o:{owner}", json.dumps(keys))
