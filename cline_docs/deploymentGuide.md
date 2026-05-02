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

## Delete Stack (safe S3 cleanup first)
Use the helper script below instead of running `sam delete` directly. It empties all S3 buckets managed by the stack (including versioned objects and delete markers) before calling `sam delete`, which avoids `DELETE_FAILED` on bucket resources such as `SummitsBucket`.

```bash
./delete-stack.sh
```

Optional: pass additional `sam delete` arguments through to the script.

```bash
./delete-stack.sh --debug
```

`./deploy.sh` script behavior:
1. Sources `.env` for sensitive parameters
2. Runs `sam deploy` with parameter overrides
3. Reads CloudFormation stack outputs (API URL, WS URL, Cognito IDs)
4. Validates the pre-existing Amplify app + branch from `samconfig.toml`
5. Updates Amplify environment variables via `aws amplify update-app`
6. Enforces SPA rewrite custom rule (`/*` style regex → `/index.html`, HTTP 200)
7. Triggers Amplify rebuild via `aws amplify start-job`
8. Runs route header checks for `/alerts`, `/alerts/`, `/map` on default Amplify domain
9. (Optional) Runs same checks on custom domain if `CUSTOM_WEB_DOMAIN` is set in shell
10. Invokes `RefreshSummitsFunction` asynchronously to populate `SummitsTable`
11. Invokes `GetSotaAlertsFunction` asynchronously once to prefill `SotaAlertsTable`

## Amplify Ownership Model
- Amplify is **pre-existing** and is **not** created by `template.yaml` anymore.
- `deploy.sh` manages env vars/rewrite/build for that existing app via:
  - `samconfig.toml` → `[amplify].app_id`
  - `samconfig.toml` → `[amplify].branch`
- This avoids accidental deployment to an unused, stack-created Amplify app.

## Optional Custom Domain Validation
Set custom domain before running deploy (for route status checks in script output):

```bash
export CUSTOM_WEB_DOMAIN=watchtower.example.com
./deploy.sh
```

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
