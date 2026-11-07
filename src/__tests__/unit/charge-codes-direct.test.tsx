// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

/**
 * feature-plan-ux-people-codes.md §3 / CC-2, CC-3, CC-5, CC-8 (and the Create-from-CLINs modal):
 * CC-2 — `tab=indirect` renders the Indirect panel; an invalid tab → Direct; switching uses history.replaceState
 *        (Next keeps useSearchParams in sync — mocked the same way) and changes the panel; `code` stays on Direct only.
 * CC-3 — the Labor category column shows the category in effect on the workspace's today (a future change is ignored).
 * CC-5 — an empty-CLIN line for an active CLIN with no code, none for a CLIN whose only code is inactive; a manual
 *        create clears it without a reload (the refetch into state).
 * CC-8 — editing a code on an inactive SLIN shows "(inactive)", and saving another field doesn't send slinId.
 */

const nav = vi.hoisted(() => ({ listeners: new Set<() => void>() }));
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (cb: () => void) => { nav.listeners.add(cb); return () => { nav.listeners.delete(cb); }; };
  return { useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search)) };
});
const actions = vi.hoisted(() => ({
  listChargeCodes: vi.fn(async () => [] as unknown[]),
  createChargeCode: vi.fn<(d: unknown) => Promise<unknown>>(async () => ({ ok: true, data: {} })),
  updateChargeCode: vi.fn<(id: string, d: unknown) => Promise<unknown>>(async () => ({ ok: true, data: {} })),
  preview: vi.fn(async () => [] as unknown[]),
  autobridge: vi.fn<(ids?: string[]) => Promise<unknown>>(async () => ({ ok: true, data: { created: 1, skipped: 0 } })),
  notify: vi.fn(),
}));
vi.mock('@/server/actions/charge-codes', () => ({
  createChargeCode: actions.createChargeCode, updateChargeCode: actions.updateChargeCode, listChargeCodes: actions.listChargeCodes,
  deactivateChargeCode: vi.fn(), reactivateChargeCode: vi.fn(), getChargeCodeReactivationInfo: vi.fn(), createCostClass: vi.fn(),
  previewAutobridgeChargeCodes: actions.preview, autobridgeChargeCodesFromClins: actions.autobridge,
}));
vi.mock('@/server/actions/charge-code-categories', () => ({
  previewChargeCodeCategoryImpact: vi.fn(), addChargeCodeCategoryChange: vi.fn(), correctChargeCodeCategory: vi.fn(), removeChargeCodeCategoryChange: vi.fn(),
}));
vi.mock('@/server/actions/indirect-codes', () => ({ updateIndirectCode: vi.fn(), getIndirectChargeCodes: vi.fn(async () => []), createIndirectCode: vi.fn(), seedIndirectCodes: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: actions.notify } }));

import { ChargeCodesClient } from '@/app/(app)/admin/charge-codes/ChargeCodesClient';
import { parseCodesTab } from '@/lib/charge-codes-tab';
import { buttonByText, click, dialogTitled, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';
import type { CalendarDate } from '@/lib/calendar-date';

const realReplace = window.history.replaceState.bind(window.history);
let replaceSpy: ReturnType<typeof vi.fn>;
beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  replaceSpy = vi.fn((...args: Parameters<History['replaceState']>) => { realReplace(...args); for (const l of nav.listeners) l(); });
  window.history.replaceState = replaceSpy as never;
});
afterEach(() => { unmount(m); m = undefined; window.history.replaceState = realReplace; realReplace(null, '', '/'); });

const TODAY = '2026-11-06' as CalendarDate;
const code = (id: string, c: string, o: Record<string, unknown> = {}) => ({
  id, code: c, name: `${c} name`, description: null, clinId: 'clin-1', clinNumber: '0001', clinDescription: 'Base', slinId: null, slinNumber: null,
  chargeable: true, peopleCount: 2, contractId: 'k1', contractName: 'NAVAIR', contractNumber: 'N-1', laborCategoryId: null, classId: null,
  className: null, workLocation: 'onsite', billable: true, isActive: true, createdAt: new Date(), categoryChanges: [], hasHours: false, ...o,
});
const CONTRACTS = [
  { id: 'k1', name: 'NAVAIR', contractNumber: 'N-1', clins: [
    { id: 'clin-1', clinNumber: '0001', description: 'Base' },
    { id: 'clin-2', clinNumber: '0002', description: 'Option' },   // only an INACTIVE code → no line
    { id: 'clin-3', clinNumber: '0003', description: 'ODC — Travel' }, // no code at all → a line
  ] },
  { id: 'k2', name: 'Army', contractNumber: 'A-2', clins: [{ id: 'clin-9', clinNumber: '0009', description: null }] }, // a parent with only a line
];
const CATS = [{ id: 'lc-a', lcatCode: 'SE-I', title: 'Eng I', clinId: 'clin-1', slinId: null, status: 'active' }, { id: 'lc-b', lcatCode: 'SE-II', title: 'Eng II', clinId: 'clin-1', slinId: null, status: 'active' }];
const INDIRECT = [{ id: 'ic1', code: 'OH-01', name: 'Overhead', category: 'overhead' as const, description: null, isActive: true, availableToAll: true, leavePayType: null, createdAt: new Date(), updatedAt: new Date() }];

