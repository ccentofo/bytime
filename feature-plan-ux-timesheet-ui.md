# Blueprint UX-3 Part B: the timesheet screen and accessible grid

> **Role for the executing developer:** senior front-end engineer (React 19, accessibility, Mantine 9).
>
> **Follows:** `BLUEPRINT-STANDARD.md`.
>
> **Requires UX-3 Part A merged** (`feature-plan-ux-timesheet.md` Part A). Part A provides:
> - notes persistence and their read shape;
> - quarter-hour and day-total server rules;
> - the selected-period fields on `getTimesheetPeriod`;
> - `getPastTimesheets` and `weekly.ts`;
> - deep links;
> - the offline removal;
> - the old-grid note wiring.
>
> **Sources:** `UX-AUDIT.md` (V1–V5, A1–A4, A10, A11) and the approved mockup `ux-mockups/index.html` → "Employee timesheet".
>
> **Status:** v5.2 FINAL, 2026-10-28, lead architect. Self-contained. Pre-mortem history is in §13.
> - v5.1 changed only the NoteModal button wording (§4.8).
> - **v5.4 (§16), product owner polish:** an editor that never widens its column, one subtle edit ring, the note icon in the corner, and a hint with no "hover" wording. §16 overrides §4.6's focus ring and §14.5's hint.
> - **v5.3 (§15) fixes two things the browser check found:** the compiled CSS dropped every `light-dark()` color, and the page and grid double-scroll. §15 overrides §14.1's token syntax and §4.7's scroller height.
> - **v5.2 is the visual revision in §14.** It supersedes the grid's look, the note button, the day meters and the weekly notice's styling, wherever §4.1, §4.2, §4.6 and §4.8 say otherwise. Approved mockup: `ux-mockups/timesheet-grid-v2.html`.
>
> **Branch:** `ux-timesheet-ui`, cut from `main` after Part A merges.

**What this delivers:**
- the timesheet page per the mockup;
- a grid fully operable by keyboard and screen reader;
- the notes UI;
- an unsaved-changes guard for period switches, in-app links, sign-out and tab close/reload;
- a week view for narrow screens and 400% zoom;
- a "Past timesheets" page;
- notes in the Approvals drawer.

**Not in this part:**
- **Back/Forward protection** (per-tab drafts and refresh of stale cached data) moves to **Part C**, a separate future blueprint (product owner, 2026-10-28).
- the page-by-page pass (UX-4);
- Playwright CI and the accessibility conformance report (UX-5);
- real offline editing (deferred).

**No server rule changes.** Two read-shape additions are listed in §4.14.

---

## 0. Decisions (all answered)

| # | Decision | Ruling |
|---|---|---|
| UX-D3 | Employees land on the timesheet | Yes (UX-2) |
| UX3-D1 | Notes | Persisted append-only per cell; no reason code for note changes; locked at submission (Part A) |
| UX3-D3 / D4 | Hours | Quarter hours only. A day can't exceed 24 hours, except that a day already over 24 may be lowered (L1). Server-enforced (Part A). |
| UX3-Q1 | Past timesheets | Every period since the account started, including never-submitted ones |
| UX3B-D2 | Back/Forward unsaved work | **Product owner, 2026-10-28:** moved to **Part C**. Until Part C ships, using browser Back/Forward with unsaved edits can lose those edits. Server data stays safe: a save based on stale data is refused by the revision check (Part A) and never corrupts records. Documented in §6. |
| UX3B-D3 | Weekly "under 40" notice | **Product owner, 2026-10-28: exempt employees only**, as today |
| BIZ | Privacy and Terms §7 | The Part A offline/IndexedDB wording still needs the business-side update. Part B stores nothing new in the browser. |

## 1. Verified current state (after Part A merges)

**Page**
- `src/app/(app)/timesheet/page.tsx`:
  - resolves the period with `resolveRequestedPeriod`;
  - passes `TimesheetPageData`, including `notes`;
  - still calls `getEmployeeDashboardData`.
- **Page-level fields** come only from the page: `userId`, `today`, `readOnly`, `flsaExempt` (`types/timesheet.ts:102-115`).
- `getTimesheetPeriod` doesn't return those page-level fields (`actions/timesheet.ts:71-90`). It does compute `today` internally (`:94`). `today` is refreshed later by `SET_TODAY`.

**Components** (`src/components/timesheet/`)
- **`BiWeeklyTimesheetClient`** renders `TimesheetDashboard` outside the provider.
- **`TimesheetToolbar`** has:
  - the status badge and the self-approval badge (`:252-253`, CO-D6);
  - the dirty count;
  - Discard, Save and Submit, using `disabled`;
  - local ReasonModal and SubmitModal state (`:22,326`);
  - `overtimeInfo` with Sunday–Saturday weeks, counting overtime in every week including incomplete ones (`:65-100`, `:81`);
  - `completenessWarnings` (`:110-172`);
  - the exempt-only "Total Period Hours" panel with the under-40 warning (`:305-325`).
- **`PayPeriodSelector`** disables ‹ and › while loading (`:75,92`).
- **`BiWeeklyTable`** uses divs with `role="table"`, ResizeObserver density, and dense mode with 10 px text.
- **`HourCell`** is a `<div onClick>` with a `NumberInput`. It commits on blur and handles no keys. Its notes rule is `periodEditable && !isFutureDate` (`:80`).

**`TimesheetContext`**
- `useReducer`. `SET_PERIOD_DATA` copies `...state` and never sets the page-level fields (`:86-105`).
- `MARK_SAVED` has a stale-period guard that compares `periodStart` only.
- Also: `DISCARD_CHANGES`, `SET_TODAY`, the Part A notes state, `dirtyCells` and `dirtyNotes`, and `saveAll`.
- `showPeriod` uses a `loadSeq` ref, so the latest load wins (`:280-290`).

**Row names**
- `ChargeCode` has no name field. `description = r.description ?? r.name` at the five construction sites (`actions/timesheet.ts:563,595,639,649,655`).
- As a result, indirect rows show the category (V4).
- The Approvals drawer row label is `{cc.clin} — {cc.projectName}` (`ApprovalsClient.tsx:345`).

**`selectedPeriodFacts.summary`**
- carries `submittedAt` and `reviewedAt` as `Date` (`internal/employee-dashboard.ts:14-15`);
- has an exact `workdaysFilled` / `expectedWorkdays` / `total` computation (`:63-84`).

**Elsewhere**
- **Sign-out** (`sign-out.ts`): `clearDesigneeNoticeDismissals()` → `await signOut({ redirect: false })` → `location.assign('/login')`.
- **No unsaved-work protection** exists anywhere.
- **`PageHeader`** takes `title`, `description`, `actions` and `order`.
- **`AppShellWrapper`**'s `Props.user` has no `id`, although the layout passes it (`AppShellWrapper.tsx:16-20`, `layout.tsx:56`).
- **Nav:** the employee menu is "Timesheet" only, pinned by `nav-config.test.ts:28` and `app-navbar.test.tsx:96-98`.
- **Mantine `Notification`** defaults to `role="alert"` (`Notification.mjs:41`). A region inserted together with its text is announced unreliably.
- **`globals.css:6-10`:** `html, body { overflow-x: hidden; max-width: 100vw }`.
- **Tests:** `@testing-library/dom` is missing and user-event is absent. `timesheet-results` and `timesheet-notes-wiring` mount the provider without mocking `next/navigation`.
- **Lint:** react-hooks 7.1.1 flags ref reads and writes during render (`react-hooks/refs`) and global mutation in components (`react-hooks/immutability`).

## 2. Verified external facts

| Fact | Source |
|---|---|
| The app router keys a page segment without its search params, so `/timesheet?period=A` → `/timesheet` doesn't remount the component | `layout-router.js:488` |
| Back/Forward restores the tree stored in history state, so `initialData` can be stale (Part C) | `app-router.js:84-95,288-297` |
| `history.replaceState` is patched by Next and doesn't re-run server components | `app-router.js:268-281` |
| A capture-phase listener on `document` runs before `Link`'s `onClick`, and `Link` skips navigation when `defaultPrevented` is set | `link.js:~319` |
| Dispatching to the component's own reducer during render is allowed and passes lint | `react-dom-client.development.js:9112`; lead-commissioned lint run |
| `flushSync` after an `await` is allowed; layout effects flush inside it | React docs; lint run |
| Mantine Modal supports `returnFocus={false}`. `onExitTransitionEnd` fires after the exit transition, synchronously when `duration` is 0. | `use-modal.mjs`, `use-transition.mjs:27-30` |
| `useMediaQuery(q, initial)` reads in an effect and uses `initial` on the first render | `use-media-query.mjs:9-10` |
| `user-event` needs `@testing-library/dom` | package metadata |
| iOS opens the keyboard only on a synchronous `focus()` inside the user gesture | WebKit |
| WAI-ARIA APG data grid pattern; `<table role="grid">` mapping | WAI-ARIA APG |
| WCAG 1.4.10 allows two-dimensional scrolling for data tables | WCAG 2.1 |

## 3. Invariants
1. **Server rules are authoritative.** The client mirrors the quarter-hour and day-total checks for feedback only.
2. **Save, reason and submit semantics are unchanged:**
   - one batch, all-or-nothing;
   - ReasonModal for edits and late entries, staying open for retry after a failed save;
   - SubmitModal certification, exempt wording, `completenessWarnings`, and an overtime figure with **today's meaning** (all weeks touching the period);
   - the self-approval badge.
3. **Unsaved work is only discarded by the user's choice** for period switches, in-app links, sign-out and tab close/reload. Back/Forward is a documented gap until Part C (UX3B-D2).
4. **WCAG 2.1 AA:**
   - always **exactly one** tab stop in the grid;
   - focus is never dropped to `<body>` by a control disabling or unmounting;
   - axe in jsdom plus the manual script (§10).
5. **Standards:**
   - UX-1 tokens, the `Icons` registry, one h1, minimum text 0.875 rem;
   - **no lint errors:** no ref reads or writes during render, and no global mutation in components.

## 4. Design

