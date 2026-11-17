# 3b-fix (backup run crash on a connect-stage deadline or stop): audit

**Item:** 3b-fix (`LAUNCH-TRACKER.md` on `disaster-restore-button`; Q-A1, 2026-11-17: its own branch). **Found by:** the 3c dev, confirmed by the lead (`DISASTER-RESTORE-AUDIT.md` F-3b).

**Audited:** `da49414` on `backup-dumponce-fix`, from `main` at `8af3b2c` (the latest `main`, checked with `git fetch`).

## Verdict: **READY** at `da49414`
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
