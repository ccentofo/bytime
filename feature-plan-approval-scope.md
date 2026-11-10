# Blueprint: approval scope only from explicit grants

> **Status:** v3 FINAL, 2026-11-10, lead architect. Pre-mortem rounds 1 and 2 applied (§14). The two-round limit is reached; the code audit catches the rest.
>
> **Branch:** `approval-scope`, from `main` at `3f9eb9b` (UX-4c Part 1 merged) or later.
>
> **Product-owner decision (2026-11-10), binding:**
> 1. A charge code grant never gives approval authority. Approval scope comes **only** from an explicit grant on Assignments → Approval scope, logged with who granted it and when.
> 2. **Existing data:** convert today's implied scopes into explicit grants **once**, then show admins a one-time "review approval scopes" list so they can remove any that weren't intended.
> 3. **Promotion:** charge code access is kept and approval scope **starts empty**; the flow asks "Which CLINs will this person approve?". **Demotion:** approval scope is removed and charge code access stays.
> 4. Split the data so a row can grant charging without granting approval.

---

## 0. Lead rulings
| # | Ruling |
|---|---|
| S1 | **A new table, `approval_scopes`**, holds approval scope. `user_assignments` keeps its rows and now means only **CLIN membership** (who works on a CLIN; created by charge-code grants). It never grants approval. |
| S2 | **Approval rule:** supervisor A approves user E when E is A's effective designee (unchanged), **or** E's role is `employee` and A's **active scope CLINs** intersect E's **active membership CLINs**. Admins and self-approval are unchanged. |
| S3 | **Review scope (who a supervisor can see)** = self ∪ every user with an active membership row on a CLIN in A's scope (any role, as today for shared CLINs) ∪ A's designators. A supervisor's own membership no longer widens what they see. |
| S4 | **A supervisor's own filter options** (report and audit Contract/CLIN dropdowns) = their scope CLINs ∪ their own membership CLINs. |
| S5 | **Every scope write locks, logs and re-routes:** it takes the user-rules lock exclusive, logs `admin_change_log` (entity `approval_scope`, values `{ supervisorId, clinId }`), and re-routes waiting timesheets as role changes do. Writers outside `updateUser` / `createUserWithPassword` go through `scopeChange` (§4.1). Role, active-state and CLIN checks run **after** the lock. |
| S6 | **Migrated scopes are "unreviewed"** (`source='migration'`, `reviewed_at` null). They keep granting until removed. The review list and the Home count come from **one server query**: `source='migration' AND is_active AND reviewed_at IS NULL`, for any holder (inactive or no longer a supervisor, labelled as such). Keep sets `reviewed_at`; Remove and demotion deactivate **and** set `reviewed_at`. The list is server state, not dismissable. |
| S7 | **The import's approval-scope tab** writes `approval_scopes` (§4.2). Its copy and template change in this blueprint. |
| S8 | **Charge-code grants keep upserting membership rows** (unchanged). The Give access supervisor notice (R8) is removed. |
| S9 | **Deploy is fix-forward only (§12.1).** No Instant Rollback for this release: the old engine reads only `user_assignments`, so a rollback would re-grant revoked scopes and drop new ones.
  - Run `db:migrate:all` and the Vercel deploy **back to back**, with no admin edits to assignments, users or charge-code access in between.
  - Then a **report-only** window check lists anything the old code may have changed during the window. The founder fixes those by hand on the Approval scope tab.
  - There's no production data yet (only the demo workspaces and the design partner). Automatic conversion was rejected in round 2: it can't distinguish old-code from new-code writes without extra triggers. |
| S10 | **Demotion from supervisor also cleans up membership rows not backed by charging.** Leftover rows from the old supervisor-scope action would otherwise make the former supervisor approvable, and visible, on CLINs they only supervised. Membership rows on CLINs where the user has no active `user_charge_codes` row are deactivated. Recorded follow-up (next release): a migration that does the same for current supervisors' unbacked rows (it can't go in `0018`, because the old code reads membership during the window). This is the one exception to invariant 3, and it only touches unbacked rows. |

