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

### Frontend/Auth — concrete fix for login hanging perception
- Implemented a direct auth-flow fix in `web/src/app/services/auth.service.ts`:
  - added timeout wrapper for Cognito calls (`signIn`, `getCurrentUser`) so login/session checks fail fast instead of waiting indefinitely on stalled network calls
  - `signIn` timeout: 15s with explicit user-facing timeout error
  - session check timeout: 8s
  - added post-login guard fast-path: when local auth signal is already true, `checkSession()` returns immediately and avoids redundant immediate Cognito roundtrip during navigation guard evaluation
- Verified build: `cd web && npx ng build --configuration production` ✅ (known warnings unchanged)
- Verified current live config consistency via AWS CLI:
  - CloudFormation Cognito outputs and Amplify app env vars now match
  - latest Amplify job succeeded

### Ops Debug — global APRS activator spread despite DM-only scope
- Investigated live production behavior where map showed activators worldwide although `ConfigTable.sotaAssociations=["DM"]`.
- Verified via AWS CLI:
  - `ConfigTable` scope is DM-only (`sotaAssociations=["DM"]`, `sotaRegions=[]`).
  - `AprsPositionsTable` contains many fresh positions outside DM (EU/NA/Asia/South America/Oceania), indicating ingest is effectively global.
  - In recent data (`<=5 min`), the majority of packets were outside DM bbox.
- Root-cause finding:
  - EC2 APRS listener currently starts with default login callsign fallback `N0CALL` when `APRS_LOGIN_CALLSIGN` is not provided.
  - Stack/UserData currently exports `CONFIGTABLE_TABLE_NAME` and `AWS_REGION`, but does **not** export APRS login credentials/passcode.
  - This strongly indicates APRS-IS server-side filtering is not reliably enforced in live operation, resulting in broad/global packet ingest.
- Recommended remediation:
  - Provide proper APRS-IS login callsign (+ passcode if required) via environment for EC2 listener.
  - Add a backend safety guard (scope validation before persisting APRS positions) so global packets are dropped even if listener filter fails.

### Backend/EC2/Frontend — APRS scope stability, config latency fix, and stale marker control
- **APRS filter refresh behavior hardened**:
  - listener refresh interval reduced from 10 minutes to **120 seconds**
  - listener now logs scope cardinality and explicit fallback reasons when config cache keys are missing
  - when no associations are selected, listener falls back to safe default APRS filter instead of deriving broad scope
- **`GET /config` latency + missing-cache issue fixed**:
  - `GetConfigFunction` fallback now derives and persists all dynamic scope cache keys from `SummitsTable` when missing:
    - `sotaAssociationOptions`
    - `sotaRegionsByAssociation`
    - `sotaAprsAreaByAssociation`
    - `sotaAprsAreaByRegion`
  - this avoids repeated full-table scans on subsequent config loads
- **Scope safety enforcement**:
  - `PutConfigFunction` now rejects empty `sotaAssociations` (HTTP 400)
  - frontend Config page enforces at least one selected association before save
- **Immediate stale marker cleanup on scope change**:
  - `PutConfigFunction` now clears `AprsPositionsTable` when `sotaAssociations` or `sotaRegions` changes
  - prevents previously broad APRS scope from continuing to overload map rendering after narrowing
- **APRS freshness cap set to 6h**:
  - `GetAprsPositionsFunction` now filters out items older than 6 hours by `lastSeen`
  - map component applies an additional client-side 6h guard before rendering activators


### Backend/Infra/Frontend — Dynamic association/region scope + APRS filter generation
- Removed remaining hardcoded south-Germany/Austria association assumptions in config and filtering flows.
- `RefreshSummitsFunction` now writes dynamic option/catalog keys into `ConfigTable` after each summit refresh:
  - `sotaAssociationOptions` (all currently valid associations from SOTA CSV)
  - `sotaRegionsByAssociation` (region lists per association)
  - `sotaAprsAreaByAssociation` (derived APRS `a/...` bbox per association)
  - `sotaAprsAreaByRegion` (derived APRS `a/...` bbox per association+region key)
