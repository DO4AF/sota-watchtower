# SOTA Watchtower — Deployment Guide

## Prerequisites
- AWS CLI configured with appropriate credentials
- SAM CLI installed (`pip install aws-sam-cli`)
- Node.js + npm (for local Angular builds)
- `.env` file in repo root (copy from `.env.example`)

## .env File
```bash
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_USER_CHAT_ID=<id>
TELEGRAM_GROUP_CHAT_ID=<id>
FREQUENCY_FILTER_PATTERN='<regex>'  # MUST be quoted if contains parens/special chars
ADMIN_EMAIL=admin@fruechtl.cloud
ADMIN_PASSWORD=<password>
```

⚠️ **Important**: `FREQUENCY_FILTER_PATTERN` must be single-quoted in .env if it contains `(` or `)` characters, otherwise bash will fail with syntax error when sourcing the file.

## Full Deploy (Backend + Frontend)
```bash
./deploy.sh
```

This script:
1. Sources `.env` for sensitive parameters
2. Runs `sam deploy` with parameter overrides
3. Reads CloudFormation stack outputs (API URL, WS URL, Cognito IDs)
4. Updates Amplify environment variables via `aws amplify update-app`
5. Triggers Amplify rebuild via `aws amplify start-job`

## Backend Only (SAM)
```bash
sam build && sam deploy --parameter-overrides \
  "TelegramBotToken=..." \
  "TelegramUserChatId=..." \
  ...
```

Or just use `./deploy.sh` which handles all of this.

## Frontend Only
```bash
git add -A && git commit -m "..." && git push origin main
```
Amplify auto-deploys on push to `main` branch.

## Local Frontend Build (for testing)
```bash
cd web
npx ng build --configuration production
```
Build output: `web/dist/sota-watchtower-web/browser/`

## Amplify Configuration
- **App ID**: d1e96ec1sckzck
- **Branch**: main
- **Build spec**: `amplify.yml` in repo root
- **Monorepo root**: `web/`
- **Build command**: `npm run build` (runs `ng build --configuration production`)
- **Output**: `dist/sota-watchtower-web/browser`

## Amplify Environment Variables (auto-set by deploy.sh)
```
AMPLIFY_DIFF_DEPLOY=false
AMPLIFY_MONOREPO_APP_ROOT=web
ANGULAR_API_BASE_URL=https://eklnc5wyab.execute-api.eu-central-1.amazonaws.com/Prod
ANGULAR_WS_URL=wss://2p8sa2gf6a.execute-api.eu-central-1.amazonaws.com/Prod
ANGULAR_COGNITO_USER_POOL_ID=eu-central-1_28VyKiw9R
ANGULAR_COGNITO_CLIENT_ID=5mkkjt1k52t1apd0s4kpikgp0o
ANGULAR_REGION=eu-central-1
```

## samconfig.toml
```toml
[amplify]
app_id = "d1e96ec1sckzck"
branch = "main"

[default.deploy.parameters]
stack_name = "sota-watchtower-stack"
region = "eu-central-1"
capabilities = "CAPABILITY_IAM"
```

## Checking Amplify Build Status
```bash
aws amplify list-jobs --app-id d1e96ec1sckzck --branch-name main \
  --max-results 3 --region eu-central-1 \
  --query "jobSummaries[*].{id:jobId,status:status}" --output table
```

## Checking Stack Resources
```bash
aws cloudformation list-stack-resources \
  --stack-name sota-watchtower-stack \
  --region eu-central-1 \
  --query "StackResourceSummaries[*].{Name:LogicalResourceId,Status:ResourceStatus}" \
  --output table
```

## Testing the API
```bash
# APRS positions (no auth)
curl https://eklnc5wyab.execute-api.eu-central-1.amazonaws.com/Prod/aprs-positions

# Summits (no auth in current config)
curl https://eklnc5wyab.execute-api.eu-central-1.amazonaws.com/Prod/summits
```

## EC2 APRS Listener
The EC2 instance runs `aprs-listener.service` (systemd). To check:
```bash
# SSH to EC2 instance
journalctl -u aprs-listener -f
```
The instance is managed by CloudFormation (AprsMonitorInstance resource).
