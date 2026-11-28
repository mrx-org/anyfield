"""Settings of a logged-in user: language, colour theme, light/dark and whether MCP
Apps take the chat's colours. Stored per user (`u:<user id>`), used by the website
and every MCP App as their defaults. Without a login (the shared `visitor`) nothing
is stored: the tools say so."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastmcp import FastMCP
from pydantic import BaseModel, ConfigDict, Field

from .auth import current_user
from .store import SessionStore

Locale = Literal["en", "de", "es", "fr", "it"]
Mode = Literal["light", "dark", "auto"]
# The colour themes of Skeleton (the UI library); the default is cerberus
THEMES = (
    "catppuccin", "cerberus", "concord", "crimson", "dracula", "fennec", "hamlindigo", "legacy",
    "mint", "modern", "mona", "nosh", "nouveau", "pine", "reign", "rocket", "rose", "rosepine",
    "sahara", "seafoam", "terminus", "vintage", "vox", "wintry",
)  # fmt: skip
Theme = Literal[THEMES]  # type: ignore[valid-type]
NOT_SAVED = "Not saved: settings are kept only for a logged-in user (this call has no login)."


class UserSettings(BaseModel):
    """null: not set (the default applies)."""

    model_config = ConfigDict(extra="forbid")

    locale: Locale | None = Field(
        default=None, description="Language of the UI; null: the chat's or browser's"
    )
    theme: Theme | None = Field(default=None, description="Colour theme; null: cerberus")
    mode: Mode | None = Field(
        default=None, description="light, dark or auto (the chat's or system's); null: auto"
    )
    chat_theme: bool | None = Field(
        default=None,
        description="In a chat, take the chat's colours where it sends them (else the theme); null: true",
    )


def register(mcp: FastMCP, store: SessionStore) -> None:
    @mcp.tool(annotations={"readOnlyHint": True})
    async def get_user_settings() -> dict[str, Any]:
        """The logged-in user's settings for anyfield's UI (website and MCP Apps):
        `locale`, `theme`, `mode`, `chat_theme`; null where not set. `saved` is false
        without a login (then all are null)."""
        user = current_user()
        settings = await store.get_settings(user.id) if user else None
        return {"saved": user is not None, **(settings or UserSettings()).model_dump()}

    @mcp.tool
    async def set_user_settings(
        locale: Annotated[Locale | None, Field(description="Language of the UI")] = None,
        theme: Annotated[Theme | None, Field(description=f"Colour theme: {', '.join(THEMES)}")] = None,
        mode: Annotated[
            Mode | None, Field(description="light, dark, or auto (as the chat or system)")
        ] = None,
        chat_theme: Annotated[
            bool | None,
            Field(description="In a chat, take the chat's colours where it sends them (else the theme)"),
        ] = None,
        reset: Annotated[
            list[Literal["locale", "theme", "mode", "chat_theme"]] | None,
            Field(description="Settings to set back to their default"),
        ] = None,
    ) -> dict[str, Any]:
        """Change the user's settings for anyfield's UI, e.g. the language to the one of
        the conversation, a colour theme, or light/dark. They apply to the website and
        every MCP App the user opens later (an open one on its next load). Arguments
        left out stay. Only with a login: without one nothing is saved (`saved: false`,
        `warning`)."""
        user = current_user()
        current = (await store.get_settings(user.id) if user else None) or UserSettings()
        changes = {
            k: v
            for k, v in {"locale": locale, "theme": theme, "mode": mode, "chat_theme": chat_theme}.items()
            if v is not None
        }
        new = current.model_copy(update={**changes, **dict.fromkeys(reset or [])})
        if user is None:
            return {"saved": False, "warning": NOT_SAVED, **new.model_dump()}
        await store.put_settings(user.id, new)
        return {"saved": True, **new.model_dump()}
