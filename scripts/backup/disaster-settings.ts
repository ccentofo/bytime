/**
 * The rebuild's creation settings (feature-plan-disaster-restore.md §6.3, §6.4 step 5): the app's own database-name and
 * history-retention rules, bundled from src/lib/tenant/db-name.ts and lifecycle-config.ts (the Dockerfile COPYs both).
 * NEON_HISTORY_RETENTION_SECONDS is unset in the task definition, so the policy value applies, as in the app's production.
 */
import { tenantDatabaseName } from '../../src/lib/tenant/db-name';
import { tenantDbHistoryRetentionSeconds } from '../../src/lib/tenant/lifecycle-config';

export function rebuildSettings(slug: string): { databaseName: string; historyRetentionSeconds: number } {
  return { databaseName: tenantDatabaseName(slug), historyRetentionSeconds: tenantDbHistoryRetentionSeconds() };
}
