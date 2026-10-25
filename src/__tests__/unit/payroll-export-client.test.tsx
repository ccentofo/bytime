// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';

/**
 * Certified outputs fix round 1, F4: payroll can't be downloaded without seeing the flagged employees — both download
 * buttons stay disabled until a preview of the CURRENT range is loaded; changing the range clears it; flagged employees
 * are listed above the buttons.
 */

const actions = vi.hoisted(() => ({ preview: vi.fn(), csv: vi.fn() }));
vi.mock('@/server/actions/payroll-export', () => ({ getPayrollExportPreview: actions.preview, generatePayrollExportCSV: actions.csv }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));
// The date picker is UI plumbing here: a button that picks another range.
vi.mock('@mantine/dates', () => ({
  DatePickerInput: ({ onChange }: { onChange: (v: [string | null, string | null]) => void }) =>
    <button data-testid="pick-range" onClick={() => onChange(['2026-09-01', '2026-09-15'])}>pick</button>,
}));

import { PayrollExportClient } from '@/app/(app)/admin/integrations/payroll-export/PayrollExportClient';
import type { CalendarDate } from '@/lib/calendar-date';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => {
  // Mantine's Table.ScrollContainer / ScrollArea need ResizeObserver (absent in jsdom).
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
  });
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  actions.preview.mockResolvedValue({ ok: true, data: { status: 'ready', workweekStartDay: 1, reportedDays: 5, employees: [
    { employeeName: 'Pat Doe', employeeEmail: 'p@x', flsaExempt: false, regularHours: 40, overtimeHours: 5, uncompensatedOvertimeHours: 0, ptoHours: 0, sickHours: 0, holidayHours: 0, unpaidLeaveHours: 0, totalPaidHours: 45, totalRecordedHours: 45, otBasisIncludesUnapprovedDays: true },
  ] } });
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.clearAllMocks(); });

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label)) as HTMLButtonElement;

describe('PayrollExportClient (F4)', () => {
  it('downloads are disabled before a preview, enabled after it, and disabled again when the range changes', async () => {
    await act(async () => { root.render(<MantineProvider><PayrollExportClient today={'2026-10-25' as CalendarDate} /></MantineProvider>); });
    expect(q('payroll-download')!.disabled).toBe(true);
    expect(q('payroll-download-daily')!.disabled).toBe(true);
    expect(q('payroll-preview-first')).not.toBeNull();

    await act(async () => { button('Preview Data').click(); });
    expect(actions.preview).toHaveBeenCalledTimes(1);
    expect(q('payroll-download')!.disabled).toBe(false);
    expect(q('payroll-download-daily')!.disabled).toBe(false);
    // The flagged list sits ABOVE the buttons.
    const flagged = q('payroll-flagged')!;
    expect(flagged.textContent).toContain('Pat Doe');
    expect(flagged.compareDocumentPosition(q('payroll-download')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await act(async () => { q('pick-range')!.click(); });
    expect(q('payroll-download')!.disabled).toBe(true);
    expect(q('payroll-download-daily')!.disabled).toBe(true);
    expect(q('payroll-flagged')).toBeNull();
  });

  it('a preview that resolves AFTER the range changed is ignored (it belongs to the old range)', async () => {
    let resolve!: (v: unknown) => void;
    const ready = { ok: true, data: { status: 'ready', workweekStartDay: 1, reportedDays: 0, employees: [] } };
    actions.preview.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    await act(async () => { root.render(<MantineProvider><PayrollExportClient today={'2026-10-25' as CalendarDate} /></MantineProvider>); });
    await act(async () => { button('Preview Data').click(); });
    await act(async () => { q('pick-range')!.click(); });
    await act(async () => { resolve(ready); });
    expect(q('payroll-download')!.disabled).toBe(true);
  });

  it('a refused preview keeps downloads disabled', async () => {
    actions.preview.mockResolvedValue({ ok: true, data: { status: 'refused', reason: 'workweek-unset', codes: [], message: 'Set the workweek start day…' } });
    await act(async () => { root.render(<MantineProvider><PayrollExportClient today={'2026-10-25' as CalendarDate} /></MantineProvider>); });
    await act(async () => { button('Preview Data').click(); });
    expect(q('payroll-download')!.disabled).toBe(true);
    expect(q('payroll-refused')).not.toBeNull();
  });
});
