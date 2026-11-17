# Disaster restore button (build queue 3c)

> **Status:** **DRAFT v1**, 2026-11-17, lead architect. Not yet reviewed.
>
> **Branch:** `disaster-restore-button`, from `main` at `8af3b2c`, after 3b (PR #33).
>
> **Source:**
> - `BUSINESS-DECISIONS.md` §5, "Disaster restore button (Q4): requirements for engineering item 3c":
>   - only the founder can press it, through a protected GitHub environment with their approval and hardware-key login;
>   - it runs in AWS;
>   - it rebuilds the workspace from its newest backup into a **new** Neon database, checks it the same way as the restore test, then switches the workspace over;
>   - the original database is kept, never deleted automatically;
>   - it reports the time of the backup used;
>   - the LB-D6 exception is limited to this button, and every use is logged.
> - §5 founder constraints: nothing manual (a person presses a button only in a disaster); no customer data on the founder's machines; it scales.
> - **The 3c scope, accepted 2026-11-17** (`LAUNCH-TRACKER.md` decisions log, Q1–Q5):
>   - two modes, "workspace" and "control plane", with the whole-account loss handled as a runbook using both;
>   - the founder repoints Vercel, GitHub and AWS and pauses/resumes crons by hand after a control-plane rebuild;
>   - after a whole-account loss, the founder creates a new Neon account and pastes its key;
>   - workspaces deleted in the lost window are re-marked deleted automatically, and those created in it are handled in Stripe from a checklist;
>   - the founder emails customers from a template.
> - The 3c brief in `LAUNCH-TRACKER.md` (lead handoff notes) and 3b v3.2's rebuild design (`95d8bfe` §6.10).
> - 3b as merged (`feature-plan-database-backups.md` FINAL v5.8; `scripts/backup/**`; `ops/aws/*.yml`).
>
> **Standard:** `BLUEPRINT-STANDARD.md`, including §2's CI/Docker rule and §3.7 (every CI step run verbatim; the Dockerfile built from an exact-COPY folder; early CI push).

## 1. Goal and scope
A founder-only **button** (a GitHub Actions workflow behind the `aws-disaster` environment) that starts a **disaster task** in the backup AWS account. All data moves only between AWS us-east-1 and Neon us-east-1.

1. **Mode `workspace`** (one slug, several, or `all-lost`): for each workspace whose Neon project is **proven gone**:
   - pick its newest verified backup;
   - create a **new** Neon project, restore into it, check every row count, migrate it to the current schema;
   - switch the workspace's control-plane row to it (the LB-D6 exception, audited);
   - start a watch on the original;
   - email the founder the backup time and the hours to re-enter.
2. **Mode `control-plane`:** restore the newest verified control-plane backup into a **new** Neon project, migrate it, then reconcile the window since that backup automatically:
   - re-mark deleted any workspace whose deletion happened in the window (proven from Neon's record of deleted projects), or whose deletion date had passed;
   - list workspaces whose project is lost (for mode `workspace`);
   - list Neon projects no row knows about (created in the window);
   - write the new URL where the founder copies it from, and repoint the backup tasks.
3. **Mode `rehearse`:** everything in mode `workspace` except the switch, for one workspace, on any environment. The new project is deleted at the end. This proves the pipeline without touching live state (§12).
4. **The original-database watch** (in the daily digest): if an original comes back, the founder is told; the watch ends on its own once the original is deleted.
5. **The runbooks** in `RESTORE.md`, "Disaster": A (a workspace lost), B (the control plane lost), C (the whole Neon account lost). Each includes the founder's checklist (repointing, crons, Stripe, the customer email template).

**Out of scope:**
- automatic switch-over on a detected outage (§5: the button);
- merging data from a returned original (§5: the founder decides, the customer re-enters);
- 3d (exports);
- recovering a project Neon still has in its 7-day recovery window: the button refuses and points to Neon's own recovery, which loses nothing (§6.4 step 2).

## 2. Questions for the product owner, and founder duties
The scope was accepted 2026-11-17 (Q1–Q5). **One new question, because it's a founder setup step:**

| # | Question | Recommendation | Section |
|---|---|---|---|
| Q1 | **Which Neon API key the disaster task holds.** It must create projects. Neon has no key that can create but not delete: an organisation key can delete **every** project, customers' included (§4.1.4). | **A dedicated Neon team member with the "Editor" role**, whose personal API key goes into AWS. An Editor can create projects and delete only the ones it created (the rehearsal's), never a customer's existing project. **Setup:** add the alias `neon-ops@cadenzpoint.com`, invite it to the Neon organisation as Editor, sign in once to create its key, and paste the key into AWS. About 10 minutes. The alternative is an organisation key: simpler, but a compromised disaster task could then delete every workspace's database. | §6.2, §12 |

**Design choices stated for the record** (engineering's call within §5):
- **The button refuses while Neon can still recover the original.** Recovery in the Neon console keeps everything, with no lost hours. The runbook says to recover there first.
- **No customer-identifying text in public logs.** The repo is public, so the GitHub run shows only counts, the run id and success or failure. Slugs, backup times and the hours to re-enter go to the founder's email (the AWS alert topic) and into the control plane (`disaster_actions`, shown in the digest).
- **Mode `rehearse`** exists so the pipeline can be proven at staging without destroying anything.

**One-time founder setup** (added to `PRODUCTION-DEPLOY.md` Phase 13b; every click is in `FOUNDER-ACCOUNTS-SETUP.md`):
1. **GitHub:** create the `aws-disaster` environment (you as required reviewer, `main` only, admin bypass off), verified by `curl`, plus one secret, `AWS_DISASTER_ROLE_ARN`, from the stack outputs.
2. **AWS:** paste the Neon API key into Parameter Store as `/cadenzpoint/backup/neon-api-key`.
3. **The rehearsal** (§12) with the lead.

**Founder duties in a disaster** (accepted Q2, Q3, Q5): press the button and approve it; for a control-plane loss, follow the checklist; email customers from the template.

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
- **The deploy path:** `deploy-prod.yml` runs `db:migrate:all`, then `db:migrate:check`, then `vercel pull`/`build`/`deploy --prebuilt` (`:30-51`). `scripts/migrate-all.ts` parses `--check`, `--concurrency` and `--tenant` (`:56-66`).
- **Repo visibility:** public, so Actions logs and summaries are readable by anyone logged in (§4.2.3).

## 4. External behaviour (verified from source; fetched 2026-11-17)
### 4.1 Neon API v2
1. **Create project:** `POST /projects` → 201 with `project.id`, `connection_uris[]` (`connection_uri` is the direct host; `connection_parameters.pooler_host`) and `operations`. A personal key must pass `org_id`; an organisation key infers it. Poll each operation (`GET /projects/{id}/operations/{op}`) every 5 s until `finished`/`skipped`; `failed`/`error`/`cancelled` are terminal; `423 Locked` means retry with backoff (neon.com/docs/reference/api/projects/create-project, …/manage/operations).
2. **Get project:** only the 200 response is documented. **The status for a deleted project, or for no access, is not documented.** So this design treats only "404 + positive control + not recoverable" as gone, and anything else as unproven (…/projects/get-project).
3. **Deleted projects:**
   - `GET /projects?recoverable=true` lists deleted projects still in the 7-day window;
   - `POST /projects/{id}/recover` (beta) restores one, with its connection strings. The examples keep the id;
   - recovery needs organisation Admin or project Admin (…/recover-project, …/list-projects, …/manage/projects).
4. **Key types** (…/manage/api-keys, …/manage/user-permissions):
   - **organisation:** admin-level, can create and delete;
   - **project-scoped:** can't create projects;
   - **personal:** the user's role. An organisation **Editor** may do "everything except deleting projects…", but becomes Admin of projects it creates (so it can delete its own) (Q1).
5. **Rate limits:** 700 requests/minute, 40/s burst per route; 429 beyond (…/api/key-concepts).
6. **Restore:** with `--no-owner`, the restoring Neon role owns everything. `neon_superuser` isn't a Postgres superuser. Event triggers are allowed for `neon_superuser`. Use unpooled connections (…/import/migrate-from-postgres). 3b already restores this way.

### 4.2 GitHub Actions
1. **`workflow_dispatch` inputs:** `boolean`/`choice`/`number`/`environment`/`string`; at most 25. Use them in scripts **through `env:`**, not `${{ }}` inside `run:` (…/workflow-syntax, …/security/secure-use). The workflow must be on the default branch.
2. **Required reviewers:** one approval suffices; pending approvals fail after 30 days; environment secrets are unavailable until approved; on free plans this works only in public repos. **Not documented: whether the approver sees the inputs**, hence the `confirm` input (…/review-deployments, …/limits).
3. **Public repos:** run pages and logs are readable by any logged-in user. Summaries mask secrets only, so **nothing about workspaces is printed** (…/using-workflow-run-logs).

### 4.3 AWS
1. **RunTask:**
   - overrides allow `command` and `environment`, 8,192 characters in total; no secrets override;
   - IAM restricts the task definition by `Resource` and the cluster by `ecs:cluster`. **No condition can restrict command overrides**, so anyone allowed to run the disaster family can run it with any command; the role is reachable only through the approved environment;
   - `iam:PassRole` with `iam:PassedToService = ecs-tasks.amazonaws.com` (…/API_RunTask.html, service authorisation reference).
2. **DescribeTasks:** `lastStatus`, `stopCode`, `containers[].exitCode`; stopped tasks stay visible at least an hour (…/API_DescribeTasks.html).
3. **FilterLogEvents:** searches all streams of a group; paginate until there's no `nextToken`; a quoted phrase pattern (`"BACKUP <cp> control-plane"`) is case-sensitive and matches anywhere, so the code re-parses each line exactly; 25 TPS in us-east-1 (…/API_FilterLogEvents.html, …/FilterAndPatternSyntax.html).

### 4.4 Vercel
1. **Environment changes apply only to new deployments.** A redeploy of a `vercel deploy --prebuilt` deployment "reuses its prebuilt output and doesn't rebuild from source". So after changing `CONTROL_PLANE_DATABASE_URL`, a **new CI deploy** is needed (§6.0) (vercel.com/docs/environment-variables, …/cli/redeploy).
2. **Crons:** the project's Cron Jobs page has a **Disable Cron Jobs** button that persists across deployments until re-enabled. There's no documented API (vercel.com/docs/cron-jobs/manage-cron-jobs).

## 5. Invariants that must not break
1. **The original database is never deleted, overwritten or written** by anything in this item.
2. **A workspace is switched only when its original is proven gone:**
   - a 404 for its project id;
   - a **positive control**: the same API key returns 200 for a project known to exist;
   - not in Neon's recoverable list.

   And never while Neon can still recover it.
3. **A switch is atomic and checked** under the tenant lock: the row's current URL and project id must still be the ones read at the start (byte equality).
4. **Only verified backups are restored:**
   - the encryption context binds the object to its workspace;
   - the ciphertext SHA-256 equals the control-plane row's, or, in mode `control-plane`, the backup task's own `BACKUP` log line;
   - the sidecar matches;
   - every count matches.
5. **Every switch, re-tombstone and created project is recorded** (`disaster_actions`, `tenant_audit_events`), and every created project is tracked from the moment Neon returns its id, so a crash leaves no untracked copy.
6. **A workspace whose deletion was due is never brought back** (`deletion_scheduled_for` passed, or Neon shows its project deleted in the window).
7. **Customer data stays in Neon us-east-1 and AWS us-east-1.** Nothing about workspaces appears in public logs.
8. **Only the founder can start it:**
   - the `aws-disaster` environment: required reviewer, `main` only, admin bypass off;
   - the OIDC trust on that environment only;
   - the button role can start only the disaster task family.

## 6. Design

### 6.0 The disaster deploy path (`deploy-prod.yml`, `scripts/migrate-all.ts`)
After a control-plane rebuild, the app must be **redeployed** to read the new `CONTROL_PLANE_DATABASE_URL`. A dashboard Redeploy reuses the prebuilt output and doesn't apply changed environment values (§4.4). And `deploy-prod` migrates every workspace first, so lost workspaces would fail it. So:
- **`deploy-prod.yml`** gains a `workflow_dispatch` boolean input `skip_lost_workspaces` (default false), passed as `--skip-lost` to both `db:migrate:all` and `db:migrate:check`.
- **`--skip-lost`** skips exactly the tenants listed **lost** in the newest `control-plane`-mode `disaster_runs` row of the (new) control plane, finished within the last 48 hours, and not linked since (no later `linked` `disaster_actions` row). Each is printed "skipped (lost, awaiting rebuild)". Any other unreachable tenant still fails the deploy.
- **It refuses** when there's no such run ("--skip-lost needs a control-plane disaster run in the last 48 h"). So it can't be used to paper over an ordinary outage.

### 6.1 The button (`.github/workflows/disaster-restore.yml`)
```yaml
name: Disaster restore
on:
  workflow_dispatch:
    inputs:
      mode:    { type: choice, options: [workspace, control-plane, rehearse], required: true }
      targets: { type: string, required: false, description: 'workspace / rehearse: slugs, comma-separated, or all-lost' }
      confirm: { type: string, required: true, description: 'Type the mode again to confirm' }
permissions: { contents: read }
concurrency: { group: disaster-restore, cancel-in-progress: false }
jobs:
  run:
    if: github.ref == 'refs/heads/main' && vars.AWS_BACKUPS_ENABLED == 'true'
    runs-on: ubuntu-24.04
    environment: aws-disaster          # required reviewer: the founder; main only; admin bypass off
    timeout-minutes: 360
    permissions: { contents: read, id-token: write }
    steps:
      - uses: actions/checkout@<sha>
        with: { persist-credentials: false }
      - uses: aws-actions/configure-aws-credentials@<sha>
        with: { role-to-assume: '${{ secrets.AWS_DISASTER_ROLE_ARN }}', aws-region: us-east-1, role-duration-seconds: 21600, mask-aws-account-id: true }
      - run: scripts/backup/disaster-button.sh
        env:
          MODE: ${{ inputs.mode }}
          TARGETS: ${{ inputs.targets }}
          CONFIRM: ${{ inputs.confirm }}
```
**`disaster-button.sh`** (bash, AWS CLI only, no npm; `set -euo pipefail`):
1. **Validate the inputs** (they come only through env vars, never interpolated into a command):
   - `CONFIRM` must equal `MODE`;
   - `TARGETS` must match `^(all-lost|[a-z0-9-]{1,63}(,[a-z0-9-]{1,63}){0,49})$` for `workspace`/`rehearse`, and be empty for `control-plane`;
   - `rehearse` takes exactly one slug.
2. **Start the task:** `aws ecs run-task` with the cluster, the **disaster** task definition (by family; the role can only run that family), Fargate and the network configuration (read from the stack's outputs through `cloudformation describe-stacks`), and `containerOverrides` `command: ["disaster", MODE, "--targets", TARGETS, "--run-id", "gh-<run id>"]`. A `failures` array or an empty `tasks` list stops with "the task didn't start" plus the reason.
3. **Wait:** `aws ecs wait tasks-stopped`, looped (the waiter gives up after 10 minutes) until stopped or 6 hours.
4. **Report, privately:** print only "disaster task finished: exit <code>, run <run id>; details emailed and in the digest". The GitHub step exits with the task's exit code. **Nothing about workspaces is printed:** the repo and its logs are public (§4).

**Environment `aws-disaster`:** required reviewer the founder, Prevent self-review off, admin bypass off, deployment branches `main` only. It's created and verified **before** the stack outputs its role (§12). The workflow reuses `vars.AWS_BACKUPS_ENABLED`, so nothing runs before backups are set up.

### 6.2 AWS additions (`ops/aws/backup-stack.yml`)
| Resource | Notes |
|---|---|
| **`DisasterButtonRole`** (`/cadenzpoint-backup/cadenzpoint-backup-disaster-button`) | **Trust:** GitHub OIDC, `StringEquals` `aud = sts.amazonaws.com`, `sub = repo:ccentofo/bytime:environment:aws-disaster`. **Policy:** `ecs:RunTask` on `task-definition/cadenzpoint-backup-disaster:*` with `ecs:cluster` = the backup cluster; `iam:PassRole` on the disaster execution and task roles (`iam:PassedToService = ecs-tasks.amazonaws.com`); `ecs:DescribeTasks` on the cluster's tasks; `ecs:TagResource` (`ecs:CreateAction = RunTask`); `cloudformation:DescribeStacks` on the main stack. Max session 6 h. |
| **Task definition `disaster`** | The same image (`ImageUri`) with `Command ["disaster"]`; 2 vCPU / 4 GiB; `StopTimeout: 120`; its own log group (retention 90 days, longer than the backups, as a record of disaster runs); environment as §6.4. |
| **Disaster execution role** | ECR pull; logs; `ssm:GetParameters` on control-plane-url, encryption-key, neon-api-key. |
| **Disaster task role** (`…/cadenzpoint-backup-disaster-task`) | `s3:GetObject` on `BUCKET/v1/*`; `s3:ListBucket` with `s3:prefix` `v1/*`; `kms:Decrypt` (key, `purpose` condition); `logs:FilterLogEvents` on the **backup** task's log group (mode `control-plane` verifies against the `BACKUP` line); `ssm:PutParameter` on `/cadenzpoint/backup/control-plane-url` and `/cadenzpoint/disaster/new-control-plane-url` (mode `control-plane`); `sns:Publish` on the alert topic. |
| **Policy updates** | The bucket policy's GetObject deny and the key policy's Decrypt/ReEncrypt deny gain the disaster task role as the second allowed principal. 3b's `expected-policies.ts` and the drift check include it. The roles rule already alerts on `cadenzpoint-backup-*` role changes. |
| **Outputs** | `DisasterButtonRoleArn`; the cluster, subnets and security group (read by the button script). |

**SSM parameters (founder, once):** `/cadenzpoint/backup/neon-api-key`, the Editor member's personal key (Q1), and `/cadenzpoint/backup/neon-org-id`, since a personal key must name the organisation when creating a project (§4.1.1). `/cadenzpoint/disaster/new-control-plane-url` is written by the task, not created by the founder.

### 6.3 Image and deploy changes (3b's image)
- **The image gains the migrations:** `COPY drizzle/ /app/drizzle/` in the runtime stage, and the bundle imports `src/lib/tenant/migrate-tenant.ts` (drizzle's migrator reads the folder at run time).
- **The deploy list** gains `drizzle/**` and `src/lib/tenant/migrate-tenant.ts`, so a new migration requests a backup-system deploy, keeping the disaster image's migrations current. **Founder duty, flagged:** one approval click per release that carries a migration.
- **The disaster command checks the image is current** before acting (§6.4 step 3, §6.5 step 4).
- **`BLUEPRINT-STANDARD.md` §3.7 applies:** the exact-COPY build check runs the builder's commands in a temp folder holding only the copied files, and the new workflow's `run:` blocks are run verbatim (the AWS calls against a stub `aws` on `PATH`).

### 6.4 Mode `workspace` (`scripts/backup/disaster.ts`)
**Environment:** `CONTROL_PLANE_DATABASE_URL`, `ENCRYPTION_KEY`, `NEON_API_KEY` (all from SSM), `NEON_REGION_ID` (= `aws-us-east-1`, a task constant), `BACKUP_BUCKET`, `BACKUP_KMS_KEY_ARN`, `BACKUP_DECRYPT_KEY_ARNS`, `ALERT_TOPIC_ARN`, `BACKUP_PG_RESTORE_BIN`, `AWS_REGION`.

**Start:**
- take the advisory lock `DISASTER_LOCK_KEY = 728_402_205` on the control plane's direct host, through 3b's lock factory (non-recycled, with heartbeat); exit if held;
- insert a `disaster_runs` row (`running`).

**Targets:**
- given slugs → those tenants;
- `all-lost` → every tenant in `provisioning`/`active`/`suspended` with a URL whose step 2 proves it gone (checked one at a time, concurrency 4).

**Per workspace** (concurrency 2; each step must pass; any failure records `failed` with an error summary and moves on):
1. **Facts:**
   - status `active` or `suspended` (or `provisioning` with a URL);
   - `deletion_scheduled_for` is null or in the future;
   - `neon_project_id` non-null;
   - `decrypt(db_url_encrypted)` succeeds.

   Keep `oldUrlEncrypted` and `oldProjectId`.
2. **The original is proven gone:**
   - (a) `GET /projects/{oldProjectId}` → **404**;
   - (b) **positive control:** the same key returns **200** for the control plane's own Neon project (its id is found once per run by matching the control plane's direct host among the projects' endpoints, §4), proving the key and organisation are right;
   - (c) **not recoverable:** the project is absent from Neon's list of deleted, recoverable projects (§4). If it's there, refuse: "Neon can still recover this project with no data lost: recover it in the Neon console (RESTORE.md A.1)."
   - Any other status (5xx, 401, 403, timeout) refuses (`proof-failed`).
3. **The image is current:** the image's tenant migration journal must contain every migration applied to at least one other reachable live workspace (`__drizzle_migrations` hashes). Otherwise refuse: "approve the pending backup-system deploy first". If no other workspace is reachable (account loss), this check is skipped, and the summary says so.
4. **Backup:**
   - the newest `ok` `database_backups` row for the tenant whose object exists;
   - its SHA-256, context, sidecar and counts are verified during the restore (3b's `restoreObject`, plus the sidecar check).
5. **Create the new project** (`createNeonDatabase`'s request, run by the task; name `cadenzpoint-<slug>-r<yyyymmddhhmm>`; pg 16; us-east-1; the tenant's database name and history setting).
   - **The moment Neon returns the id**, insert a `disaster_actions` row: `created`, the new project id, the slug, the run.
   - Then wait for the operations (§4).
6. **Restore** into the new project's **direct** URL (the host must be a us-east-1 Neon host, via `parseNeonHost`; not the control plane's host).
   - `pg_restore --no-owner --no-acl --exit-on-error --single-transaction`;
   - require decryption complete, the SHA match, and exact counts against the row and the sidecar.
7. **Migrate:** `migrateTenantDatabase(newDirectUrl)` from `/app/drizzle`, then `getPendingMigrationCount = 0`.
8. **Guards:**
   - the new endpoint belongs to the new project and isn't the control plane's;
   - no other non-deleted tenant has this project id or this direct host;
   - any decrypt failure on another row refuses.
9. **Switch** (one control-plane transaction):
   - `SET LOCAL lock_timeout`, then `pg_advisory_xact_lock(hashtext('tenant:' || id))`, the app's own tenant lock (`locked.ts:63`; U-test pins the string);
   - `UPDATE tenants SET db_url_encrypted = encrypt(pooled), neon_project_id = new, lifecycle_version = lifecycle_version + 1 WHERE id = … AND status IN (…) AND db_url_encrypted = oldUrlEncrypted AND neon_project_id = oldProjectId`;
   - **0 rows** → refuse (`changed-meanwhile`; the new project stays tracked);
   - in the same transaction:
     - insert `tenant_audit_events` `database-rebuilt`: actor `disaster:<run id>`; detail with the old and new project, backup key, backup `started_at`, SHA-256;
     - set the `disaster_actions` row to `linked`;
     - raise the global alert `rebuild-original-watch` (dedup = old project id; detail: slug, backup time).
10. **Report:** after the run, one email to the alert topic listing, per workspace, the slug, the result, the **backup time**, and "changes made after <backup started_at> UTC need re-entering"; plus the counts. The `disaster_runs` row is set `pass`/`fail`.

**After the switch,** the app uses the new database within 60 s (the registry cache, `registry.ts:65`). A workspace whose lost database received no writes needs no further action.

### 6.5 Mode `control-plane`
1. **Take no control-plane lock** (the control plane may be gone). Concurrency is the GitHub workflow's group, and the task refuses if `/cadenzpoint/disaster/new-control-plane-url` was written less than 1 hour ago (a double press).
2. **Is the old control plane really gone?**
   - If the current `CONTROL_PLANE_DATABASE_URL` answers `SELECT 1` within 15 s on two tries 60 s apart, **refuse**: "the control plane is reachable; a rebuild would split it."
   - Otherwise continue. The rebuild itself changes nothing live until the founder repoints the app (runbook B).
3. **Backup:**
   - `<cp>` = the id of the old control plane's direct host (3b's key scheme). List `v1/<cp>/control-plane/control-plane/` and take the newest object with a sidecar.
   - Its SHA-256 must equal the `BACKUP <cp> control-plane …` line for that key in the backup task's log group (`FilterLogEvents`), which is independent of the lost control plane.
   - No line → try the next older object; none in 25 days → refuse.
4. **Create** `cadenzpoint-control-plane-r<yyyymmddhhmm>` (pg 16, us-east-1), record nothing yet (there's no control plane), restore, check counts against the sidecar, then migrate with `/app/drizzle/control-plane`.
   - **The image is current** if every control-plane migration in the restored `__drizzle_migrations` is in the image's journal. Otherwise refuse: the image predates the backup.
5. **Record:** insert into the **new** control plane:
   - a `disaster_runs` row;
   - a `disaster_actions` row for its own project (`linked`, kind `control-plane`).
6. **Reconcile the window** (in the new control plane, each tenant under the tenant lock). For each tenant in `provisioning`/`active`/`suspended`/`deleting`:
   - **`deletion_scheduled_for` in the past** → **re-tombstone**: `status = 'deleted'`, `deleted_at = deletion_scheduled_for`, `db_url_encrypted = null`; audit `retombstoned` (reason `deletion-due`).
   - **its project 404s and is in Neon's recoverable list with a deletion time after the backup's `started_at`** → re-tombstone (reason `deleted-in-window`, `deleted_at` = Neon's deletion time).
   - **its project 404s and isn't recoverable** → listed **lost** (for mode `workspace`).
   - **its project answers 200** → fine.
   - **A Neon call fails** → listed **unknown**; re-run the reconcile later (it's idempotent).
   - Neon projects named `cadenzpoint-*` that no tenant row references, and that aren't the new control plane or a `disaster_actions` project → listed **unknown projects** (created in the window; runbook B's Stripe checklist).
7. **Repoint the backups and hand over the URL:**
   - `ssm:PutParameter` `/cadenzpoint/backup/control-plane-url` = the new URL, so tomorrow's backup covers the new control plane;
   - `/cadenzpoint/disaster/new-control-plane-url` = the same, which the founder copies into Vercel and GitHub (runbook B).
8. **Email** the founder:
   - the backup time;
   - the counts of re-tombstoned, lost and unknown workspaces, and unknown projects, **with their slugs and names** (private email);
   - the runbook B checklist link.

### 6.6 Mode `rehearse`
Mode `workspace` for **one** slug, with these differences:
- **step 2 is skipped**, because the original exists;
- **step 9 doesn't switch:** it checks the guard conditions in a transaction that is rolled back;
- **then the new project is deleted** (verified by 404) and its `disaster_actions` row set `rehearsed-deleted`.

The email says "rehearsal passed" with the timings. Safe on production too: it reads the backup and writes only to the project it creates.

### 6.7 Control-plane tables (one drizzle-kit migration)
**`disaster_runs`** (set once at the end):

| column | type / note |
|---|---|
| `id` | uuid PK |
| `run_id` | varchar(80) |
| `mode` | `workspace` \| `control-plane` \| `rehearse` |
| `started_at`, `finished_at` | timestamptz (finished null while running) |
| `status` | `running` \| `pass` \| `fail` |
| `summary` | jsonb (counts, slugs, results; no error text beyond 3b's summaries) |

**`disaster_actions`** (one row per created project or re-tombstone; `status` changes are recorded by appending, not editing):

| column | type / note |
|---|---|
| `id` | uuid PK |
| `run_id` | varchar(80) |
| `tenant_id` | uuid null FK → `tenants.id` (null for the control plane's own project) |
| `kind` | `rebuild` \| `control-plane` \| `retombstone` \| `rehearse` |
| `status` | `created` \| `linked` \| `failed` \| `rehearsed-deleted` \| `retombstoned` |
| `new_project_id`, `old_project_id` | varchar null |
| `backup_key`, `backup_started_at` | null |
| `detail` | text null (summary) |
| `at` | timestamptz |

### 6.8 Monitoring (3b's `backup-status.ts` and digest)
| Finding | Condition | Alert (scope / dedup) |
|---|---|---|
| orphan project | a `disaster_actions` project whose latest status is `created` (never linked, failed or deleted) for over 6 h | `rebuild-orphan-project` (global / project id; detail: slug, created time) |
| disaster run stuck | a `disaster_runs` row `running` for over 7 h | `disaster-run-stuck` (global) |
| original watch | open `rebuild-original-watch` | (raised at the switch) |
| original returned | the watch's project id answers 200 (checked daily with the app's `NEON_API_KEY`, one call per open watch, 10 s timeout) | `rebuild-original-returned` (global / old project id): "the original came back: decide, then delete it in the Neon console (RESTORE.md A.5)" |
| watch done | the watch's project 404s **and** isn't in the recoverable list, on 2 consecutive daily checks | the watch and "returned" alerts are resolved |
| watch check failed | a Neon call fails | `rebuild-watch-check-failed` (global); resolved by the next success |

- **The digest's Backups section adds:** "Disaster runs in the last 7 days: <mode> <status> at <time> (<n> workspaces)".
- **Alert scopes:** these kinds are global, so `tenant:delete`'s tenant-scoped resolution doesn't touch them. 3b's "monitoring off resolves every backup kind" excludes `rebuild-*` (they're facts about real projects, not about monitoring).
- **`tenant:delete`:** refuses to apply while the tenant has an open `rebuild-original-returned` or a `rebuild-orphan-project` naming it. It lists them and says to delete those projects in the Neon console first.

### 6.9 Runbooks (`RESTORE.md`, "Disaster")
- **A. One workspace lost** (its Neon project unreachable):
  1. Check Neon's status page and the project in the Neon console. If Neon lists it as deleted and recoverable, **recover it there**: nothing is lost, and stop here.
  2. If it's unreachable but not deleted (an outage), wait for Neon up to the 1-business-day target. The button refuses while the project exists.
  3. If it's gone: Actions → **Disaster restore** → `workspace`, the slug, confirm → approve. Read the email.
  4. Email the customer with **template A** (the backup time; what to re-enter; that their earlier records are intact).
  5. If the original comes back later (`rebuild-original-returned`): look at it in the Neon console (no download). Tell the customer if anything there matters, then delete it in the Neon console. The watch closes itself.
- **B. The control plane lost:**
  1. In Vercel → the project → Cron Jobs → **Disable Cron Jobs** (§4.4). It stays disabled until re-enabled, across deployments.
  2. Press **Disaster restore** → `control-plane` → approve. Read the email.
  3. Copy `/cadenzpoint/disaster/new-control-plane-url` (AWS → Parameter Store, as `corey-admin`) into Vercel production's `CONTROL_PLANE_DATABASE_URL` **and** the GitHub `production` environment's secret of the same name. Then run Actions → **Deploy to Production** with `skip_lost_workspaces` ticked (§6.0). A dashboard Redeploy wouldn't apply the new value (§4.4).
  4. Check the app loads and an admin can sign in.
  5. **Stripe checklist** for each "unknown project" in the email (a workspace created in the window): find its Stripe customer by email in the Stripe dashboard. Then either recreate the workspace with the lead, or cancel and refund, and email the customer.
  6. Press **Disaster restore** → `workspace` → `all-lost` for the lost workspaces (runbook A from step 3).
  7. Re-enable the crons in Vercel. The next lifecycle run reconciles billing state from Stripe.
  8. Email affected customers (template B).
- **C. The whole Neon account lost:**
  1. Create a new Neon account (`infra@`; FOUNDER-ACCOUNTS-SETUP Part 5 style).
  2. Create an API key. Paste it into `/cadenzpoint/backup/neon-api-key` (AWS) **and** Vercel's `NEON_API_KEY`.
  3. Runbook B (every workspace will show **lost**; deletions in the window can't be seen in a new account, so only `deletion_scheduled_for` re-tombstones). Then `all-lost`.
  4. Recreate the restore-test project in the new account and update `/cadenzpoint/backup/restore-test-url`.

## 7. State machines
### 7.1 One workspace rebuild
| State | Event | Next | Side effects |
|---|---|---|---|
| start | facts fail | failed `facts` | none |
| start | project 200 | failed `original-exists` | none |
| start | 404 but the positive control fails, or another status | failed `proof-failed` | none |
| start | 404, control ok, recoverable | failed `recoverable` | none (the message points to Neon recovery) |
| proven | image behind | failed `image-behind` | none |
| proven | no verified backup | failed `no-backup` | none |
| proven | Neon create fails before an id | failed `create` | none |
| created | (id returned) | — | `disaster_actions` `created` |
| created | operations fail or time out | failed `create` | action `failed`; project kept, orphan alert after 6 h |
| created | restore, SHA, sidecar or count fails | failed `<stage>` | action `failed`; orphan alert |
| restored | migration fails | failed `migrate` | action `failed`; orphan alert |
| migrated | guards fail | failed `guard` | action `failed`; orphan alert |
| migrated | switch updates 0 rows | failed `changed-meanwhile` | action `failed`; orphan alert |
| migrated | switch commits | linked | audit, action `linked`, the watch alert |
| any | SIGTERM / deadline | failed `stopped` | action `failed` if created |

### 7.2 The original watch
| State | Event | Next | Side effects |
|---|---|---|---|
| watching | daily check: 200 | returned | `rebuild-original-returned` |
| watching | 404 and not recoverable, twice | done | watch resolved |
| watching | the check fails | watching | `rebuild-watch-check-failed` |
| returned | founder deletes it in Neon; then 404 and not recoverable twice | done | both resolved |

### 7.3 One tenant in the control-plane reconcile
In §6.5 step 6 (each row is a state, the Neon result is the event).

## 8. Failure modes
| # | Failure | Behaviour |
|---|---|---|
| F1 | A wrong API key or organisation (404 for everything) | The positive control fails → `proof-failed`; nothing created. |
| F2 | The original is only temporarily unreachable (Neon outage) | The project still answers 200 or 5xx → refused. The founder waits (runbook A.2). |
| F3 | The original returns after a switch | The digest's `rebuild-original-returned`; the founder decides; nothing merged automatically (§5). |
| F4 | The task dies after creating a project | The `created` action row shows it; the orphan alert after 6 h; the founder deletes the project in Neon. |
| F5 | A concurrent change to the tenant row (deletion, another rebuild) | The byte-equality switch updates 0 rows → refused. |
| F6 | The image's migrations are behind the app | The currency check refuses; approve the pending backup-system deploy. |
| F7 | A forged or tampered backup object | Context, SHA (row or log line), sidecar and counts: refused. |
| F8 | Double press | The workflow concurrency group plus the disaster lock (workspace) or the 1-hour marker (control plane). |
| F9 | A deleted workspace resurrected by an old control plane | `deletion_scheduled_for` and Neon's deleted list re-tombstone it; it's never rebuilt. |
| F10 | Notices sent in the lost window are sent again | The restored control plane lacks those notice rows, so the lifecycle may resend one. Accepted and stated in runbook B (crons stay off until the checklist is done). |
| F11 | Stripe events in the window | The lifecycle's daily reconcile reads Stripe after the crons resume. |
| F12 | Neon project limit reached | Create fails → `create`; the email says so. |
| F13 | GitHub approval left pending | Nothing runs; the approval expires. |
| F14 | Public-log leakage | The script prints only the exit code and run id (U6 asserts no target names are echoed). |

## 9. Platform limits
- **Fargate:** a 6-hour run deadline. Each workspace takes about the restore time plus the migrations. `all-lost` at concurrency 2: about 30 restores an hour for small workspaces.
- **Neon:** the API rate limits (§4); project creation per account; the plan's project limit (Launch 100, Scale 1,000).
- **GitHub:** a job runs up to 6 hours (`timeout-minutes: 360`), which is enough to wait.

## 10. Blast radius
| File | Change |
|---|---|
| `scripts/backup/disaster.ts`, `scripts/backup/lib/neon-api.ts` (key-required Neon calls: create, get, recoverable list, delete-own, endpoints, project list) | **new** |
| `scripts/backup/main.ts` | the `disaster` command (refused outside ECS like the others) |
| `scripts/backup/disaster-button.sh`, `.github/workflows/disaster-restore.yml` | **new** |
| `ops/aws/backup-stack.yml` | the disaster task, roles, log group, outputs; the bucket and key policy exemptions |
| `scripts/backup/lib/expected-policies.ts` | the disaster role in the expected policies; the drift check covers the new roles |
| `Dockerfile.backup` | `COPY drizzle/ /app/drizzle/` (runtime stage) |
| `scripts/backup/deploy-paths.txt` | `drizzle/**`, `src/lib/tenant/migrate-tenant.ts` |
| migration + `src/db/control-plane/schema.ts` | `disaster_runs`, `disaster_actions` |
| `src/lib/tenant/backup-status.ts`, `ops-digest.ts` | §6.8 findings, the original watch (Neon calls with the app's `NEON_API_KEY`), the digest line; `rebuild-*` excluded from the monitoring-off resolution |
| `src/lib/tenant/delete-tenant.ts`, `scripts/delete-tenant.ts` | refuse while a `rebuild-original-returned` / `rebuild-orphan-project` names the tenant |
| `scripts/migrate-all.ts`, `scripts/lib/migrate-all-run.ts`, `.github/workflows/deploy-prod.yml` | `--skip-lost` and the `skip_lost_workspaces` input (§6.0) |
| `RESTORE.md` | "Disaster" runbooks A–C and templates A/B |
| `PRODUCTION-DEPLOY.md` Phase 13b, `FOUNDER-ACCOUNTS-SETUP.md` | the `aws-disaster` environment, the Neon Editor member and key, the org id, the rehearsal |
| Tests | as §11; 3b's U6 (`backup-static`) extended |

## 11. Required tests (each must fail without the change it proves)
**Without Neon or AWS:**
- a **fake Neon API** (a local HTTP server in the test) whose `POST /projects` creates a local Postgres database (`bkt_dr_*`) and returns its URL, with scripted statuses (404, 403, 5xx, 423, 429), a scripted recoverable list, and operations;
- 3b's fakes for S3, KMS, SNS and CloudWatch Logs (a `LogReader` seam);
- a scratch control plane per suite (3b's G2 pattern).

**Unit:**
- **D1:** gone-proof: 404 + control 200 + not recoverable → gone; 404 + control 404 → `proof-failed`; 404 + recoverable → `recoverable`; 403/5xx/timeout → `proof-failed`; 200 → `original-exists`.
- **D2:** `TARGETS` validation in `disaster-button.sh` (stub `aws` on `PATH`): `all-lost`, lists, bad characters, too many, `rehearse` with two slugs, `control-plane` with targets, confirm mismatch. **No target text in the script's output.**
- **D3:** the image-currency check (journal subset rules) for both modes.
- **D4:** the switch SQL: byte-equality `WHERE`, `lifecycle_version` bump, the tenant-lock string equals `locked.ts`'s.
- **D5:** `--skip-lost` selection (newest control-plane run within 48 h, minus later `linked`), and the refusal without one.
- **D6:** §6.8 findings: orphan at 6 h, the stuck run at 7 h, watch returned/done/failed; the digest line; `rebuild-*` not resolved by monitoring off.
- **D7:** U6 additions: the disaster role's grants and trust (`environment:aws-disaster`, `StringEquals`); RunTask limited to the disaster family and cluster; the bucket and key exemptions; the workflow (environment, `id-token` at job level, inputs only through `env:`, SHA pins, the `vars.AWS_BACKUPS_ENABLED` gate); `drizzle/` copied; the deploy list.

**Integration** (fake Neon, scratch control plane, real pg 16 tools):
- **R1:** `workspace` end to end. Back up a scratch tenant, mark its project gone in the fake, run the mode:
  - a new database exists with exact counts and migrations applied;
  - the row is switched, the audit and the action are `linked`, the watch alert is open;
  - the old database is untouched;
  - the summary has the backup time.
- **R2:** every §7.1 failure row, each leaving the old row unchanged, with a `failed` action where a project was created (and the orphan finding after 6 h simulated).
- **R3:** `changed-meanwhile`: the row is changed between the proof and the switch → refused, nothing switched.
- **R4:** `all-lost` picks exactly the proven-gone tenants (one 200, one recoverable, two gone).
- **R5:** `control-plane` end to end:
  - restore into a new database; migrations;
  - the reconcile: a tenant with a past deletion date re-tombstoned; one with a project in the recoverable list deleted after the backup re-tombstoned; one 404 not recoverable listed lost; one 200 fine; one unknown project listed;
  - the SSM writes (fake);
  - **a reachable old control plane → refused**;
  - a missing log line → the next older object; none → refused.
- **R6:** `rehearse`: no switch, the new database deleted, the action `rehearsed-deleted`, the tenant row unchanged.
- **R7:** `migrate-all --skip-lost` skips exactly the listed tenant and fails on another unreachable one; `--check` likewise.
- **R8:** `tenant:delete` refuses while a `rebuild-original-returned` names the tenant.
- **R9:** the lock: a second `workspace` run exits with nothing done; SIGTERM mid-restore → the action `failed`, the new database left tracked.

## 12. Founder steps and rehearsal (`PRODUCTION-DEPLOY.md` Phase 13b additions, in order)
1. **GitHub:** create environment `aws-disaster` (required reviewer you, Prevent self-review off, admin bypass off, Selected branches `main`). Verify with the two `curl` commands, as for `aws-backups`.
2. **Neon (Q1):**
   - add the Workspace alias `neon-ops@cadenzpoint.com`;
   - in Neon, invite it to the organisation as **Editor**;
   - sign in as it once (security key), then create a personal API key;
   - in AWS Parameter Store, create `/cadenzpoint/backup/neon-api-key` (SecureString, that key) and `/cadenzpoint/backup/neon-org-id` (the organisation id from Neon's settings).
3. **Merge and deploy** this item (the backup-system deploy request; approve it after `deploy-prod`). Copy the stack output `DisasterButtonRoleArn` into the `aws-disaster` environment secret `AWS_DISASTER_ROLE_ARN`.
4. **The rehearsal, on staging and then production:** Actions → **Disaster restore** → `rehearse`, one throwaway workspace's slug, confirm `rehearse` → approve. **Expect** the email "rehearsal passed" with the backup time and timings, and in the control plane a `disaster_runs` `pass` with a `rehearsed-deleted` action. Expect no change to the workspace.
5. **The "can't" checks:**
   - starting the workflow on a branch other than `main` → the environment refuses;
   - in CloudShell, as `corey-admin`, `aws ecs run-task` with the disaster family isn't blocked for an admin (stated: an admin can always act); the button role is the only GitHub path.

## 13. Verification
1. `npx tsc --noEmit`, lint, `npm run test`, `npm run test:tz`, `npm run db:safety`, and integration (the memory command plus the pg 16 tools).
2. **`BLUEPRINT-STANDARD.md` §3.7:**
   - the new workflow's and `deploy-prod.yml`'s changed `run:` blocks run verbatim (with a stub `aws`, and `vercel` stubbed);
   - the exact-COPY build check of `Dockerfile.backup` with `drizzle/` added;
   - **the product owner pushes once as soon as the CI and Dockerfile commit exists.**
3. **The lead's checks file** (local): `disaster-button.sh` validation outputs; `migrate-all --skip-lost` against a local scratch control plane; the digest's disaster line; the `tenant:delete` refusal.
4. **Real AWS and Neon:** the rehearsal (§12 step 4), with the founder.

## 13. Verification
*(Filled after the research pass.)*

## 14. Hand-off rules
As 3b §14, plus `BLUEPRINT-STANDARD.md` §3.7, and the early CI push (the workflow and Dockerfile change).

## 15. Pre-mortem log
Not yet reviewed.
