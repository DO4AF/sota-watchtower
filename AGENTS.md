# Project Metadata

## Title
SOTA Watchtower

## Short Description
Real-time APRS-driven SOTA activator monitoring with automatic summit-zone detection.

## Detailed Description
A functional proof-of-concept that integrates APRS telemetry with SOTA activity data to automatically identify likely summit activations in near real-time. The system ingests APRS position reports from APRS-IS, correlates callsigns with active SOTA alerts, performs geo-proximity checks against summit coordinates, and publishes notifications via a Telegram bot. Also includes an Angular 19 web dashboard for live map monitoring of APRS walkers, summit zones, and tactical relevance scoring. Deployed as an AWS SAM serverless stack.

## Intent
Experiment – validate an APRS-first detection workflow for SOTA activators.

## Stack
- AWS SAM / CloudFormation
- AWS Lambda (Python — APRS ingestion, correlation engine)
- API Gateway (WebSocket + REST)
- DynamoDB (state persistence)
- Angular 19 (frontend dashboard)
- Telegram Bot API (notifications)
- APRS-IS (real-time position feed)

## Status
Proof-of-concept – functional and deployed; not a replacement for SOTLAS.

## Architecture
```
APRS-IS ──► EC2 Listener ──► Lambda (ingestion)
                                  │
                                  ▼
                           DynamoDB (activator state)
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
             Lambda (correlation)         Lambda (notification)
                    │                           │
                    ▼                           ▼
            Angular Dashboard            Telegram Bot
```

## Key Features
- **APRS-IS Integration**: Connects to `rotate.aprs.net:14580` with dynamic area filters and deduplication.
- **Activator Detection**: Correlates APRS callsigns with SOTA alerts; performs summit-zone proximity checks with altitude thresholds.
- **Web Dashboard**: Angular 19 with real-time map, alerts, spots, tactical view, and configuration UI.
- **Telegram Pipeline**: HamAlert-forwarded events and automatic activation notifications.

## Key Notes
- SSID-insensitive matching for APRS/alert correlation.
- Duplicate notification suppression via DynamoDB state tracking.
- Open source under GPL-3.0.
