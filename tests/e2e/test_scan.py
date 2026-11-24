"""End-to-end coverage for the HTTP scan pipeline in scan_zero/scan_module.js.

Drives the real SCAN button with the Modal sim gateway stubbed (tests/e2e/sim_gateway_stub.py),
which covers `_httpPrepareAndSubmit` -> `_httpPollOnce` -> `_httpFinishJob` and the two
compute steps it orchestrates: `_readSeqMatrixDefinition` and `_reconstructJob`. The
sequence is built for real by pypulseq in Pyodide; only the remote simulation is faked.
The result NPZ is decoded on the worker by `recon.py`'s `inputs_from_npz`, so
this suite exercises that boundary too.

Both tests run with the recon toggle OFF (`kspace_log`). That is deliberate: `matrix` --
the value `_readSeqMatrixDefinition` recovers from the job's `.seq` -- is consulted by
`_kspace_log_volume` in scan_zero/recon.py and by nothing else, so a run with the toggle on
cannot observe it at all.
"""
from __future__ import annotations

import io

import numpy as np
import pytest

from app_seam import EXPLORER_JS, NV_JS
from conftest import DEFAULT_PHANTOM_NIFTIS
from sim_gateway_stub import JOB_ID, install_sim_gateway_stub

pytestmark = pytest.mark.e2e

# A scan is a pypulseq build in Pyodide plus a Pyodide-side NPZ decode and recon. Measured
# ~1.1s from click to done here, but the build is the uncovered slow step this budget is for.
SCAN_MS = 300_000

# anyseq/mr0_tse_2d_seq.py's seq_TSE_2D is the only shipped sequence that calls
# set_definition('matrix', [Nread, Nphase, 1]) -- gre.py and tse.py write 'recon_matrix' and
# gre_seq.py writes neither -- so it is the one that gives _readSeqMatrixDefinition something
# to find. Nread/Nphase are dropped to 16 to keep the build small; TE is raised from its 5ms
# default because at Nread=16 the readout is short enough to make the sequence's own
# pre-refocus delay negative, which pypulseq rejects outright.
MATRIX_QUERY = (
    "?pro=1&s_category=anyseq&s_file=mr0_tse_2d_seq&s_func=seq_TSE_2D"
    "&sp_Nread=16&sp_Nphase=16&sp_shots=2&sp_TE=0.008"
)
MATRIX_SEQ_MATRIX = [16, 16, 1]
MATRIX_SCAN_VOLUME = "scan_1_seq_TSE_2D.nii.gz"

N_SAMPLES = MATRIX_SEQ_MATRIX[0] * MATRIX_SEQ_MATRIX[1]


def _ramp_npz() -> bytes:
    """A fake result whose recon output is checkable voxel by voxel.

    `_kspace_log_volume` writes ``log(abs(signal) + 1)``, so magnitudes of ``exp(i/(N-1)) - 1``
    come out as an exact 0..1 ramp in acquisition order: voxel k of the reshaped volume must
    hold ``k / (N - 1)``. That pins the complex decode in `inputs_from_npz`, the sample
    order, and the C-order reshape all at once, which "the array is finite" would not.

    The trajectory is golden-angle radial on purpose. `_per_axis_cartesian_and_offsets` would
    otherwise detect a Cartesian grid and scatter onto the recon grid instead, and the
    Cartesian branch never looks at `matrix`.
    """
    i = np.arange(N_SAMPLES)
    theta = i * np.pi * (3.0 - np.sqrt(5.0))
    radius = (i % MATRIX_SEQ_MATRIX[0]) / MATRIX_SEQ_MATRIX[0] * 120.0  # 1/m
    ktraj = np.stack(
        [radius * np.cos(theta), radius * np.sin(theta), np.zeros(N_SAMPLES)], axis=1
    ).astype(np.float32)
    signal = ((np.exp(i / (N_SAMPLES - 1)) - 1.0) * np.exp(1j * 0.3 * i)).astype(np.complex64)
    buf = io.BytesIO()
    np.savez(buf, signal=signal, ktraj=ktraj)
    return buf.getvalue()


JOB_JS = """
() => {
  const j = (window.anyfield.scan.queue || [])[0];
  if (!j) return null;
  return {
    baseName: j.baseName, status: j.status, error: j.error, stage: j.pipelineStage,
    httpJobId: j.httpJobId, reconDone: j.reconDone, vfsSeqPath: j.vfsSeqPath,
    hasNiftiUrl: !!j.niftiUrl,
  };
}
"""

SCAN_VOLUME_JS = f"""
(name) => {{
  const v = {NV_JS}.nv.volumes.find(x => x.name === name);
  if (!v) return null;
  // Small enough (a few hundred voxels) to check every one of them in the test.
  return {{dims: Array.from(v.hdr.dims).slice(1, 4), img: Array.from(v.img)}};
}}
"""

# log(abs(signal) + 1) for the ramp the stub serves, in acquisition order.
EXPECTED_RAMP = np.arange(N_SAMPLES) / (N_SAMPLES - 1)


def _run_scan(app, npz: bytes):
    """Turn the recon toggle off, stub the gateway, click SCAN, wait for the job to settle."""
    page = app.page
    app.wait_for_default_phantom()
    inst = app.instance_id()

    page.click('.tab-btn[data-tab="view"]')
    page.uncheck(f"#scanRecon-{inst}")
    assert page.evaluate(f"() => {NV_JS}.isScanReconEnabled()") is False

    stub = install_sim_gateway_stub(page, npz)
    page.click("#btn-start-scan")
    page.wait_for_function(
        "() => ['done', 'error'].includes((window.anyfield.scan.queue || [])[0]?.status)",
        timeout=SCAN_MS,
    )
    job = page.evaluate(JOB_JS)
    assert job["status"] == "done", f"scan failed: {job['error']}"
    return stub, job


