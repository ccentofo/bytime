import 'server-only';
import { countActiveUsers, readWorkspaceTimeZone, DEFAULT_TIME_ZONE } from '@/lib/billing/tenant-reads';

/**
 * The Billing page's two tenant-DB reads, behind one object so tests can stub them (feature-plan-per-user-billing.md
 * S20, S37). `getTenantBillingInfo` always calls through this object. Lives here, not in the `'use server'` actions
 * file (lead ruling B1); the reads themselves are billing infrastructure in src/lib/billing/tenant-reads.ts.
 */
export const billingTenantReads = {
  countActiveUsers: (row: { dbUrlEncrypted: string | null }) => countActiveUsers(row),
  readWorkspaceTimeZone: (row: { dbUrlEncrypted: string | null }) => readWorkspaceTimeZone(row),
};

export { readWorkspaceTimeZone, DEFAULT_TIME_ZONE };
