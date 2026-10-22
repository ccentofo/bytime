import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * feature-plan-terms-compliance-fixes.md §5.1 locked-section rule: inside a function that receives the locked
 * transaction `tx`, every statement must use `tx`. Using `controlDb` (another pool) or `withLockedPool` /
 * `withTenantLock` (a second connection from the same 3-connection pool) while holding the lock can deadlock the
 * pool or escape the transaction.
 */

const ROOT = path.resolve(__dirname, '../../..');
const LOCKED_FILES = [
  'src/lib/billing/reconcile.ts',
  'src/lib/billing/tenant-billing.ts',
  'src/lib/billing/stripe-state.ts',
  'src/lib/tenant/notices.ts',
  'src/lib/tenant/lifecycle-store.ts',
  'src/lib/tenant/lifecycle-runner.ts',
  'src/lib/tenant/delete-tenant.ts',
  'src/lib/tenant/provision.ts',
  'src/app/api/stripe/webhook/route.ts',
  'src/app/api/cron/tenant-lifecycle/route.ts',
  'src/lib/tenant/admin-commands.ts',
  'scripts/tenant-admin.ts',
  'scripts/backfill-trial-dates.ts',
];
const FORBIDDEN_IN_TX = /\bcontrolDb\b|\bwithLockedPool\s*\(|\bwithTenantLock\s*\(|\bgetLockedDb\s*\(/;

function matchClose(src: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return i;
  }
  return src.length;
}

/** The parameter list with nested (), {}, <>, [] contents removed, so a `tx` inside a callback TYPE doesn't count. */
function topLevel(params: string): string {
  let depth = 0;
  let out = '';
  for (const c of params) {
    if ('({<['.includes(c)) depth++;
    else if (')}>]'.includes(c)) depth = Math.max(0, depth - 1);
    else if (depth === 0) out += c;
  }
  return out;
}

/** Bodies of every function/arrow whose parameter list contains `tx` (paren/brace-matched, comments stripped). */
export function txFunctionBodies(raw: string): string[] {
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
  const bodies: string[] = [];
  // Function declarations: balance the parameter list, then skip the return type (angle-bracket aware).
  const fn = /function\s+\w+\s*(?:<[^>]*>)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = fn.exec(source)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(source, open, '(', ')');
    if (!/(^|,)\s*tx\s*\??\s*:/.test(topLevel(source.slice(open + 1, close)))) continue;
    let angle = 0;
    let i = close + 1;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === '<') angle++;
      else if (c === '>' && source[i - 1] !== '=') angle--;
      else if (c === '{' && angle === 0) break;
    }
    bodies.push(source.slice(i + 1, matchClose(source, i, '{', '}')));
  }
  // Arrow functions whose first parameter is tx: `(tx) => {`, `async (tx): Promise<X> => {`.
  const arrow = /\(\s*tx\b[^)]*\)\s*(?::\s*[^={]+)?=>\s*\{/g;
  while ((m = arrow.exec(source)) !== null) {
    const open = m.index + m[0].length - 1;
    bodies.push(source.slice(open + 1, matchClose(source, open, '{', '}')));
  }
  return bodies;
}

/**
 * Names of top-level functions (across all scanned files) that take a pool connection, directly or through
 * another such function — calling one inside a locked section is the same violation, one call removed.
 */
export function poolUsingFunctions(sources: string[]): Set<string> {
  const chunks: Array<{ name: string; text: string }> = [];
  for (const src of sources) {
    const lines = src.split('\n');
    let current: { name: string; text: string } | null = null;
    for (const line of lines) {
      const decl = /^(?:export\s+)?(?:async\s+)?(?:function\s+|const\s+|let\s+)(\w+)/.exec(line);
      if (decl) {
        current = { name: decl[1], text: '' };
        chunks.push(current);
        current.text += line.slice(decl[0].length) + '\n';
      } else if (current) {
        current.text += line + '\n';
      }
    }
  }
  const users = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const c of chunks) {
      if (users.has(c.name)) continue;
      const callsUser = [...users].some((u) => new RegExp(`\\b${u}\\s*\\(`).test(c.text));
      if (FORBIDDEN_IN_TX.test(c.text) || callsUser) {
        users.add(c.name);
        changed = true;
      }
    }
  }
  return users;
}

