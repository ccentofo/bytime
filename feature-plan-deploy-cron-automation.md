# Blueprint: Deployment Automation & Cron Scheduling

> **This ticket contains THREE phases (A: cron scheduling, B: deploy automation, C: CI migration parity). Do A first (it unblocks core DCAA reminders), then B and C.**
> **Tier 1.** Operational readiness. No application business logic changes.

## 1. Architectural Overview

### The Problem

**Gap A — Cron endpoints exist but nothing calls them.** `src/app/api/cron/daily-reminder/route.ts` and `src/app/api/cron/submission-deadline/route.ts` are implemented, rate-limited, and protected by an optional `CRON_SECRET` header (`x-cron-secret`). But there is **no scheduler** invoking them. Daily-time-entry reminders and submission-deadline nudges — both important for DCAA "log time daily" behavior — never fire in production.

**Gap B — The staging deploy workflow is a stub.** `.github/workflows/deploy-staging.yml` builds and runs migrations correctly, but the deploy step is literally `echo "Add deployment command here (e.g., docker push, vercel deploy, etc.)"`. There is no production deploy workflow at all.

**Gap C — CI integration tests don't match prod migration discipline.** `ci.yml` provisions the test DB with `npx drizzle-kit push` (the integration-tests job), while production uses migration files via `npm run db:deploy` (`scripts/migrate.ts` → `migrate()`). This means CI never exercises the actual migration files; a broken migration can pass CI and fail in production.

### Design Decisions

1. **Scheduler is host-agnostic via a GitHub Actions scheduled workflow** that `curl`s the two endpoints with the `x-cron-secret` header. This works whether the app runs on Vercel, Docker/Caddy, Railway, etc. A Vercel-native `vercel.json` cron alternative is documented for teams who deploy on Vercel and prefer it.
2. **Deploy target follows the GTM decision (self-service SaaS, single app deployment).** The README and provisioning scripts point at **Vercel + Neon**, so the primary deploy path is Vercel CLI; a Docker registry path is documented as the alternative for the self-hosted `docker-compose.prod.yml` stack.
3. **Migrations always run before the app is promoted.** The workflow runs `npm run db:deploy` against the target DB before the deploy step (the staging workflow already orders it this way — keep that order).
4. **CI gains a migration-applied job** so the real `drizzle/*.sql` files are exercised on every push.

> **Idempotency / DST note for cron:** both endpoints already guard their own logic (weekend skip, deadline-window checks) and are rate-limited. A scheduled job that occasionally double-fires is safe. Schedule in UTC and pick the hour that maps to a sensible local late-afternoon for the target customer base; the endpoint logic, not the scheduler, owns "who gets a reminder."

---

## 2. File Topology

```
Files to CREATE:
├── .github/workflows/cron.yml          ← Scheduled workflow hitting both cron endpoints
├── .github/workflows/deploy-prod.yml   ← Production deploy (mirrors staging, prod secrets)
├── vercel.json                         ← (OPTIONAL, Vercel-only) native cron config

Files to MODIFY:
├── .github/workflows/deploy-staging.yml ← Replace the stub deploy step with a real one
├── .github/workflows/ci.yml             ← Integration job uses migrations (db:deploy) not push
├── Dockerfile                           ← Clarify comment: migrations run via db:deploy, not runtime push

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/**                              ← ❌ DO NOT MODIFY (cron routes already correct)
├── scripts/migrate.ts                  ← ❌ DO NOT MODIFY (already correct)
├── drizzle.config.ts                   ← ❌ DO NOT MODIFY
├── docker-compose.prod.yml             ← ❌ DO NOT MODIFY (deploy uses it, doesn't change it)
├── Caddyfile                           ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS:**
> - **DO NOT** search inside `node_modules/`, `.next/`, or `dist/`.
> - This is an infra/CI blueprint — do **not** change anything under `src/`.
> - Secrets (`CRON_SECRET`, deploy tokens, DB URLs) live in **GitHub repo secrets**, never in the YAML.
> - Workflows must be valid YAML — validate by pushing to a branch and watching the Actions tab, or with `actionlint` if available.

---

## Phase A: Cron Scheduling

### Decision: which scheduler?
- **Default (host-agnostic): GitHub Actions scheduled workflow** — implement A1.
- **If and only if the app is deployed on Vercel** and the team prefers native crons, additionally/instead implement A2. Note A2 requires the route to accept Vercel's auth header (see the note in A2).

**A1.** Create `.github/workflows/cron.yml`:

```yaml
name: Scheduled Cron — Reminders

