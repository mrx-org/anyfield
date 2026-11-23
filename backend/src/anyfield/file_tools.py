"""The caller's files in the gateway's CAS: upload, list, download. A tool of its own
(three UI tools: upload, list, both as file manager). anyfield keeps no files; the
bytes go straight between the browser and the gateway:

- upload: `create_file_upload_url` hands out the gateway's short-lived upload URL
  (`create_upload_url`), the browser PUTs the file there and gets its sha256 back;
- list: the gateway's `list_files` for the caller;
- download: `<gateway>/files/<sha256>`, no login needed (the hash is the permission).
"""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Annotated, Any, Literal

from fastmcp import FastMCP
from fastmcp.apps.config import AppConfig
from fastmcp.exceptions import ToolError
from pydantic import Field

from .args import OptionalSessionKey
from .auth import current_user

Call = Callable[[str, dict[str, Any]], Awaitable[Any]]
FileMode = Literal["all", "bifti"]
ModeArg = Annotated[
    FileMode | None,
    Field(
        description="'all' files or only 'bifti' phantoms (.zip; whether one really is a phantom shows when its maps load)"
    ),
]

UPLOAD_APP_URI = "ui://anyfield/file-upload.html"
LIST_APP_URI = "ui://anyfield/file-list.html"
MANAGER_APP_URI = "ui://anyfield/file-manager.html"


# Listing is slow at the gateway (it scans its whole index): the list is kept per
# user for a while, per container. `refresh` (the list's reload button, after an
# upload) asks the gateway again.
LIST_TTL = 300  # seconds
MAX_CACHED = 1000


def is_bifti(f: dict[str, Any]) -> bool:
    """A bifti phantom as far as a listing can tell: a .zip (as `CasFiles`)."""
    return str(f.get("name", "")).lower().endswith(".zip") or "zip" in str(f.get("type") or "")


class UserFiles:
    def __init__(self, call: Call | None, gateway_url: str) -> None:
        self._call = call
        self.gateway_url = gateway_url.rstrip("/")
        # user id ("" without a login) -> (monotonic time, list)
        self._lists: dict[str, tuple[float, list[dict[str, Any]]]] = {}

    @staticmethod
    def _who() -> str:
        user = current_user()
        return user.id if user else ""

    def _need(self) -> Call:
        if self._call is None:
            raise ToolError("The MRX gateway is not available on this server.")
        return self._call

    async def list(self, refresh: bool = False, mode: FileMode = "all") -> list[dict[str, Any]]:
        """`{sha256, name, type, size, uploaded_at, url}` per file, newest first;
        `mode` 'bifti': only the bifti phantoms. From the cache unless `refresh` or
        older than `LIST_TTL`."""
        listed = await self._all(refresh)
        return [f for f in listed if is_bifti(f)] if mode == "bifti" else listed

    async def _all(self, refresh: bool) -> list[dict[str, Any]]:
        who, now = self._who(), time.monotonic()
        cached = self._lists.get(who)
        if not refresh and cached is not None and now - cached[0] < LIST_TTL:
            return cached[1]
        files = await self._need()("list_files", {})
        if isinstance(files, dict):
            files = files.get("result", files.get("files", []))
        out: dict[str, dict[str, Any]] = {}
        for f in files or []:
            sha = str(f.get("hash", ""))
            if not sha or sha in out:
                continue
            out[sha] = {
                "sha256": sha,
                "name": str(f.get("name", "")),
                "type": f.get("type"),
                "size": f.get("size"),
                "uploaded_at": f.get("uploaded_at"),
                "url": self.download_url(sha),
            }
        result = sorted(out.values(), key=lambda f: f["uploaded_at"] or "", reverse=True)
        if len(self._lists) >= MAX_CACHED:
            self._lists.clear()
        self._lists[who] = (now, result)
        return result

    async def upload_url(self, file_name: str) -> dict[str, Any]:
        r = await self._need()("create_upload_url", {"file_name": file_name})
        if not isinstance(r, dict) or "url" not in r:
            raise ToolError("The MRX gateway returned no upload URL.")
        return {"url": r["url"], "expires_in": r.get("expires_in")}

    def download_url(self, sha256: str) -> str:
        return f"{self.gateway_url}/files/{sha256}"


