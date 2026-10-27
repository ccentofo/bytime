import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { patchSource, MRT_VERSION } from '../../../scripts/patch-mantine-react-table.mjs';

/**
 * feature-plan-ux-foundations.md §4.2 / T3, T4 (UX-AUDIT B4): the mantine-react-table Collapse patch. T3 drives the
 * pure `patchSource` on fixtures (it never touches node_modules); T4 checks the INSTALLED dist files are patched.
 */

const ROOT = path.resolve(__dirname, '../../..');
type Kind = 'esm' | 'cjs';
const patch = patchSource as (text: string, kind: Kind) => { text: string; changed: boolean };

const SHORT: Record<Kind, string> = { esm: 'jsx(Collapse, { in: ', cjs: 'jsxRuntime.jsx(core.Collapse, { in: ' };
const ALERT: Record<Kind, string> = { esm: 'jsxs(Collapse, { className: classes$9.collapse, in: ', cjs: 'jsxRuntime.jsxs(core.Collapse, { className: classes$9.collapse, in: ' };
const PROGRESS: Record<Kind, string> = {
  esm: "jsx(Collapse, { className: clsx(classes$4.collapse, isTopToolbar && classes$4['collapse-top']), in: ",
  cjs: "jsxRuntime.jsx(core.Collapse, { className: clsx(classes$4.collapse, isTopToolbar && classes$4['collapse-top']), in: ",
};
const patched = (s: string) => s.replace(/ in: $/, ' expanded: ');
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

/** A dist-like fixture: the five Collapse openings among other code (which mentions "in" but never " in: "). */
function fixture(kind: Kind, opts: { patched?: boolean; dropOne?: boolean; extraIn?: boolean } = {}) {
  const p = (s: string) => (opts.patched ? patched(s) : s);
  const parts = [
    `const x = 1; for (const k in obj) {} // "in" without the colon form`,
    `${p(SHORT[kind])}showColumnFilters, children: null })`,
    `${p(SHORT[kind])}showAlertBanner, children: null })`,
    opts.dropOne ? '' : `${p(SHORT[kind])}isOpen, children: null })`,
    `${p(ALERT[kind])}showGlobalFilter, children: [] })`,
    `${p(PROGRESS[kind])}isSaving, children: null })`,
    opts.extraIn ? 'const other = { in: true };' : '',
  ];
  return parts.join('\n');
}

describe('patchSource (T3)', () => {
  for (const kind of ['esm', 'cjs'] as const) {
    it(`${kind}: unpatched → exactly 5 replacements, 0 " in: " left, nothing else touched`, () => {
      const src = fixture(kind);
      const out = patch(src, kind);
      expect(out.changed).toBe(true);
      expect(count(out.text, ' in: ')).toBe(0);
      expect(count(out.text, ' expanded: ')).toBe(5);
      expect(out.text).toBe(fixture(kind, { patched: true }));
      expect(out.text).toContain('for (const k in obj)');
    });

    it(`${kind}: already patched → unchanged (idempotent)`, () => {
      const src = fixture(kind, { patched: true });
      expect(patch(src, kind)).toEqual({ text: src, changed: false });
    });

    it(`${kind}: only 4 Collapse props → throws the documented message`, () => {
      expect(() => patch(fixture(kind, { dropOne: true }), kind))
        .toThrow('mantine-react-table patch: unexpected source (expected 5 Collapse `in:` props, found 4). Re-check the MRT version and update scripts/patch-mantine-react-table.mjs.');
    });

    it(`${kind}: an extra " in: " elsewhere → throws (count is over the whole file)`, () => {
      expect(() => patch(fixture(kind, { extraIn: true }), kind)).toThrow(/expected 5 Collapse `in:` props, found 6/);
    });
  }

  it('the wrong kind for the text → throws (cjs text is not esm)', () => {
    expect(() => patch(fixture('cjs'), 'esm')).toThrow(/unexpected source/);
  });
});

describe('the installed mantine-react-table is patched (T4)', () => {
  const HOW = 'run `node scripts/patch-mantine-react-table.mjs`';
  it(`package version is ${MRT_VERSION} (exact pin)`, () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'node_modules/mantine-react-table/package.json'), 'utf8'));
    expect(pkg.version, `mantine-react-table must be ${MRT_VERSION}`).toBe(MRT_VERSION);
    const ours = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(ours.dependencies['mantine-react-table']).toBe(MRT_VERSION);
    for (const hook of ['postinstall', 'predev', 'prebuild', 'pretest']) {
      expect(ours.scripts[hook], hook).toBe('node scripts/patch-mantine-react-table.mjs');
    }
  });

  for (const [file, kind] of [['index.esm.mjs', 'esm'], ['index.cjs', 'cjs']] as const) {
    it(`dist/${file}: 0 unpatched and 5 patched Collapse props`, () => {
      const text = readFileSync(path.join(ROOT, 'node_modules/mantine-react-table/dist', file), 'utf8');
      const unpatched = count(text, SHORT[kind]) + count(text, ALERT[kind]) + count(text, PROGRESS[kind]);
      const done = count(text, patched(SHORT[kind])) + count(text, patched(ALERT[kind])) + count(text, patched(PROGRESS[kind]));
      expect(unpatched, `dist/${file} is not patched — ${HOW}`).toBe(0);
      expect(done, `dist/${file} is not patched — ${HOW}`).toBe(5);
    });
  }
});

describe('the CLI guard (UX-1 audit L6)', () => {
  it('runs when invoked directly or through a symlink; not for another script or no argv', async () => {
    const { isDirectRun } = await import('../../../scripts/patch-mantine-react-table.mjs');
    const { mkdtempSync, symlinkSync } = await import('fs');
    const os = await import('os');
    const script = path.join(ROOT, 'scripts/patch-mantine-react-table.mjs');
    const link = path.join(mkdtempSync(path.join(os.tmpdir(), 'mrt-guard-')), 'patch.mjs');
    symlinkSync(script, link);
    expect(isDirectRun(script)).toBe(true);
    expect(isDirectRun(link)).toBe(true);
    expect(isDirectRun(path.join(ROOT, 'scripts/check-migration-safety.ts'))).toBe(false);
    expect(isDirectRun('')).toBe(false);
  });
});
