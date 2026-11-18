import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

/**
 * url-fix (2026-11-18): every postgres.js client in src/ and scripts/ must connect through postgresJsUrl
 * (src/lib/db/pg-url.ts). postgres.js forwards unknown URL query keys to the server as startup settings, so a raw
 * Neon URL (`…&channel_binding=require`) fails with 42704.
 * - Excluded: scripts/backup/ (the backup image applies its own `clientUrl`, scripts/backup/lib/pg-url.ts) and tests.
 * - For each file with a value import of `postgres`, every call `<binding>(` must be written `<binding>(postgresJsUrl(`.
 * - drizzle-kit connects with postgres.js too (pg isn't installed), so both drizzle configs must wrap their `url`.
 */

const ROOT = path.resolve(__dirname, '../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(ROOT, full).split(path.sep).join('/');
    if (rel === 'scripts/backup' || rel === 'src/__tests__' || name === 'node_modules') continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name)) out.push(rel);
  }
  return out;
}

/** The local name(s) a file binds postgres.js's default export to (`import x from 'postgres'`, `import x, {…} from`). */
function postgresBindings(src: string): string[] {
  const names: string[] = [];
  const re = /import\s+(?!type\b)([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"]postgres['"]/g;
  for (const m of src.matchAll(re)) names.push(m[1]);
  // `import * as x from 'postgres'` / `require('postgres')` would be new patterns: refuse them so this check stays exhaustive.
  if (/import\s+\*\s+as\s+\w+\s+from\s*['"]postgres['"]|require\(\s*['"]postgres['"]\s*\)|import\(\s*['"]postgres['"]\s*\)/.test(src)) names.push('<unsupported import form>');
  return names;
}

/** Comments blanked out (line numbers kept), so prose like "never let postgres() fall back" isn't a call. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

function violations(rel: string, raw: string): { calls: number; bad: string[] } {
  const src = stripComments(raw);
  const bad: string[] = [];
  let calls = 0;
  for (const name of postgresBindings(src)) {
    if (name === '<unsupported import form>') { bad.push(`${rel}: unsupported import form of 'postgres'; use \`import postgres from 'postgres'\``); continue; }
    const call = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\s*\\(`, 'g');
    for (const m of src.matchAll(call)) {
      calls++;
      const rest = src.slice(m.index! + m[0].length);
      if (!/^\s*postgresJsUrl\(/.test(rest)) {
        const line = src.slice(0, m.index).split('\n').length;
        bad.push(`${rel}:${line}: ${raw.split('\n')[line - 1].trim()}`);
      }
    }
  }
  return { calls, bad };
}

describe('every postgres.js client connects through postgresJsUrl (url-fix)', () => {
  it('src/ and scripts/ (outside scripts/backup/ and tests)', () => {
    const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))];
    let total = 0;
    const bad: string[] = [];
    for (const rel of files) {
      const r = violations(rel, readFileSync(path.join(ROOT, rel), 'utf8'));
      total += r.calls;
      bad.push(...r.bad);
    }
    expect(bad).toEqual([]);
    // 9 app + 14 script call sites at the url-fix build; a broken scanner must not pass with nothing found.
    expect(total).toBeGreaterThanOrEqual(23);
  });

  it('both drizzle-kit configs wrap their url', () => {
    for (const f of ['drizzle.config.ts', 'drizzle.control-plane.config.ts']) {
      const src = readFileSync(path.join(ROOT, f), 'utf8');
      expect(src, f).toMatch(/import \{ postgresJsUrl \} from '\.\/src\/lib\/db\/pg-url'/);
      expect(src, f).toMatch(/\burl:\s*postgresJsUrl\(/);
      expect(src.match(/\burl:/g)?.length, f).toBe(1);
    }
  });

  it('the scanner flags an unwrapped call, an aliased import and an unsupported import form', () => {
    expect(violations('x.ts', "import postgres from 'postgres';\nconst a = postgres(url, { max: 1 });").bad).toEqual(['x.ts:2: const a = postgres(url, { max: 1 });']);
    expect(violations('x.ts', "import pg, { type Sql } from 'postgres';\nconst a = pg(postgresJsUrl(u));\nconst b = pg(u);").bad).toEqual(['x.ts:3: const b = pg(u);']);
    expect(violations('x.ts', "import * as p from 'postgres';").bad).toHaveLength(1);
    expect(violations('x.ts', "import type postgres from 'postgres';\ntype S = postgres.Sql;").bad).toEqual([]);
    expect(violations('x.ts', "import postgres from 'postgres';\nconst a = postgres( postgresJsUrl(u), {});").bad).toEqual([]);
    expect(violations('x.ts', "import postgres from 'postgres';\n// never call postgres('') here\n/* postgres(x) */\nconst a = postgres(postgresJsUrl('postgresql://h/d'), {});").bad).toEqual([]);
    expect(violations('x.ts', "import postgres from 'postgres';\nconst a = postgres('postgresql://h/d'); // ok?").bad).toEqual(["x.ts:2: const a = postgres('postgresql://h/d'); // ok?"]);
  });
});
