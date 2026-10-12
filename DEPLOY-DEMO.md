# CadenzPoint — Vercel + Neon Demo Setup (detailed, step-by-step)

A complete, click-by-click guide to put the multi-tenant demo live at **cadenzpoint.com** on free
tiers. Tenants will live at `acme.cadenzpoint.com`, `globex.cadenzpoint.com`, etc.

**Time:** ~60–90 min (most of it waiting on DNS). **Cost:** $0 to demo (domain already bought).

> **Do Part 0 first.** Validate everything locally with `npm run demo:local` (see
> `feature-plan-local-demo-env.md` / `LOCAL-MULTITENANT-TESTING.md`). If the local demo works, the
> only new variables in the cloud are *connection strings* and *DNS* — which this guide walks you
> through. Don't debug the app for the first time in the cloud.

---

## What you'll create (accounts)
- **Neon** (neon.tech) — Postgres. Free.
- **Vercel** (vercel.com) — hosting. Free Hobby for a private demo (see caveat at the end).
- **Resend** (resend.com) — email. Free.
- **GitHub** — the repo must be pushed somewhere Vercel can import it.
- Your **domain registrar** — wherever you bought `cadenzpoint.com`.

Keep a scratchpad open. You'll collect: 4 Neon connection strings, 3 generated secrets, 1 Resend API
key. Treat all of them as passwords.

---

## Part 1 — Neon (database)

### 1.1 Create the project
1. Sign in at **neon.tech** → **New Project**.
2. Name: `cadenzpoint-demo`. Postgres version: 16+. **Region:** pick one near your Vercel region
   (e.g. AWS `us-east-1`) to minimize latency. Create.

### 1.2 Create the databases
You need **one control-plane DB + one DB per demo tenant**. Easiest via the SQL editor:
1. Left sidebar → **SQL Editor**.
2. Run:
   ```sql
   CREATE DATABASE cadenzpoint_control;
   CREATE DATABASE tenant_acme;
   CREATE DATABASE tenant_globex;
   CREATE DATABASE tenant_initech;
   ```
   (Or use **Branches → your branch → Databases → New Database** four times.)

### 1.3 Grab the POOLED connection strings (one per database)
Serverless functions open many short-lived connections, so you want the **pooled** endpoint.
1. Left sidebar → **Dashboard** (or **Connect**).
2. In the connection widget: set **Database** = `cadenzpoint_control`, and toggle **Connection
   pooling = ON** (the host will contain **`-pooler`**).
3. Copy the full string. It looks like:
   ```
   postgresql://<role>:<password>@ep-xxxx-pooler.us-east-1.aws.neon.tech/cadenzpoint_control?sslmode=require
   ```
4. Repeat, switching the **Database** dropdown to `tenant_acme`, `tenant_globex`, `tenant_initech`,
   copying each pooled string.

> If the password isn't shown, click **Reset password** (or "Show password") in the Roles section
> and copy it. The same role/password works across all databases in the project — only the database
> name at the end of the URL changes.

You now have 4 strings. Label them control / acme / globex / initech.

---

## Part 2 — Generate the three secrets (on your machine)

```bash
openssl rand -base64 32     # → AUTH_SECRET
openssl rand -hex 32        # → ENCRYPTION_KEY   (write this down — used in TWO places)
openssl rand -hex 16        # → CRON_SECRET
```

> ⚠️ **ENCRYPTION_KEY is the #1 thing people get wrong.** You will use the SAME value when you seed
> the tenants (Part 3) AND in Vercel (Part 6). `seed:demo` encrypts each tenant's DB URL with it; the
> live app decrypts with it. If the two differ, every tenant returns a decrypt error. Use one value.

---

## Part 3 — Seed the Neon tenants (from your machine, before deploying)

You'll run the same seed command you used locally, but pointed at Neon.

1. In the repo, create/edit `.env` with the **Neon control string** and the **same secrets**:
   ```bash
   CONTROL_PLANE_DATABASE_URL='postgresql://...-pooler.../cadenzpoint_control?sslmode=require'
   ENCRYPTION_KEY='<the hex key from Part 2>'
   APP_ROOT_DOMAIN='cadenzpoint.com'
   ```
2. Apply the control-plane schema to Neon:
   ```bash
   npm run db:migrate:cp
   ```
3. Seed each tenant (migrates the tenant DB → loads 6 months of GovCon data → registers it active):
   ```bash
   npm run seed:demo acme    '<neon tenant_acme pooled url>'    'Acme Defense'
   npm run seed:demo globex  '<neon tenant_globex pooled url>'  'Globex Systems'
   npm run seed:demo initech '<neon tenant_initech pooled url>' 'Initech Federal'
   ```

