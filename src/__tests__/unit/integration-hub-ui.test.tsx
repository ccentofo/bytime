// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';

/**
 * feature-plan-ux-integrations-billing.md §3.1 / I1, I10: the Integrations hub. IN-1 the callback banner renders from
 * the server's props (the mocked search params are EMPTY) and survives the replaceState that drops the params; IN-3
 * each connector once, the last send in words, the unmatched count, no Auto-sync badge; IN-13 the Gusto card is honest
 * (no Connect, nothing says "sent"); IN-15 Reconnect only while expired.
 */

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ refresh: vi.fn() }) }));

import { IntegrationsClient, callbackBanner, type CallbackParams } from '@/app/(app)/settings/integrations/IntegrationsClient';
import type { HubConnection } from '@/server/actions/integrations';
import { installDomStubs, mount, unmount, type Mounted } from '../helpers/dom';

beforeAll(installDomStubs);
let m: Mounted | undefined;
afterEach(() => { unmount(m); m = undefined; window.history.replaceState(null, '', '/'); });

const NO_CALLBACK: CallbackParams = { connected: null, provider: null, error: null };
const qbo = (over: Partial<HubConnection> = {}): HubConnection => ({
  id: 'c1', companyName: 'Acme Federal LLC', connectedAt: new Date('2026-10-02T12:00:00Z'), expired: false,
  lastSend: { at: new Date('2026-11-03T19:14:00Z'), pushed: 42, failed: 0, skipped: 5, status: 'success', errorSummary: null },
  unmatchedPeople: 5, ...over,
});
const render = async (hub: Partial<{ qbo: HubConnection | null; gusto: HubConnection | null; activeApiKeys: number }> = {}, callback = NO_CALLBACK) => {
  m = await mount(<IntegrationsClient hub={{ qbo: null, gusto: null, activeApiKeys: 2, ...hub }} callback={callback} workspaceTimezone="America/New_York" />);
};
const card = (title: string) => m!.container.querySelector(`section[aria-label="${title}"]`) as HTMLElement;
const links = (el: HTMLElement) => [...el.querySelectorAll('a, button')].map((a) => a.textContent?.trim());

describe('IN-1: the callback banner (I1)', () => {
  it('each param → its text and role, from props while useSearchParams is empty', () => {
    expect(callbackBanner({ connected: 'true', provider: 'qbo', error: null })).toEqual({
      kind: 'success', text: 'QuickBooks Online is connected. Next, match your people, contracts and CLINs.',
      action: { label: 'Match now', href: '/settings/integrations/quickbooks' },
    });
    expect(callbackBanner({ connected: 'true', provider: null, error: null })?.text).toBe('Connected.');
    expect(callbackBanner({ connected: null, provider: null, error: 'connection_cancelled' })?.text).toBe('Connecting was cancelled. Nothing changed.');
    expect(callbackBanner({ connected: null, provider: null, error: 'connection_failed' })?.text).toBe('Couldn’t finish connecting. Try again; if it keeps happening, contact support.');
    expect(callbackBanner({ connected: null, provider: null, error: 'qbo_config_missing' })?.text).toBe('QuickBooks isn’t set up for this server yet. Contact support.');
    expect(callbackBanner({ connected: null, provider: null, error: 'unknown_provider' })?.text).toBe('Couldn’t finish connecting.');
    expect(callbackBanner(NO_CALLBACK)).toBeNull();
  });

  it('success renders as role="status" with "Match now", and stays after replaceState drops the params', async () => {
    window.history.replaceState(null, '', '/settings/integrations?connected=true&provider=qbo');
    const replace = vi.spyOn(window.history, 'replaceState');
    await render({ qbo: qbo() }, { connected: 'true', provider: 'qbo', error: null });
    expect(replace).toHaveBeenCalledWith(null, '', '/settings/integrations');
    expect(window.location.search).toBe('');
    const banner = m!.container.querySelector('[role="status"]')!;
    expect(banner.textContent).toContain('QuickBooks Online is connected.');
    expect(banner.querySelector('a')?.getAttribute('href')).toBe('/settings/integrations/quickbooks');
    replace.mockRestore();
  });

  it('an error renders as role="alert"; no params → no banner and no replaceState', async () => {
    await render({}, { connected: null, provider: null, error: 'connection_cancelled' });
    expect(m!.container.querySelector('[role="alert"]')?.textContent).toContain('Connecting was cancelled. Nothing changed.');
    unmount(m);
    const replace = vi.spyOn(window.history, 'replaceState');
    await render();
    expect(m!.container.querySelector('[role="alert"], [role="status"]')).toBeNull();
    expect(replace).not.toHaveBeenCalled();
    replace.mockRestore();
  });
});

