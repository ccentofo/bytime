# Blueprint 3d: Cloud export link (the F2 change)

> **Status: FINAL v3.0, pre-mortem CLEAN** (2026-11-18). 2 rounds plus 10 confirmation passes (pass 10 clean); every finding fixed and the LOWs folded in (§15). **Accepted by the product owner 2026-11-18:** A1, A2 and A4 as designed. **A3** (the Privacy sentence or sentences) comes from the business session; the dev builds everything else, and the Privacy change lands when the wording arrives.
>
> **Decisions:**
> - `BUSINESS-DECISIONS.md` §5, "Consequence: the F2 'founder-held final export' must change";
> - `LAUNCH-TRACKER.md` 2026-11-18, 3d Q1–Q4.
>
> **Builds on** 3b/3c/3c-2's backup AWS account, stack, button pattern and audit.

## 1. Goal and scope
**Goal:** the founder never downloads a customer's data.
- **When a customer asks for their export to be sent** (or for a legal or policy-breach case), the founder presses an **Export workspace** button. A task in the backup AWS account builds the workspace export ZIP from the workspace's database and stores it in a separate S3 bucket. The recipients get an email with a link on cadenzpoint.com that works for **7 days**.
- **Legal-hold copies** live in the same bucket until the founder releases them.
- **The local `tenant:export` command** and its destroy-by bookkeeping are retired.

**In scope:**
1. **The exports bucket and its key** (§6.1).
2. **The export task**, with modes `deliver`, `hold` and `release` (§6.3).
3. **The Export workspace button** (§6.4).
4. **Delivery records and the `export-ready` notice** (§6.5).
5. **The download page** (§6.6).
6. **The hourly expiry sweep and monitoring** (§6.7).
7. **Retiring the F2 local export** (§6.8).
8. **Docs** (§6.9).

**Out of scope:**
- A customer-initiated "send me my export" button: customers export themselves in the app today (Settings → Export Workspace Data), and that's unchanged.
- Changing the export's contents or format.
- Zip64: the existing 65,000-entry and ~3.94 GiB limits stay, and a workspace over them is refused with a message.

## 2. Product-owner decisions and founder duties
| # | Decision | Effect here |
|---|---|---|
| BD §5 | The founder never downloads customer data. A sent export is a cloud job, an S3 location in the backup account, and a link that expires after 7 days. Files expire within 7 days. Legal holds use the same location. | §6.1–§6.7 |
| 2026-11-18 Q1 | The link is on cadenzpoint.com. A page checks it and starts a fresh, short download per click, with Vercel reading that one AWS location through OIDC (no stored key). | §6.6 |
| 2026-11-18 Q2 | Recipients: the notice recipients (active admins and the billing email), plus one verified address the founder may add for a legal or policy case, with an extra typed confirmation. | §6.3, §6.5 |
| 2026-11-18 Q3 | A GitHub button (founder approval; runs in AWS). | §6.4 |
| 2026-11-18 Q4 | A legal-hold copy is kept until the founder releases it; open holds are listed in the digest monthly. | §6.3, §6.7 |
| F5 (2026-10-22) | A breach-suspended workspace: "the founder takes the export (F2 rules) and sends it to a verified contact". | §6.3: **for a `policy_hold` workspace the link goes only to the extra address, which is required.** Its admins aren't sent it (they're who the hold protects against). **Confirm at acceptance (A1).** |

