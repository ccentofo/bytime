// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { format } from 'util';
import { readFileSync } from 'fs';
import path from 'path';
import { MantineProvider } from '@mantine/core';
import { MantineReactTable, MRT_ShowHideColumnsButton, type MRT_ColumnDef } from 'mantine-react-table';
import { useAppTable } from '@/components/table/mrtDefaults';

/**
 * feature-plan-ux-foundations.md T5 (UX-AUDIT B4): with the Collapse patch, MRT's collapsible parts actually OPEN —
 * the detail panel, the global search — and React no longer warns about a non-boolean `in` attribute. Unpatched, the
 * panel is in the DOM but hidden, so presence is not enough: `isRendered` walks the ancestors. T6: the shared
 * useAppTable defaults (aria-sort, the actions header's name, no toolbar toggles, a bordered search box).
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
    renderDetailPanel: ({ row }) => <div data-testid={`panel-${row.original.id}`}>Detail for {row.original.name}</div>,
  });
  return <MantineReactTable table={table} />;
}

type Person = { id: string; name: string; email: string; note: string };
const PEOPLE_COLUMNS: MRT_ColumnDef<Person>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'email', header: 'Email' },
  { accessorKey: 'note', header: 'Note' },
];
const PEOPLE: Person[] = [{ id: 'a', name: 'Bo', email: 'bo@x', note: 'n1' }, { id: 'b', name: 'Al', email: 'al@x', note: 'n2' }];
const SORTED = { sorting: [{ id: 'name', desc: false }] };
const HIDDEN = { columnVisibility: { note: false } };

/** Like a migrated table: row actions; optionally AuditTrail's hidden column + its show/hide-columns button. */
function PeopleTable({ auditLike = false }: { auditLike?: boolean }) {
  const table = useAppTable<Person>({
    columns: PEOPLE_COLUMNS,
    data: PEOPLE,
    enableRowActions: true,
    renderRowActions: () => <button type="button">Edit</button>,
    initialState: auditLike ? HIDDEN : SORTED,
    ...(auditLike ? { enableToolbarInternalActions: true, renderToolbarInternalActions: ({ table: t }) => <MRT_ShowHideColumnsButton table={t} /> } : {}),
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
const searchInput = () => container.querySelector('input[aria-label="Search this table"]') as HTMLInputElement | null;

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

describe('useAppTable defaults (T6)', () => {
  const headCell = (label: string) => [...container.querySelectorAll('thead th')].find((th) => th.textContent?.includes(label)) as HTMLElement;
  const renderPeople = async (auditLike = false) => {
    await act(async () => { root.render(<MantineProvider env="test"><PeopleTable auditLike={auditLike} /></MantineProvider>); });
  };

  it('aria-sort: ascending on the sorted column, none on a sortable unsorted one', async () => {
    await renderPeople();
    expect(headCell('Name').getAttribute('aria-sort')).toBe('ascending');
    expect(headCell('Email').getAttribute('aria-sort')).toBe('none');
  });

  it('the actions column header has the accessible name "Actions" (visually hidden), right-aligned', async () => {
    await renderPeople();
    const ths = [...container.querySelectorAll('thead th')];
    const actions = ths[ths.length - 1] as HTMLElement;
    expect(actions.textContent?.trim()).toBe('Actions');
    expect(actions.style.textAlign).toBe('right');
  });

  it('no toolbar toggle icons by default; the search box uses the bordered `default` variant', async () => {
    await renderPeople();
    for (const label of ['Show/Hide search', 'Show/Hide filters', 'Show/Hide columns', 'Toggle density', 'Toggle full screen']) {
      expect(container.querySelector(`button[aria-label="${label}"]`), label).toBeNull();
    }
    expect(searchInput()?.getAttribute('data-variant')).toBe('default');
  });

  it('a table configured like AuditTrail renders the show/hide-columns button (and only it)', async () => {
    await renderPeople(true);
    expect(container.querySelector('button[aria-label="Show/Hide columns"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Show/Hide filters"]')).toBeNull();
    // …and AuditTrail itself is configured that way (it hides Comment / Entered By by default).
    const audit = readFileSync(path.resolve(__dirname, '../../app/(app)/admin/audit-trail/AuditTrailClient.tsx'), 'utf8');
    expect(audit).toContain('enableToolbarInternalActions: true,');
    expect(audit).toContain('renderToolbarInternalActions: ({ table }) => <MRT_ShowHideColumnsButton table={table} />,');
  });
});
