# anyfield v4 (Studie)

Neubau von anyfield: Ein MCP-Server auf Modal hält den Zustand jeder Session.
Browser, MCP App und KI ändern ihn über dieselben Tools. Plan und Design:
Linear [MRX-71](https://linear.app/mrx-org/issue/MRX-71/studie-anyfield-redesign-v4-mit-mcp-state-server).

Produktiv: `https://mrx-org--anyfield-web.modal.run` (MCP-Endpunkt `/mcp`).

## Zugriff

| Was | Wie |
| -- | -- |
| Sessions auflisten, anlegen, umbenennen, löschen | GitHub-Login (OAuth). Der Server verlangt ihn erst, wenn eines dieser Tools aufgerufen wird. |
| Alle anderen Tools | Nur der Session-Key als Tool-Parameter `session_key`. Wer ihn kennt, darf die Session lesen und ändern; er lässt sich teilen. |

Web-App: `/` (eigene Sessions), `/s/{key}` (eine Session).

## Tools

`list_sessions`, `create_session`, `rename_session`, `delete_session` (Login) ·
`get_session`, `set_fov`, `move_fov`, `rotate_fov`, `open_fov_planner` (Session-Key).
`open_fov_planner` zeigt in Clients mit MCP Apps den FOV-Planer im Chat.

## Aufbau

```
backend/   Python (uv), FastMCP, Modal
  src/anyfield/server.py     Tools, Routen
  src/anyfield/auth.py       GitHub-OAuth nur für Session-Verwaltung
  src/anyfield/store.py      Modal Dict + Volume (Dict-Einträge verfallen nach 7 Tagen)
  src/anyfield/modal_app.py  Deployment
frontend/  Svelte 5, TypeScript, Vite, NiiVue
  src/lib/client/            Transport: MCP-HTTP (Web), MCP App, Mock
  src/lib/state/             SessionStore: Polling, optimistische Änderungen
  src/lib/components/fov/    FOV-Planer (eigenständige Komponente)
  src/web/                   Web-App
  src/mcp-app/               MCP App (eine HTML-Datei)
  dev/app-host.html          Test-Host für die MCP App
```

## Entwickeln

```sh
cd frontend && pnpm install && pnpm build      # dist/ wird vom Backend ausgeliefert
cd backend && uv run pytest                    # Tests
cd backend && uv run python -m anyfield        # Testserver im Speicher, ohne Login (Nutzer "dev")
cd frontend && pnpm dev                        # Web-App mit Hot Reload, Proxy auf den Testserver
# MCP App testen: http://localhost:5173/dev/app-host.html?key=<session key>
```

Der Testserver ist nur für Tests und Frontend-Entwicklung; betrieben wird nur auf Modal.

## Deployment

Jeder Push auf `mcp-redesign` deployt nach Tests per GitHub Actions auf Modal
(Workspace mrx-org). Einmalig einzurichten:

1. GitHub-OAuth-App in der mrx-org anlegen, Callback-URL
   `https://mrx-org--anyfield-web.modal.run/auth/callback`.
2. Modal-Secret im Workspace mrx-org:
   `modal secret create gh_oauth GITHUB_OAUTH_CLIENT_ID=… GITHUB_OAUTH_CLIENT_SECRET=…`
3. Modal-Token für mrx-org als Repository-Secrets `MODAL_TOKEN_ID` und `MODAL_TOKEN_SECRET`.
