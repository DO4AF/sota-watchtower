#!/usr/bin/env bash
# deploy.sh — Deploy the SAM stack and sync Amplify environment variables.
# Usage: ./deploy.sh [extra sam deploy args]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAMCONFIG="$SCRIPT_DIR/samconfig.toml"

# Read Amplify config from samconfig.toml
AMPLIFY_APP_ID=$(grep -A5 '^\[amplify\]' "$SAMCONFIG" | grep 'app_id' | sed 's/.*=\s*"\(.*\)"/\1/')
AMPLIFY_BRANCH=$(grep -A5 '^\[amplify\]' "$SAMCONFIG" | grep 'branch' | sed 's/.*=\s*"\(.*\)"/\1/')
STACK_NAME=$(grep -A20 '^\[default\.deploy' "$SAMCONFIG" | grep 'stack_name' | sed 's/.*=\s*"\(.*\)"/\1/')
REGION=$(grep -A20 '^\[default\.deploy' "$SAMCONFIG" | grep 'region' | sed 's/.*=\s*"\(.*\)"/\1/')

echo "==> Deploying SAM stack: $STACK_NAME"
sam deploy "$@"

echo ""
echo "==> Reading stack outputs..."
OUTPUTS=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "Stacks[0].Outputs" \
  --output json)

API_URL=$(echo "$OUTPUTS"     | python3 -c "import sys,json; o={x['OutputKey']:x['OutputValue'] for x in json.load(sys.stdin)}; print(o.get('WatchtowerWebApiUrl',''))")
WS_URL=$(echo "$OUTPUTS"      | python3 -c "import sys,json; o={x['OutputKey']:x['OutputValue'] for x in json.load(sys.stdin)}; print(o.get('WatchtowerWsApiUrl',''))")
POOL_ID=$(echo "$OUTPUTS"     | python3 -c "import sys,json; o={x['OutputKey']:x['OutputValue'] for x in json.load(sys.stdin)}; print(o.get('CognitoUserPoolId',''))")
CLIENT_ID=$(echo "$OUTPUTS"   | python3 -c "import sys,json; o={x['OutputKey']:x['OutputValue'] for x in json.load(sys.stdin)}; print(o.get('CognitoClientId',''))")

echo "  API URL:          $API_URL"
echo "  WebSocket URL:    $WS_URL"
echo "  Cognito Pool ID:  $POOL_ID"
echo "  Cognito Client:   $CLIENT_ID"

echo ""
echo "==> Syncing Amplify env vars (app: $AMPLIFY_APP_ID, branch: $AMPLIFY_BRANCH)..."

# Get existing env vars we want to preserve (AMPLIFY_* keys set by Amplify itself)
EXISTING=$(aws amplify get-app --app-id "$AMPLIFY_APP_ID" \
  --query "app.environmentVariables" --output json)

AMPLIFY_DIFF_DEPLOY=$(echo "$EXISTING" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('AMPLIFY_DIFF_DEPLOY','false'))")
MONOREPO_ROOT=$(echo "$EXISTING"       | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('AMPLIFY_MONOREPO_APP_ROOT','web'))")

aws amplify update-app --app-id "$AMPLIFY_APP_ID" \
  --environment-variables "{
    \"AMPLIFY_DIFF_DEPLOY\": \"$AMPLIFY_DIFF_DEPLOY\",
    \"AMPLIFY_MONOREPO_APP_ROOT\": \"$MONOREPO_ROOT\",
    \"ANGULAR_API_BASE_URL\": \"$API_URL\",
    \"ANGULAR_WS_URL\": \"$WS_URL\",
    \"ANGULAR_COGNITO_USER_POOL_ID\": \"$POOL_ID\",
    \"ANGULAR_COGNITO_CLIENT_ID\": \"$CLIENT_ID\",
    \"ANGULAR_REGION\": \"$REGION\"
  }" \
  --query "app.environmentVariables" --output table

echo ""
echo "==> Triggering Amplify rebuild on branch: $AMPLIFY_BRANCH"
JOB_ID=$(aws amplify start-job \
  --app-id "$AMPLIFY_APP_ID" \
  --branch-name "$AMPLIFY_BRANCH" \
  --job-type RELEASE \
  --query "jobSummary.jobId" \
  --output text)

echo "    Build job started: #$JOB_ID"
echo "    Watch at: https://$AMPLIFY_BRANCH.$AMPLIFY_APP_ID.amplifyapp.com"
echo ""
echo "Done."
