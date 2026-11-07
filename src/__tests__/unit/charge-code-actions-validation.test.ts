import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * feature-plan-ux-people-codes.md §3.2–§3.4, unit companion to integration CC-4 / CC-6 / CC-7 (runnable without
 * Postgres: a scripted database). Create from CLINs: a taken or > 100-character code is unavailable; a subset creates
 * only those; [] is refused; no argument creates the whole available set; `created` counts returned rows and `skipped`
 * every other id passed. Create / update: an inactive CLIN, a SLIN from another CLIN, and a CLIN move that keeps the
 * old SLIN are refused; codes are trimmed. listChargeCodes: `peopleCount` names the outer column literally.
 */

vi.mock('server-only', () => ({}));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {}, captureMessage: () => {} }));
vi.mock('@/db', async () => {
  const { createFakeControlDb } = await import('../helpers/fake-control-db');
  const db = createFakeControlDb() as ReturnType<typeof createFakeControlDb> & { transaction: (cb: (tx: unknown) => unknown) => unknown };
  db.transaction = async (cb) => cb(db);
  return { getDb: async () => db, getDbForWrite: async () => db, getDbForAuth: async () => db, getDbForUrl: () => db, __db: db };
});
vi.mock('@/lib/session', () => {
  class AuthorizationError extends Error {
    constructor(public kind: 'unauthenticated' | 'forbidden', message: string) { super(message); this.name = 'AuthorizationError'; }
  }
  const admin = async () => ({ id: 'admin-1', email: 'a@x', fullName: 'Ann', role: 'admin' });
  return { AuthorizationError, requireSession: admin, requireAdmin: admin, requireAdminFresh: admin };
});

import * as dbModule from '@/db';
import { chargeCodes, chargeCodeLaborCategories, clins, slins, timesheetEntries } from '@/db/schema';
import type { FakeControlDb } from '../helpers/fake-control-db';
import { autobridgeChargeCodesFromClins, createChargeCode, previewAutobridgeChargeCodes, updateChargeCode } from '@/server/actions/charge-codes';

const db = (dbModule as unknown as { __db: FakeControlDb }).__db;
beforeEach(() => db.reset());

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clin = (n: number, o: Record<string, unknown> = {}) => ({ clinId: ID(n), clinNumber: String(n).padStart(4, '0'), description: `CLIN ${n}`, contractName: 'NAVAIR', contractNumber: 'N-1', ...o });

describe('Create codes from CLINs (CC-6 companion)', () => {
  it('preview: a taken code and a > 100-character code are unavailable with their reasons; sorted by contract, then CLIN; names ≤ 255', async () => {
    db.onSelect(clins, [clin(3), clin(1, { contractName: 'Army', contractNumber: 'A-1' }), clin(2), clin(4, { contractNumber: 'X'.repeat(99) }), clin(5, { description: 'n'.repeat(300) })]);
    db.onSelect(chargeCodes, [{ code: 'N-1-0002' }]);
    const rows = await previewAutobridgeChargeCodes();
    expect(rows.map((r) => [r.contractName, r.clinNumber, r.code.length > 100 ? 'long' : r.code, r.available, r.reason ?? null])).toEqual([
      ['Army', '0001', 'A-1-0001', true, null],
      ['NAVAIR', '0002', 'N-1-0002', false, 'Code N-1-0002 is already used — add one yourself.'],
      ['NAVAIR', '0003', 'N-1-0003', true, null],
      ['NAVAIR', '0004', 'long', false, 'Code would be too long — add one yourself.'],
      ['NAVAIR', '0005', 'N-1-0005', true, null],
    ]);
    expect(rows.find((r) => r.clinNumber === '0005')!.name).toHaveLength(255);
  });

  it('a subset creates only those (in one insert); created = returned rows; skipped = every other id passed', async () => {
    db.onSelect(clins, [clin(1), clin(2), clin(3)]);
    db.onSelect(chargeCodes, []);
    db.onReturning('insert', chargeCodes, [{ id: 'new-1' }]);                         // CLIN 3's code taken meanwhile
    const r = await autobridgeChargeCodesFromClins([ID(1), ID(3), ID(9)]);               // ID(9) no longer qualifies
    expect(r).toEqual({ ok: true, data: { created: 1, skipped: 2 } });
    expect(db.inserts).toHaveLength(1);
    expect((db.inserts[0].values as unknown as Array<{ clinId: string }>).map((v) => v.clinId)).toEqual([ID(1), ID(3)]);
  });

  it('no argument: every available CLIN; [] refused; non-UUID refused; nothing is read before a refusal', async () => {
    db.onSelect(clins, [clin(1), clin(2)]);
    db.onSelect(chargeCodes, [{ code: 'N-1-0002' }]);
    db.onReturning('insert', chargeCodes, [{ id: 'new-1' }]);
    expect(await autobridgeChargeCodesFromClins()).toEqual({ ok: true, data: { created: 1, skipped: 0 } });
    expect((db.inserts[0].values as unknown as Array<{ code: string }>).map((v) => v.code)).toEqual(['N-1-0001']);
    db.reset();
    expect(await autobridgeChargeCodesFromClins([])).toMatchObject({ ok: false, error: 'Tick at least one CLIN.' });
    expect(await autobridgeChargeCodesFromClins(['nope'])).toMatchObject({ ok: false });
    expect(db.ops).toEqual([]);
  });
});

