"""Session state: a small JSON with the user's choices only, no data.

Data (phantom maps, value ranges, loading state) comes from the tools that
produce it and is never stored here. Besides `state`, a session has only
management fields.
"""

from __future__ import annotations

import secrets
import time
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

Vec3 = tuple[float, float, float]
Int3 = tuple[int, int, int]


class Fov(BaseModel):
    """Field of view in world coordinates (RAS, mm), independent of the phantom grid.

    The box is centred on `center_mm`. Its axes are the world axes rotated by
    `rotation_deg`: first about X, then about Y, then about Z (as in v3).
    """

    model_config = ConfigDict(extra="forbid")

    center_mm: Vec3 = (0.0, 0.0, 0.0)
    rotation_deg: Vec3 = (0.0, 0.0, 0.0)
    size_mm: Vec3 = (200.0, 200.0, 100.0)


class PhantomChoice(BaseModel):
    """A phantom of the BIfTI registry."""

    model_config = ConfigDict(extra="forbid")

    collection: str
    name: str = Field(description="Phantom file name, e.g. 'subj04-3T-1mm.json'")


class View(BaseModel):
    model_config = ConfigDict(extra="forbid")

    property: str = Field(default="density", description="Shown property: density, T1, T2, ...")


class State(BaseModel):
    """What the user (or the AI) chose. `phantom=None` is the default phantom
    (`phantoms.DEFAULT_PHANTOM`, from the gateway like every other)."""

    model_config = ConfigDict(extra="forbid")

    phantom: PhantomChoice | None = None
    view: View = Field(default_factory=View)
    fov: Fov = Field(default_factory=Fov)
    matrix: Int3 = Field(default=(128, 128, 1), description="Resolution (x, y, z) of the planned scan")


class Session(BaseModel):
    key: str
    name: str
    owner: str | None = Field(default=None, description="User id (WorkOS `sub`) of the creator")
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)
    rev: int = 0
    state: State = Field(default_factory=State)


def merge_patch(target: Any, patch: Any) -> Any:
    """RFC 7386 JSON Merge Patch: objects merge, `null` removes, the rest replaces."""
    if not isinstance(patch, dict):
        return patch
    result = dict(target) if isinstance(target, dict) else {}
    for k, v in patch.items():
        if v is None:
            result.pop(k, None)
        else:
            result[k] = merge_patch(result.get(k), v)
    return result


def new_key() -> str:
    """Random session key (128 bit). Whoever knows it may read and change the session."""
    return secrets.token_urlsafe(16)
