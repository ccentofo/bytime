# Feature plan: Dated labor-category rates

Status: FINAL v3 (lead architect, 2026-10-25) — pre-mortem rounds 1–2 incorporated (2 = the limit set by the product
owner; remaining risk is caught at the post-implementation audit). Follows `BLUEPRINT-STANDARD.md`.
Implemented by the dev agent; audited by the lead. **Starts only after `feature-plan-certified-outputs.md` is
merged** — it builds on that plan's `src/server/internal/cost-basis.ts` (C3), its `admin_change_log` table and log
writer (tenant migration 0014), and its ruling Q3 (`feature-plan-certified-outputs.md` v6.1).

**Goal (CO-D7, CO-D13):** an hour is priced at the labor-category rate **in effect on the day it was worked**. A rate
changes two ways: **"new rate from a date"** (applies from that date onward) or **"correction"** (the rate was entered
wrong — it applies to every hour in that rate's period). Every change is logged with who, when, old and new values.
Charge codes get the same treatment for *which* labor category they bill.

**Read §11 ("Known traps") before writing any code.** Each step below has one intended implementation. Where the code
you find differs from what the plan says, stop and report with file:line — don't improvise.

| Phase | Scope | App working after it? |
|---|---|---|
| D1 | Data model, the one rate rule (SQL + pure TS), pricing through `cost-basis.ts`, rate actions, impact preview, import fix, export / cleanup / seed | Yes — rates can't be edited in the UI until D2 (the edit form stops sending rates) |
| D2 | Rate schedule UI, current-rate displays, report wording | Yes |
| D3 | Charge codes: dated labor category (same pattern) | Yes |

---

## 0. Decisions

### Product owner (recorded)
| ID | Decision |
|---|---|
| CO-D7 | Rate changes must not re-price past hours; price each hour at the rate in effect on the day worked. Two kinds of change: **correction** (rate entered wrong → applies to all hours of that period, logged) and **new rate from a date** (applies from that date forward). |
| CO-D13 | Changing a used charge code's labor category: allowed, with a warning **and logged** (who, when, old, new); same correction-versus-new-rate treatment once rates are dated. |
| CO-D10 | Labor-category resolution order is **unchanged** by this plan; only the *rate* of the resolved category becomes dated. |

### Open — product owner (the plan ships the stated default until answered)
| ID | Question | Default until answered |
|---|---|---|
| DR-Q1 | May a "new rate from a date" be dated in the past (e.g. a contract modification signed with a retroactive effective date)? Doing so re-prices hours already recorded. | **Allowed.** Before saving, the admin sees how many recorded hours it re-prices; when that number is above zero a **reason is required** and logged (the DR-2 rule). |
| DR-Q2 | Must a charge code's labor category belong to the charge code's own CLIN (and SLIN)? Today nothing checks this, so a code can be priced at another CLIN's rate. (Related: a new code's first category is set through the same schedule as a "correction" of its empty starting category — no reason needed when no hours are re-priced, DR-2.) | **Enforced in the new D3 schedule only:** its category list shows only matching categories and its actions refuse a mismatch; moving a code to another CLIN/SLIN is refused while it has a labor category. Charge-code create is unchanged (its form has no category field — certified-outputs ruling Q3). |

