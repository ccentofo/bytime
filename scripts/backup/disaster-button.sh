#!/usr/bin/env bash
# The Disaster restore button (feature-plan-disaster-restore.md §6.1), run by .github/workflows/disaster-restore.yml
# after the founder approves the `aws-disaster` environment. It starts ONE disaster task in the backup AWS account and
# waits for it. Bash 3.2 and 5 (no associative arrays, no ${x,,}, no mapfile). Never `set -x`.
#
#   bash scripts/backup/disaster-button.sh          read the inputs, validate, start the task, wait, report
#   bash scripts/backup/disaster-button.sh --stop   stop every task this run started (the workflow's cancelled() step)
#
# Public logs (the repo is public): the inputs are read from the event file, never from `env:` or `${{ }}`; every target is
# masked before anything else; every AWS call either captures one field (--query … --output text) or goes to /dev/null.
# No EXIT trap: a `set -e` abort or the 340-minute exit never stops the task. INT/TERM traps are a second line behind the
# workflow's `if: cancelled()` step (GitHub signals only the step's entry process, then kills the tree).
set -euo pipefail

CLUSTER=cadenzpoint-backup
FAMILY=cadenzpoint-backup-disaster
STACK=cadenzpoint-backup
CONTAINER=disaster
WAIT_POLLS=340 # one per minute: 340 minutes, inside the 360-minute job and the 6-hour credentials
UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

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
    echo "no running disaster task from this run"
    return 0
  fi
  local n=0 arn
  for arn in $arns; do
    aws ecs stop-task --cluster "$CLUSTER" --task "$arn" --reason "button run cancelled" >/dev/null 2>&1 || true
    n=$((n + 1))
  done
  echo "stop requested for $n disaster task(s) from this run"
}

if [ "${1:-}" = "--stop" ]; then
  stop_tasks
  exit 0
fi
if [ "$#" -gt 0 ]; then fail "unknown argument"; fi

# ---- 1. read and mask ------------------------------------------------------------------------------------------------
: "${GITHUB_EVENT_PATH:?}"
# A newline or carriage return in any input (possible through the API or gh, not the form) would defeat both the masking
# and the validation, so it is refused before anything is printed, and the message prints no value (fix round 1, FR6).
if jq -e '[(.inputs // {})[] | strings | test("[\\r\\n]")] | any' "$GITHUB_EVENT_PATH" >/dev/null; then
  fail "inputs must be a single line"
fi
MODE=$(jq -r '.inputs.mode // ""' "$GITHUB_EVENT_PATH")
TARGETS=$(jq -r '.inputs.targets // ""' "$GITHUB_EVENT_PATH")
OVERRIDE=$(jq -r '.inputs.override // "none"' "$GITHUB_EVENT_PATH")
CONFIRM=$(jq -r '.inputs.confirm // ""' "$GITHUB_EVENT_PATH")

# Mask before anything else can print: the raw value, and each comma-separated piece.
if [ -n "$TARGETS" ]; then
  echo "::add-mask::$TARGETS"
  OLD_IFS=$IFS; IFS=','
  for piece in $TARGETS; do
    piece=$(printf '%s' "$piece" | tr -d '[:space:]')
    if [ -n "$piece" ]; then echo "::add-mask::$piece"; fi
  done
  IFS=$OLD_IFS
fi

case "$MODE" in workspace|rehearse) ;; *) fail "mode must be workspace or rehearse" ;; esac
case "$OVERRIDE" in none|unreachable-4h|canary) ;; *) fail "override must be none, unreachable-4h or canary" ;; esac
if [ "$MODE" = workspace ] && [ "$OVERRIDE" = canary ]; then fail "override canary is only for rehearse"; fi
if [ "$MODE" = rehearse ] && [ "$OVERRIDE" = unreachable-4h ]; then fail "override unreachable-4h is only for workspace"; fi

EXPECTED_CONFIRM=$MODE
if [ "$OVERRIDE" = unreachable-4h ]; then EXPECTED_CONFIRM="workspace unreachable-4h"; fi
if [ "$CONFIRM" != "$EXPECTED_CONFIRM" ]; then fail "confirm must be exactly: $EXPECTED_CONFIRM"; fi

if ! printf '%s' "$TARGETS" | grep -Eq "^(all-lost|${UUID}(,${UUID}){0,49})$"; then
  fail "targets must be workspace ids (uuid, lowercase), comma-separated, up to 50, or all-lost"
fi
if [ "$TARGETS" = all-lost ]; then
  if [ "$MODE" != workspace ]; then fail "all-lost is only for workspace"; fi
  if [ "$OVERRIDE" != none ]; then fail "all-lost can't be combined with an override"; fi
else
  # Duplicate ids are removed (the task removes them too).
  TARGETS=$(printf '%s' "$TARGETS" | tr ',' '\n' | awk '!seen[$0]++' | paste -sd, -)
  if [ "$MODE" = rehearse ] && printf '%s' "$TARGETS" | grep -q ','; then fail "rehearse takes exactly one workspace id"; fi
fi

# ---- 2. one run at a time ----------------------------------------------------------------------------------------------
RUNNING=$(aws ecs list-tasks --cluster "$CLUSTER" --family "$FAMILY" --desired-status RUNNING --query 'length(taskArns)' --output text)
if [ "$RUNNING" != "0" ]; then fail "a disaster task is already running (RESTORE.md runbook A.11)"; fi

# ---- 3. start ----------------------------------------------------------------------------------------------------------
SUBNETS=$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='TaskSubnets'].OutputValue" --output text)
SG=$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='TaskSecurityGroup'].OutputValue" --output text)
if [ -z "$SUBNETS" ] || [ "$SUBNETS" = None ] || [ -z "$SG" ] || [ "$SG" = None ]; then fail "the backup stack has no TaskSubnets/TaskSecurityGroup outputs (approve the pending Backup system deploy)"; fi
OVERRIDES=$(jq -cn --arg c "$CONTAINER" --arg m "$MODE" --arg t "$TARGETS" --arg o "$OVERRIDE" --arg r "$STARTED_BY" \
  '{containerOverrides: [{name: $c, command: ["disaster", $m, "--targets", $t, "--override", $o, "--run-id", $r]}]}')
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
echo "disaster task started ($MODE, run $STARTED_BY); the start is emailed"

trap 'echo "cancel received: stopping the task"; stop_tasks; exit 130' INT
trap 'echo "termination received: stopping the task"; stop_tasks; exit 143' TERM

# ---- 5. wait (no `aws ecs wait`) --------------------------------------------------------------------------------------
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

# ---- 6. report --------------------------------------------------------------------------------------------------------
if [ "$STATUS" != STOPPED ]; then
  echo "still running after 340 minutes; its results will be emailed (run $STARTED_BY)"
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
echo "disaster task finished: exit $EXIT_CODE; run $STARTED_BY; results emailed and in the digest"
exit "$EXIT_CODE"
