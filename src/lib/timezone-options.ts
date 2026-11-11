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

/**
 * A friendly name for an IANA zone (UX-4C2A-AUDIT.md S10, product owner 2026-11-11): the standard generic name built
 * into Intl, e.g. America/New_York → "Eastern Time". An unknown id (or no name) falls back to the id itself.
 */
export function timezoneLabel(tz: string): string {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longGeneric' }).formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value;
    return name || tz;
  } catch {
    return tz;   // not a zone Intl knows
  }
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
