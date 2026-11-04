# Blueprint UX-4b Part 2: Approvals review and Payroll export

> **Status:** v3 FINAL, 2026-11-04, lead architect. Pre-mortem rounds 1 and 2 are applied (§13). The two-round limit is reached; the code audit catches the rest.
>
> **Branch:** `ux-approvals-payroll`, cut from `main` **after UX-4b Part 1 merges**. It uses the Part 1 kit: `StatusBadge` / `STATUS`, `Notice`, `PageHeader`, `formatHours`, `numericColumn`, `useAppTable` options, `useBusy`, `WriteButton` (read-only aware), `toastError` / `toastSuccess`, `lastCompletedPeriods`, `PeriodPresetSelect`, and `saveBlob`.
>
> **Approved design:** `ux-mockups/ux4-batch1.html`, screens Approvals and Payroll export. Match it, except where §0 says otherwise.
>
> **Sources:**
> - `UX-4-AUDIT.md` §4 and C18;
> - the research pass (2026-11-03);
> - two pre-mortem reviews (2026-11-04).

---

## 0. Lead rulings (no product decisions)
| # | Ruling |
|---|---|
| A1 | **"Return for corrections" is display only.** The stored status, the event value, the `rejectPeriod` action and the email ids are unchanged. `approvalLabel`'s existing fields (`kind`, `text`, `badge`, `approverName`, `selfApproved`) stay as they are, because they feed the PDF, reports, the v1 API and exports. It **adds** `uiText` / `uiBadge` for every kind (§3.1.4), formatted in the same file. The employee timesheet's "Self-rejected" badge is out of scope (recorded). |
| A2 | **Server-side comment rule:** `rejectPeriod` refuses an empty, whitespace or non-string comment; both decisions refuse > 1,000 characters; the trimmed comment is stored. |
| A3 | **One waiting order** in a **pure** module (`src/lib/approvals/waiting-order.ts`, `compareWaiting`): period start, then submitted-at (nulls last), then employee name (`localeCompare`, sensitivity "base"), then period id. `approvalQueue` sorts in JS with it (it already loads every submitted row unpaginated), and the client list and "open next" use the same function. There's no SQL ORDER BY to keep in agreement. |
| A4 | **"Worth a look" counts cells** (`source = 'app'`):
  - **corrections:** cells whose latest revision > 1;
  - **late entries:** cells whose revision 1 carries a reason **and** whose latest revision is 1 (a late cell that was later corrected counts as a correction; the Drawer notes it was originally late);
  - **resubmitted:** `submissionCount > 1`.

  An empty list cell renders nothing. |
| A5 | **The review is a Drawer** (right, `size="xl"`, full width below 48em) with Previous / Next in its header. |
| A6 | **Hours show on Waiting rows only.** |
| A7 | **Payroll Leave = paid leave** (PTO, sick, holiday). Unpaid is excluded from Leave and Total paid. The CSV formats are unchanged. |
| A8 | **No "Remind" button.** "Daily hours detail" stays as a secondary download. |
| A9 | **Demo seed** modifies the existing pending-review period (never adds period rows) to show corrections, a late entry, a note and a returned-then-resubmitted history, with explicit, ordered, past timestamps. |
| A10 | **Every decision is bound to the review that's on screen:**
  - it sends `periodId: reviewData.periodId` and `seen: reviewData.submissionCount` from the **same object**;
  - the decision card renders **only** when `reviewData && reviewData.periodId === current.id`;
  - status, self rules and `canApprove` for the card come from `reviewData`;
  - a failed or in-flight read sets `reviewData = null`;
  - the Drawer's title and header always describe `current`.

  Without this, Previous / Next could approve a timesheet the reviewer never saw (DCAA C2). |
| A11 | **The Payroll F10 warning stays.** When any employee's overtime depends on unapproved days, a warning shows **above** the download buttons, and those people are marked in the table. |

## 1. Verified current state
At `main` `4333674` / the Part 1 branch; re-verify line numbers after Part 1 merges.