def register(
    mcp: FastMCP,
    files: UserFiles,
    *,
    opened: Callable[[str | None], Awaitable[dict[str, Any]]],
    base_url: str,
    static_dir: Path | None,
) -> None:
    from .server import app_html

    @mcp.tool(annotations={"readOnlyHint": True})
    async def list_user_files(
        mode: ModeArg = None,
        refresh: Annotated[
            bool, Field(description="Ask the gateway again instead of a list from the last minutes")
        ] = False,
    ) -> list[dict[str, Any]]:
        """The caller's files in the MRX gateway's storage (uploads and tool results),
        newest first: `sha256` (pass it to tools), `name`, `type`, `size` (bytes),
        `uploaded_at` and `url` to download it. The gateway removes a file a day
        after its last use. The list may be a few minutes old; `refresh` for the
        current one (e.g. right after an upload). `mode='bifti'` for the phantoms
        (pass one to select_phantom as `sha256`)."""
        return await files.list(refresh, mode or "all")

    @mcp.tool
    async def create_file_upload_url(
        file_name: Annotated[str, Field(description="Name to store the file under, e.g. 'brain.zip'")],
    ) -> dict[str, Any]:
        """A short-lived URL (`url`, valid `expires_in` seconds) to upload one file to
        the caller's files: PUT the bytes there, the response body is its sha256. The
        file upload tool uses it; an agent with a shell can too (`curl -T <path> <url>`)."""
        return await files.upload_url(file_name)

    @mcp.tool(app=AppConfig(resource_uri=UPLOAD_APP_URI), annotations={"readOnlyHint": True})
    async def open_file_upload() -> dict[str, Any]:
        """Show the file upload: the user drops files (or picks them) to store them in
        their files; each upload's name and sha256 come back to the chat. In clients
        without MCP Apps: use create_file_upload_url."""
        return {"message": "Drop files into the box to upload them."}

    @mcp.tool(app=AppConfig(resource_uri=LIST_APP_URI), annotations={"readOnlyHint": True})
    async def open_file_list(
        session_key: OptionalSessionKey = None,
        mode: Annotated[
            FileMode | None,
            Field(
                description="Fix what the list shows: 'all' files or only 'bifti' phantoms (the type "
                "column is left out). Omit to let the user switch."
            ),
        ] = None,
        download: Annotated[bool, Field(description="Show the download buttons")] = True,
    ) -> dict[str, Any]:
        """Show the user's files as a sortable, searchable table (name, type, size,
        uploaded) with download buttons. Clicking a name: without a session it sends
        `"name": <sha256>` to the chat; with a session it depends on the mode - in
        'bifti' mode it makes the file the session's phantom, in 'all' mode nothing.
        E.g. mode='bifti' to let the user pick one of their phantoms. Returns the files
        (and with a session the session) too."""
        listed = await files.list(mode=mode or "all")
        return {**(await opened(session_key) if session_key else {}), "files": listed}

    @mcp.tool(app=AppConfig(resource_uri=MANAGER_APP_URI), annotations={"readOnlyHint": True})
    async def open_file_manager() -> dict[str, Any]:
        """Show the file manager: the file upload above the file list (see
        open_file_upload and open_file_list). Returns the files too."""
        return {"files": await files.list()}

    app_html(mcp, UPLOAD_APP_URI, "File upload", "file-upload-app.html", base_url, static_dir)
    app_html(mcp, LIST_APP_URI, "File list", "file-list-app.html", base_url, static_dir)
    app_html(mcp, MANAGER_APP_URI, "File manager", "file-manager-app.html", base_url, static_dir)
