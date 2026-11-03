// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { act } from 'react';

/**
 * feature-plan-ux-page-fixes.md C12 / T-C12: the one-time API key Modal can't be dismissed by Esc, the overlay or a ✕
 * (the key would be lost); "Copy key" is a labelled Button that reads "Copied" after a click; "I've copied the key" is
 * the only way out.
 */

vi.mock('@/server/actions/api-keys', () => ({
  createApiKey: vi.fn(async () => ({ ok: true, data: { key: 'cp_live_secret123' } })),
  revokeApiKey: vi.fn(), deleteApiKey: vi.fn(),
  getApiKeys: vi.fn(async () => []),
}));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { ApiKeysClient } from '@/app/(app)/settings/api-keys/ApiKeysClient';
import { buttonByText, click, dialogTitled, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';

beforeAll(installDomStubs);
let m: Mounted | undefined;
afterEach(() => { unmount(m); m = undefined; vi.unstubAllGlobals(); });

async function createKey() {
  m = await mount(<ApiKeysClient initialKeys={[]} workspaceTimezone="America/New_York" />);
  await click(buttonByText('Create API Key'));
  const name = [...document.body.querySelectorAll('label')].find((l) => l.textContent?.replace(/\s*\*\s*$/, '').trim() === 'Name')!;
  const input = document.getElementById(name.htmlFor) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'QBO');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click(buttonByText('Generate Key'));
  await wait();
  return dialogTitled('Copy your API key')!;
}

describe('API key Modal (C12, T-C12)', () => {
  it('Esc and an overlay click don\'t close it, and it has no ✕', async () => {
    const dialog = await createKey();
    expect(dialog.textContent).toContain('cp_live_secret123');
    expect(dialog.querySelector('.mantine-Modal-close')).toBeNull();
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await wait();
    expect(dialogTitled('Copy your API key')).toBeDefined();
    const overlay = document.body.querySelector('.mantine-Modal-overlay');
    if (overlay) await click(overlay);
    expect(dialogTitled('Copy your API key')).toBeDefined();
  });

  it('"Copy key" is a labelled Button that turns into "Copied"; "I\'ve copied the key" closes', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const dialog = await createKey();
    const copy = [...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Copy key')!;
    expect(copy).toBeDefined();
    await click(copy);
    await wait();
    expect(writeText).toHaveBeenCalledWith('cp_live_secret123');
    expect([...dialog.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Copied')).toBe(true);
    await click([...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === "I've copied the key"));
    await wait(300);
    expect(dialogTitled('Copy your API key')).toBeUndefined();
  });
});
