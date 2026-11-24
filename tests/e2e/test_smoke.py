"""End-to-end smoke tests: does index.html actually boot and stay usable?

Every test here drives a real headless Chromium against the real app. Pyodide and the
micropip installs come over the network; the sequence sources are served by
tests/e2e/github_stub.py. See tests/e2e/README.md.
"""
from __future__ import annotations

import re

import pytest
from playwright.sync_api import expect

from app_seam import EXPLORER_JS

pytestmark = pytest.mark.e2e

# Panels re-render behind Pyodide calls, so UI assertions get far more slack than
# the Playwright default (5s). Booting itself is handled by the boot_app fixture.
SLOW_MS = 60_000

# bootstrap()'s SequenceExplorer.DEFAULT_INIT_PROT, i.e. what loads with no URL params.
DEFAULT_FILE = "anyseq.scripts.gre_seq"
DEFAULT_FUNC = "seq_gre"

# A second sequence from the same source, so the deep-link and interaction tests
# assert on a selection that is visibly not the default. seq_tse_2d's own defaults
# (see anyseq/tse.py) are n_read=128 and te=0.005.
OTHER_FILE = "anyseq.scripts.tse"
OTHER_FUNC = "seq_tse_2d"
OTHER_QUERY = "?s_category=anyseq&s_file=tse&s_func=seq_tse_2d"


def _selection(app) -> dict:
    return app.page.evaluate(
        f"() => ({{file: {EXPLORER_JS}.selectedSequence.fileName,"
        f" func: {EXPLORER_JS}.selectedSequence.functionName}})"
    )


def _param_value(app, name: str) -> str:
    return app.page.input_value(f"#seq-param-{name}")


def test_app_boots_and_renders_default_params(default_app):
    """Pyodide comes up, the default sequence auto-selects, its params render."""
    page = default_app.page

    # A different selection here usually means a source folder failed to list and the
    # explorer fell back, not that the default changed -- see the source-stub notes in
    # tests/e2e/README.md.
    assert _selection(default_app) == {"file": DEFAULT_FILE, "func": DEFAULT_FUNC}, (
        f"expected the default sequence; the tree loaded "
        f"{default_app.page.evaluate(f'() => Object.keys({EXPLORER_JS}.sequences).length')} files"
    )

    # The loader only hides once Pyodide, the Niivue module and the sources have
    # all finished, so it doubles as an "everything got there" assertion.
    expect(page.locator("#loader")).to_have_class(re.compile(r"\bhidden\b"), timeout=SLOW_MS)

    params = page.locator("#seq-params-controls .params-table-row")
    expect(params.first).to_be_visible(timeout=SLOW_MS)
    assert params.count() >= 5, "GRE exposes ~13 parameters; got an unexpectedly short table"

    # A named GRE parameter at its documented default, so an empty-but-present
    # table can't pass this test.
    assert _param_value(default_app, "Nread") == "96"

    # Guards the fontconfig setup: with no usable font Chromium either aborts
    # outright or lays text out at zero width.
    name_width = page.evaluate(
        "() => document.getElementById('seq-current-name').getBoundingClientRect().width"
    )
    assert name_width > 0, "sequence name laid out at zero width -- no usable font?"

    assert default_app.page_errors == []
    assert default_app.severe_console_errors() == []


def test_tree_lists_all_sources(default_app):
    """All six configured sources parse and land in the tree."""
    page = default_app.page
    sources = page.eval_on_selector_all(
        "#seq-tree-container .seq-source-header", "els => els.map(e => e.dataset.source)"
    )
    assert sources == [
        "anyseq", "builtin", "mrseq.sequences", "pypulseq_examples", "MRzero", "Educational",
    ], (
        "a source is missing from the tree -- most likely its listing failed; check the "
        "stub's unmatched URLs"
    )

    items = page.locator("#seq-tree-container .seq-function-item")
    assert items.count() >= 20, f"expected the full function list, got {items.count()}"


def test_deep_link_selects_sequence_and_applies_params(boot_app):
    """?s_category=&s_file=&s_func= (+ ?sp_*) reproduces a saved selection.

    bootstrap() joins the three s_* params into an init_prot token and passes any
    sp_<name> values through as parameter overrides; seq_explorer applies both in
    selectInitialSequence() and logs the outcome as [init_prot] ....
    """
    app = boot_app(f"{OTHER_QUERY}&sp_n_read=64&sp_te=0.02", shared_link="Load shared")

    assert _selection(app) == {"file": OTHER_FILE, "func": OTHER_FUNC}
    assert app.logs("[init_prot] OK selected") == [
        "[init_prot] OK selected anyseq/tse:seq_tse_2d"
    ], "deep link resolved via the fallback path instead of the URL token"

    assert _param_value(app, "n_read") == "64"
    assert _param_value(app, "te") == "0.02"

    # The overrides must also register as deviations from the function defaults,
    # otherwise a share link rebuilt from this state would silently drop them.
    changed = app.page.evaluate(f"() => {EXPLORER_JS}.collectChangedSeqParamsForShare()")
    assert changed.get("n_read") == 64
    assert changed.get("te") == 0.02

    assert app.page_errors == []
    assert app.severe_console_errors() == []


def test_select_other_sequence_and_edit_param(boot_app):
    """Clicking a different sequence reloads its params; editing one sticks."""
    app = boot_app()  # its own page: this test mutates app state
    page = app.page

    # Source groups render collapsed, and the tree remembers that in localStorage,
    # so toggle only when it's actually shut.
    header = page.locator("#seq-tree-container .seq-source-header[data-source='anyseq']")
    if "collapsed" in (header.get_attribute("class") or ""):
        header.click()
    item = page.locator(
        f"#seq-tree-container .seq-function-item"
        f"[data-file='{OTHER_FILE}'][data-function='{OTHER_FUNC}']"
    )
    expect(item).to_be_visible(timeout=SLOW_MS)
    item.click()

    page.wait_for_function(
        f"() => {EXPLORER_JS}.selectedSequence.functionName === '{OTHER_FUNC}'",
        timeout=SLOW_MS,
    )
    app.wait_ready()
    assert _selection(app) == {"file": OTHER_FILE, "func": OTHER_FUNC}
    expect(item).to_have_class(re.compile(r"\bselected\b"))

    before = _param_value(app, "n_read")
    assert before != "48", "pick an override that differs from the default"
    page.fill("#seq-param-n_read", "48")
    page.dispatch_event("#seq-param-n_read", "change")

    assert _param_value(app, "n_read") == "48"
    changed = page.evaluate(f"() => {EXPLORER_JS}.collectChangedSeqParamsForShare()")
    assert changed.get("n_read") == 48

    assert app.page_errors == []
    assert app.severe_console_errors() == []
