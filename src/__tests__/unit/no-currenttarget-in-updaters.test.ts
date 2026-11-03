import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { stripComments } from '../helpers/source-scanner';

/**
 * UX-4A-AUDIT.md §6 M5: React clears `event.currentTarget` once the handler returns, and a state-updater function can
 * run later, during render, so reading `e.currentTarget` inside one throws ("Cannot read properties of null"). Read the
 * value in the handler first. This scans every src/**\/*.tsx (not tests) for `.currentTarget` inside a `setX((y) => …)`.
 */

const ROOT = path.resolve(__dirname, '../../..');
const UPDATER_READS_CURRENT_TARGET = /set\w+\(\(\w+\) =>[^;]*\.currentTarget/;

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === '__tests__' || name === 'node_modules') return [];
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return name.endsWith('.tsx') ? [full] : [];
  });
}

describe('no event.currentTarget inside a state updater (M5)', () => {
  it('no src/**/*.tsx reads .currentTarget inside a setX((y) => …) updater', () => {
    const offenders = tsxFiles(path.join(ROOT, 'src')).flatMap((file) =>
      stripComments(readFileSync(file, 'utf8')).split('\n')
        .map((line, i) => (UPDATER_READS_CURRENT_TARGET.test(line) ? `${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}` : null))
        .filter((x): x is string => x !== null));
    expect(offenders).toEqual([]);
  });

  it('fixture: the pattern flags the bug and passes the fix', () => {
    expect(UPDATER_READS_CURRENT_TARGET.test('onChange={(e) => setForm((f) => ({ ...f, on: e.currentTarget.checked }))}')).toBe(true);
    expect(UPDATER_READS_CURRENT_TARGET.test('onChange={(e) => { const checked = e.currentTarget.checked; setForm((f) => ({ ...f, on: checked })); }}')).toBe(false);
  });
});
