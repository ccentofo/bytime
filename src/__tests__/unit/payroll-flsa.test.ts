import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { computeFlsa, toCents, workweekStart, type FlsaEntry, type HoursKind } from '@/lib/payroll/flsa';
import { escapeCsvField, FORMULA_PATTERN } from '@/lib/csv/escape';
import { generateCsv } from '@/lib/reports/csv-generator';
import { FORMULA_PATTERN as EXPORT_FORMULA_PATTERN } from '@/lib/export/workspace-export';
import {
  DAILY_DETAIL_HEADERS, generateDailyDetailCSV, generatePayrollCSV, payrollFilename, PAYROLL_FORMATS, type PayrollRow,
} from '@/lib/integrations/connectors/payroll-export';
import type { CalendarDate } from '@/lib/calendar-date';

/**
 * feature-plan-certified-outputs.md C7 / §9 rows "FLSA", "Leave columns", "Gusto / exempt", "CSV": the pure FLSA
 * weekly-overtime walk (integer hundredths), the file layouts, and the shared CSV escaping.
 */

const ROOT = path.resolve(__dirname, '../../..');
const d = (s: string) => s as CalendarDate;
const MON = 1;
// October 2026: Thu 1, Fri 2, Sat 3, Sun 4, Mon 5 … Fri 9, … Mon 12 … Thu 15, Fri 16.
const e = (date: string, hours: string, kind: HoursKind = 'worked', userId = 'u1', billable = true): FlsaEntry =>
  ({ userId, date: d(date), kind, cents: toCents(hours), billable });
const run = (entries: FlsaEntry[], o: { start?: string; end?: string; exempt?: boolean; unapproved?: string[] } = {}) => computeFlsa({
  entries,
  exempt: () => o.exempt ?? false,
  workweekStartDay: MON,
  rangeStart: d(o.start ?? '2026-10-05'),
  rangeEnd: d(o.end ?? '2026-10-11'),
  dayInfo: (_u, date) => ({ approved: !(o.unapproved ?? []).includes(date) }),
});
const week = (hours: string[], start = 5) => hours.map((h, i) => e(`2026-10-${String(start + i).padStart(2, '0')}`, h));

