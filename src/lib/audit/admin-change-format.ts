import { ADMIN_CHANGE_ACTIONS, LEGACY_ADMIN_CHANGE_ACTIONS, type AdminChangeEntity, type AdminChangeReadAction } from './admin-change-registry';
import { formatCalendarDate, isCalendarDate } from '@/lib/calendar-date';
import { formatCurrency } from '@/lib/format';

/**
 * Words for an admin_change_log row on the Audit trail's Admin changes tab (feature-plan-ux-people-codes.md §6.4).
 * `describeAdminChange` is a Record over the registry — every writable pair AND the legacy read-only pair — so tsc
 * enforces that each has text; a pair the registry doesn't know (DB values are strings) falls back to a humanized
 * action and never throws. Ids are resolved through `names` (built on the server): a missing one reads "(deleted)", a
 * null one "None". Client-safe.
 */

export interface AdminChangeRow {
  entity: string;
  action: string;
  entityId: string;
  oldValue: unknown;
  newValue: unknown;
}
/** id → display name (users, charge codes, labor categories "{code} {title}", CLINs). */
export type AdminChangeNames = Record<string, string>;
export interface AdminChangeText { change: string; details: string }

type Describe = (row: AdminChangeRow, names: AdminChangeNames) => AdminChangeText;
type Table = { [E in AdminChangeEntity]: Record<AdminChangeReadAction<E>, Describe> };

const ENTITY_NAMES: Record<string, string> = {
  self_approval: 'Self-approval', charge_code: 'Charge code', workspace_settings: 'Workspace', charge_code_labor_category: 'Charge code',
  user: 'User', labor_category_rate: 'Labor category',
};
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ROLE: Record<string, string> = { admin: 'Admin', supervisor: 'Supervisor', employee: 'Employee' };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});
/** An id → its name; null / absent → "None" (or `none`); an id we can't find → "(deleted)". */
const nameOf = (names: AdminChangeNames, id: unknown, none = 'None') =>
  (id === null || id === undefined ? none : typeof id === 'string' ? names[id] ?? '(deleted)' : '(deleted)');
const subject = (row: AdminChangeRow, names: AdminChangeNames) => nameOf(names, row.entityId);
const date = (v: unknown) => (isCalendarDate(v) ? formatCalendarDate(v, 'MMM D, YYYY') : null);
const money = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? formatCurrency(String(v)) : null);
const reason = (v: unknown) => (typeof obj(v).reason === 'string' && obj(v).reason ? ` · “${obj(v).reason as string}”` : '');
const join = (...parts: Array<string | null | false | undefined>) => parts.filter(Boolean).join(' · ');

const categoryChange = (verb: string): Describe => (row, names) => {
  const o = obj(row.oldValue), n = obj(row.newValue);
  const from = date(n.effectiveDate);
  return {
    change: `Labor category ${verb}`,
    details: join(subject(row, names), `${nameOf(names, o.laborCategoryId)} → ${nameOf(names, n.laborCategoryId)}`, from && `from ${from}`) + reason(n),
  };
};
const rateChange = (verb: string): Describe => (row, names) => {
  const o = obj(row.oldValue), n = obj(row.newValue);
  const from = date(n.effectiveDate ?? o.effectiveDate);
  const rates = money(o.hourlyRate) && money(n.hourlyRate) ? `${money(o.hourlyRate)} → ${money(n.hourlyRate)}` : money(n.hourlyRate) ?? money(o.hourlyRate);
  return { change: `Rate ${verb}`, details: join(subject(row, names), rates, from && `from ${from}`) + reason(n) };
};
const simple = (change: string): Describe => (row, names) => ({ change, details: subject(row, names) });