Each prints `✓ Demo tenant "..." is ACTIVE and populated`. Logins (same on every tenant):
`admin@cadenzpoint.dev` / `Password123!` (plus supervisor/employee accounts).

> This step talks to Neon directly from your laptop — no deploy needed yet. If a command hangs, your
> Neon compute may be cold; re-run it.

---

## Part 4 — Resend (email)

> Decide DNS first: in Part 7 you'll likely move DNS to Vercel. If so, you'll add these Resend
> records **in Vercel's DNS** (Part 7.4). You can do Resend now and add the records after nameservers
> switch — verification just completes once the records propagate.

1. Sign in at **resend.com** → **Domains → Add Domain** → `cadenzpoint.com`.
2. Resend shows DNS records (an SPF `TXT`, DKIM `TXT`/`CNAME`, optionally a return-path `MX/TXT`).
   Keep this tab open; you'll add these where your DNS lives (Part 7.4).
3. **API Keys → Create API Key** → copy `re_...` (this is `RESEND_API_KEY`).
4. `EMAIL_FROM` will be `CadenzPoint <noreply@cadenzpoint.dev>` (must be on the verified domain).

---

## Part 5 — Push the repo to GitHub

If it isn't already on GitHub:
```bash
git add -A && git commit -m "CadenzPoint demo ready"
git push    # to your GitHub remote
```
Vercel imports from GitHub in the next part.

---

## Part 6 — Vercel (hosting + env)

### 6.1 Import
1. Sign in at **vercel.com** → **Add New… → Project** → import your GitHub repo.
2. Framework Preset: **Next.js** (auto-detected). Leave build/output defaults. **Don't deploy yet** —
   add env vars first (or deploy, then add env and redeploy; either works).

### 6.2 Environment variables
Project → **Settings → Environment Variables**. Add each below, scope **Production** (also tick
Preview if you want preview deploys to work). Paste the Neon **pooled** URLs and your Part 2 secrets.

| Name | Value |
|---|---|
| `CONTROL_PLANE_DATABASE_URL` | Neon pooled URL for `cadenzpoint_control` |
| `ENCRYPTION_KEY` | the **same** hex key you seeded with (Part 2) |
| `AUTH_SECRET` | the base64 secret (Part 2) |
| `NEXT_PUBLIC_APP_URL` | `https://cadenzpoint.com` |
| `APP_ROOT_DOMAIN` | `cadenzpoint.com` |
| `NEXT_PUBLIC_APP_ROOT_DOMAIN` | `cadenzpoint.com` |
| `CRON_SECRET` | the hex secret (Part 2) |
| `RESEND_API_KEY` | `re_...` (Part 4) |
| `EMAIL_FROM` | `CadenzPoint <noreply@cadenzpoint.dev>` |
| `CSP_MODE` | `report-only` (flip to `enforce` later) |
| `NEON_API_KEY` | **leave unset** (no auto-provisioning for the demo) |

> Optional: `STRIPE_*` (Part 10), `NEXT_PUBLIC_SENTRY_DSN`.