## 1. Verified current state
- **`user_assignments`** (`schema.ts:165-175`): id, userId, clinId, slinId, isActive, assignedAt, assignedBy; unique (userId, clinId).
- **Writers:**
  - `assignChargeCodeToUserInternal` (`internal/charge-codes.ts:49-69`, any role)
  - `assignUserToClin` / `unassignUserFromClin` (`actions/assignments.ts:66-103`)
  - `bulkImportAssignments` (`actions/import.ts:292-348`: **no transaction, no savepoints**, plain per-row `db` calls, any role)
  - the seed (`seed-full.ts:220-229`)
  - `clear-tenant-data.ts:29`
  - the test helper `helpers.ts:78-86`

  None of them locks, re-routes or logs.
- **Engine** (`approval-rules.ts`):
  - `loadApprovalFacts` (53-63)
  - `sharesActiveClin` (86-92)
  - `canApprove` (95-105)
  - `reviewScopeFrom` (107-121)
  - `approvableScope` (283-287)
  - lock (43-51)
  - re-route (239-276) and `notifyReroutedApprovals` (`submission-notify.ts:69-90`)
- **Hand-built `ApprovalFacts` literals:** `users.ts:49`, `assignments/page.tsx:74`.
- **Static lock test** (`user-rules-lock.test.ts:16-33`): a hand-written list of writers. Each must have one `db.transaction(async (tx) => {` whose first statement is `await lockUserRulesExclusive(tx);`.
- **Readers outside the engine:**
  - filter options (`reports.ts:325-333`, `audit.ts:466-520`)
  - `users.ts:198-207` (`role_changed` clinIds)
  - the Assignments page (`assignments.ts:11-60`, `clinsBy` via `AssignmentsClient.tsx:81-85` and `ChargeCodeAccessPanel.tsx:58` → `GiveAccessModal`)
  - export (`allowlists.ts:239-247`)
  - `getSupervisorScopeInfo` (`supervisor-scope.ts:13-28`)
- **`updateUser`** (`users.ts:94-233`):
  - takes the lock first;
  - snapshots before at :194 and after at :227;
  - logs on `changed.role !== old.role` (:198-199);
  - the sole-admin refusal at :162-182.
- **Users UI:**
  - `editConfirmCopy` / `roleChangeCopy` (`UsersClient.tsx:80-140`);
  - `handleSubmit` rebuilds `updateData` from `form` (:241-303);
  - Add user has no confirm (:286-296);
  - `ConfirmModal` renders the message in a `<Text>` (no children slot);
  - `admin/users/page.tsx` loads no CLINs.
- **Home** (`home.ts`):
  - internals only (trap T-A, :23);
  - the admin gate `isAdmin && notices && contracts && overlaps && setup` (:61);
  - a burst of 9 parallel queries against a pool max of 10 (:49, `db/index.ts:33`).
- **Import UI:** `ImportClient.tsx:560` ("Bulk assign employees to CLINs") and `:569`. Template: `public/templates/assignment-import-template.csv` (employee examples).
- **Assignments page:** already at 10 parallel loads (`page.tsx:28`).
- **Migrations:**
  - latest tenant migration `0017`;
  - `db:safety` forbids drops, renames, type changes and SET NOT NULL;
  - backfill precedent: `0014:63-73`;
  - Drizzle's last generated statement has no trailing `--> statement-breakpoint` (see `0017`);
  - applied by `db:migrate:all`, then the Vercel deploy (`PRODUCTION-DEPLOY.md:36-48`), and on provisioning.
  - Rollback is documented at `PRODUCTION-DEPLOY.md:593-597`.
- **`admin_change_log`:** `actor_id` NOT NULL (no migration logging); written only through `logAdminChange`; pairs come from the registry.
- **Seed:** Sarah's scope is nav01 and disa01 (she charges nav01); Mike's is army01 and army02 (he charges army01).

## 2. Invariants
1. **Approval only by `canApprove`.** Decisions take the shared lock. Scope writes take the exclusive lock and are logged.
2. **No silent loss or gain:** every (supervisor, CLIN) pair that granted approval before the release still does after it (via the migration; window edits are prevented by procedure and caught by the window check, S9), until an admin removes it. No pair gains approval.
3. **Charging is unaffected:** `user_charge_codes` is untouched. Membership changes only per S10.
4. **Admins approve everyone;** self-approval is unchanged.
5. **`admin_change_log`** is written only by `logAdminChange`.