- `SeedConfigFunction` defaults changed to generic startup values:
  - `sotaAssociations = []` (empty => all available options)
  - `sotaRegions = []` (empty => all regions of selected associations)
- `PutConfigFunction` now accepts and validates `sotaRegions` (format `ASSOC|RegionName`) against cached SOTA options/regions.
- `GetSummitsFunction`, `GetSotaAlertsFunction`, `GetSotaSpotsFunction`, and `GetSpotsWebFunction` now use dynamic association selection from config/options instead of hardcoded `DL/OE/DM` filters.
- EC2 APRS listener (`ec2/aprs-listener/aprs-listener.py`) now:
  - builds APRS-IS filter dynamically from ConfigTable cache (`a/...` scopes)
  - appends `t/p` (positions only) to reduce traffic
  - refreshes scope periodically (10 min)
  - applies max-9 area filter guardrail
  - keeps walker symbol logic unchanged (`/` + `[`/`p`)
  - adds lightweight dedupe for near-identical packets per callsign (45s window)
  - logs active filter and packet stats (`walker/invoked/deduped/too_fast/ignored_symbol`)
- `template.yaml` updated accordingly:
  - added `CONFIGTABLE_TABLE_NAME` + IAM reads where needed (`GetSotaSpotsFunction`, `GetSotaAlertsFunction`, `RefreshSummitsFunction`, EC2 role)
  - EC2 `UserData` now exports `CONFIGTABLE_TABLE_NAME` and `AWS_REGION` to `/etc/environment`
- Frontend config UI (`/config`) now loads dynamic options from backend:
  - removed hardcoded association list
  - added optional region multi-select
  - `AppConfig` now includes `sotaRegions`
- Validation rerun:
  - `python -m py_compile ...` for touched backend handlers ✅
  - `sam validate` ✅ (basic validation)
  - `cd web && npx ng build --configuration production` ✅ (known warnings unchanged: SCSS budgets + Leaflet CommonJS)

### Frontend — Map alert recency + Alerts/Spots freshness highlighting and filtering
- **Map widgets alert recency rule updated:** overdue alerts are no longer kept indefinitely in map widget context.
  - Alerts are now retained on map widgets only when they are future/current or at most **60 minutes overdue**.
  - Alerts with **missing/invalid timestamps remain visible** (but are not time-highlighted), per UX decision.
  - Expired alerts (based on `expiration`) are still excluded.
- **Alerts table highlighting added:** alerts with valid activation time within **±60 minutes** of now are highlighted in green.
- **Spots table freshness behavior updated:**
  - spots older than **6 hours** are now hidden (when timestamp is valid)
  - spots with valid time not older than **30 minutes** are highlighted in green
  - spots with missing/invalid timestamps stay visible and are never highlighted
- **Alerts/Spots table typography harmonized:** standardized body/time/distance/link sizing for more consistent column readability across both tables.
- Validation rerun: `cd web && npx ng build --configuration production` ✅ (known warnings unchanged: SCSS budget + Leaflet CommonJS).

### Frontend — Map legend + alerted/upcoming panel semantics update
- **Legend updated** to match current map behavior:
  - summit point colors now shown as **discrete original SOTLAS buckets** (`1/2/4/6/8/10`) instead of an old gradient bar
  - retained activator freshness and tactical-line entries
  - added explicit indicator entries for **🔔 active alert badge** and **summit glow ring = planned today (UTC)**
  - removed outdated legend entry about gray no-APRS progress bars
- **Alerted panel behavior changed**:
  - panel renamed to **Alerted activators (APRS)**
  - now includes **all alerted activators that have APRS** (no `<2 km` cutoff)
  - still sorted by **distance to alerted summit** and keeps distance/proximity bar visualization
- **Upcoming panel behavior changed**:
  - now explicitly **Upcoming Alerts (no APRS)** only
  - removed proximity/gray bars in this panel
  - each row now shows **planned alert time (UTC)** and **time remaining / overdue** text
  - sorted by alert time ascending (earliest first)
