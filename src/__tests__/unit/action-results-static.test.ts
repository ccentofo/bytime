import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { stripComments, parseExportedFunctions, parameterNames, writePayloads } from '../helpers/source-scanner';

/**
 * feature-plan-launch-blockers.md P4 — static checks for the action-result contract:
 * 1. expected errors are typed (no `throw new Error(` in actions / validation / internal, except justified invariants);
 * 2. no server action calls another server action (shared logic lives in src/server/internal/*);
 * 3. internal writers take the caller's client (TenantWriter/DbTx/…) and never obtain one themselves;
 * 4. every awaited call of a converted action has its result consumed — per call site.
 * Each rule has a fixture proving it fires.
 */

const SRC = path.resolve(__dirname, '../..');
const ACTIONS_DIR = path.join(SRC, 'server/actions');
const INTERNAL_DIR = path.join(SRC, 'server/internal');

const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = path.join(dir, e.name);
  if (e.isDirectory()) return e.name === 'node_modules' || e.name === '__tests__' ? [] : walk(full);
  return /\.tsx?$/.test(e.name) ? [full] : [];
});
const rel = (f: string) => path.relative(SRC, f);
const read = (f: string) => stripComments(fs.readFileSync(f, 'utf-8'));

// ---------------------------------------------------------------------------
// 1. Typed expected errors
// ---------------------------------------------------------------------------

/** True invariant violations allowed to stay plain Errors (file → justification). None today. */
const THROW_ALLOWLIST: Record<string, string> = {};

