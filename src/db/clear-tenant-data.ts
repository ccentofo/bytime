import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

/**
 * Empty a tenant database (feature-plan-terms-compliance-fixes.md §5.4). Shared by the demo seeder and the
 * integration-test cleanup so the two can never drift apart.
 *
 * Runs in ONE transaction: `timesheet_entries` and `period_events` are append-only (a trigger blocks
 * UPDATE/DELETE/TRUNCATE) unless `cadenzpoint.allow_entry_delete` is set, and `SET LOCAL` only lasts for
 * the transaction. Tables are cleared in foreign-key order. This is a destructive tool: callers must decide
 * the database is safe to wipe (see seedRichData's guard).
 */
export async function clearTenantData(db: PostgresJsDatabase<any>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL cadenzpoint.allow_entry_delete = 'on'`);
    await tx.delete(schema.periodEvents);
    await tx.delete(schema.timesheetEntries);
    await tx.delete(schema.timesheetPeriods);
    await tx.delete(schema.userChargeCodes);
    await tx.delete(schema.chargeCodes);
    await tx.delete(schema.costClasses);
    await tx.delete(schema.userAssignments);
    await tx.delete(schema.userLaborCategories);
    await tx.delete(schema.laborCategories);
    await tx.delete(schema.indirectChargeCodes);
    await tx.delete(schema.slins);
    await tx.delete(schema.clins);
    await tx.delete(schema.contracts);
    await tx.delete(schema.loginAttempts);
    await tx.delete(schema.notificationPreferences);
    await tx.delete(schema.passwordResetTokens);
    await tx.delete(schema.apiKeys);
    // Cascades to integration mappings, sync logs and sync records; connected_by references users.
    await tx.delete(schema.integrationConnections);
    await tx.delete(schema.users);
    await tx.delete(schema.payPeriodConfig);
    // Single-row table seeded by migration 0011: reset to the default rather than delete.
    await tx.insert(schema.workspaceSettings)
      .values({ id: 1, timezone: 'America/New_York', updatedAt: new Date() })
      .onConflictDoUpdate({ target: schema.workspaceSettings.id, set: { timezone: 'America/New_York', updatedAt: new Date() } });
  });
}

/** Email domains the demo/test seeders have ever used; a database holding only these users is safe to wipe. */
export const SEED_EMAIL_DOMAINS = ['cadenzpoint.dev', 'bytime.dev'] as const;
