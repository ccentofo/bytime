// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { useEffect } from 'react';
import { MantineReactTable, type MRT_ColumnDef, type MRT_TableInstance } from 'mantine-react-table';
import { useAppTable, DEFAULT_TABLE_OPTIONS, type AppTableExpandable } from '@/components/table/mrtDefaults';
import { installDomStubs, mount, unmount, type Mounted } from '../helpers/dom';

/**
 * feature-plan-hotfix-table-state.md §3: a table's settings never leak into the next table. mantine-react-table writes
 * `columnOrder` and `globalFilterFn` into the `initialState` object it receives; before the fix, every table that
 * passed no `initialState` got the SAME module-level object (DEFAULT_TABLE_OPTIONS.initialState), so the first one's
 * column order (and filter fn) reached every later table until a full reload.
 * T-1 — table A (a, b, c), unmounted; then table B (c, b, x): B's headers are c, b, x.
 * T-2 — an expandable table (globalFilterFn 'treeText') mounting beside a plain one: the plain table's state and its
 *        initialState aren't 'treeText' (they don't share one object).
 * T-3 — DEFAULT_TABLE_OPTIONS is unchanged after rendering tables (deep-equal to the import-time snapshot) and frozen.
 * T-4 — a table passing its own initialState still gets the defaults (showGlobalFilter) merged in.
 * One module instance for the whole file, as in the browser: the tables run one after another in the same session.
 */

const SNAPSHOT = JSON.stringify(DEFAULT_TABLE_OPTIONS);

type Row = Record<string, string>;
const tables: Record<string, MRT_TableInstance<Row>> = {};
const keep = (name: string) => (t: MRT_TableInstance<Row>) => { tables[name] = t; };
let last: MRT_TableInstance<Row> | null = null;
const keepLast = (t: MRT_TableInstance<Row>) => { last = t; };

function Table({ ids, options = {}, onTable = keepLast }: { ids: string[]; options?: Record<string, unknown>; onTable?: (t: MRT_TableInstance<Row>) => void }) {
  const columns: MRT_ColumnDef<Row>[] = ids.map((id) => ({ id, accessorKey: id, header: id.toUpperCase() }));
  const table = useAppTable<Row>({ columns, data: [Object.fromEntries(ids.map((id) => [id, `${id}1`]))], ...options });
  useEffect(() => { onTable(table); });
  return <MantineReactTable table={table} />;
}
const headers = (m: Mounted) => [...m.container.querySelectorAll('thead th')].map((th) => th.textContent?.trim()).filter(Boolean);

beforeAll(installDomStubs);
let m: Mounted | undefined;
afterEach(() => { unmount(m); m = undefined; last = null; });

describe('table settings never leak between tables (hotfix)', () => {
  it('T-1: table B keeps its own column order after table A (no initialState on either)', async () => {
    m = await mount(<Table ids={['a', 'b', 'c']} />);
    expect(headers(m)).toEqual(['A', 'B', 'C']);
    unmount(m);
    m = await mount(<Table ids={['c', 'b', 'x']} />);
    expect(headers(m)).toEqual(['C', 'B', 'X']);
    expect(last!.getState().columnOrder.filter((id) => !id.startsWith('mrt-'))).toEqual(['c', 'b', 'x']);
  });

  it('T-2: an expandable table (treeText) mounting beside a plain one leaves the plain table\'s state and initialState alone', async () => {
    const expandable: AppTableExpandable<Row> = {
      getSubRows: () => undefined, label: (r) => r.name, searchText: (r) => r.name, rowId: (r) => r.name,
    };
    // MRT re-assigns globalFilterFn on each mount, so a table's own STATE can't inherit it; the leak is the shared
    // initialState object under a table that's still mounted (and every later reader of it).
    m = await mount(<><Table ids={['p', 'q']} onTable={keep('plain')} /><Table ids={['name', 'n']} options={{ expandable }} onTable={keep('tree')} /></>);
    expect(tables.tree.getState().globalFilterFn).toBe('treeText');
    expect(tables.plain.getState().globalFilterFn).not.toBe('treeText');
    expect(tables.plain.options.initialState?.globalFilterFn).not.toBe('treeText');
    expect(tables.plain.options.initialState).not.toBe(tables.tree.options.initialState);
  });

  it('T-3: DEFAULT_TABLE_OPTIONS is unchanged after rendering tables, and frozen (deeply)', async () => {
    m = await mount(<Table ids={['a', 'b']} />);
    unmount(m);
    m = await mount(<Table ids={['z', 'y']} options={{ initialState: { sorting: [{ id: 'z', desc: true }] } }} />);
    expect(JSON.stringify(DEFAULT_TABLE_OPTIONS)).toBe(SNAPSHOT);
    expect(DEFAULT_TABLE_OPTIONS.initialState).toEqual({ showGlobalFilter: true });
    expect(Object.isFrozen(DEFAULT_TABLE_OPTIONS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TABLE_OPTIONS.initialState)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TABLE_OPTIONS.mantineTableProps)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TABLE_OPTIONS.displayColumnDefOptions['mrt-row-actions'])).toBe(true);
    expect(() => { (DEFAULT_TABLE_OPTIONS.initialState as Record<string, unknown>).columnOrder = ['oops']; }).toThrow(TypeError);
  });

  it('T-4: a table with its own initialState still gets the defaults merged in (the search box shows)', async () => {
    m = await mount(<Table ids={['a', 'b']} options={{ initialState: { sorting: [{ id: 'a', desc: false }] } }} />);
    expect(last!.getState().showGlobalFilter).toBe(true);
    expect(last!.getState().sorting).toEqual([{ id: 'a', desc: false }]);
    expect(m.container.querySelector('input[aria-label="Search this table"]')).not.toBeNull();
  });
});
