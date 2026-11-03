// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * feature-plan-ux-page-fixes.md C7 (R1) / T-C7b, T-C7c: the Pay schedule form. Save is aria-disabled with a visible reason
 * until something changes (a pending fixture loads with its date selected, so Save starts disabled); a form equal to the
 * current schedule while a change is pending says to use Cancel; Save asks first and only Confirm calls the action, with
 * expectedPendingId; the banner's Cancel asks with "Keep scheduled change" and sends cancelPending; changing only the
 * pending change's date enables Save; the weekly label follows the week start; the fields are labelled.
 */

const actions = vi.hoisted(() => ({
  getValidScheduleChangeDates: vi.fn<(...a: unknown[]) => Promise<{ immediate: boolean; dates: string[]; problem: string | null }>>(async () => ({ immediate: false, dates: ['2026-03-16'], problem: null })),
  updatePayPeriodConfig: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: { effectiveFrom: '2026-03-16', pendingId: 'p9' } })),
}));
vi.mock('@/server/actions/pay-period-config', () => actions);
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { PayScheduleClient } from '@/app/(app)/settings/pay-schedule/PayScheduleClient';
import { notifications } from '@mantine/notifications';
import { buttonByText, click, dialogTitled, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { unmount(m); m = undefined; });

const CURRENT = { periodType: 'semimonthly', anchorDate: '2026-01-01', weekStartDay: 1 } as const;
const PENDING = { id: 'p1', periodType: 'biweekly', anchorDate: '2025-01-06', weekStartDay: 1, effectiveFrom: '2026-02-16', createdAt: new Date() } as const;
const render = async (pendingChange: typeof PENDING | null = null, initialConfig: { periodType: string; anchorDate: string; weekStartDay: number } = CURRENT) => {
  m = await mount(<PayScheduleClient initialConfig={initialConfig as never} pendingChange={pendingChange as never} />);
  await wait(30);
};
const save = () => buttonByText('Save Schedule Change');
const reason = () => document.getElementById('pay-save-why')?.textContent ?? null;
const radio = (value: string) => m!.container.querySelector(`input[type="radio"][value="${value}"]`) as HTMLInputElement;
const field = (text: string) => {
  const l = [...m!.container.querySelectorAll('label')].find((x) => x.textContent?.replace(/\s*\*\s*$/, '').trim() === text);
  return l ? document.getElementById(l.htmlFor) as HTMLInputElement : null;
};
const inDialog = (d: HTMLElement, text: string) => [...d.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const UNCHANGED = 'Change the period type, anchor date or week start to schedule a change.';

describe('Pay schedule (C7, T-C7b)', () => {
  it('no pending: Save is aria-disabled with its reason until something changes; then it confirms, and only Confirm saves', async () => {
    await render();
    expect(save().getAttribute('aria-disabled')).toBe('true');
    expect(save().hasAttribute('disabled')).toBe(false);
    expect(reason()).toBe(UNCHANGED);
    expect(actions.getValidScheduleChangeDates).not.toHaveBeenCalled();   // the form is the current schedule
    await click(save());
    expect(dialogTitled('Change the pay schedule?')).toBeUndefined();

    await click(radio('biweekly'));
    await wait(30);
    expect(field('Effective from')!.value).toBe('Mar 16, 2026');
    expect(save().getAttribute('aria-disabled')).toBeNull();
    expect(reason()).toBeNull();
    await click(save());
    const confirm = dialogTitled('Change the pay schedule?')!;
    expect(confirm.textContent).toContain("Starting Mar 16, 2026, every employee's timesheets will use bi-weekly pay periods. Current and past periods don't change.");
    expect(actions.updatePayPeriodConfig).not.toHaveBeenCalled();
    await click(inDialog(confirm, 'Cancel'));
    expect(actions.updatePayPeriodConfig).not.toHaveBeenCalled();
    await click(save());
    await click(inDialog(dialogTitled('Change the pay schedule?')!, 'Schedule change'));
    await wait();
    expect(actions.updatePayPeriodConfig).toHaveBeenCalledTimes(1);
    expect(actions.updatePayPeriodConfig).toHaveBeenCalledWith({ periodType: 'biweekly', anchorDate: '2026-01-01', weekStartDay: 1, effectiveFrom: '2026-03-16', expectedPendingId: null });
    // The new pending change is now the baseline: banner shown, Save disabled again, the next write carries its id.
    expect(m!.container.querySelector('[data-testid="pending-change"]')!.textContent).toContain('Mar 16, 2026');
    expect(dialogTitled('Change the pay schedule?')).toBeUndefined();
    await wait(30);
    expect(save().getAttribute('aria-disabled')).toBe('true');
  });

  it('immediate: "starting now" copy and "Change schedule"; a refusal shows inside the confirm, which stays open', async () => {
    actions.getValidScheduleChangeDates.mockResolvedValue({ immediate: true, dates: [], problem: null });
    actions.updatePayPeriodConfig.mockResolvedValueOnce({ ok: false, code: 'validation', error: 'This is already your pay schedule. Change a setting before saving.' });
    await render();
    await click(radio('monthly'));
    await wait(30);
    await click(save());
    const confirm = dialogTitled('Change the pay schedule?')!;
    expect(confirm.textContent).toContain("Every employee's timesheets will use monthly pay periods starting now. No timesheets have been entered yet.");
    await click(inDialog(confirm, 'Change schedule'));
    await wait();
    expect(dialogTitled('Change the pay schedule?')!.querySelector('[role="alert"]')!.textContent).toBe('This is already your pay schedule. Change a setting before saving.');
    expect(notifications.show).not.toHaveBeenCalled();
    actions.getValidScheduleChangeDates.mockResolvedValue({ immediate: false, dates: ['2026-03-16'], problem: null });
  });

  it('a pending fixture loads with Save aria-disabled and the pending date selected (prepended when the server omits it)', async () => {
    await render(PENDING);
    expect(radio('biweekly').checked).toBe(true);                    // the form starts from the pending change
    expect(field('Effective from')!.value).toBe('Feb 16, 2026');
    expect(save().getAttribute('aria-disabled')).toBe('true');
    expect(reason()).toBe(UNCHANGED);
  });

  it('with a pending change, a form equal to the current schedule → Save aria-disabled with the "use Cancel" reason', async () => {
    await render(PENDING);
    await click(radio('semimonthly'));
    await wait(30);
    expect(save().getAttribute('aria-disabled')).toBe('true');
    expect(reason()).toBe('This matches your current schedule. To keep it, use Cancel scheduled change.');
  });

  it('the weekly label follows the week start; every field has a real label', async () => {
    await render(null, { periodType: 'weekly', anchorDate: '2026-01-04', weekStartDay: 0 });
    expect(radio('weekly').closest('.mantine-Radio-root')!.textContent).toBe('Weekly (7 days, Sunday to Saturday)');
    expect(m!.container.textContent).not.toContain('Mon–Sun');
    const group = m!.container.querySelector('[role="radiogroup"]')!;
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)!.textContent).toBe('Period type');
    expect(field('Anchor date')).not.toBeNull();
    expect(field('Week start day')).not.toBeNull();
    expect(field('Effective from')).not.toBeNull();
  });
});

