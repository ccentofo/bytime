import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { stripComments } from '../helpers/source-scanner';

/**
 * feature-plan-ux-timesheet-ui.md B-T13 (§4.7, static): no dense mode; nothing smaller than 0.875rem in the timesheet CSS
 * and no size="xs" text in the timesheet TSX; the scroller is height-limited (max(18rem …)) with sticky headers, the
 * corner above both, and the narrow/short-viewport override; globals.css no longer clips html/body sideways.
 */

const ROOT = path.resolve(__dirname, '../../..');
const DIR = path.join(ROOT, 'src/components/timesheet');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const full = path.join(dir, n);
  return statSync(full).isDirectory() ? walk(full) : [full];
});
const css = () => readFileSync(path.join(DIR, 'Timesheet.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const ruleOf = (sheet: string, selector: string) => {
  const i = sheet.indexOf(`${selector} {`);
  return i < 0 ? null : sheet.slice(i, sheet.indexOf('}', i) + 1);
};

describe('timesheet reflow and text size (B-T13)', () => {
  it('no dense mode: no getDensity anywhere in the timesheet components', () => {
    for (const f of walk(DIR).filter((f) => /\.(ts|tsx)$/.test(f))) expect(stripComments(readFileSync(f, 'utf8')), f).not.toMatch(/getDensity|density/i);
  });

  it('no font-size below 0.875rem in the timesheet CSS', () => {
    const sizes = [...css().matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(sizes.length).toBeGreaterThan(0);
    for (const v of sizes) {
      const rem = v.match(/^([\d.]+)rem$/);
      const px = v.match(/^([\d.]+)px$/);
      if (rem) expect(Number(rem[1]), v).toBeGreaterThanOrEqual(0.875);
      else if (px) expect(Number(px[1]), v).toBeGreaterThanOrEqual(14);
      else expect(v, 'only rem / px sizes').toMatch(/^(inherit|var\(--mantine-font-size-(sm|md|lg|xl)\))$/);
    }
  });

  it('M2: no Mantine `loading` and no real `disabled` on any timesheet control (aria-disabled + a click guard instead)', () => {
    for (const f of walk(DIR).filter((f) => f.endsWith('.tsx'))) {
      const src = stripComments(readFileSync(f, 'utf8'));
      expect(src, f).not.toMatch(/\sloading=/);
      expect(src, f).not.toMatch(/(?<![-\w])disabled=/);
    }
  });

  it('no size="xs" (and no 10–13px inline font sizes) in the timesheet TSX', () => {
    for (const f of walk(DIR).filter((f) => f.endsWith('.tsx'))) {
      const src = stripComments(readFileSync(f, 'utf8'));
      expect(src, f).not.toMatch(/size=["']xs["']/);
      expect(src, f).not.toMatch(/fontSize:\s*1[0-3]\b/);
    }
  });

  it('the scroller is height-limited with sticky headers; the corner sits above both; the narrow/short override lifts both', () => {
    const sheet = css();
    expect(ruleOf(sheet, '.scroller')).toMatch(/overflow: auto;[\s\S]*max-height: max\(18rem, calc\(100dvh - var\(--ts-chrome\)\)\);/);
    expect(ruleOf(sheet, '.scroller thead th')).toMatch(/position: sticky;\s*top: 0;\s*z-index: 2;/);
    expect(ruleOf(sheet, ".scroller th[scope='row']")).toMatch(/position: sticky;\s*left: 0;\s*z-index: 1;/);
    expect(ruleOf(sheet, '.scroller thead th.corner')).toMatch(/left: 0;\s*z-index: 3;/);
    const media = sheet.slice(sheet.indexOf('@media (max-height: 40em), (max-width: 40em)'));
    expect(media).toMatch(/\.scroller \{\s*max-height: none;\s*\}/);
    expect(media).toMatch(/\.scroller thead th,\s*\.scroller th\[scope='row'\] \{\s*position: static;\s*\}/);
    expect(ruleOf(sheet, '.page')).toMatch(/--ts-chrome: 15rem;/);
  });

  it('M3: no `-filled` color as TEXT color (it fails 4.5:1 in dark mode); the closed note and grand total use light-dark pairs', () => {
    const sheet = css();
    expect(sheet).not.toMatch(/(?<![-\w])color:\s*var\(--mantine-color-[\w-]+-filled\)/);
    expect(ruleOf(sheet, '.closedNote')).toContain('color: light-dark(var(--mantine-color-warning-8), var(--mantine-color-warning-4));');
    expect(ruleOf(sheet, '.grand')).toContain('color: light-dark(var(--mantine-color-signal-7), var(--mantine-color-signal-4));');
  });

  // v5.2 visual revision (§14.6 B-T13).
  it('v5.2: no meter; no today box-shadow; the weekend tint isn\'t default-hover; cells declare column lines; no noteBar', () => {
    const sheet = css();
    expect(sheet).not.toMatch(/\.meter/);
    expect(ruleOf(sheet, '.todayCol') ?? '').not.toMatch(/box-shadow/);
    expect(sheet).not.toMatch(/\.todayCol\s*\{[^}]*box-shadow/);
    const weekendRules = [...sheet.matchAll(/[^{}]*\.weekend[^{}]*\{[^}]*\}/g)].map((m) => m[0]);
    expect(weekendRules.length).toBeGreaterThan(0);
    for (const r of weekendRules) expect(r).not.toMatch(/default-hover/);
    // The tints set background-color only: the shorthand would clear a closed cell's hatch (background-image).
    for (const sel of ['.day.weekend', '.day.todayCol', '.day.unsaved', '.day.editable:hover']) expect(ruleOf(sheet, sel) ?? '', sel).toMatch(/^[^{]*\{\s*background-color:/);
    expect(ruleOf(sheet, '.cell')).toMatch(/border-inline-end:\s*1px solid var\(--line\);/);
    expect(ruleOf(sheet, '.cell')).toMatch(/border-block-end:\s*1px solid var\(--line\);/);
    expect(sheet).not.toMatch(/noteBar/);
    for (const f of walk(DIR).filter((f) => f.endsWith('.tsx'))) expect(stripComments(readFileSync(f, 'utf8')), f).not.toMatch(/noteBar|meterFill|styles\.meter/);
  });

  it('v5.2: the heavier lines, the scroller frame, the tokens and the note trigger', () => {
    const sheet = css();
    expect(ruleOf(sheet, '.rowHeader')).toMatch(/border-inline-end: 2px solid var\(--line-strong\);/);
    expect(sheet).toMatch(/\.totalHead,\s*\.totalCol \{\s*border-inline-start: 2px solid var\(--line-strong\);/);
    expect(sheet).toMatch(/tfoot \.cell \{\s*border-block-start: 2px solid var\(--line-strong\);/);
    expect(ruleOf(sheet, '.scroller')).toMatch(/border: 1px solid var\(--line-strong\);[\s\S]*border-radius: var\(--mantine-radius-md\);/);
    for (const token of ['--line:', '--line-strong:', '--weekend:', '--today-tint:', '--hover-tint:', '--group:']) expect(ruleOf(sheet, '.page'), token).toContain(token);
    // The separators are darker than the cell lines in both schemes (ink-3 > ink-2, dark-4 > dark-5 on a dark body).
    expect(ruleOf(sheet, '.page')).toContain('--line: light-dark(var(--mantine-color-ink-2), var(--mantine-color-dark-5));');
    expect(ruleOf(sheet, '.page')).toContain('--line-strong: light-dark(var(--mantine-color-ink-3), var(--mantine-color-dark-4));');
    expect(ruleOf(sheet, '.noteTrigger')).toMatch(/display: none;/);
    expect(sheet).toMatch(/\.hasNote \.noteTrigger,\s*\[data-active\] \.noteTrigger \{\s*display: grid;/);
  });

  it('no overflow: hidden on the grid, its cells or the scroller', () => {
    const sheet = css();
    for (const sel of ['.scroller', '.grid', '.cell', '.day', '.rowHeader', '.gridArea', '.colHead', '.dayHeader']) {
      expect(ruleOf(sheet, sel) ?? '', sel).not.toMatch(/overflow:\s*hidden/);
    }
  });

  it('globals.css has no html/body overflow-x: hidden or max-width: 100vw', () => {
    const globals = readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf8');
    expect(globals).not.toMatch(/overflow-x:\s*hidden/);
    expect(globals).not.toMatch(/max-width:\s*100vw/);
  });
});
