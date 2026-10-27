import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { DEFAULT_THEME, darken, mergeMantineTheme } from '@mantine/core';
import { cssVariablesResolver, theme } from '@/theme';
import { stripComments } from '../helpers/source-scanner';
import * as statusColors from '@/lib/ui/status-colors';

/**
 * feature-plan-ux-foundations.md §4.1 / T1, T1b, T2 (UX-AUDIT A5, V9): the theme is contrast-safe in both schemes,
 * the palette is restricted (no unknown colors, no explicit shades), and the provider setup survives the Server
 * Component layout.
 */

const ROOT = path.resolve(__dirname, '../../..');
const merged = mergeMantineTheme(DEFAULT_THEME, theme); // the bare theme leaves theme.scale undefined
const PALETTE = ['signal', 'ink', 'gray', 'success', 'warning', 'red', 'cyan'] as const;

// ── WCAG 2.x contrast ────────────────────────────────────────────────────────────────────────────────────────────
function rgb(color: string): [number, number, number] {
  const hex = color.trim().match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) as [number, number, number];
  const fn = color.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  throw new Error(`unparseable color ${color}`);
}
function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE = '#ffffff';
const LIGHT_BG = ['#ffffff', '#f7f8fb', '#f1f3f5'];   // white, ink-0, gray-1 (filled inputs, menu hover)
const DARK_BG = ['#181a20', '#23262f', '#343a48'];    // dark-7, dark-6, dark-5
const BORDER_LIGHT_BG = ['#ffffff', '#f7f8fb'];
const BORDER_DARK_BG = ['#181a20', '#23262f'];

type Pair = { what: string; fg: string; bg: string; min: number };
function failures(pairs: Pair[]): string[] {
  return pairs.filter((p) => contrast(p.fg, p.bg) < p.min)
    .map((p) => `${p.what}: ${p.fg} on ${p.bg} = ${contrast(p.fg, p.bg).toFixed(2)} (< ${p.min})`);
}

/**
 * Mantine 9.3.1's derivation (node_modules/@mantine/core/esm/core/MantineProvider/MantineCssVariables/
 * get-css-color-variables.mjs): light — filled = text = outline = shade[primaryShade.light], light = shade 1,
 * light-color = shade 9; dark — filled = shade[primaryShade.dark], text = shade 4, light = darken(shade 9, .5),
 * light-color = shade 0.
 */
function ruleR(name: string): Pair[] {
  const c = merged.colors[name];
  const shade = (scheme: 'light' | 'dark') => (typeof merged.primaryShade === 'object' ? merged.primaryShade[scheme] : merged.primaryShade);
  const lightFilled = c[shade('light')];
  const darkFilled = c[shade('dark')];
  return [
    { what: `${name} light: white on filled`, fg: WHITE, bg: lightFilled, min: 4.5 },
    { what: `${name} light: text on white`, fg: lightFilled, bg: '#ffffff', min: 4.5 },
    { what: `${name} light: text on ink-0`, fg: lightFilled, bg: '#f7f8fb', min: 4.5 },
    { what: `${name} light: light badge`, fg: c[9], bg: c[1], min: 4.5 },
    { what: `${name} dark: white on filled`, fg: WHITE, bg: darkFilled, min: 4.5 },
    { what: `${name} dark: text on dark-7`, fg: c[4], bg: '#181a20', min: 4.5 },
    { what: `${name} dark: text on dark-6`, fg: c[4], bg: '#23262f', min: 4.5 },
    { what: `${name} dark: light badge`, fg: c[0], bg: darken(c[9], 0.5), min: 4.5 },
  ];
}

