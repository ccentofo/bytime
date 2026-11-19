import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * SWEEP-FINDINGS.md A1-D7: the Gusto connect path must not log the `/v1/token_info` response — its `resource_owner` is
 * a person (name, email). Only the company UUID (not personal) may be logged.
 */

vi.mock('server-only', () => ({}));
vi.mock('@/lib/integrations/connectors/gusto-api', () => ({
  exchangeGustoCode: async () => ({ accessToken: 'gusto-access-secret', refreshToken: 'gusto-refresh-secret', expiresIn: 7200 }),
  refreshGustoToken: async () => ({}),
  fetchGustoEmployees: async () => [],
  fetchGustoCurrentUser: async () => { throw new Error('404 on /v1/me'); },
  gustoGetRaw: async () => ({
    scope: 'companies:read',
    resource: { type: 'Company', uuid: 'co-uuid-1234' },
    resource_owner: { type: 'CompanyAdmin', uuid: 'owner-uuid-9', email: 'pat.owner@payroll.example', first_name: 'Pat', last_name: 'Owner' },
  }),
  fetchGustoCompanyInfo: async () => ({ companyName: 'Acme Payroll' }),
}));

import { gustoConnector } from '@/lib/integrations/connectors/gusto';

afterEach(() => { vi.restoreAllMocks(); });

describe('A1-D7: no personal data from /v1/token_info in the logs', () => {
  it('connects with the company UUID, and no console line carries the owner or the tokens', async () => {
    const lines: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x) ?? String(x))).join(' ')); });
    }
    const out = await gustoConnector.exchangeCodeForTokens!('code-1');
    expect(out).toMatchObject({ realmId: 'co-uuid-1234', companyName: 'Acme Payroll' });
    const all = lines.join('\n');
    for (const secret of ['pat.owner@payroll.example', 'Pat', 'Owner', 'owner-uuid-9', 'resource_owner', 'gusto-access-secret']) {
      expect(all, secret).not.toContain(secret);
    }
  });
});
