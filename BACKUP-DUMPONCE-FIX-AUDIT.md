# 3b-fix (backup run crash on a connect-stage deadline or stop): audit

**Item:** 3b-fix (`LAUNCH-TRACKER.md` on `disaster-restore-button`; Q-A1, 2026-11-17: its own branch). **Found by:** the 3c dev, confirmed by the lead (`DISASTER-RESTORE-AUDIT.md` F-3b).

**Audited:** `da49414` on `backup-dumponce-fix`, from `main` at `8af3b2c` (the latest `main`, checked with `git fetch`).

## Verdict: **READY** at `380c499`
**Merge-gate items for the product owner:**
- CI must pass on the push.
- `backup.ts` is on the backup deploy list, but `backup-deploy.yml` runs only once the repository variable `AWS_BACKUPS_ENABLED` is `true` (the founder's last setup step). Until then the merge requests no deploy approval; afterwards, a change like this one asks for one **Backup system** approval.

## The defect
In `scripts/backup/backup.ts` `dumpOnce`, a target deadline or a stop that fired during the version query rejected the `pipelineDone` deferred before anything awaited it. In the image, `installCrashHandler` turns an unhandled rejection into FATAL and **exit 1 for the whole backup run**, not just that target.

## The change (read by the lead)
- **The fix:** one line, `pipelineDone.promise.catch(() => {})`, right after the deferred is created, plus a comment.
- **Why it's safe:** the real awaits (`await pipelineDone.promise` and the `begin` handler) still see the rejection, so the target fails exactly as before.
- **Nothing else changed.**

## Test
`backup-command.test.ts` S2c, two cases, a target deadline and a stop, each during a hanging version query. Each checks three things:
- the target is recorded `failed` with error `deadline`/`stopped`;
- the run exits 1;
- no `unhandledRejection` fires.

**The lead's revert check:** with the line removed, both cases fail (`2 failed`); restored, the file passes 22 of 22. The tree was clean after.

## Lead gates (worktree `../bytime-3b-fix` at `da49414`)
| Gate | Result |
|---|---|
| `npx tsc --noEmit` | ✅ exit 0 |
| `eslint . --ignore-pattern '.claude/**'` | ✅ 0 errors (39 pre-existing warnings) |
| `npm run db:safety` | ✅ |
| `npm run test:tz` | ✅ 251 files, 2,925 passed, in UTC, Los Angeles and Auckland |
| Integration, **run alone** (memory-noted environment, pg 16 tools), finished 18:07 Eastern | ✅ 98 files passed, 2 skipped; **893 passed, 0 failed**; no unhandled errors; no scratch databases left |

No scope change and no product behaviour change.

## Addendum: S21/S23 made deterministic (`380c499`, test-only)
- **The failure:** 3c's CI (push run 44194375025) failed at `backup-command.test.ts:354`, "re-take with a migration started in the gap", with `expected +0 to be 1`.
- **The cause:** the test cut the backup's lock session and only then opened MIGRATE_RUN. The backup re-takes 1 s later and checks MIGRATE_RUN at that point, so on a slow runner it could check first. The same race is on `main`.
- **The fix:** MIGRATE_RUN is taken (and asserted) before the terminate. Same code path: a migration holding its lock at re-take time.
- **The lead's verification at `380c499`:**
  - with the `migrating` branch disabled, the test fails; restored, it passes;
  - `backup-command.test.ts` passed 3 runs in a row (22 of 22 each);
  - tsc clean;
  - **integration alone: 98 files, 893 passed, 0 failed** (finished 18:41 Eastern); no scratch databases left.
