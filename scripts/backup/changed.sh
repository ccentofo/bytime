#!/usr/bin/env bash
# Does this push need a backup-system deploy? (feature-plan-database-backups.md §6.2; impact analysis G1.)
#   changed.sh <event_name> <sha>   → prints `changed=true` or `changed=false`
#
# - workflow_dispatch: always true.
# - Finds the LAST SUCCESSFULLY DEPLOYED commit: walks up to 20 `aws-backups` deployments, newest first, reading each
#   one's statuses until one has `success`. None found → true (first deploy, or every earlier one failed/rejected).
# - Superseded: if this commit is an older ancestor of the last deployed one → false (an old re-run never redeploys
#   older code).
# - Otherwise true when `git diff --name-only <deployed>..<sha>` touches the deploy list (deploy-paths.txt).
# - ANY error (API, unknown commit, git) → true: fail towards deploying (the founder still approves).
# Needs GH_TOKEN with `deployments: read`. bash 3.2 compatible (macOS runs the tests).
set -u -o pipefail

event="${1:-}"
sha="${2:-}"
out() { echo "changed=$1"; exit 0; }

[ "$event" = "workflow_dispatch" ] && out true
[ -n "$sha" ] || out true

here="$(cd "$(dirname "$0")" && pwd)"
paths_file="$here/deploy-paths.txt"
repo="${GITHUB_REPOSITORY:-ccentofo/bytime}"
[ -f "$paths_file" ] || out true

list="$(gh api "repos/$repo/deployments?environment=aws-backups&per_page=20" --jq '.[] | "\(.id) \(.sha)"' 2>/dev/null)" || out true

deployed=""
while read -r id dsha; do
  [ -z "${id:-}" ] && continue
  state="$(gh api "repos/$repo/deployments/$id/statuses?per_page=100" --jq 'if (map(.state) | index("success")) then "success" else "other" end' 2>/dev/null)" || out true
  if [ "$state" = "success" ]; then
    deployed="$dsha"
    break
  fi
done <<EOF_LIST
$list
EOF_LIST

[ -n "$deployed" ] || out true
[ "$sha" = "$deployed" ] && out false

if git merge-base --is-ancestor "$sha" "$deployed" 2>/dev/null; then
  out false
fi

files="$(git diff --name-only "$deployed" "$sha" 2>/dev/null)" || out true

while IFS= read -r f; do
  [ -z "$f" ] && continue
  while IFS= read -r p; do
    case "$p" in ''|'#'*) continue ;; esac
    case "$p" in
      */\*\*)
        prefix="${p%\*\*}"
        case "$f" in "$prefix"*) out true ;; esac
        ;;
      *)
        [ "$f" = "$p" ] && out true
        ;;
    esac
  done < "$paths_file"
done <<EOF_FILES
$files
EOF_FILES

out false
