# Certified outputs — lead audit of the implementation

**Audited:** branch `certified-outputs` at `c17810c` (C1–C8, commits `26d7538`…`c17810c`) against
`feature-plan-certified-outputs.md` v6.2 and `CERTIFIED-OUTPUTS-IMPLEMENTATION-REPORT.md`. **Date:** 2026-10-25.
**Method:** gates re-run by the lead; the lead's independent guard-first, SQL-interpolation and segment-config scans;
six read-only auditors (C1, C2, C3, C4+C5, C6+C8, C7); every item below that affects code was checked against the
source. The product owner's first integration run (missing control-plane URL — see §4) contributed three items.

**Verdict: NOT READY TO MERGE — fix round 1 below.** No HIGH findings. The core logic held up under adversarial review:
cost-basis SQL traced by hand (one row per entry, correct precedence, no cross-SLIN borrowing, no bound parameters);
FLSA walk correct for 40.00 exactly, every workweek start day, DST weeks, mid-week ranges and boundary weeks; the import
lock order is deadlock-free; every new action checks the caller first; no raw values in `sql`; migrations agree with
the schema (drizzle-kit reports no drift).

## 1. Gates (lead)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run lint` | 0 errors, 59 warnings |
| `npm run test` | 1221 passed (81 files) |
| `db:safety` | passes (`node --import tsx scripts/check-migration-safety.ts`) |
| guard-first / `sql` interpolation / segment-config scans (lead's own) | clean — only public actions and fixed lock keys |
| integration (product owner, after `npm run db:migrate:cp`) | **463 passed, 4 failed** — the 4 are F6 (summary grouped by name) and T7 (hours compared as strings ×3); every C1/C3/C7 SQL path passed on Postgres |

## 2. Fix round 1 (required before merge)

Each item: where, failure, fix, test that must fail without it (record a break-it).

### Correctness
- **F1 (C2, MEDIUM) — user-rules deadlocks, log drift, approve-time race.** `setUserApprover` (`users.ts:237-256`)
  locks the target `FOR UPDATE` then takes `KEY SHARE` on other users through the `approver_id` and
  `admin_change_log.actor_id` FKs; `updateUser` (`:140-155`) locks all active admins then the target; the reactivation
  branch (`:134-137`) locks the target first → 40P01 deadlocks (generic error + Sentry). `recomputeSelfApproval`
  (`approval-rules.ts:140-163`) reads under READ COMMITTED without serialization → two concurrent writers can miss a
  real switch (CO-D19 says every switch is logged). `approvePeriod` checks `canApprove` outside its transaction
  (`periods.ts:345-351`). **Fix:** every writer of `users.role` / `is_active` / `approver_id` (the six enumerated:
  `createUser`, `updateUser`, `createUserWithPassword`, `bulkImportEmployees`, `setUserApprover`, `provisionTenant`)
  takes `pg_advisory_xact_lock(hashtext('user-rules'))` as the **first statement of its transaction**, before any row
  lock; approve/reject take `pg_advisory_xact_lock_shared(hashtext('user-rules'))` inside the decision transaction and
  re-run `canApprove` there. Use a named constant, allowlisted in `sql-template-params` like `IMPORT_WINDOW_LOCK`.
  **Tests:** deterministic, two raw per-call clients: (a) one holds the admin row locks, the other runs
  `setUserApprover` on a higher-id admin → no 40P01, both complete; (b) deactivate admin2 and add admin3 concurrently →
  the log's last row matches the final state; (c) demote a designee while an approval waits on the shared lock → the
  approval is refused. Static: every enumerated writer's transaction begins with the lock (fixture without it fails).
- **F2 (C2, MEDIUM) — "self-approval back on" notice never shows for pre-C2 workspaces.** `currentSelfApprovalOn`
  (`approval-rules.ts:186-195`) needs an earlier "disabled" row; only provisioning writes a baseline. **Fix (no
  migration):** the notice shows when the latest `self_approval` row for the admin is `enabled` **and** its reason is
  not a baseline reason (`'workspace created'`, the seed's reason). **Test:** a workspace with two admins and no prior
  rows → deactivate one → the notice shows for the other.
- **F3 (C1, MEDIUM) — import hours silently truncated.** `src/server/internal/migration.ts:50-53` and
  `src/server/actions/migration.ts:104` use `parseFloat` ("7,5" → 7, "8h" → 8). **Fix:** `Number(String(x).trim())`;
  empty or non-finite → row error; 0–24; round to 2 decimals (the `validateHours` rule). **Test:** `'7,5'`, `'8h'`, `''`
  are row errors; `'7.5'` imports as 7.50.
- **F4 (C7, MEDIUM) — payroll can be downloaded without seeing flagged employees.** `PayrollExportClient.tsx:200-217`
  (downloads need only a range), `:56,158` (preview not cleared on range change). **Fix:** changing the range clears the
  preview; both download buttons stay disabled until a preview for the current range is loaded; if anyone is flagged,
  the list is visible above the buttons. **Test:** render test — download disabled before preview and after a range
  change; enabled after preview.
- **F5 (C3, MEDIUM) — "Remaining" funding figures carry no unpriced flag.** `DashboardClient.tsx:73,134-146` (contract),
  `:208,219-223` (CLIN), `:233,245-249` (SLIN), overview Remaining card (~`:358-366`). **Fix:** `UnpricedNote` / "based on
  priced cost" on each Remaining figure while unpriced hours > 0 (CO-D17). **Test:** render test with unpriced hours.
- **F6 (pre-existing, found by the integration run) — hours summary merges employees with the same name.**
  `actions/reports.ts:257` groups by `users.fullName`. **Fix:** group by `users.id` (select it), keep the name for
  display. **Test:** the existing `approver-rules` designee-scope assertion (two "Test User"s) passes; plus a direct
  case.
- **F7 (C4, LOW→required, cheap) — revision map can wedge a save.** `timesheet.ts:109-136` groups revisions by
  (charge, clin, indirect, date) while the conflict check uses the COALESCE cell identity → a charge cell with
  revisions under two `clin_id`s (pre-C3 data) fails every save with "modified by another session". **Fix:** group by
  `COALESCE(charge_code_id, indirect_code_id, clin_id), entry_date`. **Test:** that data shape → save succeeds.
- **F8 (C4, LOW, cheap)** `TimesheetContext.tsx:277` seeds the offline store with the old period's codes → use
  `period.chargeCodes`; make `chargeCodes` required on period data (`types/timesheet.ts:80`) and drop the `??` fallback
  (`TimesheetContext.tsx:76`); export the reducer and test that navigation replaces the list.
- **F9 (C5, LOW, cheap)** PDF charge-row contract/CLIN label comes from the group's first row in DB order
  (`timesheet-rows.ts:72,84`; no ORDER BY in `actions/reports.ts:117-165`) → take them from the charge code's own CLIN.
- **F10 (C7, LOW, cheap)** `flsa.ts:127` flags employees even when no overtime depends on unapproved days → flag only
  when `unapprovedWorkedSoFar > 0 && beyond > 0`, and say so in the method doc. Gusto record counts a failed insert as
  both pushed and failed (`gusto.ts:166,191`) → increment `pushed` after success. Payroll actions: user dates via
  `validateCalendarDate`-style `UserFacingError` (not `parseCalendarDate`). Remove dead `getPayrollFormats`. Method doc:
  add "unapproved days skipped in one export are only picked up by re-exporting that range" and "changing a used leave
  code's pay type or an indirect code's category changes past exports".
- **F11 (C3, LOW, cheap)** `UnpricedNote` links land at the page top → add `#cost-basis-reports`; the period-report note
  scopes by the *generated* range, not the current inputs. Reactivate count counts deactivated users
  (`charge-codes.ts:155-157,172-173`) → count active users only. Document in the API-key dialog that `/api/v1/costs`
  `lcatTitle` is now `'Unpriced'` for unmatched rows.
- **F12 (C6, LOW, cheap)** audit queries order by `created_at` only (`audit.ts:192,323`) → add `desc(id)` tie-breaker;
  fetch 501 and show "showing the first 500" when capped. Period-event date filter uses `period_start` only
  (`audit.ts:315-316`) → overlap test. `validateUUID` every id input in the audit reads after the guard.
- **F13 (pre-existing, LOW, cheap)** generated-passwords CSV built by hand (`ImportClient.tsx:273-275`; ~1 in 59
  passwords starts with `@`, which Excel shows as `#NAME?`) → use the shared `generateCsv`.
- **F14 (C1, LOW, cheap)** batch split counts UTF-16 chars (`import-plan.ts:43`) → `new TextEncoder().encode(...)
  .length`; validators coerce fields with `String(x ?? '')`; `tenant:admin show` reports "closed" when an app
  `submitted` event exists (`scripts/tenant-admin.ts:101`).
- **F15 (C2, LOW, cheap)** re-route emails print the re-route time as "submitted at" (`submission-notify.ts:45`) → the
  real submission time. Delete the dead CLIN-only `getSupervisedEmployeeIds` (`supervisor-scope.ts:21`) and its test.
  Fix stale `npx tsx scripts/seed-demo.ts` usage lines (`scripts/seed-demo.ts:17,20,52`,
  `feature-plan-production-deploy.md:199`).

- **F16 (test infrastructure, cheap)** the integration setup migrates the test tenant DB but not the control plane;
  a local control plane behind the journal produced 185 cryptic `column … does not exist` failures (CI migrates it,
  `ci.yml:96-99`). **Fix:** in `src/__tests__/integration/setup-db.ts`, when `CONTROL_PLANE_DATABASE_URL` is set, compare
  the rows in the control plane's `drizzle.__drizzle_migrations` with `drizzle/control-plane/meta/_journal.json` and throw
  one message: "Control-plane database is behind (N of M migrations) — run `npm run db:migrate:cp` with
  CONTROL_PLANE_DATABASE_URL set." **Test:** unit test of the comparison helper.

### Test gaps (each must fail without the code it covers)
- **T1 (C4)** save path: assigned, active code, **CLIN set inactive** → new day refused, existing day correctable; same
  for the **contract** (integration + unit via `chargeCodeFacts({ clinActive: false })`).
- **T2 (C6)** `getAuditPeriodEvents` scope: as the no-CLIN designee `book`, events for {book, X} only; `other` → `[]`.
- **T3 (C8)** seeder conformance: run `seedRichData(getTestDb())` **twice**; assert every approved period's reviewer
  passes `canApprove`, non-draft periods have `submitted` events, approved have `approved`, workweek = 1, every leave
  code has `leave_pay_type`, one baseline `self_approval` row.
- **T4 (C7)** latest revision in payroll: rev 1 = 10 h, rev 2 = 8 h → 8 h; a correction to 0 h → day omitted. Float-sum
  case that isn't 40 as floats: 5.83, 5.83, 5.83, 10.88, 11.63 → 40.00 regular, 0 OT.
- **T5 (C3)** integration cases: SLIN-level conflict; SLIN beats CLIN (CLIN-level A + SLIN-level B on the entry's SLIN →
  B); exact dashboard `slinSummaries` cost/unpriced; `getEmployeeSummaryReport().unpricedHours`. Static import test also
  flags `schema.(userLaborCategories|laborCategories)` and raw `labor_categories` / `user_labor_categories` in `sql`.
- **T6 (C8)** export `self_approved` parity: add a legacy period (no event, `reviewed_by = user_id`) and
  reject → resubmit → approve.
- **T7 (integration run)** three tests compare hours as strings (`audit-trail.test.ts:73`,
  `grid-corrections.test.ts:82,119`) — compare `Number(x).toFixed(2)`; the database stores hours as saved.
- **T8 (C2)** the "another reviewer decided first" integration test must exercise the zero-row-UPDATE re-read path (not
  the status pre-check).

## 3. Rulings on the dev's questions and deviations

- **Zero-hour rows on the PDF:** keep printing them (matches the grid; the audit trail would otherwise show a code the
  signed timesheet doesn't).
- **Approval line on reprint (name / timezone read at print):** accepted for this release; **backlog:** snapshot the
  approver's display name and the workspace timezone on the decision event. Identity can't change (actor id is stored).
- **Payroll actions converted to ActionResult:** accepted.
- **Seed scripts run with `--conditions=react-server`:** accepted (`demo:local` uses the npm scripts).
- **Unrelated bugs §6:** Gusto counter → F10; daily notes never sent to the server and the hard-coded "Semi-Monthly" PDF
  title → backlog.

## 4. Product owner: the integration command

The first run skipped 13 suites (203 tests): `CONTROL_PLANE_DATABASE_URL` lives in `.env`, and the command used read
only `.env.local`. Use this one (fails instead of skipping when the URL is missing):

```bash
REQUIRE_CONTROL_PLANE_TESTS=1 CONTROL_PLANE_DATABASE_URL="$(grep -h '^CONTROL_PLANE_DATABASE_URL=' .env.local .env 2>/dev/null | head -1 | cut -d= -f2-)" ENCRYPTION_KEY="$(grep -h '^ENCRYPTION_KEY=' .env.local .env 2>/dev/null | head -1 | cut -d= -f2-)" TZ=America/New_York npm run test:integration
```

## 5. Backlog (not now)

Approver name/timezone snapshot on decision events; `NEVER_EXPORTED_COLUMNS` test (every column allowlisted or excluded
on purpose); fix-guidance links to the specific code/employee; re-route email N+1 queries; static writer test blind
spots (raw `UPDATE users`, aliased imports); import race test strength (xid order) and probabilistic lock-order test;
C3 race test non-determinism (static order test guards it); daily notes not sent to the server; "Semi-Monthly" PDF
title; offline path: one forbidden cell pauses the queue forever.

## 6. Fix round 1 verification (`abacfd1`, `a980a2e`, `577483c`) — 2026-10-25

**Lead:** `tsc` clean; lint 0 errors; 1260 unit tests pass; `db:safety` passes; guard-first and `sql`-interpolation scans
clean (new fixed lock key `USER_RULES_LOCK` only). **F1 verified by the lead:** `lockUserRulesExclusive` is the first
statement in all six writers plus the seeder (`users.ts:43,135,209,240`, `import.ts:50`, `provision.ts:90`,
`seed-full.ts:96`); approve and reject share `decidePeriod` (`periods.ts:328`), which takes `lockUserRulesShared` inside
the decision transaction and re-runs `selfApprovalAvailable` / `canApprove` there.
**Integration (product owner):** 481 passed, 5 skipped (baseline), 0 failed — includes F6, T7, the three F1 concurrency
tests and the seed-conformance test.

**Re-audit of F2–F16 / T1–T8 (one reviewer + the integration run):** all verified except below. Items the reviewer
could only read (F2, F3, F6, F7, F11 and the Postgres parts of T1–T6, T8) are proven by the product owner's
481-pass integration run. F7's integration case is order-dependent; its static check is the deterministic guard.

### Fix round 2 (small; required before merge)
- **R1 (MEDIUM — caused by the lead's F13 instruction)** `generateCsv` prefixes `'` to values starting with `@`, and the
  password generator (`src/server/actions/import.ts:342-348`) can start a password with `@` (~1 in 59) → the CSV and the
  copied text (`ImportClient.tsx:276,396`) show `'@…`, an unusable password. **Fix:** generated passwords never start with a
  formula-trigger character (`= + - @`, tab, CR) — draw the first character from letters and digits only. Keep
  `generateCsv`. **Test:** 10,000 generated passwords never match `FORMULA_PATTERN`; the CSV cell for a password equals the
  password exactly.
- **R2 (LOW)** F2: a pre-C2 sole-admin workspace's first unrelated user write logs `enabled` with a non-baseline reason →
  a false "back on" notice. **Fix:** when an admin has **no** prior `self_approval` row and the write didn't remove an admin
  or designee, log the first row with a baseline reason (add it to `BASELINE_SELF_APPROVAL_REASONS`). **Test:** that case
  shows no notice; deactivating the second admin of a pre-C2 workspace still shows it.
- **R3 (LOW)** F12: period-events `truncated` is untested and under-reports when the 5,000-candidate prefetch caps
  (`audit.ts:486,499`) → `truncated = overlapping.length > 500 || candidates.length === 5000`; unit case.
- **R4 (LOW)** `triggerGustoSync` (`gusto.ts:59`) and `triggerQBOSync` (`qbo.ts:158`) still use `parseCalendarDate` on user
  dates → `validateCalendarDate`-style `UserFacingError`.
- **R5 (LOW)** F3: require a decimal pattern (`/^\d+(\.\d+)?$/` after trim) so `'0x8'` / `'1e1'` are refused.

## 7. Fix round 2 verification (`5543bdb`) — 2026-10-25

**Lead:** `tsc` clean; lint 0 errors; 1268 unit tests pass; `db:safety` passes. R1 verified (first character from
letters/digits, CSPRNG; 10,000-password test). R2 verified (`existingState` only when no prior row **and** self-approval
was already available before the write; real switches keep their reason; a writer that omits `before` falls back to one
extra notice, never a wrong permission). R3–R5 accepted as reported (R5 also refuses `.5` / `8.` — a refusal with a clear
message, not truncation; accepted).

**Code audit: CLEAN for merge.** Remaining before the PR (product owner): integration run (adds the R2 Postgres case),
the Postgres break-its in the implementation report §18–§19, `npm run report:cost-basis-change -- acme`,
`npm run build && node scripts/check-build-trace.mjs`, `npm run demo:local` twice, and the blueprint §10 browser checks.
Before production: payroll accountant reviews `docs/payroll-overtime-method.md`; ADP / Paychex / Gusto layouts verified
in staging before payroll export is marketed.
