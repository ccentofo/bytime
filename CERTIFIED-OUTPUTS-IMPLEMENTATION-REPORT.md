# Certified outputs — implementation report

**Blueprint:** `feature-plan-certified-outputs.md` (FINAL v6.1, rulings Q1–Q7 inline) · **Branch:** `certified-outputs`,
created from local `main` at `da73893` (not fetched), not pushed · **For:** lead systems architect · **Status:** in
progress, one commit per part — see §9 onwards.

| Part | Commit | Status |
|---|---|---|
| C1 | `26d7538` | done; integration suite to run on the product owner's machine |
| C2 | `dbff17b` | done (Q8 ruled: option b); integration suite to run on the product owner's machine |
| C3 | `25cd351` | done; integration suite to run on the product owner's machine |
| C4–C8 | — | in progress |

## 1. How the research was done

I read `AGENTS.md`, BLUEPRINT-STANDARD §3 and the whole blueprint. Three read-only reviewers then re-checked every
"Verified current state" claim (§1) and the C1–C8 designs against the current code, which includes the launch-blockers
merge. I spot-checked the claims that became stop items myself (`charge-codes.ts:114-120`, `timesheet.ts:25-42` /
`:209` / `:392`, `indirect-codes.ts:108-110`, `ChargeCodesClient.tsx`).

**Result:** almost every behavioural claim in §1 still holds, but most line numbers have moved (table in §5). Seven items
conflict with the code or are ambiguous, and need a ruling (§3). The rest are implementation details I resolve as
listed in §4, so they can be audited.

## 2. External facts confirmed (source)

| Fact | Source |
|---|---|
| Server-action body limit is 1 MB by default; `next.config` doesn't raise it | `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/serverActions.md:24-28` |
| `after()` is allowed in Server Functions, and may read `headers`/`cookies` there | `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md:8, 62-66` |
| Drizzle 0.45.2: `leftJoinLateral` / `innerJoinLateral` exist, but take only `Subquery \| SQL` (not a table); `.for('update' \| 'share' …)` exists | `node_modules/drizzle-orm/pg-core/query-builders/select.d.ts:118, 187, 586`; `select.types.d.ts:55` |
| Tenant migrations end at `0013_truncate_guard` → 0014 is next. Control plane ends at `0008_signup_controls` → drizzle-kit should generate 0009 | `drizzle/meta/_journal.json`, `drizzle/control-plane/meta/_journal.json` |
| 0012 pattern: drizzle-kit DDL plus hand-written trigger SQL in the same file; `cadenzpoint_block_entry_mutation()` honours `SET LOCAL cadenzpoint.allow_entry_delete='on'` (the `clearTenantData` bypass) | `drizzle/0012_lame_edwin_jarvis.sql:22-35`, `0013_truncate_guard.sql` |
| `dayOfWeek()` is dayjs `.day()` (0 = Sunday), matching C7 | `src/lib/calendar-date.ts:69-71` |

## 3. Stop items — rulings needed (file:line)

**Q1 — C4 contradicts itself on legacy CLIN rows.**
- §4 C4 defines `assignable` for `clin` as "the employee has an active `user_assignments` row on that CLIN". §9 "Grid
  assignable" says "empty days editable only with an active assignment".
- The same section says "Legacy CLIN cells only where `priorRevision > 0` (closes the existing path that creates new
  CLIN-only cells)". §9 "Grid/review" says "new legacy CLIN cell refused".
- Both can't hold: is a new CLIN-only cell allowed for an employee with an active `user_assignments` row, or never?
- Today it is allowed for anyone holding a charge code on the CLIN (`timesheet.ts:48-65`, `:292`), because
  `assignChargeCodeToUserInternal` upserts `user_assignments` (`src/server/internal/charge-codes.ts:63-68`).
- **My reading:** "never" (priorRevision > 0 only), so legacy rows are `assignable: false`. That closes the path the
  blueprint calls out. Please confirm.

**Q2 — CO-D8 "Reactivation does not restore user assignments" is not true of the current data model.**
- `deactivateChargeCode` sets only `charge_codes.is_active=false` and leaves every `user_charge_codes` row active
  (`src/server/actions/charge-codes.ts:114-120`).
- Reactivating would therefore make the code assignable again at once, for everyone previously assigned.
- To behave as written, either:
  - (a) deactivation also deactivates the code's `user_charge_codes` rows (a behaviour change to deactivation); or
  - (b) reactivation deactivates them.
- Which one? Under (a), a deactivated code's rows still show through C4's "every code with an entry in the period".

**Q3 — CO-D13 warning has nowhere to appear.**
- The charge-code form has no labor-category or SLIN field. `ChargeCodesClient.tsx:97-133` sends only
  code/description/clinId/costClass/flags; the row type carries `slinId`/`laborCategoryId` (`:29`, `:32`) unused.
- QBO import (`qbo.ts:278`) and the seed never set them either, so a used code's labor category can't be changed in the
  app today.
- Does C3 add a labor-category select (and SLIN?) to the charge-code form, so the warning and the `admin_change_log` row
  are reachable? Or is CO-D13 server-only for now (logged when changed via the action)?

**Q4 — Saves never check that a charge code is active.**
- C4 says the "assignment / active-code checks run per cell…", as if both exist.
- Only the assignment check exists. It reads `user_charge_codes.is_active` on a **separate** `getDb()` connection
  (`timesheet.ts:25-42`, called at `:281`), never `charge_codes.is_active`, and never CLIN/contract status.
- So today new hours can be added to a deactivated code that is still assigned, which CO-D8 forbids.
- **My reading:** C4 adds the active check (code active + CLIN/contract active, the same set as
  `getChargeCodesForEmployee`, `timesheet.ts:468-476`) for `priorRevision = 0` cells, inside the transaction.
- Confirm, because it changes behaviour for users who still hold a deactivated code.

**Q5 — `recomputeSelfApproval` "in the same transaction" for writers that have no transaction, and user creation
outside the app.**
- `createUser` and `createUserWithPassword` (`users.ts:28-45`, `:175-197`) and `bulkImportEmployees`
  (`import.ts:31-91`) run without a transaction. I would wrap them.
- `provisionTenant` creates the first admin (`src/lib/tenant/provision.ts:88-95`), so self-approval becomes available.
  That is a "switch on" under CO-D19, and `admin_change_log.actor_id` would be the new admin.
- The seeders (`seed-users.ts`, `seed-full.ts`, `seed-tenant.ts`, `provision-customer-db.ts`) also insert users.
- Should `provisionTenant` log the initial `enabled` row, and must the scripts call it? **My reading:** yes for
  `provisionTenant` (it is app code); scripts are exempt from the static test, but `seed-full` writes the rows it needs
  for C2-conformant demo data. Please confirm.

**Q6 — CO-D17 "every cost total" and the cost exports.**
- C3 lists "report CSV/PDF exports". There is no cost PDF: the cost exports are CSV (`api/reports/cost-report-csv`) and
  XLSX (`api/reports/cost-report-xlsx`, `src/lib/reports/cost-report-excel.ts`).
- `GET /api/v1/costs` (`src/app/api/v1/costs/route.ts:40`) also returns cost totals.
- **My reading:** CSV + XLSX carry the "X hours unpriced" count. Should `/api/v1/costs` also return `costBasis` per row
  plus an unpriced-hours total? That is an API-contract addition, so I won't add it unruled.

**Q7 — C5 "stable on reprint" and the PDF footer.**
- The PDF footer prints the generation time (`src/lib/reports/timesheet-pdf.tsx` ~`:123`), so two prints differ.
- **My reading:** "stable" means the same rows, totals and approval line on every reprint (that is what the test will
  assert), and the "Generated …" footer stays. Confirm, or rule that the footer goes.

## 4. Resolved as implementation details (not stop items — listed for the audit)

- **C1 / launch-blockers ruling:**
  - `validateMigrationData` becomes `userAction`/`ActionResult` with `requireAdminFresh` as the first await. Today it is
    a plain array, `requireAdmin` after `getDb()` (`migration.ts:18-24`). The launch-blockers audit §5 ruled C1 converts
    it.
  - A periods-validation action is created; none exists, and `periodValidated` is set but never read
    (`MigrationClient.tsx:47, 97`).
  - Row rules are in `src/server/internal/migration.ts:11-97`, and the row type is in `src/types/migration.ts:2-12`. A
    static test forbids `importMigrationData` calling `validateMigrationData` (`action-results-static.test.ts:335`), so
    both use the internal validator.
  - Today's import has **no transaction** and per-row inserts (`migration.ts:43-75`). C1 replaces this with the
    one-transaction design.
- **`REASON_LABELS`:** added to the existing `src/lib/reason-codes.ts`. `MIGRATION` is **not** added to `REASON_CODES`,
  because `saveTimesheetBatch` validates against it (`timesheet.ts:373-375`) and would then accept it.
- **`tenant:admin show`:**
  - It reads the control plane only today (`scripts/tenant-admin.ts:116-138`).
  - Reading `history_import_closed_at` needs the tenant DB (`decrypt`, ENCRYPTION_KEY). If the key or the tenant DB is
    unavailable, `show` prints "unknown (tenant DB not reachable)" rather than failing.
  - `reopen-import-window` follows the existing `plans` + `applyAdminPlan` pattern (`admin-commands.ts:37-156`).
- **C2 scope:**
  - The submission-email recipient loop calls `getSupervisedEmployeeIds` directly (`periods.ts:120-129`), and the scope
    banner counts CLIN sharers only (`supervisor-scope.ts:70-114`). Both move to `reviewScope`/`canApprove`, as the
    blueprint's recipients and banner rules require.
  - Dead `getScopedPendingApprovals` (`periods.ts:542-580`, no callers) is deleted, per the blueprint's LOWs.
- **C2 conflict message:** the blueprint calls it "existing 'just reviewed by someone else' message". The actual existing
  text is `CONCURRENT_REVIEW_MESSAGE` = "This timesheet was just changed by someone else. Please refresh and try again."
  (`periods.ts:356`). It is kept as is.
- **C4:**
  - The indirect-code check (`availableToAll` + active, `timesheet.ts:261-276`) and the CLIN check (`:292`) move inside
    the transaction, per cell, after `priorRevision`.
  - `getTimesheetPeriod` gains the code list; it doesn't return one today (`timesheet.ts:109-131`). `SET_PERIOD_DATA`
    gains `chargeCodes` (`src/types/timesheet.ts:67`).
  - The blueprint's offline claim is inaccurate: `sync-service.ts:172` sends `clinId` (holding a charge-code id), and its
    fallback reason `'OFFLINE_SYNC'` is invalid. The path is dormant (`saveOfflineEntry` has no callers). It is mapped by
    `kind` as designed; the invalid fallback reason is listed in §6, not fixed.
- **C3:**
  - The 5 copies are confirmed, with no 6th: `server/internal/reports.ts:85-100`, `actions/reports.ts:275-290`,
    `dashboard.ts:134-149, 201-216 (the SLIN query), 374-389`.
  - The lateral join is built as an `SQL`/`Subquery`.
  - The static-import allowlist includes the non-report importers (setup, import, labor-categories, charge-codes,
    allowlists, clear-tenant-data).
  - "No `status` filter" changes historical totals for inactive/closed categories. That is intended, and the
    before/after script reports it.
  - The `user_labor_categories (user_id, effective_date)` index is absent: only
    `(user_id, labor_category_id, effective_date)` exists (`drizzle/0000:162`), so 0014 adds it.
