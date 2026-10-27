// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { PageHeader } from '@/components/ui/PageHeader';
import { installDomStubs, mount, unmount, type Mounted } from '../helpers/dom';
import { stripComments } from '../helpers/source-scanner';

/**
 * feature-plan-ux-foundations.md §4.7 / T15 (UX-AUDIT A6): PageHeader is the page's h1 (same visual size as before);
 * the app shell's first element is a skip link to #main-content, which is AppShell.Main (focusable, no ring).
 */

const ROOT = path.resolve(__dirname, '../../..');
beforeAll(installDomStubs);
let m: Mounted | undefined;
afterEach(() => { unmount(m); m = undefined; });

describe('page structure (T15)', () => {
  it('PageHeader renders an h1 by default (sized like the old h2), an h2 with order={2}', async () => {
    m = await mount(<PageHeader title="Charge codes" />);
    const h1 = m.container.querySelector('h1');
    expect(h1?.textContent).toBe('Charge codes');
    expect(h1?.getAttribute('style') ?? '').toContain('--title-fz: var(--mantine-h2-font-size)');
    unmount(m);
    m = await mount(<PageHeader title="Billing" order={2} />);
    expect(m.container.querySelector('h1')).toBeNull();
    expect(m.container.querySelector('h2')?.textContent).toBe('Billing');
  });

  it('AppShellWrapper: the first child of AppShell is the skip link to #main-content; AppShell.Main is the target', () => {
    const src = stripComments(readFileSync(path.join(ROOT, 'src/app/(app)/AppShellWrapper.tsx'), 'utf8'));
    const afterOpen = src.slice(src.indexOf('<AppShell\n'));
    const body = afterOpen.slice(afterOpen.indexOf('>') + 1).trimStart();
    expect(body.startsWith('<a href="#main-content" className={classes.skip}>Skip to main content</a>')).toBe(true);
    expect(src).toMatch(/<AppShell\.Main id="main-content" tabIndex=\{-1\}/);
    const css = readFileSync(path.join(ROOT, 'src/app/(app)/AppShellWrapper.module.css'), 'utf8');
    expect(css).toMatch(/\.skip:focus-visible \{[^}]*z-index: 300;/);
    expect(readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf8')).toMatch(/#main-content:focus \{\s*outline: none;\s*\}/);
  });
});