### Lead decisions (engineering, not policy)
| ID | Decision | Why |
|---|---|---|
| DR-1 | The ceiling rate is dated together with the hourly rate (each change row carries both). Ceiling stays display/export only. | Ceilings escalate by option year like rates; one row per change keeps the two from drifting apart. |
| DR-2 | **One reason rule for every change (add, correct, remove; rates and D3 categories):** a reason (1–500 characters) is required whenever the change re-prices recorded hours (impact > 0), optional otherwise; it is stored in the log. | An auditor needs "why" exactly when past costs move; requiring it for zero-impact changes (e.g. a new code's first category) is busywork. |
| DR-3 | Creating a labor category, bulk import and the demo seed set the **starting** rate; creation and import are not "changes" and write no change log row (the seed writes one for its demo change, D1.7). | Matches how every other entity's creation works today. |

---

## 1. Verified current state (file:line, 2026-10-25, `main` at `da73893`)

- `labor_categories` (`src/db/schema.ts:172-185`): one `hourly_rate varchar(20) NOT NULL DEFAULT '0.00'` and one
  `ceiling_rate varchar(20) NULL`; a category belongs to a CLIN and optionally a SLIN. `validateRate`
  (`src/lib/validation.ts:96-109`) returns `num.toFixed(2)` and throws `UserFacingError`. **Not every stored rate went
  through it:** bulk import writes `row.hourlyRate?.trim() || '0.00'` unvalidated (`src/server/actions/import.ts:242-243`).
- `user_labor_categories` (`schema.ts:191-202`) is already dated. Not changed.
- `charge_codes.labor_category_id` (`schema.ts:233`, nullable, `ON DELETE SET NULL`); set by `updateChargeCode`
  (`charge-codes.ts:98`) and `createChargeCodeInternal` (`src/server/internal/charge-codes.ts:24,37`) with no CLIN check;
  the charge-code form has no category field (`ChargeCodesClient.tsx:269-299`).
- **Rate writers:** `createLaborCategory` / `updateLaborCategory` (`src/server/actions/labor-categories.ts:65-87`,
  `:92-115` — the update overwrites rates in place, silently re-pricing all history), bulk import (above),
  `scripts/seed-full.ts:139-157` (e.g. NAV-01 `SE-III` = `145.00` / ceiling `160.00`).
- **Rate readers:** today 5 cost queries; certified outputs C3 replaces all of them with `cost-basis.ts`. Displays:
  `LaborCategoriesClient.tsx:370-378, 445-447, 607`; `DashboardClient.tsx:276`; cost CSV/XLSX "Rate ($/hr)"
  (`cost-report-csv/route.ts:41`, `cost-report-excel.ts:56`); **public API** `/api/v1/costs` returns `hourlyRate` per
  entry (via `getDetailedCostReportData`). After this plan that field is the rate in effect on the entry's date.
- `timesheet_entries.hours` is `varchar` (`schema.ts:271`); `saveTimesheetBatch` refuses future dates
  (`timesheet.ts:252`).
- `ReadDb` has no `execute` (`src/db/index.ts:17`); use the select builder.
- Labor categories, CLINs and SLINs are never hard-deleted by the app; `clearTenantData` deletes charge codes
  (`clear-tenant-data.ts:21`) then labor categories (`:25`).
- Tests that pin the action set or constraint list and **will need updating**: `unit/fresh-admin-writes.test.ts:101`
  (`toHaveLength(N)` — raise by the new **mutations** only: 3 in D1, 3 in D3; the preview reads are not admin writes), `unit/import-duplicate-errors.test.ts:82-85` (exact
  `DUPLICATE_ENTITY_MESSAGES` keys), `integration/fresh-admin-writes.test.ts`, `unit/guard-first-oracle.test.ts`,
  `unit/server-action-guards.test.ts`, `unit/action-results-static.test.ts`, `unit/sql-template-params.test.ts`,
  `unit/export-allowlists.test.ts`, the seeder test, and certified outputs' tests for `updateChargeCode`'s
  labor-category logging (C3).
- Validators to reuse: `validateUUID` (`validation.ts:117-123`, "… is not a valid identifier."),
  `validateOptionalCalendarDate` (`:141-147`, "… is not a valid date."), `validateRequired`, `validateStringLength`
  (requires a string — call `validateRequired` first). `parseCalendarDate` throws a **plain** `Error` — never use it
  on user input.
- Workspace timezone default `America/New_York` (`schema.ts:506`). Calendar helpers: `compare`, `addMonths`,
  `startOfMonth`, `todayIn`, `formatCalendarDate` (`src/lib/calendar-date.ts`).

## 2. Verified external facts

| Fact | Source |
|---|---|
| drizzle's postgres-js driver replaces the date/timestamp serializers with a pass-through; a JS `Date` inside a `sql` template crashes at runtime but passes integration tests | `node_modules/drizzle-orm/postgres-js/driver.js:16-19`; LAUNCH-BLOCKERS-AUDIT §11 |
| `sql` templates inline a nested `SQL` object as SQL text (not a parameter); drizzle operators (`eq`, `gte`, `lt`) send values through the column's encoder | drizzle 0.45 `sql` / operators |
| `unit/sql-template-params.test.ts` accepts in a `${…}` only: an exported `table.column`, `<expr>.toISOString()` followed by `::timestamptz`/`::date`, a nested `sql` fragment, or an allowlist entry keyed by exact `(file, expr)` | that test (`sqlParamViolations`) |
| `SELECT … FOR NO KEY UPDATE` locks the row against other writers but, unlike `FOR UPDATE`, doesn't block the `KEY SHARE` locks that FK inserts take | Postgres docs, "Row-Level Locks" |
| A unique violation arrives wrapped (`err.cause.code === '23505'`, `err.cause.constraint_name`); `DUPLICATE_ENTITY_MESSAGES` values are static strings | `src/lib/db-errors.ts` |
| `SUM(CAST(varchar AS NUMERIC))` keeps the scale of the stored strings (`'8'` → `8`, `'8.00'` → `8.00`); `hours × rate` of scale 2 × 2 yields scale 4 (`800.0000`) | Postgres numeric arithmetic |

---

## 3. Invariants

- **One rule, one implementation each side.** The rate of labor category L on day D is computed only by
  `hourlyRateOnSql` (SQL) and `rateOn` (TS); an integration test proves they agree. No other code reads a rate column
  (static test, §9 "Static (rates)").
- Rate of L on D = `hourly_rate` of the **latest** `labor_category_rates` row for L with `effective_date <= D`, else
  `labor_categories.hourly_rate` (the **starting rate**). Inclusive on the effective date. No end dates → no overlaps
  or gaps.
- Costs are computed at read time; nothing stores a cost.
- Every rate **change** made through the app (add, correct, remove — D1.5; D3's equivalents) writes exactly one
  `admin_change_log` row in the same transaction. Creation/import set starting values and aren't changes (DR-3).
- Unpriced entries stay unpriced; the builder yields NULL for a NULL category, and NULL costs add nothing to a `SUM`.
- Security: each new action is `userAction(async () => { await requireAdminFresh(); … })` — the guard is the first
  await. Expected failures are `UserFacingError` / `ConflictError` with the exact messages in §4.
- Calendar dates are `CalendarDate` strings; "today" for displays is the workspace today from the server.
- DCAA data untouched; no new route segment config; no new external calls.

---

## 4. Design

### D1.1 Schema + migration (tenant; next free number, expected `0015`, generated by drizzle-kit)

In `src/db/schema.ts`, directly after `laborCategories`:

```ts
// Dated rate changes (feature-plan-dated-rates.md). labor_categories.hourly_rate / ceiling_rate are the STARTING
// rate (days before the first change). Rate on day D = latest change with effective_date <= D, else the starting
// rate. No end dates by design: periods can't overlap or leave gaps.
export const laborCategoryRates = pgTable('labor_category_rates', {
  id: uuid('id').defaultRandom().primaryKey(),
  laborCategoryId: uuid('labor_category_id').notNull().references(() => laborCategories.id, { onDelete: 'cascade' }),
  effectiveDate: date('effective_date', { mode: 'string' }).notNull(),
  hourlyRate: varchar('hourly_rate', { length: 20 }).notNull(),  // validateRate format, same type as the starting rate
  ceilingRate: varchar('ceiling_rate', { length: 20 }),           // null = no ceiling in this period
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('lcat_rate_effective_unique_idx').on(table.laborCategoryId, table.effectiveDate),
]);
```

`npx drizzle-kit generate` (tenant config). The SQL must contain only the `CREATE TABLE`, its FKs and the unique
index; `db:safety` passes. **No backfill** — with no rows every rate equals today's value, so deploying D1 changes no
number. If another tenant migration merges before yours, delete yours and regenerate so its journal `when` is newest
(the migrator orders by it, `src/lib/tenant/migrate-tenant.ts:57-81`).

### D1.2 Pure rule — `src/lib/labor-rates.ts` (new; client-safe, no `server-only`)

```ts
import { compare, type CalendarDate } from '@/lib/calendar-date';

export interface RatePeriodValues { hourlyRate: string; ceilingRate: string | null }
export interface RateChange extends RatePeriodValues { id: string; effectiveDate: CalendarDate }
export interface RateSchedule { starting: RatePeriodValues; changes: RateChange[] } // changes in ANY order
export type RatePeriodRef = 'starting' | string;                                     // 'starting' or a change id

export function rateOn(s: RateSchedule, day: CalendarDate): RatePeriodValues & { source: RatePeriodRef } {
  let best: RateChange | null = null;
  for (const c of s.changes) {
    if (compare(c.effectiveDate, day) <= 0 && (best === null || compare(c.effectiveDate, best.effectiveDate) > 0)) best = c;
  }
  return best ? { hourlyRate: best.hourlyRate, ceilingRate: best.ceilingRate, source: best.id } : { ...s.starting, source: 'starting' };
}

export function periodBounds(s: RateSchedule, ref: RatePeriodRef): { from: CalendarDate | null; toExclusive: CalendarDate | null } {
  const sorted = [...s.changes].sort((a, b) => compare(a.effectiveDate, b.effectiveDate));
  if (ref === 'starting') return { from: null, toExclusive: sorted[0]?.effectiveDate ?? null };
  const i = sorted.findIndex((c) => c.id === ref);
  if (i < 0) throw new Error(`periodBounds: unknown change ${ref}`); // programming error only
  return { from: sorted[i].effectiveDate, toExclusive: sorted[i + 1]?.effectiveDate ?? null };
}

/** Rates compared as numbers (stored values may be '145' or '145.00'); unparseable values never compare equal. */
export function sameRate(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const x = Number(a), y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && x.toFixed(2) === y.toFixed(2);
}

/** Main-table display (D2), pure so it is unit-testable: current values and the next later change, if any. */
export function rateDisplay(s: RateSchedule, today: CalendarDate): { current: RatePeriodValues; next: RateChange | null } {
  const { source: _source, ...current } = rateOn(s, today);
  let next: RateChange | null = null;
  for (const c of s.changes) {
    if (compare(c.effectiveDate, today) > 0 && (next === null || compare(c.effectiveDate, next.effectiveDate) < 0)) next = c;
  }
  return { current, next };
}

/** Reason input: null / undefined / blank after trim → null (no reason); otherwise
 *  validateStringLength(validateRequired(reason, 'Reason'), 'Reason', 1, 500). Pure; lives here, NOT in the 'use server'
 *  file (a sync export there breaks the build and the guard test). */
export function normalizeReason(reason: unknown): string | null { /* as documented above */ }

// Action inputs/outputs (client imports these types)
export interface AddRateChangeInput { laborCategoryId: string; effectiveDate: string; hourlyRate: string; ceilingRate: string | null; reason?: string }
export interface CorrectRateInput { laborCategoryId: string; target: RatePeriodRef; hourlyRate: string; ceilingRate: string | null; reason?: string }
export interface RemoveRateChangeInput { laborCategoryId: string; changeId: string; reason?: string }
export type RateImpactInput = ({ kind: 'add' } & AddRateChangeInput) | ({ kind: 'correct' } & CorrectRateInput) | ({ kind: 'remove' } & RemoveRateChangeInput);
export interface RateImpact { hours: string /* 2 decimals, e.g. '12.00' */; from: CalendarDate | null; toExclusive: CalendarDate | null; reasonRequired: boolean /* hours > 0 */ }
export interface RateScheduleView extends RateSchedule { laborCategoryId: string }
```

No floats beyond `sameRate`'s comparison, no `Date`, no money arithmetic.

### D1.3 SQL rule — `src/server/internal/labor-rates.ts` (new, `import 'server-only'`)

```ts
import 'server-only';
import { sql, type SQL } from 'drizzle-orm';

/** Hourly rate (NUMERIC) of a category on a day; NULL when the category is NULL. The ONLY SQL rate rule.
 *  Arguments are SQL FRAGMENTS (e.g. sql`${laborCategories.id}`), typed `SQL` so a value can't be passed. */
export function hourlyRateOnSql(args: { laborCategoryId: SQL; onDate: SQL }): SQL<string> {
  const { laborCategoryId, onDate } = args;
  return sql<string>`CAST(COALESCE(
    (SELECT r.hourly_rate FROM labor_category_rates r
      WHERE r.labor_category_id = ${laborCategoryId} AND r.effective_date <= ${onDate}
      ORDER BY r.effective_date DESC LIMIT 1),
    (SELECT lc0.hourly_rate FROM labor_categories lc0 WHERE lc0.id = ${laborCategoryId})
  ) AS NUMERIC)`;
}
```

Both `COALESCE` arguments are `varchar`; the single cast is outside (T6). Add to the `sql-template-params` allowlist:
`{ file: 'src/server/internal/labor-rates.ts', expr: 'laborCategoryId' }` and `{ …, expr: 'onDate' }` (D3 adds
`chargeCodeId`), justification "typed `SQL` fragment parameter — the type forbids values". If `cost-basis.ts` stores the
builder's result in a const and interpolates it into another `sql` template, add `(cost-basis.ts, '<that const>')` with
the justification "SQL fragment from hourlyRateOnSql".

### D1.4 Pricing — `src/server/internal/cost-basis.ts` (from certified outputs C3)

**Known shape of the real `cost-basis.ts` (certified-outputs audit, 2026-10-25 — confirm at hand-off):** the category
is resolved inside a `LEFT JOIN LATERAL (… CASE …) cost_basis` and joined as `cost_lc`; the rate is read in **several**
places — `pricedCostSum` uses raw `"cost_lc"."hourly_rate"` (`cost-basis.ts:94`), `costBasisFields.hourlyRate` (`:89`)
feeds `reports.ts:91`, and `dashboard.ts:347,385` select **and GROUP BY** `cost_lc.hourly_rate`. So: (1) compute
`applied_rate` **inside** the lateral with `hourlyRateOnSql` — the category id is chosen by a `CASE` in the same
`SELECT`, so wrap it one level deeper (select the resolved id in an inner subquery, apply the builder in the outer one)
rather than repeating the `CASE`; (2) replace every `cost_lc.hourly_rate` read with `cost_basis.applied_rate`, and group
by `cost_basis.applied_rate`; (3) the latest-revision predicate is copied ~9 times — export it from `cost-basis.ts` as
one fragment and use it in `pricedHoursFor`; (4) extend the §9 rate-column static test to also flag
`costLaborCategory.hourlyRate` (and any `\w+LaborCategory\.hourlyRate`) outside the allowed files.

- Wherever `cost-basis.ts` turns the resolved category into a rate, use
  `hourlyRateOnSql({ laborCategoryId: <resolved category id fragment>, onDate: <the entry's entry_date fragment> })`.
  `cost-basis.ts` then never mentions `hourly_rate` (the static test enforces it).
- Fragments are passed as `sql\`${table.column}\`` for real tables. If C3 built the resolution on a drizzle `alias()`
  or subquery, `${alias.column}` isn't an exported table and the `sql-template-params` test will name it — add that
  exact `(cost-basis.ts, expr)` to its allowlist with the justification "column of the per-entry resolution subquery".
- The per-entry output gains `appliedRate` (string). **Group by rate only over the per-entry result** (a derived
  table/subquery that already carries `applied_rate`), never by re-evaluating the builder in `GROUP BY`. A category
  whose rate changed inside a range therefore shows one row per rate — correct and expected.
- Add, in `cost-basis.ts` next to its per-entry resolution, `pricedHoursFor(db: ReadDb | DbTx, laborCategoryId: string,
  from: CalendarDate | null, toExclusive: CalendarDate | null): Promise<string>`: one select over the per-entry result,
  filters with drizzle operators only — `eq(<resolved id>, laborCategoryId)`, `gte(<entry date>, from)` when `from`,
  `lt(<entry date>, toExclusive)` when `toExclusive` — selecting
  `sql<string>\`CAST(ROUND(COALESCE(SUM(CAST(${<hours>} AS NUMERIC)), 0), 2) AS NUMERIC(12,2))::text\`` (always two
  decimals, e.g. `'12.00'`). Values never appear inside `sql` (T1).
- If `cost-basis.ts`'s structure makes any of this impossible, **stop and report** with file:line.

### D1.5 Rate actions — `src/server/actions/labor-category-rates.ts` (new, `'use server'`)

Every mutation follows this skeleton exactly:

```ts
export async function addLaborCategoryRateChange(input: AddRateChangeInput): Promise<ActionResult<RateScheduleView>> {
  return userAction(async () => {
    const actor = await requireAdminFresh();                 // 1. FIRST await (launch-blockers A1)
    const v = validateAddInput(input);                       // 2. pure validation, before any transaction
    const db = await getDbForWrite();                        // 3. write gate (read_only workspace → read_only)
    return db.transaction(async (tx) => {
      const schedule = await lockAndReadSchedule(tx, v.laborCategoryId);  // 4. FOR NO KEY UPDATE on L; not_found
      // 5. state checks → 6. write (check .returning() is non-empty) → 7. log via the certified-outputs writer → 8. return
      return { laborCategoryId: v.laborCategoryId, ...(await readRateSchedule(tx, v.laborCategoryId)) };
    });
  });
}
```

Internal helpers in `src/server/internal/labor-rates.ts` (take a client, never call `getDb*`): `lockAndReadSchedule(tx,
id)` (`select … from labor_categories where id = $1 .for('no key update')`, then the changes; casts each
`effectiveDate` to `CalendarDate`), `readRateSchedule(db: ReadDb | DbTx, id)` (also used by the preview, which has no
transaction). Pure validators (`validateAddInput`, …) live in `src/lib/labor-rates.ts` or the internal module — never as
sync exports of the `'use server'` file. Logging: **the existing `admin_change_log` writer from
certified outputs, passed `tx`** — never a second writer (if none exists, stop and report).

**Validation (pure, step 2):** ids → `validateUUID(id, 'Labor category')` / `validateUUID(id, 'Rate period')`;
`effectiveDate` → new `validateCalendarDate(value, 'Effective date')` in `validation.ts` (`isCalendarDate` or
`UserFacingError('Effective date is not a valid date.')`, matching `validateOptionalCalendarDate`); `hourlyRate` →
`validateRate(v, 'Hourly rate')`; `ceilingRate` → `null`/`''` → `null`, else `validateRate(v, 'Ceiling rate')`;
`reason` → `normalizeReason` (`null`/`undefined`/blank after trim = no reason; otherwise 1–500). The preview
validates ids, date and rates only and ignores `reason`.

**State checks and messages (step 5; run in this table's order, first failure wins; exact strings):**

| Check | Error |
|---|---|
| category missing | `UserFacingError('Labor category not found.', 'not_found')` |
| correct/remove: target isn't `'starting'` or a change of **this** L | `UserFacingError('That rate period no longer exists. Refresh and try again.', 'not_found')` |
| add: a change already on that date (pre-check under the lock) | `ConflictError(\`There is already a rate change on ${date} for this labor category. Correct that one instead.\`)` |
| add: same date raced past the pre-check (unique index) | via `DUPLICATE_ENTITY_MESSAGES['lcat_rate_effective_unique_idx']` = `'There is already a rate change on that date for this labor category. Correct that one instead.'` (static; deliberately different wording — the §9 concurrency row relies on it) |
| add: values equal those in effect on that date (`sameRate` on both) | `UserFacingError(\`That is already the rate in effect on ${date}.\`)` |
| correct: values unchanged (`sameRate` on both) | `UserFacingError('Nothing to correct — the values are unchanged.')` |
| any action: its re-priced hours (`pricedHoursFor(tx, L, …)` over the period it affects — add: `[D, next change after D)`, correct: `periodBounds(target)`, remove: `periodBounds(changeId)`) > 0 and no reason (DR-2) | `UserFacingError('A reason is required because this change re-prices recorded hours.')` |
| write `.returning()` empty | the not_found period message above |

`${date}` is the `YYYY-MM-DD` string as validated.

**Writes and log rows** (`entity = 'labor_category_rate'`, `entity_id = L`):

| Action | Write | `action` | `old_value` | `new_value` |
|---|---|---|---|---|
| `addLaborCategoryRateChange` | insert change (`createdBy` = actor) | `rate_change_added` | `{ source, hourlyRate, ceilingRate }` = `rateOn(schedule, D)` before the insert | `{ effectiveDate, hourlyRate, ceilingRate, reason, repricedHours }` |
| `correctLaborCategoryRate` | update the starting rate (`labor_categories`) or the change row; set `updated_at` | `rate_corrected` | `{ target, hourlyRate, ceilingRate }` | `{ target, hourlyRate, ceilingRate, reason, period: periodBounds(target), repricedHours }` (`reason` is null when `repricedHours` is `'0.00'` and none was given) |
| `removeLaborCategoryRateChange` | delete the change row | `rate_change_removed` | the removed row's values + `effectiveDate` | `{ reason, repricedHours }` |

`previewRateChangeImpact(input: RateImpactInput): Promise<ActionResult<RateImpact>>` — `userAction` +
`requireAdminFresh` first, validation of ids/date/rates only (no reason), no lock, no transaction, read client: add → `[D, next change after D)`,
correct → `periodBounds(target)`, remove → `periodBounds(changeId)`; `hours = pricedHoursFor(...)`, `reasonRequired = Number(hours) > 0`. Same not_found rules.

Add `lcat_rate_effective_unique_idx` to `DUPLICATE_ENTITY_MESSAGES` (and to the key list in
`import-duplicate-errors.test.ts`). The name must equal the index name drizzle-kit wrote into the migration — the §9
"Duplicate mapping" row proves it against the real database.

### D1.6 Supporting changes
- `updateLaborCategory`: remove `hourlyRate` and `ceilingRate` from its input type and body. Rates change only via D1.5.
  `createLaborCategory` keeps them (starting rate).
- `bulkImportLaborCategories` (`import.ts:208-243`): validate `hourlyRate` with `validateRate` and `ceilingRate` with
  the optional rule; an invalid value is a row error (the validator's message). **Behavior change, intended:** a blank hourly rate used to
  become `'0.00'` and is now a row error; a whitespace-only ceiling is treated as blank (null). Fixes stored values like `'$145'` that would make every pricing query fail on the cast.
- `getAllLaborCategories`: also returns each category's `rateChanges: RateChange[]` (one extra query on
  `labor_category_rates`, grouped in TS).
- `LaborCategoriesClient.tsx`: the edit modal stops sending rates and hides those fields when editing; create shows
  "Starting hourly rate" / "Starting ceiling rate".
- Export (`allowlists.ts`): add `labor_category_rates` with descriptions — `id` "Rate change id.",
  `labor_category_id` "The labor category (labor_categories.csv id).", `effective_date` "First day this rate applies
  (inclusive); it applies until the next change.", `hourly_rate` "Hourly rate from effective_date.", `ceiling_rate`
  "Ceiling rate from effective_date (blank = none).", `created_by` "User who added the change (users.csv id).",
  `created_at` / `updated_at` "When the row was created / last corrected (UTC)." Change `labor_categories.hourly_rate`
  / `ceiling_rate` descriptions to "Starting rate — applies to days before the first change in labor_category_rates.csv."
- `clearTenantData`: `delete(laborCategoryRates)` before `delete(laborCategories)`.

### D1.7 Seed (`scripts/seed-full.ts`)
After the labor categories are inserted: NAV-01 `SE-III` (starting `145.00` / `160.00`) gets one change, effective
`addMonths(startOfMonth(todayIn('America/New_York')), -2)`, hourly `'149.35'`, ceiling `'164.80'` (hard-coded strings —
no arithmetic), `createdBy` = the seeded admin, plus its matching `admin_change_log` row. Write it the same way certified outputs'
seed handles `recomputeSelfApproval`; if the writer can't be imported from a `tsx` script (`server-only`, branded
`DbTx`), insert into `schema.adminChangeLog` directly (scripts are exempt — certified-outputs ruling Q5):
`entity 'labor_category_rate'`, `entity_id` = the category, `action 'rate_change_added'`, `old_value`
`{ source: 'starting', hourlyRate: '145.00', ceilingRate: '160.00' }`, `new_value` `{ effectiveDate, hourlyRate:
'149.35', ceilingRate: '164.80', reason: 'Demo: option-year escalation', repricedHours: null }`, actor = the seeded
admin. Do **not** import `getWorkspaceToday` or anything under `src/server/internal/` (server-only).

### D2 — Rate schedule UI and displays
- **Main table:** Hourly / Ceiling show `rateDisplay(schedule, today).current` formatted with the page's existing
  `formatRate` (e.g. `$110.00`); when `next` exists, a dimmed second line `→ $120.00 from Apr 1, 2027`
  (`formatCalendarDate(next.effectiveDate, 'MMM D, YYYY')`). `today` = `getWorkspaceToday()` in `page.tsx`, passed as a
  prop. The assignments table (`:445-447`) and the assignment dropdown label (`:607`) show the current rate of the
  assigned category, found by `laborCategoryId` in the same `laborCats` state. Drop `hourlyRate` from the selects of
  `getUserLaborCategoryAssignments` (`labor-categories.ts:154`) and `getAssignableLaborCategories` (`:221`) and from
  `UserLcatAssignment`, so nothing can show a starting rate as the current one.
- **Row action "Rates"** (`useCanWrite` rules) opens `RateScheduleModal.tsx` (new, same folder):
  - table: "From the start", then changes ascending; columns From · Hourly · Ceiling · **Correct** (all) · **Remove**
    (changes only).
  - "Add a rate change": Effective date, Hourly, Ceiling — prefilled from `rateOn(schedule, date)` when the date
    changes. **Preview** → `previewRateChangeImpact`; shows "This changes the cost of {hours} recorded hours ({from} –
    {to})." or "No recorded hours are affected." When `reasonRequired`: a Reason field (required) and a checkbox "I understand
    past costs will change" must be filled before **Add** enables. **A change to a value field (effective date, hourly,
    ceiling; D3: category, target) clears the preview, the reason gate and the checkbox; typing the reason does not.**
  - Correct / Remove: same Preview → (Reason + checkbox when `reasonRequired`) rule.
  - All calls via `runAction`. On `ok`: replace the modal's schedule **and merge the returned `RateScheduleView` into the
    page's `laborCats` state with `setLaborCats`** (so the main table updates — `router.refresh()` alone doesn't reset
    that state). On failure: show `r.error`, keep the form.
