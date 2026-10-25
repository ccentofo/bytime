import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { is } from 'drizzle-orm';
import { Column } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as tenantSchema from '@/db/schema';
import * as controlSchema from '@/db/control-plane/schema';
import { findTaggedTemplates } from '../helpers/sql-template-scanner';

/**
 * Launch-blockers audit R11: drizzle's postgres-js driver replaces the timestamptz serializer with a pass-through
 * (node_modules/drizzle-orm/postgres-js/driver.js) because column encoders map dates. A raw `Date` interpolated into a
 * drizzle `sql` fragment skips the column encoder, postgres-js infers timestamptz and hands the Date object to the wire
 * encoder → "Received an instance of Date" (POST /signup/verify 500; the signal counter crashed on every second signal).
 * The integration suite cannot catch this class (there the driver's `instanceof Date` check is false), so this static
 * check does: every `${…}` inside a drizzle `sql` template in src/ and scripts/ (multi-line and nested included) is
 *  - a column reference `<table>.<column>` (a real exported table and column; `table.<col>` in the schema files'
 *    index callbacks), or
 *  - `<expr>.toISOString()` followed by a `::timestamptz` / `::date` cast, or
 *  - on the justified allowlist below.
 * Checked tags: drizzle's `sql` (and aliases, e.g. `sql as dsql`), and any postgres-js client in the same file that is
 * passed to `drizzle(client)` — drizzle installs the pass-through on that client's own serializers. A postgres-js client
 * that is never passed to drizzle keeps its Date serializer and is not checked. A nested drizzle `sql` fragment is
 * allowed as an interpolation (its own interpolations are checked).
 */

const ROOT = path.resolve(__dirname, '../../..');

const ALLOWLIST: Array<{ file: string; expr: string; why: string }> = [
  { file: 'src/db/control-plane/locked.ts', expr: "'tenant:' + tenantId", why: 'advisory-lock key (a string for hashtext)' },
  { file: 'src/server/internal/periods.ts', expr: "'timesheet:' + userId", why: 'advisory-lock key (a string for hashtext)' },
  { file: 'src/lib/tenant/migrate-tenant.ts', expr: 'MIGRATION_LOCK_KEY', why: 'advisory-lock key (a number constant)' },
  { file: 'src/server/internal/import-window.ts', expr: 'IMPORT_WINDOW_LOCK', why: 'advisory-lock key (a string constant for hashtext; certified-outputs C1)' },
  { file: 'src/server/internal/approval-rules.ts', expr: 'USER_RULES_LOCK', why: 'advisory-lock key (a string constant for hashtext; certified-outputs fix round 1 F1)' },
  { file: 'src/lib/cron/heartbeat.ts', expr: 'name', why: 'the heartbeat cron name (a CronName string)' },
  { file: 'src/lib/signup/signals.ts', expr: '`${key}:last`', why: 'a signal_counters key (a string)' },
];

const SCHEMA_FILES = new Set(['src/db/schema.ts', 'src/db/control-plane/schema.ts']);

/** Exported drizzle tables: name → table. */
const TABLES = new Map<string, Record<string, unknown>>(
  [...Object.entries(tenantSchema), ...Object.entries(controlSchema)]
    .filter(([, v]) => is(v, PgTable))
    .map(([k, v]) => [k, v as unknown as Record<string, unknown>]),
);

/** Template tags to check in this file: drizzle's `sql` (as imported) and postgres-js clients passed to drizzle(). */
export function drizzleSqlTags(source: string): Set<string> {
  const tags = new Set<string>();
  for (const m of source.matchAll(/\bdrizzle\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g)) tags.add(m[1]);
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]drizzle-orm['"]/g)) {
    for (const spec of m[1].split(',').map((s) => s.trim())) {
      const named = spec.match(/^sql(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (named) tags.add(named[1] ?? 'sql');
    }
  }
  return tags;
}

function isColumnRef(expr: string, file: string): boolean {
  const m = expr.match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/);
  if (!m) return false;
  if (m[1] === 'table' && SCHEMA_FILES.has(file)) return true; // pgTable extra-config callback parameter
  const table = TABLES.get(m[1]);
  return !!table && is(table[m[2]], Column);
}

const isCastIso = (expr: string, after: string) => /\.toISOString\(\)$/.test(expr) && /^::(timestamptz|date)\b/.test(after);

/** Offending interpolations: `file:line ${expr}`. `allowlist` defaults to the real one. */
export function sqlParamViolations(source: string, file: string, allowlist = ALLOWLIST): string[] {
  const tags = drizzleSqlTags(source);
  if (tags.size === 0) return [];
  const out: string[] = [];
  for (const t of findTaggedTemplates(source)) {
    if (!tags.has(t.tag)) continue;
    for (const x of t.interpolations) {
      if (isColumnRef(x.expr, file) || isCastIso(x.expr, x.after)) continue;
      if ([...tags].some((tag) => x.expr.startsWith(`${tag}\``))) continue; // a nested sql fragment
      if (allowlist.some((a) => a.file === file && a.expr === x.expr)) continue;
      out.push(`${file}:${x.line} \${${x.expr}}`);
    }
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === 'node_modules' || name === '__tests__') return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|mts)$/.test(name) ? [full] : [];
  });
}

