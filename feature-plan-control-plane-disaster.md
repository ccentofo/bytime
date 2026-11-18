# Blueprint 3c-2: Control-plane disaster (rebuild, reconcile, whole-account runbook)

> **Status: v1.5** (2026-11-18). Round 1: 27 findings (5 HIGH). Round 2: 20 findings (3 HIGH). Confirmation pass 1: 4 MEDIUM, 5 LOW. Confirmation pass 2: 1 HIGH, 3 MEDIUM, 7 LOW. Confirmation pass 3: 1 MEDIUM, 7 LOW. All addressed; §15. **Open for the product owner: Q3** (§2).
> Branch `control-plane-disaster`, from `main` at `57d6729`. Follows `BLUEPRINT-STANDARD.md`.
>
> **Scope decisions:**
> - `LAUNCH-TRACKER.md` 2026-11-17: the 3c scope Q1–Q5, the split, and the 4-hour override, which applies to workspaces only;
> - `LAUNCH-TRACKER.md` 2026-11-18: 3c-2's Q1–Q2;
> - `BUSINESS-DECISIONS.md` §5.
>
> **Builds on 3c**, `feature-plan-disaster-restore.md` FINAL v4.0 (merged, PR #34), and 3b (`feature-plan-database-backups.md`).

## 1. Goal and scope
**Goal:** when the control-plane database is lost (its Neon project deleted or unrecoverable), the founder presses the
same **Disaster restore** button. A task in AWS then does four things:
- rebuilds the control plane from its newest verified backup into a **new** Neon project;
- checks the rebuild the way the restore test does;
- works out what changed after that backup (the "window");
- emails the founder exactly what to do next.

The founder then repoints Vercel, GitHub and AWS to the new database by hand, from a checklist (accepted 2026-11-17 Q2),
and resyncs billing from Stripe with one command. A runbook covers losing the whole Neon account.

**In scope:**
1. **A stable, per-environment backup id**, so every backup stays findable after a rebuild (§6.0). This is a fix to 3b.
2. **Button mode `control-plane`:** gone-proof, rebuild, check and record, then the reconcile (§6.3).
3. **Button mode `reconcile`:** the window reconcile, re-runnable on its own (§6.4).
4. **`rehearse --targets control-plane`:** a non-destructive monthly rehearsal of the rebuild path (§6.5).
5. **`tenant:delete --project-proven-gone`:** closes a workspace whose database is proven gone, with every Stripe safeguard kept (§6.6, decision Q1).
6. **Window-workspace addresses** stay unavailable to new signups until resolved. System project names are reserved as slugs (§6.7).
7. **Monitoring:** window projects, and the old control plane's watch (§6.8).
8. **`tenant:admin stripe-resync`:** re-links checkouts completed in the window and refreshes every paying workspace from live Stripe, so billing facts lost in the rollback come back (§6.10). No event replay, and no email from the command.
9. **Runbooks:** B (control plane lost) and C (whole Neon account lost), plus updates to A (§6.9).

**Out of scope:**
- An automatic switch-over (BUSINESS-DECISIONS §5).
- Writing to Vercel or GitHub from AWS (2026-11-17 Q2).
- A Stripe key in AWS (2026-11-18 Q1).
- Re-attaching a window signup's data (2026-11-18 Q2).
- An outage override for the control plane: during a Neon outage the founder waits (B.1). The 4-hour override stays workspace-only.
- Changing the customer-facing product. The visible effects use existing messages: a handful of reserved slugs ("invalid") and open window slugs ("taken") (§6.7).

## 2. Product-owner decisions and founder duties
| # | Decision (date) | Effect here |
|---|---|---|
| 2026-11-17 Q1 | The button has a control-plane mode; losing the Neon account is a runbook using both modes | §6.3, §6.9 C |
| 2026-11-17 Q2 | After a rebuild, the founder repoints Vercel, GitHub and AWS and pauses/resumes crons by hand | Runbook B; the task writes nothing outside the new project |
| 2026-11-17 Q3 | If the Neon account is lost, the founder creates a new account and pastes its API key into AWS | Runbook C |
| 2026-11-17 Q4 | Window-created workspaces are reconciled in Stripe by hand from a checklist. *Deleted ones re-marked automatically*: **revised by 2026-11-18 Q1** | §6.4 lists; §6.6 closes |
| 2026-11-17 Q5 | The founder emails affected customers from a template | Templates B, B2 |
| **2026-11-18 Q1** | Workspaces deleted in the window, and lost workspaces that can't be rebuilt, are closed by the founder with `tenant:delete <slug> --project-proven-gone`. Every Stripe safeguard is kept | §6.6 |
| **2026-11-18 Q2** | A customer who signed up in the window signs up again (any charge that day refunded). The founder deletes the leftover database once they confirm | §6.4 R4, runbook B |
| **Q3 (open)** | A window signup whose email can't be found (no restored `signups` row, no Stripe customer, nothing in the email provider's log). **Recommended:** delete the leftover database 30 days after the reconcile if they haven't been reached; it holds at most a day of trial data. **Alternative:** keep it until the founder decides case by case | runbook B.9 |

**Founder duties at disaster time** (runbook B):
- disable crons, press, read the email;
- repoint (five places, including their own `.env.local`), deploy;
- run the Stripe resync, work the lists, re-enable crons;
- email customers.

**New one-time duties:**
- **Set the backup id:** SSM `/cadenzpoint/backup/control-plane-backup-id` (`staging` or `prod`) in PRODUCTION-DEPLOY 13b, alongside the control-plane URL. **If 13b is already done when 3c-2 deploys, create it as `prod` before approving that deploy** (§12 step 0).
- **Rehearse once:** press the control-plane rehearsal at setup (§12).

## 3. Verified current state (`main` at `57d6729`)
- **The backup id is a host hash, and the log parser expects one.**
  - `scripts/backup/lib/keys.ts:28-31`: `controlPlaneId(url)` is sha256 of the control plane's direct host, first 12 hex characters. It's used in every S3 key (`keys.ts:48-55`), every KMS encryption context (`crypto.ts:74-75`, exact match at `:85`) and every `BACKUP` line (`backup.ts:285`). The callers are backup (`:145`), restore test (`restore-test.ts:118`) and disaster (`disaster-workspace.ts:31`).
  - `log-reader.ts:24` `LINE_RE` requires the id to be 12 hex characters.
  - **A rebuilt control plane has a new host, so a new id.** The restore test would then list an empty prefix, and 3c's `backupCandidates` (`disaster-steps.ts:262-283`) would find no earlier tenant backup.
  - **3b's staging rehearsal runs the production stack pointed at staging** (`feature-plan-database-backups.md:724`, `:1045-1064`). The founder switches the URL and the key together (13b step 11).
- **Who reads the control plane** (all from env or SSM; nothing persists the host):
  - **App:** two lazy pools (`src/db/control-plane/index.ts:5-22`, `locked.ts:16-24`), read once per process, so a new URL needs a redeploy (§4.2).
  - **Crons and scripts**, including the founder's own `tenant:delete`/`tenant:admin` runs, from `.env.local`.
  - **Workflows:** `deploy-prod.yml:42,51`.
  - **Backup tasks:** SSM `/cadenzpoint/backup/control-plane-url` (backup-stack.yml:951,1012,1071,1138) and `control-plane-project-id` (disaster, :1153; the app reads it at `disaster-status.ts:312`).
  - **IAM:** no role has `ssm:PutParameter`, and a PutParameter event raises an alarm (`expected-policies.ts:74`).
  - **Log groups:** the task reads backup lines only from `BACKUP_LOG_GROUP` (`main.ts:161,180`).
- **The control-plane backup:**
  - it's dumped after the tenants (`backup.ts:461-500`);
  - the sidecar holds `rowCounts`, `sha256` (of the stored object), `startedAt` (taken before the snapshot, `:240` vs `:350`) and `finishedAt`;
  - the log line is `BACKUP <cp> control-plane control-plane control-plane <runId> <key> <sha256> <bytes>`;
  - `realLogReader.backupLines` hard-codes target `tenant` (`log-reader.ts:45,48`);
  - backup logs keep 30 days, the disaster log group 365, and S3 objects expire at 25 days.
- **3c's task** (`disaster.ts:202-299`) assumes a live control plane. It needs one for:
  - the lock (`:244`);
  - the `disaster_runs` row (`:270-289`), whose summary is **replaced** at the end (`:286-289`);
  - `RunContext` (it needs a client and a run row);
  - `networkProven` (`disaster-steps.ts:109-121`);
  - `positiveControl`'s live-tenant list (`:69-89`);
  - `loadTenant` and `record`.

  **Reusable as-is:**
  - `pollRecoverable` (`:92`);
  - `classifyGoneEndpoint` and `candidateServes` with a `CandidateRule` (`classify-endpoint.ts:85-129`);
  - `pgQuery` and `classifyConnectError` (`:36-45`);
  - the restore and verify helpers;
  - `neon.createProject`, `deleteProject` and `verifyGone`.

  **Log lines:** `SWITCHING`/`LINKED <tenantId> <old> <new> <key> <sha256>` (`disaster-steps.ts:443-468`), and the healed form (`:521`).

  **The leftover check** reads `disaster_actions` rows with kind `rebuild`/`rehearse` and a project name, and raises `rebuild-orphan-project` for an unreferenced live project after 6 h (`disaster-status.ts:115-125,182-197`).

  **The workspace email** still tells the founder to "lower neon-ops@ to Viewer (A.7)" (`disaster-workspace.ts:104`).