describe('create / update checks (CC-7 companion)', () => {
  it('create: an inactive CLIN (or contract) → "Choose an active CLIN."; a SLIN from another CLIN refused; the code is trimmed', async () => {
    db.onSelect(clins, [{ clinStatus: 'inactive', contractStatus: 'active' }]);
    expect(await createChargeCode({ code: 'X', name: 'Y', clinId: ID(1) })).toMatchObject({ ok: false, error: 'Choose an active CLIN.' });
    db.onSelect(clins, [{ clinStatus: 'active', contractStatus: 'inactive' }]);
    expect(await createChargeCode({ code: 'X', name: 'Y', clinId: ID(1) })).toMatchObject({ ok: false, error: 'Choose an active CLIN.' });
    db.onSelect(clins, [{ clinStatus: 'active', contractStatus: 'active' }]);
    db.onSelect(slins, [{ clinId: ID(2) }]);
    expect(await createChargeCode({ code: 'X', name: 'Y', clinId: ID(1), slinId: ID(7) })).toMatchObject({ ok: false, error: "That SLIN isn't on the chosen CLIN." });
    expect(db.inserts).toEqual([]);
    db.onSelect(clins, [{ clinStatus: 'active', contractStatus: 'active' }]);
    db.onSelect(slins, [{ clinId: ID(1) }]);
    db.onReturning('insert', chargeCodes, [{ id: 'cc' }]);
    expect(await createChargeCode({ code: '  NAV-9  ', name: ' Nine ', clinId: ID(1), slinId: ID(7) })).toMatchObject({ ok: true });
    expect(db.inserts[0].values).toMatchObject({ code: 'NAV-9', name: 'Nine', slinId: ID(7) });
  });

  it('create: required fields and lengths, before any read', async () => {
    expect(await createChargeCode({ code: '  ', name: 'Y', clinId: ID(1) })).toMatchObject({ ok: false, error: 'Enter a code.' });
    expect(await createChargeCode({ code: 'X', name: '', clinId: ID(1) })).toMatchObject({ ok: false, error: 'Enter a name.' });
    expect(await createChargeCode({ code: 'X', name: 'Y', clinId: '' })).toMatchObject({ ok: false, error: 'Choose a CLIN.' });
    expect(await createChargeCode({ code: 'x'.repeat(101), name: 'Y', clinId: ID(1) })).toMatchObject({ ok: false, error: 'The code must be 100 characters or fewer.' });
    expect(await createChargeCode({ code: 'X', name: 'Y', clinId: ID(1), description: 'd'.repeat(2001) })).toMatchObject({ ok: false });
    expect(db.ops).toEqual([]);
  });

  it('update: moving the CLIN while the old SLIN stays → refused; the locks run first; a code is trimmed', async () => {
    const current = { id: 'cc', clinId: ID(1), slinId: ID(7), laborCategoryId: null };
    db.onSelect(chargeCodes, [current]);
    db.onSelect(timesheetEntries, []);
    db.onSelect(chargeCodeLaborCategories, []);
    db.onSelect(slins, [{ clinId: ID(1) }]);                                            // the old SLIN sits on the old CLIN
    expect(await updateChargeCode('cc', { clinId: ID(2) })).toMatchObject({ ok: false, error: "That SLIN isn't on the chosen CLIN." });
    expect(db.updates).toEqual([]);
    db.onSelect(chargeCodes, [current]);
    db.onSelect(timesheetEntries, [{ id: 'te' }]);                                       // hours recorded: the existing lock wins
    expect(await updateChargeCode('cc', { clinId: ID(2) })).toMatchObject({ ok: false, error: expect.stringContaining('already has recorded hours') });
    db.onSelect(chargeCodes, [{ ...current, slinId: null }]);
    db.onReturning('update', chargeCodes, [{ id: 'cc' }]);
    expect(await updateChargeCode('cc', { code: '  NEW  ' })).toMatchObject({ ok: true });
    expect(db.updates[0].set).toMatchObject({ code: 'NEW' });
  });
});

describe('listChargeCodes (CC-4 companion)', () => {
  it('peopleCount counts active rows of active users, naming the outer column literally (charge_codes.id); chargeable is the shared rule', () => {
    const src = readFileSync('src/server/actions/charge-codes.ts', 'utf8');
    const people = src.match(/peopleCount:\s*sql<number>`([^`]*)`/)?.[1] ?? '';
    expect(people).toContain('ucc.charge_code_id = charge_codes.id');
    expect(people).toContain('ucc.is_active and u.is_active');
    expect(people).not.toContain('${');
    expect(src).toMatch(/chargeable:\s*sql<boolean>`\$\{CHARGEABLE_CODE\}`/);
    expect(src).toMatch(/\.leftJoin\(slins, eq\(chargeCodes\.slinId, slins\.id\)\)/);
  });
});
