# Blueprint 3d: Cloud export link (the F2 change)

> **Status: v1.0 DRAFT, not yet reviewed** (2026-11-18). Branch `cloud-export`, from `main` at `17ac1c8`. Follows `BLUEPRINT-STANDARD.md`.
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
6. **Expiry sweep and monitoring** (§6.7).
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
- **A1:** the policy-hold rule above.
- **A2:** expiry wording. Access ends at exactly 7 days, and the file is erased by a sweep within 12 hours after that, with S3's own expiry as the backstop (§6.7). BUSINESS-DECISIONS says "files … expire automatically within 7 days". Accept "access ends at 7 days; erased within 12 hours after", or ask the business session to word it.
- **A3:** the Privacy page lists AWS for "encrypted backups" only (`src/app/privacy/page.tsx:51`). Export copies are also stored there. A one-line wording change is needed; the business session supplies the sentence (as A2 in 3b).

**Founder duties:**
- **Setup (PRODUCTION-DEPLOY 13b/13d):**
  - deploy the updated `bootstrap.yml` (the Vercel OIDC provider and the exports bucket ARN in `CfnExecRole`);
  - set the Vercel env `EXPORT_DOWNLOAD_ROLE_ARN`, `EXPORT_BUCKET` and `AWS_REGION=us-east-1`;
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
2. **Only the export task writes the bucket.** The Vercel role may only `GetObject` under `delivery/`, through a 5-minute presign. Nothing is public, and every request is TLS-only.
3. **A link works only for its delivery, until its `expires_at` (created + 7 days),** and only while it isn't revoked. The token is 32 random bytes. The control plane stores its SHA-256 for lookup, plus an encrypted copy for the email.
4. **Recipients are fixed at export time and stored with the delivery:** the notice recipients, or for `policy_hold` the extra address only, plus the extra address when given. Nothing is sent to an address the founder didn't confirm.
5. **Logs and the public button log carry ids, never emails, slugs or tokens.** Inputs are masked first.
6. **Hold copies are never served by the download page** and never expire by themselves.
7. **The in-app self-export is unchanged.**

## 6. Design
### 6.1 Storage (`ops/aws/backup-stack.yml`, `bootstrap.yml`)
- **Bucket `cadenzpoint-exports-${AccountId}`:**
  - `RetainExceptOnCreate`; public access blocked; `BucketOwnerEnforced`; versioning denied;
  - **SSE-KMS** with a new key `ExportKey` (alias `alias/cadenzpoint-exports`), with `BucketKeyEnabled`;
  - **lifecycle:**
    - rule `expire-delivery`: prefix `delivery/`, `Expiration: 7` days (the backstop);
    - rule `abort-mpu`: `AbortIncompleteMultipartUpload: 1`;
    - **no rule for `hold/`**.
