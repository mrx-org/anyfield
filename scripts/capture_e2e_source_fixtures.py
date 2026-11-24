#!/usr/bin/env python3
"""Capture the third-party GitHub responses that tests/e2e/ serves instead of the network.

The e2e suite must not touch the GitHub API. Unauthenticated callers get 60
requests/hour/IP, and running out is silent rather than loud: the folder listings come
back empty, the explorer falls back to a different sequence, and the assertions fail as
though sequence selection regressed. tests/e2e/github_stub.py therefore answers every
api.github.com / raw.githubusercontent.com request from one of two places:

  * the working tree, for the two mrx-org/anyfield folder sources (this repo's own
    sequences -- a committed copy would drift from the code under test);
  * the snapshots this script writes, for the three third-party sources.

Run it to refresh those snapshots. It is idempotent and costs one GitHub API call per
folder listing:

    python scripts/capture_e2e_source_fixtures.py
"""
from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURES_DIR = REPO_ROOT / "tests" / "e2e" / "fixtures" / "github"
MANIFEST_PATH = FIXTURES_DIR / "manifest.json"

# The three third-party sources from pypulseq/sources.toml. The mrx-org/anyfield folder
# sources are deliberately absent: the stub serves those from disk.
# Folder listings, exactly as SequenceExplorer.loadFolder() builds them from the TOML path.
FOLDER_LISTING_APIS = (
    # pypulseq_examples
    "https://api.github.com/repos/imr-framework/pypulseq/contents/examples/scripts?ref=master",
    # Educational (https://github.com/magdamd/MuT)
    "https://api.github.com/repos/magdamd/MuT/contents",
)
MRZERO_NOTEBOOK_URL = (
    "https://raw.githubusercontent.com/MRsources/MRzero-Core/refs/heads/main/"
    "documentation/playground_mr0/mr0_EPI_2D_seq.ipynb"
)

# Everything else is raw.githubusercontent.com, which isn't rate limited.
GITHUB_API_CALLS = len(FOLDER_LISTING_APIS)

# Guards the output-stripping below against a silently restructured notebook.
MRZERO_CODE_CELLS = 6

USER_AGENT = "anyfield-e2e-fixture-capture"


def _fetch(url: str) -> bytes:
    """GET `url`, following redirects.

    Following them is not optional: imr-framework/pypulseq has moved to
    pulseq/pypulseq, so the contents API answers 301 with a
    {"message": "Moved Permanently"} body. Browsers' fetch() follows redirects by
    default, which is why the app never notices; a hand-rolled client that doesn't --
    `curl` without -L, or an opener built without HTTPRedirectHandler -- captures that
    error body as though it were the listing.
    """
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def _api_budget() -> tuple[int, int] | None:
    """(remaining, seconds_until_reset), or None if /rate_limit can't be reached.

    /rate_limit is itself free, so asking costs nothing.
    """
    try:
        with urllib.request.urlopen("https://api.github.com/rate_limit", timeout=15) as response:
            core = json.load(response)["resources"]["core"]
    except (urllib.error.URLError, OSError, KeyError, ValueError):
        return None
    return core["remaining"], max(0, int(core["reset"] - time.time()))


def _api_fixture_rel(url: str) -> str:
    parsed = urlparse(url)
    slug = parsed.path.strip("/").replace("/", "_")
    if parsed.query:
        slug += "_" + parsed.query.replace("=", "-").replace("&", "_")
    return f"api/{slug}.json"


def _raw_fixture_rel(url: str) -> str:
    """Mirror the URL path under raw/, so the fixture tree stays greppable by hand."""
    return "raw" + urlparse(url).path


def _strip_notebook_outputs(raw: bytes) -> bytes:
    """Drop cell outputs and execution counts from a notebook.

    The published MRzero notebook is ~937 KB, nearly all of it base64-encoded output
    images. The app's convert_notebook_to_python() only ever joins the `source` of code
    cells, so an output-stripped copy is behaviourally identical at ~14 KB -- a far
    better thing to commit, review and diff than a megabyte of PNGs.
    """
    notebook = json.loads(raw)
    code_cells = 0
    for cell in notebook.get("cells", []):
        if cell.get("cell_type") != "code":
            continue
        code_cells += 1
        cell["outputs"] = []
        cell["execution_count"] = None
    if code_cells != MRZERO_CODE_CELLS:
        raise SystemExit(
            f"expected {MRZERO_CODE_CELLS} code cells in the MRzero notebook, found "
            f"{code_cells}; the upstream notebook was restructured, so check that "
            f"tests/e2e still assert the right thing before updating the constant"
        )
    return json.dumps(notebook, indent=1).encode() + b"\n"


def _write(rel_path: str, body: bytes, url: str) -> tuple[str, str, int]:
    path = FIXTURES_DIR / rel_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    print(f"  {len(body):>8,} B  {rel_path}\n            <- {url}")
    return url, rel_path, len(body)


def main() -> int:
    budget = _api_budget()
    if budget is not None:
        remaining, reset_in = budget
        if remaining < GITHUB_API_CALLS:
            print(
                f"GitHub API budget exhausted: {remaining} left, need {GITHUB_API_CALLS}. "
                f"Resets in ~{reset_in // 60 + 1} min.",
                file=sys.stderr,
            )
            return 1
        print(f"GitHub API budget: {remaining} remaining, spending {GITHUB_API_CALLS}.")

    print(f"Writing fixtures under {FIXTURES_DIR.relative_to(REPO_ROOT)}/")
    written: list[tuple[str, str, int]] = []

    for listing_api in FOLDER_LISTING_APIS:
        listing_body = _fetch(listing_api)
        listing = json.loads(listing_body)
        if not isinstance(listing, list):
            raise SystemExit(
                f"expected a contents listing array from {listing_api}, got {listing!r} -- "
                f"a repository redirect was not followed"
            )
        written.append(_write(_api_fixture_rel(listing_api), listing_body, listing_api))

        # The listing is served verbatim, so its download_url values are exactly the URLs
        # the app will ask for next -- which makes them the manifest keys.
        for entry in listing:
            download_url = entry.get("download_url")
            if not download_url:
                continue
            written.append(_write(_raw_fixture_rel(download_url), _fetch(download_url), download_url))

    notebook = _strip_notebook_outputs(_fetch(MRZERO_NOTEBOOK_URL))
    written.append(_write(_raw_fixture_rel(MRZERO_NOTEBOOK_URL), notebook, MRZERO_NOTEBOOK_URL))

    manifest = {url: rel_path for url, rel_path, _ in sorted(written)}
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"  {MANIFEST_PATH.stat().st_size:>8,} B  {MANIFEST_PATH.name}  ({len(manifest)} URLs)")

    total = sum(size for _, _, size in written)
    print(f"\n{len(written)} fixtures, {total:,} B total.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
