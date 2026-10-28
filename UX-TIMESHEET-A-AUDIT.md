# UX-3 Part A (timesheet server and data): lead audit of the implementation

**Audited:** branch `ux-timesheet-server` at `4aebfc7` (8 commits on `c8706b1`) against `feature-plan-ux-timesheet.md` **Part A v3 FINAL**. **Date:** 2026-10-27.

**Method:**
- **Lead:** re-ran the gates and read migration `0017_timesheet_notes.sql` (CHECK, unique index, both append-only triggers on the existing function).
- **Two independent auditors:**
  - DCAA, data and security, including about 26 adversarial `safeNext` inputs;
  - periods, old-grid wiring, offline removal, emails and lockfile.

  Both ran the unit suites and read every integration test.
- **Product owner:** runs integration and `breakit-check-ux3a.mjs`; results below.

**Verdict: NOT READY TO MERGE. No HIGH; two MEDIUM; fix round 1 below.**

## 1. Gates and verified properties

| Check | Result |
|---|---|
| `tsc` / lint / unit | clean / 0 errors, 63 warnings / 132 files, 1623 pass |
| `db:safety` | passes |
| **Append-only (DCAA)** | The only note insert is `writeNotes`, inside the save transaction after `lockEmployeeTimesheet`, `assertEntryDatesEditable` (note dates included, notes-only batches can't skip it), the cell inserts and the day-total check. No UPDATE or DELETE path exists. DB triggers cover UPDATE, DELETE and TRUNCATE. `clearTenantData` is the only bypass user and deletes notes in the right order (statically tested). |
| All-or-nothing | One transaction; eligibility is read through `tx` (no second connection while the lock is held) |
| Hours | `typeof number` → finite → 0–24 → `Number.isInteger(v*4)`, no normalization; stored `String(validated)`. The existing `''` / `'0x8'` hole is closed. |
| Day total | `tx` + `LATEST_REVISION` before and after the inserts, only with cells present; `Number()` with a missing day as 0; L1 rule `next > 24 && next > prev` |
| Security | Own data only; the review path is guarded first; every changed action is guard-first; no new `'use server'` exports. `safeNext` held on the rebuilt path. The proxy overwrites `x-cp-path`. All 7 callers use `return loginRedirect()`. |
| Export | `timesheet_notes`: all 10 columns described; all revisions exported |
| Old grid | Hours save unchanged. ReasonModal still gets cells only. Note dirty/save/discard/submit rules match A4.9; first-load notes work; a cleared note keeps its revision. |
| Offline | No references left in `src`, `README.md` or `public` (Terms and Privacy left to the business side). Lockfile consistent for `npm ci`. |
| Integration, Postgres break-its, build, migrations, browser checks | product owner, pending |

## 2. Rulings on the dev's gap decisions
All accepted:
- `period-lock-integrity.test.ts:337` repointed to `result.revisions`;
- `dirtyNotes` compares trimmed bodies over both maps' keys;
- `getTimesheetPeriod` keeps the stored period length (safe: the stored length always matches the schedule);
- `isCurrent` added to client state;
- **Next follows the period list** (re-fetched when today changes), with `isCurrent` used only before the list arrives (self-review fix, verified correct);
- duplicate note cells and non-text bodies refused;
- the "(and N more days)" wording;
- the error-page wording;
- 7 landing cards;
- the unrelated lockfile line reverted.

## 3. Fix round 1 (required before merge)

### M1 (MEDIUM): remove the dead `skipConflictCheck` bypass
- **Problem:** its only caller was the deleted offline sync (`src/lib/offline/sync-service.ts:182` on `main`). The action still accepts it from any client (`timesheet.ts:199,297`), and Part A passes it into `writeNotes` (`:444`, `timesheet-notes.ts:95`). A hand-crafted request can therefore skip the note `expectedRevision` check (A5, A6).
- **Fix:** remove the flag from `saveTimesheetBatch`'s payload type and from `writeNotes`. Add a unit pin that the payload type and source no longer mention `skipConflictCheck`, and an integration case: a stale note `expectedRevision` is still a conflict even when the request carries `skipConflictCheck: true`.

### M2 (MEDIUM): deep-link values are decoded twice, which changes their meaning
- **Problem:** `x-cp-path` is already in encoded form. `safeNext` decodes it (`safe-next.ts:22`) and returns the decoded rebuild, so `?search=a%23b` becomes `?search=a`, and `%26` or `%3F` change the query. The login page then runs `safeNext` on Next's already-decoded `searchParams`, decoding a second time (`?a=%25` → null). Not a security issue (every output passes the checks on the rebuilt path), but it's a correctness gap.
- **Fix:** `safeNext(input)` **returns its input unchanged** or `null`:
  - validate on the decoded copy as today;
  - **also reject when `new URL(input, 'http://x')` changes the string**, i.e. `pathname + search !== input`, meaning the parser normalised it. This also closes L2's double-encoded dot segments.

  With that rule, `loginRedirect` sends the raw value, encoded once with `encodeURIComponent`. Next decodes it once into the same raw string; the login page's `safeNext` sees the identical input and returns it; `router.push` gets it unchanged.
- **Tests:** `/admin/users?search=a%23b` round-trips unchanged through `loginRedirect` → login page; `/timesheet/x/%252e%252e/%252e%252e/admin` → null; `/timesheet?period=2026-10-01` unchanged.

### LOWs (cheap; same round)
- **L1** Refuse control characters other than tab and newline in note bodies (`validateNotes`, `timesheet-notes.ts:57-59`) with "A note can't contain control characters." Today a NUL becomes a raw Postgres error. Add a test.
- **L2** Covered by M2.
- **L3** Note eligibility uses **latest non-empty** notes, matching what `getPeriodCodesForEmployee` shows. Still allow **clearing** a note that's currently non-empty (`timesheet-notes.ts:144-149`). Add a test: after clearing an ended-assignment note, a new note on that hidden row is refused.
- **L4** Restore the indirect-entry case removed from `timesheet-save.test.ts` (indirect `clinId` null), and list the other removed near-vacuous cases in the report.
- **L5** A-T2 constraint assertions match `timesheet_notes_one_code_check` and `timesheet_notes_cell_rev_unique_idx` on `cause.message`, the way `isAppendOnlyError` does.
- **L6** The note conflict message no longer says "entries" (`timesheet.ts:451-453`). Use "This timesheet changed in another tab or session. Reload to see the latest, then try again."
- **L7** `PayPeriodSelector` catch: `setCurrentPeriodStart(null)` so a failed list re-fetch falls back cleanly (`PayPeriodSelector.tsx:30-44`).
- **L8** A-T9: give the other user an entry or period row older than the employee's creation date, and assert the employee's list still ends at their own bound (`past-periods.test.ts:106-116`).
- **L9** Toast wording counts notes as "changes", not "entries" (`TimesheetToolbar.tsx:191,206`).
- **L10** `preview()` slices by code points, not UTF-16 units (`past-periods.ts:34`).
- **L11** Landing grid: with 7 cards use `cols={{ base: 1, sm: 2, md: 3 }}` or another balanced layout (`src/app/page.tsx:96`).
- **L12** `CONTEXT.md:12`: remove the Dexie/IndexedDB goal or mark it deferred (see the offline-editing future feature).

**Recorded, no change (backlog):**
- duplicate *hour* cells in one batch are still accepted (old behaviour; a second insert for the same cell hits the unique index);
- past periods makes about 6 queries per page, not 4 (fine).

## 4. Fix round 1 verification (`e5a63ed`), 2026-10-28

- **Lead gates:** `tsc` clean; lint 0 errors, 63 warnings; 132 files, 1637 pass. The break-it script's 7 original edits still apply.
- **Break-it script additions:**
  - M1: note revision check skipped;
  - L3: eligibility from any note, including cleared ones;
  - L8: earliest bound from all users' data (two edits).

  Total 10. L5 is a test-text mutation; it was verified by reading the named-constraint assertions.
- **M2 consequences accepted:** an encoded `//` and a fully encoded input are now refused (not in final form). `safeNext` returns its input unchanged or null, so the value is identical at both stages.
- **L4 disclosure:** commit 3 had overwritten `integration/timesheet-save.test.ts`. The indirect-entry case is restored. The three removed raw-insert cases never called the save action, and append-only behaviour is covered by the trigger tests and A-T1, so they aren't restored (accepted).
- **Dev reports 12/12 unit break-its.**
- **Code audit: CLEAN pending the product owner's runs:**
  - integration;
  - `node breakit-check-ux3a.mjs` (10 checks);
  - `npm run db:migrate:all` on the local tenants;
  - build plus build-trace;
  - `demo:local` ×2;
  - the A10 browser checks.

## 5. Product owner runs (2026-10-28) and fix round 2

**Results:**
- Integration: 567 pass, **3 fail**, all in `past-periods.test.ts`: imported entries before creation, an older period row, and the 26-row pages.
- Postgres break-its: 8/8 caught. Checks 6 (A-T9) and 10 (L8) were skipped because their baseline file fails.
- Browser:
  - A note was lost on reload (see "Note on reload" below).
  - Jane's grid shows only its first row. That's Part B's layout work: the dashboard is removed, the header is compact, and the scroller has an `18rem` minimum. It's not a Part A defect.

**Root cause (verified by rendering the SQL with `drizzle.mock()`):**
- In a single-table select, Drizzle renders an interpolated column **without its table**: `${users.id}` becomes `"id"`.
- Inside `(SELECT … FROM timesheet_entries pp_te WHERE pp_te.user_id = "id")`, Postgres binds `"id"` to the *inner* table (`pp_te.id`). The subquery is never true, so it returns NULL.
- `firstEntry` and `firstPeriod` are therefore always NULL, and the list always stops at the creation day.
- The L8 test passed *because* of this bug. It wasn't proof of anything.
- When the query has joins, Drizzle qualifies the column: `audit.ts:186,251` render `"timesheet_entries"."created_by"`, which is correct.

### M3 (MEDIUM): past timesheets ignore imported history
`past-periods.ts:59-60`. Bind the user id as a parameter, using exactly this text (the break-it script matches it):
```ts
firstEntry: sql<string | null>`(SELECT MIN(pp_te.entry_date)::text FROM timesheet_entries pp_te WHERE pp_te.user_id = ${userId})`,
firstPeriod: sql<string | null>`(SELECT MIN(pp_tp.period_start)::text FROM timesheet_periods pp_tp WHERE pp_tp.user_id = ${userId})`,
```
Add a one-line comment saying why: an interpolated column renders unqualified in a single-table select. The existing 3 failing tests are the regression tests, and L8 still holds.

### M4 (MEDIUM, pre-existing, same bug class): export `self_approved` ignores `period_events`
- **Where:** `allowlists.ts:106,108` (`PERIOD_SELF_APPROVED`).
- **Why it's wrong:** the export reads it in a single-table select (`workspace-export.ts:113`). `pe.period_id = ${timesheetPeriods.id}` becomes `pe.period_id = "id"`, which binds to `pe.id`. Both subqueries are always NULL, so the column falls back to `reviewed_by = user_id`. That ignores the migration source and the latest approval's actor, so an imported approval can be exported as self-approved.
- **Why tests didn't catch it:** every existing test case has `reviewed_by` consistent with its events.

**Fix:** write the outer column literally, using exactly this text in both subqueries:
`… FROM period_events pe WHERE pe.period_id = timesheet_periods.id AND pe.event = 'approved' …`

Add a comment: the expression is only used with `.from(timesheetPeriods)`, never aliased. The `reviewed_by` and `user_id` interpolations outside the subqueries are correct and stay.

**Tests** (in `export-workspace.test.ts`; each must also equal `approvalLabels`, like T6):
- (a) The admin's own period, approved, `reviewedBy` the admin, with an `approved` event whose actor is the admin and `source: 'migration'`. Expected **`false`** (an imported approval).
- (b) The admin's own period, approved, `reviewedBy` the admin, whose latest `approved` event's actor is another admin. Expected **`false`** (the latest event decides).

### Note on reload (no code change in Part A)
The old modal's **Save Note** button only updates the working copy. The toolbar **Save** sends the note. The save and read path is covered end to end (A-T3/A-T4 integration, plus the `timesheet-notes-wiring` unit test).

**Product owner re-check:**
1. Add a note and press Save Note.
2. Confirm the toolbar shows 1 unsaved change, then press the toolbar **Save**.
3. Reload.

If the note is still lost, that's a defect; report it.

Part B v5.1 renames the button **Done** and adds the hint "Your note is saved when you save your timesheet."

**Break-it script:** the L8 edit now matches `${userId}`. Three checks are added (M3, M4 source, M4 actor), for 13 in total.

**Note re-check (2026-10-28):** the product owner confirmed notes save and survive a reload after the toolbar Save. Not a defect. The misleading "Save Note" label is fixed in Part B v5.1, where the button reads "Done".

## 6. Fix round 2 verification (`adc5d7a`), 2026-10-28

**Lead review:**
- The diff matches §5 word for word.
- The two changed unit files pass (18 tests).
- `breakit-check-ux3a.mjs --dry-run`: all 13 checks' edits apply.
- The new export case covers (a) and (b), and compares each with `approvalLabels`.
- The dev's change to the `export-allowlists` pin is accepted: Drizzle's dialect qualifies the column on its own, so the old pin could never fail. The new pin asserts the literal text.

**Dev gates:** `tsc` clean; lint 0 errors, 63 warnings; 1637/1637 under `test` and under `test:tz`; `db:safety` passes.

**Pending (product owner):** integration (the three `past-periods` cases plus the new export case), the 13 break-its, then the rest of the run list.