const render = async (codes: unknown[], o: Record<string, unknown> = {}) => {
  m = await mount(<ChargeCodesClient initialCodes={codes as never} costClasses={[]} contracts={CONTRACTS} laborCategories={CATS} indirectCodes={INDIRECT} workspaceToday={TODAY} {...o} />);
  await wait(10);
};
const visiblePanel = () => [...document.body.querySelectorAll('[role="tabpanel"]')].find((p) => (p as HTMLElement).style.display !== 'none') as HTMLElement;
const rowOf = (text: string) => [...document.body.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes(text)) as HTMLElement | undefined;
const setValue = (input: HTMLInputElement | HTMLTextAreaElement, v: string) => {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, v);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const field = (dialog: HTMLElement, label: string) => {
  const l = [...dialog.querySelectorAll('label')].find((x) => x.textContent?.replace(/\s*\*\s*$/, '').trim() === label);
  return l ? document.getElementById(l.htmlFor) as HTMLInputElement : null;
};
const choose = async (input: HTMLInputElement | null, option: string) => {
  await click(input);
  await click([...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent?.startsWith(option)));
};

describe('tabs (CC-2)', () => {
  it('tab=indirect renders the Indirect panel; an invalid tab → Direct', async () => {
    realReplace(null, '', '/admin/charge-codes?tab=indirect');
    await render([code('cc1', 'NAV-01')]);
    expect(visiblePanel().getAttribute('data-testid')).toBe('indirect-panel');
    expect(visiblePanel().textContent).toContain('OH-01');
    expect(buttonByText('Add indirect code')).toBeDefined();
    unmount(m);
    realReplace(null, '', '/admin/charge-codes?tab=bogus');
    await render([code('cc1', 'NAV-01')]);
    expect(visiblePanel().getAttribute('data-testid')).toBe('direct-panel');
    expect(parseCodesTab('bogus')).toBe('direct');
    expect(parseCodesTab(undefined)).toBe('direct');
  });

  it('switching tabs replaces the URL (no navigation) and changes the panel; `code` is dropped off Direct', async () => {
    realReplace(null, '', '/admin/charge-codes?code=abc');
    await render([code('cc1', 'NAV-01')]);
    expect(visiblePanel().getAttribute('data-testid')).toBe('direct-panel');
    await click([...document.body.querySelectorAll('[role="tab"]')].find((t) => t.textContent?.startsWith('Indirect')));
    expect(replaceSpy).toHaveBeenCalledWith(null, '', '?tab=indirect');
    expect(visiblePanel().getAttribute('data-testid')).toBe('indirect-panel');
    await click([...document.body.querySelectorAll('[role="tab"]')].find((t) => t.textContent?.startsWith('Direct')));
    expect(replaceSpy).toHaveBeenLastCalledWith(null, '', '?tab=direct');
    expect(visiblePanel().getAttribute('data-testid')).toBe('direct-panel');
    expect(buttonByText('Add charge code')).toBeDefined();
  });
});

