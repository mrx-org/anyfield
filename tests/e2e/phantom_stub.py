"""Serve the default phantom archive from disk instead of the Modal cache admin.

`bootstrap()` starts a background `loadDefaultCachePhantom()` on every boot, which
downloads `DEFAULT_CACHE_PHANTOM_ID` as a 25 MB `.tar.gz` from the cache admin (see
`cacheDownloadUrl` / `downloadPhantomTarGz` in scan_zero/bifti_cache.js). A suite run boots
six times and asks for the archive six or seven times, so that was ~150 MB of live network
per run and the last thing that could fail a run for reasons unrelated to the code under
test -- as it did: both tests/e2e/test_scan.py tests timed out in
`wait_for_default_phantom()` with the app logging nothing about a phantom at all, taking
the suite from ~85s to 141s.

The archive is served byte-for-byte as downloaded, from a gitignored cache under
tests/e2e/.phantom-cache/. It has to be the real thing: tests/e2e/test_phantom_execute.py
asserts on the phantom's actual content (181x217x181, T1 spanning 0.37-4.16s, ADC peaking
at 3.19, a constant B1- of 1.0), so a synthesized or downsampled stand-in would only move
the failure. Note that the upstream `.tar.gz` is content-stable but *not* byte-stable --
see KNOWN_ARCHIVES.

## The one deliberate fallthrough: cache fill

github_stub.py refuses any fallthrough to the real network, and for good reason. This
module makes exactly one exception: on a *cache miss* it fetches the archive once, writes
it to the cache, and says so loudly. That is not the silent fallthrough github_stub.py
rejects -- it is bounded (once per machine, per phantom id), it announces itself, and the
run that triggers it is the only one that pays. The alternative was committing a 25 MB
binary, which is not an option, so this keeps `pytest tests/e2e/` runnable out of the box
on a fresh machine. Anything *other* than a phantom download on the cache-admin host gets
github_stub.py's treatment: recorded, answered with an obviously-broken status, and named
in the failure.

Populate the cache deliberately (and get the loud log on stdout rather than mid-test)
with:

    python scripts/fetch_e2e_phantom.py

## Making this fast found a real app bug

Serving the archive instantly did not just speed the suite up, it flipped an app-side race
and broke every boot: the phantom stopped reaching the Pyodide VFS at all (6/6 measured)
while the viewer still showed its three volumes, so `wait_for_default_phantom()` timed out
reporting "nothing about a phantom" -- the exact failure this stub was written to
eliminate. A response-delay sweep, one boot each, everything else identical:

    delay   /phantom      pyodide.asm.wasm fetches
      0s    ENOENT        3
      3s    7 entries     2   (nv.pyodide !== explorer.config.pyodide: the other ordering)
      6s    7 entries     1
     10s    7 entries     2

Three Pyodide runtimes in one boot. The cause was in the app, not here:
`loadPhantomFromCache` -> `_extractPhantomTarGz` -> `NiivueModule.initPyodide()`, whose
`if (!this.pyodide) this.pyodide = await loadPyodide()` built a *second, private* runtime
whenever it ran before app_bootstrap.js had assigned the shared one. `populatePyodideVFS`
then wrote `/phantom` into whichever runtime lost the race, and it was discarded.

Fixed in the app -- `NiivueModule` takes the page's `pyodidePromise` and awaits
it -- so this module no longer needs the response gate it briefly carried, and the archive
is served immediately. **The generalisable lesson: making something faster is a behaviour
change.** A test double that is quicker than production explores orderings production
never did, which is a feature, not a hazard; this one found a bug that had looked
like unreachable "dormant code".

## Who serves which Modal host

A plain boot makes exactly *one* request to either Modal host: this download. (Verified by
recording every request of a `?pro=1` boot: 1 x cache admin, 0 x sim gateway. The other
`/v1/` endpoints bifti_cache.js documents are only reached from UI the tests never open --
`GET {simGateway}/v1/cache` from the "Add BIfTI" dialog via `fetchCachedPhantomIds`, and
`GET {cacheAdmin}/v1/phantoms` from nothing at all in this app.) The scan tests add the
three job calls on the sim gateway, which sim_gateway_stub.py answers *per page*.

The two stubs cover disjoint hosts, so they never both match a URL, and neither needs to
run before the other. Should that ever change: Playwright checks handlers newest-first
(`_routes.insert(0, ...)`), and a `page.route()` is checked before any `context.route()`,
so sim_gateway_stub.py's per-page handler would win over this module's per-context one.
This module therefore never registers on the sim gateway host, and sim_gateway_stub.py
never registers on the cache admin -- keeping "who owns this host" a property of the code
rather than of fixture ordering.
"""
from __future__ import annotations

