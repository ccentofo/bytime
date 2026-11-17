#!/usr/bin/env bash
# Deploy the backup stack (feature-plan-database-backups.md §6.2 "deploy.sh"). Runs in the `deploy` job only, after the
# founder's approval, with the DeployRole's OIDC session. bash + docker + aws cli only: no npm, no node.
# Prints no account ids, ARNs or the alert email (the environment secrets are masked; the email is masked again).
set -euo pipefail

: "${REPOSITORY_URI:?REPOSITORY_URI is not set}"
: "${ARTIFACTS_BUCKET:?ARTIFACTS_BUCKET is not set}"
: "${ALERT_EMAIL:?ALERT_EMAIL is not set}"
: "${CFN_EXEC_ROLE_ARN:?CFN_EXEC_ROLE_ARN is not set}"
: "${GITHUB_SHA:?GITHUB_SHA is not set}"
echo "::add-mask::$ALERT_EMAIL"

STACK=cadenzpoint-backup
REPOSITORY=cadenzpoint-backup
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
template="$root/ops/aws/backup-stack.yml"

# ---- 1. stack state ---------------------------------------------------------------------------------------------
status=""
if out="$(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text 2>&1)"; then
  status="$out"
else
  case "$out" in
    *"does not exist"*) status="NONE" ;;
    *) echo "Could not read the stack state (describe-stacks failed)." >&2; exit 1 ;;
  esac
fi

check_retained_bucket() {
  local account bucket hb
  account="$(aws sts get-caller-identity --query Account --output text)"
  echo "::add-mask::$account"
  bucket="cadenzpoint-backups-$account"
  if hb="$(aws s3api head-bucket --bucket "$bucket" 2>&1)"; then
    hb="exists"
  fi
  case "$hb" in
    *"404"*|*"Not Found"*) return 0 ;;
    exists|*"403"*|*"Forbidden"*)
      echo "The backup bucket and key were retained from a deleted stack. Follow the runbook 'Re-create the backup stack' (import the retained bucket and key with a CloudFormation import change set, done with the lead)." >&2
      exit 1 ;;
    *) echo "Could not check for a retained backup bucket (head-bucket failed)." >&2; exit 1 ;;
  esac
}

case "$status" in
  NONE|REVIEW_IN_PROGRESS)
    check_retained_bucket ;;
  ROLLBACK_COMPLETE)
    echo "The first create failed and rolled back. In the AWS console, delete the stack \`$STACK\` (it holds nothing), then re-run this workflow." >&2
    exit 1 ;;
  UPDATE_ROLLBACK_FAILED)
    aws cloudformation continue-update-rollback --stack-name "$STACK" --role-arn "$CFN_EXEC_ROLE_ARN"
    echo "The update failed and is being rolled back (continue-update-rollback); check the run log, then re-run." >&2
    exit 1 ;;
  ROLLBACK_FAILED)
    echo "The stack is ROLLBACK_FAILED. Follow PRODUCTION-DEPLOY.md, Backups (AWS): 'Stack stuck in ROLLBACK_FAILED'." >&2
    exit 1 ;;
  DELETE_FAILED)
    echo "The stack is DELETE_FAILED. Follow PRODUCTION-DEPLOY.md, Backups (AWS): 'Stack stuck in DELETE_FAILED'." >&2
    exit 1 ;;
  *_IN_PROGRESS)
    echo "Another stack operation is running ($status); re-run this workflow when it finishes." >&2
    exit 1 ;;
  *) ;;
esac

# ---- 2. image (immutable tags: a re-run for the same commit reuses the pushed digest) --------------------------------
docker load -i image.tar >/dev/null
digest=""
if found="$(aws ecr describe-images --repository-name "$REPOSITORY" --image-ids imageTag="$GITHUB_SHA" --query 'imageDetails[0].imageDigest' --output text 2>&1)"; then
  digest="$found"
  echo "image for ${GITHUB_SHA:0:7} already pushed; reusing it"
else
  case "$found" in
    *ImageNotFoundException*) ;;
    *) echo "Could not look up the image (describe-images failed)." >&2; exit 1 ;;
  esac
  docker tag "backup:$GITHUB_SHA" "$REPOSITORY_URI:$GITHUB_SHA"
  docker push "$REPOSITORY_URI:$GITHUB_SHA" >/dev/null
  digest="$(aws ecr describe-images --repository-name "$REPOSITORY" --image-ids imageTag="$GITHUB_SHA" --query 'imageDetails[0].imageDigest' --output text)"
fi
case "$digest" in
  sha256:*) ;;
  *) echo "Unexpected image digest." >&2; exit 1 ;;
esac

# ---- 3. template check --------------------------------------------------------------------------------------------
key="templates/$GITHUB_SHA/backup-stack.yml"
aws s3 cp "$template" "s3://$ARTIFACTS_BUCKET/$key" --only-show-errors
aws cloudformation validate-template --template-url "https://$ARTIFACTS_BUCKET.s3.us-east-1.amazonaws.com/$key" >/dev/null

# ---- 4. deploy ----------------------------------------------------------------------------------------------------
aws cloudformation deploy \
  --stack-name "$STACK" \
  --template-file "$template" \
  --s3-bucket "$ARTIFACTS_BUCKET" \
  --role-arn "$CFN_EXEC_ROLE_ARN" \
  --parameter-overrides "ImageUri=$REPOSITORY_URI@$digest" "AlertEmail=$ALERT_EMAIL" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset >/dev/null

# ---- 5. report ----------------------------------------------------------------------------------------------------
final="$(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text)"
echo "deployed ${GITHUB_SHA:0:7}: $final"
