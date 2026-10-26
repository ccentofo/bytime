# Feature plan: Certified outputs (import integrity, approver rules, correct reports, PDF, audit trail, payroll overtime)

Status: FINAL v6.2 (lead architect, 2026-10-25 — dev rulings Q1–Q8 recorded inline) — pre-mortem rounds 1–3 incorporated; business answers to CO-Q1–Q9
and the follow-up conditions recorded (2026-10-22) and designed in. Remaining risk is caught at the post-implementation audit. Follows `BLUEPRINT-STANDARD.md`.
Implemented by the dev agent **after `feature-plan-launch-blockers.md` P3 and P4 have landed** (C2 needs the fresh role
checks; every action here uses P4's `ActionResult` contract). Source: the 2026-10-22 whole-codebase audit.

Everything a customer or auditor relies on to certify, bill or pay time must show the true recorded hours: imported
history is labelled and can't back-fill, approvals come from an independent approver who sees exactly what they approve,
and every report, the PDF, the audit trail and the payroll export are built from the entries.

| Part | Scope |
|---|---|
| C1 | Migration import: durable onboarding window, attribution + labelling, overlap and lock guards, founder escape hatch |
| C2 | Approver rules: no peer approval, designated approvers with real access, approve exactly what was reviewed |
| C3 | Cost / hours reports: one cost-basis join (charge-code LCAT aware), history not changed by deactivation, CLIN immutability |
| C4 | Grid and review show every recorded hour (read-only where not assignable), per-period code lists |
| C5 | Timesheet PDF built from entries |
| C6 | Audit trail: all entries, true cell identity, import provenance |
| C7 | Payroll export: FLSA weekly overtime, leave, exempt, every format incl. Gusto, daily detail, safe CSV |
| C8 | Small items: "OTHER" reason needs a comment; export of new columns; seeder conformance |

---

## 0. Decisions

### Product owner (2026-10-22 — recorded)
| ID | Decision |
|---|---|
| CO-D1 | Migration import: **timesheet history during onboarding only; reference data any time.** Timesheets and pay periods importable only until the workspace's **first submitted timesheet**; afterwards no bulk import. Contracts, CLINs, users, charge codes any time. Every imported entry **marked as migrated** with **source system, import date and importing admin**; original author/dates kept **as data**; never displayed as if the employee typed it. **Escape hatch:** founder reopens the window for one workspace with a logged reason (support action). |
| CO-D2 | Payroll overtime = **federal FLSA, over 40 h per workweek, non-exempt**; no state rules at launch; label **"FLSA weekly overtime"**; **include daily hours**; computed **per workweek** (a week crossing pay periods is one week); a **workweek start day** setting per workspace; **exempt employees stay in the export with zero paid OT and an "uncompensated overtime" column**; payroll accountant reviews before marketing. |
| CO-D5 | **No peer approval.** A supervisor's timesheet is approved by an admin or by a supervisor **explicitly designated** as their approver — never a peer, never themselves; small companies: the admin approves supervisors; prerequisite: launch-blockers P3. |

### Business answers (2026-10-22 — recorded, not invented; designed in below)
| ID | Decision | Where |
|---|---|---|
| CO-D6 (Q1) | Sole-admin self-approval allowed, labelled **"Self-approved" everywhere the timesheet appears** (screen, approvals list, PDF, reports, audit trail, v1 API, export). **Switched off automatically** once a second active admin exists or the admin has an effective designated approver. Setup recommends designating a reviewer. | C2 |
| CO-D7 (Q2) | Rate changes must **not** re-price past hours (target: rate in effect on the day worked; "correction" vs "new rate from a date"). **Interim:** today's behavior with the "Costs use current labor-category rates" label is acceptable — **must be fixed before cost reports / contract dashboard are marketed** → separate follow-up blueprint (effective-dated rates), not in this plan. | C3 label; follow-up |
| CO-D8 (Q3) | Employees **may correct existing entries** on a code no longer assigned (or no longer active) — reason code required, period not locked — but **may not add new hours** to it. Admins **may reactivate** a deactivated charge code (logged). Approved/submitted periods stay locked. | C3, C4 |
| CO-D9 (Q4) | Unchanged: supervisors view CLIN-sharing peers, can't approve them. (Later idea, not here: limit peer view to the shared CLIN's lines.) | — |
| CO-D10 (Q5) | Most specific first: **charge code's labor category → employee's assignment on the entry's SLIN → employee's assignment on the CLIN.** **Never guess:** no applicable category, or two different categories at the same level → entry is **unpriced** and listed in an "Unpriced hours" report. | C3 |
| CO-D11 (Q6) | **Leave in its own columns** (PTO, sick, holiday) in ADP/Paychex/Gusto, not inside Regular. Leave **never** counts toward FLSA overtime. | C7 |
| CO-D12 (Q7) | Designated approvers for **supervisors and admins** (not employee-role users). An admin with a designated approver can't self-approve. | C2 |
| CO-D13 (Q8) | Changing a used charge code's labor category: allowed with the warning **and logged** (who, when, old, new). Gets the CO-D7 correction-vs-new-rate treatment in the follow-up. | C3 |
| CO-D15 (follow-up) | Corrections on unassigned **and deactivated** codes: change or zero out existing entries with a reason code; no new hours; locked periods stay locked. |
| CO-D16 (follow-up) | Built-in leave codes ship with their pay type pre-set (only custom codes can block the export). Unpaid leave stays on the record (daily-hours file, custom export). Export docs note: partial-day unpaid deductions from exempt salaries can risk exempt status — payroll accountant's call (documentation only). |
| CO-D17 (follow-up) | Unpriced hours must never make totals quietly shrink: every cost **and funding** total shows "X hours unpriced" linking to the report; the report tells the admin how to fix each entry. The founder tells the design partner when their numbers move (engineering provides a before/after report). |
| CO-D18 (follow-up) | Designee: a supervisor with no CLINs sees **only** the people they approve (plus themselves); the designee is a normal billable user (seat counting unchanged — all active users, `seats.ts:20`); mutual designation (owner ↔ bookkeeper) allowed. |
| CO-D19 (follow-up) | Self-approval returning: only when no other active admin **and** no active designee; every switch on/off is logged; the admin sees a notice when it comes back on; each self-approval records the active-admin count at that moment (and the last switch-on) in the audit trail; timesheets waiting on a deactivated approver are re-routed (new approvers notified). |
| CO-D14 (Q9) | Vendor payroll files carry **no** uncompensated-OT column; it lives in `custom` and the Daily hours detail. | C7 |


---

## 1. Verified current state (file:line, 2026-10-22)

### Migration import
- `src/server/actions/migration.ts:137-185` `importMigrationData`: no `lockEmployeeTimesheet`, no `assertEntryDatesEditable`,
  no future-date check; reason = file value or `'MIGRATION'` (`:164`); `createdAt` = file value (`:150-152`);
  `createdBy` = **employee** (`:167`). Rows accept Contract/CLIN or indirect codes only (`:88-119`) and insert **no
  `chargeCodeId`** (`:157-168`) → every imported direct row is CLIN-only; the per-cell unique index
  (`COALESCE(charge_code_id, indirect_code_id, clin_id)`) never collides with app charge-code entries on that CLIN/day.
  The file has no author column (`MigrationEntryRow`, `:11-21`).