import gzip
import hashlib
import re
import sys
import urllib.error
import urllib.request
import warnings
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import BrowserContext, Route

CACHE_DIR = Path(__file__).resolve().parent / ".phantom-cache"

# scan_zero/bifti_cache.js: BIFTI_CACHE_ADMIN_DEFAULT and DEFAULT_CACHE_PHANTOM_ID.
CACHE_ADMIN_BASE = "https://mzaiss--bifti-cache-admin.modal.run"
DEFAULT_PHANTOM_ID = "brainweb-20-v2/subj04-3T-1mm-tra"

# Two patterns, one handler, so route precedence cannot decide the outcome:
#   1. any host's phantom download -- matched on shape, not on the default id, so a test
#      that loads a *different* phantom is served (or fails loudly) instead of silently
#      escaping to the network, and so a window.ANYFIELD_BIFTI_CACHE_ADMIN_URL override is
#      still covered;
#   2. everything else on the real cache admin -- nothing in the app asks for it today, and
#      if that changes the request must report rather than reach Modal.
DOWNLOAD_PATTERN = "**/v1/phantoms/*/*/download"
ROUTE_PATTERNS = (DOWNLOAD_PATTERN, f"{CACHE_ADMIN_BASE}/**")

# Playwright's glob matches the query string too, so DOWNLOAD_PATTERN alone would miss a
# `?...` suffix. `cacheDownloadUrl` never adds one; this is what recognizes the path once a
# pattern has matched, and it keeps the query out of the decision.
DOWNLOAD_PATH_RE = re.compile(r"^/v1/phantoms/([^/]+)/([^/]+)/download$")

# What the real server answers with (measured against the live URL):
#   content-type: application/gzip
#   content-disposition: attachment; filename="brainweb-20-v2-subj04-3T-1mm-tra.tar.gz"
#   content-length: 25363448
#   access-control-allow-origin: *
# The app only calls res.arrayBuffer(), so content-disposition is cosmetic, but serving a
# different content-type would hide a future app change that starts caring.
ARCHIVE_CONTENT_TYPE = "application/gzip"

# The page is on 127.0.0.1, so a fulfilled cross-origin response still faces the normal
# CORS check. Real GitHub-style ACAO; the live cache admin sends the same.
CORS_HEADERS = {"access-control-allow-origin": "*"}

# Not a real HTTP status, same contract as github_stub.py: an unserved URL must not be
# mistakable for something `downloadPhantomTarGz` knows how to handle. (It special-cases
# 404 with "add it via the cache admin", which would be exactly the wrong advice.)
UNMATCHED_STATUS = 599

# A gzip stream starts with these two bytes. The cheapest way to tell a real archive from
# an error page or an HTML captive-portal interception that arrived with status 200.
GZIP_MAGIC = b"\x1f\x8b"

# The live archive as of this writing: (compressed size, sha256 of the *decompressed* tar).
#
# The digest is of the inner tar, not of the .tar.gz, because the .tar.gz is not
# byte-stable. Two downloads a few minutes apart came back the same 25,363,448 bytes with
# different sha256s, differing in exactly four bytes -- the mtime in the gzip header
# (offset 4..7): the cache admin re-gzips per request. The 28,979,200-byte tar inside, and
# so every member the tests read, was identical. Content-identical is therefore the
# strongest guarantee available here, and it is the one that matters: what
# test_phantom_execute.py asserts on is the members.
#
# Not enforced -- the upstream phantom is allowed to change -- but a fresh download whose
# *content* differs is worth saying out loud, because those assertions are pinned to it.
KNOWN_ARCHIVES = {
    DEFAULT_PHANTOM_ID: (
        25_363_448,
        "0022f59f89a11158d4e0ddc48692a652f4f193db74ba933e73dc9b6fd002af1f",
    ),
}

