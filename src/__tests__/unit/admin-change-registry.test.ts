import { describe, it, expect } from 'vitest';
import { ADMIN_CHANGE_ACTIONS, isKnownAdminChange, type AdminChangePair } from '@/lib/audit/admin-change-registry';
import type { AdminChangeLogRow } from '@/server/internal/admin-change-log';

/**
 * feature-plan-ux-people-codes.md §6.4: the registry lists every pair the code writes (§1.5 + R5); the writer's row type
 * comes from it (tsc rejects an unregistered pair — the @ts-expect-error lines fail `npx tsc` if the type widens); the
 * legacy pair is readable but not writable.
 */
describe('admin change registry', () => {
  it('lists the §1.5 pairs and the R5 user actions', () => {
    expect(ADMIN_CHANGE_ACTIONS.user).toEqual(['approver_changed', 'role_changed', 'deactivated', 'reactivated', 'flsa_changed', 'password_reset', 'mfa_reset', 'created']);
    expect(Object.keys(ADMIN_CHANGE_ACTIONS).sort()).toEqual(['charge_code', 'charge_code_labor_category', 'labor_category_rate', 'self_approval', 'user', 'workspace_settings']);
  });

  it('known pairs include the legacy one for readers; unknown ones are not known', () => {
    expect(isKnownAdminChange('charge_code', 'labor_category_changed')).toBe(true);
    expect(isKnownAdminChange('user', 'mfa_reset')).toBe(true);
    expect(isKnownAdminChange('user', 'teleported')).toBe(false);
    expect(isKnownAdminChange('spaceship', 'enabled')).toBe(false);
  });

  it('types: registered pairs compile; unregistered and legacy pairs do not', () => {
    const ok: AdminChangePair[] = [{ entity: 'user', action: 'mfa_reset' }, { entity: 'self_approval', action: Math.random() > 2 ? 'enabled' : 'disabled' }];
    // @ts-expect-error — not a user action
    const bad: AdminChangePair = { entity: 'user', action: 'rate_corrected' };
    // @ts-expect-error — legacy, read-only
    const legacy: AdminChangeLogRow = { actorId: 'a', entityId: 'b', entity: 'charge_code', action: 'labor_category_changed', oldValue: null, newValue: null };
    expect([ok.length, bad, legacy]).toBeTruthy();
  });
});
