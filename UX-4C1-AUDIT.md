# UX-4c Part 1 (Assignments, Charge codes, Users, Audit trail): lead audit

**Audited:** branch `ux-people-codes` at `036044f` (6 commits on `a47e822`) against `feature-plan-ux-people-codes.md` **v3 FINAL**. **Date:** 2026-11-06.

**Method:**
- Lead gates.
- Two independent auditors:
  - commits 2–4 (Charge codes, Indirect, Assignments);
  - commits 1, 5, 6 (shared, Users, Audit trail).

  They read every change and ran 38 mutations (all restored; the tree was verified clean).
- **Product owner:** integration and `breakit-check-ux4c1.mjs` (13 Postgres checks).

**Verdict: NOT READY TO MERGE. No HIGH; 6 MEDIUM (M6 = integration fixtures); fix round 1 below.** The riskiest parts hold:
- the CSV cursor stays in SQL;
- 422 comes before streaming;
- one filter builder covers list, count, summary and export, with supervisor scope;
- the two-step reset checks self first, reads the admin's email from the DB, bumps the session in SQL and logs in the transaction;
- `assignChargeCodesToUser` checks everything in one transaction;
- autobridge counts `returning` rows;
- the SLIN edit rules;
- no `/admin/indirect-codes` link remains.

## 1. Results
| Check | Result |
|---|---|
| `tsc` / lint / unit (lead) | clean / 0 errors, 54 warnings / 209 files, 2285 pass |
| Auditor mutations | 30 of 38 caught. The 8 survivors are covered by M2, M4, M5 and L5, or are expected to be caught by integration (US-4, AU-4) |
| Integration (product owner) | 5 failures, all test fixtures (M6); no product bug |
| Break-its (product owner) | blocked until M6 (baselines fail) |

**Dev gap decisions accepted:**
- MIGRATION label unchanged;
- duplicate-email message unchanged (R7 wins);
- the CSV cursor in `internal/` guarding itself;
- no audit tab counts;
- self-approval context kept under events;
- Reason filter includes Imported;
- Role filter;
- password rules show min and max;
- Give access skips held codes;
- the active contract×CLIN load;
- an ended overlapping row still shows (Overlaps wins);
- active tab counts;
- IR&D and B&P as separate groups;
- the paging fix (only the visible table holds the URL page; verified correct).

**Rejected:** overtime in the Edit Drawer saved without the confirm (M1).

## 2. Fix round 1

### M1: the Edit Drawer changes overtime status with no warning
- **Where:** `UsersClient.tsx:225-237, 525-535`.
- **Problem:** the ⋯ "Mark as exempt…" confirm warns that the change reprices overtime "for every period, including past ones". Edit skips it, and a combined role + overtime change shows only the role confirm.
- **Fix:** when editing and `flsaExempt` changed, show the existing FLSA confirm copy before saving. If the role changed too, show one confirm that includes both messages.
- **Test:** an Edit save with a changed overtime status shows the FLSA confirm, and Cancel sends nothing.

### M2: no test proves a change-log row is written in the same transaction as its change
- **Where:** `users-admin-actions.test.ts:22` (the fake passes `db` as `tx`).
- **Problem:** writing the log through `db` outside the transaction passes, in `adminResetMfa`, `adminResetPassword` and `updateUser`. The §8 "log fails → change rolls back" mode is unguarded.
- **Fix:** the fake hands the callback a distinct `tx` that tags its operations, and the tests assert the `adminChangeLog` insert came through `tx`. Add one integration case where `logAdminChange` throws (`vi.spyOn`) and the user row is unchanged.

### M3: the overlap status goes stale after a labor-category write
- **Where:** `assignments/page.tsx:63`, `LaborCategoryAssignmentsPanel.tsx:98, 171, 188`.
- **Problem:** `overlapIds` is computed once. After End… fixes an overlap, the row still says Overlaps and the notice stays; a new overlap isn't flagged.
- **Fix:** add a `requireAdmin` read (`ADMIN_READ_ONLY_ALLOWLIST`) returning `{ assignments, overlapIds }`, used by the panel's refetch.
- **Test:** End… on an overlapping row clears Overlaps and the notice.

