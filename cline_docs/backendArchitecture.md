# SOTA Watchtower — Backend Architecture

## SAM Template
- **File**: `template.yaml`
- **Transform**: AWS::Serverless-2016-10-31
- **Deploy**: `./deploy.sh` (wraps `sam deploy`)

## Lambda Functions Detail

### ActivationZoneMonitorFunction
- **Trigger**: Invoked by EC2 aprs-listener via boto3
- **Runtime**: Python 3.12
- **Layers**: GeopyLayer (geopy for distance calculation)
- **Key Logic**:
  1. Receives APRS position (callsign, lat, lon, alt)
  2. Stores position in AprsPositionsTable (with 2h TTL)
  3. Fetches all active SOTA alerts from SotaAlertsTable
  4. For each alert, checks if walker is within activation zone (distance + altitude)
  5. If in zone and not yet notified → invokes TelegramNotifyFunction + marks alert as notified
- **Env Vars**: SOTAALERTSTABLE_TABLE_NAME, APRSPOSITIONSTABLE_TABLE_NAME, TELEGRAM_GROUP_ID, LAMBDA_FUNCTION_NAME (TelegramNotify)

### GetAprsPositionsFunction
- **Trigger**: GET /aprs-positions (no Cognito auth)
- **Runtime**: Python 3.12
- **Returns**: All items from AprsPositionsTable as JSON array
- **CORS**: Enabled

### GetSummitsFunction
- **Trigger**: GET /summits (Cognito auth)
- **Runtime**: Python 3.12
- **Data**: Reads summitslist.csv (bundled with function)
- **Returns**: GeoJSON FeatureCollection
- **CSV Format**: SummitCode, AssociationName, RegionName, SummitName, AltMeters, AltFeet, Lon, Lat, Lon2, Lat2, Points, BonusPoints, ValidFrom, ValidTo, ActivationCount, LastActivationDate, LastActivatorCallsign

### HamAlertProcessFunction
- **Trigger**: POST /notify (HamAlertApi, no auth)
- **Runtime**: Python 3.12
- **Logic**: Parses HamAlert webhook, stores in SotaAlertsTable, invokes TelegramNotifyFunction

### GetAlertsWebFunction / GetSpotsWebFunction
- **Trigger**: GET /alerts, GET /spots (Cognito auth)
- **Runtime**: Python 3.12
- **GetAlertsWebFunction**:
  - Reads `SotaAlertsTable` and enriches with summit metadata from `SummitsTable`
  - Returns normalized/enriched alert rows for web table: `dateActivated`, `callsign`, `summitRef`, `summitName`, `altitude`, `points`, `frequenciesComments`, `notified`, etc.
- **GetSpotsWebFunction**:
  - Fetches recent SOTA spots, filters by configured associations, enriches with `SummitsTable`
  - Returns normalized spot rows: `time`, `callsign`, `frequency`, `mode`, `summitRef`, `summitName`, `altitude`, `points`, `postedBy`, `comments`

### GetConfigFunction / PutConfigFunction
- **Trigger**: GET/PUT /config (Cognito auth)
- **Runtime**: Python 3.12
- **Storage**: ConfigTable (key-value DynamoDB)
- **Config Keys**: telegramBotToken, telegramGroupId, telegramUserId, frequencyFilterPattern, sotaAssociations, activationZoneDistanceMeters, activationZoneAltitudeDeltaMeters

### TelegramNotifyFunction
- **Trigger**: Lambda invoke (from other functions)
- **Runtime**: Python 3.12
- **Env Vars**: TELEGRAM_BOT_TOKEN, TELEGRAM_USER_CHAT_ID, TELEGRAM_GROUP_CHAT_ID

### DailyBriefingFunction
- **Trigger**: EventBridge schedule (morning)
- **Runtime**: Python 3.12
- **Logic**: Fetches upcoming SOTA alerts, formats and sends via Telegram

### SeedConfigFunction
- **Trigger**: CloudFormation custom resource (on stack create)
- **Runtime**: Python 3.12
- **Logic**: Seeds initial config values into ConfigTable

### WebSocket Functions
- **WebSocketConnectFunction**: Stores connectionId in WebSocketConnectionsTable
- **WebSocketDisconnectFunction**: Removes connectionId
- **WebSocketBroadcastFunction**: Sends message to all active connections

## EC2 APRS Listener

### Location
`ec2/aprs-listener/`

### Files
- `aprs-listener.py` — Main script
- `aprs-listener.service` — systemd service unit
- `install.sh` — Installation script
- `requirements.txt` — aprslib, boto3

### How It Works
1. Connects to APRS-IS server: `rotate.aprs.net:14580`
2. Filter: `r/47.5/11.0/500` (radius filter around Alps)
3. Parses APRS packets using `aprslib`
4. Filters by SOTA associations (DL, OE, DM, HB, etc.)
5. Invokes `ActivationZoneMonitorFunction` via boto3 for each valid position
6. Logs to `/sota-watchtower/aprs-listener` CloudWatch log group

### IAM Role
`AprsMonitorInstanceRole` — allows:
- `lambda:InvokeFunction` on ActivationZoneMonitorFunction
- `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents`

## DynamoDB Table Schemas

### SotaAlertsTable
```
PK: callsign (String)
Attributes: summit, frequency, mode, comments, posterCallsign, dateActivated (ISO8601), notified (bool), expiration (TTL)
```

## Notes on Data Refresh
- `RefreshSummitsFunction` now parses SOTA CSV validity dates (`ValidFrom`/`ValidTo`, format `DD/MM/YYYY`) as real dates before filtering, preventing expired summits from entering `SummitsTable` / static `summits.json`.

### ConfigTable
```
PK: key (String)
Attributes: value (String)
```

### WebSocketConnectionsTable
```
PK: connectionId (String)
```

### AprsPositionsTable
```
PK: callsign (String)
SK: timestamp (String, ISO8601)
Attributes: latitude, longitude, altitude, lastSeen, ttl (Number, Unix epoch)
TTL attribute: ttl (2 hours from write)
```

## Summit Data
- **File**: `src/GetSummitsFunction/summitslist.csv` (also in ActivationZoneMonitorFunction)
- **Format**: 17 columns, no header
- **Columns**: SummitCode, AssociationName, RegionName, SummitName, AltMeters, AltFeet, Lon, Lat, Lon2, Lat2, Points, BonusPoints, ValidFrom, ValidTo, ActivationCount, LastActivationDate, LastActivatorCallsign
- **Points range**: 1–10 (used for marker coloring)
- **Associations tracked**: DL, OE, DM, HB, HB0, I, F (configurable)
