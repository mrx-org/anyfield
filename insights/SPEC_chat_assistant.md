# Chat assistant

Optional LLM-backed chat for Anyfield: answer MRI questions and adjust sequences/parameters via structured **actions**. FOV stays human-controlled; simulation stays on the existing toolapi pipeline.

## Layout

```
chat/
  chat_panel.js      # browser UI, context builder, action runner
  chat_panel.css
  README.md
  backend/           # FastAPI on :8765
    main.py
    llm.py
    prompts.py
    log_config.py
    requirements.txt
    .env.example
    README.md
```

## Architecture

```
Browser (chat/chat_panel.js)  ─POST /chat►  chat/backend  ─OAI API►  local LLM (:8080)
       │
       └── runChatActions ──► seqExplorer (select_sequence, set_param)
```

Backend forwards `messages` verbatim (no server-side state injection). System prompt carries catalog + phantom; state lives in user messages only.

## UI

Fourth header view (message bubble): full-width chat panel in `slot-main`. Planning, compare, and sequence plot modes unchanged.

Integration: `index.html` `ViewManager` — `chat` mode, header button, `initChatPanel`. While in chat view, incidental `setMode('planning')` from the Niivue sidebar is blocked unless the user clicks a header view button (`_viewModeExplicit`).

Debug:

- `window.ANYFIELD_CHAT_URL` — backend URL override
- `window.ANYFIELD_CHAT_DEBUG = true` or `localStorage.anyfield_chat_debug = '1'` — log requests in DevTools

## Context sent to LLM

| Layer | Content |
|-------|---------|
| System | Instructions, sequence catalog (`file:function` per line), phantom JSON, `pyodide_ready` |
| User messages | Plain text, plus `[Anyfield state]` only on **new** messages when selection or params changed since the last snapshot |
| History | Never rewritten — append-only for KV-cache-friendly prefixes |

`[Anyfield state]` JSON shape: `{ "selected": { "file", "function", "label", "params" } }`.

After chat actions mutate params/selection, the next user message gets a fresh snapshot automatically (`lastSentStateFingerprint` is not updated by actions).

Client also sends `context` each request: `selected`, `sequence_catalog`, `phantom`, `pyodide_ready`, `state_changed` (logging; backend does not inject from it).

Model rule: use param names from the **most recent** `[Anyfield state]` block.

## Actions

| Type | Fields | Client |
|------|--------|--------|
| `select_sequence` | `file`, `function` | `seqExplorer.selectSequenceByFileAndFunction` |
| `set_param` | `name`, `value` | `seqExplorer.updateParamValue` |

Unknown action types are dropped client-side. No auto-plot / execute.

## Logging

Backend: full message list at INFO; full LLM payload at DEBUG (`LOG_LEVEL=DEBUG` in `chat/backend/.env` → `logs/chat.log`, gitignored).

## Local dev

1. LLM on `http://127.0.0.1:8080/v1`, model alias `local`
2. `cd chat/backend && python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && cp .env.example .env && python main.py`
3. Repo root: `python -m http.server 8000` → header chat view

Runbook: [chat/backend/README.md](../chat/backend/README.md).