const PLAIN_THROW = /\bthrow\s+new\s+Error\s*\(/;

function plainThrowFiles(files: Array<{ name: string; source: string }>): string[] {
  return files.filter((f) => PLAIN_THROW.test(f.source) && !(f.name in THROW_ALLOWLIST)).map((f) => f.name);
}

// ---------------------------------------------------------------------------
// 2. No action-to-action calls
// ---------------------------------------------------------------------------

const ACTION_IMPORT = /from\s+['"](?:@\/server\/actions\/[^'"]+|\.\/[^'"]+)['"]/g;

function actionCrossImports(source: string): string[] {
  return [...source.matchAll(ACTION_IMPORT)].map((m) => m[0]);
}

function sameFileActionCalls(source: string): string[] {
  const fns = parseExportedFunctions(source);
  const names = fns.map((f) => f.name);
  const out: string[] = [];
  for (const fn of fns) {
    for (const other of names) {
      if (other !== fn.name && new RegExp(`(?<![.\\w])${other}\\s*\\(`).test(fn.bodyText)) out.push(`${fn.name} → ${other}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Internal writers take the caller's client
// ---------------------------------------------------------------------------

const INTERNAL_WRITE = /\b(?:db|tx|executor|writer)\s*\.\s*(?:insert|update|delete)\s*\(|\.execute\(\s*sql`\s*(?:insert|update|delete)\b/i;
const CLIENT_PARAM = /:\s*(?:[^,)]*\b)?(?:TenantWriter|DbTx|WriteDb|AuthDb|AttemptsWriter)\b/;
const OBTAINS_CLIENT = /\bgetDb\w*\s*\(|\bgetDbForUrl\s*\(/;

function internalWriterViolations(source: string): string[] {
  const fns = parseExportedFunctions(source);
  // Writers: write directly, or call a writer of the same file (fixpoint).
  const writers = new Set(fns.filter((f) => INTERNAL_WRITE.test(f.bodyText)).map((f) => f.name));
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of fns) {
      if (writers.has(f.name)) continue;
      if ([...writers].some((w) => new RegExp(`(?<![.\\w])${w}\\s*\\(`).test(f.bodyText))) { writers.add(f.name); grew = true; }
    }
  }
  const out: string[] = [];
  for (const f of fns.filter((fn) => writers.has(fn.name))) {
    if (!CLIENT_PARAM.test(f.paramText)) out.push(`${f.name}: writes but takes no TenantWriter/DbTx client parameter`);
    if (OBTAINS_CLIENT.test(f.bodyText)) out.push(`${f.name}: writes and obtains its own client (getDb*/getDbForUrl)`);
  }
  return out;
}

function massAssignment(source: string): string[] {
  const out: string[] = [];
  for (const fn of parseExportedFunctions(source)) {
    for (const param of parameterNames(fn.paramText)) {
      const whole = new RegExp(`^\\s*${param}\\s*(as\\b[\\s\\S]*)?$`);
      const spread = new RegExp(`\\.\\.\\.\\s*${param}\\b`);
      for (const payload of writePayloads(fn.bodyText)) {
        if (whole.test(payload) || spread.test(payload)) out.push(`${fn.name}(${param})`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Callers consume results — per call site
// ---------------------------------------------------------------------------

/** Exported actions whose body is `return userAction(...)`, by import specifier. */
function convertedActions(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const f of fs.readdirSync(ACTIONS_DIR).filter((n) => n.endsWith('.ts'))) {
    const names = parseExportedFunctions(read(path.join(ACTIONS_DIR, f)))
      .filter((fn) => /^\{\s*return\s+userAction\s*\(/.test(fn.bodyText))
      .map((fn) => fn.name);
    map.set(`@/server/actions/${f.replace(/\.ts$/, '')}`, new Set(names));
  }
  return map;
}

/** Local names this file imports for converted actions. */
function importedConverted(source: string, converted: Map<string, Set<string>>): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g)) {
    if (m[1]) continue;
    const set = converted.get(m[3]);
    if (!set) continue;
    for (const spec of m[2].split(',').map((x) => x.trim()).filter(Boolean)) {
      if (spec.startsWith('type ')) continue;
      const [orig, alias] = spec.split(/\s+as\s+/);
      if (set.has(orig)) out.push(alias ?? orig);
    }
  }
  return out;
}

/**
 * Call sites of `names` whose result is not consumed. Consumed means: wrapped in runAction(...); returned to the
 * caller (`return [await] name(`); or assigned (`const|let x = [await] name(`) with `x.ok` / `x?.ok` read afterwards.
 */
function uncheckedCallSites(source: string, names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    const re = new RegExp(`(?<![.\\w])${name}\\s*\\(`, 'g');
    for (const m of source.matchAll(re)) {
      const before = source.slice(Math.max(0, m.index! - 200), m.index!);
      if (/import\s*\{[^}]*$/.test(before)) continue;                       // inside an import list
      if (/runAction\(\s*(?:await\s+)?$/.test(before)) continue;
      if (/\breturn\s+(?:await\s+)?$/.test(before)) continue;
      const assign = /\b(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*(?:await\s+)?$/.exec(before);
      if (assign) {
        const after = source.slice(m.index!);
        if (new RegExp(`\\b${assign[1]}\\s*(?:\\?\\.|\\.)\\s*ok\\b`).test(after)) continue;
      }
      const line = source.slice(0, m.index!).split('\n').length;
      out.push(`${name}() at line ${line}`);
    }
  }
  return out;
}

/** Files whose action calls the per-call-site check must cover. */
function callSiteFiles(): string[] {
  const clientFiles = walk(SRC).filter((f) => /^\s*['"]use client['"]/.test(read(f)));
  const extra = [path.join(SRC, 'lib/offline/sync-service.ts'), path.join(SRC, 'components/timesheet/TimesheetToolbar.tsx')];
  return [...new Set([...clientFiles, ...extra])];
}

/** Non-action functions whose results must also be consumed, per file (they return ActionResult). */
const RESULT_RETURNING_CALLS: Record<string, string[]> = {};

// ---------------------------------------------------------------------------

describe('action-result contract (static, launch-blockers P4)', () => {
  it('no plain `throw new Error(` in actions, validation, or internal helpers (except justified invariants)', () => {
    const files = [...walk(ACTIONS_DIR), ...walk(INTERNAL_DIR), path.join(SRC, 'lib/validation.ts')]
      .map((f) => ({ name: rel(f), source: read(f) }));
    expect(plainThrowFiles(files)).toEqual([]);
  });

  it('the throw check flags a new plain Error (fixture)', () => {
    expect(plainThrowFiles([{ name: 'server/actions/x.ts', source: "if (!ok) throw new Error('nope');" }])).toEqual(['server/actions/x.ts']);
    expect(plainThrowFiles([{ name: 'server/actions/y.ts', source: "throw new UserFacingError('nope');" }])).toEqual([]);
  });

  it('THROW_ALLOWLIST has no stale entries', () => {
    for (const file of Object.keys(THROW_ALLOWLIST)) {
      const full = path.join(SRC, file);
      expect(fs.existsSync(full) && PLAIN_THROW.test(read(full)), `${file} no longer throws a plain Error — remove it`).toBe(true);
    }
  });

  it('no actions module imports another actions module', () => {
    const offenders = walk(ACTIONS_DIR).flatMap((f) => actionCrossImports(read(f)).map((imp) => `${rel(f)}: ${imp}`));
    expect(offenders).toEqual([]);
  });

  it('no exported action calls another exported action of the same file', () => {
    const offenders = walk(ACTIONS_DIR).flatMap((f) => sameFileActionCalls(read(f)).map((c) => `${rel(f)}: ${c}`));
    expect(offenders).toEqual([]);
  });

  it('none of the seven listed action-to-action calls remain', () => {
    const src = (f: string) => read(path.join(ACTIONS_DIR, f));
    const body = (f: string, fn: string) => parseExportedFunctions(src(f)).find((x) => x.name === fn)?.bodyText ?? '';
    expect(src('qbo.ts')).not.toMatch(/(?<![.\w])createCostClass\s*\(|(?<![.\w])createChargeCode\s*\(/);
    expect(body('charge-codes.ts', 'assignAllUnderClin')).not.toMatch(/(?<![.\w])assignChargeCodeToUser\s*\(/);
    expect(body('migration.ts', 'importMigrationData')).not.toMatch(/(?<![.\w])validateMigrationData\s*\(/);
    expect(body('pay-period-config.ts', 'getCurrentEffectiveConfig')).not.toMatch(/(?<![.\w])getEffectiveConfigAt\s*\(/);
    expect(body('pay-period-config.ts', 'getPayPeriodConfig')).not.toMatch(/(?<![.\w])getCurrentEffectiveConfig\s*\(/);
    expect(body('signup.ts', 'startSignup')).not.toMatch(/(?<![.\w])checkSlugAvailable\s*\(/);
    expect(src('employee-dashboard.ts')).not.toMatch(/from '@\/server\/actions\//);
  });

  it('the action-to-action checks fire (fixtures)', () => {
    expect(actionCrossImports("import { a } from '@/server/actions/charge-codes';")).toHaveLength(1);
    expect(actionCrossImports("import { a } from './charge-codes';")).toHaveLength(1);
    expect(actionCrossImports("import { a } from '@/server/internal/charge-codes';")).toHaveLength(0);
    const fixture = `
      export async function one() { return userAction(async () => { await requireSession(); return two(); }); }
      export async function two() { return userAction(async () => { await requireSession(); }); }`;
    expect(sameFileActionCalls(fixture)).toEqual(['one → two']);
  });

  it('internal writers take the caller’s client and never obtain one', () => {
    const offenders = walk(INTERNAL_DIR).flatMap((f) => internalWriterViolations(read(f)).map((v) => `${rel(f)}: ${v}`));
    expect(offenders).toEqual([]);
  });

  it('an internal writer that calls getDbForWrite is flagged (fixture)', () => {
    const bad = `export async function saveThing(name: string) { const db = await getDbForWrite(); await db.insert(t).values({ name }); }`;
    expect(internalWriterViolations(bad)).toEqual([
      'saveThing: writes but takes no TenantWriter/DbTx client parameter',
      'saveThing: writes and obtains its own client (getDb*/getDbForUrl)',
    ]);
    const transitive = `
      export async function write(db: TenantWriter) { await db.insert(t).values({ a: 1 }); }
      export function wrapper() { return getDbForWrite().then((db) => write(db)); }`;
    expect(internalWriterViolations(transitive)).toEqual([
      'wrapper: writes but takes no TenantWriter/DbTx client parameter',
      'wrapper: writes and obtains its own client (getDb*/getDbForUrl)',
    ]);
    const good = `export async function write(db: TenantWriter, name: string) { await db.insert(t).values({ name }); }`;
    expect(internalWriterViolations(good)).toEqual([]);
  });

  it('internal writers never pass or spread a raw caller-supplied parameter into a write (mass assignment)', () => {
    const offenders = walk(INTERNAL_DIR).flatMap((f) => massAssignment(read(f)).map((v) => `${rel(f)}: ${v}`));
    expect(offenders).toEqual([]);
  });

  it('every awaited call of a converted action has its result consumed (per call site)', () => {
    const converted = convertedActions();
    const offenders: string[] = [];
    for (const file of callSiteFiles()) {
      if (!fs.existsSync(file)) continue;
      const source = read(file);
      const names = [...importedConverted(source, converted), ...(RESULT_RETURNING_CALLS[rel(file)] ?? [])];
      for (const site of uncheckedCallSites(source, names)) offenders.push(`${rel(file)}: ${site}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the client check flags an unchecked awaited action (fixture)', () => {
    const fixture = `
      'use client';
      import { saveThing } from '@/server/actions/things';
      async function onSave() { await saveThing({ a: 1 }); toast('Saved'); }`;
    const names = importedConverted(fixture, new Map([['@/server/actions/things', new Set(['saveThing'])]]));
    expect(names).toEqual(['saveThing']);
    expect(uncheckedCallSites(fixture, names)).toEqual(['saveThing() at line 4']);
  });

  it('the per-call-site check flags an ignored result in a file that checks another call (fixture)', () => {
    const fixture = [
      "import { saveThing, runAction } from '@/server/actions/things';",
      'async function a() { const r = await saveThing(1); if (!r.ok) return; }',
      'async function b() { await runAction(saveThing(2)); }',
      'async function c() { return saveThing(3); }',
      'async function d() { const x = await saveThing(4); console.log(x); }',
      'async function e() { await saveThing(5); }',
    ].join('\n');
    expect(uncheckedCallSites(fixture, ['saveThing'])).toEqual(['saveThing() at line 5', 'saveThing() at line 6']);
  });
});