- **3c's button:**
  - modes `[workspace, rehearse]` (`disaster-restore.yml:16`; `disaster-button.sh:77`);
  - `confirm` equals the mode;
  - `parseDisasterArgs` exits **1** on an unknown mode (`disaster.ts:80`), so an older image gives no "approve the pending deploy" hint, and 2 on an unknown flag (`:68`).
- **The tables:** `disaster_runs.mode` and `disaster_actions` are varchar with no CHECKs, and `tenant_id` is nullable (`0012_disaster_restore.sql`). **No migration is needed.**
- **Tenant lifecycle:**
  - only `tenant:delete` sets `deleting`/`deleted`;
  - on its first run, `tenant:delete` refuses a missing project (`delete-tenant.ts:256-263`), while a resumed `deleting` run accepts one (`:255`);
  - step 5's `deleteNeonProjectVerified` treats a 404 as `alreadyDeleted` (`neon.ts:200-211`);
  - `--force-with-reason` skips only the date and notice checks (`:123`);
  - the cron skips `deleting` rows (`lifecycle-runner.ts:182,488-490`);
  - `CONTROL_PLANE_PROJECT_ID` isn't in `scripts/delete-tenant.ts`'s env list (`:17-18`).
- **Signup and provisioning:**
  - the Neon project `cadenzpoint-<slug>` is created **before** the `tenants` row (`neon.ts:94`, `provision.ts:72-74`);
  - the slug is checked only against `tenants` (`server/internal/signup.ts:20-24`, `provision.ts:51-59`);
  - `isValidSlug` (`slug-rules.ts:5-10`) reserves only `www`, `app`, `api`, `admin`, `static`, `assets`, `mail` and `support`. So it accepts `control-prod`, `restore-tests`, `recoverable-canary`, `r-…` and `control-r…`, which can collide with system project names;
  - staging and production share the name pattern and may share one Neon organisation (PRODUCTION-DEPLOY.md:292-293);
  - **no production workspaces exist yet** (pre-launch, 2026-11-18).
- **Stripe:**
  - metadata carries `{ slug, tenantId }` (`tenant-billing.ts:20-23`, `src/server/actions/billing.ts:71-85`);
  - the webhook handler is inline in `POST` (`stripe/webhook/route.ts:64-242`): checkout resolves by `metadata.slug`, and an unknown slug is ignored with 200 (`:87-91`); an unknown customer raises `stripe-event-unknown-customer` (`:102-109`); it re-reads live Stripe state for every event (`:155,182`).
  - **The daily cron does NOT re-read every tenant:** `shouldReconcile` is false without a customer, and for a GOOD subscription before its period ends (`lifecycle.ts:231-248`). **So billing facts lost in a rollback don't self-heal.** Example: a trial that converted in the window loses its customer link and goes read-only after the trial. Hence §6.10. The webhook's checkout branch passes the customer link to `reconcileInLock` as `extraPatch` (`route.ts:136-150`). `reconcileInLock` queues state-derived notices and alerts in the same transaction (`reconcile.ts:103-110`); they're delivered later by the notice cron.
- **What a rollback loses** (control-plane writes after the backup's snapshot), each with what recovers it:

  | Lost | Recovered by |
  |---|---|
  | new `tenants` rows | the window signups; Q2 |
  | lifecycle and Stripe facts | **the Stripe resync, §6.10** |
  | deletions | Q1 |
  | 3c rebuilds | re-applied, §6.4 R2 |
  | `tenant_notices` | can re-send; accepted 2026-11-17. Dates only move later |
  | `signups` | users sign up again |
  | `ops_alerts` | re-derived daily; `pending-invoice-void` is redone by `tenant:delete`'s Stripe step |
  | `tenant_audit_events` | a gap, including founder-export events that feed a receipt's destroy-by date (`delete-tenant.ts:383-396`); the window is named in the email |
  | `payment_pending_observations` | the microdeposit window restarts; LOW, accepted |
  | `tenant_seat_billing` | re-derived by seat sync |
  | `database_backups`, `restore_test_*` | the next runs; 3c's candidates use log lines when rows are missing |
  | `disaster_*` | §6.4 |

## 4. External behaviour (verified 2026-11-18 from the sources named)
### 4.1 Neon
1. **`GET /projects`** (neon.com/docs/reference/api/projects/list-projects):
   - `limit` 1–400, `cursor`, `search`, `org_id`, `recoverable`;
   - each project has `id`, `name`, `created_at`;
   - after a `timeout`, the list is incomplete.

   3c's `listProjects` paginates and treats an incomplete list as such. **`NeonProject` must gain `createdAt`**, since today it maps only `id` and `name` (`neon-api.ts:31-36,134-138`).
2. **Roles** (neon.com/docs/manage/user-permissions; …/organizations):
   - any member except a Collaborator can create a project;
   - "whoever creates a project becomes **Admin** on it", and keeps it;
   - Viewers can't see connection strings of others' projects;
   - "a per-project permission can only raise someone's access, never lower it".

   **So the disaster key can read connection strings only for projects it created** (3c rebuilds). 3c's A.7 can't work and is removed.
3. **`GET /projects/{id}/connection_uri?database_name=&role_name=&pooled=true`** returns `{ uri }` (…/get-connection-uri). The owner role comes from the branch's databases list (`owner_name`). **The dev confirms that endpoint and field in the impact analysis.**
4. **Plans** (neon.com/docs/introduction/plans):
   - Free: history 6 h, 100 projects;
   - Launch: up to 7 days, 100 projects;
   - Scale: up to 30 days, 1,000 projects (a soft limit);
   - upgrades happen in the console (Billing → Change plan).
5. **From 3c §4.1:** the proxy answers an unknown or deleted endpoint with `28P01`; `failed` is terminal; `423` means back off.

### 4.2 Vercel
- Env changes "only apply to new deployments" (vercel.com/docs/environment-variables). **So repointing needs a redeploy**, which B.6 provides.
- **Disable Cron Jobs** persists until it's explicitly re-enabled (vercel.com/docs/cron-jobs/manage-cron-jobs).

### 4.3 AWS
- ECS injects SSM values when a container starts, so a new task picks up a new value (docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-ssm-paramstore.html).
- `FilterLogEvents`: as in 3c §4.3.

### 4.4 Stripe
- **`GET /v1/checkout/sessions`** lists sessions, filterable by `created` and `status`, paginated (stripe.com/docs/api/checkout/sessions/list). **The dev confirms those filters in the impact analysis.** Customers and subscriptions are read live, as `reconcileInLock` already does.
- AWS never calls Stripe.

## 5. Invariants that must not break
1. **No original is ever deleted, overwritten or written** by anything in this item: neither the old control-plane project nor any workspace database.
2. **A control-plane rebuild needs the full gone-proof** (§6.3 step 3). There's no override.
3. **The task writes only inside the new project, plus its log and its one email.**
   - No SSM writes. No Vercel, GitHub or Stripe calls.
   - The old control plane is never written.
4. **The reconcile never deletes a project and never tombstones a tenant.** Its only tenant writes are re-applying confirmed `LINKED` rebuilds with 3c's full switch guard. Everything else is proof rows, alerts, action rows, and the email.
5. **Backups stay findable after any rebuild**, and staging's never mix with production's. The id comes per environment from SSM, and a rebuild never changes it (§6.0).
6. **`--project-proven-gone` replaces only `tenant:delete`'s "not found" refusal.** It never skips the date/notice checks (that needs `--force-with-reason`), the Stripe steps, the disaster guard or the tombstone.
7. **Window addresses stay unavailable to new signups** while their `window-project` alert is open. System project names are never valid slugs (§6.7).
8. **3c's invariants are unchanged:**
   - logs carry ids, never slugs or URLs;
   - public GitHub logs show no target;
   - one disaster run at a time;
   - every start is emailed (EventBridge).
9. **No customer data on the founder's machine.** `--project-proven-gone` reads Neon metadata and the control plane. `stripe-resync` reads Stripe, as `seat-sync` already does, and prints slugs and counts only, never an email address. Neither reads a workspace database or delivers a notice.

## 6. Design
### 6.0 A stable, per-environment backup id (fixes 3b)
- **`controlPlaneId(url, env = process.env)`:**
  - if `BACKUP_CONTROL_PLANE_ID` is set, return it, validated **`^(prod|staging)$`** (else throw);
  - otherwise return today's host hash, unchanged for tests and local use.
- **`LINE_RE`** (`log-reader.ts:24`) accepts the id as `([0-9a-f]{12}|prod|staging)`, so it covers both forms.
- **`main.ts` resolves the id once** from its own `env` and passes `cpId` in the deps of backup, restore-test and disaster. The callers stop computing it, which keeps tests honest.
- **The stack** injects `BACKUP_CONTROL_PLANE_ID` as a **secret** from SSM `/cadenzpoint/backup/control-plane-backup-id`. It goes on the backup, restore-test and disaster task definitions, not audit's (audit never computes the id). Each of those exec roles' `ssm:GetParameters` gains that ARN. **ECS can't start a task whose secret parameter is missing**, hence §12 step 0.
- **The founder sets the value** in PRODUCTION-DEPLOY 13b step 6, beside the URL:
  - `staging` for 3b's staging rehearsal, switched to `prod` with the URL and key in step 11;
  - step 9 checks for a `BACKUP staging control-plane` line, and step 12 for a `BACKUP prod control-plane` line;
  - **a wrong value is the one thing the context check can't catch** (it's consistent everywhere), hence the two-value whitelist and those checks;
  - runbook B **never** changes it.
