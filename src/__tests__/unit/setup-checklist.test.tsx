// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * feature-plan-ux-setup-import.md §3.3 (the Setup checklist page):
 * SU-6  — the two settings steps show inline forms only when not done AND no timesheet data; otherwise a link.
 * SU-11 — when an inline save completes a step, focus moves to that step's heading and the save is announced.
 * Plus: validation on click; a partial save still refetches; the pay schedule's default anchor for twice a month; the
 * progress line, the "now" tint, the access badge "{w} of {m}" with the non-blocking names note, the complete notice.
 */

const h = vi.hoisted(() => ({
  pageData: vi.fn(), tz: vi.fn(), week: vi.fn(), pay: vi.fn(),
}));
vi.mock('@/server/actions/setup', () => ({ getSetupPageData: h.pageData }));
vi.mock('@/server/actions/workspace-settings', () => ({ updateWorkspaceTimezone: h.tz, updateWorkweekStartDay: h.week }));
vi.mock('@/server/actions/pay-period-config', () => ({ updatePayPeriodConfig: h.pay }));
vi.mock('@/app/(app)/admin/charge-codes/CreateFromClinsModal', () => ({ CreateFromClinsModal: () => null }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { SetupChecklistClient } from '@/app/(app)/settings/setup/SetupChecklistClient';
import { showsInlineForm } from '@/app/(app)/settings/setup/setup-view';
import type { SetupPageData } from '@/server/internal/setup';
import { click, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  h.tz.mockResolvedValue({ ok: true, data: 'America/Chicago' });
  h.week.mockResolvedValue({ ok: true, data: 1 });
  h.pay.mockResolvedValue({ ok: true, data: { effectiveFrom: null } });
});
afterEach(() => { unmount(m); m = undefined; });

type Done = Partial<Record<string, boolean>>;
function data(done: Done = {}, o: { hasTimesheetData?: boolean; workweek?: number | null; withAccess?: number; total?: number; gaps?: string[] } = {}): SetupPageData {
  const keys = ['timeAndWeek', 'paySchedule', 'contractsClins', 'chargeCodes', 'people', 'chargeCodeAccess', 'indirectCodes', 'laborCategories', 'connection'] as const;
  const steps = keys.map((key, i) => ({
    key, required: i < 6, done: done[key] ?? false,
    ...(key === 'chargeCodeAccess' ? { withAccess: o.withAccess ?? 0, total: o.total ?? 0 } : {}),
  }));
  const required = steps.filter((s) => s.required);
  return {
    status: {
      steps, requiredDone: required.filter((s) => s.done).length, requiredTotal: 6, isComplete: required.every((s) => s.done),
      counts: { indirectCodes: 0, contracts: 1, clins: 2, chargeCodes: 0, laborCategories: 0, employees: o.total ?? 0, employeesWithAccess: o.withAccess ?? 0, adminsWithAccess: 0, clinsWithoutCode: 0 },
      hasTimesheetData: o.hasTimesheetData ?? false, payConfigSet: !!done.paySchedule,
    },
    gaps: { missingCount: o.gaps?.length ?? 0, names: o.gaps ?? [] },
    settings: { timezone: 'America/New_York', workweekStartDay: o.workweek ?? null, payConfig: { set: !!done.paySchedule, periodType: 'semimonthly', anchorDate: '2026-01-01', weekStartDay: 1 }, connectionName: null },
    scopeCount: 0,
  };
}
const render = async (d: SetupPageData) => { m = await mount(<SetupChecklistClient initialData={d} />); };
const stepEl = (key: string) => document.body.querySelector(`[data-step="${key}"]`) as HTMLElement;
const fieldIn = (root: Element, label: string) => {
  const l = [...root.querySelectorAll<HTMLLabelElement>('label')].find((x) => x.textContent?.replace(/\s*\*\s*$/, '').trim() === label)!;
  return document.getElementById(l.htmlFor) as HTMLInputElement;
};
const choose = async (root: Element, label: string, option: string) => {
  const input = fieldIn(root, label);
  await click(input);
  await click([...document.getElementById(input.getAttribute('aria-controls')!)!.querySelectorAll('[role="option"]')].find((o) => o.textContent === option));
};
const button = (root: Element, text: string) => [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;

describe('the Setup checklist page (§3.3)', () => {
  it('SU-6: inline forms only while not done and no timesheet data; otherwise the links', async () => {
    expect([showsInlineForm({ done: false }, false), showsInlineForm({ done: true }, false), showsInlineForm({ done: false }, true)]).toEqual([true, false, false]);
    await render(data());
    expect(stepEl('timeAndWeek').querySelector('[data-testid="form-timeAndWeek"]')).not.toBeNull();
    expect(stepEl('paySchedule').querySelector('[data-testid="form-paySchedule"]')).not.toBeNull();
    unmount(m);
    await render(data({}, { hasTimesheetData: true }));                                    // not done, but timesheets exist
    expect(stepEl('timeAndWeek').querySelector('form, [data-testid="form-timeAndWeek"]')).toBeNull();
    expect(stepEl('timeAndWeek').querySelector('a')!.textContent).toBe('Change on Workspace');
    expect(stepEl('paySchedule').querySelector('a')!.getAttribute('href')).toBe('/settings/pay-schedule');
    unmount(m);
    await render(data({ timeAndWeek: true, paySchedule: true }, { workweek: 1 }));          // done
    expect(stepEl('timeAndWeek').querySelector('a')!.getAttribute('href')).toBe('/settings/workspace');
    expect(stepEl('paySchedule').querySelector('a')!.textContent).toBe('Change on Pay schedule');
  });

  it('SU-11: a save that completes the step focuses its heading and announces it; validation comes first', async () => {
    h.pageData.mockResolvedValue(data({ timeAndWeek: true }, { workweek: 1 }));
    await render(data());
    const form = stepEl('timeAndWeek');
    await click(button(form, 'Save'));
    expect(form.textContent).toContain('Choose the day the workweek starts.');
    expect(h.week).not.toHaveBeenCalled();
    await choose(form, 'Workweek starts on (FLSA overtime)', 'Monday');
    await click(button(form, 'Save'));
    await wait(30);
    expect(h.tz).not.toHaveBeenCalled();                                                  // the time zone didn't change
    expect(h.week).toHaveBeenCalledWith(1);
    expect(document.activeElement).toBe(document.getElementById('setup-step-timeAndWeek'));
    expect(document.body.querySelector('[data-testid="setup-announce"]')!.textContent).toBe('Time zone and workweek saved');
  });

  it('a partial save (time zone saved, workweek refused) still refetches and shows the error', async () => {
    h.week.mockResolvedValueOnce({ ok: false, code: 'validation', error: 'Choose a workweek start day (Sunday through Saturday).' });
    h.pageData.mockResolvedValue(data());
    await render(data());
    const form = stepEl('timeAndWeek');
    await choose(form, 'Time zone', 'America/Chicago');
    await choose(form, 'Workweek starts on (FLSA overtime)', 'Sunday');
    await click(button(form, 'Save'));
    await wait(30);
    expect(h.tz).toHaveBeenCalledWith('America/Chicago');
    expect(h.pageData).toHaveBeenCalledTimes(1);
    expect(stepEl('timeAndWeek').querySelector('[role="alert"]')!.textContent).toBe('Choose a workweek start day (Sunday through Saturday).');
  });

  it('pay schedule: twice a month sends the default anchor and week start, immediately', async () => {
    h.pageData.mockResolvedValue(data({ paySchedule: true }));
    await render(data());
    await click(button(stepEl('paySchedule'), 'Save pay schedule'));
    await wait(30);
    expect(h.pay).toHaveBeenCalledWith({ periodType: 'semimonthly', anchorDate: '2026-01-01', weekStartDay: 1, effectiveFrom: null });
  });

  it('progress, the "now" tint, the access badge with the names note, and the complete notice', async () => {
    await render(data({ timeAndWeek: true, paySchedule: true, contractsClins: true, chargeCodes: true, people: true, chargeCodeAccess: true }, { workweek: 1, withAccess: 4, total: 6, gaps: ['Emily Davis', 'Robert Taylor'] }));
    expect(document.body.querySelector('[data-testid="setup-progress"]')!.textContent).toContain('6 of 6 required steps done');
    expect(document.body.querySelector('[data-testid="setup-complete"]')!.textContent).toBe('Your workspace is set up. People can record time.');
    const access = stepEl('chargeCodeAccess');
    expect(access.textContent).toContain('4 of 6 people can charge a direct code');
    expect(access.textContent).toContain('4 of 6');                                        // the warn badge
    expect(access.querySelector('[data-testid="access-gaps"]')!.textContent)
      .toBe("Without a direct code: Emily Davis and Robert Taylor. If they record only indirect time (overhead, G&A, leave), that's fine.");
    unmount(m);
    await render(data({ timeAndWeek: true }, { workweek: 1 }));
    expect(stepEl('paySchedule').hasAttribute('data-now')).toBe(true);
    expect(stepEl('timeAndWeek').hasAttribute('data-now')).toBe(false);
    expect(document.body.querySelector('[data-testid="setup-complete"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="setup-progress"]')!.textContent).toContain('3 recommended steps below.');
  });
});