### 6.3 First deploy
Click **Deploy**. The build should succeed (the app reads DB/Stripe lazily, so missing optional
config won't break the build). You'll get a `https://<project>.vercel.app` URL. The **apex/marketing**
page works there; **tenant subdomains will NOT** (vercel.app can't do your wildcard) — that's
expected. Tenants come alive once your domain + wildcard are attached (Part 7).

---

## Part 7 — Domain & DNS (the wildcard is the key step)

Tenants need `*.cadenzpoint.com` with valid SSL. The lowest-friction way to get an automatic wildcard
certificate is to let **Vercel manage your DNS** (delegate nameservers).

### 7.1 Add the domains in Vercel
Project → **Settings → Domains** → add all three:
- `cadenzpoint.com`
- `www.cadenzpoint.com`
- `*.cadenzpoint.com`  ← the wildcard (covers every tenant subdomain)

### 7.2 Point your registrar's nameservers at Vercel
1. When you add `cadenzpoint.com`, Vercel offers **"Use Vercel DNS"** and shows nameservers like
   `ns1.vercel-dns.com` / `ns2.vercel-dns.com`.
2. At your **registrar** (where you bought the domain), find **Nameservers** (sometimes "DNS" →
   "Custom nameservers"). Replace the existing nameservers with the two Vercel gives you. Save.
3. Propagation takes minutes to a few hours. Vercel's Domains page shows ✅ when each is valid and the
   wildcard cert is issued.

> **Alternative (keep DNS at your registrar):** add a `CNAME` for `www` and for `*` pointing to
> `cname.vercel-dns.com`, an `A`/`ALIAS` for the apex per Vercel's instructions, and complete the TXT
> challenge Vercel shows for the wildcard cert. This works but is fiddlier; nameserver delegation is
> the no-thinking option and makes Part 7.4 trivial.

### 7.3 (apex routing) Confirm www → apex (or apex → www)
In Vercel's Domains UI, set the redirect you prefer (commonly `www.cadenzpoint.com` →
`cadenzpoint.com`). Either is fine; just be consistent.

### 7.4 Add the Resend DNS records
Now that DNS is on Vercel: Vercel **Domains → cadenzpoint.com → manage DNS records** (or the Vercel
account-level Domains dashboard). Add the SPF/DKIM (and return-path) records Resend gave you in
Part 4. Back in Resend, the domain flips to **Verified** once they propagate.

---

## Part 8 — Verify production

1. Open **https://cadenzpoint.com** → rebranded marketing page + logo (apex, no tenant).
2. Open **https://acme.cadenzpoint.com** → log in `admin@cadenzpoint.dev` / `Password123!` → populated
   workspace. Then **https://globex.cadenzpoint.com** → different data (isolation proven live).
3. Run the smoke script against production:
   ```bash
   ./scripts/smoke-tenancy.sh https://cadenzpoint.com https://acme.cadenzpoint.com "<your CRON_SECRET>"
   ```
   Expect all checks green (health, apex/tenant routing, forged-header equivalence, cron auth).
4. **Crons:** Vercel → Project → **Cron** shows the two jobs from `vercel.json`. Vercel authenticates
   them by sending `Authorization: Bearer <CRON_SECRET>`; the routes already accept that. (Hobby runs
   crons about once/day — fine for these reminders.)

---

## Part 9 — Harden: flip CSP to enforce

1. With the site up, open a few pages and check the **browser console** for CSP violation reports
   (CSP is in `report-only`, so it logs without breaking anything).
2. If clean, set `CSP_MODE=enforce` in Vercel env → **redeploy**. Re-check the console.

---

## Part 10 — Stripe (optional — only to demo billing)

1. Stripe Dashboard in **Test mode** → copy `sk_test_...`, `pk_test_...`; create your products/prices
   and copy the `price_...` IDs.
2. Add `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_PRICE_*` to Vercel.
3. **Webhook:** Stripe → Developers → Webhooks → add endpoint
   `https://cadenzpoint.com/api/stripe/webhook`; copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
4. Redeploy. Demo checkout uses Stripe's hosted pages (test cards like `4242 4242 4242 4242`).

Leave all Stripe vars unset to demo only the core app.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Tenant page 500s, logs show decrypt error | `ENCRYPTION_KEY` in Vercel ≠ the one used to seed | set them identical; re-seed if unsure (Part 3) |
| `acme.cadenzpoint.com` = "domain not found"/no SSL | wildcard not added or DNS not propagated | add `*.cadenzpoint.com` in Vercel; wait for ✅; confirm nameservers switched |
| Apex works, tenants don't | only apex domain added, not the wildcard | add `*.cadenzpoint.com` (Part 7.1) |
| "No workspace selected" on a tenant URL | tenant not registered/active in control plane | re-run `npm run seed:demo <slug> <url> <name>` |
| Emails not arriving | Resend domain not verified / records missing | complete Part 7.4; confirm "Verified" in Resend |
| Build fails on Vercel | a required env missing or a type error | check the build log; ensure Part 6.2 vars set; `npm run build` locally first |
| Cron returns 401 | `CRON_SECRET` mismatch | ensure the same value in Vercel; Vercel sends it as Bearer automatically |
| DB connection errors under load | using the non-pooled Neon host | use the **`-pooler`** connection strings everywhere |

---

## Cost & free-tier caveats
- **Vercel Hobby is non-commercial.** A private/internal demo is fine; a public sales motion needs
  **Pro (~$20/mo)** per Vercel's terms.
- **Neon free** auto-suspends idle compute (first request after idle is slow — a cold start) and caps
  storage/projects. Fine for a demo; production wants a paid plan.
- **Email** only delivers once the Resend domain is **Verified**.

## From demo → sellable (separate track, not blockers here)
Distributed rate limiting (Upstash) · backups + retention (DCAA ~3yr) · your own NIST 800-171 / CMMC
posture for defense buyers · live Stripe + tax/dunning · per-tenant migration rollout · E2E tests +
uptime monitoring. These are the gaps before charging real money.
