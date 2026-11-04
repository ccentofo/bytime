import * as schema from '@/db/schema';
import { getTestDb, createTestUser, createTestContract, createTestClin } from './helpers';

/**
 * feature-plan-ux-approvals-payroll.md P-5: the Gusto sync fixture, used FIRST by the recorder (on the code before
 * Part 2) and then by the P-5 regression guard. Range Mar 1 – 15, 2026; workweek starts Monday (set by the caller).
 *   - Pat (non-exempt, active): approved Mar 1 (15 days); 9.00 h Mon–Fri Mar 2–6 → 40 regular + 5 overtime.
 *   - Ivy (EXEMPT, INACTIVE): approved Mar 1 (15 days); 10.00 h Mon–Fri Mar 9–13 → 40 regular, 10 uncompensated.
 *   - Mo (non-exempt): a MISALIGNED approved row starting Mar 3 with a NULL period_num_days; 8.00 h on Mar 2, 3, 4, 13.
 *     Mar 2 is before his row, so it stays unapproved (24 h in the payload); snapping his row to the schedule's period
 *     (Mar 1 – 15) would approve it (32 h) — UX-4B2-AUDIT.md M3.
 *   - Eve (non-exempt, active): an expected submitter with no entries (never in the payload).
 * The payload is compared with user ids replaced by names (ids differ per run).
 */
export async function seedPayrollP5Fixture() {
  const db = getTestDb();
  const [pat, ivy, mo, eve] = [
    await createTestUser({ role: 'employee', fullName: 'Pat Doe' }),
    await createTestUser({ role: 'employee', fullName: 'Ivy Exempt', flsaExempt: true, isActive: false }),
    await createTestUser({ role: 'employee', fullName: 'Mo Misaligned' }),
    await createTestUser({ role: 'employee', fullName: 'Eve Nohours' }),
  ];
  const clinId = (await createTestClin((await createTestContract()).id)).id;
  const work = (userId: string, date: string, hours: string) =>
    db.insert(schema.timesheetEntries).values({ userId, clinId, entryDate: date, hours, revisionNumber: 1, createdBy: userId });
  await db.insert(schema.timesheetPeriods).values([
    { userId: pat.id, periodStart: '2026-03-01', periodNumDays: 15, periodType: 'semimonthly', status: 'approved' },
    { userId: ivy.id, periodStart: '2026-03-01', periodNumDays: 15, periodType: 'semimonthly', status: 'approved' },
    { userId: mo.id, periodStart: '2026-03-03', periodNumDays: null, periodType: null, status: 'approved' },
  ]);
  for (const day of ['02', '03', '04', '05', '06']) await work(pat.id, `2026-03-${day}`, '9.00');
  for (const day of ['09', '10', '11', '12', '13']) await work(ivy.id, `2026-03-${day}`, '10.00');
  for (const day of ['02', '03', '04', '13']) await work(mo.id, `2026-03-${day}`, '8.00');
  return { pat, ivy, mo, eve, names: new Map([[pat.id, 'Pat Doe'], [ivy.id, 'Ivy Exempt'], [mo.id, 'Mo Misaligned'], [eve.id, 'Eve Nohours']]) };
}

/** The payload with each userId replaced by the person's name (stable across runs). */
export function normalizePayload(payload: unknown, names: Map<string, string>): unknown {
  return JSON.parse(JSON.stringify(payload), (k, v) => (k === 'userId' && typeof v === 'string' ? names.get(v) ?? v : v));
}
