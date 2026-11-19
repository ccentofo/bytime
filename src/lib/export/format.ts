/**
 * Shared formatting for the export notice and the download page (feature-plan-cloud-export.md §6.5, §6.6). No imports:
 * safe for any runtime.
 */

/** "November 25, 2026 at 3:04 PM CST": a date and time in the given IANA zone. */
export function fmtDateTime(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(d);
}

/** "812 KB", "12.3 MB", "1.4 GB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** The download page's one text for every link that doesn't work (expired, revoked, erased, on hold, unknown: no oracle). */
export const EXPIRED_TEXT = 'This link has expired. Ask support@cadenzpoint.com for a new one.';
