import { VisuallyHidden } from '@mantine/core';
import type { MRT_Column, MRT_RowData, MRT_TableOptions } from 'mantine-react-table';
import { useMantineReactTable } from 'mantine-react-table';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value !== 'function';
}

/**
 * Recursively merges `override` onto `base`. Plain objects are merged key-by-key
 * (so a table customizing e.g. `mantineTableProps.style` doesn't lose sibling
 * defaults like `highlightOnHover`); arrays, functions, and primitives in `override`
 * replace `base` outright, since those can't be meaningfully merged.
 */
function deepMerge<T>(base: T, override: T): T {
  if (isPlainObject(base) && isPlainObject(override)) {
    const merged: Record<string, unknown> = { ...base };
    for (const key of Object.keys(override)) {
      merged[key] = deepMerge((base as Record<string, unknown>)[key], override[key]);
    }
    return merged as T;
  }
  return override !== undefined ? override : base;
}

/** `aria-sort` on sortable headers (UX-AUDIT A11). Trap T-A: a table passing its own table-level
 *  mantineTableHeadCellProps replaces this function (deepMerge) — compose instead. */
function sortHeaderProps({ column }: { column: MRT_Column<MRT_RowData> }) {
  if (!column.getCanSort()) return {};
  const sorted = column.getIsSorted();
  return { 'aria-sort': sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none' } as const;
}

const DEFAULT_TABLE_OPTIONS = {
  layoutMode: 'semantic',
  enableColumnActions: false,
  enableDensityToggle: false,
  enableFullScreenToggle: false,
  // Toolbar (feature-plan-ux-foundations.md §4.4): a visible search box at the top left, no toggle icons, no column
  // filters unless a table opts back in (enableColumnFilters + initialState.showColumnFilters).
  enableToolbarInternalActions: false,
  enableColumnFilters: false,
  positionGlobalFilter: 'left',
  initialState: { showGlobalFilter: true },
  // MRT hard-codes variant "filled" (no visible border) — `default` gives the input a visible edge.
  mantineSearchTextInputProps: { placeholder: 'Search', 'aria-label': 'Search this table', variant: 'default' },
  positionActionsColumn: 'last',
  mantinePaperProps: { withBorder: true, radius: 'md', shadow: 'none', style: { width: '100%' } },
  mantineTableContainerProps: { style: { maxWidth: '100%', overflowX: 'auto' } },
  mantineTableProps: { highlightOnHover: true, striped: 'odd', withColumnBorders: false },
  mantineTableHeadCellProps: sortHeaderProps,
  // Row actions (RowActions): right-aligned, wide enough for a primary button + the menu trigger, and a header with an
  // accessible name ("Actions", visually hidden).
  displayColumnDefOptions: {
    'mrt-row-actions': {
      size: 132,
      header: 'Actions',
      Header: () => <VisuallyHidden>Actions</VisuallyHidden>,
      mantineTableHeadCellProps: { style: { textAlign: 'right' } },
      mantineTableBodyCellProps: { style: { textAlign: 'right' } },
    },
  },
  localization: { noRecordsToDisplay: 'Nothing here yet.' },
} as const;

/**
 * Shared CadenzPoint table defaults — one sort/toolbar/spacing system for every
 * MRT table in the app. Per-table options win on conflicting keys; nested `*Props`
 * objects are merged, not replaced, so a table's own customizations survive.
 */
export function useAppTable<T extends MRT_RowData>(options: MRT_TableOptions<T>) {
  const merged = deepMerge(
    DEFAULT_TABLE_OPTIONS as unknown as MRT_TableOptions<T>,
    options
  );
  return useMantineReactTable<T>(merged);
}
