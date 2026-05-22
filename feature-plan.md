# Blueprint: Semi-Monthly Pay Period Navigation & Column Header Alignment

## 1. Architectural Overview

### Problem Analysis

The current system uses a hardcoded 14-day period starting from a fixed Monday (`2026-05-18`). This has two fundamental issues:

**Issue 1 — Pay Period Model is Wrong:**
The current "bi-weekly" model assumes every pay period is exactly 14 days starting on a Monday. The user's actual business requirement is **semi-monthly** pay periods:
- **Period A:** 1st of the month → 15th of the month (always 15 days)
- **Period B:** 16th of the month → last day of the month (varies: 13–16 days depending on month)

This means the table must support a **variable number of day columns** (not always 14). The column count depends on which half of the month the user is viewing. The hardcoded `Array.from({ length: 14 })` and `WEEKEND_INDICES` constants must be replaced with dynamic date range generation.

**Issue 2 — No Period Navigation:**
There is no UI to switch between pay periods. The user needs forward/backward navigation controls. We'll add a `<PayPeriodSelector>` component above the table with:
- Left/Right arrow buttons (Mantine `<ActionIcon>`) to move to the previous/next period
- A center label showing the current period range (e.g., "May 1 – May 15, 2026")
- The entire component uses Mantine `<Group>` for layout

**Issue 3 — Column Headers Not Centered:**
Looking at the screenshot, the day column headers (Mon/May 18, Tue/May 19, etc.) are not properly centered above their respective data columns. The `ColumnHeaderDate` component uses `<Stack align="center">` which is correct, but the MRT head cell itself needs explicit `textAlign: 'center'` and the content needs to be horizontally centered within the fixed-width cell.

### State Management Changes

The `periodStart` in `TimesheetState` will be managed by two new reducer actions:
- `NAVIGATE_PERIOD` with a direction (`'prev' | 'next'`) — the reducer computes the new period start
- The `periodStart` will always be normalized to either the 1st or the 16th of a month

The number of days in the period is **derived** (not stored) from `periodStart`:
- If `periodStart.date() === 1` → period ends on the 15th → `numDays = 15`
- If `periodStart.date() === 16` → period ends on last day of month → `numDays = daysInMonth - 15`

Weekend detection must change from a static index set to dynamic `dayjs(date).day()` checks (where 0 = Sunday, 6 = Saturday).

### Mock Data Changes

The mock data currently uses a fixed 14-element `hours` array. Since the period length is now variable (13–16 days), mock entries need to provide enough hours data. The simplest approach: **generate mock entries dynamically** based on the current `periodStart` rather than hardcoding arrays. A helper function `generateMockHours(periodStart, numDays, chargeCodeId)` will produce realistic hour arrays of the correct length.

---

## 2. File Topology

```
Files to MODIFY:
├── src/types/timesheet.ts                                 ← Add NAVIGATE_PERIOD action, update TimesheetEntry
├── src/data/mock-timesheet.ts                             ← Replace fixed arrays with dynamic generation
├── src/components/timesheet/TimesheetContext.tsx           ← Add period navigation reducer logic
├── src/components/timesheet/BiWeeklyTimesheetClient.tsx    ← Add PayPeriodSelector, update title
├── src/components/timesheet/BiWeeklyTable.tsx              ← Dynamic column count, fix header centering
├── src/components/timesheet/cells/ColumnHeaderDate.tsx     ← Fix centering, dynamic weekend detection
├── src/components/timesheet/cells/HourCell.tsx             ← No changes expected
├── src/components/timesheet/cells/TotalHoursCell.tsx       ← No changes expected

Files to CREATE:
└── src/components/timesheet/PayPeriodSelector.tsx          ← New: navigation arrows + period label
```

---

## 3. Step-by-Step Execution Plan

> **⚠️ STRICT RULES FOR THE EXECUTION AGENT:**
> - Use **Mantine v9** imports only (`@mantine/core`, `@mantine/hooks`).
> - Use **Mantine React Table v2** (`mantine-react-table`).
> - Do **NOT** search or read any files inside `node_modules/`, `.next/`, or `dist/`.
> - Do **NOT** install any new packages. Everything needed is already installed.
> - Do **NOT** create any API routes, Server Actions, or database schemas.
> - Only modify the files listed above.

