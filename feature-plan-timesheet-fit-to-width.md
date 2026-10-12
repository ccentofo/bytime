# Blueprint: Fit-to-Width Timesheet Grid — Whole Pay Period, Zero Horizontal Scroll

> **Role for the executing developer: Senior UX/UI engineer.** This is a design-led task. You own
> the visual and interaction quality, not just the mechanics. The acceptance bar is a polished,
> legible grid that fits any pay period on one screen — treat the density rules below as the
> framework and use your judgment on exact spacing/typography to make it feel premium.

## 1. Product & UX Overview

### The goal
The timesheet grid must **always fit the full pay period within the viewport — no horizontal
scrollbar — for every interval: weekly (7), biweekly (14), semi-monthly (15–16), and monthly
(28–31 days)**, on standard desktop/tablet widths. The whole period is visible at a glance.

This is a deliberate competitive differentiator. The incumbents we displace (Deltek Costpoint
T&E, Unanet, Hour Timesheet) all force horizontal scrolling on longer periods. "See your entire
month at once" is a feature, not a nicety — make it feel effortless.

### Current state (what to replace)
`src/components/timesheet/BiWeeklyTable.tsx` renders a `MantineReactTable` with **fixed pixel
column widths** (Charge Code 260, each day 72, Total 80) and `tableLayout: 'fixed'`. The total
width therefore grows with the number of days and overflows the viewport (a recent change made
MRT's container scroll horizontally — **that scroll approach is being abandoned in favor of
fit-to-width and should be removed**).

### The core idea
Stop sizing columns in fixed pixels. The table is **always 100% of its container**; the
**Charge Code** and **Total** columns take a constrained share, and the **day columns divide the
remaining width equally** (`minmax(0, 1fr)`-style). As the day count rises, day cells get
narrower — so the grid adapts its **density** (typography, header verbosity, indicators) to stay
clean and legible instead of overflowing.

### Density tiers (the heart of the UX work)
Derive a density from the number of day columns (or, better, the computed per-day pixel width) and
adjust the rendering. These are guidelines — tune to taste:

| Tier | When | Day header | Hours cell | "Late" indicator | Charge Code col |
|---|---|---|---|---|---|
| **Comfortable** | ≤14 cols (weekly/biweekly) | `Mon` / `Jun 1` | normal font, "8.00" | orange **"Late"** badge | full (≈240px), code + title + desc |
| **Compact** | 15–16 cols (semi-monthly) | `Mon` / `Jun 1`, slightly smaller | smaller font | "Late" badge (may abbreviate) | full, desc may truncate |
| **Dense** | ≥17 cols (monthly) | weekday initial `M` + day number `1`; drop the month | ~10–11px, integers plain ("8"), fractions compact ("8.5"); no number-spinner | small orange **dot** with tooltip "Late entry" (no text) | narrower (≈170–190px), title + truncated desc with tooltip |

Hard legibility floor: never render text below ~10px. Weekend shading, today's highlight, and the
editable/locked states must remain visually clear at every tier.

### Scope / responsive boundary
- **Desktop & tablet (≈≥1024px): the no-scroll requirement is absolute** for all four intervals.
- **Phones (<≈768px):** 31 columns cannot be legible on a phone. The full-fit requirement does NOT
  apply here — a phone needs a different layout (e.g., one-day-at-a-time, or a vertical day list).
  That mobile layout is **out of scope for this blueprint** (call it out as a follow-up); just make
  sure the desktop grid degrades to a horizontal scroll *only* below the tablet breakpoint rather
  than breaking. Everything ≥1024px must fit.

---

## 2. Technical Direction

You have two viable implementations. **Recommended: a purpose-built CSS layout** — MantineReactTable's
pixel-based column model fights "fill exactly 100% and divide the rest," and once the table always
fits, **column pinning and the scroll container become unnecessary** (pinning only exists to keep
columns visible during scroll). Removing MRT here simplifies the component and gives you total
control over density. Reuse the existing cell components — this is a re-shell, not a rewrite.

