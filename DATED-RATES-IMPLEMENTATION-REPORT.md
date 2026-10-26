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