export const ADMIN_CHANGE_TEXT: Table = {
  self_approval: {
    enabled: simple('Self-approval turned on'),
    disabled: simple('Self-approval turned off'),
  },
  charge_code: {
    deactivated: simple('Charge code deactivated'),
    reactivated: simple('Charge code reactivated'),
    // Legacy (before dated categories): old / new laborCategoryId on the code itself.
    labor_category_changed: (row, names) => ({
      change: 'Labor category changed',
      details: join(subject(row, names), `${nameOf(names, obj(row.oldValue).laborCategoryId)} → ${nameOf(names, obj(row.newValue).laborCategoryId)}`),
    }),
  },
  workspace_settings: {
    workweek_start_day_changed: (row) => {
      const day = (v: unknown) => (typeof v === 'number' && DAYS[v] ? DAYS[v] : 'Not set');
      return { change: 'Workweek start day changed', details: join('Workspace', `${day(obj(row.oldValue).workweekStartDay)} → ${day(obj(row.newValue).workweekStartDay)}`) };
    },
  },
  charge_code_labor_category: {
    category_change_added: categoryChange('change added'),
    category_corrected: categoryChange('corrected'),
    category_change_removed: categoryChange('change removed'),
  },
  user: {
    approver_changed: (row, names) => ({
      change: 'Approver changed',
      details: join(subject(row, names), `${nameOf(names, obj(row.oldValue).approverId, 'None (admins approve)')} → ${nameOf(names, obj(row.newValue).approverId, 'None (admins approve)')}`),
    }),
    role_changed: (row, names) => {
      const clinIds = obj(row.newValue).clinIds;
      const clins = Array.isArray(clinIds) && clinIds.length > 0 ? `approves on ${clinIds.map((id) => nameOf(names, id)).join(', ')}` : null;
      return { change: 'Role changed', details: join(subject(row, names), `${ROLE[String(obj(row.oldValue).role)] ?? 'Unknown'} → ${ROLE[String(obj(row.newValue).role)] ?? 'Unknown'}`, clins) };
    },
    deactivated: simple('User deactivated'),
    reactivated: simple('User reactivated'),
    flsa_changed: (row, names) => {
      const word = (v: unknown) => (v === true ? 'Exempt' : v === false ? 'Non-exempt' : 'Unknown');
      return { change: 'Overtime status changed', details: join(subject(row, names), `${word(obj(row.oldValue).flsaExempt)} → ${word(obj(row.newValue).flsaExempt)}`) };
    },
    password_reset: simple('Password reset'),
    mfa_reset: simple('Two-step sign-in reset'),
    created: (row, names) => {
      const n = obj(row.newValue);
      return { change: 'User added', details: join(subject(row, names), ROLE[String(n.role)], n.flsaExempt === true ? 'Exempt' : n.flsaExempt === false ? 'Non-exempt' : null) };
    },
  },
  labor_category_rate: {
    rate_change_added: rateChange('change added'),
    rate_corrected: rateChange('corrected'),
    rate_change_removed: rateChange('change removed'),
  },
};

const humanize = (action: string) => {
  const words = action.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Change';
};

/** The row's words; an unknown (entity, action) — from a newer or older version — never throws. */
export function describeAdminChange(row: AdminChangeRow, names: AdminChangeNames): AdminChangeText {
  const byAction = (ADMIN_CHANGE_TEXT as Record<string, Record<string, Describe> | undefined>)[row.entity];
  const describe = byAction && Object.prototype.hasOwnProperty.call(byAction, row.action) ? byAction[row.action] : undefined;
  // The describers read old / new values defensively (any JSON shape), so a known pair never throws either.
  if (describe) return describe(row, names);
  return { change: humanize(row.action), details: names[row.entityId] ?? ENTITY_NAMES[row.entity] ?? row.entity };
}

/** Every pair the formatter covers (for tests): the registry plus the legacy pairs. */
export const DESCRIBED_PAIRS: Array<[string, string]> = [
  ...Object.entries(ADMIN_CHANGE_ACTIONS).flatMap(([e, actions]) => (actions as readonly string[]).map((a): [string, string] => [e, a])),
  ...Object.entries(LEGACY_ADMIN_CHANGE_ACTIONS).flatMap(([e, actions]) => (actions as readonly string[]).map((a): [string, string] => [e, a])),
];
