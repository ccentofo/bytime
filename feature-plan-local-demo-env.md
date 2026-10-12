# Blueprint: One-Command Local Demo Environment (mirror the cloud, verify before deploy)

> **Role for the executing developer: Platform/DevEx engineer.** Build a single command that stands
> up the full multi-tenant CadenzPoint demo **locally**, populated with realistic data, then verify
> it end-to-end. The whole point: prove the exact demo we'll run on Vercel/Neon works *here first* —
> same control plane, same `seed:demo` path, same routing — so the cloud step is pure infra, not
> debugging.

## 1. Goal & Overview

Today the local multi-tenant flow (`LOCAL-MULTITENANT-TESTING.md`) is a ~10-step manual procedure
that seeds **blank** tenants via `seed:tenant`. We want a **one command** —
`npm run demo:local` — that produces the *populated* demo: a control-plane DB plus 2–3 tenant
databases, each loaded with the 6-month GovCon dataset (contracts, CLINs, employees, timesheets,
approvals), reachable at `http://<slug>.localhost:3000`.

This mirrors the production demo topology exactly:

| | Local | Cloud (Vercel/Neon) |
|---|---|---|
| Control plane | `cadenzpoint_control` DB on local Postgres | `cadenzpoint_control` DB on Neon |
| Tenants | `tenant_acme`, `tenant_globex`, `tenant_initech` (local DBs) | same names, Neon DBs |
| Seeding | `npm run seed:demo <slug> <localUrl> <name>` | `npm run seed:demo <slug> <neonUrl> <name>` |
| Routing | `<slug>.localhost:3000` (native) | `<slug>.cadenzpoint.com` (wildcard DNS) |
| `APP_ROOT_DOMAIN` | `localhost` | `cadenzpoint.com` |

Because the only difference is the connection strings + domain, a green local run is strong evidence
the cloud demo will work.

> **Prerequisite (already built):** `npm run seed:demo <slug> <dbUrl> [displayName]` and the
> `seedRichData()` it calls (`scripts/seed-demo.ts`, `scripts/seed-full.ts`); the control-plane
> migrate (`npm run db:migrate:cp`); host routing in `src/lib/tenant/host.ts`.

## 2. Technical Direction

Build one orchestrator script that is **idempotent** (safe to re-run) and **self-consistent** (it
passes the control-plane URL to its child commands so it doesn't depend on `.env` being perfectly
set for that one value). It must:

1. Create the control-plane DB + each tenant DB on local Postgres if they don't already exist
   (Postgres has no `CREATE DATABASE IF NOT EXISTS`; guard with a `pg_database` check).
2. Migrate the control plane.
3. Seed each tenant via the existing `seed:demo` (migrate → rich data → register active).
4. Print the URLs, the demo cred sheet, the `/etc/hosts` line (for curl/smoke), and the smoke command.

`ENCRYPTION_KEY` must still come from `.env`/`.env.local` (the app and `seed:demo` share it). The
script should fail fast with a clear message if it's missing, rather than letting `seed:demo` hit a
confusing decrypt error later.

**Bash is the right tool here** (matches `smoke-tenancy.sh`; needs only `psql` + `npm`, which the
local flow already requires). Keep it Bash-3.2-safe (macOS) like the existing smoke script.

## 3. File Topology

```
Files to CREATE:
└── scripts/setup-local-demo.sh         ← the one-command bootstrap (idempotent)

Files to MODIFY:
├── package.json                        ← add "demo:local": "bash scripts/setup-local-demo.sh"
└── LOCAL-MULTITENANT-TESTING.md        ← add a "Quick start (one command)" section at the top

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── scripts/seed-demo.ts / seed-full.ts ← reuse as-is (do not duplicate seed logic)
├── scripts/smoke-tenancy.sh            ← reuse for verification (do not fold it into the bootstrap)
└── src/lib/tenant/**                   ← routing already correct for *.localhost
```

## 4. Step-by-Step

> **⚠️ GUARDRAILS:**
> - Idempotent: re-running must not error on existing DBs and must not duplicate tenants
>   (`seed:demo` already upserts the registry row and clears+reseeds tenant data).
> - Never create or seed the integration-test DBs here, and never point the integration runner at
>   the demo DBs — it truncates. Keep them separate.
> - Bash-3.2-safe (macOS default). `set -uo pipefail`.
> - Don't hardcode `ENCRYPTION_KEY`; require it from the environment/.env and fail clearly if absent.

