# Reminder email capacity (4b): lead audit

> **Verdict: READY** (2026-11-12, after fix round 1 at `bc6024c`; §8). The first verdict was NOT READY, with fix round 1 (FR1–FR7) inside the approved blueprint. No HIGH findings and no scope items at any point.
>
> **Next:** the product owner pushes the branch and opens the PR, CI goes green, then the product owner runs the build plus `REMINDER-CAPACITY-BROWSER-CHECKS.md` personally.
>
> **Audited:** branch `reminder-capacity`, commits `5639b5e`, `004d159`, `a58c5ff`, `8f3262a` on `44c01e9`. Blueprint `feature-plan-reminder-capacity.md` FINAL v3.1, plus the implementation details approved at the impact-analysis review (tracker handoff notes).

## 1. Lead gates (2026-11-12, at `8f3262a`)
| Gate | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors in source or tests. The only 2 errors are in `.next/dev/types/validator.ts`, a stale dev-server file from 2026-11-11 that still points at the `gusto-connect` / `qbo-connect` routes deleted in launch hardening. Not from this branch; the next `next dev` regenerates it. |
| `npm run lint` | 0 errors (39 warnings, none in a changed file). |
| `npm run test` | 225 files, 2,504 passed. |
| `npm run build` | Compiled (run for the checks rehearsal). |
| Integration `reminder-batch-cron.test.ts` | 3 passed (run by auditor B with `REQUIRE_CONTROL_PLANE_TESTS=1`). The full integration suite: the dev reports 722 passed, 0 failed; the product owner re-runs it at the merge gate. |

