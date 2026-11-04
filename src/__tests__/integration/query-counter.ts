/**
 * feature-plan-ux-approvals-payroll.md §3.1.5 / A-4, P-1: count the queries a read makes. Wraps a drizzle client in a
 * Proxy that counts `select`, `selectDistinct` and `execute` calls (a transaction's own client isn't counted — the
 * reads measured here use none). Use it from a `vi.mock('@/db')` factory: `getDb: async () => counted.db`.
 */
export function countingDb<T extends object>(db: T): { db: T; counter: { n: number } } {
  const counter = { n: 0 };
  const proxy = new Proxy(db, {
    get(target, key, receiver) {
      const v = Reflect.get(target, key, receiver);
      if (typeof v !== 'function') return v;
      if (key === 'select' || key === 'selectDistinct' || key === 'execute') {
        return (...args: unknown[]) => { counter.n += 1; return (v as (...a: unknown[]) => unknown).apply(target, args); };
      }
      return (v as (...a: unknown[]) => unknown).bind(target);
    },
  });
  return { db: proxy, counter };
}
