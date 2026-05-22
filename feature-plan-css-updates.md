# Blueprint: CSS/UI Polish — Table Styling, Color Scheme Flash Fix

> **This ticket contains THREE phases. Complete each phase fully before starting the next.**

---

## Problem Statement

The application is functionally complete but has several UI/CSS issues that degrade the user experience:

1. **Color Scheme Flash (FOUC):** Every route navigation causes a visible flash where the page briefly renders in the wrong color scheme (light → dark or vice versa) before correcting itself. This happens because `MantineProvider` uses `defaultColorScheme="auto"` but there is no `ColorSchemeScript` injected into `<head>` to read `localStorage` before the first paint.

2. **Oversized Sort/Column-Action Icons in MRT Tables:** The Mantine React Table column headers in admin pages (User Management, Contracts & CLINs, User Assignments, Timesheet Approvals) display large sort arrows (↕) and three-dot menu icons that crowd the header text and look disproportionate.

3. **Insufficient Cell Padding:** Table cells across all admin MRT tables have minimal padding, causing content (badges, switches, text, action icons) to appear cramped and crowded against cell borders.

4. **Action Column Inconsistencies:** The Actions column in some tables lacks proper alignment and spacing between action icons.

---

## File Topology

```
Files to MODIFY:
├── src/app/layout.tsx                                    ← Add ColorSchemeScript to <head>
├── src/app/globals.css                                   ← Add global MRT CSS overrides
├── src/app/(app)/admin/contracts/ContractsClient.tsx      ← Add table padding props
├── src/app/(app)/admin/users/UsersClient.tsx              ← Add table padding props
├── src/app/(app)/admin/assignments/AssignmentsClient.tsx  ← Add table padding props
├── src/app/(app)/admin/approvals/ApprovalsClient.tsx      ← Add table padding props

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/db/schema.ts                                      ← ❌ DO NOT MODIFY
├── src/auth.ts                                           ← ❌ DO NOT MODIFY
├── src/middleware.ts                                     ← ❌ DO NOT MODIFY
├── src/components/timesheet/*                            ← ❌ DO NOT MODIFY (already styled correctly)
├── src/components/shell/*                                ← ❌ DO NOT MODIFY
├── src/server/actions/*                                  ← ❌ DO NOT MODIFY
├── src/types/*                                           ← ❌ DO NOT MODIFY
├── src/lib/*                                             ← ❌ DO NOT MODIFY
├── src/app/(app)/timesheet/*                             ← ❌ DO NOT MODIFY
```

---

## Phase A: Fix Color Scheme Flash (FOUC)

### Problem

When navigating between routes, the page flashes briefly — rendering in the wrong color scheme before Mantine hydrates and applies the correct one from `localStorage`. This is because `MantineProvider` is configured with `defaultColorScheme="auto"` but there is no `ColorSchemeScript` in `<head>` to set the `data-mantine-color-scheme` attribute before the first paint.

### Execution Steps

> **⚠️ GUARDRAILS:**
> - **DO NOT** search, grep, or read files inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** modify any files listed in "NOT TOUCHED".
> - Use **Mantine v9** imports only.

---

**A1.** Modify `src/app/layout.tsx` — add `ColorSchemeScript` to prevent the flash.

**A1a.** Update the import from `@mantine/core` to include `ColorSchemeScript`. Find:

```typescript
import { MantineProvider, createTheme } from "@mantine/core";
```

Replace with:

```typescript
import { MantineProvider, ColorSchemeScript, createTheme } from "@mantine/core";
```

**A1b.** Add `ColorSchemeScript` inside the `<head>` tag. Find:

```tsx
      <head />
```

Replace with:

```tsx
      <head>
        <ColorSchemeScript defaultColorScheme="auto" />
      </head>
```

### Phase A Verification

```bash
npm run build
```

Must pass with zero errors. Then:

