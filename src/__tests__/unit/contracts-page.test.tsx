// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import userEvent from '@testing-library/user-event';

/**
 * feature-plan-ux-kit-contracts.md §4.1 / C-2, C-3, C-4: the Contracts page. The strip (active contracts) and the
 * unpriced notice (only when > 0); expand and search (K-5 on the real page); no footer; one-line rows; Unpriced links
 * scoped with `?`. Editing a CLIN's funding with MoneyInput (an inline server error; success updates funded and
 * remaining). Close: the copy, Cancel, Confirm → status 'closed', the badge, and the menu.
 */

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  updateContract: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  createContract: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  updateClin: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  createClin: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  updateSlin: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  createSlin: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));
vi.mock('@/server/actions/contracts', () => ({ updateContract: h.updateContract, createContract: h.createContract }));
vi.mock('@/server/actions/clins', () => ({ updateClin: h.updateClin, createClin: h.createClin }));
vi.mock('@/server/actions/slins', () => ({ updateSlin: h.updateSlin, createSlin: h.createSlin }));

import { ContractsClient } from '@/app/(app)/admin/contracts/ContractsClient';
import type { ContractsOverview, ContractNode } from '@/server/internal/contracts-overview';
import { click, dialogTitled, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => { for (const f of Object.values(h)) f.mockReset(); });
afterEach(() => { unmount(m); m = undefined; });

const line = (id: string, n: string, description: string, funded: string | null, pricedCost: number, unpricedHours = 0, status: 'active' | 'inactive' = 'active') =>
  ({ id, description, funded, hours: 0, pricedCost, unpricedHours, status });
const contract = (o: Partial<ContractNode> & Pick<ContractNode, 'id' | 'name'>): ContractNode => ({
  contractNumber: `N-${o.id}`, description: null, contractType: 'prime', status: 'active', startDate: null, endDate: null, ceiling: null,
  funded: null, hours: 0, pricedCost: 0, unpricedHours: 0, clins: [], ...o,
});
const ARMY = contract({
  id: 'army', name: 'Army IT Support', contractNumber: 'W911QX-23-D-0042', contractType: 'sub', endDate: '2026-09-30' as never,
  funded: '750000.00', pricedCost: 173238, unpricedHours: 744.5,
  clins: [
    { ...line('a1', '0001', 'Help desk', '300000.00', 92410, 310), clinNumber: '0001', slins: [] },
    { ...line('a2', '0002', 'Network operations', '350000.00', 80828, 434.5), clinNumber: '0002', slins: [] },
  ],
});
const DISA = contract({
  id: 'disa', name: 'DISA Cyber Operations', contractNumber: 'HC1028-22-C-0015', funded: '1800000.00', pricedCost: 218575,
  clins: [
    { ...line('d1', '0001', 'Cyber operations', '1200000.00', 171300), clinNumber: '0001', slins: [] },
    { ...line('d2', '0002', 'Cloud infrastructure', '600000.00', 47275), clinNumber: '0002', slins: [
      { ...line('s1', '0002AA', 'Migration support', '150000.00', 47275, 0, 'inactive'), slinNumber: '0002AA' },
      { ...line('s2', '0002AB', 'Backup', null, 0), slinNumber: '0002AB' },
    ] },
  ],
});
const OLD = contract({ id: 'old', name: 'Old Closed', status: 'closed', funded: '100000.00', pricedCost: 5000, unpricedHours: 10 });
const overview = (contracts: ContractNode[]): ContractsOverview => ({ contracts, totals: { activeContracts: 0, funded: 0, pricedCost: 0, unpricedHoursAll: 0 } });

