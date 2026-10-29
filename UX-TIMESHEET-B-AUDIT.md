# UX-3 Part B (timesheet screen and accessible grid): lead audit of the implementation

**Audited:** branch `ux-timesheet-ui` at `2432b88` (9 commits on `main`) against `feature-plan-ux-timesheet-ui.md` **v5.1 FINAL**. **Date:** 2026-10-28.

**Method:**
- **Lead:** re-ran the gates.
- **Three independent auditors:**
  - grid, keyboard, notes, visuals and reflow;
  - state, save flow, guard, URL sync, session expiry and announcements;
  - server read shapes, other screens, security and regressions.

  Each ran its unit suites and mutated 4–11 behaviours to test the tests.
- **Lead verification:** H1, H3 and M2 checked against the code.
- **Product owner:** runs integration, the build and the browser and screen-reader checks (§4).

**Verdict: NOT READY TO MERGE. 3 HIGH, 8 MEDIUM; fix round 1 below.** The structure is sound. Exactly one tab stop held in every state tried, the validation mirrors the server, the generations and `MARK_SAVED` guard are correct, and security is unchanged. The HIGHs are edge paths, each with a concrete fix.

## 1. Gates and verified properties

| Check | Result |
|---|---|
| `tsc` / lint / unit | clean / 0 errors, 59 warnings (main: 63) / 146 files, 1753 pass (lead re-run) |
| Grid structure (§4.2) | caption, ids, `data-r`/`data-c`, explicit gridcells, rowgroups, footer, reasons, `aria-readonly` placement, editor name |
| One tab stop (§3, T-P) | held: initial, fewer rows, no rows, week switch, picker, edit mode, after invalid Tab, after Shift+Tab |
| Validation mirror | quarter hours, 0–24, day total ≤ 24 with the L1 exemption, same as `day-totals.ts:35` |
| Save flow (§4.4) | one consistent capture; `MARK_SAVED` in `flushSync` with the sent entries only; edits during a save are saved again; `periodStart` + `syncGen` stale guard; latest load wins |
| Guard (§4.9) | token-checked unregister settles `false`; one shared confirm; sign-out awaits; `beforeunload` only when dirty; the link listener ignores modifiers, `_blank`, `download`, cross-origin and hash links |
| URL sync | no loop with Next's patched `replaceState` |
| Security | `requireSession` first, own data only; review path unchanged (`assertCanAccessEmployee`); no new `'use server'` exports; clients import internals as types only |
| Removed components | no live imports; every old feature has a new home |
| Deps | exactly `@testing-library/dom@10.4.0` and `user-event@14.6.1`; lockfile consistent (`hasInstallScript` is a correct refresh) |

## 2. Rulings on the dev's gap decisions
All accepted:
- Toasts `role="none"`, page Alerts `role="note"`.
- SubmitModal text `xs` → `sm`.
- ‹ is never aria-disabled.
- The note textarea has a fixed `rows={4}`.
- The link guard also covers same-URL links without a hash.
- Load more: aria-disabled while loading, focus moves to the first new row, toolbars off.
- Approvals notes order and the `aria-labelledby` label.
- The smaller keyboard choices.

## 3. Fix round 1 (required before merge)

### H1 (HIGH): a click without a focus change discards the open draft
- **Where:** `TimesheetGrid.tsx:356-370`. Blueprint §3 inv. 1, §5 "edit | blur → commit".
- **Problem:** `handleClick` relies on mousedown moving focus, which blurs the editor and commits the draft. A screen-reader activation (VoiceOver double-tap, NVDA browse mode) or an iOS tap fires `click` without that blur. `flushSync(setRequested)` then moves the editor while `mode === 'edit'`, `enterEdit` resets the draft, and the focused input unmounts without onBlur.
- **Probe:** type `5` in 0:3, then `click(0:4)`. 0:3 stays 0, and nothing is announced.
- **Fix:** at the top of `handleClick`, when `mode === 'edit'` and the clicked position isn't the active one:
  - run the blur path explicitly: commit, or restore and announce when invalid, exactly as `handleEditorBlur`;
  - set `suppressBlurCommit.current = true` so a later native blur doesn't commit twice.
- **Test:** `fireEvent.click` with no prior focus or mousedown. A valid draft commits once; an invalid one is restored and announced.

