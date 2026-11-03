import { useMemo, useState, type ReactNode } from 'react';
import { Stack, Text, VisuallyHidden } from '@mantine/core';
import type {
  MRT_Cell, MRT_Column, MRT_ColumnDef, MRT_ExpandedState, MRT_FilterFn, MRT_Row, MRT_RowData, MRT_TableInstance, MRT_TableOptions,
} from 'mantine-react-table';
import { useMantineReactTable } from 'mantine-react-table';
import { Icons } from '@/components/ui/icons';
import styles from './AppTable.module.css';

/** The kit's table classes; `.num` right-aligns a cell in a plain (non-MRT) table. */
export const tableClasses = styles;

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

// ── numericColumn (feature-plan-ux-kit-contracts.md §3.4.1) ──────────────────────────────────────────────────────

type PropsOrFn<A, P> = P | ((args: A) => P) | undefined;

/** Compose a caller's cell props (object or function) with `align: 'right'` — the caller's props still apply. */
function alignRight<A, P extends object>(caller: PropsOrFn<A, P>): (args: A) => P & { align: 'right' } {
  return (args: A) => {
    const own = (typeof caller === 'function' ? (caller as (a: A) => P)(args) : caller) ?? ({} as P);
    return { ...own, align: 'right' as const };
  };
}

/**
 * A right-aligned numeric column: header, body and footer cells get `align: 'right'` (MRT aligns header content with
 * it too), composed with any props the column passes; `format` renders the value. No footer totals (C2).
 */
export function numericColumn<T extends MRT_RowData>(
  def: MRT_ColumnDef<T> & { format?: (value: unknown, row: T) => ReactNode },
): MRT_ColumnDef<T> {
  const { format, ...rest } = def;
  return {
    ...rest,
    mantineTableHeadCellProps: alignRight(rest.mantineTableHeadCellProps) as MRT_ColumnDef<T>['mantineTableHeadCellProps'],
    mantineTableBodyCellProps: alignRight(rest.mantineTableBodyCellProps) as MRT_ColumnDef<T>['mantineTableBodyCellProps'],
    mantineTableFooterCellProps: alignRight(rest.mantineTableFooterCellProps) as MRT_ColumnDef<T>['mantineTableFooterCellProps'],
    ...(format && !rest.Cell ? { Cell: ({ cell, row }: { cell: MRT_Cell<T>; row: MRT_Row<T> }) => format(cell.getValue(), row.original) } : {}),
  };
}

// ── Kit options (feature-plan-ux-kit-contracts.md §3.4.2–3). Every one is opt-in: undefined = today's table. ────────

export interface AppTableExpandable<T extends MRT_RowData> {
  getSubRows: (row: T) => T[] | undefined;
  /** The toggle's name: "Show {label}" / "Hide {label}". */
  label: (row: T) => string;
  /** What search matches for this row (its ancestors' text counts too). */
  searchText: (row: T) => string;
  /** A stable id across refreshes, e.g. `${level}:${id}` (MRT keeps `expanded` keyed by row id). */
  rowId: (row: T) => string;
  /** The expanded state before any toggle (`true` = everything open). */
  defaultExpanded?: MRT_ExpandedState;
}

export interface AppTableKitOptions<T extends MRT_RowData> {
  /** Shown only when there are no rows at all; an empty search says "No results for “{q}”." instead. */
  emptyState?: { title: string; body?: ReactNode; action?: ReactNode };
  /** No pagination and no bottom toolbar. */
  compact?: boolean;
  /** No striping. */
  hairline?: boolean;
  expandable?: AppTableExpandable<T>;
}

/**
 * The tree search (registered in filterFns as 'treeText'): a row matches when its searchable value — or any ancestor's —
 * contains the query, case-insensitively. So a contract-name match keeps all its descendants, and a SLIN match keeps its
 * ancestors (filterFromLeafRows). Module-level and pure: it reads only the rows' own column values.
 */
const treeText: MRT_FilterFn<MRT_RowData> = (row, columnId, filterValue) => {
  const q = String(filterValue ?? '').trim().toLowerCase();
  if (!q) return true;
  return [row, ...row.getParentRows()].some((r) => String(r.getValue(columnId) ?? '').toLowerCase().includes(q));
};

const resolve = <S,>(updater: S | ((prev: S) => S), prev: S): S =>
  (typeof updater === 'function' ? (updater as (p: S) => S)(prev) : updater);

/** Our expand control: a real button with aria-expanded and a name; rows with no children get a spacer. */
function TreeCell<T extends MRT_RowData>({ row, label, children }: { row: MRT_Row<T>; label: string; children: ReactNode }) {
  const expanded = row.getIsExpanded();
  return (
    <span className={styles.treeCell} style={{ ['--tree-depth' as string]: row.depth }}>
      {row.getCanExpand() ? (
        <button
          type="button"
          className={styles.expand}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Hide' : 'Show'} ${label}`}
          onClick={(e) => { e.stopPropagation(); row.toggleExpanded(); }}
        >
          <Icons.expand size={16} className={styles.chevron} aria-hidden="true" />
        </button>
      ) : <span className={styles.spacer} aria-hidden="true" />}
      {children}
    </span>
  );
}

