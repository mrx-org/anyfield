"""Session state: a small JSON with the user's choices only, no data.

Data (phantom maps, value ranges, loading state) comes from the tools that
produce it and is never stored here. Besides `state`, a session has only
management fields.
"""

from __future__ import annotations

import secrets
import time
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

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


class CasPhantom(BaseModel):
    """A phantom in the gateway's CAS: a bifti .zip (an upload or a get_phantom
    result). The hash is the permission: whoever has it (e.g. in a shared
    session) can see the phantom, whatever their own files are."""

    model_config = ConfigDict(extra="forbid")

    sha256: str = Field(pattern=r"^[0-9a-f]{64}$", description="Hash of the phantom's .zip in the CAS")
    name: str = Field(description="File name, for display only, e.g. 'my-phantom.zip'")


Phantom = PhantomChoice | CasPhantom


class View(BaseModel):
    """How the viewers show the phantom (each viewer picks its plane itself)."""

    model_config = ConfigDict(extra="forbid")

    property: str = Field(default="density", description="Shown property: density, T1, T2, ...")
    tissues: list[str] | None = Field(
        default=None,
        description="Tissues combined into the maps (names from list_phantom_tissues); null: all",
    )

    @field_validator("tissues")
    @classmethod
    def _tissues(cls, v: list[str] | None) -> list[str] | None:
        # Sorted, each once; none at all means all (the gateway refuses an empty list)
        return sorted(set(v)) or None if v is not None else None


class State(BaseModel):
    """What the user (or the AI) chose. `phantom` is a registry phantom
    ({collection, name}) or one in the CAS ({sha256, name}); `None` is the default
    phantom (`phantoms.DEFAULT_PHANTOM`, from the gateway like every other)."""

    model_config = ConfigDict(extra="forbid")

    phantom: Phantom | None = None
    view: View = Field(default_factory=View)
    fov: Fov = Field(default_factory=Fov)
    matrix: Int3 = Field(default=(128, 128, 1), description="Resolution (x, y, z) of the planned scan")

    @model_validator(mode="before")
    @classmethod
    def _stored(cls, data: Any) -> Any:
        """Read sessions stored before a field moved or went away."""
        if isinstance(data, dict) and isinstance(data.get("view"), dict) and "plane" in data["view"]:
            data = {**data, "view": {k: v for k, v in data["view"].items() if k != "plane"}}
        return data


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