---

### Step 1: Update TypeScript Types (`src/types/timesheet.ts`)

**1a.** Add the `NAVIGATE_PERIOD` action to `TimesheetAction`:

```typescript
export type TimesheetAction =
  | { type: 'SET_HOURS'; chargeCodeId: string; dayIndex: number; value: number }
  | { type: 'SET_NOTE'; chargeCodeId: string; dayIndex: number; note: NoteData }
  | { type: 'OPEN_NOTE_MODAL'; chargeCodeId: string; dayIndex: number }
  | { type: 'CLOSE_NOTE_MODAL' }
  | { type: 'NAVIGATE_PERIOD'; direction: 'prev' | 'next' };
```

**1b.** The `TimesheetEntry` interface stays the same, but add a comment noting `hours` length is now variable (matches the number of days in the active period).

---

### Step 2: Update Mock Data to Support Variable-Length Periods (`src/data/mock-timesheet.ts`)

**2a.** Change `MOCK_PERIOD_START` to be the 1st or 16th of a month (not a Monday). Use a fixed date that falls on a semi-monthly boundary:

```typescript
// Semi-monthly period: May 16 – May 31, 2026
export const MOCK_PERIOD_START: Date = dayjs('2026-05-16').toDate();
```

**2b.** Add a utility function to compute the number of days in a semi-monthly period:

```typescript
export function getNumDaysInPeriod(periodStart: Date): number {
  const d = dayjs(periodStart);
  if (d.date() === 1) {
    return 15; // 1st through 15th
  }
  // 16th through end of month
  return d.daysInMonth() - 15;
}
```

**2c.** Add a function to generate mock hours for any period length:

```typescript
export function generateMockEntries(periodStart: Date): TimesheetEntry[] {
  const numDays = getNumDaysInPeriod(periodStart);
  
  // For each charge code, generate hours based on day-of-week
  // Weekdays get hours, weekends get 0
  const patterns: Record<string, number> = {
    'cc-001': 8.0,
    'cc-002': 6.0,
    'cc-003': 2.0,
    'cc-004': 2.0,
    'cc-005': 0.0,
  };

  return MOCK_CHARGE_CODES.map((cc) => {
    const dailyHours = patterns[cc.id] ?? 0;
    const hours: number[] = [];
    for (let i = 0; i < numDays; i++) {
      const date = dayjs(periodStart).add(i, 'day');
      const dow = date.day(); // 0=Sun, 6=Sat
      const isWeekend = dow === 0 || dow === 6;
      // cc-003 gets 0 on Mondays, cc-004 gets hours only on Mondays
      if (cc.id === 'cc-003') {
        hours.push(isWeekend || dow === 1 ? 0 : dailyHours);
      } else if (cc.id === 'cc-004') {
        hours.push(dow === 1 ? dailyHours : 0);
      } else {
        hours.push(isWeekend ? 0 : dailyHours);
      }
    }
    return { chargeCodeId: cc.id, hours };
  });
}
```

**2d.** Replace the existing `MOCK_ENTRIES` export to use this function:

```typescript
export const MOCK_ENTRIES: TimesheetEntry[] = generateMockEntries(MOCK_PERIOD_START);
```

**2e.** Keep `MOCK_CHARGE_CODES` and `REASON_CODES` unchanged.

---

### Step 3: Update the Reducer for Period Navigation (`src/components/timesheet/TimesheetContext.tsx`)

**3a.** Import `dayjs` and the new `generateMockEntries` and `getNumDaysInPeriod` functions from `mock-timesheet.ts`.

**3b.** Add the `NAVIGATE_PERIOD` case to the reducer:

```typescript
case 'NAVIGATE_PERIOD': {
  const current = dayjs(state.periodStart);
  let newStart: dayjs.Dayjs;
  
  if (action.direction === 'next') {
    if (current.date() === 1) {
      // 1st → 16th of same month
      newStart = current.date(16);
    } else {
      // 16th → 1st of next month
      newStart = current.add(1, 'month').date(1);
    }
  } else {
    if (current.date() === 1) {
      // 1st → 16th of previous month
      newStart = current.subtract(1, 'month').date(16);
    } else {
      // 16th → 1st of same month
      newStart = current.date(1);
    }
  }

  const newPeriodStart = newStart.toDate();
  return {
    ...state,
    periodStart: newPeriodStart,
    entries: generateMockEntries(newPeriodStart),
    notes: {}, // clear notes when switching periods (mock behavior)
  };
}
```