- Added alert-time parsing in `map.component.ts` to support robust countdown formatting from `dateActivated`/`activationDate` values.
- Validation rerun: `cd web && npx ng build --configuration production` ✅ (known warnings unchanged: SCSS budget + Leaflet CommonJS).

### Frontend — Alerts/Spots table width optimization (comments removed)
- Removed the **Frequencies/Comments** column from the Alerts table to reduce horizontal width and avoid unnecessary scrolling.
- Removed the **Comments** column from the Live Spots table for the same reason.
- Updated Alerts/Spots search behavior so filters only match values visible in the table (removed matching on hidden comments fields).


### Frontend — Tactical activator relevance + summit tooltip regression fix
- Tactical mode now also limits **activator markers/traces** to only those activators that are relevant to active tactical associations (respecting source chips).
- This removes non-relevant activators from tactical view and improves focus/noise ratio.
- Fixed summit tooltip regression for tactical-relevant summits by making animated glow rings non-interactive (`interactive: false`) so summit circle marker tooltips/popups are reachable again.
- Validation rerun: `cd web && npx ng build --configuration production` ✅ (known warnings unchanged: SCSS budget + Leaflet CommonJS).

### Frontend — Tactical View + Upcoming Alerts panel on Map
- Added a new **Tactical View toggle** in the map toolbar (Standard/Tactical) with an **Auto-fit tactical** action.
- Added **Tactical source filter chips** (`Alerts`, `Recent spots`, `Candidates`) so users can quickly declutter tactical context.
- Tactical mode now renders only **relevant summits** (summits with active alerts, recent spots within **60 minutes**, or candidate proximity hits).
- Added tactical **airline links** between activator and associated summit:
  - Alerts: solid orange line
  - Candidates: dashed cyan line
  - Recent spots: dotted purple line
- Tactical lines now support **freshness-based fading** (newer data = higher opacity).
- Added a dedicated **Upcoming Alerts (all active)** panel on the right overlay:
  - includes alerts even when APRS position is missing
  - rows without APRS show a **gray progress bar** and `No APRS` status
  - clicking no-APRS rows centers the summit; APRS rows center the activator
- Existing **Approaching (<2 km)** panel remains proximity-only for signal clarity.
- Required frontend validation run: `cd web && npx ng build --configuration production` ✅ (known warnings only: SCSS budget + Leaflet CommonJS).

### Deployment/Hosting — Use pre-existing Amplify app only + SPA rewrite enforcement
- Removed SAM-managed Amplify resources from `template.yaml` (`AmplifyApp`, `AmplifyMainBranch`) and removed `AmplifyAppId` output.
- `deploy.sh` now explicitly validates the pre-existing Amplify app/branch from `samconfig.toml` before deployment sync.
- `deploy.sh` now enforces Amplify SPA rewrite custom rules (`regex -> /index.html`, HTTP 200) on the real app to prevent deep-link refresh issues (e.g. `/alerts/` 404 after trailing-slash redirects).
- `deploy.sh` now runs route header checks for `/alerts`, `/alerts/`, and `/map` on the default Amplify domain, and optionally on a custom domain when `CUSTOM_WEB_DOMAIN` is set.

### Backend — Alerts/Spots summit ref normalization hardening
- Added summit reference normalization in `GetSotaAlertsFunction` and `GetSpotsWebFunction` to avoid malformed refs when upstream `summitCode` already includes association (prevents values like `OE/OE/SB-462`).
- `GetSotaAlertsFunction` now supports additional upstream callsign/time field variants while deduplicating alerts (`activatingCallsign` / `activatorCallsign` / `callsign`, `timeStamp` / `timestamp`).
- `GetSpotsWebFunction` now uses normalized summit refs consistently for lookup/response and accepts additional time fallback (`spotTime`) while preserving current field compatibility.

