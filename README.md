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
| Zustand | `get_state`, `patch_state` (JSON Merge Patch), `open_session` (JSON-Editor) |
| Dateien | `list_user_files`, `create_file_upload_url`, `open_file_upload`, `open_file_list`, `open_file_manager` |
| FOV-Planer | `set_fov`, `move_fov`, `rotate_fov`, `open_fov_planner`, `open_fov_viewer` |
| Phantom (BIfTI) | `list_phantom_collections`, `list_phantoms`, `list_phantom_tissues`, `select_phantom`, `set_phantom_property`, `get_phantom_maps`, `open_phantom_browser`, `open_phantom_preview` |

Der Session-Zustand ist ein kleines JSON nur mit der Auswahl, keine Daten:

```json
{
  "phantom": { "collection": "endres-brainweb-001", "name": "subj04-3T-1mm.json" },
  "tissues": ["GM", "WM"],
  "view": { "property": "T1" },
  "fov": { "center_mm": [0, 0, 10], "rotation_deg": [0, 0, 20], "size_mm": [220, 220, 60] },
  "matrix": [128, 128, 1]
}
```

`phantom: null` ist das Standard-Phantom `endres-brainweb-001` / `subj04-3T-1mm.json`
(vom Gateway wie jedes andere). Statt eines Katalog-Phantoms `{collection, name}` kann
`phantom` auch ein Phantom im CAS des Gateways sein: `{"sha256": "<hash>", "name": "x.zip"}`
(ein bifti-`.zip`, hochgeladen oder von `bifti_get_phantom`). Der Hash ist die Berechtigung:
Wer eine Session mit einem CAS-Phantom geteilt bekommt, sieht es, auch als `visitor`. Per
`patch_state` beim Wechsel der Art das andere Feld auf `null` setzen (Merge Patch), z. B.
`{"phantom": {"sha256": "…", "name": "x.zip", "collection": null}}`. Karten und Wertebereiche liefert `get_phantom_maps`;
sie werden nicht gespeichert. `tissues` gehört zum Phantom: welche seiner Gewebe
betrachtet (und später simuliert) werden, Namen aus `list_phantom_tissues`, `null` für
alle. Gewählt wird es im Phantom-Browser oder mit `select_phantom` (`tissues`, mit Session
auch ohne Phantom für das aktuelle). Ein anderes Phantom setzt die Gewebe auf alle zurück,
außer sie werden mit ihm zusammen gesetzt. `view` gilt für alle Viewer der Session
(Eigenschaft, `set_phantom_property`). Die Ebene (`tra`, `cor`, `sag`, `3d`) wählt jeder
Viewer selbst; sie steht nicht im Zustand. Ebenso die Fensterung: Unter jedem Viewer
zeigt ein Histogramm die Werte der Eigenschaft, seine zwei Linien (Min, Max) stellen das
Fenster ein (auch Rechtsklick ziehen im Bild); ein neues Volumen beginnt beim Wertebereich.

`open_*` zeigen in Clients mit MCP Apps das jeweilige Tool im Chat. Mit `session_key`
arbeitet es auf der Session; ohne wählt der Nutzer lokal, jede Änderung geht als
Kontext an das Modell (`updateModelContext`), „In den Chat“ schickt die Auswahl als
Nachricht. `select_phantom` geht auch ohne Session (prüft nur die Wahl). Die Website
zeigt unter `/s/{key}` Phantom-Browser, visuellen FOV-Planer und FOV-Planer nebeneinander.

Der Phantom-Browser hat zwei Reiter: **Katalog** (bifti-Registry) und **CAS**, die
Dateiliste (`file_list`, siehe Datei-Tools) fest im Modus BIfTI, ohne Download; ein Klick
wählt das Phantom. Ein geteiltes CAS-Phantom, das nicht in den eigenen Dateien liegt,
steht dort nicht (MRX-90). Die KI findet BIfTIs mit `list_user_files(mode="bifti")`. Ob ein Zip ein
Phantom ist, zeigt sich erst beim Laden der Karten. Wer was listen darf (z. B. kein
`list_files` für `visitor`), regelt das Gateway.

Tools lassen sich verschachteln: Der Phantom-Browser enthält die Phantom-Vorschau
(`open_phantom_preview`) zum Aufklappen. Zugeklappt (Standard, pro Gerät) wird sie nicht
gerendert und lädt keine Karten; so lässt sich das Phantom einer Session z. B. vom Handy
aus wechseln, ohne es dort zu laden.

