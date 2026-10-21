import 'server-only';
import { getDb } from '@/db';
import { timesheetPeriods } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

export type PeriodStatus = 'draft' | 'submitted' | 'approved' | 'rejected';

export interface PeriodInfo {
  id: string | null;
  status: PeriodStatus;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  reviewComment: string | null;
  periodType: string | null;
  periodNumDays: number | null;
}

/**
 * Get the period status for an arbitrary user and period start date. Returns draft if no record
 * exists yet.
 *
 * INTERNAL — not a server action. Used by saveTimesheetBatch's period-lock check (which already
 * validated the actor owns the entry) and by the self-only getPeriodStatus() action in
 * src/server/actions/periods.ts.
 */
export async function getPeriodStatusFor(userId: string, periodStart: Date): Promise<PeriodInfo> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(timesheetPeriods)
    .where(
      and(
        eq(timesheetPeriods.userId, userId),
        eq(timesheetPeriods.periodStart, periodStart),
      )
    );

  if (rows.length === 0) {
    return {
      id: null,
      status: 'draft',
      submittedAt: null,
      reviewedAt: null,
      reviewedBy: null,
      reviewComment: null,
      periodType: null,
      periodNumDays: null,
    };
  }

  const row = rows[0];
  return {
    id: row.id,
    status: row.status,
    submittedAt: row.submittedAt,
    reviewedAt: row.reviewedAt,
    reviewedBy: row.reviewedBy,
    reviewComment: row.reviewComment,
    periodType: row.periodType ?? null,
    periodNumDays: row.periodNumDays ?? null,
  };
}