# Anything smaller than this is a truncation or an error body, not a phantom: the real
# archive holds three multi-MB NIfTIs, the smallest of them 8.8 MB.
MIN_PLAUSIBLE_ARCHIVE_BYTES = 1_000_000

FETCH_TIMEOUT_S = 300
USER_AGENT = "anyfield-e2e-phantom-cache"


class PhantomCacheFillWarning(UserWarning):
    """Raised as a warning so the one-time network fetch survives pytest's capture.

    A banner on stderr is invisible under a passing `pytest -q` (output is captured and
    only shown for failures); the warnings summary is not.
    """


@dataclass
class CachedArchive:
    """A verified cache entry, plus whether producing it needed the network."""

    phantom_id: str
    path: Path
    data: bytes
    sha256: str
    filled_from_network: bool = False

    @property
    def size(self) -> int:
        return len(self.data)


@dataclass
class PhantomStub:
    """What the stub did, for tests and for the boot fixture's unmatched-URL check."""

    served: list[str] = field(default_factory=list)
    unmatched: list[str] = field(default_factory=list)
    # Phantom ids that needed the one-time network fetch during this session. Empty on a
    # warm cache, which is what "the suite is hermetic now" means in practice.
    cache_fills: list[str] = field(default_factory=list)

    def unmatched_report(self) -> str:
        return "\n  ".join(self.unmatched)


def download_url(phantom_id: str) -> str:
    """The URL `cacheDownloadUrl(phantom_id)` builds, for the two-segment folder id.

    Always the canonical cache admin, even when the intercepted request came from a
    `window.ANYFIELD_BIFTI_CACHE_ADMIN_URL` override: an override points at a local or
    staging admin that a cache fill has no business reaching, and the id is the only part
    of the request that identifies *which* phantom. Cache entries are keyed by id alone for
    the same reason.
    """
    collection, name = _split_phantom_id(phantom_id)
    return f"{CACHE_ADMIN_BASE}/v1/phantoms/{collection}/{name}/download"


def cache_path(phantom_id: str) -> Path:
    """Cache file for a phantom id, with `collection/name` flattened into one filename."""
    collection, name = _split_phantom_id(phantom_id)
    return CACHE_DIR / f"{_safe(collection)}__{_safe(name)}.tar.gz"


def ensure_cached(phantom_id: str, *, announce: bool = True) -> CachedArchive:
    """Return the archive bytes for `phantom_id`, downloading once if the cache is cold.

    Idempotent: a warm, verified cache entry costs one read and one sha256 (~40ms for
    25 MB) and touches no network. Safe to call from the route handler and from
    scripts/fetch_e2e_phantom.py alike.
    """
    path = cache_path(phantom_id)
    cached = _read_verified(path, phantom_id)
    if cached is not None:
        return cached

    url = download_url(phantom_id)
    data = _fetch(url)
    _check_payload(phantom_id, url, data)
    digest = hashlib.sha256(data).hexdigest()
    _write_cache_entry(path, data, digest)
    archive = CachedArchive(phantom_id, path, data, digest, filled_from_network=True)
    if announce:
        _announce_cache_fill(archive, url)
    return archive


