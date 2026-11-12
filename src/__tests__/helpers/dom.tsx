import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { theme } from '@/theme';
import { WorkspaceModeProvider } from '@/components/shell/WorkspaceMode';

/**
 * jsdom render helpers for the UX-1 table tests (no @testing-library — trap T-I). Menus and modals render in a portal,
 * so queries go through `document.body` (trap T-H).
 */
export function installDomStubs(): void {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
  });
  // Mantine's Combobox scrolls the selected option into view on a timer; jsdom has no layout (an uncaught TypeError).
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
}

export interface Mounted { container: HTMLDivElement; root: Root }

export async function mount(ui: ReactNode, mode: 'full' | 'read_only' = 'full'): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MantineProvider env="test" theme={theme}>
        <WorkspaceModeProvider mode={mode}>{ui}</WorkspaceModeProvider>
      </MantineProvider>,
    );
  });
  return { container, root };
}

export function unmount(m: Mounted | undefined): void {
  if (!m) return;
  act(() => m.root.unmount());
  m.container.remove();
  document.body.innerHTML = '';
}

export const wait = (ms = 20) => act(async () => new Promise((r) => setTimeout(r, ms)));

/**
 * Poll until `check()` is true (launch hardening H3): for a UI state that is expected to APPEAR, instead of a fixed
 * sleep that a slow CI runner can outlast. Only each 20 ms sleep runs inside act — never the loop: React 19 flushes the
 * renders scheduled inside an act scope only when its callback resolves, so a loop inside one act would never see the
 * change. Throws with `description` after `timeout` ms. Not for "nothing happened" / debounce / negative checks — those
 * keep their fixed wait().
 */
export async function waitUntil(check: () => boolean, description: string, { timeout = 2000 }: { timeout?: number } = {}): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${description}`);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
}
export async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error('click: element not found');
  await act(async () => { (el as HTMLElement).click(); });
  await wait();
}

/** Every button in the page (incl. portals) whose trimmed text equals `text`. */
export const buttonsByText = (text: string) =>
  [...document.body.querySelectorAll('button')].filter((b) => b.textContent?.trim() === text) as HTMLButtonElement[];
export const buttonByText = (text: string) => buttonsByText(text)[0];
export const menuItems = () => [...document.body.querySelectorAll('[role="menuitem"]')] as HTMLElement[];
export const menuItem = (label: string) => menuItems().find((i) => i.textContent?.startsWith(label));
export const rowMenuTrigger = (rowLabel: string) => document.body.querySelector(`button[aria-label="More actions for ${rowLabel}"]`) as HTMLButtonElement | null;

export async function openRowMenu(rowLabel: string): Promise<void> {
  await click(rowMenuTrigger(rowLabel));
}
export async function chooseRowAction(rowLabel: string, label: string): Promise<void> {
  await openRowMenu(rowLabel);
  await click(menuItem(label));
}
/** The open Mantine Modal / Drawer dialog whose title contains `title`. */
export const dialogTitled = (title: string) =>
  [...document.body.querySelectorAll('[role="dialog"]')].find((d) => d.textContent?.includes(title)) as HTMLElement | undefined;
export const isSwitch = (el: Element) => el.matches('input[role="switch"], .mantine-Switch-input');
