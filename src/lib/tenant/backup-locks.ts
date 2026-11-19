/**
 * Session advisory-lock keys for the backup system (feature-plan-database-backups.md §6.4). Distinct from each other and
 * from MIGRATION_LOCK_KEY = 728_402_113 (src/lib/tenant/migrate-tenant.ts). All are taken on the control plane's DIRECT
 * host. No imports: the backup image bundles this module, and scripts/migrate-all.ts imports it too.
 */
export const BACKUP_LOCK_KEY = 728_402_201;
export const AUDIT_LOCK_KEY = 728_402_202;
export const RESTORE_TEST_LOCK_KEY = 728_402_203;
export const MIGRATE_RUN_LOCK_KEY = 728_402_204;
/** feature-plan-disaster-restore.md §6.4 "Start": one disaster task at a time (waited for up to 3 minutes). */
export const DISASTER_LOCK_KEY = 728_402_205;
/**
 * feature-plan-cloud-export.md §6.3 (3d): the export task's record and release transactions take this as a transaction
 * lock (`pg_advisory_xact_lock`) before the tenant lock, never during the build. The app never takes it.
 */
export const EXPORT_LOCK_KEY = 728_402_206;
