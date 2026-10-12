# Blueprint: App-Wide UI Consistency Pass (Tables, Color, Formatting, Patterns)

> **Role for the executing developer: Senior front-end / design-systems engineer.** The app works;
> it doesn't yet *feel* like one product. Every screen was built separately, so tables, colors,
> dates, row actions, and page headers each drift a little. This pass replaces that drift with a
> small set of shared building blocks and applies them everywhere. **Visual/UX only — no server,
> schema, or business-logic changes.**

## 1. Findings (already diagnosed — fix, don't re-investigate)

**F1 — Root cause of the "big, blue, clunky" sort buttons: the MRT stylesheet is never imported.**
`mantine-react-table` v2 ships `mantine-react-table/styles.css` (≈40 KB). It is imported nowhere, so
MRT's sort/column-action icons render as raw Mantine `ActionIcon`s. The shipped CSS makes the sort
icon `--ai-size-xs`, transparent, neutral (`--mantine-color-bright`), and switches to the brand
color **only when the column is actively sorted** (`[data-sorted]`). Everything else is a workaround
that grew around this missing import:
- **11 copy-pasted `*.module.css` files** with a `.tableHeaderCell` hack, in **3 different variants**
  (`button { all: unset }`; an ActionIcon override hardcoding `--mantine-color-blue-7`; and one with a
  typo, `--mantine-color-blud-7`, in `Approvals.module.css`).
- **`[class*="MRT_…"] … !important` overrides** in `src/app/globals.css` trying to resize icons.
- **54 inline `padding: '12px 16px'`** style blocks re-declared across the 10 MRT tables, which share
  no common configuration.

**F2 — Off-palette colors.** The theme (`src/theme.ts`) defines `signal` (primary), `ink`, `success`,
`warning`. Components still hardcode Mantine defaults: `color="red"`×36, `"green"`×35, `"blue"`×25,
`"orange"`×16, `"gray"`×11, `"yellow"`×9, plus one-offs (`violet`, `teal`, `indigo`, `grape`).
Mantine `blue` ≠ brand `signal`, so blue badges/buttons visibly clash with primary buttons.
Notifications use `'green'`/`'yellow'`/`'red'`.

**F3 — Inconsistent dates.** 7 `toLocaleDateString()/toLocaleString()` calls (locale-dependent —
e.g. Assignments shows `9/11/2026` while Audit Trail shows `Jun 12, 2026`), plus 8 different dayjs
display formats.

**F4 — Inconsistent row actions.** Some tables use text `Button`s ("Deactivate"), others `ActionIcon`s,
some mix both. 2 destructive actions use the browser's native `confirm()` (QBO + Gusto disconnect).

**F5 — Inconsistent page headers.** Page titles use `<Title order={2}>` with `mb="md"`, `mb="lg"`, or
no margin; there's no shared header with description/actions. 13 `Badge`s have no variant (filled),
55 use `light`.

**F6 — Next.js dev overlay shows "1 Issue"** on every page (visible in recent screenshots). Unknown
cause — find and fix it (likely a hydration or console error).

## 2. Design Decisions (locked)

| Concern | Standard |
|---|---|
| Tables | One shared MRT defaults helper; MRT stylesheet imported once; no per-page header CSS |
| Primary / informational | `signal` |
| Success / active / approved / cleared | `success` |
| Warning / pending / late / needs reason | `warning` |
| Destructive / error / rejected | `red` (Mantine red — keep as the danger color) |
| Neutral / inactive / draft | `gray` |
| Badges | `variant="light"` by default (theme-level) |
| Display dates | `MMM D, YYYY`; date-time `MMM D, YYYY h:mm A`; short `MMM D` — via shared helpers only |
| Row actions | Icon-only `ActionIcon variant="subtle"` + `Tooltip`; destructive = `color="red"`. Text buttons only for primary workflow verbs (e.g. Approve/Reject in Approvals) |
| Destructive confirmation | Shared in-app confirm modal — never native `confirm()` |
| Page header | Shared `PageHeader` (title + optional description + optional right-aligned actions) |

## 3. File Topology

```
CREATE:
├── src/components/table/mrtDefaults.ts        ← shared MRT options + helper (Phase 1)
├── src/lib/ui/status-colors.ts                ← single source for role/status/period → color (Phase 2)
├── src/lib/format.ts                          ← formatDate / formatDateTime / formatShortDate (Phase 3)
├── src/components/ui/ConfirmModal.tsx         ← reusable destructive-confirm (Phase 4)
└── src/components/ui/PageHeader.tsx           ← shared page header (Phase 5)

MODIFY:
├── src/app/layout.tsx                         ← import 'mantine-react-table/styles.css'
├── src/app/globals.css                        ← delete MRT [class*=…] !important hacks made redundant
├── src/theme.ts                               ← component defaultProps only (Badge, Tooltip, Modal) — NO palette changes
├── all 10 tables using useMantineReactTable   ← adopt mrtDefaults; drop inline header/body padding + tableHeaderCell
├── all (app) *Client.tsx pages                ← colors, dates, row actions, PageHeader
└── QBOConfigClient.tsx / GustoConfigClient.tsx← native confirm() → ConfirmModal

DELETE (after migration; confirm nothing imports them):
└── the .tableHeaderCell rules in the 11 *.module.css files (delete the file if it becomes empty):
    assignments, contracts, api-keys, dashboard, labor-categories, indirect-codes,
    audit-trail (keep its dark-mode correction-row rule), approvals, users, import, reports

DO NOT MODIFY:
├── src/server/**, src/db/**, src/lib/** (except the new src/lib/format.ts + src/lib/ui/)
├── theme palette values in src/theme.ts (brand is locked)
├── src/components/timesheet/BiWeeklyTable.tsx layout (fit-to-width grid) — only its `c="blue"` → `c="signal"`
└── navbar collapse/cookie logic in AppShellWrapper / (app)/layout.tsx
```

