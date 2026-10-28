# Blueprint UX-3: the timesheet (Part A server and data, Part B screen and accessible grid)

> **Role for the executing developer:** senior full-stack engineer (DCAA data rules, Drizzle, React 19 accessibility).
> **Follows:** `BLUEPRINT-STANDARD.md`. **Builds on:** UX-1 (icons, `RowActions`, theme, axe helper, DOM helpers) and UX-2 (nav-config, `landingPath`, Home, `currentPeriodSummary`, `CHARGEABLE_CODE`, B5).
> **Sources:** `UX-AUDIT.md` (V1–V5, A1–A4, A10, A11), approved mockup `ux-mockups/index.html` → "Employee timesheet".
> **Status:** Part A **v3 FINAL** (rounds 1 and 2 fixed, §13), 2026-10-27, lead architect. **Part B is DRAFT:** it gets a full self-contained v3 rewrite and its own review before Part B starts. Do not implement Part B from this text.

**Two parts, two branches, two audits.** Part B starts only after Part A is merged.

| Part | Branch | Scope |
|---|---|---|
| **A: server and data** | `ux-timesheet-server` | notes persisted append-only; quarter-hour rule; 24-hours-per-day rule; period validation and the selected-period summary; past-periods data; deep links that survive sign-in; the fake offline layer removed; weekly (FLSA) data |
| **B: screen** | `ux-timesheet-ui` | page layout per the mockup; the accessible keyboard grid; notes UI; unsaved-changes guard; week view for narrow screens and 400% zoom; Past timesheets page; notes in the Approvals drawer |

**Out of scope:**
- page-by-page pass and copy (UX-4);
- Playwright in CI and the ACR (UX-5);
- **real offline editing** (deferred, product owner asked that it be kept on record);
- Terms and Privacy wording (business side, §0).

---

## 0. Decisions

| # | Decision | Ruling |
|---|---|---|
| UX3-D1 | Notes | **Persisted, append-only like entries** (each change is a new revision), **one note per cell** (charge code × day, as the UI does today), editable until the period is submitted, then locked with it. Approvers see them in the review drawer. (Product owner, 2026-10-27.) |
| UX3-D2 | Offline | **Remove** the "Synced" badge and the unused offline layer; real offline editing is a future feature (product owner). |
| UX3-D3 | Hour steps | **Quarter hours only** (.00, .25, .50, .75). Other values are refused with a message, never rounded. Server-enforced (product owner). |
| UX3-D4 | Day over 24 | **Blocked**: the save is refused, naming the day. Server-enforced (product owner). |
| L1 (lead) | Day-total exemption | A day **already** over 24 (imported history) may be saved if the save doesn't raise that day's total. Otherwise an employee couldn't correct imported data one cell at a time. |
| L2 (lead) | History import | `importMigrationData` stays exempt from D3 and D4. It records another system's history as-is (`src/lib/migration/import-plan.ts:26-37`). |
| L3 | Note reason code | **Product owner, 2026-10-27: no reason code for note changes.** Every change is kept as a permanent revision, and notes lock at submission. Notes carry **text only**. Today's per-note `reasonCode` was never saved or used. Reason codes stay on the batch, for hour changes. |
| UX3-Q1 | Past timesheets for periods never submitted | **Product owner, 2026-10-27 (as proposed):** list every past period from the one containing the user's creation date (workspace timezone), plus any older imported periods, showing "Not submitted" with hours if any. |
| BIZ | Legal copy | Terms §7 (`src/app/terms/page.tsx:65-66`) and Privacy §7 (`src/app/privacy/page.tsx:72-74`) describe offline support and IndexedDB storage. **The developer doesn't edit them.** The product owner updates them on the business side, before or with the Part A deploy. The landing page's "Offline Support" card (`src/app/page.tsx:122-126`) is product copy, so Part A removes it. |

## 1. Verified current state (`main` at `7f1df7e`)

**Notes**
- **Client-only.** `notes: Record<'chargeCodeId-dayIndex', { comment, reasonCode }>` (`src/types/timesheet.ts:55`), `SET_NOTE` (`TimesheetContext.tsx:33-38`), cleared on every period load (`:73`).
- **Never sent to the server.** `saveTimesheetBatch` has no notes field.
- The privacy policy already lists "daily notes" as timesheet data (`privacy/page.tsx:23`).

**Entries and append-only**
- **Cell identity** (`src/db/schema.ts:305-344`): `user_id`, `entry_date`, plus one of `charge_code_id` / `indirect_code_id` / `clin_id`.
- **Unique index** `entries_user_code_date_rev_unique_idx` on `(user_id, coalesce(charge_code_id, indirect_code_id, clin_id), entry_date, revision_number)` (`:335-340`).
- **Latest revision:** `LATEST_REVISION` (`src/server/internal/cost-basis.ts:117-121`).
- **Next revision** = `COALESCE(MAX(rev), 0) + 1` under the employee lock (`actions/timesheet.ts:298-305`). A unique violation becomes `ConflictError` (`:385-409`).
- **Append-only is enforced by the database.** `cadenzpoint_block_entry_mutation()` adds BEFORE UPDATE OR DELETE row triggers (`drizzle/0012_lame_edwin_jarvis.sql`) and TRUNCATE statement triggers (`0013_truncate_guard.sql`), reused at `0014:49-60`.
  - The only bypass is `SET LOCAL cadenzpoint.allow_entry_delete='on'` in `src/db/clear-tenant-data.ts:16`. Its delete order is checked statically (`certified-small-items.test.ts:92`).
  - Trigger tests: `src/__tests__/integration/append-only-trigger.test.ts`.

**Save, lock and validation**
- **`saveTimesheetBatch`** (`:161-420`): one transaction, `lockEmployeeTimesheet(tx, userId)` (`:231`; `pg_advisory_xact_lock`, `internal/periods.ts:146-148`), then `assertEntryDatesEditable` (`:80-117`, refuses dates in submitted or approved periods). Per-cell refusals throw, so the save is **all-or-nothing**.
- **`validateHours`** (`src/lib/validation.ts:66-79`): 0–24 per cell, then **silently rounds** to 2 decimals. Its only caller is `:209`, which ignores the return value, so `cell.hours.toString()` is stored unrounded (`:378`).
- **Only dirty cells are sent** (`TimesheetContext.tsx:182-210,225`), so untouched historical values are never re-validated.
- **Seed hours** are all quarter hours (`seed-full.ts:341-346,427,438,457,472`). API v1 is read-only.

**Migrations**
- **Tenant migrations:** `drizzle/`, latest `0016_last_talisman`.
- **Generation:** `npm run db:generate`; trigger SQL is hand-appended with a comment (precedent `0014:46-58`).
- **`MIGRATIONS.md`:** expand/contract (`:51-76`); per-migration notes (`:78-104`).
- **`db:safety`:** `scripts/check-migration-safety.ts:33-46`. A new table with triggers passes.
- **Deploy:** `db:migrate:all` + `db:migrate:check`; provisioning runs `migrateTenantDatabase()`.

**Export**
- `EXPORT_TABLES` (`src/lib/export/allowlists.ts:122`) is a per-column allowlist with descriptions.
- `export-allowlists.test.ts:97-115` (C8) fails when a schema table is neither exported nor in `NEVER_EXPORTED_TABLES`.
- The founder export and in-app export share `createWorkspaceZipStream`. Tenant deletion drops the whole database.

**Period loading and status**
- **`/timesheet/page.tsx`:** takes no `searchParams` (`:18`); always shows the current period (`:26-28`); `Promise.all` of `getTimesheetPeriod`, `getUserByEmail`, `getEmployeeDashboardData`, `getTenantState` (`:32-37`).
- **`getTimesheetPeriod`** (`actions/timesheet.ts:68-97`):
  - **doesn't validate** that the date is a period start (a mid-period date gives a misaligned grid);
  - **drops `reviewComment`**, which `getPeriodStatusFor` returns (`internal/periods.ts:12-18,31`).
- **Status display:** `TimesheetDashboard` sits **outside** `TimesheetProvider` and always describes the current period (`BiWeeklyTimesheetClient.tsx:84-88`). After navigating, the cards and rejection comment are wrong.
- **Navigation:** "next" has no upper bound (`TimesheetContext.tsx:303-307` → `getNeighborPeriod`). **There is no dirty guard and no `beforeunload` anywhere in `src/`**, so period navigation silently discards unsaved edits (`SET_PERIOD_DATA` overwrites them, `:65`).

**Weekly and FLSA**
- `TimesheetToolbar.tsx:45-107` groups weeks Sunday–Saturday, ignoring the workspace workweek, and clips at period edges. So partial edge weeks falsely trigger "Some weeks have fewer than 40 hours" (`:99,319`).
- It uses `entries[0].hours.length` instead of `numDays`.
- The "Late" header badge ignores the user's creation date (`BiWeeklyTable.tsx:71-77`, `ColumnHeaderDate.tsx:89-93`).

