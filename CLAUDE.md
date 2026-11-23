# anyfield v4

Neubau von anyfield als Studie. Ziel, Plan und Design-Docs stehen im Linear-Issue **MRX-71**:
https://linear.app/mrx-org/issue/MRX-71/studie-anyfield-redesign-v4-mit-mcp-state-server

- Vor der Arbeit das Issue und die angehängten Docs lesen. Sie sind Living Documents.
- Grundlegende Änderungen an Ziel, Architektur oder Plan als Kommentar im Issue begründen.
- v3 liegt unverändert auf `main`.

## Commits

- Jede Commit-Message folgt **Conventional Commits** (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `ci:` …, optional mit Scope, z. B. `feat(server): …`).
- `Refs MRX-71` (letzte Zeile) nur bei Commits, die ein Feature bzw. einen Punkt aus dem Issue fertigstellen. Normale Zwischen-Commits ohne Referenz.

## Arbeiten im Repo

- Aufbau, Befehle und Deployment: siehe `README.md`.
- Vor jedem Commit: `pnpm check && pnpm test` (frontend), `uv run ruff check src tests && uv run ruff format --check src tests && uv run pytest` (backend).
- Betrieb nur auf Modal; `python -m anyfield` ist nur ein Testserver.
- UI lokal testen (auch Phantom-Selektor mit Gateway-Aufrufen): kein Deploy, kein OAuth. Erster Tipp: persönlichen Gateway-API-Key (`https://mcp.anyfield.net/keys`) als `MRX_VISITOR_KEY` setzen, `uv run -m anyfield` + `pnpm dev`, dann `/dev/app-host.html?tool=open_phantom_browser`. Den echten Visitor-Key nicht rotieren (siehe README, „Entwickeln“).
- Komponenten sprechen nie direkt MCP, sondern über `Transport`/`AnyfieldClient` und hängen an einer `Selection` (`SessionStore` oder `LocalSelection`), nie direkt an einer Session.
- anyfield ist nur UI: Daten und Rechnen liegen bei den MRX-MCP-Tools des Gateways (`GatewayClient`). Der Session-Zustand enthält nur die Auswahl.
- Ändert sich die Form gespeicherter Sessions (Feld entfällt, umbenannt, verschoben): `SCHEMA_VERSION` erhöhen und einen Schritt in `backend/src/anyfield/migrations.py` anlegen (rohes JSON, nie die Modelle), mit Test. Keine Lese-Kompatibilität in Modellen oder Tools. Veröffentlichte Schritte nie ändern. Details: README, „Session-Schema und Migrationen“.
- UI: Bausteine aus Skeleton nehmen statt selbst zu basteln. Icons **immer** aus Lucide (`@lucide/svelte`, Import je Icon über `@lucide/svelte/icons/<name>`), nie Unicode-Zeichen oder eigene SVGs.