- **Bucket policy** (Deny statements only, the backup bucket's pattern):
  - `DenyInsecureTransport`;
  - `DenyVersioningAndObjectLock`;
  - `DenyWritesExceptExportTask` (Put/Delete/Abort);
  - `DenyReadsExceptExportRoles` (`GetObject` only for the export task role, plus the download role under `delivery/*`);
  - `DenyPolicyAndLifecycleChangesExceptDeploy`.
- **`ExportKey` policy:** encrypt and decrypt for the export task role. Decrypt for the download role **only via S3** (`kms:ViaService = s3.us-east-1.amazonaws.com`, with the encryption-context bucket ARN). Deny key deletion and disabling except via `CfnExecRole`, as the backup key.
- **`bootstrap.yml`** (deployed by hand at setup; 13b hasn't run yet):
  - `CfnExecRole`'s S3 statement gains `arn:aws:s3:::cadenzpoint-exports-${AccountId}`;
  - a new `AWS::IAM::OIDCProvider` for `https://oidc.vercel.com/<team>`.

  The team slug and Vercel project name are **template constants** (the FR1 lesson); the founder tells the dev both values, and they're committed.

### 6.2 Roles (`backup-stack.yml`, `expected-policies.ts`)
- **`ExportTaskRole`:**
  - S3 `PutObject`, `GetObject`, `DeleteObject`, `ListBucket` and `AbortMultipartUpload` on the exports bucket;
  - KMS on `ExportKey`;
  - SNS publish to the alert topic.
  - **No access to the backup bucket or key.**
- **`ExportExecRole`:** `ssm:GetParameters` for `control-plane-url`, `encryption-key` and `control-plane-backup-id`.
- **`ExportDownloadRole`:**
  - trusted by the Vercel OIDC provider, with `aud` = `https://vercel.com/<team>` and `sub` = `owner:<team>:project:<project>:environment:production` (exact `StringEquals`);
  - permissions: `s3:GetObject` on `arn:aws:s3:::cadenzpoint-exports-${AccountId}/delivery/*`, plus `kms:Decrypt` (via S3);
  - `MaxSessionDuration` 3600.
- **`DisasterButtonRole`'s RunTask** gains the `cadenzpoint-backup-export` family. It's the same button environment (`aws-disaster`), with no new trust.
- **`expected-policies.ts`, the audit and U6:**
  - generalise from one bucket to a list: `BUCKETS = [backup, exports]`, each with its expected policy and lifecycle;
  - `ALL_ROLES` gains the three roles;
  - the audit's `protectionDrift` checks both buckets, so the audit role gains `GetBucketPolicy`/`GetLifecycleConfiguration`/`GetBucketEncryption` on the exports bucket.

### 6.3 The export task (`scripts/backup/export.ts`; image command `export`)
**Task definition `cadenzpoint-backup-export`:**
- 1 vCPU / 4 GB;
- secrets: `CONTROL_PLANE_DATABASE_URL`, `ENCRYPTION_KEY`;
- env: `EXPORT_BUCKET`, `ALERT_TOPIC_ARN`, `APP_ROOT_DOMAIN`;
- its own log group, `/cadenzpoint/backup/export` (365 days).

**Grammar** (`parseExportArgs`; an unknown flag exits 2):
- `export deliver --workspace <uuid> [--extra <email>] [--reason <text>] --run-id <id>`
- `export hold --workspace <uuid> --reason <text> --run-id <id>`
- `export release --hold <uuid> --reason <text> --run-id <id>`

**The start:**
- `startedBy` must be `gh-` or `cloudshell-`;
- ECS oldest-wins for the family;
- an advisory lock `EXPORT_LOCK_KEY` (a new constant beside 3c's) on the control plane;
- log `export <mode> run <runId> started by <x>`.

**`deliver`:**
1. **Load the tenant by id** under the tenant lock (read only):
   - its status must be `active` or `suspended`, with `db_url_encrypted` set. Otherwise refuse (`not-exportable`: deleted, deleting, provisioning, no database);
   - `policy_hold` (suspension reason `policy`) **requires** `--extra` (refuse `extra-required`).
2. **Recipients:**
   - for `policy_hold`: the extra address only;
   - otherwise D10: active admins from the workspace database, plus the billing email, plus the signup email when there's no active admin, plus `--extra` if given;
   - lowercased and deduplicated;
   - none → refuse `no-recipients`.
3. **Build:** `openExportSnapshot(decrypt(url))` → `createWorkspaceZipStream` → S3 multipart upload (`@aws-sdk/lib-storage` `Upload`, 8 MiB parts, `IfNoneMatch: '*'`), at key `delivery/<deliveryId>/<slug>-export-<yyyymmdd>.zip`, with SHA-256 computed while streaming.
   - **Failures:** the ZIP limits, a database error or an upload error → abort the upload, delete any object, result `failed`.
4. **Record, in one control-plane transaction:**
   - an `export_deliveries` row (§6.5);
   - a `tenant_notices` row (kind `export-ready`, `scheduled_for` = the delivery's `created_at`, status pending), as raw SQL like 3c's writes, with `enqueueNotice`'s column semantics;
   - a `tenant_audit_events` row `export-delivered` (detail: delivery id, recipient count, an extra-address flag, reason).
5. **Email the founder** (SNS): `export delivered: workspace <id>, delivery <id>, <n> recipient(s), expires <iso>`, ids only.

**`hold`:**
- steps 1 and 3, with key `hold/<holdId>/<slug>-export-<yyyymmdd>.zip`;
- then an `export_holds` row (id, tenant id, key, bytes, sha256, reason, created_at, `released_at` null);
- audit `export-held`; an SNS line.
- **No email to customers.**
- Allowed in every exportable status, including `policy_hold`, with no `--extra`.

**`release`:**
- load the hold; already released → refuse `released`;
- delete the object, then verify with a 404;
- set `released_at` and `release_reason`; audit `export-hold-released`.

**Exit codes:** pass 0; refusal or failure 1. Unknown-flag version skew 2, as 3c.

### 6.4 The Export workspace button (`.github/workflows/export-workspace.yml`, `scripts/backup/export-button.sh`)
- **Workflow:**
  - `workflow_dispatch`, inputs: `mode` (choice: `deliver`, `hold`, `release`), `target` (a workspace uuid, or a hold uuid for release), `extra_recipient` (optional), `reason` (optional, required for hold and release, and for deliver with an extra address), `confirm`;
  - `confirm` must equal `<mode>`, or `deliver with extra` when there's an extra address;
  - main only, `vars.AWS_BACKUPS_ENABLED`, environment `aws-disaster` (founder approval), `queue: max`, an `if: cancelled()` stop step.
- **The script follows 3c's button:**
  - inputs are read from the event file and **masked before anything prints** (target, extra address, reason);
  - single-line inputs only;
  - validation: a uuid; the email address against a strict pattern, at most 254 characters; the reason at most 200 characters, no control characters;
  - the stack output `ExportModes` gate;
  - one task at a time;
  - `run-task` with `--started-by gh-<run>-<attempt>`;
  - wait, then report the exit code.

  The reason is passed to the task as an argument; it's masked in the log, and the task logs only its length.

### 6.5 Delivery records and the `export-ready` notice
- **Table `export_deliveries`:**
  - columns: `id` uuid PK; `tenant_id` FK; `s3_key`; `bytes`; `sha256`; `token_hash` char(64) unique; `token_encrypted` text; `recipients_encrypted` text (a JSON array, `encrypt()`ed); `extra_recipient` boolean; `reason` text null; `created_at`; `expires_at`; `revoked_at` null; `erased_at` null; `download_count` int default 0; `last_download_at` null; `run_id`;
  - index `(tenant_id, created_at)`;
  - **table `export_holds`** as in §6.3;
  - one drizzle-kit control-plane migration.
- **`NoticeKind`** gains `export-ready`:
  - `isNoticeSuperseded('export-ready')` → **always false**, even for `deleting`/`deleted`, because an export taken before a deletion must still reach the customer;
  - `renderNotice` loads the delivery by `(tenant_id, created_at = anchor)` and returns the **stored recipients** (not D10 at send time);
  - the template `export-ready.tsx` (LifecycleLayout): "Your CadenzPoint workspace export is ready", the workspace name, the link `https://<APP_ROOT_DOMAIN>/export/<token>`, "works until <date and time, workspace time zone>", "If you didn't ask for this, contact support@cadenzpoint.com".
- **The link persists in the frozen payload** (`tenant_notices.payload`) until the row is pruned. That's accepted: the link stops working at `expires_at`, and the founder can revoke it (`tenant:admin export-revoke <delivery-id> --yes` sets `revoked_at`).

### 6.6 The download page (`src/app/export/[token]/page.tsx` plus a server action)
**The page:**
- **apex only:** on a workspace host it redirects to the apex, as `/signup/page.tsx` does;
- **GET:** look up `token_hash = sha256(token)` and render one of:
  - **valid:** "Workspace export for <workspace name> · <size> · works until <date>" and a **Prepare download** form (POST to self);
  - **expired, revoked or erased:** "This link has expired. Ask support@cadenzpoint.com for a new one";
  - **unknown:** the same text (no oracle).

  A GET never mints a URL, so email scanners fetch only the page.

**POST (the server action):**
- re-check the token (valid, not expired or revoked);
- rate-limit with the Upstash shared limiter, `export-download:<deliveryId>`, 20 per hour, and per IP 30 per hour;
- mint a **5-minute** presigned GET (`ResponseContentDisposition: attachment; filename="<file>"`) with `awsCredentialsProvider({ roleArn: EXPORT_DOWNLOAD_ROLE_ARN })`;
- increment `download_count` and set `last_download_at`;
- re-render the page with a plain **Download** link to that URL, "valid for 5 minutes". Navigation isn't governed by `form-action`.

**Headers:** `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and `X-Robots-Tag: noindex`.

**Packages:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` and `@vercel/oidc-aws-credentials-provider` move to runtime `dependencies`, all at exact versions. **U6's "no `@aws-sdk` in `src/`" rule** gains one allowed file, `src/lib/export/download-url.ts`, and that file is the only importer.

**Env:**
- `EXPORT_DOWNLOAD_ROLE_ARN`, `EXPORT_BUCKET` and `AWS_REGION=us-east-1` (production only);
- all three missing → the page says "downloads aren't available; contact support" and raises `export-download-misconfigured`.

### 6.7 The expiry sweep and monitoring
- **The sweep**, a new step in the backup command (06:17 and the 18:17 catch-up):
  - list `delivery/` and delete every object whose delivery has `expires_at <= now`, or that has no delivery row and is older than 7 days;
  - set `erased_at`;
  - **the maximum life is 7 days plus 12 hours;** lifecycle's 7-day rule is the backstop;
  - the backup task role gains `ListBucket`/`DeleteObject` on the exports bucket's `delivery/` prefix only.
- **Findings** (3b's monitoring; global alerts unless noted):
  - **`export-copy-overdue`:** a delivery object older than 8 days (from the backup task's list result, recorded as a `backup_permission_checks`-style probe row);
  - **`export-hold-open`:** in the **first digest of each month**, one line per open hold (id, workspace id, age, reason), raised as info and resolved when no holds are open;
  - **`export-download-misconfigured`** (§6.6);
  - **`export-task-failed`:** the run's SNS line covers it; no alert.
- **The digest line:** "Exports in the last 7 days: N delivered, M downloads; open holds: K".

### 6.8 Retiring the F2 local export
**Delete:**
- `scripts/tenant-export.ts` and its `package.json` script;
- `src/lib/export/founder-export-path.ts`;
- the `export-destroyed` command (`admin-commands.ts:285-296`, `tenant-admin.ts`);
- `ops-digest.ts`'s `checkFounderExports`;
- the receipt field `founderExportDestroyBy` and its print;
- the tests that pin them.

**Keep `BACKUP_RETENTION_DAYS`** only if another use exists; the dev checks, and removes it if there's none.

**The receipt** gains a line "Export copies: N delivered (expire automatically); M open hold(s)", and **`tenant:delete` refuses nothing new.** A hold survives the deletion by design (a legal exception, Terms §9.3).

**The export error messages** (`workspace-export.ts:19,293,307,311`) say "contact the lead" instead of naming `tenant:export`.

### 6.9 Docs
- **`TENANT-DELETION.md` "Final export"** is rewritten:
  - the button;
  - the policy-hold rule;
  - "take the export and wait for 'delivered' before running `tenant:delete`";
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
| `active` | `now >= expires_at` | `expired` | the page shows "expired"; no URL |
| `active` | `export-revoke` | `revoked` | audit `export-revoked` |
| `expired` or `revoked` | the sweep | `erased` | the object deleted; `erased_at` |
| `erased` | a page GET | `erased` | "expired" |

"Can't happen": `erased` → `active`. Nothing un-erases, and a new press creates a new delivery.

### 7.2 A hold
| State | Event | Next |
|---|---|---|
| — | `hold` passes | `open` (row, audit, SNS) |
| `open` | `release` | `released` (object deleted and verified; audit) |
| `open` | first digest of the month | `open` (listed) |
| `released` | `release` again | `released` (refused `released`) |

### 7.3 The export notice
`pending` → (cron) `sent`, with the D10 delivery machinery unchanged. It's **never superseded.** If the send fails, it retries as today. A delivery whose notice was never sent shows in the digest line as "not yet emailed".

## 8. Failure modes
| # | Situation | Behaviour |
|---|---|---|
| F1 | A workspace over the ZIP limits | `failed` with "too large for a single ZIP: contact the lead"; nothing stored |
| F2 | A database error mid-stream | the upload aborted, any object deleted, `failed` |
| F3 | The upload succeeds but recording fails | the object deleted (verified), `failed`. No row means no link |
| F4 | The task dies after upload, before recording | an orphan object under `delivery/` with no row → the sweep deletes it after 7 days; `export-copy-overdue` if not |
| F5 | The notice fails to send | retried by the cron; the digest shows "not yet emailed" |
| F6 | A workspace deleted before the email sends | the notice is still sent (never superseded) to the stored recipients; the download page doesn't need the workspace |
| F7 | A leaked link | it works until 7 days or until `export-revoke`; rate-limited; downloads counted |
| F8 | An email scanner prefetches the link | a GET only renders the page; no URL is minted |
| F9 | Vercel's OIDC role is misconfigured | the page shows the support text; `export-download-misconfigured` |
| F10 | Two presses at once | ECS oldest-wins plus the lock |
| F11 | A press for a `policy_hold` workspace without an extra address | refused `extra-required` |
| F12 | A typo in the extra address | the founder typed it twice (confirm includes "with extra"; the address is shown masked); a wrong address → revoke and press again |
| F13 | A release of a hold whose object is already gone | the delete is idempotent; a 404 verifies; it's released |

## 9. Platform limits
- **ZIP limit** ~3.94 GiB. Multipart with 8 MiB parts gives up to 505 parts, well under 10,000.
- **ECS** 1 vCPU / 4 GB. Streaming keeps memory bounded (`highWaterMark 0`, 5,000-row batches).
- **Vercel:** the page and action are light (one control-plane read and one presign).
- **S3 storage:** cents per GB-month for at most 7 days, plus holds.

## 10. Blast radius
- **Stack:** `ops/aws/backup-stack.yml` (bucket, key, roles, task, log group, `ExportModes` output, button RunTask) and `ops/aws/bootstrap.yml`.
- **`scripts/backup/`:**
  - `main.ts` (the `export` command);
  - `export.ts` and `export-button.sh` (new);
  - `lib/expected-policies.ts` and `audit.ts` (multi-bucket);
  - `backup.ts` (the sweep step);
  - `deploy-paths.txt`, `bundle.mjs`, `tsconfig.backup.json` (`paths` for `@/`), `Dockerfile.backup` (the COPY lines for `src/lib/export/*`, `src/db/schema.ts`, `src/lib/provenance*`, `src/lib/csv/escape*`).
  - The `package.json` import in `manifest.ts`: **replace it with a build-time constant** (`APP_VERSION` from `process.env.npm_package_version`, or a generated file), so the bundle never imports `package.json`.
- **`.github/workflows/export-workspace.yml`** (new).
- **App:**
  - `src/app/export/[token]/page.tsx` and its action (new); `src/lib/export/download-url.ts` (new);
  - `src/db/control-plane/schema.ts` plus one migration;
  - `src/lib/tenant/lifecycle.ts` (`NoticeKind`, supersede); `notices.ts` (render, stored recipients); `src/lib/email/templates/export-ready.tsx`;
  - `admin-commands.ts` and `tenant-admin.ts` (`export-revoke`; `export-destroyed` removed);
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
| T1 | `parseExportArgs`: every mode and its required flags; an unknown flag exits 2; a bad uuid, email or reason refused |
| T2 | `deliver` against a scratch workspace with fake S3: the ZIP stored under `delivery/<id>/`; the SHA-256 matches; the row, notice and audit written in one transaction; the recipients are D10 plus the extra address, lowercased and deduplicated |
| T3 | A `policy_hold` workspace: without `--extra` refused; with it, the recipients are exactly the extra address |
| T4 | Statuses: deleted, deleting, provisioning and no URL → `not-exportable` |
| T5 | Failure paths: the ZIP limit, a database error, an upload error, a recording error → no row, the object deleted, the upload aborted |
| T6 | `hold` and `release`: the hold row and object; a release deletes and verifies; a second release refused |
| T7 | The notice: `export-ready` is never superseded (`deleting`/`deleted` included); render uses the stored recipients and the link; the template text |
| T8 | The page GET: valid, expired, revoked, erased, unknown and workspace-host-redirect states; **a GET never calls the presigner** (spy) |
| T9 | The POST: re-checks; rate limit; a 5-minute presign with attachment disposition; `download_count` incremented; an expired token refused |
| T10 | Misconfigured env → the support text plus the alert |
| T11 | The sweep: deletes expired-delivery objects and orphan objects older than 7 days, sets `erased_at`, never touches `hold/` |
| T12 | Findings: `export-copy-overdue` at more than 8 days; open holds listed in the month's first digest only; the digest line |
| T13 | U6 and the stack: the bucket policy statements; lifecycle (`delivery/` 7 days, no hold rule); KMS conditions (download role via S3 only); the role set; the button RunTask families; `ExportModes`; the bootstrap OIDC provider and `CfnExecRole` ARN; the audit checks both buckets |
| T14 | U6: the only `src/` importer of `@aws-sdk` is `download-url.ts`; the bundle's `src/` inputs are exact, with COPY lines; `package.json` never bundled |
| T15 | The button: masking (target, extra address, reason never in the visible output); confirm rules; validation; `ExportModes` gate; one at a time |
| T16 | Retired: no `tenant:export` script, no `export-destroyed`, no `founder-export-overdue`; the receipt line; `tenant:delete` behaviour otherwise unchanged |
| T17 | Logs: ids only; the reason logged as a length |
| T18 | The in-app export route is unchanged (existing tests pass as-is) |

## 12. Founder steps (`PRODUCTION-DEPLOY.md`)
1. **13b:** before deploying `bootstrap.yml`, give the dev the Vercel team slug and project name (committed as constants). Deploy the updated bootstrap.
2. **13d (new):**
   - set the Vercel production env `EXPORT_DOWNLOAD_ROLE_ARN` (stack output), `EXPORT_BUCKET` and `AWS_REGION=us-east-1`, then deploy;
   - press Export workspace → `deliver`, target = the `rehearsal` workspace id, extra = your own address (confirm `deliver with extra`) → approve;
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
