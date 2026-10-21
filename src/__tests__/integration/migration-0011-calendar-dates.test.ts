import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';

// ---------------------------------------------------------------------------
// feature-plan-calendar-dates.md D2 — migration 0011 core SQL logic.
//
// Exercises the exact UTC+12h conversion, duplicate-period guard, and revision
// renumbering logic from drizzle/0011_solid_gideon.sql against an ISOLATED
// Postgres schema built with minimal, FK-free versions of just the two tables
// those statements touch (timesheet_periods, timesheet_entries). This is
// deliberate, not a shortcut: running the actual migration file requires the
// database to be at the pre-0011 schema version, but every other integration
// test's shared setup (setup-db.ts) migrates straight through to the latest
// migration before any test runs — there's no supported way to "rewind" one
// shared test database to an intermediate schema version without either a
// second disposable database or hand-rolled migration-state surgery. Testing
// the same SQL expressions against a reduced, isolated schema gives equivalent
// coverage of the logic that matters (the rounding formula, the duplicate
// check, the window-function renumbering) without either of those.
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.TEST_DATABASE_URL
  ?? 'postgresql://bytime:bytime_dev@localhost:5432/bytime_test';

let sql: ReturnType<typeof postgres>;
const SCHEMA = 'migration_0011_test';

async function resetSchema() {
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await sql.unsafe(`CREATE SCHEMA ${SCHEMA}`);
  await sql.unsafe(`
    CREATE TABLE ${SCHEMA}.timesheet_periods (
      id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      user_id uuid NOT NULL,
      period_start timestamp with time zone NOT NULL,
      status text NOT NULL DEFAULT 'draft'
    );
    CREATE TABLE ${SCHEMA}.timesheet_entries (
      id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      user_id uuid NOT NULL,
      clin_id uuid,
      indirect_code_id uuid,
      charge_code_id uuid,
      entry_date timestamp with time zone NOT NULL,
      revision_number integer NOT NULL DEFAULT 1,
      created_at timestamp with time zone NOT NULL DEFAULT now()
    );
  `);
}

/** The exact renumbering statement from drizzle/0011_solid_gideon.sql, schema-qualified. */
async function runRevisionRenumbering() {
  await sql.unsafe(`
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY
            user_id,
            COALESCE(charge_code_id, indirect_code_id, clin_id),
            ((entry_date AT TIME ZONE 'UTC') + interval '12 hours')::date
          ORDER BY created_at, revision_number, id
        ) AS new_revision_number
      FROM ${SCHEMA}.timesheet_entries
    )
    UPDATE ${SCHEMA}.timesheet_entries
    SET revision_number = ranked.new_revision_number
    FROM ranked
    WHERE ${SCHEMA}.timesheet_entries.id = ranked.id
      AND ${SCHEMA}.timesheet_entries.revision_number IS DISTINCT FROM ranked.new_revision_number;
  `);
}

/** The exact duplicate-period guard from drizzle/0011_solid_gideon.sql, schema-qualified. */
async function runDuplicatePeriodGuard(): Promise<void> {
  await sql.unsafe(`
    DO $$
    DECLARE
      conflict_summary text;
    BEGIN
      SELECT string_agg(
        format('user_id=%s day=%s (%s colliding periods)', user_id, day, cnt),
        '; '
      )
      INTO conflict_summary
      FROM (
        SELECT
          user_id,
          ((period_start AT TIME ZONE 'UTC') + interval '12 hours')::date AS day,
          COUNT(*) AS cnt
        FROM ${SCHEMA}.timesheet_periods
        GROUP BY user_id, ((period_start AT TIME ZONE 'UTC') + interval '12 hours')::date
        HAVING COUNT(*) > 1
      ) AS dupes;

      IF conflict_summary IS NOT NULL THEN
        RAISE EXCEPTION 'duplicate timesheet_periods rows collide on the same calendar day after UTC+12h conversion — %', conflict_summary;
      END IF;
    END $$;
  `);
}

async function runTypeChange(table: string, column: string) {
  await sql.unsafe(`
    ALTER TABLE ${SCHEMA}.${table}
    ALTER COLUMN ${column} SET DATA TYPE date
    USING ((${column} AT TIME ZONE 'UTC') + interval '12 hours')::date;
  `);
}

const USER_A = '11111111-1111-1111-1111-111111111111';
const CODE_A = '22222222-2222-2222-2222-222222222222';