- `:189-250` `importMigrationPeriods`: any status, `reviewedBy` = any user by email, any timestamps, no `period_events`,
  counts `onConflictDoNothing` skips as imported. `MigrationClient.periodValidated` set, never read.
- `period_events` (drizzle/0012) has **no backfill**; `scripts/seed-full.ts:358-365` writes approved periods without
  events; the old periods import never wrote events → pre-0012/seeded tenants have certified periods with no events.

### Approvals
- `src/server/internal/supervisor-scope.ts:20-60` scope = all users sharing an active CLIN (no role filter).
  `approvePeriod`/`rejectPeriod` call `assertCanAccessEmployee` (`periods.ts:302-306, 384-388`, `session.ts:140-147`)
  **before** anything else; `getTimesheetForReview` (`timesheet.ts:426`) and the approvals list `getScopedPeriods`
  (`periods.ts:455-460`, used by `ApprovalsClient`) are CLIN-scoped (`getScopedPendingApprovals` has no callers).
  Submission emails go to scoped supervisors (`periods.ts:114-131`). Approve/reject conditional on `status='submitted'`
  only (stale-version approve possible). Admin self-approval labelled (`reports.ts:104-115`).

### Reports
- LCAT cost join, **5 copies**: `src/server/internal/reports.ts:85`, `src/server/actions/reports.ts:276`,
  `src/server/actions/dashboard.ts:135, 202, 375`. `user_labor_categories` (no CLIN) LEFT JOINed on user+date, then
  `labor_categories` on `clin_id` → duplicates; dashboard inner-join variants double with overlapping same-CLIN
  assignments; all filter `status='active'`. They ignore `charge_codes.labor_category_id` (`schema.ts:233`) and
  `labor_categories.slin_id` (`:175`). `endUserLaborCategoryAssignment` always ends today (`labor-categories.ts:189-197`).
- `updateChargeCode` (`charge-codes.ts:105-106`) can move a used code's CLIN/SLIN; `ChargeCodesClient.tsx:119-125`
  always sends `clinId`; saves read the code outside the save transaction (`timesheet.ts:280-285`).

### Grid / review
- `getChargeCodesForEmployee` (`timesheet.ts:439-471`) = currently assigned + active codes only; entries for other codes
  invisible (`:555-569`); review uses the same path. `timesheet/page.tsx:30` loads codes once — period navigation keeps
  the first list. `TimesheetContext.tsx:217-218` sends every non-indirect row as `chargeCodeId` (a legacy CLIN row would
  be sent as `chargeCodeId = clinId`). Offline sync (`src/lib/offline/sync-service.ts`) maps cells similarly.
- Legacy CLIN save path: `validateClinAssignment` (`timesheet.ts:289`) accepts any employee holding a charge code on the
  CLIN, because `assignChargeCodeToUser` upserts `user_assignments` (`charge-codes.ts:156-161`) → new CLIN-only cells
  can be created today.

### PDF / audit trail
- `reports.ts:119-171`: rows from active CLIN assignments, hours keyed by `clinId` → indirect/leave dropped, same-CLIN
  codes overwrite, deactivated assignments vanish. `audit.ts:131` INNER JOIN `clins` → indirect entries missing;
  `getCellRevisionHistory` (`:146-176`) filters `clinId`.

### Payroll
- `payroll-export.ts:143-168` OT = `max(0, total − 80)`; ADP/Paychex "Regular" = min(total incl. leave, 80);
  `gusto` format (`:103-117`) has total hours only; the Gusto connector (`gusto.ts:151, 194-199`) reuses
  `aggregateEntriesByEmployee`; the formats are `adp`, `paychex`, `gusto`, `custom`. `escapeCSV` (`:199`) and
  `src/lib/reports/csv-generator.ts:18` have no formula guard (pattern exists: `workspace-export.ts:26`).
- `getApprovedEntriesForSync` (`sync-engine.ts:38-52, 86-90`) selects approved periods whose **start** is in the range
  and returns each period's full length; no indirect **category** (`:68-82`). The UI accepts any range
  (`PayrollExportClient.tsx:165`).

### Export / seed / cleanup
- `timesheet_entries` columns are defined in `src/lib/export/manifest.ts:31-44` + `timesheetSource`
  (`workspace-export.ts`), not `EXPORT_TABLES`. `clear-tenant-data.ts:39-41` resets only `workspace_settings.timezone`.
- `seed-full.ts` has supervisors approving periods and writes no `period_events`.
- `timesheet.ts:360-373` accepts `OTHER` with an empty comment.

---

## 2. Verified external facts

| Fact | Source |
|---|---|
| FLSA overtime: hours worked > 40 in a **workweek** (fixed recurring 168 h, employer-chosen); each workweek stands alone | 29 CFR 778.103–778.105 |
| Paid leave/holiday/vacation are not hours worked | 29 CFR 778.218–778.219 (payroll-accountant review, CO-D2) |
| `ADD COLUMN … DEFAULT <constant>` is metadata-only; no UPDATE trigger fires | PostgreSQL 11+ ALTER TABLE |
| Advisory locks: exclusive `pg_advisory_xact_lock` / shared `pg_advisory_xact_lock_shared` on the same key | PostgreSQL docs |
| Drizzle 0.45 lateral joins — dev agent confirms (`leftJoinLateral`); fallback correlated subqueries | node_modules/drizzle-orm |

---

## 3. Invariants

DCAA: `timesheet_entries`, `period_events` and the new `import_batches` are append-only (UPDATE/DELETE/TRUNCATE
triggers; provenance set only at insert); every hour attributable to who recorded it in this system; reason codes;
period lock (also during a reopened import window); charge-code denormalization — a used code's CLIN/SLIN never
changes. Imported rows labelled wherever shown or exported. **Lock order:** any transaction that takes the import-window
lock takes it **before** any `lockEmployeeTimesheet`. Approval rights enforced on the server. Calendar-date model.

---

## 4. Design

### C1 — Migration import (CO-D1)

**Schema — tenant migration `0014_certified_outputs` (additive):**
- `import_batches (id uuid pk, kind varchar(10) check in ('entries','periods'), source_system varchar(100) not null,
  imported_by uuid not null references users(id), imported_at timestamptz not null default now(), file_name
  varchar(255), row_count int not null, imported_count int not null, skipped_count int not null)` — inside the batch
  transaction, **after** all bulk pre-checks (exact under the window + per-employee locks), the batch row is inserted
  **first** with the final counts, then the entries / period rows / period_events referencing it (plain, non-deferrable
  FKs). Any unexpected insert conflict rolls back the whole batch. Append-only + TRUNCATE triggers like 0012/0013 (reuse
  `cadenzpoint_block_entry_mutation()`).
- `timesheet_entries` + `period_events` add `source varchar(20) not null default 'app'`, `import_batch_id uuid null
  references import_batches(id)`, `original_metadata jsonb null`.
- `workspace_settings` add `history_import_closed_at timestamptz null` and `workweek_start_day smallint null` (C7).
  **Backfill (conservative):** `history_import_closed_at = now()` if any `timesheet_periods` row has status ≠ `draft`
  **or** any `period_events` row with `event='submitted'` exists.
- `users` add `approver_id uuid null references users(id)` (C2); `timesheet_periods` add `submission_count int not null default 0` (C2).
- `period_events` add `approval_context jsonb null` — written only on a **self-approval** event:
  `{ selfApproved: true, activeAdminCount, effectiveDesignee: null, selfApprovalEnabledAt, selfApprovalEnabledBy }`
  (the latter two from the most recent `self_approval`/`enabled` row in `admin_change_log`). Insert-time only (table is
  append-only).