- **`main.ts`:** inside ECS, a missing or invalid value is fatal for `backup`, `restore-test` and `disaster`. `audit` and `--self-check` never read it.
- **Effect:**
  - keys, contexts and lines use the per-environment id;
  - a rebuilt control plane keeps the id, so the restore test and 3c's candidate search keep working;
  - staging's dumps live under `staging/`, never production's prefix.
- **If production backups already exist** under a host-hash prefix when this deploys, they expire within 25 days, and new ones go under `prod` from the next nightly run. For up to a day:
  - the restore test reports `FAIL:list` for the control plane;
  - a workspace rebuild can use only post-deploy backups.

  A 13b note only; expected: backups aren't live (2026-11-18).

### 6.1 The button
- **The mode choice** becomes `[workspace, rehearse, control-plane, reconcile]`.
- **Targets** must be the literal `control-plane` for modes `control-plane` and `reconcile`. `rehearse` accepts `control-plane`, or keeps `uuid`/`auto` for workspaces.
- **The override** must be `none` for `control-plane`, `reconcile`, and `rehearse` of the control plane. `canary` stays workspace-only.
- **`confirm`** equals the mode.
- **An image older than the button** is refused **by the button**, before any AWS start: the stack gains an output `DisasterModes` (`workspace rehearse control-plane reconcile`, plus `rehearse-control-plane`). `disaster-button.sh` reads it alongside `TaskSubnets` (`:99`) and refuses a mode or target it doesn't list: "the Backup system deploy that adds this mode is pending approval". `parseDisasterArgs` keeps exit 1 for an unknown mode, so the existing tests stand. **A missing `DisasterModes` output** (a stack from before this deploy) allows exactly 3c's modes, so a workspace disaster still works in that gap.
- **The startedBy gate:** `control-plane` and `reconcile` need `gh-` or `cloudshell-`. A schedule can only rehearse.
- **Tests:** D2 cases for each new combination and refusal. The literal `control-plane` is masked like any target.

### 6.2 AWS (`ops/aws/backup-stack.yml`, `expected-policies.ts`)
1. **The backup id secret** on three task definitions, with the matching exec-role `GetParameters` grants (§6.0). The output is `DisasterModes` (§6.1).
2. **The disaster task:**
   - secret `RESTORE_TEST_DATABASE_URL` (the existing `/cadenzpoint/backup/restore-test-url`), and its exec-role grant;
   - plain env `DISASTER_LOG_GROUP: /cadenzpoint/backup/disaster`;
   - `main.ts` requires both for `control-plane`, `reconcile` and `rehearse --targets control-plane`;
   - the task role's `ReadBackupLines` gains `log-group:/cadenzpoint/backup/disaster:*`.
3. **Schedule `cadenzpoint-backup-disaster-rehearse-cp`:** `cron(17 15 15 * ? *)` UTC, in the workspace rehearsal's hour, on day 15. The input is `["disaster","rehearse","--targets","control-plane"]`. **The start-email template** (`backup-stack.yml:1339`, "not the monthly rehearsal (the 1st …)") and RESTORE.md:137 name both rehearsals (the 1st and the 15th). PRODUCTION-DEPLOY 13b's quiet-window sentences add the 15th.
4. **`expected-policies.ts` and U6** gain all of the above. **No `ssm:PutParameter` anywhere.**

### 6.3 Mode `control-plane` (`scripts/backup/disaster-control-plane.ts`)
The control plane is gone, so this mode has **its own run harness**:
- the deadline (330 min), SIGTERM, the hard exit and the email, as 3c;
- **no** control-plane lock, no abandoned-run closing, and no run row until step 8;
- ECS oldest-task-wins and the startedBy gate still run first.

`runDisaster` branches to it **before** opening any control-plane client.

1. **Start log:** `disaster control-plane run <runId> started by <x>`. `cpRunStartedAt = now`.
2. **Network first:** `pgQuery(RESTORE_TEST_DATABASE_URL)` succeeds, or refuse `network-unproven`.
3. **Gone-proof of the old control plane:**
   - (a) `GET /projects/{CONTROL_PLANE_PROJECT_ID}`:
     - 404 → continue;
     - 200 → refuse `original-exists` ("Neon still has the project: if it's an outage, wait for Neon; B.1");
     - otherwise → `proof-failed`.
   - (b) **Positive control:** the org list is complete and **contains** `RESTORE_TEST_PROJECT_ID`, and GET on it → 200.
   - (c) The id isn't in the recoverable list (`pollRecoverable`). If it's listed → refuse `recoverable` ("recover it in the Neon console: nothing is lost").
   - (d) `classifyGoneEndpoint(CONTROL_PLANE_DATABASE_URL, CONTROL_PLANE_RULE)`, where `CONTROL_PLANE_RULE = { exactNames: [], prefixes: ['cadenzpoint-control'] }`:
     - a login or post-auth answer → `reachable` ("the control plane at SSM `control-plane-url` answers. If you rebuilt before, check that SSM's URL and project id match Vercel's; runbook B.5");
     - served by a candidate → `served` ("a live project holds the control plane's address: fix `/cadenzpoint/backup/control-plane-project-id`");
     - unproven → `proof-failed`.

     Customer projects matching the prefix can't serve the control plane's host, so they're harmless here.
4. **Earlier rebuild still present:**
   - if any **live** org project's name matches exactly the control-plane rebuild pattern (§6.11) → refuse `rebuild-exists`: "a rebuilt control plane exists: `<id>`, created `<time>`. **If Vercel, GitHub or your `.env.local` use it, it's your live control plane: don't delete it.** Put its pooled URL and id into SSM (runbook B.5) and stop. Delete it only if you never repointed to it (runbook B.3).";
   - an incomplete list → `proof-failed`;
   - there's **no age limit**.

   A system that's correctly repointed already refuses at leg (a). ECS oldest-wins covers concurrent presses. These names can't be slugs (§6.7).
5. **Candidates:**
   - list `v1/<id>/control-plane/control-plane/`, dumps with a sidecar, newest first;
   - the SHA-256 comes from the `BACKUP … control-plane …` line, via a new `LogReader.controlPlaneLines(id)` on `BACKUP_LOG_GROUP` (exact re-parse; accepts the ` row-failed` suffix);
   - no line → skipped (counted);
   - none → refuse `no-backup`.
