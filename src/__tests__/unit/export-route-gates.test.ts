import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SWEEP-FINDINGS.md A1-G21: the in-app workspace export route resolves the workspace with getTenantForExport (export's
 * own rule: every mode but closed, a policy hold only when the founder allowed it), never the read or write gate, and
 * allows 5 exports per workspace per hour. The snapshot open fails on purpose (→ 503), so each allowed request stops
 * right after the limiter without streaming anything.
 */

const h = vi.hoisted(() => ({ slug: 'acme', refuse: null as null | string, forExport: 0 }));
vi.mock('@/lib/session', () => {
  class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); this.name = 'AuthorizationError'; }
  }
  return { AuthorizationError, requireAdminFresh: async () => ({ id: 'admin-1', email: 'a@x.test', fullName: 'A', role: 'admin' }) };
});
vi.mock('@/lib/tenant/context', () => {
  class ExportNotAllowedError extends Error {}
  const wrong = async () => { throw new Error('the export route must use getTenantForExport'); };
  return {
    ExportNotAllowedError,
    getTenantForExport: async () => {
      h.forExport++;
      if (h.refuse) throw new ExportNotAllowedError(h.refuse);
      return { slug: h.slug, dbUrl: `postgresql://app@db/${h.slug}` };
    },
    getTenantOrThrow: wrong, getTenantForWrite: wrong, getTenantForBilling: wrong,
  };
});
vi.mock('@/lib/export/workspace-export', () => ({
  createWorkspaceZipStream: vi.fn(),
  openExportSnapshot: vi.fn(async () => { throw new Error('snapshot unavailable (test)'); }),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { GET } from '@/app/api/export/workspace/route';

const get = () => GET(new Request('https://acme.example.com/api/export/workspace') as never);

let n = 0;
beforeEach(() => { h.slug = `ws-${++n}`; h.refuse = null; h.forExport = 0; }); // a fresh limiter key per case

describe('A1-G21: the export route uses getTenantForExport', () => {
  it('a refusal from getTenantForExport (closed, or a policy hold without export) → 403 with its message', async () => {
    h.refuse = 'This workspace is not available.';
    const res = await get();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'This workspace is not available.' });
    expect(h.forExport).toBe(1);
  });

  it('an allowed workspace reaches the snapshot step (here: 503)', async () => {
    expect((await get()).status).toBe(503);
    expect(h.forExport).toBe(1);
  });
});

describe('A1-G21: 5 exports per workspace per hour', () => {
  it('the 6th request in the hour → 429 with Retry-After; another workspace is unaffected', async () => {
    for (let i = 0; i < 5; i++) expect((await get()).status, `request ${i + 1}`).toBe(503);
    const sixth = await get();
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get('Retry-After'))).toBeGreaterThan(3000);
    h.slug = `${h.slug}-other`;
    expect((await get()).status).toBe(503);
  });
});
