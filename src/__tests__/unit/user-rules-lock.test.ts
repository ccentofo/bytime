import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { parseExportedFunctions, stripComments } from '../helpers/source-scanner';

/**
 * Certified outputs fix round 1, F1: every writer of users.role / is_active / approver_id takes the user-rules advisory
 * lock EXCLUSIVELY as the first statement of its transaction (before any row lock); approve/reject take it SHARED as
 * the first statement of the decision transaction and re-run canApprove under it. The concurrency behaviour itself
 * (no 40P01, no log drift, a waiting approval refused) is in integration/user-rules-lock.test.ts.
 */

const ROOT = path.resolve(__dirname, '../../..');

/** The six enumerated writers (CERTIFIED-OUTPUTS-AUDIT.md F1). */
const WRITERS: Array<{ file: string; fn: string }> = [
  { file: 'src/server/actions/users.ts', fn: 'updateUser' },
  { file: 'src/server/actions/users.ts', fn: 'createUserWithPassword' },
  { file: 'src/server/actions/users.ts', fn: 'setUserApprover' },
  { file: 'src/server/actions/import.ts', fn: 'bulkImportEmployees' },
  { file: 'src/lib/tenant/provision.ts', fn: 'provisionTenant' },
];

/** The first `await …;` statement inside each `.transaction(async (tx) => {` in `body`. */
export function firstStatementsOfTransactions(body: string): string[] {
  const out: string[] = [];
  const open = /\bdb\.transaction\(async \((\w+)\) => \{/g; // the outer transaction (not savepoints)
  for (let m = open.exec(body); m; m = open.exec(body)) {
    const rest = body.slice(m.index + m[0].length);
    const stmt = /^\s*([^;]*;)/.exec(rest);
    out.push(stmt ? stmt[1].trim() : '');
  }
  return out;
}

const LOCK_FIRST = /^await lockUserRulesExclusive\(tx\);$/;

describe('F1 — user-rules lock', () => {
  it('every enumerated writer opens exactly one transaction and its first statement is the exclusive lock', () => {
    for (const w of WRITERS) {
      const fn = parseExportedFunctions(stripComments(readFileSync(path.join(ROOT, w.file), 'utf8'))).find((f) => f.name === w.fn);
      expect(fn, `${w.file} ${w.fn}`).toBeDefined();
      const firsts = firstStatementsOfTransactions(fn!.bodyText);
      expect(firsts.length, `${w.fn} transactions`).toBe(1);
      expect(firsts[0], w.fn).toMatch(LOCK_FIRST);
    }
  });

  it('fixture: a writer whose transaction starts with a row lock (or has no lock) is flagged', () => {
    const bad = `const r = await db.transaction(async (tx) => {
      const [t] = await tx.select().from(users).where(eq(users.id, id)).for('update');
      await lockUserRulesExclusive(tx);
    });`;
    expect(firstStatementsOfTransactions(bad)[0]).not.toMatch(LOCK_FIRST);
    expect(firstStatementsOfTransactions('await db.transaction(async (tx) => { await recomputeSelfApproval(tx, a, b); });')[0]).not.toMatch(LOCK_FIRST);
    expect(firstStatementsOfTransactions('await db.transaction(async (tx) => {\n  await lockUserRulesExclusive(tx); // F1\n  x();\n});')[0]).toMatch(LOCK_FIRST);
  });

  it('approve/reject: the decision transaction starts with the SHARED lock, then re-reads the facts and re-runs canApprove', () => {
    const src = stripComments(readFileSync(path.join(ROOT, 'src/server/actions/periods.ts'), 'utf8'));
    const decide = src.slice(src.indexOf('async function decidePeriod('), src.indexOf('export async function approvePeriod'));
    expect(firstStatementsOfTransactions(decide)).toEqual(['await lockUserRulesShared(tx);']);
    const tx = decide.slice(decide.indexOf('db.transaction(async (tx) => {'));
    expect(tx.indexOf('await loadApprovalFacts(tx)')).toBeGreaterThan(tx.indexOf('await lockUserRulesShared(tx);'));
    expect(tx.indexOf('canApprove(current, actor.id, period.userId)')).toBeGreaterThan(tx.indexOf('await loadApprovalFacts(tx)'));
    expect(tx.indexOf('canApprove(current, actor.id, period.userId)')).toBeLessThan(tx.indexOf('tx.update(timesheetPeriods)'));
  });

  it('the seeder also serializes its self-approval baseline', () => {
    expect(readFileSync(path.join(ROOT, 'scripts/seed-full.ts'), 'utf8')).toMatch(/await lockUserRulesExclusive\(tx as never\); await recomputeSelfApproval\(/);
  });
});

// ── feature-plan-approval-scope.md S5, §4.1 (AS-17) ─────────────────────────────────────────────────────────────────

/** Every .ts/.tsx file under `dir` (relative to ROOT), skipping tests. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (rel === 'src/__tests__' || name === 'node_modules') continue;
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}
/** Files whose code writes approval_scopes (`insert(approvalScopes)` / `update(approvalScopes)`, any namespace). */
export function approvalScopeWriters(files: Array<{ rel: string; src: string }>): string[] {
  return files.filter((f) => /\.(insert|update)\(\s*(?:\w+\.)?approvalScopes\s*\)/.test(stripComments(f.src))).map((f) => f.rel);
}
/** Files importing internal/approval-scopes (the three write helpers). */
export function approvalScopeHelperImporters(files: Array<{ rel: string; src: string }>): string[] {
  return files.filter((f) => /from ['"](?:@\/server\/internal|\.\.?(?:\/[\w.-]+)*)\/approval-scopes['"]/.test(f.src)).map((f) => f.rel);
}

describe('approval scope writes (AS-17)', () => {
  const files = [...sourceFiles('src'), ...sourceFiles('scripts')].map((rel) => ({ rel, src: readFileSync(path.join(ROOT, rel), 'utf8') }));

  it('scopeChange opens one transaction whose first statement is the exclusive lock', () => {
    const fn = parseExportedFunctions(stripComments(readFileSync(path.join(ROOT, 'src/server/internal/approval-rules.ts'), 'utf8'))).find((f) => f.name === 'scopeChange');
    expect(fn).toBeDefined();
    expect(firstStatementsOfTransactions(fn!.bodyText)).toHaveLength(1);
    expect(firstStatementsOfTransactions(fn!.bodyText)[0]).toMatch(LOCK_FIRST);
  });

  it('approval_scopes is written only in internal/approval-scopes.ts and the seed (src/ and scripts/, tests excluded)', () => {
    for (const w of approvalScopeWriters(files)) expect(['src/server/internal/approval-scopes.ts', 'scripts/seed-full.ts'], w).toContain(w);
  });

  it('the write helpers are imported only by the allowed modules', () => {
    const allowed = ['src/server/internal/approval-rules.ts', 'src/server/actions/assignments.ts', 'src/server/actions/import.ts', 'src/server/actions/users.ts'];
    for (const f of approvalScopeHelperImporters(files)) expect(allowed, f).toContain(f);
  });

  it('fixture: the scans flag a stray writer and a stray importer', () => {
    const fake = [
      { rel: 'src/x.ts', src: "await tx.update(approvalScopes).set({ isActive: false });" },
      { rel: 'scripts/y.ts', src: "await db.insert(schema.approvalScopes).values({});" },
      { rel: 'src/ok.ts', src: "// tx.update(approvalScopes) in a comment\nawait tx.delete(approvalScopes);" },
      { rel: 'src/z.ts', src: "import { grantScopeRows } from '@/server/internal/approval-scopes';" },
      { rel: 'src/w.ts', src: "import { grantScopeRows } from './approval-scopes';" },
    ];
    expect(approvalScopeWriters(fake)).toEqual(['src/x.ts', 'scripts/y.ts']);
    expect(approvalScopeHelperImporters(fake)).toEqual(['src/z.ts', 'src/w.ts']);
  });
});