describe('Migration 0011 core SQL logic (calendar-dates D2)', () => {
  beforeAll(async () => {
    sql = postgres(TEST_DB_URL, { max: 1 });
    await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto`); // gen_random_uuid()
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sql.end();
  });

  it('converts all three historical midnight conventions to the SAME correct calendar day', async () => {
    await resetSchema();

    // Three ways "Nov 1" has been stored: UTC midnight, US-Eastern midnight before DST ended
    // (UTC-4, so 04:00Z), and US-Eastern midnight after DST ended (UTC-5, so 05:00Z).
    await sql.unsafe(`
      INSERT INTO ${SCHEMA}.timesheet_entries (user_id, charge_code_id, entry_date, revision_number)
      VALUES
        ('${USER_A}', '${CODE_A}', '2026-11-01T00:00:00Z', 1),
        ('${USER_A}', '${CODE_A}', '2026-11-02T04:00:00Z', 1),
        ('${USER_A}', '${CODE_A}', '2026-11-03T05:00:00Z', 1);
    `);

    await runTypeChange('timesheet_entries', 'entry_date');

    const rows = await sql.unsafe(`SELECT entry_date::text FROM ${SCHEMA}.timesheet_entries ORDER BY entry_date`);
    expect(rows.map((r: any) => r.entry_date)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
  });

  it('renumbers a same-day duplicate revision chain without losing any row', async () => {
    await resetSchema();

    // The bug: the same cell saved as revision 1 under TWO conventions for what is really one
    // calendar day (Nov 1), plus a legitimate, already-correct revision 2 created afterward.
    await sql.unsafe(`
      INSERT INTO ${SCHEMA}.timesheet_entries (user_id, charge_code_id, entry_date, revision_number, created_at)
      VALUES
        ('${USER_A}', '${CODE_A}', '2026-11-01T00:00:00Z', 1, '2026-11-01T10:00:00Z'),
        ('${USER_A}', '${CODE_A}', '2026-11-01T04:00:00Z', 1, '2026-11-01T12:00:00Z'),
        ('${USER_A}', '${CODE_A}', '2026-11-01T04:00:00Z', 2, '2026-11-01T14:00:00Z');
    `);

    const beforeCount = await sql.unsafe(`SELECT COUNT(*)::int AS n FROM ${SCHEMA}.timesheet_entries`);
    expect(beforeCount[0].n).toBe(3);

    await runRevisionRenumbering();
    await runTypeChange('timesheet_entries', 'entry_date');

    const afterCount = await sql.unsafe(`SELECT COUNT(*)::int AS n FROM ${SCHEMA}.timesheet_entries`);
    expect(afterCount[0].n).toBe(3); // no row lost

    const rows = await sql.unsafe(`
      SELECT revision_number, entry_date::text FROM ${SCHEMA}.timesheet_entries ORDER BY revision_number
    `);
    expect(rows.map((r: any) => r.revision_number)).toEqual([1, 2, 3]);
    expect(rows.every((r: any) => r.entry_date === '2026-11-01')).toBe(true);

    // The new unique index target — (user, code, day, revision) — would now accept all three
    // rows without a conflict, which is exactly the point: distinct revision numbers per day.
    const distinctRevisions = new Set(rows.map((r: any) => r.revision_number));
    expect(distinctRevisions.size).toBe(3);
  });

  it('leaves an already-correct revision chain unchanged (renumbering is a no-op for clean data)', async () => {
    await resetSchema();

    await sql.unsafe(`
      INSERT INTO ${SCHEMA}.timesheet_entries (user_id, charge_code_id, entry_date, revision_number, created_at)
      VALUES
        ('${USER_A}', '${CODE_A}', '2026-11-01T00:00:00Z', 1, '2026-11-01T10:00:00Z'),
        ('${USER_A}', '${CODE_A}', '2026-11-01T00:00:00Z', 2, '2026-11-01T12:00:00Z');
    `);

    await runRevisionRenumbering();

    const rows = await sql.unsafe(`
      SELECT revision_number FROM ${SCHEMA}.timesheet_entries ORDER BY revision_number
    `);
    expect(rows.map((r: any) => r.revision_number)).toEqual([1, 2]);
  });

  it('fails closed on a same-day duplicate PERIOD instead of silently merging or picking one', async () => {
    await resetSchema();

    // Two periods for the same user that both round to Nov 1 under the +12h conversion.
    await sql.unsafe(`
      INSERT INTO ${SCHEMA}.timesheet_periods (user_id, period_start, status)
      VALUES
        ('${USER_A}', '2026-11-01T00:00:00Z', 'draft'),
        ('${USER_A}', '2026-11-01T04:00:00Z', 'submitted');
    `);

    await expect(runDuplicatePeriodGuard()).rejects.toThrow(/duplicate timesheet_periods rows collide/i);

    // Fail-closed: the type change must not be attempted / must not have silently succeeded.
    const rows = await sql.unsafe(`SELECT COUNT(*)::int AS n FROM ${SCHEMA}.timesheet_periods`);
    expect(rows[0].n).toBe(2); // both rows still present, untouched
  });

  it('does not false-positive on two periods for the same user on genuinely different days', async () => {
    await resetSchema();

    await sql.unsafe(`
      INSERT INTO ${SCHEMA}.timesheet_periods (user_id, period_start, status)
      VALUES
        ('${USER_A}', '2026-11-01T00:00:00Z', 'draft'),
        ('${USER_A}', '2026-11-16T00:00:00Z', 'draft');
    `);

    await expect(runDuplicatePeriodGuard()).resolves.toBeUndefined();
    await runTypeChange('timesheet_periods', 'period_start');

    const rows = await sql.unsafe(`SELECT period_start::text FROM ${SCHEMA}.timesheet_periods ORDER BY period_start`);
    expect(rows.map((r: any) => r.period_start)).toEqual(['2026-11-01', '2026-11-16']);
  });

  it('keeps the 1900-01-01 effective_from sentinel working', async () => {
    await resetSchema();
    await sql.unsafe(`ALTER TABLE ${SCHEMA}.timesheet_periods ADD COLUMN effective_from timestamp with time zone`);
    await sql.unsafe(`
      INSERT INTO ${SCHEMA}.timesheet_periods (user_id, period_start, effective_from)
      VALUES ('${USER_A}', '2026-11-01T00:00:00Z', '1900-01-01T00:00:00Z');
    `);
    await runTypeChange('timesheet_periods', 'effective_from');
    const rows = await sql.unsafe(`SELECT effective_from::text FROM ${SCHEMA}.timesheet_periods`);
    expect(rows[0].effective_from).toBe('1900-01-01');
  });
});
