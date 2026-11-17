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
revision, workspace deletion. Its §0 decisions come from the business side first (answered — see
`src/lib/tenant/lifecycle-config.ts`). Build after 1c.

**T1 backfill**: immediately after `db:migrate:all` applies the T1 control-plane migration in each
environment, run `npm run backfill:trial-dates` (reads `CONTROL_PLANE_DATABASE_URL` from the
environment) so every pre-existing trial tenant gets a `trial_ends_at`. Idempotent — safe to re-run.
Use `--check` first to preview with no changes applied.

**Lifecycle crons** (`feature-plan-terms-compliance-fixes.md` §4.4): `/api/cron/tenant-lifecycle`
(daily) reconciles with Stripe, applies due state changes, and emails the founder digest;
`/api/cron/notice-delivery` (every 10 minutes, needs Vercel **Pro**) delivers and retries the
lifecycle notices; `/api/cron/seat-sync` (every 10 minutes, `feature-plan-per-user-billing.md` §6.5) keeps each
Standard subscription's Stripe quantity in step with the active users. All are in `vercel.json`. Set `OPS_ALERT_EMAIL` (6.4). The digest is **sent every
day** (LB-D7, `feature-plan-launch-blockers.md` P6) — a short "all quiet" version when nothing needs action
— and lists unresolved alerts, workspaces ready for deletion, stuck deletions, notices pending more than
24 h, forced notices, the lifecycle-exempt (demo) list, and **any cron that is overdue or has never run**
(each cron records a heartbeat in `cron_runs`). Without `OPS_ALERT_EMAIL` no digest is sent (log warning,
plus a `digest-disabled` alert in production). **No digest by 15:00 UTC → the lifecycle cron is down;
investigate** (Vercel → Cron Jobs and the function logs).

**First deploy of the lifecycle code in an environment — in this order:**
1. Migrate the control plane **before** any new code is deployed, with that environment's values in your
   shell (the deploy workflow would migrate too, but steps 2–3 must happen in between):
   ```bash
   CONTROL_PLANE_DATABASE_URL='<that environment's pooled URL>' ENCRYPTION_KEY='<that environment's key>' npm run db:migrate:all
   ```
2. Mark the existing demo workspaces exempt (F1), or re-seed them with `npm run seed:demo` (which marks
   them exempt) — with the same `CONTROL_PLANE_DATABASE_URL` in your shell:
   ```bash
   npm run tenant:admin -- set-exempt acme on --reason "demo workspace" --yes
   npm run tenant:admin -- set-exempt globex on --reason "demo workspace" --yes
   npm run tenant:admin -- set-exempt initech on --reason "demo workspace" --yes
   ```
3. **Staging only:** clear the `tenant_notices` rows created by the earlier build (old anchors; pre-launch
   only):
   ```bash
   psql '<staging control plane URL>' -c 'TRUNCATE tenant_notices;'
   ```
4. Then deploy the new code (Phase 12.1 for staging, 13.1 for production).

Every founder script prints the control plane it is about to touch (`Target control plane: host/db`, with
a boxed warning when it isn't local) — read it before typing `--yes`.

**Founder tooling** (`npm run tenant:admin -- <command>`; every change needs `--yes`, is audited, and
can take 60 s to show in the app): `show <slug>`, `extend-trial <slug> <days>`, `end-trial <slug>`,
`suspend <slug> --reason "…"` (policy breach: hold screen for everyone, export blocked, admins emailed),
`unsuspend <slug>`, `set-policy-export <slug> on|off --reason "…"` (F5: allow/block export for one policy hold),
`set-exempt <slug> on|off --reason "…"`,
`force-notice-sent <slug> <kind> --reason "…"`, `export-destroyed <slug> [--legal-hold "…"]`,
`resolve-alert <id> --note "…"`, `audit-note <slug> --note "…"` (append a note to the audit trail — used by
[`RESTORE.md`](RESTORE.md)), `waitlist list` and `waitlist provision <signup-id>` (below),
`reopen-import-window <slug> --days <1-30> --reason "…"` (`feature-plan-certified-outputs.md` C1: lets one workspace
import a missed period of timesheet history after its first submission — a support action; the period-lock and
overlap guards still apply; `show` prints the window state, reading the workspace DB when `ENCRYPTION_KEY` is set).

**Signup abuse controls** (`feature-plan-launch-blockers.md` P5, LB-D2): Cloudflare Turnstile on `/signup`, at most
3 verified workspaces per network per day, a global cap of 20 new workspaces per day (past it, verified signups are
waitlisted and the founder is emailed once that day), cleanup of old signup rows (LB-D5) and an alert at 80 Neon
projects. All of it is behind `SIGNUP_CONTROLS_ENABLED` (6.4), **off by default — signup then works exactly as
before**. Before turning it on in **production**: (1) the updated Privacy Policy (§2 IP-hash sentence, §4 Cloudflare
as subprocessor, §7 signup retention) is published; (2) `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` and
`SIGNUP_IP_SALT` are set (missing secret or salt → every signup is refused and you get a `signup-config-missing`
email). Waitlisted signups appear in the daily digest; provision one with
`npm run tenant:admin -- waitlist provision <signup-id> --yes` (it emails the set-password link; if that email fails,
it prints the link — send it yourself). The 80-project alert and the IP-hash cleanup run whatever the flag.

**T7 backfill**: after `db:migrate:cp` applies the T7 control-plane migration, run
`npm run backfill:neon-project-ids` (reads `CONTROL_PLANE_DATABASE_URL` and `NEON_API_KEY`) so
every pre-existing tenant gets its `neon_project_id` recorded — `npm run tenant:delete` needs it to
know which Neon project to delete. Idempotent; `--check` previews with no changes. See
`TENANT-DELETION.md` for the deletion runbook itself.

**LB-D1 retention backfill**: tenant Neon projects created before `feature-plan-launch-blockers.md` P6
keep Neon's default 1 day of history. After that code is deployed, run (reads `CONTROL_PLANE_DATABASE_URL`
and `NEON_API_KEY`):
```bash
npm run backfill:neon-retention -- --check
npm run backfill:neon-retention
```
It sets 7 days on every tenant project, lists tenants without a `neon_project_id` as needing manual action
(run the T7 backfill first), and exits non-zero if any project failed. Restores use this history:
[`RESTORE.md`](RESTORE.md).

---

## Phase 2 — Get the code onto `main` (you, ~15 min)

Production deploys should come from `main`, never a work-in-progress branch.

