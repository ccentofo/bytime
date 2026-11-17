# Disaster restore button: one workspace (build queue 3c)

> **Status:** **DRAFT v3.5**, 2026-11-17, lead architect.
> - **Split (product owner, 2026-11-17):** this item is the **one-workspace** button. The control-plane rebuild, its reconcile and the whole-account runbook moved to **3c-2** (brief in `LAUNCH-TRACKER.md`).
> - **Outage override accepted (2026-11-17)** (§6.4 step 2).
> - Rounds 1–2 and confirmation passes 1–5 are fixed here (§15). Confirmation pass 6 is next.
>
> **Branch:** `disaster-restore-button`, from `main` at `8af3b2c`.
>
> **Source:**
> - `BUSINESS-DECISIONS.md` §5, "Disaster restore button (Q4)":
>   - only the founder can press it (a protected GitHub environment, their approval, hardware-key login);
>   - it runs in AWS;
>   - it rebuilds the workspace from its newest backup into a **new** Neon database, checks it like the restore test, then switches the workspace over;
>   - the original is kept, never deleted automatically;
>   - it reports the time of the backup used;
>   - the LB-D6 exception is limited to this button, and every use is logged.
> - §5 founder constraints: nothing manual (a button only in a disaster); no customer data on the founder's machines; it scales.
> - `LAUNCH-TRACKER.md` decisions log 2026-11-17: the 3c scope (Q1–Q5; Q5, customer emails from a template, applies here), the split, the outage override.
> - 3b as merged (`feature-plan-database-backups.md` FINAL v5.8; `scripts/backup/**`; `ops/aws/*.yml`).
>
> **Standard:** `BLUEPRINT-STANDARD.md`, including §2's CI/Docker rule, §3.7 and §4's early CI push.

## 1. Goal and scope
A founder-only **button** (a GitHub Actions workflow behind the `aws-disaster` environment) that starts a **disaster task** in the backup AWS account. Data moves only between AWS us-east-1 and Neon us-east-1, and nothing identifying a customer appears in public logs.

1. **Mode `workspace`** (one or more workspace ids, or `all-lost`). For each workspace whose original is **proven gone**, or **proven unreachable for 4 hours** with the override:
   - pick its newest backup that verifies (falling back to older ones);
   - create a **new** Neon project and restore into it, checking every count;
   - switch the workspace's control-plane row to it (the LB-D6 exception, audited and logged);
   - start a watch on the original;
   - email the founder the backup time and the hours to re-enter.

   **It doesn't migrate.** The runbook's next step, a normal "Deploy to Production", brings the rebuilt database to the current schema.
2. **Mode `rehearse`:** mode 1 for one workspace without the switch, plus every Neon and AWS read the real path needs. The new project is then deleted. It runs **automatically each month** (a schedule, no approval needed, because it changes no live row) and on demand.
3. **The original watch** (daily, in the digest): if an original comes back, the founder is told. The watch lasts at least 30 days.
4. **The disaster deploy path:** `deploy-prod` input `skip_lost_workspaces`, which skips workspaces this button has proven lost. That lets the app deploy while some workspaces are still lost.
5. **Runbook A** in `RESTORE.md` (one or more workspaces lost), with customer email template A.

**Out of scope:**
- 3c-2: the control plane, the reconcile, the whole Neon account;
- automatic switch-over;
- merging data from a returned original (§5);
- recovering a project still in Neon's 7-day recovery window (the button refuses and points to Neon's recovery, which loses nothing).

## 2. Questions for the product owner, and founder duties
**Decided:** the scope (Q1–Q5), the split, the outage override. **Questions:**

| # | Question | Recommendation | Section |
|---|---|---|---|
| Q1 | **Which Neon API key the disaster task holds.** It must create projects and read every project's metadata. Neon has no create-only key. An **organisation key** can delete every project, customers' included. An organisation **Editor** can't delete projects, but can drop any project's databases, branches and history (§4.1.5). | **A dedicated team member with the "Viewer" role.** Its personal key goes into AWS. A Viewer creates its own projects (and is their Admin), and reads all projects' metadata, but can't read others' connection strings or change them. **The honest residual:** a leaked key could read the project list (the names reveal the customer list) and create projects up to the plan's limit. It could also delete or read projects **it created**, including rebuilt live ones, so runbook A step 7 lowers its access on every rebuilt project to Viewer. **Setup:** the alias `neon-ops@cadenzpoint.com`, invited as Viewer, a key made once, pasted into AWS, about 10 minutes. **The rehearsal proves** a Viewer can do everything needed, including seeing other projects in the recoverable list; if not, the fallback is Editor, and I'll tell you. | §6.2, §12 |
| Q2 | **If GitHub itself is down during a disaster.** §5 names the GitHub environment as the trigger. | **Allow a fallback:** you start the same task from AWS CloudShell, signed in with your hardware key, with one command from the runbook. It runs in AWS, and it's emailed like a press (§6.2). Without it, a GitHub outage blocks the 1-business-day target. | §6.9 |

**Design choices stated for the record:**
- **Refuse while Neon can recover the original;** recovery loses nothing.
- **Workspace ids, not names,** are typed into the button, and nothing identifying is printed (public logs).
- **No migrations in the button;** the normal deploy migrates.
- **The monthly automatic rehearsal** keeps the key and the pipeline proven without any action from you.

