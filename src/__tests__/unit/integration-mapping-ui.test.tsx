// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * feature-plan-ux-page-fixes.md C13 / T-C13a: QuickBooks and Gusto mapping rows. A mapped row shows its match before
 * the provider's data is loaded; clearing a mapped Select calls deleteMapping with the row's REAL id (a just-saved row
 * included — no temp- ids); a match missing from the loaded list is kept as "(not found in …)"; Sync refreshes the
 * route (success or failure); a row's Select is aria-disabled and ignores changes while its save is in flight.
 */

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  saveMapping: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  deleteMapping: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: undefined })),
  triggerQBOSync: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: { result: { pushed: 1, failed: 0, skipped: 0 } } })),
  triggerGustoSync: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ ok: false, code: 'validation', error: 'Gusto said no.' })),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));
vi.mock('@/server/actions/integrations', () => ({ saveMapping: h.saveMapping, deleteMapping: h.deleteMapping, disconnectIntegration: vi.fn(), toggleAutoSync: vi.fn() }));
vi.mock('@/server/actions/qbo', () => ({
  fetchQBOEmployeesForMapping: async () => ({ ok: true, data: [{ id: 'q2', name: 'Other Person' }, { id: 'q3', name: 'Bob QBO' }] }),
  fetchQBOVendorsForMapping: async () => ({ ok: true, data: [] }),
  fetchQBOCustomersForMapping: async () => ({ ok: true, data: [] }),
  fetchQBOServiceItemsForMapping: async () => ({ ok: true, data: [] }),
  triggerQBOSync: h.triggerQBOSync,
}));
vi.mock('@/server/actions/gusto', () => ({
  fetchGustoEmployeesForMapping: async () => ({ ok: true, data: [{ id: 'g1', name: 'Ann Gusto' }, { id: 'g2', name: 'Bob Gusto' }] }),
  triggerGustoSync: h.triggerGustoSync,
}));

import { QBOConfigClient } from '@/app/(app)/settings/integrations/quickbooks/QBOConfigClient';
import { GustoConfigClient } from '@/app/(app)/settings/integrations/gusto/GustoConfigClient';
import { notifications } from '@mantine/notifications';
import { buttonByText, click, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { unmount(m); m = undefined; });

