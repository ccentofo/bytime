/**
 * Single source of truth for badge colors across the app (roles, statuses, and the
 * category/location/sync dimensions). Use these instead of inline color strings or
 * per-file maps so a badge's color always matches its meaning everywhere (see the
 * UI consistency blueprint's semantic color table).
 */
export const ROLE_COLOR = {
  admin: 'signal',
  supervisor: 'warning',
  employee: 'gray',
} as const;

export const PERIOD_STATUS_COLOR = {
  draft: 'gray',
  submitted: 'signal',
  approved: 'success',
  rejected: 'red',
} as const;

export const RECORD_STATUS_COLOR = {
  active: 'success',
  inactive: 'gray',
  closed: 'gray',
} as const;

// The maps below are keyed by free-form strings at their call sites (DB values), so they're
// typed as Record<string, string>; callers fall back with `?? 'gray'` for unknown keys.

/** Indirect charge-code category. `irad` keeps `cyan` — a deliberate one-off outside the
 *  semantic palette so the six categories stay visually distinct instead of colliding on gray. */
export const INDIRECT_CATEGORY_COLOR: Record<string, string> = {
  overhead: 'signal',
  ga: 'gray',
  irad: 'cyan',
  bp: 'warning',
  leave: 'success',
  unallowable: 'red',
};

/** Charge-code work location. Not a status, so `telework` uses the neutral `ink` tone rather
 *  than a color that carries status meaning. */
export const WORK_LOCATION_COLOR: Record<string, string> = {
  onsite: 'signal',
  telework: 'ink',
  other: 'gray',
};

/** Integration sync run / connection status. */
export const SYNC_STATUS_COLOR: Record<string, string> = {
  success: 'success',
  partial: 'warning',
  failed: 'red',
  running: 'signal',
  pending: 'gray',
};
