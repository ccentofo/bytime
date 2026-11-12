// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { theme } from '@/theme';

/**
 * feature-plan-ux-integrations-billing.md §3.2: the QuickBooks page (IntegrationConfigView) and the Gusto page.
 * - IN-4 QuickBooks data loads on open, ONCE under StrictMode.
 * - C13 (kept, now on the Contracts tab): a missing match shows "(not found in QuickBooks)"; clearing deletes by the
 *   real id (a just-saved row included); the Select is aria-disabled while its save runs; "no longer exists" drops it.
 * - IN-6 / I4 a legacy double match warns, and choosing one leaves only it; a failed choice is reverted.
 * - IN-8 / I5 the suggestion and "Match {n} by email".
 * - IN-9 / I6 the Send modal: period options, the unmatched and not-yet-approved counts, the duplicate and stale
 *   warnings, "Match at least one person first".
 * - IN-10 / I7 History in words; "See {n} failures" only when failed records exist, with server labels.
 * - IN-13 the Gusto page: no matching, Send or History; nothing says "sent".
 */

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  lists: null as unknown,
  load: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  saveMapping: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  deleteMapping: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: undefined })),
  setPersonMapping: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  matchPeopleByEmail: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: { matched: 1, skipped: 0 } })),
  getSendPreview: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  getSyncFailures: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => [{ id: 'r1', label: 'Ann · Navy / 0001 · Oct 15, 2026', error: 'Bad item' }]),
  triggerQBOSync: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ ok: true, data: { syncLogId: 'l', result: { pushed: 3, failed: 0, skipped: 0, errors: [] } } })),
  startQuickBooksConnect: vi.fn(async () => {}),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));
vi.mock('@/server/actions/qbo', () => ({ loadQboMappingData: h.load, triggerQBOSync: h.triggerQBOSync }));
vi.mock('@/server/actions/integrations', () => ({
  saveMapping: h.saveMapping, deleteMapping: h.deleteMapping, disconnectIntegration: vi.fn(), setPersonMapping: h.setPersonMapping,
  matchPeopleByEmail: h.matchPeopleByEmail, getSendPreview: h.getSendPreview, getSyncFailures: h.getSyncFailures,
  startQuickBooksConnect: h.startQuickBooksConnect,
}));

