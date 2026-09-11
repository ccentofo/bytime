# Blueprint: Production Config Hardening — Security Headers, Sentry Sampling & Env Template

> **This ticket contains THREE phases (A, B, C). They are independent and may be done in any order, but complete all three.**
> **Tier 1 — BLOCKING for production launch.** Low-risk, high-value config changes. No business logic is touched.

## 1. Architectural Overview & DCAA Impact

### The Problem

Three production-readiness gaps in configuration:

**Gap A — No HTTP security headers.** `next.config.ts` is bare (`output: 'standalone'` only). The app ships no `Content-Security-Policy`, `Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options`, or `Referrer-Policy`. For a security-sensitive GovCon product, clickjacking/MIME-sniffing/missing-HSTS are basic findings any customer security review (or a SOC 2 pre-assessment) will flag.

**Gap B — Sentry trace sampling at 100%.** All three Sentry configs (`sentry.server.config.ts`, `sentry.client.config.ts`, `sentry.edge.config.ts`) set `tracesSampleRate: 1`. At production traffic this is expensive and noisy. It should be env-driven and default low in production.

**Gap C — No `.env.example`.** `src/db/index.ts:9` literally tells users to "See .env.example for required environment variables," but the file does not exist. New deployments and the upcoming self-service control plane have no canonical list of required configuration.

### Why this matters for sales

These are the cheapest credibility wins before a customer security questionnaire. Missing security headers and an absent env contract make the app look unfinished even though the core is strong.

### Design Decisions

1. **Headers via Next's `headers()`** in `next.config.ts` — applies to all routes at the framework level, no middleware cost.
2. **CSP starts in Report-Only**, then is promoted to enforcing after verifying Mantine renders. Mantine injects inline styles, so `style-src` must allow `'unsafe-inline'`. Sentry needs its ingest host in `connect-src`.
3. **Sentry sampling reads an env var** with a safe production default (`0.1`), overridable per environment.
4. **`.env.example` is documentation + contract** — it lists every variable the code reads (`grep process.env`), grouped, with comments and dummy-safe placeholders. It contains NO real secrets.

---

## 2. File Topology

```
Files to MODIFY:
├── next.config.ts                  ← Add async headers() with security headers + CSP
├── sentry.server.config.ts         ← tracesSampleRate from env
├── sentry.client.config.ts         ← tracesSampleRate from env
├── sentry.edge.config.ts           ← tracesSampleRate from env

Files to CREATE:
├── .env.example                    ← Canonical list of all env vars (no secrets)

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/**                          ← ❌ DO NOT MODIFY (this is a config-only blueprint)
├── src/middleware.ts               ← ❌ DO NOT MODIFY
├── Dockerfile / docker-compose*    ← ❌ DO NOT MODIFY (handled in deploy blueprint)
├── Caddyfile                       ← ❌ DO NOT MODIFY (Caddy adds its own HTTPS; app headers are additive)
```

> **CSP + Caddy note:** the prod stack fronts the app with Caddy (`Caddyfile`), which already provides automatic HTTPS. The app-level HSTS header is still correct and harmless behind Caddy. Do not move headers into Caddy — keeping them in `next.config.ts` means they apply on Vercel and Docker identically.

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS:**
> - **DO NOT** search inside `node_modules/`, `.next/`, or `dist/`.
> - This blueprint modifies **only** config files. Do not touch anything under `src/`.
> - The `.env.example` must contain **placeholders only** — never copy a real secret into it.
> - **After Phase A, run `npm run build` AND start the app to confirm Mantine still renders** (CSP can silently break inline styles).

---

## Phase A: Security Headers in `next.config.ts`

**A1.** Replace the entire contents of `next.config.ts` with:

```typescript
import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// Content-Security-Policy.
// - Mantine injects inline <style> tags, so style-src must allow 'unsafe-inline'.
// - Next.js requires 'unsafe-inline' (and 'unsafe-eval' in dev) for its runtime/scripts.
// - Sentry ingest must be reachable from the browser via connect-src.
//   Replace the *.ingest.sentry.io host below with your project's ingest host if different.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.ingest.sentry.io https://*.ingest.us.sentry.io",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  // Start CSP in REPORT-ONLY. After verifying the app renders with no console CSP
  // violations, rename this header to "Content-Security-Policy" to enforce.
  { key: "Content-Security-Policy-Report-Only", value: csp },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
```

