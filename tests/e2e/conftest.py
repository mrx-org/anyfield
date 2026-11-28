"""Playwright e2e smoke tests for the static anyfield app.

Serves the repo root as a plain static site (it has no build step) and points
Playwright at it. See scripts/setup_e2e_deps.sh and tests/e2e/README.md for why
LD_LIBRARY_PATH and the FONTCONFIG_* vars are patched below (machines without
root/apt can't run the normal `playwright install-deps`).
"""
from __future__ import annotations

import functools
import http.server
import os
import socket
import threading
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from playwright.sync_api import BrowserContext, ConsoleMessage, Page
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from app_seam import EXPLORER_JS, NV_JS
from github_stub import GitHubStub, install_github_stub
from phantom_stub import PhantomStub, install_phantom_stub

# The captured third-party sources are real Python scripts, and one of them
# (pns_test.py) matches pytest's default *_test.py pattern, so collection would try to
# import it as a test module.
collect_ignore = ["fixtures"]

REPO_ROOT = Path(__file__).resolve().parents[2]
LOCAL_PREFIX = REPO_ROOT / ".pw-system-libs"
LOCAL_SYSTEM_LIBS = LOCAL_PREFIX / "usr" / "lib" / "x86_64-linux-gnu"
LOCAL_FONTS_CONF = LOCAL_PREFIX / "etc" / "fonts"

if LOCAL_SYSTEM_LIBS.is_dir():
    existing = os.environ.get("LD_LIBRARY_PATH", "")
    if str(LOCAL_SYSTEM_LIBS) not in existing:
        os.environ["LD_LIBRARY_PATH"] = (
            f"{LOCAL_SYSTEM_LIBS}:{existing}" if existing else str(LOCAL_SYSTEM_LIBS)
        )

if LOCAL_FONTS_CONF.is_dir():
    # fontconfig's compiled-in paths point at /etc/fonts and /usr/share/fonts, which
    # don't exist on such machines -- everything lives under .pw-system-libs instead.
    # Without this Chromium finds zero fonts and Skia's fallback font manager aborts
    # the whole browser on the first text paint:
    #   [FATAL:.../SkFontMgr_FontConfigInterface.cpp] Not implemented.
    # FONTCONFIG_SYSROOT relocates every path fontconfig knows about (config, font
    # dirs and the prebuilt cache in .pw-system-libs/var/cache/fontconfig) under that
    # prefix, so FONTCONFIG_PATH stays the *sysroot-relative* /etc/fonts.
    os.environ.setdefault("FONTCONFIG_SYSROOT", str(LOCAL_PREFIX))
    os.environ.setdefault("FONTCONFIG_PATH", "/etc/fonts")

# Booting means: Pyodide + micropip installs from the real network, plus the sequence
# sources from tests/e2e/github_stub.py. ~10-30s depending on CDN latency, so every wait
# here is generous.
BOOT_TIMEOUT_MS = 180_000

# The default phantom's ~25MB .tar.gz no longer comes from the network: tests/e2e/phantom_stub.py
# serves it from tests/e2e/.phantom-cache/. So this is not a download budget any more. What
# remains is the app's own work -- unpacking the archive in the page and adding the three
# NIfTIs to the viewer. The worker /phantom VFS is not part of it: the app writes the archive
# there only when Execute / JSON Save first needs it.
#
# Measured over 5 instrumented suite runs (30 boots), the phantom was ready 0.0-1.0s after
# `wait_ready` returned, every time. 60s is therefore a huge margin, kept so on purpose: it is
# also the budget within which a *failed* load reports instead of stalling the suite, and it
# stays well under BOOT_TIMEOUT_MS so it is the phantom that gets named, not the boot.
PHANTOM_TIMEOUT_MS = 60_000

# The app is ready once the explorer has auto-selected a sequence *and* rendered its
# parameter table -- the last step of bootstrap()'s slow path.
APP_READY_JS = f"""
!!({EXPLORER_JS} && {EXPLORER_JS}.selectedSequence)
&& document.querySelectorAll('#seq-params-controls .params-table-row').length > 0
"""

