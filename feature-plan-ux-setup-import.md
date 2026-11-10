# Blueprint UX-4c Part 2a: Setup checklist and Import

> **Status:** v3 FINAL, 2026-11-10, lead architect. Pre-mortem rounds 1 and 2 applied (§14). The two-round limit is reached; the code audit catches the rest.
>
> **Branch:** `ux-setup-import`, cut from `main` **after `approval-scope` merges** (its rewritten `bulkImportAssignments` and the approval-scope import copy are the base for the Approval scope import type here).
>
> **Approved design:** `ux-mockups/ux4-batch2b.html`, screens Setup and Import (`UX-4-AUDIT.md` §10). Match it except where §0 says otherwise.
>
> **Product-owner direction:** polished, usable, professional; not overengineered.

---

## 0. Lead rulings
| # | Ruling |
|---|---|
| P1 | **Setup moves into Settings.** It's at `/settings/setup`, titled "Setup checklist", the first item in `SETTINGS_NAV`. `/admin/setup` redirects there (307). The Home "Finish setting up" card links there. |
| P2 | **Six required steps:** Time zone and workweek; Pay schedule; Contracts and CLINs; Charge codes; People; Charge code access. **Three recommended:** Indirect codes, Labor categories, Payroll or accounting connection. Steps can be done in any order; the list is in dependency order. |
| P3 | **Honest completion.** Each step is done only when its condition holds (§3.1). Admins record time too (`team-period-status.ts:59`), so a workspace of only admins can finish:
  - **People** is done when an active employee or supervisor exists **or** an active admin holds a chargeable code.
  - **Charge code access** is done when the covered group (active employees and supervisors with a chargeable code, plus admins with one) isn't empty. People who only charge indirect codes (G&A, HR, accounting) never hold a direct code, so requiring everyone would never finish (round 2).
    - The step always shows "{w} of {m} people can charge a direct code" with the names of the others as a **non-blocking** note: "If they record only indirect time (overhead, G&A, leave), that's fine."
    - The badge is Done, plus "{w} of {m}" in warn when w < m.
  - `isComplete` = all six required steps done. |