`open_phantom_preview` ohne Session ist ein schneller Blick auf ein beliebiges Phantom:
Die KI gibt `collection` und `phantom` an (Pflicht), optional `property` und `tissues` zum
Start. Mit Session zeigt es Phantom und Ansicht der Session, die anderen Argumente
entfallen. Im Test-Host werden weitere Query-Parameter zu Tool-Argumenten, z. B.
`/dev/app-host.html?tool=open_phantom_preview&collection=endres-brainweb-001&phantom=subj04-3T-1mm.json&property=T1`.

anyfield hält keine Phantomdaten. Katalog und Karten liefern die bifti-Tools des
MRX-Gateways (`bifti_list_collections`, `bifti_list_phantoms`,
`bifti_get_property_maps`). Gateway-Aufrufe laufen mit Login als der Nutzer (Token
Exchange bei AuthKit), ohne Login als `visitor`. Die Karten (PD, T1, T2, T2′, ADC, dB0,
B1±; über die Gewebe kombiniert) sind NIfTIs unter `<gateway>/files/<hash>`, die Browser
und MCP Apps ohne Login laden. Mit `fov` und `matrix` liefert `get_phantom_maps` die
Karten auf dem geplanten Scan-Raster (Reslicing); das FOV wird dafür aus dem
Scanner-Rahmen der Karten in den RAS+-Rahmen des Phantoms zurückgedreht. Der FOV-Planer
zeigt so die Vorschau im FOV.

FOV-Planung sind zwei Tools: der **FOV-Planer** (`fov_planner`) mit Slidern für Position,
Rotation, Größe und Matrix (eine Affine mit Raster) und oben, zum Aufklappen, der
Phantom-Vorschau auf diesem Raster („Vorschau - Resampled“); und der **visuelle
FOV-Planer** (`fov_viewer`, `open_fov_viewer`), das Phantom mit der FOV-Box, breit im
2×2-Raster, schmal eine Ebene mit Auswahl-Dropdown. Beide nutzen denselben Viewer-Baustein
wie die Phantom-Vorschau (`PhantomViewer`).

Im visuellen Planer wird die Box in den 2D-Ansichten mit der Maus bearbeitet (Strg oder
Cmd): ziehen verschiebt die Box mit der Maus in der Ebene der Ansicht (sie bleibt dort
gepackt, wo man klickt), Rechtsklick ziehen dreht um die
Normale der Ansicht (Shift: fein), Mausrad ändert die Größe der Box-Achse entlang der
Vertikalen der Ansicht (etwa 2 mm je Raste, Shift: fein). Ohne Strg bleibt die Maus bei NiiVue
(Fadenkreuz, Schichten, Rechtsklick ziehen: Fensterung). Auf Touch-Geräten schaltet ein
Knopf über der Ansicht die Finger auf die Box um: ein Finger verschiebt, zwei Finger drehen
(ab 5°, damit Spreizen nicht mitdreht). Spreizen ändert die Box-Achse, in deren Richtung
gespreizt wird, um so viel, wie die Finger entlang dieser Achse auseinandergehen (diagonal:
beide; je Achse ab 3 mm). Die Achsen drehen dabei mit der Box mit, Drehen und Spreizen
gehen also gleichzeitig.

Der **Session-Editor** (`session`, `open_session`, nur mit Session-Key) zeigt den Zustand
als JSON zum Bearbeiten (CodeMirror, Syntaxfehler im Text markiert). „Update“ schickt,
was sich gegenüber dem geladenen Stand geändert hat, als Merge Patch an `patch_state`, mit
`expected_rev` (gelöschte Felder: zurück auf ihren Standard). Prüft der Server die
Änderung nicht durch oder hat sich die Session inzwischen geändert, steht seine Meldung im
Editor und der Text bleibt. „Reload“ verwirft die Änderungen und lädt den aktuellen
Zustand; hat sich die Session seit dem Laden geändert, zeigt er ein Warn-Icon. Auf der
Website öffnet „Zustand (JSON)“ denselben Editor als Modal.

Die **Datei-Tools** zeigen die Dateien des Nutzers im Speicher (CAS) des Gateways.
anyfield hält keine Dateien, die Bytes gehen direkt zwischen Browser und Gateway:

- `file_upload` (`open_file_upload`): Dateien in eine Box ziehen oder anklicken. Der
  Browser holt je Datei eine kurzlebige Upload-URL (`create_file_upload_url`, beim
  Gateway `create_upload_url`) und lädt per POST dorthin hoch (CORS des Gateways
  erlaubt kein PUT), mit Fortschritt. Danach Name und Hash; im Chat erfährt auch das
  Modell davon.
