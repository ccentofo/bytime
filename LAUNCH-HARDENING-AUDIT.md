# Launch hardening audit: H1–H6

> **Blueprint:** `feature-plan-launch-hardening.md` FINAL v3.2. **Branch:** `launch-hardening`, `f795a77..0af93b0` (7 commits). **Dev's papers:** `LAUNCH-HARDENING-IMPACT-ANALYSIS.md` (go-ahead given 2026-11-11), `LAUNCH-HARDENING-DEV-REPORT.md`.
>
> **Lead:** CadenzPoint Planning, 2026-11-11.
>
> **Verdict: READY.**
> - No HIGH or MEDIUM findings. No fix round.
> - No change outside the blueprint's scope, apart from the one comment the lead pre-approved.
> - One wording point for the product owner (§5, L1). It doesn't block the merge.
> - Merge gate, next steps: CI green on the PR, then the product owner's build and browser checks (§6).

## 1. Lead gates (run by the lead at `0af93b0`)
| Gate | Result |
|---|---|
| `npx tsc --noEmit` | **Only 4 errors, all in stale generated files:** `.next/types/validator.ts` and `.next/dev/types/validator.ts` (lines 422 and 431) still name the two deleted connect routes. `npm run build` / `dev` regenerates them, and CI has no `.next`. The same check with `.next` excluded: **0 errors**. |
| `npm run lint` | 0 errors, 39 warnings (none new) |
| `npm run test` | 223 files, 2,443 / 2,443 |
| Dev's reported runs, not re-run by the lead | `test:tz` 3 × 2,443; `db:safety` OK; integration (`REQUIRE_CONTROL_PLANE_TESTS=1`) 87 files / 719 tests passed, 2 files / 5 tests skipped. The skipped files are the two isolation files, which need `TEST_DATABASE_URL` / `TEST_DATABASE_URL_2` (product owner's machine and CI). |

## 2. Break-it (`breakit-check-launch-hardening.mjs`, uncommitted; local Postgres)
29 one-line mutations, each run against one test file. **27 failed as they should.** The tree was clean afterwards.

**Caught (27):**
- **H1:** the daily key back in the write allowlist (T3), the "disable" sentence back in the email (T5), the reminder section shown to supervisors and admins, and the Q2 sentence changed (T4).
- **H2:** `uiBadge` → `badge` in `past-periods.ts`, and separately in `timesheet.ts` alone (T6).
- **H4:** `countFrom` ignored (T8); Home stops passing the creation day (unit T10); the `selectedPeriodFacts` recompute dropped; the status line keeps "0 of 0"; the timesheet counts from the period start; Home keeps "0 of 0" (T11).
- **H5:** the banner `key` removed (T13b); CSP without Intuit (T15); the nonce cookie not httpOnly; `requireAdminFresh` → `requireAdmin`; signed-out → `/timesheet` instead of `/login`; the state's nonce ≠ the cookie's; the QuickBooks page back to the GET link (T14).
- **H6:** no lock (T18); no compare-and-swap (T19b/c); 0 rows not treated as a lost race; the waiter refreshes again (T20); the re-read's usable check dropped (T19a); the fast path ignores provider/active (T21b); no timeout signal (T21a); a network failure not mapped (T21).

**Survived (2), both explained:**
- **#9:** Home stops passing the creation day, run against `integration/home-data`. The blueprint named that file for T10's Home half; the dev put it in `unit/home-scope-review` instead, which catches the same mutation (#8). It also checks that the read runs before the burst, runs once, and converts to the workspace time zone. Accepted; this is a change of test location, not a gap.
- **#29:** `is_active` dropped from the token write's compare-and-swap. Both ways a connection is deactivated (`actions/integrations.ts:73`, `internal/integrations.ts:73`) also clear the tokens, so the refresh-token comparison alone already gives 0 rows. The term is a backstop no real path can reach. Informational.

## 3. Independent auditors
Two sub-agents, run after break-it, each leaving the tree clean.

**Server half (H1, H2, H4, H5, H6 and their tests):** no HIGH. One MEDIUM, which the lead re-rated LOW (S1). Confirmed correct:
- the cron and allowlist changes;
- certified outputs still read `.badge` / `.text`;
- every `periodProgress` / `currentPeriodSummary` caller, the Home pre-burst read, and the time zone use;
- the Next 16.2.6 Origin check, cookies and redirect behaviour;
- the R2-9 state and nonce chain through `complete/[provider]`;
- H6's READ COMMITTED reasoning, lock order, pool use, and that no caller runs inside a transaction. Node 22 fetch was probed: a timeout before the headers or during the body read gives `TimeoutError`, and a killed or refused connection gives `TypeError`. All match the mapping.

