# Disaster restore button (build queue 3c)

> **Status:** **DRAFT v2**, 2026-11-17, lead architect. Round 1 (two reviewers on v1: 3 HIGH, 17 MEDIUM) is fixed here, partly by simplifying (§15). Round 2 is next.
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
>   - the founder repoints Vercel, GitHub **and AWS**, and pauses/resumes crons, by hand after a control-plane rebuild;
>   - after a whole-account loss, the founder creates a new Neon account and pastes its key;
>   - workspaces deleted in the lost window are re-marked deleted automatically, and those created in it are handled in Stripe from a checklist;
>   - the founder emails customers from a template.
> - The 3c brief in `LAUNCH-TRACKER.md` (lead handoff notes) and 3b v3.2's rebuild design (`95d8bfe` §6.10).
> - 3b as merged (`feature-plan-database-backups.md` FINAL v5.8; `scripts/backup/**`; `ops/aws/*.yml`).
>
> **Standard:** `BLUEPRINT-STANDARD.md`, including §2's CI/Docker rule, §3.7 (CI steps run verbatim; the Dockerfile built from an exact-COPY folder) and §4's early CI push.

## 1. Goal and scope
A founder-only **button** (a GitHub Actions workflow behind the `aws-disaster` environment) that starts a **disaster task** in the backup AWS account. Data moves only between AWS us-east-1 and Neon us-east-1. Nothing identifying a customer appears in public logs.

1. **Mode `workspace`** (workspace ids, or `all-lost`): for each workspace whose Neon project is **proven gone**:
   - pick its newest backup that verifies (falling back to older ones);
   - create a **new** Neon project and restore into it, checking every count;
   - switch the workspace's control-plane row to it (the LB-D6 exception, audited);
   - start a watch on the original;
   - email the founder the backup time and the hours to re-enter.

   **It doesn't migrate.** A normal "Deploy to Production" afterwards brings the rebuilt database to the current schema (runbook step).
2. **Mode `control-plane`:** for a control plane **proven gone** (the same proof as a workspace), restore its newest verified backup into a **new** Neon project, then run the reconcile (mode 3). It writes the new URL where the founder copies it from. **It repoints nothing**: Vercel, GitHub and the backup tasks are repointed by the founder's checklist (accepted Q2).
3. **Mode `reconcile`** (idempotent; run by mode 2, and on its own), against the control plane the backups now use:
   - classify every workspace (fine / lost / re-tombstone / unknown);
   - import newer tenant backup records from the backup log;
   - list Neon projects created in the window.
4. **Mode `rehearse`:** mode 1 for one workspace without the switch. The new project is then deleted. It proves the pipeline without touching live state (§12).
5. **The original watch** (in the daily digest), for workspace originals and the control plane's: if an original comes back, the founder is told. The watch lasts at least 30 days.
6. **The disaster deploy path** (`deploy-prod` input `skip_lost_workspaces`) and the runbooks in `RESTORE.md` "Disaster": A (one workspace), B (the control plane), C (the whole Neon account), with the founder's checklists and the customer email templates.

**Out of scope:**
- automatic switch-over (§5: a button);
- merging data from a returned original (§5: the founder decides, the customer re-enters);
- 3d (exports);
- recovering a project still in Neon's 7-day recovery window: the button refuses and points to Neon's own recovery, which loses nothing.

## 2. Questions for the product owner, and founder duties
The scope was accepted 2026-11-17 (Q1–Q5). **Three new questions:**

| # | Question | Recommendation | Section |
|---|---|---|---|
| Q1 | **Which Neon API key the disaster task holds.** It must create projects and list every project. Neon has no create-only key: an **organisation key** can delete every project, customers' included, and an organisation **Editor** can't delete projects but *can* drop any project's databases, branches and history (§4.1.4). | **A dedicated Neon team member with the "Viewer" role.** Its personal API key goes into AWS. A Viewer can create its own projects (and is Admin of those) and read every project's metadata, but can't read other projects' connection strings or change them. **The honest residual:** it's Admin of every project it creates, so after a real disaster it could delete the **rebuilt** live projects. Runbook step: after a disaster, transfer those projects' Admin to your own account. **Setup:** add the alias `neon-ops@cadenzpoint.com`, invite it as Viewer, sign in once to make its key, and paste the key and the organisation id into AWS (about 10 minutes). The rehearsal proves a Viewer can do everything needed; if Neon refuses one of the calls, the fallback is Editor, and I'll tell you. | §6.2, §12 |
| Q2 | **A customer may get one notice twice after a control-plane rebuild.** Notices sent between the last control-plane backup and the loss (up to about a day) aren't in the restored control plane. When the crons resume, a notice still due may be sent once more. Resend's 24-hour duplicate guard covers some of these (`notices.ts:39`). | **Accept**, and runbook B's customer email mentions it. Preventing it would mean storing every notice outside the control plane, for an event that may never happen. | §8 F10 |
| Q3 | **If GitHub itself is down during a disaster.** §5 names the GitHub environment as the only trigger. | **Allow a fallback:** you start the same disaster task from AWS CloudShell, signed in with your hardware key, using one command from the runbook. It runs in AWS, and it's logged and emailed like a button press (§6.2 alerting). Without it, a GitHub outage would block the 1-business-day target. | §6.9 |

**Design choices stated for the record:**
- **Refuse while Neon can recover.** Recovery in the Neon console loses nothing; the runbooks start there.
- **Workspace ids, not names, are typed into the button,** and nothing identifying is printed: the repo and its logs are public. The emails and the digest map ids to names.
- **No migrations inside the button.** The normal deploy migrates afterwards, so the image needs no migration files and adds no routine deploy approvals.

**One-time founder setup** (added to `PRODUCTION-DEPLOY.md` Phase 13b; every click in `FOUNDER-ACCOUNTS-SETUP.md`):
1. **GitHub:** create the `aws-disaster` environment (you as required reviewer, `main` only, admin bypass off), verified by `curl`, plus one environment secret, `AWS_DISASTER_ROLE_ARN`, from the stack outputs.
2. **Neon (Q1):** the Viewer member and its key.
3. **AWS Parameter Store:**
   - `/cadenzpoint/backup/neon-api-key` (that key);
   - `/cadenzpoint/backup/neon-org-id`;
   - `/cadenzpoint/backup/control-plane-project-id`: the control plane's Neon project id, from the Neon console.
4. **The rehearsal** (§12), on production. It's safe there: it never changes a live row.

