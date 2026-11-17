# Database backups (build queue 3b)

> **Status:** **DRAFT v5.5**, 2026-11-16, lead architect. A redesign to the revised `BUSINESS-DECISIONS.md` §5 (2026-11-16). Rounds 1 and 2 and confirmation passes 1–3 are fixed here (§15). Confirmation pass 4 is next.
>
> **What changed from v4.1** (`78222b4`):
> - The jobs run **in the backup AWS account** (scheduled container tasks in us-east-1), not on GitHub's runners.
> - Encryption uses **AWS KMS**. There is no `age` and no key file.
> - Restore tests are **weekly and automatic**, into temporary databases in Neon us-east-1. Nothing runs on the founder's machine.
> - The founder-run tooling is removed: the local `db:restore`, the drill, `restore_copies` and the manual deletion of old objects.
> - The S3 rule stays at 25 days, but the alert moves to **29 days** and is a safety net only.
> - The live Privacy page's backup sentence changes to the business-approved wording.
>
> **Branch:** `database-backups`, from `main` at `c416049`. `main` hasn't moved since, so the §3 references were checked there.
>
> **Source:**
> - `BUSINESS-DECISIONS.md` §5, "Backups beyond Neon", revised 2026-11-16, and its founder constraints:
>   1. nothing manual;
>   2. no customer data on the founder's machines, ever;
>   3. it scales.
> - `BUSINESS-DECISIONS.md` §3 (A2): the new Privacy §3 text. §3 (B): the Terms §9.3 and Privacy §7 rewording (the business side applies those to the drafts).
> - `LAUNCH-TRACKER.md` build queue 3b; decisions log 2026-11-16.
> - LB-D6 (no `set-db-url`): unchanged here. The narrow disaster exception is item **3c**.
>
> **Out of this item, by plan:**
> - **3c**, the disaster button: rebuild a lost workspace or control plane into a new Neon database, check it, switch over.
> - **3d**, the export change: F2, `TENANT-DELETION.md`'s founder-download step, `scripts/tenant-export.ts`, `checkFounderExports`, and the customer export-by-link. 3d reuses the AWS platform this item builds.
>
> **Standard:** `BLUEPRINT-STANDARD.md`.

## 1. Goal and scope

Disaster-recovery backups that survive losing a Neon project or the whole Neon account, control plane included. Everything runs on its own, in AWS us-east-1 and Neon us-east-1.

1. **An AWS platform, written as code** (`ops/aws/`, CloudFormation):
   - a small **bootstrap stack** the founder creates once in the console: the GitHub sign-in link (OIDC), the deploy role and the image registry;
   - the **main stack**, deployed from GitHub Actions after the founder approves: the bucket, the KMS key, the container tasks and their roles, the schedules, the alert email, the key-deletion alarm, the audit trail and the budget.
2. **One container image with three commands**, run by EventBridge Scheduler as ECS Fargate tasks:
   - `backup`: daily at 06:17 UTC, plus an 18:17 catch-up. It backs up every workspace database and then the control plane.
   - `audit`: daily at 11:17 UTC. It records the oldest backup's age, the bucket settings, the KMS key's state and the alert email's state, and drops abandoned test databases.
   - `restore-test`: weekly, Mondays at 08:17 UTC, with a daily catch-up if Monday's didn't finish. It restores the control plane plus the workspaces due for a test into temporary databases, checks every row count, then drops them.
3. **Monitoring.**
   - The tasks write their results to control-plane tables, and the existing daily digest (Vercel, 13:00 UTC) reads them and raises alerts.
   - A KMS key deletion or disabling, or any change to the backup policies, lifecycle, versioning, audit trail or alerting, emails the founder **immediately**, straight from AWS. The daily audit also checks those protections are still in place.
   - Every role's "can't" limits are re-checked automatically on each run (§6.13).
4. **The Privacy page's backup sentence** changes to the approved §3 (A2) wording.

