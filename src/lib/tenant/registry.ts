import 'server-only';
import { eq } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { tenants } from '@/db/control-plane/schema';
import { decrypt, encrypt } from '@/lib/encryption';

export type TenantRecord = {
  id: string;
  slug: string;
  name: string;
  status: 'provisioning' | 'active' | 'suspended' | 'deleting' | 'deleted';
  plan: string;
  dbUrl: string; // decrypted
  // feature-plan-terms-compliance.md T3: the facts getTenantAccess() derives the mode from.
  // Always selected — the mode is recomputed fresh on every read (never cached), only the facts
  // themselves ride along with the 60s registry cache.
  subscriptionStatus: string | null;
  trialEndsAt: Date | null;
  pastDueSince: Date | null;
  suspendedAt: Date | null;
  subscriptionEndedAt: Date | null;
  deletionScheduledFor: Date | null;
  // T7: persisted at creation so deletion doesn't have to guess the Neon project name.
  neonProjectId: string | null;
};

type CacheEntry = { value: TenantRecord | null; expires: number };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

/** Look up a tenant by slug, decrypting its DB URL. Positive results cached for TTL_MS. */
export async function getTenantBySlug(slug: string): Promise<TenantRecord | null> {
  const now = Date.now();
  const hit = cache.get(slug);
  if (hit && hit.expires > now) return hit.value;

  const [row] = await controlDb.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
  const value: TenantRecord | null = row
    ? {
        id: row.id,
        slug: row.slug,
        name: row.name,
        status: row.status,
        plan: row.plan,
        // T7: null for a tombstoned (deleted) tenant — nothing should ever reach for it, since
        // getTenantAccess() returns 'closed' for status 'deleted' before any dbUrl use.
        dbUrl: row.dbUrlEncrypted ? decrypt(row.dbUrlEncrypted) : '',
        subscriptionStatus: row.subscriptionStatus,
        trialEndsAt: row.trialEndsAt,
        pastDueSince: row.pastDueSince,
        suspendedAt: row.suspendedAt,
        subscriptionEndedAt: row.subscriptionEndedAt,
        deletionScheduledFor: row.deletionScheduledFor,
        neonProjectId: row.neonProjectId,
      }
    : null;

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
}): Promise<void> {
  await controlDb.insert(tenants).values({
    slug: input.slug,
    name: input.name,
    dbUrlEncrypted: encrypt(input.dbUrl),
    plan: input.plan ?? 'trial',
    status: 'provisioning',
    neonProjectId: input.neonProjectId ?? null,
  });
}