## 3. Schema and migration `0018`
- **Table `approval_scopes`:**

  | Column | Type | Notes |
  |---|---|---|
  | id | uuid pk default | |
  | supervisor_id | uuid not null → users | |
  | clin_id | uuid not null → clins | |
  | is_active | boolean not null default true | |
  | source | varchar(20) not null default 'app' | `app` / `migration` / `import` |
  | granted_at | timestamptz not null default now() | |
  | granted_by | uuid null → users | null only for migrated rows with no recorded assigner |
  | reviewed_at | timestamptz null | set at grant for `app` / `import`; null for `migration` until reviewed, removed or demoted |

  - Unique `(supervisor_id, clin_id)`; index `(clin_id) WHERE is_active`.
  - The change log covers who reviewed or removed a row.
- **File layout:**
  1. Drizzle's generated statements (table, FKs, indexes, **including the unique index**);
  2. add `--> statement-breakpoint` after the last generated statement;
  3. then the commented, idempotent backfill:
  ```sql
  INSERT INTO approval_scopes (supervisor_id, clin_id, is_active, source, granted_at, granted_by)
  SELECT ua.user_id, ua.clin_id, true, 'migration', ua.assigned_at, ua.assigned_by
  FROM user_assignments ua JOIN users u ON u.id = ua.user_id
  WHERE u.role = 'supervisor' AND ua.is_active
  ON CONFLICT (supervisor_id, clin_id) DO NOTHING;
  ```
- **New tenants** run it on an empty database (nothing inserted).
- **`db:safety`** passes.
- **Export:** add `approval_scopes` to `allowlists.ts` with every column, and a README line "Who approves which CLINs, and who granted it".
- **`clear-tenant-data.ts`:** delete `approval_scopes` before `users` and `clins`.

## 4. Server
### 4.1 Engine and `scopeChange`
- **`loadApprovalFacts`** loads active `approval_scopes` into `scopeClinsBySupervisor`. `clinsByUser` stays as membership. Update the two hand-built literals.
- **`canApprove`** supervisor branch per S2. **`reviewScopeFrom`** per S3. `approvableScope`, `eligibleApprovers` and recipients follow.
- **`getSupervisorScopeInfo.assignedClinCount`** = the active scope count.
- **`scopeChange(db, actorId, fn)`** in `approval-rules.ts`:
  - opens `db.transaction(async (tx) => {`, with `await lockUserRulesExclusive(tx);` as **its first statement**;
  - snapshots submitted eligibility;
  - runs `fn(tx)` (which validates **after** the lock and writes);
  - snapshots again and returns `{ result, rerouted }`.

  The caller calls `notifyReroutedApprovals` **after** the transaction resolves.
- **One write module:** every `approval_scopes` write goes through `src/server/internal/approval-scopes.ts`:
  - `grantScopeRows(tx, { actorId, supervisorId, clinIds, source })` upserts, logs `granted` for new or reactivated rows, and returns the ids;
  - `deactivateScopeRows(tx, { actorId, rows })` deactivates, sets `reviewed_at` if null, and logs `removed`;
  - `markScopeRowsKept(tx, …)`.
- **Lock tests:**
  - assert `scopeChange`'s first statement is the lock;
  - a static scan of `src/` and `scripts/` (**excluding `src/__tests__/`**) finds `insert(approvalScopes)` / `update(approvalScopes)` only in `approval-scopes.ts` and `seed-full.ts`;
  - a second check: the three helpers are imported only by `approval-rules.ts` (scopeChange users), `actions/assignments.ts`, `actions/import.ts` and `actions/users.ts`.

### 4.2 Actions
- **`grantApprovalScope({ supervisorId, clinIds })`** (replaces `assignUserToClin`):
  - `requireAdminFresh`; UUIDs; 1–200 deduped ids.
  - In `scopeChange`:
    - the user is an active supervisor ("Choose an active supervisor.");
    - each CLIN is active on an active contract;
    - upsert each id not already active: reactivate, `source='app'`, `granted_at=now`, `granted_by=actor`, `reviewed_at=now`;
    - log `granted`.
  - Returns `{ granted }`.
- **`revokeApprovalScope({ supervisorId, clinId })`** (replaces `unassignUserFromClin`):
  - in `scopeChange`: deactivate and set `reviewed_at` if null; log `removed`;
  - already inactive → `{ changed: false }`, no log.
- **`reviewMigratedScopes({ keep, remove })`** (scope row ids, UUIDs, ≤ 500 in total):
  - in one `scopeChange`, only rows matching the S6 predicate; others are skipped and counted;
  - Keep → `reviewed_at`, log `kept`;
  - Remove → deactivate + `reviewed_at`, log `removed`.
