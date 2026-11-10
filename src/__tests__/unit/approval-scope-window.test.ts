import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * APPROVAL-SCOPE-AUDIT.md L3: the window check's `--since` must be ISO 8601 (a date, or a date-time with a zone); a
 * tenant's failure prints the driver's cause (not only Drizzle's "Failed query: …"), redacted; and the caveat about
 * post-deploy charge-code grants is printed before the tenants.
 */
vi.mock('server-only', () => ({}));
import { WINDOW_CAVEAT, parseWindowSince, windowErrorDetail } from '@/server/internal/approval-scope-window';

describe('the window check script (L3)', () => {
  it('--since: ISO dates and zoned date-times pass; anything else is refused', () => {
    expect(parseWindowSince('2026-11-12T14:05:00Z')).toEqual({ since: new Date('2026-11-12T14:05:00Z') });
    expect(parseWindowSince('2026-11-12T09:05:00.250-05:00')).toEqual({ since: new Date('2026-11-12T14:05:00.250Z') });
    expect(parseWindowSince('2026-11-12')).toEqual({ since: new Date('2026-11-12T00:00:00Z') });
    for (const bad of ['11/12/2026', 'yesterday', '2026-11-12 14:05', '2026-11-12T14:05:00', '1731420300000', '2026-13-40']) {
      expect(parseWindowSince(bad), bad).toEqual({ error: expect.stringContaining("isn't an ISO 8601 date") });
    }
    expect(parseWindowSince(undefined)).toEqual({ error: expect.stringContaining('--since is required') });
  });

  it('a tenant error shows the cause, redacted; without a cause, the message', () => {
    const wrapped = Object.assign(new Error('Failed query: select … params: x'), { cause: new Error('password authentication failed at postgres://u:secret@db.example/acme') });
    expect(windowErrorDetail(wrapped)).toBe('password authentication failed at [redacted-connection-string]');
    expect(windowErrorDetail(new Error('connect ECONNREFUSED'))).toBe('connect ECONNREFUSED');
    expect(windowErrorDetail('boom')).toBe('boom');
  });

  it('the script prints the caveat and uses the helpers', () => {
    expect(WINDOW_CAVEAT).toMatch(/right after the deploy/);
    expect(WINDOW_CAVEAT).toMatch(/charge code after the deploy/);
    const src = readFileSync(path.resolve(__dirname, '../../../scripts/check-approval-scope-window.ts'), 'utf8');
    expect(src).toContain('console.log(`${WINDOW_CAVEAT}\\n`);');
    expect(src).toContain('const parsed = parseWindowSince(');
    expect(src).toContain("couldn't be read — ${windowErrorDetail(err)}");
  });
});
