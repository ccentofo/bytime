import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Launch-blockers audit A5 + A6: a bulk-import row never returns the raw Drizzle error (its message is
 * "Failed query: <sql> params: <…>" — for employees that includes the bcrypt hash); a known duplicate becomes a
 * specific message, both per import row and as a `{ ok:false, code:'conflict' }` action result.
 */

const h = vi.hoisted(() => ({ insertError: null as unknown }));

vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('@/lib/session', () => ({
  AuthorizationError: class AuthorizationError extends Error {},
  requireAdminFresh: async () => ({ id: 'admin-1', role: 'admin', email: 'a@x.dev', fullName: 'A' }),
}));
vi.mock('@/db', () => {
  const selectChain = { from: () => selectChain, where: async () => [] };
  return {
    getDbForWrite: async () => ({
      select: () => selectChain,
      insert: () => ({ values: async () => { throw h.insertError; } }),
    }),
  };
});

import { bulkImportContracts } from '@/server/actions/import';
import { userAction } from '@/lib/action-result';
import { DUPLICATE_ENTITY_MESSAGES } from '@/lib/db-errors';

/** What Drizzle 0.45 throws: a DrizzleQueryError whose message carries the SQL and params; the pg error is `.cause`. */
function drizzleError(pg: { code: string; constraint_name?: string }) {
  return Object.assign(
    new Error('Failed query: insert into "contracts" ("contract_number", "name") values ($1, $2) params: SECRET-PARAM,Acme'),
    { cause: Object.assign(new Error('pg'), pg) },
  );
}

const row = { contractNumber: 'C-1', name: 'Acme', type: 'prime', fundedValue: '', ceilingValue: '', startDate: '', endDate: '' };

beforeEach(() => {
  h.insertError = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('bulk import row errors (A5)', () => {
  it('an unexpected DB error (varchar overflow) → the generic message, no SQL or params', async () => {
    h.insertError = drizzleError({ code: '22001' });
    const r = await bulkImportContracts([row]);
    expect(r.ok).toBe(true);
    const message = r.ok ? r.data.errors[0].message : '';
    expect(message).toBe('Could not import this row.');
    expect(message).not.toMatch(/insert into|params|SECRET-PARAM/i);
  });

  it('a duplicate contract number → the specific duplicate message', async () => {
    h.insertError = drizzleError({ code: '23505', constraint_name: 'contracts_contract_number_unique' });
    const r = await bulkImportContracts([row]);
    expect(r.ok && r.data.errors[0].message).toBe('A contract with that number already exists.');
  });

  it('a bad date → a row message naming the field (not the raw parse error)', async () => {
    const r = await bulkImportContracts([{ ...row, startDate: '2026-13-40' }]);
    expect(r.ok && r.data.errors[0].message).toBe('Start date "2026-13-40" is not a valid date (use YYYY-MM-DD).');
  });
});

describe('known duplicates become conflict results (A6)', () => {
  for (const [constraint, message] of Object.entries(DUPLICATE_ENTITY_MESSAGES)) {
    it(`${constraint} → { ok:false, code:'conflict', error: "${message}" }`, async () => {
      const result = await userAction(async () => { throw drizzleError({ code: '23505', constraint_name: constraint }); });
      expect(result).toEqual({ ok: false, code: 'conflict', error: message });
    });
  }

  it('an unknown unique violation is still a bug (rethrown, shown generically by Next)', async () => {
    await expect(userAction(async () => { throw drizzleError({ code: '23505', constraint_name: 'entries_user_code_date_rev_unique_idx' }); }))
      .rejects.toThrow(/Failed query/);
  });

  it('covers the audit families: email, contract number, charge code, indirect code, cost class, SLIN, LCAT, LCAT assignment', () => {
    expect(Object.keys(DUPLICATE_ENTITY_MESSAGES).sort()).toEqual([
      'cc_lcat_effective_unique_idx', 'charge_codes_code_unique', 'clin_lcat_unique_idx', 'clin_slin_unique_idx', 'contracts_contract_number_unique',
      'cost_classes_name_unique', 'indirect_charge_codes_code_unique', 'lcat_rate_effective_unique_idx', 'user_lcat_effective_unique_idx', 'users_email_unique',
    ]);
  });
});