**Offline layer**
- **Files:** `src/lib/offline/{db.ts, offline-store.ts, sync-service.ts, use-online-status.ts}` (Dexie DB `bytime-offline`).
- **Only seeding runs** (`BiWeeklyTimesheetClient.tsx:50-75`, `TimesheetContext.tsx:274-285`). `saveOfflineEntry` has never had a caller (`git log -S`), so the queue is never fed and `SyncStatusIndicator` (`AppHeader.tsx:51`) always shows "Synced".
- **Dependency:** `dexie` (`package.json:57`).
- **Copy that claims offline:** landing `page.tsx:122-126`; `timesheet/error.tsx:31,38`; Terms and Privacy (§0 BIZ).

**Sign-in chain**
- `(app)/layout.tsx` (`:34,42,53`), `timesheet/page.tsx:20-22`, `profile/page.tsx:15`, `profile/notifications/page.tsx:13` and `requirePageRole` (`src/lib/session.ts:151`) all redirect to a bare `/login`.
- `LoginForm` calls `signIn(..., { redirect: false })` (`:69-73`) then `router.push('/')` (`:111`). MFA happens in the same component (`:32-35,76`).
- `src/proxy.ts` only sets `x-tenant-slug` (`:11-15`). **Deep links are lost at sign-in.**

**Links that should open a specific period**
- the rejected email (`timesheet-rejected.tsx:52`, sent from `periods.ts:300-308`, `periodStart` in scope);
- the approved email (`timesheet-approved.tsx:42`, `periods.ts:265`).

**Grid today** (Part B replaces it)
- **No ARIA structure:** a CSS grid of divs with `role="table"` and no rows (`BiWeeklyTable.tsx:92-180`).
- **Mouse-only cells:** `HourCell` is a `<div onClick>` that mounts a Mantine `NumberInput` after a click, with no keyboard path (`HourCell.tsx`).
- **Notes need hover:** the note button only appears on hover; in dense mode it's a dot.
- **Dense mode:** forced below 1024 px, with 10 px text (`BiWeeklyTable.tsx:20-56`).
- **Visual noise:** "—" in every empty cell (`HourCell.tsx:18`).
- **No grid DOM tests exist.** Tests that pin source text:
  - `grid-corrections.test.ts:216-226` (regex on `HourCell`, `ChargeCodeCell`, context, page);
  - `certified-small-items.test.ts:76-81` (`ReasonModal` `canSubmit`, `DailyNoteModal` disabled rule);
  - `action-results-static.test.ts:287,296`;
  - `icon-registry.test.ts:48-53`;
  - `timesheet-results.test.tsx` (mocks `SubmitModal`, `ReasonModal`, `offline-store` by path).
- **Approvals drawer:** its own table (`ApprovalsClient.tsx:318-367`); it only imports types. **Nothing outside `/timesheet` imports the grid components.**

## 2. Verified external facts

| Fact | Source |
|---|---|
| Next 16 page `searchParams` is a `Promise<{ [k]: string \| string[] \| undefined }>` and must be awaited; values may be arrays | `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md:67-124` |
| `window.history.replaceState` integrates with `useSearchParams` and doesn't re-run server components (a `router.replace` would re-run the force-dynamic page) | `…/01-getting-started/04-linking-and-navigating.md:343-412` |
| Mantine `Modal` returns focus to the opener only when `trapFocus` and `returnFocus` are on (defaults); if the opener unmounted, focus lands on `body` | `@mantine/core/esm/components/ModalBase/use-modal.mjs` |
| Mantine `NumberInput` (react-number-format) reformats mid-entry with `fixedDecimalScale`, and ↑↓ change the value by `step`, conflicting with grid arrow keys | `@mantine/core` NumberInput docs and source |
| iOS opens the on-screen keyboard only when `focus()` runs synchronously inside the user gesture (not in rAF or an effect). Use `flushSync` then `focus()`. | WebKit behaviour; current `HourCell` focuses in rAF |
| WAI-ARIA APG data grid: one tab stop (roving tabindex), arrows, Home/End, Ctrl+Home/End, edit mode with Enter/F2, Esc to cancel. A `<table role="grid">` maps `th`/`td` to header/gridcell. | WAI-ARIA Authoring Practices, Grid pattern |
| WCAG 1.4.10 allows two-dimensional scrolling for data tables | WCAG 2.1 Understanding 1.4.10 |

# PART A: server and data (`ux-timesheet-server`)

## A3. Invariants (Part A)
1. **DCAA:**
   - entries stay append-only;
   - notes are append-only too, enforced by DB triggers, not only the app;
   - reason codes for edits and late entries are unchanged;
   - the period lock applies to notes exactly as to hours;
   - the save stays all-or-nothing, with hours and notes in one transaction.
2. **Guard-first:** every new or changed action's first await is its guard. New internals live in `src/server/internal/` (never exported from `'use server'` files).
3. **Own data only:** the timesheet, notes, past periods and deep links serve the session user's own data. Reviewers read notes only through `getTimesheetForReview`, which already calls `assertCanAccessEmployee`.
4. **Export completeness:** the new table is in the workspace export with every revision.
5. **No open redirect:** a `next` parameter can only point at same-origin app paths on an allowlist.
6. **Quarter-hour and day-total rules apply only to app saves** (L2), and only to cells sent in the batch. Untouched history isn't re-validated.

## A4. Design

### A4.1 Notes table (UX3-D1)
**Schema `timesheetNotes` / `timesheet_notes`** (`src/db/schema.ts`), migration generated with `npm run db:generate -- --name timesheet_notes`, giving `0017_timesheet_notes`:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk default random | |
| `user_id` | uuid not null → users | |
| `entry_date` | date (string mode) not null | |
| `charge_code_id` | uuid null → charge_codes | exactly one of the three code columns is non-null: **declare with drizzle `check()` in `schema.ts`** (precedent `schema.ts:95,415,610`), not hand SQL |
| `indirect_code_id` | uuid null → indirect_charge_codes | |
| `clin_id` | uuid null → clins | legacy CLIN-only rows |
| `body` | text not null | stored trimmed; max 1000 characters; `''` means cleared |
| `revision_number` | integer not null | starts at 1 per cell |
| `created_by` | uuid not null → users | |
| `created_at` | timestamptz not null default now() | |

- **Indexes:**
  - unique `timesheet_notes_cell_rev_unique_idx` on `(user_id, coalesce(charge_code_id, indirect_code_id, clin_id), entry_date, revision_number)`, declared like the entries index (drizzle generates COALESCE expression indexes, precedent `0011`);
  - a lookup index on `(user_id, entry_date)`.
- **Hand-appended SQL** (with a comment, as in `0014:46-58`): the BEFORE UPDATE OR DELETE row trigger and the statement-level TRUNCATE trigger using `cadenzpoint_block_entry_mutation()`. The function is generic on `TG_TABLE_NAME`.
- **`MIGRATIONS.md`** gets a "tenant migration 0017" note: additive and deployable before the app; never roll the app back past it once notes exist.
- **`clearTenantData`** runs `tx.delete(schema.timesheetNotes)` **right after `timesheetEntries`**, because of its FKs to charge codes, indirect codes, CLINs and users. Extend `certified-small-items.test.ts:92` to assert the notes delete precedes the chargeCodes, indirectChargeCodes, clins and users deletes.
- **Export:** add an `EXPORT_TABLES` entry (`src/lib/export/allowlists.ts`) covering every column, each with a description. All revisions are exported because `EXPORT_TABLES` paginates every row.
- **Outer catch:** the outer catch in `saveTimesheetBatch` (`timesheet.ts:402-409`) maps a `timesheet_notes_cell_rev_unique_idx` violation to `ConflictError`, as it does for entries.

### A4.2 Saving notes
- **`saveTimesheetBatch` payload** gains `notes?: { chargeCodeId?, indirectCodeId?, clinId?, dayIndex: number, body: string, expectedRevision: number }[]`. It uses the same cell-ref shape as `cells`; `expectedRevision` is the revision the client last read, or 0 for none.
- **Validation, before the transaction:**
  - `dayIndex` is within the period;
  - exactly one code reference;
  - `typeof body === 'string'`, trimmed, at most 1000 characters (else `UserFacingError('A note can be at most 1000 characters.')`);
  - **no notes on future dates** (`'Notes can't be added to future dates.'`, mirroring the cell rule).
- **Inside the same transaction**, after `lockEmployeeTimesheet` and `assertEntryDatesEditable`, where the date list now **includes note dates**:
  - **Eligibility.** Checked in the transaction with `tx`. **Never call `getPeriodCodesForEmployee`**: it opens a second connection (`getDb()`, `timesheet.ts:549-551`), and `:247` forbids a second connection while holding the lock.
    - A charge-code note needs an active assignment to a code passing `CHARGEABLE_CODE`, **or** an entry in the period for that code, **or** an existing note in the period for that code.
    - An indirect-code note needs an active, available-to-all indirect code, or an entry or note.
    - A CLIN note needs an entry or note.
    - Otherwise: `'You can only add notes to rows on your timesheet.'`.
  - **Optimistic check per note.** If the latest revision ≠ `expectedRevision`, throw `ConflictError` (unless `skipConflictCheck`, as for cells).
  - **Write.** If the latest body equals the new trimmed body, it's a no-op. Otherwise insert `revision_number = latest + 1`, `created_by = actor`.
