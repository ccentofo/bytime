import { describe, it, expect, vi } from 'vitest';

/**
 * UX-2 ruling on the Approvals scope sentence: n = people the supervisor can approve through a shared CLIN who did not
 * designate them; k = people who designated them; n + k = Home's team (approvableScope). A peer supervisor who merely
 * shares a CLIN is in neither.
 */

vi.mock('server-only', () => ({}));
const h = vi.hoisted(() => ({ facts: null as unknown }));
vi.mock('@/db', () => ({ getDb: async () => ({}) }));
vi.mock('@/server/internal/approval-rules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/internal/approval-rules')>()),
  loadApprovalFacts: async () => h.facts,
}));

import { approvableScope, type ApprovalFacts, type ApprovalUser } from '@/server/internal/approval-rules';
import { getSupervisorScopeInfo } from '@/server/internal/supervisor-scope';

const user = (id: string, role: ApprovalUser['role'], approverId: string | null = null): ApprovalUser => ({ id, role, isActive: true, approverId });

describe('supervisor scope counts (UX-2 ruling)', () => {
  it('one shared-CLIN employee, one shared-CLIN peer supervisor, one designator → n = 1, k = 1, n + k = team', async () => {
    const facts: ApprovalFacts = {
      users: new Map([
        ['S', user('S', 'supervisor')],
        ['E', user('E', 'employee')],         // shares CLIN c1 with S
        ['P', user('P', 'supervisor')],       // shares CLIN c1 with S — a peer, not approvable
        ['D', user('D', 'supervisor', 'S')],  // a supervisor who designated S (only approver roles designate), no shared CLIN
        ['A', user('A', 'admin')],
      ]),
      clinsByUser: new Map([['S', new Set(['c1'])], ['E', new Set(['c1'])], ['P', new Set(['c1'])]]),
    };
    h.facts = facts;
    const info = await getSupervisorScopeInfo('S');
    expect(info).toMatchObject({ approvableEmployeeCount: 1, designatedByCount: 1, assignedClinCount: 1 });
    const team = approvableScope(facts, 'S');
    expect(team.sort()).toEqual(['D', 'E']);
    expect(info.approvableEmployeeCount + info.designatedByCount).toBe(team.length);
  });

  it('a designator who ALSO shares a CLIN counts once (in k), never twice', async () => {
    const facts: ApprovalFacts = {
      users: new Map([['S', user('S', 'supervisor')], ['E', user('E', 'supervisor', 'S')]]),
      clinsByUser: new Map([['S', new Set(['c1'])], ['E', new Set(['c1'])]]),
    };
    h.facts = facts;
    expect(await getSupervisorScopeInfo('S')).toMatchObject({ approvableEmployeeCount: 0, designatedByCount: 1 });
  });
});