describe('FLSA weekly overtime (pure)', () => {
  it('workweekStart: the first day of the week containing the date, for any start day (0 = Sunday)', () => {
    expect(workweekStart(d('2026-10-08'), 1)).toBe('2026-10-05'); // Thu → Mon
    expect(workweekStart(d('2026-10-05'), 1)).toBe('2026-10-05');
    expect(workweekStart(d('2026-10-04'), 1)).toBe('2026-09-28'); // Sun → previous Mon
    expect(workweekStart(d('2026-10-08'), 0)).toBe('2026-10-04');
    expect(workweekStart(d('2026-10-08'), 4)).toBe('2026-10-08');
    expect(workweekStart(d('2026-10-07'), 4)).toBe('2026-10-01');
  });

  it('45 h week → 40 regular + 5 OT, the OT on the day the 40th hour passes', () => {
    const { employees, days } = run(week(['9', '9', '9', '9', '9']));
    expect(employees[0]).toMatchObject({ regular: 4000, overtime: 500, uncompensatedOvertime: 0, totalPaid: 4500 });
    expect(days.map((x) => [x.date, x.regular, x.overtime])).toEqual([
      ['2026-10-05', 900, 0], ['2026-10-06', 900, 0], ['2026-10-07', 900, 0], ['2026-10-08', 900, 0], ['2026-10-09', 400, 500],
    ]);
  });

  it('exactly 40.00 h from fractional days → 0 OT (integer hundredths, no float residue)', () => {
    // As floats, 8.29 × 4 + 6.84 hours × 100 = 3999.9999999999995 — in hundredths it is exactly 4000.
    const { employees } = run(week(['8.29', '8.29', '8.29', '8.29', '6.84']));
    expect(employees[0]).toMatchObject({ regular: 4000, overtime: 0, totalPaid: 4000 });
    expect(['8.29', '8.29', '8.29', '8.29', '6.84'].reduce((s, h) => s + toCents(h), 0)).toBe(4000);
  });

  it('leave never counts toward the 40: 40 h worked + 8 h holiday → 0 OT, holiday 8 in its own column', () => {
    // The holiday comes FIRST in the week, so counting it would push Saturday's hours into overtime.
    const { employees } = run([e('2026-10-05', '8', 'holiday'), ...week(['8', '8', '8', '8', '8'], 6)]);
    expect(employees[0]).toMatchObject({ regular: 4000, overtime: 0, holiday: 800, totalPaid: 4800 });
    const allLeave = run([e('2026-10-05', '8', 'pto'), e('2026-10-06', '8', 'sick'), ...week(['8', '8', '8', '8', '8'], 7)]);
    expect(allLeave.employees[0]).toMatchObject({ regular: 4000, overtime: 0 });
  });

  it('PTO / sick / holiday paid in their own columns; unpaid leave never in a paid total (Total recorded includes it)', () => {
    const { employees } = run([e('2026-10-05', '8', 'pto'), e('2026-10-06', '8', 'sick'), e('2026-10-07', '4', 'unpaid'), e('2026-10-07', '4')]);
    expect(employees[0]).toMatchObject({ regular: 400, pto: 800, sick: 800, unpaidLeave: 400, totalPaid: 2000, totalRecorded: 2400 });
  });

  it('exempt → 0 OT and the hours beyond 40 as uncompensated overtime', () => {
    const { employees, days } = run(week(['9', '9', '9', '9', '9']), { exempt: true });
    expect(employees[0]).toMatchObject({ regular: 4000, overtime: 0, uncompensatedOvertime: 500, totalPaid: 4000, totalRecorded: 4500 });
    expect(days[4]).toMatchObject({ overtime: 0, uncompensatedOvertime: 500 });
  });

  it('boundary week: days before the range count toward its 40 but are never reported (no double count across two exports)', () => {
    // Week Mon 12 – Sun 18; semi-monthly exports [1–15] and [16–31]. Mon–Thu 12–15: 4×9 = 36 h; Fri 16: 9 h.
    const entries = [...week(['9', '9', '9', '9'], 12), e('2026-10-16', '9')];
    const first = run(entries, { start: '2026-10-01', end: '2026-10-15' });
    const second = run(entries, { start: '2026-10-16', end: '2026-10-31' });
    expect(first.employees[0]).toMatchObject({ regular: 3600, overtime: 0 });
    expect(second.employees[0]).toMatchObject({ regular: 400, overtime: 500 });
    expect(second.days.map((x) => x.date)).toEqual(['2026-10-16']);
    expect(first.employees[0].overtime + second.employees[0].overtime).toBe(500);
    expect(first.employees[0].regular + second.employees[0].regular).toBe(4000);
  });

  it('unapproved days earlier in the workweek count toward the 40; they are not output; the employee is flagged', () => {
    const r = run(week(['9', '9', '9', '9', '9']), { unapproved: ['2026-10-05', '2026-10-06'] });
    expect(r.days.map((x) => x.date)).toEqual(['2026-10-07', '2026-10-08', '2026-10-09']);
    expect(r.employees[0]).toMatchObject({ regular: 2200, overtime: 500, otBasisIncludesUnapprovedDays: true });
  });

  it('F10: unapproved earlier days with NO overtime on the reported days → not flagged', () => {
    const r = run(week(['8', '8', '8', '8', '8']), { unapproved: ['2026-10-05', '2026-10-06'] });
    expect(r.employees[0]).toMatchObject({ regular: 2400, overtime: 0, otBasisIncludesUnapprovedDays: false });
    const exempt = run(week(['9', '9', '9', '9', '9']), { unapproved: ['2026-10-05'], exempt: true });
    expect(exempt.employees[0]).toMatchObject({ uncompensatedOvertime: 500, otBasisIncludesUnapprovedDays: true });
  });

  it('an unapproved day AFTER the reported days does not flag (it cannot change their split)', () => {
    const r = run(week(['9', '9', '9', '9', '9']), { unapproved: ['2026-10-09'] });
    expect(r.employees[0]).toMatchObject({ regular: 3600, overtime: 0, otBasisIncludesUnapprovedDays: false });
  });

  it('each workweek stands alone (no averaging); employees with nothing reported are omitted', () => {
    const r = run([...week(['10', '10', '10', '10', '10']), ...week(['6', '6', '6', '6', '6'], 12), e('2026-10-05', '8', 'worked', 'u2')], {
      start: '2026-10-05', end: '2026-10-18', unapproved: [],
    });
    expect(r.employees.find((x) => x.userId === 'u1')).toMatchObject({ regular: 7000, overtime: 1000 });
    const none = run([e('2026-10-05', '8')], { unapproved: ['2026-10-05'] });
    expect(none.employees).toEqual([]);
  });
});

