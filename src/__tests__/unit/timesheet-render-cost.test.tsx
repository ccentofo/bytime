// @vitest-environment jsdom
import '@testing-library/react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { act, cleanup, fireEvent } from '@testing-library/react';

/**
 * feature-plan-ux-timesheet-ui.md B-T10 (§7): committing one cell re-renders only these grid cells — the changed cell, its
 * row total, the footer day and the grand total — measured with RenderProbeContext (no global counters).
 */

vi.mock('@/server/actions/timesheet', () => ({ saveTimesheetBatch: vi.fn(), getTimesheetPeriod: vi.fn() }));
vi.mock('@/server/actions/periods', () => ({ submitPeriod: vi.fn(), getWorkspaceContext: vi.fn(async () => ({ today: '2026-01-20' })), getPeriodOptions: vi.fn(async () => []) }));
vi.mock('@/server/actions/pay-period-config', () => ({ getNeighborPeriod: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => '/timesheet' }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { TimesheetGrid } from '@/components/timesheet/TimesheetGrid';
import { RenderProbeContext } from '@/components/timesheet/RenderProbe';
import { CC, CC2, IND, chargeCode, pageData } from '../helpers/timesheet-fixtures';
import { installTimesheetDomStubs, live, renderTimesheet } from '../helpers/timesheet-render';

beforeAll(() => installTimesheetDomStubs());
afterEach(() => cleanup());

describe('render cost (B-T10)', () => {
  it('one commit re-renders only the changed cell, its row total, the footer day cell and the grand total', () => {
    const rendered: string[] = [];
    const probe = (_kind: 'cell', key: string) => { rendered.push(key); };
    renderTimesheet(
      pageData({ chargeCodes: [chargeCode({ id: CC }), chargeCode({ id: CC2, clin: 'B' }), chargeCode({ id: IND, clin: 'LV', kind: 'indirect', isIndirect: true })] }),
      <RenderProbeContext.Provider value={probe}><TimesheetGrid /></RenderProbeContext.Provider>,
    );
    expect(rendered.length).toBeGreaterThan(40); // the first render touches every cell
    rendered.length = 0;
    act(() => live.ctx!.dispatch({ type: 'SET_HOURS', chargeCodeId: CC2, dayIndex: 4, value: 7.5 }));
    expect(new Set(rendered)).toEqual(new Set(['1:4', '1:total', 'foot:4', 'foot:total']));
  });

  it('v5.2: the note trigger costs no renders — pointer hover re-renders nothing (noteViewable doesn\'t depend on hover)', () => {
    const rendered: string[] = [];
    const probe = (_kind: 'cell', key: string) => { rendered.push(key); };
    renderTimesheet(pageData({ chargeCodes: [chargeCode({ id: CC })] }), <RenderProbeContext.Provider value={probe}><TimesheetGrid /></RenderProbeContext.Provider>);
    rendered.length = 0;
    const td = document.querySelector('td[data-r="0"][data-c="3"]')!;
    fireEvent.mouseEnter(td);
    fireEvent.mouseOver(td);
    fireEvent.pointerEnter(td);
    fireEvent.mouseLeave(td);
    expect(rendered).toEqual([]);
  });
});
