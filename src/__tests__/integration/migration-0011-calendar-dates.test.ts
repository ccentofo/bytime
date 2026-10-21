import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import postgres from 'postgres';

// ---------------------------------------------------------------------------
// feature-plan-calendar-dates.md D2 — runs the REAL drizzle/0011 migration file.
//
// The shared test database is already migrated to the latest version, so each case builds a
// scratch Postgres schema, replays the real migrations 0000–0010 into it (unqualified names
// resolve to it via search_path; the few explicit "public". qualifiers are rewritten), seeds
// rows the way the pre-0011 app wrote them, then applies the real 0011 file. Editing the
// migration's conversions, guards, or renumbering changes what these tests observe.
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.TEST_DATABASE_URL
  ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test';
const DRIZZLE_DIR = path.resolve(__dirname, '../../../drizzle');
const SCHEMA = 'migration_0011_test';

type Journal = { entries: Array<{ idx: number; tag: string }> };
const journal: Journal = JSON.parse(fs.readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf8'));

function migrationChunks(idx: number): string[] {
  const entry = journal.entries.find((e) => e.idx === idx);
  if (!entry) throw new Error(`No migration with idx ${idx}`);
  const raw = fs.readFileSync(path.join(DRIZZLE_DIR, `${entry.tag}.sql`), 'utf8');
  return raw
    .split('--> statement-breakpoint')
    .map((chunk) => chunk.replaceAll('"public".', `"${SCHEMA}".`).trim())
    .filter(Boolean);
}

let sql: ReturnType<typeof postgres>;

/** Fresh scratch schema at the pre-0011 version (0000–0010 applied). */
async function schemaAtVersion10() {
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await sql.unsafe(`CREATE SCHEMA ${SCHEMA}`);
  await sql.unsafe(`SET search_path TO ${SCHEMA}`);
  for (let idx = 0; idx <= 10; idx++) {
    for (const chunk of migrationChunks(idx)) await sql.unsafe(chunk);
  }
}

/** Applies the real 0011 file in one transaction, like Drizzle's migrator does. */
async function applyMigration11() {
  await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL search_path TO ${SCHEMA}`);
    for (const chunk of migrationChunks(11)) await tx.unsafe(chunk);
  });
}

async function columnType(table: string, column: string): Promise<string> {
  const [row] = await sql`
    SELECT data_type FROM information_schema.columns
    WHERE table_schema = ${SCHEMA} AND table_name = ${table} AND column_name = ${column}`;
  return row?.data_type;
}

/** Minimal reference rows the seeded entries point at. */
async function seedReferences() {
  const [user] = await sql`INSERT INTO users (email, full_name) VALUES ('m@example.com', 'Migration User') RETURNING id`;
  const [contract] = await sql`INSERT INTO contracts (contract_number, name) VALUES ('C-1', 'Contract') RETURNING id`;
  const [clin] = await sql`INSERT INTO clins (contract_id, clin_number) VALUES (${contract.id}, '0001') RETURNING id`;
  const [code] = await sql`INSERT INTO charge_codes (code, name, clin_id) VALUES ('CC-1', 'Code', ${clin.id}) RETURNING id`;
  const [indirect] = await sql`INSERT INTO indirect_charge_codes (code, name, category) VALUES ('PTO', 'Leave', 'leave') RETURNING id`;
  return { userId: user.id as string, clinId: clin.id as string, chargeCodeId: code.id as string, indirectId: indirect.id as string };
}

describe.skipIf(!TEST_DB_URL)('migration 0011 (real file): calendar-date conversion', () => {
  beforeAll(async () => {
    sql = postgres(TEST_DB_URL, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sql.end();
  });

  it('converts every stored convention to the intended calendar day and repairs split revision chains', async () => {
    await schemaAtVersion10();
    const ref = await seedReferences();

    // Periods saved by the server (UTC midnight), a US browser (04:00Z), and post-DST (05:00Z).
    await sql`INSERT INTO timesheet_periods (user_id, period_start, status) VALUES
      (${ref.userId}, '2026-10-01T00:00:00Z', 'approved'),
      (${ref.userId}, '2026-10-16T04:00:00Z', 'submitted'),
      (${ref.userId}, '2026-11-16T05:00:00Z', 'draft')`;

    // One charge-code cell (with its denormalized clin_id) saved under two conventions: two
    // "revision 1" rows for the same day. The 04:00Z save is the later one.
    await sql`INSERT INTO timesheet_entries (user_id, charge_code_id, clin_id, entry_date, hours, revision_number, created_at) VALUES
      (${ref.userId}, ${ref.chargeCodeId}, ${ref.clinId}, '2026-10-05T00:00:00Z', '8', 1, '2026-10-05T15:00:00Z'),
      (${ref.userId}, ${ref.chargeCodeId}, ${ref.clinId}, '2026-10-05T04:00:00Z', '6', 1, '2026-10-05T18:00:00Z')`;
    // A legacy CLIN-only row and an indirect row on the same day: different cells, untouched.
    await sql`INSERT INTO timesheet_entries (user_id, clin_id, entry_date, hours, revision_number) VALUES
      (${ref.userId}, ${ref.clinId}, '2026-10-05T04:00:00Z', '1', 1)`;
    await sql`INSERT INTO timesheet_entries (user_id, indirect_code_id, entry_date, hours, revision_number) VALUES
      (${ref.userId}, ${ref.indirectId}, '2026-10-05T00:00:00Z', '2', 1)`;

    // Labor-category assignments: one ended with "End assignment" (a real now() instant), one
    // ended with a date-picker value (exact UTC midnight, which excluded that day).
    const [lcat] = await sql`INSERT INTO labor_categories (clin_id, lcat_code, title) VALUES (${ref.clinId}, 'SWE3', 'Engineer') RETURNING id`;
    await sql`INSERT INTO user_labor_categories (user_id, labor_category_id, effective_date, end_date) VALUES
      (${ref.userId}, ${lcat.id}, '2026-01-01T00:00:00Z', '2026-10-21T22:30:00Z'),
      (${ref.userId}, ${lcat.id}, '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z')`;

    // A sync log whose end is end-of-October in a US browser (early Nov 1 in UTC).
    const [conn] = await sql`INSERT INTO integration_connections (provider, display_name, connected_by) VALUES ('quickbooks_online', 'QBO', ${ref.userId}) RETURNING id`;
    await sql`INSERT INTO integration_sync_logs (connection_id, sync_type, period_start, period_end) VALUES
      (${conn.id}, 'timesheet_push', '2026-08-01T04:00:00Z', '2026-11-01T03:59:59.999Z')`;

    await sql`INSERT INTO pay_period_config (period_type, anchor_date, week_start_day, effective_from) VALUES
      ('semimonthly', '2026-01-01T00:00:00Z', 1, '1900-01-01T00:00:00Z')`;

    const entriesBefore = await sql`SELECT count(*)::int AS n FROM timesheet_entries`;

    await applyMigration11();

    for (const [table, column] of [
      ['timesheet_periods', 'period_start'], ['timesheet_entries', 'entry_date'],
      ['pay_period_config', 'anchor_date'], ['pay_period_config', 'effective_from'],
      ['contracts', 'start_date'], ['contracts', 'end_date'],
      ['user_labor_categories', 'effective_date'], ['user_labor_categories', 'end_date'],
      ['integration_sync_logs', 'period_start'], ['integration_sync_logs', 'period_end'],
    ]) {
      expect(await columnType(table, column), `${table}.${column}`).toBe('date');
    }

    const periods = await sql`SELECT period_start::text AS d FROM timesheet_periods ORDER BY period_start`;
    expect(periods.map((p) => p.d)).toEqual(['2026-10-01', '2026-10-16', '2026-11-16']);

    // No row lost; the split chain is one chain ordered by created_at (the later save is rev 2).
    const entriesAfter = await sql`SELECT count(*)::int AS n FROM timesheet_entries`;
    expect(entriesAfter[0].n).toBe(entriesBefore[0].n);
    const chain = await sql`
      SELECT entry_date::text AS d, hours, revision_number AS rev FROM timesheet_entries
      WHERE charge_code_id = ${ref.chargeCodeId} ORDER BY revision_number`;
    expect(chain.map((r) => [r.d, r.hours, r.rev])).toEqual([['2026-10-05', '8', 1], ['2026-10-05', '6', 2]]);
    const others = await sql`
      SELECT revision_number AS rev FROM timesheet_entries WHERE charge_code_id IS NULL ORDER BY hours`;
    expect(others.map((r) => r.rev)).toEqual([1, 1]);

    // Labor-category end dates become the INCLUSIVE last day.
    const lcatEnds = await sql`SELECT end_date::text AS d FROM user_labor_categories ORDER BY effective_date`;
    expect(lcatEnds.map((r) => r.d)).toEqual(['2026-10-21', '2026-11-30']);

    const [sync] = await sql`SELECT period_start::text AS s, period_end::text AS e FROM integration_sync_logs`;
    expect([sync.s, sync.e]).toEqual(['2026-08-01', '2026-10-31']);

    const [config] = await sql`SELECT effective_from::text AS d FROM pay_period_config`;
    expect(config.d).toBe('1900-01-01');

    const [settings] = await sql`SELECT timezone FROM workspace_settings`;
    expect(settings.timezone).toBe('America/New_York');

    // The new per-cell revision uniqueness is in force.
    await expect(sql`INSERT INTO timesheet_entries (user_id, charge_code_id, clin_id, entry_date, hours, revision_number)
      VALUES (${ref.userId}, ${ref.chargeCodeId}, ${ref.clinId}, '2026-10-05', '9', 2)`).rejects.toMatchObject({ code: '23505' });
  });

  it('fails closed, changing nothing, when two periods collapse onto one calendar day', async () => {
    await schemaAtVersion10();
    const ref = await seedReferences();
    await sql`INSERT INTO timesheet_periods (user_id, period_start, status) VALUES
      (${ref.userId}, '2026-10-01T00:00:00Z', 'submitted'),
      (${ref.userId}, '2026-10-01T04:00:00Z', 'draft')`;

    await expect(applyMigration11()).rejects.toThrow(/duplicate timesheet_periods rows collide/);

    // The whole migration rolled back: still the old column type, and no new table.
    expect(await columnType('timesheet_periods', 'period_start')).toBe('timestamp with time zone');
    const [settingsTable] = await sql`
      SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = ${SCHEMA} AND table_name = 'workspace_settings'`;
    expect(settingsTable.n).toBe(0);
  });
});
