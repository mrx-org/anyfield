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

from llm import chat_completion
from log_config import setup_logging

load_dotenv()
log = setup_logging()

app = FastAPI(title="Anyfield Chat Backend", version="0.0.1")

_cors_origins = os.getenv(
    "CORS_ORIGINS",
    "http://localhost:8000,http://127.0.0.1:8000",
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _cors_origins if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatMessage(BaseModel):
    role: str = "user"
    content: str


class ChatContext(BaseModel):
    model_config = ConfigDict(extra="ignore")

    selected: dict[str, Any] | None = None
    sequence_catalog: list[dict[str, Any]] = Field(default_factory=list)
    phantom: dict[str, Any] | None = None
    pyodide_ready: bool = False
    state_changed: bool = True


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    context: ChatContext = Field(default_factory=ChatContext)


class ChatResponse(BaseModel):
    message: str
    actions: list[dict[str, Any]] = Field(default_factory=list)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "anyfield-chat-backend"}


@app.post("/chat", response_model=ChatResponse)
def chat(req: ChatRequest) -> ChatResponse:
    ctx = req.context.model_dump()
    log.info(
        "POST /chat turns=%d pyodide_ready=%s selected=%s catalog=%d state_changed=%s",
        len(req.messages),
        req.context.pyodide_ready,
        (req.context.selected or {}).get("function"),
        len(req.context.sequence_catalog),
        req.context.state_changed,
    )
    log.info("chat request messages:\n%s", json.dumps([m.model_dump() for m in req.messages], indent=2, ensure_ascii=False))
    log.debug("chat request context:\n%s", json.dumps(ctx, indent=2, ensure_ascii=False))

    try:
        result = chat_completion(
            [m.model_dump() for m in req.messages],
            ctx,
        )
    except Exception as exc:
        log.exception("LLM request failed")
        raise HTTPException(status_code=502, detail=f"LLM request failed: {exc}") from exc

    log.info("chat response message=%r actions=%s", result.get("message", "")[:120], result.get("actions"))
    return ChatResponse(**result)


if __name__ == "__main__":
    host = os.getenv("CHAT_HOST", "127.0.0.1")
    port = int(os.getenv("CHAT_PORT", "8765"))
    uvicorn.run("main:app", host=host, port=port, reload=True)
