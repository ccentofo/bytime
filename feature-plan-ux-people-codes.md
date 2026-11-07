# Blueprint UX-4c Part 1: Assignments, Charge codes, Users, Audit trail

> **Status:** v3 FINAL, 2026-11-06, lead architect. Pre-mortem rounds 1 and 2 are applied (§14). The two-round limit is reached; the code audit catches the rest.
>
> **Branch:** `ux-people-codes`, cut from `main` at `ec30654` or later. It uses the UX-4b kit:
> - `StatusBadge` / `STATUS`, `Notice`, `PageHeader`;
> - `formatHours` / `formatCount`, `numericColumn`;
> - `useAppTable` (`expandable`, `emptyState`, `compact`, `hairline`);
> - `useBusy`, `WriteButton`, `toastError` / `toastSuccess`, `ConfirmModal`;
> - `resolvePeriodRange`, `downloadFile`.
>
> **Approved design:** `ux-mockups/ux4-batch2a.html` (Assignments, Charge codes, Users, Audit trail). Match it except where §0 says otherwise.
>
> **Product-owner direction** (`UX-4-AUDIT.md` §9–§10): polished, usable and professional, **not overengineered**. The Admin changes tab, the admin two-step reset and the audit CSV are in.

---

## 0. Lead rulings (no product decisions)
| # | Ruling |
|---|---|
| R1 | **Charge codes and Indirect codes become one page**, `/admin/charge-codes?tab=direct\|indirect` (default `direct`; invalid → `direct`). `/admin/indirect-codes` redirects (307) to `/admin/charge-codes?tab=indirect`. The nav loses "Indirect codes". |
| R2 | **Cut from the mockup (lean):**
  - the "Group by charge code" view (Charge codes already shows People per code);
  - "Show removed access" / Restore (Give access re-grants; the upsert reactivates);
  - the labor-category gap line;
  - SLIN in Approval scope (`canApprove` matches by CLIN only, `approval-rules.ts:95-105`);
  - the "2nd time" event note;
  - People as a link. |
| R3 | **"Changed" = revision ≥ 2 everywhere** on the Audit trail (switch, count, row edge). **"Late" uses the same row rule as Approvals** (`period-flags.ts:43`, `flagged-cells.ts:54`): `revision_number = 1 AND source = 'app' AND change_reason_code IS NOT NULL`.
  - The Audit trail counts **rows**. Approvals counts a cell as late only if it was never later corrected (`period-flags.ts:57`), so the two numbers can differ by design.
  - The summary and list share one filter builder (§6.2). |
| R4 | **Reason labels are UI-only** (research: no PDF, CSV or API uses them). Edit the labels in `REASON_CODES` (`reason-codes.ts:1-7`; `REASON_LABELS` derives from it):
  - Correction
  - Late entry
  - Transfer between accounts
  - Supervisor-directed change
  - Other
  - `MIGRATION` stays "Imported"

  `ReasonModal` already requires a comment for every reason (`ReasonModal.tsx:46`), so no extra hint is needed. The audit CSV writes the **raw code**. |
| R5 | **More admin change logging**, each in the same transaction as the change; entity `user`:
  - `updateUser`:
    - `role_changed` {role}
    - `deactivated` / `reactivated`
    - `flsa_changed` {flsaExempt}
  - `adminResetPassword`: `password_reset`
  - new `adminResetMfa`: `mfa_reset`
  - `createUserWithPassword` and `bulkImportEmployees`: `created` {role, flsaExempt}

  `createUser` (`users.ts:28`) has no app caller. Delete it and its tests (grep first). |
| R6 | **Admin two-step reset:**
  - it needs the **acting admin's current password** (`verifyCurrentPassword`, like self-service P3, `mfa.ts:37-41`);
  - it can't target yourself ("Use your profile to turn off two-step sign-in.");
  - it bumps the session. That signs the user out **within about a minute**: the session version is re-checked at most every 60 s (`auth.ts:221-227`).
  - There's no workspace two-step requirement (`auth.ts` asks for a code only when `totp_enabled`). |
