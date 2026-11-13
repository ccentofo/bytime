# Audit: large report responses (build queue 5b)

> **Verdict: READY** at `8265d27` (fix round 1 verified; checks rehearsed against the finished branch). No HIGH or MEDIUM in the code. One MEDIUM was in Planning's own staging doc, now fixed.
>
> **Audited:** `a8c0462`, then fix round 1 at `8265d27`, on `large-report-responses` (the dev's change is `git diff fce3d03 a8c0462`), against `feature-plan-large-report-responses.md` FINAL v3.1 plus the approved implementation details in `LAUNCH-TRACKER.md` (5b handoff note, 2026-11-13).
>
> **Lead:** CadenzPoint Planning, 2026-11-13.

## 1. Scope check
- **17 files, exactly the blueprint's §10.1 set.** No file or behaviour change outside the blast radius.
- **Product-visible changes are exactly what the product owner approved:**
  - the Excel message text is Q2's, word for word;
  - the cap is 25,000 (Q1), only on the detailed cost Excel, after the no-hours check;
  - `/api/v1/periods` and `/api/v1/timesheets/approved` stream (Q4);
  - no Downloads text changed (Q5).
- CSV and API status codes, headers and bodies are unchanged: byte identity was proven against the old code (§3).
- **Two small extras within the design, accepted:**
  - `streamJoined` loops past an empty batch (only reachable with an empty first item and no head), which keeps "never an empty chunk" and "each pull enqueues or closes" literally true;
  - T15 also pins the `maxDuration` line for the two Q4 routes.

## 2. Lead gates (2026-11-13, at `a8c0462`)
| Gate | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors in source. Two errors in the stale generated `.next/dev/types/validator.ts` (it names routes deleted by launch hardening H5): the product owner's dev-server state, unchanged by this item. |
| `eslint` on the 17 changed files | clean |
| `npm run test` | 232 files, 2,543 tests passed (baseline 227 / 2,525) |
| `npm run db:safety` | ✓ |
| Integration (`REQUIRE_CONTROL_PLANE_TESTS=1`, `TZ=America/New_York`) | 86 files passed, 2 skipped (the isolation suites), **3 failed under load**: `stripe-webhook` lock timeout → 503, `tenant-delete` drop with an open connection, `tenant-lifecycle-cron` lock-timeout skip. None touches 5b's files, and the run overlapped my unit-test runs. **Re-run alone: 3 files, 90/90 passed.** Timing-sensitive tests, not 5b. |
| Dev's report | `test:tz` all 3 zones; integration 89 files passed, 2 skipped (the isolation suites need `TEST_DATABASE_URL`); `npm run build` ✓ with all five routes dynamic |

Also removed four of Planning's own leftover auditor worktrees (`.claude/worktrees/agent-*`, all clean). They were why `npm run lint` swept up 196 errors.

## 3. Independent review
**Break-it** (`/tmp/5b-breakit/breakit.mjs`, uncommitted; 15 exact-text mutations of product code, each run against one test file, restored with `git checkout`): **14 of 15 caught.**
- Caught:
  - in the stream helper: `highWaterMark` 1, no separator before later batches, tail dropped, Sentry not called;
  - in the CSV route: a buffered body, a CRLF separator;
  - in the API helper: an extra space in the head, the meta key order;
  - `/api/v1/costs`, `/periods` and `/timesheets/approved` each back to `apiResponse`;
  - the Excel cap: `>=`, the check removed, the message changed.
- Missed by its target file only: an extra empty line from `csvLines`. T6 builds its expected bytes with `generateCsv`, which calls the same `csvLines`, as the blueprint prescribed. The full suite still catches it (`csv-generator.test.ts` "handles empty data", `payroll-flsa.test.ts`). LOW, L1.

**Auditor A (server and runtime; own worktree): READY, no HIGH or MEDIUM.**
- **Invariants:** authorization comes before any byte; everything that can fail runs before `new Response`; the stream holds only the prepared strings, never `data`.
- **Byte identity.** The old route and the new one ran side by side through the same mocks, and the bytes were identical:
  - CSV, n ∈ {1, 2, 999, 1000, 1001, 3777}: formula-looking values, commas, quotes, CR/LF, emoji, lone surrogates, nulls. The BOM, status and headers also match.
  - JSON, n ∈ {0, 1, 1000, 1001, 2345}: Dates (valid, invalid, nested), `undefined`, functions, `-0`, `Infinity`, and a meta that overrides `timestamp`.
  - No chunk boundary can split a surrogate pair.
- **Through Next's real `pipeToNodeResponse` into an `http` server:**
  - **Backpressure:** pulls stopped at 8,000 of 200,000 items with a paused client.
  - **Disconnect:** at most one batch is in flight, then no more pulls, and no Sentry noise.
  - **A throw at item 2,500:** the client saw "aborted", not a clean end. Sentry captured it once, plus Next's expected `onRequestError`.
  - **Every empty edge case** closes without hanging.
- **Other checks:**
  - no client bundle reaches `stream-text.ts` or Sentry (`csv-generator.ts` still imports only `@/lib/csv/escape`);
  - nothing in the path buffers the body (Sentry's wrapper reads only `status`, and the ISR branch doesn't apply);
  - `maxDuration` passes `route-segment-config.test.ts`.

**Auditor B (tests, scope and checks; own worktree):**
- **Code and tests:** clean. All of T1–T16 exist and assert what §11 says (sizes over 4.5 MB computed, bytes not text, the 25,000/25,001 boundary, no-hours precedence, the uncapped summary, T11 through the real `handleApiRequest`). **20 of 20 of its own reverts failed their tests.**
- **Docs:** one MEDIUM and four LOWs, all in **Planning's** documents (§4).

## 4. Findings

| # | Severity | Where | Finding | Status |
|---|---|---|---|---|
| M1 | MEDIUM (Planning's doc) | `PRODUCTION-DEPLOY.md` 12.13 step 2 | The seed used Neon's `current_date` (UTC), but the helper's window ends on the local date. After 19:00 in Maryland, the last 120 rows fall outside it, so `meta.total` would read 40,680 and the step says stop. | **Fixed by the lead:** the rows now end yesterday by the database clock (`current_date - 1 - d`, contract start `- 401`). Verified in a rolled-back transaction: 40,800 rows, ending yesterday. |
| L1 | LOW | T6 | Its expected bytes use `generateCsv`, which shares `csvLines` with the route (as prescribed). | Accepted: `csv-generator.test.ts` and the Excel item's T10/T11 pin `csvLines`; the test's own copy of the columns caught the column and separator mutations. |
| L2 | LOW | §11 | No test proves that a row which can't serialize gives the API's JSON 500 (auditor A's lazy-serialization mutation survived). | **Fix round 1, FR1** (T11b, BigInt row) |
| L3 | LOW | §11 | Removing `maxDuration` from the cost CSV or `/api/v1/costs` broke no test. | **Fix round 1, FR2** (pin it statically) |
| L4 | LOW (Planning's doc) | checks C.4 | "all `Unpriced`": Cost Basis is lowercase `unpriced`. | Fixed |
| L5 | LOW (Planning's doc) | checks B.4 | The Class note is quoted in a text editor. | Fixed: open the file in Excel or Numbers |
| L6 | LOW (Planning's doc) | checks 0.2, C.1, G | Several "ends with" lines are wrong (more output follows; padded labels). | Fixed: "includes" |

Not verified locally (by design): Vercel's treatment of the streamed body (Q6) and a cut-off through Vercel's proxy. Both are tested at staging step 12.13 before production.

## 5. Fix round 1 (`8265d27`, tests only)
- **FR1 (T11b):** a row with a BigInt gives 500, `application/json`, `{ error: 'Internal server error' }`, and one Sentry capture. The dev's revert (lazy per-batch serialization) failed; **my own revert** (a lazy `{ length, slice }` that serializes per batch) also failed.
- **FR2:** `maxDuration = 300` is pinned in the cost CSV route and `/api/v1/costs`. Deleting it from each route failed its own pin; my own revert on `/api/v1/costs` also failed.
- **Gates after the fix:** 232 files, 2,546 tests passed; tsc clean in source; the two changed test files lint clean.

## 6. Checks rehearsal (2026-11-13, at `e322f50`, which contains `8265d27`)
Every one of the 19 code blocks was extracted verbatim and run in its own fresh interactive zsh, in order, from a reset demo through cleanup.
- **Results:**
  - M: the baseline returned four 200s.
  - A: `compare` gave `costs.csv: IDENTICAL`, `costs.json: IDENTICAL`, `periods.json: SAME ROWS`, `approved.json: SAME ROWS`.
  - C: 26,000 rows seeded; `Excel (cost report): 422` with the exact Q2 message; the CSV returned 200 with 26,004 non-empty lines and the Class note last; the Hours summary returned 200.
  - G: the workspace was deleted (database dropped), the key and files removed, the demo reset.
  - Afterwards: no `bytime_lrr*` database, no test key, port 3000 free, a clean tree.
- **Clicks:** the in-app browser isn't available on this install, so the browser steps (B, C.4) were checked by signing in with curl and fetching the exact URLs the buttons call, and then reading the files:
  - B's CSV headers and last line, and the Excel's header, TOTALS, unpriced row and two notes;
  - C.4's Excel message, plus a CSV row with LCAT Title `Unpriced` and Cost Basis `unpriced`.
  - No person clicked.
- **Fixed by the rehearsal:** the baseline step switched to the local `main` branch, which on this machine is 5 commits behind GitHub (`9427fba`, before the Excel item). That would have compared against the wrong code. It now uses `git switch --detach stable-2026-11-13-excel-cost-report` (`1d44b35`). Commit `e322f50`.
- **Also stopped,** with the product owner's permission: a stale `npm run start` from 12:42 that held port 3000.
