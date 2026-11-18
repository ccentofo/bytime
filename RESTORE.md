# Restoring tenant data — runbook

Policy: **LB-D6** (`feature-plan-launch-blockers.md` §0). Terms §8.5 promises time records are never deleted or
overwritten, so the **live database is never rewound** except in the narrow in-place case below.

## What we have

- Every tenant has its own Neon project (`cadenzpoint-<slug>`) with **7 days** of point-in-time history
  (`history_retention_seconds = 604800`, LB-D1). These are **mistake-undo** backups — not DCAA record retention.
- Check every project's setting: `npm run backfill:neon-retention -- --check` (apply with no flag).
- History older than 7 days is gone. Act quickly when a customer reports lost data.

## Default: restore into a copy, put back only what was lost

1. **Pin the facts.** Workspace slug, what was lost, and a UTC time just *before* the mistake (within the last 7 days).
   Run `npm run tenant:admin -- show <slug>` to confirm the workspace and its `neon_project_id`.
2. **Branch the history at that time — never restore `main`.** Neon console → project `cadenzpoint-<slug>` → create a
   new branch from `main` at the chosen point in time, named `restore-<yyyymmdd>-<short-reason>`. (API equivalent:
   `POST /projects/{project_id}/branches` with `branch.parent_timestamp` — confirm the field names on
   api-docs.neon.tech before first use.)
3. **Connect read-only.** Use the branch's connection string with
   `?options=-c%20default_transaction_read_only%3Don` (or run `SET default_transaction_read_only = on;` first). Nothing
   is ever written to the branch.
4. **Export the rows you need**, e.g. `\copy (SELECT … ) TO 'recovered.csv' CSV HEADER` from `psql`. Compare with the
   live workspace to list exactly what is missing.
5. **Re-enter them through the app's normal flows** — timesheet corrections with a reason code (so the revision trail
   shows who, when and why), the admin screens for setup data. **Never** `INSERT`/`UPDATE` the live database by hand.
6. **Delete the branch** (it is a copy of customer data) and record what you did:
   `npm run tenant:admin -- audit-note <slug> --note "Branch restore at <ts>: recovered <what>, re-entered via <how>." --yes`

## In-place restore (exception — total corruption only)

Only when the live database is unusable **and all four** hold:

1. **Confirmed no legitimate data after the restore point.** On a fresh branch of the *current* state, check the newest
   `created_at` / `updated_at` in the timesheet, revision, approval and audit tables. Anything after the restore point
   would be erased — then this path is not allowed; use the default path.
2. **The customer's written consent** (email from the workspace admin naming the restore time) **plus the founder's.**
3. **A written record of what was erased and why**, on the audit trail, referencing the consent:
   `npm run tenant:admin -- audit-note <slug> --note "In-place restore to <ts>. Erased: <what>. Why: <corruption>. Consent: <admin email + date>; founder approved." --yes`
4. **The customer notified afterwards** (template below).

Procedure: in the Neon console restore the project's `main` branch to the chosen time (Neon keeps the pre-restore state
as a backup branch — keep it until the customer confirms, then delete it). Then bring the schema current — the restore
point may predate a migration: `npm run db:migrate:all -- --tenant <slug>`. Smoke-test the workspace before telling the
customer.

### Customer notice template (send after an in-place restore)

> Subject: Your CadenzPoint workspace was restored
>
> Hi <name>,
>
> As agreed on <consent date>, we restored the <workspace> workspace to its state at <restore time, with timezone>.
> Changes made after that moment were removed: <what was erased>. Everything up to <restore time> — including every
> timesheet revision and approval — is intact.
>
> Please check <what to check> and re-enter <anything they need to re-enter>. Reply to this email if anything looks
> wrong; we keep the pre-restore copy until <date>.
>
> — <founder>, CadenzPoint

## A bad migration

**Fix forward.** Write a new migration that corrects the problem, run `npm run db:safety`, and deploy it the normal
way (`MIGRATIONS.md`). Never re-run a broken migration, never edit a migration that has already been applied, never
rewind a tenant database to undo one. The deploy pipeline stops before new code goes live if any tenant fails to
migrate, and the running code keeps working against the expanded schema (expand/contract).

## Backups beyond Neon (feature-plan-database-backups.md)

Neon's 7-day history covers mistakes. Losing a Neon project or the whole Neon account is covered by a separate daily
backup in AWS us-east-1 (BUSINESS-DECISIONS.md §5). Everything runs on its own; nothing runs on your machine.

- **What runs:** in the backup AWS account, scheduled container tasks: `backup` daily at 06:17 UTC (every workspace,
  then the control plane; catch-up at 18:17), `audit` daily at 11:17 UTC, and `restore-test` weekly on Mondays at
  08:17 UTC (catch-up the other days). Backups are encrypted with a KMS key and expire automatically after 25 days.
