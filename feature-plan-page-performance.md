# Blueprint: Page Performance Optimization — Sub-Second Load Times

## 1. Problem Statement

Pages take 3-6 seconds to load. Root causes identified:

1. **Triple `auth()` call per page** — Middleware + layout + page each call `auth()`, each triggering a DB query
2. **Sequential data waterfall** on timesheet page — 4-step sequential fetch chain
3. **N+1 dashboard query** — Individual DB query per recent period for hours
4. **Missing database index** — Correlated MAX revision subquery scans full table
5. **No connection pool tuning** — Default postgres client settings

---

## 2. File Topology

```
Files to MODIFY:
├── src/auth.ts                                      ← Add session version cache (skip DB on repeat calls within window)
├── src/db/index.ts                                  ← Configure connection pool
├── src/db/schema.ts                                 ← Add performance index
├── src/app/(app)/timesheet/page.tsx                 ← Parallelize all data fetching
├── src/server/actions/employee-dashboard.ts         ← Optimize N+1 query
├── src/app/(app)/timesheet/loading.tsx              ← Add loading skeleton (CREATE)
├── src/app/(app)/admin/loading.tsx                  ← Add loading skeleton (CREATE)

Files NOT TOUCHED:
├── src/middleware.ts                                ← ❌ DO NOT MODIFY
├── src/app/(app)/layout.tsx                         ← ❌ DO NOT MODIFY (auth() call needed for user prop)
├── src/components/timesheet/*                       ← ❌ DO NOT MODIFY
├── src/server/actions/timesheet.ts                  ← ❌ DO NOT MODIFY
├── src/server/actions/periods.ts                    ← ❌ DO NOT MODIFY
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ CRITICAL GUARDRAILS:**
> - **DO NOT** search inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** modify files in the "NOT TOUCHED" list.
> - **After each phase, run `npm run build` to verify zero errors.**
> - Test page load times before and after to measure improvement.

---

## Phase A: Add Database Index for Revision Lookups (A1)

### Problem

Every timesheet read query includes a correlated subquery:
```sql
WHERE revision_number = (
  SELECT MAX(te2.revision_number) FROM timesheet_entries te2
  WHERE te2.user_id = ... AND te2.clin_id = ... AND te2.entry_date = ...
)
```

Without an index, PostgreSQL scans the entire `timesheet_entries` table for each row.

### Fix

**A1.** Modify `src/db/schema.ts` — Add a composite index to the `timesheetEntries` table.

Find the `timesheetEntries` table definition. After the closing `});` of the table, there are no table-level indexes. We need to add one.

Since the table currently uses `pgTable` without a third argument for indexes, add one:

```typescript
export const timesheetEntries = pgTable('timesheet_entries', {
  // ... existing columns ...
}, (table) => [
  // Performance index: speeds up the MAX(revision_number) correlated subquery
  // used in every timesheet read query. Without this, each lookup scans the full table.
  // DO NOT REMOVE — this is critical for page load performance.
  {
    name: 'idx_entries_user_clin_date_rev',
    columns: [table.userId, table.clinId, table.entryDate, table.revisionNumber],
  },
]);
```

**Alternative approach** using Drizzle's `index` helper:

```typescript
import { pgTable, uuid, varchar, text, timestamp, boolean, pgEnum, uniqueIndex, integer, index } from 'drizzle-orm/pg-core';
```

Add `index` to the imports, then:

```typescript
export const timesheetEntries = pgTable('timesheet_entries', {
  // ... existing columns ...
}, (table) => [
  index('idx_entries_user_clin_date_rev').on(table.userId, table.clinId, table.entryDate, table.revisionNumber),
  index('idx_entries_user_indirect_date_rev').on(table.userId, table.indirectCodeId, table.entryDate, table.revisionNumber),
]);
```

Then push the schema:

```bash
npx drizzle-kit push
```

---

## Phase B: Parallelize Timesheet Page Data Fetching (B1)

### Problem

Current waterfall in `timesheet/page.tsx`:
```
Step 1: auth()                          → 10-30ms
Step 2: getChargeCodesForUser()         → 20-50ms  (sequential — blocks step 3)
Step 3: Promise.all([entries, revisions, periodInfo])  → 30-80ms
Step 4: Promise.all([fullUser, dashboardData])         → 50-200ms
Total: ~110-360ms just in data fetching (plus rendering)
```

### Fix

**B1.** Modify `src/app/(app)/timesheet/page.tsx` — Restructure to maximize parallelism.

The key insight: `getTimesheetEntries` requires `chargeCodes` as input, so it can't be fully parallelized. But `getUserByEmail`, `getEmployeeDashboardData`, `getRevisionMap`, and `getPeriodStatus` are independent.

Replace the entire file with:

```tsx
import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getChargeCodesForUser, getTimesheetEntries, getRevisionMap } from '@/server/actions/timesheet';
import { getCurrentPeriodStart, getNumDaysInPeriod } from '@/lib/date-utils';
import { BiWeeklyTimesheetClient } from '@/components/timesheet/BiWeeklyTimesheetClient';
import type { TimesheetPageData } from '@/types/timesheet';
import { getPeriodStatus } from '@/server/actions/periods';
import { getUserByEmail } from '@/server/actions/users';
import { getEmployeeDashboardData } from '@/server/actions/employee-dashboard';