describe('the Direct table', () => {
  it('CC-3: the category in effect on the workspace today ("since" its change); a future-dated change is ignored; none → "None"', async () => {
    await render([
      code('cc1', 'NAV-01', { laborCategoryId: 'lc-a', categoryChanges: [{ id: 'ch1', effectiveDate: '2026-12-01', laborCategoryId: 'lc-b' }] }),
      code('cc2', 'NAV-02', { laborCategoryId: 'lc-a', categoryChanges: [{ id: 'ch2', effectiveDate: '2026-10-16', laborCategoryId: 'lc-b' }] }),
      code('cc3', 'NAV-03'),
    ]);
    expect(rowOf('NAV-01')!.querySelector('[data-testid="code-category"]')!.textContent).toBe('SE-I');
    expect(rowOf('NAV-02')!.querySelector('[data-testid="code-category"]')!.textContent).toBe('SE-II since Oct 16, 2026');
    expect(rowOf('NAV-03')!.textContent).toContain('None');
  });

  it('rows: contract parents; code (mono) with "CLIN n · SLIN n"; Location, Billable, People (0 in warn), Status', async () => {
    await render([code('cc1', 'NAV-01', { slinId: 's1', slinNumber: '0001AA', peopleCount: 0, billable: false, workLocation: null })]);
    const r = rowOf('NAV-01')!;
    expect(r.textContent).toContain('CLIN 0001 · SLIN 0001AA');
    expect(r.textContent).toContain('—');
    expect(r.textContent).toContain('No');
    expect(r.querySelector('[class*="warn"]')!.textContent).toBe('0');
    expect(rowOf('NAVAIR')!.textContent).toContain('N-1');
  });

  it('CC-5: an empty-CLIN line for a CLIN with no code (not one with an inactive code); a manual create clears it without a reload', async () => {
    const codes = [code('cc1', 'NAV-01'), code('cc2', 'NAV-02', { clinId: 'clin-2', clinNumber: '0002', isActive: false })];
    await render(codes);
    const lines = () => [...document.body.querySelectorAll('[data-testid="empty-clin-line"]')].map((l) => l.textContent);
    expect(lines()).toEqual(['CLIN 0009 has no charge codes.', 'CLIN 0003 ODC — Travel has no charge codes.']);
    // Manual create on CLIN 0003 → the refetch returns it → its line goes.
    actions.listChargeCodes.mockResolvedValueOnce([...codes, code('cc3', 'NAV-03', { clinId: 'clin-3', clinNumber: '0003' })]);
    await click(buttonByText('Add charge code'));
    const dialog = dialogTitled('Add charge code')!;
    await act(async () => { setValue(field(dialog, 'Code')!, 'NAV-03'); setValue(field(dialog, 'Name')!, 'Travel'); });
    await choose(field(dialog, 'Contract'), 'N-1 — NAVAIR');
    await choose(field(dialog, 'CLIN'), '0003');
    await click(buttonByText('Save'));
    await wait(20);
    expect(actions.createChargeCode).toHaveBeenCalledWith(expect.objectContaining({ code: 'NAV-03', clinId: 'clin-3' }));
    expect(lines()).toEqual(['CLIN 0009 has no charge codes.']);
  });

  it('the empty lines show only with Status = Active; no codes at all → the empty state with "Create codes from CLINs…"', async () => {
    await render([code('cc1', 'NAV-01'), code('cc2', 'NAV-02', { isActive: false })]);
    const label = [...document.body.querySelectorAll<HTMLLabelElement>('[data-testid="direct-panel"] label')].find((l) => l.textContent?.trim() === 'Status')!;
    await choose(document.getElementById(label.htmlFor) as HTMLInputElement, 'Inactive');
    expect(document.body.querySelectorAll('[data-testid="empty-clin-line"]')).toHaveLength(0);
    expect(rowOf('NAV-02')).toBeDefined();
    expect(rowOf('NAV-01')).toBeUndefined();
    unmount(m);
    await render([]);
    const empty = document.body.querySelector('[data-testid="codes-empty"]')!;
    expect(empty.textContent).toContain('No charge codes yet.');
    expect(empty.textContent).toContain('Create one per CLIN, or add one yourself.');
    expect(document.body.querySelector('[data-testid="direct-panel"] table')).toBeNull();
  });
});

