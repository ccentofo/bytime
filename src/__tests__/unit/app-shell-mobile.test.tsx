// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';

/**
 * feature-plan-ux-navigation-home.md §4.2 / T4: the mobile menu. The Burger exposes aria-expanded; the layout doesn't
 * remount on client navigation, so AppShellWrapper closes the menu when the pathname changes (not on first render).
 */

const nav = vi.hoisted(() => ({ pathname: '/home' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('next-auth/react', () => ({ SessionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>, signOut: vi.fn() }));
vi.mock('@/components/shell/SyncStatusIndicator', () => ({ SyncStatusIndicator: () => null }));

import { AppShellWrapper } from '@/app/(app)/AppShellWrapper';
import { theme } from '@/theme';
import { installDomStubs } from '../helpers/dom';

beforeAll(installDomStubs);
let root: Root;
let container: HTMLDivElement;
afterEach(() => { act(() => root.unmount()); container.remove(); document.body.innerHTML = ''; });

const USER = { fullName: 'Ann Admin', email: 'a@x', role: 'admin' };
const tree = () => (
  <MantineProvider env="test" theme={theme}>
    <AppShellWrapper user={USER} waitingCount={null}><p>page</p></AppShellWrapper>
  </MantineProvider>
);
const burger = () => container.querySelector('button.mantine-Burger-root') as HTMLButtonElement;

describe('mobile menu (T4)', () => {
  it('aria-expanded flips on click; a pathname change closes it; the first render does not toggle', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(tree()); });
    expect(burger().getAttribute('aria-expanded')).toBe('false'); // first render: still closed
    expect(burger().getAttribute('aria-label')).toBe('Open navigation');

    await act(async () => { burger().click(); });
    expect(burger().getAttribute('aria-expanded')).toBe('true');
    expect(burger().getAttribute('aria-label')).toBe('Close navigation');

    nav.pathname = '/admin/users'; // client navigation: same layout instance, new pathname
    await act(async () => { root.render(tree()); });
    expect(burger().getAttribute('aria-expanded')).toBe('false');

    // A re-render on the SAME path leaves an open menu open.
    await act(async () => { burger().click(); });
    await act(async () => { root.render(tree()); });
    expect(burger().getAttribute('aria-expanded')).toBe('true');
  });
});
