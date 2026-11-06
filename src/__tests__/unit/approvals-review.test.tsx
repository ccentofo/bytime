// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

/**
 * feature-plan-ux-approvals-payroll.md §3.3 / A-7, A-8, A-9: the review Drawer.
 * A-7 — the header and Previous / Next; ReviewGrid marks (classes + screen-reader text) and totals; the Worth a look
 *       card (the return comment, "Since returned", "originally entered late"); the Notes card.
 * A-8 — the binding (A10): while Next loads, or after its read fails, there is no decision button (Retry instead);
 *       after the load, Approve sends THAT period's id and ITS seen; Previous / Next / close do nothing while a
 *       decision runs; Return with an empty comment sends nothing, shows the inline error and focuses the comment;
 *       the buttons are WriteButtons with no `disabled`; a stale read is dropped.
 * A-9 — open next: getScopedPeriods, then the next waiting id by compareWaiting (not the decided one); at the end the
 *       Drawer closes and focus goes to the heading; unchecked → focus on the row at the same index; a refresh
 *       failure after a successful decision is a toast, never a decision error.
 * UX-4B2-AUDIT.md fix round 1 — M1 (the kept grid names its employee), M2 (focus on the heading, the live region),
 *       L2 (close focus by row id), L3 (nothing to click while closing), L4, L5, L8 (deep-linked non-Waiting row).
 */

