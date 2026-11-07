// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * feature-plan-ux-people-codes.md §4.2, §4.4 / AS-2, AS-4, AS-5, AS-7:
 * AS-2 — Charge code access grouped by person: every active user; a code that can't be charged is dimmed with "Can't be
 *        charged right now" and not counted; n = 0 → the warn text; people with nothing chargeable sort last; Remove….
 * AS-4 — R8: choosing a supervisor plus a code on a CLIN they have no active row on shows the notice naming that CLIN;
 *        an employee shows none.
 * AS-5 — Give access: held codes checked and aria-disabled ("already has access"); the CLIN box selects its selectable
 *        codes (indeterminate when partly); "Choose a person." / "Choose at least one charge code."; the success toast.
 * AS-7 — Approval scope: active supervisors listed even with no CLINs; People counts active employees only; the
 *        uncovered line ignores an inactive supervisor's row.
 */

const actions = vi.hoisted(() => ({
  assign: vi.fn<(d: unknown) => Promise<unknown>>(async () => ({ ok: true, data: { assigned: 2 } })),
  unassign: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: undefined })),
  getCcAssignments: vi.fn(async () => [] as unknown[]),
  getAssignments: vi.fn(async () => [] as unknown[]),
  notify: vi.fn(),
}));
vi.mock('@/server/actions/charge-codes', () => ({
  assignChargeCodesToUser: actions.assign, unassignChargeCodeFromUser: actions.unassign, getChargeCodeAssignments: actions.getCcAssignments,
}));
vi.mock('@/server/actions/assignments', () => ({ assignUserToClin: vi.fn(), unassignUserFromClin: vi.fn(), getAssignments: actions.getAssignments }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: actions.notify } }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('') }));
vi.mock('@/server/actions/labor-categories', () => ({ assignUserToLaborCategory: vi.fn(), endUserLaborCategoryAssignment: vi.fn(), getUserLaborCategoryAssignments: vi.fn() }));

import { AssignmentsClient } from '@/app/(app)/admin/assignments/AssignmentsClient';
import { scopeRows, uncoveredClins } from '@/app/(app)/admin/assignments/ApprovalScopePanel';
import { buttonByText, click, dialogTitled, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => vi.clearAllMocks());
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
const scope = (id: string, userId: string, clinId: string, clinNumber: string, contractName: string, isActive = true) => ({
  id, userId, clinId, slinId: null, isActive, assignedAt: new Date('2025-12-01T15:00:00Z'), userName: USERS.find((u) => u.id === userId)!.fullName,
  userEmail: 'x', clinNumber, clinDescription: 'Base', contractName, contractNumber: 'K', slinNumber: null, slinDescription: null,
});
const SCOPE = [
  scope('a1', 'u-sarah', 'clin-n1', '0001', 'NAVAIR'), scope('a2', 'u-jane', 'clin-n1', '0001', 'NAVAIR'),
  scope('a3', 'u-old', 'clin-n1', '0001', 'NAVAIR'), scope('a4', 'u-sam', 'clin-n1', '0001', 'NAVAIR', false),
  scope('a5', 'u-jane', 'clin-d2', '0002', 'DISA'), scope('a6', 'u-ex', 'clin-d2', '0002', 'DISA'),     // only an INACTIVE supervisor covers DISA 0002
];
const ACTIVE_CLINS = [
  { clinId: 'clin-n1', clinNumber: '0001', clinDescription: 'Base', contractId: 'k-n', contractName: 'NAVAIR', contractNumber: 'N' },
  { clinId: 'clin-d2', clinNumber: '0002', clinDescription: 'Cloud', contractId: 'k-d', contractName: 'DISA', contractNumber: 'D' },
];
const LCAT = { initialAssignments: [], assignableLcats: [], rateByCategory: {}, categoryNames: {}, today: '2026-11-06' as never };

const render = async (o: Record<string, unknown> = {}) => {
  m = await mount(<AssignmentsClient initialTab="charge-codes" lcat={LCAT} initialAssignments={SCOPE as never} users={USERS as never}
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

  it('AS-4: a supervisor plus a code on a CLIN they have no row on → the notice naming that CLIN; an employee → none', async () => {
    await render();
    const dialog = await open();
    await chooseIn(dialog, 'Person', 'Sarah Wilson');
    await click(box(dialog, 'NAV-1B'));                                              // NAVAIR 0001: she already has it
    expect(dialog.querySelector('[data-testid="supervisor-notice"]')).toBeNull();
    await click(box(dialog, 'DISA-2'));
    expect(dialog.querySelector('[data-testid="supervisor-notice"]')!.textContent)
      .toContain('Sarah Wilson is a supervisor. These codes also let them approve employees on DISA CLIN 0002. You can change that on Approval scope.');
    await chooseIn(dialog, 'Person', 'Amy Adams');
    await click(box(dialog, 'DISA-2'));
    expect(dialog.querySelector('[data-testid="supervisor-notice"]')).toBeNull();
  });
});

describe('Approval scope (AS-7)', () => {
  it('active supervisors even with no CLINs; People counts active employees only; the approver line', () => {
    const rows = scopeRows(USERS as never, SCOPE as never, { 'u-sarah': 'Ann Admin', 'u-sam': null });
    expect(rows.map((r) => r.level === 'supervisor' && [r.person.fullName, r.children.length, r.approver])).toEqual([
      ['Sam Solo', 0, null], ['Sarah Wilson', 1, 'Ann Admin'],
    ]);
    const sarah = rows[1].level === 'supervisor' ? rows[1].children[0] : null;
    expect(sarah && sarah.level === 'clin' && sarah.people).toBe(1);               // Jane — not Old Gone (inactive), not Sam (supervisor)
  });

  it('uncovered: a CLIN with an active employee row and no ACTIVE supervisor row (an inactive supervisor doesn\'t cover it)', () => {
    expect(uncoveredClins(USERS as never, SCOPE as never, ACTIVE_CLINS).map((c) => c.clinId)).toEqual(['clin-d2']);
  });

  it('renders the notice, "{n} CLINs · approver: …", Since as a workspace date, and the uncovered line', async () => {
    await render({ initialTab: 'approval-scope' });
    await click([...document.body.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Approval scope'));
    const panel = document.getElementById([...document.body.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Approval scope')!.getAttribute('aria-controls')!)!;
    expect(panel.textContent).toContain('Admins can approve anyone. A supervisor approves employees assigned to the CLINs below');
    const summaries = [...panel.querySelectorAll('[data-testid="scope-summary"]')].map((s) => s.textContent);
    expect(summaries).toEqual(['0 CLINs · approver: admins', '1 CLIN · approver: Ann Admin']);
    expect(panel.textContent).toContain('Dec 1, 2025');
    expect(panel.querySelector('[data-testid="uncovered-clins"]')!.textContent).toBe('Not covered by a supervisor: DISA CLIN 0002 — admins approve these.');
  });
});
