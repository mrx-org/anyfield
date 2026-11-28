"""Projects, their tree of states and their sessions (pointers into the tree).

A change of a session's state adds a node after the session's head, or replaces the
head if it is the same change by the same actor within `history.MERGE_S` (see
history.py), and moves the session there. Undo, redo and jumps only move the
session's pointer; a change after an undo starts a new branch. A project never has
no session: where one would be left without, a session `default` is created on its
newest leaf.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict
from collections.abc import Awaitable, Callable

from fastmcp.exceptions import ToolError
from fastmcp.server.dependencies import get_context
from pydantic import ValidationError

from .auth import current_user
from .history import MERGE_S, changed_keys, children, newest, node_hash
from .models import SESSION_COLORS, Node, NodeInfo, Project, Session, SessionRef, State, new_key
from .store import SessionStore

log = logging.getLogger(__name__)

DEFAULT_SESSION = "default"
Check = Callable[[State, State], Awaitable[State]]


def current_actor() -> str:
    """Who makes the current tool call: the anyfield client (`anyfield/client` in the
    request's `_meta`: the website, an MCP App), else the MCP client's name (e.g. the
    chat host), and with a login the user."""
    name = None
    try:
        ctx = get_context()
        meta = (ctx.request_context.meta if ctx.request_context else None) or {}
        name = meta.get("anyfield/client")
        if not name:
            params = ctx.session.client_params
            name = params.client_info.name if params else None
        if not name:
            name = (meta.get("io.modelcontextprotocol/clientInfo") or {}).get("name")
    except (RuntimeError, AttributeError):  # outside a request (tests calling directly)
        log.debug("no client info", exc_info=True)
    user = current_user()
    who = name or "unknown"
    return f"{who} ({user.login or user.id})" if user else who


class Projects:
    def __init__(self, store: SessionStore) -> None:
        self.store = store
        self._locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    def lock(self, project_id: str) -> asyncio.Lock:
        """Changes of a project and its sessions run one after the other (per container)."""
        return self._locks[project_id]

    # --- reading --------------------------------------------------------------

    async def session(self, key: str) -> Session:
        s = await self.store.get(key)
        if s is None:
            raise ToolError("Unknown session key.")
        return s

    async def project(self, project_id: str) -> Project:
        p = await self.store.get_project(project_id)
        if p is None:
            raise ToolError("Unknown project.")
        return p

    async def node(self, project_id: str, h: str) -> Node:
        n = await self.store.get_node(project_id, h)
        if n is None:
            raise ToolError(f"Unknown state {h!r} in this project.")
        return n

    # --- projects -------------------------------------------------------------

    async def create_project(self, name: str, owner: str | None) -> tuple[Project, Session]:
        """A project with one state (the default) and a session `default` on it."""
        now = time.time()
        state = State()
        actor = current_actor()
        h = node_hash(None, state.model_dump(), [], actor, now)
        project = Project(id=new_key(), name=name, owner=owner, created_at=now, updated_at=now)
        project.nodes[h] = NodeInfo(parent=None, change=[], actor=actor, time=now)
        project.leaves = [h]
        await self.store.put_node(project.id, Node(hash=h, parent=None, state=state, actor=actor, time=now))
        session = await self._new_session(project, h, DEFAULT_SESSION, state)
        await self.store.put_project(project)
        return project, session

    async def delete_project(self, project: Project) -> None:
        for key in project.sessions:
            await self.store.delete(key)
        for h in project.nodes:
            await self.store.delete_node(project.id, h)
        await self.store.delete_project(project.id)

    async def ensure_session(self, project: Project) -> Project:
        """The project, with a session `default` on its newest leaf if it had none."""
        if project.sessions:
            return project
        async with self.lock(project.id):
            project = await self.project(project.id)
            if not project.sessions:
                h = newest(project.nodes, project.leaves) or next(iter(project.nodes))
                await self._new_session(project, h, DEFAULT_SESSION)
                await self.store.put_project(project)
        return project

    # --- sessions -------------------------------------------------------------

    async def _new_session(self, project: Project, at: str, name: str, state: State | None = None) -> Session:
        """A session on node `at`, added to the project (the caller stores the project)."""
        used = {ref.color for ref in project.sessions.values()}
        color = next(
            (c for c in SESSION_COLORS if c not in used),
            SESSION_COLORS[len(project.sessions) % len(SESSION_COLORS)],
        )
        if state is None:
            state = (await self.node(project.id, at)).state
        now = time.time()
        session = Session(
            key=new_key(), project=project.id, name=name, color=color, head=at, state=state, rev=1
        )
        project.sessions[session.key] = SessionRef(name=name, color=color, head=at, updated_at=now)
        await self.store.put(session)
        return session

    async def branch(self, key: str, at: str | None, name: str | None) -> Session:
        """A new session of the same project on node `at` (default: this session's head)."""
        s = await self.session(key)
        async with self.lock(s.project):
            project = await self.project(s.project)
            target = at or s.head
            if target not in project.nodes:
                raise ToolError(f"Unknown state {target!r} in this project.")
            new = await self._new_session(project, target, (name or "").strip() or f"{s.name} 2")
            await self.store.put_project(project)
            return new

    async def rename_session(self, key: str, name: str) -> Session:
        s = await self.session(key)
        async with self.lock(s.project):
            s = await self.session(key)
            project = await self.project(s.project)
            s.name = name.strip() or s.name
            s.rev += 1
            project.sessions[key].name = s.name
            await self.store.put(s)
            await self.store.put_project(project)
            return s

    async def delete_session(self, key: str) -> tuple[Project, Session | None]:
        """Delete a session (its states stay). Returns the project and the session to
        go on with: the most recently changed one left, or, if it was the last, a new
        session `default` on the project's newest leaf."""
        s = await self.session(key)
        async with self.lock(s.project):
            project = await self.project(s.project)
            project.sessions.pop(key, None)
            await self.store.delete(key)
            await self.store.put_project(project)
        project = await self.ensure_session(project)
        left = max(project.sessions, key=lambda k: project.sessions[k].updated_at, default=None)
        return project, (await self.store.get(left)) if left else None

    # --- changing the state -----------------------------------------------------

    async def change(
        self, key: str, fn: Callable[[State], State], check: Check, expected_rev: int | None = None
    ) -> Session:
        """Apply `fn` to the session's state (validated by `check`) and commit it: a new
        node after the head, or the head replaced (same change by the same actor
        within MERGE_S, the head a leaf no other session points at)."""
        s = await self.session(key)
        async with self.lock(s.project):
            s = await self.session(key)
            if expected_rev is not None and expected_rev != s.rev:
                raise ToolError(f"Conflict: session is at rev {s.rev}, not {expected_rev}. Re-read it.")
            try:
                new = fn(s.state.model_copy(deep=True))
            except (ValueError, ValidationError) as e:
                raise ToolError(str(e)) from e
            new = await check(s.state, new)
            old_d, new_d = s.state.model_dump(mode="json"), new.model_dump(mode="json")
            keys = changed_keys(old_d, new_d)
            if not keys:
                return s
            project = await self.project(s.project)
            actor, now = current_actor(), time.time()
            head = project.nodes.get(s.head)
            others = any(k != key and ref.head == s.head for k, ref in project.sessions.items())
            merge = (
                head is not None
                and head.parent is not None
                and head.actor == actor
                and head.change == keys
                and now - head.time < MERGE_S
                and s.head in project.leaves
                and not others
            )
            if merge:
                parent = head.parent
                project.nodes.pop(s.head)
                project.leaves.remove(s.head)
                await self.store.delete_node(project.id, s.head)
            else:
                parent = s.head
                if s.head in project.leaves:
                    project.leaves.remove(s.head)
            h = node_hash(parent, new_d, keys, actor, now)
            await self.store.put_node(
                project.id, Node(hash=h, parent=parent, state=new, change=keys, actor=actor, time=now)
            )
            project.nodes[h] = NodeInfo(parent=parent, change=keys, actor=actor, time=now)
            project.leaves.append(h)
            project.updated_at = now
            return await self._point(project, s, h, new, now)

    async def _point(
        self, project: Project, s: Session, h: str, state: State, now: float | None = None
    ) -> Session:
        """Move session `s` to node `h` (with its state) and store both."""
        now = now or time.time()
        s.head, s.state, s.rev, s.updated_at = h, state, s.rev + 1, now
        ref = project.sessions.get(s.key)
        if ref is None:
            project.sessions[s.key] = SessionRef(name=s.name, color=s.color, head=h, updated_at=now)
        else:
            ref.head, ref.updated_at = h, now
        await self.store.put(s)
        await self.store.put_project(project)
        return s

    async def goto(self, key: str, target: str) -> Session:
        """Move the session to any state of its project."""
        s = await self.session(key)
        async with self.lock(s.project):
            s = await self.session(key)
            project = await self.project(s.project)
            if target not in project.nodes:
                raise ToolError(f"Unknown state {target!r} in this project.")
            if target == s.head:
                return s
            return await self._point(project, s, target, (await self.node(project.id, target)).state)

    async def undo(self, key: str, steps: int = 1) -> Session:
        """Back to the parent, `steps` times (at most to the root)."""
        s = await self.session(key)
        async with self.lock(s.project):
            s = await self.session(key)
            project = await self.project(s.project)
            h = s.head
            for _ in range(steps):
                parent = project.nodes[h].parent
                if parent is None:
                    break
                s.redo[parent] = h
                h = parent
            if h == s.head:
                return s
            return await self._point(project, s, h, (await self.node(project.id, h)).state)

    async def redo(self, key: str, steps: int = 1) -> Session:
        """Forward to a child, `steps` times: the one this session came back from,
        else the newest."""
        s = await self.session(key)
        async with self.lock(s.project):
            s = await self.session(key)
            project = await self.project(s.project)
            h = s.head
            for _ in range(steps):
                kids = children(project.nodes, h)
                if not kids:
                    break
                remembered = s.redo.get(h)
                h = remembered if remembered in kids else kids[-1]
            if h == s.head:
                return s
            return await self._point(project, s, h, (await self.node(project.id, h)).state)