describe('Pay schedule pending change (C7, T-C7c)', () => {
  it('the banner\'s Cancel asks ("Keep scheduled change" keeps it), then sends cancelPending; the banner clears and the form resets', async () => {
    actions.updatePayPeriodConfig.mockResolvedValueOnce({ ok: true, data: { effectiveFrom: null, cancelledPending: true } });
    await render(PENDING);
    await click(buttonByText('Cancel scheduled change'));
    let confirm = dialogTitled('Cancel the scheduled change?')!;
    expect(confirm.textContent).toContain('Your current semi-monthly schedule stays in effect.');
    await click(inDialog(confirm, 'Keep scheduled change'));
    expect(actions.updatePayPeriodConfig).not.toHaveBeenCalled();
    expect(dialogTitled('Cancel the scheduled change?')).toBeUndefined();

    await click(buttonByText('Cancel scheduled change'));
    confirm = dialogTitled('Cancel the scheduled change?')!;
    await click(inDialog(confirm, 'Cancel scheduled change'));
    await wait(30);
    expect(actions.updatePayPeriodConfig).toHaveBeenCalledWith({ ...CURRENT, effectiveFrom: null, cancelPending: true, expectedPendingId: 'p1' });
    expect(m!.container.querySelector('[data-testid="pending-change"]')).toBeNull();
    expect(radio('semimonthly').checked).toBe(true);
    expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Scheduled change cancelled.' }));
    expect(dialogTitled('Cancel the scheduled change?')).toBeUndefined();
  });

  it('changing only the pending change\'s date enables Save, which re-schedules with the pending id', async () => {
    await render(PENDING);
    await click(field('Effective from'));
    await click([...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent?.trim() === 'Mar 16, 2026'));
    expect(save().getAttribute('aria-disabled')).toBeNull();
    await click(save());
    await click(inDialog(dialogTitled('Change the pay schedule?')!, 'Schedule change'));
    await wait();
    expect(actions.updatePayPeriodConfig).toHaveBeenCalledWith({ periodType: 'biweekly', anchorDate: '2025-01-06', weekStartDay: 1, effectiveFrom: '2026-03-16', expectedPendingId: 'p1' });
  });
});
