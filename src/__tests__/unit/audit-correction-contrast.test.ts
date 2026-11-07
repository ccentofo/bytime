import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { DEFAULT_THEME } from '@mantine/core';
import { theme } from '@/theme';
import { stripComments } from '../helpers/source-scanner';
import { isLateEntry } from '@/lib/audit/late-entry';

/**
 * feature-plan-ux-people-codes.md §6.2 / AU-10 (replacing ux-page-fixes C14): Audit trail rows changed after their first
 * entry (revision ≥ 2) or entered late get a warning EDGE on the first cell, and no fill — `--audit-correction-bg` is
 * gone from globals.css and the client. The edge is defined for both schemes without the CSS light/dark function, covers
 * `data-correction` AND `data-late`, and keeps 3:1 against the page background in both schemes. Late = the Approvals row
 * rule (an app revision 1 with a reason).
 */

const ROOT = path.resolve(__dirname, '../../..');
const css = stripComments(readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf8'));
const client = stripComments(readFileSync(path.join(ROOT, 'src/app/(app)/admin/audit-trail/AuditTrailClient.tsx'), 'utf8'));
const colors = { ...DEFAULT_THEME.colors, ...theme.colors } as Record<string, readonly string[]>;

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (hex: string) => { const v = rgb(hex).map((x) => x / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const resolve = (v: string) => { const m = v.match(/var\(--mantine-color-([a-z]+)-(\d)\)/); return m ? colors[m[1]][Number(m[2])] : v.trim(); };
const block = (selector: string) => { const i = css.indexOf(`${selector} {`); return i < 0 ? '' : css.slice(i, css.indexOf('}', i)); };
const varIn = (selector: string, name: string) => block(selector).match(new RegExp(`${name}:\\s*([^;]+);`))?.[1];

describe('Audit trail changed / late rows (AU-10)', () => {
  it('no --audit-correction-bg anywhere: no fill, in the stylesheet or the client', () => {
    expect(css).not.toContain('--audit-correction-bg');
    expect(client).not.toContain('--audit-correction-bg');
    expect(client).not.toMatch(/backgroundColor:/);
  });

  it('the edge is defined for both schemes (no CSS light/dark function) and drawn for changed AND late rows', () => {
    expect(varIn(':root', '--audit-correction-edge')).toBe('var(--mantine-color-warning-7)');
    expect(varIn(":root[data-mantine-color-scheme='dark']", '--audit-correction-edge')).toBe('var(--mantine-color-warning-6)');
    expect(css).not.toMatch(/light-dark\(/);
    const rule = css.slice(css.indexOf("tr[data-correction='true'] > td:first-child"), css.indexOf('}', css.indexOf("tr[data-correction='true'] > td:first-child")));
    expect(rule).toContain("tr[data-late='true'] > td:first-child");
    expect(rule).toContain('box-shadow: inset 3px 0 0 var(--audit-correction-edge)');
  });

  it('the client marks late rows with data-late (the Approvals row rule) and changed rows with data-correction', () => {
    expect(client).toContain("'data-late': isLateEntry(e) ? 'true' : undefined,");
    expect(client).toContain("'data-correction': e.revisionNumber >= 2 ? 'true' : undefined,");
    expect(isLateEntry({ revisionNumber: 1, source: 'app', changeReasonCode: 'CORRECTION' })).toBe(true);
    expect(isLateEntry({ revisionNumber: 1, source: 'migration', changeReasonCode: 'LATE_ENTRY' })).toBe(false);
    expect(isLateEntry({ revisionNumber: 2, source: 'app', changeReasonCode: 'LATE_ENTRY' })).toBe(false);
    expect(isLateEntry({ revisionNumber: 1, source: 'app', changeReasonCode: null })).toBe(false);
  });

  it('the edge keeps 3:1 against the page background in both schemes', () => {
    const light = resolve(varIn(':root', '--audit-correction-edge')!);
    const dark = resolve(varIn(":root[data-mantine-color-scheme='dark']", '--audit-correction-edge')!);
    expect(ratio(light, '#ffffff')).toBeGreaterThanOrEqual(3);
    expect(ratio(dark, colors.dark[7])).toBeGreaterThanOrEqual(3);
  });
});
