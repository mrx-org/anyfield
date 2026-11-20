# anyfield v4 (Studie)

Neubau von anyfield als UI-Schicht über den MRX-MCP-Tools des Gateways: kleine,
modulare UI-Tools (Phantom-Auswahl, FOV-Planer). Jedes läuft ohne Session (Ergebnis
zurück in den Chat), mit Session (Auswahl im Session-Zustand, geteilt mit Website und
KI) und auf der Website. Plan und Design: Linear
[MRX-71](https://linear.app/mrx-org/issue/MRX-71/studie-anyfield-redesign-v4-mit-mcp-state-server),
Leitbild [MRX-74](https://linear.app/mrx-org/issue/MRX-74/anyfield-modulare-ui-tools-auf-den-mrx-mcp-tools-session-optional).

Produktiv: `https://app.anyfield.net` (Website, Login, MCP-Endpunkt `/mcp`;
Env `ANYFIELD_PUBLIC_URL`), auf Modal in Region eu-west. Ein Cloudflare Worker leitet
die Domain an die modal.run-URL weiter (die der Deploy meldet) und setzt
`X-Original-Host: app.anyfield.net`; daraus nimmt der Server den öffentlichen Host
(Modal verwirft `X-Forwarded-Host`/`-Proto`; `X-Forwarded-Host` wird gelesen, wo er ankommt). Seiten, die für
einen anderen Host angefragt werden (z. B. direkt modal.run), leiten auf
`app.anyfield.net` um, denn nur dort klappt der Login (Token-Audience, CORS bei AuthKit).
Das MRX-Gateway liegt unter `https://mcp.anyfield.net/mcp`; Tokens dafür tauscht
anyfield mit `resource=https://mcp.anyfield.net/mcp`.

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
| Phantom (BIfTI) | `list_phantom_collections`, `list_phantoms`, `select_phantom`, `set_phantom_view`, `get_phantom_maps`, `open_phantom_browser`, `open_phantom_preview` |

Der Session-Zustand ist ein kleines JSON nur mit der Auswahl, keine Daten:

```json
{
  "phantom": { "collection": "endres-brainweb-001", "name": "subj04-3T-1mm.json" },
  "view": { "property": "T1", "plane": "tra" },
  "fov": { "center_mm": [0, 0, 10], "rotation_deg": [0, 0, 20], "size_mm": [220, 220, 60] },
  "matrix": [128, 128, 1]
}
```

`phantom: null` ist das Standard-Phantom `endres-brainweb-001` / `subj04-3T-1mm.json`
(vom Gateway wie jedes andere). Karten und Wertebereiche liefert `get_phantom_maps`;
sie werden nicht gespeichert. `view` ist die Ansicht der Phantom-Vorschau (Eigenschaft;
Ebene `tra`, `cor`, `sag` oder `3d`); der FOV-Planer zeigt vorerst immer PD.

`open_*` zeigen in Clients mit MCP Apps das jeweilige Tool im Chat. Mit `session_key`
arbeitet es auf der Session; ohne wählt der Nutzer lokal, jede Änderung geht als
Kontext an das Modell (`updateModelContext`), „In den Chat“ schickt die Auswahl als
Nachricht. `select_phantom` geht auch ohne Session (prüft nur die Wahl). Die Website
zeigt unter `/s/{key}` beide Tools nebeneinander.

Tools lassen sich verschachteln: Der Phantom-Browser enthält die Phantom-Vorschau
(`open_phantom_preview`) zum Aufklappen. Zugeklappt (Standard, pro Gerät) wird sie nicht
gerendert und lädt keine Karten; so lässt sich das Phantom einer Session z. B. vom Handy
aus wechseln, ohne es dort zu laden.

anyfield hält keine Phantomdaten. Katalog und Karten liefern die bifti-Tools des
MRX-Gateways (`bifti_list_collections`, `bifti_list_phantoms`,
`bifti_get_property_maps`). Gateway-Aufrufe laufen mit Login als der Nutzer (Token
Exchange bei AuthKit), ohne Login als `visitor`. Die Karten (PD, T1, T2, T2′, ADC, dB0,
B1±; über die Gewebe kombiniert) sind NIfTIs unter `<gateway>/files/<hash>`, die Browser
und MCP Apps ohne Login laden. Mit `fov` und `matrix` liefert `get_phantom_maps` die
Karten auf dem geplanten Scan-Raster (Reslicing); das FOV wird dafür aus dem
Scanner-Rahmen der Karten in den RAS+-Rahmen des Phantoms zurückgedreht. Der FOV-Planer
zeigt so eine Vorschau „Im Scan-Raster“.

## Aufbau

```
backend/   Python (uv), FastMCP, Modal
  src/anyfield/server.py     Tools, Routen
  src/anyfield/auth.py       Login (AuthKit) nur für Session-Verwaltung
  src/anyfield/gateway.py    Gateway-Tools im Namen des Nutzers (Token Exchange) oder als `visitor`
  src/anyfield/store.py      Modal Dict + Volume (Dict-Einträge verfallen nach 7 Tagen)
  src/anyfield/phantoms.py   Katalog und Karten vom Gateway, FOV → Scan-Raster
  src/anyfield/phantom_tools.py  Phantom-Tool
  src/anyfield/modal_app.py  Deployment
frontend/  Svelte 5, TypeScript, Vite, NiiVue, Skeleton (UI), Lucide (Icons)
  src/lib/client/            Transport: MCP-HTTP (Web), MCP App, Mock
  src/lib/state/             Selection: SessionStore (Polling, optimistisch) oder LocalSelection
  src/lib/components/fov/    FOV-Planer (eigenständige Komponente)
  src/lib/components/phantom/  Phantom-Browser und Phantom-Vorschau (eigenständige Komponenten)
  src/web/                   Web-App
  src/mcp-app/               MCP Apps (je eine HTML-Datei, gemeinsame Hülle McpApp.svelte)
  dev/app-host.html          Test-Host für die MCP App
```

UI-Bausteine kommen aus Skeleton (`@skeletonlabs/skeleton-svelte`), Icons **immer** aus
Lucide (`@lucide/svelte`, je Icon importiert: `import ChevronRight from
"@lucide/svelte/icons/chevron-right"`). Keine Unicode-Zeichen oder eigenen SVGs als Icons.

## Entwickeln

```sh
cd frontend && pnpm install && pnpm build      # dist/ wird vom Backend ausgeliefert (auch die MCP Apps)
cd backend && uv run pytest                    # Tests
cd backend && uv run -m anyfield               # Testserver im Speicher, ohne Login (Nutzer "dev")
cd frontend && pnpm dev                        # Web-App mit Hot Reload, Proxy auf den Testserver
# MCP App testen: http://localhost:5173/dev/app-host.html[?key=<session key>][&tool=open_phantom_browser|open_phantom_preview]
```

Der Testserver ist nur für Tests und Frontend-Entwicklung; betrieben wird nur auf Modal.
Phantom-Katalog und Karten gibt es dort nur mit `MRX_VISITOR_KEY` in der Umgebung
(Aufrufe ans echte Gateway). Lokal kein OAuth und keinen eigenen Visitor-Key nötig:
einfach den **persönlichen API-Key** des Gateways eintragen (einmal angezeigt, erzeugen
unter `https://mcp.anyfield.net/keys`). Der Server schickt ihn als Bearer-Token, die
Gateway-Aufrufe laufen dann als du statt als `visitor`:

```powershell
$env:MRX_VISITOR_KEY = "mrx_..."   # sh: export MRX_VISITOR_KEY=mrx_...
cd backend; uv run -m anyfield
```

Den echten Visitor-Key (Modal-Secret `mrx-visitor`) nicht dafür rotieren: Gateway und
anyfield teilen ihn, ein neuer Wert braucht einen Deploy beider Apps.

pnpm fehlt (Node ≥ 25 hat kein Corepack mehr): `npm install -g pnpm@10.28.0`.

## Deployment

Jeder Push auf `mcp-redesign` deployt nach Tests per GitHub Actions auf Modal
(Workspace mrx-org). Einmalig einzurichten:

1. Cloudflare Worker für `app.anyfield.net` auf die modal.run-URL aus dem Deploy-Log
   (steht auch in der Job-Zusammenfassung).
2. WorkOS AuthKit (Umgebung Production): `https://app.anyfield.net/mcp` als Resource
   Indicator, `https://app.anyfield.net` als CORS-Origin (`workos authkit cors set …`,
   ersetzt die ganze Liste).
3. Modal-Secrets im Workspace mrx-org: `workos-anyfield` (`WORKOS_AUTHKIT_DOMAIN`,
   `WORKOS_CLIENT_ID`, `WORKOS_CLIENT_SECRET`) und `mrx-visitor` (`MRX_VISITOR_KEY`,
   mit dem Gateway geteilt).
4. Modal-Token für mrx-org als Repository-Secrets `MODAL_TOKEN_ID` und `MODAL_TOKEN_SECRET`.
