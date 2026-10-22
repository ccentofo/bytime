/**
 * Control-plane registration shared by the seeding scripts (seed-demo, seed-tenant). These run under plain
 * `tsx` (no server-only modules), so the §4.1 rules are applied inline: the tenant advisory lock is taken
 * before touching an existing row, and every write bumps lifecycle_version.
 *
 * `exempt` (F1) is set ONLY by the demo seeder: it marks the workspace lifecycle-exempt, clears any deletion
 * date, supersedes pending lifecycle notices, and records an audit event when the flag changes.
 */
import postgres from 'postgres';

export async function registerTenant(controlUrl: string, input: {
  slug: string;
  name: string;
  dbUrlEncrypted: string;
  exempt: boolean;
  actor: string;
}): Promise<void> {
  const sql = postgres(controlUrl, { max: 1 });
  const now = new Date();
  try {
    await sql.begin(async (tx) => {
      const [existing] = await tx<{ id: string; lifecycle_exempt: boolean; status: string }[]>`
        select id, lifecycle_exempt, status from tenants where slug = ${input.slug}`;
      if (existing) await tx`select pg_advisory_xact_lock(hashtext(${'tenant:' + existing.id}))`;
      if (existing && (existing.status === 'deleting' || existing.status === 'deleted')) {
        throw new Error(`Workspace "${input.slug}" is ${existing.status}; refusing to re-register it (the slug stays reserved).`);
      }
      const [row] = await tx<{ id: string }[]>`
        insert into tenants (slug, name, db_url_encrypted, status, plan, lifecycle_exempt)
        values (${input.slug}, ${input.name}, ${input.dbUrlEncrypted}, 'active', 'trial', ${input.exempt})
        on conflict (slug) do update set
          name = excluded.name,
          db_url_encrypted = excluded.db_url_encrypted,
          status = 'active',
          suspended_at = null,
          suspension_reason = null,
          lifecycle_exempt = tenants.lifecycle_exempt or excluded.lifecycle_exempt,
          deletion_scheduled_for = case when excluded.lifecycle_exempt then null else tenants.deletion_scheduled_for end,
          lifecycle_version = tenants.lifecycle_version + 1,
          updated_at = ${now}
        returning id`;
      if (input.exempt && !existing?.lifecycle_exempt) {
        await tx`
          update tenant_notices set superseded_at = ${now}
          where tenant_id = ${row.id} and sent_at is null and forced_at is null and superseded_at is null`;
        await tx`
          insert into tenant_audit_events (tenant_id, kind, detail, actor)
          values (${row.id}, 'exempt-on', 'demo workspace (seed-demo)', ${input.actor})`;
      }
    });
  } finally {
    await sql.end();
  }
}
