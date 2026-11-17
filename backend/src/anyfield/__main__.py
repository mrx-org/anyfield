"""Run the server in memory, without Modal: `uv run python -m anyfield`.

For tests and frontend development only (production runs on Modal). Without
WORKOS_AUTHKIT_DOMAIN there is no login; session management then acts as the
fixed user `dev` (set ANYFIELD_DEV_USER to change it).
"""

from __future__ import annotations

import argparse
import os
import tempfile
from pathlib import Path

import uvicorn

from .gateway import GatewayClient
from .phantoms import local_library
from .server import build, http_app
from .store import MemoryStore


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument(
        "--static", type=Path, default=Path(__file__).resolve().parents[3] / "frontend" / "dist"
    )
    args = parser.parse_args()
    base_url = f"http://127.0.0.1:{args.port}"
    auth = None
    if "WORKOS_AUTHKIT_DOMAIN" in os.environ:
        from .auth import authkit_auth

        auth = authkit_auth(base_url)
    else:
        os.environ.setdefault("ANYFIELD_DEV_USER", "dev")
    library = local_library(Path(tempfile.gettempdir()) / "anyfield-phantoms")
    # With MRX_VISITOR_KEY: the real gateway, as `visitor` (or exchanged with the WorkOS env)
    gateway = GatewayClient.from_env()
    mcp = build(MemoryStore(), base_url, auth=auth, static_dir=args.static, library=library, gateway=gateway)
    uvicorn.run(http_app(mcp), port=args.port)


if __name__ == "__main__":
    main()
