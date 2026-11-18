# Blueprint 3c-2: Control-plane disaster (rebuild, reconcile, whole-account runbook)

> **Status: v1.0 DRAFT, not yet reviewed** (2026-11-18). Branch `control-plane-disaster`, from `main` at `57d6729`.
> Follows `BLUEPRINT-STANDARD.md`.
>
> **Scope decisions:**
> - `LAUNCH-TRACKER.md` 2026-11-17: the 3c scope Q1–Q5, the split, and the 4-hour override, which applies to workspaces only;
> - `LAUNCH-TRACKER.md` 2026-11-18: 3c-2's Q1–Q2;
> - `BUSINESS-DECISIONS.md` §5.
>
> **Builds on 3c**, `feature-plan-disaster-restore.md` FINAL v4.0 (merged, PR #34), and 3b (`feature-plan-database-backups.md`).

## 1. Goal and scope
**Goal:** when the control-plane database is lost (its Neon project deleted or unrecoverable), the founder presses the
same **Disaster restore** button. A task in AWS then does four things:
- rebuilds the control plane from its newest verified backup into a **new** Neon project;
- checks the rebuild the way the restore test does;
- works out what changed after that backup (the "window");
- emails the founder exactly what to do next.

The founder then repoints Vercel, GitHub and AWS to the new database by hand, from a checklist (accepted 2026-11-17 Q2).
A runbook covers losing the whole Neon account.

**In scope:**
1. **A stable backup id**, so every backup stays findable after a rebuild (§6.0). This is a fix to 3b: today the id is a hash of the control plane's host, which changes.
2. **Button mode `control-plane`:** gone-proof, rebuild, check and record, then the reconcile (§6.3).
3. **Button mode `reconcile`:** the window reconcile, re-runnable on its own (§6.4).
4. **`rehearse --targets control-plane`:** a non-destructive monthly rehearsal of the rebuild path (§6.5).
5. **`tenant:delete --project-proven-gone`:** closes a workspace whose database is proven gone, with every Stripe safeguard kept (§6.6, decision Q1).
6. **Window-workspace addresses** stay unavailable to new signups until resolved (§6.7).
7. **Monitoring:** window projects, and the old control plane's watch (§6.8).
8. **Runbooks:** B (control plane lost) and C (whole Neon account lost), plus updates to A (§6.9).

**Out of scope:**
- An automatic switch-over (BUSINESS-DECISIONS §5: founder-pressed only).
- Writing to Vercel or GitHub from AWS (2026-11-17 Q2: no Vercel token in AWS).
- A Stripe key in AWS (decision Q1).
- Re-attaching a window signup's data (decision Q2: they sign up again).
- An outage override for the control plane: during a Neon outage the founder waits for Neon (runbook B.1). The 4-hour override stays workspace-only.
- Changing the customer-facing product.

## 2. Product-owner decisions and founder duties
| # | Decision (date) | Effect here |
|---|---|---|
| 2026-11-17 Q1 | The button has a control-plane mode; losing the Neon account is a runbook using both modes | §6.3, §6.9 C |
| 2026-11-17 Q2 | After a rebuild, the founder repoints Vercel, GitHub and AWS and pauses/resumes crons by hand | Runbook B; the task writes nothing outside the new project |
| 2026-11-17 Q3 | If the Neon account is lost, the founder creates a new account and pastes its API key into AWS | Runbook C |
| 2026-11-17 Q4 | Window-created workspaces are reconciled in Stripe by hand from a checklist. *Deleted ones re-marked automatically*: **revised by 2026-11-18 Q1** | §6.4 lists; §6.6 closes |
| 2026-11-17 Q5 | The founder emails affected customers from a template | Template B |
| **2026-11-18 Q1** | Workspaces deleted in the window, and lost workspaces that can't be rebuilt, are closed by the founder with `tenant:delete <slug> --project-proven-gone`. Every Stripe safeguard is kept | §6.6 |
| **2026-11-18 Q2** | A customer who signed up in the window signs up again (any charge that day refunded). The founder deletes the leftover database once they confirm | §6.4 R4, runbook B |

**Founder duties at disaster time** (runbook B): disable crons, press, read the email, repoint four places, deploy, work the lists, re-enable crons, email customers.

**New one-time duty:** none. The control-plane rehearsal schedule is created by the stack. The first control-plane rehearsal is pressed once at setup (§12).

## 3. Verified current state (`main` at `57d6729`)
- **The backup id is a host hash.** `scripts/backup/lib/keys.ts:28-31` defines `controlPlaneId(url)` as sha256 of the control plane's direct host, first 12 hex characters. It's used for:
  - every S3 key: `v1/<cp>/<target>/<id>/YYYY/MM/DD/<runId>-<rand8>.dump.enc` (`keys.ts:48-55`);
  - every KMS encryption context (`crypto.ts:74-75`, matched exactly at `:85`);
  - every `BACKUP` log line (`backup.ts:285`);
  - the callers: backup (`backup.ts:145`), restore test (`restore-test.ts:118`) and disaster (`disaster-workspace.ts:31`).

  **A rebuilt control plane has a new host, so a new `<cp>`.** After a rebuild:
  - the restore test lists an empty prefix (`FAIL:list`);
  - 3c's `backupCandidates` (`disaster-steps.ts:262-283`) finds **no** earlier tenant backup. In a whole-account loss, that's every backup.
- **Who reads the control plane** (all from env or SSM; nothing persists the host):
  - **App:** two lazy pools (`src/db/control-plane/index.ts:5-22`, `locked.ts:16-24`), read once per process, so a new URL needs a redeploy (§4.4).
  - **Crons and scripts.**
  - **Workflows:** `deploy-prod.yml:42,51`, `deploy-staging.yml`.
  - **Backup tasks:** SSM `/cadenzpoint/backup/control-plane-url` (backup-stack.yml:951,1012,1071,1138) and `control-plane-project-id` (disaster, :1153; the app reads it at `disaster-status.ts:312`).
  - **IAM:** no role has `ssm:PutParameter`, and a PutParameter event raises an alarm (`expected-policies.ts:74`).
- **The control-plane backup:**
  - it's dumped after the tenants, at most 75 min in (`backup.ts:461-500`), under REPEATABLE READ;
  - the key is `v1/<cp>/control-plane/control-plane/…`;
  - its sidecar holds `rowCounts`, `sha256` (of the stored object), `startedAt` and `finishedAt` (`backup.ts:271-275`);
  - the log line is `BACKUP <cp> control-plane control-plane control-plane <runId> <key> <sha256> <bytes>`;
  - `realLogReader.backupLines` hard-codes target `tenant` (`log-reader.ts:45,48`);
  - the backup log group keeps 30 days (`backup-stack.yml:292`), and S3 objects expire at 25 days (`:113-114`).
- **3c's task** (`disaster.ts:202-299`) assumes a live control plane. It needs one for:
  - the `DISASTER_LOCK_KEY` lock (`:244`);
  - the `disaster_runs` row (`:270-289`);
  - `networkProven`'s tenant list and fallback (`disaster-steps.ts:109-121`);
  - `positiveControl`'s live-tenant list (inside a try, `:69-89`);
  - `loadTenant` and `record`.

  **Reusable as-is:**
  - `pollRecoverable` (`:92`);
  - `classifyGoneEndpoint` and `candidateServes` with a `CandidateRule` parameter (`classify-endpoint.ts:85-129`, "so 3c-2 can pass its own");
  - `pgQuery`;
  - the restore and verify helpers (`restoreObject`, sidecar `decryptBuffer`, `countTables`, `compareCounts`);
  - `neon.createProject`, `deleteProject` and `verifyGone`.

  **Log lines:**
  - `SWITCHING <tenantId> <old> <new> <key> <sha256>` before COMMIT, and `LINKED` with the same fields after (`disaster-steps.ts:443-468`);
  - the healed `LINKED … (healed by the re-read)` line, which since FR8 carries the same fields (`:521`).

  The disaster log group keeps 365 days.
- **3c's button:**
  - modes `[workspace, rehearse]` (`disaster-restore.yml:16`; `disaster-button.sh:77`);
  - `confirm` equals the mode;
  - targets are a uuid list or `all-lost` (`:86`);
  - `parseDisasterArgs` exits 1 on an unknown mode (`disaster.ts:80`) and 2 on an unknown flag (`:68`).
- **The tables:**
  - `disaster_runs.mode` and `disaster_actions.kind`/`status` are varchar, with no CHECKs (`0012_disaster_restore.sql`);
  - `disaster_actions.tenant_id` is nullable.

  So **no migration is needed** for new values.
- **Tenant lifecycle:**
  - only `tenant:delete` sets `deleting`/`deleted` (`delete-tenant.ts`), and the lifecycle cron never deletes;
  - on its first run, `tenant:delete` refuses a missing project: "The tenant database was not found …" (`delete-tenant.ts:256-263`);
  - step 5's `deleteNeonProjectVerified` already treats a 404 at preflight as `alreadyDeleted` (`neon.ts:200-211`);
  - `--force-with-reason` skips only the date and notice checks (`:123`).
- **Signup and provisioning:**
  - the Neon project `cadenzpoint-<slug>` is created **before** the `tenants` row (`provision.ts:62-133`, `registry.ts:96-104`);
  - the slug is checked only against `tenants` (`server/internal/signup.ts:20-24`, `provision.ts:51-59`);
  - staging and production share the name pattern, and may share one Neon organisation (PRODUCTION-DEPLOY.md:292-293).
- **Stripe:**
  - customer and subscription metadata carry `{ slug, tenantId }` (`tenant-billing.ts:20-23`, `billing.ts:71-85`);
  - checkout resolves by `metadata.slug`, and an unknown slug is ignored with 200 (`stripe/webhook/route.ts:87-91`);
  - an unknown customer raises `stripe-event-unknown-customer` (`:102-109`);
  - the lifecycle cron re-reads every live tenant from Stripe daily (`lifecycle-runner.ts:198-205,381-392,487`), so subscription facts self-heal after a rollback.
- **What a rollback loses** (control-plane writes after the backup's snapshot), each with what recovers it:

  | Lost | Recovered by |
  |---|---|
  | new `tenants` rows | the window signups; Q2 |
  | lifecycle and Stripe facts | the daily Stripe re-read |
  | deletions | Q1 |
  | 3c rebuilds | re-applied in §6.4 R2 |
  | `tenant_notices` | can re-send; accepted 2026-11-17 |
  | `signups` | users sign up again |
  | `ops_alerts` | re-derived daily; `pending-invoice-void` is redone by `tenant:delete`'s Stripe step |
  | `tenant_audit_events` | a gap; the window is named in the email |
  | `payment_pending_observations` | the microdeposit window restarts; LOW, accepted |
  | `tenant_seat_billing` | re-derived by seat sync |
  | `database_backups`, `restore_test_*` | the next runs; 3c's candidates use log lines when rows are missing (`disaster-steps.ts:267-280`) |
  | `disaster_*` | §6.4 |

## 4. External behaviour (verified 2026-11-18 from the sources named)
### 4.1 Neon
1. **`GET /projects`** (neon.com/docs/reference/api/projects/list-projects):
   - `limit` 1–400, `cursor`, `search` (partial name or id), `org_id`, `recoverable` ("only deleted projects within the recovery window");
   - each project has `id`, `name`, `created_at`;
   - after a `timeout`, the list is incomplete ("unavailable").

   3c's `listProjects` already paginates and treats `unavailable` as incomplete.
2. **Roles** (neon.com/docs/manage/user-permissions):
   - "Any organization member except a Collaborator can create a project";
   - "whoever creates a project becomes **Admin** on it", and keeps that access;
   - Viewers "cannot see connection strings" of projects they didn't create, but have Admin on their own;
   - "a per-project permission can only raise someone's access, never lower it" (neon.com/docs/manage/organizations).

   **So the disaster key can read connection strings for projects it created** (3c rebuilds), **and not for workspace projects the app created.** 3c's runbook A.7 ("lower `neon-ops@` to Viewer") can't work, and is removed (§6.9).
3. **`GET /projects/{id}/connection_uri?database_name=&role_name=&pooled=true`** returns `{ uri }`, the pooled URI with the password (neon.com/docs/reference/api/projects/get-connection-uri).
   - `database_name` and `role_name` are required. The owner role comes from the branch's databases list (`owner_name`).
   - **The dev confirms the exact databases endpoint and field in the impact analysis.**
4. **Plans** (neon.com/docs/introduction/plans):
   - Free: history 6 h, 100 projects;
   - Launch: up to 7 days of history;
   - upgrades happen in the console (Billing → Change plan), and a compute "picks up the new plan limits … the next time it restarts".

   Runbook C upgrades the new account **before** pressing.
5. **From 3c §4.1, unchanged:**
   - the proxy answers an unknown or deleted endpoint with `28P01`;
   - operation `failed` is terminal;
   - `423` means back off.

### 4.2 Vercel
- "Any change you make to environment variables are not applied to previous deployments, they only apply to new deployments" (vercel.com/docs/environment-variables). **So repointing needs a redeploy**, which runbook B's Deploy to Production provides.
- Cron jobs: "**Disable Cron Jobs** … applies to the project and persists across deployment promotions … they remain disabled until you explicitly re-enable them" (vercel.com/docs/cron-jobs/manage-cron-jobs).

### 4.3 AWS
- ECS injects SSM parameters "when the container is initially started … You must either launch a new task …" (docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-ssm-paramstore.html). **So after the founder updates `/cadenzpoint/backup/control-plane-url`, the next scheduled task uses the new value**, with no stack deploy.
- `FilterLogEvents`: as in 3c §4.3 (paginate to the end; a quoted phrase is case-sensitive; 25 TPS).

### 4.4 Stripe
Unchanged. AWS never calls Stripe. `tenant:delete` (founder's machine, the app's keys) does.

## 5. Invariants that must not break
1. **No original is ever deleted, overwritten or written.** That covers the old control-plane project and every workspace database: nothing in this item deletes or writes to them.
2. **A control-plane rebuild needs the full gone-proof** (§6.3 step 3): (a)–(d) as 3c's invariant 2, with the control-plane candidate rule. There's no override.
3. **The task writes only inside the new project, plus its log and its one email.**
   - No SSM writes. No Vercel, GitHub or Stripe calls.
   - The founder repoints.
   - The old control plane, if it's reachable at all, is never written.
4. **The reconcile never deletes a project and never tombstones a tenant.**
   - Its only tenant writes are re-applying a confirmed `LINKED` rebuild through 3c's guarded switch semantics (byte-equal URL and project id, under the tenant lock).
   - Everything else is proof rows, alerts, action rows, and the email.
5. **Backups stay findable after any rebuild.** The backup id is the same before and after (§6.0).
6. **`--project-proven-gone` replaces only `tenant:delete`'s "not found" refusal.** It never skips the date/notice checks (that needs `--force-with-reason`, as today), the Stripe steps, the disaster guard or the tombstone step.
7. **Window addresses stay unavailable to new signups** while their `window-project` alert is open (§6.7). They become available when the project is deleted, or when the founder resolves the alert by hand.
8. **3c's invariants are unchanged:**
   - logs carry ids, never slugs or URLs;
   - public GitHub logs show no target;
   - one disaster run at a time;
   - every start is emailed.
9. **No customer data on the founder's machine.** `tenant:delete --project-proven-gone` reads only Neon metadata and the control plane.

## 6. Design
### 6.0 A stable backup id (fixes 3b; `keys.ts`, the stack)
- **`controlPlaneId(url, env = process.env)`:**
  - if `BACKUP_CONTROL_PLANE_ID` is set, return it, validated `^[a-z0-9-]{1,32}$` (else throw);
  - otherwise return today's host hash, unchanged for tests and local use.
- **`main.ts`:** inside ECS (the metadata URI is present), a missing or invalid `BACKUP_CONTROL_PLANE_ID` is fatal for every command except `--self-check`.
- **The stack** sets `BACKUP_CONTROL_PLANE_ID: prod` as a plain environment value (not a secret) on the backup, restore-test, audit and disaster task definitions. U6 asserts that all four set it, identically.
- **Effect:** S3 keys, contexts and `BACKUP` lines use `prod`. A rebuilt control plane keeps the same id, so the restore test and 3c's candidate search keep working after a rebuild.
- **If backups are already on when this deploys** (`AWS_BACKUPS_ENABLED=true`), earlier objects stay under the old prefix and expire within 25 days. New ones go under `prod` from the next nightly run.
  - For up to a day, the restore test reports `FAIL:list` for the control plane, and a workspace rebuild can use only post-deploy backups.
  - This is noted in PRODUCTION-DEPLOY 13b, with no code for it. Expected: backups aren't live yet (2026-11-18).

### 6.1 The button (`disaster-restore.yml`, `disaster-button.sh`, `parseDisasterArgs`)
- **The mode choice** becomes `[workspace, rehearse, control-plane, reconcile]`.
- **Targets** must be the literal `control-plane`:
  - for modes `control-plane` and `reconcile`;
  - for `rehearse` of the control plane (`rehearse` keeps `uuid`/`auto` for workspaces).
- **The override** must be `none` for `control-plane` and `reconcile`.
- **`confirm`** must equal the mode, so the founder types `control-plane` or `reconcile`.
- **`parseDisasterArgs`** accepts these combinations. Everything else refuses with exit 1.
- **The startedBy gate:** `control-plane` and `reconcile` need `gh-` or `cloudshell-`, as `workspace` does. A schedule can only rehearse.
- **D2 cases** are added for each new mode and each refusal. Masking is unchanged. The literal `control-plane` isn't sensitive, but it's masked anyway, like any target.

### 6.2 AWS (`ops/aws/backup-stack.yml`, `expected-policies.ts`)
1. **`BACKUP_CONTROL_PLANE_ID: prod`** on four task definitions (§6.0).
2. **Disaster task:**
   - a new secret `RESTORE_TEST_DATABASE_URL`, from the existing `/cadenzpoint/backup/restore-test-url`, for network-first;
   - the exec role's `ssm:GetParameters` gains that ARN.
3. **The disaster task role's `ReadBackupLines`** gains the disaster log group (`/cadenzpoint/backup/disaster:*`), for the `SWITCHING`/`LINKED` lines (§6.4 R2).
4. **A schedule** `cadenzpoint-backup-disaster-rehearse-cp`, monthly, offset from the workspace rehearsal (`cron(17 18 15 * ? *)`; the dev confirms the existing one's day). Its input is `["disaster","rehearse","--targets","control-plane"]`.
5. **`expected-policies.ts` and U6** gain all of the above. **No `ssm:PutParameter` anywhere** (invariant 3).

### 6.3 Mode `control-plane` (`scripts/backup/disaster-control-plane.ts`)
The control plane is gone, so this mode **skips 3c's control-plane start steps**: the `DISASTER_LOCK_KEY` lock, closing abandoned runs, and the run row. It keeps ECS's oldest-task-wins check (`disaster.ts`), the startedBy gate and the start email. `runDisaster` branches on mode **before** opening the control-plane client.

1. **Start log:** `disaster control-plane run <runId> started by <x>`.
2. **Network first:** `pgQuery(RESTORE_TEST_DATABASE_URL)` succeeds, or refuse `network-unproven`.
3. **Gone-proof of the old control plane** (invariant 2):
   - (a) `GET /projects/{CONTROL_PLANE_PROJECT_ID}` → 404. A 200 → refuse `original-exists` ("Neon still has the control-plane project: if it's an outage, wait for Neon; runbook B.1"). Any other status → `proof-failed`.
   - (b) **Positive control:** the org list is complete and **contains** `RESTORE_TEST_PROJECT_ID`, and GET on it → 200. This is 3c's in-list rule, with the known list = that one id.
   - (c) The id isn't in the recoverable list, with `pollRecoverable`'s 6 × 10 s. If it's listed → refuse `recoverable` ("recover the control-plane project in the Neon console: nothing is lost; runbook B.1").
   - (d) `classifyGoneEndpoint(CONTROL_PLANE_DATABASE_URL, CONTROL_PLANE_RULE)`, where `CONTROL_PLANE_RULE = { exactNames: [], prefixes: ['cadenzpoint-control'] }`:
     - a login or post-auth answer → refuse `reachable`;
     - an endpoint served by a candidate → refuse `served` ("a live project holds the control plane's address: update `/cadenzpoint/backup/control-plane-project-id`");
     - unproven → `proof-failed`.
4. **Double press:**
   - Live org projects named with the prefix `cadenzpoint-control-r` and `created_at` within 24 h → refuse `recent-rebuild` ("a control plane was rebuilt at <time> (project <id>): finish runbook B, or delete that project in Neon, then press again").
   - ECS oldest-wins covers concurrent presses.
5. **Candidates:**
   - list `v1/prod/control-plane/control-plane/`, dumps with a sidecar, newest first;
   - the SHA-256 comes from the `BACKUP … control-plane …` line, via a new `LogReader.controlPlaneLines(cp)` that re-parses each line exactly and also accepts the ` row-failed` suffix;
   - no line → skipped, counted in the email;
   - none → refuse `no-backup`.
6. **Build** (3c's failure classes):
   - **Create** `cadenzpoint-control-r<yyyymmddhhmm>-<try>`:
     - pg 16, `NEON_REGION_ID`, `org_id`;
     - the database name is the old URL's database name;
     - history retention is the policy value.
   - **Log** `DISASTER-PROJECT <id> <name>` at once: there's no control plane to record it in yet.
   - **Restore:** the context is `{cp:'prod', kind:'dump', target:'control-plane', id:'control-plane', key}`; the context is checked before `pg_restore`, as in 3b.
   - **Verify:** the counts match the decrypted sidecar's `rowCounts`.
   - **Failures:**
     - integrity → delete the project (nothing can point at it), then the next older candidate (at most 3);
     - infrastructure → delete, then the same candidate once more;
     - then `retryable`.

     Each delete is verified with a 404. If verification fails, log `DISASTER-PROJECT-KEPT <id>`, and the email names it.
7. **Re-check:** repeat legs (a) and (c). If the old project answers 200 or is recoverable → delete the new project and email "the original control plane is back: keep using it; nothing was changed" (result `original-back`).
8. **Record in the new control plane** (its direct URL, from the create response):
   - a `disaster_runs` row: mode `control-plane`, status `running`, summary `{ previousProjectId, newProjectId, newProjectName, backupKey, backupStartedAt, sha256 }`;
   - a `disaster_actions` row: kind `rebuild`, status `created`, `tenant_id` NULL, project ids;
   - a global `rebuild-original-watch`, dedup = the old project id, detail `{ kind: 'control-plane', oldProjectId, newProjectId, watchStartedAt }`.
9. **Reconcile** against the new control plane, with `windowStart = backupStartedAt` (§6.4).
10. **Finish:**
    - set the run row to `pass` (or `fail` if the reconcile threw; the project is kept either way, since it's a complete control plane);
    - one email: the new project id and name, the backup time, the reconcile summary, runbook B's next steps, and "if the old control-plane project comes back before you repoint, keep using the old one and delete the new project".

    Exit 0 on `pass`.

**Deadline and stop:** 3c's (330 min, SIGTERM, hard exit).
- Before step 8, a stop deletes an unrecorded project, which is safe because nothing points at it.
- After step 8, the project is kept, and the email (if sent) or the log names it.

### 6.4 The reconcile (`scripts/backup/disaster-reconcile.ts`; mode `reconcile`, or step 9 above)
**Inputs:**
- a control-plane client;
- `windowStart`. Standalone, that's the newest `disaster_runs` row with mode `control-plane`, from its `summary.backupStartedAt`. None → refuse `no-rebuild` ("there's no control-plane rebuild to reconcile").

Standalone, it uses 3c's normal start: the control plane is live (the founder repointed), so it takes the lock and writes a run row of mode `reconcile`. It's idempotent: a re-run only appends proofs and refreshes alerts.

**R1. The shared proof legs,** fetched once, as 3c's `all-lost` does:
- network first (a live workspace or the restore-test URL);
- the positive control (in-list, restore test or control plane);
- one recoverable list (polled).

If any fails, every tenant is `unknown`.

**R2. Rebuilds made in the window:**
- Read the disaster log group from `windowStart` to now. Collect `SWITCHING` and `LINKED` lines (including the healed form) and parse them exactly.
- **For each `LINKED <t> <old> <new> <key> <sha>`** whose tenant row exists, is live, and has `neon_project_id = old`:
  1. `GET /projects/{new}` → 200;
  2. read the default branch's database owner;
  3. `GET connection_uri?pooled=true`;
  4. a 3c-style guarded switch:
     - the tenant lock and `lock_timeout`;
     - `UPDATE … WHERE url = <restored encrypted URL> AND neon_project_id = old`;
     - `lifecycle_version + 1`, `updated_at`;
     - audit `database-rebuilt` with detail `{ reapplied: true, … }`;
     - action `rebuild`/`linked`;
     - re-raise the `rebuild-original-watch` for `old`.

  Log `RELINKED <t> <old> <new>`. Rows already pointing at `new` → nothing.
- **Any other case** is listed and never applied:
  - a `SWITCHING` without a matching `LINKED`: "may or may not have committed; project `<new>` kept; contact the lead";
  - a `LINKED` whose project 404s;
  - a tenant row missing or deleted;
  - a different `neon_project_id`.

**R3. Classify each tenant** in `provisioning`/`active`/`suspended`/`deleting` with a `neon_project_id`, concurrency 4.
- "Due" means `status = 'deleting'` or `deletion_scheduled_for <= now()`.
- A proof row is appended for every row of the table, except `fine` and `unknown`.

| Neon | Due? | Result | Proof row (decisive) | The email says |
|---|---|---|---|---|
| 200 | any | fine | none | — |
| 404, not recoverable, (d) doesn't answer, not served | no | **lost** | `gone` | runbook A, `all-lost` |
| 404, recoverable or not | **yes** | **deleted in window** | `window-deleted` *(new, skippable)* | close with `tenant:delete <slug> --project-proven-gone` |
| 404, recoverable | no | **recoverable, not due** | `recoverable-deleted` *(new, skippable)* | recover it in the Neon console (nothing is lost); if it really should be closed, `--project-proven-gone --force-with-reason` |
| 404, (d) answers or is served | any | stale project id | `refused:reachable` | contact the lead |
| any error, or R1 failed | any | unknown | none | re-run `reconcile` later |

`SKIPPABLE_PROOFS` (`disaster-proofs.ts:12`) gains `window-deleted` and `recoverable-deleted`, so `--skip-lost` deploys skip both (3c §6.0 rules unchanged).

**Mass warning:** if 3 or more tenants are `window-deleted` or `recoverable-deleted`, the email starts: "possible mass deletion: check Neon's status page and console before closing any workspace". Nothing is gated on it: nothing here is automatic.

**R4. Projects created in the window:**
- Take every org project with `created_at > windowStart`, excluding:
  - any project a `tenants` row references (any status);
  - names starting `cadenzpoint-control`;
  - `cadenzpoint-restore-tests` and `cadenzpoint-recoverable-canary`;
  - the projects R2 re-applied.
- For each, raise a global `window-project` alert: dedup = the project id, detail `{ projectId, name, createdAt, slug | null, type }`.
  - `type` is `signup` for `cadenzpoint-<slug>`: decision Q2's checklist.
  - `rebuild` for `cadenzpoint-r-…`: an unlinked 3c rebuild; delete it once nothing above names it.
  - `other` otherwise: staging if staging shares the org, or unknown; leave it or resolve by hand.
- Append an action row (`window-project`).

**R5. Email lines,** appended to the run's email:
- the window start;
- per class: counts, then `tenant id + slug` lists;
- re-applied and unconfirmed rebuilds;
- window projects;
- the mass warning;
- runbook B's next steps.

### 6.5 Mode `rehearse --targets control-plane` (monthly, plus once at setup)
The control plane is live, so 3c's normal start applies (lock, run row in the real control plane).
1. **Proof legs against the live control plane:**
   - network first;
   - the positive control;
   - `GET CONTROL_PLANE_PROJECT_ID` → 200 (expected live);
   - the recoverable list fetched;
   - the candidate rule listing `cadenzpoint-control*` projects completes.

   Any failure → `fail`.
2. **The double-press check runs read-only.** It logs the result and refuses nothing.
3. **Build** as §6.3 steps 5–6, into `cadenzpoint-rehearse-cp-<yyyymmddhhmm>`. This name is outside the `cadenzpoint-control` rule and outside 3c's rebuild names.
4. **Reconcile against the restored copy**, with `windowStart` = that backup's `startedAt`, and `dryRun`:
   - R2 resolves but **doesn't switch**;
   - R3 classifies and writes proof rows **into the copy only**;
   - R4 lists but raises no alerts in the real control plane.

   **The real control plane gets only the run row and its summary** (counts per class). The rehearsal's own `fine` count is expected to be near all of them, and `window projects` = recent signups (expected).
5. **Always:** delete the copy, verify the 404, and append `rehearsed-deleted`. A copy that can't be deleted → `fail`, and it's named.

`disaster-rehearse-failed` (3c §6.8) evaluates the two targets separately: the newest of each must not be `fail`, and each must have passed within 40 days (summary `target`).

### 6.6 `tenant:delete --project-proven-gone` (`scripts/delete-tenant.ts`, `src/lib/tenant/delete-tenant.ts`)
- **Allowed only for** `neon-project` databases, and only on the run that would hit the "not found" refusal. A resumed `deleting` run already accepts a missing project.
- **Before that refusal** (read-only, the app's `NEON_API_KEY` org key), all of these must hold, or refuse with the failed check named:
  1. `GET /projects/{neon_project_id}` → 404;
  2. **positive control:** the org project list is complete and contains `CONTROL_PLANE_PROJECT_ID`, and GET on it → 200. That's the same check as `observeNeon`'s `keyOk` (`disaster-status.ts:270-280`);
  3. the tenant's URL doesn't log in: `pgQuery` → not `ok` and not post-auth.
- **If the project is in the recoverable list,** print "Neon can still recover this project until <recoverable_until or 'its window ends'>; closing the workspace doesn't recover it", and continue.
- **Then the normal flow,** unchanged:
  - the preconditions (date/notice; `--force-with-reason` to bypass, audited);
  - the locked reconcile and disaster guard;
  - `deleting`;
  - the Stripe steps;
  - step 5 (`deleteNeonProjectVerified` → `alreadyDeleted`);
  - the tombstone.
- **Audit:** `deletion-started` gains detail `project-proven-gone`. The receipt's database line reads `Neon project <id> (already gone; proven at <time>)`.
- **Docs:** `TENANT-DELETION.md` gains the flag. RESTORE.md A.8 and runbook B point to it.

### 6.7 Window addresses stay unavailable (`server/internal/signup.ts`, `provision.ts`)
- **The slug check refuses a slug when** an open `window-project` alert has `detail->>'slug' = slug`.
  - It applies in `startSignup` and in `provisionTenant`, which covers the waitlist path.
  - It shows the existing "taken" message. Nothing new is shown to users.
- **The slug becomes available when:**
  - the project 404s (§6.8); or
  - the founder resolves the alert (`tenant:admin resolve-alert <id> --note …`). `window-project` isn't a `rebuild-`/`disaster-` kind, so it's allowed by hand: for staging projects in a shared org.

### 6.8 Monitoring (`src/lib/tenant/disaster-status.ts`)
- **`window-project`:** daily, `GET /projects/{id}` with the app key. A 404 resolves it ("project deleted"). Any failure leaves it open (the Neon-failure rule).
- **`rebuild-original-watch` with `kind: 'control-plane'`:** 3c's watch logic, with control-plane wording:
  - **returned:** "the old control plane exists again: don't use it; delete it in the Neon console once you're satisfied the new one is complete";
  - **recoverable:** "can still be recovered until …: don't recover it".

  `tenant:delete`'s guard ignores alerts without a `tenantId`.
- **The digest line** gains `control-plane` and `reconcile` runs (3c's "Disaster runs in the last 7 days").

### 6.9 Runbooks (`RESTORE.md`)
**B. The control plane lost:**
1. **Check Neon first:**
   - if the control-plane project is listed as deleted and recoverable, **recover it there**, and stop;
   - if it exists but doesn't answer (status.neon.tech), wait for Neon. There's no override.
2. **Vercel → Schedules → Cron Jobs → Disable Cron Jobs.**
3. **Press:** Actions → **Disaster restore** → mode `control-plane`, targets `control-plane`, confirm `control-plane` → approve. Read the email.
4. **If the old project came back meanwhile** (check the Neon console): keep the old one, delete the new project, and re-enable the crons. Stop.
5. **Repoint.** Neon console → the new project (named in the email) → Connect → the **pooled** connection string. Paste it into:
   - Vercel production `CONTROL_PLANE_DATABASE_URL`;
   - the GitHub `production` environment secret of the same name;
   - AWS SSM `/cadenzpoint/backup/control-plane-url` (as `corey-admin`).

   Put the new project id into:
   - Vercel `CONTROL_PLANE_PROJECT_ID`;
   - SSM `/cadenzpoint/backup/control-plane-project-id`.
6. **Actions → Deploy to Production**, with **Skip lost workspaces** ticked. This migrates the restored control plane, and the redeploy picks up the new URL.
7. **Check** the app loads, and that an admin can sign in to one workspace.
8. **Work the email's lists:**
   - **lost** → runbook A from step 3 (`all-lost`);
   - **deleted in window** → `npm run tenant:delete -- <slug> --project-proven-gone --yes`;
   - **recoverable, not due** → recover it in Neon. If it was meant to be closed, use the same command with `--force-with-reason`;
   - **window projects:**
     - `signup` → the Stripe checklist: find the customer by email in Stripe, refund and cancel anything from that day, email them to sign up again (template B2), and delete the project in Neon once they confirm;
     - `rebuild` → delete it in Neon if nothing in the email names it;
     - `other` → staging: resolve the alert by hand;
   - **unconfirmed rebuilds, stale ids** → contact the lead;
   - **unknown** → re-run the button in mode `reconcile` later.
9. **Deploy to Production again** (normal) once no workspace is lost, then **re-enable the cron jobs** in Vercel.
10. **Email affected customers** (template B). It mentions that a notice from the lost day may arrive again.

**C. The whole Neon account lost:**
1. Create a new Neon account on `infra@`, create its organisation, and **upgrade it to Launch** (Billing → Change plan). Free keeps only 6 hours of history.
2. Invite `neon-ops@` (Viewer, or Member per 3c's Q-D1) and create its key. Create an organisation key for the app. Update:
   - SSM `/cadenzpoint/backup/neon-api-key` and `/cadenzpoint/backup/neon-org-id`;
   - Vercel `NEON_API_KEY`;
   - the GitHub `production` environment's `NEON_API_KEY`.
3. Recreate the restore-test project (FOUNDER-ACCOUNTS-SETUP Part 5). Update `/cadenzpoint/backup/restore-test-url` and `/cadenzpoint/backup/restore-test-project-id`.
4. Runbook B from step 2. In a new account:
   - every workspace classifies **lost**;
   - window deletions can't be seen, so they show as lost. Their rebuild refuses `deletion-due` and points to `--project-proven-gone`;
   - the old watches resolve as unverifiable.
5. Runbook A step 3 with `all-lost`, then B.9.

**A (3c), updated:**
- **A.7 removed:** a creator stays Admin, so lowering is impossible (§4.1.2). The residual, the disaster key being Admin on the projects it rebuilt, is recorded in the runbook.
- **A.8** points to `--project-proven-gone`.

**Templates:**
- **B:** to every customer after a control-plane rebuild. Their data is intact; any notice from the lost day may repeat; billing self-corrects within a day.
- **B2:** to a window signup. Sorry; please sign up again; any charge from that day is refunded.

## 7. State machines
### 7.1 One control-plane run (mode `control-plane`)
| State | Event | Next | Side effects |
|---|---|---|---|
| start | gate, ECS or network fails | refused (exit 1) | email |
| start | proof refuses (`original-exists`, `recoverable`, `reachable`, `served`, `proof-failed`, `recent-rebuild`, `no-backup`) | refused | email with the reason |
| proven | create fails (no id) | next try, or `retryable` | — |
| created | restore or verify fails | deleted → next candidate / `retryable` | delete + verify; `DISASTER-PROJECT-KEPT` if not verified |
| created | stop or deadline before recording | deleted | delete + verify |
| verified | re-check: the original is back | `original-back` | delete the new project; email |
| verified | recording fails | `fail`, the project kept | log `DISASTER-PROJECT <id>`; email names it |
| recorded | reconcile throws | `fail`, the project kept | the run row says `fail`; email: press `reconcile` after repointing |
| recorded | reconcile done | `pass` | email |

"Can't happen": a second concurrent run past ECS oldest-wins. The ECS check runs before any Neon write, and the 24-hour double-press check covers sequential presses.

### 7.2 One tenant in the reconcile: §6.4 R3's table (every cell)

### 7.3 A window project
| State | Event | Next |
|---|---|---|
| open alert | daily GET → 404 | resolved (the slug becomes available) |
| open alert | daily GET fails | open |
| open alert | the founder resolves by hand | resolved |
| resolved | the reconcile re-run finds it again (still exists) | re-raised (dedup) |

### 7.4 `tenant:delete --project-proven-gone`
| Check | Fails | Result |
|---|---|---|
| status `deleted` | — | the receipt (unchanged) |
| not a `neon-project` database | — | refused: "only for Neon-project workspaces" |
| GET → not 404 | — | refused "the project exists (or Neon didn't answer)" |
| positive control | — | refused "can't prove the key sees the organisation" |
| URL logs in / post-auth | — | refused "the database answers" |
| all pass | — | the normal flow from the preconditions on; every later refusal unchanged |

## 8. Failure modes
| # | Situation | Behaviour |
|---|---|---|
| F1 | Wrong Neon key or org | Positive control fails → refused; nothing created |
| F2 | Neon outage (the project exists, but doesn't answer) | `original-exists` → wait (B.1) |
| F3 | The control-plane project was deleted minutes ago | Recoverable → refused: recover it in the console |
| F4 | Two presses within 24 h | `recent-rebuild` |
| F5 | Two presses at once | ECS oldest-wins |
| F6 | No `BACKUP` line for the newest dump (logs failed) | Skipped; an older one is used; the email counts it |
| F7 | A corrupt or tampered dump | The context check or count mismatch → next candidate |
| F8 | The task dies after create, before record | The project exists unrecorded, and the log has `DISASTER-PROJECT <id>`. The next press refuses `recent-rebuild` and names it. Runbook B: delete that project in Neon, then press again |
| F9 | The old control plane returns before repoint | Step 7 catches it during the run; afterwards, B.4 |
| F10 | The old control plane returns after repoint | The watch → `rebuild-original-returned` → don't use it; delete it later |
| F11 | Founder repoints only some of the four places | Backups would dump the dead or old control plane: the backup fails `connect`, the digest raises `backup-failed`. Deploys fail on a dead URL. Runbook B.5 lists all four; B.7 checks the app |
| F12 | A `LINKED` line refers to a project whose connection string can't be read (permission) | Listed "contact the lead"; never guessed |
| F13 | The reconcile is interrupted | Re-run `reconcile`: R2 is guarded (byte-equal), R3 appends, R4 dedups |
| F14 | A Stripe webhook during the outage | 5xx → Stripe retries for up to 3 days; processed after repoint. Window customers' events → `stripe-event-unknown-customer` (alert) → the Stripe checklist |
| F15 | A notice is re-sent | Accepted (template B says so) |
| F16 | A window signup's slug is taken by someone new | Blocked by §6.7 while the alert is open |
| F17 | Staging shares the org | Its new projects list as `other` (or `signup`); the founder resolves by hand; a staging slug blocks the same prod slug until then |
| F18 | Deploys during the window shipped migrations | B.6 migrates the restored control plane forward |
| F19 | A workspace classified lost was actually only slow | (d) requires no login/post-auth answer and no serving candidate; network-first and the positive control are shared; it's 3c's proof |
| F20 | `--project-proven-gone` against a live project | Refused (GET 200, or a login) |
| F21 | The rehearsal copy can't be deleted | `fail`, named; the next press doesn't see it (name outside the rule) |

## 9. Platform limits
- **The control plane is small (MBs):** a restore takes minutes, inside the 330-minute deadline.
- **The reconcile** makes about 2 Neon calls per tenant (GET plus the shared lists), at concurrency 4. At 1,000 tenants that's minutes, under Neon's rate limits with 3c's 429/423 backoff.
- **`FilterLogEvents`:** two scans (the backup group, then the disaster group), paginated, under 25 TPS.
- **ECS and the email:** one SNS email, under 256 KB. Lists are truncated at 200 entries per class, with "and N more; see the log".

## 10. Blast radius
- **`scripts/backup/`:**
  - `lib/keys.ts` (§6.0) and its callers (unchanged signatures, plus `env`);
  - `main.ts` (the env check; the `control-plane`/`reconcile` modes);
  - `disaster.ts` (modes, parse, start branch);
  - `disaster-control-plane.ts` (new) and `disaster-reconcile.ts` (new);
  - `disaster-rehearse.ts` (the control-plane target);
  - `disaster-steps.ts` (export what's reused; nothing changes for workspaces);
  - `lib/log-reader.ts` (`controlPlaneLines`, `disasterLines`);
  - `lib/neon-api.ts` (`getConnectionUri`, the database owner lookup);
  - `lib/classify-endpoint.ts` (`CONTROL_PLANE_RULE`);
  - `lib/disaster-proofs.ts` (two skippable statuses);
  - `disaster-button.sh`, `lib/expected-policies.ts`.
- **`.github/workflows/disaster-restore.yml`:** modes.
- **`ops/aws/backup-stack.yml`:** §6.2.
- **App and scripts:**
  - `src/lib/tenant/delete-tenant.ts` and `scripts/delete-tenant.ts` (§6.6);
  - `src/lib/tenant/disaster-status.ts` (§6.8);
  - `server/internal/signup.ts` and `src/lib/tenant/provision.ts` (§6.7);
  - `src/lib/tenant/admin-commands.ts` (no change: `window-project` is resolvable).
- **Docs:**
  - `RESTORE.md` (B, C, A.7/A.8, templates B/B2);
  - `PRODUCTION-DEPLOY.md` (13b note §6.0; 13c additions §12);
  - `TENANT-DELETION.md`;
  - `FOUNDER-ACCOUNTS-SETUP.md` (runbook C pointer);
  - `.env.example` (none).
- **Tests:** §11. Existing 3b and 3c tests must pass unchanged, except where they assert the host-hash id inside ECS (they gain the env).

## 11. Required tests (each fails without the change it proves)
**Testing rules (3c lessons):**
- Timing tests **wait on real state** (rows, `pg_locks`, log lines), never fixed sleeps.
- Every new integration file is run **5 times in a row** and once **with a CPU hog** (`yes` × 10) before the report.
- Each test world has its own scratch control plane. No assertion depends on other files' rows.

| # | Scenario |
|---|---|
| T1 | `controlPlaneId` with `BACKUP_CONTROL_PLANE_ID` → that value; invalid → throws; unset → the host hash (unchanged) |
| T2 | `main.ts` in ECS without `BACKUP_CONTROL_PLANE_ID` → fatal; `--self-check` still runs |
| T3 | U6: all four task definitions set `BACKUP_CONTROL_PLANE_ID: prod`; no `ssm:PutParameter`; the disaster task has the restore-test URL secret and the disaster log group read; the cp rehearsal schedule input is exact |
| T4 | Backup → control-plane rebuild → a **workspace rebuild finds the pre-rebuild tenant backup** (integration; fails with the host hash) |
| T5 | The restore test after a rebuild finds the control-plane backup (fails with the host hash) |
| T6 | Parse and button: each new mode and target combination is accepted; every wrong combination refused; the override must be `none`; confirm = mode; the startedBy gate |
| T7 | Gone-proof legs one at a time: 200 → `original-exists`; recoverable → `recoverable`; wrong org (list lacks the restore-test id) → `proof-failed`; a login → `reachable`; served by `cadenzpoint-control*` → `served`; network unproven → `network-unproven`; full proof → proceeds |
| T8 | `recent-rebuild`: a `cadenzpoint-control-r…` project 23 h old → refused; 25 h → proceeds |
| T9 | Candidates: the newest without a line is skipped; integrity → older (≤ 3); infrastructure → the same once, then `retryable`; each failed project deleted and verified |
| T10 | Re-check: the original reappears during the run → the new project deleted, `original-back`, nothing recorded |
| T11 | Recording: run row, action row and watch alert in the **new** control plane; nothing written to the old URL (a spy connection) |
| T12 | The task never writes SSM, Vercel or Stripe (no client constructed) |
| T13 | R2: `LINKED` + row on `old` → relinked (URL from `connection_uri`, guarded update, audit, watch); `SWITCHING` without `LINKED` → listed only; `LINKED` with a 404 project → listed; the row changed meanwhile → not applied |
| T14 | R3 table: every row of §6.4 R3, including R1 failing → all unknown; proof statuses written as specified |
| T15 | `--skip-lost` skips `window-deleted` and `recoverable-deleted` (and is superseded by a newer `linked`/`ok`) |
| T16 | R4: a project created after `windowStart` and unreferenced → alert with the right `type`; referenced, control-plane-named, restore-test and canary ones excluded |
| T17 | The mass warning at 3, not at 2 |
| T18 | Reconcile re-run: idempotent (no second relink; alerts deduped) |
| T19 | Standalone `reconcile` without a control-plane run → `no-rebuild` |
| T20 | Rehearsal: builds, reconciles the **copy** (proof rows only there; the real control plane has only the run row), deletes, verifies; a delete failure → `fail` |
| T21 | `disaster-rehearse-failed` per target: a failed cp rehearsal alerts even if the workspace one passed |
| T22 | `tenant:delete --project-proven-gone`: each check of §7.4 refuses alone; all pass → the Stripe steps run (spy), tombstone, receipt line; without the flag → the "not found" refusal unchanged; preconditions still apply without `--force-with-reason` |
| T23 | Signup and provision refuse a slug with an open `window-project` alert; the slug is available after the alert resolves |
| T24 | Monitoring: `window-project` 404 → resolved; Neon failure → stays open; the cp watch wording; `tenant:delete`'s guard ignores tenant-less watches |
| T25 | The email: truncation at 200 per class; no URL or secret in the email or logs |
| T26 | Logs carry ids only (`DISASTER-PROJECT`, `RELINKED`); the public button log shows no target |

## 12. Founder steps and rehearsal (`PRODUCTION-DEPLOY.md` Phase 13c additions)
1. **After the deploy that merges 3c-2:** check the stack shows `BACKUP_CONTROL_PLANE_ID=prod` (the audit task checks it, and U6 pins it).
2. **Once:** Actions → Disaster restore → `rehearse`, targets `control-plane`, confirm `rehearse`. Expect `pass`, and that no `cadenzpoint-rehearse-cp-*` project is left.
3. **Note in 13b:** if backups were already on before this deploy, see §6.0. One nightly run restores normal coverage.
4. **Runbook C's pre-check:** the founder knows where Billing → Change plan is in Neon. That's a reading step, not a setup step.

## 13. Verification
- `npx tsc --noEmit`, `npm run lint`, `npm run test`, `npm run test:tz`, `npm run db:safety`.
- Integration, alone, with the pg 16 tools and the memory-noted environment.
- §3.7 verbatim runs: every changed `run:` block of `disaster-restore.yml` (button scenarios for the new modes) and the exact-COPY image build.
- cfn-lint on the templates.
- The early CI push once the CI commit exists.
- The lead's checks file (`CONTROL-PLANE-DISASTER-BROWSER-CHECKS.md`) covers:
  - `tenant:delete --project-proven-gone` against a local workspace, with a fake proof seam for Neon in tests only;
  - the signup refusal for a window slug;
  - the reconcile against a scratch control plane with stubs;
  - the button refusals.

## 14. Hand-off rules
`BLUEPRINT-STANDARD.md` §3 in full, including §3.7. Also:
- the §11 timing rules;
- no real AWS or Neon;
- never touch acme, globex or initech, or any remote database;
- stage files by name;
- never push;
- tell the lead before each full integration run (shared local Postgres).

## 15. Pre-mortem log
- **v1.0 (2026-11-18):** draft. Questions Q1–Q2 were answered before drafting. Round 1 is next.
