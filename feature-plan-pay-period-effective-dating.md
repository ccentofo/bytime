# Blueprint: Effective-Dated Pay-Period Configuration — Changes Apply to Future Periods Only

> **Role for the executing developer: Senior engineer.** This touches schema, a new resolution
> layer, and every place periods are computed (server load + client navigation). Get the data model
> and the "config in effect at a date" rule right first; the rest follows.

## 1. Architectural Overview & DCAA Impact

### The problem
Pay-period configuration is a **single, overwritable global row** (`pay_period_config`). Period
boundaries for *every* period — past, active, future — are computed from whatever that row currently
says ([pay-period-config.ts](src/server/actions/pay-period-config.ts), [date-utils.ts:30](src/lib/date-utils.ts),
[timesheet/page.tsx:23](src/app/(app)/timesheet/page.tsx), [TimesheetContext.tsx:240](src/components/timesheet/TimesheetContext.tsx)).
So when an admin changes the interval (e.g., biweekly → semi-monthly), it **retroactively re-segments
historical and in-progress timesheets**.

A partial guard exists: `timesheet_periods` snapshots `periodType` + `periodNumDays` at **submit**, and
the read path overrides only `periodType` from that snapshot. This means:
- **Draft / never-submitted / active periods**: no snapshot → fully follow the new global config.
- **Submitted/approved**: protected on `periodType` only — **not** `anchorDate`/`weekStartDay`, so
  **weekly/biweekly** boundaries can still shift (semi-monthly/monthly are calendar-based, so safe).
- **Navigation math always uses the global config**, which can mismatch a rendered period's snapshot.

### DCAA impact
Re-segmenting periods that contain **certified (submitted/approved) labor** changes how hours roll up
into pay periods, submission scope, and the audit narrative. Entry *data* is safe (append-only, keyed
by date), but the **period grouping must be immutable once a period is active or certified.** A pay-
schedule change is a forward-looking business event; it must never rewrite history.