const connection = (provider: string) => ({
  id: 'conn-1', provider, displayName: provider, externalCompanyName: 'Acme', isActive: true, autoSyncOnApproval: false,
  lastSyncAt: null, lastSyncStatus: null, connectedAt: new Date('2026-10-01T12:00:00Z'),
});
const mapping = (id: string, bytimeEntityId: string, externalEntityId: string, externalEntityName: string) => ({
  id, connectionId: 'conn-1', entityType: 'employee', bytimeEntityId, bytimeEntityName: null, externalEntityId, externalEntityName, metadata: null,
});
const EMPLOYEES = [{ id: 'u1', fullName: 'Ann', email: 'ann@x.test' }, { id: 'u2', fullName: 'Bob', email: 'bob@x.test' }];
/** QuickBooks keeps every tab panel mounted (Employees and Vendors both list the same people): query the visible one. */
const panel = () => m!.container.querySelector('[role="tabpanel"]:not([style*="display: none"])') as HTMLElement;
const row = (name: string) => [...panel().querySelectorAll('tbody tr')].find((tr) => tr.querySelector('td')?.textContent?.startsWith(name)) as HTMLElement;
const select = (label: string) => panel().querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
/** The option in THIS Select's listbox (other rows' listboxes stay mounted). */
const optionOf = (label: string, option: string) => {
  const list = document.getElementById(select(label).getAttribute('aria-controls') ?? '');
  return list ? [...list.querySelectorAll('[role="option"]')].find((o) => o.textContent?.trim() === option) : undefined;
};
async function choose(label: string, option: string) {
  await click(select(label));
  await click(optionOf(label, option));
}
const deferred = () => { let resolve!: (v: unknown) => void; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

describe('QuickBooks mapping rows (C13)', () => {
  const render = async () => {
    m = await mount(<QBOConfigClient connection={connection('quickbooks')} mappings={[mapping('map-real-1', 'u1', 'q1', 'Ann QBO')]} syncLogs={[]}
      bytimeEmployees={EMPLOYEES} bytimeContracts={[]} bytimeClins={[]} workspaceTimezone="America/New_York" />);
  };

  it('before Load, a mapped row shows its match and how to change it', async () => {
    await render();
    expect(row('Ann').textContent).toContain('Ann QBO');
    expect(row('Ann').textContent).toContain('Load QuickBooks data to change');
    expect(row('Bob').textContent).toContain('Load QBO Data to see employees');
  });

  it('after Load: a missing match is kept as "(not found in QuickBooks)"; clearing deletes by the real id and removes it', async () => {
    await render();
    await click(buttonByText('Load QBO Data'));
    await wait();
    expect(select('QuickBooks match for Ann').value).toBe('Ann QBO (not found in QuickBooks)');
    await click(panel().querySelector('[aria-label="Remove mapping for Ann"]'));
    await wait();
    expect(h.deleteMapping).toHaveBeenCalledWith('map-real-1');
    expect(row('Ann').textContent).toContain('Unmapped');
    expect(notifications.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Mapping removed', message: 'Ann is no longer matched.' }));
  });

  it('a save stores the real id (a later clear deletes it); the Select is aria-disabled and ignores changes while the save runs', async () => {
    const pending = deferred();
    h.saveMapping.mockImplementationOnce(() => pending.promise);
    await render();
    await click(buttonByText('Load QBO Data'));
    await wait();
    await choose('QuickBooks match for Bob', 'Bob QBO');
    expect(select('QuickBooks match for Bob').getAttribute('aria-disabled')).toBe('true');
    await click(select('QuickBooks match for Bob'));
    const other = optionOf('QuickBooks match for Bob', 'Other Person');
    if (other) await click(other);
    expect(h.saveMapping).toHaveBeenCalledTimes(1);
    expect(h.saveMapping.mock.calls[0][0]).toMatchObject({ bytimeEntityId: 'u2', externalEntityId: 'q3' });
    pending.resolve({ ok: true, data: { id: 'map-new-9' } });
    await wait();
    expect(select('QuickBooks match for Bob').getAttribute('aria-disabled')).toBeNull();
    await click(panel().querySelector('[aria-label="Remove mapping for Bob"]'));
    await wait();
    expect(h.deleteMapping).toHaveBeenCalledWith('map-new-9');
  });

  it('"no longer exists" also drops the mapping from the page', async () => {
    h.deleteMapping.mockResolvedValueOnce({ ok: false, code: 'validation', error: 'That mapping no longer exists.' });
    await render();
    await click(buttonByText('Load QBO Data'));
    await wait();
    await click(panel().querySelector('[aria-label="Remove mapping for Ann"]'));
    await wait();
    expect(row('Ann').textContent).toContain('Unmapped');
  });

  it('Sync refreshes the route', async () => {
    await render();
    await click(buttonByText('Sync Now'));
    await wait();
    expect(h.triggerQBOSync).toHaveBeenCalled();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('Gusto mapping rows (C13)', () => {
  const render = async () => {
    m = await mount(<GustoConfigClient connection={connection('gusto')} mappings={[mapping('map-g-1', 'u1', 'g-gone', 'Ann (old)')]} syncLogs={[]}
      bytimeEmployees={EMPLOYEES} workspaceTimezone="America/New_York" />);
  };

  it('before Load the match shows; after Load clearing deletes by the real id', async () => {
    await render();
    expect(row('Ann').textContent).toContain('Ann (old)');
    expect(row('Ann').textContent).toContain('Load Gusto data to change');
    await click(buttonByText('Load Gusto Employees'));
    await wait();
    expect(select('Gusto match for Ann').value).toBe('Ann (old) (not found in Gusto)');
    await click(panel().querySelector('[aria-label="Remove mapping for Ann"]'));
    await wait();
    expect(h.deleteMapping).toHaveBeenCalledWith('map-g-1');
  });

  it('the Select is aria-disabled and ignores changes while its save runs', async () => {
    const pending = deferred();
    h.saveMapping.mockImplementationOnce(() => pending.promise);
    await render();
    await click(buttonByText('Load Gusto Employees'));
    await wait();
    await choose('Gusto match for Bob', 'Bob Gusto');
    expect(select('Gusto match for Bob').getAttribute('aria-disabled')).toBe('true');
    await click(select('Gusto match for Bob'));
    const other = optionOf('Gusto match for Bob', 'Ann Gusto');
    if (other) await click(other);
    expect(h.saveMapping).toHaveBeenCalledTimes(1);
    expect(h.saveMapping.mock.calls[0][0]).toMatchObject({ bytimeEntityId: 'u2', externalEntityId: 'g2' });
    pending.resolve({ ok: true, data: { id: 'map-g-2' } });
    await wait();
    expect(select('Gusto match for Bob').getAttribute('aria-disabled')).toBeNull();
  });

  it('Sync refreshes the route even when it fails', async () => {
    await render();
    await click(buttonByText('Sync Now'));
    await wait();
    expect(h.triggerGustoSync).toHaveBeenCalled();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
});
