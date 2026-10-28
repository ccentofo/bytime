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

const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);

/** Index of the brace matching the `{` at `open` (or the end of the source). */
function matchingBrace(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return i;
  }
  return source.length;
}

/** Does the `{` at `open` start a FUNCTION body (vs. an if/for/try block or an object literal)? */
function opensFunctionBody(source: string, open: number): boolean {
  const before = source.slice(0, open).trimEnd();
  if (before.endsWith('=>')) return true;
  // A return-type annotation sits between `)` and `{`: `function f(x): Promise<T> {`.
  const head = before.replace(/\)\s*:\s*[^(){};=]+$/, ')');
  if (!head.endsWith(')')) return false;
  let depth = 0;
  for (let i = head.length - 1; i >= 0; i--) {
    if (head[i] === ')') depth++;
    else if (head[i] === '(' && --depth === 0) {
      const word = /(\w+)\s*$/.exec(head.slice(0, i))?.[1] ?? '';
      return !CONTROL_KEYWORDS.has(word);
    }
  }
  return false;
}

/**
 * Launch-blockers audit A8: the end of the innermost enclosing FUNCTION around `index` — a result check must sit in
 * the same function as the call, not anywhere later in the file. Walks outward past if/for/try/object blocks.
 */
function enclosingFunctionEnd(source: string, index: number): number {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    if (source[i] === '}') depth++;
    else if (source[i] === '{') {
      if (depth > 0) { depth--; continue; }
      if (opensFunctionBody(source, i)) return matchingBrace(source, i);
    }
  }
  return source.length;
}

/**
 * The variable(s) a call's value is assigned to, if the call is part of the right-hand side of an assignment in the
 * same statement: `x = [await] call(`, `x = cond ? await a(…) : await call(`, `const [a, b] = await Promise.all([…call(…)])`.
 * The nearest preceding `=` whose right-hand side is bracket-balanced up to the call and has no top-level `;`.
 */
function assignedNames(source: string, index: number): string[] {
  const windowStart = Math.max(0, index - 2000);
  const window = source.slice(windowStart, index);
  const assigns = [...window.matchAll(/(?:\b(?:const|let)\s+)?(\[[^\]=;]*\]|\b\w+)\s*(?::[^=;(){}\n]+)?(?<![=!<>])=(?![=>])/g)];
  for (let k = assigns.length - 1; k >= 0; k--) {
    const a = assigns[k];
    const rhs = window.slice(a.index! + a[0].length);
    let depth = 0;
    let ok = true;
    for (const ch of rhs) {
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) { if (--depth < 0) { ok = false; break; } }
      else if (ch === ';' && depth === 0) { ok = false; break; }
    }
    if (!ok) continue;
    const target = a[1];
    if (!target.startsWith('[')) return [target];
    return target.slice(1, -1).split(',').map((x) => x.trim().replace(/^\.\.\./, '').split(/\s*=/)[0]).filter((x) => /^\w+$/.test(x));
  }
  return [];
}

/**
 * Call sites of `names` whose result is not consumed. Consumed means: wrapped in runAction(...); returned to the
 * caller (`return [await] name(` or an arrow body `=> name(`); or assigned (`[const|let] x = [await] name(`) with
 * `x.ok` / `x?.ok` read later IN THE SAME FUNCTION (audit A8 — a same-named variable in another function doesn't count).
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
      if (/=>\s*(?:await\s+)?$/.test(before)) {
        // An arrow body returns the result — but not to a JSX event handler (onClick={() => save(x)} discards it),
        // unless the prop's own type returns the result to a component that checks it (RESULT_RETURNING_PROPS).
        const handler = /\b(on[A-Z]\w*)=\{\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>\s*(?:await\s+)?$/.exec(before);
        if (!handler || RESULT_RETURNING_PROPS.has(handler[1])) continue;
      }
      const assigned = assignedNames(source, m.index!);
      if (assigned.length > 0) {
        const after = source.slice(m.index!, enclosingFunctionEnd(source, m.index!));
        if (assigned.every((v) => new RegExp(`\\b${v}\\s*(?:\\?\\.|\\.)\\s*ok\\b`).test(after))) continue;
      }
      const line = source.slice(0, m.index!).split('\n').length;
      out.push(`${name}() at line ${line}`);
    }
  }
  return out;
}

/** The body of the function whose `{` is at `open`, with nested function bodies blanked (their returns aren't its own). */
function ownBody(source: string, open: number): string {
  const close = matchingBrace(source, open);
  let out = '';
  for (let i = open + 1; i < close; i++) {
    if (source[i] === '{' && opensFunctionBody(source, i)) {
      i = matchingBrace(source, i);
      out += '{}';
      continue;
    }
    out += source[i];
  }
  return out;
}

/**
 * Launch-blockers audit A7/A8: a local helper that calls an action (directly or via runAction) and is itself AWAITED
 * elsewhere in the file must return the outcome — a helper that returns void swallows the result, and its caller can
 * only assume success (Gusto auto-match counted failed saves as matched).
 */