**Step 1 — Create `scripts/setup-local-demo.sh`:**
```bash
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
CONTROL_DB="${CONTROL_DB:-cadenzpoint_control}"
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
  CONTROL_PLANE_DATABASE_URL="$CONTROL_URL" APP_ROOT_DOMAIN="localhost" \
    npm run seed:demo "$slug" "$PG_BASE/$db" "$name" || fail "seeding $slug failed"
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
```

**Step 2 — Add the npm alias.** In `package.json` scripts:
```json
"demo:local": "bash scripts/setup-local-demo.sh",
```

**Step 3 — Make it executable & document it.** `chmod +x scripts/setup-local-demo.sh`. Add a
"Quick start (one command)" section to the TOP of `LOCAL-MULTITENANT-TESTING.md`:
```markdown
## Quick start (one command)

Prereqs: local Postgres running (`docker compose up -d`), `psql` on PATH, and `.env` with a real
`ENCRYPTION_KEY` (`openssl rand -hex 32`), `APP_ROOT_DOMAIN=localhost`, `AUTH_SECRET`, and
`NEXT_PUBLIC_APP_URL=http://localhost:3000`.

    npm run demo:local      # creates control + tenant DBs, migrates, seeds 3 populated tenants
    npm run dev             # then open http://acme.localhost:3000

Login on any tenant: admin@cadenzpoint.dev / Password123!. This mirrors the exact cloud demo
(same control plane + seed:demo path); only the connection strings and domain differ. The manual,
step-by-step walkthrough below remains for understanding/debugging each stage.
```

## 5. Verification (do all of this locally — it's the whole point)

### 5a. Bootstrap runs clean, twice
```bash
npm run demo:local      # first run: creates + seeds
npm run demo:local      # second run: idempotent — "already exists" + reseeds, no errors
```

### 5b. The isolation check (browser)
```bash
npm run dev
```
| Check | Expected |
|---|---|
| `http://acme.localhost:3000` login as `admin@cadenzpoint.dev` / `Password123!` | full populated workspace (contracts, 6 mo timesheets) |
| `http://globex.localhost:3000` | populated, but a **different** dataset instance |
| Create a contract in `globex`, reload `acme` | does NOT appear in acme (physical isolation) |
| `http://localhost:3000` (apex) | marketing/signup; an `(app)` route shows "No workspace selected" |
| Timesheet on any tenant | whole pay period fits, no horizontal scroll; revision history shows a reason-coded correction |
| Dark mode toggle | Cool Slate theme, both modes legible |

### 5c. Smoke + automated isolation
```bash
./scripts/smoke-tenancy.sh http://localhost:3000 http://acme.localhost:3000 "${CRON_SECRET:-devsecret}"
# expect: all checks pass (health, apex/tenant routing, forged-header equivalence, cron auth)

# Automated cross-tenant isolation test — point ONLY at the throwaway DBs:
TEST_DATABASE_URL=postgresql://bytime:bytime_dev@localhost:5432/bytime_test \
TEST_DATABASE_URL_2=postgresql://bytime:bytime_dev@localhost:5432/bytime_test2 \
npm run test:integration
```

### 5d. Build & lint
```bash
npm run build && npm run lint    # zero errors; no NEW lint errors
```

### 5e. Common errors to watch for
| Symptom | Cause | Fix |
|---|---|---|
| `seed:demo` fails: cannot decrypt / ENCRYPTION_KEY | key missing or differs between runs | set one real `ENCRYPTION_KEY` in `.env`; never change it between seed and app |
| `db:migrate:cp` connects to the wrong DB | `.env` `CONTROL_PLANE_DATABASE_URL` differs | the script passes it inline; ensure your running app's `.env` also points at `cadenzpoint_control` |
| `<slug>.localhost` won't load | using curl (not a browser) without hosts entry | add the `/etc/hosts` line the script prints |
| tenant shows blank after seed | app `ENCRYPTION_KEY` ≠ the one used to seed | align the keys; re-run `demo:local` |
| integration test wiped my demo data | runner pointed at a demo DB | only ever point `TEST_DATABASE_URL*` at `bytime_test`/`bytime_test2` |
| `CREATE DATABASE` permission denied | local role lacks CREATEDB | grant: `ALTER ROLE bytime CREATEDB;` |

## 6. Definition of done
`npm run demo:local` → `npm run dev` yields three populated, isolated tenants at
`*.localhost:3000`; the smoke script and integration isolation test pass; build + lint clean. At that
point the cloud deploy (next guide) is just swapping local connection strings for Neon ones and the
domain for `cadenzpoint.com`.
```