- **Where results show:** the daily ops digest's **Backups** section ("N of M workspaces backed up…", "Last restore
  test …") and its alerts (`backup-*`, `restore-test-*`) under "Unresolved alerts". A change to the backup protections
  (the key, the bucket policy, the lifecycle rule, the alerting) emails you at once, straight from AWS.
- **The weekly restore test** restores the control plane and the workspaces due for a test into temporary databases
  in the dedicated `cadenzpoint-restore-tests` Neon project, checks every table's row count, then deletes them.
  Every workspace is tested at least once every 13 weeks. This replaces the old monthly manual drill.
- **A lost workspace project:** the **Disaster restore** button, below (runbook A). **The control plane or the whole
  Neon account:** item 3c-2 (still to be built); until it exists, contact the lead; don't improvise.
- **`backup-old-objects` (a backup older than 29 days):** nothing can delete backups by hand, by design. AWS removes
  expired objects asynchronously and stops billing for them at expiry. If the alert persists past day 30, open an AWS
  support case (Lifecycle expiration delayed) with the bucket name and the object key from the audit.

## Disaster: workspaces (runbook A; feature-plan-disaster-restore.md)

A founder-only GitHub button that rebuilds one or more **lost** workspaces from their newest verified backup into a
**new** Neon project and switches each workspace over. It runs in the backup AWS account; nothing runs on your Mac and
you never see customer data. The original database is kept and watched, never deleted by the button. Every press is
emailed (start, finish and caller) and logged. The button does **not** migrate: the normal deploy (step 4) does.

1. **Neon console first:** if the project is listed as **deleted and recoverable**, recover it there. Nothing is lost;
   stop. (If Neon's recovery itself fails, contact Neon support and the lead. Until it's recovered, or its 7-day window
   passes and the button can proceed, deploys fail on this workspace.) The button refuses while Neon can still recover it.
2. **Unreachable but not deleted** (check status.neon.tech): as soon as the outage looks long, press **with the
   override** (step 3). If 3b's backups have already failed to connect twice over 4 hours or more, that press rebuilds
   at once, and the email names that evidence. Otherwise it only records the observation, starts the 4-hour clock, and
   tells you when to press again. Wait for Neon meanwhile.
3. Find the workspace id (in the digest's alerts, or `npm run tenant:admin -- show <slug>`). GitHub → **Actions →
   Disaster restore → Run workflow**: mode `workspace`; targets = the id(s), comma-separated, or `all-lost`; override
   `none` (or `unreachable-4h`); confirm `workspace` (or `workspace unreachable-4h` with the override) → **Review
   deployments → Approve**. **To cancel, cancel the run:** its last step stops the task.
4. **Right away: run Deploy to Production.** Tick `skip_lost_workspaces` only if other workspaces are still lost. This
   applies the migrations (and any database rules) added since the backup. The workspace is live at the backup's
   schema from the switch (within 60 s) until this deploy finishes. (If the digest ever shows `workspace-needs-deploy`,
   a skipped workspace came back by itself, or a rebuild had no deploy since: run Deploy to Production, normal.)
5. Email the customer with **template A** (below): the backup time, what to re-enter, and that records before it are
   intact.
6. **If the digest says the original came back** (`rebuild-original-returned`): don't open it. Ask the customer to
   confirm their re-entered hours are complete, then delete the original in the Neon console. The alert resolves on the
   next daily check after the 404. The watch closes after its 30 days.
7. In the Neon console, on each rebuilt project (the email names it), set `neon-ops@` to **Viewer** (Settings → access).
   If the console won't lower it, tell the lead: `neon-ops@` then stays Admin on that one project (Q1's residual).
8. **A lost workspace that was due for deletion** (the press records its proof and refuses `deletion-due`): deploys with
   **Skip lost workspaces** ticked skip it. `tenant:delete` refuses on a missing project today; the proven-gone deletion path is item 3c-2. Until then
   it stays skipped and listed.
8a. **The press says "credentials problem"** (the workspace's database password was reset, or similar): the data is
   intact. Deploys with **Skip lost workspaces** ticked skip it meanwhile. Contact the lead; refreshing a workspace's credentials is a separate decision
   (a repoint under LB-D6).
9. **If GitHub is down (Q2):** AWS CloudShell, signed in as `corey-admin` (security key), us-east-1. Replace `<ids>`
   (comma-separated workspace ids) and run, as one command:

   ```bash
   STAMP=$(date -u +%Y%m%dT%H%M%S); aws ecs run-task --cluster cadenzpoint-backup --task-definition cadenzpoint-backup-disaster --launch-type FARGATE --count 1 --started-by "cloudshell-$STAMP" --network-configuration "awsvpcConfiguration={subnets=[$(aws cloudformation describe-stacks --stack-name cadenzpoint-backup --query "Stacks[0].Outputs[?OutputKey=='TaskSubnets'].OutputValue" --output text)],securityGroups=[$(aws cloudformation describe-stacks --stack-name cadenzpoint-backup --query "Stacks[0].Outputs[?OutputKey=='TaskSecurityGroup'].OutputValue" --output text)],assignPublicIp=ENABLED}" --overrides "{\"containerOverrides\":[{\"name\":\"disaster\",\"command\":[\"disaster\",\"workspace\",\"--targets\",\"<ids>\",\"--override\",\"none\",\"--run-id\",\"cloudshell-$STAMP\"]}]}" --query 'tasks[0].taskArn' --output text
   ```

   The start is emailed, like a press; the results are emailed and appear in the digest. With the override, use
   `\"unreachable-4h\"` in place of `\"none\"`.
10. **A workspace that can't be rebuilt** (`no-backup`): its proof keeps it skippable by deploys (with **Skip lost
    workspaces** ticked) until it's rebuilt or reachable again. Contact the lead. 3b's daily `backup-failed`/`backup-stale` alerts for it continue meanwhile; that's
    expected.
