"""Deployment on Modal (workspace mrx-org): `modal deploy -m anyfield.modal_app`.

Serves `web` at `https://mrx-org--anyfield-web.modal.run`. Needs the Modal
secret `gh_oauth` with GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET
(a GitHub OAuth app whose callback URL is `<BASE_URL>/auth/callback`).
"""

from __future__ import annotations

import os
from pathlib import Path

import modal

APP_NAME = "anyfield"
BASE_URL = os.environ.get("ANYFIELD_BASE_URL", f"https://mrx-org--{APP_NAME}-web.modal.run")
STATE_PATH = Path("/state")
STATIC_DIR = Path("/static")

app = modal.App(APP_NAME)
sessions_dict = modal.Dict.from_name("anyfield-sessions", create_if_missing=True)
oauth_dict = modal.Dict.from_name("anyfield-oauth-state", create_if_missing=True)
state_volume = modal.Volume.from_name("anyfield-state", create_if_missing=True, version=2)

image = modal.Image.debian_slim(python_version="3.13")
if modal.is_local():
    # Local paths only exist where `modal deploy` runs; inside the container the
    # image is already built.
    backend_dir = Path(__file__).resolve().parents[2]
    frontend_dist = backend_dir.parent / "frontend" / "dist"
    if not (frontend_dist / "index.html").exists():
        raise RuntimeError(f"Build the frontend first: {frontend_dist} is missing")
    image = (
        image.uv_sync(str(backend_dir), extra_options="--no-dev")
        .env({"ANYFIELD_BASE_URL": BASE_URL})
        .add_local_dir(frontend_dist, str(STATIC_DIR))
        # Not only .py: the default phantom in `data/` too
        .add_local_python_source("anyfield", ignore=["**/__pycache__/**"])
    )


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("gh_oauth")],
    volumes={str(STATE_PATH): state_volume},
    min_containers=0,
    scaledown_window=300,
    timeout=120,
)
@modal.concurrent(max_inputs=100)
@modal.asgi_app()
def web():
    from .auth import DictKeyValue, encrypted, github_auth
    from .server import build, http_app
    from .store import ModalStore

    store = ModalStore(sessions_dict, state_volume, STATE_PATH / "sessions")
    auth = github_auth(BASE_URL, client_storage=encrypted(DictKeyValue(oauth_dict)))
    return http_app(build(store, BASE_URL, auth=auth, static_dir=STATIC_DIR))
