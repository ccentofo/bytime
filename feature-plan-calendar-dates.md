# Blueprint: Calendar Dates & Timezones — One Date Model, Everywhere

> **Role for the executing developer: Senior full-stack engineer.** Branch: `calendar-dates` off
> `main`. Read `AGENTS.md`; this is Next.js 16 / Auth.js v5 beta / Drizzle 0.45 / Mantine 9 — confirm
> APIs in `node_modules` before relying on them. This touches the timekeeping core: work in the phase
> order below, keep the suite green after every phase, and do not change business rules (append-only
> revisions, reason codes, period lock, charge-code denormalization, scope) beyond what is specified.

## 0. Why this exists (verified — don't re-investigate)

A pay-period day like "Nov 1" is a **calendar date**, but the app stores it as a `timestamp with time
zone` and computes "midnight" in **two different timezones**: the server's (UTC on Vercel) and the
browser's (e.g. America/New_York). The same day therefore exists as `2026-11-01T00:00Z` and
`2026-11-01T04:00Z`, and the code compares them by exact instant. Locally the server and browser share
a timezone, so **none of this shows up in development; it breaks in production for every US user**:

1. **Off-by-one grid.** `timesheet/page.tsx:24` and `getNeighborPeriod` produce UTC-midnight period
   starts; a US browser renders them as the previous evening: header "Oct 31 – Nov 15", **16 columns
   for a 15-day period**, wrong weekday shading, wrong late/future flags; saving the last column fails
   "Invalid day index".
2. **Broken revision chains / double-counted hours (DCAA).** `saveTimesheetBatch` finds the prior
   revision with `eq(timesheetEntries.entryDate, entryDate)` (`timesheet.ts:222-225, 252-255`). A day
   saved under the other convention gets a second "revision 1": the edit skips the reason-code rule,
   optimistic concurrency is bypassed, and every report/export/API/QBO/payroll query that picks
   "latest revision per `entry_date`" counts the day **twice**.
3. **Read path shifts columns.** `getTimesheetEntriesForEmployee` maps rows with a floored
   `dayjs(row.entryDate).diff(start,'day')` and picks "latest" by `entryDate` order, not revision.
4. **Biweekly unusable from the picker.** The anchor is stored at UTC midnight; diffed in a US browser
   it yields **Sunday** starts, which the server's `resolvePeriod` rejects.
5. **"Today" disagrees.** Server "today" is UTC; browser "today" is local. After ~8pm Eastern, entering
   today's hours is "late" on the server but not the client → save fails asking for a reason code.
   Future-date blocking is a day loose.
6. **Period length ignores the pay schedule** in 13 places (semimonthly default assumed): the timesheet
   reader, approvals view, PDF, approve/reject emails, dashboard, deadline cron (all tenants!),
   sync-engine (QBO/Gusto/payroll), reports dropdown, the selector's history.
7. **Exact-instant matches** miss same-day rows: dashboard period status, deadline cron (reminds people
   who already submitted); `user_period_unique_idx` doesn't prevent same-day duplicate periods.
8. **Legal record ambiguity.** PDF "Digitally signed" times and email timestamps are UTC wall-clock
   with no zone label; the audit trail shows entry dates a day early in US browsers.
9. **Overlapping periods** at a pay-schedule change: the first period of the new schedule may start
   before `effective_from`, so a few days belong to two periods.
10. **Reminder emails fire up to 3×**: `vercel.json` crons **and** `.github/workflows/cron.yml` (which
    itself hits both endpoints on both schedules) call the same endpoints.

The round-2 `calendarDay()` rounding in `src/server/internal/periods.ts` keeps the **lock** safe; this
blueprint fixes the model so that rounding is no longer needed.

## 1. The model (LOCKED)