describe('locked sections use only the passed tx (§5.1)', () => {
  const sources = LOCKED_FILES.map((f) => readFileSync(path.join(ROOT, f), 'utf8'));
  const poolUsers = poolUsingFunctions(sources);
  const callsPoolUser = (body: string) => [...poolUsers].find((u) => new RegExp(`\\b${u}\\s*\\(`).test(body)) ?? null;

  LOCKED_FILES.forEach((file, idx) => {
    it(file, () => {
      for (const body of txFunctionBodies(sources[idx])) {
        const hit = FORBIDDEN_IN_TX.exec(body)?.[0] ?? callsPoolUser(body);
        expect(hit, `${file}: "${hit}" inside a function that holds the tenant lock`).toBeNull();
      }
    });
  });

  it('the pool-user analysis finds the known helpers', () => {
    for (const name of ['deliverNotice', 'voidSubscriptionInvoices', 'restore', 'noticeStates', 'ensureStripeCustomer']) {
      expect(poolUsers.has(name), name).toBe(true);
    }
    for (const name of ['reconcileInLock', 'evaluateInLock', 'readNoticeStates', 'updateTenantGuarded']) {
      expect(poolUsers.has(name), name).toBe(false);
    }
  });

  it('the scan finds tx functions (guards against the regex silently matching nothing)', () => {
    const source = readFileSync(path.join(ROOT, 'src/lib/billing/reconcile.ts'), 'utf8');
    expect(txFunctionBodies(source).length).toBeGreaterThan(0);
    const webhook = readFileSync(path.join(ROOT, 'src/app/api/stripe/webhook/route.ts'), 'utf8');
    expect(txFunctionBodies(webhook).length).toBeGreaterThan(0);
  });

  it('mutation check: a controlDb use inside a tx arrow is caught', () => {
    const bad = `await withTenantLock(id, async (tx) => { const r = await readTenant(tx, id); await controlDb.update(x); });`;
    expect(txFunctionBodies(bad).some((b) => FORBIDDEN_IN_TX.test(b))).toBe(true);
    const badFn = `async function evaluateInLock(tx: ControlTx, id: string) { if (a) { b(); } await withLockedPool((db) => db); }`;
    expect(txFunctionBodies(badFn).some((b) => FORBIDDEN_IN_TX.test(b))).toBe(true);
    // Parameter lists with object types and comments containing ')' (the reconcileInLock shape).
    const tricky = `export async function reconcileInLock(tx: ControlTx, row: R, now: Date, opts: {
  /** Extra (see §4.3). */
  extraPatch?: P;
} = {}): Promise<Array<{ id: string }>> {
  const a = { b: 1 };
  await controlDb.select();
}`;
    expect(txFunctionBodies(tricky).some((b) => FORBIDDEN_IN_TX.test(b))).toBe(true);
    // A tx inside a callback TYPE of a function that does not itself hold the lock is not a locked section.
    const callbackType = `async function lockedChange(slug: string, plan: (row: R) => { after?: (tx: T) => Promise<void> }) { await withTenantLock(id, async (tx) => { await tx.update(x); }); }`;
    expect(txFunctionBodies(callbackType).some((b) => FORBIDDEN_IN_TX.test(b))).toBe(false);
    const ok = `await withTenantLock(id, async (tx) => { await tx.update(x); }); await withLockedPool((db) => db);`;
    expect(txFunctionBodies(ok).some((b) => FORBIDDEN_IN_TX.test(b))).toBe(false);
  });
});
