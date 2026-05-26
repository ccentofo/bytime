# Blueprint: CI/CD Pipeline — GitHub Actions for Build, Test & Deploy

## 1. Architectural Overview

### Why CI/CD Now

The application has 40+ feature plans, a database migration system, 65 unit tests, and (after integration tests) ~85 total tests. But there is **no automated pipeline** — every build, test, and deployment is manual. A developer could push code that:
- Fails to build (TypeScript errors)
- Breaks existing tests
- Has schema changes without migrations
- Introduces DCAA compliance regressions

### Pipeline Design

```
Push to any branch
  → Lint (eslint)
  → Build (next build)
  → Unit Tests (vitest)
  → Migration Check (drizzle-kit check)

Push to main branch
  → All of the above PLUS:
  → Integration Tests (vitest --config integration, requires DB)
  → Deploy to staging (optional — manual trigger)
```

### Key Decisions

1. **GitHub Actions** — Standard CI for GitHub-hosted repos, free for public repos, generous free tier for private
2. **PostgreSQL service container** — GitHub Actions supports Docker service containers for integration tests
3. **No auto-deploy to production** — Production deployment is manual (too risky to automate for a DCAA system without thorough QA)
4. **Branch protection** — Require passing CI checks before merging to main

---

## 2. File Topology

```
Files to CREATE:
├── .github/
│   └── workflows/
│       ├── ci.yml                                    ← Main CI workflow (lint, build, test)
│       └── deploy-staging.yml                        ← Manual staging deployment (optional)

Files to MODIFY:
├── package.json                                      ← Add lint:ci script if needed

Files NOT TOUCHED:
├── All source files                                  ← ❌ DO NOT MODIFY
├── vitest.config.ts                                  ← ❌ DO NOT MODIFY
├── vitest.config.integration.ts                      ← ❌ DO NOT MODIFY
├── drizzle.config.ts                                 ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS:**
> - **DO NOT** modify any source files.
> - GitHub Actions workflow files must be in `.github/workflows/` directory.
> - YAML must be valid — use proper indentation (2 spaces).
> - Secrets (DATABASE_URL, AUTH_SECRET) must be configured in GitHub repo settings, NOT committed to code.
> - **After creating files, verify YAML syntax is correct.**

---

## Phase A: Main CI Workflow (A1)

### A1. Create `.github/workflows/ci.yml`

```yaml
name: CI — Build, Lint, Test

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

env:
  NODE_VERSION: '21'
  DATABASE_URL: postgresql://bytime:bytime_dev@localhost:5432/bytime_test

jobs:
  # ─────────────────────────────────────────────────────────────
  # Job 1: Lint + Build + Unit Tests (no DB needed)
  # ─────────────────────────────────────────────────────────────
  lint-build-test:
    name: Lint, Build & Unit Tests
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Lint
        run: npm run lint

      - name: Build
        run: npm run build
        env:
          # Provide dummy values for build-time env vars
          AUTH_SECRET: ci-dummy-auth-secret-not-real
          DATABASE_URL: postgresql://dummy:dummy@localhost:5432/dummy

      - name: Unit Tests
        run: npm run test

  # ─────────────────────────────────────────────────────────────
  # Job 2: Integration Tests (requires PostgreSQL)
  # ─────────────────────────────────────────────────────────────
  integration-tests:
    name: Integration Tests
    runs-on: ubuntu-latest
    needs: lint-build-test  # Only run if lint/build/unit pass
    if: github.ref == 'refs/heads/main' || github.event_name == 'pull_request'

    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: bytime
          POSTGRES_PASSWORD: bytime_dev
          POSTGRES_DB: bytime_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U bytime"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run database migrations
        run: npx drizzle-kit push
        env:
          DATABASE_URL: ${{ env.DATABASE_URL }}

      - name: Run integration tests
        run: npm run test:integration
        env:
          TEST_DATABASE_URL: ${{ env.DATABASE_URL }}
          DATABASE_URL: ${{ env.DATABASE_URL }}

  # ─────────────────────────────────────────────────────────────
  # Job 3: Migration Check (verify schema ↔ migration sync)
  # ─────────────────────────────────────────────────────────────
  migration-check:
    name: Migration Sync Check
    runs-on: ubuntu-latest
    needs: lint-build-test

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Check migration sync
        run: npm run db:check
