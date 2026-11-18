# Control-plane disaster (3c-2): audit

**Item:** build queue 3c-2. **Blueprint:** `feature-plan-control-plane-disaster.md` FINAL v2.0, accepted 2026-11-18 (Q1–Q3), plus the approved details D1–D14 and P1 (`LAUNCH-TRACKER.md`, 3c-2 row).

**Audited:** `7b6a845..bce561e` on `control-plane-disaster`: 11 dev commits (C1–C9 and two test commits). Auditors at `bce561e`.

## Verdict: **READY** at `f1ea99e` (after fix round 1)
Round 1 (`bce561e`) was NOT READY (§4). Fix round 1 (FR1–FR10) is verified in §6. The lead's gates, integration alone, break-it (10/10) and re-run checks (§7) all pass.

**Merge gate for the product owner:** push `f1ea99e` (plus the lead's commits) and get a green CI run, push and PR. The early run on `4e63039` was all green. Production readiness: PRODUCTION-DEPLOY 13b step 0/6/11 (the backup id) and 13c (the control-plane rehearsal press), with the founder.

No scope items for the product owner.

## Round 1 verdict (kept for the record): NOT READY, fix round 1 required
- **Severity:** no HIGH; 2 MEDIUM code defects, about 9 LOWs, and test gaps (30 surviving mutations across both auditors).
- **Nothing in the code** can rebuild a live control plane, delete a project something points at, write outside the new project in mode `control-plane`, or skip a live workspace in a deploy.
- **Fix round:** none of the findings changes what the product does, so it goes to the dev directly, inside the blueprint (§5).

**CI:** the push run on `4e63039` was **all green**, including the first Docker build of the image with the 3c-2 code, the in-image self-check, and CI's cfn-lint block as written. The PR's run is pending until a PR is opened.

## 1. Scope check
Every changed file is in the blueprint's §10, or is explained by D1–D14 or the dev report:
- `Dockerfile.backup` and `tsconfig.backup.json` (D1);
- the new `src/lib/tenant/proven-gone.ts` (D3's module) and `window-slugs.ts` (D8's query);
- `src/lib/billing/checkout-link.ts` and `scripts/backup/lib/disaster-sql.ts` (§10);
- existing tests edited where the blueprint changes what they pin (dev report §6.7);
- the test helpers (`drop-db.ts`, `fake-neon`, `fake-stripe`, the harness).

**No customer-facing change** beyond the reserved and window slugs. **No `package.json` change.**

**Small additions the lead accepts:**
- the action-row kind `window-project`/`listed`;
- the rehearsal's fallback window start (now − 26 h when a backup has no `startedAt`);
- R2's race outcomes → `unknown`;
- `target` and the merge landing in C4.

## 2. Lead gates (main tree at `bce561e`)
| Gate | Result |
|---|---|
| `npx tsc --noEmit` | ✅ |
| `eslint . --ignore-pattern '.claude/**'` | ✅ 0 errors (39 pre-existing warnings) |
| `npm run db:safety` | ✅ |
| `npx vitest run` | ✅ 262 files; 3,148 passed, 1 skipped |
| Integration, **run alone**, CI-equivalent environment (`.env`, `REQUIRE_CONTROL_PLANE_TESTS=1`, `TZ=America/New_York`, `TEST_DATABASE_URL`, pg 16 tools), finished 09:46 Eastern | ✅ 112 files passed, 1 skipped (`tenant-data-isolation`, as in CI); **1,046 passed, 0 failed**; no scratch databases left |
| CI push run, `4e63039` | ✅ all four jobs |

## 3. Independent auditors
Two auditors worked in their own worktrees at `bce561e`:
- **A:** the backup task, AWS and the button;
- **B:** the app side, `tenant:delete`, Stripe, monitoring, docs, tests and scope.

**Both confirmed:**
- **Invariant 3:** mode `control-plane` takes no lock and writes no run row before step 8; its only contact with the old URL is leg (d); it records in one transaction in the new project, with no action row.
- **The gone-proof:** legs (a)–(d) and the re-check.
- **`rebuild-exists`:** exact, live-only, with the don't-delete wording verbatim.
- **R2:** chain ends only; `switchGuards` with the new control plane's host; `rt_`; pooled us-east-1; `sslmode`; the byte-equal guarded UPDATE.
- **R3:** precedence and every row; no path to a skip proof for a reachable or served workspace.
- **R4:** the bounds.
- **The backup id and `main.ts`.**
- **Run rows:** `target` at INSERT, merged on every close.
- **The rehearsal's isolation.**
- **IAM:** the exact grants; no `PutParameter`.
- **The button:** `DisasterModes` and its fallback; masking; ids-only logs.
- **`--project-proven-gone`:** all five checks in order, only the "not found" refusal replaced, every safeguard kept, a no-op on resume.
- **`stripe-resync`:** the `tenantId` re-link rule, the shared link rule (the webhook unchanged), `customerId`, seat sync, the live and never-null email, and no notice, `after()` or email printed.
- **`window-signup`**, the reserved and window slugs, and the monitoring.
- **`--skip-lost`.**
- **The runbooks** against the real commands.

**Mutations:** A caught 63 of 82 (one equivalent) and B caught 53 of 64 (two not real misses). Every other miss is a test gap.

## 4. Findings
| # | Severity | Finding | Where |
|---|---|---|---|
| FR1 | **MEDIUM** | **`stripe-resync` never refreshes a workspace whose window checkout ends in a conflict.** Step 1's planned workspaces are left out of step 2, and the conflict branch returns before `reconcileInLock`. §6.10 step 2 says **every** paying workspace. Re-runs never fix it, and the dry run lists it under "refresh". Reproduced by auditor B (`past_due` stays, the old billing email stays). | `admin-commands.ts:404,423` |
| FR2 | **MEDIUM** (rated LOW by auditor A; raised by the lead because of the data-loss path) | **An end-less listed R2 chain's projects are neither excluded from R4 nor named under R2.** That covers no tenant row, a deleted row, a row outside every chain, or a healed `-` line. R4 then raises the chain's new project as type `rebuild` ("delete it in Neon if nothing in this email names it"). Scenario: someone signs up in the window and 3c rebuilds them in the window. Their row is lost, so the founder deletes the customer's only copy, and no `signup` alert holds the address. Reproduced by auditor A. | `disaster-reconcile.ts:153-158,324,408` |
| FR3 | LOW | A Stripe error while reading the current customer is swallowed into "conflict" (exit 0). §6.10 says exit 1 if any failed. | `admin-commands.ts:398` |
| FR4 | LOW | The email offers `all-lost` while a tenant with R2 lines is `unknown` (its chain lookup 5xx'd, no proof), so 3c's `all-lost` filter doesn't protect it. Only B.5a's ordering does. | `disaster-reconcile.ts:381`; `disaster-workspace.ts:55` |
| FR5 | LOW | The window block reaches the verify route's older `ProvisionConflictError` path. It marks the signup **consumed**, so `window-signup` no longer lists it, and it tells the user "sign up again with a different name" (contradicting B2). | `provision.ts:61`; `signup/verify/route.ts:180-183` |
| FR6 | LOW (docs) | B.8/B.9 resolve alerts by id, but nothing prints the ids while the digest is off. | `RESTORE.md:242,262` |
| FR7 | LOW (docs) | RESTORE.md:84-85 still says "item 3c-2 (still to be built)". B.3's refusal list omits `network-unproven`. | `RESTORE.md` |
| FR8 | LOW (test) | D3's static test reads only lines starting `import`/`export`/`require(`, so a multi-line import or an `await import()` passes (M59). Its title says three scripts but pins two. | `control-plane-disaster-static.test.ts:118-121` |
| FR9 | LOW (test hygiene) | `drop-db.ts:19` retries DROP in a tight loop if 42501 persists without an autovacuum worker. | `src/__tests__/helpers/drop-db.ts` |
| FR10 | MEDIUM (test gaps) | Guarded rules with no catching test; the list follows the table. | tests |

**FR10, the surviving mutations to cover** (one test each, failing under that mutation):
- **Mode `control-plane`:**
  - leg (d) `unproven` ignored (C07);
  - the 3-candidate cap (C11);
  - the re-check of the recoverable list (C14);
  - `pass` when the reconcile threw (C17, §7.1);
  - the reconcile's guard-host wiring from mode `control-plane` (C19);
  - the `windowStart` wiring (C20).
- **The reconcile:**
  - a normal chain plus a healed `-` line (R01);
  - the D5 pooled-host check (R08);
  - the D6 `rt_` check (R09);
  - the byte-equal URL condition (R12);
  - **`served` → stale** (R16; under it, a served tenant gets `gone`);
  - R1's positive control (R27) and network first (R30);
  - P1's exit 1 when R1 fails (R29).
- **Elsewhere:**
  - the newest-decisive-proof ordering (L08);
  - `controlPlaneLines`' own target and id filter (L11);
  - the control-plane rehearsal's positive control and its `CONTROL_PLANE_PROJECT_ID` 200 check (H04, H05).
- **`stripe-resync` (T27):**
  - session pagination (M25);
  - a null live email on a **relinked** workspace (M30);
  - the per-tenant dedupe (M34);
  - D12's live statuses (M35);
  - the CLI's exit 1 (M36);
  - the CLI's `--stripe-mode` wiring (M37);
  - a static check for no `after()`.
- **Monitoring:**
  - a Neon **5xx** never resolves `window-project` (M48);
  - the control plane's "recoverable" wording (M51);
  - `readDisasterFacts`' `target` end to end (M55, M61);
  - the cron calls `syncWindowProjects` (M62).
- **Other:**
  - T23's in-list positive-control leg isolated (M03, the class fixed for T7);
  - the webhook's `if (!link.ok) return null` (M56; a gap that predates 3c-2, but this item touches the line).

## 5. Fix round 1 (sent to the dev, inside the blueprint)
1. **FR1:** a workspace whose link ends in a conflict is still refreshed against its **current** customer: `reconcileInLock` without the link patch, with the live email when that's present. The outcome reads `conflict (refreshed)`. Test (auditor B's scenario): after `--yes` the row mirrors the live subscription, and the conflict alert is raised.
2. **FR2:** for a listed chain without a resolvable end, collect every `new` id in that tenant's lines, exclude them from R4, and print them in the email's "unconfirmed rebuild" list next to the tenant id ("project(s) `<ids>` kept: contact the lead; don't delete"). Test (auditor A's scenario): no `window-project` alert for those ids, and the ids appear in the email.
3. **FR3:** a failed read of the current customer → that workspace `failed` (exit 1), not `conflict`. Test.
4. **FR4:** the email offers `all-lost` only when no tenant is `unconfirmed rebuild` **and** no tenant with R2 lines is `unknown`. Test.
5. **FR5:** the verify route's `ProvisionConflictError` path doesn't consume a row when the cause is an open window address. The user sees the plain "taken" message, and the row stays listed for `window-signup`. Test.
6. **FR6:** `window-signup` prints its alert's id. The reconcile email prints each `window-project` alert's id. B.8 gains a one-line query to list open `stripe-event-unknown-customer` alert ids (`tenant:admin` has an existing alert listing; use it if it prints global alerts, otherwise document the psql line). Update B.8/B.9.
7. **FR7:** fix RESTORE.md:84-85, and add `network-unproven` ("press again") to B.3.
8. **FR8:** make D3's static test catch multi-line imports and dynamic `import()` (match the module specifier anywhere), and fix the title.
9. **FR9:** the retry loop sleeps between tries.
10. **FR10:** one test per surviving mutation above, each failing under that mutation.

Then:
- re-run every gate (integration alone with the full CI environment; the 5× and CPU-hog rule for touched integration files);
- revert-check the new tests;
- add a fix-round section to the dev report;
- commit by name;
- message the lead.

## 6. Verification after fix round 1 (`f1ea99e`)
**Code read by the lead:**
- **FR1:** a conflicting workspace is refreshed with `reconcileInLock` against its current customer, using that customer's live email, and reported under both conflict and refreshed.
- **FR3:** a failed read of the current customer → `failed` (exit 1).
- **FR2:** every project a listed or unknown chain names is kept out of R4 and printed with "kept: contact the lead; don't delete". That's a superset of the rule asked for, on the safe side.
- **FR4:** `all-lost` is offered only with no unconfirmed rebuild and no unknown chain.
- **FR5:** `ProvisionConflictError` gains a `window` reason; the verify route shows "taken" without consuming the signup.
- **FR6:** alert ids are printed by `window-signup` and in the reconcile email. B.8 uses a documented psql line, since `tenant:admin` lists only tenant-scoped alerts.
- **FR7, FR8 and FR9:** done as specified.

**The dev's evidence:**
- 39/39 revert checks caught;
- 42/42 green across the 7 touched files (5× each plus a CPU-hog run);
- full integration: 1,070 passed, 0 failed.

**Lead gates:**

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | ✅ |
| `eslint . --ignore-pattern '.claude/**'` | ✅ 0 errors |
| `npx vitest run` | ✅ 3,154 passed, 1 skipped |
| Integration, **run alone**, CI-equivalent environment, finished 10:28 Eastern | ✅ 112 files passed, 1 skipped; **1,070 passed, 0 failed**; no scratch databases left |

**Lead break-it** (`/tmp/cp2-breakit/run.py`; one exact edit each, run the test, restore): **10 of 10 caught, tree clean.**
1. FR1, a conflicting workspace not refreshed;
2. FR2, listed chains' projects back in R4;
3. R3, a served address no longer stale;
4. `rebuild-exists` without the don't-delete wording;
5. `--project-proven-gone` accepting a non-`auth` failure;
6. `--project-proven-gone` ignoring a live project serving the host;
7. `control-prod` not reserved;
8. window addresses not held at signup;
9. the backup id accepting any value;
10. `all-lost` not skipping `chain-unconfirmed`.

Case 4 first ran against the unit suite by mistake; it's caught by `disaster-control-plane.test.ts`.

## 7. Checks run by the lead (`CONTROL-PLANE-DISASTER-BROWSER-CHECKS.md`, at `bce561e`, 2026-11-18)
**Method:** every bash block (32) was extracted verbatim, and each ran in a fresh `zsh -i -s`. The blocks whose lines the display had cut off were re-run whole. Throwaway workspaces `cp1118094710` and `cp1118094754`.

| Section | Result | Evidence |
|---|---|---|
| 0 Setup | ✅ | migrations applied; usage line; `Ready: cp1118094710 …`; bundle built |
| A Outside AWS | ✅ | `refused: outside ECS only \`--self-check\` and \`backup --dry-run\` against a local control plane may run` |
| B.1 Wrong target | ✅ | `refused: mode control-plane takes targets control-plane`; aws calls 0 |
| B.2 Wrong confirm | ✅ | `refused: confirm must be exactly: control-plane`; aws calls 0 |
| B.3 No `DisasterModes` | ✅ | `refused: the Backup system deploy that adds this mode is pending approval: approve it in GitHub, then press again`; 2 aws calls (`list-tasks`, `describe-stacks`); no `run-task` |
| B.4 Mode listed | ✅ | it passes the mode check; the next refusal is `the backup stack has no TaskSubnets/TaskSecurityGroup outputs …` |
| C.1 Reserved names | ✅ | `control-prod`, `restore-tests`, `recoverable-canary`, `r-deadbeef-x`, `control-r20261118000000-1` and `rehearse-cp-20261118000000-1` → `invalid`; `control-room` and `harbor` → available |
| C.2 No alert | ✅ | `✗ "cpchkwindow" is not a window signup (no open window-project alert names it).` |
| C.3 Held address | ✅ | `slug cpchkwindow: {"available":false,"reason":"taken"}` |
| C.4 Lookup | ✅ | `Window project test-cpchk-proj for "cpchkwindow" …`, then `"CP Check Co"  cpchk@example.invalid … not verified` |
| C.5 Release | ✅ | `window check: {"checked":1,"resolved":1}`; `window alert resolved: true`; slug available |
| D Proven-gone on a local workspace | ✅ | `✗ --project-proven-gone is only for a workspace with its own Neon project; nothing was changed.`; still `status: active` |
| E Resync without a key | ✅ | `✗ STRIPE_SECRET_KEY is missing or not a recognizable Stripe key …` (no local Stripe key; T27 covers the real path) |
| F.1 `window-deleted` | ✅ | the uuid row reads `skipped: skipped (proven lost, awaiting rebuild)`; `exit code: 0`; a `skip \| skipped` row |
| F.2 `chain-unconfirmed` | ✅ | the same skip; `exit code: 0` |
| F.3 No flag | ✅ | `FAILED: database "bytime_cp…" does not exist`; `exit code: 1` |
| G Templates | ✅ | `cfn-lint: clean` |
| H Clean up | ✅ | `cleaned: cp…`; 0 `bytime_cp*` databases, 0 test alerts, 0 test signup rows left |

**Re-run at `f1ea99e`:** all 32 blocks verbatim, every **Expect** met. C.4 now also prints the alert id (FR6). Workspace `cp1118102906`, cleaned (0 databases, alerts or signup rows left).

**Not covered locally** (covered by the fakes-based integration tests, CI and the founder's 13c rehearsal):
- a real control-plane rebuild;
- the reconcile against Neon;
- the rehearsal;
- a real `--project-proven-gone` close;
- `stripe-resync` against Stripe;
- the Docker runtime stage (CI ✅ on `4e63039`).
