import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { stripComments } from '../helpers/source-scanner';

/**
 * feature-plan-dated-rates.md D1.5 ruling (D0): ONE admin_change_log writer — logAdminChange(tx, row) in
 * src/server/internal/admin-change-log.ts — used with the caller's transaction. No other file inserts log rows.
 */

vi.mock('server-only', () => ({}));

import { createFakeControlDb } from '../helpers/fake-control-db';
import { adminChangeLog } from '@/db/schema';
import { logAdminChange } from '@/server/internal/admin-change-log';

const ROOT = path.resolve(__dirname, '../../..');
const WRITER = 'src/server/internal/admin-change-log.ts';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === '__tests__' || name === 'node_modules') return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/** True when the source inserts into admin_change_log directly (named or namespace import). */
export function insertsChangeLog(src: string): boolean {
  return /\.insert\(\s*(?:schema\.)?adminChangeLog\s*\)/.test(stripComments(src));
}

describe('logAdminChange', () => {
  it('inserts exactly the given row with the CALLER\'s client and returns its id', async () => {
    const tx = createFakeControlDb();
    tx.onReturning('insert', adminChangeLog, [{ id: 'log-1' }]);
    const row = { actorId: 'a', entity: 'charge_code', entityId: 'c', action: 'deactivated', oldValue: { isActive: true }, newValue: { isActive: false } };
    expect(await logAdminChange(tx as never, row)).toBe('log-1');
    expect(tx.inserts).toEqual([{ table: adminChangeLog, values: row }]);
  });
});

describe('static: no admin_change_log insert outside the writer', () => {
  it('src/ and scripts/ never call insert(adminChangeLog) except admin-change-log.ts', () => {
    const offenders = [...sourceFiles(path.join(ROOT, 'src')), ...sourceFiles(path.join(ROOT, 'scripts'))]
      .map((f) => path.relative(ROOT, f))
      .filter((rel) => rel !== WRITER && insertsChangeLog(readFileSync(path.join(ROOT, rel), 'utf8')));
    expect(offenders).toEqual([]);
    expect(insertsChangeLog(readFileSync(path.join(ROOT, WRITER), 'utf8'))).toBe(true);
  });

  it('fixture: a direct insert (named or namespace import) is flagged; a select or delete is not', () => {
    expect(insertsChangeLog('await tx.insert(adminChangeLog).values({ actorId })')).toBe(true);
    expect(insertsChangeLog('await db.insert(schema.adminChangeLog).values(row)')).toBe(true);
    expect(insertsChangeLog('await db.select().from(adminChangeLog)')).toBe(false);
    expect(insertsChangeLog('await tx.delete(schema.adminChangeLog)')).toBe(false);
  });

  it('the certified-outputs writers and the dated-rates actions use it (same transaction client)', () => {
    const uses = (rel: string) => (readFileSync(path.join(ROOT, rel), 'utf8').match(/await logAdminChange\(tx, \{/g) ?? []).length;
    // dated rates D3: the labor-category log moved from updateChargeCode into the category actions.
    expect(uses('src/server/actions/charge-codes.ts')).toBe(2);
    expect(uses('src/server/actions/labor-category-rates.ts')).toBe(3);
    expect(uses('src/server/actions/charge-code-categories.ts')).toBe(3);
    expect(uses('src/server/actions/users.ts')).toBe(1);
    expect(uses('src/server/actions/workspace-settings.ts')).toBe(1);
    expect(readFileSync(path.join(ROOT, 'src/server/internal/approval-rules.ts'), 'utf8')).toMatch(/const logId = await logAdminChange\(tx, \{/);
  });
});
