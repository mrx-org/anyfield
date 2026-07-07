# Chat assistant

Browser panel + FastAPI backend for the Anyfield sequence assistant (MRI Q&A, sequence select, parameter changes via structured actions).

| Path | Role |
|------|------|
| `chat_panel.js` | UI, frozen bootstrap, delta tracking, client agent loop |
| `chat_panel.css` | Panel styles |
| `backend/` | FastAPI + LLM proxy — [backend/README.md](backend/README.md) |

**Design (protocol, context, agent loop):** [insights/SPEC_chat_assistant.md](../insights/SPEC_chat_assistant.md)

**Runbook (env, API, logging):** [backend/README.md](backend/README.md)

**Security & threat model:** [SECURITY.md](SECURITY.md)

## Quick start

1. Start LLM (OpenAI-compatible, e.g. llama.cpp on `:8080/v1`, model alias `local`).
2. Backend: `cd chat/backend && source .venv/bin/activate && python main.py` → `:8765`
3. Anyfield: repo root `python -m http.server 8000` → header chat view (message bubble).

Hard-refresh the browser after pulling frontend changes.

## Client debug

- `window.ANYFIELD_CHAT_URL` — backend base URL (default `http://127.0.0.1:8765`)
- `window.ANYFIELD_CHAT_DEBUG = true` or `localStorage.anyfield_chat_debug = '1'` — log requests in DevTools

Status line: `backend ok` / `offline` (from `GET /health`).
