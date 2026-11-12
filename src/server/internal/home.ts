import 'server-only';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { users } from '@/db/schema';
import { addDays, calendarDayOf, formatCalendarDate } from '@/lib/calendar-date';
import type { HomeView } from '@/lib/home/attention';
import { approvableScope, loadApprovalFacts } from './approval-rules';
import { approvalQueue } from './approval-queue';
import { approvalNotices } from './approval-notices';
import { approvalScopesToReview } from './approval-scopes';
import { overlappingAssignments } from './cost-basis';
import { contractBurnSummary } from './dashboard';
import { currentPeriodSummary } from './employee-dashboard';
import { loadScheduleResolver, pendingConfigChangeInternal } from './pay-period-config';
import { getSetupStatusInternal } from './setup';
import { teamPeriodStatus } from './team-period-status';
import { getWorkspaceTimezone, getWorkspaceToday } from './workspace-settings';

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

  // H4: the user's creation time is read HERE, before the burst (pool max 10 — trap T-I), not inside it.
  const [today, tz, resolver, [created]] = await Promise.all([
    getWorkspaceToday(),
    getWorkspaceTimezone(),
    loadScheduleResolver(db),
    db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, userId)).limit(1),
  ]);
  // feature-plan-launch-hardening.md H4: "X of Y workdays" counts from the account's creation day.
  const createdOn = calendarDayOf(created?.createdAt ?? new Date(), tz);
  const cur = resolver.periodContaining(today);
  const prev = resolver.neighbor(cur.start, 'prev');
  const teamScope: 'all' | string[] = isAdmin ? 'all' : approvableScope(facts, userId);

  const [waiting, myPeriod, team, lastTeam, notices, contracts, pendingConfig, overlaps] = await Promise.all([
    approvalQueue(db, userId, facts, { names: 4 }),
    currentPeriodSummary(db, userId, cur, today, createdOn),
    teamPeriodStatus(db, cur.start, cur.numDays, teamScope, tz),
    teamPeriodStatus(db, prev.start, prev.numDays, teamScope, tz),
    isAdmin ? approvalNotices(db, userId, facts) : null,
    isAdmin ? contractBurnSummary(db) : null,
    isAdmin ? pendingConfigChangeInternal(db, today) : null,
    isAdmin ? overlappingAssignments(db) : null,
  ]);

  // Setup's parallel COUNTs run AFTER the main burst (pool max 10 — trap T-I); admins only, no cache().
  const setup = isAdmin ? await getSetupStatusInternal() : null;
  // feature-plan-approval-scope.md §4.2: one more query, after the burst and after setup's COUNTs, never alongside them.
  const scopesToReview = isAdmin ? await approvalScopesToReview(db) : 0;

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
      pendingConfig: pendingConfig ? { effectiveFrom: pendingConfig.effectiveFrom } : null,
      overlaps: overlaps.length,
      setup: { isComplete: setup.isComplete, requiredDone: setup.requiredDone, requiredTotal: setup.requiredTotal, steps: setup.steps.map((s) => ({ key: s.key, done: s.done, required: s.required })) },
      // Outside the gate above: 0 is the usual value and must not hide the admin section.
      approvalScopesToReview: scopesToReview,
    } : null,
  };
}
