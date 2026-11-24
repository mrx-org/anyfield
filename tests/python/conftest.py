import gzip
import io
from pathlib import Path

import numpy as np
import nibabel as nib
import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

# Small, real, checked-in fixtures -- used instead of fabricating synthetic
# phantom data wherever a real config is enough.
#
# NOTE: data/brain_default_1mm_single_slice/*.nii.gz are, despite the
# extension, actually *uncompressed* raw NIfTI bytes on disk (confirmed via
# magic-byte sniffing: sizeof_hdr=348, not gzip's 0x1f8b) -- pre-existing
# inconsistency vs. the other two phantom folders, seemingly left over from
# before the (still-open) gzip-compress branch. data/resampling.py's
# run_resampling() never gzip-decompresses its input (expects raw bytes), so
# this folder works fine there; data/execute_json.py's _load_nii() DOES
# unconditionally gzip-decompress any ".gz" filename, so it would raise
# gzip.BadGzipFile on this folder -- use SINGLE_SLICE for resampling tests,
# GZ_PHANTOM (real gzip) for execute_json tests.
SINGLE_SLICE_PHANTOM_DIR = REPO_ROOT / "data" / "brain_default_1mm_single_slice"
SINGLE_SLICE_PHANTOM_JSON = "brain_default.json"

GZ_PHANTOM_DIR = REPO_ROOT / "data" / "brain_default_1mm_gz"
GZ_PHANTOM_JSON = "brain_default_1mm_gz.json"


@pytest.fixture(scope="session")
def single_slice_phantom_dir() -> Path:
    assert SINGLE_SLICE_PHANTOM_DIR.is_dir(), (
        f"Expected fixture phantom dir at {SINGLE_SLICE_PHANTOM_DIR}"
    )
    return SINGLE_SLICE_PHANTOM_DIR


@pytest.fixture(scope="session")
def gz_phantom_dir() -> Path:
    assert GZ_PHANTOM_DIR.is_dir(), f"Expected fixture phantom dir at {GZ_PHANTOM_DIR}"
    return GZ_PHANTOM_DIR


def read_nifti_bytes_decompressed(path: Path) -> bytes:
    """Raw single-file NIfTI bytes regardless of whether ``path`` is actually
    gzip-compressed on disk (sniffs magic bytes rather than trusting the
    extension -- see the module docstring above)."""
    raw = path.read_bytes()
    if raw[:2] == b"\x1f\x8b":
        return gzip.decompress(raw)
    return raw


def load_nifti_any(path: Path) -> nib.Nifti1Image:
    """Load a NIfTI file whether or not it's actually gzip-compressed, without
    relying on nibabel's extension-based sniffing (see module docstring)."""
    raw = read_nifti_bytes_decompressed(path)
    fh = nib.FileHolder(fileobj=io.BytesIO(raw))
    return nib.Nifti1Image.from_file_map({"header": fh, "image": fh})


def make_ref_mask_nifti_bytes(
    tmp_path: Path,
    nx: int,
    ny: int,
    nz: int,
    dx_mm: float,
    dy_mm: float,
    dz_mm: float,
    name: str = "ref_mask.nii",
) -> bytes:
    """Build a minimal single-file .nii (uncompressed) as raw bytes, matching what
    ``run_sim_recon``/``run_resampling`` expect for their ``ref_bytes``/``*_bytes`` args
    (``nib.Nifti1Image.from_file_map`` on an in-memory ``io.BytesIO``)."""
    data = np.zeros((nx, ny, nz), dtype=np.uint8)
    affine = np.diag([dx_mm, dy_mm, dz_mm, 1.0]).astype(np.float64)
    img = nib.Nifti1Image(data, affine)
    img.header.set_zooms((dx_mm, dy_mm, dz_mm))
    path = tmp_path / name
    nib.save(img, str(path))
    return path.read_bytes()