- **A notes-only batch** is valid and needs no reason code. The server derives reasons per cell, so zero cells means no reason, and nothing returns early (lead-verified).
- **Result:** `ok` returns `{ revisions, noteRevisions }`. `noteRevisions` maps key → new revision for every note that was written. Update `timesheet-results.test.tsx:117,173` mocks to the new shape and assert the merged revisions.

### A4.3 Reading notes; notes keep their row visible
- **`getTimesheetPeriod`** returns `notes: Record<string, { body: string; revision: number }>`.
  - Keys are `'{rowId}-{dayIndex}'`, where rowId is the charge, indirect or CLIN id. Lead-verified to match the client key (`TimesheetContext.tsx:34`, `HourCell.tsx:56`).
  - It holds the latest revision per cell, and includes `''` bodies with their revision, so the client knows the revision even after a note is cleared.
- **`getPeriodCodesForEmployee`** adds any code that has a **latest non-empty note** in the period as `assignable: false` (as for codes with entries). That way a note on a row whose assignment ended stays visible to the employee and the reviewer, and can still be cleared.
- **`getTimesheetForReview`** returns the same `notes`, read **after** `submissionCount` (C2 order, `timesheet.ts:423-459`).
- **Not in this phase:** the PDF and the audit-trail notes history (backlog).

### A4.4 Hours: a real number, quarter hours (UX3-D3), stored exactly
- **`validateHours(value, label)`:**
  1. `typeof value !== 'number'` → `UserFacingError(`${label} must be a number.`)`. This closes today's hole where `''` or `'0x8'` coerce through `Number()` and are stored as raw strings, breaking every `SUM(CAST(hours AS NUMERIC))` (`timesheet.ts:378`, `employee-dashboard.ts:51`).
  2. `!Number.isFinite(value)` → refuse.
  3. `< 0` / `> 24` → existing messages.
  4. **`!Number.isInteger(value * 4)`** → refuse. Quarter hours are exact in binary floating point, so there is **no normalization**: 7.2500001 is refused.
  5. Return `value`.
- **`saveTimesheetBatch`** uses the returned number. It stores `String(validated)` and uses the cell's date in the quarter-hour message: "Hours must be in quarter hours (.00, .25, .50 or .75). {value} on {MMM D, YYYY} isn't."
- **`parseImportHours`** is unchanged (L2; add a comment).

### A4.5 24 hours per day (UX3-D4, L1)
In `saveTimesheetBatch`, **only when the batch has cells**:
1. Let `affected` be the distinct dates of the batch's cells.
2. **Before inserting:** read `prevTotals`, the latest-revision sum per date for the user over `affected`, in one grouped query with `LATEST_REVISION` on `tx`.
3. **After inserting:** read `newTotals` the same way.
4. Convert with `Number()` (postgres-js returns SUMs as strings), with a missing date meaning 0: `const prev = Number(prevTotals[d] ?? 0), next = Number(newTotals[d] ?? 0)`. If any date has `next > 24 && next > prev`, throw `UserFacingError("Hours for {ddd, MMM D, YYYY} would total {n}. A day can't exceed 24 hours across all charge codes.")`. With several dates, add "and {k} more". The throw rolls everything back.
- Dates are `'YYYY-MM-DD'` strings.
- **Tests with an ordered fake DB** must script the two new reads: `grid-corrections.test.ts:55-60` and `certified-small-items.test.ts` (`correctionFacts`) consume the selects of `timesheet_entries` in order (`fake-control-db.ts:39`). List them in the report.

### A4.6 Period resolution and the selected-period summary
- **New internal** `resolveRequestedPeriod(db, raw: string | string[] | undefined, today)` in `src/server/internal/timesheet-period.ts`, returning `{ start, numDays, config, isCurrent }`:
  1. If `raw` is an array, take the first element. If it isn't a calendar date, use the current period.
  2. Otherwise `resolver.periodContaining(raw)` (imported periods are always on-schedule, `migration.ts:212`).
  3. Clamp future periods to the current one.
- **`getTimesheetPeriod(periodStart)`** calls it after the guard and returns `periodStart` (canonical) and `isCurrent`. A non-canonical input is snapped.
- **`getNeighborPeriod`** (`pay-period-config.ts:61-71`) **keeps its current return shape** `{ periodStart, periodConfig, numDays }` and **adds `isCurrent`**. "Next" is clamped at the current period, computed from the workspace `today`. **`period-lock-integrity.test.ts:312-316`** calls it with future dates; pin the clock (`vi.setSystemTime` after 2026-12-01) or use past dates. Both files go in A8.
- **`getTimesheetPeriod` adds** (the existing fields are unchanged):

  | Field | Content |
  |---|---|
  | `reviewComment` | `string \| null` |
  | `summary` | from `currentPeriodSummary(db, userId, period, today)`, which accepts any period (lead-verified, `internal/employee-dashboard.ts:39-44`): expected workdays, due date |
  | `submitOpensOn` | `'YYYY-MM-DD'` |
  | `workweekStartDay` | `number \| null` |
  | `outsideWeekHours` | `Record<'YYYY-MM-DD', number>`: latest-revision hours for the days of the period's first and last workweeks (start = `workweekStartDay ?? 0`) that fall outside the period |
  | `userCreatedOn` | `'YYYY-MM-DD'`, workspace timezone |

- **`src/lib/timesheet/weekly.ts`** (pure): `weeklyTotals(periodDays, hoursByDate, outsideWeekHours, workweekStartDay, today)` returns `{ weekStart, total, complete, overtime }[]`.
  - `complete` means all 7 days are known and ≤ today.
  - `overtime = max(0, total − 40)` for complete weeks.
  - A week is "under 40" only when it's complete.
- **Page (Part A, minimal).** `/timesheet/page.tsx` accepts `searchParams` (Promise; may be an array) and resolves with `resolveRequestedPeriod`. **It keeps calling `getEmployeeDashboardData`**, so the old dashboard still renders until Part B removes it.

### A4.7 Past periods data
- **Action:** `getPastTimesheets({ page })`. `requireSession` first, then validate `page` (an integer ≥ 0, else 0), own data only. Then the internal `pastPeriods(db, userId, page, pageSize = 26, today, tz)` in `src/server/internal/past-periods.ts`:
  1. **Earliest bound** = the earliest of `userCreatedOn`, the user's `MIN(entry_date)` and `MIN(timesheet_periods.period_start)`, in one query. Imported entries create no period rows (`migration.ts:150,179`), so the entry date matters.
  2. Walk back from the current period with `resolver.neighbor(start, 'prev')` to the period containing the earliest bound. The walk is in memory and has no 60 cap.
  3. Slice the page.
  4. One grouped latest-revision hours query over the page's whole date range.
  5. One select of `timesheet_periods` for those starts, plus `approvalLabels` for the page's rows only.
- **Rows:** `{ start, numDays, label, status: 'notSubmitted' | 'submitted' | 'approved' | 'rejected', hours, submittedAt, reviewedAt, reviewComment (≤ 140 chars plus an ellipsis), approvalBadge, isCurrent }`. The current period comes first. **Returns** `{ rows, page, hasMore }`.

### A4.8 Deep links that survive sign-in
1. **`src/proxy.ts`:** set request header `x-cp-path` = `pathname + search`, overwriting any incoming value. Use the same `NextResponse.next({ request: { headers } })` pattern as `x-tenant-slug`. Lead-verified: internal `_rsc` parameters are stripped before the proxy runs.
2. **`src/lib/session.ts`:**
   - Add **`async function loginRedirect(): Promise<never>`**. It reads `(await headers()).get('x-cp-path')`, applies `safeNext`, and calls `redirect(...)`. `headers()` is async in Next 16 (`…/04-functions/headers.md:45`).
   - **Every caller writes `return loginRedirect();`** (or `await` and return), so TypeScript narrows and nothing falls through.
   - Replace the bare `redirect('/login')` calls in `(app)/layout.tsx:34,42,53`, `timesheet/page.tsx:20-22`, `profile/page.tsx:15`, `profile/notifications/page.tsx:13` and `requirePageRole` (`session.ts:151`).