describe('T1: contrast (rule R, both schemes)', () => {
  it('primaryShade is 7 in both schemes', () => {
    expect(merged.primaryShade).toEqual({ light: 7, dark: 7 });
  });

  for (const name of PALETTE) {
    it(`${name}: filled, text, outline and light-badge pairs ≥ 4.5:1 in light and dark`, () => {
      expect(failures(ruleR(name))).toEqual([]);
    });
  }

  it('resolver variables: dimmed / error / placeholder ≥ 4.5 on every background; default-border ≥ 3 on input backgrounds', () => {
    const v = cssVariablesResolver(merged);
    expect(Object.keys(v).sort()).toEqual(['dark', 'light', 'variables']);
    const pairs: Pair[] = [];
    for (const key of ['--mantine-color-dimmed', '--mantine-color-error', '--mantine-color-placeholder'] as const) {
      for (const bg of LIGHT_BG) pairs.push({ what: `light ${key}`, fg: v.light[key], bg, min: 4.5 });
      for (const bg of DARK_BG) pairs.push({ what: `dark ${key}`, fg: v.dark[key], bg, min: 4.5 });
    }
    for (const bg of BORDER_LIGHT_BG) pairs.push({ what: 'light default-border', fg: v.light['--mantine-color-default-border'], bg, min: 3 });
    for (const bg of BORDER_DARK_BG) pairs.push({ what: 'dark default-border', fg: v.dark['--mantine-color-default-border'], bg, min: 3 });
    expect(failures(pairs)).toEqual([]);
  });

  it('danger text (§4.1.7): red-7 on white / red-0 / gray-1; red-4 on dark-6 / dark-5 ≥ 4.5', () => {
    const red = merged.colors.red;
    expect(failures([
      { what: 'red-7 on white', fg: red[7], bg: '#ffffff', min: 4.5 },
      { what: 'red-7 on red-0', fg: red[7], bg: red[0], min: 4.5 },
      { what: 'red-7 on gray-1', fg: red[7], bg: merged.colors.gray[1], min: 4.5 },
      { what: 'red-4 on dark-6', fg: red[4], bg: merged.colors.dark[6], min: 4.5 },
      { what: 'red-4 on dark-5', fg: red[4], bg: merged.colors.dark[5], min: 4.5 },
    ])).toEqual([]);
  });

  // M1 (UX-1 fix round 1): the focus ring, the focused input border and checked indicators are drawn with
  // --mantine-primary-color-filled (signal-7 in both schemes) unless overridden. Read the ACTUAL colors from the
  // overrides — a missing override falls back to Mantine's default, so deleting one fails the contrast pairs below.
  const css = readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf8');
  const primaryFilled = merged.colors.signal[typeof merged.primaryShade === 'object' ? merged.primaryShade.dark : merged.primaryShade];
  const lightDark = (value: string | undefined) => {
    const m = value?.match(/light-dark\(var\(--mantine-color-signal-(\d)\),\s*var\(--mantine-color-signal-(\d)\)\)/);
    return m ? { light: merged.colors.signal[Number(m[1])], dark: merged.colors.signal[Number(m[2])] } : null;
  };
  const ring = () => {
    const rule = css.match(/:root \.mantine-focus-auto:focus-visible,\s*:root \.mantine-focus-always:focus \{\s*outline-color: ([^;]+);/);
    return lightDark(rule?.[1]) ?? { light: primaryFilled, dark: primaryFilled };
  };
  const inputFocusDark = () => {
    const rule = css.match(/:root\[data-mantine-color-scheme='dark'\] \.mantine-Input-wrapper:is\(\[data-variant='default'\], \[data-variant='filled'\]\) \{\s*--input-bd-focus: var\(--mantine-color-signal-(\d)\);/);
    return rule ? merged.colors.signal[Number(rule[1])] : primaryFilled;
  };
  const indicatorOf = (component: 'Checkbox' | 'Radio' | 'Switch' | 'Tabs', cssVar: string) => {
    const vars = (theme.components?.[component] as { vars?: (t: unknown, p: object) => { root?: Record<string, string> } } | undefined)?.vars?.(merged, {});
    return lightDark(vars?.root?.[cssVar]) ?? { light: primaryFilled, dark: primaryFilled };
  };

  it('focus ring (actual color per scheme) ≥ 3:1 — signal-7 on white / ink-0, signal-4 on dark-7 / dark-6', () => {
    const r = ring();
    expect(failures([
      { what: 'ring light on white', fg: r.light, bg: '#ffffff', min: 3 },
      { what: 'ring light on ink-0', fg: r.light, bg: '#f7f8fb', min: 3 },
      { what: 'ring dark on dark-7', fg: r.dark, bg: '#181a20', min: 3 },
      { what: 'ring dark on dark-6', fg: r.dark, bg: '#23262f', min: 3 },
    ])).toEqual([]);
  });

  it('focused input border in dark ≥ 3:1 on the input backgrounds (dark-6 default, dark-5 filled)', () => {
    const c = inputFocusDark();
    expect(failures([
      { what: 'input focus border on dark-6', fg: c, bg: '#23262f', min: 3 },
      { what: 'input focus border on dark-5', fg: c, bg: '#343a48', min: 3 },
    ])).toEqual([]);
  });

  it('checked indicators (Checkbox, Radio, Switch, Tabs) ≥ 3:1 against the surface, with the white mark ≥ 3:1 on them', () => {
    const pairs: Pair[] = [];
    for (const [component, cssVar] of [['Checkbox', '--checkbox-color'], ['Radio', '--radio-color'], ['Switch', '--switch-color'], ['Tabs', '--tabs-color']] as const) {
      const c = indicatorOf(component, cssVar);
      pairs.push(
        { what: `${component} light on white`, fg: c.light, bg: '#ffffff', min: 3 },
        { what: `${component} light on ink-0`, fg: c.light, bg: '#f7f8fb', min: 3 },
        { what: `${component} dark on dark-7`, fg: c.dark, bg: '#181a20', min: 3 },
        { what: `${component} dark on dark-6`, fg: c.dark, bg: '#23262f', min: 3 },
      );
      if (component !== 'Tabs') pairs.push({ what: `${component} white mark on dark fill`, fg: WHITE, bg: c.dark, min: 3 }, { what: `${component} white mark on light fill`, fg: WHITE, bg: c.light, min: 3 });
    }
    expect(failures(pairs)).toEqual([]);
  });

  it('static: the overrides exist (globals.css ring, input focus border, SegmentedControl outline; theme indicator vars)', () => {
    expect(css).toMatch(/:root \.mantine-focus-auto:focus-visible,\s*:root \.mantine-focus-always:focus \{\s*outline-color: light-dark\(var\(--mantine-color-signal-7\), var\(--mantine-color-signal-4\)\);/);
    expect(css).toContain("--input-bd-focus: var(--mantine-color-signal-4);");
    expect(css).toContain('--segmented-control-outline: 2px solid var(--mantine-color-signal-4);');
    // A caller's own color still wins (the theme var steps aside).
    const vars = (theme.components?.Checkbox as { vars: (t: unknown, p: object) => { root: Record<string, string | undefined> } }).vars(merged, { color: 'red' });
    expect(vars.root['--checkbox-color']).toBeUndefined();
  });
});

// ── T1b: palette restriction ────────────────────────────────────────────────────────────────────────────────────
function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === '__tests__' || name === 'node_modules') return [];
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return name.endsWith('.tsx') ? [full] : [];
  });
}

