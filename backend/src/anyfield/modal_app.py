"""Deployment on Modal (workspace mrx-org): `modal deploy -m anyfield.modal_app`.

Serves `web` at `https://mrx-org--anyfield-web.us-east.modal.run` (the URL
Modal reports; the host without `us-east` is an alias that redirects there).
Login through WorkOS AuthKit: needs the Modal secrets `workos-anyfield`
(WORKOS_AUTHKIT_DOMAIN, WORKOS_CLIENT_ID, WORKOS_CLIENT_SECRET) and
`mrx-visitor` (MRX_VISITOR_KEY, shared with the gateway). `<BASE_URL>/mcp` must
be a Resource Indicator in WorkOS.
"""

from __future__ import annotations

import os
from pathlib import Path

import modal

APP_NAME = "anyfield"
BASE_URL = os.environ.get("ANYFIELD_BASE_URL", f"https://mrx-org--{APP_NAME}-web.us-east.modal.run")
STATE_PATH = Path("/state")
STATIC_DIR = Path("/static")

app = modal.App(APP_NAME)
sessions_dict = modal.Dict.from_name("anyfield-sessions", create_if_missing=True)
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


PHANTOM_ROOT = STATE_PATH / "phantoms"


@app.function(
    image=image,
    volumes={str(STATE_PATH): state_volume},
    memory=16384,  # a 0.5 mm brain takes several GB while it is resampled
    timeout=900,
)
def prepare_phantom(collection: str, name: str) -> dict:
    """Download a BIfTI phantom and write its display maps to the state volume."""
    from .phantoms import prepare

    meta = prepare(collection, name, PHANTOM_ROOT, PHANTOM_ROOT / "_downloads")
    state_volume.commit()
    return meta


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("workos-anyfield"), modal.Secret.from_name("mrx-visitor")],
    volumes={str(STATE_PATH): state_volume},
    min_containers=0,
    scaledown_window=300,
    timeout=900,  # select_phantom waits while a new phantom is prepared
)
@modal.concurrent(max_inputs=100)
@modal.asgi_app()
def web():
    from .auth import authkit_auth
    from .phantoms import PhantomLibrary
    from .server import build, http_app
    from .store import ModalStore

    store = ModalStore(sessions_dict, state_volume, STATE_PATH / "sessions")
    auth = authkit_auth(BASE_URL)
    library = PhantomLibrary(PHANTOM_ROOT, prepare_phantom.remote.aio, reload=state_volume.reload)
    return http_app(build(store, BASE_URL, auth=auth, static_dir=STATIC_DIR, library=library))
