#!/usr/bin/env bash
#
# smoke-tenancy.sh — runtime smoke checks for multi-tenant routing & DCAA isolation guards.
# These verify behavior a `npm run build` cannot: live subdomain routing, header-spoof
# resistance, cron auth, and health. Run against a real deployment.
#
# Usage:
#   ./scripts/smoke-tenancy.sh <APEX_URL> <TENANT_URL> [CRON_SECRET]
#
# Example:
#   ./scripts/smoke-tenancy.sh https://app.example.com https://acme.example.com s3cr3t
#
# Notes:
#   - APEX_URL   = the apex/marketing host (no tenant).
#   - TENANT_URL = an ACTIVE tenant's subdomain host.
#   - CRON_SECRET (optional) enables the cron auth checks.
#   - Some checks (cross-subdomain cookie reuse, per-tenant API key, suspended gating)
#     require credentials/DB changes and are listed at the end as MANUAL steps.

set -uo pipefail

APEX_URL="${1:-}"
TENANT_URL="${2:-}"
CRON_SECRET="${3:-${CRON_SECRET:-}}"

if [[ -z "$APEX_URL" || -z "$TENANT_URL" ]]; then
  echo "Usage: $0 <APEX_URL> <TENANT_URL> [CRON_SECRET]" >&2
  exit 2
fi

PASS=0
FAIL=0

# status URL [header...]
status() {
  local url="$1"; shift
  local args=()
  for h in "$@"; do args+=(-H "$h"); done
  # ${args[@]+"${args[@]}"} expands to nothing when empty — required under `set -u` on
  # macOS Bash 3.2, where a bare "${args[@]}" on an empty array errors "unbound variable".
  curl -s -o /dev/null -w "%{http_code}" ${args[@]+"${args[@]}"} "$url"
}

check() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "  ✓ $label ($actual)"; PASS=$((PASS+1))
  else
    echo "  ✗ $label (got $actual, expected $expected)"; FAIL=$((FAIL+1))
  fi
}

echo "== Health =="
HEALTH_CODE=$(status "$APEX_URL/api/health")
check "GET /api/health is 200" "$HEALTH_CODE" "200"
if curl -s "$APEX_URL/api/health" | grep -q '"status":"healthy"'; then
  echo "  ✓ health body reports healthy"; PASS=$((PASS+1))
else
  echo "  ✗ health body not healthy"; FAIL=$((FAIL+1))
fi

echo "== Apex / tenant routing =="
check "apex root responds" "$(status "$APEX_URL/")" "200"
TENANT_BASELINE=$(status "$TENANT_URL/login")
check "tenant /login responds" "$TENANT_BASELINE" "200"

echo "== Header-spoof resistance (host is the source of truth) =="
# A forged x-tenant-slug must NOT change the outcome: the proxy overwrites it from the host,
# and context.ts re-derives from host. Expect identical status to the baseline.
SPOOFED=$(status "$TENANT_URL/login" "x-tenant-slug: nonexistent-tenant-xyz")
check "forged x-tenant-slug yields same status as baseline" "$SPOOFED" "$TENANT_BASELINE"

if [[ -n "$CRON_SECRET" ]]; then
  echo "== Cron auth =="
  check "cron WITHOUT secret is 401" "$(status "$APEX_URL/api/cron/daily-reminder")" "401"
  check "cron WITH secret is 200" \
    "$(status "$APEX_URL/api/cron/daily-reminder" "x-cron-secret: $CRON_SECRET")" "200"
else
  echo "== Cron auth =="
  echo "  • skipped (no CRON_SECRET passed)"
fi

echo ""
echo "== Summary: $PASS passed, $FAIL failed =="
echo ""
echo "MANUAL checks (need credentials / DB access — not automated here):"
echo "  • Cross-subdomain cookie: log in on $TENANT_URL, replay its session cookie on a"
echo "    different tenant host → must be UNAUTHORIZED (cookies are per-subdomain)."
echo "  • Per-tenant API key: a tenant's API key works on its host, fails on another's host."
echo "  • Suspended gating: set a tenant status='suspended' in the control-plane registry →"
echo "    its app routes show the 'workspace suspended' screen within ~60s (registry TTL)."

[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
