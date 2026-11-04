// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

/**
 * feature-plan-ux-approvals-payroll.md §4.2 / P-3, P-4 (and certified-outputs fix round 1, F4 / F10):
 * P-3 — opens on the last pay period with the server's preview (no read on mount); a preset change previews again; a
 *       stale preview is dropped; the F10 "Overtime uses unapproved days" Notice precedes Download in the DOM and goes
 *       when the range changes; "not in this file" with Review links to /admin/approvals?review=; footer totals and
 *       exempt "—"; the remembered format is validated; the explanation is a collapsed accordion.
 * P-4 — F4 in the HANDLER: a click while the preview loads, or after a range change before the new preview, never
 *       generates a file; the downloads are WriteButtons with useBusy props and no `disabled`.
 */

const actions = vi.hoisted(() => ({ preview: vi.fn(), csv: vi.fn() }));
vi.mock('@/server/actions/payroll-export', () => ({ getPayrollExportPreview: actions.preview, generatePayrollExportCSV: actions.csv }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { PayrollExportClient, FORMAT_KEY, type PayrollPresets } from '@/app/(app)/admin/payroll-export/PayrollExportClient';
import { click, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';
import type { CalendarDate } from '@/lib/calendar-date';

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:x');
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  actions.csv.mockResolvedValue({ ok: true, data: { csvContent: 'a,b', filename: 'f.csv', employeeCount: 1, totalPaidHours: 45, flaggedCount: 0 } });
});
afterEach(() => { unmount(m); m = undefined; vi.restoreAllMocks(); });

const c = (s: string) => s as CalendarDate;
const PRESETS: PayrollPresets = {
  last: { start: c('2026-10-01'), end: c('2026-10-15'), label: 'Oct 1 – 15, 2026' },
  current: { start: c('2026-10-16'), end: c('2026-10-31'), label: 'Oct 16 – 31, 2026' },
  previous: { start: c('2026-09-16'), end: c('2026-09-30'), label: 'Sep 16 – 30, 2026' },
};
const emp = (name: string, o: Record<string, unknown> = {}) => ({
  userId: `u-${name}`, employeeName: name, employeeEmail: `${name}@x`, flsaExempt: false, regularHours: 40, overtimeHours: 5,
  uncompensatedOvertimeHours: 0, ptoHours: 0, sickHours: 0, holidayHours: 0, unpaidLeaveHours: 0, totalPaidHours: 45, totalRecordedHours: 45,
  otBasisIncludesUnapprovedDays: false, paidLeave: 0, ...o,
});
const ni = (name: string, status: string, o: Record<string, unknown> = {}) => ({
  userId: `u-${name}`, employeeName: name, periodId: null, periodStart: '2026-10-01', periodEnd: '2026-10-15', status, hoursInRange: 0,
  submittedAt: null, returnedAt: null, partlyIncluded: false, canReview: false, ...o,
});
const ready = (o: Record<string, unknown> = {}) => ({
  ok: true as const,
  data: {
    status: 'ready', workweekStartDay: 1, reportedDays: 5,
    employees: [emp('Pat Doe', { otBasisIncludesUnapprovedDays: true }), emp('Ivy Exempt', { flsaExempt: true, overtimeHours: 0, totalPaidHours: 40, paidLeave: 8 })],
    totals: { people: 2, regular: 80, overtime: 5, paidLeave: 8, totalPaid: 85 },
    notIncluded: [
      ni('Sue Submitted', 'submitted', { periodId: 'p-sue', canReview: true, hoursInRange: 80 }),
      ni('Rae Returned', 'rejected', { periodId: 'p-rae', returnedAt: '2026-10-18T14:00:00.000Z', hoursInRange: 72.5 }),
      ni('Pat Doe', 'none', { periodStart: '2026-10-16', periodEnd: '2026-10-31', partlyIncluded: true }),
    ],
    ...o,
  },
});
const quiet = () => ({ ok: true as const, data: { status: 'ready', workweekStartDay: 1, reportedDays: 0, employees: [], totals: { people: 0, regular: 0, overtime: 0, paidLeave: 0, totalPaid: 0 }, notIncluded: [] } });
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

const render = async (initial: unknown = ready()) => {
  m = await mount(<PayrollExportClient presets={PRESETS} initialPreview={initial as never} timeZone="America/New_York" />);
  await wait(10);
};
const input = (label: string) => document.getElementById([...m!.container.querySelectorAll('label')].find((l) => l.textContent?.trim().startsWith(label))!.htmlFor) as HTMLInputElement;
const pick = async (label: string, option: string) => {
  const el = input(label);
  await click(el);
  await click([...document.getElementById(el.getAttribute('aria-controls')!)!.querySelectorAll('[role="option"]')].find((o) => o.textContent === option));
};
const byTestId = (id: string) => m!.container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('Payroll export (P-3)', () => {
  it('opens on the last pay period with the server\'s preview (no read on mount); header; no back link', async () => {
    await render();
    expect(input('Pay period').value).toBe('Last pay period · Oct 1 – 15, 2026');
    expect(actions.preview).not.toHaveBeenCalled();
    expect(m!.container.querySelector('h1')!.textContent).toBe('Payroll export');
    expect(m!.container.textContent).toContain('Approved hours for a pay period, formatted for your payroll system, with weekly overtime worked out.');
    expect(m!.container.textContent).not.toContain('Back to reports');
    expect(byTestId('payroll-in-file')!.textContent).toContain('Pat Doe');
  });

  it('a preset change previews that range; a stale response is dropped', async () => {
    await render();
    const slow = deferred<unknown>();
    actions.preview.mockImplementationOnce(() => slow.promise).mockResolvedValueOnce(quiet());
    await pick('Pay period', 'This pay period · Oct 16 – 31, 2026');
    expect(actions.preview).toHaveBeenLastCalledWith({ periodStart: '2026-10-16', periodEnd: '2026-10-31' });
    await pick('Pay period', 'Sep 16 – 30, 2026');
    expect(actions.preview).toHaveBeenLastCalledWith({ periodStart: '2026-09-16', periodEnd: '2026-09-30' });
    await wait(10);
    expect(byTestId('payroll-in-file')!.textContent).toContain('No approved hours in this pay period.');
    await act(async () => { slow.resolve(ready()); });       // the Oct 16 – 31 preview arrives late
    await wait(10);
    expect(byTestId('payroll-in-file')!.textContent).not.toContain('Pat Doe');
  });

  it('F10: the flagged Notice precedes Download in the DOM, names the people, marks them, and goes when the range changes', async () => {
    await render();
    const notice = byTestId('payroll-flagged')!;
    expect(notice.textContent).toContain('Overtime uses unapproved days.');
    expect(notice.textContent).toContain('Pat Doe');
    expect(notice.compareDocumentPosition(byTestId('payroll-download')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const patRow = [...byTestId('payroll-in-file')!.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes('Pat Doe'))!;
    expect(patRow.textContent).toContain('Flagged');
    actions.preview.mockResolvedValueOnce(quiet());
    await pick('Pay period', 'Sep 16 – 30, 2026');
    expect(byTestId('payroll-flagged')).toBeNull();
  });

  it('not in this file: the count, why (returned date, partly included), hours, and Review only where it can be reviewed', async () => {
    await render();
    expect(m!.container.textContent).toContain('3 people aren’t in this file.');   // counted by person, not by row
    const rows = [...byTestId('payroll-not-included')!.querySelectorAll('tbody tr')];
    expect(rows.map((r) => r.querySelector('td')!.textContent)).toEqual(['Sue Submitted', 'Rae Returned', 'Pat Doe']);
    expect(rows[0].textContent).toContain('Submitted— waiting for approval');
    expect(rows[0].textContent).toContain('80.00');
    expect(rows[0].querySelector('a')!.getAttribute('href')).toBe('/admin/approvals?review=p-sue');
    expect(rows[1].textContent).toContain('Returned— returned Oct 18, not resubmitted');
    expect(rows[1].querySelector('a')).toBeNull();
    expect(rows[2].textContent).toContain('Not started— not started · partly included');
  });

  it('in this file: FLSA, exempt overtime "—", paid leave, and the footer totals', async () => {
    await render();
    const table = byTestId('payroll-in-file')!;
    const ivy = [...table.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes('Ivy Exempt'))!;
    expect(ivy.textContent).toContain('Exempt');
    expect([...ivy.querySelectorAll('td')].map((t) => t.textContent)).toEqual(expect.arrayContaining(['—', '8.00', '40.00']));
    const foot = table.querySelector('tfoot')!.textContent;
    expect(foot).toContain('2 people');
    expect(foot).toContain('80.00');
    expect(foot).toContain('85.00');
  });

  it('the remembered format is validated (an unknown value → the default) and a choice is remembered', async () => {
    window.localStorage.setItem(FORMAT_KEY, 'bogus');
    await render();
    expect(input('Format').value).toBe('ADP Workforce Now');
    await pick('Format', 'Gusto');
    expect(window.localStorage.getItem(FORMAT_KEY)).toBe('gusto');
    expect(input('Format').value).toBe('Gusto');
    unmount(m);
    await render();
    expect(input('Format').value).toBe('Gusto');
  });

  it('the overtime explanation is a collapsed accordion with the workweek day', async () => {
    await render();
    const control = byTestId('payroll-how')!.querySelector('button')!;
    expect(control.textContent).toBe('How overtime is worked out');
    expect(control.getAttribute('aria-expanded')).toBe('false');
    expect(byTestId('payroll-how')!.textContent).toContain('starts Monday');
  });

  it('a refused preview: a Notice with the message and the place to fix it', async () => {
    await render({ ok: true, data: { status: 'refused', reason: 'workweek-unset', codes: [], message: 'Set the workweek start day in Settings before exporting payroll.' } });
    expect(byTestId('payroll-refused')!.textContent).toContain('Set the workweek start day in Settings before exporting payroll.');
    expect(byTestId('payroll-refused')!.querySelector('a')!.getAttribute('href')).toBe('/settings/workspace');
  });
});

describe('downloads (P-4, F4 in the handler)', () => {
  it('a click while the new range\'s preview loads generates nothing; after it arrives, the click downloads that range', async () => {
    await render();
    const pending = deferred<unknown>();
    actions.preview.mockImplementationOnce(() => pending.promise);
    await pick('Pay period', 'Sep 16 – 30, 2026');
    expect(byTestId('payroll-loading')!.textContent).toBe('Loading preview…');
    expect(byTestId('payroll-download')!.getAttribute('aria-disabled')).toBe('true');
    await click(byTestId('payroll-download'));
    await click(byTestId('payroll-download-daily'));
    expect(actions.csv).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(ready()); });
    await wait(10);
    await click(byTestId('payroll-download'));
    await wait(10);
    expect(actions.csv).toHaveBeenCalledWith({ periodStart: '2026-09-16', periodEnd: '2026-09-30', format: 'adp' });
  });

  it('a refused or failed preview never downloads; the buttons are WriteButtons with no `disabled`', async () => {
    await render({ ok: true, data: { status: 'refused', reason: 'leave-pay-type', codes: ['LV-X'], message: 'Set a pay type.' } });
    for (const id of ['payroll-download', 'payroll-download-daily']) {
      expect(byTestId(id)!.hasAttribute('disabled'), id).toBe(false);
      expect(byTestId(id)!.getAttribute('aria-disabled'), id).toBe('true');
    }
    await click(byTestId('payroll-download'));
    expect(actions.csv).not.toHaveBeenCalled();
    unmount(m);
    await render({ ok: false, code: 'unexpected', error: 'Something went wrong.' });
    expect(byTestId('payroll-preview-error')!.textContent).toBe('Something went wrong.');
    await click(byTestId('payroll-download-daily'));
    expect(actions.csv).not.toHaveBeenCalled();
  });

  it('the daily detail downloads with format "daily-hours"; a ready preview downloads straight away', async () => {
    await render();
    expect(byTestId('payroll-download')!.getAttribute('aria-disabled')).toBeNull();
    await click(byTestId('payroll-download-daily'));
    await wait(10);
    expect(actions.csv).toHaveBeenCalledWith({ periodStart: '2026-10-01', periodEnd: '2026-10-15', format: 'daily-hours' });
  });
});
