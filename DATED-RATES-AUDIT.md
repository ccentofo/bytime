# Dated rates — lead audit of the implementation

**Audited:** branch `dated-rates` at `f8f52e3` (D0 `99bb0ec`, D1 `2aa4bf9`, D2 `1a0de14`, D3 `f8f52e3`) against
`feature-plan-dated-rates.md` (FINAL v3 + the D1.5 ruling) and `DATED-RATES-IMPLEMENTATION-REPORT.md`. **Date:**
2026-10-26. **Method:** gates re-run by the lead; the lead's guard-first and `sql`-interpolation scans; D0 pure-move
check by the lead; two read-only auditors (D1; D2+D3); the HIGH finding re-verified by the lead in the source.

**Verdict: NOT READY TO MERGE — one HIGH (H1), one MEDIUM, fix round 1 below.** (Superseded: fix round 1 verified §5; automated runs clean §6; build + browser checks owed.)

## 1. Gates and lead checks

| Check | Result |
|---|---|
| `tsc` / lint / unit / tz / `db:safety` | clean / 0 errors (58 warnings) / 1368 pass / 1368 pass / passes |
| guard-first, `sql` interpolation scans | clean — `APPLIED_RATE` and `CHARGE_CODE_CATEGORY` are fragments built only from column references |
| D0 (`logAdminChange`) | verified pure move: only the call changed; columns and values identical; caller's `tx`; static test |
| integration / Postgres break-its | product owner's run pending (`breakit-check.mjs`, 19 checks) |

## 2. Fix round 1 (required before merge)

### H1 (HIGH, verified by the lead) — table-alias collision makes every entry use the latest rate change of ANY category
- **Where:** `src/server/internal/cost-basis.ts:56` passes `sql\`r.labor_category_id\`` into `hourlyRateOnSql`; the
  lateral's derived table is named `r` (`cost-basis.ts:92`); the builder's own subquery is
  `FROM labor_category_rates r` (`labor-rates.ts:21-22`). Inside the subquery the inner `r` shadows the outer one, so
  the rendered SQL is `WHERE r.labor_category_id = r.labor_category_id` — always true.
- **Failure:** once any category has a dated change, every priced entry on or after that date — in every category — is
  costed at that change's rate (dashboard contract/CLIN/SLIN, employee summary, period report and its GROUP BY, the
  detail report, CSV/XLSX, `/api/v1/costs` `hourlyRate`). The demo seed (SE-III → 149.35) triggers it. The D2 screens
  (TS `rateOn`) stay correct, so the screens and the reports disagree — the §3 "one rule" invariant is broken.
  `pricedHoursFor` is unaffected.
- **Why tests missed it:** F1 has one category with changes (the tautology then happens to be right); the SQL = TS
  test calls the builder with `laborCategories.id`, not the `r.`-qualified fragment the real call site passes.
- **Fix:**
  1. Give every builder's internal aliases unique, prefixed names that no caller can collide with —
     `hourlyRateOnSql`: `dr_rate` (for `labor_category_rates`) and `dr_start` (for `labor_categories`);
     `chargeCodeLaborCategoryOnSql`: `dr_cc_change` and `dr_cc_start`.
  2. Rename the lateral's derived tables from `r` / `c` to `resolved` / `counts`.
  3. Update the SQL text pinned in `unit/cost-basis` accordingly.
