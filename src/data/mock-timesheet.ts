import dayjs from 'dayjs';
import type { ChargeCode, TimesheetEntry } from '@/types/timesheet';

// Compute the most recent Monday as the bi-weekly period start
const today = dayjs('2026-05-18'); // Fixed date to avoid hydration mismatch
const dayOfWeek = today.day(); // 0=Sun, 1=Mon, ...
const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
export const MOCK_PERIOD_START: Date = today.subtract(daysToMonday, 'day').toDate();

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

// 14-day arrays: Mon–Sun, Mon–Sun (weekends = dayIndex 5,6,12,13)
// Realistic distribution: 8h weekdays, 0h weekends, some variation
export const MOCK_ENTRIES: TimesheetEntry[] = [
  {
    chargeCodeId: 'cc-001',
    //              Mon   Tue   Wed   Thu   Fri   Sat   Sun   Mon   Tue   Wed   Thu   Fri   Sat   Sun
    hours: [8.0, 8.0, 8.0, 8.0, 8.0, 0.0, 0.0, 8.0, 8.0, 8.0, 8.0, 8.0, 0.0, 0.0],
  },
  {
    chargeCodeId: 'cc-002',
    hours: [6.0, 6.0, 6.0, 6.0, 6.0, 0.0, 0.0, 6.0, 6.0, 6.0, 6.0, 6.0, 0.0, 0.0],
  },
  {
    chargeCodeId: 'cc-003',
    hours: [0.0, 2.0, 2.0, 2.0, 2.0, 0.0, 0.0, 0.0, 2.0, 2.0, 2.0, 2.0, 0.0, 0.0],
  },
  {
    chargeCodeId: 'cc-004',
    hours: [2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
  },
  {
    chargeCodeId: 'cc-005',
    hours: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
  },
];

export const REASON_CODES: { value: string; label: string }[] = [
  { value: 'CORRECTION', label: 'Correction of Error' },
  { value: 'LATE_ENTRY', label: 'Late Entry (>24hrs)' },
  { value: 'TRANSFER', label: 'Transfer Between Accounts' },
  { value: 'SUPERVISOR_DIRECTED', label: 'Supervisor-Directed Change' },
  { value: 'OTHER', label: 'Other (explain in comments)' },
];