/**
 * Shared CadenzPoint table defaults — one sort/toolbar/spacing system for every
 * MRT table in the app. Per-table options win on conflicting keys; nested `*Props`
 * objects are merged, not replaced, so a table's own customizations survive.
 */
export function useAppTable<T extends MRT_RowData>(options: MRT_TableOptions<T> & AppTableKitOptions<T>) {
  const { emptyState, compact, hairline, expandable, ...mrt } = options;

  // The expandable table owns its search and expanded state (§3.4.3): while searching, everything starts expanded
  // (searchExpanded); clearing the search restores the user's own `expanded`.
  const [globalFilter, setGlobalFilter] = useState('');
  const [expanded, setExpanded] = useState<MRT_ExpandedState>(expandable?.defaultExpanded ?? {});
  const [searchExpanded, setSearchExpanded] = useState<MRT_ExpandedState>(true);

  const firstColumn = mrt.columns[0];
  const firstId = firstColumn ? String(firstColumn.id ?? firstColumn.accessorKey ?? 'tree') : 'tree';
  const columns = useMemo<MRT_ColumnDef<T>[]>(() => {
    if (!expandable || !firstColumn) return mrt.columns;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { accessorKey: _key, Cell: ownCell, ...first } = firstColumn;
    const decorated: MRT_ColumnDef<T> = {
      ...first,
      id: firstId,
      // The one globally searchable value: this row's search text (treeText adds its ancestors').
      accessorFn: (row: T) => expandable.searchText(row),
      Cell: (props) => (
        <TreeCell row={props.row} label={expandable.label(props.row.original)}>
          {ownCell ? ownCell(props) : expandable.label(props.row.original)}
        </TreeCell>
      ),
    };
    return [decorated, ...mrt.columns.slice(1)];
  }, [mrt.columns, expandable, firstColumn, firstId]);

  const kit: Partial<MRT_TableOptions<T>> = {};
  if (compact) Object.assign(kit, { enablePagination: false, enableBottomToolbar: false });
  if (hairline) Object.assign(kit, { mantineTableProps: { striped: false } });
  if (emptyState) {
    kit.renderEmptyRowsFallback = ({ table }: { table: MRT_TableInstance<T> }) => (mrt.data.length === 0 ? (
      <Stack align="center" gap={6} py="xl" data-testid="table-empty-state">
        <Text fw={600}>{emptyState.title}</Text>
        {emptyState.body && <Text size="sm" c="dimmed" ta="center">{emptyState.body}</Text>}
        {emptyState.action}
      </Stack>
    ) : (
      <Text c="dimmed" ta="center" py="xl" data-testid="table-no-results">No results for “{String(table.getState().globalFilter ?? '')}”.</Text>
    ));
  }

  const merged = deepMerge(deepMerge(DEFAULT_TABLE_OPTIONS as unknown as MRT_TableOptions<T>, kit as MRT_TableOptions<T>), { ...mrt, columns });

  if (expandable) {
    const callerState = mrt.state ?? {};
    Object.assign(merged, {
      getSubRows: expandable.getSubRows,
      getRowId: (row: T) => expandable.rowId(row),
      enableExpanding: true,
      enableExpandAll: false,
      // A paginated tree pages its top-level rows and expands within the page. Without pagination (compact) TanStack only
      // expands rows in its expanded row model when this is true, so it stays true there (else nothing ever expands).
      paginateExpandedRows: !(compact || mrt.enablePagination === false) ? false : true,
      filterFromLeafRows: true,
      filterFns: { ...(mrt.filterFns ?? {}), treeText },
      globalFilterFn: 'treeText',
      getColumnCanGlobalFilter: (column: { id: string }) => column.id === firstId,
      onGlobalFilterChange: (updater: string | undefined | ((prev: string) => string | undefined)) => {
        const next = (typeof updater === 'function' ? updater(globalFilter) : updater) ?? '';
        if (!globalFilter && next) setSearchExpanded(true);
        setGlobalFilter(next);
      },
      onExpandedChange: (updater: MRT_ExpandedState | ((prev: MRT_ExpandedState) => MRT_ExpandedState)) => {
        if (globalFilter) setSearchExpanded((prev) => resolve(updater, prev));
        else setExpanded((prev) => resolve(updater, prev));
      },
      // Never an undefined key here: useReactTable spreads `state` over its own (an undefined would override it).
      state: {
        ...callerState,
        globalFilter,
        expanded: globalFilter ? searchExpanded : expanded,
        // MRT always renders its own expand column with enableExpanding; ours lives in the first data column.
        columnVisibility: { ...(callerState.columnVisibility ?? {}), 'mrt-row-expand': false },
      },
    });
  }

  return useMantineReactTable<T>(merged);
}
