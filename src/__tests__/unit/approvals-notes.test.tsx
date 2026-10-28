// @vitest-environment jsdom
import '@testing-library/react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * feature-plan-ux-timesheet-ui.md B-T12 (§4.12): the Approvals drawer lists the period's notes from the `notes` map
 * (non-empty only, date then row, "{ddd, MMM D} · {code} {rowName} · {body}", "Removed code" for a row not in the review);
 * the row label is "{clin} {rowName}"; a cell with a note shows the glyph plus sr ", note"; a missing `notes` is {}.
 */

const nav = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => nav, usePathname: () => '/admin/approvals' }));
const actions = vi.hoisted(() => ({ getTimesheetForReview: vi.fn() }));
vi.mock('@/server/actions/periods', () => ({ approvePeriod: vi.fn(), rejectPeriod: vi.fn(), getScopedPeriods: vi.fn(async () => []) }));
vi.mock('@/server/actions/timesheet', () => ({ getTimesheetForReview: actions.getTimesheetForReview }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { ApprovalsClient, reviewNotes } from '@/app/(app)/admin/approvals/ApprovalsClient';
import { click, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';
import { expectNoAxeViolations } from '../helpers/axe';
import { chargeCode, CC, CC2, IND } from '../helpers/timesheet-fixtures';
import type { CalendarDate } from '@/lib/calendar-date';

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => vi.clearAllMocks());
afterEach(() => { unmount(m); m = undefined; });

// Oct 1–15, 2026 (Oct 1 is a Thursday).
const START = '2026-10-01' as CalendarDate;
const CODES = [
  chargeCode({ id: CC, clin: '0001', name: 'Systems engineering', projectName: 'Atlas' }),
  chargeCode({ id: IND, clin: 'OH', name: 'Overhead', projectName: 'Indirect' }),
];
const NOTES = {
  [`${IND}-0`]: { body: 'Training day', revision: 1 },
  [`${CC}-2`]: { body: 'Site visit', revision: 1 },
  [`${CC}-0`]: { body: 'Kickoff', revision: 2 },
  [`${CC}-5`]: { body: '', revision: 3 },                 // removed: not listed
  [`${CC2}-1`]: { body: 'Old work', revision: 1 },        // its row isn't in the review
};
const PERIOD = {
  id: 'p1', userId: 'jane', userName: 'Jane Doe', userEmail: 'jane@x', periodStart: START, periodNumDays: 15, status: 'submitted',
  submittedAt: new Date('2026-10-16T10:00:00Z'), reviewedAt: null, reviewedBy: null, canApprove: true, approvalBadge: null, approvalText: null,
  submissionCount: 1, flags: null,
};
const review = (o: Record<string, unknown> = {}) => ({
  chargeCodes: CODES,
  entries: [{ chargeCodeId: CC, hours: [8, 0, 4, ...Array(12).fill(0)] }, { chargeCodeId: IND, hours: [0, 8, ...Array(13).fill(0)] }],
  periodStatus: 'submitted', submissionCount: 1, canApprove: true, approvalBadge: null, approvalText: null, notes: NOTES, ...o,
});
const openDrawer = async () => {
  m = await mount(<ApprovalsClient initialPeriods={[PERIOD] as never} currentUserId="sarah" userRole="admin" workspaceTimezone="America/New_York" scopeInfo={null} />);
  await wait(10);
  await click(m.container.querySelector('tbody tr button'));
  await wait(30);
};
const drawerRows = () => [...document.body.querySelectorAll('[role="dialog"] tbody tr')];

describe('Approvals drawer notes (B-T12)', () => {
  it('reviewNotes: non-empty only, sorted by date then row, "{ddd, MMM D} · {code} {rowName} · {body}", "Removed code"', () => {
    expect(reviewNotes(NOTES, CODES, START).map((n) => n.text)).toEqual([
      'Thu, Oct 1 · 0001 Systems engineering · Kickoff',
      'Thu, Oct 1 · OH Overhead · Training day',
      'Fri, Oct 2 · Removed code · Old work',
      'Sat, Oct 3 · 0001 Systems engineering · Site visit',
    ]);
    expect(reviewNotes(undefined, CODES, START)).toEqual([]);
  });

  it('the drawer: row labels use rowName, the Notes list renders, and note cells carry the glyph plus sr ", note"', async () => {
    actions.getTimesheetForReview.mockResolvedValue(review());
    await openDrawer();
    expect(drawerRows().map((r) => r.querySelector('td')?.textContent)).toEqual(['0001 Systems engineering', 'OH Overhead']);
    expect(document.body.textContent).not.toContain('0001 — Atlas');
    const list = document.body.querySelector('[data-testid="review-notes"]')!;
    expect(list.getAttribute('aria-labelledby')).toBe('review-notes-heading');
    expect(document.getElementById('review-notes-heading')!.textContent).toBe('Notes');
    expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Thu, Oct 1 · 0001 Systems engineering · Kickoff',
      'Thu, Oct 1 · OH Overhead · Training day',
      'Fri, Oct 2 · Removed code · Old work',
      'Sat, Oct 3 · 0001 Systems engineering · Site visit',
    ]);
    // Cells: day 0 and day 2 on the direct row, day 0 on overhead; the emptied note (day 5) shows nothing.
    const noted = (r: number) => [...drawerRows()[r].querySelectorAll('td')].slice(1).flatMap((td, i) => (td.querySelector('[data-testid="note-indicator"]') ? [i] : []));
    expect(noted(0)).toEqual([0, 2]);
    expect(noted(1)).toEqual([0]);
    const indicator = drawerRows()[0].querySelectorAll('td')[1].querySelector('[data-testid="note-indicator"]')!;
    expect(indicator.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(indicator.textContent).toBe(' , note');
    await expectNoAxeViolations(document.body);
  });

  it('a review without `notes` (or with an empty map) doesn\'t crash and shows no Notes list', async () => {
    const { notes: _omit, ...withoutNotes } = review();
    void _omit;
    actions.getTimesheetForReview.mockResolvedValue(withoutNotes);
    await openDrawer();
    expect(drawerRows()).toHaveLength(2);
    expect(document.body.querySelector('[data-testid="review-notes"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="note-indicator"]')).toBeNull();
  });
});
