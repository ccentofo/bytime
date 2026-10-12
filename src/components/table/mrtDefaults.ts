import type { MRT_RowData, MRT_TableOptions } from 'mantine-react-table';
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

const DEFAULT_TABLE_OPTIONS = {
  layoutMode: 'semantic',
  enableColumnActions: false,
  enableDensityToggle: false,
  enableFullScreenToggle: false,
  positionActionsColumn: 'last',
  mantinePaperProps: { withBorder: true, radius: 'md', shadow: 'none', style: { width: '100%' } },
  mantineTableContainerProps: { style: { maxWidth: '100%', overflowX: 'auto' } },
  mantineTableProps: { highlightOnHover: true, striped: 'odd', withColumnBorders: false },
  displayColumnDefOptions: { 'mrt-row-actions': { header: '', size: 80 } },
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