3. **`src/lib/safe-next.ts`** (pure) exports **`safeNext(raw)`**. **Order matters:** the structural checks (`//`, backslash, allowlist, denylist) run on the **rebuilt** `pathname + search` from `new URL`, never only on the input. `new URL('/timesheet/..//evil.com', 'http://x')` normalises to `//evil.com`.
   - reject values over 512 characters;
   - decode **once** with `decodeURIComponent`, catching errors → null;
   - reject anything with a backslash, control characters or tab/newline, before or after decoding;
   - require a leading `/`, but not `//`;
   - `new URL(decoded, 'http://x')` must have origin `http://x`; rebuild from `pathname + search`;
   - the pathname must be covered, on segment boundaries, by one of `/timesheet`, `/home`, `/admin`, `/settings`, `/profile`. **Export `covers()` from `nav-config.ts`** and reuse it;
   - deny `/login`, `/api`, `/signup`, `/reset-password`, `/forgot-password`;
   - re-check the **rebuilt** string: it starts with `/`, not `//`; no backslash; no decoded `.` or `..` segment in the input;
   - anything else → `null`.
   - **`loginRedirect` must `encodeURIComponent(next)`.** The login page takes the first element if `searchParams.next` is an array.
4. **`login/page.tsx`** awaits `searchParams`, applies `safeNext` and passes `next` to `<LoginForm next={next} />`. `LoginForm` calls `router.push(next ?? '/')` after both the password and the MFA steps. **Update `routing.test.tsx:105,118,126`**, which call `LoginPage()` without props.
5. **Emails:**
   - `send.ts`: the rejected and approved send functions gain `periodStart` (`email/send.ts:91-122`).
   - The rejected and approved templates link to `${appUrl}/timesheet?period=${periodStart}`. The senders in `periods.ts` pass it.
   - The reminder emails are unchanged.

### A4.9 Old-grid wiring for notes (Part A must not lose notes)
Part A keeps the old grid but makes notes saveable:

**`TimesheetContext`:**
- **State shape:**
  - `notes` is the working copy, `Record<key, string>` of **bodies only**;
  - `savedNotes` is the baseline, `Record<key, { body: string; revision: number }>`;
  - **a cleared note stays in the baseline as `{ body: '', revision: n }`**, never deleted, so its revision survives;
  - `expectedRevision = savedNotes[k]?.revision ?? 0`.
- **Initial state:** `TimesheetProvider` initialises `notes` and `savedNotes` from **`initialData.notes`** (today `{}` at `:164`). `timesheet/page.tsx` passes `notes`, and `TimesheetPageData` (`types/timesheet.ts:99-113`) gains `notes`. That way notes show on **first load**, not only after navigating.
- **`SET_PERIOD_DATA`** also loads `notes` and `savedNotes` from `action.notes` (today `{}` at `:73`).
- **`dirtyNotes`** = keys where `(notes[k]?.body ?? '').trim() !== (savedNotes[k]?.body ?? '')`.
- `dirtyCount` = dirty cells + dirty notes. Save and Discard enable on it (`TimesheetToolbar.tsx:270,277`).
- `saveAll` sends when **either** cells or notes are dirty (today it returns early at `:218`). It snapshots the notes it sent, each with its `expectedRevision`.
- **On `ok`,** `MARK_SAVED` moves the baseline for every **sent** note to `{ body: trimmed, revision: noteRevisions[k] ?? previous }`, keeping `''` entries. The stale-period guard is kept (`:90`). Change the client's revision merge to `result.data.revisions` **in the same commit as the result-shape change** (commit 2), so tsc and the runtime stay correct.
- `DISCARD_CHANGES` restores `notes` from `savedNotes`.
- **Submit is blocked while any note is dirty**, alongside the existing dirty-cell rule.

**`DailyNoteModal`:**
- the comment field maps to `body`;
- the reason-code select is removed (L3);
- the `certified-small-items.test.ts:80` pin becomes "the note modal has no reason code" (`DailyNoteModal.tsx:22-28,45,79-84`).

`src/types/timesheet.ts`: `notes: Record<string, string>`, `savedNotes: Record<string, { body; revision }>`; `NoteData.reasonCode` is removed. **`HourCell.tsx:57`** shows the note indicator only when `notes[k]?.trim()` is non-empty, so cleared notes show no icon.

**The note modal is read-only** on cells that aren't editable (locked period, future date, `readOnly`): `HourCell.tsx:75` passes an `editable` flag. **The Next button is disabled when `isCurrent`** (`PayPeriodSelector`), so a same-period reload can't drop unsaved edits.

### A4.10 Remove the offline layer (UX3-D2)
- **Delete:**
  - `src/lib/offline/{db, offline-store, sync-service, use-online-status}.ts`;
  - `SyncStatusIndicator.tsx` and its `AppHeader` mount;
  - the seeding and sync calls (`BiWeeklyTimesheetClient.tsx:50-75`, `TimesheetContext.tsx:274-285`);
  - `dexie` (`npm uninstall dexie`).
- **One-time cleanup:** in **`AppShellWrapper`** (so it runs on any app page), a `useEffect` calls `indexedDB.deleteDatabase('bytime-offline')`, wrapped in try/catch and ignoring `onblocked`.
- **Copy:**
  - remove the landing "Offline Support" card (`src/app/page.tsx:122-126`);
  - fix `timesheet/error.tsx:31,38`;
  - remove the offline claims in `README.md:32,93`.
  - **Not Terms or Privacy** (§0 BIZ).
- **Tests:**
  - delete `sync-service.test.ts`;
  - drop `queueItemCellRef` in `grid-corrections.test.ts:44,208-213`, and drop the seeding regex at `:222-223` (`:221` already pins `action.chargeCodes`);
  - `action-results-static.test.ts:287`;
  - remove `SyncStatusIndicator` from `icon-registry.test.ts:48`;
  - remove the `vi.mock`s of `SyncStatusIndicator` (`app-shell-mobile.test.tsx:15`, `demo-marker.test.tsx:6`, `header-menu.test.tsx:10`) and `timesheet-results.test.tsx:22`.

## A5. State tables (Part A)

**Note cell** (period editable means draft or rejected, and not a future date)

| Latest (rev, body) | Client `expectedRevision` | New body | Editable | Result |
|---|---|---|---|---|
| none | 0 | non-empty | yes | insert rev 1 |
| none | 0 | `''` | yes | no-op |
| (n, X) | n | X | yes | no-op |
| (n, X) | n | Y | yes | insert rev n+1 |
| (n, X) | n | `''` | yes | insert rev n+1 `''` |
| (n, X) | ≠ n | any | yes | `ConflictError`; nothing written |
| any | any | any | submitted or approved | whole save refused (period lock), **including notes-only batches** |
| any | any | any | row not eligible | whole save refused |

**Day total** (per affected date): `new ≤ 24` → ok; `new > 24 && new > prev` → refuse; `new > 24 && new ≤ prev` → ok (L1).

## A6. Failure modes (Part A)

| Case | Behaviour |
|---|---|
| Two tabs edit the same note | The second save fails `expectedRevision` → `ConflictError`; the user reloads |
| A mixed hours + notes save where one rule fails | whole batch rolled back; client keeps everything dirty |
| Deploy order | migration 0017 before the app; an old app ignores the table |
| Hours sent as a string, `''`, `'0x8'` or `7.2500001` | refused (`must be a number` / quarter rule); nothing stored |
| An imported day at 30 hours; a correction 8 → 6 | 28 ≤ 30 → allowed (L1) |
| `?period=` garbage, mid-period or future | snapped or clamped; no error page |
| `next=%2F%2Fevil.com`, `next=/\evil`, tab or newline in `next` | `safeNext` → null |
| An assignment ended after a note was added (no hours) | the row stays visible via the note (A4.3); the note can be cleared |
| `indexedDB.deleteDatabase` blocked | ignored; retried on the next app load |

## A7. Platform limits
- **`getTimesheetPeriod`:** +2–3 small queries.
- **Save:** +2 grouped queries when cells are present, plus about 1–2 small eligibility and revision reads per note, inside the transaction.
- **Past periods:** 4 queries per page.

## A8. Blast radius (Part A)