| Concept | Representation | Rule |
|---|---|---|
| Calendar date (entry day, period start, anchor, effective-from, contract/LCAT dates, sync range) | `CalendarDate` = `'YYYY-MM-DD'` string, end to end: DB column `date` (Drizzle `date(..., { mode: 'string' })`), server actions, RSC props, URLs, API | **Never** converted to a JS `Date` or an instant. All arithmetic on it is timezone-free. |
| Instant (created_at, submitted_at, reviewed_at, attempted_at, …) | `timestamptz` / `Date` | Unchanged. Displayed in the **workspace timezone** with a zone label where it's a record (PDF, emails, audit). |
| "Today" | `todayIn(workspaceTimezone)` → `CalendarDate` | Computed on the **server** from the workspace's IANA timezone (never the browser's — a user could spoof it to dodge the late-entry rule). The client receives it from the server. |
| Workspace timezone | IANA name (e.g. `America/New_York`) in a tenant-DB `workspace_settings` row | Set at signup from the creator's browser, editable by admins in Settings. |

Do **not** use Drizzle `mode: 'date'` (it maps to a JS `Date` and brings the bug back).

## 2. Preconditions (check first; STOP if any fails)

- **No production tenants exist yet.** This blueprint changes column types in one migration (§D2),
  which is only acceptable before real customer data exists. Confirm with the product owner; if a
  production control plane has any tenant, **stop and report**: the migration must then be redesigned
  as expand/backfill/contract.
- `main` is green (unit, integration, `db:safety`, Turbopack `npm run build`).

## 3. Phases

### D1 — `CalendarDate` core (pure, fully unit-tested)
Create `src/lib/calendar-date.ts` (plain module; **not** `'use server'` — the guard test bans
re-exporting types from action files). Use dayjs's bundled `utc` and `timezone` plugins (no new
dependency). API (all inputs/outputs `CalendarDate` unless noted):
- `type CalendarDate = string & { readonly __brand: 'CalendarDate' }`, `isCalendarDate(s)`,
  `parseCalendarDate(s)` (validates `YYYY-MM-DD` and a real date; throws otherwise — use at every
  trust boundary: server actions, route params, API query strings).
- `addDays`, `diffDays(a, b)` (exact integer), `dayOfWeek` (0–6), `dayOfMonth`, `daysInMonth`,
  `startOfMonth`, `withDayOfMonth`, `addMonths`, `compare`, `isBefore`/`isAfter`, `max`/`min`.
  Implement on `dayjs.utc(s)` internally so results never depend on the process timezone.
- `todayIn(timeZone: string): CalendarDate` and `isValidTimeZone(tz)`.
- `formatCalendarDate(d, pattern)` (e.g. `'MMM D'`, `'M/D'`) — formats via UTC, never via local `Date`.
- `formatInstant(date: Date, timeZone, pattern)` → includes the zone abbreviation (e.g. `Oct 21, 2026
  4:05 PM EDT`).

Rewrite `src/lib/date-utils.ts` period math on `CalendarDate` (same names where sensible, new
signatures): `getNumDaysInPeriod(start, config)`, `getPeriodStartForDate(day, config)`,
`navigatePeriod(start, dir, config)`, `getPeriodEndDate`, `getLastWeekdayInPeriod`,
`getCurrentPeriodStart(today, config)` (takes `today` explicitly — no hidden clock). **Make `config`
required** (no semimonthly default), so every caller must pass the effective config — that's what
surfaces the 13 places in §0.6 at compile time. `PeriodConfig.anchorDate` becomes `CalendarDate`.
Biweekly: period number = `floor(diffDays(day, anchor) / 14)` on dates — fixes the Sunday bug.

**Tests** (`src/__tests__/unit/calendar-date.test.ts`, rewrite `date-utils.test.ts`): every function,
month/year boundaries, leap day, DST-change weeks, biweekly anchors before/after the date. Keep the
existing DCAA snapshot/config-semantics tests (rewritten to strings). Remove the deliberately loose
biweekly assertions; assert exact dates.

### D2 — Tenant migration `0011` (one migration, explicit safety allowances)
Generate with `npm run db:generate`, then hand-edit the SQL so it does, in order, inside the
migration:
1. **Duplicate-period guard**: a `DO $$ … $$` block that **raises** (with the offending user ids and
   days) if two `timesheet_periods` rows for the same user map to the same calendar day under
   `((period_start AT TIME ZONE 'UTC') + interval '12 hours')::date`. Fail closed; don't guess a merge.
   (Local demo DBs can be re-seeded if this fires.)
