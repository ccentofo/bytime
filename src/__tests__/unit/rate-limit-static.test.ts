import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { SHARED_LIMITS } from '@/lib/rate-limit/limits';

/**
 * feature-plan-upstash-rate-limiting.md static checks over file content only (no git: CI checks out depth 1):
 * T4 (every Upstash key expires within 25 h), T13 (the moved callers await the shared store), T14 (the memory limits
 * are untouched), and the static half of T21 (no IP reaches login_attempts).
 */

const ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const count = (src: string, needle: string) => src.split(needle).length - 1;

describe('FR7: the shared limits are exactly the approved numbers (Q2, Q3, Q4)', () => {
  it('SHARED_LIMITS', () => {
    expect(SHARED_LIMITS).toEqual({
      slugLookup: { limit: 30, windowMs: 60_000 },
      signup: { limit: 8, windowMs: 3_600_000 },
      signInFailure: { limit: 20, windowMs: 900_000 },
      resetRequest: { limit: 10, windowMs: 3_600_000 },
      // feature-plan-cloud-export.md §6.6 (T23): the export download page.
      exportDownloadIp: { limit: 30, windowMs: 3_600_000 },
      exportDownload: { limit: 20, windowMs: 3_600_000 },
    });
  });
});

describe('FR2: the Credentials provider passes the client IP to authorizeCredentials', () => {
  it('src/auth.ts wires authorize with getClientIp(request)', () => {
    // Without the ip argument every sign-in would share the one ip:unknown budget.
    expect(read('src/auth.ts')).toContain('authorize: (credentials, request) => authorizeCredentials(credentials, getClientIp(request))');
  });
});

describe('FR4: the reset limit runs before any database work', () => {
  it("in requestPasswordReset, consume('resetRequest' comes before getDbForAuth(", () => {
    const src = read('src/server/actions/password-reset.ts');
    const start = src.indexOf('export async function requestPasswordReset(');
    const end = src.indexOf('export async function', start + 1);
    const body = src.slice(start, end === -1 ? undefined : end);
    const gate = body.indexOf("consume('resetRequest'");
    const db = body.indexOf('getDbForAuth(');
    expect(start).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(db).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(db);
  });
});

describe('T4: every shared window keeps keys well within 25 hours', () => {
  it('each windowMs ≤ 12 h; the longest is 1 h', () => {
    const windows = Object.values(SHARED_LIMITS).map((l) => l.windowMs);
    for (const w of windows) expect(w).toBeLessThanOrEqual(12 * 3_600_000);
    expect(Math.max(...windows)).toBe(3_600_000);
  });
});

describe('T13: the moved callers await the shared store', () => {
  const route = read('src/app/signup/check/route.ts');
  const finder = read('src/server/actions/workspace-finder.ts');
  const signup = read('src/server/actions/signup.ts');

  it('await checkSlugLookupRateLimit( ×2 (signup check + workspace finder)', () => {
    expect(count(route, 'await checkSlugLookupRateLimit(') + count(finder, 'await checkSlugLookupRateLimit(')).toBe(2);
    expect(count(route, 'checkSlugLookupRateLimit(ip)')).toBe(count(route, 'await checkSlugLookupRateLimit(ip)'));
  });

  it("await consume('signup' ×2 (start + resend)", () => {
    expect(count(signup, "await consume('signup'")).toBe(2);
    expect(count(signup, "consume('signup'")).toBe(2);
  });

  it('none of those files calls the memory limiter', () => {
    for (const src of [route, finder, signup]) expect(src).not.toMatch(/\bcheckRateLimit\(/);
  });
});

describe('T14: the memory limits are untouched (Q4)', () => {
  const REPORT_ROUTES = ['timesheet-pdf', 'period-cost-xlsx', 'cost-report-csv', 'audit-csv', 'cost-report-xlsx', 'unpriced-xlsx']
    .map((r) => `src/app/api/reports/${r}/route.ts`);
  const files: Array<[string, string]> = [
    ...REPORT_ROUTES.map((f) => [f, 'checkReportRateLimit('] as [string, string]),
    ['src/lib/api-auth.ts', 'checkRateLimit('],
    ['src/app/api/export/workspace/route.ts', 'checkRateLimit('],
    ['src/lib/cron-auth.ts', 'checkCronRateLimit('],
  ];

  it.each(files)('%s still calls %s and never the shared store', (file, call) => {
    const src = read(file);
    expect(src).toContain(call);
    expect(src).not.toContain('@/lib/rate-limit/store');
    expect(src).not.toMatch(/\bconsume\(/);
  });

  it('the report and cron presets keep their numbers', () => {
    const rl = read('src/lib/rate-limit.ts');
    expect(rl).toContain('checkRateLimit(`report:${ip}`, 10, ONE_MINUTE)');
    expect(rl).toContain('checkRateLimit(`cron:${ip}`, 2, ONE_MINUTE)');
  });
});

describe('T21 (static): no IP reaches login_attempts', () => {
  it('login-attempts.ts has no ipAddress parameter or insert key', () => {
    expect(read('src/server/internal/login-attempts.ts')).not.toMatch(/ipAddress/);
  });

  it('the schema carries the login_attempts_no_raw_ip check, and the migration adds only it', () => {
    expect(read('src/db/schema.ts')).toContain("check('login_attempts_no_raw_ip', sql`${table.ipAddress} IS NULL`)");
    const journal = JSON.parse(read('drizzle/meta/_journal.json')) as { entries: Array<{ tag: string }> };
    const tag = journal.entries.find((e) => e.tag.startsWith('0019_'))!.tag;
    expect(read(`drizzle/${tag}.sql`).trim()).toBe(
      'ALTER TABLE "login_attempts" ADD CONSTRAINT "login_attempts_no_raw_ip" CHECK ("login_attempts"."ip_address" IS NULL);',
    );
  });
});
