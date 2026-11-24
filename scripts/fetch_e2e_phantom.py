#!/usr/bin/env python3
"""Populate the local phantom cache that tests/e2e/ serves instead of the Modal cache admin.

Every boot of index.html downloads `DEFAULT_CACHE_PHANTOM_ID` as a 25 MB `.tar.gz` from
the cache admin, and a suite run boots three or four times. tests/e2e/phantom_stub.py
answers that request from tests/e2e/.phantom-cache/ instead, which is what makes the e2e
suite hermetic and drops a run from ~140s (when the download misbehaves) to ~75s.

The cache is gitignored: the archive's four members are already individually gzipped, so
there is nothing to shrink, and a 25 MB binary does not belong in the history. This script
is how you fill it deliberately -- after a fresh setup, alongside
`bash scripts/setup_e2e_deps.sh`:

    python scripts/fetch_e2e_phantom.py

It is idempotent and prints what it did: a warm, hash-verified cache costs no network. The
stub can also fill the cache itself on a miss mid-run (it says so loudly), so running this
is an optimization, not a prerequisite.

`--check` verifies without ever downloading, for a machine that should already be warm.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
# tests/e2e/ is not a package (pytest puts it on sys.path itself), so import it by path.
sys.path.insert(0, str(REPO_ROOT / "tests" / "e2e"))

from phantom_stub import (  # noqa: E402 -- needs the sys.path line above
    CACHE_DIR,
    DEFAULT_PHANTOM_ID,
    cache_path,
    download_url,
    ensure_cached,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "phantom_ids",
        nargs="*",
        default=[DEFAULT_PHANTOM_ID],
        metavar="COLLECTION/NAME",
        help=f"phantom ids to cache (default: {DEFAULT_PHANTOM_ID})",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="report cache state and exit non-zero if cold; never downloads",
    )
    args = parser.parse_args(argv)

    print(f"Phantom cache: {CACHE_DIR.relative_to(REPO_ROOT)}/")
    cold = 0
    for phantom_id in args.phantom_ids or [DEFAULT_PHANTOM_ID]:
        path = cache_path(phantom_id)
        if args.check:
            state = f"{path.stat().st_size:,} B" if path.is_file() else "MISSING"
            print(f"  {phantom_id}  ->  {path.name}  ({state})")
            cold += not path.is_file()
            continue
        # announce=False: the stub's banner exists to be impossible to miss inside a test
        # run. Here the download *is* the point, so a plain line is enough.
        archive = ensure_cached(phantom_id, announce=False)
        verb = "downloaded" if archive.filled_from_network else "already cached"
        print(f"  {archive.size:>12,} B  {path.name}  ({verb})")
        print(f"                 sha256 {archive.sha256}")
        if archive.filled_from_network:
            print(f"                 <- {download_url(phantom_id)}")

    if args.check and cold:
        print(
            f"\n{cold} phantom(s) not cached. Run this script without --check.",
            file=sys.stderr,
        )
        return 1
    print("\nThe e2e suite will now serve the phantom from disk and touch no network.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
