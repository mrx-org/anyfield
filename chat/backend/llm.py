import json
import os
import re
from typing import Any

from openai import OpenAI

from log_config import setup_logging
from prompts import SYSTEM_PROMPT

log = setup_logging()

_JSON_BLOCK_RE = re.compile(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", re.IGNORECASE)


def _client() -> OpenAI:
    base_url = os.getenv("LLM_BASE_URL", "http://127.0.0.1:8080/v1").rstrip("/")
    if not base_url.endswith("/v1"):
        base_url = f"{base_url}/v1"
    return OpenAI(
        base_url=base_url,
        api_key=os.getenv("LLM_API_KEY", "local"),
    )


def _parse_actions(text: str) -> list[dict[str, Any]]:
    match = _JSON_BLOCK_RE.search(text or "")
    if not match:
        return []
    try:
        payload = json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        log.warning("failed to parse actions JSON: %s", exc)
        return []
    actions = payload.get("actions")
    return actions if isinstance(actions, list) else []


def _strip_json_block(text: str) -> str:
    if not text:
        return ""
    cleaned = _JSON_BLOCK_RE.sub("", text)
    return cleaned.strip()


def _format_sequence_catalog(catalog: list[dict[str, Any]]) -> str:
    if not catalog:
        return "(catalog empty — sequences may still be loading)"
    lines = []
    for entry in catalog:
        file_key = entry.get("file") or "?"
        func = entry.get("function") or "?"
        lines.append(f"{file_key}:{func}")
    return "\n".join(lines)


def _build_system_content(context: dict[str, Any] | None) -> str:
    ctx = context or {}
    parts = [SYSTEM_PROMPT.rstrip()]

    catalog = ctx.get("sequence_catalog") or []
    parts.append("\n--- Sequence catalog ---")
    parts.append(_format_sequence_catalog(catalog))

    phantom = ctx.get("phantom")
    parts.append("\n--- Phantom ---")
    if phantom:
        parts.append(json.dumps(phantom, indent=2, default=str))
    else:
        parts.append("(no phantom loaded)")

    py_ready = ctx.get("pyodide_ready", False)
    parts.append(f"\npyodide_ready: {py_ready}")

    return "\n".join(parts)


def _estimate_tokens(text: str) -> int:
    """Rough heuristic (~4 chars/token); llama.cpp n_tokens is authoritative."""
    return max(1, len(text) // 4)


def _build_api_messages(
    messages: list[dict[str, str]],
    context: dict[str, Any] | None,
) -> list[dict[str, str]]:
    system_content = _build_system_content(context)
    api_messages: list[dict[str, str]] = [{"role": "system", "content": system_content}]

    for msg in messages:
        role = msg.get("role", "user")
        if role not in ("user", "assistant"):
            role = "user"
        content = str(msg.get("content", "")).strip()
        if content:
            api_messages.append({"role": role, "content": content})

    return api_messages


def chat_completion(
    messages: list[dict[str, str]],
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Call the LLM and return {message, actions}."""
    client = _client()
    model = os.getenv("LLM_MODEL", "local")

    api_messages = _build_api_messages(messages, context)
    payload_text = json.dumps(api_messages, ensure_ascii=False)
    est_tokens = _estimate_tokens(payload_text)

    log.info(
        "LLM request model=%s api_messages=%d est_prompt_tokens~%d state_changed=%s catalog=%d",
        model,
        len(api_messages),
        est_tokens,
        (context or {}).get("state_changed", True),
        len((context or {}).get("sequence_catalog") or []),
    )
    log.debug("LLM full payload:\n%s", json.dumps(api_messages, indent=2, ensure_ascii=False))

    response = client.chat.completions.create(
        model=model,
        messages=api_messages,
        temperature=0.3,
    )
    raw = (response.choices[0].message.content or "").strip()
    actions = _parse_actions(raw)
    message = _strip_json_block(raw) or raw

    usage = getattr(response, "usage", None)
    if usage:
        log.info(
            "LLM usage prompt_tokens=%s completion_tokens=%s total=%s",
            getattr(usage, "prompt_tokens", "?"),
            getattr(usage, "completion_tokens", "?"),
            getattr(usage, "total_tokens", "?"),
        )

    log.info("LLM response chars=%d actions=%d", len(raw), len(actions))
    log.debug("LLM raw response:\n%s", raw)
    if actions:
        log.info("parsed actions: %s", json.dumps(actions, ensure_ascii=False))

    return {"message": message, "actions": actions}