function voidAwaitedWrappers(source: string, actionNames: string[]): string[] {
  const defs = [
    ...source.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/g),
    ...source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*(?::[^=;{}]+)?=>\s*\{/g),
  ];
  const callsAction = new RegExp(`(?<![.\\w])(?:${[...actionNames, 'runAction'].join('|')})\\s*\\(`);
  const out: string[] = [];
  for (const d of defs) {
    const name = d[1];
    let open = source.indexOf('{', d.index! + d[0].length - 1);
    while (open !== -1 && !opensFunctionBody(source, open)) open = source.indexOf('{', open + 1);
    if (open === -1) continue;
    const close = matchingBrace(source, open);
    const body = source.slice(open, close);
    if (!callsAction.test(body)) continue;
    const outside = source.slice(0, d.index!) + source.slice(close);
    if (!new RegExp(`\\bawait\\s+${name}\\s*\\(`).test(outside)) continue;
    if (/\breturn\s+(?!;)[^\s;]/.test(ownBody(source, open))) continue;
    out.push(`${name}: awaited wrapper returns void`);
  }
  return out;
}

/** Files whose action calls the per-call-site check must cover. */
function callSiteFiles(): string[] {
  const clientFiles = walk(SRC).filter((f) => /^\s*['"]use client['"]/.test(read(f)));
  const extra = [path.join(SRC, 'components/timesheet/TimesheetToolbar.tsx')];
  return [...new Set([...clientFiles, ...extra])];
}

/** JSX props typed to return ActionResult to a component that checks it (ImportWizard's onImport). */
const RESULT_RETURNING_PROPS = new Set(['onImport']);

/** Non-action functions whose results must also be consumed, per file (they return ActionResult). */
const RESULT_RETURNING_CALLS: Record<string, string[]> = {
  'components/timesheet/TimesheetToolbar.tsx': ['saveAll', 'submitTimesheet'],
};

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
      const actions = importedConverted(source, converted);
      // A runAction(...) result is a RunResult: it must be consumed like the action's own (audit A8).
      const usesRunAction = /\bimport\s*\{[^}]*\brunAction\b[^}]*\}\s*from\s*['"]@\/lib\/run-action['"]/.test(source);
      const names = [...actions, ...(usesRunAction ? ['runAction'] : []), ...(RESULT_RETURNING_CALLS[rel(file)] ?? [])];
      for (const site of uncheckedCallSites(source, names)) offenders.push(`${rel(file)}: ${site}`);
      for (const w of voidAwaitedWrappers(source, actions)) offenders.push(`${rel(file)}: ${w}`);
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
      'const g = <Button onClick={() => saveThing(7)} />;',
      'const h = <ImportWizard onImport={(rows) => saveThing(rows)} />;',
      'async function f(code: string, note: string) {\n  const res = await saveThing(6);\n  if (!res.ok) return;\n}',
    ].join('\n');
    expect(uncheckedCallSites(fixture, ['saveThing'])).toEqual(['saveThing() at line 5', 'saveThing() at line 6', 'saveThing() at line 7']);
  });

  it('a .ok check in ANOTHER function doesn’t count for this call (fixture, audit A8)', () => {
    const fixture = [
      'async function checked() {',
      '  const result = await saveThing(1);',
      '  if (!result.ok) return;',
      '}',
      'async function unchecked() {',
      '  const result = await saveThing(2);',
      '  toast("Saved");',
      '}',
      'async function nested() {',
      '  const result = await saveThing(3);',
      '  if (cond) { try { log(); } finally { done(); } }',
      '  if (result.ok) toast("ok");',
      '}',
      'async function typed(x: string): Promise<void> {',
      '  let result;',
      '  try { result = await saveThing(4); } catch { return; }',
      '  if (!result.ok) return;',
      '}',
      'async function ternary() {',
      '  const result = cond',
      '    ? await saveThing({ a: 1 })',
      '    : await saveThing({ b: 2 });',
      '  if (!result.ok) return;',
      '}',
      'async function all() {',
      '  const [p, q] = await Promise.all([saveThing(5), saveThing(6)]);',
      '  if (!p.ok) return;',
      '}',
    ].join('\n');
    // line 6: unchecked in its own function; line 26: q is never checked (every destructured result must be).
    expect(uncheckedCallSites(fixture, ['saveThing'])).toEqual(['saveThing() at line 6', 'saveThing() at line 26', 'saveThing() at line 26']);
  });

  it('an unconsumed runAction(...) result is flagged (fixture, audit A8)', () => {
    const fixture = [
      'async function a() { const r = await runAction(saveThing(1)); if (r.ok) toast(); }',
      'async function b() { await runAction(saveThing(2)); markSaved(); }',
    ].join('\n');
    expect(uncheckedCallSites(fixture, ['saveThing', 'runAction'])).toEqual(['runAction() at line 2']);
  });

  it('an awaited helper that swallows the action result is flagged (fixture, audit A7/A8)', () => {
    const fixture = `
      async function handleSaveMapping(id: string) {
        const saved = await runAction(saveMapping({ id }));
        if (!saved.ok) return;
        setMappings((prev) => { const next = [...prev]; return next; });
      }
      async function handleAutoMatch() {
        let matched = 0;
        for (const id of ids) { await handleSaveMapping(id); matched++; }
      }
      async function returnsOutcome(id: string): Promise<RunResult<unknown>> {
        const saved = await runAction(saveMapping({ id }));
        return saved;
      }
      async function caller() { const r = await returnsOutcome('x'); if (r.ok) count++; }
      function onChange(id: string) { handleSelect(id); }
      async function handleSelect(id: string) { const r = await runAction(saveMapping({ id })); if (!r.ok) return; }`;
    expect(voidAwaitedWrappers(fixture, ['saveMapping'])).toEqual(['handleSaveMapping: awaited wrapper returns void']);
  });
});
