# Dated rates — implementation report

Blueprint: `feature-plan-dated-rates.md` FINAL v3. Branch `dated-rates`, from local `main` at `130dbcf` (certified
outputs merged in PR #10; not fetched). I read `AGENTS.md`, `BLUEPRINT-STANDARD.md` §3 and the whole blueprint, §11
"Known traps" first.

**Status (2026-10-26):** the stop item below was ruled **option A**, recorded in the blueprint at D1.5, "Ruling (dev
mapping report, 2026-10-26)". The branch was recreated from `main` at `ac65b25`, which includes the sign-out fix. D0
(the single log writer) landed first, then D1–D3; see §6 onward. The original stop report follows unchanged.

**Original status: STOPPED before any code.** D1.4 maps cleanly onto the real `cost-basis.ts`. D1.5's logging rule does not fit:
there is no shared `admin_change_log` writer (§2 below). That is an explicit stop condition in the blueprint (D1.5:
"if none exists, stop and report"), and §9's Atomicity row and trap T12 depend on it. Nothing has been written to the
branch.

Rulings in force:
- none beyond the blueprint;
- DR-Q1 and DR-Q2 ship their stated defaults exactly (§4 below).

---

## 1. D1.4 (pricing) → real `src/server/internal/cost-basis.ts`: fits

The blueprint's "Known shape" holds. The current line numbers are below.

