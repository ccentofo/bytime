# Approval scope (charging ≠ approving): lead audit

**Audited:** branch `approval-scope` at `6e98f66` (6 commits on `10a945f`) against `feature-plan-approval-scope.md` **v3 FINAL**. **Date:** 2026-11-10.

**Method:**
- Lead gates.
- **Lead break-its run on local Postgres:** `breakit-check-approval-scope.mjs`, 11 checks.
- Two independent auditors:
  - engine / migration / server (commits 1–3);
  - Home / UI / seed (commits 4–6).

  32 further mutations; the tree was verified clean afterwards.

**Verdict: NOT READY TO MERGE. No HIGH; 2 MEDIUM (test gaps); fix round 1 below.**
- **Invariant 2 holds:** the backfill converts exactly the active supervisor membership rows, and AS-2's literal matrix equals the old rule.
- **Lock order holds:** `scopeChange` locks first; `updateUser`'s inline writes come before its after-snapshot and `recomputeSelfApproval`; notifications are sent after commit.
- **The window check is truly read-only:** Postgres refused an injected UPDATE.
- **The seed approves the same people as before,** with an empty review list.

## 1. Results
| Check | Result |
|---|---|
| `tsc` / lint / unit (lead) | clean / 0 errors, 54 warnings / 213 files, 2328 pass |
| Integration (dev, local Postgres) | 84 files passed, 663 tests |
| Break-its (lead, local Postgres) | **10/11 caught by integration**. Check 1 (S2 role check) is caught by 3 unit tests (`approval-rules.test.ts`: AS-5, CO-D5, recipients), where §11 places it, so it's covered. |
| Auditor mutations | 28 of 32 caught. The survivors are M1, M2, L1 and L2 below (one more is a no-op equivalent). |