### 1.1 Approvals
- **Page:** `admin/approvals/page.tsx:14-22` (`requirePageRole('approver')`; `getScopedPeriods`, `getMyScopeInfo`, timezone; `ApprovalNotices` above the h1, `:26`). No `searchParams`.
- **Client** `ApprovalsClient.tsx`:
  - `periods = useState(initialPeriods)` (`:154`), refreshed by calling `getScopedPeriods()` after a decision (`:213`, `:244`; `router.refresh()` alone wouldn't update it);
  - `openReview` sets `reviewData` to null first (`:178`);
  - decisions send `periodId: selectedPeriod.id` and `seen: reviewData.submissionCount` (`:202-205`, `:233-236`);
  - views `:68` (Decided = every decided period in scope, `:70`); a controlled sort `SORT_FOR` (`:75-76`);
  - columns `:259-318`; "Nothing unusual" `:339`; the Drawer `:450`; two textareas `:530-544`;
  - `ReviewDecisionButtons.tsx:26-43` renders `WriteButton`s (the read-only gate) with `disabled={!canReject}` and `loading`;
  - errors appear twice; toasts say "Timesheet Rejected"; raw status badges `:283`, `:468`.
- **Server** (`actions/periods.ts`):
  - `getScopedPeriods` (`:459`);
  - `approvePeriod` (`:408`) / `rejectPeriod` (`:422`) → `decidePeriod` (`:336`): the `seen` check first, then self rules, `canApprove` and status submitted, then a transaction with `lockUserRulesShared` and a conditional UPDATE on `status='submitted' AND submission_count=seen` (`:373`), plus `period_events`. **No server comment check.** Every existing test reject passes a non-empty comment.
- **`internal/approval-queue.ts`:** `'server-only'` + `getDb` (`:1-4`); orders in SQL by submitted-at then period start (`:27-63`); `getWaitingCount` (`:69`). `unit/approval-queue.test.ts:42-45` pins the ORDER BY text.
- **`internal/period-flags.ts:23-54`:** one grouped query over rows, `GROUP BY user_id, entry_date` (`:40`); `hours` is **varchar** (`schema.ts:313`).
- **Late rule:** `saveTimesheetBatch` (`timesheet.ts:372-374, 404-411`): revision 1 of a past day stores a reason; later revisions store their own reason; revision 1 keeps its reason.
- **`approvalLabel`** (`internal/approval-label.ts`): `ApprovalKind` (`:13-14`) covers approved, rejected, self-approved, self-rejected, imported-approved, imported-rejected (and none); fields `kind`, `text`, `badge`, `approverName`, `selfApproved`.
  - `loadApprovalLabelData` (`:133`) reads every event of the period; `approvalLabels` returns no events.
  - Consumers: the v1 API (`selfApproved` only), reports (`badge`, `approverName`, `text`), and the employee timesheet / past periods (`badge`).
  - The static scan `Self-(approved|rejected)` is in `approval-decisions.test.ts:384`.
- **`getTimesheetForReview`** (`timesheet.ts:468-511`): guard; the period row (with `id`, `submissionCount`) **first**, statically enforced; `periodLengthFor` re-reads the period; notes; codes; `getTimesheetEntriesForEmployee` (`:657-716`: reads every revision and keeps the latest, selecting `changeReasonCode` but not `comment` or `createdAt`; it calls `periodLengthFor` **again**, `:665`; `getTimesheetPeriod` `:86` is the other caller); facts; labels.
- **Static tests:** `approval-decisions.test.ts:387` (`seen: reviewData.submissionCount` exactly twice, plus `if (!reviewData) return null;`), `:392`, and `integration/timesheet-read.test.ts:207`.
- **`workspace-mode.test.tsx:36-46`** pins the decision buttons as `WriteButton`s labelled "Reject".

### 1.2 Payroll export
- **Page:** `page.tsx:10-13` (`requirePageRole('admin')`, passes `today`).
- **Client** `PayrollExportClient.tsx`:
  - defaults to this month (`:52-55`);
  - the F4 `rangeKey` rule (`:56-61`), "so the flagged employees are always seen before a file is downloaded";
  - **the `payroll-flagged` Alert above the buttons (`:199-207`)**, plus a "Flagged" badge per person (`:313`);
  - downloads gated only by `disabled={!canDownload}` (`:227, 237`);
  - a "no approved data" toast on every preview (`:76-78`); `setPreviewState` set unconditionally (`:75`);
  - the FLSA Alert (`:175-186`, including uncompensated overtime and the exempt partial-day note); the Data source card (`:273`); a back link (`:127`); `Container lg`.
- **Server:** `getPayrollExportPreview` (`:49`) and `generatePayrollExportCSV` (`:88`, refuses an unknown format at `:96`), both `requireAdmin`.
- **`internal/payroll-data.ts:66` `loadPayrollData`:**
  - workweek start via `readWorkweekStartDay`;
  - entries in `[workweekStart(rangeStart), rangeEnd]`; a leave pay-type check;
  - **`if (userIds.length === 0) return …` before the people query (`:106`)**;
  - users with entries; periods with `existingPeriodLength` per row (N+1);
  - approvals from period rows only (`:126`);
  - `computeFlsa` (`lib/payroll/flsa.ts:81`; approved in-range days only; exempt overtime 0; `totalPaid` excludes unpaid, `:147`).

  Hours are already integer cents internally (`toCents`). **Period rows exist only after a submit** (`periods.ts:266`) or a migration. Gusto sync maps fields explicitly (`sync-engine.ts:153, 173, 304-308`).
- **Expected submitters:** `EXPECTED_SUBMITTER_ROLES` and `bucketOf` (no row + hours → in progress; `team-period-status.ts:12, 18-22, 52`).
- **Tests:** `payroll-export-client.test.tsx` (`:62-69` flagged above Download; `pick-range`; `.disabled` asserts); `payroll-export-actions.test.ts` (mocks `pay-period-config` with `existingPeriodLength` only; a per-table fake db; exact preview `:94` and CSV `:113`; guard first `:125`); `payroll-flsa.test.ts:56,71,162`.

### 1.3 Demo seed
- `scripts/seed-full.ts`: `clearTenantData` first (`:73`; it deletes `period_events` and notes under the trigger bypass).
- The latest completed period is `submitted` for all six people (`isPendingReview = periods.length - 2`, `:390`), with `submissionCount: 1` and `submittedAt = periodStart + numDays + 1d` (`:395`). That can be in the future when seeding on the 16th or the 1st.
- Base entries: rev 1 on every weekday per assigned code (`:432-451`; `nav02` always 2 h); `createdAt` defaults to `now()` (`schema.ts:317`); events use explicit dates (`:407-410`).
- Unique indexes:
  - `entries_user_code_date_rev_unique_idx` (`schema.ts:335-340`), one rev per cell;
  - `user_period_unique_idx` (`:398`);
  - notes need `revisionNumber` and `createdBy` (`:357-358`).
- Reason codes `CORRECTION` / `LATE_ENTRY` (`lib/reason-codes.ts:2-3`).

## 2. Invariants
- **DCAA:**
  - decisions run the existing conditional UPDATE under `lockUserRulesShared`;
  - **A10:** the decision's `periodId` and `seen` come from the same review object, and decisions are impossible while a review loads;
  - entries and events stay append-only;
  - payroll reports approved days only; the F10 warning is preserved (A11).
- **Security:** guards first; the `?review=` deep link re-checks scope through the read; ids validated after the guard; no internals in `'use server'` exports; client code imports **no** `server-only` module (A3).
- **Static tests** stay true or are updated as listed in §9:
  - `submissionCount` first;
  - the decision binding: `/periodId: reviewData\.periodId,\s*seen: reviewData\.submissionCount/` at least once, **no** `selectedPeriod.id` or `periodId: selectedPeriod` anywhere in the file, and the gate literal `reviewData.periodId ===` present. The old `if (!reviewData) return null;` assertion is dropped;
  - the approval line formatted only in `approval-label.ts`.
- **Read-only workspaces:** decision and download buttons stay `WriteButton`s (or equivalent read-only gating).
- **Kit rules:** no `disabled` / Mantine `loading` on focusable buttons; no `light-dark()` in `.css`; no `-filled` text.

## 3. Approvals

### 3.1 Server
1. **`src/lib/approvals/waiting-order.ts`** (pure): `compareWaiting(a, b)` on `{ periodStart, submittedAt, employeeName, periodId }`.
   - `approvalQueue` **drops its SQL ORDER BY** and sorts `mine` with `compareWaiting`.
   - Update `unit/approval-queue.test.ts:42-45` and the doc comments (`:15`, `:45`).
   - `getScopedPeriods` sorts its waiting rows with it.
2. **`periodFlags`:** keep `GROUP BY user_id, entry_date`. Inside each group:
   ```sql
   COUNT(DISTINCT COALESCE(charge_code_id, indirect_code_id, clin_id)) FILTER (WHERE source = 'app' AND revision_number > 1)               -- corrected cells (per day)
   COUNT(DISTINCT COALESCE(charge_code_id, indirect_code_id, clin_id)) FILTER (WHERE source = 'app' AND revision_number = 1 AND change_reason_code IS NOT NULL) -- late candidates
   SUM(CAST(hours AS NUMERIC)) FILTER (WHERE <LATEST_REVISION>)                                                                             -- hours
   ```
   **Use this single shape instead of the three expressions above** (one query; the same row count as today):
   ```sql
   SELECT user_id, entry_date,
          COUNT(*) FILTER (WHERE max_app_rev > 1)                AS corrections,
          COUNT(*) FILTER (WHERE late1 AND max_app_rev = 1)      AS late_entries,
          SUM(latest_hours::numeric)                             AS hours
   FROM (SELECT user_id, entry_date,
                MAX(revision_number) FILTER (WHERE source = 'app') AS max_app_rev,
                BOOL_OR(revision_number = 1 AND source = 'app' AND change_reason_code IS NOT NULL) AS late1,
                (ARRAY_AGG(hours ORDER BY revision_number DESC))[1] AS latest_hours
         FROM timesheet_entries WHERE <user/date ranges>
         GROUP BY user_id, entry_date, COALESCE(charge_code_id, indirect_code_id, clin_id)) c
   GROUP BY 1, 2
   ```
   - `source = 'app'` **leaves the WHERE** (`period-flags.ts:39`), so hours include imported rows, while the flags count app rows only.
   - Aggregate per period in JS. Hours use `.mapWith(Number)`.
   - Flags are computed for `canApprove` rows only, as today.

   `PeriodFlags = { corrections; lateEntries; resubmitted; hours }`. Update `integration/period-flags.test.ts`.
3. **`getScopedPeriods`** rows gain `hours` (Waiting only), `decidedByName` and `decidedAtText` (from §3.1.4).
4. **`approvalLabel`** adds, formatted in this file only:

   | `kind` | `uiText` | `uiBadge` |
   |---|---|---|
   | approved | "Approved by {name} on {MMM D, YYYY}" | — |
   | rejected | "Returned by {name} on {MMM D, YYYY}" | — |
   | self-approved | "Self-approved on {date}" | "Self-approved" |
   | self-rejected | "Self-returned on {date}" | "Self-returned" |
   | imported-approved | "Approved in {system} by {reviewer} on {imported date}" | — |
   | imported-rejected | "Returned in {system} by {reviewer} on {imported date}" | — |
   | none | null | — |

   It also adds `decidedAtText` (the date string the `uiText` uses; for imported decisions, the imported date, never the import time) and `decidedByName`.
   - **Imported kinds:** keep the existing fallbacks ("another system", "reviewer not recorded", "an unknown date"). The imported date is a raw metadata string: format it as `MMM D, YYYY` if it's a calendar date, otherwise show it as is.
   - An in-app decision with a null date leaves out " on …".
   - `decidedByName`: the decider's name; `nameOf(userId)` for self kinds; the metadata reviewer for imported ones.
   - `decidedAtText` null → "—" in the Decided column.
   - Existing fields are unchanged.
   - Widen the static scan to `Self-(approved|rejected|returned)` and require `uiText` strings to be formatted only here.
5. **Review read** (`getTimesheetForReview`), with **zero new queries**. Passing `numDays` through removes the two `periodLengthFor` reads, so the count **drops by 2**. Record the baseline count before changing anything, and assert `baseline − 2` as a literal. Query counting: the test's `getDb` mock wraps `getTestDb()` in a Proxy that counts `select`, `selectDistinct` and `execute` calls (none exists today; add it as a shared test helper, also used by P-1). Three callers share `getTimesheetEntriesForEmployee`: the review, `getTimesheetPeriod` and the public `getTimesheetEntries` (`timesheet.ts:54`).
   - read `periodId`, `numDays` and the period length from the first period select (keeping `submissionCount: timesheetPeriods.submissionCount` in that select, so both static order tests stay true);
   - pass `numDays` into `getTimesheetEntriesForEmployee` (signature `numDays?`, falling back to `periodLengthFor` for `getTimesheetPeriod`);
   - add `comment`, `createdAt` and `source` to its revisions select. Return the **revision chains separately** (`revisionsByCell`); the `TimesheetEntry[]` sent to the employee grid is unchanged;
   - call `loadApprovalLabelData` + `approvalLabel` directly for this period (instead of `approvalLabels`), adding `comment` to its events select, so `lastReturn` costs nothing;
   - return:
     ```ts
     periodId: string | null; numDays: number;   // null when no period row exists (`:499`); no decision card then
     submittedAt: string | null; submittedComment: string | null;
     flagged: FlaggedCell[];   // A4 rule with source = 'app', so the list counts match the Drawer's n. FlaggedCell = { rowId; dayIndex; kind: 'correction' | 'late'; originallyLate: boolean; sinceReturned: boolean; current: CellRevision; previousHours: number | null; history: CellRevision[] }
     lastReturn: { comment: string | null; byName: string | null; at: string } | null;  // latest 'rejected' event, when submissionCount > 1
     ```
6. **`decidePeriod`:** after the existing `seen` check (so the missing-seen error stays first), validate `typeof data.comment === 'string' || data.comment === undefined`, then trim it.
   - reject: an empty trimmed comment → `UserFacingError('Add a comment so the employee knows what to fix.')`;
   - both: > 1,000 → `UserFacingError('Comments can be at most 1,000 characters.')`.

   Store the trimmed value.
7. **Deep link** `?review=`: the page reads `searchParams: Promise<{ review?: string | string[] }>` (first of an array) and `validateUUID`s it (invalid → ignored), then passes `initialReviewId`.
   - The client opens it **once**, from a mount effect guarded by a ref (StrictMode-safe). setState happens only after the read resolves.
   - It then removes `review` from the URL with **`window.history.replaceState`** (Next keeps the router in sync, `linking-and-navigating.md:397-412`; `router.replace` would re-run the page on the server).
   - When the opened row isn't in the Waiting view, Previous / Next are hidden.
   - An id not in the rows → `toastError` "That timesheet isn't available to you."

### 3.2 List
- **Header:** `PageHeader` with h1 "Approvals", the description "Timesheets waiting for you come first, oldest pay period first.", and `notices` = `ApprovalNotices` (below the h1). For supervisors, the scope sentence is plain text.
- **Views:** a SegmentedControl "Waiting for you ({n})" / "Decided" / "Everything" (`fullWidth` below 40em).
- **Waiting** (`state.sorting = []`, keeping the `compareWaiting` order):

  | Column | Content |
  |---|---|
  | Employee | name |
  | Pay period | `periodLabel` |
  | Submitted | `MMM D` |
  | Hours | `numericColumn` |
  | Worth a look | flags, or nothing |
  | Action | Review: primary on the first row |

- **Decided:** Employee, Pay period, Status (`StatusBadge`), "Decided by" (name plus `uiBadge`), "Decided on" (`decidedAtText`), and View.
- **Everything:** Employee, Pay period, Status, Submitted, and View / Review.
- **Empty states:** Waiting "Nothing is waiting for you. New timesheets appear here when employees submit."; Decided "No decided timesheets yet."
- `useAppTable` with `hairline`, and `compact` when ≤ 25 rows.

### 3.3 Review Drawer
**Container:** `Drawer position="right" size="xl"` (`"100%"` below 48em), with `returnFocus={false}` (focus is managed in `onExitTransitionEnd`). The title is "{Employee} · {Pay period}", and the header line is "Submitted {MMM D} · {hours} hours · {StatusBadge}". In the Waiting view, the header also has "‹ Previous" / "Next ›" (aria-labels "Previous waiting timesheet" / "Next waiting timesheet"; aria-disabled at the ends) and "{i} of {n} waiting".

1. **`ReviewGrid`** (new, read-only, its own CSS module; the timesheet's visual language): full lines, weekday headers, weekend tint, blank empty cells, a name-then-code row header, daily and period totals.
   - Flagged cells: warn-soft background, a 2 px bottom line, and a top-right warning triangle. Note cells: a top-left accent triangle.
   - Screen-reader text: ", corrected" / ", late entry" / ", has a note".
   - A legend, and a caption "Hours for {employee}, {period}".
2. **Cards** (a row on wide screens, stacked below 64em):
   - **"Worth a look ({n})"**, where n = `flagged.length`:
     - for a resubmission, first "Returned {MMM D} by {name}: “{comment}”";
     - then each flagged cell, "**{Ddd MMM D} · {row}**: {previous} → {current}" (late: "{current}, entered {MMM D}"), with a sub-line "{reason label} · “{comment}” · changed {MMM D}", plus a "Since returned" tag and "originally entered late" where true;
     - the submit note, if any;
     - empty: "Nothing unusual in this timesheet."
   - **"Notes ({n})"** (today's logic).
   - **Decision card** (when `canApprove`):
     - one `Textarea` "Comment", described "Optional to approve. Required to return, so the employee knows what to fix.", max 1,000, with a non-live counter;
     - **`WriteButton`s** "Return for corrections" (outlined) and "Approve" (primary), spreading `busy.props('decision:return' | 'decision:approve', { group: 'decision' })`, with no `disabled` / `loading`;
     - self-review labels "Return (self)" / "Approve (self)", as today's self rules apply.
     - **Return with an empty comment:** no request; inline error on the Textarea; focus moves to it.
     - A checkbox "Open the next timesheet after I decide" (checked).
   - **Decided or read-only:** `uiText` instead of the card.
3. **Binding (A10):**
   - the decision sends `{ periodId: reviewData.periodId, seen: reviewData.submissionCount, comment }`;
   - **the card renders only when `reviewData && reviewData.periodId === current.id`**. While a read is in flight or after it fails, `reviewData` is `null`, and the card area shows `role="status"` "Loading…" or the read's error with Retry. There's nothing to click;
   - while a decision runs, Previous / Next and closing the Drawer are blocked: their handlers check `busy.any()` (`aria-disabled` alone doesn't block a click), and the Drawer's `onClose` ignores closing while busy;
   - a `getScopedPeriods` failure **after** a successful decision shows `toastError` "Decided, but the list couldn't refresh. Reload the page.", never as a decision error;
   - an approve comment that trims to empty is stored as null;
   - export the card as `DecisionCard` (it replaces `ReviewDecisionButtons`) so `workspace-mode.test.tsx` can render it.
4. **After a decision** (one error location: `runAction` silent plus an inline Alert in the decision card):
   1. snapshot the current Waiting ids (in `compareWaiting` order) **before** deciding;
   2. on success: `const rows = await getScopedPeriods(); setPeriods(rows);` then, from `rows`, open the first snapshot id after the current one that's still waiting, else the first waiting, else close (focus the list heading in `onExitTransitionEnd`);
   3. `router.refresh()` only for the sidebar count;
   4. unchecked "open next": close, and focus the Review button of the row now at the same index, else the heading.

   Toasts: "Timesheet approved" / "Timesheet returned", with "{employee} · {period}".
5. **Previous / Next** load the neighbour's review with a request token (a stale response is dropped before setState). The old grid stays visible, but the decision card shows "Loading…" (step 3).
6. **Copy:**
   - "Return for corrections" / "Returned" everywhere in the UI;
   - `NotificationsClient.tsx:85` "…returned for corrections";
   - `periods.ts` (≈ `:279`, the submit guard) "Only draft or returned timesheets can be submitted.";
   - `MigrationClient.tsx:461` "submitted, approved or returned periods".

   (`errorTitle` is ignored with `silent`; don't set it.)
7. **Removed:** the two textareas, `ReviewDecisionButtons` (folded into the decision card), raw status badges, and "Nothing unusual" as a list cell.

## 4. Payroll export

### 4.1 Server
1. **`loadPayrollData(db, range)`:**
   - `readWorkweekStartDay` selects `{ day, timezone }` in its existing query (no new query, no signature change for sync);
   - replace the per-row `existingPeriodLength` with one `loadScheduleResolver`;
   - **remove the `userIds.length === 0` early return**: people and periods are always read for the expected set;
   - **people query:** `id IN (entry userIds) OR (is_active AND role IN EXPECTED_SUBMITTER_ROLES)`, selecting `createdAt`. **`employees`, `days` and `exempt` use every entry user, exactly as today**: a deactivated exempt employee whose hours are all approved keeps their name and gets 0 overtime. Only `notIncluded` uses the expected set;
   - the timezone runs through `canonicalTimeZone` (as `workspace-settings.ts:20`);
   - **period length:** `periodNumDays ?? getNumDaysInPeriod(start, resolver.configOn(start))`, never the resolver's snapped period, so misaligned imported rows keep today's approved days.

   Queries: workweek + tz, entries, people, periods, schedule (5). The return adds `notIncluded` and keeps every existing field.
2. **Person-periods:**
   - for each expected person, stored period rows cover their own days first;
   - group the remaining in-range days by `resolver.periodContaining(day)`, and never list a resolver period overlapping a stored row;
   - **the createdAt rule applies only to person-periods with no stored row and 0 hours:** those are listed only when `calendarDayOf(createdAt, tz) <= periodEnd`. Anyone with a stored row or hours in the period is always listed (imported users created today keep their history).
   - **`partlyIncluded`:** the person has at least one approved in-range day in this file.
   - **`canReview`:** `status === 'submitted' && periodId !== null`.
   - Rows whose period is approved aren't listed.
   - `hoursInRange` = latest revision, in range, all kinds.
   - Status: the stored row's status; **no row and hours > 0 → `draft`**; no row and 0 hours → `none`.
   ```ts
   type NotIncluded = { userId; employeeName; periodId: string | null; periodStart; periodEnd;
     status: 'none' | 'draft' | 'submitted' | 'rejected'; hoursInRange: number; submittedAt: string | null; returnedAt: string | null;
     partlyIncluded: boolean; canReview: boolean };
   ```
   - Order: status (submitted, rejected, draft, none), then name, then period start.
   - Key: `userId|periodStart`.
3. **Preview** (`ready`):
   ```ts
   { status: 'ready'; workweekStartDay; reportedDays;
     employees: Array<PayrollPreviewEmployee & { userId: string; flsaExempt: boolean; paidLeave: number; otBasisIncludesUnapprovedDays: boolean }>;
     totals: { people: number; regular: number; overtime: number; paidLeave: number; totalPaid: number };   // integer-cent sums, then fromCents
     notIncluded: NotIncluded[] }
   ```
   `refused` is unchanged.
4. **Presets:** the page computes `{ last, current, previous }` on the server and passes them; the default is `last`.

### 4.2 UI
1. **Header:** `PageHeader`, h1 "Payroll export", description "Approved hours for a pay period, formatted for your payroll system, with weekly overtime worked out." No back link and no `Container lg`.
2. **Controls:**
   - "Pay period" uses the **kit's `PeriodPresetSelect`**: "Last pay period · {label}" (default), "This pay period · {label}", "{previous label}", and "Custom dates…" (the kit's two DateInputs, seeded from the current range). The preview runs only when the selection is complete.
   - "Format" is a Select whose value is remembered in `localStorage` `cp.payrollFormat`, read with the **`useSyncExternalStore`** pattern used in `ApprovalNotices.tsx:49+` (no setState in an effect) and **validated against the format options** (else the default).
   - The page stores the resolved start and end for every preset, so "Custom dates…" can be seeded from the current range (`PeriodPresetSelect.tsx:48` takes them as values).
   - **The initial preview for the default range is computed on the server** and passed in, so there's no mount effect; later range changes auto-preview on the client.
   - Buttons "Download CSV" (primary) and "Download daily detail" (outlined) are `WriteButton`s with `useBusy` props.
3. **Auto-preview:**
   - whenever the range changes, with a request token (a stale response is dropped **before** setState);
   - remove the "no approved data" toast (the empty states cover it);
   - **F4 enforced in the handler:** `download()` returns immediately unless `preview?.status === 'ready'` and the preview's `rangeKey` equals the current one;
   - while loading, the buttons are aria-disabled with "Loading preview…";
   - refused → a warn `Notice` with the existing message.
4. **F10 warning (A11):** when any employee has `otBasisIncludesUnapprovedDays`, a warn `Notice` (`data-testid="payroll-flagged"`) appears **above** the download buttons, titled "Overtime uses unapproved days", with the existing sentence and the names. A "Flagged" warn badge appears next to each such name in "In this file".
5. **Not in this file:** a warn `Notice`, "**{n} people aren't in this file.** Only approved timesheets are exported.", then a table:

   | Column | Content |
   |---|---|
   | Name | name |
   | Why | `StatusBadge` plus "— waiting for approval" (submitted) / "— returned {MMM D}, not resubmitted" (rejected) / "— not submitted" (draft) / "— not started" (none); plus "· partly included" |
   | Hours | `numericColumn` |
   | Action | "Review" when `canReview`, linking to `/admin/approvals?review={periodId}` |

6. **In this file:** Employee (plus a Flagged badge), FLSA, Regular, Overtime ("—" for exempt), Leave (paid), Total, and a footer "{n} people" with the totals.
7. **"How overtime is worked out"** is a collapsed Accordion item:

   > Overtime is hours worked over 40 in your workweek (starts {day}), for non-exempt employees only. Leave doesn't count toward the 40. Weeks that cross the pay-period edge use the days on both sides. Exempt employees' hours over 40 are listed as uncompensated overtime in the Custom and daily-detail files. Partial-day deductions for exempt employees aren't calculated; review those in your payroll system.

8. **Removed:** the Data source card, the always-open FLSA Alert, the format-repeat Alert, the back link and the unused CSS module.

## 5. Demo seed (A9)
In `scripts/seed-full.ts`, modify the existing `isPendingReview` iteration (the latest completed period, already `submitted`). **Never insert a second period row.**
- **`base` = `min(planned submittedAt, now − 1 h)`, applied to every pending period** (so no `submittedAt` is in the future when seeding on the 1st or 16th).
- Offsets: `t4 = base`, `t3 = base − 1 h`, `t2 = base − 2 h`, `t1 = base − 3 h`.
- **The base loop sets `createdAt` for non-current periods** to `min(entry day 17:00 workspace time, t1 − 1 h)`, so every revision 1 precedes the backdated events.

**Strict order:** rev 1 entries < late entry < first submit < return < correction after return < second submit.

1. **Jane (submitted once):**
   - two corrections: rev 2 rows on two existing cells (same `chargeCodeId` + `clinId` as rev 1), reason `CORRECTION`, with comments "Left early for a doctor's appointment." and "Forgot the afternoon site visit.", and explicit `createdAt` before `submittedAt`;
   - one late entry: rev 1 on a cell the base loop leaves empty (e.g. `OH-001` on a non-Friday weekday in the period, a day ≤ period end − 2), reason `LATE_ENTRY`, comment "Entered the next morning.", `createdAt` = `min(day + 1, base − 4 h)`;
   - one note (`revisionNumber: 1`, `createdBy`, `chargeCodeId`).
2. **Robert:**
   - **replace** (don't add to) the loop's `submitted` event for him with three events: `submitted` at t1 (actor Robert), `rejected` at t2 with comment "Please add Tuesday's site visit hours." (actor `reviewerFor(robert)`), and `submitted` at t4 (actor Robert);
   - a correction (rev 2, reason `CORRECTION`, comment "Added the Tuesday site visit.") at t3, between the return and the resubmit;
   - his period row gets `submission_count = 2`, `submitted_at = t4` and `review_comment = NULL` **in the loop's own insert** (no UPDATE needed; `timesheet_periods` has no trigger in any case).
3. **The others:** unchanged (submitted, nothing unusual).

**Idempotent:** `clearTenantData` runs first; re-running produces the same state.

## 6. State tables
**Decision** (server unchanged; UI added):

| Status | Event | Result | UI |
|---|---|---|---|
| submitted, review loaded | Approve | approved | toast; open next / close |
| submitted, review loaded | Return with a comment | rejected | toast; open next / close |
| submitted | Return with an empty comment | client: no request; server: validation | inline error, focus to the comment |
| any | review loading (Previous / Next / deep link) | — | decision card replaced by "Loading…"; nothing to click |
| submitted | stale `seen` | refused (existing) | inline Alert (existing copy) |
| approved / rejected | — | — | read-only `uiText` |

**Open next:** the snapshot S, the current id c, and the fresh `rows` from `getScopedPeriods()`.

| Condition | Opens |
|---|---|
| ∃ id ∈ S after c, waiting in `rows` | that id |
| else ∃ waiting in `rows` | the first waiting |
| else | close; focus the heading |

**Payroll person-period status:**

| Stored row | Hours in range | Status | Shown as |
|---|---|---|---|
| submitted | any | submitted | Submitted — waiting for approval |
| rejected | any | rejected | Returned — returned {date}, not resubmitted |
| draft | any | draft | Draft — not submitted |
| none | > 0 | draft | Draft — not submitted |
| none | 0 | none | Not started — not started |
| approved | any | (not listed) | — |

## 7. Failure modes
- **Review read fails:** an inline Alert with Retry.
- **Previous / Next race:** token-checked; decisions are blocked while loading (A10).
- **A decision fails:** an inline Alert; the comment is kept.
- **Deep link:** out of scope → toast; opened once; the param is removed.
- **Payroll:**
  - a preview fails: inline Alert, downloads blocked;
  - a range change mid-preview: the stale response is dropped;
  - a click during loading or a stale range: the handler refuses (F4);
  - an invalid stored format → the default;
  - zero entries → every expected person listed as not started.
- **Seed re-run:** identical state; no future timestamps.

## 8. Platform limits
- **Review read:** the same query count as before (recorded), or fewer.
- **`getScopedPeriods`:** unchanged count.
- **Payroll preview:** 5 queries, with no N+1.

## 9. Blast radius
| Area | Files |
|---|---|
| Server | `actions/periods.ts`, `internal/approval-queue.ts` (JS sort), new `lib/approvals/waiting-order.ts`, `internal/period-flags.ts`, `internal/approval-label.ts`, `actions/timesheet.ts` (review read; `getTimesheetEntriesForEmployee` `numDays` param and separate revision chains), `internal/payroll-data.ts`, `actions/payroll-export.ts` |
| UI | `admin/approvals/{page,ApprovalsClient}.tsx`, new `components/approvals/ReviewGrid.tsx` (+ CSS), `ReviewDecisionButtons.tsx` (removed / folded), `admin/payroll-export/{page,PayrollExportClient}.tsx`, `NotificationsClient.tsx`, `MigrationClient.tsx` |
| Seed | `scripts/seed-full.ts` |

**Tests to update:**
- `approval-queue` (`:42-45`, the order text → JS sort);
- `approvals-client`, `approvals-notes`;
- `workspace-mode` ("Return for corrections", still `WriteButton`; imports the exported `DecisionCard` instead of `ReviewDecisionButtons`, `:18, :34`);
- `approval-decisions`: the static binding test becomes "`periodId: reviewData.periodId` and `seen: reviewData.submissionCount` in the decision payload(s)" instead of "exactly twice"; the scan widened to "returned";
- `timesheet-read` (static order kept);
- `period-flags` (per cell, hours, late excluding corrected);
- `payroll-export-client`: the flagged Notice above Download; `pick-range` → kit presets; `.disabled` asserts → handler-refusal asserts;
- `payroll-export-actions`: the mock adds `loadScheduleResolver`; workweek+tz select; widened selects; new preview shape;
- `payroll-flsa`, `server-action-guards`, `icon-registry`, `seeder`, `seed-conformance`.

## 10. Test matrix
Each test must fail without its change.

| ID | Scenario |
|---|---|
| A-1 | `compareWaiting` (unit): period, then submission (null last), then name (case-insensitive), then id; `approvalQueue` returns rows in comparator order on a fixture where submission order ≠ period order |
| A-2 | `periodFlags` (integration): a cell with rev 2 **and** rev 3 counts 1 correction; a late cell later corrected counts as a correction, not late; a migration row isn't counted as a flag, **but its hours are included**; hours = the latest-revision sum (varchar cast) |
| A-3 | `rejectPeriod` with empty, whitespace or non-string → validation, with no status change and no event; > 1,000 refused for both; the trimmed comment is stored |
| A-4 | `getTimesheetForReview` (integration): `periodId` (null with no row), `numDays`; `flagged` with history; `originallyLate`; `lastReturn` only when `submissionCount > 1`; `sinceReturned`; **the query count equals the recorded baseline − 2** (counting Proxy); `getTimesheetPeriod` and `getTimesheetEntries` entries are unchanged (no revision chains) |
| A-5 | `approvalLabel`: `uiText` / `uiBadge` for all seven kinds; imported `decidedAtText` = the imported date; the old fields are unchanged; static scan widened |
| A-6 | List: Waiting columns plus Hours in comparator order (no client re-sort); empty flags render nothing; Decided columns; no "Rejected" text in the rendered UI for any kind |
| A-7 | Drawer: header and Previous/Next; ReviewGrid marks (classes plus sr text); totals; the Worth a look card incl. the return comment, "Since returned" and "originally entered late"; the Notes card |
| A-8 | **Binding:** start Next, then try to decide before the load resolves → no decision button exists; **Next's read fails → no decision button** (error with Retry); after load, Approve sends **the new** `periodId` with **its** `seen`; Previous/Next/close do nothing while a decision runs. Return with empty → no request, inline error, focus; buttons are `WriteButton`s with no `disabled` |
| A-9 | Open next: after approving, `getScopedPeriods` is called, then the next waiting id by `compareWaiting` opens (not the decided one); at the end the Drawer closes and focus goes to the heading; unchecked → focus on the row at the same index |
| A-10 | Deep link: opens once (StrictMode double mount → one read); the param is removed with `history.replaceState` (no `router.replace` call); an id not in the rows → toast; invalid → ignored; Previous/Next hidden for a non-Waiting row |
| A-11 | Static tests (updated) pass: `submissionCount` first; the binding regex; no `selectedPeriod.id`; the gate literal. (A regression guard: exempt from the revert check.) |
| A-12 | Read-only workspace: the decision buttons are aria-disabled `WriteButton`s with the reason ("Return for corrections" label) |
| P-1 | `loadPayrollData` (integration): 5 queries for 3 users (counting Proxy); **an inactive exempt user with only approved hours keeps their name and gets 0 overtime**; **a user created today with a stored submitted row in range is listed**; `notIncluded` covers submitted, returned, stored draft, **no row with 8 h → draft**, and no row with 0 h → none; a **mid-range hire** isn't listed for periods ending before their creation day; **zero entries in range** → every expected person listed, still 5 queries; partly included; approved not listed |
| P-2 | Totals: two different employees with 0.10 and 0.20 hours → totals exactly 0.30 (integer cents); `paidLeave` excludes unpaid; exempt overtime "—" |
| P-3 | UI: default last period; auto-preview on preset change; a stale preview response is dropped; the **flagged Notice precedes Download** in DOM order and disappears when the range changes; Not in this file with `?review=` links; footer totals; the stored format validated; the accordion collapsed |
| P-4 | **F4 in the handler:** click Download while loading, or after a range change before the new preview → `generatePayrollExportCSV` not called; downloads are `WriteButton`s with `useBusy` and no `disabled` |
| P-5 | **Gusto sync payload deep-equals** the pre-change payload for the same fixture. The fixture includes an expected user with no entries, an inactive exempt user with approved hours, and **a misaligned approved row with a null `periodNumDays`**. (A regression guard: exempt from the revert check.) |
| S-1 | Seed (integration / seeder): Jane's pending period has ≥ 2 corrected cells, 1 late cell and 1 note, with every `createdAt` < `submittedAt` ≤ now; Robert's has events submitted < rejected < submitted, `submissionCount` 2, `review_comment` null, and **exactly one flagged cell with `sinceReturned` true**; Jane has none; a second run gives the same counts |

## 11. Verification
- **Dev:** `npx tsc --noEmit && npm run lint && npm run test && npm run test:tz && npm run db:safety`.
- **Product owner:**
  1. Integration.
  2. The lead's break-it script.
  3. Build plus both checks.
  4. `npm run demo:local` twice.
- **Browser** (light and dark):
  1. **Approvals:**
     - Waiting shows hours, with flags only where there are changes;
     - Jane's grid marks corrected and late cells, and "Worth a look" lists each change with its reason and comment;
     - return with no comment → inline message;
     - return with a comment → the next timesheet opens;
     - Robert's shows the earlier return comment and a "Since returned" change;
     - press Next and quickly try to click Approve: there's no button until it loads;
     - as Sarah: only her people.
  2. **Payroll:**
     - opens on the last pay period: in the demo, everyone is submitted, so "Not in this file" lists all six and "In this file" is empty;
     - **choose the previous period** to check totals, exempt "—" and downloads;
     - a Review link opens that timesheet in Approvals;
     - if any overtime uses unapproved days, the warning sits above the buttons.

## 12. Hand-off rules and commit order
**Commit order:** one commit per line, each with its tests.
1. Server: `waiting-order`, flags, `approvalLabel` UI fields, `decidePeriod` validation, the review-read additions
2. Approvals list + deep link
3. Review Drawer (`ReviewGrid`, cards, binding, decision, open next, Previous/Next)
4. Copy sweep
5. Payroll server
6. Payroll UI
7. Demo seed

**Rules:**
- `BLUEPRINT-STANDARD.md` §3 (impact analysis first; stop and ask).
- **Record the review read's query count before changing it** (for A-4).
- Every §10 test must fail without its change: revert-check and report.
- Don't push. Don't edit Terms or Privacy. The seed touches only the local demo tenants it already seeds.
- Report: commits, gates, revert checks, anything not run, and gap decisions.

## 13. Pre-mortem record
**Round 1:** 2 HIGH, 10 MEDIUM, ~16 LOW, all applied in v2.

| Finding | Fix in v2 |
|---|---|
| **H:** Previous/Next could approve an unseen timesheet | A10 binding; decisions blocked while loading |
| **H:** the F10 unapproved-days warning was dropped | A11 kept above the buttons |
| **M:** open next used stale rows | refetch with `getScopedPeriods` |
| **M:** the comparator lived in a server-only module; collation mismatch | pure module, JS sort |
| **M:** read-only gate dropped | `WriteButton`s kept |
| **M:** `uiText` covered only 2 of 7 kinds | all 7 |
| **M:** "Not started" for people with hours | no row + hours → draft |
| **M:** timezone source and per-period hire date | tz folded into the workweek select; per-period created check |
| **M:** early return hid everyone | removed |
| **M:** F4 bypass via `useBusy` | handler re-check |
| **M:** seed collisions | modify the existing period; empty cell for the late entry; same codes for revisions |
| **M:** seed timestamps | explicit, ordered, past |

The LOWs:
- the varchar hours cast;
- late-after-correction semantics;
- `numDays` pass-through and separate revision chains;
- direct `loadApprovalLabelData`;
- comment type check and trim;
- deep link open-once;
- dead `errorTitle`;
- Decided empty copy;
- Waiting sort `[]`;
- focus via `onExitTransitionEnd`;
- ghost rows across schedule changes;
- kit custom dates;
- the stale-preview token;
- removing the no-data toast;
- format validation;
- the two accordion facts;
- non-vacuous Gusto and cents tests;
- the demo default view note.

**Round 2:** 1 HIGH, 6 MEDIUM, about 14 LOW, all applied in v3:

| Finding | Fix in v3 |
|---|---|
| **H:** the people query dropped names and exempt status of fully approved users | every entry user is still read; only `notIncluded` uses the expected set |
| **M:** A10 failure path | card gated on `reviewData.periodId === current.id`; a failed read nulls `reviewData` |
| **M:** static test contradictions | regex binding; no `selectedPeriod.id`; the gate literal; dropped `return null` |
| **M:** hire-date rule hid imported users | applies only with no row and 0 hours |
| **M:** period-length drift | snapshot or `getNumDaysInPeriod` with the config on that day |
| **M:** seed base timestamps | the base loop backdates; concrete offsets |
| **M:** Robert's duplicate events and actors | replaced; correct actors; set in the insert |

The LOWs:
- the single flags SQL shape, with `source` out of the WHERE;
- review count baseline − 2, with a counting Proxy;
- `periodId` nullable; the three callers;
- imported label fallbacks and the `decidedAtText` format;
- `busy.any()` handler checks;
- refresh-failure copy;
- an empty approve comment stored as null;
- exported `DecisionCard`;
- the deep link via mount effect plus `history.replaceState`, with Previous/Next hidden off-Waiting;
- `partlyIncluded` / `canReview` defined;
- canonical tz;
- `useSyncExternalStore` for the format;
- server initial preview;
- preset seeding;
- `base` for every pending period;
- regression guards exempt from the revert check.
