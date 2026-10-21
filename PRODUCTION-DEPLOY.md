# CadenzPoint — Production Deployment Guide (step by step)

Work through this top to bottom. Each step says **who** does it, **where**, and **how to know it
worked**. Don't skip ahead: later steps depend on values you collect earlier.

> `DEPLOY-DEMO.md` is the older *free-tier demo* guide. This file supersedes it for a real
> production launch: separate staging + production, paid plans, live billing, gated deploys.

### Already ran the demo guide? Turn the demo into STAGING

If you followed `DEPLOY-DEMO.md` (a Vercel project on a `*.vercel.app` URL plus one Neon project
holding `cadenzpoint_control` and `tenant_acme` / `tenant_globex` / `tenant_initech`), **don't
delete it — reuse it as staging**:

| Guide step | What to do instead with the demo |
|---|---|
| Phase 5 (Neon) — **staging** half | Keep the demo's Neon project as the staging control plane. Its existing `tenant_*` databases already match the naming rule, so they double as stress-test tenants in 12.7. Check its region (project **Settings**); if it isn't `aws-us-east-1`, staging still works, just slower. |
| Phase 6.1 (staging Vercel project) | Don't create a new one: rename the demo project to `cadenzpoint-staging` (**Settings → General → Project Name**). |
| Phase 6.3 / 6.4 | Apply them to the renamed project: set region `iad1`, then **update** its env vars to the staging values in the 6.4 table (notably `APP_ROOT_DOMAIN` / `NEXT_PUBLIC_APP_ROOT_DOMAIN` = `staging.cadenzpoint.com`, `NEXT_PUBLIC_APP_URL` = `https://staging.cadenzpoint.com`, `EMAIL_FROM` on `cadenzpoint.com`, `NEON_API_KEY` + `NEON_REGION_ID`, Stripe **test** keys). Keep its existing `ENCRYPTION_KEY`: the demo tenants' connection strings were encrypted with it. |
| Phase 7.2 | Attach `staging.cadenzpoint.com` and `*.staging.cadenzpoint.com` to this project. |
| Production (Phases 5, 6.2, 7.1, onward) | Build fresh: a new Neon production control plane and a new `cadenzpoint` Vercel project. |

Two things to know:
- **Your domain currently forwards elsewhere.** If `cadenzpoint.com` redirects to a registrar
  forwarding/parking host, DNS was never pointed at Vercel. Phase 7.3 (switch nameservers to
  Vercel) replaces that forward, which is intended.
- **The demo stops auto-deploying on `git push`** once `vercel.json`'s `git.deploymentEnabled: false`
  reaches the branch Vercel watches. That's deliberate: from then on, staging updates go through the
  **Deploy to Staging** workflow, which needs the Phase 11 GitHub Environment secrets.

---

## How a production deploy works (read once)

```
You click "Run workflow" in GitHub Actions
   │
   ├─ 1. GitHub loads secrets from the matching GitHub Environment (staging OR production)
   ├─ 2. npm run db:migrate:all     → control plane + EVERY tenant DB migrated (locked, redacted logs)
   ├─ 3. npm run db:migrate:check   → fails the deploy if anything is still pending
   └─ 4. vercel pull/build/deploy   → new code goes live (runtime env vars live in Vercel)
```

Two rules follow from this:
1. **Deploys only happen through that workflow**, never by Vercel auto-deploying a `git push`
   (an auto-deploy skips step 2 and breaks every tenant on a schema change).
2. **Migrations must be backward-compatible** (expand/contract — see `MIGRATIONS.md`), because
   they run while the old code is still serving traffic. CI enforces this with `npm run db:safety`.

Every deploy also needs **two kinds of configuration**, kept in two different places:
| What | Where it lives | Used by |
|---|---|---|
| Migration + deploy credentials | **GitHub Environment secrets** (`staging`, `production`) | the GitHub Actions workflow |
| App runtime settings | **Vercel project environment variables** | the running app |

---

