/**
 * The limits shared across instances through Upstash (feature-plan-upstash-rate-limiting.md §6.1, Q4). Report, API,
 * in-app export and cron limits stay in memory (`src/lib/rate-limit.ts`); the export download page's two limits are
 * shared (feature-plan-cloud-export.md §6.6). Every window must stay ≤ 12 h so every Upstash key expires well within 25
 * hours (a key lives at most its window plus one more).
 */
export const SHARED_LIMITS = {
  slugLookup:    { limit: 30, windowMs: 60_000 },     // signup check + workspace finder, one budget
  signup:        { limit: 8,  windowMs: 3_600_000 },  // start + resend, one budget
  signInFailure: { limit: 20, windowMs: 900_000 },    // Q2
  resetRequest:  { limit: 10, windowMs: 3_600_000 },  // Q3
  exportDownloadIp: { limit: 30, windowMs: 3_600_000 }, // the export download page, per IP, checked before any token lookup
  exportDownload:   { limit: 20, windowMs: 3_600_000 }, // per delivery, after the token is checked
} as const;

export type SharedLimit = keyof typeof SHARED_LIMITS;
