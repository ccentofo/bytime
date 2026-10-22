import { describe, it, expect, afterEach, vi } from 'vitest';
import { eq, like } from 'drizzle-orm';

vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': `203.0.113.${Math.floor(Math.random() * 200)}` }) }));
vi.mock('@/lib/email/send-signup', () => ({ sendSignupVerifyEmail: vi.fn(async () => ({ ok: true as const, id: 'test-message-id' })) }));

import { controlDb } from '@/db/control-plane';
import { signups } from '@/db/control-plane/schema';
import { TERMS_VERSION } from '@/lib/tenant/lifecycle-config';
import { startSignup } from '@/server/actions/signup';
import { cpReady } from './lifecycle-helpers';

/** R12 (feature-plan-terms-compliance-fixes.md §5.6): signup requires Terms acceptance; version + time are stored. */
describe.skipIf(!cpReady)('signup Terms acceptance (R12)', () => {
  afterEach(async () => {
    await controlDb.delete(signups).where(like(signups.slug, 'test-lc-signup-%'));
  });

  it('rejects a signup without termsAccepted: true and stores nothing', async () => {
    const slug = `test-lc-signup-${Date.now().toString(36)}`;
    const r = await startSignup({ companyName: 'No Terms Co', email: 'a@test.dev', slug, termsAccepted: false });
    expect(r.success).toBe(false);
    expect(await controlDb.select().from(signups).where(eq(signups.slug, slug))).toHaveLength(0);
  });

  it('records the Terms version and acceptance time', async () => {
    const slug = `test-lc-signup-${Date.now().toString(36)}b`;
    const before = Date.now();
    const r = await startSignup({ companyName: 'Terms Co', email: 'b@test.dev', slug, termsAccepted: true });
    expect(r.success).toBe(true);
    const [row] = await controlDb.select().from(signups).where(eq(signups.slug, slug));
    expect(row.termsVersion).toBe(TERMS_VERSION);
    expect(row.termsAcceptedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });
});