### 4.1 Page layout (mockup "Employee timesheet")
**`PageHeader` gains `below?: ReactNode`,** rendered under the title row. The mockup puts the period control on its own line under the h1.

**1. Header band**
- **Title:** "Timesheet" (h1).
- **`below`: the period control.**

  | Control | Behaviour |
  |---|---|
  | ‹ `ActionIcon` | "Previous period" |
  | Period label | e.g. "Oct 16 – 31, 2026"; no wrap |
  | › `ActionIcon` | "Next period". At the current period it gets `aria-disabled` plus `aria-describedby` "This is the current period". Part A's period-list logic stays. |
  | "Choose period" `Select` | `aria-label="Choose period"`. Options come from `getPeriodOptions(today, 23, 0)` (24 periods). **If the shown period isn't in that list** (an older period opened from Past timesheets), it's added as an extra option at the top. If the unsaved guard is cancelled, the Select snaps back to the shown period. |
  | "Today" button | **Always rendered.** `aria-disabled` with "You're on the current period" when current, so focus isn't lost when it would otherwise disappear. |

- **`actions`:**
  - the status pill (Draft / Submitted / Approved / Returned), shown **once**;
  - the self-approval badge, when the server sends one;
  - **Discard changes**, **Save**, **Submit**.
- **Disabled-looking controls** (‹, ›, Today, Discard, Save, Submit) use **`aria-disabled` plus a click guard, never `disabled`**, so a focused control never drops focus.

**Submit reason.** When a reason applies, Submit gets `aria-disabled="true"` and `aria-describedby="{id}-submit-why"`, with the reason as **visible** text (≥ 0.875 rem). When no reason applies, there's no `aria-describedby` and no reason element. Precedence, first match wins:

| # | Condition | Reason |
|---|---|---|
| 1 | read-only workspace | "This workspace is read-only" |
| 2 | locked | "This timesheet is submitted" / "…approved" |
| 3 | loading | "Loading…" |
| 4 | unsaved changes | "Save your changes first" |
| 5 | before `submitOpensOn` | "Opens {dddd, MMM D}" |
| 6 | no hours | "Add hours before submitting" |

