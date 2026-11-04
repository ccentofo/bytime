import * as schema from '@/db/schema';
import type { CalendarDate } from '@/lib/calendar-date';
import { getTestDb, createTestUser, createTestContract, createTestClin, createTestChargeCode, createTestIndirectCode } from './helpers';

/**
 * feature-plan-ux-approvals-payroll.md A-4: one review-read fixture, used FIRST by the baseline recorder (on the code
 * before Part 2) and then by the A-4 test. Rob's semi-monthly period Mar 1 – 15, 2026, with a period_num_days snapshot
 * (15), submitted twice (returned once in between):
 *   - code A, Mar 2: rev 1 = 8.00 (plain)
 *   - code A, Mar 3: rev 1 = 8.00, rev 2 = 6.00 (CORRECTION, "Left early.") — before the return
 *   - code A, Mar 4: rev 1 = 4.00 (LATE_ENTRY, "Entered the next morning.") — late, never corrected
 *   - code A, Mar 5: rev 1 = 2.00 (LATE_ENTRY), rev 2 = 3.00 (CORRECTION, "Added the site visit.") — after the return
 *   - overhead, Mar 6: rev 1 = 1.00 (plain)
 *   - a note on code A, Mar 2: "Site visit at Pax River."
 *   events: submitted (Mar 16 09:00 UTC, Rob) → rejected (Mar 16 12:00, Ann, "Please add the site visit.") →
 *           submitted (Mar 16 15:00, Rob)
 */
export const REVIEW_START = '2026-03-01' as CalendarDate;

export async function seedReviewReadFixture() {
  const db = getTestDb();
  const admin = await createTestUser({ role: 'admin', fullName: 'Ann Admin' });
  const rob = await createTestUser({ role: 'employee', fullName: 'Robert Taylor' });
  const clin = await createTestClin((await createTestContract({ name: 'NAVAIR' })).id, { clinNumber: '0001' });
  const code = await createTestChargeCode(clin.id, { code: 'NAV-01' });
  const overhead = await createTestIndirectCode({ code: 'OH-001', category: 'overhead' });
  await db.insert(schema.userChargeCodes).values({ userId: rob.id, chargeCodeId: code.id, isActive: true });

  const t = (iso: string) => new Date(iso);
  const [period] = await db.insert(schema.timesheetPeriods).values({
    userId: rob.id, periodStart: REVIEW_START, periodNumDays: 15, periodType: 'semimonthly', status: 'submitted',
    submittedAt: t('2026-03-16T15:00:00Z'), submittedComment: 'All done.', submissionCount: 2,
  }).returning();
  await db.insert(schema.periodEvents).values([
    { periodId: period.id, userId: rob.id, event: 'submitted', actorId: rob.id, comment: 'First pass.', createdAt: t('2026-03-16T09:00:00Z') },
    { periodId: period.id, userId: rob.id, event: 'rejected', actorId: admin.id, comment: 'Please add the site visit.', createdAt: t('2026-03-16T12:00:00Z') },
    { periodId: period.id, userId: rob.id, event: 'submitted', actorId: rob.id, comment: 'All done.', createdAt: t('2026-03-16T15:00:00Z') },
  ]);

  const entry = (o: { day: string; hours: string; rev: number; reason?: string; comment?: string; at: string; indirect?: boolean }) =>
    db.insert(schema.timesheetEntries).values({
      userId: rob.id, createdBy: rob.id, entryDate: o.day, hours: o.hours, revisionNumber: o.rev,
      ...(o.indirect ? { indirectCodeId: overhead.id } : { chargeCodeId: code.id, clinId: clin.id }),
      changeReasonCode: o.reason ?? null, comment: o.comment ?? null, createdAt: t(o.at),
    });
  await entry({ day: '2026-03-02', hours: '8.00', rev: 1, at: '2026-03-02T21:00:00Z' });
  await entry({ day: '2026-03-03', hours: '8.00', rev: 1, at: '2026-03-03T21:00:00Z' });
  await entry({ day: '2026-03-03', hours: '6.00', rev: 2, reason: 'CORRECTION', comment: 'Left early.', at: '2026-03-10T21:00:00Z' });
  await entry({ day: '2026-03-04', hours: '4.00', rev: 1, reason: 'LATE_ENTRY', comment: 'Entered the next morning.', at: '2026-03-05T13:00:00Z' });
  await entry({ day: '2026-03-05', hours: '2.00', rev: 1, reason: 'LATE_ENTRY', comment: 'Late.', at: '2026-03-06T13:00:00Z' });
  await entry({ day: '2026-03-05', hours: '3.00', rev: 2, reason: 'CORRECTION', comment: 'Added the site visit.', at: '2026-03-16T13:00:00Z' });
  await entry({ day: '2026-03-06', hours: '1.00', rev: 1, indirect: true, at: '2026-03-06T21:00:00Z' });
  await db.insert(schema.timesheetNotes).values({ userId: rob.id, createdBy: rob.id, chargeCodeId: code.id, entryDate: '2026-03-02', body: 'Site visit at Pax River.', revisionNumber: 1 });
  return { admin, rob, code, clin, overhead, periodId: period.id };
}