**One-time founder setup** (Phase 13b; every click in `FOUNDER-ACCOUNTS-SETUP.md`):
1. **GitHub:** the `aws-disaster` environment (you as required reviewer, `main` only, admin bypass off), verified by `curl`; one secret, `AWS_DISASTER_ROLE_ARN`.
2. **Neon (Q1):** the Viewer member and its key.
3. **Just before the first rehearsal (the same day):** create a project named `cadenzpoint-recoverable-canary` with your own account, then delete it. The first rehearsal **with override `canary`** must see it in the Viewer's recoverable list, or it fails. The monthly schedule doesn't check the canary.
4. **AWS Parameter Store:** `/cadenzpoint/backup/neon-api-key`, `/cadenzpoint/backup/neon-org-id`, `/cadenzpoint/backup/restore-test-project-id` and `/cadenzpoint/backup/control-plane-project-id` (the positive control's known projects; 3c-2 uses the second too).
5. **The first rehearsal** (§12).

**Founder duties in a disaster:**
- press and approve;
- run "Deploy to Production" when the email says;
- lower `neon-ops@` to Viewer on each rebuilt project;
- email customers from template A.

## 3. Verified current state (`main` at `8af3b2c`)
- **Neon helpers** (`src/lib/tenant/neon.ts`):
  - `createNeonDatabase(slug)` (`:47-97`) posts `pg_version: 16`, `region_id` from `NEON_REGION_ID`, the tenant database name and the history setting; builds the pooled URL from `pooler_host` (`:84-96`); and waits for the operations (`:100-130`). It falls back to a local database without `NEON_API_KEY` outside production (`:49-54`), so the disaster task never calls it as-is: it uses a key-required variant.
  - `neonProjectExists` (`:238-247`): 404 → false, other failures throw.
  - `deleteNeonProjectVerified` (`:200-236`) checks endpoints and the control-plane host.
  - `directNeonHost` (`:187`).
- **The tenant lock** `withTenantLock` (`src/db/control-plane/locked.ts:57-72`): `pg_advisory_xact_lock(hashtext('tenant:' || id))`, `SET LOCAL lock_timeout`/`statement_timeout`, version-conflict retry. Tenant row updates bump `lifecycle_version` (`schema.ts:64`).
- **Tenants** (`schema.ts:12-…`): `db_url_encrypted`, `status`, `deletion_scheduled_for`, `deleted_at`, `neon_project_id`. **`tenant:delete`** sets `deleting` (`delete-tenant.ts:283`), then `deleted`, `deleted_at` and a null URL (`:340`). **`tenant_audit_events`** (`schema.ts:156-165`): `tenantId`, `kind`, `detail`, `actor`.
- **The registry** caches tenant facts for 60 s (`registry.ts:65`).
- **3b, merged:**
  - `scripts/backup/main.ts` dispatches `backup`/`audit`/`restore-test`;
  - `restoreObject` (`scripts/backup/lib/restore-stream.ts:18-31`) streams, decrypts with the header check, and spawns pg_restore;
  - `countTables`/`compareCounts` (`counts.ts`); the lock factory (`locks.ts`, non-recycled, heartbeat); `parseNeonHost` (`neon-host.ts`); `summarizeError`;
  - the image copies only named inputs (`Dockerfile.backup:10-33`), and the deploy list is `scripts/backup/deploy-paths.txt`.
- **The deploy path:** `deploy-prod.yml` runs `npm run build`, then `db:migrate:all`, then `db:migrate:check`, then `vercel pull`/`build`/`deploy --prebuilt` (`:23-51`). `scripts/migrate-all.ts` parses `--check`, `--concurrency` and `--tenant` (`:56-66`).
- **Repo visibility:** public, so Actions logs and summaries are readable by anyone logged in (§4.2.3).

## 4. External behaviour (verified from source; fetched 2026-11-17)
### 4.1 Neon API v2
1. **Create project:** `POST /projects` → 201 with `project.id`, `connection_uris[]` (`connection_uri` is the direct host; `connection_parameters.pooler_host`) and `operations`. A personal key must pass `org_id`; an organisation key infers it. Poll each operation (`GET /projects/{id}/operations/{op}`) every 5 s until `finished`/`skipped`; `error`/`cancelled` are terminal, and `failed` is terminal only without a `retry_at` (as `neon.ts:113` already treats it); `423 Locked` means retry with backoff (neon.com/docs/reference/api/projects/create-project, …/manage/operations).
2. **List projects** (`GET /projects`): **a personal key must pass `org_id`**, or it lists only the member's own projects. Results are cursor-paginated, and the API may return an incomplete list with `unavailable_project_ids` when some projects are still being fetched. The design passes `org_id`, paginates to the end, and treats a non-empty `unavailable_project_ids` as "unproven" (…/reference/api/projects/list-projects).
3. **Get project:** only the 200 response is documented. **The status for a deleted project, or for no access, is not documented.** So this design treats only the full proof (invariant 2: 404, positive control, not recoverable, and the address not served by a live project) as gone, and anything else as unproven (…/projects/get-project).
4. **Deleted projects:**
   - `GET /projects?recoverable=true` lists deleted projects still in the 7-day window;
   - `POST /projects/{id}/recover` (beta) restores one, with its connection strings. The examples keep the id. **A deletion-time field is not documented**, so the design doesn't depend on one;
   - recovery needs organisation Admin or project Admin (…/recover-project, …/list-projects, …/manage/projects).
5. **Key types** (…/manage/api-keys, …/manage/user-permissions):
   - **organisation:** admin-level, can create and delete;
   - **project-scoped:** can't create projects;
   - **personal:** the user's role. An organisation **Editor** can't delete projects but can create, edit or delete any project's branches, endpoints, databases and roles, and get connection strings. A **Viewer** can create its own projects (whoever creates a project becomes its Admin) and read every project's metadata and endpoints, but can't get other projects' connection strings or change them. **Unconfirmed:** whether a Viewer may call `GET /projects?recoverable=true`; the rehearsal proves it (Q1).
6. **Rate limits:** 700 requests/minute, 40/s burst per route; 429 beyond (…/api/key-concepts).
9. **Neon's proxy and unknown endpoints (verified live 2026-11-17, on direct and `-pooler` hosts):** `*.us-east-1.aws.neon.tech` is wildcard DNS, so any endpoint name resolves to Neon's proxy. Connecting to a never-existing endpoint returns `28P01 password authentication failed` (anti-enumeration), with both postgres.js and psql. A deleted endpoint is expected to answer the same way; the rehearsal checks it (§6.5).
7. **Restore:** with `--no-owner`, the restoring Neon role owns everything. `neon_superuser` isn't a Postgres superuser. Event triggers are allowed for `neon_superuser`. Use unpooled connections (…/import/migrate-from-postgres). 3b already restores this way.

### 4.2 GitHub Actions
1. **`workflow_dispatch` inputs:** `boolean`/`choice`/`number`/`environment`/`string`; at most 25. Use them in scripts **through `env:`**, not `${{ }}` inside `run:` (…/workflow-syntax, …/security/secure-use). The workflow must be on the default branch.
2. **Required reviewers:** one approval suffices; pending approvals fail after 30 days; environment secrets are unavailable until approved; on free plans this works only in public repos. **Not documented: whether the approver sees the inputs**, hence the `confirm` input (…/review-deployments, …/limits).
3. **Public repos:** run pages and logs are readable by any logged-in user. GitHub prints each step's `env:` values in the log, and summaries mask secrets only, so **nothing about workspaces is printed or passed through `env:`**. GitHub shows no inputs panel on run pages (an open request) (…/using-workflow-run-logs).
4. **Cancelling a run:** the runner sends SIGINT to the step's entry process, SIGTERM 7.5 s later, then kills the process tree 2.5 s later. An `if: cancelled()` step still runs (…/workflow-cancellation).

### 4.3 AWS
1. **RunTask:**
   - overrides allow `command` and `environment`, 8,192 characters in total; no secrets override;
   - IAM restricts the task definition by `Resource` and the cluster by `ecs:cluster`. **No condition can restrict command overrides**, so anyone allowed to run the disaster family can run it with any command; the role is reachable only through the approved environment;
   - `iam:PassRole` with `iam:PassedToService = ecs-tasks.amazonaws.com` (…/API_RunTask.html, service authorisation reference).
2. **DescribeTasks:** `lastStatus`, `stopCode`, `containers[].exitCode`; stopped tasks stay visible at least an hour (…/API_DescribeTasks.html).
3. **FilterLogEvents:** searches all streams of a group; paginate until there's no `nextToken`; a quoted phrase pattern (`"BACKUP <cp> tenant <id>"`) is case-sensitive and matches anywhere, so the code re-parses each line exactly; 25 TPS in us-east-1 (…/API_FilterLogEvents.html, …/FilterAndPatternSyntax.html).

4. **IAM resource types:** `ecs:ListTasks` is on resource type container-instance (use `*` with `ecs:cluster`); `DescribeTasks`/`StopTask` are on `task` (service authorisation reference).
5. **ECS Task State Change events** go to EventBridge for every task start, with `detail.taskDefinitionArn` and `lastStatus`, needing no CloudTrail (…/ecs_cwe_events.html).

## 5. Invariants that must not break
1. **The original database is never deleted, overwritten or written** by anything in this item.
2. **A switch needs proof:**
   - **Gone:**
     - (a) `GET /projects/{id}` → 404;
     - (b) a **positive control**: the same key and `org_id` list the organisation's projects with no `unavailable_project_ids`, **and** return 200 for one known project. That's the first that answers of: the restore-test project (`RESTORE_TEST_PROJECT_ID`), the control plane's project (`CONTROL_PLANE_PROJECT_ID`), or any other live workspace's project;
     - (c) the id is absent from the recoverable list (with `org_id`, paginated to the end, **polled 6 × 10 s**, since the list may lag);
     - (d) **the tenant's own address isn't served by a live project**, decided by `classifyEndpoint` (§6.4.1):
       - a **successful** login with the stored credentials → refuse `reachable`;
       - otherwise (an authentication error, a proxy error, or a socket error) it counts as "doesn't answer" **only if** no existing organisation project serves that endpoint. **The candidates** are projects named exactly `cadenzpoint-<slug>`, or starting `cadenzpoint-r-<tenant id first 8>-` (the button's own rebuilds), found with the list's `search` and `org_id`. Each is checked with `GET /projects/{id}/endpoints` against the URL's direct host:
         - a match means a stale `neon_project_id` → refuse `reachable`;
         - **any endpoints call that isn't 200, or a list with `unavailable_project_ids`, → unproven** (never "not served").

         The candidate rule is a parameter, so 3c-2 can pass the control plane's name. Runbook A notes: **don't rename tenant projects in the Neon console.**

       Neon's proxy answers an unknown or deleted endpoint with `28P01` "password authentication failed", not a network error (verified live, §4.1.8). So an authentication error alone proves nothing either way.
   - **Or unreachable for 4 hours** (the override):
     - the project answers 200, but its database refuses connections now, with a connection error (not an authentication error);
     - **and** the same was observed at least 4 hours earlier, either by this button's own earlier observation (§6.4 step 2) or by 3b's failed backup rows (connection labels) with no `ok` since;
     - **and** the founder typed the override.

   Anything else refuses.
3. **A switch is atomic and checked** under the app's tenant lock:
   - byte equality on the URL and project id read at the start;
   - live status and no passed deletion date;
   - a `lifecycle_version` bump.
4. **Only verified backups are restored:**
   - the context binds the object to its workspace and to the current control plane's `cp`;
   - the SHA-256 equals the control-plane row's, or the backup task's `BACKUP` log line;
   - the sidecar matches;
   - every count matches.
5. **Every project the task creates is tracked before it exists.** On a failure before the switch commits, the task deletes it **only after a locked re-read proves the tenant row doesn't point to it**. If that can't be proven, it's kept and reported (the leftover finding). A project the tenant row points to is **never** deleted.
6. **Customer data stays in Neon us-east-1 and AWS us-east-1.** No customer name appears in public logs or in the disaster log group (ids only). The founder isn't asked to view customer data.
7. **Only the founder can start it, and every start is known:**
   - the `aws-disaster` environment and its OIDC trust;
   - the button role starts only the disaster family;
   - an ECS task-state rule emails **every** start of the family, whatever the caller or path.

## 6. Design

### 6.0 The disaster deploy path (`deploy-prod.yml`, `scripts/migrate-all.ts`, `scripts/lib/migrate-all-run.ts`)
While some workspaces are lost, `deploy-prod` would fail on them (`tenant-migration.ts:44-58`). After a rebuild, a deploy must migrate the rebuilt ones. So:
- **`deploy-prod.yml`:**
  - gains the `workflow_dispatch` boolean input `skip_lost_workspaces` (default false). The step sets `SKIP_LOST: ${{ inputs.skip_lost_workspaces == true }}` and passes `--skip-lost` only when `[ "$SKIP_LOST" = true ]`, to both `db:migrate:all` and `db:migrate:check`;
  - **pins** `actions/checkout` and `actions/setup-node` by SHA, and the Vercel CLI by exact version (§2's rule).
- **`--skip-lost`** skips a tenant only when all of these hold. Each skip prints "skipped (proven lost, awaiting rebuild)" **with the tenant's uuid, never its slug**: the deploy log is public. D5 and the §3.7 run assert that no slug appears on a skipped row. (Pre-existing, noted for the product owner: deploy-prod's table already prints every slug publicly. That's tracked separately, not changed here.)
  1. its newest **decisive** `proof` row (`gone`, `unreachable-4h`, `observed-unreachable`, `reachable-again`, or `refused:original-exists|reachable|recoverable`; a transient `refused:proof-failed` or `network-unproven` doesn't supersede) says `gone`, `unreachable-4h` or `observed-unreachable` (any age);
  2. no `linked` row is newer, and no 3b `ok` backup finished after it;
  3. **this deploy's `pendingCount` for it throws, with any error.** That's the first call, which connects and queries; `migrateOneTenant` catches it at `tenant-migration.ts:42-63`. A failure in `migrate()` itself is never skipped. A Neon proxy error for a deleted endpoint isn't a socket error. A tenant that connects is migrated normally, but only when the run holds the migrate lock. **A tenant excluded from step 0 that reconnects in the pass is reported "reachable again; re-run the deploy" and counts as FAILED (exit 1, so Vercel doesn't deploy) instead of being migrated without the lock**, keeping 3b's rule that migrations and backups never overlap. Either way its proof stops counting: **every `migrate-all` run** (with or without the flag, not `--check`) appends a superseding `proof` row `reachable-again` (`run_id` = `migrate-<timestamp>`) for each tenant with a live proof that connected.
- **Reading `disaster_actions` tolerates a missing table** (42P01 counts as "no proofs"), so the deploy that merges this item, which runs before the migration creating it, doesn't fail. Tested like `backup-locks.test.ts:198`.
- `listTenants` gains the tenant `id`. The workflow calls `npm run db:migrate:all -- --skip-lost` (the `--`, or npm swallows the flag); D5 and the §3.7 run assert that the flag reaches argv.

  Any other unreachable tenant fails the deploy, as today.
- **Step 0 of `migrate-all-run.ts`** (the backup-wait handshake) excludes skipped tenants from its pending count, so they don't force a 30-minute wait.

### 6.1 The button (`.github/workflows/disaster-restore.yml`, `scripts/backup/disaster-button.sh`)
```yaml
name: Disaster restore
on:
  workflow_dispatch:
    inputs:
      mode:     { type: choice, options: [workspace, rehearse], required: true }
      targets:  { type: string, required: true, description: 'Workspace ids (uuid), comma-separated, or all-lost (workspace only)' }
      override: { type: choice, options: ['none', 'unreachable-4h', 'canary'], default: 'none' }   # canary: rehearse only
      confirm:  { type: string, required: true, description: 'Type the mode again' }
permissions: { contents: read }
concurrency: { group: disaster-restore, cancel-in-progress: false, queue: max }
jobs:
  run:
    if: github.ref == 'refs/heads/main' && vars.AWS_BACKUPS_ENABLED == 'true'
    runs-on: ubuntu-24.04
    environment: aws-disaster
    timeout-minutes: 360
    permissions: { contents: read, id-token: write }
    steps:
      - uses: actions/checkout@<sha>
        with: { persist-credentials: false }
      - uses: aws-actions/configure-aws-credentials@<sha>
        with: { role-to-assume: '${{ secrets.AWS_DISASTER_ROLE_ARN }}', aws-region: us-east-1, role-duration-seconds: 21600, mask-aws-account-id: true }
      - id: run
        run: exec bash scripts/backup/disaster-button.sh     # reads the inputs itself; nothing passed via env:
      - if: cancelled()
        run: bash scripts/backup/disaster-button.sh --stop   # stops every task started by this run
```
- **Inputs are never in `env:` or a step's `${{ }}`;** GitHub prints step env values in public logs (§4.2.3). D7 asserts `inputs.` appears only under `on:`.
- **Cancelling:** GitHub signals only the step's entry process and kills the tree after 10 s (§4.2.4). So the reliable stop is the `if: cancelled()` step. `exec` and traps on INT, TERM and EXIT are a second line.

**`disaster-button.sh`** (bash, AWS CLI and `jq`; `set -euo pipefail`; never `set -x`; every AWS call either captures one field with `--query … --output text` or goes to `/dev/null`):
1. **Read and mask:** `jq -r` each input from `$GITHUB_EVENT_PATH`, then `::add-mask::` each target before anything else. Rules:
   - `confirm` must equal `mode`;
   - `targets` must match `^(all-lost|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(,[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}){0,49})$`;
   - `rehearse` takes exactly one id, and override `none` or `canary`; `canary` is only for `rehearse`;
   - `all-lost` can't be combined with an override.
2. **One run at a time:** `aws ecs list-tasks --cluster … --family cadenzpoint-backup-disaster --desired-status RUNNING --query 'length(taskArns)'`. If it's not 0, stop: "a disaster task is already running".
3. **Start:** `aws ecs run-task` with:
   - `--started-by gh-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT`;
   - the disaster family and Fargate, with the subnets and security group from the stack outputs and `assignPublicIp=ENABLED`;
   - `containerOverrides` `[{ name: "disaster", command: ["disaster", MODE, "--targets", TARGETS, "--override", OVERRIDE, "--run-id", "gh-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"] }]` (the container's name from the task definition).

   Capture `tasks[0].taskArn` and `failures` only.
4. **`--stop`:** `list-tasks --started-by gh-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT` (retried 3 times, 10 s apart, since a just-started task may not be listed yet), then `stop-task` each, with output to `/dev/null`.
5. **Wait:** every 60 s (`sleep 60 & wait $!`), `describe-tasks --query 'tasks[0].[lastStatus,stopCode,containers[0].exitCode]'`. Stop when `STOPPED`, or after 340 minutes. A failed describe is retried. **No `aws ecs wait`.**
6. **Report:**
   - a null exit code (the container never ran) → "the task didn't start: <stopCode>", exit 1;
   - exit code 2 → "this image is older than the button: approve the pending Backup system deploy, then press again";
   - otherwise "disaster task finished: exit <code>; run gh-<id>; results emailed and in the digest", and exit with that code;
   - **the 340-minute wait runs out with the task still running** → "still running; its results will be emailed", exit 1. It doesn't stop the task; the cancelled-step only runs on a cancel.

### 6.2 AWS additions (`ops/aws/backup-stack.yml`)
| Resource | Notes |
|---|---|
| **`DisasterButtonRole`** (`/cadenzpoint-backup/cadenzpoint-backup-disaster-button`) | **Trust:** GitHub OIDC, `StringEquals` `aud`, and `sub = repo:ccentofo/bytime:environment:aws-disaster`. **Policy:** `ecs:RunTask` on `task-definition/cadenzpoint-backup-disaster:*` with `ecs:cluster` = the backup cluster; `ecs:ListTasks` on `*` with `ArnEquals ecs:cluster` (its resource type is container-instance, §4.3.4); `ecs:DescribeTasks` and `ecs:StopTask` on `task/cadenzpoint-backup/*`; `iam:PassRole` on the two disaster roles with `iam:PassedToService = ecs-tasks.amazonaws.com` (that's what stops a `taskRoleArn` override); `ecs:TagResource` (`ecs:CreateAction = RunTask`); `cloudformation:DescribeStacks` on the main stack. **`MaxSessionDuration: 21600`** (the workflow asks for 6 h; the default is 1 h). **Stated:** a role that may run the disaster family may run it with any command or environment (§4.3.1), and Describe/Stop also reach the backup tasks in that cluster, so the role equals the disaster task's powers plus stopping backup tasks. It's reachable only through the approved environment. |
| **Task definition `disaster`** | The same image; **container name `disaster`** (the button's and the schedule's overrides use it; D7 asserts both); `Command ["disaster"]`; 2 vCPU / 4 GiB; `StopTimeout: 120`; log group `/cadenzpoint/backup/disaster`, retention 365 days (ids only, invariant 6). |
| **Disaster execution role** | ECR pull; logs; `ssm:GetParameters` on control-plane-url, encryption-key, neon-api-key, neon-org-id, restore-test-project-id and control-plane-project-id. |
| **Disaster task role** (`…/cadenzpoint-backup-disaster-task`) | `s3:GetObject`, `s3:ListBucket` (`v1/*`); `kms:Decrypt` (`purpose` condition); `logs:FilterLogEvents` on the backup task's log group; `ecs:ListTasks` (`*` + `ecs:cluster`) and `ecs:DescribeTasks` (`task/cadenzpoint-backup/*`) for the in-task single-run check; `sns:Publish` on the alert topic. **No SSM write.** |
| **Schedule `cadenzpoint-backup-disaster-rehearse`** (the name fits `CfnExecRole`'s `schedule/default/cadenzpoint-backup-*`, `bootstrap.yml:265`) | `cron(17 15 1 * ? *)` UTC (the 1st at 15:17, when no backup job runs); `Input` command `["disaster", "rehearse", "--targets", "auto"]`, with the run id generated by the task. `auto` = a random workspace that is live, not due for deletion, and has an `ok` backup in the last 36 h. **None eligible → the rehearsal fails** "no eligible workspace", and the alert is raised. The Scheduler role gains `ecs:RunTask` on the disaster family **and `iam:PassRole` on the disaster execution and task roles**, as 3b's role lists its passed roles. |
| **Policy updates** | The bucket's GetObject deny and the key's Decrypt/ReEncrypt deny gain the disaster task role. `expected-policies.ts`, `ALL_ROLES`, `rulePatterns` and the audit role's `InspectRules` include the new roles and rules. |
| **Alerting additions** | **(1) `cadenzpoint-backup-disaster-started`:** the ECS **Task State Change** event (`source aws.ecs`; `detail.taskDefinitionArn` prefix `arn:aws:ecs:us-east-1:<acct>:task-definition/cadenzpoint-backup-disaster:`; `detail.lastStatus` `PROVISIONING` **or `STOPPED`**). It emails both the start and the finish of every run, whatever the start path, without CloudTrail. **(2) `cadenzpoint-backup-disaster-runtask`:** CloudTrail `RunTask` matching the family **or** its ARN (`$or` of two prefixes on `requestParameters.taskDefinition`), so the email names the caller. **(3) The protections rule** gains `PutParameter`, `DeleteParameter` and `DeleteParameters` **by event name only**, with no `requestParameters` filter, which would stop the rule's other events from matching. The account writes no parameters in normal operation, so this costs only expected emails. D7 asserts the protections pattern has no `requestParameters` key. |
| **Outputs** | `DisasterButtonRoleArn`; the cluster, subnets and security group. |

### 6.3 Image and deploy changes
- **The bundle gains** `scripts/backup/disaster.ts`, `scripts/backup/lib/neon-api.ts`, and imports of `src/lib/tenant/db-name.ts` and `src/lib/tenant/lifecycle-config.ts` (the database-name and history rules; `import type` only from the schema).
- The Dockerfile `COPY`s those two `src/` files, and `deploy-paths.txt` lists them. U6's metafile check enforces both.
- **No migrations in the image.**
- **The image rejects unknown flags with exit 2,** which the button reports as "image older than the button" (version skew).
- **§3.7:** the changed `run:` blocks of the new workflow and `deploy-prod.yml` run verbatim with stub `aws`, `jq` and `vercel`; the exact-COPY build check; **the early CI push**.

### 6.4 Mode `workspace` (`scripts/backup/disaster.ts`)
**Environment:**
- from SSM: `CONTROL_PLANE_DATABASE_URL`, `ENCRYPTION_KEY`, `NEON_API_KEY`, `NEON_ORG_ID`, `RESTORE_TEST_PROJECT_ID`, `CONTROL_PLANE_PROJECT_ID`;
- constants: `NEON_REGION_ID=aws-us-east-1`, `BACKUP_BUCKET`, `BACKUP_KMS_KEY_ARN`, `BACKUP_DECRYPT_KEY_ARNS`, `ALERT_TOPIC_ARN`, `BACKUP_PG_RESTORE_BIN`, `BACKUP_LOG_GROUP`, `DISASTER_LOG_GROUP`, `AWS_REGION`, `DISASTER_DEADLINE_MINUTES=330`.

**argv:** one parser (`parseDisasterArgs`) shared by the task and D2's tests: `workspace` takes ids or `all-lost` and override `none`/`unreachable-4h`; `rehearse` takes one id or `auto`, and override `none`/`canary`. `--run-id` is optional; the task generates `task-<timestamp>` when it's absent. An unknown flag → exit 2. **Exit code 2 is reserved for that**; every other failure exits 1.

**Who started it:** the task reads its own `startedBy` (DescribeTasks on its ARN). **`workspace` is refused unless it starts with `gh-` or `cloudshell-`.** So the monthly schedule, or a schedule edited in a deploy, can only rehearse.

**Start:**
- **single run:** `ecs:ListTasks` for the family. If another running task has an earlier `createdAt`, or the same `createdAt` and a smaller ARN, exit "another disaster task is running".
- **lock:** take `DISASTER_LOCK_KEY = 728_402_205` through 3b's lock factory, **waiting up to 3 minutes** (a cancelled task can hold it for its 120 s stop).
- **run row:** close older `running` `disaster_runs` rows as `fail` (`abandoned`), then insert this run's row.

**Targets:**
- given ids → those tenants;
- `all-lost` → every `provisioning`/`active`/`suspended` tenant with a URL whose step 2 proves **gone**, never by the override. Done efficiently: first collect the tenants whose projects 404 (concurrency 4), then fetch **one** positive control and **one** recoverable list (after the 404s, so it's fresh) for all of them.

**Per workspace** (concurrency 2; any failure records an error summary and moves on):
1. **Facts:**
   - status `active`/`suspended`, or `provisioning` with a URL;
   - `neon_project_id` non-null;
   - `decrypt(db_url_encrypted)` succeeds;
   - **`deletion_scheduled_for` null or in the future.** If it has passed, the workspace isn't rebuilt. **Step 2's proof still runs and is recorded** (its real status, with detail `deletion-due`), so a proven-lost one can be skipped by deploys. Then refuse `deletion-due` (runbook A.8).

   Keep `oldUrlEncrypted` and `oldProjectId`.
2. **Proof** (invariant 2). The result is appended as a `disaster_actions` row of kind `proof`, status `gone`/`unreachable-4h`/`refused:<reason>`. That row is what `--skip-lost` reads.
   - **Gone** → continue.
   - **Recoverable** → refuse `recoverable`: "recover it in the Neon console, nothing is lost".
   - **Network first:** before any unreachable result counts (the override path, (d) above, or recording `observed-unreachable`), the task proves its own network. One other live workspace, or failing that the control plane (both Neon us-east-1), must connect. Otherwise refuse `network-unproven`, and record nothing as evidence.
   - **200, with the override typed:**
     1. classify with the override rules of §6.4.1, two tries 60 s apart;
     2. **answers**, **credentials problem** or `url-project-mismatch` → refuse;
     3. **unreachable** on both tries → look for evidence at least 4 hours old:
        - an earlier `proof` row `observed-unreachable` for this tenant **with the same `old_project_id`**, from 4 to 48 hours ago, with **no 3b `ok` row and no `reachable-again` since it**;
        - **or** 3b's rows for it within the last 26 hours are all `failed` with label `connection-refused` or `timeout`, the oldest at least 4 h ago, and no `ok` since.

        **Either kind counts only if it's newer than the tenant's latest `linked` row** (or `database-rebuilt` audit), so evidence about an earlier original never justifies switching away from a rebuilt one.



        Found → continue. The original stays and is watched, and the email names the evidence used. Not found → append `observed-unreachable` and refuse: "observed unreachable now; press again with the override after <now + 4 h>".
   - **200 without the override** → refuse `original-exists`: "if it has been unreachable for hours, press with the override".
   - **Unproven** → refuse `proof-failed`.
3. **Schema note:** read the newest applied migration in up to two other reachable live workspaces. The email then says "the app is N migrations ahead of this backup: run Deploy to Production now", or "no other workspace was reachable: run Deploy to Production now to be safe".
4. **Backup, newest first, up to 3 tries:**
   - candidates are the tenant's `ok` rows plus objects under `v1/<current cp>/tenant/<id>/` whose SHA-256 is confirmed by a `BACKUP` line (the catch-up and late tenants);
   - the context's `cp` must be the current control plane's;
   - **only an integrity failure moves to an older candidate:** a context or `cp` mismatch, a decryption or authentication failure, a SHA or sidecar mismatch, or a count mismatch. The failed project is deleted (step 10), and the next candidate gets a fresh project;
   - **an infrastructure failure** (labels `connection-refused`, `timeout`, `s3-error`, `kms-error`, `killed`, a Neon 5xx, 423 or 429 after backoff) **retries the same candidate once** in a fresh project. If that fails too, the workspace stops **without switching** (status `retryable`; the email says "press again"). A transient fault never pushes a workspace onto an older backup, which couldn't be undone once linked.
   - **Anything unclassified** (label `other`, such as a restore that fails the same way every time) stops the workspace **without switching and without falling back** (status `restore-failed`; the email says to contact the lead).
5. **Create** (`neon-api.ts`):
   - name `cadenzpoint-r-<tenant id, first 8>-<yyyymmddhhmmss>-<try>` (at most 40 characters, unique);
   - insert the intent row first (`disaster_actions` kind `rebuild`, the name, `intended`);
   - `POST /projects` with `org_id`, pg 16, us-east-1, `tenantDatabaseName(slug)` and `tenantDbHistoryRetentionSeconds()`. The task definition sets `NEON_HISTORY_RETENTION_SECONDS` to the app's production value (a stack constant), so rebuilt projects get the same retention. 423 and 429 are retried with backoff; the operations are awaited;
   - record `created` with the id;
   - a create error with no id → list by that exact name (with `org_id`). Found → adopt (`created`), then clean up.
   - The email gives Neon's HTTP status and error code (not the message).
6. **Restore** into the new project's direct URL:
   - the host must be a us-east-1 Neon host via `parseNeonHost` (tests override it in-process), and not the control plane's;
   - `pg_restore --no-owner --no-acl --exit-on-error --single-transaction`;
   - decryption complete, the SHA matches, exact counts against the row or sidecar.
7. **Guards:**
   - the new endpoint belongs to the new project and isn't the control plane's;
   - no other non-deleted tenant has this project id or direct host;
   - a decrypt failure on another row refuses.
8. **In override mode, re-check first:** run the override classification again. If it **answers** now, abort, clean up (step 10), and report "reachable now".
   **Switch** (one transaction):
   - `SET LOCAL lock_timeout = '5s'`; `pg_advisory_xact_lock(hashtext('tenant:' || id))` (pinned to `locked.ts:63` by D4);
   - `UPDATE tenants SET db_url_encrypted = encrypt(pooled URL), neon_project_id = new, lifecycle_version = lifecycle_version + 1 WHERE id = … AND status IN ('provisioning','active','suspended') AND db_url_encrypted = oldUrlEncrypted AND neon_project_id = oldProjectId AND (deletion_scheduled_for IS NULL OR deletion_scheduled_for > now())`;
   - a lock timeout is retried up to 3 times, 10 s apart (a webhook may hold the tenant lock briefly);
   - **0 rows** → `changed-meanwhile`;
   - in the same transaction:
     - audit `database-rebuilt` (actor `disaster:<run id>`; old and new project, backup key, backup `started_at`, SHA-256, override used or not);
     - append the `linked` row;
     - raise the global `rebuild-original-watch` (dedup = old project id; detail: tenant id, slug, backup time, watch start). All raw-SQL alert raises use `ON CONFLICT` on `ops_alerts_open_unique`, as `raiseAlert` does;
     - **with the override,** also raise `rebuild-original-returned` at once (detail includes the tenant id, which `tenant:delete` matches on): the original exists by definition, so the founder is told to settle it with the customer and delete it.
   - **Just before the commit,** write `SWITCHING <tenant id> <old project> <new project> <backup key> <sha256>`; **after it,** `LINKED …` with the same fields, both to the disaster log group. 3c-2 re-applies rebuilds from these lines after a control-plane loss, confirming each against Neon (the brief says so). A `SWITCHING` without a `LINKED` (a kill at the commit, or a commit healed later by the leftover check) is still recoverable that way.
9. **The app** uses the new database within 60 s (`registry.ts:65`; pools are keyed by URL).
10. **Cleanup on any failure, before or instead of a commit:**
    - **first, wait for any in-flight switch call to settle** (the SIGTERM and deadline paths await it; `StopTimeout` is 120 s);
    - **then re-read the tenant row inside a transaction that takes the same tenant advisory lock** (`pg_advisory_xact_lock(hashtext('tenant:' || id))`, `lock_timeout = '30s'`), so a commit still in progress is waited for, not missed;
    - **if `neon_project_id` equals the new id** (a commit whose acknowledgement was lost), record `linked`, write the `LINKED` line, and **don't delete**;
    - **a lock timeout or any read error → never delete:** retry the locked re-read every 30 s **within the time left** (the run's deadline, or the 120 s stop window after SIGTERM). If it still fails, append `failed` on exit, and the leftover finding handles it;
    - otherwise delete the new project (the task is its Admin; 423 and 429 retried with backoff), verify the 404, and append `deleted`;
    - a failed delete appends `failed`, and the leftover finding picks it up;
    - **`linked` is terminal:** no later step, deadline or SIGTERM deletes a linked project.

**End:**
- one email to the alert topic (private) listing, for each workspace: the id, slug and result; the **backup time**; "changes after <backup started_at> UTC need re-entering"; the skipped backups; the Deploy to Production line; and "lower `neon-ops@` to Viewer on project <id>" (runbook A.7);
- the run row set `pass` or `fail`;
- deadline 330 min and SIGTERM run step 10's rules for in-flight workspaces.

### 6.4.1 `classifyEndpoint(url, candidates)` (used by (d) and the override)
**On the override path the project exists by definition**, so the table below isn't used there. Instead:
- a successful login → **answers**;
- **any `28P01` → credentials problem** (refuse `reachable`);
- only a proxy error that isn't `28xxx`, or a socket error or timeout, → **unreachable**;
- also, `GET /projects/{neon_project_id}/endpoints` must list the URL's direct host. If it doesn't, refuse `url-project-mismatch`.

The table is for proof (d), where the project 404s:
| Connection result | Endpoint served by a live org project? | Class |
|---|---|---|
| login succeeds | — | **answers** |
| `28P01` (auth) | yes (the URL host's endpoint is listed by a live candidate project) | **served**: refuse `reachable` (a stale project id) |
| `28P01` (auth) | no | **doesn't answer** (Neon's response for an unknown or deleted endpoint) |
| a proxy error that isn't `28xxx` (e.g. "Couldn't connect to compute node", "endpoint … not found/disabled") or a socket error/timeout | yes | **served** (refuse `reachable`; a live project holds that endpoint) |
| the same | no | **doesn't answer** |
| any endpoints lookup fails, or the list is partial | — | **unproven** |

3b's `labelFor` (`summarize-error.ts:61`) gains Neon's proxy wording ("Couldn't connect to compute node", "endpoint is disabled", "endpoint not found") as `connection-refused`, so 3b's failed backups qualify as override evidence. A local test server (D1) answers the Postgres startup with a `28P01` error, as Neon does, plus each proxy error.

### 6.5 Mode `rehearse` (on demand, and monthly by schedule)
Mode `workspace` for one id (or `auto`), with these differences:
- **step 2 runs the full proof against the live original and requires:**
  - the project answers 200;
  - the positive control passes;
  - the recoverable list was returned;
  - (the canary check below polls the list the same way);
  - **on a rehearsal started from the button with override `canary`** (§12 step 5): the list **contains `cadenzpoint-recoverable-canary`**, and `GET /projects/{canary id}` returns **404**, proving legs (a) and (c) for another member's deleted project. **Otherwise the rehearsal fails.** Monthly rehearsals don't check the canary; the daily `rebuild-original-recoverable` finding (§6.8) catches a recoverable original after the fact, while recovery is still possible.
- **its proof row has status `rehearse-ok`,** which `--skip-lost` and the override evidence ignore;
- **step 8 runs its guards as plain `SELECT`s** (nothing written, no lock taken);
- **step 10 always runs:**
  1. delete the project, verify the 404;
  2. check it appears in the recoverable list (polled up to 6 × 10 s, since the list may lag), proving deletions are visible to the key;
  3. run **`classifyEndpoint` on the deleted project's endpoint, retrying for up to 5 minutes** (a compute or proxy route may linger), and require "doesn't answer". Record the class and the delay. Otherwise the rehearsal fails: the real proof would misjudge a lost workspace;
  4. append `rehearsed-deleted`.

The email reports the result and timings. A failed scheduled rehearsal raises `disaster-rehearse-failed` (§6.8).

### 6.6 (reserved)

### 6.7 Control-plane tables (one drizzle-kit migration)
**`disaster_runs`** (`finished_at`, `status` and `summary` are set once at the end):

| column | type / note |
|---|---|
| `id` | uuid PK |
| `run_id` | varchar(80) |
| `mode` | `workspace` \| `rehearse` |
| `started_at`, `finished_at` | timestamptz |
| `status` | `running` \| `pass` \| `fail` |
| `summary` | jsonb (counts; ids and results; no error text beyond 3b's summaries) |

**`disaster_actions`** (append-only; the latest row per tenant and kind, or per project, is current):

| column | type / note |
|---|---|
| `id` | uuid PK |
| `run_id` | varchar(80) |
| `tenant_id` | uuid null FK → `tenants.id` ON DELETE CASCADE (tests delete tenant rows; production tombstones) |
| `kind` | `proof` \| `rebuild` \| `rehearse` |
| `status` | `proof`: `gone` \| `unreachable-4h` \| `observed-unreachable` \| `reachable-again` \| `rehearse-ok` \| `refused:<reason>`; `rebuild`/`rehearse`: `intended` \| `created` \| `linked` \| `deleted` \| `failed` \| `rehearsed-deleted` \| `gone-confirmed`. A run's **result** per workspace (`changed-meanwhile`, `retryable`, `no-backup`, …) is in `disaster_runs.summary` and the email, not in this column. |
| `project_name`, `new_project_id`, `old_project_id` | varchar null (`proof` rows store `old_project_id` = the original they observed) |
| `backup_key`, `backup_started_at` | null |
| `detail` | text null (summary) |
| `at` | timestamptz |

### 6.8 Monitoring (3b's `backup-status.ts`, digest; Neon checks use the app's `NEON_API_KEY`, 10 s timeouts)
The app's key must be an **organisation** key. `PRODUCTION-DEPLOY.md` 5.5 is reworded to say **Organization settings → API keys** (not account). With it, the organisation is inferred and the lists cover every project. **The checks detect a personal key:** if the list doesn't contain the control plane's project (`CONTROL_PLANE_PROJECT_ID`, a Vercel env added with this item), raise `rebuild-watch-check-failed` ("the app's Neon key can't see the organisation") instead of trusting the result.
| Finding | Condition | Alert (scope / dedup) |
|---|---|---|
| leftover project | a project whose latest action is `intended`/`created`/`failed` for over 6 h **and that no tenant row references** (one that is referenced is healed to `linked`) | `rebuild-orphan-project` (global / project id or name; detail includes `tenant_id` and slug): "delete it in the Neon console". **Resolved** when the daily check finds no project by that id or name; the check then appends `gone-confirmed`, so it isn't re-checked. **If a tenant row references a `failed` project** (a commit that landed while cleanup couldn't prove it), the check appends `linked` and raises the watch instead. |
| disaster run stuck | a run `running` for over 6 h | `disaster-run-stuck` (global); resolved when it finishes or is closed `abandoned` (by the next run, at the latest the monthly rehearsal) |
| rehearsal failed | the newest `rehearse` run (scheduled or by hand) is `fail`, or no rehearsal has passed in 40 days (anchored to the first) | `disaster-rehearse-failed` (global); **resolved** when the newest rehearsal passes |
| original returned | an open watch's project answers 200 (or raised at the switch for an override) | `rebuild-original-returned` (global / old project id): "the original exists. Don't open it: ask the customer whether their re-entered hours are complete, then delete it in the Neon console (runbook A.6)". **Resolved on 404 alone.** |
| original recoverable | a watched original answers 404, **is** in the org key's recoverable list, and **was never reported `returned`** (so it wasn't deliberately deleted by the founder after returning) | `rebuild-original-recoverable` (global / old project id): "the original can still be recovered in Neon until about <first seen in the list + 7 days>. Recovering it won't switch the workspace back (the button refuses to switch to a live original). It would become a 'returned' copy, for you and the customer to settle (runbook A.6)". Resolved when it leaves the list, or returns. |
| watch done | at least 30 days since the watch started, and the project 404s and isn't recoverable | the watch resolved |
| watch check failed | a Neon call fails | `rebuild-watch-check-failed` (global); resolved by the next success |

- **The digest's Backups section** adds "Disaster runs in the last 7 days: <mode> <status> at <time>".
- **These kinds are not in 3b's `FINDING_KINDS`** (so `syncBackupAlerts` doesn't resolve them), and they're excluded from "monitoring off resolves every backup kind".
- **`tenant:admin resolve-alert`** (`admin-commands.ts:330`) **refuses the `rebuild-*` and `disaster-*` kinds:** they close only on the facts above, so a watch can't be ended by hand.
- **`tenant:delete`** refuses to apply while an open `rebuild-original-returned` or `rebuild-orphan-project` names the tenant. Both resolve once the founder deletes the project in Neon (404), so this can't block forever.
- **The override's original** exists at the switch, so "returned" is raised then (above) and stays until it 404s. **`tenant:delete` refuses while any open `rebuild-original-returned` names the tenant.** So a workspace can't be deleted while a copy of its data still exists in Neon, and the copy is deleted first.

### 6.9 Runbook A (`RESTORE.md`, "Disaster: workspaces")
1. **Neon console:** if the project is listed as deleted and recoverable, recover it there. Nothing is lost; stop.
2. **Unreachable but not deleted** (check status.neon.tech): wait for Neon. If it's still unreachable after 4 hours, press with the override (step 3). The button records the first observation if it has none yet, and tells you when to press again.
3. Find the workspace id (in the digest's alerts or `tenant:admin show <slug>`). Actions → **Disaster restore** → `workspace`, the id(s) or `all-lost`, override if needed, confirm `workspace` → approve. **To cancel, cancel the run**: its last step stops the task.
4. **Right away:** run **Deploy to Production**. Tick `skip_lost_workspaces` if other workspaces are still lost. This applies migrations, and any database rules added since the backup, before customers use the rebuilt workspace.
5. Email the customer with **template A**: the backup time; what to re-enter; that records before it are intact.
6. If the digest says the original came back: don't open it. Ask the customer to confirm their re-entered hours are complete, then delete the original in the Neon console. The watch closes after its 30 days.
7. In the Neon console, on each rebuilt project's access settings, set `neon-ops@` to **Viewer** (Q1's residual).
8. **A lost workspace that was due for deletion** (the button records its proof and refuses `deletion-due`): deploys skip it. `tenant:delete` refuses on a missing project today; the proven-gone deletion path is in 3c-2. Until then, it stays skipped and listed.
9. **If GitHub is down (Q2):** in AWS CloudShell as `corey-admin`, run the command printed here (`aws ecs run-task … --started-by cloudshell-<date>` with the same overrides). The start emails you.
10. **A workspace that can't be rebuilt** (`no-backup`): its proof keeps it skippable by deploys until it's rebuilt or reachable again. Contact the lead. 3b's daily `backup-failed`/`backup-stale` alerts for it continue meanwhile; that's expected.

## 7. State machines
### 7.1 One workspace
| State | Event | Next | Side effects |
|---|---|---|---|
| start | facts fail | failed `facts` | none |
| start | deletion date passed | proof recorded, then failed `deletion-due` | the proof's real status (detail `deletion-due`) |
| start | 200, no override | failed `original-exists` | `proof` refused |
| start | 404, but the URL logs in or a candidate project serves its endpoint (proof d) | failed `reachable` | `proof` refused |
| start | 200, override: login succeeds, any `28P01`, or the URL's host isn't the project's endpoint | failed `reachable` / `url-project-mismatch` | `proof` refused |
| proven (override) | the re-check before the switch logs in | failed `reachable-now` | cleanup |
| start | 200, override, unreachable, no 4 h evidence | failed `observed` | `proof observed-unreachable` |
| start | 200, override, unreachable, evidence ≥ 4 h | proven | `proof unreachable-4h` |
| start | unproven | failed `proof-failed` | `proof` refused |
| start | the task's own network unproven | failed `network-unproven` | `proof` refused (not evidence) |
| proven | no backup candidates at all | failed `no-backup` | none |
| created | unclassified restore failure (label `other`) | cleanup, no fallback | `deleted`; result `restore-failed` |
| start | recoverable | failed `recoverable` | `proof` refused |
| start | gone | proven | `proof gone` |
| proven | no candidate verifies after 3 | failed `no-backup` | candidates' projects deleted |
| proven | intent row | intended | — |
| intended | id returned | created | `created` |
| intended | no id; found by name | created (adopted) | `created`, then cleanup |
| intended | no id; not found | failed `create` | `failed` (no project) |
| created | integrity failure (context, decrypt, SHA, sidecar, counts) | the next older candidate (up to 3), or cleanup | `deleted` |
| created | infrastructure failure | the same candidate once more, then stop without switching | `deleted`; result `retryable` |
| created | guards fail | cleanup | `deleted` |
| created | switch: 0 rows | cleanup | `changed-meanwhile` |
| created | switch commits | **linked (terminal)** | audit, `linked`, watch, `LINKED` line |
| created | commit acknowledgement lost, or still committing | cleanup waits on the tenant lock; the locked re-read finds the new id → linked | `linked`, `LINKED` line |
| created | cleanup's locked re-read times out or errors | failed (project kept) | `failed`; the leftover finding |
| created | deadline / SIGTERM | cleanup (re-read first) | `deleted` / `failed` / `linked` |
| linked | deadline / SIGTERM / a later error | linked | nothing deleted |

### 7.2 The original watch
| State | Event | Next | Side effects |
|---|---|---|---|
| watching | daily: 200 (or at the switch, for an override) | returned | `rebuild-original-returned` |
| returned | daily: 404 | watching | `returned` resolved |
| watching | daily: 404 and in the recoverable list | watching | `rebuild-original-recoverable` |
| watching | ≥ 30 days, 404, not recoverable | done | resolved |
| any | the check fails | unchanged | `rebuild-watch-check-failed` |

## 8. Failure modes
| # | Failure | Behaviour |
|---|---|---|
| F1 | Wrong key or org | The positive control fails → unproven; nothing created. |
| F2 | Brief outage | 200 → refused; after 4 hours, the override (evidence-based). |
| F3 | The original returns after a switch | `rebuild-original-returned`; the founder and customer decide; nothing merged. |
| F4 | The task dies after creating a project | The intent/created row → the leftover finding; resolved by 404. |
| F5 | A concurrent change to the row | 0 rows → cleanup. |
| F6 | The app ahead of the backup's schema | The email says to deploy now; runbook A.4 deploys right away. |
| F7 | A forged or tampered backup | Context, SHA, sidecar and counts → the next older candidate. |
| F8 | Double press / cancel | The button's running-task check; in-task oldest-wins; the `cancelled()` step stops the task. |
| F9 | A commit acknowledgement lost | The re-read before any delete keeps the live project. |
| F10 | The Viewer can't see others' recoverable projects | The rehearsal's canary check fails → `disaster-rehearse-failed`; fall back to Editor (Q1). |
| F11 | A leaked disaster key | Q1's stated residual; A.7 lowers it on rebuilt projects. |
| F12 | The Neon project limit, 429, 423 | Backoff, then `create` with Neon's status and code in the email. |
| F13 | GitHub down | The CloudShell fallback (Q2); the start is emailed. |
| F14 | Public-log leakage | Inputs from the event file, masked; ids only; quiet AWS output (D2, D7). |
| F15 | Image older than the button | Unknown flag → exit 2 → "approve the pending Backup system deploy". |
| F16 | A key that stopped working | The monthly rehearsal fails → `disaster-rehearse-failed`, long before a disaster. |

## 9. Platform limits
- **Task deadline** 330 minutes; the button waits up to 340, inside the 360-minute job and the 6-hour credentials.
- **`all-lost`** at concurrency 2: about 30 small restores an hour.
- **Neon:** 700 requests/minute, 40/s per route (backoff on 429); the plan's project limit.

## 10. Blast radius
| File | Change |
|---|---|
| `scripts/backup/disaster.ts`, `scripts/backup/lib/neon-api.ts` | **new** (key-required Neon calls with `org_id`: create, get, list with pagination and `unavailable_project_ids`, the recoverable list, delete-own, endpoints, find by name) |
| `scripts/backup/main.ts` | `disaster` (refused outside ECS; unknown flags exit 2) |
| `scripts/backup/disaster-button.sh`, `.github/workflows/disaster-restore.yml` | **new** |
| `Dockerfile.backup`, `scripts/backup/deploy-paths.txt` | `db-name.ts`, `lifecycle-config.ts` |
| `ops/aws/backup-stack.yml`, `scripts/backup/lib/expected-policies.ts` | the task, roles, log group, monthly schedule, the two start rules, the SSM events, the exemptions, `ALL_ROLES`, `rulePatterns`, `InspectRules` |
| migration + `src/db/control-plane/schema.ts` | `disaster_runs`, `disaster_actions` |
| `src/lib/tenant/backup-status.ts`, `ops-digest.ts` | §6.8 |
| `src/lib/tenant/admin-commands.ts` | `resolve-alert` refuses `rebuild-*`/`disaster-*` |
| `scripts/backup/lib/summarize-error.ts` | Neon proxy wording → `connection-refused` (§6.4.1) |
| `src/lib/tenant/delete-tenant.ts`, `scripts/delete-tenant.ts` | the refusal, checked **inside step 3's tenant lock**; and inside that lock, require `db_url_encrypted` and `neon_project_id` to equal step 1's values. A switch between classification and deletion then refuses instead of deleting the old original and orphaning the rebuilt project. |
| `scripts/migrate-all.ts`, `scripts/lib/migrate-all-run.ts`, `scripts/lib/tenant-migration.ts` (the skip hook in `migrateOneTenant`'s catch), `.github/workflows/deploy-prod.yml` | `--skip-lost`, the step 0 exclusion, `reachable-again`, the input, the pins |
| `RESTORE.md`, `PRODUCTION-DEPLOY.md` (Phase 13b; 5.5 says Organization key; the Vercel env `CONTROL_PLANE_PROJECT_ID`), `FOUNDER-ACCOUNTS-SETUP.md`, `.env.example` | runbook A, template A, the CloudShell command, the setup |
| Tests | §11; `backup-static` (U6) extended |

## 11. Required tests (each must fail without the change it proves)
**Without Neon or AWS:** a **fake Neon API** (a local HTTP server in the test) whose `POST /projects` creates a local database (`bkt_dr_*`). It scripts:
- statuses (404, 403, 5xx, 423, 429);
- the recoverable list, including the canary;
- the personal-key behaviour (an empty list without `org_id`);
- `unavailable_project_ids`;
- pagination;
- lost create responses;
- endpoints.

Plus 3b's fakes (S3, KMS, SNS, a `LogReader`), a fake ECS list, a scratch control plane, and the in-process `parseNeonHost` override (with a test that the real guard refuses local URLs).

**Unit:**
- **D1:** `classifyEndpoint`'s table with a local server answering the startup with `28P01` and with each proxy error; **an endpoints lookup failure or a partial list → unproven**; **a rebuilt-named project (`cadenzpoint-r-…`) serving the endpoint → served**; **the override: any `28P01` → refused**, and a URL host not among the project's endpoints → `url-project-mismatch`; and the proof table (including (d): a 404 project whose tenant URL still **logs in** → `reachable`; a `28P01` with no live project serving the endpoint → doesn't answer (gone); a `28P01` where a `cadenzpoint-<slug>` project serves it → `reachable`; the control falls back to the control plane's project or a live workspace's when the restore-test project is gone):
  - gone;
  - recoverable;
  - unproven: the control fails, no `org_id` (an empty list), a partial list, 401/403/5xx;
  - 200 with and without the override;
  - the override's evidence rules: an earlier observation 4–48 h ago; 3b failures with connection labels at least 4 h old and no `ok` since; an auth error → reachable.
- **D2:** `disaster-button.sh`, run **as GitHub runs it** (through a `bash -e` wrapper; the script is written for bash 3.2 as well as 5, and D2 runs under both where available), with a stub `aws` and an event file:
  - validation: ids, the strict uuid, `all-lost`, `rehearse` rules, override rules, confirm, a leading `-`;
  - **no target text anywhere in the output**;
  - the running-task refusal;
  - `--stop` stops the run's tasks;
  - the describe loop survives a failed call;
  - a null exit code and exit 2 messages;
  - `parseDisasterArgs` grammar (`auto` and `canary` only with `rehearse`; a generated run id).
- **D3:** backup candidates: rows plus log-verified objects; the current `cp`; **integrity failures** fall back up to 3, each with a fresh project; **infrastructure failures** retry the same candidate once, then `retryable` with no switch.
- **D4:** the switch SQL: byte equality, the deletion clause, the `lifecycle_version` bump, the lock string.
- **D5:** `--skip-lost`:
  - proven and unreachable → skipped (including a `deletion-due` proof);
  - proven and reachable → migrated;
  - unproven and unreachable → fails;
  - linked since → not skipped;
  - a proof of any age → skipped (no expiry);
  - **no slug on a skipped row** (uuid only);
  - a skipped tenant reconnecting in the pass → FAILED, exit 1, with `reachable-again` written;
  - **the flag reaches argv** through `npm run db:migrate:all -- --skip-lost`;
  - a 3b `ok` row finished after the proof → not skipped;
  - reachable, then `migrate()` fails → FAILED (the skip applies only when `pendingCount` throws);
  - step 0 excludes skipped tenants;
  - the `deploy-prod.yml` boolean (`false` never passes the flag).
- **D6:** §6.8 (also: `rebuild-original-recoverable`, including its suppression after `returned`; `rebuild-watch-check-failed`): leftover resolved by 404 with `gone-confirmed` appended; stuck at 6 h; rehearsal failed and its 40-day anchor; the watch's 30-day minimum and the override variant; not in `FINDING_KINDS`; excluded from monitoring off; the digest line.
- **D7:** U6 additions:
  - the roles' trusts and grants; the button role's `MaxSessionDuration` ≥ the workflow's `role-duration-seconds`; every new resource name and ARN matches a `CfnExecRole` pattern in `bootstrap.yml`; the Scheduler role's PassRole covers every role its schedules use; the schedule's command is `rehearse` and parses through the real argv parser;
  - the ECS resource types (`ListTasks` `*` plus `ecs:cluster`);
  - PassRole;
  - no SSM write by the task role;
  - the monthly schedule;
  - the exemptions;
  - the two start rules;
  - the protections pattern without `requestParameters`;
  - the workflow: environment; `id-token`; `inputs.` only under `on:`; the `cancelled()` step; `exec`; `queue: max`; SHA pins; the gate;
  - `deploy-prod.yml`'s pins.

**Integration** (fake Neon, scratch control plane, real pg 16 tools):
- **R1:** `workspace` end to end:
  - exact counts; the row switched;
  - the audit, `linked`, the watch and the `LINKED` line recorded;
  - the old database untouched; no migrations run;
  - the email has the backup time and the A.7 line.
- **R2:** every §7.1 failure row leaves the row unchanged, with the task deleting what it created (404 in the fake); a failed delete → `failed` and the leftover finding.
- **R3:** `changed-meanwhile`.
- **R4:** `all-lost` picks exactly the gone tenants (never via the override); a tenant whose project 404s but whose URL still connects is **not** picked.
- **R5b:** `workspace` started by the schedule (startedBy not `gh-`/`cloudshell-`) → refused; `rehearse` from the schedule → runs.
- **R5:** the override: (also) **a rebuilt workspace that then flaps:** evidence from before its `linked` row is ignored; **observed, then reachable (a 3b `ok`), then unreachable:** the old observation is ignored; no other workspace reachable → `network-unproven`. And: a first press records `observed-unreachable` and refuses; a press 4+ hours later (fake clock) proceeds; with 3b failure rows, a first press proceeds; an auth error with the endpoint still served → refused; Neon's proxy messages labelled `connection-refused` count as evidence.
- **R6:** `rehearse` (also: **a rehearsal that fails mid-restore still deletes its project**; the deleted endpoint classified "doesn't answer"):
  - no switch; the project deleted;
  - the recoverable-list and canary checks;
  - the SQLSTATE recorded;
  - the row unchanged;
  - `auto` picks a workspace with a recent `ok`.
- **R7:** `migrate-all --skip-lost` and `--check` against real databases; **every non-check run writes `reachable-again`**, after which the override evidence ignores the older observation; the deletion-due proof is skipped; a missing `disaster_actions` table → no proofs, no failure.
- **R8:** `tenant:delete` refuses while a returned or leftover alert names the tenant, and proceeds after the 404; **a switch committed between its steps 2 and 3 → refused**.
- **R9:** concurrency and termination:
  - a second run exits (the lock and oldest-wins);
  - SIGTERM mid-restore → cleanup;
  - **SIGTERM right after the commit → not deleted**;
  - **a dropped commit acknowledgement → the re-read keeps it**;
  - **a switch paused before COMMIT (seam), then SIGTERM → cleanup blocks on the tenant lock and keeps the project once the commit lands**;
  - a lock timeout in cleanup → `failed`, nothing deleted.

## 12. Founder steps and rehearsal (`PRODUCTION-DEPLOY.md` Phase 13b additions, in order)
1. **GitHub:** create `aws-disaster` (required reviewer you, Prevent self-review off, admin bypass off, `main` only). Verify with the two `curl` commands.
2. **Neon (Q1):**
   - add the alias `neon-ops@cadenzpoint.com`;
   - invite it as **Viewer**; sign in once (security key); create its personal key.
3. **AWS Parameter Store:** `/cadenzpoint/backup/neon-api-key`, `/cadenzpoint/backup/neon-org-id`, `/cadenzpoint/backup/restore-test-project-id`, `/cadenzpoint/backup/control-plane-project-id` (all SecureString).
4. **Push early** once the CI and Dockerfile commit exists (§4 of the standard). Merge; deploy-prod; approve the backup-system deploy. Copy `DisasterButtonRoleArn` into the `aws-disaster` secret.
5. **A rehearsal workspace in production** (before launch there may be none with backups): `npm run provision:tenant` a workspace `rehearsal`, `tenant:admin set-exempt rehearsal --yes`, and wait for its first `ok` backup. It stays as the rehearsals' target.
6. **Canary, then rehearse, the same day:** with your own Neon account, create a project `cadenzpoint-recoverable-canary` and delete it. Then Actions → **Disaster restore** → `rehearse`, the `rehearsal` workspace's id, override `canary`, confirm `rehearse` → approve.
   - **Expect:**
     - the start email;
     - "rehearsal passed": the proof against the live original, the canary seen, the project deleted and visible as recoverable;
     - no change to the workspace.
   - **If the canary isn't seen:** switch `neon-ops@` to Editor and rehearse again (Q1's fallback).
7. **From then on,** the monthly schedule rehearses automatically; a failure appears in the digest.

## 13. Verification
1. `npx tsc --noEmit`, lint, `npm run test`, `npm run test:tz`, `npm run db:safety`, integration (the memory command plus the pg 16 tools).
2. **§3.7:** every changed `run:` block run verbatim with stubs; the exact-COPY build check; **the early push**.
3. **The lead's checks file** (local): `disaster-button.sh` through a `bash -e` wrapper (validation, silence, `--stop`); `migrate-all --skip-lost` on a scratch control plane; the digest's disaster line; the `tenant:delete` refusal.
4. **Real AWS and Neon:** §12 step 6 with the founder, then the first monthly run.

## 14. Hand-off rules
As 3b §14, plus `BLUEPRINT-STANDARD.md` §3.7 and the early CI push.

## 15. Pre-mortem log
**Round 1** (on v1): 3 HIGH, 17 MEDIUM. Fixed in v2 by simplifying (no migrations in the button; ids not slugs; control-plane mode repoints nothing) plus a strict re-tombstone, a reconcile mode and more.

**Round 2** (two fresh reviewers on v2): **0 HIGH, 7 + 12 MEDIUM** (overlapping). Most of the MEDIUMs were in control-plane mode, the reconcile, and disasters following disasters. Following the 3b lesson, the lead proposed a split; **the product owner accepted (2026-11-17): 3c-2 takes the control plane** (brief in the tracker), and accepted a 4-hour outage override. Fixed in v3 for the workspace button:
- **the cancel stop** (an `if: cancelled()` step, `--started-by`, `exec`, INT/TERM traps);
- **every start emailed** (the ECS task-state rule, plus RunTask by family or ARN);
- **ECS resource types** in IAM;
- **a positive control** that works with everything lost (the restore-test project id); the rehearsal runs the full proof;
- **runbook A.7 lowers `neon-ops` to Viewer** on rebuilt projects; Q1 restated (customer-list exposure, project creation);
- **SSM events by name only**, and the new rules in drift;
- **the undo of re-tombstones** removed with the reconcile (3c-2);
- **`linked` is terminal,** and every delete is preceded by a re-read (lost acknowledgements);
- **`--skip-lost`** reads the button's own `proof` rows, so no reconcile is needed; step 0 excludes skipped tenants;
- **the `LINKED` log line** for 3c-2;
- **the canary** proves the Viewer's recoverable list sees others' projects;
- **the outage override** (accepted);
- **LOWs:**
  - quiet `stop-task`; a strict uuid regex re-validated in the task;
  - the null exit code; version skew (exit 2);
  - Describe/Stop scope stated;
  - ids only in logs;
  - deploy right away, before the customer email;
  - names within 40 characters, unique per try;
  - the watch kinds outside `FINDING_KINDS`;
  - `gone-confirmed` stops re-checks;
  - `db-name`/`lifecycle-config` in the image;
  - the tie-break by ARN;
  - **the monthly automatic rehearsal** (key validity).

**Confirmation pass 1** (one fresh reviewer on v3): **5 MEDIUM, 11 LOW; no HIGH.** Fixed in v3.1:
- **cleanup waits for an in-flight commit** (a locked re-read; never delete on a lock timeout or error);
- **an override's original** gets "returned" at the switch, resolved on 404 alone, and `tenant:delete` refuses while it's open, so no copy outlives a deletion; a new `rebuild-original-recoverable` finding;
- **IAM and CloudFormation:** `MaxSessionDuration` 21600; the schedule name fits `CfnExecRole`; the Scheduler role's PassRole;
- **a deletion-due lost workspace** gets its proof recorded, so deploys skip it;
- **the canary** is created the same day as a first rehearsal, which fails without it; monthly rehearsals rely on the recoverable-original finding.
- **LOWs:**
  - one argv grammar, with a generated run id;
  - `workspace` refused unless started by `gh-`/`cloudshell-`;
  - plain-`SELECT` guards in rehearse;
  - start and finish emails;
  - stale §4.4 removed, with example and step references fixed;
  - `--skip-lost` defined (any connection error; no 7-day expiry; tenant ids; the `--`);
  - named labels and a 26 h window for the override evidence;
  - one control and one list for `all-lost`;
  - a 3-minute lock wait, `--stop` retries, 423 retries on delete;
  - monitoring wording;
  - the rehearse proof status `rehearse-ok`.

**Confirmation pass 2** (one fresh reviewer on v3.1): **3 MEDIUM (one stale text), 9 LOW; no HIGH.** Fixed in v3.2:
- **only integrity failures fall back to an older backup;** infrastructure failures retry the same one, then stop without switching (`retryable`);
- **override evidence is tied to the current original** (the same `old_project_id`, newer than the latest `linked`, no `ok` or `reachable-again` since), and **the task's network must be proven** by another workspace connecting;
- **D5 matches §6.0** (no 7-day expiry).
- **LOWs:**
  - a 3b `ok` cancels a skip proof, and every `migrate-all` writes `reachable-again`;
  - the skip applies only when `pendingCount` throws;
  - the enums are completed, and result statuses moved to the summary;
  - `override canary` naming;
  - the recoverable-original alert is suppressed after a founder deletion, with first-seen + 7 days;
  - **`tenant:delete` compares the URL and project id inside its lock** (a switch race);
  - `tenant_id` in the orphan alert;
  - the locked re-read is retried;
  - the recoverable list is polled;
  - the runbook note on 3b alerts for unrebuilt workspaces.

**Confirmation pass 3** (one fresh reviewer on v3.2): **3 MEDIUM, 11 LOW; no HIGH.** Fixed in v3.3:
- **"gone" also requires the tenant's own URL not to answer** (a stale project id can't trigger a switch);
- **skips print uuids, not slugs** (public deploy logs);
- **the positive control falls back** to the control plane's project or a live workspace's (a new SSM parameter, `control-plane-project-id`).
- **LOWs:**
  - the missing-table tolerance on the merge deploy;
  - only decisive proofs supersede, and `observed-unreachable` is skippable;
  - the network check before any unreachable result is used or recorded;
  - the deletion-due proof keeps its real status, and `auto` skips ineligible workspaces;
  - unclassified restore failures stop without fallback;
  - a reconnecting skipped tenant isn't migrated without the lock;
  - the app's organisation key stated;
  - test additions; blast-radius items (`tenant-migration.ts`, CASCADE, the container name, exit 2, the alert detail, ON CONFLICT, the history setting);
  - cleanup wording within the stop window, and invariant 5 reworded;
  - canary wording.
- **Noted for the product owner (pre-existing, outside 3c):** deploy-prod's public log prints every workspace slug.

**Confirmation pass 4** (one fresh reviewer on v3.3): **1 HIGH, 0 MEDIUM, 10 LOW.** Fixed in v3.4:
- **HIGH: Neon's proxy answers unknown or deleted endpoints with `28P01`** (verified live), so "an auth error means reachable" would never prove a workspace gone, and would block deploys. Now:
  - only a **successful login** counts as "answers";
  - the stale-id defence checks via the API whether a live `cadenzpoint-<slug>` project serves the endpoint;
  - proxy errors are classified (`classifyEndpoint`, §6.4.1), and 3b's labels learn Neon's proxy wording;
  - a local test server answers `28P01`, as Neon does;
  - the rehearsal classifies its own deleted endpoint, and the canary rehearsal also checks `GET` → 404 for another member's deleted project.
- **LOWs:**
  - `resolve-alert` refuses `rebuild-*`/`disaster-*` (the watch can't be ended by hand);
  - the leftover check heals a landed commit to `linked`;
  - proof (c) polls the list, and the recoverable-original text says recovery won't switch back;
  - the Organization-key wording, with personal-key detection (`CONTROL_PLANE_PROJECT_ID` in Vercel);
  - run ids include the attempt;
  - `bash` invocation (no executable bit needed);
  - stale §4.1 text and §7.1 rows, and the D5 bullets;
  - the rehearsal-failed resolution;
  - the operation `failed`-with-`retry_at` rule;
  - the switch's lock retries;
  - the button after its 340-minute wait;
  - the failed-rehearsal cleanup test.
- **The 3c-2 brief in the tracker is updated** (no "auth error = reachable").

**Confirmation pass 5** (one fresh reviewer on v3.4): **1 MEDIUM, 7 LOW; no HIGH.** Fixed in v3.5:
- **MEDIUM: on the override path, a password error on a rebuilt workspace was classed "doesn't answer".** The override now refuses on any `28P01`, and checks that the URL's host is the project's endpoint.
- **LOWs:**
  - the candidates include `cadenzpoint-r-<id8>-` rebuilds, and any endpoints-lookup failure → unproven; "don't rename" in the runbook;
  - the rehearsal's deleted-endpoint check retries for 5 minutes;
  - a re-check right before an override switch;
  - a reconnecting skipped tenant fails the deploy (exit 1);
  - `auto` with none eligible fails, and a production `rehearsal` workspace is added to setup;
  - §7.1 rows for proof (d) and the override;
  - the container name `disaster`;
  - §4.1 numbering;
  - a `SWITCHING` line before the commit, for 3c-2.