**2. Status line**
- A `<p>`. **Not a live region** (the mockup's `role="status"` is deliberately not used).
- Built from `periodProgress` (§4.4), counting unsaved edits too. Totals are rounded to 2 decimals.

| Period | Text |
|---|---|
| draft or rejected, due date ≥ today | "{total} hours entered · {workdaysFilled} of {expectedWorkdays} workdays so far are filled in · Due {dddd, MMM D}" |
| draft or rejected, due date < today | the same, ending "… · Was due {MMM D}" |
| submitted | "{total} hours · Submitted {MMM D, YYYY}", using `submittedOn` (server CalendarDate, workspace timezone, §4.14) |
| approved | "{total} hours · Approved {MMM D, YYYY}", using `reviewedOn` |

Right after a submit in this session, the submitted date is `state.today`.

**3. Returned banner**

Shown for rejected periods: an `Alert` (warning tone) "Returned for corrections", with `reviewComment` quoted. Shown once.

**4. Weekly notice** (`WeeklyNotice`), **exempt employees only** (UX3B-D3)
- Built from `weeklyTotals(days, hoursByDate, outsideWeekHours, workweekStartDay, today)`. Uses **complete weeks only**.
- **Under 40:** "Week of {MMM D}: {h} hours. Record all time worked, including leave."
- **Overtime:** "Week of {MMM D}: {o} hours over 40 (uncompensated)."
- Replaces the old exempt panel (`TimesheetToolbar.tsx:305-325`).

**5. Grid** (§4.2), with:
- the **"Add note" / "Edit note" button rendered by the grid component itself** (§4.8), above the table;
- a visible hint bar (`aria-hidden`) beneath it.

**6. "Past timesheets" link** → `/timesheet/history`, for every role.

**Removed:**
- `TimesheetDashboard`, and the page's `getEmployeeDashboardData` call;
- the duplicate returned alert;
- the "Semi-Monthly Timesheet" title;
- the "Current" button;
- the "Late" badges;
- the old exempt panel.

**`loading.tsx`** becomes a skeleton of the header band plus the grid.

**Submit availability:**
period editable (draft or rejected, not read-only, not loading)
∧ ¬`hasUnsaved`
∧ the period has hours
∧ `!isBefore(state.today, submitOpensOn)`.

**`useSubmitChecks()`:**
- keeps `completenessWarnings` exactly;
- keeps the certification and exempt wording;
- computes the **SubmitModal overtime figure** as Σ over **every week touching the period** of max(0, known week total − 40). Week boundaries use the workspace workweek from `weeklyTotals`, and incomplete weeks are included, which matches today's meaning;
- `totalPeriodHours` = `periodProgress.total`.

### 4.2 Grid structure
```
div.scroller  style="--ts-rh: clamp(9rem, 28vw, 16rem)"
 table role="grid" aria-labelledby="{id}-cap" aria-describedby="{id}-keys"
  caption id="{id}-cap" class=sr-only  "Hours for {Oct 16 to 31, 2026}, {Draft}"
  thead > tr
    th scope="col" class=corner        "Charge code"
    th scope="col" id="{id}-ch-{d}"    [aria-hidden] <span>Mon</span><span>{Oct 19 | Today}</span>   (no meter, §14)
                                       [sr-only] "Monday Oct 19[, today], {h} hours[, no hours logged]"
                                       <span id="{id}-chn-{d}" hidden>Monday Oct 19</span>
    th scope="col" id="{id}-ch-total"  "Total"
  tbody (one per non-empty group: "Direct", then "Indirect and leave")
   tr class=group > th scope="rowgroup" colspan={visibleDays+2}  "Direct"
   tr
    th scope="row" id="{id}-rh-{rowKey}" data-r={r} data-c="rh" tabIndex={active?0:-1}
       <span class=code>{code}</span> <span class=name>{rowName(cc)}</span> [<span>{CLOSED_TO_NEW_HOURS}</span>]
    td role="gridcell" data-r={r} data-c={dayIndex} tabIndex={active?0:-1} [aria-readonly="true"] [aria-describedby="{why-id}"]
       <span class=value>{8.00 | empty}</span><span class=sr-only>{, unsaved}{, note}{, imported}</span>
    td role="gridcell" data-r={r} data-c="total" aria-readonly="true" tabIndex={active?0:-1}  {row total}
  tfoot > tr
    th scope="row" id="{id}-rh-foot" data-r="foot" data-c="rh" tabIndex={active?0:-1}  "Daily total"
    td role="gridcell" data-r="foot" data-c={d} aria-readonly="true" tabIndex={active?0:-1}  {8.00}[sr ", no hours, past workday"]
    td role="gridcell" data-r="foot" data-c="total" aria-readonly="true" tabIndex={active?0:-1}  {grand total}
 p id="{id}-keys" class=sr-only  "Arrow keys move between days and codes. Type a number to enter hours. Press N to add a note. Escape undoes the cell."
 hidden: {id}-why-future "Future date. Hours can't be entered yet." · {id}-why-closed "{CLOSED_TO_NEW_HOURS}. You can correct hours already recorded." · {id}-why-locked "This timesheet is {submitted|approved} and can't be changed." · {id}-why-readonly "This workspace is read-only." · {id}-why-total "Totals are calculated."
 div id="{id}-err" (visible when present)
```

**Rules:**
- `{id}` comes from `useId()`.
- Hours always show 2 decimals; an empty cell has no text.
- **`aria-readonly="true"`** goes on:
  - future cells;
  - closed cells that can't be corrected;
  - total cells;
  - every day cell, when the period isn't editable, is loading, or the workspace is read-only.

  Row headers don't get it. **Never use `aria-disabled` on cells.**
- Imported provenance gets a per-cell hidden description.
- **`rowName(cc)` = `cc.name`** (§4.14).
- `CLOSED_TO_NEW_HOURS` = "Closed to new hours", from `src/lib/timesheet/copy.ts`.
- "No hours logged" applies only to past weekdays on or after `userCreatedOn`.

### 4.3 Keyboard model

**Positions**
- **Rows:** body rows in order, then `'foot'`.
- **Columns:** `'rh'`, then the visible day indexes, then `'total'`.
- Group rows and the `thead` aren't positions.

**Active position (exactly one tab stop)**
- **Grid-local state:** `{ requested: { r, c }, mode: 'nav' | 'edit', week, seed }`.
- **During render** the grid derives `active = clamp(requested)`:
  - snap `r` into range, or to `'foot'` if there are no body rows;
  - snap `c` to the nearest visible column in that row.
- **Every handler moves from `active`,** not `requested`.
- **Initial position:**
  - the first body row at today's column, if today is in the period;
  - otherwise the first visible day;
  - with no body rows, `('foot', 'rh')`.
- `active` is the only element with `tabIndex=0`.

**Modifier rule.** Navigation keys, N, Delete, digits and Space act only when no Ctrl, Meta or Alt is held. The exception is Ctrl+Home/End and Meta+Home/End. So Alt+← and ⌘+← (browser Back) pass through. Every handled key calls `preventDefault()`.

**Navigation mode**

| Key | Action |
|---|---|
| ← / → | Previous or next column. Stop at the edges. **Week view, at a week edge:** switch to the adjacent week and continue; stop at the period edges. |
| ↑ / ↓ | Previous or next row (`'foot'` after the last body row). Stop at the edges. |
| Home / End | `'rh'` / `'total'` in the current row |
| Ctrl or Meta + Home / End | First day of the first body row / `('foot', 'total')`. Switches week in week view as needed. |
| PageUp / PageDown | On a **day column**: day −7 / +7, clamped to the first or last day of the period, switching week in week view. On `'rh'` or `'total'`: nothing. |
| Enter / F2 / Space | **Editable day cell:** edit (Enter and Space select all; F2 puts the caret at the end). **Read-only day cell:** announce its reason. **Total:** announce "Totals are calculated." **Row header:** nothing. Always `preventDefault`. |
| 0–9, `.` or `,` | **Editable day cell, not composing** (`!e.nativeEvent.isComposing && e.keyCode !== 229`): edit with the draft set to exactly that character, `,` stored as `.`. **Read-only day cell:** announce the reason. Elsewhere: nothing. |
| Delete / Backspace | **Editable day cell:** set to 0 and announce "Cleared". **Read-only day cell:** announce the reason. Elsewhere: nothing. |
| N or n | **Day cell:** open NoteModal for that cell. It's read-only when the note isn't editable (§4.8). |
| Esc | **Dirty day cell:** restore its saved value and announce "Restored to {v}" |
| Tab / Shift+Tab | Not prevented: leaves the grid |

**Edit mode**

One `<input>` lives inside the active cell only:
- `type="text"`, `inputMode="decimal"`, `enterKeyHint="done"`, `autoComplete="off"`;
- `aria-labelledby="{id}-rh-{rowKey} {id}-chn-{d}"`;
- while invalid, `aria-invalid="true"` and `aria-describedby="{id}-err"`.

While editing, the cell's `td` has `tabIndex=-1`.

| Key | Action |
|---|---|
| typing | `onChange`: NFKC, then `,` → `.`, then accept only `^\d{0,2}(\.\d{0,2})?$`; otherwise ignore the keystroke |
| Enter | **Valid:** commit and stay. **Invalid:** stay in edit, show the error, announce it assertively. |
| ↑ / ↓ | **Valid:** commit and move. **Invalid:** same as Enter. |
| ← / → | Move the caret (not handled) |
| Tab / Shift+Tab | **Valid:** commit and move right or left within the grid; on the last or first visible day, commit and let Tab leave the grid. **Invalid:** restore the earlier value, announce, and **let Tab leave the grid** natively. Never trap. |
| Esc | Discard the draft and return to navigation mode with the earlier value |
| blur | **Valid:** commit. **Invalid:** restore and announce "{v} isn't valid; restored {old}". |

- **Clicks inside the active input** are ignored by the table's click handler.
- **Enter, ↑, ↓, Tab and Esc** set `suppressBlurCommit` before moving focus.

**Commit rules** (a client mirror of the server):
- empty or `.` → 0;
- `Number.isInteger(v * 4)`;
- 0–24;
- the new day total across rows ≤ 24, **or** ≤ that day's **saved** total (L1).

**Error messages:**
- "Use quarter hours (.00, .25, .50 or .75)."
- "Hours must be between 0 and 24."
- "This day would total {n} hours. A day can't exceed 24."

**Mouse and touch.** Clicking makes a position active. Clicking an editable day cell enters edit mode with the text selected: `flushSync(() => setMode('edit'))`, then a synchronous `input.focus()` inside the handler.

**Period and view changes.** When `periodStart`, `syncGen` (§4.4) or the view changes:
- the grid resets `mode` to `'nav'` **during render**, using its own `setState`;
- it bumps a grid-local `cancelledGen` if a draft was open;
- an **effect keyed on `cancelledGen`** announces "Edit cancelled" (never during render).

**Handlers** are plain per-render closures on `<table>`. **No refs** except `suppressBlurCommit`, which is written only inside handlers.

**Grid imperative handle.** The grid exposes `focusActive()` via `useImperativeHandle`. The provider holds the ref for NoteModal.

### 4.4 State and data flow

**Page context vs period data**

`TimesheetPageData` becomes `{ ...pageContext, period }`:
- `pageContext` = `userId`, `today`, `readOnly`, `flsaExempt`;
- `period` = the whole `getTimesheetPeriod` result.

In `timesheet/page.tsx`, `today` comes from the `getTimesheetPeriod` result (it already computes it), not from a second `getWorkspaceToday()`.

**Initial state:**

```ts
useReducer(reducer, initialData, (d) =>
  reducer({ ...emptyState, ...pageContextOf(d) }, { type: 'SET_PERIOD_DATA', ...d.period }))
```

`SET_PERIOD_DATA` never changes page-context fields. A **`SET_PAGE_CONTEXT`** action updates `today`, `readOnly` and `flsaExempt`.

**`SET_PERIOD_DATA` sets these period fields:**
- `periodStart`, `numDays`, `periodConfig`;
- `periodEnd`, derived as `addDays(periodStart, numDays − 1)`;
- `chargeCodes`, `entries`, `savedEntries`, `savedCellRevisions`;
- `periodStatus`, `approvalBadge`;
- `notes`, `savedNotes`;
- `reviewComment`, `summary`, `submitOpensOn`;
- `workweekStartDay`, `outsideWeekHours`, `userCreatedOn`;
- `isCurrent`, `submittedOn`, `reviewedOn`.

**Generations**, both in reducer state:
- **`syncGen`** is bumped only by the render-time re-sync below.
- **`loadGen`** is bumped by `BEGIN_PERIOD_LOAD`.
- `showPeriod` results and failures carry the `loadGen` and `syncGen` they started with. The reducer ignores them if either differs, so the latest in-page load wins.
- `MARK_SAVED`'s stale guard compares `periodStart` **and** `syncGen`.

**Derived values:** `dirtyCells`, `dirtyNotes`, `hasUnsaved`, `unsavedCount`.

**`src/lib/timesheet/period-progress.ts`** (pure)

`periodProgress({ start, numDays, dailyHours, today, submitOpensOn })` returns `{ total, workdaysFilled, expectedWorkdays, dueDate }`:

| Field | Definition |
|---|---|
| `workdaysFilled` | Mon–Fri, ≤ today, day total > 0 |
| `expectedWorkdays` | Mon–Fri in the period, ≤ today |
| `dueDate` | `submitOpensOn` |
| `total` | rounded to 2 decimals |

- **Part A's `currentPeriodSummary` calls it.** Its output fields and the `submissionDeadline` format are unchanged, so UX-2 Home and T21 don't change.
- The client calls it with daily totals built from `state.entries`.

**Re-sync on RSC navigation** (same route, a new `initialData` object)

Triggers: the sidebar link, the guard's `router.push`, or Back/Forward.
- **During render**, compare `initialData` with the previous value held in `useState`. If it differs:
  1. set the new value;
  2. `dispatch({ type: 'SET_PAGE_CONTEXT', … })`;
  3. `dispatch({ type: 'SET_PERIOD_DATA', ...initialData.period, resync: true })`, which bumps `syncGen`.
- **No refs, storage or side effects during render.**
- If the confirm modal or ReasonModal is open, it closes and its promise settles `false` (an effect keyed on `syncGen`).
- **Unsaved edits are overwritten by a re-sync only on Back/Forward.** Other navigations pass the guard first. This is the documented gap that Part C closes (UX3B-D2).

**Rendering**
- One delegated `onKeyDown` and one `onClick` on `<table>`, reading `data-r` / `data-c`.
- **`memo(HourCell)` props:** `r`, `c`, `rowKey`, `gridId`, `value`, `savedValue`, `editable`, `whyId`, `hasNote`, `provenanceId`, `isActive`, `unsaved`, and `editor`. `editor` is a `<CellEditor/>` element only for the editing cell, otherwise `null`.
- `dispatch` lives in its own context.
- Rows are precomputed once per render as `Map(rowKey → …)`.

**`useSaveFlow()`** lives in the provider. ReasonModal and SubmitModal move into the provider. It exposes `requestSave(): Promise<boolean>`.

| Case | Behaviour |
|---|---|
| Start | `saveAll` is called through a ref updated in **`useLayoutEffect`** (refs are used here only because an `await` intervenes) |
| Success | Dispatch `MARK_SAVED` inside **`flushSync`**. Then re-check `hasUnsaved` through a ref updated in `useLayoutEffect`. If edits were made during the save, save again; otherwise resolve **true**. |
| ReasonModal Cancel | resolve **false** |
| Failure while ReasonModal is open | the modal stays open for retry, and the promise stays pending until success or Cancel |
| Failure without ReasonModal (lock, day total, conflict, network) | assertive error, resolve **false** |
| **Session expired** (`code === 'unauthenticated'`) | resolve **false**. Show an assertive Alert: "Your session expired. Your changes aren't saved yet. Sign in again in a new tab, then come back and press Save." Its **"Sign in (new tab)"** link has `target="_blank"` to `/login?next={encodeURIComponent(pathname+search)}`. The guard's link listener ignores `_blank`. The session cookie is shared, so Save then works in this tab. |
| A save already running | await it, then apply the same re-check |

`DISCARD_CHANGES` is also dispatched inside `flushSync`.

### 4.5 Announcements

**`TimesheetAnnouncer`** renders two regions, **empty at mount**: `role="status"` (polite) and `role="alert"` (assertive).

**`announce(msg, level)`** clears the region, then sets the text after about 50 ms, so a repeated message is re-read. It's called **only from effects and event handlers, never during render**.

| Level | Messages |
|---|---|
| Polite | read-only reasons; "Cleared"; "Restored to {v}"; "Edit cancelled"; "Saved" / "{n} changes saved"; "Showing {period label}, {status}"; "Submitted" |
| Assertive | validation errors; save, submit and period-load failures; conflicts; session expired |

- **Toasts never carry a live role.** Pass `role: undefined`, or wrap so Mantine's default `role="alert"` is replaced by none. The announcer does all speaking. Error toasts use `autoClose: false`.
- **No live region** on totals, the status line or the note counter.

### 4.6 Visual states (never color alone)

| State | Visual | Accessible |
|---|---|---|
| Unsaved | 2 px dashed bottom border plus a tint | sr ", unsaved"; header "{n} unsaved changes" |
| Imported | small import glyph | sr ", imported" plus a provenance description |
| Closed to new hours | diagonal hatch plus lock glyph on empty cells; row-header text | `aria-readonly` plus `why-closed` |
| Note | the cell's note trigger, shown and blue (§14) | sr ", note" |
| No hours on a past weekday | blank footer total (no meter, §14) | sr ", no hours logged" (on or after `userCreatedOn`) |
| Future | lighter **text** only | `aria-readonly` plus `why-future` |
| Today | header: blue top edge, blue bold day name, "Today" in place of the date; body: a light column tint (§14) | sr ", today" |
| Weekend | a faint body-cell tint (§14) | the day name |
| Invalid | red border plus visible `#err` text | `aria-invalid` on the **input** plus `aria-describedby` |

**Focus ring:**

```css
.cell:focus { outline: 2px solid light-dark(var(--mantine-color-signal-7), var(--mantine-color-signal-4)); outline-offset: -2px; box-shadow: inset 0 0 0 4px var(--mantine-color-body); }
```

### 4.7 Reflow and zoom
- **Remove** dense mode: `getDensity`, the ResizeObserver and the 10 px text. Minimum text is 0.875 rem.
- **Columns:** days `min-width: 3.5rem`; row header `width: var(--ts-rh)`; `border-collapse: separate`.
- **CSS:**

  ```css
  .page { --ts-chrome: 15rem; }
  .scroller { overflow: auto; max-height: max(18rem, calc(100dvh - var(--ts-chrome))); scroll-padding-top: 3.5rem; scroll-padding-left: var(--ts-rh); }
  .scroller thead th { position: sticky; top: 0; z-index: 2; }
  .scroller th[scope=row] { position: sticky; left: 0; z-index: 1; }
  .scroller thead th.corner { left: 0; z-index: 3; }
  @media (max-height: 40em), (max-width: 40em) {
    .scroller { max-height: none; }
    .scroller thead th, .scroller th[scope=row] { position: static; }
  }
  ```

- **No `overflow: hidden`** on the grid, its cells or their ancestors.
- **Delete the whole `globals.css:6-10` rule.**

**Week view** below 40 em width (`useMediaQuery('(max-width: 40em)', false)`; the first paint is the full grid):
- **Weeks** are aligned to `workweekStartDay ?? 0` and clipped to the period.
- **Week picker:** a `SegmentedControl` (`aria-label="Week"`) when there are ≤ 3 weeks. Otherwise a `Select` labelled "Week", so it never overflows at 320 px.
- **Columns:** only that week's day columns render; `data-c` stays the **period** day index.
- **Total** shows the period row total.
- **`week`** (grid-local) updates whenever the active **day** changes. It stays unchanged when the active column is `'rh'` or `'total'`.
- **Choosing a week** moves `requested.c` to **that week's first day**.
- **A view switch** keeps the active day, so the week follows it. Edits are cancelled (§4.3).

### 4.8 Notes UI
- **Note editability:** period editable (draft or rejected, not read-only, not loading) ∧ the date isn't in the future. **Whether the row is closed doesn't matter** (the server accepts notes on any shown row). This is today's rule.
- **Each day cell carries its own note trigger** (§14, v5.2). There is no note button above the table. N / n on a day cell also opens the note.
- **`NoteModal`** (replaces `DailyNoteModal`):
  - **always mounted**; toggles `opened` and keeps the last cell during the exit transition;
  - a `Textarea` labelled "Note", with `data-autofocus` and a non-live counter "{n}/1000";
  - buttons **Done**, **Cancel**, **Remove note** (sets `''`). Never "Save" on this button: it doesn't save;
  - under the textarea, a plain (non-live) hint linked by `aria-describedby`: "Your note is saved when you save your timesheet.";
  - read-only (Close only) when the note isn't editable;
  - Done writes into `notes` (dirty, so it joins the unsaved count). The timesheet Save saves it.
- **Before opening,** commit any edit. Use `returnFocus={false}`; `onExitTransitionEnd` calls `gridRef.current.focusActive()`.
- **A save with only note changes** doesn't open ReasonModal.

### 4.9 Unsaved-changes guard

**`src/lib/timesheet/unsaved-guard.ts`:**

```ts
type Registration = { token: symbol; getCount(): number; requestSave(): Promise<boolean>; discard(): void; openConfirm(n: number): Promise<'save' | 'discard' | 'cancel'> };
export function registerUnsavedGuard(r: Registration): () => void;
export function confirmLeave(): Promise<boolean>;
```

**Registration**
- The provider registers in a `useLayoutEffect` (functions read the latest state through refs updated in layout effects).
- The provider renders the confirm modal.
- **Unregister is token-checked.** It settles any pending confirm with `false` and clears the shared promise. The promise is bound to the token.

**`confirmLeave()`**

| Situation or choice | Result |
|---|---|
| nothing registered, or `getCount() === 0` | `true` |
| concurrent calls | share the token's promise |
| **`'save'`** | close the confirm, wait for its exit transition, then `await requestSave()` |
| **`'discard'`** | `discard()` (`DISCARD_CHANGES` in `flushSync`), then `true` |
| **`'cancel'`** (button, Esc or overlay) | `false` |

**Confirm modal**
- Title "You have {n} unsaved changes".
- Buttons: **Save and continue**, **Discard and continue** (red), **Cancel**.
- `returnFocus={false}`. On cancel, focus goes to the captured trigger if it's still mounted. The trigger is the clicked `<a>`, or the element that was focused when the guard ran. The fallback is the grid's active cell.

**Covered paths**

1. **In-page period changes** (‹, ›, Choose period, Today). Each awaits `confirmLeave()` first. On cancel, the Select snaps back.
2. **In-app links.** The **provider** installs one capture-phase `click` listener on `document`, and it's the only link mechanism. It acts on `e.target.closest('a[href]')` only when **all** of these hold:
   - `getCount() > 0`;
   - a primary click with no modifier keys;
   - no `download` attribute;
   - `target` is empty or `_self`;
   - same origin;
   - the href doesn't start with `#`;
   - it isn't the same pathname and search with only the hash differing.

   Then it calls `preventDefault()` and `await confirmLeave()`. On `true`: app paths → `router.push(href)`; other paths (`/api/...`) → `location.assign(href)`.
3. **Sign out:**

   ```ts
   if (!(await confirmLeave())) return;
   clearDesigneeNoticeDismissals();
   await signOut({ redirect: false });
   location.assign('/login');
   ```

4. **Tab close / reload.** A `beforeunload` listener is attached **while committed `hasUnsaved` is true**. An effect re-evaluates it after every commit: new edits re-arm it, and a save or discard removes it. The handler does `e.preventDefault(); e.returnValue = true`.
5. **Discard changes button.** A confirm "Discard {n} unsaved changes?" (red), then `DISCARD_CHANGES` in `flushSync`.

### 4.10 URL sync
An **effect keyed on the committed `periodStart`, `isCurrent` and `syncGen`** calls:

```ts
history.replaceState(null, '', isCurrent ? '/timesheet' : '/timesheet?period=' + periodStart)
```

- It runs only when the URL differs, never from a fetch continuation.
- On mount, it canonicalizes to the period actually rendered.

### 4.11 Past timesheets page (`/timesheet/history`)

**Server page** (`src/app/(app)/timesheet/history/page.tsx`):
- session guard: `return loginRedirect()`;
- `metadata.title = 'Past timesheets'`, with PageHeader "Past timesheets";
- **fetches page 0 on the server** (`getPastTimesheets({ page: 0 })`) and passes it, plus the workspace timezone, to the client.

**Client:**
- `useAppTable` with `enablePagination: false`, `enableGlobalFilter: false`, `enableSorting: false`.
- Dates are formatted deterministically with `formatCalendarDate(calendarDayOf(date, tz), 'MMM D, YYYY')`, so there's no hydration mismatch.

**Columns:**

| Column | Content |
|---|---|
| **Period** | Link to `/timesheet?period={start}`; the current period links to `/timesheet` and is suffixed "(current)" |
| **Status** | "Not submitted" (gray), "Submitted" (signal), "Approved" (success), "Returned" (red), plus `approvalBadge` text as given |
| **Hours** | 2 decimals |
| **Submitted** | date |
| **Reviewed** | date |
| **Comment** | preview |

**Load more and empty state**
- "Load more" calls `getPastTimesheets({ page })`. Rows are de-duplicated by `start`.
- Empty state: "No past timesheets yet."

**Nav:** the employee menu gains "Past timesheets" `/timesheet/history`, icon `history`. Update `nav-config.test.ts:28` and `app-navbar.test.tsx:96-98`. Approvers reach the page through the link on the timesheet.

### 4.12 Approvals drawer notes
- Cells with a note show the glyph plus sr ", note".
- Below the table, a "Notes" list built from the `notes` map (non-empty only), sorted by date then row: "{ddd, MMM D} · {code} {rowName} · {body}". If the row is missing, use "Removed code".
- The drawer's row label becomes `{cc.clin} {rowName(cc)}`.
- Treat a missing `notes` as `{}`. Update the `approvals-client.test.tsx:18` mock.

### 4.13 Copy
- Sentence case throughout.
- `CLOSED_TO_NEW_HOURS` comes from `copy.ts`.
- No meaning carried by an icon alone.

### 4.14 Read-shape additions (server; no rule changes)
1. **`selectedPeriodFacts`** (`internal/timesheet-period.ts`) returns `submittedOn` and `reviewedOn` as CalendarDates via `calendarDayOf(…, timeZone)`. `getTimesheetPeriod` returns them at the top level. It also returns the `today` it computes, and **`readOnly`** (from the tenant state it can read cheaply). The page uses those.
2. **`ChargeCode.name: string`** comes from `chargeCodes.name`, the indirect `name`, or the CLIN description. It's populated at all five construction sites (`actions/timesheet.ts:563,595,639,649,655`; tsc catches a missed one). Test fixtures gain `name`.

## 5. State tables

**Cell mode**

| Mode | Event | Next | Side effects |
|---|---|---|---|
| nav | navigation key (rule above) | nav (moved) | `preventDefault`; focus moves |
| nav | Enter / F2 / Space / digit on an editable day | edit | input focused synchronously; a digit seeds the draft exactly |
| nav | the same on a read-only day | nav | reason announced |
| nav | Enter / Space on a total | nav | "Totals are calculated." |
| nav | Delete on an editable day | nav | `SET_HOURS 0`; "Cleared" |
| nav | Esc on a dirty day | nav | `SET_HOURS saved`; "Restored to …" |
| nav | N on a day | modal | NoteModal opens |
| edit | Enter / ↑ / ↓, valid | nav (moved per key) | `suppressBlurCommit`; `SET_HOURS` once |
| edit | Tab, valid | nav (moved; leaves at the last or first day) | `suppressBlurCommit`; `SET_HOURS` once |
| edit | Enter / ↑ / ↓, invalid | edit | error shown; assertive |
| edit | Tab, invalid | **leaves the grid** | restore; announce |
| edit | Esc | nav | draft discarded |
| edit | blur, valid / invalid | nav | commit / restore and announce |
| modal | close (any way) | nav | `focusActive()` after the exit transition |
| any | `periodStart`, `syncGen` or view change | nav | edit cancelled (announced by an effect); position clamped |

**Notes**

| From | Event | To |
|---|---|---|
| clean | Done with a different body | dirty |
| dirty | timesheet Save ok | clean |
| dirty | Save fails | dirty |
| dirty | Discard | clean |
| dirty | Submit | blocked: "Save your changes first" |

**Unsaved guard**

| From | Event | Result |
|---|---|---|
| clean | navigate | proceed |
| unsaved | navigate | confirm opens |
| confirm | Save → saved, nothing left | proceed |
| confirm | Save → ReasonModal cancel, failure or session expired | stay |
| confirm | Discard | discard, proceed |
| confirm | Cancel, Esc or overlay | stay; the Select snaps back |
| any | provider unmounts, or `syncGen` changes, while a confirm or ReasonModal is pending | close; resolve `false` |

## 6. Failure modes

| Case | Behaviour |
|---|---|
| Save fails | ReasonModal stays open if it was used; otherwise an assertive message; everything stays dirty |
| Edits made during a save | the re-check saves again before proceeding |
| Session expired mid-edit | Save fails `unauthenticated`. The Alert offers "Sign in (new tab)"; after signing in there, Save works here and nothing is lost. |
| A period load fails (`showPeriod`) | assertive error; the current period stays shown and editable (generation-checked); ‹/› stay usable |
| **Back/Forward with unsaved edits** | **Known gap until Part C:** the re-sync overwrites the unsaved edits. A cached stale period may be shown; saving it is refused by the revision check (Part A) with "This timesheet changed…" and never corrupts data. |
| 400% zoom or a landscape phone | `max-height` and sticky positioning are lifted; week view |
| Uncommitted typing at reload | the browser prompts (`beforeunload`) only for committed edits. A draft still in the input isn't committed. Accepted. |

## 7. Platform limits
- **No new server calls** beyond `getPastTimesheets` on its page.
- **Render cost:** a commit re-renders only these grid cells (measured on cells): the changed cell, its row total, the footer day cell and the grand total. Non-cell components (header, status line, `WeeklyNotice`, Submit reason) also re-render, which is expected.

## 8. Blast radius

**Rewritten**

| From | To |
|---|---|
| `BiWeeklyTimesheetClient` | `TimesheetClient` |
| `BiWeeklyTable` | `TimesheetGrid` (+ `HourCell` with its note trigger, `CellEditor`, `RowHeaderCell`, `DayHeader`, `TotalCell`) |
| `TimesheetToolbar` | `TimesheetHeader`, `SaveSubmitControls`, `WeeklyNotice`, `useSubmitChecks` |
| `PayPeriodSelector` | `PeriodControl` |
| `DailyNoteModal` | `NoteModal` |
| `Timesheet.module.css` | rewritten |
| `TimesheetContext` | page-context split, `SET_PAGE_CONTEXT`, `syncGen` / `loadGen`, re-sync, `useSaveFlow` (with ReasonModal and SubmitModal), guard registration and link listener |

**Removed:** `TimesheetDashboard`; the old exempt panel.

**New:**
- `src/lib/timesheet/{unsaved-guard, period-progress, copy}.ts`;
- `TimesheetAnnouncer.tsx`;
- `RenderProbeContext` (a test-only counter hook);
- `timesheet/history/page.tsx` (+ client).

**Touched:**
- `timesheet/page.tsx`, `loading.tsx`;
- `PageHeader.tsx` (`below`);
- `sign-out.ts`;
- `internal/employee-dashboard.ts` (`periodProgress`);
- `internal/timesheet-period.ts`, `actions/timesheet.ts`, `types/timesheet.ts` (§4.14);
- `nav-config.ts`, `ApprovalsClient.tsx`, `globals.css`.

**Tests to update:**

| Test | Change |
|---|---|
| `grid-corrections` | source regexes repointed |
| `certified-small-items` | ReasonModal pin repointed; "NoteModal has no reason code" |
| `action-results-static` | |
| `icon-registry` | timesheet files use `Icons` and leave the allowlist |
| `timesheet-results`, `timesheet-notes-wiring` | mock `next/navigation`; new paths; `initialData` in the `{…pageContext, period}` shape; fixtures gain `name`. Or retire `timesheet-notes-wiring` with equivalent §9 coverage. |
| `grid-corrections` (unit fixtures) | `name` |
| `approvals-client` | `notes` in the mock |
| `nav-config.test.ts:28`, `app-navbar.test.tsx:96-98` | |
| `page-metadata` | 33 pages |
| `sign-out.test.ts` | call order |

## 9. Test matrix

**Dependencies:** add exact devDependencies `@testing-library/dom@10.4.0` and `@testing-library/user-event@14.6.1` (or the newest 10.4.x / 14.6.x, pinned exactly).
- Import `@testing-library/react` once in each new test file so it configures `act`. Don't wrap user-event calls in `act`.
- Render with a test theme: `Modal.extend({ defaultProps: { transitionProps: { duration: 0 } } })`.
- **Render counting:** `RenderProbeContext` (default `null`); cells call `useContext(RenderProbe)?.('cell', key)`.

| ID | Test | Scenario | Break-it |
|---|---|---|---|
| B-T1 | `unit/timesheet-grid-structure.test.tsx` | the §4.2 tree incl. `data-r`/`data-c` on row headers; `role=gridcell`; one `tabindex=0`; empty cells blank; `aria-readonly` placement; day-header sr text rules; no "Late" badge; `rowName` on indirect rows; axe clean | render divs |
| B-T2 | `unit/timesheet-grid-keyboard.test.tsx` (user-event) | every §4.3 navigation key; edges stop; group rows skipped; Tab leaves; handled keys `defaultPrevented`; **Alt+← and ⌘+← not handled**; PageUp/Down on `'rh'`/`'total'` do nothing; **exactly one `tabindex=0` after a period with fewer rows, after a week change, and with no body rows**; initial position at today | clamp only the column |
| B-T3 | same | typing **7** → draft exactly **"7"**; `,` seeds `.`; Enter/↑/↓/Tab commit once; edit-mode Esc discards **and blur doesn't commit**; nav-mode Esc restores and announces; Delete → 0 and "Cleared"; read-only Enter announces; Enter on a total announces; a click inside the input doesn't reselect; full-width digits; IME composing (and keyCode 229) doesn't seed | remove the seed `preventDefault` |
| B-T4 | same | 7.3 → stays in edit, `aria-invalid` on the input, visible `#err`, assertive; **invalid Tab restores and focus leaves the grid**; a day over 24 is blocked unless ≤ the saved total (L1); invalid blur restores | trap on invalid Tab |
| B-T5 | `unit/timesheet-notes-ui.test.tsx` | N/n and a cell's note trigger open NoteModal (§14 has the trigger rules); editable on a **closed** row; read-only when locked or future; the button reads "Done" (no button in NoteModal contains "Save") and the hint is its textarea's description; Done → dirty; Save sends `notes` only, with no ReasonModal; Remove → `''`; focus returns to the active cell for both openers; axe with the modal open | apply the hours-editability rule to notes |
| B-T6 | `unit/timesheet-page-layout.test.tsx` | one h1; `below` holds the period control; mounting with `flsaExempt: true, readOnly: true` keeps both (fixture with a complete week over 40 so the FLSA text shows; cells read-only); first mount shows server notes and the status line from `initialData`; the status line follows a commit; "Was due" for past drafts; `submittedOn`/`reviewedOn` used; returned banner; Submit reason precedence per §4.1, and **no `aria-describedby` when available**; Submit enables after `SET_TODAY`; the SubmitModal overtime figure **includes an incomplete final week** (today's meaning); WeeklyNotice is exempt-only and uses complete weeks; **focus stays on Save/Discard/Today/‹ after they become unavailable**; a Choose period value missing from the list is added; no dashboard; no old panel | use `disabled` on Save |
| B-T7 | `unit/timesheet-unsaved-guard.test.tsx` | confirm on ‹ → Save and continue (ok → moves; ReasonModal cancel → stays; failure without ReasonModal → stays); Discard and continue → moves and `beforeunload` is removed, **re-armed by the next edit**; Cancel or Esc → stays and the Select snaps back; link listener rules (only when count > 0; modifiers, `_blank`, `#main-content`, same-path hash ignored; Past timesheets link → **one** confirm); **provider unmount, or a `syncGen` change, with a confirm open → resolves false and a later sign-out isn't blocked**; sign-out awaits the confirm; a cancelable `beforeunload` is `defaultPrevented` only while dirty; `requestSave` re-saves edits made during a save without a conflict; **`unauthenticated` save → the Alert with a `target=_blank` sign-in link, and the edits stay dirty** | sign out first; or leave the promise pending |
| B-T8 | `unit/timesheet-url-sync.test.tsx` | `replaceState` from an effect on committed state (not `router.replace`); canonicalizes on mount; a late `showPeriod` response or failure after a newer load or a re-sync is ignored (`loadGen`/`syncGen`); **the latest of two quick ‹ clicks wins**; same-route re-sync: a probe child logging `periodStart` in `useLayoutEffect` **never logs the old period after the prop change**; edit mode resets on re-sync; **after ‹, exactly one `getTimesheetPeriod` call** | effect-based re-sync; or first-wins |
| B-T9 | `unit/timesheet-week-view.test.tsx` | narrow (`matchMedia` stub) → weeks aligned to the workweek and clipped; only that week's columns; ← at the week edge → previous week; PageDown → day + 7; choosing a week moves to its first day (one tab stop); **more than 3 weeks → a Select picker**; a view switch mid-edit cancels; Total is the period total | render all columns |
| B-T10 | `unit/timesheet-render-cost.test.tsx` | via `RenderProbeContext`: one commit re-renders only the §7 cell set | drop `memo` |
| B-T11 | `unit/past-timesheets-page.test.tsx` | server page 0 passed; rows; status words; `approvalBadge` as given; links (current → `/timesheet`); no pagination or search UI; Load more de-duplicates; deterministic dates in the passed timezone; empty state; axe; employee nav + `activeHref` | link without the period |
| B-T12 | `unit/approvals-notes.test.tsx` | notes list from the map; `{code} {rowName}` and the "Removed code" fallback; the row label uses `rowName`; cell glyph plus sr text; a missing `notes` doesn't crash | — |
| B-T13 | `unit/timesheet-css-static.test.ts` (static) | no `getDensity`; no font-size below 0.875 rem in timesheet CSS and no `size="xs"` in timesheet TSX; the scroller rule includes `max(18rem`, the corner z-index and the media override; `globals.css` has no html/body `overflow-x: hidden` or `max-width: 100vw` | — |
| B-T14 | `unit/timesheet-announcer.test.tsx` | both regions empty at mount; the status line and note counter aren't live; **toasts carry no live role and success is spoken once by the announcer**; error toasts don't auto-close; a repeated message is re-announced; "Edit cancelled" is announced from an effect | double-announce success |
| B-T15 | `unit/period-progress.test.ts` | cases (weekends and future excluded; totals across rows; `dueDate` = `submitOpensOn`; rounding); `currentPeriodSummary` imports it (static); Home/T21 numbers unchanged | — |
| B-T16 | `unit/timesheet-lint.test.ts` | the **ESLint Node API** over `src/components/timesheet/**` and `src/lib/timesheet/**` reports zero `react-hooks/refs` and `react-hooks/immutability` messages; no `globalThis.` writes in those files | — |

## 10. Verification

```bash
npx tsc --noEmit && npm run lint && npm run test && npm run test:tz && node --import tsx scripts/check-migration-safety.ts
```

**Product owner**, each separately:
1. the integration suite;
2. `npm run build && node scripts/check-build-trace.mjs`;
3. `npm run demo:local` twice.

**Browser checks** (light and dark), as Jane on `acme.localhost:3000`:

1. **Layout**
   - The grid starts near the top.
   - The period control sits under the "Timesheet" heading.
   - Status and actions are on the right.
   - No "—" in empty cells; each row is one line plus the code.
   - Every cell has visible row and column lines; day headers show "Today" and no meters; weekends are a faint tint; no blue mark on every row.
   - Hovering a cell shows its note icon; a cell with a note keeps a blue icon.
   - The weekly notice appears for exempt users only.
2. **Keyboard only**
   - Tab into the grid; arrows move.
   - Type `7.5` + Enter → "unsaved".
   - `7.3` → refused, with a message.
   - `7.3` + Tab → restored, and focus leaves the grid.
   - Esc restores a changed cell.
   - N opens a note; focus returns to the same cell.
   - Alt+← still goes Back.
   - Save and Discard keep focus after use.
3. **Unsaved guard**
   - Change a cell, then press ‹ → confirm.
   - Click Home in the sidebar → confirm.
   - Reload the tab → the browser warns.
   - Sign out → confirm first.
4. **Session expiry**
   - Edit a cell, then clear the session cookie in DevTools and press Save → "Your session expired…".
   - Sign in using the new-tab link, come back, press Save → saved.
5. **No sideways page scroll** on Home, Users and Charge codes at 1280 px with permanent scrollbars (macOS: Appearance → Show scroll bars: Always).
6. **Past timesheets**
   - Rows include "Not submitted" periods.
   - Clicking one opens it with `?period=`, and a reload keeps it.
7. **400% browser zoom** (and a narrow window)
   - Week view appears.
   - The grid stays visible and usable.
   - Nothing is clipped, and the week picker doesn't overflow.
8. **VoiceOver (Safari)**
   - Row, day and value are announced.
   - Moving across days announces the day.
   - The editor announces row and day.
   - Submit's reason is read.
   - "Saved" is spoken once.
9. **As Sarah:** Jane's submitted timesheet in Approvals lists the notes.

**Manual screen-reader script** (record the results in the audit). Run it with NVDA + Firefox, JAWS + Chrome (if available), and VoiceOver + Safari on macOS and iOS:
- focus mode;
- header announcements;
- state words;
- read-only reasons;
- the editor name;
- errors;
- the note round trip;
- the period-change announcement;
- Submit's reason;
- the save announcement;
- Quick Nav on and off.

## 11. Known traps
- **T-A** Don't use `NumberInput` in the grid.
- **T-B** iOS keyboard: call `focus()` synchronously in the gesture, via `flushSync`.
- **T-C** `preventDefault` on the seeding keystroke.
- **T-D** Suppress the blur commit after key commits.
- **T-E** Live regions are empty at mount, and only the announcer speaks. Toasts have no live role. Never call `announce` during render.
- **T-F** No `opacity` on focusable cells.
- **T-G** Sticky positioning needs a height-limited scroller with no `overflow: hidden` in between; both are lifted at narrow or short viewports.
- **T-H** Same-route navigation doesn't remount. Re-sync during render with dispatches only.
- **T-I** Generations: `loadGen` (latest load wins) and `syncGen` (re-sync). Never refs.
- **T-J** Modal focus: `returnFocus={false}` plus `focusActive()` after the exit transition. Keep modals mounted.
- **T-K** The mockup's `role="status"` summary is deliberately not used.
- **T-L** `user-event` needs `@testing-library/dom`.
- **T-M** No ref reads or writes and no storage calls during render. Refs are allowed only across an `await` (`saveAll`, `hasUnsaved`) and are updated in `useLayoutEffect`. No global mutation in components.
- **T-N** Commit `MARK_SAVED` / `DISCARD_CHANGES` with `flushSync` before any re-check.
- **T-O** Page-context fields must survive initialization and period loads.
- **T-P** Exactly one tab stop: derive the clamp during render. Never use `disabled` on focusable controls; use `aria-disabled` plus a guard.
- **T-Q** Don't edit Terms or Privacy. Never use the demo tenants for destructive or repro tests.

## 12. Dev-agent hand-off rules
Follow `BLUEPRINT-STANDARD.md` §3.

**Before coding,** write the impact analysis, including how Part A's old-grid wiring maps into the new components. Stop and ask if anything doesn't match the code.

**Commit order:**
1. State and data (page context, `SET_PAGE_CONTEXT`, generations, §4.14, `period-progress`, context split, `useSaveFlow`) — B-T6 init parts, B-T15.
2. Grid structure and visuals — B-T1, B-T10, B-T14.
3. Keyboard and editing — B-T2–B-T4.
4. Notes UI — B-T5.
5. Page layout, `PageHeader` `below`, status line, weekly notice, Submit reasons, URL sync, re-sync — B-T6, B-T8.
6. Unsaved guard (incl. sign-out and session expiry) — B-T7.
7. Reflow, week view, `globals.css` — B-T9, B-T13.
8. Past timesheets page, nav, Approvals notes — B-T11, B-T12.
9. Lint guard — B-T16.

**Don't push.** Report the break-its, the pre-existing tests changed and why, the lint count, and anything you couldn't run.

## 13. Pre-mortem record

| Version | Findings |
|---|---|
| Draft in `feature-plan-ux-timesheet.md` | round 1: 4 HIGH / 10 MEDIUM; round 2: 4 HIGH / 7 MEDIUM |
| v3 (self-contained rewrite) | round 1: 12 HIGH / 17 MEDIUM |
| v4 | round 2: 5 HIGH / 20 MEDIUM |

**Every v4 HIGH sat in the Back/Forward draft and page-open refresh subsystem:** a refresh loop, wrong-period restore, an unanchored prompt, a stuck refresh failure, and URL-sync ordering.

**Product owner decision (UX3B-D2):** split that subsystem into **Part C**. Removing it eliminates all of those HIGHs.

**v5 applies every remaining finding:**
- latest-wins `loadGen`;
- the `MARK_SAVED` `syncGen` guard;
- the note button inside the grid, plus the `focusActive` handle;
- week state and PageUp/PageDown definitions;
- per-render handlers (refs only across awaits, updated in layout effects);
- announcements from effects only;
- `aria-disabled` everywhere a control could lose focus;
- the SubmitModal overtime meaning kept;
- the exempt-only notice (UX3B-D3);
- toasts without live roles;
- a lint guard via the ESLint API;
- a Select week picker above 3 weeks;
- session-expiry recovery (sign in from a new tab);
- page-context refresh via the `getTimesheetPeriod` `today` / `readOnly`;
- LOWs: line numbers, fixtures, invalid Tab, `,` seed, corner header, missing Select option, `periodConfig`, "Was due", rounding.

**Two-round limit reached; handed off as FINAL.** Anything left is caught in the code audit.

**v5.1 (2026-10-28):** in the Part A browser check, a note was lost on reload. The likely cause: the old modal's "Save Note" button only updates the working copy, so it reads as if it had saved. NoteModal's button becomes **Done**, with a hint that the timesheet Save saves it. The §4.9 guard also warns on reload.


## 14. v5.2 visual revision (2026-10-28)

**Why:** in the product owner's browser review of the implemented grid, these made the grid harder to use than the old one:
- no column lines, so it was hard to tell which cell you're in;
- notes reachable only through a key or a button above the table;
- a bright weekend stripe;
- a blue dash on every row for today;
- busy meters under the day names.

The product owner approved `ux-mockups/timesheet-grid-v2.html`. **Match it.** Behaviour, keyboard, state, the single tab stop and every audit fix stay exactly as built. This changes looks and the note entry point only.

**Product owner decisions:** empty cells stay blank. **No row striping** (lead ruling: the lines already separate rows, and stripes would compete with the weekend and today tints).

### 14.1 Lines and structure (`Timesheet.module.css`)
- **Every** `th`/`td` in the table gets `border-inline-end: 1px solid var(--line)` and `border-block-end: 1px solid var(--line)`.
- **Heavier lines** (`2px solid var(--line-strong)`): after the row-header column, before the Total column, under the column headers, and above the footer.
- The scroller keeps its current rules (sticky header and row header, `max(18rem…)`, the narrow and short media overrides). It gains a `1px solid var(--line-strong)` outer border and `border-radius: var(--mantine-radius-md)`. `overflow` stays `auto`: never `hidden` (T-G).
- Day cells: `min-block-size: 2.875rem`, centered tabular numbers, 2 decimals, blank when 0 (unchanged).
- Define the tokens once on `.page`:
  ```css
  .page {
    --line: var(--mantine-color-default-border);
    --line-strong: light-dark(var(--mantine-color-gray-4), var(--mantine-color-dark-3));
    --weekend: light-dark(var(--mantine-color-gray-0), color-mix(in srgb, var(--mantine-color-body) 85%, black));
    --today-tint: color-mix(in srgb, var(--mantine-color-signal-6) 9%, transparent);
    --hover-tint: light-dark(var(--mantine-color-signal-0), color-mix(in srgb, var(--mantine-color-signal-6) 18%, transparent));
    --group: light-dark(var(--mantine-color-gray-1), color-mix(in srgb, var(--mantine-color-body) 92%, white));
  }
  ```

### 14.2 Tints and states
| Element | Rule |
|---|---|
| Weekend | body day cells only: `background: var(--weekend)`. Not the header, group rows or footer. **Remove** the `default-hover` weekend rule. |
| Today | header: `border-block-start: 3px solid var(--mantine-color-signal-6)`, day name and "Today" in `light-dark(signal-7, signal-4)`, weight 700. Body day cells: `background: var(--today-tint)`. **Delete `.todayCol`'s inset box-shadow** (the per-row dash). |
| Hover | `@media (hover: hover)`: an editable day cell under the pointer gets `var(--hover-tint)`. Never on future or read-only cells. |
| Active / focus | the existing §4.6 focus ring, unchanged. |
| Unsaved | the existing tint plus a 2 px dashed bottom line inset 4 px. The dash colour is `light-dark(warning-8, warning-4)` (audit M3). |
| Closed | the existing hatch; the lock glyph moves to the top-left corner. |
| Future | dimmed text in the header and cells; no hover tint; no trigger unless a note exists. |
| Group row ("Direct", "Indirect and leave") | `background: var(--group)`; label `0.875rem`, weight 700, `var(--mantine-color-dimmed)`; **no vertical lines** inside the group row. |
| Day header | day name (weight 600) on line 1, date or "Today" on line 2 (dimmed, weight 500). **Delete the meter** (`.meter`, `.meterFill` and their markup). The sr text is unchanged, including ", no hours logged". |

**Text contrast:** every text colour above must be ≥ 4.5:1 in both schemes; non-text marks (the today edge, lines next to the focus ring) ≥ 3:1. Never use a `-filled` colour for text (audit M3).

### 14.3 Row header
- **Line 1:** the row name (`rowName`, already de-duplicated by L13), weight 600.
- **Line 2:** the code as a chip: `display: inline-block; font-family: var(--mantine-font-family-monospace); font-size: 0.875rem; font-weight: 500; padding: 0 0.375rem; border-radius: var(--mantine-radius-xs); background: light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-5)); color: var(--mantine-color-text)`.
- A row with no name shows the code chip alone, with no empty line.
- "Closed to new hours" stays on its own line below (audit M3 colours).
- The DOM order is name, then code. The row header's accessible name becomes "{name} {code}". Update the editor's `aria-labelledby` expectations in tests only if they assert the order; the ids are unchanged.

### 14.4 The per-cell note trigger (replaces the note button above the table)
**Markup.** Inside each day `td`, after the value:
```tsx
{showTrigger && (
  <span className={styles.noteTrigger} data-note-trigger aria-hidden="true" title={hasNote ? 'Edit note' : 'Add note'}>
    <Icons.note size={14} />
  </span>
)}
```
- It's a `span`, **not a button**: no `tabIndex`, no role, `aria-hidden`.
- The **grid has exactly one tab stop**, as before. Screen-reader and keyboard users use N / n (unchanged) and hear ", note" on cells that have one. The trigger is a pointer convenience with a full keyboard equivalent (WCAG 2.1.1 satisfied).

**When it renders:** `showTrigger = noteViewable && (hasNote || isActive || pointerHover)`.
- `noteViewable` = the note is editable (§4.8 rule), or it exists (read-only view).
- `isActive` = the active cell, including while editing.
- `pointerHover` is pure CSS: render the trigger whenever `noteViewable`, hide it with CSS unless `.hasNote`, `[data-active]` or `@media (hover: hover)` `:hover`. Don't add hover state in React.
- So `HourCell` gets one new boolean prop, `noteViewable`, and the cell gets `data-active` when active. Memo stays on plain props.

**CSS:**
- `position: absolute; inset-block-start: 2px; inset-inline-end: 2px; inline-size: 1.5rem; block-size: 1.5rem; display: grid; place-items: center; border-radius: var(--mantine-radius-xs); cursor: pointer; color: var(--mantine-color-dimmed)`.
- `.hasNote .noteTrigger { color: light-dark(var(--mantine-color-signal-7), var(--mantine-color-signal-4)); }`
- Hover: `background: var(--mantine-color-default-hover)`.
- The import glyph moves to the **top-left** corner. The old note glyph in `.glyphs` is removed (the trigger replaces it).

**Click handling** (in the existing delegated `handleClick`, before the cell logic):
1. If the click target is inside `[data-note-trigger]`:
   - run the H1 blur path when editing a different cell (or the same cell: commit or restore the draft first, exactly as a blur would);
   - set the requested position to that cell **without entering edit mode**;
   - `openNote(row, d)`.

   Focus then returns to that cell on close, through the existing `focusActive()` after the exit transition.
2. A pointer-down on the trigger must not start an edit. Call `preventDefault()` on `mousedown` for `[data-note-trigger]`, so the cell's focus-then-edit path doesn't run first.

**Remove:**
- the note button above the table (`noteBar`), its `aria-label` logic and "Choose a day cell first";
- `.noteBar` CSS.

### 14.5 Hint line and weekly notice
- **Visible hint** above the grid (`aria-hidden`, as now): "Click a cell or type a number to enter hours. Hover a cell to add a note, or press N."
- The grid's `aria-describedby` keys text (`{id}-keys`, sr-only) stays: "Arrow keys move. Type a number to enter hours. N adds or edits a note. Escape undoes the cell."
- **WeeklyNotice** keeps its content and rules (exempt only, complete weeks). It is no longer a Mantine `Alert`:
  - one `<p role="note" data-testid="weekly-notice">`;
  - an `aria-hidden` info icon, then the lines joined with " · ";
  - styled `border: 1px solid var(--line); border-inline-start: 3px solid var(--mantine-color-signal-6); border-radius: var(--mantine-radius-sm); padding: 0.5rem 0.75rem; background: light-dark(var(--mantine-color-gray-0), color-mix(in srgb, var(--mantine-color-body) 92%, white)); font-size: 0.875rem; color: var(--mantine-color-text)`.

### 14.6 Tests (update; each must fail when its rule is reverted)
- **B-T1:**
  - no button above the table;
  - no meter element in day headers;
  - group rows have no vertical-line class;
  - row header DOM order is name, then code chip;
  - axe passes with a trigger visible.
- **B-T2:** exactly one tab stop with triggers rendered: `querySelectorAll('[tabindex="0"]')` inside the grid area = 1, and no trigger is focusable.
- **B-T5, rewritten for the trigger:**
  - a click on a cell's trigger opens NoteModal for **that** cell and doesn't enter edit mode;
  - while editing another cell, a trigger click commits that draft once (H1 path), then opens the note;
  - a future empty cell renders no trigger;
  - a locked period shows a trigger only on cells with a note, and opens read-only;
  - N/n unchanged;
  - focus returns to the trigger's cell after Done and Cancel;
  - `hasNote` cells keep the trigger with the note class.
- **B-T13 (static):**
  - no `.meter`;
  - no `box-shadow` in `.todayCol` (or no `.todayCol` at all);
  - the weekend rule doesn't use `default-hover`;
  - `.cell` (or `th, td`) declares `border-inline-end`;
  - no `-filled` variable as a text `color`;
  - no `noteBar`.
- **B-T6:** WeeklyNotice is a `p[role="note"]`, not an Alert.
- **B-T14:** unchanged.
- **Render cost (B-T10):** a commit still re-renders only the four expected cells. `noteViewable` must not depend on hover state.

### 14.7 Browser check (product owner, §10 item 1, replaced)
In light and dark, at 1280 px and at 400 % zoom (week view):
- every cell has row and column lines;
- weekends are faint;
- today is a blue top edge plus a faint column, with no blue mark on each row;
- hovering a cell shows the note icon; clicking it opens the note for that cell; a saved note leaves a blue icon;
- no meters, no "Add note" button;
- the overtime notice is one slim line;
- the result looks like `ux-mockups/timesheet-grid-v2.html`.


## 15. v5.3: compiled-CSS colours and one scroll container (2026-10-28)

**Found in the product owner's browser pass of v5.2:**
- no row or column lines;
- no weekend tint, group band, chip background or notice border;
- "Today" not blue;
- the page and the grid both scroll.

### 15.1 Root cause: `light-dark()` in `.css` files never works in this build
- **What happens:** Turbopack's Lightning CSS compiles `light-dark(A, B)` to `var(--lightningcss-light, A) var(--lightningcss-dark, B)`. It defines those two variables only where it compiles a `color-scheme` declaration. Mantine sets the scheme with the `data-mantine-color-scheme` attribute, so the variables are never defined. The value becomes `A B` (two colours), which is invalid, and the browser drops the whole declaration.
- **Verified** in `.next/dev/static/chunks/src_components_timesheet_Timesheet_module_*.css`.
- **Not affected:** `light-dark()` in inline styles and Mantine style props (`theme.ts` `INDICATOR_COLOR`, `AuditTrailClient.tsx`) never passes through Lightning CSS, so it works natively.
- **Also broken on `main`:**
  - `globals.css:35`: UX-1's dark-mode input focus ring (a 508 contrast fix that has never been active);
  - `RowActions.module.css:5`: the danger hover;
  - `Home.module.css:15,23,30`.

**Fix, deterministic and not tied to Lightning CSS internals:** no `light-dark()` in any `src/**/*.css`. Use explicit scheme selectors.
- **Tokens:** define the light value on the class, and the dark value in an override rule placed after it:
  ```css
  .page {
    --line: var(--mantine-color-ink-2);
    --line-strong: var(--mantine-color-ink-3);
    --weekend: var(--mantine-color-gray-0);
    --hover-tint: var(--mantine-color-signal-0);
    --group: var(--mantine-color-gray-1);
    --chip: var(--mantine-color-gray-1);
    --accent-text: var(--mantine-color-signal-7);
    --warn-text: var(--mantine-color-warning-8);
    --unsaved-bg: var(--mantine-color-warning-0);
    --notice-bg: var(--mantine-color-gray-0);
    --today-tint: color-mix(in srgb, var(--mantine-color-signal-6) 9%, transparent);
  }
  :global([data-mantine-color-scheme='dark']) .page {
    --line: var(--mantine-color-dark-5);
    --line-strong: var(--mantine-color-dark-4);
    --weekend: color-mix(in srgb, var(--mantine-color-body) 85%, black);
    --hover-tint: color-mix(in srgb, var(--mantine-color-signal-6) 18%, transparent);
    --group: color-mix(in srgb, var(--mantine-color-body) 92%, white);
    --chip: var(--mantine-color-dark-5);
    --accent-text: var(--mantine-color-signal-4);
    --warn-text: var(--mantine-color-warning-4);
    --unsaved-bg: var(--mantine-color-dark-6);
    --notice-bg: color-mix(in srgb, var(--mantine-color-body) 92%, white);
  }
  ```
  Every former `light-dark()` in `Timesheet.module.css` uses one of these tokens. That covers the focus ring, the today header text, the trigger with a note, the closed note, the unsaved dash, the grand total, the chip and the notice. The values are the same as §14 and audit M3, only spelled differently.
- **`globals.css:35`:** move the dark value into the existing `:root[data-mantine-color-scheme='dark'] …` rule; the light value goes in the plain rule.
- **`RowActions.module.css`, `Home.module.css`:** the same pattern (light on the class; `:global([data-mantine-color-scheme='dark']) .cls` for dark).

**Guards:**
- **Static unit test** `unit/css-no-light-dark.test.ts`: no `light-dark(` in any `src/**/*.css`. Inline TS/TSX usage is allowed.
- **Build-output check** `scripts/check-css-output.mjs`: after `npm run build`, scan `.next/static/**/*.css` and fail if any contains `--lightningcss-`. Print the file. Add it to the product owner's verification right after the build-trace check.
- **Lesson for visual checks:** compare against the **compiled** CSS (a real `next dev` or `next build`). A static render with raw CSS hides compiler transforms.

### 15.2 One scroll container: the page doesn't scroll, the grid fills the rest
**Problem:** the scroller's `max(18rem, calc(100dvh - var(--ts-chrome)))` with `--ts-chrome: 15rem` is shorter than the real chrome: the app header, padding, page header, status line, notice and hint, about 22–24rem. The page scrolls too, giving two nested scrollbars and wheel scrolling that switches between them.

**Fix (wide and tall viewports):**
```css
.page {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  block-size: calc(100dvh - var(--app-shell-header-offset, 0rem) - 2 * var(--app-shell-padding, 0rem));
  min-block-size: 0;
}
.page > * { flex: 0 0 auto; }
.page > .gridSlot { flex: 1 1 auto; min-block-size: 0; display: flex; flex-direction: column; }
.gridArea { flex: 1 1 auto; min-block-size: 0; }
.scroller { flex: 1 1 auto; min-block-size: 18rem; max-height: none; }
```
- **`gridSlot`** is a wrapper `div` in `TimesheetClient` around `<TimesheetGrid/>`. The "Past timesheets" link moves into the header area (next to the status line). That way only the grid flexes, and nothing sits below the scroller.
- **Delete `--ts-chrome`.**
- **Result:** at desktop sizes the page itself never scrolls. The grid fills the remaining height, scrolls in both directions, and keeps the sticky header and row header (T-G).
- **Short or narrow viewports** (the existing `@media (max-height: 40em), (max-width: 40em)` block): `.page { block-size: auto; }` and `.scroller { flex: none; min-block-size: 0; max-height: none; }`. The page scrolls normally and stickiness is lifted, as now (§4.7, 400 % zoom).
- **If a shell banner** (demo or read-only) adds height above the page, the page may scroll by that amount. That's acceptable; don't measure it.

### 15.3 Tests
- `css-no-light-dark` (above). Reverting one `light-dark(` must fail it.
- **B-T13 updates:**
  - `.page` has the dark override block defining every token used;
  - no `--ts-chrome`;
  - `.scroller` has `flex: 1 1 auto` and no `calc(100dvh` max-height;
  - the narrow/short media block resets `.page` `block-size: auto`.
- **B-T6:** the "Past timesheets" link is in the header area. The grid's wrapper has the `gridSlot` class and is the page's last child.

### 15.4 Product owner verification (adds to §14.7)
- `npm run build && node scripts/check-build-trace.mjs && node scripts/check-css-output.mjs` → all pass.
- **Dark and light at 1280 px:**
  - lines, weekend tint, section band and chip backgrounds all visible;
  - "Today" is blue;
  - only one scrollbar (the grid's); the page doesn't move when you scroll the grid;
  - the column header and row names stay pinned while scrolling.
- **Elsewhere:**
  - Home looks as designed in dark mode;
  - a red row-action menu item shows its hover;
  - the input focus ring in dark mode is light blue (UX-1 fix now active).


## 16. v5.4: editing polish (2026-10-28, product owner review)

**Product owner findings on v5.3:**
1. Clicking into a cell widens its column.
2. The hint "Hover a cell to add a note, or press N" is misleading: hovering doesn't add a note. Mouse users find the icon by hovering anyway, so the hint doesn't need to mention it.
3. The bright blue box around the input hides the note icon.

**Decisions (product owner):**
- **N stays as the keyboard way to open a note** (nav mode, unchanged: Section 508 / WCAG 2.1.1). The visible hint may mention it.
- For mouse users, the way to add a note is the note icon in the cell. The hover reveal works (confirmed by the product owner) and stays as is.

### 16.1 The editor overlays the cell and never changes layout
```css
.day { position: relative; }            /* already, for the trigger */
.editor {
  position: absolute;
  inset: 0;
  inline-size: 100%;
  block-size: 100%;
  min-inline-size: 0;
  box-sizing: border-box;
  margin: 0;
  padding: 0 0.25rem;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--mantine-color-text);
  font: inherit;
  text-align: center;
  outline: none;                         /* the cell's ring (16.2) shows focus */
}
.editor[aria-invalid='true'] { box-shadow: inset 0 0 0 2px var(--invalid); }
```
- Add `--invalid` to the `.page` tokens: red-7 light, red-5 dark (in the §15.1 dark override block).
- The visible `#err` text and `aria-invalid` are unchanged.
- **Delete `min-inline-size: 3rem`** from `.editor`; it was what widened the column.

### 16.2 One subtle ring, on the cell edge
Replace the §4.6 focus rule (no outline plus body-coloured inner ring):
```css
.page { --ring: var(--mantine-color-signal-6); }   /* both schemes: ≥ 3:1 on body, tints and hover (≈4.4:1 light, ≈3.7:1 dark) */
.cell:focus,
.day:focus-within {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--ring);
}
@media (forced-colors: active) {
  .cell:focus,
  .day:focus-within { outline: 2px solid CanvasText; outline-offset: -2px; }
}
```
- It's a `box-shadow`, so it paints under the cell's children: the note icon sits **on top of** the ring, never behind it.
- Row headers and totals use the same `.cell:focus` rule.

### 16.3 The note icon in the corner
- `.noteTrigger`: `inset-block-start: 1px; inset-inline-end: 1px; inline-size: 1.25rem; block-size: 1.25rem; z-index: 1;` with the icon at `size={14}`.
- Show/hide rules are unchanged: the cell has a note, is active, or is under the pointer (the hover reveal works; don't change it).

### 16.4 Copy
- **Visible hint above the grid:** "Click a cell to enter hours. Keyboard: arrow keys move, N adds a note." No "hover" wording anywhere. This is accurate: the arrow keys leave edit mode, and N works on a selected cell.
- **The sr-only keys description** (`{id}-keys`) stays: "Arrow keys move. Type a number to enter hours. N adds or edits a note. Escape undoes the cell."

### 16.5 Tests (each must fail when reverted)
- **B-T13 (static):**
  - `.editor` has `position: absolute`, `inset: 0` and no `min-inline-size` other than `0`;
  - the focus rule uses `box-shadow` with `var(--ring)`, plus a `forced-colors` outline fallback, and no `outline:` other than `none` outside that media block;
  - the trigger inset is `1px` with `z-index: 1`;
  - `--invalid` and `--ring` are defined (`--invalid` in both blocks).
- **B-T1:** the visible hint's text is exactly "Click a cell to enter hours. Keyboard: arrow keys move, N adds a note.", and no visible text in the timesheet page matches `/hover/i`. The sr keys description still mentions N.
- **B-T5:** N on a selected cell (nav mode) still opens the note; N while editing types nothing and opens nothing (unchanged behaviour, now pinned).

### 16.6 Product owner check
- **Click a cell and type:** the column doesn't change width, there's one thin blue ring on the cell edge, and the note icon sits in the corner, fully visible.
- **An invalid value** (`7.3`) shows a red ring and the message.
- **Hover a cell:** the note icon appears; click it to open the note.
- **The hint** reads "Click a cell to enter hours. Keyboard: arrow keys move, N adds a note."
- **Arrow keys to a cell, then N:** the note opens.
