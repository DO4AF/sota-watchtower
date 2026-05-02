#!/usr/bin/env bash
# deploy.sh — Deploy the SAM stack and sync a pre-existing Amplify app.
# Usage: ./deploy.sh [extra sam deploy args]
set -euo pipefail
export AWS_PAGER=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAMCONFIG="$SCRIPT_DIR/samconfig.toml"
ENV_FILE="$SCRIPT_DIR/.env"

# Load sensitive parameters from .env
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found. Copy .env.example to .env and fill in values."
  exit 1
fi
set -a
# shellcheck source=.env
source "$ENV_FILE"
set +a

# Read Amplify config from samconfig.toml
AMPLIFY_APP_ID=$(grep -A5 '^\[amplify\]' "$SAMCONFIG" | grep 'app_id' | sed 's/.*=\s*"\(.*\)"/\1/')
AMPLIFY_BRANCH=$(grep -A5 '^\[amplify\]' "$SAMCONFIG" | grep 'branch' | sed 's/.*=\s*"\(.*\)"/\1/')
STACK_NAME=$(grep -A20 '^\[default\.deploy' "$SAMCONFIG" | grep 'stack_name' | sed 's/.*=\s*"\(.*\)"/\1/')
REGION=$(grep -A20 '^\[default\.deploy' "$SAMCONFIG" | grep 'region' | sed 's/.*=\s*"\(.*\)"/\1/')
CUSTOM_WEB_DOMAIN="${CUSTOM_WEB_DOMAIN:-}"

if [[ -z "$AMPLIFY_APP_ID" || -z "$AMPLIFY_BRANCH" ]]; then
  echo "ERROR: Missing [amplify] app_id/branch in $SAMCONFIG"
  exit 1
fi

if [[ -z "$STACK_NAME" || -z "$REGION" ]]; then
  echo "ERROR: Missing [default.deploy.parameters] stack_name/region in $SAMCONFIG"
  exit 1
fi

echo "==> Validating pre-existing Amplify app and branch..."
aws amplify get-app --app-id "$AMPLIFY_APP_ID" --region "$REGION" --query "app.appId" --output text >/dev/null
aws amplify get-branch --app-id "$AMPLIFY_APP_ID" --branch-name "$AMPLIFY_BRANCH" --region "$REGION" --query "branch.branchName" --output text >/dev/null

DESIRED_CUSTOM_RULES='[{"source":"</^((?!\\.(css|gif|ico|jpg|js|png|txt|svg|woff|ttf|map|json)$).)*$/>","target":"/index.html","status":"200"}]'

echo "==> Deploying SAM stack: $STACK_NAME"
sam deploy \
  --parameter-overrides \
    "TelegramBotToken=${TELEGRAM_BOT_TOKEN}" \
    "TelegramUserChatId=${TELEGRAM_USER_CHAT_ID}" \
    "TelegramGroupChatId=${TELEGRAM_GROUP_CHAT_ID}" \
    "FrequencyFilterPattern=${FREQUENCY_FILTER_PATTERN}" \
    "AdminEmail=${ADMIN_EMAIL}" \
    "AdminPassword=${ADMIN_PASSWORD}" \
  "$@"

echo ""
echo "==> Reading stack outputs..."
OUTPUTS=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "Stacks[0].Outputs" \
  --output json)

API_URL=$(echo "$OUTPUTS"       | python3 -c "import sys,json; o={x['OutputKey']:x['OutputValue'] for x in json.load(sys.stdin)}; print(o.get('WatchtowerWebApiUrl',''))")
WS_URL=$(echo "$OUTPUTS"        | python3 -c "import sys,json; o={x['OutputKey']:x['OutputValue'] for x in json.load(sys.stdin)}; print(o.get('WatchtowerWsApiUrl',''))")
POOL_ID=$(echo "$OUTPUTS"       | python3 -c "import sys,json; o={x['OutputKey']:x['OutputValue'] for x in json.load(sys.stdin)}; print(o.get('CognitoUserPoolId',''))")
CLIENT_ID=$(echo "$OUTPUTS"     | python3 -c "import sys,json; o={x['OutputKey']:x['OutputValue'] for x in json.load(sys.stdin)}; print(o.get('CognitoClientId',''))")
SUMMITS_URL=$(echo "$OUTPUTS"   | python3 -c "import sys,json; o={x['OutputKey']:x['OutputValue'] for x in json.load(sys.stdin)}; print(o.get('SummitsBucketUrl',''))")

echo "  API URL:          $API_URL"
echo "  WebSocket URL:    $WS_URL"
echo "  Cognito Pool ID:  $POOL_ID"
echo "  Cognito Client:   $CLIENT_ID"
echo "  Summits URL:      $SUMMITS_URL"

echo ""
echo "==> Syncing Amplify env vars (app: $AMPLIFY_APP_ID, branch: $AMPLIFY_BRANCH)..."

# Get existing env vars we want to preserve (AMPLIFY_* keys set by Amplify itself)
EXISTING=$(aws amplify get-app --app-id "$AMPLIFY_APP_ID" --region "$REGION" \
  --query "app.environmentVariables" --output json)

