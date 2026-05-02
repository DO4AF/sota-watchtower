#!/usr/bin/env bash
# delete-stack.sh — Empty stack-managed S3 buckets, then delete the SAM stack.
# Usage: ./delete-stack.sh [extra sam delete args]
set -euo pipefail
export AWS_PAGER=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SAMCONFIG="$SCRIPT_DIR/samconfig.toml"

STACK_NAME=$(grep -A20 '^\[default\.deploy' "$SAMCONFIG" | grep 'stack_name' | sed 's/.*=\s*"\(.*\)"/\1/')
REGION=$(grep -A20 '^\[default\.deploy' "$SAMCONFIG" | grep 'region' | sed 's/.*=\s*"\(.*\)"/\1/')

echo "==> Looking up S3 buckets in stack: $STACK_NAME ($REGION)"

BUCKETS=$(aws cloudformation list-stack-resources \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "StackResourceSummaries[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId" \
  --output text 2>/dev/null || true)

if [[ -z "${BUCKETS:-}" ]]; then
  echo "    No stack-managed S3 buckets found (or stack not present)."
else
  for bucket in $BUCKETS; do
    echo "==> Emptying s3://$bucket"

    # Delete current objects.
    aws s3 rm "s3://$bucket" --recursive --region "$REGION" >/dev/null || true

    # Delete versioned objects + delete markers if versioning is enabled.
    while true; do
      VERSION_PAYLOAD=$(aws s3api list-object-versions \
        --bucket "$bucket" \
        --region "$REGION" \
        --max-items 1000 \
        --output json 2>/dev/null \
        | python3 -c 'import sys,json; data=json.load(sys.stdin); objs=[{"Key":x["Key"],"VersionId":x["VersionId"]} for x in (data.get("Versions", []) + data.get("DeleteMarkers", []))]; print(json.dumps({"Objects": objs, "Quiet": True}))' \
        || echo '{"Objects":[],"Quiet":true}')

      VERSION_COUNT=$(echo "$VERSION_PAYLOAD" | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("Objects", [])))')
      if [[ "$VERSION_COUNT" -eq 0 ]]; then
        break
      fi

      aws s3api delete-objects \
        --bucket "$bucket" \
        --region "$REGION" \
        --delete "$VERSION_PAYLOAD" \
        >/dev/null 2>&1 || true
    done

    # Abort incomplete multipart uploads that can also block bucket deletion.
    while true; do
      UPLOADS=$(aws s3api list-multipart-uploads \
        --bucket "$bucket" \
        --region "$REGION" \
        --max-items 100 \
        --output json 2>/dev/null || echo '{"Uploads": []}')

      UPLOAD_COUNT=$(echo "$UPLOADS" | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("Uploads", [])))')
      if [[ "$UPLOAD_COUNT" -eq 0 ]]; then
        break
      fi

      echo "$UPLOADS" | python3 -c 'import sys,json; d=json.load(sys.stdin); [print(u["Key"] + "\t" + u["UploadId"]) for u in d.get("Uploads", [])]' \
        | while IFS=$'\t' read -r key upload_id; do
            aws s3api abort-multipart-upload \
              --bucket "$bucket" \
              --region "$REGION" \
              --key "$key" \
              --upload-id "$upload_id" \
              >/dev/null 2>&1 || true
          done
    done
  done
fi

echo ""
echo "==> Deleting SAM stack: $STACK_NAME"
sam delete \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --no-prompts \
  "$@"