def install_phantom_stub(context: BrowserContext) -> PhantomStub:
    """Route the cache admin for the whole context, serving downloads from disk."""
    stub = PhantomStub()

    def handler(route: Route) -> None:
        url = route.request.url
        match = DOWNLOAD_PATH_RE.match(urlparse(url).path)
        if match is None:
            _fulfill_unmatched(
                route,
                stub,
                url,
                "not a phantom download URL. Nothing in the app requests anything else on "
                "the cache admin; if that changed, extend the stub.",
            )
            return

        phantom_id = f"{match.group(1)}/{match.group(2)}"
        try:
            archive = ensure_cached(phantom_id)
        except Exception as exc:  # noqa: BLE001 -- report any failure as this URL's
            _fulfill_unmatched(
                route,
                stub,
                url,
                f"could not serve phantom {phantom_id!r} from "
                f"{CACHE_DIR.name}/: {type(exc).__name__}: {exc}",
            )
            return

        if archive.filled_from_network:
            stub.cache_fills.append(phantom_id)
        route.fulfill(
            status=200,
            headers={
                **CORS_HEADERS,
                "content-type": ARCHIVE_CONTENT_TYPE,
                # The live server names the attachment `{collection}-{name}.tar.gz`.
                "content-disposition": (
                    f'attachment; filename="{match.group(1)}-{match.group(2)}.tar.gz"'
                ),
            },
            # Playwright derives content-length from the body, so res.arrayBuffer() gets
            # all of it; setting the header by hand here would only risk disagreeing.
            body=archive.data,
        )
        stub.served.append(url)

    for pattern in ROUTE_PATTERNS:
        context.route(pattern, handler)
    return stub


def _fulfill_unmatched(route: Route, stub: PhantomStub, url: str, why: str) -> None:
    stub.unmatched.append(f"{url}\n    {why}")
    route.fulfill(
        status=UNMATCHED_STATUS,
        headers={**CORS_HEADERS, "content-type": "text/plain; charset=utf-8"},
        body=f"tests/e2e/phantom_stub.py did not serve {url}: {why}",
    )


def _split_phantom_id(phantom_id: str) -> tuple[str, str]:
    """`collection/name` from a cache id, dropping any third config segment.

    `splitCacheId` allows `collection/name/config`, but the *download* is folder-based, so
    the cache is keyed by the folder -- one archive serves every config in it.
    """
    parts = [p for p in str(phantom_id or "").strip().split("/") if p]
    if len(parts) < 2:
        raise ValueError(
            f"phantom id {phantom_id!r} is not collection/name[/config]"
        )
    return parts[0], parts[1]