**2.1** Open a pull request into `main` from the branch that holds the work you're shipping (replace
`<release-branch>`; check with `git branch -a` — don't reuse an old branch name from this guide):
```bash
gh pr create --repo ccentofo/bytime --base main --head <release-branch> --fill
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
Neon **Organization settings → API keys → Create** (an **Organization** API key, not one made under your account
settings: the daily disaster checks need the organisation's full project list, feature-plan-disaster-restore.md §6.8).
Save it as `NEON_API_KEY`. If your current key was made under account settings, replace it.
Also note the region id from 5.1 (`aws-us-east-1`) as `NEON_REGION_ID`, and each control plane's **project id**
(Neon → the control-plane project → Settings → General) as `CONTROL_PLANE_PROJECT_ID` (staging's and production's).

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
| `OPS_ALERT_EMAIL` | your staging-watching inbox (optional) | the founder inbox for the deletion/failure digest (T4) |
| `NEXT_PUBLIC_APP_URL` | `https://staging.cadenzpoint.com` | `https://cadenzpoint.com` |
| `APP_ROOT_DOMAIN` | `staging.cadenzpoint.com` | `cadenzpoint.com` |
| `NEXT_PUBLIC_APP_ROOT_DOMAIN` | `staging.cadenzpoint.com` | `cadenzpoint.com` |
| `NEON_API_KEY` | from 5.5 | from 5.5 |
| `NEON_REGION_ID` | `aws-us-east-1` | `aws-us-east-1` |
| `CONTROL_PLANE_PROJECT_ID` | staging control plane's Neon project id (5.5) | production control plane's Neon project id (5.5): the daily disaster checks use it to prove the key sees the organisation; until it's set, `rebuild-watch-check-failed` appears daily where `BACKUPS_EXPECTED=1` |
| `RESEND_API_KEY` | staging key (Phase 8) | prod key (Phase 8) |
| `EMAIL_FROM` | `CadenzPoint Staging <noreply@cadenzpoint.com>` | `CadenzPoint <noreply@cadenzpoint.com>` |
| `STRIPE_SECRET_KEY` | **test** `sk_test_…` (Phase 9) | **live** `sk_live_…` (Phase 9) |
| `STRIPE_WEBHOOK_SECRET` | test `whsec_…` | live `whsec_…` |
| `STRIPE_PRICE_STANDARD_MONTHLY` / `STRIPE_PRICE_STANDARD_ANNUAL` | test price IDs (9.1) | live price IDs (9.1) |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry DSN (Phase 10) | Sentry DSN |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.2` | `0.1` |
| `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | `0.2` (browser) | `0.1` (browser) |
| `SENTRY_ENVIRONMENT` / `NEXT_PUBLIC_SENTRY_ENVIRONMENT` | `staging` | `production` |
| `SENTRY_CRON_MONITORS` | leave unset | leave unset (LB-D7: no paid cron monitors; revisit at ~10 paying customers) |
| `NEON_HISTORY_RETENTION_SECONDS` | `21600` **only** if the staging Neon org is on the Free plan (it rejects more) | leave unset (7 days, LB-D1) |
| `NEXT_PUBLIC_DEMO_URL` | *optional* — a demo workspace URL for the marketing page's demo buttons (hidden when unset) | same |
| `SIGNUP_CONTROLS_ENABLED` | leave unset (signup works as before) until the product owner decides to enable signup controls (P5) | **leave unset until the updated Privacy Policy is published** (LB-D3, LB-D5) |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile widget keys (staging hostname) | production hostname keys |
| `SIGNUP_IP_SALT` | `openssl rand -hex 32` (secret; never shown to browsers). **Required even with signup controls off:** it also keys the rate-limit hashes, and without it sign-in and signup limits stay per-instance | a different `openssl rand -hex 32` |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`) | **set by the Upstash integration** (Phase 8b) for the staging database; don't type them | set by the integration for the production database |
| `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | *optional* — enables source-map upload for readable stack traces | same |
| `CSP_MODE` | `report-only` | `report-only` (flip to `enforce` in Phase 13) |
| `BACKUPS_EXPECTED` | `0` (no staging backups; Phase 13b step 9 sets `1` for one day) | leave unset until Phase 13b step 12, then `1`. Unset, the digest says "Backup monitoring is not configured" every day; `0` quiets that to an "off" line, which still counts as news |

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

## Phase 8b — Rate limiting: Upstash (you, ~10 min)

Sign-in and signup limits are shared across Vercel instances through Upstash Redis (`feature-plan-upstash-rate-limiting.md`). Each project gets its own database. Only hashed IPs are stored, and every entry expires within 2 hours.

**8b.1** Vercel → the **`cadenzpoint-staging`** project → **Storage** (or **Integrations → Marketplace**) → **Upstash** → **Upstash for Redis** → **Create**:
- name `cadenzpoint-staging-ratelimit`;
- region **US East (N. Virginia), us-east-1**;
- plan **Pay as You Go** (or Free while testing);
- connect it to `cadenzpoint-staging` with the **Production** environment checked.

**8b.2** Repeat for the **`cadenzpoint`** project: name `cadenzpoint-ratelimit`, us-east-1, connected to `cadenzpoint` (Production).

**8b.3** In each project, **Settings → Environment Variables** now shows the integration's variables: `KV_REST_API_URL` and `KV_REST_API_TOKEN`, or `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Either pair works. Don't add them by hand, and never paste the `REDIS_URL` (`rediss://…`) into the REST URL.

