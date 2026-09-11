# Local Multi-Tenant Testing (no domain required)

## Quick start (one command)

Prereqs: local Postgres running (`docker compose up -d`), `psql` on PATH, and `.env` with a real
`ENCRYPTION_KEY` (`openssl rand -hex 32`), `APP_ROOT_DOMAIN=localhost`, `AUTH_SECRET`, and
`NEXT_PUBLIC_APP_URL=http://localhost:3000`.

    npm run demo:local      # creates control + tenant DBs, migrates, seeds 3 populated tenants
    npm run dev             # then open http://acme.localhost:3000

Login on any tenant: admin@cadenzpoint.dev / Password123!. This mirrors the exact cloud demo
(same control plane + seed:demo path); only the connection strings and domain differ. The manual,
step-by-step walkthrough below remains for understanding/debugging each stage.

You can fully exercise the multi-tenant routing locally using `*.localhost` subdomains, which
resolve to `127.0.0.1` natively. This tests the exact production path — proxy → host-derived
tenant → per-tenant DB → physical isolation — without DNS, TLS, or a paid domain.

> **What this proves:** subdomain→tenant routing, host-as-source-of-truth, forged-header
> rejection, physical data isolation across separate databases, suspended/provisioning
> gating, and per-host session cookies.
> **What it does NOT prove (needs a real wildcard domain later):** TLS/HSTS, real DNS, Vercel
> edge behavior, and production CSP `enforce`. Defer those until you own a domain.

> **When to run this:** **BEFORE blueprint 5 (provisioning).** This validates the control
> plane (blueprint 4) at runtime — the foundation BP5 builds on. `seed:tenant` here is the
> manual stand-in for what BP5 will automate, so this exercises the same surface. After BP5
> lands, swap `seed:tenant` for the real `provisionTenant` flow and re-run §8–§10 to confirm
> provisioning yields the same correct result.

> **This guide uses Option A** — reuse your existing local `bytime` database as one tenant so
> you keep your current demo data/logins, and create one fresh DB for a second tenant. (For a
> clean slate instead, create a `bytime_acme` DB too and seed both fresh.)

---

## 0. Prerequisites
- Postgres 16 (via `docker compose up -d`, or local).
- Node 22, deps installed (`npm ci`).
- `psql` on your PATH (for creating databases + the suspended-gating check).

## 1. Create the databases
Option A reuses your existing `bytime` DB as tenant **acme**. You only need to create the
control-plane DB, one fresh DB for tenant **beta**, and two throwaway DBs for the automated
test. Connect via your existing `bytime` database to issue the `CREATE DATABASE` commands:
```bash
docker compose up -d   # if Postgres isn't already running

for db in bytime_control bytime_beta bytime_test bytime_test2; do
  psql "postgresql://bytime:bytime_dev@localhost:5432/bytime" -c "CREATE DATABASE $db;"
done
```
> In that URL, `bytime` (user) / `bytime_dev` (password) / `bytime` (database). Leave the
> existing `bytime` database’s data intact — we register it as a tenant, we don’t wipe it.

## 2. Configure env vars — use `.env` for these (NOT only `.env.local`)
Different tools read different files:
- **Next.js app** reads `.env.local` AND `.env` (`.env.local` wins).
- **`tsx` scripts** (`seed:tenant`, `db:deploy`) read `.env.local` then `.env` (`.env.local` wins).
- **`drizzle-kit`** (`db:migrate:cp`) reads **`.env` only** — not `.env.local`.

Because of `drizzle-kit`, put the shared multi-tenant vars in **`.env`** so everything sees them.
Create `.env` (copy from `.env.example`) with:
```bash
AUTH_SECRET=replace-with-openssl-rand-base64-32          # openssl rand -base64 32
ENCRYPTION_KEY=replace-with-openssl-rand-hex-32          # openssl rand -hex 32
APP_ROOT_DOMAIN=localhost
NEXT_PUBLIC_APP_URL=http://localhost:3000
CONTROL_PLANE_DATABASE_URL=postgresql://bytime:bytime_dev@localhost:5432/bytime_control
CRON_SECRET=devsecret
```
> **`ENCRYPTION_KEY` must be a real value and identical everywhere.** The app encrypts/decrypts
> tenant DB URLs with it. If you already keep it in `.env.local`, either move it to `.env` or make
> sure both files have the SAME value — a mismatch means the app can’t decrypt tenants the seed
> script created. `seed:tenant` now hard-fails if `ENCRYPTION_KEY` is unset, so you can’t hit the
> silent-dev-fallback trap. No `DATABASE_URL` needed — tenant connections come from the registry.

