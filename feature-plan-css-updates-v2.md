# Blueprint: CSS/UI Polish v2 — Correct MRT Styling Approach

> **This ticket contains TWO phases. Complete Phase A fully before starting Phase B.**
>
> **This blueprint supersedes `feature-plan-css-updates.md`.** The prior blueprint's Phase B used plain `.mrt-*` CSS class selectors that matched zero DOM elements because MRT v2 uses CSS Modules with hashed class names (e.g., `.MRT_TableHeadCell-module_root__6y50a`). Those selectors are dead CSS. This blueprint removes them and uses MRT's JavaScript API instead.

---

## Problem Statement

The admin tables (User Management, Contracts & CLINs, User Assignments, Timesheet Approvals) have the following issues visible in the screenshot:

1. **Oversized sort icons (↕)** — The sort arrow icons in column headers are too large and crowd the header text.
2. **Oversized column action menu icons (⋮)** — Three-dot menu buttons in every column header are disproportionately large and unnecessary for these simple admin tables.
3. **Insufficient header/cell padding** — Content is cramped against cell borders.
4. **"Add User" button riding the edge** — The top toolbar has no padding, so the custom action button hugs the table border.
5. **Top toolbar icons too large** — Search, filter, density, and fullscreen toggle icons in the toolbar are oversized.

### Why the Previous Blueprint Failed

MRT v2 uses **CSS Modules with hashed class names** at build time. The class names in the DOM look like `.MRT_TableHeadCell-module_root__6y50a` — the suffix hash changes between builds. The prior blueprint targeted plain `.mrt-table-head-cell` which matches zero elements. The correct approach is to use **MRT's JavaScript configuration API** (`useMantineReactTable` props) to control sizing, padding, and feature toggles.

---

## File Topology

```
Files to MODIFY:
├── src/app/globals.css                                   ← Remove dead .mrt-* CSS, add attribute-based overrides
├── src/app/(app)/admin/contracts/ContractsClient.tsx      ← MRT API props for styling
├── src/app/(app)/admin/users/UsersClient.tsx              ← MRT API props for styling
├── src/app/(app)/admin/assignments/AssignmentsClient.tsx  ← MRT API props for styling
├── src/app/(app)/admin/approvals/ApprovalsClient.tsx      ← MRT API props for styling

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/db/schema.ts                                      ← ❌ DO NOT MODIFY
├── src/auth.ts                                           ← ❌ DO NOT MODIFY
├── src/middleware.ts                                     ← ❌ DO NOT MODIFY
├── src/app/layout.tsx                                    ← ❌ DO NOT MODIFY (ColorSchemeScript already added)
├── src/components/timesheet/*                            ← ❌ DO NOT MODIFY
├── src/components/shell/*                                ← ❌ DO NOT MODIFY
├── src/server/actions/*                                  ← ❌ DO NOT MODIFY
├── src/types/*                                           ← ❌ DO NOT MODIFY
├── src/lib/*                                             ← ❌ DO NOT MODIFY
├── src/app/(app)/timesheet/*                             ← ❌ DO NOT MODIFY
```

---

## Phase A: Remove Dead CSS + Add Working Overrides

### Problem

The `globals.css` contains ~60 lines of `.mrt-*` CSS selectors that match zero DOM elements. These must be removed and replaced with selectors that actually work with MRT v2's CSS Modules architecture.

### Execution Steps

> **⚠️ GUARDRAILS:**
> - **DO NOT** search, grep, or read files inside `node_modules/`, `.next/`, or `dist/`.
> - **DO NOT** modify any files listed in "NOT TOUCHED".
> - Use **Mantine v9** imports only.

---

**A1.** Modify `src/app/globals.css` — **delete** the entire MRT CSS override block (lines 30–90, everything from the `/* ---` comment through the end of the file) and replace it with attribute-based selectors that actually match MRT v2's DOM output.

Find and DELETE the entire block starting from:

```css
/* ---------------------------------------------------------------------------
   Mantine React Table — Global Style Overrides
```

All the way through the end of the file (the `.mrt-table-body-cell[data-is-row-actions="true"]` rule).

Then add this NEW block at the end of the file:

