# Launch hardening follow-ups

> **Status:** **FINAL v3.2**, 2026-11-11, lead architect.
> - **Product owner accepted every §2 recommendation (Q1–Q9) on 2026-11-11.** Where §4–§8 offer an alternative ("if the product owner chooses…"), the recommended path is the one to build.
> - **Pre-mortem:** round 1 (1 HIGH, 6 MEDIUM), round 2 (7 MEDIUM) and a confirmation pass (1 MEDIUM). All fixed.
> - **Q9:** no CI test names were given, so H3 works from the measured causes in §6.
> - **v3.2 (2026-11-11):** H6 added (product owner accepted audit item R1). Pre-mortem by one fresh reviewer: 1 HIGH (a same-row reconnect during a refresh would be overwritten → compare-and-swap on the refresh token), 1 MEDIUM (a test seam: stub `fetch`), 3 LOW. Confirmation pass: the concurrency core is sound; 1 MEDIUM (the fast path also checks provider and active), 3 LOW. All fixed.
>
> **Branch:** `launch-hardening`, from the latest `main` **after Part 2b (`ux-integrations-landing`) merges**. H5 edits Part 2b's Integrations files; line numbers marked "2b" are from the Part 2b working tree and must be re-checked after it merges.
>
> **Source:** `LAUNCH-TRACKER.md`:
> - the "Launch hardening follow-ups" list (approved for direct lead ↔ dev work, product owner 2026-11-12);
> - the 2026-11-11 decision that employees can't opt out of daily reminders.
>
> **Standard:** `BLUEPRINT-STANDARD.md`. Each item is independent; one commit per item.

## 1. Items and verdicts (each re-checked against current code, 2026-11-11)

| # | Tracker item | Verdict | In this blueprint |
|---|---|---|---|
| H1 | Daily reminders: employees can't opt out | **Open.** The switch exists and the cron honours it. | Fix (§4) |
| H2 | Employee-side "Self-rejected" badge uses old wording | **Open.** Two employee screens read the old field. | Fix (§5) |
| H3 | Slow-CI flaky screen tests | **Open.** | Fix (§6) |
| H4 | "Late" day badge shows for days before a person was created | **Fixed as written.** UX-3 removed the "Late" badge. The grid's "no hours" mark skips days before `userCreatedOn` (`TimesheetGrid.tsx:162`). **The same flaw survives in the workday counts and the submit warnings** (§7). | Per Q4 |
| H5 | Connect routes can be started from another site | **Open** (low severity). | Fix (§8) |
| H6 | **QuickBooks token refresh races across requests** (`UX-4C2B-AUDIT.md` R1; added by the product owner 2026-11-11) | **Open.** | Fix (§8b) |
| V1 | Past-hours import skipping the period lock | **Closed.** Two independent checks agree. | Nothing to do |
| V2 | UX-4 database index note (C5) | **A watch item, not a defect.** `feature-plan-ux-page-fixes.md:409` chose no index for the C5 `exists` subquery. For a charge code with no hours, that subquery can scan every entry, because every `timesheet_entries` index leads with `user_id`. Demo-sized data loads fine. | Q5 |
| — | Clean-up migration for supervisors' unbacked membership rows | **Deferred by the tracker** until approval scope has been live once. | Not in scope |

**V1 evidence:**
- **Lock order:** the entry import takes the import-window lock exclusively, then the sorted per-employee locks (`src/server/actions/migration.ts:110`, `:124`). Submit takes the window lock shared, then the same employee lock (`periods.ts:240-241`), so the two serialize.
- **Refusal:** locked periods are read under those locks (`migration.ts:140-154`), and `planEntryImport` refuses any row inside one (`src/lib/migration/import-plan.ts:149-152`).
- **Status imports:** they write `periodNumDays`, so later entry imports into those periods are refused.
- **Tests:** `unit/migration-import-plan.test.ts:41`, `integration/migration-import.test.ts:256`.

## 2. Questions for the product owner: **all recommendations accepted (product owner, 2026-11-11)**