- `admin_change_log (id uuid pk, actor_id uuid not null references users(id), entity varchar(40) not null, entity_id uuid
  not null, action varchar(40) not null, old_value jsonb, new_value jsonb, created_at timestamptz not null default now())`
  — append-only + TRUNCATE triggers (reuse `cadenzpoint_block_entry_mutation()`); written in the same transaction as the
  change it records: charge-code labor-category change (CO-D13), charge-code deactivate/reactivate (CO-D8),
  `workweek_start_day` change (C7), approver designation change (C2), **self-approval switched on/off** (C2,
  `entity='self_approval'`, `entity_id` = the admin, `new_value` = `{ enabled, reason, activeAdminCount }`). Exported in
  the workspace export.
- `indirect_charge_codes` add `leave_pay_type varchar(10) null` with check (`pto|sick|holiday|unpaid`), required by the
  app when `category = 'leave'` (C7). Backfill by the seeded codes: `LV-AL`→pto, `LV-SL`→sick, `LV-HOL`→holiday,
  `LV-LWOP`→unpaid; other leave codes stay null (payroll export lists them and refuses until set).
- Index `user_labor_categories (user_id, effective_date)` if absent (check `drizzle/`).
- Control plane migration (**next free index, generated by drizzle-kit at implementation time — never hand-numbered**;
  launch-blockers adds `0007_cron_runs` and `0008_signup_controls`; if any other control-plane migration merges first,
  delete and regenerate this one so its journal `when` is the newest): `tenants.import_window_until timestamptz null`.

**Window:** open iff `workspace_settings.history_import_closed_at IS NULL` **or** `tenants.import_window_until > now`
(read **fresh** from the control plane inside the import, not the 60 s registry cache). `submitPeriod` runs
`UPDATE workspace_settings SET history_import_closed_at = $now WHERE id = 1 AND history_import_closed_at IS NULL` in its
transaction (no row lock on later submits). 0014 upserts the `workspace_settings` row so it always exists; a missing row
is treated as **closed**. Migration-imported periods never set it. `seed-full.ts` sets it when it seeds submissions.
The window check **also** treats the existence of any app-sourced `submitted` period_event as closed (covers old code
running between the 0014 migration and the deploy). If the control-plane read fails during an import → refuse the
batch (fail closed).

**Locking:** each import batch is one transaction: `pg_advisory_xact_lock(hashtext('workspace:import-window'))` →
re-check window → per employee `lockEmployeeTimesheet` (in a stable order: sorted user ids). `submitPeriod` takes
`pg_advisory_xact_lock_shared(hashtext('workspace:import-window'))` **as its first statement, before**
`lockEmployeeTimesheet` (invariant §3; prevents the A-waits-B deadlock).

**Entries import** (`importMigrationData`, `ActionResult`):
- Inputs: rows + `sourceSystem` (required, 1–100) + file name; optional new column **"Entered By"** (email or name of
  the original author; when absent `original_metadata.enteredBy = null`, displayed as "author not recorded").
- Window closed → refuse the batch ("Timesheet history can only be imported before your first submitted timesheet.
  Contact support if you need to import a missed period.").
- Per row (pre-checked in bulk queries, not per-row savepoints): entry date **before today** (workspace TZ);
  **overlap guard:** reject if the employee already has any entry that day for the same `clin_id` (app charge-code rows
  carry `clin_id`) or the same indirect code; **in-file duplicates:** a later row for the same (employee, cell code,
  date) as an earlier file row → row error; **lock guard:** reject entry dates inside **any `submitted` or `approved`
  period, whatever its source** (an imported approval must never cover hours added after it; a submitted period is in an
  approval queue). Required order, stated in the UI: import entries **first**, then periods. Hours rounded with the
  existing `validateHours` rule (2 decimals) before insert; per-cell uniqueness (existing).
  (Definition used by the periods import: a period is **imported** only if it has at least one `period_events` row with
  `source='migration'` and **no** app-sourced event; legacy periods with no events at all count as app periods.)
- Insert (multi-row) `createdBy = importing admin`, `createdAt = DB now`, `source='migration'`, `import_batch_id`,
  `changeReasonCode='MIGRATION'` (system-only; `REASON_LABELS` map adds "Imported (migration)"; `saveTimesheetBatch`
  keeps rejecting it; **create** `REASON_LABELS` in `src/lib/reason-codes.ts`), `comment` = file comment or "Imported from {sourceSystem}",
  `original_metadata = { enteredBy, enteredAt: file createdAt, reason: file reason, comment: file comment }` (strings verbatim).
- Batch limits: Next's server-action body limit is **1 MB** by default
  (`node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/serverActions.md`) — the UI splits
  files into batches of **≤ 2,000 rows, ≤ ~800 KB serialized and ≤ 200 distinct employees** for **both validation and
  import** (`validateMigrationData` is batched the same way — today `MigrationClient.tsx:106` sends the whole file); the
  **server refuses** a batch over 2,000 rows or 200 employees with a validation error; inserts in chunks of ≤ 1,000 rows
  per statement (Postgres 65,535 bind-parameter limit) inside the one transaction (one advisory lock per employee;
  `max_locks_per_transaction`). If the window closes partway through a multi-batch file, the UI reports which batches
  committed and which rows remain.

**Periods import:** same window/lock/batch. Row errors: a period whose **end date (start + numDays − 1) is not before
the workspace's today** (an imported current/future period would lock the employee's live timesheet forever — `approved`
is terminal); status `draft` (nothing to certify — only `submitted`/`approved`/`rejected` are importable). Pre-check
existing `(user_id, period_start)` rows under the locks (no `onConflictDoNothing`); refuse a (user, period) that already has **any** period row that is not an imported one (per the
definition above) or app-sourced entries in that period. Insert the period with `reviewedBy = null`, `submittedAt/reviewedAt = null`, and write
`period_events` (`submitted`, plus `approved`/`rejected`) with `actor_id = importing admin`, `source='migration'`,
`import_batch_id`, `original_metadata = { reviewer: file email verbatim, submittedAt, reviewedAt, comment }`. Count only
pre-checked inserts; duplicates = skipped. UI requires validation before Import (`periodValidated`).

**Display:** grid (cell indicator + tooltip), approval review, audit trail, revision history, PDF, workspace export,
and the **v1 API** (`/api/v1/timesheets`, `/periods`, `/timesheets/approved` return `source` and, for migration rows,
`importedFrom`/`importedAt`; imported approvals return `approvedBy: null` + `approvalSource: 'migration'`):
"Imported from {source system} on {import date} by {admin}" + "originally entered by {enteredBy ?? 'author not
recorded'} on {enteredAt}". Imported approval on the PDF: "Approved in {source system} by {reviewer} on {date} (imported
{import date})". `period_events.actor_id` export description notes that for migration rows the actor is the importing admin.

**Escape hatch:** `tenant:admin reopen-import-window <slug> --days <1-30> --reason "…" --yes` (locked, versioned,
audited `import-window-reopened`); `show` prints window state (`history_import_closed_at` via the tenant DB + reopen
expiry). Lock and overlap guards still apply while reopened. A missing/empty `--reason` is refused by argument
validation before any write (nothing audited).