| Area | Files |
|---|---|
| Schema and migration | `schema.ts`, `drizzle/0017_timesheet_notes.sql` (+ hand triggers), `drizzle/meta/*`, `MIGRATIONS.md`, `clear-tenant-data.ts` |
| Export | `src/lib/export/allowlists.ts` |
| Actions and internals | `actions/timesheet.ts` (`saveTimesheetBatch`, `getTimesheetPeriod`, `getPeriodCodesForEmployee`, `getTimesheetForReview`, `getPastTimesheets`), `actions/pay-period-config.ts` (`getNeighborPeriod` clamp), new internals `timesheet-period.ts`, `past-periods.ts`, `timesheet-notes.ts` |
| Validation | `src/lib/validation.ts`, `src/lib/migration/import-plan.ts` (comment only) |
| Pure libs | `src/lib/timesheet/weekly.ts`, `src/lib/safe-next.ts`, `nav-config.ts` (export `covers`) |
| Auth chain | `src/proxy.ts`, `src/lib/session.ts`, `(app)/layout.tsx`, `timesheet/page.tsx`, `profile/page.tsx`, `profile/notifications/page.tsx`, `login/page.tsx`, `LoginForm.tsx` |
| Emails | `email/send.ts`, `timesheet-rejected.tsx`, `timesheet-approved.tsx`, senders in `periods.ts` |
| Old-grid wiring | `TimesheetContext.tsx` (initial state, `SET_PERIOD_DATA`, `MARK_SAVED`, `result.data.revisions`), `TimesheetToolbar.tsx` (dirty count, Submit block), `DailyNoteModal.tsx`, `HourCell.tsx` (note indicator, modal editable flag), `PayPeriodSelector.tsx` (Next disabled at current), `types/timesheet.ts` (`TimesheetPageData.notes`), `timesheet/page.tsx` (passes notes) |
| Period navigation | `actions/pay-period-config.ts` (`getNeighborPeriod` + `isCurrent`), `integration/period-lock-integrity.test.ts:312-316` (pin the clock) |
| Other tests that change | `validation.test.ts:55` (rounding gone), `:70` (message for non-numbers), `email-send.test.ts:121-122` (`periodStart`) |
| Offline removal | per A4.10, plus `AppShellWrapper.tsx` (cleanup effect) and `README.md` |
| Tests | `timesheet-results.test.tsx` (result shape), `grid-corrections.test.ts` and `certified-small-items.test.ts` (scripted fake-DB reads; note-modal pin; clear order), `routing.test.tsx` (`LoginPage` props), plus the offline-test list in A4.10 |

## A9. Test matrix (Part A; each fails without its change; record break-its)

| ID | Test | Scenario | Break-it |
|---|---|---|---|
| A-T1 | `integration/timesheet-notes.test.ts` | rev 1 / same body no-op / rev 2 / `''` rev 3; **notes-only batch on a submitted period → refused, zero note rows**; the same on an approved period; a mixed batch on a submitted period refused; a rejected period accepts notes; notes-only needs no reason; ineligible row refused; > 1000 chars refused; future date refused; stale `expectedRevision` → conflict; a note on a row whose assignment ended keeps the row in `getPeriodCodesForEmployee` (`assignable: false`) and can be cleared | skip note dates in `assertEntryDatesEditable` (only the notes-only case can catch it) |
| A-T2 | `integration/append-only-trigger.test.ts` (extend) | UPDATE, DELETE and TRUNCATE on `timesheet_notes` fail; `clearTenantData` succeeds | drop the trigger |
| A-T3 | `unit/export-allowlists.test.ts` (C8) + assertion | notes exported, every column described | remove the entry |
| A-T4 | `integration/timesheet-read.test.ts` | latest notes per cell (cleared bodies carry their revision); `reviewComment`; `summary` for a **past** period; `submitOpensOn`; `outsideWeekHours` for edge weeks with workweek Monday and with null; `userCreatedOn`; the review returns notes and reads `submissionCount` first (static order) | notes for the current period only |
| A-T5 | `unit/validation.test.ts` + `integration/timesheet-save.test.ts` | 7.25 ok and stored `'7.25'`; 7.3 refused with the date; **7.2500001 refused; `'8'` and `''` refused (`must be a number`)**; untouched historical 7.33 not re-validated | add 1e-6 normalization; or accept numeric strings |
| A-T6 | `integration/day-total.test.ts` | **16 + 9 as two cells in ONE batch on an empty day** → refused naming the day; 16 then 9 in separate saves → second refused; 12 + 12 ok; imported 30 → 28 ok, → 31 refused; refused batch writes nothing; a notes-only batch skips the day-total queries | per-cell check only |
| A-T7 | `integration/timesheet-period-resolve.test.ts` | garbage → current; mid-period → canonical; future → current; `getTimesheetPeriod` returns the canonical start and `isCurrent`; `getNeighborPeriod('next')` at the current period stays current | accept any date |
| A-T8 | `unit/weekly.test.ts` | Monday vs Sunday workweek; edge weeks completed by `outsideWeekHours`; an incomplete future week isn't flagged; OT per complete week | Sunday-only grouping |
| A-T9 | `integration/past-periods.test.ts` | starts at the earliest of created, first entry and first period row; **imported entries before creation with no period row are listed**; submitted, approved, rejected (truncated comment) and not-submitted rows; 26-row paging with `hasMore`; `page = -1` or `'x'` treated as 0; own data only | bound by `created_at` only |
| A-T10 | `unit/safe-next.test.ts` | accepts `/timesheet?period=2026-10-01`, `/admin/users`, `/timesheet/history`; rejects `//x`, `%2F%2Fx`, `/\x`, `/%5Cx`, `https://x`, `/api/x`, `/login`, `/timesheetx`, **`/timesheet/..//evil.com`, `/timesheet/%2e%2e//x`**, tab or newline, > 512 chars; `loginRedirect` encodes the value | no decode before checking |
| A-T11 | `unit/login-redirect.test.tsx` + `routing.test.tsx` | `loginRedirect` is async and builds `/login?next=…` from `x-cp-path`; callers `return` it (static); the login page passes the sanitized `next`; `LoginForm` pushes `next` after the password and after MFA; the proxy overwrites an incoming `x-cp-path` | push `'/'` regardless |
| A-T12 | `unit/emails-period-link.test.ts` | rejected and approved emails contain `/timesheet?period={start}` | old link |
| A-T13 | `unit/offline-removed.test.ts` (static) | no `src/lib/offline` imports; no `SyncStatusIndicator`; no `dexie`; `AppShellWrapper` calls `indexedDB.deleteDatabase('bytime-offline')`; no "offline" claims in `src/app/page.tsx` or `README.md` | leave the badge |
| A-T14 | `unit/timesheet-notes-wiring.test.tsx` (jsdom, old grid) | **a server note shows on the first render from `initialData`**; **clear → save → re-add → save sends `expectedRevision` = the cleared revision and succeeds**; a cleared note shows no icon; the note modal is read-only on a locked or future cell; Next is disabled at the current period; typing a note enables Save; Save sends `notes` with `expectedRevision` and no reason; after ok the note is clean (also when the server no-ops); Discard reverts a note; Submit is disabled while a note is dirty; the period load shows server notes | `saveAll` early return on cells only |

## A10. Verification (Part A)
```bash
npx tsc --noEmit && npm run lint && npm run test && npm run test:tz && node --import tsx scripts/check-migration-safety.ts
```

**Product owner** (each separately):
1. **Migrate the local tenant databases.** Your existing local tenants need migration 0017 before the integration tests. Check for a `db:migrate:all` script with `npm run`, or use the repo's `MIGRATIONS.md` instructions.
2. **Integration** (the standard command, `REQUIRE_CONTROL_PLANE_TESTS=1`).
3. **Lead's Postgres break-it script** for Part A.
4. `npm run build && node scripts/check-build-trace.mjs`.
5. `npm run demo:local` ×2.

**Browser checks:**
- As Jane:
  - type a note and save, then reload: the note is still there;
  - try 7.3 hours: refused with the message;
  - try 16 + 9 on one day: refused, naming the day;
  - submit, then try changing a note: refused.
- As Sarah, open Jane's submitted timesheet in Approvals: notes are returned. The drawer UI comes in Part B, so check the network response or the minimal display.
- Sign out, open `/timesheet?period=2026-10-01`, sign in: you land on that period.
- The header shows no "Synced" badge.

# PART B: screen and accessible grid (`ux-timesheet-ui`, after Part A merges)

## B3. Invariants (Part B)
1. **Server rules are authoritative.** The client mirrors quarter-hour and 24-per-day checks for instant feedback, but the server decides.
2. **Save, reason and submit semantics are unchanged:**
   - one batch;
   - ReasonModal for edits or late entries;
   - certification at submit;
   - all-or-nothing.
3. **No silent data loss.** Unsaved hours or notes are never discarded without confirmation (period change, in-app navigation, tab close).
4. **WCAG 2.1 AA** for the page, verified by axe in jsdom plus the manual script (B10).
5. **UX-1 tokens, `Icons`, `PageHeader`** (one h1).

## B4. Design

### B4.1 Page layout (mockup "Employee timesheet")
Top to bottom:
1. **`PageHeader`** titled "Timesheet" (h1).
   - **Left, the period control:**
     - ‹ "Previous period";
     - the period label (nowrap);
     - › "Next period" (`aria-disabled` at the current period, with reason text "This is the current period");
     - **"Choose period"** `Select` (labelled) listing 24 back plus the current one;
     - **"Today"** button when not on the current period.
   - **Right:**
     - the status pill **once**, plus the **self-approval badge** where applicable (CO-D6 / C2: self-approval is labelled wherever the timesheet appears; today `TimesheetToolbar.tsx:252-253`);
     - **Save** (enabled when `hasUnsaved`) and **Submit**;
     - **Discard changes** (quiet; confirm when unsaved).
   - **Submit** uses `aria-disabled` + `aria-describedby`, with **visible reason text at ≥ 0.875 rem**: "Opens {dddd, MMM D}" / "Save your changes first" / "Add hours before submitting".