| Check | Expected |
|---|---|
| Navigate between routes (timesheet → contracts → users → back) | **No color scheme flash** — page renders in the correct scheme immediately |
| Toggle dark/light mode via header icon | Switch is instant, persists across navigation |
| Open app in a new tab | Correct color scheme is applied on first paint (no flash) |
| Hard refresh (Ctrl+Shift+R) | No flash — `ColorSchemeScript` runs before React hydration |

**⚠️ Do NOT proceed to Phase B until Phase A builds and verifies correctly.**

---

## Phase B: Global MRT Table CSS Overrides

### Problem

All Mantine React Table instances across the admin pages have:
- Oversized sort icons in column headers
- Oversized column action menu icons (three-dot icons)
- Tight/cramped cell padding
- Top toolbar icons that are too large

These issues are consistent across all 4 admin tables, so a global CSS approach is most maintainable.

### Execution Steps

---

**B1.** Modify `src/app/globals.css` — add MRT-specific CSS overrides at the END of the file. Do NOT modify existing CSS rules.

Add the following CSS block at the end of the file:

```css
/* ---------------------------------------------------------------------------
   Mantine React Table — Global Style Overrides
   Targets MRT's internal CSS classes to fix icon sizing, padding, and spacing.
   --------------------------------------------------------------------------- */

/* Shrink the sort arrow icons in column headers */
.mrt-table-head-cell-sort-button svg {
  width: 14px !important;
  height: 14px !important;
}

/* Shrink the column actions (three-dot menu) icons in headers */
.mrt-table-head-cell-column-actions-button {
  min-width: 24px !important;
  min-height: 24px !important;
  width: 24px !important;
  height: 24px !important;
}

.mrt-table-head-cell-column-actions-button svg {
  width: 14px !important;
  height: 14px !important;
}

/* Add consistent padding to header cells */
.mrt-table-head-cell {
  padding: 10px 12px !important;
}

/* Add consistent padding to body cells */
.mrt-table-body-cell {
  padding: 10px 12px !important;
}

/* Ensure header cell content (label + icons) doesn't wrap awkwardly */
.mrt-table-head-cell-content {
  gap: 4px !important;
}

/* Shrink top toolbar action icons (search, filter, density, fullscreen) */
.mrt-toolbar-internal-buttons svg {
  width: 18px !important;
  height: 18px !important;
}

.mrt-toolbar-internal-buttons button {
  min-width: 32px !important;
  min-height: 32px !important;
  width: 32px !important;
  height: 32px !important;
}

/* Bottom toolbar (pagination) — tighten spacing */
.mrt-table-pagination {
  padding: 8px 12px !important;
}

/* Row action cells — ensure consistent padding */
.mrt-table-body-cell[data-is-row-actions="true"] {
  padding: 6px 12px !important;
}
```

### Phase B Verification

```bash
npm run build
```

Must pass with zero errors. Then:

| Check | Expected |
|---|---|
| User Management table | Sort icons (↕) are smaller (14px), header text has breathing room |
| Contracts & CLINs table | Column action dots (⋮) are smaller, not crowding "Contract Number" text |
| All admin tables — cell padding | Body cells have 10px vertical / 12px horizontal padding — content not cramped |
| Top toolbar icons (search, filter, density, fullscreen) | Icons are 18px, buttons are 32px — compact but still clickable |
| Pagination area | Tighter, cleaner spacing |
| Dark mode | All overrides render correctly in dark mode (no color issues) |

**⚠️ Do NOT proceed to Phase C until Phase B builds and verifies correctly.**

---

## Phase C: Per-Table Component Refinements

### Problem

Even with global CSS overrides, some tables may need individual `useMantineReactTable` configuration for optimal results — particularly for column sizing adjustments and ensuring row action cells are properly spaced. The global CSS handles icon sizing and padding, but column widths and specific `mantineTableProps` need to be set per-table.

### Execution Steps

---

**C1.** Modify `src/app/(app)/admin/contracts/ContractsClient.tsx` — add table styling props.

