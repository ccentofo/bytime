/**
 * After `next build` (feature-plan-ux-timesheet-ui.md §15.1): fail if any compiled stylesheet in .next/static contains
 * `--lightningcss-`. Turbopack's Lightning CSS compiles `light-dark(A, B)` to
 * `var(--lightningcss-light, A) var(--lightningcss-dark, B)` and defines those variables only where it compiles a
 * `color-scheme` declaration; Mantine sets the scheme with the data-mantine-color-scheme attribute, so the value is two
 * colours and the browser drops the whole declaration. The static guard (unit/css-no-light-dark.test.ts) keeps
 * `light-dark(` out of src/**\/*.css; this checks what the compiler actually emitted.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

// Default: the production build's output. A directory argument checks another one, e.g. a dev server's
// `.next/dev/static` (`node scripts/check-css-output.mjs .next/dev/static`).
const root = process.argv[2] ?? '.next/static';
if (!existsSync(root)) {
  console.error(`✗ ${root} not found — run \`npm run build\` first.`);
  process.exit(1);
}
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const full = path.join(dir, n);
  return statSync(full).isDirectory() ? walk(full) : [full];
});
const cssFiles = walk(root).filter((f) => f.endsWith('.css'));
if (cssFiles.length === 0) {
  console.error(`✗ No compiled CSS under ${root} — is the build complete?`);
  process.exit(1);
}
const offenders = cssFiles.flatMap((file) => {
  const css = readFileSync(file, 'utf8');
  const at = css.indexOf('--lightningcss-');
  return at < 0 ? [] : [{ file, excerpt: css.slice(Math.max(0, at - 80), at + 80).replace(/\s+/g, ' ') }];
});
if (offenders.length > 0) {
  console.error(`✗ ${offenders.length} compiled stylesheet(s) contain --lightningcss- (a light-dark() the compiler rewrote; it never applies under Mantine's attribute-based color scheme):`);
  for (const { file, excerpt } of offenders) console.error(`  ${file}\n    …${excerpt}…`);
  process.exit(1);
}
console.log(`✓ None of the ${cssFiles.length} compiled stylesheets under ${root} contain --lightningcss-.`);