def _safe(segment: str) -> str:
    """Flatten one id segment into a filename. Ids come off a URL, so nothing else may."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "_", segment).lstrip(".")
    if not cleaned:
        raise ValueError(f"phantom id segment {segment!r} has no usable characters")
    return cleaned


def _digest_path(path: Path) -> Path:
    return path.with_suffix(path.suffix + ".sha256")


def _read_verified(path: Path, phantom_id: str) -> CachedArchive | None:
    """A cache entry, or None if it is absent, unverifiable or corrupt.

    A corrupt entry is treated as a miss rather than as an error: re-fetching self-heals,
    the fetch path verifies what it writes, and the loud log says it happened. What must
    never happen is a half-written archive quietly feeding a run -- an interrupted download
    cannot produce one (see `_write_cache_entry`), but a full disk or a stray `cp` can.
    """
    if not path.is_file():
        return None
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    recorded = _read_recorded_digest(_digest_path(path))
    if recorded is None:
        _warn(
            f"{path.name} has no {_digest_path(path).name} beside it, so its integrity "
            f"cannot be checked; re-fetching."
        )
        return None
    if recorded != digest:
        _warn(
            f"{path.name} is {len(data):,} B with sha256 {digest[:12]}..., but "
            f"{_digest_path(path).name} records {recorded[:12]}...; the cached archive is "
            f"corrupt or was replaced. Re-fetching."
        )
        return None
    return CachedArchive(phantom_id, path, data, digest)


def _read_recorded_digest(digest_path: Path) -> str | None:
    """The hash out of a `sha256sum`-format sidecar (`<hex>  <filename>`)."""
    if not digest_path.is_file():
        return None
    first = digest_path.read_text(encoding="utf-8").split()
    if not first or not re.fullmatch(r"[0-9a-f]{64}", first[0]):
        return None
    return first[0]


def _fetch(url: str) -> bytes:
    """Download the archive, or raise saying what to do about it.

    Worth knowing before trusting a failure here: the cache admin has been seen to fail transiently.
    Answering 404 to the same URL that had just served 25 MB has been observed minutes
    apart, which is precisely why a run should never depend on this function.
    """
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT_S) as response:
            declared = response.headers.get("content-length")
            data = response.read()
    except (urllib.error.URLError, OSError) as exc:
        raise RuntimeError(
            f"the phantom cache has no usable entry and {url} could not be fetched "
            f"({exc}). A 404 means either that the phantom is genuinely not on the cache "
            f"or a transient cache-admin error, in which case "
            f"retrying is enough. Otherwise populate the cache on a machine that can reach "
            f"it (python scripts/fetch_e2e_phantom.py) and copy {CACHE_DIR.name}/ over."
        ) from exc
    # urllib does not check this itself: a connection dropped mid-body returns short.
    if declared is not None and int(declared) != len(data):
        raise RuntimeError(
            f"{url} announced {int(declared):,} bytes but delivered {len(data):,}; "
            f"the download was truncated, so nothing was cached."
        )
    return data


def _check_payload(phantom_id: str, url: str, data: bytes) -> None:
    if data[:2] != GZIP_MAGIC:
        raise RuntimeError(
            f"{url} returned {len(data):,} bytes that are not gzip (first bytes "
            f"{data[:8]!r}); refusing to cache them."
        )
    if len(data) < MIN_PLAUSIBLE_ARCHIVE_BYTES:
        raise RuntimeError(
            f"{url} returned only {len(data):,} bytes, well under the "
            f"{MIN_PLAUSIBLE_ARCHIVE_BYTES:,} a real phantom archive needs."
        )
    known = KNOWN_ARCHIVES.get(phantom_id)
    if known is None:
        return
    expected_size, expected_tar_sha = known
    try:
        actual_tar_sha = hashlib.sha256(gzip.decompress(data)).hexdigest()
    except (OSError, EOFError, zlib.error) as exc:
        raise RuntimeError(
            f"{url} returned {len(data):,} bytes that start like gzip but do not "
            f"decompress ({exc}); refusing to cache them."
        ) from exc
    if (len(data), actual_tar_sha) != (expected_size, expected_tar_sha):
        _warn(
            f"the upstream archive for {phantom_id} has changed: expected {expected_size:,} "
            f"compressed bytes wrapping tar {expected_tar_sha[:12]}..., got {len(data):,} "
            f"wrapping {actual_tar_sha[:12]}.... Serving what the server sent. If the "
            f"phantom's content moved, tests/e2e/test_phantom_execute.py's PHANTOM_DIMS, "
            f"T1_RANGE_S and ADC_MAX are pinned to the old one -- check them, then update "
            f"KNOWN_ARCHIVES in tests/e2e/phantom_stub.py."
        )


def _write_cache_entry(path: Path, data: bytes, digest: str) -> None:
    """Write archive + sidecar, atomically, so an interrupted write is never a cache hit."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.write_bytes(data)
    tmp.replace(path)
    _digest_path(path).write_text(f"{digest}  {path.name}\n", encoding="utf-8")


def _announce_cache_fill(archive: CachedArchive, url: str) -> None:
    banner = (
        "=" * 78 + "\n"
        "tests/e2e/phantom_stub.py: ONE-TIME NETWORK FETCH of the default phantom\n"
        f"  cache miss for {archive.phantom_id}\n"
        f"  downloaded {archive.size:,} bytes (sha256 {archive.sha256[:16]}...) from\n"
        f"    {url}\n"
        f"  into {_repo_relative(archive.path)}\n"
        "  Every later run serves it from that file and touches NO network. To do this\n"
        "  deliberately instead of mid-test: python scripts/fetch_e2e_phantom.py\n"
        + "=" * 78
    )
    print(f"\n{banner}", file=sys.stderr, flush=True)
    warnings.warn(banner, PhantomCacheFillWarning, stacklevel=2)


def _warn(message: str) -> None:
    print(f"\ntests/e2e/phantom_stub.py: {message}", file=sys.stderr, flush=True)
    warnings.warn(message, PhantomCacheFillWarning, stacklevel=3)


def _repo_relative(path: Path) -> str:
    root = Path(__file__).resolve().parents[2]
    return str(path.relative_to(root)) if path.is_relative_to(root) else str(path)