```css
/* ---------------------------------------------------------------------------
   Mantine React Table v2 — Global Style Overrides
   MRT v2 uses CSS Modules with hashed class names, so we target elements
   using attribute selectors [class*="MRT_"] and standard HTML selectors.
   --------------------------------------------------------------------------- */

/* Shrink sort icons in column headers */
[class*="MRT_TableHeadCellSortLabel"] svg {
  width: 14px !important;
  height: 14px !important;
}

/* Shrink column action menu buttons (three-dot icons) */
[class*="MRT_TableHeadCell-module_content-actions"] button {
  min-width: 24px !important;
  min-height: 24px !important;
  width: 24px !important;
  height: 24px !important;
  padding: 2px !important;
}

[class*="MRT_TableHeadCell-module_content-actions"] svg {
  width: 14px !important;
  height: 14px !important;
}

/* Shrink toolbar internal buttons (search, filter, density, fullscreen) */
[class*="MRT_ToolbarInternalButtons"] button {
  min-width: 32px !important;
  min-height: 32px !important;
  width: 32px !important;
  height: 32px !important;
}

[class*="MRT_ToolbarInternalButtons"] svg {
  width: 18px !important;
  height: 18px !important;
}

/* Add padding to the top toolbar so buttons don't ride the edge */
[class*="MRT_TopToolbar-module_root"] {
  padding: 8px 12px !important;
}

/* Tighten gap between header label text and sort/action icons */
[class*="MRT_TableHeadCell-module_content__"] {
  gap: 2px !important;
}

/* Bottom toolbar padding */
[class*="MRT_BottomToolbar-module_root"] {
  padding: 6px 12px !important;
}
```

### Phase A Verification

```bash
npm run build
```

Must pass with zero errors. Then:

| Check | Expected |
|---|---|
| Sort icons (↕) in all admin table headers | Visibly smaller (14px) |
| Column action dots (⋮) buttons | Smaller (24px buttons, 14px icons) |
| Top toolbar (search, filter, density, fullscreen icons) | Smaller (32px buttons, 18px icons) |
| "Add User" / "Add Contract" button | Has breathing room from toolbar padding (8px 12px) |
| Bottom toolbar / pagination | Tighter spacing (6px 12px) |
| Dark mode | All overrides render correctly |

**⚠️ Do NOT proceed to Phase B until Phase A builds and verifies correctly.**

---

## Phase B: MRT JavaScript API Styling Props

### Problem

Even with CSS overrides, the tables need proper padding via MRT's official JavaScript API to ensure consistent cell spacing. Additionally, tables that don't need column action menus should disable them entirely for a cleaner look.

### Execution Steps

---

**B1.** Modify `src/app/(app)/admin/users/UsersClient.tsx` — update the `useMantineReactTable` config.

Find the current config block (which already has the Phase C props from the prior blueprint):

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

Replace with:

```typescript
    enableColumnActions: false,
    enableDensityToggle: false,
    enableFullScreenToggle: false,
    mantineTableProps: {
      highlightOnHover: true,
      striped: 'odd',
      withColumnBorders: false,
    },
    mantineTableHeadCellProps: {
      style: {
        fontWeight: 600,
        fontSize: '0.85rem',
        padding: '12px 16px',
      },
    },
    mantineTableBodyCellProps: {
      style: {
        fontSize: '0.875rem',
        padding: '12px 16px',
      },
    },
    mantineTopToolbarProps: {
      style: {
        padding: '12px 16px',
      },
    },
    displayColumnDefOptions: {
      'mrt-row-actions': {
        header: 'Actions',
        size: 80,
        mantineTableHeadCellProps: {
          style: {
            textAlign: 'center' as const,
            padding: '12px 16px',
          },
        },
        mantineTableBodyCellProps: {
          style: {
            textAlign: 'center' as const,
            padding: '12px 16px',
          },
        },
      },
    },
```

---

**B2.** Modify `src/app/(app)/admin/contracts/ContractsClient.tsx` — update the `useMantineReactTable` config.

Find the current config block:

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

Replace with:

```typescript
    enableColumnActions: false,
    enableDensityToggle: false,
    enableFullScreenToggle: false,
    mantineTableProps: {
      highlightOnHover: true,
      striped: 'odd',
      withColumnBorders: false,
    },
    mantineTableHeadCellProps: {
      style: {
        fontWeight: 600,
        fontSize: '0.85rem',
        padding: '12px 16px',
      },
    },
    mantineTableBodyCellProps: {
      style: {
        fontSize: '0.875rem',
        padding: '12px 16px',
      },
    },
    mantineTopToolbarProps: {
      style: {
        padding: '12px 16px',
      },
    },
    displayColumnDefOptions: {
      'mrt-row-actions': {
        header: 'Actions',
        size: 100,
        mantineTableHeadCellProps: {
          style: {
            textAlign: 'center' as const,
            padding: '12px 16px',
          },
        },
        mantineTableBodyCellProps: {
          style: {
            textAlign: 'center' as const,
            padding: '12px 16px',
          },
        },
      },
    },
```

---

**B3.** Modify `src/app/(app)/admin/assignments/AssignmentsClient.tsx` — update the `useMantineReactTable` config.

Find the current config block:

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

Replace with:

```typescript
    enableColumnActions: false,
    enableDensityToggle: false,
    enableFullScreenToggle: false,
    mantineTableProps: {
      highlightOnHover: true,
      striped: 'odd',
      withColumnBorders: false,
    },
    mantineTableHeadCellProps: {
      style: {
        fontWeight: 600,
        fontSize: '0.85rem',
        padding: '12px 16px',
      },
    },
    mantineTableBodyCellProps: {
      style: {
        fontSize: '0.875rem',
        padding: '12px 16px',
      },
    },
    mantineTopToolbarProps: {
      style: {
        padding: '12px 16px',
      },
    },
    displayColumnDefOptions: {
      'mrt-row-actions': {
        header: 'Actions',
        size: 110,
        mantineTableHeadCellProps: {
          style: {
            textAlign: 'center' as const,
            padding: '12px 16px',
          },
        },
        mantineTableBodyCellProps: {
          style: {
            textAlign: 'center' as const,
            padding: '12px 16px',
          },
        },
      },
    },
```