- **C7:**
  - The payroll export actions become `ActionResult`, so the refusals reach the user. Today they are `requireAdmin` and
    throw (`src/server/actions/payroll-export.ts:89`); the launch-blockers ruling named C7 for this.
  - Gusto branch: `pushTimesheetEntries`' signature carries no leave/exempt data (`src/lib/integrations/types.ts:101,
    115-130`), so it gets a payroll payload (the blueprint's Known LOW). The refusal lands between the connector lookup
    (`sync-engine.ts:162`) and the sync-log insert (`:168`).
  - Escaping: the workspace export uses `Papa.unparse({ escapeFormulae: FORMULA_PATTERN })` (`workspace-export.ts:26,
    92-94`), with no escape function. `src/lib/csv/escape.ts` therefore owns `FORMULA_PATTERN` and `escapeCsvField`; the
    workspace export imports the pattern from there.
  - Leave codes are defined in **three** places: `seedIndirectCodes` (`indirect-codes.ts:92-114`), `seed-full.ts:287-307`
    and `scripts/provision-customer-db.ts:39-51` (a blast-radius addition). All three get `leave_pay_type`.
  - Backfill is by code, exactly as CO-D16/C1 specify. An admin-renamed code stays null and blocks the export until set
    (a refusal, not a mis-pay).
  - `leave_pay_type` is required on create and update, including a category change to `leave`.
- **C8:**
  - "The existing comment length rule applies": **no such rule exists**. `saveTimesheetBatch` never validates `comment`
    (`timesheet.ts:209, 392`), so only the non-blank `OTHER` rule is added (no new limit, as written).
  - The client already requires a comment for every code (`ReasonModal.tsx:44`).
  - `period_events` provenance columns go in `allowlists.ts:235-244` (that table is exported through `EXPORT_TABLES`);
    `timesheet_entries` provenance goes in `manifest.ts`/`timesheetSource`.
  - The "every tenant table exported or never-exported" test special-cases `timesheet_entries`, which goes through
    `timesheetSource`.
- **Seeder:** today Sarah and Mike approve their **own** periods, not just peers' (`seed-full.ts:355-357`). C8 makes all
  seeded approvals admin or designee.

## 5. Stale line references in blueprint §1 (behaviour confirmed unless noted)

| Blueprint | Current |
|---|---|
| `migration.ts:137-185`, `:88-119`, `:11-21` | `migration.ts:30-79`; rules in `server/internal/migration.ts:53-85`; type in `src/types/migration.ts:2-12` |
| `migration.ts:189-250` | `:84-157` |
| `periods.ts:302-306, 384-388` (scope check "before anything else") | `:387-391, 450-454`: after the load and the non-admin self-refusal. Order differs; behaviour equivalent |
| `periods.ts:455-460`, `:114-131`, `:134` | `:488-505`, `:120-137`, `:137` |
| `timesheet.ts:426`, `:439-471`, `:280-285`, `:360-373` | `:425-434`, `:443-524`, `:282-289`, `:362-375` |
| `TimesheetContext.tsx:217-218` | `:219-220` |
| `charge-codes.ts:156-161` (assign upserts `user_assignments`) | `server/internal/charge-codes.ts:63-68` |
| `reports.ts:119-171` (PDF) | `:119-172`; route `src/app/api/reports/timesheet-pdf/route.ts`, template `src/lib/reports/timesheet-pdf.tsx` |
| `audit.ts:131` | `:132` |
| `seed-full.ts:358-365` | `:359-365` |
| `manifest.ts:31-44` | `:32-55` |
| `MigrationClient.tsx:106` | `:107` |

## 6. Unrelated bugs noticed (not fixed)

- `src/lib/offline/sync-service.ts:181` falls back to reason `'OFFLINE_SYNC'`, which is not in `REASON_CODES`. The path
  is dormant.
- The timesheet PDF title is hard-coded "Semi-Monthly Timesheet" (`timesheet-pdf.tsx:41`), wrong for weekly/biweekly
  workspaces.
- `updateChargeCode` returns `{ ok: true }` for a missing id (`charge-codes.ts:75-109`).
- Labor-category validation is missing:
  - `createLaborCategory` doesn't check that `slin_id` belongs to `clin_id` (`labor-categories.ts:64-87`).
  - Charge-code `laborCategoryId` isn't checked against the code's CLIN, so CO-D10 level 1 could price at another
    CLIN's rate.
  - `assignUserToLaborCategory` doesn't check end ≥ effective (`:171-190`).
- `importMigrationPeriods` turns an unrecognised status into `draft`, and an unknown reviewer email into null, silently
  (`migration.ts:113-119`). C1 replaces this code.
- `/api/v1/timesheets/approved` selects periods by start date, the same bug as payroll (`route.ts:37-44`). It is not in
  C7's scope.
- Seeded periods omit `periodType`/`periodNumDays` (`seed-full.ts:359-365`).
- **Daily notes are never saved.** Notes from the timesheet's daily-note modal (`DailyNoteModal.tsx`,
  `TimesheetContext` `SET_NOTE`) live only in client state, and nothing sends them to the server. C8 still applies the
  OTHER-needs-a-comment rule there, so the two inputs agree.
- The Gusto connector counts a failed sync-record insert as both pushed and failed: it increments `pushed` before the
  insert and `failed` in the catch (`gusto.ts`, `pushPayroll`, kept as it was in `pushTimesheetEntries`). The log status
  can then read `partial` when nothing was recorded.

## 7. Plan once ruled

These parts are unaffected by Q1–Q7, so they can start as soon as you say go:
- **C1** (migration 0014, which carries every part's schema, plus control-plane 0009, the window, the import rewrite and
  `tenant:admin reopen-import-window`);
- **C6**;
- **C7**;
- **C8**.

C2 waits on Q5; C3 on Q2, Q3 and Q6; C4 on Q1, Q2 and Q4; C5 on Q7. One commit per part, gates after each, a break-it
check per §9 row.

## 8. Reminders for the product owner

- Run `npm run report:cost-basis-change -- <slug>` **before and after C3** (the script lands with C3).
- `npm run build && node scripts/check-build-trace.mjs`, `npm run demo:local` ×2 and the blueprint §10 manual browser
  checks must run on your machine before the PR.
- Integration command:
  ```bash
  CONTROL_PLANE_DATABASE_URL="$(grep '^CONTROL_PLANE_DATABASE_URL=' .env.local | cut -d= -f2-)" ENCRYPTION_KEY="$(grep '^ENCRYPTION_KEY=' .env.local | cut -d= -f2-)" TZ=America/New_York npm run test:integration
  ```
- `docs/payroll-overtime-method.md` (written in C7) is required before production.

## 9. C1 — Migration import (`26d7538`)

**Files.**
- Schema and migrations:
  - `src/db/schema.ts`, `src/db/control-plane/schema.ts`;
  - `drizzle/0014_certified_outputs.sql` (drizzle-kit DDL plus appended triggers and backfills) with its snapshot and
    journal;
  - `drizzle/control-plane/0009_import_window.sql` (drizzle-kit generated; journal idx 9, newest `when`) with its
    snapshot and journal.
- New modules:
  - `src/server/internal/import-window.ts`, `src/server/internal/import-provenance.ts`;
  - `src/lib/migration/import-plan.ts` (pure decisions, limits, splitting), `src/lib/migration/batch-runner.ts`;
  - `src/lib/provenance.ts`.
- Changed:
  - `src/server/actions/migration.ts` (rewritten), `src/server/internal/migration.ts` (+ periods validator),
    `src/types/migration.ts`;
  - `src/server/actions/periods.ts` (`submitPeriod`: shared window lock first, window close);
  - `src/lib/reason-codes.ts` (`REASON_LABELS`);
  - `src/lib/tenant/admin-commands.ts` (`reopenImportWindow`), `scripts/tenant-admin.ts` (`reopen-import-window`;
    `show` prints the window state);
  - `src/app/(app)/admin/migration/MigrationClient.tsx`, `public/templates/migration-timesheet-template.csv`
    ("Entered By");
  - the v1 routes `timesheets`, `periods`, `timesheets/approved`;
  - `src/db/clear-tenant-data.ts`, `scripts/seed-full.ts`;
  - `PRODUCTION-DEPLOY.md` (founder command), `MIGRATIONS.md` (0014 deploy note).

**Commands (at `26d7538`).**
- `npx tsc --noEmit`: clean.
- `npm run lint`: 0 errors, 62 warnings.
- `npm run test`: 1065 passed / 71 files.
- `npm run test:tz`: 1065 passed in each of UTC, Los Angeles and Auckland.
- `npm run db:safety`: passes; 0014 and cp-0009 are additive.
- **Integration: not run here (no Postgres in my sandbox).** The new `integration/migration-import.test.ts` needs
  `CONTROL_PLANE_DATABASE_URL` (the import reads the reopen state); use the integration command in §8.

**§9 rows → tests.** *U* = unit (break-it run by me); *I* = integration (`migration-import.test.ts`, product owner).

| §9 row | Scenario | Test |
|---|---|---|
| Window | open before any submission | U `import-window`; I |
| Window | closed after the first app submission, nothing written | U (rule + `submitPeriod` closes it, static); I |
| Window | imported submitted events don't close it | U (the query filters `source = 'app'`, rendered SQL); I |
| Window | approved period with no events closed after the 0014 backfill | U (backfill SQL as shipped); I (runs the shipped statement) |
| Window | founder reopen allows until T, refuses after (clock injected) | U (clock injected); I (control-plane row, before/after) |
| Window | reopen without a reason refused, nothing written | U (planner + script argument order) |
| Window | old-code app `submitted` event without the flag → closed | U; I |
| Window | control-plane read failure → batch refused | U (fail closed, `UserFacingError`) |
| Periods import dates | period ending today or later → row error; draft → row error | U `migration-import-plan`; I |
| Periods import dates | entries into an imported approved period → refused | U (lock guard on any approved period); I |
| Batch limits | 2,001 rows or 201 employees → server validation error | U (planner and through the actions, before any DB work) |
| Batch limits | validation of a large file is batched | U `migration-batches-and-labels` (5,000 rows → 2,000/2,000/1,000) |
| Batch limits | partial multi-batch close reports committed batches | U (stops at the refused batch, lists remaining rows) |
| Import race / locks | import vs first `submitPeriod` on separate connections | I (per-call connections; xmin order, or refused + nothing written) |
| Import race / locks | lock order: concurrent import (A, B) + submits by A and B never deadlock | I (5 rounds); U (static lock order in `submitPeriod` and both imports) |
| Import guards | legacy approved period, no events (reopened) → refused; app-approved (reopened) refused; imported-approved refused | U; I |
| Import guards | date in any submitted period; app charge-code hours on that CLIN/day; same indirect code/day; existing cell; future date | U; I |
| Batch integrity | every `import_batch_id` resolves; counts equal rows inserted; in-file duplicate → row error | U (duplicate); I |
| Batch integrity | DB error mid-batch → nothing written | I (a temporary trigger forces the failure; batch row absent) |
| Batch integrity | 2,000-row / ~800 KB batch succeeds | U (stays one batch); I (2,000 rows inserted) |
| Attribution | `createdBy` = admin, `createdAt` ≈ now, `source='migration'`, batch row, `original_metadata` (Entered By present/absent) | I |
| Attribution | `MIGRATION` refused by `saveTimesheetBatch`; `import_batches` UPDATE/DELETE/TRUNCATE blocked | U (not in `REASON_CODES`) + I; I (also `admin_change_log`) |
| Period import | `reviewedBy` null; events source migration + original reviewer; duplicates skipped; refused where app rows exist | U; I |
| Display | v1 API `source` / `importedFrom` / imported approval `approvedBy: null` + `approvalSource: 'migration'` | I; U (label helper) |

**Break-it (all run by me; each test failed with its fix undone and passed once restored):**
- entry guards: future date, lock guard, overlap, in-file duplicate;
- period guards: end date, draft/status, imported → skipped, app entries;
- batch limits (rows, employees), the byte split, and the server limit in the action;
- window rule: reopen, app event, missing row; the `source='app'` filter; fail-closed control-plane read; the
  `IS NULL` close predicate;
- lock order: `submitPeriod` shared lock removed, window close removed, import exclusive lock removed;
- the batch runner not stopping on a refusal;
- the reopen planner's reason check and the script's `--reason` requirement;
- `MIGRATION` made pickable; the legacy-import label removed;
- 0014's `admin_change_log` TRUNCATE guard removed, and the leave backfill mis-mapped.

28 mutations; 28 failures.

**Break-its that need Postgres (product owner):**
1. **Lock order.** In `src/server/actions/periods.ts`, move `await lockImportWindowShared(tx);` to after
   `await lockEmployeeTimesheet(tx, userId);`. Expected: the lock-order test fails in some round (a 40P01 deadlock
   rejects a call). Restore and it passes.
2. **Race.** Delete `await assertImportWindowOpen(tx, tenant.id, new Date());` in `importMigrationData`. Expected: the
   race test fails (an import commits after the submission, or the "closed" window tests import rows). Restore.
3. **Rollback.** In `importMigrationData` (the first function with this line), change
   `return await db.transaction(async (tx) => {` to `return await (async (tx: any) => {`, and its matching closing
   `});` (just before `} catch (err) {`) to `})(db);`. The batch then runs without a transaction. Expected: "a DB error
   mid-batch → nothing written" fails, because the batch row and the first rows survive. Restore.

**Deviations from the blueprint (and why):**
1. **Display ordering.** The grid, review, audit trail, revision history, PDF and workspace-export labels land with
   C4 / C6 / C5 / C8, which rewrite those paths. C1 ships the shared helper (`src/lib/provenance.ts`, with
   `REASON_LABELS`), the data, and the v1 API labels. The §9 "Display" row is completed part by part.
2. **`clearTenantData` landed in C1, not C8.** It now clears the new tables and resets the window and workweek, because
   C1's integration cleanup needs it (new FKs to `users`, and a closed window must not leak between tests).
3. **Counts.** `import_batches.skipped_count` = rows not inserted (`row_count − imported_count`).
   `MigrationResult.skipped` counts only already-imported periods; row errors are listed separately. No batch row is
   written when a batch inserts nothing.
4. **Imported period rows.** `reviewComment` and `submittedComment` are also null: the file's comment lives only in
   the events' `original_metadata`, so no unattributed text reads as a CadenzPoint review. The decision event is
   written 1 ms after the submitted event, to keep their order on `created_at`.
5. **Unknown statuses.** An unrecognised period status is a row error, not a silent `draft` as before.
6. **Period validation runs before the transaction.** `resolvePeriod` reads the schedule on its own connection, and
   the rule is never to open a second connection while holding the locks. The window and every lock-dependent fact
   are still checked inside the transaction.
7. **Extra CHECK constraints.** `workspace_settings.workweek_start_day` is null or 0–6, and `leave_pay_type` is null or
   one of the four values. These are defensive, beyond the blueprint's text.

**Open items:** the integration suite and its three Postgres break-its (above); the §10 manual import check (product
owner).

## 10. C2 — Approver rules (`dbff17b`)

### Q8 — ruling needed: re-routing when a designee is deactivated

The blueprint conflicts with itself here.
- **§4 C2 "Re-routing (CO-D19)":** after a change commits, email "every **submitted** period whose eligible-approver
  set **gained** someone, to the newly eligible recipients only".
- **§9 "Self-approval switch":** "waiting timesheet of a supervisor whose designee is deactivated → **admins emailed**,
  approvable".
- **The conflict:** admins can always approve a supervisor's timesheet (`canApprove`: "Other admin → true"). They were
  eligible before the designee was deactivated, and they already got the submission email (when opted in). Under the §4
  rule nobody is gained, so nobody is emailed — the §9 row can't pass as written. The CO-D19 wording ("timesheets
  waiting on a deactivated approver are re-routed (new approvers notified)") suggests the §9 reading.
- **Options:**
  - **(a)** Keep §4 as written: only the newly eligible are emailed, and the §9 row is amended (admins aren't
    re-emailed, because they already were).
  - **(b)** Also treat **losing the effective designee** as a re-routing event. For each waiting period whose
    employee's effective designee becomes null (designee deactivated or demoted, or designation cleared), email the
    period's current eligible approvers (the admins) again; the "gained" rule stays for everything else.
- **Recommendation: (b).** It matches CO-D19 and the §9 row and is a small change, local to `newlyEligible` and its
  snapshot.
- **Ruled (b) — implemented.** The eligibility snapshot also records each waiting timesheet's effective designee. When
  that designee is lost (deactivated, demoted, or the designation removed or changed), every current approver of that
  timesheet is emailed once, with "Its designated approver is no longer available." Otherwise only the newly eligible
  are emailed. The submitter exclusion and the opt-in are unchanged.
- **Tests:** unit — `newlyEligible` covers designee lost / changed / unchanged; the template prints the note; the
  re-routing path passes it. Integration — designee deactivated → both admins emailed once each with the note; a later
  gained admin is emailed without it.
- **Break-it: 4 mutations, 4 failures** — loss not detected; only new recipients; note not passed; template drops the
  note.

### Implemented (gates green; uncommitted)

- **`src/server/internal/approval-rules.ts`** (new). One snapshot of users plus active CLIN assignments
  (`loadApprovalFacts`), with pure rules over it:
  - `effectiveDesignee`, `canApprove`, `reviewScopeFrom`/`reviewScope`;
  - `eligibleApprovers` (the submission recipients), `selfApprovalAvailable`;
  - `recomputeSelfApproval`: compares each admin with the last recorded `self_approval` state and writes
    enabled/disabled with the reason and active-admin count;
  - `selfApprovalContext`, `currentSelfApprovalOn`, `snapshotSubmittedEligibility`/`newlyEligible`.
  Roles, active states and designations always come from the database, never the session token.
- **`src/server/internal/approval-label.ts`** (new). `approvalLabel()` is the one formatter (in-app, Self-approved /
  Self-rejected, imported). It is used by the approvals list and review, the timesheet status badge, the PDF
  (`approvalLine`) and v1 (`selfApproved`).
- **`src/server/internal/submission-notify.ts`** (new). Submission and re-routing emails go to exactly the
  `canApprove` set, excluding the submitter, opted-in only.
- **`src/lib/session.ts`.** `getEmployeeScope` and `assertCanAccessEmployee` delegate to `reviewScope` (CO-D18).
  `supervisor-scope.ts` banner counts include designators; `getSupervisedEmployeeIds` is kept only for its integration
  test.
- **`periods.ts`:**
  - `submitPeriod` sets or increments `submission_count`;
  - approve and reject share `decidePeriod`, with the fresh guard in each exported action. The order is: load →
    non-admin self (existing message) → admin self when not available ("Your timesheet must be approved by another
    admin or your designated approver.") → `canApprove` false → not found → status → `UPDATE … AND submission_count =
    seen` → re-read: "resubmitted…" or the existing concurrent message;
  - a missing `seen` is refused;
  - a self-approval event writes `approval_context`;
  - `getScopedPeriods` returns `canApprove` and the label;
  - the dead `getScopedPendingApprovals` is deleted.
- **`timesheet.ts`.** `getTimesheetForReview` returns `submissionCount` (read before the entries; ordering argued in
  its doc comment), `periodStatus`, `canApprove` and the label. `getTimesheetPeriod` returns `approvalBadge`.
- **User writers** call `recomputeSelfApproval` and the re-routing snapshot in one transaction:
  - `users.ts`: `createUser`, `updateUser`, `createUserWithPassword`, and the new `setUserApprover` (validated, logged
    as `user/approver_changed`);
  - `import.ts`: `bulkImportEmployees` (now one transaction with a savepoint per row, so a failing row is still
    reported per row);
  - `provision.ts`: the baseline row ("workspace created"), only when it inserts the admin;
  - `seed-full.ts`: once after the users are seeded.
- **UI:**
  - Approvals: "You can view but not approve this timesheet"; the explicit self-approval-off message; decisions wait for
    the review data and send `seen`; badges come from the server.
  - Users: an Approver select for supervisor/admin users only (`src/lib/approvals/approver-options.ts`).
  - Notices: "Self-approval is back on" on the dashboard and Approvals, keyed by the log row; the designee
    recommendation on the dashboard and Users, cleared at sign-out (`ApprovalNotices`).
  - The timesheet toolbar shows the self-approval badge.

### Tests and break-it

- **Unit `approval-rules.test.ts`:**
  - §5 approval table: peer, designee, admin self (second admin, designee, designee lost), demoted designee, demoted
    supervisee, undesignating admin, mutual designation;
  - designee scope (no CLINs → {self, X});
  - recipients (designee yes, peer no, never self), `newlyEligible`;
  - Approver select shown/hidden.
- **Unit `approval-decisions.test.ts`:**
  - `approvalLabel` (in-app, self, legacy, imported, rejected);
  - `recomputeSelfApproval` (enabled with count 1, nothing with a designee, disabled, demoted admin, idempotent);
  - approve/reject through the real action with a scripted DB: missing `seen`, "resubmitted" vs concurrent, the
    UPDATE's predicates, non-admin self, admin self off, peer → not found, `approval_context` written;
  - static: every role / is_active / approver_id writer recomputes (with fixture); no other "Self-approved" formatter;
    the client sends `seen`; review ordering.
- **Integration `approver-rules.test.ts` (product owner)** covers the same rows end to end: the §9 Approver, Approver
  (base), Stale approval, Approval rows, Self-approval switch, Designee scope (approvals, review, revision history,
  audit trail, hours report, PDF) and label rows. Existing tests were updated for `seen`: `authorization`,
  `fresh-authorization`, `dcaa-concurrency`, `submission-emails`.
- **Break-it: 22 mutations, 22 failures**, covering:
  - the designee rules, peer approval, admin self, the designator scope, recipients, `newlyEligible`, the designee
    check in self-approval;
  - recompute idempotence and demoted admins;
  - label self/imported;
  - missing `seen`, the `submission_count` predicate, the resubmitted message, the admin self check,
    `approval_context`;
  - the writer recompute (`setUserApprover`, bulk import), a second formatter, the client `seen`, the select for
    employees.
- **Gates at `dbff17b`:** tsc clean; lint 0 errors / 62 warnings; 1108 unit tests ×4; db:safety passes.

### Deviations (so far)

1. **Seed scripts run under the react-server condition.** `seed:demo` and `db:seed:full` now run with
   `node --conditions=react-server --import tsx`, like `tenant:admin` and the other ops scripts. `seed-full` must import
   the real `recomputeSelfApproval` (ruling Q5), which is `server-only`. Checked: the module graph loads with the
   condition and fails without it.
2. **The label lands in C6/C8 for two places.** The "Self-approved" label in the audit trail's period events and the
   export's derived column come with C6 (the audit trail has no period-event view today) and C8 (export).
3. **The "back on" notice needs an earlier "disabled" row.** It shows only when self-approval came back on after being
   off, so the "workspace created" baseline row doesn't show "back on" on a new workspace.
4. **The approval email keeps the approver's name.** For a self-approval it still says "approved by {admin's name}";
   the email is not in the blueprint's label list, and the static test keeps every "Self-approved" literal inside the
   helper.

## 11. C3 — Cost / hours reports (`25cd351`)

**Files.**
- New:
  - `src/server/internal/cost-basis.ts`: the lateral resolution, the `decideCostBasis` mirror, the priced-cost and
    unpriced-hours sums, and the Unpriced / Overlap report queries plus the fix text;
  - `src/lib/cost-labels.ts`, `src/components/costs/UnpricedNote.tsx`;
  - `src/app/(app)/admin/labor-categories/CostBasisReports.tsx`;
  - `scripts/report-cost-basis-change.ts` with `scripts/lib/cost-basis-change.ts`, and the npm script
    `report:cost-basis-change`.
- Changed:
  - the five joins: `server/internal/reports.ts`, `actions/reports.ts` (employee summary), `actions/dashboard.ts`
    (CLIN cost, SLIN cost, period report);
  - `DashboardClient`, `ReportsClient`, the CSV / XLSX exports, `/api/v1/costs`, the API-key dialog;
  - `labor-categories.ts` (reports, end date) and its page;
  - `charge-codes.ts` (`updateChargeCode` lock, refusal and log; `deactivateChargeCode` log; `reactivateChargeCode`;
    `getChargeCodeReactivationInfo`) and `ChargeCodesClient` (Reactivate + dialog);
  - `timesheet.ts` (`FOR SHARE` re-read).

**§9 rows → tests.** *U* = unit (break-it run by me); *I* = integration `cost-basis.test.ts` (product owner).

| §9 row | Scenario | Test |
|---|---|---|
| Unpriced | no applicable category → unpriced, hours counted, no cost, listed with `no-category` | U (`decideCostBasis`, SQL, cost CASE); I |
| Unpriced | two categories at the CLIN level, same date → unpriced `conflict` | U; I (plus the fix text and the overlap report) |
| Unpriced | SLIN-level category on a different SLIN → unpriced (not borrowed) | U (SQL predicates); I |
| Unpriced | footer count shown | U (dashboard, CSV, XLSX, v1 static/rendered); I (summaries, period report, v1) |
| Unpriced visibility | dashboard funding bar "X hours unpriced" + link, "priced cost" | U (static); I (data) |
| Unpriced visibility | cost report CSV / XLSX carry the count | U (XLSX read back; CSV static) |
| Unpriced visibility | Unpriced report rows show the fix text with links | U (fix text); I |
| Unpriced visibility | `report:cost-basis-change` prints old vs new per CLIN (read-only) | U (merge/format; script read-only, banner, frozen join, npm script) |
| Cost basis | used code's LCAT change logged (ruling Q3: no UI warning) | U; I |
| Cost basis | charge code with LCAT uses it; SLIN-matched assignment for a SLIN entry | U; I |
| Cost basis | LCATs on two CLINs: summary hours = true hours, one detailed row per entry | I |
| Cost basis | deactivated LCAT keeps historical cost | U (no status filter); I |
| Cost basis | overlap report lists overlaps; promotion (end yesterday, start today) works | U (`findOverlaps`, end date); I |
| Cost basis | static import test | U (allowlist + fixture + five join sites) |
| Charge code | CLIN change racing a first save uses in-transaction values | U (static `FOR UPDATE` / `FOR SHARE`); I (separate connections, 3 rounds) |
| Charge code | used code CLIN/SLIN change refused; unchanged `clinId` accepted; unused code editable | U; I |
| Corrections (CO-D8) | `reactivateChargeCode` logs + assignable only with active CLIN/contract; deactivate logged | U; I |
| Change log | LCAT change, deactivate, reactivate each write one row (old/new) | U; I |

**Break-it: 23 mutations, 23 failures**, covering:
- `decideCostBasis` (conflict, charge code);
- the SQL (SLIN borrowed at CLIN level, status filter, conflict priced), and cost summing unpriced entries;
- an extra labor-category importer, and a join site left on the old join;
- the overlap boundary, the conflict fix text, the label at 0, the dashboard CLIN note;
- the script (banner, difference sign);
- the used-code CLIN change, the LCAT log, `FOR UPDATE`, `FOR SHARE`, the deactivate log, the reactivate count;
- the end-date check, the XLSX row, the CSV footer.

**Gates at `25cd351`:** tsc clean; lint 0 errors / 62 warnings; 1144 unit tests ×4; db:safety passes.

**Product owner:** run `npm run report:cost-basis-change -- <slug>` once C3 is on the branch you test, and again after
deploying. The script computes the old join (frozen) and the new resolution on the same data, so each run shows what
moves.

**Deviations / notes:**
1. **The rule exists twice, deliberately.** The decision is the SQL `CASE` in the lateral (as the blueprint
   prescribes), plus a pure TS mirror `decideCostBasis` used by the unit tests. A static test asserts the SQL's
   predicates and `CASE` match the mirror. The SQL itself only runs in the integration suite: my sandbox can't start
   Postgres (an initdb attempt failed on `shmget: Operation not permitted`).
2. **Unpriced hours report is capped.** It shows at most 500 entries (`truncated` flag, "first 500 entries shown"); the
   dashboard and report totals are never capped.
3. **Unpriced period-report rows.** The period cost report groups unpriced hours into their own "Unpriced" rows (cost
   0), next to the priced rows.
4. **`updateChargeCode` and a missing id.** It now returns `not_found` for a missing id; it used to return
   `{ ok: true }`, a bug listed in §6. This came with the blueprint's "compare against the stored row".
5. **When a labor-category change is logged.** Only for a used code, as written. A change on an unused code isn't
   logged.
6. **Still not validated (§6, unchanged).** A charge code's labor category isn't checked against the code's own CLIN,
   so level 1 can price with another CLIN's category.

## 12. C4 — Timesheet grid and corrections (`1cbb72a`)

**Files.**
- New:
  - `src/lib/timesheet/cell-rules.ts`: `isCellEditable` (the grid) and `newCellRefusal` (the server). One rule: a day
    with a prior revision can be corrected on any row; an empty day can be filled only on an assignable row.
- Changed:
  - `src/types/timesheet.ts`: `ChargeCode.kind` (`charge` | `clin` | `indirect`) and `assignable`, plus
    `TimesheetEntry.provenance`.
  - `src/server/actions/timesheet.ts`:
    - `getPeriodCodesForEmployee` builds the period's list: assignable codes ∪ every code with an entry in the period,
      0-hour rows included. Extra rows have `assignable: false`; legacy CLIN rows are `kind: 'clin'`, labelled
      `CLIN n`.
    - `getTimesheetPeriod` returns the list as `chargeCodes`, and the review uses the same list.
    - Entries carry per-day provenance.
    - `saveTimesheetBatch` decides per cell, inside the transaction, after reading `priorRevision` (below).
  - `TimesheetContext`: `SET_PERIOD_DATA` replaces the list on navigation; the save maps each cell by kind
    (`cellRefForKind`).
  - `page.tsx` takes the list from `getTimesheetPeriod`.
  - `HourCell` uses `isCellEditable`, shows a tooltip on read-only empty days, and an imported-cell dot.
    `ChargeCodeCell` shows the "No longer assigned" label.
  - ApprovalsClient review shows provenance markers and the "No longer assigned (recorded hours shown)" row label.
  - Offline (`db.ts`, `offline-store.ts`, `sync-service.ts`): codes and queue items store `kind`; the sync maps by kind
    (`queueItemCellRef`).

**The save, per cell (rulings Q1 / Q2 / Q4).**
- **Assignment checks moved.** The pre-transaction checks (`validateChargeCodeAssignment` / `validateClinAssignment`)
  are gone. The facts are read inside the transaction after the `FOR SHARE` re-read: active assignment, code / CLIN /
  contract status, and indirect state.
- **A new cell (`priorRevision === 0`)** must pass `newCellRefusal`:
  - not assigned → the existing `AuthorizationError` "Unauthorized: You are not assigned to charge code …";
  - code, CLIN or contract inactive → "This charge code is no longer active …";
  - indirect code inactive or not available → "Indirect code … is not available.";
  - a CLIN-only cell → always refused (Q1).
- **A cell with a prior revision** is a correction:
  - the reason code is still required, and the period lock still applies;
  - it may set the hours to 0 ("Leave pre-set");
  - a legacy CLIN correction takes its SLIN from the prior revision, and a different client SLIN is refused.

**§9 rows → tests.** *U* = `unit/grid-corrections.test.ts` (break-it run by me); *I* =
`integration/grid-corrections.test.ts` (product owner).

| §9 row | Scenario | Test |
|---|---|---|
| Grid assignable | new day on an unassigned code refused (forbidden); on a deactivated code refused | U (scripted DB through the real action); I |
| Grid assignable | read-only empty days on non-assignable rows; correctable recorded days | U (`isCellEditable`, HourCell wiring) |
| Grid assignable | legacy CLIN: new CLIN-only cell refused (Q1) | U; I |
| Grid/review | period list = assignable ∪ recorded; a code shows only in periods where it has hours; replaced on navigation | I (`getTimesheetPeriod` for two periods); U (reducer and page wiring) |
| Grid/review | review shows every recorded hour (unassigned and CLIN rows) | I (total 11 h across both rows) |
| Corrections (CO-D8) | correction on a deactivated / unassigned code saved with a reason | U; I |
| Corrections (CO-D8) | correction without a reason refused | U; I |
| Corrections (CO-D8) | correction in a submitted period refused | U (lock mocked); I (real lock) |
| Corrections (CO-D8) | legacy CLIN correction keeps the prior SLIN; a different SLIN refused | U; I |
| Corrections (CO-D8) | inactive indirect: correction allowed, new day refused | U; I |
| Leave pre-set | correction to 0 on a deactivated code | U; I (stored `0.00`, rev 2, row still listed) |
| Display | imported cell labelled in grid / review | I (`provenance[0]` text); U (static marker) |
| Save mapping | `charge` → chargeCodeId, `clin` → clinId, `indirect` → indirectCodeId; offline items with no kind → charge | U |

**Break-it: 14 mutations, 14 failures**, covering:
- `isCellEditable`, both directions;
- `newCellRefusal` (CLIN-only allowed; the active state ignored);
- the server rule applied to every cell, and skipped entirely;
- the legacy CLIN SLIN, both directions;
- the assignment fact replaced by `true`;
- the client / offline kind mapping (three cases);
- HourCell ignoring `assignable`;
- the reducer keeping the old list.

**Postgres break-its for the product owner** (each should fail `integration/grid-corrections.test.ts`):
1. Remove `eq(userChargeCodes.isActive, true)` from `assignedCodes` in `saveTimesheetBatch`. The "unassigned" test
   then saves a new day.
2. In `getPeriodCodesForEmployee`, return only `assignable`, dropping `extraCharge` / `extraClin` / `extraIndirect`.
   The "deactivated", "legacy CLIN", "indirect" and review tests then fail.
3. Drop the period-date filter from the `recorded` query. The "unassigned" test's `other` period then lists the code.

**Gates at `1cbb72a`:** tsc clean; lint 0 errors / 62 warnings; 1155 unit tests ×4; db:safety passes.
- `npm run db:safety` hit `listen EPERM` on tsx's IPC pipe in my sandbox this time. That's not a code fault: the same
  script passes under `node --import tsx scripts/check-migration-safety.ts`. C4 adds no migration.

**Deviations / notes:**
1. **A legacy CLIN correction can't change its SLIN.** The prior revision's SLIN is copied, and a different client SLIN
   is refused. The blueprint says the correction "keeps the recorded allocation"; refusing a change is stricter than
   silently ignoring it.
2. **Unassigned keeps its old error.** It stays an `AuthorizationError` (`forbidden`) with the old message, so the
   existing RBAC integration tests (`charge-code-actions.test.ts`) still hold. The other refusals are
   `UserFacingError` (`validation`).
3. **Offline items queued before C4 have no `kind`.** They are treated as `charge`, unless they carry an
   `indirectCodeId`. Before C4 the grid had no CLIN rows, so this is exact.
4. **`revisionMapFor` keys differently from the entries read.** It keys `chargeCodeId ?? clinId ?? indirectCodeId`;
   the entries read uses `chargeCodeId ?? indirectCodeId ?? clinId`. The two agree, because indirect rows have a null
   `clin_id`. C6 makes cell identity one COALESCE everywhere.
5. **The offline `'OFFLINE_SYNC'` reason fallback** (§6) is still unfixed: it's unrelated, and the path is dormant.

## 13. C5 — Timesheet PDF from entries (`1ff4988`)

**Files.**
- New:
  - `src/lib/reports/timesheet-rows.ts`:
    - `buildTimesheetRows` (pure) makes one row per true cell code from latest-revision entries: a charge code, a
      legacy CLIN, or an indirect code with its category.
    - Sums are in integer hundredths, and the sort order is fixed (charge → CLIN → indirect, then contract / CLIN /
      code, then id).
    - Each row carries the provenance of its imported cells.
    - `timesheetRowLabel` formats the row label.
  - `src/lib/indirect-categories.ts`: the indirect-category display names, moved out of `timesheet.ts` so the PDF
    (and C6) can share them.
- Changed:
  - `actions/reports.ts` `getTimesheetReportData`:
    - one latest-revision query with LEFT JOINs (charge code, CLIN, contract, SLIN, indirect code, import batch,
      importer) replaces the assignment query;
    - `TimesheetReportData.chargeCodes` becomes `rows: TimesheetRow[]`;
    - access is still `assertCanAccessEmployee`, which delegates to `reviewScope` since C2.
  - `lib/reports/timesheet-pdf.tsx` uses the row labels and numbered imported-hours notes `[n]`. The approval line is
    unchanged (C2 helper).

**§9 rows → tests.** *U* = `unit/timesheet-pdf-rows.test.ts` (break-it run by me); *I* =
`integration/timesheet-pdf.test.ts` (product owner).

| §9 row | Scenario | Test |
|---|---|---|
| PDF | indirect / leave rows, with category | U; I |
| PDF | two codes on one CLIN, same day, both present | U; I (3 h + 5 h on day 0, no active CLIN assignment) |
| PDF | rows not from assignments (deactivated assignment still prints) | U (static: no `userAssignments`); I |
| PDF | latest revision only | I (rev 2 = 4 h wins over rev 1 = 3 h) |
| PDF | total = sum of entries (exact) | U (0.29 + 1.13 = 1.42); I (17.3) |
| PDF | stable reprint (Q7: rows, totals, approval line identical) | U (any input order → identical output); I (two calls deep-equal, with and without an approval) |
| Display | imported rows labelled on the PDF | U (provenance on rows, PDF renders); I (Deltek label on the CLIN row) |
| Self-approved label | PDF approval line from the one helper | U (static); I (in-app approver) |

**Break-it: 10 mutations, 10 failures**, covering:
- rows keyed by CLIN (the old overwrite);
- indirect rows dropped;
- float sums, no sort, an out-of-window day counted;
- the category dropped, provenance dropped, a mixed SLIN shown;
- the action joined back to assignments;
- the approval line removed from the PDF.

The float-sum mutation first **survived**: 0.1 and 0.2 multiply by 100 exactly. I switched the test to 0.29 + 1.13, and
the mutation now fails as it should.

**Postgres break-it for the product owner:** in `getTimesheetReportData`, change the latest-revision subquery's
`COALESCE(...)` comparison to `te2.clin_id = timesheet_entries.clin_id`. The integration test's NAV-A / NAV-B rows then
show only the highest revision per CLIN-day.

**Gates at `1ff4988`:** tsc clean; lint 0 errors / 62 warnings; 1164 unit tests ×4; the migration-safety script passes.
`npm run db:safety` still hits the sandbox's tsx IPC `listen EPERM`; see §12.

**Deviations / notes:**
1. **0-hour rows print.** A row whose latest revisions are all 0 (a correction to zero) is printed with "—" days and
   0.00 total. That matches "rows from latest-revision entries" and the grid / review (C4). Tell me if the PDF should
   drop all-zero rows.
2. **The footer's generation time still changes on every print**, as ruled in Q7.
3. **Reprint stability has two limits outside C5:**
   - The approval line reads the approver's **current** name from `users`, so renaming the approver changes later
     reprints.
   - Changing the workspace timezone changes the formatted dates.
   - Making these stable would need the name and timezone snapshotted at decision time, which is a C2 / schema
     change. Not done; flagging for a ruling if wanted.
4. **The hard-coded "Semi-Monthly Timesheet" title** (§6) is unchanged: it's unrelated.

## 14. C6 — Audit trail (`da319a1`)

**Files.**
- New:
  - `src/lib/cell-code.ts`: `cellKind`, plus `cellCodeLabel` (e.g. "NAV-0001", "CLIN 0001", "LV-PTO (Leave)").
- Changed:
  - `actions/audit.ts`:
    - `getAuditEntries` LEFT JOINs CLIN, contract, SLIN, charge code, indirect code, import batch and importer, so
      indirect entries appear. Each row carries its true `cellCode`, `kind`, `codeLabel`, indirect category and
      `provenance`.
    - `getCellRevisionHistory(userId, cellCode, entryDate)` matches
      `COALESCE(charge_code_id, indirect_code_id, clin_id) = cellCode` (bound parameter, UUID validated first) and
      returns provenance per revision.
    - New `getAuditPeriodEvents`: same scope as the entries, filtered by employee and period start.
  - `internal/approval-label.ts`: new `periodEventLabel`, which shares its wording with `approvalLabel`. Imported
    decision text is factored out; `approvalLabel`'s output is unchanged.
  - `AuditTrailClient`:
    - a Code column with an "Imported" badge and the provenance tooltip;
    - Reason via `reasonLabel`, so MIGRATION shows "Imported (migration)";
    - "Entered By" shows the import label for imported rows;
    - the drawer opens by `cellCode`, shows the code and category, and the import label per revision;
    - a new "Timesheet events" section shows each event's label, the self-approval context and the comment.
  - `timesheet.ts`: the cell key order is now `chargeCodeId ?? indirectCodeId ?? clinId` everywhere (C4 note 4).

**§9 rows → tests.** *U* = `unit/audit-trail.test.ts` (break-it run by me); *I* = `integration/audit-trail.test.ts`
(product owner).

| §9 row | Scenario | Test |
|---|---|---|
| Audit | indirect entries appear (with category) | U (mapping and static LEFT JOINs); I |
| Audit | sibling codes on one CLIN, same day → separate histories | U (static COALESCE; UI passes `cellCode`); I (3 → 4 h vs 5 h) |
| Audit | MIGRATION label | U (`REASON_LABELS`, legacy provenance, UI uses `reasonLabel`); I |
| Display | audit list and revision history label imported rows (source, date, admin; author or "not recorded") | U; I |
| Self-approved label | audit trail period events show "Self-approved" (one helper; existing static test still passes) | U; I |
| Self-approval switch | the self-approval event's `approval_context` shown (active admins, switched on at / by) | U; I (switched on by a different user) |
| Designee scope | audit trail and revision history scoped by `reviewScope` | existing `approver-rules` integration (unchanged; legacy CLIN cells → `cellCode` = CLIN id) |

**Break-it: 15 mutations, 14 failures in the unit suite.**
- The 14 caught: INNER JOIN on CLIN, clin-first cell code, history filtered by `clin_id`, UUID validation removed,
  entry / revision provenance dropped, category dropped, the MIGRATION label removed, a self-approval labelled as
  ordinary, the context dropped, an imported submission shown as app, and three UI wirings.
- **Survivor (A11):** skipping the name lookup for `selfApprovalEnabledBy`. The fake DB returns scripted users whatever
  ids are requested. I made the integration test switch self-approval on as a different user (Bo), so the mutation
  shows "an unknown user" there. **Postgres break-it for the product owner:** delete
  `if (typeof by === 'string') ids.add(by);` in `getAuditPeriodEvents`. The integration "period events" test should
  fail.

**Gates at `da319a1`:** tsc clean; lint 0 errors / 62 warnings; 1177 unit tests ×4; the migration-safety script passes.

**Deviations / notes:**
1. **The period-events date filter uses the period start**, matching the timesheet the event belongs to. Contract,
   CLIN, reason and "corrections only" don't apply to period events; the section says so.
2. **Malformed `cellCode` throws.** It raises `UserFacingError` ("Cell code is not a valid identifier."), like the
   other read actions' validation. It is only reachable with a tampered call.
3. **Summary cards are unchanged.** They count every entry; they already included indirect entries because that query
   never joined `clins`.

## 15. C7 — Payroll export, FLSA weekly overtime (`4df0ad3`)

**Files.**
- New:
  - `src/lib/payroll/flsa.ts`: the pure walk, in integer hundredths, with `workweekStart`, `toCents` and
    `computeFlsa`.
  - `src/server/internal/payroll-data.ts`:
    - reads all latest-revision entries in [workweek start of the range start, range end], plus each date's
      containing period;
    - `PayrollNotReadyError` covers both refusals (workweek unset; leave codes without a pay type).
  - `src/lib/csv/escape.ts`: RFC 4180 with CR, plus `FORMULA_PATTERN`.
  - `docs/payroll-overtime-method.md`.
- Changed:
  - `connectors/payroll-export.ts`:
    - all four formats are rebuilt on the FLSA totals, plus the Daily hours detail;
    - filenames carry `flsa-weekly-overtime`;
    - the old `aggregateEntriesByEmployee` (OT over 80 per period) and the unused `generateExportFile` are removed.
  - `actions/payroll-export.ts`: both actions return `ActionResult`. The preview returns a structured refusal (reason
    and codes).
  - Gusto:
    - `sync-engine.ts`: payroll connectors are loaded via `payroll-data` **before** the sync log; QBO is unchanged on
      `getApprovedEntriesForSync`.
    - `gusto.ts`: `pushPayroll` records regular, OT, PTO, sick, holiday, uncompensated OT and the flag.
    - `types.ts`: adds `pushPayroll` and `PayrollSyncInput`.
  - `PayrollExportClient`:
    - the "FLSA weekly overtime" label, help text and exempt-deduction note;
    - refusal alerts linking to Settings or Indirect Codes;
    - flagged employees listed before download;
    - the leave columns;
    - a Daily hours detail button.
  - Settings:
    - `getWorkweekStartDaySetting` and `updateWorkweekStartDay` (fresh admin, transaction, `admin_change_log`);
    - a Workweek section with no default, plus a confirmation modal citing 29 CFR 778.105 before changing a set value.
  - Indirect codes:
    - `leave_pay_type` is required for leave and cleared otherwise, in create and update;
    - the page shows a Pay type field and column, with a "blocks payroll export" badge when it's missing;
    - `seedIndirectCodes` and `provision-customer-db.ts` pre-set LV-AL / LV-SL / LV-HOL / LV-LWOP.
  - `csv-generator.ts` uses `escape.ts`; `workspace-export.ts` re-exports `FORMULA_PATTERN` from it.

**§9 rows → tests.**
- *U* = `unit/payroll-flsa.test.ts` (pure) and `unit/payroll-export-actions.test.ts` (scripted DB); break-its run by me.
- *I* = `integration/payroll-flsa.test.ts` (product owner).

| §9 row | Scenario | Test |
|---|---|---|
| FLSA | 45 h week → 40 + 5 OT (on the day it occurs) | U; I |
| FLSA | 40.00 h exactly → 0 OT (integer hundredths) | U (8.29 × 4 + 6.84 — floats give 3999.9999999999995); I (13.33 / 13.33 / 13.34) |
| FLSA | exempt → 0 OT + uncompensated | U; I |
| FLSA | leave excluded from the 40, in its own columns in every format | U (leave first in the week; all formats); I (ADP / custom) |
| FLSA | boundary week across two semi-monthly exports: preceding days counted, no double count | U; I (§10 hand calculation: 20 + 0, then 60 + 9 = 89 h worked) |
| FLSA | range over two periods, the first unapproved, week crossing → unapproved days count, only approved in-range days output, flagged | U (walk; data selection); I (Thursday workweek: 36 h unapproved + 8 h → 4 + 4, flagged) |
| FLSA | arbitrary mid-period range includes in-range days of a period that started earlier | U (data, scripted periods); I (10–20 → 58 + 4) |
| FLSA | refused without the workweek setting | U (data, preview, CSV, Gusto); I |
| FLSA | Gusto push payload + refuses before a sync log | U; I |
| FLSA | Gusto CSV and connector carry OT; custom columns | U; I |
| Leave columns | 40 h + 8 h holiday → 0 OT, holiday in its own column; LWOP never paid; pay type missing → refused; ADP Total = R + OT + PTO + Sick + Holiday; backfill | U; I (backfill in C1's `0014` and its test) |
| Gusto / exempt | Gusto CSV has the five hour columns and no `hours`; they sum to total paid; exempt: 0 OT in vendor files, uncompensated in custom + daily detail | U; I |
| Leave pre-set | new workspace after `seedIndirectCodes` exports without setting a pay type; unpaid leave in daily detail + custom (`Total recorded` includes it, `Total paid` doesn't) | U; I |
| Change log | workweek change writes one row (old → new) | U; I |
| CSV | formula-leading values prefixed `'` (payroll + report CSVs); plain negatives untouched; CR quoted | U |

