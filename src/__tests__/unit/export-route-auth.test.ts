import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * feature-plan-launch-blockers.md P4 §7 / §9 "Export route": a guard failure is a 401/403 response, not an unhandled
 * throw (a generic 500 that hides the real reason).
 */

const h = vi.hoisted(() => ({ guard: null as null | (() => never), tenantCalls: 0 }));

vi.mock('@/lib/session', () => {
  class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); this.name = 'AuthorizationError'; }
  }
  return {
    AuthorizationError,
    requireAdminFresh: vi.fn(async () => {
      if (h.guard) h.guard();
      return { id: 'admin-1', email: 'a@example.com', fullName: 'A', role: 'admin' };
    }),
  };
});
vi.mock('@/lib/tenant/context', () => ({
  ExportNotAllowedError: class ExportNotAllowedError extends Error {},
  getTenantForExport: vi.fn(async () => { h.tenantCalls++; throw new Error('not reached in these tests'); }),
}));
vi.mock('@/lib/export/workspace-export', () => ({ createWorkspaceZipStream: vi.fn(), openExportSnapshot: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

import { AuthorizationError } from '@/lib/session';
import { GET } from '@/app/api/export/workspace/route';

const request = () => new Request('https://acme-test.example.com/api/export/workspace') as never;

beforeEach(() => { h.guard = null; h.tenantCalls = 0; });

describe('workspace export route guard', () => {
  it('unauthenticated → 401, and the export never starts', async () => {
    h.guard = () => { throw new AuthorizationError('unauthenticated', 'Unauthorized: No active session'); };
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(h.tenantCalls).toBe(0);
  });

  it('signed in but not an admin → 403', async () => {
    h.guard = () => { throw new AuthorizationError('forbidden', 'Forbidden: admin role required'); };
    const res = await GET(request());
    expect(res.status).toBe(403);
    expect(h.tenantCalls).toBe(0);
  });

  it('a non-authorization error is not disguised as a 401/403', async () => {
    h.guard = () => { throw new Error('database down'); };
    await expect(GET(request())).rejects.toThrow('database down');
  });
});
