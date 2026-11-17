# Disaster restore button (3c): audit

**Item:** build queue 3c. **Blueprint:** `feature-plan-disaster-restore.md` FINAL v4.0, accepted 2026-11-17 (Q1, Q2, monthly rehearsal), plus the approved details D1–D13 and Q-D1 (`LAUNCH-TRACKER.md`, 3c row).

**Audited:** `cff7567..11667dd` on `disaster-restore-button`:
- 9 dev commits, C1–C8b, auditors at `3e0685b`;
- C8c (`11667dd`), docs only, read by the lead.

## Verdict: **READY** at `40b807e` (after fix rounds 1 and 2)
Round 1 (`11667dd`) was NOT READY (§4): 1 MEDIUM code defect, 3 MEDIUM test gaps, about 11 LOWs. Fix round 1 (FR1–FR16) is verified in §6. The lead's gates, integration alone, break-it (10/10) and checks (§7) all pass.

**Merge-gate items for the product owner:**
- **Push fix round 2** (`40b807e` plus the lead's commits) and get one green CI run (push and PR). The early push (`d7cab1f`) passed:
  - the backup image build and in-image self-check;
  - CI's cfn-lint block as written;
  - lint/build/unit (bash 5);
  - the migration check.

  Its one integration failure was the M67 test's order dependence, fixed in `b788701` (§6.1).
- `PRODUCTION-DEPLOY.md` Phase 13c (AWS, Neon and GitHub, with the founder) stays a production-readiness step, not a merge requirement.

No scope items for the product owner. **Q-A1 is decided** (F-3b gets its own branch, 3b-fix).

## Round 1 verdict (kept for the record): NOT READY, fix round 1 required
- **Severity:** no HIGH; 1 MEDIUM code defect, 3 MEDIUM test gaps, about 11 LOW code and doc defects, and further test gaps.
- **No unsafe path:** no path proves a live workspace gone, deletes a project a tenant points at, or puts a target id or slug in the public log through the button's form.
- **Fix round:** none of the findings changes what the product does, so the fix round (§5) went to the dev directly, inside the approved blueprint.

## 1. Scope check
- **Every changed file** (71) is in the blueprint's blast radius (§10) or D13, or is explained:
  - **The `disaster.ts` split:** `disaster-steps`, `-workspace`, `-rehearse` and `-settings` implement the listed `disaster.ts`.
  - **New libraries:** `classify-endpoint`, `disaster-proofs`, `disaster-sql`, `disaster-records`; `aws-clients` gains ECS and Logs.
  - **`backup-locks.ts`:** `DISASTER_LOCK_KEY` (§6.4).
- **Small additions the lead accepts** (no product behaviour):
  - `tenant:admin show` prints the workspace id (runbook A.3 needs it);
  - the runbook uses the real `set-exempt … on --reason … --yes` syntax;
  - `all-lost` reports a 404-but-reachable workspace as `not-lost`;
  - strictly increasing `disaster_actions` times;
  - extra result codes (`guard`, `create`, `not-lost`, `cleanup-failed`, `original-back`, `reachable-now`, `not-finished`, `error`);
  - cleanup budgets;
  - `NEON_REGION_ID` checked at start;
  - the stack output names `TaskSubnets`/`TaskSecurityGroup`.
- **The dev's positive-control rule.** The known project must also be **in** the organisation's list.
  - **Why it's needed:** `GET /projects/{id}` ignores `org_id`. With a wrong `NEON_ORG_ID`, every org-scoped list is empty but complete, so (c) and (d) pass vacuously.
  - **Verdict: accepted as the correct reading of invariant 2(b)**, confirmed independently by auditor A (M13 shows the wrong-org test catches its removal).
- **Docs:**
  - the setup lives in a new Phase 13c rather than inside 13b;
  - `CONTROL_PLANE_PROJECT_ID` is set for staging too (harmless: staging has `BACKUPS_EXPECTED=0`).
- **No unapproved product behaviour.**

## 2. Lead gates (main tree at `11667dd`)
| Gate | Result |
|---|---|
| `npx tsc --noEmit` | ✅ exit 0 |
| `eslint . --ignore-pattern '.claude/**'` | ✅ 0 errors (39 pre-existing warnings) |
| `npm run test` | ✅ 257 files; 3,058 passed, 1 skipped |
| `npm run db:safety` | ✅ no backward-incompatible statements |
| `cfn-lint` 1.60.1 | ✅ checks section F |
| Integration, **run alone** | see §2.1 |
| Docker image build; CI's cfn-lint block as written; bash 5 | **Not runnable here.** The early push or the merge-gate CI run proves them. |

### 2.1 Integration, run alone
- **Setup:** the memory-noted control-plane environment (`.env` sourced, `REQUIRE_CONTROL_PLANE_TESTS=1`, `TZ=America/New_York`), plus `REQUIRE_PG16_TOOLS=1` and the Homebrew pg 16 tools, after `npm run db:migrate:cp`.
- **Run:** with nothing else using the local server, at about 16:55 Eastern.
- ✅ **104 files passed, 2 skipped (the usual two); 948 passed, 0 failed, no unhandled rejection.**
- The dev's one-off S2b unhandled rejection (F-3b) didn't appear.

## 3. Independent auditors
Two auditors worked in their own worktrees at `3e0685b`.
- **A:** the restore task and the infrastructure.
- **B:** the deploy path, monitoring, guards, docs, test coverage and scope.

Both found the implementation faithful to the blueprint almost everywhere:
- **Gone proof:** (a)–(d) are org-scoped and paginated, a partial list counts as unproven, and `unproven` never counts as gone.
- **Override:** the evidence rules hold (same `old_project_id`, two runs at least 4 h apart, network first), and so do the D3 SQLSTATE order and `pgConnector`'s hard deadline.
- **The switch:** the tenant lock, byte equality, `lifecycle_version`, `updated_at`, SWITCHING before COMMIT and LINKED after.
- **Cleanup:** a locked re-read before every delete.
- **Backups and runs:** intent rows first; candidate fallback; `failed` terminal (D4); 423/429 backoff; a lost create adopted by exact name; the run lock and oldest-wins; the hard exit; the `startedBy` gate.
- **Logs:** ids only.
- **Rehearsal:** never switches.
- **IAM:** least privilege, D6 and D11.
- **`--skip-lost`:** every §6.0 rule, D1 and D2; uuid-only printing; reconnect → FAILED.
- **`deploy-prod.yml`:** the boolean only through `env:`; pins match upstream.
- **Monitoring:** every threshold, dedup, D5, and alert details carrying no secrets.
- **Guards:** `tenant:delete` checks in both locked sections; `resolve-alert` refuses.
- **Docs:** runbook A against the code; the founder steps including Q-D1, A.7 and the OIDC `sub` line.

**Mutation results** (equivalent mutants excluded):
- A caught 66 of 86 and B caught 53 of 65;
- apart from FR1, every miss was a test gap.

## 4. Findings
| # | Severity | Finding | Where |
|---|---|---|---|
| FR1 | **MEDIUM** | **The pre-switch re-check follows what the founder typed, not which proof passed.** Runbook A.2 tells the founder to press with the override early. If that workspace's project is actually gone (404), the gone proof passes and a full restore runs. Then the override re-check sees the 404 and aborts: the project is deleted, and the email says "reachable now, or unproven: nothing switched". That press can never rebuild the workspace, and it wastes a whole restore in a disaster. Had it switched, it would have raised `rebuild-original-returned` for a gone original. Reproduced by auditor A (`proof:gone, intended, created, deleted, proof:refused:proof-failed`). | `disaster-workspace.ts:188-201` |
| FR2 | MEDIUM (test gap; code correct) | **A Neon-failure day leaves Neon-based alerts and watches as they are:** untested where it's applied. Deleting the resolve-loop skip (`disaster-status.ts:330`) or the watch skip (`:161`) passes every test. Without them, a Neon outage resolves `rebuild-original-returned`/`rebuild-orphan-project` (unblocking `tenant:delete` while a copy exists) or ends a 30-day watch early. | `disaster-status.ts:161,330` |
| FR3 | MEDIUM (test gap; D7) | The cron step's isolation is untested: making `runDisasterMonitoring` rethrow passes every test. | `disaster-status.ts:338-348`, `route.ts` |
| FR4 | MEDIUM (test gaps) | Guarded behaviour with no catching test: the list follows the table. | tests |
| FR5 | LOW | A stop or the deadline during the guards or the re-check doesn't stop the switch (`throwIfAborted` runs only before the re-check). Reproduced: abort on the re-check's GET, and the workspace is still `linked`. | `disaster-workspace.ts:187-201` |
| FR6 | LOW | A newline in `targets` (API or `gh` only, not the form) defeats both masking and validation: the second line prints in the public log. The task refuses later. | `disaster-button.sh:63,81` |
| FR7 | LOW | A switch lock timeout gets 3 tries in total; §6.4 step 8 says "retried up to 3 times". | `disaster-steps.ts:472-473` |
| FR8 | LOW | The healed `LINKED` line and `linked` row lack the backup key, SHA-256 and backup time ("the same fields", §6.4). 3c-2 re-applies rebuilds from these lines. | `disaster-steps.ts:515-516` |
| FR9 | LOW | `all-lost` drops workspaces whose project lookup failed: there's a log line, nothing in the results. If every lookup 5xx's, the email says "No workspace is proven lost". | `disaster-workspace.ts:53-62,88,92` |
| FR10 | LOW | The wait on Neon's create operations (up to 10 min) ignores the stop signal, so cleanup can't run inside ECS's 120 s stop window. The leftover check still finds the project. | `neon-api.ts:161-175`, `disaster-steps.ts:335-336` |
| FR11 | LOW | The schema note's connections to other workspaces have no hard deadline (the postgres.js reconnect loop). A hang after the switch: no "run Deploy now" email, and the run stays `running` until the hard exit. | `disaster-steps.ts:533` |
| FR12 | LOW | The daily sync's writes aren't atomic: `withLockedPool` isn't a transaction, although its comment says it is. A failure between the healed `linked` insert and the watch raise leaves that original unwatched for good. A failure after a stuck run is closed loses the stuck alert. | `disaster-status.ts:310-322`, `locked.ts:74` |
| FR13 | LOW (docs) | **Runbook A.8, A.8a, A.10:** "deploys skip it" is true only when `skip_lost_workspaces` is ticked, and nothing says to tick it on each release while such a workspace remains (only A.4). **Results list:** it misses `cleanup-failed`, `original-back`, `reachable-now`, `network-unproven`, `facts` and `error`. | `RESTORE.md:117-122,136,146-151` |
| FR14 | LOW (test hygiene) | `disaster-monitoring.test.ts` runs on the dev control plane. Its cleanup deletes every `digest-%` action row and every global disaster alert first seen since it started. Its sync also resolved the lead's checks alert mid-run (§7, E). | `disaster-monitoring.test.ts:40-45` |
| FR15 | LOW (positive-control residual) | **The rule proves the list's org holds the *known* project, not the tenant's.** If the restore-test project sat in a different org and `NEON_ORG_ID` pointed there, the tenant-side lists would be vacuous again. Proof (d)'s login still refuses a live workspace. Only a setup mistake can cause it. | `disaster-steps.ts:69-89` |
| FR16 | LOW (cosmetic) | `disasterGuard` sits between `restore()`'s doc comment and `restore()`. | `delete-tenant.ts:165-185` |
| F-3b | **MEDIUM, in 3b** (found by the dev; confirmed by the lead) | **In `dumpOnce`, a target deadline or stop before `pipelineDone.promise` is awaited** (e.g. during the version query) rejects a deferred that nobody awaits. In the image, `installCrashHandler` turns the unhandled rejection into FATAL, **exit 1 for the whole night's backup run**. Fix: one line, `pipelineDone.promise.catch(() => {})` after creating it, plus a test. **Outside 3c's scope: Q-A1.** | `scripts/backup/backup.ts:324-369` |

**FR4, the missed mutations to cover** (one test each, failing under that mutation):
- **The restore task (auditor A):**
  - **The override path:** a candidate check that can't complete refuses (M09); the override classifies twice (M20); observations are tied to `old_project_id` (M30).
  - **The recoverable list:** a partial list, or a failed poll, is unproven (M15, M16).
  - **Network first:** on the gone path and on the override path, R5's "no other workspace reachable → `network-unproven`" (M18, M19).
  - **The gone re-check:** it refuses an unproven or served address and a recoverable original (M31, M32).
  - **Cleanup and backups:** a delete is verified by a 404 (M44); the 3-candidate cap (M48).
  - **Run control:**
    - `all-lost` uses the shared positive control (M51);
    - the final run update never overwrites a row the digest closed (M57);
    - the `DISASTER_LOCK_KEY` value is distinct from every other lock key (M58);
    - the 3-minute lock wait (M59);
    - the switch lock-timeout retry (M84, after FR7).
  - **Rehearsal:** it refuses a served or unproven deleted endpoint (M66), a canary answering 200 (M67), a deleted copy missing from the recoverable list (M68), and a skipped positive control (M86).
  - **Harness:** `createWorld` cleans up when it fails partway. Mutated runs leaked 41 scratch databases, and four mutants flickered.
- **Deploy path and monitoring (auditor B):**
  - **`tenant:delete`'s guard per locked section:** each copy alone, and URL-only vs project-id-only changes (M53, M54, M65).
  - **Proof rules:** `refused:database-missing` is skippable, pinned literally (M01); the facts reader's 3b `ok` SQL is run by R7 with a `database_backups` row (M10).
  - **`--skip-lost`:** without the flag, nothing is skippable, and the handshake runs and the slug prints (M20).
  - **Monitoring:**
    - the 6 h leftover boundary (M32);
    - a stuck run is closed only while it's still `running` (M46);
    - the monitoring gate with `BACKUPS_EXPECTED` unset in production (M58).

## 5. Fix round 1 (sent to the dev, inside the blueprint)
1. **FR1:** choose the pre-switch re-check by **which proof passed** (`proof.status === 'unreachable-4h'` → `recheckOverride`; `gone` → `recheckGone`), never by the typed override. `rebuild-original-returned` is raised at the switch only when the override proof was the one used. Tests:
   - override typed + project 404 + full gone proof → `linked`, with no `rebuild-original-returned`;
   - override typed + project 200 → the override re-check (existing).
2. **FR2:** sync-level tests on a Neon-failure day:
   - open `rebuild-original-returned`/`rebuild-orphan-project` stay open;
   - a watch 30+ days old isn't marked done.
3. **FR3:** a test that a throwing `syncDisasterAlerts` → `runDisasterMonitoring` returns `{error: true}` and raises `rebuild-watch-check-failed`. Also a route-level test that the lifecycle cron continues past a failing disaster step (mock the module).
4. **FR4:** one test per missed mutation listed in §4, each failing under that mutation. Make `createWorld` tear down whatever it created when it fails partway.
5. **FR5:** `throwIfAborted(ws.signal)` immediately before `switchWorkspace` (after the guards and the re-check), so a stop or deadline in that window goes to cleanup. Test: abort during the re-check → not linked, project cleaned.
6. **FR6:** `disaster-button.sh` refuses any input containing a newline or carriage return **before** it prints anything: `refused: inputs must be a single line`, which prints no value. D2 case with the reproduced input: the second line is absent from the output, and there are no aws calls.
7. **FR7:** a switch lock timeout is retried up to 3 times (4 attempts in total), as §6.4 step 8 says. Test (M84).
8. **FR8:** the healed `LINKED` line carries the same fields as the normal one (`<tenant> <old> <new> <backupKey> <sha256>`, then `(healed by the re-read)`). The healed `linked` row stores `backup_key` and `backup_started_at`. Pass them into `cleanupProject`. Test.
9. **FR9:** an `all-lost` workspace whose project lookup failed is reported in the results and the email as `proof-failed` ("press again"), never silently dropped. Test: a 5xx on every lookup → each listed as `proof-failed`, and the run is not `pass`.
10. **FR10:** the create-operation wait checks the stop signal on each poll and returns at once on a stop, so cleanup runs inside the stop window. Test.
11. **FR11:** the schema note's connections go through `pgConnector` (its hard deadline). A note that can't finish is skipped with a log line; the email and the run row still complete. Test with the fake proxy closing the socket.
12. **FR12:** the sync's writes run in **one transaction**, `db.transaction(...)` on the locked pool. Correct `withLockedPool`'s comment ("not a transaction"). Test: a failure injected after the healed `linked` insert leaves no `linked` row, so the leftover is found again the next day.
13. **FR13:** in `RESTORE.md` A.8, A.8a and A.10, say "deploys with **Skip lost workspaces** ticked skip it". Add to runbook A and to `PRODUCTION-DEPLOY.md` Phase 14 (release): "while any workspace is skipped or awaiting a rebuild, tick Skip lost workspaces on every release". Complete the results list with `cleanup-failed` (contact the lead; a project may be left in Neon), `original-back`, `reachable-now`, `network-unproven`, `facts` and `error`, each with its action.
14. **FR14:** `disaster-monitoring.test.ts` deletes only rows and alerts it created (its tenant ids, its run ids or dedup keys), never `digest-%` globally. Document in its header that its sync can resolve other open global disaster alerts on a dev control plane (as 3b's S9).
15. **FR15:** add to the founder setup (Phase 13c and Part 6b) a check that the restore-test project, the control-plane project and the workspaces are all in the organisation whose id goes into `/cadenzpoint/backup/neon-org-id`, with the console path. No code change.
16. **FR16:** move `restore()`'s doc comment back above `restore()`.

Then:
- re-run every gate (integration included, **alone**, with the memory-noted environment and the pg 16 tools);
- revert-check every new test;
- write a fix-round section in the dev report;
- commit by name;
- message the lead.

**Not in this round:** F-3b, until the product owner decides where it goes (Q-A1).

## 6. Verification after fix round 1 (`b788701`)
**Commits:** `e1da0bd`, `e9dc703`, `93492af`, `0849d9f`, `2d5fbd1`, `14c71bf`, `1ccc1c7`, `b788701` (the lead's `d7cab1f` sits between them). They touch only the files the fix round names, plus their tests, and add no new behaviour.

**Code read by the lead:**
- **FR1:** `overrideProof = proof.status === 'unreachable-4h'` picks the re-check and the `returned` flag; the typed override no longer does.
- **FR5:** `throwIfAborted` sits right before `switchWorkspace`.
- **FR6:** a `jq` test refuses any input containing `\r` or `\n` before anything prints.
- **FR7:** a lock timeout returns `lock-timeout` only after `attempt > 3`.
- **FR8:** the healed row and line carry `backup_key`, `backup_started_at` and the SHA-256.
- **FR9:** a failed lookup → `proof-failed`, and the email's "No workspace…" line appears only with no results.
- **FR10:** the operation wait checks the signal on each poll, and its abortable pause throws with the project id for cleanup.
- **FR11:** `pgQuery`, a shared hard-deadline helper; the note makes at most 2 answers from at most 4 tries. The dev's FR11 test found that tries weren't capped (about 39 × 3 s).
- **FR12:** the sync runs in `pool.transaction`, and `withLockedPool`'s comment is corrected.
- **FR13, FR15:** docs, with a static test.
- **FR14:** the test's own rows only.
- **FR16:** the comment is moved.
- **Extra, accepted:** a project that still answers after DELETE records an explicit `failed` detail.

**The dev's checks:** 42 of 42 new revert checks caught; the original 33 still caught on the fixed code.

**Lead gates:**

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | ✅ exit 0 |
| `eslint . --ignore-pattern '.claude/**'` | ✅ 0 errors (39 pre-existing warnings) |
| `npm run test` | ✅ 258 files; 3,075 passed, 1 skipped |
| `npm run db:safety` | ✅ |
| Integration, **run alone**, with the memory-noted environment and the pg 16 tools, at 17:40–17:50 Eastern | ✅ 105 files passed, 2 skipped; **976 passed, 0 failed**; no scratch databases left |

**Lead break-it** (`/tmp/dr-breakit/run.py`, uncommitted; one exact-text edit per case, run its test, expect FAIL, restore): **10 of 10 caught, tree clean, no leftover databases.**
1. the re-check following the typed override (FR1);
2. the positive control without the in-list rule;
3. the switch without URL byte equality;
4. cleanup deleting a project the tenant points at;
5. a newer 3b `ok` no longer ending a proof;
6. `28xxx` no longer classed as auth;
7. a skipped workspace printed by slug;
8. a Neon-failure day resolving Neon alerts (FR2);
9. `tenant:delete` ignoring an open orphan alert;
10. the button accepting a multi-line input (FR6).

The integration cases loaded the control-plane environment, so a setup failure can't pass as a catch.

### 6.1 CI on the early push (`d7cab1f`, run 44191551685)
- **Lint, Build & Unit Tests:** ✅, including the D2 button tests under bash 5.
- **Backup templates and image:** ✅. That's the first Docker build of the image with the disaster code, its in-image self-check, and CI's cfn-lint block run as written.
- **Migration Sync Check:** ✅.
- **Integration Tests:** ❌ one test, `disaster-rehearse.test.ts:128` (M67, `expected +0 to be 1`). It depended on test order: an earlier test's canary could be picked. The test fix is `b788701`, the commit after the push; the lead's solo run on `b788701` passed. **A green run on the final commit is still the merge gate.**

### 6.2 CI on `7c06714`, and fix round 2 (`40b807e`, test-only)
- **The runs:**
  - **Push run** 44194375025: the integration job failed at `backup-command.test.ts:354`. That's 3b's S21/S23, a timing race in the test, also on `main`: the migration lock was opened after the backup's lock session was cut, so a slow runner could re-take first. It's fixed on the 3b-fix branch (`380c499`), not here.
  - **PR run** 44194383730: the integration job failed at `disaster-fixround.test.ts:154` (M18/M19, `restore-failed` instead of `network-unproven`).
  - Every other job was green in both runs.
- **Cause (the dev's diagnosis, which corrects the lead's first reading):** each 3c test world has its own scratch control plane. Earlier tests in the file had rebuilt workspaces onto new fake hosts that the test's "dead" map didn't cover. `networkProven` walks live tenants in uuid order, so a rebuilt one connected first. The dev reproduced it deterministically, with CI's exact message.
- **Fix:**
  - **A test-only `DisasterDeps.connector` seam:** never read from the environment, and never set by `main.ts`, which `backup-main` asserts. M18/M19 use a refuse-all connector and keep the connectable foreign workspace as a guard.
  - **FR11:** every mapped host closes after the commit.
  - **`disaster-monitoring`:** it counts only its own keys.
  - **No production behaviour changes.** The only production-file edit is the seam's `??` fallback.
- **The lead's verification at `40b807e`:**
  - tsc clean, lint 0 errors, unit 3,076 passed;
  - the fix-round file passed 3 runs in a row (14 of 14 each);
  - break-it: network-first always "proven" → caught, and the seam ignored → caught;
  - the earlier 10 break-it cases: 10 of 10 caught, tree clean;
  - **integration alone: 105 files, 976 passed, 0 failed** (finished 18:38 Eastern); no scratch databases left.

**Residual LOW (dev control plane only, accepted):** the integration suite's syncs leave resolved `rebuild-watch-check-failed` rows on the developer's local control plane, the same class as 3b's S9 note. Production and CI are unaffected.

## 7. Checks run by the lead (`DISASTER-RESTORE-BROWSER-CHECKS.md`, at `11667dd`, 2026-11-17)
**Method:** every bash block was extracted verbatim from the file by a script (31 blocks), and each ran in a fresh `zsh -i -s`. There's no app server: 3c has no screens. Throwaway workspace `dr1117170416`.

| Section | Result | Evidence |
|---|---|---|
| 0 Setup | ✅ | migrations applied; usage line; `Ready: dr1117170416 (tenant id b00cce84-…)` |
| A Command outside AWS | ✅ | `refused: outside ECS only \`--self-check\` and \`backup --dry-run\` against a local control plane may run` |
| B.1 Wrong confirm | ✅ | `refused: confirm must be exactly: workspace`; target shown 0 times; aws calls 0 |
| B.2 Name, not id | ✅ | `refused: targets must be workspace ids (uuid, lowercase), …`; shown 0; aws calls 0 |
| B.3 Already running | ✅ | `refused: a disaster task is already running (RESTORE.md runbook A.11)`; shown 0; one call, `ecs list-tasks … --family cadenzpoint-backup-disaster --desired-status RUNNING` |
| C.1 Healthy | ✅ | `up-to-date`, exit 0, no rows |
| C.2 Lost | ✅ | `FAILED: database "bytime_dr1117170416" does not exist`, exit 1 |
| C.3 Flag, no proof | ✅ | the skip notice, the same FAILED, exit 1, no rows |
| C.4 `--check --skip-lost` | ✅ | the row labelled `b00cce84-…` reads `skipped: skipped (proven lost, awaiting rebuild)`, exit 0, still 1 row |
| C.5 `--skip-lost` | ✅ | the same uuid row; `✓ All databases migrated successfully.`; exit 0; `migrate-20261117T220428Z \| skip \| skipped` |
| C.6 No flag | ✅ | the FAILED row by name, exit 1 |
| D.1 Rebuilt | ✅ | `findings: 2`: open `workspace-needs-deploy` (key = tenant id) and `rebuild-watch-check-failed` (no Neon key locally) |
| D.2 Migrated | ✅ | `findings: 1`; `workspace-needs-deploy` resolved |
| D.3 Digest | ✅ | `["Disaster runs in the last 7 days: none."]` |
| E.1 `show` | ✅ | `id: b00cce84-…` |
| E.2 `resolve-alert` | ✅ | `✗ rebuild-orphan-project closes only when its condition clears (…); it can't be resolved by hand.` |
| E.3 `tenant:delete` | ✅ | `✗ A copy of this workspace's data may still exist in Neon (rebuild-orphan-project test-drchk-orphan): …`; still `status: active` |
| F Templates | ✅ | `cfn-lint: clean` (1.60.1) |
| G Clean up | ✅ | `cleaned: dr1117170416`; 0 `bytime_dr*` databases, 0 action rows, 0 test alerts left |

**An earlier attempt at E.3 was spoiled while the auditors ran.** `disaster-monitoring.test.ts`'s sync resolved the test alert 4 s before the delete, so the delete went through. That's FR14; the run above was alone.

**Re-run after fix round 1 (`b788701`):** all 32 blocks verbatim in fresh shells, every **Expect** met. The added check B.4 (FR6): `refused: inputs must be a single line`, target shown 0 times, aws calls 0. Throwaway workspace `dr1117175151`, cleaned (0 databases, 0 rows, 0 test alerts left).

**Not covered locally:**
- the image build, CI's cfn-lint block and bash 5 (CI; all passed on the early push);
- every AWS, Neon and GitHub step: the button's first press, the rehearsal, the emails and the console steps (`PRODUCTION-DEPLOY.md` Phase 13c, with the founder).
