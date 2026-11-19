import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SWEEP-FINDINGS.md §5 A2-D1, N1 (lead, 2026-11-19): `subscription-ended` is held during a policy hold and nothing else
 * re-queues it once the end is recorded, so `unsuspend` queues it (in its locked transaction) for an ended, non-exempt
 * workspace. enqueueNotice decides insert / revive / no-op (integration: tenant-admin.test.ts).
 */

const h = vi.hoisted(() => ({ enqueued: [] as Array<{ tenantId: string; kind: string; anchor: Date }> }));

vi.mock('server-only', () => ({}));
vi.mock('@/db/control-plane/locked', () => ({ withLockedPool: async () => { throw new Error('not used'); }, withTenantLock: async () => { throw new Error('not used'); } }));
vi.mock('@/lib/tenant/notices', () => ({
  LEASE_MINUTES: 10,
  redactExportPayload: (p: unknown) => p,
  enqueueNotice: async (_tx: unknown, tenantId: string, kind: string, anchor: Date) => { h.enqueued.push({ tenantId, kind, anchor }); return 'n1'; },
}));

import { plans } from '@/lib/tenant/admin-commands';
import type { TenantRow } from '@/lib/tenant/lifecycle-store';
import type { ControlTx } from '@/db/control-plane/locked';

const E = new Date('2026-07-01T00:00:00Z');
const held = (o: Partial<TenantRow> = {}) => ({
  id: 't1', status: 'suspended', suspensionReason: 'policy', suspendedAt: new Date('2026-06-01T00:00:00Z'),
  subscriptionEndedAt: null, lifecycleExempt: false, ...o,
}) as unknown as TenantRow;
const plan = (row: TenantRow) => plans.unsuspend()(row, {} as never, new Date());

beforeEach(() => { h.enqueued = []; });

describe('N1: unsuspend re-queues subscription-ended', () => {
  it('an ended workspace → enqueueNotice(subscription-ended, anchored on the end) in the locked transaction', async () => {
    const p = plan(held({ subscriptionEndedAt: E }));
    expect(p.patch).toMatchObject({ status: 'active', suspensionReason: null });
    await p.after!({} as ControlTx, new Date());
    expect(h.enqueued).toEqual([{ tenantId: 't1', kind: 'subscription-ended', anchor: E }]);
  });

  it('not ended, or lifecycle-exempt (F1: no lifecycle emails) → nothing queued', () => {
    expect(plan(held()).after).toBeUndefined();
    expect(plan(held({ subscriptionEndedAt: E, lifecycleExempt: true })).after).toBeUndefined();
  });
});
