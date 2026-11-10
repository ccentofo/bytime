// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * feature-plan-ux-people-codes.md §4.2, §4.4 / AS-2, AS-4, AS-5, AS-7:
 * AS-2 — Charge code access grouped by person: every active user; a code that can't be charged is dimmed with "Can't be
 *        charged right now" and not counted; n = 0 → the warn text; people with nothing chargeable sort last; Remove….
 * AS-4 — (feature-plan-approval-scope.md AS-14) a supervisor plus a code on a CLIN they lack shows NO notice: a charge
 *        code never gives approval authority.
 * AS-5 — Give access: held codes checked and aria-disabled ("already has access"); the CLIN box selects its selectable
 *        codes (indeterminate when partly); "Choose a person." / "Choose at least one charge code."; the success toast.
 * AS-7 — Approval scope (feature-plan-approval-scope.md §5): active supervisors listed even with no CLINs; their
 *        approval_scopes rows; People counts active employee members only; the uncovered line ignores an inactive
 *        supervisor's scope; Since names who granted it (or "converted from earlier data"); the review list (tags,
 *        Keep / Remove, Save review); Add (several CLINs) and Remove call the new actions.
 */

const actions = vi.hoisted(() => ({
  assign: vi.fn<(d: unknown) => Promise<unknown>>(async () => ({ ok: true, data: { assigned: 2 } })),
  unassign: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: undefined })),
  getCcAssignments: vi.fn(async () => [] as unknown[]),
  getScopesView: vi.fn(async () => ({ scopes: [] as unknown[], membership: [] as unknown[] })),
  grant: vi.fn<(d: unknown) => Promise<unknown>>(async () => ({ ok: true, data: { granted: 2 } })),
  revoke: vi.fn<(d: unknown) => Promise<unknown>>(async () => ({ ok: true, data: { changed: true } })),
  review: vi.fn<(d: unknown) => Promise<unknown>>(async () => ({ ok: true, data: { kept: 2, removed: 1, skipped: 0 } })),
  notify: vi.fn(),
}));
vi.mock('@/server/actions/charge-codes', () => ({
  assignChargeCodesToUser: actions.assign, unassignChargeCodeFromUser: actions.unassign, getChargeCodeAssignments: actions.getCcAssignments,
}));
vi.mock('@/server/actions/assignments', () => ({
  grantApprovalScope: actions.grant, revokeApprovalScope: actions.revoke, reviewMigratedScopes: actions.review, getApprovalScopesView: actions.getScopesView,
}));
vi.mock('@mantine/notifications', () => ({ notifications: { show: actions.notify } }));
// L10: a test can shrink the review chunk size (null = the real REVIEW_CHUNK), so it renders a handful of rows, not 501.
const chunking = vi.hoisted(() => ({ size: null as number | null }));
vi.mock('@/app/(app)/admin/assignments/review-chunks', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/app/(app)/admin/assignments/review-chunks')>();
  return { ...real, reviewChunks: (ids: string[], toRemove: ReadonlySet<string>) => real.reviewChunks(ids, toRemove, chunking.size ?? real.REVIEW_CHUNK) };
});
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('') }));
vi.mock('@/server/actions/labor-categories', () => ({ assignUserToLaborCategory: vi.fn(), endUserLaborCategoryAssignment: vi.fn(), getUserLaborCategoryAssignments: vi.fn() }));

import { AssignmentsClient } from '@/app/(app)/admin/assignments/AssignmentsClient';
import { holderTag, scopeRows, uncoveredClins } from '@/app/(app)/admin/assignments/ApprovalScopePanel';
import { buttonByText, click, dialogTitled, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => { vi.clearAllMocks(); chunking.size = null; });
afterEach(() => { unmount(m); m = undefined; });

