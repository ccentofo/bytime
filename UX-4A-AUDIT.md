# UX-4a (page bug fixes): lead audit of the implementation

**Audited:** branch `ux-page-fixes` at `da4861e` (14 commits on `main`) against `feature-plan-ux-page-fixes.md` **v3 FINAL**. **Date:** 2026-11-02.

**Method:**
- Lead gates.
- Two independent auditors:
  - ConfirmModal, C1–C6, C14–C16;
  - C7–C13, C17.

  Each read every change, ran the unit suites and mutated 8–13 behaviours.
- The product owner ran integration and `breakit-check-ux4a.mjs` (9 Postgres checks). The lead diagnosed the one failure through two instrumented runs.

**Verdict: NOT READY TO MERGE. No HIGH; 4 MEDIUM; fix round 1 below.** Every blueprint item is implemented as specified; the auditors verified each one line by line.

## 1. Results
| Check | Result |
|---|---|
| `tsc` / lint / unit (lead re-run) | clean / 0 errors, 56 warnings / 170 files, 1968 pass |
| Integration (product owner) | 599 pass, **1 fail** (T-C7e), 5 skipped |
| Postgres break-its | **6/6 caught** (T-C3d, T-C4b, T-C5c, T-C13b, T-C15c, T-C17c). The 3 pay-schedule checks were skipped because their file failed (T-C7e). |
| Auditor mutations | 19 of 21 caught (2 C1 token paths uncaught; see L2) |

## 2. T-C7e diagnosis (lead, two instrumented runs)
- **Run 1:** only one advisory waiter, while the saves were "still pending".
- **Run 2, per save:**
  - save A waits on `Lock:advisory` (`pg_stat_activity`: active, `SELECT pg_advisory_xact_lock(...)`);
  - save B returned `{ ok:false, code:'unauthenticated', error:'Unauthorized: No active session' }` **before reaching the lock**.
- **Conclusion:**
  - **The lock and the C7 server code work.**
  - In the test harness, the second of two *simultaneous* calls fails `getSessionUser`. That function does `await import('@/lib/tenant/context')` (a module the test mocks) on every call, and under concurrency the second call evidently gets a failing tenant check. That's consistent with a Vitest mocked-module / dynamic-import race.
  - Production is unaffected: each request runs its own session check, with no mock.

## 3. Fix round 1 (required before merge)

### M1: busy spinner invisible on filled buttons
- **Where:** `ConfirmModal.tsx:62` and `ReportsClient.tsx` `busyProps` (~:91).
- **Problem:** the Loader is `color="var(--button-color)"` (white), but `data-disabled` paints the button gray-2, so every red or primary confirm turns grey with a white spinner at about 1.2:1.
- **Fix:** `color="currentColor"`, or omit `color`.
- **Test:** a static or unit assertion that the busy Loader doesn't use `--button-color`.

### M2: QuickBooks mapping tabs all gated on QuickBooks employees
- **Where:** `QBOConfigClient.tsx:361,380,395,410` pass `loaded={qboEmployees.length > 0}` to every tab. A company with no employees can never map vendors, customers or items. This is a regression; each tab used to gate on its own list.
- **Fix:** a `qboLoaded` boolean, set after a successful load, passed to all tabs.
- **Test:** zero employees plus a non-empty customer list → the customers tab is mappable.

### M3: workspace Save buttons use `disabled`, so focus drops after the C8 confirm
- **Where:** `WorkspaceSettingsClient.tsx:103-106`, `disabled={!timezone || timezone === savedTimezone}`. After a successful confirm, the Modal returns focus to a now-`disabled` button, and focus falls to `<body>`. The Workweek button has the same problem.
- **Fix:** `aria-disabled` plus `data-disabled` plus a click guard, with the visible reason "Choose a different timezone to save." / "Choose a different day to save." (the Pay schedule pattern).
- **Test:** neither button ever has the `disabled` attribute; after confirm, focus stays on the button.

### M4: T-C7e harness fix (test only; product code unchanged)
- **Stagger the saves:**
  1. Start save A, and poll until **1** waiter.
  2. Then start save B, and poll until **2** waiters.
  3. Commit, and assert as now.

  Save B's pre-lock phase then never runs concurrently with save A's.
- **Filter the lock query:** `… AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND objid = (hashtext('pay_period_config')::bigint & 4294967295)`. Or simply compare to `objid` read from the holder's own granted row.
- **Clean up:** in `finally`, `await saves?.catch(() => {})` before ending the pools (no dangling rejection on a failing run).
- **On a timeout,** include each save's settled result in the error message (the lead's diagnostic pattern). A future failure then explains itself.

### LOWs (same round)
- **L1, C1 Add button** (`ContractsClient.tsx:515-521`):
  - no Mantine `loading` (it sets `disabled`): use `aria-disabled` + `data-disabled` + `Loader`;
  - in the error state, give it the reason "Couldn't load CLINs".
- **L2, C1 tests:** add token tests for `loadSlins`' success path and for `handleClinStatusToggle`. Both mutations currently survive.
- **L3, C16:** `onCancel` of the role confirm also clears `formError` (as IndirectCodes does).
- **L4, C4:** `validateUUID(data.userId, 'Employee')` after the guard. The check-then-insert race is accepted and recorded.
- **L5, C3:**
  - `handleSeedDefaults` catches a failed refetch and shows "Codes were added, but the list couldn't refresh. Reload the page.";
  - singular for 1: "Added 1 standard indirect code."
