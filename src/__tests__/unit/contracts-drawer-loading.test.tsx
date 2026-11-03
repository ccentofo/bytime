// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

/**
 * feature-plan-ux-page-fixes.md C1 / T-C1a–f: the Contracts "Manage CLINs and SLINs" drawer. Opening a contract clears
 * the previous one's CLINs and shows a loading status; a stale response (or mutation result) for a contract that is no
 * longer open is dropped; a failed read shows an alert with Retry instead of crashing the page; a failed SLIN read isn't
 * cached; "Add" is unavailable (aria-disabled, no spinner, a click does nothing) until the CLINs have loaded.
 */

const h = vi.hoisted(() => ({ getClinsByContract: vi.fn(), createClin: vi.fn(), updateClin: vi.fn(), getSlinsByClin: vi.fn() }));
vi.mock('@/server/actions/contracts', () => ({ createContract: vi.fn(), updateContract: vi.fn() }));
vi.mock('@/server/actions/clins', () => ({ getClinsByContract: h.getClinsByContract, createClin: h.createClin, updateClin: h.updateClin }));
vi.mock('@/server/actions/slins', () => ({ getSlinsByClin: h.getSlinsByClin, createSlin: vi.fn(), updateSlin: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { ContractsClient } from '@/app/(app)/admin/contracts/ContractsClient';
import { buttonByText, chooseRowAction, click, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => { for (const f of Object.values(h)) f.mockReset(); });
afterEach(() => { unmount(m); m = undefined; });

const contract = (id: string, number: string) => ({
  id, contractNumber: number, name: `Contract ${number}`, description: null, contractType: 'prime', status: 'active' as const,
  startDate: null, endDate: null, fundedValue: null, ceilingValue: null, createdAt: new Date(), updatedAt: new Date(),
});
const clin = (id: string, contractId: string, clinNumber: string) => ({
  id, contractId, clinNumber, description: null, fundedAmount: null, status: 'active' as const, createdAt: new Date(), updatedAt: new Date(),
});
const A = contract('a', 'A-100');
const B = contract('b', 'B-200');
const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const drawer = () => [...document.body.querySelectorAll('[role="dialog"]')].find((d) => d.textContent?.includes('CLINs —')) as HTMLElement;
const open = (c: typeof A) => chooseRowAction(c.contractNumber, 'Manage CLINs and SLINs');
const typeInto = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

async function render() {
  m = await mount(<ContractsClient initialContracts={[A, B]} />);
  await wait();
}

describe('Contracts CLIN drawer (C1)', () => {
  it('T-C1a: opening B after A clears A\'s CLINs and shows a loading status while B loads', async () => {
    const b = deferred<unknown[]>();
    h.getClinsByContract.mockResolvedValueOnce([clin('a1', 'a', 'A-CLIN-1')]).mockReturnValueOnce(b.promise);
    await render();
    await open(A);
    expect(drawer().textContent).toContain('A-CLIN-1');
    await open(B);
    expect(drawer().textContent).not.toContain('A-CLIN-1');
    const status = drawer().querySelector('[role="status"]')!;
    expect(status.textContent).toContain('Loading CLINs…');
    expect(drawer().textContent).not.toContain('No CLINs yet');
    await act(async () => { b.resolve([clin('b1', 'b', 'B-CLIN-1')]); });
    expect(drawer().textContent).toContain('B-CLIN-1');
  });

  it('T-C1b: a stale A response arriving after B is ignored', async () => {
    const a = deferred<unknown[]>();
    const b = deferred<unknown[]>();
    h.getClinsByContract.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    await render();
    await open(A);
    await open(B);
    await act(async () => { b.resolve([clin('b1', 'b', 'B-CLIN-1')]); });
    await act(async () => { a.resolve([clin('a1', 'a', 'A-CLIN-1')]); });
    expect(drawer().textContent).toContain('B-CLIN-1');
    expect(drawer().textContent).not.toContain('A-CLIN-1');
  });

  it('T-C1c: a failed fetch shows role=alert (the page doesn\'t crash) and Retry loads', async () => {
    h.getClinsByContract.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce([clin('a1', 'a', 'A-CLIN-1')]);
    await render();
    await open(A);
    const alert = drawer().querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("Couldn't load this contract's CLINs");
    expect(document.body.textContent).toContain('B-200');                      // the contracts table is still there
    await click(buttonByText('Retry'));
    expect(drawer().querySelector('[role="alert"]')).toBeNull();
    expect(drawer().textContent).toContain('A-CLIN-1');
    expect(h.getClinsByContract).toHaveBeenCalledTimes(2);
  });

  it('T-C1d: a failed SLIN fetch isn\'t cached — expanding again refetches', async () => {
    h.getClinsByContract.mockResolvedValueOnce([clin('a1', 'a', 'A-CLIN-1')]);
    h.getSlinsByClin.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce([]);
    await render();
    await open(A);
    const expand = () => drawer().querySelector('button[aria-label="Expand SLINs"], button[aria-label="Collapse SLINs"]') as HTMLButtonElement;
    await click(expand());
    expect(drawer().textContent).toContain("Couldn't load SLINs.");
    await click(expand());                                                     // collapse
    await click(expand());                                                     // expand again
    expect(h.getSlinsByClin).toHaveBeenCalledTimes(2);
    expect(drawer().textContent).toContain('No SLINs yet');
  });

  it('T-C1e: "Add" is aria-disabled while loading, doesn\'t spin, and a forced click does nothing', async () => {
    const a = deferred<unknown[]>();
    h.getClinsByContract.mockReturnValueOnce(a.promise);
    await render();
    await open(A);
    const add = [...drawer().querySelectorAll('button')].find((x) => x.textContent?.trim() === 'Add') as HTMLButtonElement;
    expect(add.getAttribute('aria-disabled')).toBe('true');
    expect(add.hasAttribute('disabled')).toBe(false);
    expect(add.getAttribute('data-loading')).toBeNull();
    expect(document.getElementById(add.getAttribute('aria-describedby')!)!.textContent).toBe('Loading CLINs…');
    await act(async () => { typeInto(drawer().querySelector('input')!, '0009'); });
    await click(add);
    expect(h.createClin).not.toHaveBeenCalled();
    await act(async () => { a.resolve([]); });
    expect(add.getAttribute('aria-disabled')).toBeNull();
  });

  it('T-C1f: a CLIN created on A that resolves after switching to B doesn\'t appear in B\'s list', async () => {
    const created = deferred<unknown>();
    h.getClinsByContract.mockResolvedValueOnce([]).mockResolvedValueOnce([clin('b1', 'b', 'B-CLIN-1')]);
    h.createClin.mockReturnValueOnce(created.promise);
    await render();
    await open(A);
    await act(async () => { typeInto(drawer().querySelector('input')!, 'A-NEW'); });
    await click([...drawer().querySelectorAll('button')].find((x) => x.textContent?.trim() === 'Add'));
    expect(h.createClin).toHaveBeenCalledTimes(1);
    await open(B);
    expect(drawer().textContent).toContain('B-CLIN-1');
    await act(async () => { created.resolve({ ok: true, data: clin('a-new', 'a', 'A-NEW') }); });
    await wait();
    expect(drawer().textContent).toContain('B-CLIN-1');
    expect(drawer().textContent).not.toContain('A-NEW');
  });

  // UX-4A-AUDIT.md L1 -------------------------------------------------------------------------------------------------
  const addButton = () => [...drawer().querySelectorAll('button')].find((x) => x.textContent?.trim() === 'Add') as HTMLButtonElement;

  it('L1: while a CLIN is being created, Add is aria-disabled with a Loader — never disabled — and a second click does nothing', async () => {
    const created = deferred<unknown>();
    h.getClinsByContract.mockResolvedValueOnce([]);
    h.createClin.mockReturnValueOnce(created.promise);
    await render();
    await open(A);
    await act(async () => { typeInto(drawer().querySelector('input')!, '0009'); });
    await click(addButton());
    expect(addButton().getAttribute('aria-disabled')).toBe('true');
    expect(addButton().hasAttribute('disabled')).toBe(false);
    expect(addButton().getAttribute('data-loading')).toBeNull();
    expect(addButton().querySelector('.mantine-Loader-root')).not.toBeNull();
    await click(addButton());
    expect(h.createClin).toHaveBeenCalledTimes(1);
    await act(async () => { created.resolve({ ok: true, data: clin('n1', 'a', '0009') }); });
    await wait();
    expect(addButton().getAttribute('aria-disabled')).toBeNull();
  });

  it('L1: when the CLINs failed to load, Add says why', async () => {
    h.getClinsByContract.mockRejectedValueOnce(new Error('network'));
    await render();
    await open(A);
    expect(addButton().getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(addButton().getAttribute('aria-describedby')!)!.textContent).toBe("Couldn't load CLINs");
  });

  // UX-4A-AUDIT.md L2: the token paths the auditors' mutations got through ------------------------------------------
  const slin = (id: string, clinId: string, slinNumber: string) => ({
    id, clinId, slinNumber, description: null, fundedAmount: null, status: 'active' as const, createdAt: new Date(), updatedAt: new Date(),
  });
  const expandA1 = () => click(drawer().querySelector('button[aria-label="Expand SLINs"]'));

  it('L2: a SLIN read from a previous opening of the drawer that resolves late doesn\'t overwrite the current one', async () => {
    const stale = deferred<unknown[]>();
    const fresh = deferred<unknown[]>();
    h.getClinsByContract.mockResolvedValue([clin('a1', 'a', 'A-CLIN-1')]);
    h.getSlinsByClin.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
    await render();
    await open(A);
    await expandA1();                                         // first read, still pending
    await open(B);
    await open(A);                                            // a new opening: a new token
    await expandA1();
    await act(async () => { fresh.resolve([slin('s2', 'a1', 'FRESH-SLIN')]); });
    await act(async () => { stale.resolve([slin('s1', 'a1', 'STALE-SLIN')]); });
    await wait();
    expect(drawer().textContent).toContain('FRESH-SLIN');
    expect(drawer().textContent).not.toContain('STALE-SLIN');
  });

  it('L2: a CLIN status change that resolves after the drawer was reopened doesn\'t overwrite the fresh list', async () => {
    const toggled = deferred<unknown>();
    const inactive = { ...clin('a1', 'a', 'A-CLIN-1'), status: 'inactive' as const };
    h.getClinsByContract.mockResolvedValue([inactive]);
    h.updateClin.mockReturnValueOnce(toggled.promise);
    await render();
    await open(A);
    await click([...drawer().querySelectorAll('button')].find((x) => x.textContent?.trim() === 'Activate'));
    expect(h.updateClin).toHaveBeenCalledWith('a1', { status: 'active' });
    await open(B);
    await open(A);                                            // the fresh read still says inactive
    await act(async () => { toggled.resolve({ ok: true, data: { ...inactive, status: 'active' } }); });
    await wait();
    const row = [...drawer().querySelectorAll('tr')].find((tr) => tr.textContent?.includes('A-CLIN-1'))!;
    expect(row.textContent).toContain('Activate');
    expect(row.textContent).not.toContain('Deactivate');
  });
});
