#!/usr/bin/env bash
# The Export workspace button (feature-plan-cloud-export.md §6.4), run by .github/workflows/export-workspace.yml after the
# founder approves the `aws-disaster` environment. It starts ONE export task in the backup AWS account and waits for it.
# 3c's button pattern (disaster-button.sh). Bash 3.2 and 5 (no associative arrays, no ${x,,}, no mapfile). Never `set -x`.
#
#   bash scripts/backup/export-button.sh          read the inputs, validate, start the task, wait, report
#   bash scripts/backup/export-button.sh --stop   stop every task this run started (the workflow's cancelled() step)
#
# Public logs (the repo is public): the inputs are read from the event file, never from `env:` or `${{ }}`; the target,
# both address inputs and the reason are masked before anything else prints; every AWS call either captures one field
# (--query … --output text) or goes to /dev/null. The address and reason do reach the RunTask call's overrides, which
# CloudTrail records in the backup account (founder-only; accepted, §6.4). The task logs only the reason's length.
# No EXIT trap: a `set -e` abort or the 60-minute exit never stops the task. INT/TERM traps are a second line behind the
# workflow's `if: cancelled()` step.
set -euo pipefail

CLUSTER=cadenzpoint-backup
FAMILY=cadenzpoint-backup-export
STACK=cadenzpoint-backup
CONTAINER=export
WAIT_POLLS=60 # one per minute: the task's 45-minute deadline plus its 5-minute hard exit, inside the 75-minute job
UUID='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
EMAIL='^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$'

: "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}"
STARTED_BY="gh-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"

fail() { echo "refused: $1"; exit 1; }

stop_tasks() {
  local arns="" i
  for i in 1 2 3; do
    # startedBy must be the only filter (AWS ListTasks); --cluster is not a filter.
    arns=$(aws ecs list-tasks --cluster "$CLUSTER" --started-by "$STARTED_BY" --query 'taskArns' --output text 2>/dev/null || true)
    if [ -n "$arns" ] && [ "$arns" != "None" ]; then break; fi
    arns=""
    if [ "$i" -lt 3 ]; then sleep 10; fi
  done
  if [ -z "$arns" ]; then
    echo "no running export task from this run"
    return 0
  fi
  local n=0 arn
  for arn in $arns; do
    aws ecs stop-task --cluster "$CLUSTER" --task "$arn" --reason "button run cancelled" >/dev/null 2>&1 || true
    n=$((n + 1))
  done
  echo "stop requested for $n export task(s) from this run"
}

if [ "${1:-}" = "--stop" ]; then
  stop_tasks
  exit 0
fi
if [ "$#" -gt 0 ]; then fail "unknown argument"; fi

# ---- 1. read and mask ------------------------------------------------------------------------------------------------
: "${GITHUB_EVENT_PATH:?}"
# A newline or carriage return in any input (possible through the API or gh, not the form) would defeat both the masking
# and the validation, so it is refused before anything is printed, and the message prints no value.
if jq -e '[(.inputs // {})[] | strings | test("[\\r\\n]")] | any' "$GITHUB_EVENT_PATH" >/dev/null; then
  fail "inputs must be a single line"
fi
MODE=$(jq -r '.inputs.mode // ""' "$GITHUB_EVENT_PATH")
TARGET=$(jq -r '.inputs.target // ""' "$GITHUB_EVENT_PATH")
EXTRA=$(jq -r '.inputs.extra_recipient // ""' "$GITHUB_EVENT_PATH")
EXTRA_AGAIN=$(jq -r '.inputs.extra_recipient_again // ""' "$GITHUB_EVENT_PATH")
REASON=$(jq -r '.inputs.reason // ""' "$GITHUB_EVENT_PATH")
CONFIRM=$(jq -r '.inputs.confirm // ""' "$GITHUB_EVENT_PATH")

# Mask before anything else can print: the target, both address inputs, the reason. GitHub unescapes %25 (and %0D, %0A)
# in workflow-command data, so `%` is escaped first, or a value holding "%25" would register a different mask (FR9).
for value in "$TARGET" "$EXTRA" "$EXTRA_AGAIN" "$REASON"; do
  if [ -n "$value" ]; then echo "::add-mask::${value//%/%25}"; fi
done

case "$MODE" in deliver|hold|release) ;; *) fail "mode must be deliver, hold or release" ;; esac
if [ "$CONFIRM" != "$MODE" ]; then fail "confirm must be exactly: $MODE"; fi
if ! printf '%s' "$TARGET" | grep -Eq "$UUID"; then
  if [ "$MODE" = release ]; then fail "target must be a hold id (uuid, lowercase)"; fi
  fail "target must be a workspace id (uuid, lowercase)"
fi
# An extra address is only for deliver (§6.4), refused before any AWS call.
if [ "$MODE" != deliver ] && { [ -n "$EXTRA" ] || [ -n "$EXTRA_AGAIN" ]; }; then fail "an extra address is only for deliver"; fi
if [ -n "$EXTRA" ] || [ -n "$EXTRA_AGAIN" ]; then
  # Typed twice, and both must match exactly (A4: plus the founder's own check out of band, recorded in the reason).
  if [ "$EXTRA" != "$EXTRA_AGAIN" ]; then fail "the two extra address inputs don't match"; fi
  case "$EXTRA" in -*) fail "the extra address can't start with -" ;; esac
  if [ "${#EXTRA}" -gt 254 ] || ! printf '%s' "$EXTRA" | grep -Eq "$EMAIL"; then fail "the extra address must be one email address (at most 254 characters)"; fi