6. **Build** (3c's failure classes):
   - **Create** the control-plane rebuild name (§6.11) (pg 16, `NEON_REGION_ID`, `org_id`, the old URL's database name, which is `cadenzpoint_control` in production, the policy history retention).
   - **Log** `DISASTER-PROJECT <id> <name>` at once.
   - **Restore** with the context `{cp:<id>, kind:'dump', target:'control-plane', id:'control-plane', key}`, checked before `pg_restore`.
   - **Verify** the counts against the decrypted sidecar.
   - **Failures:** integrity → delete (verified), then the next older candidate (at most 3); infrastructure → delete, then the same once more; then `retryable`. An unverified delete → log `DISASTER-PROJECT-KEPT <id>` and name it in the email.
7. **Re-check:** repeat legs (a) and (c). If the old project answers 200 or is recoverable → delete the new project, result `original-back` ("keep using the original; nothing was changed").
8. **Record, in one transaction** on the new control plane's direct URL:
   - a `disaster_runs` row: mode `control-plane`, status `running`, summary `{ target:'control-plane', previousProjectId, newProjectId, newProjectName, backupKey, backupStartedAt, sha256, cpRunStartedAt }`. **If this row is later closed by the digest** (the task died after recording), 3c's stuck finding names RESTORE.md A.11, which gains a control-plane line: "the project is recorded and complete: continue runbook B from step 5 with it, then press `reconcile`". **A task that died before recording** leaves an unrecorded project: B.3's `rebuild-exists` path (never repointed → delete it and press again);
   - the global `rebuild-original-watch`, dedup = the old project id, detail `{ kind:'control-plane', oldProjectId, newProjectId, watchStartedAt }`.

   **No `disaster_actions` row for the control plane:** 3c's leftover check reads those rows and would flag the live control plane (round 1).
   **If recording fails:** delete the project (nothing points at it), verify, `retryable`.
9. **Reconcile** against the new control plane, with `windowStart = backupStartedAt` and `windowEnd = cpRunStartedAt` (§6.4).
10. **Finish:**
    - **merge** into the run row's summary (`summary || {…}`), never replace;
    - status `pass`, or `fail` if the reconcile threw. Either way the project is kept, since it's a complete control plane, and the email says "after repointing, press `reconcile`";
    - one email: the new project id and name, the backup time, the reconcile summary, runbook B's next steps, and "if the old control-plane project comes back before you repoint, keep the old one and delete the new project".

    Exit 0 on `pass`.

**Stop or deadline:** before step 8 commits, the new project is deleted and verified. After step 8, it's kept and named.

### 6.4 The reconcile (`scripts/backup/disaster-reconcile.ts`; mode `reconcile`, or step 9 above)
**Inputs:**
- a control-plane client;
- `windowStart` and `windowEnd`. Standalone, these come from the newest `disaster_runs` row with mode `control-plane`: `summary.backupStartedAt` and `summary.cpRunStartedAt`. None → refuse `no-rebuild`.

Standalone, the control plane must be live, so it uses 3c's normal start (lock, run row of mode `reconcile`, summary `target:'control-plane'`). **A first connect that fails (any error) → refuse `repoint-first`** ("the control plane in SSM doesn't answer: finish runbook B.5"), instead of 3c's misleading lock message. It's idempotent.

**R1. The shared proof legs,** fetched once:
- network first (a live workspace, or the restore-test URL);
- the positive control (in-list: the restore-test or control-plane project);
- one recoverable list (polled).

If any fails, every tenant is `unknown`.

**R2. Rebuilds made in the window: follow each chain to its end.**
- Read `DISASTER_LOG_GROUP` from `windowStart` to now. Collect `LINKED` lines (the normal form **and the healed form with a real old id**, which is a committed switch; `disaster-steps.ts:521`), `RELINKED` lines (below) and `SWITCHING` lines, parsed exactly. A healed `LINKED` whose `old` is `-` is listed as unconfirmed.
- **Per tenant:**
  - start at the row's `neon_project_id` and follow the links `old → new` in log-time order until none continues;
  - the middle projects are gone by design, since 3c rebuilds only after proving the original gone, so **only the chain's end is checked**.
  - If the end equals the row's project, it's **already applied** (counted separately; this is what makes re-runs quiet).
- **Otherwise, apply once:**
  1. the row is live and not due;
  2. `GET /projects/{end}` → 200;
  3. the database's owner role;
  4. `GET connection_uri?pooled=true`;
  5. one guarded UPDATE with **`switchWorkspace`'s conditions** (status, deletion date, byte-equal restored URL and project id, the tenant lock and `lock_timeout`). It doesn't use `switchWorkspace` itself, so no new `SWITCHING`/`LINKED` lines.
  6. The guards check the end's host: not the **new** control plane's direct host (from the new URL), and an `rt_`-free name. `Built` is formed as `{ projectId: end, pooledUri, backupStartedAt: null }`.
  7. audit `database-rebuilt` `{ reapplied: true, chain }`;
  8. action `rebuild`/`linked`;
  9. re-raise the watch for the chain's start.
  10. **log `RELINKED <t> <start> <end>`**, which a future reconcile follows like a `LINKED`.
- **Listed, never applied** (and the tenant is excluded from R3's `lost`; see R3):
  - a `SWITCHING` with no matching `LINKED` at the chain's end;
  - an end that 404s, or whose connection string read returns 403/404. **Any other error** (5xx, timeout) makes the tenant `unknown` instead, so B.5a's re-press retries it;
  - a row missing, deleted, due, or on a project outside every chain.

**R3. Classify each tenant** in `provisioning`/`active`/`suspended`/`deleting`, concurrency 4.
- "Due" means `status = 'deleting'` or `deletion_scheduled_for <= now()`.
- **A row without `neon_project_id` → `unknown`** (listed).
- **`all-lost` (3c, `disaster-workspace.ts:49-63`) skips any tenant whose newest decisive proof is `chain-unconfirmed`**, listing it as "unconfirmed rebuild: contact the lead". A one-line filter; a later, unrelated `all-lost` press can't rebuild it either.
- **A tenant with any listed (unconfirmed) R2 chain → `unconfirmed rebuild`, with proof `chain-unconfirmed`** *(new, skippable; never `gone`)*, whatever Neon says. Its newest data may sit in the chain's project, so it must never be rebuilt from an older backup without the lead. Deploys skip it, so it can't block B.6. The end state is the lead's: re-link by hand, or rebuild by explicit id. In runbook C every chain end 404s, so the lead rebuilds them.
- A proof row is appended for every row of the table except `fine`, `in progress` and `unknown`.

| Neon | Row | Result | Proof row (decisive) | The email says |
|---|---|---|---|---|
| 200 | `active`/`suspended` | fine | none | — |
| 200 | `deleting` or `provisioning` | **in progress** | none | `deleting` → re-run `tenant:delete <slug>` (it finishes or restores). `provisioning` → contact the lead |
| 404, not recoverable, (d) doesn't answer, not served | not due | **lost** | `gone` | runbook A: `all-lost` **only if no unconfirmed rebuild is listed**; otherwise the email prints the lost ids to press explicitly |
| 404, recoverable or not | **due** | **deleted in window** | `window-deleted` *(new, skippable)* | `tenant:delete <slug> --project-proven-gone`. If it aborts on a live subscription, the deletion was cancelled in the window: treat it as lost (runbook A) |
| 404, recoverable | not due | **recoverable, not due** | `recoverable-deleted` *(new, skippable)* | check your deletion receipts for the window first. Not deleted on purpose → recover it in the Neon console. Deleted on purpose (e.g. forced) → `--project-proven-gone --force-with-reason` |
| 404, (d) answers or is served | any | stale project id | `refused:reachable` | contact the lead |
| any (a listed R2 chain) | any | **unconfirmed rebuild** | `chain-unconfirmed` *(new, skippable)* | contact the lead; never `all-lost` |
| no `neon_project_id` | any | unknown | none | contact the lead |
| any error, or R1 failed | any | unknown | none | re-run `reconcile` later |

`SKIPPABLE_PROOFS` gains `window-deleted`, `recoverable-deleted` and `chain-unconfirmed`.

**Mass warning:** if 3 or more tenants are `window-deleted` or `recoverable-deleted`, the email starts "possible mass deletion: check Neon's status page and console before closing any workspace".

**R4. Projects created in the window:**
- Take every org project with `windowStart − 1 h < created_at <= windowEnd`. The hour covers signups whose project came before the snapshot but whose row came after; the upper bound keeps live signups out of a later standalone run. Exclude:
  - any project a `tenants` row references (any status);
  - the old and new control-plane ids;
  - `RESTORE_TEST_PROJECT_ID`;
  - names matching the control-plane rebuild and rehearsal patterns (§6.11), or `cadenzpoint-recoverable-canary`;
  - the projects R2 re-applied;
  - **any project id that already has a `window-project` alert (open or resolved)**, so a re-run never reopens a resolved one;
  - the ends of every chain R2 found, applied or listed (they appear under R2).
- **Type** each remaining project:
  - `rebuild`: name matches 3c's rebuild pattern (§6.11), checked **before** `signup`;
  - `signup`: name is `cadenzpoint-<slug>` with `isValidSlug(slug)`;
  - `other`: anything else.
- Raise a global `window-project` alert (dedup = the project id, detail `{ projectId, name, createdAt, slug | null, type }`) and append an action row.

**R5. Email lines:**
- the window start and end;
- per class: counts, then `tenant id + slug` lists (truncated at 200);
- re-applied and unconfirmed rebuilds;
- window projects by type, each with its project id and created time;
- the mass warning;
- runbook B's next steps.

### 6.5 Mode `rehearse --targets control-plane` (monthly, plus once at setup)
The control plane is live, so this uses 3c's normal start (lock, run row in the real control plane, summary `target:'control-plane'`).
1. **Proof legs against the live control plane:** network first; the positive control; `GET CONTROL_PLANE_PROJECT_ID` → 200; the recoverable list; the control-plane candidate listing completes. Any failure → `fail`.
2. **The earlier-rebuild check runs read-only** (§6.3 step 4). It logs the result and refuses nothing.
3. **Build** as §6.3 steps 5–6, into the rehearsal name (§6.11). **The real control plane gets 3c's `rehearse` action rows** (`intended` → `created` → `rehearsed-deleted`), so the leftover check covers a copy left by a crash.
4. **Reconcile the restored copy**, with `windowStart` = that backup's `startedAt`, `windowEnd` = now, and `dryRun`:
   - R2 resolves but doesn't switch;
   - R3 writes proof rows **into the copy only**;
   - R4 lists and raises nothing.

   The real control plane gets only the run row's summary (counts per class). **The reconcile throwing → `fail`.** The counts are informational, including `unknown`.
5. **Always:** delete the copy, verify the 404, and append `rehearsed-deleted`. If that fails → `fail`, the copy is named, and the leftover check alerts after 6 h.

**`disaster-rehearse-failed`** evaluates targets separately. **`target` is written in the run-row INSERT** (`disaster.ts:255`) for every mode, and later updates **merge**. So rows closed by the outer catch, the abandoned close or the digest keep it. A row with no `target` (3c's existing ones) counts as `workspace`.

### 6.6 `tenant:delete --project-proven-gone`
- **Allowed only for `neon-project` databases.** On a resumed `deleting` run it's a no-op (that run already accepts a missing project).
- **Before the "not found" refusal** (read-only, the app's `NEON_API_KEY` org key), all of these must hold, or refuse with the failed check named:
  1. `CONTROL_PLANE_PROJECT_ID` is set. It's now required for this flag, and the founder's `.env.local` gains it (B.5).
  2. **Positive control tied to the connected control plane:** the org list is complete; it contains `CONTROL_PLANE_PROJECT_ID`; and that project's endpoints include the direct host of `CONTROL_PLANE_DATABASE_URL`.
  3. `GET /projects/{neon_project_id}` → 404.
  4. The tenant's URL fails with **`auth` (28xxx)**, which is what Neon's proxy says for a deleted endpoint. A socket error, timeout, proxy error, `3D000`, post-auth answer or login → refuse "couldn't prove the database is gone".
  5. **No live org project serves the tenant's host** (the impact analysis decides whether to share `candidateServes` and `tenantCandidateRule` from `scripts/backup/lib` or port them; mind the bundle and tsconfig boundary) (`candidateServes` with 3c's `tenantCandidateRule`; any endpoints call that fails → refuse). This catches a stale password on a project that's still alive. Hosts are compared with `directHost` (`neon-api.ts:88-91`), which strips `-pooler`.
- **If the project is in the recoverable list,** print "Neon can still recover this project until <…>; closing the workspace doesn't recover it", and continue.
- **Then the normal flow, unchanged:** preconditions (`--force-with-reason` to bypass, audited); the locked reconcile and disaster guard; `deleting`; Stripe; step 5 (`alreadyDeleted`); the tombstone.
- **Audit:** `deletion-started` gains detail `project-proven-gone`. The receipt reads `Neon project <id> (already gone; proven at <time>)`.

### 6.7 Window addresses and reserved slugs (`slug-rules.ts`, `server/internal/signup.ts`, `provision.ts`)
- **`isValidSlug` also refuses system project names:**
  - exact: `control-prod`, `control-staging`, `restore-tests`, `recoverable-canary`;
  - patterns: as §6.11.

  No production workspaces exist yet. The dev checks the seed and demo data and the tests.
- **The slug check also refuses a slug** when an open `window-project` alert has `detail->>'slug' = slug`.
  - It applies in `startSignup` and `provisionTenant` (which covers the waitlist path).
  - It shows the existing "taken" message for an open window slug. A reserved name fails `isValidSlug` and shows the existing "invalid" message (`signup.ts:21`).
- **The slug becomes available** when the alert resolves (§6.8), or when the founder resolves it by hand. `window-project` isn't a `rebuild-`/`disaster-` kind, so `resolve-alert` allows it.

### 6.8 Monitoring (`src/lib/tenant/disaster-status.ts`)
- **`window-project`:** daily, its own step, **not** in `NEON_KINDS`.
  - It resolves when the project 404s ("project deleted"), or when a `tenants` row references it ("now a workspace").
  - A Neon failure leaves it open.
- **`rebuild-original-watch` with `kind: 'control-plane'`:** 3c's watch logic, with control-plane wording:
  - **returned:** "the old control plane exists again: don't use it; delete it in the Neon console once you're satisfied";
  - **recoverable:** "… don't recover it".

  `tenant:delete`'s guard already ignores tenant-less alerts.
- **The digest line** includes `control-plane` and `reconcile` runs.
- **`disaster-workspace.ts:104`'s email** drops the A.7 line and says "you remain Admin of rebuilt projects through the disaster key; that's expected".

### 6.9 Runbooks (`RESTORE.md`)
**B. The control plane lost:**
1. **Check Neon first:**
   - deleted and recoverable → **recover it there**, and stop;
   - exists but doesn't answer (status.neon.tech) → wait for Neon.
2. **Vercel → Schedules → Cron Jobs → Disable Cron Jobs.**
3. **Press:** Actions → **Disaster restore** → mode `control-plane`, targets `control-plane`, confirm `control-plane` → approve. Read the email.
   - **If GitHub is down:** run the CloudShell command printed in RESTORE.md, with these arguments.
   - **If the press refuses `rebuild-exists`:** **check Vercel, GitHub and `.env.local` first.** If any use that project, it's your live control plane: never delete it; put its URL and id into SSM (step 5) and stop. Only if you never repointed to it: delete it in Neon and press again.
4. **If the old project came back meanwhile** (check the Neon console): keep the old one, delete the new project, re-enable the crons, and stop.
5. **Repoint.** Neon console → the new project (named in the email) → Connect → database `cadenzpoint_control` → **pooled** string. Put it in:
   - Vercel production `CONTROL_PLANE_DATABASE_URL`;
   - the GitHub `production` secret of the same name;
   - SSM `/cadenzpoint/backup/control-plane-url`;
   - your own `.env.local`.

   Put the new project id in:
   - Vercel `CONTROL_PLANE_PROJECT_ID`;
   - SSM `/cadenzpoint/backup/control-plane-project-id`;
   - `.env.local`.

   **Don't change** `/cadenzpoint/backup/control-plane-backup-id`. Each SSM write sends a protection-alarm email: expected (it's you).
5a. **If the email shows `fail`, or any `unknown`:** press mode `reconcile` now (it uses the SSM URL you just set), and repeat until there's no `unknown`. If Neon's API is down, wait. A deploy fails on a lost workspace that has no proof. Unconfirmed rebuilds aren't `unknown`: they have a skippable proof. **If the same tenant is still `unknown` after 2 presses, contact the lead.**
6. **Actions → Deploy to Production** with **Skip lost workspaces** ticked. It migrates the restored control plane and picks up the new URL.
7. **Check** that the app loads and an admin can sign in to one workspace.
8. **Stripe resync:** `npm run tenant:admin -- stripe-resync --since <window start from the email> --stripe-mode live`, read the plan, then the same command with `--yes` (§6.10). Then resolve any `stripe-event-unknown-customer` alerts raised since the window start whose customer is now linked.
9. **Work the email's lists:**
   - **lost** → runbook A from step 3. **Use `all-lost` only if the email lists no unconfirmed rebuild;** otherwise press with the lost list's explicit ids. `all-lost` picks every live 404 tenant, including ones whose newest data sits in a chain project. **Check your deletion receipts for the window first:** if you deleted it on purpose, close it instead (`--project-proven-gone --force-with-reason`);
   - **deleted in window** → `npm run tenant:delete -- <slug> --project-proven-gone --yes`. If it aborts on a live subscription, the deletion was cancelled in the window: treat it as lost;
   - **recoverable, not due** → as the email says (receipts first);
   - **in progress** → re-run `tenant:delete <slug>` for `deleting`; contact the lead for `provisioning`;
   - **window projects:**
     - `signup` → **find the person,** in this order:
       1. the restored control plane's `signups` rows for that slug: `npm run tenant:admin -- window-signup <slug>`. **If more than one is printed, don't guess:** match on the company name the customer used (ask when you email; mention the address), and contact the lead if it's still unclear;
       2. Stripe → Customers, searching `metadata['slug']:'<slug>'` (set when they reached billing);
       3. the email provider's sent log, by the signup time in the alert and the slug.

       If the customer's `tenantId` is one the control plane knows, it isn't a window signup: contact the lead. Otherwise refund and cancel anything from that day, **resolve the project's `window-project` alert** (so their address is free again), and email template B2. Once they confirm, **delete the project by the id in the email**, after checking in Neon that its created date is before the window end. A re-signup creates a second project with the same name. **If nobody can be found:** Q3. **A staging workspace** (staging shares the org): resolve the alert by hand and never delete it.
     - `rebuild` → delete it in Neon if nothing in the email names it.
     - `other` → staging, or unknown: resolve the alert by hand.
   - **unconfirmed rebuilds, stale ids** → contact the lead;
   - **unknown** → press `reconcile` later.
10. **Re-enable the cron jobs in Vercel** once step 8 is done and the **deleted in window** and **in progress** items are closed. Don't wait for lost rebuilds, `provisioning` items, signup contacts or confirmations, or `unknown`. Then **Deploy to Production** (normal) after the last lost workspace is rebuilt or closed.
11. **Email affected customers** with template B.

**C. The whole Neon account lost:**
1. Create a new Neon account on `infra@`, with its organisation, and **upgrade it before anything else**: Launch for up to 90 workspaces, Scale above that (§4.1.4; Free keeps only 6 h of history).
2. Invite `neon-ops@` (Viewer, or Member per Q-D1) and create its key. Create the app's organisation key. Update:
   - SSM `neon-api-key` and `neon-org-id`;
   - Vercel `NEON_API_KEY`;
   - the GitHub `production` `NEON_API_KEY`;
   - `.env.local`.
3. Recreate the restore-test project (FOUNDER-ACCOUNTS-SETUP Part 5). Update SSM `restore-test-url` and `restore-test-project-id`.
4. Runbook B from step 2. In a new account:
   - workspaces that weren't due classify **lost**;
   - due ones classify **deleted in window** (close them);
   - window deletions that weren't due can't be told apart from lost ones. **Check your receipts before rebuilding**;
   - the old watches resolve as unverifiable.

**A (3c), updated:**
- **A.7 kept as "(removed)"**, so the numbering (A.8, A.11, and `disaster-status.ts:145`'s "see RESTORE.md A.11") stays valid: creators stay Admin (§4.1.2).
- **A.8** points to `--project-proven-gone`.

**Templates:**
- **B:** to every customer after a control-plane rebuild. Their data is intact; a notice from the lost day may repeat; billing is corrected the same day.
- **B2:** to a window signup. Sorry; please sign up again; any charge from that day is refunded.

### 6.10 `tenant:admin stripe-resync --since <iso> --stripe-mode live|test [--yes]`
**Not an event replay** (round 2: replaying event-anchored side effects could send false emails or roll back fields).
1. **Re-link window checkouts:**
   - list Checkout Sessions with `status=complete` and `created >= since − 1 h`, all pages;
   - for each whose `metadata.slug` names a live tenant whose `stripe_customer_id` differs from `session.customer`, **and whose live customer's `metadata.tenantId` equals that tenant's id** (otherwise it's listed as "not this workspace's checkout": a re-signup can reuse a slug), apply **the webhook's checkout link rule**: `replaceable` = no customer or a deleted one; no other tenant owns that customer (else raise `checkout-customer-conflict`, as `route.ts:141-148`);
   - the rule moves into a shared helper `checkoutLinkPatch(tx, row, customerId)`, which both the webhook and the command call; the webhook's behaviour is unchanged;
   - before the replaceable test, the command reads the row's current customer live: a customer deleted in Stripe counts as replaceable (it may have been replaced in the window).
2. **Refresh every paying workspace:**
   - for every `active`/`suspended` tenant with a `stripe_customer_id`, under its tenant lock, call **`reconcileInLock(tx, row, now, { extraPatch })`**, as the daily cron does;
   - step 1's newly linked tenants are included, and get `customerId` passed as the webhook does (`route.ts:150`), so their subscription is mirrored in the same run;
   - `extraPatch` holds step 1's link, if any, and `billingEmail` from the **live** customer (retrieved now, never from an event). **A null live email never clears the stored one.**
3. **Output:**
   - without `--yes`: counts (links to make, tenants to refresh) and slugs; nothing is written;
   - with `--yes`: the same plus outcomes (refreshed, linked, conflict, failed). **Exit 1 if any failed.**
   - No email address is printed.
- **Side effects** are exactly `reconcileInLock`'s, plus `markSeatSyncDue` for every tenant step 1 relinked (as the webhook's checkout branch, `route.ts:168`) and every tenant that becomes good (`route.ts:207,225`): state-derived notices queued in the same transaction, delivered later by the notice cron (crons resume at B.10), and alerts. **The command never delivers a notice, never calls `after()`, and never reads a workspace database.** Re-running it is safe: it converges on live state.
- **Refusals:**
  - `--since` missing;
  - a `--stripe-mode` that doesn't match the key (as `seat-sync`).

### 6.10b `tenant:admin window-signup <slug>` (read-only)
- **Only when** an open `window-project` alert names the slug; otherwise it refuses "not a window signup".
- Prints **every** `signups` row for that slug (the table has no unique slug, `0001_lucky_leper_queen.sql`) with `created_at <=` the alert's `createdAt`, and either `expires_at >= createdAt` or waitlisted. Newest first, each with its company name, email, created, verified and waitlisted.
- None → "no restored signup; use Stripe or the email log".
- It never writes. Printing one signup email to the founder is the same contact data the founder already gets from Stripe; it isn't workspace data.

### 6.11 System project names (one module, `scripts/backup/lib/project-names.ts`)
**One exported builder and one regex per name, tested round-trip.** They use 3c's existing 14-digit stamp (`disaster-steps.ts:319-321`):

| Name | Builder | Regex |
|---|---|---|
| 3c workspace rebuild | `cadenzpoint-r-<id8>-<stamp14>-<try>` (moved here unchanged) | `^cadenzpoint-r-[0-9a-f]{8}-\d{14}-\d+$` |
| control-plane rebuild | `cadenzpoint-control-r<stamp14>-<try>` | `^cadenzpoint-control-r\d{14}-\d+$` |
| control-plane rehearsal copy | `cadenzpoint-rehearse-cp-<stamp14>-<try>` | `^cadenzpoint-rehearse-cp-\d{14}-\d+$` |

`isValidSlug`'s reserved patterns (§6.7) mirror these: `^r-[0-9a-f]{8}-`, `^control-r\d{14}-\d+$`, `^rehearse-cp-\d{14}-\d+$`.

## 7. State machines
### 7.1 One control-plane run (mode `control-plane`)
| State | Event | Next | Side effects |
|---|---|---|---|
| start | gate or ECS refuses | exit 1 | log only; EventBridge has already emailed the start |
| start | network or proof refuses (`network-unproven`, `original-exists`, `recoverable`, `reachable`, `served`, `proof-failed`, `rebuild-exists`, `no-backup`) | exit 1 | email with the reason |
| proven | create fails (no id) | next try, or `retryable` | — |
| created | restore or verify fails | deleted → next candidate / `retryable` | delete + verify; `DISASTER-PROJECT-KEPT` if not verified |
| created | stop or deadline before step 8 commits | deleted | delete + verify |
| verified | re-check: original back | `original-back` | delete the new project; email |
| verified | recording fails | `retryable` | delete + verify; email |
| recorded | reconcile throws | `fail`, project kept | email: "after repointing, press `reconcile`" |
| recorded | reconcile done | `pass` | email |

"Can't happen": two runs past ECS oldest-wins. The ECS check runs before any Neon write, and step 4 catches sequential presses.

### 7.2 One tenant in the reconcile: §6.4 R3's table (every cell)

### 7.3 A window project
| State | Event | Next |
|---|---|---|
| (none) | R4 finds it, no alert ever | open |
| (none) | R4 finds it, an alert existed (any state) | unchanged |
| open | daily: 404 | resolved (address free) |
| open | daily: a tenant references it | resolved |
| open | daily: Neon fails | open |
| open | founder resolves | resolved |

### 7.4 `tenant:delete --project-proven-gone`
| Check (in order) | If it fails |
|---|---|
| status `deleted` | the receipt (unchanged) |
| status `deleting` (resumed) | the flag is a no-op; the normal resume |
| not a `neon-project` database | refused |
| `CONTROL_PLANE_PROJECT_ID` missing | refused |
| positive control (in list + endpoint host) | refused |
| GET not 404 | refused |
| URL result not `auth` | refused |
| a live org project serves the tenant's host (or a check fails) | refused |
| all pass | the normal flow from the preconditions on; every later refusal unchanged |

## 8. Failure modes
| # | Situation | Behaviour |
|---|---|---|
| F1 | Wrong Neon key or org | Positive control fails → refused; nothing created |
| F2 | Neon outage | `original-exists` → wait (B.1) |
| F3 | Control-plane project deleted minutes ago | `recoverable` → recover in the console |
| F4 | A second press after a successful one | `rebuild-exists`, with a refusal that says not to delete a project in use; or, if fully repointed, leg (a) refuses with 200 |
| F5 | Two presses at once | ECS oldest-wins |
| F6 | No `BACKUP` line for the newest dump | Skipped; an older one is used; counted |
| F7 | A corrupt or tampered dump, or another environment's | The context (per-environment id) or count check fails → next candidate |
| F8 | The task dies after create, before step 8 | The log has `DISASTER-PROJECT <id>`; the next press refuses `rebuild-exists`; B.3 says delete it and press again |
| F9 | The old control plane returns before repoint | Step 7 during the run; afterwards, B.4 |
| F10 | The old control plane returns after repoint | The watch → `rebuild-original-returned` |
| F11 | Founder repoints only some places | A stale SSM URL → backups fail `connect` → `backup-failed`. A stale GitHub secret → the deploy fails. A stale `.env.local` → `--project-proven-gone`'s positive control refuses (wrong endpoint host). B.5 lists all of them |
| F12 | A `LINKED` project's connection string can't be read | Listed; never guessed |
| F13 | The reconcile is interrupted | Re-run `reconcile`: guarded and idempotent |
| F14 | A Stripe webhook during the outage | 5xx → Stripe retries; processed after repoint. A missed or lost fact comes back with the resync (B.8) |
| F15 | A notice is re-sent | Accepted; dates only move later |
| F16 | A window signup's slug is taken by someone new | Blocked while the alert is open |
| F17 | Staging shares the org | Its new projects list as `other` or `signup`; the founder resolves them by hand |
| F18 | Migrations shipped in the window | B.6 migrates the restored control plane |
| F19 | A workspace classified lost was only slow | 3c's proof: the shared network-first and positive control, (d) with no answer, no serving candidate |
| F20 | `--project-proven-gone` against a live project | Refused (200, an endpoint answer, or no `auth` failure) |
| F21 | A rehearsal copy is left behind | 3c's `rehearse` rows in the real control plane → the leftover alert after 6 h |
| F22 | A trial converted in the window (customer link lost) | B.8 resync → the window's completed checkout relinks it, and `reconcileInLock` mirrors the live subscription |
| F23 | A forced deletion in the window | Shows as recoverable-not-due or lost → B.9 says check receipts first |
| F24 | A due date cancelled in the window, then the project lost | `tenant:delete` aborts on the live subscription → B.9: treat as lost |
| F25 | A row restored mid-change (`deleting`/`provisioning`, project live) | Listed `in progress` |
| F27 | The founder repointed Vercel and GitHub but not SSM, then pressed again | Leg (d) refuses `reachable` with the SSM hint, or step 4 refuses `rebuild-exists` with the don't-delete wording; nothing is created |
| F28 | The backup id was typed wrong (staging's value in production) | The whitelist allows only two values; 13b steps 9/12 check for the right `BACKUP` line; the founder fixes SSM before production's first backup |
| F26 | Pressing a new mode before the Backup system deploy is approved | The button reads the stack's `DisasterModes` and refuses with "approve the pending deploy"; no task starts |

## 9. Platform limits
- **The control plane is small:** a restore takes minutes, inside the 330-minute deadline.
- **The reconcile** makes about 1 Neon call per tenant, plus shared lists, at concurrency 4. That's minutes at 1,000 tenants, with 3c's 429/423 backoff.
- **`FilterLogEvents`:** two scans, paginated, under 25 TPS.
- **The email:** lists truncated at 200 per class, under SNS's 256 KB.
- **Stripe resync:** one paginated session list, plus about 3 Stripe reads per paying tenant (`reconcileInLock` and the live customer), run sequentially. At launch, minutes; at 1,000 paying tenants, under Stripe's rate limits with its SDK retries.

## 10. Blast radius
- **`scripts/backup/`:**
  - `lib/keys.ts` and its three callers;
  - `lib/log-reader.ts` (`LINE_RE`, `controlPlaneLines`, `disasterLines`);
  - `main.ts`;
  - `disaster.ts` (modes, parse, branch, summary merge plus `target`);
  - `disaster-control-plane.ts` (new) and `disaster-reconcile.ts` (new);
  - `disaster-rehearse.ts`;
  - `disaster-steps.ts` (exports);
  - `disaster-workspace.ts` (line 104 text);
  - `lib/neon-api.ts` (`createdAt`, `getConnectionUri`, the owner lookup);
  - `lib/classify-endpoint.ts` (`CONTROL_PLANE_RULE`);
  - `lib/project-names.ts` (new, §6.11; `disaster-steps.ts`'s `rebuildName` moves here unchanged);
  - `lib/disaster-proofs.ts`;
  - `disaster-button.sh`, `lib/expected-policies.ts`.
- **`.github/workflows/disaster-restore.yml`;** **`ops/aws/backup-stack.yml`** (secrets, env, grants, schedule, `DisasterModes`, the start-email template).
- **App and scripts:**
  - `src/lib/tenant/delete-tenant.ts` and `scripts/delete-tenant.ts`;
  - `src/lib/tenant/disaster-status.ts`;
  - `src/lib/tenant/slug-rules.ts`, `server/internal/signup.ts`, `src/lib/tenant/provision.ts`;
  - `src/app/api/stripe/webhook/route.ts` (the checkout link rule moves into `src/lib/billing/checkout-link.ts`, behaviour unchanged);
  - `scripts/tenant-admin.ts` and `src/lib/tenant/admin-commands.ts` (`stripe-resync`, `window-signup`).
- **Docs:**
  - `RESTORE.md` (B, C, A.7/A.8, the A.11 control-plane line, `:137`'s rehearsal times, templates);
  - `PRODUCTION-DEPLOY.md` (13b steps 6/9/11/12 backup id and checks; the quiet-window sentences; 13c additions);
  - `TENANT-DELETION.md`;
  - `FOUNDER-ACCOUNTS-SETUP.md`;
  - `.env.example` (`CONTROL_PLANE_PROJECT_ID` noted for local admin use).
- **Tests:** §11. Existing 3b and 3c tests pass unchanged. Those that build log lines or keys inside ECS gain the env, and those that call the three callers pass `cpId`.

## 11. Required tests (each fails without the change it proves)
**Testing rules (3c lessons):**
- Timing tests wait on real state (rows, `pg_locks`, log lines), never fixed sleeps.
- Every new integration file is run **5 times in a row** and once **with a CPU hog** (`yes` × 10) before the report.
- Each test world has its own scratch control plane. No assertion depends on other files' rows.
- **The integration worlds run with `BACKUP_CONTROL_PLANE_ID` set** (and one T4 variant unset).

| # | Scenario |
|---|---|
| T1 | `controlPlaneId`: `prod`/`staging` → that value; anything else (`probe`, `Prod`) → throws; unset → the host hash. `parseBackupLine` accepts `prod`, `staging` and host-hash lines, and rejects others. `main` passes `cpId` in deps (a test env without a global env still uses it) |
| T2 | `main.ts` in ECS without the id → fatal for backup, restore-test and disaster; `audit` and `--self-check` run normally |
| T3 | U6: the id secret on backup, restore-test and disaster (not audit), plus their exec grants; the restore-test URL secret, `DISASTER_LOG_GROUP` and the disaster log-group read; the `DisasterModes` output; the schedule name, cron and input exact; the start-email template names both rehearsals; no `ssm:PutParameter` |
| T4 | Backup → control-plane rebuild → **a workspace rebuild finds the pre-rebuild tenant backup** (fails with the host hash) |
| T5 | The restore test after a rebuild finds the control-plane backup |
| T6b | The button with no `DisasterModes` output allows `workspace` and workspace `rehearse` only |
| T6 | Parse and button: each new combination accepted; wrong ones refused (exit 1, the existing tests unchanged); a mode or target missing from the stack's `DisasterModes` → the button refuses before any `run-task`, with the deploy hint; override `none` (`canary` refused for the control-plane target); confirm = mode; the startedBy gate |
| T7 | Gone-proof legs one at a time: 200, recoverable, list without the restore-test id, login, served, network unproven → each refusal; full proof → proceeds |
| T8 | `rebuild-exists`: a live project named by the §6.11 builder → refused at any age, with the don't-delete wording; `cadenzpoint-control-risk` → not counted; an incomplete list → `proof-failed`. `reachable` carries the SSM hint |
| T9 | Candidates: no line → skipped; integrity → older (≤ 3); infrastructure → the same once, then `retryable`; each failed project deleted and verified; another environment's dump fails the context check |
| T10 | Re-check: original back → the new project deleted, `original-back`, nothing recorded |
| T11 | Recording: the run row and watch are in the **new** control plane, in one transaction; no `disaster_actions` row; nothing written to the old URL (spy). A recording failure → project deleted, `retryable` |
| T12 | **The daily disaster checks raise nothing about the rebuilt control plane** (no `rebuild-orphan-project`) |
| T13 | The task constructs no SSM-write, Vercel or Stripe client |
| T14 | R2 chains: old→n1→n2 with n1 gone (as in reality), lines shuffled → one update old→n2, `RELINKED <t> old n2`; a **healed `LINKED` with a real old id** counts as a link; a re-run → "already applied", nothing listed; `SWITCHING` without `LINKED` at the end → listed; healed `-` → listed; end 404 → listed; row due or changed → not applied; no `SWITCHING`/`LINKED` lines written by R2; the guard uses the new control plane's host |
| T15 | R3: every row of the table, including `in progress`, `unconfirmed rebuild` and no project id; R1 failing → all unknown; a chain end whose connection read fails with 503 → `unknown` (403/404 → unconfirmed); the email offers `all-lost` only when no chain is unconfirmed; **3c's `all-lost` skips a `chain-unconfirmed` tenant** |
| T16 | `--skip-lost` skips `window-deleted`, `recoverable-deleted` and `chain-unconfirmed`; superseded by a newer `linked` or `ok` |
| T17 | R4 bounds: created 30 min before `windowStart` and unreferenced → listed; after `windowEnd` → not listed; referenced, control-plane, restore-test, canary, cp-rebuild, rehearsal and chain-end projects excluded; types from §6.11's regexes (`cadenzpoint-r-and-d` → `signup`; a real 3c rebuild name → `rebuild`); an existing resolved alert → not reopened |
| T18 | The mass warning at 3, not at 2 |
| T19 | A reconcile re-run is quiet (no relink, no listing of already-applied chains, alerts deduped); standalone without a control-plane run → `no-rebuild`; standalone when the control plane doesn't answer → `repoint-first` |
| T20 | `target` written at INSERT for every mode; the summary merges (`backupStartedAt` survives); a row closed by the outer catch, abandoned close or digest keeps `target`; a missing target counts as `workspace` |
| T21 | Rehearsal: rows in the real control plane (`intended`/`created`/`rehearsed-deleted`); proof rows only in the copy; the copy deleted; a delete failure → `fail` and the leftover alert later; the reconcile throwing → `fail`; `unknown` counts don't fail it; retries in one minute use distinct names |
| T22 | `disaster-rehearse-failed` per target |
| T23 | `--project-proven-gone`: each check of §7.4 refuses alone (including a timeout instead of `auth`, a control-plane endpoint host mismatch, and a live org project serving the tenant's host); all pass → the Stripe steps run (spy), tombstone, receipt line; no-op on a resumed `deleting` run; without the flag the refusal is unchanged; preconditions apply without `--force-with-reason` |
| T24 | Reserved slugs refused (each exact name; each §6.11 pattern built by its builder → its slug part refused); an ordinary slug valid; §6.11 builder → regex round trip for all three names |
| T25 | Signup and provision refuse an open window slug; available after resolve; also after the daily check sees a tenant reference it |
| T26 | Monitoring: `window-project` 404 → resolved; Neon failure → open; not resolved by the `NEON_KINDS` sweep; the control-plane watch wording |
| T27 | `stripe-resync`: dry run writes nothing; `--yes` relinks a window checkout through `checkoutLinkPatch` only when the live customer's `metadata.tenantId` matches (a re-signup reusing the slug isn't linked); a row whose current customer was deleted in Stripe is replaceable; a conflict raises the alert; linked tenants mirrored in the same run; `markSeatSyncDue` when a tenant becomes good; the live billing email, never nulled; no notice delivered, no `after()`, no email printed; a second run changes nothing; exit 1 if any failed; a mode mismatch refused |
| T28b | `window-signup`: prints every eligible row (two rows → both); excludes a row created after the project, and an expired unverified row; refuses without an open alert; writes nothing |
| T28 | `checkoutLinkPatch` extraction: the existing webhook tests pass unchanged |
| T29 | Email and logs: truncation; no URL or secret; ids only (`DISASTER-PROJECT`, `RELINKED`); the public button log shows no target |

## 12. Founder steps and rehearsal (`PRODUCTION-DEPLOY.md`)
0. **If 13b is already done when 3c-2 deploys:** create `/cadenzpoint/backup/control-plane-backup-id` = `prod` **before** approving the Backup system deploy. Without it, ECS can't start any backup, restore-test or disaster task.
1. **13b step 6:** create the parameter = `staging` for the rehearsal; step 9 checks for a `BACKUP staging control-plane` line. **Step 11:** switch it to `prod` with the URL and key; step 12 checks for a `BACKUP prod control-plane` line.
2. **13c, after the deploy that merges 3c-2:** Actions → Disaster restore → `rehearse`, targets `control-plane`, confirm `rehearse`. Expect `pass`, and no `cadenzpoint-rehearse-cp-*` project left.
3. **`.env.local`:** add `CONTROL_PLANE_PROJECT_ID` (production's).
4. **A 13b note** if production backups already existed (§6.0).

## 13. Verification
- `npx tsc --noEmit`, `npm run lint`, `npm run test`, `npm run test:tz`, `npm run db:safety`.
- Integration, alone, with the pg 16 tools and the memory-noted environment.
- §3.7 verbatim runs for every changed `run:` block, and the exact-COPY image build.
- cfn-lint.
- The early CI push once the CI commit exists.
- The lead's checks file covers:
  - the button refusals;
  - the reserved and window slugs;
  - `--project-proven-gone` against a local workspace (test-only Neon seam);
  - `stripe-resync`'s dry run with a stub;
  - the reconcile against a scratch control plane with fakes.

## 14. Hand-off rules
`BLUEPRINT-STANDARD.md` §3 in full, including §3.7. Also:
- the §11 testing rules;
- no real AWS, Neon or Stripe;
- never touch acme, globex or initech, or any remote database;
- stage files by name;
- never push;
- tell the lead before each full integration run.

## 15. Pre-mortem log
- **v1.0 (2026-11-18):** draft. Q1–Q2 were answered before drafting.
- **v1.1, round 1** (2 reviewers; 27 findings: 5 HIGH, 15 MEDIUM, 7 LOW grouped). All fixed:
  - **HIGH:**
    - the control-plane action row would trip 3c's leftover check → no action row (§6.3.8, T12);
    - `LINE_RE` rejected a non-hex id → `LINE_RE` widened (§6.0, T1);
    - Stripe facts don't self-heal → `stripe-replay` (§6.10, B.8, §3 corrected);
    - system names could collide with slugs → reserved slugs plus exact regexes (§6.7, §6.3.4, R4);
    - R4 had no upper bound → `windowEnd = cpRunStartedAt`, and resolve-on-reference.
  - **MEDIUM:**
    - the per-environment id from SSM (staging's rehearsal uses the production stack);
    - the double-press rule became exact, with no age;
    - rehearsal rows go in the real control plane, with `-<try>`;
    - the summary merges, plus `target`;
    - an unknown mode exits 2;
    - R4's lower bound is −1 h;
    - `--project-proven-gone` needs `auth` and the endpoint-host tie, with `CONTROL_PLANE_PROJECT_ID` required;
    - R2 is ordered and uses 3c's full guard;
    - a recording failure deletes the project;
    - forced and cancelled deletions are covered in the runbook;
    - the `in progress` class;
    - crons are re-enabled earlier;
    - B2 resolves the alert, and resolved alerts are never reopened.
  - **LOW:**
    - `DISASTER_LOG_GROUP` and the restore-test URL wiring;
    - the schedule hour;
    - §7.1 email wording;
    - override `none` for the control-plane rehearsal;
    - C.4 alignment;
    - the database name in B.5;
    - the A.7 email text;
    - `.env.local`;
    - CloudShell;
    - F8 in the runbook;
    - the flag a no-op on resume;
    - runbook C's plan by count;
    - null project id → unknown;
    - `window-project` kept out of `NEON_KINDS`;
    - the founder-export audit gap.
- **v1.2, round 2** (2 fresh reviewers; 20 findings: 3 HIGH, 9 MEDIUM, 8 LOW). All fixed:
  - **HIGH:**
    - **R2 chains never applied** (middle projects are gone by design) → follow each chain to its end, check only the end, apply once, log `RELINKED`;
    - **the Stripe replay couldn't run** (`after()` outside a request; working around it would breach constraint 2) and **would replay event-anchored side effects** (a false bank-failure email, a stale billing email) → replaced by `stripe-resync`: re-link window checkouts with the webhook's own rule, and refresh every paying tenant with `reconcileInLock` and live customer reads. No replay, no notice delivery;
    - **`rebuild-exists` could lead the founder to delete the live control plane** (repointed Vercel but not SSM) → don't-delete wording, the SSM hint on `reachable`, and B.3 aligned.
  - **MEDIUM:**
    - exit 2 can't help the image running during the upgrade → the button reads the stack's `DisasterModes`;
    - the id whitelisted to `prod|staging`, with 13b `BACKUP`-line checks;
    - a missing SSM parameter stops every task → §12 step 0;
    - `target` written at INSERT;
    - 3c's rebuild stamp is 14 digits → one names module with round-trip tests (§6.11);
    - R2 re-runs listed already-applied chains → "already applied";
    - B.6 failed when there were unknowns → B.5a;
    - `stripe-resync` rolling back the billing email → live reads.
  - **LOW:**
    - `candidateServes` added to `--project-proven-gone`;
    - `Built` and the new control plane's host spelled out;
    - the reserved-slug message is "invalid";
    - B.10's criteria;
    - the start-email template and the rehearsal times;
    - `main` resolves `cpId` once, and audit doesn't need the id;
    - A.11's control-plane line, and `repoint-first`;
    - `DISASTER_LOG_GROUP` for the control-plane rehearsal;
    - the rehearsal's pass rule.
- **v1.3, confirmation pass 1** (4 MEDIUM, 5 LOW; not clean). All fixed:
  - the missing-id fatal no longer covers `audit`;
  - the re-link requires the live customer's `tenantId`, so a re-signup reusing a slug isn't linked;
  - healed `LINKED` lines with a real old id count; a tenant with an unconfirmed chain is `unknown` (no `gone` proof); `all-lost` is only for emails with no unconfirmed rebuild;
  - window signups are found via Stripe customer metadata or the email provider's sent log, and the uncontactable case goes to the product owner as Q3;
  - LOWs:
    - linked tenants are mirrored in the same run;
    - a missing `DisasterModes` allows 3c's modes;
    - §10's exit-2 leftover is gone;
    - a null email never clears the stored one, and B.8 resolves stale unknown-customer alerts;
    - the impact analysis decides how `candidateServes` is shared.
- **v1.4, confirmation pass 2** (1 HIGH, 3 MEDIUM, 7 LOW; not clean). All fixed:
  - **HIGH:** an unconfirmed-chain tenant had no skippable proof, so B.6 (the deploy that repoints the app) could never pass, which was near-certain in runbook C → a new skippable proof `chain-unconfirmed`; the lead owns the end state.
  - **MEDIUM:**
    - finding a window signup now starts with the restored `signups` row (`tenant:admin window-signup`, read-only), then Stripe metadata, then the provider's log;
    - delete by project id, after checking its created date (a re-signup duplicates the name);
    - the email offers `all-lost` only when no chain is unconfirmed.
  - **LOW:**
    - a deleted live customer is replaceable;
    - `markSeatSyncDue`;
    - the SSM alarm emails are expected;
    - A.11 and B.3 are aligned (after versus before recording);
    - staging projects are never deleted;
    - B.10 doesn't wait on lead items;
    - the billing path corrected.
- **v1.5, confirmation pass 3** (1 MEDIUM, 7 LOW; not clean). All fixed:
  - **MEDIUM:** `window-signup` printed only the newest row, which could be another person's earlier attempt at the same slug → print every eligible row (time-bounded); the founder matches on the company name and never guesses.
  - **LOW:**
    - the email-log lookup uses the time and slug;
    - 3c's `all-lost` skips `chain-unconfirmed` tenants (a one-line filter);
    - a transient connection-string error → `unknown`, not an escalation;
    - R3's table gains every row;
    - B.5a's escape after 2 presses;
    - A.7 stays numbered;
    - `markSeatSyncDue` on every relink, with the line citations corrected.