**3c.** Update the `initialState` to use `generateMockEntries(MOCK_PERIOD_START)` for `entries` (it should already, but verify).

---

### Step 4: Create the Pay Period Selector (`src/components/timesheet/PayPeriodSelector.tsx`)

Create a **new file**. Mark it `'use client'`.

```typescript
'use client';

import { ActionIcon, Group, Text, Title } from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useTimesheet } from '@/components/timesheet/TimesheetContext';
import { getNumDaysInPeriod } from '@/data/mock-timesheet';

export function PayPeriodSelector() {
  const { state, dispatch } = useTimesheet();
  const { periodStart } = state;

  const start = dayjs(periodStart);
  const numDays = getNumDaysInPeriod(periodStart);
  const end = start.add(numDays - 1, 'day');
  const periodLabel = `${start.format('MMM D')} – ${end.format('MMM D, YYYY')}`;

  return (
    <Group justify="space-between" align="center" mb="md">
      <Group gap="sm" align="center">
        <ActionIcon
          variant="subtle"
          size="lg"
          onClick={() => dispatch({ type: 'NAVIGATE_PERIOD', direction: 'prev' })}
          aria-label="Previous pay period"
        >
          <IconChevronLeft size={20} />
        </ActionIcon>
        <div>
          <Title order={3}>Semi-Monthly Timesheet</Title>
          <Text c="dimmed" size="sm">
            Pay Period: {periodLabel}
          </Text>
        </div>
        <ActionIcon
          variant="subtle"
          size="lg"
          onClick={() => dispatch({ type: 'NAVIGATE_PERIOD', direction: 'next' })}
          aria-label="Next pay period"
        >
          <IconChevronRight size={20} />
        </ActionIcon>
      </Group>
    </Group>
  );
}
```

---

### Step 5: Update BiWeeklyTimesheetClient to Use PayPeriodSelector (`src/components/timesheet/BiWeeklyTimesheetClient.tsx`)

**5a.** Remove the inline `<Title>` and `<Text>` for the period label — the `PayPeriodSelector` component now handles this.

**5b.** Import and render `<PayPeriodSelector />` above the `<Paper>` wrapper.

The updated `TimesheetContent` should look like:

```typescript
function TimesheetContent() {
  return (
    <Container fluid px="md" py="xl">
      <PayPeriodSelector />
      <Paper shadow="xs" p="md" radius="md" style={{ overflowX: 'auto' }}>
        <BiWeeklyTable />
      </Paper>
      <DailyNoteModal />
    </Container>
  );
}
```

**5c.** Remove the `useTimesheet()` call and `dayjs` imports from `TimesheetContent` since it no longer needs them directly.

---

### Step 6: Update BiWeeklyTable for Dynamic Column Count & Header Centering (`src/components/timesheet/BiWeeklyTable.tsx`)

This is the most complex change.

**6a.** Import `getNumDaysInPeriod` from `mock-timesheet.ts`.

**6b.** Replace the hardcoded `WEEKEND_INDICES` constant. Remove it entirely. Weekend detection will now be dynamic:

```typescript
// DELETE this line:
// const WEEKEND_INDICES = new Set([5, 6, 12, 13]);
```

**6c.** Compute `numDays` dynamically:

```typescript
const numDays = getNumDaysInPeriod(periodStart);
```

**6d.** Replace `Array.from({ length: 14 }, ...)` with `Array.from({ length: numDays }, ...)`.

**6e.** Replace the static `WEEKEND_INDICES.has(dayIndex)` check with dynamic weekend detection:

```typescript
const date = dayjs(periodStart).add(dayIndex, 'day');
const dow = date.day();
const isWeekend = dow === 0 || dow === 6;
```

(The `date` variable is already computed above this in the existing code, so just derive `dow` and `isWeekend` from it.)

**6f.** Fix the column header centering issue. The `mantineTableHeadCellProps` at the global level (lines 185-190) already sets `textAlign: 'center'`, but individual day columns override this with their own `mantineTableHeadCellProps` that only sets `backgroundColor`. Add explicit centering to the per-column head cell props:

