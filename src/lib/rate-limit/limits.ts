/**
 * The limits shared across instances through Upstash (feature-plan-upstash-rate-limiting.md §6.1, Q4). Report, API,
 * export and cron limits stay in memory (`src/lib/rate-limit.ts`). Every window must stay ≤ 12 h so every Upstash key
 * expires well within 25 hours (a key lives at most its window plus one more).
 */
export const SHARED_LIMITS = {
  slugLookup:    { limit: 30, windowMs: 60_000 },     // signup check + workspace finder, one budget
  signup:        { limit: 8,  windowMs: 3_600_000 },  // start + resend, one budget
  signInFailure: { limit: 20, windowMs: 900_000 },    // Q2
  resetRequest:  { limit: 10, windowMs: 3_600_000 },  // Q3
} as const;

export type SharedLimit = keyof typeof SHARED_LIMITS;
