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
const DARK_PAGE = ":global([data-mantine-color-scheme='dark']) .page";
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

  it('one scroll container (§15.2): the page is the viewport and the scroller fills it, with sticky headers; the corner sits above both; the narrow/short override lifts all of it', () => {
    const sheet = css();
    const page = ruleOf(sheet, '.page')!;
    expect(page).toMatch(/display: flex;\s*flex-direction: column;\s*box-sizing: border-box;/);
    expect(page).toContain('block-size: calc(100dvh - var(--app-shell-header-offset, 0rem) - 2 * var(--app-shell-padding, 0rem));');
    expect(sheet).toMatch(/\.page > \* \{\s*flex: 0 0 auto;\s*\}/);
    expect(sheet).toMatch(/\.page > \.gridSlot \{\s*flex: 1 1 auto;\s*min-block-size: 0;\s*display: flex;\s*flex-direction: column;\s*\}/);
    expect(ruleOf(sheet, '.gridArea')).toMatch(/flex: 1 1 auto;\s*min-block-size: 0;/);
    const scroller = ruleOf(sheet, '.scroller')!;
    expect(scroller).toMatch(/overflow: auto;\s*flex: 1 1 auto;\s*min-block-size: 18rem;\s*max-height: none;/);
    expect(scroller).not.toMatch(/calc\(100dvh/);
    expect(sheet).not.toMatch(/--ts-chrome/);
    expect(ruleOf(sheet, '.scroller thead th')).toMatch(/position: sticky;\s*top: 0;\s*z-index: 2;/);
    expect(ruleOf(sheet, ".scroller th[scope='row']")).toMatch(/position: sticky;\s*left: 0;\s*z-index: 1;/);
    expect(ruleOf(sheet, '.scroller thead th.corner')).toMatch(/left: 0;\s*z-index: 3;/);
    const media = sheet.slice(sheet.indexOf('@media (max-height: 40em), (max-width: 40em)'));
    expect(media).toMatch(/\.page \{\s*block-size: auto;\s*\}/);
    expect(media).toMatch(/\.scroller \{\s*flex: none;\s*min-block-size: 0;\s*max-height: none;\s*\}/);
    expect(media).toMatch(/\.scroller thead th,\s*\.scroller th\[scope='row'\] \{\s*position: static;\s*\}/);
    // The media block comes after the rules it overrides (same specificity: source order decides).
    expect(sheet.indexOf('@media (max-height: 40em), (max-width: 40em)')).toBeGreaterThan(sheet.indexOf('.scroller {'));
  });

  it('M3: no `-filled` color as TEXT color (it fails 4.5:1 in dark mode); the closed note and grand total use the scheme tokens', () => {
    const sheet = css();
    expect(sheet).not.toMatch(/(?<![-\w])color:\s*var\(--mantine-color-[\w-]+-filled\)/);
    expect(ruleOf(sheet, '.closedNote')).toContain('color: var(--warn-text);');
    expect(ruleOf(sheet, '.grand')).toContain('color: var(--accent-text);');
    expect(ruleOf(sheet, '.page')).toContain('--warn-text: var(--mantine-color-warning-8);');
    expect(ruleOf(sheet, '.page')).toContain('--accent-text: var(--mantine-color-signal-7);');
    expect(ruleOf(sheet, DARK_PAGE)).toContain('--warn-text: var(--mantine-color-warning-4);');
    expect(ruleOf(sheet, DARK_PAGE)).toContain('--accent-text: var(--mantine-color-signal-4);');
  });

  // v5.3 (§15.1): explicit scheme selectors, never the CSS light/dark function (Lightning CSS's output for it is dropped).
  it('v5.3: .page has a dark override block defining every scheme-dependent token, and every token the sheet uses is defined', () => {
    const sheet = css();
    const tokensIn = (rule: string) => [...rule.matchAll(/(--[\w-]+):/g)].map((m) => m[1]);
    const light = tokensIn(ruleOf(sheet, '.page')!);
    const dark = tokensIn(ruleOf(sheet, DARK_PAGE) ?? '');
    expect(light).toEqual(expect.arrayContaining(['--line', '--line-strong', '--weekend', '--hover-tint', '--group', '--chip', '--accent-text', '--warn-text', '--unsaved-bg', '--notice-bg', '--today-tint']));
    // Every light token has a dark value, except the today tint and the focus ring (signal-6 in both schemes).
    expect([...light].filter((t) => t !== '--today-tint' && t !== '--ring').sort()).toEqual([...dark].sort());
    // The dark block comes after the light one.
    expect(sheet.indexOf(`${DARK_PAGE} {`)).toBeGreaterThan(sheet.indexOf('.page {'));
    // Every token the sheet reads (other than Mantine's, the shell's and --ts-rh set inline by the grid) is defined on .page.
    const used = new Set([...sheet.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]).filter((t) => !t.startsWith('--mantine-') && !t.startsWith('--app-shell-') && t !== '--ts-rh'));
    for (const t of used) expect(light, t).toContain(t);
    for (const [sel, token] of [['.cell:focus,\n.day:focus-within', '--ring'], ['.code', '--chip'], ['.unsaved::after', '--warn-text'], ['.hasNote .noteTrigger', '--accent-text'], ['.weeklyNotice', '--notice-bg']] as const) {
      expect(ruleOf(sheet, sel), sel).toContain(`var(${token})`);
    }
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
    expect(ruleOf(sheet, '.page')).toContain('--line: var(--mantine-color-ink-2);');
    expect(ruleOf(sheet, '.page')).toContain('--line-strong: var(--mantine-color-ink-3);');
    expect(ruleOf(sheet, DARK_PAGE)).toContain('--line: var(--mantine-color-dark-5);');
    expect(ruleOf(sheet, DARK_PAGE)).toContain('--line-strong: var(--mantine-color-dark-4);');
    expect(ruleOf(sheet, '.noteTrigger')).toMatch(/display: none;/);
    expect(sheet).toMatch(/\.hasNote \.noteTrigger,\s*\[data-active\] \.noteTrigger \{\s*display: grid;/);
  });

  // v5.4 editing polish (§16.5 B-T13).
  it('v5.4: the editor overlays its cell — absolute, inset 0, no minimum width but 0 (the column never widens)', () => {
    const sheet = css();
    const editor = ruleOf(sheet, '.editor')!;
    expect(editor).toMatch(/position: absolute;/);
    expect(editor).toMatch(/inset: 0;/);
    expect([...editor.matchAll(/min-inline-size:\s*([^;]+);/g)].map((m) => m[1].trim())).toEqual(['0']);
    expect(sheet).not.toMatch(/min-inline-size: 3rem/);
    expect(ruleOf(sheet, ".editor[aria-invalid='true']")).toMatch(/box-shadow: inset 0 0 0 2px var\(--invalid\);/);
    expect(ruleOf(sheet, '.day')).toMatch(/position: relative|block-size/);
  });

  it('v5.4: one focus ring — a box-shadow in var(--ring) — with a forced-colors outline; no other outline but none', () => {
    const sheet = css();
    const focus = ruleOf(sheet, '.cell:focus,\n.day:focus-within')!;
    expect(focus).toMatch(/outline: none;/);
    expect(focus).toMatch(/box-shadow: inset 0 0 0 2px var\(--ring\);/);
    const forcedAt = sheet.indexOf('@media (forced-colors: active)');
    expect(forcedAt).toBeGreaterThan(-1);
    const forced = sheet.slice(forcedAt, sheet.indexOf('}\n}', forcedAt) + 3);
    expect(forced).toMatch(/\.cell:focus,\s*\.day:focus-within \{\s*outline: 2px solid CanvasText;\s*outline-offset: -2px;/);
    const outside = sheet.slice(0, forcedAt) + sheet.slice(forcedAt + forced.length);
    expect([...outside.matchAll(/(?<![-\w])outline:\s*([^;]+);/g)].map((m) => m[1].trim()).filter((v) => v !== 'none')).toEqual([]);
  });

  it('v5.4: the note trigger is pinned 1px into the corner, above the ring and the editor (z-index 1)', () => {
    const trigger = ruleOf(css(), '.noteTrigger')!;
    expect(trigger).toMatch(/inset-block-start: 1px;/);
    expect(trigger).toMatch(/inset-inline-end: 1px;/);
    expect(trigger).toMatch(/inline-size: 1\.25rem;\s*block-size: 1\.25rem;/);
    expect(trigger).toMatch(/z-index: 1;/);
  });

  it('v5.4: --ring and --invalid are defined (--invalid in both blocks)', () => {
    const sheet = css();
    expect(ruleOf(sheet, '.page')).toContain('--ring: var(--mantine-color-signal-6);');
    expect(ruleOf(sheet, '.page')).toContain('--invalid: var(--mantine-color-red-7);');
    expect(ruleOf(sheet, DARK_PAGE)).toContain('--invalid: var(--mantine-color-red-5);');
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
