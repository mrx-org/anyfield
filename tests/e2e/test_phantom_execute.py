"""End-to-end coverage for the phantom Execute path in niivue_app.js.

Drives the real `#json-execute-*` button, so one test covers `handleJsonExecute` and both
halves it was split into: `_writePhantomJsonToVfs` and `_executePhantomToVolumeData`.
See tests/e2e/README.md for the setup this shares with the smoke tests.
"""
from __future__ import annotations

import pytest
from playwright.sync_api import expect

from app_seam import CONTEXT_JS, NV_JS
from conftest import DEFAULT_PHANTOM_JSON, DEFAULT_PHANTOM_NIFTIS

pytestmark = pytest.mark.e2e

SLOW_MS = 60_000
# Execute is not a UI wait: it runs execute_phantom over five tissues at 181x217x181
# float32 inside the Pyodide worker. Measured 7.5-8s on the main thread; the worker
# path is the same compute, hence its own budget.
EXECUTE_MS = 180_000

# The Execute button is pro-gated (pro_mode.js), and ?pro= carries no shared state, so this
# needs no shared-link answer.
PRO_QUERY = "?pro=1"

PHANTOM_STEM = DEFAULT_PHANTOM_JSON.removesuffix(".json")

# execute_phantom(write_executed=False, write_averaged=True) writes one density-weighted 3D
# map per scalar property and one per B1 channel, in this order -- see data/execute_json.py.
# The order is what _executePhantomToVolumeData returns and what the caller pairs bytes to.
AVERAGED_MAPS = [
    f"{PHANTOM_STEM}_{prop}.nii"
    for prop in ("density", "T1", "T2", "T2'", "ADC", "dB0", "B1+", "B1-")
]

# Documented scalars from the default phantom's own JSON: T1 spans fat (0.37s) to csf and
# vessels (4.16s), ADC peaks at csf/vessels (3.19), and every tissue declares "B1-": [1.0].
# Asserting these per map is what proves each output path kept its own bytes.
T1_RANGE_S = (0.37, 4.16)
ADC_MAX = 3.19
PHANTOM_DIMS = [181, 217, 181]
NIFTI_FLOAT32 = 16

# The default phantom's JSON carries a "$schema" key and no "file_type", which
# execute_phantom() rejects outright ("Unsupported file_type: None"). So a fresh boot cannot
# Execute the phantom it just loaded; adding the key is the user's only workaround. This is
# a known app/data issue -- the test adds the key rather than asserting the
# failure, so it keeps testing the real path once the phantom is fixed. Editing here also
# means _writePhantomJsonToVfs is handed a body that differs from the VFS copy, which is the
# only way to see that it wrote at all.
ADD_FILE_TYPE_JS = f"""
() => {{
  const nv = {NV_JS};
  const cfg = JSON.parse(nv.getJsonEditorValue());
  cfg.file_type = 'nifti_phantom_v1';
  const body = JSON.stringify(cfg, null, 2);
  nv.setJsonEditorValue(body);
  return body;
}}
"""

# Every _averaged volume group, with enough of each volume to tell "in volumeGroups" from
# "actually in the viewer" -- the two things handleJsonExecute has to keep in step.
EXECUTED_GROUPS_JS = f"""
() => {{
  const nv = {NV_JS};
  const shown = nv.nv.volumes;
  return nv.volumeGroups
    .filter(g => String(g.jsonName || '').endsWith('_averaged'))
    .map(g => ({{
      id: g.id,
      jsonName: g.jsonName,
      jsonFileName: g.jsonFileName,
      names: g.volumes.map(v => v.name),
      opacities: g.volumes.map(v => v.opacity),
      inViewer: g.volumes.map(v => shown.includes(v)),
    }}));
}}
"""

MAP_STATS_JS = f"""
(name) => {{
  const v = {NV_JS}.nv.volumes.find(x => x.name === name);
  if (!v) return null;
  return {{
    dims: Array.from(v.hdr.dims).slice(1, 4),
    datatypeCode: v.hdr.datatypeCode,
    min: v.global_min,
    max: v.global_max,
  }};
}}
"""


def _vfs_dir(app, path: str) -> list[str] | None:
    """Entries of a worker VFS directory, or None when it does not exist."""
    entries = app.page.evaluate(
        f"""async (path) => {{
          const client = await {CONTEXT_JS}.pyWorker.whenInit();
          try {{ return await client.fsReaddir(path); }} catch (_) {{ return null; }}
        }}""",
        path,
    )
    return None if entries is None else sorted(entries)


def _averaged_dir(app) -> list[str] | None:
    return _vfs_dir(app, "/phantom/averaged")


def _viewer_volume_names(app) -> list[str]:
    return app.page.evaluate(f"() => {NV_JS}.nv.volumes.map(v => v.name)")


def _vfs_json(app, name: str) -> str:
    return app.page.evaluate(
        f"""async (name) => {{
          const client = await {CONTEXT_JS}.pyWorker.whenInit();
          const bytes = await client.fsRead('/phantom/' + name);
          return new TextDecoder('utf-8').decode(bytes);
        }}""",
        name,
    )


def _the_executed_group(app) -> dict:
    groups = app.page.evaluate(EXECUTED_GROUPS_JS)
    assert len(groups) == 1, (
        f"expected exactly one _averaged group, got {[g['jsonName'] for g in groups]}"
    )
    return groups[0]


