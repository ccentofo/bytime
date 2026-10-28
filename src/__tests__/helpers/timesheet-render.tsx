import '@testing-library/react'; // configures act for user-event (feature-plan-ux-timesheet-ui.md §9)
import { render, type RenderResult } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { MantineProvider, Modal, createTheme, mergeThemeOverrides } from '@mantine/core';
import { theme } from '@/theme';
import { WorkspaceModeProvider } from '@/components/shell/WorkspaceMode';
import { TimesheetProvider, useTimesheet } from '@/components/timesheet/TimesheetContext';
import type { TimesheetPageData } from '@/types/timesheet';

/**
 * Test rendering for the timesheet (§9): the app theme with Modal transitions at 0 ms (so onExitTransitionEnd runs
 * synchronously), jsdom stubs, and a probe that hands the live context to the test after every commit.
 */

export const testTheme = mergeThemeOverrides(theme, createTheme({ components: { Modal: Modal.extend({ defaultProps: { transitionProps: { duration: 0 } } }) } }));

export function installTimesheetDomStubs(matches: (query: string) => boolean = () => false): void {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: matches(query), media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
}

export type Ctx = ReturnType<typeof useTimesheet>;
export const live: { ctx: Ctx | null } = { ctx: null };

function Probe() {
  const value = useTimesheet();
  useEffect(() => { live.ctx = value; });
  return null;
}

export function withTheme(ui: ReactNode): ReactNode {
  return (
    <MantineProvider env="test" theme={testTheme}>
      <WorkspaceModeProvider mode="full">{ui}</WorkspaceModeProvider>
    </MantineProvider>
  );
}

/** Mount `children` inside a TimesheetProvider for `data`. `rerenderWith` swaps initialData (an RSC re-sync). */
export function renderTimesheet(data: TimesheetPageData, children: ReactNode): RenderResult & { rerenderWith: (next: TimesheetPageData) => void } {
  const tree = (d: TimesheetPageData) => withTheme(<TimesheetProvider initialData={d}>{children}<Probe /></TimesheetProvider>);
  const result = render(tree(data));
  return Object.assign(result, { rerenderWith: (next: TimesheetPageData) => result.rerender(tree(next)) });
}

/** Tab until focus is inside the grid (the note button above the table comes first in tab order, §4.1). */
export async function enterGrid(user: { tab: () => Promise<void> }): Promise<void> {
  for (let i = 0; i < 6 && !document.activeElement?.closest('table[role="grid"]'); i++) await user.tab();
}