on:
  schedule:
    # Times are UTC. 20:00 UTC ≈ afternoon US business hours.
    # Daily time-entry reminder, weekdays (endpoint also skips weekends).
    - cron: '0 20 * * 1-5'
    # Submission-deadline reminder, every day (endpoint decides who to notify).
    - cron: '0 20 * * *'
  workflow_dispatch: {}   # allow manual runs for testing

jobs:
  ping-crons:
    name: Hit cron endpoints
    runs-on: ubuntu-latest
    steps:
      - name: Daily reminder
        run: |
          curl -sS -f -X GET "${{ secrets.APP_CRON_BASE_URL }}/api/cron/daily-reminder" \
            -H "x-cron-secret: ${{ secrets.CRON_SECRET }}"
      - name: Submission deadline
        run: |
          curl -sS -f -X GET "${{ secrets.APP_CRON_BASE_URL }}/api/cron/submission-deadline" \
            -H "x-cron-secret: ${{ secrets.CRON_SECRET }}"
```

> Add repo secrets: `APP_CRON_BASE_URL` (e.g. `https://app.bytime.app`) and `CRON_SECRET` (must equal the deployed app's `CRON_SECRET` env var). `curl -f` makes the job fail (and alert) on non-2xx.
>
> **Multi-tenant caveat (forward-looking):** once the control-plane blueprint lands and the app serves many tenants on subdomains, these cron endpoints will need to iterate tenants (or be hit per-tenant). For this Tier-1 milestone the app is still effectively single-DB per deployment, so one base URL is correct. The control-plane blueprint's verification section notes the cron fan-out follow-up.

**A2.** *(Vercel-only, optional)* Create `vercel.json`:

```json
{
  "crons": [
    { "path": "/api/cron/daily-reminder", "schedule": "0 20 * * 1-5" },
    { "path": "/api/cron/submission-deadline", "schedule": "0 20 * * *" }
  ]
}
```

> Vercel Cron authenticates by sending `Authorization: Bearer $CRON_SECRET`, not the `x-cron-secret` header the routes check today. If you choose A2, you must also (in a separate, src-touching change tracked elsewhere — NOT in this blueprint) make the routes accept `Authorization: Bearer` in addition to `x-cron-secret`. Because this blueprint forbids `src/` edits, **prefer A1**, which matches the existing header contract with no code change.

### Phase A Verification

| Check | Expected Result |
|---|---|
| Manually trigger `cron.yml` (workflow_dispatch) | Both curls return 2xx |
| Wrong/missing `CRON_SECRET` | Endpoint returns 401, `curl -f` fails the job |
| Weekend daily-reminder run | Endpoint returns `{ sent: 0, message: 'Weekend…' }` |
| Scheduled run fires | Visible in Actions tab at the cron time (±, GitHub schedules are best-effort) |

---

## Phase B: Deploy Automation

### B-Vercel (primary path — matches README's Vercel+Neon model)

**B1.** Replace the stub step in `.github/workflows/deploy-staging.yml`. Find:

```yaml
      # Add your deployment step here (e.g., Docker push, Vercel, Railway, etc.)
      - name: Deploy
        run: echo "Add deployment command here (e.g., docker push, vercel deploy, etc.)"
        env:
          DATABASE_URL: ${{ secrets.STAGING_DATABASE_URL }}
          AUTH_SECRET: ${{ secrets.AUTH_SECRET }}
```

Replace with:

```yaml
      - name: Install Vercel CLI
        run: npm i -g vercel@latest

      - name: Deploy to Vercel (staging/preview)
        run: |
          vercel pull --yes --environment=preview --token="${{ secrets.VERCEL_TOKEN }}"
          vercel build --token="${{ secrets.VERCEL_TOKEN }}"
          vercel deploy --prebuilt --token="${{ secrets.VERCEL_TOKEN }}"
        env:
          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
```

> The existing `Run database migrations` step (`npm run db:deploy` against `STAGING_DATABASE_URL`) must remain BEFORE this deploy step. Do not remove it.

**B2.** Create `.github/workflows/deploy-prod.yml` mirroring staging but with production secrets and a stricter trigger:

```yaml
name: Deploy to Production

on:
  workflow_dispatch:
    inputs:
      confirm:
        description: 'Type "deploy-prod" to confirm'
        required: true
        default: ''

jobs:
  deploy:
    name: Deploy to Production
    runs-on: ubuntu-latest
    if: github.event.inputs.confirm == 'deploy-prod'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - name: Build
        run: npm run build
        env:
          AUTH_SECRET: ${{ secrets.AUTH_SECRET }}
          DATABASE_URL: ${{ secrets.PROD_DATABASE_URL }}
      - name: Run database migrations
        run: npm run db:deploy
        env:
          DATABASE_URL: ${{ secrets.PROD_DATABASE_URL }}
      - name: Install Vercel CLI
        run: npm i -g vercel@latest
      - name: Deploy to Vercel (production)
        run: |
          vercel pull --yes --environment=production --token="${{ secrets.VERCEL_TOKEN }}"
          vercel build --prod --token="${{ secrets.VERCEL_TOKEN }}"
          vercel deploy --prebuilt --prod --token="${{ secrets.VERCEL_TOKEN }}"
        env:
          VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
```