---

**B4.** Modify `src/app/(app)/admin/approvals/ApprovalsClient.tsx` — update the `useMantineReactTable` config.

Find the current config block:

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

Replace with:

```typescript
    enableColumnActions: false,
    enableDensityToggle: false,
    enableFullScreenToggle: false,
    mantineTableProps: {
      highlightOnHover: true,
      striped: 'odd',
      withColumnBorders: false,
    },
    mantineTableHeadCellProps: {
      style: {
        fontWeight: 600,
        fontSize: '0.85rem',
        padding: '12px 16px',
      },
    },
    mantineTableBodyCellProps: {
      style: {
        fontSize: '0.875rem',
        padding: '12px 16px',
      },
    },
    mantineTopToolbarProps: {
      style: {
        padding: '12px 16px',
      },
    },
    displayColumnDefOptions: {
      'mrt-row-actions': {
        header: 'Actions',
        size: 100,
        mantineTableHeadCellProps: {
          style: {
            textAlign: 'center' as const,
            padding: '12px 16px',
          },
        },
        mantineTableBodyCellProps: {
          style: {
            textAlign: 'center' as const,
            padding: '12px 16px',
          },
        },
      },
    },
```

### Phase B Verification

```bash
npm run build
```

Must pass with zero errors. Then:

| Check | Expected |
|---|---|
| **User Management table** | No three-dot (⋮) icons in column headers; sort arrows only; "Add User" has proper padding from top edge; cells have 12px/16px padding |
| **Contracts & CLINs table** | Same clean headers; "Add Contract" button has breathing room; no density/fullscreen toggles |
| **User Assignments table** | Same polish; "Assign" form above table unchanged |
| **Timesheet Approvals table** | Same polish; "Review" button in Actions column properly spaced |
| **All tables — dark mode** | Stripes, padding, and hover all render correctly |
| **All tables — sorting still works** | Click column headers to sort — arrows appear but are smaller (14px via CSS) |
| **Density/fullscreen toggles** | Removed from all admin tables (unnecessary clutter) |

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
- `src/app/layout.tsx`
- `src/components/timesheet/*`
- `src/components/shell/*`
- `src/server/actions/*`
- `src/types/*`
- `src/lib/*`
- `src/app/(app)/timesheet/*`

**SHOULD** include:
- `src/app/globals.css` (Phase A — removed dead CSS, added working attribute selectors)
- `src/app/(app)/admin/users/UsersClient.tsx` (Phase B — MRT API props)
- `src/app/(app)/admin/contracts/ContractsClient.tsx` (Phase B — MRT API props)
- `src/app/(app)/admin/assignments/AssignmentsClient.tsx` (Phase B — MRT API props)
- `src/app/(app)/admin/approvals/ApprovalsClient.tsx` (Phase B — MRT API props)

## Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `enableColumnActions` type error | Wrong prop name | Must be exactly `enableColumnActions: false` (camelCase) |
| `mantineTopToolbarProps` type error | Not a valid prop | Check MRT v2 docs — it may be `mantineTopToolbarProps` or may need to be applied differently |
| Sort icons still large after Phase A | `[class*="MRT_TableHeadCellSortLabel"]` doesn't match | Inspect the actual DOM in browser DevTools, check the sort label wrapper class |
| Padding not applying | MRT's inline styles have higher specificity | Add `!important` to the padding values in the style objects if needed |
| Column action dots still showing | `enableColumnActions: false` not set | Ensure it's added to the `useMantineReactTable` config, not inside `mantineTableProps` |
| Top toolbar has no padding despite `mantineTopToolbarProps` | Prop name wrong for this MRT version | Try wrapping the `<MantineReactTable>` in a `<div style={{ padding: '12px 16px' }}>` as fallback |

## Why This Approach Will Work

1. **`[class*="MRT_"]` attribute selectors** — CSS `[class*="substring"]` matches any element whose `class` attribute **contains** the substring. Since MRT's hashed class names always start with `MRT_ComponentName-module_`, the substring match works regardless of the hash suffix. This is stable across builds.

2. **`enableColumnActions: false`** — This is MRT's official API to remove column action menus entirely. No CSS hacking needed.

3. **`mantineTableHeadCellProps.style.padding`** — This uses MRT's passthrough API to set inline styles on the rendered `<th>` elements, which always wins over CSS class-based padding.

4. **`mantineTopToolbarProps.style.padding`** — Same passthrough mechanism for the toolbar wrapper.