| # | Question | Recommendation |
|---|---|---|
| Q1 | Both reminders only ever go to people with the `employee` role (`daily-reminder/route.ts:73`, `submission-deadline/route.ts:84`), yet supervisors and admins see both reminder switches, which do nothing for them. | **Daily switch:** remove it for everyone (your decision for employees, a dead control for the rest). **Deadline switch:** keep it for employees, hide it for supervisors and admins. Sending reminders to supervisors who log time would be new scope, so it's not proposed. |
| Q2 | What employees see instead of the daily switch. (Only demo data has it switched off today; there's no production data.) Also, the tenant data export's description of the now-unused column. | One plain line under "Reminder Notifications": **"Daily time entry reminders are always on. You'll get one on weekdays when you haven't entered time."** The export description becomes "Not used: daily reminders always go to employees (since 2026-11)." |
| Q3 | The daily reminder email ends "You can disable these reminders in your notification settings." | **Remove that sentence** from the daily reminder. The deadline reminder can still be switched off, so its sentence stays. |
| Q4 | **The H4 sibling.** Days before a person's account existed still count as missing in two kinds of places. **(a) The progress line** "X of Y workdays so far are filled in", on the timesheet and on Home (Home is supervisors and admins only). A mid-period hire sees "0 of 8" on day one. **(b) The submit warnings** ("N workdays with no hours recorded…", "Total period hours … seem low for N workdays"). These are **appended to the submission comment and kept in the audit trail** (`SubmitModal.tsx:34-38`, `:79`). An account's creation date is the day it was added to CadenzPoint, not a hire date. So when a company goes live mid-period, the earlier days in that first period are real workdays: today they're flagged at submit, and with this change they wouldn't be. | **Fix (a) only.** The progress line counts from the account's creation day, and when nothing is expected yet it shows hours and the due date without the "X of Y" clause. **Leave (b) unchanged:** the certified record keeps flagging every empty workday in the period, which is the conservative choice for DCAA. Home's per-day bars keep drawing days before creation as empty bars (they show hours, not a "missing" mark). |
| Q5 | V2 (C5 index note). | **Close it as a recorded watch item** (Deferred list: "Charge codes / Assignments: add an index on `timesheet_entries(charge_code_id)` if either page is slow with real data"). |
| Q6 | **For the business session, not engineering:** two pieces of text say users can turn off reminder emails, which contradicts the 2026-11-11 decision. **(1)** The draft `business/legal/privacy-policy.md` (lines 74 and 163). **(2)** The live Privacy page, `src/app/privacy/page.tsx:34`: "Send email notifications (configurable in your preferences)". Part 2b's text doesn't change that line. | Forward both to the business session to reword. Engineering applies the new line when it arrives. |
| Q7 | **Gusto.** After Part 2b there's no Gusto Connect in the product (decision I10: "Gusto is honest"). Today's `gusto-connect` route can still be opened directly. | **QuickBooks only:** delete `gusto-connect` and don't replace it. Existing Gusto connections and the `complete` route's Gusto branch are untouched. |
| Q8 | **Reminder capacity** (found in review; it exists today, H1 only enlarges it). The reminder cron sends at most 2 emails a second (Resend's 10/s team limit, shared by three crons) and stops at 240 s. So one daily run reaches about **480 people across all workspaces**. Anyone past that is skipped for the day; the next day resumes from there. The Resend plan's daily quota is a separate limit (a business item: the Resend account). | **Add a small follow-up blueprint to the queue:** use Resend's batch send (`resend.batch.send`, up to 100 emails per call, present in the installed `resend` 6.12.4, `dist/index.d.mts:1502-1506`) for the three cron senders. Not in this blueprint. |
| Q9 | Do you remember which tests failed in CI? (I can't read the CI history from here.) | Optional. Without names, H3 works from measured causes (§6). |

## 3. Invariants that must not break
- **DCAA:** append-only revisions, reason codes, period lock, charge-code denormalization. Nothing here writes timesheet entries.
  - With Q4 as recommended, the submission comment's warnings are unchanged.
  - If you choose to fix (b) too, the warnings recorded at submit change for days before an account's creation; that's the trade-off Q4 describes.
- **Certified outputs keep "Rejected":** the PDF, reports, v1 API and data export read `approvalLabel().text` / `.badge` and stay as they are. Only the in-app employee screens change (A1 in `feature-plan-ux-approvals-payroll.md`: display only).
- **Security:**
  - every server action calls a session guard before any work (`unit/server-action-guards.test.ts`);
  - identity comes from the session;
  - the OAuth state stays signed and single-use, with an httpOnly nonce cookie scoped to the host (R2-9).
- **Tenancy:** the cron runs per tenant, in each tenant's own time zone (D7).
- **Calendar dates:** day logic uses `CalendarDate` and the workspace's `today`, never the browser clock.
- **No schema migration.**

## 4. H1: daily reminders can't be switched off

### 4.1 Current state (verified)
- **Cron** `src/app/api/cron/daily-reminder/route.ts:93-110`: for each active `employee` with no entry today, it reads `notification_preferences.email_daily_reminder` (missing row = on) and sends only if it's on.
- **Preferences module** `src/server/internal/notifications.ts:6-46`: `NotificationPrefs`, the defaults and the reader all include `emailDailyReminder`. Other callers of `isNotificationEnabled` use other keys.
- **Action** `src/server/actions/notifications.ts:21-27` (the allowlist) and `:59-68` (insert with defaults when there's no row, update otherwise).
- **UI** `src/app/(app)/profile/notifications/NotificationsClient.tsx:93-107`: both reminder switches, shown to every role.
- **Email** `src/lib/email/templates/daily-reminder.tsx:43`.
- **Schema** `src/db/schema.ts:499`: `email_daily_reminder boolean not null default true`.
- **Export** `src/lib/export/allowlists.ts:369` (descriptions aren't checked by tests).
- **Seeder** `scripts/seed-full.ts:595`.
- **Provisioning** (`provision.ts:98`, `provision-customer-db.ts:58`, `seed-tenant.ts:95`) inserts only `userId`. Unaffected.

### 4.2 Design
1. **Cron:** delete the preference lookup (`:93-98`) and the now-unused `notificationPreferences` import (`:6`). Every active employee with no entry today, who isn't a seed recipient, is sent the reminder.
2. **Type:** remove `emailDailyReminder` from `NotificationPrefs`, `DEFAULT_NOTIFICATION_PREFS`, the reader's mapping and `NOTIFICATION_PREF_KEYS`.
   - A request that still sends the key writes nothing for it and returns ok.
   - A tab left open from before the deploy most likely gets Next's "Failed to find Server Action" (action ids change per build), shown through the existing error toast. Harmless; fixed by a reload.
3. **Column stays.** It's unused, with no migration and `db:safety` untouched. A schema comment marks it unused.
   - The export keeps it, with the description "Not used: daily reminders always go to employees (since 2026-11)."
   - The seeder line may stay.
4. **UI:**
   - the daily switch is removed for every role;
   - employees see the Q2 line, as static text;
   - the deadline switch shows for employees only (Q1);
   - for supervisors and admins the whole "Reminder Notifications" section, including its divider (`NotificationsClient.tsx:91`), is hidden.
   - The doc comment at `actions/notifications.ts:32` changes from "five boolean preference keys" to four.
5. **Email:** delete the Q3 sentence from `daily-reminder.tsx` only.

### 4.3 Send decision (cron, per employee, after the tenant's weekend skip)
| Role | Active | Entry today | Seed recipient | Old preference | Sends? |
|---|---|---|---|---|---|
| employee | yes | no | no | on / off / no row | **yes** (was: only on / no row) |
| employee | yes | yes | — | any | no |
| employee | yes | no | yes | any | no (counted in `skippedSeedRecipients`) |
| employee | no | — | — | any | no (not selected) |
| supervisor / admin | — | — | — | any | no (not selected; unchanged) |

### 4.4 Failure modes and limits
- **Capacity:** sending dominates the run's time, not queries. Each send waits 500 ms on the shared throttle (`src/lib/email/rate.ts:6-7`), and the sweep stops at 240 s (`src/lib/cron/tenant-sweep.ts:26`). That's about 480 sends per run across all tenants, once a weekday (`vercel.json`: `0 20 * * 1-5`).
  - H1 adds every employee who had the reminder off. Only demo data has it off today.
  - The ceiling is pre-existing; Q8 tracks it.
  - Resume, cursor and failed-tenant handling are unchanged.
- **A send fails:** unchanged (`failedSends` is counted; no retry within the run).

## 5. H2: employees see "Self-returned", not "Self-rejected"

### 5.1 Current state (verified twice)
`approvalLabel()` returns `badge` ("Self-rejected", used by outputs) and `uiBadge` ("Self-returned", for the UI) (`src/server/internal/approval-label.ts:104-109`). Both are non-null only for self decisions; they're null for imported periods and for another or null decider (`:83-120`).

Two employee screens read `badge`:
- **Timesheet page:** `getTimesheetPeriod` (`src/server/actions/timesheet.ts:91-95`) → `TimesheetClient.tsx:59`.
- **Past timesheets:** `pastPeriods` (`src/server/internal/past-periods.ts:126`) → `PastTimesheetsClient.tsx:77`.

**No other employee-facing "Rejected" text exists:**
- the return email says "Returned" (`timesheet-rejected.tsx:38`);
- status words say "Returned";
- the audit trail's "Self-rejected" (`audit.ts:363`) is admin-only;
- `getTimesheetForReview`'s `approvalBadge` (`timesheet.ts:529`) isn't rendered.

### 5.2 Design
- Both employee sources read `uiBadge`. Keep the field name `approvalBadge`, and update the comments at `src/types/timesheet.ts:74`, `:142` and `past-periods.ts:34`.
- The PDF, reports, v1 API and export are unchanged.

## 6. H3: slow-CI flaky tests

### 6.1 Current state (measured locally 2026-11-11, `vitest run --reporter=json`, 217 files, all green)
- **CI:** the unit suite runs **three times** (`test:tz`, `.github/workflows/ci.yml:46-47`) on `ubuntu-latest`. Vitest 2.1.9's default per-test timeout is 5 s, and the default hook timeout is 10 s. Nothing overrides either (`vitest.config.ts`, `setup.ts`, no per-file overrides).
- **Real CPU work:**
  - `timesheet-lint.test.ts`: two tests at 2.4 s and 2.3 s locally, **already with 120 s timeouts** (`:34`, `:44`).
  - `eslint-a11y-config.test.ts` (`:13`, `:30`): 2.1 s, with **no timeout override**. This is the likely timeout flake: a runner 2–3× slower passes 5 s.
  - `seed-review-story.test.ts:35` already has 60 s.
  - The time goes into ESLint's lazy config load on the first `calculateConfigForFile` / `lintFiles` call; constructing `new ESLint()` is cheap.
- **Fixed sleeps:** 175 `wait(` calls in 29 unit files, plus 33 raw `setTimeout` sleeps. The shared `click()` helper calls `wait()` too (`src/__tests__/helpers/dom.tsx:45-49`). `wait` wraps `act()`, and `IS_REACT_ACT_ENVIRONMENT` is true (`dom.tsx:12`).
  - Long sleeps (`kit-table` L1/L2: `wait(400)` ×3; `app-navbar` M1: (300 + 150) ms ×3) make files slow but don't scale with runner speed.
  - The flake risk on a slow runner is **short** sleeps that wait for a UI state to appear (for example `app-navbar.test.tsx:28`, `:116`).
  - Many sleeps exist on purpose, before a check that something did **not** happen or that a debounce passed. They must stay.
- **Heaviest files:** `users-row-actions` 11.3 s, `approvals-review` 11.0 s, `kit-table` 6.3 s.
- **Precedent:** `64f1236` fixed a CI flake by rendering 5 rows instead of 501. A test that times out also leaves DOM behind for the next test, so failures cascade.

### 6.2 Design (in this order; limited to the named files)
1. **`eslint-a11y-config.test.ts`:** add explicit 60 s timeouts to its tests, matching the existing lint-test practice.
   - In `timesheet-lint.test.ts`, keep the 120 s timeouts; **never lower an existing timeout**.
   - Optionally, create **one shared** `ESLint` instance per file in `beforeAll` and warm its config by calling `calculateConfigForFile` once, with an explicit hook timeout of at least 60 s (the default is 10 s). The tests then use that instance instead of `new ESLint()` each time. Otherwise the warm-up does nothing.
2. **Short sleeps that wait for a UI state to appear,** in `app-navbar.test.tsx`, `kit-table.test.tsx`, `users-row-actions.test.tsx` and `approvals-review.test.tsx` only.
   - Replace them with a new poll helper in `src/__tests__/helpers/dom.tsx`: `waitUntil(check, description, { timeout = 2000 } = {})`.
   - **Only the sleep goes inside `act`**, never the loop. React 19 queues every render scheduled inside an act scope and flushes only when the callback resolves (`react-dom-client.development.js:18749-18751`, `react.development.js:841-848`). A loop inside one `act` would never see the UI change.
     ```
     const deadline = Date.now() + timeout
     for (;;) {
       if (check()) return
       if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${description}`)
       await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
     }
     ```
   - **Don't** use `vi.waitFor` directly: it polls outside `act`.
   - Each converted test is revert-checked: break the UI change it waits for, and the test must fail on the assertion, not by hanging.
   - **Keep** every sleep that comes before a negative assertion, a debounce, or a "nothing changed" check. Leave `click()` alone.
   - The dev lists each replaced sleep, with file:line.
3. **Heavy renders** in those four files: render the fewest rows that still prove each assertion.
4. **Axe calls are assertions.** Remove one only when it checks a DOM identical to another axe call in the same test.
5. **Nothing else changes:**
   - no other test file is touched;
   - no assertion is deleted or weakened;
   - no global timeout is raised.

   The dev reports before/after timings per touched test and file (same JSON reporter command), plus any assertion changed, with its reason.
6. If Q9 names specific failures, they come first, and the list of files grows only by those.

## 7. H4 sibling (per Q4)

### 7.1 Current state (verified twice)
- **The grid's rule** (correct): `noHours = no hours && past && weekday && !isBefore(date, userCreatedOn)` (`TimesheetGrid.tsx:162`).
- **`userCreatedOn`** is `calendarDayOf(users.created_at, workspaceTimeZone)` (`src/server/internal/timesheet-period.ts:71`). `created_at` is the account's creation time: people import and `seed-tenant` never backdate it (only the demo seeder does, `seed-full.ts:102`). In production it can't be later than `today`, since both come from the same clock. **Tests can make it later:** `integration/employee-dashboard.test.ts:36` creates a user created on the real date and passes `today = 2026-10-07`.
- **`periodProgress`** (`src/lib/timesheet/period-progress.ts:22-41`) counts `expectedWorkdays` / `workdaysFilled` over the whole period up to today. Its callers:
  - `useSubmitChecks` (`useSubmitChecks.ts:30`) → `StatusLine.tsx:26`;
  - `currentPeriodSummary` (`src/server/internal/employee-dashboard.ts:71`), which has **two** callers:
    - Home (`src/server/internal/home.ts:40`, inside a pool-limited `Promise.all` burst; trap T-I comment at `:48`) → `HomeClient.tsx:78`;
    - `selectedPeriodFacts` (`timesheet-period.ts:58`). Its result is stored as `state.summary` (`TimesheetContext.tsx:127`) but not rendered.
- **`completenessWarnings`** (`useSubmitChecks.ts:39-74`) is the submit dialog. Its "no hours" list (`:45-53`) and "seem low" count (`:66-74`) cover the whole period, and its output goes into the submission comment (`SubmitModal.tsx:34-38`).
- **Test-only callers:**
  - `unit/period-progress.test.ts`: its static check at `:36` pins the exact `periodProgress({ … })` call in `employee-dashboard.ts`;
  - `integration/employee-dashboard.test.ts`;
  - `unit/home-scope-review.test.ts`: it mocks `getDb` as `{}` (`:15`);
  - `integration/home-data.test.ts` (wraps `currentPeriodSummary` at `:75`).

### 7.2 Design (Q4 as recommended: progress line only)
1. `periodProgress` takes a **required** `countFrom: CalendarDate`, so `tsc` finds every caller.
   - `expectedWorkdays` and `workdaysFilled` count only weekdays `≥ countFrom` and `≤ today`.
   - `total` still includes all hours, including imported hours on earlier days. So the counts never read "9 of 8".
   - If `countFrom` is after `today` or after the period's end, both counts are 0.
2. **Callers:**
   - **`useSubmitChecks`:** pass `state.userCreatedOn`, and add it to the picked state type.
   - **Home:** read the user's `createdAt` in the small `Promise.all` that already runs before the burst (`home.ts:33`: today, time zone, schedule resolver), as a fourth item. Pass `calendarDayOf(createdAt, tz)` into `currentPeriodSummary` via a new required parameter. **No new query inside the burst.** Don't widen `loadApprovalFacts` (19 callers, some inside locked transactions).
   - **`selectedPeriodFacts`:** keep its three queries parallel (the `createdAt` read already exists, `timesheet-period.ts:60`). After the `Promise.all`, recompute the summary's `expectedWorkdays` / `workdaysFilled` with `periodProgress` from `summary.dailyHours` and the creation day. That's the only way that adds neither a query nor a serial round-trip. To make it possible, `currentPeriodSummary`'s `countFrom` parameter is optional here and **required for Home** (enforced by T10). (`state.summary` isn't rendered, so this is only for consistency.)
3. **Progress text when `expectedWorkdays === 0`:**
   - timesheet `StatusLine`: "`{hours}` hours entered · Due `{dddd, MMM D}`", or "· Was due `{MMM D}`" once past, keeping both existing due variants (`StatusLine.tsx:23-25`). The "X of Y" clause is dropped;
   - Home: "`{hours}` hours entered." without the second sentence.
4. **`completenessWarnings` is unchanged** (Q4 b).
5. **Out of scope:** who is "expected to submit" for Home's team status (UX2-Q1).

**If the product owner chooses to fix (b) too:** `completenessWarnings` also takes `countFrom`. Both its "no hours" list and its "seem low" workday count then start at `max(periodStart, countFrom)`. Tests T9 and T9b below cover it.

## 8. H5: connect can't be started from another site

### 8.1 Current state (verified)
- **The route:** `GET /api/integrations/qbo-connect` (`src/app/api/integrations/qbo-connect/route.ts`) checks `requireAdminFresh`, mints a signed state, sets the httpOnly nonce cookie (`sameSite: 'lax'`, 10 min, host-only) and redirects to `https://appcenter.intuit.com/connect/oauth2` (`qbo-api.ts:14`).
- **The session cookie:** Auth.js's is host-only `SameSite=Lax` (`node_modules/@auth/core/lib/utils/cookie.js:48-55`; no override in `src/auth.ts`), so a top-level GET from any site carries it.
- **Impact is low:**
  - the admin lands on Intuit's consent page;
  - finishing still needs consent and the matching nonce cookie (`complete/[provider]/route.ts:9-12`, `:32-37`);
  - a cross-site trigger can overwrite an admin's in-progress nonce, breaking that attempt.
- **Links to the route after Part 2b (2b line numbers):**
  - Connect at `IntegrationsClient.tsx:138`;
  - **Reconnect** at `IntegrationsClient.tsx:139`;
  - **Reconnect** at `IntegrationConfigView.tsx:240`.

  Two tests assert those links:
  - `unit/integration-hub-ui.test.tsx:89`;
  - `unit/integration-mapping-ui.test.tsx:132`, whose actions mock at `:33-36` lacks the new export. The hub test doesn't mock `@/server/actions/integrations` at all, and `IntegrationsClient.tsx:11` imports only a type from it today.

  Nothing else references the route: `oauth-connect.test.ts:66-67` imports only `complete` and `callback`, and the Intuit app settings register only the callback URL.
- **The error banner** on the hub is mount-only state (`IntegrationsClient.tsx:97-103`). The old GET route always ended in a full page load, so the banner always showed. An action's redirect to the same route is a soft navigation that may not remount it.
- **Gusto:** `gusto-connect/route.ts` exists, and Part 2b removes every link to it (Q7).

### 8.2 Design (Q7 as recommended)
1. **New server action** `startQuickBooksConnect()` in `src/server/actions/integrations.ts`, taking no arguments.
   - Server Actions are POST-only. Next compares the request's `Origin` host with `x-forwarded-host`, falling back to `host`, and aborts on a mismatch (`node_modules/next/dist/server/app-render/action-handler.js:379-412`; `next.config.ts` sets no `allowedOrigins`). That refuses other sites **and** sibling tenant subdomains.

   Structure:
   ```
   let actor
   try { actor = await requireAdminFresh() }
   catch (e) { unstable_rethrow(e); redirect(e instanceof AuthorizationError && e.kind === 'unauthenticated' ? '/login' : '/timesheet') }   // as session.ts:22
   const slug = await getTenantSlug()
   if (!slug) redirect('/settings/integrations?error=qbo_config_missing')
   let nonce: string, authUrl: string
   try { nonce = generateOAuthNonce(); authUrl = getQBOAuthUrl(mintOAuthState({ tenantSlug: slug, userId: actor.id, provider: 'quickbooks_online', nonce })) }
   catch { redirect('/settings/integrations?error=qbo_config_missing') }   // config missing
   ;(await cookies()).set('qbo_oauth_nonce', nonce, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 600, path: '/' })
   redirect(authUrl)   // outside any try (redirect.md:50-54: absolute URLs allowed; it throws)
   ```
   Don't wrap it in `userAction`: it always ends in a redirect. Cookies set in an action are written onto the action's response (`node_modules/next/dist/server/async-storage/request-store.js:71-74`), before the external redirect:
   - with JavaScript on, the client hard-navigates (`server-action-reducer.js:222-227`);
   - with JavaScript off, it's a 303 with `Location` (`action-handler.js:791-809`).
2. **UI: all three controls** become a plain `<form action={startQuickBooksConnect}>` with a submit `Button`, keeping each one's label and look.
   - **Don't** call the action through `runAction` or an await-with-catch. Next's redirect handling does the navigation, and a catch would turn the redirect into an error. That was the A4 bug (precedent `workspace-finder.ts:22-24`).
   - The read-only (`WriteButton`) branches are unchanged.
   - **Banner:** `page.tsx` passes a `key` built from the callback params (`error`, `connected`, `provider`) to `IntegrationsClient`. A redirect back with a new error then remounts it, and the banner shows.
3. **Delete** `qbo-connect/route.ts` and `gusto-connect/route.ts`. Callback, complete and cookie names are unchanged.
4. **CSP:** add `https://*.intuit.com` to `form-action` in `next.config.ts:23`. Chromium applies `form-action` to every redirect hop of a form-submission navigation, and Intuit's authorize page can redirect to its own sign-in host. Before coding, the product owner runs `curl -sI '<a real authorize URL>'` and confirms every hop is on `*.intuit.com`; if not, list the extra hosts.
   - With JavaScript on, the redirect is a script navigation, and `form-action` doesn't apply.
   - Before hydration, or with JavaScript off, it's a native form POST answered `303 Location: <Intuit>`. Chromium checks `form-action` on that redirect, and the CSP is planned to switch from report-only to enforce (`PRODUCTION-DEPLOY.md:569`).
5. **Read-only workspaces:** the same as today.

### 8.3 Flow states
| Start | Event | Result | Side effects |
|---|---|---|---|
| Integrations hub or QBO page, admin, full mode | Click Connect or Reconnect (same origin, JS on) | Intuit consent page | Nonce cookie set; state signed |
| Same, before hydration or JS off | Native POST → 303 | Intuit consent page (allowed by `form-action`) | Same |
| A tab left open across a deploy | Click Connect | "Failed to find Server Action", error boundary until reload (same as every other action) | None |
| Another origin or a sibling tenant host | POST to the action | Aborted by Next (origin mismatch) | None |
| Anywhere | GET `/api/integrations/qbo-connect` or `gusto-connect` | 404 | None |
| Not signed in | Action | `/login` | None |
| Signed in, not admin | Action | `/timesheet` | None |
| Admin, QBO not configured | Action | `/settings/integrations?error=qbo_config_missing` | No cookie |
| Consent done | Callback → complete | Unchanged | Unchanged |

## 8b. H6: one QuickBooks token refresh at a time

### 8b.1 Current state (verified)
`ensureValidToken(connectionId)` (`src/lib/integrations/connectors/qbo-api.ts:136-176`):
1. reads the tokens with the read client;
2. returns the access token if it's valid for more than 5 minutes;
3. otherwise gets the write client (which throws in read-only mode, before the refresh), calls `refreshQBOToken` (`:99-128`, a plain `fetch` with no timeout), and writes the new tokens with `WHERE id = connectionId`.

There is no lock and no re-read. **Callers:**
- `loadQboMappingData` (`src/server/actions/qbo.ts:43`, once per page load since Part 2b I3);
- `fetchQBOClassesForMapping` (`qbo.ts:133`);
- the sync engine (`sync-engine.ts:218`, after the `running` log exists).

So two requests at once can both refresh: a page load during a send, two tabs, or the classes import. Each refresh presents the same refresh token, and the last write wins.

### 8b.2 Failure modes
- **Concurrent refresh.** Intuit may reject the second refresh, or both may succeed with different tokens. Either way the stored pair can end up invalid, and the admin sees "Needs reconnecting" with no real cause.
- **Refresh racing a reconnect or disconnect.** A refresh that started before a reconnect deactivated the row writes tokens back onto it. That undoes the token clearing of Part 2b G7 and leaves secrets on an inactive row.
- **Hung refresh.** `fetch` has no timeout, so a hung Intuit call holds the request until the platform kills it.

**Intuit's exact refresh-token rotation rules couldn't be fetched** (the docs render client-side). The design below doesn't depend on them: it serializes, re-reads, and always stores what the last successful refresh returned. The dev confirms the rotation rule from Intuit's docs in the impact analysis and records it.

### 8b.3 Design
`ensureValidToken`:
1. **Fast path:** read the row with the read client, now also selecting `provider` and `is_active`.
   - Not `quickbooks_online`, not active, or tokens missing → `connectionExpiredError`.
   - Access token valid for more than 5 minutes → return it, with no lock.
   - This also closes `fetchQBOClassesForMapping`'s missing provider and active checks (`qbo.ts:130-138`): a Gusto id never gets a token handed to Intuit.
2. **Refresh path:**
   - get the write client first, as today, so a read-only workspace still throws before the provider is called;
   - open **one transaction** on it;
   - `SELECT pg_advisory_xact_lock(hashtext('integration-token:' || connectionId))`;
   - **re-read** the row (`provider`, `is_active`, both encrypted tokens, `token_expires_at`) inside the transaction.
     - **Not `quickbooks_online`, inactive, or no tokens** → throw `connectionExpiredError('QuickBooks')`. A reconnect or disconnect won, and nothing is written.
     - **Valid for more than 5 minutes** (another request refreshed while this one waited) → return that access token, with no refresh.
     - **Otherwise** → `refreshQBOToken(<the re-read refresh token>)`, then update the row with a **compare-and-swap**: `WHERE id = connectionId AND is_active = true AND refresh_token_encrypted = <the re-read ciphertext> … RETURNING id`, all inside the same transaction.
       - Under READ COMMITTED that `WHERE` is re-checked against the latest committed row.
       - A reconnect that committed **during** the Intuit call makes it update 0 rows, whether it **reused this same row** with new tokens (the usual reconnect, `internal/integrations.ts:54-66`) or deactivated it. So does a disconnect.
       - **0 rows → throw `connectionExpiredError`**, and the new tokens are discarded. The reconnect's tokens always win.
3. **`refreshQBOToken`** gets `signal: AbortSignal.timeout(15_000)`.
   - The `try/catch` wraps both the `fetch()` and the body read (`response.json()`; the same signal covers it).
   - A timeout (`TimeoutError` DOMException) or a network failure (`TypeError`) is caught and rethrown as `UserFacingError('QuickBooks didn’t respond. Try again in a minute.')`.
   - HTTP error responses keep the existing `providerRefreshError` mapping.
4. **Lock key:** the prefix `integration-token:` is new. Add `{ file: 'src/lib/integrations/connectors/qbo-api.ts', expr: "'integration-token:' + connectionId" }` to the `sql-template-params` allowlist (same pattern as `:37-39`).
5. **Test seam:** `ensureValidToken` calls `refreshQBOToken` inside the same module, so `vi.mock` / `vi.spyOn` can't intercept it. Tests stub the network with `vi.stubGlobal('fetch', …)` keyed on Intuit's token URL, with `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` set. Concurrent changes run from **inside** that stub through a second database connection. They don't block, because the refresh transaction holds no row lock until its final update.

**Lock ordering:** no other code takes `integration-token:` together with another lock family, and the transaction holds only this lock.
- A reconnect takes `integration-connection:{provider}`, then updates rows, waiting on row locks if a refresh transaction holds one. The refresh transaction never waits for the connection lock.
- So the two only queue on row locks in one direction: no deadlock.

**Platform limits:**
- The transaction holds one pooled connection (per-tenant pool `max: 10`, `src/db/index.ts:33`) for one Intuit round trip, at most 15 s with the timeout.
- Refreshes happen at most about hourly per connection, and the fast path takes no lock.
- **Accepted:** if Intuit is down, requests queued on the lock each try in turn (N × 15 s, each holding one connection). Per-tenant concurrency here is low: page loads, a send, the classes import.
- **Accepted, and the same as today:** if Intuit rotates the token but the 15 s timeout fires before its reply arrives, that rotation is lost. Whether this matters depends on Intuit's rotation rule, which the dev confirms.

**Gusto:** `ensureValidGustoToken` is unused by the UI since Part 2b I10. Out of scope; it's recorded.

### 8b.4 States (refresh path, per call)
| Re-read inside the lock | Action | Writes |
|---|---|---|
| Not QuickBooks, row inactive, or a token missing | throw `connectionExpiredError` | none |
| Access token valid for more than 5 min | return it | none |
| Expired or due, active | refresh with the re-read refresh token; store the pair by compare-and-swap | tokens and `token_expires_at` (`AND is_active = true AND refresh_token_encrypted = re-read`); 0 rows → throw `connectionExpiredError` |
| Refresh fails: HTTP error / timeout or network | throw `providerRefreshError` / "QuickBooks didn’t respond…" | none; the transaction rolls back |

## 9. Blast radius
| File | Change |
|---|---|
| `src/app/api/cron/daily-reminder/route.ts` | Preference lookup and its import removed (H1) |
| `src/server/internal/notifications.ts`, `src/server/actions/notifications.ts` | Key removed (H1) |
| `src/app/(app)/profile/notifications/NotificationsClient.tsx` | Switches per Q1; Q2 line (H1) |
| `src/lib/email/templates/daily-reminder.tsx` | Q3 sentence removed |
| `src/db/schema.ts`, `src/lib/export/allowlists.ts` | Comment and description only |
| `src/server/actions/timesheet.ts`, `src/server/internal/past-periods.ts`, `src/types/timesheet.ts` | H2 |
| `src/lib/timesheet/period-progress.ts`, `useSubmitChecks.ts`, `StatusLine.tsx`, `employee-dashboard.ts`, `home.ts`, `timesheet-period.ts`, `HomeClient.tsx` | H4 (Q4) |
| `src/server/actions/integrations.ts`, `IntegrationsClient.tsx`, `IntegrationConfigView.tsx`, `next.config.ts`; delete `src/app/api/integrations/{qbo,gusto}-connect/route.ts` | H5 |
| `src/app/(app)/settings/integrations/page.tsx` | `key` on `IntegrationsClient` (H5 banner) |
| `src/lib/integrations/connectors/qbo-api.ts`, `unit/sql-template-params` allowlist | H6 |
| Tests | `unit/notifications-page`, `unit/reminder-crons`, `unit/email-send` (if it checks the footer), `unit/period-progress` (static regex at `:36`), `integration/employee-dashboard` (passes `countFrom` explicitly; keep the existing expectations by passing a day at or before its period start), `unit/home-scope-review` (extend its `getDb` mock), `integration/home-data`, `unit/past-timesheets-page`, `unit/timesheet-page-layout`, `integration/approver-rules`, `unit/integration-hub-ui` and `unit/integration-mapping-ui` (mock the actions module with `startQuickBooksConnect`; assert a `form` with a submit button labelled "Connect QuickBooks" / "Reconnect" instead of an `href`), `src/__tests__/helpers/dom.tsx` (`waitUntil`), plus the four H3 files |

Nothing changes for other crons, webhooks, migrations, the control plane or the v1 API.

## 10. Required tests
Each test fails without its change, and the dev revert-checks every one, except those marked **guard**: regression guards that pin behaviour which must not change.

| # | Scenario | Where |
|---|---|---|
| T1 | Daily cron: an employee whose preference row says `email_daily_reminder = false`, with no entry today, **is sent** the reminder. | `unit/reminder-crons` (table-keyed mock, `:67-73`) |
| T2 | Daily cron: no `notification_preferences` query runs. The mock throws on that table only when a per-test flag is set, because the deadline cron in the same file still queries it (`submission-deadline/route.ts:111`). It also asserts **positively** that the employee was sent the reminder, since the tenant sweep would otherwise swallow the throw. | `unit/reminder-crons` |
| T3 | `updateNotificationPreferences({ emailDailyReminder: false })` returns ok and writes nothing for that key. The property carries a `// @ts-expect-error` line comment directly above it, as in `integration/mass-assignment.test.ts:84-86`. (a) No row: the inserted row has `email_daily_reminder = true`. (b) Existing row: the value is unchanged. | integration |
| T4 | Notifications page: no daily switch for employee, supervisor or admin. The Q2 line shows for employees only. The deadline switch shows for employees only. | `unit/notifications-page` |
| T5 | Daily reminder HTML doesn't contain "disable these reminders"; the deadline email still does. | template render test |
| T6 | A self-returned period: `getTimesheetPeriod().approvalBadge === 'Self-returned'`, and so does the `pastPeriods` row. A self-approved one still reads "Self-approved". | `integration/approver-rules` |
| T7 **guard** | `approvalLabel().badge` for a self-return stays "Self-rejected" (already covered at `approval-decisions.test.ts:70`, `:134`; confirm it's still there). | existing |
| T8 | `periodProgress` with `countFrom` mid-period: earlier days are neither expected nor filled, even with imported hours on them; `total` includes those hours. Also covered: `countFrom` before the period start (no change), `countFrom` = today, a weekend `countFrom`, `countFrom` after today (0 and 0). | `unit/period-progress` |
| T9 **guard** (Q4 as recommended) | `completenessWarnings` still lists a weekday before the account's creation and still counts it in "seem low". | unit |
| T9b (only if (b) is chosen) | `completenessWarnings` with `countFrom`: no earlier day in the list; the "seem low" count starts at `countFrom`. | unit |
| T10 | `currentPeriodSummary` for a person created mid-period: `expectedWorkdays` counts only from the creation day. Home adds no query inside the burst (the creation read is in the pre-burst `Promise.all`). | `integration/employee-dashboard` + `integration/home-data` |
| T11 | With `expectedWorkdays === 0`: StatusLine's exact text is "`{h}` hours entered · Due …" (both due variants), and Home's is "`{h}` hours entered." | unit |
| T12 | `startQuickBooksConnect()` as admin: sets `qbo_oauth_nonce` with httpOnly, secure, lax, 600 s, path `/`, no domain, and redirects to the Intuit URL. The state verifies, and its tenantSlug, userId, provider and nonce match the cookie. | unit |
| T13 | Not admin → `/timesheet`; unauthenticated → `/login`; no tenant slug → the error redirect; config missing (the auth-URL builder throws) → the error redirect. None of them sets a cookie. | unit |
| T13b | Render the server page `await IntegrationsPage({ searchParams })` (with `requirePageRole` and `getIntegrationHub` mocked) without `error`, then re-render **into the same root** with `error=qbo_config_missing`: the banner shows. Removing the `key` from `page.tsx` makes it fail. | `unit/integration-hub-ui` |
| T14 | Source scan: no non-test file under `src/` contains `/api/integrations/qbo-connect` or `/api/integrations/gusto-connect`. | unit |
| T15 | The CSP from `(await import('next.config')).default.headers()` (following `route-moves.test.ts:50`), under either `Content-Security-Policy` or `Content-Security-Policy-Report-Only` (`next.config.ts:31-33`), has `form-action 'self' https://*.intuit.com` (plus any host the curl check adds), and nothing else. | unit |
| T16 **guard** | `server-action-guards` passes with the new action. | existing |
| T17 (H3) | Before/after timing table in the dev's report; each replaced sleep listed; no assertion removed. | report |
| T18 (H6) | **Waits for the lock.** A holder connection takes `integration-token:{id}`; `ensureValidToken` on an expired connection is seen waiting in `pg_locks`. The holder releases it; exactly one token fetch, and the new pair is stored. (The Part 2b IN-5 technique, `integrations.test.ts:133-161`; the test database has one connection.) | integration |
| T19 (H6) | All three cases through the fetch stub and a second connection. **(a)** The re-read finds the row deactivated → `connectionExpiredError`, no fetch, no write. **(b)** The row is deactivated **during** the stubbed refresh → 0 rows, `connectionExpiredError`, tokens stay null. **(c)** The **same row is reconnected** (reactivated with new tokens) during the stubbed refresh → 0 rows, `connectionExpiredError`, and **the reconnect's tokens survive**. | integration |
| T20 (H6) | **Re-read wins.** The holder takes the lock; the call reads an expired token, then waits (seen in `pg_locks`); the holder writes a valid token and commits; the call returns that token with **no fetch**. | integration |
| T21 (H6) | Token fetch: (a) `fetch` receives an `AbortSignal`; (b) a `TimeoutError` and (c) a `TypeError` both surface "QuickBooks didn’t respond. Try again in a minute.", with no write. | unit (fetch stub) |
| T21b (H6) | A Gusto connection id passed to `ensureValidToken`, run **twice**: once with a token valid for more than 5 minutes (fast path) and once expired (refresh path). Both → `connectionExpiredError` and no fetch. The same for an inactive QuickBooks row with a valid token. | integration |
| T22 **guard** (H6) | Fast path: a valid token returns without opening a transaction; read-only mode still throws before the provider is called (existing behaviour). | unit |

## 11. Verification
- **Dev:** `npx tsc --noEmit`, `npm run lint` (0 errors), `npm run test`, `npm run test:tz`, `npm run db:safety`, and:
  ```bash
  REQUIRE_CONTROL_PLANE_TESTS=1 CONTROL_PLANE_DATABASE_URL="$(grep -h '^CONTROL_PLANE_DATABASE_URL=' .env.local .env 2>/dev/null | head -1 | cut -d= -f2-)" ENCRYPTION_KEY="$(grep -h '^ENCRYPTION_KEY=' .env.local .env 2>/dev/null | head -1 | cut -d= -f2-)" TZ=America/New_York npm run test:integration
  ```
  Check the skipped count: about 1 file is normal.
- **Product owner:** `npm run build`, `npm run demo:local`, `AUTH_TRUST_HOST=true npm run start`, then:
  1. **Profile → Notifications:**
     - as an employee: no daily switch, the Q2 line, and the deadline switch;
     - as a supervisor or admin: neither reminder switch.
  2. **Self-returned badge.** Sign in as Admin User. As the only admin, they already have self-approval (it's derived from being the only active admin, `approval-rules.ts:96-100`).
     - Open a past period (it's a draft) and enter hours. If the admin has no code to charge, give them one in Assignments first.
     - Submit it, then return it from Approvals.
     - The Timesheet page and Past timesheets show "Self-returned".
  3. **New account:** create a supervisor today and sign in as them.
     - Home and the timesheet show no "X of Y" clause, or count only from today.
     - The submit dialog's warnings deliberately still list earlier empty weekdays (Q4 b). The dialog only opens on a period's last weekday, so this is covered by test T9 rather than by hand.
  4. **Connect:** Settings → Integrations → Connect QuickBooks goes to Intuit, or to the config-missing state locally.
     - If a connection is expired, both Reconnect buttons do the same.
     - `/api/integrations/qbo-connect` opened directly returns 404.
     - **With JavaScript disabled** in the browser, Connect still reaches Intuit, and the console shows no `form-action` CSP report. (With JavaScript on, the navigation is scripted and `form-action` doesn't apply.)
     - Locally, with QuickBooks not configured, the hub shows the config-missing banner after clicking Connect, with JavaScript **on**.

## 12. Hand-off rules
`BLUEPRINT-STANDARD.md` §3 in full:
- a written impact analysis before coding;
- one commit per item (H1, H2, H3, H4, H5, H6);
- revert-check every test that isn't a guard;
- don't push.

Don't stage the lead's uncommitted planning files (draft `feature-plan-*.md`, draft `*-AUDIT.md`, `BUSINESS-DECISIONS.md`, `test-data/`).