describe('IN-3: the hub cards', () => {
  it('each connector once, the last send in words, the unmatched count, no Auto-sync badge', async () => {
    await render({ qbo: qbo() });
    const titles = [...m!.container.querySelectorAll('section h2')].map((h) => h.textContent);
    expect(titles).toEqual(['QuickBooks Online', 'Gusto', 'Payroll file', 'API keys']);
    expect(card('QuickBooks Online').textContent).toContain('Last sent Nov 3, 2026 EST · 42 sent, 0 failed · 5 people not matched');
    expect(card('API keys').textContent).toContain('2 active keys');
    expect(m!.container.textContent).not.toMatch(/Auto-sync|push timesheets|Configure/i);
    expect(links(card('QuickBooks Online'))).toEqual(['Open']);
  });

  it('nothing sent yet; not connected → "Connect QuickBooks"', async () => {
    await render({ qbo: qbo({ lastSend: null, unmatchedPeople: 0 }) });
    expect(card('QuickBooks Online').textContent).toContain('Nothing sent yet');
    expect(card('QuickBooks Online').textContent).not.toContain('not matched');
    unmount(m);
    await render();
    expect(links(card('QuickBooks Online'))).toEqual(['Connect QuickBooks']);
    expect(card('QuickBooks Online').querySelector('a')?.getAttribute('href')).toBe('/api/integrations/qbo-connect');
  });
});

describe('IN-15 (unit): Reconnect only while the connection is expired', () => {
  it('expired → Reconnect (to the connect route) plus Open; after a reconnect (expired false) → no Reconnect', async () => {
    await render({ qbo: qbo({ expired: true }) });
    expect(links(card('QuickBooks Online'))).toEqual(['Reconnect', 'Open']);
    expect(card('QuickBooks Online').textContent).toContain('Needs reconnecting');
    unmount(m);
    await render({ qbo: qbo({ expired: false }) });
    expect(links(card('QuickBooks Online'))).not.toContain('Reconnect');
  });

  it('read-only workspace: Reconnect and Connect are the disabled WriteButton', async () => {
    m = await mount(<IntegrationsClient hub={{ qbo: null, gusto: null, activeApiKeys: 0 }} callback={NO_CALLBACK} workspaceTimezone="UTC" />, 'read_only');
    const connect = [...card('QuickBooks Online').querySelectorAll('button')].find((b) => b.textContent === 'Connect QuickBooks');
    expect(connect?.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('IN-13 (hub): Gusto is honest (I10)', () => {
  it('no Connect; the note and "Open Payroll export"; nothing says "sent"', async () => {
    await render();
    const gusto = card('Gusto');
    expect(gusto.textContent).toContain('Sending hours straight to Gusto isn’t available yet. Download a Gusto payroll file from Payroll export.');
    expect(links(gusto)).toEqual(['Open Payroll export']);
    expect(gusto.querySelector('a[href*="gusto-connect"]')).toBeNull();
    expect(gusto.textContent).not.toMatch(/\bsent\b|sends/i);
  });

  it('an existing Gusto connection: the same note, plus a way to its page (to disconnect)', async () => {
    await render({ gusto: { ...qbo(), id: 'g1', companyName: 'Gusto Co', lastSend: null, unmatchedPeople: 0 } });
    expect(links(card('Gusto'))).toEqual(['Open Payroll export', 'Manage connection']);
    expect(card('Gusto').textContent).not.toMatch(/\bsent\b|sends/i);
  });
});
