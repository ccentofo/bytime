# Blueprint: Production Deployment — Vercel + Neon (Free Tier)

## 1. Architectural Overview

### Deployment Target

- **Application:** Vercel (free hobby tier) — automatic HTTPS, global CDN, preview deployments
- **Database:** Neon (free tier — 0.5GB serverless PostgreSQL) — auto-suspend on idle, instant resume
- **Cost:** $0/month

### Why This Stack

| Component | Choice | Why |
|---|---|---|
| **App hosting** | Vercel | Built for Next.js, one-click deploy, free HTTPS, custom domains |
| **Database** | Neon | Free serverless PostgreSQL, Drizzle ORM compatible, auto-suspend saves resources |
| **Email** | Resend (optional) | Free 100/day tier, already integrated |

### Architecture

```
Users → Vercel CDN (vercel.app or custom domain)
  → Next.js Serverless Functions
    → Neon PostgreSQL (serverless, auto-suspend)
```

---

## 2. File Topology

```
Files to CREATE:
├── .env.example                                     ← Template for all environment variables
├── src/app/api/health/route.ts                      ← Health check endpoint
├── vercel.json                                      ← Vercel deployment configuration (optional)

Files to MODIFY:
├── next.config.ts                                   ← Ensure compatible with Vercel
├── src/db/index.ts                                  ← Add Neon serverless driver support
├── README.md                                        ← Complete rewrite with product info
├── package.json                                     ← Add @neondatabase/serverless (if needed)

Files NOT TOUCHED:
├── All feature source code                          ← ❌ DO NOT MODIFY
├── src/auth.ts                                      ← ❌ DO NOT MODIFY
├── src/db/schema.ts                                 ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS:**
> - **DO NOT** modify feature source code — this is deployment infrastructure only.
> - **DO NOT** commit secrets to the repository.
> - **After each phase, run `npm run build` to verify zero errors.**

---

### Phase A: Environment Configuration (A1–A2)

#### A1. Create `.env.example`

```env
# ── Database ──
# Neon free tier: https://neon.tech (sign up, create project, copy connection string)
DATABASE_URL=postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/bytime?sslmode=require

# ── Authentication ──
# Generate with: openssl rand -base64 32
AUTH_SECRET=your-random-secret-at-least-32-characters

# ── Application URL ──
NEXT_PUBLIC_APP_URL=https://your-app.vercel.app

# ── Email (optional — Resend) ──
# RESEND_API_KEY=re_xxxxxxxxxxxx
# EMAIL_FROM=noreply@yourdomain.com

# ── Cron Secret (optional — protects cron endpoints) ──
# CRON_SECRET=your-cron-secret
```

#### A2. Add `.env.example` to git (verify `.env.local` is in `.gitignore`)

The `.gitignore` should already have `.env.local`. Verify it also has `.env` but NOT `.env.example`.

---

### Phase B: Database Connection for Neon (B1)

#### B1. Modify `src/db/index.ts` — Support both local and Neon connections

Neon's free tier requires SSL (`?sslmode=require` in the connection string). The `postgres` package handles this automatically when the URL includes `sslmode=require`. No code changes needed — just ensure the `DATABASE_URL` has `?sslmode=require` when pointing to Neon.

**However**, add a guard for missing `DATABASE_URL`:

```typescript
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. See .env.example for required environment variables.'
  );
}

// Connection pool configuration
// - max: 10 for dev, Neon free tier handles up to 20
// - idle_timeout: 20 seconds
// - connect_timeout: 10 seconds (Neon cold starts can be slow)
// - prepare: false (required for Neon serverless)
const client = postgres(connectionString, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

export const db = drizzle(client, { schema });
```

---

### Phase C: Health Check Endpoint (C1)

#### C1. Create `src/app/api/health/route.ts`

```typescript
import { NextResponse } from 'next/server';
import { db } from '@/db';
import { sql } from 'drizzle-orm';

export async function GET() {
  try {
    // Quick DB connectivity check
    await db.execute(sql`SELECT 1`);

    return NextResponse.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version ?? '0.1.0',
    });
  } catch {
    return NextResponse.json(
      { status: 'unhealthy', error: 'Database connection failed' },
      { status: 503 }
    );
  }
}
```

---

### Phase D: Next.js Configuration for Vercel (D1)

#### D1. Verify `next.config.ts` is Vercel-compatible

Read the current config. Vercel deploys Next.js natively — no special configuration needed unless there are custom settings. Ensure:
- No `output: 'standalone'` (that's for Docker, not Vercel)
- No custom server
- The config should be minimal

---

### Phase E: Deploy to Vercel (E1–E5)

These are manual steps (not code changes):

#### E1. Push code to GitHub

```bash
git add -A
git commit -m "chore: prepare for production deployment"
git push origin main
```

#### E2. Sign up for Neon (free)

1. Go to https://neon.tech
2. Sign up with GitHub
3. Create a new project (name: `bytime`)
4. Copy the connection string (it includes `?sslmode=require`)
5. Save it — you'll need it for Vercel

#### E3. Set up Neon database

```bash
# Set DATABASE_URL to your Neon connection string
export DATABASE_URL="postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/bytime?sslmode=require"

# Push schema to Neon
npx drizzle-kit push

