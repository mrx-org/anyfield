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
Browser (chat/chat_panel.js)
  ──GET /health──►  max_agent_loops, agent_prompts
  ──POST /chat──►   chat/backend  ──OpenAI API──►  local LLM (:8080)
       │
       └── runChatActions ──► seqExplorer (select_sequence, set_param)
```

## UI

Fourth header view (message bubble): full-width chat panel in `slot-main`. Planning, compare, and sequence plot modes unchanged.

Integration: `index.html` `ViewManager` — `chat` mode, header button, `initChatPanel`. While in chat view, incidental `setMode('planning')` from the Niivue sidebar is blocked unless the user clicks a header view button (`_viewModeExplicit`).

Debug:

- `window.ANYFIELD_CHAT_URL` — backend URL override
- `window.ANYFIELD_CHAT_DEBUG = true` or `localStorage.anyfield_chat_debug = '1'` — log requests in DevTools

Status line: `backend ok` / `offline`.

## Context (KV-cache friendly)

| Layer | Content |
|-------|---------|
| System | `SYSTEM_PROMPT` + **frozen** JSON `{ selected, catalog, scanner }` from turn 1 (`bootstrap_context` on every POST) |
| User | Plain text; optional `[Anyfield context update]` + JSON delta when catalog, scanner, or selected changed |
| Silent updates | Same delta format after agent actions — appended to history, not shown as a user bubble |

**`selected`** includes `file`, `function`, `label`, and `params`: an array of `{ name, type, value }` (current or default values, types coerced client-side when the UI reports unknown types).

**`scanner`** includes `name`, `B0_T`, `gyro_MHz_T`, and `physics`:

- `larmor_MHz`, `fat_water_delta_hz`, `opposed_phase_te_s`
- `tissues_s` — per-tissue T1/T2 (seconds)
- `ir_null_ti_s` — IR null time per tissue (= T1 × ln 2); see `physics.legend`

Client tracks fingerprints (`modelKnown`); deltas cover catalog add/remove, scanner replace, selected replace.

POST `context` carries the **live** snapshot (backend INFO logs use this for `selected`). POST `bootstrap_context` carries the **frozen** turn-1 snapshot (system prompt only).

## Agent loop

Per user message, the client runs hidden LLM turns (`internal: true`) and shows **one** assistant bubble at the end.

1. Initial turn (plain user text; turn 1 also freezes bootstrap).
2. If the model returns actions:
   - Apply `select_sequence` first.
   - If the same batch includes `set_param`: push a silent context update, apply params, push another update, stop looping.
   - If select-only: prepend a context delta to the `after_select` follow-up (from `/health` / `prompts.py`), call the model again; repeat until no actions or `CHAT_MAX_AGENT_LOOPS` (default 3, from `/health`).
   - Param-only batch: apply params, silent context update, stop looping.
3. If any actions were applied: one `final_answer` turn (template from `/health` / `prompts.py`) for the visible summary.

System lines (`Applied: …`) show what the client executed; they are not sent to the model as user text.

`set_param` is rejected if the name is not on the current sequence. Unknown action types are dropped client-side.

Configure loop depth via `CHAT_MAX_AGENT_LOOPS` in `chat/backend/.env`. Edit follow-up templates in `prompts.py` (`AGENT_AFTER_SELECT`, `AGENT_FINAL_ANSWER`); restart backend.

Tune LLM sampling via `LLM_GENERATION` JSON in `.env` (passed through to the OpenAI-compatible API; exposed read-only on `/health` as `generation`).

Assistant replies render as Markdown in the panel (`marked` + KaTeX for `$…$` / `$$…$$` math; same stack as Credits for prose).

## Actions

| Type | Fields | Client |
|------|--------|--------|
| `select_sequence` | `file`, `function` | `seqExplorer.selectSequenceByFileAndFunction` |
| `set_param` | `name`, `value` | `seqExplorer.updateParamValue` |

No auto-plot / execute.

## Logging

Backend (`chat/backend/.env`, default `LOG_LEVEL=INFO`):

- INFO: live context per POST, agent `agent_meta` + trace, last user message
- DEBUG: turn-1 bootstrap JSON, full LLM payload and raw response
- Warns if turn 2+ POST lacks `bootstrap_context`

Log file: `chat/backend/logs/chat.log` (gitignored).

Runbook: [chat/backend/README.md](../chat/backend/README.md).

## Local dev

1. LLM on `http://127.0.0.1:8080/v1`, model alias `local`
2. `cd chat/backend && python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && cp .env.example .env && python main.py`
3. Repo root: `python -m http.server 8000` → header chat view (hard-refresh after frontend changes)

Index: [chat/README.md](../chat/README.md).
