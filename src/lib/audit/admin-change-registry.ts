/**
 * Every (entity, action) pair `admin_change_log` can hold (feature-plan-ux-people-codes.md §6.4), as ONE typed registry:
 * `AdminChangeLogRow` (the sole writer's input) is typed from it, so a writer can't log an unregistered pair, and the
 * Audit trail's formatter is a Record over it, so tsc enforces that every pair has text. Client-safe.
 */
export const ADMIN_CHANGE_ACTIONS = {
  /** Computed by recomputeSelfApproval; entity_id = the admin. */
  self_approval: ['enabled', 'disabled'],
  charge_code: ['deactivated', 'reactivated'],
  workspace_settings: ['workweek_start_day_changed'],
  /** entity_id = the charge code. */
  charge_code_labor_category: ['category_change_added', 'category_corrected', 'category_change_removed'],
  /** entity_id = the user. R5: role, active state, overtime status, credentials and creation are logged too. */
  user: ['approver_changed', 'role_changed', 'deactivated', 'reactivated', 'flsa_changed', 'password_reset', 'mfa_reset', 'created'],
  /** entity_id = the labor category. */
  labor_category_rate: ['rate_change_added', 'rate_corrected', 'rate_change_removed'],
} as const;

/**
 * Pairs that only exist in old tenants' data and are never written again: `charge_code` / `labor_category_changed`
 * was written by updateChargeCode before dated categories (commit f8f52e3). Readers format them; writers can't log them.
 */
export const LEGACY_ADMIN_CHANGE_ACTIONS = {
  charge_code: ['labor_category_changed'],
} as const;

export type AdminChangeEntity = keyof typeof ADMIN_CHANGE_ACTIONS;
export type AdminChangeAction<E extends AdminChangeEntity> = (typeof ADMIN_CHANGE_ACTIONS)[E][number];
type LegacyEntity = keyof typeof LEGACY_ADMIN_CHANGE_ACTIONS;
/** What a reader may meet: the writable pairs plus the legacy ones. */
export type AdminChangeReadAction<E extends AdminChangeEntity> =
  | AdminChangeAction<E>
  | (E extends LegacyEntity ? (typeof LEGACY_ADMIN_CHANGE_ACTIONS)[E][number] : never);

/** A writable pair: `{ entity: 'user'; action: 'approver_changed' | … }` for each entity. */
export type AdminChangePair = { [E in AdminChangeEntity]: { entity: E; action: AdminChangeAction<E> } }[AdminChangeEntity];

/** Runtime check for values read back from the database (they are plain strings there). */
export function isKnownAdminChange(entity: string, action: string): boolean {
  const known = (ADMIN_CHANGE_ACTIONS as Record<string, readonly string[]>)[entity] ?? [];
  const legacy = (LEGACY_ADMIN_CHANGE_ACTIONS as Record<string, readonly string[]>)[entity] ?? [];
  return known.includes(action) || legacy.includes(action);
}
