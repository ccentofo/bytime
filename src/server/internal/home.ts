import 'server-only';
import { getDb } from '@/db';
import { addDays, formatCalendarDate } from '@/lib/calendar-date';
import type { HomeView } from '@/lib/home/attention';
import { approvableScope, loadApprovalFacts } from './approval-rules';
import { approvalQueue } from './approval-queue';
import { approvalNotices } from './approval-notices';
import { overlappingAssignments } from './cost-basis';
import { contractBurnSummary } from './dashboard';
import { currentPeriodSummary } from './employee-dashboard';
import { loadScheduleResolver, pendingConfigChangeInternal } from './pay-period-config';
import { getSetupStatusInternal } from './setup';
import { teamPeriodStatus } from './team-period-status';
import { getWorkspaceTimezone, getWorkspaceToday, workweekStartDayInternal } from './workspace-settings';

const label = (start: string, numDays: number) =>
  `${formatCalendarDate(start as never, 'MMM D')} – ${formatCalendarDate(addDays(start as never, numDays - 1), 'MMM D, YYYY')}`;

/**
 * Home's data (feature-plan-ux-navigation-home.md §4.5). INTERNAL, no guard: home/page.tsx calls
 * requirePageRole('approver') first. The role comes from FRESH approval facts, never the (up to 60 s stale) JWT: a
 * just-demoted admin sees no money, and anyone no longer an active approver is sent to the timesheet. Admin-only parts
 * never run for supervisors (internals, never the requireAdmin actions — trap T-A).
 */
export async function getHomeData(userId: string): Promise<HomeView | { redirect: '/timesheet' }> {
  const db = await getDb();
  const facts = await loadApprovalFacts(db);
  const me = facts.users.get(userId);
  if (!me || !me.isActive || (me.role !== 'admin' && me.role !== 'supervisor')) return { redirect: '/timesheet' };
  const isAdmin = me.role === 'admin';

  const [today, tz, resolver] = await Promise.all([getWorkspaceToday(), getWorkspaceTimezone(), loadScheduleResolver(db)]);
  const cur = resolver.periodContaining(today);
  const prev = resolver.neighbor(cur.start, 'prev');
  const teamScope: 'all' | string[] = isAdmin ? 'all' : approvableScope(facts, userId);

  const [waiting, myPeriod, team, lastTeam, notices, contracts, workweek, pendingConfig, overlaps] = await Promise.all([
    approvalQueue(db, userId, facts, { names: 4 }),
    currentPeriodSummary(db, userId, cur, today),
    teamPeriodStatus(db, cur.start, cur.numDays, teamScope, tz),
    teamPeriodStatus(db, prev.start, prev.numDays, teamScope, tz),
    isAdmin ? approvalNotices(db, userId, facts) : null,
    isAdmin ? contractBurnSummary(db) : null,
    isAdmin ? workweekStartDayInternal(db) : null,
    isAdmin ? pendingConfigChangeInternal(db, today) : null,
    isAdmin ? overlappingAssignments(db) : null,
  ]);

  // Setup's parallel COUNTs run AFTER the main burst (pool max 10 — trap T-I); admins only, no cache().
  const setup = isAdmin ? await getSetupStatusInternal() : null;

  return {
    userId,
    role: isAdmin ? 'admin' : 'supervisor',
    today,
    waiting,
    myPeriod,
    team,
    lastTeam,
    lastPeriodLabel: label(prev.start, prev.numDays),
    admin: isAdmin && notices && contracts && overlaps && setup ? {
      notices,
      contracts: contracts.map((c) => ({ contractId: c.contractId, contractName: c.contractName, status: c.status, fundedValue: c.fundedValue, pricedCost: c.pricedCost, unpricedHours: c.unpricedHours })),
      // ALL contracts (any status): equals the unpriced report "Fix pricing" opens. Active-only applies to the card.
      unpricedTotal: Math.round(contracts.reduce((s, c) => s + c.unpricedHours, 0) * 100) / 100,
      workweekSet: workweek !== null,
      pendingConfig: pendingConfig ? { effectiveFrom: pendingConfig.effectiveFrom } : null,
      overlaps: overlaps.length,
      setup: { isComplete: setup.isComplete, done: setup.done, total: setup.total, steps: setup.steps },
    } : null,
  };
}