### C2 — Approver rules (CO-D5, CO-D6, CO-D9, CO-D12)
- `src/server/internal/approval-rules.ts`:
  - `reviewScope(actor)` = admin → all; supervisor → (users sharing an active CLIN) ∪ (users whose
    `effectiveDesignee` = actor — supervisors **and admins** who designated them) ∪ self.
  - **One scope everywhere (CO-D18):** `getEmployeeScope` and `assertCanAccessEmployee` (`src/lib/session.ts:127-147`)
    delegate to `reviewScope`, so the designee can open everything a review needs (cell revision history, audit trail,
    hours reports, PDF) for the people they approve — and a supervisor with **no CLINs** sees exactly {self, the people
    who designated them}. Empty-scope handling in consumers stays as today (`periods.ts`, `reports.ts`, `audit.ts`
    return `[]`). Dollar views stay admin-only (fresh role, launch-blockers P3).
  - `effectiveDesignee(employee)` = `employee.approverId` when the employee's role is **supervisor or admin** and the
    designee is active with role admin/supervisor (fresh), else null.
  - `canApprove(actor, employee)` — **self** (actor = employee): only if actor is admin **and** no other active admin
    exists **and** `effectiveDesignee(actor)` is null (CO-D6/CO-D12; evaluated at approve time, so adding a second admin
    or a designee switches it off immediately — also for an already-submitted timesheet); recorded and labelled
    "Self-approved" with `approval_context` (CO-D19). **Other admin** → true. **Supervisor** → (`effectiveDesignee(employee) === actor.id`) **or** (`employee.role === 'employee'` and shares an active CLIN); otherwise false.
    A designated approver who is deactivated or no longer admin/supervisor (fresh role) → false (and the supervisee falls
    back to admins).
- Order in `approvePeriod`/`rejectPeriod`: `requireApproverFresh` → load period → **explicit non-admin self-approval
  refusal (existing message, kept so existing tests hold)** → **admin self-approval no longer allowed** (second admin
  or designee exists) → explicit message "Your timesheet must be approved by another admin or your designated approver."
  → `canApprove(actor, employee)` → false → "not found" (no disclosure). `assertCanAccessEmployee` is **replaced** for these paths by `reviewScope`/`canApprove`.
  `reviewScope` includes the actor themselves for viewing (own rows listed, own PDF), as today.
- `getTimesheetForReview`, the timesheet PDF route and `getScopedPeriods` use `reviewScope` (so designees see their
  supervisees); `getScopedPeriods` returns `canApprove: boolean` per period; ApprovalsClient shows "You can view but not
  approve this timesheet" when false. Other view paths (audit trail, reports) unchanged (CO-D9).
- **"Self-approved" label everywhere** a timesheet's approval appears: approvals list + review, timesheet page status,
  PDF approval line, hours/approval reports, audit trail period events, v1 API (`selfApproved: true`), workspace export
  (derived column). One helper `approvalLabel(period, events)` used by all of them; static test: no other code formats
  the approver line.
- **Self-approval switch (CO-D19):** `selfApprovalAvailable(admin)` = admin active **and** no other active admin
  **and** no effective designee. `recomputeSelfApproval(tx, actorId)` (internal) compares it before/after for every
  active admin and writes one `admin_change_log` row per change (`enabled`/`disabled`, reason e.g. "admin X
  deactivated", `activeAdminCount`). Called **in the same transaction** by every write path that changes `users.role`,
  `users.is_active` or `users.approver_id` — the dev agent inventories them (`users.ts` create/update/deactivate/
  reactivate, bulk user import, designation change, …); a static test asserts each such function calls it. When a
  switch turns **on**, the admin sees a notice on the dashboard and Approvals page: "Self-approval is back on: you're
  now the only active admin and have no designated approver. Consider designating one." (shown until dismissed;
  dismissal keyed by the log row id in `localStorage`). **Ruling Q5:** `createUser`, `createUserWithPassword` and
  `bulkImportEmployees` gain a transaction so the recompute runs inside it; `provisionTenant` writes the baseline
  `self_approval`/`enabled` row (reason "workspace created", actor = the first admin) only when it inserts that admin
  (a resumed provisioning never writes a second one); `scripts/**`, `clearTenantData` and test helpers are exempt from
  the static "every writer calls it" check, but `seed-full.ts` calls `recomputeSelfApproval` once after seeding users so
  demo data has the same history.
- **Re-routing (CO-D19):** approval is never assigned to a person — `canApprove` is evaluated live — so a waiting
  timesheet is approvable by whoever qualifies now. After any change above commits, `after()` sends the existing
  "timesheet waiting for approval" email for every **submitted** period whose eligible-approver set gained someone,
  to the newly eligible recipients only (same submitter exclusion).
  **Ruling Q8:** losing a timesheet's **effective designee** (deactivated, demoted, or the designation removed/changed)
  is also a re-routing event: email that timesheet's **current** approvers (normally the admins), even though they were
  eligible before — they reasonably assumed the designee would handle it. Same email template, same submitter exclusion
  and admin notification opt-in, plus one line: "Its designated approver is no longer available." One email per waiting
  timesheet per event.
- **Setup recommendation:** while the workspace has exactly one active admin and that admin has no effective designee, the
  admin dashboard and the Users page show a dismissible notice: "Auditors prefer an independent reviewer. Designate
  another officer or your bookkeeper (supervisor role) to approve your timesheets." (Dismissal stored per admin in
  `localStorage`; the notice returns after sign-in — no schema change.)
- Submission notification recipients = users for whom `canApprove(recipient, employee)` is true (admins who opted in +
  designated approver + in-scope supervisors when the employee is employee-role), **excluding the submitter** (existing
  filter, `periods.ts:134`). The Approvals scope banner / "No employees in your scope" state counts designees too.
- User management: "Approver" select for **supervisor- and admin-role users** (CO-D12), options = active admins +
  supervisors ≠ self; server validates (`requireAdminFresh`) and logs the change to `admin_change_log`; demoting or
  deactivating an approver leaves `approver_id` set but ineffective (rule above). `approverId` is honoured **only while
  the employee's role is supervisor or admin** (a user demoted to employee falls back to the normal employee rule). The
  select is hidden for employee-role users (CO-D12).
  Circular designation (A→B, B→A) is allowed by data but harmless: each still can't approve themselves; admins remain
  approvers.
- **Approve exactly what was reviewed:** `submitPeriod` increments `submission_count`; `getTimesheetForReview` returns it;
  approve/reject require `seen` (server rejects a missing value); the review loads `submission_count` in the same
  query/snapshot as the entries; Approve/Reject stay disabled until the review data has loaded;
  `UPDATE … WHERE id=$1 AND status='submitted' AND submission_count=$seen RETURNING` → zero rows → re-read the row:
  status still `submitted` with a higher count → `ConflictError("This timesheet was resubmitted after you opened it —
  refresh to review the new version.")`; status no longer `submitted` → existing "just reviewed by someone else" message.

