/** The browser's IANA zone list (empty where Intl.supportedValuesOf isn't available). Client-safe. */
const BROWSER_TIMEZONES: string[] = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];

/**
 * Select options for a time zone, always including `current`: browsers disagree on names (e.g. Asia/Calcutta vs
 * Asia/Kolkata) and some omit UTC, and a Select whose value isn't among its options renders blank.
 */
export function timezoneOptions(current: string | null): Array<{ value: string; label: string }> {
  const zones = current && !BROWSER_TIMEZONES.includes(current) ? [current, ...BROWSER_TIMEZONES] : BROWSER_TIMEZONES;
  return zones.map((tz) => ({ value: tz, label: tz }));
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