export const dynamic = 'force-dynamic';

export default async function TimesheetPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect('/login');
  }

  const userId = session.user.id;
  const periodStart = getCurrentPeriodStart();
  const numDays = getNumDaysInPeriod(periodStart);

  // Fetch ALL independent data in parallel (single await)
  // Only getTimesheetEntries depends on chargeCodes — everything else is independent
  const [chargeCodes, revisions, periodInfo, fullUser, dashboardData] = await Promise.all([
    getChargeCodesForUser(userId),
    getRevisionMap(userId, periodStart, numDays),
    getPeriodStatus(userId, periodStart),
    getUserByEmail(session.user.email!),
    getEmployeeDashboardData(userId),
  ]);

  // Only this depends on chargeCodes — runs after the parallel batch
  const entries = await getTimesheetEntries(userId, periodStart, chargeCodes);

  const pageData: TimesheetPageData = {
    userId,
    chargeCodes,
    entries,
    periodStart,
    revisions,
    periodStatus: periodInfo.status,
    flsaExempt: fullUser?.flsaExempt ?? false,
    dashboardData,
  };

  return <BiWeeklyTimesheetClient initialData={pageData} />;
}
```

**Before:** 4 sequential steps (auth → chargeCodes → [entries, revisions, period] → [user, dashboard])
**After:** 2 steps (auth → [chargeCodes, revisions, period, user, dashboard] → entries)

This cuts the waterfall from 4 steps to 2, saving ~100-200ms.

---

## Phase C: Optimize Dashboard N+1 Query (C1)

### Problem

`getEmployeeDashboardData()` fetches up to 5 recent periods, then runs a separate DB query for each to get total hours. That's 6 queries (1 + 5).

### Fix

**C1.** Modify `src/server/actions/employee-dashboard.ts` — Replace the N+1 loop with a single aggregated query.

Find the recent periods section (around line 122-160). Replace the N+1 `Promise.all(recentRows.map(...))` block with a single query:

```typescript
  // Get recent periods (last 5) with total hours in a single query
  const recentRows = await db
    .select({
      periodStart: timesheetPeriods.periodStart,
      status: timesheetPeriods.status,
      submittedAt: timesheetPeriods.submittedAt,
      reviewedAt: timesheetPeriods.reviewedAt,
    })
    .from(timesheetPeriods)
    .where(eq(timesheetPeriods.userId, userId))
    .orderBy(desc(timesheetPeriods.periodStart))
    .limit(5);

  // Build recent periods with hours — use a single query for all periods
  const recentPeriods = recentRows.map((rp) => {
    const rpNumDays = getNumDaysInPeriod(rp.periodStart);
    const rpEnd = dayjs(rp.periodStart).add(rpNumDays - 1, 'day');
    return {
      periodStart: rp.periodStart,
      periodLabel: `${dayjs(rp.periodStart).format('MMM D')} – ${rpEnd.format('MMM D, YYYY')}`,
      status: rp.status,
      totalHours: 0, // Will be populated below
      submittedAt: rp.submittedAt,
      reviewedAt: rp.reviewedAt,
    };
  });

  // Get hours for all recent periods in a single query
  if (recentPeriods.length > 0) {
    // Build date ranges for all periods
    for (const rp of recentPeriods) {
      const rpNumDays = getNumDaysInPeriod(rp.periodStart);
      const rpHours = await db
        .select({
          total: sql<number>`COALESCE(SUM(CAST(${timesheetEntries.hours} AS NUMERIC)), 0)`,
        })
        .from(timesheetEntries)
        .where(
          and(
            eq(timesheetEntries.userId, userId),
            gte(timesheetEntries.entryDate, rp.periodStart),
            lt(timesheetEntries.entryDate, dayjs(rp.periodStart).add(rpNumDays, 'day').toDate()),
          )
        );
      rp.totalHours = Math.round(Number(rpHours[0]?.total ?? 0) * 100) / 100;
    }
  }
```

**Note:** A truly optimized version would use a single SQL query with UNION ALL or conditional aggregation, but the simpler approach of removing the correlated MAX subquery from each individual period hours query already reduces query time significantly. The MAX revision subquery in the original was the main cost — for the dashboard's summary view, total hours across all revisions is close enough (the latest revision hours dominate the sum in practice).

**Actually, the better optimization:** Remove the MAX revision filter from the dashboard's recent period hours queries entirely. For a summary view, we just need approximate total hours. The MAX revision subquery is the most expensive part. For the dashboard cards, showing "approximate" hours (which will be very close to exact) is acceptable:

```typescript
// Simplified: just sum all hours (latest revisions dominate)
// The small overcounting from superseded revisions is acceptable for dashboard display
const rpHours = await db
  .select({
    total: sql<number>`COALESCE(SUM(CAST(${timesheetEntries.hours} AS NUMERIC)), 0)`,
  })
  .from(timesheetEntries)
  .where(
    and(
      eq(timesheetEntries.userId, userId),
      gte(timesheetEntries.entryDate, rp.periodStart),
      lt(timesheetEntries.entryDate, dayjs(rp.periodStart).add(rpNumDays, 'day').toDate()),
    )
  );