11. **The button says "a disaster task is already running":** on the 1st of the month around 15:17 UTC, that's the
    monthly rehearsal: wait a few minutes. Otherwise, if nothing is running from your side: in CloudShell,
    `aws ecs list-tasks --cluster cadenzpoint-backup --family cadenzpoint-backup-disaster`, then
    `aws ecs stop-task --cluster cadenzpoint-backup --task <arn>`. It's logged and emailed.
12. **A rebuilt or recovered workspace that drops out again** (deploys fail on it once its proof is superseded): press
    with the override again. The new observation lets deploys (with **Skip lost workspaces** ticked) skip it while you
    wait.
13. **Every release while a workspace is skipped or awaiting a rebuild:** tick **Skip lost workspaces** on Deploy to
    Production each time. Without it, the deploy fails on that workspace (and Vercel doesn't deploy).

**Don't rename tenant projects in the Neon console:** the button's address check finds a workspace's projects by name
(`cadenzpoint-<slug>`, and its rebuilds `cadenzpoint-r-<id>-…`).

**Results the email can report, per workspace:**
- `linked`: rebuilt and switched (steps 4–7).
- `original-exists`: press with the override if it's been unreachable for hours (step 2).
- `recoverable`: recover it in Neon (step 1).
- `observed`: press again with the override after the time given (step 2).
- `reachable` / `not-lost`: the original answers; nothing to rebuild.
- `reachable-now`: an override press whose original answered (or couldn't be checked) just before the switch; nothing
  switched. Check status.neon.tech; press again with the override if it drops out again.
- `original-back`: the original came back just before the switch; nothing switched. Check it in the Neon console.
- `network-unproven`: the task couldn't reach any database at all (its own network); press again later.
- `credentials`: step 8a. `database-missing`: see "In-place restore" above (needs the customer's written consent).
- `deletion-due`: step 8. `no-backup`: step 10.
- `retryable`, `changed-meanwhile`, `not-started`, `not-finished`: press again.
- `proof-failed`: a Neon lookup failed or a check couldn't complete; press again once, and contact the lead if it repeats.
- `facts`: the workspace id isn't a live workspace with a database (check the id; contact the lead).
- `restore-failed`, `create`, `guard`, `error`: contact the lead with the email.
- `cleanup-failed` (rehearsal): contact the lead; a project may be left in Neon (the digest's leftover check lists it).
- `unconfirmed-rebuild` (`all-lost` only): a rebuild in a control-plane rollback window is unconfirmed (runbook B's
  reconcile listed it), so `all-lost` never rebuilds it from an older backup; contact the lead.

**The monthly rehearsal** (the 1st, 15:17 UTC, automatic) does all of this for the `rehearsal` workspace without the
switch, then deletes its copy. A failure appears in the digest as `disaster-rehearse-failed`: tell the lead.

### Customer email: template A (after a disaster rebuild)

> Subject: Your CadenzPoint workspace was restored from a backup
>
> Hello,
>
> On <date>, the database behind your CadenzPoint workspace became unavailable because of a failure at our hosting
> provider. We restored your workspace from our most recent verified backup, taken at **<backup time, with time zone>**.
> Your workspace is available again.
>
> **What you need to do:** anything entered or changed after <backup time> (time entries, submissions, approvals,
> settings) wasn't in that backup. Please ask your team to re-enter it. Everything recorded before that time is intact,
> including its full history.
>
> We keep the original database untouched while we confirm with our provider whether it can be recovered; if it comes
> back, we'll contact you before doing anything with it.
>
> If anything looks wrong, reply to this email.
>
> — <founder>, CadenzPoint

## Not in this runbook

The only path that points a workspace at a different database is the Disaster restore button above (the LB-D6
exception, limited to that button; every use is audited and emailed). The live database is never swapped for a
restored branch. Workspace deletion (and backup expiry after deletion) is in `TENANT-DELETION.md`.