## 2. Break-it (`breakit-check-reminder-capacity.mjs`, uncommitted)
The lead's own 25 mutations, chosen independently of the dev's 91: **25 of 25 caught**, tree clean afterwards. They cover:
- **Batch helper (#1–10):** strict validation, quota retried, 403 not a stop, concurrent-409 not retried, no redaction, `sent` from all entries, timeout not retried, time-cap shape, unsorted key, wrong sender.
- **Sweep (#11–14):** no grace, reason always `budget`, `stopReason` missing from `detail`, no alert time-box.
- **Routes (#15–25):**
  - the breaker reset on zero-sent, and concurrent-409s counted;
  - email stops returning `lastDone`, or ignored on a full batch;
  - the period filter, `approved`, opt-outs, and the entry-today skip;
  - a batch size of 50;
  - out of time without a flush;
  - the slug in the key.

## 3. Checks rehearsal (`REMINDER-CAPACITY-BROWSER-CHECKS.md`)
Run by the lead against the finished branch, every step as written.

| Check | What happened |
|---|---|
| A | 150 reminders went out as 2 requests: `emails=100` and `emails=50`, both `validation=permissive` with `rem:daily-reminder:` keys. `sent: 152` (2 from the local `fresh` workspace), `batches: 3`, `stopReason: null`. No demo-domain mail. |
| B | The same 3 keys, each `KEY SEEN BEFORE`. |
| C | One request only; `stopReason: "email-quota"`, `incomplete: true`, `sent: 0`, `batches: 1`. Both console lines matched character for character. The `cron-incomplete` alert stored `detail.stopReason = "email-quota"`. |
| D | The next complete run resolved the alert ("next run completed"). `rccheck` was deleted and its database dropped. |

**Fixed in the checks file:**
- The stand-in printed only a key's first 40 characters, which are the same for every batch in one workspace. It now prints the key's ending, and A.3/B.2 compare endings. Auditor B found the same issue independently.
- The Expect lines now quote the scripts' exact output: the seed line, `BEGIN` / `INSERT` before the count, the delete dry run and its receipt.
- C.2 and C.4 explain `resumes: { <slug>: null }` after a quota stop, and the possible `[ops alert]` line.

The status line now says "rehearsed".

## 4. Scope check
`git diff --name-only 44c01e9..HEAD` is exactly the §10.1 list (13 files). The §10.2 files are untouched: `notices.ts`, `ops-alert-email.ts`, the templates, `vercel.json`, `heartbeat.ts`, `run-cron.ts`, and the 7 `@/lib/email/send` mock factories. **No change to product behaviour beyond the blueprint.** Nothing for the product owner.

## 5. Independent auditors
Two fresh reviewers, each in its own git worktree, with no access to the dev's report:
- **A:** server code;
- **B:** tests, scope and the checks file.

Both left their trees clean. Neither found a HIGH.

**Confirmed sound** (verified in code by the auditors, and by the lead where noted):
- **Resend SDK 6.12.4:** `{ data, error, headers }`; HTTP and network failures never reject; a non-JSON error body and a network failure both retry as A7; a payload without `react` isn't mutated; both headers are sent; `RESEND_BASE_URL` is honoured.
- **Classification:** A1–A10 in the right order.
- **Late rejections:** a send that rejects after the timeout won is absorbed by `Promise.race` (no unhandled rejection), and timers are cleared.
- **Retries and keys:** retry bodies are byte-identical; the key is ≤ 136 characters, deterministic, and holds no address.
- **Recipients and content:** the same skip rules in the same order, the same subjects, props and `appUrl` as `44c01e9`. The daily cron never reads preferences (lead read, auditor A).
- **Resume rules:** email stops keep `resumeAfter` on all three paths; budget stops return `lastDone`.
- **Sweep:** `stopReason` is in `detail`; the budget text is byte-identical; the error level is right; the 10 s alert time-box holds.
- **Timing:** the bound holds at about 275 s.
- **PII:** no full address in logs or Sentry.
- **Tests:** I1 covers all nine employee kinds; I2 is a real query-count comparison.

## 6. Findings

### Fix round 1 (sent to the dev; within the blueprint)
| # | Sev | Finding | Fix |
|---|---|---|---|
| FR1 | MEDIUM (A rated it MEDIUM; the lead agrees it's a real gap in the blueprint's §6.4 rule, though its production effect is mild) | **A slow but working Resend never trips the breaker.** A timeout leaves the first request in flight (the SDK can't abort). The retry, with the same key, gets 409 `concurrent_idempotent_requests`, so the batch ends `failed` with that name, which the breaker exempts (`send-batch.ts:86,107`; `tally` in both routes). Proved by auditor A with a probe test. Effect: the run keeps going until the 240 s budget instead of stopping with `email-failing`, and the alert says "time budget". The emails most likely do go out, slowly. | In `deliverReminderBatch`, if **any** attempt of this batch timed out and the batch ends `failed` after retries, return `errorName: 'send_timeout'`, so the breaker counts it. A batch whose only retryable results were concurrent-409s keeps that name and stays exempt. **Tests:** B25 (never settles, then 409, then 409 → `failed`, `send_timeout`); C14(f) (three such batches → `email-failing`); C14(e) unchanged. |
| FR2 | MEDIUM (both auditors, proved by mutation) | **The retry time cap isn't pinned.** Either `now() + 2000 > notAfter` or `now() + 12000 > notAfter` passes every test (B21's `notAfter` = +13 s stops all three variants, `send-batch.ts:200`). | Add B21b with an injected `now` (`opts.now`; also closes FR6), first attempt timing out: `notAfter` = start + 15 s → no retry; start + 25 s → no retry; start + 27 s → one retry. Name the two mutations each case catches in the report. |
| FR3 | LOW (B, proved) | Quota and config stops aren't checked for logging: removing the `report(...)` call for them (`send-batch.ts:190`) passes, yet the product owner's check C.4 relies on that console line. | B7, B8, B9 and B9b assert one Sentry message at level `error` and the exact console line. |
| FR4 | LOW (A and B, proved) | Untested classification paths: "429 with another name → retry" (`:85`); the `missing/invalid/restricted_api_key` names (`:82`); a JSON 4xx without `name` → retry (`:88`, `name === undefined`). | B9c: `{ name: 'restricted_api_key', statusCode: 422 }` → stop/config. B5b: `{ name: 'too_many_requests', statusCode: 429 }` then success → 2 calls. B24b: `{ message: 'Bad Request', statusCode: 400 }` (no name) then success → 2 calls. |
| FR5 | LOW (B, proved) | C12 doesn't pin the tenant's local date: the fixed clock (2026-10-21T20:00Z) is the same date in New York and UTC (`daily-reminder/route.ts:114`). | Add a C12 case at 2026-10-22T02:00Z (still 2026-10-21 in New York): the key's date is `2026-10-21`. |
| FR6 | LOW (B) | `opts.now` is never injected in the B-tests. | Covered by FR2's B21b. |
| FR7 | LOW (B) | `until()` (`email-send-batch.test.ts:47`) stops after 5,000 `setImmediate` ticks, not after a time; a slow CI render could trip it. | Bound it by real elapsed time (for example 10 s by `performance.now()`), still on real `setImmediate`. |

### Recorded, accepted (no change)
- Retries aren't re-throttled, so a 1 s window can briefly hold 3 requests from one cron. That's far under Resend's 10/s, and §6.4's own pseudocode has the same shape (A).
- `batches` counts a render failure, which makes no request (A). Rare; it also feeds the breaker, which is reasonable.
- An email stop with no saved resume point lists that workspace under "resumes mid-way" (`null`), as a budget stop before the first employee does today (A).
- More ids than messages logs a warning with an empty domain list (A, B). Cosmetic; B3 (cap) asserts the warning.
- The A1 warning test uses `idCount` rather than the capped `sent`. Benign (A).

## 7. Next
1. The dev applies FR1–FR7 as one commit (tests plus the FR1 code change), re-runs `tsc`, the full `npm run test`, and the integration file, and names a revert check for each new test.
2. The lead re-runs the gates, break-it (plus FR1/FR2 mutations) and appends a verification section here.
3. Then READY → CI → the product owner's build and `REMINDER-CAPACITY-BROWSER-CHECKS.md`.

## 8. Verification after fix round 1 (2026-11-12, `bc6024c`)
- **The change:** one commit with three files: `send-batch.ts` (FR1 only: a `timedOut` flag; a batch that ends `failed` after retries is named `send_timeout` if any attempt timed out), `email-send-batch.test.ts`, `reminder-crons.test.ts`. No other file. The lead read the diff: FR1 matches §6 exactly. It's applied on the retries-ended path only, the one path where a concurrent-409 name can survive; A8–A10 endings keep their own names, which the breaker already counts.
- **Tests added:**
  - B25 plus an all-409 contrast that stays exempt;
  - C14(f) for both crons, driving the **real** helper through a fake client whose first request per key hangs and whose retries get 409;
  - B21b, with three `notAfter` cases on an injected `now`;
  - FR3 logging assertions on B7/B8/B9/B9b;
  - B9c, B5b, B24b;
  - C12 at 02:00 UTC for both crons;
  - `until()` bounded by 10 s of real time.
- **Lead gates:**

  | Gate | Result |
  |---|---|
  | `tsc` | 0 source errors (the 2 known stale `.next/dev` errors only) |
  | `npm run lint` | 0 errors |
  | `npm run test` | 225 files, **2,516 passed** |

  The dev reports the reminder integration file 3/3 and its own 16 fix-round revert mutations plus the original set, 109/109, re-run on the committed tree.
- **Lead break-it, extended to 32 checks:** **32 of 32 caught**, tree clean. The new ones:
  - FR1 reverted (caught by the helper tests and by the cron tests);
  - the cap without the timeout term, and without the delay term;
  - no logging on quota/config stops;
  - an other-named 429 not retried;
  - the UTC date in the key.
- **Dev process note (self-reported):** its first revert run happened before committing, so its script's `git checkout` reverted the uncommitted FR1 code. It noticed (4 checks reported "text not found"), re-applied, committed, and re-ran on the committed tree. Its break-it now runs on committed trees only. No effect on the result; the lead's checks ran on `bc6024c`.
- **Open LOWs:** the accepted items in §6 ("Recorded, accepted") stand.

**Verdict: READY.**