## Phase 1 — Pre-deploy code fixes ✅ DONE (one step left for you)

All six fixes are implemented and verified (type check, lint, 140 unit tests incl. a mocked-Neon
provisioning suite, and a full `next build` with Sentry wired in). **One step needs your machine,**
because it downloads a package from npm:
```bash
npm install server-only@0.0.1 --save-exact
```
That makes `server-only` a real dependency (Next.js had been resolving it internally), which
`npm run provision:tenant` needs. Then confirm the script loads — it should print its usage line:
```bash
npm run provision:tenant
```
Also run the integration suite once (`npm run test:integration` with `TEST_DATABASE_URL` set), since
the migration helper now converts pooled Neon URLs to direct ones.

What changed, for reference:

| # | Fix | Why it blocks |
|---|---|---|
| 1.1 | **Disable Vercel Git auto-deploys.** Add `"git": { "deploymentEnabled": false }` to `vercel.json` (keep the existing `crons`). | Otherwise every push to `main` auto-deploys to production *without* migrating tenants. |
| 1.2 | **Staging workflow fixes** (`.github/workflows/deploy-staging.yml`): Node `21` → `22`; deploy to a **separate staging Vercel project** as a production-type deployment (`vercel pull --environment=production`, `vercel build --prod`, `vercel deploy --prebuilt --prod`). | Node 21 is end-of-life. Preview deployments get random `*.vercel.app` URLs, which can't serve tenant subdomains, so staging can't test multi-tenancy. |
| 1.3 | **Neon provisioning** (`src/lib/tenant/neon.ts`): (a) `region_id` from `NEON_REGION_ID`; (b) tenant database named `tenant_<slug>` via one shared rule (`src/lib/tenant/db-name.ts`, also used by the stress test); (c) stores the **pooled** URL for the app, while migrations convert it back to the **direct** host (session advisory locks don't hold through Neon's transaction-mode pooler); (d) waits for Neon's setup operations to finish before first connect; (e) prefix `bytime-` → `cadenzpoint-`. Field names verified against the Neon API v2 reference. | (a) Tenants otherwise land in Neon's default region, far from your app. (b) Every Neon DB is otherwise named `neondb`, which blinds the isolation stress test. (c) The app's DB client is built for a pooler; direct connections from serverless can be exhausted. |
| 1.4 | **Fix `npm run provision:tenant`.** It crashed on load (`Cannot find module 'server-only'`): the package was never installed. Fixed by running the script under Node's `react-server` condition (so the guard resolves to its no-op build) plus installing `server-only` (your step above). | Your operator fallback for creating a tenant without the public signup flow. |
| 1.5 | **Wire up Sentry.** Add `instrumentation.ts` (register server/edge configs), `instrumentation-client.ts` (browser init), and wrap `next.config.ts` with `withSentryConfig` — following the installed `@sentry/nextjs` v10 docs. | Today nothing loads the `sentry.*.config.ts` files, so production errors are never reported. |
| 1.6 | **Email sender domain.** Change the `EMAIL_FROM` default in `src/lib/email/client.ts` and `.env.example` from `cadenzpoint.dev` to `cadenzpoint.com`. | You own `.com`; Resend refuses to send from an unverified domain. |

**Bonus fix found while verifying the build:** `AuditTrail.module.css` contained only a global selector,
which webpack's CSS Modules rejects (Turbopack tolerated it). The rule moved to `globals.css`.

---

## Phase 1b — Security hardening ✅ done (merged to `main`)

A review found critical authorization gaps (account takeover via password reset, self-approval of
timesheets, supervisor-to-admin escalation, MFA not enforced). Both blueprints are implemented,
audited and merged: `feature-plan-security-hardening.md` (round 1) and
`feature-plan-security-hardening-round2.md` (cross-tenant session replay, period-lock bypass, data
exposure, OAuth).

What it means for deployment:
- **Migration `0010`** (additive `users.totp_last_used_step`) ships with it. The deploy workflows
  run `db:migrate:all` before the app goes live, so nothing extra to do there; run
  `npm run db:migrate` on your local demo database yourself.
