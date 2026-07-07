"""Anyfield chat backend — thin FastAPI wrapper around an OpenAI-compatible LLM."""

from __future__ import annotations

import json
import os
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field
import uvicorn

from llm import chat_completion, generation_kwargs
from log_config import setup_logging

load_dotenv()
log = setup_logging()

app = FastAPI(title="Anyfield Chat Backend", version="0.0.2")

_default_frontend = os.getenv("ANYFIELD_FRONTEND_URL", "http://localhost:8000").rstrip("/")
_default_cors = os.getenv(
    "CORS_ORIGINS",
    f"{_default_frontend},http://127.0.0.1:8000",
)
_cors_origins = _default_cors.split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _cors_origins if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_BLOCK_MARKERS = (
    ("[Anyfield context update]", "context_update"),
)


class ChatMessage(BaseModel):
    role: str = "user"
    content: str


class ChatContext(BaseModel):
    model_config = ConfigDict(extra="ignore")
    selected: dict[str, Any] | None = None
    catalog: list[dict[str, Any]] = Field(default_factory=list)
    scanner: dict[str, Any] | None = None


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    context: ChatContext = Field(default_factory=ChatContext)
    bootstrap_context: ChatContext | None = None
    agent_meta: dict[str, Any] | None = None


class ChatResponse(BaseModel):
    message: str
    actions: list[dict[str, Any]] = Field(default_factory=list)


def _blocks_in_message(content: str) -> list[str]:
    blocks = []
    for marker, name in _BLOCK_MARKERS:
        if marker in content:
            blocks.append(name)
    return blocks


def _normalize_context(ctx: dict[str, Any] | None) -> dict[str, Any]:
    raw = ctx or {}
    return {
        "selected": raw.get("selected"),
        "catalog": raw.get("catalog") or [],
        "scanner": raw.get("scanner"),
    }


def _bootstrap_for_request(
    live_ctx: dict[str, Any],
    bootstrap_raw: dict[str, Any] | None,
    turns: int,
) -> dict[str, Any] | None:
    if bootstrap_raw:
        return _normalize_context(bootstrap_raw)
    if turns <= 1:
        return _normalize_context(live_ctx)
    return None


@app.get("/health")
def health() -> dict[str, Any]:
    from prompts import AGENT_AFTER_SELECT, AGENT_FINAL_ANSWER

    return {
        "status": "ok",
        "frontend_url": _default_frontend,
        "max_agent_loops": int(os.getenv("CHAT_MAX_AGENT_LOOPS", "3")),
        "generation": generation_kwargs(),
        "agent_prompts": {
            "after_select": AGENT_AFTER_SELECT,
            "final_answer": AGENT_FINAL_ANSWER,
        },
    }


@app.post("/chat", response_model=ChatResponse)
def chat(req: ChatRequest) -> ChatResponse:
    ctx = _normalize_context(req.context.model_dump())
    turns = len(req.messages)
    last = req.messages[-1].content if req.messages else ""
    blocks = _blocks_in_message(last)
    bootstrap_ctx = _bootstrap_for_request(
        ctx,
        req.bootstrap_context.model_dump() if req.bootstrap_context else None,
        turns,
    )

    if turns == 1:
        log.debug(
            "bootstrap context (turn 1):\n%s",
            json.dumps(bootstrap_ctx or ctx, indent=2, ensure_ascii=False),
        )
    if turns > 1 and not req.bootstrap_context:
        log.warning("turn %d without bootstrap_context", turns)
    log.info(
        "POST /chat turns=%d frozen_bootstrap=%s context_update=%s catalog=%d selected=%s scanner=%s",
        turns,
        req.bootstrap_context is not None,
        "context_update" in blocks,
        len(ctx.get("catalog") or []),
        (ctx.get("selected") or {}).get("function"),
        bool(ctx.get("scanner")),
    )
    if req.agent_meta:
        log.info(
            "agent meta phase=%s loop=%s applied=%s",
            req.agent_meta.get("phase"),
            req.agent_meta.get("loop"),
            req.agent_meta.get("applied"),
        )
        trace = req.agent_meta.get("trace")
        if trace:
            log.info("agent trace (%d steps):\n%s", len(trace), json.dumps(trace, indent=2, ensure_ascii=False))
    log.info(
        "last chat request message:\n%s",
        json.dumps([req.messages[-1].model_dump()], indent=2, ensure_ascii=False),
    )

    try:
        result = chat_completion(
            [m.model_dump() for m in req.messages],
            bootstrap_context=bootstrap_ctx,
        )
    except Exception as exc:
        log.exception("LLM request failed")
        raise HTTPException(status_code=502, detail=f"LLM request failed: {exc}") from exc

    log.info(
        "chat response message=%r actions=%s",
        result.get("message", "")[:120],
        result.get("actions"),
    )
    return ChatResponse(**result)


if __name__ == "__main__":
    host = os.getenv("CHAT_HOST", "127.0.0.1")
    port = int(os.getenv("CHAT_PORT", "8765"))
    uvicorn.run("main:app", host=host, port=port, reload=True)
