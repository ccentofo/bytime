# Pre-staging sweep, fix round: audit

**Item:** build queue 8, step 1 (the regression and test-gap sweep's fix round). **Brief:** `SWEEP-FINDINGS.md` §3–§6 and §9, with the product owner's four decisions (§2). **Base:** `main` at `4ae8c31`.

| Session | Branch | Head | Commits | Files |
|---|---|---|---|---|
| S1: tenancy, sign-in and security | `sweep-fix-auth` | `dfb1353` | 6 | 34 |
| S2: billing, lifecycle and notices | `sweep-fix-billing` | `2a1480f` | 6 | 18 |
| S3: timekeeping, reports, data safety, test hygiene | `sweep-fix-timekeeping` | `67e1bbe` | 11 | 49 |

## Verdict: **READY, all three**
- No HIGH or MEDIUM findings in the fix round.
- The three branches share **no files**, so they merge in any order without conflicts.
- The lead also checked **all three merged together**, the state `main` will be in after the three PRs: every gate and the full integration suite pass (§4).

**Merge gate for the product owner:** push each branch, open its PR, wait for green CI, merge. Then push and merge `regression-sweep` (the sweep's records and the tracker).

**One open question for the product owner (no rush; not a merge blocker):** Q-N2 in `SWEEP-FINDINGS.md` §8. During a policy hold, should the customer still be able to open Stripe's billing portal? It's left as is.

## 1. What changed
**S1:**
- **Code:**
  - The Sentry scrub filters `token`, any `*token`, `email`, `code` and `state` parameters after `?`, `&` or `#` and their encoded forms. It also covers Sentry's `request.query_string` (S1's own find).
  - The admin password reset refuses your own account (decision 1), and the Users menu hides it on your own row.
  - Lockouts are keyed on the email from the database.
  - Authentication runs before `getDb` in five actions, and the guard-first rule now covers every non-public action.
  - The unused `checkSlugAvailable` is deleted; `checkLockout` is gated as a refunded peek.
  - The Gusto log no longer prints personal data; the reset uses the one shared password rule.
- **Tests:**
  - **HIGH:** the write gate, `jwtCallback`'s invalidation, inactive sign-in, API key states, one pool per URL.
  - **MEDIUM:** 27 admin actions pinned to admin guards, plus the closed-workspace auth refusal, the forged-header mismatch, the random IV, the per-email lockout, the registry cache, slug rules, the session bumps and supervisor scope.
  - **LOW:** the rest of the list.
  - The tautological `session-invalidation.test.ts` is repaired to run through the real writers and the real `jwtCallback`.

**S2:**
- **Code:**
  - Decision 3: no payment, trial or suspension emails during a policy hold, including `bank-payment-failed`.
  - N1: a pending `subscription-ended` is held, and `unsuspend` re-queues it, so the customer is told exactly once. This also closes the gap where a subscription ending during a hold was never announced. Its deletion date follows the deletion notice's rule (at least now + 14 days, never shrinking).
  - The portal refuses a closed workspace.
  - `force-notice-sent` refuses a bad anchor cleanly.
  - The unused `AUTO_DELETE` is removed.
  - Docs: the false seat-sync digest line after a control-plane rebuild; the trial clock under a policy hold.
- **Tests:**
  - **HIGH:** `tenant:delete`'s shared-database refusal.
  - **MEDIUM:** a lapsed trial's deletion date set once, termination at exactly 30 days, a deletion notice superseded when D clears, the digest's deletion lists.
  - **LOW:** the edges.
- **Test hygiene:** three timing flakes exposed under load, each fixed by waiting on the real event, or with a measured timeout where the cost is a server-wide checkpoint:
  - the `tenant-delete` suite;
  - two `tenant-lifecycle-cron` tests.

**S3:**
- **Code:**
  - `/api/v1/timesheets` pages in a total order with a true `total`.
  - The QuickBooks imports validate every item and run all or nothing.
  - Bad parameters give 400s.
  - Decision 4: time-zone changes and charge-code assignments and removals are in the admin change log, bulk imports included.
  - Decision 2: supervisors get the reminders and see and control them on Notifications, using one shared rule.
  - `db:safety` flags constraints, drops, `TRUNCATE` and `DELETE`, uses named allows, keeps a baseline list in the script (no shipped migration edited), and has its own tests.
- **Tests:**
  - **HIGH:** the workspace export past one batch.
  - **MEDIUM:** the cost report's contract filter, the approved-only API, the submit rules, export column completeness, journal order, payroll's lower bound, reminders only for full workspaces.
  - **LOW:** the rest.
- **Test hygiene:**
  - the two flaky integration tests are deterministic;
  - two checks-file expectations are updated;
  - `@vitest/coverage-v8` 2.1.9 is pinned (coverage: 61.8% of statements).

## 2. Lead review
- **Each branch's impact analysis** was reviewed before coding. Decisions are recorded in `SWEEP-FINDINGS.md` §9; the open question in §8.
- **Each diff** was read by the lead.
- **Two fixes asked of the sessions after review, both now verified:**
  - S1 G5 crashed its worker instead of failing an assertion, from printing whole Drizzle objects. Fixed in `dfb1353`.
  - S2's `tenant-delete` timeout under load. Fixed in `21fc407`, with two further flakes found in its file (`fea91d9`, `2a1480f`).

## 3. Lead gates and break-it, per branch
| | S1 | S2 | S3 |
|---|---|---|---|
| `tsc` | ✅ | ✅ | ✅ |
| Lint | ✅ 0 errors | ✅ 0 errors | ✅ 0 errors |
| `db:safety` | ✅ | ✅ | ✅ |
| Unit (lead) | ✅ 3,444 | ✅ 3,315 | ✅ 3,378 |
| Integration, **run alone** by the lead, CI-equivalent environment | ✅ 1,175 passed, 0 failed | ✅ 1,183 passed, 0 failed | ✅ 1,186 passed, 0 failed |
| Lead break-it, unit | **8/8** on the whole unit suite (G1 ×2, G2, G3, G4, G5, D1, D2) | **6/6** (decision 3, Q1, dunning, N1, the portal, termination at 30 days) | **8/8** (D1 ×2, D7 ×2, D6, D9, D8, G4) |
| Lead break-it, integration | **2/2** (`updateUser` and `changePassword` session bumps) | **2/2** (the shared-database refusal, N1's stated date) | **2/2** (the QuickBooks closed-contract refusal, the approved-only API) |
| Dev revert checks | 78 unit + 6 integration | 31 unit + 11 integration | 56 unit + 10 integration |

**The eight rules no test caught before** (`SWEEP-FINDINGS.md` §1) are now all caught. The lead re-ran each one as a break:
- the write gate ×2, inactive sign-in, the inactive session and the revoked key (S1);
- the shared-database delete and the lapsed trial's deletion date (S2);
- the export past 5,000 rows (S3).

All are caught by a test that fails.

## 4. The three branches merged together (a scratch merge `a712e28`; nothing committed anywhere)
| Gate | Result |
|---|---|
| Merge | clean (no conflicts); 101 files against `main` |
| `tsc` | ✅ |
| Lint | ✅ 0 errors (39 warnings, as on `main`) |
| `db:safety` | ✅ |
| `test:tz` | ✅ 3,583 passed × 3 time zones (UTC, Los Angeles, Auckland) |
| Build | ✅ |
| Integration, alone, CI-equivalent environment | ✅ 122 files, **1,198 passed, 0 failed**, only `tenant-data-isolation` skipped; no scratch databases left |

The first `test:tz` attempt failed one test, `backup-static` U6. That's the known artifact of a symlinked `node_modules` (esbuild reports `../<other worktree>/node_modules/...` inputs). With a real copy of `node_modules`, all three zones pass.

## 5. Not covered locally
Real Stripe, Resend, Sentry, Neon, Vercel and AWS behaviour. These are proven at the staging rehearsal (PRODUCTION-DEPLOY Phase 12), which comes next after these merge and the account setup (Phases 3–11).