fi
if [ -z "$REASON" ]; then
  if [ "$MODE" != deliver ]; then fail "a reason is required for $MODE"; fi
  if [ -n "$EXTRA" ]; then fail "a reason is required for deliver with an extra address"; fi
else
  case "$REASON" in -*) fail "the reason can't start with -" ;; esac
  if [ "${#REASON}" -gt 200 ]; then fail "the reason must be at most 200 characters"; fi
  if printf '%s' "$REASON" | LC_ALL=C grep -q '[[:cntrl:]]'; then fail "the reason can't contain control characters"; fi
  if [ -z "$(printf '%s' "$REASON" | tr -d '[:space:]')" ]; then fail "the reason can't be blank"; fi
fi

# ---- 2. one run at a time ----------------------------------------------------------------------------------------------
RUNNING=$(aws ecs list-tasks --cluster "$CLUSTER" --family "$FAMILY" --desired-status RUNNING --query 'length(taskArns)' --output text)
if [ "$RUNNING" != "0" ]; then fail "an export task is already running: wait for it, then press again"; fi

# ---- 3. start ----------------------------------------------------------------------------------------------------------
# An image older than this button can't run the export task: the stack lists the modes its image runs (§6.4). A stack from
# before 3d has no such output.
MODES=$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='ExportModes'].OutputValue" --output text)
if [ -z "$MODES" ] || [ "$MODES" = None ]; then MODES=""; fi
case " $MODES " in
  *" $MODE "*) ;;
  *) fail "the Backup system deploy that adds the export task is pending approval: approve it in GitHub, then press again" ;;
esac
SUBNETS=$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='TaskSubnets'].OutputValue" --output text)
SG=$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='TaskSecurityGroup'].OutputValue" --output text)
if [ -z "$SUBNETS" ] || [ "$SUBNETS" = None ] || [ -z "$SG" ] || [ "$SG" = None ]; then fail "the backup stack has no TaskSubnets/TaskSecurityGroup outputs (approve the pending Backup system deploy)"; fi
TARGET_FLAG=--workspace
if [ "$MODE" = release ]; then TARGET_FLAG=--hold; fi
OVERRIDES=$(jq -cn --arg c "$CONTAINER" --arg m "$MODE" --arg f "$TARGET_FLAG" --arg t "$TARGET" --arg e "$EXTRA" --arg r "$REASON" --arg id "$STARTED_BY" \
  '{containerOverrides: [{name: $c, command: (["export", $m, $f, $t] + (if $e != "" then ["--extra", $e] else [] end) + (if $r != "" then ["--reason", $r] else [] end) + ["--run-id", $id])}]}')
STARTED=$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$FAMILY" --launch-type FARGATE --count 1 \
  --started-by "$STARTED_BY" \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=ENABLED}" \
  --overrides "$OVERRIDES" \
  --query '[tasks[0].taskArn, length(failures), failures[0].reason]' --output text)
TASK_ARN=$(printf '%s' "$STARTED" | awk -F'\t' '{print $1}')
FAILURES=$(printf '%s' "$STARTED" | awk -F'\t' '{print $2}')
if [ -z "$TASK_ARN" ] || [ "$TASK_ARN" = None ] || [ "$FAILURES" != "0" ]; then
  fail "the task didn't start: $(printf '%s' "$STARTED" | awk -F'\t' '{print $3}')"
fi
echo "export task started ($MODE, run $STARTED_BY); the start is emailed"

trap 'echo "cancel received: stopping the task"; stop_tasks; exit 130' INT
trap 'echo "termination received: stopping the task"; stop_tasks; exit 143' TERM

# ---- 4. wait (no `aws ecs wait`) --------------------------------------------------------------------------------------
STATUS="" STOP_CODE="" EXIT_CODE=""
polls=0
while [ "$polls" -lt "$WAIT_POLLS" ]; do
  sleep 60 & wait $!
  polls=$((polls + 1))
  if ! LINE=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --query 'tasks[0].[lastStatus,stopCode,containers[0].exitCode]' --output text 2>/dev/null); then
    continue # a failed describe is retried at the next poll
  fi
  STATUS=$(printf '%s' "$LINE" | awk -F'\t' '{print $1}')
  if [ "$STATUS" = STOPPED ]; then
    STOP_CODE=$(printf '%s' "$LINE" | awk -F'\t' '{print $2}')
    EXIT_CODE=$(printf '%s' "$LINE" | awk -F'\t' '{print $3}')
    break
  fi
done

# ---- 5. report --------------------------------------------------------------------------------------------------------
if [ "$STATUS" != STOPPED ]; then
  echo "still running after 60 minutes; its result will be emailed (run $STARTED_BY)"
  exit 1
fi
if [ -z "$EXIT_CODE" ] || [ "$EXIT_CODE" = None ]; then
  echo "the task didn't start: ${STOP_CODE:-unknown}"
  exit 1
fi
if [ "$EXIT_CODE" = 2 ]; then
  echo "this image is older than the button: approve the pending Backup system deploy, then press again"
  exit 2
fi
echo "export task finished: exit $EXIT_CODE; run $STARTED_BY; the result is emailed ('export delivered', 'export held', 'export released', or the refusal)"
exit "$EXIT_CODE"
