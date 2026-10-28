// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { act } from 'react';
import path from 'path';

/**
 * feature-plan-ux-navigation-home.md §4.2 / T3: the sidebar. Group headers are real buttons (no NavLink children —
 * Space would toggle twice) with aria-expanded / aria-controls; the active group is forced open; active leaves carry
 * aria-current; the waiting count is announced; Settings mode; the collapsed rail (flyouts, icons, indicator label).
 */

const nav = vi.hoisted(() => ({ pathname: '/timesheet' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

import { AppNavbar, NAV_GROUPS_KEY } from '@/components/shell/AppNavbar';
import { click, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';
import { expectNoAxeViolations } from '../helpers/axe';
import { stripComments } from '../helpers/source-scanner';

beforeAll(installDomStubs);
let m: Mounted | undefined;
beforeEach(() => { nav.pathname = '/timesheet'; window.localStorage.clear(); });
afterEach(() => { unmount(m); m = undefined; });

const render = async (props: { userRole?: string; collapsed?: boolean; waitingCount?: number | null }) => {
  m = await mount(<AppNavbar userRole="admin" {...props} />);
  await wait(10);
};
const groupButton = (label: string) => [...m!.container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
const link = (text: string) => [...m!.container.querySelectorAll('a')].find((a) => a.textContent?.startsWith(text)) as HTMLAnchorElement | undefined;

describe('AppNavbar — expanded (T3)', () => {
  it('group header: a childless <button> with aria-expanded/aria-controls; one click toggles once; aria-controls → the sibling Collapse', async () => {
    await render({});
    const header = groupButton('People');
    expect(header.tagName).toBe('BUTTON');
    expect(header.getAttribute('type')).toBe('button');
    expect(header.querySelector('a')).toBeNull();
    expect(header.getAttribute('aria-expanded')).toBe('false');
    const controlled = document.getElementById(header.getAttribute('aria-controls')!)!;
    expect(controlled).not.toBeNull();
    expect(controlled.contains(header)).toBe(false);
    expect(controlled.textContent).toContain('Users');
    await click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(JSON.parse(window.localStorage.getItem(NAV_GROUPS_KEY)!)).toEqual({ people: true });
    await click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
  });

  it('the group holding the current page is open and its toggle does nothing; the active leaf has aria-current="page"', async () => {
    nav.pathname = '/admin/charge-codes';
    await render({});
    const header = groupButton('Contracts');
    expect(header.getAttribute('aria-expanded')).toBe('true');
    await click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(window.localStorage.getItem(NAV_GROUPS_KEY)).toBeNull(); // no store change
    expect(link('Charge codes')!.getAttribute('aria-current')).toBe('page');
    expect(link('Contracts and CLINs')!.getAttribute('aria-current')).toBeNull();
  });

  it('a stored open group is restored after mount', async () => {
    window.localStorage.setItem(NAV_GROUPS_KEY, JSON.stringify({ reports: true }));
    await render({});
    expect(groupButton('Reports').getAttribute('aria-expanded')).toBe('true');
  });

  it('leaves have no aria-label in expanded mode; Approvals text includes "3 waiting"; no badge when 0', async () => {
    await render({ waitingCount: 3 });
    for (const a of m!.container.querySelectorAll('a')) expect(a.getAttribute('aria-label'), a.textContent ?? '').toBeNull();
    expect(link('Approvals')!.textContent).toContain('3 waiting');
    // L9: the visible badge is hidden from assistive tech (the announced text carries the count).
    const badge = link('Approvals')!.querySelector('.mantine-Badge-root')!;
    expect(badge.textContent).toBe('3');
    expect(badge.getAttribute('aria-hidden')).toBe('true');
    unmount(m);
    await render({ waitingCount: 0 });
    expect(link('Approvals')!.textContent).toBe('Approvals');
    unmount(m);
    await render({ waitingCount: null });
    expect(link('Approvals')!.textContent).toBe('Approvals');
  });

  it('Settings path: back link + the Settings menu, a "Settings" label that is not a heading', async () => {
    nav.pathname = '/settings/integrations/quickbooks';
    await render({});
    expect(link('Back to the app')!.getAttribute('href')).toBe('/home');
    expect([...m!.container.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Back to the app', 'Workspace', 'Pay schedule', 'Billing', 'Integrations', 'API keys', 'Data import', 'Timesheet history import']);
    expect(link('Integrations')!.getAttribute('aria-current')).toBe('page');
    expect(m!.container.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
    expect(m!.container.textContent).toContain('Settings');
  });

  it('employee: Timesheet and Past timesheets', async () => {
    m = await mount(<AppNavbar userRole="employee" />);
    expect([...m.container.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Timesheet', 'Past timesheets']);
  });

  it('axe clean (expanded, admin, a group open)', async () => {
    nav.pathname = '/admin/users';
    await render({ waitingCount: 2 });
    await expectNoAxeViolations(document.body);
  });
});

describe('AppNavbar — collapsed rail (T3)', () => {
  it('groups are flyout triggers listing their children; the trigger is marked active for a child route', async () => {
    nav.pathname = '/admin/assignments';
    await render({ collapsed: true });
    const people = m!.container.querySelector('button[aria-label="People"]') as HTMLButtonElement;
    expect(people.getAttribute('data-active')).toBe('true');
    expect(m!.container.querySelector('button[aria-label="Contracts"]')!.getAttribute('data-active')).toBeNull();
    await click(people);
    await wait(20);
    const items = [...document.body.querySelectorAll('[role="menuitem"]')] as HTMLAnchorElement[];
    expect(items.map((i) => i.textContent)).toEqual(['Users', 'Assignments']);
    expect(items[1].getAttribute('aria-current')).toBe('page');
    expect(items[1].getAttribute('href')).toBe('/admin/assignments');
    await expectNoAxeViolations(document.body);
  });

  it('M1: every rail group trigger shows its name in a tooltip on focus; the menu ARIA stays on the button; axe clean', async () => {
    await render({ collapsed: true });
    for (const label of ['Contracts', 'People', 'Reports']) {
      const trigger = m!.container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
      expect(trigger.getAttribute('aria-haspopup'), label).toBe('menu');
      expect(trigger.getAttribute('aria-expanded'), label).toBe('false');
      await act(async () => { trigger.focus(); });
      await wait(300);
      const tip = [...document.body.querySelectorAll('[role="tooltip"]')].find((t) => t.textContent === label);
      expect(tip, label).toBeDefined();
      await expectNoAxeViolations(document.body);
      await act(async () => { trigger.blur(); });
      await wait(150);
    }
  });

  it('leaves are icons with an aria-label; Approvals is labelled "Approvals, 3 waiting"', async () => {
    await render({ collapsed: true, waitingCount: 3 });
    const approvals = m!.container.querySelector('a[href="/admin/approvals"]')!;
    expect(approvals.getAttribute('aria-label')).toBe('Approvals, 3 waiting');
    expect(approvals.querySelector('svg')).not.toBeNull();
    expect(m!.container.querySelector('a[href="/home"]')!.getAttribute('aria-label')).toBe('Home');
  });

  it('Settings mode in the rail: the back link and every Settings leaf render with icons and names', async () => {
    nav.pathname = '/settings/billing';
    await render({ collapsed: true });
    const links = [...m!.container.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('aria-label'))).toEqual(['Back to the app', 'Workspace', 'Pay schedule', 'Billing', 'Integrations', 'API keys', 'Data import', 'Timesheet history import']);
    for (const a of links) expect(a.querySelector('svg'), a.getAttribute('aria-label') ?? '').not.toBeNull();
  });
});

describe('AppNavbar — static (T3)', () => {
  it('localStorage is read only inside useEffect and written only in the toggle handler', () => {
    const src = stripComments(readFileSync(path.resolve(__dirname, '../../components/shell/AppNavbar.tsx'), 'utf8'));
    const reads = [...src.matchAll(/localStorage\.getItem/g)].map((x) => x.index!);
    const writes = [...src.matchAll(/localStorage\.setItem/g)].map((x) => x.index!);
    expect(reads).toHaveLength(1);
    expect(writes).toHaveLength(1);
    const effect = src.indexOf('useEffect(() => {');
    expect(reads[0]).toBeGreaterThan(effect);
    expect(reads[0]).toBeLessThan(src.indexOf('}, []);', effect));
    const toggle = src.indexOf('function toggleGroup(');
    expect(writes[0]).toBeGreaterThan(toggle);
    expect(src).not.toMatch(/useState[^;]*localStorage/);
  });
});
