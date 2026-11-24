"""Answer every GitHub request a booted page makes, without touching GitHub.

Booting index.html lists four sequence folders through the *unauthenticated* GitHub
API (60 requests/hour/IP) and then fetches each listed file from
raw.githubusercontent.com. Running the API budget out does not look like a network
error: the listings come back empty, nothing is surfaced, the explorer silently falls
back to another sequence, and the assertions fail as though sequence selection
regressed. So the suite serves both hosts itself.

Requests resolve in this order:

1. A committed snapshot named in fixtures/github/manifest.json -- the three *third-party*
   sources (pypulseq's examples folder, the MuT folder and the MRzero notebook). Refresh them with
   scripts/capture_e2e_source_fixtures.py.
2. A raw URL under mrx-org/anyfield -- served from the working tree.
3. A contents-API listing under mrx-org/anyfield -- synthesized from the real directory.
4. Nothing -> recorded and answered with an obviously-broken status. There is
   deliberately no fallthrough to the real network for these two hosts: a silent one is
   what made the failure mode above so hard to read.

Rules 2 and 3 exist instead of snapshots because those two sources are *this repo*.
Committing a second copy of pypulseq/anyseq/*.py would reproduce the drift trap the app
already has -- it runs GitHub's published copy, so a local edit to a sequence is
invisible to the running app -- and the tests would then be pinned to the stale copy
rather than to the code under review.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from playwright.sync_api import BrowserContext, Route

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures" / "github"
MANIFEST_PATH = FIXTURES_DIR / "manifest.json"

# pypulseq/sources.toml points its two folder sources at this repo on this branch.
OWN_REPO = "mrx-org/anyfield"
OWN_BRANCH = "main"
OWN_RAW_PREFIX = f"https://raw.githubusercontent.com/{OWN_REPO}/{OWN_BRANCH}/"
OWN_CONTENTS_PREFIX = f"https://api.github.com/repos/{OWN_REPO}/contents/"

ROUTE_PATTERNS = ("https://api.github.com/**", "https://raw.githubusercontent.com/**")

# The page is on 127.0.0.1, so a fulfilled cross-origin response still goes through the
# normal CORS check. Real GitHub sends this; without it every fetch fails.
CORS_HEADERS = {"access-control-allow-origin": "*"}

# raw.githubusercontent.com serves everything as text/plain, including .ipynb, and the
# app only ever calls .text() on it.
RAW_CONTENT_TYPE = "text/plain; charset=utf-8"
JSON_CONTENT_TYPE = "application/json; charset=utf-8"

# Not a real HTTP status. An unmatched URL must not be mistakable for anything the app
# knows how to handle or retry.
UNMATCHED_STATUS = 599


@dataclass
class GitHubStub:
    """What the stub did, for tests and for the boot fixture's unmatched-URL check."""

    served: list[str] = field(default_factory=list)
    unmatched: list[str] = field(default_factory=list)

    def unmatched_report(self) -> str:
        return "\n  ".join(self.unmatched)


def _listing_entry(path: Path, repo_relative: str) -> dict:
    """One entry of a contents-API response, with the fields the app reads.

    loadFolder() filters on `type` and `name`, fetches `download_url`, and records
    `path` and `html_url` as the sequence's origin. `size` is along for realism.
    """
    is_dir = path.is_dir()
    return {
        "name": path.name,
        "path": repo_relative,
        "type": "dir" if is_dir else "file",
        "size": 0 if is_dir else path.stat().st_size,
        "html_url": f"https://github.com/{OWN_REPO}/{'tree' if is_dir else 'blob'}/{OWN_BRANCH}/{repo_relative}",
        # Must round-trip back through the raw rule below.
        "download_url": None if is_dir else f"{OWN_RAW_PREFIX}{repo_relative}",
    }


def _repo_path(repo_relative: str) -> Path | None:
    """Resolve a repo-relative path, refusing anything that escapes the repo root.

    The path comes off a URL, so containment is checked after resolution rather than by
    trusting the string.
    """
    candidate = (REPO_ROOT / repo_relative).resolve()
    if candidate != REPO_ROOT and not candidate.is_relative_to(REPO_ROOT):
        return None
    return candidate


def install_github_stub(context: BrowserContext) -> GitHubStub:
    """Route api.github.com and raw.githubusercontent.com for the whole context."""
    stub = GitHubStub()
    manifest: dict[str, str] = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    def fulfill_snapshot(route: Route, url: str, rel_path: str) -> bool:
        path = FIXTURES_DIR / rel_path
        if not path.is_file():
            return False
        route.fulfill(
            status=200,
            headers={
                **CORS_HEADERS,
                "content-type": JSON_CONTENT_TYPE if rel_path.startswith("api/") else RAW_CONTENT_TYPE,
            },
            body=path.read_bytes(),
        )
        stub.served.append(url)
        return True

    def fulfill_working_tree_file(route: Route, url: str) -> bool:
        repo_relative = unquote(urlparse(url).path.split(f"/{OWN_REPO}/{OWN_BRANCH}/", 1)[-1])
        path = _repo_path(repo_relative)
        if path is None or not path.is_file():
            return False
        route.fulfill(
            status=200,
            headers={**CORS_HEADERS, "content-type": RAW_CONTENT_TYPE},
            body=path.read_bytes(),
        )
        stub.served.append(url)
        return True

    def fulfill_working_tree_listing(route: Route, url: str) -> bool:
        parsed = urlparse(url)
        # A ref other than main means sources.toml moved and the fixture story needs
        # revisiting, so let it fall through to the loud failure rather than pretending
        # the working tree is that ref.
        if parse_qs(parsed.query).get("ref", [OWN_BRANCH]) != [OWN_BRANCH]:
            return False
        repo_relative = unquote(parsed.path.split("/contents/", 1)[-1]).strip("/")
        directory = _repo_path(repo_relative)
        if directory is None or not directory.is_dir():
            return False
        # Real GitHub lists everything; the app is what filters to *.py.
        entries = [
            _listing_entry(child, f"{repo_relative}/{child.name}")
            for child in sorted(directory.iterdir())
        ]
        route.fulfill(
            status=200,
            headers={**CORS_HEADERS, "content-type": JSON_CONTENT_TYPE},
            body=json.dumps(entries).encode("utf-8"),
        )
        stub.served.append(url)
        return True

    def handler(route: Route) -> None:
        url = route.request.url
        rel_path = manifest.get(url)
        if rel_path is not None and fulfill_snapshot(route, url, rel_path):
            return
        if url.startswith(OWN_RAW_PREFIX) and fulfill_working_tree_file(route, url):
            return
        if url.startswith(OWN_CONTENTS_PREFIX) and fulfill_working_tree_listing(route, url):
            return
        stub.unmatched.append(url)
        route.fulfill(
            status=UNMATCHED_STATUS,
            headers={**CORS_HEADERS, "content-type": "text/plain; charset=utf-8"},
            body=(
                f"tests/e2e/github_stub.py has no fixture for {url}. The e2e suite must "
                f"not reach GitHub: add a snapshot with "
                f"scripts/capture_e2e_source_fixtures.py, or extend the stub."
            ),
        )

    for pattern in ROUTE_PATTERNS:
        context.route(pattern, handler)
    return stub
