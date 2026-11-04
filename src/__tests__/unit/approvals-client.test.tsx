// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * feature-plan-ux-navigation-home.md §4.6 / T12 (UX-AUDIT B3): Approvals as a to-do list — "Waiting for you (n)" by
 * default (only rows the user may decide), Decided / Everything views, Review vs View, reason chips only on submitted
 * rows the user can't decide, flags, router.refresh() after a decision, no admin banner.
 * feature-plan-ux-approvals-payroll.md §3.2 / A-6, A-10: Waiting keeps the server's compareWaiting order (no client
 * re-sort) with Hours; empty flags render nothing; Decided columns; no "Rejected" anywhere in the UI; the ?review=
 * deep link opens once, leaves the URL through history.replaceState, toasts when out of scope.
 */

const nav = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => nav, usePathname: () => '/admin/approvals' }));
const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toastError: toast.error, toastSuccess: vi.fn() }));
const actions = vi.hoisted(() => ({
  approvePeriod: vi.fn(async () => ({ ok: true, data: undefined })),
  rejectPeriod: vi.fn(),
  getScopedPeriods: vi.fn(async () => [] as unknown[]),
  getTimesheetForReview: vi.fn(async (userId: string) => ({ chargeCodes: [], entries: [], periodStatus: 'submitted', submissionCount: 1, canApprove: true, approvalBadge: null, approvalText: null, notes: {}, periodId: userId.replace(/^u-/, ''), numDays: 15, flagged: [], lastReturn: null })),
}));
vi.mock('@/server/actions/periods', () => ({ approvePeriod: actions.approvePeriod, rejectPeriod: actions.rejectPeriod, getScopedPeriods: actions.getScopedPeriods }));
vi.mock('@/server/actions/timesheet', () => ({ getTimesheetForReview: actions.getTimesheetForReview }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { ApprovalsClient, reasonChip, rowsForView, scopeSentence } from '@/app/(app)/admin/approvals/ApprovalsClient';
import { buttonByText, click, dialogTitled, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';
import { expectNoAxeViolations } from '../helpers/axe';

const ME = 'me';
const row = (id: string, o: Record<string, unknown>) => ({
  id, userId: `u-${id}`, userName: `Person ${id}`, userEmail: `${id}@x`, periodStart: '2026-10-01', periodNumDays: 15,
  status: 'submitted', submittedAt: new Date('2026-10-16T10:00:00Z'), reviewedAt: null, reviewedBy: null, canApprove: false,
  approvalBadge: null, approvalText: null, submissionCount: 1, flags: null, ...o,
});
// In the server's compareWaiting order (period, then submission): Older Olga before Newer Nora.
const PERIODS = [
  row('old', { canApprove: true, userName: 'Older Olga', submittedAt: new Date('2026-10-15T10:00:00Z'), hours: 80, flags: { corrections: 0, lateEntries: 0, resubmitted: false } }),
  row('new', { canApprove: true, userName: 'Newer Nora', submittedAt: new Date('2026-10-17T10:00:00Z'), hours: 92.5, flags: { corrections: 2, lateEntries: 1, resubmitted: true } }),
  row('mine', { userId: ME, userName: 'Me Myself' }),                                  // own, not decidable
  row('peer', { userName: 'Peer Pat' }),                                               // someone else's to decide
  row('done', { userName: 'Done Dana', status: 'approved', reviewedAt: new Date('2026-10-20T10:00:00Z'), periodStart: '2026-10-16', decidedByName: 'Sam Super', decidedAtText: 'Oct 20, 2026' }), // newest period
  row('back', { userName: 'Back Bo', status: 'rejected', reviewedAt: new Date('2026-10-21T10:00:00Z'), decidedByName: 'Back Bo', decidedAtText: 'Oct 21, 2026', approvalUiBadge: 'Self-returned', approvalBadge: 'Self-rejected' }),
  row('sept', { userName: 'Sept Sam', periodStart: '2026-09-16' }),                    // oldest period, not decidable
  row('draft', { userName: 'Draft Dee', status: 'draft' }),
];

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => { vi.clearAllMocks(); actions.getScopedPeriods.mockResolvedValue(PERIODS); });
afterEach(() => { unmount(m); m = undefined; });

const render = async (userRole = 'supervisor', periods: unknown[] = PERIODS, extra: Record<string, unknown> = {}) => {
  m = await mount(<ApprovalsClient initialPeriods={periods as never} currentUserId={ME} userRole={userRole} workspaceTimezone="America/New_York"
    scopeInfo={userRole === 'supervisor' ? { assignedContractCount: 0, assignedClinCount: 1, approvableEmployeeCount: 3, designatedByCount: 2 } : null} {...extra} />);
  await wait(10);
};
const headers = () => [...m!.container.querySelectorAll('thead th')].map((t) => t.textContent?.trim() ?? '').filter(Boolean);
const bodyNames = () => [...m!.container.querySelectorAll('tbody tr')].map((r) => r.querySelector('td')?.textContent ?? '');
const segment = (label: string) => [...m!.container.querySelectorAll('label')].find((l) => l.textContent?.startsWith(label)) as HTMLLabelElement;

describe('Approvals to-do list (T12)', () => {
  it('A-6: "Waiting for you (2)": decidable rows in the server\'s order, Hours, flags only where there are changes; Review is primary on the first row', async () => {
    await render();
    expect(segment('Waiting for you').textContent).toBe('Waiting for you (2)');
    expect(headers()).toEqual(['Employee', 'Pay period', 'Submitted', 'Hours', 'Worth a look', 'Actions']);
    expect(bodyNames()).toEqual(['Older Olga', 'Newer Nora']);
    const rows = [...m!.container.querySelectorAll('tbody tr')];
    expect(rows[0].textContent).toContain('Oct 1 – 15, 2026');
    expect(rows[0].textContent).toContain('Oct 15');
    expect(rows[0].textContent).toContain('80.00');
    expect(rows[1].textContent).toContain('92.50');
    expect(rows[1].textContent).toContain('2 corrections');
    expect(rows[1].textContent).toContain('1 late entry');
    expect(rows[1].textContent).toContain('Resubmitted after return');
    // An empty flag list renders nothing (no "Nothing unusual").
    expect(m!.container.textContent).not.toContain('Nothing unusual');
    expect(rows[0].querySelector('[class*="flag"]')).toBeNull();
    const buttons = [...m!.container.querySelectorAll('tbody button')] as HTMLElement[];
    expect(buttons.map((b) => b.textContent)).toEqual(['Review', 'Review']);
    expect(buttons.map((b) => b.getAttribute('data-variant') ?? 'filled')).toEqual(['filled', 'default']);
  });

  it('A-6: no client re-sort — Waiting shows the rows in exactly the order given (here not by submission)', async () => {
    await render('supervisor', [PERIODS[1], PERIODS[0]]);
    expect(bodyNames()).toEqual(['Newer Nora', 'Older Olga']);
    expect(m!.container.querySelector('thead [aria-sort], thead .mantine-ActionIcon-root[aria-label*="Sort"]')).toBeNull();
  });

  it('A-6: Decided columns — Status badge, Decided by (+ the self badge), Decided on; no "Rejected" anywhere', async () => {
    await render();
    await click(segment('Decided'));
    expect(headers()).toEqual(['Employee', 'Pay period', 'Status', 'Decided by', 'Decided on', 'Actions']);
    expect(bodyNames()).toEqual(['Back Bo', 'Done Dana']);                 // newest decision first
    const rows = [...m!.container.querySelectorAll('tbody tr')];
    expect(rows[0].textContent).toContain('Returned');
    expect(rows[0].textContent).toContain('Self-returned');
    expect(rows[0].textContent).toContain('Oct 21, 2026');
    expect(rows[1].textContent).toContain('Approved');
    expect(rows[1].textContent).toContain('Sam Super');
    expect(document.body.textContent).not.toMatch(/Rejected/i);
    await click(segment('Everything'));
    expect(document.body.textContent).not.toMatch(/Rejected/i);
  });

  it('"Everything" shows every non-draft row, newest period first; undecidable submitted rows say View + the right chip; decided rows have no chip', async () => {
    await render();
    await click(segment('Everything'));
    const names = bodyNames();
    expect(names).toHaveLength(7);
    expect(names).not.toContain('Draft Dee');
    const rowOf = (name: string) => [...m!.container.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes(name))!;
    expect(rowOf('Me Myself').querySelector('button')!.textContent).toBe('View');
    expect(rowOf('Me Myself').querySelector('[data-testid="reason-chip"]')!.textContent).toBe('Your own — needs another approver');
    expect(rowOf('Peer Pat').querySelector('[data-testid="reason-chip"]')!.textContent).toBe('Approved by an admin or their designee');
    expect(rowOf('Done Dana').querySelector('[data-testid="reason-chip"]')).toBeNull();
    expect(rowOf('Older Olga').querySelector('[data-testid="reason-chip"]')).toBeNull();
  });

  it('L9: switching from Waiting to Everything shows newest period first', async () => {
    await render();
    expect(bodyNames()).toEqual(['Older Olga', 'Newer Nora']);
    await click(segment('Everything'));
    const names = bodyNames();
    expect(names[0]).toBe('Done Dana');           // 2026-10-16
    expect(names[names.length - 1]).toBe('Sept Sam'); // 2026-09-16
  });

  it('the drawer title is "{Employee} · {Pay period}" for Review and View alike (UX-4b Part 2 §3.3)', async () => {
    await render();
    await click(segment('Everything'));
    const rowOf = (name: string) => [...m!.container.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes(name))!;
    await click(rowOf('Me Myself').querySelector('button'));
    await wait(30);
    expect(dialogTitled('Me Myself · Oct 1 – 15, 2026')).toBeTruthy();
    unmount(m);
    await render();
    await click(rowOf('Older Olga').querySelector('button'));
    await wait(30);
    expect(dialogTitled('Older Olga · Oct 1 – 15, 2026')).toBeTruthy();
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

  it('empty states: Waiting "Nothing is waiting for you. New timesheets appear here…"; Decided "No decided timesheets yet."', async () => {
    m = await mount(<ApprovalsClient initialPeriods={[PERIODS[3]] as never} currentUserId={ME} userRole="admin" workspaceTimezone="UTC" scopeInfo={null} />);
    expect(m.container.textContent).toContain('Nothing is waiting for you.');
    expect(m.container.textContent).toContain('New timesheets appear here when employees submit.');
    expect(m.container.textContent).toContain('Waiting for you (0)');
    await click(segment('Decided'));
    expect(m.container.textContent).toContain('No decided timesheets yet.');
  });

  it('the header: h1 "Approvals", the description, and the notices below the h1', async () => {
    await render('admin', PERIODS, { notices: <div data-testid="the-notices">notice</div> });
    const h1 = m!.container.querySelector('h1')!;
    expect(h1.textContent).toBe('Approvals');
    expect(m!.container.textContent).toContain('Timesheets waiting for you come first, oldest pay period first.');
    const n = m!.container.querySelector('[data-testid="the-notices"]')!;
    expect(h1.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('scope sentence with plurals; the admin banner is gone; axe clean', async () => {
    expect(scopeSentence({ assignedContractCount: 0, assignedClinCount: 2, approvableEmployeeCount: 1, designatedByCount: 0 })).toBe('You review 1 person on 2 CLINs');
    expect(scopeSentence({ assignedContractCount: 0, assignedClinCount: 1, approvableEmployeeCount: 3, designatedByCount: 2 })).toBe('You review 3 people on 1 CLIN and 2 people who designated you');
    expect(scopeSentence({ assignedContractCount: 0, assignedClinCount: 2, approvableEmployeeCount: 0, designatedByCount: 1 })).toBe('You review 1 person who designated you'); // L2
    await render();
    expect(m!.container.querySelector('[data-testid="scope-sentence"]')!.textContent).toBe('You review 3 people on 1 CLIN and 2 people who designated you.');
    await expectNoAxeViolations(document.body);
    const src = readFileSync(path.resolve(__dirname, '../../app/(app)/admin/approvals/ApprovalsClient.tsx'), 'utf8');
    expect(src).not.toContain('You have full access to all employee timesheets.');
    expect(src).not.toContain('ROLE_COLOR');
  });
});

describe('the ?review= deep link (A-10)', () => {
  let replaceSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    window.history.pushState(null, '', '/admin/approvals?review=old&x=1');
    replaceSpy = vi.spyOn(window.history, 'replaceState');
  });
  afterEach(() => { replaceSpy.mockRestore(); window.history.pushState(null, '', '/'); });

  it('opens once under StrictMode (one read), then removes the param with history.replaceState (no router call)', async () => {
    // StrictMode must wrap the ROOT for React to double-invoke effects (nested inside mount()'s providers it doesn't).
    const { StrictMode, act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { MantineProvider } = await import('@mantine/core');
    const { theme } = await import('@/theme');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<StrictMode><MantineProvider env="test" theme={theme}>
        <ApprovalsClient initialPeriods={PERIODS as never} currentUserId={ME} userRole="admin" workspaceTimezone="UTC" scopeInfo={null} initialReviewId="old" />
      </MantineProvider></StrictMode>);
    });
    m = { container, root };
    await wait(40);
    expect(actions.getTimesheetForReview).toHaveBeenCalledTimes(1);
    expect(actions.getTimesheetForReview).toHaveBeenCalledWith('u-old', '2026-10-01');
    expect(replaceSpy).toHaveBeenCalledWith(null, '', '/admin/approvals?x=1');
    expect(window.location.search).toBe('?x=1');
    expect(nav.replace).not.toHaveBeenCalled();
    expect(nav.push).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('an id not in the rows → the toast, no read; no id → nothing', async () => {
    m = await mount(<ApprovalsClient initialPeriods={PERIODS as never} currentUserId={ME} userRole="admin" workspaceTimezone="UTC" scopeInfo={null} initialReviewId="nope" />);
    await wait(20);
    expect(toast.error).toHaveBeenCalledWith(expect.objectContaining({ message: "That timesheet isn't available to you." }));
    expect(actions.getTimesheetForReview).not.toHaveBeenCalled();
    expect(replaceSpy).toHaveBeenCalledTimes(1);                      // the param still leaves the URL
    unmount(m);
    replaceSpy.mockClear();
    m = await mount(<ApprovalsClient initialPeriods={PERIODS as never} currentUserId={ME} userRole="admin" workspaceTimezone="UTC" scopeInfo={null} />);
    await wait(20);
    expect(actions.getTimesheetForReview).not.toHaveBeenCalled();
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it('state is set only after the read resolves (nothing opens while it is pending)', async () => {
    let resolve!: (v: unknown) => void;
    actions.getTimesheetForReview.mockImplementationOnce(() => new Promise((r) => { resolve = r; }) as never);
    m = await mount(<ApprovalsClient initialPeriods={PERIODS as never} currentUserId={ME} userRole="admin" workspaceTimezone="UTC" scopeInfo={null} initialReviewId="old" />);
    await wait(20);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    const { act } = await import('react');
    await act(async () => { resolve({ chargeCodes: [], entries: [], periodStatus: 'submitted', submissionCount: 1, canApprove: true, approvalBadge: null, approvalText: null, notes: {} }); });
    await wait(30);
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });
});