- **Wording:** every "Costs use current labor-category rates." becomes "Costs use the labor-category rate in effect on
  each day worked." Static test scans `src/` excluding `src/__tests__/` for the old sentence (build the needle by
  concatenation so the test file can't match itself).
- **API key dialog text:** note that `/api/v1/costs` `hourlyRate` is the rate in effect on each entry's date.

### D3 — Charge codes: dated labor category
- Migration (its own, generated after D1's): `charge_code_labor_categories` — `id`, `charge_code_id` (FK cascade),
  `effective_date date NOT NULL`, `labor_category_id uuid NOT NULL` (FK, default NO ACTION — never `SET NULL`),
  `created_by`, timestamps, unique `(charge_code_id, effective_date)` named `cc_lcat_effective_unique_idx`.
  `charge_codes.labor_category_id` is the **starting** category (may be null); a dated change always names a category.
- SQL rule next to `hourlyRateOnSql`: `chargeCodeLaborCategoryOnSql({ chargeCodeId, onDate })` =
  `COALESCE((SELECT c.labor_category_id FROM charge_code_labor_categories c WHERE c.charge_code_id = ${chargeCodeId}
  AND c.effective_date <= ${onDate} ORDER BY c.effective_date DESC LIMIT 1), (SELECT cc0.labor_category_id FROM
  charge_codes cc0 WHERE cc0.id = ${chargeCodeId}))`. `cost-basis.ts` step 1 uses it instead of
  `charge_codes.labor_category_id`. Allowlist entry `(labor-rates.ts, 'chargeCodeId')`. Pure twin
  `chargeCodeCategoryOn(schedule, day)` in `src/lib/labor-rates.ts`, agreement test.
- Actions (`src/server/actions/charge-code-categories.ts`): `addChargeCodeCategoryChange`, `correctChargeCodeCategory`
  (target `'starting'` — which **may** be corrected to `null` — or a change id; a change's category can't be null),
  `removeChargeCodeCategoryChange`, `previewChargeCodeCategoryImpact`. Same skeleton as D1.5; lock the **charge code**
  row `.for('no key update')`; log `entity = 'charge_code_labor_category'`, `entity_id` = charge code id, actions
  `category_change_added` / `category_corrected` / `category_change_removed`, JSON `{ target, effectiveDate,
  laborCategoryId, reason, period, repricedHours }` like D1.5. Messages: D1.5's with "category" for "rate" (e.g.
  "There is already a category change on {date} for this charge code. Correct that one instead."; static duplicate:
  "There is already a category change on that date for this charge code. Correct that one instead."). Category id
  validation, in order, before DR-Q2: `validateUUID(id, 'Labor category')`; an existence read →
  `UserFacingError('Labor category not found.', 'not_found')`; `null` on a dated change →
  `UserFacingError('A dated change must name a labor category.')`. Add `cc_lcat_effective_unique_idx` to
  `DUPLICATE_ENTITY_MESSAGES` and the key list. Log `old_value` = `{ target, laborCategoryId }` before, `new_value` =
  `{ target, effectiveDate, laborCategoryId, reason, period, repricedHours }`. The impact query (latest-revision hours on
  this charge code in a period) lives in `cost-basis.ts` next to `pricedHoursFor` as `pricedHoursForChargeCode`, same
  rounding. Pure twin's schedule type: `{ starting: string | null; changes: { id: string; effectiveDate: CalendarDate;
  laborCategoryId: string }[] }`. Impact = latest-
  revision hours on this charge code in the period (2 decimals). DR-Q2 default: a category whose `clin_id` ≠ the code's,
  or whose SLIN ≠ the code's SLIN when both are set → `UserFacingError('That labor category belongs to a different CLIN
  or SLIN than this charge code.')`.
- `updateChargeCode`: **stops accepting `laborCategoryId`** (remove from type and body; certified outputs' logging of it
  moves into these actions — rewrite those C3 tests to target the new actions). DR-Q2 default: a CLIN or SLIN change is
  refused while the code has a starting category or any dated change: `UserFacingError("Remove this charge code's
  labor categories before moving it to another CLIN or SLIN.")`. `createChargeCode` / `createChargeCodeInternal`
  unchanged.
- UI: Charge Codes row action "Labor category" → `ChargeCodeCategoryModal.tsx`, same structure as `RateScheduleModal`,
  both rendering the shared `src/components/admin/EffectiveDatedTable.tsx` (presentational: rows + caller-supplied value
  cells and action buttons). Options: only categories passing DR-Q2. Same preview/reason/checkbox/merge rules.
- Export: add `charge_code_labor_categories` with column descriptions in the D1.6 style, and reword
  `charge_codes.labor_category_id` (`allowlists.ts:145`) to "Starting labor category — applies to days before the first
  change in charge_code_labor_categories.csv (labor_categories.csv id), if any." `clearTenantData`: nothing
  (charge-code deletion cascades to it, and charge codes are deleted before labor categories).

---

## 5. State tables

### Rate schedule of one labor category (all writes hold `FOR NO KEY UPDATE` on the category row)
| Current | Event | Result | Side effects |
|---|---|---|---|
| any | add on D (no change on D; values differ from those in effect on D; reason given if it re-prices hours) | change inserted | log `rate_change_added`; hours in `[D, next)` re-priced |
| any | add on D, a change on D exists | unchanged | date-specific `ConflictError` |
| any | add on D raced past the pre-check | unchanged | static duplicate message (unique index) |
| any | add with the values already in effect on D | unchanged | "already the rate…" |
| any | add re-pricing > 0 hours without a reason | unchanged | "A reason is required…" |
| any | correct starting | starting values updated | log `rate_corrected`; hours before the first change re-priced |
| has X | correct X | X updated | log; X's period re-priced |
| has X | remove X | X deleted | log `rate_change_removed`; X's period priced by the previous period |
| any | correct/remove a period that isn't this category's, or is already gone | unchanged | not_found message |
| any | correct with identical values | unchanged | "Nothing to correct…" |
| — | category id doesn't exist | unchanged | "Labor category not found." |
| any | remove the starting rate | can't happen — no action exists | — |
| any | category inactive | changes allowed | same as active (history pricing) |
| any | workspace not `full` | unchanged | `read_only` from `getDbForWrite` (after the guard) |
| any | signed out / demoted admin | unchanged | `unauthenticated` / `forbidden`, before any query |

D3's table is identical with "category" for "values", the DR-Q2 refusal, `null` allowed only for the starting
category, and the charge-code row as the lock.

## 6. Failure modes

| Failure | Behavior |
|---|---|
| Two adds for the same category and date at once | the lock serializes them; the second hits the pre-check (`conflict`, date-specific message). Without the lock the unique index would still refuse (static message) |
| Correct and remove of the same change race | serialized; the second gets not_found (pre-check or empty `.returning()`) |
| Preview shown, schedule changed by someone else before saving | the save re-validates under the lock and returns the real schedule |
| DB error mid-action | transaction rolls back: no change without its log row, no log row without its change |
| Timesheet saved while a rate changes / report read meanwhile | no interaction (cost computed at read time; one statement = one snapshot) |
| Old code running after the migration (deploy window) | ignores the new table; starting rates equal today's rates until the new UI exists. Deploy right after migrating |
| **Rolling the app back past D1 after dated changes exist** | old code prices everything at starting rates — silently re-prices. Runbook: never roll back past D1 once a dated change exists; fix forward |
| Another tenant migration merged first | regenerate yours (D1.1) |
| Legacy stored rate like `'145'` | prices correctly (cast), compares correctly (`sameRate`); invalid legacy strings are prevented going forward by the import fix |

## 7. Platform limits

Per priced entry: two index probes (rate lookup + starting rate), served by `lcat_rate_effective_unique_idx` and the
primary key. Report rows split only where a rate changed inside the range. No new routes, segment config, or external
calls.

## 8. Blast radius

**D1:** `src/db/schema.ts` + migration; `src/lib/labor-rates.ts`, `src/server/internal/labor-rates.ts`,
`src/server/actions/labor-category-rates.ts` (new); `src/server/internal/cost-basis.ts`;
`src/server/actions/labor-categories.ts`; `src/server/actions/import.ts`; `src/lib/validation.ts`;
`src/lib/db-errors.ts`; `src/lib/export/allowlists.ts`; `src/db/clear-tenant-data.ts`; `scripts/seed-full.ts`;
`LaborCategoriesClient.tsx` (edit modal); tests listed in §1 (counts and key lists updated) plus the new tests in §9.
**D2:** `labor-categories/{page,LaborCategoriesClient,RateScheduleModal}.tsx`; every file with the old footer
sentence; the API key dialog text. **D3:** schema + migration; `src/server/actions/charge-code-categories.ts` (new);
`charge-codes.ts`; `cost-basis.ts` step 1; `src/lib/labor-rates.ts`; `src/components/admin/EffectiveDatedTable.tsx`,
`ChargeCodeCategoryModal.tsx` (new); `ChargeCodesClient.tsx`; `allowlists.ts`; certified outputs' `updateChargeCode`
category tests (rewritten). If certified outputs' static test "labor tables imported only via `cost-basis.ts`" flags
`server/internal/labor-rates.ts`, `actions/labor-category-rates.ts` or `actions/charge-code-categories.ts`, add them to
its allowlist. **Docs:** `MIGRATIONS.md` (deploy + no-rollback note), export README (generated from `allowlists.ts`).

---

## 9. Required test matrix (each fails without its fix; record a break-it for each)

**Fixture F1** (integration): CLIN `C`; category `L` on `C`, starting hourly `'100.00'`, ceiling `'150.00'`; employee
`E` assigned to `L` from `2026-01-01`; latest-revision entries for `E` on a charge code of `C` with **no** category of
its own, hours stored as `'8.00'`, `'8.00'`, `'4.00'` on `2026-12-31`, `2027-01-01`, `2027-06-30`. Entries are
**inserted directly** with the test DB helpers (`saveTimesheetBatch` refuses future dates). Money assertions compare
`Number(x).toFixed(2)`; hours from `pricedHoursFor` compare as exact strings.

| Area | Scenario | Expected |
|---|---|---|
| Pure | `rateOn` with changes out of order; day before / on / after each change; no changes | exact values + `source`; inclusive on the date |
| Pure | `periodBounds` starting / middle / last; unknown id throws; `sameRate('145','145.00')` true, `('145','$145')` false; `rateDisplay` current + next | exact |
| SQL = TS | F1 + changes `2027-01-01`→`110.00`, `2027-04-01`→`120.00`: `hourlyRateOnSql` vs `rateOn` on 2020-01-01, 2026-12-31, 2027-01-01, 2027-03-31, 2027-04-01, 2030-01-01 | equal on every date |
| Pricing | F1, no changes (per-entry via `getDetailedCostReportData`; grouped via `getPeriodCostReport`) | 800.00 / 800.00 / 400.00, total 2000.00 |
| Pricing | add `2027-01-01` → `110.00` (reason given: it re-prices 12.00 h) | 800.00 / 880.00 / 440.00 = 2120.00; applied rates 100 / 110 / 110 |
| Pricing | then add `2027-04-01` → `120.00` (reason given) | 800.00 / 880.00 / 480.00 = 2160.00 |
| Correction | then correct starting → `105.00`, reason "typo" | 840.00 / 880.00 / 480.00; one log row (old 100.00 → new 105.00, target starting, reason, period, repricedHours `'8.00'`) |
| Correction | then correct `2027-01-01` → `112.00` | 840.00 / 896.00 / 480.00 |
| Removal | then remove `2027-04-01`, reason "wrong date" | 840.00 / 896.00 / 448.00; log row with the removed values |
| Grouping | period cost report 2026-12-01..2027-06-30 after the first add | two rows for E/L: rate 100 (8.00 h), rate 110 (12.00 h) |
| Unpriced | an entry with no resolvable category, changes present | still unpriced, no cost, in the unpriced count |
| Impact | preview add `2027-01-01` on F1 | `{ hours: '12.00', from: '2027-01-01', toExclusive: null }` |
| Impact | preview correct starting (with the `2027-01-01` change) | `{ '8.00', null, '2027-01-01' }` |
| Impact | preview remove `2027-04-01` (both changes present) | `{ '4.00', '2027-04-01', null }` |
| DR-2 | add `2027-01-01` on F1 without a reason; correct starting (impact 8.00 h) without a reason; add a change dated after the last entry (`2028-01-01`, impact 0.00) without a reason | first two: "A reason is required…", nothing written; third: succeeds, log `reason: null` |
| DR-2 (reason input) | add with reason `''` and with `'   '` on a zero-impact date | treated as no reason; succeeds |
| Validation | add on a date with a change; same values (`'110'` vs stored `'110.00'`); `'2027-02-30'`; rate `'-1'`; rate `'abc'`; id `'not-a-uuid'`; reason of 501 characters; correct with identical values; remove another category's change; remove twice | exact §4 messages / codes; nothing written; no log row |
| Concurrency (lock) | **deterministic:** in its own transaction the test takes `SELECT … FOR NO KEY UPDATE` on L **and inserts a `2027-01-01` change**; then starts `addLaborCategoryRateChange` for `2027-01-01` (with a reason); asserts it is still pending after 200 ms; commits | the action returns `conflict` with the **date-specific** message (it waited on the lock, then the pre-check saw the row). Break-it: remove the lock → the action waits on the unique index instead and returns the **static** message → test fails |
| Duplicate mapping | integration: insert a duplicate `(labor_category_id, effective_date)` row directly through the test DB, catch the error, assert `duplicateEntityMessage(err)` equals the static string; same for `cc_lcat_effective_unique_idx` (D3) | equal — proves the map key matches drizzle-kit's real index name |
| Atomicity | mock the certified-outputs log-writer module to throw | no change row; starting rate unchanged. Break-it: write the log after the transaction → test fails |
| Security | each new action: signed out → `unauthenticated`; JWT admin demoted in DB → refused; listed in `fresh-admin-writes` (count raised), `guard-first-oracle` | refused before any query |
| No silent edit | `updateLaborCategory` called with an `hourlyRate` key | stored rate unchanged |
| Import | bulk import row with hourly `'$145'` | row error with the validator message; nothing inserted for that row |
| Static (rates) | outside the allowed files, no match of `/\b(laborCategories|laborCategoryRates)\.(hourlyRate|ceilingRate)\b/` or `/\b(hourly_rate|ceiling_rate)\b/` in `src/` and `scripts/` (excluding `src/__tests__/` and `drizzle/`). Allowed: `src/db/schema.ts`, `src/server/internal/labor-rates.ts`, `src/server/actions/labor-categories.ts`, `src/server/actions/labor-category-rates.ts`, `src/server/actions/import.ts`, `src/lib/export/allowlists.ts`, `scripts/seed-full.ts`, `scripts/report-cost-basis-change.ts` (C3's frozen old join). Fixture referencing a rate column elsewhere → fails | as stated |
| Static (wording) | old footer sentence absent from `src/` (excluding tests) | as stated |
| Display (D2) | `rateDisplay` with today `2027-02-01` → current `110.00`, next `2027-04-01`/`120.00`; today `2026-12-31` → current `100.00`; render test shows `$110.00` and `→ $120.00 from Apr 1, 2027` (today injected, never the real clock) | exact |
| UI (D2) | Add disabled until Preview ran; with `reasonRequired` also until reason + checkbox; changing a value field clears them, typing the reason doesn't; on ok the **main table** shows the new current rate; on failure the error shows and the form stays | as stated |
| Export | new tables exported, every column described | allowlist test passes |
| Seed | `demo:local` twice; NAV-01 SE-III has the change and its log row; seeder test passes | as stated |
| D3 pricing | code `K` on `C`, starting category `L` (100.00); `M` on `C`, starting 90.00; entries on `K`: `2027-01-15` 8.00 h, `2027-03-15` 8.00 h. Add `K`→`M` from `2027-03-01` (reason given) | 800.00 / 720.00 |
| D3 correction | then correct starting → `M` | 720.00 / 720.00 |
| D3 removal | then remove the `2027-03-01` change | 720.00 / 720.00 (starting is now `M`) |
| D3 starting to none | `E` assigned to `L`; correct `K`'s starting category → `null` with no dated changes (reason given) | `K` entries fall through to `E`'s category: 800.00 / 800.00 |
| D3 first category | a new code with no entries: set its starting category (`correct` from null) without a reason | succeeds (impact 0.00, DR-2) |
| D3 bad category id | `'not-a-uuid'`; a valid uuid that doesn't exist; `null` on a dated change | "Labor category is not a valid identifier." / "Labor category not found." (not_found) / "A dated change must name a labor category."; nothing written |
| D3 SQL = TS | `chargeCodeLaborCategoryOnSql` vs `chargeCodeCategoryOn` on the D3 dates | equal |
| D3 DR-Q2 | add / correct with a category of another CLIN, or a SLIN mismatch; move a code with categories to another CLIN | DR-Q2 messages; nothing written |
| D3 no silent edit | `updateChargeCode` with `laborCategoryId` | category unchanged |
| D3 concurrency / atomicity / security / validation | same rows as D1 against the charge-code actions | same outcomes |

Concurrency tests: per-call `postgres(TEST_DB_URL, { max: 1 })` clients (as `dcaa-concurrency.test.ts:28-36`), closed in
`afterAll`; the `@/lib/session` mock **also stubs `requireAdminFresh` and `requireAdmin`** (the real ones dynamically
import the tenant context — T11).

---

## 10. Verification

```bash
npx tsc --noEmit && npm run lint && npm run test && npm run test:tz && node --import tsx scripts/check-migration-safety.ts
REQUIRE_CONTROL_PLANE_TESTS=1 CONTROL_PLANE_DATABASE_URL="$(grep -h '^CONTROL_PLANE_DATABASE_URL=' .env.local .env 2>/dev/null | head -1 | cut -d= -f2-)" ENCRYPTION_KEY="$(grep -h '^ENCRYPTION_KEY=' .env.local .env 2>/dev/null | head -1 | cut -d= -f2-)" TZ=America/New_York npm run test:integration
npm run build && node scripts/check-build-trace.mjs
npm run demo:local && npm run demo:local
```

Manual (product owner, `npm run dev`, `acme.localhost:3000` as admin):
1. Labor Categories → a category → **Rates**: add a change dated the first of **next** month → Preview: no recorded hours
   affected → Add. Dashboard and cost report unchanged; the table shows "→ $X from …".
2. Add a change dated the first of **last** month → Preview shows hours → reason + tick → Add. Last month's cost report
   shows the new rate from that date and the old one before; the dashboard funding figure moves.
3. Correct the starting rate (reason) → costs before the first change move. Remove a change (reason) → its period falls
   back to the previous rate.
4. NAV-01 SE-III shows the seeded change.
5. Charge Codes → a used code → **Labor category**: a category from another CLIN isn't offered; add a dated change to a
   same-CLIN category → that code's costs from that date use the new category's rate.
6. Reload every touched page — no error screens.

---

## 11. Known traps (each has bitten this codebase)

| # | Trap | Do this | Caught by |
|---|---|---|---|
| T1 | A value (esp. a JS `Date`) inside a `sql` template | values only through drizzle operators (`eq`/`gte`/`lt`); inside `sql` only `table.column`, nested `sql`, the allowlisted builder parameters, or `${d.toISOString()}::date` | `unit/sql-template-params` |
| T2 | Guard after the write gate (anonymous state oracle) | `requireAdminFresh()` is the first await; validation next; `getDbForWrite()` after | `server-action-guards`, `guard-first-oracle` |
| T3 | `parseCalendarDate` / `validateStringLength(undefined)` throw plain errors → "Something went wrong" | `validateCalendarDate`; `validateRequired` before `validateStringLength`; `validateUUID` for ids | Validation rows |
| T4 | Raw DB errors to the client | only `UserFacingError` / `ConflictError`; unique violations via `DUPLICATE_ENTITY_MESSAGES` | Validation + concurrency rows |
| T5 | Concurrency tests on the shared `max: 1` client never race | per-call clients; the deterministic held-lock test | Concurrency rows |
| T6 | `COALESCE(varchar, numeric)` type error | both arguments `varchar`; one cast outside, in the builder | SQL = TS row |
| T7 | Two rate rules drifting | only `rateOn` + `hourlyRateOnSql`; agreement test; rate-column static test | SQL = TS, Static rows |
| T8 | Browser clock for "today" | `today` from `getWorkspaceToday()` on the server; seed uses `todayIn('America/New_York')` | Display, Seed rows |
| T9 | Route segment config from an imported constant | add no route config | `npm run build` |
| T10 | Ignored action results / stale client state | `runAction`; act only on `ok`; merge the returned schedule into `laborCats` | `action-results-static`, UI row |
| T11 | vitest 2.1.9: concurrent dynamic `import()` of a mocked module returns the real one | stub `requireAdminFresh` / `requireAdmin` in the session mock for concurrency tests | Concurrency rows |
| T12 | A second log writer, or logging outside the transaction | reuse certified outputs' writer with `tx` | Atomicity row |
| T13 | Float money / scale surprises | no TS money math; SQL returns strings; assertions use `toFixed(2)`; `pricedHoursFor` rounds to `NUMERIC(12,2)` | Pricing rows |
| T14 | Grouping by a re-evaluated subquery | group over the per-entry result's `applied_rate` column | Grouping row |
| T15 | `.for('update')` blocking FK inserts on related tables | `.for('no key update')` | Concurrency rows |

## 12. Dev-agent hand-off rules

`BLUEPRINT-STANDARD.md` §3 in full. One commit per phase (D1, D2, D3); gates after each; a break-it result for every
§9 row. Start only after certified outputs is merged; first report how D1.4/D1.5 map onto the real `cost-basis.ts` and
the `admin_change_log` writer (file:line) before writing code. Ship DR-Q1/DR-Q2 defaults exactly and list them in the
report. The product owner runs the integration suite, `npm run build`, `demo:local` ×2 and the §10 manual checks
before the PR.
