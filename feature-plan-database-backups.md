# Database backups (build queue 3b)

> **Status:** **DRAFT v2**, 2026-11-15, lead architect.
> - Pre-mortem round 1 (2 HIGH, about 16 MEDIUM, about 20 LOW across two reviewers) is fixed in this version (§15).
> - Round 2 is pending.
>
> **Branch:** `database-backups`, from `main` at `c416049` (after per-user billing, PR #32). The §3 references were checked there.
>
> **Source:**
> - `BUSINESS-DECISIONS.md` §5 (Decided 2026-11-10), "Backups beyond Neon: Yes. Required before the first paying customer." Its requirements:
>   - a daily `pg_dump` (custom format) of every tenant database and the control plane, skipping `deleting` / `deleted`;
>   - encrypted on the runner with a public key before upload; the private key never on the runner or in storage;
>   - stored in S3 us-east-1, in an AWS account separate from Vercel and Neon;
>   - 30 days rolling, enforced by a lifecycle rule;
>   - write-only job credentials; restores use separate founder-held credentials;
>   - digest reporting, with an alert when an active tenant's newest backup is more than 36 h old;
>   - RPO 24 h, and restore within 1 business day;
>   - a monthly restore drill;
>   - runner: "engineering's choice".
> - `LAUNCH-TRACKER.md` build queue 3b (approved 2026-11-11).
> - LB-D6 (`feature-plan-launch-blockers.md:40,380`; `RESTORE.md:80-83`): "No `set-db-url` command"; "the live database is never swapped for a restored branch". Q4 asks to change this for the disaster case.
> - Terms §9.3 (`business/legal/terms-of-service.md:211-213`): "Deleted Customer Data may remain in our backups for up to **30 days** before being overwritten".
> - Privacy page (`src/app/privacy/page.tsx:44,52`): backups "for up to 30 days"; AWS listed as a subprocessor ("encrypted backups").
> - `lifecycle-config.ts:48-52`: `BACKUP_RETENTION_DAYS = 30`.
>
> **Standard:** `BLUEPRINT-STANDARD.md`.

## 1. Goal and scope

Disaster-recovery backups that survive losing a Neon project, or the whole Neon account (control plane included):

1. **A daily GitHub Actions job:**
   - dumps every tenant database, then the control plane **last**;
   - uses Postgres 16 tools over the direct host, with an exported snapshot and exact row counts;
   - encrypts each dump with `age` to a recipient **committed in the repo**;
   - uploads it to S3 under a key that can't be overwritten, with an encrypted **sidecar manifest** next to it;
   - records a manifest row in the control plane, and the key plus SHA-256 in the run's log, an independent record.
2. **Monitoring in the daily digest:**
   - a missed run (Q5), stale or failed targets, monitoring switched off, the drill overdue or failed;
   - each check is isolated, so a backup bug never stops the digest.
3. **Restore tooling** that works **from S3 alone** (no control plane needed):
   - integrity checks against the manifest and the run log;
   - a drill that creates and drops its own scratch database and records PASS or FAIL;
   - restore copies tracked with a destroy-by date.
4. **A guarded disaster relink command** (Q4), plus a runbook.
5. **AWS setup** as reviewable policy files, plus the founder runbook.

**Out of scope:**
- point-in-time recovery (Neon's 7-day history, `RESTORE.md`);
- staging backups (Q2);
- cross-region copies;
- an archive plan;
- any change to retention periods or to the Terms.

## 2. Questions for the product owner

| # | Question | Recommendation | Section |
|---|---|---|---|
| Q1 | **Keeping the "30 days" promise (Terms §9.3).** An S3 lifecycle rule makes an object *eligible* for deletion after N days, rounded up to the next midnight UTC. AWS removes it asynchronously: "might not … [happen] until days or even weeks later", and AWS doesn't recommend lifecycle alone for deadline-bound deletion. | **A 25-day lifecycle rule** (eligible within 26 days), **plus a daily "old objects" check.** A separate **list-only** AWS identity, in the same workflow, lists the backup keys. It can see names and dates but read no content. The digest flags any object older than 29 days, and the founder deletes it by hand the same day. This tightens §5's "can't read" to "can't read content"; your call. Alternative: a weekly manual check by the founder, which allows up to about 37 days in the worst case. Either way the business side may want §9.3 to allow for the provider's lag. | §6.6 |
| Q2 | **Staging backups.** | **None.** One rehearsal against a test bucket (§12.3), then nothing. | §6.8 |
| Q3 | **Drill frequency.** §5 says monthly, but the backups only live 25 days (Q1), so a monthly drill can't catch a problem before every backup is affected. | **Every 3 weeks.** The digest reminds you 21 days after the last PASS. Each drill restores a random tenant **and** the control plane. A failed drill raises an alert until the next PASS. | §6.7, §6.9 |
| Q4 | **A disaster relink command.** LB-D6 (your 2026-10 decision) says there is no command to point a workspace at another database. When a Neon project (or the account) is lost, restoring within 1 business day needs one. Relinking to a backup up to 24 h old loses the entries made since, so customers must be told. | **Add `tenant:admin set-database-url`, for the lost-database case only.** It's guarded (§6.10): same tenant's backup proven, schema migrated, project id verified, no sharing. **Plus a customer notice** (template in `RESTORE.md`) naming the backup time and the lost window. The live-database rule otherwise stands. | §6.10 |
| Q5 | **Alerting on a single missed run.** §5's 36 h rule only fires after two missed runs in a row (backups run at 06:17 UTC, the digest at 13:00). | **Also alert when the newest successful control-plane backup is more than 26 h old at digest time** (one missed run). The 36 h per-tenant rule stays. | §6.7 |

Design choices stated for the record (engineering's call within §5):
- **Runner:** GitHub Actions scheduled workflow. No GitHub Actions cron exists today, and Vercel can't run `pg_dump`.
- **Time:** 06:17 UTC.
- **Coverage:** `provisioning` tenants with a URL are backed up, per §5's literal skip list; staleness ignores tenants created under 36 h ago. Lifecycle-exempt demo workspaces are included.
- **Existing drill:** the existing monthly Neon branch drill in `RESTORE.md` is **unchanged**. The new drill is in addition to it.

## 3. Verified current state (2026-11-15, `main` at `c416049`)

### 3.1 Databases
- **One Neon project per tenant**, with `pg_version: 16` and `history_retention_seconds` (`src/lib/tenant/neon.ts:71-74`), plus the control plane, which is Postgres 16 per `PRODUCTION-DEPLOY.md:272`. Not enforced in code, so §6.2 checks each server.
- **Stored URLs are Neon's pooled host;** `toDirectConnectionUrl` (`src/lib/tenant/migrate-tenant.ts:18-30`) strips `-pooler`.
- **Tenant URLs** are AES-256-GCM encrypted in `tenants.db_url_encrypted`. `encryption.ts:20-23` falls back to a dev key when `NODE_ENV` isn't production, so an empty `ENCRYPTION_KEY` must be refused explicitly.
- **Statuses** `provisioning|active|suspended|deleting|deleted` (`schema.ts:4-10`); `deleted` tenants have a null URL.
- **`tenant:delete`:**
  - classifies a database by `neon_project_id` (`delete-tenant.ts:99-100`);
  - refuses when the project is missing (`:236-245`) or another workspace shares the URL (`:218-230`);
  - deletes the project named by `neon_project_id` (`:325-327`).
- **`isLoopbackUrl`** lives in `src/lib/tenant/loopback.ts:9` (it handles `[::1]`).
- **Founder scripts print `printTargetBanner()`.** `ops-retention-scripts.test.ts:254` checks "every founder script prints it". The `tenant:admin` actor is `founder:${USER}` (`scripts/tenant-admin.ts:60`).
- **`migrate-all.ts`** (dotenv; concurrency 3; one retry after a connection error with `isConnectionError` at `:71`; redaction at `:67`; exit 1 on failure) reads tenant URLs from the control plane (`:174-187`).

### 3.2 GitHub Actions
- `ci.yml` (push/PR; the integration job runs on `ubuntu-latest` with a `postgres:16-alpine` service and no client tools installed).
- `deploy-prod.yml` and `deploy-staging.yml` are manual and use environments `production` / `staging` (`deploy-prod.yml:19`). `production` is gated to `main` (`PRODUCTION-DEPLOY.md:540-542`).
- There is no scheduled workflow. `package.json:45` has a postinstall patch (mantine) that the app build needs, but scripts don't.

### 3.3 Monitoring
- **Digest** (`ops-digest.ts:73-…`):
  - built from `section()` calls with `hasNews`;
  - lists unresolved alerts (`:138-139`);
  - tracks founder exports with destroy-by alerts (`checkFounderExports`, `:34-64`).
- **`runLifecycleCron`** writes its global alerts with no try/catch (`lifecycle-runner.ts:512-517`). The route runs signup maintenance and the digest after it (`route.ts:23-27`), and `runCron` records success after `work()` (`run-cron.ts:25-30`).
- **`recordAudit` requires a `tenantId`** (`lifecycle-store.ts:108-…`).
- **`tenant:admin show`** (`tenant-admin.ts:189-208`) doesn't list backups.

### 3.4 Docs
- **`RESTORE.md`:** branch restore (the default), in-place restore (exception), the monthly branch drill (`:70-78`), and "no command that points a workspace at a different database" (`:80-83`).
- **`TENANT-DELETION.md`** "Backup window" (`:124-145`).
- **`PRODUCTION-DEPLOY.md`:** Phase 15 row (`:913`), Operations (`:883-887`), `production` environment branch gate (`:540-542`).

### 3.5 The product owner's machine (for local verification)
- pg_dump 16.14 at `/opt/homebrew/opt/postgresql@16/bin`.
- `age` isn't installed, and there's no `/usr/lib/postgresql`.

## 4. External behaviour (verified from source; fetched 2026-11-15)

### 4.1 GitHub Actions
1. **Scheduled runs** can be delayed or **dropped** under load ("High load times include the start of every hour"). They run in UTC on the default branch's latest commit. The 60-day auto-disable is documented for public repos only. (docs.github.com …/events-that-trigger-workflows)
2. **Limits and failure emails:**
   - a job runs for up to 6 h; `timeout-minutes` defaults to 360;
   - `concurrency: { group, cancel-in-progress: false }`;
   - failed-run email goes to the user who last changed the cron or created the workflow (…/limits, …/workflow-syntax, …/notifications-for-workflow-runs).
3. **OIDC:**
   - `id-token: write`; `aws-actions/configure-aws-credentials@v6` with `role-to-assume`, and `role-duration-seconds` between 900 and 43200 (default 3600);
   - trust policy `aud = sts.amazonaws.com`; a job with an environment gets `sub = repo:OWNER/REPO:environment:NAME` **whatever its branch**;
   - repos created after July 15, 2026 may emit an immutable sub format (…/oidc-in-aws, …/reference/security/oidc).
4. **Environment branches:** "No restriction" is the default for which branches can deploy to an environment; "Selected branches and tags" restricts it. Secrets reach only jobs that reference the environment; required reviewers or wait timers hold the job (…/deployments-and-environments).
5. **Runner image `ubuntu-24.04`:** AWS CLI 2.40.0, Node 22, PostgreSQL client 16.15; no `age`. PGDG provides `postgresql-client-16`, and apt provides `age` 1.1.1 (runner-images; packages.ubuntu.com/noble/age).
6. **Secrets:** masking is best-effort; values fetched at runtime aren't masked (use `::add-mask::`); an unset secret arrives as an empty string (…/security/secrets).

### 4.2 AWS S3
1. **Size:** a single PUT is at most 5 GB; multipart allows 10,000 parts. lib-storage `Upload` throws beyond 10,000 parts, so set `partSize`.
2. **Don't use the CLI to upload.** `aws s3 cp` in CLI ≥ 2.33.0 can exit 0 after a failed upload (github.com/aws/aws-cli/issues/10743, open; the runner has 2.40.0), so uploads use the SDK.
3. **Conditional writes:**
   - `If-None-Match: *` on PutObject and CompleteMultipartUpload returns 412 if the key exists, and 409 on a concurrent conflict;
   - only `s3:PutObject` is needed;
   - lib-storage passes `IfNoneMatch` to both calls (lib-storage 3.1169.0 `dist-cjs/index.js:258,452-463`);
   - enforce it with a bucket-policy Deny on `s3:PutObject` when `{"Null": {"s3:if-none-match": "true"}, "Bool": {"s3:ObjectCreationOperation": "true"}}` (…/conditional-writes-enforce.html, Example 2).
   - **An SDK retry of a write whose first attempt succeeded but timed out sees 412.**
4. **lib-storage calls** `PutObject`, `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload` and `AbortMultipartUpload` (source). `s3:PutObject` covers all but the abort, which needs `s3:AbortMultipartUpload`.
   - `abort()` only signals an AbortController and **doesn't cancel an in-flight PutObject or Complete** (`:243-245,277,463`), so the Body must not end on failure (§6.2).
5. **Lifecycle:**
   - creation + N days, rounded up to the next midnight UTC; removal is asynchronous, "days or even weeks"; no storage billing after expiry;
   - bucket policies can't block lifecycle deletes;
   - a versioned bucket only adds delete markers, so **versioning stays off**;
   - `AbortIncompleteMultipartUpload` (…/intro-lifecycle-rules.html, …/lifecycle-expire-general-considerations.html).
6. **`NotPrincipal` and assumed roles:** `NotPrincipal` with a role ARN doesn't match assumed-role session ARNs, so use `Condition: ArnNotLike aws:PrincipalArn` (IAM docs).
7. **Defaults and price:**
   - new buckets come with Block Public Access, Bucket-owner-enforced ownership and SSE-S3;
   - add a TLS-only policy;
   - storage costs $0.023/GB-month; PUT and LIST cost $0.005 per 1,000.

### 4.3 age
- `age -r age1…` streams stdin to stdout; `age -d -i key`; `age-keygen`.
- STREAM ChaCha20-Poly1305 with an authenticated final chunk: truncation and tampering are detected; exit 0 only on full success.
- **No sender authentication:** anyone with the public key can make a valid file (age spec, man page). If the input simply ends early, age encrypts what it got as a **valid, shorter** file, so pipeline success must be decided outside age (§6.2).

### 4.4 pg_dump / pg_restore / Neon
1. **Use 16 for both pg_dump and pg_restore.**
   - pg_restore 17 emits `SET transaction_timeout`, which a 16 server rejects;
   - pg_dump 17 writes archive format 1.16, which pg_restore 16 can't read;
   - pg_dump refuses to dump a newer server (postgres source; neon.com/docs/manage/backups-pg-dump).
2. **Snapshots:** `--snapshot=NAME` uses a `pg_export_snapshot()` snapshot from a REPEATABLE READ transaction, valid "until the end of the transaction that exported it". Keep the exporter open until pg_dump exits (postgresql.org/docs/16/functions-admin.html).
3. **Neon:**
   - use an unpooled connection;
   - `pg_restore -O`;
   - a dump wakes the compute (CU-hours for the dump plus about 5 min);
   - transfer allowance 500 GB per project per month on Launch/Scale.
4. **postgres.js `sql.begin`** races its callback against `connection.onclose` (`node_modules/postgres/cjs/src/index.js:243-246`). The pipeline's result must be awaited separately (§6.2).

## 5. Invariants that must not break
1. **The private key never touches the runner, the repo, S3 or Vercel.** The recipient is committed in `ops/backup-recipient.txt`, and changing it takes a reviewed commit.
2. **No connection string, password or key is printed** to logs, manifests or errors. Errors are redacted, runtime values masked, and children get a minimal env.
3. **The backup writer can add objects but can't read, overwrite or delete them.** The list-only auditor (Q1) sees names, sizes and dates only.
4. **A backup counts as `ok` only if every stage succeeded.** On any failure the upload body is destroyed before it ends, so no partial object is ever completed.
5. **Dumps are read-only** (REPEATABLE READ READ ONLY).
6. **`deleting` and `deleted` tenants are never dumped.** Status is re-read before each target.
7. **The restore tooling writes only to scratch databases it creates or proves empty.** Only `set-database-url` (Q4) changes a live link, behind its guards.
8. **Backup monitoring fails loudly, never silently.** Unset config shows "OFF", errors show "could not be read", and one missed run alerts (Q5).
9. **Tenancy:** a workspace can only be relinked to a database restored from **its own** backup.

## 6. Design

### 6.1 Control-plane tables (one drizzle-kit migration `00NN_database_backups.sql`)

`database_backups` (append-only):

| column | type |
|---|---|
| `id` | uuid PK |
| `tenant_id` | uuid null, FK → `tenants.id` ON DELETE CASCADE (null = control plane) |
| `target` | varchar(20) not null: `'tenant'` \| `'control-plane'` |
| `run_id` | varchar(80) not null (`${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}`, or `local-<uuid>`) |
| `status` | varchar(10) not null: `'ok'` \| `'failed'` |
| `s3_key` | text null |
| `bytes` | bigint null |
| `sha256` | char(64) null (ciphertext, hex) |
| `row_counts` | jsonb null |
| `server_version` | varchar(20) null |
| `pg_dump_version` | varchar(40) null |
| `error` | text null (redacted, ≤ 500 chars) |
| `started_at` | timestamptz not null |
| `finished_at` | timestamptz not null |

Index `(tenant_id, status, finished_at DESC)`.

`backup_drills` (append-only):

| column | type |
|---|---|
| `id` | uuid PK |
| `run_at` | timestamptz not null |
| `tenant_id` | uuid null (the drilled tenant) |
| `tenant_result` | varchar(40) not null: `PASS` \| `MISMATCH` \| `FAIL:<stage>` \| `NO-ELIGIBLE-TENANT` |
| `control_plane_result` | varchar(40) not null (same values) |
| `tenant_key` | text null |
| `control_plane_key` | text null |
| `old_objects` | int null (from `--list-old`) |
| `actor` | varchar(80) not null |
| `detail` | text null |

Index `(run_at DESC)`.

### 6.2 The backup script (`scripts/db-backup.ts`; helpers in `scripts/lib/backup/`)
Run as `npm run db:backup` → `node --conditions=react-server --import tsx scripts/db-backup.ts`. It prints `printTargetBanner()` and is added to `ops-retention-scripts.test.ts:254`.

**Environment.** Each one is fatal if missing **or empty**:
- `CONTROL_PLANE_DATABASE_URL`, `ENCRYPTION_KEY`, `BACKUP_BUCKET`, `AWS_REGION` (= `us-east-1`).
- AWS credentials come from the OIDC step.
- The recipient is read from `ops/backup-recipient.txt` (one line, `^age1[0-9a-z]{58}$`). There's no recipient env variable.

**Binaries:**
- `pg_dump`: `BACKUP_PG_DUMP_BIN`, else `pg_dump` on PATH. `--version` must start with `pg_dump (PostgreSQL) 16.`.
- `age`: `BACKUP_AGE_BIN`, else `age`. `--version` must succeed.

**Flags:**
- `--only control-plane|<slug>` (validated `^(control-plane|[a-z0-9-]{1,63})$`);
- `--dry-run`: lists targets with each server's `server_version`; checks binaries, the recipient and every connection; no dump, upload or write;
- `--concurrency N` (default 3).

**Targets, in order:**
1. Tenants with status `provisioning`, `active` or `suspended` and a non-null URL, by slug.
2. **Then the control plane, last.** Its dump then contains this run's tenant manifest rows.

The **status is re-read** right before each tenant starts, and a tenant now `deleting` or `deleted` is skipped with outcome `skipped`.

**Seam (testability):** `runBackup({ targets?: TargetFilter, store: BackupStore, clock, runId, bins })`. `BackupStore` is `{ putStream(key, body, opts), putSmall(key, bytes) }` with an S3 implementation via lib-storage. Tests inject a fake store and a target filter. **Tests never back up demo workspaces.**

**Per target (`backupOne`):**
1. **URL:**
   - decrypt (tenants), `toDirectConnectionUrl`;
   - take the password from `new URL().password`, `decodeURIComponent` it, and remove it from the URL;
   - children get `{ PATH, HOME, LANG, PGPASSWORD, PGSSLMODE?: from URL }`: a **minimal env**, never `process.env`. sslmode and options stay in the URL query.
   - When `GITHUB_ACTIONS === 'true'`, print `::add-mask::` for the password and the direct host before first use.
2. **Snapshot and counts:** a direct `postgres` connection (`max: 1`, `connect_timeout: 30`).
   - Check `SELECT current_setting('server_version_num')::int`: refuse unless 160000–169999 (`FAIL: server version`).
   - `const pipelineDone = new Deferred()`, then `sql.begin('isolation level repeatable read read only', async (tx) => { … })`:
     - `SET LOCAL idle_in_transaction_session_timeout = 0`, `SET LOCAL statement_timeout = 0`;
     - `snap = pg_export_snapshot()`;
     - count each base table from `pg_tables` where `schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_temp%' AND schemaname NOT LIKE 'pg_toast%'`, giving `rowCounts`;
     - start the pipeline; `await pipelineDone.promise`; return.
   - **The outcome is the pipeline's result, awaited separately:** `await Promise.allSettled([begin, pipelineDone.promise])`. If the pipeline succeeded, the target is `ok` even if `begin` later rejects (the snapshot was already imported). If `begin` rejects before the pipeline starts, the target fails.
3. **Pipeline** (`stream.pipeline` for every hop, plus error listeners on every child stdio):
   - `pgDump = spawn(PG_DUMP, ['-Fc', '--no-owner', '--no-acl', '--snapshot=' + snap, '--dbname=' + urlWithoutPassword], { env: childEnv })`;
   - `ageProc = spawn(AGE, ['-r', RECIPIENT], { env: minimal })`;
   - `pgDump.stdout → ageProc.stdin`;
   - `ageProc.stdout` → a hashing `PassThrough` (SHA-256 and byte count) **created with the end gate**: age's stdout is piped into it with `{ end: false }`. The hashing stream is **ended only after** pg_dump `close` = `(0, null)` **and** age `close` = `(0, null)`;
   - on any failure (spawn `error`, a non-zero exit or signal, an EPIPE, an upload rejection): kill both children, then `hashing.destroy(err)`, so the upload rejects **before completing**, then `upload.abort()`;
   - stderr is drained fully and kept truncated to 4 KB, redacted.
   - **Upload:** `store.putStream(key, hashing, { IfNoneMatch: '*', ChecksumAlgorithm: 'SHA256', partSize: 64 MiB, queueSize: 2, leavePartsOnError: false })`.
   - **Success** = both children `(0, null)`, the upload resolved, and bytes ≥ 1024 (an age file with a real dump is never smaller).
4. **Keys:** `v1/<target>/<id>/<YYYY>/<MM>/<DD>/<runId>-<rand8>.dump.age`, where `<id>` is the tenant uuid or `control-plane` and `rand8` is 8 random hex characters, so future keys can't be guessed and pre-created. The sidecar key is the same with `.manifest.json.age`.
5. **Sidecar manifest:** after the dump object succeeds, `store.putSmall(sidecarKey, age-encrypt(JSON))`, with `IfNoneMatch: '*'`. The JSON holds `{ v: 1, target, tenantId, slug, runId, key, bytes, sha256, rowCounts, serverVersion, pgDumpVersion, startedAt, finishedAt }`. A sidecar failure makes the target `failed`; the dump object stays and expires.
6. **Record:** insert the `database_backups` row (`ok` or `failed` with the redacted error) on a separate control-plane connection. A failed insert makes the target `failed` in the summary. The S3 objects remain and are usable via the sidecar.
7. **Independent record:** for each `ok` target, print to stdout **and** append to `$GITHUB_STEP_SUMMARY` one line: `BACKUP <target> <id> <key> <sha256> <bytes>`. GitHub keeps run logs for 90 days by default (longer than the 25-day retention), out of reach of the AWS writer. The disaster runbook cross-checks against it (§6.9).
8. **Retries:**
   - a connection error before the pipeline starts gets one retry after 5 s (the `isConnectionError` heuristic);
   - after all targets, **failed targets are retried once more** (new key);
   - an SDK 412 is recorded as `key-exists-or-retried`. It can come from an SDK retry of a write that actually succeeded, and the end-of-run retry covers that case.

**End:**
- Print a table (target, status, size, duration; no keys or URLs).
- Exit 1 if any target is still failed; otherwise exit 0.

### 6.3 Redaction (`scripts/lib/backup/redact.ts`)
`redact(text)` masks `postgres(ql)://…` URLs, `password=…` and anything matching the current target's password or host. It's applied to every error, stderr and manifest field.

### 6.4 The workflow (`.github/workflows/db-backup.yml`)
```yaml
name: Database backups
on:
  schedule: [{ cron: '17 6 * * *' }]
  workflow_dispatch:
    inputs:
      only: { description: 'Optional: control-plane or one slug', required: false }
permissions: { contents: read }
concurrency: { group: db-backup, cancel-in-progress: false }
jobs:
  backup:
    runs-on: ubuntu-24.04
    environment: production-backups
    timeout-minutes: 120
    permissions: { contents: read, id-token: write }
    steps:
      - uses: actions/checkout@<sha>
        with: { persist-credentials: false }
      - uses: actions/setup-node@<sha>          # node 22
      - run: npm ci --ignore-scripts           # scripts don't need the mantine postinstall patch
      - run: |
          sudo apt-get update && sudo apt-get install -y postgresql-common age
          sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
          sudo apt-get install -y postgresql-client-16
      - uses: aws-actions/configure-aws-credentials@<sha of v6>
        with: { role-to-assume: '${{ secrets.BACKUP_ROLE_ARN }}', aws-region: us-east-1, role-duration-seconds: 7200 }
      - run: |
          if [ -n "$ONLY" ]; then npm run db:backup -- --only "$ONLY"; else npm run db:backup; fi
        env:
          ONLY: ${{ inputs.only }}
          BACKUP_PG_DUMP_BIN: /usr/lib/postgresql/16/bin/pg_dump
          CONTROL_PLANE_DATABASE_URL: ${{ secrets.CONTROL_PLANE_DATABASE_URL }}
          ENCRYPTION_KEY: ${{ secrets.ENCRYPTION_KEY }}
          BACKUP_BUCKET: ${{ vars.BACKUP_BUCKET }}
          AWS_REGION: us-east-1
  old-objects:                                   # Q1: list-only audit, its own role and credentials
    needs: backup
    if: always()
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
- **The `production-backups` environment:**
  - **deployment branches: Selected → `main` only** (§4.1.4);
  - no required reviewers or wait timers;
  - secrets `CONTROL_PLANE_DATABASE_URL`, `ENCRYPTION_KEY`, `BACKUP_ROLE_ARN`, `BACKUP_AUDIT_ROLE_ARN`; variable `BACKUP_BUCKET`.
- **`db:backup-audit`** (`scripts/db-backup-audit.ts`): lists `v1/` (paginated) and writes one `backup_audits` row: `{ run_at, oldest_object_at, objects_over_29_days, total_objects, total_bytes }`. It needs no `ENCRYPTION_KEY`. The table is a third small append-only table, added to the same migration.
- **Pinning:** actions are pinned to SHAs. The new devDependencies `@aws-sdk/client-s3` and `@aws-sdk/lib-storage` are imported only by `scripts/`; a static test (U6) enforces that.

### 6.5 AWS resources (`ops/aws/`, placeholders only; applied per §12)
- **`backup-bucket-policy.json`:**
  - Deny `*` when `aws:SecureTransport = false`;
  - Deny `s3:PutObject` when `{"Null": {"s3:if-none-match": "true"}, "Bool": {"s3:ObjectCreationOperation": "true"}}`;
  - Deny `s3:DeleteObject*` and `s3:PutLifecycleConfiguration` when `ArnNotLike aws:PrincipalArn <founder admin role ARN, or the SSO role pattern>`.
- **`backup-lifecycle.json`:** `Expiration.Days = 25` on prefix `v1/`; `AbortIncompleteMultipartUpload.DaysAfterInitiation = 1`.
- **Writer:**
  - `backup-writer-trust.json`: OIDC; `aud = sts.amazonaws.com`; `sub = repo:ccentofo/bytime:environment:production-backups` (confirm the emitted format at first run);
  - MaxSessionDuration 7200;
  - `backup-writer-policy.json`: Allow `s3:PutObject`, `s3:AbortMultipartUpload` on `arn:aws:s3:::BUCKET/v1/*`. Nothing else.
- **Auditor:** `backup-audit-trust.json` (same sub); `backup-audit-policy.json`: Allow `s3:ListBucket` on `arn:aws:s3:::BUCKET` with `s3:prefix` `v1/*`. Nothing else: no GetObject.
- **Restore:** `backup-restore-policy.json` (the founder's restore identity): Allow `s3:GetObject` on `BUCKET/v1/*` and `s3:ListBucket` on `BUCKET` (prefix `v1/`).
- **Bucket:** us-east-1; Block Public Access; Bucket owner enforced; SSE-S3; **versioning off**; in an account separate from Vercel and Neon.
- **An AWS Budgets alert** at $10/month (a leaked writer could upload junk; §8 F12).

### 6.6 Retention (Q1)
- **Lifecycle:** objects expire at creation + 25 days, rounded up to midnight UTC (eligible within 26 days). The bucket policy can't stop lifecycle deletes.
- **Deleted workspaces:** a workspace's backups stop when it enters `deleting` (re-read per target), so its last backup is eligible within 26 days.
- **Daily check:** the `old-objects` job records the oldest object and the count over 29 days. The digest raises `backup-old-objects` when `objects_over_29_days > 0` (§6.7). The founder deletes those objects with the admin role (the runbook command lists them via `db:restore --list-old`).
- `BACKUP_RETENTION_DAYS` stays 30. The `TENANT-DELETION.md` backup window gains the S3 paragraph.

### 6.7 Monitoring (lifecycle cron and digest)
**Config (fails loudly):** `BACKUPS_EXPECTED` must be `1` (production) or `0` (staging, where §12 sets it). When `NODE_ENV === 'production'` and the variable is **unset or anything else**, the digest prints "**Backup monitoring is not configured (BACKUPS_EXPECTED)**", counted in `hasNews`. Local development (`NODE_ENV` not production) skips it silently.

**Module `src/lib/tenant/backup-status.ts`** (server-only). `readBackupFacts(now, filter?)` returns:
- the newest `ok` row and the newest row of any status per target;
- `provisioning`/`active`/`suspended` tenants with `created_at`;
- the newest `backup_drills` PASS and the newest drill row;
- the newest `backup_audits` row;
- the first-ever `ok` row time.

`backupFindings(facts, now)` is pure and unit-tested. It returns:

| Finding | Condition | Alert kind (dedup) |
|---|---|---|
| missed run (Q5) | the newest control-plane `ok` is older than 26 h | `backup-missed-run` (global) |
| stale tenant | created over 36 h ago, and the newest `ok` is missing or older than 36 h | `backup-stale` (slug) |
| stale control plane | the newest `ok` is missing or older than 36 h | `backup-stale` (`control-plane`) |
| failed | the newest row of any status is `failed` | `backup-failed` (slug or `control-plane`) |
| drill overdue (Q3) | `max(first ok, last PASS)` + 21 days < now (never before the first `ok`) | `backup-drill-overdue` (global) |
| drill failed | the newest drill row isn't PASS on both targets | `backup-drill-failed` (global) |
| old objects (Q1) | the newest audit row has `objects_over_29_days > 0`, or no audit row in 30 h | `backup-old-objects` (global) |

**Wiring:**
- **Lifecycle step:** a new step **in the route** (`tenant-lifecycle/route.ts`), after `runLifecycleCron` and before the digest, wrapped in `try/catch`:
  - `syncBackupAlerts(now)` raises the found kinds and resolves the absent ones (and every backup alert of a tenant no longer `provisioning`/`active`/`suspended`);
  - on a throw it best-effort raises the global `backup-check-failed` alert and logs, so the digest still runs.
- **Digest section "Backups"** (also try/catch):
  - one summary line ("N of M targets backed up in the last 26 h; newest control-plane backup <time>"), the config-OFF line, and the error line "Backup status could not be read: <redacted>", all passed through `esc()`;
  - individual findings are **not repeated**, since they appear under "Unresolved alerts".
- **Timing (stated):** the check runs at 13:00 UTC. A run dropped at 06:17 shows as "missed run" about 31 h after the previous success.

### 6.8 Staging and local (Q2)
- **Staging:** `BACKUPS_EXPECTED=0` and no backup workflow, since the environment is gated to `main` with production secrets only. A one-off rehearsal (§12.3) uses a test bucket and test key, run locally.
- **Local:** `npm run db:backup -- --dry-run` against the local control plane, with `BACKUP_PG_DUMP_BIN=/opt/homebrew/opt/postgresql@16/bin/pg_dump` on the product owner's Mac. Real uploads need a bucket.

### 6.9 Restore and drill (`scripts/db-restore.ts`)
Run as `npm run db:restore` on the founder's machine. It prints `printTargetBanner()` and uses actor `founder:${USER}`.

**Environment:**
- `BACKUP_BUCKET`;
- AWS credentials of the restore identity (the profile chain);
- `BACKUP_AGE_KEY_FILE` (path; the key file stays outside synced folders and is put on disk only while restoring);
- `BACKUP_PG_RESTORE_BIN` / `BACKUP_AGE_BIN` (pg_restore must report `16.`);
- `CONTROL_PLANE_DATABASE_URL` is **optional**. With it, rows are cross-checked and drills recorded; without it (disaster), the script works from S3 alone.

**Modes:**
- `--target control-plane|<tenant uuid>|<slug, needs the control plane> [--key <s3 key> | --latest] --into <scratch url> [--yes]`.
- `--drill --into-server <local server url> [--yes]`: restores a random tenant with an `ok` backup in the last 36 h **and** the control plane's newest backup. Each goes into a fresh database it creates (`cp_drill_<rand>`), which it **drops in `finally` and on SIGINT/SIGTERM**.
- `--list-old`: read-only; lists objects under `v1/` older than 29 days.

**Steps for one restore:**
1. **Scratch guard:** `--into` must be loopback (`isLoopbackUrl`) unless `--allow-remote-scratch`. It's converted with `toDirectConnectionUrl`. The database must have **no** tables outside `pg_catalog` and `information_schema`. The script prints the plan (target, key, size, scratch host and db) and stops without `--yes`.
2. **Pick the object:** `--key`; or `--latest`, the newest `.dump.age` under the target's prefix (S3 list) that has a sidecar; or the newest `ok` row (control plane available).
3. **Download** the object and its sidecar into `fs.mkdtemp` (mode 0700).
4. **Integrity:**
   - decrypt the sidecar (`age -d -i`, exit 0 required);
   - check that the sidecar's `key` equals the object key;
   - compute the object's SHA-256 and require it to equal the sidecar's `sha256`;
   - when the control plane is available, also require it to equal the row's;
   - always print the SHA-256 and run id for the founder to match against the GitHub run log's `BACKUP` line. The disaster runbook makes this a required manual step, since age can't tell who encrypted a file.
5. `age -d -i KEY -o <dir>/dump <obj>`: exit 0 required.
6. `pg_restore --no-owner --no-acl --exit-on-error --dbname=<scratch direct>` (16): exit 0 required.
7. **Counts:** count every table in the sidecar's `rowCounts` in the scratch database and compare exactly: PASS or MISMATCH (listing the tables).
8. **`finally`:** delete the temp directory, with SIGINT/SIGTERM handlers.
9. **Non-drill restores** print "this is a copy of customer data: drop the database when done". When the control plane is available, they record an audit event `backup-restore-copy` (detail: key, scratch host and db, destroy-by = now + 30 days). The digest tracks it like founder exports: a `backup-restore-copy-overdue` alert until `tenant:admin restore-copy-destroyed <slug> --yes` records the disposal. Restores into a tenant-proof database for relinking also record `backup-restored` (§6.10).

**Drill recording:** in `finally`, insert a `backup_drills` row with each target's result (`PASS` / `MISMATCH` / `FAIL:<stage>` / `NO-ELIGIBLE-TENANT`), the keys, and the `--list-old` count. Only a row with PASS on both targets resets the reminder (§6.7).

**Exit:** 0 only on PASS.

### 6.10 Disaster relink (Q4): `tenant:admin set-database-url`
**Command:** `npm run tenant:admin -- set-database-url <slug> --url-file <path> --neon-project-id <id> [--yes]`.

**Guards** (it refuses unless every one holds):
1. The tenant is `active` or `suspended`.
2. The new URL (read from the file, never argv) is a **pooled** Neon host, and the Neon API shows that host as an endpoint of `<id>` (reuses the endpoint check in `neon.ts:217-220`). The project has `pg_version` 16 and the policy history retention; if retention differs, the command offers `backfill:neon-retention`.
3. **No other** non-deleted tenant's URL decrypts to the same host and database.
4. The tenant's audit trail has a `backup-restored` event whose destination host and database equal the new URL's. It's recorded by `db:restore --target <this tenant> --into <new direct url> --allow-remote-scratch --relink-proof`, which is allowed only into an empty non-loopback database.
5. It runs `migrateTenantDatabase(newUrl)` (under the migration lock), then requires `getPendingMigrationCount(newUrl) === 0`.

**On `--yes`:** under the tenant lock with the version guard:
- write `db_url_encrypted = encrypt(url)` and `neon_project_id = <id>`;
- audit `database-url-replaced` (detail: old and new host, old and new project id, the backup key);
- print "the app picks this up within 60 s (registry cache)", and the **customer notice reminder** (the template in `RESTORE.md`: the backup time and the lost window).

**Runbook** (`RESTORE.md`, new "Disaster" section):
1. If the control plane is lost, restore it first (from S3 alone) into a new Neon project, and update `CONTROL_PLANE_DATABASE_URL` in every place: Vercel production, the GitHub `production` and `production-backups` environments, and your shell.
2. For each tenant: create a Neon project (pg 16, 7-day history), run `db:restore --relink-proof`, then `set-database-url`.
3. Smoke test.
4. Send the notice.

## 7. State machines

### 7.1 One backup attempt (per target, per run)
| State | Event | Next | Side effects |
|---|---|---|---|
| queued | status re-read is `deleting`/`deleted` | skipped | none |
| start | server version not 16 | failed | `failed` row |
| start | connection error | retry once after 5 s | — |
| start | second connection error | failed | `failed` row |
| dumping | any stage fails (pg_dump, age, EPIPE, upload) | failed | kill children; destroy the body (the upload rejects before completion); abort; `failed` row |
| dumping | both children `(0,null)` → body ended → upload resolves, bytes ≥ 1024 | uploaded | — |
| dumping | `begin` rejects after the pipeline started | (no change) | the outcome follows the pipeline |
| uploaded | sidecar upload fails | failed | the dump object stays (expires); `failed` row |
| uploaded+sidecar | manifest insert ok | ok | `ok` row; `BACKUP` line in the log and step summary |
| uploaded+sidecar | manifest insert fails | failed (summary) | objects usable via the sidecar; exit 1 |
| failed | end-of-run retry | queued (new key) | — |
| any | job timeout or kill | none | no row; parts aborted by lifecycle in 1 day; missed-run or stale alert |

### 7.2 Freshness and drill (digest)
The table in §6.7 is the state table. For each kind: alert raised while the condition holds, resolved the first run it doesn't; tenants leaving `provisioning`/`active`/`suspended` have their backup alerts resolved.

## 8. Failure modes
| # | Failure | Behaviour |
|---|---|---|
| F1 | One scheduled run dropped | `backup-missed-run` at the next 13:00 digest (Q5). |
| F2 | Control plane unreachable from the runner | Fatal, exit 1; GitHub's failure email; missed-run alert next digest. |
| F3 | One tenant unreachable | Retry after 5 s, end-of-run retry, then `failed`; `backup-failed`. The runbook says: re-run the workflow with `only=<slug>` the same day. |
| F4 | pg_dump fails mid-stream | The end gate holds the body open, so it's destroyed and the upload rejects. No object is completed. |
| F5 | age fails | Same. A bad recipient file fails at start for every target. |
| F6 | Manifest insert fails after upload | The objects and sidecar exist and are restorable from S3; the target counts as failed; exit 1. |
| F7 | OIDC session expiry | `role-duration-seconds 7200` ≥ `timeout-minutes 120`; raise both together. |
| F8 | Job timeout | Unreached targets get no row; missed or stale alerts. |
| F9 | 412 on write | `key-exists-or-retried` (an SDK retry, or a pre-created key; random suffixes make pre-creation impractical). The end-of-run retry uses a new key. |
| F10 | Credentials leak via GitHub | The environment is gated to `main`. **Honest scope:** a leaked environment exposes the control-plane URL and `ENCRYPTION_KEY`, hence owner access to every tenant database. That's the same as the existing `production` environment. AWS scope: add objects only (no read, overwrite or delete); list-only for the auditor. |
| F11 | `ENCRYPTION_KEY` wrong or empty | Empty is refused at start. A wrong key fails every tenant decrypt (all `failed`); the control plane still succeeds. |
| F12 | A leaked writer uploads junk or pre-creates keys | The Budgets alert ($10), random key suffixes, junk expires in 25 days. Abort only affects in-flight uploads, so it causes a `failed` row and a retry. |
| F13 | Over 625 GiB per database | lib-storage throws: `failed`. Far beyond launch. |
| F14 | A Neon IP allow-list blocks the runner | None is configured (`neon.ts`). If one is ever added, allow GitHub's ranges (§12). |
| F15 | Restore into a non-empty, remote or live database | Scratch guard. Relinking requires the `backup-restored` proof. |
| F16 | Tampered or truncated object | Sidecar and row SHA-256 mismatch, or age authentication fails, before pg_restore. A forged pair is caught by the manual run-log match. |
| F17 | Deleted workspace data outlives 30 days | 25-day lifecycle plus the daily old-objects check (Q1). |
| F18 | Monitoring misconfigured | The OFF line, `backup-check-failed`, missed-run (§6.7). |
| F19 | Overlapping runs | `concurrency` serializes them; unique keys. |
| F20 | Wrong recipient | Committed in the repo, so a change is a reviewed commit. The drill (every 3 weeks, < 25 days) catches a key mismatch before all backups are affected. |
| F21 | Drill fails or finds no eligible tenant | `backup-drill-failed` until the next PASS. |
| F22 | Restore copy left on the founder's machine | The drill drops its own databases. Non-drill copies are tracked with destroy-by plus an overdue alert. |
| F23 | Actions minutes exhausted | The run doesn't start: missed-run alert. §12 adds a spending limit or budget. |
| F24 | The `begin` connection drops mid-dump | The outcome follows the pipeline (§6.2 step 2). |
| F25 | A relink to the wrong tenant's database | Guards 3 and 4 (§6.10). |

## 9. Platform limits
- **GitHub Actions:** a run at launch takes minutes (about 5 min/day, roughly 150 min/month). The 6 h cap is never approached at 120 min.
- **Neon:** CU-hours ≈ dump time + 5 min per tenant per day; transfer ≈ uncompressed size per day against 500 GB per project per month; concurrency 3.
- **S3:** under $5/month at launch.
- **Runner memory:** about 128 MiB for lib-storage.
- **Vercel:** a few control-plane reads in the daily cron, isolated in try/catch.

## 10. Blast radius

### 10.1 Changed or new
| File | Change |
|---|---|
| `drizzle/control-plane/00NN_database_backups.sql`, `src/db/control-plane/schema.ts` | `database_backups`, `backup_drills`, `backup_audits` |
| `scripts/db-backup.ts`, `scripts/db-backup-audit.ts`, `scripts/db-restore.ts`, `scripts/lib/backup/{pipeline,keys,redact,targets,store,manifest,bins}.ts` | **new** |
| `ops/backup-recipient.txt`, `ops/aws/*.json` | **new** (the recipient is public; the policies use placeholders) |
| `scripts/tenant-admin.ts`, `src/lib/tenant/admin-commands.ts` | `set-database-url`, `restore-copy-destroyed`; `show` lists the newest backup per target and the newest drill |
| `src/lib/tenant/backup-status.ts` | **new** |
| `src/app/api/cron/tenant-lifecycle/route.ts` | the isolated backup-alert step |
| `src/lib/tenant/ops-digest.ts` | the Backups section; `backup-restore-copy` tracking |
| `.github/workflows/db-backup.yml` | **new** |
| `.github/workflows/ci.yml` | integration job pinned to `ubuntu-24.04`; installs `postgresql-client-16`; sets `REQUIRE_PG16_TOOLS=1` |
| `package.json` | `db:backup`, `db:backup-audit`, `db:restore` scripts; devDependencies `@aws-sdk/client-s3`, `@aws-sdk/lib-storage` |
| `.env.example` | `BACKUPS_EXPECTED`; restore env |
| `src/__tests__/unit/ops-retention-scripts.test.ts:254` | the banner list gains the three scripts |
| `RESTORE.md` | "Restore from the S3 backup", "Disaster", the 3-weekly drill, the customer notice template; the existing branch drill unchanged; the `:80-83` sentence amended per Q4 |
| `TENANT-DELETION.md` | backup window adds S3 |
| `PRODUCTION-DEPLOY.md` | new Phase "Backups (AWS)"; Phase 15 row done (citing §5's "no new retention period"); Operations daily (re-run on `backup-failed`) and every 3 weeks (drill); env table `BACKUPS_EXPECTED` (production 1, staging 0) |

### 10.2 Checked, unchanged
- app request paths;
- `delete-tenant.ts` (its checks work after a relink because `neon_project_id` is updated);
- `migrate-all.ts`;
- Vercel crons;
- the privacy page.
- The business draft privacy policy's subprocessor table lacks AWS: a business-side item (§12).

## 11. Required tests (each must fail without the change it proves)
**Tool requirement:** S6 and S10 need Postgres 16 `pg_dump` and `pg_restore`, found via `BACKUP_PG_*_BIN` or PATH. With `REQUIRE_PG16_TOOLS=1` (set in `ci.yml` and in the §13.2 command) a missing or wrong tool **fails** the test; it skips only when the variable is unset. `age` is faked in tests (an identity transform with exit-code control); the real `age` is exercised at §12.

**Unit:**
- **U1:** `objectKey` / `sidecarKey`: format, UTC date parts, random suffix present and unique.
- **U2:** `redact` (URLs, `password=`, the current password/host); `splitPassword` URL-decodes; the child env is minimal (no `ENCRYPTION_KEY`, no AWS vars).
- **U3:** `backupFindings`: every row of the §6.7 table, plus "new tenant < 36 h", "tenant left active resolves", "drill reminder never before first ok", "anchor max(first ok, last PASS)".
- **U4:** the success predicate and the end gate: the body ends only after both `(0,null)`; any failure destroys it.
- **U5:** recipient file validation; `--only` validation; empty env refused.
- **U6:** static checks:
  - no `src/` file imports `@aws-sdk/*`;
  - the workflow pins `uses:` to SHAs, uses `production-backups`, has `id-token` only at job level, `persist-credentials: false`, `--ignore-scripts`, and never interpolates `inputs.*` in `run:`.
- **U7:** the scratch guard: remote refused without the flag; `[::1]` accepted; a non-empty database refused.
- **U8:** count comparison: PASS and MISMATCH.
- **U9:** the digest Backups section: summary line; the OFF line in production when unset or `2`; nothing in development; findings not duplicated; `esc()` applied.

**Integration** (local Postgres; throwaway `test-lc-*` tenants only, cleaned by `run_id`; fake store; fake age; target filter):
- **S1:** happy path, 2 test tenants (one `suspended`) plus the control plane **last**:
  - `ok` rows with key, sidecar written, bytes, SHA-256 matching the stored bytes, exact row counts, server version;
  - a `deleting` test tenant skipped;
  - `BACKUP` lines printed;
  - the control-plane dump's manifest table contains this run's tenant rows (checked via the snapshot counts).
- **S2:** fake pg_dump exits 1 mid-stream → `failed`; **the fake store never received end-of-stream**; abort called; others ok; exit 1.
- **S3:** fake age exits 1 → the same.
- **S4:** the store rejects with 412 → `key-exists-or-retried`; the end-of-run retry with a new key succeeds → final `ok`.
- **S5:** manifest insert fails → summary failed, exit 1, the sidecar exists.
- **S6:** **real pg_dump 16** wrapped by a fake that inserts rows into the test database right after pg_dump starts. The restored counts (S10) equal the snapshot counts, not the post-insert counts.
- **S7:** connection error then success → one retry, `ok`. Two errors → `failed`.
- **S8:** stderr containing a password URL → the stored error is redacted.
- **S9:** lifecycle route with `BACKUPS_EXPECTED=1` and the filter:
  - stale → `backup-stale` raised; fresh → resolved; failed → `backup-failed`;
  - control-plane `ok` 27 h old → `backup-missed-run`;
  - drill rows → overdue and failed;
  - an audit row with old objects → `backup-old-objects`;
  - a tenant moved to `deleting` → its alerts resolved.
- **S9b:** `readBackupFacts` throws → the digest is still sent with the "could not be read" line, `backup-check-failed` raised, lifecycle results returned.
- **S10:** `db:restore` from S6's files with **no control-plane env** (sidecar only) → PASS. A tampered byte → SHA mismatch refusal. A sidecar whose key differs → refusal. `--drill` creates and drops its databases (none remain), records a `backup_drills` row; a forced pg_restore failure records `FAIL:pg_restore`.
- **S11:** `set-database-url` refuses each of:
  - no `--yes`;
  - a `deleting` tenant;
  - a non-pooled URL;
  - a project-id mismatch (fake Neon);
  - another tenant sharing the database;
  - a missing `backup-restored` proof;
  - pending migrations.

  On success it writes the encrypted URL and project id and audits; it never prints the password.
- **S12:** a wrong `ENCRYPTION_KEY` → every tenant `failed`, the control plane `ok`.
- **S13:** `db:backup-audit` with a fake lister → `backup_audits` row with the right oldest time and over-29 count.

## 12. Founder steps (PRODUCTION-DEPLOY, new Phase "Backups (AWS)"), in this order
1. **Deploy** the release (the migration applied). The workflow file is on `main`, but its job can't run until the environment exists with secrets.
2. **AWS account and bucket:**
   - create an AWS account separate from Vercel and Neon (root MFA, an admin role);
   - in us-east-1, create the bucket (defaults; versioning off);
   - apply **`backup-lifecycle.json` first**, then `backup-bucket-policy.json` (with your admin role ARN or SSO pattern);
   - set a Budgets alert at $10/month.
3. **IAM:**
   - the OIDC provider (`token.actions.githubusercontent.com`, audience `sts.amazonaws.com`);
   - the writer role (`backup-writer-*.json`, MaxSessionDuration 2 h);
   - the auditor role (`backup-audit-*.json`);
   - the restore identity (`backup-restore-policy.json`; an IAM user with MFA and keys in the password manager, or an SSO role).
4. **Keys:**
   - `brew install age postgresql@16` on your Mac;
   - `age-keygen -o cadenzpoint-backup.key` in a folder **outside** iCloud-synced locations;
   - store the key in the password manager plus one offline copy, then delete the file;
   - commit the printed `age1…` recipient to `ops/backup-recipient.txt` (a PR the lead reviews).
5. **GitHub:**
   - create environment `production-backups` with **Deployment branches → Selected → `main`**, no reviewers, no wait timer;
   - secrets `CONTROL_PLANE_DATABASE_URL`, `ENCRYPTION_KEY` (production values), `BACKUP_ROLE_ARN`, `BACKUP_AUDIT_ROLE_ARN`; variable `BACKUP_BUCKET`;
   - set an Actions spending limit or budget so minutes can't run out silently.
6. **Vercel:** `BACKUPS_EXPECTED=1` in production, `0` in staging.
7. **First run:** Actions → Database backups → Run workflow.
   - Expect both jobs green, `BACKUP` lines in the summary, and `tenant:admin show <slug>` listing the newest backup.
   - If AWS denies the role, read the token's `sub` in CloudTrail and fix the trust policy (§4.1.3).
8. **First drill:** with the key file restored temporarily, run `BACKUP_AGE_KEY_FILE=… BACKUP_BUCKET=… AWS_PROFILE=<restore> CONTROL_PLANE_DATABASE_URL=<prod> BACKUP_PG_RESTORE_BIN=/opt/homebrew/opt/postgresql@16/bin/pg_restore npm run db:restore -- --drill --into-server postgres://localhost/postgres --yes`. Expect PASS on both targets. Delete the key file.
9. **Business side:** add AWS to the business privacy-policy draft's subprocessor table (the live page already lists it).
10. **If a Neon IP allow-list is ever enabled,** allow GitHub's runner ranges (F14).

**12.3 Staging rehearsal (once, Q2):** a test bucket and test key pair, `db:backup -- --only <staging slug>` with your own AWS profile, then `db:restore --target … --latest --into postgres://localhost/rehearsal --yes` with no control-plane env, then PASS. Then rehearse `set-database-url` on a staging throwaway workspace. Delete the test bucket.

## 13. Verification
1. `npx tsc --noEmit`, `npm run lint`, `npm run test`, `npm run test:tz`, `npm run db:safety`.
2. On the product owner's machine: `npm run db:migrate:cp` (local control plane), then `REQUIRE_PG16_TOOLS=1 BACKUP_PG_DUMP_BIN=/opt/homebrew/opt/postgresql@16/bin/pg_dump BACKUP_PG_RESTORE_BIN=/opt/homebrew/opt/postgresql@16/bin/pg_restore REQUIRE_CONTROL_PLANE_TESTS=1 CONTROL_PLANE_DATABASE_URL=… ENCRYPTION_KEY=… TZ=America/New_York npm run test:integration` (the memory-noted form).
3. **The lead's checks file `DATABASE-BACKUPS-BROWSER-CHECKS.md`** (local, no AWS):
   - the `--dry-run` target list and versions;
   - the digest Backups section and alerts via SQL fixtures plus a lifecycle cron curl (`BACKUPS_EXPECTED=1`, then unset with `NODE_ENV=production` via a local production server);
   - `db:restore` refusals and a sidecar-only restore of an integration-produced file;
   - `set-database-url` refusals.
   - The real AWS path is proven at §12 steps 7–8 and 12.3.

## 14. Hand-off rules (in addition to `BLUEPRINT-STANDARD.md` §3)
- Impact analysis first; stop for the lead's review.
- Never print or store a secret; real ARNs never committed.
- No real AWS in tests (the `BackupStore` seam). Tests touch only `test-lc-*` tenants.
- Stage files by name.

## 15. Pre-mortem log
**Round 1** (two independent reviewers, 2026-11-15, on v1). Pipeline/AWS/security: 1 HIGH, 5 MEDIUM, 13 LOW. Monitoring/restore/tests: 1 HIGH (the same), 12 MEDIUM, 8 LOW. Fixed in v2:

- **HIGH — disaster restore impossible without the control plane, and tenant backups a day behind:**
  - the control plane is dumped **last**;
  - an encrypted sidecar manifest per object;
  - restore from S3 alone;
  - the run-log `BACKUP` line as an independent check (S10).
- **MEDIUM fixes:**
  - environment gated to `main`;
  - recipient committed;
  - drill every 3 weeks including the control plane (Q3);
  - `neon_project_id` handled in relink;
  - relink guarded (tenant proof, no sharing, migrated, project verified) and taken to the product owner (Q4, reversing LB-D6 for the disaster case);
  - restore copies dropped or tracked;
  - missed-run alert (Q5) and the end-of-run retry;
  - monitoring fails loudly;
  - backup checks isolated from the digest;
  - drill results recorded PASS/FAIL with an alert;
  - tests isolated from demo data (target filter, store seam);
  - Postgres 16 tools required in CI and the PO command;
  - the end gate so no partial object completes;
  - Q1 now offers a daily list-only check with honest bounds.
- **LOW fixes:**
  - stream errors handled;
  - 412 relabelled;
  - outcome follows the pipeline;
  - honest F10 and least-privilege workflow;
  - Budgets alert and random key suffix;
  - `ArnNotLike` admin exception, lifecycle applied before the policy;
  - empty env refused, password decoded;
  - server version checked;
  - status re-read;
  - minimum size;
  - timing stated;
  - digest duplication avoided;
  - `isLoopbackUrl` and the banner;
  - `show` lists backups;
  - founder steps for macOS tools and key storage;
  - table filter;
  - missing failure tests;
  - Actions budget;
  - actor convention.
