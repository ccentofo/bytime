import { describe, it, expect } from 'vitest';
import { safeNext } from '@/lib/safe-next';

/**
 * feature-plan-ux-timesheet.md A-T10 (A4.8, invariant A3.5 — no open redirect): only same-origin app paths on the
 * allowlist survive; structural checks run on the decoded input AND the path rebuilt by the URL parser.
 */

describe('safeNext', () => {
  it('accepts allowlisted app paths (with their query)', () => {
    expect(safeNext('/timesheet?period=2026-10-01')).toBe('/timesheet?period=2026-10-01');
    expect(safeNext('/admin/users')).toBe('/admin/users');
    expect(safeNext('/timesheet/history')).toBe('/timesheet/history');
    expect(safeNext('/timesheet')).toBe('/timesheet');
    expect(safeNext('/home')).toBe('/home');
    expect(safeNext('/settings/integrations/gusto')).toBe('/settings/integrations/gusto');
    expect(safeNext('/profile/notifications')).toBe('/profile/notifications');
  });

  it('M2: returns its input UNCHANGED (never a decoded rewrite) — encoded query characters keep their meaning', () => {
    for (const v of ['/admin/users?search=a%23b', '/admin/users?search=a%26b%3Dc', '/admin/users?q=a+b', '/timesheet?x=%25', '/admin/users?search=caf%C3%A9']) expect(safeNext(v)).toBe(v);
  });

  it.each([
    ['protocol-relative', '//x'],
    ['encoded protocol-relative', '%2F%2Fx'],
    ['backslash', '/\\x'],
    ['encoded backslash', '/%5Cx'],
    ['absolute URL', 'https://x'],
    ['javascript:', 'javascript:alert(1)'],
    ['the API', '/api/x'],
    ['sign-in itself', '/login'],
    ['signup', '/signup'],
    ['password reset', '/reset-password?token=x'],
    ['not on a segment boundary', '/timesheetx'],
    ['not on the allowlist', '/terms'],
    ['dot segments that normalise to //host', '/timesheet/..//evil.com'],
    ['encoded dot segments', '/timesheet/%2e%2e//x'],
    ['a single dot segment', '/timesheet/./x'],
    ['a tab', '/timesheet\t'],
    ['a newline', '/timesheet\n/x'],
    ['an encoded newline', '/timesheet%0A'],
    ['a bad escape', '/timesheet%E0%A4%A'],
    ['empty', ''],
    ['M2: double-encoded dot segments', '/timesheet/x/%252e%252e/%252e%252e/admin'],
    ['M2: a value the parser would rewrite (fragment)', '/timesheet#x'],
    ['M2: a value the parser would rewrite (unescaped space)', '/admin/users?search=a b'],
    ['M2: an encoded "?" in the path', '/timesheet%3Fperiod=1'],
    ['M2: an encoded "//" in the path', '/timesheet/%2F%2Fevil.com'],
    ['M2: a fully encoded path (not in its final form)', '%2Ftimesheet%3Fperiod%3D2026-10-01'],
  ])('rejects %s', (_label, value) => {
    expect(safeNext(value)).toBeNull();
  });

  it('rejects values over 512 characters, and non-strings', () => {
    expect(safeNext(`/timesheet?x=${'a'.repeat(500)}`)).toBeNull();
    expect(safeNext(`/timesheet?x=${'a'.repeat(498)}`)).not.toBeNull(); // exactly 512
    expect(safeNext(null)).toBeNull();
    expect(safeNext(['/timesheet'])).toBeNull();
  });
});
