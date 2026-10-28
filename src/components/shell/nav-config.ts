import type { Icons } from '@/components/ui/icons';

/**
 * Navigation config (feature-plan-ux-navigation-home.md §4.2, UX-D3). Pure: menus by role, the Settings area's own
 * menu, longest-prefix active matching and the landing page. Labels are decoupled from URLs. Visibility is UX only —
 * every page guards itself.
 */

export type NavRole = 'admin' | 'supervisor' | 'employee';
/** `icon` is required: the collapsed rail shows icons only. `match` adds extra path prefixes that count as this leaf. */
export type NavLeaf = { label: string; href: string; icon: keyof typeof Icons; match?: string[] };
export type NavGroup = { key: string; label: string; icon: keyof typeof Icons; children: Omit<NavLeaf, 'icon'>[] };
export type NavEntry = NavLeaf | NavGroup;

export const isGroup = (e: NavEntry): e is NavGroup => 'children' in e;

const HOME: NavLeaf = { label: 'Home', href: '/home', icon: 'home' };
const MY_TIMESHEET: NavLeaf = { label: 'My timesheet', href: '/timesheet', icon: 'timeEntry' };
const APPROVALS: NavLeaf = { label: 'Approvals', href: '/admin/approvals', icon: 'approvals' };
const SETTINGS: NavLeaf = { label: 'Settings', href: '/settings/workspace', icon: 'settings', match: ['/settings'] };

const CONTRACTS_GROUP: NavGroup = {
  key: 'contracts', label: 'Contracts', icon: 'contracts', children: [
    { label: 'Overview', href: '/admin/dashboard' },
    { label: 'Contracts and CLINs', href: '/admin/contracts' },
    { label: 'Charge codes', href: '/admin/charge-codes' },
    { label: 'Indirect codes', href: '/admin/indirect-codes' },
    { label: 'Labor categories', href: '/admin/labor-categories' },
  ],
};
const PEOPLE_GROUP: NavGroup = {
  key: 'people', label: 'People', icon: 'users', children: [
    { label: 'Users', href: '/admin/users' },
    { label: 'Assignments', href: '/admin/assignments' },
  ],
};
const ADMIN_REPORTS_GROUP: NavGroup = {
  key: 'reports', label: 'Reports', icon: 'reports', children: [
    { label: 'Downloads', href: '/admin/reports' },
    { label: 'Payroll export', href: '/admin/payroll-export' },
    { label: 'Audit trail', href: '/admin/audit-trail' },
  ],
};
const SUPERVISOR_REPORTS_GROUP: NavGroup = {
  key: 'reports', label: 'Reports', icon: 'reports', children: [
    { label: 'Downloads', href: '/admin/reports' },
    { label: 'Audit trail', href: '/admin/audit-trail' },
  ],
};

/** The main menu by role. Admins end with Settings (rendered at the bottom). `/admin/setup` is in no menu. */
export function mainNav(role: NavRole): NavEntry[] {
  if (role === 'admin') return [HOME, MY_TIMESHEET, APPROVALS, CONTRACTS_GROUP, PEOPLE_GROUP, ADMIN_REPORTS_GROUP, SETTINGS];
  if (role === 'supervisor') return [HOME, MY_TIMESHEET, APPROVALS, SUPERVISOR_REPORTS_GROUP];
  // feature-plan-ux-timesheet-ui.md §4.11: approvers reach Past timesheets from the link on the timesheet.
  return [{ label: 'Timesheet', href: '/timesheet', icon: 'timeEntry' }, { label: 'Past timesheets', href: '/timesheet/history', icon: 'history' }];
}

/** The Settings area's own menu (admins only — every page guards with requirePageRole('admin')). */
export const SETTINGS_NAV: NavLeaf[] = [
  { label: 'Workspace', href: '/settings/workspace', icon: 'workspace' },
  { label: 'Pay schedule', href: '/settings/pay-schedule', icon: 'paySchedule' },
  { label: 'Billing', href: '/settings/billing', icon: 'billing' },
  { label: 'Integrations', href: '/settings/integrations', icon: 'integrations', match: ['/settings/integrations'] },
  { label: 'API keys', href: '/settings/api-keys', icon: 'apiKeys' },
  { label: 'Data import', href: '/settings/import', icon: 'dataImport' },
  { label: 'Timesheet history import', href: '/settings/migration', icon: 'historyImport' },
];

/** Where people land (UX-D3): admins and supervisors → Home; employees → Timesheet. The ONLY source. */
export function landingPath(role: NavRole): '/home' | '/timesheet' {
  return role === 'admin' || role === 'supervisor' ? '/home' : '/timesheet';
}

export const SETTINGS_BACK = (role: NavRole): NavLeaf => ({ label: 'Back to the app', href: landingPath(role), icon: 'back' });

/** True on a path segment boundary: `/a/b` covers `/a/b` and `/a/b/c`, never `/a/bc`. */
export function covers(prefix: string, pathname: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

/**
 * The href of the leaf whose href (or a `match` prefix) is the LONGEST segment-boundary prefix of `pathname`, or null.
 * So sub-pages highlight their section (`/settings/integrations/gusto` → Integrations).
 */
export function activeHref(pathname: string, leaves: { href: string; match?: string[] }[]): string | null {
  let best: { href: string; len: number } | null = null;
  for (const leaf of leaves) {
    for (const prefix of [leaf.href, ...(leaf.match ?? [])]) {
      if (covers(prefix, pathname) && (!best || prefix.length > best.len)) best = { href: leaf.href, len: prefix.length };
    }
  }
  return best?.href ?? null;
}

export function isSettingsPath(pathname: string): boolean {
  return covers('/settings', pathname);
}

/** Every leaf in a menu (group children included) — the candidate set for activeHref. */
export function navLeaves(entries: NavEntry[]): { href: string; match?: string[] }[] {
  return entries.flatMap((e) => (isGroup(e) ? e.children : [e]));
}

export function toNavRole(role: string | null | undefined): NavRole {
  return role === 'admin' || role === 'supervisor' ? role : 'employee';
}
