// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * feature-plan-ux-navigation-home.md §4.6 / T12 (UX-AUDIT B3): Approvals as a to-do list — "Waiting for you (n)" by
 * default (only rows the user may decide, oldest submitted first), Decided / Everything views, Review vs View, reason
 * chips only on submitted rows the user can't decide, flags, router.refresh() after a decision, no admin banner.
 */

const nav = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => nav, usePathname: () => '/admin/approvals' }));
const actions = vi.hoisted(() => ({
  approvePeriod: vi.fn(async () => ({ ok: true, data: undefined })),
  rejectPeriod: vi.fn(),
  getScopedPeriods: vi.fn(async () => [] as unknown[]),
  getTimesheetForReview: vi.fn(async () => ({ chargeCodes: [], entries: [], periodStatus: 'submitted', submissionCount: 1, canApprove: true, approvalBadge: null, approvalText: null })),
}));
vi.mock('@/server/actions/periods', () => ({ approvePeriod: actions.approvePeriod, rejectPeriod: actions.rejectPeriod, getScopedPeriods: actions.getScopedPeriods }));
vi.mock('@/server/actions/timesheet', () => ({ getTimesheetForReview: actions.getTimesheetForReview }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { ApprovalsClient, reasonChip, rowsForView, scopeSentence } from '@/app/(app)/admin/approvals/ApprovalsClient';
import { buttonByText, click, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';
import { expectNoAxeViolations } from '../helpers/axe';

const ME = 'me';
const row = (id: string, o: Record<string, unknown>) => ({
  id, userId: `u-${id}`, userName: `Person ${id}`, userEmail: `${id}@x`, periodStart: '2026-10-01', periodNumDays: 15,
  status: 'submitted', submittedAt: new Date('2026-10-16T10:00:00Z'), reviewedAt: null, reviewedBy: null, canApprove: false,
  approvalBadge: null, approvalText: null, submissionCount: 1, flags: null, ...o,
});
const PERIODS = [
  row('new', { canApprove: true, userName: 'Newer Nora', submittedAt: new Date('2026-10-17T10:00:00Z'), flags: { corrections: 2, lateEntries: 1, resubmitted: true } }),
  row('old', { canApprove: true, userName: 'Older Olga', submittedAt: new Date('2026-10-15T10:00:00Z'), flags: { corrections: 0, lateEntries: 0, resubmitted: false } }),
  row('mine', { userId: ME, userName: 'Me Myself' }),                                  // own, not decidable
  row('peer', { userName: 'Peer Pat' }),                                               // someone else's to decide
  row('done', { userName: 'Done Dana', status: 'approved', reviewedAt: new Date() }),
  row('draft', { userName: 'Draft Dee', status: 'draft' }),
];

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => { vi.clearAllMocks(); actions.getScopedPeriods.mockResolvedValue(PERIODS); });
afterEach(() => { unmount(m); m = undefined; });

const render = async (userRole = 'supervisor') => {
  m = await mount(<ApprovalsClient initialPeriods={PERIODS as never} currentUserId={ME} userRole={userRole} workspaceTimezone="America/New_York"
    scopeInfo={userRole === 'supervisor' ? { assignedContractCount: 0, assignedClinCount: 1, approvableEmployeeCount: 3, designatedByCount: 2 } : null} />);
  await wait(10);
};
const bodyNames = () => [...m!.container.querySelectorAll('tbody tr')].map((r) => r.querySelector('td')?.textContent ?? '');
const segment = (label: string) => [...m!.container.querySelectorAll('label')].find((l) => l.textContent?.startsWith(label)) as HTMLLabelElement;

describe('Approvals to-do list (T12)', () => {
  it('default "Waiting for you (2)": only decidable rows, oldest submitted first, each with Review and its flags', async () => {
    await render();
    expect(segment('Waiting for you').textContent).toBe('Waiting for you (2)');
    expect(bodyNames()).toEqual(['Older Olga', 'Newer Nora']);
    expect(m!.container.textContent).toContain('2 corrections');
    expect(m!.container.textContent).toContain('1 late entry');
    expect(m!.container.textContent).toContain('Resubmitted');
    expect(m!.container.textContent).toContain('Nothing unusual');
    expect([...m!.container.querySelectorAll('tbody button')].map((b) => b.textContent)).toEqual(['Review', 'Review']);
  });

  it('"Everything" shows every non-draft row, newest period first; undecidable submitted rows say View + the right chip; decided rows have no chip', async () => {
    await render();
    await click(segment('Everything'));
    const names = bodyNames();
    expect(names).toHaveLength(5);
    expect(names).not.toContain('Draft Dee');
    const rowOf = (name: string) => [...m!.container.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes(name))!;
    expect(rowOf('Me Myself').querySelector('button')!.textContent).toBe('View');
    expect(rowOf('Me Myself').querySelector('[data-testid="reason-chip"]')!.textContent).toBe('Your own — needs another approver');
    expect(rowOf('Peer Pat').querySelector('[data-testid="reason-chip"]')!.textContent).toBe('Approved by an admin or their designee');
    expect(rowOf('Done Dana').querySelector('[data-testid="reason-chip"]')).toBeNull();
    expect(rowOf('Older Olga').querySelector('[data-testid="reason-chip"]')).toBeNull();
    await click(segment('Decided'));
    expect(bodyNames()).toEqual(['Done Dana']);
  });

  it('reason chips per case (pure)', () => {
    expect(reasonChip({ status: 'submitted', canApprove: false, userId: ME }, ME, 'supervisor')).toBe('Your own — needs another approver');
    expect(reasonChip({ status: 'submitted', canApprove: false, userId: ME }, ME, 'admin')).toBe('Your own — another admin or designee approves');
    expect(reasonChip({ status: 'submitted', canApprove: false, userId: 'x' }, ME, 'admin')).toBe('Approved by an admin or their designee');
    expect(reasonChip({ status: 'approved', canApprove: false, userId: 'x' }, ME, 'admin')).toBeNull();
    expect(reasonChip({ status: 'submitted', canApprove: true, userId: 'x' }, ME, 'admin')).toBeNull();
    expect(rowsForView('everything', PERIODS as never).map((r) => r.id)).not.toContain('draft');
  });

  it('a decision calls router.refresh() (the sidebar count) and refetches the list', async () => {
    await render();
    await click([...m!.container.querySelectorAll('tbody button')][0]);
    await wait(30);
    await click(buttonByText('Approve'));
    await wait(30);
    expect(actions.approvePeriod).toHaveBeenCalledTimes(1);
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    expect(actions.getScopedPeriods).toHaveBeenCalled();
  });

  it('empty Waiting view says "Nothing is waiting for you."', async () => {
    m = await mount(<ApprovalsClient initialPeriods={[PERIODS[4]] as never} currentUserId={ME} userRole="admin" workspaceTimezone="UTC" scopeInfo={null} />);
    expect(m.container.textContent).toContain('Nothing is waiting for you.');
    expect(m.container.textContent).toContain('Waiting for you (0)');
  });

  it('scope sentence with plurals; the admin banner is gone; axe clean', async () => {
    expect(scopeSentence({ assignedContractCount: 0, assignedClinCount: 2, approvableEmployeeCount: 1, designatedByCount: 0 })).toBe('You review 1 person on 2 CLINs');
    expect(scopeSentence({ assignedContractCount: 0, assignedClinCount: 1, approvableEmployeeCount: 3, designatedByCount: 2 })).toBe('You review 3 people on 1 CLIN and 2 people who designated you');
    await render();
    expect(m!.container.querySelector('[data-testid="scope-sentence"]')!.textContent).toBe('You review 3 people on 1 CLIN and 2 people who designated you.');
    await expectNoAxeViolations(document.body);
    const src = readFileSync(path.resolve(__dirname, '../../app/(app)/admin/approvals/ApprovalsClient.tsx'), 'utf8');
    expect(src).not.toContain('You have full access to all employee timesheets.');
    expect(src).not.toContain('ROLE_COLOR');
  });
});