| R7 | **Create user:**
  - overtime status is required (no default);
  - `createUserWithPassword` now runs `validatePassword` (it doesn't today; `users.ts:197`);
  - the email check stays `validateEmail` (`users.ts:206`);
  - a duplicate email already becomes a friendly `conflict` through `userAction` (`action-result.ts:43`); no new mapping. |
| R8 | **Approval-scope behaviour is unchanged, but made visible** (round 2: changing it narrows supervisor report, audit and filter visibility, which is a policy change). Giving any user a code still upserts their CLIN row (`internal/charge-codes.ts:63-68`), and for a supervisor that grants approval over employees on that CLIN (`approval-rules.ts:102`). The UI now says so:
  - Give access warns when the person is a supervisor (§4.2);
  - Approval scope lists every active supervisor CLIN row, whatever created it (§4.4);
  - the Remove confirm says a later code grant on that CLIN restores it;
  - the role-change-to-supervisor confirm points to Approval scope (§5.2).

  **Recorded follow-up for the product owner:** should charging a CLIN ever grant approval scope? |
| R9 | The QuickBooks auto-send switch is Part 2 and stays hidden (`UX-4-AUDIT.md` §10). |

## 1. Verified current state
### 1.1 Charge codes (`src/server/actions/charge-codes.ts`, `src/app/(app)/admin/charge-codes/`)
- **Page** (`page.tsx:16-59`): `requirePageRole('admin')`; `?code=` auto-opens the category modal. Loads: `listChargeCodes()`, `listCostClasses()`, the active contract×CLIN join and `getAllLaborCategories()`.
- **`listChargeCodes()`** (41-84): code fields, `clinNumber`, `slinId`, contract name and number, the starting `laborCategoryId`, class, `workLocation`, `billable`, `isActive`, `hasHours`, `categoryChanges`. It has **no** CLIN, contract or SLIN status, no CLIN description and no SLIN number. It is also used by Assignments.
- **Client state:** `ChargeCodesClient.tsx:91` keeps `codes` in `useState` and refreshes with `refreshCodes()` (:109-112).
- **`createChargeCode`** (86-92 → internal:30-43): trim only.
- **`updateChargeCode`** (94-146): allowlist; `FOR UPDATE`. A CLIN or SLIN change is refused when hours exist (127-134) or categories exist (135-141). It doesn't check that the SLIN belongs to the CLIN, and doesn't trim `code`.
- **Deactivate / reactivate** (152-210): `logAdminChange`.
- **`autobridgeChargeCodesFromClins()`** (314-347):
  - qualifying CLINs: active CLIN and contract, with no code;
  - code `${contractNumber}-${clinNumber}`; name = description or "{contract} / {clin}";
  - no transaction; `onConflictDoNothing`, but `created++` counts even a skipped row.
  - `charge_codes.code` is globally unique, varchar(100) (`schema.ts:255`).
  - **Caller:** `SetupWizardClient.tsx:231-234` (prints `total`).
- **Helpers:** `chargeCodeCategoryOn(schedule, day)` (`lib/labor-rates.ts:147-153`); `CHARGEABLE_CODE` (`internal/chargeable.ts:12-17`).

### 1.2 Indirect codes
- **Actions** (`actions/indirect-codes.ts`): validated create and update (a leave code needs a pay type; `isActive` is settable); `seedIndirectCodes` (a no-op if any exist).
- **Payroll blocking:** Payroll export blocks on **any** leave code with hours and no pay type, active or not (`payroll-data.ts:116`). It links to the indirect page (`PayrollExportClient.tsx:284`).

### 1.3 Assignments
- **Page:** `page.tsx:21-41` runs ten parallel loads, the pool maximum; `getUsers` is one of them.
- **Tabs:** `?tab=` via `assignments-params.ts`. A tab switch drops the filters (`AssignmentsClient.tsx:146-149`).
- **Client state:** the client reads its tab from `useSearchParams` (141-144) and keeps `ccAssignments` / `assignments` in state, refreshed by re-calling actions.
- **`assignChargeCodeToUserInternal(executor: TenantWriter, …)`** (`internal/charge-codes.ts:49-69`): upserts `user_charge_codes` (reactivates) and `user_assignments` (any role; R8). No active checks; returns void.
- **`assignAllUnderClin`** (actions:243-265). **`assignUserToClin`** (`actions/assignments.ts:60-85`): one caller (`AssignmentsClient.tsx:323`); takes `slinId`. The import writes `user_assignments` directly (`import.ts:329`).
- **Labor categories:** overlaps via the pure `findOverlaps(rows)` (`internal/cost-basis.ts:310`, keyed by user + SLIN-or-CLIN).
- **Approval** (`approval-rules.ts`): `canApprove` (95-105) requires an active actor:
  - an admin approves anyone;
  - a supervisor approves anyone they're the `effectiveDesignee` for (`:69`; only supervisor or admin users have approvers), or employees sharing an active CLIN.

### 1.4 Users
- **`getUsers()`** (`users.ts:22`): `requireAdmin`, `SAFE_USER_COLUMNS`. Also loaded by Assignments.
- **`updateUser`** (:77):
  - lock order: `lockUserRulesExclusive`, then admin rows `FOR UPDATE` (144-148);
  - reads the target only in some branches (138-160);
  - session bump on a role or isActive change;
  - no change log.
- **`createUserWithPassword`** (:197): `validateEmail`; no `validatePassword`; no FLSA input.
- **`setUserApprover`** (:236): logs `approver_changed`. **`unlockUserAccount`** (:57): inserts a success row (`login-attempts.ts:160`). The `getDbForAuth` allowlist (`write-gate-boundaries.test.ts:38-40`) applies.
- **Lockout** (`login-attempts.ts:25-75`):
  - email only;
  - failures in 15 minutes, newer than the latest success, ≥ 5;
  - `minutesRemaining` = dayjs `diff` (truncated); locked only while `> 0`.
  - `login_attempts` has no email index (`schema.ts:102-108`).
- **MFA:** `disableMFA` (`mfa.ts:91`): self, password, no session bump. No admin path.
- **`adminResetPassword`** (`password.ts:106`, `getDbForAuth`): `validatePassword` (local, 8–128); read-then-write session bump; no log.
- **Guards:** `server-action-guards.test.ts:210, 227` (read-only allowlists) and `write-gate-boundaries.test.ts`.

### 1.5 Audit trail
- **Guard:** `requireApprover()`. Scope: `getEmployeeScope` (`session.ts:129`).
- **`getAuditEntries`** (`audit.ts:121`):
  - joins clins and contracts; the contract filter is `eq(contracts.id)` (158-160, 196-197);
  - `LIMIT AUDIT_ROW_LIMIT+1`.
- **`getAuditSummary`** (:385): no joins, no filters. COUNTs are `sql<number>` without `mapWith` (strings from postgres-js).
- **`getAuditPeriodEvents`** (:314): also uses `AUDIT_ROW_LIMIT` and `truncated` (344, 358-359); the UI shows a notice (`AuditTrailClient.tsx:457`).
- **Existing row style:** `tr[data-correction='true'] > td:first-child` with `--audit-correction-edge` plus `--audit-correction-bg`, asserted by `audit-correction-contrast.test.ts`.
- **`timesheet_entries` indexes** all start with `user_id` (none on `created_at` or `entry_date`).
- **`admin_change_log`** (`schema.ts:453-464`):
  - free-string entity and action;
  - sole writer `logAdminChange(tx: TenantWriter, row)` (static test).
  - Actual (entity, action) pairs:
    - `self_approval` / enabled · disabled (computed; `entity_id` = admin user; `approval-rules.ts:181-185`)
    - `charge_code` / deactivated · reactivated
    - `workspace_settings` / workweek_start_day_changed
    - `charge_code_labor_category` / category_change_added · category_corrected · category_change_removed (`entity_id` = charge code; `charge-code-categories.ts:29`)
    - `user` / approver_changed
    - `labor_category_rate` / rate_change_added · rate_corrected · rate_change_removed (`entity_id` = labor category; `labor-category-rates.ts:27`)
- **Report route pattern:** `cost-report-csv/route.ts` **buffers** (:54). Vercel limits a **buffered** response to 4.5 MB; streamed responses are exempt (`feature-plan-terms-compliance-fixes.md:48`).
- **CSV escaping:** `escapeCsvField` (`src/lib/csv/escape.ts`) handles the formula guard.

### 1.6 Links and tests touched
- **Callers of `autobridgeChargeCodesFromClins`:** `SetupWizardClient.tsx:231-234` and `ChargeCodesClient.tsx:205` (both read `.total`).
- **Links to `/admin/indirect-codes`:** `SetupWizardClient.tsx`, `MigrationClient.tsx:293`, `PayrollExportClient.tsx:284` (its text "Indirect Codes"), and the tests `row-state.test.tsx:57`, `migration-client.test.tsx:70` and `indirect-codes-row-actions.test.tsx:21`.
- **Nav:** `nav-config.ts:17-56` and `nav-config.test.ts:13-44`. Redirects: `next.config.ts:63-81`; redirect tests in `route-moves.test.ts`.

## 2. Invariants
1. **DCAA:** no change to `timesheet_entries`, `period_events` or the period lock. `admin_change_log` is written only by `logAdminChange`.
2. **Security:**
   - every action guards before any query;
   - writes use `requireAdminFresh`;
   - reads use `requireAdmin` / `requireApprover`, and every new `requireAdmin` read joins `ADMIN_READ_ONLY_ALLOWLIST`;
   - supervisor audit scope applies to every new audit read and to the export;
   - **no TOTP secret or recovery codes reach the browser**;
   - no raw IP is read.
3. **Session bumps** are written in SQL (`users.sessionVersion + 1`).
4. **Workspace timezone** for every "today" and range. The page passes `workspaceToday` to clients; clients never use the browser's date.
5. **The focus rule:** no `disabled` or `loading` on focusable buttons.
6. **No `light-dark()` in `.css`.**
7. **DB clients:**
   - reads use `getDb()`;
   - writes use `getDbForWrite()`;
   - `getDbForAuth()` only where `write-gate-boundaries.test.ts` allows it. Add `adminResetMfa` there (mfa.ts) so it works in read_only and billing_only, like `adminResetPassword`.

## 3. Charge codes
### 3.1 Route, nav, redirect, links
- **Page** `/admin/charge-codes`, title "Charge codes".
  - The server reads `tab` for its first render.
  - **The client reads the tab from `useSearchParams`** (as `AssignmentsClient` does) and switches with `history.replaceState`, keeping `code` only on direct.
  - The `?code=` auto-open is unchanged.
- **Header actions:**
  - Direct: "Create codes from CLINs…" and "Add charge code" (primary);
  - Indirect: "Add indirect code".
- **Redirect:** add `{ source: "/admin/indirect-codes", destination: "/admin/charge-codes?tab=indirect", permanent: false }` to `next.config.ts`, and a case to `route-moves.test.ts`.
- **Move and delete:** delete `admin/indirect-codes/page.tsx`; move `IndirectCodesClient.tsx` to `admin/charge-codes/IndirectCodesPanel.tsx`.
- **Nav:** remove the "Indirect codes" leaf; update `nav-config.test.ts`.
- **Links:** repoint every link in §1.6 to `/admin/charge-codes?tab=indirect`. Payroll's link text becomes "Set pay types on Indirect codes".

### 3.2 Direct tab
- **`listChargeCodes()` adds:**
  - `chargeable` (boolean, the `CHARGEABLE_CODE` expression as a select column);
  - `clinDescription`;
  - `slinNumber` (left join `slins`);
  - `peopleCount`: active `user_charge_codes` rows whose user is active, as a correlated subquery **writing the outer column literally** (`charge_codes.id`).

  Existing consumers ignore the new fields.
- **The page also passes** `workspaceToday`, the active SLINs (for the form) and `getIndirectChargeCodes()` (moved from the old indirect page, `indirect-codes/page.tsx:13`). The empty-CLIN lines are **computed on the client** from the `codes` state plus the existing active contract×CLIN prop: an active CLIN whose id isn't any code's `clinId`. That way a manual create also clears its line.
- **After every write, refetch into state as today** (`refreshCodes()`); `router.refresh()` alone doesn't update this table.
- **Table:** `useAppTable` `expandable` with parent = contract (name + number), `defaultExpanded` true. Children are codes sorted by code, followed by the contract's empty-CLIN lines. A contract with only empty-CLIN lines is still a parent.
  - **Charge code:** code (mono), with "CLIN {n}" or "CLIN {n} · SLIN {n}" below in normal text.
  - **Name.**
  - **Labor category:** `chargeCodeCategoryOn` at `workspaceToday` → "{lcat code} since {date}" (the date of the change in effect; none for the starting value), or "None" (dimmed).
  - **Location:** Onsite / Telework / Other / "—".
  - **Billable:** Yes / No.
  - **People:** `numericColumn`; 0 in warn.
  - **Status:** `StatusBadge`.
  - **Actions:** "Edit"; a ⋯ menu with "Change labor category…" and "Deactivate…" or "Reactivate…" (existing flows).
  - **Empty-CLIN lines:** the text "CLIN {n} {description} has no charge codes." in the first column, other cells blank, no actions. They show only when the Status filter is Active (the default).
- **Toolbar:** search (MRT global filter; parents use `treeText`) and Status (Active (default) / Inactive / All), filtered client-side.
- **Empty states:**
  - When there are **no codes at all**, render instead of the table: "No charge codes yet." / "Create one per CLIN, or add one yourself." / "Create codes from CLINs…".
  - When filters match nothing, the table's `emptyState` reads "No charge codes match."

### 3.3 Create codes from CLINs
- **New `previewAutobridgeChargeCodes()`:**
  - `requireAdmin` (add it to `ADMIN_READ_ONLY_ALLOWLIST`);
  - returns `{ clinId, code, name, contractName, clinNumber, available, reason? }[]` for the qualifying set, sorted by contract name, then CLIN number;
  - `name` is truncated to 255;
  - `available = false` with a reason when the code string is over 100 characters ("Code would be too long — add one yourself.") or is **already used by another code** ("Code {code} is already used — add one yourself.").
- **`autobridgeChargeCodesFromClins(clinIds?: string[])`:**
  - `requireAdminFresh`;
  - **no argument** = every qualifying, available CLIN (the Setup wizard's call); `[]` is refused ("Tick at least one CLIN."); ids are UUIDs, deduped, ≤ 500;
  - recompute the qualifying, available set and intersect;
  - insert in **one transaction** with `.onConflictDoNothing().returning({ id })`;
  - `created` = returned rows; `skipped` = requested − created, where requested = **every id passed** (ids dropped by the intersection count as skipped), or the whole set with no argument;
  - returns `{ created, skipped }`.
  - **Update both callers** (§1.1) to use `created`: the Setup wizard (toast "Created {n} charge codes") and `setup-wizard.test.tsx`; the Charge codes button now opens the modal.
- **Modal "Create codes from CLINs":**
  - text: "These active CLINs have no charge code yet. Each ticked one gets a code named after the CLIN. You can rename them afterwards.";
  - table: checkbox, New code (mono), Name, CLIN. Available rows are ticked by default. Unavailable rows show their reason and an unticked checkbox that's `aria-disabled`.
  - help text: "They start billable, with no labor category, and nobody has access yet — give access on Assignments.";
  - buttons: Cancel, and "Create {n} codes" (validate on click: "Tick at least one CLIN.");
  - empty: "Every active CLIN already has a charge code." + Close;
  - toast: "Created {created} charge codes" (+ " · {skipped} skipped" when > 0); then refetch.

### 3.4 Charge code form
- **Fields:**
  - Code (required)
  - Name (required)
  - Description
  - Contract (required)
  - CLIN (required)
  - **SLIN** (optional: "None" plus the CLIN's active SLINs, **always including the code's current SLIN even if inactive**, labelled "(inactive)")
  - Location
  - Class (with the existing inline new-class field)
  - Billable
- **SLIN read-only rule (new):** the same as CLIN. It's read-only with the existing reasons when the code has recorded hours or labor categories, because `updateChargeCode`'s locks already cover a SLIN change.
- **The client sends `slinId` only when it changed.**
- **Validation:** on click, inline errors ("Enter a code.", "Enter a name.", "Choose a CLIN."). Server errors go in one top `Alert` (`role="alert"`); no validation toast.
- **Server, create and update:** the new checks go in the **actions** (`createChargeCode` / `updateChargeCode`), not `createChargeCodeInternal`, so the QBO import (`qbo.ts:280`) is unchanged.
  - code 1–100 after trim (update trims too), name 1–255, description ≤ 2,000;
  - UUIDs;
  - on create, the CLIN and contract must be active ("Choose an active CLIN.");
  - after merging the update, the **effective** `(clinId, slinId)` pair must have the SLIN on that CLIN ("That SLIN isn't on the chosen CLIN.");
  - existing locks run first.

### 3.5 Indirect tab
- **Groups** (`expandable`, `defaultExpanded` true; empty groups hidden), in order: Leave ("paid and unpaid time off"), Overhead, G&A ("general and administrative"), IR&D, B&P, Unallowable ("FAR 31.205").
- **Columns:**
  - Code
  - Name
  - **Pay type:** Paid time off / Sick / Holiday / Unpaid; "—" for non-leave; a `bad` badge "Not set"
  - **On timesheets:** Everyone / Hidden; "—" when inactive
  - Status
  - Actions: "Edit" + ⋯ with "Deactivate…" / "Reactivate"

  Description moves into the form.
- **Notice** (warn) when **any** leave code, active or inactive, has no pay type (matching `payroll-data.ts:116`):
  - singular: "{CODE} {Name} has no pay type, so Payroll export is blocked for anyone who charged it.";
  - plural: "{n} leave codes have no pay type, so Payroll export is blocked for anyone who charged them.";
  - "Set pay type" opens the first one's edit form (by code).
- **Form errors:** inline plus an `Alert`, replacing the Badge. The "Hide {code} from timesheets?" confirm is kept.
- **Empty state:** "No indirect codes yet." / "Add the standard DCAA set or add your own." / "Add standard codes".

## 4. Assignments
### 4.1 Shared
- **Title** "Assignments"; tabs Charge code access | Labor categories | Approval scope.
- **Switching tabs keeps** `laborCategoryId`, `userId` and `assignments`; only `tab` changes.
- **After every write, refetch into state as today.**
- **Pickers offer active rows only:**
  - people: `isActive`;
  - supervisors: active, role supervisor;
  - codes: `chargeable`;
  - CLINs: active CLIN on an active contract.

### 4.2 Charge code access (grouped by person)
- **Parents:** every active user (all roles), sorted by name. People with no chargeable access sort last.
- **Children:** the person's **active** assignment rows:
  - code (mono), name, "Contract · CLIN", location (sentence case);
  - action "Remove…";
  - a row whose code isn't `chargeable` shows dimmed with "Can't be charged right now" in the name cell and **doesn't count**.
- **Parent text:** "{n} codes · {contract short names}", where n counts chargeable rows only.
  - With n = 0, the warn text is "No charge codes · only indirect time on their timesheet".
  - Parent action: "Add codes" (opens Give access with the person preselected).
- **"Remove…":** "Remove {name}'s access to {code}?" / "They can't charge new time to it. Hours already recorded stay on record." Then `unassignChargeCodeFromUser`.
- **Give access** (Modal "Give access to charge codes"):
  - **Person** (required, active users).
  - **Charge codes** (required): a checklist of `chargeable` codes grouped by "{contract} · CLIN {n} {clinDescription}".
    - The CLIN checkbox selects or clears that CLIN's selectable codes (indeterminate when partly selected).
    - Codes already actively held show checked and `aria-disabled`, with "already has access".
  - **Supervisor notice (R8):** when the chosen person is a supervisor and the selection includes codes on CLINs where they have no active CLIN row, show a warn `Notice` in the dialog: "{name} is a supervisor. These codes also let them approve employees on {CLIN list}. You can change that on Approval scope." It's computed client-side from the supervisor rows already loaded.
  - **Footer:** "{n} codes selected", Cancel, "Give access to {n} code(s)". Validation: "Choose a person." / "Choose at least one charge code."
  - **On success:** toast "{name} can now charge {n} more code(s)"; close; refetch. On error: an `Alert`; the selection is kept.
- **New action `assignChargeCodesToUser({ userId, chargeCodeIds })`:**
  - `requireAdminFresh`; UUIDs; 1–200 ids, deduped;
  - in **one transaction**:
    - the user exists and is active ("Choose an active person.");
    - every code matches `CHARGEABLE_CODE`, else nothing is written ("{code} can't be charged right now. Refresh and try again.");
    - read which of the ids are already actively held;
    - call `assignChargeCodeToUserInternal(tx, …)` **only for ids not already held** (so `assignedBy` isn't overwritten);
  - returns `{ assigned }`.
  - Delete `assignChargeCodeToUser` and `assignAllUnderClin` if grep finds no other callers. Update `action-results-static.test.ts:335`, the fresh-admin-writes tests, `assignments-row-actions.test.tsx:10`, `assignments-lcat-tab.test.tsx:35` and `charge-code-actions.test.ts:78-270` (keep its `:251` CLIN-row sync assertion on the new action). Add `assignChargeCodesToUser` to the fresh-admin-writes unit and integration lists.

### 4.3 Labor categories
- **Overlaps:** the page computes them with `findOverlaps` from the assignment rows it already loads (no 11th load; map the row shape the function needs). It passes the overlapping assignment ids.
- **Grouped by person:** parents are people with at least one visible row. Children:
  - Category ("{code} {title}")
  - Where ("{contract short} · CLIN {n}" or "· SLIN {n}")
  - Rate today (existing `rateDisplay`)
  - From
  - Until ("No end")
  - **Status** (workspace today):
    - **Overlaps** (warn; wins)
    - Current
    - "Starts {MMM D}"
    - "Ended {MMM D, YYYY}"
  - "End…" (the existing modal; hidden once ended)
- **Show:** "Current and upcoming" (default; hides Ended) / "Everything, including ended".
- **Notice** when overlaps exist: "{n} people have overlapping labor categories, so some hours aren't priced." (or "{name} has overlapping labor categories, so some hours aren't priced.") with the link "See what to fix" → `/admin/reports/unpriced?reason=conflict`.
- **Chips:** behaviour unchanged.
- **"Assign a labor category":** the existing form in a Modal (active users only).

### 4.4 Approval scope
- **Notice:** "Admins can approve anyone. A supervisor approves employees assigned to the CLINs below, and supervisors or admins who name them as their approver. Supervisors' and admins' own timesheets go to their approver (set on Users), or to admins if none."
- **Parents:** **active supervisors, including those with no CLINs** (so "Add CLIN" is reachable), sorted by name.
  - Parent text: "{n} CLINs · approver: {name or "admins"}".
  - The approver is computed **on the server** with the same `effectiveDesignee` rule, from the `getUsers()` rows **already loaded** in that request (`SAFE_USER_COLUMNS` has `approverId`). It's passed as a prop; no extra load.
  - Action "Add CLIN" (preselects the supervisor).
- **Children:** the supervisor's active `user_assignments` rows:
  - "{contract} · CLIN {n} {description}";
  - **People** = active users with role `employee` holding an active row on that CLIN;
  - **Since** = `assignedAt` as a workspace date;
  - "Remove…": "Remove {CLIN} from {name}'s approval scope?" / "They'll stop approving employees on this CLIN. Giving {name} a charge code on this CLIN later adds it back."
- **Footer line:** active CLINs (active contract) with ≥ 1 active employee row and **no coverage**. Coverage = an active row whose user is active with role supervisor. Text: "Not covered by a supervisor: {list} — admins approve these." Hidden when none.
- **"Add CLIN to a supervisor":** a Modal with Supervisor, Contract and CLIN (active only). `assignUserToClin` **drops `slinId`** (sole caller, never sent). Add validation: UUIDs; the user exists, is active and is a supervisor ("Choose an active supervisor."); the CLIN exists.

## 5. Users
### 5.1 Server
- **New `getUsersForAdminPage()`** (`requireAdmin`, `getDb()`, added to `ADMIN_READ_ONLY_ALLOWLIST`): `SAFE_USER_COLUMNS` plus:
  - `mfaEnabled` (`users.totpEnabled`, boolean only);
  - `lock: { minutesRemaining } | null`;
  - `approverName` (server-computed effective approver, for supervisors and admins).

  `getUsers()` is unchanged (Assignments keeps using it).
- **Lockout:** pull out a pure `lockoutFromRows(rows, now)` in `login-attempts.ts` that both `getLockoutInfo` and the new `getLockoutsForEmails(db, emails)` use, so the arithmetic is identical (truncated minutes; locked only while > 0).
  - `getLockoutsForEmails` runs **one** query: `attempted_at >= now − 15 min AND lower(email) IN (…)`. A success before the window can't change the result.
  - Match on lowercased `users.email`.
- **`updateUser`:**
  - after `lockUserRulesExclusive`, read the target's role, isActive and flsaExempt with a plain SELECT (no extra `FOR UPDATE`; the lock order stays the same);
  - throw `not_found` if the row is missing;
  - log only the fields that changed (R5).
- **`createUserWithPassword({ email, fullName, role, password, flsaExempt, approverId? })`:**
  - `flsaExempt` is a required boolean ("Choose an overtime status.");
  - move `validatePassword` and its constants to `src/lib/password-rules.ts` (used by `password.ts`, this action and the forms);
  - the existing `validateEmail`;
  - `isUniqueViolation` → "Email is already used by another user.";
  - `approverId` only for supervisor or admin, validated by a helper extracted from `setUserApprover`;
  - logs `created`, plus `approver_changed` when an approver is set.
  - When the role changes to `supervisor`, `updateUser`'s `role_changed` `newValue` also lists the user's active CLIN ids (the approval scope they get). Read them in the same transaction.
- **`bulkImportEmployees`** (`import.ts:86`): logs `created` per inserted user, inside its existing per-row savepoint.
- **New `adminResetMfa({ userId, currentPassword })`** in `mfa.ts`:
  - `requireAdminFresh`; `getDbForAuth()` (add it to `WRITE_GATE_AUTH_ALLOWLIST` in `server-action-guards.test.ts:89`; `mfa.ts` is already allowed file-wide in `write-gate-boundaries.test.ts:30`);
  - **refuse self first** (before any password check, so it doesn't use up an attempt);
  - `verifyCurrentPassword` for the **acting admin**, using the admin's email **read from the DB row** (the JWT email isn't refreshed). A wrong password shows "That password isn't right." and counts as a failed attempt; a lockout keeps its existing message;
  - transaction: `FOR UPDATE`; already off → `{ changed: false }`; otherwise clear `totpSecret`, `totpRecoveryCodes` and `totpLastUsedStep`, set `totpEnabled = false` and `sessionVersion = users.sessionVersion + 1`, plus `updatedAt`;
  - log `mfa_reset`;
  - returns `{ changed: true }`.
- **`adminResetPassword`:** hash **before** opening a transaction; in the transaction, update with an SQL session bump and log `password_reset`.

### 5.2 UI
- **Title** "Users"; the `ApprovalNotices` banner is kept.
- **Toolbar:**
  - search (name, email);
  - Role select;
  - Status select (Active (default) / Inactive / Locked / All);
  - a seat line: "{active} active · {free} of {limit} seats free", or "{active} active" when unlimited (`getSeatUsage`).
- **Columns:**
  - **Name:** bold, with email and " · you" below.
  - **Role:** plain text.
  - **Approver:**
    - supervisors and admins: `approverName`, or "None — admins approve";
    - employees: "CLIN supervisors" (dimmed).
  - **Overtime:** Exempt / Non-exempt.
  - **Two-step sign-in:** On / Off.
  - **Status:** Active / Inactive / "Locked · {n} min" (warn; active users only).
- **Actions:** "Edit", plus a ⋯ menu showing only what applies:
  - **"Unlock now"** (locked only): no confirm; toast "{name} can sign in again"; refetch.
  - **"Reset password…".**
  - **"Reset two-step sign-in…"** (`mfaEnabled` and not you). Modal: "Reset two-step sign-in for {name}?" / "They're signed out within a minute. They'll sign in with just their password and can turn two-step sign-in on again from their profile." Field "Your password" (required). Button "Reset two-step sign-in". A stale "already off" result → toast "Two-step sign-in was already off"; refetch.
  - **"Mark as exempt…" / "Mark as non-exempt…":** unchanged.
  - **"Deactivate…" / "Reactivate":** unchanged.
- **Role-change confirm to Supervisor** (the existing variant): add "They'll approve employees on the CLINs they're assigned to. Check Assignments → Approval scope." (R8).
- **Add user** (Drawer):
  - **Fields:**
    - Full name
    - Email
    - Role (options with descriptions as in the mockup)
    - **Overtime status:** a required radio with no default, "Non-exempt (paid overtime)" / "Exempt", help "Payroll export uses this to work out overtime."
    - **Approver:** Supervisor or Admin only; default "None (admins approve)"
    - **Temporary password:** rules from `password-rules.ts` tick as met; help "Share it with them privately. They can change it after signing in."
  - **Footer:** "Uses 1 of {free} free seats" (hidden when unlimited), Cancel, "Add user".
  - **Errors:** inline plus a top `Alert` (`role="alert"`) "Fix {n} thing(s) to add this user:" with links that focus each field. Server errors go in the same Alert.
- **Edit:** the same Drawer, without the password field.
- **Reset password modal:** the button is never disabled; it validates on click with the shared rules.

## 6. Audit trail
### 6.1 Filters, URL, loading
- **URL:** `range=last30|last|this|custom&start&end&user&contract&clin&reason&changed=1&tab=entries|events|admin&page`. Invalid values fall back to the defaults (`last30`, `entries`, page 1). For a supervisor, `tab=admin` → `entries`.
- **The page server-loads the URL's filters, tab and page** (entries page + summary, or events, or admin changes), so the first paint shows data. It passes `workspaceToday` and the resolved start and end.
- **The client resolves every preset to `start` / `end`** before calling actions or building the CSV link:
  - `last30` = workspaceToday − 29 … workspaceToday;
  - `last` / `this` via `resolvePeriodRange`;
  - `custom`: no query until both dates are valid and start ≤ end (inline "End date must be on or after the start date.").
- **Any filter change resets `page` to 1** and writes the URL with `replaceState`.
- **A request token** applies only the latest response; the table gets `aria-busy` while loading.
- **Filter bar:**
  - Dates (+ two DateInputs for custom);
  - Employee;
  - Contract (+ CLIN, shown only once a contract is chosen);
  - Reason;
  - "Changed entries only".
- **Hidden per tab:** Contract, CLIN, Reason and Changed on Events and Admin changes; Employee on Admin changes.

### 6.2 Entries tab
- **One filter builder** `auditEntryWhere(scope, filters)` used by the list, the count, the summary and the export.
  - The contract filter becomes `clin_id IN (SELECT id FROM clins WHERE contract_id = $1)`, so it needs no join.
  - The date filters stay on `entry_date`.
- **`getAuditEntries(filters & { page })`:**
  - `pageSize` 50;
  - returns `{ entries, total, page, pageSize }`, with `total` = `COUNT(*)` `.mapWith(Number)`;
  - order unchanged: `created_at DESC, id DESC`.

  Remove `truncated` for entries only. `getAuditPeriodEvents` keeps its cap (rename `AUDIT_ROW_LIMIT` to `EVENT_ROW_LIMIT`) and its notice.
- **`getAuditSummary(filters)`:** `{ entries, changed, late, people }`, every count `.mapWith(Number)`:
  - `changed` = `revision_number >= 2`;
  - `late` per R3;
  - `people` = distinct `user_id`.
- **Strip:** "Entries in this view", "Changed after first entry", "Entered late", "People".
- **Table** (MRT, manual pagination, `rowCount = total`):
  - Work date
  - Employee
  - Charge code (code + the existing Imported badge)
  - Hours (`numericColumn`)
  - **Version** (badge, warn when ≥ 2)
  - Reason (label or "—")
  - **Comment** ("—")
  - **Entered:** workspace date and time, with "by {name}" or the import provenance below
  - **History:** an icon button with the label "History for {employee}, {date}", opening the existing revision Drawer, retitled "Entry history", with "Version {n}"
- **Row edge:** extend the existing `data-correction` edge to late rows (a `data-late` attribute or a shared `data-flag`). Remove `--audit-correction-bg` and its fill, rewrite `audit-correction-contrast.test.ts`, and add the legend "Changed or entered late".
- **Empty state:** "No entries in these dates." / "Try a longer date range or fewer filters."

### 6.3 Timesheet events tab
- **Data:** the table uses the stored event value mapped through `STATUS` (`rejected` → "Returned"), the actor's name, and `self = actor_id === user_id` (add these fields to `AuditPeriodEvent` if missing). `periodEventLabel` is unchanged.
- **Columns:**
  - When (date and time)
  - Employee
  - Pay period
  - Event (`StatusBadge` + " · self-approved" / " · self-returned")
  - By
  - Comment
- **Pagination:** client-side.
- **Empty state:** "No submits, approvals or returns in these dates."

### 6.4 Admin changes tab (admins only)
- **Typed registry** `ADMIN_CHANGE_ACTIONS` in `src/lib/audit/admin-change-registry.ts`, listing each entity's possible actions (§1.5 pairs + R5) `as const`.
  - Type `AdminChangeLogRow.entity` / `action` from it, so writers can't log unregistered pairs (computed actions like `enabled | disabled` type-check as the union).
  - The formatter `describeAdminChange` is a `Record<Entity, Record<Action, (row, names) => { change, details }>>`, so **tsc enforces coverage**.
  - **Legacy pair:** `charge_code` / `labor_category_changed` was written before commit `f8f52e3`, so old tenants still have rows. Register it as a **read-only** action (not in the writer type) with old/new `laborCategoryId` → "{code} {title}".
  - **Runtime fallback:** DB values are strings, so look up defensively. An unknown pair renders `{ change: humanize(action), details: entity name }` and never throws.
  - **Null ids** in values render as "None" (approver: "None (admins approve)"), not "(deleted)".
  - The single-writer test row (`admin-change-log-writer.test.ts:38`) needs `as const` once the row type narrows.
- **New `getAdminChanges({ start, end, page })`:**
  - `requireAdmin` (`ADMIN_READ_ONLY_ALLOWLIST`), `getDb()`;
  - `(created_at AT TIME ZONE $workspaceTz)::date BETWEEN start AND end`;
  - `ORDER BY created_at DESC, id DESC`, 50 per page + total;
  - joins the actor's name;
  - **batch-resolves names** for `entity_id` **and** for ids inside `old_value` / `new_value` (`approverId` → user; `laborCategoryId` → "{code} {title}"; …) per entity: `user`, `self_approval` (users), `charge_code` and `charge_code_labor_category` (charge codes), `labor_category_rate` (labor categories), `workspace_settings` ("Workspace"); missing → "(deleted)".
- **Table:** When, Change, Details, By.
- **Empty state:** "No admin changes in these dates."

### 6.5 Audit CSV
- **`GET /api/reports/audit-csv?start&end&user&contract&clin&reason&changed`:** `start` and `end` are **required** (400 otherwise).
  - `checkReportRateLimit`;
  - guard and scope through a new `getAuditExportCursor(filters)` (`requireApprover`, `auditEntryWhere`).
- **Count first:**
  - 0 → 422 "No entries in these dates.";
  - more than 50,000 → 422 "More than 50,000 entries match. Choose a shorter date range.".
- **Resolve everything before building the stream**, copying `api/export/workspace/route.ts:37-64` and `lib/export/workspace-export.ts:240-360`: actor, scope, DB client, workspace timezone and the WHERE clause. The batch function closes over them and never calls `getDb()`, `headers()`, `getEmployeeScope` or `getWorkspaceTimezone` inside `pull()`.
  - The batch helper lives in `src/server/internal/audit-export.ts`, not the `'use server'` `audit.ts`.
  - Set `export const maxDuration = 300` on the route.
  - Handle `cancel()` and `request.signal` (stop fetching), and report errors to Sentry.
- **Then stream:** a `ReadableStream` that writes the header row, then fetches **keyset batches of 1,000** (`created_at DESC, id DESC`) and encodes each row with `escapeCsvField`.
  - **The cursor stays in SQL:** `WHERE (te.created_at, te.id) < (SELECT created_at, id FROM timesheet_entries WHERE id = $lastId)`.
  - **Never build the cursor from a JS `Date`.** `created_at` has microsecond precision, rows from one save share it, and a `Date` truncates to milliseconds, which would silently drop rows.
  - Headers: `Content-Type: text/csv; charset=utf-8`, attachment filename `audit-trail-{start}-to-{end}.csv`.
  - A mid-stream DB error closes the stream with `controller.error`, which the browser sees as a failed download, not a silent short file.
- **Columns:**
  - Work date
  - Employee
  - Employee email
  - Contract number
  - CLIN
  - Charge code
  - Hours
  - Version
  - Reason code (raw)
  - Comment
  - Entered at (ISO 8601 with offset, workspace zone)
  - Entered by
  - Source
- **Client:** `downloadFile` with a busy state (`useBusy`). Confirm in the impact analysis that `downloadFile` handles a streamed body (it uses `blob()`).

### 6.6 Seed
No change. The seed already logs `rate_change_added` (`seed-full.ts:185`), so the demo's Admin changes tab has a row.

## 7. State tables
**Charge code access** (`user_charge_codes.is_active`):

| From | Event | To | Side effects |
|---|---|---|---|
| none / inactive | Give access (user active, code chargeable) | active | `user_assignments` upsert (unchanged; a supervisor notice in the UI, R8) |
| active | Give access (already held) | active | none (aria-disabled in the UI; upsert idempotent) |
| active | Remove | inactive | none (`user_assignments` unchanged) |
| any | Give access with the user inactive or a code not chargeable | unchanged | the whole request is refused |

**Supervisor approval scope** (`user_assignments` for a supervisor):

| From | Event | To |
|---|---|---|
| none / inactive | Add CLIN | active |
| active | Remove | inactive |
| inactive | Give access to a code on that CLIN | active (unchanged behaviour; the dialog warns, R8) |

**Two-step sign-in:**

| From | Event | To | Side effects |
|---|---|---|---|
| on | admin reset (other user, correct password) | off | 3 fields nulled; session bump; `mfa_reset` log |
| on | admin reset, wrong admin password | on | failed attempt recorded; message |
| off | admin reset (stale UI) | off | `{changed:false}`; no log |
| any | admin reset of self | unchanged | refused |

**Lock** (derived): locked at the 5th failure inside 15 minutes; unlocked by a success row (sign-in or Unlock now) or when the window passes.

## 8. Failure modes
| Operation | Failure | Behaviour |
|---|---|---|
| Give access | a code is deactivated before saving | the whole request refused, the code named; nothing written |
| Give access | double click | `useBusy`; upsert idempotent |
| Create codes from CLINs | two admins at once | one transaction each; `onConflictDoNothing` + `returning`; the second reports skipped |
| Create codes from CLINs | code string taken or too long | marked unavailable in the preview; never attempted |
| Create codes from CLINs | DB error mid-insert | the transaction rolls back; nothing created; error shown |
| Admin MFA reset | user signed in | signed out within ~60 s (session check interval) |
| Admin MFA reset | concurrent resets | `FOR UPDATE`; the second gets `{changed:false}`; one log |
| `updateUser` log write fails | | the transaction rolls back; the change isn't saved |
| Audit filters | overlapping requests | request token; latest wins |
| Audit CSV | > 50,000 rows / 0 rows | 422 before streaming |
| Audit CSV | DB error mid-stream | `controller.error`; failed download; Sentry |
| Audit CSV | > 1,000 rows from one save (same `created_at`) | the SQL cursor keeps every row (no JS `Date` truncation) |
| Audit CSV | user cancels the download | `cancel()` / `request.signal` stop the fetches |
| Admin changes | an unknown or legacy (entity, action) row | fallback text; never throws |
| Audit CSV | supervisor passes an out-of-scope user | scope WHERE → 0 rows → 422 |
| Users page | lock query fails | page error, as today (one query) |

## 9. Platform limits
- **Audit list:** 50 rows plus a COUNT per request. `timesheet_entries` has no index on `created_at` or `entry_date` (all indexes start with `user_id`), which is acceptable at current tenant sizes. Recorded for later if a tenant grows.
- **Audit CSV is streamed**, so it isn't subject to the 4.5 MB buffered limit. It's at most 50,000 rows in 1,000-row keyset batches; memory stays bounded.
- **Users:** one bounded `login_attempts` query (15-minute window).
- **Give access:** ≤ 200 codes per transaction. **Assignments page:** still ten parallel loads (overlaps computed in process).

## 10. Blast radius
| Area | Files |
|---|---|
| Nav and redirect | `nav-config.ts`, `nav-config.test.ts`, `next.config.ts`, `route-moves.test.ts` |
| Indirect move | delete `admin/indirect-codes/page.tsx`; move `IndirectCodesClient.tsx` → `IndirectCodesPanel.tsx`; tests `row-state.test.tsx`, `indirect-codes-row-actions.test.tsx` |
| Links | `SetupWizardClient.tsx`, `MigrationClient.tsx`, `PayrollExportClient.tsx`, `migration-client.test.tsx` |
| Charge codes | `actions/charge-codes.ts`, `internal/charge-codes.ts`, `ChargeCodesClient.tsx`, `setup-wizard.test.tsx`, charge-code tests |
| Assignments | `AssignmentsClient.tsx`, `LaborCategoryAssignmentsPanel.tsx`, `actions/assignments.ts`, `assignments-params.ts`, `action-results-static.test.ts`, fresh-admin-writes unit and integration tests |
| Users | `users.ts`, `password.ts`, `mfa.ts`, `login-attempts.ts`, `import.ts`, new `lib/password-rules.ts`, `UsersClient.tsx`, `users-row-actions.test.tsx` |
| Audit | `audit.ts`, `AuditTrailClient.tsx`, `reason-codes.ts`, `globals.css`, `audit-correction-contrast.test.ts`, `audit-trail.test.ts`, new route, `admin-change-registry.ts`, `admin-change-log.ts` (types) |
| Guards | `server-action-guards.test.ts` (`ADMIN_READ_ONLY_ALLOWLIST` += `previewAutobridgeChargeCodes`, `getUsersForAdminPage`, `getAdminChanges`), `WRITE_GATE_AUTH_ALLOWLIST` (`server-action-guards.test.ts:89`) += `adminResetMfa` |
| Labels | tests asserting "Correction of Error" or "Late Entry (>24hrs)" |

## 11. Test matrix
Each row must fail without its change.

| # | Scenario | Kind |
|---|---|---|
| CC-1 | Redirect `/admin/indirect-codes` → `?tab=indirect` (`route-moves.test.ts`) | unit |
| CC-2 | `tab=indirect` renders the panel; an invalid tab → direct; switching tabs via `replaceState` changes the panel | unit |
| CC-3 | The category column uses the category in effect on workspace today (a future-dated change is ignored) | unit |
| CC-4 | `peopleCount` excludes inactive users and inactive rows; `chargeable` false for a code on an inactive CLIN | integration |
| CC-5 | Empty-CLIN line for an active CLIN with no code, not for one with an inactive code; it disappears after a manual create without a reload | unit |
| CC-6 | Preview: taken code and > 100-character code marked unavailable; create with a subset creates only those; `[]` refused; no argument creates the whole available set; `created` counts inserted rows | integration |
| CC-7 | Create: SLIN from another CLIN refused; inactive CLIN refused; update moving the CLIN while the old SLIN stays → refused | integration |
| CC-8 | Edit a code with an inactive SLIN: the SLIN shows "(inactive)" and saving another field doesn't send `slinId` | unit |
| CC-9 | Indirect notice appears for an **inactive** leave code with no pay type | unit |
| CC-10 | Setup wizard toast uses `created` | unit |
| AS-1 | Tab switch keeps the LCAT filters | unit |
| AS-2 | Person grouping: non-chargeable rows dimmed and not counted; n = 0 warn text | unit |
| AS-3 | `assignChargeCodesToUser`: inactive user refused; one non-chargeable code → nothing written; reactivates an inactive row; `assigned` excludes already-held | integration |
| AS-4 | **R8 notice:** choosing a supervisor plus a code on a CLIN they don't have shows the notice listing that CLIN; an employee shows none | unit |
| AS-5 | Give access dialog: held codes checked and `aria-disabled`; CLIN checkbox; validation messages | unit |
| AS-6 | LCAT status (Overlaps wins); "Current and upcoming" hides Ended; notice links to the conflict report | unit |
| AS-7 | Approval scope: supervisors with no CLINs listed; People counts employees only; uncovered line ignores an inactive supervisor's row | unit |
| AS-8 | `assignUserToClin` refuses an inactive user and a non-supervisor | integration |
| US-1 | `getUsersForAdminPage` returns `mfaEnabled`, `lock` and `approverName`; `getUsers` doesn't run the lock query | unit |
| US-2 | `getLockoutsForEmails` equals `getLockoutInfo` per email: 4 failures; 5; 5 then a success; failures older than 15 minutes; mixed-case email; 14 min 59 s remaining | integration |
| US-3 | `adminResetMfa`: wrong admin password refused (and recorded); success clears 3 fields, sets enabled false, bumps the session, logs once; already off → no log; self refused **without** recording a failed attempt | integration |
| US-4 | `updateUser` logs only the changed fields (promotion to admin and FLSA included); a promotion to supervisor lists their active CLIN ids; name-only → no log | integration |
| US-5 | `createUserWithPassword`: missing `flsaExempt`, short password, approver for an employee → refused; logs `created` | integration |
| US-6 | `adminResetPassword` logs and bumps the session in SQL; `bulkImportEmployees` logs `created` per user | integration |
| US-7 | Menu: Unlock only when locked; Reset two-step only when on and not self | unit |
| US-8 | Add user: no overtime choice → the Alert lists it and links to the field | unit |
| AU-1 | The page renders data for the URL's filters with no interaction; the default is last 30 workspace days | unit |
| AU-2 | Summary follows the filters, including a contract filter (no missing-FROM error); `late` counts a revision-1 app row with a CORRECTION reason (matches Approvals) | integration |
| AU-3 | Paging: page 2 is the next 50; `total` is a number equal to the filtered count | integration |
| AU-4 | Supervisor scope on entries, summary and export | integration |
| AU-5 | Events show "Returned" and the self note; events keep their cap notice | unit |
| AU-6 | Admin tab hidden for supervisors; `getAdminChanges` refuses a supervisor; day bounds use the workspace zone (a row at 11:30 PM New York on day X is in day X) | unit + integration |
| AU-7 | `describeAdminChange` resolves an `approverId` inside `new_value` to a name; an unknown id → "(deleted)"; a null id → "None"; the legacy `labor_category_changed` renders; an unknown pair doesn't throw | unit |
| AU-8 | CSV: raw reason code; formula guard on `=` comment; 0 rows → 422; over cap → 422; missing `start` → 400; **more than 1,000 rows inserted in one transaction → the CSV row count equals the COUNT** | integration |
| AU-9 | Stale response ignored; a filter change resets the page to 1 | unit |
| AU-10 | No `--audit-correction-bg`; late rows get the edge | unit |

## 12. Verification
- **Dev:** `npx tsc --noEmit`, `npm run lint` (0 errors), `npm run test`, `npm run test:tz`, `npm run db:safety`.
- **Product owner:**
  - integration;
  - `npm run build && node scripts/check-build-trace.mjs && node scripts/check-css-output.mjs`;
  - `npm run demo:local`;
  - the lead's break-it script.
- **Browser** (acme admin, then sarah.wilson):
  1. The old Indirect codes address lands on the Indirect tab; the nav has no Indirect codes.
  2. Create codes from CLINs lists NAVAIR 0003 and Army 0003; untick one; one is created and its empty-CLIN line goes away.
  3. Give Robert NAVAIR-0002; Remove it; give it again.
  4. Choose Sarah in Give access with DISA-0002: the supervisor notice names DISA CLIN 0002.
  5. Sign in as john with a wrong password 5 times (private window). John shows Locked; Unlock now clears it.
  6. Turn on two-step sign-in as jane, then reset it as admin (with your password). Within a minute jane is signed out; Admin changes shows the reset.
  7. The Audit trail shows data immediately; Reason → Late entry changes the numbers; Download CSV saves a file.
  8. As sarah, there's no Admin changes tab.

## 13. Hand-off rules and commit order
- `BLUEPRINT-STANDARD.md` §3: impact analysis first; every matrix row a test that fails without its change (revert-check and report); honest reporting; don't push.
- **Commits:**
  1. Shared: `password-rules.ts`, `lockoutFromRows`, R4 labels, admin-change registry types.
  2. Charge codes: merge, redirect, nav, links, direct tab, create from CLINs, form.
  3. Indirect tab.
  4. Assignments + R8 + `assignChargeCodesToUser`.
  5. Users: server (R5, R6, R7) + UI.
  6. Audit trail: server (filter builder, paging, summary, events, admin changes, CSV stream) + UI.

## 14. Pre-mortem record
**Round 1 (2026-11-06)**, two reviewers: Charge codes + Assignments; Users + Audit. 1 HIGH, 17 MEDIUM, all applied.
- **HIGH:** the CSV must stream (4.5 MB buffered limit).
- **MEDIUM:**
  - DB clients and guard allowlists;
  - lock arithmetic shared via `lockoutFromRows` and a bounded query;
  - the admin MFA reset needs the admin's password, and sign-out is "within a minute";
  - late matches Approvals;
  - the shared filter needs no join, and COUNTs use `mapWith(Number)`;
  - the real change-log entities and value-id resolution;
  - a typed registry instead of a grep test;
  - URL, date and preset resolution;
  - the events cap kept;
  - `updateUser` old values;
  - the import logs `created`;
  - R8 (codes no longer grant supervisor approval scope; reversed in round 2);
  - Restore cut;
  - refetch into state;
  - the Setup wizard caller;
  - code collisions and lengths;
  - missing loader fields and the ten-load limit;
  - "No charge codes" by chargeable;
  - the pay-type notice includes inactive codes;
  - the coverage definition and server-side approver;
  - the SLIN edit rules;
  - the link list;
  - empty states.
- **LOW, also applied:**
  - the R7 email check;
  - events use kind + self rather than new label fields;
  - `getUsers` left untouched;
  - the existing edge reused;
  - the index claim;
  - labels edited in `REASON_CODES`;
  - day bounds;
  - bcrypt outside the transaction;
  - a History button;
  - the approval notice wording;
  - `slinId` dropped from `assignUserToClin`;
  - the executor already exists;
  - the overlap notice links to the report;
  - the group-by-code view cut;
  - the tab from `useSearchParams`;
  - the autobridge transaction.

**Round 2 (2026-11-06)**, two fresh reviewers. 1 HIGH, 4 MEDIUM, all applied:
- **HIGH:** the CSV keyset cursor stays in SQL (microsecond `created_at` vs JS `Date`), with a one-transaction > 1,000-row test.
- **MEDIUM:**
  - R8 reversed to visible-not-changed: changing it narrowed supervisor report, audit and filter visibility, a policy question now recorded;
  - promotion now explains approval scope and logs the CLINs;
  - stream context is resolved before streaming (the workspace-export pattern), with `maxDuration`, cancel handling and Sentry;
  - the legacy `labor_category_changed` pair plus a runtime fallback.
- **LOW, applied:**
  - the extra `autobridge` caller and the tests touched;
  - validation lives in the actions (QBO import unaffected);
  - the page loads SLINs and indirect codes;
  - held ids aren't re-assigned;
  - `skipped` counts every id passed;
  - the approver is computed from rows already loaded;
  - the duplicate-email mapping already exists;
  - the self check runs before the password check, with the email from the DB;
  - the allowlist location;
  - null ids render as "None";
  - the seed already logs a rate change;
  - late counts rows, not cells.

**Recorded for the product owner (not blocking):** should charging a CLIN ever grant a supervisor approval scope (R8)? And should promotion keep CLIN rows from past code grants?
