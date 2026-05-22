'use client';

import { useMemo } from 'react';
import { Text } from '@mantine/core';
import { MantineReactTable, useMantineReactTable, type MRT_ColumnDef } from 'mantine-react-table';
import dayjs from 'dayjs';
import { useTimesheet } from '@/components/timesheet/TimesheetContext';
import { ChargeCodeCell } from '@/components/timesheet/cells/ChargeCodeCell';
import { HourCell } from '@/components/timesheet/cells/HourCell';
import { TotalHoursCell } from '@/components/timesheet/cells/TotalHoursCell';
import { ColumnHeaderDate } from '@/components/timesheet/cells/ColumnHeaderDate';
import type { TimesheetEntry } from '@/types/timesheet';

// Weekend day indices (Monday start): 5=Sat, 6=Sun, 12=Sat, 13=Sun
const WEEKEND_INDICES = new Set([5, 6, 12, 13]);

// Row shape passed to MRT — merges ChargeCode + TimesheetEntry
interface TableRow extends TimesheetEntry {
  chargeCodeId: string;
}

export function BiWeeklyTable() {
  const { state } = useTimesheet();
  const { chargeCodes, entries, periodStart } = state;

  // Merge charge codes + entries into flat row objects
  const tableData: TableRow[] = useMemo(
    () =>
      chargeCodes.map((cc) => {
        const entry = entries.find((e) => e.chargeCodeId === cc.id);
        return {
          chargeCodeId: cc.id,
          hours: entry ? entry.hours : Array(14).fill(0),
        };
      }),
    [chargeCodes, entries]
  );

  const columns = useMemo<MRT_ColumnDef<TableRow>[]>(() => {
    // Column 0 — Charge Code (pinned left)
    const chargeCodeCol: MRT_ColumnDef<TableRow> = {
      accessorKey: 'chargeCodeId',
      header: 'Charge Code',
      size: 260,
      enableSorting: false,
      Cell: ({ row }) => {
        const cc = chargeCodes.find((c) => c.id === row.original.chargeCodeId);
        if (!cc) return null;
        return <ChargeCodeCell chargeCode={cc} />;
      },
      Footer: () => (
        <Text fw={700} size="sm">
          Daily Totals
        </Text>
      ),
      mantineTableBodyCellProps: {
        style: {
          backgroundColor: 'var(--mantine-color-body)',
          borderRight: '2px solid var(--mantine-color-default-border)',
          verticalAlign: 'top',
          padding: '8px',
        },
      },
      mantineTableFooterCellProps: {
        style: {
          backgroundColor: 'var(--mantine-color-body)',
          borderRight: '2px solid var(--mantine-color-default-border)',
          borderTop: '2px solid var(--mantine-color-default-border)',
          padding: '8px',
        },
      },
    };

    // Columns 1–14 — Day columns
    const dayColumns: MRT_ColumnDef<TableRow>[] = Array.from({ length: 14 }, (_, dayIndex) => {
      const date = dayjs(periodStart).add(dayIndex, 'day').toDate();
      const isWeekend = WEEKEND_INDICES.has(dayIndex);

      return {
        id: `day-${dayIndex}`,
        accessorFn: (row: TableRow) => row.hours[dayIndex],
        header: `Day ${dayIndex}`,
        size: 72,
        enableSorting: false,
        Header: () => <ColumnHeaderDate date={date} dayIndex={dayIndex} />,
        Cell: ({ row }: { row: { original: TableRow } }) => (
          <HourCell chargeCodeId={row.original.chargeCodeId} dayIndex={dayIndex} />
        ),
        Footer: () => {
          const dayTotal = entries.reduce((sum, entry) => sum + entry.hours[dayIndex], 0);
          return (
            <Text fw={700} ta="center" size="sm">
              {dayTotal.toFixed(2)}
            </Text>
          );
        },
        mantineTableBodyCellProps: {
          style: {
            backgroundColor: isWeekend
              ? 'light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-7))'
              : undefined,
            padding: '6px 4px',
            verticalAlign: 'middle' as const,
          },
        },
        mantineTableHeadCellProps: {
          style: {
            backgroundColor: isWeekend
              ? 'light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-7))'
              : undefined,
          },
        },
        mantineTableFooterCellProps: {
          style: {
            backgroundColor: isWeekend
              ? 'light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-7))'
              : undefined,
            borderTop: '2px solid var(--mantine-color-default-border)',
            padding: '6px 4px',
            textAlign: 'center' as const,
          },
        },
      } as MRT_ColumnDef<TableRow>;
    });

    // Column 15 — Total (pinned right)
    const totalCol: MRT_ColumnDef<TableRow> = {
      id: 'total',
      accessorFn: (row) => row.hours.reduce((a, b) => a + b, 0),
      header: 'Total',
      size: 80,
      enableSorting: false,
      Cell: ({ row }) => <TotalHoursCell chargeCodeId={row.original.chargeCodeId} />,
      Footer: () => {
        const grandTotal = entries.reduce(
          (sum, entry) => sum + entry.hours.reduce((a, b) => a + b, 0),
          0
        );
        return (
          <Text fw={900} ta="center" size="sm" c="blue">
            {grandTotal.toFixed(2)}
          </Text>
        );
      },
      mantineTableBodyCellProps: {
        style: {
          borderLeft: '2px solid var(--mantine-color-default-border)',
          padding: '6px 4px',
          verticalAlign: 'middle' as const,
        },
      },
      mantineTableFooterCellProps: {
        style: {
          borderLeft: '2px solid var(--mantine-color-default-border)',
          borderTop: '2px solid var(--mantine-color-default-border)',
          padding: '6px 4px',
        },
      },
    };

    return [chargeCodeCol, ...dayColumns, totalCol];
  }, [chargeCodes, periodStart, entries]);

  const table = useMantineReactTable({
    columns,
    data: tableData,
    enableColumnActions: false,
    enableColumnFilters: false,
    enablePagination: false,
    enableSorting: false,
    enableTopToolbar: false,
    enableBottomToolbar: false,
    enableRowSelection: false,
    enableDensityToggle: false,
    enableFullScreenToggle: false,
    enableHiding: false,
    enableGlobalFilter: false,
    enableTableFooter: true,
    mantineTableProps: {
      withColumnBorders: false,
      highlightOnHover: false,
      striped: 'odd',
      style: { tableLayout: 'fixed' },
    },
    mantineTableHeadCellProps: {
      style: {
        borderBottom: '2px solid var(--mantine-color-default-border)',
        textAlign: 'center' as const,
        padding: '8px 4px',
      },
    },
    mantineTableBodyCellProps: {
      style: {
        borderBottom: '1px solid var(--mantine-color-default-border)',
        padding: '6px 4px',
        verticalAlign: 'middle' as const,
      },
    },
    initialState: {
      columnPinning: { left: ['chargeCodeId'], right: ['total'] },
    },
  });

  return <MantineReactTable table={table} />;
}