- `file_list` (`open_file_list`): Tabelle aus `list_files` des Gateways, nach jeder
  Spalte sortierbar, mit Suche, schmal horizontal scrollbar. Erste Spalte lädt herunter
  (`<gateway>/files/<hash>`, ohne Login: der Hash ist die Berechtigung; im Chat über
  `openLink`, das iframe darf nicht selbst herunterladen). Ein Dropdown neben der Suche
  zeigt alle Dateien oder nur BIfTIs (`.zip`). Optionen des Tools: `mode` (`all` oder
  `bifti`) legt das Dropdown fest und graut es aus, bei `bifti` ohne Spalte „Typ“;
  `download=false` blendet die Downloads aus. Ein Klick auf den Namen: ohne Session
  `"name": <hash>` in den Chat (auf der Website kopiert), mit Session je nach Modus, bei
  `bifti` wird die Datei Phantom der Session (hervorgehoben), bei `all` nichts. Weitere
  Modi (z. B. Sequenzen) setzen später ihr Feld. Das Gateway löscht eine Datei einen Tag
  nach ihrer letzten Nutzung.
- `file_manager` (`open_file_manager`): beides untereinander; ein Upload lädt die Liste
  neu. Auf der Website hinter „Dateien“ in der Kopfzeile.

Ohne Login laufen die Datei-Tools als gemeinsamer `visitor` (siehe MRX-90).

## Aufbau

```
backend/   Python (uv), FastMCP, Modal
  src/anyfield/server.py     Tools, Routen
  src/anyfield/auth.py       Login (AuthKit) nur für Session-Verwaltung
  src/anyfield/gateway.py    Gateway-Tools im Namen des Nutzers (Token Exchange) oder als `visitor`
  src/anyfield/store.py      Modal Dict + Volume (Dict-Einträge verfallen nach 7 Tagen)
  src/anyfield/migrations.py Migrationen gespeicherter Sessions (Schema-Versionen)
  src/anyfield/phantoms.py   Katalog und Karten vom Gateway, FOV → Scan-Raster
  src/anyfield/phantom_tools.py  Phantom-Tool
  src/anyfield/file_tools.py     Datei-Tools (Upload, Liste, Download über das Gateway)
  src/anyfield/modal_app.py  Deployment
frontend/  Svelte 5, TypeScript, Vite, NiiVue, Skeleton (UI), Lucide (Icons)
  src/lib/client/            Transport: MCP-HTTP (Web), MCP App, Mock
  src/lib/state/             Selection: SessionStore (Polling, optimistisch) oder LocalSelection
  src/lib/components/fov/    FOV-Planer (Slider) und visueller FOV-Planer
  src/lib/components/phantom/  Phantom-Browser, Phantom-Vorschau, Viewer-Baustein PhantomViewer
  src/lib/components/session/  Session-Editor (JSON)
  src/lib/components/files/    Datei-Upload, Dateiliste, Dateimanager
  src/web/                   Web-App
  src/mcp-app/               MCP Apps (je eine HTML-Datei, gemeinsame Hülle McpApp.svelte)
  dev/app-host.html          Test-Host für die MCP App
```

UI-Bausteine kommen aus Skeleton (`@skeletonlabs/skeleton-svelte`), Icons **immer** aus
Lucide (`@lucide/svelte`, je Icon importiert: `import ChevronRight from
"@lucide/svelte/icons/chevron-right"`). Keine Unicode-Zeichen oder eigenen SVGs als Icons.

## Session-Schema und Migrationen

Jede gespeicherte Session trägt `version` (Schema-Version, fehlt bei alten Sessions: 0).
Ändert sich die Form des Zustands so, dass gespeicherte Sessions nicht mehr passen
(Feld entfällt, wird umbenannt oder verschoben), kommt ein Migrationsschritt in
`backend/src/anyfield/migrations.py`, nicht in Modelle oder Tools:

1. `SCHEMA_VERSION` um eins erhöhen.
2. Schritt `_vN_to_vN+1` in `STEPS` eintragen: rohes JSON (dict) rein, rohes JSON raus,
   ohne I/O und ohne die aktuellen Modelle. So bleibt er gültig, wenn die Modelle sich
   später wieder ändern.
3. Test in `tests/test_migrations.py` mit einer Session, wie sie vorher gespeichert war.

Ein veröffentlichter Schritt wird nie mehr geändert; jede Änderung bekommt einen neuen.
Neue Felder mit Standardwert brauchen keine Migration.

Beim Start jedes Containers (`modal_app.web`) schreibt `migrate_modal_store` alle
Sessions in Dict und Volume auf die aktuelle Version um. Ein Marker im Dict
(`meta:schema_version`) lässt spätere Starts das überspringen; laufen mehrere Container
gleichzeitig los, schreiben sie dasselbe. Zusätzlich migriert der Store jede Session beim
Lesen: Während eines Deploys können Container mit altem Code noch Sessions im alten Format
schreiben. Eine Session mit neuerer Version als der Code wird abgelehnt.

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