### Backend/Infra — API Gateway CORS error-response fix
- Added API Gateway `GatewayResponse` resources for `WatchtowerWebApi` (`DEFAULT_4XX`, `DEFAULT_5XX`, `UNAUTHORIZED`, `ACCESS_DENIED`) in `template.yaml`.
- All these API-level error responses now include CORS headers (`Access-Control-Allow-Origin`, `Access-Control-Allow-Headers`, `Access-Control-Allow-Methods`).
- This fixes browser-side "CORS Missing Allow Origin" errors for `/alerts` and `/spots` when requests fail before Lambda (e.g. auth/authorizer/API Gateway 4xx/5xx).

### Backend — Alerts/Spots timeout reduction + timeout-CORS coverage
- **GetAlertsWebFunction performance optimization:** replaced full `SummitsTable` scan with targeted `BatchGetItem` enrichment for only summit refs used by active alerts.
- **GetSpotsWebFunction performance optimization:** replaced full `SummitsTable` scan with targeted `BatchGetItem` enrichment for only summit refs present in filtered spots.
- **Lambda timeout safety margin:** increased `GetAlertsWebFunction` and `GetSpotsWebFunction` timeouts from 30s to 60s.
- **API Gateway timeout/failure CORS coverage:** added `GatewayResponse` resources for `INTEGRATION_TIMEOUT` and `INTEGRATION_FAILURE` so timeout/failure responses include CORS headers.

### Backend — Alerts/Spots post-redeploy resilience fixes
- **GetSpotsWebFunction SOTA API compatibility fix:** spots normalization now supports both old and new upstream field names (`activatingCallsign`/`activatorCallsign`, `posterCallsign`/`callsign`) so `Time (UTC)`, `Callsign`, and `Posted By` no longer render as empty dashes.
- **Spots summit metadata fallback:** when `SummitsTable` lookup misses, `/spots` now parses upstream `summitDetails` (e.g. `"Reisseck, 2305m, 10 points"`) to still provide `summitName`, `altitude`, and `points`.
- **GetSotaAlertsFunction hardening:** frequency regex creation is now fail-safe (invalid/missing pattern falls back to match-all), ISO timestamp comparisons are robust for trailing `Z`, and ingestion logs now report fetched/filtered/deleted/written counts.
- **Automatic alerts refresh restored:** `GetSotaAlertsFunction` now has an EventBridge schedule (`rate(5 minutes)`) to repopulate `SotaAlertsTable` continuously after redeploy.
- **Deploy bootstrap improved:** `deploy.sh` now invokes `GetSotaAlertsFunction` once after deployment, so alerts are prefilled immediately instead of waiting for the next schedule tick.
- **Critical API 502 fix (`/alerts`, `/spots`):** both web Lambdas used low-level DynamoDB `batch_get_item` with incorrectly typed keys (`{'summitCode': 'OE/...'}` instead of `{'summitCode': {'S': 'OE/...'}}`), causing `ParamValidationError` and API Gateway `502 InternalServerErrorException`. Key serialization was corrected in both `GetAlertsWebFunction` and `GetSpotsWebFunction`.

### Deployment — Safe stack deletion helper
- Added root-level `delete-stack.sh` to safely tear down `sota-watchtower-stack` by first emptying all stack-managed S3 buckets (including versioned objects and delete markers), then running `sam delete --no-prompts`.
- This prevents CloudFormation `DELETE_FAILED` on non-empty bucket resources (notably `SummitsBucket`) during stack removal.
- Updated `cline_docs/deploymentGuide.md` with a dedicated “Delete Stack (safe S3 cleanup first)” section and usage examples.