## 4. Step-by-Step

> **⚠️ GUARDRAILS**
> - Next.js 16 + Mantine v9 + MRT v2 — confirm APIs in `node_modules` (`mantine-react-table/dist/index.esm.d.mts`
>   for option types) before relying on them. Read `AGENTS.md`.
> - **Preserve all behavior:** every table still sorts, filters, paginates, searches, and fires its
>   row actions/drawers/modals exactly as today. Audit-trail Rev# history drawer, Contracts/Approvals
>   drawers, Assignments tabs, and the approve/reject flow must keep working.
> - **No page-level horizontal bleed regressions** at 100% zoom with the navbar open (keep the
>   responsive container + `layoutMode: 'semantic'` behavior from the last polish pass).
> - Verify **light and dark** mode after each phase.
> - `npm run build`, `npm run test`, `npm run lint` pass; no NEW lint warnings.

### Phase 1 — Tables (the headline fix)
**1.1** In `src/app/layout.tsx`, import MRT's stylesheet **after** the Mantine imports and before
`./globals.css`:
```ts
import "@mantine/core/styles.css";
import "@mantine/dates/styles.css";
import "@mantine/notifications/styles.css";
import "mantine-react-table/styles.css";
import "./globals.css";
```
**1.2** Create `src/components/table/mrtDefaults.ts` exporting a helper every table uses. Shape:
```ts
import type { MRT_RowData, MRT_TableOptions } from 'mantine-react-table';
import { useMantineReactTable } from 'mantine-react-table';

/** Shared CadenzPoint table defaults. Per-table options override these (shallow merge;
 *  nested *Props objects should be merged, not replaced, if a table customizes them). */
export function useAppTable<T extends MRT_RowData>(options: MRT_TableOptions<T>) {
  return useMantineReactTable<T>({
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
    ...options,
  });
}
```
Use MRT's built-in density/spacing (from its stylesheet) instead of inline padding. If cells feel
too tight, set one value here (e.g. `mantineTableBodyCellProps: { py: 'sm' }`) — never per table.