- **L6, C5:** add a static assertion that `charge-codes.ts` contains the literal `te.charge_code_id = charge_codes.id`. T-C5c only catches an uncorrelated `exists`, not an interpolated column.
- **L7, C11:** Validate and Import in `MigrationClient` capture the parse token and drop results if a newer file was picked.
- **L8, C17:** singular "1 employee has no direct charge code…".
- **L9, C7:** the cancel toast has title "Scheduled change cancelled" and message "Your current schedule stays in effect." (no repeated text).
- **L10, C10:** `RowStatus` keys errors by index, not text.

**Recorded, no change:**
- the ConfirmModal `loading` follows each caller's shared `isPending` (cosmetic; per-action busy state is UX-4b);
- a cancel from a stale page is refused rather than treated as an idempotent cancel (blueprint order, by design);
- C4's check-then-insert window;
- Mantine `loading` on the Setup and Migration buttons (UX-4b kit).

## 4. Product owner runs after fix round 1
1. Integration (all of it).
2. `node breakit-check-ux4a.mjs`: expect 9/9 caught.
3. `npm run build && node scripts/check-build-trace.mjs && node scripts/check-css-output.mjs`.
4. `npm run demo:local` twice.
5. The browser checks in blueprint §10, plus:
   - a confirm's spinner is visible in light mode;
   - QuickBooks tabs, if connected.

## 5. Fix round 1 verification (`da4861e..5dff9a4`, 14 commits), 2026-11-02

**Lead gates:** `tsc` clean; lint 0 errors, 56 warnings; 171 files, 1986 pass. `breakit-check-ux4a.mjs --dry-run`: all 9 edits apply.

**Dev revert checks:** 30/30 caught (M1–M3, L1–L10). M4 (T-C7e) is type-checked only; it awaits the product owner's run.

**Lead read of M4:**
- the saves are staggered: A, then wait for 1 waiter; B, then wait for 2;
- waiters are counted on this lock only (database, classid and objid from the holder's own granted row);
- the expected winner is A, because Postgres grants queued lock waiters in order;
- a timeout reports each save's settled result;
- both saves are settled before the pools end.

**Dev gap decisions, all accepted:**
- M1 omits the Loader colour (`currentColor` is rejected by the palette guard T1b);
- the M3 Workweek button also drops `loading`;
- the M2 test-suite reset;
- the L5 shared copy helper (the Setup wizard had the same plural);
- L7 doesn't undo a completed import, only its stale summary;
- L10 exports `RowStatus` for a direct test.

**Pending (product owner):** integration (T-C7e), the 9 break-its, build plus checks, `demo:local` ×2, browser checks.

## 6. Product owner results and fix round 2 (2026-11-03)

**Results:**
- Integration: all pass, including T-C7e.
- `breakit-check-ux4a.mjs`: all caught.

**Browser finding:** toggling "Show on every timesheet" crashes the page with `TypeError: Cannot read properties of null (reading 'checked')` at `IndirectCodesClient.tsx:384`.

### M5 (MEDIUM, pre-existing on `main` at `:329`; it now blocks C2's confirm flow)
- **Cause:** `onChange={(e) => setForm((f) => ({ ...f, availableToAll: e.currentTarget.checked }))}`. React clears `event.currentTarget` once the handler returns, and the updater function can run later, during render. (`e.target` survives, which is why the `e.target.value` updaters elsewhere work.)
- **Scope:** a repo-wide search found this one place only.
- **Fix:** read the value in the handler: `onChange={(e) => { const checked = e.currentTarget.checked; setForm((f) => ({ ...f, availableToAll: checked })); }}`.
- **Guard:** a static unit test (e.g. `unit/no-currenttarget-in-updaters.test.ts`) scanning `src/**/*.tsx` (excluding `__tests__`) for `e.currentTarget` inside a state-updater arrow (`set\w+\(\(\w+\) =>[^;]*\.currentTarget`) fails on any match.
- **Revert checks:** put the old line back → the guard fails.
- **Optional:** a render test that toggles the switch twice inside one `act` (which defeats React's eager-state path) and asserts no throw.

### Setup screen (no change)
Since UX-2 the Setup wizard isn't in the nav. It appears on Home as a "Finish setting up" item only until setup is complete, and the demo workspaces are complete. The page still works directly at `/admin/setup`.

## 7. Fix round 2 and closing (2026-11-03)
- **M5** (`ccb0ddb`): the value is read in the handler; the guard test is `no-currenttarget-in-updaters`.
- **Two further fixes found in the product owner's browser pass, verified by the lead:**
  - **ConfirmModal z-index:** a confirm declared before its edit Modal rendered *behind* it (equal z-index, so mount order decides). Now `getDefaultZIndex('modal') + 1`, with a test.
  - **Home attention button:** the label was clipped to "Choose a rev…". The text column now flexes and the button doesn't shrink, with a test.
- **Lead gates with these:** `tsc` clean; lint 0 errors, 56 warnings; 172 files, 1990 pass.
- **Product owner:** integration and the 9 break-its are green, and the browser checks are confirmed working.

**Verdict: READY TO MERGE.**
