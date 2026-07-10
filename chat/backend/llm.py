import json
import os
import re
from typing import Any

from openai import OpenAI

from log_config import get_logger
from prompts import SYSTEM_PROMPT

log = get_logger()

_JSON_BLOCK_RE = re.compile(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", re.IGNORECASE)


def _generation_kwargs() -> dict[str, Any]:
    raw = os.getenv("LLM_GENERATION", "").strip()
    if not raw:
        return {"temperature": 0.3}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        log.warning("invalid LLM_GENERATION JSON, using temperature=0.3: %s", exc)
        return {"temperature": 0.3}
    if not isinstance(parsed, dict):
        log.warning("LLM_GENERATION must be a JSON object, using temperature=0.3")
        return {"temperature": 0.3}
    return parsed


def generation_kwargs() -> dict[str, Any]:
    return dict(_generation_kwargs())


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


def _format_bootstrap_context(context: dict[str, Any]) -> str:
    return (
        "\n\n--- Anyfield context (JSON) ---\n"
        + json.dumps(context, indent=2, ensure_ascii=False, default=str)
    )


def _estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)


def _usage_to_dict(usage: Any) -> dict[str, Any]:
    if usage is None:
        return {}
    if hasattr(usage, "model_dump"):
        return usage.model_dump(mode="json", exclude_none=True)
    if isinstance(usage, dict):
        return {k: v for k, v in usage.items() if v is not None}
    out: dict[str, Any] = {}
    for key in (
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "completion_tokens_details",
        "prompt_tokens_details",
    ):
        val = getattr(usage, key, None)
        if val is not None:
            out[key] = (
                val.model_dump(mode="json", exclude_none=True)
                if hasattr(val, "model_dump")
                else val
            )
    return out


def _extract_reasoning(message: Any) -> str | None:
    """Best-effort reasoning text from OpenAI-compatible message objects."""
    if message is None:
        return None
    for key in ("reasoning_content", "reasoning"):
        val = getattr(message, key, None)
        if val is not None and str(val).strip():
            return str(val).strip()
    extra = getattr(message, "model_extra", None) or {}
    if isinstance(extra, dict):
        for key in ("reasoning_content", "reasoning"):
            val = extra.get(key)
            if val is not None and str(val).strip():
                return str(val).strip()
    return None


def _build_api_messages(
    messages: list[dict[str, str]],
    bootstrap_context: dict[str, Any] | None = None,
) -> list[dict[str, str]]:
    system_content = SYSTEM_PROMPT
    if bootstrap_context:
        system_content += _format_bootstrap_context(bootstrap_context)

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
    bootstrap_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    client = _client()
    model = os.getenv("LLM_MODEL", "local")

    api_messages = _build_api_messages(messages, bootstrap_context)
    payload_text = json.dumps(api_messages, ensure_ascii=False)
    est_tokens = _estimate_tokens(payload_text)
    gen = _generation_kwargs()

    log.info(
        "LLM request model=%s api_messages=%d est_prompt_tokens~%d frozen_bootstrap=%s generation=%s",
        model,
        len(api_messages),
        est_tokens,
        bootstrap_context is not None,
        json.dumps(gen, ensure_ascii=False),
    )
    log.debug("LLM full payload:\n%s", json.dumps(api_messages, indent=2, ensure_ascii=False))

    response = client.chat.completions.create(
        model=model,
        messages=api_messages,
        **gen,
    )
    choice_message = response.choices[0].message
    raw = (choice_message.content or "").strip()
    actions = _parse_actions(raw)
    message = _strip_json_block(raw) or raw
    reasoning = _extract_reasoning(choice_message)

    usage_dict = _usage_to_dict(getattr(response, "usage", None))
    if usage_dict:
        log.info(
            "LLM usage prompt_tokens=%s completion_tokens=%s total=%s",
            usage_dict.get("prompt_tokens", "?"),
            usage_dict.get("completion_tokens", "?"),
            usage_dict.get("total_tokens", "?"),
        )
        log.debug("LLM usage detail: %s", json.dumps(usage_dict, ensure_ascii=False))

    if reasoning:
        log.debug("LLM reasoning (%d chars):\n%s", len(reasoning), reasoning)

    log.info("LLM response chars=%d actions=%d", len(raw), len(actions))
    log.debug("LLM raw response:\n%s", raw)
    if actions:
        log.info("parsed actions: %s", json.dumps(actions, ensure_ascii=False))

    return {
        "message": message,
        "actions": actions,
        "usage": usage_dict or None,
        "reasoning": reasoning,
    }