```

---

## Phase B: Staging Deployment Workflow (B1)

### B1. Create `.github/workflows/deploy-staging.yml`

```yaml
name: Deploy to Staging

on:
  workflow_dispatch:  # Manual trigger only
    inputs:
      confirm:
        description: 'Type "deploy" to confirm'
        required: true
        default: ''

jobs:
  deploy:
    name: Deploy to Staging
    runs-on: ubuntu-latest
    if: github.event.inputs.confirm == 'deploy'

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '21'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build
        env:
          AUTH_SECRET: ${{ secrets.AUTH_SECRET }}
          DATABASE_URL: ${{ secrets.STAGING_DATABASE_URL }}

      - name: Run database migrations
        run: npm run db:deploy
        env:
          DATABASE_URL: ${{ secrets.STAGING_DATABASE_URL }}

      # Add your deployment step here (e.g., Docker push, Vercel, Railway, etc.)
      - name: Deploy
        run: echo "Add deployment command here (e.g., docker push, vercel deploy, etc.)"
        env:
          DATABASE_URL: ${{ secrets.STAGING_DATABASE_URL }}
          AUTH_SECRET: ${{ secrets.AUTH_SECRET }}
```

---

## Phase C: Branch Protection Rules (C1)

### C1. Configure GitHub Branch Protection (manual — not a code change)

Go to GitHub → Repository Settings → Branches → Add rule for `main`:

1. **Require status checks to pass before merging:**
   - ✅ `Lint, Build & Unit Tests`
   - ✅ `Migration Sync Check`
   - ✅ `Integration Tests` (optional but recommended)

2. **Require pull request reviews:** At least 1 approval

3. **Do not allow bypassing the above settings**

This ensures no code reaches `main` without passing all CI checks.

---

## Phase D: Add CI Badge to README (D1)

### D1. Modify `README.md` — Add CI status badge

Add at the top of the README:

```markdown
![CI](https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg)
```

Replace `<owner>/<repo>` with the actual GitHub repository path.

---

## 4. Verification

### 4a. Workflow Syntax Check

```bash
# Validate YAML syntax (requires yq or yamllint)
# Or just push and let GitHub validate
```

### 4b. Expected CI Run Times

| Job | Expected Time | What Runs |
|---|---|---|
| Lint, Build & Unit Tests | ~2-3 minutes | npm ci → eslint → next build → vitest |
| Integration Tests | ~3-5 minutes | npm ci → drizzle push → vitest integration |
| Migration Sync Check | ~1 minute | npm ci → drizzle-kit check |
| **Total pipeline** | ~5-8 minutes | All jobs in parallel (after lint-build-test) |

### 4c. Required GitHub Secrets

| Secret | Where to Set | Value |
|---|---|---|
| `AUTH_SECRET` | Repo Settings → Secrets | Random 32+ char string |
| `STAGING_DATABASE_URL` | Repo Settings → Secrets | PostgreSQL connection string for staging |

### 4d. Common Issues

| Issue | Fix |
|---|---|
| `npm ci` fails | Ensure `package-lock.json` is committed |
| Build fails — missing env vars | Dummy values provided for build-time; real values in secrets |
| Integration tests fail — DB not ready | `health-cmd` + retries ensure PostgreSQL is ready before tests |
| `db:check` fails | Developer forgot to generate migration after schema change |
| Deploy step empty | Replace `echo` with actual deployment command for your platform |

### 4e. CI/CD Flow Summary

```
Developer pushes code
  ↓
GitHub Actions triggers ci.yml
  ↓
┌────────────────────────────────┐
│ lint-build-test (parallel)     │
│ ├── npm ci                     │
│ ├── eslint                     │
│ ├── next build                 │
│ └── vitest (65 unit tests)     │
└────────────┬───────────────────┘
             ↓ (only if passed)
┌────────────────────────────────┐  ┌──────────────────────┐
│ integration-tests              │  │ migration-check      │
│ ├── PostgreSQL service         │  │ ├── npm ci           │
│ ├── drizzle-kit push           │  │ └── drizzle-kit check│
│ └── vitest integration (20)    │  └──────────────────────┘
└────────────────────────────────┘
             ↓
All checks pass → PR can be merged
             ↓
Manual trigger → deploy-staging.yml → Build + Migrate + Deploy
```