### M4: the server-side approver is untested
- **Where:** `assignments/page.tsx:76-81` (`effectiveDesignee`).
- **Problem:** replacing it with the raw `approverId` passes every test.
- **Fix:** a page-level test: a supervisor whose approver is inactive, or not an approver role, shows "admins". Mirror it for `getUsersForAdminPage`'s `approverName`.

### M5: the autobridge conflict path is untested
- **Where:** `charge-codes.ts:429`.
- **Problem:** removing `.onConflictDoNothing()` passes everything.
- **Fix:** an integration case that inserts the candidate's code string between preview and create (outside the qualifying check, e.g. on another CLIN) and expects `{ created: 0, skipped: 1 }` with no error. The unit companion asserts on-conflict-do-nothing is used.

### M6: five integration tests fail on their own fixtures (product owner run, 2026-11-07)
- **Result:** 80 files passed, 2 failed (5 tests). Every failure is in the test **setup**; none is a product bug.
- **Unique index `entries_user_code_date_rev_unique_idx`** on (user, code, entry date, revision):
  - AU-2 (`audit-ux4c.test.ts:109`): the imported row repeats the user, CLIN, date and revision of an earlier row.
  - AU-3 (`:119`): 120 rows on one date, all revision 1.
  - AU-8 (`:169`, `:178`): `generate_series` with `g % 28` dates and revision 1 (50,001 and 2,345 rows).
  - **Fix:** give each row a distinct key. For example, use `revision_number = g` in the bulk inserts, which keeps one user, CLIN and date range. The one-transaction AU-8 case must still share a single `created_at` (one statement or one transaction). Use distinct dates or revisions in AU-2 and AU-3.
- **`contracts.contract_number` is varchar(50)** (`schema.ts:116`): CC-6's "too long" fixture (`charge-codes-ux4c.test.ts:110`) uses a 99-character contract number.
  - The longest possible generated code is 50 + 1 + 50 = 101 characters (`clin_number` is varchar(50), `:136`).
  - **Fix:** a 50-character contract number plus a 50-character CLIN number.
- **Break-it:** `breakit-check-ux4c1.mjs` can't run until these pass, because its baselines run these files.

### LOWs (same round)
- **L1, UUID case:** `validateUUID` returns the lowercased value (`src/lib/validation.ts:130`), so the self checks in `adminResetMfa` and `updateUser` (`mfa.ts:136`, `users.ts:113`) can't be bypassed with upper case. Grep its callers for anything relying on the original case.
- **L2, wrong-password message:** `verifyCurrentPassword` returns `reason: 'wrong' | 'locked' | 'no_password'`; `adminResetMfa` maps on `reason`, not the message string (`mfa.ts:142`).
- **L3, CSV snapshot:** read the newest row's id together with the count. The first batch gets `(created_at, id) <= (SELECT … WHERE id = $topId)` (still in SQL), so the file can't exceed the count or the cap.
- **L4, CLIN filter race:** apply `getClinsForFilter`'s result only if the contract is still the selected one (`AuditTrailClient.tsx:135-140`).
- **L5, untested guards:**
  - `FOR UPDATE` in `adminResetMfa` (static or unit assertion);
  - the CSV route's `request.signal`, `cancel` and Sentry calls (unit with a mocked cursor);
  - lock shown only for active users.

  Add `getUsersForAdminPage` to `no-secrets-leaked`.