const ALLOWED = new Set<string>([...PALETTE, 'dimmed', 'white', 'black', 'bright']);

/** A color value is OK when it's a `var(...)`, or a palette / special name with NO `.N` shade suffix. */
export function badColor(value: string): string | null {
  if (value.startsWith('var(')) return null;
  if (/\.\d$/.test(value)) return `explicit shade "${value}"`;
  return ALLOWED.has(value) ? null : `color "${value}" is not in the palette`;
}

/**
 * Every `c=` / `color=` string literal: `c="x"`, `color={'x'}`, and the RESULT literals of an expression
 * (`a ? 'x' : 'y'`, `map[k] ?? 'x'`) — never the strings being compared (`status === 'active'`).
 */
export function colorLiterals(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\b(?:c|color)=(?:"([^"]*)"|'([^']*)'|\{\s*['"]([^'"]*)['"]\s*\})/g)) out.push(m[1] ?? m[2] ?? m[3]);
  for (const m of src.matchAll(/\b(?:c|color)=\{([^}]*)\}/g)) {
    for (const r of m[1].matchAll(/(?:\?\?|\?|:)\s*['"]([^'"]+)['"]/g)) out.push(r[1]);
  }
  return out;
}

describe('T1b: palette restriction (static)', () => {
  it('every color= / c= literal in src/**/*.tsx is a palette color, dimmed/white/black/bright or var(…), with no shade suffix', () => {
    const offenders = tsxFiles(path.join(ROOT, 'src')).flatMap((f) =>
      colorLiterals(stripComments(readFileSync(f, 'utf8'))).flatMap((v) => {
        const bad = badColor(v);
        return bad ? [`${path.relative(ROOT, f)}: ${bad}`] : [];
      }));
    expect(offenders).toEqual([]);
  });

  it('every value in src/lib/ui/status-colors.ts is a palette color', () => {
    const values = Object.values(statusColors).flatMap((map) => Object.values(map as Record<string, string>));
    expect(values.length).toBeGreaterThan(10);
    expect(values.filter((v) => badColor(v) !== null)).toEqual([]);
  });

  it('fixture: grape and an explicit shade are flagged; comparisons are not; var() is allowed', () => {
    expect(colorLiterals(`<Badge color="grape" />`).map(badColor)).toEqual(['color "grape" is not in the palette']);
    expect(colorLiterals(`<Text c="warning.7">`).map(badColor)).toEqual(['explicit shade "warning.7"']);
    expect(colorLiterals(`<B color={status === 'remove' ? 'red' : undefined} />`)).toEqual(['red']);
    expect(colorLiterals(`<B color={MAP[k] ?? 'gray'} c={'signal'} />`).sort()).toEqual(['gray', 'signal']);
    expect(badColor('var(--mantine-color-red-6)')).toBeNull();
  });

  it('fixture (L9): a URL\'s // is not a comment; single-quoted attributes are scanned', () => {
    expect(colorLiterals(stripComments(`<Anchor href="https://x.test/docs" c="grape">Docs</Anchor>`)).map(badColor)).toEqual(['color "grape" is not in the palette']);
    expect(colorLiterals(`<Badge color='grape' />`).map(badColor)).toEqual(['color "grape" is not in the palette']);
    expect(stripComments(`const a = 1; // c="grape"`)).not.toContain('grape');
  });
});

