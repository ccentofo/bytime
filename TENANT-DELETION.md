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

Deletion **aborts and restores the workspace** whenever payment activity appears: an active/trialing or
incomplete subscription, a payment processing on an open invoice (ACH), or an invoice void still pending.
A restored workspace goes back to `active` (or `suspended` for a policy suspension), the abort is audited
(`deletion-aborted`) and raised as an alert, and the next cron run re-reconciles it with Stripe.

## Final export

Customers export everything themselves (Settings → Export Workspace Data) and receive three notices during
the 90 days. **A founder copy is not taken by default (F2).** Take one only when the customer asks for it to
be sent, or for a legal request:

```bash
npm run tenant:export -- <slug> <out-dir>
```

- The output is AES-256 encrypted; the password is printed **once** and never stored.
- `<out-dir>` must be outside the repo and outside `~/Documents`, `~/Desktop`, `~/Library/Mobile Documents`,
  `~/Library/CloudStorage`, and any iCloud/Dropbox/OneDrive/Google Drive folder; the tool refuses those, and
  excludes the folder from Time Machine (`tmutil addexclusion`, verified).
- **Never email the file unencrypted.** Send it through an expiring link, and the password separately.
- **Destroy it** once delivered, and in every case by its destroy-by date: 30 days after the export, or 30 days
  after the workspace is deleted if sooner (the deletion receipt prints it). Then record it:
  `npm run tenant:admin -- export-destroyed <slug> --yes` (or `--legal-hold "<reason>"` to keep it only as long
  as a legal obligation requires). The digest alerts when a destroy-by date passes without a record.
- Decrypt: `openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in <file> -out <file>.zip`

## Running it

```bash
# Dry run — always do this first.
npm run tenant:delete -- <slug>

# Apply (also resumes an interrupted run).
npm run tenant:delete -- <slug> --yes

# Before the notice window has elapsed (audited).
npm run tenant:delete -- <slug> --yes --force-with-reason "customer written request, ticket #123"
```

Required env: `CONTROL_PLANE_DATABASE_URL`, `ENCRYPTION_KEY`, and `STRIPE_SECRET_KEY` / `NEON_API_KEY` if the
tenant has a Stripe customer / a dedicated Neon project.

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
founder export destroy-by date if one was taken. Running it again against a deleted tenant prints the tombstone.

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
npm run provision:tenant -- delete-test "Delete Test" test@example.com "Test Admin"

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

`BACKUP_RETENTION_DAYS = 30` in `src/lib/tenant/lifecycle-config.ts` (D11) matches the longest
window on any currently-published Neon plan (Scale's 30-day history window). **If CadenzPoint ends
up on a negotiated enterprise plan with a longer PITR/history window than 30 days, D11 needs to be
revisited** — that is not something these docs can confirm, since Neon's public pages don't publish
enterprise-tier numbers.

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
- **Founder export (if one was taken)**: destroyed by its destroy-by date and recorded with
  `tenant:admin export-destroyed` (see "Final export").