- **`getApprovalScopesView()`** (`requireAdmin`, read-only allowlist) returns, in one load slot (two sequential queries):
  - active scope rows with names;
  - the S6 review rows (any holder, with `holderActive` and `holderRole`);
  - membership rows for People counts and uncovered CLINs.

  It replaces `getAssignments` on the Assignments page, which stays at 10 loads. `clinsBy` and its R8 prop chain are removed.
- **Delete `assignUserToClin` / `unassignUserFromClin`** and update their tests and the fresh-admin-writes lists.
- **`updateUser`:** scope writes go inline, inside its existing transaction and lock, **after** the before-snapshot (:194) and **before** the after-snapshot (:227) and `recomputeSelfApproval`. It does **not** call `scopeChange`.
  - **`approvalClinIds`** (0–200 deduped UUIDs) is allowed **only** when the role actually changes **to** supervisor (`old.role !== 'supervisor' && new role === 'supervisor'`). Otherwise → `UserFacingError("Already a supervisor — edit their approval scope on Assignments.")` when the role is unchanged, or "Approval CLINs only apply when making someone a supervisor."
  - Validate the CLINs (active on an active contract) after the lock.
  - Promoting an inactive user is allowed (no "active supervisor" check here).
  - **Real change to supervisor:** deactivate any active scope rows **not among the chosen ids** (log `removed`), then grant the chosen ids (`source='app'`, log `granted` only for new or reactivated rows). `role_changed.newValue.clinIds` = the chosen ids.
  - **Real change from supervisor:** deactivate every active scope row and set `reviewed_at` (log `removed`). Apply S10 membership cleanup. `role_changed.newValue.membershipRemoved` = those CLIN ids.
  - The sole-admin refusal throws first, as today.
- **`createUserWithPassword`:** `approvalClinIds` is allowed when the role is supervisor (same validation, inline grants, logged).
- **`bulkImportAssignments`** (rewritten, following `bulkImportEmployees`, `import.ts:51-108`):
  - `requireAdminFresh`; ≤ 500 rows (else "Import 500 rows or fewer at a time.");
  - one `scopeChange` for the batch;
  - per row, inside `tx.transaction(async (sp) => …)` (a savepoint): look up the user ("User "{email}" not found") and the CLIN ("CLIN "{n}" not found under contract "{c}"") and check:
    - the user is an active supervisor ("{email} isn't an active supervisor, so they can't approve a CLIN.");
    - the CLIN is active on an active contract;
    - existing active scope → skipped;
    - else upsert with `source='import'`, `granted_by=actor`, `reviewed_at=now`, and log `granted`.
  - A row error never aborts the batch.
- **Filter options** (S4): `reports.ts:325-333`, `audit.ts:466-520`.
- **Registry and formatter:**
  - registry: `approval_scope: ['granted', 'removed', 'kept']`, with `entityId` = the scope row id and values `{ supervisorId, clinId }`;
  - the formatter resolves names through the existing user and CLIN batches (`audit.ts:438-451`). **Extend `adminChangeNames`** to collect `supervisorId`, `clinId` and `membershipRemoved[]`, or they render "(deleted)". Text: "Approval scope added / removed / kept" · "{supervisor} · {contract} CLIN {n}".
- **Home:**
  - a new internal count `approvalScopesToReview(db)` (the S6 predicate);
  - `HomeView.admin.approvalScopesToReview: number`, **outside** the truthiness gate at `home.ts:61`;
  - it runs **after** both the 9-query burst and `getSetupStatusInternal`'s 7 parallel COUNTs (`setup.ts:36`), never alongside them;
  - attention item "{n} approval scopes to review" → `/admin/assignments?tab=approval-scope` when n > 0.
- **Users page loader:** add an admin read of active CLINs on active contracts, grouped by contract, for the picker.

## 5. UI
- **Approval scope tab:**
  - rows from `getApprovalScopesView`;
  - Add (several CLINs) → `grantApprovalScope`;
  - Remove → `revokeApprovalScope`, with the confirm "Remove {CLIN} from {name}'s approval scope?" / "They'll stop approving employees on this CLIN.";
  - Since = `granted_at` + "by {name}", or "converted from earlier data";
  - **Uncovered CLINs:** active CLINs with ≥ 1 active employee membership row and no active scope held by an active supervisor.