- **Tests (each must fail on today's code):**
  - **Unit:** render `COST_BASIS_LATERAL` with drizzle's `PgDialect` and assert no `(\w+)\.labor_category_id = \1\.labor_category_id`
    (and no `(\w+)\.charge_code_id = \1\.charge_code_id`); assert the builders' rendered SQL contains only the prefixed aliases.
  - **Integration (new §9 row "Two categories"):** F1 plus category `O` on the same CLIN with starting rate `90.00`
    and its own change `2027-03-01` → `95.00`; employee `E2` assigned to `O` with entries `2027-01-15` 8.00 h and
    `2027-04-15` 8.00 h; L keeps its `2027-01-01` → `110.00` change. Expected per-entry via
    `getDetailedCostReportData`: E2 720.00 (rate 90) and 760.00 (rate 95); E/L unchanged (800 / 880 / 440). Today's
    code instead takes the latest change of ANY category: E2's 2027-01-15 entry at 110 (880.00) and E's 2027-06-30
    entry at 95 (380.00) — so the test fails on both employees.
  - **Integration:** run the SQL = TS comparison through `getDetailedCostReportData().hourlyRate` (the real call
    site), not only by calling the builder directly.
  - **Postgres break-it** (for the lead's script): revert the lateral alias to `r` → the "Two categories" test fails.

### M1 (MEDIUM, D2/D3 UI) — a late preview arms Save for values it never ran on
- **Where:** `RateScheduleModal.tsx:88-100`, `ChargeCodeCategoryModal.tsx:83-95`, shared `ImpactGate.tsx`. While a
  preview is in flight the value fields, row Correct/Remove buttons and Cancel stay live; a change calls `reset()`, then
  the late result re-arms the gate for the new values (auditor's jsdom probe: preview 2028-01-01, change to 2025-01-01
  while pending → "No recorded hours are affected." and Save enabled). The server re-checks DR-2, but the admin can tick
  "I understand" against an hours count for different input — defeats DR-Q1's "the admin sees how many hours it
  re-prices".
- **Fix:** generation counter (`useRef`) in `useImpactGate`: bump it in `reset()`, capture it in `preview()`, drop a
  result whose generation changed. Also reset `mode` and the gate when a modal closes (L5).
- **Test:** render test with a deferred preview promise: change a value while pending → after resolve, Save stays
  disabled and no impact text shows; same for clicking a row's Correct while an Add preview is pending.

### LOWs (cheap; same round)
- **L1** `integration/dated-rates.test.ts:112-118`: assert the §9 totals 2120.00 and 2160.00 (period report).
- **L2** category actions: tests for a bad date (`'2027-02-30'`), a 501-character reason and a bad `Category period` id
  (removing `validateEffectiveDate` from `validateCategoryAddInput` would survive today).
- **L3** render-test Correct and Remove in the rate modal (only Add is covered).
- **L4** `previewChargeCodeCategoryImpact` checks the category before the period; `correctChargeCodeCategory:96-98`
  the reverse — make them match (period first, per the D1.5 table).
- **L5** reopening the same modal keeps the half-done form — covered by M1's reset-on-close.
- **L6** `MIGRATIONS.md:87-96`: add 0016 / `charge_code_labor_categories` to the no-rollback note.
- **L7** `cost-basis.ts:49-53`: move the `APPLIED_RATE` doc comment back above `APPLIED_RATE`.

## 3. Rulings on the dev's deviations (report §9)
All accepted: "Charge code not found." and the "Charge code" / "Category period" labels (D3 locks the code);
category-id check order null → uuid → exists → DR-Q2 (the plan's literal order made the null message unreachable);
the DR-Q2 move refusal after the "recorded hours" refusal (the hours message is the true blocker); `ImpactGate` as a
shared piece (keeps the two modals identical, and is the single place to fix M1). X38 (unreachable guard behind a
disabled button) mutated via the button instead — accepted.

## 4. Blueprint lesson (added as trap T16)
SQL builders interpolated inside other SQL must use internal aliases no caller can reuse. The blueprint's own example
used `r` and told the dev to wrap it one level deeper — the lead's omission, not only the dev's.

## 5. Fix round 1 verification (`e97c029` H1, `ecbf312` M1 + L1–L7) — 2026-10-26

**Lead:** `tsc` clean; 1381 unit tests pass; scans clean. **H1 verified in the source:** `hourlyRateOnSql` uses only
`dr_rate` / `dr_start` (`labor-rates.ts:21-24`), `chargeCodeLaborCategoryOnSql` only `dr_cc_change` / `dr_cc_start`
(`:74-76`), the lateral's derived tables are `counts` / `resolved` (`cost-basis.ts:90-91`) and `APPLIED_RATE` passes
`resolved.labor_category_id` — no alias can shadow the caller's. Unit render tests reject self-comparison (including a
quote-stripped variant the dev added after its first break-it). The "Two categories" integration row (expected total
3600.00) is in blueprint §9. M1 (generation ticket in `useImpactGate`, reset on close) and L1–L7 accepted as reported
(19/19 break-its).
**Postgres break-its:** `breakit-check.mjs` updated — PG-1/2/4/11/12/21 retargeted to the new aliases; added PG-22 (make
`dr_rate` collide with `resolved` → "Two categories" fails) and PG-24 (totals at the starting rate → period totals
fail). PG-23 omitted (PG-22 recreates the same bug).
**Code audit: CLEAN pending the product owner's runs:** integration (audit §4 command), `node breakit-check.mjs`
(21 checks), `npm run build && node scripts/check-build-trace.mjs`, `npm run demo:local` ×2, blueprint §10 browser checks.

## 6. Product owner's runs — 2026-10-26

- **Integration** (audit §4 command, control plane required): first run 512 pass / 1 fail — `dated-rates-d3` "D3
  validation" expected "A reason is required" for a 2027-02-01 add, but `[2027-02-01, 2027-03-01)` holds no entries on
  K, so DR-2 correctly needed no reason. Test-expectation bug, not code: fixed in `3cde8f5` (the add now uses
  2027-01-01, which re-prices the 2027-01-15 entry, plus the zero-impact counterpart → ok). Re-run: clean.
- **Postgres break-its:** `breakit-check.mjs` **21 / 21 caught**, working tree restored. The lead spot-checked the logs:
  each failure is the intended assertion (e.g. PG-10 → the seed-conformance baseline row; PG-22 → "Two categories").
- **Still owed before merge:** `npm run build && node scripts/check-build-trace.mjs`, `npm run demo:local` ×2, blueprint
  §10 browser checks.
