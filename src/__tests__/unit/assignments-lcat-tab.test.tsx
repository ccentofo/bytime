// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

/**
 * feature-plan-ux-kit-contracts.md §4.3 / L-2: People → Assignments → "Labor categories". `?tab=` is allowlisted (first
 * of arrays; invalid → charge-codes); a tab switch REPLACES the URL with history.replaceState (no router call) and drops
 * the filters; `laborCategoryId` filters exactly (that category's assignments active today) with a chip; `userId`
 * filters and pre-selects; `assignments` highlights; switching tabs and back clears the filter and chip; removing a chip
 * clears its param; the Rate shows for an assignment to a DEACTIVATED category (rates for every category, from the page).
 *
 * next/navigation is mocked the way Next behaves: useSearchParams follows window.location, and replaceState notifies it.
 */

const nav = vi.hoisted(() => ({ listeners: new Set<() => void>(), router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() } }));
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (cb: () => void) => { nav.listeners.add(cb); return () => { nav.listeners.delete(cb); }; };
  return {
    useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search)),
    useRouter: () => nav.router,
  };
});
const h = vi.hoisted(() => ({
  getAssignments: vi.fn(), getUsers: vi.fn(), getContracts: vi.fn(), listChargeCodes: vi.fn(), getChargeCodeAssignments: vi.fn(),
  getWorkspaceTimezone: vi.fn(), getWorkspaceToday: vi.fn(), getAllLaborCategories: vi.fn(), getUserLaborCategoryAssignments: vi.fn(),
  getAssignableLaborCategories: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/session', () => ({ requirePageRole: vi.fn(async () => ({ id: 'a', role: 'admin' })) }));
vi.mock('@/server/actions/assignments', () => ({ assignUserToClin: vi.fn(), unassignUserFromClin: vi.fn(), getAssignments: h.getAssignments }));
vi.mock('@/server/actions/users', () => ({ getUsers: h.getUsers }));
vi.mock('@/server/actions/contracts', () => ({ getContracts: h.getContracts }));
vi.mock('@/server/actions/charge-codes', () => ({
  assignChargeCodeToUser: vi.fn(), unassignChargeCodeFromUser: vi.fn(), assignAllUnderClin: vi.fn(),
  getChargeCodeAssignments: h.getChargeCodeAssignments, listChargeCodes: h.listChargeCodes,
}));
vi.mock('@/server/actions/clins', () => ({ getClinsByContract: vi.fn(async () => []) }));
vi.mock('@/server/actions/labor-categories', () => ({
  assignUserToLaborCategory: vi.fn(), endUserLaborCategoryAssignment: vi.fn(), getUserLaborCategoryAssignments: h.getUserLaborCategoryAssignments,
  getAllLaborCategories: h.getAllLaborCategories, getAssignableLaborCategories: h.getAssignableLaborCategories,
}));
vi.mock('@/server/internal/workspace-settings', () => ({ getWorkspaceTimezone: h.getWorkspaceTimezone, getWorkspaceToday: h.getWorkspaceToday }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import AssignmentsPage from '@/app/(app)/admin/assignments/page';
import { AssignmentsClient } from '@/app/(app)/admin/assignments/AssignmentsClient';
import { parseAssignmentsParams } from '@/lib/assignments-params';
import { click, installDomStubs, mount, unmount, type Mounted } from '../helpers/dom';
import type { CalendarDate } from '@/lib/calendar-date';

const realReplace = window.history.replaceState.bind(window.history);
let replaceSpy: ReturnType<typeof vi.fn>;
beforeAll(installDomStubs);
beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  for (const f of Object.values(nav.router)) f.mockReset();
  replaceSpy = vi.fn((...args: Parameters<History['replaceState']>) => { realReplace(...args); for (const l of nav.listeners) l(); });
  window.history.replaceState = replaceSpy as never;
});
let m: Mounted | undefined;
afterEach(() => { unmount(m); m = undefined; window.history.replaceState = realReplace; realReplace(null, '', '/'); });

const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const U2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const L1 = '11111111-1111-4111-8111-111111111111';
const L2 = '22222222-2222-4222-8222-222222222222'; // deactivated
const X1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const X2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const X3 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const X4 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const asg = (id: string, userId: string, userName: string, laborCategoryId: string, lcatCode: string, effectiveDate: string, endDate: string | null = null) => ({
  id, userId, userName, laborCategoryId, lcatCode, lcatTitle: `${lcatCode} title`, effectiveDate, endDate, clinNumber: '0001',
  contractName: 'NAVAIR', contractNumber: 'N1',
});
const ASSIGNMENTS = [
  asg(X1, U1, 'Pat Doe', L1, 'SE-I', '2026-01-01'),                 // active today on L1
  asg(X2, U2, 'Lee Roe', L1, 'SE-I', '2025-01-01', '2026-06-30'),   // ended on L1
  asg(X3, U2, 'Lee Roe', L2, 'SE-II', '2026-01-01'),                // on the deactivated L2
  asg(X4, U1, 'Pat Doe', L1, 'SE-I', '2026-12-01'),                 // future on L1
];
const USERS = [{ id: U1, fullName: 'Pat Doe' }, { id: U2, fullName: 'Lee Roe' }];
const LCAT_PROPS = {
  initialAssignments: ASSIGNMENTS as never,
  assignableLcats: [{ id: L1, lcatCode: 'SE-I', title: 'SE-I title', clinNumber: '0001', contractName: 'NAVAIR' }] as never,
  rateByCategory: { [L1]: '100.00', [L2]: '120.00' },
  categoryNames: { [L1]: { lcatCode: 'SE-I', clinNumber: '0001' }, [L2]: { lcatCode: 'SE-II', clinNumber: '0002' } },
  today: '2026-11-03' as CalendarDate,
};

async function render(search: string) {
  realReplace(null, '', `/admin/assignments${search}`);
  m = await mount(
    <AssignmentsClient initialTab="charge-codes" initialAssignments={[]} users={USERS as never} contracts={[]} chargeCodes={[]}
      initialChargeCodeAssignments={[]} workspaceTimezone="America/New_York" lcat={LCAT_PROPS} />,
  );
}
const tab = (name: string) => [...document.body.querySelectorAll('[role="tab"]')].find((t) => t.textContent === name) as HTMLElement;
const panel = () => document.getElementById(tab('Labor categories').getAttribute('aria-controls')!)!;
const rows = () => [...panel().querySelectorAll('tbody tr')] as HTMLElement[];
const rowIds = () => rows().map((r) => (r.textContent ?? '').match(/(Pat Doe|Lee Roe).*?(SE-I+)/)?.slice(1).join('/') + (r.textContent?.includes('Jan 1, 2025') ? ' ended' : r.textContent?.includes('Dec 1, 2026') ? ' future' : ''));
const chips = () => [...panel().querySelectorAll('[data-testid^="lcat-chip-"]')].map((c) => c.textContent);
const search = () => new URLSearchParams(window.location.search);

describe('URL parsing (L-2)', () => {
  it('tab allowlist and default; ids UUID-validated; assignments a comma list with invalid ids dropped', () => {
    const p = (q: string) => { const s = new URLSearchParams(q); return parseAssignmentsParams((k) => s.get(k)); };
    expect(p('tab=labor-categories').tab).toBe('labor-categories');
    expect(p('tab=approval-scope').tab).toBe('approval-scope');
    expect(p('tab=nope').tab).toBe('charge-codes');
    expect(p('').tab).toBe('charge-codes');
    expect(p(`laborCategoryId=${L1}&userId=not-a-uuid`)).toMatchObject({ laborCategoryId: L1, userId: null });
    expect(p(`assignments=${X1},bad,${X2}`).assignments).toEqual([X1, X2]);
  });

  it('the page: the first of an array; invalid → charge-codes; rates for EVERY category (current, inactive included)', async () => {
    h.getAllLaborCategories.mockResolvedValue([
      { id: L1, lcatCode: 'SE-I', clinNumber: '0001', status: 'active', hourlyRate: '100.00', ceilingRate: null, rateChanges: [] },
      { id: L2, lcatCode: 'SE-II', clinNumber: '0002', status: 'inactive', hourlyRate: '110.00', ceilingRate: null,
        rateChanges: [{ id: 'r', effectiveDate: '2026-06-01', hourlyRate: '120.00', ceilingRate: null }] },
    ]);
    for (const f of [h.getAssignments, h.getUsers, h.getContracts, h.listChargeCodes, h.getChargeCodeAssignments, h.getUserLaborCategoryAssignments, h.getAssignableLaborCategories]) f.mockResolvedValue([]);
    h.getWorkspaceTimezone.mockResolvedValue('America/New_York');
    h.getWorkspaceToday.mockResolvedValue('2026-11-03');
    const page = async (sp: Record<string, string | string[]>) => ((await AssignmentsPage({ searchParams: Promise.resolve(sp) })) as { props: Record<string, never> }).props;
    expect((await page({ tab: ['labor-categories', 'approval-scope'] })).initialTab).toBe('labor-categories');
    expect((await page({ tab: 'bogus' })).initialTab).toBe('charge-codes');
    const props = await page({});
    expect(props.initialTab).toBe('charge-codes');
    expect((props.lcat as { rateByCategory: unknown }).rateByCategory).toEqual({ [L1]: '100.00', [L2]: '120.00' });
    expect((props.lcat as { categoryNames: unknown }).categoryNames).toEqual({ [L1]: { lcatCode: 'SE-I', clinNumber: '0001' }, [L2]: { lcatCode: 'SE-II', clinNumber: '0002' } });
    expect(h.getAllLaborCategories).toHaveBeenCalledTimes(3);
  });
});

describe('the Labor categories tab (L-2)', () => {
  it('opens from ?tab=; laborCategoryId filters EXACTLY to that category\'s assignments active today, with a chip', async () => {
    await render(`?tab=labor-categories&laborCategoryId=${L1}`);
    expect(tab('Labor categories').getAttribute('aria-selected')).toBe('true');
    expect(rowIds()).toEqual(['Pat Doe/SE-I']);
    expect(chips()).toEqual(['Labor category: SE-I · CLIN 0001']);
  });

  it('a tab switch uses history.replaceState (no router call) and drops the filters; switching back shows no filter or chip', async () => {
    await render(`?tab=labor-categories&laborCategoryId=${L1}`);
    await act(async () => { tab('Charge Code Access').click(); });
    expect(replaceSpy).toHaveBeenLastCalledWith(null, '', '?tab=charge-codes');
    expect(tab('Charge Code Access').getAttribute('aria-selected')).toBe('true');
    await act(async () => { tab('Labor categories').click(); });
    expect(replaceSpy).toHaveBeenLastCalledWith(null, '', '?tab=labor-categories');
    expect(chips()).toEqual([]);
    expect(rows()).toHaveLength(4);
    for (const f of Object.values(nav.router)) expect(f).not.toHaveBeenCalled();
  });

  it('removing a chip clears its param (the tab stays) and the filter', async () => {
    await render(`?tab=labor-categories&laborCategoryId=${L1}`);
    await click(panel().querySelector('button[aria-label="Remove filter Labor category: SE-I · CLIN 0001"]'));
    expect(search().get('laborCategoryId')).toBeNull();
    expect(search().get('tab')).toBe('labor-categories');
    expect(chips()).toEqual([]);
    expect(rows()).toHaveLength(4);
  });

  it('userId filters to that employee and pre-selects them in the assign form', async () => {
    await render(`?tab=labor-categories&userId=${U2}`);
    expect(rows().every((r) => r.textContent?.includes('Lee Roe'))).toBe(true);
    expect(rows()).toHaveLength(2);
    expect(chips()).toEqual(['Employee: Lee Roe']);
    const label = [...panel().querySelectorAll('label')].find((l) => l.textContent?.startsWith('User'))!;
    expect((document.getElementById(label.htmlFor) as HTMLInputElement).value).toBe('Lee Roe');
  });

  it('assignments highlights exactly those rows, with ", overlapping" for screen readers', async () => {
    await render(`?tab=labor-categories&userId=${U2}&assignments=${X2},${X3}`);
    const marked = rows().filter((r) => r.getAttribute('data-overlap') === 'true');
    expect(marked).toHaveLength(2);
    for (const r of marked) expect(r.textContent).toContain(', overlapping');
    unmount(m);
    await render(`?tab=labor-categories&assignments=${X1}`);
    const all = rows();
    expect(all.filter((r) => r.getAttribute('data-overlap') === 'true').map((r) => r.textContent?.includes('Jan 1, 2026') && r.textContent?.includes('Pat Doe'))).toEqual([true]);
    expect(all.filter((r) => r.textContent?.includes(', overlapping'))).toHaveLength(1);
  });

  it('the Rate shows for an assignment to a deactivated category', async () => {
    await render('?tab=labor-categories');
    const onL2 = rows().find((r) => r.textContent?.includes('SE-II'))!;
    expect(onL2.textContent).toContain('$120.00/hr');
  });

  it('invalid filter values are ignored (no chip, no filter)', async () => {
    await render('?tab=labor-categories&laborCategoryId=nope&userId=123');
    expect(chips()).toEqual([]);
    expect(rows()).toHaveLength(4);
  });
});
