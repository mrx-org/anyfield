# End-to-end browser tests

These drive the real app — `index.html` served as a static site — in headless
Chromium via Playwright, including its real network fetch of Pyodide. They are
the only tests that prove the page actually boots.

## Setup (once per machine)

```bash
source .venv/bin/activate
bash scripts/setup_e2e_deps.sh
python scripts/fetch_e2e_phantom.py     # optional; the suite does it itself if you don't
```

That installs Playwright's Chromium binary and, when the machine has no
root/sudo, works around the missing system libraries (see below). The second
command pre-fills the local phantom cache the suite serves instead of the Modal
cache admin — optional because the stub fills it on the first miss, but doing it
deliberately keeps the one network fetch out of the middle of a test run.

## Running

```bash
source .venv/bin/activate
pytest tests/e2e/            # ~85s, 7 tests, all passing
```

A bare `pytest` runs only `tests/python/`: `testpaths` in `pyproject.toml`
excludes this directory, so nobody pays the browser cost by accident. Tests here
are also tagged with the `e2e` marker, which is what you want when pointing
pytest at a wider path: `pytest tests/ -m e2e` runs just these,
`pytest tests/ -m "not e2e"` runs everything else.

Three modules:

- `test_smoke.py` — does the page boot, list its sources, and honour a deep link.
- `test_phantom_execute.py` — the phantom Execute button, i.e. `handleJsonExecute`
  plus `_writePhantomJsonToVfs` and `_executePhantomToVolumeData`.
- `test_scan.py` — a whole HTTP scan with the remote simulation stubbed, i.e.
  `_httpPrepareAndSubmit` → `_httpPollOnce` → `_httpFinishJob` and the three
  compute steps it drives.

## Why `.pw-system-libs/` and the fontconfig setup exist

`playwright install-deps` needs root. On a machine with neither root nor a
working system `apt-get update` target, `scripts/setup_e2e_deps.sh`
apt-*downloads* the `.deb`s Chromium needs and `dpkg-deb -x` extracts them into
a repo-local, gitignored prefix at `.pw-system-libs/`. `tests/e2e/conftest.py`
then prepends that prefix's `usr/lib/x86_64-linux-gnu` to `LD_LIBRARY_PATH`.

Shared libraries alone aren't enough. fontconfig has its font paths compiled in
(`/etc/fonts`, `/usr/share/fonts`, `/var/cache/fontconfig`), none of which exist
here — everything is under the prefix. With zero fonts found, Chromium doesn't
degrade gracefully; Skia's fallback font manager aborts the browser process the
moment the app paints its first text:

```
[FATAL:third_party/skia/src/ports/SkFontMgr_FontConfigInterface.cpp:163] Not implemented.
```

`conftest.py` fixes this by setting `FONTCONFIG_SYSROOT` to the prefix, which
relocates *all* of those paths under it at once, plus `FONTCONFIG_PATH=/etc/fonts`
(sysroot-relative). The setup script warms `fc-cache` inside the prefix so
Chromium doesn't rescan every font on each launch. Both are no-ops on a normal
machine with system fonts: the env vars are only set when `.pw-system-libs/etc/fonts`
exists.

`test_app_boots_and_renders_default_params` asserts rendered text has non-zero
width, so a regression here fails loudly instead of silently rendering blanks.

## Timeouts are deliberately generous

A boot is Pyodide + micropip installs + loading four sequence sources (locally,
see above). That is typically ~10s and can be several times that (a run of
the whole suite is ~30s), so
`BOOT_TIMEOUT_MS` is 180s and UI assertions use 60s rather than Playwright's
5s default. Don't tighten these without measuring; the failure mode is a flaky
suite, not a fast one.

To keep that cost down, `conftest.py` boots once per page and shares it:
read-only tests take the session-scoped `default_app`, and tests that need a
different URL or mutate state call `boot_app(...)` for their own page.

## The sequence sources never come from GitHub

The suite is hermetic with respect to GitHub. `tests/e2e/github_stub.py` installs
`context.route()` handlers for `api.github.com` and `raw.githubusercontent.com`
and answers everything itself. Nothing falls through to the real network.

The app lists its folder sources through the
**unauthenticated** GitHub API — 60 requests per hour per IP, four calls per
booted page, three booted pages per run — and running out is silent: the
listings come back empty, the explorer quietly falls back to some other
sequence, and the assertions fail as if sequence selection had regressed.

Requests resolve in order:

