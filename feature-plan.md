# Blueprint: Bi-Weekly Timesheet — Polish & Aggregation

## 1. Architectural Overview

### Problem Analysis

After reviewing all source files, there are **three distinct categories** of issues:

**Issue 1 — Broken Color Scheme / Theming:**
The root cause is that the MantineProvider is set to `defaultColorScheme="light"`, but the user's browser/OS is in dark mode. The `globals.css` file also has `prefers-color-scheme: dark` media queries that set `--background: #0a0a0a` and `color-scheme: dark`. Meanwhile, the table component hardcodes light-mode-only Mantine CSS variables like `var(--mantine-color-gray-0)` and `var(--mantine-color-gray-1)` for weekend backgrounds, charge code cell backgrounds, and borders. In dark mode, `gray-0` resolves to near-white (`#f8f9fa`), creating the jarring white boxes the user sees. The fix is twofold:
1. **Force a consistent color scheme** in the MantineProvider by changing `defaultColorScheme` to `"auto"` (or `"dark"` if that's the desired look), so Mantine respects the OS preference.
2. **Replace all hardcoded `gray-0`/`gray-1`/`gray-3` cell styles** with theme-aware alternatives. Instead of setting explicit `backgroundColor` values on cells, use Mantine's `light-dark()` CSS function or alpha-based variables (e.g., `var(--mantine-color-default-border)` for borders, and `var(--mantine-color-body)` or semantic tokens for backgrounds). Weekend shading should use a very subtle alpha overlay rather than a fixed gray shade.

**Issue 2 — Constrained Screen Real Estate:**
`BiWeeklyTimesheetClient.tsx` uses `<Container size="xl">` which caps at `1280px`. For a 16-column table, this causes unnecessary horizontal scrolling. The fix is to switch to `<Container fluid px="md">` to span the full viewport width.

**Issue 3 — Missing Totals / Aggregation:**
The existing `TotalHoursCell` component already computes per-row totals, and a "Total" column exists but may not be rendering correctly with pinning. What's completely missing is:
- **Footer row** with daily totals (sum of all charge codes for each day column)
- **Grand total** in the bottom-right corner (sum of all hours across all rows and days)

The best approach for MRT v2 is to use the `Footer` property on each column definition. MRT v2 supports `mantineTableFooterCellProps` for styling footer cells. We will add a `Footer` renderer to each day column that sums all entries for that day index, a `Footer` on the "Charge Code" column that displays "Daily Totals", and a `Footer` on the "Total" column that displays the grand total. We must also enable `enableBottomToolbar: false` (already set) and ensure the `<tfoot>` renders by setting `enableTableFooter: true` (or by simply providing `Footer` on at least one column — MRT v2 auto-shows the footer row when any column has a `Footer` property).

### Files to Modify

| File | Changes |
|---|---|
| `src/app/globals.css` | Remove the `prefers-color-scheme` media queries that conflict with Mantine's theme system |
| `src/app/layout.tsx` | Change `defaultColorScheme` from `"light"` to `"auto"` on both `ColorSchemeScript` and `MantineProvider` |
| `src/components/timesheet/BiWeeklyTimesheetClient.tsx` | Replace `<Container size="xl">` with `<Container fluid px="md">` |
| `src/components/timesheet/BiWeeklyTable.tsx` | (Major changes) Fix all hardcoded color variables, add `Footer` renderers for daily totals + grand total, add `mantineTableFooterCellProps` styling |
| `src/components/timesheet/cells/HourCell.tsx` | Minor: ensure NumberInput text color is theme-aware |

### No New Files Required
All changes are modifications to existing files. No new components are needed.

---

## 2. File Topology

```
Files to MODIFY (no new files):
├── src/app/globals.css                                    ← Remove conflicting dark-mode CSS
├── src/app/layout.tsx                                     ← Fix defaultColorScheme to "auto"
├── src/components/timesheet/BiWeeklyTimesheetClient.tsx    ← Container fluid
├── src/components/timesheet/BiWeeklyTable.tsx              ← Theme fixes + footer aggregation
└── src/components/timesheet/cells/HourCell.tsx             ← Theme-aware NumberInput
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ STRICT RULES FOR THE EXECUTION AGENT:**
> - Use **Mantine v9** imports only (`@mantine/core`, `@mantine/hooks`).
> - Use **Mantine React Table v2** (`mantine-react-table`).
> - Do **NOT** search or read any files inside `node_modules/`, `.next/`, or `dist/`.
> - Do **NOT** install any new packages.
> - Do **NOT** create any API routes, Server Actions, or database schemas.
> - Only modify the files listed above. Do not refactor or rename any other files.

---

### Step 1: Fix Global CSS Conflicts (`src/app/globals.css`)

**Problem:** The `globals.css` file contains `@media (prefers-color-scheme: dark)` blocks that set custom `--background` and `--foreground` CSS variables and `color-scheme: dark`. These conflict with Mantine's own theme system and cause the body background to go dark while Mantine components may still render in light mode (or vice versa).

**Action:** Replace the entire `globals.css` with a minimal reset that defers all color decisions to Mantine:

```css
html {
  height: 100%;
}

html,
body {
  max-width: 100vw;
  overflow-x: hidden;
}

body {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

* {
  box-sizing: border-box;
  padding: 0;
  margin: 0;
}

a {
  color: inherit;
  text-decoration: none;
}
```

**What was removed:**
- The `:root` block with `--background` / `--foreground` custom properties
- Both `@media (prefers-color-scheme: dark)` blocks
- The `color` and `background` declarations on `body`
- The `font-family` declaration on `body` (Mantine provides its own)

---

### Step 2: Fix Color Scheme in Layout (`src/app/layout.tsx`)

**Problem:** `defaultColorScheme="light"` is hardcoded, but the user's OS is in dark mode. The `ColorSchemeScript` sets `data-mantine-color-scheme="light"` on SSR, but the client's dark mode preference overrides it inconsistently.

**Action:** Change both `ColorSchemeScript` and `MantineProvider` to use `defaultColorScheme="auto"`:

```tsx
<ColorSchemeScript defaultColorScheme="auto" />
```
```tsx
<MantineProvider defaultColorScheme="auto" theme={theme}>{children}</MantineProvider>
```

This tells Mantine to respect the user's OS preference and apply its full dark/light token system consistently.

---

### Step 3: Expand Layout to Full Width (`src/components/timesheet/BiWeeklyTimesheetClient.tsx`)

**Problem:** `<Container size="xl">` caps width at 1280px, squeezing the 16-column table.

**Action:** Change line 18 from:
```tsx
<Container size="xl" py="xl">
```
to:
```tsx
<Container fluid px="md" py="xl">
```

This makes the table stretch to the full viewport width with only a small horizontal padding.

---

### Step 4: Fix Theme-Hardcoded Styles in BiWeeklyTable (`src/components/timesheet/BiWeeklyTable.tsx`)

This is the most critical step. Every hardcoded `var(--mantine-color-gray-X)` must be replaced with theme-aware values.

#### 4a. Charge Code Column Cell Props (lines 50-57)

Replace:
```typescript
mantineTableBodyCellProps: {
  style: {
    backgroundColor: 'var(--mantine-color-gray-0)',
    borderRight: '2px solid var(--mantine-color-gray-3)',
    verticalAlign: 'top',
    padding: '8px',
  },
},
```
With:
```typescript
mantineTableBodyCellProps: {
  style: {
    backgroundColor: 'var(--mantine-color-body)',
    borderRight: '2px solid var(--mantine-color-default-border)',
    verticalAlign: 'top',
    padding: '8px',
  },
},
```

#### 4b. Weekend Day Column Body Cell Props (lines 75-81)

Replace:
```typescript
mantineTableBodyCellProps: {
  style: {
    backgroundColor: isWeekend ? 'var(--mantine-color-gray-0)' : undefined,
    padding: '6px 4px',
    verticalAlign: 'middle',
  },
},
```
With:
```typescript
mantineTableBodyCellProps: {
  style: {
    backgroundColor: isWeekend
      ? 'light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-7))'
      : undefined,
    padding: '6px 4px',
    verticalAlign: 'middle',
  },
},
```

#### 4c. Weekend Day Column Header Cell Props (lines 82-86)

Replace:
```typescript
mantineTableHeadCellProps: {
  style: {
    backgroundColor: isWeekend ? 'var(--mantine-color-gray-0)' : undefined,
  },
},
```
With:
```typescript
mantineTableHeadCellProps: {
  style: {
    backgroundColor: isWeekend
      ? 'light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-7))'
      : undefined,
  },
},
```

#### 4d. Total Column Cell Props (lines 98-104)

Replace:
```typescript
mantineTableBodyCellProps: {
  style: {
    borderLeft: '2px solid var(--mantine-color-gray-3)',
    padding: '6px 4px',
    verticalAlign: 'middle',
  },
},
```
With:
```typescript
mantineTableBodyCellProps: {
  style: {
    borderLeft: '2px solid var(--mantine-color-default-border)',
    padding: '6px 4px',
    verticalAlign: 'middle',
  },
},
```

#### 4e. Global Table Head Cell Props (lines 130-135)

Replace:
```typescript
mantineTableHeadCellProps: {
  style: {
    borderBottom: '2px solid var(--mantine-color-gray-3)',
    textAlign: 'center',
    padding: '8px 4px',
  },
},
```
With:
```typescript
mantineTableHeadCellProps: {
  style: {
    borderBottom: '2px solid var(--mantine-color-default-border)',
    textAlign: 'center' as const,
    padding: '8px 4px',
  },
},
```

#### 4f. Global Table Body Cell Props (lines 138-143)

Replace:
```typescript
mantineTableBodyCellProps: {
  style: {
    borderBottom: '1px solid var(--mantine-color-gray-1)',
    padding: '6px 4px',
    verticalAlign: 'middle',
  },
},
```
With:
```typescript
mantineTableBodyCellProps: {
  style: {
    borderBottom: '1px solid var(--mantine-color-default-border)',
    padding: '6px 4px',
    verticalAlign: 'middle' as const,
  },
},
```

---

### Step 5: Add Footer Aggregation Row (`src/components/timesheet/BiWeeklyTable.tsx`)

This step adds the daily totals footer row, including a grand total cell.

#### 5a. Add `Footer` to the Charge Code column

Add the following property to the `chargeCodeCol` definition:

```typescript
Footer: () => (
  <Text fw={700} size="sm">
    Daily Totals
  </Text>
),
```

Also add `mantineTableFooterCellProps` to match the body cell styling:

```typescript
mantineTableFooterCellProps: {
  style: {
    backgroundColor: 'var(--mantine-color-body)',
    borderRight: '2px solid var(--mantine-color-default-border)',
    borderTop: '2px solid var(--mantine-color-default-border)',
    padding: '8px',
  },
},
```

#### 5b. Add `Footer` to each Day column

Inside the `Array.from({ length: 14 }, ...)` mapping, add to each day column object:

```typescript
Footer: () => {
  const dayTotal = entries.reduce((sum, entry) => sum + entry.hours[dayIndex], 0);
  return (
    <Text fw={700} ta="center" size="sm">
      {dayTotal.toFixed(2)}
    </Text>
  );
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
```

> **Note:** The `entries` variable is already available in scope from the `useTimesheet()` destructuring at the top of the component.

#### 5c. Add `Footer` to the Total column

```typescript
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
mantineTableFooterCellProps: {
  style: {
    borderLeft: '2px solid var(--mantine-color-default-border)',
    borderTop: '2px solid var(--mantine-color-default-border)',
    padding: '6px 4px',
  },
},
```

#### 5d. Ensure the footer row renders

In the `useMantineReactTable` configuration, verify that `enableTableFooter` is not explicitly set to `false`. MRT v2 automatically shows the footer row when any column has a `Footer` property. If it doesn't render, explicitly add:

```typescript
enableTableFooter: true,
```

---

### Step 6: Theme-Aware NumberInput in HourCell (`src/components/timesheet/cells/HourCell.tsx`)

The `NumberInput` uses `variant="unstyled"` which should inherit text color from the parent. However, to be safe, ensure the input text is always visible regardless of theme by adding an explicit `color` style:

Replace the `styles` prop on the `NumberInput` (line 61):
```typescript
styles={{ input: { textAlign: 'center', padding: 0 } }}
```
With:
```typescript
styles={{ input: { textAlign: 'center', padding: 0, color: 'var(--mantine-color-text)' } }}
```

---

## 4. Verification

After completing all steps, the execution agent must verify:

### 4a. Build Check
```bash
npm run build
```
Must complete with **zero errors**.

### 4b. Dev Server Visual Checks
```bash
npm run dev
```
Navigate to `http://localhost:3000/timesheet` and verify:

| Check | Expected Result |
|---|---|
| **No white boxes** | Weekend columns and charge code cells should blend smoothly with the dark (or light) background — no jarring white rectangles |
| **Full width** | The table should stretch across the entire viewport with only small left/right margins |
| **Footer row visible** | A "Daily Totals" row must appear at the bottom of the table |
| **Daily totals correct** | Each day column footer should show the sum of all charge codes for that day (e.g., Mon Week 1 = 8+6+0+2+0 = 16.00) |
| **Grand total correct** | Bottom-right cell should show the sum of all hours across all rows (verify against mock data: the expected total is 160.00) |
| **Weekend footer shading** | Weekend footer cells should have the same subtle background as weekend body cells |
| **Borders consistent** | All separating borders (charge code right border, total left border, header bottom, footer top) should use the same muted theme-aware color |
| **NumberInput visible** | Clicking a day cell should show an inline number input with readable text in both dark and light themes |
| **Note modal works** | Clicking the note icon should open the DCAA modal — this should not be broken by any of these changes |

### 4c. Quick Math Verification (against mock data)

| Charge Code | Row Total |
|---|---|
| NAVAIR Systems Support | 80.00 |
| DISA Cyber Operations | 60.00 |
| DHS Border Security Analytics | 16.00 |
| Army Logistics Modernization | 4.00 |
| Overhead / G&A | 0.00 |
| **Grand Total** | **160.00** |

| Day | Daily Total |
|---|---|
| Mon (Wk1) | 16.00 |
| Tue (Wk1) | 16.00 |
| Wed (Wk1) | 16.00 |
| Thu (Wk1) | 16.00 |
| Fri (Wk1) | 16.00 |
| Sat (Wk1) | 0.00 |
| Sun (Wk1) | 0.00 |
| Mon (Wk2) | 16.00 |
| Tue (Wk2) | 16.00 |
| Wed (Wk2) | 16.00 |
| Thu (Wk2) | 16.00 |
| Fri (Wk2) | 16.00 |
| Sat (Wk2) | 0.00 |
| Sun (Wk2) | 0.00 |

### 4d. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `light-dark()` CSS function not working | Browser doesn't support it | Ensure `<ColorSchemeScript>` sets `data-mantine-color-scheme` on `<html>` — Mantine's `light-dark()` reads this attribute, not the browser's native `prefers-color-scheme` |
| Footer row not appearing | MRT requires `Footer` on at least one column | Ensure `Footer` property is set on the charge code column at minimum |
| TypeScript error on `style` objects | Missing `as const` for string literal types | Add `as const` to `textAlign` and `verticalAlign` values |
| Grand total doesn't update on edit | Footer reads from `entries` which comes from context | Ensure the Footer function references `entries` from the component scope (which reactively updates via context) — do NOT memoize the footer independently |

---