```typescript
mantineTableHeadCellProps: {
  style: {
    backgroundColor: isWeekend
      ? 'light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-7))'
      : undefined,
    textAlign: 'center' as const,
    verticalAlign: 'middle' as const,
  },
},
```

**6g.** Also ensure the "Charge Code" header is left-aligned (not centered like the day columns). Add to the `chargeCodeCol` definition:

```typescript
mantineTableHeadCellProps: {
  style: {
    textAlign: 'left' as const,
    borderBottom: '2px solid var(--mantine-color-default-border)',
    borderRight: '2px solid var(--mantine-color-default-border)',
    padding: '8px',
  },
},
```

**6h.** Ensure the "Total" column header is centered. Add to `totalCol`:

```typescript
mantineTableHeadCellProps: {
  style: {
    textAlign: 'center' as const,
    borderLeft: '2px solid var(--mantine-color-default-border)',
  },
},
```

**6i.** Add `numDays` (or `periodStart`) to the `useMemo` dependency array for `columns` (it should already have `periodStart` — verify).

---

### Step 7: Update ColumnHeaderDate for Dynamic Weekend Detection (`src/components/timesheet/cells/ColumnHeaderDate.tsx`)

**7a.** Remove the static `WEEKEND_INDICES` set.

**7b.** Detect weekends dynamically using `dayjs`:

```typescript
export function ColumnHeaderDate({ date }: ColumnHeaderDateProps) {
  const d = dayjs(date);
  const isWeekend = d.day() === 0 || d.day() === 6;
  // ... rest stays the same
}
```

**7c.** The `dayIndex` prop is no longer needed for weekend detection. You may keep it in the interface for potential future use, or remove it — architect's preference is to **keep it** for now but not use it for weekend logic.

---

## 4. Verification

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
| **Period label** | Shows "Pay Period: May 16 – May 31, 2026" (or whichever mock start is set) |
| **Column count** | 16 day columns for May 16–31, 15 day columns for May 1–15 |
| **Left arrow click** | Navigates to May 1–15 period; column count changes to 15; mock data regenerates |
| **Right arrow click** | Navigates to Jun 1–15 period; column count changes to 15; mock data regenerates |
| **Multiple navigations** | Click right 3 times → should show Jun 16–30 (15 cols), Jul 1–15 (15 cols), Jul 16–31 (16 cols) |
| **February edge case** | Navigate to Feb 2026: Feb 1–15 = 15 cols, Feb 16–28 = 13 cols |
| **Weekend shading** | Weekend columns dynamically shaded regardless of which day-of-week the period starts on |
| **Column headers centered** | All day headers (Mon/May 18, etc.) are horizontally centered over their data cells |
| **Charge Code header** | "Charge Code" header is left-aligned, not centered |
| **Total header** | "Total" header is centered |
| **Daily totals footer** | Footer row adjusts to show correct number of daily totals |
| **Grand total** | Bottom-right grand total recalculates when period changes |
| **No hydration errors** | No React hydration mismatch warnings in the console |

### 4c. Semi-Monthly Period Math Verification

| Period Start | Period End | # Days | # Columns |
|---|---|---|---|
| Jan 1 | Jan 15 | 15 | 15 |
| Jan 16 | Jan 31 | 16 | 16 |
| Feb 1 | Feb 15 | 15 | 15 |
| Feb 16 | Feb 28 | 13 | 13 |
| Mar 1 | Mar 15 | 15 | 15 |
| Mar 16 | Mar 31 | 16 | 16 |
| Apr 16 | Apr 30 | 15 | 15 |

### 4d. Common Errors to Watch For

| Error | Root Cause | Fix |
|---|---|---|
| `hours[dayIndex]` is `undefined` | Mock data array length doesn't match `numDays` | Ensure `generateMockEntries` uses `getNumDaysInPeriod` |
| Footer totals show `NaN` | Accessing beyond array bounds after period change | All `reduce()` calls must use the entry's actual `hours.length` |
| Column pinning breaks | MRT can't pin if column IDs change | Column IDs (`day-0`, `day-1`...) are index-based and always start at 0 — this should be fine |
| `TypeError: Cannot read properties of undefined` | Missing `chargeCode` after period change | The `chargeCodes` array doesn't change — only `entries` does. This should not happen |

---