**Recommended approach — CSS Grid (or `table-layout: fixed; width: 100%`):**
- A CSS grid with columns: `grid-template-columns: var(--cc-width) repeat(N, minmax(0, 1fr)) var(--total-width);`
  The `minmax(0, 1fr)` is the key — it lets day columns shrink **below content width** and share
  the remaining space equally, guaranteeing the row total never exceeds 100%.
- Or a semantic `<table style="table-layout:fixed; width:100%">` with a `<colgroup>` that fixes only
  the Charge Code and Total widths and leaves day columns to divide the remainder. (Use whichever
  gives you the cleanest sticky header + footer; grid usually wins for this.)
- Drive density from the **measured container width** (e.g. a `useElementSize`/`ResizeObserver` hook)
  divided by the column count, OR simply from `numDays`. Measured width is more robust across navbar
  collapse and window resizes.
- **Remove**: the fixed `size: 72` day columns, `tableLayout:'fixed'` fixed-pixel sizing, the
  `mantineTableContainerProps` horizontal scroll, the `columnPinning` config, and the outer Paper's
  scroll handling. No element in the timesheet should produce a horizontal scrollbar at ≥1024px.

**Alternative (keep MRT):** only if you can make MRT reliably fill 100% and divide remaining width
(via `layoutMode`, `grow`, and computed sizes) AND drop pinning/scroll. If you find yourself fighting
MRT's sizing, switch to the CSS approach — do not reintroduce horizontal scroll to make MRT behave.

Either way, **preserve all existing behavior**: editable vs locked cells (period status), weekend
shading, today highlight, daily totals footer, grand total, the dirty/late/edit flows, and the
existing cell components (`HourCell`, `ChargeCodeCell`, `TotalHoursCell`, `ColumnHeaderDate`).

---

## 3. File Topology

```
Files to MODIFY:
├── src/components/timesheet/BiWeeklyTable.tsx          ← Replace fixed-width MRT layout with fit-to-width grid; remove pinning/scroll
├── src/components/timesheet/cells/ColumnHeaderDate.tsx ← Density-aware header (full → weekday-initial+day → dot for Late)
├── src/components/timesheet/cells/HourCell.tsx         ← Density-aware cell typography/padding; compact number formatting
├── src/components/timesheet/cells/ChargeCodeCell.tsx   ← Density-aware width/truncation (tooltip on truncate)
├── src/components/timesheet/cells/TotalHoursCell.tsx   ← Compact formatting at dense tier
├── src/components/timesheet/BiWeeklyTimesheetClient.tsx← Remove the table scroll container styling (no longer needed)
├── (optional) src/components/timesheet/Timesheet.module.css ← Grid/density CSS if you prefer CSS modules over inline

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/components/timesheet/TimesheetContext.tsx       ← Data/state unchanged
├── src/server/actions/**                               ← No server changes
├── src/lib/date-utils.ts                               ← getNumDaysInPeriod stays the source of column count
```

> A density value (tier or measured per-day width) needs to reach the cell components. Thread it via
> props from `BiWeeklyTable` (cleanest) or a small React context local to the grid. Don't put it in
> the global timesheet state.

---

## 4. Step-by-Step

> **⚠️ GUARDRAILS:**
> - Read the Next.js 16 / Mantine v9 docs in `node_modules` before relying on component APIs.
> - **No horizontal scrollbar may appear at ≥1024px for any interval.** That's the pass/fail line.
> - Reuse existing cell components and all behavior (locked/editable, totals, weekend/today, late/edit flows).
> - Don't regress dark mode, and keep the legibility floor (~10px text).
> - `npm run build` and the existing tests must pass.

**Step 1 — Column model.** In `BiWeeklyTable.tsx`, replace the fixed-pixel MRT columns with a
fit-to-width layout (CSS grid recommended): `grid-template-columns: <cc> repeat(numDays, minmax(0,1fr)) <total>`,
where `numDays = getNumDaysInPeriod(periodStart, state.periodConfig)`. Remove `columnPinning`,
the fixed `size:72`, and any horizontal-scroll/overflow. Keep header row, body rows (one per charge
code), the daily-totals footer row, and the grand-total cell.

**Step 2 — Density signal.** Measure the grid container width with a `ResizeObserver`/`useElementSize`
and compute `perDayPx = (containerWidth - ccWidth - totalWidth) / numDays`. Derive `density:
'comfortable' | 'compact' | 'dense'` from `perDayPx` (preferred) or `numDays`. Recompute on resize and
on period change.

