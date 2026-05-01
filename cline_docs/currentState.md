# SOTA Watchtower — Current State & Change Log

## Current Status (as of 2026-05-01)
- ✅ Backend fully deployed (sota-watchtower-stack in eu-central-1)
- ✅ Frontend live on Amplify (build #13 succeeded)
- ✅ APRS walker positions working (32+ positions in API)
- ✅ CloudWatch dashboard fixed (no more "Network Failure")
- ✅ Dark mode default
- ✅ Inter font
- ✅ Left sidebar navigation
- ✅ Summit markers with points-based coloring (no clustering)
- ✅ Walker traces with configurable duration
- ✅ Debug event log panel
- ✅ Walker freshness indicator

## Recent Changes

### 2026-05-01 — Major Feature Release
**Backend:**
- Added `AprsPositionsTable` (DynamoDB) with composite key (callsign PK + timestamp SK) and 2h TTL
- Added `GetAprsPositionsFunction` — unauthenticated GET /aprs-positions endpoint
- Fixed `ActivationZoneMonitorFunction`: was using TABLE_ARN instead of TABLE_NAME for DynamoDB
- Fixed CloudWatch dashboard: duplicate Export key causing "Network Failure" error
- Fixed .env: FREQUENCY_FILTER_PATTERN must be single-quoted

**Frontend:**
- Dark mode is now the default
- Inter font via Google Fonts
- CARTO Dark Matter / Voyager map tiles
- Left sidebar navigation (replaces top toolbar)
- Summit markers: colored circles by points (green→red), no clustering
- Walker markers: large icons with freshness-based opacity
- Walker traces: polylines showing historical positions
- Debug event log panel (toggleable)
- Polished login page, alerts table, map legend

## Known Issues / TODOs
- Walker trace history requires backend to store multiple positions per callsign (done via composite key)
- Trace duration is configurable in UI (localStorage), default 2 hours
- Summit CSV has no header row — columns are positional
- leaflet and leaflet.markercluster are CommonJS (warning in build, not an error)

## Infrastructure Notes
- EC2 instance may be replaced/recreated by CloudFormation if UserData changes
- Amplify build fails if TypeScript errors exist — always run `npx ng build` locally before pushing
- The .env FREQUENCY_FILTER_PATTERN must be quoted: `FREQUENCY_FILTER_PATTERN='...'`

## API Endpoints Summary
| Method | Path | Auth | Function |
|--------|------|------|----------|
| GET | /aprs-positions | None | GetAprsPositionsFunction |
| GET | /summits | Cognito | GetSummitsFunction |
| GET | /alerts | Cognito | GetAlertsWebFunction |
| GET | /spots | Cognito | GetSpotsWebFunction |
| GET | /config | Cognito | GetConfigFunction |
| PUT | /config | Cognito | PutConfigFunction |
| POST | /notify | None | HamAlertProcessFunction (via HamAlertApi) |
