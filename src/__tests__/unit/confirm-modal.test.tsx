// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { theme } from '@/theme';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { expectNoAxeViolations } from '../helpers/axe';

/**
 * feature-plan-ux-foundations.md §4.6 / T8: ConfirmModal's tone — danger (default) is the red button, neutral the
 * primary color (e.g. Reactivate no longer shows red); the confirm button is disabled while loading; axe clean.
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

  it('the confirm button is disabled while loading (no double submit)', async () => {
    const onConfirm = vi.fn();
    await render({ loading: true, onConfirm });
    const b = [...document.body.querySelectorAll('button')].find((x) => x.getAttribute('data-loading') === 'true') as HTMLButtonElement;
    expect(b).toBeDefined();
    expect(b.disabled).toBe(true);
  });

  it('axe: clean on document.body while open', async () => {
    await render();
    await expectNoAxeViolations(document.body);
  });
});
