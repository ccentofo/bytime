import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { DEFAULT_THEME } from '@mantine/core';
import { theme, cssVariablesResolver } from '@/theme';
import { stripComments } from '../helpers/source-scanner';

/**
 * feature-plan-ux-page-fixes.md C14 / T-C14: Audit trail correction rows. The row tint is var(--audit-correction-bg)
 * (no inline light-dark, which gave the light #fee9c4 in dark mode); globals.css defines it for both schemes with no
 * CSS light/dark function; the old dark-mode td colour rule is gone; the warning edge is on td:first-child; and every
 * child keeps its contrast on the tint — body, dimmed and signal text ≥ 4.5:1, the history icon and the edge ≥ 3:1.
 */

const ROOT = path.resolve(__dirname, '../../..');
const css = stripComments(readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf8'));
const client = stripComments(readFileSync(path.join(ROOT, 'src/app/(app)/admin/audit-trail/AuditTrailClient.tsx'), 'utf8'));
const colors = { ...DEFAULT_THEME.colors, ...theme.colors } as Record<string, readonly string[]>;
const vars = cssVariablesResolver(theme as never) as { light: Record<string, string>; dark: Record<string, string> };

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (hex: string) => { const v = rgb(hex).map((x) => x / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** Resolve `var(--mantine-color-{name}-{shade})` or a hex to a hex. */
const resolve = (v: string) => { const m = v.match(/var\(--mantine-color-([a-z]+)-(\d)\)/); return m ? colors[m[1]][Number(m[2])] : v.trim(); };
const block = (selector: string) => { const i = css.indexOf(`${selector} {`); return i < 0 ? '' : css.slice(i, css.indexOf('}', i)); };
const varIn = (selector: string, name: string) => block(selector).match(new RegExp(`${name}:\\s*([^;]+);`))?.[1];

describe('Audit trail correction rows (C14)', () => {
  it('the row uses var(--audit-correction-bg); no inline light-dark', () => {
    expect(client).toContain("backgroundColor: 'var(--audit-correction-bg)'");
    expect(client).not.toMatch(/light-dark\(var\(--mantine-color-warning-0\)/);
  });

  it('globals.css defines the tint and the edge for both schemes, with no CSS light/dark function', () => {
    expect(varIn(':root', '--audit-correction-bg')).toBe('var(--mantine-color-warning-0)');
    expect(varIn(':root', '--audit-correction-edge')).toBe('var(--mantine-color-warning-7)');
    expect(varIn(":root[data-mantine-color-scheme='dark']", '--audit-correction-bg')).toBe('#2a2416');
    expect(varIn(":root[data-mantine-color-scheme='dark']", '--audit-correction-edge')).toBe('var(--mantine-color-warning-6)');
    expect(css).not.toMatch(/light-dark\(/);
  });

  it('the old dark-mode td colour rule is gone; the edge is an inset shadow on td:first-child', () => {
    expect(css).not.toMatch(/tr\[data-correction='true'\]\s+td\s*\{[^}]*color/);
    expect(block("tr[data-correction='true'] > td:first-child")).toContain('box-shadow: inset 3px 0 0 var(--audit-correction-edge)');
  });

  it('contrast on the tint: body / dimmed / signal text ≥ 4.5:1, the icon and the edge ≥ 3:1, in both schemes', () => {
    const light = resolve(varIn(':root', '--audit-correction-bg')!);
    const dark = resolve(varIn(":root[data-mantine-color-scheme='dark']", '--audit-correction-bg')!);
    const pairs: Array<[string, string, string, number]> = [
      ['light body text', DEFAULT_THEME.black, light, 4.5],
      ['dark body text', colors.dark[0], dark, 4.5],
      ['light dimmed', vars.light['--mantine-color-dimmed'], light, 4.5],
      ['dark dimmed', vars.dark['--mantine-color-dimmed'], dark, 4.5],
      ['light signal text', colors.signal[7], light, 4.5],
      ['dark signal text', colors.signal[4], dark, 4.5],
      ['light history icon (gray subtle)', colors.gray[9], light, 3],
      ['dark history icon (gray subtle)', colors.gray[0], dark, 3],
      ['light edge', resolve(varIn(':root', '--audit-correction-edge')!), light, 3],
      ['dark edge', resolve(varIn(":root[data-mantine-color-scheme='dark']", '--audit-correction-edge')!), dark, 3],
    ];
    const failing = pairs.filter(([, fg, bg, min]) => ratio(fg, bg) < min).map(([what, fg, bg]) => `${what}: ${ratio(fg, bg).toFixed(2)}`);
    expect(failing).toEqual([]);
  });
});
