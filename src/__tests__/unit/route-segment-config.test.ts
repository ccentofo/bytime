import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { stripComments } from '../helpers/source-scanner';
import { REMINDER_CRON_MAX_DURATION_S } from '@/lib/cron/tenant-sweep';

vi.mock('server-only', () => ({}));
vi.mock('@/db/control-plane', () => ({ controlDb: {} }));

/**
 * Launch-blockers audit R10: route segment config must be a literal Next can read statically
 * (node_modules/next/dist/build/analysis/get-page-static-info.js) — `export const maxDuration = SOME_IMPORT` fails
 * `npm run build` with "Invalid segment configuration export detected". Every segment config export under src/app is
 * assigned a literal, and the two reminder crons' literal stays equal to REMINDER_CRON_MAX_DURATION_S (the sweep's
 * 240 s time budget is sized to fit inside it).
 */

const ROOT = path.resolve(__dirname, '../../..');
const APP = path.join(ROOT, 'src/app');
const SEGMENT_CONFIG = /^\s*export\s+const\s+(maxDuration|dynamic|revalidate|runtime|fetchCache|preferredRegion|dynamicParams)\b\s*(?::[^=]+)?=\s*([^;\n]+?)\s*;?\s*$/gm;
const STRING = String.raw`(?:'[^'\\\n]*'|"[^"\\\n]*")`;
const LITERAL = new RegExp(String.raw`^(?:${STRING}|-?\d+(?:\.\d+)?|true|false|\[\s*(?:${STRING}\s*(?:,\s*${STRING}\s*)*,?\s*)?\])$`);

/** Segment config exports whose value is not a literal: `name = value`. */
export function nonLiteralSegmentConfig(source: string): string[] {
  const out: string[] = [];
  for (const m of stripComments(source).matchAll(SEGMENT_CONFIG)) {
    if (!LITERAL.test(m[2].trim())) out.push(`${m[1]} = ${m[2].trim()}`);
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const literalMaxDuration = (rel: string) => {
  const m = stripComments(readFileSync(path.join(ROOT, rel), 'utf8')).match(/^\s*export\s+const\s+maxDuration\s*=\s*(\d+)\s*;/m);
  return m ? Number(m[1]) : null;
};

describe('route segment config is statically readable (audit R10)', () => {
  it('every segment config export under src/app is a literal', () => {
    const offenders = sourceFiles(APP).flatMap((f) => nonLiteralSegmentConfig(readFileSync(f, 'utf8')).map((v) => `${path.relative(ROOT, f)}: ${v}`));
    expect(offenders).toEqual([]);
  });

  it('the scan sees the known exports (guards against a regex that matches nothing)', () => {
    const all = sourceFiles(APP).flatMap((f) => [...stripComments(readFileSync(f, 'utf8')).matchAll(SEGMENT_CONFIG)].map((m) => m[1]));
    expect(all.filter((n) => n === 'maxDuration').length).toBeGreaterThanOrEqual(5);
    expect(all).toContain('dynamic');
    expect(all).toContain('runtime');
  });

  it('fixture: identifiers, member access and expressions are flagged; literals pass', () => {
    expect(nonLiteralSegmentConfig("import { X } from './x';\nexport const maxDuration = REMINDER_CRON_MAX_DURATION_S;")).toEqual(['maxDuration = REMINDER_CRON_MAX_DURATION_S']);
    expect(nonLiteralSegmentConfig('export const revalidate = config.revalidate;')).toEqual(['revalidate = config.revalidate']);
    expect(nonLiteralSegmentConfig('export const maxDuration = 60 * 5;')).toEqual(['maxDuration = 60 * 5']);
    expect(nonLiteralSegmentConfig('export const dynamic = `force-dynamic`;')).toEqual(['dynamic = `force-dynamic`']);
    expect(nonLiteralSegmentConfig([
      'export const maxDuration = 300;',
      "export const dynamic = 'force-dynamic';",
      'export const runtime = "nodejs"',
      'export const revalidate = false;',
      'export const dynamicParams = true;',
      "export const preferredRegion = ['iad1', 'sfo1'];",
      '// export const maxDuration = NOT_REAL;',
    ].join('\n'))).toEqual([]);
  });

  it('both reminder crons export the literal REMINDER_CRON_MAX_DURATION_S', () => {
    for (const rel of ['src/app/api/cron/daily-reminder/route.ts', 'src/app/api/cron/submission-deadline/route.ts']) {
      expect(literalMaxDuration(rel), rel).toBe(REMINDER_CRON_MAX_DURATION_S);
    }
  });
});
