// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';

/**
 * Launch-blockers audit A4: on a successful lookup the apex finder navigates to the workspace URL the action returned
 * and shows NO error (a cross-origin server-action redirect used to reject the client promise → "Something went
 * wrong" on every success). A refusal shows the server's message.
 */

const h = vi.hoisted(() => ({ goToWorkspace: vi.fn(), assign: vi.fn() }));
vi.mock('@/server/actions/workspace-finder', () => ({ goToWorkspace: h.goToWorkspace }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { WorkspaceFinder } from '@/components/auth/WorkspaceFinder';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign: h.assign } });
});
beforeEach(() => {
  h.goToWorkspace.mockReset();
  h.assign.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function submit(slug: string): Promise<HTMLButtonElement> {
  await act(async () => { root.render(<MantineProvider><WorkspaceFinder target="/login" rootDomain="cadenzpoint.com" /></MantineProvider>); });
  await act(async () => { type(container.querySelector('input') as HTMLInputElement, slug); });
  await act(async () => { (container.querySelector('button[type="submit"]') as HTMLButtonElement).click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return container.querySelector('button[type="submit"]') as HTMLButtonElement;
}

describe('WorkspaceFinder', () => {
  it('ok → navigates to the returned workspace URL, shows no error, stays loading', async () => {
    h.goToWorkspace.mockResolvedValue({ ok: true, data: { url: 'https://acme.cadenzpoint.com/login' } });
    const button = await submit('acme');
    expect(h.goToWorkspace).toHaveBeenCalledWith('acme', '/login');
    expect(h.assign).toHaveBeenCalledWith('https://acme.cadenzpoint.com/login');
    expect(container.textContent).not.toMatch(/something went wrong/i);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(button.hasAttribute('data-loading')).toBe(true);
  });

  it('a refusal shows the server message and does not navigate', async () => {
    h.goToWorkspace.mockResolvedValue({ ok: false, code: 'not_found', error: 'No workspace with that name.' });
    const button = await submit('nobody');
    expect(h.assign).not.toHaveBeenCalled();
    expect(container.textContent).toContain('No workspace with that name.');
    expect(button.hasAttribute('data-loading')).toBe(false);
  });
});
