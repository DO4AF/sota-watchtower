# GitHub Copilot Instructions — SOTA Watchtower

## Central Knowledge Base
All project context, architecture, and conventions are documented in `cline_docs/`:
- `cline_docs/projectOverview.md` — What the project is, URLs, tech stack, credentials structure
- `cline_docs/architecture.md` — AWS architecture, data flow, DynamoDB schemas, API endpoints
- `cline_docs/frontendArchitecture.md` — Angular structure, components, services, routing, theme
- `cline_docs/backendArchitecture.md` — Lambda functions, EC2 APRS listener, summit CSV format
- `cline_docs/deploymentGuide.md` — How to deploy, Amplify, SAM, env vars
- `cline_docs/currentState.md` — Current status, recent changes, known issues
- `cline_docs/styleGuide.md` — UI conventions, colors, fonts, layout rules

**Always read the relevant cline_docs file before making changes.**

## Project Summary
SOTA Watchtower is a ham radio summit monitoring platform (Angular 19 + AWS SAM).
- Frontend: Angular 19, PrimeNG, Leaflet, hosted on AWS Amplify
- Backend: AWS Lambda (Python 3.12), API Gateway, DynamoDB, EC2 APRS listener
- Auth: AWS Cognito
- Region: eu-central-1

## Critical Rules

### Frontend
- All Angular components are **standalone** (no NgModules)
- Use `inject()` for dependency injection, not constructor injection
- Use Angular signals for local state where possible
- **Always run `cd web && npx ng build --configuration production` before committing** — Amplify build fails on TypeScript errors
- Dark mode is the default — never hardcode light mode
- Font: Inter (loaded in index.html via Google Fonts)
- Layout: Left sidebar navigation, NOT top navbar
- Map tiles: CARTO Dark Matter (dark) / CARTO Voyager (light)
- Summit markers: `L.circleMarker` colored by points (1-10, green→red), NO clustering
- Walker markers: freshness-based opacity/color, with trace polylines

### Backend
- Python 3.12 for all Lambda functions
- DynamoDB table names come from env vars (e.g., `APRSPOSITIONSTABLE_TABLE_NAME`), never hardcoded
- Always use `TABLE_NAME` env var, NOT `TABLE_ARN` for DynamoDB operations
- CORS headers must be included in all API responses
- `AprsPositionsTable` has composite key: PK=callsign, SK=timestamp (ISO8601)

### Deployment
- `./deploy.sh` handles full deploy (SAM + Amplify env sync + rebuild trigger)
- `.env` FREQUENCY_FILTER_PATTERN must be single-quoted if it contains parentheses
- Never commit `.env` — it's in `.gitignore`
- Stack name: `sota-watchtower-stack`, region: `eu-central-1`

## API Endpoints
| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | /aprs-positions | None | Returns walker positions with history |
| GET | /summits | Cognito | Returns GeoJSON |
| GET | /alerts | Cognito | Returns SOTA alerts |
| GET | /spots | Cognito | Returns SOTA spots |
| GET | /config | Cognito | Returns config key-value |
| PUT | /config | Cognito | Saves config |
| POST | /notify | None | HamAlert webhook (different API GW) |
