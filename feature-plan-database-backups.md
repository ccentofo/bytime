# Database backups (build queue 3b)

> **Status:** **DRAFT v5**, 2026-11-16, lead architect. A redesign to the revised `BUSINESS-DECISIONS.md` §5 (2026-11-16). Not yet reviewed.
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
   - `audit`: daily at 11:17 UTC. It records the oldest backup's age, the KMS key's state and any leftover test databases, and drops leftovers.
   - `restore-test`: weekly, Mondays at 08:17 UTC. It restores the control plane plus the workspaces tested longest ago into temporary databases, checks every row count, then drops them.
3. **Monitoring.**
   - The tasks write their results to control-plane tables, and the existing daily digest (Vercel, 13:00 UTC) reads them and raises alerts.
   - A KMS key deletion or disabling emails the founder **immediately**, straight from AWS.
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
| Q2 | **Staging backups.** | **None.** The staging rehearsal (§12.4) deploys a throwaway copy of the stack once to prove it end to end, then deletes it. | §6.10 |

**One-time founder actions this design needs.** These are flagged, not decided; the accounts guide `FOUNDER-ACCOUNTS-SETUP.md` gives each step in full. Everything else is created by code.
1. **AWS account** for backups only: root login with two hardware keys; the Paid plan; a backup card; an admin login for yourself (no access keys).
2. **Create the bootstrap stack once.** Upload `ops/aws/bootstrap.yml` in the AWS console and click Create. About ten minutes.
3. **Paste three secrets once** into AWS Parameter Store: the control-plane URL, `ENCRYPTION_KEY`, and the restore-test project's URL. AWS can't be given them any other way without GitHub holding them. You redo this only if one of them ever changes.
4. **Create one Neon project once**, `cadenzpoint-restore-tests`: us-east-1, Postgres 16, the shortest history setting. The weekly tests use it.
5. **GitHub:** create the `aws-backups` environment with yourself as the required reviewer (Q1), and set two variables.
6. **Confirm the AWS alert email** once, by clicking the link AWS sends.
7. **Vercel:** set `BACKUPS_EXPECTED=1` in production and `0` in staging.