# Seed demo data
npx tsx scripts/seed-full.ts
```

#### E4. Deploy to Vercel

1. Go to https://vercel.com
2. Sign up with GitHub
3. Click "Import Project" → select your `bytime` repository
4. Set environment variables:
   - `DATABASE_URL` = your Neon connection string
   - `AUTH_SECRET` = run `openssl rand -base64 32` and paste the result
   - `NEXT_PUBLIC_APP_URL` = `https://bytime.vercel.app` (or your custom domain)
5. Click "Deploy"

#### E5. Verify deployment

```bash
# Check health
curl https://your-app.vercel.app/api/health

# Test login page
open https://your-app.vercel.app/login
```

---

### Phase F: Professional README (F1)

#### F1. Replace `README.md` with product documentation

```markdown
# ByTime — DCAA-Compliant Timekeeping for Government Contractors

![Build Status](https://img.shields.io/badge/build-passing-brightgreen)
![Tests](https://img.shields.io/badge/tests-85%20passing-brightgreen)
![DCAA](https://img.shields.io/badge/DCAA-compliant-blue)

**ByTime** is a modern, fault-tolerant timekeeping and project management application designed specifically for Government Contractors (GovCon). It replaces legacy systems like Deltek, Unanet, and HourTimesheet with a vastly superior user experience while strictly adhering to DCAA compliance standards.

## 🎯 Demo

**Live Demo:** [https://bytime.vercel.app](https://bytime.vercel.app)

| Role | Email | Password |
|---|---|---|
| Admin | admin@bytime.dev | Password123! |
| Supervisor | sarah.wilson@bytime.dev | Password123! |
| Employee | jane.smith@bytime.dev | Password123! |

## ✨ Key Features

### DCAA Compliance (Built-In)
- ✅ **Append-Only Audit Trail** — Every change creates a new revision; nothing is ever deleted
- ✅ **Daily Time Entry** — Late entry detection with mandatory reason codes
- ✅ **Total Time Accounting** — FLSA exempt overtime tracking + indirect charge codes
- ✅ **Granular RBAC** — Employees can only charge to explicitly assigned CLINs
- ✅ **Digital Certification** — Employee submission + supervisor approval workflows
- ✅ **Audit Trail Viewer** — Full revision history with timeline visualization

### Modern UX
- 🌙 **Dark/Light Mode** — Seamless theme switching
- 📱 **Responsive Design** — Works on desktop, tablet, and mobile
- 🔌 **Offline Support** — Log time without internet; syncs automatically
- ⚡ **Fast** — Sub-second page loads with parallel data fetching
- 🔔 **Notifications** — Email alerts for submissions, approvals, rejections

### GovCon Data Model
- 📋 Contracts → CLINs → SLINs → Labor Categories → Employees
- 💰 Budget tracking with funded value, ceiling, and burn % visualization
- 📊 Cost reports (PDF, CSV, Excel) with effective-date rate accuracy
- 🏷️ Indirect charge codes (Overhead, G&A, IR&D, B&P, Leave)

### Administration
- 👥 User management with role-based access
- 🔐 Brute force protection + session invalidation
- 🔑 REST API with API key authentication
- 📧 Configurable email notifications
- 🗄️ Database migration system

## 🚀 Quick Start

### Prerequisites
- Node.js 21+
- PostgreSQL 16+ (or Docker)

### Setup

```bash
# Clone and install
git clone <repo-url>
cd bytime
npm install

# Start PostgreSQL
docker-compose up -d

# Push schema and seed data
npx drizzle-kit push
npm run db:seed:full

# Start dev server
npm run dev
```

Open http://localhost:3000 and login with any demo credentials above.

## 🧪 Testing

```bash
npm run test              # Unit tests (65 tests)
npm run test:integration  # Integration tests (20 tests, requires DB)
npm run test:all          # All tests
```

## 📦 Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router, RSC, Server Actions) |
| UI | Mantine v9 + Mantine React Table v2 |
| Database | PostgreSQL 16 |
| ORM | Drizzle ORM |
| Auth | Auth.js v5 (JWT sessions) |
| Offline | Dexie.js (IndexedDB) |
| Testing | Vitest |
| Email | Resend + React Email |

## 📄 License

Proprietary — All rights reserved.
```

---

## 4. Verification

### Deployment Checklist

| Check | Expected |
|---|---|
| `npm run build` passes | Zero errors |
| Neon DB schema pushed | All tables created |
| Demo data seeded | 8 users, 1340 entries |
| Vercel deployment succeeds | Green checkmark |
| `/api/health` returns 200 | `{"status":"healthy"}` |
| Login works | admin@bytime.dev / Password123! |
| Timesheet page loads | Dashboard + grid with seeded data |
| Dark mode works | Toggle in header |
| Reports page works | PDF download with correct dates |

### Common Issues

| Issue | Fix |
|---|---|
| `ECONNREFUSED` on Vercel | DATABASE_URL missing `?sslmode=require` |
| `AUTH_SECRET is missing` | Set AUTH_SECRET in Vercel environment variables |
| Cold start timeout | Neon free tier takes 3-5s on first request after idle; subsequent requests are fast |
| Build fails on Vercel | Ensure `prepare: false` in postgres client config |
