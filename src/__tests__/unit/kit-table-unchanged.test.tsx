// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { MantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';

/**
 * feature-plan-ux-kit-contracts.md §3.4 / K-4 (first half): with no kit options, useAppTable renders exactly what it did
 * before the kit (the snapshot was recorded from the pre-kit mrtDefaults). Mantine's generated ids are normalised.
 */

import { useAppTable } from '@/components/table/mrtDefaults';
import { installDomStubs, mount, unmount, type Mounted } from '../helpers/dom';

beforeAll(installDomStubs);
let m: Mounted | undefined;
afterEach(() => { unmount(m); m = undefined; });

type Row = { id: string; name: string; status: string; hours: number };
const DATA: Row[] = [{ id: '1', name: 'Alpha', status: 'active', hours: 12.5 }, { id: '2', name: 'Bravo', status: 'inactive', hours: 3 }];
const COLUMNS: MRT_ColumnDef<Row>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'hours', header: 'Hours' },
];

function Table({ data }: { data: Row[] }) {
  const table = useAppTable<Row>({ columns: COLUMNS, data, enableRowActions: true, renderRowActions: () => <button type="button">Edit</button> });
  return <MantineReactTable table={table} />;
}

const normalise = (html: string) => html.replace(/mantine-[a-z0-9]+/gi, 'mantine-ID').replace(/«[^»]+»|:r[0-9a-z]+:/g, 'ID');

describe('useAppTable with no kit options (K-4)', () => {
  it('renders the same markup as before the kit (with rows)', async () => {
    m = await mount(<Table data={DATA} />);
    expect(normalise(m.container.innerHTML)).toMatchSnapshot();
  });

  it('renders the same markup as before the kit (empty)', async () => {
    m = await mount(<Table data={[]} />);
    expect(normalise(m.container.innerHTML)).toMatchSnapshot();
  });
});
