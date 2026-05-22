import dayjs from 'dayjs';
import type { ChargeCode, TimesheetEntry } from '@/types/timesheet';

// Semi-monthly period: May 16 – May 31, 2026
export const MOCK_PERIOD_START: Date = dayjs('2026-05-16').toDate();

export const MOCK_CHARGE_CODES: ChargeCode[] = [
  {
    id: 'cc-001',
    projectName: 'NAVAIR Systems Support',
    clin: 'CLIN 0001AA',
    description: 'Systems engineering & technical assistance for NAVAIR PMA-265',
  },
  {
    id: 'cc-002',
    projectName: 'DISA Cyber Operations',
    clin: 'CLIN 0002AB',
    description: 'Cybersecurity operations support for DISA Joint Service Provider',
  },
  {
    id: 'cc-003',
    projectName: 'DHS Border Security Analytics',
    clin: 'CLIN 0003',
    description: 'Data analytics and reporting for CBP border operations',
  },
  {
    id: 'cc-004',
    projectName: 'Army Logistics Modernization',
    clin: 'CLIN 0004BA',
    description: 'ERP integration and sustainment for Army G-4 logistics systems',
  },
  {
    id: 'cc-005',
    projectName: 'Overhead / G&A',
    clin: 'CLIN 0099',
    description: 'General & administrative overhead — non-billable indirect',
  },
];

export function getNumDaysInPeriod(periodStart: Date): number {
  const d = dayjs(periodStart);
  if (d.date() === 1) {
    return 15; // 1st through 15th
  }
  // 16th through end of month
  return d.daysInMonth() - 15;
}

export function generateMockEntries(periodStart: Date): TimesheetEntry[] {
  const numDays = getNumDaysInPeriod(periodStart);

  // For each charge code, generate hours based on day-of-week
  // Weekdays get hours, weekends get 0
  const patterns: Record<string, number> = {
    'cc-001': 8.0,
    'cc-002': 6.0,
    'cc-003': 2.0,
    'cc-004': 2.0,
    'cc-005': 0.0,
  };

  return MOCK_CHARGE_CODES.map((cc) => {
    const dailyHours = patterns[cc.id] ?? 0;
    const hours: number[] = [];
    for (let i = 0; i < numDays; i++) {
      const date = dayjs(periodStart).add(i, 'day');
      const dow = date.day(); // 0=Sun, 6=Sat
      const isWeekend = dow === 0 || dow === 6;
      // cc-003 gets 0 on Mondays, cc-004 gets hours only on Mondays
      if (cc.id === 'cc-003') {
        hours.push(isWeekend || dow === 1 ? 0 : dailyHours);
      } else if (cc.id === 'cc-004') {
        hours.push(dow === 1 ? dailyHours : 0);
      } else {
        hours.push(isWeekend ? 0 : dailyHours);
      }
    }
    return { chargeCodeId: cc.id, hours };
  });
}

export const MOCK_ENTRIES: TimesheetEntry[] = generateMockEntries(MOCK_PERIOD_START);

export const REASON_CODES: { value: string; label: string }[] = [
  { value: 'CORRECTION', label: 'Correction of Error' },
  { value: 'LATE_ENTRY', label: 'Late Entry (>24hrs)' },
  { value: 'TRANSFER', label: 'Transfer Between Accounts' },
  { value: 'SUPERVISOR_DIRECTED', label: 'Supervisor-Directed Change' },
  { value: 'OTHER', label: 'Other (explain in comments)' },
];
