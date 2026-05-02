# SOTA Watchtower — Frontend Architecture

## Stack
- **Framework**: Angular 19 (standalone components, no NgModules)
- **UI Library**: PrimeNG (buttons, tables, forms, toolbar, toast, etc.)
- **Map**: Leaflet + @bluehalo/ngx-leaflet
- **Auth**: AWS Amplify JS (Cognito)
- **Build**: Angular CLI, esbuild
- **Hosting**: AWS Amplify

## Project Structure
```
web/src/
├── index.html              # Google Fonts (Inter), Leaflet CSS
├── main.ts                 # Bootstrap, Amplify.configure()
├── styles.scss             # Global styles, CSS custom properties, dark/light themes
├── environments/
│   ├── environment.ts      # Dev: reads from window.__env (set by Amplify)
│   └── environment.prod.ts # Prod: reads from window.__env
└── app/
    ├── app.ts              # Root component (AppComponent + App alias)
    ├── app.html            # Shell: left sidebar nav + router-outlet
    ├── app.scss            # Sidebar layout styles
    ├── app.routes.ts       # Routes: /map, /alerts, /config, /login
    ├── app.config.ts       # provideRouter, provideHttpClient, provideAnimations
    ├── guards/
    │   └── auth.guard.ts   # Redirects to /login if not authenticated
    ├── services/
    │   ├── api.service.ts      # HTTP calls to REST API
    │   ├── auth.service.ts     # Cognito login/logout/session
    │   ├── theme.service.ts    # Dark/light mode toggle (localStorage)
    │   ├── websocket.service.ts # WebSocket connection management
    │   └── event-log.service.ts # (planned) Event log for debug panel
    ├── shared/
    │   └── callsign-flag.util.ts # shared callsign→country-flag heuristic mapper
    └── components/
        ├── map/            # Leaflet map with summits, alerts, walkers
        ├── alerts/         # SOTA alerts + spots table
        ├── config/         # Configuration form
        └── login/          # Login page
```

## Layout
The app uses a **left sidebar** layout:
- Sidebar (240px wide, collapsible to 64px): brand, nav links, theme toggle, logout
- Main content: `<router-outlet>` fills remaining space
- Map component: full height of content area

## Routing
```
/login    → LoginComponent (no auth guard)
/map      → MapComponent (auth guard)
/alerts   → AlertsComponent (auth guard)
/config   → ConfigComponent (auth guard)
/         → redirectTo: /map
```

## Theme System
- `ThemeService` manages dark/light mode
- Default: **dark mode**
- Stored in `localStorage` key `theme`
- Applies CSS class `dark-theme` / `light-theme` to `<body>`
- Map tiles switch: CARTO Dark Matter (dark) / CARTO Voyager (light)
- PrimeNG theme: Aura Dark / Aura Light

## Map Component
- Uses `@bluehalo/ngx-leaflet` directive
- **Summit markers**: `L.circleMarker`, colored by points (green→red gradient), no clustering
- **Walker markers**: Large emoji/SVG icon, freshness-based opacity, with trace polylines
- **Alert markers**: Orange glow circle
- **Notified markers**: Green glow circle
- **Walker traces**: Polylines showing historical positions (configurable hours)
- **Quick Search overlay**: live summit/activator suggestions while typing; selecting a suggestion centers/zooms map
- **Approaching panel**: right-side section for alerted activators with APRS within `<2 km` to alerted summit (proximity-focused)
- **Upcoming Alerts panel**: right-side section listing all active alerts (including alerts with no APRS); no-APRS entries show a gray/disabled progress bar
- **Candidates panel**: right-side section for APRS-active activators without alert within `<2 km` to nearest summit
- **Tactical mode**: toolbar toggle (Standard/Tactical) to reduce map to relevant summits only (alerted summits, recent-spotted summits, candidate-target summits)
- **Tactical lines**: activator→summit association lines with source styles (alert=solid, candidate=dashed, spot=dotted) and age-based opacity fade
- **Tactical source chips**: quick include/exclude of `Alerts`, `Recent spots` (60 min window), and `Candidates`
- **Auto-fit tactical**: one-click fit-to-bounds for tactical summits and active tactical lines
- **Debug log panel**: Toggleable side panel showing events
- Callsign country flags are shown (when resolvable) in activator-related UI text.
- Refreshes APRS positions every 60 seconds

## API Service Interfaces
```typescript
interface SotaAlert {
  callsign, summit, summitRef?, dateActivated?, summitName?, altitude?, points?,
  frequenciesComments?, frequency?, mode?, comments?, notified?, expiration?
}
interface SotaSpot {
  time, callsign, frequency, mode, summitRef, summitName, altitude, points,
  postedBy, comments, activatorCallsign?, summitCode?, timeStamp?
}
interface AprsPosition { callsign, latitude, longitude, altitude, lastSeen, history? }
interface AppConfig { telegramBotToken, telegramGroupId, telegramUserId,
                      frequencyFilterPattern, sotaAssociations,
                      activationZoneDistanceMeters, activationZoneAltitudeDeltaMeters }
```

## Alerts & Spots View
- Alerts table columns: Date/Time (UTC), Callsign, Summit Ref., Summit Name, Altitude, Points, Frequencies/Comments, Dist. to Summit, Status, Actions.
- Spots table columns: Time (UTC), Callsign, Frequency, Mode, Summit Ref., Summit Name, Altitude, Points, Posted By, Comments, Actions.
- Callsigns render with best-effort country flags from shared `callsign-flag.util.ts`; unknown prefixes show no flag.

## Environment Variables (set by Amplify)
```
ANGULAR_API_BASE_URL      → environment.apiBaseUrl
ANGULAR_WS_URL            → environment.wsUrl
ANGULAR_COGNITO_USER_POOL_ID → environment.cognitoUserPoolId
ANGULAR_COGNITO_CLIENT_ID → environment.cognitoClientId
ANGULAR_REGION            → environment.region
```

## Key Dependencies
```json
"@angular/core": "^19",
"primeng": "^19",
"@bluehalo/ngx-leaflet": "^19",
"leaflet": "^1.9",
"aws-amplify": "^6",
"rxjs": "^7"
```

## Build & Deploy
- Local build: `cd web && npx ng build --configuration production`
- Amplify auto-builds on git push to main
- Build config: `amplify.yml` in repo root
- Output: `web/dist/sota-watchtower-web/browser/`

## CSS Conventions
- CSS custom properties defined in `styles.scss` under `:root` and `.dark-theme`/`.light-theme`
- Key variables: `--surface-0`, `--surface-card`, `--text-color`, `--primary-color`, `--sidebar-width`
- Font: Inter (Google Fonts, loaded in index.html)
- No inline styles — all in component `.scss` files
