# Database backups (build queue 3b)

> **Status:** **DRAFT v3**, 2026-11-15, lead architect.
> - Round 1 (2 HIGH, about 16 MEDIUM) is fixed in v2.
> - Round 2 (2 HIGH, about 17 MEDIUM) is fixed in v3. The disaster relink is redesigned as a narrow `rebuild-database` command (§15).
> - Confirmation pass pending.
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
> - LB-D6 (`feature-plan-launch-blockers.md:40,380`; `RESTORE.md:80-83`): "No `set-db-url` command"; the live database is never swapped for a restored branch. Q4 asks to allow one narrow exception.
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
4. **`tenant:admin rebuild-database` (Q4):** for a lost tenant database only. It creates a **fresh Neon project for that workspace** (the provisioning code), restores **that workspace's** backup, migrates, verifies, then relinks. The old project is tracked until it's deleted. Plus the disaster runbook, including the control plane.
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
| Q4 | **Disaster rebuild (an exception to LB-D6).** When a tenant's Neon project is lost, restoring within 1 business day needs a way to point the workspace at a rebuilt database. A backup can be up to 24 h old, so entries made since are lost. LB-D6 required written consent before *overwriting* time records in an in-place restore. Here nothing is overwritten (the original is gone), but entries are lost. | **Add `tenant:admin rebuild-database`, used only when a project is lost:** <br>1. **Try Neon recovery first.** Neon keeps a deleted project recoverable for 7 days (`neon.ts:198`). Rebuild only if recovery isn't possible within **4 business hours**. <br>2. **A notice, not consent:** waiting for consent would block the 1-day restore. The notice (template in `RESTORE.md`) names the backup time and the lost window. <br>3. **If the old project ever comes back,** it's tracked and must be deleted or reconciled; an open alert stays until then. | §6.10 |
| Q5 | **Alerting on one missed run.** §5's 36 h rule only fires after two missed runs (backups 06:17 UTC, digest 13:00). | **Also alert when there's no successful control-plane backup in 26 h** at digest time. Add a **catch-up run at 18:17 UTC** that exits immediately if today's control-plane backup already succeeded, so one dropped run doesn't cost a day of RPO. | §6.4, §6.7 |

