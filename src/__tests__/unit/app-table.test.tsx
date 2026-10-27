// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { format } from 'util';
import { MantineProvider } from '@mantine/core';
import { MantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import { useAppTable } from '@/components/table/mrtDefaults';

/**
 * feature-plan-ux-foundations.md T5 (UX-AUDIT B4): with the Collapse patch, MRT's collapsible parts actually OPEN —
 * the detail panel, the global search — and React no longer warns about a non-boolean `in` attribute. Unpatched, the
 * panel is in the DOM but hidden, so presence is not enough: `isRendered` walks the ancestors.
 */

// Attached before the file's first render: React warns once per attribute per page load.
const consoleError = vi.spyOn(console, 'error');

type Row = { id: string; name: string };
// Module-level constants: inline columns/data re-create every render and hang act().
const COLUMNS: MRT_ColumnDef<Row>[] = [{ accessorKey: 'name', header: 'Name' }];
const DATA: Row[] = [{ id: '1', name: 'Alpha contract' }, { id: '2', name: 'Bravo contract' }];

function Table() {
  const table = useAppTable<Row>({
    columns: COLUMNS,
    data: DATA,
    enableExpanding: true,
    initialState: { showGlobalFilter: true }, // explicit here; §4.4 makes it the default (T6)
    renderDetailPanel: ({ row }) => <div data-testid={`panel-${row.original.id}`}>Detail for {row.original.name}</div>,
  });
  return <MantineReactTable table={table} />;
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
  });
});
afterAll(() => consoleError.mockRestore());

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

/** Visible to the user: no ancestor is display:none, aria-hidden="true" or inert. */
function isRendered(el: Element | null): boolean {
  if (!el) return false;
  for (let n: Element | null = el; n; n = n.parentElement) {
    if ((n as HTMLElement).style?.display === 'none') return false;
    if (n.getAttribute('aria-hidden') === 'true') return false;
    if (n.hasAttribute('inert')) return false;
  }
  return true;
}
const wait = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)));
const bodyRows = () => [...container.querySelectorAll('tbody tr')].filter((tr) => !tr.querySelector('[data-testid^="panel-"]'));
const searchInput = () => container.querySelector('input[placeholder="Search"]') as HTMLInputElement | null;

async function render() {
  await act(async () => { root.render(<MantineProvider env="test"><Table /></MantineProvider>); });
}

describe('MRT collapsible parts open (T5)', () => {
  it('expanding row 1 renders its detail panel (visible, not just present)', async () => {
    await render();
    const expand = container.querySelector('button[aria-label="Expand"]') as HTMLButtonElement;
    expect(expand).not.toBeNull();
    await act(async () => { expand.click(); });
    await wait(50); // Collapse opens over animation frames
    expect(isRendered(container.querySelector('[data-testid="panel-1"]'))).toBe(true);
  });

  it('the global search is visible on first render, and typing filters the rows', async () => {
    await render();
    const input = searchInput();
    expect(isRendered(input)).toBe(true);
    expect(bodyRows().map((r) => r.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Alpha'), expect.stringContaining('Bravo')]));
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Bravo');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await wait(350); // MRT debounces the global filter 250 ms
    const names = bodyRows().map((r) => r.textContent ?? '').filter((t) => /contract/.test(t));
    expect(names).toHaveLength(1);
    expect(names[0]).toContain('Bravo');
  });

  it('no React warning about a non-boolean `in` attribute (formatted message)', () => {
    const messages = consoleError.mock.calls.map((args) => format(...args));
    expect(messages.filter((m) => /non-boolean attribute .in./.test(m))).toEqual([]);
  });
});
