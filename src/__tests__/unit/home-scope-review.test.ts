import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * feature-plan-approval-scope.md §4.2 / AS-13 (Home half): `admin.approvalScopesToReview` sits OUTSIDE the admin section's
 * truthiness gate — a count of 0 still renders the section — and the count query runs after the main burst and after
 * setup's parallel COUNTs, never alongside them (pool max 10).
 */

const h = vi.hoisted(() => {
  const order: string[] = [];
  const later = <T,>(label: string, value: T) => async () => { order.push(`${label}:start`); await new Promise((r) => setTimeout(r, 5)); order.push(`${label}:end`); return value; };
  /** H4: the arguments currentPeriodSummary was called with. */
  const summaryCalls: unknown[][] = [];
  return { order, count: 0, later, summaryCalls };
});
vi.mock('server-only', () => ({}));
// H4: Home's one direct query — the user's creation time, read BEFORE the burst (logged as 'created').
vi.mock('@/db', () => ({
  getDb: async () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => { h.order.push('created'); return [{ createdAt: new Date('2026-11-05T03:00:00Z') }]; } }) }) }),
  }),
}));
vi.mock('@/server/internal/approval-rules', () => ({
  loadApprovalFacts: async () => ({ users: new Map([['admin-1', { id: 'admin-1', role: 'admin', isActive: true, approverId: null }]]), clinsByUser: new Map(), scopeClinsBySupervisor: new Map() }),
  approvableScope: () => [],
}));
vi.mock('@/server/internal/approval-queue', () => ({ approvalQueue: h.later('burst', { count: 0, people: 0, names: [], oldestPeriodLabel: null }) }));
vi.mock('@/server/internal/employee-dashboard', () => ({
  currentPeriodSummary: (...args: unknown[]) => { h.summaryCalls.push(args); return h.later('burst', {})(); },
}));
vi.mock('@/server/internal/team-period-status', () => ({ teamPeriodStatus: h.later('burst', {}) }));
vi.mock('@/server/internal/approval-notices', () => ({ approvalNotices: h.later('burst', { selfApprovalBackOn: null, recommendDesignee: false }) }));
vi.mock('@/server/internal/dashboard', () => ({ contractBurnSummary: h.later('burst', []) }));
vi.mock('@/server/internal/cost-basis', () => ({ overlappingAssignments: h.later('burst', []) }));
vi.mock('@/server/internal/pay-period-config', () => ({
  loadScheduleResolver: async () => ({ periodContaining: () => ({ start: '2026-11-01', numDays: 15 }), neighbor: () => ({ start: '2026-10-16', numDays: 16 }) }),
  pendingConfigChangeInternal: h.later('burst', null),
}));
vi.mock('@/server/internal/workspace-settings', () => ({
  getWorkspaceToday: async () => '2026-11-10', getWorkspaceTimezone: async () => 'America/New_York', workweekStartDayInternal: h.later('burst', 1),
}));
vi.mock('@/server/internal/setup', () => ({ getSetupStatusInternal: h.later('setup', { isComplete: true, requiredDone: 6, requiredTotal: 6, steps: [] }) }));
vi.mock('@/server/internal/approval-scopes', () => ({ approvalScopesToReview: async () => { h.order.push('count'); return h.count; } }));

import { getHomeData } from '@/server/internal/home';
import type { HomeView } from '@/lib/home/attention';

beforeEach(() => { h.order.length = 0; h.count = 0; h.summaryCalls.length = 0; });

describe('Home: approval scopes to review (AS-13)', () => {
  it('a count of 0 still renders the admin section (0 is outside the gate); a count of 3 is passed through', async () => {
    const zero = await getHomeData('admin-1') as HomeView;
    expect(zero.admin).not.toBeNull();
    expect(zero.admin!.approvalScopesToReview).toBe(0);
    h.count = 3;
    expect((await getHomeData('admin-1') as HomeView).admin!.approvalScopesToReview).toBe(3);
  });

  it('the count runs after every burst query and after setup, never alongside them', async () => {
    await getHomeData('admin-1');
    const at = h.order.indexOf('count');
    expect(at).toBe(h.order.length - 1);
    expect(h.order.filter((e) => e.endsWith(':start')).length).toBe(h.order.filter((e) => e.endsWith(':end')).length);
    expect(h.order.lastIndexOf('setup:end')).toBeLessThan(at);
    expect(h.order.lastIndexOf('burst:end')).toBeLessThan(h.order.indexOf('setup:start'));
  });
});

/**
 * feature-plan-launch-hardening.md H4 (T10, Home half): Home's progress counts from the account's creation day, read in
 * the small Promise.all BEFORE the burst (pool max 10 — trap T-I) and passed to currentPeriodSummary.
 */
describe('Home: the creation day (H4, T10)', () => {
  it('the creation read runs before any burst query, and currentPeriodSummary gets the creation day in the workspace timezone', async () => {
    await getHomeData('admin-1');
    expect(h.order.indexOf('created')).toBeGreaterThanOrEqual(0);
    expect(h.order.indexOf('created')).toBeLessThan(h.order.indexOf('burst:start'));
    expect(h.order.filter((e) => e === 'created')).toHaveLength(1);
    expect(h.summaryCalls).toHaveLength(1);
    // 2026-11-05T03:00Z is Nov 4 in America/New_York.
    expect(h.summaryCalls[0][4]).toBe('2026-11-04');
  });
});