const person = (id: string, fullName: string, role = 'employee', isActive = true) => ({ id, fullName, email: `${id}@x`, role, isActive, approverId: null });
const USERS = [
  person('u-jane', 'Jane Smith'), person('u-amy', 'Amy Adams'), person('u-sarah', 'Sarah Wilson', 'supervisor'),
  person('u-sam', 'Sam Solo', 'supervisor'), person('u-old', 'Old Gone', 'employee', false), person('u-ex', 'Ex Super', 'supervisor', false),
];
const code = (id: string, c: string, clinId: string, clinNumber: string, contractName: string, o: Record<string, unknown> = {}) => ({
  id, code: c, name: `${c} name`, clinId, clinNumber, clinDescription: `CLIN ${clinNumber} desc`, contractName, workLocation: 'onsite', chargeable: true, ...o,
});
const CODES = [
  code('cc-n1', 'NAV-1', 'clin-n1', '0001', 'NAVAIR'), code('cc-n1b', 'NAV-1B', 'clin-n1', '0001', 'NAVAIR'),
  code('cc-d2', 'DISA-2', 'clin-d2', '0002', 'DISA'), code('cc-x', 'OLD-9', 'clin-x', '0009', 'Old', { chargeable: false }),
];
const access = (userId: string, userName: string, c: (typeof CODES)[number], isActive = true) => ({
  userId, userName, chargeCodeId: c.id, code: c.code, name: c.name, clinNumber: c.clinNumber, contractName: c.contractName, contractNumber: 'K',
  workLocation: c.workLocation, isActive, assignedAt: new Date('2026-01-01T00:00:00Z'),
});
const ACCESS = [
  access('u-jane', 'Jane Smith', CODES[0]), access('u-jane', 'Jane Smith', CODES[3]),     // one chargeable, one not
  access('u-amy', 'Amy Adams', CODES[3]),                                                 // only a non-chargeable code
  access('u-sarah', 'Sarah Wilson', CODES[0]),
  access('u-sam', 'Sam Solo', CODES[2], false),                                          // removed access: not listed, not counted
];
const scope = (id: string, supervisorId: string, clinId: string, clinNumber: string, contractName: string, o: Record<string, unknown> = {}) => {
  const u = USERS.find((x) => x.id === supervisorId)!;
  return {
    id, supervisorId, supervisorName: u.fullName, holderRole: u.role, holderActive: u.isActive, clinId, clinNumber, clinDescription: 'Base',
    contractName, contractNumber: 'K', clinActive: true, source: 'app', grantedAt: new Date('2025-12-01T15:00:00Z'), grantedByName: 'Ann Admin', needsReview: false, ...o,
  };
};
const SCOPES = [
  scope('s1', 'u-sarah', 'clin-n1', '0001', 'NAVAIR'),
  scope('s2', 'u-ex', 'clin-d2', '0002', 'DISA'),                                       // only an INACTIVE supervisor covers DISA 0002
];
const MEMBERSHIP = [
  { userId: 'u-sarah', clinId: 'clin-n1' }, { userId: 'u-jane', clinId: 'clin-n1' }, { userId: 'u-old', clinId: 'clin-n1' },
  { userId: 'u-sam', clinId: 'clin-n1' }, { userId: 'u-jane', clinId: 'clin-d2' },
];
const ACTIVE_CLINS = [
  { clinId: 'clin-n1', clinNumber: '0001', clinDescription: 'Base', contractId: 'k-n', contractName: 'NAVAIR', contractNumber: 'N' },
  { clinId: 'clin-d2', clinNumber: '0002', clinDescription: 'Cloud', contractId: 'k-d', contractName: 'DISA', contractNumber: 'D' },
];
const LCAT = { initialAssignments: [], assignableLcats: [], rateByCategory: {}, categoryNames: {}, today: '2026-11-06' as never };

