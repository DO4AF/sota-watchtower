# SOTA Watchtower — Project Overview

## What It Is
SOTA Watchtower is a ham radio summit monitoring platform. It tracks SOTA (Summits On The Air) activators via APRS (Automatic Packet Reporting System), sends Telegram notifications, and provides a real-time web dashboard showing summit alerts, spots, and walker positions on a map.

## Live URLs
- **Web App**: https://main.d1e96ec1sckzck.amplifyapp.com
- **REST API**: https://eklnc5wyab.execute-api.eu-central-1.amazonaws.com/Prod
- **WebSocket**: wss://2p8sa2gf6a.execute-api.eu-central-1.amazonaws.com/Prod
- **HamAlert Webhook**: https://2uiu0zunw9.execute-api.eu-central-1.amazonaws.com/Prod/notify
- **CloudWatch Dashboard**: https://eu-central-1.console.aws.amazon.com/cloudwatch/home?region=eu-central-1#dashboards/dashboard/SOTA-Watchtower-Dashboard

## AWS Account & Region
- **Region**: eu-central-1 (Frankfurt)
- **Account**: 362007790881
- **Stack Name**: sota-watchtower-stack
- **Amplify App ID**: d1e96ec1sckzck

## Tech Stack
| Layer | Technology |
|-------|-----------|
| Frontend | Angular 19, PrimeNG, Leaflet, TypeScript |
| Hosting | AWS Amplify (GitHub auto-deploy) |
| Auth | AWS Cognito (User Pool + App Client) |
| Backend | AWS SAM (Lambda + API Gateway) |
| Database | DynamoDB (4 tables) |
| APRS Ingest | EC2 t3.micro (Python, aprslib) |
| Notifications | Telegram Bot API |
| Monitoring | CloudWatch Dashboard |

## Key Features
1. **APRS Walker Tracking** — EC2 listens to APRS-IS, Lambda stores positions, map shows walkers with traces
2. **SOTA Alerts** — HamAlert webhook → Lambda → DynamoDB → Telegram + Web UI
3. **SOTA Spots** — Polled from SOTA API, shown in alerts table
4. **Summit Map** — All SOTA summits shown as colored dots (by points), no clustering
5. **Daily Briefing** — Morning Telegram message with upcoming activations
6. **Config UI** — Web UI to configure Telegram tokens, frequency filters, SOTA associations

## Credentials & Secrets (in .env, never committed)
```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_USER_CHAT_ID=...
TELEGRAM_GROUP_CHAT_ID=...
FREQUENCY_FILTER_PATTERN='...'  # must be quoted if contains parens
ADMIN_EMAIL=admin@fruechtl.cloud
ADMIN_PASSWORD=...
```

## Cognito
- **User Pool ID**: eu-central-1_28VyKiw9R
- **Client ID**: 5mkkjt1k52t1apd0s4kpikgp0o
- Single admin user, email/password auth

## Deployment
See `cline_docs/deploymentGuide.md` for full deployment instructions.
Run `./deploy.sh` to deploy backend + sync Amplify env vars + trigger rebuild.
