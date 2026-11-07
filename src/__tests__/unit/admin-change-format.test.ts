import { describe, it, expect } from 'vitest';
import { ADMIN_CHANGE_TEXT, DESCRIBED_PAIRS, describeAdminChange } from '@/lib/audit/admin-change-format';
import { ADMIN_CHANGE_ACTIONS } from '@/lib/audit/admin-change-registry';

/**
 * feature-plan-ux-people-codes.md §6.4 / AU-7: describeAdminChange resolves an approverId inside new_value to a name; an
 * unknown id → "(deleted)"; a null id → "None" ("None (admins approve)" for an approver); the legacy
 * charge_code / labor_category_changed renders; an unknown pair (or malformed values) never throws; every registry pair
 * has its own words (tsc enforces it — this pins it at runtime too).
 */
const names = { 'u-pat': 'Pat Doe', 'u-ann': 'Ann Admin', 'cc-1': 'NAV-0001', 'lc-1': 'SE-II Software Engineer', 'clin-1': 'NAVAIR CLIN 0001' };
const row = (entity: string, action: string, entityId: string, oldValue: unknown, newValue: unknown) => ({ entity, action, entityId, oldValue, newValue });

describe('describeAdminChange (AU-7)', () => {
  it('an approverId inside the values → the name; a null one → "None (admins approve)"; an unknown id → "(deleted)"', () => {
    expect(describeAdminChange(row('user', 'approver_changed', 'u-pat', { approverId: null }, { approverId: 'u-ann' }), names))
      .toEqual({ change: 'Approver changed', details: 'Pat Doe · None (admins approve) → Ann Admin' });
    expect(describeAdminChange(row('user', 'approver_changed', 'u-gone', { approverId: 'u-x' }, { approverId: null }), names))
      .toEqual({ change: 'Approver changed', details: '(deleted) · (deleted) → None (admins approve)' });
  });

  it('the legacy labor_category_changed renders, with "None" for a null category', () => {
    expect(describeAdminChange(row('charge_code', 'labor_category_changed', 'cc-1', { laborCategoryId: null }, { laborCategoryId: 'lc-1' }), names))
      .toEqual({ change: 'Labor category changed', details: 'NAV-0001 · None → SE-II Software Engineer' });
  });

  it('R5 actions read in words (a promotion names the CLINs it approves on)', () => {
    expect(describeAdminChange(row('user', 'role_changed', 'u-pat', { role: 'employee' }, { role: 'supervisor', clinIds: ['clin-1'] }), names).details)
      .toBe('Pat Doe · Employee → Supervisor · approves on NAVAIR CLIN 0001');
    expect(describeAdminChange(row('user', 'mfa_reset', 'u-pat', null, null), names)).toEqual({ change: 'Two-step sign-in reset', details: 'Pat Doe' });
    expect(describeAdminChange(row('user', 'created', 'u-pat', null, { role: 'employee', flsaExempt: false }), names).details).toBe('Pat Doe · Employee · Non-exempt');
    expect(describeAdminChange(row('workspace_settings', 'workweek_start_day_changed', '0', { workweekStartDay: null }, { workweekStartDay: 1 }), names).details).toBe('Workspace · Not set → Monday');
    expect(describeAdminChange(row('labor_category_rate', 'rate_change_added', 'lc-1', { hourlyRate: '145.00' }, { effectiveDate: '2027-01-01', hourlyRate: '149.35', reason: 'Mod 3' }), names).details)
      .toBe('SE-II Software Engineer · $145.00 → $149.35 · from Jan 1, 2027 · “Mod 3”');
  });

  it('L7: self-approval rows show the recorded reason; none recorded → just the admin', () => {
    expect(describeAdminChange(row('self_approval', 'disabled', 'u-ann', { enabled: true }, { enabled: false, reason: 'Pat Doe added (admin)', activeAdminCount: 2 }), names))
      .toEqual({ change: 'Self-approval turned off', details: 'Ann Admin · Pat Doe added (admin)' });
    expect(describeAdminChange(row('self_approval', 'enabled', 'u-ann', { enabled: false }, { enabled: true, reason: 'Pat Doe deactivated' }), names))
      .toEqual({ change: 'Self-approval turned on', details: 'Ann Admin · Pat Doe deactivated' });
    expect(describeAdminChange(row('self_approval', 'enabled', 'u-ann', { enabled: false }, { enabled: true }), names))
      .toEqual({ change: 'Self-approval turned on', details: 'Ann Admin' });
  });

  it('an unknown pair, or values of the wrong shape, never throw', () => {
    expect(describeAdminChange(row('spaceship', 'warp_engaged', 'x', 7, 'nope'), names)).toEqual({ change: 'Warp engaged', details: 'spaceship' });
    expect(describeAdminChange(row('user', 'teleported', 'u-pat', null, null), names)).toEqual({ change: 'Teleported', details: 'Pat Doe' });
    expect(() => describeAdminChange(row('user', 'role_changed', 'u-pat', 'garbage', 42), names)).not.toThrow();
    expect(describeAdminChange(row('user', 'approver_changed', 'u-pat', null, null), names).details).toBe('Pat Doe · None (admins approve) → None (admins approve)');
    expect(() => describeAdminChange(row('labor_category_rate', 'rate_corrected', 'lc-1', null, null), names)).not.toThrow();
    expect(describeAdminChange(row('user', 'toString', 'u-pat', null, null), names).change).toBe('ToString');
  });

  it('every registry pair (and the legacy one) has its own words, not the fallback', () => {
    expect(DESCRIBED_PAIRS.length).toBe(Object.values(ADMIN_CHANGE_ACTIONS).flat().length + 1);
    for (const [entity, action] of DESCRIBED_PAIRS) {
      expect(typeof (ADMIN_CHANGE_TEXT as Record<string, Record<string, unknown>>)[entity]?.[action], `${entity}/${action}`).toBe('function');
    }
  });
});