**Design choices stated for the record** (engineering's call within §5):
- **Restore tests use one dedicated Neon project**, not a new project per test. Creating projects would need a Neon API key in AWS that could also delete every customer's project. With one project, the test only ever holds that project's connection, and it can't touch production.
- **Missed-run alert after 26 hours, and an 18:17 catch-up run.** §5's 36-hour rule alone only fires after two missed days.
- **Restore-test coverage alert:** if any workspace goes 14 weeks without a passing test, the digest says so. That checks §5's 13-week rule, with one week of slack.
- **Demo workspaces are backed up and tested** like any other.

## 3. Verified current state (`main` at `c416049`)

### 3.1 Databases
- **One Neon project per tenant**, created by `createNeonDatabase(slug)` (`src/lib/tenant/neon.ts:47-…`) with `pg_version: 16` and the region (`:63-74`).
- **Stored URLs use the pooled host.** `toDirectConnectionUrl` (`scripts/migrate-tenant.ts:18-30`) gives the direct host.
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
   - the SDK passes the encryption context to `GenerateDataKey`/`Decrypt` (source: kms-keyring helpers.ts), so `kms:EncryptionContext:purpose` conditions apply. That's confirmed from source, not the guide; **§12 step 10 proves it in AWS**.
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
   - The trust policy accepts **both** forms for `environment:aws-backups` (`StringLike`). The first deploy shows the actual claim in CloudTrail.
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
   - **silent: `DROP DATABASE … WITH (FORCE)`.** The test closes its own sessions first, then runs a plain `DROP DATABASE`, then `WITH (FORCE)` only if one is still open. Proven at §12.4.
2. **History window:**
   - **0 is allowed** and disables instant restore and time travel for the project;
   - expired history is removed automatically, and history is billed at $0.20/GB-month;
   - with 0, dropped test databases aren't kept (Neon API spec, `history_retention_seconds` minimum 0; neon.com/docs/introduction/history-window).
3. **Plans:**
   - Launch allows 100 projects, Scale 1,000 (soft);
   - storage is unlimited on paid plans, while Free allows 1 GB per project;
   - **new projects default to Postgres 18**, so the restore-test project must be set to 16 by hand (neon.com/docs/introduction/plans; Neon changelog 2026-06-05).
4. **Backups are read-only** (as v4.1 §4.4):
   - pg_dump and pg_restore 16 match the 16 servers; pg_restore 17 emits `SET transaction_timeout`, which 16 rejects;
   - `--snapshot` with `pg_export_snapshot()`;
   - `--lock-wait-timeout`;
   - the unpooled host;
   - transfer is 500 GB per project per month on Launch/Scale.

## 5. Invariants that must not break
1. **Customer data exists only in Neon us-east-1 and AWS us-east-1.** No job runs on GitHub's runners or on any personal machine. GitHub only starts deploys.
2. **The backup task can add backups, never read or delete them.** It holds `kms:GenerateDataKey` but not `kms:Decrypt`, and `s3:PutObject` but not `s3:GetObject` or `s3:DeleteObject`.
3. **Only the restore-test role (and 3c's disaster role) can decrypt or read backups.** The bucket policy and the key policy deny everyone else, the founder's admin login included. Undoing that takes a reviewed stack change, which CloudTrail logs.
4. **No long-lived access keys anywhere.** Tasks use roles; GitHub uses OIDC; the founder signs in with a hardware key.
5. **Versioning stays off.** The bucket policy denies `s3:PutBucketVersioning` to every principal.
6. **`ok` means every stage succeeded.** On failure the upload body is destroyed before it ends, so no partial object completes.
7. **Dumps are read-only.**
8. **`deleting` and `deleted` workspaces are never dumped**, with the status re-read per target.
9. **Restore tests write only to `rt_…` databases they create in the restore-test project**, and drop only names that match the pattern. They refuse a target URL whose database holds user tables.
10. **No secret is logged.** Errors are redacted; logs never contain URLs, hosts or passwords.
11. **Monitoring fails loudly.** A check that can't run is itself an alert.
12. **Tenancy:** a backup object is bound to its workspace by the encryption context (§6.5). A restore accepts it only for that workspace.

## 6. Design

### 6.1 AWS layout (`ops/aws/`)
Two CloudFormation templates in YAML. **Long-form functions only** (`Fn::Sub:`, not `!Sub`), so the tests parse them with a plain YAML parser (U6).

**`bootstrap.yml`**, stack `cadenzpoint-backup-bootstrap`, which the founder creates once in the console:

| Resource | Notes |
|---|---|
| `AWS::IAM::OIDCProvider` | `token.actions.githubusercontent.com`, audience `sts.amazonaws.com` |
| `DeployRole` | Trusted only by GitHub OIDC with `aud = sts.amazonaws.com` and `sub` `StringLike` either `repo:ccentofo/bytime:environment:aws-backups` or `repo:ccentofo@*/bytime@*:environment:aws-backups` (§4.6.1). The environment allows only `main` and needs the founder's approval. Policy: push to the one ECR repo; create, update and describe the stack `cadenzpoint-backup` and its change sets; `iam:PassRole` on `CfnExecRole` only. Max session 1 h. |
| `CfnExecRole` | Assumable only by `cloudformation.amazonaws.com`. Rights to create the main stack's resource types. Honest scope: it can manage IAM roles under the path `/cadenzpoint-backup/`, so a deploy can change who reads backups. That's why deploys need the founder's approval (Q1). |
| `AWS::ECR::Repository` `cadenzpoint-backup` | Immutable tags; scan on push; a lifecycle rule that keeps the last 20 images. |
| Outputs | `DeployRoleArn`, `RepositoryUri` |

**`backup-stack.yml`**, stack `cadenzpoint-backup`, deployed by the workflow (§6.2). Parameters: `ImageUri` (`…@sha256:<digest>`), `AlertEmail`, `MonthlyBudgetUsd` (default 10).

| Resource | Notes |
|---|---|
| **KMS key** `BackupKey` | Symmetric; `PendingWindowInDays: 30`; `EnableKeyRotation: true`; `DeletionPolicy`/`UpdateReplacePolicy: Retain`; alias `alias/cadenzpoint-backup`. **Key policy:** (a) account root administers the key (the standard statement, so the key can never become unmanageable); (b) **Deny `kms:Decrypt`** to every principal whose `aws:PrincipalArn` isn't the restore-test task role (or 3c's role, added by 3c); (c) **Deny `kms:ScheduleKeyDeletion`** when `kms:ScheduleKeyDeletionPendingWindowInDays` is below 30 (§4.4); (d) the backup task role gets `kms:GenerateDataKey` only, with `kms:EncryptionContext:purpose = cadenzpoint-backup`; (e) the restore-test role gets `kms:Decrypt` with the same condition; (f) the audit role gets `kms:DescribeKey`. |
| **Bucket** `BackupBucket` | Name `cadenzpoint-backups-<account id>`; us-east-1; Block Public Access (all four); Object Ownership BucketOwnerEnforced; default encryption SSE-S3 (the client-side KMS layer sits on top); **no `VersioningConfiguration`**; `DeletionPolicy`/`UpdateReplacePolicy: Retain`. **Lifecycle:** `Expiration.Days: 25` on prefix `v1/`; `AbortIncompleteMultipartUpload.DaysAfterInitiation: 1`. |
| **Bucket policy** | Deny all when `aws:SecureTransport = false`. Deny `s3:PutObject` without `If-None-Match` (the conditional-write condition, §4.3). Deny `s3:PutBucketVersioning` and `s3:PutBucketObjectLockConfiguration` to all. Deny `s3:DeleteObject*` to all. Deny `s3:GetObject*` to every principal except the restore-test role (and 3c's role). |
| **VPC** | One VPC; two public subnets in two AZs; an internet gateway; **no NAT gateway** (it costs about $32/month); a security group allowing egress on 443 and 5432 only, and no ingress. Tasks get a public IP (§4.2). |
| **ECS cluster** `cadenzpoint-backup` | Fargate only; Container Insights off. |
| **Task definitions** | One per command family: `backup`, `audit`, `restore-test`. The same image with a different `Command`. `backup` and `restore-test`: 2 vCPU / 4 GiB; `audit`: 0.5 vCPU / 1 GiB. Linux/X86_64; ephemeral storage default (streaming, no temp files). Log driver `awslogs` to its own log group (retention 30 days). `StopTimeout: 120`. |
| **Execution roles** (one per family) | Pull the image; write logs; `ssm:GetParameters` **only on the parameters that family needs**: `backup` → control-plane URL and encryption key; `restore-test` → control-plane URL and restore-test URL; `audit` → control-plane URL and restore-test URL. |
| **Task roles** | **backup:** `s3:PutObject` on `BUCKET/v1/*`, `s3:AbortMultipartUpload`, `kms:GenerateDataKey` (key, with the context condition). **restore-test:** `s3:GetObject` on `BUCKET/v1/*`, `s3:ListBucket` with `s3:prefix` `v1/*`, `kms:Decrypt` (key, with the condition). **audit:** `s3:ListBucket` with `s3:prefix` `v1/*`, `s3:ListBucketMultipartUploads`, `s3:GetBucketVersioning`, `kms:DescribeKey`. |
| **Schedules** (`AWS::Scheduler::Schedule`, UTC, flexible window off) | `backup-daily` `cron(17 6 * * ? *)`; `backup-catchup` `cron(17 18 * * ? *)`, command `backup --if-missing-today`; `audit-daily` `cron(17 11 * * ? *)`; `restore-test-weekly` `cron(17 8 ? * MON *)`. `ScheduleExpressionTimezone: UTC`. Each targets ECS `RunTask` (Fargate, platform `LATEST`, the subnets, public IP enabled) with the task definition **pinned by revision ARN**. `RetryPolicy`: `MaximumRetryAttempts: 10`, `MaximumEventAgeInSeconds: 3600`. A `DeadLetterConfig` points to the SQS queue `cadenzpoint-backup-scheduler-dlq`. One Scheduler execution role, trusted by `scheduler.amazonaws.com` with `aws:SourceAccount`: `ecs:RunTask` on the three revision ARNs; `iam:PassRole` on their execution and task roles with `iam:PassedToService = ecs-tasks.amazonaws.com`; `ecs:TagResource` with `ecs:CreateAction = RunTask`; `sqs:SendMessage` on the DLQ. |
| **SSM parameters** | **Not created by the stack** (CloudFormation can't create SecureString parameters, §4.7). Their names are fixed: `/cadenzpoint/backup/control-plane-url`, `/cadenzpoint/backup/encryption-key`, `/cadenzpoint/backup/restore-test-url`. The founder creates them once. |
| **Alerting** | An SNS topic `cadenzpoint-backup-alerts` with an email subscription to `AlertEmail` (the founder confirms it once). An EventBridge rule on the default bus matching `detail-type: AWS API Call via CloudTrail`, `source: aws.kms`, `detail.eventName: [ScheduleKeyDeletion, DisableKey]`, for **any key** in the account (no key-id matching to get wrong). The target is the SNS topic, with a topic policy letting `events.amazonaws.com` publish. The Scheduler dead-letter queue gets a CloudWatch alarm (messages visible > 0) to the same topic. |
| **CloudTrail** | One multi-region trail of **all** management events, read and write (the first copy is free, §4.5). It's required for the KMS alarm rule and keeps every key use beyond the 90-day event history. It writes to a separate log bucket, `cadenzpoint-backup-trail-<account id>`, with expiry at 365 days. The logs hold no customer data. |
| **Budget** | `AWS::Budgets::Budget`, monthly cost `MonthlyBudgetUsd`; alerts at 80% actual and 100% forecast, to `AlertEmail`. |

### 6.2 Image and deploy (`Dockerfile.backup`, `.github/workflows/backup-deploy.yml`)
**Image:**
- base `node:22-bookworm-slim`, pinned by digest;
- `postgresql-client-16` from PGDG (the binaries at `/usr/lib/postgresql/16/bin/`);
- `ca-certificates`;
- the bundled commands at `/app/backup.mjs`, built with esbuild from `scripts/backup/main.ts` (`--platform=node --bundle --format=esm`, with `pg-native` excluded). No repo checkout, no dev dependencies, no `.env` file in the image;
- runs as a non-root user; the entrypoint is `node /app/backup.mjs`.

**Workflow:**
```yaml
name: Backup system deploy
on:
  push:
    branches: [main]
    paths: ['ops/aws/**', 'scripts/backup/**', 'src/lib/encryption.ts', 'scripts/migrate-tenant.ts',
            'Dockerfile.backup', 'package-lock.json', '.github/workflows/backup-deploy.yml']
  workflow_dispatch: {}
permissions: { contents: read }
concurrency: { group: backup-deploy, cancel-in-progress: false }
jobs:
  deploy:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-24.04
    environment: aws-backups          # Selected branches: main; required reviewer: the founder (Q1)
    timeout-minutes: 30
    permissions: { contents: read, id-token: write }
    steps:
      - uses: actions/checkout@<sha>
        with: { persist-credentials: false }
      - uses: aws-actions/configure-aws-credentials@<sha>
        with: { role-to-assume: '${{ vars.AWS_DEPLOY_ROLE_ARN }}', aws-region: us-east-1, role-duration-seconds: 3600 }
      - uses: aws-actions/amazon-ecr-login@<sha>
      - run: scripts/backup/deploy.sh      # build, push by SHA tag, read the digest, cloudformation deploy
        env:
          REPOSITORY_URI: ${{ vars.AWS_BACKUP_REPOSITORY_URI }}
          ALERT_EMAIL: ${{ vars.BACKUP_ALERT_EMAIL }}
          CFN_EXEC_ROLE_ARN: ${{ vars.AWS_CFN_EXEC_ROLE_ARN }}
```
- **`deploy.sh`** (`set -euo pipefail`):
  1. `docker build -f Dockerfile.backup -t "$REPOSITORY_URI:$GITHUB_SHA" .`, then push.
  2. Read the pushed digest with `aws ecr describe-images`.
  3. `aws cloudformation deploy --stack-name cadenzpoint-backup --template-file ops/aws/backup-stack.yml --role-arn "$CFN_EXEC_ROLE_ARN" --parameter-overrides ImageUri=<uri>@<digest> AlertEmail="$ALERT_EMAIL" --capabilities CAPABILITY_NAMED_IAM --no-fail-on-empty-changeset`.
  4. Print the stack outputs (no secrets exist in them).
- **The image runs only in AWS.** The build on GitHub's runner compiles code; it never connects to a database and holds no secrets.
- **Environment `aws-backups` must exist and be gated before this file reaches `main`** (§12 step 5). Otherwise GitHub creates it unprotected on the first run (§4.6.3). The job-level `if: github.ref == 'refs/heads/main'` is a second guard. It's still advisory, because a workflow edited on another branch could drop it. **The real gate is the environment's branch rule and the required reviewer.** Hence the merge gate.
- Actions pinned by SHA. `@aws-sdk/*` and `@aws-crypto/*` are imported only under `scripts/backup/` (U6).

### 6.3 Control-plane tables (one drizzle-kit migration `00NN_database_backups.sql`)
Append-only except where noted. Tests mark rows with `run_id` starting `test-`. Five tables, the last in §6.13.

**`database_backups`** (as v4.1):

| column | type / note |
|---|---|
| `id` | uuid PK |
| `tenant_id` | uuid null FK → `tenants.id` ON DELETE CASCADE (null = control plane) |
| `target` | `'tenant'` \| `'control-plane'` |
| `run_id` | varchar(80) |
| `status` | `'ok'` \| `'failed'` |
| `s3_key` | text null |
| `bytes` | bigint null |
| `sha256` | char(64) null (of the stored, encrypted object) |
| `row_counts` | jsonb null |
| `server_version`, `pg_dump_version` | varchar null |
| `error` | text null (redacted, ≤ 500) |
| `started_at`, `finished_at` | timestamptz |

Index `(tenant_id, status, finished_at DESC)`.

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
| `stale_uploads` | int (multipart uploads older than 2 days) |
| `kms_key_state` | varchar(40) (`Enabled`, `Disabled`, `PendingDeletion`, …, or `error`) |
| `leftover_test_dbs` | int (`rt_…` databases older than 1 h found, and dropped, by this run) |
| `errors` | text null (redacted; any check that couldn't run) |

**`restore_test_runs`** (**not** append-only: `finished_at`, `status` and `detail` are set once at the end):

| column | type / note |
|---|---|
| `id` | uuid PK |
| `run_id` | varchar(80) |
| `started_at` | timestamptz |
| `finished_at` | timestamptz null |
| `status` | `'running'` \| `'pass'` \| `'fail'` |
| `planned` | int (control plane + N workspaces) |
| `detail` | text null |

**`restore_test_results`** (one row per target tested):

| column | type / note |
|---|---|
| `id` | uuid PK |
| `run_id` | uuid FK → `restore_test_runs.id` |
| `target` | `'tenant'` \| `'control-plane'` |
| `tenant_id` | uuid null FK → `tenants.id` ON DELETE CASCADE |
| `backup_id` | uuid null FK → `database_backups.id` ON DELETE SET NULL |
| `s3_key` | text null |
| `backup_started_at` | timestamptz null |
| `result` | `PASS` \| `MISMATCH` \| `FAIL:<stage>` |
| `detail` | text null (redacted; for MISMATCH, the differing tables and counts) |
| `duration_ms` | int |
| `tested_at` | timestamptz |

Index `(tenant_id, tested_at DESC)`.

**`backup_permission_checks`** (one row per probe set; §6.13):

| column | type / note |
|---|---|
| `id` | uuid PK |
| `run_id` | varchar(80) |
| `role` | `'backup'` \| `'audit'` \| `'restore-test'` |
| `checked_at` | timestamptz |
| `ok` | boolean (every probe was refused as expected) |
| `detail` | jsonb (probe → `denied` \| `skipped` \| `ALLOWED` \| `error:<code>`; backup rows also hold `edk`) |

### 6.4 The backup command (`scripts/backup/backup.ts`; helpers in `scripts/backup/lib/`)
**The core is v4.1 §6.2**, which passed four review rounds:
- the barrier (all tenants, one retry round, then the control plane by T + 75 min at the latest);
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
- `BACKUP_CONCURRENCY` (default 3).

No dotenv is loaded in the container. For local `--dry-run` and tests it loads dotenv like its siblings.

**Run id:** `ecs-<YYYYMMDDTHHMMSSZ>-<rand6>`.

**One run at a time:**
- At start, take `pg_try_advisory_lock(<constant for backup>)` on a dedicated **direct** control-plane connection (pooled connections can't hold session locks), held for the whole run.
- If it isn't granted, log "another backup run is active" and exit 0. The catch-up then can't overlap a slow morning run.
- If that connection drops, the run continues; the unique keys make overlap harmless.

**Run deadline:** 6 hours. Then everything still running is killed and recorded `failed` (`run-deadline`), and the process exits 1. ECS has no runtime limit of its own (§4.2).

**Encryption (replaces `age`):** per §6.5. `pgDump.stdout` → `encryptStream` → the hashing `PassThrough` (SHA-256 and bytes; `{ end: false }`) → upload. The gate is unchanged: the hashing stream ends only after pg_dump closes with `(0, null)` **and** the encrypt stream has emitted `end` without error. Any failure: kill pg_dump, destroy the encrypt stream, `hashing.destroy(err)`, `upload.abort()`.

**Keys:**
- `v1/<target>/<id>/<YYYY>/<MM>/<DD>/<runId>-<rand8>.dump.enc`, where `<id>` is the tenant uuid or `control-plane`;
- the sidecar is the same key with `.manifest.json.enc`;
- the sidecar JSON is as in v4.1, plus `slug`, encrypted the same way with its own encryption context (`kind: 'manifest'`).

**The `BACKUP` line goes to the task log** (CloudWatch, kept 30 days): `BACKUP <target> <id> <slug> <runId> <key> <sha256> <bytes>`. 3c's disaster path can read it when the control plane is gone.

**Logging:** never URLs, hosts or passwords. Errors pass through `redact()` (v4.1 §6.3). Child processes get only `{ PATH, HOME, LANG, PGPASSWORD }`.

**Exit code:** 1 if any target is still failed. ECS records it; monitoring reads the rows.

### 6.5 Encryption format
- **The AWS Encryption SDK for JavaScript** (`@aws-crypto/client-node`), with a **KMS keyring** naming `BACKUP_KMS_KEY_ARN` only.
- **Algorithm suite:** the committing, **unsigned** suite `ALG_AES256_GCM_IV12_TAG16_HKDF_SHA512_COMMIT_KEY`. The commitment policy is `REQUIRE_ENCRYPT_REQUIRE_DECRYPT`. Unsigned, so decryption can stream and use `decryptUnsignedMessageStream`, which refuses signed messages (§4.3).
- **Frame length:** 64 KiB (the default is 4 KiB). `buildClient({ commitmentPolicy: REQUIRE_ENCRYPT_REQUIRE_DECRYPT, maxEncryptedDataKeys: 1 })`.
- **Decryption uses a strict KMS keyring** naming the key ARN, never a discovery keyring.
- **Encryption context** (authenticated, and sent to KMS):
  - `purpose: cadenzpoint-backup`, which the key policy requires;
  - `kind`: `dump` or `manifest`;
  - `target`: `tenant` or `control-plane`;
  - `id`: the tenant uuid or `control-plane`;
  - `key`: the S3 key without its suffix.
- **Decryption** checks that the message header's context matches exactly what the caller expects (`id` and `key` included) **before** any plaintext is used. That replaces v4.1's sidecar ownership check for the dump itself (invariant 12).
- **Integrity of the stored object:** SHA-256 of the ciphertext, kept in the row and in the `BACKUP` line.
- **Honest limit, as with `age`:** anyone with the backup role can create a validly encrypted object. The restore test therefore also requires the object's SHA-256 to match the control-plane row.

### 6.6 The audit command (`audit`, daily 11:17 UTC)
1. List `v1/` (paginated). Record:
   - `oldest_object_at` and `oldest_key`;
   - `objects_over_29_days` (by `LastModified`);
   - totals.
2. `GetBucketVersioning` → `versioning_status`. `ListMultipartUploads` → `stale_uploads` (older than 2 days).
3. `DescribeKey` → `kms_key_state`.
4. **Leftover test databases:**
   - connect to the restore-test URL (the guard in §6.7 step 1);
   - list databases matching `^rt_[0-9]{8}_[a-z0-9]{8}$`;
   - drop each one older than 1 hour (from the name's date, and `pg_stat_database` activity: none);
   - count them in `leftover_test_dbs`.

   A dropped leftover still alerts once, so a crashing restore test can't hide.
5. **Each check is isolated.** One that fails writes `error` into its column and its message into `errors`, and the row is still inserted.
6. Take the advisory lock for `audit`; exit 0 if it's held.

### 6.7 The restore-test command (`restore-test`, weekly, Mondays 08:17 UTC)
1. **Guards:**
   - take the `restore-test` advisory lock;
   - the restore-test URL's host must differ from the control plane's;
   - its database must have **no user tables**, so a production URL pasted by mistake is refused.
2. **Sweep:** drop leftover `rt_…` databases older than 1 hour (as §6.6 step 4).
3. **Insert the `restore_test_runs` row** (`running`, `planned`).
4. **Choose the targets:**
   - the control plane;
   - plus `N = max(1, ceil(E / 13))` workspaces, where **E** = workspaces in `active`, `suspended` or `provisioning` with a URL, and an `ok` backup in the last 36 h. If E = 0, test the control plane only.
   - Order:
     1. workspaces whose latest result isn't PASS;
     2. then never tested;
     3. then by oldest `tested_at`;
     4. ties broken at random.
5. **For each target, in order** (concurrency 1, a 2-hour deadline per target):
   1. **Pick the backup by listing**, as 3c will in a disaster: the newest `.dump.enc` under `v1/<target>/<id>/` (by `LastModified`) that has a sidecar. Then find its `database_backups` row by `s3_key`, which must be `ok`. No row: `FAIL:no-row`.
   2. **Create** `rt_<YYYYMMDD>_<rand8>` in the restore-test project.
   3. **Stream** `GetObject` → hashing (SHA-256) → `decryptUnsignedMessageStream` (context checked on the header) → `pg_restore --no-owner --no-acl --exit-on-error --single-transaction --dbname=<rt db>` (pg 16, minimal env). Success means:
      - decryption ended without error;
      - pg_restore closed `(0, null)`;
      - the SHA-256 equals the row's.
   4. **Sidecar:** decrypt it (context `kind: manifest` and the same `id`/`key`). It must equal the row on `sha256` and `row_counts`.
   5. **Counts:** exact `count(*)` of every base table in the restored database. The table set and every count must equal the row's `row_counts`, giving PASS or MISMATCH (with the differences in `detail`).
   6. **`finally`:** kill pg_restore if it's running, close this run's connections to the database, then `DROP DATABASE IF EXISTS <name>` (name checked by the regex). Use `WITH (FORCE)` only if that fails because sessions remain (§4.8.1). A failed drop is logged, and the next audit or test drops it and alerts.
   7. **Insert** the `restore_test_results` row.
6. **Finish:** set the run row to `pass` (every result PASS) or `fail`, with `finished_at`. SIGTERM (ECS stop) runs the same `finally` path within `StopTimeout`.
7. **Run deadline:** 6 hours. Targets not reached are recorded `FAIL:not-reached`.

**Stages for `FAIL:<stage>`:** `list`, `no-row`, `create-db`, `download`, `decrypt`, `context`, `sha256`, `pg_restore`, `sidecar`, `count`, `deadline`, `not-reached`.

### 6.8 Retention
- The lifecycle rule expires objects at creation + 25 days, rounded to midnight UTC (§4.3). AWS then deletes them asynchronously.
- The audit alerts if anything is older than 29 days. **Nobody deletes by hand**, and nothing has delete rights (invariant 5 and the bucket policy).
- Deleted workspaces: backups stop at `deleting`, re-read per target. Their last backups expire within the rule.
- `BACKUP_RETENTION_DAYS` stays 30.
- `TENANT-DELETION.md` gains one paragraph: "Backups in S3 expire automatically within 30 days; nothing to do."

### 6.9 Monitoring
**`BACKUPS_EXPECTED` (Vercel env), as v4.1:**
- `1`: the sync runs;
- `0`: off, and the digest says so. On the production domain that line counts as news;
- anything else in production: "not configured", counted as news;
- local development: silent.

**Module `src/lib/tenant/backup-status.ts`** (server-only):
- `readBackupFacts(now, filter?)`;
- the pure `backupFindings(facts, now)`;
- `syncBackupAlerts(now, filter?)`.

It runs as an isolated step in `tenant-lifecycle/route.ts`, after `runLifecycleCron` and before signup maintenance. On a throw, it raises the global `backup-check-failed` (best effort); a successful sync resolves it.

| Finding | Condition (checked at 13:00 UTC) | Alert (scope / dedup) |
|---|---|---|
| missed backup run | no control-plane `ok` in 26 h | `backup-missed-run` (global) |
| stale workspace | a URL, created over 36 h ago, newest `ok` missing or older than 36 h | `backup-stale` (tenant) |
| failed backup | the target's newest row is `failed` | `backup-failed` (tenant, or global / `control-plane`) |
| audit missed | no `backup_audits` row in 30 h | `backup-audit-missed` (global) |
| old backups | latest audit `objects_over_29_days > 0` | `backup-old-objects` (global) |
| bucket drift | latest audit: versioning not `''`, or `stale_uploads > 0` | `backup-bucket-drift` (global) |
| key not enabled | latest audit `kms_key_state` isn't `Enabled` | `backup-key-state` (global) |
| audit check failed | latest audit `errors` not null | `backup-audit-error` (global) |
| restore test missed | no finished run in 8 days, anchored to the first control-plane `ok` (no alert before that + 8 days) | `restore-test-missed` (global) |
| restore test failed | the latest finished run is `fail`, **or** a run is `running` for more than 12 h | `restore-test-failed` (global; detail lists the failed targets by slug) |
| test databases left behind | latest audit `leftover_test_dbs > 0` | `restore-test-leftover` (global) |
| permission drift | per role: the latest `backup_permission_checks.ok` is false, or no row in 8 days after the role's first | `backup-permission-drift` (global; detail names the role and probe) |
| coverage | an eligible workspace whose first `ok` is over 14 weeks old, with no PASS in 14 weeks | `restore-test-coverage` (tenant) |

- **The state table is this table:** raised while true, resolved the first sync it's false. Tenant findings for workspaces no longer `provisioning`/`active`/`suspended` are resolved.
- **Digest section "Backups"** (try/catch; all `esc()`d):
  - "N of M workspaces backed up in the last 26 h. Newest control-plane backup: <time>."
  - "Last restore test <date>: <pass/fail>, control plane + K workspaces."
  - the off / not-configured line, or "Backup status could not be read: <redacted>" (counts as news).
  
  Findings appear under "Unresolved alerts", not twice.
- **Immediate (AWS → email), not via the digest:** a KMS `ScheduleKeyDeletion` or `DisableKey`; messages in the Scheduler dead-letter queue (a schedule that couldn't start its task). The audit's `kms_key_state` puts the same fact into the digest the next day.

### 6.10 Staging and local
- **Staging:** `BACKUPS_EXPECTED=0`; no stack. The one-time rehearsal (§12.4) deploys a throwaway stack named `cadenzpoint-backup-rehearsal` in the same AWS account, against staging, then deletes it.
- **Local:** `npm run backup:local -- backup --dry-run` (targets and server versions; no AWS). The commands' cores are tested with fakes (§11).

### 6.11 The Privacy page
- `src/app/privacy/page.tsx:43-44`: replace "Deleted data may remain in backups for up to 30 days." with the §3 (A2) sentence: "Backups expire automatically within 30 days of being made and are then permanently deleted by our storage provider."
- Update the pin in `legal-pages.test.tsx:28`.
- Nothing else on the page changes. AWS is already listed as a provider (`:52`).

### 6.13 Permission probes (invariants 2 and 3, checked automatically)
Each task, at the end of its run, tries the actions its role must **not** have and records what AWS said. Probes never touch real data: they use non-existent keys or harmless forms.

| Role | Probes (each must return AccessDenied) |
|---|---|
| backup | `HeadObject` on its own just-written key (needs `s3:GetObject`); `DeleteObject` on `v1/probe/does-not-exist`; `kms:Decrypt` of this run's encrypted data key; a `PutObject` **without** `If-None-Match` to `v1/probe/<runId>` |
| audit | `HeadObject` on `oldest_key`; `kms:Decrypt` of the newest stored data key; `DeleteObject` (non-existent key) |
| restore-test | `DeleteObject` (non-existent key); `PutObject` with `If-None-Match` to `v1/probe/<runId>` |

- **The Decrypt probes use a real encrypted data key.** A dummy blob might be rejected as invalid before the deny is evaluated. The backup task takes the encrypted data key (and context) from the header of its first object this run, probes with it, and stores it base64 in its row's `detail.edk`. That's safe to store: it's useless without `kms:Decrypt`. The audit probes with the newest stored `edk`, and skips that probe (`skipped`, still `ok`) if there's none yet.
- **The audit's HeadObject** uses `oldest_key`, and is `skipped` when the bucket is empty. The audit role can list, so a missing key would answer NotFound rather than AccessDenied.
- **`denied`** means an AccessDenied error code. Any success is `ALLOWED`, and any other error is `error:<code>`; both make `ok = false`.
- If the backup role's unconditional PUT ever succeeds, the object `v1/probe/<runId>` expires within 25 days like any other.
- The digest finding `backup-permission-drift` (global) fires when a role's latest row has `ok = false`, or when there's no row for that role in 8 days (after its first run).
- That turns "the backup job can't read or delete" from a one-time check into a daily one.

### 6.12 Removed from v4.1
- `age`, `ops/backup-recipient.txt`, `db:restore`, the founder drill and `--s3-only` drills;
- `restore_copies`, `register-restore-copy`, `restore-copy-destroyed`, and the `tenant:delete` copy refusal;
- `backup_drills`;
- `--list-old` and manual deletion;
- the `db-backup.yml` workflow and the GitHub-hosted jobs.

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
| (run) | advisory lock held | exit 0 | log line only |
| (run, catch-up) | today's control-plane `ok` exists and no tenant failed today | exit 0 | none |

### 7.2 One restore-test target

| State | Event | Next | Side effects |
|---|---|---|---|
| chosen | no sidecar-backed object under the prefix | done `FAIL:list` | result row |
| chosen | no `ok` row for the key | done `FAIL:no-row` | result row |
| chosen | `CREATE DATABASE` fails | done `FAIL:create-db` | result row |
| restoring | GetObject or stream error | `FAIL:download` | kill pg_restore; drop the db; result row |
| restoring | header context differs | `FAIL:context` | same, before any plaintext reaches pg_restore |
| restoring | decryption fails mid-stream | `FAIL:decrypt` | same |
| restoring | pg_restore non-zero | `FAIL:pg_restore` | same |
| restoring | SHA-256 differs from the row | `FAIL:sha256` | drop; result row |
| restored | sidecar differs or won't decrypt | `FAIL:sidecar` | drop; result row |
| restored | table set or a count differs | MISMATCH | drop; result row with the differences |
| restored | all equal | PASS | drop; result row |
| any | 2-hour deadline | `FAIL:deadline` | kill; drop; result row |
| any | drop fails | (result unchanged) | logged; the next audit drops it and alerts |

### 7.3 One restore-test run

| State | Event | Next | Side effects |
|---|---|---|---|
| — | lock held, or a guard fails | exit (1 for a guard, 0 for the lock) | a guard failure inserts a `fail` run with the reason |
| — | start | running | sweep; run row |
| running | every target done, all PASS | pass | `finished_at` |
| running | any target not PASS | fail | `finished_at`; `restore-test-failed` at the next digest |
| running | 6 h run deadline | fail | remaining targets `FAIL:not-reached` |
| running | task killed without `finally` | stays `running` | after 12 h, `restore-test-failed`; the next run sweeps the databases |

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
| F9 | Someone enables versioning | The bucket policy denies it. If it's ever changed through the stack, the audit records it and alerts. |
| F10 | A deploy changes who can read backups | Needs the founder's approval (Q1); CloudTrail logs the change. |
| F11 | The backup role leaks | It can only add objects: no read, delete or overwrite. Junk expires in 25 days; the budget alerts on abuse. |
| F12 | The restore-test role leaks | It can read and decrypt backups. It's reachable only by the ECS task; there are no keys to leak. Stated plainly. |
| F13 | `ENCRYPTION_KEY` or the control-plane URL in SSM is wrong or stale (rotated in Vercel, not in AWS) | Every workspace fails, or the run fails; alerts the same day. The runbook names the SSM update. |
| F14 | A restore test leaves a database behind | The audit drops it within a day and alerts; the next test sweeps it. |
| F15 | Restore-test URL points at production by mistake | Refused: same host as the control plane, or user tables present (§6.7 step 1). |
| F16 | Restore-test Neon project deleted or suspended | `FAIL:create-db`; `restore-test-failed`; the audit records `errors`. |
| F17 | Overlapping runs | Advisory locks; unique keys. |
| F18 | A backup run past 6 h (growth) | The run deadline records the unreached targets; alerts. Fix: raise `BACKUP_CONCURRENCY`, or split into batches (a config change, §9). |
| F19 | Old objects (AWS's deletion is late) | `backup-old-objects` at 29 days, a safety net. Within the 30-day promise in all normal cases (§4.3). |
| F20 | Monitoring misconfigured | Off / not-configured lines; `backup-check-failed`. |
| F21 | The alert email never confirmed | The Scheduler and KMS emails don't arrive, but the digest still covers the same facts by the next day. The §12 checklist includes the confirmation, verified by a test publish. |
| F22 | Migration lock during a dump | `--lock-wait-timeout=60s` fails the target, and the retry round retries. No deploys 06:00–08:30 and 18:00–20:30 UTC. |
| F23 | AWS account suspended for an unpaid bill | Every task stops; alerts at 13:00. Mitigations: the Paid plan, a backup card, the budget alert. |
| F24 | A wrong workspace's backup restored | The encryption context's `id` and `key` must match, checked before any plaintext is used. |
| F25 | The environment auto-created unprotected | §12 order (create and gate first, a merge gate); the job-level `if`. Until the environment exists and is gated, a run from another branch could assume the deploy role, so the bootstrap stack is created **after** the environment (§12 steps 3 and 5 swap: environment first). |
| F27 | AWS retires a running task for maintenance (§4.2.3) | SIGTERM: targets recorded `failed` `stopped` within `StopTimeout`. A backup run's catch-up re-runs it that evening; a restore test is caught by `restore-test-failed` and runs again next week. |
| F26 | Deploy fails halfway | CloudFormation rolls back to the previous stack; the old task definitions keep running. |

## 9. Platform limits
- **ECS Fargate:** no runtime limit (the 6-hour run deadline is ours). 2 vCPU / 4 GiB. Streaming, so dumps never touch disk. lib-storage buffers about (queueSize + 1) × 64 MiB per upload: about 576 MiB at concurrency 3, inside 4 GiB.
- **Scale:**
  - one run backs up E workspaces at `BACKUP_CONCURRENCY` at a time;
  - when a run approaches the deadline, raise the concurrency (and the task size), or add a second schedule that takes half the workspaces (`--shard 1/2`, a later config change, not built now);
  - restore tests grow with `ceil(E/13)` per week.
- **Neon:**
  - backups use transfer of about the uncompressed size per day per project (500 GB/project/month on Launch/Scale);
  - the restore-test project: storage only while a test runs; compute about the restore time once a week.
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
| `Dockerfile.backup`, `.dockerignore` (if missing) | **new** |
| `.github/workflows/backup-deploy.yml` | **new** |
| `.github/workflows/ci.yml` | the integration job on `ubuntu-24.04` installs `postgresql-client-16` and sets `REQUIRE_PG16_TOOLS=1` plus `BACKUP_PG_DUMP_BIN`/`BACKUP_PG_RESTORE_BIN`; a new step runs `cfn-lint ops/aws/*.yml` |
| `src/lib/tenant/backup-status.ts` | **new** |
| `src/app/api/cron/tenant-lifecycle/route.ts` | the isolated backup step |
| `src/lib/tenant/ops-digest.ts` | the Backups section |
| `scripts/tenant-admin.ts`, `src/lib/tenant/admin-commands.ts` | `show` lists the newest backup and the latest restore-test result for the workspace |
| `src/app/privacy/page.tsx`, `src/__tests__/unit/legal-pages.test.tsx` | the §6.11 sentence |
| `package.json` | scripts `backup:local`, `backup:build`; dependencies `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, `@aws-sdk/client-kms`, `@aws-crypto/client-node` (bundled into the image only); devDependency `yaml` |
| `.env.example` | `BACKUPS_EXPECTED` |
| Tests | `signup-ops.test.tsx:171-189` (mock `backup-status`, the order); `ops-digest-alerts.test.ts` (stub the new queries; the all-quiet text); `tenant-notices.test.ts:272`, `seat-sync.test.ts:308` (`BACKUPS_EXPECTED` unset, so no section) |
| `RESTORE.md` | a "Backups beyond Neon" section: what runs, where results show, and that a lost project or account is item 3c's button (until 3c, contact the lead) |
| `TENANT-DELETION.md` | the S3 paragraph (§6.8) |
| `PRODUCTION-DEPLOY.md` | new Phase "Backups (AWS)" (§12); Phase 15 row; Operations (what the digest shows); env table `BACKUPS_EXPECTED`; the no-deploy windows; "if `ENCRYPTION_KEY` or the control-plane URL changes, update SSM" |

### 10.2 Checked, unchanged
- app request paths; `migrate-all.ts`; `deploy-prod.yml`;
- `checkFounderExports`, `tenant-export.ts`, `delete-tenant.ts` founder exports (3d);
- the business drafts' Terms §9.3 / Privacy §7 (the business side applies §3 (B)).

## 11. Required tests (each must fail without the change it proves)
**Without AWS.** The commands use seams:
- `BackupStore` (put) and `BackupReader` (list, get), faked in memory;
- `KeyringFactory`, which in tests returns the Encryption SDK's **raw AES keyring**, so the real streaming encryption code runs;
- `KeyInfo` (DescribeKey) and the clock, faked.

**Restore tests** run against the local Postgres server as the "restore-test project" (`CREATE DATABASE rt_…` locally). pg 16 `pg_dump`/`pg_restore` via `BACKUP_PG_*_BIN`; with `REQUIRE_PG16_TOOLS=1` (CI and §13) a missing or wrong tool **fails** instead of skipping.

**Isolation:** `test-lc-*` tenants, `test-` run ids, the filters, and cleanup of the four tables and the new global alert kinds. No test calls the whole route.

**Unit:**
- **U1:** keys and the sidecar key; run-id format.
- **U2:** `redact`; password split; the minimal child env; no URL or host in any log line (a capture test across a failing run).
- **U3:** `backupFindings`: every §6.9 row raised and cleared, plus a new workspace, null-URL provisioning, a workspace leaving active, the restore-test anchor (no alert in the first 8 days), the 12-hour `running` rule, and coverage at 14 weeks.
- **U4:** the end gate: the body ends only after pg_dump `(0,null)` **and** the encrypt `end`; any failure destroys it.
- **U5:** environment checks: empty values, a non-hex key, a wrong pg_dump version.
- **U6:** static checks on the templates and the workflow:
  - **the backup task role has no `s3:GetObject`, `s3:DeleteObject*` or `kms:Decrypt`;**
  - the audit role has neither of the latter two;
  - the key policy denies Decrypt to all but the restore role, and denies a deletion window under 30;
  - the bucket policy denies versioning, deletes, Gets (except the restore role) and PUTs without If-None-Match;
  - the bucket has no `VersioningConfiguration` and has the 25-day rule;
  - Retain on the bucket and key;
  - no NAT gateway;
  - every schedule pins a revision;
  - the workflow pins SHAs, has the job `if`, `id-token` at job level only, `persist-credentials: false`, and environment `aws-backups`;
  - no long-form violation (`!Ref`) in the templates;
  - no `src/` import of `@aws-sdk/*` or `@aws-crypto/*`.
- **U7:** restore-test target choice: `N = max(1, ceil(E/13))` at E = 0, 1, 13, 14, 27; the ordering (not-PASS first, never tested, oldest, random ties).
- **U8:** count comparison: a missing table, an extra table, a differing count.
- **U9:** the digest Backups section: both summary lines, the `0` line, not-configured, silent in development, no duplication, `esc()`, "could not be read" in `hasNews`.
- **U10:** the route order with `vi.doMock`: the backup step runs between lifecycle and signup maintenance; a throwing step still lets the digest run and raises `backup-check-failed`.
- **U11:** the restore-test URL guard: same host refused; a database with user tables refused; the drop regex refuses `postgres`, `template1`, tenant-like names.

**Integration** (fake store and reader; raw AES keyring; real Postgres):
- **S1:** two `test-lc-*` tenants (one `suspended`) plus the control plane, with fake pg_dump:
  - `ok` rows, sidecars, SHA-256 equal to the stored bytes, exact counts, `BACKUP` lines;
  - a `deleting` tenant skipped;
  - the control plane starts only after all tenant work, and includes this run's tenant rows.
- **S1b:** a hung tenant past the (shortened) T + 75 → the control plane still runs; the summary names the slug.
- **S2:** fake pg_dump exits 1 mid-stream → `failed`; the store never saw end-of-stream.
- **S2b:** a hanging pg_dump → killed at the (shortened) deadline → `failed` `deadline`.
- **S3:** the keyring throws (KMS denied) → every target `failed`; exit 1.
- **S4:** the store rejects 412 → retry with a new key → `ok`.
- **S5:** row insert fails → the `row-failed` line; exit 1.
- **S6:** **real pg_dump 16**, rows inserted and committed after the counts and before pg_dump → the restored counts equal the snapshot (fails without `--snapshot`).
- **S7:** connection error then ok; two errors → failed; a count-query error before the pipeline → failed with no hang (10 s test timeout).
- **S8:** the advisory lock: a second run exits 0 with no rows.
- **S9:** `syncBackupAlerts(now, filter)` with `BACKUPS_EXPECTED=1`: every finding raised and resolved; `0` → nothing synced.
- **S10:** **the restore test end to end** with real pg_dump and pg_restore 16. Back up two test tenants and the control plane into the fake store (raw AES keyring), then run `restore-test` against the local server:
  - **PASS** for each;
  - no `rt_…` database remains;
  - the run and result rows are correct.
- **S11:** restore-test failures, each with no `rt_…` left behind:
  - a tampered object → `FAIL:sha256` (or `decrypt`);
  - another tenant's object placed under this tenant's prefix → `FAIL:context`;
  - a row with altered `row_counts` → MISMATCH with the difference in `detail`;
  - a forced pg_restore failure → `FAIL:pg_restore`;
  - a missing row → `FAIL:no-row`.
- **S12:** a wrong `ENCRYPTION_KEY` → tenants `failed`, the control plane `ok`.
- **S13:** `audit` with a fake reader and key info: the row's fields; one throwing check → `errors` set and the row still inserted; leftover `rt_…` databases older than 1 h dropped and counted, newer ones left alone.
- **S14:** `--if-missing-today`: no work when today is complete; only failed tenants; a full run when there's no control-plane `ok` today.
- **S16:** permission probes with a fake store and key client: all refused → `ok`; one allowed → `ok = false` with `ALLOWED` in `detail`; a non-AccessDenied error → `error:<code>`, `ok = false`. `backupFindings` raises `backup-permission-drift` for a false row and for a role with no row in 8 days.
- **S15:** SIGTERM during a restore test → the `rt_…` database dropped, and the result `FAIL:stopped`.

**Template proof beyond U6:** `cfn-lint` in CI (§10.1). Real AWS behaviour is proven at §12 steps 9–11 and in the rehearsal (§12.4).

## 12. Founder steps (PRODUCTION-DEPLOY, new Phase "Backups (AWS)"), **in this order**
`FOUNDER-ACCOUNTS-SETUP.md` has every click. This is the checklist.
1. **AWS account:** create it, register two hardware keys on root, upgrade to the Paid plan, add a backup card, set alternate contacts, create your admin login (security key, no access keys).
2. **Neon:** create `cadenzpoint-restore-tests` (us-east-1, Postgres 16, the shortest history window), and copy its direct connection string.
3. **GitHub, before the bootstrap stack exists** (so no run can assume the deploy role until the environment is gated):
   - create environment `aws-backups`: Selected branches → `main`; required reviewer → you; **leave "Prevent self-review" off** (you approve your own deploys);
   - add the variable `BACKUP_ALERT_EMAIL`; the other three come after step 4;
   - **merge this item only after this is confirmed** (merge gate).
4. **Bootstrap stack:** in the AWS console, CloudFormation → Create stack → upload `ops/aws/bootstrap.yml` → acknowledge IAM → Create. Copy the three outputs. Add them as the GitHub variables `AWS_DEPLOY_ROLE_ARN`, `AWS_CFN_EXEC_ROLE_ARN` and `AWS_BACKUP_REPOSITORY_URI`.
5. **SSM:** create the three SecureString parameters (§6.1).
6. **Merge and deploy the app** (the migration is applied by `deploy-prod`).
7. **First backup-system deploy:** it starts on the merge (or Actions → "Backup system deploy" → Run). Approve it. Expect a green run.
8. **Confirm the alert email** (AWS sends it on the first deploy).
9. **First run by hand:** in ECS, run the `backup` task once (the runbook gives the exact console path), then `audit`, then `restore-test`. Expect `ok` rows, an audit row with `Enabled`, and a `pass` run.
10. **"Can't" checks.** The tasks' own checks are automatic (§6.13): expect three `backup_permission_checks` rows with `ok = true` after step 9. Then, **outside 06:00–08:30 and 18:00–20:30 UTC**, in **AWS CloudShell** (in the browser, inside AWS; signed in as `corey-admin`), paste the commands the lead gives you:
    - `aws s3api head-object` on a backup key → expect **AccessDenied**. HeadObject transfers no data, so nothing is downloaded even if the deny were missing.
    - `aws kms decrypt` of the stored data key (the lead gives the exact command from the latest `backup_permission_checks` row) → expect **AccessDenied**.
    - `aws kms schedule-key-deletion --pending-window-in-days 7` → expect **AccessDenied**. If it ever succeeds, run `cancel-key-deletion` and then `enable-key` at once, and stop: cancelling leaves the key Disabled.
    - `aws kms disable-key`, then `aws kms enable-key` straight away → expect the **immediate alert email** within a few minutes. That proves the alarm. The next audit shows `Enabled`.
11. **Vercel:** `BACKUPS_EXPECTED=1` in production and `0` in staging, then redeploy both. The next digest shows the Backups section.
12. **Business side:** nothing new (AWS is already a listed provider).

**12.4 Staging rehearsal (once, a production-readiness gate):**
1. Deploy `backup-stack.yml` as `cadenzpoint-backup-rehearsal`, with the staging SSM parameters under `/cadenzpoint/backup-rehearsal/…` (a stack parameter).
2. Run `backup --only <staging slug>`, `audit`, then `restore-test`. Expect PASS.
3. Delete the stack. Empty and delete its bucket. The key goes into its 30-day deletion, so expect the alert email: a second proof of the alarm.

## 13. Verification
1. `npx tsc --noEmit`, `npm run lint`, `npm run test`, `npm run test:tz`, `npm run db:safety`.
2. On the product owner's machine: `npm run db:migrate:cp`, then the memory-noted integration command with `REQUIRE_PG16_TOOLS=1 BACKUP_PG_DUMP_BIN=/opt/homebrew/opt/postgresql@16/bin/pg_dump BACKUP_PG_RESTORE_BIN=/opt/homebrew/opt/postgresql@16/bin/pg_restore`. These use local throwaway test data only, never customer data.
3. `docker build -f Dockerfile.backup .` succeeds, and `docker run … --version-check` prints pg_dump 16. If the dev's sandbox can't run Docker, the lead runs this.
4. `cfn-lint ops/aws/*.yml` is clean.
5. **The lead's checks file** (local, no AWS):
   - `--dry-run`;
   - the digest's Backups section through a local production server with `BACKUPS_EXPECTED` set to `1`, `0`, then unset;
   - the Privacy page sentence.
6. **Real AWS:** §12 steps 9–10 and the rehearsal §12.4, run with the founder once the accounts exist. **Until then, 3b can be built, reviewed and merged.** It reports nothing until `BACKUPS_EXPECTED=1`, so the merge is safe before AWS exists.

## 14. Hand-off rules (in addition to `BLUEPRINT-STANDARD.md` §3)
- Impact analysis first; stop for the lead's review.
- Never print or store a secret; no real account ids or ARNs committed (`<account id>` placeholders; the templates use `AWS::AccountId`).
- No real AWS or Neon in tests (the seams). Tests touch only marked rows and `test-lc-*` tenants.
- Stage files by name.

## 15. Pre-mortem log
**History:** v1–v4.1 went through two rounds and four confirmation passes; v4.1 was CLEAN (`78222b4`, §15 there). v5 keeps v4.1's reviewed backup core (§6.4) and replaces where jobs run, the encryption, restore and retention handling. **v5 needs its own rounds.**

## 16. LOW items carried from v4.1 (still apply)
1. The restore test's backup choice uses S3 `LastModified`; the `BACKUP` line carries the slug.
2. The control plane runs outside the tenant concurrency pool; S1b fills every slot with hung tenants.
3. The no-deploy windows are 06:00–08:30 and 18:00–20:30 UTC. Separately, migrations set no `lock_timeout` (a later item).
4. Stated limitation (into the 3c brief): the catch-up doesn't re-dump the control plane, so its newest backup can lack the `ok` rows of tenants re-run that evening. 3c restores those with the `BACKUP` line's SHA-256.
