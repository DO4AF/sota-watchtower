# Current State — SOTA Watchtower

## Last updated: 2026-05-02

## Status: Production — Live

---

## Live URLs
- **Web UI:** https://main.d1e96ec1sckzck.amplifyapp.com
- **REST API:** https://s7l4613rp6.execute-api.eu-central-1.amazonaws.com/Prod
- **WebSocket:** wss://393w4h7amb.execute-api.eu-central-1.amazonaws.com/Prod
- **Summits GeoJSON (S3):** https://sota-watchtower-stack-summitsbucket-f4mxdd7k3poh.s3.eu-central-1.amazonaws.com/summits.json
- **Cognito User Pool:** eu-central-1_7gp1Avnkp
- **Cognito Client ID:** 2tbj9rhe1ds0ip7mse1h9vi0ej

---

## Recent Changes (2026-05-02)

### Frontend — Map Marker & Overlay Refinements
- **Quick Search panel moved** from top-left to **top-center** for better map balance.
- Clicking entries in **Approaching** and **Candidates** now pans/zooms the map **without** showing a temporary jump label marker.
- **All summit markers now use the same radius** (minimum size / 5px); summit point value is still encoded by color.
- **Activator markers now show a bell badge (🔔)** when the activator has an active alert (SSID-insensitive callsign match).
- **Summit glow now applies only to planned activations for today (UTC)**.
- Glow rings are rendered via Leaflet **SVG renderer** (while summit dots stay on canvas) so pulse animation works reliably.

### Frontend — Favicon
- Added a new **globe-themed SVG favicon** at `web/public/favicon.svg`.
- Updated `web/src/index.html` to use the new SVG favicon.

### Backend — Alert Data Enrichment
- `GetSotaAlertsFunction` now persists `dateActivated` into `SotaAlertsTable` items so the frontend can reliably filter “planned today” glow markers.

### Frontend — Map Search + Proximity Panels
- **Quick Search panel added to Map view**: live suggestions while typing for both **summits** (code/name) and **activators** (callsign). Clicking a suggestion (or pressing Enter) centers and zooms the map to the selected target.
- **Approaching activators panel added**: shows activators with an **active alert** whose current APRS position is **< 2 km** from their alerted summit.
- **Candidates panel added**: shows APRS-active activators **without an active alert** when they are **< 2 km** from their nearest summit.
- Both proximity panels include a **distance progress bar** indicating closeness to summit (0 km = full bar, 2 km = empty) and rows are clickable to focus the map.
- Callsign matching between APRS and alerts is normalized (SSID-insensitive, e.g. `OE1ABC-7` ⇄ `OE1ABC`) to improve correlation.

### Frontend — Alerts Layout Fix
- **Alerts view tables restored**: added explicit host flex sizing to `alerts.component.scss` (`:host { display:flex; flex-direction:column; flex:1; min-height:0; height:100%; }`).
- This fixes a layout collapse where only the header row rendered and both table panels had zero height in `/alerts`.

### Backend — Dynamic Telegram Configuration
- **TelegramNotifyFunction** now reads Telegram bot token from DynamoDB `ConfigTable` at runtime instead of from Lambda environment variables. The env var `TELEGRAM_BOT_TOKEN` is still set (for fallback), but the DynamoDB value takes precedence. **No redeployment needed when changing Telegram credentials.**
- **HamAlertProcessFunction** fixed: env var key was `TELEGRAM_user_ID` — corrected to `TELEGRAM_USER_ID`. Function also now reads Telegram Group/User IDs from ConfigTable at runtime.
- **ActivationZoneMonitorFunction** now reads `activationZoneDistanceMeters` (default: 150m) and `activationZoneAltitudeDeltaMeters` (default: 25m) from ConfigTable at runtime. Previously these were hardcoded. **GUI activation zone threshold changes now take effect immediately.**
- `template.yaml` updated to add `CONFIGTABLE_TABLE_NAME` env var and `DynamoDBReadPolicy` to: `TelegramNotifyFunction`, `HamAlertProcessFunction`, `ActivationZoneMonitorFunction`.

### Frontend — UI Improvements
- **Alerts & Spots views** now span full window height with scrollable tables (removed paginator). Both tabs have a search/filter input box.
- **Alert table** has a new **Distance** column: when APRS position data is available for the alerting callsign, the haversine distance from the activator to the summit is computed client-side and shown (e.g. "2.3 km" or "450 m").
- **Map component**: clicking on an activator's **trace polyline** now pans+zooms the map to the activator marker (minimum zoom 13).
- **Event Log** is now fully filterable: free-text search across category+message, plus per-severity toggle buttons (INFO / SUCCESS / WARN / ERROR).
- **Event Log layout fixed**: aligned the routed host/flex sizing with Alerts/Spots (`:host` + `min-height:0` flex chain), so the table area now reliably ends at the window bottom and scrolls internally.
- **Config page** updated: replaced "⚠ warning about Telegram credentials requiring redeployment" with "ℹ info: changes take effect immediately."

### Docs
- `.clinerules`: added SAM `sam delete + deploy.sh` instructions for infrastructure changes.

---

## Architecture Summary

### AWS Stack: `sota-watchtower-stack` (eu-central-1)
- **HamAlert API** — receives APRS spot webhooks from HamAlert
- **ActivationZoneMonitorFunction** — main logic: checks if activator is within activation zone; reads thresholds from DynamoDB
- **TelegramNotifyFunction** — sends Telegram messages; bot token read from DynamoDB
- **WebSocket API** — live push updates to browser clients
- **Cognito** — authentication for the web UI
- **Amplify** — hosts the Angular SPA (auto-builds on git push to `main`)

### DynamoDB Tables
| Table | Key | Notes |
|-------|-----|-------|
| `ConfigTable` | PK=configKey | Telegram creds, filter pattern, associations, activation zone thresholds |
| `SotaAlertsTable` | PK=callsign, SK=summit | Active SOTA alerts + activation state |
| `AprsPositionsTable` | PK=callsign | Latest APRS position + position history, TTL=2h |
| `SummitsTable` | PK=summitCode | All 18k+ SOTA summits |
| `WebSocketConnectionsTable` | PK=connectionId | Active WS clients |

### ConfigTable keys (configKey values)
- `telegramBotToken` — Telegram bot token (read at runtime by TelegramNotifyFunction)
- `telegramGroupId` — Telegram group chat ID
- `telegramUserId` — Telegram user chat ID
- `frequencyFilterPattern` — regex for filtering APRS spots by frequency
- `associations` — list of SOTA associations to monitor
- `activationZoneDistanceMeters` — max horizontal distance from summit (default: 150)
- `activationZoneAltitudeDeltaMeters` — max altitude below summit (default: 25)

---

## Known Issues / Notes
- The `leaflet` npm package used by the map component is CommonJS (not ESM), causing a harmless Angular build warning.
- Angular build emits a style budget warning for `map.component.scss` after adding map overlay panels; build still succeeds.
- `AprsMonitorInstance` EC2: `Replacement: Conditional` in CloudFormation changeset — this is expected when UserData changes, but instance is not replaced unless `UpdateReplacePolicy` triggers it.
- Distance column in Alerts tab requires both APRS position AND summit coordinates from the GeoJSON. If the GeoJSON hasn't loaded yet the column shows `?`; if no APRS data for the callsign it shows `—`.
