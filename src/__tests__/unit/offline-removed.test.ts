import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { stripComments } from '../helpers/source-scanner';

/**
 * feature-plan-ux-timesheet.md A-T13 (A4.10, UX3-D2): the fake offline layer is gone — no src/lib/offline, no
 * SyncStatusIndicator ("Synced" badge), no dexie dependency, no offline claims on the landing page or in the README —
 * and AppShellWrapper deletes the old IndexedDB database once. (Terms and Privacy are the business side's — not here.)
 */

const ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === 'node_modules' || name === '__tests__') return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe('offline layer removed (UX-3 A-T13)', () => {
  it('no src/lib/offline module, no imports of it, no SyncStatusIndicator, no dexie anywhere in src', () => {
    expect(existsSync(path.join(ROOT, 'src/lib/offline'))).toBe(false);
    expect(existsSync(path.join(ROOT, 'src/components/shell/SyncStatusIndicator.tsx'))).toBe(false);
    const offenders = sourceFiles(path.join(ROOT, 'src'))
      .filter((f) => /lib\/offline|SyncStatusIndicator|from ['"]dexie['"]/.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('dexie is not a dependency', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect({ ...pkg.dependencies, ...pkg.devDependencies }).not.toHaveProperty('dexie');
    expect(JSON.parse(read('package-lock.json')).packages['']).not.toHaveProperty(['dependencies', 'dexie']);
  });

  it('AppShellWrapper deletes the old IndexedDB database (in an effect, best effort)', () => {
    const shell = stripComments(read('src/app/(app)/AppShellWrapper.tsx'));
    expect(shell).toContain("indexedDB.deleteDatabase('bytime-offline')");
    const effect = shell.slice(shell.lastIndexOf('useEffect(', shell.indexOf("indexedDB.deleteDatabase('bytime-offline')")), shell.indexOf("indexedDB.deleteDatabase('bytime-offline')"));
    expect(effect).toMatch(/useEffect\(\(\) => \{\s*try \{\s*const request = $/);
  });

  it('no offline claims on the landing page, the timesheet error page or in the README', () => {
    for (const rel of ['src/app/page.tsx', 'src/app/(app)/timesheet/error.tsx', 'README.md']) {
      expect(stripComments(read(rel)), rel).not.toMatch(/offline|dexie|indexeddb|sync(s|ed)? (automatically|when)/i);
    }
  });
});