- **Review list** (top of the tab, while review rows exist):
  - a warn `Notice`: "These approval scopes were converted from earlier assignments. Keep the ones that are right and remove any that weren't intended.";
  - a table with Supervisor (tagged "(inactive)" / "(no longer a supervisor)"), CLIN (tagged "(inactive)"), and Keep / Remove (segmented, default Keep);
  - "Save review" → toast "Approval scopes reviewed"; refetch.
- **Give access:** remove the R8 notice and its prop chain (`clinsBy`).
- **Users:**
  - **"CLINs they approve"** multi-select (grouped by contract, optional, empty allowed) **in the Drawer**, shown when `form.role === 'supervisor'` and (Add, or `editingUser.role !== 'supervisor'`). Help: "Charge code access doesn't change. Their approval scope starts with only what you choose here."
    - Stored in `form.approvalClinIds` and reset in `openCreate` / `openEdit`.
    - Sent as `approvalClinIds` only in that case.
  - The role confirm (`editConfirmCopy`) **summarizes**: "They'll approve: {CLIN list}." or "They won't approve any CLINs yet.".
  - Demotion copy: "Their approval scope is removed. Charge code access doesn't change."
  - Cancelling keeps the selection. A failed save rolls back the role and the grants together, and the error shows in the confirm as today.
- **Approvals page** empty states:
  - `assignedClinCount === 0` → "You don't approve any CLINs yet. An admin can add them on Assignments → Approval scope.";
  - otherwise the existing "nobody to approve" text.
- **Import tab** (S7):
  - the description becomes "Give supervisors approval scope on CLINs. Each row lets one supervisor approve employees on one CLIN.";
  - the order note says the supervisors must already exist;
  - the template's example rows use supervisor emails; the `Email` header is unchanged.

## 6. Seed
- Insert `approval_scopes` for Sarah (nav01, disa01) and Mike (army01, army02): `source='app'`, `granted_by` admin, `reviewed_at` set.
- Remove Sarah's disa01 and Mike's army02 membership rows. Keep nav01 and army01, which they charge.
- Demo approvals are unchanged. The review list is empty.
- Update the seed tests.

## 7. State tables
**Scope row:**

| From | Event | To | Side effects |
|---|---|---|---|
| none | grant (tab / promotion / create / import) | active, reviewed | lock; log; re-route |
| none | `0018` backfill | active, unreviewed | none |
| active, unreviewed | Keep | active, reviewed | log `kept` |
| active | revoke / Remove / demotion | inactive, `reviewed_at` set | lock; log `removed`; re-route |
| inactive | grant | active, reviewed | as grant |
| active | supervisor deactivated | unchanged | approves nothing while inactive |
| active | grant again | unchanged | skipped |

**Role change:**

| From → To | Scope | Membership |
|---|---|---|
| X → supervisor (real change) | exactly the chosen CLINs | unchanged |
| supervisor → employee / admin | all removed (reviewed) | unbacked rows deactivated (S10) |
| supervisor → supervisor with `approvalClinIds` | refused | unchanged |

## 8. Failure modes
| Operation | Failure | Behaviour |
|---|---|---|
| Migrate → deploy window | the old code grants, reactivates, promotes or unassigns | the window check reports it; the founder fixes it by hand (S9); there are no admin edits during the window by procedure |
| Rollback wanted | | not supported (S9); fix forward |
| `0018` re-run | | `ON CONFLICT DO NOTHING`; the journal runs it once |
| Grant vs decision | concurrent | exclusive vs shared lock |
| Revoke while the supervisor reviews | Approve pressed | `canApprove` re-checked under the lock → refused |
| Concurrent demotion vs grant | | validation after the lock refuses the grant |
| Import row SQL error | | its savepoint rolls back; other rows continue; the batch commits |
| Re-route email fails | | never throws (existing) |
| Review saved twice | | already-reviewed rows skipped |
| Window check finds a pair | | manual fix by the founder; no automatic writes, so no lock or re-route is needed |

## 9. Platform limits
- `loadApprovalFacts`: +1 small indexed query.
- Assignments: still 10 loads.
- Home: one extra query after the burst.
- Import: ≤ 500 rows under one lock (short).