describe('the code form', () => {
  it('validation on click: inline "Enter a code." / "Enter a name." / "Choose a CLIN."; a server error is one Alert, no toast', async () => {
    await render([code('cc1', 'NAV-01')]);
    await click(buttonByText('Add charge code'));
    const dialog = dialogTitled('Add charge code')!;
    await click(buttonByText('Save'));
    for (const msg of ['Enter a code.', 'Enter a name.', 'Choose a CLIN.']) expect(dialog.textContent).toContain(msg);
    expect(actions.createChargeCode).not.toHaveBeenCalled();
    actions.createChargeCode.mockResolvedValueOnce({ ok: false, code: 'validation', error: "That SLIN isn't on the chosen CLIN." });
    await act(async () => { setValue(field(dialog, 'Code')!, 'X'); setValue(field(dialog, 'Name')!, 'Y'); });
    await choose(field(dialog, 'Contract'), 'N-1 — NAVAIR');
    await choose(field(dialog, 'CLIN'), '0001');
    await click(buttonByText('Save'));
    await wait(10);
    expect(dialog.querySelector('[role="alert"]')!.textContent).toBe("That SLIN isn't on the chosen CLIN.");
    expect(actions.notify).not.toHaveBeenCalled();
  });

  it('CC-8: a code on an inactive SLIN shows "(inactive)"; saving another field sends no slinId', async () => {
    await render([code('cc1', 'NAV-01', { slinId: 's-old', slinNumber: '0001ZZ' })], { slins: [{ id: 's-new', clinId: 'clin-1', slinNumber: '0001AA', description: null }] });
    await click([...rowOf('NAV-01')!.querySelectorAll('button')].find((b) => b.textContent === 'Edit'));
    const dialog = dialogTitled('Edit charge code')!;
    expect(field(dialog, 'SLIN')!.value).toBe('0001ZZ (inactive)');
    await act(async () => { setValue(field(dialog, 'Name')!, 'Renamed'); });
    await click(buttonByText('Save'));
    expect(actions.updateChargeCode).toHaveBeenCalledTimes(1);
    const sent = actions.updateChargeCode.mock.calls[0][1] as object;
    expect(sent).toMatchObject({ name: 'Renamed' });
    expect('slinId' in sent).toBe(false);
    expect('clinId' in sent).toBe(false);
  });
});

describe('Create codes from CLINs (§3.3)', () => {
  const C = (clinId: string, codeText: string, available = true, reason?: string) => ({ clinId, code: codeText, name: `${codeText} name`, contractName: 'NAVAIR', clinNumber: clinId.slice(-1), available, reason });

  it('available rows ticked; an unavailable one shows its reason, unticked and aria-disabled; creates only the ticked ones; the toast counts', async () => {
    actions.preview.mockResolvedValueOnce([C('clin-3', 'N-1-0003'), C('clin-4', 'N-1-0004'), C('clin-5', 'N-1-0005', false, 'Code N-1-0005 is already used — add one yourself.')]);
    actions.autobridge.mockResolvedValueOnce({ ok: true, data: { created: 1, skipped: 0 } });
    await render([code('cc1', 'NAV-01')]);
    await click(buttonByText('Create codes from CLINs…'));
    await wait(10);
    const dialog = dialogTitled('Create codes from CLINs')!;
    const box = (c: string) => dialog.querySelector(`input[aria-label="Create ${c}"]`) as HTMLInputElement;
    expect([box('N-1-0003').checked, box('N-1-0004').checked, box('N-1-0005').checked]).toEqual([true, true, false]);
    expect(box('N-1-0005').getAttribute('aria-disabled')).toBe('true');
    expect(box('N-1-0005').hasAttribute('disabled')).toBe(false);
    expect(dialog.textContent).toContain('Code N-1-0005 is already used — add one yourself.');
    await click(box('N-1-0005'));
    expect(box('N-1-0005').checked).toBe(false);
    await click(box('N-1-0004'));
    await click(buttonByText('Create 1 code'));
    await wait(10);
    expect(actions.autobridge).toHaveBeenCalledWith(['clin-3']);
    expect(actions.notify.mock.calls.map((c) => (c[0] as { message: string }).message)).toContain('Created 1 charge code');
    expect(actions.listChargeCodes).toHaveBeenCalled();
  });

  it('nothing ticked → "Tick at least one CLIN." and no call; every CLIN coded → the empty message', async () => {
    actions.preview.mockResolvedValueOnce([C('clin-3', 'N-1-0003')]);
    await render([code('cc1', 'NAV-01')]);
    await click(buttonByText('Create codes from CLINs…'));
    await wait(10);
    await click(dialogTitled('Create codes from CLINs')!.querySelector('input[aria-label="Create N-1-0003"]'));
    await click(buttonByText('Create 0 codes'));
    expect(dialogTitled('Create codes from CLINs')!.querySelector('[role="alert"]')!.textContent).toBe('Tick at least one CLIN.');
    expect(actions.autobridge).not.toHaveBeenCalled();
    unmount(m);
    actions.preview.mockResolvedValueOnce([]);
    await render([code('cc1', 'NAV-01')]);
    await click(buttonByText('Create codes from CLINs…'));
    await wait(10);
    expect(dialogTitled('Create codes from CLINs')!.textContent).toContain('Every active CLIN already has a charge code.');
  });
});