1. **A committed snapshot**, for the three *third-party* sources —
   pypulseq's `examples/scripts` folder listing and the `magdamd/MuT`
   ("Educational") folder listing, each plus its file bodies, and the
   MRzero notebook. They live under `fixtures/github/`, with
   `fixtures/github/manifest.json` mapping request URL → fixture file. Refresh
   them deliberately with `python scripts/capture_e2e_source_fixtures.py` (one
   GitHub API call per folder listing; it prints what it wrote). The captured MRzero notebook has
   its cell outputs stripped: 937 KB of embedded output images down to 14 KB,
   with no behavioural difference, because the app's
   `convert_notebook_to_python()` only reads code cells' `source`.
2. **The working tree**, for the two `mrx-org/anyfield` folder sources
   (`pypulseq/anyseq/` and `pypulseq/built_in_seq/`) — the listing is
   synthesized from the real directory and each file body read from disk.
   Snapshotting those would recreate the drift problem the app already has: it runs
   GitHub's *published* copy, so a local edit to a sequence is invisible to the
   running app, and a committed copy would pin the tests to it too. Serving the
   working tree means the suite tests the code you are about to commit.
3. **No match → a loud failure.** The stub records the URL and answers with
   status 599; `boot_app` then fails the test naming the unmatched URLs. If you
   see that, either a source moved (recapture) or the app started asking for
   something new (extend the stub). It never means "network down".

So no run of this suite changes `api.github.com/rate_limit`'s `remaining`.

## The sim gateway never runs a simulation

`DEFAULT_SIM_BACKEND_ID` in `scan_zero/sim_backends.js` is `pdgo1_t4`, whose
`transport` is `'http'`, so the remote half of a scan is three plain HTTP calls
and needs no WebSocket interception. `tests/e2e/sim_gateway_stub.py` answers them
per page — submit, one status poll that returns `done`, and a `.npz` of synthetic
k-space built by the test — and records anything else asked of that host so a new
gateway call fails loudly instead of reaching Modal (and a GPU).

The fake result is a magnitude ramp, not noise, precisely so the recon output can
be checked voxel by voxel: `log(abs(signal) + 1)` of `exp(k/(N-1)) - 1` is `k/(N-1)`.

## The default phantom comes off local disk

`bootstrap()` downloads `DEFAULT_CACHE_PHANTOM_ID` as a 25 MB `.tar.gz` from the
Modal cache admin on every boot — six or seven boots per run, so ~150 MB of live
network, and the last thing that could fail a run for reasons unrelated to the
code under test. It did: a measured run had both `test_scan.py` tests time out in
`wait_for_default_phantom()` and took 141s instead of ~85s.

`tests/e2e/phantom_stub.py` now answers that request from
`tests/e2e/.phantom-cache/`, byte-for-byte as downloaded — `test_phantom_execute.py`
asserts on the real phantom's content, so nothing smaller would do. The cache is
gitignored (the archive's four members are already individually gzipped, so there
is nothing to shrink) and re-fetchable:

```bash
python scripts/fetch_e2e_phantom.py
```

Two things about it are worth knowing before you touch it:

- **It fills itself on a miss**, once, loudly, and says that later runs will be
  offline. That is the single deliberate exception to the no-fallthrough rule
  `github_stub.py` sets, and it exists so a fresh machine can just run the suite.
- **Making it fast found a real app bug, and the story is in the module
  docstring.** Answering instantly used to flip an app-side race so that the
  phantom never reached the Pyodide VFS at all, on every boot, while the viewer
  still showed its three volumes. That was the app loading Pyodide two or three
  times per boot and discarding the runtime the phantom went into; it is fixed in
  the app, and the stub now answers immediately.

## What still comes from the real network

Pyodide and the micropip installs, which are out of scope.

## Known issues

- Any URL carrying shared state (`?s_category=...`) makes `bootstrap()` show an
  "Open shared link?" modal, and it *blocks* source loading until answered.
  `boot_app(query, shared_link="Load shared")` handles that.
- The tests fail on any severe console error except the allow-listed
  `mrseq.sequences` in `BENIGN_CONSOLE_ERRORS` (configured in
  `pypulseq/sources.toml` but ships no importable package, so it errors on every
  boot).
- **`wait_ready` does not imply the phantom is loaded.** The default phantom load
  is a separate promise chain in `bootstrap()`, so app-ready can come before the
  phantom is in the viewer. Anything using the phantom or scanning must call
  `BootedApp.wait_for_default_phantom()` first. The worker `/phantom` VFS stays
  empty after boot; the app writes the archive there on the first Execute or JSON Save.
  Skipping the wait is a flake, not a slow test. When a load failure hits, that wait is
  where it surfaces, with the app's own log quoted — and `(nothing about a
  phantom)` in that message is the *silent* shape of the race, not a missing log.
- The Execute button and the pro-only sim backends need `?pro=1` (`pro_mode.js`),
  which carries no shared state and so needs no `shared_link` answer. Both live
  in tab panes, so the pane's `.tab-btn[data-tab=…]` has to be clicked before
  Playwright will consider the control visible.
