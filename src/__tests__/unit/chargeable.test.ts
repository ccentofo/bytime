import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { stripComments } from '../helpers/source-scanner';

/**
 * feature-plan-ux-navigation-home.md §4.7 / §4.8 / T16 (B1, B5): ONE "chargeable code" rule — timesheet row sourcing
 * and the Setup counts share CHARGEABLE_CODE; the save path passes slinActive to newCellRefusal per cell.
 */

vi.mock('server-only', () => ({}));
import { CHARGEABLE_CODE } from '@/server/internal/chargeable';

const ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string) => stripComments(readFileSync(path.join(ROOT, rel), 'utf8'));

describe('chargeable code rule (T16)', () => {
  it('the predicate: code active, CLIN active, contract active, SLIN null or active', () => {
    const sql = new PgDialect().sqlToQuery(CHARGEABLE_CODE);
    const flat = sql.sql.replace(/\s+/g, ' ');
    expect(flat).toContain('"charge_codes"."is_active" = $1');
    expect(flat).toContain('"clins"."status" = $2');
    expect(flat).toContain('"contracts"."status" = $3');
    expect(flat).toContain('("charge_codes"."slin_id" is null or "slins"."status" = $4)');
    expect(sql.params).toEqual([true, 'active', 'active', 'active']);
  });

  it('row sourcing (getChargeCodesForEmployee) and setup.ts use CHARGEABLE_CODE; neither re-inlines the status checks', () => {
    const ts = read('src/server/actions/timesheet.ts');
    const rows = ts.slice(ts.indexOf('async function getChargeCodesForEmployee'), ts.indexOf('async function getPeriodCodesForEmployee'));
    expect(rows).toContain('CHARGEABLE_CODE');
    expect(rows).not.toMatch(/eq\(clins\.status, 'active'\)/);
    const setup = read('src/server/internal/setup.ts');
    expect(setup).toContain("import { CHARGEABLE_CODE } from '@/server/internal/chargeable';");
    expect(setup.match(/CHARGEABLE_CODE/g)!.length).toBeGreaterThanOrEqual(3); // import + chargeCodes count + access count
    expect(setup).not.toMatch(/eq\(clins\.status, 'active'\),\s*eq\(contracts\.status/);
  });

  it('the save path passes slinActive (from the left-joined SLIN status) to newCellRefusal', () => {
    const ts = read('src/server/actions/timesheet.ts');
    const save = ts.slice(ts.indexOf('export async function saveTimesheetBatch'), ts.indexOf('async function getChargeCodesForEmployee'));
    expect(save).toMatch(/slinStatus: slins\.status/);
    expect(save).toMatch(/\.leftJoin\(slins, eq\(chargeCodes\.slinId, slins\.id\)\)/);
    const call = save.slice(save.indexOf('newCellRefusal({'), save.indexOf('})', save.indexOf('newCellRefusal({')));
    expect(call).toMatch(/slinActive:/);
  });
});
