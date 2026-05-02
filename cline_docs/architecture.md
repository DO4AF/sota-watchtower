# SOTA Watchtower — Architecture

## Data Flow

```
APRS-IS Network
    │
    ▼
EC2 (aprs-listener.py)
    │  publishes to AWS Lambda via boto3
    ▼
ActivationZoneMonitorFunction
    │  ├─ stores position in AprsPositionsTable (DynamoDB)
    │  ├─ checks if near a SOTA summit (geopy)
    │  └─ if in zone → TelegramNotifyFunction → Telegram

HamAlert Webhook
    │
    ▼
HamAlertApi (API Gateway)
    │
    ▼
HamAlertProcessFunction
    │  ├─ stores alert in SotaAlertsTable
    │  └─ TelegramNotifyFunction → Telegram

SOTA API (external)
    │
    ▼
GetSotaAlertsFunction (scheduled)
    │  └─ stores in SotaAlertsTable

Web Browser
    │
    ▼
WatchtowerWebApi (API Gateway + Cognito)
    │  ├─ GET /summits → GetSummitsFunction
    │  ├─ GET /alerts → GetAlertsWebFunction
    │  ├─ GET /spots → GetSpotsWebFunction
    │  ├─ GET /aprs-positions → GetAprsPositionsFunction (no auth)
    │  ├─ GET /config → GetConfigFunction
    │  └─ PUT /config → PutConfigFunction

WatchtowerWsApi (WebSocket)
    │  ├─ $connect → WebSocketConnectFunction
    │  ├─ $disconnect → WebSocketDisconnectFunction
    │  └─ broadcast → WebSocketBroadcastFunction
```

## DynamoDB Tables

| Table | PK | SK | TTL | Purpose |
|-------|----|----|-----|---------|
| SotaAlertsTable | callsign | - | expiration | SOTA alerts from HamAlert |
| ConfigTable | key | - | - | App configuration key-value store |
| WebSocketConnectionsTable | connectionId | - | - | Active WebSocket connections |
| AprsPositionsTable | callsign | timestamp | ttl (2h) | APRS walker positions with history |

### AprsPositionsTable Schema
```
PK: callsign (String) — e.g. "OE8PIT-7"
SK: timestamp (String) — ISO8601 e.g. "2026-05-01T15:30:00"
latitude: String
longitude: String
altitude: String
lastSeen: String (ISO8601)
ttl: Number (Unix epoch, 2 hours from write)
```

## Lambda Functions

| Function | Trigger | Purpose |
|----------|---------|---------|
| HamAlertProcessFunction | API GW POST /notify | Process HamAlert webhook |
| GetSotaAlertsFunction | EventBridge schedule | Fetch SOTA alerts from API |
| GetSotaSpotsFunction | EventBridge schedule | Fetch SOTA spots from API |
| DailyBriefingFunction | EventBridge schedule (morning) | Send daily Telegram briefing |
| TelegramNotifyFunction | Lambda invoke | Send Telegram messages |
| ActivationZoneMonitorFunction | Lambda invoke (from EC2) | Process APRS positions |
| GetAprsPositionsFunction | API GW GET /aprs-positions | Return walker positions (no auth) |
| GetSummitsFunction | API GW GET /summits | Return GeoJSON summit data |
| GetAlertsWebFunction | API GW GET /alerts | Return alerts (Cognito auth) |
| GetSpotsWebFunction | API GW GET /spots | Return spots (Cognito auth) |
| GetConfigFunction | API GW GET /config | Return config (Cognito auth) |
| PutConfigFunction | API GW PUT /config | Save config (Cognito auth) |
| SeedConfigFunction | CloudFormation custom resource | Seed initial config |
| WebSocketConnectFunction | WS $connect | Store connection ID |
| WebSocketDisconnectFunction | WS $disconnect | Remove connection ID |
| WebSocketBroadcastFunction | Lambda invoke | Broadcast to all WS clients |

## EC2 Instance
- **Type**: t3.micro
- **OS**: Amazon Linux 2
- **Service**: aprs-listener.service (systemd)
- **Script**: ec2/aprs-listener/aprs-listener.py
- **Function**: Connects to APRS-IS (rotate.aprs.net:14580), filters by SOTA associations, invokes ActivationZoneMonitorFunction via boto3

## API Gateway

### WatchtowerWebApi (REST)
- **Auth**: Cognito User Pool authorizer (except /aprs-positions which is open)
- **CORS**: Enabled
- **Stage**: Prod

### WatchtowerWsApi (WebSocket)
- **Stage**: Prod
- **Routes**: $connect, $disconnect

### HamAlertApi (REST)
- **Auth**: None (webhook endpoint)
- **Route**: POST /notify

## Amplify Hosting
- **App ID**: d1e96ec1sckzck
- **Branch**: main
- **Ownership model**: pre-existing Amplify app (not created by CloudFormation/SAM)
- **Build**: Angular production build (ng build --configuration production)
- **Root**: web/
- **Auto-deploy**: On git push to main
- **Env vars**: Set by deploy.sh via `aws amplify update-app`
- **SPA rewrites**: enforced by deploy.sh custom rule (`regex -> /index.html`, HTTP 200) to prevent deep-link refresh 404s (e.g. `/alerts/`)

## CloudWatch Dashboard
- **Name**: SOTA-Watchtower-Dashboard
- **Widgets**: APRS data stream (log query), Country (log query), Last callsign (log query), Lambda metrics
- **Log group**: /sota-watchtower/aprs-listener (on EC2)