**Break-it: 31 mutations, 27 caught at first run; every one is now covered.**
- Caught in the unit suite:
  - the FLSA engine: threshold 80, no weekly reset, exempt paid OT, unapproved days skipped, no flag, boundary days
    reported, unpaid leave in total paid, wrong `workweekStart`;
  - the layouts: ADP Regular including leave, the Gusto `hours` column, an uncompensated column in ADP, Paychex codes
    always set;
  - CSV: no formula guard, CR unquoted, negatives prefixed;
  - refusals: workweek check skipped, pay-type check skipped;
  - output ignoring approval;
  - Gusto: refusal moved after the log, payload fields dropped;
  - settings: change not logged, range unchecked;
  - leave codes accepted without a pay type, a built-in not pre-set;
  - the CSV action not wrapped in `userAction` (re-run as a two-part edit; my first attempt didn't compile).
- **Survivors fixed by strengthening the tests:**
  - **F2, float hours.** 13.33 / 13.34 multiply by 100 exactly. The test now uses 8.29 × 4 + 6.84.
  - **F3, leave counted toward 40.** The holiday came after the worked days, so it couldn't change anything. The leave
    now comes first in the week.
- **Survivors only Postgres can catch** (the fake DB ignores `where`). **Product owner:** each should fail
  `integration/payroll-flsa.test.ts`.
  - **D4:** in `loadPayrollData`, change `const from = workweekStart(rangeStart, workweekStartDay);` to
    `const from = rangeStart;`. The §10 hand calculation (16–31 → 60 + 9) breaks.
  - **D5:** change `gte(timesheetPeriods.periodStart, addDays(from, -31))` to
    `gte(timesheetPeriods.periodStart, rangeStart)`. The mid-period range (10–20 → 58 + 4) breaks.

**Gates at `4df0ad3`:** tsc clean; lint 0 errors / 59 warnings (3 fewer: code removed); 1209 unit tests ×4; the
migration-safety script passes.

**Deviations / notes:**
1. **The payroll actions now return `ActionResult`.** That follows blueprint line 6 ("every action here uses P4's
   ActionResult"). Before, they threw, and Next redacts thrown errors in production. They stay on the read-only
   allowlist (no write).
2. **The preview returns refusals as data**
   (`{ status: 'refused', reason, codes, message }`), so the screen can link to Settings or Indirect Codes. CSV
   generation returns a failed result with the same message.
3. **The leave-pay-type check covers in-range days only.** Leave before the range (boundary days) never counts toward
   the 40 and is never output, so it can't affect the files.
4. **The flag rule.** An employee is flagged when a reported day with worked hours follows unapproved worked hours in
   the same workweek. An unapproved day after the reported days can't change their split, so it doesn't flag.
5. **The workweek log row uses a placeholder id.** `admin_change_log.entity_id` is a uuid and `workspace_settings` has
   none, so the row uses entity `workspace_settings` with the nil UUID. The first set (null → day) is also logged.
6. **`pay_period_start` / `pay_period_end` are now the export range.** Before, they were each employee's first and last
   entry date.
7. **Gusto still makes no API call.** It records the payload in the sync log, as the blueprint says. The double count
   noted in §6 (pushed and failed both incremented) is kept as it was.
8. **The seeder (`seed-full.ts`) pay types come in C8.** `seedIndirectCodes` and `provision-customer-db.ts`, both
   product paths, are done here.

## 16. C8 — Small items (`c17810c`)

**Files.**
- OTHER needs a comment:
  - `src/lib/reason-codes.ts` gains `reasonNeedsComment` and `OTHER_REASON_COMMENT_REQUIRED`.
  - `saveTimesheetBatch` refuses OTHER with a blank comment, after the reason-code check.
  - `ReasonModal` blocks it (it already required a comment for every reason), and so does `DailyNoteModal`.
- Workspace export:
  - `allowlists.ts`: new columns `users.approver_id`, `indirect_charge_codes.leave_pay_type`,
    `timesheet_periods.submission_count`, and `workspace_settings.history_import_closed_at` + `workweek_start_day`.
  - `period_events` gains `source`, `import_batch_id`, `original_metadata` and `approval_context`, and its `actor_id`
    description explains imported rows.
  - New files: **`import_batches.csv`** and **`admin_change_log.csv`**.
  - A **derived** `self_approved` column on `timesheet_periods` and `period_events`. It is computed in SQL with the
    same rule as `approvalLabel`; derived columns are a new `expr` on `ExportTableConfig`.
  - `workspace-export.ts` `timesheetSource` adds `source`, `import_batch_id`, `original_metadata` and the derived
    **`provenance`** label (via `provenanceText`); `manifest.ts` documents them.
- `clearTenantData`: already complete since C1. C8 adds the order and reset checks.
- Seeder (`seed-full.ts`, reused by `seed:demo`):
  - supervisors get `approver_id = admin`;
  - approvals follow C2: a supervisor's timesheet is approved by the admin (their designee), an employee's by a
    supervisor who shares a CLIN; a `reviewerFor` check throws otherwise;
  - `period_events` (submitted and approved, source app) are written for every seeded submission;
  - `submission_count` is 1 on non-draft periods;
  - `workweek_start_day = 1`;
  - leave codes get their pay type.

**§9 rows → tests.** *U* = `unit/certified-small-items.test.ts` and `unit/export-allowlists.test.ts`; *I* =
`integration/export-workspace.test.ts`, new C8 case.

| Item | Test |
|---|---|
| OTHER without a comment refused (server); client blocks it | U (through `saveTimesheetBatch`; static on both modals) |
| export: entries / period_events provenance, `import_batches`, `admin_change_log` (§9 "Change log": table in the export), new columns, descriptions | U (allowlist and column order); I (real archive) |
| Display: the export labels migrated rows | I (`provenance` column) |
| Self-approved label: the export's derived column | U (rendered SQL); I (true for a self-approval; false for an imported or ordinary approval) |
| every tenant table exported or never-exported | U (schema introspection; no stale entries; no overlap) |
| `clearTenantData` order + resets | U (static) |
| seeder conformance | U (static) |

**Break-it: 16 mutations, 16 failures**, covering:
- the server OTHER check, whitespace handling, both modals;
- `clear`: `admin_change_log`, workweek reset;
- seed: approval events, supervisor approver, workweek, leave pay type;
- export: `admin_change_log` file, `import_batches` dropped (re-run as a real deletion; my first mutation didn't
  compile), provenance label, `self_approved` ignoring imports, the `approver_id` header, the never-exported list
  growing.

**Gates at `c17810c`:** tsc clean; lint 0 errors / 59 warnings; 1221 unit tests ×4; the migration-safety script passes.

**Deviations / notes:**
1. **Seeder checks are static.** Running the seeder needs Postgres. The product owner's `npm run demo:local` (twice)
   exercises it for real, and `reviewerFor` throws if any seeded employee has no supervisor sharing a CLIN.
2. **The admin keeps no designee in the demo.** A sole admin's self-approval stays available, and `recomputeSelfApproval`
   records that as before. The demo has no admin timesheets.
3. **OTHER rule and existing reasons.** No new comment-length limit was added (no limit existed). Corrections with
   other reasons keep their current rules.

---

## 17. Hand-off — all parts committed (`26d7538` … `c17810c`), not pushed

| Part | Commit | Break-it (unit) | Postgres-only checks for the product owner |
|---|---|---|---|
| C1 migration import | `26d7538` | 28/28 | lock order, race, rollback (§9) |
| C2 approver rules | `dbff17b` | 26/26 (incl. Q8) | — (integration `approver-rules`) |
| C3 cost basis | `25cd351` | 23/23 | SQL semantics (integration `cost-basis`) |
| C4 grid corrections | `1cbb72a` | 14/14 | 3 (§12) |
| C5 PDF | `1ff4988` | 10/10 | 1 (§13) |
| C6 audit trail | `da319a1` | 14/15 (A11: Postgres) | 1 (§14) |
| C7 payroll FLSA | `4df0ad3` | 29/31 (D4, D5: Postgres) | 2 (§15) |
| C8 small items | `c17810c` | 16/16 | — (integration export case) |

**Product owner — on your machine, before the PR:**
1. **Integration suite.** My sandbox can't run Postgres. These are new or changed: `migration-import`,
   `approver-rules`, `cost-basis`, `grid-corrections`, `timesheet-pdf`, `audit-trail`, `payroll-flsa`, and
   `export-workspace` (C8 case).
   ```bash
   CONTROL_PLANE_DATABASE_URL="$(grep '^CONTROL_PLANE_DATABASE_URL=' .env.local | cut -d= -f2-)" ENCRYPTION_KEY="$(grep '^ENCRYPTION_KEY=' .env.local | cut -d= -f2-)" TZ=America/New_York npm run test:integration
   ```
2. **The Postgres break-its** listed in §9 and §12–§15: undo each fix, confirm its test fails, restore.
3. **Cost-basis report** before deploying C3 and again after:
   ```bash
   npm run report:cost-basis-change -- <slug>
   ```
4. **Build and trace check:**
   ```bash
   npm run build && node scripts/check-build-trace.mjs
   ```
5. **Demo seed twice.** It now writes `period_events`, designated approvers, the workweek and leave pay types:
   ```bash
   npm run demo:local
   ```
6. **The blueprint §10 manual browser checks.** That includes the payroll export for a semi-monthly period with a
   boundary workweek against a hand calculation, and the PDF with leave hours.
7. **`docs/payroll-overtime-method.md`** must be reviewed by the payroll accountant before production. The vendor
   column layouts (ADP / Paychex / Gusto) need verifying in staging before payroll export is marketed.
8. **`npm run db:safety`.** In my sandbox it now fails with tsx's IPC `listen EPERM` (the sandbox, not the code). The
   same script passes under `node --import tsx scripts/check-migration-safety.ts`. Run `npm run db:safety` on your
   machine.

**Open questions for the lead (no code waits on them):**
- **C5 0-hour rows.** Should a PDF row whose latest revisions are all 0 be printed (current behavior) or dropped?
- **C5 approval line on reprint.** The approver's name and the workspace timezone are read live; a rename or timezone
  change alters later reprints. Snapshotting them would be a C2 / schema change.

---

## 18. Fix round 1 (CERTIFIED-OUTPUTS-AUDIT.md) — `abacfd1` (F1), `a980a2e` (F2–F16), `577483c` (T1–T8)

The audit's §3 rulings are applied as written:
- **Zero-hour PDF rows:** printing them stays.
- **Approval name / timezone snapshot:** backlog.
- **The ActionResult conversion and the react-server seed scripts:** accepted.
- **§6 bugs:** the Gusto counter is fixed in F10; daily notes and the "Semi-Monthly" title are backlog.

§5 (backlog) was not touched. No item conflicted with the code.

**Break-it legend:**
- **U-fail:** I undid the fix (mutation), the named unit test failed, and I restored it.
- **PG:** the check needs Postgres (it lives in a `where` clause or a real lock). The integration test covers it; the
  product owner's break-it is listed at the end of this section.

**Gates at `577483c`:** tsc clean; lint 0 errors / 59 warnings (F8 briefly added one stale hook dependency, removed);
1260 unit tests ×4; the migration-safety script passes.

| Item | Commit | Fix | Test(s) | Break-it |
|---|---|---|---|---|
| **F1** user-rules lock | `abacfd1` | <ul><li>`lockUserRulesExclusive` / `lockUserRulesShared` added to `approval-rules.ts` (key `USER_RULES_LOCK`, allowlisted in `sql-template-params`).</li><li>The exclusive lock is the first statement of the transaction in `createUser`, `updateUser`, `createUserWithPassword`, `setUserApprover`, `bulkImportEmployees` and `provisionTenant`; the seeder's baseline takes it too.</li><li>`decidePeriod` takes the shared lock first in its transaction, re-reads the facts and re-runs the self-approval and `canApprove` checks before the UPDATE.</li></ul> | <ul><li>unit `user-rules-lock.test.ts`: static first statement for all six, plus fixtures</li><li>unit `approval-decisions.test.ts`: the shared lock SQL; demoted while waiting → not found; self-approval off while waiting → refused</li><li>**integration `user-rules-lock.test.ts` (a)(b)(c)**, deterministic with a raw client plus a `pg_stat_activity` observer</li></ul> | U-fail 8/8: lock missing per writer, lock after a row lock, no shared lock, no re-check, no self re-check. **PG:** (a)–(c) |
| **F2** back-on notice | `a980a2e` | The latest `self_approval` row is `enabled` and its reason is not a baseline (`'workspace created'`, `'demo workspace seeded'`); no earlier "disabled" row is needed. | <ul><li>unit `approval-decisions` F2 cases</li><li>integration `approver-rules`: two admins, no rows → deactivate → notice</li></ul> | U-fail 2/2: old rule, baseline shown |
| **F3** import hours | `a980a2e` | `parseImportHours`: `Number(trimmed)`; empty or non-finite → row error; 0–24; 2 decimals. Used by the validator and the import. | <ul><li>unit `fix-round-1-small` F3</li><li>integration `migration-import`: "7,5" / "8h" / "" are row errors, "7.5" → 7.50</li></ul> | U-fail 3/3: `parseFloat`, empty accepted, validator back to `parseFloat` |
| **F4** payroll preview gate | `a980a2e` | The preview is keyed to its range; changing the range clears it; both downloads need a READY preview of the current range; the flagged list sits above the buttons. | render `payroll-export-client.test.tsx`: disabled before / after a range change, enabled after a preview; a stale response is ignored; a refusal keeps downloads disabled | U-fail 2/2 (the range-key mutation first **survived**, because the clear-on-change guard alone held it; I added the stale-response test, and it now fails) |
| **F5** Remaining flags | `a980a2e` | `PricedBasisNote` ("based on priced cost" plus the unpriced link) on the overview, contract, CLIN and SLIN Remaining figures. | render `dashboard-remaining.test.tsx` (expands the row; 4 notes; scoped hrefs) | U-fail 3/3: contract, overview, SLIN |
| **F6** summary by id | `a980a2e` | `getEmployeeSummaryReport` groups by `users.id`, returns `employeeId`, keeps the name for display. | <ul><li>integration `approver-rules` designee scope (two "Test User"s)</li><li>new `cost-basis` same-name case</li></ul> | **PG** (GROUP BY): group by `users.fullName` → both fail |
| **F7** revision-map identity | `a980a2e` | Group by `COALESCE(charge, indirect, clin)` + date; the map is keyed by it. | <ul><li>unit `fix-round-1-small` F7 (static)</li><li>integration `grid-corrections`: revisions under two clin_ids → map = 2, save with `expectedRevision` succeeds</li></ul> | U-fail (static). **PG:** the old grouping returns the two groups in unspecified order, so the integration case fails about half the time (see the note below) |
| **F8** offline codes | `a980a2e` | Offline seeding uses `period.chargeCodes`; `chargeCodes` is required on `SET_PERIOD_DATA` and the `??` fallback is gone; `timesheetReducer` is exported. | unit `grid-corrections`: reducer replaces the list (including an empty list), plus a static seeding check | U-fail 2/2 |
| **F9** PDF code CLIN | `a980a2e` | Aliased joins to the charge code's own CLIN / contract / SLIN label each charge row. | unit `timesheet-pdf-rows` F9: two entry-level CLINs, either order → the code's CLIN | U-fail |
| **F10** FLSA flag, Gusto counter, payroll dates, method doc | `a980a2e` | <ul><li>Flag only when `unapprovedWorkedSoFar > 0 && beyond > 0`.</li><li>Gusto counts `pushed` after the insert.</li><li>Payroll dates go through `validateCalendarDate` (`UserFacingError`).</li><li>`getPayrollFormats` removed, along with its guard-allowlist entry.</li><li>The method doc gains the overtime-only flag rule, "re-export the range that contains it", and code changes altering past exports.</li></ul> | <ul><li>unit `payroll-flsa` (no OT → not flagged)</li><li>`integration-sync-errors` (pushed = 0)</li><li>`payroll-export-actions` (bad dates → `validation` result; doc strings)</li></ul> | U-fail 3/3 (the date mutation first targeted the start date, which the test doesn't exercise; re-run on the end date, it now fails) |
| **F11** cost-view links, reactivation count, API dialog | `a980a2e` | <ul><li>`UnpricedNote` links end in `#cost-basis-reports`.</li><li>The period-report note uses the generated range.</li><li>The reactivation count (dialog and action) joins `users.is_active`.</li><li>The API-key dialog documents `lcatTitle` "Unpriced".</li></ul> | <ul><li>render `dashboard-remaining` (anchors)</li><li>unit `charge-code-cost-rules` F11 (static count, generated range, dialog)</li><li>integration `cost-basis` reactivation with a deactivated assignee</li></ul> | U-fail 3/3 |
| **F12** audit reads | `a980a2e` | <ul><li>`desc(id)` tie-breakers.</li><li>501-row fetch → `{ entries, truncated }` / `{ events, truncated }`; the UI shows "Showing the first 500".</li><li>Period events filtered by overlap: a SQL prefilter of start − 31 days, then the exact end from the period's real length.</li><li>Every id and date input validated after the guard (`getClinsForFilter` included).</li></ul> | <ul><li>unit `audit-trail` F12 (cap, overlap, validation, order)</li><li>integration `audit-trail` overlap case (Feb 10–28 includes the Feb 1 period; Feb 16–28 doesn't)</li></ul> | U-fail 4/5. **PG:** the prefilter on `period_start ≥ start` (fake DB ignores `where`) |
| **F13** passwords CSV | `a980a2e` | `generateCsv` with Email and Password columns. | unit `fix-round-1-small` F13 | U-fail |
| **F14** import bytes, coercion, `show` | `a980a2e` | <ul><li>`serializedBytes` counts UTF-8 bytes; batch splitting uses it.</li><li>`coerceImportRow` applies `String(x ?? '')` in both validators.</li><li>`tenant:admin show` uses `describeImportWindowState` (closed when an app `submitted` event exists).</li></ul> | unit `fix-round-1-small` F14 | U-fail 3/3 |
| **F15** re-route time, dead code, usage lines | `a980a2e` | <ul><li>`notifySubmissionRecipients` takes `submittedAt`; re-routes pass `period.submitted_at`, and submit passes the row's.</li><li>`getSupervisedEmployeeIds` and its integration test deleted.</li><li>The `seed-demo.ts` and `feature-plan-production-deploy.md` usage lines now name the npm scripts.</li></ul> | unit `submission-notify.test.ts` | U-fail |
| **F16** control plane behind | `a980a2e` | `setup-db.ts` compares `drizzle.__drizzle_migrations` `max(created_at)` with the journal and throws the single message from the audit. | unit `fix-round-1-small` F16 (helper and wiring) | U-fail |
| **T1** inactive CLIN / contract on save | `577483c` | — | <ul><li>unit `grid-corrections` T1 (`chargeCodeFacts({ clinActive: false })` / `{ contractActive: false }`)</li><li>integration `grid-corrections` T1</li></ul> | U-fail 2/2: the rule ignores CLIN/contract; the save doesn't read contract status |
| **T2** period-event scope | `577483c` | — | <ul><li>integration `approver-rules` designee scope: events for {book, X}; `other` → []</li><li>unit static</li></ul> | U-fail (scope filter removed). **PG:** the same mutation fails the integration case |
| **T3** seeder conformance | `577483c` | — | integration `seed-conformance.test.ts`: `seedRichData` run twice; every approved reviewer passes `canApprove`; submitted / approved events; workweek 1; leave pay types; one baseline row | **PG:** e.g. remove `if (supervisorIds.includes(employeeId)) return userIds.admin;` in `seed-full.ts` → Sarah self-approves → `canApprove` fails |
| **T4** payroll latest revision, float sum | `577483c` | — | <ul><li>unit `payroll-flsa`: 5.83 ×3 + 10.88 + 11.63 → 40.00 regular, 0 OT; a 0-hour day omitted</li><li>integration `payroll-flsa`: rev 1 = 10 / rev 2 = 8 → 8; corrected to 0 → day omitted</li></ul> | U-fail 2/2: float hours; 0-hour day reported. **PG:** latest-revision subquery removed |
| **T5** cost-basis SLIN cases + stricter import rule | `577483c` | — | <ul><li>integration `cost-basis`: SLIN-level conflict; SLIN beats CLIN; exact `slinSummaries` cost / unpriced; summary `unpricedHours`</li><li>unit `cost-basis`: the rule also flags `schema.laborCategories` / `schema.userLaborCategories` and raw table names in `sql` (fixtures); `clear-tenant-data.ts` added to the allowlist (cleanup, namespace import)</li></ul> | U-fail 3/3: namespace detection off, raw-sql detection off, CLIN before SLIN in the CASE |
| **T6** export `self_approved` parity | `577483c` | — | integration `export-workspace` T6: a legacy period (no events, reviewed_by = user) and reject → resubmit → approve, both ways, compared with `approvalLabels` | U-fail (ORDER BY ASC in the derived SQL, via the rendered-SQL unit check). **PG:** same mutation → `otherLast` exports true |
| **T7** hours compared as strings | `577483c` | — | `audit-trail.test.ts` (histories) and `grid-corrections.test.ts` (0-hour correction, CLIN correction) compare `Number(x).toFixed(2)` | n/a: a test-correctness fix for the product owner's 3 failures. The code it covers keeps its own break-its (C4, C6) |
| **T8** zero-row decision path | `577483c` | — | integration `approver-rules` T8: a raw client holds the user-rules lock, the decision passes its pre-checks and waits, the other reviewer approves, the conditional UPDATE matches 0 rows → re-read → "just changed"; no `rejected` event | U-fail (status dropped from the UPDATE's `where`, via the existing unit check). **PG:** same mutation → T8's decision succeeds |

**Notes:**
1. **F7's integration case can pass under the break-it.** It fails reliably only with the fix in place. GROUP BY output
   order is unspecified, so with the old grouping it fails roughly half the time. The static unit check is the
   deterministic guard.
2. **The audit reads' return shape changed.** `getAuditEntries` and `getAuditPeriodEvents` now return
   `{ entries | events, truncated }`. The client and every caller are updated (the `authorization`, `approver-rules`
   and `audit-trail` tests).
3. **The F1 integration tests need real per-call connections.** They mock `getDbForWrite` to open its own connection
   on every call, like the `authorization` test, because the shared test client is `max: 1`.

**Product owner — Postgres break-its for this round** (undo, confirm the named integration test fails, restore):
1. **F1:** remove `await lockUserRulesExclusive(tx);` from `setUserApprover`. `user-rules-lock` (a) should fail with a
   40P01 deadlock.
2. **F1:** remove it from `updateUser`. (b) should fail: the log's last row is `enabled`.
3. **F1:** remove `await lockUserRulesShared(tx);` from `decidePeriod`. (c) should fail, because the approval is never
   blocked.
4. **F6:** group the summary by `users.fullName` again. The `approver-rules` designee-scope test and the `cost-basis`
   same-name case should fail.
5. **F12:** change the period-event prefilter to `gte(timesheetPeriods.periodStart, startDate)`. The `audit-trail`
   overlap case should fail.
6. **T2:** drop the scope filter in `getAuditPeriodEvents`. The `approver-rules` designee test should fail.
7. **T3:** drop the supervisor branch of `reviewerFor` in `seed-full.ts`. `seed-conformance` should fail.
8. **T4:** remove the latest-revision subquery in `loadPayrollData`. The `payroll-flsa` T4 case should fail.
9. **T6:** change `ORDER BY pe.created_at DESC` to `ASC` in `PERIOD_SELF_APPROVED`. The `export-workspace` T6 case
   should fail.
10. **T8:** drop `eq(timesheetPeriods.status, 'submitted')` from the decision UPDATE. The `approver-rules` T8 case
    should fail.

**Integration command (audit §4).** Whenever a control-plane migration changes, run `npm run db:migrate:cp` first,
with `CONTROL_PLANE_DATABASE_URL` set. Otherwise the setup now stops with "Control-plane database is behind (N of M
migrations) …".
```bash
REQUIRE_CONTROL_PLANE_TESTS=1 CONTROL_PLANE_DATABASE_URL="$(grep -h '^CONTROL_PLANE_DATABASE_URL=' .env.local .env 2>/dev/null | head -1 | cut -d= -f2-)" ENCRYPTION_KEY="$(grep -h '^ENCRYPTION_KEY=' .env.local .env 2>/dev/null | head -1 | cut -d= -f2-)" TZ=America/New_York npm run test:integration
```
New or changed integration files this round:
- new: `user-rules-lock`, `seed-conformance` (allow ~5 minutes; it seeds twice);
- changed: `approver-rules`, `audit-trail`, `cost-basis`, `export-workspace`, `grid-corrections`, `migration-import`,
  `payroll-flsa`, `charge-code-actions` (dead test removed), `authorization` (new audit return shape).

The other reminders from §17 still apply: `npm run build && node scripts/check-build-trace.mjs`, `npm run demo:local`
twice, the blueprint §10 browser checks, the payroll accountant's review of `docs/payroll-overtime-method.md`, and the
vendor layouts in staging.

---

## 19. Fix round 2 (CERTIFIED-OUTPUTS-AUDIT.md §6) — `5543bdb`

**Gates at `5543bdb`:** tsc clean; lint 0 errors / 59 warnings; 1268 unit tests ×4; the migration-safety script passes.
Each item has the test the audit names, and every break-it mutation made that test fail (9/9) before I restored it.

| Item | Fix | Test(s) | Break-it |
|---|---|---|---|
| **R1** generated passwords vs the CSV formula guard | The generator moved to `src/server/internal/generated-password.ts` (`generateImportPassword`). The first character is drawn from letters and digits only; the rest of the set is unchanged (`!@#$` allowed after the first). `bulkImportEmployees` uses it, and `generateCsv` stays. | unit `fix-round-2.test.ts`: 10,000 passwords never match `FORMULA_PATTERN`, and the CSV cell equals the password exactly; static check that the old generator is gone | U-fail: first character drawn from the full set |
| **R2** false "back on" notice in pre-C2 sole-admin workspaces | <ul><li>`recomputeSelfApproval(tx, actor, reason, { before })` takes the facts from before the write. Each writer loads them once and shares them with `snapshotSubmittedEligibility(tx, beforeFacts)` (no extra query).</li><li>If an admin has no prior row and self-approval was already available before the write, the row's reason is `EXISTING_STATE_REASON` (`'existing state recorded'`), which is added to `BASELINE_SELF_APPROVAL_REASONS`.</li><li>Provisioning and the seeder pass no `before` and keep their own baseline reasons.</li></ul> | <ul><li>unit `approval-decisions` R2: sole admin with an unrelated write → baseline reason → no notice; a pre-C2 workspace deactivating its second admin → the real reason → notice; static check that all five writers pass `before`</li><li>integration `approver-rules` R2: real `updateUser` on an employee → `existing state recorded`, no notice. The F2 integration case (second admin deactivated → notice) still covers the other half.</li></ul> | U-fail 3/3: no baseline reason; baseline reason always; `updateUser` not passing `before` |
| **R3** period-event `truncated` at the prefetch cap | `truncated = overlapping.length > 500 \|\| candidates.length === 5000` (named constant `EVENT_CANDIDATE_LIMIT`). | unit `audit-trail` R3: 501 overlapping → true; 5,000 candidates with none overlapping → `{ events: [], truncated: true }`; 1 → false; undated 501 → true | U-fail 2/2: prefetch cap ignored; overlap cap ignored |
| **R4** sync triggers use `parseCalendarDate` on user dates | `triggerGustoSync` and `triggerQBOSync` use `validateCalendarDate` (`UserFacingError` → a `validation` result). | unit `fix-round-2` R4: bad Gusto start / QBO end → validation result, no sync started; valid dates reach `executeSyncOperation` | U-fail 2/2 (Gusto, QBO) |
| **R5** import hours accept `0x8` / `1e1` | `parseImportHours` requires `/^\d+(\.\d+)?$/` after the trim. | unit `fix-round-2` R5: `0x8`, `1e1`, `+8`, `.5`, `8.`, `Infinity`, `0b1` and `8 h` refused; `8`, `7.5` and ` 10.25 ` accepted | U-fail: pattern removed |

**Notes:**
1. **R5 refuses `.5` and `8.`** as well. They follow the audit's pattern; the row error says "for example 7.5".
2. **R2's integration case needs Postgres.** It is in `approver-rules`. **Product owner's break-it:** in
   `recomputeSelfApproval`, replace `existingState ? EXISTING_STATE_REASON : reason` with `reason`. The R2 integration
   case should then fail, because the notice shows.

Integration command and `npm run db:migrate:cp` first: unchanged from §18.
