"""Argument types shared by the tool modules (server, phantom_tools, file_tools).
Each tool's docstring says what the session does for it."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field

SessionKey = Annotated[str, Field(description="Key of the session (from create_session or a shared link)")]
OptionalSessionKey = Annotated[
    str | None,
    Field(
        description="Optional session key: the tool works on that session (see its description). "
        "Without one the user's choice goes back to the chat"
    ),
]
ExpectedRev = Annotated[
    int | None, Field(description="Optional: fail instead of overwriting if the session changed since")
]
Vec3Arg = Annotated[list[float], Field(min_length=3, max_length=3)]
LocaleArg = Annotated[
    Literal["en", "de", "es", "fr", "it"] | None,
    Field(
        description="Language of the user interface: set it to the language of the conversation "
        "(default: the chat's or browser's, else English)"
    ),
]
