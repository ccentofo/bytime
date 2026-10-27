import { describe, it, expect } from 'vitest';
import { Icons } from '@/components/ui/icons';
import { activeHref, isGroup, isSettingsPath, landingPath, mainNav, navLeaves, SETTINGS_BACK, SETTINGS_NAV, type NavEntry } from '@/components/shell/nav-config';

/**
 * feature-plan-ux-navigation-home.md §4.2 / T2: the menus by role, required icons, longest-prefix active matching on
 * segment boundaries, the Settings area and landing paths.
 */

const shape = (entries: NavEntry[]) => entries.map((e) => (isGroup(e) ? [e.label, e.children.map((c) => [c.label, c.href])] : [e.label, e.href]));

describe('nav-config (T2)', () => {
  it('admin main menu', () => {
    expect(shape(mainNav('admin'))).toEqual([
      ['Home', '/home'], ['My timesheet', '/timesheet'], ['Approvals', '/admin/approvals'],
      ['Contracts', [['Overview', '/admin/dashboard'], ['Contracts and CLINs', '/admin/contracts'], ['Charge codes', '/admin/charge-codes'], ['Indirect codes', '/admin/indirect-codes'], ['Labor categories', '/admin/labor-categories']]],
      ['People', [['Users', '/admin/users'], ['Assignments', '/admin/assignments']]],
      ['Reports', [['Downloads', '/admin/reports'], ['Payroll export', '/admin/payroll-export'], ['Audit trail', '/admin/audit-trail']]],
      ['Settings', '/settings/workspace'],
    ]);
  });

  it('supervisor and employee menus; /admin/setup is in no menu', () => {
    expect(shape(mainNav('supervisor'))).toEqual([
      ['Home', '/home'], ['My timesheet', '/timesheet'], ['Approvals', '/admin/approvals'],
      ['Reports', [['Downloads', '/admin/reports'], ['Audit trail', '/admin/audit-trail']]],
    ]);
    expect(shape(mainNav('employee'))).toEqual([['Timesheet', '/timesheet']]);
    for (const role of ['admin', 'supervisor', 'employee'] as const) {
      expect(navLeaves(mainNav(role)).map((l) => l.href)).not.toContain('/admin/setup');
    }
  });

  it('every top-level entry and Settings leaf has a registered icon (rail mode)', () => {
    for (const role of ['admin', 'supervisor', 'employee'] as const) {
      for (const e of mainNav(role)) expect(Icons[e.icon], e.label).toBeDefined();
    }
    for (const l of [...SETTINGS_NAV, SETTINGS_BACK('admin')]) expect(Icons[l.icon], l.label).toBeDefined();
    expect(SETTINGS_NAV.map((l) => [l.label, l.href])).toEqual([
      ['Workspace', '/settings/workspace'], ['Pay schedule', '/settings/pay-schedule'], ['Billing', '/settings/billing'],
      ['Integrations', '/settings/integrations'], ['API keys', '/settings/api-keys'], ['Data import', '/settings/import'],
      ['Timesheet history import', '/settings/migration'],
    ]);
  });

  it('activeHref: longest prefix on segment boundaries', () => {
    const admin = navLeaves(mainNav('admin'));
    expect(activeHref('/settings/integrations/gusto', SETTINGS_NAV)).toBe('/settings/integrations');
    expect(activeHref('/admin/payroll-export', admin)).toBe('/admin/payroll-export');
    expect(activeHref('/admin/users', admin)).toBe('/admin/users');
    expect(activeHref('/admin/users/42', admin)).toBe('/admin/users');
    expect(activeHref('/admin/users-x', admin)).toBeNull();
    expect(activeHref('/settings/billing', admin)).toBe('/settings/workspace'); // Settings matches all of /settings
    expect(activeHref('/admin/setup', admin)).toBeNull();
    expect(activeHref('/home', admin)).toBe('/home');
  });

  it('isSettingsPath, landingPath, SETTINGS_BACK', () => {
    expect(isSettingsPath('/settings')).toBe(true);
    expect(isSettingsPath('/settings/billing')).toBe(true);
    expect(isSettingsPath('/settingsx')).toBe(false);
    expect(isSettingsPath('/admin/settings')).toBe(false);
    expect(landingPath('admin')).toBe('/home');
    expect(landingPath('supervisor')).toBe('/home');
    expect(landingPath('employee')).toBe('/timesheet');
    expect(SETTINGS_BACK('admin')).toEqual({ label: 'Back to the app', href: '/home', icon: 'back' });
  });
});