def test_execute_phantom_writes_json_and_loads_averaged_maps(boot_app):
    """Execute turns the edited JSON into the averaged maps, in the viewer, and replaces.

    Phases one and two share a page on purpose: a second boot plus a second Pyodide run
    would roughly double the suite's wall time to assert one more thing.
    """
    app = boot_app(PRO_QUERY)  # its own page: Execute mutates volumeGroups and the VFS
    page = app.page
    app.wait_for_default_phantom()
    inst = app.instance_id()

    page.click('.tab-btn[data-tab="phantoms"]')
    execute = page.locator(f"#json-execute-{inst}")
    status = page.locator(f"#json-tab-status-{inst}")
    expect(execute).to_be_visible(timeout=SLOW_MS)

    # Documented starting point, so a boot that silently lost the phantom cannot pass by
    # executing something else (or nothing).
    assert page.evaluate(f"() => {NV_JS}.jsonTabCurrentName") == DEFAULT_PHANTOM_JSON
    assert _viewer_volume_names(app) == list(DEFAULT_PHANTOM_NIFTIS)
    # The boot unpacks the archive in the page; the worker VFS only gets it on first use.
    assert _vfs_dir(app, "/phantom") is None, "/phantom should stay unwritten until Execute"

    edited_body = page.evaluate(ADD_FILE_TYPE_JS)
    assert '"file_type"' in edited_body

    # --- Phase 1: first Execute ---
    execute.click()
    expect(status).to_have_text(f"Done — {len(AVERAGED_MAPS)} maps loaded.", timeout=EXECUTE_MS)

    # _writePhantomJsonToVfs ran, and wrote the *editor's* body: the VFS copy had no
    # file_type until this click. Catches the write being dropped or moved after the compute
    # (the compute would then have read the old body and raised on file_type).
    assert _vfs_json(app, DEFAULT_PHANTOM_JSON) == edited_body
    # ... and _syncJsonContentToVolumeGroups carried the same body onto the source group,
    # which is what the editor falls back to when it is empty.
    assert '"file_type"' in page.evaluate(
        f"() => {NV_JS}.volumeGroups.find("
        f"g => g.jsonFileName === '{DEFAULT_PHANTOM_JSON}').jsonContent"
    )

    # Execute wrote the parked archive first: the NIfTIs execute_phantom read are there.
    assert set(DEFAULT_PHANTOM_NIFTIS) <= set(_vfs_dir(app, "/phantom") or [])
    # The compute half really produced the files it reported paths for.
    assert _averaged_dir(app) == sorted(AVERAGED_MAPS)

    group = _the_executed_group(app)
    assert group["jsonName"] == f"{PHANTOM_STEM}_averaged"
    assert group["jsonFileName"] == DEFAULT_PHANTOM_JSON
    # Order matters: the caller zips each returned path to the bytes read for it, so a
    # reordering or an off-by-one in that pairing shows up here.
    assert group["names"] == AVERAGED_MAPS
    # The i === 0 ? 1.0 : 0 rule in handleJsonExecute -- exactly one visible map, the first.
    assert group["opacities"] == [1.0] + [0] * (len(AVERAGED_MAPS) - 1)
    # Group bookkeeping and the viewer agreeing is the whole point of the split's caller.
    assert all(group["inViewer"])
    assert _viewer_volume_names(app) == list(DEFAULT_PHANTOM_NIFTIS) + AVERAGED_MAPS

    # Per-map values from the phantom's own JSON. If the read pass ever paired a path with
    # another map's bytes these would swap: T1's max is 4.16 and ADC's is 3.19.
    t1 = page.evaluate(MAP_STATS_JS, f"{PHANTOM_STEM}_T1.nii")
    assert t1["dims"] == PHANTOM_DIMS
    assert t1["datatypeCode"] == NIFTI_FLOAT32
    assert (t1["min"], t1["max"]) == pytest.approx(T1_RANGE_S, abs=1e-4)

    adc = page.evaluate(MAP_STATS_JS, f"{PHANTOM_STEM}_ADC.nii")
    assert adc["max"] == pytest.approx(ADC_MAX, abs=1e-4)

    # Every tissue declares "B1-": [1.0], so its density-weighted average is constant 1.
    b1m = page.evaluate(MAP_STATS_JS, f"{PHANTOM_STEM}_B1-.nii")
    assert (b1m["min"], b1m["max"]) == pytest.approx((1.0, 1.0), abs=1e-6)

    # --- Phase 2: Execute again replaces the group rather than stacking it ---
    first_id = group["id"]
    execute.click()
    expect(status).to_have_text("Executing...", timeout=SLOW_MS)
    expect(status).to_have_text(f"Done — {len(AVERAGED_MAPS)} maps loaded.", timeout=EXECUTE_MS)

    again = _the_executed_group(app)
    assert again["id"] != first_id, "Execute reused the group id; it should build a new one"
    assert again["names"] == AVERAGED_MAPS
    assert again["opacities"] == [1.0] + [0] * (len(AVERAGED_MAPS) - 1)
    assert all(again["inViewer"])
    # The removal loop that must run before the compute: 3 phantom + 8 maps, not 3 + 16.
    assert _viewer_volume_names(app) == list(DEFAULT_PHANTOM_NIFTIS) + AVERAGED_MAPS

    assert app.page_errors == []
    assert app.severe_console_errors() == []