AMPLIFY_DIFF_DEPLOY=$(echo "$EXISTING" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('AMPLIFY_DIFF_DEPLOY','false'))")
MONOREPO_ROOT=$(echo "$EXISTING"       | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('AMPLIFY_MONOREPO_APP_ROOT','web'))")

aws amplify update-app --app-id "$AMPLIFY_APP_ID" --region "$REGION" \
  --environment-variables "{
    \"AMPLIFY_DIFF_DEPLOY\": \"$AMPLIFY_DIFF_DEPLOY\",
    \"AMPLIFY_MONOREPO_APP_ROOT\": \"$MONOREPO_ROOT\",
    \"ANGULAR_API_BASE_URL\": \"$API_URL\",
    \"ANGULAR_WS_URL\": \"$WS_URL\",
    \"ANGULAR_COGNITO_USER_POOL_ID\": \"$POOL_ID\",
    \"ANGULAR_COGNITO_CLIENT_ID\": \"$CLIENT_ID\",
    \"ANGULAR_REGION\": \"$REGION\",
    \"ANGULAR_SUMMITS_URL\": \"$SUMMITS_URL\"
  }" \
  --custom-rules "$DESIRED_CUSTOM_RULES" \
  --query "app.environmentVariables" --output table

echo ""
echo "==> Confirming Amplify SPA rewrite rules..."
aws amplify get-app --app-id "$AMPLIFY_APP_ID" --region "$REGION" \
  --query "app.customRules" --output table

echo ""
echo "==> Triggering Amplify rebuild on branch: $AMPLIFY_BRANCH"
JOB_ID=$(aws amplify start-job \
  --app-id "$AMPLIFY_APP_ID" \
  --branch-name "$AMPLIFY_BRANCH" \
  --region "$REGION" \
  --job-type RELEASE \
  --query "jobSummary.jobId" \
  --output text)

echo "    Build job started: #$JOB_ID"
DEFAULT_WEB_URL="https://$AMPLIFY_BRANCH.$AMPLIFY_APP_ID.amplifyapp.com"
echo "    Watch at: $DEFAULT_WEB_URL"

normalize_base_url() {
  local domain="$1"
  if [[ -z "$domain" ]]; then
    return 0
  fi
  if [[ "$domain" =~ ^https?:// ]]; then
    printf '%s\n' "$domain"
  else
    printf 'https://%s\n' "$domain"
  fi
}

check_route() {
  local base_url="$1"
  local route="$2"
  local headers
  headers=$(curl -sSI "${base_url}${route}" | tr -d '\r')
  local status
  status=$(echo "$headers" | awk 'NR==1 {print $2}')
  local location
  location=$(echo "$headers" | awk 'tolower($1)=="location:" {print $2; exit}')
  printf '    %-40s -> HTTP %s' "${base_url}${route}" "${status:-?}"
  if [[ -n "$location" ]]; then
    printf ' (Location: %s)' "$location"
  fi
  printf '\n'
}

echo ""
echo "==> Route header checks (expect SPA routes to end up as HTTP 200 after rewrite handling)"
for route in /alerts /alerts/ /map; do
  check_route "$DEFAULT_WEB_URL" "$route"
done

if [[ -n "$CUSTOM_WEB_DOMAIN" ]]; then
  CUSTOM_BASE_URL=$(normalize_base_url "$CUSTOM_WEB_DOMAIN")
  echo ""
  echo "==> Custom domain route checks: $CUSTOM_BASE_URL"
  for route in /alerts /alerts/ /map; do
    check_route "$CUSTOM_BASE_URL" "$route"
  done
fi

echo ""
echo "==> Invoking RefreshSummitsFunction to populate SummitsTable..."
REFRESH_FN=$(aws cloudformation describe-stack-resources \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "StackResources[?LogicalResourceId=='RefreshSummitsFunction'].PhysicalResourceId" \
  --output text 2>/dev/null || echo "")

if [[ -n "$REFRESH_FN" ]]; then
  aws lambda invoke \
    --function-name "$REFRESH_FN" \
    --region "$REGION" \
    --payload '{}' \
    /tmp/refresh-summits-out.json > /dev/null 2>&1 &
  REFRESH_PID=$!
  echo "    RefreshSummitsFunction invoked asynchronously (PID: $REFRESH_PID)"
  echo "    This will take ~60s. Check /tmp/refresh-summits-out.json for result."
else
  echo "    WARNING: Could not find RefreshSummitsFunction — skipping summit population."
fi

echo ""
echo "==> Invoking GetSotaAlertsFunction once to prefill SotaAlertsTable..."
ALERTS_FN=$(aws cloudformation describe-stack-resources \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "StackResources[?LogicalResourceId=='GetSotaAlertsFunction'].PhysicalResourceId" \
  --output text 2>/dev/null || echo "")

if [[ -n "$ALERTS_FN" ]]; then
  aws lambda invoke \
    --function-name "$ALERTS_FN" \
    --region "$REGION" \
    --payload '{}' \
    /tmp/get-sota-alerts-out.json > /dev/null 2>&1 &
  ALERTS_PID=$!
  echo "    GetSotaAlertsFunction invoked asynchronously (PID: $ALERTS_PID)"
  echo "    Check /tmp/get-sota-alerts-out.json for result."
else
  echo "    WARNING: Could not find GetSotaAlertsFunction — skipping initial alerts prefill."
fi

echo ""
echo "Done."