**Open for the product owner at acceptance:**
- **A1, the policy-breach rule:**
  - a `policy_hold` workspace whose export the founder hasn't re-enabled (`policyExportAllowed` false) → the link goes **only** to the extra address, which is required;
  - once the founder has re-enabled export for that workspace (`set-policy-export on`, F5's honest-mistake path), it goes to the normal recipients;
  - **any link sent earlier to the normal recipients** (with or without an extra address alongside) **stops working while the workspace is on such a hold, including after the workspace is deleted** (§6.6). The page shows it as unavailable; it isn't revoked. If the founder lifts the hold or re-enables export within the 7 days, it works again. **After a deletion that's no longer possible** (both commands need `suspended`), so those links stay dead. Only a delivery addressed to the extra address **alone** keeps working;
  - **an export email not yet sent when the hold starts** still goes to its recipients, and its link then shows as unavailable. No data reaches them.
- **A2, the expiry wording:** access ends at exactly 7 days, and an hourly sweep erases the file within 1 hour after that, with S3's own expiry as the backstop (§6.7). BUSINESS-DECISIONS says "files … expire automatically within 7 days". Accept "access ends at 7 days; erased within the hour after", or ask the business session to word it.
- **A3, the Privacy page:** it lists AWS for "encrypted backups" only (`src/app/privacy/page.tsx:51`), and §3 (:43) says data "is then permanently deleted". Export copies are also stored in AWS, and a legal-hold copy can outlive a deletion. The business session supplies the sentence(s).
- **A4, what "verified address" means** (Q2): v1.1 reads it as the founder typing the address twice (two button inputs that must match, both masked), plus the founder's own check out of band, recorded in the reason. If the business side needs more (for example a confirmation email the recipient must click first), it's a scope change.

**Founder duties:**
- **Setup (PRODUCTION-DEPLOY 13b/13d):**
  - deploy the updated `bootstrap.yml` (the Vercel OIDC provider and the exports bucket ARN in `CfnExecRole`);
  - set the Vercel env `EXPORT_DOWNLOAD_ROLE_ARN` and `EXPORT_BUCKET`, and set the Vercel team's OIDC issuer mode to **Team**;
  - press one test delivery against the `rehearsal` workspace.
- **Per request:** press the button, approve, and read the email.
- **Holds:** release each one when the legal reason ends.

## 3. Verified current state (`main` at `17ac1c8`)
- **The export:** `src/lib/export/workspace-export.ts`.
  - `openExportSnapshot(url)` (:51-83) opens a REPEATABLE READ snapshot on the direct host.
  - `createWorkspaceZipStream` (:241-353) returns a pull-based web `ReadableStream` (keyset batches of 5,000) holding one CSV per `EXPORT_TABLES` entry, the two timesheet files, `README.md` and `manifest.json`.
  - Limits are 65,000 entries and ~3.94 GiB, with no Zip64 (:31-32, :293-311). A failure leaves a partial archive (:321).
  - **No Next or `server-only` imports**, and it reads no env. `manifest.ts:1` imports `package.json` (for `APP_VERSION`), and `allowlists.ts` imports `@/db/schema`.
- **The in-app export:** `src/app/api/export/workspace/route.ts`. It needs `requireAdminFresh`, is gated by `canExport` (every mode except `closed`; `policy_hold` only with `policyExportAllowed`), and is rate-limited to 5 per hour per instance.
- **The backup image's bundle guards:**
  - U6 (`backup-static.test.ts:338-346`) pins the bundle's `src/` inputs and requires an exact `COPY` per input;
  - `tsconfig.backup.json` has no `paths`, so `@/` imports don't resolve;
  - `package.json` must not be on the deploy list (:343);
  - U6 also fails if any `src/` file imports `@aws-sdk/*` (:406-416).
- **F2 today:**
  - `scripts/tenant-export.ts`: an AES file on the founder's Mac, plus a `founder-export-taken` audit with a destroy-by date;
  - `founder-export-path.ts`;
  - `tenant:admin export-destroyed` (`admin-commands.ts:285-296`; audits `founder-export-destroyed`/`-legal-hold`);
  - `ops-digest.ts:35-65` `checkFounderExports`, which raises `founder-export-overdue`;
  - `delete-tenant.ts:411-428`: the receipt's `founderExportDestroyBy`;
  - `BACKUP_RETENTION_DAYS` (`lifecycle-config.ts:52`), used only by these;
  - docs: TENANT-DELETION.md :31-50, :101-102, :178-179; PRODUCTION-DEPLOY.md:164.

  **No production workspace exists**, so no founder export was ever taken.
- **Notices:**
  - `NoticeKind` (`lifecycle.ts:149-161`), `isNoticeSuperseded` (:184-215; `deleting`/`deleted` always supersede), `renderNotice` (`notices.ts:101-177`), and templates in `src/lib/email/templates/`;
  - recipients follow D10 (`notices.ts:73-91`), read from the workspace database at delivery;
  - the payload is frozen at first render (:234-240), and the cron runs every 10 minutes (`vercel.json`);
  - `enqueueNotice` is `server-only` with `@/` imports, so the backup bundle can't call it;
  - `tenant_notices` is unique on `(tenant_id, kind, scheduled_for)` (`schema.ts:109`).
- **The backup stack:**
  - one bucket, with a policy of Deny statements only (`backup-stack.yml:90-185`);
  - the KMS key's decrypt is denied except for named roles (:30-81);
  - the button role trusts `environment:aws-disaster` and may RunTask on one family (:631-700);
  - EventBridge emails every start and RunTask (:1331-1392);
  - **`expected-policies.ts` and the audit's `protectionDrift` assume one bucket** (:110-247; `audit.ts:63-131`).
  - `bootstrap.yml:112-134` limits `CfnExecRole`'s S3 actions to `arn:aws:s3:::cadenzpoint-backups-${AccountId}`, and the GitHub OIDC provider is there too (:10-15).
- **Routing:**
  - `src/proxy.ts` only tags the tenant;
  - `tenantFromHost` returns null for the apex;
  - apex token pages exist (`/signup/verify`, with a sha256 token check, `route.ts:69,144`);
  - CSP `form-action 'self' https://*.intuit.com` (`next.config.ts:24`), **so a form POST can't redirect to S3.**
- **The app has no AWS SDK at runtime:** it's in devDependencies only, and there's no `@aws-sdk/s3-request-presigner` or `@vercel/oidc-aws-credentials-provider`.

## 4. External behaviour (verified 2026-11-18)
1. **S3 presigned URLs** (docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html):
   - up to 7 days with IAM user keys;
   - with role credentials, "the presigned URL expires when the role session expires", and ECS task credentials "typically rotate every 1-6 hours";
   - S3 checks expiry at request time, and an in-progress download continues past expiry.

   **So no 7-day S3 link from a task.** The app mints a 5-minute URL per click instead.
2. **Vercel OIDC to AWS** (vercel.com/docs/oidc/aws), available on all plans:
   - an IAM OIDC provider `https://oidc.vercel.com/<team>` with audience `https://vercel.com/<team>`;
   - a role whose trust conditions `sub` = `owner:<team>:project:<project>:environment:production`;
   - in code, `awsCredentialsProvider({ roleArn })` from `@vercel/oidc-aws-credentials-provider`;
   - set `AWS_REGION` explicitly.
3. **S3 lifecycle expiry** (…/lifecycle-expire-general-considerations.html): removal is asynchronous, and "there may be a delay between the expiration date and the date at which Amazon S3 removes an object". **Hence the sweep** (§6.7).
4. **CSP:** a navigation link to S3 isn't governed by `form-action`. A form POST that redirects to S3 is.

## 5. Invariants that must not break
1. **The founder's machine never receives customer data.** The task runs in AWS; the bytes go from S3 straight to the recipient.
2. **Only the export task role writes or deletes in the bucket.** Deliveries, holds and releases run in the `cadenzpoint-backup-export` family; the hourly sweep runs in its own `cadenzpoint-backup-sweep` family **with the same task role**. The Vercel role may only `GetObject` under `delivery/`, through a 5-minute presign. Nothing is public, and every request is TLS-only.
3. **A link works only for its delivery, until its `expires_at` (created + 7 days),** only while it isn't revoked, and only while it isn't unavailable under a policy hold (§6.6). The token is 32 random bytes. The control plane stores its SHA-256 for lookup, plus an encrypted copy that exists only until the email is sent. **Once sent, the token is redacted from the frozen payload** (§6.5).
4. **Recipients are fixed at export time and stored with the delivery (encrypted).** The delivery cron sends to exactly those addresses, **as one separate message per recipient (a Resend batch), so no recipient sees another and no one else gets a copy**, never D10 at send time. At most 50 recipients (refused above that). They are the notice recipients plus the extra address when given, or the extra address only for a `policy_hold` workspace whose export isn't re-enabled (A1). An extra address must be typed twice and match.
5. **The task's logs and the public button log carry ids, never emails, slugs or tokens.** Inputs are masked first. **The token does appear in the request path** of the download page: Vercel's request logs (short retention, accepted) and Sentry's URL capture (scrubbed, §6.6). It also appears in the frozen notice payload and the email provider's log (§6.5).
6. **Hold copies are never served by the download page** and never expire by themselves.
7. **The in-app self-export is unchanged.**

## 6. Design
### 6.1 Storage (`ops/aws/backup-stack.yml`, `bootstrap.yml`)
- **Bucket `cadenzpoint-exports-${AccountId}`:**
  - `RetainExceptOnCreate`; public access blocked; `BucketOwnerEnforced`; versioning denied;
  - **SSE-KMS** with a new key `ExportKey` (alias `alias/cadenzpoint-exports`), with `BucketKeyEnabled`;
  - **lifecycle:**
    - rule `expire-delivery`: prefix `delivery/`, `Expiration: 8` days. It's the backstop: lifecycle counts from the upload start and rounds to midnight UTC, so 7 could remove a file before its link expires;
    - rule `abort-mpu`: `AbortIncompleteMultipartUpload: 1`;
    - no rule for `hold/`.
- **Bucket policy** (Deny statements only, the backup bucket's pattern; principals by `aws:PrincipalArn`):
  - `DenyInsecureTransport`;
  - `DenyVersioningAndObjectLock`;
  - `DenyWritesExceptExportTask` (Put/Delete/Abort): only `ExportTaskRole`, which also runs the sweep;
  - `DenyReadsExceptExportRoles` (`GetObject`): `ExportTaskRole`, plus `ExportDownloadRole` under `delivery/*` only;
  - `DenyPolicyAndLifecycleChangesExceptDeploy`.
- **The `ExportKey` policy is deny-only, by `aws:PrincipalArn`, like the backup key.** It avoids KMS's principal-exists check, since `Fn::Sub` ARNs create no dependency:
  - the root-account statement, as the backup key;
  - `DenyDecryptExceptExportRoles` (covering `kms:Decrypt` and `kms:ReEncrypt*`, as the backup key);
  - `DenyGenerateDataKeyExceptExportTask`;
  - `DenyShortDeletionWindow` (a pending window under 30 days) and `DenyKeyPolicyChangesExceptDeploy`, as the backup key (`expected-policies.ts:142-145`). Legal holds depend on this key.
- **The grants live in the roles' own policies:**
  - **the export task role** (shared by both families): `kms:GenerateDataKey` and `kms:Decrypt`, with `kms:EncryptionContext:aws:s3:arn` = the bucket ARN;
  - **the download role:** `kms:Decrypt`, with `kms:ViaService = s3.us-east-1.amazonaws.com` plus the same context;
  - **the audit role:** `kms:DescribeKey` and `kms:GetKeyPolicy`.

  3b's KMS-change alerts (key disable or deletion) also cover `ExportKey`. A deleted key would destroy legal holds.
- **`bootstrap.yml`** (deployed by hand at setup; 13b hasn't run yet):
  - `CfnExecRole`'s S3 statement gains `arn:aws:s3:::cadenzpoint-exports-${AccountId}`;
  - its KMS alias statement gains `alias/cadenzpoint-exports`;
  - a new `AWS::IAM::OIDCProvider`: URL `https://oidc.vercel.com/<team>`, `ClientIdList` = `https://vercel.com/<team>`, and no thumbprints (as the GitHub provider).

  The backup stack builds its ARN with `Fn::Sub`, the GitHub provider's precedent. The trust condition keys are exactly `oidc.vercel.com/<team>:aud` and `oidc.vercel.com/<team>:sub`.

  The team slug and project name are **template constants**, committed once the founder gives them. They appear in `bootstrap.yml`, `backup-stack.yml` and `expected-policies.ts`, and **U6 asserts the three are equal.** **The Vercel team's issuer mode must be Team** (founder step).

### 6.2 Roles (`backup-stack.yml`, `expected-policies.ts`; all under path `/cadenzpoint-backup/`, named `cadenzpoint-backup-*`, as `BackupRolesOnly` requires)
- **`cadenzpoint-backup-export-task`:**
  - S3: `PutObject`, `GetObject`, `DeleteObject`, `ListBucket`, `AbortMultipartUpload` (exports bucket only);
  - KMS as §6.1;
  - `sns:Publish` to the alert topic;
  - **`ecs:ListTasks` (with an `ecs:cluster` condition) and `ecs:DescribeTasks`** (3c's `ListOwnFamily`/`DescribeTasks`; oldest-wins needs both);
  - `logs:CreateLogStream`/`PutLogEvents` through the exec role only.
  - **No access to the backup bucket or key.**
- **`cadenzpoint-backup-export-exec`:** ECR pull, logs, and `ssm:GetParameters` for `control-plane-url` and `encryption-key`.
- **`cadenzpoint-backup-export-download`:**
  - trusted by the Vercel OIDC provider, with exact `StringEquals` on `aud` = `https://vercel.com/<team>` and `sub` = `owner:<team>:project:<project>:environment:production`;
  - permissions: `s3:GetObject` on `…/delivery/*`, plus `kms:Decrypt` as §6.1;
  - `MaxSessionDuration` 3600.
- **`DisasterButtonRole`:** RunTask gains the `cadenzpoint-backup-export` family, and **`PassDisasterRoles` gains the export task and exec roles.** It stays the same `aws-disaster` environment. The comment at :628-630 ("stops a taskRoleArn override") is updated: with PassRole on both families, an override could swap their roles, which is accepted. Every press needs the founder's approval.
- **`SchedulerRole`:** RunTask gains the `cadenzpoint-backup-sweep` family, and PassRole gains the export task and exec roles. In the stack, and in `expected-policies.ts` as **explicit entries appended to its `RunTasks`/`PassTaskRoles` statements (:236-237). `FAMILIES` is unchanged** (§6.7). U6 asserts it.
- **`expected-policies.ts`, the audit and U6:**
  - generalise to `BUCKETS = [backup, exports]` and `KEYS = [backup, exports]`, each with **its own expected policy and its own expected lifecycle-rule array** (the backup bucket keeps its one rule; the exports bucket has two). `audit.ts`'s single-rule check becomes a per-bucket comparison;
  - `ALL_ROLES` gains the three roles. Because `FAMILIES` is unchanged, their expected documents (trust, inline policy) are **explicit entries in `roles`**, not produced by the exec-role loop (`expected-policies.ts:243`);
  - the audit gets env `EXPORT_KEY_ARN` and `EXPORT_BUCKET`, and its role gains `s3:GetBucketPolicy`, `s3:GetLifecycleConfiguration` and **`s3:GetEncryptionConfiguration`** on the exports bucket, plus `kms:DescribeKey`/`GetKeyPolicy` on `ExportKey`. Encryption is checked **only for the exports bucket**: the backup bucket's role grant doesn't include it, and its data is client-side encrypted;
  - U6's "every task definition has `BACKUP_KMS_KEY_ARN`" rule exempts the export and sweep families;
  - `protectionDrift` checks both buckets and both keys, including **key state** (`Enabled`; `PendingDeletion` → finding);
  - U6 pins it all, including the exact role names and paths.

### 6.3 The export task (`scripts/backup/export.ts`; image command `export`)
**Task definition `cadenzpoint-backup-export`:**
- 1 vCPU / 4 GB;
- secrets: `CONTROL_PLANE_DATABASE_URL`, `ENCRYPTION_KEY`;
- env: `EXPORT_BUCKET`, `ALERT_TOPIC_ARN`;
- its own log group, `/cadenzpoint/backup/export` (365 days).

**Run deadline:** 45 minutes. **Before the upload finishes**, it aborts the upload and fails (any partial object is deleted). **After the upload**, it follows step 4's rule: the object is left, and the outcome is unknown.
- **`openExportSnapshot(url, opts?)` gains an optional options argument**; the app's call is unchanged.
- The task passes `connect_timeout: 30`, plus server-side `idle_in_transaction_session_timeout` and `statement_timeout` (45 minutes) through `connection:`, as `audit.ts:137` does. A half-open socket can't then hold the snapshot past the deadline on the server.
- **Why it's bounded:** a long REPEATABLE READ snapshot holds AccessShare locks, and a migration's `ALTER` queues behind them. That's the same exposure as the in-app export, whose bound is Vercel's 800 s.
- **The ZIP limit** (~3.94 GiB) fits well inside 45 minutes.

**Grammar** (`parseExportArgs`; an unknown flag exits 2):
- `export deliver --workspace <uuid> [--extra <email>] [--reason <text>] --run-id <id>`
- `export hold --workspace <uuid> --reason <text> --run-id <id>`
- `export release --hold <uuid> --reason <text> --run-id <id>`
- `export sweep` (its own family, `cadenzpoint-backup-sweep`, §6.7)

A value starting with `-` is refused (no flag confusion). **`--extra` on `hold` or `release`** is refused with exit 1 (`extra-not-allowed`), not exit 2. `--run-id` is optional and generated when absent (`disaster.ts:116`'s pattern).

**The start:**
- `startedBy` must be `gh-` or `cloudshell-` for deliver, hold and release. **`--extra` is accepted only from a `gh-` start**, because only the button enforces the type-twice check. A `cloudshell-` deliver with `--extra` is refused. **This is an honour-system convention:** `startedBy` is whatever the caller passes, so a CloudShell user could type `gh-…`. It's the same as 3c's gate (`disaster.ts:244`): the founder is the only CloudShell user;
- **`sweep` may run from any caller:** it only deletes expired or revoked delivery copies, and orphaned **delivery** copies (hold orphans are only reported);
- ECS oldest-wins within the `cadenzpoint-backup-export` family. The sweep is a different family, so it never competes, and the button's one-at-a-time check isn't affected;
- an advisory lock `EXPORT_LOCK_KEY` (`728_402_206`, beside 3c's) on the control plane, held only for the short record transaction and **never during the build** (it would block nothing useful);
- log `export <mode> run <runId> started by <x>`.

**`deliver`:**
1. **Load the tenant by id** (a plain read):
   - its status must be `active` or `suspended`, with `db_url_encrypted` set. Otherwise refuse (`not-exportable`: deleted, deleting, provisioning, no database);
   - a `policy_hold` workspace (suspension reason `policy`) with `policy_export_allowed` false **requires** `--extra` (refuse `extra-required`).
1b. **Schema check, inside the snapshot:** the workspace's applied tenant migration count (`drizzle.__drizzle_migrations`; 3c's `migrationCount` query, `disaster-steps.ts:572`) must equal the journal length baked into the image. Otherwise refuse `schema-skew`: "approve the pending Backup system deploy (or run it from Actions → Backup system deploy if none is pending), or run Deploy to Production". The bundled schema can't read columns the database lacks, or miss new ones.
2. **Recipients**, resolved **after the build, just before recording, on a fresh connection after the snapshot closes** (a REPEATABLE READ snapshot can't see later changes), so an admin deactivated mid-build is left out:
   - for a `policy_hold` workspace whose export isn't re-enabled: the extra address only;
   - otherwise D10. It's the task's own copy of `notices.ts:73-91` (which is `server-only`), so **one shared fixture test** (an integration test; `notices.ts` exports `resolveRecipientsAndTimezone` as an internal export for it, with the `server-only` stub as `setup-db.ts:11`) runs both against the same workspace states and requires equal results. It **honours `NOTICE_RECIPIENTS`** (`lifecycle-config.ts:145`, bundled): active admins from the workspace database, plus the billing email, plus the signup email when there's no active admin, plus `--extra` if given;
   - lowercased and deduplicated;
   - none → refuse `no-recipients`; more than 50 → refuse `too-many-recipients`. **For `deliver` only, the same count is pre-checked right after 1b** (after the schema check, so a skewed workspace fails `schema-skew`, not a raw read error), so nothing is built in vain. A workspace over 50 recipients uses the in-app self-export (TENANT-DELETION notes it);
   - the workspace's time zone (`workspace_settings.timezone`, canonicalised) is read here too.
3. **Build:** `openExportSnapshot(decrypt(url))` → `createWorkspaceZipStream` → S3 multipart upload (`@aws-sdk/lib-storage` `Upload`, 8 MiB parts, `IfNoneMatch: '*'`), at key `delivery/<deliveryId>/<slug>-export-<yyyymmdd>.zip`, with SHA-256 computed while streaming.
   - **Failures:** the ZIP limits, a database error or an upload error → abort the upload, delete any object, result `failed`.
   - **The delivery and hold ids are generated before the upload**, because they're in the S3 key.
4. **Record, in one control-plane transaction**, under the `tenant:` lock, with `SET LOCAL lock_timeout = '5s'` and `statement_timeout = '10s'` (`withTenantLock`'s values, `locked.ts:43-44`).

   **Errors that certainly committed nothing** → delete the object at once, and exit 1 with `export refused` (or `export failed`) and its code. That covers every error the server returned **before COMMIT was sent**:
   - a refusal at the re-resolve, such as `no-recipients`;
   - a failed read on the fresh connection;
   - the deadline firing before `BEGIN`;
   - `55P03` on the `pg_advisory_xact_lock` statement.

   This applies to `hold` too.

   **Once the transaction has started, the task never deletes the object after an error.** A record error isn't proof of failure: a COMMIT can succeed with its acknowledgement lost, a dropped socket can still let the server commit, and the deadline or a stop can land mid-commit. On any record error (including the deadline or a stop after the upload), the task:
   - leaves the object;
   - logs, and emails (SNS), `export outcome unknown: deliver, workspace <id>, delivery <id>` (or `hold <id>`);
   - exits 1.

   If the transaction committed, the notice is sent and the link works. If it didn't, the object has no row: the hourly sweep deletes a delivery orphan after 1 day, and reports a hold orphan as `export-orphan-hold`. **Only the `changed` refusal deletes at once**, after its deliberate rollback (a rolled-back transaction can't have committed).

   The transaction:
   - the transaction takes `pg_advisory_xact_lock(hashtext('tenant:' || id))`, the exact key from `locked.ts:64`;
   - **re-read the tenant first.** If its status, suspension reason, `policy_export_allowed` or `db_url_encrypted` changed since step 1 → roll back, then delete the object **outside the lock**, and refuse `changed` ("press again");
   - a `tenant_notices` row by raw SQL: kind `export-ready`, `scheduled_for` = `date_trunc('milliseconds', now())`; `sent_at`, `forced_at` and `superseded_at` null (= pending); the other columns take their defaults. `RETURNING id`;
   - an `export_deliveries` row (§6.5) carrying **`notice_id` = that id**, and **`extra_only` = (`suspension_reason = 'policy'` AND NOT `policy_export_allowed`)**, computed from **this same re-read** that guards `changed`;
   - a `tenant_audit_events` row `export-delivered` (detail: delivery id, recipient count, an extra-address flag, the reason's length).
5. **Email the founder** (SNS, the run's closing line, see below). **A publish failure after the commit is logged, and the exit stays 0** (3c's rule, `disaster.ts:339-341`). The id is in the `export-delivered` audit event, which `tenant:admin show <slug>` prints (`scripts/tenant-admin.ts:202-204`).

**`hold`:**
- **step 1's status check only** (`active`/`suspended` with a database; **no recipient checks**: `extra-required`, `no-recipients` and `too-many-recipients` are deliver-only), then 1b (schema-skew) and 3, with key `hold/<holdId>/<slug>-export-<yyyymmdd>.zip`;
- then an `export_holds` row (id, tenant id, key, bytes, sha256, reason, `run_id`, created_at, `released_at` null, `release_reason` null);
- audit `export-held` **with the hold id in its detail**; an SNS line **including the hold id** (`export held: workspace <id>, hold <id>`), which `release` needs.
- **No email to customers.**
- **`hold` records under the same `tenant:` lock and timeouts as `deliver` step 4.** A certain no-commit error deletes the object at once; any other record failure leaves the object, "outcome unknown: hold <id>" is logged and emailed, and the exit is 1. A committed hold is listed by the digest; an uncommitted one is reported by the sweep as `export-orphan-hold`.
- Allowed in every exportable status, including `policy_hold`, with no `--extra`.

**`release`:**
- load the hold; already released → refuse `released`;
- delete the object, then verify with a 404;
- set `released_at` and `release_reason`; audit `export-hold-released`.

**`sweep`:** hourly (§6.7).

**Exit codes:** pass 0; refusal or failure 1. Unknown-flag version skew 2, as 3c.

**Every run, of every mode except `sweep`, ends with one SNS line to the founder,** with ids and codes only (invariant 5), whatever its outcome:
- `export delivered: workspace <id>, delivery <id>, <n> recipient(s), expires <iso>`;
- `export held: workspace <id>, hold <id>`;
- `export released: hold <id>`;
- `export refused: <mode>, <target>, <code>`, where the target is `workspace <id>` or, for `release`, `hold <id>` (e.g. `schema-skew`, `changed`, `not-exportable`, `extra-required`, `no-recipients`, `released`);
- `export failed: <mode>, <target>, <code>` (a database or upload error, a deadline before the upload finished, `too-large`). An exit-2 parse error publishes `export failed: parse, -, version-skew`;
- **`export outcome unknown: <mode>, workspace <id>, delivery <id>`** (or `hold <id>`).

A failed publish is logged, and the exit code stands.

### 6.4 The Export workspace button (`.github/workflows/export-workspace.yml`, `scripts/backup/export-button.sh`)
- **Workflow:**
  - `workflow_dispatch`, inputs: `mode` (choice: `deliver`, `hold`, `release`), `target` (a workspace uuid, or a hold uuid for release), `extra_recipient` (optional), **`extra_recipient_again`** (required when there's an extra address, and must match exactly), `reason` (optional; required for hold, release, and deliver with an extra address), `confirm`;
  - `confirm` must equal `<mode>`;
  - main only, `vars.AWS_BACKUPS_ENABLED`, environment `aws-disaster` (founder approval), `queue: max`, an `if: cancelled()` stop step.
- **The script follows 3c's button:**
  - inputs are read from the event file and **masked before anything prints** (target, both address inputs, reason); a mismatch between the two addresses → refuse before any AWS call;
  - single-line inputs only;
  - validation: a uuid; the email address against a strict pattern, at most 254 characters; the reason at most 200 characters, no control characters;
  - `extra_recipient` given for `hold` or `release` → refuse before any AWS call;
  - the stack output `ExportModes` gate;
  - one task at a time;
  - `run-task` with `--started-by gh-<run>-<attempt>`;
  - wait, then report the exit code.

  The reason is passed to the task as an argument; it's masked in the log, and the task logs only its length.
- **The address and reason appear in CloudTrail's RunTask `overrides`** (the backup account, founder-only). That's accepted and documented.
- **Separate rules, `ExportStartedRule` and `ExportRunTaskRule`**, with export wording ("Export workspace task started …"), matching only the `cadenzpoint-backup-export` family. So every press is emailed, and **the hourly sweep is never emailed.**
  - Both rules are in the audit's `InspectRules` list.
  - `CfnExecRole`'s `AlertRules` grant covers them.

### 6.5 Delivery records and the `export-ready` notice
- **Table `export_deliveries`:**
  - columns: `id` uuid PK; `tenant_id` FK; **`notice_id` uuid unique** (FK `tenant_notices`); `s3_key`; `bytes`; `sha256`; `token_hash` char(64) unique; `token_encrypted` text null; `recipients_encrypted` text (a JSON array, `encrypt()`ed); **`time_zone`** varchar(100); `extra_recipient` boolean; **`extra_only`** boolean **NOT NULL, no default** (true only when the policy-hold rule sent it to the extra address alone; set by step 4); `reason` text null; `created_at`; `expires_at`; `revoked_at` null; `erased_at` null; `download_count` int default 0; `last_download_at` null; `run_id`;
  - index `(tenant_id, created_at)`;
  - **table `export_holds`** as in §6.3;
  - one drizzle-kit control-plane migration.
- **`NoticeKind`** gains `export-ready`.
- **`isNoticeSuperseded` is never consulted for `export-ready`:** the `deliverNotice` branch below decides. As a backstop, `isNoticeSuperseded` returns `false` for `export-ready` **before** its `deleting`/`deleted` line (`lifecycle.ts:187`).
- **`deliverNotice` gains an `export-ready` branch right after the claim** (`notices.ts:207`), **before the generic supersede check** (:209-213). The generic check would supersede `deleting`/`deleted`:
  - load the delivery by `notice_id = claimed.id`, and the tenant's **control-plane row** (a tombstone is fine; `renderNotice` needs its name and slug);
  - if it's missing, revoked, expired or erased → supersede and stop. **Never fall through to D10**;
  - otherwise skip `isNoticeSuperseded`;
  - in the freeze: the decrypted stored recipients and the time zone;
  - **the send:** `client.batch.send(messages, { idempotencyKey: \`${noticeId}:${generation}\`, batchValidation: 'strict' })`, **raced against an attempt timeout** as `send-batch.ts:97-99` does (a timeout counts as failed and is retried with the same key), as `send-batch.ts:98` calls it but **strict** (all or nothing), with **one message per recipient** (`to: [address]`, the same subject and HTML). No support copy and no `bcc`;
  - **outcome rules,** specific to this kind:
    - **sent** only when `result.data.data` is an array of exactly N elements, each with a non-empty string `.id` (as `settleOk` checks), N being the number of recipients. Then `provider_message_id` = the first id (the column is `varchar(100)`; the full id list goes into the existing `payload` jsonb as `providerIds`), and `recipients` = the real list, which is the proof of notice;
    - anything else (an error, or a short or malformed array) → **failed**, and the next cron retries with the same key;
    - errors are classified **by name**, exactly as `notices.ts:283-288`: `concurrent_idempotent_requests`, `rate_limit_exceeded` or a 429 → retried; `invalid_idempotent_request` raises its existing alert;
    - **the permissive reminder helper (`deliverReminderBatch`) is not reused**: it counts a partial success as sent;
  - it **never** reads the workspace database, so a dropped or tombstoned workspace still gets its email;
  - the 23-hour refreeze uses the same branch.
- **`renderNotice` for `export-ready`:**
  - the link `apexBaseUrl() + '/export/' + token` (decrypting `token_encrypted`);
  - the time zone formatting uses `canonicalTimeZone` (so `src/lib/calendar-date.ts` is in the closure only if the task uses it; the task stores the canonical zone);
  - "works until <date and time, in the stored time zone>", with a new `fmtDateTime` (the existing `fmt` is date only);
  - template `export-ready.tsx` (`LifecycleLayout`): "Your CadenzPoint workspace export is ready", the workspace name, the link, the expiry, "If you didn't ask for this, contact support@cadenzpoint.com".
- **After the notice is sent** (`sent_at` set), in the same transaction:
  - `token_encrypted` is nulled;
  - **the token is replaced in `payload.html` with `[link removed after sending]`.** (`stated` never contains the link.)
  - The `sent_at` write becomes a transaction that includes both.
  - **On supersede** (revoke, expiry, or a missing delivery), the same nulling and redaction apply.
  - The recipient addresses stay in `tenant_notices.recipients` as the proof of notice, which is accepted (that's the table's purpose).

  The token is still in the email provider's log, and in the recipients' mailboxes. That's accepted: it stops working at `expires_at` or on revoke.
- **Other supersede and force paths:** `set-exempt on`'s blanket supersede (`admin-commands.ts:121-123`) and `scripts/register-tenant.ts:45-46` both exclude `export-ready`. `force-notice-sent` (`admin-commands.ts:257-281`) refuses `export-ready` ("use `export-revoke`").
- **`tenant:admin export-revoke <delivery-id> [--yes]`:**
  - refuses an unknown or already revoked/erased delivery;
  - without `--yes`, prints what it will do;
  - with it, **under `withTenantLock`:** sets `revoked_at`, audits `export-revoked` and supersedes the pending notice in the same transaction;
  - **if the notice's lease is live** (a send in flight), it warns "the email may already be going out; the link is dead either way".

  The sweep then erases the file.

### 6.6 The download page (`src/app/export/[token]/page.tsx` plus a server action)
**The page:**
- **apex only:** on a workspace host it redirects to the apex, as `/signup/page.tsx` does;
- **a malformed token** (not 43 base64url characters) shows the "expired" text without a database read;
- **GET:** look up `token_hash = sha256(token)` and render one of:
  - **valid:** "Workspace export for <workspace name> · <size> · works until <date>" and a **Prepare download** form (POST to self);
  - **expired, revoked or erased:** "This link has expired. Ask support@cadenzpoint.com for a new one";
  - **unknown:** the same text (no oracle).

  A GET never mints a URL, so email scanners fetch only the page.

**Policy hold:** a delivery with **`extra_only` false** is **unavailable** (the "expired" text, no URL) while its tenant has `suspension_reason = 'policy'` and `policy_export_allowed` false, **whatever its status**. `tenant:delete` keeps both on the tombstone, so deleting a breach workspace doesn't release the block; `unsuspend` clears the reason (`admin-commands.ts:101`). The seed tool `register-tenant.ts:37` also clears it on re-register (dev and seed only). Both GET and POST check this, reading the tenant row. A delivery with `extra_only` true (the founder's verified address alone) is unaffected (A1).

**POST (the server action):**
- re-check the token (valid, not expired or revoked, and not unavailable under a policy hold);
- rate-limit **first, by IP**, with `getClientIpFromHeaders` (`rate-limit.ts:23-31`) plus `ipIdentifier` (`rate-limit/identifier.ts:30`; Vercel sets `x-forwarded-for`) → `exportDownloadIp` (30 per hour); then check the token; then `exportDownload` per delivery (20 per hour). Both are `SHARED_LIMITS` entries (camelCase, `limits.ts:7-10`). The header comment at `limits.ts:2-3` ("export limits stay in memory") is updated;
- mint a **5-minute** presigned GET (`ResponseContentDisposition: attachment; filename="<file>"`) with `awsCredentialsProvider({ roleArn: EXPORT_DOWNLOAD_ROLE_ARN })`;
- increment `download_count` and set `last_download_at`;
- re-render the page with a plain **Download** link to that URL, "valid for 5 minutes". Navigation isn't governed by `form-action`.

**Headers:**
- a `headers()` entry in `next.config.ts` for `/export/:path*`, **appended after the global `/:path*` entry** (the last match wins), with `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`. T8 checks the built headers for `/export/x`;
- page metadata `referrer: 'no-referrer'`, `robots: { index: false }`.

**Sentry:** one shared deep scrub, the regex `/export/[A-Za-z0-9_-]{43}` → `/export/[token]`, applied to every string field (URLs, transaction names, span descriptions and data, breadcrumbs, `request.url`). It's wired into `beforeSend`, `beforeSendTransaction` and `beforeBreadcrumb` in **all three inits**: `sentry.server.config.ts`, `sentry.edge.config.ts` and `src/instrumentation-client.ts`. A test per runtime.

**Packages:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` and `@vercel/oidc-aws-credentials-provider` move to runtime `dependencies`, all at exact versions. **U6's "no `@aws-sdk` in `src/`" rule** gains one allowed file, `src/lib/export/download-url.ts`, and that file is the only importer.

**Env:**
- `EXPORT_DOWNLOAD_ROLE_ARN` and `EXPORT_BUCKET` (production only);
- the region is **hard-coded `us-east-1`** in `download-url.ts` (Vercel sets `AWS_REGION` itself);
- `awsCredentialsProvider({ roleArn })` with **no `audience` option** (the trust `aud` is the default);
- **either value missing, or an assume-role or presign error** (only after a valid token) → the page says "downloads aren't available; contact support", and raises `export-download-misconfigured` with **`raiseAlertWithEmail`** (`ops-alert-email.ts`, the signup pattern), because a customer is waiting. It's global and deduped, and the next successful presign resolves it.

**Package pins:** `@aws-sdk/s3-request-presigner` at the same version as `client-s3`. The dev checks `@smithy/types` dedupes after adding the OIDC package.

**Note:** a presigned URL can stop working before 5 minutes if the cached role session ends first. A download already in progress continues; the page says "if the link doesn't work, prepare it again".

### 6.7 The hourly expiry sweep and monitoring
- **Task family `cadenzpoint-backup-sweep`:**
  - the same image; 0.25 vCPU / 0.5 GB;
  - **the same task role and the same execution role** as the export family (`cadenzpoint-backup-export-exec`, whose `WriteLogs` covers both `/cadenzpoint/backup/export` and `/cadenzpoint/backup/sweep`); a secret for `CONTROL_PLANE_DATABASE_URL`; env `EXPORT_BUCKET`;
  - **`FAMILIES` in `expected-policies.ts` is not extended** (that would expect sweep roles that don't exist). The sweep's task definition and `SchedulerRole`'s RunTask and PassRole get **explicit expected entries**, appended to `SchedulerRole`'s `RunTasks`/`PassTaskRoles` statements (`expected-policies.ts:236-237`). U6 asserts both;
  - **U6's schedule rules:** the count becomes **8** (`backup-static.test.ts:167`); the "DependsOn every other resource" rule applies to **all eight** schedules, so every existing schedule's `DependsOn` grows with the new resources (`:179-181`); its `Input` uses the pinned shape, `{"containerOverrides":[{"name":"<container>","command":["export","sweep"]}]}` (:189);
  - its own log group, `/cadenzpoint/backup/sweep` (30 days).
- **Schedule `cadenzpoint-backup-export-sweep`:** EventBridge Scheduler, `rate(1 hour)`, input `["export","sweep"]`. `SchedulerRole` has RunTask and PassRole for it (§6.2).
  - **Not covered by the export start or RunTask email rules** (a different family).
  - **A start failure** goes to the existing schedule DLQ alarm.
- **The sweep's limits:** a 15-minute run deadline, plus `connect_timeout` and server-side `statement_timeout` (as `audit.ts:137`), so a hung sweep can't pile up hourly starts.
- **What `sweep` does (row-driven):**
  0. **if any control-plane read fails, stop.** Orphan steps never run on a lookup error, so an error can't be mistaken for "no row";
  1. for every `export_deliveries` row with `erased_at IS NULL AND (expires_at <= now() OR revoked_at IS NOT NULL)`, delete `s3_key` (an already-missing object counts as done), then set `erased_at`;
  2. **delivery orphans:** list `delivery/` and delete objects with no delivery row that are older than 1 day;
  3. **hold orphans:** list `hold/`. An object with no `export_holds` row that is older than 1 day is **not deleted** (it may be a legal copy whose row a control-plane rollback lost). It raises `export-orphan-hold` (global, dedup = key; the founder contacts the lead). Holds with rows are never touched.
  - **Access ends at `expires_at`, and the file is erased within the next hour.** Lifecycle's 8 days is the backstop.
- **Findings,** in `ops-digest.ts`, in the slot `checkFounderExports` leaves (:80), with their own raise and resolve, **not** 3b's `syncBackupAlerts` (whose sweep would auto-resolve them):
  - **`export-copy-overdue`:** any row with `erased_at IS NULL AND LEAST(COALESCE(revoked_at, expires_at), expires_at) < now() - interval '6 hours'`; resolved when none remain;
  - **`export-download-misconfigured`:** raised by the page (§6.6), and resolved on success;
  - **`export-orphan-hold`:** raised **and resolved by the sweep** (it's the only one that can list S3), when that key has a row or is gone. **The lead's runbook:** check the key's provenance; then insert the `export_holds` row (hold id from the key path) and `release` it, or keep it as a hold.
  - The findings run in the daily digest, so "after 6 hours" means **at the first digest at least 6 hours after expiry** (up to about 30 hours).
- **The digest:**
  - **a line every day:** "Exports in the last 7 days: N delivered, M downloads, K not yet emailed (notice `sent_at` and `superseded_at` both null). Open legal holds: H (oldest D days)";
  - **on UTC day 1:** also a section listing every open hold (hold id, workspace id, age, reason).

### 6.8 Retiring the F2 local export
**Delete:**
- `scripts/tenant-export.ts` and its `package.json` script;
- `src/lib/export/founder-export-path.ts`;
- the `export-destroyed` command (`admin-commands.ts:285-296`, `tenant-admin.ts`);
- `ops-digest.ts`'s `checkFounderExports`, its type and its call;
- the receipt field `founderExportDestroyBy` and its print;
- the tests that pin them.

**`BACKUP_RETENTION_DAYS`** is used only by these, so it's removed, and `TENANT-DELETION.md:160`'s D11 paragraph is reworded (backups expire per 3b; export copies per §6.7; holds per §6.3).

**The receipt** gains a line "Export copies: N delivered (expire automatically); M open hold(s)", and **`tenant:delete` refuses nothing new.** A hold survives the deletion by design (a legal exception, Terms §9.3).

**The export error messages** (`workspace-export.ts:19,293,307,311`) say "contact the lead" instead of naming `tenant:export`.

### 6.9 Docs
- **`TENANT-DELETION.md` "Final export"** is rewritten:
  - the button;
  - the policy-hold rule;
  - **in bold, at the top of the section:** "take the export and wait until the Export workspace run has passed (the run's result, or the 'export delivered' email) before running `tenant:delete`";
  - **"If you get `export outcome unknown`":** run `npm run tenant:admin -- show <slug>` and look for an `export-delivered` (or `export-held`) audit event whose detail has that delivery (or hold) id.
    - **Found:** it worked. Don't press again.
    - **Not found after 10 minutes:** press again. A leftover delivery copy is erased by the sweep after a day; a leftover **hold** copy raises `export-orphan-hold` instead, so tell the lead.
  - **"If a run failed and no export email arrived"** (the task was killed): treat it as outcome unknown. Use `show`, and look for a recent `export-delivered`/`export-held` event. Nothing technical stops a deletion during an export build; the export then fails `changed`;
  - holds.
- **`PRODUCTION-DEPLOY.md`:**
  - 13b: the bootstrap update;
  - 13d (new): the Vercel env, a test delivery against `rehearsal` (download it in a private window and check the ZIP opens), then revoke it;
  - :164 drops `export-destroyed`.
- **`feature-plan-terms-compliance-fixes.md` F2:** a note that it's superseded by 3d.
- **`FOUNDER-ACCOUNTS-SETUP.md`:** the Vercel team slug and project name for the bootstrap constants.
- **The Privacy page:** A3 (the business session's sentence).

## 7. State machines
### 7.1 A delivery
| State | Event | Next | Side effects |
|---|---|---|---|
| — | `deliver` passes | `active` | row, notice, audit, SNS |
| `active` | a page POST with valid rate | `active` | a 5-minute URL; `download_count + 1` |
| `active` (`extra_only` false) | the tenant goes on a policy hold, or `set-policy-export off` during one | `unavailable` | none (computed at read) |
| `active` (`extra_only` true) | a policy hold | `active` | none |
| `active` | `tenant:delete` without a policy hold | `active` | none (the page needs only the delivery and the tombstone) |
| `unavailable` | a page GET or POST | `unavailable` | the "expired" text; no URL |
| `unavailable` | `unsuspend` or `set-policy-export on` (before expiry) | `active` | none |
| `unavailable` | `tenant:delete` | `unavailable` | the tombstone keeps the reason; permanent |
| `unavailable` | `now >= expires_at` | `expired` | none |
| `unavailable` | `export-revoke --yes` | `revoked` | as revoke |
| `active` | `now >= expires_at` | `expired` | the page shows "expired"; no URL |
| `active` | `export-revoke --yes` | `revoked` | audit; the pending notice superseded |
| `expired` or `revoked` | the hourly sweep (row-driven) | `erased` | the object deleted (a missing one counts); `erased_at` |
| `erased` | a page GET | `erased` | "expired" |
| `expired` | a page GET or POST | `expired` | "expired"; no URL |
| `revoked` | a page GET or POST | `revoked` | "expired"; no URL |
| `erased` | a page POST | `erased` | "expired"; no URL |
| — | a record error after the transaction started | `active` if it committed; otherwise no row (the sweep erases the object after 1 day) | SNS "outcome unknown" |
| `active` | a page POST over a rate limit | `active` | refused ("try again later"); no presign |
| `revoked` or `erased` | `export-revoke` | unchanged | refused |

"Can't happen": `erased` → `active`. Nothing un-erases, and a new press creates a new delivery.

### 7.2 A hold
| State | Event | Next |
|---|---|---|
| — | `hold` passes | `open` (row, audit, SNS) |
| `open` | `release` | `released` (object deleted and verified; audit) |
| `open` | first digest of the month | `open` (listed) |
| `released` | `release` again | `released` (refused `released`) |

### 7.3 The export notice
`pending` → (cron) `sent`, with the delivery machinery unchanged except for the stored-recipients branch.
- **Superseded only when its delivery is revoked, expired or erased**, never by `deleting`/`deleted` or `set-exempt`.
- If the send fails, it retries as today.
- **On `sent` or supersede, `token_encrypted` is nulled and the token is redacted from `payload.html`.**
- Unsent ones show in the digest line.

## 8. Failure modes
| # | Situation | Behaviour |
|---|---|---|
| F1 | A workspace over the ZIP limits | `failed` with "too large for a single ZIP: contact the lead"; nothing stored |
| F2 | A database error mid-stream | the upload aborted, any object deleted, `failed` |
| F3 | The upload succeeds but recording errors after the transaction started (including a lost acknowledgement, the deadline or a stop) | the object is left; SNS "outcome unknown" with the delivery id; exit 1. The runbook: `tenant:admin show <slug>` → `export-delivered` with that id means done. Committed → the email and working link. Not → the sweep erases the orphan after 1 day |
| F4 | The task dies after upload, before recording | an orphan object with no row → the hourly sweep deletes it after 1 day |
| F5 | The notice fails to send | retried by the cron; the digest shows "not yet emailed" |
| F6 | A workspace deleted (or its database dropped) before the email sends | still sent to the stored recipients with the stored time zone: the branch never reads the workspace database. The page doesn't need the workspace |
| F7 | A leaked link | it works until 7 days or until `export-revoke`; rate-limited; downloads counted |
| F8 | An email scanner prefetches the link | a GET only renders the page; no URL is minted |
| F9 | Vercel's OIDC role is misconfigured | the page shows the support text; `export-download-misconfigured` |
| F10 | Two presses at once | ECS oldest-wins plus the lock |
| F11 | A press for a `policy_hold` workspace without an extra address | refused `extra-required` |
| F12 | A typo in the extra address | the two address inputs must match, or the press is refused before AWS; a wrong but matching address → `export-revoke` (supersedes the unsent email) and press again |
| F14 | The workspace becomes policy-suspended during the build | step 4's re-read refuses `changed`; the object is deleted |
| F15 | Image and workspace schemas differ | `schema-skew` before any read |
| F16 | The export hangs (half-open socket) | before the upload finishes, the 45-minute deadline aborts it and fails; after the upload, step 4's rule (object left, outcome unknown). The lock is never held during the build |
| F17 | The sweep fails repeatedly | start failures → the schedule DLQ alarm; the effect → `export-copy-overdue` after 6 hours (an app query in the digest); a lifecycle-deleted object still gets `erased_at` on the next good sweep (row-driven) |
| F18 | A revoke while the send is in flight | the email may still go; the link is dead (revoked); `export-revoke` warns |
| F19 | Two recipients from different parties | one separate message each (a batch): neither sees the other, and no support copy exists |
| F20 | A hold task dies after upload, or a control-plane rollback loses a hold row | the orphaned hold object is kept and raises `export-orphan-hold`; the founder contacts the lead |
| F21 | A workspace put on a policy hold after a link reached its admins | every delivery with `extra_only` false (even one that also had an extra address) is unavailable while the hold lasts, including after deletion; an email still pending at that moment is sent and its link shows unavailable; `extra_only` links keep working |
| F22 | An SNS publish fails | logged; the exit code stands; the audit event (`tenant:admin show`) has the id |
| F23 | A hold's record step errors after upload | the object is left; "outcome unknown: hold <id>"; exit 1. Committed → listed as a hold. Not → the sweep reports `export-orphan-hold` (never deletes it) |
| F13 | A release of a hold whose object is already gone | the delete is idempotent; a 404 verifies; it's released |

## 9. Platform limits
- **ZIP limit** ~3.94 GiB. Multipart with 8 MiB parts gives up to 505 parts, well under 10,000.
- **ECS** 1 vCPU / 4 GB. Streaming keeps memory bounded (`highWaterMark 0`, 5,000-row batches).
- **Vercel:** the page and action are light (one control-plane read and one presign).
- **S3 storage:** cents per GB-month for at most 7 days, plus holds.
- **The sweep:** 0.25 vCPU / 0.5 GB, hourly, for about a minute each: well under $1 a month.

## 10. Blast radius
- **Stack:**
  - `ops/aws/backup-stack.yml`:
    - the bucket and its policy; `ExportKey` and its alias;
    - the task, exec and download roles;
    - the export and sweep task definitions; the `/export` and `/sweep` log groups;
    - the sweep schedule;
    - the `ExportStartedRule` and `ExportRunTaskRule`;
    - the `ExportModes` output, plus **`ExportDownloadRoleArn` and `ExportBucket` outputs** (the founder copies both into Vercel);
    - the button's RunTask and PassRole; `SchedulerRole`'s RunTask and PassRole;
    - the audit role's reads;
  - `ops/aws/bootstrap.yml`.
- **`scripts/backup/`:**
  - `main.ts` (the `export` command);
  - `export.ts` and `export-button.sh` (new);
  - `lib/expected-policies.ts` and `audit.ts` (multi-bucket);
  - `export.ts` (`deliver`, `hold`, `release` and `sweep`); **`backup.ts` is unchanged** (the backup task can't delete in the exports bucket);
  - `deploy-paths.txt`, `bundle.mjs`, `tsconfig.backup.json` (`paths` for `@/`), `Dockerfile.backup`: **exact files**, each with a COPY line, a tsconfig `include` and a deploy-paths entry: `src/lib/export/workspace-export.ts`, `src/lib/export/allowlists.ts`, `src/lib/export/manifest.ts`, `src/db/schema.ts`, `src/lib/db/pg-url.ts`, `src/lib/provenance.ts`, `src/lib/csv/escape.ts`, plus `src/lib/calendar-date.ts` if the closure needs it (the dev confirms with esbuild's metafile). **Also `drizzle/meta/_journal.json`**: it's read at build time for the journal length, so it isn't a metafile input. U6 asserts its COPY line and its `deploy-paths` entry. **Not** `download-url.ts`.
  - **`APP_VERSION`:** the app keeps `manifest.ts`'s `package.json` import, unchanged. `bundle.mjs` adds an esbuild **`onResolve`/`onLoad` plugin** that serves `{ "version": "<read at build time>" }` for that import. `define` can't replace an imported binding, and `alias` doesn't apply to relative paths. U6 asserts `package.json` isn't in the metafile, and exempts the plugin's virtual namespace from its `listed()` check (`backup-static.test.ts:340`). `package.json` stays off the deploy list, so an export manifest can carry the version of the last backup deploy rather than the newest app release. That's accepted and documented in the README the ZIP carries.
  - **The image's migration journal length:** a `declare const __TENANT_JOURNAL_LENGTH__: number` global, set by esbuild `define` from `drizzle/meta/_journal.json`'s entry count. The same `define` goes in the vitest configs.
- **`.github/workflows/export-workspace.yml`** (new).
- **App:**
  - `src/app/export/[token]/page.tsx` and its action (new); `src/lib/export/download-url.ts` (new);
  - `src/db/control-plane/schema.ts` plus one migration;
  - `src/lib/tenant/lifecycle.ts` (`NoticeKind`, supersede); `notices.ts` (render, stored recipients); `src/lib/email/templates/export-ready.tsx`;
  - `admin-commands.ts` and `tenant-admin.ts` (`export-revoke`; `export-destroyed` removed; `set-exempt`'s supersede excludes `export-ready`);
  - `next.config.ts` (the `/export` headers); `src/lib/rate-limit/limits.ts` (two entries); the Sentry configs (the scrub);
  - `ops-digest.ts`; `delete-tenant.ts`; `scripts/delete-tenant.ts`;
  - `src/lib/export/workspace-export.ts` (messages);
  - `package.json` (runtime dependencies).
- **Retired files** (§6.8).
- **Docs** (§6.9).
- **Tests:** §11, plus the edits to U6, `tenant-delete`, `tenant-admin` and `ops-retention-scripts`.

## 11. Required tests (each fails without the change it proves)
**Testing rules (3c lessons):** wait on real state, not fixed sleeps. Each new integration file is run 5 times in a row and once under a CPU hog. Each test world uses its own scratch databases.

| # | Scenario |
|---|---|
| T1 | `parseExportArgs`: every mode and its required flags; an unknown flag exits 2; a bad uuid, email or reason refused; `--extra` on `hold`/`release` → exit 1 `extra-not-allowed` |
| T2 | `deliver` against a scratch workspace with fake S3: the ZIP under `delivery/<id>/`; the SHA-256 matches; the notice, delivery (`notice_id`) and audit in one transaction; the recipients are D10 per `NOTICE_RECIPIENTS` plus the extra address, lowercased and deduplicated; the time zone stored; a schema-skewed workspace fails `schema-skew` before the recipient count |
| T3 | `policy_hold` with export not re-enabled: without `--extra` refused; with it, the recipients are exactly the extra address and **`extra_only` is true**. With `policy_export_allowed`: the normal recipients, `extra_only` false. A normal deliver plus extra → `extra_only` false. A suspension starting mid-build → `changed`, the object deleted |
| T4 | Statuses: deleted, deleting, provisioning and no URL → `not-exportable` |
| T5 | Failure paths: the ZIP limit, a database error, an upload error before completion → no row, the object deleted, the upload aborted; **a record error after the upload** (a lost acknowledgement, a delayed commit, a deadline mid-record) → the object kept, "outcome unknown: delivery <id>" logged, exit 1, and **with the commit done the email is sent and the link works**; a `changed` refusal → the object deleted at once; an SNS failure after commit → exit 0 |
| T6 | `hold` and `release`: the schema-skew check applies; no recipient checks for a hold (a `policy_hold` workspace without `--extra`, one with no recipients, and one over 50 all pass); the hold row and object; the `export-held` audit carries the hold id; a hold record error → the object kept, outcome unknown, exit 1; a release deletes and verifies; a release of an already-gone object succeeds (F13); a second release refused |
| T7 | The notice **through `deliverNotice`**: the branch runs before the generic supersede; **one batch message per stored recipient** (no `bcc`, no support copy; a `policy_hold` export never reaches an admin); `recipients` records the real list; sent for a dropped database and for a tombstoned workspace; not superseded by `deleting`/`deleted`/`set-exempt`/`register-tenant`; superseded after revoke or expiry, or with a missing delivery (never D10), with the token nulled and redacted on supersede too; `force-notice-sent` refuses it; `isNoticeSuperseded` backstop; the link via `apexBaseUrl()`; the date and time in the stored time zone; on send, the token nulled and redacted in one transaction; the millisecond `scheduled_for` and the `notice_id` link |
| T8 | The page GET: valid, expired, revoked, erased, unknown, malformed (no database read) and workspace-host-redirect states; **a GET never calls the presigner** (spy); the `/export` headers in the built config; the Sentry scrub |
| T9 | The POST: re-checks; rate limit; a 5-minute presign with attachment disposition; `download_count` incremented; an expired token refused |
| T10 | Either env value missing, or an assume-role or presign error → the support text plus the deduped alert; resolved on success |
| T11 | The sweep (its own family, the export exec role): row-driven deletes of expired and revoked keys; a missing object still sets `erased_at`; delivery orphans older than 1 day deleted, **a row-less `delivery/` object under 1 day old kept**; **a control-plane lookup error stops before any orphan step**; hold orphans raise `export-orphan-hold` and are never deleted; holds with rows untouched; runnable from any caller |
| T12 | `export-copy-overdue` in ops-digest (the `LEAST` query at 6 hours; resolved when none; not touched by `syncBackupAlerts`); the daily line's counts (K excludes superseded) and the open-hold count; the full hold list on UTC day 1 |
| T13 | U6 and the stack: the bucket policy statements; lifecycle (`delivery/` 8 days, no hold rule); **the deny-only `ExportKey` policy** and the role-side KMS grants; the three roles' names and paths; the task role's ECS reads; the button's RunTask families and PassRole; **`SchedulerRole`'s sweep RunTask and PassRole**; the **separate** export start and RunTask rules (export family only, not the sweep); the sweep schedule and family; `ExportModes`, **`ExportDownloadRoleArn` and `ExportBucket` outputs**; bootstrap (OIDC provider, `CfnExecRole` bucket and alias); the team-slug constants equal in three files; the audit's per-bucket rule arrays, its exports-only encryption check and both keys' state; the `BACKUP_KMS_KEY_ARN` exemption |
| T14 | U6: the only `src/` importer of `@aws-sdk` is `download-url.ts`; the bundle's `src/` inputs are exact, with COPY lines; `package.json` never bundled |
| T15 | The button: masking (target, both addresses, reason never visible); the two addresses must match; an extra address on `hold` or `release` refused; confirm = mode; a leading `-` refused; validation; the `ExportModes` gate; one at a time |
| T16 | Retired: no `tenant:export` script, no `export-destroyed`, no `founder-export-overdue`; the receipt line; `tenant:delete` behaviour otherwise unchanged |
| T17 | Logs: ids only, in the export **and sweep** tasks (never S3 keys, which contain the slug); the reason logged as a length |
| T18 | The in-app export route is unchanged (existing tests pass as-is); the in-app manifest still carries `package.json`'s version |
| T27 | Batch outcome: exactly N elements with string `.id` → sent (first id stored, all in `payload.providerIds`); a short array, a `validation_error` or a 429 → failed and retried with the same key; retry-by-name classification; strict validation set; **the 23-hour refreeze after a failed batch** bumps the generation and key, re-renders from `token_encrypted`, and keeps the stored recipients (never D10) |
| T26 | More than 50 recipients → `too-many-recipients` |
| T30 | The closing SNS line for each outcome (delivered, held, released, refused, failed, outcome unknown, parse failure), ids only, with a hold target for `release`; a failed publish doesn't change the exit code; certain no-commit errors after the upload (`no-recipients` at re-resolve, a lock timeout) delete at once and report `refused` |
| T23 | The page's rate limit: the IP limit is checked before any token lookup; the per-delivery limit after |
| T24 | `export-revoke` under the tenant lock warns when the lease is live |
| T25 | `openExportSnapshot(url, opts)`: the task's server-side timeouts are applied; the app's call is unchanged |
| T28 | The page under a later policy hold (deliveries made **through `deliver`**, not seeded): an admins-only delivery and an admins-plus-extra delivery are both unavailable on GET and POST (no presign); an `extra_only` delivery still works; still unavailable after `tenant:delete`; `unsuspend` or `set-policy-export on` (before deletion) makes it available again |
| T29 | The recipient rule: the shared fixture gives equal results for the task's copy and `notices.ts`'s; an admin deactivated mid-build is left out (fresh connection); a `cloudshell-` start with `--extra` refused |
| T19 | `schema-skew`: a workspace one migration ahead of the image's journal → refused before any read; the journal length comes from `drizzle/meta/_journal.json` at build |
| T20 | The 45-minute deadline aborts a stalled build before the upload completes (fake stalled stream) and deletes any partial object; a deadline during record leaves the object (T5) |
| T21 | `export-revoke`: refusals; the dry run; `--yes` sets `revoked_at`, audits and supersedes the pending notice |
| T22 | The bundle: `package.json` isn't a metafile input (the plugin); the image's `APP_VERSION` equals `package.json`'s version; `_journal.json` is copied and on the deploy list |

## 12. Founder steps (`PRODUCTION-DEPLOY.md`)
1. **13b:** before deploying `bootstrap.yml`, give the dev the Vercel team slug and project name (committed as constants). Deploy the updated bootstrap.
2. **13d (new):**
   - Vercel → team settings → OIDC: issuer mode **Team**;
   - set the Vercel production env `EXPORT_DOWNLOAD_ROLE_ARN` (stack output `ExportDownloadRoleArn`) and `EXPORT_BUCKET` (stack output `ExportBucket`), then deploy;
   - press Export workspace → `deliver`, target = the `rehearsal` workspace id, extra = your own address (typed in both address boxes), reason "setup test", confirm `deliver` → approve;
   - open the email in a private window → Prepare download → Download, and check the ZIP opens;
   - revoke the delivery (`tenant:admin export-revoke`).

## 13. Verification
- tsc, lint, unit tests, `test:tz`, `db:safety` and build.
- Integration alone, with the full CI environment.
- §3.7 verbatim runs (the new workflow block, the Dockerfile exact-COPY build) and cfn-lint.
- The early CI push (**CI only: the PR waits for READY**).
- The lead's checks file covers:
  - the button refusals;
  - the page states against a local control plane with fake S3 or presign;
  - `export-revoke`;
  - the retired commands gone.

## 14. Hand-off rules
`BLUEPRINT-STANDARD.md` §3, the §11 testing rules, and also:
- no real AWS, Neon or Stripe;
- never touch acme, globex or initech;
- stage files by name;
- never push;
- ask the lead before every integration run (the shared Postgres).

## 15. Pre-mortem log
- **v1.0 (2026-11-18):** draft. Q1–Q4 were answered before drafting, and A1–A3 are open for acceptance.
- **v1.1, round 1** (2 reviewers; 7 HIGH, about 17 MEDIUM, 29 LOW). All addressed:
  - **HIGH:**
    - the bucket policy denied the backup task's sweep, and the sweep's placement was unreliable → the sweep is its own hourly schedule under `ExportTaskRole`;
    - the anchor lookup lost microseconds → the delivery links to its notice by `notice_id`, and `scheduled_for` is millisecond-truncated;
    - stored recipients were ignored by `deliverNotice` → an `export-ready` branch that never reads the workspace database, with a stored time zone;
    - the extra address wasn't really verified → two matching inputs, with A4 put to the product owner;
    - the task role lacked the ECS reads for oldest-wins → added.
  - **MEDIUM:**
    - `PassRole` for the button;
    - the `CfnExecRole` alias;
    - multi-key audit, with the correct action names and key state;
    - the exact bundle file list;
    - `APP_VERSION` through esbuild `define` (the app unchanged);
    - the schema-skew check;
    - the run deadline and timeouts (lock never held during the build);
    - revoke supersedes the email, and `set-exempt` excludes it;
    - re-read on record;
    - `policyExportAllowed` in A1;
    - headers through `next.config`;
    - the Sentry scrub;
    - findings made testable (an app query, and holds on day 1).
  - **LOW:**
    - region hard-coded, and misconfiguration on any failure;
    - `apexBaseUrl()`;
    - the notice columns spelled out;
    - the token nulled after send;
    - token shape check and `SHARED_LIMITS`;
    - presign session note;
    - pins;
    - TENANT-DELETION :160, and A3 covering holds;
    - `fmtDateTime`;
    - lifecycle at 8 days;
    - no `audience` option, and Team issuer mode;
    - start emails for the family, and CloudTrail exposure noted;
    - leading `-` refused;
    - role names and paths;
    - the sweep erases revoked deliveries.
- **v1.2, round 2** (2 fresh reviewers; 3 HIGH, 15 MEDIUM, 13 LOW). All addressed:
  - **HIGH:**
    - the sweep in the export family would have emailed every hour and couldn't be started by the scheduler → its own small family, `cadenzpoint-backup-sweep`, with `SchedulerRole` RunTask and PassRole, and separate export-only email rules;
    - every export email showed all recipients to each other → `bcc`, with `to` = support.
  - **MEDIUM:**
    - the export branch runs before the generic supersede, and a missing delivery is superseded, never D10;
    - the token is redacted from the frozen payload on send;
    - revoke runs under the tenant lock and warns about an in-flight send;
    - the sweep is row-driven (lifecycle-deleted objects resolve);
    - findings live in ops-digest, not `syncBackupAlerts`;
    - a daily open-hold count;
    - the Sentry scrub covers all three inits and every string field;
    - `_journal.json` copied and on the deploy list;
    - an esbuild plugin for the `package.json` import (`define` can't);
    - server-side timeouts through an optional `openExportSnapshot` argument;
    - a deny-only `ExportKey` policy with role-side grants;
    - per-bucket lifecycle arrays and an exports-only encryption check;
    - the "3 failures" email dropped.
  - **LOW:**
    - `register-tenant` and `force-notice-sent` exclusions;
    - headers appended after the global entry;
    - the IP limit first, with camelCase names;
    - K excludes superseded, and `LEAST` for overdue;
    - recipients resolved after the build, and `db_url_encrypted` added to `changed`;
    - test-helper FK order (the dev deletes deliveries first);
    - the exact lock SQL, with the delete after rollback;
    - `--run-id` optional;
    - PassRole comment honesty;
    - `calendar-date.ts`;
    - export-worded rules;
    - team-slug constants asserted equal;
    - sweep cost.
- **v1.3, confirmation pass 1** (1 HIGH, 3 MEDIUM, 10 LOW; not clean). All addressed:
  - **HIGH:** `to = support@` would have put every live link, including policy-hold exports, into the support mailbox → one message per recipient via a Resend batch (one idempotency key), with the real recipient list recorded.
  - **MEDIUM:**
    - the sweep's execution role and log permission named (the export exec role, writing both groups); `FAMILIES` not extended, with explicit expected entries;
    - hold orphans raise `export-orphan-hold` and are never auto-deleted;
    - §10 corrected (no sweep in `backup.ts`; the full stack list).
  - **LOW:**
    - the `isNoticeSuperseded` backstop;
    - the `ExportKey` deletion-window and policy-change denies;
    - recipients kept as the proof of notice (accepted);
    - `export_holds` `release_reason` and `run_id`;
    - nulling and redaction on supersede too;
    - code references corrected;
    - the U6 plugin-namespace exemption;
    - the overdue wording;
    - the 50-recipient cap;
    - the deletion-during-export doc line made prominent.
- **v1.4, confirmation pass 2** (2 MEDIUM, 8 LOW; not clean). All addressed:
  - **MEDIUM:**
    - the batch's outcome rules are specified: strict validation; sent only with exactly N ids; the first id in the column and all ids in the payload; failures retried with the same key; the permissive reminder helper not reused;
    - the §6.2 and §6.7 contradiction about `FAMILIES` resolved (explicit `SchedulerRole` entries; `FAMILIES` unchanged).
  - **LOW:**
    - `hold` runs the schema check;
    - the sweep resolves `export-orphan-hold`, with a lead runbook;
    - §7.3 mirrors the redaction;
    - U6's schedule count (8) and the input shape;
    - the 50-recipient cap pre-checked, with the self-export fallback;
    - the sweep logs ids only;
    - `ReEncrypt*` in the key's deny;
    - `stated` never holds the link.
- **v1.5, confirmation pass 3** (1 MEDIUM, 8 LOW; not clean). All addressed:
  - **MEDIUM:** the recipient checks could refuse a legal hold → they're deliver-only; a hold needs only the status check, the schema check and the build.
  - **LOW:**
    - retry-by-name classification;
    - `.id` elements;
    - a refreeze-after-failure test;
    - the schema check before the recipient count;
    - `NOTICE_RECIPIENTS` honoured;
    - sweep wording;
    - every schedule's `DependsOn` grows;
    - the manifest version note.
- **v1.6, confirmation pass 4** (1 MEDIUM, 7 LOW; not clean). All addressed:
  - **MEDIUM:** a link sent to the admins kept working after a later policy hold → the page treats non-extra deliveries as unavailable while the hold lasts (no revoke; reversible). Folded into A1 for the product owner.
  - **LOW:**
    - recipients resolved on a fresh connection;
    - the line reference;
    - the `ExportDownloadRoleArn` output;
    - explicit role entries;
    - an extra address refused for hold and release;
    - `--extra` only from `gh-` starts;
    - a shared recipient-rule fixture.
- **v1.7, confirmation pass 5** (2 MEDIUM, 6 LOW; not clean). All addressed:
  - **MEDIUM:**
    - the hold exemption keyed on "had an extra" let admins-plus-extra links work → a stored `extra_only` flag; every other delivery is blocked;
    - deletion released the block → it's based on the reason and the flag whatever the status (the tombstone keeps them).
  - **LOW:**
    - the `ExportBucket` output;
    - the recipient function exported for the integration fixture;
    - `startedBy` documented as an honour system;
    - `--extra` on hold or release → exit 1;
    - the hold id in the SNS line;
    - F21 notes the pending email.
- **v1.8, confirmation pass 6** (2 MEDIUM, 6 LOW; not clean). All addressed:
  - **MEDIUM:**
    - `extra_only` was read but never written → step 4 computes it from the guarding re-read; NOT NULL, no default; T3 and T28 test it through `deliver`;
    - §7.1 lacked the hold-unavailable state → five rows added.
  - **LOW:**
    - A1 and F21 note that deletion makes the block permanent;
    - invariant 3 mentions the hold;
    - an SNS failure after commit → exit 0 (3c's rule); hold record failure → delete and exit 1;
    - outputs in T13;
    - the line reference;
    - the seed-tool note.
- **v1.9, confirmation pass 7** (1 MEDIUM, 6 LOW; not clean). All addressed:
  - **MEDIUM:** a lost COMMIT acknowledgement would delete a committed export's object (a dead link and a second email; a hold row without its copy) → ids pre-generated; after a record error (not the deliberate `changed` rollback), an exists-check on a fresh connection decides: committed, absent, or left for the sweep.
  - **LOW:**
    - tests for the SNS-exit-0, hold record failure and gone-object release;
    - the TENANT-DELETION line accepts "run passed";
    - the hold id in the `export-held` audit;
    - the missing §7.1 cells;
    - the branch reads the control-plane row;
    - the line reference.
- **v2.0, confirmation pass 8** (1 MEDIUM, 5 LOW; not clean). All addressed:
  - **MEDIUM:** the exists-check could race a still-running commit → **removed**. After the upload, the task never deletes on a record error: the object is left, the outcome is reported unknown by id, and the hourly sweep decides (deletes a delivery orphan after 1 day; reports a hold orphan). Only the deliberate `changed` rollback deletes at once. This simplifies rather than adds.
  - **LOW:**
    - the "outcome unknown" line names the id to check before pressing again;
    - the missing §7.1 cells;
    - record `lock_timeout`/`statement_timeout`;
    - the send attempt timeout;
    - the `limits.ts` comment.
- **v2.1, confirmation pass 9** (1 MEDIUM, 5 LOW; not clean). All addressed:
  - **MEDIUM:** "outcome unknown" and refusals reached only CloudWatch, and the digest has no ids → every run ends with one SNS line (ids and codes only) for every outcome, and the runbook checks with `tenant:admin show <slug>` for the id.
  - **LOW:**
    - a test that a row-less object under 1 day is kept;
    - a lookup error stops the orphan steps;
    - certain no-commit errors after the upload delete at once and report `refused`;
    - the §7.1 record-error row;
    - the D10 range made consistent.
- **FINAL v3.0, confirmation pass 10: CLEAN** (no HIGH or MEDIUM; 6 LOWs, all folded in):
  - the runbook covers leftover hold copies and killed runs;
  - certain no-commit is defined as "the server returned an error before COMMIT was sent", including the deadline before `BEGIN`;
  - `hold` uses the same lock and rule;
  - the `export failed` and parse-failure SNS lines, with a hold target for `release`;
  - the sweep's deadline and timeouts.
