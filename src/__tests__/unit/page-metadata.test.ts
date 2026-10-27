import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { stripComments } from '../helpers/source-scanner';

/**
 * feature-plan-ux-foundations.md §4.7 / T14 (UX-AUDIT A6, WCAG 2.4.2): every page has its own title. Root layout:
 * `title.default` + `title.template`; every page.tsx (except the landing page, which uses `title.absolute`) exports
 * `metadata` with a title string; no 'use client' file exports metadata (it would break the build — trap T-C).
 */

const ROOT = path.resolve(__dirname, '../../..');
const APP = path.join(ROOT, 'src/app');

function files(dir: string, test: (name: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full, test);
    return test(name) ? [full] : [];
  });
}
const read = (f: string) => stripComments(readFileSync(f, 'utf8'));
const rel = (f: string) => path.relative(ROOT, f);
const LANDING = 'src/app/page.tsx';

describe('page titles (T14)', () => {
  it('the root layout sets title.default and title.template', () => {
    const layout = read(path.join(APP, 'layout.tsx'));
    expect(layout).toMatch(/title:\s*\{\s*default:\s*"CadenzPoint",\s*template:\s*"%s – CadenzPoint"\s*\}/);
  });

  it('every page.tsx except the landing page exports metadata with a title string', () => {
    const pages = files(APP, (n) => n === 'page.tsx');
    expect(pages.length).toBe(32); // UX-2: + home and settings/pay-schedule
    const missing = pages.filter((f) => rel(f) !== LANDING)
      .filter((f) => !/export const metadata: Metadata = \{ title: '[^']+' \};/.test(read(f)))
      .map(rel);
    expect(missing).toEqual([]);
  });

  it('the landing page uses title.absolute (a template does not apply to the layout\'s own segment)', () => {
    expect(read(path.join(ROOT, LANDING))).toContain("export const metadata: Metadata = { title: { absolute: 'CadenzPoint – DCAA-compliant timekeeping' } };");
  });

  it("no 'use client' file exports metadata", () => {
    const offenders = files(path.join(ROOT, 'src'), (n) => /\.(ts|tsx)$/.test(n))
      .filter((f) => !f.includes('__tests__'))
      .filter((f) => { const s = read(f); return /^\s*['"]use client['"]/.test(s) && /export (const metadata|async function generateMetadata|function generateMetadata)/.test(s); })
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('settings/error.tsx is exactly the client re-export of admin/error (UX-2 §4.1)', () => {
    expect(readFileSync(path.join(APP, '(app)/settings/error.tsx'), 'utf8')).toBe("'use client';\nexport { default } from '../admin/error';\n");
  });

  it('client error boundaries render a <title>', () => {
    for (const f of ['src/app/error.tsx', 'src/app/global-error.tsx', 'src/app/(app)/error.tsx', 'src/app/(app)/admin/error.tsx', 'src/app/(app)/timesheet/error.tsx']) {
      expect(read(path.join(ROOT, f)), f).toContain('<title>Something went wrong – CadenzPoint</title>');
    }
  });
});
