import pytest

from anyfield.fov import move_fov, normalize_angle, rotate_fov, set_fov
from anyfield.models import Fov


@pytest.mark.parametrize("deg, want", [(0, 0), (180, 180), (-180, 180), (190, -170), (540, 180), (-370, -10)])
def test_normalize_angle(deg, want):
    assert normalize_angle(deg) == pytest.approx(want)


def test_partial_set_keeps_other_fields():
    f = set_fov(Fov(), center_mm=(1, 2, 3))
    assert f.size_mm == Fov().size_mm and f.center_mm == (1, 2, 3)


def test_move_and_rotate_are_relative():
    f = rotate_fov(move_fov(Fov(center_mm=(1, 1, 1)), (1, 2, 3)), (90, 0, 0))
    assert f.center_mm == (2, 3, 4) and f.rotation_deg == (90, 0, 0)


@pytest.mark.parametrize("size", [(0, 1, 1), (1, -1, 1), (1, 1, 601)])
def test_size_limits(size):
    with pytest.raises(ValueError):
        set_fov(Fov(), size_mm=size)
