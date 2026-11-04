# Blueprint UX-4b Part 1: shared kit + Contracts, Labor categories, Unpriced hours, Reports

> **Status:** v3 FINAL, 2026-11-03, lead architect. Pre-mortem rounds 1 and 2 are applied (§13). The two-round limit is reached; the code audit catches the rest.
>
> **Branch:** `ux-kit-contracts`, cut from `main`.
>
> **Approved design:** `ux-mockups/ux4-batch1.html`, screens Contracts, Reports, Labor categories and Unpriced hours (product owner, 2026-10-31 and 2026-11-03). **Match it**, except where §0 says otherwise.
>
> **Sources:**
> - `UX-4-AUDIT.md` §3, §4 and §8;
> - three lead-commissioned research passes;
> - two pre-mortem reviews (2026-11-03).
>
> **Part 2** (Approvals, Payroll export, demo seed) is a separate blueprint and uses this kit.

---

## 0. Lead rulings (no product decisions)
| # | Ruling |
|---|---|
| K1 | **Kit scope.** The kit is built here and used by the Part 1 pages. Every kit option on shared components is **opt-in**; undefined means today's behaviour, so the 12 existing `useAppTable` tables are unchanged. Three central changes apply app-wide on purpose: persistent error toasts (through `runAction`), the date display and parse format (DateInput and DatePickerInput theme defaults), and `WriteButton` never using `disabled`. |
| K2 | **Returned is amber.** "Returned" uses the warning tone everywhere through the new status map. The stored value stays `rejected`. |
| C1 | **One Contracts page.** Overview (`/admin/dashboard`) merges into `/admin/contracts`, and the old URL redirects (307). The nav keeps the leaf label "Contracts and CLINs" inside the "Contracts" group. The h1 is "Contracts and CLINs". The Overview's `ApprovalNotices` aren't carried over (Home already shows the self-approval item). |
| C2 | **Summary strip:** money and counts cover **active** contracts. The unpriced notice counts **all** contracts (Home's figure). The table has **no footer totals** (the strip is the summary). |
| C3 | **Close and reopen a contract** from its ⋯ menu, each with a confirm. Closed and inactive already behave the same in every rule (each check is `=== 'active'`). |
| C4 | **SLINs are subsets of their CLIN.** The UI never adds SLINs into a CLIN or a contract. |
| C5 | **Cost rounding:** reuse `clinCostTotals` (cents per CLIN) and `sumRounded`, so Contracts and Home agree to the cent. |
| C6 | **No new money rules.** There's no "funded ≤ ceiling" check (the server doesn't enforce one; that would be a business rule). Only end date ≥ start date is checked, inline, because the server already requires valid dates. |
| R1 | **Reports page.** The leaf and h1 are both "Downloads". The Unpriced hours report lives at `/admin/reports/unpriced`, with the breadcrumb "Downloads › Unpriced hours". |
| R2 | **Removed from the design (no backend):** the Contract costs PDF and signed timesheets for "Everyone". |
| R3 | **"Cost by pay period"** is a new Excel download replacing the Overview's on-screen period cost report: one row per pay period × contract, the last N **completed** periods (default 6). |
| R4 | **Empty downloads:** when a report's total hours are 0, routes return **422** `{ error }` and `downloadFile` shows it in place. The reports aren't limited to approved hours (no behaviour change), so the wording never says "approved". |
| R5 | **Hours summary copy matches what it does:** direct time only, because it inner-joins CLINs. "Total hours per employee by contract and CLIN (direct time only)." |
| U1 | **Unpriced hours** are grouped by reason × employee × location, where location follows the cost basis's **level**. Overlapping pairs attach to conflict groups by level. **Pairs with no affected hours are listed in their own section,** so Home's overlap alert always leads somewhere actionable. |
| L1 | **Labor-category assignments** move to People → Assignments as a third tab, "Labor categories". The Rate column is kept, computed on the server for **every** category. |

## 1. Verified current state
Line numbers are from `main` at `4333674`.

### 1.1 Kit pieces
| Piece | Today |
|---|---|
| Status words | Three maps disagree: `lib/timesheet/labels.ts:7`, `home/HomeClient.tsx:13`, `timesheet/history/PastTimesheetsClient.tsx:22-26`. Colours: `lib/ui/status-colors.ts:14` (rejected red), `:21`. Raw lowercase badges at contracts `:333, :571, :663`, labor categories `:438` and dashboard `:177`. Active/Inactive is hand-built in 8 places. |
| Page header | `components/ui/PageHeader.tsx:4-15`. `description` renders inside `<Text>` (a `<p>`, `:23`). `ApprovalNotices` renders above the h1 from `page.tsx` (dashboard `:20`, users `:17`, approvals `:26`). |
| Money and hours | `lib/format.ts` has dates only. Local money formatters: `HomeClient.tsx:14`, `DashboardClient.tsx:38,42`, `ContractsClient.tsx:354,568,659`, `LaborCategoriesClient.tsx:154`, `RateScheduleModal.tsx:24`. Tabular figures are already global (`globals.css:54-60`). |
| Tables | `components/table/mrtDefaults.tsx:34-64` (deepMerge: arrays and functions **replace**, `:26-27`). MRT beta.9: `enableExpanding` is needed for `getExpandedRowModel` (`index.esm.mjs:2880`). The `mrt-row-expand` column **always** renders with it (`showRowExpandColumn`, `:1195-1199`; `positionExpandColumn` only `'first' \| 'last'`, `:1214-1229`). That column's button has no `aria-expanded`, a fixed "Expand" label, and `disabled` on leaves (`:745-750`). Header content is aligned by `justify-content: var(--mrt-cell-align)` (`styles.css:282,609`). TanStack `filterFromLeafRows` keeps only *matching* children of a matching parent (`table-core filterRowsUtils.js:38-52`). `renderEmptyRowsFallback` also renders for an empty search. |
| Busy state | One shared `isPending` per page. `useBusyRows` in `components/ui/useRowState.ts:17-24`. ReportsClient `busyProps(card, button)` (`:63-93`). `WriteButton` (`components/shell/WorkspaceMode.tsx:36-46`, about 45 JSX call sites in 17 files, none inside a `<form>`/`onSubmit`) uses `disabled` in read-only mode. |
| Error toasts | `app/providers.tsx:14` `autoClose={4000}`; `lib/run-action.ts:33-36` red toast. 21 direct red toasts in 11 files. |
| Dates | Mantine DateInput defaults to "MMMM D, YYYY" (`@mantine/dates DateInput.mjs:18`) and parses on every keystroke (`:72-83`). Overrides to `YYYY-MM-DD` at `ChargeCodeCategoryModal.tsx:138` and `RateScheduleModal.tsx:145`. DatePickerInput is used at `PayrollExportClient.tsx:159` and `PayScheduleClient.tsx:250`. dayjs loads only utc/timezone (`lib/calendar-date.ts:5-6`) and relativeTime, **not `customParseFormat`**. |
| Money inputs | TextInputs with "($)" labels (`ContractsClient.tsx:442,448,507,612`; `LaborCategoriesClient.tsx:587,594`; `RateScheduleModal.tsx:148-149`). The server uses `validateMonetaryValue` (`parseFloat`, max 999,999,999.99) and `validateRate` (max 9,999.99) (`lib/validation.ts:94-123`). Mantine 9.3.1 NumberInput **defaults `allowedDecimalSeparators: ['.', ',']`** (`NumberInput.mjs:~80`); react-number-format turns a single typed `,` into the decimal (`:931-934`); the paste handler replaces every `,` with `.` (`:266-287`). It emits a number or a string (`:63-64, 157`); `onValueChange` gives `values.value` plus `source`. |
| Period presets | `getPeriodOptions` (`actions/periods.ts:70`, ≤ 60 each way) throws. `loadScheduleResolver` (`internal/pay-period-config.ts:54`). Reports asks for 11 back (`ReportsClient.tsx:103`). |
| Download | `lib/download.ts` (`downloadFile`, `downloadErrorMessage` with 404 "That employee wasn't found.", `filenameFromDisposition`). |

