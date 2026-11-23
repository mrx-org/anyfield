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
from typing import Annotated, Any

from fastmcp import FastMCP
from fastmcp.apps.config import AppConfig
from fastmcp.exceptions import ToolError
from pydantic import Field

from .auth import current_user

Call = Callable[[str, dict[str, Any]], Awaitable[Any]]

UPLOAD_APP_URI = "ui://anyfield/file-upload.html"
LIST_APP_URI = "ui://anyfield/file-list.html"
MANAGER_APP_URI = "ui://anyfield/file-manager.html"


# Listing is slow at the gateway (it scans its whole index): the list is kept per
# user for a while, per container. `refresh` (the list's reload button, after an
# upload) asks the gateway again.
LIST_TTL = 300  # seconds
MAX_CACHED = 1000


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

    async def list(self, refresh: bool = False) -> list[dict[str, Any]]:
        """`{sha256, name, type, size, uploaded_at, url}` per file, newest first;
        from the cache unless `refresh` or older than `LIST_TTL`."""
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


def register(mcp: FastMCP, files: UserFiles, *, base_url: str, static_dir: Path | None) -> None:
    from .server import app_html

    @mcp.tool(annotations={"readOnlyHint": True})
    async def list_user_files(
        refresh: Annotated[
            bool, Field(description="Ask the gateway again instead of a list from the last minutes")
        ] = False,
    ) -> list[dict[str, Any]]:
        """The caller's files in the MRX gateway's storage (uploads and tool results),
        newest first: `sha256` (pass it to tools), `name`, `type`, `size` (bytes),
        `uploaded_at` and `url` to download it. The gateway removes a file a day
        after its last use. The list may be a few minutes old; `refresh` for the
        current one (e.g. right after an upload)."""
        return await files.list(refresh)

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
    async def open_file_list() -> dict[str, Any]:
        """Show the user's files as a sortable table (name, type, size, uploaded)
        with download buttons; clicking a name sends its name and sha256 to
        the chat. Returns the files too (see list_user_files)."""
        return {"files": await files.list()}

    @mcp.tool(app=AppConfig(resource_uri=MANAGER_APP_URI), annotations={"readOnlyHint": True})
    async def open_file_manager() -> dict[str, Any]:
        """Show the file manager: the file upload above the file list (see
        open_file_upload and open_file_list). Returns the files too."""
        return {"files": await files.list()}

    app_html(mcp, UPLOAD_APP_URI, "File upload", "file-upload-app.html", base_url, static_dir)
    app_html(mcp, LIST_APP_URI, "File list", "file-list-app.html", base_url, static_dir)
    app_html(mcp, MANAGER_APP_URI, "File manager", "file-manager-app.html", base_url, static_dir)
