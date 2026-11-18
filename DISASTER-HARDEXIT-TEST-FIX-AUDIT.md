# 3c test fix (hard-exit test and other fixed timings): audit

**Why:** CI for `backup-dumponce-fix` at `f18c5e6` (which contains `main` with 3c) failed in `disaster-concurrency.test.ts` D8 with `TypeError: unblock is not a function`, then a 30 s timeout. The hard-exit timer starts at run start (50 + 50 ms in the test). On the slow runner it fired before the start sequence had called the test's hanging mode. This was a test defect: the production hard exit calls `process.exit(1)` whenever it fires.

**Audited:** `796f606` on `disaster-hardexit-test-fix`, from `main` at `58a5b3f`. **Test files only:** `disaster-concurrency.test.ts`, `disaster-harness.ts` and `disaster-button.test.ts`. No production file changed (checked with `git diff --stat 58a5b3f..HEAD -- scripts src/lib src/app`).

## Verdict: **READY** at `796f606`
Merge gate for the product owner: CI must pass on the push.

## Changes (read by the lead)
- **D8:** the hard exit is remembered; a mode called afterwards resolves at once, and `hardExit` calls `unblock?.()`. The assertions are unchanged. Both orders are tested:
  - the mode hangs first (50 + 50 ms);
  - the timer fires first (0 + 0 ms), CI's order. With the old test, this reproduced the CI failure exactly.
- **The dev's scan hardened six more timing-sensitive spots:**
  - the R9 held lock now keeps a slow heartbeat;
  - SIGTERM mid-restore waits up to 60 s for `created`;
  - the two cleanup lock tests poll `pg_locks` (holder granted, cleanup waiting) instead of sleeping 100/300 ms;
  - the harness lock timings are 500 ms / 10 s, with a 10 s wait;
  - D2 sends SIGINT only after `started`;
  - M59's margin is 20 s.

## Lead verification
- tsc clean.
- **Break-it:** with the hard-exit timer cleared in `disaster.ts`, both D8 cases fail. Restored, the tree is clean.
- **Under CPU load:** with 10 background `yes` processes, `disaster-concurrency.test.ts` passed 3 runs in a row (10 of 10 each), and `disaster-button.test.ts` passed 36 of 36. The load processes were killed afterwards.
- **Integration alone:** 105 files passed, 2 skipped; **977 passed, 0 failed** (finished 20:37 Eastern); no scratch databases left.
- **The dev's checks:** unit 3,075; the touched files passed 5 runs in a row; the CPU-load runs passed.
