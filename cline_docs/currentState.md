# SOTA Watchtower — Current State & Change Log

## Current Status (as of 2026-05-01)
- ✅ Backend fully deployed (sota-watchtower-stack in eu-central-1)
- ✅ Frontend live on Amplify (build #22 deploying)
- ✅ **SummitsTable in DynamoDB** — 18,274 summits across 18 European associations
- ✅ **RefreshSummitsFunction** — downloads SOTA CSV daily at 02:00 UTC via EventBridge
- ✅ **APRS walker positions working** — 73+ positions, fresh data (S56CT-7 etc.)
- ✅ **Walker timestamp bug fixed** — microsecond ISO-8601 strings from Python now parsed correctly
- ✅ Walker markers enlarged (36px badge, 52×56 icon) with color glow
- ✅ Summit markers scaled by points (1pt→5px, 10pt→8px) with white stroke
- ✅ CloudWatch dashboard APRS Signal alarm = green
- ✅ Dark mode default (p-dark on html element, ThemeService forces it)
- ✅ Inter font (Google Fonts)
- ✅ Left sidebar navigation
- ✅ Walker freshness: <5m=green/pulse, 5-15m=yellow, 15-30m=orange, >30m=gray (min opacity 0.55)
- ✅ Walker traces (polyline history) with configurable duration
- ✅ **Map performance: canvas renderer + viewport-based loading** — all 18k summits render smoothly

## Recent Changes

### 2026-05-01 — Frontend: Map Performance & Missing Summits Fix

**Problem:** All 18,274 summit `CircleMarker`s were added to the map as SVG DOM elements at once.
The browser struggled to manage this many nodes → lag on pan/zoom, and some summits (e.g. Germany)
appearing to be missing due to rendering failures.

**Fix — two-pronged approach:**

1. **Canvas renderer** (`L.canvas({ padding: 0.5 })`): all `CircleMarker`s now share a single
   `<canvas>` element instead of thousands of SVG nodes. Canvas handles 50k+ points without issue.
   Enabled via `preferCanvas: true` in `mapOptions` and explicit `renderer:` per marker.

2. **Viewport-based marker management**: summit data is stored in memory as lightweight
   `SummitRecord[]` objects (no Leaflet objects). `updateViewport()` runs on `moveend`/`zoomend`
   (debounced 80ms) and:
   - Adds `CircleMarker`s only for summits within `getBounds().pad(0.5)` (visible + 50% buffer)
   - Removes markers that have scrolled outside the buffered bounds
   - Uses a `Map<code, [CircleMarker, glowMarker|null]>` index for O(1) add/remove

This means at any moment only ~2–5k markers exist on the canvas (depending on zoom/area),
even though all 18k summits are held in memory and become visible as you pan.

### 2026-05-01 — Backend: DynamoDB Summit Database

**New resources:**
- `SummitsTable` (DynamoDB): PK=summitCode, GSI=AssociationIndex (PK=association, SK=summitCode)
- `RefreshSummitsFunction`: downloads storage.sota.org.uk/summitslist.csv, filters ValidFrom/ValidTo,
  batch-writes to SummitsTable. EventBridge cron(0 2 * * ? *).
- `GetSummitsFunction`: queries SummitsTable GSI by association; reads association list from
  ConfigTable.sotaAssociations (default: DL,OE,HB,HB0,F,I,PA,ON,LX,9A,OK,SP,OM,HA,S5,YU,YO,LZ)

**Why:** Old approach bundled summitslist.csv in Lambda package and downloaded it on every invocation →
timeout. DynamoDB query now returns 18,274 summits in <1 second.

### 2026-05-01 — Frontend: Walker Visibility Bug Fix

**Bug:** Python's `datetime.now(timezone.utc).isoformat()` generates timestamps with microseconds
(6 decimal places, e.g. `2026-05-01T19:35:49.412395+00:00`). JavaScript's `Date()` constructor
only guarantees 3 decimal places (milliseconds). Extra digits cause `Invalid Date` / NaN in some
browser engines → `activatorFreshness()` returns NaN for all ages → all walkers display as
faded gray blobs at opacity 0.40.

**Fix:** `parseTimestamp()` strips digits beyond 3 decimal places via regex before `new Date()`.
Walkers now correctly show green/yellow/orange/gray based on actual age.

**Additional improvements:**
- Minimum walker opacity raised 0.40 → 0.55
- Walker badge enlarged 30px → 36px with color glow box-shadow
- Walker icon size 40×48 → 52×56
- Summit circle radius scales with points (1pt=5px, 10pt=8px), added white stroke
- Walker label uses Inter font instead of Courier New

### 2026-05-01 — Previous Session (Major Feature Release)
- Backend: AprsPositionsTable, GetAprsPositionsFunction, ActivationZoneMonitorFunction fixes
- Frontend: Full UI overhaul (dark mode, Inter, sidebar nav, walker markers, summit coloring, login page)

## Known Issues / Limitations
- CloudWatch dashboard "StartQuery Network Failure": this is a **browser-side** issue
  (ad blocker, network, or content security policy). The AWS infrastructure is correctly
  configured. The APRS Signal alarm widget works (green = ActivationZoneMonitorFunction invoked).
- leaflet is CommonJS (warning in build, not an error)
- APRS listener filter: pedestrian symbols (`[`, `p`) only, speed <10 km/h

## API Endpoints Summary
| Method | Path          | Auth    | Function                    |
|--------|---------------|---------|-----------------------------|
| GET    | /aprs-positions | None  | GetAprsPositionsFunction    |
| GET    | /summits      | None    | GetSummitsFunction          |
| GET    | /alerts       | Cognito | GetAlertsWebFunction        |
| GET    | /spots        | Cognito | GetSpotsWebFunction         |
| GET    | /config       | Cognito | GetConfigFunction           |
| PUT    | /config       | Cognito | PutConfigFunction           |
| POST   | /notify       | None    | HamAlertProcessFunction (HamAlertApi) |

## Infrastructure Notes
- Stack: `sota-watchtower-stack` in `eu-central-1`
- Amplify App ID: `d1e96ec1sckzck` (GitHub-connected, keep this)
- API Gateway (Web): `https://qxocjpup19.execute-api.eu-central-1.amazonaws.com/Prod`
- WebSocket: `wss://d24nsyrv72.execute-api.eu-central-1.amazonaws.com/Prod`
- Cognito User Pool: `eu-central-1_HICITnIcX`
- Cognito Client: `4qfqhh6sga89802nghhsc7bqae`
- AprsPositionsTable: single PK=callsign, positions stored as list attribute (up to 100 track points)
- SummitsTable: populated by RefreshSummitsFunction — must invoke manually after redeploy (daily cron at 02:00 UTC)
- EC2 instance may be replaced/recreated by CloudFormation if UserData/AMI changes
- The .env FREQUENCY_FILTER_PATTERN must be single-quoted
- Always run `cd web && npx ng build --configuration production` before git push
- After full stack redeploy: run `aws lambda invoke --function-name RefreshSummitsFunction ...` to re-populate SummitsTable