import { IntegrationConfigView, type ConfigMapping, type SendPeriodOption } from '@/app/(app)/settings/integrations/IntegrationConfigView';
import { GustoConfigClient } from '@/app/(app)/settings/integrations/gusto/GustoConfigClient';
import { buttonByText, click, dialogTitled, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';
import type { SyncLog } from '@/server/actions/integrations';

beforeAll(installDomStubs);
let m: Mounted | undefined;
const LISTS = {
  employees: { ok: true, data: [{ id: 'e1', name: 'Emily Davis', email: 'emily.davis@acme.test' }, { id: 'e2', name: 'Bob QBO' }] },
  vendors: { ok: true, data: [{ id: 'v1', name: 'Davis Consulting LLC' }] },
  customers: { ok: true, data: [{ id: 'k2', name: 'Other Customer' }, { id: 'k3', name: 'Navy QBO' }] },
  items: { ok: true, data: [] },
};
beforeEach(() => {
  vi.clearAllMocks();
  h.saveMapping.mockReset();
  h.setPersonMapping.mockReset();
  h.load.mockImplementation(async () => ({ ok: true, data: LISTS }));
  h.getSendPreview.mockImplementation(async () => ({ periodStart: '2026-10-16', periodEnd: '2026-10-31', unmatchedPeople: 0, notApprovedPeople: 0, sentAt: null, partlySentAt: null }));
});
afterEach(() => { unmount(m); m = undefined; });

const PEOPLE = [
  { id: 'u1', fullName: 'Emily Davis', email: 'Emily.Davis@acme.test' },
  { id: 'u2', fullName: 'John Doe', email: 'john@acme.test' },
];
const CONTRACTS = [{ id: 'k-ann', contractNumber: 'N-1', name: 'Navy' }, { id: 'k-bob', contractNumber: 'A-2', name: 'Army' }];
const PERIODS = ([
  { start: '2026-10-16', end: '2026-10-31', label: 'Last pay period · Oct 16 – 31, 2026' },
  { start: '2026-11-01', end: '2026-11-15', label: 'This pay period · Nov 1 – 15, 2026' },
  { start: '2026-10-01', end: '2026-10-15', label: 'Pay period · Oct 1 – 15, 2026' },
  { start: '2026-09-16', end: '2026-09-30', label: 'Pay period · Sep 16 – 30, 2026' },
] as Array<{ start: string; end: string; label: string }>) as SendPeriodOption[];
const map = (id: string, entityType: string, bytimeEntityId: string, externalEntityId: string, externalEntityName: string): ConfigMapping => ({
  id, entityType, bytimeEntityId, bytimeEntityName: null, externalEntityId, externalEntityName,
});
const render = async (opts: { mappings?: ConfigMapping[]; logs?: SyncLog[]; strict?: boolean; expired?: boolean } = {}) => {
  const ui = (
    <IntegrationConfigView
      connection={{ id: 'conn-1', companyName: 'Acme Federal LLC', connectedAt: new Date('2026-10-02T12:00:00Z'), expired: opts.expired ?? false }}
      people={PEOPLE}
      contracts={CONTRACTS}
      clins={[]}
      mappings={opts.mappings ?? []}
      syncLogs={opts.logs ?? []}
      periods={PERIODS}
      expiredMessage="Your QuickBooks connection has expired — reconnect it on the Integrations page."
      workspaceTimezone="America/New_York"
    />
  );
  if (opts.strict) {
    // StrictMode must wrap the ROOT for React to double-invoke effects (nested inside mount()'s providers it doesn't).
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<StrictMode><MantineProvider env="test" theme={theme}>{ui}</MantineProvider></StrictMode>); });
    m = { container, root };
  } else {
    m = await mount(ui);
  }
  await wait();
};
const tab = async (label: RegExp) => click([...document.body.querySelectorAll('[role="tab"]')].find((t) => label.test(t.textContent ?? '')));
/** Inactive panels stay in the DOM with display: none: query the visible one. */
const panel = () => m!.container.querySelector('[role="tabpanel"]:not([style*="display: none"])') as HTMLElement;
const row = (name: string) => [...panel().querySelectorAll('tbody tr')].find((tr) => tr.querySelector('td')?.textContent?.startsWith(name)) as HTMLElement;
/** A Select by its aria-label, or by its visible <label>. */
const select = (label: string) => (document.body.querySelector(`input[aria-label="${label}"]`)
  ?? document.getElementById([...document.body.querySelectorAll('label')].find((l) => l.textContent === label)?.htmlFor ?? '')) as HTMLInputElement;