2. **Status line** (`<p>`, **deliberately not live**; this overrides the mockup's `role="status"`, see T-K).
   - **Total hours and filled workdays** are computed **from client state** (`state.entries`), so they follow edits.
   - **`expectedWorkdays` and the due date** come from the selected period's server `summary`.
   - **Text:** "{total} hours entered · {filled} of {expected} workdays so far are filled in · Due {dddd, MMM D}". Submitted, approved or rejected periods say "Submitted {date}" or "Approved {date}" from the period's dates. Right after submitting, use `state.today`.
3. **Rejected banner** for any rejected period, from `state.reviewComment`.
4. **Weekly notice** from `weeklyTotals` (complete weeks only), using the workspace workweek.
5. **The grid** (B4.2), with the hint bar (`aria-hidden`) and `#ts-keys`.
6. **"Past timesheets"** link for every role.

- **Submit availability** = editable ∧ ¬`hasUnsaved` ∧ has hours ∧ `!isBefore(state.today, submitOpensOn)`. `today` is refreshed by `SET_TODAY`.
- **`SubmitModal` behaviour is kept unchanged:** certification, exempt wording, `completenessWarnings` and FLSA totals (`TimesheetToolbar.tsx:110-172,337-347`). Move these into a hook (`useSubmitChecks`); don't drop them.
- **Removed:** `TimesheetDashboard`, the duplicate rejected alert, the mid-page "Semi-Monthly Timesheet" title, the "Current" button, and the page's `getEmployeeDashboardData` call. **Update `loading.tsx`.**

### B4.2 Grid structure
The tree is unchanged from v1:
- `<table role="grid">` inside `div.scroller`;
- a caption;
- `th scope=col` day headers;
- `th scope=rowgroup` group rows;
- `th scope=row` row headers;
- a `tfoot` totals row;
- `useId()`-prefixed ids.

Changes:
- **Explicit `role="gridcell"` on every `td`,** so jsx-a11y doesn't flag tabindex on a non-interactive element.
- **`div.scroller`:** `overflow: auto; max-height: calc(100dvh - var(--ts-chrome, 16rem))`. Sticky only works inside the scrolling box, so this makes the sticky `thead` and first column stick.
- **Day headers follow the mockup:**
  - the visible day name and date ("Today" in place of the date on today's column);
  - **a fill meter** (`aria-hidden`);
  - **no "Late" badge** (the meter replaces it, V5);
  - sr-only text "Monday Oct 19[, today], {h} hours[, no hours logged]". "No hours logged" applies only to past weekdays on or after `userCreatedOn`.
- **The editing input** uses `aria-labelledby="rh-{key} ch-{d}-name"`, where `ch-{d}-name` is a hidden span holding only the day name and date. The edit name then doesn't include "no hours logged".

### B4.3 Keyboard model
Same key tables as v1, with these corrections:
- **`preventDefault()`** on every key the grid handles in navigation mode:
  - arrows, Home/End, Ctrl+Home/End, PageUp/PageDown;
  - Enter, F2, Space, Delete/Backspace, N;
  - **and the seeding digit or `.`**, so the browser doesn't insert the character a second time into the just-focused input. The draft must be exactly "7" after typing 7.
- **Esc, Enter and arrow commits from edit mode** set a `suppressBlurCommit` ref (or switch modes with `flushSync`) **before** moving focus. Otherwise the input's blur would commit a draft Esc meant to discard, or commit twice.
- **While editing,** the cell's own `td` gets `tabIndex = -1`, so Shift+Tab can't land on it.
- **`onChange` normalization:**
  - apply NFKC (full-width digits) and turn `,` into `.`;
  - then filter to `^\d{0,2}(\.\d{0,2})?$`;
  - a lone `.` or an empty value commits as 0.
- **Validation on commit** mirrors the server:
  - quarter hours;
  - 0–24 per cell;
  - a day total of 24 or less, unless the new total is no higher than the saved total (L1).

### B4.4 State and implementation
- **Context state additions in `TimesheetContext`.** The reducer's `SET_PERIOD_DATA` sets **all** of them:
  - `savedNotes`;
  - `reviewComment`;
  - `summary`;
  - `submitOpensOn`;
  - `workweekStartDay`;
  - `outsideWeekHours`;
  - `userCreatedOn`;
  - `isCurrent`;
  - plus Part A's `notes`, `dirtyNotes` and `hasUnsaved` (dirty cells or dirty notes).
- **A4.9's note dirty-tracking rules stay:** the baseline moves only for sent notes, no-op notes become clean, `DISCARD_CHANGES` reverts, and Submit is blocked while unsaved.
- **Re-sync on RSC navigation.** Same route, different `?period=` (for example the sidebar "Timesheet" link): when the page's `initialData` object changes, dispatch `SET_PERIOD_DATA` from it. Next keys the page segment without search params (`layout-router.js:488`), so the component doesn't remount and `useReducer` would keep the old period. The guard (B4.9) has already confirmed nothing is unsaved.
- **Rendering:**
  - grid-local `{ active, mode, seed }`;
  - delegated handlers;
  - `memo(HourCell)` with plain props;
  - a separate, stable `dispatch` context;
  - rows precomputed once per render.
- **No `NumberInput`;** use a plain input.
- **On period changes:** clamp the active column on `SET_PERIOD_DATA`, and cancel any edit on `BEGIN_PERIOD_LOAD`.
- **`useSaveFlow()` hook,** shared by the toolbar and the guard, exposes `requestSave(): Promise<boolean>`:
  - it opens ReasonModal when hours need a reason;
  - it resolves false when ReasonModal is cancelled or the save fails, and true on success;
  - if a save is already running, it awaits that save instead of starting a second one.

  ReasonModal moves into the provider so both callers can use it.

### B4.5 Announcements
Unchanged from v1:
- polite and assertive regions, empty at mount;
- `announce()`;
- no live totals or status line;
- error toasts don't auto-close.

### B4.6 Visual states (never color alone)
As in v1, except:
- a **late weekday** shows as an empty meter plus sr ", no hours logged", with no visible badge (per the mockup);
- a **future** cell dims its text only, never the cell itself, because opacity would also dim the focus ring.

The focus ring is as in v1: inset, on `:focus`, with a body-colored inner band.

### B4.7 Reflow: no dense mode
As in v1:
- no `getDensity`;
- minimum 0.875 rem;
- rem-based columns;
- sticky header and first column inside the height-limited scroller;
- no `overflow: hidden` on the grid or cells.

Plus:
- **Delete the whole `globals.css:6-10` rule, including `max-width: 100vw`.** On Windows, 100vw includes the scrollbar, so once `overflow-x: hidden` goes it would create a horizontal scrollbar. Check that no page scrolls sideways (B9).
- **Week view below 40 em (640 px).** This covers 400% zoom on a 1280 px window, and phones.
  - Use `useMediaQuery('(max-width: 40em)', false)`. The first paint is the full grid, then it switches.
  - `data-c` stays the **period day index**; the visible columns are the selected week's indexes.
  - ← / → at a week edge **switch to the adjacent week** and continue.
  - PageUp / PageDown switch weeks.
  - On a view switch (resize or zoom), the selected week follows the active column, and any edit is cancelled: the draft is discarded and the cancellation is announced.

### B4.8 Notes UI
- **Toolbar button:** "Add note" / "Edit note", with `aria-label="… note, {row}, {Mon Oct 19} (N)"`.
- **`NoteModal`:**
  - a 1000-character Textarea;
  - Save note, Cancel and Remove note;
  - read-only when the period is locked;
  - a saved note stays dirty until the timesheet's Save.
- **Focus return follows one rule.** `NoteModal` sets `returnFocus={false}` and calls `grid.focusActive()` in `onExitTransitionEnd`. Focus **always returns to the active cell**, whether N or the toolbar button opened the modal.
- **Commit any edit before opening.**

### B4.9 Unsaved-changes guard (no silent loss)
A shared module, `src/lib/timesheet/unsaved-guard.ts`, holds the current `hasUnsaved` and `requestSave` (registered by the timesheet provider). It exports `confirmLeave(): Promise<boolean>`, which shows the confirm "You have {n} unsaved changes" with three choices:
- **Save and continue:** calls `requestSave()` and proceeds only on true. The confirm closes before ReasonModal opens.
- **Discard and continue.**
- **Cancel.**

It covers:
1. **Period changes:** previous, next, choose, Today, and the Past timesheets link.
2. **In-app links:**
   - a capture-phase document click listener on `closest('a[href]')` for same-origin paths;
   - it ignores modifier clicks, any `target` other than `_self`, and `download`;
   - it calls `preventDefault()` and, after `confirmLeave()` resolves true, `router.push(href)`.

   Lead-verified: Next `Link` returns early when `defaultPrevented` is set (`client/app-dir/link.js:319`).
3. **Sign out:** `signOutToLogin()` awaits `confirmLeave()` **before** calling `signOut()`.
4. **Tab close or reload:** a `beforeunload` handler while unsaved, calling `e.preventDefault()` and setting `e.returnValue = ''`.
5. **Browser Back/Forward.** Next treats `popstate` as a client navigation (`app-router.js:288-297`), so it can't be intercepted reliably. Instead, a draft is kept:
   - **Writing:** while unsaved, the provider writes a draft to **`sessionStorage`**, key `cp:ts-draft:{userId}:{periodStart}`, debounced at 500 ms. It holds the dirty cell values, the dirty notes, and the saved revisions they were based on.
   - **Restoring:** when a period loads with a draft whose base revisions still match, show "You have unsaved changes from earlier on this timesheet." with **Restore** and **Discard**.
   - **Clearing:** on a successful save, on discard, on sign-out (`signOutToLogin`), and when the base revisions no longer match. In the mismatch case, tell the user: "Your earlier unsaved changes were dropped because the timesheet changed."
   - sessionStorage is per tab and cleared when the tab closes, so nothing persists on a shared computer.
6. **Discard changes button:** confirm "Discard {n} unsaved changes?".

### B4.10 URL sync
- After a period loads: `history.replaceState(null, '', isCurrent ? '/timesheet' : '/timesheet?period=' + start)`.
- On first mount, also replace the URL when the server snapped or clamped the requested period.

### B4.11 Past timesheets page
As in v1:
- route `/timesheet/history`, behind the session guard;
- a table with status words and the self-approved badge;
- "Load more", and "(current)" on the current period;
- an employee nav entry;
- approvers reach it through the link.

`page-metadata` goes to 33 pages.

### B4.12 Approvals drawer notes
- Build the list from the `notes` map: date · row name · body. The row name falls back to "Removed code" when the row isn't in the drawer's list.
- Cells with a note show the note glyph plus sr ", note".
- A missing `notes` is treated as `{}`. Update the mock at `approvals-client.test.tsx:18`.

### B4.13 Copy
As in v1: indirect rows are named by the code's name, and sentence case throughout.

## B5. State tables (Part B)

**Cell mode:** as v1, plus:
- digits and `.` are `preventDefault`ed when seeding;
- Esc, Enter and arrow commits suppress the blur commit;
- in week view, ← / → at an edge switch weeks.

**Notes**

| State | Event | Next |
|---|---|---|
| clean | edit in NoteModal → Save note | dirty |
| dirty | timesheet Save ok (written or no-op) | clean (baseline = sent body) |
| dirty | Save fails | dirty |
| dirty | Discard | clean (restored) |
| dirty | Submit | blocked ("Save your changes first") |

**Unsaved guard**
- `clean` + navigate → navigate.
- `unsaved` + navigate → confirm, then:
  - Save ok → navigate;
  - Save fails or reason cancelled → stay;
  - Discard → navigate;
  - Cancel → stay.

**Draft**

| Situation | Draft |
|---|---|
| unsaved | written (debounced) |
| saved, discarded, signed out, or base mismatch | removed |
| period load with a matching draft | Restore / Discard prompt |

## B6. Failure modes (Part B)

| Case | Behaviour |
|---|---|
| Save fails | everything stays dirty; assertive message; focus stays |
| Navigation during save | the period control is disabled while saving; the guard awaits the running save |
| Back/Forward with unsaved edits | navigation happens; the draft is restorable on return (B4.9.5) |
| Sign out with unsaved edits | confirm first; the draft is cleared on sign-out |
| Same-route navigation to `/timesheet` from `?period=X` | re-sync from `initialData` (B4.4) |
| Uncommitted draft in the input at reload | lost. Accepted: it was never committed, and committed values are in the sessionStorage draft. |
| View switch mid-edit | edit cancelled and announced |
| Windows scrollbars after the overflow rule is removed | B9 check |
| IME composing | no type-to-edit until composition ends |

## B7. Blast radius (Part B)
- **Rewritten:**
  - `BiWeeklyTimesheetClient` → `TimesheetClient`;
  - `BiWeeklyTable` → `TimesheetGrid`;
  - `cells/*`;
  - `TimesheetToolbar`, split into `TimesheetHeader`, `SaveSubmitControls`, `WeeklyNotice` and `useSubmitChecks`. It **keeps the SubmitModal inputs and the self-approval badge**;
  - `PayPeriodSelector` → `PeriodControl`;
  - `DailyNoteModal` → `NoteModal`;
  - `Timesheet.module.css`;
  - `TimesheetContext`: state additions, the context split, `useSaveFlow`, ReasonModal moved into the provider, re-sync and the draft.
- **Removed:** `TimesheetDashboard`.
- **New:** `src/lib/timesheet/unsaved-guard.ts`; `timesheet/history/page.tsx` (+ client); the employee nav entry.
- **Touched:** `src/components/auth/sign-out.ts` (`confirmLeave`, draft clear), `ApprovalsClient` (notes), `globals.css`, `loading.tsx`.
- **Tests to update:**
  - `grid-corrections` (source regexes);
  - `certified-small-items` (repoint the ReasonModal `canSubmit` pin to its new path; the note pin becomes "NoteModal has no reason code");
  - `action-results-static` (new save/submit consumer path);
  - `icon-registry` (timesheet files on `Icons`, removed from the allowlist);
  - `timesheet-results` (mock paths);
  - `approvals-client` (notes in the mock);
  - `page-metadata` (33 pages);
  - the sign-out tests.

## B8. Test matrix (Part B)
**Add exact-version devDependencies:** `@testing-library/dom` (10.x) and `@testing-library/user-event` (14.x). `.npmrc` sets `legacy-peer-deps`, so the dom peer isn't installed automatically. Tests mount with `createRoot`, so wrap user-event calls in `act`, or import `@testing-library/react` once so it configures `act` for user-event.

| ID | Test | Scenario | Break-it |
|---|---|---|---|
| B-T1 | `unit/timesheet-grid-structure.test.tsx` | grid table with caption; correct `scope`s; explicit `role=gridcell`; exactly one `tabindex=0`; empty cells blank; `aria-readonly` on future, closed, total and locked cells; day-header sr text includes the hours, and "no hours logged" only for past weekdays on or after `userCreatedOn`; no "Late" badge; axe clean | render divs |
| B-T2 | `unit/timesheet-grid-keyboard.test.tsx` (user-event) | arrows, Home/End, Ctrl+Home/End and PageUp/PageDown move the single tab stop; edges stop; group rows skipped; Tab leaves; handled keys are `defaultPrevented` | wrap at edges |
| B-T3 | same | **typing 7 gives a draft of exactly "7"**; Enter, Tab, ↑ and ↓ commit once (`SET_HOURS` × 1); edit-mode Esc discards **and the blur doesn't commit**; nav-mode Esc restores and announces; Delete → 0; Enter on a read-only cell announces; Shift+Tab from the input leaves the grid; `,` normalized to `.`; a full-width digit is accepted | remove the seeding `preventDefault` |
| B-T4 | same | 7.3 invalid, stays in edit mode, assertive message; a day over 24 blocked unless ≤ saved (L1); blur on an invalid value restores | allow 7.3 |
| B-T5 | `unit/timesheet-notes-ui.test.tsx` | N and the toolbar button open NoteModal; Save note → dirty; timesheet Save sends notes only (no ReasonModal); Remove → `''`; locked → read-only; **focus returns to the active cell** after Save, Cancel and Esc, for either opener; axe with the modal open | keep the default `returnFocus` |
| B-T6 | `unit/timesheet-page-layout.test.tsx` | one h1; status pill once **plus the self-approval badge**; the status line follows **edits** (total changes after a commit) and the **selected** period's expected and due values; rejected banner for a past rejected period; Submit `aria-disabled` with visible reason; Submit enables when `today` passes `submitOpensOn` (dispatch `SET_TODAY`); SubmitModal receives `completenessWarnings` and FLSA totals; next `aria-disabled` at the current period; weekly notice uses the workweek, complete weeks only | compute the status from the server summary only |
| B-T7 | `unit/timesheet-unsaved-guard.test.tsx` | dirty + prev → confirm → Save and continue (ok → moves; ReasonModal cancel → stays); Discard → moves; Cancel → stays; a sidebar link is intercepted when dirty, not when clean, not on modifier clicks, not on `target=_blank`; **sign-out awaits `confirmLeave` before `signOut`**; a cancelable `beforeunload` event is `defaultPrevented` only while dirty; **the draft is written while dirty, Restore is offered on reload with matching revisions, the draft is dropped on mismatch with a message, and cleared on save, discard and sign-out** | navigate without the guard; or sign out first |
| B-T8 | `unit/timesheet-url-sync.test.tsx` | uses `replaceState`, not `router.replace`; `?period=` for past periods, a clean URL for the current one; URL corrected on mount when the server snapped; **a same-route `initialData` change re-syncs the grid** | `router.replace`; no re-sync |
| B-T9 | `unit/timesheet-week-view.test.tsx` | narrow (`matchMedia` stub) → week control; only that week's columns; ← at the week edge moves to the previous week; PageDown switches weeks; a view switch mid-edit cancels the edit; Total is the period total | render all columns |
| B-T10 | `unit/timesheet-render-cost.test.tsx` | a **test-only render counter inside the real `HourCell`** (e.g. `globalThis.__cellRenders`, enabled in tests); committing one cell re-renders at most that cell, its row total, the footer and that day's header | drop `memo` |
| B-T11 | `unit/past-timesheets-page.test.tsx` | rows, status words, self-approved badge, links with `?period=`, Load more, "(current)", axe; employee nav "Past timesheets" active by longest prefix | — |
| B-T12 | `unit/approvals-notes.test.tsx` | notes listed from the map; "Removed code" fallback; cell glyph plus sr text; a missing `notes` doesn't crash | — |
| B-T13 | `unit/no-dense-mode.test.ts` (static) | no `getDensity`; no CSS font-size below 0.875 rem in the timesheet CSS **and no `size="xs"` text in the timesheet TSX**; `globals.css` has no html/body `overflow-x: hidden` or `max-width: 100vw` | — |
| B-T14 | `unit/timesheet-announcer.test.tsx` | live regions empty at mount; status line not live; error toasts don't auto-close | make the status line `role=status` |

## B9. Verification (Part B)
The standard gates plus integration, build and `demo:local` ×2. **Browser checks** (light and dark):
1. As Jane:
   - the grid starts near the top;
   - status, period control and actions are in one band;
   - no "—" in empty cells;
   - rows are one line plus the code.
2. **Keyboard only:**
   - Tab into the grid; arrows move; type `7.5` and press Enter (shows "unsaved");
   - type `7.3`: refused with a message;
   - Esc on a changed cell restores it;
   - N opens a note; save it; focus returns to the same cell;
   - Save; Submit says why it's unavailable.
3. **Unsaved guard:**
   - change a cell, then press ‹: a confirm appears;
   - click Home in the sidebar: a confirm appears;
   - reload the tab: the browser warns;
   - press the browser Back button, then come back: "Restore unsaved changes?" appears;
   - sign out: a confirm appears first.
3b. **No sideways page scroll** on Home, Users and Charge codes at 1280 px with Windows-style scrollbars.
4. **Past timesheets:** rows include "Not submitted" periods; clicking one opens it; the URL shows `?period=`; reload keeps it.
5. **Narrow window, or browser zoom 400%:** week view, no clipped text, everything reachable.
6. **VoiceOver** (Safari): Tab into the grid → it announces the row, the day and the value; moving across days announces the day; editing announces the row and day name. (Full manual script in B10.)
7. **As Sarah:** open Jane's submitted timesheet in Approvals; the notes are listed.

## B10. Manual screen-reader script (record the results in the audit)
**Readers:** NVDA + Firefox, JAWS + Chrome (if available), VoiceOver + Safari (macOS and iOS). For each:
- entering focus mode;
- row and column header announcement on moves;
- state words (unsaved, note, imported, read only);
- the read-only reason;
- the edit-mode name;
- error announcement;
- note round trip with focus return;
- period-change announcement;
- Submit's reason;
- VoiceOver Quick Nav on and off (the N key versus the button).

## 11. Known traps
- **T-A** Exports from `'use server'` files are public. New internals go in `src/server/internal/`.
- **T-B** The notes table needs the DB triggers. App-only append-only isn't enough (DCAA).
- **T-C** `clearTenantData` delete order is statically tested; add notes before `users`.
- **T-D** Quarter hours: `Number.isInteger(v * 4)`, **no normalization**. Never `% 0.25`.
- **T-E** The day-total check must use `tx` (inside the lock) and `LATEST_REVISION`, and compare with the pre-save total (L1).
- **T-F** Never a raw `Date` in `sql`; dates are strings.
- **T-G** `searchParams` is a Promise and may hold arrays.
- **T-H** Use `history.replaceState`, not `router.replace` (that re-runs the force-dynamic page and double-loads).
- **T-I** A `NumberInput` in the grid fights the arrow keys and the formatting; use a plain input.
- **T-J** iOS opens the keyboard only on synchronous `focus()` in the gesture; use `flushSync`.
- **T-K** Live regions must exist empty at mount; never put totals or the status line in a live region.
- **T-L** No `opacity` on focusable cells (it dims the ring); dim the text only.
- **T-M** Sticky positioning breaks under any ancestor with `overflow: hidden`.
- **T-N** Mantine Modal returns focus only to a still-mounted opener; commit the edit first and keep the fallback.
- **T-O** Don't edit the Terms or Privacy pages (business side).
- **T-P** The demo tenants (acme, globex, initech) are never used for destructive or repro testing.

## 12. Dev-agent hand-off rules
Follow `BLUEPRINT-STANDARD.md` §3.

**Part A commit order:**
1. A4.1 schema, migration, triggers, export and clear-tenant (A-T1 partial, A-T2, A-T3);
2. A4.2–A4.3 note save and read (A-T1, A-T4 notes);
3. A4.4–A4.5 quarter hours and day total (A-T5, A-T6);
4. A4.6–A4.7 period resolution, summary, weekly and past periods (A-T4, A-T7, A-T8, A-T9);
5. A4.8 deep links and emails (A-T10–A-T12);
6. A4.9 old-grid note wiring (A-T14), then A4.10 offline removal (A-T13).

**Part B commit order** (after Part A merges, on a new branch):
1. context split and grid structure (B-T1, B-T10);
2. keyboard and editing (B-T2–B-T4, B-T14);
3. notes UI (B-T5);
4. page layout, weekly notice and URL sync (B-T6, B-T8);
5. unsaved guard (B-T7);
6. week view and reflow (B-T9, B-T13);
7. past timesheets page and approvals notes (B-T11, B-T12).

**Stop and ask** when anything doesn't match the code. **Don't push.** Report the break-its, the changed pre-existing tests and anything you couldn't run.

## 13. Pre-mortem record

**Round 1 (2026-10-27).** Two reviewers raised 7 HIGH and 19 MEDIUM findings. The lead verified the server-side HIGHs in the source:
- `validateHours` coercion and raw storage (`validation.ts:67`, `timesheet.ts:378`);
- the cells-only early return in `saveAll` (`TimesheetContext.tsx:218`).

**HIGH fixes in v2:**
- **Part A:**
  - a notes-only lock test that can actually fail;
  - hours must be real numbers, with exact quarter checks and no normalization (this also closes the existing `''` / `'0x8'` storage hole);
  - old-grid note wiring so notes actually save.
- **Part B:**
  - full note dirty-tracking;
  - `preventDefault` on type-to-edit (the digit was entered twice);
  - `@testing-library/dom` added (the user-event peer);
  - the unsaved-loss paths: Back/Forward handled by a sessionStorage draft, and sign-out guarded.

**MEDIUM fixes:**
- note eligibility checked inside the transaction (no second connection);
- notes keep their row visible;
- note `expectedRevision`;
- dashboard kept during Part A;
- `getNeighborPeriod` clamp;
- fake-DB tests scripted for the new reads;
- async `loginRedirect`;
- past periods include imported entries;
- note-modal test pins updated;
- clear order;
- `check()` declared in the schema;
- dead imported-start branch removed;
- the result-shape test;
- same-route re-sync;
- selected-period state fields;
- the `requestSave` flow;
- blur/Esc suppression;
- one focus-return rule;
- height-limited scroller for sticky headers;
- `max-width: 100vw` deleted;
- SubmitModal inputs and the self-approval badge kept;
- mockup day headers (meter, no Late badge);
- a real render counter;
- week-view details.

**Round 2, Part A (2026-10-27).** One fresh reviewer found 3 HIGH and 5 MEDIUM findings, all fixed in Part A v3.

HIGH:
- notes passed and initialised on first load;
- `getNeighborPeriod` keeps its shape and adds `isCurrent`, with the clock-dependent test pinned;
- a cleared note keeps its revision in the baseline.

MEDIUM:
- numeric day totals with a missing date as 0, and a one-batch test;
- `safeNext` validates the rebuilt URL (dot-segments) and `loginRedirect` encodes;
- T-D aligned;
- the cleared-note icon fixed;
- the result-shape client change moved into commit 2.

LOW items are recorded inline (Next disabled at the current period, read-only note modal on locked cells, test updates, line numbers).

Per the two-round limit, **Part A is handed off**; anything left is caught in the code audit.

**Round 2, Part B (2026-10-27).** One fresh reviewer found 4 HIGH and 7 MEDIUM findings:
- v2 referenced v1 text that no longer exists;
- the scroller collapses at 400% zoom;
- the Back/Forward cache defeats draft matching;
- the first-load fields are missing.

**Part B will be rewritten as a self-contained v3 with its own review before implementation.**