### The solution: effective-dated configuration
Replace the single global row with a **history of configs, each with an `effective_from` date**. The
"config in effect at date D" is the most recent row with `effective_from <= D`. Every period
computation resolves the config **for that period's start date**, so:
- Past periods keep the schedule that was in effect then.
- The active period keeps its schedule (you can't change a period that has already started).
- Submitted/approved periods are inherently immutable in structure.
- A new schedule is written with `effective_from = the next period boundary`, so it applies to
  **future periods only**.

This makes the per-period snapshot redundant for computation (the history is authoritative); we keep
writing the snapshot as an **audit record** and optionally expand it to the full config.

### Design decisions
1. **`effective_from` must land on a period boundary and be in the future.** `updatePayPeriodConfig`
   computes the start of the **next** period under the *current* config and uses that as `effective_from`.
   Retroactive or mid-period changes are rejected.
2. **One source of truth.** All period math (current period, neighbor navigation, numDays, period end,
   last-weekday-for-submit) resolves the config via `getEffectiveConfigAt(periodStartDate)`.
3. **Navigation crosses schedule changes correctly.** Stepping prev/next uses the *current* period's
   config to reach the adjacent period's date range, then snaps to the boundary under the config
   effective there. This is done server-side to keep the rule in one place.
4. **Audit snapshot retained.** Keep snapshotting on submit (expand to full config) so a certified
   period carries an immutable record of exactly what it used — independent of history edits.
5. **Backward compatible migration.** The existing single row is backfilled with a far-past
   `effective_from` so all existing periods keep their current schedule.

---

## 2. File Topology

```
Files to MODIFY:
├── src/db/schema.ts                         ← payPeriodConfig: add effective_from (history table), index
├── src/server/actions/pay-period-config.ts  ← Resolution layer: getEffectiveConfigAt, future-effective writes, history
├── src/server/actions/periods.ts            ← submit/last-weekday math uses per-date config; expand snapshot (optional)
├── src/app/(app)/timesheet/page.tsx         ← Resolve config at the loaded period's start (drop periodType-only override)
├── src/components/timesheet/TimesheetContext.tsx ← Navigation fetches effective config per target period
├── src/lib/date-utils.ts                    ← (If needed) a helper to snap a date to its period start under a config
├── src/app/(app)/admin/settings/**          ← Settings UX: "applies starting <date>", show schedule history, block retro
├── drizzle/<generated>.sql                  ← Generated migration (npm run db:generate) — additive + backfill

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/db/control-plane/**                  ← Unrelated
├── src/server/actions/timesheet.ts          ← Entries are by date; no change
```

> Tenant note: `pay_period_config` is a **tenant** table, so the migration runs per tenant DB via the
> normal migration flow. No control-plane changes.

---

## 3. Step-by-Step Execution Plan

> **⚠️ GUARDRAILS:**
> - Read the Next 16 / Drizzle docs in `node_modules` before relying on APIs.
> - The invariant to protect: **no period that has started or been certified may change structure.**
> - All period computation must go through `getEffectiveConfigAt(date)` — no direct reads of "the
>   global config" for segmentation.
> - `npm run build`, `npm run db:check`, and existing tests must pass. Add tests (see §4).

### Phase A — Schema & migration
**A1.** In `src/db/schema.ts`, make `payPeriodConfig` an effective-dated history table: add
`effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull()`, keep
`periodType`/`anchorDate`/`weekStartDay`, add `createdAt`. Add an index on `effectiveFrom`
(descending lookups). Remove the implicit "single row" assumption.

**A2.** `npm run db:generate`. Hand-verify the generated SQL: it must (a) add `effective_from`
nullable, (b) **backfill** existing row(s) with a far-past value (e.g. `'1900-01-01'`), (c) set the
column `NOT NULL`. If drizzle can't express the backfill, add a manual `UPDATE ... SET effective_from
= '1900-01-01' WHERE effective_from IS NULL;` step between the add-column and set-not-null in the
migration file. This guarantees existing periods keep their current schedule.

### Phase B — Resolution layer (`pay-period-config.ts`)
**B1.** `getEffectiveConfigAt(date: Date): Promise<PeriodConfig>` — return the row with the greatest
`effective_from <= date`; fall back to `DEFAULT_PERIOD_CONFIG` if none.

**B2.** `getCurrentEffectiveConfig(): Promise<PeriodConfig>` — `getEffectiveConfigAt(now)`. Keep the
existing `getPayPeriodConfig()` name as an alias of this for callers that legitimately want "the
config in effect now" (e.g., computing the current period to land on at page load).

**B3.** Rewrite `updatePayPeriodConfig` to be future-effective and non-destructive:
- Compute the **next period boundary** under the *current* effective config (use
  `getCurrentEffectiveConfig` + `getCurrentPeriodStart` + `navigatePeriod(..., 'next')`).
- **Reject** any `effectiveFrom` earlier than that boundary (no retroactive/mid-period changes).
- **Insert** a new history row with `effectiveFrom = next boundary` (do NOT overwrite prior rows).
- If a not-yet-effective future row already exists, replace it (so re-editing the pending change works).
- Return the computed `effectiveFrom` so the UI can say "applies starting <date>".

**B4.** `getConfigHistory()` and/or `getPendingConfigChange()` for the settings UI.

### Phase C — Apply per-date config everywhere periods are computed
**C1.** `timesheet/page.tsx`: compute the landing period from `getCurrentEffectiveConfig()`, then set
`periodConfig` for the rendered period via `getEffectiveConfigAt(periodStart)`. **Remove the
`periodType`-only snapshot override** ([page.tsx:37-43](src/app/(app)/timesheet/page.tsx)) — the
effective config is now authoritative.

**C2.** `TimesheetContext.tsx` navigation: today it computes the neighbor with the *global* config
([:240-241](src/components/timesheet/TimesheetContext.tsx)) and overrides only `periodType`
([:251-259](src/components/timesheet/TimesheetContext.tsx)). Replace with a server-resolved neighbor:
- Add a server action `getNeighborPeriod(currentPeriodStart, direction): { periodStart, config, numDays }`
  that (a) resolves the config effective at `currentPeriodStart`, (b) steps one period in `direction`
  to reach a probe date in the neighbor, (c) resolves the config effective at the probe date, (d) snaps
  the probe to that config's period start, and returns the start + that config + its numDays. This keeps
  the cross-schedule-change rule in one place and correct.
- Navigation in the client calls `getNeighborPeriod` (fold it into the existing `Promise.all` with
  entries/revisions/status), and stores the returned `config`/`numDays` in state for rendering.
- `loadPeriodByDate` similarly resolves via `getEffectiveConfigAt(date)` → snap to period start.

**C3.** `periods.ts`: `submitPeriod`'s "last weekday of period" and numDays math must use
`getEffectiveConfigAt(periodStart)`, not the global config. Keep snapshotting on submit; **optionally
expand the snapshot** to store the full effective config (`anchorDate`, `weekStartDay`) so the audit
record is complete (closes the weekly/biweekly audit gap). Approve/reject are unaffected (status only).

**C4.** Audit cross-check (optional, recommended): when reading a submitted/approved period, assert the
snapshot matches `getEffectiveConfigAt(periodStart)`; log a warning on mismatch (should never happen
once changes are future-only — a useful tripwire).

### Phase D — Settings UX
**D1.** In the pay-period settings page, after a change, show **"Your new schedule takes effect
<effectiveFrom date> — the current and past periods are unchanged."** Surface the pending change and
allow editing it before it takes effect.

**D2.** Make retroactive selection impossible in the UI (the server already rejects it). Optionally
show a short schedule history (which interval applied when).

---

## 4. Verification

### 4a. Build / migration
```bash
npm run build && npm run db:check
# apply the migration to a test tenant DB and confirm existing periods are unchanged
```

### 4b. Core behavior matrix (the acceptance gate)
Set up a tenant with some history, then change the interval and verify:

| Scenario | Expected |
|---|---|
| Change interval, view a **past** period | Unchanged — uses the schedule effective then |
| Change interval, view the **current/active** period | Unchanged — keeps its schedule (change is future-effective) |
| Change interval, view a **submitted/approved** period | Unchanged structure (and snapshot matches) |
| Navigate to a **future** period past the effective date | Uses the **new** interval |
| Navigate **across** the change boundary (prev/next) | Boundaries line up cleanly; no overlap/gap/double-count |
| Settings after change | Shows "applies starting <date>"; current period not affected |
| Attempt a retroactive/mid-period `effective_from` | Rejected server-side |
| Fresh tenant, no config rows | Defaults to semi-monthly for all periods (no retro shifting) — fixes the original report |

### 4c. Tests to add
- Unit: `getEffectiveConfigAt` (multiple history rows, boundary at exactly `effective_from`, fallback to default).
- Unit/integration: `updatePayPeriodConfig` sets `effective_from` to the next boundary and rejects retro dates.
- Integration: a submitted period's structure is stable across a subsequent interval change.
- Integration: `getNeighborPeriod` returns correct starts when stepping across a schedule change.

### 4d. Common errors to watch for
| Symptom | Cause | Fix |
|---|---|---|
| Past periods still shift after change | a read path still uses the global config | route ALL segmentation through `getEffectiveConfigAt(periodStart)` |
| Overlap/gap navigating across the change | neighbor computed with one config only | use the two-sided snap in `getNeighborPeriod` |
| Migration makes existing periods re-segment | `effective_from` backfilled to "now" instead of far-past | backfill existing row to `'1900-01-01'` |
| Change took effect immediately mid-period | `effective_from` not snapped to next boundary | compute next boundary under current config; reject earlier dates |
| Weekly/biweekly submitted period shifts | snapshot lacked anchor/weekStart | effective-dating fixes computation; expand snapshot for the audit record |
| `getEffectiveConfigAt` returns wrong row | comparison/order bug | greatest `effective_from <= date`, tie-break by `created_at` desc |
```
