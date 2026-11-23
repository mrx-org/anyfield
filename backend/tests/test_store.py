from anyfield.models import Session
from anyfield.store import ModalStore


class FakeDict:
    def __init__(self):
        self.data = {}
        outer = self

        class Op:
            def __init__(self, fn):
                self.aio = fn

        async def get(k, default=None):
            return outer.data.get(k, default)

        async def put(k, v):
            outer.data[k] = v

        async def pop(k, default=None):
            return outer.data.pop(k, default)

        self.get, self.put, self.pop = Op(get), Op(put), Op(pop)


class FakeVolume:
    commits = 0

    def reload(self):
        pass

    def commit(self):
        self.commits += 1


async def test_dict_miss_falls_back_to_volume(tmp_path):
    d, v = FakeDict(), FakeVolume()
    store = ModalStore(d, v, tmp_path, flush_s=0)
    await store.put(Session(key="k1", name="a"))
    await store.set_owned_by("u", ["k1"])
    await store.flush()
    assert v.commits == 1

    d.data.clear()  # what Modal does after 7 idle days
    assert (await store.get("k1")).name == "a"
    assert await store.owned_by("u") == ["k1"]
    assert "s:k1" in d.data  # refilled

    await store.delete("k1")
    await store.flush()
    d.data.clear()
    assert await store.get("k1") is None


def test_reads_sessions_stored_with_a_plane():
    raw = '{"key": "k", "name": "n", "state": {"view": {"property": "T1", "plane": "cor", "tissues": null}}}'
    s = Session.model_validate_json(raw)
    assert s.state.view.property == "T1" and "plane" not in s.state.view.model_dump()
