import json

import pytest

from anyfield.migrations import MARKER, SCHEMA_VERSION, migrate, migrate_json, migrate_modal_store
from anyfield.models import Node, Project, Session
from anyfield.store import MemoryStore

# A session as version 0 stored it (before 23.11.2026): no `version`, plane and tissues in the view
V0 = {
    "key": "k",
    "name": "n",
    "rev": 3,
    "state": {
        "phantom": None,
        "view": {"property": "T1", "plane": "cor", "tissues": ["WM"]},
        "fov": {"center_mm": [0, 0, 0], "rotation_deg": [0, 0, 0], "size_mm": [200, 200, 100]},
        "matrix": [128, 128, 1],
    },
}


def test_v0_to_current():
    s = migrate(V0)
    assert s["version"] == SCHEMA_VERSION
    assert s["state"]["view"] == {"property": "T1"} and s["state"]["tissues"] == ["WM"]
    s.pop("_extra")
    session = Session.model_validate(s)
    assert session.state.tissues == ["WM"] and session.rev == 3


# A session as version 2 stored it (before 28.11.2026): its own state, owner and name
V2 = {
    "version": 2,
    "key": "k",
    "name": "Kopf",
    "owner": "alice",
    "created_at": 10.0,
    "updated_at": 20.0,
    "rev": 7,
    "state": {
        "phantom": None,
        "tissues": None,
        "view": {"property": "T1"},
        "fov": {"center_mm": [0, 0, 0], "rotation_deg": [0, 0, 0], "size_mm": [200, 200, 100]},
        "matrix": [128, 128, 1],
        "layout": {"root": {"tabs": [{"id": "a", "tool": "session", "options": {}}], "active": 0}},
    },
}


def test_v2_session_becomes_a_project_with_one_session():
    s = migrate(V2)
    extra = s.pop("_extra")
    session = Session.model_validate(s)
    assert session.key == "k" and session.project == "k" and session.name == "default" and session.rev == 7
    assert session.state.layout.root.tabs[0].tool == "state"  # the JSON editor was renamed
    project = Project.model_validate(extra["p:k"])
    assert project.name == "Kopf" and project.owner == "alice"
    assert project.leaves == [session.head] and project.sessions["k"].head == session.head
    node = Node.model_validate(extra[f"n:k:{session.head}"])
    assert node.parent is None and node.state == session.state


async def test_the_store_writes_the_project_of_an_old_session():
    store = MemoryStore()
    store.entries["s:k"] = json.dumps(V2)
    s = await store.get("k")
    project = await store.get_project("k")
    assert project is not None and project.sessions["k"].head == s.head
    assert (await store.get_node("k", s.head)).state == s.state
    assert json.loads(store.entries["s:k"])["version"] == SCHEMA_VERSION


def test_v1_tissues_move_next_to_the_phantom():
    v1 = {**V0, "version": 1, "state": {**V0["state"], "view": {"property": "PD", "tissues": ["GM"]}}}
    s = migrate(v1)
    assert s["state"]["view"] == {"property": "PD"} and s["state"]["tissues"] == ["GM"]
    v1 = {**v1, "state": {**v1["state"], "view": {"property": "PD"}}}
    assert "tissues" not in migrate(v1)["state"]  # none: the default (all)


def test_current_stays_and_newer_is_refused():
    current = json.dumps(migrate(V0))
    assert migrate_json(current) is None
    with pytest.raises(ValueError, match="newer"):
        migrate({**V0, "version": SCHEMA_VERSION + 1})


def test_new_sessions_carry_the_current_version():
    assert Session(key="k", project="p", name="n", head="h").version == SCHEMA_VERSION


async def test_the_store_reads_old_sessions():
    store = MemoryStore()
    store.entries["s:k"] = json.dumps(V0)
    s = await store.get("k")
    assert s is not None and s.state.tissues == ["WM"]


class SyncDict:
    """The sync API of modal.Dict that the startup migration uses."""

    def __init__(self, data):
        self.data = dict(data)

    def keys(self):
        return iter(self.data)

    def get(self, k, default=None):
        return self.data.get(k, default)

    def put(self, k, v):
        self.data[k] = v


class FakeVolume:
    commits = 0

    def reload(self):
        pass

    def commit(self):
        self.commits += 1


def test_startup_migrates_dict_and_volume_once(tmp_path):
    d = SyncDict({"s:k": json.dumps(V0), "o:owner": json.dumps(["k"])})
    (tmp_path / "s_k.json").write_text(json.dumps(V0))
    (tmp_path / "o_owner.json").write_text(json.dumps(["k"]))
    vol = FakeVolume()

    assert migrate_modal_store(d, vol, tmp_path) == 2
    assert json.loads(d.data["s:k"])["version"] == SCHEMA_VERSION
    assert json.loads((tmp_path / "s_k.json").read_text())["state"]["view"] == {"property": "T1"}
    assert json.loads(d.data["p:k"])["id"] == "k" and (tmp_path / "p_k.json").exists()
    assert d.data["o:owner"] == json.dumps(["k"])  # owner lists are no sessions
    assert d.data[MARKER] == SCHEMA_VERSION and vol.commits == 1

    # Marked: the next start does nothing
    d.data["s:k"] = json.dumps(V0)
    assert migrate_modal_store(d, vol, tmp_path) == 0
    assert vol.commits == 1


def test_startup_without_a_volume_dir(tmp_path):
    d = SyncDict({})
    assert migrate_modal_store(d, FakeVolume(), tmp_path / "missing") == 0
    assert d.data[MARKER] == SCHEMA_VERSION
