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
    expect(safeNext('%2Ftimesheet%3Fperiod%3D2026-10-01')).toBe('/timesheet?period=2026-10-01'); // encoded once
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
