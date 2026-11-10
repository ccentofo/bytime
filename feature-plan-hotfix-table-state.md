# Hotfix: table settings leak between pages (column order)

> **Status:** FINAL, 2026-11-12, lead architect. This is a small mechanical fix with the cause verified in the library source, so no pre-mortem round.
>
> **Branch:** `fix-table-state`, from `main` **after `approval-scope` merges**.
>
> **Reported by the product owner:** after moving between pages (for example Charge codes → Labor categories), a table shows another table's column order. A hard reload fixes it. It reproduces on a production build, not only on `npm run dev`.

## 1. Cause (verified)
1. `useAppTable` builds its options with `deepMerge(DEFAULT_TABLE_OPTIONS, …)` (`src/components/table/mrtDefaults.tsx:23-32, 208`).
2. When a table passes **no** `initialState`, `deepMerge(base.initialState, undefined)` returns `base.initialState`: the **shared module-level object** `DEFAULT_TABLE_OPTIONS.initialState` (:31, :52), not a copy.
3. mantine-react-table **mutates** the `initialState` object it receives. In `node_modules/mantine-react-table/dist/index.esm.mjs:3019-3027`, `initState.columnOrder = … getDefaultColumnOrderIds(...)` and `initState.globalFilterFn = …`.
4. So the first such table writes its column order (and its `globalFilterFn`, e.g. `'treeText'`) into the shared defaults. Every later table in the same page session inherits them, until a full reload re-evaluates the module.
   - TanStack puts the known ids first in that stale order, so Labor categories rendered Code, Category, People, Status, Hourly, Ceiling (Charge codes' order filtered to the shared ids).
   - The leaked `globalFilterFn` can also make a non-tree table's search use `treeText`.
5. Approvals worked around this by passing `state.columnOrder` (`ApprovalsClient.tsx:386`).

## 2. Fix
1. **`deepMerge` never returns a shared nested object.** When `override` is undefined and `base` is a plain object, return a recursive copy. Simplest: start `merged` as a deep copy of `base`. Functions and non-plain values are copied by reference, as today.
2. **Defense in depth:** `useAppTable` passes MRT a **fresh** `initialState` per call: `{ ...merged.initialState }` after the merge.
3. **Freeze `DEFAULT_TABLE_OPTIONS`** with a recursive `Object.freeze` (plain objects only), so any future in-place write throws in tests instead of leaking silently.
4. **Leave Approvals' explicit `columnOrder` in place** (harmless). Update its comment to point at this hotfix.

## 3. Tests (each must fail without the fix)
| # | Scenario |
|---|---|
| T-1 | Render table A (columns a, b, c; no `initialState`) and unmount it. Then render table B (columns c, b, x; no `initialState`). B's header order is c, b, x. |
| T-2 | After rendering an expandable table, a plain table's `getState().globalFilterFn` isn't `'treeText'`. |
| T-3 | `DEFAULT_TABLE_OPTIONS` (exported for the test, or checked through a getter) is unchanged after rendering two tables: deep-equal to a snapshot taken at import, and frozen. |
| T-4 | A table that passes its own `initialState` still gets the defaults (`showGlobalFilter: true`) merged in. |

## 4. Verification
- **Dev:** `npx tsc --noEmit`, `npm run lint`, `npm run test`, `npm run test:tz`.
- **Product owner:**
  - `npm run build`, then `AUTH_TRUST_HOST=true npm run start`;
  - visit Charge codes → Labor categories → Assignments → Users → Contracts **without** hard reloads;
  - every table keeps its own column order (Labor categories: Category, Code, Hourly rate, Ceiling rate, People, Status).

## 5. Hand-off
`BLUEPRINT-STANDARD.md` §3. One commit for the fix and tests. Revert-check each test. Don't push.