# bootstrap()'s background loadDefaultCachePhantom() -- DEFAULT_CACHE_PHANTOM_ID in
# scan_zero/bifti_cache.js -- and the only JSON config a default boot has to offer.
DEFAULT_PHANTOM_JSON = "subj04-3T-1mm-tra.json"
DEFAULT_PHANTOM_NIFTIS = ("subj04.nii.gz", "subj04_dB0.nii.gz", "subj04_B1+.nii.gz")

# That load is its own promise chain in bootstrap(), and APP_READY_JS can be true before it
# lands. Anything using the phantom must wait for the whole set -- the JSON
# in the editor and the group in the viewer. The worker /phantom VFS is deliberately not
# checked: it stays empty until Execute / JSON Save needs it (NiivueModule._phantomVfsWorker).
PHANTOM_READY_JS = f"""
() => {{
  const nv = {NV_JS};
  if (!nv?.jsonTabCurrentName) return false;
  return nv.volumeGroups.some(g => g.jsonFileName === nv.jsonTabCurrentName && g.volumes.length > 0)
    && String(nv.getJsonEditorValue() || '').trim().length > 0;
}}
"""

BENIGN_CONSOLE_ERRORS = (
    # mrseq is listed in pypulseq/sources.toml but ships no importable package
    # directory, so every boot logs this.
    "mrseq.sequences",
)


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):  # noqa: A002 -- silence per-request access log
        pass