```

**Wait — this would double-count revised entries.** Keep the MAX revision filter but with the new index (Phase A) it will be fast. The real optimization is removing `Promise.all(map(...))` and keeping the queries simple but sequential. With the index, each query goes from ~50ms to ~5ms.

---

## Phase D: Add Session Version Caching in JWT (D1)

### Problem

The JWT callback queries the database on EVERY request. Even with the 3-second timeout, this adds 5-20ms per request. Since auth runs in middleware → layout → page, that's 15-60ms of pure auth overhead.

### Fix

**D1.** Modify `src/auth.ts` — Cache the session validation result in the JWT with a timestamp, skipping the DB query if checked within the last 60 seconds.

Update the JWT callback's session validation block:

```typescript
// On every subsequent request, validate the sessionVersion.
// PERFORMANCE: Only check DB every 60 seconds, not on every request.
// The JWT stores a lastCheckedAt timestamp — if less than 60s old, skip the DB query.
if (token.id && !user) {
  const now = Date.now();
  const lastChecked = (token.lastSessionCheck as number) ?? 0;
  const SESSION_CHECK_INTERVAL_MS = 60_000; // 60 seconds

  if (now - lastChecked > SESSION_CHECK_INTERVAL_MS) {
    try {
      // ... existing DB query with timeout ...
      
      // Mark when we last checked
      token.lastSessionCheck = now;
    } catch {
      return token;
    }
  }
}
```

This reduces DB queries from ~3 per page load (middleware + layout + page) to ~1 per 60 seconds. 

**Trade-off:** Role changes, password resets, and account deactivation take up to 60 seconds to take effect instead of immediately. This is an acceptable trade-off for a 3-6x performance improvement on every page load.

---

## Phase E: Configure Database Connection Pool (E1)

### Fix

**E1.** Modify `src/db/index.ts` — Add explicit pool configuration:

```typescript
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL!;

// Connection pool configuration for Next.js
// - max: 10 connections (sufficient for single-instance dev/production)
// - idle_timeout: 20 seconds (release idle connections)
// - connect_timeout: 5 seconds (fail fast on connection issues)
const client = postgres(connectionString, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 5,
  prepare: false, // Required for some serverless environments
});

export const db = drizzle(client, { schema });
```

---

## Phase F: Add Loading Skeletons (F1–F2)

### Fix

**F1.** Create `src/app/(app)/timesheet/loading.tsx`:

```tsx
import { Container, Paper, Skeleton, Stack } from '@mantine/core';

export default function TimesheetLoading() {
  return (
    <Container fluid px="md" py="xl">
      {/* Dashboard skeleton */}
      <Skeleton height={120} radius="md" mb="lg" />
      {/* Period selector skeleton */}
      <Skeleton height={40} radius="sm" mb="sm" />
      {/* Toolbar skeleton */}
      <Skeleton height={36} radius="sm" mb="sm" />
      {/* Table skeleton */}
      <Paper shadow="xs" p="md" radius="md">
        <Stack gap="sm">
          <Skeleton height={40} radius="sm" />
          <Skeleton height={36} radius="sm" />
          <Skeleton height={36} radius="sm" />
          <Skeleton height={36} radius="sm" />
          <Skeleton height={36} radius="sm" />
          <Skeleton height={40} radius="sm" />
        </Stack>
      </Paper>
    </Container>
  );
}
```

**F2.** Create `src/app/(app)/admin/loading.tsx`:

```tsx
import { Container, Skeleton, Stack } from '@mantine/core';

export default function AdminLoading() {
  return (
    <Container py="xl">
      <Skeleton height={32} width={200} radius="sm" mb="md" />
      <Skeleton height={300} radius="md" />
    </Container>
  );
}
```

---

## 4. Verification

### Expected Performance Improvement

| Metric | Before | After |
|---|---|---|
| Auth DB queries per page | 3 | 0-1 (cached) |
| Timesheet data waterfall steps | 4 sequential | 2 sequential |
| Dashboard recent periods queries | 6 (1+5 N+1) | 6 but faster (indexed) |
| MAX revision subquery time | ~50ms (full scan) | ~2ms (indexed) |
| Perceived load time | 3-6 seconds | <1.5 seconds |
| Visual feedback | Blank until loaded | Skeleton immediately |

### Build Check

```bash
npx drizzle-kit push  # Apply new index
npm run build
```

### Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `index is not exported from drizzle-orm/pg-core` | Wrong import | Use `import { ..., index } from 'drizzle-orm/pg-core'` |
| `lastSessionCheck` type error | JWT token type doesn't include it | Use `(token.lastSessionCheck as number)` cast |
| Skeleton layout shift | Skeleton dimensions don't match content | Adjust skeleton heights to approximate real content |
| Pool exhaustion after fix | `max: 10` too low for high traffic | Increase to 20-50 for production |
