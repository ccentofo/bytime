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

## Monthly restore drill

On a **named throwaway workspace** in staging (e.g. `restore-drill`) — never a demo workspace (acme, globex, initech)
and never a customer's:

1. Record row counts: `SELECT count(*) FROM timesheet_entries;` (and `users`, `contracts`) and note the UTC time T.
2. Make a change (enter or delete a few hours), wait a few minutes.
3. Branch the project at T (step 2 of the default path), connect read-only, and confirm the counts match step 1.
4. Delete the branch. Note the date and result in your ops log.

## Not in this runbook

There is no command that points a workspace at a different database, and the live database is never swapped for a
restored branch. Workspace deletion (and backup expiry after deletion) is in `TENANT-DELETION.md`.