### 1.2 Pages
| Page | Today |
|---|---|
| **Overview** | `admin/dashboard/page.tsx:12-23`. `getContractSummaries` (`actions/dashboard.ts:94-286`, `requireAdmin`): 7 queries, including SLIN priced cost and unpriced via `COST_BASIS_LATERAL`. Totals cover all contracts. `getPeriodCostReport` (`:299-377`) is on screen only. Burn helpers: `lib/ui/burn.ts:26-46`. No importers outside the dashboard and tests. |
| **Contracts** | `ContractsClient.tsx` (711 lines): modal (no status), drawer, lazy loads, Deactivate/Activate. CLIN and SLIN number, description and funding can't be edited. `create/updateContract` (`contracts.ts:30,58`): status not runtime-validated; `updateContract` neither validates its id nor reports a missing row (`:86`). `create/updateClin` (`clins.ts:16,36`) and `create/updateSlin` (`slins.ts:16,36`) don't validate the parent or check it's active. |
| **Labor categories** | `page.tsx:24-50`: 8 loads, including the unpriced report (≤ 500) and overlaps. Client (719 lines): a flat table, the Add/Edit modal (needs `getContracts`, `:546`), `RateScheduleModal`, and the assignment UI (`:196-203, 328-385, 466-520, 625-670, 693-716`). The Rate column is per **assignment** across **all** categories (`:178-182, 483-486`). `getAllLaborCategories` (`:39-78`) has no `contractId` and is also used by charge codes. |
| **Unpriced** | `internal/cost-basis.ts:201-270` `unpricedEntries(db, filters, limit)` (positional limit, capped at 500, **inner-joins `clins`** at `:225`, which excludes indirect entries). The cost basis decides the CLIN level when the SLIN level has no candidates (`:72, 89`). `findOverlaps` keys CLIN-level pairs with `slinId = null` (`:308`). Home's overlap count = `overlappingAssignments(db)`, which includes **future** overlaps and ones with no hours (`internal/home.ts:43, 67`). `CostBasisReports.tsx:28, 68` is the only overlap list. `UnpricedNote.tsx:19` builds `${HREF}&${params}`; its scope params are `startDate`/`endDate`/`contractId`/`clinId`/`slinId`. `CURRENT_RATES_NOTE` is required in `DashboardClient` and `CostBasisReports` (`cost-basis.test.ts:241-247`). |
| **Reports** | `page.tsx:11` `requirePageRole('approver')`. Client: three cards (red / success / signal buttons). Detailed and summary reports keep cleared (0-hour) latest revisions (`internal/reports.ts:63-108`), and the summary inner-joins CLINs (`actions/reports.ts:~258`). The PDF renders any status (`timesheet-pdf/route.ts:32`). `exceljs` pattern: `lib/reports/cost-report-excel.ts:10`, route `api/reports/cost-report-xlsx`. |
| **Assignments** | `page.tsx` takes no searchParams. `AssignmentsClient.tsx:379` has uncontrolled Tabs. |
| **Nav and links** | `nav-config.ts:22-30`; `/admin/dashboard` links at `nav-config.ts:24` and `lib/home/attention.ts:176`; unpriced links at `lib/cost-labels.ts:8`, `UnpricedNote.tsx:19` and `attention.ts:183`; redirects in `next.config.ts:63-75`. |

## 2. Invariants
- **DCAA:** no change to entries, revisions or the period lock.
- **Security:**
  - every new read action and every route's data call guards first (`requireAdmin` unless stated);
  - ids are validated **after** the guard;
  - no internals exported from `'use server'` files.
- **SQL:** correlated outer columns are written literally. Reuse `LATEST_REVISION` and `COST_BASIS_LATERAL`. **Every unpriced or cost aggregate inner-joins `clins`**, so indirect and leave entries (with a null `clin_id`) are never counted as unpriced.
- **CSS:** no `light-dark()` in `.css`; no `-filled` text colours.
- **Controls:** no `disabled` and no Mantine `loading` on focusable buttons.
- **Totals:** never from a capped list.
- **No business decisions** (C6).
- **`CURRENT_RATES_NOTE`** ("costs use the labor-category rate in effect on each day worked", CO-D7) appears on every screen and sheet that shows cost: Contracts, Unpriced, period-cost Excel. The static list in `cost-basis.test.ts:241-247` is updated to the new files.

## 3. The kit

### 3.1 `StatusBadge` and the status map
**`src/lib/ui/status.ts`:**
```ts
export type StatusKey = 'draft' | 'notSubmitted' | 'submitted' | 'approved' | 'rejected' | 'active' | 'inactive' | 'closed';
export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'dim';
export const STATUS: Record<StatusKey, { word: string; tone: Tone }> = {
  draft: { word: 'Draft', tone: 'dim' }, notSubmitted: { word: 'Not submitted', tone: 'dim' },
  submitted: { word: 'Submitted', tone: 'info' }, approved: { word: 'Approved', tone: 'ok' },
  rejected: { word: 'Returned', tone: 'warn' },
  active: { word: 'Active', tone: 'ok' }, inactive: { word: 'Inactive', tone: 'dim' }, closed: { word: 'Closed', tone: 'dim' },
};
export function statusWord(s: string): string; // known → word; else sentence case, '_' → ' '
```
- `lib/timesheet/labels.ts` `STATUS_WORD` derives from it (same words).
- `PERIOD_STATUS_COLOR.rejected` becomes `warning` (covered by `theme-contrast` T1).

**`StatusBadge`:** `<span className={styles.badge} data-tone={tone}>{word}</span>`, a dot (`::before`, `currentColor`) plus the word.
- Tones: `ok` `var(--mantine-color-success-text)`, `warn` `warning-text`, `bad` `red-text`, `info` `signal-text`, `dim` `--mantine-color-dimmed`.

### 3.2 `Notice` and `PageHeader`
- **`<Notice tone="warn" | "info" action?={{ label; href } | { label; onClick }}>`:**
  - a 1px border, a 3px left rule (warn `warning-6`, info `signal-6`), and a soft fill via the dark-override pattern;
  - an `aria-hidden` icon, the message, and the action right-aligned;
  - `role="note"`.
