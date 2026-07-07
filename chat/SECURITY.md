# Chat assistant — security & threat model

This document covers the Anyfield sequence assistant (`chat/` + `chat/backend/`). It is intended for **local/demo** use alongside the static Anyfield app and a trusted local LLM.

## Trust boundaries

| Component | Trust level | Notes |
|-----------|-------------|--------|
| Anyfield static app (`ANYFIELD_FRONTEND_URL`) | Trusted | Same origin as the chat panel |
| Chat backend (`:8765`) | Trusted local service | Forwards history to the LLM; no auth in default setup |
| Local LLM | Semi-trusted | Can emit natural language **and** structured `actions` |
| Assistant markdown output | Semi-trusted | Rendered as HTML in the browser (see below) |
| User chat input | Untrusted text | Rendered with `textContent` only — no HTML |
| System / “Applied” lines | Trusted UI | Plain text from the client |

The **primary control plane** is JSON **actions** (`select_sequence`, `set_param`), not markdown. A compromised or malicious model can change protocols regardless of markdown sanitization.

## Deployment assumptions

- Browser and backend run on **localhost** (or a controlled network).
- **No multi-tenant** or public internet exposure in the default configuration.
- Operators choose the LLM and backend URL (`window.ANYFIELD_CHAT_URL`, `LLM_*` env).
- CORS allows only configured frontend origins (`ANYFIELD_FRONTEND_URL` / `CORS_ORIGINS`).

If you expose the chat backend or render untrusted markdown to other users, treat this as **high risk** and add authentication, origin lockdown, and a stricter content policy.

## CORS & origins

- `ANYFIELD_FRONTEND_URL` — static Anyfield app origin (default `http://localhost:8000`).
- `CORS_ORIGINS` — comma-separated list allowed to call `POST /chat` (defaults to `{ANYFIELD_FRONTEND_URL},http://127.0.0.1:8000`).
- `GET /health` exposes `frontend_url` for verification.

The chat **backend** URL (`http://127.0.0.1:8765`) is separate; the panel uses `window.ANYFIELD_CHAT_URL` or the built-in default.

## Assistant markdown rendering

Only **assistant** bubbles (visible final replies) use HTML rendering:

1. **marked** — GFM markdown → HTML.
2. **DOMPurify** — sanitize marked output.
3. **KaTeX auto-render** — `$…$`, `$$…$$`, `\(...\)`, `\[...\]` with `trust: false`.
4. **DOMPurify again** — sanitize final DOM; `ADD_ATTR` keeps KaTeX layout attrs (`class`, `style`, `aria-*`, `xmlns`, `encoding`).

User messages, system lines, and errors use `textContent`.

Compared with a single sanitize pass and raw `innerHTML`, the second pass re-checks the full tree after KaTeX mutates the DOM. `trust: false` blocks KaTeX `\href{javascript:…}`. Residual risk: `style` is allowed on any surviving node in pass 2 (acceptable for local demo; tighten with a KaTeX-only hook later if needed).

### Residual markdown risks (low in default setup)

| Risk | Mitigation | Residual |
|------|------------|----------|
| HTML/script injection from LLM | DOMPurify before and after KaTeX | Low |
| KaTeX `\href{javascript:…}` | `trust: false` | Low |
| CSS via `style` on non-KaTeX nodes | Pass 2 allows `style` globally | Low–moderate (demo) |
| CDN supply chain (esm.run) | Pinned import URLs | Moderate if CDN compromised |

**Do not** reuse this pipeline for arbitrary user-supplied markdown or third-party content without a stronger policy (CSP, subresource integrity, pinned local bundles, no actions).

## Protocol actions

Parsed from a fenced JSON block in the model reply:

- `select_sequence` — changes active sequence in `seqExplorer`
- `set_param` — updates parameter values

Unknown types are dropped client-side. Params must exist on the current sequence schema.

A malicious model can emit valid actions that change sequences/parameters. Operators should treat LLM output like **automation input**, not display-only text.

## Logging

Backend logs full message payloads at INFO/DEBUG (`chat/backend/logs/chat.log`). Logs may contain phantom JSON, protocol state, and user text. Restrict file permissions and retention in shared environments.

## Related docs

- [chat/README.md](README.md) — layout & quick start  
- [backend/README.md](backend/README.md) — env & API  
- [insights/SPEC_chat_assistant.md](../insights/SPEC_chat_assistant.md) — protocol design  