**1.3** Migrate all 10 tables (`grep -rl useMantineReactTable src`) to `useAppTable`. Remove from each:
`mantineTableHeadCellProps` padding/className, `mantineTableBodyCellProps` padding,
`mantineTopToolbarProps` padding, and any option now provided by the defaults. Keep table-specific
options (columns, data, row actions, initialState, columnVisibility, state, row props such as the
audit trail's correction-row highlight).

**1.4** Delete the `.tableHeaderCell` rules from the 11 CSS modules (and the file + its import if it
becomes empty). Keep `AuditTrail.module.css`'s dark-mode `tr[data-correction]` rule.

**1.5** In `globals.css`, delete the `[class*="MRT_…"] !important` icon/toolbar overrides that the
MRT stylesheet now handles. Remove one at a time and check visually; keep only rules that still
earn their place (comment why).

**Acceptance for Phase 1:** sort icons are small and neutral, and only the actively-sorted column's
icon is brand-colored; header text and icon sit on one line; all tables share identical spacing,
striping, toolbar, and empty-state text.

### Phase 2 — Semantic color
**2.1** Create `src/lib/ui/status-colors.ts` with typed maps, e.g.:
```ts
export const ROLE_COLOR = { admin: 'signal', supervisor: 'warning', employee: 'gray' } as const;
export const PERIOD_STATUS_COLOR = { draft: 'gray', submitted: 'signal', approved: 'success', rejected: 'red' } as const;
export const RECORD_STATUS_COLOR = { active: 'success', inactive: 'gray', closed: 'gray' } as const;
```
Use these for every role/status badge instead of inline color strings.

**2.2** Replace hardcoded colors per the §2 table: `blue`→`signal`, `green`→`success`,
`orange`/`yellow`→`warning`, one-offs (`violet`/`teal`/`indigo`/`grape`) → the semantic color that
matches their meaning (most are category/role badges → `gray` or `signal`). Keep `red` for
destructive/error. Notifications: `'green'`→`'success'`, `'yellow'`→`'warning'`. Timesheet grand
total `c="blue"` → `c="signal"`.

**2.3** In `src/theme.ts` `components`, add defaults only:
`Badge: { defaultProps: { variant: 'light' } }`, `Tooltip: { defaultProps: { withArrow: true, openDelay: 300 } }`,
`Modal: { defaultProps: { centered: true, radius: 'md' } }`. Do not change palette values.

### Phase 3 — Dates
Create `src/lib/format.ts`:
```ts
import dayjs from 'dayjs';
export const formatDate = (d: Date | string | null | undefined) => (d ? dayjs(d).format('MMM D, YYYY') : '—');
export const formatDateTime = (d: Date | string | null | undefined) => (d ? dayjs(d).format('MMM D, YYYY h:mm A') : '—');
export const formatShortDate = (d: Date | string | null | undefined) => (d ? dayjs(d).format('MMM D') : '—');
```
Replace all 7 `toLocale*String` calls and the display uses of the dayjs formats in `(app)` pages with
these helpers. **Leave `'YYYY-MM-DD'`** where it's a data/URL/API value (not display), and leave the
timesheet grid's compact column headers alone.

### Phase 4 — Row actions & confirmations
**4.1** Create `src/components/ui/ConfirmModal.tsx` — a small controlled Mantine `Modal` with title,
message, Cancel, and a red confirm button with loading state (or a `useConfirm()` hook returning a
promise). No new npm dependency.
**4.2** Replace the 2 native `confirm()` calls (QBO + Gusto disconnect) with it.
**4.3** Standardize table row actions to icon-only `ActionIcon variant="subtle"` + `Tooltip`
(e.g. edit = `IconPencil`, deactivate = `IconBan`/`IconUserOff`, history = `IconHistory`),
destructive = `color="red"`. Apply to assignments (both tabs), charge-codes, labor-categories,
indirect-codes. Approvals keeps its text Approve/Reject buttons (workflow verbs).
**4.4** Destructive row actions (deactivate/disconnect) open `ConfirmModal` first.

### Phase 5 — Page headers & layout rhythm
Create `src/components/ui/PageHeader.tsx`:
```tsx
type Props = { title: string; description?: string; actions?: React.ReactNode };
// <Group justify="space-between" align="flex-end" mb="lg"> Title order={2} + dimmed description | actions </Group>
```
Use it as the top of every `(app)` page (replace the bare `<Title order={2} …>`). Move each page's
primary action (e.g. "New Charge Code", "Auto-generate from CLINs") into `actions`. Section headings
inside pages use `Title order={4}`; keep vertical rhythm consistent (`mb="lg"` between sections).

### Phase 6 — Clean up the "1 Issue" dev overlay
Run `npm run dev`, open the overlay, identify the error (likely hydration mismatch or a console
error), fix the root cause, and confirm the overlay is gone on every `(app)` route. Report what it was.

## 5. Verification

### 5a. Build & static gates
```bash
npm run build && npm run lint && npm run test
grep -rn "mantine-react-table/styles.css" src/app/layout.tsx          # exactly 1 hit
grep -rln "tableHeaderCell" src                                          # no hits
grep -rnE 'color="(blue|green|orange|yellow|violet|teal|indigo|grape)"' src/app src/components   # no hits
grep -rn "toLocaleDateString\|toLocaleString()" src/app src/components  # no hits
grep -rnE "[^a-zA-Z]confirm\(" src/app src/components                   # no hits
grep -rln "useMantineReactTable" src/app                                 # no hits (only mrtDefaults.ts uses it)
```

### 5b. Visual matrix (light AND dark, 100% zoom, navbar open)
| Route | Check |
|---|---|
| Every MRT table (dashboard, contracts, charge-codes, assignments ×2 tabs, approvals, labor-categories, audit-trail, users, indirect-codes, api-keys) | small neutral sort icons; sorted column icon is brand-colored; identical spacing/striping; no page bleed |
| Badges everywhere | light variant; roles/statuses use the shared color map |
| Dates everywhere | `MMM D, YYYY` style; no `9/11/2026` style |
| Row actions | icon + tooltip; destructive asks for confirmation in-app |
| Page tops | consistent PageHeader with description; primary action top-right |
| Any page | no "1 Issue" dev overlay |

### 5c. Functional regression
Sort/filter/paginate/search on every table; audit-trail history drawer; Contracts + Approvals
drawers; approve/reject; Assignments tabs (assign, assign-all-under-CLIN, deactivate); QBO/Gusto
disconnect (now via modal); timesheet entry + save.

### 5d. Common errors
| Symptom | Cause | Fix |
|---|---|---|
| Sort icons still large/blue | stylesheet imported in the wrong place, or leftover `.tableHeaderCell` hack | import once in root layout after Mantine CSS; delete the hacks |
| Table options silently lost | defaults spread *after* table options, or nested `*Props` replaced | spread `...options` last; merge nested prop objects |
| Color prop renders gray | used a color not in the theme (`signal`/`ink`/`success`/`warning` + Mantine built-ins only) | use the §2 mapping |
| Dark-mode text unreadable on audit correction rows | removed the AuditTrail dark-mode rule | keep that rule |

## 6. Definition of Done
One table system, one color vocabulary, one date format, one row-action pattern, one page header,
and no dev-overlay errors — consistent across every route in both color schemes, with zero
behavior regressions.