**Out of scope:**
- point-in-time recovery (Neon's 7-day history covers that);
- staging backups (Q2);
- cross-region copies;
- an archive plan;
- 3c and 3d (above).

## 2. Questions for the product owner, and founder duties

| # | Question | Recommendation | Section |
|---|---|---|---|
| Q1 | **Approving deploys of the backup system.** Whoever can deploy the main stack controls the backup account. That includes being able to grant itself the right to read backups. | **The deploy job needs your approval in GitHub**, as `production` already does. You get an email and click "Approve" once per deploy. Deploys happen only when backup code or AWS settings change, rarely after launch. The alternative is no approval, with only the `main` branch rule. That's weaker, because a compromised GitHub workflow step could then reach the backups. | §6.2 |
| Q2 | **Staging backups.** | **None.** The rehearsal points the production stack at staging for its first runs, then switches to production (§6.10, §12 steps 6–11). | §6.10 |
| Q4 | **The monthly manual restore drill in `RESTORE.md`** (`:70-77`): each month you branch a staging workspace in Neon, compare counts, and log it. It rehearses Neon's own 7-day point-in-time restore, not these backups. It's manual and recurring, which conflicts with constraint 1. | **Retire it.** The weekly automatic restore test now proves restorability every week. Neon's point-in-time restore stays documented in `RESTORE.md` for a mistake, done in Neon's console when needed. | §10.1 |
| Q3 | **The "25 hours" IP-hash promise.** Privacy §1 says the salted hash of a signup or sign-in IP address is kept "for up to 25 hours" (`privacy/page.tsx:25`). The app nulls `signups.ip_hash` after 24 h, but a control-plane backup taken before that keeps the value until the backup expires (up to 30 days). The new §3 sentence ("Backups expire automatically within 30 days…") may or may not be read as covering this. | **Ask the business session** whether §1 needs "(backups excepted, which expire within 30 days)" or similar. Engineering could instead leave `signups` **data** out of control-plane backups. But a disaster would then lose pending and waitlisted signups, with no way to contact them. Not recommended. Nothing in the build waits on this. | §6.11 |

**One-time founder actions this design needs.** These are flagged, not decided; `FOUNDER-ACCOUNTS-SETUP.md` gives each step in full. Everything else is created by code.
1. **AWS account** for backups only, using the advanced sign-up: root login with two hardware keys; the Paid plan; a backup card; an admin login for yourself (no access keys).
2. **GitHub:** create the `aws-backups` environment with yourself as required reviewer (Q1), and verify it with two `curl` commands, **before** the bootstrap stack exists. Then add five environment secrets and, last, one switch variable.
3. **Create the bootstrap stack once:** upload `ops/aws/bootstrap.yml` in the AWS console and click Submit.
4. **Create one Neon project once**, `cadenzpoint-restore-tests`: us-east-1, Postgres 16, history window 0.
5. **Paste three values into AWS Parameter Store:** staging's control-plane URL and `ENCRYPTION_KEY` (for the rehearsal), and the restore-test project's URL. After the rehearsal passes, replace the first two with production's. You redo this only if one of them ever changes.
6. **Approve the first deploy** in GitHub, and **confirm the AWS alert email** once.
7. **Run the three tasks once by hand and do the "can't" checks**, with the lead, in AWS's browser console and CloudShell (nothing on your Mac).
8. **Vercel:** set `BACKUPS_EXPECTED=1` in production.

**After setup, your only recurring actions:**
- approving a backup-system deploy when its code changes (Q1);
- reading the digest.

**One known exception, event-driven, not per customer or per day:** if production's `ENCRYPTION_KEY` or the control-plane database password ever changes, you update the matching AWS parameter as part of that change (the runbook says so). The next backup alerts if it's forgotten.

**Design choices stated for the record** (engineering's call within §5):
- **Restore tests use one dedicated Neon project**, not a new project per test. Creating projects would need a Neon API key in AWS that could also delete every customer's project. With one project, the test only ever holds that project's connection, and it can't touch production.
- **Missed-run alert after 26 hours, and an 18:17 catch-up run.** §5's 36-hour rule alone only fires after two missed days.
- **Restore-test coverage alert:** if any workspace goes 13 weeks without a passing test (§5's rule itself), the digest says so. The schedule targets 12 weeks, so normally this never fires.
- **Demo workspaces are backed up and tested** like any other.

## 3. Verified current state (`main` at `c416049`)

### 3.1 Databases
- **One Neon project per tenant**, created by `createNeonDatabase(slug)` (`src/lib/tenant/neon.ts:47-…`) with `pg_version: 16` and the region (`:63-74`).
- **Stored URLs use the pooled host.** `toDirectConnectionUrl` (`src/lib/tenant/migrate-tenant.ts:19`; `MIGRATION_LOCK_KEY = 728_402_113` at `:10`) gives the direct host.
- **Tenant URLs are encrypted** with AES-256-GCM (`src/lib/encryption.ts`):
  - in production, `ENCRYPTION_KEY` must be 64 hex characters (`:17-19`);
  - elsewhere, a non-hex key is silently derived (`:28-29`), so a wrong key isn't detected until decryption fails.
- **Statuses** (`src/db/control-plane/schema.ts:4-10`): `provisioning`, `active`, `suspended`, `deleting`, `deleted`. A crashed provisioning leaves `provisioning` with no URL (`provision.ts:44,68-74`).
- **No extensions:** no `CREATE EXTENSION` in `drizzle/` or `drizzle/control-plane/`. Tables, triggers and functions only, so `pg_restore --no-owner --no-acl` restores everything.
- **Production deploys already put `CONTROL_PLANE_DATABASE_URL` and `ENCRYPTION_KEY` on a GitHub runner** for migrations (`.github/workflows/deploy-prod.yml:30-37`, environment `production` with required reviewers, `PRODUCTION-DEPLOY.md:540-542`). Migrations change schema only; no customer data leaves Neon.

### 3.2 GitHub Actions
- `ci.yml`: push/PR on every branch; the integration job runs on `ubuntu-latest` with a `postgres:16-alpine` service and no client tools (`:55-105`).
- `deploy-prod.yml` / `deploy-staging.yml`: manual, environments `production` / `staging`.
- **The repo is public** (`api.github.com/repos/ccentofo/bytime` answers 200 without login, checked 2026-11-16). That matters because required reviewers on an environment are available on GitHub's free plans only for public repos (§4.6).

### 3.3 Monitoring and app
- **The daily cron** `src/app/api/cron/tenant-lifecycle/route.ts:22-27`: `runLifecycleCron`, then `runSignupMaintenance`, then `sendOpsDigest`. `runCron` records success after `work()` (`run-cron.ts:25-30`).
- **The digest** (`src/lib/tenant/ops-digest.ts`):
  - `checkFounderExports` (`:35-64`, called at `:79`): unchanged here (3d);
  - `hasNews` (`:108`), the all-quiet line (`:126`), `section()` and "Unresolved alerts" (`:138`).
- **Alerts:** `raiseAlert` scope is a tenant id or `'global'` (`lifecycle-store.ts:56-71`); `resolveAlertsOfKind` (`:95-105`).
- `BACKUP_RETENTION_DAYS = 30` (`lifecycle-config.ts:52`), used by the founder-export code only (3d).
- **The Privacy page** (`src/app/privacy/page.tsx:43-44`): "Deleted data may remain in backups for up to 30 days." It's pinned word for word by `src/__tests__/unit/legal-pages.test.tsx:28`.
- **Tests that call the digest or mock the route:**
  - `signup-ops.test.tsx:171-189` mocks every route import and asserts the order;
  - `ops-digest-alerts.test.ts` stubs the digest's queries;
  - `tenant-notices.test.ts:272` and `seat-sync.test.ts:308` call `sendOpsDigest`;
  - `lifecycle-helpers.ts:71-80` cleans `test-lc-*` tenants only.

### 3.4 Docs
- **`RESTORE.md`:** branch restore, the in-place exception, the monthly Neon branch drill (`:70-78`), "no command" (`:80-83`).
- **`TENANT-DELETION.md`:** the backup window (`:124-145`).
- **`PRODUCTION-DEPLOY.md`:** Phase 15 (`:913`), Operations (`:883-887`).

### 3.5 Tooling
- `tsx`, `esbuild` and `postgres` are installed. `js-yaml` is present only as a transitive dependency.
- No AWS SDK packages yet.

## 4. External behaviour (verified from source; fetched 2026-11-16)
"Silent" means the official docs don't say; the design doesn't rely on those points.

### 4.1 EventBridge Scheduler (ECS `RunTask` target)
1. **Retries cover only errors returned by the RunTask call.** `MaximumRetryAttempts` is 0–185 and `MaximumEventAgeInSeconds` 60–86400, with exponential backoff. The defaults when omitted are **not documented for Scheduler**, so the template sets both (…/scheduler/latest/APIReference/API_RetryPolicy.html).
2. **When retries are exhausted,** the invocation goes to an SQS dead-letter queue if one is configured. Metrics: `InvocationDroppedCount`, `InvocationsSentToDeadLetterCount` (…/configuring-schedule-dlq.html, …/monitoring-cloudwatch.html).
3. **Silent:** whether a RunTask HTTP 200 with a non-empty `failures` array (e.g. no capacity) counts as an error. A task that starts and then crashes is not retried. **So the design relies on the missed-run alert and the catch-up run, not on Scheduler retries** (F2).
4. **Execution role:**
   - trusted by `scheduler.amazonaws.com`;
   - `ecs:RunTask` on the task definition ARNs (a specific revision, or `family:*`);
   - `iam:PassRole` on each execution and task role, with `iam:PassedToService = ecs-tasks.amazonaws.com`;
   - `ecs:TagResource` with `ecs:CreateAction = RunTask` (…/AmazonECS/latest/developerguide/CWE_IAM_role.html).
5. **Time zones and the time window:**
   - Scheduler supports time zones, but a daylight-saving jump can skip or merge runs, so **the schedules use UTC**;
   - `FlexibleTimeWindow` is required: set `Mode: OFF` (…/schedule-types.html, …/managing-schedule-flexible-time-windows.html).

### 4.2 ECS Fargate
1. **Limits:**
   - ephemeral storage 20 GiB by default, up to 200 GiB, shared with the image;
   - up to 16 vCPU / 120 GB (32 vCPU on platform 1.4.0+) (…/fargate-task-storage.html, …/fargate-tasks-services.html).
2. **Network:** a public subnet with a route to an internet gateway, and `AssignPublicIp: ENABLED` (Fargate only), lets the task pull from ECR and reach the internet without a NAT gateway. Public IPv4 costs $0.005/hour, billed per second with a 60-second minimum (…/fargate-task-networking.html, aws.amazon.com/vpc/pricing).
3. **Runtime and stopping:**
   - there's **no documented maximum runtime**;
   - a stop sends SIGTERM, then SIGKILL after `stopTimeout` (default 30 s, maximum 120 s);
   - **AWS can retire a standalone task for maintenance and doesn't replace it** (…/API_StopTask.html, …/task_definition_parameters.html, …/task-maintenance.html).
4. **CloudFormation:**
   - `AWS::Scheduler::Schedule` `EcsParameters` takes `TaskDefinitionArn` (required), `LaunchType: FARGATE`, `NetworkConfiguration` and `PlatformVersion`;
   - `Ref` on `AWS::ECS::TaskDefinition` returns the ARN **with its revision**, so schedules pin a revision;
   - without a revision, RunTask uses the latest ACTIVE one (…/aws-properties-scheduler-schedule-ecsparameters.html, …/aws-resource-ecs-taskdefinition.html).

### 4.3 AWS Encryption SDK for JavaScript (`@aws-crypto/client-node`, 5.0.2) and S3
1. **The API:** `buildClient()` returns `encryptStream`, `decryptStream` and `decryptUnsignedMessageStream`.
2. **Defaults:**
   - commitment policy `REQUIRE_ENCRYPT_REQUIRE_DECRYPT`;
   - `maxEncryptedDataKeys` unlimited (set it to 1 here);
   - **the default suite is signed** (`…_COMMIT_KEY_ECDSA_P384`);
   - frame 4096 bytes (repo `aws/aws-encryption-sdk-javascript`: encrypt_client.ts, decrypt_client.ts, algorithm_suites.ts, identifiers.ts).
3. **Streaming decryption of a signed message releases plaintext before the signature is checked.** The guide says unsigned suites should use decrypt-unsigned. The Node example encrypts with `ALG_AES256_GCM_IV12_TAG16_HKDF_SHA512_COMMIT_KEY` and decrypts with `decryptUnsignedMessageStream`, which fails on signed ciphertext (…/encryption-sdk/latest/developer-guide/configure.html).
4. **KMS keyring permissions:**
   - encrypt needs `kms:GenerateDataKey` on the generator key; decrypt needs `kms:Decrypt`;
   - decryption should use a keyring **naming the key ARN** (strict, not discovery) (…/use-kms-keyring.html);
   - the SDK passes the encryption context to `GenerateDataKey`/`Decrypt` (source: kms-keyring helpers.ts), so `kms:EncryptionContext:purpose` conditions apply. That's confirmed from source, not the guide; **§12 step 9's successful backup and restore prove it in AWS**.
5. **S3 SSE-KMS isn't used for the encryption,** because SSE-KMS multipart uploads need `kms:Decrypt` on UploadPart (…/AmazonS3/latest/userguide/mpuoverview.html). That would break "the backup job can only encrypt". So encryption is client-side, and the bucket keeps SSE-S3 underneath.
6. **Lifecycle expiry:**
   - expiry = creation + N days, **rounded up to the next midnight UTC**;
   - in an unversioned bucket, S3 "queues the object for removal and removes it asynchronously, permanently";
   - billing stops when the rule is satisfied (…/intro-lifecycle-rules.html, …/lifecycle-expire-general-considerations.html, …/troubleshoot-lifecycle.html).
7. **Versioning:**
   - `s3:PutBucketVersioning` can be denied in the bucket policy;
   - **once enabled, versioning can never be turned off** (…/Versioning.html), which is why the Deny matters;
   - Object Lock needs versioning, so it isn't used;
   - **the root user can always delete a bucket policy**: stated honestly; root is MFA-locked and used only for recovery.
8. **Conditional writes:** as v4.1 §4.2.3. `If-None-Match: *` on PutObject and Complete returns 412/409; enforced with a Deny on `s3:PutObject` using `{"Null": {"s3:if-none-match": "true"}, "Bool": {"s3:ObjectCreationOperation": "true"}}`. lib-storage passes the header through and sends a single PUT only at the body's end.

### 4.4 AWS KMS
1. **Deletion window:** `PendingWindowInDays` is 7–30, default 30.
   - **`kms:ScheduleKeyDeletionPendingWindowInDays`** exists (numeric). Deny `kms:ScheduleKeyDeletion` with `NumericLessThan 30`.
   - Silent: whether the key is present when the window is omitted. Omitted means 30, so it's safe either way (…/API_ScheduleKeyDeletion.html, …/conditions-kms.html).
2. **CloudTrail logs every KMS operation,** including `GenerateDataKey` and `Decrypt` (logged as Read events). `ScheduleKeyDeletion` and `DisableKey` are Write events (…/logging-using-cloudtrail.html, …/logging-management-events-with-cloudtrail.html).
3. **KMS emits its own EventBridge events only** for rotation, imported-material expiry, and deletion *after* it completes. Scheduling and disabling must be matched as `AWS API Call via CloudTrail` (…/kms-events.html).
4. **Price:**
   - $1/month per key (none while scheduled for deletion);
   - 20,000 requests a month free, then about $0.03 per 10,000 (that rate is from the pricing examples) (aws.amazon.com/kms/pricing).

### 4.5 CloudTrail and EventBridge
1. **A trail with logging is required** to match `AWS API Call via CloudTrail` events. Write management events match rules in the default ENABLED state, and are delivered to the default bus only (…/eventbridge/latest/userguide/eb-service-event-cloudtrail.html).
2. **Cost:**
   - one copy of management events to S3 is free;
   - event history covers 90 days at no cost (aws.amazon.com/cloudtrail/pricing).
   - The trail logs **all** management events, read included, so every key use is kept beyond 90 days (§5 "every use of the key is logged"). The volume is tiny (two data keys per target per day).

### 4.6 GitHub Actions
1. **OIDC subject:**
   - with an environment, `sub = repo:OWNER/REPO:environment:NAME`;
   - **repositories created, renamed or transferred after 2026-07-15 use an immutable format**, `repo:OWNER@OWNER-ID/REPO@REPO-ID:…`. Older repos keep the old format unless they opt in (…/actions/reference/security/oidc).
   - `ccentofo/bytime` was created 2026-05-27, so it uses the name-based form. The trust policy is `StringEquals` on exactly `repo:ccentofo/bytime:environment:aws-backups` (§6.1). A repo re-created under that name after 2026-07-15 would get the immutable form and couldn't match.
2. **The AWS OIDC provider needs no thumbprint** for GitHub (a trusted CA). `ThumbprintList` is optional in CloudFormation (…/id_roles_providers_create_oidc_verify-thumbprint.html, …/aws-resource-iam-oidcprovider.html). Audience `sts.amazonaws.com`.
3. **Environments:**
   - "Running a workflow that references an environment that does not exist will create an environment … [without] protection rules";
   - **required reviewers on Free/Pro/Team plans work only in public repos**;
   - "Prevent self-review" is off unless selected;
   - admin bypass can be turned off (…/manage-environments, …/deployments-and-environments).
4. **`job_workflow_ref`:** v4.1 relied on a trust condition on it. **v5 doesn't.** IAM's support for that GitHub claim as a condition key isn't confirmed, and the environment's branch rule (`main`) plus the required reviewer already limit which runs can assume the role.

### 4.7 AWS other
1. **CloudFormation can't create SecureString SSM parameters,** so they're created in the console. Task definitions read them through `Secrets` → `ValueFrom` (the parameter ARN), which needs `ssm:GetParameters` on the execution role. The default `alias/aws/ssm` key decrypts for the account's roles.
2. **IAM Identity Center can't give access to a standalone account** (account instances don't support permission sets). **An IAM user with console access and a security key is the documented alternative** for that case. Root and IAM users can each register up to 8 MFA devices; root MFA is enforced (…/account-instances-identity-center.html, …/gs-identities-iam-users.html, …/id_credentials_mfa.html).
3. **The "Sign up for AWS (new)" flow creates no root user,** and its IAM users can't use the console. Use the **advanced** sign-up (…/accounts/latest/reference/sign-up-for-aws.html).
4. **The Free plan closes the account** after 6 months or when the credits run out, and offers only "select services". Use the **Paid** plan; credits still apply for 12 months (…/awsaccountbilling/latest/aboutv2/free-tier-plans.html).

### 4.8 Neon
1. **Databases:**
   - `CREATE DATABASE` and `DROP DATABASE` work over SQL;
   - the limit is 500 databases per branch;
   - the owner role (in `neon_superuser`) has CREATEDB (neon.com/docs/manage/databases, …/manage/roles);
   - **silent: `DROP DATABASE … WITH (FORCE)`.** The test closes its own sessions first, then runs a plain `DROP DATABASE`, then `WITH (FORCE)` only if one is still open. Proven at §12 step 9.
2. **History window:**
   - **0 is allowed** and disables instant restore and time travel for the project;
   - expired history is removed automatically, and history is billed at $0.20/GB-month;
   - with 0, dropped test databases aren't kept (Neon API spec, `history_retention_seconds` minimum 0; neon.com/docs/introduction/history-window).
3. **Hostnames:** `ep-<name>[-pooler][.c-<n>].<region>.aws.neon.tech`. Some AWS regions add a **cell label** such as `c-2` ("connection strings in some AWS regions may include a cell identifier (for example, `c-2`)", neon.com/docs/reference/glossary). One shared parser, `parseNeonHost(host)` in `scripts/backup/lib/neon-host.ts`, uses `^ep-[a-z0-9-]+?(?<pooler>-pooler)?(?:\.c-\d+)?\.(?<region>[a-z0-9-]+)\.aws\.neon\.tech$`. Both the restore-test guard and the `region` column use it (U5/U11 accept `…c-2.us-east-1…`; refuse `…us-east-2…`, `…c-2.us-east-2…` and `-pooler`).
4. **Plans:**
   - Launch allows 100 projects, Scale 1,000 (soft);
   - storage is unlimited on paid plans, while Free allows 1 GB per project;
   - **new projects default to Postgres 18**, so the restore-test project must be set to 16 by hand (neon.com/docs/introduction/plans; Neon changelog 2026-06-05).
5. **Backups are read-only** (as v4.1 §4.4):
   - pg_dump and pg_restore 16 match the 16 servers; pg_restore 17 emits `SET transaction_timeout`, which 16 rejects;
   - `--snapshot` with `pg_export_snapshot()`;
   - `--lock-wait-timeout`;
   - the unpooled host;
   - transfer is 500 GB per project per month on Launch/Scale.

## 5. Invariants that must not break
1. **Customer data exists only in Neon us-east-1 and AWS us-east-1.** No job runs on GitHub's runners or on any personal machine. GitHub only builds the image (no data, no secrets) and starts deploys. Stored fields, logs, alerts and emails carry **no customer values** (§6.4 "Error summaries").
2. **The backup task can add backups, never read or delete them.** It holds `kms:GenerateDataKey` but not `kms:Decrypt`/`kms:ReEncrypt*`, and `s3:PutObject` but not `s3:GetObject` or `s3:DeleteObject`. This is checked automatically every day (§6.13).
3. **Only the restore-test role (and 3c's disaster role) can read or decrypt backups through any normal path.**
   - The bucket and key policies deny everyone else a plain download, decrypt or re-encrypt, the founder's admin login included. So nothing lands anywhere by accident.
   - **Stated honestly:** an account administrator (the founder's admin login, or root) can always get access on purpose. For example, they could change a policy, run the restore-test task with a different command, or deploy a stack with the deploy roles. Those are deliberate acts with a hardware-key login, and CloudTrail records them.
   - **Changes to the protections themselves** email immediately, whoever makes them (§6.1 Alerting): the key, the bucket policy, the lifecycle rule, versioning, the audit trail, the backup roles' policies, and the alerting itself (rules, targets, subscription, alarm). The audit re-checks all of them daily (§6.6), so even a change that silences the email shows up in the next digest.
   - A task started by hand isn't alerted. CloudTrail records it.
4. **No long-lived access keys anywhere.** Tasks use roles; GitHub uses OIDC; the founder signs in with a hardware key.
5. **Versioning stays off.** The bucket policy denies `s3:PutBucketVersioning` to every principal. An attempt to change that policy alerts immediately.
6. **`ok` means every stage succeeded.** On failure the upload body is destroyed before it ends, so no partial object completes.
7. **Dumps are read-only.**
8. **`deleting` and `deleted` workspaces are never dumped**, with the status re-read per target.
9. **Restore tests write only to `rt_…` databases they create in the restore-test project**, and drop only names that match the pattern. They refuse a target URL that:
   - holds user tables;
   - shares the control plane's host;
   - uses a pooled host;
   - isn't in Neon us-east-1 on Postgres 16.
10. **No secret is logged.** Logs never contain URLs, hosts or passwords.
11. **Monitoring fails loudly.** A check that can't run is itself an alert.
12. **Tenancy:** a backup object is bound to its workspace by the encryption context (§6.5). A restore accepts it only for that workspace, checked before any plaintext reaches pg_restore.

## 6. Design

### 6.1 AWS layout (`ops/aws/`)
Two CloudFormation templates in YAML.
- **Long-form functions only** (`Fn::Sub:`, not `!Sub`), so the tests parse them with a plain YAML parser (U6).
- **One backup stack per account**, so physical names are fixed constants.
- **Role paths:**
  - roles the main stack creates live under the IAM path `/cadenzpoint-backup/`;
  - the bootstrap roles live under `/cadenzpoint-bootstrap/`, outside what a deploy can touch.
- **The account's audit trail lives in the bootstrap stack,** so a deploy can neither stop it nor be blocked by its logs on a rollback.

**`bootstrap.yml`**, stack `cadenzpoint-backup-bootstrap`, which the founder creates once in the console:

| Resource | Notes |
|---|---|
| `AWS::IAM::OIDCProvider` | `token.actions.githubusercontent.com`, audience `sts.amazonaws.com`, no thumbprint (§4.6.2). |
| `DeployRole` (fixed name `cadenzpoint-backup-deploy`, path `/cadenzpoint-bootstrap/`) | **Trust:** GitHub OIDC only, `StringEquals` `aud = sts.amazonaws.com` and `sub = repo:ccentofo/bytime:environment:aws-backups`. The repo was created 2026-05-27, before the immutable-subject change, so it uses the name-based form (§4.6.1). The residual risk is that someone re-registers the account name after a rename; the founder guide says never to rename or delete the account or repo without the lead (§3.2 there). The environment allows only `main` and needs the founder's approval. **Policy:** `ecr:GetAuthorizationToken` (`*`); push/describe images in the one repo; `s3:PutObject`/`GetObject` on the artifacts bucket; `cloudformation:ValidateTemplate` (`*`); create/update/describe/`ContinueUpdateRollback` on **exactly** `arn:aws:cloudformation:us-east-1:<acct>:stack/cadenzpoint-backup/*` and its change sets; `iam:PassRole` on `CfnExecRole` only. Max session 1 h. |
| `CfnExecRole` (fixed name `cadenzpoint-backup-cfn`, path `/cadenzpoint-bootstrap/`; the main stack's policies build its ARN from the same constants, U6) | **Trust:** `cloudformation.amazonaws.com` only. **Policy:** the main stack's resource types (S3 bucket and policy, KMS key and alias, EC2 VPC/subnets/IGW/routes/security group, ECS cluster and task definitions, Scheduler schedules, SQS, SNS, EventBridge rules, CloudWatch logs and alarm, Budgets); `kms:CreateKey`, `kms:PutKeyPolicy` (KMS's lockout check requires the creating principal to keep it; it's also the one principal the key policy's `PutKeyPolicy` deny exempts), `kms:ScheduleKeyDeletion` (create rollback); IAM create/update/delete/tag on roles **under `/cadenzpoint-backup/` only**; `iam:PassRole` on those roles (to `ecs-tasks.amazonaws.com` and `scheduler.amazonaws.com`); `iam:CreateServiceLinkedRole` with `iam:AWSServiceName = ecs.amazonaws.com` (a fresh account has no ECS service-linked role). It can't touch the bootstrap roles. **Honest scope:** a deploy can change which `/cadenzpoint-backup/` role reads backups. That's why deploys need the founder's approval (Q1). |
| `AWS::ECR::Repository` `cadenzpoint-backup` | Immutable tags; scan on push; a lifecycle rule that keeps the last 20 images. |
| Artifacts bucket (CloudFormation-generated name) | For `cloudformation deploy --s3-bucket` (templates over 51,200 bytes need one). Block Public Access; expiry 30 days. No customer data. |
| **CloudTrail** (here, so no deploy can touch it) | One multi-region trail of **all** management events, read and write (the first copy is free, §4.5). It's required for the alert rules, and keeps every key use beyond the 90-day event history. Its log bucket gets a CloudFormation-generated name (a failed or retried create can't collide), `DeletionPolicy: Retain`, expiry 365 days, and a bucket policy for `cloudtrail.amazonaws.com` with `aws:SourceArn` = the trail ARN. The trail `DependsOn` that policy. The logs hold no customer data. |
| Outputs | `DeployRoleArn`, `CfnExecRoleArn`, `RepositoryUri`, `ArtifactsBucket` |

**`backup-stack.yml`**, stack `cadenzpoint-backup`, deployed by the workflow (§6.2). Parameters: `ImageUri` (`…@sha256:<digest>`), `AlertEmail`, `MonthlyBudgetUsd` (default 10), `BackupConcurrency` (3), `BackupTargetDeadlineMinutes` (30), `RestoreTestConcurrency` (2), `RestoreTestTargetDeadlineMinutes` (120), `BackupTaskCpu`/`BackupTaskMemory` (2048/4096), `RestoreTestTaskCpu`/`RestoreTestTaskMemory` (2048/4096). Engineering changes them in the template's defaults; the next approved deploy applies them.

**Principal ARNs in policies** are built as strings with `Fn::Sub`, path included, for example `arn:aws:iam::${AWS::AccountId}:role/cadenzpoint-backup/cadenzpoint-backup-restore-test-task`. Role *grants* go in the roles' IAM policies; the key and bucket policies only *deny*, using `ArnNotEquals aws:PrincipalArn`. That avoids a CloudFormation dependency cycle (key ↔ role), and KMS's check that every principal named in a key policy exists. `aws:PrincipalArn` is the role ARN for an assumed-role session (§4).

| Resource | Notes |
|---|---|
| **KMS key** `BackupKey` | Symmetric; `PendingWindowInDays: 30`; `EnableKeyRotation: true` (adds $1/month at each of the first two yearly rotations); **`DeletionPolicy: RetainExceptOnCreate`**, `UpdateReplacePolicy: Retain`; alias `alias/cadenzpoint-backup`. **Key policy:** (a) account root administers the key (the standard statement; the key can never become unmanageable; IAM policies then grant the task roles); (b) **Deny `kms:Decrypt` and `kms:ReEncrypt*`** where `aws:PrincipalArn` isn't the restore-test task role (or 3c's role, added by 3c); (c) **Deny `kms:ScheduleKeyDeletion`** when `kms:ScheduleKeyDeletionPendingWindowInDays` is `NumericLessThan 30` (§4.4); (d) **Deny `kms:PutKeyPolicy`** where `aws:PrincipalArn` isn't `CfnExecRole`. |
| **Bucket** `BackupBucket` | Name `cadenzpoint-backups-<account id>`; us-east-1; Block Public Access (all four); Object Ownership BucketOwnerEnforced; default encryption SSE-S3 (the client-side KMS layer sits on top); **no `VersioningConfiguration`**; **`DeletionPolicy: RetainExceptOnCreate`**, `UpdateReplacePolicy: Retain`. **Lifecycle:** `Expiration.Days: 25` on prefix `v1/`; `AbortIncompleteMultipartUpload.DaysAfterInitiation: 1`. |
| **Bucket policy** | Deny all when `aws:SecureTransport = false`. Deny `s3:PutObject` without `If-None-Match` (§4.3.8). Deny `s3:PutBucketVersioning` and `s3:PutBucketObjectLockConfiguration` to all. Deny `s3:DeleteObject*` to all. Deny `s3:GetObject*` where `aws:PrincipalArn` isn't the restore-test role (or 3c's). Deny `s3:PutBucketPolicy`, `s3:DeleteBucketPolicy` and `s3:PutLifecycleConfiguration` where `aws:PrincipalArn` isn't `CfnExecRole`. (Root can still delete a bucket policy, §4.3.7; that alerts.) |
| **VPC** | One VPC; two public subnets in two AZs; an internet gateway; **no NAT gateway** (about $32/month); a security group allowing egress on 443 and 5432 only, and no ingress. Tasks get a public IP (§4.2). |
| **ECS cluster** `cadenzpoint-backup` | Fargate only; Container Insights off. |
| **Task definitions** | One per command family: `backup`, `audit`, `restore-test`. The same image with a different `Command`. `backup` and `restore-test`: 2 vCPU / 4 GiB; `audit`: 0.5 vCPU / 1 GiB. Linux/X86_64; ephemeral storage default (streaming, no temp files). `initProcessEnabled: true`. Log driver `awslogs` to its own log group (retention 30 days). `StopTimeout: 120`. |
| **Execution roles** (one per family) | ECR pull (`ecr:GetAuthorizationToken` on `*`; `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer` on the repo); write logs; `ssm:GetParameters` **only on the parameters that family needs**: `backup` → control-plane URL and encryption key; `restore-test` → control-plane URL and restore-test URL; `audit` → control-plane URL and restore-test URL. |
| **Task roles** (`/cadenzpoint-backup/`) | **Trust:** `ecs-tasks.amazonaws.com` with `aws:SourceAccount` = this account and `ArnLike aws:SourceArn arn:aws:ecs:us-east-1:<acct>:*`. **backup:** `s3:PutObject` on `BUCKET/v1/*`, `s3:AbortMultipartUpload`, `kms:GenerateDataKey` (key, with `kms:EncryptionContext:purpose = cadenzpoint-backup`). **restore-test:** `s3:GetObject` on `BUCKET/v1/*`, `s3:ListBucket` with `s3:prefix` `v1/*`, `kms:Decrypt` (key, with the condition). **audit:** `s3:ListBucket` with `s3:prefix` `v1/*`, `s3:ListBucketMultipartUploads`, `s3:GetBucketVersioning`, `s3:GetBucketPolicy`, `s3:GetLifecycleConfiguration`, `kms:DescribeKey`, `kms:GetKeyPolicy`, `events:DescribeRule` and `events:ListTargetsByRule` on the two rules, `sns:ListSubscriptionsByTopic` on the topic, `sns:GetSubscriptionAttributes`, `cloudtrail:GetTrailStatus` on the trail, `cloudwatch:DescribeAlarms` on the DLQ alarm. |
| **Schedules** (`AWS::Scheduler::Schedule`) | `backup-daily` `cron(17 6 * * ? *)`; `backup-catchup` `cron(17 18 * * ? *)`; `audit-daily` `cron(17 11 * * ? *)`; `restore-test-weekly` `cron(17 8 ? * MON *)`; `restore-test-catchup` `cron(17 8 ? * TUE-SUN *)`. `ScheduleExpressionTimezone: UTC`; `FlexibleTimeWindow: { Mode: OFF }`. Each targets ECS `RunTask` (Fargate, platform `LATEST`, the subnets, public IP enabled) with the task definition **pinned by revision ARN**. The two catch-ups use `Target.Input` `{"containerOverrides":[{"name":"<family>","command":["backup","--if-missing-today"]}]}` and `["restore-test","--if-missed"]`. `RetryPolicy`: `MaximumRetryAttempts: 10`, `MaximumEventAgeInSeconds: 3600`. `DeadLetterConfig` → SQS `cadenzpoint-backup-scheduler-dlq` (retention 2 days). One Scheduler execution role, trusted by `scheduler.amazonaws.com` with `aws:SourceAccount`: `ecs:RunTask` on the three task families' `family:*` ARNs (the schedules still pin revisions; this way an image-only deploy doesn't rewrite the role, and doesn't send a protections email); `iam:PassRole` on their execution and task roles with `iam:PassedToService = ecs-tasks.amazonaws.com`; `ecs:TagResource` with `ecs:CreateAction = RunTask`; `sqs:SendMessage` on the DLQ. |
| **SSM parameters** | **Not created by the stack** (CloudFormation can't create SecureString parameters, §4.7). Fixed names: `/cadenzpoint/backup/control-plane-url`, `/cadenzpoint/backup/encryption-key`, `/cadenzpoint/backup/restore-test-url`. The founder creates them once (§12). |
| **Alerting (immediate email)** | An SNS topic `cadenzpoint-backup-alerts` with an email subscription to `AlertEmail` (no filter policy). The topic policy lets `events.amazonaws.com` and `cloudwatch.amazonaws.com` publish, each with `aws:SourceAccount`. **Two EventBridge rules** on the default bus, matching CloudTrail write events (default `ENABLED` state) **from any caller**, with no caller condition (an exclusion can silently miss callers whose events lack the field). **`cadenzpoint-backup-protections`**, matched by `eventName` alone: KMS `ScheduleKeyDeletion`, `DisableKey`, `PutKeyPolicy`, `CreateGrant`; CloudTrail `StopLogging`, `DeleteTrail`, `UpdateTrail`, `PutEventSelectors`; S3 `PutBucketPolicy`, `DeleteBucketPolicy`, `PutBucketLifecycle`, `DeleteBucketLifecycle`, `PutBucketVersioning`; EventBridge `DisableRule`, `DeleteRule`, `PutRule`, `PutTargets`, `RemoveTargets`; SNS `Unsubscribe`, `Subscribe`, `DeleteTopic`, `SetTopicAttributes`, `SetSubscriptionAttributes`; CloudWatch `DeleteAlarms`, `DisableAlarmActions`. **`cadenzpoint-backup-roles`**, a separate rule so its extra condition can't stop the others matching: IAM `UpdateAssumeRolePolicy`, `PutRolePolicy`, `DeleteRolePolicy`, `AttachRolePolicy`, `DetachRolePolicy`, with `requestParameters.roleName` prefix `cadenzpoint-backup-` (every backup role's name starts with it; these events always carry the field). IAM events are delivered in us-east-1. An input transformer puts the event name, the caller's ARN and the time in each email. **A deploy that changes one of these also emails, which is expected.** The first deploy sends a few, dropped until the subscription is confirmed. **Plus** a CloudWatch alarm `cadenzpoint-backup-dlq` on the DLQ (`ApproximateNumberOfMessagesVisible > 0`, `TreatMissingData: notBreaching`) to the topic. |
| **Budget** | `AWS::Budgets::Budget`, monthly cost `MonthlyBudgetUsd`; alerts at 80% actual and 100% forecast, to `AlertEmail`. |

### 6.2 Image and deploy (`Dockerfile.backup`, `.github/workflows/backup-deploy.yml`)
**Image (multi-stage):**
- **builder stage** `node:22-bookworm-slim` (by digest):
  - copy `package.json`, `package-lock.json`, `scripts/backup/`, and the `src/` files the bundle imports;
  - `npm ci --ignore-scripts`;
  - `npm run backup:bundle`, the same command CI hashes: esbuild `scripts/backup/main.ts` → `backup.cjs` with `--platform=node --bundle --format=cjs --conditions=react-server`, excluding `pg-native`.
  - **No npm code runs on the GitHub runner.**
- **runtime stage** `node:22-bookworm-slim` (by digest):
  - `postgresql-client-16` from PGDG (`/usr/lib/postgresql/16/bin/`) and `ca-certificates`;
  - `/app/backup.cjs` only; no repo, no `node_modules`, no `.env`;
  - a non-root user; entrypoint `node /app/backup.cjs`.
- **`backup.cjs --self-check`** loads every module, checks `pg_dump --version` and `pg_restore --version` (16.x, using `/usr/lib/postgresql/16/bin/` when the `*_BIN` variables are unset), and exits 0. It needs no environment. Run in CI (§13) and as the image's build-time smoke test.

**Workflow** (two jobs; only the second can reach AWS):
```yaml
name: Backup system deploy
on:
  push:
    branches: [main]
    paths: ['ops/aws/backup-stack.yml', 'scripts/backup/**', 'src/lib/encryption.ts', 'src/lib/tenant/direct-url.ts',
            'src/lib/tenant/backup-locks.ts', 'Dockerfile.backup', '.github/workflows/backup-deploy.yml']
  workflow_dispatch: {}
permissions: { contents: read }
concurrency: { group: backup-deploy, cancel-in-progress: false }
jobs:
  build:                                # no id-token, no environment, no secrets
    if: github.ref == 'refs/heads/main' && vars.AWS_BACKUPS_ENABLED == 'true'
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@<sha>
        with: { persist-credentials: false }
      - run: docker build -f Dockerfile.backup -t backup:${{ github.sha }} . && docker save backup:${{ github.sha }} -o image.tar
      - run: docker run --rm backup:${{ github.sha }} --self-check
      - uses: actions/upload-artifact@<sha>
        with: { name: image, path: image.tar, retention-days: 7 }   # an approval can come days later; past 7, "Re-run all jobs"
  deploy:
    needs: build
    if: github.ref == 'refs/heads/main' && vars.AWS_BACKUPS_ENABLED == 'true'
    runs-on: ubuntu-24.04
    environment: aws-backups            # Selected branches: main; required reviewer: the founder (Q1)
    timeout-minutes: 30
    permissions: { contents: read, id-token: write }
    steps:
      - uses: actions/checkout@<sha>
        with: { persist-credentials: false }
      - uses: actions/download-artifact@<sha>
        with: { name: image }
      - uses: aws-actions/configure-aws-credentials@<sha>
        with: { role-to-assume: '${{ secrets.AWS_DEPLOY_ROLE_ARN }}', aws-region: us-east-1, role-duration-seconds: 3600, mask-aws-account-id: true }
      - uses: aws-actions/amazon-ecr-login@<sha>
      - run: scripts/backup/deploy.sh   # no npm, no node; bash + docker + aws cli only
        env:
          REPOSITORY_URI: ${{ secrets.AWS_BACKUP_REPOSITORY_URI }}   # environment secrets: masked in the public logs
          ARTIFACTS_BUCKET: ${{ secrets.AWS_ARTIFACTS_BUCKET }}
          ALERT_EMAIL: ${{ secrets.BACKUP_ALERT_EMAIL }}
          CFN_EXEC_ROLE_ARN: ${{ secrets.AWS_CFN_EXEC_ROLE_ARN }}
```
**When a deploy is requested: only when the backup code or the stack changes.**
- **The filter lists the backup code's own files:** `scripts/backup/**` (the backup-wait helper lives there too, as `scripts/backup/lib/backup-wait.ts`), the three `src/` modules it imports (`src/lib/encryption.ts`, `src/lib/tenant/direct-url.ts`, `src/lib/tenant/backup-locks.ts`), the main template, the Dockerfile and the workflow.
- **U6 keeps the list complete:** it builds the bundle with esbuild's `--metafile` and fails if any input outside `node_modules` isn't matched by a filter entry. A new import can't slip past.
- **App-only changes, `package.json`/lockfile bumps and other migrations trigger nothing,** so approval requests stay rare (Q1). Stated plainly: a dependency update reaches the image with the next backup-code change, not on its own.
- **The backup code queries its tables with explicit column lists in plain SQL** (`scripts/backup/lib/`), so a migration on other columns can't break the image.
- **A migration that changes the backup tables** comes with a backup-code change (the SQL), so a deploy is requested. Runbook: **approve it only after `deploy-prod` has applied the migration**. The tasks' start check refuses to run against missing tables either way.
- **`ops/aws/bootstrap.yml` isn't in the filter.** A bootstrap change is rare, and the founder applies it in the console (CloudFormation → the bootstrap stack → Update → upload), with the lead's instructions.
- **The builder stage copies exactly those inputs** (plus `package.json`, `package-lock.json` and a dedicated `tsconfig.backup.json` passed to esbuild with `--tsconfig`), so the build doesn't depend on files that happen to be present.

**Public logs.** The repo is public, and GitHub prints each step's inputs. So the account-identifying values (the role ARNs, the repository URI, the artifacts bucket and the alert email) are **`aws-backups` environment secrets**, which GitHub masks. Environment secrets are available on free plans for public repos. The only repository **variable** is `AWS_BACKUPS_ENABLED`, a non-sensitive switch the job `if` reads.

**`deploy.sh`** (`set -euo pipefail`; prints no account ids, ARNs or the email; `::add-mask::` for the email):
1. **Stack state** (`describe-stacks`; a "does not exist" error is caught and means a new stack; nothing else is swallowed under `set -e`):
   - none, or `REVIEW_IN_PROGRESS` (a failed first change set, no resources): proceed; `cloudformation deploy` treats it as new;
   - `ROLLBACK_COMPLETE` (a failed first create): stop with "The first create failed and rolled back. In the AWS console, delete the stack `cadenzpoint-backup` (it holds nothing), then re-run this workflow." `RetainExceptOnCreate` leaves no orphan bucket or key, and the trail isn't in this stack;
   - `UPDATE_ROLLBACK_FAILED`: run `aws cloudformation continue-update-rollback`, then stop with "rolled back; check the run log";
   - `ROLLBACK_FAILED`, `DELETE_FAILED`: stop with the matching `PRODUCTION-DEPLOY.md` runbook line;
   - any other `*_IN_PROGRESS`: stop with "another operation is running".
2. **Image:** `docker load -i image.tar`. If `aws ecr describe-images --image-ids imageTag=$GITHUB_SHA` finds the tag, reuse its digest (a re-run); `ImageNotFoundException` is caught and means push. Otherwise tag, push, and read the digest.
3. **Template check:** `aws cloudformation validate-template --template-url` after uploading to the artifacts bucket.
4. **Deploy:** `aws cloudformation deploy --stack-name cadenzpoint-backup --template-file ops/aws/backup-stack.yml --s3-bucket "$ARTIFACTS_BUCKET" --role-arn "$CFN_EXEC_ROLE_ARN" --parameter-overrides ImageUri=<uri>@<digest> AlertEmail="$ALERT_EMAIL" --capabilities CAPABILITY_NAMED_IAM --no-fail-on-empty-changeset`.
5. **Report:** print "deployed <short sha>" and the stack status only.

Further rules:
- **The job-level `if` on `vars.AWS_BACKUPS_ENABLED == 'true'`** means nothing runs, and no approval is requested, until the founder sets it as the last setup step before the first deploy (§12).
- **Environment `aws-backups` must exist and be gated before the bootstrap stack exists** (§12 step 3), and that's verified (§12). Otherwise GitHub creates it unprotected on first use (§4.6.3). The real gate is the environment's branch rule plus the required reviewer.
- **The image runs only in AWS.** The build compiles code; it never connects to a database and holds no secrets.
- Actions are pinned by SHA. `@aws-sdk/*` and `@aws-crypto/*` are imported only under `scripts/backup/` (U6).
- **Deploy order:** the backup tasks check at start that their tables exist (a missing table is fatal: "run deploy-prod first"). §12 approves the backup deploy only after `deploy-prod` has applied the migration.

### 6.3 Control-plane tables (one drizzle-kit migration `00NN_database_backups.sql`)
Five tables. Append-only except where noted. Tests mark rows with a `run_id` starting `test-`. Every table has a `run_id` varchar(80) for that marker.

**`database_backups`:**

| column | type / note |
|---|---|
| `id` | uuid PK |
| `tenant_id` | uuid null FK → `tenants.id` ON DELETE CASCADE (null = control plane) |
| `target` | `'tenant'` \| `'control-plane'` |
| `run_id` | varchar(80) |
| `status` | `'ok'` \| `'failed'` |
| `s3_key` | text null, **unique** where not null |
| `bytes` | bigint null |
| `sha256` | char(64) null (of the stored, encrypted object) |
| `row_counts` | jsonb null: `{ "<schema>.<table>": <number> }`. Counts are stored as JSON numbers; postgres.js returns `count(*)` as a string, so it's converted. Comparisons ignore key order. |
| `server_version`, `pg_dump_version` | varchar null |
| `region` | varchar(40) null (from the direct host, e.g. `us-east-1`; `unknown` if the host doesn't match Neon's pattern) |
| `target_deadline_ms` | int (the per-target deadline this run used) |
| `error` | text null (an **error summary**, §6.4) |
| `started_at`, `finished_at` | timestamptz |

Index `(tenant_id, status, finished_at DESC)`; index `(run_id)`.

**`backup_audits`** (one row per audit run):

| column | type / note |
|---|---|
| `id` | uuid PK |
| `run_id` | varchar(80) |
| `run_at` | timestamptz |
| `oldest_object_at`, `oldest_key` | null when the bucket is empty |
| `objects_over_29_days`, `total_objects` | int |
| `total_bytes` | bigint |
| `versioning_status` | varchar(20) (`''` = never enabled; anything else alerts) |
| `stale_uploads` | int (multipart uploads older than 4 days; the 1-day abort rule is asynchronous too) |
| `kms_key_state` | varchar(40) (`Enabled`, `Disabled`, `PendingDeletion`, …, or `error`) |
| `alert_email_confirmed` | boolean null (the topic has a confirmed email subscription; null = check failed) |
| `protection_drift` | text null (null = all present; otherwise the missing `Sid`s, rule or lifecycle) |
| `leftover_test_dbs` | int null (abandoned `rt_…` databases found and dropped; null = sweep skipped because a restore test was running) |
| `errors` | text null (error summaries of any check that couldn't run) |

**`restore_test_runs`** (**not** append-only: `finished_at`, `status` and `detail` are set once):

| column | type / note |
|---|---|
| `id` | uuid PK |
| `run_id` | varchar(80) |
| `started_at` | timestamptz |
| `finished_at` | timestamptz null |
| `status` | `'running'` \| `'pass'` \| `'fail'` |
| `planned` | int |
| `swept_test_dbs` | int (abandoned `rt_…` databases this run dropped at start) |
| `deadline_ms` | int |
| `target_deadline_ms` | int (the per-target deadline this run used) |
| `detail` | text null (slugs and stages only; `abandoned` for a run closed by the next one) |

**`restore_test_results`** (one row per target tested):

| column | type / note |
|---|---|
| `id` | uuid PK |
| `test_run_id` | uuid FK → `restore_test_runs.id` ON DELETE CASCADE |
| `run_id` | varchar(80) (the marker) |
| `target` | `'tenant'` \| `'control-plane'` |
| `tenant_id` | uuid null FK → `tenants.id` ON DELETE CASCADE |
| `backup_id` | uuid null FK → `database_backups.id` ON DELETE SET NULL |
| `s3_key` | text null |
| `backup_started_at` | timestamptz null |
| `result` | `PASS` \| `MISMATCH` \| `FAIL:<stage>` |
| `detail` | text null. For MISMATCH: table names with both counts; otherwise an error summary. |
| `duration_ms` | int |
| `tested_at` | timestamptz |

Index `(tenant_id, result, tested_at DESC)`.

**`backup_permission_checks`** (one row per probe set; §6.13):

| column | type / note |
|---|---|
| `id` | uuid PK |
| `run_id` | varchar(80) |
| `role` | `'backup'` \| `'audit'` \| `'restore-test'` |
| `checked_at` | timestamptz |
| `ok` | boolean (every probe was refused, or skipped, as expected) |
| `detail` | jsonb: probe → `denied` \| `skipped` \| `ALLOWED` \| `error:<code>`. Backup rows also hold `edk` and `edk_context`. |

### 6.4 The backup command (`scripts/backup/backup.ts`; helpers in `scripts/backup/lib/`)
**The core is v4.1 §6.2**, which passed four review rounds:
- the barrier (all tenants, one retry round, then the control plane by T + 75 min at the latest, outside the tenant pool);
- the exported snapshot with exact row counts;
- the per-target 30-minute deadline, with TCP keepalives on child URLs;
- the end gate;
- conditional writes with random key suffixes;
- the `BACKUP` line, then the row;
- `--if-missing-today`, `--only`, `--dry-run`, `--concurrency`.

Only the differences are listed here.

**Environment** (from the task definition; each fatal if missing or empty):
- `CONTROL_PLANE_DATABASE_URL` and `ENCRYPTION_KEY`, from SSM. The key must be 64 hex characters.
- `BACKUP_BUCKET`, `BACKUP_KMS_KEY_ARN`, `AWS_REGION` (= `us-east-1`).
- `BACKUP_PG_DUMP_BIN` (`/usr/lib/postgresql/16/bin/pg_dump`; `--version` must start with `pg_dump (PostgreSQL) 16.`).
- `BACKUP_CONCURRENCY` (default 3); `BACKUP_TARGET_DEADLINE_MINUTES` (default 30).

No dotenv is loaded in the container. **Outside ECS** (no `ECS_CONTAINER_METADATA_URI_V4`), the commands refuse everything except `backup --dry-run` and `--self-check` (which loads modules and checks tool versions, nothing else), so a production `.env` on a laptop can never start a dump (constraint 2). Tests call the cores in-process through the seams.

**Start checks:**
- the five tables exist (else fatal: "backup tables missing: run deploy-prod first");
- the key ARN and bucket are set.

**Run id:** `ecs-<YYYYMMDDTHHMMSSZ>-<rand6>`.

**Each row records** the target's `region` (parsed from its direct host by `parseNeonHost`, §4.8) and the run's `target_deadline_ms`, for the §6.9 region and slow-target findings.

**One run at a time:**
- At start, take `pg_try_advisory_lock(BACKUP_LOCK_KEY)` on a dedicated **direct** control-plane connection (`toDirectConnectionUrl`; pooled connections can't hold session locks), held for the whole run.
- If it isn't granted, log "another backup run is active" and exit 0. The catch-up then can't overlap a slow morning run.
- If that connection drops, the run reconnects and re-takes the lock. If it can't, it **starts no new targets** (those in flight finish) and records the rest `failed` (`lock-lost`). Otherwise `migrate-all` could miss the running dump.
- **All three lock connections** use `toDirectConnectionUrl` (U5). A session lock on the pooled host can be taken and released on different server connections.
- **The lock keys** are `BACKUP_LOCK_KEY = 728_402_201`, `AUDIT_LOCK_KEY = 728_402_202`, `RESTORE_TEST_LOCK_KEY = 728_402_203` and `MIGRATE_RUN_LOCK_KEY = 728_402_204`. They're distinct from `MIGRATION_LOCK_KEY = 728_402_113` (`src/lib/tenant/migrate-tenant.ts:10`) and defined once in `scripts/backup/lib/locks.ts` (U5 asserts they're distinct).

**Run deadline:** 6 hours. Then everything still running is killed and recorded `failed` (`run-deadline`), and the process exits 1. ECS has no runtime limit of its own (§4.2).

**Migrations and backups never overlap (`scripts/migrate-all.ts`, `scripts/backup/lib/backup-wait.ts`).**
- **Why:** a migration's `ALTER TABLE` queues behind pg_dump's ACCESS SHARE locks, and every app query on that table then queues behind the `ALTER`. On the control plane, that's every request. Migrations set no `lock_timeout`.
- **Two locks, and each side takes its own and then checks the other's.** Neither ever blocks waiting for the other's lock (the checks are reads of `pg_locks`, and the waits are polling loops), so there's no deadlock, and they can't both miss each other. Both live on the control plane's **direct** host.
  - `MIGRATE_RUN_LOCK_KEY = 728_402_204`: `migrate-all` holds it for its whole run (not in `--check`).
  - `BACKUP_LOCK_KEY`: the backup run holds it.
- **`migrate-all`:**
  1. Take `MIGRATE_RUN_LOCK_KEY` (waiting if another migrate-all holds it).
  2. Check whether `BACKUP_LOCK_KEY` is held **through `pg_locks`** (`locktype = 'advisory'`, `database` = the current database's oid, the key's `classid`/`objid`, `objsubid = 1`, `granted`), not by taking it, so a backup starting in that instant isn't turned away.
  3. If a backup is running, release `MIGRATE_RUN_LOCK_KEY`, print "Waiting for the backup run to finish…", and retry every 60 s for up to 30 minutes. Then exit 1 with "A backup run is still active. Re-run deploy-prod later; nothing was changed."
  4. Otherwise migrate, then release.
- **The backup run,** after taking `BACKUP_LOCK_KEY` and before its first dump, waits while `MIGRATE_RUN_LOCK_KEY` is held (checked through `pg_locks`, every 60 s, up to 60 minutes). After that it proceeds, and logs and records the wait. A migration still running after an hour is far outside normal; `--lock-wait-timeout` then protects the dump side.
- **The helper** `waitForLock(sql, key, { sleep, now, maxMs })` and `isAdvisoryLockHeld(sql, key)` live in `scripts/backup/lib/backup-wait.ts`, with seams for tests (S21). The lock constants live in `src/lib/tenant/backup-locks.ts`, imported by both sides.
- This replaces the clock-based "no deploys at 06:00–08:30" rule, which didn't grow with run length. **No deploy windows remain.**

**Encryption (replaces `age`):** per §6.5. `pgDump.stdout` → `encryptStream` → the hashing `PassThrough` (SHA-256 and bytes; `{ end: false }`) → upload. The gate is unchanged: the hashing stream ends only after pg_dump closes with `(0, null)` **and** the encrypt stream has emitted `end` without error. Any failure: kill pg_dump, destroy the encrypt stream, `hashing.destroy(err)`, `upload.abort()`.

**Keys:**
- `v1/<cp>/<target>/<id>/<YYYY>/<MM>/<DD>/<runId>-<rand8>.dump.enc`, where `<cp>` is the first 12 hex characters of SHA-256 of the control plane's direct host, and `<id>` is the tenant uuid or `control-plane`. `<cp>` keeps the staging rehearsal's objects apart from production's with no setting to get wrong. 3c computes it from the production URL, or reads it from the `BACKUP` lines;
- the sidecar is the same key with `.manifest.json.enc`;
- the sidecar JSON is as in v4.1, plus `slug`, encrypted with its own context (`kind: 'manifest'`).

**The `BACKUP` line goes to the task log** (CloudWatch, kept 30 days): `BACKUP <cp> <target> <id> <slug> <runId> <key> <sha256> <bytes>`. 3c's disaster path can read it when the control plane is gone.

**Error summaries (no customer values anywhere).** Postgres messages can quote row values: `CONTEXT: COPY …, line N: "…"`, `DETAIL: Key (…)=(…)`, `Failing row contains (…)`, `invalid input syntax …: "…"`. So **no raw stderr or error message is stored, logged or alerted.** `summarizeError(stage, err, stderr)` keeps only:
- the stage;
- the child's exit code and signal;
- the SQLSTATE, **only from a structured field** (postgres.js `err.code`), never parsed from text: a 5-character token inside a quoted value could be a customer's value. pg_dump and pg_restore print no SQLSTATE at default verbosity, so none is taken from their stderr;
- the table name when the message has the form `COPY <name>` (an identifier from the schema, not data);
- a **label from a fixed list** when the message matches a known value-free pattern: `connection-refused`, `timeout`, `auth-failed`, `server-version`, `lock-timeout`, `access-denied`, `kms-error`, `s3-error`, `disk`, `killed`. Otherwise the label is `other`. **The message line itself is never stored**, because even "safe" lines carry hosts and user names.

A top-level `uncaughtException`/`unhandledRejection` handler logs only `summarizeError` and exits 1. Node's default crash print would include a PostgresError's `detail`.

That summary is what goes into `database_backups.error`, `restore_test_results.detail`, `backup_audits.errors`, the task log and alert details. Child processes get only `{ PATH, HOME, LANG, PGPASSWORD }`; logs never contain URLs, hosts or passwords.

**Exit code:** 1 if any target is still failed. ECS records it; monitoring reads the rows.

### 6.5 Encryption format
- **The AWS Encryption SDK for JavaScript** (`@aws-crypto/client-node` 5.x), with a **KMS keyring** naming `BACKUP_KMS_KEY_ARN` only.
- **Algorithm suite:** the committing, **unsigned** suite `ALG_AES256_GCM_IV12_TAG16_HKDF_SHA512_COMMIT_KEY`. The commitment policy is `REQUIRE_ENCRYPT_REQUIRE_DECRYPT`. Unsigned, so decryption streams through `decryptUnsignedMessageStream`, which refuses signed messages (§4.3).
- **Frame length:** 64 KiB. `buildClient({ commitmentPolicy: REQUIRE_ENCRYPT_REQUIRE_DECRYPT, maxEncryptedDataKeys: 1 })`.
- **Decryption uses a strict KMS keyring** naming the key ARN, never a discovery keyring. **The key is never replaced:** U6 fails if `BackupKey` sets a property whose change forces replacement beyond the reviewed set, and the runbook says a key change means a new key *added* while the old one is kept for 25 days. The restore test's keyring takes `BACKUP_DECRYPT_KEY_ARNS` (comma-separated, default the current key) for that case.
- **Encryption context** (authenticated, and sent to KMS):
  - `purpose: cadenzpoint-backup`, which the task roles' IAM conditions require;
  - `cp`: the control-plane id above;
  - `kind`: `dump` or `manifest`;
  - `target`: `tenant` or `control-plane`;
  - `id`: the tenant uuid or `control-plane`;
  - `key`: the S3 key without its suffix.
- **The header check gates the restore.** The SDK has no "required context" option on decrypt, so the check is ours, and it happens **before pg_restore is started**:
  - the decrypt stream's `MessageHeader` event fires before any plaintext;
  - its handler compares the context to the expected value (exact key set and values) **synchronously**;
  - on a mismatch, it destroys the stream (`FAIL:context`);
  - on a match, it only then spawns pg_restore and pipes the plaintext into it.

  KMS `Decrypt` of the data key happens before the header check; that's logged and harmless.
- **Integrity of the stored object:** SHA-256 of the ciphertext, kept in the row and in the `BACKUP` line.
- **Honest limit, as with `age`:** anyone with the backup role can create a validly encrypted object. The restore test therefore also requires the object's SHA-256 to match the control-plane row.

### 6.6 The audit command (`audit`, daily 11:17 UTC)
1. Take `AUDIT_LOCK_KEY`; exit 0 if it's held. Run the start checks.
2. List `v1/` (paginated). Record `oldest_object_at`, `oldest_key`, `objects_over_29_days` (by `LastModified`) and the totals.
3. `GetBucketVersioning` → `versioning_status`. `ListMultipartUploads` → `stale_uploads` (older than 4 days).
4. `DescribeKey` → `kms_key_state`.
5. `ListSubscriptionsByTopic` → `alert_email_confirmed`: true if an `email` subscription exists whose ARN isn't `PendingConfirmation`.
5b. **Protection drift:**
   - `GetBucketPolicy` must exist, and its statements, **normalised** (sorted keys and arrays), must equal the expected statements rendered with this account's id and ARNs;
   - `GetLifecycleConfiguration` must hold the 25-day rule;
   - `GetKeyPolicy` must equal its expected statements, normalised the same way;
   - both rules: `DescribeRule` must be `ENABLED` with the expected `EventPattern`, and `ListTargetsByRule` must show exactly the alert topic;
   - the trail: `GetTrailStatus.IsLogging` must be true;
   - the email subscription must have no `FilterPolicy` (`GetSubscriptionAttributes`);
   - the DLQ alarm must exist with actions enabled (`DescribeAlarms`).

   **The expected documents have one source:** `scripts/backup/lib/expected-policies.ts` renders them from the account id and the fixed names. U6 checks they equal the template's statements, with `Fn::Sub` substituted. Normalisation sorts keys and arrays, turns a one-item array into its scalar, and stringifies booleans and numbers. **Any** difference (missing, extra or changed) goes into `protection_drift` as the `Sid`s that differ. This catches a policy silently replaced, removed or widened by any path, including a future template change.
6. **Leftover test databases**, only if `pg_try_advisory_lock(RESTORE_TEST_LOCK_KEY)` is granted (so no restore test is running). The lock is held for the whole sweep, then released. If it isn't granted, `leftover_test_dbs = null` (skipped).
   - Connect to the restore-test URL (the §6.7 guards).
   - Drop every database matching `^rt_[0-9]{14}_[a-z0-9]{8}$` (the name carries its UTC creation time to the second) that is **older than 1 hour** and has **no session in `pg_stat_activity`**.
   - Count them. A dropped leftover still alerts once, so a crashing test can't hide.
7. **Permission probes** (§6.13).
8. **Each check is isolated.** One that fails writes `error` into its column (or null) and its summary into `errors`, and the row is still inserted.

### 6.7 The restore-test command (`restore-test`, weekly, Mondays 08:17 UTC)
**Catch-up:** `restore-test --if-missed` (Tuesday to Sunday, 08:17 UTC) exits 0 at once if a run that **completed** has started since the latest Monday 00:00 UTC. **Completed** means: `planned` is set, and either `status = pass`, or `status = fail` with a result row for every planned target and none of them `FAIL:stopped` or `FAIL:not-reached`. Guard-failure, lock-held and abandoned rows are never completed. A completed failure is already alerted. Otherwise it runs normally. So a lost, stopped, cut or locked-out Monday run is retried the next day. **Every run row gets `finished_at` when it ends**, the lock-held and guard-failure rows included.

**Audit environment** (§6.6): `CONTROL_PLANE_DATABASE_URL`, `RESTORE_TEST_DATABASE_URL` (SSM), `BACKUP_BUCKET`, `BACKUP_KMS_KEY_ARN`, `ALERT_TOPIC_ARN`, `ALERT_RULE_NAMES`, `TRAIL_NAME`, `DLQ_ALARM_NAME`, `AWS_REGION`.

**Environment:** `CONTROL_PLANE_DATABASE_URL`, `RESTORE_TEST_DATABASE_URL` (both from SSM), `BACKUP_BUCKET`, `BACKUP_KMS_KEY_ARN`, `AWS_REGION`, `BACKUP_PG_RESTORE_BIN` (16.x), `RESTORE_TEST_CONCURRENCY` (default 2), `RESTORE_TEST_DEADLINE_HOURS` (default 6), `RESTORE_TEST_TARGET_DEADLINE_MINUTES` (default 120).

1. **Guards:**
   - take `RESTORE_TEST_LOCK_KEY`, retrying every 30 s for up to 10 minutes. The only other holder is the audit's short sweep. If it's still held, insert a run row `fail` with `detail = 'lock held'` and exit 1, so a skipped run is visible and the catch-up retries;
   - run the start checks;
   - the restore-test URL's host must differ from the control plane's, compared **after `toDirectConnectionUrl` on both**; and the restore-test URL must not contain `-pooler` (pg_restore needs a direct connection);
   - its database must have **no user tables**, so a production URL pasted by mistake is refused;
   - **its host must be in Neon us-east-1** (by `parseNeonHost`, §4.8: region `us-east-1`, direct, cell label allowed) and its `server_version_num` in 160000–169999. Neon's default region is us-east-2 and its default version 18 (§4.8), so a project made with the defaults is refused instead of silently holding customer copies outside us-east-1.

   A guard failure inserts a run row `fail` with `finished_at` set and the reason in `detail`, then exits 1. (Tests pass a host-guard override as an in-process parameter only, never an environment variable, because CI's servers share `localhost`.)
2. **Close abandoned runs:** any earlier `running` row is set to `fail`, `finished_at = now()`, `detail = 'abandoned'`.
3. **Sweep:** drop leftover `rt_…` databases older than 1 hour with no session (as §6.6 step 6; this run holds the lock).
4. **Insert the `restore_test_runs` row** (`running`, `planned`, `deadline_ms`).
5. **Choose the targets:**
   - always the control plane;
   - **eligible workspaces (E):** `active`, `suspended` or `provisioning` with a URL, and an `ok` backup in the last 36 h;
   - **due date** per workspace = the `tested_at` of its latest **PASS**, or, if it has never passed, its first `ok` backup's `finished_at`;
   - **N** = `max(1, ceil(E / 12), the number of eligible workspaces whose due date is more than 11 weeks ago)`. If E = 0, test the control plane only;
   - take the N workspaces with the **oldest due dates**, ties broken at random, and **test them in due-date order** (the control plane first). If the run deadline cuts the list, it cuts the newest.

   This meets §5's rule ("every one is restore-tested at least once every 13 weeks") **with a week of slack**. The cycle is 12 weeks, a workspace becomes overdue at 11, and a lost Monday is retried by the daily catch-up. A new workspace's due date is recent, so new signups can't push older customers out. A workspace that keeps failing keeps an old due date, so it's retested every week. Once it's 11 weeks overdue it **adds** to N rather than taking someone else's slot.
6. **Test the targets** with `RESTORE_TEST_CONCURRENCY` workers. Each worker uses its own database; at most `RESTORE_TEST_CONCURRENCY` databases exist at once, far below Neon's 500. Each target has a 2-hour deadline.
   1. **Pick the backup by listing**, as 3c will in a disaster:
      - consider objects under `v1/<cp>/<target>/<id>/` (`<cp>` from this task's own control-plane URL) ending `.dump.enc` that have a sidecar and are **at least 30 minutes old**, newest first (a backup still finishing can't be picked);
      - take the first whose `database_backups` row (by `s3_key`) exists and is `ok`;
      - if newer sidecar-backed objects were skipped for lacking a row, note that in `detail`. It isn't a failure: a backup that failed after uploading leaves exactly that.
      - No candidate at all: `FAIL:list`. Candidates but none with an `ok` row: `FAIL:no-row`.
   2. **Create** `rt_<YYYYMMDDHHMMSS>_<rand8>` in the restore-test project.
   3. **Stream** `GetObject` → hashing (SHA-256) → `decryptUnsignedMessageStream`. The context check runs on `MessageHeader` (§6.5); only then is `pg_restore --no-owner --no-acl --exit-on-error --single-transaction --dbname=<rt db>` spawned (pg 16, minimal env) and fed. Success means:
      - decryption ended without error;
      - pg_restore closed `(0, null)`;
      - the SHA-256 equals the row's.
   4. **Sidecar:** decrypt it (context `kind: manifest`, same `id`/`key`). It must equal the row on `sha256` and `row_counts`, ignoring key order.
   5. **Counts:** exact `count(*)` of every base table in the restored database. The table set and every count must equal the row's `row_counts`, giving PASS or MISMATCH (table names and both counts in `detail`).
   6. **`finally`:**
      - kill pg_restore if it's running;
      - close this worker's connections to the database;
      - `DROP DATABASE IF EXISTS <name>` (name checked by the regex);
      - `WITH (FORCE)` only if sessions remain (§4.8.1).

      A failed drop is logged; the next audit or test drops it and alerts.
   7. **Insert** the `restore_test_results` row.
7. **Finish:** set the run row to `pass` (every result PASS) or `fail`, with `finished_at`. SIGTERM (an ECS stop or task retirement) runs the same `finally` paths within `StopTimeout`, records `FAIL:stopped`, and closes the run `fail`.
8. **Run deadline:** `RESTORE_TEST_DEADLINE_HOURS`. Targets not reached are recorded `FAIL:not-reached`.

**Stages for `FAIL:<stage>`:** `list`, `no-row`, `create-db`, `download`, `decrypt`, `context`, `sha256`, `pg_restore`, `sidecar`, `count`, `deadline`, `not-reached`, `stopped`.

### 6.8 Retention
- The lifecycle rule expires objects at creation + 25 days, rounded up to midnight UTC (§4.3.6). AWS then deletes them asynchronously.
- The audit alerts if anything is older than 29 days. **Nobody deletes by hand**, and nothing has delete rights (the bucket policy).
- Deleted workspaces: backups stop at `deleting`, re-read per target. Their last backups expire under the rule.
- `BACKUP_RETENTION_DAYS` stays 30.
- `TENANT-DELETION.md` gains one paragraph: "Backups in S3 expire automatically within 30 days; nothing to do."

### 6.9 Monitoring
**`BACKUPS_EXPECTED` (Vercel env), as v4.1:**
- `1`: the sync runs;
- `0`: off, and the digest says so. On the production domain that line counts as news;
- anything else in production: "not configured", counted as news;
- local development: silent.

When the sync doesn't run (`0` or not configured), the step resolves **every** backup alert kind (`backup-*`, `restore-test-*`), so nothing lingers from a period when monitoring was on.

**Module `src/lib/tenant/backup-status.ts`** (server-only):
- `readBackupFacts(now, filter?)`;
- the pure `backupFindings(facts, now)`;
- `syncBackupAlerts(now, filter?)`.

It runs as an isolated step in `tenant-lifecycle/route.ts`, after `runLifecycleCron` and before signup maintenance. On a throw it raises the global `backup-check-failed` (best effort); a successful sync resolves it. **Alert details carry slugs, stages, counts and times only:** never an error text beyond the §6.4 summary, because the digest prints `detail` (`ops-digest.ts:139`).

| Finding | Condition (checked at 13:00 UTC) | Alert (scope / dedup) |
|---|---|---|
| missed backup run | no control-plane `ok` in 26 h; **anchored**: no alert until a first control-plane `ok` exists | `backup-missed-run` (global) |
| stale workspace | a URL, created over 36 h ago, newest `ok` missing or older than 36 h; **anchored** to the first control-plane `ok` + 36 h | `backup-stale` (tenant) |
| failed backup | the target's newest row is `failed` | `backup-failed` (tenant, or global / `control-plane`) |
| slow backup run | the latest run that backed up the control plane spanned more than 70% of the 6-hour deadline (from its rows' first `started_at` to last `finished_at`) | `backup-run-slow` (global) |
| audit missed | no `backup_audits` row in 12 h (the audit runs at 11:17, the check at 13:00, so one missed audit alerts the same day); **anchored** to the first audit row | `backup-audit-missed` (global) |
| old backups | latest audit `objects_over_29_days > 0` | `backup-old-objects` (global) |
| bucket drift | latest audit: versioning not `''`, or `stale_uploads > 0` | `backup-bucket-drift` (global) |
| key not enabled | latest audit `kms_key_state` isn't `Enabled` | `backup-key-state` (global) |
| alert email unconfirmed | latest audit `alert_email_confirmed` is false | `backup-alert-email` (global) |
| protection drift | latest audit `protection_drift` not null | `backup-protection-drift` (global; detail lists what's missing) |
| audit check failed | latest audit `errors` not null | `backup-audit-error` (global) |
| restore test missed | no finished run in 8 days, anchored to the first control-plane `ok` (no alert before that + 8 days) | `restore-test-missed` (global) |
| restore test failed | the latest **completed** run (§6.7's definition; ordered by `finished_at`) is `fail`, **or** a guard failure is the most recent finished row, **or** the latest run is `running` and started over 12 h ago (lock-held rows are ignored: the catch-up retries them) | `restore-test-failed` (global; detail lists failed targets by slug and stage) |
| slow restore test | the latest **completed** run took more than 70% of its `deadline_ms` | `restore-test-slow` (global) |
| slow target | a workspace's newest `ok` backup took over half of that row's `target_deadline_ms`, or its latest restore result **from the last 14 days** took over half of its run's `target_deadline_ms` | `backup-target-slow` (tenant; remedy: raise that deadline or the task CPU, stack parameters §6.1). The backup half clears on the next daily run; the restore half within 14 days. |
| test databases left behind, or a crashed test | latest audit `leftover_test_dbs > 0`, **or** a run in the last 7 days has `swept_test_dbs > 0`, **or** a run in the last 7 days was closed `abandoned` | `restore-test-leftover` (global; clears after 7 clean days) |
| permission drift | per role: the latest `backup_permission_checks.ok` is false, or no row in 8 days after the role's first | `backup-permission-drift` (global, dedup = role; detail names the probe) |
| database region | any target's newest row has `region` other than `us-east-1` | `backup-region` (tenant, or global / `control-plane`) |
| coverage (§5's rule itself) | an eligible workspace whose first `ok` is over 13 weeks old, with no PASS in 13 weeks | `restore-test-coverage` (tenant) |

- **The state table is this table:** raised while true, resolved the first sync it's false. Tenant findings for workspaces no longer `provisioning`/`active`/`suspended` are resolved.
- **The "slow" findings are the scale signal.** When one appears, raise `BACKUP_CONCURRENCY`/`RESTORE_TEST_CONCURRENCY` (and the task size). That's a stack parameter change by engineering, not founder work (§6.1 parameters, §9).
- **Digest section "Backups"** (try/catch; all `esc()`d):
  - "N of M workspaces backed up in the last 26 h. Newest control-plane backup: <time>."
  - "Last restore test <date>: <pass/fail>, control plane + K workspaces."
  - the off / not-configured line, or "Backup status could not be read" (counts as news).

  Findings appear under "Unresolved alerts", not twice.
- **Immediate (AWS → email), not via the digest:** the §6.1 protections rule and the DLQ alarm. The audit also puts the key state, the email subscription state, the bucket settings and the protection drift check into the digest.

### 6.10 Staging and local
- **Staging:** `BACKUPS_EXPECTED=0`; no stack of its own. **The rehearsal uses the production stack, pointed at staging** (§12 steps 6–11): the founder first fills the SSM parameters with **staging's** control-plane URL and key, and the stack's first runs back up and restore-test staging. Once they pass, the founder replaces those two parameters with production's.
  - Staging's backups sit in the production bucket and expire in 25 days like any other. Staging holds only test data.
  - No second stack, no teardown, no name collisions.
- **Local:** `npm run backup:local -- backup --dry-run` (targets and server versions; no AWS). The commands' cores are tested with fakes (§11).

### 6.11 The Privacy page
- `src/app/privacy/page.tsx:43-44`: replace "Deleted data may remain in backups for up to 30 days." with the §3 (A2) sentence: "Backups expire automatically within 30 days of being made and are then permanently deleted by our storage provider."
- Update the pin in `legal-pages.test.tsx:28`.
- Nothing else on the page changes. AWS is already listed as a provider (`:52`). Q3 asks the founder about the 25-hour IP-hash sentence.

### 6.12 Removed from v4.1
- `age`, `ops/backup-recipient.txt`, `db:restore`, the founder drill and `--s3-only` drills;
- `restore_copies`, `register-restore-copy`, `restore-copy-destroyed`, and the `tenant:delete` copy refusal;
- `backup_drills`;
- `--list-old` and manual deletion;
- the `db-backup.yml` workflow and the GitHub-hosted jobs.

### 6.13 Permission probes (invariants 2 and 3, checked automatically)
Each task, at the end of its run, tries the actions its role must **not** have and records what AWS said. Probes never read or change real data.

| Role | Probes |
|---|---|
| backup | `HeadObject` on its own just-written key; `DeleteObject` on `v1/probe/does-not-exist`; `kms:Decrypt` and `kms:ReEncrypt` of this run's encrypted data key; a `PutObject` **without** `If-None-Match` to `v1/probe/<runId>` |
| audit | `HeadObject` on `oldest_key`; `kms:Decrypt` of the newest stored data key; `DeleteObject` on a non-existent key |
| restore-test | `DeleteObject` on a non-existent key; `PutObject` with `If-None-Match` to `v1/probe/<runId>` |

**What counts as `denied`:**
- **HeadObject:** HTTP status **403** (`$metadata.httpStatusCode`). A HEAD response has no error body, so the SDK reports `Forbidden` and never `AccessDenied` (§4). The key is known to exist, so 403 can only mean "not allowed".
- **S3 PUT and DELETE:** the error code `AccessDenied`.
- **KMS:** the error code `AccessDeniedException`.
- Any success is `ALLOWED`; any other error is `error:<code or status>`. Either makes `ok = false`.

**Probe inputs:**
- **The Decrypt probes use a real encrypted data key.** A dummy blob might be rejected as invalid before the deny is evaluated. The backup task takes the encrypted data key and its context from its first object's `MessageHeader` this run, and stores them in `detail.edk` / `edk_context`. That's safe: it's useless without `kms:Decrypt`, and `ReEncrypt` is denied too. The audit probes with the newest stored `edk`, and its probe is `skipped` (still `ok`) if there's none yet.
- **The audit's HeadObject** uses `oldest_key`, and is `skipped` when the bucket is empty.
- **The backup's HeadObject and Decrypt probes are `skipped`** (still `ok`) when the run wrote no object (every target failed). The real failure is alerted on its own.

If the backup role's unconditional PUT ever succeeds, the object `v1/probe/<runId>` expires within 25 days like any other.

The digest finding `backup-permission-drift` turns "the backup job can't read or delete" from a one-time check into a daily one.

## 7. State machines

### 7.1 One backup attempt (per target, per run)
As v4.1 §7.1, with `age` read as the encrypt stream:

| State | Event | Next | Side effects |
|---|---|---|---|
| queued | status re-read is `deleting`/`deleted` | skipped | none |
| start | server version not 16 | failed | `failed` row |
| start | connection error | retry after 5 s, then failed | `failed` row |
| start | `begin` rejects before the pipeline | failed | `failed` row |
| dumping | any stage fails, or the 30-minute deadline | failed | kill pg_dump; destroy the encrypt and hashing streams; abort; `failed` row |
| dumping | pg_dump `(0,null)` and encrypt `end` → body ended → upload resolves, ≥ 1024 bytes | uploaded | — |
| uploaded | sidecar fails | failed | the dump object stays (it expires); `failed` row |
| uploaded + sidecar | row ok | ok | `BACKUP` line; `ok` row |
| uploaded + sidecar | row insert fails | failed (summary) | `BACKUP … row-failed` line; exit 1 |
| failed (tenant) | retry round | queued (new key) | — |
| all tenants settled, or T + 75 min | — | control plane starts | — |
| control plane failed | ≥ 35 min left before the 6 h run deadline | one retry | — |
| any | run deadline (6 h) | failed `run-deadline` | kill; abort; rows |
| any | SIGTERM (ECS stop) | failed `stopped` | same, within `StopTimeout` |
| (run) | backup tables missing | exit 1 | "run deploy-prod first"; `backup-missed-run` at 13:00 |
| (run) | advisory lock held | exit 0 | log line only |
| (run, catch-up) | today's control-plane `ok` exists, and every eligible tenant has an `ok` row today | exit 0 | none |
| (run, catch-up) | today's control-plane `ok` exists; some tenants failed today **or have no row today** (provisioned after the morning run, or not reached before the deadline) | backs up only those | rows |

### 7.2 One restore-test target

| State | Event | Next | Side effects |
|---|---|---|---|
| chosen | no sidecar-backed object at least 30 min old under the prefix | done `FAIL:list` | result row |
| chosen | candidates exist, none with an `ok` row | done `FAIL:no-row` | result row |
| chosen | a newer candidate lacks a row, an older one has an `ok` row | restoring (the older one) | note in `detail` |
| chosen | `CREATE DATABASE` fails | done `FAIL:create-db` | result row |
| restoring | GetObject or stream error | `FAIL:download` | kill pg_restore; drop the db; result row |
| restoring | header context differs | `FAIL:context` | destroy the stream; pg_restore was never started; drop; result row |
| restoring | decryption fails mid-stream | `FAIL:decrypt` | same |
| restoring | pg_restore non-zero | `FAIL:pg_restore` | same |
| restoring | SHA-256 differs from the row | `FAIL:sha256` | drop; result row |
| restored | sidecar differs or won't decrypt | `FAIL:sidecar` | drop; result row |
| restored | table set or a count differs | MISMATCH | drop; result row with the differences |
| restored | all equal | PASS | drop; result row |
| any | 2-hour deadline | `FAIL:deadline` | kill; drop; result row |
| any | SIGTERM | `FAIL:stopped` | kill; drop; result row within `StopTimeout` |
| any | drop fails | (result unchanged) | logged; the next audit or test drops it and alerts |

### 7.3 One restore-test run

| State | Event | Next | Side effects |
|---|---|---|---|
| — | (catch-up) a run finished since Monday 00:00 UTC | exit 0 | none |
| — | lock still held after 10 minutes of retries | exit 1 | a `fail` run row, `detail = 'lock held'`; the next day's catch-up retries |
| — | a guard fails | exit 1 | a `fail` run row with `finished_at` and the reason |
| — | start | running | close earlier `running` rows as `fail`/`abandoned`; sweep; run row |
| running | every target done, all PASS | pass | `finished_at` |
| running | any target not PASS | fail | `finished_at`; `restore-test-failed` at the next digest |
| running | run deadline | fail | remaining targets `FAIL:not-reached` |
| running | SIGTERM | fail | in-flight targets `FAIL:stopped`; `finished_at` |
| running | task killed without `finally` (SIGKILL, OOM) | stays `running` | after 12 h, `restore-test-failed` (latest run); the next run closes it `abandoned` and sweeps its databases; the next audit drops them first if no test holds the lock |

### 7.4 Monitoring
The §6.9 table: raised while true, resolved the first sync it's false.

## 8. Failure modes
| # | Failure | Behaviour |
|---|---|---|
| F1 | A schedule fails to start its task (RunTask API error) | Scheduler retries per §4.1. Exhausted retries land in the dead-letter queue, whose alarm emails at once. A missing backup also raises `backup-missed-run` at 13:00, and the 18:17 catch-up runs. |
| F2 | RunTask accepted but the task can't start (capacity, image pull) | The task stops. No rows, so `backup-missed-run`. The catch-up covers one miss. (§4.1.3: undocumented whether Scheduler retries this, so the design doesn't rely on it.) |
| F3 | Control plane unreachable from AWS | Fatal, exit 1, no rows; `backup-missed-run`. |
| F4 | A workspace unreachable | Retry after 5 s, the retry round, then `backup-failed`. The catch-up retries that day's failures. |
| F5 | pg_dump fails mid-stream | The end gate destroys the body; no object completes. |
| F6 | KMS unavailable or denied | The encrypt stream errors at its first data key; every target fails; alerts. |
| F7 | Row insert fails after upload | The objects and the `BACKUP … row-failed` line exist; the restore test can't use them (no row). They expire. |
| F8 | The key is scheduled for deletion or disabled | Immediate email; the digest's `backup-key-state`. The 30-day window leaves time to cancel; the key policy refuses a shorter window. |
| F9 | Someone enables versioning | The bucket policy denies it; any attempt to change the policy, or versioning, emails at once; the audit records the versioning state and alerts. |
| F10 | A deploy changes who can read backups | Needs the founder's approval (Q1). Policy changes email at once; CloudTrail logs everything. |
| F11 | The backup role leaks | It can only add objects: no read, delete, overwrite, decrypt or re-encrypt. Junk expires in 25 days; the budget alerts on abuse. The daily probes prove the limits. |
| F12 | The restore-test role leaks | It can read and decrypt backups. It's reachable only by ECS tasks in this account and region (trust conditions); there are no keys to leak. Stated plainly. |
| F13 | `ENCRYPTION_KEY` or the control-plane URL in SSM is wrong or stale (rotated in Vercel, not in AWS) | Every workspace fails, or the run fails; alerts the same day. The runbook names the SSM update. |
| F14 | A restore test leaves a database behind | The audit drops it within a day, only when no test holds the lock, and alerts; the next test sweeps it. |
| F15 | Restore-test URL points at production by mistake | Refused: same host as the control plane, a pooled host, or user tables present (§6.7 step 1). |
| F16 | Restore-test Neon project deleted or suspended | `FAIL:create-db`; `restore-test-failed`; the audit records `errors`. |
| F17 | Overlapping runs | Advisory locks (distinct keys); unique keys; the audit's sweep takes the restore-test lock. |
| F18 | Growth: runs approach their deadlines | `backup-run-slow` / `restore-test-slow` at 70%, before anything fails. Engineering raises the concurrency and task size (§9). |
| F19 | Old objects (AWS's deletion is late) | `backup-old-objects` at 29 days, a safety net. Within the 30-day promise in all normal cases (§4.3.6). |
| F20 | Monitoring misconfigured | Off / not-configured lines; `backup-check-failed` (resolved when the sync is off). |
| F21 | The alert email isn't confirmed, or the subscription is lost | The audit records it daily and the digest alerts (`backup-alert-email`). Fix: in SNS, **Request confirmation** within 48 h; after that, re-create the subscription in the console. The §12 checklist proves delivery with a test alarm. |
| F22 | Migration and dump overlap | Two ordered locks (§6.4): `migrate-all` waits for a running backup, and a backup waits for a running migration, so neither starts while the other runs. The only residue is a migration still running after the backup's 60-minute wait. |
| F23 | AWS account suspended for an unpaid bill | Every task stops; alerts at 13:00. Mitigations: the Paid plan, a backup card, the budget alert. |
| F24 | A wrong workspace's backup restored | The encryption context's `id` and `key` must match, checked before pg_restore starts. |
| F25 | The environment auto-created unprotected | §12 order: the environment is created, gated and **verified** before the bootstrap stack exists (a merge gate). The job-level `if` on `vars.AWS_BACKUPS_ENABLED` means no run reaches the environment until the founder sets it. |
| F26 | Deploy fails halfway | An update rolls back to the previous stack, and the old task definitions keep running. A failed **first** create ends in `ROLLBACK_COMPLETE` with nothing retained (`RetainExceptOnCreate`); `deploy.sh` says to delete the empty stack in the console and re-run. |
| F27 | AWS retires a running task for maintenance (§4.2.3) | SIGTERM: targets recorded `failed`/`FAIL:stopped` within `StopTimeout`. The backup catch-up re-runs it that evening; the restore-test catch-up re-runs a stopped test the next day (§6.7). |
| F28 | Re-running a deploy for the same commit | `deploy.sh` reuses the existing image tag's digest instead of pushing again (immutable tags). |
| F29 | A compromised npm package in the build | It runs only in the `build` job (no OIDC, no environment, no secrets) and inside Docker's builder stage with `--ignore-scripts`. It can't reach AWS. A malicious change to the *bundled code* would still ship on the founder's approval, which is the normal code-review risk. |
| F30 | Customer values in error text | `summarizeError` keeps only stage, exit code, SQLSTATE, table name and allow-listed messages (§6.4). |
| F31 | An admin deliberately gets read access | Possible by design (invariant 3): a hardware-key login acting on purpose. Policy changes email at once; running a task by hand doesn't, but CloudTrail keeps it. |
| F33 | A protection silently removed (a policy replaced by a template change, a rule disabled) | Changes email at once, whoever makes them; the daily audit compares the bucket policy, lifecycle, key policy and alert rule with what's expected (`backup-protection-drift`). |
| F34 | A Monday restore test lost (couldn't start, retired, crashed, lock held) | The daily catch-up (Tue–Sun 08:17) runs it the next day. The 12-week cycle leaves a week of slack inside §5's 13. |
| F35 | A backup older than 29 days | `backup-old-objects`. Nothing can delete it (by design); AWS removes expired objects asynchronously and bills nothing after expiry. If one stays over 30 days, open an AWS support case (RESTORE.md). |
| F32 | The image falls behind the code | The path filter lists every bundle input outside `node_modules`, enforced by the U6 metafile test. A deploy waiting for approval simply waits; the founder gets GitHub's email. Dependency updates ride with the next backup-code change. |

## 9. Platform limits
- **ECS Fargate:** no runtime limit (the 6-hour run deadline is ours). 2 vCPU / 4 GiB. Streaming, so dumps never touch disk. lib-storage buffers about (queueSize + 1) × 64 MiB per upload: about 576 MiB at concurrency 3, inside 4 GiB.
- **Scale:**
  - one run backs up E workspaces at `BACKUP_CONCURRENCY` at a time;
  - when `backup-run-slow` appears, raise `BACKUP_CONCURRENCY` (and the task size); beyond that, a second schedule taking half the workspaces (`--shard 1/2`, a later change, not built now);
  - restore tests grow with `ceil(E/12)` per week, run `RESTORE_TEST_CONCURRENCY` at a time. At about 7 minutes per workspace, 2 workers and 6 hours cover about 100 per run (E ≈ 1,300); `restore-test-slow` warns before that limit.
- **Neon:**
  - backups use transfer of about the uncompressed size per day per project (500 GB/project/month on Launch/Scale);
  - the restore-test project: storage only while a test runs; compute about the restore time once a week. Its compute size sets restore speed (raise it when `restore-test-slow` appears);
  - **each daily dump wakes that workspace's Neon compute** for the dump plus Neon's autosuspend delay (about 5 minutes), including trial and suspended workspaces. At hundreds of workspaces that's real compute time on the Neon bill; the 18:17 catch-up usually does no work.
- **Costs at launch** (estimates for the founder; §4 has the prices):
  - KMS $1/month;
  - S3 under $1;
  - Fargate cents;
  - public IPv4 while tasks run, cents;
  - CloudTrail first trail free;
  - Scheduler and SNS within free tiers.
  
  Total well under $10/month.
- **Vercel:** isolated reads in the daily cron.

## 10. Blast radius

### 10.1 Changed or new
| File | Change |
|---|---|
| migration + `src/db/control-plane/schema.ts` | 5 tables |
| `scripts/backup/main.ts`, `backup.ts`, `audit.ts`, `restore-test.ts`, `lib/*`, `deploy.sh` | **new** |
| `ops/aws/bootstrap.yml`, `ops/aws/backup-stack.yml` | **new** |
| `Dockerfile.backup`, `.dockerignore` (excludes `.env*`, `node_modules`, `.git`, `test-data/`) | **new** |
| `.github/workflows/backup-deploy.yml` | **new** |
| `.github/workflows/ci.yml` | the integration job on `ubuntu-24.04` installs `postgresql-client-16`, sets `REQUIRE_PG16_TOOLS=1` plus `BACKUP_PG_DUMP_BIN`/`BACKUP_PG_RESTORE_BIN`, and creates an empty `bytime_rt_test` database (the restore-test target); a new step runs `cfn-lint ops/aws/*.yml`; a new step builds the image and runs `--self-check` |
| `src/lib/tenant/backup-status.ts` | **new** |
| `src/lib/tenant/backup-locks.ts` | **new**: the four lock constants (§6.4) |
| `src/lib/tenant/direct-url.ts` | **new**: `toDirectConnectionUrl` moved here unchanged; `migrate-tenant.ts` re-exports it, so app-side migration edits don't change the backup bundle |
| `scripts/migrate-all.ts`, `scripts/backup/lib/backup-wait.ts` (**new**) | the ordered-lock wait (§6.4); `MIGRATIONS.md` notes it |
| `src/app/api/cron/tenant-lifecycle/route.ts` | the isolated backup step |
| `src/lib/tenant/ops-digest.ts` | the Backups section |
| `src/app/privacy/page.tsx`, `src/__tests__/unit/legal-pages.test.tsx` | the §6.11 sentence |
| `package.json` | scripts `backup:local`, `backup:bundle` (the esbuild command, also used by U6 for the metafile); `esbuild` becomes a pinned direct devDependency (today it's only transitive); dependencies `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, `@aws-sdk/client-kms`, `@aws-crypto/client-node` (bundled into the image only); devDependency `yaml` |
| `.env.example` | `BACKUPS_EXPECTED` |
| Tests | the source-scan tests that will also read `scripts/backup/**` (`sql-template-params`, `route-moves`, `user-rules-lock`, `admin-change-log-writer`, `dated-rates-d1`): allow-list entries as needed, no rule weakened; `signup-ops.test.tsx:171-189` (mock `backup-status`, the order); `ops-digest-alerts.test.ts` (stub the new queries; the all-quiet text); `tenant-notices.test.ts:272`, `seat-sync.test.ts:308` (`BACKUPS_EXPECTED` unset, so no section) |
| `RESTORE.md` | a "Backups beyond Neon" section: what runs, where results show, that a lost project or account is item 3c's button (until 3c, contact the lead), and the 29-day remedy (F35). **Per Q4,** the "Monthly restore drill" section is removed (if the founder accepts) |
| `TENANT-DELETION.md` | the S3 paragraph (§6.8) |
| `PRODUCTION-DEPLOY.md` | new Phase "Backups (AWS)" (§12); Phase 15 row; Operations (what the digest shows); env table `BACKUPS_EXPECTED`; "if `ENCRYPTION_KEY` or the control-plane URL changes, update SSM"; "approve a backup deploy that comes with a backup-table migration only after `deploy-prod`"; bootstrap updates in the console; the deploy-state runbook lines |

### 10.2 Checked, unchanged
- app request paths; `deploy-prod.yml` (its `db:migrate:all` step gains the wait through `migrate-all.ts`);
- `checkFounderExports`, `tenant-export.ts`, `delete-tenant.ts` founder exports (3d);
- the business drafts' Terms §9.3 / Privacy §7 (the business side applies §3 (B)).

## 11. Required tests (each must fail without the change it proves)
**Without AWS.** The commands use seams:
- `BackupStore` (put, head, delete) and `BackupReader` (list, get), faked in memory;
- `KeyringFactory`, which in tests returns the Encryption SDK's **raw AES keyring**, so the real streaming encryption code runs;
- `KeyClient` (DescribeKey, Decrypt/ReEncrypt probes), `TopicClient` and the clock, faked;
- AWS-shaped errors in the fakes match the real SDK: HEAD 403 is `{ name: 'Forbidden', $metadata: { httpStatusCode: 403 } }`; S3 denials `AccessDenied`; KMS denials `AccessDeniedException`.

**Restore tests** run against the local Postgres server, using the empty `bytime_rt_test` database as the "restore-test project" (CI creates it; §13 creates it locally). pg 16 `pg_dump`/`pg_restore` via `BACKUP_PG_*_BIN`. With `REQUIRE_PG16_TOOLS=1` (CI and §13) a missing or wrong tool **fails** instead of skipping. The host guard is overridden in-process only.

**Isolation:** `test-lc-*` tenants; `test-` run ids in every table; the filters; cleanup of the five tables and the new global alert kinds. No test calls the whole route.

**Unit:**
- **U1:** keys and the sidecar key; run-id and `rt_` name formats.
- **U2:** `summarizeError` with real error samples (a COPY failure with `CONTEXT … line 3: "…"`, a `DETAIL: Key (email)=(…)`, `invalid input syntax …: "AB123"`, `Failing row contains (…)`, `connection to server at "ep-….neon.tech" … failed`, `password authentication failed for user "…"`): **no quoted value, host or user name survives**; `AB123` is not taken as a SQLSTATE; the SQLSTATE comes only from `err.code`; the label is right; the table is kept. The crash handler logs only the summary. Plus the password split; the minimal child env; no URL or host in any log line (a capture test across a failing run).
- **U3:** `backupFindings`: every §6.9 row raised and cleared, plus:
  - a new workspace; null-URL provisioning; a workspace leaving active;
  - the restore-test anchor (no alert in the first 8 days);
  - the latest-run rule: an old `running` row followed by a newer `pass` → no alert;
  - the 12-hour rule on the latest run;
  - coverage at 13 weeks;
  - the slow thresholds;
  - `alert_email_confirmed` false and null;
  - `backup-region` for a non-us-east-1 row;
  - `backup-target-slow` from `target_deadline_ms`, with the restore half ignoring results older than 14 days.
- **U4:** the end gate: the body ends only after pg_dump `(0,null)` **and** the encrypt `end`; any failure destroys it.
- **U5:** environment checks (empty values, a non-hex key, a wrong pg_dump/pg_restore version); the lock keys are distinct from each other and from `MIGRATION_LOCK_KEY`; every lock connection is built with `toDirectConnectionUrl` (a connection-factory seam fed a `-pooler` URL must receive the direct host); missing tables → fatal with the message; outside ECS, everything but `backup --dry-run` and `--self-check` is refused; `--self-check` uses the image's default tool paths when the `*_BIN` variables are unset; `<cp>` is derived from the direct host.
- **U6:** static checks on the templates, the Dockerfile and the workflow:
  - **the backup task role has no `s3:GetObject`, `s3:DeleteObject*`, `kms:Decrypt` or `kms:ReEncrypt*`;** the audit role has none of those either;
  - the key policy denies Decrypt and ReEncrypt to all but the restore role, denies a deletion window under 30, and denies `PutKeyPolicy` to all but `CfnExecRole`;
  - the deny ARNs include the `/cadenzpoint-backup/` path;
  - the bucket policy denies versioning, Object Lock, deletes, Gets (except the restore role), PUTs without If-None-Match, and policy and lifecycle changes (except `CfnExecRole`);
  - the bucket has no `VersioningConfiguration` and has the 25-day rule;
  - `RetainExceptOnCreate` on the backup bucket and key; the trail and its bucket (`Retain`, generated name) in `bootstrap.yml`;
  - no NAT gateway; no Container Insights;
  - every schedule pins a revision, uses UTC, `FlexibleTimeWindow: OFF`, a retry policy and the DLQ; both catch-ups have their `containerOverrides` input;
  - the two rules list exactly the §6.1 event names, with **no caller condition**, and only the roles rule has the `roleName` prefix. **Sample CloudTrail events run through a small pattern matcher** (KMS `DisableKey` and S3 `PutBucketPolicy` match the protections rule; IAM `PutRolePolicy` on `cadenzpoint-backup-x` matches the roles rule; on `other-role` it matches nothing). The topic policy allows events and cloudwatch; the DLQ alarm has its fixed name and `notBreaching`;
  - `DeployRole` names the exact stack ARN and the exact legacy `sub` (`StringEquals`); the bootstrap roles have fixed names and sit outside `/cadenzpoint-backup/`; the `CfnExecRole` ARN in the main stack's denies equals the bootstrap's name and path; the execution roles have the ECR pull actions; the audit role has the drift Get/Describe actions; `CfnExecRole` has `iam:CreateServiceLinkedRole` for ECS; the task-role trusts have the account and region conditions; the trail is in `bootstrap.yml`, not the main stack;
  - the workflow: SHAs pinned; the `build` job has no `id-token` and no environment; the `deploy` job has `id-token` and `environment: aws-backups`; both have the job `if` (main and `vars.AWS_BACKUPS_ENABLED == 'true'`); the ARNs, URI, bucket and email come from `secrets.*`, never `vars.*`; `persist-credentials: false`; `mask-aws-account-id: true`; no `npm` in the deploy job; no `inputs.*` in `run:`;
  - the Dockerfile builder runs `npm ci --ignore-scripts`;
  - **every non-`node_modules` input in the esbuild metafile matches a `paths` entry**, and the `src/` inputs are only the three named modules; the Dockerfile runs `npm run backup:bundle` and copies `tsconfig.backup.json`;
  - no `!` short-form tags in the templates; `backup-stack.yml` parses;
  - no `src/` import of `@aws-sdk/*` or `@aws-crypto/*`.
- **U7:** restore-test target choice:
  - N at E = 0, 1, 12, 13, 25;
  - targets returned in due-date order;
  - **simulations over 26 weeks** (each asserts that no passing workspace's gap between PASSes exceeds 13 weeks):
    - E = 10 with one new workspace a week;
    - one permanently failing workspace (N grows by one once it's 11 weeks overdue);
    - **one lost Monday recovered by Tuesday's catch-up**;
    - **a run cut by the deadline** (the newest-due targets are the ones not reached);
  - ties random.
- **U8:** count comparison: a missing table, an extra table, a differing count; key order ignored; string versus number counts.
- **U9:** the digest Backups section: both summary lines, the `0` line, not-configured, silent in development, no duplication, `esc()`, "could not be read" in `hasNews`.
- **U10:** the route order with `vi.doMock`: the backup step runs between lifecycle and signup maintenance; a throwing step still lets the digest run and raises `backup-check-failed`; with `BACKUPS_EXPECTED=0` the step resolves `backup-check-failed`.
- **U11:** the restore-test URL guards: same host refused (also when one URL is pooled and the other direct); a `us-east-2` host refused; a `c-2.us-east-1` host **accepted**; a `c-2.us-east-2` host refused; a Postgres 18 server refused; `-pooler` refused; a database with user tables refused; the drop regex refuses `postgres`, `template1`, `rt_2026111608` (short) and tenant-like names.
- **U12:** the header check: a mismatched context destroys the stream **and pg_restore is never spawned** (the spawn seam records no call).

**Integration** (fake store and reader; raw AES keyring; real Postgres):
- **S1:** two `test-lc-*` tenants (one `suspended`) plus the control plane, with fake pg_dump:
  - `ok` rows, sidecars, SHA-256 equal to the stored bytes, exact counts (as numbers), `BACKUP` lines;
  - a `deleting` tenant skipped;
  - the control plane starts only after all tenant work, and includes this run's tenant rows.
- **S1b:** a hung tenant past the (shortened) T + 75 → the control plane still runs; the summary names the slug.
- **S2:** fake pg_dump exits 1 mid-stream → `failed`; the store never saw end-of-stream.
- **S2b:** a hanging pg_dump → killed at the (shortened) deadline → `failed` `deadline`.
- **S3:** the keyring throws (KMS denied) → every target `failed`; exit 1.
- **S4:** the store rejects 412 → retry with a new key → `ok`.
- **S5:** row insert fails → the `row-failed` line; exit 1.
- **S6:** **real pg_dump 16**, rows inserted and committed through the `afterCounts` hook (between the counts and the pg_dump spawn) → the restored counts equal the snapshot (fails without `--snapshot`).
- **S7:** connection error then ok; two errors → failed; a count-query error before the pipeline → failed with no hang (10 s test timeout).
- **S8:** the advisory lock: a second run exits 0 with no rows.
- **S9:** `syncBackupAlerts(now, filter)` with `BACKUPS_EXPECTED=1`: every finding raised and resolved; `0` → nothing synced.
- **S10:** **the restore test end to end** with real pg_dump and pg_restore 16. Back up two test tenants and the control plane into the fake store (raw AES keyring), then run `restore-test` against `bytime_rt_test`'s server:
  - with the target-selection seam overridden to choose both tenants: **PASS** for each and for the control plane;
  - no `rt_…` database remains;
  - the run and result rows are correct;
  - with `RESTORE_TEST_CONCURRENCY=2`, two databases exist at once at most.
- **S11:** restore-test failures, each with no `rt_…` left behind:
  - a tampered ciphertext frame → `FAIL:decrypt`;
  - a valid object whose row has a different `sha256` → `FAIL:sha256`;
  - **another tenant's object copied under this tenant's prefix, with a matching `ok` row and the right SHA-256 inserted for it** → `FAIL:context`;
  - a row with altered `row_counts` → MISMATCH with the difference in `detail`;
  - a forced pg_restore failure → `FAIL:pg_restore`, and `detail` holds only the summary;
  - no row for any candidate → `FAIL:no-row`;
  - a newer object without a row plus an older one with an `ok` row → the older is restored (PASS, note in `detail`);
  - an object under 30 minutes old is ignored.
- **S12:** a wrong `ENCRYPTION_KEY` → tenants `failed`, the control plane `ok`.
- **S13:** `audit` with fake clients:
  - the row's fields; one throwing check → `errors` set and the row still inserted;
  - leftover `rt_…` databases older than 1 h with no session dropped and counted; newer ones, and ones with a session, left alone;
  - **with `RESTORE_TEST_LOCK_KEY` held by another connection → nothing dropped, `leftover_test_dbs` null.**
- **S14:** `--if-missing-today`: no work when today is complete; only failed tenants **and tenants with no row today**; a full run when there's no control-plane `ok` today.
- **S15:** a stop signal (through an injectable signal seam, not a real SIGTERM to the test process) during a restore test → the `rt_…` database dropped, the result `FAIL:stopped`, the run closed `fail`.
- **S16:** permission probes with the fakes:
  - all refused (HEAD 403, `AccessDenied`, `AccessDeniedException`) → `ok`;
  - one allowed → `ok = false`, `ALLOWED`;
  - another error → `error:<code>`, `ok = false`;
  - audit with no stored `edk` → `skipped`, `ok`.
  - `backupFindings` raises `backup-permission-drift` for a false row and for a role with no row in 8 days.
- **S17:** an earlier `running` run row is closed `fail`/`abandoned` by the next run, and `restore-test-failed` then follows the latest run.
- **S19:** `--if-missed` re-runs after a Monday run that was stopped, cut by the deadline, locked out or guard-failed, and exits after a completed pass or a completed fail. Plus the remaining §7.2/§7.3 transitions, each with its row: `FAIL:list`, `FAIL:create-db` (fake), `FAIL:download` (reader error mid-stream), `FAIL:sidecar`, `FAIL:deadline` and `FAIL:not-reached` (shortened deadlines), a guard-failure run row, a failed drop logged, the step-3 sweep, the lock retried then `lock held`, and `--if-missed` exiting when a run finished since Monday.
- **S20:** the audit's drift check: a changed rule pattern, an extra rule target, a trail not logging, a subscription with a filter policy, a missing DLQ alarm; a missing bucket-policy `Sid`, a missing key-policy `Sid`, **a statement with its `Sid` kept but its `ArnNotEquals` exemption widened**, a disabled rule, and a missing lifecycle rule each recorded in `protection_drift`; all equal → null; scalar versus one-item array → equal.
- **S21:** the ordered locks, with the lock held on a second connection: `migrate-all` waits, then exits 1 after the (shortened) limit with nothing applied; `--check` never waits; with `MIGRATE_RUN_LOCK_KEY` held, a backup waits and then proceeds, recording the wait; `isAdvisoryLockHeld` reads `pg_locks` without taking the lock; both helpers connect through `toDirectConnectionUrl`.
- **S18:** backup tables missing (a schema without the migration) → every command exits 1 with "run deploy-prod first".

**Template proof beyond U6:** `cfn-lint` in CI (§10.1). Real AWS behaviour is proven at §12 steps 8–12.

## 12. Founder steps (PRODUCTION-DEPLOY, new Phase "Backups (AWS)"), **in this order**
`FOUNDER-ACCOUNTS-SETUP.md` has every click. This is the checklist. Steps 6–11 are also the **staging rehearsal**, a production-readiness gate.
1. **AWS account:** create it with the advanced sign-up; register two hardware keys on root; the Paid plan; a backup card; alternate contacts; your admin login (security key, no access keys).
2. **Neon:** create `cadenzpoint-restore-tests` (us-east-1, **Postgres 16**, history window 0), and copy its **direct** connection string.
3. **GitHub, before the bootstrap stack exists:**
   - create environment `aws-backups`: Selected branches → `main`; required reviewer → you; **"Prevent self-review" off**; **"Allow administrators to bypass" off**;
   - add the environment secret `BACKUP_ALERT_EMAIL` (in the environment's page, **Environment secrets → Add secret**);
   - **verify** with two commands, and send the output to the lead:
     - `curl -s https://api.github.com/repos/ccentofo/bytime/environments/aws-backups` must show a `required_reviewers` rule naming you, `"can_admins_bypass": false` and `"custom_branch_policies": true`;
     - `curl -s https://api.github.com/repos/ccentofo/bytime/environments/aws-backups/deployment-branch-policies` must list exactly one policy: `main`, type `branch`.
   - **This item may merge only after this check** (the merge gate). With `AWS_BACKUPS_ENABLED` unset, the deploy workflow does nothing, so merging before AWS exists is safe.
4. **Bootstrap stack:**
   - in the AWS console (as `corey-admin`, us-east-1): CloudFormation → Create stack → upload `ops/aws/bootstrap.yml` → acknowledge IAM → Submit;
   - copy the four outputs into **`aws-backups` environment secrets**: `AWS_DEPLOY_ROLE_ARN`, `AWS_CFN_EXEC_ROLE_ARN`, `AWS_BACKUP_REPOSITORY_URI` and `AWS_ARTIFACTS_BUCKET`.
5. **Make sure the app is deployed with this item's migration** (`deploy-prod`), and staging too.
6. **SSM, staging values first (the rehearsal):**
   - `/cadenzpoint/backup/control-plane-url` = **staging's** control-plane URL;
   - `/cadenzpoint/backup/encryption-key` = **staging's** `ENCRYPTION_KEY`;
   - `/cadenzpoint/backup/restore-test-url` = the Neon string from step 2.

   Take the values from the password manager (PRODUCTION-DEPLOY Phase 4); Vercel doesn't reveal sensitive values.
7. **First deploy:** set the repository variable `AWS_BACKUPS_ENABLED` = `true` (this arms the workflow), then Actions → "Backup system deploy" → Run workflow. Approve it (**Review deployments → Approve and deploy**). Expect both jobs green.
8. **Confirm the alert email** from AWS (within 48 hours; if missed, use SNS → the subscription → **Request confirmation**).
9. **First runs (against staging):**
   - in ECS → cluster `cadenzpoint-backup` → **Run new task**, run the `backup` task family, then `audit`. **Wait at least 30 minutes after the backup task stops** (the restore test ignores newer objects), then run `restore-test`. The runbook gives the exact clicks.
   - **Expect** in **staging's** control plane: `ok` rows with `region = us-east-1`, an audit row with `Enabled`, `alert_email_confirmed = true`, `protection_drift` null and `errors` null, a `pass` restore-test run, and three `backup_permission_checks` rows with `ok = true`.
   - Set staging's `BACKUPS_EXPECTED=1` for a day and check the digest shows the Backups section, then set it back to `0`.
   - **The next day,** check the 18:17 catch-up's log line shows `--if-missing-today` (proving the schedule's command override), and, if the hand-run restore test happened since Monday 00:00 UTC, the next 08:17 restore-test catch-up exits at once ("a completed run since Monday").
10. **"Can't" checks**, Tuesday to Sunday between 15:00 and 17:00 UTC (no job runs then), in **AWS CloudShell** as `corey-admin`. Paste the commands the lead gives you:
    - `aws s3api head-object` on a backup key → expect **"(403) … Forbidden"**. HeadObject transfers no data, so nothing is downloaded even if the deny were missing.
    - `aws kms decrypt` of the stored data key (from the latest `backup_permission_checks` row) → expect **AccessDeniedException**.
    - `aws kms schedule-key-deletion --pending-window-in-days 7` → expect **AccessDeniedException**. If it ever succeeds, run `cancel-key-deletion` and then `enable-key` at once, and stop: cancelling leaves the key Disabled.
    - `aws kms disable-key`, then `aws kms enable-key` straight away → expect the **immediate alert email** within minutes.
    - `aws s3api put-bucket-versioning … Status=Enabled` → expect **AccessDenied** and an **immediate alert email**. CloudTrail records denied calls too; if no email arrives, the lead investigates before go-live.
    - `aws cloudwatch set-alarm-state --alarm-name cadenzpoint-backup-dlq --state-value ALARM --state-reason test` → expect an alarm email.
11. **Switch to production:** replace the first two SSM parameters with **production's** values. The next scheduled runs back up production into its own `<cp>` prefix. Staging's rehearsal backups expire on their own.
12. **Vercel:** set `BACKUPS_EXPECTED=1` in production (staging stays `0`) **only after** production's first backup and audit have run: confirm in the ECS console that both tasks stopped with exit code 0, and that the backup's log shows a `BACKUP … control-plane …` line. Then redeploy. The anchors in §6.9 also prevent a go-live burst of alerts.

## 13. Verification
1. `npx tsc --noEmit`, `npm run lint`, `npm run test`, `npm run test:tz`, `npm run db:safety`.
2. On the product owner's machine:
   1. `npm run db:migrate:cp`;
   2. `psql postgresql://bytime:bytime_dev@localhost:5432/bytime -c 'CREATE DATABASE bytime_rt_test'` (once);
   3. the memory-noted integration command, with `REQUIRE_PG16_TOOLS=1 BACKUP_PG_DUMP_BIN=/opt/homebrew/opt/postgresql@16/bin/pg_dump BACKUP_PG_RESTORE_BIN=/opt/homebrew/opt/postgresql@16/bin/pg_restore`.

   These use local throwaway test data only, never customer data.
3. `npm run backup:bundle`, then `docker build -f Dockerfile.backup .` and `docker run --rm <image> --self-check` (loads the whole bundle; prints pg 16 tools). If the dev's sandbox can't run Docker, the lead runs this (CI also does).
4. `cfn-lint ops/aws/*.yml` is clean (CI runs it; locally, `pipx install cfn-lint` first).
5. **Before merge, the lead checks a real Neon database's extensions**, read-only, on **staging**: `SELECT extname FROM pg_extension`. If anything besides `plpgsql` is present, the restore must handle it. Record the result in §4.8.
6. **The lead's checks file** (local, no AWS):
   - `--dry-run`;
   - the digest's Backups section through a local production server with `BACKUPS_EXPECTED` set to `1`, `0`, then unset;
   - the Privacy page sentence.
7. **Real AWS:** §12 steps 7–11, run with the founder once the accounts exist. 3b can be built, reviewed and merged before then (the §12 step 3 merge gate). The deploy workflow does nothing until `AWS_BACKUPS_ENABLED` is set. **Until go-live, the production digest shows "Backup monitoring is not configured" every day** (§6.9), a deliberate reminder; set `BACKUPS_EXPECTED=0` in production to quiet it until go-live if preferred. That shows the "off" line, which also counts as news on the production domain.

## 14. Hand-off rules (in addition to `BLUEPRINT-STANDARD.md` §3)
- Impact analysis first; stop for the lead's review.
- Never print or store a secret; no real account ids or ARNs committed (`<account id>` placeholders; the templates use `AWS::AccountId`).
- No real AWS or Neon in tests (the seams). Tests touch only marked rows and `test-lc-*` tenants.
- Stage files by name.

## 15. Pre-mortem log
**History:** v1–v4.1 went through two rounds and four confirmation passes; v4.1 was CLEAN (`78222b4`, §15 there). v5 keeps v4.1's reviewed backup core (§6.4) and replaces where jobs run, the encryption, the restore and retention handling.

**Round 1** (two fresh reviewers on v5: A on AWS, security and deploy; B on backup, restore and monitoring). **No HIGH; 7 + 9 MEDIUM (some found by both); about 22 LOW.** Fixed in v5.1:
- **The admin-read claim was overstated** (A1, B8). Invariant 3 is now honest. Deny `kms:ReEncrypt*`; deny `PutKeyPolicy` and bucket-policy/lifecycle changes except to `CfnExecRole`; immediate alerts on policy, role, trail and lifecycle changes outside the deploy role, and on hand-run tasks.
- **HEAD probes can't return AccessDenied** (A2, B3): 403 = denied; KMS `AccessDeniedException`; the CloudShell expectations corrected; fakes shaped like the real errors.
- **A stuck first deploy and same-commit re-runs** (A3): `RetainExceptOnCreate`; `deploy.sh` handles `ROLLBACK_COMPLETE` and reuses an existing tag.
- **The rehearsal stack couldn't work** (A4, B7): replaced by pointing the production stack at staging first (§6.10, §12).
- **npm supply chain in the deploy job** (A5): a multi-stage image with `npm ci --ignore-scripts` in the builder; a separate `build` job without OIDC; the `deploy` job runs no npm.
- **Customer values in stored errors** (A6, B4): `summarizeError` with an allow-list; U2 with real samples.
- **The merge gate contradiction** (A7): the environment verified by `curl` before the bootstrap stack; the workflow inert until `AWS_DEPLOY_ROLE_ARN` is set, which is set last.
- **13-week coverage could starve** (B1): due-date ordering and `N = max(1, ceil(E/13), overdue)`; 20-week simulations in U7.
- **The audit could drop a live test database** (B2): the audit's sweep takes the restore-test lock; `rt_` names carry seconds; `pg_stat_activity`.
- **Restore-test throughput** (B5): `RESTORE_TEST_CONCURRENCY`; "slow run" findings at 70% for both jobs.
- **A killed run stuck `running`** (B6): the next run closes it `abandoned`; the finding uses the latest run only.
- **A stale image** (B9): the path filter lists every bundle input, enforced by a metafile test; plain-SQL table access with explicit columns.
- **LOWs folded in:**
  - IAM grants in role policies and path-qualified deny ARNs (no cycle);
  - the topic policy for CloudWatch, and the alarm proof by `set-alarm-state`;
  - the SNS confirmation recovery, plus a daily subscription check;
  - exact stack ARNs, bootstrap roles outside the managed path, a permissions boundary;
  - an artifacts bucket for templates over 51,200 bytes;
  - masked account id and email in public logs;
  - four bootstrap outputs; `ENCRYPTION_KEY` from the password manager; admin bypass off;
  - the check window for the disable test;
  - the rotation cost;
  - esbuild `cjs` with `react-server` and a self-check;
  - the synchronous header check before pg_restore spawns;
  - S11's context case with a matching row;
  - CI's `bytime_rt_test` and the in-process host override;
  - `-pooler` refused;
  - the listing race (30 minutes; fall back to an older object with a row);
  - the extension check on staging;
  - the catch-up's `containerOverrides`;
  - the start check that tables exist, with deploy order;
  - Neon compute wake-ups in §9;
  - the path fix; the lock first in the audit;
  - `FAIL:stopped`; `test_run_id`;
  - `finished_at` on guard failures; `BACKUP_PG_RESTORE_BIN`;
  - a unique `s3_key`; distinct lock keys;
  - number-typed, order-free counts;
  - `backup-check-failed` resolved when the sync is off;
  - `initProcessEnabled`.
- **Raised to the product owner:** Q3 (the 25-hour IP-hash sentence versus backups).

**Round 2** (two fresh reviewers on v5.1). **A (AWS): 1 HIGH, 4 MEDIUM, 6 LOW. B (backup/restore): 1 MEDIUM, about 13 LOW.** Fixed in v5.2:
- **HIGH: the caller-exclusion alert rules never matched IAM-user or root callers.** `anything-but` doesn't match a missing `sessionIssuer`. Replaced by **one rule with no caller condition**, a fixed list of protection-changing events from anyone. The hand-run-task alert is dropped, and invariant 3 now says so honestly. A **daily drift check** of the bucket policy, lifecycle, key policy and alert rule is added (`backup-protection-drift`). The rule now covers EventBridge and SNS tampering.
- **MEDIUM: permission sets that couldn't deploy or run.** The permissions boundary is removed (it blocked ECR pulls and added risk). Exact grants for ECR pull, ValidateTemplate, `GetAuthorizationToken`, PassRole, the ECS service-linked role, the drift checks and create rollback.
- **MEDIUM: deploy.sh stuck states:** `REVIEW_IN_PROGRESS`, `UPDATE_ROLLBACK_FAILED`, `ROLLBACK_FAILED`/`DELETE_FAILED` handled. **The audit trail moved to the bootstrap stack** with a generated bucket name, so a main-stack rollback can't be blocked by log files, and no deploy can stop the trail.
- **MEDIUM: name-based OIDC wildcard.** The trust is now `StringEquals` on the exact legacy subject (the repo predates the immutable format). The founder guide warns never to rename or delete the account or repo.
- **MEDIUM: no slack in the 13-week rule.** A 12-week cycle with overdue at 11 weeks; due-date order within a run; a daily restore-test catch-up; the coverage alert at 13 weeks (the rule itself); U7 simulations with a lost Monday and a deadline cut.
- **LOWs folded in:**
  - fixed bootstrap role names, with a U6 equality check;
  - the trail's `DependsOn` and `SourceArn`;
  - artifact retention of 7 days;
  - complete environment checks (bypass, branch list);
  - the catch-up override verified from the 18:17 log;
  - the SSM refresh stated as a known exception;
  - SQLSTATE only from `err.code`, labels instead of message lines, a crash handler;
  - all locks on direct connections, a lock held through the sweep, the restore-test lock retried;
  - the failed-finding on the latest finished run;
  - go-live anchors and the `BACKUPS_EXPECTED` timing;
  - stale uploads at 4 days;
  - the catch-up includes tenants with no row today;
  - the test seams (target override, `afterCounts`, signal), the split `sha256`/`decrypt` cases, S19 for the untested transitions;
  - `<cp>` in keys and context;
  - the control-plane least-privilege risk stated (the tasks hold the same owner URL Vercel holds);
  - per-target slow findings;
  - outside-ECS refusal (constraint 2);
  - the 29-day remedy;
  - host compare after `toDirectConnectionUrl`;
  - dedup by role;
  - `esbuild` a direct devDependency;
  - the `cfn-lint` install note.

**Confirmation pass 1** (one fresh reviewer on v5.2): **1 MEDIUM, 10 LOW; no HIGH.** Fixed in v5.3:
- **MEDIUM: a migration during a long dump could freeze a workspace, or the app (control plane).** `migrate-all` now waits while a backup run holds its lock (up to 30 minutes, then refuses without changing anything). The lock constants are shared in `src/lib/tenant/backup-locks.ts`. The clock-based no-deploy window is retired. **Scope note for the product owner:** this touches `scripts/migrate-all.ts`, which v5.2 left unchanged. It changes no product behaviour (deploys may wait).
- **LOWs:**
  - the restore-test listing prefix includes `<cp>`;
  - the restore-test catch-up retries stopped, cut or locked-out runs, and every run row gets `finished_at`;
  - contradictions fixed (`StringEquals`, 13-week coverage, `ceil(E/12)`, `--self-check` allowed outside ECS);
  - step 9 waits 30 minutes before the restore test;
  - **deploy requests only when the bundle hash or the stack changes** (`bundle.sha256`, checked in CI);
  - account-identifying values moved to environment secrets, with an `AWS_BACKUPS_ENABLED` switch variable;
  - audit-missed at 26 h;
  - the drift check compares normalised statements;
  - IAM role-policy and trust changes on `cadenzpoint-backup-*` roles alert;
  - per-target deadlines as settings, with the right remedy;
  - wording fixes (§13.7, §4.3.4, §6.5);
  - `CfnExecRole` gets `kms:PutKeyPolicy`.

**Confirmation pass 2** (one fresh reviewer on v5.3): **4 MEDIUM, 10 LOW; no HIGH.** Fixed in v5.4:
- **MEDIUM: the restore-test project's region and version weren't enforced** (Neon defaults to us-east-2 and Postgres 18). The guard now requires a us-east-1 Neon host and Postgres 16. Every backup row records its database's region, and `backup-region` alerts on any workspace outside us-east-1.
- **MEDIUM: the monthly manual drill in `RESTORE.md` conflicts with constraint 1.** Raised as **Q4** (recommend retiring it).
- **MEDIUM: the `migrate-all` wait had no test.** It's now a seamed helper (`scripts/backup/lib/backup-wait.ts`) with S21. It's also redesigned as **two ordered locks**: migrate-all holds `MIGRATE_RUN_LOCK_KEY` and checks the backup lock through `pg_locks`, and the backup waits for a running migration. That closes the race where a backup started mid-migration.
- **MEDIUM: `backup-target-slow` couldn't be computed or cleared.** `target_deadline_ms` is stored on rows and runs, and the restore half only looks at results from the last 14 days.
- **LOWs:**
  - the Dockerfile runs the hashed `npm run backup:bundle`;
  - the bundle hash is an app constant, and the rows record the running image's hash (`backup-image-stale`, which also catches GitHub's 300-file `paths` limit);
  - `toDirectConnectionUrl` moved to `direct-url.ts`;
  - `bootstrap.yml` left out of the trigger, with its console update stated;
  - the drift check single-sourced, catching changed statements (S20);
  - the Scheduler role uses `family:*` ARNs (image deploys no longer email);
  - audit-missed at 12 h;
  - backup probes skipped when nothing was written;
  - "completed" defined for the restore-test catch-up, with S19 cases;
  - stale text fixed (`--self-check`, the deploy windows, F32, the trail bucket, "each run", stack parameters, step ranges);
  - the founder guide synced (the SSM exception, re-copying the Neon string, step order);
  - source-scan tests added to the blast radius;
  - **the `tenant-admin show` addition is dropped** (not required by §5, and it read production backup facts on the founder's Mac).

**Confirmation pass 3** (one fresh reviewer on v5.4): **3 MEDIUM, 10 LOW; no HIGH.** Fixed in v5.5, by simplifying where a fix had grown the design:
- **MEDIUM: Neon cell hostnames** (`…c-2.us-east-1…`) would fail the region guard and the `region` parse. One shared `parseNeonHost` handles them, with accept and refuse tests.
- **MEDIUM: the bundle hash couldn't match inside Docker** (a different tsconfig context), so `backup-image-stale` would never clear. **Removed:** the hash trigger, the constant, the column and the finding. Deploys trigger on the backup code's own files, kept complete by the U6 metafile test. The builder copies exact inputs and a dedicated tsconfig.
- **MEDIUM: the alert path could be silenced unseen.** The event list now covers rule, target, subscription and alarm changes. The IAM events are a separate rule, so the `roleName` condition can't block the others. The daily drift check compares rule patterns and targets, trail logging, the subscription's filter policy and the DLQ alarm. U6 runs sample events through a matcher.
- **LOWs:**
  - lock re-take, or no new targets;
  - `pg_locks` filtered by database and `objsubid`, and the no-deadlock argument restated;
  - crashed tests stay visible (`swept_test_dbs`, abandoned runs in 7 days);
  - "latest completed run" ordered by `finished_at`;
  - all backup alerts resolved when monitoring is off;
  - the key is never replaced, and decrypt accepts retained keys;
  - go-live confirmed from the ECS console;
  - lock-connection tests with `-pooler` URLs;
  - the DLQ alarm named, `notBreaching`;
  - restore-test task size parameters;
  - the audit environment listed;
  - the step 9 catch-up note;
  - step ranges.

## 16. LOW items carried (the dev implements; the audit verifies)
1. The restore test's backup choice uses S3 `LastModified`; the `BACKUP` line carries the slug.
2. The control plane runs outside the tenant concurrency pool; S1b fills every slot with hung tenants.
3. Migrations wait for a running backup (§6.4). Restore tests touch only the restore-test project, so they need no window. Separately, migrations set no `lock_timeout` (a later item).
4. Stated limitation (into the 3c brief): the catch-up doesn't re-dump the control plane, so its newest backup can lack the `ok` rows of tenants re-run that evening. 3c restores those with the `BACKUP` line's SHA-256.
5. The SSM parameter names are fixed in the task definitions; the runbook's "update SSM when a value changes" applies to all three.
6. **Stated risk:** the tasks hold the production control-plane owner URL (the same one Vercel holds), so a compromised task could change control-plane rows. A narrower Postgres role (SELECT on `tenants`, INSERT/UPDATE on the five tables) is a later hardening item, not built now.