const allFiles = () => [...sourceFiles(path.join(ROOT, 'src')), ...sourceFiles(path.join(ROOT, 'scripts'))]
  .map((f) => ({ rel: path.relative(ROOT, f), source: readFileSync(f, 'utf8') }));

describe('drizzle sql templates never interpolate a raw value (audit R11)', () => {
  it('every ${…} in a drizzle sql template in src/ and scripts/ is a column, an ISO string with a cast, or allowlisted', () => {
    expect(allFiles().flatMap((f) => sqlParamViolations(f.source, f.rel))).toEqual([]);
  });

  it('the scan sees the codebase (dozens of templates, both fixed sites) — not a regex that matches nothing', () => {
    let templates = 0;
    const isoSites: string[] = [];
    for (const f of allFiles()) {
      const tags = drizzleSqlTags(f.source);
      for (const t of findTaggedTemplates(f.source).filter((t) => tags.has(t.tag))) {
        templates++;
        for (const x of t.interpolations) if (isCastIso(x.expr, x.after)) isoSites.push(`${f.rel} ${x.expr}`);
      }
    }
    expect(templates).toBeGreaterThan(50);
    expect(isoSites).toEqual(expect.arrayContaining([
      'src/app/signup/verify/route.ts now.toISOString()',
      'src/lib/signup/signals.ts stale.toISOString()',
      'src/lib/signup/signals.ts now.toISOString()',
      'src/lib/tenant/notices.ts now.toISOString()',
    ]));
  });

  it('every allowlist entry is still used (no stale exemptions)', () => {
    const files = new Map(allFiles().map((f) => [f.rel, f.source]));
    for (const a of ALLOWLIST) {
      const src = files.get(a.file) ?? '';
      const tags = drizzleSqlTags(src);
      const used = findTaggedTemplates(src).some((t) => tags.has(t.tag) && t.interpolations.some((x) => x.expr === a.expr));
      expect(used, `${a.file}: ${a.expr}`).toBe(true);
    }
  });

  it('fixtures: ${now} and ${stale} fail (the two bugs); casts, columns and non-drizzle templates are handled', () => {
    const header = "import { and, sql } from 'drizzle-orm';\nimport { signups, signalCounters } from '@/db/control-plane/schema';\n";
    const f = 'src/fixture.ts';
    expect(sqlParamViolations(`${header}db.update(signups).set({ verifiedAt: sql\`coalesce(\${signups.verifiedAt}, \${now})\` });`, f))
      .toEqual(['src/fixture.ts:3 ${now}']);
    expect(sqlParamViolations([
      header,
      'const x = sql`CASE WHEN ${signalCounters.windowStart} < ${stale}',
      '  THEN ${now} ELSE ${signalCounters.windowStart} END`;',
    ].join('\n'), f)).toEqual(['src/fixture.ts:4 ${stale}', 'src/fixture.ts:5 ${now}']);
    // a value that merely looks like table.column, an ISO string without a cast, and a nested template
    expect(sqlParamViolations(`${header}sql\`a = \${row.createdAt} and b = \${now.toISOString()} and \${sql\`c = \${when}\`}\`;`, f))
      .toEqual(['src/fixture.ts:3 ${row.createdAt}', 'src/fixture.ts:3 ${now.toISOString()}', 'src/fixture.ts:3 ${when}']);
    // the fixed forms pass; an alias is followed; a postgres-js client (not drizzle's sql) is not checked
    expect(sqlParamViolations(`${header}sql\`coalesce(\${signups.verifiedAt}, \${now.toISOString()}::timestamptz) and d = \${day.toISOString()}::date\`;`, f)).toEqual([]);
    expect(sqlParamViolations("import { sql as dsql } from 'drizzle-orm';\ndsql`x < ${now}`;", f)).toEqual(['src/fixture.ts:2 ${now}']);
    expect(sqlParamViolations("import postgres from 'postgres';\nconst sql = postgres(url);\nawait sql`update t set at = ${now}`;", f)).toEqual([]);
    // …unless that client is passed to drizzle(), which replaces its Date serializer
    expect(sqlParamViolations("import postgres from 'postgres';\nimport { drizzle } from 'drizzle-orm/postgres-js';\nconst client = postgres(url);\nconst db = drizzle(client);\nawait client`update t set at = ${now}`;", f))
      .toEqual(['src/fixture.ts:5 ${now}']);
    // the allowlist is per file and per expression
    expect(sqlParamViolations(`${header}sql\`select pg_advisory_xact_lock(hashtext(\${'tenant:' + tenantId}))\`;`, f)).toEqual([expect.stringContaining("'tenant:' + tenantId")]);
    expect(sqlParamViolations(`${header}sql\`select pg_advisory_xact_lock(hashtext(\${'tenant:' + tenantId}))\`;`, 'src/db/control-plane/locked.ts')).toEqual([]);
  });
});
