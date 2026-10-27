// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { theme } from '@/theme';
import { RowActions, type RowAction } from '@/components/ui/RowActions';
import { READ_ONLY_TOOLTIP, WorkspaceModeProvider } from '@/components/shell/WorkspaceMode';
import { expectNoAxeViolations } from '../helpers/axe';

/**
 * feature-plan-ux-foundations.md §4.4 / T7: the six RowActions rendering rules — primary button, menu trigger name,
 * keyboard focus, danger items last behind a divider (with the .danger class, never shade-6 red), aria-disabled
 * (not disabled) items with their reason, single-action buttons, read-only buttons, busy, and axe.
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

async function render(props: { primary?: RowAction; items: RowAction[] }, mode: 'full' | 'read_only' = 'full') {
  await act(async () => {
    root.render(
      <MantineProvider env="test" theme={theme}>
        <WorkspaceModeProvider mode={mode}>
          <RowActions rowLabel="NAV-01" {...props} />
        </WorkspaceModeProvider>
      </MantineProvider>,
    );
  });
}
const wait = (ms = 20) => act(async () => new Promise((r) => setTimeout(r, ms)));
const trigger = () => container.querySelector('button[aria-label="More actions for NAV-01"]') as HTMLButtonElement | null;
const menuItems = () => [...document.body.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
const itemLabels = () => menuItems().map((i) => i.textContent);
async function openMenu() { await act(async () => { trigger()!.click(); }); await wait(); }
const buttonByText = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;

const act_ = (key: string, extra: Partial<RowAction> = {}): RowAction => ({ key, label: key, icon: 'edit', onSelect: vi.fn(), ...extra });

describe('RowActions (T7)', () => {
  it('rule 1–2: the primary renders as a visible labelled button; the trigger is named "More actions for <row>"', async () => {
    const edit = act_('Edit');
    await render({ primary: edit, items: [act_('Rates', { icon: 'rates' }), act_('History', { icon: 'history' })] });
    const primary = buttonByText('Edit')!;
    expect(primary).toBeDefined();
    expect(primary.getAttribute('data-variant')).toBe('subtle');
    await act(async () => { primary.click(); });
    expect(edit.onSelect).toHaveBeenCalledTimes(1);
    expect(trigger()).not.toBeNull();
    expect(trigger()!.getAttribute('aria-haspopup')).toBe('menu');
  });

  it('rule 2: opening by keyboard focuses the first item (no focus placeholder)', async () => {
    await render({ items: [act_('Rates', { icon: 'rates' }), act_('History', { icon: 'history' })] });
    trigger()!.focus();
    await act(async () => { trigger()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); trigger()!.click(); });
    await wait(50);
    expect(document.activeElement).toBe(menuItems()[0]);
    expect(document.body.querySelector('[data-autofocus]')).toBeNull();
  });

  it('rule 2: danger items render last behind one divider whatever the input order, with the .danger class and no shade-6 red', async () => {
    await render({ items: [act_('Deactivate…', { icon: 'deactivate', tone: 'danger' }), act_('Change labor category', { icon: 'laborCategory' })] });
    await openMenu();
    expect(itemLabels()).toEqual(['Change labor category', 'Deactivate…']);
    const dropdown = document.body.querySelector('[role="menu"]')!;
    const children = [...dropdown.children];
    const divider = children.findIndex((c) => c.className.includes('divider'));
    expect(divider).toBe(children.indexOf(menuItems()[1]) - 1);
    const danger = menuItems()[1];
    expect(danger.className).toMatch(/danger/);
    expect(danger.getAttribute('style') ?? '').not.toContain('--menu-item-color: var(--mantine-color-red-6)');
  });

  it('rule 2: no leading divider when every item is danger (API keys: Revoke, Delete)', async () => {
    await render({ items: [act_('Revoke…', { icon: 'revokeKey', tone: 'danger' }), act_('Delete…', { icon: 'delete', tone: 'danger' })] });
    await openMenu();
    expect(itemLabels()).toEqual(['Revoke…', 'Delete…']);
    expect([...document.body.querySelector('[role="menu"]')!.children].some((c) => c.className.includes('divider'))).toBe(false);
  });

  it('rule 4: read-only — write items are aria-disabled (not disabled), reachable with ArrowDown, show the reason, do nothing; writes:false items stay enabled', async () => {
    const rates = act_('Rates', { icon: 'rates' });
    const reset = act_('Reset password…', { icon: 'resetPassword', writes: false });
    await render({ items: [rates, reset] }, 'read_only');
    await openMenu();
    const [ratesItem, resetItem] = menuItems();
    expect(ratesItem.getAttribute('aria-disabled')).toBe('true');
    expect(ratesItem.hasAttribute('disabled')).toBe(false);
    expect(ratesItem.hasAttribute('data-disabled')).toBe(false);
    expect(ratesItem.textContent).toContain('Read-only workspace');
    // ArrowDown from the dropdown reaches the first (aria-disabled) item: it's in Mantine's keyboard set.
    await act(async () => { document.body.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(document.activeElement).toBe(ratesItem);
    await act(async () => { ratesItem.click(); });
    expect(rates.onSelect).not.toHaveBeenCalled();
    expect(menuItems()).toHaveLength(2); // the menu stays open
    expect(resetItem.getAttribute('aria-disabled')).toBeNull();
    await act(async () => { resetItem.click(); });
    expect(reset.onSelect).toHaveBeenCalledTimes(1);
  });

  it('rule 4: disabledReason — aria-disabled with the reason inside the item', async () => {
    const deactivate = act_('Deactivate…', { icon: 'deactivate', tone: 'danger', disabledReason: "You can't deactivate your own account" });
    await render({ primary: act_('Edit'), items: [act_('Rates', { icon: 'rates' }), deactivate] });
    await openMenu();
    const item = menuItems().find((i) => i.textContent?.includes('Deactivate'))!;
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.textContent).toContain("You can't deactivate your own account");
    await act(async () => { item.click(); });
    expect(deactivate.onSelect).not.toHaveBeenCalled();
  });

  it('rule 3: one visible item and no primary → a labelled button, no menu; danger uses subtle + red; hidden → nothing', async () => {
    const deactivate = act_('Deactivate…', { icon: 'deactivate', tone: 'danger' });
    await render({ items: [deactivate] });
    expect(trigger()).toBeNull();
    const button = buttonByText('Deactivate…')!;
    expect(button.getAttribute('data-variant')).toBe('subtle');
    expect(button.getAttribute('style') ?? '').toContain('--mantine-color-red');
    await act(async () => { button.click(); });
    expect(deactivate.onSelect).toHaveBeenCalledTimes(1);

    await render({ items: [{ ...deactivate, hidden: true }] });
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('rule 3: a lone action disabled by a reason shows the reason as visible text', async () => {
    const end = act_('End assignment…', { icon: 'endAssignment', disabledReason: 'Already ended' });
    await render({ items: [end] });
    const button = buttonByText('End assignment…')!;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(container.textContent).toContain('Already ended');
    await act(async () => { button.click(); });
    expect(end.onSelect).not.toHaveBeenCalled();
  });

  it('rule 4b: read-only primary and single buttons — aria-disabled, click does nothing, described by the read-only text', async () => {
    const edit = act_('Edit');
    await render({ primary: edit, items: [act_('Rates', { icon: 'rates' }), act_('History', { icon: 'history' })] }, 'read_only');
    const primary = buttonByText('Edit')!;
    expect(primary.getAttribute('aria-disabled')).toBe('true');
    expect(primary.hasAttribute('disabled')).toBe(false);
    await act(async () => { primary.click(); });
    expect(edit.onSelect).not.toHaveBeenCalled();
    expect(document.getElementById(primary.getAttribute('aria-describedby')!)!.textContent).toBe(READ_ONLY_TOOLTIP);

    const deactivate = act_('Deactivate…', { icon: 'deactivate', tone: 'danger' });
    await render({ items: [deactivate] }, 'read_only');
    const single = buttonByText('Deactivate…')!;
    expect(single.getAttribute('aria-disabled')).toBe('true');
    await act(async () => { single.click(); });
    expect(deactivate.onSelect).not.toHaveBeenCalled();
    expect(document.getElementById(single.getAttribute('aria-describedby')!)!.textContent).toBe(READ_ONLY_TOOLTIP);
  });

  it('rule 5: the wrapper never wraps and aligns right', async () => {
    await render({ primary: act_('Edit'), items: [act_('Rates', { icon: 'rates' }), act_('History', { icon: 'history' })] });
    const group = container.querySelector('.mantine-Group-root') as HTMLElement;
    expect(group, container.innerHTML.slice(0, 300)).not.toBeNull();
    expect(group.getAttribute('style') ?? '').toMatch(/--group-wrap:\s*nowrap/);
    expect(group.getAttribute('style') ?? '').toMatch(/--group-justify:\s*flex-end/);
  });

  it('busy blocks clicks and shows a loader', async () => {
    const edit = act_('Edit', { busy: true });
    await render({ primary: edit, items: [act_('Rates', { icon: 'rates' }), act_('History', { icon: 'history' })] });
    const primary = buttonByText('Edit')!;
    expect(primary.getAttribute('data-loading')).toBe('true');
    expect(primary.querySelector('.mantine-Loader-root, [class*="Loader"]')).not.toBeNull();
    await act(async () => { primary.click(); });
    expect(edit.onSelect).not.toHaveBeenCalled();
  });

  it('axe: clean on document.body with the menu closed and open (incl. read-only items)', async () => {
    await render({ primary: act_('Edit'), items: [act_('Rates', { icon: 'rates' }), act_('Deactivate…', { icon: 'deactivate', tone: 'danger' })] }, 'read_only');
    await expectNoAxeViolations(document.body);
    await openMenu();
    await expectNoAxeViolations(document.body);
  });
});
