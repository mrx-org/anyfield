# Chat backend

FastAPI service for the Anyfield chat panel. Forwards chat + context to an OpenAI-compatible LLM and returns text plus optional **actions** for the browser.

Not the MRI simulation stack — only powers `../chat_panel.js`.

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

Open http://localhost:8000/ → header chat view (message bubble).

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `LLM_BASE_URL` | `http://127.0.0.1:8080/v1` | OpenAI-compatible base URL |
| `LLM_MODEL` | `local` | Model name (llama.cpp alias) |
| `LLM_API_KEY` | `local` | API key (local servers often ignore) |
| `CHAT_HOST` | `127.0.0.1` | Bind address |
| `CHAT_PORT` | `8765` | Bind port |
| `CORS_ORIGINS` | `http://localhost:8000,…` | Allowed Anyfield origins |
| `LOG_LEVEL` | `INFO` | Use `DEBUG` for full LLM I/O |
| `LOG_FILE` | `logs/chat.log` | Rotating log path |
| `LOG_MAX_BYTES` | `2097152` | Max log file size before rotation |
| `LOG_BACKUP_COUNT` | `3` | Rotated log copies to keep |

## API

### `GET /health`

```json
{"status": "ok", "service": "anyfield-chat-backend"}
```

### `POST /chat`

Request body: `messages`, `context` (see [SPEC_chat_assistant.md](../../insights/SPEC_chat_assistant.md)).

Response: `message`, optional `actions` (applied in browser via `runChatActions()`).

## Actions

| Type | Fields | Client |
|------|--------|--------|
| `select_sequence` | `file`, `function` | `selectSequenceByFileAndFunction` |
| `set_param` | `name`, `value` | `updateParamValue` |

## Logging

Full message list at INFO; LLM payload and raw output at DEBUG. Console + `logs/chat.log` (gitignored).

Browser debug: `window.ANYFIELD_CHAT_DEBUG = true` or `localStorage.anyfield_chat_debug = '1'`.