| Blueprint expectation | Real code (file:line) | Plan |
|---|---|---|
| Category resolved in `LEFT JOIN LATERAL (… CASE …) cost_basis` | `COST_BASIS_LATERAL` at `cost-basis.ts:49-76`. The outer `SELECT` (`:50-57`) picks `labor_category_id` with a `CASE` over `c.l1 / c.sole2 / c.sole3`, from the inner derived table `c` (`:58-75`). | Wrap it one level deeper, as D1.4 (1) says: rename the current lateral body to an inner derived table `r` and add an outer `SELECT r.labor_category_id, r.basis, r.level, <APPLIED_RATE> AS applied_rate FROM (…) r`. `APPLIED_RATE = hourlyRateOnSql({ laborCategoryId: sql\`r.labor_category_id\`, onDate: sql\`${timesheetEntries.entryDate}\` })` is a module const, so the `CASE` is never repeated. The lateral keeps exactly one row per entry; the output gains `applied_rate`. |
| Joined as `cost_lc` | `costLaborCategory = alias(laborCategories, 'cost_lc')` `:79`; `COST_LC_ON` `:80` | Kept for code and title only. |
| `pricedCostSum` reads raw `"cost_lc"."hourly_rate"` | `:93-94` | `CAST(hours AS NUMERIC) * cost_basis.applied_rate` (applied_rate is already NUMERIC). |
| `costBasisFields.hourlyRate` feeds `reports.ts` | field `:89`; consumer `src/server/internal/reports.ts:91` (`parseFloat(row.hourlyRate)`), join `:84` | `hourlyRate: sql<string \| null>\`cost_basis.applied_rate\``, plus an explicit `appliedRate` with the same value. `reports.ts` keeps reading `row.hourlyRate`, which is now the rate on the entry's date. |
| `dashboard.ts` selects **and groups by** `cost_lc.hourly_rate` | period report: select `src/server/actions/dashboard.ts:347` (`COALESCE("cost_lc"."hourly_rate", '0')`), GROUP BY `:385` (`costLaborCategory.hourlyRate`); join `:359` | Select `COALESCE(cost_basis.applied_rate, 0)::text`; group by `cost_basis.applied_rate`. That is a column of the per-entry lateral, so the builder is never re-evaluated in `GROUP BY` (T14). Result: one row per rate. |
| Other cost readers | `dashboard.ts:141` (CLIN costs) and `:193` (SLIN costs) use `pricedCostSum` only; `src/server/actions/reports.ts:253` (employee summary) uses `pricedCostSum`; `scripts/report-cost-basis-change.ts:67` uses the lateral + `pricedCostSum` for its "new" column | Nothing to change beyond `pricedCostSum`; these all switch to dated rates automatically. The script's frozen old join (`:48`, `laborCategories.hourlyRate`) stays — it is an allowed file in §9 "Static (rates)". |
| Latest-revision predicate copied "~9 times" | **17 copies in 12 files**. Cost path: `cost-basis.ts:135`, `internal/reports.ts:52`, `actions/reports.ts:170,261`, `dashboard.ts:120,148,172,200,367`, `scripts/report-cost-basis-change.ts:27`. Others: `employee-dashboard.ts:99,183`, `payroll-data.ts:89`, `sync-engine.ts:102`, `workspace-export.ts:179`, `api/v1/timesheets/route.ts:37`, `api/v1/timesheets/approved/route.ts:93`. | D1.4 (3): export one fragment `LATEST_REVISION` from `cost-basis.ts` and use it in `pricedHoursFor` and in `unpricedEntries` (`:134-138`, the in-file copy). The other 16 copies stay as they are: replacing them isn't in D1.4's scope (blast radius §8 doesn't list those files). Flagged for the lead. |
| `pricedHoursFor(db: ReadDb \| DbTx, …)` | `ReadDb` is `Omit<TenantDb, … 'execute'>` (`src/db/index.ts:17`); `DbTx` `:20` | One `select` from `timesheet_entries` `.leftJoinLateral(COST_BASIS_LATERAL)`, with `LATEST_REVISION` and drizzle operators only: `eq(sql\`cost_basis.labor_category_id\`, id)`, `gte` / `lt` on `timesheetEntries.entryDate`. It selects the `NUMERIC(12,2)::text` sum. No values inside `sql` (T1). |
| Allowlist entries for `sql-template-params` | — | `(labor-rates.ts, 'laborCategoryId')`, `(labor-rates.ts, 'onDate')`, `(cost-basis.ts, 'APPLIED_RATE')` ("SQL fragment from hourlyRateOnSql"). `sql\`r.labor_category_id\`` is a plain nested fragment with no interpolation. |
| Static rate-column test | — | The §9 regexes, plus D1.4 (4) `\b\w+LaborCategory\.hourlyRate\b`. After the change, `cost-basis.ts` contains neither `hourly_rate` nor `costLaborCategory.hourlyRate`. |
| Unpriced stays unpriced | — | A NULL `r.labor_category_id` → both subqueries return no row → `applied_rate` NULL → priced sums use `basis = 'priced'`, unchanged. |

Lock strength: drizzle 0.45 supports `.for('no key update')` (`node_modules/drizzle-orm/pg-core/query-builders/select.types.d.ts:60`).

## 2. D1.5 (rate actions) → the `admin_change_log` writer: does NOT fit (stop item)

**What the blueprint requires:**
- D1.5: "Logging: **the existing `admin_change_log` writer from certified outputs, passed `tx`** — never a second
  writer (if none exists, stop and report)."
- §9 Atomicity: "mock the certified-outputs log-writer module to throw."
- T12: "reuse certified outputs' writer with `tx`."

**What exists.** Certified outputs never introduced a writer function or module. Every log row is a direct insert in
the caller's transaction:

| Writer | file:line |
|---|---|
| charge code `labor_category_changed` | `src/server/actions/charge-codes.ts:120` |
| charge code `deactivated` | `src/server/actions/charge-codes.ts:143` |
| charge code `reactivated` | `src/server/actions/charge-codes.ts:183` |
| user `approver_changed` | `src/server/actions/users.ts:261` |
| `workweek_start_day_changed` | `src/server/actions/workspace-settings.ts:72` |
| `self_approval` enabled / disabled | `src/server/internal/approval-rules.ts:180` (inside `recomputeSelfApproval`) |
| demo seed rows | `scripts/seed-full.ts` (through `recomputeSelfApproval`) |

So there is no module to "reuse" and none to mock for the Atomicity row.

**Options (lead's call):**

- **A — recommended.** Add the one writer:
  - `src/server/internal/admin-change-log.ts` exports
    `logAdminChange(tx: TenantWriter, row: { actorId; entity; entityId; action; oldValue; newValue }): Promise<void>`,
    a single `tx.insert(adminChangeLog).values(row)`.
  - Move the six existing inserts onto it. This is mechanical and behavior-identical; the existing C2/C3/C7 tests keep
    passing.
  - Add a static test: no `insert(adminChangeLog)` outside that module (scripts exempt).
  - D1.5 and D3 log through it. The Atomicity row mocks the module, exactly as written.
  - Cost: it touches four merged certified-outputs files (`charge-codes.ts`, `users.ts`, `workspace-settings.ts`,
    `approval-rules.ts`), outside D1's blast radius (§8).
- **B.** Keep the existing pattern: D1.5 / D3 insert directly with `tx`, like every certified-outputs writer. The
  Atomicity row then needs another way to make the log insert throw, e.g. a fake `tx` whose `insert(adminChangeLog)`
  rejects. T12's "single writer" is then read as "the same table, in the same transaction". No certified-outputs file
  changes.
- **C.** Add `logAdminChange` for D1.5 / D3 only and leave the six existing inserts alone. Not recommended: it creates
  exactly the "second writer" the blueprint forbids.

I'll proceed as soon as one of these is chosen. Nothing else in D1 is blocked, but I'm not starting partway: the
report-first rule says stop.

## 3. Impact analysis (BLUEPRINT-STANDARD §3 rule 1)

**Files to change.** As in blueprint §8. If option A is chosen, add `src/server/internal/admin-change-log.ts` and the
four certified-outputs files above.

**Callers affected by D1.4:**
- `getDetailedCostReportData` (→ cost CSV / XLSX "Rate ($/hr)" and **public `/api/v1/costs` `hourlyRate`**, which
  becomes the rate in effect on each entry's date);
- `getEmployeeSummaryReport`;
- dashboard contract / CLIN / SLIN summaries and the period report (it gains one row per rate when a rate changes
  inside the range);
- `report:cost-basis-change` (its "new" column prices dated).

**Behavior before any dated change exists:** identical. No rows means every rate is the starting rate (D1.1, no
backfill).

**Tests that will need updating (blueprint §1), confirmed present:**
- `unit/fresh-admin-writes.test.ts` (count +3 in D1, +3 in D3);
- `unit/import-duplicate-errors.test.ts` (key list);
- `integration/fresh-admin-writes.test.ts`, `unit/guard-first-oracle.test.ts`, `unit/server-action-guards.test.ts`,
  `unit/action-results-static.test.ts`, `unit/sql-template-params.test.ts`, `unit/export-allowlists.test.ts`;
- `integration/seed-conformance.test.ts` (seeder);
- C3's `updateChargeCode` labor-category tests (D3 rewrites them).

**Not a stop item, but noted:**
- `internal/reports.ts:91,103` computes the per-entry cost in TypeScript (`hours * rate`, rounded). T13 says "no TS
  money math". That code predates this plan, and the §9 pricing figures are exact with it. I'll keep it unless the
  lead wants the per-entry cost moved into SQL.
- §1's "~9 copies" of the latest-revision predicate is 17 (above); D1.4 only needs the exported fragment.

## 4. Open questions shipped as defaults (unanswered — listed as required)

- **DR-Q1 (backdated rate changes):** **allowed.** Before saving, the admin sees how many recorded hours the change
  re-prices; when that number is above zero, a reason is required and logged (DR-2).
- **DR-Q2 (a charge code's category must match its CLIN/SLIN):** **enforced in the new D3 schedule only.** Its category
  list shows only matching categories, and its actions refuse a mismatch with "That labor category belongs to a
  different CLIN or SLIN than this charge code."; moving a code to another CLIN/SLIN is refused while it has a labor
  category. Charge-code create is unchanged.

## 5. Product owner reminders (for the PR, once D1–D3 land)

1. `npm run db:migrate:cp` is **not** needed: this plan adds tenant migrations only. Run it only if a control-plane
   migration has changed.
2. The integration command from `CERTIFIED-OUTPUTS-AUDIT.md` §4:
   ```bash
   REQUIRE_CONTROL_PLANE_TESTS=1 CONTROL_PLANE_DATABASE_URL="$(grep -h '^CONTROL_PLANE_DATABASE_URL=' .env.local .env 2>/dev/null | head -1 | cut -d= -f2-)" ENCRYPTION_KEY="$(grep -h '^ENCRYPTION_KEY=' .env.local .env 2>/dev/null | head -1 | cut -d= -f2-)" TZ=America/New_York npm run test:integration
   ```
3. `npm run build && node scripts/check-build-trace.mjs`.
4. `npm run demo:local` twice.
5. The blueprint §10 manual browser checks.

---

## 6. D0 — single `admin_change_log` writer (ruling option A)

**Writer.** `src/server/internal/admin-change-log.ts` exports `logAdminChange(tx, row)`:
- it takes the caller's `TenantWriter` and never obtains a client of its own;
- it inserts the six columns explicitly (no spread, so the launch-blockers mass-assignment rule holds);
- it returns the new row's id.

**The six inserts, moved as a pure move.** Columns and values are identical, in the same transaction and the same
position in each function:

| Writer | file:line |
|---|---|
| charge code `labor_category_changed` | `charge-codes.ts:120` |
| charge code `deactivated` | `charge-codes.ts:143` |
| charge code `reactivated` | `charge-codes.ts:183` |
| user `approver_changed` | `users.ts:261` |
| `workweek_start_day_changed` | `workspace-settings.ts:72` |
| `self_approval` in `recomputeSelfApproval` | `approval-rules.ts:180`; it keeps `logId` from the returned id |

Unused `adminChangeLog` imports were removed from the three action files.

**Tests** (`unit/admin-change-log-writer.test.ts`):
- the writer inserts exactly the given row with the caller's client and returns the id;
- static: no file in `src/` or `scripts/` other than the writer calls `insert(adminChangeLog)` or
  `insert(schema.adminChangeLog)`, with fixtures for named and namespace imports, and for select and delete not being
  flagged;
- static: the six writers call `logAdminChange(tx, …)`.

**Existing certified-outputs tests:** unchanged (no test file was modified in D0) and green.

**Break-it: 3/3 fail.**
- a direct insert put back in `deactivateChargeCode`;
- the writer dropping a column;
- `recomputeSelfApproval` bypassing the writer.

**Gates:** tsc clean; lint 0 errors / 59 warnings; 1277 unit tests ×4; the migration-safety script passes.
**Postgres:** the product owner's integration run covers the six paths (C2 / C3 / C7 suites).

## 7. D1 — data model, rate rule, pricing, rate actions, import / export / cleanup / seed

**Files.**
- **D1.1** `src/db/schema.ts` `laborCategoryRates`, and migration `drizzle/0015_silly_warhawk.sql` (generated by
  drizzle-kit: `CREATE TABLE`, two FKs, `lcat_rate_effective_unique_idx`; no backfill).
- **D1.2** `src/lib/labor-rates.ts`:
  - `rateOn`, `periodBounds`, `sameRate`, `rateDisplay`, `normalizeReason`;
  - `addedPeriod`, the "[D, next change)" period used by add and the preview;
  - pure validators (`validateAddInput`, `validateCorrectInput`, `validateRemoveInput`);
  - the exact §4 messages (`RATE_MESSAGES`);
  - the input / output types.
- **D1.3** `src/server/internal/labor-rates.ts`: `hourlyRateOnSql` (the only SQL rate rule), `lockAndReadSchedule`
  (`.for('no key update')`) and `readRateSchedule`.
- **D1.4** `cost-basis.ts`:
  - the lateral is wrapped one level deeper and computes `applied_rate = APPLIED_RATE`, i.e. `hourlyRateOnSql` on
    `r.labor_category_id` and the entry date; the `CASE` is not repeated;
  - `pricedCostSum` uses `cost_basis.applied_rate`;
  - `costBasisFields.hourlyRate` / `appliedRate` read `cost_basis.applied_rate`;
  - new: `LATEST_REVISION` (exported, used by `pricedHoursFor` and `unpricedEntries`) and `pricedHoursFor`
    (`NUMERIC(12,2)::text`, operators only);
  - `dashboard.ts` period report selects `COALESCE(cost_basis.applied_rate, 0)::text` and groups by
    `cost_basis.applied_rate`.
- **D1.5** `src/server/actions/labor-category-rates.ts`: `addLaborCategoryRateChange`, `correctLaborCategoryRate`,
  `removeLaborCategoryRateChange`, `previewRateChangeImpact`. The skeleton and check order are as written; each log row
  goes through `logAdminChange(tx, …)`.
- **D1.6**
  - `updateLaborCategory` no longer accepts rates.
  - `bulkImportLaborCategories` validates the hourly and ceiling rates (blank or `$145` is a row error; a blank ceiling
    is none).
  - `getAllLaborCategories` returns `rateChanges`.
  - The edit modal sends no rates and hides those fields; create says "Starting hourly rate ($)" / "Starting ceiling
    rate ($)".
  - Export: the `labor_category_rates` table and the reworded descriptions.
  - `clearTenantData` deletes rates before categories.
  - `DUPLICATE_ENTITY_MESSAGES` gains `lcat_rate_effective_unique_idx`.
- **D1.7** `scripts/seed-full.ts`: NAV-01 SE-III gets a change from the first of the month two months back,
  `149.35` / `164.80`, with its log row via `logAdminChange`, in one transaction.
- **Docs:** `MIGRATIONS.md` gains the 0015 note (deploy right after migrating; never roll back past dated rates once a
  change exists).
- **Pinned lists updated, as blueprint §1 said they would be:**
  - `unit` + `integration/fresh-admin-writes` (37 → 40, the three mutations);
  - `guard-first-oracle` (the three mutations plus the preview);
  - `import-duplicate-errors` (key list);
  - `sql-template-params` allowlist (`labor-rates.ts` `laborCategoryId` / `onDate`, `cost-basis.ts` `APPLIED_RATE`);
  - the C3 import rule allowlist (`internal/labor-rates.ts`, `actions/labor-category-rates.ts`);
  - C3's rendered `pricedCostSum` expectation;
  - `seed-conformance` (+ the D1.7 assertions).

**§9 rows (D1) → tests.**
- *U* = `unit/dated-rates-d1.test.ts` (plus the named lists).
- *I* = `integration/dated-rates.test.ts` (Fixture F1) and `seed-conformance`.

| §9 row | Test | Break-it (U = run by me; PG = for the lead's check script) |
|---|---|---|
| Pure | U: `rateOn` before / on / after, any order (now both orders), none; `periodBounds` start / middle / last / unknown; `sameRate`; `rateDisplay`; `addedPeriod` | U-fail: exclusive date (P1); first match instead of latest (P2 — **survived at first**, my fixture had the latest change first; I added the reversed order and it now fails); wrong period end (P3); string compare (P4) |
| SQL = TS | I: `hourlyRateOnSql` vs `rateOn` on the six dates | PG-1 |
| Pricing | I: 800 / 800 / 400 = 2000 → 800 / 880 / 440 (rates 100 / 110 / 110) → 800 / 880 / 480 | PG-2 |
| Correction | I: starting → 105 (log row exact) → 840 / 880 / 480; `2027-01-01` → 112 → 840 / 896 / 480 | U (log values); PG-2 |
| Removal | I: remove `2027-04-01` → 840 / 896 / 448, log with the removed values | U (log values); PG-2 |
| Grouping | I: period report rows `[100, 8.00]`, `[110, 12.00]` | PG-3 |
| Unpriced | I: unpriced entry stays unpriced (per entry and in the period report), priced total unchanged | PG-4 |
| Impact | I: add `{12.00, 2027-01-01, null}` (with a superseded revision present), correct starting `{8.00, null, 2027-01-01}`, remove `{4.00, 2027-04-01, null}`; U: preview shape, ignores the reason, not_found | PG-5, PG-6 |
| DR-2 | U + I: reason required at impact > 0 (nothing written, no log row); zero impact without a reason succeeds, log `reason: null` | U-fail S3 |
| DR-2 (reason input) | U + I: `''` / `'   '` are no reason | U-fail P5 |
| Validation | U + I: duplicate date (conflict, date-specific), same values (`'110'` vs `'110.00'`), `2027-02-30`, `-1`, `abc`, `not-a-uuid`, a 501-character reason, identical correct, another category's change, remove twice | U-fail: V1, S1, S2, S4, S5, S6, S7 |
| Concurrency (lock) | I: deterministic held `FOR NO KEY UPDATE` + insert → the action waits ≥ 200 ms, then the date-specific `conflict` | U-fail L1 (static lock check); PG-7 |
| Duplicate mapping | I: a real duplicate → `duplicateEntityMessage` = the static string | U-fail D1 (key list); PG-8 |
| Atomicity | U: a failing writer fails the action; static: `await logAdminChange(tx, …)` inside `db.transaction`. I: the writer mocked to throw → no change row, starting rate unchanged, no log row | U-fail A1 (log not awaited); PG-9 |
| Security | U: `fresh-admin-writes` (40), `guard-first-oracle`; I: signed out → `unauthenticated` (mutation and preview), non-admin → `forbidden`, nothing written | U-fail G1 (write gate before the guard) |
| No silent edit | U: the update set has no rate keys; I: the stored rate is unchanged | U-fail N1 |
| Import | U: `$145` → "Hourly rate must be a valid number.", blank → "Hourly rate cannot be empty.", a whitespace ceiling → none | U-fail I1 |
| Static (rates) | U: §9 regexes plus `\w+LaborCategory\.hourlyRate` over `src/` + `scripts/` (allowed list as in §9); fixtures; `cost-basis.ts` clean | U-fail R1 (raw rate in `pricedCostSum`), R2 (`costLaborCategory.hourlyRate` in the dashboard) |
| Export | U: `labor_category_rates` exported, every column described, starting-rate wording; the existing every-table test | U-fail E1 |
| Seed | U (static) + I (`seed-conformance`: one change 149.35 / 164.80 and one log row after seeding twice) | U-fail SD1; PG-10. `demo:local` ×2 is the product owner's |
| (cleanup) | U: `labor_category_rates` deleted before `labor_categories` | U-fail C1 |

**D1 break-it: 25 unit mutations, 25 failures** (P2 after strengthening the test).

**Postgres-only break-its for the lead's check script.** Undo, confirm the named `integration/dated-rates.test.ts`
case fails, restore:
- **PG-1:** in `hourlyRateOnSql`, `r.effective_date <= ${onDate}` → `<`. Fails: "SQL = TS".
- **PG-2:** in `cost-basis.ts`, `onDate: sql\`${timesheetEntries.entryDate}\`` → `onDate: sql\`CURRENT_DATE\``.
  Fails: "Pricing → Correction → Removal".
- **PG-3:** in the dashboard period report, remove `sql\`cost_basis.applied_rate\`` from `groupBy`. Fails: "Grouping"
  (Postgres refuses the ungrouped column, or the rows merge).
- **PG-4:** in `hourlyRateOnSql`, starting-rate subquery `WHERE lc0.id = ${laborCategoryId}` →
  `WHERE lc0.clin_id IS NOT NULL ORDER BY lc0.id LIMIT 1`, **and** in `pricedCostSum` replace
  `cost_basis.basis = 'priced'` with `TRUE`. Fails: "Unpriced" (the period total includes the entry).
- **PG-5:** in `pricedHoursFor`, drop `toExclusive ? lt(...) : undefined`. Fails: "Impact" (correct starting → 20.00).
- **PG-6:** in `pricedHoursFor`, drop `LATEST_REVISION`. Fails: "Impact" (add → 20.00).
- **PG-7:** in `lockAndReadSchedule`, remove `.for('no key update')`. Fails: "Concurrency" (the static duplicate
  message instead of the date-specific one).
- **PG-8:** rename the key in `DUPLICATE_ENTITY_MESSAGES`. Fails: "Duplicate mapping".
- **PG-9:** move `addLaborCategoryRateChange`'s `logAdminChange` call after `db.transaction(...)` resolves. Fails:
  "Atomicity" (the change row exists).
- **PG-10:** remove the D1.7 block from `seed-full.ts`. Fails: `seed-conformance`.

**Gates (D1):** tsc clean; lint 0 errors / 59 warnings; 1321 unit tests ×4; the migration-safety script passes.

**Deviations / notes (D1):**
1. **The date validator keeps the blueprint's exact message without adding a second `validateCalendarDate`.** The
   blueprint asks for a *new* `validateCalendarDate(value, 'Effective date')` in `validation.ts` with the message
   "Effective date is not a valid date.". A `validateCalendarDate` already exists there (certified-outputs fix round 1,
   F10), with the message "… must be a valid date (YYYY-MM-DD)." and tests on it (payroll, sync triggers). Changing it
   would change those messages, so the rate validators use `validateOptionalCalendarDate` (message "Effective date is
   not a valid date.") plus a required check (`validateEffectiveDate` in `src/lib/labor-rates.ts`). The §9 message is
   exact; no existing validator changed.
2. **One small pure helper the blueprint didn't name.** `addedPeriod(schedule, day)` in `src/lib/labor-rates.ts`
   names the add / preview period ("[D, next change after D)" in D1.5).
3. **The preview rejects a missing or unknown `kind`** with "Choose a rate change to preview." (`UserFacingError`). The
   blueprint doesn't define that input.
4. **Two inherited items stay as they are, per the ruling:** the other 16 latest-revision copies, and the per-entry TS
   cost in `reports.ts`.
