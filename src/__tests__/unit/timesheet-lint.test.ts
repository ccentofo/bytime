import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { ESLint } from 'eslint';
import { stripComments } from '../helpers/source-scanner';

/**
 * feature-plan-ux-timesheet-ui.md B-T16: the timesheet code stays clean under react-hooks 7 — the ESLint Node API (the
 * project's own flat config) reports zero `react-hooks/refs` and `react-hooks/immutability` messages over
 * src/components/timesheet/** and src/lib/timesheet/**, with both rules confirmed active for those files; and nothing
 * there writes to globalThis.
 */

const ROOT = path.resolve(__dirname, '../../..');
const DIRS = ['src/components/timesheet', 'src/lib/timesheet'];
const RULES = ['react-hooks/refs', 'react-hooks/immutability'];
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const full = path.join(dir, n);
  return statSync(full).isDirectory() ? walk(full) : [full];
});
const sources = () => DIRS.flatMap((d) => walk(path.join(ROOT, d))).filter((f) => /\.(ts|tsx)$/.test(f));

describe('timesheet lint guard (B-T16)', () => {
  it('both rules are active for the timesheet files (so a zero count means something)', async () => {
    const eslint = new ESLint({ cwd: ROOT });
    for (const file of ['src/components/timesheet/TimesheetGrid.tsx', 'src/lib/timesheet/unsaved-guard.ts']) {
      const config = await eslint.calculateConfigForFile(path.join(ROOT, file));
      for (const rule of RULES) {
        const entry = config.rules?.[rule];
        const severity = Array.isArray(entry) ? entry[0] : entry;
        expect([1, 2, 'warn', 'error'], `${rule} in ${file}`).toContain(severity);
      }
    }
  }, 120_000);

  it('the ESLint Node API reports zero react-hooks/refs and react-hooks/immutability messages', async () => {
    const files = sources();
    expect(files.length).toBeGreaterThan(10);
    const results = await new ESLint({ cwd: ROOT }).lintFiles(files);
    expect(results).toHaveLength(files.length);
    const hits = results.flatMap((r) => r.messages.filter((m) => m.ruleId && RULES.includes(m.ruleId))
      .map((m) => `${path.relative(ROOT, r.filePath)}:${m.line} ${m.ruleId} ${m.message}`));
    expect(hits).toEqual([]);
  }, 120_000);

  it('no globalThis writes', () => {
    const write = /globalThis\b(?:\s+as\s+[^)]*\))?\s*(?:\.\s*\w+|\[[^\]]*\])\s*(?:[-+*/%&|^]?=(?!=)|\+\+|--)|Object\.(?:assign|defineProperty|defineProperties)\(\s*globalThis\b/;
    const offenders = sources().filter((f) => write.test(stripComments(readFileSync(f, 'utf8')))).map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
    // The pattern itself catches the usual shapes.
    for (const s of ['globalThis.x = 1', '(globalThis as any).x = 1', 'globalThis["x"] = 1', 'globalThis.n++', 'Object.assign(globalThis, {})']) expect(write.test(s), s).toBe(true);
    expect(write.test('globalThis.x === 1')).toBe(false);
  });
});