- **`PageHeader`:**
  - gains `notices?: ReactNode`, rendered after the title row;
  - `description: ReactNode`, rendered in a **`div`** with the same typography (a ReactNode in a `<p>` is invalid nesting);
  - `breadcrumb?: ReactNode`, above the title.

### 3.3 Formatting (`src/lib/format.ts`)
```ts
export function formatCurrency(v: number | string | null | undefined, opts?: { cents?: boolean }): string; // '—' for null/NaN; cents default true
export function formatHours(v: number | string | null | undefined, opts?: { blankZero?: boolean }): string; // "1,719.00"
export function formatCount(n: number): string;
```
These use module-level `Intl.NumberFormat('en-US')` instances.

### 3.4 Tables
1. **`numericColumn<T>(def & { format?; })`:**
   - sets **`align: 'right'`** on `mantineTableHeadCellProps`, `mantineTableBodyCellProps` and `mantineTableFooterCellProps` (MRT aligns header content with `--mrt-cell-align`), **composed** with any caller-supplied props (object or function);
   - `Cell` runs through `format`;
   - no footer totals (C2).
2. **`useAppTable` opt-in options** (undefined = today):
   - `emptyState?: { title; body?; action? }`: renders only when `data.length === 0`; an empty search shows "No results for “{q}”.";
   - `compact?: boolean`: no pagination or bottom toolbar;
   - `hairline?: boolean`: no striping.
3. **`expandable?: { getSubRows; label: (row) => string; searchText: (row) => string }`.** The hook:
   1. sets `enableExpanding: true` and `enableExpandAll: false`, and **hides MRT's column** with `state.columnVisibility['mrt-row-expand'] = false` (merged with any caller visibility);
   2. renders **its own** control inside the first data column's `Cell`, indented by `row.depth`: a `<button type="button">` with `aria-expanded`, `aria-label="Show {label}"` / `"Hide {label}"`, and a chevron rotating 90° (CSS, `prefers-reduced-motion` respected). Rows with no children render a spacer, never a button;
   3. **search:**
      - MRT treats `globalFilterFn` as a **key** into `filterFns` (`index.esm.mjs:3024, 3125`), so register the function as `filterFns: { treeText }` and set `globalFilterFn: 'treeText'`;
      - `treeText` is a stable module-level function that's pure on `row.original`. It matches the query (case-insensitive substring) against `searchText(row.original)` **plus every ancestor's** `searchText`, via `row.getParentRows()` (`table-core core/row.js:58`). So a contract-name match also matches all its descendants;
      - only one column is globally filterable: `getColumnCanGlobalFilter: (c) => c.id === FIRST_DATA_COLUMN_ID`. That column has an `accessorFn` returning `label(row.original)` (a string, so TanStack accepts it, `GlobalFiltering.js:27-30`);
      - `filterFromLeafRows: true` (ranking is already off for non-fuzzy functions);
      - **state ownership:** the hook owns `globalFilter`, `expanded` and `searchExpanded` (`useState` with `onGlobalFilterChange` / `onExpandedChange`) and passes `state.expanded = globalFilter ? searchExpanded : expanded`. **Never put an `undefined` key in `state`**: `useReactTable` spreads `options.state` over the internal state, so it would override it.
      - `searchExpanded` resets to `true` whenever the query goes from empty to non-empty; toggles during a search update `searchExpanded`; clearing the search restores the user's previous `expanded`.
      - `getRowId: (row) => \`${row.level}:${row.id}\`` (stable ids, so a `router.refresh()` that inserts a row never expands the wrong rows; MRT sets `autoResetExpanded: false`);
   4. sets `paginateExpandedRows: false`.
4. **Plain tables:** export a `.num` class (right align).

### 3.5 `useBusy()`
```ts
const busy = useBusy();
await busy.run(key, fn);       // a string key; use composite keys for several buttons: 'costs:excel'
busy.is(key); busy.any();      // read STATE (never a ref) — react-hooks 7
<Button {...busy.props(key, { icon })} onClick={() => busy.run(key, fn)} />
// props: { 'aria-disabled', 'data-disabled', 'aria-busy', leftSection: <Loader size="xs" /> | icon }
```
- Re-entry is guarded by a ref written only in `run`.
- The mounted ref is set inside an effect.