**A2.** Build and run, then verify headers and that the UI is intact:

```bash
npm run build
npm run start    # or npm run dev
# in another shell:
curl -sI http://localhost:3000/login | grep -iE "content-security|strict-transport|x-frame|x-content|referrer|permissions"
```

**A3.** Open the app in a browser. Log in, load the timesheet grid and an admin page. Open DevTools console and confirm there are **no CSP violation messages** and Mantine styles render correctly (dark/light mode, tables, modals). The PDF/Excel report downloads and the MFA QR image must also work (covered by `img-src data: blob:`).

**A4.** Promote CSP to enforcing **only after A3 is clean**: change the header key `"Content-Security-Policy-Report-Only"` → `"Content-Security-Policy"`. Rebuild and re-verify A3.

> If any third-party origin is required at runtime (e.g., a Sentry ingest host that differs from the wildcards, or Stripe later), add it to the relevant CSP directive rather than weakening to `*`. The billing blueprint will extend `script-src`/`frame-src`/`connect-src` for Stripe — that is expected.

### Phase A Verification

| Check | Expected Result |
|---|---|
| `curl -I` on any route | All six headers present |
| App renders (timesheet, admin, modals) | No visual regressions, no CSP console errors |
| MFA QR code displays | OK (`img-src data:`) |
| Report PDF/XLSX download | OK |
| Clickjacking test (iframe the app) | Blocked by `X-Frame-Options: DENY` / `frame-ancestors 'none'` |

---

## Phase B: Env-Driven Sentry Sampling

**B1.** In **each** of `sentry.server.config.ts`, `sentry.client.config.ts`, `sentry.edge.config.ts`, find:

```typescript
  // Adjust this value in production, or use tracesSampler for greater control
  tracesSampleRate: 1,
```

Replace with:

```typescript
  // Trace sampling. Defaults to 0.1 in production; override via SENTRY_TRACES_SAMPLE_RATE.
  // Set to 1 only in dev/staging when you need full traces.
  tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE
    ? Number(process.env.SENTRY_TRACES_SAMPLE_RATE)
    : (process.env.NODE_ENV === 'production' ? 0.1 : 1),
```

> Apply the identical change to all three files. The client config also reads the same `SENTRY_TRACES_SAMPLE_RATE` — that's fine; if you prefer a public var for the client you may use `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` there, but a single var is acceptable for MVP since the value is not sensitive.

### Phase B Verification

```bash
npm run build
```

| Check | Expected Result |
|---|---|
| Build | Zero errors |
| No env var set, `NODE_ENV=production` | Effective rate is 0.1 |
| `SENTRY_TRACES_SAMPLE_RATE=0.25` | Effective rate is 0.25 |
| Dev (`NODE_ENV!=production`) | Effective rate is 1 |

---

## Phase C: Create `.env.example`

**C1.** Create `.env.example` at the repo root with the content below. Every variable corresponds to a real `process.env.*` read in the codebase or a documented requirement (`AUTH_SECRET` for Auth.js, `NEXT_PUBLIC_SENTRY_DSN` for Sentry). Placeholders only.

