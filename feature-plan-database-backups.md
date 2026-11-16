# Database backups (build queue 3b)

> **Status:** **DRAFT v4**, 2026-11-15, lead architect.
> - **Scope split (product owner, 2026-11-15):** this blueprint covers backups, monitoring, restore into a scratch database, the drill and retention. The disaster tooling (rebuilding a lost workspace database, the control-plane disaster runbook, re-tombstoning) moves to its own item, **3c**. The v3.2 design is the starting point for 3c (commit `95d8bfe`).
> - Rounds 1–2 and confirmation passes 1–3 are logged in §15. Pass 3 found MEDIUMs only in the 3c tooling.
> - A confirmation pass on this trimmed version is pending.
>
> **Branch:** `database-backups`, from `main` at `c416049` (after per-user billing, PR #32). The §3 references were checked there.
>
> **Source:**
> - `BUSINESS-DECISIONS.md` §5 (Decided 2026-11-10), "Backups beyond Neon: Yes. Required before the first paying customer". Its requirements:
>   - a daily `pg_dump` (custom format) of every tenant database and the control plane, skipping `deleting` / `deleted`;
>   - encrypted on the runner with a public key; the private key never on the runner or in storage;
>   - S3 us-east-1, in an account separate from Vercel and Neon;
>   - 30 days rolling, via a lifecycle rule;
>   - write-only job credentials, with separate founder-held restore credentials;
>   - digest reporting, plus an alert when an active tenant's newest backup is more than 36 h old;
>   - RPO 24 h; restore within 1 business day;
>   - a monthly restore drill, recorded;
>   - runner: engineering's choice.
> - `LAUNCH-TRACKER.md` build queue 3b (approved 2026-11-11).
> - LB-D6 (`feature-plan-launch-blockers.md:40,380`; `RESTORE.md:80-83`): "No `set-db-url` command"; the live database is never swapped for a restored branch. Unchanged by this item; item 3c will ask the product owner about a narrow disaster exception.
> - Terms §9.3 (`business/legal/terms-of-service.md:211-213`): deleted data "may remain in our backups for up to **30 days**". Terms §8.5: time records are never deleted or overwritten.
> - Privacy page (`src/app/privacy/page.tsx:44,52`): backups up to 30 days; AWS is a subprocessor. `lifecycle-config.ts:48-52`: `BACKUP_RETENTION_DAYS = 30`.
>
> **Standard:** `BLUEPRINT-STANDARD.md`.

## 1. Goal and scope

Disaster-recovery backups that survive losing a Neon project, or the whole Neon account, control plane included.

1. **A daily GitHub Actions job:**
   - dumps every tenant database, with end-of-run retries, and then the control plane, **after** all tenant work has finished;
   - uses Postgres 16 tools over the direct host, with an exported snapshot and exact row counts;
   - encrypts each dump with `age` to a recipient committed in the repo;
   - uploads it to S3 under a key that can't be overwritten, with an encrypted sidecar manifest;
   - records a control-plane row and an independent `BACKUP` line in the run log.
2. **Monitoring that fails loudly:**
   - a missed run, stale or failed targets, monitoring switched off, the drill overdue or failed, old objects, untracked restore copies;
   - every check is isolated from the digest.
3. **Restore tooling:**
   - works from S3 alone;
   - a tenant restore accepts only that tenant's own backup;
   - checks integrity against the sidecar, the control-plane row or a supplied SHA-256;
   - a drill every 3 weeks in databases it creates and drops;
   - restore copies are tracked until they're destroyed.
4. **Disaster rebuild is item 3c.** Pointing a workspace at a rebuilt database, and recovering a lost control plane, need their own tooling and runbook. Until 3c lands, a disaster restore goes into a scratch database (this item), and relinking is done by the founder with the lead's help. Both 3b and 3c are required before the first paying customer.
5. **AWS setup** as reviewable policy files, plus the founder runbook.

**Out of scope:**
- point-in-time recovery (Neon's 7-day history);
- staging backups (Q2);
- cross-region copies;
- an archive plan;
- changes to retention periods or to the Terms.

## 2. Questions for the product owner

| # | Question | Recommendation | Section |
|---|---|---|---|
| Q1 | **Keeping the "30 days" promise (Terms §9.3).** An S3 lifecycle rule makes an object *eligible* for deletion after N days, rounded up to midnight UTC. AWS removes it asynchronously ("days or even weeks later") and doesn't recommend lifecycle alone for deadline-bound deletion. | **A 25-day lifecycle rule** (eligible within 26 days), **plus a daily old-objects check** by a separate **list-only** AWS identity. It sees names, sizes and dates, no content. The digest raises an alert when the oldest object is **over 27 days** old, and the founder deletes it by hand the same day. Worst case: about 27 days plus one daily sample plus same-day deletion, which stays at or under 30 days. This tightens §5's "can't read" to "can't read content"; your call. Alternative: a weekly manual check (worst case about 34 days). Either way the business side may want §9.3 to allow for the provider's lag. | §6.6 |
| Q2 | **Staging backups.** | **None.** One rehearsal against a test bucket (§12.3). | §6.8 |
| Q3 | **Drill frequency and where it's recorded.** §5 says monthly and "record the result in a runbook". The backups only live 25 days (Q1). | **Every 3 weeks**, reminded 21 days after the last PASS. Each drill restores a random tenant **and** the control plane. Alternate drills use the S3-only path (no control-plane lookup), the disaster path. Results are recorded in a control-plane table the digest reads, and the runbook points there. **The drill puts real customer data on the founder's laptop briefly**, in databases it drops at the end. Require FileVault. | §6.7, §6.9 |
| Q4 | **Alerting on one missed run.** §5's 36 h rule only fires after two missed runs (backups 06:17 UTC, digest 13:00). | **Also alert when there's no successful control-plane backup in 26 h** at digest time. Add a **catch-up run at 18:17 UTC** that exits immediately if today's control-plane backup already succeeded, so one dropped run doesn't cost a day of RPO. | §6.4, §6.7 |

Design choices stated for the record (engineering's call within §5):
- **Runner:** GitHub Actions, scheduled.
- **Time:** 06:17 UTC, plus the 18:17 catch-up (Q4).
- **Coverage:**
  - `provisioning` tenants with a URL are backed up (§5's literal skip list), and the stale rule ignores tenants created under 36 h ago and tenants with no URL;
  - demo workspaces are included.
- **Existing drill:** the existing monthly Neon branch drill stays unchanged.

## 3. Verified current state (2026-11-15, `main` at `c416049`)

### 3.1 Databases
- **One Neon project per tenant:** `createNeonDatabase(slug)` (`src/lib/tenant/neon.ts:47-…`) creates the project with `pg_version: 16`, `history_retention_seconds` and the region (`:63-74`), and returns `{ dbUrl, neonProjectId }`.
- **Neon helpers:**
  - `findNeonProjectIdByName` (`:285-297`) returns the first name match;
  - `deleteNeonProjectVerified` (`:200-236`) checks that the tenant's endpoint host belongs to the project, and that the project isn't the control plane's (`:219-224`), then deletes the whole project;
  - `neonProjectExists` (`:238`);
  - `directNeonHost` (`:187`);
  - a deleted project is recoverable for 7 days (`:198`).
- **Control plane:** Postgres 16 per `PRODUCTION-DEPLOY.md:272`, not enforced in code.
- **Stored URLs** use the pooled host; `toDirectConnectionUrl` (`migrate-tenant.ts:18-30`).
- **`migrateTenantDatabase(url)`** (`:33-…`) runs `./drizzle` from the current checkout; `getPendingMigrationCount` is exported.
- **Encryption:** tenant URLs are AES-256-GCM. `encryption.ts:29-30` derives any non-hex key in non-production, so a wrong or dev key is **not detected**. Writes must prove the key (§6.10).
- **Statuses** (`schema.ts:4-10`): `provisioning`, `active`, `suspended`, `deleting`, `deleted`. A crashed provisioning leaves `provisioning` with no URL (`provision.ts:44,68-74`).
- **`tenant:delete`:**
  - classifies by `neon_project_id` (`delete-tenant.ts:99-100`);
  - refuses when another workspace shares the URL (`:216-226`, and on a decrypt failure `:225-229`), or when the project is missing (`:236-245`);
  - deletes by `neon_project_id` (`:327-329`);
  - the deletion receipt lists founder exports (`:362-383`).
- **`isLoopbackUrl`** (`src/lib/tenant/loopback.ts:9`). **`dropDatabaseVerified`** (`neon.ts:264`) checks names before dropping.
- **Founder scripts:**
  - call `dotenv.config({ path: ['.env.local', '.env'] })` (`tenant-admin.ts:37-42`, `migrate-all.ts:28-29`, `tenant-export.ts:14-15`); the developer's `.env` holds the **local** control-plane URL, and `.env.local` holds a dev `ENCRYPTION_KEY`;
  - print `printTargetBanner()` (`scripts/lib/target.ts:32-37`, which prints the control-plane host), checked by `ops-retention-scripts.test.ts:254`;
  - actor `founder:${USER}` (`tenant-admin.ts:60`).

### 3.2 GitHub Actions
- **`ci.yml`:** push/PR on all branches; the integration job runs on `ubuntu-latest` with a `postgres:16-alpine` service and no client tools.
- **Deploy workflows:** `deploy-prod.yml` / `deploy-staging.yml` are manual, with environments `production` / `staging`. `production` is gated to `main` **and** has required reviewers (`PRODUCTION-DEPLOY.md:540-542`).
- **Postinstall:** `package.json:45` (mantine), which scripts don't need.
- **No scheduled workflow** exists.

### 3.3 Monitoring and app
- **Route** `tenant-lifecycle/route.ts:22-27`: `runLifecycleCron`, then `runSignupMaintenance`, then `sendOpsDigest`. `runCron` records success after `work()` (`run-cron.ts:25-30`).
- **`runLifecycleCron`'s global writes** have no try/catch (`lifecycle-runner.ts:512-517`).
- **Digest** (`ops-digest.ts`):
  - `section()`, `hasNews` (`:108-110`);
  - unresolved alerts (`:138-139`);
  - `checkFounderExports` (`:34-64`, no try/catch at `:79`), which anchors destroy-by on the data's time, capped at deletion + 30 (`:42-55`).
- **Alerts and audit:**
  - `raiseAlert` scope: tenant id, or `'global'` (`lifecycle-store.ts:56-71`);
  - `resolveAlertsOfKind` (tenant-scoped, `:95-105`);
  - `recordAudit` needs a `tenantId` (`:108-…`).
- **Registry cache TTL** is 60 s (`registry.ts:65`).
- **Staging** is its own Vercel project with production-type deploys (`PRODUCTION-DEPLOY.md:79,299-311`), so `NODE_ENV=production` there too.
- **Tests:**
  - `tenant-lifecycle-cron.test.ts:491` calls `runLifecycleCron({ onlyTenantIds })` directly;
  - `signup-ops.test.tsx:171-189` mocks every route import and asserts order;
  - `ops-digest-alerts.test.ts` stubs the digest's queries;
  - `tenant-notices.test.ts:272` and `seat-sync.test.ts:308` call `sendOpsDigest`;
  - `seat-sync.test.ts:143` cleans global alert kinds per suite;
  - `lifecycle-helpers.ts:71-80` cleans `test-lc-*` only.

### 3.4 Docs
- **`RESTORE.md`** (branch restore, in-place exception, monthly branch drill `:70-78`, "no command" `:80-83`).
- **`TENANT-DELETION.md`** backup window (`:124-145`).
- **`PRODUCTION-DEPLOY.md`:** Phase 15 (`:913`), Operations (`:883-887`).

### 3.5 Product owner's machine
- pg 16.14 at `/opt/homebrew/opt/postgresql@16/bin`.
- No `age`.
- Local Postgres is docker `postgres:16-alpine`, user `bytime`/`bytime_dev`.

## 4. External behaviour (verified from source; fetched 2026-11-15)

### 4.1 GitHub Actions
1. **Schedules** may be delayed or **dropped** under load. They run in UTC on the default branch. The 60-day auto-disable is documented for public repos (…/events-that-trigger-workflows).
2. **Limits:**
   - a job runs up to 6 h;
   - `concurrency` with `cancel-in-progress: false` keeps **one** pending run (a newer pending run replaces it);
   - failure emails go to the user who last edited the cron (…/limits, …/workflow-syntax, …/notifications-for-workflow-runs).
3. **OIDC:**
   - `id-token: write`; configure-aws-credentials v6, `role-duration-seconds` 900–43200;
   - `sub = repo:OWNER/REPO:environment:NAME` for a job with an environment, **on any branch**;
   - the token also carries `job_workflow_ref` (`OWNER/REPO/.github/workflows/FILE@refs/heads/BRANCH`), which a trust policy can condition on (…/oidc-in-aws, …/reference/security/oidc).
4. **Environments:**
   - **"Running a workflow that references an environment that does not exist will create an environment with the referenced name … will not have any protection rules or secrets configured."**
   - Branch policy "Selected branches" restricts which branches can deploy (…/manage-environments, …/deployments-and-environments).
5. **Runner image `ubuntu-24.04`:** CLI 2.40.0, Node 22, pg client 16.15, no `age`. PGDG `postgresql-client-16`; apt `age` 1.1.1. On PATH, `pg_dump` is Debian's `pg_wrapper`, so use the absolute path.
6. **Secrets and logs:**
   - masking is best-effort; runtime values need `::add-mask::`; an unset secret is `''`;
   - log retention is configurable from 1 to 400 days for private repos, and admins can delete logs (…/security/secrets, …/usage-limits).

### 4.2 AWS S3
1. Single PUT up to 5 GB; lib-storage multipart, **with `partSize` set**.
2. **Don't upload with `aws s3 cp`:** it can exit 0 on failure (aws-cli#10743, open), so the SDK is used.
3. **Conditional writes:**
   - `If-None-Match: *` on PutObject and Complete gives 412 or 409; needs `s3:PutObject` only;
   - lib-storage passes it through (3.1169.0 `dist-cjs/index.js:258,452-463`) and sends a single PUT only at the body's end;
   - destroying the body with an error rejects the upload; `abort()` doesn't cancel an in-flight PUT or Complete (`:243-245`);
   - enforce with the Deny on `s3:PutObject` + `{"Null": {"s3:if-none-match": "true"}, "Bool": {"s3:ObjectCreationOperation": "true"}}` (…/conditional-writes-enforce.html, Example 2);
   - an SDK retry of a write that actually succeeded sees 412.
4. **IAM:** lib-storage calls PutObject, CreateMultipartUpload, UploadPart, Complete and AbortMultipartUpload. `s3:ListBucket` with condition `StringLike s3:prefix "v1/*"` scopes listing.
5. **Lifecycle:**
   - creation + N days, rounded to midnight UTC; asynchronous removal ("days or even weeks"); not blockable by bucket policy;
   - versioning off (a versioned bucket only adds delete markers);
   - `AbortIncompleteMultipartUpload`.
6. **Policy conditions:** `ArnNotLike aws:PrincipalArn` for principal exceptions (`NotPrincipal` doesn't match assumed-role sessions).
7. **Defaults and price:**
   - Block Public Access, Bucket owner enforced, SSE-S3; add a TLS-only policy;
   - storage $0.023/GB-month; PUT and LIST $0.005 per 1,000.

### 4.3 age
- Streaming, `-r` / `-d -i`, `age-keygen`; STREAM AEAD with an authenticated final chunk; exit 0 only on full success.
- **No sender authentication:** anyone with the public key can make a valid file.
- **An early end of input produces a valid shorter file,** so pipeline success is decided outside age (§6.2).

### 4.4 pg_dump / pg_restore / Neon / postgres.js
1. **Version 16 for both tools:**
   - pg_restore 17 emits `SET transaction_timeout`, which a 16 server rejects;
   - archive format 1.16 is unreadable by 16;
   - pg_dump refuses newer servers.
2. **`--snapshot`** with `pg_export_snapshot()` from REPEATABLE READ, valid until the exporting transaction ends. An imported snapshot outlives its exporter.
3. **`--lock-wait-timeout=N`** makes pg_dump fail rather than wait on a conflicting lock (postgresql.org/docs/16/app-pgdump.html).
4. **Neon:** unpooled connection; `pg_restore -O`; the minimal env plus the URL query (`sslmode`, `channel_binding`) is enough. Transfer: 500 GB per project per month on Launch/Scale.
5. **postgres.js:** `sql.begin` races its callback against `connection.onclose` (`node_modules/postgres/cjs/src/index.js:243-246`). The option string passes `'isolation level repeatable read read only'` intact (`:241`).

## 5. Invariants that must not break
1. **The private key never touches the runner, the repo, S3 or Vercel.** The recipient lives in `ops/backup-recipient.txt` (a reviewed commit).
2. **No secret is printed:**
   - errors redacted; runtime values masked **before any output**;
   - the banner shows a redacted label in Actions;
   - children get a minimal env.
3. **AWS access:**
   - the writer adds objects only (no read, overwrite or delete);
   - the auditor lists names only;
   - the restore identity reads.
4. **`ok` means every stage succeeded.** On failure the upload body is destroyed before it ends, so no partial object completes.
5. **Dumps are read-only.**
6. **`deleting` and `deleted` tenants are never dumped** (status re-read per target).
7. **Restores write only to loopback scratch databases they create, or that are proven empty.** Nothing in this item writes to a live database or changes a workspace's database link.
8. **Monitoring fails loudly.**
9. **Tenancy:** a tenant restore accepts only that tenant's own backup (key path **and** sidecar `tenantId`).

## 6. Design

### 6.1 Control-plane tables (one drizzle-kit migration `00NN_database_backups.sql`, all append-only except where noted)

**`database_backups`:**

| column | type / note |
|---|---|
| `id` | uuid PK |
| `tenant_id` | uuid null FK → `tenants.id` ON DELETE CASCADE (null = control plane) |
| `target` | `'tenant'` \| `'control-plane'` |
| `run_id` | varchar(80) |
| `status` | `'ok'` \| `'failed'` |
| `s3_key` | text null |
| `bytes` | bigint null |
| `sha256` | char(64) null |
| `row_counts` | jsonb null |
| `server_version` | varchar(20) null |
| `pg_dump_version` | varchar(40) null |
| `error` | text null (redacted ≤ 500) |
| `started_at`, `finished_at` | timestamptz |

Index `(tenant_id, status, finished_at DESC)`.

**`backup_drills`:**

| column | type / note |
|---|---|
| `id` | uuid PK |
| `run_at` | timestamptz |
| `actor` | varchar(80) |
| `mode` | `'control-plane-lookup'` \| `'s3-only'` |
| `tenant_id` | uuid null |
| `tenant_result` | `PASS` \| `MISMATCH` \| `FAIL:<stage>` \| `NO-ELIGIBLE-TENANT` |
| `control_plane_result` | as above |
| `tenant_key`, `control_plane_key` | text null |
| `duration_ms` | int |
| `old_objects` | int null |
| `detail` | text null |

**`backup_audits`:**

| column | type / note |
|---|---|
| `id` | uuid PK |
| `run_id` | varchar(80) |
| `run_at` | timestamptz |
| `oldest_object_at` | timestamptz null |
| `oldest_key` | text null |
| `objects_over_27_days` | int |
| `total_objects` | int |
| `total_bytes` | bigint |

**`restore_copies`** (**not** append-only: `closed_*` is set once):

| column | type / note |
|---|---|
| `id` | uuid PK |
| `created_at` | timestamptz |
| `actor` | varchar(80) |
| `target` | `'tenant'` \| `'control-plane'` |
| `tenant_id` | uuid null |
| `s3_key` | text |
| `backup_started_at` | timestamptz |
| `destination` | text (host/db, no credentials) |
| `destroy_by` | timestamptz |
| `closed_at` | timestamptz null |
| `closed_reason` | `'destroyed'` \| `'drill-dropped'` |

FKs: `backup_drills.tenant_id` and `restore_copies.tenant_id` reference `tenants.id` **ON DELETE CASCADE** (production tombstones and never deletes tenant rows, so this only affects tests, `lifecycle-helpers.ts:71-80`).

The tests mark their rows with `run_id`/`actor` starting `test-`, and clean them by that marker (§11).

### 6.2 The backup script (`scripts/db-backup.ts`; helpers in `scripts/lib/backup/`)
Run as `npm run db:backup` (`node --conditions=react-server --import tsx`).

**Environment.** Each one is fatal if missing **or empty**:
- `CONTROL_PLANE_DATABASE_URL`, `ENCRYPTION_KEY` (must be 64 hex characters; §3.1 note), `BACKUP_BUCKET`, `AWS_REGION` (= `us-east-1`);
- `BACKUP_PG_DUMP_BIN` (absolute; `--version` must start with `pg_dump (PostgreSQL) 16.`), `BACKUP_AGE_BIN` (default `age`).

The recipient comes from `ops/backup-recipient.txt` (`^age1[0-9a-z]{58}$`). The script loads **no dotenv** in Actions; locally it loads dotenv like its siblings, for `--dry-run`.

**Banner and masking:**
- when `GITHUB_ACTIONS === 'true'`, first print `::add-mask::` for the control-plane host and password;
- then print the banner with the label `control plane (masked)`;
- elsewhere, print `printTargetBanner()`.

The script is added to `ops-retention-scripts.test.ts:254` with that exception.

**Flags:**
- `--only control-plane|<slug>` (validated);
- `--dry-run`: targets and each server version; no dump, upload or write;
- `--if-missing-today`: the Q4 catch-up. When a control-plane `ok` row exists for today (UTC) it backs up **only the tenants whose newest row today is `failed`** (or which have no row today), and exits 0 if there are none. Otherwise it runs a full backup.
- `--concurrency N` (default 3).

**Order (a barrier):**
1. All tenant targets: `provisioning`, `active` or `suspended` with a non-null URL, by slug, run with the concurrency limit.
2. One retry round for failed tenants (new keys).
3. **When every tenant target and retry has settled, or at the latest T + 75 min** (job start + 75 min, whichever comes first): the control plane. A tenant still running at T + 75 continues, and the summary notes "control plane started before <slugs> finished". A control-plane dump missing a few tenant rows beats none.
4. One retry of the control plane if it failed **and at least 35 minutes remain** before the 120-minute job timeout, measured from the **job's** start (the workflow passes `JOB_STARTED_AT`, set in its first step), not the script's.

Tenants not yet started at T + 75 still run, after the control plane starts, inside the same concurrency limit.

So the control-plane dump contains this run's tenant rows. The status is re-read before each tenant starts; one now `deleting`/`deleted` is `skipped`.

**Seams:**
- `runBackup({ filter?: { tenantIds?: string[]; controlPlane?: boolean }, store: BackupStore, clock, runId, bins, controlPlaneDb })`;
- `BackupStore = { putStream(key, body, opts), putSmall(key, bytes, opts) }`, with S3 via lib-storage;
- tests inject a fake store and a filter (`test-lc-*` tenants only).

**Per target (`backupOne`), with a 30-minute wall-clock deadline.** When the deadline passes: kill both children, destroy the body, abort the upload, record `failed` with `deadline`. Child URLs (control plane and tenants alike, all via `toDirectConnectionUrl`) carry `connect_timeout=30&keepalives=1&keepalives_idle=30&keepalives_interval=10&keepalives_count=3`, so a half-open TCP connection fails fast.
1. **URL:**
   - decrypt (tenants) or take the secret (control plane), then `toDirectConnectionUrl`, for both;
   - take the password with `decodeURIComponent(new URL().password)` and remove it from the URL;
   - in Actions, print `::add-mask::` for the password and host;
   - children get only `{ PATH, HOME, LANG, PGPASSWORD }`; sslmode and options stay in the URL query.
2. **Snapshot:**
   - a direct `postgres` connection (`max: 1`, `connect_timeout: 30`);
   - check `server_version_num` is in 160000–169999, else `FAIL: server version`;
   - `pipelineStarted = false`; `pipelineDone = deferred()`;
   - `begin = sql.begin('isolation level repeatable read read only', async (tx) => { SET LOCAL idle_in_transaction_session_timeout = 0; SET LOCAL statement_timeout = 0; SET LOCAL lock_timeout = '60s'; snap = pg_export_snapshot(); rowCounts = count each base table (excluding pg_catalog, information_schema, pg_temp%, pg_toast%); pipelineStarted = true; Promise.resolve().then(() => startPipeline(snap)).then(pipelineDone.resolve, pipelineDone.reject); await pipelineDone.promise.catch(() => {}); })`;
   - `begin.catch((e) => { if (!pipelineStarted) pipelineDone.reject(e); })`;
   - **the outcome is `await pipelineDone.promise`**. A `begin` failure before the pipeline starts rejects it, and a failure after doesn't change it.
   - **The per-target deadline also rejects `pipelineDone`** (reason `deadline`), kills any children, and calls `sql.end({ timeout: 5 })`. So a stage stuck before the pipeline (a count waiting on a lock, despite `lock_timeout`) settles too. No path can hang.
3. **Pipeline** (`stream.pipeline` per hop; error listeners on every child stdio; stderr fully drained and the first 4 KB kept, redacted):
   - `pgDump = spawn(PG_DUMP, ['-Fc', '--no-owner', '--no-acl', '--lock-wait-timeout=60s', '--snapshot=' + snap, '--dbname=' + urlWithoutPassword], { env })`;
   - `ageProc = spawn(AGE, ['-r', RECIPIENT], { env: minimal })`;
   - `pgDump.stdout → ageProc.stdin`;
   - `ageProc.stdout` → the hashing `PassThrough` (SHA-256 and bytes) with `{ end: false }`. **The hashing stream is ended only after** pg_dump `close` = `(0, null)` **and** age `close` = `(0, null)`;
   - on any failure: kill both children, `hashing.destroy(err)` (the upload rejects before completing), `upload.abort()`;
   - upload: `store.putStream(key, hashing, { IfNoneMatch: '*', ChecksumAlgorithm: 'SHA256', partSize: 64 MiB, queueSize: 2, leavePartsOnError: false })`;
   - **success** = both children `(0, null)`, the upload resolved, and bytes ≥ 1024.
4. **Keys:** `v1/<target>/<id>/<YYYY>/<MM>/<DD>/<runId>-<rand8>.dump.age`, where `<id>` is the tenant uuid or `control-plane`. Sidecar: the same with `.manifest.json.age`.
5. **Sidecar:** `putSmall(sidecarKey, age(JSON))` with `IfNoneMatch: '*'`. The JSON: `{ v: 1, target, tenantId, slug, runId, key, bytes, sha256, rowCounts, serverVersion, pgDumpVersion, startedAt, finishedAt }`.
6. **Independent record**, as soon as **both** objects succeed: print and append to `$GITHUB_STEP_SUMMARY` `BACKUP <target> <id> <runId> <key> <sha256> <bytes>`.
7. **Row:** insert `database_backups` (`ok`, or `failed` with the redacted error). A failed insert leaves the target `failed` in the summary; the line from step 6 is printed again with `row-failed`.
8. **Retries:** a connection error before the pipeline gets one retry after 5 s, plus the barrier retry round. A 412 is recorded as `key-exists-or-retried`.

**End:** a table (no keys or URLs). Exit 1 if any target is still failed.

### 6.3 Redaction (`scripts/lib/backup/redact.ts`)
`redact(text)` masks postgres URLs, `password=…`, and the current target's password and host. It's applied to every error, stderr and stored field.

### 6.4 The workflow (`.github/workflows/db-backup.yml`)
```yaml
name: Database backups
on:
  schedule: [{ cron: '17 6 * * *' }, { cron: '17 18 * * *' }]   # 18:17 = catch-up (Q4)
  workflow_dispatch:
    inputs:
      only: { description: 'Optional: control-plane or one slug', required: false }
permissions: { contents: read }
concurrency: { group: "db-backup-${{ inputs.only && format('only-{0}', inputs.only) || 'all' }}", cancel-in-progress: false }
jobs:
  backup:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-24.04
    environment: production-backups
    timeout-minutes: 120
    permissions: { contents: read, id-token: write }
    steps:
      - uses: actions/checkout@<sha>
        with: { persist-credentials: false }
      - uses: actions/setup-node@<sha>        # node 22
      - run: npm ci --ignore-scripts
      - run: |
          sudo apt-get update && sudo apt-get install -y postgresql-common age
          sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
          sudo apt-get install -y postgresql-client-16
      - uses: aws-actions/configure-aws-credentials@<sha of v6>
        with: { role-to-assume: '${{ secrets.BACKUP_ROLE_ARN }}', aws-region: us-east-1, role-duration-seconds: 7200 }
      - run: |
          if [ -n "$ONLY" ]; then npm run db:backup -- --only "$ONLY"
          elif [ "$EVENT" = schedule ] && [ "$CRON" = '17 18 * * *' ]; then npm run db:backup -- --if-missing-today
          else npm run db:backup; fi
        env:
          ONLY: ${{ inputs.only }}
          EVENT: ${{ github.event_name }}
          CRON: ${{ github.event.schedule }}
          BACKUP_PG_DUMP_BIN: /usr/lib/postgresql/16/bin/pg_dump
          CONTROL_PLANE_DATABASE_URL: ${{ secrets.CONTROL_PLANE_DATABASE_URL }}
          ENCRYPTION_KEY: ${{ secrets.ENCRYPTION_KEY }}
          BACKUP_BUCKET: ${{ vars.BACKUP_BUCKET }}
          AWS_REGION: us-east-1
  old-objects:
    needs: backup
    if: always() && github.ref == 'refs/heads/main'
    runs-on: ubuntu-24.04
    environment: production-backups
    timeout-minutes: 10
    permissions: { contents: read, id-token: write }
    steps:
      - uses: actions/checkout@<sha>
        with: { persist-credentials: false }
      - uses: actions/setup-node@<sha>
      - run: npm ci --ignore-scripts
      - uses: aws-actions/configure-aws-credentials@<sha of v6>
        with: { role-to-assume: '${{ secrets.BACKUP_AUDIT_ROLE_ARN }}', aws-region: us-east-1, role-duration-seconds: 900 }
      - run: npm run db:backup-audit
        env:
          CONTROL_PLANE_DATABASE_URL: ${{ secrets.CONTROL_PLANE_DATABASE_URL }}
          BACKUP_BUCKET: ${{ vars.BACKUP_BUCKET }}
          AWS_REGION: us-east-1
```
- **`production-backups` must exist and be gated before this file reaches `main`** (§12 step 1; GitHub would otherwise auto-create it unprotected).
  - Gating: deployment branches Selected → `main`; no reviewers or wait timer.
  - Secrets: `CONTROL_PLANE_DATABASE_URL`, `ENCRYPTION_KEY`, `BACKUP_ROLE_ARN`, `BACKUP_AUDIT_ROLE_ARN`. Variable: `BACKUP_BUCKET`.
  - **The merge gate for this item** includes the product owner confirming that setting.
- **Trust policies** also require `job_workflow_ref` = `ccentofo/bytime/.github/workflows/db-backup.yml@refs/heads/main` (§4.1.3).
- **`db:backup-audit`** (`scripts/db-backup-audit.ts`) lists `v1/` (paginated, through a `BackupReader` seam) and inserts one `backup_audits` row. It needs no `ENCRYPTION_KEY`.
- **Pinning and imports:** actions are pinned to SHAs. `@aws-sdk/client-s3` and `@aws-sdk/lib-storage` are devDependencies imported only under `scripts/` (U6).

### 6.5 AWS (`ops/aws/`, placeholders)
- **`backup-bucket-policy.json`:**
  - Deny `*` when `aws:SecureTransport = false`;
  - Deny `s3:PutObject` + `{"Null": {"s3:if-none-match": "true"}, "Bool": {"s3:ObjectCreationOperation": "true"}}`;
  - Deny `s3:DeleteObject*` and `s3:PutLifecycleConfiguration` with `ArnNotLike aws:PrincipalArn <admin role ARN or SSO pattern>`.
- **`backup-lifecycle.json`:** `Expiration.Days = 25` on `v1/`; `AbortIncompleteMultipartUpload.DaysAfterInitiation = 1`.
- **Writer:** trust on `aud`, `sub = repo:ccentofo/bytime:environment:production-backups` and `job_workflow_ref` (as above); MaxSessionDuration 7200. Policy: `s3:PutObject` and `s3:AbortMultipartUpload` on `BUCKET/v1/*`.
- **Auditor:** the same trust. Policy: `s3:ListBucket` on `BUCKET` with `StringLike s3:prefix "v1/*"`.
- **Restore identity:** `s3:GetObject` on `BUCKET/v1/*`; `s3:ListBucket` with `StringLike s3:prefix "v1/*"`.
- **Bucket:** us-east-1; defaults; **versioning off**; separate account.
- **Budgets alert** at $10/month.
- **F10, stated honestly:** both roles are reachable from the one environment. The environment also holds the control-plane URL and `ENCRYPTION_KEY`, which means owner access to every tenant database. That's the same data exposure as `production`, minus its required reviewers, offset by the branch gate and `job_workflow_ref`.

### 6.6 Retention (Q1)
- **Lifecycle:** expires at creation + 25 days, rounded to midnight UTC (eligible within 26 days).
- **Deleted workspaces:** backups stop at `deleting` (re-read per target).
- **Daily audit:** the audit job records `oldest_object_at` and `objects_over_27_days`. The digest raises `backup-old-objects` when `oldest_object_at < now − 27 days`, or when there's no audit row in 30 h. The founder lists the objects with `db:restore --list-old` and deletes them with the admin role the same day.
- `BACKUP_RETENTION_DAYS` stays 30. `TENANT-DELETION.md` gains the S3 paragraph.

### 6.7 Monitoring (lifecycle route and digest)
**`BACKUPS_EXPECTED`:**
- `1` (production): the alert sync runs;
- `0` (staging): the sync **doesn't run**, and the digest prints "Backup monitoring is off on this deployment (BACKUPS_EXPECTED=0)". When `APP_ROOT_DOMAIN` is the production domain (`cadenzpoint.com`), that line also counts in `hasNews`, so a mistaken `0` in production isn't buried under "all quiet";
- anything else, when `NODE_ENV === 'production'`: the sync doesn't run, and the digest prints "**Backup monitoring is not configured (BACKUPS_EXPECTED)**", counted in `hasNews`;
- non-production local: silent.

**Module `src/lib/tenant/backup-status.ts`** (server-only):
- `readBackupFacts(now, filter?)`;
- the pure `backupFindings(facts, now)`;
- `syncBackupAlerts(now, filter?)`, where the filter `{ tenantIds, controlPlaneRunIds, drillActors, auditRunIds }` limits **both** facts and resolutions (tests).

**Scopes:**
- tenant findings use tenant scope (`tenantId`), so `resolveAlertsOfKind` and the `test-lc-*` cleanup work;
- control-plane and global findings use global scope, with dedup key `control-plane` or `''`.

| Finding | Condition | Alert (scope / dedup) |
|---|---|---|
| missed run (Q4) | no control-plane `ok` in 26 h | `backup-missed-run` (global) |
| stale tenant | the tenant has a non-null URL, was created over 36 h ago, and its newest `ok` is missing or older than 36 h | `backup-stale` (tenant) |
| failed | the target's newest row is `failed` | `backup-failed` (tenant, or global / `control-plane`) |
| drill overdue (Q3) | `max(first ok, last PASS)` + 21 days < now; never before the first `ok` | `backup-drill-overdue` (global) |
| drill failed | the newest drill row isn't PASS on both targets (`NO-ELIGIBLE-TENANT` counts as PASS for the tenant half) | `backup-drill-failed` (global) |
| old objects (Q1) | `oldest_object_at < now − 27 d`, or no audit row in 30 h | `backup-old-objects` (global) |
| restore copy overdue | an open `restore_copies` row past `destroy_by` | `restore-copy-overdue` (**global** / copy id) |

- **Wiring:** a step in `tenant-lifecycle/route.ts`, after `runLifecycleCron` and before signup maintenance:
  - `try { await syncBackupAlerts(now) } catch { best-effort raise global backup-check-failed; log }`;
  - each successful sync **resolves** `backup-check-failed`;
  - `backup-stale` and `backup-failed` for tenants no longer `provisioning`/`active`/`suspended` are resolved. The global `restore-copy-overdue` kind is never auto-resolved by status.
- **Digest section "Backups"** (try/catch):
  - one summary line ("N of M targets backed up in 26 h; newest control-plane backup <time>");
  - the OFF / not-configured line;
  - the "Backup status could not be read: <redacted>" line, which counts in `hasNews`;
  - all `esc()`d;
  - findings aren't repeated; they appear under "Unresolved alerts".
- **Timing:** checked at 13:00 UTC. One dropped 06:17 run is covered by the 18:17 catch-up. Two drops show as missed-run at the next digest.

### 6.8 Staging and local (Q2)
- **Staging:** `BACKUPS_EXPECTED=0`; no backup workflow (the environment is gated to `main`, production only). A one-off rehearsal (§12.3).
- **Local:** `npm run db:backup -- --dry-run` with `BACKUP_PG_DUMP_BIN=/opt/homebrew/opt/postgresql@16/bin/pg_dump`.

### 6.9 Restore and drill (`scripts/db-restore.ts`)
Run as `npm run db:restore`, on the founder's machine.

**Loads no dotenv.** It requires **`--control-plane env|none`**:
- `env` uses the exported `CONTROL_PLANE_DATABASE_URL` (refused if unset);
- `none` never touches a control plane.

It prints which mode it's in, and the banner (`printTargetBanner()`, or "no control plane"). Actor `founder:${USER}`.

**Environment:**
- `BACKUP_BUCKET`;
- AWS restore identity (profile chain);
- `BACKUP_AGE_KEY_FILE` (outside synced folders, on disk only while in use);
- `BACKUP_PG_RESTORE_BIN` (absolute, `16.`); `BACKUP_AGE_BIN`.

**Seams:** `verifyBackup(input, deps)` (steps 2–4) and `applyBackup(verified, destination, deps)` (steps 5–7), composed as `restoreOne`. `deps = { reader: BackupReader, controlPlane: Db | null, bins, clock }`, where `BackupReader = { list(prefix), get(key) }`. Tests call them in-process (and item 3c will reuse them).

**Modes:**
- `--target control-plane|<tenant uuid>|<slug, needs env> (--key K | --latest) --into <scratch url> [--expect-sha256 H] [--yes]`.
- `--drill --into-server <local server url> [--s3-only] [--yes]`:
  - requires `--control-plane env` (`none` refuses, since the result must be recorded). In `--s3-only` mode the object is chosen by listing alone, but its integrity is still checked against the control-plane row for that key. The disaster `--expect-sha256` path itself is exercised by 12.3;
  - restores a random tenant with an `ok` row in the last 36 h, picked from the control plane (or, with `--s3-only`, a random tenant prefix **holding an object from the last 36 h**, found by listing), **and** the control plane;
  - inserts a `restore_copies` row for each drill database at creation (`destroy_by` = creation + 1 day), and closes it `drill-dropped` when it's dropped. A crashed drill therefore leaves a tracked copy, which the next drill's sweep closes after dropping;
  - each goes into a fresh `cp_drill_<rand8>` database it creates and **drops in `finally`** (kill pg_restore first, then `DROP DATABASE … WITH (FORCE)`, name checked by regex);
  - SIGINT/SIGTERM handlers do the same;
  - at start it sweeps leftover `cp_drill_%` databases;
  - `--into-server` must be loopback.
- `--list-old`: read-only, objects under `v1/` older than 27 days.

**One restore:**
1. **Scratch guard:**
   - `--into` must be loopback (`isLoopbackUrl`); it's converted with `toDirectConnectionUrl`;
   - a missing **loopback** database is created (`CREATE DATABASE`);
   - the database must have no user tables;
   - print the plan and stop without `--yes`.
2. **Key choice and ownership:**
   - the key must match `^v1/tenant/<target uuid>/` (or `^v1/control-plane/control-plane/`) **before download**;
   - `--latest` picks the newest `.dump.age` under that prefix that has a sidecar;
   - with `env` and no `--key`/`--latest`: the newest `ok` row.
3. **Download** to `fs.mkdtemp` (0700).
4. **Integrity:**
   - decrypt the sidecar (exit 0);
   - require `sidecar.key == key`, `sidecar.target` and `sidecar.tenantId` equal to the target, and `sidecar.runId` equal to the key's run-id prefix;
   - compute the object's SHA-256 and require it to equal `sidecar.sha256`;
   - **and** one of: the control-plane row for that key (`env`), or `--expect-sha256` (from the run log's `BACKUP` line).
   - A missing row in `env` mode warns and falls back to requiring `--expect-sha256`. With neither, refuse: "Provide --expect-sha256 from the GitHub run log". This catches a forged pair.
5. `age -d` (exit 0), then `pg_restore --no-owner --no-acl --exit-on-error` (16, exit 0).
6. **Counts:** exact against `sidecar.rowCounts`, giving PASS or MISMATCH.
7. **`finally`:** delete the temp directory.
8. **Copies (not drills):**
   - in `env` mode, insert a `restore_copies` row with `destroy_by = min(sidecar.startedAt + BACKUP_RETENTION_DAYS, tenant.deletedAt + 30 d)`;
   - in `none` mode, print the destroy-by date and the command to register the copy later (`tenant:admin register-restore-copy …`), and instruct the founder to do so;
   - `tenant:admin restore-copy-destroyed <copy id> --yes` closes it;
   - `tenant:delete` refuses to apply while the tenant has open copies (§6.10).

**Drill recording:** once the drill has actually started (after `--yes`), insert a `backup_drills` row in `finally` with both results, the mode, keys, duration and `--list-old` count. Drills alternate `--s3-only` (the runbook says so; the reminder text names the next mode).

**Exit:** 0 only on PASS.

### 6.10 Restore copies and deletion; the disaster pointer
**Global scope.** `restore-copy-overdue` is a global alert (dedup = copy id). It isn't resolved by tenant deletion (`delete-tenant.ts:342-344` resolves tenant-scoped alerts only) or by the §6.7 status rule.

**Closing copies.** The generic `tenant:admin resolve-alert` (`admin-commands.ts:330-335`) refuses this kind and names `restore-copy-destroyed <copy id> --yes`.

**`tenant:delete`:**
- Before any state change (before its step 3, on a first run and on resume), it lists the tenant's open `restore_copies` and **refuses to apply** until they're closed.
- `scripts/delete-tenant.ts` prints the copies and the command; the digest's "Ready for deletion" line notes "blocked by <n> open restore copies"; `TENANT-DELETION.md` documents it.
- Drill copies are closed by the drill itself. A crashed drill's copy is closed by the next drill's sweep, or by `restore-copy-destroyed` after the founder drops the database.

**Disaster pointer (`RESTORE.md`).** A short "If a Neon project or the Neon account is lost" section:
1. Try Neon recovery (7 days; open a support ticket).
2. Restore the newest backup into a local scratch database with `db:restore --control-plane none --latest --expect-sha256 <from the run log>`, to confirm it's intact.
3. **Contact the lead:** relinking a workspace, or replacing the control plane, is item 3c's tooling.

## 7. State machines

### 7.1 One backup attempt (per target, per run)
| State | Event | Next | Side effects |
|---|---|---|---|
| queued | status re-read is `deleting`/`deleted` | skipped | none |
| start | server version not 16 | failed | `failed` row |
| start | connection error | retry after 5 s, then failed | `failed` row |
| start | `begin` rejects before the pipeline (count error, drop) | failed | `pipelineDone` rejected; `failed` row |
| dumping | any stage fails | failed | kill children; destroy the body; abort; `failed` row |
| dumping | both children `(0,null)` → body ended → upload resolves, ≥ 1024 bytes | uploaded | — |
| dumping | `begin` rejects after the pipeline started | (no change) | the outcome follows the pipeline |
| uploaded | sidecar fails | failed | dump object stays; `failed` row |
| uploaded + sidecar | row ok | ok | `BACKUP` line; `ok` row |
| uploaded + sidecar | row fails | failed (summary) | `BACKUP … row-failed` line; exit 1 |
| failed (tenant) | barrier retry round | queued (new key) | — |
| all tenants settled | — | control plane starts | — |
| any | job timeout or kill | none | parts aborted in 1 day; alerts |

### 7.2 Monitoring
The table in §6.7 is the state table: raised while true, resolved the first sync it's false. **Exception:** `restore-copy-overdue` closes only through `restore-copy-destroyed`.

## 8. Failure modes
| # | Failure | Behaviour |
|---|---|---|
| F1 | One scheduled run dropped | The 18:17 catch-up runs the backup (Q4). If both drop: `backup-missed-run` at the next digest. |
| F2 | Control plane unreachable from the runner | Fatal, exit 1; GitHub's email; missed-run alert. |
| F3 | A tenant unreachable | Retry after 5 s, then the barrier retry; `backup-failed`. The runbook: re-run with `only=<slug>` (its own concurrency group, so it doesn't replace a pending scheduled run). |
| F4 | pg_dump fails mid-stream | The end gate destroys the body, so no object completes. |
| F5 | age fails | Same; a bad recipient fails every target at start. |
| F6 | Row insert fails after upload | Objects and `BACKUP … row-failed` line exist; restorable with `--expect-sha256`. |
| F7 | OIDC session expiry | 7200 s ≥ 120 min. |
| F8 | Job timeout | Unreached targets alert. |
| F9 | 412 | `key-exists-or-retried`; retry with a new key. |
| F10 | Credentials leak via GitHub | Branch gate plus `job_workflow_ref`; honest scope in §6.5. |
| F11 | `ENCRYPTION_KEY` wrong or empty | Empty or non-hex is refused at start. A wrong key fails every tenant. |
| F12 | Leaked writer uploads junk | Budgets alert; random suffixes; junk expires in 25 days. |
| F13 | Over 625 GiB | `failed`. |
| F14 | Neon IP allow-list | None configured; noted in §12. |
| F15 | Restore into a non-empty, remote or live database | Scratch guard (loopback, empty). |
| F16 | Tampered, truncated or forged object | Ownership, sidecar, SHA and age checks, plus the row or `--expect-sha256`. |
| F17 | Deleted data past 30 days | 25-day rule plus the daily over-27-days check (Q1). |
| F18 | Monitoring misconfigured | OFF / not-configured lines; `backup-check-failed` (auto-resolves). |
| F19 | Overlapping runs | Concurrency groups; unique keys. |
| F20 | Wrong recipient | Committed file; a drill every 3 weeks < 25 days. |
| F21 | Drill fails | `backup-drill-failed` until PASS. |
| F22 | Restore copies left behind | Drills drop theirs; others are tracked by `restore_copies`, with an alert. |
| F23 | Actions minutes exhausted | Missed-run alert; §12 sets a budget. |
| F24 | `begin` connection drops | §6.2 step 2 (no hang). |
| F25 | Wrong tenant's backup in a restore | Key prefix plus sidecar `tenantId` refuse (invariant 9). |
| F32 | One tenant hangs (half-open TCP, a stalled PUT) | A per-target 30-minute deadline kills both children, destroys the body and aborts. TCP keepalives on the child URLs. The control plane starts by T+75 min regardless (§6.2). |
| F33 | Restore copies of a later-deleted workspace | The global alert survives deletion; `tenant:delete` refuses until copies are closed. |
| F29 | Migration lock during a dump | `--lock-wait-timeout=60s` fails the target, and the barrier retries. The runbook: no deploys at 06:17 or 18:17 UTC. |
| F30 | The environment auto-created unprotected | §12 order (create and gate before merge), the job-level `if`, `job_workflow_ref`. |

## 9. Platform limits
- **GitHub Actions:** minutes per run, about 2 runs a day (the catch-up usually exits in seconds); 120-minute timeout.
- **Neon:** CU-hours ≈ dump time + 5 min per tenant per day; transfer ≈ uncompressed size per day.
- **S3:** under $5/month.
- **Runner memory:** lib-storage buffers about (queueSize + 1) × 64 MiB per upload, about 576 MiB at concurrency 3 (the runner has 7 GB).
- **Vercel:** isolated reads in the daily cron.

## 10. Blast radius

### 10.1 Changed or new
| File | Change |
|---|---|
| migration + `src/db/control-plane/schema.ts` | 4 tables |
| `scripts/db-backup.ts`, `db-backup-audit.ts`, `db-restore.ts`, `scripts/lib/backup/*` | **new** |
| `ops/backup-recipient.txt`, `ops/aws/*.json` | **new** |
| `scripts/tenant-admin.ts` (+ header usage), `src/lib/tenant/admin-commands.ts` | `register-restore-copy`, `restore-copy-destroyed`; `show` lists the newest backup per target, the newest drill and open copies |
| `src/lib/tenant/backup-status.ts` | **new** |
| `src/app/api/cron/tenant-lifecycle/route.ts` | the isolated backup step |
| `src/lib/tenant/ops-digest.ts` | Backups section |
| `src/lib/tenant/delete-tenant.ts`, `scripts/delete-tenant.ts` | dry run and apply list open restore copies; apply refuses until they're closed (before any state change, first run and resume) |
| `src/lib/tenant/admin-commands.ts` (`resolveAlertById`) | refuses `restore-copy-overdue` |
| `TENANT-DELETION.md` | the refusal and how to clear it |
| `src/__tests__/integration/lifecycle-helpers.ts` | cleanup tolerates the new cascading FKs (no change needed beyond a check) |
| `.github/workflows/db-backup.yml` | **new** |
| `.github/workflows/ci.yml` | integration job on `ubuntu-24.04`; installs `postgresql-client-16`; sets `REQUIRE_PG16_TOOLS=1`, `BACKUP_PG_DUMP_BIN` and `BACKUP_PG_RESTORE_BIN` to `/usr/lib/postgresql/16/bin/…` |
| `package.json` | scripts `db:backup`, `db:backup-audit`, `db:restore`; devDependencies |
| `.env.example` | `BACKUPS_EXPECTED` |
| Tests | `ops-retention-scripts.test.ts:254` (banner list); `signup-ops.test.tsx:171-189` (mock `backup-status`, order); `ops-digest-alerts.test.ts` (stub the new queries; all-quiet text); `tenant-notices.test.ts:272`, `seat-sync.test.ts:308` (digest calls: `BACKUPS_EXPECTED` unset in tests, so no section) |
| `RESTORE.md` | S3 restore, the disaster pointer (§6.10), the 3-weekly drill; `:80-83` unchanged |
| `TENANT-DELETION.md` | S3 paragraph |
| `PRODUCTION-DEPLOY.md` | new Phase "Backups (AWS)"; Phase 15 row done (citing §5's "no new retention period"); Operations daily and 3-weekly; env table `BACKUPS_EXPECTED`; no deploys at 06:17/18:17 UTC |

### 10.2 Checked, unchanged
- app request paths;
- `migrate-all.ts`;
- the privacy page;
- the business draft's subprocessor table (a business item, §12).

## 11. Required tests (each must fail without the change it proves)
**Tools:** S6 and S10 need pg 16 `pg_dump` and `pg_restore` via `BACKUP_PG_*_BIN`. With `REQUIRE_PG16_TOOLS=1` (CI and the §13.2 command) a missing or wrong tool **fails**; the tests skip only when it's unset. `age` is faked: an identity transform with exit control.

**Isolation:**
- tests use `test-lc-*` tenants, a `test-` run id or actor, and the filters;
- `afterEach` removes `database_backups`, `backup_drills`, `backup_audits` and `restore_copies` rows with the test marker, plus the global alert kinds `backup-missed-run`, `backup-drill-overdue`, `backup-drill-failed`, `backup-old-objects`, `backup-check-failed`, and `backup-stale`/`backup-failed`/`restore-copy-overdue` with dedup key `control-plane` or a test id;
- no test calls the whole lifecycle route.

**Unit:**
- **U1:** keys (format, UTC, random suffix, the sidecar key).
- **U2:** `redact`; password split and decode; minimal child env.
- **U3:** `backupFindings`: every §6.7 row, plus new tenant, null-URL provisioning, a tenant leaving active (stale and failed resolved, `restore-copy-overdue` kept), the drill anchor, and `NO-ELIGIBLE-TENANT`.
- **U4:** end gate: the body ends only after both `(0,null)`; any failure destroys it.
- **U5:** recipient file; `--only`; empty env and non-hex key refused.
- **U6:** static checks:
  - no `src/` import of `@aws-sdk/*`;
  - the workflow pins SHAs, has `if: github.ref == 'refs/heads/main'` on both jobs, `id-token` only at job level, `persist-credentials: false`, `--ignore-scripts`, no `inputs.*` in `run:`, and both crons.
- **U7:** scratch and drill-server guard (loopback incl. `[::1]`; non-empty refused).
- **U8:** count comparison.
- **U9:** digest Backups section: summary, the `0` line, the not-configured line (unset or `2` in production), silent in development, no duplication, `esc()`, "could not be read" in `hasNews`.
- **U10:** the route order with `vi.doMock` (signup-ops pattern): the backup step sits between lifecycle and signup maintenance. A throwing step still lets the digest run, and `backup-check-failed` is raised.
- **U11:** key ownership: `restoreOne` refuses another tenant's prefix, a sidecar with a different `tenantId`/`target`/`runId`, and a missing `--expect-sha256` when no row exists.

**Integration** (fake store and reader, fake age, filters):
- **S1:** two `test-lc-*` tenants (one `suspended`) plus the control plane. pg_dump is faked here; row counts come from the snapshot query, which is real:
  - `ok` rows, sidecars, SHA-256 equal to the stored bytes, exact counts;
  - a `deleting` tenant skipped;
  - `BACKUP` lines;
  - **the control plane starts only after all tenant work** (the store records order), and its row counts include this run's tenant rows.
- **S2:** fake pg_dump exits 1 mid-stream → `failed`; **the store never saw end-of-stream**; exit 1.
- **S2b:** a fake pg_dump that hangs → killed at the (test-shortened) per-target deadline → `failed` with `deadline`.
- **S1b:** with one tenant hung past the (test-shortened) T + 75 deadline, the control plane still runs, and the summary names the unfinished slug.
- **S3:** fake age exits 1 → the same.
- **S4:** the store rejects 412 → `key-exists-or-retried`; the barrier retry with a new key → `ok`.
- **S5:** row insert fails → summary failed; the `row-failed` line.
- **S6:** **real pg_dump 16**. A wrapper inserts and **commits** rows into the test database **after** the counts and **before** it execs pg_dump. The restored counts equal the snapshot counts and exclude the inserted rows. (Without `--snapshot` this fails.)
- **S7:** connection error then ok; two errors → failed. A count-query error before the pipeline → failed **with no hang** (a test timeout of 10 s).
- **S8:** redaction of stderr.
- **S9:** `syncBackupAlerts(now, filter)` with `BACKUPS_EXPECTED=1`: each §6.7 finding raised and resolved; `0` → nothing synced.
- **S10:** `restoreOne` with `controlPlane: null` on a file it builds itself (real pg_dump and pg_restore 16) → PASS with `--expect-sha256`. Tampered → refused. `--drill` creates and drops `cp_drill_*` (none remain) and records a `backup_drills` row; a forced pg_restore failure → `FAIL:pg_restore`; plan-only (no `--yes`) records nothing.
- **S16:** `tenant:delete` refuses to apply (no state change, first run and resume) while the tenant has an open restore copy, and lists the command. A tenant tombstoned **by SQL** with an open copy past `destroy_by` keeps `restore-copy-overdue` open (global). The generic `resolve-alert` refuses `restore-copy-overdue`.
- **S18:** a count query hanging on a lock → the per-target deadline settles the target `failed` (`deadline`), with no hang.
- **S12:** a wrong `ENCRYPTION_KEY` → tenants `failed`, the control plane `ok`.
- **S13:** `db:backup-audit` with a fake reader → a correct `backup_audits` row.
- **S14:** `restore_copies`: `destroy_by` = min(backup + 30, deletion + 30); overdue alert; `restore-copy-destroyed` closes it; a copy opened for an already-deleted (tombstoned) tenant keeps its global alert.
- **S15:** `--if-missing-today`: today's control-plane `ok` exists and no tenant failed today → exit 0 with no work; one tenant failed today → only that tenant runs; no control-plane `ok` today → a full run.

## 12. Founder steps (PRODUCTION-DEPLOY, new Phase "Backups (AWS)"), **in this order**
1. **Before merging this item:**
   - in GitHub, **create** environment `production-backups` (or edit it if it exists): Deployment branches → **Selected → `main`**; no reviewers or wait timer;
   - add the secrets and variable as you go (step 6);
   - **merge only after this is confirmed** (part of the merge gate).
2. **AWS:**
   - create an account separate from Vercel and Neon (root MFA, admin role);
   - create the bucket in us-east-1 (defaults, versioning off);
   - apply **`backup-lifecycle.json` first**, then `backup-bucket-policy.json`;
   - set the Budgets alert at $10.
3. **IAM:**
   - the OIDC provider;
   - the writer and auditor roles (trusts with `sub` **and** `job_workflow_ref`);
   - the restore identity (MFA).
4. **Keys:**
   - `brew install age postgresql@16`;
   - turn on FileVault (Q3);
   - `age-keygen -o cadenzpoint-backup.key` outside synced folders;
   - store the key in the password manager plus one offline copy, then delete the file;
   - commit the `age1…` recipient to `ops/backup-recipient.txt` in a PR.
5. **Merge and deploy** (the migration applied).
6. **GitHub:**
   - secrets `CONTROL_PLANE_DATABASE_URL`, `ENCRYPTION_KEY` (production), `BACKUP_ROLE_ARN`, `BACKUP_AUDIT_ROLE_ARN`; variable `BACKUP_BUCKET`;
   - an Actions spending budget;
   - log retention of at least 30 days (Settings → Actions → General).
7. **First run:** Actions → Run workflow. Expect both jobs green and `BACKUP` lines. If AWS denies the role, read the `sub` and `job_workflow_ref` claims in CloudTrail and fix the trust.
8. **Vercel:** `BACKUPS_EXPECTED=1` in production and `0` in staging, **then redeploy both**.
9. **First drill:** run `BACKUP_AGE_KEY_FILE=… BACKUP_BUCKET=… AWS_PROFILE=<restore> CONTROL_PLANE_DATABASE_URL=<prod> BACKUP_PG_RESTORE_BIN=/opt/homebrew/opt/postgresql@16/bin/pg_restore npm run db:restore -- --control-plane env --drill --into-server postgres://bytime:bytime_dev@localhost:5432/postgres --yes`. Expect PASS on both. Delete the key file.
10. **Business side:** add AWS to the business privacy-policy draft's subprocessors.
11. **Neon IP allow-lists:** if one is ever enabled, allow GitHub's ranges.

**12.3 Staging rehearsal (once):**
1. A test bucket and test key.
2. `db:backup -- --only <staging slug>` with your profile.
3. `db:restore -- --control-plane none --target <uuid> --latest --expect-sha256 <from the output> --into postgres://bytime:bytime_dev@localhost:5432/rehearsal --yes` → PASS (the loopback database is created if missing).
4. Delete the test bucket.

## 13. Verification
1. `npx tsc --noEmit`, `npm run lint`, `npm run test`, `npm run test:tz`, `npm run db:safety`.
2. On the product owner's machine, run `npm run db:migrate:cp`, then the memory-noted integration command with `REQUIRE_PG16_TOOLS=1 BACKUP_PG_DUMP_BIN=/opt/homebrew/opt/postgresql@16/bin/pg_dump BACKUP_PG_RESTORE_BIN=/opt/homebrew/opt/postgresql@16/bin/pg_restore`.
3. **The lead's checks file** (local, no AWS):
   - `--dry-run`;
   - `syncBackupAlerts` via SQL fixtures marked `test-`, and the digest section through a local production server with `BACKUPS_EXPECTED` set to `1`, `0`, then unset;
   - `db:restore` refusals and an S3-free restore of an integration-built file;
   - Real AWS is proven at §12 steps 7 and 9, and at 12.3.

## 14. Hand-off rules (in addition to `BLUEPRINT-STANDARD.md` §3)
- Impact analysis first; stop for the lead's review.
- Never print or store a secret; no real ARNs committed.
- No real AWS or Neon in tests (the seams). Tests touch only marked rows and `test-lc-*` tenants.
- Stage files by name.

## 15. Pre-mortem log
**Round 1** (2 reviewers, on v1): 2 HIGH (the same one twice), about 16 MEDIUM. Fixed in v2:
- control plane last;
- sidecars;
- restore from S3 alone;
- branch gate;
- committed recipient;
- drill every 3 weeks;
- the relink taken to the product owner;
- restore copies;
- missed-run alert;
- fail-loud monitoring;
- isolation;
- drill PASS/FAIL;
- test isolation;
- pg 16 tools;
- end gate;
- honest Q1.

**Round 2** (2 fresh reviewers, on v2): **2 HIGH, about 17 MEDIUM, about 27 LOW.** Fixed in v3:
- **HIGH — cross-tenant relink and shared-project deletion:** the generic `set-database-url` is replaced by `rebuild-database`. It always creates a fresh project for the workspace through the provisioning helper, accepts only that tenant's key prefix and sidecar, and guards shared project ids and hosts (§6.10, S11, U11).
- **MEDIUM fixes:**
  - no hang when `begin` fails before the pipeline;
  - the environment created and gated before merge, plus the job-level `if` and `job_workflow_ref`;
  - Q1 threshold 27 days with honest bounds;
  - a real barrier so the control plane follows every tenant and retry;
  - restore-copy anchoring, relink handling, control-plane copies (the `restore_copies` table);
  - no dotenv in `db:restore`, with explicit `--control-plane env|none`; rebuild proves the key;
  - old project tracked;
  - the control-plane disaster runbook (pause crons, redeploy, Stripe reconcile);
  - `BACKUPS_EXPECTED` gates the sync, and `0` is shown;
  - test isolation (filters, markers, cleanup lists, no full-route test);
  - S6 inserts before pg_dump;
  - Q4 adds recovery first and the notice-versus-consent decision;
  - the `BackupReader` seam and dependency-injected rebuild.
- **LOW fixes:**
  - `--expect-sha256` and the sidecar run id;
  - the restore list condition;
  - proof replaced by construction;
  - banner masking;
  - the `row-failed` line;
  - `--lock-wait-timeout`;
  - drill-server safety and the sweep;
  - alternating S3-only drills;
  - a separate concurrency group for `only` runs;
  - redeploy after env changes;
  - log retention;
  - honest F10 for the auditor;
  - the rebuild checkout check;
  - `backup-check-failed` resolves;
  - null-URL provisioning;
  - alert overlap;
  - alert scopes;
  - drill recording details;
  - copy disposal by id;
  - Q3 recording location;
  - the 18:17 catch-up (RPO);
  - retry order;
  - blast-radius test files;
  - CI binary paths;
  - founder-step URLs and redeploys;
  - FileVault.

**Confirmation pass 1** (one fresh reviewer, on v3): 8 MEDIUM, 16 LOW; no HIGH. Fixed in v3.1:
- **MEDIUM fixes:**
  - copy and rebuild alerts made global, so they survive deletion, and `tenant:delete` refuses while they're open;
  - the orphan alert raised right after project creation;
  - an automatic 8-day watch on the old project;
  - **no rebuild while the original project exists** (the flag removed; stated in Q4);
  - the suspend step removed from runbook A (it's a policy hold that emails customers);
  - a per-target 30-minute deadline, TCP keepalives, and the control plane starting by T + 75 min;
  - the step 8 compare against the step 1 values;
  - runbook B reconciles deletions in the window, and rebuild refuses closed workspaces or past deletion dates.
- **LOW fixes:**
  - `NEON_API_KEY` required, with null-id and loopback refusals;
  - `verifyBackup` / `applyBackup` split;
  - `--no-copy-record` for the control-plane relink;
  - drill copies tracked and closed `drill-dropped`;
  - the unreachable stale control-plane row removed;
  - per-slug concurrency groups;
  - production-domain `0` counted in `hasNews`;
  - the notice names what a rebuild undoes;
  - `git fetch` with refusal on mismatch;
  - the memory figure corrected;
  - the control-plane URL goes direct;
  - FK specs;
  - S1 fake versus real stated;
  - drill-mode edge cases;
  - loopback database auto-create;
  - citations.

**Confirmation pass 2** (one fresh reviewer, on v3.1): 4 MEDIUM, 11 LOW; no HIGH. Fixed in v3.2:
- **MEDIUM fixes:**
  - a `retombstone` command for workspaces deleted in a control-plane backup's lost window (runbook B.4);
  - the old-project watch as an isolated sub-step with timeouts and its own failure alert;
  - `tenant:delete` refuses only on open copies, orphans and pending projects (not the watch); verified close commands; the generic `resolve-alert` refuses these kinds;
  - a reconcile procedure for a returned old project (runbook A.6), with re-enter versus export in Q4 and `--reconciled-note`.
- **LOW fixes:**
  - the deadline settles a pre-pipeline hang, plus `lock_timeout`;
  - the `onProjectCreated` callback;
  - test matrix updates (S11b, S16–S18, cleanup kinds);
  - the deployed-commit check uses the last successful `deploy-prod` run;
  - watch semantics stated;
  - the control-plane retry needs 35 minutes left;
  - the 404 confirmed at 12.3, and the account-loss note;
  - blast radius;
  - staging watch handling;
  - `--s3-only` integrity source;
  - 12.3 as a production-readiness gate.

**Confirmation pass 3** (one fresh reviewer, on v3.2): 6 MEDIUM, 12 LOW; no HIGH. **All six MEDIUMs were in the disaster tooling:**
- runbook B's cron pause and redeploy path;
- 404 as proof of absence;
- retombstone's safety;
- workspaces created in the lost window;
- the deployed-commit check.

The backup pipeline, key ownership, IAM/OIDC and monitoring held up, as in the passes before.

**Scope split (product owner, 2026-11-15, recommended by the lead):** the disaster tooling moves to item **3c**, a separate blueprint whose starting point is v3.2 (commit `95d8bfe`). Pass 3's MEDIUMs and the relevant LOWs are carried into 3c's brief in `LAUNCH-TRACKER.md`.

v4 removes from this item:
- `rebuild-database`, `retombstone`, the old-project watch, the orphan alerts;
- runbook A/B (replaced by the disaster pointer in §6.10);
- Q4, the disaster exception (it moves to 3c; the old Q5 is now Q4).

v4 keeps restore into loopback scratch databases, restore copies and the deletion refusal.

**Pass-3 LOWs that apply to the core, written in:**
- the control-plane retry is timed from the job's start;
- the catch-up retries tenants that failed that day;
- drill copies get a 1-day `destroy_by`.
