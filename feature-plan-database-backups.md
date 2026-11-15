# Database backups (build queue 3b)

> **Status:** **DRAFT v1**, 2026-11-15, lead architect. Not yet reviewed (pre-mortem log in §15).
>
> **Branch:** `database-backups`, from `main` at `c416049` (after per-user billing, PR #32). The §3 references were checked there.
>
> **Source:**
> - `BUSINESS-DECISIONS.md` §5 (Decided 2026-11-10): "Backups beyond Neon: Yes. Required before the first paying customer." It sets these requirements:
>   - a daily `pg_dump` (custom format) of every tenant database and the control plane;
>   - encryption on the runner with a public key before upload;
>   - S3 us-east-1, in an AWS account separate from Vercel and Neon;
>   - 30 days rolling, by a lifecycle rule;
>   - write-only job credentials;
>   - digest monitoring with a 36-hour staleness alert;
>   - RPO 24 h and restore within 1 business day;
>   - a monthly restore drill.
>
>   The runner is "engineering's choice".
> - `LAUNCH-TRACKER.md` build queue 3b, approved 2026-11-11 as its own blueprint.
> - Terms of Service §9.3 (`business/legal/terms-of-service.md:211-213`): "Deleted Customer Data may remain in our backups for up to **30 days** before being overwritten".
> - The live Privacy page (`src/app/privacy/page.tsx:44,52`): "backups for up to 30 days"; "Amazon Web Services (encrypted backups)" is listed as a subprocessor.
> - `src/lib/tenant/lifecycle-config.ts:48-52`: `BACKUP_RETENTION_DAYS = 30`. "Any backup system added later must expire deleted tenants' data within this window."
>
> **Standard:** `BLUEPRINT-STANDARD.md`.

## 1. Goal and scope

Add disaster-recovery backups that survive the loss of the Neon account or a Neon project:

1. **A daily job** (GitHub Actions, scheduled). It takes a `pg_dump` of the control plane and of every tenant database that isn't being deleted, using the direct host, Postgres 16 client tools and an exported snapshot. Each dump is encrypted with `age` to the founder's public key and uploaded to S3 us-east-1 under a key no one can overwrite.
2. **A manifest per backup in the control plane:** size, ciphertext SHA-256, and exact row counts taken in the same snapshot. The digest reads it to report failures and staleness, since the job's credentials can't read S3.
3. **Restore tooling for the founder:** restore any backup into an empty scratch database and check it against the manifest. It also runs the monthly drill, and a disaster runbook relinks a workspace to a restored database.
4. **AWS setup as reviewable policy files** and a founder runbook in PRODUCTION-DEPLOY.

**Out of scope:**
- Point-in-time recovery (Neon's 7-day history already covers it, `RESTORE.md`).
- Backups of staging (Q2).
- Cross-region copies.
- A customer-facing archive plan.
- Any change to retention periods or to the Terms.

## 2. Questions for the product owner

| # | Question | Recommendation | Section |
|---|---|---|---|
| Q1 | **Keeping the "30 days" promise.** Terms §9.3: deleted data "may remain in our backups for up to 30 days". An S3 lifecycle rule makes an object *eligible* for deletion after N days (rounded up to the next midnight UTC). AWS removes it asynchronously and says removal "might not … [happen] until days or even weeks later" and is not guaranteed by a deadline. A 30-day rule alone can't strictly keep the promise. | **A 25-day lifecycle rule** (eligible within 26 days, a 4-day buffer for AWS's normal lag), **plus a check in the monthly drill**. The drill lists the bucket with the founder's read credentials and flags any object older than 29 days; the founder deletes stragglers by hand. RPO is unaffected (25 daily backups kept). The business side may also want to reword §9.3 to allow for the provider's lag. | §6.6, §6.9 |
| Q2 | **Staging backups.** | **None.** Staging gets a one-off rehearsal into a separate test bucket (§12.3), then nothing. Production only. | §6.8 |
| Q3 | **A drill reminder in the digest.** §5 asks for a monthly drill "recorded in a runbook". | **Yes:** the restore script records each drill on the workspace's audit trail. The digest shows "No restore drill in 35 days" when none was recorded. | §6.7 |

Design choices stated for the record (engineering's call within §5; no answer needed):
- **Runner:** a GitHub Actions scheduled workflow. No GitHub Actions cron exists today; the existing crons run on Vercel, which can't run `pg_dump`.
- **Time:** 06:17 UTC daily, 1–2 a.m. US Eastern, off the top of the hour as GitHub advises.
- **Coverage:** lifecycle-exempt demo workspaces are backed up like any other ("every tenant database").

## 3. Verified current state (2026-11-15, `main` at `c416049`)

### 3.1 Databases and how to reach them
- **One Neon project per tenant**, created with `pg_version: 16` (`src/lib/tenant/neon.ts:71`), plus the control-plane database (`CONTROL_PLANE_DATABASE_URL`).
- **Stored URLs use Neon's pooled host** (`ep-…-pooler…`, PgBouncer in transaction mode). `toDirectConnectionUrl(url)` (`src/lib/tenant/migrate-tenant.ts:18-30`) strips `-pooler` for session work and passes non-Neon URLs (local, CI) through unchanged.
- **Tenant URLs** are AES-256-GCM encrypted in `tenants.db_url_encrypted` and decrypted with `ENCRYPTION_KEY` (`src/lib/encryption`). `deleted` tenants have a null URL (`schema.ts:16-19`).
- **Tenant statuses:** `provisioning | active | suspended | deleting | deleted` (`schema.ts:4-10`). `scripts/lib/tenant-migration.ts:16` treats `active, suspended, provisioning, deleting` as migratable.
- **The pattern for a script that loops over tenants** is `scripts/migrate-all.ts`:
  - dotenv from `.env.local` then `.env`;
  - `printTargetBanner()`;
  - concurrency 3;
  - one retry after a connection error (cold start);
  - a results table;
  - exit 1 if any tenant failed;
  - run as `node --conditions=react-server --import tsx` (`package.json:18`).

### 3.2 GitHub Actions today
- `.github/workflows/ci.yml` runs on push/PR. `deploy-prod.yml` and `deploy-staging.yml` are manual (`workflow_dispatch`) and use GitHub **environments** `production` and `staging`, whose secrets include `CONTROL_PLANE_DATABASE_URL`, `ENCRYPTION_KEY`, `NEON_API_KEY`, `VERCEL_TOKEN` and others (`deploy-prod.yml:19,30-54`).
- **No scheduled workflow exists.** Remote: `github.com:ccentofo/bytime`.

### 3.3 Monitoring today
- **The daily digest** (`src/lib/tenant/ops-digest.ts:73-…`, sent by the 13:00 UTC lifecycle cron):
  - adds sections with `section(title, items)` (`:121-124`);
  - computes `hasNews` (`:108-110`);
  - lists unresolved `ops_alerts`.
- **Condition alerts** are raised and resolved in the lifecycle runner (`CONDITION_ALERT_KINDS`, `lifecycle-runner.ts`).
- **Audit trail:** `recordAudit(db, { tenantId, kind, actor, detail })` (`lifecycle-store.ts:108-…`); `tenantId` is required.

### 3.4 Docs and policy that mention backups
- **`RESTORE.md`:**
  - Neon branch restores (the default path);
  - in-place restore (exception only);
  - a monthly *branch* drill on a staging throwaway workspace;
  - "There is no command that points a workspace at a different database" (`:80-83`).
- **`TENANT-DELETION.md` §"Backup window" (`:124-145`):** Neon's deleted-project recovery is 7 days. `BACKUP_RETENTION_DAYS = 30` "matches the longest window on any currently-published Neon plan".
- **`PRODUCTION-DEPLOY.md`:**
  - Phase 15 row "Long-term retention + backup policy" (`:913`);
  - Operations, "Monthly: the restore drill in RESTORE.md" (`:885`).
- **`src/lib/tenant/delete-tenant.ts:371-374`** uses `BACKUP_RETENTION_DAYS` for founder exports' destroy-by date (unchanged).

## 4. External behaviour (verified from source; fetched 2026-11-15)

### 4.1 GitHub Actions
1. **Scheduled runs can be late or dropped.** "The `schedule` event can be delayed during periods of high loads … High load times include the start of every hour. If the load is sufficiently high enough, some queued jobs may be dropped." Runs are UTC and use the default branch's latest commit (docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows). **So monitoring must alert on missing success, not just on failure (§6.7).**
2. **The 60-day auto-disable rule is documented for public repositories only.** For private ones it's unconfirmed, and the staleness alert covers it either way.
3. **Limits:**
   - a job runs for up to 6 h;
   - `timeout-minutes` defaults to 360;
   - `concurrency: { group, cancel-in-progress: false }` keeps one run active and one pending (docs.github.com/en/actions/reference/limits; workflow-syntax).
4. **Failed-run notifications** go to the user who created the workflow or last changed its cron line (docs …/notifications-for-workflow-runs).
5. **OIDC to AWS:**
   - workflow permissions `id-token: write`, `contents: read`;
   - `aws-actions/configure-aws-credentials@v6` with `role-to-assume`, `aws-region`, and `role-duration-seconds` (900–43200, default 3600);
   - trust policy `StringEquals` on `token.actions.githubusercontent.com:aud = sts.amazonaws.com` and `…:sub`. A job that references an environment has the sub `repo:OWNER/REPO:environment:NAME`;
   - AWS recommends OIDC over long-lived keys (docs …/oidc-in-aws). **The session must outlast the job.** Repos created after July 15, 2026 may use an immutable sub format: check the emitted value.
6. **Runner image `ubuntu-24.04`** (image 20261111.370.1): AWS CLI 2.40.0, Node 22, PostgreSQL client **16.15**; no `age`.
   - Install PGDG `postgresql-client-16` and `age` (`apt install age`, 1.1.1 on noble) (github.com/actions/runner-images, packages.ubuntu.com/noble/age, postgresql.org/download/linux/ubuntu).
7. **Secrets:**
   - Secrets are masked only best-effort, and values fetched at runtime aren't masked. **Never print a connection string.** Mask derived values with `::add-mask::`.
   - Environments with required reviewers would hold a scheduled job; availability depends on the GitHub plan (docs …/secrets, …/deployments-and-environments).

### 4.2 AWS S3
1. **Size:** a single PUT is up to 5 GB; multipart allows up to 10,000 parts, objects to 48.8 TiB. `@aws-sdk/lib-storage` `Upload` uses multipart and throws if it would exceed 10,000 parts (default 5 MiB parts, so set `partSize`) (docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html; lib-storage source).
2. **Don't use `aws s3 cp` for the upload.** AWS CLI ≥ 2.33.0 can **exit 0 after a failed upload** (ReadTimeoutError after retries, including an aborted multipart). The bug is open with no fix (github.com/aws/aws-cli/issues/10743), and the runner has 2.40.0. So uploads go through the SDK, which throws on failure.
3. **Conditional writes:**
   - `If-None-Match: *` on PutObject and CompleteMultipartUpload returns 412 if the key exists; a 409 `ConditionalRequestConflict` means restart the upload;
   - needs only `s3:PutObject`;
   - lib-storage passes `IfNoneMatch` through to both calls;
   - a bucket policy can enforce it with `s3:if-none-match` plus `s3:ObjectCreationOperation`. The Deny form denies `s3:PutObject` with `{"Null": {"s3:if-none-match": "true"}, "Bool": {"s3:ObjectCreationOperation": "true"}}` (docs …/conditional-writes.html, …/conditional-writes-enforce.html).
4. **Write-only access:** `s3:PutObject` covers CreateMultipartUpload, UploadPart and CompleteMultipartUpload; `s3:AbortMultipartUpload` is separate, and aborting removes only uncompleted parts. No GetObject, ListBucket or DeleteObject is needed (docs …/mpuoverview.html).
5. **Integrity:** S3 rejects a mismatched checksum. Multipart with SHA256 supports composite checksums only (algorithm declared at create) (docs …/checking-object-integrity-upload.html). End-to-end integrity comes from age's authentication plus our own SHA-256 of the ciphertext.
6. **Lifecycle:**
   - expiration time = creation time + N days, rounded up to the next midnight UTC;
   - removal is asynchronous and "might not … [happen] until days or even weeks later"; storage isn't billed after expiration;
   - AWS doesn't recommend lifecycle alone for deadline-bound deletion;
   - in a versioned bucket, Expiration only adds a delete marker;
   - `AbortIncompleteMultipartUpload` cleans up orphaned parts (docs …/intro-lifecycle-rules.html, …/lifecycle-expire-general-considerations.html). **Versioning stays off** (overwrites are denied).
7. **Bucket defaults and price:**
   - new buckets have Block Public Access on, Bucket-owner-enforced ownership (ACLs disabled) and SSE-S3;
   - recommended: a TLS-only policy (`aws:SecureTransport`);
   - us-east-1 S3 Standard costs $0.023/GB-month, and PUT/LIST $0.005 per 1,000 (each part is a request).

### 4.3 age
- **Usage:** `age -r age1… [-o out] [in]` (stdin to stdout by default) and `age -d -i key.txt`. `age-keygen -o key.txt` prints the recipient.
- **Format:** 64 KiB ChaCha20-Poly1305 chunks with a final-chunk flag and an HMAC'd header, so truncation and tampering are detected.
- **Exit status:** "age will exit 0 if and only if encryption or decryption are successful for the full length of the input"; partial authenticated output can precede a failure.
- **No sender authentication:** anyone with the public key can make a valid file. The drill checks content, not just decryption (github.com/FiloSottile/age; C2SP age spec; age.1 man page).

### 4.4 pg_dump / pg_restore / Neon
1. **Use version 16 for both dump and restore.**
   - pg_dump 17 can dump a 16 server.
   - pg_restore 17 always emits `SET transaction_timeout = 0`, which errors on a 16 server.
   - 17 writes archive format 1.16, which pg_restore 16 can't read (postgres `pg_backup_archiver.c/.h`, REL_16/17).
   - Neon: match the client to the project's Postgres version (neon.com/docs/manage/backups-pg-dump).
2. **Snapshots:**
   - `pg_dump --snapshot=NAME` uses a snapshot exported by `pg_export_snapshot()` from a REPEATABLE READ transaction;
   - "available for import only until the end of the transaction that exported it";
   - keep the exporter open until pg_dump exits, on the same direct endpoint (postgresql.org/docs/16/functions-admin.html).
3. **Neon:**
   - "Avoid using `pg_dump` over a pooled connection string. Use an unpooled connection string."
   - `neon_superuser` ownership causes non-fatal restore errors, so use `pg_restore -O`.
   - A dump wakes a suspended compute and bills its CU-hours for about the dump time plus 5 min.
   - Network transfer: Launch and Scale include 500 GB per project per month, then $0.10/GB (neon.com/docs/manage/backups-pg-dump, /introduction/plans, /introduction/scale-to-zero).
4. **Errors:**
   - pg_dump's fatal errors exit 1 and write to stderr;
   - pg_restore continues past errors unless `-e`, and exits 1 if any were ignored;
   - Node child processes report `(code, signal)` on `close` and `error` if spawn fails (postgres REL_16 source; nodejs.org/api/child_process.html).

## 5. Invariants that must not break
1. **The private key never touches the runner, the repo, S3 or Vercel.** The runner holds only the public recipient.
2. **No connection string, password or key is ever printed** to logs, the manifest or errors. Errors are redacted (as `migrate-all.ts:67` does), and URLs are masked.
3. **The backup job can't read or delete backups:**
   - its role allows only `s3:PutObject` (plus `s3:AbortMultipartUpload`) on the backup prefix;
   - the bucket policy denies overwrites;
   - versioning is off.
4. **A backup counts as successful only if every stage succeeded:** pg_dump, age, the upload, and the manifest write. A partial object is never completed.
5. **Backups never change a tenant's data.** The dump is read-only, in a REPEATABLE READ snapshot.
6. **`deleting` and `deleted` tenants are never backed up** (§5 "Skip tenants in deleting / deleted"), so their last backup expires on schedule.
7. **The restore tooling never writes to a live database:** it restores only into an empty scratch database.
8. **The calendar-date, DCAA and tenancy invariants are untouched;** no app request path changes except the digest.

## 6. Design

### 6.1 Manifest table (control plane)
Migration `drizzle/control-plane/00NN_database_backups.sql` (drizzle-kit generated) creates `database_backups`:

| column | type |
|---|---|
| `id` | uuid PK default random |
| `tenant_id` | uuid null, FK → `tenants.id` ON DELETE CASCADE (null = the control plane) |
| `target` | varchar(20) not null: `'tenant'` \| `'control-plane'` |
| `run_id` | varchar(80) not null (`${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}`, or `local-<uuid>`) |
| `status` | varchar(10) not null: `'ok'` \| `'failed'` |
| `s3_key` | text null (null when failed before upload) |
| `bytes` | bigint null (ciphertext size) |
| `sha256` | char(64) null (ciphertext, hex) |
| `row_counts` | jsonb null (`{ "schema.table": count }` from the dump's snapshot) |
| `pg_dump_version` | varchar(40) null |
| `error` | text null (redacted, ≤ 500 chars) |
| `started_at`, `finished_at` | timestamptz not null |

Index `(tenant_id, status, finished_at DESC)`. Rows are append-only and never updated. The founder may prune rows older than a year; not automated.

### 6.2 The backup script (`scripts/db-backup.ts`, helpers in `scripts/lib/backup/`)
Run as `npm run db:backup` → `node --conditions=react-server --import tsx scripts/db-backup.ts`.

**Environment** (each missing one is a fatal error naming the variable):
- `CONTROL_PLANE_DATABASE_URL`, `ENCRYPTION_KEY`;
- `BACKUP_BUCKET`, `BACKUP_AGE_RECIPIENT` (must match `^age1[0-9a-z]{58}$`);
- `AWS_REGION` (`us-east-1`); AWS credentials come from the OIDC step;
- `BACKUP_PG_DUMP_BIN` (default `/usr/lib/postgresql/16/bin/pg_dump`) and `BACKUP_AGE_BIN` (default `age`).

**Flags:**
- `--only control-plane|<slug>`: one target;
- `--dry-run`: lists the targets and checks binaries, the recipient and the control plane; no dump, no upload, no writes;
- `--concurrency N` (default 3).

**Start:**
1. Print the target banner (control-plane host only, never credentials).
2. Run `pg_dump --version`. Refuse unless it starts with `pg_dump (PostgreSQL) 16.`.
3. Run `age --version`. Refuse on failure.
4. Validate the recipient.

**Targets:**
- the control plane first;
- then every tenant with status `active` or `suspended` (not `provisioning`, `deleting` or `deleted`) and a non-null `db_url_encrypted`, ordered by slug.

**Per target** (`backupOne`):
1. **URL:** decrypt (for tenants) and convert with `toDirectConnectionUrl`. Split the password out: pass it to children through `PGPASSWORD` in their environment, never in argv, and give pg_dump the URL **without** the password.
2. **Snapshot and counts:** open a direct `postgres` connection (`max: 1`, `connect_timeout: 30`) and run `sql.begin('isolation level repeatable read read only', async (tx) => …)`:
   - `SET LOCAL idle_in_transaction_session_timeout = 0`, `SET LOCAL statement_timeout = 0`;
   - `snap = SELECT pg_export_snapshot()`;
   - list the base tables (`pg_tables` where `schemaname NOT IN ('pg_catalog','information_schema')`) and count each with `SELECT count(*) FROM "<schema>"."<table>"` (identifiers quoted with postgres.js `sql(name)`); this is `rowCounts`;
   - run the **pipeline** (step 3) while the transaction stays open; commit after it resolves or rejects.
3. **Pipeline:**
   - `pgDump = spawn(PG_DUMP, ['-Fc', '--no-owner', '--no-acl', '--snapshot=' + snap, '--dbname=' + urlWithoutPassword], { env: { …process.env, PGPASSWORD } })`;
   - `ageProc = spawn(AGE, ['-r', RECIPIENT])`;
   - `pgDump.stdout → ageProc.stdin`;
   - `ageProc.stdout → hashing PassThrough` (SHA-256 and byte count) → `Upload` (lib-storage) with `{ Bucket, Key, Body, IfNoneMatch: '*', ChecksumAlgorithm: 'SHA256', ContentType: 'application/octet-stream' }`, `partSize: 64 MiB`, `queueSize: 2`, `leavePartsOnError: false`;
   - both children's stderr is collected (truncated to 4 KB, then redacted);
   - **success** = pg_dump `close` with `(0, null)`, AND age `close` with `(0, null)`, AND the upload promise resolves, AND bytes > 0;
   - **on the first failure** (spawn `error`, non-zero exit, a signal, or an upload rejection): kill the other children, `await upload.abort()`, and reject with a redacted reason.
4. **Object key:** `v1/<target>/<id>/<YYYY>/<MM>/<DD>/<runId>.dump.age`, where `<id>` is the tenant uuid or `control-plane`. Keys are unique per run, so a legitimate run never collides. A 412 (key exists) is a failure with the reason `key-exists` (§8 F9).
5. **Record:** insert a `database_backups` row, `ok` with key, bytes, SHA-256, row counts and pg_dump version, or `failed` with the redacted error, on a separate control-plane connection. A failed manifest write makes the target `failed` in the run summary, even though the object exists (§8 F6).
6. **Retry:** a connection error (the `isConnectionError` heuristic from `migrate-all.ts:71`) before the pipeline starts gets one retry after 5 s. Pipeline failures aren't retried in the same run (the next day's run is the retry).

**End:**
- Print a table: target, status, size, duration (no keys, no URLs).
- Exit 1 if any target failed, so GitHub marks the run failed and notifies.
- Exit 0 otherwise.

### 6.3 Redaction and masking (`scripts/lib/backup/redact.ts`)
- **`redact(text)`** replaces any `postgres(ql)://…` URL with `postgres://***` and any `password=…` with `password=***`. It's applied to every error and stderr captured.
- **Masking in GitHub:** when `GITHUB_ACTIONS === 'true'`, each decrypted tenant password and direct host is written as `::add-mask::<value>` to stdout before first use.

### 6.4 The workflow (`.github/workflows/db-backup.yml`)
```yaml
name: Database backups
on:
  schedule: [{ cron: '17 6 * * *' }]
  workflow_dispatch:
    inputs:
      only: { description: 'Optional: control-plane or one slug', required: false }
permissions: { id-token: write, contents: read }
concurrency: { group: db-backup, cancel-in-progress: false }
jobs:
  backup:
    runs-on: ubuntu-24.04
    environment: production-backups
    timeout-minutes: 120
    steps:
      - uses: actions/checkout@<pinned sha>
      - uses: actions/setup-node@<pinned sha>  # node 22, cache npm
      - run: npm ci
      - run: |   # Postgres 16 client from PGDG + age, then assert versions
          sudo apt-get update && sudo apt-get install -y postgresql-common age
          sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
          sudo apt-get install -y postgresql-client-16
          /usr/lib/postgresql/16/bin/pg_dump --version | grep -q '^pg_dump (PostgreSQL) 16\.'
          age --version
      - uses: aws-actions/configure-aws-credentials@<pinned sha of v6>
        with: { role-to-assume: '${{ secrets.BACKUP_ROLE_ARN }}', aws-region: us-east-1, role-duration-seconds: 7200 }
      - run: |
          if [ -n "$ONLY" ]; then npm run db:backup -- --only "$ONLY"; else npm run db:backup; fi
        env:
          ONLY: ${{ inputs.only }}
          CONTROL_PLANE_DATABASE_URL: ${{ secrets.CONTROL_PLANE_DATABASE_URL }}
          ENCRYPTION_KEY: ${{ secrets.ENCRYPTION_KEY }}
          BACKUP_BUCKET: ${{ vars.BACKUP_BUCKET }}
          BACKUP_AGE_RECIPIENT: ${{ vars.BACKUP_AGE_RECIPIENT }}
          AWS_REGION: us-east-1
```
- **The `production-backups` environment** holds only `CONTROL_PLANE_DATABASE_URL`, `ENCRYPTION_KEY` and `BACKUP_ROLE_ARN` (secrets), plus `BACKUP_BUCKET` and `BACKUP_AGE_RECIPIENT` (variables). It has **no** required reviewers or wait timers, which would hold scheduled runs.
- **The workflow input** reaches the shell only through the `ONLY` env var, quoted, and the script validates it (`^(control-plane|[a-z0-9-]{1,63})$`). It's never interpolated into the `run:` text.
- **Action versions** are pinned to commit SHAs.
- **New devDependencies:** `@aws-sdk/client-s3` and `@aws-sdk/lib-storage`. They're used only by scripts, never imported by `src/`, and a unit test enforces that.

### 6.5 AWS resources (files in `ops/aws/`, applied by the founder per §12)
- **`backup-bucket-policy.json`** has three statements:
  - Deny any action when `aws:SecureTransport = false`;
  - Deny `s3:PutObject` when `{"Null": {"s3:if-none-match": "true"}, "Bool": {"s3:ObjectCreationOperation": "true"}}` (no overwrites);
  - Deny `s3:DeleteObject*` and `s3:PutLifecycleConfiguration` for every principal except the founder's admin role (ARN placeholder).
- **`backup-lifecycle.json`:** `Expiration.Days = 25` on prefix `v1/` (Q1), plus `AbortIncompleteMultipartUpload.DaysAfterInitiation = 1`.
- **`backup-writer-trust.json`:** OIDC provider `token.actions.githubusercontent.com`; `aud = sts.amazonaws.com`; `sub = repo:ccentofo/bytime:environment:production-backups` (confirm the emitted format, §4.1.5). MaxSessionDuration 7200.
- **`backup-writer-policy.json`:** Allow `s3:PutObject` and `s3:AbortMultipartUpload` on `arn:aws:s3:::BUCKET/v1/*`. Nothing else.
- **`backup-restore-policy.json`** (founder's restore identity): Allow `s3:GetObject` on `BUCKET/v1/*`, and `s3:ListBucket` on `BUCKET` with prefix `v1/`. Nothing else.
- **Bucket settings:** us-east-1; Block Public Access (all four); Bucket owner enforced; SSE-S3; **versioning off**; account separate from Vercel and Neon (§5).

### 6.6 Retention (Q1)
- The lifecycle rule expires objects at creation + 25 days (rounded to midnight UTC), so they're eligible within 26 days.
- Backups of a workspace stop when it enters `deleting` (invariant 6), so its last backup is eligible within 26 days of the deletion run.
- The monthly drill (§6.9) also lists the bucket and reports any object older than 29 days (by `LastModified`). The founder deletes those with the admin role.
- `TENANT-DELETION.md` "Backup window" gains the S3 paragraph.
- `BACKUP_RETENTION_DAYS` stays 30, unchanged.

### 6.7 Monitoring (lifecycle cron and digest)
**Gated by `BACKUPS_EXPECTED=1`** in the production Vercel env only. Without it (local, staging, CI) the checks are skipped and the digest says nothing about backups.

New module `src/lib/tenant/backup-status.ts` (server-only). `evaluateBackups(now)` reads, on the locked pool:
- the newest `ok` row per target;
- the newest row of any status per target;
- every tenant with status `active` or `suspended` and its `created_at`;
- the newest `backup-restore-drill` audit event (Q3).

Findings (a pure function `backupFindings(facts, now)`, unit-tested):
- **stale tenant:** an `active`/`suspended` tenant created more than 36 h ago whose newest `ok` row is missing or older than 36 h;
- **stale control plane:** its newest `ok` row is missing or older than 36 h;
- **failed:** a target whose newest row is `failed`;
- **drill overdue** (Q3): no `backup-restore-drill` event in 35 days. Never alerted before the first `ok` backup exists.

Wiring:
- **Condition alerts:** `runLifecycleCron` (once per run, not per tenant) raises `backup-stale` (dedup = slug or `control-plane`) and `backup-failed` (dedup the same), and resolves those no longer found. Same auto-resolve pattern as `CONDITION_ALERT_KINDS`, as a separate global step after the tenant loop, before the digest.
- **Digest section** "Backups": one line per finding, e.g. `acme — no successful backup since 2026-11-13T06:20Z`, `control plane — last backup failed: <redacted error>`, `No restore drill recorded in 35 days`. Included in `hasNews`.
- **A dropped or missed scheduled run** shows as staleness after 36 h, because the control plane is always a target.

### 6.8 Staging and local (Q2)
- **Staging:** no schedule. The workflow runs only on the default branch with the production environment.
- **Rehearsal:** a one-off at staging (§12.3) uses a **test** bucket and a test key pair, run locally by the founder with `npm run db:backup` and their own AWS profile, then discarded.
- **Local development:** `npm run db:backup -- --dry-run` works against the local control plane. A real upload needs a real bucket and AWS credentials; locally the pipeline is exercised by the integration tests with the fake uploader.

### 6.9 Restore and drill (`scripts/db-restore.ts`)
Run as `npm run db:restore`, by the founder on their own machine.

**Environment:**
- `CONTROL_PLANE_DATABASE_URL`, `ENCRYPTION_KEY` (for `--drill` live counts);
- `BACKUP_BUCKET`;
- AWS credentials of the restore identity (the standard AWS profile chain);
- `BACKUP_AGE_KEY_FILE` (path to the private key; the key never leaves the founder's machine);
- `BACKUP_PG_RESTORE_BIN` (default: `pg_restore` on PATH, which must report `16.`).

**Modes:**
- `--target control-plane|<slug> [--key <s3 key>] --into <scratch url> [--yes]`. Restores the newest `ok` backup of that target (from `database_backups`), or the given key.
- `--drill --into <scratch url> [--yes]`. Picks a random `active` tenant with an `ok` backup in the last 36 h and restores its newest one. Then it checks counts (step 6) and records the result (step 8).
- `--list-old`: lists objects under `v1/` older than 29 days (Q1 check). Read-only.

**Steps:**
1. **Scratch guard:** the `--into` host must be `localhost`, `127.0.0.1` or `::1`, unless `--allow-remote-scratch` is given. The target database must contain **no** tables outside `pg_catalog` and `information_schema`; otherwise refuse ("scratch database is not empty"). Print the plan (target, key, size, scratch host and db name) and stop without `--yes`.
2. Download the object (`GetObject`) to a temp file (mode 600) in `os.tmpdir()`.
3. Compute its SHA-256 and compare with the manifest row. A mismatch refuses: "backup file doesn't match its manifest".
4. `age -d -i $BACKUP_AGE_KEY_FILE -o <tmp>.dump <tmp>`. Require exit 0 (age is authenticated; a non-zero exit means tampering or truncation, so stop).
5. `pg_restore --no-owner --no-acl --exit-on-error --dbname=<scratch> <tmp>.dump` (16). Require exit 0.
6. **Counts:** count every table from the manifest in the scratch database and compare exactly with `row_counts`. Print MATCH or the differing tables.
7. Delete the temp files (in `finally`).
8. **`--drill` only:** `recordAudit(… { tenantId, kind: 'backup-restore-drill', actor: 'founder:db-restore', detail: '<MATCH|MISMATCH> key=<key> tables=<n> rows=<total>' })`, then run `--list-old` and print its result.

Exit 0 only on MATCH.

### 6.10 Disaster relink (`tenant:admin set-database-url`)
For the "restore within 1 business day" case: a Neon project or the Neon account is lost.

Command: `npm run tenant:admin -- set-database-url <slug> --url-file <path> [--yes]`.
- Reads the new **pooled** URL from a file (never argv).
- Connects to it and refuses unless it holds a restored CadenzPoint schema (the `drizzle.__drizzle_migrations` table exists, and `users` exists).
- Shows the old and new hosts (no passwords), then on `--yes` writes `db_url_encrypted = encrypt(url)` under the tenant lock, with an audit event `database-url-replaced` (detail: old host → new host).
- Invalidation of the registry cache is the 60 s TTL (stated in the output).
- Refuses for `deleting`/`deleted` tenants.

The `RESTORE.md` disaster section walks through it: restore the control plane first if lost, create new Neon projects, `db:restore` into each, migrate (`db:migrate:all -- --tenant`), `set-database-url`, smoke test.

## 7. State machines

### 7.1 One backup attempt (per target, per run)
| State | Event | Next | Side effects |
|---|---|---|---|
| start | connection error | retry once after 5 s | — |
| start | second connection error | failed | `failed` row (`error` = connect) |
| snapshot open | counts done, pipeline started | dumping | — |
| dumping | pg_dump exits non-zero or by signal | failed | kill age; `upload.abort()`; `failed` row |
| dumping | age exits non-zero | failed | kill pg_dump; abort; `failed` row |
| dumping | upload rejects (412 key exists, 409, network) | failed | kill both; abort; `failed` row |
| dumping | all three succeed, bytes > 0 | uploaded | commit the snapshot tx |
| dumping | bytes = 0 | failed | abort; `failed` row |
| uploaded | manifest insert ok | ok | `ok` row |
| uploaded | manifest insert fails | failed (summary) | object exists without a row (F6); the run exits 1 |
| any | job timeout or kill | (none) | no row for that target; multipart parts expire in 1 day; staleness alert after 36 h |

### 7.2 Freshness per target (digest)
| State | Condition | Digest and alert |
|---|---|---|
| fresh | newest `ok` ≤ 36 h | nothing |
| new | tenant created < 36 h ago, no `ok` yet | nothing |
| stale | otherwise | `backup-stale` alert and a digest line; resolved when fresh |
| failed | newest row of any status is `failed` | `backup-failed` alert and a digest line; resolved when the newest row is `ok` |
| gone | tenant now `deleting`/`deleted` | not evaluated; its alerts resolved |

## 8. Failure modes
| # | Failure | Behaviour |
|---|---|---|
| F1 | GitHub drops or delays the scheduled run | No rows. After 36 h every target is stale: an alert plus the digest (§6.7). |
| F2 | The control plane is unreachable from the runner | The script can't list targets or write rows: fatal, exit 1, GitHub's failure email. Staleness after 36 h. |
| F3 | One tenant DB unreachable (cold start, Neon incident) | One retry, then a `failed` row. The others continue. `backup-failed` next digest. |
| F4 | pg_dump fails mid-stream | age is killed and the upload aborted (no partial object completed); a `failed` row. |
| F5 | age fails (bad recipient, crash) | The same. The recipient is validated at start, so it fails fast for every target. |
| F6 | Upload succeeds, manifest insert fails | The object exists, unreferenced (harmless; it expires in 25 days). The target counts as failed; staleness covers it if it persists. |
| F7 | The OIDC session expires mid-job | `role-duration-seconds: 7200` ≥ `timeout-minutes: 120`. If a run ever exceeds it, uploads fail, giving `failed` rows. Raise both together. |
| F8 | Job timeout (120 min) | GitHub kills the job. Targets not reached get no row, then staleness. Orphaned parts are aborted by lifecycle after 1 day. |
| F9 | 412 key exists | Impossible for a legitimate run (unique run id). It means someone with write access pre-created the key. A `failed` row with `key-exists`, so the alert surfaces it. |
| F10 | A credentials leak from GitHub (writer role) | The attacker can add objects but can't read, overwrite or delete them. The founder rotates by removing the trust policy. Backups intact. |
| F11 | `ENCRYPTION_KEY` mismatch | Decrypting tenant URLs fails for every tenant: all `failed`, alert. The control-plane dump still succeeds. |
| F12 | pg_dump client isn't 16 | Refused at start (version assert), exit 1. |
| F13 | A tenant DB larger than about 625 GiB | lib-storage throws (10,000 parts × 64 MiB): a `failed` row. Far beyond launch scale. |
| F14 | The runner's IP is blocked by a Neon IP allow-list | Unconfirmed whether projects use allow-lists (the app creates none in `neon.ts`). If one is ever added, the founder must allow GitHub's ranges. Noted in §12. |
| F15 | A restore into a non-empty or remote DB | Refused by the scratch guard (§6.9 step 1). |
| F16 | A tampered or truncated backup file | The SHA-256 mismatch against the manifest, or age's authentication, refuses before pg_restore runs. |
| F17 | A deleted workspace's backups outlive 30 days | The 25-day rule plus the monthly `--list-old` check (Q1). |
| F18 | The digest runs on staging or local | `BACKUPS_EXPECTED` unset, so the checks are skipped. No false alerts. |
| F19 | Two runs overlap (a manual dispatch during the schedule) | `concurrency` serializes them. Unique keys mean even a parallel run can't collide. |

## 9. Platform limits
- **GitHub Actions:**
  - job cap 6 h; we set 120 min;
  - at launch (a few tenants, small databases) a run takes minutes;
  - minutes cost: about 5 min/day ≈ 150 min/month (private-repo quota applies).
- **Neon:**
  - each dump wakes the tenant compute (CU-hours ≈ dump time + 5 min) and counts against the project's transfer allowance (500 GB/month on Launch/Scale);
  - roughly the uncompressed data size per day, negligible at launch;
  - concurrency 3 keeps simultaneous computes low.
- **S3:** at launch, well under $5/month (§5).
- **Memory:** lib-storage holds up to `queueSize × partSize` = 128 MiB on the runner (7 GB available).
- **Vercel:** no change except a few control-plane reads in the daily lifecycle cron.

## 10. Blast radius

### 10.1 Changed or new
| File | Change |
|---|---|
| `drizzle/control-plane/00NN_database_backups.sql`, `src/db/control-plane/schema.ts` | new table |
| `scripts/db-backup.ts`, `scripts/lib/backup/{pipeline,keys,redact,targets}.ts` | **new** |
| `scripts/db-restore.ts` | **new** |
| `scripts/tenant-admin.ts`, `src/lib/tenant/admin-commands.ts` | `set-database-url` |
| `src/lib/tenant/backup-status.ts` | **new** (findings) |
| `src/lib/tenant/lifecycle-runner.ts` | the global backup-alert step |
| `src/lib/tenant/ops-digest.ts` | the Backups section |
| `.github/workflows/db-backup.yml` | **new** |
| `ops/aws/*.json` | **new** (policies, lifecycle) |
| `package.json` | `db:backup`, `db:restore` scripts; devDependencies `@aws-sdk/client-s3`, `@aws-sdk/lib-storage` |
| `.env.example` | `BACKUPS_EXPECTED` (Vercel production only), restore env documented |
| `RESTORE.md` | new sections "Restore from the S3 backup" and "Disaster: a lost Neon project or account"; the monthly drill now uses `db:restore --drill` (the branch drill stays as a quarterly item) |
| `TENANT-DELETION.md` | the backup window gains S3 |
| `PRODUCTION-DEPLOY.md` | a new Phase "Backups (AWS)"; the Phase 15 row marked done; Operations daily/monthly; the env table gains `BACKUPS_EXPECTED` |

### 10.2 Checked, unchanged
- The app request paths.
- `delete-tenant.ts` (founder exports keep `BACKUP_RETENTION_DAYS`).
- `migrate-all.ts`; the Vercel crons.
- The privacy page (already lists AWS for encrypted backups, and 30 days).
- The business draft privacy policy's subprocessor table lacks AWS; that's the business side's file (§5 "AWS is added to the Privacy Policy as a subprocessor (item 3)"), flagged in §12.

## 11. Required tests (each must fail without the change it proves)
**Unit:**
- **U1:** `objectKey` produces `v1/tenant/<uuid>/YYYY/MM/DD/<run>.dump.age` and `v1/control-plane/control-plane/…`, with UTC date parts.
- **U2:** `redact` masks postgres URLs and `password=` in mixed text; `splitPassword` returns a URL without its password, plus the password; `toDirectConnectionUrl` is reused.
- **U3:** `backupFindings` covers every row of §7.2 (fresh, new < 36 h, stale, failed, gone, control plane, drill overdue, no alert before the first ok).
- **U4:** the success predicate requires all four conditions; each single failure → failed.
- **U5:** recipient validation; `--only` validation (rejects shell metacharacters).
- **U6:** static: no file under `src/` imports `@aws-sdk/*`; the workflow references only `production-backups` and pins `uses:` to SHAs; `run:` steps never interpolate `inputs.*` directly.
- **U7:** the restore scratch guard: remote host refused without the flag; a non-empty database refused.
- **U8:** the restore count comparison: MATCH, and MISMATCH listing the tables.

**Integration** (local Postgres; fake `pg_dump` and `age` binaries via `BACKUP_PG_DUMP_BIN` / `BACKUP_AGE_BIN` pointing at small node scripts; an injected fake uploader behind an `Uploader` interface):
- **S1:** a happy path over the control plane plus 2 tenants (one `suspended`). Rows `ok` with key, bytes, SHA-256 (matching the uploaded bytes), row counts equal to the real counts, and the pg_dump version. `deleting`, `deleted` and `provisioning` tenants are skipped.
- **S2:** the fake pg_dump exits 1 mid-stream → that target `failed`, the uploader saw `abort()`, the others ok, exit code 1.
- **S3:** the fake age exits 1 → `failed`, abort called.
- **S4:** the uploader rejects with 412 → `failed` with `key-exists`.
- **S5:** the manifest insert fails (injected) → the summary counts it failed, exit 1.
- **S6:** the snapshot is real. The real local pg_dump (16 if available; the test asserts the version or skips **with an explicit failure in CI**, where 16 is required) dumps under the exported snapshot while rows are inserted concurrently; the restored counts equal the manifest.
- **S7:** a connection error then success → one retry, `ok`.
- **S8:** redaction: a fake pg_dump writing a URL with a password to stderr → the stored `error` has no password.
- **S9:** lifecycle cron with `BACKUPS_EXPECTED=1`: a stale tenant → `backup-stale` raised; a fresh ok row → resolved; failed newest → `backup-failed`; the digest lists them. With the env unset → nothing.
- **S10:** `db-restore` against a local scratch database, using the files from S6: SHA-256 check, a fake age decrypt (identity), real pg_restore 16, MATCH. A tampered file → SHA mismatch refusal. `--drill` records `backup-restore-drill`.
- **S11:** `tenant:admin set-database-url` refuses an empty database, a `deleting` tenant, and without `--yes`. It writes encrypted, audits, and never prints the password.

## 12. Founder steps (PRODUCTION-DEPLOY, new Phase "Backups (AWS)")
1. **AWS account and bucket:**
   - Create an AWS account **separate from Vercel and Neon**, with root MFA and an admin role.
   - In us-east-1, create the bucket (keep Block Public Access, Bucket owner enforced, SSE-S3; versioning **off**).
   - Apply `ops/aws/backup-bucket-policy.json` and `backup-lifecycle.json`.
2. **The OIDC provider** `token.actions.githubusercontent.com` (audience `sts.amazonaws.com`).
3. **The writer role** with `backup-writer-trust.json` and `backup-writer-policy.json` (MaxSessionDuration 2 h). First run the workflow once with `role-to-assume` set and read the token's `sub` in CloudTrail if access is denied (§4.1.5).
4. **The restore identity** with `backup-restore-policy.json` (an IAM user with MFA, access keys in the password manager, or an SSO role).
5. **Keys:** `age-keygen -o cadenzpoint-backup.key` **on the founder's machine**. Store the file in the password manager plus one offline copy, never in the repo or cloud storage. Copy the `age1…` recipient.
6. **GitHub:**
   - create the environment `production-backups` (no required reviewers, no wait timer);
   - secrets: `CONTROL_PLANE_DATABASE_URL`, `ENCRYPTION_KEY` (production values), `BACKUP_ROLE_ARN`;
   - variables: `BACKUP_BUCKET`, `BACKUP_AGE_RECIPIENT`.
7. **Vercel production env:** `BACKUPS_EXPECTED=1`.
8. **First run:** Actions → Database backups → Run workflow. Expect success and one `ok` row per target (`tenant:admin show` lists the newest backup). Then `npm run db:restore -- --drill --into postgres://localhost/cp_scratch --yes` locally. Expect MATCH.
9. **Business side (item 3):** add AWS to the business privacy-policy draft's subprocessor table. The live page already lists it.
10. **If a Neon IP allow-list is ever enabled,** add GitHub's runner ranges or use a self-hosted runner (F14).

**Staging rehearsal (12.3, once, Q2):** a test bucket, a test key, `npm run db:backup -- --only <staging slug>` with the founder's own AWS profile, then `db:restore` into local scratch → MATCH. Delete the test bucket afterwards.

## 13. Verification
1. `npx tsc --noEmit`, `npm run lint`, `npm run test`, `npm run test:tz`, `npm run db:safety`.
2. Integration with the env from the memory note (control-plane suites must not skip). Local Postgres 16 tools are needed for S6 and S10; the dev names the local versions.
3. **The lead's checks file `DATABASE-BACKUPS-BROWSER-CHECKS.md`** (local, no AWS):
   - `npm run db:backup -- --dry-run` against the local demo (target list, version checks);
   - the digest's Backups section via SQL fixtures in `database_backups` and a curl to the lifecycle cron with `BACKUPS_EXPECTED=1`;
   - `db:restore` refusals (remote host, non-empty scratch);
   - `tenant:admin set-database-url` refusals.
   - The real S3 path is proven at the founder's first run (§12 step 8) and the staging rehearsal (§12.3).

## 14. Hand-off rules (in addition to `BLUEPRINT-STANDARD.md` §3)
- Impact analysis first, then stop for the lead's review.
- Never print or store a connection string, password or private key. Never commit `ops/aws` files with real ARNs (placeholders only).
- No real AWS calls from tests (the `Uploader` interface).
- Stage files by name.

## 15. Pre-mortem log
(empty)
