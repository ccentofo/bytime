#!/usr/bin/env bash
#
# setup-local-demo.sh — stand up the FULL CadenzPoint demo locally, mirroring the cloud topology.
# Creates the control-plane DB + N tenant DBs on local Postgres, migrates the control plane, and
# seeds each tenant with the 6-month GovCon dataset. Idempotent: safe to re-run.
#
# Prereqs: local Postgres running; `psql` on PATH; `.env` (or `.env.local`) contains a real
#          ENCRYPTION_KEY (same value the app uses). APP_ROOT_DOMAIN should be `localhost`.
#
# Usage:   npm run demo:local
#
set -uo pipefail

# --- Config (override via env if your local Postgres differs) ---------------
# A connection to an EXISTING database, used only to issue CREATE DATABASE.
ADMIN_URL="${LOCAL_ADMIN_DATABASE_URL:-postgresql://bytime:bytime_dev@localhost:5432/bytime}"
# Base (no db name) for building per-database URLs.
PG_BASE="${LOCAL_PG_BASE:-postgresql://bytime:bytime_dev@localhost:5432}"

# Derive CONTROL_DB from CONTROL_PLANE_DATABASE_URL in env/.env if available,
# so the script writes to the same DB the app reads — avoiding the #1 mismatch.
_cp_url="${CONTROL_PLANE_DATABASE_URL:-}"
if [ -z "$_cp_url" ]; then
  _cp_url="$(grep -s '^CONTROL_PLANE_DATABASE_URL=' .env.local .env 2>/dev/null | head -1 | cut -d= -f2-)"
fi
# Extract just the db name from the URL (last path segment, strip query string)
_cp_db="${_cp_url##*/}"; _cp_db="${_cp_db%%\?*}"

CONTROL_DB="${CONTROL_DB:-${_cp_db:-cadenzpoint_control}}"
CONTROL_URL="$PG_BASE/$CONTROL_DB"

# slug:dbname:Display Name  (add/remove tenants here)
TENANTS=(
  "acme:tenant_acme:Acme Defense"
  "globex:tenant_globex:Globex Systems"
  "initech:tenant_initech:Initech Federal"
)

fail() { echo "✗ $1" >&2; exit 1; }

# --- Preflight -------------------------------------------------------------
command -v psql >/dev/null 2>&1 || fail "psql not found on PATH (needed to create databases)."
psql "$ADMIN_URL" -tAc "SELECT 1" >/dev/null 2>&1 \
  || fail "Cannot connect to local Postgres at $ADMIN_URL (is it running? docker compose up -d)"

# ENCRYPTION_KEY must be available to seed:demo. We don't read it here; we just check that the
# app's env has it, because seed:demo will need it to encrypt the tenant URLs.
# (dotenv in seed:demo reads .env.local then .env. We surface a clear error early.)
if [ -z "${ENCRYPTION_KEY:-}" ] && ! grep -qs "^ENCRYPTION_KEY=" .env .env.local 2>/dev/null; then
  fail "ENCRYPTION_KEY is not set in the environment or in .env/.env.local.
   Generate one: echo \"ENCRYPTION_KEY=\$(openssl rand -hex 32)\" >> .env
   It MUST match the running app, or tenants won't decrypt."
fi

ensure_db() {
  local db="$1"
  if psql "$ADMIN_URL" -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1; then
    echo "  • database $db already exists"
  else
    psql "$ADMIN_URL" -c "CREATE DATABASE \"$db\"" >/dev/null && echo "  ✓ created database $db"
  fi
}

echo "== 1/3 Creating databases =="
ensure_db "$CONTROL_DB"
for t in "${TENANTS[@]}"; do
  IFS=':' read -r slug db name <<< "$t"
  ensure_db "$db"
done

echo "== 2/3 Migrating control plane =="
# Pass the control URL inline so this works regardless of what .env points at (dotenv won't
# override an already-set process.env var, so this value wins for the child).
CONTROL_PLANE_DATABASE_URL="$CONTROL_URL" npm run db:migrate:cp || fail "control-plane migration failed"

echo "== 3/3 Seeding demo tenants =="
for t in "${TENANTS[@]}"; do
  IFS=':' read -r slug db name <<< "$t"
  echo "-- $slug ($name) --"
  # Local-only: these databases are this machine's demo copies, so wiping them on re-run is intended.
  case "$PG_BASE" in
    *@localhost:*|*@127.0.0.1:*) WIPE_FLAG="--wipe-demo-data" ;;
    *) WIPE_FLAG="" ;;
  esac
  # The env prefix must sit on the command line itself so the seeder registers into THIS control plane,
  # never whatever .env points at.
  CONTROL_PLANE_DATABASE_URL="$CONTROL_URL" APP_ROOT_DOMAIN="localhost" \
    npm run seed:demo "$slug" "$PG_BASE/$db" "$name" -- $WIPE_FLAG || fail "seeding $slug failed"
done

echo ""
echo "✅ Local demo ready."
echo ""
echo "Visit (browsers resolve *.localhost natively):"
for t in "${TENANTS[@]}"; do
  IFS=':' read -r slug db name <<< "$t"
  echo "  http://$slug.localhost:3000   ($name)"
done
echo "  http://localhost:3000          (apex — marketing/signup)"
echo ""
echo "Login on any tenant:  admin@cadenzpoint.dev / Password123!"
echo "  supervisors: sarah.wilson@cadenzpoint.dev, mike.chen@cadenzpoint.dev"
echo "  employees:   jane.smith@cadenzpoint.dev, john.doe@cadenzpoint.dev, ..."
echo ""
echo "For curl/smoke, add the hosts once:"
echo "  sudo sh -c 'echo \"127.0.0.1 acme.localhost globex.localhost initech.localhost\" >> /etc/hosts'"
echo ""
echo "Then: npm run dev   (and in another shell)"
echo "  ./scripts/smoke-tenancy.sh http://localhost:3000 http://acme.localhost:3000 \"\${CRON_SECRET:-devsecret}\""