2. **Revision renumbering** for entries that collide after conversion: for each cell
   `(user_id, coalesce(charge_code_id, indirect_code_id, clin_id), converted day)`, renumber
   `revision_number` by `(created_at, revision_number, id)` with a window function. All rows are kept;
   only numbering is repaired. Comment it as a one-time data repair.
3. **Type changes** with `USING ((col AT TIME ZONE 'UTC') + interval '12 hours')::date` (the same
   rounding as `calendarDay()`; correct for every stored convention) for:
   `timesheet_entries.entry_date`, `timesheet_periods.period_start`, `pay_period_config.anchor_date`,
   `pay_period_config.effective_from`, `contracts.start_date/end_date`,
   `user_labor_categories.effective_date/end_date`, `integration_sync_logs.period_start/period_end`.
   Put `-- migration-safety: allow pre-launch type change to calendar date; no production tenants
   (feature-plan-calendar-dates.md §2)` in each chunk so `db:safety` passes with a recorded reason.
   Keep the `1900-01-01` `effective_from` sentinel working.
4. **Uniqueness that the model now makes possible**:
   - `timesheet_periods`: the existing `(user_id, period_start)` unique index now means one row per
     user per day (it's a `date`). Verify it survives the type change; recreate if needed.
   - `timesheet_entries`: unique index on `(user_id, coalesce(charge_code_id, indirect_code_id,
     clin_id), entry_date, revision_number)`. This also closes the race where two concurrent saves
     both compute the same next revision (one now fails and the action retries once or reports a
     conflict). Keep the three existing performance indexes (schema says DO NOT REMOVE).
5. **`workspace_settings`**: single-row table (`id smallint primary key default 1 check (id = 1)`,
   `timezone text not null default 'America/New_York'`, `updated_at`), inserted by the migration.

Update `src/db/schema.ts` accordingly (`date(..., { mode: 'string' })`). Write a migration test
(integration) that seeds a DB with all three historical conventions (00:00Z, 04:00Z, post-DST 05:00Z)
and a same-day duplicate entry chain, runs the migration, and asserts the converted days, the
renumbered revisions (no row lost), and that a same-day duplicate **period** makes it fail.

### D3 — Server on `CalendarDate`
- Every server action, internal helper, route handler and cron that takes or returns a calendar date
  uses `CalendarDate` and calls `parseCalendarDate` on input. Includes (not exhaustive):
  `timesheet.ts` (`getTimesheetEntries`, `getRevisionMap`, `saveTimesheetBatch`,
  `getTimesheetForReview`), `periods.ts` (`getPeriodStatus`, `submitPeriod`, scoped period lists),
  `pay-period-config.ts` (`getEffectiveConfigAt`, `getNeighborPeriod`, `updatePayPeriodConfig`),
  `reports.ts`, `internal/reports.ts`, `audit.ts`, `dashboard.ts`, `employee-dashboard.ts`,
  `payroll-export.ts`, `qbo.ts`, `gusto.ts`, `migration.ts`, `src/lib/integrations/sync-engine.ts`,
  `src/app/api/reports/*`, `src/app/api/v1/*`, `src/app/api/cron/*`.
- `src/server/internal/periods.ts`: `calendarDay()`/`calendarDayWindow()` are no longer needed —
  replace with plain date equality/ranges and delete them. `assertEntryDatesEditable` and
  `resolvePeriod` operate on `CalendarDate`. Keep the lock semantics identical.
- **Period length**: everywhere uses `resolvePeriod(day)` (server) or the period row's
  `period_num_days` snapshot — never a default config. Fix all 13 sites in §0.6 (the D1 required
  `config` parameter will flag them).
- **"Today"**: `getWorkspaceToday()` (server-only helper: reads `workspace_settings.timezone`, cached
  per request) replaces every `dayjs()` / `new Date()` used as a calendar day: future-date block,
  late-entry rule, submit-before-last-weekday, landing period, dashboard, pending-config check, crons.
- Revision lookup and "latest revision" subqueries now compare `date = date`; the duplicates in §0.2
  cannot recur.

### D4 — Wire contract and client
- RSC props and action results carry `CalendarDate` strings (`TimesheetPageData.periodStart`, entry
  rows, period lists, approvals rows incl. `periodNumDays`).
- **Client does no clock-or-schedule math of its own.** Add a server action
  `getPeriodOptions(aroundDay, before, after)` → `[{ start, numDays, label }]` resolved per the
  effective config of each period (fixes the selector's history across schedule changes and the
  hard-coded semimonthly reports dropdown). `TimesheetContext`, `PayPeriodSelector`, `BiWeeklyTable`,
  `TimesheetToolbar`, `HourCell`, `ColumnHeaderDate`, `ReportsClient`, `ApprovalsClient` use server-
  provided `start`/`numDays`/`today`. Day `i` of a period = `addDays(start, i)`, labelled with
  `formatCalendarDate`.
- The page receives `today` and the workspace timezone from the server; refresh `today` on focus /
  every few minutes (re-ask the server) so a tab left open overnight rolls over.
- Late/future flags in the client use the server's `today` (the server remains authoritative).
- Mantine `DatePickerInput` values are already `'YYYY-MM-DD'` strings in v9 — pass them through as
  `CalendarDate` (Settings anchor, LCAT dates, report/audit filters, contract dates, payroll/QBO/
  Gusto ranges). Remove every `new Date('YYYY-MM-DD')` and `toISOString().split('T')[0]`.
- Offline store (`src/lib/offline/*`, dormant): switch its keys/maths to `CalendarDate` so it can't
  reintroduce the old model; keep it dormant.

### D5 — Display of instants (records must be unambiguous)
- Timesheet PDF: day headers from `CalendarDate`; "Digitally signed", "Approved", "Generated"
  timestamps via `formatInstant(…, workspaceTimezone)` with zone label.
- Emails (submitted/approved/rejected/reminders/deadline): same.
- Audit trail and approvals: entry days via `formatCalendarDate`; `created_at` instants via
  `formatInstant` in the workspace timezone.
- `src/lib/format.ts`: route `formatDate`/`formatShortDate` to `CalendarDate` formatting and
  `formatDateTime` to `formatInstant`; remove the timezone-dependent versions.

### D6 — Reports, exports, integrations, public API
- Cost CSV/XLSX, payroll export, QBO `TxnDate`, Gusto: use the `CalendarDate` directly (no
  formatting through `Date`).
- `src/lib/integrations/sync-engine.ts`: period bounds from `period_num_days` / `resolvePeriod`, not
  hard-coded semimonthly; date-range filters inclusive on `date` columns (fixes the "+1 day pulls in
  next month's day 1" bug).
- **Public API v1**: `entryDate`, `periodStart`, and date query params become `'YYYY-MM-DD'`. There
  are no external API consumers yet; document the format in the API docs/README and in the response
  shape tests.

### D7 — Crons
- `daily-reminder` and `submission-deadline`: per tenant, use that tenant's timezone for "today" and
  its effective pay-period config (not the default); period lookups by date equality.
- **Delete `.github/workflows/cron.yml`** — Vercel Cron (`vercel.json`) is the scheduler of record
  (PRODUCTION-DEPLOY.md 13.5), and the workflow both duplicates it and double-fires within itself.
  Remove its `APP_CRON_BASE_URL` mention from docs if any.
- Keep the 20:00 UTC schedule (product owner may later want reminders at a local hour per tenant;
  out of scope).

### D8 — Settings: timezone and safe pay-schedule changes
- Settings page: "Workspace timezone" select (IANA list via `Intl.supportedValuesOf('timeZone')`),
  admin-only write (`requireAdminFresh`), validated with `isValidTimeZone`.
- Signup: capture the creator's browser timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`)
  on the signup form → `signups.timezone` (control-plane, additive nullable column) → written into
  `workspace_settings` at provisioning (validated; fall back to the column default).
- **No overlapping periods (§0.9)**: `updatePayPeriodConfig` accepts the change only if
  `effective_from` is a period boundary of **both** the old and the new schedule (for weekly/biweekly
  that means the anchor aligns; for semimonthly/monthly, the 1st/16th). The server offers the next
  valid common boundaries (`getValidScheduleChangeDates(newConfig)`), and the UI shows them as the
  choices. Also validate that a weekly/biweekly anchor falls on `weekStartDay`.
  Then remove `resolvePeriod`'s "upcoming config" special case and update the test that encoded the
  overlap (`period-lock-integrity.test.ts`, "first period of a new pay schedule").

### D9 — Tests that can't be fooled by the dev machine's timezone
- Add `npm run test:tz`: runs the unit suite three times with `TZ=UTC`, `TZ=America/Los_Angeles`, and
  `TZ=Pacific/Auckland` (UTC+13, the worst case for off-by-one). CI runs `test:tz` and runs the
  integration suite with `TZ=America/New_York` (CI's default is UTC; dev is usually US local).
- Integration tests that build dates with `dayjs('…').toDate()` / `new Date('…')` move to
  `CalendarDate` strings.
- New integration tests:
  - Save a cell, edit it → revision 2 with reason required (same day regardless of process TZ).
  - Grid length equals the period's `numDays` for weekly, biweekly, semimonthly, monthly.
  - Biweekly: `getPeriodOptions` and save/submit work for the current period.
  - After 8pm in the workspace timezone (inject the clock), entering today's hours needs no reason.
  - Future date (tomorrow in workspace TZ) rejected; today accepted.
  - Report totals don't double-count after edits.
  - Schedule change: non-common-boundary `effective_from` rejected; valid one accepted; no day
    belongs to two periods.
  - PDF/email timestamp strings include the zone abbreviation.

## 4. Guardrails
- Business rules unchanged: append-only revisions, reason codes for late entries and edits, the
  period lock (submitted/approved immutable; draft/rejected editable), charge-code denormalization,
  `user_assignments` sync, supervisor scope, admin self-approval.
- Security unchanged: every action still guarded before any query; `parseCalendarDate` on every
  untrusted date input; the guard-coverage test stays green.
- No JS `Date` for calendar dates anywhere in `src/` after this lands — add a lint-style unit test that
  greps for `new Date('` with a date-only literal and `toISOString().split('T')[0]` in `src/` and
  fails if found (allowlist with justification only).
- `npm run db:safety` passes (with the recorded allowances); Turbopack `npm run build` passes locally.

## 5. Verification
```bash
npx tsc --noEmit && npm run lint && npm run test && npm run test:tz
TZ=America/New_York npm run test:integration   # TEST_DATABASE_URL(_2), CONTROL_PLANE_DATABASE_URL set
npm run db:safety
npm run build
```
Manual (the bug only shows when server and browser timezones differ — reproduce that):
- Run the dev server with `TZ=UTC npm run dev` and use a browser on US time (your Mac). Before this
  change you'd see 16 columns for Nov 1–15; after, 15, with correct weekdays.
- Switch the browser/OS timezone to Pacific/Auckland and reload: same dates, same grid.
- Biweekly tenant: Current / dropdown / arrows all land on valid periods; save and submit work.
- Enter today's hours at 9pm workspace time (or with an injected clock): no reason prompt.
- PDF and approval email show times like "4:05 PM EDT".

## 6. Report back
Files changed; migration SQL (paste it); for each item in §0, the test that proves it fixed;
tsc/lint/unit/`test:tz`/integration/build output; anything you stopped on or deviated from.

## 7. Out of scope
- Per-user timezone overrides (workspace timezone only for now).
- Reminder emails at a local hour per tenant (schedule stays 20:00 UTC).
- Terms-compliance features (`feature-plan-terms-compliance.md`).