## 10. Blast radius
- **Schema and migration:** `schema.ts`, `drizzle/0018_*.sql`, journal.
- **New script:** `scripts/check-approval-scope-window.ts` + npm script `scopes:window-check` (report-only, §12.1).
- **New module:** `src/server/internal/approval-scopes.ts`.
- **Engine and actions:**
  - `approval-rules.ts`, `supervisor-scope.ts`, `assignments.ts`, `import.ts`, `users.ts`, `reports.ts`, `audit.ts`;
  - the registry, `admin-change-format.ts`;
  - `home.ts`, `lib/home/attention.ts`.
- **Tables:** `allowlists.ts` + README, `clear-tenant-data.ts`.
- **Pages and components:**
  - `admin/assignments/page.tsx`, `AssignmentsClient.tsx`, `ApprovalScopePanel.tsx`, `ChargeCodeAccessPanel.tsx`, `GiveAccessModal.tsx`;
  - `admin/users/page.tsx`, `UsersClient.tsx`;
  - `ApprovalsClient.tsx`;
  - `ImportClient.tsx`, `public/templates/assignment-import-template.csv`.
- **Seed and helpers:** `seed-full.ts`; the helper `assignUserToClin` (membership) plus a new `assignApprovalScope`.
- **Tests:**
  - **Unit:** approval-rules, approval-scope-counts, approvals-client, assignments-row-actions, assignments-lcat-tab, assign-access-actions, users-admin-actions, approval-decisions, user-rules-lock, home-page, `admin-change-log-writer` (its per-file `uses(...)` counts change), `users-row-actions` (old promotion copy at `:178`), `import-row-errors` (mocks `bulkImportAssignments`), and `export-allowlists` (passes once `allowlists.ts` is updated).
  - **Integration:** use `assignApprovalScope` for supervisors in approver-rules, authorization, approval-queue, employee-summary-report, period-flags, period-lock, calendar-dates-d9, export-workspace, cost-basis, timesheet-pdf, setup-status, fresh-admin-writes, audit AU-4, team-period-status, home-data, submission-emails, charge-code-actions `:251`, charge-codes AS-8, users US-4, timesheet-rbac, seed-conformance and seed-review-story.

## 11. Test matrix
Each row must fail without its change.

| # | Scenario | Kind |
|---|---|---|
| AS-1 | The backfill statement **read from `drizzle/0018_*.sql`** converts active supervisor membership into active unreviewed scopes (including an inactive supervisor), not employee rows; a second run inserts nothing | integration |
| AS-2 | After the backfill, a fixture (2 supervisors, 3 employees) gives a **literal expected `canApprove` matrix** equal to the old rule's | integration |
| AS-3 | A supervisor with a code but no scope on X can't approve or see an employee on X | integration |
| AS-4 | Two supervisors charging the same CLIN without scope: neither approves nor sees the other's employees | unit |
| AS-5 | Scope on X: sees a peer who charges X; can't approve them | unit |
| AS-6 | Filter options include own charged CLINs without scope | integration |
| AS-7 | `grantApprovalScope`: non-supervisor refused (checked after the lock); inactive CLIN refused; logs `{supervisorId, clinId}`; a waiting period re-routes to the new supervisor (email recorded) | integration |
| AS-8 | `revokeApprovalScope`: deactivates and logs; a later Approve is refused | integration |
| AS-9 | Promotion with `[X]`: exactly X, even with membership on Y; logs; `role_changed` lists [X]. A second "promotion" of a supervisor with ids → refused, scope unchanged | integration |
| AS-10 | Demotion: scope removed + reviewed + logged; an unbacked membership row deactivated; a backed one kept | integration |
| AS-11 | Review: keep → reviewed + log; remove → inactive + log; app rows ignored; a row of an inactive supervisor and of a demoted user are reviewable | integration |
| AS-12 | Import: a non-supervisor row → row error; a forced SQL error in one row leaves the others committed; > 500 rows refused | integration |
| AS-13 | The review list and the Home count use the same predicate (an inactive holder counted **and** listed); Home's admin section still renders when the count is 0 | unit |
| AS-14 | Give access with a supervisor plus a code on a CLIN they lack (the old trigger) shows **no** notice | unit |
| AS-15 | The Drawer shows the CLIN picker only for a real change to supervisor (or Add); the confirm summarizes; ids are sent | unit |
| AS-16 | Seed: Sarah and Mike approve the same people as before; the review list is empty | integration |
| AS-17 | `scopeChange`'s first statement is the lock; the scan finds `approval_scopes` writes only in `approval-scopes.ts` and the seed; the helpers are imported only by the allowed files | unit |
| AS-18 | The window check reports: a supervisor's active membership row with no scope row; a `role_changed` to supervisor at or after `--since`; an active unreviewed migrated scope whose membership row is inactive. It writes nothing | integration |