**UI, H3 and scope half:** no HIGH or MEDIUM. Confirmed correct:
- the H1 role matrix;
- the exact H4 strings;
- no nested forms, `display: contents` is harmless, the read-only branches are intact, the `key` remounts only when the callback changes, and the action is never called through `runAction` or a catch;
- all 22 H3 replacements wait for something to appear, every negative or debounce sleep was kept, nothing was weakened, and H3 touched only §6.2's files.

## 4. Scope check
- **Product files:** all inside §9.
- **Pre-approved outside §9:** `src/server/actions/qbo.ts:18-22`, confirmed comment-only.
- **Tests outside §9's file list:**
  - required by §10: `unit/qbo-connect-action`, `unit/qbo-token`, `integration/qbo-token-refresh`, `integration/mass-assignment`, `unit/reminder-email-footer`;
  - disclosed extras: one H4 case in `integration/timesheet-read`, and a mock-only fix in `unit/integration-provider-errors` (commit `0af93b0`; no assertion changed).
- **Named in §9, not changed:** `integration/home-data` (see #9), `unit/past-timesheets-page` (T6 covers H2 in `integration/approver-rules`).
- **No product behaviour change outside the blueprint.**

## 5. Findings (all LOW; none blocks the merge)
| # | Finding | Disposition |
|---|---|---|
| **L1** | **The Q2 line uses typographic apostrophes** ("You’ll", "haven’t"; `NotificationsClient.tsx:96`). The approved text has straight ones. Every word matches, and curly apostrophes are the app's convention (e.g. `:36`). | **Product owner's call.** Lead's recommendation: keep the curly ones (consistent with every other string). |
| S1 | T21b's "expired Gusto id → refresh path" case is rejected by the fast path first, so the in-transaction provider check has no test. Nothing ever changes a connection's provider, so that check can't be reached by a real request. **The blueprint's wording was the lead's miss;** the dev's test proves the reachable behaviour (error, no fetch). | Recorded. No change. |
| S2 | T18's "exactly one fetch" can't fail with a single caller. T20 plus the `pg_locks` wait are the real proof (the test DB has one connection). | Recorded. |
| S3 | Pre-existing: a 200 reply from Intuit that isn't JSON (a maintenance page) throws `SyntaxError`, which shows the generic error, not "QuickBooks didn't respond…". | Recorded; a candidate for a later hardening pass. |
| S4 | No `lock_timeout` on the token lock. Accepted in §8b.3 (each waiter at most about 15 s per holder). | Accepted. |
| U1 | Connect / Reconnect show no pending state while the action runs. A double click is safe in practice (Next queues server actions; the browser ends on the second state and cookie). One narrow race leads to a nonce mismatch and a retry, as the old link could. | Recorded. Not in the blueprint. |
| U2 | Two `waitUntil` conditions are already true on the first check (`approvals-review:365`, `users-row-actions:389`). They're as strong as before in practice. | Recorded. |
| U3 | The read-only hub test doesn't assert that there's no `<form>`. The read-only branch is unchanged. | Recorded. |
| — | Pre-existing (from the impact analysis): `fetchQBOClassesForMapping` has no `validateUUID`, and has no UI caller. | Recorded. |

## 6. Merge gate: what's left
1. **The product owner** pushes `launch-hardening` and opens the PR. CI must be green. It runs the isolation databases and has no stale `.next`.
2. **On the product owner's machine:** `npm run build` (this also regenerates `.next/types`, clearing the `tsc` noise), `npm run demo:local`, `AUTH_TRUST_HOST=true npm run start`, then the browser checks in blueprint §11:
   - Notifications by role;
   - the Self-returned badge;
   - a new account's progress line;
   - Connect / Reconnect: JS on, JS off, a direct GET to `/api/integrations/qbo-connect` returns 404, and the config-missing banner.
3. After the product owner says it's stable: merge, then tag `stable-YYYY-MM-DD-launch-hardening`.

## 7. Product owner's browser checks (2026-11-12)
- **A–D and F–G passed:** Notifications by role, the new account's "0 of 1", Self-returned on both screens, Connect to Intuit, both 404s, both Reconnect buttons, and the config-missing banner.
- **E (JavaScript off) is withdrawn, not failed.** With JavaScript off, the Integrations page body never renders: the settings pages finish loading in the browser (`src/app/(app)/settings/loading.tsx`, on `main` before this branch). CadenzPoint doesn't support use without JavaScript, so the check couldn't run.
  - The blueprint's no-JavaScript scenario (§8.2 item 4, §11 item 4) was the lead's over-reach. The real case, a click in the moment before the page finishes loading, is covered by T15 and the lead's hop check.
  - No code change is needed.
- **Verdict stands: READY.** The merge waits only on green CI.
