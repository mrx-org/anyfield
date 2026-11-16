"""Session state. Small (a few KB): large data will only be referenced by hash."""

from __future__ import annotations

import secrets
import time

from pydantic import BaseModel, Field

Vec3 = tuple[float, float, float]


class Fov(BaseModel):
    """Field of view in world coordinates (RAS, mm), independent of the phantom grid.

    The box is centred on `center_mm`. Its axes are the world axes rotated by
    `rotation_deg`: first about X, then about Y, then about Z (as in v3).
    """

    center_mm: Vec3 = (0.0, 0.0, 0.0)
    rotation_deg: Vec3 = (0.0, 0.0, 0.0)
    size_mm: Vec3 = (200.0, 200.0, 100.0)


class Session(BaseModel):
    key: str
    name: str
    owner: str | None = Field(default=None, description="GitHub user id of the creator")
    owner_login: str | None = None
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)
    rev: int = 0
    fov: Fov = Field(default_factory=Fov)


def new_key() -> str:
    """Random session key (128 bit). Whoever knows it may read and change the session."""
    return secrets.token_urlsafe(16)