**Dev gap decisions accepted:**
- `scopeChange(db, fn)` without `actorId`;
- change-log values in `newValue` with `oldValue` null;
- window-check list 1 without `--since` (correct: reactivations don't bump `assigned_at`);
- import wording;
- demotion copy for supervisor → admin;
- `[]` sent when no CLINs are picked;
- the new Approvals empty-state wording;
- the README summary line;
- the review-read count 11 → 12;
- Assignments still at 10 loads.

**Rejected:** leaving `getAssignments` / `getAssignmentsForUser` exported and unused (L5).

## 2. Fix round 1

### M1: AS-9 doesn't prove "exactly the chosen CLINs"
- **Where:** `approval-scope.test.ts` AS-9; `users.ts` ~250.
- **Problem:** the fixture has no scope before the promotion, so removing the stale-row deactivation still passes.
- **Fix (test):** before promoting, seed an active `source='migration'` scope on Z for the user. This is the realistic window case, a supervisor demoted by the old code. After promotion with [X], assert:
  - Z is inactive with `reviewed_at` set;
  - a `removed` log exists;
  - the only active row is X.

### M2: `createUserWithPassword` scope grants are untested
- **Where:** `users.ts:347`.
- **Problem:** removing the `grantScopeRows` call passes everything.
- **Fix (test):** an integration case creates a supervisor with `approvalClinIds: [X]` and asserts:
  - an active `app` row;
  - a `granted` log;
  - a re-route email for a waiting employee on X;
  - a non-supervisor with ids is refused.

### LOWs (same round)
- **L1, S10 real-demotion test:** in AS-10, change an employee with an unbacked membership row to admin. Assert the row stays active and the role log has no `membershipRemoved` (`users.ts:226` mutation survived).
- **L2, import inactive supervisor:** add an inactive-supervisor row to AS-12 and expect "isn't an active supervisor" (`import.ts:318`). Echo the trimmed email in row messages, not the raw value.
- **L3, window check errors:**
  - print `err.cause?.message ?? err.message` (redacted) per tenant, not only Drizzle's "Failed query" (`check-approval-scope-window.ts:73`);
  - reject a `--since` that isn't an ISO date;
  - print a caveat that list 1 also shows post-deploy charge-code grants to supervisors, so run it right after deploy.
- **L4, re-grant clears review:** in `grantScopeRows`, a chosen CLIN whose row is already active **and** `source='migration' AND reviewed_at IS NULL` gets `reviewed_at = now()` and a `kept` log. The admin just chose it, so it leaves the review list and Home count (`approval-scopes.ts:57`). Test it.
- **L5, dead endpoints:** delete `getAssignments` / `getAssignmentsForUser` (`assignments.ts:19-68`) and their `server-action-guards` allowlist entries (:122-123).
- **L6, comments:**
  - move the "lowercased: the self checks…" comment back beside `validateUUID` (`users.ts:132`);
  - `setup.ts:31` no longer calls `user_assignments` "approval scope".
- **L7, Users picker reset test:** open Edit for an employee, switch to Supervisor, pick a CLIN, close the Drawer, then open Edit for another employee and switch to Supervisor. The picker is empty and `[]` is sent (`UsersClient.tsx:233`).
- **L8, import banner:** "5. CLIN assignments" → "5. Approval scope" (`ImportClient.tsx:486`).
- **L9, review table name:** `aria-label="Approval scopes to review"` on the review table (`ApprovalScopePanel.tsx:310`).
- **L10, review size:** "Save review" sends rows in chunks of ≤ 500 (the server limit) (`ApprovalScopePanel.tsx:244-246`).
- **L11, empty Add dropdown:** the Add modal's MultiSelect gets `nothingFoundMessage="They already approve every active CLIN."` (`ApprovalScopePanel.tsx:366`).

**Recorded, no change:**
- S10 counts a CLIN as backed by any active `user_charge_codes` row, even if the code is inactive. This matches the blueprint and is conservative.
- Old-code demotions during the window aren't listed by the window check. That isn't a gain, and S6 lists their scopes as "(no longer a supervisor)".

## 3. Product owner runs (after fix round 1)
1. Integration (expect 0 failures) and `node breakit-check-approval-scope.mjs` (expect 10/11 + check 1 by unit, or 11/11).
2. `npm run build && node scripts/check-build-trace.mjs && node scripts/check-css-output.mjs`.
3. **Before re-seeding:** `npm run db:migrate:all`. Then sign in to acme as admin: Assignments → Approval scope shows the review list with Sarah's and Mike's converted scopes, and Home shows "{n} approval scopes to review". Keep one, remove one, and the Home item clears.
4. `npm run demo:local` (seeded scopes, no review list).
5. Browser:
   - give Sarah a code on Army CLIN 0001: she still can't see or approve Robert;
   - promote John to supervisor with one CLIN: he approves only there;
   - demote him: scope gone, his codes intact.

## 4. Fix round 1 verification (`daa9704`, `9ea805f`, `aee61ca`), 2026-11-12
**Lead gates:** `tsc` clean; lint 0 errors, 54 warnings; 214 files, 2335 pass. Break-it dry run: all 11 edits apply.

**Dev report:** integration 84 files and 665 tests pass; break-it 10/11 by integration, with check 1 caught by unit (as audited); 19/19 revert checks.

**Spot check:** L4 marks an unreviewed converted row reviewed and logs `kept` through the shared predicate.

**Gap decisions, all accepted:**
- L3: a date-time without a zone is refused;
- L4: a re-chosen converted row counts as "kept", not "granted";
- L10: stop on a failed chunk and refetch;
- three commits.

**Product owner, before merging:** §3 steps 2–5 (build, `db:migrate:all` before re-seeding, `demo:local`, browser).

**Verdict (2026-11-12): READY TO MERGE.** The product owner reports the tests clean. The table column-order issue found during browser checks predates this branch; its fix is in `feature-plan-hotfix-table-state.md`. Deploy is fix-forward only (§12.1).