Find the `useMantineReactTable` call:

```typescript
  const table = useMantineReactTable({
    columns,
    data: contracts,
    enableRowActions: true,
    positionActionsColumn: 'last',
    renderRowActions: ({ row }) => (
```

Add the following properties to the `useMantineReactTable` config object, AFTER the `renderTopToolbarCustomActions` property and BEFORE the closing `});`:

```typescript
    mantineTableProps: {
      highlightOnHover: true,
      striped: 'odd',
      withColumnBorders: false,
    },
    mantineTableHeadCellProps: {
      style: {
        fontWeight: 600,
        fontSize: '0.85rem',
      },
    },
    mantineTableBodyCellProps: {
      style: {
        fontSize: '0.875rem',
      },
    },
    displayColumnDefOptions: {
      'mrt-row-actions': {
        header: 'Actions',
        size: 100,
        mantineTableHeadCellProps: {
          style: { textAlign: 'center' as const },
        },
        mantineTableBodyCellProps: {
          style: { textAlign: 'center' as const },
        },
      },
    },
```

---

**C2.** Modify `src/app/(app)/admin/users/UsersClient.tsx` — add table styling props.

Find the `useMantineReactTable` call:

```typescript
  const table = useMantineReactTable({
    columns,
    data: users,
    enableRowActions: true,
    positionActionsColumn: 'last',
    renderRowActions: ({ row }) => (
```

Add the following properties to the `useMantineReactTable` config object, AFTER the `renderTopToolbarCustomActions` property and BEFORE the closing `});`:

```typescript
    mantineTableProps: {
      highlightOnHover: true,
      striped: 'odd',
      withColumnBorders: false,
    },
    mantineTableHeadCellProps: {
      style: {
        fontWeight: 600,
        fontSize: '0.85rem',
      },
    },
    mantineTableBodyCellProps: {
      style: {
        fontSize: '0.875rem',
      },
    },
    displayColumnDefOptions: {
      'mrt-row-actions': {
        header: 'Actions',
        size: 80,
        mantineTableHeadCellProps: {
          style: { textAlign: 'center' as const },
        },
        mantineTableBodyCellProps: {
          style: { textAlign: 'center' as const },
        },
      },
    },
```

---

**C3.** Modify `src/app/(app)/admin/assignments/AssignmentsClient.tsx` — add table styling props.

Find the `useMantineReactTable` call:

```typescript
  const table = useMantineReactTable({
    columns,
    data: assignments,
    enableColumnFilters: true,
    enableRowActions: true,
    positionActionsColumn: 'last',
    renderRowActions: ({ row }) => (
```

Add the following properties to the `useMantineReactTable` config object, AFTER the closing of `renderRowActions` and BEFORE the closing `});`:

```typescript
    mantineTableProps: {
      highlightOnHover: true,
      striped: 'odd',
      withColumnBorders: false,
    },
    mantineTableHeadCellProps: {
      style: {
        fontWeight: 600,
        fontSize: '0.85rem',
      },
    },
    mantineTableBodyCellProps: {
      style: {
        fontSize: '0.875rem',
      },
    },
    displayColumnDefOptions: {
      'mrt-row-actions': {
        header: 'Actions',
        size: 110,
        mantineTableHeadCellProps: {
          style: { textAlign: 'center' as const },
        },
        mantineTableBodyCellProps: {
          style: { textAlign: 'center' as const },
        },
      },
    },
```

---

**C4.** Modify `src/app/(app)/admin/approvals/ApprovalsClient.tsx` — add table styling props.

Find the `useMantineReactTable` call:

```typescript
  const table = useMantineReactTable({
    columns,
    data: periods,
    enableRowActions: true,
    positionActionsColumn: 'last',
    renderRowActions: ({ row }) => (
```

Add the following properties to the `useMantineReactTable` config object, AFTER the closing of `renderRowActions` and BEFORE the closing `});`:

