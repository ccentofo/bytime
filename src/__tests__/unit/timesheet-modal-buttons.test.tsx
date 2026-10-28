// @vitest-environment jsdom
import '@testing-library/react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * UX-TIMESHEET-B-AUDIT M2 (and the brief's rule): the ReasonModal's and SubmitModal's buttons are never `disabled` and
 * never use Mantine's `loading` (which sets `disabled`) — they're aria-disabled with a click guard, so focus never drops
 * to <body>; while saving the confirm says "Saving…" / "Submitting…".
 */

vi.mock('server-only', () => ({}));

import { ReasonModal } from '@/components/timesheet/ReasonModal';
import { SubmitModal } from '@/components/timesheet/SubmitModal';
import { installTimesheetDomStubs, withTheme } from '../helpers/timesheet-render';
import { CC, chargeCode } from '../helpers/timesheet-fixtures';
import type { CalendarDate } from '@/lib/calendar-date';

beforeAll(() => installTimesheetDomStubs());
afterEach(() => cleanup());

const button = (label: string) => [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
const late = [{ chargeCodeId: CC, dayIndex: 2, hours: 4, isEdit: false, isLateEntry: true }];
const reasonModal = (o: { isSaving?: boolean; onConfirm?: (r: string, c: string) => Promise<boolean | void>; onClose?: () => void } = {}) => (
  <ReasonModal opened onClose={o.onClose ?? vi.fn()} onConfirm={o.onConfirm ?? vi.fn(async () => true)} editedCells={[]} lateEntryCells={late}
    chargeCodes={[chargeCode()]} periodStart={'2026-01-01' as CalendarDate} isSaving={o.isSaving ?? false} />
);
const submitModal = (o: { isSaving?: boolean; onConfirm?: (c?: string) => Promise<void>; onClose?: () => void } = {}) => (
  <SubmitModal opened onClose={o.onClose ?? vi.fn()} onConfirm={o.onConfirm ?? vi.fn(async () => {})} isSaving={o.isSaving ?? false} periodLabel="Jan 1 – 15, 2026" />
);
const noDisabled = () => expect([...document.querySelectorAll('[role="dialog"] button')].filter((b) => b.hasAttribute('disabled'))).toEqual([]);

describe('ReasonModal buttons (M2)', () => {
  it('Confirm Save is aria-disabled until a comment is given, and a click does nothing', async () => {
    const onConfirm = vi.fn(async () => true);
    const user = userEvent.setup();
    render(withTheme(reasonModal({ onConfirm })));
    const confirm = button('Confirm Save');
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    noDisabled();
    await user.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('while saving: "Saving…", both buttons aria-disabled (never disabled), clicks do nothing', async () => {
    const onConfirm = vi.fn(async () => true);
    const onClose = vi.fn();
    const user = userEvent.setup();
    const view = render(withTheme(reasonModal({ onConfirm, onClose })));
    // A valid reason first (LATE_ENTRY is preselected for late entries), so only the saving guard can stop the click.
    await user.type(document.querySelector('[role="dialog"] textarea')!, 'Forgot on Friday');
    expect(button('Confirm Save').getAttribute('aria-disabled')).toBeNull();
    view.rerender(withTheme(reasonModal({ isSaving: true, onConfirm, onClose })));
    expect(button('Confirm Save')).toBeUndefined();
    const saving = button('Saving…');
    expect(saving.getAttribute('aria-disabled')).toBe('true');
    expect(button('Cancel').getAttribute('aria-disabled')).toBe('true');
    noDisabled();
    await user.click(saving);
    await user.click(button('Cancel'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('SubmitModal buttons (M2)', () => {
  it('Submit Timesheet is aria-disabled until certified, and a click does nothing', async () => {
    const onConfirm = vi.fn(async () => {});
    const user = userEvent.setup();
    render(withTheme(submitModal({ onConfirm })));
    const submit = button('Submit Timesheet');
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    noDisabled();
    await user.click(submit);
    expect(onConfirm).not.toHaveBeenCalled();
    await user.click(document.querySelector('[role="dialog"] input[type="checkbox"]')!);
    expect(button('Submit Timesheet').getAttribute('aria-disabled')).toBeNull();
    await user.click(button('Submit Timesheet'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('while submitting: "Submitting…", aria-disabled (never disabled)', () => {
    render(withTheme(submitModal({ isSaving: true })));
    expect(button('Submitting…').getAttribute('aria-disabled')).toBe('true');
    expect(button('Cancel').getAttribute('aria-disabled')).toBe('true');
    noDisabled();
  });
});
