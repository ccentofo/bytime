import 'server-only';
import { eq } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { tenants } from '@/db/control-plane/schema';
import { decrypt, encrypt } from '@/lib/encryption';
import type { LifecycleFacts } from './lifecycle';

export type TenantRecord = LifecycleFacts & {
  id: string;
  slug: string;
  name: string;
  plan: string;
  dbUrl: string; // decrypted ('' for a tombstoned tenant; the access mode is `closed` before any use)
  // T7: persisted at creation so deletion doesn't have to guess the Neon project name.
  neonProjectId: string | null;
  stripeCustomerId: string | null;
  stripeCustomerDeletedAt: Date | null;
  currentPeriodEnd: Date | null;
  lifecycleVersion: number;
};

type TenantRow = typeof tenants.$inferSelect;

/**
 * The one mapper from a control-plane row to lifecycle facts (feature-plan-terms-compliance-fixes.md §4.1).
 * Used by the registry, crons, webhook and scripts so every caller derives the access mode identically.
 */
export function toLifecycleFacts(row: TenantRow): LifecycleFacts {
  return {
    status: row.status,
    subscriptionStatus: row.subscriptionStatus,
    stripeSubscriptionId: row.stripeSubscriptionId,
    trialEndsAt: row.trialEndsAt,
    pastDueSince: row.pastDueSince,
    suspendedAt: row.suspendedAt,
    suspensionReason: row.suspensionReason === 'nonpayment' || row.suspensionReason === 'policy' ? row.suspensionReason : null,
    subscriptionEndedAt: row.subscriptionEndedAt,
    deletionScheduledFor: row.deletionScheduledFor,
    firstGoodAt: row.firstGoodAt,
    lifecycleExempt: row.lifecycleExempt,
    policyExportAllowed: row.policyExportAllowed,
  };
}

/** Full registry record (facts + identity + decrypted URL) from a control-plane row. */
export function toTenantRecord(row: TenantRow): TenantRecord {
  return {
    ...toLifecycleFacts(row),
    id: row.id,
    slug: row.slug,
    name: row.name,
    plan: row.plan,
    dbUrl: row.dbUrlEncrypted ? decrypt(row.dbUrlEncrypted) : '',
    neonProjectId: row.neonProjectId,
    stripeCustomerId: row.stripeCustomerId,
    stripeCustomerDeletedAt: row.stripeCustomerDeletedAt,
    currentPeriodEnd: row.currentPeriodEnd,
    lifecycleVersion: row.lifecycleVersion,
  };
}

type CacheEntry = { value: TenantRecord | null; expires: number };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

/** Look up a tenant by slug, decrypting its DB URL. Positive results cached for TTL_MS. */
export async function getTenantBySlug(slug: string): Promise<TenantRecord | null> {
  const now = Date.now();
  const hit = cache.get(slug);
  if (hit && hit.expires > now) return hit.value;

  const [row] = await controlDb.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
  const value: TenantRecord | null = row ? toTenantRecord(row) : null;

  // IMPORTANT: never negatively-cache. An "unknown" slug looked up during signup (slug
  // availability check / startSignup) would otherwise persist as a stale null and make a
  // just-provisioned tenant appear "Unknown" for up to TTL_MS — across separate module
  // instances (route handlers vs server actions) and serverless instances, which
  // invalidateTenant() on the provisioning path cannot reach. Only cache found tenants.
  if (value) cache.set(slug, { value, expires: now + TTL_MS });
  return value;
}

/** Invalidate a slug's cache entry (call after status/plan changes). */
export function invalidateTenant(slug: string): void {
  cache.delete(slug);
}

/** Insert a new tenant record (used by the provisioning blueprint). DB URL is encrypted at rest. */
export async function createTenantRecord(input: {
  slug: string; name: string; dbUrl: string; plan?: string; neonProjectId?: string | null;
  /** The signer this provisioning belongs to: only they may resume it (provision.ts). */
  signupEmail: string;
}): Promise<void> {
  await controlDb.insert(tenants).values({
    slug: input.slug,
    name: input.name,
    dbUrlEncrypted: encrypt(input.dbUrl),
    plan: input.plan ?? 'trial',
    status: 'provisioning',
    neonProjectId: input.neonProjectId ?? null,
    signupEmail: input.signupEmail,
  });
}