**`WriteButton` in read-only mode:**
- drop the caller's `disabled` and `loading`;
- render `aria-disabled` + `data-disabled`;
- in `onClick`, call `preventDefault()` and `stopPropagation()` and do nothing;
- expose the reason through `aria-describedby` on a visually hidden span (the Tooltip's label renders lazily).

Outside read-only mode its behaviour is unchanged (callers' `disabled` / `loading` still pass through until each page is converted in the later sweep).

### 3.6 Errors (`src/lib/toast.ts`)
- `toastError({ title, message })` uses `color: 'red'` and `autoClose: false`. `toastSuccess(...)` uses the default autoClose.
- `runAction` uses `toastError`. The Notifications `limit` stays at its default of 5, and older ones queue.
- Direct red toasts are converted on Part 1 pages. A static test enforces it for those files.

### 3.7 Forms
1. **`MoneyInput`:**
   - `value: string`, `onChange(value: string)`, `max?: number`;
   - Mantine `NumberInput` with `prefix="$"`, `thousandSeparator=","`, **`allowedDecimalSeparators={['.']}`**, `decimalScale={2}`, `allowNegative={false}`, `hideControls`, `inputMode="decimal"`, `clampBehavior="none"`;
   - it forwards **only** `onValueChange` calls with `source === 'event'`, as `values.value` (a plain numeric string), and **never** a float;
   - `max`: **not** forwarded to NumberInput; on blur, if the value exceeds `max`, show the inline error "Must be at most {formatCurrency(max)}." (the server enforces it as well);
   - a third decimal place in a paste is truncated ("1234.567" → "1234.56"). The input shows the result, so it's visible.

   Labels drop "($)".
2. **Dates.** `lib/date-utils.ts`:
   - `dayjs.extend(customParseFormat)`;
   - `parseFlexibleDate(input: string): string | null`: strict parsing against `MMM D, YYYY`, `MMMM D, YYYY`, `YYYY-MM-DD`, `M/D/YYYY` and `MM/DD/YYYY`; returns a `YYYY-MM-DD` string; returns null for incomplete or invalid input ("Oct 1, 2", "2026-02-30").

   Theme defaults: `DateInput: { valueFormat: 'MMM D, YYYY', dateParser: parseFlexibleDate }`, `DatePickerInput: { valueFormat: 'MMM D, YYYY' }`. Remove the two `YYYY-MM-DD` overrides.

### 3.8 Period presets
- **`resolvePeriodRange(preset)`** in `actions/periods.ts`: `requireSession`, returns an ActionResult. `preset` is one of:

  | Kind | Range |
  |---|---|
  | `thisPeriod` | the current pay period |
  | `lastPeriod` | the most recent completed period |
  | `lastN` (n 1..24) | the N most recent **completed** periods, oldest start → newest end |
  | `thisMonth` | 1st of the current month → today |
  | `contractToDate` | admin only; `validateUUID`. Start: `contracts.startDate`, else `MIN(entry_date)` on its CLINs, else today, **clamped to ≤ today**. End: today |
  | `allTime` | `{ start: null, end: null }`, unbounded |
  | `custom` | start ≤ end, else `UserFacingError('The end date must be on or after the start date.')` |

  It returns `{ start: CalendarDate | null, end: CalendarDate | null, label }`. Labels use `periodLabel`-style formatting, e.g. "Last pay period · Oct 1 – 15, 2026" or "Dec 16, 2025 – Jan 15, 2026".
- **`<PeriodPresetSelect presets value onChange />`:** a Select. "Custom dates…" reveals two DateInputs, with an inline start ≤ end check.

### 3.9 Download helper
- `downloadFile(url, fallbackName, opts?: { messages?: Partial<Record<number, string>> })`.
- On 422, show the JSON `error` (non-JSON falls back to the generic message).
- Extract `saveBlob(blob, name)`.

## 4. Pages

### 4.1 Contracts (`/admin/contracts`)
1. **Read `getContractsOverview()`** (`actions/contracts.ts`, `requireAdmin`; logic in `internal/contracts-overview.ts`). Five queries:
   - contracts (+ description, dates, ceiling);
   - CLINs;
   - SLINs;
   - per CLIN: hours, priced cost and unpriced, via `clinCostTotals` extended with `totalHours` (additive);
   - per SLIN: the same, in one lateral query.

   All aggregates inner-join `clins` and use `LATEST_REVISION`. The types:
   ```ts
   type Money = { funded: string | null; hours: number; pricedCost: number; unpricedHours: number };
   interface SlinNode extends Money { id: string; slinNumber: string; description: string | null; status: RecordStatus }
   interface ClinNode extends Money { id: string; clinNumber: string; description: string | null; status: RecordStatus; slins: SlinNode[] }
   interface ContractNode extends Money { id: string; contractNumber: string; name: string; description: string | null; contractType: 'prime' | 'sub'; status: RecordStatus; startDate: CalendarDate | null; endDate: CalendarDate | null; ceiling: string | null; clins: ClinNode[] }
   interface ContractsOverview { contracts: ContractNode[]; totals: { activeContracts: number; funded: number; pricedCost: number; unpricedHoursAll: number } }
   ```
   Contract money is `sumRounded` of its CLINs. Totals are active-only, except `unpricedHoursAll`.
2. **Page:** `requirePageRole('admin')`, then the read.
   - Header: h1 "Contracts and CLINs"; description "Funding, spending and burn for each contract, CLIN and SLIN." followed by a small dimmed `CURRENT_RATES_NOTE` line; action "Add contract".
   - No `ApprovalNotices` (C1).
3. **Summary strip** (four cells, mockup):

   | Cell | Value |
   |---|---|
   | Active contracts | count |
   | Funded | whole dollars |
   | Spent (priced hours) · {burn}% | whole dollars |
   | Remaining | whole dollars |

4. **Notice** (when `unpricedHoursAll > 0`): "**{hours} hours have no labor-category rate,** so their cost isn't counted above.", with "Fix pricing" linking to `/admin/reports/unpriced`.
5. **Hierarchy table** (`useAppTable` with `expandable`, `hairline`, `compact` when ≤ 25 top-level rows):

   | Column | Content |
   |---|---|
   | Contract | the expand control and name; sub-line: type pill, number (mono) and "ends {MMM D, YYYY}". CLIN: "CLIN {n} · {description}". SLIN: "SLIN {n} · {description}". |
   | Funded / Spent / Remaining | `numericColumn`. Contract and CLIN rows show whole dollars; SLIN rows the same |
   | Burn | a bar plus "{p}% · {tier}" (contract) or "{p}%" |
   | Unpriced | hours, as a link scoped to the row (`/admin/reports/unpriced?contractId=…[&clinId=…][&slinId=…]`, built with `URLSearchParams`) when > 0; else "0.00" |
   | Status | `StatusBadge` |
   | Actions | Edit plus ⋯ (below) |

   - `searchText` = name + number + description at each level.
   - Rows stay one line. Contracts start collapsed unless there's exactly one.
   - **⋯ menus:**
     - contract: Add CLIN (**only when active**), Close contract / Reopen contract;
     - CLIN: Add SLIN (only when the CLIN and its contract are active), Deactivate / Reactivate;
     - SLIN: Deactivate / Reactivate.
6. **Dialogs** (`MoneyInput`; theme DateInput):
   - contract: number, name, description, type, dates, funded, ceiling;
   - CLIN and SLIN: number, description, funded;
   - Add CLIN / Add SLIN: the same dialog, with the parent shown read-only.

   The only client check is end ≥ start ("The end date must be on or after the start date."). Errors are inline; no silently disabled submit; `runAction` silent plus an inline Alert.
7. **Close / reopen** (`ConfirmModal`):
   - **Close** (danger): title `Close {name}?`; message "Its charge codes will no longer appear on anyone's timesheet, and no one can add new hours to it. Recorded hours stay, and you can reopen it later."; confirm "Close contract".
   - **Reopen** (neutral): title `Reopen {name}?`; message "Its active charge codes will appear on timesheets again for employees assigned to them."; confirm "Reopen contract".

   Both call `updateContract(id, { status })`.
8. **CLIN and SLIN Deactivate / Reactivate:** keep the UX-4a confirms and copy.
9. **After a write:** merge the **row the server returns** (never the form values: clearing an optional money or date field is a server no-op today, `validation.ts:94`, so the form could disagree with the database), then `router.refresh()`. The drawer, lazy loads and C1 tokens are deleted.
10. **Server hardening:**
    - `updateContract`: `validateUUID(id)`; runtime-validate status (`active | inactive | closed`) and type (`prime | sub`) with "Invalid contract status." / "Invalid contract type."; if no row is updated, `UserFacingError('That contract no longer exists.', 'not_found')`.
    - `createClin`: `validateUUID(contractId)`; refuse a non-active contract with "This contract isn't active. Reopen it before adding CLINs."
    - `createSlin`: `validateUUID(clinId)`; refuse when the CLIN **or its contract** isn't active: "This CLIN or its contract isn't active."
    - `updateClin` / `updateSlin`: `validateUUID(id)`, and when no row is updated, `not_found` "That CLIN no longer exists." / "That SLIN no longer exists."
    - Every `create*` / `update*` action used here returns the saved row (`.returning()`).
11. **Removed:** `admin/dashboard/*`, `getContractSummaries`, `getPeriodCostReport`, the drawer and the old flat table.

### 4.2 Labor categories
1. **Server:**
   - `getAllLaborCategories` adds `contractId` (additive);
   - `getLaborCategoryPeopleCounts()` (`actions/labor-categories.ts`, `requireAdmin`; the file is on the LCAT allowlist): one grouped query, `COUNT(DISTINCT user_id)` of assignments active on the workspace today, by `labor_category_id`.
2. **Page (5 loads):** categories, contracts (for the Add modal), people counts, `getUnpricedSummary()` and today.
3. **Header:** h1 "Labor categories"; description "Each category's billing rate on a CLIN. Charge codes and employees use these to price hours."; action "Add labor category".
4. **Notice** (when unpriced > 0): "**{hours} hours have no labor-category rate,** so their cost isn't counted.", with "See what to fix" linking to `/admin/reports/unpriced`.
5. **Table** (`expandable`, groups by contract, `hairline`):
   - group rows: name, number (mono) and "· {n} categories";
   - children:

     | Column | Content |
     |---|---|
     | Category | "{title} · CLIN {n}[ · SLIN {n}]" |
     | Code | mono |
     | Hourly rate / Ceiling rate | `numericColumn`, cents |
     | People | `formatCount`, linking to `/admin/assignments?tab=labor-categories&laborCategoryId={id}` |
     | Status | `StatusBadge` |
     | Actions | Edit plus ⋯ (Rates…, Deactivate / Reactivate) |

   - Groups start expanded. `searchText` = contract name and number, title and code.
6. **Modals:** unchanged, except `MoneyInput` and the theme DateInput.
7. **Removed:** the assignment UI (§4.3) and `CostBasisReports` (§4.4).

### 4.3 Assignments: "Labor categories" tab
1. **`page.tsx`:** `searchParams: Promise<{ tab?; laborCategoryId?; userId?; assignments? }>` (first of arrays):
   - `tab` allowlisted to `charge-codes | approval-scope | labor-categories` (default `charge-codes`);
   - `laborCategoryId` and `userId` UUID-validated (else ignored);
   - `assignments` a comma list of UUIDs (invalid ones dropped).
2. **The client derives `tab`, `laborCategoryId`, `userId` and `assignments` from `useSearchParams()`,** validating the UUIDs client-side (invalid values are ignored). The server only uses `tab` to render the initial tab.
   - Switching tabs calls `window.history.replaceState(null, '', '?tab=…')`, which drops the filters. Next keeps `useSearchParams` in sync with no server round-trip.
   - Removing a chip calls `replaceState` without that param.
3. **`LaborCategoryAssignmentsPanel.tsx`** (the moved UI) keeps the assign form, table and End assignment modal.
   - The page passes `rateByCategory: Record<laborCategoryId, string | null>` for **all** categories, from `getAllLaborCategories` with `rateDisplay(schedule, today).current?.hourlyRate ?? null`. Rows and dropdown options both look up rates there.
   - Assignable categories come from `getAssignableLaborCategories`.
   - **Filters:**
     - `laborCategoryId` filters the table **exactly** to that category's assignments active today, with a removable chip "Labor category: {code} · CLIN {n}";
     - `userId` filters the table to that employee (also with a chip) and pre-selects them in the assign form;
     - `assignments` highlights those rows (warning-soft background plus the sr text ", overlapping").
4. **Server:** `endUserLaborCategoryAssignment` adds `validateUUID(id, 'Assignment')` after the guard.

### 4.4 Unpriced hours (`/admin/reports/unpriced`)
1. **Server** (`internal/cost-basis.ts`; every query **inner-joins `clins`**):
   - **`unpricedGroups(db, filters, { limit = 1000 })`.** One grouped query over latest revisions with `basis <> 'priced' AND hours > 0`.
     - **Group key:** `(basis, level, user_id, location)`, where location is `slin_id` when `level = 'slin'`, else `clin_id`, plus `charge_code_id` for `no-category` groups only.
     - Select `SUM(hours)`, `MIN/MAX(entry_date)` and `COUNT(*)`.
     - Order by `SUM(hours) DESC`, then the full key (a deterministic tiebreak). `limit + 1` gives `truncated`.
     - **Build it as a subquery** that selects the per-entry columns plus a computed `loc` (`CASE WHEN level = 'slin' THEN slin_id ELSE clin_id END`) and a computed `code_key` (the charge code for `no-category`, else null). The outer query groups by plain columns. **Never** interpolate a literal such as `${'slin'}` into both SELECT and GROUP BY (they become different parameters, and Postgres rejects the query).
   - **`unpricedTotals(db, filters)`:** total hours and distinct employees, plus the group count as `count(*)` over the same grouped subquery. With no filters, `totals.hours` equals Home's `unpricedTotal` (parity).
   - **Conflict pairs:** extend `OverlapRow` with `clinId` and `slinId`. Attach a pair to a conflict group **by level**: `slin` → `pair.level === 'slin' && pair.slinId === group.slinId`; `clin` → `pair.level === 'clin' && pair.clinId === group.clinId`. In both cases the same user, and the pair's overlap window intersects the group's date range.
   - **Unattached pairs:**
     - add `contractId` to `OverlapRow`, and scope pairs by the `contractId`, `clinId` and `slinId` filters;
     - decide "has no affected hours" against the **unfiltered** conflict groups, via one extra grouped query of `(level, user, loc, MIN, MAX)` where `basis = 'conflict'`;
     - pairs with no unfiltered conflict group are `unattachedOverlaps`. Pairs that do have hours but none inside the current date filter are returned as `outOfViewOverlaps`.
   - **`fix`:**
     - `no-category` with a code → `set-code-category`;
     - without a code → `assign-category`;
     - conflict → `end-overlap` with the attached pairs' assignment ids.

   ```ts
   interface UnpricedReport {
     totals: { hours: number; groups: number; employees: number; overlaps: number };
     groups: UnpricedGroup[]; unattachedOverlaps: OverlapRow[]; truncated: boolean;
   }
   ```
   `overlaps` = the number of pairs (attached + unattached + out of view), which with no filters equals Home's overlap count. The interface also carries `outOfViewOverlaps: OverlapRow[]`.
2. **Actions** (`actions/labor-categories.ts`, `requireAdmin`):
   - `getUnpricedReport(filters)`;
   - `getUnpricedSummary()` (totals only).

   **Filters:** `contractId`, `clinId`, `slinId`, `start`/`end` **and** the legacy `startDate`/`endDate` names, and `reason` (`conflict`). Validated as today, with invalid values ignored. With no `start`/`end`, the period preset is **All time** (so scoped links from Contracts match their cell values). `getUnpricedHoursReport` is removed once unused.
3. **Page** (`requirePageRole('admin')`):
   - `PageHeader` with breadcrumb "Downloads › Unpriced hours", h1 "Unpriced hours", description "Hours that have no labor-category rate, so contract costs leave them out. Each row is one thing to fix." plus `CURRENT_RATES_NOTE`, and the action "Download Excel";
   - a strip: "Unpriced hours", "Things to fix", "Employees affected";
   - filters: contract, period preset (All time, Last pay period, This pay period, This month, Custom) and a "Show overlaps only" toggle (`reason=conflict`).
4. **Groups table** (`numericColumn` for Hours):

   | Column | Content |
   |---|---|
   | What's wrong | "No category" (warn) or "Overlapping categories" (bad) |
   | Employee | name |
   | Where | the code, or "{contract} CLIN {n}[ SLIN {n}]" |
   | Hours | hours |
   | Dates | date range |
   | Fix | a button |

   Fix buttons:
   - set-code-category: "Set category on code", linking to `/admin/charge-codes?code={id}`;
   - assign-category: "Assign {first name} a category", linking to `/admin/assignments?tab=labor-categories&userId={id}`;
   - end-overlap: "Review overlap", linking to `/admin/assignments?tab=labor-categories&userId={id}&assignments={ids}`.
5. **Overlap section** (when `unattachedOverlaps` or `outOfViewOverlaps` is non-empty, including under `reason=conflict`). Titled "Overlapping assignments (no hours affected yet)" for `unattachedOverlaps`, and "Overlapping assignments with no unpriced hours in this view" for `outOfViewOverlaps` (only shown when a filter is set).
   - columns: employee, level, CLIN/SLIN, both categories, the overlap window;
   - "Review overlap" uses the same link as above.
6. **States:**
   - truncated: an info Notice, "Showing the 1,000 largest groups. Download Excel for everything.";
   - empty, with no unattached overlaps either: "No unpriced hours. Every recorded hour has a labor-category rate.";
   - empty groups with unattached overlaps: the section alone, with a sentence above it.
7. **Charge codes deep link:** the page reads `searchParams.code` (UUID-validated) and opens `ChargeCodeCategoryModal` for that code if it's in the list.
8. **Excel route `app/api/reports/unpriced-xlsx/route.ts`** (the `cost-report-xlsx` pattern):
   - rate limit; filters as in 2 (400 on invalid); the guarded action inside try;
   - sheets: "To fix" (all groups, fetched in pages of 5,000 ordered by hours then the full key), "Overlaps" (all pairs in scope), and "Every entry" (`unpricedEntries(db, filters, 50_000)`, plus a truncation row if hit; with `reason=conflict`, entries are filtered in memory to those whose basis is conflict);
   - `CURRENT_RATES_NOTE` row on each sheet;
   - no groups and no overlaps → 422; never 404.
9. **Links:**
   - `UNPRICED_REPORT_HREF = '/admin/reports/unpriced'`;
   - `UnpricedNote` builds `?` + `URLSearchParams` (no `&` concatenation, no `#cost-basis-reports`);
   - Home's overlap item → `/admin/reports/unpriced?reason=conflict`;
   - Home's "Open overview" → `/admin/contracts`.

### 4.5 Reports (`/admin/reports`, h1 "Downloads")
**Layout:** one panel of rows in a three-column grid (description; inputs; buttons) with fixed column widths, matching the mockup. Buttons are outlined, except the PDF's primary. `useBusy` uses composite keys (`costs:excel`, `costs:csv`). Each row has an inline `role="alert"` error. There's no colour-coding.

| Row | Inputs | Buttons | Data | Visible to |
|---|---|---|---|---|
| **Signed timesheet** ("An employee's timesheet for one pay period, with signatures and the audit trail.") | employee; pay period (this, last, or one of 24 back) | Download PDF | `timesheet-pdf` | approver |
| **Contract costs** ("Hours and cost by contract, CLIN and labor category, using the rate in effect each day.") | contract or All; preset (Last pay period, This pay period, This month, Contract to date when a contract is chosen, Custom) | Excel, CSV | `cost-report-xlsx` / `-csv` | admin |
| **Hours summary** (R5 copy) | preset (Last pay period, This pay period, This month, Custom) | Excel | `cost-report-xlsx?format=summary` | approver |
| **Cost by pay period** ("Hours and cost for each pay period and contract.") | last N completed periods (3, 6, 12; default 6) | Excel | `period-cost-xlsx` | admin |
| **Unpriced hours** ("Hours with no labor-category rate or with overlapping assignments.") | "All time · {hours} hours · {groups} things to fix" | View, Excel | `unpriced-xlsx` | admin |

**Page data:**
- `getReportFilterOptions()` adds contract `startDate`;
- `getPeriodOptions(today, 24, 0)`;
- **`getUnpricedSummary()` only when `user.role === 'admin'`** (supervisors never call it).

**`period-cost-xlsx`:**
- the route validates `n ∈ {3, 6, 12}` and calls a new **`getPeriodCostByPeriod(n)`** in `actions/reports.ts` (`requireAdmin` first) inside the try;
- one query: latest revisions × cost basis, inner-joining CLINs, **grouped by `clin_id`, contract and `entry_date`**, within the last N completed periods. The range comes from an **internal** helper `lastCompletedPeriods(db, n)` in `internal/pay-period-config.ts`, which `resolvePeriodRange` also uses; it never calls the action;
- in memory: bucket the rows into periods with `loadScheduleResolver`, sum unrounded per CLIN per period, `round2`, then `sumRounded` per contract per period;
- one sheet: Period, Contract, Hours, Priced cost, Unpriced hours, a totals row per period, and a `CURRENT_RATES_NOTE` row;
- total hours 0 → 422.

Per-period figures aren't expected to equal the all-time Contracts figures.

**R4 everywhere:** `cost-report-csv`, `cost-report-xlsx` (both formats), `period-cost-xlsx` and `unpriced-xlsx` return 422 when **Σ hours = 0** (cleared-only ranges included):
- costs: "No hours recorded between {range label}.";
- summary: "No direct hours recorded between {range label}.";
- `timesheet-pdf` keeps 404 for an unknown user, with a per-route message.

## 5. Routes, redirects, nav
- **`next.config.ts`** (307):
  - `/admin/dashboard` → `/admin/contracts`;
  - **first:** `/admin/labor-categories` with `has: [{ type: 'query', key: 'report', value: 'overlaps' }]` → `/admin/reports/unpriced?reason=conflict`;
  - **then:** `/admin/labor-categories` with `has: [{ type: 'query', key: 'report' }]` → `/admin/reports/unpriced` (the query passes through; the legacy `startDate`/`endDate` are accepted per §4.4.2).
- **`nav-config.ts`:** remove "Overview". The Contracts group: "Contracts and CLINs", "Charge codes", "Indirect codes", "Labor categories".
- **Page metadata:** + "Unpriced hours", − "Contract dashboard" (still 33).

## 6. State tables
**Contract status:**

| From | Action | To | Effect |
|---|---|---|---|
| active | Close (confirm) | closed | codes leave timesheets; Add CLIN hidden; labor-category assign refused |
| closed / inactive | Reopen (confirm) | active | codes return for assigned employees |
| any | Edit | unchanged | — |
| — | update with an unknown id | — | `not_found` "That contract no longer exists." |

**Unpriced fix routing:**

| Kind | Button | Destination |
|---|---|---|
| set-code-category | Set category on code | `/admin/charge-codes?code={id}` (opens the modal) |
| assign-category | Assign {name} a category | `…/assignments?tab=labor-categories&userId=` (filtered, pre-selected) |
| end-overlap / unattached overlap | Review overlap | `…&userId=&assignments=` (filtered, highlighted) |

## 7. Failure modes
- **Contracts read fails:** the error boundary. **A write fails:** an inline Alert, with state unchanged.
- **Search:** a parent match shows all its children; a child match shows its ancestors, all expanded.
- **Unpriced:**
  - truncated: notice, with exact totals;
  - overlaps with no hours: their own section;
  - indirect and leave entries are never counted;
  - invalid params ignored.
- **Excel:** >50k entries → a truncation row; ties are deterministic.
- **Downloads:** Σ hours 0 → 422 in place; 429 → the existing copy; network → the existing message.
- **Presets:** a future contract start is clamped; custom start > end is inline; `allTime` is unbounded.
- **MoneyInput:**
  - a comma is never a decimal, so a paste of "1,234,567.89" → "1234567.89";
  - a partial "12." is sent as a string, and the server validates it;
  - over `max`: an inline error on blur.
- **Dates:** partial input never commits a wrong date (`parseFlexibleDate` returns null).
- **Supervisors on Reports:** no admin-only reads are called.
- **Redirects:** bookmarks land with their queries.

## 8. Platform limits
- **Contracts:** 5 queries.
- **Labor categories:** 5 loads.
- **Unpriced:** groups, totals, overlaps and filter options (4).
- **Excel:** ≤ 50k rows; groups in pages of 5,000.
- **Period-cost:** 1 query.
- **Reports page:** filter options, period options and an optional summary (≤ 3).
- **Assignments page:** 6 loads today, plus categories (for rates) and the panel's assignments and assignable list. Keep it at **≤ 10** (the pool's `max: 10`, `db/index.ts:33`): reuse the existing users and contracts loads; don't add duplicates.

## 9. Blast radius
| Area | Files |
|---|---|
| New | `lib/ui/status.ts`, `components/ui/{StatusBadge,Notice,MoneyInput,PeriodPresetSelect}.tsx`, `components/ui/useBusy.ts`, `lib/toast.ts`, `internal/contracts-overview.ts`, `app/(app)/admin/reports/unpriced/*`, `app/api/reports/{unpriced-xlsx,period-cost-xlsx}/route.ts`, `lib/reports/{unpriced-excel,period-cost-excel}.ts`, `admin/assignments/LaborCategoryAssignmentsPanel.tsx` |
| Changed | `PageHeader`, `mrtDefaults` / `useAppTable`, `WriteButton` (about 45 sites; behaviour changes only in read-only mode), `run-action`, `download.ts`, `format.ts`, `date-utils.ts`, `theme.ts`, `labels.ts`, `status-colors.ts`, `ContractsClient` (rewrite), contracts / CLINs / SLINs actions, labor-categories actions, page and client, `AssignmentsClient` and page, charge-codes page (`?code=`), `ReportsClient` and page, `actions/reports.ts` (`getPeriodCostByPeriod`, 422 checks in the routes), `internal/cost-basis.ts`, `internal/dashboard.ts` (`totalHours`), `nav-config`, `next.config.ts`, `cost-labels.ts`, `UnpricedNote`, `home/attention.ts` |
| Removed | `admin/dashboard/*`, `getContractSummaries`, `getPeriodCostReport`, `CostBasisReports.tsx`, `getUnpricedHoursReport` |

**Tests to update:**
- **Unit:**
  - `nav-config`, `app-navbar`, `home-page`, `page-metadata`;
  - `dashboard-remaining` (replaced by contracts-overview tests);
  - `burn`;
  - `cost-basis`: lateral counts per file, adding the contracts-overview, unpricedGroups and period-cost sites; the `CURRENT_RATES_NOTE` file list, adding the new Contracts client, the Unpriced page and the period-cost generator;
  - `charge-code-cost-rules:144-147`;
  - `workspace-mode` (the new read-only WriteButton: assert no `disabled` attribute; `:58` `data-read-only` assertion updated);
  - `contracts-drawer-loading` and `contracts-clin-deactivate` (rewritten);
  - `row-state`;
  - `labor-categories-assignable` and `rate-schedule-ui` (moved panel; rates per category; `:128` expects `'100.00'`, now `'$100.00'` with `MoneyInput`);
  - `reports-download`, `icon-registry`, `confirm-modal:80`, `assignments-row-actions`;
  - `server-action-guards` (new reads);
  - **new `route-moves.test.ts`:** both redirect rules, and no source link to `/admin/dashboard` or `/admin/labor-categories?report`.
- **Integration:**
  - `cost-basis` and `home-data`: move to `getContractsOverview` / `unpricedTotals`, keeping parity;
  - `dated-rates`: the T14 per-rate grouping assertions move to the detailed cost report in `internal/reports.ts`, and `:129-140` moves to `getContractsOverview`.

## 10. Test matrix
Each test must fail without its change.

| ID | Scenario |
|---|---|
| K-1 | `StatusBadge` words and tones; unknown → sentence case; rejected → "Returned"/warn; no `-filled` in its CSS |
| K-2 | Formatters: cents vs whole; null → "—"; blankZero; DB strings; separators |
| K-3 | `numericColumn`: `align: 'right'` on head, body and footer; a caller's function props composed (both run) |
| K-4 | `useAppTable`: options undefined → today's markup (snapshot of an existing table unchanged); emptyState only for `data.length === 0`; empty search → "No results for …"; compact hides pagination |
| K-5 | Expandable: **no `.mrt-expand-button` in the DOM**; own button with `aria-expanded` and "Show/Hide {label}"; leaves have no button. Search: a contract name shows **all** its CLINs, and **rows from a non-matching contract are absent**; a SLIN number shows that SLIN (visible) under its expanded parents, and **sibling SLINs that don't match are absent**; Hide works while searching; clearing the search restores the previous expanded state; a refresh that inserts a row keeps the same rows expanded (stable ids) |
| K-6 | `useBusy`: re-entry ignored; composite keys show the right button's Loader; props never include `disabled`; no setState after unmount |
| K-7 | `toastError` has `autoClose: false`; `runAction` uses it; static: no direct red toasts in Part 1 files |
| K-8 | `MoneyInput`, typed **one key at a time** with user-event: `1,234.5` → `1234.5`; paste `1,234,567.89` → `1234567.89`; paste `$1,234.50` → `1234.50`; "12." stays a string; a prop-sourced change doesn't call `onChange`; over `max` → the inline error on blur |
| K-9 | `parseFlexibleDate`: the five formats → `YYYY-MM-DD`; `Oct 1, 2` → null; `2026-02-30` → null; `01/05/2026` → `2026-01-05`; the theme defaults exist for DateInput and DatePickerInput; no `YYYY-MM-DD` overrides remain |
| K-10 | `resolvePeriodRange` (integration): this, last, lastN (completed periods, across a schedule change), thisMonth, contractToDate (start date / earliest entry / neither / future start clamped), allTime (unbounded), custom (refused when start > end); non-admin contractToDate → forbidden |
| K-11 | `WriteButton` read-only: **no `disabled` attribute**; `aria-disabled`; the reason via `aria-describedby`; a click doesn't call `onClick`; a caller's `loading` is ignored |
| C-1 | `getContractsOverview` (integration): **literal expected values** for the fixture, recorded from `getContractSummaries` **before** it's removed (CLIN, SLIN, contract); active-only totals; `unpricedHoursAll` = Home; an indirect entry in the fixture isn't counted; SLIN money not added to the CLIN |
| C-2 | Contracts UI: strip; notice only when > 0; expand; search cases (K-5); no footer; one-line rows; Unpriced cell links scoped with `?` |
| C-3 | Edit CLIN funding with `MoneyInput`: a server error inline; success updates funded and remaining |
| C-4 | Close: copy; Cancel → no call; Confirm → `status: 'closed'`; badge "Closed"; menu shows Reopen and no Add CLIN |
| C-5 | Server: invalid status/type; unknown contract, CLIN or SLIN id → `not_found`; the actions return the saved row; `createClin` on a closed contract → refused; `createSlin` under a CLIN whose contract is closed → refused; non-UUID parents → validation |
| C-6 | Redirects (route-moves), including `report=overlaps` → `?reason=conflict`; Home's links |
| L-1 | Labor categories: grouped; People counts (integration: ended and future assignments not counted); the notice; no assignment UI, no report; the Add modal lists contracts |
| L-2 | Assignments: `?tab=` allowlist, arrays, invalid → default; a tab switch uses `history.replaceState` (no router call); `laborCategoryId` filters exactly, with a chip; `userId` filters and pre-selects; `assignments` highlights; **switching tabs and back clears the filter and chip**; removing a chip clears the param; the Rate shows for an assignment to a **deactivated** category |
| U-1 | `unpricedGroups` (integration): entries collapse to the expected groups; totals = Home with no filters; an **indirect/leave entry isn't counted**; truncation keeps exact totals; **a SLIN entry with a CLIN-level conflict gets its pair**; correlation with another user's data |
| U-1b | A future-dated overlap with no entries appears in `unattachedOverlaps`; `totals.overlaps` = Home's overlap count with no filters; **with a contract filter, a pair on another contract is absent**; a pair whose conflict hours are outside the date filter appears in `outOfViewOverlaps`, not as "no hours affected yet" |
| U-2 | Unpriced UI: strip; rows; fix links per §6; the overlaps section; the conflict toggle; truncated notice; empty states; legacy `startDate`/`endDate` honoured |
| U-3 | `unpriced-xlsx` (integration): three sheets; all groups (no cap) in deterministic order; 422 when none; never 404 |
| U-4 | Charge codes `?code=` opens the modal; unknown or invalid → nothing |
| R-1 | Reports: five rows; admin-only rows hidden for a supervisor, and **a supervisor's page load never calls `getUnpricedSummary`**; neutral buttons; composite busy keys; 422 shown in place |
| R-2 | `period-cost-xlsx` (integration): bucketing across a schedule change; per-CLIN-per-period rounding; the `CURRENT_RATES_NOTE` row; 422 when empty; a non-admin → 403 |
| R-3 | Existing cost routes: zero-hour-only range → 422; a leave-only range on the summary → 422 with the "direct hours" wording; the PDF keeps 404 |
| N-1 | Nav: no Overview; "Contracts and CLINs"; metadata |

## 11. Verification
- **Dev:** `npx tsc --noEmit && npm run lint && npm run test && npm run test:tz && npm run db:safety`.
- **Product owner:**
  1. Integration.
  2. The lead's break-it script.
  3. `npm run build && node scripts/check-build-trace.mjs && node scripts/check-css-output.mjs`.
  4. `npm run demo:local` ×2.
- **Browser** (light and dark, against the mockup):
  1. **Contracts:** strip and notice; expand; search a CLIN number; edit funding (type "1,234.50" and it saves $1,234.50); close and reopen; `/admin/dashboard` redirects.
  2. **Labor categories:** grouped, People counts, the notice; no assignment form or long report.
  3. **Assignments → Labor categories:** assign and end; a People link opens it filtered.
  4. **Unpriced hours:** a handful of rows; each Fix lands correctly; the overlaps section if any; Excel with three sheets.
  5. **Downloads:** each row; an empty range shows the message in place; as Sarah, the page loads and shows only her rows.
  6. **Date fields:** "Oct 1, 2026" or "2026-10-01" both work, and a half-typed date doesn't jump. Error toasts stay until closed. Read-only mode buttons keep focus.

## 12. Hand-off rules and commit order
**Commit order:** one commit per line, each with its tests.
1. Kit: status map, `StatusBadge`, `Notice`, `PageHeader`
2. Kit: formatting, `numericColumn`, `useAppTable` options, expandable rows
3. Kit: `useBusy`, `WriteButton`, toasts
4. Kit: `MoneyInput`, dates
5. Kit: `resolvePeriodRange`, `PeriodPresetSelect`, download helper
6. Contracts read, page, dialogs, close/reopen, hardening; **record the C-1 literal values first**; remove the dashboard; redirects; nav
7. Unpriced report: server, page, Excel, links, the `?code=` deep link
8. Labor categories page, people counts, Assignments tab
9. Reports page, period-cost, 422s

**Rules:**
- Follow `BLUEPRINT-STANDARD.md` §3 (impact analysis first; stop and ask).
- Every §10 test must fail without its change: revert-check and report.
- Don't push. Don't edit Terms or Privacy. Never use demo tenants destructively.
- Report: commits, gates, revert checks, anything not run, and gap decisions.

## 13. Pre-mortem record
**Round 1:** 3 HIGH, 13 MEDIUM, ~25 LOW, all applied in v2.

| Finding | Fix in v2 |
|---|---|
| **H:** comma as decimal in `MoneyInput` | `allowedDecimalSeparators: ['.']` |
| **H:** MRT's expand column can't be turned off | hidden via `columnVisibility`, with our own control |
| **H:** overlaps with no hours lost, so Home's alert had no target | the unattached overlaps section |
| **M:** conflict matching by level | match by level |
| **M:** indirect hours counted as unpriced | inner-join `clins` everywhere |
| **M:** the Assignments rate regression | rate for every category |
| **M:** missing contracts load | added (5 loads) |
| **M:** search hiding rows | ancestor search text, expanded while searching |
| **M:** a "funded ≤ ceiling" business rule | removed (C6) |
| **M:** C-1 parity test against a deleted function | literal values recorded first |
| **M:** `customParseFormat` not loaded | `dayjs.extend`; strict formats; partial → null |
| **M:** no "this month" preset | `thisMonth` added |
| **M:** period-cost grouping vs rounding; unguarded route | group by CLIN and date; `getPeriodCostByPeriod` guarded |
| **M:** 422 definition; summary copy | Σ hours = 0; R5 copy |
| **M:** supervisor crash on Reports | summary loaded for admins only |

**Round 2:** 1 HIGH, 3 MEDIUM, about 10 LOW, all applied in v3:

| Finding | Fix in v3 |
|---|---|
| **H:** a custom `globalFilterFn` silently does nothing in MRT | registered in `filterFns` as `'treeText'`; one filterable column; negative search tests |
| **M:** expanded/filter state ownership | the hook owns it; no `undefined` keys; stable row ids |
| **M:** overlaps mislabelled under filters | scoped; "no hours" judged unfiltered; out-of-view list |
| **M:** stale Assignments filters | derived from `useSearchParams` |

The LOWs:
- `max` not forwarded; paste truncation stated;
- merge the returned row;
- CLIN/SLIN update hardening;
- the SQL subquery shape and totals via `count(*)`;
- `reason=conflict` in Excel;
- All time as the default preset;
- the `report=overlaps` redirect;
- the Assignments pool budget;
- `rateDisplay().current`;
- the internal period helper;
- the WriteButton count;
- the `rate-schedule-ui` expectation.
