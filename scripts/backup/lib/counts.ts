/**
 * Exact row counts and their comparison (feature-plan-database-backups.md §6.3 `row_counts`, §6.7 step 5, U8).
 * postgres.js returns count(*) as a string, so counts are stored as JSON numbers; comparisons ignore key order and accept
 * either type.
 */

export type RowCounts = Record<string, number>;

interface CountSql {
  unsafe: (query: string) => Promise<Array<Record<string, unknown>>>;
}

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Every base table outside the system schemas, in a stable order. */
export const BASE_TABLES_SQL = `SELECT table_schema, table_name FROM information_schema.tables
  WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')
    AND table_schema NOT LIKE 'pg\\_temp%' AND table_schema NOT LIKE 'pg\\_toast%'
  ORDER BY table_schema, table_name`;

/** `count(*)` of every base table, keyed `<schema>.<table>`. Run inside the snapshot transaction for backups. */
export async function countTables(sql: CountSql): Promise<RowCounts> {
  const tables = await sql.unsafe(BASE_TABLES_SQL);
  const out: RowCounts = {};
  for (const t of tables) {
    const schema = String(t.table_schema);
    const name = String(t.table_name);
    const [row] = await sql.unsafe(`SELECT count(*) AS n FROM ${quoteIdent(schema)}.${quoteIdent(name)}`);
    out[`${schema}.${name}`] = Number(row.n);
  }
  return out;
}

export interface CountDiff {
  table: string;
  expected: number | null; // null = not in the backup's counts (an extra table)
  actual: number | null; // null = missing from the restored database
}

/** Compare two count maps: the table set and every count must be equal. Values may be numbers or numeric strings. */
export function compareCounts(expected: Record<string, unknown>, actual: Record<string, unknown>): { equal: boolean; diffs: CountDiff[] } {
  const diffs: CountDiff[] = [];
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  for (const k of keys) {
    const e = k in expected ? Number(expected[k]) : null;
    const a = k in actual ? Number(actual[k]) : null;
    if (e === null || a === null || e !== a || Number.isNaN(e) || Number.isNaN(a)) diffs.push({ table: k, expected: e, actual: a });
  }
  return { equal: diffs.length === 0, diffs };
}

/** `detail` for a MISMATCH: table names and both counts only. */
export function describeDiffs(diffs: CountDiff[]): string {
  return diffs.map((d) => `${d.table}: backup ${d.expected ?? 'absent'}, restored ${d.actual ?? 'absent'}`).join('; ');
}