**Step 3 — Density-aware headers.** Update `ColumnHeaderDate` to accept `density`. Comfortable/compact:
`Mon` + `Jun 1`. Dense: weekday initial (`M`) + day number (`1`), drop the month; render the "Late"
state as a small orange dot with an accessible tooltip/`aria-label` instead of the text badge.
Preserve weekend dimming and today's highlight at all tiers.

**Step 4 — Density-aware cells.** Update `HourCell`/`TotalHoursCell` for compact typography and padding
at higher density, and compact number formatting (integers as `8`, fractions as `8.5`/`8.25`; avoid
trailing `.00` in dense tier). Ensure the editable input fills the cell, is center-aligned, has no
number-spinner, and remains a comfortable tap/click target. Keep locked-state rendering for
submitted/approved periods.

**Step 5 — Charge Code column.** Make `ChargeCodeCell`/the column width density-aware: full width with
code + title + description at comfortable; narrower with truncated description (tooltip) at dense. Keep
the indirect/CLIN badges legible.

**Step 6 — Remove scroll.** In `BiWeeklyTimesheetClient.tsx`, drop the table scroll container styling
(the `Paper` can keep shadow/padding but must not scroll). Verify nothing in the chain creates a
horizontal scrollbar (`document.documentElement.scrollWidth === clientWidth` on the timesheet route).

**Step 7 — Mobile guard.** Below the tablet breakpoint, allow the grid to scroll (or apply a simple
stacked fallback) rather than crushing 31 columns onto a phone. Note the full mobile layout as a
follow-up; do not block this blueprint on it.

---

## 5. Verification

### 5a. Build & tests
```bash
npm run build        # zero errors
npm run test         # unit tests pass
```

### 5b. The fit matrix (the core acceptance check)
For each period interval, at several desktop/tablet widths, confirm **no horizontal scrollbar** and a
legible, aligned grid. Use `LOCAL-MULTITENANT-TESTING.md` to set the pay period (Admin → settings) or
seed data; the blank `bytoa` tenant is fine for column-fit (headers render even with no rows).

| Interval | Day cols | 1280px | 1440px | 1024px (tablet) |
|---|---|---|---|---|
| Weekly | 7 | fits, roomy | fits | fits |
| Biweekly | 14 | fits | fits | fits |
| Semi-monthly | 15–16 | fits | fits | fits (compact) |
| Monthly | 28–31 | fits (dense, legible) | fits | fits (dense) |

For each cell of the matrix, verify in DevTools: `document.documentElement.scrollWidth` equals
`clientWidth` (no page-level horizontal scroll) and the timesheet container has no `overflow-x` scrollbar.

### 5c. Behavior & polish regression
| Check | Expected |
|---|---|
| Weekend shading + today highlight | Visible at every density |
| Daily totals + grand total | Correct, aligned, visible (Total never clipped) |
| Editable vs locked period | Draft/rejected editable; submitted/approved read-only |
| Enter hours, save, late/edit reason flow | Works at dense tier (input usable) |
| "Late" indicator | Badge at comfortable, dot+tooltip at dense |
| Dark mode | Correct at all tiers |
| Charge code truncation | Tooltip reveals full text |
| Window resize / navbar collapse | Re-fits live, no scrollbar appears |

### 5d. Common errors to watch for
| Symptom | Cause | Fix |
|---|---|---|
| Horizontal scrollbar reappears on monthly | day columns have an implicit min-width | use `minmax(0, 1fr)` (the `0` min is essential) |
| Columns overflow by a few px | borders/padding counted outside the fr math | `box-sizing: border-box`; account for border widths in the fixed col sizes |
| Text clipped/overlapping at dense | font/padding not reduced | apply the density tier to typography + padding |
| Pinned-column artifacts | leftover `columnPinning`/sticky CSS | remove pinning entirely — not needed without scroll |
| Total column squished | Total sharing `1fr` with days | give Total a fixed/min width outside the `1fr` repeat |
| Numbers jump width as you type | variable-width formatting | use tabular figures (`font-variant-numeric: tabular-nums`) |
```