**Founder duties in a disaster** (accepted Q2, Q3, Q5): press and approve; follow the checklist; run "Deploy to Production" when the email says so; email customers from the templates.

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
2. **List projects** (`GET /projects`): **a personal key must pass `org_id`**, or it lists only the member's own projects. Results are cursor-paginated, and the API may return an incomplete list with `unavailable_project_ids` when some projects are still being fetched. The design passes `org_id`, paginates to the end, and treats a non-empty `unavailable_project_ids` as "unproven" (…/reference/api/projects/list-projects).
3. **Get project:** only the 200 response is documented. **The status for a deleted project, or for no access, is not documented.** So this design treats only "404 + positive control + not recoverable" as gone, and anything else as unproven (…/projects/get-project).
4. **Deleted projects:**
   - `GET /projects?recoverable=true` lists deleted projects still in the 7-day window;
   - `POST /projects/{id}/recover` (beta) restores one, with its connection strings. The examples keep the id. **A deletion-time field is not documented**, so the design doesn't depend on one;
   - recovery needs organisation Admin or project Admin (…/recover-project, …/list-projects, …/manage/projects).
5. **Key types** (…/manage/api-keys, …/manage/user-permissions):
   - **organisation:** admin-level, can create and delete;
   - **project-scoped:** can't create projects;
   - **personal:** the user's role. An organisation **Editor** can't delete projects but can create, edit or delete any project's branches, endpoints, databases and roles, and get connection strings. A **Viewer** can create its own projects (whoever creates a project becomes its Admin) and read every project's metadata and endpoints, but can't get other projects' connection strings or change them. **Unconfirmed:** whether a Viewer may call `GET /projects?recoverable=true`; the rehearsal proves it (Q1).
6. **Rate limits:** 700 requests/minute, 40/s burst per route; 429 beyond (…/api/key-concepts).
7. **Restore:** with `--no-owner`, the restoring Neon role owns everything. `neon_superuser` isn't a Postgres superuser. Event triggers are allowed for `neon_superuser`. Use unpooled connections (…/import/migrate-from-postgres). 3b already restores this way.

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
1. **The original database is never deleted, overwritten or written** by anything in this item. That holds for workspaces and for the control plane.
2. **"Gone" needs proof, for a workspace and for the control plane alike:**
   - (a) `GET /projects/{id}` → 404;
   - (b) a **positive control**: the same key and `org_id` list the organisation's projects with no `unavailable_project_ids`, and include at least one known project (the restore-test project or a live workspace's);
   - (c) the id isn't in the recoverable list (listed with `org_id`, paginated to the end).

   Anything else is "unproven", and nothing is created.
3. **A switch is atomic and checked** under the app's tenant lock: the row's URL and project id must still be the values read at the start (byte equality), and `lifecycle_version` is bumped.
4. **Only verified backups are restored:**
   - the encryption context binds the object to its workspace and to a known control-plane id (§6.4 step 4);
   - the ciphertext SHA-256 equals the control-plane row's, or the backup task's own `BACKUP` log line;
   - the sidecar matches;
   - every count matches.
5. **Every project the task creates is tracked before it exists, and cleaned up by the task when it fails:**
   - an intent row with the unique project name comes first;
   - the task deletes its own failed or rehearsal projects (verified by 404);
   - anything left behind raises a digest alert, which resolves when the project 404s.
6. **A workspace is never brought back by mistake, and never closed by mistake.** Re-tombstoning needs all three:
   - Neon's proof that its project was deleted;
   - a row that was due for deletion;
   - no sign of a mass-deletion incident (§6.5).

   Otherwise it's listed for the founder, not changed.
7. **Customer data stays in Neon us-east-1 and AWS us-east-1.** Nothing identifying a customer appears in public logs. The founder isn't asked to view customer data.
8. **Only the founder can start it:**
   - the `aws-disaster` environment (required reviewer, `main` only, admin bypass off) and its OIDC trust;
   - the button role can only start, watch and stop the disaster task family;
   - every start, from any caller, emails the founder (§6.2).

## 6. Design

### 6.0 The disaster deploy path (`deploy-prod.yml`, `scripts/migrate-all.ts`, `scripts/lib/migrate-all-run.ts`)
After a control-plane rebuild, the app must be **redeployed** to read the new `CONTROL_PLANE_DATABASE_URL`, since a dashboard Redeploy reuses the prebuilt output (§4.4). `deploy-prod` migrates every workspace first, so lost ones would fail it. And rebuilt workspaces must be migrated afterwards. So:
- **`deploy-prod.yml`** gains a `workflow_dispatch` boolean input `skip_lost_workspaces` (default false). The step passes `--skip-lost` only when `${{ inputs.skip_lost_workspaces == true }}` (compared as a boolean in the expression, set into an env var `SKIP_LOST=true|false`, and tested as `[ "$SKIP_LOST" = true ]`). The same flag goes to `db:migrate:check`.
- **`--skip-lost`** skips a tenant only if all of these hold:
  - it's listed **lost** by the newest `reconcile` result (a `disaster_runs` row of mode `reconcile` or `control-plane`, finished within 7 days);
  - it isn't linked since;
  - it's **unreachable now**. A listed tenant that is reachable is migrated normally.

  Each skip prints "skipped (lost, awaiting rebuild)". Any other unreachable tenant still fails the deploy. Without such a run, `--skip-lost` refuses: "needs a reconcile in the last 7 days".
