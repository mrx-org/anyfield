"""Regression coverage for data/execute_json.py before it moves into the Web Worker.

Exercises the real nifti_phantom_v1 config format (constant scalars, direct file
refs, {"file", "func"} eval expressions, B1+ channel lists) against the real,
properly-gzipped checked-in phantom fixture (data/brain_default_1mm_gz/).
"""
from __future__ import annotations

import numpy as np
import nibabel as nib
import pytest

from data.execute_json import execute_phantom, _parse_file_ref


def test_parse_file_ref_valid():
    assert _parse_file_ref("brain_default_PD.nii.gz[3]") == ("brain_default_PD.nii.gz", 3)


@pytest.mark.parametrize("bad_ref", ["no_brackets.nii.gz", "missing_close[2", "bad_index[x]"])
def test_parse_file_ref_invalid_raises(bad_ref):
    with pytest.raises(ValueError):
        _parse_file_ref(bad_ref)


@pytest.fixture(scope="module")
def executed_outputs(tmp_path_factory, gz_phantom_dir):
    """Run execute_phantom() once (module-scoped -- it's the same expensive
    real-data call for every assertion in this file)."""
    out_dir = tmp_path_factory.mktemp("executed")
    averaged_dir = tmp_path_factory.mktemp("averaged")
    out_paths = execute_phantom(
        json_name="brain_default_1mm_gz.json",
        phantom_dir=str(gz_phantom_dir),
        out_dir=str(out_dir),
        averaged_dir=str(averaged_dir),
        write_executed=True,
        write_averaged=True,
    )
    return {"out_dir": out_dir, "averaged_dir": averaged_dir, "out_paths": out_paths}


def test_execute_phantom_writes_4d_per_tissue_maps(executed_outputs):
    out_dir = executed_outputs["out_dir"]
    density_path = out_dir / "brain_default_1mm_gz_density.nii"
    assert density_path.is_file()
    img = nib.load(str(density_path))
    # 5 tissues in the fixture json (gm, wm, csf, vessels, fat) -> 5 frames.
    assert img.shape[3] == 5


def test_execute_phantom_writes_b1_plus_stack(executed_outputs):
    out_dir = executed_outputs["out_dir"]
    b1p_path = out_dir / "brain_default_1mm_gz_B1+.nii"
    assert b1p_path.is_file()
    img = nib.load(str(b1p_path))
    assert img.shape[3] == 5  # one B1+ channel per tissue in this fixture


def test_execute_phantom_averaged_density_is_sum_over_tissues(executed_outputs):
    out_dir = executed_outputs["out_dir"]
    averaged_dir = executed_outputs["averaged_dir"]
    density_4d = nib.load(str(out_dir / "brain_default_1mm_gz_density.nii")).get_fdata(
        dtype=np.float32
    )
    total_density = np.sum(density_4d, axis=-1)

    avg_density = nib.load(str(averaged_dir / "brain_default_1mm_gz_density.nii")).get_fdata(
        dtype=np.float32
    )
    np.testing.assert_allclose(avg_density, total_density, atol=1e-4)


def test_execute_phantom_averaged_t1_is_nan_outside_tissue_and_finite_inside(executed_outputs):
    averaged_dir = executed_outputs["averaged_dir"]
    density = nib.load(str(averaged_dir / "brain_default_1mm_gz_density.nii")).get_fdata(
        dtype=np.float32
    )
    t1 = nib.load(str(averaged_dir / "brain_default_1mm_gz_T1.nii")).get_fdata(dtype=np.float32)

    no_tissue = density <= 0.01
    has_tissue = density > 0.01
    assert np.all(np.isnan(t1[no_tissue]))
    assert np.all(np.isfinite(t1[has_tissue]))
    # Physiologically sane range in seconds for brain tissue at 3T.
    assert np.nanmin(t1) > 0.0
    assert np.nanmax(t1) < 10.0


def test_execute_phantom_fat_db0_func_offset_is_applied(gz_phantom_dir, tmp_path):
    """Fat's dB0 is {"file": ..., "func": "x - 420"} -- isolate fat alone (write_executed
    only, single-tissue subset via a minimal in-memory config) to check the eval'd
    offset is exactly the raw dB0 value minus 420 wherever fat is present."""
    import json
    import shutil

    fat_only_dir = tmp_path / "fat_only"
    fat_only_dir.mkdir()
    for name in ["brain_default_PD.nii.gz", "brain_default_dB0.nii.gz", "brain_default_B1+.nii.gz"]:
        shutil.copy(gz_phantom_dir / name, fat_only_dir / name)

    with open(gz_phantom_dir / "brain_default_1mm_gz.json", "r", encoding="utf-8") as f:
        full_config = json.load(f)
    fat_config = dict(full_config)
    fat_config["tissues"] = {"fat": full_config["tissues"]["fat"]}
    config_path = fat_only_dir / "fat_only.json"
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(fat_config, f)

    out_dir = tmp_path / "out"
    out_paths = execute_phantom(
        json_name="fat_only.json",
        phantom_dir=str(fat_only_dir),
        out_dir=str(out_dir),
        write_executed=True,
        write_averaged=False,
    )
    db0_path = next(p for p in out_paths if p.endswith("_dB0.nii"))
    fat_db0 = nib.load(db0_path).get_fdata(dtype=np.float32)[:, :, :, 0]

    raw_db0 = nib.load(str(fat_only_dir / "brain_default_dB0.nii.gz")).get_fdata(dtype=np.float32)
    raw_density = nib.load(str(fat_only_dir / "brain_default_PD.nii.gz")).get_fdata(
        dtype=np.float32
    )[..., 4]  # fat is tissue index 4 in this fixture's density 4D stack

    present = raw_density > 0
    np.testing.assert_allclose(
        fat_db0[present], raw_db0[..., 0][present] - 420.0, atol=1e-3
    )
    assert np.all(fat_db0[~present] == 0.0)


def test_execute_phantom_rejects_unsupported_file_type(tmp_path):
    import json

    (tmp_path / "src.json").write_text(json.dumps({"file_type": "not_a_phantom"}))
    with pytest.raises(ValueError):
        execute_phantom("src.json", phantom_dir=str(tmp_path))
