import json

import pytest

from anyfield.migrations import MARKER, SCHEMA_VERSION, migrate, migrate_json, migrate_modal_store
from anyfield.models import Session
from anyfield.store import MemoryStore

# A session as version 0 stored it (before 23.11.2026): no `version`, a plane in the view
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
    assert s["state"]["view"] == {"property": "T1", "tissues": ["WM"]}
    session = Session.model_validate(s)
    assert session.state.view.tissues == ["WM"] and session.rev == 3


def test_current_stays_and_newer_is_refused():
    current = json.dumps(migrate(V0))
    assert migrate_json(current) is None
    with pytest.raises(ValueError, match="newer"):
        migrate({**V0, "version": SCHEMA_VERSION + 1})


def test_new_sessions_carry_the_current_version():
    assert Session(key="k", name="n").version == SCHEMA_VERSION


async def test_the_store_reads_old_sessions():
    store = MemoryStore()
    store.sessions["k"] = json.dumps(V0)
    s = await store.get("k")
    assert s is not None and s.state.view.tissues == ["WM"]


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
    assert "plane" not in json.loads((tmp_path / "s_k.json").read_text())["state"]["view"]
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