describe('file layouts (CO-D11 leave columns, CO-D14 no uncompensated OT in vendor files)', () => {
  const row: PayrollRow = {
    employeeName: 'Pat Q Doe', employeeEmail: 'pat@x', regular: 4000, overtime: 500, uncompensatedOvertime: 0, pto: 800, sick: 400,
    holiday: 800, unpaidLeave: 300, billable: 3000, totalPaid: 6500, totalRecorded: 6800,
  };
  const rowsOf = (csv: string) => csv.split('\n').map((l) => l.split(','));
  const fmt = (id: string) => PAYROLL_FORMATS.find((f) => f.id === id)!;
  const S = d('2026-10-01');
  const E = d('2026-10-15');

  it('ADP: Regular = worked only; PTO / Sick / Holiday columns; Total = Regular + OT + PTO + Sick + Holiday', () => {
    const [header, values] = rowsOf(generatePayrollCSV([row], fmt('adp'), S, E));
    const col = (n: string) => values[header.indexOf(n)];
    expect(col('Regular Hours')).toBe('40.00');
    expect(col('OT Hours')).toBe('5.00');
    expect([col('PTO Hours'), col('Sick Hours'), col('Holiday Hours')]).toEqual(['8.00', '4.00', '8.00']);
    expect(col('Total Hours')).toBe('65.00');
    expect(col('Period Start')).toBe('10/01/2026');
  });

  it('Paychex: REG / OT / PTO / SICK / HOL pairs, earnings code blank when 0', () => {
    const [header, values] = rowsOf(generatePayrollCSV([{ ...row, sick: 0 }], fmt('paychex'), S, E));
    const col = (n: string) => values[header.indexOf(n)];
    expect([col('Hours'), col('Earnings Code'), col('OT Hours'), col('OT Earnings Code')]).toEqual(['40.00', 'REG', '5.00', 'OT']);
    expect([col('PTO Earnings Code'), col('Sick Earnings Code'), col('Holiday Earnings Code')]).toEqual(['PTO', '', 'HOL']);
  });

  it('Gusto CSV: regular/overtime/pto/sick/holiday columns, no `hours` column, columns sum to total paid', () => {
    const [header, values] = rowsOf(generatePayrollCSV([row], fmt('gusto'), S, E));
    expect(header).toEqual(['employee_email', 'employee_name', 'regular_hours', 'overtime_hours', 'pto_hours', 'sick_hours', 'holiday_hours', 'pay_period_start', 'pay_period_end']);
    expect(header).not.toContain('hours');
    expect(values.slice(2, 7).reduce((s, v) => s + toCents(v), 0)).toBe(row.totalPaid);
  });

  it('no vendor file carries uncompensated OT or unpaid leave; Custom carries both plus Total paid / Total recorded', () => {
    for (const id of ['adp', 'paychex', 'gusto']) {
      expect(fmt(id).columns.map((c) => c.header).join('|'), id).not.toMatch(/uncompensated|unpaid/i);
    }
    const [header, values] = rowsOf(generatePayrollCSV([{ ...row, uncompensatedOvertime: 200 }], fmt('custom'), S, E));
    const col = (n: string) => values[header.indexOf(n)];
    expect(col('Uncompensated Overtime (exempt)')).toBe('2.00');
    expect(col('Unpaid Leave Hours')).toBe('3.00');
    expect(col('Total Paid Hours')).toBe('65.00');
    expect(col('Total Recorded Hours')).toBe('68.00');
    expect(col('Non-Billable Hours')).toBe('38.00');
  });

  it('Daily hours detail: one row per employee-date with the workweek start used; filenames say "FLSA weekly overtime"', () => {
    const csv = generateDailyDetailCSV([{ employeeName: 'Pat', employeeEmail: 'p@x', date: d('2026-10-09'), workweekStart: d('2026-10-05'), worked: 900, regular: 400, overtime: 500, uncompensatedOvertime: 0, pto: 0, sick: 0, holiday: 0, unpaidLeave: 0 }]);
    const [header, values] = rowsOf(csv);
    expect(header).toEqual(DAILY_DETAIL_HEADERS);
    expect(values).toEqual(['Pat', 'p@x', '2026-10-09', '9.00', '4.00', '5.00', '0.00', '0.00', '0.00', '0.00', '0.00', '2026-10-05']);
    expect(payrollFilename('adp', S, E)).toBe('payroll-adp-flsa-weekly-overtime-2026-10-01-to-2026-10-15.csv');
  });
});

describe('CSV escaping (one helper for payroll, report CSVs and the workspace export)', () => {
  it('formula-leading values are prefixed with \'; plain negatives untouched; CR/LF/quote/delimiter quoted', () => {
    expect(escapeCsvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(escapeCsvField('+1+1')).toBe("'+1+1");
    expect(escapeCsvField('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(escapeCsvField('\tx')).toBe("'\tx");
    expect(escapeCsvField('-cmd')).toBe("'-cmd");
    expect(escapeCsvField('-12.50')).toBe('-12.50');
    expect(escapeCsvField('a\rb')).toBe('"a\rb"');
    expect(escapeCsvField('a\nb')).toBe('"a\nb"');
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('a;b', ';')).toBe('"a;b"');
    expect(escapeCsvField('Pat Doe')).toBe('Pat Doe');
  });

  it('payroll CSV and report CSV use it; the workspace export re-exports the same pattern', () => {
    const payroll = generatePayrollCSV([{ employeeName: '=cmd|x', employeeEmail: '@e', regular: 0, overtime: 0, uncompensatedOvertime: 0, pto: 0, sick: 0, holiday: 0, unpaidLeave: 0, billable: 0, totalPaid: 0, totalRecorded: 0 }],
      PAYROLL_FORMATS.find((f) => f.id === 'gusto')!, d('2026-10-01'), d('2026-10-15'));
    expect(payroll.split('\n')[1].startsWith("'@e,'=cmd|x,")).toBe(true);
    expect(generateCsv([{ name: '=1+1' }], [{ key: 'name', header: 'Name' }])).toBe("Name\n'=1+1");
    expect(EXPORT_FORMULA_PATTERN).toBe(FORMULA_PATTERN);
    for (const rel of ['src/lib/reports/csv-generator.ts', 'src/lib/integrations/connectors/payroll-export.ts']) {
      expect(readFileSync(path.join(ROOT, rel), 'utf8'), rel).toMatch(/from '@\/lib\/csv\/escape'/);
    }
  });
});