- **Pinning (§2's rule, since this workflow changes):** `actions/checkout` and `actions/setup-node` are pinned by SHA, and the Vercel CLI by exact version (`npm i -g vercel@<x.y.z>`).
- **The runbooks always end with a plain "Deploy to Production"** (without the skip) once rebuilds are done. That migrates the rebuilt workspaces and proves it with `db:migrate:check`.

### 6.1 The button (`.github/workflows/disaster-restore.yml`, `scripts/backup/disaster-button.sh`)
```yaml
name: Disaster restore
on:
  workflow_dispatch:
    inputs:
      mode:    { type: choice, options: [workspace, control-plane, reconcile, rehearse], required: true }
      targets: { type: string, required: false, description: 'workspace/rehearse: workspace ids (uuid), comma-separated, or all-lost' }
      confirm: { type: string, required: true, description: 'Type the mode again' }
permissions: { contents: read }
concurrency: { group: disaster-restore, cancel-in-progress: false, queue: max }
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
      - run: scripts/backup/disaster-button.sh     # reads the inputs itself; nothing passed through env:
```
**No input appears in `env:` or in any `${{ }}` of a step,** because GitHub prints step env values in public logs (§4.2.3). U-test D7 asserts `inputs.` appears nowhere in the workflow except `on:`.

**`disaster-button.sh`** (bash, AWS CLI and `jq` only; `set -euo pipefail`; never `set -x`):
1. **Read and mask the inputs:**
   - read `mode`, `targets` and `confirm` from `$GITHUB_EVENT_PATH` with `jq -r`;
   - print `::add-mask::` for each target **before anything else**;
   - `confirm` must equal `mode`;
   - `targets` must match `^(all-lost|[0-9a-f-]{36}(,[0-9a-f-]{36}){0,49})$` for `workspace`, exactly one uuid for `rehearse`, and be empty for `control-plane`/`reconcile`.

   Ids, not slugs: an id identifies no one publicly.
2. **One run at a time:** `aws ecs list-tasks --family cadenzpoint-backup-disaster --desired-status RUNNING --query 'length(taskArns)'`. If it's not 0, stop: "a disaster task is already running; wait for its email".
3. **Start:** `aws ecs run-task` with:
   - the cluster, the disaster family, Fargate and the subnets and security group, all read from the stack outputs;
   - `assignPublicIp=ENABLED` (there's no NAT);
   - `containerOverrides` `command: ["disaster", MODE, "--targets", TARGETS, "--run-id", "gh-$GITHUB_RUN_ID"]`.

   Output goes to a variable through `--query 'tasks[0].taskArn' --output text`; `failures` are checked the same way. Nothing else is printed.
4. **If the job is cancelled, stop the task:** `trap` on EXIT and TERM calls `aws ecs stop-task` when the task is still running and the script isn't finishing normally. The runbook also says that cancelling stops it.
5. **Wait:** loop every 60 s on `aws ecs describe-tasks --query 'tasks[0].lastStatus'` until `STOPPED`, for at most **340 minutes** (the task's own deadline is 330). Each describe failure is retried; the loop doesn't use `aws ecs wait`, whose 10-minute exit 255 would end the script.
6. **Report:** print only "disaster task finished: exit <code>; run gh-<id>; results emailed and in the digest", and exit with the task's code.

### 6.2 AWS additions (`ops/aws/backup-stack.yml`)
| Resource | Notes |
|---|---|
| **`DisasterButtonRole`** (`/cadenzpoint-backup/cadenzpoint-backup-disaster-button`) | **Trust:** GitHub OIDC, `StringEquals` `aud`, and `sub = repo:ccentofo/bytime:environment:aws-disaster`. **Policy:** `ecs:RunTask` on `task-definition/cadenzpoint-backup-disaster:*` with `ecs:cluster` = the backup cluster; `ecs:ListTasks`, `ecs:DescribeTasks` and `ecs:StopTask` on that cluster; `iam:PassRole` on the disaster execution and task roles (`iam:PassedToService = ecs-tasks.amazonaws.com`; PassRole scoping is what stops a `taskRoleArn` override); `ecs:TagResource` (`ecs:CreateAction = RunTask`); `cloudformation:DescribeStacks` on the main stack. Max session 6 h. **Stated:** a role that may run the disaster family may run it with any command or environment (§4.3.1), so it equals the task's powers. It's reachable only through the approved environment. |
| **Task definition `disaster`** | The same image with `Command ["disaster"]`; 2 vCPU / 4 GiB; `StopTimeout: 120`; log group `/cadenzpoint/backup/disaster` (under the stack's log path, so `CfnExecRole` can create it), retention 365 days, as the record of disaster runs; environment per §6.4. |
| **Disaster execution role** | ECR pull; logs; `ssm:GetParameters` on control-plane-url, encryption-key, neon-api-key, neon-org-id and control-plane-project-id. |
| **Disaster task role** (`…/cadenzpoint-backup-disaster-task`) | `s3:GetObject` and `s3:ListBucket` (`v1/*`); `kms:Decrypt` (`purpose` condition); `logs:FilterLogEvents` on the backup task's log group; `ssm:PutParameter` on `/cadenzpoint/disaster/new-control-plane-url` **only**; `ecs:ListTasks` and `ecs:DescribeTasks` on the cluster (the in-task single-run check); `sns:Publish` on the alert topic. |
| **Policy updates** | The bucket's GetObject deny and the key's Decrypt/ReEncrypt deny gain the disaster task role. 3b's `expected-policies.ts`, `ALL_ROLES` and the drift check include the three new roles (with their trusts). |
| **Alerting additions** | A third EventBridge rule, `cadenzpoint-backup-disaster-start`: CloudTrail `RunTask` events whose `requestParameters.taskDefinition` starts with `cadenzpoint-backup-disaster`, **any caller**. The email names the caller. Every start, button or CloudShell, is logged and emailed. The protections rule gains SSM `PutParameter` and `DeleteParameter` on `/cadenzpoint/backup/*`. |
| **Outputs** | `DisasterButtonRoleArn`; the cluster, subnets and security group (read by the button script). |

**SSM (founder, once):** `/cadenzpoint/backup/neon-api-key` (Q1), `/cadenzpoint/backup/neon-org-id`, `/cadenzpoint/backup/control-plane-project-id`. Written by the task: `/cadenzpoint/disaster/new-control-plane-url` only.

### 6.3 Image and deploy changes
- **No migrations in the image.** The bundle gains `scripts/backup/disaster.ts` and `scripts/backup/lib/neon-api.ts`. The deploy list is unchanged, apart from what's already under `scripts/backup/**`.
- **`BLUEPRINT-STANDARD.md` §3.7:** the new workflow's and `deploy-prod.yml`'s changed `run:` blocks run verbatim (stub `aws`, `jq` and `vercel` on `PATH`); the exact-COPY build check; **an early CI push**.

### 6.4 Mode `workspace` (`scripts/backup/disaster.ts`)
**Environment:**
- from SSM: `CONTROL_PLANE_DATABASE_URL`, `ENCRYPTION_KEY`, `NEON_API_KEY`, `NEON_ORG_ID`, `CONTROL_PLANE_PROJECT_ID`;
- constants: `NEON_REGION_ID=aws-us-east-1`, `BACKUP_BUCKET`, `BACKUP_KMS_KEY_ARN`, `BACKUP_DECRYPT_KEY_ARNS`, `ALERT_TOPIC_ARN`, `BACKUP_PG_RESTORE_BIN`, `BACKUP_LOG_GROUP`, `AWS_REGION`;
- `DISASTER_DEADLINE_MINUTES=330`.

**Start (every mode):**
- **single run:** `ecs:ListTasks` for the family. If another task started earlier (by `createdAt`) is running, exit "another disaster task is running". Of two that started together, the later one exits.
- **control plane** (not in `control-plane` mode): take `DISASTER_LOCK_KEY = 728_402_205` through 3b's lock factory; close any older `running` `disaster_runs` row as `fail` (`abandoned`); insert this run's row.

**Targets:**
- given ids → those tenants;
- `all-lost` → every tenant in `provisioning`/`active`/`suspended` with a URL whose step 2 proves gone (concurrency 4).

**Per workspace** (concurrency 2; any failure records it with an error summary and moves on):
1. **Facts:**
   - status `active`, `suspended`, or `provisioning` with a URL;
   - `neon_project_id` non-null;
   - `decrypt(db_url_encrypted)` succeeds.

   **A past `deletion_scheduled_for`** → refuse `deletion-due`. The reconcile handles it (§6.5); a workspace due for deletion isn't rebuilt. Keep `oldUrlEncrypted` and `oldProjectId`.
2. **Gone-proof** (invariant 2). If recoverable → refuse `recoverable`: "recover it in the Neon console, nothing is lost (RESTORE.md A.1)". Any unproven result → `proof-failed`.
3. **Which schema is current:** read the newest applied migration in two other reachable live workspaces, if any. Used only for the email's line "the app is ahead of this backup by N migrations: run Deploy to Production now". With none reachable, the email always says to run it.
4. **Backup, newest first, up to 3 tries:**
   - candidates are the tenant's `ok` rows plus objects found under its prefixes whose SHA-256 is confirmed by a `BACKUP` log line (that covers the catch-up and late tenants missing from a restored control plane);
   - **the expected `cp`** in the context is taken from the candidate's key (`v1/<cp>/…`), and must be the current control plane's id **or** an id recorded in a `control-plane`-mode `disaster_runs` row;
   - a candidate that fails any check during the restore (step 6) is recorded and the next older one is tried;
   - the email names the backup used and any skipped.
5. **Create** (`neon-api.ts`):
   - name `cadenzpoint-<first 40 characters of slug>-r<yyyymmddhhmm>` (within Neon's name limit);
   - **insert the intent row first** (`disaster_actions`: `kind rebuild`, the unique name, status `intended`);
   - `POST /projects` with `org_id`, pg 16, us-east-1, the tenant database name and the history setting; wait for the operations (retry 423 and 429 with backoff);
   - record the id (status `created`) as soon as it's known;
   - **a create error with no id:** list projects by that unique name (with `org_id`). If found, adopt it (record `created`), then delete it in step 10.
6. **Restore** into the new project's **direct** URL.
   - The host must be a us-east-1 Neon host (`parseNeonHost`; tests inject an override in-process only) and not the control plane's host.
   - `pg_restore --no-owner --no-acl --exit-on-error --single-transaction`.
   - Decryption must complete, the SHA must match, and counts must match exactly against the row or sidecar.
7. **Guards:**
   - the new endpoint belongs to the new project and isn't the control plane's;
   - no other non-deleted tenant has this project id or direct host;
   - a decrypt failure on another row refuses.
8. **Switch** (one transaction): `SET LOCAL lock_timeout = '5s'`; `pg_advisory_xact_lock(hashtext('tenant:' || id))` (pinned to `locked.ts:63` by test D4); then `UPDATE tenants SET db_url_encrypted = encrypt(pooled URL), neon_project_id = new, lifecycle_version = lifecycle_version + 1 WHERE id = … AND status IN ('provisioning','active','suspended') AND db_url_encrypted = oldUrlEncrypted AND neon_project_id = oldProjectId AND (deletion_scheduled_for IS NULL OR deletion_scheduled_for > now())`.
   - **0 rows** → `changed-meanwhile`.
   - In the same transaction:
     - audit `database-rebuilt` (actor `disaster:<run id>`; old and new project, backup key, backup `started_at`, SHA-256);
     - append the `linked` action row;
     - raise the global alert `rebuild-original-watch` (dedup = the old project id; detail: tenant id, slug, backup time, org id, watch start).
9. **Invalidate:** nothing to call. The registry's 60 s cache applies (`registry.ts:65`), and tenant pools are keyed by URL.
10. **On any failure after create:** delete the new project (the task is Admin of what it created), verify the 404, and append `deleted`. If the delete fails, append `failed`; the orphan finding picks it up (§6.8).

**End:**
- one email to the alert topic with each workspace's id, slug, result, **backup time**, "changes made after <backup started_at> UTC need re-entering", the skipped backups, and the "Deploy to Production" line (step 3);
- the `disaster_runs` row set `pass` (all linked) or `fail`;
- deadline 330 minutes, SIGTERM: in-flight workspaces stop, and step 10 runs for each.

### 6.5 Modes `control-plane` and `reconcile`
**`control-plane`:**
1. **Gone-proof for the control plane** (invariant 2) on `CONTROL_PLANE_PROJECT_ID`.
   - If it's recoverable → refuse: "recover the control plane in the Neon console, nothing is lost (runbook B.1)".
   - If the current `CONTROL_PLANE_DATABASE_URL` accepts a connection, **or answers with an authentication error** (`28P01`, meaning the server is there), refuse: "reachable".
   - Unproven → refuse.
2. **Double press:**
   - the start check (§6.4) covers concurrent runs;
   - if `/cadenzpoint/disaster/new-control-plane-url` was written within 24 hours (`GetParameter`; `ParameterNotFound` = never), refuse: "a control plane was rebuilt in the last 24 h; finish runbook B first".
3. **Backup:**
   - `<cp>` is the id of the old control plane's direct host;
   - list `v1/<cp>/control-plane/control-plane/`; take the newest object with a sidecar whose SHA-256 equals its `BACKUP` log line (`FilterLogEvents` with the quoted phrase, each line re-parsed exactly);
   - a failing restore falls back to the next older one, up to 3;
   - none in 25 days → refuse.
4. **Create** `cadenzpoint-control-plane-r<yyyymmddhhmm>` (the database name `cadenzpoint_control`, as in production). The id is written to the task log at once (`DISASTER-PROJECT <id>`), because there's no control plane to record it in yet.
   - Restore and check the counts against the sidecar. Any failure → delete it (step 10's rule).
5. **Record** in the new control plane:
   - a `disaster_runs` row (mode `control-plane`, `previous_cp` = the old `cp`, `backup_started_at`);
   - an action row for its own project;
   - the global `rebuild-original-watch` for `CONTROL_PLANE_PROJECT_ID` (kind control plane).
6. **Write** `/cadenzpoint/disaster/new-control-plane-url` = the new **pooled** URL. That's the only write outside the new database. Then run `reconcile` against the new control plane.

**`reconcile`** (on its own: against `CONTROL_PLANE_DATABASE_URL`; inside `control-plane`: against the new one). It records a `disaster_runs` row of mode `reconcile` with the classification.
1. **The window start** = the newest `control-plane`-mode run's `backup_started_at`. None → the newest control-plane backup row's `started_at`.
2. **Import newer tenant backup records:** `BACKUP` lines for the same `cp` (or `previous_cp`) newer than the window start, whose object exists, are inserted into `database_backups` as `ok` rows. These are the catch-up and late tenants; the SHA comes from the line, and counts from the sidecar.
3. **Classify each tenant** in `provisioning`/`active`/`suspended`/`deleting` with a project id, using the gone-proof:
   - **project 200** → fine (a past deletion date stays "awaiting `tenant:delete`");
   - **gone and not recoverable** → **lost**. If its row was also due for deletion (`deletion_scheduled_for` passed, or status `deleting`), it becomes a **re-tombstone candidate** (it would have been deleted, and there's no data to bring back);
   - **404 and recoverable** → a re-tombstone candidate **only if** the row was due for deletion (`deleting`, or `deletion_scheduled_for` passed). Otherwise **deleted in window, cause unknown**: "recover it in Neon, or confirm";
   - **unproven** → **unknown** (re-run `reconcile` later).
4. **Mass-incident brake:** if the control plane's own project is in the recoverable list, **or** more than 2 tenants are recoverable-deleted, re-tombstone **nothing** and email "possible mass deletion: recover projects in the Neon console first".
5. **Re-tombstone** each candidate, under the tenant lock:
   - `status = 'deleted'`, `deleted_at = now()`, `db_url_encrypted = null`;
   - resolve its tenant-scoped alerts and delete its `payment_pending_observations`, as `tenant:delete`'s final step does (`delete-tenant.ts:340-345`);
   - audit `retombstoned` (reason);
   - append an action row holding the **old encrypted URL and project id**, which is the undo record (runbook B.9).
6. **Projects created in the window:**
   - every organisation project whose `created_at` is after the window start;
   - excluding: projects any tenant row references; the control plane's projects; projects the task created; the names `cadenzpoint-control-staging*` and `cadenzpoint-restore-tests`; projects whose endpoints belong to the staging control plane's tenants (via the name list in `/cadenzpoint/backup/neon-ignore-projects`, an optional list the founder may set).

   Each match is appended as an action row (`unknown-project`) and listed. It's tracked by a digest finding until it 404s (§6.8).
7. **Email** the founder:
   - the window start;
   - counts and lists (id + slug) for fine, lost, re-tombstoned, deleted-unknown, unknown and window projects;
   - whether the brake fired;
   - the next steps.

### 6.6 Mode `rehearse`
Mode `workspace` for one id, except:
- **step 2 is skipped**, since the original exists;
- **step 8 runs its checks in a transaction that is rolled back**;
- **step 10 always runs**: the new project is deleted, 404 verified, and the action row appended `rehearsed-deleted`.

The email reports "rehearsal passed" with timings, and whether the Viewer key could list recoverable projects (Q1).

### 6.7 Control-plane tables (one drizzle-kit migration)
**`disaster_runs`** (`finished_at`, `status` and `summary` are set once at the end):

| column | type / note |
|---|---|
| `id` | uuid PK |
| `run_id` | varchar(80) |
| `mode` | `workspace` \| `control-plane` \| `reconcile` \| `rehearse` |
| `previous_cp` | char(12) null (control-plane mode: the old `cp`) |
| `backup_started_at` | timestamptz null (control-plane mode) |
| `started_at`, `finished_at` | timestamptz |
| `status` | `running` \| `pass` \| `fail` |
| `summary` | jsonb: counts and lists of ids, slugs and results; no error text beyond 3b's summaries |

**`disaster_actions`** (append-only: a status change is a new row; the latest row per project id or tenant is current):

| column | type / note |
|---|---|
| `id` | uuid PK |
| `run_id` | varchar(80) |
| `tenant_id` | uuid null FK → `tenants.id` |
| `kind` | `rebuild` \| `control-plane` \| `retombstone` \| `rehearse` \| `unknown-project` |
| `status` | `intended` \| `created` \| `linked` \| `deleted` \| `failed` \| `rehearsed-deleted` \| `retombstoned` \| `listed` |
| `project_name`, `new_project_id`, `old_project_id` | varchar null |
| `old_url_encrypted` | text null (re-tombstone undo) |
| `backup_key`, `backup_started_at` | null |
| `detail` | text null (summary) |
| `at` | timestamptz |

### 6.8 Monitoring (3b's `backup-status.ts` and digest; checks use the app's `NEON_API_KEY` with the org, 10 s timeouts)
| Finding | Condition | Alert (scope / dedup) |
|---|---|---|
| leftover project | a project whose latest action is `intended`/`created`/`failed` for over 6 h, or an `unknown-project` row | `rebuild-orphan-project` (global / project id or name): "delete it in the Neon console once settled". **Resolved** when a daily check gets 404 for it (by id, or no project by that name). |
| disaster run stuck | a `disaster_runs` row `running` for over 6 h | `disaster-run-stuck` (global). Resolved when the next run closes it `abandoned`, or when it finishes. |
| original returned | an open `rebuild-original-watch` whose project answers 200 | `rebuild-original-returned` (global / old project id): "the original came back. Don't open its data: ask the customer whether hours after <backup time> are missing, then delete it in the Neon console (runbook A.6)" |
| watch done | at least **30 days** since the watch started, and the project 404s and isn't recoverable | the watch, and any "returned", resolved |
| watch unverifiable | the watch's org id differs from the current one (after runbook C) | the watch resolved with "unverifiable: different Neon account" |
| watch check failed | a Neon call fails | `rebuild-watch-check-failed` (global); resolved by the next success |

- **The digest's Backups section adds:** "Disaster runs in the last 7 days: <mode> <status> at <time>".
- **Scopes:** these kinds are global. 3b's "monitoring off resolves every backup kind" **excludes** `rebuild-*` and `disaster-*`, because they're facts about real projects.
- **`tenant:delete`** refuses to apply while an open `rebuild-original-returned` or `rebuild-orphan-project` names the tenant. Both resolve once the founder deletes the project in Neon (a 404), so this can't block forever.

### 6.9 Runbooks (`RESTORE.md`, "Disaster")
**A. One workspace lost** (its Neon project unreachable):
1. Neon console: if the project is listed as deleted and recoverable, **recover it there**. Nothing is lost; stop.
2. If it's unreachable but not deleted (an outage; check status.neon.tech), wait for Neon, up to the 1-business-day target. The button refuses while the project exists.
3. Find the workspace id (in the digest's alerts or the last reconcile email). Actions → **Disaster restore** → `workspace`, the id, confirm `workspace` → approve. **Cancelling the run stops the task.**
4. Read the email. If it says the app is ahead, or no other workspace was reachable, run **Deploy to Production** (normal).
5. Email the customer with **template A**: the backup time; what to re-enter; that records before it are intact.
6. If the digest later says the original came back: don't open it. Ask the customer to confirm their re-entered hours. Then delete the original in the Neon console; the watch closes after its 30 days.
7. After any real rebuild, in the Neon console, make your own account Admin of the new project (Q1's residual).

**B. The control plane lost:**
1. Neon console: if the control-plane project is deleted and recoverable, **recover it there** and stop. If Neon is having an outage, wait.
2. Vercel → the project → Cron Jobs → **Disable Cron Jobs**.
3. Actions → **Disaster restore** → `control-plane`, confirm → approve. Read the email (it includes the reconcile).
4. **Repoint** (accepted Q2): copy `/cadenzpoint/disaster/new-control-plane-url` (AWS Parameter Store, as `corey-admin`) into:
   - Vercel production's `CONTROL_PLANE_DATABASE_URL`;
   - the GitHub `production` environment's secret of the same name;
   - AWS `/cadenzpoint/backup/control-plane-url`, so the backups follow;
   - update `/cadenzpoint/backup/control-plane-project-id` to the new project's id (in the email).
5. Actions → **Deploy to Production** with `skip_lost_workspaces` ticked.
6. Check that the app loads and an admin can sign in.
7. Work through the email's lists:
   - **lost** → runbook A from step 3 (`all-lost`);
   - **deleted in window, cause unknown** → recover in Neon if it shouldn't have been deleted, or confirm the deletion with the lead;
   - **unknown** → re-run `reconcile` later;
   - **window projects** → the **Stripe checklist**: find the customer by email in Stripe, recreate the workspace with the lead or cancel and refund, email them, then delete the project in Neon.
8. **Deploy to Production** again, normal (this migrates the rebuilt workspaces). Then re-enable the crons in Vercel.
9. **Undo** of a wrong re-tombstone (rare): the action row holds the old URL and project id. Recover the project in Neon, then the lead restores the row from the action record.
10. Email affected customers (template B, which also mentions a possible repeated notice, Q2).

**C. The whole Neon account lost:**
1. Create a new Neon account on `infra@`.
2. Invite `neon-ops@` as Viewer and create its key.
3. Create an organisation key for the app. Then update:
   - `/cadenzpoint/backup/neon-api-key` and `/cadenzpoint/backup/neon-org-id`;
   - Vercel's `NEON_API_KEY`;
   - the GitHub `production` environment's `NEON_API_KEY`.
4. Recreate the restore-test project (FOUNDER-ACCOUNTS-SETUP Part 5) and update `/cadenzpoint/backup/restore-test-url`.
5. Runbook B from step 2. In the new account, every workspace shows **lost**, deletions in the window can't be seen (only due deletions re-tombstone), and the original watches resolve as unverifiable.

**If GitHub is down (Q3):** in AWS CloudShell as `corey-admin`, run the one command printed in `RESTORE.md` (`aws ecs run-task …` with the same overrides). The start emails you like a button press.

## 7. State machines
### 7.1 One workspace rebuild
| State | Event | Next | Side effects |
|---|---|---|---|
| start | facts fail | failed `facts` | none |
| start | deletion date passed | failed `deletion-due` | none (the reconcile handles it) |
| start | project 200 | failed `original-exists` | none |
| start | unproven (control fails, partial list, other status) | failed `proof-failed` | none |
| start | recoverable | failed `recoverable` | none (points to Neon recovery) |
| proven | no candidate verifies after 3 | failed `no-backup` | intent/created rows only if a create happened |
| proven | intent row inserted | intended | — |
| intended | create returns an id | created | action `created` |
| intended | create fails, no id; the name lookup finds it | created (adopted) | action `created`, then the cleanup |
| intended | create fails, no project by that name | failed `create` | action `failed` (no project) |
| created | restore/SHA/sidecar/count fails | try the next backup (up to 3), else cleanup | action `failed` → `deleted` |
| created | guards fail | cleanup | action `deleted` (or `failed` if the delete fails) |
| created | switch updates 0 rows | cleanup | `changed-meanwhile` |
| created | switch commits | linked | audit, action `linked`, the watch |
| any after create | deadline / SIGTERM | cleanup | action `deleted`/`failed` |

### 7.2 The original watch
| State | Event | Next | Side effects |
|---|---|---|---|
| watching | daily: 200 | returned | `rebuild-original-returned` |
| watching / returned | ≥ 30 days and 404 and not recoverable | done | resolved |
| watching | org id differs | done | resolved "unverifiable" |
| any | the check fails | unchanged | `rebuild-watch-check-failed` |

### 7.3 One tenant in the reconcile
| Row | Neon | Due for deletion? | Result |
|---|---|---|---|
| live/deleting | 200 | any | fine |
| live/deleting | gone, not recoverable | yes | re-tombstone (unless the brake fired) |
| live/deleting | gone, not recoverable | no | lost |
| live/deleting | 404, recoverable | yes | re-tombstone (unless the brake fired) |
| live/deleting | 404, recoverable | no | deleted-in-window, cause unknown (listed) |
| live/deleting | unproven | any | unknown |

## 8. Failure modes
| # | Failure | Behaviour |
|---|---|---|
| F1 | Wrong key or org (404 for everything, or an empty list) | The positive control fails → unproven; nothing created. |
| F2 | The original only temporarily unreachable | 200 or another status → refused; the founder waits. |
| F3 | The original returns after a switch | `rebuild-original-returned`; the founder decides with the customer; nothing merged (§5). |
| F4 | The task dies after creating a project | The intent/created row → the leftover finding after 6 h; resolved when the founder deletes it (404). |
| F5 | A concurrent change to the row | The byte-equality switch updates 0 rows → cleanup. |
| F6 | The app is ahead of the backup's schema | The email says to run Deploy to Production. The runbook's final normal deploy migrates the workspace. |
| F7 | A forged or tampered backup | Context (workspace and known `cp`), SHA (row or log line), sidecar, counts → refused; the next older candidate is tried. |
| F8 | Double press or a cancelled run | The button refuses while a task runs; in-task oldest-wins; the cancel trap stops the task; control-plane mode's 24-hour marker. |
| F9 | A deleted workspace resurrected by an old control plane | Re-tombstoned only with Neon's proof plus a due deletion; otherwise listed; the mass-incident brake. |
| F10 | A notice sent twice after a control-plane rebuild | Accepted (Q2); runbook B's email template mentions it. |
| F11 | Stripe events in the window | The lifecycle's daily reconcile reads Stripe after the crons resume. |
| F12 | The Neon project limit, or 429 | Create fails or retries with backoff; reported. |
| F13 | GitHub down | The CloudShell fallback (Q3). |
| F14 | Public-log leakage | Inputs are read from the event file and masked; ids, not slugs; quiet AWS output (D2, D7). |
| F15 | Restore tests after a control-plane rebuild | 3b's restore test also lists objects under the `previous_cp` of the newest control-plane run, until the new prefix has backups (a small change to `restore-test.ts`'s listing). |
| F16 | A compromised disaster key (Viewer) | It can create projects, and delete its own (including rebuilt ones, until runbook A.7). It can't read or change customers' existing projects. Stated in Q1. |

## 9. Platform limits
- **Task deadline:** 330 minutes; the button waits up to 340, inside the 360-minute job and the 6-hour credentials.
- **`all-lost`** at concurrency 2: about 30 small restores an hour.
- **Neon:** 700 requests/minute and 40/s per route (retried with backoff on 429); the plan's project limit.
- **GitHub:** pending approvals fail after 30 days.

## 10. Blast radius
| File | Change |
|---|---|
| `scripts/backup/disaster.ts`, `scripts/backup/lib/neon-api.ts` | **new** (key-required Neon calls with `org_id`: create, get, list with pagination and `unavailable_project_ids`, the recoverable list, delete-own, endpoints) |
| `scripts/backup/main.ts` | the `disaster` command (refused outside ECS) |
| `scripts/backup/restore-test.ts` | also lists `previous_cp` objects (F15) |
| `scripts/backup/disaster-button.sh`, `.github/workflows/disaster-restore.yml` | **new** |
| `ops/aws/backup-stack.yml`, `scripts/backup/lib/expected-policies.ts` | the disaster task, roles, log group, outputs, the start-alert rule, the SSM alert events, the bucket/key exemptions, `ALL_ROLES` |
| migration + `src/db/control-plane/schema.ts` | `disaster_runs`, `disaster_actions` |
| `src/lib/tenant/backup-status.ts`, `ops-digest.ts` | §6.8 findings and checks; the digest line; the monitoring-off exclusion |
| `src/lib/tenant/delete-tenant.ts`, `scripts/delete-tenant.ts` | the refusal (§6.8) |
| `scripts/migrate-all.ts`, `scripts/lib/migrate-all-run.ts`, `.github/workflows/deploy-prod.yml` | `--skip-lost` and the input; pins (§6.0) |
| `RESTORE.md`, `PRODUCTION-DEPLOY.md` Phase 13b, `FOUNDER-ACCOUNTS-SETUP.md` | the runbooks, templates A/B, the CloudShell command, the setup |
| Tests | §11; 3b's `backup-static` (U6) extended |

## 11. Required tests (each must fail without the change it proves)
**Without Neon or AWS:**
- a **fake Neon API** (a local HTTP server in the test) whose `POST /projects` creates a local database (`bkt_dr_*`) and returns its URL. It scripts statuses (404, 403, 5xx, 423, 429), the recoverable list, **the personal-key behaviour** (an empty list without `org_id`), partial lists with `unavailable_project_ids`, pagination, `created_at`, and lost create responses;
- 3b's fakes for S3, KMS, SNS and a `LogReader`; a scratch control plane per suite;
- the `parseNeonHost` guard overridden in-process for the fake's local URLs, plus a test that it refuses them in production configuration.

**Unit:**
- **D1:** the gone-proof truth table (invariant 2), including no `org_id` → an empty list → **unproven**, not "not recoverable"; partial lists; 401/403/5xx.
- **D2:** `disaster-button.sh` with a stub `aws` and the event file: validation (ids, `all-lost`, counts, `rehearse` with two, `control-plane` with targets, confirm mismatch, a leading `-`); **no target text anywhere in its output**; the running-task refusal; the cancel trap calling `stop-task`; the describe loop surviving a failed call.
- **D3:** backup candidate selection: rows plus log-verified objects, the `cp` rule (current or recorded `previous_cp`), fallback to the next older, the 3-try cap.
- **D4:** the switch SQL: byte equality, the deletion clause, the `lifecycle_version` bump, the lock string equal to `locked.ts`'s.
- **D5:** `--skip-lost`: listed, unlinked and unreachable → skipped; listed and reachable → migrated; unlisted unreachable → fails; no run in 7 days → refuses; the boolean wiring in `deploy-prod.yml` (`false` never passes the flag).
- **D6:** §6.8: leftover at 6 h and resolved by 404; stuck run at 6 h; the watch's 30-day minimum, returned, unverifiable org; the digest line; the monitoring-off exclusion.
- **D7:** U6 additions:
  - the three roles' grants and trusts (`environment:aws-disaster`, `StringEquals`);
  - RunTask limited to the family and cluster;
  - the task role's single SSM write path;
  - the bucket and key exemptions;
  - the start-alert rule (any caller);
  - the SSM events in the protections rule;
  - the workflow: environment, `id-token` at job level, **no `inputs.` outside `on:`**, `queue: max`, SHA pins, the gate;
  - `deploy-prod.yml`'s pins.
- **D8:** the reconcile classification table (§7.3) and the brake (the control plane recoverable, or more than 2 recoverable-deleted).

**Integration** (fake Neon, scratch control plane, real pg 16 tools):
- **R1:** `workspace` end to end:
  - the new database has exact counts;
  - the row is switched; the audit, the `linked` action and the watch are recorded;
  - the old database is untouched;
  - the email has the backup time;
  - **no migrations are run**.
- **R2:** every §7.1 failure row, each leaving the row unchanged. Where a project was created, the task deletes it (a 404 in the fake); a failed delete leaves a `failed` row and the leftover finding.
- **R3:** `changed-meanwhile`.
- **R4:** `all-lost` picks exactly the proven-gone tenants (200, recoverable, unproven and gone mixed).
- **R5:** `control-plane` end to end:
  - a reachable old control plane, or `28P01`, → refused;
  - recoverable → refused;
  - a missing log line → the next older; none → refused;
  - the new database, the run row with `previous_cp`, the watch;
  - the single SSM write;
  - then the reconcile.
- **R5b:** **`control-plane`, then `workspace` / `all-lost` on backups made before the rebuild**: they restore (the `cp` rule).
- **R6:** `reconcile`:
  - a past deletion date with the project 200 → **not** re-tombstoned;
  - recoverable plus due → re-tombstoned, with tenant alerts resolved and the undo row stored;
  - recoverable, not due → listed;
  - the brake;
  - BACKUP-line import;
  - window projects filtered by `created_at` and the exclusions;
  - re-running it changes nothing.
- **R7:** `rehearse`: no switch, the project deleted, the row unchanged.
- **R8:** `migrate-all --skip-lost` and `--check` (D5 against real databases).
- **R9:** `tenant:delete` refuses while a returned or leftover alert names the tenant, and proceeds after the 404.
- **R10:** concurrency: a second run exits (control-plane lock, and the in-task oldest-wins with a fake ECS list); SIGTERM mid-restore → cleanup.
- **R11:** 3b's restore test lists `previous_cp` objects after a control-plane run (F15).

## 12. Founder steps and rehearsal (`PRODUCTION-DEPLOY.md` Phase 13b additions, in order)
1. **GitHub:** create `aws-disaster` (required reviewer you, Prevent self-review off, admin bypass off, Selected branches `main`). Verify with the two `curl` commands.
2. **Neon (Q1):** add the alias `neon-ops@cadenzpoint.com`; invite it as **Viewer**; sign in as it once (security key); create a personal API key.
3. **AWS Parameter Store:** `/cadenzpoint/backup/neon-api-key`, `/cadenzpoint/backup/neon-org-id`, `/cadenzpoint/backup/control-plane-project-id` (all SecureString).
4. **Push early** once the CI and Dockerfile commit exists (`BLUEPRINT-STANDARD.md` §4). Merge; run deploy-prod; approve the backup-system deploy. Copy `DisasterButtonRoleArn` into the `aws-disaster` secret `AWS_DISASTER_ROLE_ARN`.
5. **Rehearse on production:** Actions → **Disaster restore** → `rehearse`, a demo workspace's id, confirm `rehearse` → approve.
   - **Expect** the start email (the start-alert rule), then "rehearsal passed" with the backup time, timings and "Viewer could list recoverable projects: yes";
   - **expect** no change to the workspace, and the rehearsal's project gone from Neon;
   - if the Viewer couldn't, switch the member to Editor (Q1's fallback) and rehearse again.
6. **Reconcile dry run:** `reconcile` → approve. **Expect** an email where every workspace is **fine**, and nothing re-tombstoned.

## 13. Verification
1. `npx tsc --noEmit`, lint, `npm run test`, `npm run test:tz`, `npm run db:safety`, and integration (the memory command plus the pg 16 tools).
2. **§3.7:** every changed `run:` block run verbatim with stubs; the exact-COPY build check; **the early push**.
3. **The lead's checks file** (local): `disaster-button.sh` validation and output silence; `migrate-all --skip-lost` against a scratch control plane; the digest's disaster line; the `tenant:delete` refusal.
4. **Real AWS and Neon:** §12 steps 5–6, with the founder.

## 14. Hand-off rules
As 3b §14, plus `BLUEPRINT-STANDARD.md` §3.7 and the early CI push.

## 15. Pre-mortem log
**Round 1** (two reviewers on v1; A on security and infrastructure, B on correctness): **3 HIGH, 17 MEDIUM, about 20 LOW.** Fixed in v2, with three simplifications:
- **No migrations in the button.** The normal deploy migrates afterwards. That removes the image-currency check, its blind spot when every workspace is lost, and the routine deploy approvals adding migrations to the image would have caused (B-M7, B-M8).
- **Control-plane mode repoints nothing** (accepted Q2 has the founder repoint AWS too). It writes only the new URL for the founder to copy (A-3, B-H2).
- **Ids, not slugs, in the button;** inputs are read from the event file and masked (A-1, B-M3).

**Other fixes:**
- **HIGH: re-tombstoning could close live workspaces** (B-H1). It now needs Neon's proof plus a due deletion, with a mass-incident brake and an undo record. A past date with the project alive stays "awaiting `tenant:delete`".
- **HIGH: no gone-proof for the control plane** (B-H2, A-3). The same three-part proof on a stored project id; auth errors count as reachable; recoverable → refuse; the control plane gets an original watch.
- **HIGH: the `cp` mismatch after a control-plane rebuild** (B-H3). The expected `cp` comes from the backup's key and must be current or recorded; restore tests list the previous prefix (F15).
- **MEDIUMs:**
  - `org_id` on every list call, pagination, and `unavailable_project_ids` as unproven (B-M1);
  - Q1 restated accurately, recommending Viewer (A-5, B-M2);
  - leftover projects: intent rows first, the task deletes its own failures and rehearsals, lost-create adoption by unique name, a 404-based resolution, and no permanent `tenant:delete` block (B-M4);
  - a `reconcile` mode (A-6, B-M5);
  - fallback to older backups, and due-for-deletion lost workspaces re-tombstoned by the reconcile (B-M6);
  - BACKUP-line import for missing rows (B-M9);
  - window projects filtered by `created_at` and exclusions, and tracked (B-M10);
  - concurrency: the button's running-task check, in-task oldest-wins, the cancel trap, abandoned runs closed, and a control-plane marker checked at the start (A-2, B-M11);
  - runbook C's org id and keys (A-4, B-L2).
- **LOWs folded in:**
  - the boolean wiring and pins in `deploy-prod`; `--skip-lost` migrates reachable listed tenants;
  - the start-alert rule and the SSM alert events;
  - rehearsal on production;
  - the log-group path, `assignPublicIp`, no `aws ecs wait`, and timeouts;
  - the uuid regex;
  - the watch's 30-day minimum and the unverifiable-org case;
  - the IAM gaps; the database name and pooled URL;
  - re-tombstone clean-up as `tenant:delete`'s final step;
  - append-only actions;
  - test seams and the missing tests;
  - the name length;
  - founders aren't asked to view returned data.
- **New questions:** Q2 (repeated notices) and Q3 (the GitHub-down fallback).