**8b.4** Usage alerts (product owner decision Q5: alerts, **no hard cap**), in the Upstash console (or Vercel's usage settings, whichever offers it): an email alert at **$5** and another at **$10** for each database.

✅ **Check:** both projects list the two variables, and both databases show region us-east-1.

---

## Phase 9 — Billing: Stripe (you, ~45 min)

**Staging uses Stripe TEST mode; production uses LIVE mode.** Do 9.1–9.4 in test mode for
staging, then again in live mode for production (dashboard toggle: **Test mode**).

**9.1** **Product catalog → Add product**: one product, **CadenzPoint Standard**, with two **graduated**
(tiered) recurring prices, exactly as `BUSINESS-DECISIONS.md` §1:
- **monthly:** users 1–5 flat $50.00 at $0 per unit; users 6 and up at $10.00 per unit;
- **yearly:** users 1–5 flat $510.00 at $0 per unit; users 6 and up at $102.00 per unit.

Copy the two **price IDs** (`price_…`) into `STRIPE_PRICE_STANDARD_MONTHLY` and `STRIPE_PRICE_STANDARD_ANNUAL`.
Enterprise has no price here: the founder makes those subscriptions by hand (see "Invoiced and Enterprise
subscriptions" below).
- **Coupon:** 20% off, duration repeating, 24 months. Which prices it applies to ("applies to products/prices") is
  the business side's call (the monthly price for sure; the annual one per their decision).
- **Promotion code** `FOUNDING` on that coupon, max 10 redemptions.
- **Settings → Payment methods:** turn on **ACH Direct Debit** (US bank account).

**9.2** **Developers → Webhooks → Add endpoint**:
- URL: `https://staging.cadenzpoint.com/api/stripe/webhook` (test) /
  `https://cadenzpoint.com/api/stripe/webhook` (live)
- Events — select exactly these ten (the ones the app handles,
  feature-plan-terms-compliance-fixes.md §4.3 and feature-plan-per-user-billing.md §6.9): `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`,
  `invoice.payment_failed`, `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `customer.updated`, `customer.deleted`
- If the Dashboard offers an API version for the endpoint, choose `2025-02-24.acacia`. It isn't required: the
  webhook never trusts the payload's state, and it reads invoice events in both shapes.
- Copy the endpoint's **Signing secret** → `STRIPE_WEBHOOK_SECRET`.

**9.3** **Settings → Billing → Customer portal** → enable it and allow: **payment method update**,
**invoice history**, **cancel at end of billing period** (never "cancel immediately" — customers keep
access until the period ends, Terms §17.2). **Plan switching: off. Quantity changes: off** (the app manages the
quantity; monthly↔annual switches are done by the founder, see the runbook below). Save.
(The app's "Manage billing" button fails until this is saved.)

**9.4** **Developers → API keys** → copy the **Secret key** → `STRIPE_SECRET_KEY`
(`sk_test_…` for staging, `sk_live_…` for production).

**9.5** **Settings → Billing → Subscriptions and emails → Manage failed payments**: when all
retries fail, choose **leave the subscription past due** (never "cancel the subscription"). The app
itself suspends at day 15 and terminates at day 45 after notice emails (Terms §4.7); if Stripe cancels
first, customers would be cut off on Stripe's schedule, without the notices the Terms promise.
- **Invoices sent to customers** (what happens after the due date): also **leave the subscription past due**.
- For failed payments **and** for invoices sent to customers, set the **invoice** outcome to **leave the invoice as-is
  (open)**, never "mark uncollectible".
- Leave **subscription status resolution** at Stripe's default; the app doesn't depend on it (it reads invoiced
  customers' invoices directly).

✅ **Check:** each Vercel project has its Stripe secret, webhook secret, and two price IDs.

**Invoiced and Enterprise subscriptions (runbook)** — env for these commands: the control-plane URL,
`ENCRYPTION_KEY`, and the `STRIPE_SECRET_KEY` of the intended mode.
1. For Enterprise only, **first**: `npm run tenant:admin -- set-plan <slug> enterprise --yes`.
2. `npm run tenant:admin -- ensure-customer <slug> --stripe-mode live --yes` (on staging: `--stripe-mode test`) →
   prints `cus_…`. In the Dashboard, set that customer's **email** to the person who pays invoices (Stripe can't send
   invoices without one).
3. In the Dashboard, create the subscription **on that customer**:
   - the Standard price for per-user invoicing, with **quantity = the live active-user count** printed by
     `npm run tenant:admin -- show <slug>` (needs `ENCRYPTION_KEY`); or a custom price for Enterprise;
   - collection method **Send invoice**, net 30, for invoiced customers.
4. `npm run tenant:admin -- show <slug>` shows the subscription as active within a minute.
5. Don't edit the quantity of a Standard subscription by hand; the app manages it. A raise is billed until renewal.
   A cut below the active count is raised back with proration, which charges the customer twice if your cut gave no
   credit.
6. Switching between monthly and annual on request: **only inside the last day before renewal.**
   - First run `npm run tenant:admin -- seat-sync <slug> --stripe-mode live --yes` and check in `show` that the seat
     row's quantity equals the live active count.
   - Then, in the Dashboard, schedule the price change at the period end with that quantity.
   - After the renewal, release the schedule (Dashboard → subscription → schedule → Release) and check in the Stripe
     Dashboard that the subscription has no schedule.
   - Scheduling earlier freezes an older quantity into the next term; the app then raises
     `seat-sync-schedule-attached`.
7. When an Enterprise contract ends and the customer moves to self-serve Standard:
   `npm run tenant:admin -- set-plan <slug> standard --yes`.
8. To move a card or ACH customer to invoicing, switch the collection method only when no invoice is open. Otherwise
   void the open invoice and re-issue it as a "send invoice" one with a due date (an open card invoice keeps being
   chased from the original failure date). The **reverse** switch (invoicing to card) only once every invoice is paid
   or voided: a card subscription follows Stripe's status, which can drop an unpaid invoice's dunning.
9. For a terminated workspace, cancel the old subscription in the Dashboard **before** creating a new one; otherwise
   the old active subscription stays tracked and the workspace stays ended (only `duplicate-live-subscriptions` shows
   it).

---

## Phase 10 — Error monitoring: Sentry (you, ~10 min)

**10.1** Sentry → **Create Project** → platform **Next.js** → name `cadenzpoint`.

**10.2** Copy the **DSN** into both Vercel projects' `NEXT_PUBLIC_SENTRY_DSN`. One Sentry project serves
both: set `SENTRY_ENVIRONMENT` and `NEXT_PUBLIC_SENTRY_ENVIRONMENT` (6.4) to `staging` / `production` so
every event is tagged with where it came from.

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
| `NEON_API_KEY` | from 5.5 — the migrate steps use it to confirm a half-deleted (`deleting`) tenant's Neon project is gone; without it every deploy FAILS while such a tenant exists ("NEON_API_KEY missing — cannot confirm deletion") |
| `VERCEL_TOKEN` | from 6.5 |
| `VERCEL_ORG_ID` | from 6.5 |
| `VERCEL_PROJECT_ID` | **staging** project ID |

**11.2** **New environment** → `production`. Add the same seven secrets with **production** values
(and the **production** `VERCEL_PROJECT_ID`). Then on this environment:
- **Required reviewers:** add yourself (every production deploy waits for your approval).
- **Deployment branches:** "Selected branches" → `main` only.

**11.3** Make sure none of those secrets exist as **repo-level** secrets (repo **Settings →
Secrets and variables → Actions → Repository secrets**). If they do, delete them, or the two
environments could read the same values.

✅ **Check:** two environments, seven secrets each, production gated to `main` + your approval.

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
↑ expect all checks passing. The cron check uses the `?probe=1` smoke probe: it proves the cron route and
`CRON_SECRET` without running the real job (no reminder emails).

**12.7** Isolation stress test (requires fix 1.3's `tenant_<slug>` database names):
1. In the **staging** Vercel project, temporarily add `DIAG_SECRET` = output of `openssl rand -hex 32`, then redeploy (re-run 12.1).
2. Run:
```bash
DIAG_SECRET=<that value> npm run stress:isolation -- --base staging.cadenzpoint.com --scheme https --tenants stagetest,stagetest2 --concurrency 30 --rounds 30
```
3. Expect **✅ PASS, 0 cross-tenant leaks**. Then **delete `DIAG_SECRET`** from Vercel and redeploy.

**12.8** Billing (test mode): give stagetest **at least 5 active users** first (below 5 an added user is inside the
flat tier: +1 with no proration). As the stagetest admin open **Billing**, choose **Standard, monthly** and pay with
card `4242 4242 4242 4242` (any future date, any CVC); the checkout quantity equals the active users. Confirm Stripe →
Webhooks shows successful deliveries and the app shows the plan as active. Add a user: within 10 minutes the
subscription shows +1 and a pending proration. Open **Manage billing** (customer portal).

**12.8b** Lifecycle rehearsal (test mode, on a throwaway workspace — never a demo workspace):
1. `npm run tenant:admin -- end-trial stagetest2 --yes`, then trigger the lifecycle cron
   (`curl -H "Authorization: Bearer <STAGING_CRON_SECRET>" https://staging.cadenzpoint.com/api/cron/tenant-lifecycle`).
   Expect the workspace read-only and a "trial has ended" email stating the deletion date.
2. Subscribe stagetest2 with card `4000 0000 0000 0341` (attaches, then fails on renewal): expect the "payment
   failed" email with a suspension date.
3. `npm run tenant:admin -- show stagetest2` lists every notice as SENT with a provider id, and no unresolved alerts
   except the ones you caused.
4. In the Stripe dashboard, cancel the subscription: expect read-only and the "subscription ended" email with a
   deletion date 90 days out.
5. ACH (Terms §4.3): in test mode, pay an invoice with a test bank account; while it is processing, the cron must not
   suspend. Note what statuses Stripe shows; record anything unexpected in feature-plan-terms-compliance-fixes.md §2.
6. Deletion dry run: `npm run tenant:delete -- stagetest2` (no `--yes`): it must report the classification and
   "Not eligible" until the deletion date has passed.
7. **Per-user billing** (`feature-plan-per-user-billing.md` §12), each on a throwaway workspace:
   - **Annual:** subscribe to Standard, annual, then add users above 5 → an immediate invoice. Deactivate and
     reactivate a user → no change and no invoice.
   - **Renewal window** (no test clock: it moves Stripe's time, not the app's):
     1. `npm run tenant:admin -- ensure-customer <slug> --stripe-mode test --yes`. In the Dashboard, attach test card
        4242 to that customer as its default payment method.
     2. In the Dashboard, create a Standard monthly subscription on that customer with a **billing cycle anchor about
        12 hours ahead**, so its period end falls inside the real next 24 h. Quantity = the live count (`show`).
     3. Deactivate a user → within 10 minutes the quantity drops with no proration. After the real renewal, the
        renewal invoice bills the lower count.
   - **ACH checkout:** choose the **Test Institution** in Financial Connections for instant verification (with manual
     entry, verify with the microdeposit amounts 32 and 45). Record the subscription status while the payment is
     processing. Use the failure account `000111111116` to see the "Payment not received" email.
   - **Promotion code:** `FOUNDING` at checkout.
   - **Send-invoice subscription,** made per the runbook above with `days_until_due: 1`: added users → the proration
     invoice is **emailed**; left unpaid → within about a day of the due date, the "Invoice overdue" email, and the
     Billing page's Pay button opens the overdue invoice; paid → the overdue state clears and the Payment tile
     returns to Active.
   - **Record these test-mode facts** in `feature-plan-per-user-billing.md` §15 and report them to Planning:
     - whether a quantity change inside the flat tier creates a $0 invoice;
     - whether a send-invoice proration invoice is draft or open right after the update;
     - whether an overdue `auto_advance: false` proration invoice moves the subscription to `past_due`;
     - whether quantity updates work on a `past_due` subscription;
     - the subscription status while an ACH payment is processing;
     - Checkout with quantity > 1;
     - a quantity update while a subscription schedule is attached;
     - a long seat-sync run (several Stripe calls in one locked section) isn't cut by Neon's pooler
       (idle-in-transaction timeout);
     - whether Stripe itself emails a send-invoice `subscription_update` invoice (record its `auto_advance`);
     - a failed card on the hosted page of a not-yet-due send-invoice invoice: the subscription status, and **whether
       `invoice.payment_failed` fires** (if it doesn't, tell Planning before launch);
     - a schedule with `end_behavior: 'renew'` and no next phase: does it freeze the quantity at renewal?

**12.9** Email: confirm the verification email arrived, and trigger a password reset to confirm it arrives too.

**12.10** CSP: open the browser DevTools console on several pages and look for CSP violation
reports. Note any for Phase 13.4.

**12.11** Sentry (after fix 1.5): visit a deliberately broken URL or trigger a test error and
confirm an event appears in Sentry tagged **`staging`**.

**12.12** Operations: the daily ops digest arrives (the "all quiet" version is fine) and lists no overdue
crons after a day; `npm run backfill:neon-retention -- --check` shows every staging tenant project at the
expected retention.

**12.13** Large downloads (`feature-plan-large-report-responses.md`, build queue 5b). This proves on Vercel
what a laptop can't: the cost CSV and `/api/v1/costs` get past Vercel's 4.5 MB response limit, the Excel shows its
25,000-row message, and a download cut off mid-way is never saved as a short file. About 1 hour, most of it waiting.
Do the steps in order. Report every result to Planning, including any surprise.

1. **A fresh throwaway workspace.** Sign up through the real flow as in 12.4, with a new name such as `stagebig`
   plus today's date (never `stagetest2`: after 12.8b it's suspended and data reads return 403; and never a
   workspace later steps use: time entries can't be deleted). Then, with staging's `CONTROL_PLANE_DATABASE_URL` in
   your shell as in Phase 1d:
```bash
npm run tenant:admin -- show <slug>
```
   ↑ expect the line `access mode now:            full`.

2. **Seed 40,800 cost rows in one year.** In Neon, open the project `cadenzpoint-<slug>` → **SQL Editor** →
   database `tenant_<slug>`, paste this and run it:
```sql
WITH c AS (
  INSERT INTO contracts (contract_number, name, start_date)
  VALUES ('STG5B-2026-LARGE-REPORT-RESPONSES-0001', 'Staging Large Report Responses Rehearsal Contract', current_date - 401)
  RETURNING id),
cl AS (
  INSERT INTO clins (contract_id, clin_number)
  SELECT c.id, '000' || g FROM c, generate_series(1, 6) g RETURNING id),
u AS (
  INSERT INTO users (email, full_name, role)
  SELECT 'stg5b-' || lpad(g::text, 2, '0') || '@example.com',
         'Staging Rehearsal Employee Number ' || lpad(g::text, 2, '0'), 'employee'
  FROM generate_series(1, 20) g RETURNING id)
INSERT INTO timesheet_entries (user_id, clin_id, entry_date, hours)
SELECT u.id, cl.id, current_date - 1 - d, '1.5' FROM u, cl, generate_series(0, 339) d;
```
   ↑ expect `INSERT 0 40800`. (Planning measured this data locally: a 7.1 MB CSV and a 19.5 MB API response.)
   The rows end yesterday by Neon's clock (UTC), so they all fall inside the helper's year at any hour of your day.

3. **An API key.** Sign in as that workspace's admin, open **Settings › API keys**, create a key (name
   `5b check`, Read Only), click **Copy key**, then in Terminal:
```bash
pbpaste > /tmp/stg5b-key
```

4. **The helper.** Paste this block once (from the first `cat` line to the closing `EOF`):
```bash
cat > /tmp/stg5b.sh <<'EOF'
#!/bin/bash
# Helper for PRODUCTION-DEPLOY step 12.13 (large report responses). Usage: bash /tmp/stg5b.sh <step>
set -uo pipefail
J=/tmp/stg5b-jar
S=$(date -v-365d +%F); E=$(date +%F)
base() { [ -s /tmp/stg5b-base ] || { echo "STOP: run: bash /tmp/stg5b.sh base <workspace URL>" >&2; exit 1; }; cat /tmp/stg5b-base; }
csv_url() { echo "$(base)/api/reports/cost-report-csv?startDate=$S&endDate=$E"; }
lastline() { python3 -I -c 'import sys; l=[x for x in open(sys.argv[1],encoding="utf-8-sig",errors="replace").read().split("\n") if x]; print(l[-1] if l else "(empty)")' "$1"; }
enc() { grep -i '^content-encoding:' "$1" | tr -d '\r' || echo "content-encoding: none"; }
case "${1:-}" in
  base)
    [ -n "${2:-}" ] || { echo "Usage: base https://<slug>.staging.cadenzpoint.com"; exit 1; }
    echo "${2%/}" > /tmp/stg5b-base && echo "Saved $(base)"
    ;;
  login)
    [ -n "${2:-}" ] || { echo "Usage: login <admin email>"; exit 1; }
    read -rsp "Password for $2: " PW; echo
    rm -f "$J"
    csrf=$(curl -sS -c "$J" -b "$J" "$(base)/api/auth/csrf" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["csrfToken"])') || exit 1
    curl -sS -o /dev/null -c "$J" -b "$J" --data-urlencode "csrfToken=$csrf" --data-urlencode "email=$2" \
      --data-urlencode "password=$PW" "$(base)/api/auth/callback/credentials"
    case "$(curl -sS -b "$J" "$(base)/api/auth/session")" in *"$2"*) echo "Signed in.";; *) echo "STOP: sign-in failed"; exit 1;; esac
    ;;
  fetch)
    [ -s /tmp/stg5b-key ] || { echo "STOP: save the API key first: pbpaste > /tmp/stg5b-key"; exit 1; }
    echo "CSV: $(curl -sS -b "$J" -D /tmp/stg5b-csv.h -o /tmp/stg5b.csv -w '%{http_code} %{size_download} bytes %{time_total}s' "$(csv_url)")"
    echo "  $(enc /tmp/stg5b-csv.h)"; echo "  last line: $(lastline /tmp/stg5b.csv)"
    wc -c < /tmp/stg5b.csv | tr -d ' ' > /tmp/stg5b-size
    echo "API: $(curl -sS -H "Authorization: Bearer $(tr -d '[:space:]' < /tmp/stg5b-key)" -D /tmp/stg5b-api.h -o /tmp/stg5b.json \
      -w '%{http_code} %{size_download} bytes %{time_total}s' "$(base)/api/v1/costs?startDate=$S&endDate=$E")"
    echo "  $(enc /tmp/stg5b-api.h)"
    python3 -I -c 'import json; d=json.load(open("/tmp/stg5b.json")); print("  meta.total:", d["meta"]["total"])' 2>/dev/null \
      || echo "  not JSON rows: $(head -c 200 /tmp/stg5b.json)"
    ;;
  excel)
    echo "Excel: $(curl -sS -b "$J" -o /tmp/stg5b.xlsx -w '%{http_code}' "$(base)/api/reports/cost-report-xlsx?startDate=$S&endDate=$E")"
    python3 -I -c 'import json; b=open("/tmp/stg5b.xlsx","rb").read(); print("  message:", json.loads(b)["error"]) if b[:1]==b"{" else print("  a spreadsheet file (no message)")'
    ;;
  slow)
    [ -s /tmp/stg5b-size ] || { echo "STOP: run fetch first"; exit 1; }
    FULL=$(cat /tmp/stg5b-size); RATE="${2:-4k}"
    echo "Downloading at $RATE (full size $FULL bytes). Started $(date -u +%H:%M:%S) UTC; this takes a while."
    curl -sS -b "$J" -D /tmp/stg5b-slow.h -o /tmp/stg5b-slow.csv --limit-rate "$RATE" "$(csv_url)"; CODE=$?
    GOT=$(wc -c < /tmp/stg5b-slow.csv | tr -d ' '); LAST=$(lastline /tmp/stg5b-slow.csv)
    echo "Finished $(date -u +%H:%M:%S) UTC. curl exit $CODE, $GOT of $FULL bytes. $(enc /tmp/stg5b-slow.h)"
    echo "Last line: $LAST"
    if [ "$CODE" != "0" ]; then echo "RESULT: cut off with an error (pass). Check the runtime logs for a timeout."
    elif [ "$GOT" = "$FULL" ] && [ "$LAST" = "$(lastline /tmp/stg5b.csv)" ]; then
      echo "RESULT: complete file. Check the runtime logs: no timeout means not exercised (rerun with: slow 1k)."
    else echo "RESULT: STOP. A short or changed file ended cleanly. Tell Planning before production."; fi
    ;;
  cleanup)
    rm -f /tmp/stg5b-* /tmp/stg5b.csv /tmp/stg5b.json /tmp/stg5b.xlsx /tmp/stg5b-slow.csv && echo "Removed the saved files."
    ;;
  *)
    echo "Usage: bash /tmp/stg5b.sh base <url>|login <email>|fetch|excel|slow [rate]|cleanup"; exit 1
    ;;
esac
EOF
```
   Then, with your workspace's address:
```bash
bash /tmp/stg5b.sh base https://<slug>.staging.cadenzpoint.com
```
```bash
bash /tmp/stg5b.sh login <admin email>
```
   ↑ type the password when asked; expect `Signed in.` The helper never asks for compression, so the sizes are
   real (browsers do get compressed files; this is the worst case).

5. **Baseline, before 5b (optional but wanted).** If **Actions → Deploy to Staging** lets you pick a tag under
   "Use workflow from", deploy `stable-2026-11-13-excel-cost-report`, wait for it, then:
```bash
bash /tmp/stg5b.sh fetch
```
   Write down the `CSV:` and `API:` status codes (`413` means the old code hit the limit; `200` means it didn't).
   Then redeploy `main` (12.1). If the tag can't be picked, skip this and say so.

6. **With 5b** (`main` deployed):
```bash
bash /tmp/stg5b.sh fetch
```
   ↑ expect `CSV: 200` with more than 4,500,000 bytes, `content-encoding: none`, and the last line
   `"Class shows the current Class of each charge code, including on past dates."`; then `API: 200` with more
   than 4,500,000 bytes, `content-encoding: none`, `meta.total: 40800`. Write down the CSV time.
```bash
bash /tmp/stg5b.sh excel
```
   ↑ expect `Excel: 422` and
   `message: More than 25,000 rows match. Choose a shorter date range, or download the CSV.`

7. **A download cut off at 300 s.** Note the start time it prints, then wait (about 30 minutes):
```bash
bash /tmp/stg5b.sh slow 4k
```
   Then open Vercel → the staging project → **Logs** **right away** (they're kept only briefly), filter on
   `/api/reports/cost-report-csv` around the start time, and note whether that request ended in a timeout.
   - `RESULT: cut off with an error (pass)`: good.
   - `RESULT: complete file`: also fine for the file. But if the logs show no timeout, the 300 s cut didn't
     happen: run `bash /tmp/stg5b.sh slow 1k` once. If it still doesn't time out, report "not exercised".
   - `RESULT: STOP`: a short or changed file ended cleanly. **Don't deploy production.** Tell Planning.

8. **Clean up.** Delete the workspace (with staging's `CONTROL_PLANE_DATABASE_URL`, `ENCRYPTION_KEY` and
   `NEON_API_KEY` in your shell):
```bash
npm run tenant:delete -- <slug> --yes --force-with-reason "5b staging rehearsal throwaway"
```
```bash
bash /tmp/stg5b.sh cleanup
```

**12.14** Shared rate limits (`feature-plan-upstash-rate-limiting.md`, build queue 6). About 15 minutes.

1. **Before deploying the release that contains it:** the new migration adds a rule that `login_attempts.ip_address` stays empty, and it fails if any row has a value. Nothing has ever written that column, but check each staging tenant in Neon (project `cadenzpoint-<slug>` → **SQL Editor** → database `tenant_<slug>`):
```sql
SELECT count(*) FROM login_attempts WHERE ip_address IS NOT NULL;
```
   ↑ expect `0` for every tenant. If not, stop and tell Planning.
2. **After the deploy,** on a staging workspace's sign-in page: sign in with a wrong password 3 times, then correctly once.
   ↑ expect "Invalid email or password." for the first two and "Invalid email or password. 2 attempts remaining before account lockout." for the third (the per-email lockout's countdown), then a normal sign-in.
3. **Upstash console** → `cadenzpoint-staging-ratelimit` → **Data Browser**.
   ↑ expect only keys like `cp-rl:signInFailure:<64 hex characters>:<number>`, each with a TTL under 30 minutes. **No IP address and no email anywhere.** Any other kind of key: stop and tell Planning.
4. **The config alert:** in the `cadenzpoint-staging` project, temporarily delete **every** token variable present (`KV_REST_API_TOKEN` and/or `UPSTASH_REDIS_REST_TOKEN`; the app reads either), redeploy (12.1), and **submit one sign-in** on a staging workspace (any password; just opening the page doesn't touch the limiter).
   ↑ expect the "rate-limit-config-missing" ops email within a few minutes, and sign-in still works.
   Put the variable back (Upstash console → the database → **REST API** → copy the token), redeploy, and wait for the next notice-delivery run (up to 10 minutes). The alert resolves, and the next daily ops digest no longer lists it.

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
the five jobs from `vercel.json` (daily-reminder, submission-deadline, tenant-lifecycle,
notice-delivery and seat-sync every 10 minutes). (Crons only run on production deployments; the 10-minute schedule
and the 800-second lifecycle/export duration need the **Pro** plan — staging too.)

**13.6** Run the smoke test against production:
```bash
./scripts/smoke-tenancy.sh https://cadenzpoint.com https://<first-workspace>.cadenzpoint.com <PROD_CRON_SECRET>
```

✅ **Check:** production is live with one real workspace.

---

## Phase 13b — Backups (AWS) (you + the lead; feature-plan-database-backups.md §12)

Daily encrypted backups of every workspace and the control plane, in a separate AWS account, with weekly automatic
restore tests. Everything runs in AWS us-east-1; nothing runs on your machine, and you never download a backup.
[`FOUNDER-ACCOUNTS-SETUP.md`](FOUNDER-ACCOUNTS-SETUP.md) Parts 4–6 have every click; this is the checklist, **in
this order**. Steps 6–11 are also the **staging rehearsal**, a production-readiness gate.

1. **AWS account** (FOUNDER-ACCOUNTS-SETUP Part 4): the *advanced* sign-up; two hardware keys on root; the **Paid**
   plan; a backup card; alternate contacts; your admin login (security key, no access keys).
2. **Neon** (Part 5): create `cadenzpoint-restore-tests` — **us-east-1, Postgres 16, history window 0** — and copy
   its **direct** connection string (no `-pooler`). The restore test refuses anything else.
3. **GitHub, before the bootstrap stack exists:** create the environment `aws-backups` (Selected branches → `main`;
   required reviewer → you; "Prevent self-review" **off**; "Allow administrators to bypass" **off**), add the
   environment secret `BACKUP_ALERT_EMAIL`, and send the lead the output of:
   - `curl -s https://api.github.com/repos/ccentofo/bytime/environments/aws-backups` (a `required_reviewers` rule
     naming you, `"can_admins_bypass": false`, `"custom_branch_policies": true`);
   - `curl -s https://api.github.com/repos/ccentofo/bytime/environments/aws-backups/deployment-branch-policies`
     (exactly one policy: `main`, type `branch`).

   **3b may merge only after this check.** With `AWS_BACKUPS_ENABLED` unset, the deploy workflow does nothing.
4. **Bootstrap stack:** AWS console (your admin login, us-east-1) → CloudFormation → Create stack → upload
   `ops/aws/bootstrap.yml` → acknowledge IAM → Submit. Copy its four outputs into `aws-backups` **environment
   secrets**: `AWS_DEPLOY_ROLE_ARN`, `AWS_CFN_EXEC_ROLE_ARN`, `AWS_BACKUP_REPOSITORY_URI`, `AWS_ARTIFACTS_BUCKET`.
5. **Deploy the app with this item's migration** (`0011_database_backups`) to staging and production (Phases 12.1
   and 13.1). The backup tasks refuse to run against a control plane without their tables.
6. **SSM parameters, staging values first** (AWS console → Systems Manager → Parameter Store, type
   **SecureString**, from your password manager — Vercel doesn't reveal sensitive values):
   `/cadenzpoint/backup/control-plane-url` = **staging's** `CONTROL_PLANE_DATABASE_URL`;
   `/cadenzpoint/backup/encryption-key` = **staging's** `ENCRYPTION_KEY`;
   `/cadenzpoint/backup/restore-test-url` = the Neon string from step 2.
7. **First deploy:** set the repository variable `AWS_BACKUPS_ENABLED` = `true`, then Actions → "Backup system
   deploy" → Run workflow → **Review deployments → Approve and deploy**. Both jobs green.
8. **Confirm the alert email** from AWS within 48 hours (missed it: SNS → the subscription → Request confirmation).
9. **First runs, against staging** (ECS → cluster `cadenzpoint-backup` → Run new task; the lead gives the clicks):
   `backup`, then `audit`; **wait at least 30 minutes after the backup task stops**, then `restore-test`. Expect in
   staging's control plane: `ok` rows with `region = us-east-1`; an audit row with `Enabled`,
   `alert_email_confirmed = true`, `protection_drift` and `errors` empty; a `pass` restore-test run; three
   `backup_permission_checks` rows with `ok = true`. Set staging's `BACKUPS_EXPECTED=1` for a day, check the digest's
   Backups section, then set it back to `0`. The next day, check the 18:17 catch-up's log shows `--if-missing-today`, and,
   if the hand-run restore test happened since Monday 00:00 UTC, that the next 08:17 restore-test catch-up exits at once
   ("a completed restore test ran since Monday").
10. **"Can't" checks** (Tuesday–Sunday, 15:00–17:00 UTC, no job runs then), in AWS CloudShell, commands from the lead:
    `head-object` on a backup → 403 (HeadObject transfers no data, so nothing is downloaded even if the deny were
    missing); `kms decrypt` of the stored data key → AccessDeniedException;
    `schedule-key-deletion --pending-window-in-days 7` → AccessDeniedException (if it ever succeeds:
    `cancel-key-deletion`, then `enable-key`, and stop); `disable-key` then `enable-key` at once → an immediate alert
    email; `put-bucket-versioning … Enabled` → AccessDenied and an immediate email (CloudTrail records denied calls too; if no
    email arrives, the lead investigates before go-live); `set-alarm-state` on
    `cadenzpoint-backup-dlq` → an alarm email.
11. **Switch to production** (15:00–17:00 UTC, when no task runs, so none starts between the two edits): replace the
    first two SSM parameters with **production's** values. The next scheduled runs back up production into its own
    `<cp>` prefix. Staging's rehearsal backups expire on their own.
12. **Vercel:** once production's first `backup` and `audit` tasks have stopped with exit code 0 (ECS console) and
    the backup log shows a `BACKUP … control-plane …` line, set production `BACKUPS_EXPECTED=1` and redeploy. The alerts'
    anchors (no missed-run or stale alert before the first control-plane backup) prevent a go-live burst of alerts.

**Runbook**

- **`ENCRYPTION_KEY` or the control-plane URL (or password) changes:** update the matching SSM parameter (step 6 names) as
  part of the same change. The restore-test URL too, if that project's URL (or password) changes. Forgetting it alerts at the
  next backup (`backup-failed` / `backup-missed-run`).
- **A backup-system deploy that comes with a backup-table migration:** approve it in GitHub **only after**
  `deploy-prod` has applied the migration.
- **`deploy-prod` waits "for the backup run to finish" and then refuses:** a backup was running and the deploy has
  migrations. Nothing was changed; re-run `deploy-prod` later (backups run at 06:17 and 18:17 UTC). App-only deploys
  never wait.
- **Bootstrap changes** (rare) are applied in the console, with the lead: CloudFormation → `cadenzpoint-backup-bootstrap`
  → Update → upload the new `ops/aws/bootstrap.yml`. The deploy workflow never touches it.
- **Deploy stopped with "The first create failed and rolled back":** CloudFormation → delete the stack
  `cadenzpoint-backup` (it holds nothing), then re-run the workflow.
- **Re-create the backup stack** (the bucket and key were retained from a deleted stack): don't create a new one.
  With the lead, import the retained bucket and key into a new `cadenzpoint-backup` stack with a CloudFormation
  import change set, then re-run the workflow.
- **Stack stuck in ROLLBACK_FAILED:** CloudFormation → the stack → Events: find the resource that failed to roll
  back; with the lead, fix it (or "Continue update rollback" skipping it), then re-run the workflow.
- **Stack stuck in DELETE_FAILED:** stop and contact the lead; the bucket and key are retained by design and must not
  be removed by hand.
- **The approval request expired** (artifacts are kept 7 days): Actions → "Backup system deploy" → Run workflow on
  `main` (not "Re-run"). A rejected deploy is asked again on the next push that touches the backup code.

**When the digest shows a backup alert**

| Alert | What to do |
|---|---|
| `backup-missed-run`, `backup-failed`, `backup-stale` | A workspace or the control plane wasn't backed up. The 18:17 catch-up retries failures; if it persists, send the lead the alert detail (stage and label only, never data). |
| `backup-key-state`, `backup-protection-drift`, `backup-bucket-drift`, `backup-alert-email` | A protection changed. If you didn't change it, treat it as an incident; tell the lead at once. |
| `restore-test-failed`, `restore-test-missed`, `restore-test-coverage` | A backup didn't restore, or the weekly test isn't running. Send the lead the detail. |
| `backup-run-slow`, `restore-test-slow`, `backup-target-slow` | Growth: the lead changes the concurrency, deadline or task size value in `ops/aws/backup-stack.yml`; it applies on the next backup-system deploy you approve. |
| `backup-permission-drift` | A role can do something it must not. Treat as an incident; tell the lead. |
| `backup-old-objects` | See RESTORE.md, "Backups beyond Neon". |
| `restore-test-leftover`, `backup-audit-missed`, `backup-audit-error`, `backup-region`, `backup-check-failed` | Send the lead the detail. |

---

## Phase 13c — The Disaster restore button (you + the lead; feature-plan-disaster-restore.md §12)

A founder-only button that rebuilds a lost workspace from its newest verified backup into a new Neon project
(RESTORE.md runbook A). Do this after Phase 13b is live. Every click is in
[`FOUNDER-ACCOUNTS-SETUP.md`](FOUNDER-ACCOUNTS-SETUP.md) Part 6b; this is the checklist, **in this order**.

0. **Check two things first:**
   - this repository was created before **15 July 2026** and hasn't been renamed or transferred since (GitHub then
     uses the subject format both backup roles trust). If it was, stop and tell the lead;
   - whether Neon → **Organization → Members → Invite** offers the **Viewer** role. If it doesn't (an organisation
     still on Neon's older roles), step 2 invites `neon-ops@` as **Member** for now (Q-D1, decided 2026-11-17): write
     the date in the setup notes, and lower it to Viewer as soon as Neon offers that role.
1. **GitHub:** create the environment `aws-disaster` (Selected branches → `main`; required reviewer → you; "Prevent
   self-review" **off**; "Allow administrators to bypass" **off**). Send the lead the output of
   `curl -s https://api.github.com/repos/ccentofo/bytime/environments/aws-disaster` and
   `curl -s https://api.github.com/repos/ccentofo/bytime/environments/aws-disaster/deployment-branch-policies`
   (as for `aws-backups`).
2. **Neon (Q1):** add the alias `neon-ops@cadenzpoint.com`; invite it to the organisation as **Viewer** (or **Member**
   if Viewer isn't offered: step 0); sign in once as it (security key) and create its **personal** API key (Account
   settings → API keys). Note the organisation id (Organization settings → General).
3. **AWS Parameter Store** (SecureString each): `/cadenzpoint/backup/neon-api-key` (the step 2 key),
   `/cadenzpoint/backup/neon-org-id`, `/cadenzpoint/backup/restore-test-project-id` (the `cadenzpoint-restore-tests`
   project's id) and `/cadenzpoint/backup/control-plane-project-id` (production's control-plane project id).
   **Vercel production:** `CONTROL_PLANE_PROJECT_ID`, and make sure `NEON_API_KEY` is an **Organization** key (5.5).
4. **The early push** (the lead asks for it when the CI commit exists), then merge; run Deploy to Production; approve
   the pending **Backup system deploy**. Copy the stack output `DisasterButtonRoleArn` (CloudFormation →
   `cadenzpoint-backup` → Outputs) into the `aws-disaster` environment secret `AWS_DISASTER_ROLE_ARN`.
5. **A `rehearsal` workspace in production** (before launch there may be none with backups):
   `npm run provision:tenant` a workspace with the slug `rehearsal`, then
   `npm run tenant:admin -- set-exempt rehearsal on --reason "disaster rehearsal target" --yes`, and wait for its first `ok` backup (the next 06:17 UTC run).
   It stays as the rehearsals' target.
6. **Canary, then rehearse, the same day:** with **your own** Neon login, create a project named
   `cadenzpoint-recoverable-canary` and delete it. Then Actions → **Disaster restore** → mode `rehearse`, targets =
   the `rehearsal` workspace's id, override `canary`, confirm `rehearse` → approve.
   - **Expect:** the start email (from AWS); "Disaster rehearsal passed" (the proof against the live original, the
     canary seen, the copy deleted and visible as recoverable); no change to the workspace.
   - **If the canary isn't seen:** in Neon, switch `neon-ops@` to **Editor** and rehearse again (Q1's fallback); tell
     the lead.
7. **From then on** the monthly schedule (the 1st, 15:17 UTC) rehearses automatically; a failure appears in the
   digest as `disaster-rehearse-failed`.

**When the digest shows a disaster alert**

| Alert | What to do |
|---|---|
| `rebuild-original-watch` | Informational: a rebuilt workspace's original is being watched (at least 30 days). Closes by itself. |
| `rebuild-original-returned` | The original exists again. Don't open it: RESTORE.md A.6 (ask the customer, then delete it in the Neon console). |
| `rebuild-original-recoverable` | The original can still be recovered in Neon until the date shown. Recovering it won't switch the workspace back. Tell the lead. |
| `rebuild-orphan-project` | A project the button created wasn't cleaned up: delete it in the Neon console (the alert names it). Resolves after the 404. |
| `workspace-needs-deploy` | Run Deploy to Production (normal) now. |
| `disaster-run-stuck` | A disaster task ran past its deadline; it was closed as abandoned. Check RESTORE.md A.11; tell the lead. |
| `disaster-rehearse-failed` | The rehearsal failed, or none passed in 40 days: tell the lead (the key or the pipeline may not work). |
| `rebuild-watch-check-failed` | A Neon check failed, or the app's key can't see the organisation: check 5.5 and `CONTROL_PLANE_PROJECT_ID`; otherwise it retries tomorrow. |

`tenant:admin resolve-alert` refuses the `rebuild-*` and `disaster-*` kinds: they close on the facts.

---

## Phase 14 — Operating it (ongoing)

**Every future release**
1. Merge to `main` via PR (CI green, including `db:safety`).
2. Deploy to **staging** (Phase 12.1) and spot-check.
3. Deploy to **production** (Phase 13.1) and approve.

**Rollback (code):** Vercel → production project → **Deployments** → pick the last good one →
**Instant Rollback**. Because migrations are backward-compatible (expand/contract), the older code
keeps working against the newer schema. After an Instant Rollback, Vercel stops promoting new production
deployments to your domains automatically — once the fix is deployed, **promote that deployment manually**
(Deployments → the new deployment → Promote).

**Rollback (database): fix forward only.** Never run down-migrations, never re-run a broken migration,
never rewind a tenant database to undo one: write a corrective migration and deploy it. Lost or damaged
customer data is restored into a copy and re-entered through the app — [`RESTORE.md`](RESTORE.md).

**A single tenant failed to migrate:** the deploy stops before the new code goes live. Fix the
cause, then re-run just that tenant locally with the production values in your shell:
`npm run db:migrate:all -- --tenant <slug>`, then re-run the deploy.

**Daily:** the ops digest arrives. **No digest by 15:00 UTC → the lifecycle cron is down; investigate.**
Its **Backups** section shows how many workspaces were backed up in the last 26 h, the newest control-plane backup
and the last weekly restore test; backup problems appear under "Unresolved alerts" (`backup-*`, `restore-test-*`).
What each one means and what to do: Phase 13b, "When the digest shows a backup alert".

**Monthly:** confirm Sentry and email are still delivering. **Yearly:** rotate `VERCEL_TOKEN` before
it expires.

### Release notes

**Approval scope (`0018_approval_scopes`, feature-plan-approval-scope.md): FIX-FORWARD ONLY.** Do **not** use
Instant Rollback for this release or to any deployment before it: the old code reads approval scope from CLIN
assignments only, so rolling back would re-grant removed scopes and drop new ones.
1. Write `MIGRATE_START` down (UTC) just before the deploy workflow starts:
   `export MIGRATE_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"`.
2. Run the deploy workflow (it migrates every tenant, then deploys, back to back). Make **no** admin edits to
   assignments, users or charge-code access until the new deployment is live.
3. When it's live, run the report-only window check with the production values in your shell:
   `npm run scopes:window-check -- --since "$MIGRATE_START"`. It writes nothing.
4. For anything it lists that should change, grant or remove the scope by hand on Assignments → Approval scope.
   On the demo and design-partner workspaces the list is expected to be empty or tiny.

Each workspace's admins then see a one-time "approval scopes to review" item on Home until they keep or remove the
converted scopes.

---

## Phase 15 — Before charging real customers (not deploy blockers, but launch blockers)

| Item | Why |
|---|---|
| ~~**Distributed rate limiting**~~ | **Done** (PR #31, 2026-11-15): sign-up and sign-in limits are shared through Upstash (Phase 8b creates the databases; staging step 12.14 checks them). Reports, API, export and cron stay per-instance by decision. |
| **Backups beyond Neon** (BUSINESS-DECISIONS.md §5) | Built (item 3b): daily encrypted backups in AWS us-east-1 with weekly automatic restore tests. Switched on in Phase 13b, before the first paying customer. Rebuilding a lost workspace from them is item 3c (also required before the first paying customer). Retention: decided in BUSINESS-DECISIONS.md §5 (no new period; customers' DCAA retention is theirs, Terms §5.4). |
| **Your own security posture** (NIST 800-171 / CMMC answer, SOC 2 roadmap) | Usually the deciding question from defense-contractor buyers. Also decide whether you'll store CUI; if so, commercial-region hosting may not be acceptable. |
| **Terms of Service, Privacy Policy, DPA** reviewed by a lawyer | Required to sell. |
| **Trademark clearance** for "CadenzPoint" | Before marketing spend. |
| **QuickBooks / Gusto production approval** | Intuit and Gusto review apps before issuing production keys; test against their sandboxes first. |
| ~~**Excel cost report** shows charge codes and Class~~ | **Done** (PR #29, 2026-11-13): the detailed cost report (Excel, CSV and `/api/v1/costs`) has Charge Code and Class. The PDF shows the charge code but not Class. |
