/**
 * A scriptable stand-in for the drizzle control-plane client in unit tests (no Postgres in the unit runner).
 * - `select(...)`: any chain (`.from().where().orderBy().limit()…`) resolves to the next scripted result for the table
 *   passed to `.from(table)` (FIFO per table), or [] when none is scripted.
 * - `insert/update/delete`: recorded (table, values / set); `.returning()` resolves to the next scripted result for
 *   that table + operation, or [].
 */

type Row = Record<string, unknown>;

export interface FakeControlDb {
  select: (fields?: unknown) => unknown;
  insert: (table: unknown) => unknown;
  update: (table: unknown) => unknown;
  delete: (table: unknown) => unknown;
  /** Script the next select result for a table. */
  onSelect(table: unknown, rows: Row[]): void;
  /** Script the next `.returning()` result of an insert/update/delete on a table. */
  onReturning(op: 'insert' | 'update' | 'delete', table: unknown, rows: Row[]): void;
  inserts: Array<{ table: unknown; values: Row }>;
  updates: Array<{ table: unknown; set: Row }>;
  deletes: Array<{ table: unknown }>;
  reset(): void;
}

export function createFakeControlDb(): FakeControlDb {
  const selects = new Map<unknown, Row[][]>();
  const returnings = new Map<string, Row[][]>();
  const tableKeys = new Map<unknown, number>();
  const keyOf = (op: string, table: unknown) => {
    if (!tableKeys.has(table)) tableKeys.set(table, tableKeys.size);
    return `${op}:${tableKeys.get(table)}`;
  };
  const next = <T>(m: Map<unknown, T[]>, k: unknown, fallback: T): T => (m.get(k)?.shift() ?? fallback);

  function chain(resolveRows: () => Row[]): unknown {
    let table: unknown;
    let resolved = false;
    let rows: Row[] = [];
    const get = () => { if (!resolved) { resolved = true; rows = table !== undefined ? next(selects, table, []) : resolveRows(); } return rows; };
    const proxy: unknown = new Proxy(() => proxy, {
      get: (_t, key) => {
        if (key === 'then') return (res: (v: Row[]) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(get()).then(res, rej);
        if (key === 'from') return (t: unknown) => { table = t; return proxy; };
        return () => proxy;
      },
    });
    return proxy;
  }

  function writeResult(op: 'insert' | 'update' | 'delete', table: unknown): unknown {
    const promise = Promise.resolve(undefined);
    const self: Record<string, unknown> = {
      onConflictDoUpdate: () => self,
      onConflictDoNothing: () => self,
      where: () => self,
      returning: async () => next(returnings, keyOf(op, table), []),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => promise.then(res, rej),
    };
    return self;
  }

  const db: FakeControlDb = {
    inserts: [], updates: [], deletes: [],
    select: () => chain(() => []),
    insert: (table) => ({ values: (values: Row) => { db.inserts.push({ table, values }); return writeResult('insert', table); } }),
    update: (table) => ({ set: (set: Row) => { db.updates.push({ table, set }); return writeResult('update', table); } }),
    delete: (table) => { db.deletes.push({ table }); return writeResult('delete', table); },
    onSelect: (table, rows) => { selects.set(table, [...(selects.get(table) ?? []), rows]); },
    onReturning: (op, table, rows) => { const k = keyOf(op, table); returnings.set(k, [...(returnings.get(k) ?? []), rows]); },
    reset: () => { selects.clear(); returnings.clear(); db.inserts = []; db.updates = []; db.deletes = []; },
  };
  return db;
}
