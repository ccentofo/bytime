# Tenant Deletion Runbook

feature-plan-terms-compliance-fixes.md §5.3 (logic: `src/lib/tenant/delete-tenant.ts`; CLI:
`scripts/delete-tenant.ts`). Deleting a workspace is **permanent**: its database is destroyed and cannot
be recovered after Neon's recovery window closes (see "Backup window" below). Only the founder runs this,
and only against a workspace that is actually due. **Never** run it against a demo workspace (they are
lifecycle-exempt and refused unless you pass `--include-exempt`) or any remote database you are not
deliberately deleting.

## When deletion is allowed

The lifecycle cron's founder digest lists workspaces **ready for deletion** (D4: deletion is never
automatic). `npm run tenant:delete -- <slug>` (no `--yes`) is a dry run that prints the database it would
delete, the Stripe state, and anything that makes the workspace not eligible. It is eligible when:

1. `deletion_scheduled_for` has passed;
2. a non-superseded `deletion-notice` for the **current** retention anchor (subscription end, else trial end)
   was given (delivered with a provider message id, or force-marked with `tenant:admin force-notice-sent`)
   at least `DELETION_NOTICE_DAYS` before that date;
3. the workspace is not lifecycle-exempt (or you pass `--include-exempt`).

All three come from the database; this tool never takes your word for it. For a deletion that must happen
sooner (e.g. a legal request or the customer's own written request), pass `--force-with-reason "<text>"`:
it bypasses 1–2 only, and the reason is recorded in `tenant_audit_events`.

A **trial workspace suspended for a policy breach before its trial ends** gets no deletion date while the hold lasts:
a policy hold keeps the data. The 90-day clock starts when the hold is lifted (`tenant:admin unsuspend`): the next cron
run sets the deletion date to the trial end + 90 days, but never sooner than 14 days after that run.

Deletion **aborts and restores the workspace** whenever payment activity appears: an active/trialing or
incomplete subscription, a payment processing on an open invoice (ACH), or an invoice void still pending.
A restored workspace goes back to `active` (or `suspended` for a policy suspension), the abort is audited
(`deletion-aborted`) and raised as an alert, and the next cron run re-reconciles it with Stripe.

## Final export

**Take the export and wait until the Export workspace run has passed (the run's result, or the "export delivered"
email) before running `tenant:delete`.**

Customers export everything themselves (Settings → Export Workspace Data) and receive three notices during the 90
days. **The founder never downloads customer data** (`BUSINESS-DECISIONS.md` §5; `feature-plan-cloud-export.md`). When a
customer asks for their export to be sent, or for a legal or policy case, it's a cloud job:

1. GitHub → Actions → **Export workspace** → Run workflow (main):
   - **mode** `deliver`; **target** the workspace id (`npm run tenant:admin -- show <slug>` prints it);
   - **extra_recipient** / **extra_recipient_again**: only for a legal or policy case: one verified address, typed twice
     (they must match). Check the address with the requester out of band first (a phone call to a known number) and say
     so in the reason;
   - **reason**: required with an extra address (at most 200 characters);
   - **confirm** `deliver` → approve the `aws-disaster` environment.
2. A task in the backup AWS account builds the ZIP from the workspace's database into the exports bucket. You get an
   email: `export delivered: workspace <id>, delivery <id>, <n> recipient(s), expires <time>`.
3. The recipients (the notice recipients: active admins and the billing email, or the signup email when there's no
   active admin, plus the extra address) each get their own email with a link on cadenzpoint.com. No recipient sees
   another. The link works for **7 days**: each click on "Prepare download" makes a fresh 5-minute download. Access ends
   at 7 days, and the copy is erased within the hour after (the hourly sweep; S3's own 8-day expiry is the backstop).

**Policy hold (F5, A1):** for a workspace suspended for a policy breach whose export you haven't re-enabled
(`set-policy-export … on`), the extra address is **required** and the link goes **only** to it, never to the workspace's
admins. Any link sent earlier to the normal recipients stops working while the hold lasts (the page shows it as expired;
it isn't revoked), including after the workspace is deleted. Lifting the hold or re-enabling export within the 7 days
makes those links work again; after a deletion that's no longer possible. A link sent to the extra address alone keeps
working.

**More than 50 recipients:** the button refuses (`too-many-recipients`); the customer uses the in-app self-export.

**A wrong address, or a link that must stop:** `npm run tenant:admin -- export-revoke <delivery-id>` (prints what it
will do; add `--yes`). The link stops working at once, an unsent email is never sent, and the sweep erases the copy. It
warns if the email may already be going out.

**If you get `export outcome unknown`:** run `npm run tenant:admin -- show <slug>` and look for an `export-delivered`
(or `export-held`) audit event whose detail has that delivery (or hold) id.
- **Found:** it worked. Don't press again.
- **Not found after 10 minutes:** press again. A leftover delivery copy is erased by the sweep after a day; a leftover
  **hold** copy raises `export-orphan-hold` instead, so tell the lead.

**If a run failed and no export email arrived** (the task was killed): treat it as outcome unknown. Use `show`, and look
for a recent `export-delivered`/`export-held` event. Nothing technical stops a deletion during an export build; the
export then fails `changed` (press again).

**What the email can say, and what to do** (`export refused: <mode>, <target>, <code>` or `export failed: …`):

| Code | Meaning | What to do |
|---|---|---|
| `schema-skew` | the workspace's migrations differ from the backup image's | approve the pending Backup system deploy (or run it from Actions → Backup system deploy if none is pending), or run Deploy to Production; then press again |
| `not-exportable` | the workspace is deleted, being deleted, still provisioning, or has no database | nothing to export |
| `extra-required` | a policy-hold workspace without re-enabled export needs the verified extra address | press again with the address typed twice |
| `no-recipients` | no active admin, billing or signup email (and no extra address) | add an extra address (press again), or ask the customer for an admin |
| `too-many-recipients` | more than 50 recipients | the customer uses the in-app self-export |
| `changed` | the workspace's status, suspension or database changed during the build | press again |
| `released` | that hold is already released | nothing to do |
| `unknown-hold` | no hold has that id | check the id in the "export held" email |
| `another-export-running` | another Export workspace task is running (one at a time) | wait for its email, then press again |
| `lock-timeout` | the workspace was busy (another change held its lock for 5 seconds) | press again |
| `ecs-unreadable` | the task couldn't read its own ECS record | press again; if it repeats, tell the lead |
| `not-from-button` | the task was started some other way than the button or the CloudShell fallback | if you didn't start it, investigate (you also got the RunTask email) |
| `extra-needs-button` | an extra address was passed from CloudShell (only the button checks it twice) | use the button |
| `delete-unverified` | a release deleted the copy but S3 still shows it | press release again; if it repeats, tell the lead |
| `too-large` | over the ZIP limits (65,000 files or about 3.94 GiB) | contact the lead |
| `database-error`, `upload-error`, `s3-error`, `deadline`, `stopped`, `internal-error` | the run failed (nothing was recorded) | press again; if it repeats, tell the lead |

**Legal holds:** mode `hold` (target the workspace id, a reason) keeps a copy in the exports bucket until you release it;
no customer email. The `export held: workspace <id>, hold <id>` email carries the hold id. Open holds are counted in the
daily digest and listed in full on the 1st of each month. A hold survives the workspace's deletion by design (a legal
exception, Terms §9.3). When the legal reason ends: mode `release`, target the **hold id**, a reason → the copy is deleted
and verified gone.

**The manifest's app version:** an export built by the cloud task carries the version of the last backup-system deploy,
not necessarily the newest app release (the backup image is rebuilt only when its own files change). The data is read
with the schema of that deploy, and the task refuses (`schema-skew`) if the workspace's migrations differ from it.

## Running it

```bash
# Dry run — always do this first.
npm run tenant:delete -- <slug>

# Apply (also resumes an interrupted run).
npm run tenant:delete -- <slug> --yes

# Before the notice window has elapsed (audited).
npm run tenant:delete -- <slug> --yes --force-with-reason "customer written request, ticket #123"

# The workspace's Neon project is already gone (RESTORE.md runbooks A.8, A.10 and B.9).
npm run tenant:delete -- <slug> --project-proven-gone --yes
```

Required env: `CONTROL_PLANE_DATABASE_URL`, `ENCRYPTION_KEY`, and `STRIPE_SECRET_KEY` / `NEON_API_KEY` if the
tenant has a Stripe customer / a dedicated Neon project; `CONTROL_PLANE_PROJECT_ID` with `--project-proven-gone`.

**`--project-proven-gone`** (feature-plan-control-plane-disaster.md §6.6): on a first run, a dedicated Neon project
that's missing is normally refused ("the tenant database was not found": a wrong id or key looks the same). With this
flag, the run first **proves** the project is gone, read-only, and refuses with the failed check named unless every
check holds: `CONTROL_PLANE_PROJECT_ID` is set; the Neon key's organisation lists that project completely and it serves
`CONTROL_PLANE_DATABASE_URL`'s host (so your `.env.local` points at the live control plane); the workspace's project
answers 404; its address fails with an authentication error (what Neon says for a deleted endpoint); and no live project
serves its address. If Neon can still recover the project, it says so (closing the workspace doesn't recover it). Then
the normal steps below run unchanged: the date and notice checks (bypass only with `--force-with-reason`), the Stripe
steps, the disaster guard, step 5 (already gone) and the tombstone. The audit and the receipt record the proof:
`Neon project <id> (already gone; proven at <time>)`. On a resumed `deleting` run the flag does nothing.

The steps, in order (each idempotent; a re-run resumes while `status = deleting`):

1. **Preconditions** (above).
2. **Classify the database** from the decrypted URL: **local** (`localhost`/`127.0.0.1`/`[::1]`, dropped with
   the admin connection, refusing protected names); **shared-project** (a database inside the control plane's
   Neon project — refused unless `--drop-shared-database`; Neon keeps its history for the PITR window, which must
   stay ≤ D11); **dedicated Neon project** (`neon_project_id`). Anything else fails before any change.
3. **Locked reconcile** with Stripe and the transition table, re-check the preconditions on the reconciled facts,
   then set `status = deleting` (all access blocked immediately).
4. **Stripe**: abort-and-restore on payment activity; otherwise cancel every past-due/unpaid/paused subscription
   and void (or mark uncollectible) every open invoice. A Stripe failure stops the run with the status still
   `deleting`; re-run to resume. The Stripe **customer** is kept (billing/tax records, Privacy §7).
5. **Preflight** (the same Stripe check again), then delete the database. Neon: the project must have an endpoint
   matching the tenant URL host and must not host the control plane; `DELETE`, then confirm it returns 404. Local /
   shared: `DROP DATABASE … WITH (FORCE)`, confirmed via `pg_database`.
6. **Tombstone**: `status = deleted`, `deleted_at`, `db_url_encrypted = NULL`, only after step 5 is confirmed.
   `slug`, `name`, Stripe ids, every date, `tenant_notices` and `tenant_audit_events` are kept — proof of notice and
   of deletion, and the slug stays reserved.

The receipt lists the dates, the database, any forced reason, every notice (sent / forced / superseded), and the
export copies ("Export copies: N delivered (expire automatically); M open hold(s)"). Running it again against a deleted
tenant prints the tombstone.

## How to verify

1. Neon console (if applicable): the project is gone (or shows as recoverable for 7 days — see below).
2. `https://<slug>.cadenzpoint.com` shows the "Workspace closed" screen for everyone; existing sessions end.
3. Connecting to the old tenant database URL fails.
4. `npm run tenant:admin -- show <slug>` shows `status deleted`, `deleted_at`, and the audit trail.
5. Re-running `npm run tenant:delete -- <slug> --yes` is a no-op.

**Manual local test procedure** (only against a throwaway local tenant created for exactly this purpose —
never acme/globex/initech, never a remote database):

```bash
# 1. Provision a throwaway local tenant (no NEON_API_KEY in your local env → a local database).
npm run provision:tenant -- delete-test "Delete Test" test@example.com "Test Admin" --no-terms-record  # throwaway: no signed agreement

# 2. Make it eligible directly in the LOCAL control-plane DB: a lapsed trial, a past deletion date, and a
#    deletion notice for that same anchor delivered 20 days before the deletion date.
psql "$CONTROL_PLANE_DATABASE_URL" -c "
  UPDATE tenants SET trial_ends_at = '2026-01-01T00:00:00Z', deletion_scheduled_for = now() - interval '1 day',
         lifecycle_version = lifecycle_version + 1
   WHERE slug = 'delete-test';
  INSERT INTO tenant_notices (tenant_id, kind, scheduled_for, sent_at, provider_message_id, recipients)
  SELECT id, 'deletion-notice', '2026-01-01T00:00:00Z', now() - interval '21 days', 'manual-test', ARRAY['test@example.com']
    FROM tenants WHERE slug = 'delete-test';
"

# 3. Dry run, then apply.
npm run tenant:delete -- delete-test
npm run tenant:delete -- delete-test --yes

# 4. Verify per the steps above, then re-run to confirm the no-op.
npm run tenant:delete -- delete-test --yes
```

## Backup window (T7.4)

Confirmed against Neon's own documentation (fetched 2026-10-21):

- **Deleted-project recovery**: a deleted Neon project is recoverable for **7 days** via
  `POST /projects/{project_id}/recover`; after that, deletion is permanent. Source:
  [neon.com/docs/manage/projects](https://neon.com/docs/manage/projects).
- **Point-in-time restore / history window**: Neon's current public plans cap this at **6 hours**
  (Free), **7 days** (Launch), and **30 days** (Scale) — a separate mechanism from project
  deletion recovery; it supports instant restore/Time Travel for *branch* data while the project
  still exists, and does not extend how long a *deleted* project's data survives. Source:
  [neon.com/docs/introduction/history-window](https://neon.com/docs/introduction/history-window),
  [neon.com/docs/introduction/plans](https://neon.com/docs/introduction/plans).
- **CadenzPoint's setting** (LB-D1, `feature-plan-launch-blockers.md`): every tenant project keeps **7 days** of
  history (`history_retention_seconds = 604800`, set at creation; `npm run backfill:neon-retention` for existing
  projects). Restoring lost data from that history — into a copy, never rewinding the live database — is in
  [`RESTORE.md`](RESTORE.md).

**Backups in S3** (feature-plan-database-backups.md §6.8): a deleted workspace is no longer backed up once it reaches
`deleting`, and its earlier backups in the backup AWS account expire automatically within 30 days (the S3 rule at 25
days, an alert at 29). Nothing to do.

**Copies after deletion** (D11): backups expire per 3b (above: the S3 rule at 25 days); export delivery copies expire
7 days after they were sent (erased within the hour after; S3's 8-day rule is the backstop, `feature-plan-cloud-export.md`
§6.7); legal-hold copies are kept until the founder releases them (§6.3). Neon's own point-in-time history on a tenant
project is LB-D1's 7 days (`tenantDbHistoryRetentionSeconds`, `lifecycle-config.ts`). **If CadenzPoint ends up on a negotiated enterprise plan
with a longer PITR/history window than 30 days, D11 needs to be revisited**: that is not something these docs can
confirm, since Neon's public pages don't publish enterprise-tier numbers.

## What is retained and why

- **Kept forever**: the tombstoned `tenants` row (slug, name, Stripe customer/subscription ids,
  every lifecycle date, `neon_project_id`), every `tenant_notices` row, and every `tenant_audit_events`
  row — this is the proof the
  Terms require that a notice was sent and that deletion happened, and it's what
  `tenant:admin -- show` and this runbook's receipt read from.
- **Destroyed**: the tenant's entire Postgres database (every table — users, timesheets,
  contracts, everything) and `db_url_encrypted` (nulled so there is nothing left to decrypt even
  if it were somehow still readable).
- **Kept, not deleted by this tool**: the Stripe **customer** record (billing/tax history —
  Privacy §7 allows this). Subscriptions are canceled and open invoices voided.
- **Export copies**: delivery copies expire on their own (7 days, erased within the hour after); open legal-hold copies
  are kept until released. The deletion receipt prints "Export copies: N delivered (expire automatically); M open
  hold(s)" (see "Final export").
