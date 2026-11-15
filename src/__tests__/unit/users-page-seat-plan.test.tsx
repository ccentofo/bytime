import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';

/**
 * feature-plan-per-user-billing.md §6.12 (audit round 1, FR2): the Users page passes `displayPlan(plan)` to the client,
 * so a legacy `pro` (or `starter`) row shows the Standard line, and an unknown value the Trial one.
 */
const h = vi.hoisted(() => ({ plan: 'pro', props: null as null | Record<string, unknown> }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/session', () => ({ requirePageRole: async () => ({ id: 'me', role: 'admin' }) }));
vi.mock('@/server/actions/users', () => ({ getUsersForAdminPage: async () => [], getApprovalNotices: async () => [] }));
vi.mock('@/server/actions/assignments', () => ({ getApprovalClinOptions: async () => [] }));
vi.mock('@/server/internal/seats', () => ({ getSeatUsage: async () => ({ limit: 100, currentActive: 7, plan: h.plan }) }));
vi.mock('@/components/approvals/ApprovalNotices', () => ({ ApprovalNotices: () => null }));
vi.mock('@/app/(app)/admin/users/UsersClient', () => ({ UsersClient: (props: Record<string, unknown>) => { h.props = props; return null; } }));

import UsersPage from '@/app/(app)/admin/users/page';

async function seatsFor(plan: string) {
  h.plan = plan;
  const tree = (await UsersPage()) as ReactElement<{ children: ReactElement[] }>;
  const client = tree.props.children.find((c) => (c?.props as Record<string, unknown> | undefined)?.seats) as ReactElement<{ seats: unknown }>;
  return client.props.seats;
}

describe('Users page: the seat line gets displayPlan(plan)', () => {
  it('legacy pro and starter → standard; enterprise; trial; unknown → trial', async () => {
    expect(await seatsFor('pro')).toEqual({ active: 7, limit: 100, plan: 'standard' });
    expect(await seatsFor('starter')).toEqual({ active: 7, limit: 100, plan: 'standard' });
    expect(await seatsFor('enterprise')).toMatchObject({ plan: 'enterprise' });
    expect(await seatsFor('trial')).toMatchObject({ plan: 'trial' });
    expect(await seatsFor('mystery')).toMatchObject({ plan: 'trial' });
  });
});
