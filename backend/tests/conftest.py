import pytest
from fastmcp import Client

from anyfield.server import build
from anyfield.store import MemoryStore

BASE_URL = "https://anyfield.test"


@pytest.fixture
def store():
    return MemoryStore()


@pytest.fixture
def mcp(store):
    return build(store, BASE_URL)


@pytest.fixture
async def client(mcp):
    async with Client(mcp) as c:
        yield c


@pytest.fixture
def as_user(monkeypatch):
    """Act as a logged-in user (in-memory calls carry no token)."""

    def login(user_id: str | None):
        if user_id is None:
            monkeypatch.delenv("ANYFIELD_DEV_USER", raising=False)
        else:
            monkeypatch.setenv("ANYFIELD_DEV_USER", user_id)

    return login