```typescript
    mantineTableProps: {
      highlightOnHover: true,
      striped: 'odd',
      withColumnBorders: false,
    },
    mantineTableHeadCellProps: {
      style: {
        fontWeight: 600,
        fontSize: '0.85rem',
      },
    },
    mantineTableBodyCellProps: {
      style: {
        fontSize: '0.875rem',
      },
    },
    displayColumnDefOptions: {
      'mrt-row-actions': {
        header: 'Actions',
        size: 100,
        mantineTableHeadCellProps: {
          style: { textAlign: 'center' as const },
        },
        mantineTableBodyCellProps: {
          style: { textAlign: 'center' as const },
        },
      },
    },
```

### Phase C Verification

```bash
npm run build
```

Must pass with zero errors. Then:

| Check | Expected |
|---|---|
| **User Management table** | Rows have alternating stripe; hover highlight; Actions column centered with header label |
| **Contracts & CLINs table** | Same polish; Edit + CLINs icons have proper spacing; header font 0.85rem semibold |
| **User Assignments table** | Deactivate button properly spaced in centered Actions column |
| **Timesheet Approvals table** | Review button centered in Actions column; clean header typography |
| **All tables — dark mode** | Stripes, hover highlight, and padding render correctly in dark mode |
| **All tables — mobile/small screen** | Tables remain scrollable; no broken layouts from padding changes |

---

## Guardrail Verification (All Phases)

```bash
npm run build
```

Must pass with zero errors.

```bash
git diff --name-only
```

Must **NOT** include:
- `src/db/schema.ts`
- `src/auth.ts`
- `src/middleware.ts`
- `src/components/timesheet/*` (any timesheet component)
- `src/components/shell/*`
- `src/server/actions/*`
- `src/types/*`
- `src/lib/*`
- `src/app/(app)/timesheet/*`

**SHOULD** include:
- `src/app/layout.tsx` (Phase A — ColorSchemeScript)
- `src/app/globals.css` (Phase B — MRT CSS overrides)
- `src/app/(app)/admin/contracts/ContractsClient.tsx` (Phase C — table props)
- `src/app/(app)/admin/users/UsersClient.tsx` (Phase C — table props)
- `src/app/(app)/admin/assignments/AssignmentsClient.tsx` (Phase C — table props)
- `src/app/(app)/admin/approvals/ApprovalsClient.tsx` (Phase C — table props)

## Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `ColorSchemeScript is not exported from '@mantine/core'` | Wrong import path | Ensure importing from `@mantine/core` — it's a Mantine v9 export |
| CSS overrides not applying | Wrong CSS class names | MRT v2 uses `mrt-` prefixed classes; verify in browser DevTools |
| `!important` not overriding | Selector specificity too low | Add more specific selectors or verify the class name is correct |
| Table stripes look wrong in dark mode | Mantine handles `striped` automatically | Use `striped: 'odd'` — Mantine applies correct dark/light backgrounds |
| `displayColumnDefOptions` type error | Wrong key name | Must use exact string `'mrt-row-actions'` as the key |
| Flash still occurs after Phase A | Browser cache | Hard refresh (Ctrl+Shift+R) to clear cached HTML without the script |
| Icons still large after Phase B | CSS classes changed in MRT version | Inspect elements in DevTools to find the actual class names, update selectors |

## CSS Override Strategy Note

The global CSS approach in Phase B targets MRT's internal CSS class names. If a future MRT version changes these class names, the overrides will silently stop working. The per-table `mantineTableHeadCellProps` / `mantineTableBodyCellProps` in Phase C serve as a fallback that uses MRT's official API and will survive version upgrades. Both layers together provide defense-in-depth styling.

If the global CSS class selectors in Phase B do not match the actual MRT v2 class names at runtime, the developer should:
1. Open browser DevTools on any admin table page
2. Inspect a column header cell and note the actual CSS class names
3. Update the selectors in `globals.css` accordingly