const rowTexts = () => [...m!.container.querySelectorAll('tbody tr')].map((r) => r.textContent ?? '');
const row = (text: string) => [...m!.container.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes(text)) as HTMLElement;
const has = (text: string) => rowTexts().some((t) => t.includes(text));
const button = (label: string) => m!.container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
const typeSearch = async (q: string) => {
  const input = m!.container.querySelector('input[aria-label="Search this table"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, q);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(400);
};
const menu = async (rowLabel: string, item: string) => {
  const trigger = document.body.querySelector(`button[aria-label="More actions for ${rowLabel}"]`) as HTMLButtonElement;
  if (trigger.getAttribute('aria-expanded') !== 'true') await click(trigger);   // open it only if it isn't already
  return [...document.body.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent?.startsWith(item)) as HTMLElement | undefined;
};

describe('Contracts page (C-2)', () => {
  it('the strip: active contracts only — count, funded, spent with burn, remaining (whole dollars)', async () => {
    m = await mount(<ContractsClient overview={overview([ARMY, DISA, OLD])} />);
    const strip = m.container.querySelector('[data-testid="contracts-strip"]')!.textContent!;
    expect(strip).toContain('2Active contracts');
    expect(strip).toContain('$2,550,000Funded');
    expect(strip).toContain('$391,813Spent (priced hours) · 15%');
    expect(strip).toContain('$2,158,187Remaining');
    expect(m.container.querySelector('h1')!.textContent).toBe('Contracts and CLINs');
    expect(m.container.textContent).toContain('Costs use the labor-category rate in effect on each day worked.');
  });

  it('the notice counts unpriced hours on ALL contracts, links to the report, and is absent at 0', async () => {
    m = await mount(<ContractsClient overview={overview([ARMY, DISA, OLD])} />);
    const note = m.container.querySelector('[role="note"]')!;
    expect(note.textContent).toContain("754.50 hours have no labor-category rate, so their cost isn't counted above.");
    expect(note.querySelector('a')!.textContent).toBe('Fix pricing');
    unmount(m);
    m = await mount(<ContractsClient overview={overview([DISA])} />);
    expect(m.container.querySelector('[role="note"]')).toBeNull();
  });

  it('contracts start collapsed (more than one); expand shows the CLINs; rows are one line; no footer', async () => {
    m = await mount(<ContractsClient overview={overview([ARMY, DISA])} />);
    expect(has('Help desk')).toBe(false);
    expect(row('Army IT Support').textContent).toContain('Sub');
    expect(row('Army IT Support').textContent).toContain('W911QX-23-D-0042');
    expect(row('Army IT Support').textContent).toContain('ends Sep 30, 2026');
    await click(button('Show CLINs for Army IT Support'));
    expect(has('CLIN 0001 · Help desk')).toBe(true);
    expect(row('Help desk').textContent).toContain('$300,000');
    expect(row('Help desk').textContent).toContain('$207,590');               // remaining
    expect(m.container.querySelector('tfoot td')).toBeNull();
    for (const cell of m.container.querySelectorAll('tbody tr td:first-child > span, tbody tr td:first-child div')) {
      expect(cell.closest('[class*="oneLine"], [class*="treeCell"]')).not.toBeNull();
    }
  });

  it('a single contract starts expanded', async () => {
    m = await mount(<ContractsClient overview={overview([ARMY])} />);
    expect(has('Help desk')).toBe(true);
  });

  it('search: a contract name shows all its CLINs; a SLIN number shows it under its parents, not its sibling', async () => {
    m = await mount(<ContractsClient overview={overview([ARMY, DISA])} />);
    await typeSearch('army');
    expect(has('Help desk')).toBe(true);
    expect(has('Network operations')).toBe(true);
    expect(has('DISA')).toBe(false);
    await typeSearch('0002AA');
    expect(has('SLIN 0002AA · Migration support')).toBe(true);
    expect(has('CLIN 0002 · Cloud infrastructure')).toBe(true);
    expect(has('DISA Cyber Operations')).toBe(true);
    expect(has('Backup')).toBe(false);
    expect(has('Army')).toBe(false);
  });

  it('UX-4B1-AUDIT L4: a CLIN toggle names its contract (CLIN numbers repeat across contracts)', async () => {
    m = await mount(<ContractsClient overview={overview([ARMY, DISA])} />);
    await click(button('Show CLINs for DISA Cyber Operations'));
    expect(button('Show SLINs for CLIN 0002 on DISA Cyber Operations')).not.toBeNull();
    expect(m.container.querySelector('button[aria-label="Show SLINs for CLIN 0002"]')).toBeNull();
  });

  it('UX-4B1-AUDIT L6: "CLIN 0002" / "SLIN 0002AB" (the prefix the cell shows) are searchable', async () => {
    m = await mount(<ContractsClient overview={overview([ARMY, DISA])} />);
    await typeSearch('SLIN 0002AB');
    expect(has('SLIN 0002AB · Backup')).toBe(true);
    expect(has('Migration support')).toBe(false);
    await typeSearch('CLIN 0002');
    expect(has('CLIN 0002 · Network operations')).toBe(true);
    expect(has('CLIN 0002 · Cloud infrastructure')).toBe(true);
    expect(has('Help desk')).toBe(false);
  });

  it('the Unpriced cell links to the report scoped to its row, built with "?"; 0 shows "0.00"', async () => {
    m = await mount(<ContractsClient overview={overview([ARMY, DISA])} />);
    const armyLink = row('Army IT Support').querySelector('a[data-testid="unpriced-link"]') as HTMLAnchorElement;
    expect(armyLink.textContent).toBe('744.50');
    const href = armyLink.getAttribute('href')!;
    expect(href.split('?')).toHaveLength(2);
    expect(new URLSearchParams(href.split('?')[1]).get('contractId')).toBe('army');
    await click(button('Show CLINs for Army IT Support'));
    const clinHref = row('Help desk').querySelector('a[data-testid="unpriced-link"]')!.getAttribute('href')!;
    expect(Object.fromEntries(new URLSearchParams(clinHref.split('?')[1]))).toMatchObject({ contractId: 'army', clinId: 'a1' });
    expect(row('DISA Cyber Operations').querySelector('a[data-testid="unpriced-link"]')).toBeNull();
    expect(row('DISA Cyber Operations').textContent).toContain('0.00');
  });
});

describe('editing CLIN funding (C-3)', () => {
  async function openClinEdit() {
    m = await mount(<ContractsClient overview={overview([ARMY, DISA])} />);
    await click(button('Show CLINs for Army IT Support'));
    await click([...row('Help desk').querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Edit'));
    return dialogTitled('Edit CLIN 0001')!;
  }
  const funded = (d: HTMLElement) => [...d.querySelectorAll('label')].find((l) => l.textContent?.trim() === 'Funded')!;

  it('a server error shows inline in the dialog; nothing changes', async () => {
    h.updateClin.mockResolvedValueOnce({ ok: false, code: 'validation', error: 'Funded amount must be a valid number.' });
    const d = await openClinEdit();
    expect(d.querySelector('[data-testid="line-parent"]')!.getAttribute('readonly')).not.toBeNull();
    await click([...d.querySelectorAll('button')].find((b) => b.textContent === 'Save changes'));
    await wait();
    expect(dialogTitled('Edit CLIN 0001')!.querySelector('[role="alert"]')!.textContent).toBe('Funded amount must be a valid number.');
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('typing "400,000" saves "400000"; success merges the returned row: funded and remaining update', async () => {
    h.updateClin.mockResolvedValueOnce({ ok: true, data: { id: 'a1', clinNumber: '0001', description: 'Help desk', fundedAmount: '400000.00', status: 'active' } });
    const d = await openClinEdit();
    const input = document.getElementById(funded(d).htmlFor) as HTMLInputElement;
    const user = userEvent.setup();
    await act(() => user.clear(input));
    await act(() => user.type(input, '400,000'));
    await click([...d.querySelectorAll('button')].find((b) => b.textContent === 'Save changes'));
    await wait(300);
    expect(h.updateClin).toHaveBeenCalledWith('a1', { clinNumber: '0001', description: 'Help desk', fundedAmount: '400000' });
    expect(dialogTitled('Edit CLIN 0001')).toBeUndefined();
    expect(row('Help desk').textContent).toContain('$400,000');
    expect(row('Help desk').textContent).toContain('$307,590');
    expect(h.refresh).toHaveBeenCalled();
  });

  it('UX-4B1-AUDIT L3: the UI shows what the server RETURNED, not what was typed', async () => {
    h.updateClin.mockResolvedValueOnce({ ok: true, data: { id: 'a1', clinNumber: '0001', description: 'Help desk (renamed)', fundedAmount: '350000.00', status: 'active' } });
    const d = await openClinEdit();
    const input = document.getElementById(funded(d).htmlFor) as HTMLInputElement;
    const user = userEvent.setup();
    await act(() => user.clear(input));
    await act(() => user.type(input, '400,000'));
    await click([...d.querySelectorAll('button')].find((b) => b.textContent === 'Save changes'));
    await wait(300);
    expect(row('Help desk').textContent).toContain('Help desk (renamed)');
    expect(row('Help desk').textContent).toContain('$350,000');
    expect(row('Help desk').textContent).toContain('$257,590');
    expect(row('Help desk').textContent).not.toContain('$400,000');
  });
});

describe('closing a contract (C-4)', () => {
  it('the copy; Cancel → no call; Confirm → status closed, the badge, Reopen in the menu and no Add CLIN', async () => {
    h.updateContract.mockResolvedValueOnce({ ok: true, data: { ...ARMY, fundedValue: ARMY.funded, ceilingValue: null, status: 'closed' } });
    m = await mount(<ContractsClient overview={overview([ARMY, DISA])} />);
    expect((await menu('Army IT Support', 'Add CLIN'))).toBeDefined();
    await click(await menu('Army IT Support', 'Close contract'));
    const confirm = dialogTitled('Close Army IT Support?')!;
    expect(confirm.textContent).toContain("Its charge codes will no longer appear on anyone's timesheet, and no one can add new hours to it. Recorded hours stay, and you can reopen it later.");
    await click([...confirm.querySelectorAll('button')].find((b) => b.textContent === 'Cancel'));
    expect(h.updateContract).not.toHaveBeenCalled();
    await click(await menu('Army IT Support', 'Close contract'));
    await click([...dialogTitled('Close Army IT Support?')!.querySelectorAll('button')].find((b) => b.textContent === 'Close contract'));
    await wait(300);
    expect(h.updateContract).toHaveBeenCalledWith('army', { status: 'closed' });
    expect(row('Army IT Support').querySelector('[data-tone]')!.textContent).toBe('Closed');
    expect(await menu('Army IT Support', 'Reopen contract')).toBeDefined();
    expect(await menu('Army IT Support', 'Add CLIN')).toBeUndefined();
    expect(h.refresh).toHaveBeenCalled();
  });

  it('Reopen: the neutral confirm and copy', async () => {
    m = await mount(<ContractsClient overview={overview([OLD, DISA])} />);
    await click(await menu('Old Closed', 'Reopen contract'));
    const confirm = dialogTitled('Reopen Old Closed?')!;
    expect(confirm.textContent).toContain('Its active charge codes will appear on timesheets again for employees assigned to them.');
    expect([...confirm.querySelectorAll('button')].find((b) => b.textContent === 'Reopen contract')!.getAttribute('style') ?? '').not.toContain('--mantine-color-red');
  });
});