@pytest.fixture(scope="session")
def base_url() -> str:
    """Serves the repo root as a static site for the lifetime of the test session."""
    port = _free_port()
    handler = functools.partial(_QuietHandler, directory=str(REPO_ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.shutdown()
        thread.join(timeout=5)


@pytest.fixture(scope="session")
def browser_context_args(browser_context_args):
    # Large-ish viewport: several panels (tree/params/plot/scan) render side by side.
    return {**browser_context_args, "viewport": {"width": 1600, "height": 1000}}


@dataclass
class BootedApp:
    """A page with index.html fully booted, plus everything it logged on the way."""

    page: Page
    console: list[ConsoleMessage] = field(default_factory=list)
    page_errors: list[str] = field(default_factory=list)

    def wait_ready(self) -> None:
        """Block until a (re)selected sequence has its parameter table rendered."""
        self.page.wait_for_function(APP_READY_JS, timeout=BOOT_TIMEOUT_MS)

    def wait_for_default_phantom(self) -> None:
        """Block until bootstrap()'s background default-phantom load has fully landed.

        Not implied by `wait_ready`, and skipping it is a flake, not a slow test -- see
        PHANTOM_READY_JS. In practice the wait is now instant (0.0-1.0s, measured), because
        the archive comes off local disk.

        The load can still fail outright: loudly (a console error mentioning phantom)
        or silently. Either way the phantom simply never arrives here.
        Waiting the full boot timeout for that would cost three minutes and report
        nothing, so this gets its own shorter budget and quotes what the app logged
        -- deliberately no retry, because a test that hides the race is worth less
        than one that names it. "(nothing about a phantom)" below is the silent
        shape. BENIGN_CONSOLE_ERRORS no longer allow-lists a phantom ErrnoError
        (4aba250); a fresh occurrence is a real failure.
        """
        try:
            self.page.wait_for_function(PHANTOM_READY_JS, timeout=PHANTOM_TIMEOUT_MS)
        except PlaywrightTimeoutError:
            reported = [
                m.text for m in self.console if "phantom" in m.text.lower() and m.type != "log"
            ]
            raise AssertionError(
                "bootstrap()'s default phantom never landed in the viewer within "
                f"{PHANTOM_TIMEOUT_MS / 1000:.0f}s. The app logged:\n  "
                + ("\n  ".join(reported) or "(nothing about a phantom)")
                + "\nThis is the known intermittent failure of loadDefaultCachePhantom(), "
                "not a regression in the test."
            ) from None

    def instance_id(self) -> str:
        """NiivueModule.instanceId, which suffixes every id in its controls markup."""
        return self.page.evaluate(f"() => {NV_JS}.instanceId")

    def logs(self, prefix: str) -> list[str]:
        return [m.text for m in self.console if m.text.startswith(prefix)]

    def severe_console_errors(self) -> list[str]:
        return [
            m.text
            for m in self.console
            if m.type == "error"
            and not any(benign in m.text for benign in BENIGN_CONSOLE_ERRORS)
        ]


@pytest.fixture(scope="session")
def app_context(browser, browser_context_args) -> BrowserContext:
    context = browser.new_context(**browser_context_args)
    try:
        yield context
    finally:
        context.close()


@pytest.fixture(scope="session")
def github_stub(app_context) -> GitHubStub:
    """Serve every GitHub request from the working tree or a committed snapshot.

    Owning the installation here rather than inside `app_context` is what lets tests
    (and `boot_app`'s unmatched-URL check) see what was actually requested. `boot_app`
    depends on it, so it is always in place before the context has any pages.
    """
    return install_github_stub(app_context)


@pytest.fixture(scope="session")
def phantom_stub(app_context) -> PhantomStub:
    """Serve bootstrap()'s 25MB default-phantom download from tests/e2e/.phantom-cache/.

    Installed here, and depended on by `boot_app`, for the same reason as `github_stub`:
    the route has to exist before the context has any pages, since the very first boot
    starts the download. See tests/e2e/phantom_stub.py for the one deliberate exception to
    the no-network rule (a loud, one-time cache fill).
    """
    return install_phantom_stub(app_context)


@pytest.fixture(scope="session")
def boot_app(app_context, base_url, github_stub, phantom_stub):
    """Factory: boot index.html at `query` and wait for the app to be ready.

    Each call costs a full boot, so tests that only read state should share
    `default_app`; take your own page only when you need a different URL or when
    you're going to mutate app state.

    Any URL carrying shared state (?s_category=... or a capsule) makes bootstrap()
    put up a modal asking whether to open the link, and it blocks source loading
    until answered -- pass `shared_link="Load shared"` (or "Load default") for those.
    """
    booted: list[BootedApp] = []

    def _boot(query: str = "", shared_link: str | None = None) -> BootedApp:
        page = app_context.new_page()
        app = BootedApp(page=page)
        # Lambdas, not bound builtins: Playwright tags handlers with an attribute.
        page.on("console", lambda m: app.console.append(m))
        page.on("pageerror", lambda e: app.page_errors.append(str(e)))
        page.goto(f"{base_url}/index.html{query}", timeout=BOOT_TIMEOUT_MS)
        if shared_link is not None:
            page.get_by_role("button", name=shared_link, exact=True).click(
                timeout=BOOT_TIMEOUT_MS
            )
        try:
            app.wait_ready()
        finally:
            # An unserved GitHub URL otherwise shows up as a missing source or a boot
            # timeout, which says nothing about the cause -- so name it, in the failure
            # path too.
            if github_stub.unmatched:
                raise AssertionError(
                    "the GitHub stub had no fixture for:\n  "
                    f"{github_stub.unmatched_report()}\n"
                    "Refresh the snapshots with scripts/capture_e2e_source_fixtures.py, "
                    "or extend tests/e2e/github_stub.py."
                )
            # Likewise for the cache admin: unserved there means no phantom, which
            # otherwise only surfaces as wait_for_default_phantom() timing out.
            if phantom_stub.unmatched:
                raise AssertionError(
                    "the phantom stub did not serve:\n  "
                    f"{phantom_stub.unmatched_report()}\n"
                    "Fill the cache with scripts/fetch_e2e_phantom.py, or extend "
                    "tests/e2e/phantom_stub.py."
                )
        booted.append(app)
        return app

    try:
        yield _boot
    finally:
        for app in booted:
            app.page.close()


@pytest.fixture(scope="session")
def default_app(boot_app) -> BootedApp:
    """One shared boot of the app with no URL parameters. Treat as read-only."""
    return boot_app("")