## 12. Verification
- **Dev:** `npx tsc --noEmit`, `npm run lint`, `npm run test`, `npm run test:tz`, `npm run db:safety`.
- **Product owner:**
  - integration with `REQUIRE_CONTROL_PLANE_TESTS=1` (the usual command);
  - `npm run db:migrate:all` on local tenants **before** re-seeding: acme shows the review list with Sarah's and Mike's converted scopes;
  - `npm run demo:local` (seeded, no review list);
  - build plus checks;
  - the lead's break-it script.
- **Browser:**
  1. Keep and remove migrated scopes; the Home item clears.
  2. Give Sarah a code on Army CLIN 0001: she still can't see or approve Robert.
  3. Promote John with one CLIN: he approves only there.
  4. Demote him: scope gone, codes intact.

### 12.1 Deploy (S9)
1. This release is **fix-forward only**. Write that in its PR description and in `PRODUCTION-DEPLOY.md`'s release notes. Instant Rollback isn't used.
2. Make no admin edits to assignments, users or charge-code access between `db:migrate:all` and the deploy going live. Run the two back to back, and record `MIGRATE_START` before migrating.
3. After the deploy is live, run `npm run scopes:window-check -- --since "$MIGRATE_START"`.
   - The npm script runs `node --conditions=react-server --import tsx scripts/check-approval-scope-window.ts`, like `migrate-all.ts`.
   - It reads every tenant and prints, per tenant: supervisors with active membership on a CLIN but no scope row; `role_changed`-to-supervisor logs since `--since`; and active unreviewed migrated scopes whose membership row is now inactive.
   - **It writes nothing.**
4. The founder grants or removes scopes by hand on the Approval scope tab for anything listed that should change. On the demo and design-partner workspaces this list is expected to be empty or tiny.

## 13. Hand-off and commit order
- `BLUEPRINT-STANDARD.md` §3 rules. Don't push.
- **Commits:**
  1. schema, `0018` and the window-check script;
  2. engine, `scopeChange` and the lock tests;
  3. actions (grant, revoke, review, updateUser, create, import, filters, registry);
  4. Home;
  5. UI (Assignments, Users, Approvals, Import, template);
  6. seed and tests.

## 14. Pre-mortem record
**Round 1 (2026-11-10)**, two reviewers. 0 HIGH, 13 MEDIUM, all applied:
- the deploy window plus rollback (S9, catch-up script);
- the review list and Home count share one predicate, including inactive and demoted holders;
- leftover supervisor membership cleaned on demotion (S10), with a follow-up migration recorded;
- the import rewritten with real savepoints (none existed);
- `scopeChange` owns the transaction, the lock comes first, plus a static write scan;
- `approvalClinIds` only on a real change to supervisor; a stale promotion is refused;
- the picker lives in the Drawer (the confirm can't hold inputs), with a Users CLIN loader;
- the import copy and template;
- the Home count outside the gate and after the burst;
- the Assignments loads kept at 10 (a combined view);
- blast-radius additions.

**LOW, also applied:**
- the migration breakpoint and order;
- validation after the lock;
- tests read the real SQL and use a literal matrix;
- the empty-state branch;
- the import cap and CLIN check;
- dropped `reviewed_by` / `removed_*` (the log covers them);
- log values `{supervisorId, clinId}`;
- the S1 wording.

**Round 2 (2026-11-10)**, one fresh reviewer. 0 HIGH, 2 MEDIUM, all applied:
- the automatic catch-up script was replaced by a **report-only window check** plus a "no edits during the window" procedure. Automatic conversion couldn't tell old-code from new-code writes (reactivations, promotions, post-deploy grants, unassigns).
- all `approval_scopes` writes go through one module (`approval-scopes.ts`); the scan excludes `__tests__`; tests touched are added to §10.

**LOW, applied:**
- `adminChangeNames` collects the new ids;
- the review cap of 500;
- the window check needs no lock;
- Home ordering after setup;
- promotion doesn't remove-then-regrant a chosen CLIN.