### H2 (HIGH): Discard during an in-flight save does the opposite of what the user chose
- **Where:** `TimesheetContext.tsx:448-468` (re-check loop), `:500` (`discardChanges`), `unsaved-guard.ts:64`, `SaveSubmitControls.tsx:32`.
- **Scenario:**
  1. The user edits and presses Save (slow network).
  2. They press ‹ and choose "Discard and continue".
  3. The save lands and `MARK_SAVED` moves the baseline (same `periodStart`/`syncGen`, the load hasn't landed).
  4. The re-check sees the revert as unsaved and opens ReasonModal for period A while B loads.
  5. Confirming writes a revert revision. Cancelling leaves hours the user believes were discarded. Without a revision, the revert is sent with no ReasonModal at all.
- **Fix, all three:**
  1. Discard changes is aria-disabled (with a guard) while `isSaving`, with the reason "Saving…".
  2. `confirmLeave` first awaits the running save (`runningRef`), then reads the count. The confirm then shows only what is still unsaved, and nothing if the save covered everything.
  3. The re-check loop stops when `periodStart` or `syncGen` differ from the values captured when `requestSave` began.
- **Tests:**
  - Discard is aria-disabled while saving.
  - ‹ during a slow save waits, then navigates without a confirm once the save covers everything.
  - A save that lands after a period change neither moves the baseline nor opens ReasonModal.

### H3 (HIGH, DCAA): session-expiry recovery can save or submit to a different person's timesheet
- **Where:** `TimesheetContext.tsx:324` and `:610`; `actions/timesheet.ts:186-187`; `actions/periods.ts:117-124`.
- **Problem:** the recovery says "sign in in a new tab". If a different account signs in there (a shared PC, or one person with admin and employee accounts), Save in the old tab writes revision-1 cells and notes into the second user's timesheet. Submit certifies the second user's period. Both actions use whoever holds the session.
- **Fix (a small rule addition, ruled by the lead):**
  - `saveTimesheetBatch` and `submitPeriod` take a **required** `expectedUserId: string`.
  - After `requireSession()` and before any read or write: if `expectedUserId !== actor.id`, throw `UserFacingError(SESSION_USER_CHANGED)`, where `SESSION_USER_CHANGED = "You're signed in as a different person now. Reload this page to continue."`. Export the constant from a non-`'use server'` module (e.g. `src/lib/timesheet/copy.ts`).
  - The provider sends `state.userId`. On this error: keep edits dirty, announce assertively, and show it in the session alert with no sign-in link. Edits are never sent.
- **Tests:**
  - **Integration:** user A's id with user B's session is refused for both actions, and no `timesheet_entries`, `timesheet_notes` or `timesheet_periods` row is written. A matching id still saves and submits.
  - **Unit:** the provider sends `userId`; the mismatch path keeps edits dirty.
  - Update every existing caller and test.

### M1: focus drops to `<body>` when the focused editor or cell unmounts (§3 inv. 4)
Confirmed by probe in three cases:
- a window blur while editing;
- a view switch mid-edit (resize or zoom across 40em);
- a re-sync with fewer rows.

**Fix:**
- In `handleEditorBlur`, when `document.activeElement === e.currentTarget` (a window blur), `focusPos` the active td before leaving edit mode.
- Add a `useLayoutEffect` keyed on `cancelledGen` / `syncGen` / `narrow` that calls `focusActive()` when focus is on `body` and the grid held focus before.

**Tests:** assert `document.activeElement` in B-T9 (view switch) and B-T8 (re-sync).

### M2: the Save button gets the real `disabled` while saving
- **Where:** `SaveSubmitControls.tsx:45` uses `loading={state.isSaving}`, and Mantine sets `disabled: disabled || loading`.
- **Problem:** a keyboard user's focus drops to `<body>`.
- **Fix:** no `loading`. Show a `Loader` in `leftSection` with the label "Saving…", aria-disabled plus `isSaving` in the click guard.
- **Test:** the button never has the `disabled` attribute during a pending save. Same rule for any `loading` prop in timesheet TSX: extend B-T13 to ban `loading=` there.

### M3: two dark-mode contrast failures (WCAG 1.4.3)
- `.closedNote` uses `warning-filled`: 3.51:1.
- `.grand` uses `signal-filled`: 3.03:1.

**Fix:** use the `light-dark()` pairs already used for indicators: warning-8 / warning-4 and signal-7 / signal-4. Extend B-T13 to ban `-filled` as a text `color` in `Timesheet.module.css`.

### M4: the week picker truncates at 320 px (§4.7)
**Problem:** the SegmentedControl clips with ellipsis. A three-week semi-monthly period needs about 308 px in a 288 px box.

**Fix:** the week view always uses the **Select "Week"**, whatever the number of weeks (the SegmentedControl is dropped). Update B-T9.

### M5: the period change is never announced (§4.5)
**Problem:** after ‹, ›, Choose period or Today, the screen reader hears nothing.

**Fix:** an effect keyed on the committed `loadGen` announces "Showing {period label}, {status}" politely after an in-page load lands. Not on mount, and not on a re-sync.

**Test:** in B-T14.

### M6: reading and focus order put Save/Submit before the period control (WCAG 1.3.2, 2.4.3)
**Where:** `PageHeader.tsx:26` renders `below` after `actions`.

**Fix:** render `below` inside the title column, so the DOM order is h1 → period control → status/actions, matching the visual order.

**Test:** in B-T6, the tab order is ‹ before Save.

### M7: no tests cover the §4.14 server additions
**Fix:** in `integration/timesheet-read.test.ts`, assert:
- `submittedOn`/`reviewedOn` for a period submitted near midnight UTC, with the workspace zone not UTC (e.g. Pacific/Honolulu);
- `readOnly` with `getTenantState` returning `read_only`;
- `today`;
- `chargeCodes[].name` for direct, indirect (the name, not the category) and legacy CLIN rows.

### M8: test gaps found by mutation
Each test must fail when its behaviour is removed:
- A valid Tab at the last and first visible day leaves the grid (adding `preventDefault` there must fail).
- F2 puts the caret at the end; Space enters edit.
- A save landing after ‹ or after a re-sync doesn't move the baseline (removing the `MARK_SAVED` stale guard must fail).
- A re-sync with ReasonModal open resolves `false`.
- `download` and cross-origin links pass through the link listener.
- A re-sync applies `SET_PAGE_CONTEXT` (new `today`/`readOnly`).

### LOWs (cheap; same round)
- **L1** Nav-mode Esc restore runs the day-total check. If restoring would break it, announce the error and keep the value (`TimesheetGrid.tsx:333-338`).
- **L2** Enter/Space on a footer day total announces "Totals are calculated." (`:312`, add `|| active.r === 'foot'`).
- **L3** Cells read-only because a period is loading get the reason "Loading…" (`:158`).
- **L4** Tie SubmitModal to `syncGen`, as ReasonModal is (a re-sync closes it). Guard `SET_PERIOD_STATUS` on `periodStart` + `syncGen`.
- **L5** `handleReasonConfirm` captures its resolver at the start, so a late save can't resolve a newer modal.
- **L6** While a "Save and continue" is in flight, a second navigation request is ignored, not queued (only the first destination runs).
- **L7** SubmitModal Alerts use `role="note"` (`SubmitModal.tsx:57,68`).
- **L8** The session alert clears on Discard and on a period change.
- **L9** `SET_TODAY` sets `isCurrent = false` when the new today is after `periodEnd`, so the URL gains `?period=`.
- **L10** ReasonModal clears its fields only after a successful save, so a retry keeps the typed reason (pre-existing).
- **L11** Past timesheets: when Load more returns no new rows and `hasMore` is false, focus the last row's link.
- **L12** Past timesheets: every row links with `?period={start}`. "(current)" comes only from the latest response, and Load more refreshes page 0's current row if it changed.
- **L13** A row name that repeats its code isn't shown twice ("CLIN 0001 CLIN 0001"), in the grid and the drawer.
- **L14** The Past timesheets table gets `aria-label="Past timesheets"`. The drawer's "Notes" label becomes a heading (`component="h3"`, same look).
- **L15** `pastPeriods` labels use the timesheet's `periodLabel` format.
- **L16** Delete the now-unused `getEmployeeDashboardData` action and its type. Update `integration/calendar-dates-fixes.test.ts`.

**Recorded, no change:**
- after a re-sync, the requested row is kept by index, not by code (rare; M1 keeps focus safe);
- two quick ‹ clicks step back once (latest wins, by design).

## 4. Product owner runs (after fix round 1)
- Integration, **sourcing `.env` first** (the dev noted `test:integration` doesn't load it). Command in the hand-off message.
- `breakit-check-ux3b.mjs` (lead; written after the fix round lands: H3 and M7).
- `npm run build && node scripts/check-build-trace.mjs`; `npm run demo:local` twice.
- Browser and screen-reader checks: blueprint §10 items 1–9, plus:
  - a VoiceOver double-tap on another cell while editing keeps the typed value (H1);
  - ‹ during a slow save (DevTools → Network → Slow 3G) doesn't prompt for a reason (H2);
  - sign in as Sarah in the new-tab recovery, then Save in Jane's tab → refused (H3).

## 5. Fix round 1 verification (`2432b88..961f1aa`, 16 commits), 2026-10-28

**Lead gates:** `tsc` clean; lint 0 errors, 59 warnings; 150 files, 1805 pass.

**Lead read of the HIGH fixes:**
- **H1:** `handleClick` runs the blur path, sets `suppressBlurCommit`, focuses the active cell, then moves.
- **H2:** Discard is aria-disabled while saving. `confirmLeave` awaits `whenSaved()` and reads the count afterwards (no confirm when nothing is left). The re-check loop is bound to the `periodStart` + `syncGen` captured at the start.
- **H3:** the guard is the first statement after `requireSession()` in both actions. `expectedUserId` is required; the only callers are the provider's save and submit.

**Dev gap decisions, all accepted:**
- H1 also covers a click on the cell being edited.
- H3:
  - the client matches the error by message;
  - a missing id is refused;
  - a refused submit closes SubmitModal and shows the session alert.
- H2: Discard's "Saving…" reason is screen-reader text only.
- M2 extended to the ReasonModal and SubmitModal buttons; B-T13 bans `disabled=` and `loading=` in timesheet TSX.
- M5 uses a `shownLoadGen` field.
- L6 ignores a second leave request while saving.
- L8 clears the alert for good.
- L12 adds `currentStart` to each response. Its revert check can't be told apart once page 0 refreshes; accepted.
- One M1 test deleted as vacuous, with the mid-edit test covering it.
- The Part A `timesheet-notes-wiring` case moved its today inside the period, because of L9.

**Lead break-it script:** `breakit-check-ux3b.mjs`, 7 Postgres checks; `--dry-run` shows all edits apply.
- H3 save guard;
- H3 submit guard;
- M7 `submittedOn` / `reviewedOn` in UTC;
- M7 `readOnly` always false;
- M7 indirect name = category;
- M7 legacy CLIN name.

**Code audit: CLEAN pending the product owner's runs.**

## 6. Product owner visual review (2026-10-28): visual revision before merge

The product owner reviewed the implemented grid in the browser and found it a step backwards from the old grid:
- no column lines;
- notes only through N or a button above the table;
- a bright weekend stripe;
- a blue dash on every row for today;
- meters under the day names.

Some of this was in the approved mockup (the lead's design); some was drift (the weekend tint, the per-row today dash).

**Approved revision:** `ux-mockups/timesheet-grid-v2.html`, specified as blueprint **v5.2 §14**: full grid lines, a per-cell note trigger, quieter tints, no meters, a name-then-code row header, and a slim weekly notice. Blank cells (PO); no striping (lead).

**Merge gate:** §14 implemented, plus the PO's integration, `breakit-check-ux3b.mjs` and one full browser pass (§10 with §14.7).

## 7. v5.2 visual revision verification (`75ad93d`), 2026-10-28

**Lead gates:** `tsc` clean; lint 0 errors, 59 warnings; 150 files, 1820 pass.

**Dev revert checks:** 23/23 caught, including:
- the trigger as a focusable button (B-T2);
- a mouse-down with no `preventDefault` (B-T5);
- hover state in HourCell (B-T10).

**The dev's static render against the mockup** found the tint shorthand wiping the closed-row hatch. It's fixed and pinned.

**Dev gap decisions, all accepted:**
- **Line tokens:** `--line` ink-2 / dark-5 and `--line-strong` ink-3 / dark-4, because this theme's `default-border` is darker than the §14.1 strong token. Pinned so the separators stay darker than the cell lines.
- The corner header is bottom-aligned and totals are right-aligned (as the mockup).
- `block-size: 2.875rem` (table cells ignore `min-block-size`).
- The code chip follows §14.3 (the 0.875rem minimum) over the mockup's 11.5px.
- The weekend token is exact.
- The notice keeps its full stops.

**Postgres break-its (product owner run, logs in `.breakit-logs-ux3b/`):** 7/7 caught. Both baselines pass, and each mutation fails only its targeted test:
- H3 save guard;
- H3 submit guard;
- M7 `submittedOn` / `reviewedOn`;
- M7 `readOnly`;
- M7 indirect name;
- M7 CLIN name.

**Pending (product owner):**
- the full integration summary;
- build plus trace;
- `demo:local` ×2;
- the browser pass (§10 with §14.7: hover, the note trigger and the 400 % week view are browser-only).

## 8. Product owner browser pass of v5.2 (2026-10-28): v5.3 required

**Found:**
- no row or column lines;
- no tints, band or chip backgrounds;
- double scrolling.

**Root causes (lead, verified in `.next` compiled CSS):**
1. Lightning CSS compiles every `light-dark()` in `.css` files to a polyfill whose variables are never defined (Mantine sets the scheme by attribute), so the declaration is invalid and dropped. **This is app-wide and on `main`:** UX-1's dark input focus ring (`globals.css:35`), `RowActions` danger hover and `Home.module.css` have never been active.
2. The scroller reserved 15rem for the page chrome, which is really about 23rem, so the page and the grid both scroll.

**Fix:** blueprint v5.3 §15:
- explicit scheme selectors and tokens, with no `light-dark()` in CSS;
- a static guard plus a build-output check (`scripts/check-css-output.mjs`);
- the page fills the viewport with one scroll container.

The dev's static render missed the first cause because it used raw, uncompiled CSS. Lesson recorded.

## 9. v5.3 verification (`9f874c0`), 2026-10-28

**Lead gates:** `tsc` clean; lint 0 errors, 59 warnings; 151 files, 1824 pass. There's no `light-dark(` left in any `src/**/*.css` outside comments. The page height uses the AppShell offsets, and `--ts-chrome` is gone.

**Dev revert checks:** 15/15 caught. `check-css-output.mjs` flags the old dev chunks; it was exercised on clean and dirty CSS.

**Dev gap decisions, all accepted:**
- one commit;
- `theme-contrast.test.ts` reads the light and dark rules separately;
- `--today-tint` has no dark value (translucent, the same in both schemes);
- comments never spell out the function;
- `check-css-output.mjs` takes an optional directory.

**The compiled output is not yet verified** (the sandbox can't build). The product owner's `npm run build && … && node scripts/check-css-output.mjs` is the gate, then the §14.7 + §15.4 browser pass.

## 10. Product owner review of v5.3 (2026-10-28)

The compiled colours and lines now render, which confirms the §15.1 fix.

**Polish requested:**
- clicking a cell widened its column (the editor's `min-inline-size: 3rem`);
- the hint "Hover a cell to add a note, or press N" is misleading;
- a bright box around the input hid the note icon.

**Product owner decisions:**
- N stays as the keyboard path (Section 508), and the visible hint may mention it.
- The hover reveal works; only the "hover" wording goes.

**Blueprint v5.4 §16:**
- the editor overlays the cell;
- one `box-shadow` ring in signal-6, with a forced-colors fallback;
- the icon pinned in the corner above the ring;
- the hint "Click a cell to enter hours. Keyboard: arrow keys move, N adds a note."

## 11. v5.4 verification (`2a04813`), 2026-10-28

**Lead gates:** `tsc` clean; lint 0 errors, 59 warnings; 151 files, 1830 pass. No `light-dark(` in CSS.

**Dev revert checks:** 17/17 caught.

**Dev gap decisions, all accepted:**
- `--ring` is the same in both schemes and is exempt from the dark-value check;
- the visible-text scan ignores sr-only, hidden, caption and style/script content;
- the outline allowlist is `none` plus the forced-colors fallback.

**Product owner browser check:** a click doesn't widen the column, and the "hover" hint is gone.

**Remaining before merge:**
- the ring and icon look, `7.3` red ring, and N;
- the full integration suite;
- build plus `check-build-trace` plus `check-css-output`;
- `demo:local`.
