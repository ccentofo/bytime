# Tenant Deletion Runbook

feature-plan-terms-compliance.md T7 / R10. Deleting a workspace is **permanent** — its database
is destroyed and cannot be recovered after Neon's recovery window closes (see "Backup window"
below). Only the founder runs this, and only against a workspace that is actually due.

## When deletion is allowed

`npm run tenant:delete -- <slug>` (no `--yes`) refuses to apply and instead prints exactly what's
missing. It is eligible when **both** are true:

1. `deletion_scheduled_for` (control plane `tenants` table) has passed.
2. A `deletion-notice` row exists in `tenant_notices` for this tenant with `sent_at` at least
   `DELETION_NOTICE_DAYS` (D3, `src/lib/tenant/lifecycle-config.ts`) days ago.

Both facts come from the database — this tool never takes your word for it. If a workspace needs
to be deleted sooner (e.g. a legal request), pass `--force-with-reason "<text>"`; the reason is
printed into the run's own receipt as the audit trail for the override.

## Take a final export first

Before deleting, strongly consider taking (or sending the customer) a final export:

```bash
# As the tenant's admin, from that tenant's subdomain:
curl -o final-export.zip https://<slug>.cadenzpoint.com/api/export/workspace \
  -H "Cookie: <admin session cookie>"
```

In practice, do this from the browser while signed in as an admin of that workspace (Settings →
Export Workspace Data), not via curl — the export route requires a real authenticated admin
session. Whether to send the export to the customer first is a case-by-case call; there is no
automatic step for it.

## Running it

```bash
# Dry run — always do this first.
npm run tenant:delete -- <slug>

# Apply.
npm run tenant:delete -- <slug> --yes

# Apply before the notice window has elapsed (logged in the receipt).
npm run tenant:delete -- <slug> --yes --force-with-reason "legal request, ticket #123"
```

Required env: `CONTROL_PLANE_DATABASE_URL`, and `STRIPE_SECRET_KEY` / `NEON_API_KEY` if the
tenant has a subscription / a Neon project respectively.

The script, in order:

1. Sets `status = deleting` — blocks all access immediately (`getTenantAccess` maps `deleting` to
   `closed`).
2. Cancels any Stripe subscription (keeps the Stripe **customer** — billing/tax records, Privacy
   §7). A Stripe failure is logged but does not stop deletion.
3. Deletes the database: the Neon project (if `neon_project_id` is on file) via
   `DELETE /projects/{project_id}`, or the local `tenant_<slug>` database in dev. If
   `neon_project_id` is missing and `NEON_API_KEY` is set, it stops and tells you to delete the
   project manually in the Neon console, then re-run — it will skip straight to tombstoning.
4. Tombstones the control-plane row: `status = deleted`, `deleted_at`, `db_url_encrypted = NULL`.
   `slug`, `name`, Stripe ids, every date, and `tenant_notices` are kept — proof of notice and of
   deletion, and the slug stays reserved (nobody can re-register a deleted company's subdomain and
   receive its former users' bookmarks or stray emails).
5. Prints a deletion receipt: slug, name, status, `deletion_scheduled_for`, `deleted_at`,
   `neon_project_id`, and every logged notice with its `sent_at`.

Running it again against an already-deleted tenant prints the existing tombstone and exits — a
no-op, not an error.

## How to verify

1. Neon console (if applicable): the project is gone from the project list (or shows as
   "recoverable" for 7 days — see below).
2. `https://<slug>.cadenzpoint.com` shows the "Workspace closed" screen (`TenantUnavailable`,
   `kind: 'closed'`) for everyone, logged in or not.
3. Connecting to the old tenant database URL fails (Neon: the project no longer resolves; local
   dev: `psql` against `tenant_<slug>` fails with "database does not exist").
4. `npm run tenant:admin -- show <slug>` (or a direct query of the control-plane `tenants` table)
   shows `status = deleted`, `deleted_at` set, `db_url_encrypted` NULL, and `neon_project_id` still
   recorded (historical reference — the project itself is gone).
5. Re-running `npm run tenant:delete -- <slug> --yes` is a no-op (prints the tombstone, makes no
   further changes).

**Manual local test procedure** (do this before trusting the tool against a real tenant, and only
against a throwaway tenant you created for exactly this purpose — never acme/globex/initech, never
a remote database):

```bash
# 1. Provision a throwaway local tenant.
npm run provision:tenant -- --slug=delete-test --name="Delete Test" --admin-email=test@example.com

# 2. Make it eligible: set deletion_scheduled_for in the past and log a deletion notice sent
#    >= DELETION_NOTICE_DAYS ago, directly in the control-plane DB (there is no UI for this —
#    it's normally the lifecycle cron's job). Example using psql against CONTROL_PLANE_DATABASE_URL:
psql "$CONTROL_PLANE_DATABASE_URL" -c "
  UPDATE tenants SET deletion_scheduled_for = now() - interval '1 day' WHERE slug = 'delete-test';
  INSERT INTO tenant_notices (tenant_id, kind, scheduled_for, sent_at, recipients)
  SELECT id, 'deletion-notice', now() - interval '20 days', now() - interval '20 days', ARRAY['test@example.com']
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

`BACKUP_RETENTION_DAYS = 30` in `src/lib/tenant/lifecycle-config.ts` (D11) matches the longest
window on any currently-published Neon plan (Scale's 30-day history window). **If CadenzPoint ends
up on a negotiated enterprise plan with a longer PITR/history window than 30 days, D11 needs to be
revisited** — that is not something these docs can confirm, since Neon's public pages don't publish
enterprise-tier numbers.

## What is retained and why

- **Kept forever**: the tombstoned `tenants` row (slug, name, Stripe customer/subscription ids,
  every lifecycle date, `neon_project_id`) and every `tenant_notices` row — this is the proof the
  Terms require that a notice was sent and that deletion happened, and it's what
  `tenant:admin -- show` and this runbook's receipt read from.
- **Destroyed**: the tenant's entire Postgres database (every table — users, timesheets,
  contracts, everything) and `db_url_encrypted` (nulled so there is nothing left to decrypt even
  if it were somehow still readable).
- **Kept, not deleted by this tool**: the Stripe **customer** record (billing/tax history —
  Privacy §7 allows this). Only the subscription is canceled.
