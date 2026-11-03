// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { act, useState } from 'react';
import { MantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';

/**
 * feature-plan-ux-kit-contracts.md §3.4 / K-3, K-4 (second half), K-5: numericColumn alignment and prop composition;
 * the opt-in emptyState / compact options; expandable rows (our own control, MRT's hidden; tree search; state ownership;
 * stable ids across a refresh).
 */

import { useAppTable, numericColumn, type AppTableExpandable } from '@/components/table/mrtDefaults';
import { installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';

beforeAll(installDomStubs);
let m: Mounted | undefined;
afterEach(() => { unmount(m); m = undefined; });

const typeSearch = async (q: string) => {
  const input = m!.container.querySelector('input[aria-label="Search this table"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, q);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(400);                                                  // MRT debounces the global filter
};
const rowTexts = () => [...m!.container.querySelectorAll('tbody tr')].map((r) => r.textContent ?? '');

// ── K-3 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
type Flat = { id: string; name: string; hours: number };
describe('numericColumn (K-3)', () => {
  it('align: right on head, body and footer, composed with a caller\'s function and object props (both apply)', () => {
    const def = numericColumn<Flat>({
      accessorKey: 'hours', header: 'Hours',
      mantineTableBodyCellProps: ({ row }) => ({ 'data-row': row.id } as never),
      mantineTableHeadCellProps: { className: 'mine' },
    });
    const body = (def.mantineTableBodyCellProps as (a: unknown) => Record<string, unknown>)({ row: { id: 'r1' } });
    expect(body).toEqual({ 'data-row': 'r1', align: 'right' });
    expect((def.mantineTableHeadCellProps as (a: unknown) => Record<string, unknown>)({})).toEqual({ className: 'mine', align: 'right' });
    expect((def.mantineTableFooterCellProps as (a: unknown) => Record<string, unknown>)({})).toEqual({ align: 'right' });
  });

  it('renders right-aligned header and body cells through `format`', async () => {
    function T() {
      const table = useAppTable<Flat>({
        columns: [{ accessorKey: 'name', header: 'Name' }, numericColumn<Flat>({ accessorKey: 'hours', header: 'Hours', format: (v) => `${Number(v).toFixed(2)} h`, mantineTableBodyCellProps: { 'data-num': 'yes' } as never })],
        data: [{ id: '1', name: 'A', hours: 3 }],
      });
      return <MantineReactTable table={table} />;
    }
    m = await mount(<T />);
    const th = [...m.container.querySelectorAll('thead th')].find((x) => x.textContent?.includes('Hours')) as HTMLElement;
    const td = m.container.querySelector('td[data-num="yes"]') as HTMLElement;
    // MRT always writes align="left" on the <th>; the column's alignment right-justifies the header content instead.
    expect(th.querySelector('[class*="content-right"]')).not.toBeNull();
    expect(td.getAttribute('style')).toContain('--mrt-cell-align: right');
    expect(td.textContent).toBe('3.00 h');
  });
});

// ── K-4 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('useAppTable opt-in options (K-4)', () => {
  function T({ data, compact }: { data: Flat[]; compact?: boolean }) {
    const table = useAppTable<Flat>({
      columns: [{ accessorKey: 'name', header: 'Name' }], data, compact,
      emptyState: { title: 'No contracts yet', body: 'Add your first contract.' },
    });
    return <MantineReactTable table={table} />;
  }

  it('emptyState only when there are no rows; an empty search says "No results for “q”."', async () => {
    m = await mount(<T data={[]} />);
    expect(m.container.querySelector('[data-testid="table-empty-state"]')!.textContent).toContain('No contracts yet');
    unmount(m);
    m = await mount(<T data={[{ id: '1', name: 'Alpha', hours: 1 }]} />);
    expect(m.container.querySelector('[data-testid="table-empty-state"]')).toBeNull();
    await typeSearch('zzz');
    expect(m.container.querySelector('[data-testid="table-no-results"]')!.textContent).toBe('No results for “zzz”.');
    expect(m.container.querySelector('[data-testid="table-empty-state"]')).toBeNull();
  });

  it('compact hides the pagination and bottom toolbar; without it they render', async () => {
    m = await mount(<T data={[{ id: '1', name: 'Alpha', hours: 1 }]} />);
    expect(m.container.querySelector('.mantine-Pagination-root, .mrt-table-pagination, [class*="bottom-toolbar"]')).not.toBeNull();
    unmount(m);
    m = await mount(<T data={[{ id: '1', name: 'Alpha', hours: 1 }]} compact />);
    expect(m.container.querySelector('.mantine-Pagination-root, .mrt-table-pagination, [class*="bottom-toolbar"]')).toBeNull();
  });
});

// ── K-5 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
type Node = { id: string; level: 'contract' | 'clin' | 'slin'; name: string; children?: Node[] };
const TREE: Node[] = [
  { id: 'army', level: 'contract', name: 'Army IT Support', children: [
    { id: 'a1', level: 'clin', name: 'CLIN 0001 Help desk' }, { id: 'a2', level: 'clin', name: 'CLIN 0002 Network operations' }] },
  { id: 'disa', level: 'contract', name: 'DISA Cyber Operations', children: [
    { id: 'd1', level: 'clin', name: 'CLIN 0001 Cyber operations' },
    { id: 'd2', level: 'clin', name: 'CLIN 0002 Cloud infrastructure', children: [
      { id: 's1', level: 'slin', name: 'SLIN 0002AA Migration support' }, { id: 's2', level: 'slin', name: 'SLIN 0002AB Backup' }] }] },
  { id: 'navair', level: 'contract', name: 'NAVAIR Systems Support', children: [{ id: 'n1', level: 'clin', name: 'CLIN 0001 Base year' }] },
];
const EXPANDABLE: AppTableExpandable<Node> = {
  getSubRows: (r) => r.children,
  label: (r) => (r.level === 'contract' ? `CLINs for ${r.name}` : `SLINs for ${r.name}`),
  searchText: (r) => r.name,
  rowId: (r) => `${r.level}:${r.id}`,
};
const COLS: MRT_ColumnDef<Node>[] = [{ accessorKey: 'name', header: 'Contract', Cell: ({ row }) => <b>{row.original.name}</b> }];

function Tree({ initial = TREE }: { initial?: Node[] }) {
  const [data, setData] = useState(initial);
  const table = useAppTable<Node>({ columns: COLS, data, expandable: EXPANDABLE, compact: true });
  return (
    <>
      <button type="button" onClick={() => setData([{ id: 'new', level: 'contract', name: 'Brand New', children: [{ id: 'x1', level: 'clin', name: 'CLIN 0009 New' }] }, ...data])}>refresh-insert</button>
      <MantineReactTable table={table} />
    </>
  );
}
const toggle = (label: string) => m!.container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
const click = async (el: HTMLElement) => { await act(async () => { el.click(); }); };
const has = (name: string) => rowTexts().some((t) => t.includes(name));

describe('expandable rows (K-5)', () => {
  it('no MRT expand button; our own button with aria-expanded and "Show/Hide {label}"; leaves get none', async () => {
    m = await mount(<Tree />);
    expect(m.container.querySelector('.mrt-expand-button')).toBeNull();
    const army = toggle('Show CLINs for Army IT Support');
    expect(army.getAttribute('aria-expanded')).toBe('false');
    expect(army.getAttribute('type')).toBe('button');
    expect(has('Help desk')).toBe(false);
    await click(army);
    expect(toggle('Hide CLINs for Army IT Support').getAttribute('aria-expanded')).toBe('true');
    expect(has('Help desk')).toBe(true);
    const leaf = [...m.container.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes('Help desk'))!;
    expect(leaf.querySelector('button')).toBeNull();
  });

  it('search: a contract name shows ALL its CLINs, and other contracts are absent', async () => {
    m = await mount(<Tree />);
    await typeSearch('army');
    expect(has('Help desk')).toBe(true);
    expect(has('Network operations')).toBe(true);
    expect(has('DISA')).toBe(false);
    expect(has('NAVAIR')).toBe(false);
  });

  it('search: a SLIN number shows that SLIN under its expanded parents; its non-matching sibling is absent', async () => {
    m = await mount(<Tree />);
    await typeSearch('0002AA');
    expect(has('Migration support')).toBe(true);
    expect(has('DISA Cyber Operations')).toBe(true);
    expect(has('Cloud infrastructure')).toBe(true);
    expect(has('Backup')).toBe(false);
    expect(has('Cyber operations') && rowTexts().some((t) => t.includes('CLIN 0001 Cyber'))).toBe(false);
    expect(has('Army')).toBe(false);
  });

  it('Hide works while searching; clearing the search restores the previous expanded state', async () => {
    m = await mount(<Tree />);
    await click(toggle('Show CLINs for Army IT Support'));        // the user's own state: Army open
    await typeSearch('o');                                          // matches every contract → all expanded
    expect(has('Base year')).toBe(true);
    await click(toggle('Hide CLINs for NAVAIR Systems Support'));
    expect(has('Base year')).toBe(false);
    await typeSearch('');
    expect(has('Help desk')).toBe(true);                            // Army still open
    expect(has('Base year')).toBe(false);                           // NAVAIR as before the search (closed)
    expect(has('Cyber operations')).toBe(false);
  });

  it('a refresh that inserts a row keeps the same rows expanded (stable ids)', async () => {
    m = await mount(<Tree />);
    await click(toggle('Show CLINs for DISA Cyber Operations'));
    await click([...m.container.querySelectorAll('button')].find((b) => b.textContent === 'refresh-insert') as HTMLElement);
    expect(has('Brand New')).toBe(true);
    expect(has('CLIN 0009 New')).toBe(false);                       // the inserted row isn't expanded
    expect(has('Cloud infrastructure')).toBe(true);                 // DISA still is
    expect(has('Help desk')).toBe(false);
  });
});
