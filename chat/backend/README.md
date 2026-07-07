# Chat backend

FastAPI service for the Anyfield chat panel. Forwards chat history + frozen bootstrap context to an OpenAI-compatible LLM; returns text and optional **actions** for the browser agent loop.

Not the MRI simulation stack — only powers `../chat_panel.js`.

**Protocol & agent-loop design:** [insights/SPEC_chat_assistant.md](../../insights/SPEC_chat_assistant.md)

## Quick start

```bash
cd chat/backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python main.py
```

Service: **http://127.0.0.1:8765**

Anyfield (repo root):

```bash
python -m http.server 8000
```

Open http://localhost:8000/ → header chat view.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `LLM_BASE_URL` | `http://127.0.0.1:8080/v1` | OpenAI-compatible base URL |
| `LLM_MODEL` | `local` | Model name (llama.cpp alias) |
| `LLM_API_KEY` | `local` | API key (local servers often ignore) |
| `LLM_GENERATION` | `{"temperature": 0.3}` | JSON object forwarded to `chat.completions.create` (any API-supported keys) |
| `CHAT_HOST` | `127.0.0.1` | Bind address |
| `CHAT_PORT` | `8765` | Bind port |
| `ANYFIELD_FRONTEND_URL` | `http://localhost:8000` | Anyfield static app origin; default CORS allowlist when `CORS_ORIGINS` unset |
| `CORS_ORIGINS` | `{ANYFIELD_FRONTEND_URL},http://127.0.0.1:8000` | Comma-separated browser origins allowed to call `/chat` |
| `LOG_LEVEL` | `INFO` | Use `DEBUG` for full LLM I/O (`.env.example` ships `DEBUG`) |
| `LOG_FILE` | `logs/chat.log` | Rotating log path |
| `LOG_MAX_BYTES` | `2097152` | Max log file size before rotation |
| `LOG_BACKUP_COUNT` | `3` | Rotated log copies to keep |
| `CHAT_MAX_AGENT_LOOPS` | `3` | Max post-select agent rounds per user message (via `/health`) |

Edit prompts in `prompts.py` (`SYSTEM_PROMPT`, `AGENT_AFTER_SELECT`, `AGENT_FINAL_ANSWER`); restart backend to apply.

Tune generation via `LLM_GENERATION` JSON in `.env` (e.g. `max_tokens`, `top_p`, etc.).

## API

### `GET /health`

Panel init: backend reachability, agent loop limit, follow-up prompt templates.

```json
{
  "status": "ok",
  "frontend_url": "http://localhost:8000",
  "max_agent_loops": 3,
  "generation": {"temperature": 0.3},
  "agent_prompts": {
    "after_select": "…",
    "final_answer": "…"
  }
}
```

Client merges `agent_prompts` over built-in defaults when offline/unreachable.

### `POST /chat`

Request body:

- `messages` — full chat history (user + assistant turns sent to the LLM)
- `context` — **live** snapshot `{ selected, catalog, scanner }` (logging; `selected` in INFO logs is current UI state)
- `bootstrap_context` — **frozen** turn-1 `{ selected, catalog, scanner }` (re-sent every request; appended to the system prompt for KV-cache stability)
- `agent_meta` — optional client agent-loop metadata + `trace` (logging)

Response: `{ "message": "…", "actions": [ … ] }`. Actions are applied in the browser (`runChatActions` in `chat_panel.js`).

## Actions

| Type | Fields | Client |
|------|--------|--------|
| `select_sequence` | `file`, `function` | `seqExplorer.selectSequenceByFileAndFunction` |
| `set_param` | `name`, `value` | `seqExplorer.updateParamValue` |

## Logging

At INFO: each POST logs live `selected`, frozen-bootstrap flag, context-update presence, last user message, agent trace when present.

At DEBUG: turn-1 bootstrap JSON; full LLM request payload and raw response.

Console + `logs/chat.log` (gitignored). Warns if turn 2+ arrives without `bootstrap_context`.

Browser debug: `window.ANYFIELD_CHAT_DEBUG = true` or `localStorage.anyfield_chat_debug = '1'`.
