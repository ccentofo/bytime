import 'server-only';
import { cache } from 'react';
import { asc, eq, sql } from 'drizzle-orm';
import { getDb, type ReadDb } from '@/db';
import { timesheetPeriods, users } from '@/db/schema';
import { addDays, formatCalendarDate, type CalendarDate } from '@/lib/calendar-date';
import { canApprove, loadApprovalFacts, type ApprovalFacts } from './approval-rules';
import { existingPeriodLength } from './pay-period-config';

export interface ApprovalQueue {
  /** Submitted periods this approver may decide. */
  count: number;
  /** Distinct people behind them (for "and {k} more"). */
  people: number;
  /** Up to `opts.names` people, oldest submission first, each once. */
  names: string[];
  /** The oldest waiting period ("Oct 1 – Oct 15, 2026"); null when nothing waits or opts.label is false. */
  oldestPeriodLabel: string | null;
}

/**
 * The approver's to-do list (feature-plan-ux-navigation-home.md §4.6, B3, L3): submitted periods filtered by
 * canApprove — the same rule as the Approvals "Waiting" view, so the sidebar count and the list agree. No is_active
 * filter (a deactivated person's submitted period still needs a decision, and canApprove allows it). One lean query;
 * never getScopedPeriods (all history). INTERNAL, no guard: callers pass their own (authorized) actor id.
 */
export async function approvalQueue(
  db: Pick<ReadDb, 'select'>,
  actorId: string,
  facts: ApprovalFacts,
  opts: { names?: number; /** Build oldestPeriodLabel (default true); it may cost a schedule lookup. */ label?: boolean } = {},
): Promise<ApprovalQueue> {
  const rows = await db
    .select({
      id: timesheetPeriods.id,
      userId: timesheetPeriods.userId,
      periodStart: timesheetPeriods.periodStart,
      periodNumDays: timesheetPeriods.periodNumDays,
      submittedAt: timesheetPeriods.submittedAt,
      fullName: users.fullName,
    })
    .from(timesheetPeriods)
    .innerJoin(users, eq(timesheetPeriods.userId, users.id))
    .where(eq(timesheetPeriods.status, 'submitted'))
    // Oldest submission first (never-stamped last); ties by period so the order is stable.
    .orderBy(sql`${timesheetPeriods.submittedAt} ASC NULLS LAST`, asc(timesheetPeriods.periodStart));

  const mine = rows.filter((r) => canApprove(facts, actorId, r.userId));
  const seen = new Set<string>();
  const people: string[] = [];
  for (const r of mine) {
    if (seen.has(r.userId)) continue;
    seen.add(r.userId);
    people.push(r.fullName);
  }
  let oldestPeriodLabel: string | null = null;
  if (mine[0] && opts.label !== false) {
    const start = mine[0].periodStart as CalendarDate;
    const numDays = await existingPeriodLength(db, start, mine[0].periodNumDays);
    oldestPeriodLabel = `${formatCalendarDate(start, 'MMM D')} – ${formatCalendarDate(addDays(start, numDays - 1), 'MMM D, YYYY')}`;
  }
  return { count: mine.length, people: people.length, names: people.slice(0, opts.names ?? people.length), oldestPeriodLabel };
}

/**
 * The sidebar's waiting count (the (app) layout calls it on every page for approvers). React cache() memoizes per
 * request; it compares arguments by identity, so it is keyed on the actor id STRING and loads db + facts inside.
 */
export const getWaitingCount = cache(async (actorId: string): Promise<number> => {
  const db = await getDb();
  const facts = await loadApprovalFacts(db);
  return (await approvalQueue(db, actorId, facts, { names: 0, label: false })).count; // the count only
});