- **Optional env var `OAUTH_STATE_SECRET`** signs the QuickBooks/Gusto connect flow. If unset, a key
  is derived from `AUTH_SECRET`, so it only matters if you want to rotate the two separately. Set
  it alongside `QBO_*` / `GUSTO_*` when you enable those integrations.

## Phase 1c — Calendar dates & timezones (BLOCKING, do before any production tenant exists)

`feature-plan-calendar-dates.md`. In production (server on UTC, users in US time zones) the
timesheet grid is off by one day, edits can split into duplicate revision chains, and hours can be
double-counted. It changes date column types in one migration, which is only safe **before the first
production tenant**; after that it becomes a multi-deploy migration.

## Phase 1d — Terms compliance (BLOCKING for paid launch)

`feature-plan-terms-compliance.md`: trial expiry, billing grace/suspension, full export with every
revision, workspace deletion. Its §0 decisions come from the business side first. Build after 1c.

---

## Phase 2 — Get the code onto `main` (you, ~15 min)

Production deploys should come from `main`, never a work-in-progress branch.

**2.1** Open a pull request from `wip/cadenzpoint-rebuild` into `main`:
```bash
gh pr create --repo ccentofo/bytime --base main --head wip/cadenzpoint-rebuild --title "CadenzPoint multi-tenant SaaS" --body "Multi-tenant control plane, rebrand, charge codes, billing, UI polish, deploy safety."
```
**2.2** Wait for CI on the PR to go green (GitHub → the PR → **Checks**). It runs lint, build,
unit tests, `db:safety`, and integration tests. Fix anything red before continuing.

**2.3** Merge the PR (GitHub UI → **Merge pull request**).

**2.4** Protect `main`: GitHub → repo **Settings → Branches → Add branch ruleset** (or
"branch protection rule") for `main` → require a pull request before merging, and require the
**CI** status checks to pass.

✅ **Check:** `main` contains all the work and is protected.

---

## Phase 3 — Accounts and plans (you, ~1 hour, costs money)

| Service | Plan needed | Why |
|---|---|---|
| **Vercel** | **Pro** | Hobby is non-commercial per Vercel's terms. Pro is required to sell. |
| **Neon** | A **paid** plan with API access | Production provisions one Neon project per tenant via the API. Check the plan's project limit and point-in-time-restore (backup) window. |
| **Resend** | Free tier is fine to start | Verification, password-reset, and reminder email. |
| **Stripe** | Activate **live mode** (business + bank details) | Real payments. |
| **Sentry** | Free tier is fine to start | Error monitoring (after fix 1.5). |
| **Password manager** | Any (1Password, Bitwarden…) | You're about to create secrets you can never lose. |

✅ **Check:** you can log in to all five dashboards, and Vercel shows **Pro**.

---

## Phase 4 — Generate secrets (you, ~10 min)

Generate **separate** values for staging and production. Never reuse a production secret anywhere else.

Run each command **twice** (once for staging, once for production) and save each output in your
password manager, labeled e.g. `CadenzPoint PROD — ENCRYPTION_KEY`:
```bash
openssl rand -hex 32
```
↑ use for **ENCRYPTION_KEY**
```bash
openssl rand -base64 32
```
↑ use for **AUTH_SECRET**
```bash
openssl rand -hex 16
```
↑ use for **CRON_SECRET**

> ⚠️ **ENCRYPTION_KEY is unrecoverable.** It encrypts every tenant's database connection string.
> If you lose it, the app can never reach any tenant database again. Keep it in the password
> manager *and* a second safe place. Never change it without a planned re-encryption.
> Rotating **AUTH_SECRET** logs every user out (acceptable in an emergency).

✅ **Check:** 6 values saved (3 staging, 3 production).

---

## Phase 5 — Neon databases (you, ~20 min)

Do this once for **staging** and once for **production**.