### Backend — Summits validity + normalized web payloads
- **RefreshSummitsFunction validity fix:** SOTA CSV `ValidFrom`/`ValidTo` is now parsed as `DD/MM/YYYY` dates before filtering. This fixes false positives where inactive summits could still appear on the map (e.g. expired summits such as Ulrichsberg).
- **GetSotaAlertsFunction enrichment:** alert items persisted in `SotaAlertsTable` now additionally include `frequency`, `mode`, `comments`, and `posterCallsign`; `callsign` now prefers `activatingCallsign` (fallback: `posterCallsign`).
- **GetAlertsWebFunction normalized response:** `/alerts` now returns enriched fields for the UI (`summitRef`, `summitName`, `altitude`, `points`, `frequenciesComments`) by joining `SotaAlertsTable` with `SummitsTable`.
- **GetSpotsWebFunction normalized response:** `/spots` now returns normalized rows (`time`, `callsign`, `frequency`, `mode`, `summitRef`, `summitName`, `altitude`, `points`, `postedBy`, `comments`) with summit metadata enriched from `SummitsTable`.
- `template.yaml` updated so `GetAlertsWebFunction` and `GetSpotsWebFunction` receive `SUMMITS_TABLE_NAME` and `DynamoDBReadPolicy` access to `SummitsTable`.

### Frontend — Alerts/Spots table expansion + callsign flags
- **Alerts table** now shows: `Date/Time (UTC)`, `Callsign`, `Summit Ref.`, `Summit Name`, `Altitude`, `Points`, `Frequencies/Comments`, `Dist. to Summit`, `Status`, `Actions`.
- **Spots table** now shows: `Time (UTC)`, `Callsign`, `Frequency`, `Mode`, `Summit Ref.`, `Summit Name`, `Altitude`, `Points`, `Posted By`, `Comments`, `Actions`.
- Added shared callsign-flag utility: `web/src/app/shared/callsign-flag.util.ts`.
- Callsign flags are now rendered (when known; no flag fallback for unknown prefixes) in:
  - Alerts callsign cells
  - Spots callsign + posted-by cells
  - Map quick-search activator suggestions
  - Map approaching/candidate overlays
  - Map activator marker labels, tooltips, and popups
- Required frontend validation run: `cd web && npx ng build --configuration production` ✅ (same known warnings only: SCSS budget + Leaflet CommonJS).

### Frontend — Map Marker & Overlay Refinements
- **Quick Search panel moved** from top-left to **top-center** for better map balance.
- Clicking entries in **Approaching** and **Candidates** now pans/zooms the map **without** showing a temporary jump label marker.
- **Approaching/Candidates cards compacted**: activator, summit, and distance now render on a single text line with the progress bar below to save vertical space.
- **Candidates overlay section height increased**: candidate list panel now gets roughly **2×** the vertical space of the Approaching panel, allowing more candidate rows to be visible.
- **Regression fix (overlay sizing)**: right overlay now uses explicit top+bottom anchoring so Approaching/Candidates panels no longer collapse into thin boxes; content renders again with the intended 1:2 height split and internal scrolling.
- **Map legend moved** to the **lower-left** corner to avoid overlap with right-side overlays.
- **Approaching panel height is now dynamic**: it uses only needed height up to its previous maximum (~1/3 of overlay), scrolls when overflowing, and **Candidates automatically takes remaining space**.
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
- `sotaAssociations` — selected SOTA associations to monitor (empty = all cached options)
- `sotaRegions` — optional selected regions (`ASSOC|RegionName`)
- `sotaAssociationOptions` — cached dynamic associations from latest summit refresh
- `sotaRegionsByAssociation` — cached dynamic regions per association
- `sotaAprsAreaByAssociation` — cached APRS `a/...` bbox per association
- `sotaAprsAreaByRegion` — cached APRS `a/...` bbox per region key
- `activationZoneDistanceMeters` — max horizontal distance from summit (default: 150)
- `activationZoneAltitudeDeltaMeters` — max altitude below summit (default: 25)

---

## Known Issues / Notes
- The `leaflet` npm package used by the map component is CommonJS (not ESM), causing a harmless Angular build warning.
- Angular build emits a style budget warning for `map.component.scss` after adding map overlay panels; build still succeeds.
- `AprsMonitorInstance` EC2: `Replacement: Conditional` in CloudFormation changeset — this is expected when UserData changes, but instance is not replaced unless `UpdateReplacePolicy` triggers it.
- Distance column in Alerts tab requires both APRS position AND summit coordinates from the GeoJSON. If the GeoJSON hasn't loaded yet the column shows `?`; if no APRS data for the callsign it shows `—`.
