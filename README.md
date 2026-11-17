# anyfield v4 (Studie)

Neubau von anyfield als UI-Schicht über den MRX-MCP-Tools des Gateways: kleine,
modulare UI-Tools (Phantom-Auswahl, FOV-Planer). Jedes läuft ohne Session (Ergebnis
zurück in den Chat), mit Session (Auswahl im Session-Zustand, geteilt mit Website und
KI) und auf der Website. Plan und Design: Linear
[MRX-71](https://linear.app/mrx-org/issue/MRX-71/studie-anyfield-redesign-v4-mit-mcp-state-server),
Leitbild [MRX-74](https://linear.app/mrx-org/issue/MRX-74/anyfield-modulare-ui-tools-auf-den-mrx-mcp-tools-session-optional).

Produktiv: `https://mrx-org--anyfield-web.us-east.modal.run` (MCP-Endpunkt `/mcp`).
Der Host ohne `us-east` ist ein Alias; Seiten leiten auf `us-east` um, denn nur
dort klappt der Login (Token-Audience, CORS bei AuthKit).

## Zugriff

| Was | Wie |
| -- | -- |
| Sessions auflisten, anlegen, umbenennen, löschen | Login über WorkOS AuthKit (GitHub oder E-Mail). Der Server verlangt ihn erst, wenn eines dieser Tools aufgerufen wird. |
| Alle anderen Tools | Ohne Login. Mit Session nur der Session-Key als Tool-Parameter `session_key`: Wer ihn kennt, darf die Session lesen und ändern; er lässt sich teilen. |

Web-App: `/` (eigene Sessions), `/s/{key}` (eine Session, mit Ansicht des Zustands-JSON).

## Tools

| Tool | Tools |
| -- | -- |
| Sessions (Login) | `list_sessions`, `create_session`, `rename_session`, `delete_session` |
| Zustand | `get_state`, `patch_state` (JSON Merge Patch) |
| FOV-Planer | `set_fov`, `move_fov`, `rotate_fov`, `open_fov_planner` |
| Phantom (BIfTI) | `list_phantom_collections`, `list_phantoms`, `select_phantom`, `set_phantom_property`, `get_phantom_maps`, `open_phantom_browser` |

Der Session-Zustand ist ein kleines JSON nur mit der Auswahl, keine Daten:

```json
{
  "phantom": { "collection": "endres-brainweb-001", "name": "subj04-3T-1mm.json" },
  "view": { "property": "T1" },
  "fov": { "center_mm": [0, 0, 10], "rotation_deg": [0, 0, 20], "size_mm": [220, 220, 60] },
  "matrix": [128, 128, 1]
}
```

`phantom: null` ist das eingebaute Standard-Phantom. Karten, Wertebereiche und
Ladezustand liefert `get_phantom_maps`; sie werden nicht gespeichert.

`open_*` zeigen in Clients mit MCP Apps das jeweilige Tool im Chat. Mit `session_key`
arbeitet es auf der Session; ohne wählt der Nutzer lokal, jede Änderung geht als
Kontext an das Modell (`updateModelContext`), „In den Chat“ schickt die Auswahl als
Nachricht. `select_phantom` geht auch ohne Session (prüft nur die Wahl). Die Website
zeigt unter `/s/{key}` beide Tools nebeneinander.

Den Phantom-Katalog liefern die bifti-Tools des MRX-Gateways (`bifti_list_collections`,
`bifti_list_phantoms`). Gateway-Aufrufe laufen mit Login als der Nutzer (Token Exchange
bei AuthKit), ohne Login als `visitor`. Die Phantome selbst lädt anyfield noch von Zenodo
(Paket `bifti`); das entfällt mit MRX-73. Beim ersten Gebrauch werden je Phantom
Anzeige-Karten berechnet (PD, T1, T2, T2′, ADC, dB0, B1±; dichtegewichtete Mittel
über die Gewebe) und auf dem Modal-Volume abgelegt; große Phantome auf höchstens
8 Mio. Voxel vergröbert.

## Aufbau

```
backend/   Python (uv), FastMCP, Modal
  src/anyfield/server.py     Tools, Routen
  src/anyfield/auth.py       Login (AuthKit) nur für Session-Verwaltung
  src/anyfield/gateway.py    Gateway-Tools im Namen des Nutzers (Token Exchange) oder als `visitor`
  src/anyfield/store.py      Modal Dict + Volume (Dict-Einträge verfallen nach 7 Tagen)
  src/anyfield/phantoms.py   BIfTI-Katalog, Anzeige-Karten (PhantomLibrary)
  src/anyfield/phantom_tools.py  Phantom-Tool
  src/anyfield/modal_app.py  Deployment
frontend/  Svelte 5, TypeScript, Vite, NiiVue
  src/lib/client/            Transport: MCP-HTTP (Web), MCP App, Mock
  src/lib/state/             Selection: SessionStore (Polling, optimistisch) oder LocalSelection
  src/lib/components/fov/    FOV-Planer (eigenständige Komponente)
  src/lib/components/phantom/  Phantom-Browser (eigenständige Komponente)
  src/web/                   Web-App
  src/mcp-app/               MCP Apps (je eine HTML-Datei, gemeinsame Hülle McpApp.svelte)
  dev/app-host.html          Test-Host für die MCP App
```

## Entwickeln

```sh
cd frontend && pnpm install && pnpm build      # dist/ wird vom Backend ausgeliefert
cd backend && uv run pytest                    # Tests
cd backend && uv run python -m anyfield        # Testserver im Speicher, ohne Login (Nutzer "dev")
cd frontend && pnpm dev                        # Web-App mit Hot Reload, Proxy auf den Testserver
# MCP App testen: http://localhost:5173/dev/app-host.html[?key=<session key>][&tool=open_phantom_browser]
```

Der Testserver ist nur für Tests und Frontend-Entwicklung; betrieben wird nur auf Modal.

## Deployment

Jeder Push auf `mcp-redesign` deployt nach Tests per GitHub Actions auf Modal
(Workspace mrx-org). Einmalig einzurichten:

1. WorkOS AuthKit (Umgebung Production): `<BASE_URL>/mcp` als Resource Indicator,
   `<BASE_URL>` als CORS-Origin (`workos authkit cors set …`, ersetzt die ganze Liste).
2. Modal-Secrets im Workspace mrx-org: `workos-anyfield` (`WORKOS_AUTHKIT_DOMAIN`,
   `WORKOS_CLIENT_ID`, `WORKOS_CLIENT_SECRET`) und `mrx-visitor` (`MRX_VISITOR_KEY`,
   mit dem Gateway geteilt).
3. Modal-Token für mrx-org als Repository-Secrets `MODAL_TOKEN_ID` und `MODAL_TOKEN_SECRET`.
