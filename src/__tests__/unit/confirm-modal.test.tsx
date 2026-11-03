// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { theme } from '@/theme';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { expectNoAxeViolations } from '../helpers/axe';

/**
 * feature-plan-ux-foundations.md §4.6 / T8: ConfirmModal's tone — danger (default) is the red button, neutral the
 * primary color (e.g. Reactivate no longer shows red); while loading the dialog is locked and its buttons are
 * aria-disabled (feature-plan-ux-page-fixes.md §3); the error slot; axe clean.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
  });
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); document.body.innerHTML = ''; });

async function render(props: Partial<React.ComponentProps<typeof ConfirmModal>> = {}) {
  await act(async () => {
    root.render(
      <MantineProvider env="test" theme={theme}>
        <ConfirmModal opened title="Deactivate NAV-01?" message="Employees can't charge new time to it." confirmLabel="Deactivate" onConfirm={vi.fn()} onCancel={vi.fn()} {...props} />
      </MantineProvider>,
    );
  });
}
const confirmButton = (label = 'Deactivate') => [...document.body.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;
const colorVar = (b: HTMLElement) => b.getAttribute('style') ?? '';

describe('ConfirmModal tone (T8)', () => {
  it('default tone → red confirm button', async () => {
    await render();
    expect(colorVar(confirmButton())).toContain('--mantine-color-red');
  });

  it('tone="neutral" → the primary color, not red', async () => {
    await render({ tone: 'neutral', confirmLabel: 'Reactivate', title: 'Reactivate NAV-01?' });
    const b = confirmButton('Reactivate');
    expect(colorVar(b)).not.toContain('--mantine-color-red');
    expect(b.getAttribute('data-variant') ?? 'filled').toBe('filled');
  });

  // feature-plan-ux-page-fixes.md §3 / T-CM: locked while loading, aria-disabled and never `disabled` (focus would drop),
  // never Mantine `loading` (it sets `disabled`); a click while loading does nothing (no double submit).
  it('while loading: the confirm button is aria-disabled, never disabled, and a click does nothing; Cancel too', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    await render({ loading: true, onConfirm, onCancel });
    const b = confirmButton();
    expect(b.getAttribute('aria-disabled')).toBe('true');
    expect(b.hasAttribute('disabled')).toBe(false);
    expect(b.getAttribute('data-loading')).toBeNull();
    const cancel = confirmButton('Cancel');
    expect(cancel.getAttribute('aria-disabled')).toBe('true');
    expect(cancel.hasAttribute('disabled')).toBe(false);
    await act(async () => { b.click(); cancel.click(); });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  // UX-4A-AUDIT.md M1: a busy button is data-disabled (grey fill), so a Loader in --button-color (white) vanishes.
  it('M1: the busy Loader is shown and never uses --button-color (in ConfirmModal and the Reports buttons)', async () => {
    await render({ loading: true });
    const loader = confirmButton().querySelector('.mantine-Loader-root') as HTMLElement;
    expect(loader).not.toBeNull();
    expect(loader.getAttribute('style') ?? '').not.toContain('--button-color');
    for (const file of ['src/components/ui/ConfirmModal.tsx', 'src/app/(app)/admin/reports/ReportsClient.tsx']) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/<Loader[^>]*--button-color/);
    }
  });

  it('while loading: Esc doesn\'t close and there is no ✕; when not loading, Esc and ✕ cancel', async () => {
    const onCancel = vi.fn();
    await render({ loading: true, onCancel });
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(onCancel).not.toHaveBeenCalled();
    expect(document.body.querySelector('.mantine-Modal-close')).toBeNull();
    await render({ loading: false, onCancel });
    expect(document.body.querySelector('.mantine-Modal-close')).not.toBeNull();
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('the error prop renders role="alert" inside the dialog, above the buttons; absent → nothing', async () => {
    await render({ error: 'The role couldn\'t be changed.' });
    const dialog = document.body.querySelector('[role="dialog"]')!;
    const alert = dialog.querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe('The role couldn\'t be changed.');
    expect(alert.compareDocumentPosition(confirmButton()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await render({ error: undefined });
    expect(document.body.querySelector('[role="dialog"] [role="alert"]')).toBeNull();
  });

  it('axe: clean on document.body while open', async () => {
    await render();
    await expectNoAxeViolations(document.body);
  });
});