**5.1** Neon console → **New Project**:
- Name: `cadenzpoint-control-staging` (or `cadenzpoint-control-prod`)
- Postgres version: **16**
- Region: **AWS US East (N. Virginia) — `aws-us-east-1`** (matches Vercel's default `iad1` region)

**5.2** In that project: **Databases → New Database** → name it `cadenzpoint_control`.

**5.3** Get the **pooled** connection string: project **Dashboard → Connect** → Database =
`cadenzpoint_control`, **Connection pooling ON** (the host contains `-pooler`). Copy it.
Save it as `CONTROL_PLANE_DATABASE_URL` for that environment.

**5.4** Check the backup window: project **Settings → Storage / History retention**. Set it to
the maximum your plan allows. (DCAA expects ~3-year record retention; long-term retention is a
separate pre-sale task.)

**5.5** (Once, not per environment) Create the **API key** used to provision tenants:
Neon **Account/Organization settings → API keys → Create**. Save it as `NEON_API_KEY`.
Also note the region id from 5.1 (`aws-us-east-1`) as `NEON_REGION_ID`.

> Staging and production can share one Neon API key, but their **control-plane databases must be
> separate** (5.1 done twice). Tenant projects created by staging signups will also appear in your
> Neon account; name them clearly (fix 1.3 adds the `cadenzpoint-` prefix).

✅ **Check:** two pooled `CONTROL_PLANE_DATABASE_URL`s (staging + prod), one `NEON_API_KEY`.

---

## Phase 6 — Vercel projects (you, ~30 min)

You'll create **two** Vercel projects: `cadenzpoint-staging` and `cadenzpoint` (production).

**6.1** Vercel → **Add New → Project** → import `ccentofo/bytime` from GitHub → name it
`cadenzpoint-staging`. Framework: Next.js (auto). **Don't click Deploy yet** if offered; if it
deploys anyway, ignore that build.

**6.2** Repeat 6.1 for the production project, named `cadenzpoint`.

**6.3** For **each** project: **Settings → Functions → Function Region** → `Washington, D.C., USA
(East) – iad1` (must match Neon's `aws-us-east-1`).

**6.4** For **each** project: **Settings → Environment Variables**. Add these with the
**Production** environment checked (each project is its own environment, so staging gets staging
values and production gets production values):

| Variable | Staging project value | Production project value |
|---|---|---|
| `CONTROL_PLANE_DATABASE_URL` | staging pooled URL (5.3) | prod pooled URL (5.3) |
| `ENCRYPTION_KEY` | staging (Phase 4) | prod (Phase 4) |
| `AUTH_SECRET` | staging | prod |
| `CRON_SECRET` | staging | prod |
| `NEXT_PUBLIC_APP_URL` | `https://staging.cadenzpoint.com` | `https://cadenzpoint.com` |
| `APP_ROOT_DOMAIN` | `staging.cadenzpoint.com` | `cadenzpoint.com` |
| `NEXT_PUBLIC_APP_ROOT_DOMAIN` | `staging.cadenzpoint.com` | `cadenzpoint.com` |
| `NEON_API_KEY` | from 5.5 | from 5.5 |
| `NEON_REGION_ID` | `aws-us-east-1` | `aws-us-east-1` |
| `RESEND_API_KEY` | staging key (Phase 8) | prod key (Phase 8) |
| `EMAIL_FROM` | `CadenzPoint Staging <noreply@cadenzpoint.com>` | `CadenzPoint <noreply@cadenzpoint.com>` |
| `STRIPE_SECRET_KEY` | **test** `sk_test_…` (Phase 9) | **live** `sk_live_…` (Phase 9) |
| `STRIPE_WEBHOOK_SECRET` | test `whsec_…` | live `whsec_…` |
| `STRIPE_PRICE_STARTER` / `_PRO` / `_ENTERPRISE` | test price IDs | live price IDs |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry DSN (Phase 10) | Sentry DSN |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.2` | `0.1` |
| `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | *optional* — enables source-map upload for readable stack traces | same |
| `CSP_MODE` | `report-only` | `report-only` (flip to `enforce` in Phase 13) |

**Do NOT set** in either project: `DIAG_SECRET` (only temporarily, Phase 12), `DATABASE_URL`,
`DEV_TENANT_ADMIN_DATABASE_URL`, `TEST_DATABASE_URL*`. Leave `QBO_*` / `GUSTO_*` unset until those
integrations are approved for production by Intuit/Gusto.

> `NEXT_PUBLIC_*` values are baked in at build time. If you change one later, redeploy.

**6.5** Collect deploy credentials for GitHub (Phase 11):
- **Team/Org ID:** Vercel → team **Settings → General → Team ID** → `VERCEL_ORG_ID`.
- **Project IDs:** each project → **Settings → General → Project ID** → staging and prod
  `VERCEL_PROJECT_ID` (two different values).
- **Token:** Vercel → account **Settings → Tokens → Create** → scope to your team, set an expiry
  (e.g. 1 year, calendar a reminder) → `VERCEL_TOKEN`.

✅ **Check:** both projects have every variable above; you have 1 org ID, 2 project IDs, 1 token.

---

## Phase 7 — Domains and DNS (you, ~20 min + waiting)

**7.1** Production project → **Settings → Domains** → add:
`cadenzpoint.com`, `www.cadenzpoint.com`, `*.cadenzpoint.com`

**7.2** Staging project → **Settings → Domains** → add:
`staging.cadenzpoint.com`, `*.staging.cadenzpoint.com`

**7.3** When Vercel offers **Vercel DNS / nameservers**, go to your domain registrar and replace
the domain's nameservers with the ones Vercel shows (e.g. `ns1.vercel-dns.com`,
`ns2.vercel-dns.com`). This lets Vercel issue the **wildcard SSL certificates** automatically.

**7.4** Set `www.cadenzpoint.com` to redirect to `cadenzpoint.com` (Domains → edit → Redirect).

**7.5** Wait for every domain to show a green check (minutes to a few hours). Then confirm DNS:
```bash
dig +short NS cadenzpoint.com
```
↑ should list Vercel's nameservers.

✅ **Check:** all 5 domains green in Vercel.

---

## Phase 8 — Email: Resend (you, ~20 min + waiting)

**8.1** Resend → **Domains → Add Domain** → `cadenzpoint.com` → region US.

**8.2** Copy the DNS records Resend shows (SPF `TXT`, DKIM `TXT`/`CNAME`, and the MX/return-path
record) into **Vercel → Domains → cadenzpoint.com → DNS Records**, exactly as given.

**8.3** Add a DMARC record in the same place: type `TXT`, name `_dmarc`, value
`v=DMARC1; p=none; rua=mailto:<your-email>`. (Tighten `p=` to `quarantine` after a few clean weeks.)

**8.4** Back in Resend, click **Verify**; wait for **Verified**.

**8.5** Resend → **API Keys** → create two **sending-only** keys, one named `staging` and one
`production`. Put them in each Vercel project's `RESEND_API_KEY` (Phase 6.4).

✅ **Check:** Resend shows `cadenzpoint.com` **Verified**.

---

## Phase 9 — Billing: Stripe (you, ~45 min)

**Staging uses Stripe TEST mode; production uses LIVE mode.** Do 9.1–9.4 in test mode for
staging, then again in live mode for production (dashboard toggle: **Test mode**).

**9.1** **Product catalog → Add product**: create Starter, Pro, Enterprise with recurring
monthly prices. Copy each **price ID** (`price_…`) into `STRIPE_PRICE_STARTER` / `_PRO` /
`_ENTERPRISE`.

**9.2** **Developers → Webhooks → Add endpoint**:
- URL: `https://staging.cadenzpoint.com/api/stripe/webhook` (test) /
  `https://cadenzpoint.com/api/stripe/webhook` (live)
- Events — select exactly these four (the ones the app handles):
  `customer.subscription.created`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `invoice.payment_failed`
- Copy the endpoint's **Signing secret** → `STRIPE_WEBHOOK_SECRET`.

**9.3** **Settings → Billing → Customer portal** → enable it, allow cancel and plan switching
between your three prices, save. (The app's "Manage billing" button fails until this is saved.)

**9.4** **Developers → API keys** → copy the **Secret key** → `STRIPE_SECRET_KEY`
(`sk_test_…` for staging, `sk_live_…` for production).

✅ **Check:** each Vercel project has its Stripe secret, webhook secret, and three price IDs.

---

## Phase 10 — Error monitoring: Sentry (you, ~10 min)

**10.1** Sentry → **Create Project** → platform **Next.js** → name `cadenzpoint`.

**10.2** Copy the **DSN** into both Vercel projects' `NEXT_PUBLIC_SENTRY_DSN`. (Sentry tags each
event with its environment, so one project is fine for both.)

**10.3** Sentry → **Alerts** → create an alert: "a new issue is created" → email you.

✅ **Check:** DSN set in both projects (it only starts reporting after fix 1.5 is deployed).

---

## Phase 11 — GitHub Environments (you, ~15 min)

**11.1** GitHub → repo **Settings → Environments → New environment** → `staging`.
Add these **environment secrets**:

| Secret | Value |
|---|---|
| `CONTROL_PLANE_DATABASE_URL` | staging pooled URL |
| `ENCRYPTION_KEY` | staging key |
| `AUTH_SECRET` | staging secret |
| `VERCEL_TOKEN` | from 6.5 |
| `VERCEL_ORG_ID` | from 6.5 |
| `VERCEL_PROJECT_ID` | **staging** project ID |

**11.2** **New environment** → `production`. Add the same six secrets with **production** values
(and the **production** `VERCEL_PROJECT_ID`). Then on this environment:
- **Required reviewers:** add yourself (every production deploy waits for your approval).
- **Deployment branches:** "Selected branches" → `main` only.

**11.3** Make sure none of those secrets exist as **repo-level** secrets (repo **Settings →
Secrets and variables → Actions → Repository secrets**). If they do, delete them, or the two
environments could read the same values.

✅ **Check:** two environments, six secrets each, production gated to `main` + your approval.

---

## Phase 12 — First STAGING deploy and full rehearsal (you, ~1 hour)

**12.1** GitHub → **Actions → Deploy to Staging → Run workflow** → branch `main` → type `deploy`
→ **Run**.

**12.2** Watch the run. Expected:
- "Migrate control plane + all tenants" → control plane migrated, `Migrating 0 tenant(s)` (none yet).
- "Verify every database is current" → exit 0.
- Vercel deploy step finishes with a deployment URL.

**12.3** Health check:
```bash
curl -s https://staging.cadenzpoint.com/api/health
```
↑ expect `{"status":"healthy", …}`.

**12.4** Create a test tenant through the **real signup flow**: open
`https://staging.cadenzpoint.com/signup`, use a real inbox you control, workspace name e.g.
`stagetest`. Open the verification email → confirm → set password at
`https://stagetest.staging.cadenzpoint.com`. Repeat with a second workspace (e.g. `stagetest2`).
In Neon you should now see two new `cadenzpoint-…` projects.

**12.5** Click through as the admin: setup wizard, create a contract/CLIN/charge code, assign it,
enter time, submit, approve, export a report. Toggle dark mode.

**12.6** Smoke test:
```bash
./scripts/smoke-tenancy.sh https://staging.cadenzpoint.com https://stagetest.staging.cadenzpoint.com <STAGING_CRON_SECRET>
```
↑ expect all checks passing.

**12.7** Isolation stress test (requires fix 1.3's `tenant_<slug>` database names):
1. In the **staging** Vercel project, temporarily add `DIAG_SECRET` = output of `openssl rand -hex 32`, then redeploy (re-run 12.1).
2. Run:
```bash
DIAG_SECRET=<that value> npm run stress:isolation -- --base staging.cadenzpoint.com --scheme https --tenants stagetest,stagetest2 --concurrency 30 --rounds 30
```
3. Expect **✅ PASS, 0 cross-tenant leaks**. Then **delete `DIAG_SECRET`** from Vercel and redeploy.

**12.8** Billing (test mode): as the stagetest admin open **Billing**, subscribe with card
`4242 4242 4242 4242` (any future date, any CVC). Confirm Stripe → Webhooks shows successful
deliveries and the app shows the plan as active. Open **Manage billing** (customer portal).

**12.9** Email: confirm the verification email arrived, and trigger a password reset to confirm it arrives too.

**12.10** CSP: open the browser DevTools console on several pages and look for CSP violation
reports. Note any for Phase 13.4.

**12.11** Sentry (after fix 1.5): visit a deliberately broken URL or trigger a test error and
confirm an event appears in Sentry.

✅ **Check:** every step above passed on staging. **Do not touch production until it does.**

---

## Phase 13 — First PRODUCTION deploy (you, ~45 min)

**13.1** GitHub → **Actions → Deploy to Production → Run workflow** → branch `main` → type
`deploy-prod` → **Run**. The job pauses for **your approval** (Phase 11.2) → **Review deployments
→ Approve**.

**13.2** Same expectations as 12.2, then:
```bash
curl -s https://cadenzpoint.com/api/health
```

**13.3** Create the **first real workspace** through `https://cadenzpoint.com/signup` (your own
company or the first customer). Complete the verification email and password setup.

**13.4** If 12.10 showed **zero** CSP violations: set `CSP_MODE` = `enforce` in the production
Vercel project and redeploy (re-run 13.1). Re-check the console afterward.

**13.5** Confirm crons are scheduled: production Vercel project → **Settings → Cron Jobs** shows
the two jobs from `vercel.json`. (Crons only run on production deployments.)

**13.6** Run the smoke test against production:
```bash
./scripts/smoke-tenancy.sh https://cadenzpoint.com https://<first-workspace>.cadenzpoint.com <PROD_CRON_SECRET>
```

✅ **Check:** production is live with one real workspace.

---

## Phase 14 — Operating it (ongoing)

**Every future release**
1. Merge to `main` via PR (CI green, including `db:safety`).
2. Deploy to **staging** (Phase 12.1) and spot-check.
3. Deploy to **production** (Phase 13.1) and approve.

**Rollback:** Vercel → production project → **Deployments** → pick the last good one →
**Instant Rollback**. Because migrations are backward-compatible (expand/contract), the older code
keeps working against the newer schema. Never roll back by running down-migrations.

**A single tenant failed to migrate:** the deploy stops before the new code goes live. Fix the
cause, then re-run just that tenant locally with the production values in your shell:
`npm run db:migrate:all -- --tenant <slug>`, then re-run the deploy.

**Monthly:** test a Neon point-in-time restore into a scratch branch, and confirm Sentry and email
are still delivering. **Yearly:** rotate `VERCEL_TOKEN` before it expires.

---

## Phase 15 — Before charging real customers (not deploy blockers, but launch blockers)

| Item | Why |
|---|---|
| **Distributed rate limiting** (e.g. Upstash Redis) | The current limiter is in memory and per serverless instance, so it barely protects login/signup on Vercel. |
| **Long-term retention + backup policy** | DCAA expects ~3-year record retention; Neon's restore window is far shorter. |
| **Your own security posture** (NIST 800-171 / CMMC answer, SOC 2 roadmap) | Usually the deciding question from defense-contractor buyers. Also decide whether you'll store CUI; if so, commercial-region hosting may not be acceptable. |
| **Terms of Service, Privacy Policy, DPA** reviewed by a lawyer | Required to sell. |
| **Trademark clearance** for "CadenzPoint" | Before marketing spend. |
| **QuickBooks / Gusto production approval** | Intuit and Gusto review apps before issuing production keys; test against their sandboxes first. |
| **Excel cost report** shows charge codes and Class | Feature gap (PDF already does). |
