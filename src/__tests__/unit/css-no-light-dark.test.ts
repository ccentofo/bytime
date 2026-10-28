import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

/**
 * feature-plan-ux-timesheet-ui.md §15.1: no `light-dark(` in any src/**\/*.css. Turbopack's Lightning CSS compiles it to
 * `var(--lightningcss-light, A) var(--lightningcss-dark, B)` and defines those variables only where it compiles a
 * `color-scheme` declaration; Mantine sets the scheme with the data-mantine-color-scheme attribute, so the value is two
 * colours and the browser drops the declaration. Use the light value on the rule and a
 * `:global([data-mantine-color-scheme='dark'])` (or `:root[data-mantine-color-scheme='dark']`) override instead.
 * Inline styles and Mantine style props never pass through Lightning CSS, so `light-dark()` in TS/TSX is allowed.
 * scripts/check-css-output.mjs checks the compiled output after a build.
 */

const SRC = path.resolve(__dirname, '../..');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const full = path.join(dir, n);
  return statSync(full).isDirectory() ? walk(full) : [full];
});
/** Comments blanked out (newlines kept, so line numbers stay right). */
const blankComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));

/** Every `light-dark(` outside comments, as "file:line". */
function lightDarkUses(files: { file: string; css: string }[]): string[] {
  return files.flatMap(({ file, css }) => {
    const code = blankComments(css);
    return code.split('\n').flatMap((line, i) => (/light-dark\(/.test(line) ? [`${file}:${i + 1}`] : []));
  });
}

describe('no light-dark() in .css files (§15.1)', () => {
  it('none in src/**/*.css', () => {
    const files = walk(SRC).filter((f) => f.endsWith('.css') && !f.includes('__tests__'));
    expect(files.length).toBeGreaterThan(3);
    expect(files.map((f) => path.relative(SRC, f))).toEqual(expect.arrayContaining(['app/globals.css', 'components/timesheet/Timesheet.module.css', 'components/ui/RowActions.module.css', 'app/(app)/home/Home.module.css']));
    expect(lightDarkUses(files.map((f) => ({ file: path.relative(SRC, f), css: readFileSync(f, 'utf8') })))).toEqual([]);
  });

  it('the check finds a use (and ignores comments)', () => {
    expect(lightDarkUses([{ file: 'x.css', css: '.a {\n  color: light-dark(red, blue);\n}' }])).toEqual(['x.css:2']);
    expect(lightDarkUses([{ file: 'x.css', css: '/* never light-dark(a, b) here */\n.a { color: red; }' }])).toEqual([]);
  });
});
