import 'server-only';
import { eq } from 'drizzle-orm';
import { controlDb } from '@/db/control-plane';
import { tenants } from '@/db/control-plane/schema';
import { invalidateTenant } from '@/lib/tenant/registry';

export async function setTenantStripeCustomer(slug: string, stripeCustomerId: string): Promise<void> {
  await controlDb.update(tenants).set({ stripeCustomerId, updatedAt: new Date() }).where(eq(tenants.slug, slug));
  invalidateTenant(slug);
}

export async function findTenantByStripeCustomer(stripeCustomerId: string) {
  const [row] = await controlDb.select().from(tenants).where(eq(tenants.stripeCustomerId, stripeCustomerId)).limit(1);
  return row ?? null;
}

export async function applySubscriptionState(input: {
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  subscriptionStatus: string;
  plan: string;
  access: 'active' | 'suspended';
}): Promise<void> {
  const row = await findTenantByStripeCustomer(input.stripeCustomerId);
  if (!row) return; // unknown customer — ignore
  await controlDb.update(tenants).set({
    stripeSubscriptionId: input.stripeSubscriptionId,
    subscriptionStatus: input.subscriptionStatus,
    plan: input.plan,
    status: input.access,
    updatedAt: new Date(),
  }).where(eq(tenants.id, row.id));
  invalidateTenant(row.slug);
}