Design choices stated for the record (engineering's call within §5):
- **Runner:** GitHub Actions, scheduled.
- **Time:** 06:17 UTC, plus the 18:17 catch-up (Q5).
- **Coverage:**
  - `provisioning` tenants with a URL are backed up (§5's literal skip list), and the stale rule ignores tenants created under 36 h ago and tenants with no URL;
  - demo workspaces are included.
- **Existing drill:** the existing monthly Neon branch drill stays unchanged.

## 3. Verified current state (2026-11-15, `main` at `c416049`)

### 3.1 Databases
- **One Neon project per tenant:** `createNeonDatabase(slug)` (`src/lib/tenant/neon.ts:47-…`) creates the project with `pg_version: 16`, `history_retention_seconds` and the region (`:63-74`), and returns `{ dbUrl, neonProjectId }`.
- **Neon helpers:**
  - `findNeonProjectIdByName` (`:285-297`) returns the first name match;
  - `deleteNeonProjectVerified` (`:200-236`) checks that the tenant's endpoint host belongs to the project, and that the project isn't the control plane's (`:224-226`), then deletes the whole project;
  - `neonProjectExists` (`:238`);
  - `directNeonHost` (`:187`);
  - a deleted project is recoverable for 7 days (`:198`).
- **Control plane:** Postgres 16 per `PRODUCTION-DEPLOY.md:272`, not enforced in code.
- **Stored URLs** use the pooled host; `toDirectConnectionUrl` (`migrate-tenant.ts:18-30`).
- **`migrateTenantDatabase(url)`** (`:33-…`) runs `./drizzle` from the current checkout; `getPendingMigrationCount` is exported.
- **Encryption:** tenant URLs are AES-256-GCM. `encryption.ts:20-23` derives any non-hex key in non-production, so a wrong or dev key is **not detected**. Writes must prove the key (§6.10).
- **Statuses** (`schema.ts:4-10`): `provisioning`, `active`, `suspended`, `deleting`, `deleted`. A crashed provisioning leaves `provisioning` with no URL (`provision.ts:44,68-74`).
- **`tenant:delete`:**
  - classifies by `neon_project_id` (`delete-tenant.ts:99-100`);
  - refuses when another workspace shares the URL (`:216-226`, and on a decrypt failure `:220-224`), or when the project is missing (`:236-245`);
  - deletes by `neon_project_id` (`:325-327`);
  - the deletion receipt lists founder exports (`:361-380`).
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
7. **Restores write only to scratch databases they create, or that are proven empty.** `rebuild-database` writes only to a project **it just created for that workspace**.
8. **Monitoring fails loudly.**
9. **Tenancy:** a tenant restore or rebuild accepts only that tenant's own backup (key path **and** sidecar `tenantId`). A rebuilt database always lives in a project of its own.
10. **Nothing writes `db_url_encrypted` with an unproven `ENCRYPTION_KEY`.**

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
| `closed_reason` | `'destroyed'` \| `'relinked'` \| `'drill-dropped'` |

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
- `--if-missing-today`: Q5 catch-up; exits 0 at once when a control-plane `ok` row exists for today (UTC);
- `--concurrency N` (default 3).

**Order (a barrier):**
1. All tenant targets: `provisioning`, `active` or `suspended` with a non-null URL, by slug, run with the concurrency limit.
2. One retry round for failed tenants (new keys).
3. **Only when every tenant target and retry has settled:** the control plane.
4. One retry of the control plane if it failed.

So the control-plane dump contains this run's tenant rows. The status is re-read before each tenant starts; one now `deleting`/`deleted` is `skipped`.

**Seams:**
- `runBackup({ filter?: { tenantIds?: string[]; controlPlane?: boolean }, store: BackupStore, clock, runId, bins, controlPlaneDb })`;
- `BackupStore = { putStream(key, body, opts), putSmall(key, bytes, opts) }`, with S3 via lib-storage;
- tests inject a fake store and a filter (`test-lc-*` tenants only).

**Per target (`backupOne`):**
1. **URL:**
   - decrypt, `toDirectConnectionUrl`;
   - take the password with `decodeURIComponent(new URL().password)` and remove it from the URL;
   - in Actions, print `::add-mask::` for the password and host;
   - children get only `{ PATH, HOME, LANG, PGPASSWORD }`; sslmode and options stay in the URL query.
2. **Snapshot:**
   - a direct `postgres` connection (`max: 1`, `connect_timeout: 30`);
   - check `server_version_num` is in 160000–169999, else `FAIL: server version`;
   - `pipelineStarted = false`; `pipelineDone = deferred()`;
   - `begin = sql.begin('isolation level repeatable read read only', async (tx) => { SET LOCAL idle_in_transaction_session_timeout = 0; SET LOCAL statement_timeout = 0; snap = pg_export_snapshot(); rowCounts = count each base table (excluding pg_catalog, information_schema, pg_temp%, pg_toast%); pipelineStarted = true; startPipeline(snap).then(pipelineDone.resolve, pipelineDone.reject); await pipelineDone.promise.catch(() => {}); })`;
   - `begin.catch((e) => { if (!pipelineStarted) pipelineDone.reject(e); })`;
   - **the outcome is `await pipelineDone.promise`**. A `begin` failure before the pipeline starts rejects it, and a failure after doesn't change it. No path can hang.
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
  schedule: [{ cron: '17 6 * * *' }, { cron: '17 18 * * *' }]   # 18:17 = catch-up (Q5)
  workflow_dispatch:
    inputs:
      only: { description: 'Optional: control-plane or one slug', required: false }
permissions: { contents: read }
concurrency: { group: "db-backup-${{ inputs.only && 'only' || 'all' }}", cancel-in-progress: false }
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
- `0` (staging): the sync **doesn't run**, and the digest prints "Backup monitoring is off on this deployment (BACKUPS_EXPECTED=0)";
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
| missed run (Q5) | no control-plane `ok` in 26 h | `backup-missed-run` (global) |
| stale tenant | the tenant has a non-null URL, was created over 36 h ago, and its newest `ok` is missing or older than 36 h | `backup-stale` (tenant) |
| stale control plane | the newest `ok` is older than 36 h, **and** missed-run isn't open | `backup-stale` (global / `control-plane`) |
| failed | the target's newest row is `failed` | `backup-failed` (tenant, or global / `control-plane`) |
| drill overdue (Q3) | `max(first ok, last PASS)` + 21 days < now; never before the first `ok` | `backup-drill-overdue` (global) |
| drill failed | the newest drill row isn't PASS on both targets (`NO-ELIGIBLE-TENANT` counts as PASS for the tenant half) | `backup-drill-failed` (global) |
| old objects (Q1) | `oldest_object_at < now − 27 d`, or no audit row in 30 h | `backup-old-objects` (global) |
| restore copy overdue | an open `restore_copies` row past `destroy_by` | `restore-copy-overdue` (tenant, or global / copy id) |

- **Wiring:** a step in `tenant-lifecycle/route.ts`, after `runLifecycleCron` and before signup maintenance:
  - `try { await syncBackupAlerts(now) } catch { best-effort raise global backup-check-failed; log }`;
  - each successful sync **resolves** `backup-check-failed`;
  - backup alerts of tenants no longer `provisioning`/`active`/`suspended` are resolved.
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

**Seams:** `restoreOne(input, deps: { reader: BackupReader, controlPlane: Db | null, bins, clock })`, where `BackupReader = { list(prefix), get(key) }`. Tests call it in-process.

**Modes:**
- `--target control-plane|<tenant uuid>|<slug, needs env> (--key K | --latest) --into <scratch url> [--expect-sha256 H] [--yes]`.
- `--drill --into-server <local server url> [--s3-only] [--yes]`:
  - restores a random tenant with an `ok` row in the last 36 h, picked from the control plane (or, with `--s3-only`, a random tenant prefix from the list), **and** the control plane;
  - each goes into a fresh `cp_drill_<rand8>` database it creates and **drops in `finally`** (kill pg_restore first, then `DROP DATABASE … WITH (FORCE)`, name checked by regex);
  - SIGINT/SIGTERM handlers do the same;
  - at start it sweeps leftover `cp_drill_%` databases;
  - `--into-server` must be loopback.
- `--list-old`: read-only, objects under `v1/` older than 27 days.

**One restore:**
1. **Scratch guard:**
   - `--into` must be loopback unless `--allow-remote-scratch`; it's converted with `toDirectConnectionUrl`;
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
   - the deletion receipt (`delete-tenant.ts:361-380`) lists the tenant's open copies.

**Drill recording:** once the drill has actually started (after `--yes`), insert a `backup_drills` row in `finally` with both results, the mode, keys, duration and `--list-old` count. Drills alternate `--s3-only` (the runbook says so; the reminder text names the next mode).

**Exit:** 0 only on PASS.

### 6.10 Disaster rebuild (Q4): `tenant:admin rebuild-database <slug>`
**Inputs:** `--key <backup key> | --latest`, `--expect-sha256 <from run log>` (required unless the control-plane row exists), `[--old-project-still-exists] [--yes]`.

**Environment:** production `CONTROL_PLANE_DATABASE_URL`, `ENCRYPTION_KEY` (**64 hex**), `NEON_API_KEY`, `NEON_REGION_ID`, the restore AWS identity, `BACKUP_AGE_KEY_FILE`, `BACKUP_PG_RESTORE_BIN`. Run from a checkout of `main` at the deployed commit (it migrates with `./drizzle`); it checks `git rev-parse HEAD` against `origin/main` and warns if they differ.

**Steps** (it refuses unless every check holds):
1. **Key proof:**
   - the tenant is `active` or `suspended`;
   - `decrypt(current db_url_encrypted)` must succeed, proving `ENCRYPTION_KEY` (invariant 10). For a lost project the URL still decrypts.
2. **Old project:** `neonProjectExists(old id)` must be **false** (404) unless `--old-project-still-exists` is given. Q4 says: try Neon's recover first. When the flag is given, the command records the old id and raises a `rebuild-old-project-pending` alert (tenant, dedup old id), resolved only by `tenant:admin old-project-deleted <slug> <id> --yes`.
3. **Backup ownership and integrity:** `restoreOne` checks as in §6.9 steps 2–4 for **this tenant's** prefix and sidecar.
4. **Create** a **new** Neon project: `createNeonDatabase(slug, { projectNameSuffix: '-r' + yyyymmdd })`. That's version 16, policy history retention, `NEON_REGION_ID`, and `tenantDatabaseName(slug)`, a project of its own by construction.
5. **Restore** into its direct URL (§6.9 steps 5–6) and require PASS.
6. **Migrate** with `migrateTenantDatabase(newUrl)`, then require `getPendingMigrationCount(newUrl) === 0`.
7. **Guards:**
   - the new endpoint host belongs to the new project and isn't the control plane's (mirror `neon.ts:224-226`);
   - no other non-deleted tenant has the new `neon_project_id`, or a URL whose `directNeonHost` equals it;
   - a decrypt failure on any other row refuses, as `delete-tenant.ts:220-224` does.
8. **On `--yes`** (before it, print the plan and stop):
   - under the tenant lock with the version guard, write `db_url_encrypted = encrypt(pooled url)` and `neon_project_id = new id`;
   - audit `database-rebuilt` (detail: old and new project, backup key, sha256, backup time);
   - close nothing in `restore_copies` (none was created; the restore went straight into the live project);
   - print "the app switches within 60 s (registry cache)" and the **customer notice reminder**.
9. **Failure after step 4:** the new project stays (it isn't linked). The command prints its id and a `tenant:admin` hint, and raises `rebuild-orphan-project` (tenant, dedup new id) until it's deleted by hand.

**The runbook (`RESTORE.md`, new "Disaster" section):**
- **A. Tenant project lost:**
  1. Try Neon recovery (7 days).
  2. Suspend the workspace if the old project is still reachable (`tenant:admin suspend`), so nothing writes to it.
  3. `rebuild-database`.
  4. Smoke test.
  5. Unsuspend.
  6. Send the notice.
- **B. Control plane lost** (with or without the tenants):
  1. Pause crons: rotate `CRON_SECRET` in Vercel and redeploy.
  2. Restore the control plane from S3 with `db:restore --target control-plane --latest --control-plane none --expect-sha256 …` into a new Neon project.
  3. Update `CONTROL_PLANE_DATABASE_URL` in Vercel production (**and redeploy**), in the GitHub `production` and `production-backups` environments, and in your shell.
  4. Reconcile the window. Workspaces created since the backup have no row: list Stripe customers and subscriptions created in the window and handle them by hand. Re-check payment state (`tenant:admin show`) before crons run.
  5. Rebuild lost tenants (A).
  6. Restore the old `CRON_SECRET` and redeploy.
  7. Send the notices.

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
The table in §6.7 is the state table: raised while true, resolved the first sync it's false.

### 7.3 Rebuild
| Step | Outcome on failure |
|---|---|
| 1–3 (before creating anything) | refuse, nothing created |
| 4 created, 5–7 fail | the new project stays unlinked; `rebuild-orphan-project` alert; workspace unchanged |
| 8 written | done; `rebuild-old-project-pending` if the old project still exists |

## 8. Failure modes
| # | Failure | Behaviour |
|---|---|---|
| F1 | One scheduled run dropped | The 18:17 catch-up runs the backup (Q5). If both drop: `backup-missed-run` at the next digest. |
| F2 | Control plane unreachable from the runner | Fatal, exit 1; GitHub's email; missed-run alert. |
| F3 | A tenant unreachable | Retry after 5 s, then the barrier retry; `backup-failed`. The runbook: re-run with `only=<slug>` (its own concurrency group, so it doesn't replace a pending scheduled run). |
| F4 | pg_dump fails mid-stream | The end gate destroys the body, so no object completes. |
| F5 | age fails | Same; a bad recipient fails every target at start. |
| F6 | Row insert fails after upload | Objects and `BACKUP … row-failed` line exist; restorable with `--expect-sha256`. |
| F7 | OIDC session expiry | 7200 s ≥ 120 min. |
| F8 | Job timeout | Unreached targets alert. |
| F9 | 412 | `key-exists-or-retried`; retry with a new key. |
| F10 | Credentials leak via GitHub | Branch gate plus `job_workflow_ref`; honest scope in §6.5. |
| F11 | `ENCRYPTION_KEY` wrong or empty | Empty or non-hex is refused at start. A wrong key fails every tenant. Rebuild proves the key by decrypting the current row before writing. |
| F12 | Leaked writer uploads junk | Budgets alert; random suffixes; junk expires in 25 days. |
| F13 | Over 625 GiB | `failed`. |
| F14 | Neon IP allow-list | None configured; noted in §12. |
| F15 | Restore into a non-empty, remote or live database | Scratch guard. Rebuild only writes a project it created. |
| F16 | Tampered, truncated or forged object | Ownership, sidecar, SHA and age checks, plus the row or `--expect-sha256`. |
| F17 | Deleted data past 30 days | 25-day rule plus the daily over-27-days check (Q1). |
| F18 | Monitoring misconfigured | OFF / not-configured lines; `backup-check-failed` (auto-resolves). |
| F19 | Overlapping runs | Concurrency groups; unique keys. |
| F20 | Wrong recipient | Committed file; a drill every 3 weeks < 25 days. |
| F21 | Drill fails | `backup-drill-failed` until PASS. |
| F22 | Restore copies left behind | Drills drop theirs; others are tracked by `restore_copies`, with an alert. |
| F23 | Actions minutes exhausted | Missed-run alert; §12 sets a budget. |
| F24 | `begin` connection drops | §6.2 step 2 (no hang). |
| F25 | Wrong tenant's backup in a restore or rebuild | Key prefix plus sidecar `tenantId` refuse (invariant 9). |
| F26 | Two tenants in one Neon project | Rebuild always creates a project per tenant, and guard 7 refuses a shared project id or host. |
| F27 | Old project comes back after a rebuild | `rebuild-old-project-pending` until deleted (Q4). |
| F28 | Control plane restored stale | Runbook B: crons paused, redeploy, Stripe reconcile. |
| F29 | Migration lock during a dump | `--lock-wait-timeout=60s` fails the target, and the barrier retries. The runbook: no deploys at 06:17 or 18:17 UTC. |
| F30 | The environment auto-created unprotected | §12 order (create and gate before merge), the job-level `if`, `job_workflow_ref`. |

## 9. Platform limits
- **GitHub Actions:** minutes per run, about 2 runs a day (the catch-up usually exits in seconds); 120-minute timeout.
- **Neon:** CU-hours ≈ dump time + 5 min per tenant per day; transfer ≈ uncompressed size per day.
- **S3:** under $5/month.
- **Runner memory:** about 128 MiB.
- **Vercel:** isolated reads in the daily cron.

## 10. Blast radius

### 10.1 Changed or new
| File | Change |
|---|---|
| migration + `src/db/control-plane/schema.ts` | 4 tables |
| `scripts/db-backup.ts`, `db-backup-audit.ts`, `db-restore.ts`, `scripts/lib/backup/*` | **new** |
| `ops/backup-recipient.txt`, `ops/aws/*.json` | **new** |
| `scripts/tenant-admin.ts` (+ header usage), `src/lib/tenant/admin-commands.ts` | `rebuild-database`, `old-project-deleted`, `register-restore-copy`, `restore-copy-destroyed`; `show` lists the newest backup per target, the newest drill and open copies |
| `src/lib/tenant/neon.ts` | `createNeonDatabase(slug, { projectNameSuffix? })` (default unchanged) |
| `src/lib/tenant/backup-status.ts` | **new** |
| `src/app/api/cron/tenant-lifecycle/route.ts` | the isolated backup step |
| `src/lib/tenant/ops-digest.ts` | Backups section |
| `src/lib/tenant/delete-tenant.ts` | the receipt lists open restore copies |
| `.github/workflows/db-backup.yml` | **new** |
| `.github/workflows/ci.yml` | integration job on `ubuntu-24.04`; installs `postgresql-client-16`; sets `REQUIRE_PG16_TOOLS=1`, `BACKUP_PG_DUMP_BIN` and `BACKUP_PG_RESTORE_BIN` to `/usr/lib/postgresql/16/bin/…` |
| `package.json` | scripts `db:backup`, `db:backup-audit`, `db:restore`; devDependencies |
| `.env.example` | `BACKUPS_EXPECTED` |
| Tests | `ops-retention-scripts.test.ts:254` (banner list); `signup-ops.test.tsx:171-189` (mock `backup-status`, order); `ops-digest-alerts.test.ts` (stub the new queries; all-quiet text); `tenant-notices.test.ts:272`, `seat-sync.test.ts:308` (digest calls: `BACKUPS_EXPECTED` unset in tests, so no section) |
| `RESTORE.md` | S3 restore, Disaster A/B, 3-weekly drill, notice template; `:80-83` amended per Q4 |
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
- **U3:** `backupFindings`: every §6.7 row, plus new tenant, null-URL provisioning, a tenant leaving active, missed-run suppressing stale control plane, the drill anchor, and `NO-ELIGIBLE-TENANT`.
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
- **S1:** two `test-lc-*` tenants (one `suspended`) plus the control plane:
  - `ok` rows, sidecars, SHA-256 equal to the stored bytes, exact counts;
  - a `deleting` tenant skipped;
  - `BACKUP` lines;
  - **the control plane starts only after all tenant work** (the store records order), and its row counts include this run's tenant rows.
- **S2:** fake pg_dump exits 1 mid-stream → `failed`; **the store never saw end-of-stream**; exit 1.
- **S3:** fake age exits 1 → the same.
- **S4:** the store rejects 412 → `key-exists-or-retried`; the barrier retry with a new key → `ok`.
- **S5:** row insert fails → summary failed; the `row-failed` line.
- **S6:** **real pg_dump 16**. A wrapper inserts and **commits** rows into the test database **after** the counts and **before** it execs pg_dump. The restored counts equal the snapshot counts and exclude the inserted rows. (Without `--snapshot` this fails.)
- **S7:** connection error then ok; two errors → failed. A count-query error before the pipeline → failed **with no hang** (a test timeout of 10 s).
- **S8:** redaction of stderr.
- **S9:** `syncBackupAlerts(now, filter)` with `BACKUPS_EXPECTED=1`: each §6.7 finding raised and resolved; `0` → nothing synced.
- **S10:** `restoreOne` with `controlPlane: null` on a file it builds itself (real pg_dump and pg_restore 16) → PASS with `--expect-sha256`. Tampered → refused. `--drill` creates and drops `cp_drill_*` (none remain) and records a `backup_drills` row; a forced pg_restore failure → `FAIL:pg_restore`; plan-only (no `--yes`) records nothing.
- **S11:** `rebuild-database` (dependency-injected: Neon, migrate, pending count, restore) refuses each of:
  - a `deleting` tenant;
  - an undecryptable current row;
  - the old project existing without the flag;
  - another tenant's key or sidecar;
  - a restore that isn't PASS;
  - pending migrations;
  - a shared project id or host;
  - no `--yes`.

  On success it writes the URL and project id and audits. A failure after create raises `rebuild-orphan-project`; `--old-project-still-exists` raises `rebuild-old-project-pending`.
- **S12:** a wrong `ENCRYPTION_KEY` → tenants `failed`, the control plane `ok`.
- **S13:** `db:backup-audit` with a fake reader → a correct `backup_audits` row.
- **S14:** `restore_copies`: `destroy_by` = min(backup + 30, deletion + 30); overdue alert; `restore-copy-destroyed` closes it; the deletion receipt lists open copies.
- **S15:** `--if-missing-today`: today's control-plane `ok` exists → exit 0 with no work; otherwise a full run.

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
3. `db:restore -- --control-plane none --target <uuid> --latest --expect-sha256 <from the output> --into postgres://bytime:bytime_dev@localhost:5432/rehearsal --yes` → PASS.
4. Rehearse `rebuild-database` on a staging throwaway workspace whose project you delete first.
5. Delete the test bucket.

## 13. Verification
1. `npx tsc --noEmit`, `npm run lint`, `npm run test`, `npm run test:tz`, `npm run db:safety`.
2. On the product owner's machine, run `npm run db:migrate:cp`, then the memory-noted integration command with `REQUIRE_PG16_TOOLS=1 BACKUP_PG_DUMP_BIN=/opt/homebrew/opt/postgresql@16/bin/pg_dump BACKUP_PG_RESTORE_BIN=/opt/homebrew/opt/postgresql@16/bin/pg_restore`.
3. **The lead's checks file** (local, no AWS):
   - `--dry-run`;
   - `syncBackupAlerts` via SQL fixtures marked `test-`, and the digest section through a local production server with `BACKUPS_EXPECTED` set to `1`, `0`, then unset;
   - `db:restore` refusals and an S3-free restore of an integration-built file;
   - `rebuild-database` refusals.
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