```bash
# =============================================================================
# ByTime — Environment Variables (template). Copy to `.env` and fill in.
# NEVER commit a real .env. This file contains placeholders only.
# =============================================================================

# --- Database (single-tenant deployment) ---------------------------------
# Per-customer Postgres connection string. For the self-service control plane,
# each tenant has its own DATABASE_URL (see the control-plane blueprint).
DATABASE_URL=postgresql://user:password@localhost:5432/bytime

# --- Authentication (Auth.js v5) -----------------------------------------
# 32-byte random secret: `openssl rand -base64 32`
AUTH_SECRET=replace-with-openssl-rand-base64-32
# Public base URL of this deployment (used in emails and OAuth redirects).
NEXT_PUBLIC_APP_URL=http://localhost:3000

# --- Encryption (TOTP secrets, recovery codes, tenant DB URLs) -----------
# 64-char hex key: `openssl rand -hex 32`
ENCRYPTION_KEY=replace-with-openssl-rand-hex-32

# --- Cron protection ------------------------------------------------------
# Shared secret sent as `x-cron-secret` by the scheduler. `openssl rand -hex 16`
CRON_SECRET=replace-with-random-cron-secret

# --- Email (Resend) -------------------------------------------------------
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxx
EMAIL_FROM="ByTime <noreply@yourdomain.com>"

# --- Error monitoring (Sentry) -------------------------------------------
NEXT_PUBLIC_SENTRY_DSN=
# Optional override; defaults to 0.1 in production, 1 in dev.
SENTRY_TRACES_SAMPLE_RATE=

# --- QuickBooks Online integration (optional) ----------------------------
QBO_CLIENT_ID=
QBO_CLIENT_SECRET=
# 'sandbox' or 'production'
QBO_ENVIRONMENT=sandbox

# --- Gusto integration (optional) ----------------------------------------
GUSTO_CLIENT_ID=
GUSTO_CLIENT_SECRET=
# 'demo' or 'production'
GUSTO_ENVIRONMENT=demo

# --- Testing (integration tests) -----------------------------------------
# Points at a disposable Postgres; integration tests truncate data.
TEST_DATABASE_URL=postgresql://bytime:bytime_dev@localhost:5432/bytime_test

# =============================================================================
# The variables below are NOT used yet — they are added by upcoming Tier 2
# blueprints. Listed here so the env contract is complete. Leave blank for now.
# =============================================================================

# --- Control plane / multi-tenancy (control-plane blueprint) -------------
# Registry DB tracking all tenants (slug -> encrypted tenant DATABASE_URL).
CONTROL_PLANE_DATABASE_URL=
# Apex domain for tenant subdomains, e.g. "bytime.app" -> acme.bytime.app
APP_ROOT_DOMAIN=

# --- Tenant provisioning (provisioning blueprint) ------------------------
# Neon API key used to create per-tenant databases.
NEON_API_KEY=
NEON_PROJECT_ID=

# --- Billing (Stripe) (billing blueprint) --------------------------------
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
```

**C2.** Confirm `.env.example` is NOT ignored by git (it must be committed) while real env files remain ignored. Check `.gitignore`:

```bash
grep -nE "env" .gitignore
```

`.gitignore` should ignore `.env`, `.env.local`, `.env.*` but must **not** ignore `.env.example`. If the pattern `.env*` would catch the example, add an explicit negation `!.env.example` to `.gitignore`.

> Editing `.gitignore` is permitted under this blueprint (it is config). Do not change any other ignore rules.

### Phase C Verification

| Check | Expected Result |
|---|---|
| `.env.example` exists at repo root | Yes |
| Contains every `process.env.*` the code reads | Yes (cross-check with `grep -rhoE "process\.env\.[A-Z_]+" src scripts \| sort -u`) |
| `git status` shows `.env.example` as trackable | Not ignored |
| No real secrets present | Placeholders only |

---

## 4. Verification

### 4a. Build

```bash
npm run build
```

Zero errors.

### 4b. Full regression

| Check | Expected Result |
|---|---|
| Login + session | Works (no header breaks auth cookies) |
| Timesheet grid, modals, tables | Render; no CSP console errors |
| Admin pages | Render |
| MFA enrollment QR | Displays |
| Report downloads (PDF/CSV/XLSX) | Work |
| Sentry receives events at reduced rate | Confirm in Sentry dashboard (staging) |

### 4c. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| Blank/unstyled UI after enabling CSP | `style-src` missing `'unsafe-inline'` | Keep `'unsafe-inline'` in `style-src` for Mantine |
| Console: "Refused to connect" to Sentry | Sentry host not in `connect-src` | Add your exact ingest host to `connect-src` |
| Console: "Refused to load script" | Next runtime needs inline scripts | `script-src` already allows `'unsafe-inline'`; in dev also `'unsafe-eval'` |
| MFA QR not visible | `img-src` missing `data:` | Keep `img-src 'self' data: blob:` |
| `.env.example` not committed | caught by `.env*` ignore | Add `!.env.example` to `.gitignore` |
| Sentry rate `NaN` | bad env value | `Number()` a non-numeric string → guard already falls back when var is unset; ensure the var, if set, is numeric |
| Stripe widgets break later | CSP too strict | The billing blueprint extends CSP for `js.stripe.com` / `api.stripe.com` — expected |