> Required repo secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `PROD_DATABASE_URL`, `STAGING_DATABASE_URL`, `AUTH_SECRET`.

### B-Docker (alternative path — for the self-hosted `docker-compose.prod.yml` stack)

If deploying via Docker instead of Vercel, replace the deploy step(s) above with a registry push + remote pull. Example deploy step:

```yaml
      - name: Build & push image
        run: |
          echo "${{ secrets.REGISTRY_PASSWORD }}" | docker login ghcr.io -u "${{ github.actor }}" --password-stdin
          docker build -t ghcr.io/${{ github.repository }}:${{ github.sha }} .
          docker push ghcr.io/${{ github.repository }}:${{ github.sha }}
      # Then trigger the host to pull & `docker compose up -d` (SSH action or webhook).
```

> Migrations still run via the `npm run db:deploy` step before the image is promoted. The self-hosted host runs `docker compose -f docker-compose.prod.yml up -d` against the new tag.

**B3.** Clarify the Dockerfile comment so future readers don't think the app pushes schema at runtime. Find:

```dockerfile
# Copy drizzle migrations for runtime schema push
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder /app/scripts ./scripts
```

Replace the comment line only (keep the COPY lines — `scripts/migrate.ts` needs them):

```dockerfile
# Copy migration files + runner so `npm run db:deploy` (drizzle migrate) can run
# as a one-off before the app starts. The app itself never pushes schema at runtime.
```

### Phase B Verification

| Check | Expected Result |
|---|---|
| `deploy-staging.yml` manual run | Builds, migrates `STAGING_DATABASE_URL`, deploys; app reachable |
| `/api/health` after deploy | `{ status: 'healthy' }` (DB reachable) |
| `deploy-prod.yml` requires `deploy-prod` confirm | Won't run without exact input |
| Migration step ordered before deploy | Yes |

---

## Phase C: CI Migration Parity

**C1.** In `.github/workflows/ci.yml`, the integration-tests job currently runs:

```yaml
      - name: Run database migrations
        run: npx drizzle-kit push
        env:
          DATABASE_URL: ${{ env.DATABASE_URL }}
```

Replace with the real migration runner so CI exercises the committed `drizzle/*.sql` files:

```yaml
      - name: Run database migrations
        run: npm run db:deploy
        env:
          DATABASE_URL: ${{ env.DATABASE_URL }}
```

> This makes CI fail if a migration file is broken or missing — which is exactly the prod-parity we want. The `migration-check` job (`npm run db:check`) still independently verifies schema↔migration sync.

### Phase C Verification

| Check | Expected Result |
|---|---|
| CI integration job | Applies `drizzle/*.sql` via `db:deploy`, tests pass |
| Intentionally corrupt a migration (local test) | `db:deploy` fails the job (desired) |
| `migration-check` job | Still green when schema and migrations are in sync |

---

## 4. Verification

### 4a. Workflow validity

Push to a feature branch; confirm all workflows parse and appear in the Actions tab. If `actionlint` is available locally, run it on `.github/workflows/*.yml`.

### 4b. End-to-end

| Check | Expected Result |
|---|---|
| Manual `cron.yml` run | Both endpoints return 2xx; reminder emails fire (or weekend skip) |
| Staging deploy | Migrations applied, app live, `/api/health` healthy |
| CI on a PR | lint+build+unit, integration (migrations-based), migration-check all green |
| Secret rotation | Updating `CRON_SECRET` in repo + app keeps cron working; mismatch → 401 |

### 4c. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| Cron job 401 | `CRON_SECRET` repo secret ≠ app env var | Make them identical |
| Cron schedule never fires | GitHub schedules are best-effort and disabled on inactive repos | Verify repo activity; use `workflow_dispatch` to test |
| Vercel deploy: missing project link | `VERCEL_ORG_ID`/`VERCEL_PROJECT_ID` absent | Add all three Vercel secrets |
| `db:deploy` fails in CI | a `drizzle/*.sql` migration is invalid/out of order | Fix the migration; this is the parity working as intended |
| Vercel cron returns 401 (if A2 chosen) | routes check `x-cron-secret`, Vercel sends `Authorization: Bearer` | Use A1 (GitHub Actions) for this milestone, or adapt routes separately |
| Health check fails post-deploy | DB env var wrong or DB unreachable | Verify `DATABASE_URL` for the environment |