const render = async (o: Record<string, unknown> = {}) => {
  m = await mount(<AssignmentsClient initialTab="charge-codes" lcat={LCAT} initialScopes={{ scopes: SCOPES, membership: MEMBERSHIP } as never} users={USERS as never}
    activeClins={ACTIVE_CLINS} chargeCodes={CODES as never} workspaceTimezone="America/New_York" initialChargeCodeAssignments={ACCESS as never}
    approverNames={{ 'u-sarah': 'Ann Admin', 'u-sam': null }} {...o} />);
  await wait(10);
};
const accessPanel = () => document.getElementById([...document.body.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Charge code access')!.getAttribute('aria-controls')!)!;
const rowsOf = (root: Element) => [...root.querySelectorAll('tbody tr')].map((r) => r.textContent ?? '');
const chooseIn = async (dialog: Element, label: string, option: string) => {
  const l = [...dialog.querySelectorAll<HTMLLabelElement>('label')].find((x) => x.textContent?.startsWith(label))!;
  await click(document.getElementById(l.htmlFor));
  await click([...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent === option));
};

describe('Charge code access by person (AS-2)', () => {
  it('active people only; non-chargeable rows dimmed and not counted; n = 0 → the warn text and last in order', async () => {
    await render();
    const text = rowsOf(accessPanel());
    const parents = text.filter((t) => /codes? ·|No charge codes/.test(t));
    expect(parents.map((t) => t.split(/\d+ codes?|No charge codes/)[0].replace('Add codes', '').trim())).toEqual(['Jane Smith', 'Sarah Wilson', 'Amy Adams', 'Sam Solo']);
    expect(text.find((t) => t.startsWith('Jane Smith'))).toContain('1 code · NAVAIR');
    expect(text.find((t) => t.startsWith('Amy Adams'))).toContain('No charge codes · only indirect time on their timesheet');
    expect(text.some((t) => t.includes('Old Gone'))).toBe(false);
    const dim = accessPanel().querySelectorAll('[data-testid="not-chargeable"]');
    expect(dim).toHaveLength(2);
    expect(dim[0].textContent).toContain("Can't be charged right now");
  });

  it('Remove…: "Remove {name}\'s access to {code}?" then unassignChargeCodeFromUser and a refetch', async () => {
    await render();
    const row = [...accessPanel().querySelectorAll('tbody tr')].find((r) => r.textContent?.includes('NAV-1') && !r.textContent.includes('Sarah'))!;
    await click([...row.querySelectorAll('button')].find((b) => b.textContent === 'Remove…'));
    const dialog = dialogTitled("Remove Jane Smith's access to NAV-1?")!;
    expect(dialog.textContent).toContain("They can't charge new time to it. Hours already recorded stay on record.");
    await click(buttonByText('Remove'));
    expect(actions.unassign).toHaveBeenCalledWith('u-jane', 'cc-n1');
    expect(actions.getCcAssignments).toHaveBeenCalled();
  });
});

describe('Give access (AS-4, AS-5)', () => {
  const open = async () => { await click(buttonByText('Give access')); return dialogTitled('Give access to charge codes')!; };
  const box = (dialog: Element, label: string) => dialog.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;

  it('AS-5: held codes checked and aria-disabled; the CLIN box selects the selectable codes (indeterminate when partly); validation', async () => {
    await render();
    const dialog = await open();
    await click(buttonByText('Give access to 0 codes'));
    expect(dialog.textContent).toContain('Choose a person.');
    expect(dialog.textContent).toContain('Choose at least one charge code.');
    expect(actions.assign).not.toHaveBeenCalled();
    await chooseIn(dialog, 'Person', 'Jane Smith');
    const held = box(dialog, 'NAV-1, already has access');
    expect([held.checked, held.getAttribute('aria-disabled'), held.hasAttribute('disabled')]).toEqual([true, 'true', false]);
    expect(dialog.textContent).toContain('already has access');
    expect(dialog.querySelector('input[aria-label^="OLD-9"]')).toBeNull();            // not chargeable → not offered (even though held)
    await click(held);                                                               // a held code can't be unticked or counted
    expect(held.checked).toBe(true);
    expect(dialog.querySelector('[data-testid="give-access-count"]')!.textContent).toBe('0 codes selected');
    const navClin = box(dialog, 'All of NAVAIR · CLIN 0001 CLIN 0001 desc');
    await click(navClin);
    expect(box(dialog, 'NAV-1B').checked).toBe(true);
    expect(navClin.checked).toBe(true);
    await click(box(dialog, 'NAV-1B'));
    expect(navClin.checked).toBe(false);
    await click(box(dialog, 'DISA-2'));
    expect(dialog.querySelector('[data-testid="give-access-count"]')!.textContent).toBe('1 code selected');
    await click(buttonByText('Give access to 1 code'));
    await wait(10);
    expect(actions.assign).toHaveBeenCalledWith({ userId: 'u-jane', chargeCodeIds: ['cc-d2'] });
    expect(actions.notify.mock.calls.map((c) => (c[0] as { message: string }).message)).toContain('Jane Smith can now charge 2 more codes');
  });

  it('a partly selected CLIN is indeterminate; a server error keeps the selection in an Alert', async () => {
    await render();
    const dialog = await open();
    await chooseIn(dialog, 'Person', 'Amy Adams');
    await click(box(dialog, 'NAV-1'));
    expect(box(dialog, 'All of NAVAIR · CLIN 0001 CLIN 0001 desc').getAttribute('data-indeterminate')).toBe('true');
    actions.assign.mockResolvedValueOnce({ ok: false, code: 'validation', error: "NAV-1 can't be charged right now. Refresh and try again." });
    await click(buttonByText('Give access to 1 code'));
    await wait(10);
    expect(dialog.querySelector('[role="alert"]')!.textContent).toBe("NAV-1 can't be charged right now. Refresh and try again.");
    expect(box(dialog, 'NAV-1').checked).toBe(true);
  });

  it('AS-4 / AS-14: a supervisor plus a code on a CLIN they lack (the old trigger) shows NO notice; nothing else changes', async () => {
    await render();
    const dialog = await open();
    await chooseIn(dialog, 'Person', 'Sarah Wilson');
    await click(box(dialog, 'DISA-2'));                                              // DISA 0002: no scope, no membership
    expect(dialog.querySelector('[data-testid="supervisor-notice"]')).toBeNull();
    expect(dialog.textContent).not.toMatch(/approve/i);
    await click(buttonByText('Give access to 1 code'));
    await wait(10);
    expect(actions.assign).toHaveBeenCalledWith({ userId: 'u-sarah', chargeCodeIds: ['cc-d2'] });
  });
});

describe('Approval scope (AS-7)', () => {
  const panel = () => document.getElementById([...document.body.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Approval scope')!.getAttribute('aria-controls')!)!;
  const openTab = async (o: Record<string, unknown> = {}) => {
    await render({ initialTab: 'approval-scope', ...o });
    await click([...document.body.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Approval scope'));
  };

  it('active supervisors even with no CLINs; their scope rows only; People counts active employee members; the approver line', () => {
    const rows = scopeRows(USERS as never, SCOPES as never, MEMBERSHIP, { 'u-sarah': 'Ann Admin', 'u-sam': null });
    expect(rows.map((r) => r.level === 'supervisor' && [r.person.fullName, r.children.length, r.approver])).toEqual([
      ['Sam Solo', 0, null], ['Sarah Wilson', 1, 'Ann Admin'],
    ]);
    const sarah = rows[1].level === 'supervisor' ? rows[1].children[0] : null;
    expect(sarah && sarah.level === 'clin' && sarah.people).toBe(1);               // Jane — not Old Gone (inactive), not Sam or Sarah (supervisors)
  });

  it('uncovered: a CLIN with an active employee member and no active supervisor\'s scope (an inactive supervisor doesn\'t cover it; membership never does)', () => {
    expect(uncoveredClins(USERS as never, SCOPES as never, MEMBERSHIP, ACTIVE_CLINS).map((c) => c.clinId)).toEqual(['clin-d2']);
    // Sarah's own membership on DISA 0002 (she charges it) doesn't cover it either.
    expect(uncoveredClins(USERS as never, SCOPES as never, [...MEMBERSHIP, { userId: 'u-sarah', clinId: 'clin-d2' }], ACTIVE_CLINS).map((c) => c.clinId)).toEqual(['clin-d2']);
  });

  it('renders the notice, "{n} CLINs · approver: …", Since with who granted it (or converted), and the uncovered line', async () => {
    await openTab({ initialScopes: { scopes: [...SCOPES, scope('s3', 'u-sam', 'clin-d2', '0002', 'DISA', { source: 'migration', grantedByName: null })], membership: MEMBERSHIP } });
    expect(panel().textContent).toContain('Admins can approve anyone. A supervisor approves employees who work on the CLINs below');
    const summaries = [...panel().querySelectorAll('[data-testid="scope-summary"]')].map((s) => s.textContent);
    expect(summaries).toEqual(['1 CLIN · approver: admins', '1 CLIN · approver: Ann Admin']);
    expect([...panel().querySelectorAll('[data-testid="scope-since"]')].map((s) => s.textContent)).toEqual(['Dec 1, 2025 converted from earlier data', 'Dec 1, 2025 by Ann Admin']);
    expect(panel().querySelector('[data-testid="uncovered-clins"]')).toBeNull();     // Sam covers DISA 0002 now
  });

  it('Remove…: the confirm, then revokeApprovalScope and a refetch; Add CLINs: several at once → grantApprovalScope', async () => {
    await openTab();
    expect(panel().querySelector('[data-testid="uncovered-clins"]')!.textContent).toBe('Not covered by a supervisor: DISA CLIN 0002 — admins approve these.');
    const row = [...panel().querySelectorAll('tbody tr')].find((r) => r.textContent?.includes('NAVAIR · CLIN 0001'))!;
    await click([...row.querySelectorAll('button')].find((b) => b.textContent === 'Remove…'));
    const confirm = dialogTitled("Remove NAVAIR CLIN 0001 from Sarah Wilson's approval scope?")!;
    expect(confirm.textContent).toContain("They'll stop approving employees on this CLIN.");
    expect(confirm.textContent).not.toMatch(/charge code/i);
    await click([...confirm.querySelectorAll('button')].find((b) => b.textContent === 'Remove'));
    await wait(10);
    expect(actions.revoke).toHaveBeenCalledWith({ supervisorId: 'u-sarah', clinId: 'clin-n1' });
    expect(actions.getScopesView).toHaveBeenCalled();

    const sam = [...panel().querySelectorAll('tbody tr')].find((r) => r.textContent?.includes('Sam Solo'))!;
    await click([...sam.querySelectorAll('button')].find((b) => b.textContent === 'Add CLINs'));
    const dialog = dialogTitled('Add CLINs to a supervisor')!;
    const input = document.getElementById([...dialog.querySelectorAll<HTMLLabelElement>('label')].find((l) => l.textContent?.startsWith('CLINs they approve'))!.htmlFor)!;
    for (const option of ['NAVAIR CLIN 0001 — Base', 'DISA CLIN 0002 — Cloud']) {
      await click(input);
      await click([...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent === option));
    }
    await click([...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Add CLINs'));
    await wait(10);
    expect(actions.grant).toHaveBeenCalledWith({ supervisorId: 'u-sam', clinIds: ['clin-n1', 'clin-d2'] });
  });

  it('the review list: tags inactive holders, ex-supervisors and inactive CLINs; Keep by default; Save review sends keep / remove', async () => {
    const review = [
      scope('r1', 'u-sarah', 'clin-d2', '0002', 'DISA', { source: 'migration', needsReview: true }),
      scope('r2', 'u-ex', 'clin-n1', '0001', 'NAVAIR', { source: 'migration', needsReview: true }),
      scope('r3', 'u-jane', 'clin-n1', '0001', 'NAVAIR', { source: 'migration', needsReview: true, clinActive: false }),
    ];
    expect([holderTag({ holderActive: false, holderRole: 'supervisor' }), holderTag({ holderActive: true, holderRole: 'employee' }), holderTag({ holderActive: true, holderRole: 'supervisor' })])
      .toEqual([' (inactive)', ' (no longer a supervisor)', '']);
    await openTab({ initialScopes: { scopes: [...SCOPES, ...review], membership: MEMBERSHIP } });
    const list = panel().querySelector('[data-testid="scope-review"]')!;
    expect(list.textContent).toContain('These approval scopes were converted from earlier assignments. Keep the ones that are right and remove any that weren\'t intended.');
    expect([...list.querySelectorAll('[data-testid="scope-review-row"]')].map((r) => r.querySelectorAll('td')[0].textContent + ' | ' + r.querySelectorAll('td')[1].textContent)).toEqual([
      'Sarah Wilson | DISA CLIN 0002', 'Ex Super (inactive) | NAVAIR CLIN 0001', 'Jane Smith (no longer a supervisor) | NAVAIR CLIN 0001 (inactive)',
    ]);
    const removeOf = (i: number) => [...list.querySelectorAll('[data-testid="scope-review-row"]')][i].querySelector('input[value="remove"]');
    await click(removeOf(1));
    await click([...list.querySelectorAll('button')].find((b) => b.textContent === 'Save review'));
    await wait(10);
    expect(actions.review).toHaveBeenCalledWith({ keep: ['r1', 'r3'], remove: ['r2'] });
    expect(actions.notify.mock.calls.map((c) => (c[0] as { title: string }).title)).toContain('Approval scopes reviewed');
    expect(actions.getScopesView).toHaveBeenCalled();
  });

  it('L9: the review table is named "Approval scopes to review"', async () => {
    await openTab({ initialScopes: { scopes: [...SCOPES, scope('r1', 'u-sarah', 'clin-d2', '0002', 'DISA', { source: 'migration', needsReview: true })], membership: MEMBERSHIP } });
    expect(panel().querySelector('[data-testid="scope-review"] table')!.getAttribute('aria-label')).toBe('Approval scopes to review');
  });

  it('L10: reviewChunks splits at REVIEW_CHUNK (500), each chunk with its own keep / remove ids', async () => {
    const { REVIEW_CHUNK, reviewChunks } = await vi.importActual<typeof import('@/app/(app)/admin/assignments/review-chunks')>('@/app/(app)/admin/assignments/review-chunks');
    expect(REVIEW_CHUNK).toBe(500);
    const chunks = reviewChunks(Array.from({ length: 1201 }, (_, i) => `r${i}`), new Set(['r0', 'r600', 'r1200']));
    expect(chunks.map((c) => [c.keep.length, c.remove])).toEqual([[499, ['r0']], [499, ['r600']], [200, ['r1200']]]);
  });

  it('L10: "Save review" sends one call per chunk, summing the counts; a failed chunk stops, shows its error and refetches', async () => {
    chunking.size = 2;                                                               // 5 rows → chunks of 2, 2, 1
    const five = Array.from({ length: 5 }, (_, i) => scope(`m${i}`, 'u-sarah', 'clin-d2', '0002', 'DISA', { source: 'migration', needsReview: true }));
    const view = { scopes: [...SCOPES, ...five], membership: MEMBERSHIP };
    actions.review
      .mockResolvedValueOnce({ ok: true, data: { kept: 1, removed: 1, skipped: 0 } })
      .mockResolvedValueOnce({ ok: true, data: { kept: 2, removed: 0, skipped: 0 } })
      .mockResolvedValueOnce({ ok: true, data: { kept: 1, removed: 0, skipped: 0 } });
    await openTab({ initialScopes: view });
    const rows = () => [...panel().querySelectorAll('[data-testid="scope-review-row"]')];
    await click(rows()[1].querySelector('input[value="remove"]'));
    await click([...panel().querySelectorAll('button')].find((b) => b.textContent === 'Save review'));
    await wait(20);
    expect(actions.review.mock.calls.map((c) => c[0])).toEqual([
      { keep: ['m0'], remove: ['m1'] }, { keep: ['m2', 'm3'], remove: [] }, { keep: ['m4'], remove: [] },
    ]);
    expect(actions.notify.mock.calls.map((c) => (c[0] as { message: string }).message)).toContain('4 kept, 1 removed.');

    unmount(m);
    vi.clearAllMocks();
    actions.review
      .mockResolvedValueOnce({ ok: true, data: { kept: 2, removed: 0, skipped: 0 } })
      .mockResolvedValueOnce({ ok: false, code: 'validation', error: 'Review 500 approval scopes or fewer at a time.' });
    actions.getScopesView.mockResolvedValueOnce({ scopes: [...SCOPES, ...five.slice(2)], membership: MEMBERSHIP });   // the first chunk was saved
    await openTab({ initialScopes: view });
    await click([...panel().querySelectorAll('button')].find((b) => b.textContent === 'Save review'));
    await wait(20);
    expect(actions.review).toHaveBeenCalledTimes(2);                                // stopped at the failed chunk; the third never sent
    expect(panel().querySelector('[data-testid="scope-review"] [role="alert"]')!.textContent).toBe('Review 500 approval scopes or fewer at a time.');
    expect(actions.getScopesView).toHaveBeenCalled();                               // earlier chunks were saved: refetch
    expect(actions.notify.mock.calls.map((c) => (c[0] as { title: string }).title)).not.toContain('Approval scopes reviewed');
  });

  it('L11: Add for a supervisor who already approves every active CLIN says so in the dropdown', async () => {
    await openTab({ initialScopes: { scopes: [...SCOPES, scope('s9', 'u-sarah', 'clin-d2', '0002', 'DISA')], membership: MEMBERSHIP } });
    const sarah = [...panel().querySelectorAll('tbody tr')].find((r) => r.textContent?.includes('Sarah Wilson'))!;
    await click([...sarah.querySelectorAll('button')].find((b) => b.textContent === 'Add CLINs'));
    const dialog = dialogTitled('Add CLINs to a supervisor')!;
    const input = document.getElementById([...dialog.querySelectorAll<HTMLLabelElement>('label')].find((l) => l.textContent?.startsWith('CLINs they approve'))!.htmlFor)!;
    await click(input);
    expect(document.getElementById(input.getAttribute('aria-controls')!)?.textContent ?? document.body.textContent).toContain('They already approve every active CLIN.');
  });

  it('no review rows → no review list', async () => {
    await openTab();
    expect(panel().querySelector('[data-testid="scope-review"]')).toBeNull();
  });
});