// ── T2: Badge, reduced motion, providers ──────────────────────────────────────────────────────────────────────────
describe('T2: theme components and the provider boundary', () => {
  it('Badge is sentence case (textTransform none) and keeps the light variant; reduced motion respected', () => {
    const badge = theme.components?.Badge as { defaultProps?: { variant?: string }; styles?: { root?: Record<string, unknown> } };
    expect(badge.defaultProps?.variant).toBe('light');
    expect(badge.styles?.root).toMatchObject({ textTransform: 'none', fontWeight: 600 });
    expect(theme.respectReducedMotion).toBe(true);
    expect(theme.primaryShade).toEqual({ light: 7, dark: 7 });
  });

  it('layout.tsx (comments stripped) renders neither MantineProvider nor cssVariablesResolver; providers.tsx is a client component that passes the resolver', () => {
    const layout = stripComments(readFileSync(path.join(ROOT, 'src/app/layout.tsx'), 'utf8'));
    expect(layout).not.toContain('MantineProvider');
    expect(layout).not.toContain('cssVariablesResolver');
    expect(layout).toMatch(/<Providers>\{children\}<\/Providers>/);
    const providers = readFileSync(path.join(ROOT, 'src/app/providers.tsx'), 'utf8');
    expect(providers.startsWith("'use client'")).toBe(true);
    expect(providers).toMatch(/<MantineProvider defaultColorScheme="auto" theme=\{theme\} cssVariablesResolver=\{cssVariablesResolver\}>/);
  });
});