const nav = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => nav, usePathname: () => '/admin/approvals' }));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toastError: toast.error, toastSuccess: toast.success }));
const actions = vi.hoisted(() => ({
  approvePeriod: vi.fn<(d: unknown) => Promise<unknown>>(async () => ({ ok: true, data: undefined })),
  rejectPeriod: vi.fn<(d: unknown) => Promise<unknown>>(async () => ({ ok: true, data: undefined })),
  getScopedPeriods: vi.fn(async () => [] as unknown[]),
  getTimesheetForReview: vi.fn(),
}));
vi.mock('@/server/actions/periods', () => ({ approvePeriod: actions.approvePeriod, rejectPeriod: actions.rejectPeriod, getScopedPeriods: actions.getScopedPeriods }));
vi.mock('@/server/actions/timesheet', () => ({ getTimesheetForReview: actions.getTimesheetForReview }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { ApprovalsClient } from '@/app/(app)/admin/approvals/ApprovalsClient';
import { click, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';
import { chargeCode, CC, IND } from '../helpers/timesheet-fixtures';
import type { CalendarDate } from '@/lib/calendar-date';

beforeAll(installDomStubs);
let m: Mounted | undefined;
afterEach(() => { unmount(m); m = undefined; });

const START = '2026-10-01' as CalendarDate; // a Thursday; Oct 3–4 is a weekend
const row = (id: string, name: string, o: Record<string, unknown> = {}) => ({
  id, userId: `u-${id}`, userName: name, userEmail: `${id}@x`, periodStart: START, periodNumDays: 15, status: 'submitted',
  submittedAt: new Date('2026-10-16T14:00:00Z'), reviewedAt: null, reviewedBy: null, canApprove: true, approvalBadge: null,
  approvalText: null, submissionCount: 1, flags: null, hours: 16, ...o,
});
// compareWaiting order: A, B, C (same period; by submission).
const A = row('a', 'Ann Adams', { submittedAt: new Date('2026-10-16T09:00:00Z') });
const B = row('b', 'Bea Brown', { submittedAt: new Date('2026-10-16T10:00:00Z'), submissionCount: 2 });
const C = row('c', 'Cy Cole', { submittedAt: new Date('2026-10-16T11:00:00Z'), submissionCount: 3 });
const D = row('d', 'Dee Done', { status: 'approved', canApprove: false, reviewedAt: new Date('2026-10-18T10:00:00Z'), hours: null });
const ROWS = [A, B, C, D];
const CODES = [chargeCode({ id: CC, clin: 'NAV-01', name: 'Onsite', projectName: 'NAVAIR' }), chargeCode({ id: IND, clin: 'OH', name: 'Overhead', projectName: 'Indirect' })];
const rev = (revision: number, hours: number, o: Record<string, unknown> = {}) =>
  ({ revision, hours, reasonCode: null, comment: null, createdAt: '2026-10-07T14:00:00.000Z', source: 'app', ...o });

function reviewFor(r: typeof A, o: Record<string, unknown> = {}) {
  return {
    chargeCodes: CODES,
    entries: [{ chargeCodeId: CC, hours: [8, 6, 0, 0, 4, ...Array(10).fill(0)] }, { chargeCodeId: IND, hours: [0, 2, ...Array(13).fill(0)] }],
    periodStatus: r.status, submissionCount: r.submissionCount, canApprove: r.canApprove, approvalBadge: null, approvalText: null,
    notes: { [`${CC}-4`]: { body: 'Site visit at Pax River.', revision: 1 } },
    periodId: r.id, numDays: 15, submittedAt: '2026-10-16T14:00:00.000Z', submittedComment: null,
    flagged: [], lastReturn: null, approvalUiText: null,
    ...o,
  };
}
const FLAGGED_A = [
  { rowId: CC, dayIndex: 1, kind: 'correction', originallyLate: false, sinceReturned: false, previousHours: 8,
    current: rev(2, 6, { reasonCode: 'CORRECTION', comment: 'Left early.' }), history: [rev(1, 8), rev(2, 6, { reasonCode: 'CORRECTION', comment: 'Left early.' })] },
  { rowId: CC, dayIndex: 4, kind: 'late', originallyLate: false, sinceReturned: false, previousHours: null,
    current: rev(1, 4, { reasonCode: 'LATE_ENTRY', comment: 'Entered the next morning.', createdAt: '2026-10-06T13:00:00.000Z' }), history: [] },
];
const FLAGGED_B = [
  { rowId: IND, dayIndex: 1, kind: 'correction', originallyLate: true, sinceReturned: true, previousHours: 1,
    current: rev(2, 2, { reasonCode: 'CORRECTION', comment: 'Added the site visit.', createdAt: '2026-10-17T14:00:00.000Z' }), history: [] },
];
const reviews: Record<string, () => unknown> = {
  'u-a': () => reviewFor(A, { flagged: FLAGGED_A }),
  'u-b': () => reviewFor(B, { flagged: FLAGGED_B, lastReturn: { comment: 'Please add the site visit.', byName: 'Sam Super', at: '2026-10-16T16:00:00.000Z' }, submittedComment: 'Fixed it.' }),
  'u-c': () => reviewFor(C),
  'u-d': () => reviewFor(D, { approvalUiText: 'Approved by Sam Super on Oct 18, 2026' }),
};

beforeEach(() => {
  vi.clearAllMocks();
  actions.getTimesheetForReview.mockImplementation(async (userId: string) => reviews[userId]());
  actions.getScopedPeriods.mockResolvedValue(ROWS);
});

const render = async (rows = ROWS) => {
  m = await mount(<ApprovalsClient initialPeriods={rows as never} currentUserId="sam" userRole="admin" workspaceTimezone="America/New_York" scopeInfo={null} />);
  await wait(10);
};
const dialog = () => document.body.querySelector('[role="dialog"]') as HTMLElement | null;
const inDialog = (text: string) => [...(dialog()?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const byLabel = (label: string) => dialog()!.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
const openRow = async (name: string) => {
  const tr = [...m!.container.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes(name))!;
  await click(tr.querySelector('button'));
  await wait(30);
};
const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const typeComment = async (text: string) => {
  const ta = dialog()!.querySelector('textarea') as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('the review Drawer (A-7)', () => {
  it('title, header line and Previous / Next with "i of n waiting" (aria-disabled at the ends)', async () => {
    await render();
    await openRow('Ann Adams');
    expect(dialog()!.textContent).toContain('Ann Adams · Oct 1 – 15, 2026');
    const header = dialog()!.querySelector('[data-testid="review-header"]')!.textContent;
    expect(header).toContain('Submitted Oct 16');
    expect(header).toContain('20.00 hours');
    expect(header).toContain('Submitted');
    expect(dialog()!.querySelector('[data-testid="review-nav"]')!.textContent).toContain('1 of 3 waiting');
    expect(byLabel('Previous waiting timesheet').getAttribute('aria-disabled')).toBe('true');
    expect(byLabel('Next waiting timesheet').getAttribute('aria-disabled')).toBeNull();
  });

  it('ReviewGrid: weekday headers, weekend tint, blank empty cells, flagged / noted marks with sr text, totals', async () => {
    await render();
    await openRow('Ann Adams');
    const grid = dialog()!.querySelector('table')!;
    expect(grid.querySelector('caption')!.textContent).toBe('Hours for Ann Adams, Oct 1 – 15, 2026');
    const ths = [...grid.querySelectorAll('thead th')];
    expect(ths[1].textContent).toBe('Thu Oct 1');                        // L4: a space between the day and the date
    expect(ths[3].className).toMatch(/weekend/);                          // Sat Oct 3
    const onsite = [...grid.querySelectorAll('tbody tr')][0];
    expect(onsite.querySelector('th')!.textContent).toBe('OnsiteNAV-01');  // name, then code
    const cells = [...onsite.querySelectorAll('td')];
    expect(cells[0].textContent).toBe('8.00');
    expect(cells[2].textContent).toBe('');                                // blank, not "—" or 0
    expect(cells[1].className).toMatch(/flagged/);
    expect(cells[1].textContent).toBe('6.00, corrected');
    expect(cells[4].className).toMatch(/flagged/);
    expect(cells[4].className).toMatch(/noted/);
    expect(cells[4].textContent).toBe('4.00, late entry, has a note');
    expect(cells[15].textContent).toBe('18.00');                          // row total
    expect(grid.querySelector('[data-testid="review-total"]')!.textContent).toBe('20.00');
    expect([...grid.querySelectorAll('tfoot td')][1].textContent).toBe('8.00'); // Fri Oct 2: 6 + 2
  });

  it('Worth a look lists each change with its reason, comment and date; the Notes card counts the notes', async () => {
    await render();
    await openRow('Ann Adams');
    const card = dialog()!.querySelector('[data-testid="worth-a-look"]')!;
    expect(card.querySelector('h3')!.textContent).toBe('Worth a look (2)');
    const changes = [...card.querySelectorAll('[data-testid="flagged-change"]')].map((c) => c.textContent);
    expect(changes[0]).toBe('Fri Oct 2 · Onsite: 8.00 → 6.00Correction of Error · “Left early.” · changed Oct 7');
    expect(changes[1]).toBe('Mon Oct 5 · Onsite: 4.00, entered Oct 6Late Entry (>24hrs) · “Entered the next morning.”');
    expect(dialog()!.textContent).toContain('Notes (1)');
    expect(dialog()!.querySelector('[data-testid="review-notes"]')!.textContent).toContain('Site visit at Pax River.');
  });

  it('a resubmission: the return comment first, "Since returned", "originally entered late", the submit note', async () => {
    await render();
    await openRow('Bea Brown');
    const card = dialog()!.querySelector('[data-testid="worth-a-look"]')!;
    expect(card.querySelector('[data-testid="last-return"]')!.textContent).toBe('Returned Oct 16 by Sam Super: “Please add the site visit.”');
    expect(card.firstElementChild!.nextElementSibling!.firstElementChild!.getAttribute('data-testid')).toBe('last-return');
    const change = card.querySelector('[data-testid="flagged-change"]')!.textContent!;
    expect(change).toContain('Since returned');
    expect(change).toContain('originally entered late');
    expect(card.querySelector('[data-testid="submit-note"]')!.textContent).toBe('Submit note: “Fixed it.”');
  });

  it('nothing flagged: "Nothing unusual in this timesheet."; a decided period shows its uiText instead of the card; View rows have no Previous / Next', async () => {
    await render();
    await openRow('Cy Cole');
    expect(dialog()!.querySelector('[data-testid="worth-a-look"]')!.textContent).toContain('Nothing unusual in this timesheet.');
    unmount(m);
    await render();
    await (async () => {
      const seg = [...m!.container.querySelectorAll('label')].find((l) => l.textContent?.startsWith('Decided'))!;
      await click(seg);
    })();
    await openRow('Dee Done');
    expect(dialog()!.querySelector('[data-testid="decision-text"]')!.textContent).toBe('Approved by Sam Super on Oct 18, 2026');
    expect(dialog()!.querySelector('[data-testid="decision-card"]')).toBeNull();
    expect(dialog()!.querySelector('[data-testid="review-nav"]')).toBeNull();
  });
});

describe('the decision binding (A-8)', () => {
  it('while Next loads there is no decision button; after the load Approve sends the NEW period id with ITS seen', async () => {
    await render();
    await openRow('Ann Adams');
    expect(inDialog('Approve')).toBeDefined();
    const pending = deferred<unknown>();
    actions.getTimesheetForReview.mockImplementationOnce(() => pending.promise);
    await click(byLabel('Next waiting timesheet'));
    expect(dialog()!.textContent).toContain('Bea Brown · Oct 1 – 15, 2026');     // the header describes current
    expect(inDialog('Approve')).toBeUndefined();
    expect(inDialog('Return for corrections')).toBeUndefined();
    expect(dialog()!.querySelector('[data-testid="review-loading"]')!.getAttribute('role')).toBe('status');
    expect(dialog()!.querySelector('table')).not.toBeNull();                    // the old grid stays visible
    await act(async () => { pending.resolve(reviews['u-b']()); });
    await wait(20);
    await click(inDialog('Approve'));
    await wait(20);
    expect(actions.approvePeriod).toHaveBeenCalledTimes(1);
    expect(actions.approvePeriod.mock.calls[0][0]).toEqual({ periodId: 'b', seen: 2, comment: undefined });
  });

  it('a failed read → no decision button, the error with Retry; Retry loads it', async () => {
    await render();
    await openRow('Ann Adams');
    actions.getTimesheetForReview.mockRejectedValueOnce(new Error('boom'));
    await click(byLabel('Next waiting timesheet'));
    await wait(20);
    expect(inDialog('Approve')).toBeUndefined();
    const err = dialog()!.querySelector('[data-testid="review-read-error"]')!;
    expect(err.textContent).toContain("This timesheet couldn't be loaded.");
    await click([...err.querySelectorAll('button')].find((b) => b.textContent === 'Retry'));
    await wait(20);
    expect(inDialog('Approve')).toBeDefined();
  });

  it('a stale read (an earlier Next) never replaces the current one', async () => {
    await render();
    await openRow('Ann Adams');
    const slowB = deferred<unknown>();
    actions.getTimesheetForReview.mockImplementationOnce(() => slowB.promise);
    await click(byLabel('Next waiting timesheet'));                              // → B (slow)
    await click(byLabel('Next waiting timesheet'));                              // → C (fast)
    await wait(20);
    expect(dialog()!.textContent).toContain('Cy Cole · Oct 1 – 15, 2026');
    await act(async () => { slowB.resolve(reviews['u-b']()); });
    await wait(20);
    await click(inDialog('Approve'));
    await wait(20);
    expect(actions.approvePeriod.mock.calls[0][0]).toMatchObject({ periodId: 'c', seen: 3 });
  });

  it('while a decision runs, Previous / Next / close do nothing', async () => {
    await render();
    await openRow('Bea Brown');
    const decision = deferred<unknown>();
    actions.approvePeriod.mockImplementationOnce(() => decision.promise);
    await click(inDialog('Approve'));
    const reads = actions.getTimesheetForReview.mock.calls.length;
    await click(byLabel('Next waiting timesheet'));
    await click(byLabel('Previous waiting timesheet'));
    expect(actions.getTimesheetForReview.mock.calls.length).toBe(reads);
    await click(dialog()!.querySelector('.mantine-Drawer-close'));
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await wait(20);
    expect(dialog()!.textContent).toContain('Bea Brown');
    await act(async () => { decision.resolve({ ok: false, code: 'conflict', error: 'This timesheet was just changed by someone else. Please refresh and try again.' }); });
    await wait(20);
    expect(dialog()!.querySelector('[data-testid="decision-error"]')!.textContent).toContain('just changed by someone else');
  });

  it('Return with an empty comment: no request, the inline error, focus on the comment; WriteButtons without `disabled`', async () => {
    await render();
    await openRow('Ann Adams');
    for (const label of ['Approve', 'Return for corrections']) expect(inDialog(label)!.hasAttribute('disabled'), label).toBe(false);
    await typeComment('   ');
    await click(inDialog('Return for corrections'));
    expect(actions.rejectPeriod).not.toHaveBeenCalled();
    expect(dialog()!.textContent).toContain('Add a comment so the employee knows what to fix.');
    expect(document.activeElement).toBe(dialog()!.querySelector('textarea'));
    await typeComment('  Please add Tuesday.  ');
    await click(inDialog('Return for corrections'));
    await wait(20);
    expect(actions.rejectPeriod.mock.calls[0][0]).toEqual({ periodId: 'a', seen: 1, comment: 'Please add Tuesday.' });
    expect(toast.success).toHaveBeenCalledWith(expect.objectContaining({ title: 'Timesheet returned', message: 'Ann Adams · Oct 1 – 15, 2026' }));
  });
});

describe('the kept grid (fix round 1, M1)', () => {
  it('during Next the grid is still captioned as A, marked busy, dimmed, with "Showing A until this loads"; the counts are hidden', async () => {
    await render();
    await openRow('Ann Adams');
    const pending = deferred<unknown>();
    actions.getTimesheetForReview.mockImplementationOnce(() => pending.promise);
    await click(byLabel('Next waiting timesheet'));
    const wrap = dialog()!.querySelector('[data-testid="review-grid"]')!;
    expect(wrap.querySelector('caption')!.textContent).toBe('Hours for Ann Adams, Oct 1 – 15, 2026');
    expect(wrap.getAttribute('aria-busy')).toBe('true');
    expect(wrap.querySelector('[data-testid="review-grid-kept"]')!.textContent).toBe('Showing Ann Adams until this loads');
    expect(wrap.querySelector('table')!.className).toMatch(/dimmed/);
    expect(dialog()!.querySelector('[data-testid="worth-a-look"] h3')!.textContent).toBe('Worth a look');
    expect(dialog()!.querySelector('#review-notes-heading')!.textContent).toBe('Notes');
    await act(async () => { pending.resolve(reviews['u-b']()); });
    await wait(20);
    const now = dialog()!.querySelector('[data-testid="review-grid"]')!;
    expect(now.querySelector('caption')!.textContent).toBe('Hours for Bea Brown, Oct 1 – 15, 2026');
    expect(now.hasAttribute('aria-busy')).toBe(false);
    expect(now.querySelector('[data-testid="review-grid-kept"]')).toBeNull();
    expect(now.querySelector('table')!.className).not.toMatch(/dimmed/);
    expect(dialog()!.querySelector('[data-testid="worth-a-look"] h3')!.textContent).toBe('Worth a look (1)');
    expect(dialog()!.querySelector('#review-notes-heading')!.textContent).toBe('Notes (1)');
  });

  it('after a failed read no grid is shown — only the error with Retry', async () => {
    await render();
    await openRow('Ann Adams');
    actions.getTimesheetForReview.mockRejectedValueOnce(new Error('boom'));
    await click(byLabel('Next waiting timesheet'));
    await wait(20);
    expect(dialog()!.querySelector('[data-testid="review-read-error"]')).not.toBeNull();
    expect(dialog()!.querySelector('table')).toBeNull();
    expect(dialog()!.textContent).not.toContain('Showing Ann Adams');
  });
});

describe('focus and announcements (fix round 1, M2)', () => {
  const heading = () => dialog()!.querySelector('[data-testid="review-heading"]') as HTMLElement;

  it('the heading is a focusable h2 naming the dialog', async () => {
    await render();
    await openRow('Ann Adams');
    expect(heading().tagName).toBe('H2');
    expect(heading().getAttribute('tabindex')).toBe('-1');
    expect(document.getElementById(dialog()!.getAttribute('aria-labelledby')!)).toBe(heading());
    expect(dialog()!.querySelector('[data-testid="review-announcement"]')!.textContent).toBe('');
  });

  it('approve with open next: focus moves to the heading before the read, the live region speaks once the review is ready', async () => {
    await render();
    await openRow('Ann Adams');
    actions.getScopedPeriods.mockResolvedValueOnce([{ ...A, status: 'approved', canApprove: false }, B, C, D]);
    const pending = deferred<unknown>();
    actions.getTimesheetForReview.mockImplementationOnce(() => pending.promise);
    inDialog('Approve')!.focus();
    await click(inDialog('Approve'));
    await wait(40);
    expect(document.activeElement).toBe(heading());
    const live = dialog()!.querySelector('[data-testid="review-announcement"]')!;
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toBe('');                                          // not before the review is ready
    await act(async () => { pending.resolve(reviews['u-b']()); });
    await wait(20);
    expect(heading().textContent).toBe('Bea Brown · Oct 1 – 15, 2026');
    expect(document.activeElement).toBe(heading());
    expect(live.textContent).toBe('Opened Bea Brown, 1 of 2 waiting');
  });

  it('Next announces the place in the list once ready', async () => {
    await render();
    await openRow('Ann Adams');
    await click(byLabel('Next waiting timesheet'));
    await wait(20);
    expect(dialog()!.querySelector('[data-testid="review-announcement"]')!.textContent).toBe('Opened Bea Brown, 2 of 3 waiting');
  });

  it('Retry keeps focus inside the Drawer (on the heading)', async () => {
    await render();
    await openRow('Ann Adams');
    actions.getTimesheetForReview.mockRejectedValueOnce(new Error('boom'));
    await click(byLabel('Next waiting timesheet'));
    await wait(20);
    const retry = [...dialog()!.querySelectorAll('[data-testid="review-read-error"] button')].find((b) => b.textContent === 'Retry') as HTMLButtonElement;
    retry.focus();
    await click(retry);
    await wait(20);
    expect(document.activeElement).toBe(heading());
    expect(dialog()!.contains(document.activeElement)).toBe(true);
  });
});

describe('approvals LOWs (fix round 1: L2–L5, L8)', () => {
  it('L2: close focus goes to the Review button by row id — in Everything, the row at the decided row\'s place, not the same DOM index', async () => {
    const later = { ...D, periodStart: '2026-10-16' as CalendarDate };       // Everything: Dee (newest period) first, then Ann, Bea, Cy
    await render([A, B, C, later]);
    await click([...m!.container.querySelectorAll('label')].find((l) => l.textContent?.startsWith('Everything')));
    await openRow('Ann Adams');
    await click(dialog()!.querySelector('input[type="checkbox"]'));
    actions.getScopedPeriods.mockResolvedValueOnce([{ ...A, status: 'approved', canApprove: false }, B, C, later]);
    await click(inDialog('Approve'));
    await wait(400);
    expect(dialog()).toBeNull();
    expect((document.activeElement as HTMLElement).dataset.reviewButton).toBe('a');   // Ann is still at index 1 in Everything
    expect(document.activeElement!.closest('tr')!.textContent).toContain('Ann Adams');
  });

  // L3, with real transitions (mount() uses env="test", which closes the Drawer instantly), so the exit is observable.
  const renderAnimated = async (rows: unknown[]) => {
    const { MantineProvider } = await import('@mantine/core');
    const { createRoot } = await import('react-dom/client');
    const { theme } = await import('@/theme');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<MantineProvider theme={theme}>
        <ApprovalsClient initialPeriods={rows as never} currentUserId="sam" userRole="admin" workspaceTimezone="America/New_York" scopeInfo={null} />
      </MantineProvider>);
    });
    m = { container, root };
    await wait(10);
  };
  it.each([
    ['open next unchecked', 'unchecked'],
    ['the last waiting one', 'last'],
    ['the list refresh fails', 'refresh-fails'],
  ] as const)('L3: after a decision that closes the Drawer (%s), there is nothing to click while it slides out', async (_label, how) => {
    await renderAnimated(how === 'last' ? [B, D] : ROWS);
    await openRow('Bea Brown');
    await wait(300);
    if (how === 'unchecked') await click(dialog()!.querySelector('input[type="checkbox"]'));
    if (how === 'refresh-fails') actions.getScopedPeriods.mockRejectedValueOnce(new Error('network'));
    else actions.getScopedPeriods.mockResolvedValueOnce(how === 'last' ? [{ ...B, status: 'approved', canApprove: false }, D] : [A, { ...B, status: 'approved', canApprove: false }, C, D]);
    await click(inDialog('Approve'));
    expect(dialog()).not.toBeNull();                                           // still sliding out
    expect(dialog()!.textContent).toContain('Bea Brown');
    expect(inDialog('Approve')).toBeUndefined();
    expect(inDialog('Return for corrections')).toBeUndefined();
    expect(dialog()!.querySelector('[data-testid="review-loading"]')).toBeNull();
    await wait(600);
    expect(dialog()).toBeNull();
    expect(actions.approvePeriod).toHaveBeenCalledTimes(1);
  });

  it('L4: the grid scrolls in a focusable region named by the caption', async () => {
    await render();
    await openRow('Ann Adams');
    const scroller = dialog()!.querySelector('table')!.parentElement!;
    expect(scroller.getAttribute('role')).toBe('region');
    expect(scroller.getAttribute('tabindex')).toBe('0');
    expect(scroller.getAttribute('aria-label')).toBe('Hours for Ann Adams, Oct 1 – 15, 2026');
  });

  it('L5: a correction with no earlier revision on record shows "—", not 0.00', async () => {
    actions.getTimesheetForReview.mockImplementationOnce(async () => reviewFor(C, { flagged: [
      { rowId: CC, dayIndex: 1, kind: 'correction', originallyLate: false, sinceReturned: false, previousHours: null,
        current: rev(2, 6, { reasonCode: 'CORRECTION' }), history: [rev(2, 6, { reasonCode: 'CORRECTION' })] },
    ] }));
    await render();
    await openRow('Cy Cole');
    expect(dialog()!.querySelector('[data-testid="flagged-change"]')!.textContent).toContain('Fri Oct 2 · Onsite: — → 6.00');
  });

  it('L8: a deep-linked row that isn\'t waiting has no Previous / Next', async () => {
    m = await mount(<ApprovalsClient initialPeriods={ROWS as never} currentUserId="sam" userRole="admin" workspaceTimezone="America/New_York" scopeInfo={null} initialReviewId="d" />);
    await wait(40);
    expect(dialog()!.textContent).toContain('Dee Done · Oct 1 – 15, 2026');
    expect(dialog()!.querySelector('[data-testid="review-nav"]')).toBeNull();
  });
});

describe('open next (A-9)', () => {
  it('after approving, the list is refetched and the next waiting id in the snapshot opens (not the decided one)', async () => {
    await render();
    await openRow('Ann Adams');
    actions.getScopedPeriods.mockResolvedValueOnce([{ ...A, status: 'approved', canApprove: false }, B, C, D]);
    await click(inDialog('Approve'));
    await wait(40);
    expect(actions.getScopedPeriods).toHaveBeenCalledTimes(1);
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    expect(dialog()!.textContent).toContain('Bea Brown · Oct 1 – 15, 2026');
    expect(actions.getTimesheetForReview).toHaveBeenLastCalledWith('u-b', START);
    expect(toast.success).toHaveBeenCalledWith(expect.objectContaining({ title: 'Timesheet approved', message: 'Ann Adams · Oct 1 – 15, 2026' }));
  });

  it('opens the next id AFTER the decided one, not the first waiting (an earlier one still waits)', async () => {
    await render();
    await openRow('Bea Brown');
    actions.getScopedPeriods.mockResolvedValueOnce([A, { ...B, status: 'approved', canApprove: false }, C, D]);
    await click(inDialog('Approve'));
    await wait(40);
    expect(dialog()!.textContent).toContain('Cy Cole · Oct 1 – 15, 2026');
  });

  it('skips a snapshot id that is no longer waiting; with nothing after it, the first waiting opens', async () => {
    await render();
    await openRow('Bea Brown');
    // B decided; C was decided meanwhile by someone else; A still waits → nothing after B → the first waiting (A).
    actions.getScopedPeriods.mockResolvedValueOnce([A, { ...B, status: 'approved', canApprove: false }, { ...C, status: 'approved', canApprove: false }, D]);
    await click(inDialog('Approve'));
    await wait(40);
    expect(dialog()!.textContent).toContain('Ann Adams · Oct 1 – 15, 2026');
  });

  it('the last one: the Drawer closes and focus goes to the heading', async () => {
    await render([A, D]);
    await openRow('Ann Adams');
    actions.getScopedPeriods.mockResolvedValueOnce([{ ...A, status: 'approved', canApprove: false }, D]);
    await click(inDialog('Approve'));
    await wait(400);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(m!.container.querySelector('h1'));
  });

  it('unchecked: closes and focuses the Review button of the row now at the same index', async () => {
    await render();
    await openRow('Bea Brown');
    await click(dialog()!.querySelector('input[type="checkbox"]'));
    actions.getScopedPeriods.mockResolvedValueOnce([A, { ...B, status: 'approved', canApprove: false }, C, D]);
    await click(inDialog('Approve'));
    await wait(400);
    expect(dialog()).toBeNull();
    const buttons = [...m!.container.querySelectorAll('[data-review-button]')];
    expect(document.activeElement).toBe(buttons[1]);                            // Cy Cole's row moved up to index 1
    expect(buttons[1].closest('tr')!.textContent).toContain('Cy Cole');
  });

  it('a refresh failure after a successful decision is a toast, not a decision error', async () => {
    await render();
    await openRow('Ann Adams');
    actions.getScopedPeriods.mockRejectedValueOnce(new Error('network'));
    await click(inDialog('Approve'));
    await wait(40);
    expect(toast.error).toHaveBeenCalledWith(expect.objectContaining({ message: "Decided, but the list couldn't refresh. Reload the page." }));
    expect(document.body.querySelector('[data-testid="decision-error"]')).toBeNull();
  });
});