### C3 — Cost / hours reports (CO-D7, CO-D8, CO-D10, CO-D13)
- `src/server/internal/cost-basis.ts` = the only LCAT resolution: per entry, the applicable labor category is
  1. `charge_codes.labor_category_id` when the entry has a charge code with one set; else
  2. the employee's assignments (`user_labor_categories` × `labor_categories`) effective on the entry date whose
     `lc.slin_id = entry.slin_id` (entry has a SLIN); else
  3. the employee's assignments effective on the date with `lc.clin_id = entry.clin_id` **and `lc.slin_id IS NULL`**
     (CLIN-level).
  At the first level that has candidates: exactly **one distinct labor category** → priced with it; **two or more
  different labor categories** → **unpriced** (never pick one). No candidates at any level → **unpriced** (a SLIN-level
  category on a different SLIN does not apply). Unpriced entries carry `costBasis: 'unpriced'`, count in hours totals,
  contribute **no** cost. **Never quietly shrink (CO-D17):** next to **every** cost and **funding-used** total —
  contract/CLIN/SLIN dashboard cards and funding bars (`dashboard.ts`), cost reports, report CSV/PDF exports — show
  "X hours unpriced" linking to the Unpriced hours report (the count is scoped to the same contract/CLIN/SLIN and date
  range as the total it sits next to); funding bars label the figure "priced cost" while X > 0. **No `status` filter.** Implemented as one lateral join
  (or correlated subqueries) returning exactly one row or none; all 5 call sites use it, including the SLIN cost query.
- Static test: `userLaborCategories` / `laborCategories` may be imported by report/dashboard query modules only through
  `cost-basis.ts` (allowlist of files; fails on any other import).
- No new overlap refusal. New admin reports on the Labor Categories page: **"Unpriced hours"** (employee, date, code,
  hours, reason, **how to fix**: `no-category` → "Set a labor category on charge code {code}, or give {employee} a labor
  category on {SLIN or CLIN} effective {date}" with links; `conflict` → "{employee} has {A} and {B} on {CLIN/SLIN}
  effective {date} — end one" linking to the overlap report) and "Overlapping labor-category assignments" (list).
- **Before/after report for the founder (CO-D17):** `scripts/report-cost-basis-change.ts` (`npm run
  report:cost-basis-change -- <slug>`, read-only, target banner) prints per contract/CLIN/SLIN: cost under the old
  resolution (today's join, frozen into the script), cost under `cost-basis.ts`, the difference, and unpriced hours — run
  before and after deploying C3 so the founder can tell the design partner what moved. `endUserLaborCategoryAssignment` gains an optional end date (≥ effective date; default today) so a
  promotion can end yesterday/start today.
- `updateChargeCode`: compare against the stored row; refuse a **changed** `clinId`/`slinId` when entries reference the
  code; changed `laborCategoryId` on a used code → allowed and logged with an `admin_change_log` row (old, new) in the
  same transaction (**ruling Q3:** the charge-code form has no labor-category field, so C3 adds **no** UI and no
  warning; the UI arrives with `feature-plan-dated-rates.md` D3). `SELECT … FOR UPDATE` the code in the
  update; `saveTimesheetBatch` **re-reads** each charge code's `clin_id`/`slin_id` inside its transaction with
  `FOR SHARE` and uses those values for the insert (not the values cached before the transaction).
- **Reactivate charge code** (CO-D8): new `reactivateChargeCode(id)` (`requireAdminFresh`, `ActionResult`) sets
  `is_active = true` and logs to `admin_change_log`; `deactivateChargeCode` logs too. **Ruling Q2:** neither deactivation nor
  reactivation touches user assignments (deactivation never removed them, `charge-codes.ts:114-120`), so reactivating
  gives the code back to everyone still assigned — what CO-D8's cases (mistake, option year, extension) want. The
  reactivate confirm dialog says "{N} employees are still assigned and will see this code again" and the log row
  records N; the code is assignable again only if its CLIN and contract are active (existing rule; the UI says so).
- Report UI/footers: "Costs use current labor-category rates." (CO-D7 interim.)
- **Ruling Q6 (CO-D17 on exports and the API):** the CSV and XLSX cost exports carry the unpriced count (there is no
  cost PDF); `/api/v1/costs` gains an **additive** `unpricedHours` field next to every cost total it returns (no field
  removed or renamed, so existing integrations keep working); mention it in the "API key created" dialog text.

### C4 — Grid and review show every recorded hour; corrections on unassigned codes (CO-D8)
- `ChargeCode` gains `kind: 'charge' | 'clin' | 'indirect'` and `assignable: boolean`. `assignable` = for `charge`:
  in today's assignable set (`timesheet.ts:464-471`); for `indirect`: active; for `clin`: **always `false`** (ruling Q1 — new
  CLIN-only cells are always refused; legacy CLIN rows are correction-only).
- **Correction rule (CO-D8, CO-D15), one rule for every kind:** in any row, a day **with a prior revision** is
  correctable — changed or **zeroed out** (a new revision with 0 hours) — (reason code required — existing rule, `timesheet.ts:356-372`) whether or not the code is still assigned or active;
  a day **without** a prior revision is editable only when the row is `assignable`. Submitted/approved periods stay
  locked (`assertEntryDatesEditable`, unchanged).
- `getTimesheetPeriod(periodStart)` returns that period's code list = assignable codes ∪ every code (charge, legacy CLIN,
  indirect) with any latest-revision entry in the period (0-hour rows included); the client replaces `state.chargeCodes`
  on navigation. Non-assignable rows show "No longer assigned — you can correct existing hours, not add new ones";
  their empty days are read-only.
- Save mapping by `kind` in `TimesheetContext` and `sync-service.ts` (`charge` → `chargeCodeId`, `clin` → `clinId`,
  `indirect` → `indirectCodeId`).
- Server (`saveTimesheetBatch`): the assignment / active-code checks run **per cell after `priorRevision` is read
  inside the transaction** and apply only to cells with `priorRevision = 0`; cells with `priorRevision > 0` skip them
  (still reason-code + period-lock checked). **Ruling Q4:** for a new charge-code cell the check is the full assignable
  rule — active assignment **and** active code (and active CLIN/contract), using the in-transaction `FOR SHARE` re-read
  from C3 — so new hours on a deactivated code are refused (intended, CO-D8/CO-D15). **Legacy CLIN cells only where
  `priorRevision > 0`** (closes the existing
  path that creates new CLIN-only cells); for a legacy CLIN cell the server **copies `slin_id` from that cell's
  prior revision** and rejects a client-sent `slinId` that differs. UI: in legacy rows only days with a prior revision
  are editable (others read-only), so one stray value can't fail an all-or-nothing save. Offline queue items (dormant path) store `kind`; items without it are treated as `charge`.
- Review uses the same function → approver sees every recorded hour.

