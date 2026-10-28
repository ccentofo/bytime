// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';

/**
 * feature-plan-ux-navigation-home.md §4.2 / T5: the user menu shows the name, email and role as a word, then
 * "Profile and security", "Notifications" (→ /profile/notifications) and "Sign out".
 */

vi.mock('next-auth/react', () => ({ signOut: vi.fn() }));

import { AppHeader } from '@/components/shell/AppHeader';
import { click, installDomStubs, mount, unmount, type Mounted } from '../helpers/dom';
import { expectNoAxeViolations } from '../helpers/axe';

beforeAll(installDomStubs);
let m: Mounted | undefined;
afterEach(() => { unmount(m); m = undefined; });

describe('user menu (T5)', () => {
  it('items and role word', async () => {
    m = await mount(<AppHeader user={{ fullName: 'Sarah Wilson', email: 'sarah@x', role: 'supervisor' }} />);
    const trigger = [...m.container.querySelectorAll('button')].find((b) => b.textContent?.includes('Sarah Wilson'))!;
    await click(trigger);
    const dropdown = document.body.querySelector('[role="menu"]')!;
    expect(dropdown.textContent).toContain('sarah@x');
    expect(dropdown.textContent).toContain('Supervisor');
    expect(dropdown.textContent).not.toContain('Role:');
    const items = [...document.body.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
    expect(items.map((i) => i.textContent)).toEqual(['Profile and security', 'Notifications', 'Sign out']);
    expect(items[0].getAttribute('href')).toBe('/profile');
    expect(items[1].getAttribute('href')).toBe('/profile/notifications');
    expect(items[2].className).toMatch(/danger/);
    await expectNoAxeViolations(document.body);
  });
});