## 3. Migrate the control plane (registry)
```bash
npm run db:migrate:cp
```

## 4. Seed two tenants
Register your existing `bytime` DB as **acme** (pass your existing admin email so the script
does NOT create a new user — you keep your current logins/data), and seed a fresh **beta**:
```bash
# acme = your existing bytime DB; reuse your demo admin (no new user created)
npm run seed:tenant acme postgresql://bytime:bytime_dev@localhost:5432/bytime admin@bytime.dev
# beta = fresh DB; creates admin@beta.test / Password123!
npm run seed:tenant beta postgresql://bytime:bytime_dev@localhost:5432/bytime_beta
```
> `seed:tenant` runs migrations on each tenant DB (applies the latest schema, additive) and
> registers it `active`. For `acme` it skips user creation because `admin@bytime.dev` already
> exists, so your existing password stands.

## 5. Map the subdomains for curl (browsers already handle `*.localhost`)
```bash
sudo sh -c 'echo "127.0.0.1 acme.localhost beta.localhost" >> /etc/hosts'
```

## 6. Run the app
```bash
npm run dev        # or: npm run build && npm run start
```

## 7. Test in the browser (the real isolation check)
- `http://acme.localhost:3000` → log in with your existing demo creds (`admin@bytime.dev /
  Password123!`). All your current `bytime` data is here.
- `http://beta.localhost:3000` → log in `admin@beta.test / Password123!` (fresh, empty workspace).
- Create a contract in **beta**, then check **acme** — it must NOT appear, and vice versa
  (physical isolation across the two databases).
- `http://localhost:3000` (apex) → marketing host; an `(app)` route shows **“No workspace selected.”**

## 8. Run the smoke script
```bash
./scripts/smoke-tenancy.sh http://localhost:3000 http://acme.localhost:3000 devsecret
```
Checks health, apex/tenant routing, forged-header equivalence, and cron auth.

## 9. Manual security checks
- **Forged header (no leak / no crash):**
  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" -H "x-tenant-slug: beta" http://acme.localhost:3000/login
  # → 200, served as acme; the spoofed header is overwritten by the proxy and ignored.
  ```
- **Cross-subdomain cookie:** log into `acme` in the browser, copy its session cookie, try it on
  `beta.localhost:3000` → unauthorized (cookies are per-host).
- **Suspended gating** (takes effect within ~60s — the registry cache TTL):
  ```bash
  psql "$CONTROL_PLANE_DATABASE_URL" -c "UPDATE tenants SET status='suspended' WHERE slug='acme';"
  # reload http://acme.localhost:3000 → "Workspace suspended" screen
  psql "$CONTROL_PLANE_DATABASE_URL" -c "UPDATE tenants SET status='active' WHERE slug='acme';"
  ```
- **Provisioning gating:** set `status='provisioning'` → “Setting up your workspace” screen.

## 10. Automated isolation test
Point the integration runner at the **throwaway** DBs (NOT acme/beta — the suite truncates data):
```bash
TEST_DATABASE_URL=postgresql://bytime:bytime_dev@localhost:5432/bytime_test \
TEST_DATABASE_URL_2=postgresql://bytime:bytime_dev@localhost:5432/bytime_test2 \
npm run test:integration
```
`tenant-data-isolation.test.ts` runs only when `TEST_DATABASE_URL_2` is set and asserts no
cross-tenant visibility. The rest of the integration suite (period-lock, RBAC, etc.) also runs.

> ⚠️ The integration suite calls `cleanupTestData()` which **truncates** the DB it points at.
> ONLY ever point it at `bytime_test`/`bytime_test2`. **Never** point `TEST_DATABASE_URL` at
> `bytime` (your real data, now tenant acme) or `bytime_beta` — it would wipe them.

---

## When you get a domain (later)
Add it to Vercel as a wildcard (`*.staging.yourdomain.com`), set `APP_ROOT_DOMAIN`,
`CONTROL_PLANE_DATABASE_URL`, and `ENCRYPTION_KEY` in Vercel env, run `db:migrate:cp` against
the staging control-plane DB, seed/provision a tenant, then run the same smoke script against
`https://staging.yourdomain.com` + `https://acme.staging.yourdomain.com`. Flip `CSP_MODE=enforce`
once the browser console is clean.
