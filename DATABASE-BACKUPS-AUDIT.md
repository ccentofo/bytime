# Database backups (3b): audit

**Item:** build queue 3b. **Blueprint:** `feature-plan-database-backups.md` FINAL v5.8, accepted 2026-11-16 (Q1–Q4 as recommended), plus the approved details G1–G9 (`LAUNCH-TRACKER.md`, 3b row).

**Audited:** `5e2cba6..f910d1a` on `database-backups` (10 dev commits after the lead's `97e6248`), then fix round 1 at `dd1a77e`.

## Verdict: **READY** at `dd1a77e` (after fix round 1)
Round 1 (`f910d1a`) was NOT READY, with 2 MEDIUM code defects, LOWs and test gaps. Fix round 1 (FR1–FR12) is verified in §6. The lead's checks pass (§7), and break-it caught 10/10. **Merge-gate items for the product owner:**
- CI must pass on the push, including the new `backup-checks` job. That's the first build of the Docker image, which can't run on this machine.
- `PRODUCTION-DEPLOY.md` Phase 13b (AWS, with the founder) stays a production-readiness step, not a merge requirement.

No scope items for the product owner.

## Round 1 verdict (kept for the record): NOT READY, fix round 1 required
No HIGH. 2 MEDIUM code defects, about 9 LOW code defects, and test gaps (guarded behaviour that survives mutation). None changes what the product does, so nothing goes to the product owner first. The fix round below goes to the dev directly, inside the approved blueprint.

## 1. Scope check
- **Every changed file** (77) is in the blueprint's blast radius (§10.1), or is explained by G1–G9 or the dev report:
  - G1–G9: `changed.sh`, `deploy-paths.txt`, `local.ts`, `bundle.mjs`, `migrate-all-run.ts`, `resolveAlertsByKindPrefix`, the AWS packages as devDependencies;
  - the dev report: `migration-batches-and-labels.test.ts`, which pinned 0010 as newest; `tsconfig.backup.json`; the cron summary's `backups` field.
- **The Privacy change** is exactly the §6.11 sentence, word for word against `BUSINESS-DECISIONS.md` §3 (A2), and its pin.
- **The monthly drill is retired** (Q4, G8): it's gone from `RESTORE.md` and from `PRODUCTION-DEPLOY.md:885`.
- **No unapproved product behaviour.**

## 2. Lead gates (main tree at `f910d1a`)
| Gate | Result |
|---|---|
| `npx tsc --noEmit` | ✅ exit 0 |
| `npm run lint` | ✅ 0 errors in the main tree (`eslint . --ignore-pattern '.claude/**'`: 39 warnings, all pre-existing). The plain run reported 202 errors, all inside the two auditor worktrees; they've been removed. |
| `npm run test` | ✅ 251 files, 2,913 tests |
| `npm run db:safety` | ✅ no backward-incompatible statements |
| `cfn-lint` 1.60.1 | ✅ 0 findings on both templates |
| Integration | The dev ran it (882 passed; 2 pre-existing time-of-day failures that also fail on `main`). The lead re-runs it **alone** after the fix round (§6). |
| Docker image build | **Not runnable on this machine** (no Docker installed; Postgres is Homebrew). It's proven by CI's new `backup-checks` job after the push: a **merge-gate item**. |

## 3. Independent auditors
Two auditors worked in their own worktrees: A on the server and infrastructure half, B on monitoring, wiring, docs, tests and scope. Both found the implementation faithful to the blueprint almost everywhere:
- **Data path:** the end gate, the encryption suite and the context check before pg_restore spawns, and `summarizeError`.
- **Locks and migrations:** the lock factory (no recycling, heartbeat, closed handles never reused) and the migrate-all handshake.
- **Restore tests:** target choice, the `rt_` guards (cell hosts, region, version, pooler, user tables), and the drop regex.
- **Audit:** the drift checks from one source.
- **Infrastructure:** every IAM and template rule (path-qualified denies, `RetainExceptOnCreate`, two caller-free rules, schedules last, legacy OIDC `StringEquals`), the two-job workflow, `changed.sh` and `deploy.sh`.
- **Monitoring and docs:** every §6.9 finding's condition, scope, dedup and threshold, the digest and `hasNews` rules, test isolation (G2), and the docs.

Mutation results: A caught 43 of 54 and B caught 31 of 46. Apart from the code defects below, every miss was a test gap.

## 4. Findings
| # | Severity | Finding | Where |
|---|---|---|---|
| FR1 | **MEDIUM** | **Tuning changes never reach the live stack.** On an existing stack, `aws cloudformation deploy` keeps the previous value for every parameter not passed in `--parameter-overrides`. `deploy.sh` passes only `ImageUri` and `AlertEmail`. So changing `BackupConcurrency`, the deadlines, the CPU/memory or `MonthlyBudgetUsd` in the template does nothing, though §6.1, §6.9, §9 and `PRODUCTION-DEPLOY.md:944` name that as the remedy for the "slow" findings. The blueprint didn't foresee this; the code follows §6.2 literally. | `deploy.sh:96-103`, `backup-stack.yml:23-49` |
| FR2 | **MEDIUM** | **`backup-permission-drift`'s alert detail is the whole probe row**, including `edk` (the encrypted data key) and `edk_context` (cp id, tenant uuid, S3 key). The digest prints `detail`, so a drifted backup role would email them. That breaks §6.9: "alert details carry slugs, stages, counts and times only; detail names the probe". The key is useless without `kms:Decrypt`, but it breaks the rule. | `backup-status.ts:187`, `probes.ts:71-73` |
| FR3 | LOW | An `abandoned` run counts as completed when its process died after the last result insert but before the final update (§6.7: abandoned is never completed). | `backup-status.ts:94-98`, `restore-test.ts:101-103` |
| FR4 | LOW | `copyTableName` takes the first `COPY <ident>` anywhere in the message, so a customer value such as `…: "COPY johnsmith …"` can be stored as the table name (invariant 1). | `summarize-error.ts:67-76` |
| FR5 | LOW | The per-target status re-read has no guard. A transient control-plane error rejects the whole pool, and no rows are written for the remaining targets. | `backup.ts:421` |
| FR6 | LOW | Step 0 counts pending migrations one tenant at a time. A `deleting` tenant whose database is already gone makes the count throw, which runs the handshake, so an app-only deploy can wait or refuse during a backup. | `migrate-all-run.ts:86-97` |
| FR7 | LOW | `release()` sets `releasing` after the unlock query, so a close during it fires lock-lost and starts a re-take that is never released. | `locks.ts:132-143` |
| FR8 | LOW | If `isAdvisoryLockHeld` throws after `MIGRATE_RUN` is acquired, the lock and its connection leak until exit. | `migrate-all-run.ts:111-114` |
| FR9 | LOW | A stop or deadline while `reader.get()` is pending leaves the later body undestroyed (a socket leak until S3 times it out). | `restore-stream.ts:84-92` |
| FR10 | MEDIUM (test gaps) | Guarded behaviours with no catching test (list below). | tests |
| FR11 | LOW | S9's sync resolves, and its cleanup deletes, *every* open global backup alert on the dev control plane, not only its own. Dev database only. | `backup-status.ts:333-335`, `backup-monitoring.test.ts:30` |
| FR12 | LOW | `PRODUCTION-DEPLOY.md` Phase 13b is missing three §12 sentences, and says "password" where §10.1 says "URL". | docs |

**FR10, the missed mutations to cover:**
- **Monitoring, B:**
  - the stale anchor (+36 h) and the audit-missed anchor;
  - just-under-threshold cases for 26 h, 36 h, the 12 h audit, 8 days and 12 h running;
  - a `fail` run with fewer results than planned is not completed;
  - coverage eligibility (an `ok` in the last 36 h);
  - the restore half's 14-day window (in S9, through `readBackupFacts`);
  - non-live tenants' alerts resolved (S9);
  - the digest's 26 h freshness window and its "last restore test" line using completed runs only;
  - U7: `OVERDUE_WEEKS` 11, not 12.
- **Server, A:**
  - U7 picks the N **oldest** due dates (reversing the order passes today);
  - the per-target status re-read (a tenant set to `deleting` *during* the run);
  - U6 asserts `CfnExecRole` has `kms:PutKeyPolicy`;
  - the exact context key set (an extra key is refused);
  - the completed rule's result-count clause (integration);
  - `hashing.destroy` on failure (defence in depth).

## 5. Fix round 1 (sent to the dev, inside the blueprint)
1. **FR1:** make the tunables **constants in the template**: concurrency, deadlines, CPU/memory, budget. Only `ImageUri` and `AlertEmail` stay as parameters, and both are passed on every deploy. A template change then always applies on the next approved deploy. U6 asserts the main stack declares exactly those two parameters. Update §6.9/§9's remedy wording in `PRODUCTION-DEPLOY.md` ("change the value in `backup-stack.yml`").
2. **FR2:** the permission-drift detail lists only the role and the probes whose result isn't `denied`/`skipped`, never `edk*`. Test: `latestDetail` with `edk` → absent from the alert detail.
3. **FR3:** exclude `detail = 'abandoned'` in both completed checks, with a test each.
4. **FR4:** accept only anchored forms (`CONTEXT: COPY <ident>,`, `Command was: COPY <ident> `). U2 case with the reproduced string.
5. **FR5:** guard the re-read; on error, record that target `failed` (`status-read`) and continue.
6. **FR6:** step 0 runs with `--concurrency` and reuses its counts; `deleting` tenants whose database is confirmed absent are skipped (the existing `isTenantDatabaseConfirmedAbsent`). Test.
7. **FR7:** set `releasing = true` before the unlock query.
8. **FR8:** release `MIGRATE_RUN` if the check throws.
9. **FR9:** destroy a body that arrives after a failure.
10. **FR10:** one targeted test per missed mutation above, each failing under that mutation.
11. **FR11:** scope S9's global resolution and cleanup to alerts it raised (a test-only tag, or the dedup key), or document it in the test as dev-database-only. The dev's choice; note it in the report.
12. **FR12:** add the three sentences and "URL (or password)".

Then re-run every gate (integration included, with the memory-noted environment and the pg 16 tools), revert-check the new tests, write a fix-round section in the dev report, commit, and message the lead.

## 6. Verification after fix round 1 (`dd1a77e`)
**Scope:** fix round 1 touched only the files named in §5, plus their tests. No new behaviour beyond FR1–FR12.

**Code read by the lead:**
- FR1: `backup-stack.yml` declares exactly `ImageUri` and `AlertEmail`, both passed by `deploy.sh`; the tunables are template constants.
- FR2: `failedProbes()` drops `edk*`, `denied` and `skipped`, and maps anything unexpected to `unexpected`.
- FR3: `isCompleted` and `COMPLETED_RUN_SQL` exclude `abandoned`.
- FR4: only the anchored `CONTEXT: COPY …,` and `Command was: COPY … ` forms.
- FR5: a guarded re-read, `status-read`.
- FR6: concurrent step 0, counts reused, confirmed-absent `deleting` tenants skipped.
- FR7: `releasing` is set before the unlock.
- FR8: MIGRATE_RUN is released if the check throws.
- FR9: a late body is destroyed.
- FR11: documented in the S9 header (dev/CI control planes only).
- FR12: the Phase 13b sentences and "URL (or password)".

**The dev's checks:** 29 of 29 new revert checks caught, on the committed tree.

**Lead gates:**

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | ✅ exit 0 |
| `eslint . --ignore-pattern '.claude/**'` | ✅ 0 errors (pre-existing warnings only); the auditor worktrees are removed |
| `npm run test` | ✅ 2,923 passed |
| Integration, **run alone**, with the memory-noted control-plane environment plus `REQUIRE_PG16_TOOLS=1` and the Homebrew pg 16 tools | ✅ 98 files passed, 2 skipped (the usual two); **891 passed, 0 failed** |
| `cfn-lint` | ✅ (the dev's run on `dd1a77e`; the templates' shape is also asserted by U6) |

**Lead break-it** (`/tmp/bk-breakit/run.py`, uncommitted; one exact-text edit per check, run its test, expect FAIL, restore): **10 of 10 caught, tree clean, no leftover databases.**
1. the drift alert keeping `edk`;
2. abandoned counted as completed;
3. not-configured not being news;
4. the lifecycle at 35 days;
5. the key deny without `ReEncrypt`;
6. the restore project allowed in us-east-2;
7. overdue at 12 weeks;
8. deploy dropping the `AlertEmail` override;
9. step 0 waiting on a gone `deleting` tenant;
10. the Privacy sentence altered.

The integration checks loaded the control-plane environment, so a setup failure can't pass as a catch.

**Follow-up proposed (not this item):** two existing integration tests (`charge-code-actions` RBAC; `migration-import` "MIGRATION is refused") fail between about 19:00 and 24:00 Eastern ("Invalid day index -1 for this pay period"), on `main` too. A small test-only fix item.

## 7. Checks run by the lead (`DATABASE-BACKUPS-BROWSER-CHECKS.md`, at `f910d1a`, 2026-11-16)
**Method:** the helper blocks were extracted verbatim and every block run in a fresh `zsh -i -s`. The app ran under the preview tool's `app-dev` config. Throwaway workspaces `bk11162333`, `bk1116233952` (plus one name lost to a same-minute collision in the first rehearsal; the helper now uses seconds).

| Section | Result | Evidence |
|---|---|---|
| 0 Setup | ✅ | usage line; `Ready: bk1116233952 (tenant id 6b17ff64-…)` |
| A Privacy | ✅ | §3 text contains `Backups expire automatically within 30 days of being made and are then permanently deleted by our storage provider.`; the old sentence is absent; screenshot of §3 in the preview |
| B Command | ✅ | bundle 3,525,795 bytes; self-check without tools → `fatal: pg_dump could not be run (check BACKUP_PG_DUMP_BIN)`; with pg 16 → `self-check ok: pg_dump (PostgreSQL) 16.14 (Homebrew); pg_restore (PostgreSQL) 16.14 (Homebrew)`; `audit`, `backup` and a Neon URL dry run → `refused: outside ECS only …`; local dry run → `dry run: 11 target(s)`, each `server 16.14 (Homebrew) region unknown`, ending `control-plane` |
| C Digest lines | ✅ | `=1` → `["0 of 10 workspaces backed up in the last 26 h. Newest control-plane backup: none.","No restore test has completed yet."] news: false`; `=0` → `off …` news false; `=0` + `APP_ROOT_DOMAIN=cadenzpoint.com` → news true; production unset → `not configured` news true; development unset → `[]` |
| D Alerts | ✅ | failing → `findings: 2`, open `backup-failed` (tenant scope) and `backup-missed-run` (global); healthy → `findings: 0`, both resolved; reopened, then `syncoff` → `synced: false`, both resolved |
| E Migrations | ✅ | backup lock held (`backup lock holders: 1`) → `db:migrate:all` all `up-to-date` in 1.7 s, no wait. Earlier, with one local workspace pending, the run waited about 90 s for the held lock, then migrated (the designed wait). |
| F Templates | ✅ | `cfn-lint` exit 0, no output |
| G Clean up | ✅ | `cleaned: bk1116233952`; no `rt_`/`bkt_`/`bytime_bk*` databases left; no `test-bkchk-*` rows; no open backup alerts |

**Not covered locally:** the image build (CI `backup-checks`), every real-AWS step (Phase 13b with the founder), and CI itself.