### C5 — Timesheet PDF from entries
Rows from latest-revision entries grouped by true cell code (charge/CLIN/indirect, with category), summed per code-day;
grand total = sum of entries; approval line per C1/C2 (in-app, "Self-approved", or imported); stable on reprint
(**ruling Q7:** rows, totals and the approval line are identical on every reprint; the footer's generation time stays). Access
via `reviewScope`.

### C6 — Audit trail
LEFT JOINs (indirect included, category shown); filter by true cell code; `getCellRevisionHistory(userId, cellCode,
entryDate)` uses `COALESCE(charge_code_id, indirect_code_id, clin_id) = cellCode`; returns provenance; UI labels imported
rows and `MIGRATION` via `REASON_LABELS`.

### C7 — Payroll export (CO-D2, CO-D11, CO-D14)
- Setting `workspace_settings.workweek_start_day` (0–6, **0 = Sunday**, matching dayjs `day()`), Settings page (admin),
  **no default**; once set, changing it shows a warning that FLSA requires a fixed workweek (29 CFR 778.105) and is
  recorded in `admin_change_log`; both stated in `docs/payroll-overtime-method.md`; payroll export and the
  Gusto payroll push refuse until set.
- Data (`src/server/internal/payroll-data.ts`): **all latest-revision entries** in
  `[workweekStart(rangeStart), rangeEnd]` regardless of approval, with indirect **category** and each date's containing
  period status. The FLSA walk uses all of them (so an unapproved day earlier in any workweek still counts toward 40);
  the **output** includes only in-range dates whose containing period is **approved** (fixes the period-start
  selection). Employees whose OT basis includes unapproved days are flagged `otBasisIncludesUnapprovedDays`.
- `src/lib/payroll/flsa.ts` (pure; all arithmetic in **integer hundredths of an hour** to avoid float residue at 40 h):
  per employee per date `{ worked, pto, sick, holiday, unpaidLeave }` (leave buckets by the indirect code's
  `leave_pay_type`; everything not `leave` is worked). **Leave of any kind never counts toward the 40 hours**
  (29 CFR 778.218–219); unpaid leave is never in a paid column; per workweek, walk dates in order; hours beyond the 40th worked hour are OT on the day they
  occur; output per in-range date `regular`, `overtime` (non-exempt), `uncompensatedOvertime` (exempt; OT = 0), `pto`,
  `sick`, `holiday`, `unpaidLeave`. Export refuses (listing the codes, link to Indirect Codes) while any leave code used
  in the range has no `leave_pay_type`; Indirect Codes page gains the field (required for category `leave` — so new
  custom leave codes always have one). **Built-in leave codes are pre-set (CO-D16):** `seedIndirectCodes` creates
  LV-AL/LV-SL/LV-HOL/LV-LWOP with pto/sick/holiday/unpaid, and the 0014 backfill sets them on existing tenants; only
  pre-existing custom leave codes can block. Unpaid leave hours appear in the Daily hours detail and `custom` export
  (never in a paid column).
- Formats (all four defined):

  | Format | Columns from flsa.ts |
  |---|---|
  | `adp` | Regular Hours = regular **worked** only; OT Hours; new **PTO Hours**, **Sick Hours**, **Holiday Hours**; Total Hours = Regular + OT + PTO + Sick + Holiday (paid hours; uncompensated OT and unpaid leave excluded). No uncompensated-OT column (CO-D14) |
  | `paychex` | Hours (REG) = regular worked; OT Hours (OT); new pairs **PTO Hours / PTO Earnings Code**, **Sick Hours / Sick Earnings Code**, **Holiday Hours / Holiday Earnings Code** (codes `PTO`, `SICK`, `HOL`, blank when 0). No uncompensated-OT column |
  | `gusto` (CSV) | Today one `hours` column = total (`payroll-export.ts:110-116`). New columns: `employee_email`, `employee_name`, **`regular_hours`** (regular worked only), **`overtime_hours`**, **`pto_hours`**, **`sick_hours`**, **`holiday_hours`**, `pay_period_start`, `pay_period_end`; the old `hours` column is **removed** (no double pay). Sum of the hour columns = total paid. Verifying names against Gusto's import spec is a staging check, not assumed |
  | Gusto "push" (`gusto.ts`) | **Stays a recorded payload — no Gusto API call** (none exists today, `gusto.ts:173-205`; a real integration is out of scope). Payload per employee: regular (worked), overtime, pto, sick, holiday, uncompensated overtime, flagged. `executeSyncOperation` branches the Gusto connector to `payroll-data` (QBO stays on `getApprovedEntriesForSync`) and refuses **before** creating a sync log when the workweek isn't set |
  | `custom` | existing billable / non-billable columns kept, plus Regular worked, OT, Uncompensated OT, PTO, Sick, Holiday, Unpaid leave, Total paid, **Total recorded** (all hours, paid or not) |
  | **Daily hours detail** (new CSV) | employee, date, worked, regular, overtime, uncompensated overtime, pto, sick, holiday, unpaid leave, workweek start used |

  Vendor column names/earnings codes are this blueprint's best layout, **not verified against the vendors' import
  specs** — verifying them is a staging check before marketing payroll export.

  UI + filenames: "FLSA weekly overtime". Flagged employees listed in the UI before download.
- `src/lib/csv/escape.ts` (RFC 4180 incl. CR + `FORMULA_PATTERN`) used by payroll, `csv-generator.ts`, and re-exported
  by the workspace export.
- `docs/payroll-overtime-method.md` (required before production): method, leave exclusion, boundary-week rule, Regular
  leave columns and pay types (CO-D11), a customer-facing note that **deducting partial days of unpaid leave from an
  exempt employee's salary can put the exemption at risk under federal rules — the payroll accountant's call**
  (CO-D16; also linked from the export screen's help text), the fact that workweek setting and `flsa_exempt` are current values (not effective-dated) — for
  the payroll accountant review.

### C8 — Small items
- `OTHER` reason requires a non-blank comment (server + client); the existing comment length rule applies (no new limit).
- Workspace export: entries/period_events provenance columns in `manifest.ts`/`timesheetSource`; `import_batches` table;
  `users.approver_id`, `timesheet_periods.submission_count`, `workspace_settings.history_import_closed_at` +
  `workweek_start_day`, `indirect_charge_codes.leave_pay_type` in the allowlist with descriptions; `admin_change_log`
  exported as its own file; new test: every table in the tenant schema is either exported
  or on the never-exported list.
- `clearTenantData`: delete `import_batches` after `period_events`/entries, and `admin_change_log`, before users
  (inside the existing bypass);
  reset `workweek_start_day` and `history_import_closed_at` with the timezone.
- `seed-full.ts`: write `period_events` for seeded submissions/approvals (source `app`), approvals by admins or
  designated approvers only (C2-conformant), set `workweek_start_day` for demos, designate an approver for seeded
  supervisors; `seedIndirectCodes` and the seeder set `leave_pay_type` on leave codes.

---

## 5. State machines

### Import window
| State | Event | Next | Side effects |
|---|---|---|---|
| open (`closed_at` null) | import batch | open | inserted in one tx under the window lock |
| open | first `submitPeriod` | closed | `history_import_closed_at` set in the submit tx |
| (migration) existing tenant with any non-draft period / submitted event | 0014 backfill | closed | — |
| closed | import | closed | refused, nothing written |
| closed | founder reopen N days | reopened until T | control-plane audit, version bump |
| reopened | import (now < T) | reopened | inserted; lock + overlap guards still enforced |
| reopened | now ≥ T | closed | — |
| open | import concurrent with first submission | serialized | window lock (exclusive vs shared), lock order invariant |

### Approval
| Period | Actor | Event | Result |
|---|---|---|---|
| submitted (n) | admin | approve/reject seen n | decided + event |
| submitted (n) | any | seen ≠ n | ConflictError |
| submitted | supervisor; employee-role, shares CLIN | approve | decided |
| submitted | supervisor; employee-role, no shared CLIN, not designated | approve/list | not visible / not found |
| submitted | supervisor; supervisor-role employee, not designated | approve | not found (visible read-only if CLIN shared, CO-D9) |
| submitted | designated supervisor (no shared CLIN) | list/review/approve | visible, approvable |
| submitted | designee demoted/deactivated | approve | refused (fresh role); admins approve |
| submitted | supervisor; admin employee, not that admin's designee | approve | not found |
| submitted | supervisor designated by an admin | list/review/approve | visible, approvable |
| submitted | admin self; sole active admin, no designee | approve | decided, "Self-approved" |
| submitted | admin self; a second active admin **or** an effective designee exists | approve | refused with explicit message |
| submitted | other admin | approve | decided |
| submitted | non-admin self | approve | refused |
| draft/approved/rejected | any | approve | refused (conditional update) |

---

## 6. Failure modes

| Failure | Behavior |
|---|---|
| Invalid rows in a batch | reported per row; valid rows inserted; DB error → whole batch rolled back |
| Import overlapping app hours (same CLIN/day) | row refused |
| Import into an app-locked period (reopened window) | row refused |
| Import entries into any submitted/approved period (incl. imported) | row refused — import entries before periods |
| Import a period ending today or later | row error (would lock the live timesheet) |
| Control-plane read fails during import | batch refused (fail closed) |
| Window closes mid multi-batch file | committed batches reported; remaining rows listed |
| Import vs first submission | serialized; no partial batch after a submission |
| Lock-order violation | prevented by invariant + test |
| Reopen without reason | refused |
| Designee loses role | fresh check refuses; admins approve (a sole admin whose designee lost the role may self-approve again) |
| Second admin deactivated | sole-admin self-approval available again **only if** that admin has no active designee; `enabled` logged; notice shown; waiting timesheets' new approvers emailed |
| Leave code without pay type | payroll export refused, codes listed |
| Two different labor categories at the same level | entry unpriced, listed in Unpriced hours |
| Stale review approve | ConflictError |
| Charge-code CLIN change racing a first save | `FOR UPDATE` / `FOR SHARE` serialize; the later sees entries / the new CLIN consistently |
| Payroll export without workweek setting | refused with link to Settings |
| Boundary days unapproved | counted, employee flagged |
| Import batch too large for one request | UI splits by rows and serialized size; server chunks inserts |
| Unexpected conflict mid-batch | whole batch rolls back (batch row included) |

---

## 7. Platform limits

Import batches ≤ 2,000 rows / ~800 KB / 200 employees (server-enforced), bulk pre-checks + multi-row inserts (keeps the exclusive window lock short). Payroll: range
+ ≤ 6 preceding days. Lateral LCAT join is indexed.

---

## 8. Blast radius

Tenant schema + migration 0014 (tables, columns, triggers, backfill, index); control plane migration (next free index);
`registry.ts` (TenantRecord), `admin-commands.ts`, `scripts/tenant-admin.ts`; `migration.ts` + `MigrationClient`;
`src/server/internal/{import-window,approval-rules,cost-basis,payroll-data}.ts` (new); `periods.ts` (shared lock,
`history_import_closed_at`, `submission_count`, `canApprove`, recipients); `supervisor-scope.ts`, `src/lib/session.ts`;
`users.ts` + user management UI; `ApprovalsClient`; timesheet PDF route + `reports.ts` + PDF template; `audit.ts` + UI;
`timesheet.ts` (period code lists, kinds, legacy CLIN rule, `FOR SHARE`, OTHER), `timesheet/page.tsx`,
`TimesheetContext.tsx`, grid components, `src/lib/offline/sync-service.ts`, `src/types/timesheet.ts` (`kind`,
`assignable`); `labor-categories.ts` + Labor Categories page (overlap report, end date); `charge-codes.ts`;
`dashboard.ts`, `server/internal/reports.ts`, `server/actions/reports.ts`; `payroll-export.ts` (connector + action +
client), `gusto.ts`/`gusto-api.ts`, `sync-engine.ts` (no change to the QBO path except via shared data helpers),
`src/lib/payroll/flsa.ts`, `src/lib/csv/escape.ts`, `csv-generator.ts`; `workspace-export.ts`, `manifest.ts`,
`allowlists.ts`; Settings page; `indirect-codes.ts` + Indirect Codes page (`leave_pay_type`); admin dashboard + Users page (designee notice); `src/server/internal/approval-label.ts` (new); `src/lib/session.ts` (scope delegation); `scripts/report-cost-basis-change.ts` (new) + npm script; dashboard funding cards; `src/lib/reason-codes.ts` (`REASON_LABELS`); `scripts/seed-full.ts`,
`src/db/clear-tenant-data.ts`, integration helpers, `src/app/api/v1/{timesheets,periods,timesheets/approved}/route.ts`;
existing tests needing updates: `authorization.test.ts`, `fresh-authorization.test.ts`, `dcaa-concurrency.test.ts`
(approve/reject now take `seen`), `calendar-dates-fixes.test.ts` (`importMigrationPeriods` signature/result); docs `docs/payroll-overtime-method.md` (new), PRODUCTION-DEPLOY
(founder command), export README.

---

## 9. Required test matrix (each fails without its fix)

| Area | Scenario |
|---|---|
| Window | open before any submission; closed after the first app submission (nothing written); imported submitted events don't close it; tenant with an approved period and **no** events is closed after 0014 backfill; founder reopen allows until T, refuses after (clock injected); reopen without reason refused, nothing written; old-code app `submitted` event without the flag → closed; control-plane read failure → batch refused |
| Periods import dates | period ending today or later → row error; `draft` row → row error; entries into an imported approved period → refused (import entries first) |
| Batch limits | 2,001 rows or 201 employees → server validation error; validation of a large file is batched (no 1 MB failure); partial multi-batch close reports committed batches |
| Gusto / exempt | Gusto CSV has `regular_hours`, `overtime_hours`, `pto_hours`, `sick_hours`, `holiday_hours`, no `hours`; columns sum to total paid; exempt employee: OT 0 in vendor files, uncompensated OT in custom + daily detail |
| Grid assignable | legacy CLIN row: days with a prior revision correctable (assigned or not), empty days always read-only and a new CLIN-only cell refused by the server (ruling Q1); new hours on a deactivated charge code refused (ruling Q4); reactivating a code restores it to still-assigned employees (ruling Q2); deactivated charge code row: existing days correctable, empty days read-only |
| Approver | supervisor demoted to employee: former designee can't approve (no shared CLIN); admin designates a supervisor (bookkeeper) → that supervisor lists, reviews and approves the admin's timesheet; admin with a designee → self-approve refused with the explicit message; second active admin created → first admin's pending self-approval refused, second admin approves; second admin deactivated → sole admin can self-approve again; Approver select shown for admin + supervisor users, hidden for employees; designation change logged |
| Self-approved label | label present on approvals list, review, timesheet status, PDF, report, audit trail, v1 API, export (one helper; static test) |
| Corrections (CO-D8) | unassigned charge code: existing day corrected with reason → saved; new day on that row → refused (server) and read-only (UI); deactivated code: correction allowed; correction in a submitted/approved period refused; `reactivateChargeCode` logs + code assignable again only with active CLIN/contract; deactivate logged |
| Unpriced | entry with no applicable category → unpriced, hours counted, no cost, listed with `no-category`; two categories at the CLIN level same date → unpriced `conflict`; SLIN-level category on a different SLIN → unpriced (not borrowed); footer count shown |
| Leave columns | 40 h worked + 8 h holiday → 0 OT, Holiday 8 in its own column (not Regular); LWOP never in a paid column; leave code without pay type → export refused; ADP Total = Regular + OT + PTO + Sick + Holiday; backfill maps LV-AL/SL/HOL/LWOP |
| Self-approval switch | deactivating the second admin writes `self_approval enabled` (with count 1) and shows the notice; with an active designee nothing is enabled; reactivating the admin / designating someone writes `disabled`; self-approval event carries `approval_context` (activeAdminCount, enabledAt/By) and the audit trail shows it; static test: every role/is_active/approver_id writer calls `recomputeSelfApproval`; waiting timesheet of a supervisor whose designee is deactivated → admins emailed, approvable |
| Designee scope | supervisor with **no CLINs** designated by X: approvals, review, revision history, audit trail, hours reports, PDF show exactly {self, X}; no other employee anywhere; admin-only writes refused (P3); mutual designation owner ↔ bookkeeper works both ways |
| Unpriced visibility | dashboard funding bar with unpriced hours shows "X hours unpriced" + link and "priced cost"; cost report CSV/PDF carry the count; Unpriced report rows show the fix text with working links; `report:cost-basis-change` prints old vs new per CLIN (read-only) |
| Leave pre-set | new workspace after `seedIndirectCodes` exports payroll without setting any pay type; unpaid leave in daily detail + custom (`Total recorded` includes it, `Total paid` doesn't); correction to 0 hours on a deactivated code saved with reason |
| Change log | LCAT change on a used code, deactivate, reactivate, workweek change, approver change each write one `admin_change_log` row (old/new); UPDATE/DELETE/TRUNCATE blocked; table in the workspace export |
| Import race / locks | import batch vs first submitPeriod on separate connections: batch fully before or refused; **lock-order test**: concurrent import (employees A,B) and submits by A and B never deadlock |
| Import guards | reopened window: approved period with **no events** (legacy) → entry import refused; date inside any submitted period → refused; row for a CLIN/day where the employee has app charge-code hours on that CLIN → refused; same indirect code/day → refused; reopened window: date inside an app-approved period refused; date inside an imported-approved period refused; future date refused; existing cell → row error |
| Batch integrity | every `import_batch_id` resolves to a batch row; batch counts equal rows inserted; in-file duplicate → row error (not batch failure); DB error mid-batch → nothing written; 2,000-row / ~800 KB batch succeeds |
| Attribution | `createdBy` = admin, `createdAt` ≈ now, `source='migration'`, batch row (source system, admin, counts), `original_metadata` (Entered By present / absent); `MIGRATION` refused by `saveTimesheetBatch`; `import_batches` UPDATE/DELETE/TRUNCATE blocked |
| Period import | `reviewedBy` null; events written with source migration + original reviewer; duplicates skipped (not counted); refused where app rows exist |
| Display | grid/review/audit/revision/PDF/export label migrated rows (source, date, admin; original author or "not recorded") |
| Approver (base) | supervisor can't approve a CLIN-sharing supervisor; designated supervisor with **no shared CLIN** lists, reviews, approves; designee demoted → refused; can't approve an undesignating admin; approves CLIN-sharing employee; sole-admin self-approval "Self-approved"; Approver select rejects self/non-approver; viewable-not-approvable message; submission email goes to the designee and not to a peer supervisor |
| Stale approval | open (n) → reject + resubmit (n+1) → stale approve refused with "resubmitted"; another reviewer decided first → "just reviewed"; missing `seen` refused; fresh approve OK |
| Approval rows | draft/approved/rejected → refused; employee-role, no shared CLIN, not designated → not found; non-admin self-approval → existing explicit message; admin's own submission doesn't email the admin |
| Cost basis | changing a used code's LCAT shows the CO-D13 warning; charge code with LCAT uses it; SLIN-matched assignment used for a SLIN entry; employee with LCATs on two CLINs: summary hours = true hours, one detailed row per entry; deactivated LCAT keeps historical cost; overlap report lists overlaps; promotion (end yesterday, start today) works; static import test |
| Charge code | CLIN change racing a first save: the save uses the in-transaction values (no entry with a stale CLIN); changing CLIN/SLIN of a used code refused; unchanged `clinId` sent by the client accepted; unused code editable |
| Grid/review | legacy CLIN correction keeps the prior revision's SLIN, a differing client SLIN refused; legacy row days without a prior revision read-only; per-period code list on navigation; hours on a deactivated code visible to employee and approver (existing days correctable, CO-D8); legacy CLIN row visible and saved by kind; new legacy CLIN cell refused, existing one correctable |
| PDF | indirect/leave rows; two codes on one CLIN same day both present; total = sum; stable reprint |
| Audit | indirect entries appear; sibling codes separate histories; MIGRATION label |
| FLSA | range over two periods, the first unapproved, workweek crossing the boundary → unapproved days count toward 40, only approved in-range days output, employee flagged; 40.00 h exactly → 0 OT (integer hundredths); Gusto push payload has regular/OT/leave/uncompensated and refuses before a sync log without the workweek setting; 45 h week → 40 + 5 OT; exempt → 0 OT + 5 uncompensated; leave excluded from 40 and shown in its own columns in every format; boundary week across two semi-monthly exports: preceding days counted, no double count; arbitrary range (mid-period start) includes in-range days of a period that started earlier; unapproved preceding days flagged; refused without workweek setting; Gusto CSV + connector carry OT; `custom` columns |
| CSV | formula-leading values prefixed `'` in payroll + report CSVs; plain negatives untouched; CR quoted |
| Export | provenance columns, `import_batches` file, new columns described; every tenant table exported or never-exported; v1 API returns `source` / imported approval fields |
| Seed/cleanup | `clearTenantData` with the new table + column resets; seeded data passes C2 rules and has events |
| OTHER | blank comment refused |

---

## 10. Verification

```bash
npx tsc --noEmit && npm run lint && npm run test && npm run test:tz && npm run db:safety
CONTROL_PLANE_DATABASE_URL="$(grep '^CONTROL_PLANE_DATABASE_URL=' .env.local | cut -d= -f2-)" ENCRYPTION_KEY="$(grep '^ENCRYPTION_KEY=' .env.local | cut -d= -f2-)" TZ=America/New_York npm run test:integration
npm run build && node scripts/check-build-trace.mjs
npm run demo:local && npm run demo:local
```
Manual: import a small history into a fresh local workspace (labels everywhere) → submit → import refused → reopen →
import into a non-locked period allowed, into the app-approved period refused; designate a supervisor's approver with
no shared CLIN and approve; payroll export for a semi-monthly period with a boundary workweek matches a hand calculation;
PDF with leave hours.

---

## 11. Dev-agent hand-off rules

`BLUEPRINT-STANDARD.md` §3 in full. Start only after launch-blockers P3 and P4. Never add UPDATE/DELETE paths to
`timesheet_entries`, `period_events` or `import_batches`; provenance only at insert. Implement CO-D6–CO-D19 exactly
as recorded; the effective-dated rates work (CO-D7 target) is **out of scope** — a separate blueprint. The payroll
method doc is required before production; vendor column layouts are verified in staging before payroll export is
marketed.

**Known LOWs to handle during implementation** (checked at the post-implementation audit):
- Overlap guard is one-way: a later app entry on an imported CLIN/day is accepted (by design — app entry rules unchanged);
  document it in the import screen help.
- Rows from the **old** importer (`source='app'` default, author = employee, `change_reason_code='MIGRATION'`) are
  labelled in the UI as "Legacy import — details not recorded" (by reason code); no data rewrite.
- Deploy the new code immediately after running tenant migration 0014 (expand/contract note in MIGRATIONS.md).
- Blast radius additions: `src/lib/integrations/types.ts` (connector `pushTimesheetEntries` signature for the Gusto
  branch), `charge-code-actions.test.ts` (C3/C4), delete the dead, CLIN-scoped `getScopedPendingApprovals`.