const optionOf = (label: string, option: string) => {
  const list = document.getElementById(select(label).getAttribute('aria-controls') ?? '');
  return list ? [...list.querySelectorAll('[role="option"]')].find((o) => o.textContent?.trim() === option) : undefined;
};
async function choose(label: string, option: string) {
  await click(select(label));
  await click(optionOf(label, option));
}
const deferred = () => { let resolve!: (v: unknown) => void; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

describe('IN-4 (UI): QuickBooks data loads when the page opens', () => {
  it('one load under StrictMode; the status line says loaded with Refresh', async () => {
    await render({ strict: true });
    expect(h.load).toHaveBeenCalledTimes(1);
    expect(h.load).toHaveBeenCalledWith('conn-1');
    const status = m!.container.querySelector('[data-testid="qbo-status-line"]')!;
    expect(status.textContent).toMatch(/QuickBooks data loaded .*Refresh/);
    expect(buttonByText('Load QBO Data')).toBeUndefined();
  });

  it('a failed list shows its message and Retry in its tab; the others still work', async () => {
    h.load.mockImplementation(async () => ({ ok: true, data: { ...LISTS, customers: { ok: false, error: 'QuickBooks returned an error (HTTP 500).' } } }));
    await render();
    await tab(/^Contracts/);
    expect(panel().textContent).toContain('QuickBooks returned an error (HTTP 500).');
    expect([...panel().querySelectorAll('button')].some((b) => b.textContent === 'Retry')).toBe(true);
    await tab(/^People/);
    expect(optionOf('QuickBooks match for John Doe', 'Bob QBO · Employee') ?? (await click(select('QuickBooks match for John Doe')), optionOf('QuickBooks match for John Doe', 'Bob QBO · Employee'))).toBeTruthy();
  });

  it('the expired message on load → Reconnect on the status line', async () => {
    h.load.mockImplementation(async () => ({ ok: false, code: 'validation', error: 'Your QuickBooks connection has expired — reconnect it on the Integrations page.' }));
    await render();
    const status = m!.container.querySelector('[data-testid="qbo-status-line"]')!;
    // H5: Reconnect is a submit button in a form posting the startQuickBooksConnect server action.
    const reconnect = status.querySelector('form button[type="submit"]') as HTMLButtonElement;
    expect(reconnect?.textContent).toBe('Reconnect');
    expect(status.querySelector('a[href*="qbo-connect"]')).toBeNull();
    await act(async () => { reconnect.click(); });
    expect(h.startQuickBooksConnect).toHaveBeenCalledTimes(1);
  });
});

describe('C13 (kept): contract rows', () => {
  it('a missing match is kept as "(not found in QuickBooks)"; clearing deletes by the real id and removes it', async () => {
    await render({ mappings: [map('map-real-1', 'contract', 'k-ann', 'k1', 'Navy Old')] });
    await tab(/^Contracts/);
    expect(select('QuickBooks match for Navy').value).toBe('Navy Old (not found in QuickBooks)');
    await click(panel().querySelector('[aria-label="Remove match for Navy"]'));
    expect(h.deleteMapping).toHaveBeenCalledWith('map-real-1');
    expect(row('Navy').textContent).toContain('Not matched');
  });

  it('a save stores the real id (a later clear deletes it); the Select is aria-disabled and ignores changes while the save runs', async () => {
    const pending = deferred();
    h.saveMapping.mockImplementationOnce(() => pending.promise);
    await render();
    await tab(/^Contracts/);
    await choose('QuickBooks match for Army', 'Navy QBO');
    expect(select('QuickBooks match for Army').getAttribute('aria-disabled')).toBe('true');
    await click(select('QuickBooks match for Army'));
    const other = optionOf('QuickBooks match for Army', 'Other Customer');
    if (other) await click(other);
    expect(h.saveMapping).toHaveBeenCalledTimes(1);
    expect(h.saveMapping.mock.calls[0][0]).toMatchObject({ entityType: 'contract', bytimeEntityId: 'k-bob', externalEntityId: 'k3' });
    pending.resolve({ ok: true, data: { id: 'map-new-9' } });
    await wait();
    expect(select('QuickBooks match for Army').getAttribute('aria-disabled')).toBeNull();
    await click(panel().querySelector('[aria-label="Remove match for Army"]'));
    expect(h.deleteMapping).toHaveBeenCalledWith('map-new-9');
  });

  it('"no longer exists" also drops the match from the page', async () => {
    h.deleteMapping.mockResolvedValueOnce({ ok: false, code: 'validation', error: 'That mapping no longer exists.' });
    await render({ mappings: [map('map-real-1', 'contract', 'k-ann', 'k3', 'Navy QBO')] });
    await tab(/^Contracts/);
    await click(panel().querySelector('[aria-label="Remove match for Navy"]'));
    expect(row('Navy').textContent).toContain('Not matched');
  });

  it('tab labels carry the counts', async () => {
    await render({ mappings: [map('m1', 'contract', 'k-ann', 'k3', 'Navy QBO'), map('m2', 'employee', 'u2', 'e2', 'Bob QBO')] });
    const tabs = [...document.body.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabs).toEqual(['People (1 of 2 matched)', 'Contracts (1 of 2)', 'CLINs (0 of 0)', 'History']);
  });
});

describe('IN-6 / I4: one match per person', () => {
  it('a legacy double match warns; choosing the vendor sends one setPersonMapping and leaves only it', async () => {
    h.setPersonMapping.mockResolvedValueOnce({ ok: true, data: { mapping: map('m-v', 'vendor', 'u2', 'v1', 'Davis Consulting LLC') } });
    await render({ mappings: [map('m-e', 'employee', 'u2', 'e2', 'Bob QBO'), map('m-v0', 'vendor', 'u2', 'v1', 'Davis Consulting LLC')] });
    expect(row('John Doe').textContent).toContain('Also matched to vendor Davis Consulting LLC. Choose one.');
    expect(select('QuickBooks match for John Doe').value).toBe('Bob QBO · Employee');
    await choose('QuickBooks match for John Doe', 'Davis Consulting LLC · Vendor');
    expect(h.setPersonMapping).toHaveBeenCalledWith({ connectionId: 'conn-1', userId: 'u2', match: { type: 'vendor', externalId: 'v1', externalName: 'Davis Consulting LLC' } });
    expect(row('John Doe').textContent).not.toContain('Also matched');
    expect(select('QuickBooks match for John Doe').value).toBe('Davis Consulting LLC · Vendor');
  });

  it('a refused choice is reverted (optimistic change undone)', async () => {
    h.setPersonMapping.mockResolvedValueOnce({ ok: false, code: 'validation', error: 'That person is inactive or no longer exists.' });
    await render({ mappings: [map('m-e', 'employee', 'u2', 'e2', 'Bob QBO')] });
    await choose('QuickBooks match for John Doe', 'Not matched');
    await wait();
    expect(select('QuickBooks match for John Doe').value).toBe('Bob QBO · Employee');
    expect(row('John Doe').textContent).toContain('Matched');
  });

  it('F6b: the change shows at once, before setPersonMapping answers (optimistic)', async () => {
    const pending = deferred();
    h.setPersonMapping.mockImplementationOnce(() => pending.promise);
    await render();
    await choose('QuickBooks match for John Doe', 'Bob QBO · Employee');
    expect(select('QuickBooks match for John Doe').value).toBe('Bob QBO · Employee');
    expect(row('John Doe').textContent).toContain('Matched');
    expect(select('QuickBooks match for John Doe').getAttribute('aria-disabled')).toBe('true');
    pending.resolve({ ok: true, data: { mapping: map('m-new', 'employee', 'u2', 'e2', 'Bob QBO') } });
    await wait();
    expect(select('QuickBooks match for John Doe').getAttribute('aria-disabled')).toBeNull();
  });

  it('F9 (G8): "Keep the employee match" saves the employee match', async () => {
    h.setPersonMapping.mockResolvedValueOnce({ ok: true, data: { mapping: map('m-e2', 'employee', 'u2', 'e2', 'Bob QBO') } });
    await render({ mappings: [map('m-e', 'employee', 'u2', 'e2', 'Bob QBO'), map('m-v0', 'vendor', 'u2', 'v1', 'Davis Consulting LLC')] });
    await click([...row('John Doe').querySelectorAll('button')].find((b) => b.textContent === 'Keep the employee match'));
    expect(h.setPersonMapping).toHaveBeenCalledWith({ connectionId: 'conn-1', userId: 'u2', match: { type: 'employee', externalId: 'e2', externalName: 'Bob QBO' } });
    expect(row('John Doe').textContent).not.toContain('Also matched');
  });

  it('F10: with no active people, the People tab says "No active people yet."', async () => {
    m = await mount(
      <IntegrationConfigView connection={{ id: 'conn-1', companyName: 'Acme', connectedAt: new Date(), expired: false }} people={[]} contracts={[]} clins={[]}
        mappings={[]} syncLogs={[]} periods={PERIODS} expiredMessage="x" workspaceTimezone="UTC" />,
    );
    await wait();
    expect(panel().textContent).toContain('No active people yet.');
    expect(panel().textContent).not.toContain('Everyone is matched.');
  });

  it('"Not matched only" hides matched people', async () => {
    await render({ mappings: [map('m-e', 'employee', 'u2', 'e2', 'Bob QBO')] });
    await choose('Show', 'Not matched only');
    expect([...panel().querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')?.textContent)).toEqual(['Emily DavisEmily.Davis@acme.test']);
  });
});

describe('F2: a saved match is "not found" only against a loaded list', () => {
  it('while QuickBooks data loads, saved matches show their saved name (no "not found")', async () => {
    h.load.mockImplementation(() => new Promise(() => {})); // never answers
    await render({ mappings: [map('m-e', 'employee', 'u2', 'e9', 'Old Bob'), map('m-k', 'contract', 'k-ann', 'k9', 'Navy Old')] });
    expect(select('QuickBooks match for John Doe').value).toBe('Old Bob · Employee');
    await tab(/^Contracts/);
    expect(select('QuickBooks match for Navy').value).toBe('Navy Old');
  });

  it('when a list failed, its saved matches show their saved name; a loaded list still marks "not found"', async () => {
    h.load.mockImplementation(async () => ({ ok: true, data: { ...LISTS, employees: { ok: false, error: 'HTTP 500' }, customers: { ok: false, error: 'HTTP 500' } } }));
    await render({ mappings: [map('m-e', 'employee', 'u2', 'e9', 'Old Bob'), map('m-v', 'vendor', 'u1', 'v9', 'Gone LLC'), map('m-k', 'contract', 'k-ann', 'k9', 'Navy Old')] });
    expect(select('QuickBooks match for John Doe').value).toBe('Old Bob · Employee');
    expect(select('QuickBooks match for Emily Davis').value).toBe('Gone LLC (not found in QuickBooks)');
    await tab(/^Contracts/);
    expect(select('QuickBooks match for Navy').value).toBe('Navy Old');
  });
});

describe('IN-8 / I5: email suggestions and match by email', () => {
  it('F3: with one list failed (employees), no suggestion and no "Match by email"', async () => {
    h.load.mockImplementation(async () => ({ ok: true, data: { ...LISTS, employees: { ok: false, error: 'HTTP 500' }, vendors: { ok: true, data: [{ id: 'v1', name: 'Emily LLC', email: 'emily.davis@acme.test' }] } } }));
    await render();
    expect(row('Emily Davis').textContent).not.toContain('Suggested');
    expect([...document.body.querySelectorAll('button')].some((b) => /by email/.test(b.textContent ?? ''))).toBe(false);
  });

  it('the unique same-email record is suggested; "Match 1 person by email" sends the pairs and refreshes', async () => {
    await render();
    expect(row('Emily Davis').textContent).toContain('Suggested: Emily Davis (same email)');
    expect(row('John Doe').textContent).not.toContain('Suggested');
    expect(m!.container.textContent).toContain('Only fills people who aren’t matched yet.');
    await click(buttonByText('Match 1 person by email'));
    expect(h.matchPeopleByEmail).toHaveBeenCalledWith({
      connectionId: 'conn-1', pairs: [{ userId: 'u1', match: { type: 'employee', externalId: 'e1', externalName: 'Emily Davis' } }],
    });
    expect(h.refresh).toHaveBeenCalled();
  });
});

describe('IN-9 / I6: the Send modal', () => {
  const openSend = async (mappings = [map('m-e', 'employee', 'u2', 'e2', 'Bob QBO')]) => {
    await render({ mappings });
    await click(buttonByText('Send hours now…'));
    await wait();
    return dialogTitled('Send hours to QuickBooks')!;
  };

  it('period options (last is the default); the unmatched and not-yet-approved counts', async () => {
    h.getSendPreview.mockResolvedValue({ periodStart: '2026-10-16', periodEnd: '2026-10-31', unmatchedPeople: 5, notApprovedPeople: 2, sentAt: null, partlySentAt: null });
    const dialog = await openSend();
    expect(select('Approved hours from').value).toBe('Last pay period · Oct 16 – 31, 2026');
    await click(select('Approved hours from'));
    const options = [...document.getElementById(select('Approved hours from').getAttribute('aria-controls')!)!.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(options).toEqual(PERIODS.map((p) => p.label));
    expect(options.some((o) => /custom/i.test(o ?? ''))).toBe(false);
    expect(h.getSendPreview).toHaveBeenCalledWith('conn-1', '2026-10-16');
    expect(dialog.textContent).toContain('5 people aren’t matched, so their hours will be skipped.');
    expect(dialog.textContent).toContain('2 people aren’t approved yet. Their hours won’t be sent, and sending this period again later resends everyone.');
  });

  it('the duplicate warning; the stale-running warning; none when the period wasn’t sent', async () => {
    h.getSendPreview.mockResolvedValueOnce({ periodStart: '2026-10-16', periodEnd: '2026-10-31', unmatchedPeople: 0, notApprovedPeople: 0, sentAt: new Date('2026-11-03T19:14:00Z'), partlySentAt: new Date('2026-11-04T19:14:00Z') });
    let dialog = await openSend();
    expect(dialog.textContent).toContain('Already sent on Nov 3, 2026 EST. Sending again creates duplicate time entries in QuickBooks.');
    expect(dialog.textContent).toContain('This period may have been partly sent on Nov 4, 2026 EST.');
    unmount(m);
    dialog = await openSend();
    expect(dialog.textContent).not.toMatch(/Already sent|partly sent/);
  });

  it('no one matched → "Match at least one person first." and Send does nothing', async () => {
    const dialog = await openSend([]);
    expect(dialog.textContent).toContain('Match at least one person first.');
    await click([...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Send hours'));
    expect(h.triggerQBOSync).not.toHaveBeenCalled();
  });

  it('Send hours sends the chosen period by its start and refreshes', async () => {
    const dialog = await openSend();
    await click([...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Send hours'));
    expect(h.triggerQBOSync).toHaveBeenCalledWith({ connectionId: 'conn-1', periodStart: '2026-10-16' });
    expect(h.refresh).toHaveBeenCalled();
  });
});

describe('IN-10 / I7: History in words', () => {
  const log = (over: Partial<SyncLog>): SyncLog => ({
    id: 'log', connectionId: 'conn-1', syncType: 'timesheet_push', periodStart: '2026-10-16' as never, periodEnd: '2026-10-31' as never,
    triggeredBy: null, triggerType: 'manual', recordsPushed: 0, recordsFailed: 0, recordsSkipped: 0, status: 'success', errorSummary: null,
    startedAt: new Date('2026-11-03T19:14:00Z'), completedAt: null, createdAt: new Date('2026-11-03T19:14:00Z'), failedRecords: 0, ...over,
  });

  it('result text per row; "See {n} failures" only when failed records exist, opening labelled failures', async () => {
    await render({
      logs: [
        log({ id: 'a', recordsPushed: 42, recordsSkipped: 5 }),
        log({ id: 'b', status: 'partial', recordsPushed: 30, recordsFailed: 2, failedRecords: 2 }),
        // F6a: records_failed > 0 but no stored failed records → no button (the button follows failedRecords).
        log({ id: 'c', status: 'failed', errorSummary: 'Your QuickBooks connection has expired.', recordsFailed: 3, failedRecords: 0 }),
        log({ id: 'd' }),
        log({ id: 'e', recordsSkipped: 3 }),
      ],
    });
    await tab(/^History/);
    const results = [...panel().querySelectorAll('[data-testid="sync-result"]')].map((r) => r.textContent);
    expect(results).toEqual([
      'Sent · 5 entries skipped: people not matched',
      'Partly sent',
      'Failed: Your QuickBooks connection has expired.',
      'Nothing to send: no approved hours in this period',
      'Nothing sent · 3 entries skipped: people not matched',
    ]);
    // Only the row with failed records has a button in its Result cell.
    const see = [...panel().querySelectorAll('tbody tr td:last-child button')];
    expect(see.map((b) => b.textContent)).toEqual(['See 2 failures']);
    expect(row('Nov 3').textContent).toContain('Oct 16 – 31, 2026');
    await click(see[0]);
    await wait();
    expect(h.getSyncFailures).toHaveBeenCalledWith('b');
    expect(dialogTitled('Entries that failed')?.textContent).toContain('Ann · Navy / 0001 · Oct 15, 2026');
  });
});

describe('IN-13 (page): the Gusto page is honest (I10)', () => {
  it('only the note, "Open Payroll export" and Disconnect — no matching, Send or History; nothing says "sent"', async () => {
    m = await mount(<GustoConfigClient connection={{ id: 'g1', companyName: 'Gusto Co' }} />);
    const text = m.container.textContent ?? '';
    expect(text).toContain('Sending hours straight to Gusto isn’t available yet. Download payroll files for Gusto from Payroll export.');
    expect([...m.container.querySelectorAll('a, button')].map((b) => b.textContent?.trim()).filter((t) => t !== 'Integrations'))
      .toEqual(['Open Payroll export', 'Disconnect…']);
    expect(m.container.querySelector('table, [role="tab"], select, input')).toBeNull();
    expect(text).not.toMatch(/\bsent\b|send hours|history|match/i);
  });
});