- **L6, flaky margin:** the US-2 integration test's `minutesRemaining` assertion uses a fixed `now` passed in, not wall-clock time.
- **L7, self-approval details:** Admin changes rows for `self_approval` show the recorded `newValue.reason`.
- **L8, "Overlaps wins" test:** add an ended and a future overlapping row to AS-6.
- **L9, Indirect tab count:** start from active codes (`ChargeCodesClient.tsx:172`), so there's no flicker.
- **L10, no active CLINs:** with no active CLINs, the Create-from-CLINs empty state reads "There are no active CLINs yet." and links to Contracts (`CreateFromClinsModal.tsx:77`).
- **L11, stale page name:** `payroll-data.ts:32` (and the `payroll-export.ts:70` comment) say "on Charge codes → Indirect", not "in Indirect Codes"; update `payroll-export-actions.test.ts:82`.
- **L12, focus rule:** `SetupWizardClient.tsx:344, 374, 412, 423` use `loading=`. Switch them to `useBusy` props (aria-disabled + Loader), since this branch touches the file.
- **L13, password rules:** the max-length rule shows as met only when the password is non-empty **and** ≤ 128. It shouldn't tick on the first keystroke before the min rule. Show it neutral until the min is met.

**Recorded, no change:**
- the two R8 product-owner questions (blueprint §14);
- batch lock-query `lower()` has no real-world impact while stored emails are lowercase (break-it check 7 covers it with a mixed-case row).

## 3. Product owner runs (after fix round 1)
1. Integration, then `node breakit-check-ux4c1.mjs` (expect 13/13).
2. `npm run build && node scripts/check-build-trace.mjs && node scripts/check-css-output.mjs`.
3. `npm run demo:local` twice.
4. Browser checks in blueprint §12, plus:
   - Edit a user's overtime status: the payroll warning appears;
   - End an overlapping labor category: Overlaps clears without a reload.

## 4. Fix round 1 verification (`6c3479e`…`68dc4a0`, 18 commits), 2026-11-07
**Lead gates:** `tsc` clean; lint 0 errors, 54 warnings; 210 files, 2306 pass. `breakit-check-ux4c1.mjs --dry-run`: all 13 edits apply. The dev reports 46/46 revert checks.

**Spot checks:**
- M1: `editConfirmCopy` covers a role change, an overtime change, and both together;
- L1: `validateUUID` lowercases;
- M3: the new read is on `ADMIN_READ_ONLY_ALLOWLIST`.

**Dev gap decisions, all accepted:**
- M5 conflict injected inside the create transaction;
- M2 rollback via `vi.mock`;
- M3 uses the Unpriced overlap query through the shared helper;
- the combined confirm copy;
- `updateUser` now validates its id;
- L3 bounds only the first batch (a long transaction committing an older `created_at` after the count is theoretical; recorded);
- L6's optional `now`;
- L7 shown plain;
- L10 from loaded contracts;
- L12 loader swap.

`dcf6175` and `46cbc5f` can be squashed at merge (optional).

**Product owner, before merging:** integration (expect 0 failures); `node breakit-check-ux4c1.mjs` (expect 13/13); build plus checks; `demo:local` twice; the §3 browser items.

**Fix round 2 (`users-ux4c` M2 test expects the rethrow), 2026-11-07.** Product owner: integration **651 passed, 0 failed**. Break-it **11/13**, all four baselines pass.
- **Check 7 not caught (accepted, no real impact):** every `login_attempts` insert stores the email lowercased (`login-attempts.ts:145, 162`), so the batch query's `lower()` is redundant today. Only a hand-inserted mixed-case row could tell the difference. The unit companion covers the matching rule.
- **Check 10 not caught (accepted, recorded):** no integration case calls `updateUser` with an **unchanged** role. The app never sends one (the Edit save sends only changed fields, `UsersClient.tsx:254-257`), so the guard only matters for direct server-action calls, and the worst case is one redundant `role_changed` row. Add a same-role case if `updateUser` gains another caller.

**Verdict (2026-11-10): READY TO MERGE.** The product owner reports build plus checks, `demo:local` and the browser checks are OK. The redirect and Overlaps steps were clarified: the demo seed has no overlap, so the steps create one on Jane.