| P4 | **Detection without new columns:**
  - time zone and workweek are done when `workweek_start_day` is set (time zone always has a value, so it's shown and editable in the same step);
  - pay schedule is done when a `pay_period_config` row exists **or** the workspace has timesheet data (the default schedule is then in use). |
| P5 | **Inline forms only while it's safe.** The two settings steps show inline forms only when the step isn't done **and** the workspace has no timesheet data. Otherwise they show the current values and a link to the Workspace or Pay schedule page, where the existing confirms live. |
| P6 | **First pay schedule save:** `updatePayPeriodConfig` allows saving a config equal to the default **only when `effectiveFrom === null` and `SELECT 1 FROM pay_period_config LIMIT 1` returns nothing**, checked inside its advisory lock. The new branch sits **after** the existing `if (pending) return cancel();` (C7, `pay-period-config.ts:272-276`) and before the refusal. Today it refuses with "This is already your pay schedule" (`pay-period-config.ts:275`). Every other case keeps the refusal, including a future date with no row. |
| P7 | **One Import page** at `/settings/import`, titled "Import". `/settings/migration` redirects to `/settings/import?type=hours` (307). The nav's "Data import" and "Timesheet history import" become one item, "Import". |
| P8 | **Nine import types**, chosen from a list (URL `?type=`):
  1. People
  2. Contracts
  3. CLINs
  4. Labor categories
  5. **Charge codes** (new)
  6. **Charge code access** (new)
  7. Approval scope

  Past timesheets: 8. Hours, 9. Timesheet status. |
| P9 | **Every setup type gets a server check (dry run) that runs the real import.** Each setup import action takes `dryRun?: boolean`. A dry run executes the identical per-row logic and **rolls back** with an internal sentinel.
  - There is no second copy of the validation.
  - A dry run sends no emails, no re-route notifications and no per-row Sentry events, and returns no passwords.
  - Hours and Timesheet status keep their existing dry run (`validateMigration*`).
  - Verified in the library source: postgres-js rolls back when the callback throws and rethrows unchanged (`node_modules/postgres/src/index.js:257-279`). Drizzle savepoints map to `client.savepoint` (`drizzle-orm/postgres-js/session.js:130-140`). `admin_change_log` triggers fire only on UPDATE, DELETE and TRUNCATE (`0014:55-60`). Advisory locks are released at rollback. |
| P10 | **Every setup import runs in one transaction with a savepoint per row** (as `bulkImportEmployees` does). One bad row never aborts the others. Contracts, CLINs and labor categories have no transaction today and gain one. |
| P11 | **Row numbers are spreadsheet rows** for setup types: `row` = record index + 2 (papaparse gives no line numbers; header = row 1, blank lines skipped). The client sends `{ row, ...fields }` and the server echoes it. The copy at `ImportClient.tsx:70` is updated. Hours and Timesheet status keep their existing numbering (`batch-runner.ts:9`). |
| P12 | **Optional columns are optional; bad values are refused, never coerced:**
  - an unknown role is an error (today it silently becomes employee, `import.ts:81-92`);
  - FLSA must be Yes/No/True/False (R7: overtime status is required);
  - contract Type is blank (prime), `prime` or `sub`, else an error.
  - Templates are updated to match. |
| P13 | **Size limits** come from per-type constants in `src/lib/import/limits.ts`, used by both the browser and the server: **Approval scope 500 rows** (as `feature-plan-approval-scope.md` §4.2), every other setup type 1,000 rows.
  - The payload is measured with `serializedBytes` (`import-plan.ts:23`) against 800 KB, so it stays under the 1 MB server-action default.
  - Over a limit is refused in the browser: "This file has {n} rows. Split it into files of {limit} rows or fewer."
  - Hours and Timesheet status batching is unchanged. |
| P14 | **The import window shows up front** for Hours and Timesheet status. A new read, `getImportWindowStatus()`, wraps `isImportWindowOpen` and returns `{ open: boolean | null }` (null when the control plane can't be read; show "Couldn't check whether past timesheets can be imported."). The copy:
  - open: "Open — you can import past timesheets.";
  - closed: "Closed — contact support to reopen it.". |
| P15 | **Confirm the pay schedule before past hours.** On Hours and Timesheet status, when no `pay_period_config` row exists, show a warn notice: "Confirm your pay schedule first. After hours are imported it can only change on a future date." It links to the Setup checklist. An Hours import makes timesheet data exist, which ends the immediate path, and Timesheet status rows must fall on period starts (`internal/migration.ts:127`). |

## 1. Verified current state
### 1.1 Setup
- **`getSetupStatusInternal`** (`src/server/internal/setup.ts:34-87`):
  - 7 parallel counts;
  - steps with `done = count > 0`;
  - access: `allCovered`, `withAccess`, `total`;
  - `isComplete = contracts && clins && chargeCodes && employeesWithAccess > 0` (:82);
  - `total` is always 7.
- **Gaps:** `getSetupAccessGapsInternal` (:103-118; names capped at 20). Actions: `getSetupStatus` / `getSetupAccessGaps` (`requireAdmin`, `actions/setup.ts:10-19`).
- **Page** `admin/setup/page.tsx`: title 'Setup'. Client: `SetupWizardClient.tsx` (Stepper; done screen gated on `isComplete`, :241). Not in any menu (`nav-config.ts:49`).
- **Home:**
  - `home.ts:50` (`getSetupStatusInternal` sequential after the burst; passes `{isComplete, done, total, steps}`; `workweekSet`);
  - `attention.ts:146-153` (title "Finish setting up: {done} of {total} done", hint from `SETUP_STEP_HINT` :58-66, link `/admin/setup`), separate workweek (:155-161) and pending pay config (:163-168) items.
- **Settings actions:**
  - `updateWorkspaceTimezone` (`workspace-settings.ts:28-42`, no log);
  - `updateWorkweekStartDay` (:60-79, logs);
  - the confirms are client-side (`WorkspaceSettingsClient.tsx:42, 121, 162`).
- **Settings schema:** `timezone` NOT NULL default (`schema.ts:629-641`); `workweek_start_day` nullable. Provisioning seeds the time zone and no pay config.
- **Pay schedule:**
  - `updatePayPeriodConfig` (`pay-period-config.ts:241-312`): an immediate change only when `workspaceHasNoTimesheetData` (:172-177);
  - the default-equals refusal (:275);
  - the anchor rule (:146-152);
  - `getValidScheduleChangeDates` (:192);
  - default semimonthly (`date-utils.ts:35-39`).

### 1.2 Import
- **`import.ts` actions:** all `requireAdminFresh`, returning `ImportResult{created, skipped, errors{row,message}[], generatedPasswords?}`. Row = index in the sent array.
  - `bulkImportEmployees` (:35-114): transaction, lock, seat check, savepoints, logs.
  - Contracts (:130-169), CLINs (:182-217) and labor categories (:232-280): **autocommit per row, no log**.
  - `bulkImportAssignments` (after `approval-scope`): approval scope, `scopeChange`, savepoints.
- **Helpers:** `import-errors.ts` (`importRowMessage`, `parseImportDate`); `csv-parser.ts` `parseCSV` (papaparse header mode, required columns, "`col` is required").
- **Migration:**
  - `validateMigrationData/Periods` (dry run);
  - `importMigrationData/Periods` (batches of 2,000 rows / 200 employees / 800 KB);
  - `runMigrationBatches` (stops at the first refusal);
  - window: `isImportWindowOpen` (`import-window.ts:40`).
- **Clients:**
  - `ImportClient.tsx`: tabs; the generic `ImportWizard` parses client-side; every template column required; generated-passwords modal :413.
  - `MigrationClient.tsx`: source system, Papa directly, no header check.
  - Templates in `public/templates/*`.
- **Charge codes:**
  - the `createChargeCode` action (`charge-codes.ts:121-147`) validates code, name, description, active CLIN and SLIN-on-CLIN, but **not** `workLocation` / `billable` values nor category fit;
  - `createChargeCodeInternal` (`internal/charge-codes.ts:18-43`) does no validation;
  - `categoryFitsCode` (`labor-rates.ts:213-216`);
  - `workLocationEnum` onsite/telework/other.
- **Access:** `assignChargeCodeToUserInternal` (internal :49-69) and `CHARGEABLE_CODE`.
- **Nav:** `SETTINGS_NAV` (`nav-config.ts:58-66`); `nav-config.test.ts:23-42, 57`; `page-metadata.test.ts:54-61` (title = label); redirects `next.config.ts:70-71` + `route-moves.test.ts:56-57`.
- **Body limit:** no `bodySizeLimit`, so Next's 1 MB default applies.

## 2. Invariants
1. **Guards first:** writes use `requireAdminFresh`; reads use `requireAdmin` (+ `ADMIN_READ_ONLY_ALLOWLIST`).
2. **Dry runs write nothing:** every write is inside the rolled-back transaction, with no emails, no passwords returned, and no `import_batches` row.
3. **Imports honour existing rules:**
   - seat limit;
   - user-rules lock for people and approval scope;
   - `CHARGEABLE_CODE` for access;
   - the charge-code validation of the `createChargeCode` action (shared, §4.3);
   - the migration import window.
4. **DCAA:** Hours and Timesheet status imports are unchanged (provenance, window, batches).
5. **The calendar-date model:** imported dates are `YYYY-MM-DD` (`parseImportDate`).
6. **The focus rule:** no `disabled` / `loading` on focusable buttons.

## 3. Setup checklist
### 3.1 Server: `getSetupStatusInternal` (rewritten)
**Keep it lean** (Home calls it, and C17 keeps names off Home, `setup.ts:100`, `setup-status.test.ts:46`): counts and booleans only, **no names and no detail strings**. It returns `{ steps, requiredDone, requiredTotal: 6, isComplete, counts, hasTimesheetData }`.
- The **page** uses a separate page-only loader `getSetupPageData()` (`requireAdmin`, read-only allowlist). It adds gaps (`getSetupAccessGapsInternal`, names ≤ 20) and `settings = { timezone, workweekStartDay, payConfig: { set, periodType, anchorDate, weekStartDay } }`, and builds the detail text on the page.
- **Move `workspaceHasNoTimesheetData`** from the `'use server'` `actions/pay-period-config.ts` into `src/server/internal/pay-period-config.ts`. Exporting it from an actions file would create an unguarded endpoint. Import it in both places.

**Steps** (key, required, done rule, detail):

| Key | Req | Done when | Detail shown |
|---|---|---|---|
| `timeAndWeek` | ✓ | `workweekStartDay !== null` | "{timezone label} · weeks start {day}" |
| `paySchedule` | ✓ | a `pay_period_config` row exists or `hasTimesheetData` | "{summary}" or "Using the default: twice a month" |
| `contractsClins` | ✓ | active contracts > 0 and active CLINs > 0 | "{n} contracts · {m} CLINs" |
| `chargeCodes` | ✓ | chargeable codes > 0 | "{n} direct codes" + warn "{k} CLINs have no code yet." when active CLINs lack a code |
| `people` | ✓ | active employees or supervisors > 0, **or** an active admin holds a chargeable code (P3) | "{n} people" (page loader) |
| `chargeCodeAccess` | ✓ | (submitters + admins with a chargeable code) > 0 (P3) | "{w} of {m} people can charge a direct code" + non-blocking names note (page loader) |
| `indirectCodes` | | active available-to-all > 0 | count |
| `laborCategories` | | active > 0 | count |
| `connection` | | an `integration_connections` row with `is_active` true and `disconnected_at` null (`schema.ts:543-561`) | provider name |

- `isComplete` = all six required done.
- `requiredDone` / `requiredTotal` replace `done` / `total`.
- **Callers:** update `home.ts`, `attention.ts` (title "Finish setting up: {requiredDone} of 6 done", hints keyed by the new keys, link `/settings/setup`). Grep for other `isComplete` / `steps` consumers.
- **Count queries:** fold the new checks into **one SQL statement of scalar subqueries**:
  - workweek set;
  - pay config row exists;
  - timesheet data exists;
  - connection exists;
  - active CLINs without a code;
  - admins with a chargeable code.

  Run it alongside the existing 7 counts, so ≤ 8 parallel queries (pool max 10, `db/index.ts:33`). The gaps (2 queries) and settings are page-only.
- **Rewrite `setup-status.test.ts`.** Its fake DB matches results by table, so the new statement needs a redesigned fixture. Keep the C17 "no names in `SetupStatus`" assertion.
- **Type `SETUP_STEP_HINT` as `Record<SetupStepKey, string>`**, so a missing key fails tsc.
- **Home:** while setup is incomplete, drop the separate "Payroll workweek isn't set" item (`attention.ts:155`), because setup covers it. Remove the now-redundant `workweekStartDayInternal` call (`home.ts:44`) if nothing else uses it.

### 3.2 Server: P6
In `updatePayPeriodConfig`, the "already your pay schedule" refusal applies only when a `pay_period_config` row exists. With none, saving the default config inserts it as immediate (`effectiveFrom` '1900-01-01', same path), subject to `workspaceHasNoTimesheetData`.

### 3.3 Page
- **Route** `/settings/setup` (`page.tsx` metadata title 'Setup checklist', `requirePageRole('admin')`), with `PageHeader title="Setup checklist"` (`page-metadata.test.ts`).
- **`SETTINGS_NAV`:** "Setup checklist" first; nav tests updated (the "`/admin/setup` is in no menu" assertions change to "`/settings/setup` is the first settings item").
- **Redirect** `/admin/setup` → `/settings/setup`; `route-moves.test.ts`.
- **Layout** (mockup):
  - progress panel: "{requiredDone} of 6 required steps done" with a bar (`aria-hidden`; the text carries the value), plus "{3 − recommendedDone} recommended steps below.";
  - an info notice: "Have a spreadsheet? Import people, contracts, CLINs, labor categories, charge codes and access in one go." → `/settings/import`;
  - a required list, then a "Recommended" h2 list.
- **Each step** is a list item:
  - a status dot (✓ done, number, or partial);
  - an h3 title and its detail;
  - a badge (Done / Required / "{w} of {m}");
  - one action.
  - The first not-done required step gets the "now" tint.
- **Actions:**
  - **Time zone and workweek** (P5 inline):
    - a Time zone select (current, pre-selected);
    - **"Workweek starts on (FLSA overtime)"** (no default), with the help line "Overtime is worked out per workweek." (the Workspace page's wording);
    - "Save" calls `updateWorkspaceTimezone` only if the time zone changed, then `updateWorkweekStartDay`. Validate on click ("Choose the day the workweek starts.");
    - **on any outcome, refetch the status**, so a partial save (time zone saved, workweek failed) retries correctly;
    - when it's done or has timesheet data: "Change on Workspace".
  - Pay schedule (P5 inline):
    - "Pay periods" (Every week / Every two weeks / Twice a month / Once a month);
    - for weekly / biweekly, "First period starts" (DateInput) and **"Pay weeks start on"** (pre-filled from the saved workweek; the anchor must fall on that day; validated inline with the server's message);
    - for twice a month and once a month, send the default anchor (`2026-01-01`) and week start (1), which `parseScheduleInput` requires and ignores for those types;
    - "Save pay schedule" → `updatePayPeriodConfig({ …, effectiveFrom: null })`.
    - Otherwise: "Change on Pay schedule".
  - Contracts and CLINs: "Open Contracts".
  - Charge codes: "Create codes from CLINs…" opens the existing `CreateFromClinsModal` (reused from Part 1), or "Open Charge codes".
  - People: "Add people" (to Users) or "Open Users".
  - Charge code access: "Give access" → `/admin/assignments`. The partial detail names up to 20 people, then "and {n} more".
  - Recommended: links to Charge codes (Indirect tab), Labor categories, Integrations.
- **Complete state:** a success `Notice` above the list, "Your workspace is set up. People can record time." The list stays.
- **Busy:** buttons use `useBusy` (no `loading`). After a save, refetch the page data into state.
- **Focus:** when a save completes a step, its form unmounts. Focus that step's h3 (`tabIndex={-1}`) and announce "{step} saved" in a polite status region, so focus never drops to `<body>`.
- **Delete `admin/setup/SetupWizardClient.tsx`** and replace its tests.

## 4. Import
### 4.1 Route, nav, layout
- **Page** `/settings/import`, title "Import" (metadata + `PageHeader`); `?type=` (default `people`; invalid → `people`).
- The client reads `type` from `useSearchParams` and switches with `replaceState`.
- **Redirect** `/settings/migration` → `/settings/import?type=hours`. Keep the old `/admin/migration` → `/settings/migration` chain working: update it to point straight at `/settings/import?type=hours`.
- **Nav:** "Import" replaces the two items. Update links to `/settings/migration` (`MigrationClient` copy goes away).
- **Layout:**
  - **Left, a type list:** "Set up, in this order" (1–7), then "Past timesheets" (8–9). Each item shows its number, label, and a ✓ with the count of existing records (people, contracts, CLINs, labor categories, chargeable codes, people with access, scopes) or "New" for types 5 and 6. Counts come from the setup status loader (reused) plus a scope count.
  - **Right, the pipeline** for the selected type: steps "Choose a file → Check rows → Import → Done" (shown as a non-interactive progress row with `aria-current`).

### 4.2 The pipeline (setup types 1–7)
1. **Choose a file:**
   - a panel with the type title, its columns ("Columns: … ; optional …"), "Download template", and the existing accessible `FileInput` ("Choose a CSV file").
   - **Parse** with `parseCSV` using the type's **required** columns only. A missing column → "This file is missing required columns: …".
   - **Over the size limit** (P13) → an inline error; nothing is sent.
2. **Check rows** (automatic after parsing):
   - call the type's action with `dryRun: true` and every parsed row (client parse errors are included as rows marked with that error and never sent);
   - show "{r} rows are ready. {p} rows have problems and won't be imported unless you fix them in the file and choose it again." (warn notice) or "All {r} rows are ready.";
   - **"Download rows with problems"** (client CSV: the original columns + "Problem", via `generateCsv`);
   - **table:** Row, the type's key columns, and Result. Problems are listed first (red text, a red left edge), then "Ready" / "Will be skipped: {reason}". Show the first 50 ready rows, then "…and {n} more ready rows. Show all.";
   - "Choose a different file".
3. **Import:** the button "Import {r} {type noun}" (validate on click: no ready rows → "Nothing to import. Fix the rows with problems first."). It sends **the ready rows** (`dryRun: false`).
4. **Done:**
   - "{created} imported · {skipped} skipped · {errors} problems", with a problems table if any (data changed since the check);
   - for People, the existing generated-passwords modal opens (Copy / Download / "I've saved the passwords"), plus a "View generated passwords" button;
   - "Import another file".

### 4.3 Server
- **Dry-run helpers** in `src/server/internal/import-run.ts`. **No wrapper owns the transaction**, so each action keeps its own `db.transaction(async (tx) => { await lockUserRulesExclusive(tx); …` where it locks, as the lock-first test requires (`user-rules-lock.test.ts:27-46`):
  - `throwIfDryRun(dryRun, value)`: the **last** statement of the transaction body. It carries the body's **full return value**: `{ result, rerouted: [] }` for People and scope, `ImportResult` for the others.
  - `catchDryRun<T>(p: Promise<T>): Promise<T>`, used outside the transaction: it returns the carried value (stripping `generatedPasswords` from the `ImportResult` inside it), and rethrows anything else. So a dry run and a real import return the same shape.
  - **Approval scope:** `scopeChange(db, fn, { dryRun })` (the real signature from `approval-scope` is `scopeChange(db, fn)`) calls `throwIfDryRun(opts.dryRun, { result, rerouted: [] })` after its second snapshot.
  - Notifications run only when `!dryRun`, after commit.
  - **Static test:** each setup import action contains `catchDryRun(`, plus either `throwIfDryRun(` or `scopeChange(` with `dryRun`. Without `catchDryRun`, every check would become a generic error plus a Sentry event.
- **Everything per row runs inside that row's savepoint**, `tx.transaction(async (sp) => …)`: lookups, validators and inserts. postgres-js records **any** failed query on the outer scope and throws it at the end, even if caught (`index.js:262-263, 290-291`). Only batch-level statements (lock, seat check, snapshots, recompute) touch `tx` directly. `bulkImportEmployees`' existing lookup outside the savepoint (`import.ts:72`) moves inside.
- **`importRowMessage` on a dry run** doesn't report to Sentry (pass a flag), to avoid one event per bad row on every check.
- **Results:** `ImportResult` gains `skippedRows: { row, reason }[]` (filled by every action) next to `errors`. The client builds the check table from both and sends only ready rows.
- **People** (`bulkImportEmployees`):
  - keeps its lock, seat check and logs; adds `dryRun`. The seat check counts only rows that pass validation (P12), so rejected rows can't refuse the batch for seats;
  - P12 role and FLSA validation ("Role must be Employee, Supervisor or Admin.", "Overtime (FLSA Exempt) must be Yes or No.");
  - existing email → skipped ("Already a user");
  - email checked with `validateEmail`;
  - no notify on dry run.
- **Contracts, CLINs, labor categories:** **extract the create actions' validation** into internal validators used by both the action and the import:
  - `validateContractInput` (from `createContract`, `contracts.ts:64-73`: `validateContractNumber`, lengths, money);
  - `validateClinInput` (from `createClin`, `clins.ts:28-30`: **the contract must be active**, `validateClinNumber`, `validateMonetaryValue`);
  - `validateLaborCategoryInput` (from `createLaborCategory`, `labor-categories.ts:117-124`: lengths, `validateRate`).

  Then:
  - **Contracts:** required Contract Number and Name; optional Type, Funded Value, Ceiling Value, Start Date, End Date (blank → null). An existing number → skipped.
  - **CLINs:** required Contract Number and CLIN Number; optional Description and Funded Amount. An existing CLIN → skipped.
  - **Labor categories:** required Contract Number, CLIN Number, LCAT Code, Title and Hourly Rate; optional Ceiling Rate. An existing LCAT code on that CLIN → skipped.
- **Charge codes (new) `bulkImportChargeCodes`:**
  - required Code, Name, Contract Number, CLIN Number;
  - optional SLIN Number, Labor Category (LCAT code), Location, Billable, Description.
  - **Extract the `createChargeCode` action's validation** into `validateChargeCodeInput(tx, input)` in `internal/charge-codes.ts`, used by both. It takes **typed** values (`workLocation` enum or null, `billable` boolean, `laborCategoryId` or null) and covers:
    - code / name / description lengths;
    - the active CLIN;
    - SLIN-on-CLIN;
    - **new:** the `workLocation` enum, and `categoryFitsCode` when a category is given.
  - **The import parses its strings first:**
    - Location (onsite / telework / other, case-insensitive; blank → null);
    - Billable (Yes / No; blank → true);
    - Labor Category, resolved by (the code's CLIN, LCAT code, active); codes are unique per CLIN (`clin_lcat_unique_idx`, `schema.ts:217`). Then `categoryFitsCode` (SLIN rules). No match → "Labor category "X" isn't on CLIN 0001.".
  - An existing code string → skipped ("Code already exists").
  - Insert via `createChargeCodeInternal`.
- **Charge code access (new) `bulkImportChargeCodeAccess`:**
  - required Email and Charge Code;
  - the user must exist and be active; the code must exist and match `CHARGEABLE_CODE` ("{code} can't be charged right now.");
  - already actively held → skipped;
  - else `assignChargeCodeToUserInternal(sp, …)`.
- **Approval scope:** `bulkImportAssignments` (from `approval-scope`) gains `dryRun` (no notify on dry run). It's labelled "Approval scope" in the UI.
- **Every setup import action:** `requireAdminFresh` first; the per-type row limit (P13, server re-check); returns `ImportResult` with spreadsheet row numbers and `skippedRows`.
- **The limit constants live in `src/lib/import/limits.ts`**, not in the `'use server'` `import.ts`.
- **Strict numbers (P12):** the import parses money and rates **before** the shared validators, which use `parseFloat` (`validation.ts:95-124`), so "12,500,000" would become 12.00.
  - Money accepts only `^\d{1,9}(\.\d{1,2})?$`; rates `^\d{1,4}(\.\d{1,2})?$`.
  - Otherwise: "{Column} must be a plain number (for example 1250000.00)." (precedent: `parseImportHours`, `import-plan.ts:33`).
- **Invalid characters:** a shared per-cell check `/[\u0000-\u0008\u000b-\u001f\u007f]/` marks the row "Row {n} contains an invalid character." (pattern: `timesheet-notes.ts:22`).
  - It runs in the browser parse **and** on the server **before any batch-level query** (the People seat-check query, `import.ts:53-55`, would otherwise abort the transaction). This covers all seven setup types.
- **Add the new actions** to the fresh-admin-writes lists.
- **New read `getImportWindowStatus()`:** `requireAdmin`, read-only allowlist; returns `{ open }`.

### 4.4 Hours and Timesheet status (types 8–9)
- The existing migration flow, re-skinned into the same pipeline:
  - "Source system" (required) above the file chooser;
  - Check rows = `validateMigration*` through `runMigrationBatches`;
  - Import = `importMigration*`.
- The window status (P14 copy) is shown at the top. When closed, the Import button is `aria-disabled` with that reason. `getImportWindowStatus` lives in `src/server/actions/migration.ts` (`ADMIN_READ_ONLY_ALLOWLIST` entry).
- **Header check:** add a header-only option to `parseCSV` (`headerColumns`: the columns that must be present, not necessarily filled). Hours rows leave either Contract/CLIN or Indirect Code blank, and status rows leave the Reviewed columns blank. Keep sending **every** row, so the file-row maths in `runMigrationBatches` stays correct.
- **P15 notice** when no pay config row exists.
- Batch messages are unchanged.

### 4.5 Templates
- **Update to match P12** (optional columns stay in the header with example values): people, contracts, CLINs, labor categories.
- **Add** `charge-code-import-template.csv` (Code, Name, Contract Number, CLIN Number, SLIN Number, Labor Category, Location, Billable, Description) and `charge-code-access-import-template.csv` (Email, Charge Code), using the demo examples.
- The approval-scope template comes from `approval-scope`.

## 5. State: the import pipeline (client)
| State | Event | Next |
|---|---|---|
| empty | choose a file → parse OK, within limits | checking (dry run in flight, `aria-busy`) |
| empty | parse fails / too big / missing columns | empty + inline error |
| checking | result | checked |
| checking | action error (network, guard) | empty + error Alert (file kept, "Check again") |
| checked | Import (ready > 0) | importing |
| checked | choose a different file | empty |
| importing | result | done (+ passwords modal for People) |
| importing | error | checked + error Alert (nothing assumed imported) |
| done | Import another file | empty |
| checking | change type | empty (a request token drops the late result) |
| importing | change type / choose a different file | **blocked**: the type list and the button are `aria-disabled` with the reason "Wait for the import to finish." (a People import's passwords must never be lost) |

## 6. Failure modes
| Operation | Failure | Behaviour |
|---|---|---|
| Dry run | a row throws a DB error | its savepoint rolls back; the row is reported; the run continues; then everything rolls back |
| Dry run | the sentinel isn't caught | `catchDryRun` wraps every action's transaction; the static test enforces it |
| Import after check | data changed in between | the import reports its own row results (the check is advisory) |
| People import | over seats | the whole batch is refused with the seat message (also in the dry run) |
| People / Approval scope | lock held during the dry run | ≤ 1,000 rows, short; acceptable |
| Import | double click | `useBusy` |
| Hours | window closes between check and import | the existing refusal message |

## 7. Platform limits
- Setup imports: ≤ 1,000 rows (scope 500), ≤ 800 KB per request (under the 1 MB default). A dry run plus an import is two requests.
- postgres-js never releases savepoints (`index.js:257-279`), so a 1,000-row run nests 1,000 subtransactions. That's acceptable at this cap, which stays.
- Migration batching is unchanged.
- The setup status runs at most 10 parallel counts.

## 8. Blast radius
- **Setup:**
  - `internal/setup.ts`, `actions/setup.ts`, `pay-period-config.ts`;
  - new `settings/setup/page.tsx` + client; delete `admin/setup/*`;
  - `home.ts`, `attention.ts`, `home-page.test.tsx`, `setup-wizard.test.tsx` (replace), `setup-status` (unit + integration), `home-data.test.ts`, `pay-period-config-save.test.ts`.
- **Import:**
  - `import.ts`, new `internal/import-run.ts`, `internal/charge-codes.ts` (validator), `actions/charge-codes.ts` (uses the validator);
  - `ImportClient.tsx` (rebuilt), delete `settings/migration/*` (page + client);
  - templates;
  - tests: `import-row-errors`, `import-row-status-keys`, `import-duplicate-errors`, `migration-client` (rewrite against the new page), `bulk-import-seat-limit`, `duplicates-and-import-errors`, `charge-code-actions-validation`, the fresh-admin-writes lists, `user-rules-lock` (people / scope still lock first), `server-action-guards`.
- **Nav and routes:** `nav-config.ts`, `nav-config.test.ts`, `page-metadata.test.ts` (page count 32 → 31), `next.config.ts`, `route-moves.test.ts` (add `/admin/setup` and `/settings/migration` to its stale-link scan), `billing-ui.test.tsx` (settings nav assertion).
- **Icons:** drop `ImportClient.tsx` from `ICON_IMPORT_ALLOWLIST` (`icon-registry.test.ts:23`) if the rebuild uses only the registry. The new "Setup checklist" leaf needs an icon key. Add a new icon (`IconListCheck`) or an `ICON_ALIASES` entry with a reason. Remove `historyImport` if unused. `icon-registry.test.ts:27,29` lists `MigrationClient.tsx` / `SetupWizardClient.tsx` and must drop them.
- **Also touched:**
  - `copy-returned.test.ts:15` (reads `MigrationClient.tsx`);
  - `server-action-guards.test.ts` (`getSetupAccessGaps` replaced by `getSetupPageData`; `getImportWindowStatus` added);
  - `users-admin-actions.test.ts:244` and `users-ux4c.test.ts:158-160` (FLSA now required in imports);
  - `dated-rates-d1.test.ts:281-283` (row numbers, transactions);
  - re-check `approval-decisions.test.ts:451`, `guard-first-oracle.test.ts:60` and `authorization.test.ts:242`.
- **Validators extracted:** `contracts.ts`, `clins.ts`, `labor-categories.ts`, `charge-codes.ts`, with their existing tests.

## 9. Test matrix
Each row must fail without its change.

| # | Scenario | Kind |
|---|---|---|
| SU-1 | Setup steps: workweek null → `timeAndWeek` not done; set → done | unit |
| SU-2 | Pay schedule step done by a config row **or** timesheet data; not done otherwise | integration |
| SU-3 | Charge code access done when anyone is covered; w < m shows the non-blocking names note | integration |
| SU-4 | `isComplete` false while any required step isn't done (e.g. workweek unset with everything else done); true with an indirect-only person uncovered | integration |
| SU-5 | P6: a new workspace with no row and no timesheet data saves the default schedule immediately (row inserted) | integration |
| SU-6 | Inline forms shown only when not done and no timesheet data; otherwise the link | unit |
| SU-7 | `/admin/setup` redirect; Settings nav first item; title = label | unit |
| SU-8 | Home card: "{requiredDone} of 6", the link to `/settings/setup` | unit |
| IM-1 | `dryRun: true` writes nothing for each of the 7 setup types (counts before = after; no `admin_change_log` rows; no passwords in the result) | integration |
| IM-2 | Dry-run results equal the real import's results on the same data (each type) | integration |
| IM-3 | A row with a forced DB error → that row reported, the others imported (contracts, CLINs, labor categories now transactional) | integration |
| IM-4 | Row numbers are spreadsheet rows (row 2 = first data row) including after client-side skips | unit + integration |
| IM-5 | People: unknown role → error; FLSA "maybe" → error; existing email → skipped | integration |
| IM-6 | Contracts: blank optional columns accepted; Type "joint" → error | integration |
| IM-7 | Charge codes: SLIN not on CLIN, inactive CLIN, bad Location, Labor category not on the CLIN → errors; existing code → skipped; success inserts | integration |
| IM-8 | Charge code access: inactive user, non-chargeable code → errors; already held → skipped; success creates the access (and the membership row) | integration |
| IM-9 | Over 1,000 rows refused in the browser and on the server | unit + integration |
| IM-10 | "Download rows with problems" contains the original columns + Problem, formula-guarded | unit |
| IM-11 | Pipeline states per §5, including "change type drops a late result" | unit |
| IM-12 | Hours: window closed → shown up front and Import aria-disabled with the reason; a missing header caught in the browser | unit |
| IM-13 | `/settings/migration` → `?type=hours`; nav has one "Import" item | unit |
| IM-14 | The shared charge-code validator: `createChargeCode` and the import both refuse a bad Location with the **new message** (not a Postgres enum error), and `createChargeCode` now refuses a labor category that doesn't fit | integration |
| IM-21 | "1,000,000" as Funded Value → refused with the plain-number message (no 1.00 saved); a rate "1,450.00" refused | integration |
| IM-22 | A NUL in a People email → that row errors in both the check and the import; the other rows proceed | integration |
| IM-15 | A NUL byte in a lookup column: the dry run and the real import both report that row only; the other rows succeed in both | integration |
| IM-16 | `skippedRows` lists existing records with reasons; the Import button counts only ready rows | unit + integration |
| IM-17 | CLIN import onto an inactive contract refused (shared validator); contract number validator applied | integration |
| IM-18 | Approval scope file of 501 rows refused in the browser and on the server | unit + integration |
| IM-19 | While importing, the type list is `aria-disabled`; a People result with passwords is never dropped | unit |
| IM-20 | Hours: a file missing a required header is refused in the browser; rows with a blank optional cell are still sent and numbered correctly | unit |
| SU-9 | Admin-only workspace: an admin with a chargeable code completes People and Charge code access | integration |
| SU-10 | Pay schedule P6: a future date with no row is still refused; with a pending-only row, an immediate default save **cancels the pending change (C7) and inserts nothing** | integration |
| SU-11 | After an inline save completes a step, focus is on that step's heading | unit |
| SU-12 | P15 notice shows on Hours when no pay config row exists | unit |

## 10. Verification
- **Dev:** `npx tsc --noEmit`, `npm run lint`, `npm run test`, `npm run test:tz`, `npm run db:safety` (no migration expected).
- **Product owner:**
  - integration;
  - build plus checks;
  - `npm run demo:local`;
  - the lead's break-it.
- **Browser:**
  1. On a **new throwaway local workspace**, the checklist starts at 0 of 6. Set the time zone, workweek and pay schedule inline; import people, contracts, CLINs and charge codes from the templates; give access by import. The checklist reaches 6 of 6.
  2. On acme (has timesheets), the settings steps show links, not forms.
  3. A file with a bad row: Check rows lists it; Download rows with problems; Import imports the rest.
  4. The Hours type shows the window status.

## 11. Hand-off and commit order
- `BLUEPRINT-STANDARD.md` §3. Don't push.
- **Commits:**
  1. setup server + P6;
  2. the Setup page, nav, redirect, Home;
  3. dry-run helpers (`throwIfDryRun` / `catchDryRun`) + transactional imports + P11 / P12;
  4. new import types + the shared charge-code validator;
  5. the Import page (pipeline, Hours / Timesheet status), templates, redirect, nav;
  6. remaining tests.

## 14. Pre-mortem record
**Round 1 (2026-11-10)**, two reviewers (Setup; Import). 0 HIGH, 15 MEDIUM, all applied:
- `workspaceHasNoTimesheetData` moves to internal (it would have been an unguarded endpoint);
- a lean `SetupStatus` (no names, ≤ 8 queries) plus a page-only loader;
- admin-only workspaces can complete;
- P6 scoped to the immediate path with no row;
- P15: confirm the pay schedule before Hours;
- distinct FLSA and pay-week labels;
- focus after an inline save;
- the blast radius (icons, copy and guard tests, page count, fake DB);
- the dry run keeps each action's own transaction (lock-first test, `scopeChange`, notify);
- everything per row inside its savepoint (postgres-js scope errors);
- `skippedRows`;
- per-type row limits (scope 500);
- no type change while importing;
- extracted contract, CLIN and labor-category validators;
- `parseCSV` header-only for Hours.

**LOW, applied:**
- the Workspace workweek item dropped while setup is incomplete;
- the connection table named;
- the pay inputs for semimonthly and monthly;
- the stale-link scan;
- `SETUP_STEP_HINT` typed;
- the row-number definition;
- the payload measured by `serializedBytes`;
- seats counted after validation;
- no Sentry on dry runs;
- window status null-safe, with corrected copy;
- the typed charge-code validator.

**Round 2 (2026-11-10)**, one fresh reviewer. 0 HIGH, 5 MEDIUM, all applied:
- the dry-run helper contract is unified (no `runImport`; full return value carried; scope via `scopeChange` options; a static test for `catchDryRun`);
- strict money and rate parsing (no `parseFloat` comma truncation);
- the control-character check before batch queries;
- charge code access doesn't block completion (indirect-only staff), with a names note;
- SU-10 matches the C7 cancel behaviour.

**LOW, applied:**
- LCAT resolution by CLIN and code;
- IM-14 asserts the new messages;
- consistent window copy;
- the icon allowlist, the window-status location, and duplicates as skipped;
- the savepoint note.