def _assert_gateway_protocol(stub):
    """The three calls of the job protocol, in order, and nothing else on that host."""
    assert stub.unmatched == [], (
        f"the sim gateway stub had no answer for:\n  {stub.unmatched_report()}"
    )
    assert stub.requests == [
        "POST /v1/jobs",
        f"GET /v1/jobs/{JOB_ID}",
        f"GET /v1/jobs/{JOB_ID}/result",
    ]
    # _httpSubmitJob's multipart form: the .seq blob, the options JSON, and the phantom id
    # that _resolveBiftiId recovered from the loaded phantom group.
    body = stub.submit_bodies[0]
    assert b'name="seq"' in body and b'name="options"' in body
    assert b"brainweb-20-v2/subj04-3T-1mm-tra" in body
    assert b'"worker": "t4"' in body or b'"worker":"t4"' in body


def test_http_scan_kspace_log_uses_the_seq_matrix(boot_app):
    """Recon off + a sequence with a `matrix` definition: the output grid is that matrix.

    This is the only observable place the seq `matrix` value is used. If
    `_readSeqMatrixDefinition` stops recovering it, `_kspace_log_volume` falls through to its
    1xNx1 strip and the assertion on `dims` fails -- see the companion test for that shape.
    """
    app = boot_app(MATRIX_QUERY, shared_link="Load shared")  # own page: this scans
    page = app.page

    # Documented starting point: the deep link really selected the matrix-defining sequence
    # at the small size, so the test is not silently scanning the default GRE.
    assert page.evaluate(f"() => {EXPLORER_JS}.selectedSequence.functionName") == "seq_TSE_2D"
    assert page.input_value("#seq-param-Nread") == "16"
    assert page.input_value("#seq-param-Nphase") == "16"

    stub, job = _run_scan(app, _ramp_npz())
    _assert_gateway_protocol(stub)

    assert job["baseName"] == "scan_1_seq_TSE_2D"
    assert job["httpJobId"] == JOB_ID
    # The stage/flag pair _httpFinishJob sets around the compute steps.
    assert job["reconDone"] is True
    assert job["stage"] == 4
    assert job["hasNiftiUrl"] is True
    # _readSeqMatrixDefinition reads this path off the VFS with pypulseq.
    assert job["vfsSeqPath"] == "/outputs/scan_1_seq_TSE_2D.seq"

    # loadJob put the result in the viewer alongside the phantom, and nothing was dropped.
    assert page.evaluate(f"() => {NV_JS}.nv.volumes.map(v => v.name)") == [
        *DEFAULT_PHANTOM_NIFTIS,
        MATRIX_SCAN_VOLUME,
    ]

    vol = page.evaluate(SCAN_VOLUME_JS, MATRIX_SCAN_VOLUME)
    # The whole point: the grid is the .seq's matrix, not the recon matrix (128x128x1 here,
    # which is what the FOV mask reference carries) and not the 1xNx1 fallback strip.
    assert vol["dims"] == MATRIX_SEQ_MATRIX
    assert len(vol["img"]) == N_SAMPLES
    # Every voxel, which pins the sample order end to end. `_kspace_log_volume` reshapes the
    # samples C-order into (Nread, Nphase, 1) and nibabel writes that first-axis-fastest, so
    # Niivue's flat `img` is the Fortran read of the C-order reshape -- i.e. a transpose. A
    # regression anywhere from `inputs_from_npz`'s complex decode to the reshape shows
    # up as a permuted or shifted ramp here.
    nread, nphase = MATRIX_SEQ_MATRIX[0], MATRIX_SEQ_MATRIX[1]
    got = np.array(vol["img"], dtype=np.float64).reshape((nread, nphase), order="F")
    assert got == pytest.approx(EXPECTED_RAMP.reshape(nread, nphase), abs=1e-5)

    assert app.page_errors == []
    assert app.severe_console_errors() == []


def test_http_scan_kspace_log_without_a_seq_matrix(boot_app):
    """The same pipeline on a sequence that defines no `matrix`: absent, not a failure.

    `_readSeqMatrixDefinition` is documented as tolerant -- no path, a path absent from the
    VFS, or any pypulseq failure yields null -- and the boot default (gre_seq) sets only FOV
    and Name, so it exercises that. This is the majority case: of the shipped sequences only
    mr0_tse_2d_seq.py defines `matrix` at all.

    It is also the regression test for the JsNull crash: Pyodide surfaces JS null as
    pyodide.ffi.JsNull rather than None, so handing the absent case straight across the
    boundary got past recon.py's `matrix is not None` guard and raised in len().
    """
    app = boot_app("?pro=1")  # own page: this scans
    page = app.page
    assert page.evaluate(f"() => {EXPLORER_JS}.selectedSequence.functionName") == "seq_gre"

    stub, job = _run_scan(app, _ramp_npz())
    _assert_gateway_protocol(stub)
    assert job["reconDone"] is True

    # The scan's own output name, rather than a second guess at the naming rule that the
    # matrix test already pins.
    scan_volume = f"{job['baseName']}.nii.gz"
    assert page.evaluate(f"() => {NV_JS}.nv.volumes.map(v => v.name)") == [
        *DEFAULT_PHANTOM_NIFTIS,
        scan_volume,
    ]

    vol = page.evaluate(SCAN_VOLUME_JS, scan_volume)
    # _kspace_log_volume's last resort: one 1xNx1 strip of every sample, no grid.
    assert vol["dims"] == [1, N_SAMPLES, 1]
    assert np.array(vol["img"]) == pytest.approx(EXPECTED_RAMP, abs=1e-5)

    assert app.page_errors == []
    assert app.severe_console_errors() == []
