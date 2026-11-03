# Blueprint UX-4a: page bug fixes (correctness, safety, honesty)

> **Status:** v3 FINAL, 2026-10-31, lead architect. Pre-mortem rounds 1 and 2 are applied (§11). The two-round limit is reached; anything left is caught in the code audit.
>
> **Branch:** `ux-page-fixes`, cut from `main` after the MFA hotfix merges.
>
> **Sources:**
> - `UX-4-AUDIT.md` §2 (C1–C17; C18 and C19 move to UX-4b with the Payroll and Contracts redesigns);
> - two lead-commissioned code research passes;
> - two pre-mortem reviews (2026-10-31).
>
> **Scope rule:** fix the bug, the copy that lies, and the accessibility defect named. No visual redesign; UX-4b does that. Sentence case applies to any string this blueprint touches.

---

## 0. Lead rulings (no product decisions in this blueprint)
| # | Ruling |
|---|---|
| R1 | **Pay schedule:** a pending change gets an explicit **"Cancel scheduled change"** button. On the server, a request whose schedule equals the current one cancels a pending change if one exists; with nothing pending it's refused, with a message. |
| R2 | **Setup "Charge code access"** stays *satisfied* (setup can complete) when at least one expected submitter has a charge code, but shows **"{n} of {m} employees have a charge code"** and a partial state, never a check, until everyone does. The completion screen names who has none. Overhead-only staff legitimately have no direct code and must not block setup forever. |
| R3 | **Indirect "Available to all employees":** keep the flag (rows already `false` must stay manageable). Relabel it honestly, say exactly what hiding does, and confirm before hiding. |
| R4 | **Assigning an employee to a labor category that isn't assignable is refused** server-side, using the same rule as `getAssignableLaborCategories`: active LCAT, active CLIN, active contract. |
| R5 | **Report downloads** go through `fetch` (no `window.open`). The PDF route encodes the filename per RFC 6266 / 5987. |

## 1. Verified current state
Line numbers are from `main` at `d120c0a`.

| # | Evidence |
|---|---|
| C1 | **Contracts drawer.** `ContractsClient.tsx:150-158`: `openClinsDrawer` never clears `clins`, and fetches in the shared `startTransition` with no request token and no catch. `:475` shows the previous contract's CLINs. `:227-238` does the same for SLINs ("No SLINs yet" while loading, `:566`). Mutation handlers append to `clins` / `slinsByClin` after an await (`handleClinSubmit :206-222`, `handleClinStatusToggle :225-236`, SLIN handlers), so a result can land in another contract's drawer. One `isPending` (`:105`) spins every button. The reads **throw** on failure; React 19 sends a throw from an async transition to `admin/error.tsx`, which blanks the page. The add button is labelled "Add". |
| C2 | **Indirect "Available to all".** The switch is at `IndirectCodesClient.tsx:326-330`, the column at `:225-229`. No per-user indirect table exists. With `availableToAll=false`, the code isn't offered on timesheets (`actions/timesheet.ts:571-579`) and new cells are refused (`:282, 338`; `lib/timesheet/cell-rules.ts:28`). **However,** a period where the employee already has entries or a latest non-empty note still shows the row (`getPeriodCodesForEmployee`, `extraIndirect`, `assignable: false`): existing cells stay correctable (`cell-rules.ts:1-18`) and notes stay allowed on that row (`internal/timesheet-notes.ts:147-153`). Other readers: `internal/setup.ts:33` (count; needs `isActive` too) and `lib/export/allowlists.ts:203` (a false description). The column says "Yes" even for an inactive code. |
| C3 | **Seed defaults.** `actions/indirect-codes.ts:134-137` returns the existing rows when any exist (insert nothing, still ok). Both clients claim success: `IndirectCodesClient.tsx:180-188` and `SetupWizardClient.tsx:185-195` ("9 standard … seeded"). The button is always visible (`:260-262`). A seed that races an insert hits the unique `code` constraint. MRT's `renderEmptyRowsFallback` also renders when a search matches nothing. |
| C4 | **Labor categories.** `LaborCategoriesClient.tsx:172` is `const [assignableLcats] = useState(initial…)` with no setter. Only `getAllLaborCategories` is refetched (`:273-276`, `:293-296`). `assignUserToLaborCategory` (`labor-categories.ts:187-206`) doesn't check assignability. `getAssignableLaborCategories` (`:267-294`) requires an active LCAT, CLIN and contract. |
| C5 | **Charge codes.** `charge-codes/page.tsx:21-31` lists active contract + CLIN pairs only. `ChargeCodesClient.tsx:113` `openEdit` finds no contract, so Contract shows blank and CLIN blank-and-disabled (`:216-219`, `:304-311`). Picking a contract clears `clinId` (`:306`). The server refuses a CLIN change once hours exist or labor categories are set (`actions/charge-codes.ts:120-137`); **moving an unused code off an inactive CLIN is allowed and works today.** `listChargeCodes` joins `clins`, `contracts` and `costClasses` (`:63-66`). Callers: `charge-codes/page.tsx:19`, `assignments/page.tsx:21`, `ChargeCodesClient` refresh. |
| C6 | **Dashboard key.** `DashboardClient.tsx:212-213`: a keyless fragment. |
| C7 | **Pay schedule.** The form starts from `initialConfig`, the current schedule (`PayScheduleClient.tsx:48-50`). Only `scheduledPeriodType` / `scheduledEffectiveFrom` of a pending change are kept (`:52-57`). An effective date is auto-selected (`:74-78`), so Save (`:227`) is enabled on load. `handleSave` (`:101`) has no dirty check and no confirmation. **Server** (`actions/pay-period-config.ts:230-280`): no no-op check; an unchanged save replaces pending rows with a row identical to the current one. `configAt` and `workspaceHasNoTimesheetData` read **outside** the transaction (`:250, :267`). Two concurrent saves at READ COMMITTED can both delete and both insert, leaving two pending rows. The `effectiveFrom === null` branch is at `:249`. The weekly label is fixed "(7 days, Mon–Sun)" (`:29`). Fields have no labels. |
| C8 | **Workspace timezone.** `WorkspaceSettingsClient.tsx:94` saves straight away. The copy says it "affects every employee immediately". Neither Select has a label (`:86-93, :107`). The workweek already confirms (pinned by `payroll-export-actions.test.ts:185-189`). |
| C9 | **First run.** `signup/verify/route.ts:192` and `lib/tenant/waitlist.ts:114` add `welcome=1`. `ResetPasswordForm.tsx:23-25` ignores it ("Set New Password" `:93`, "Resetting password for" `:122-124`). The verify page HTML (`:80-115`) and `htmlPage()` (`:36-53`) have no `<main>`. Contrast: `#228be6` 3.56:1, `#9ca3af` 2.54:1. |
| C10 | **Data import.** Errors appear only in `title=` (`ImportClient.tsx:173`). The employee tab shows none (`:331-333`). The server numbers errors over the **valid rows only** (`actions/import.ts:99-337`, `i + 1` in all 5 actions). Missing required columns (`src/lib/csv-parser.ts:36-45`) silently give 0 rows. Papa runs with `skipEmptyLines: true` (`:29`). |
| C11 | **History import.** `MigrationClient.tsx:294-296, 384-386`: a label around `<input hidden>`, unreachable by keyboard. The copy promises imports that don't exist (`:240-245`). The period parse has no `error` callback (`:141-162`). The filename persists across file changes (`:192, :221`). |
| C12 | **API keys.** `ApiKeysClient.tsx:224-230`: the key Modal closes on Esc and ✕, and the key is lost. Props are verified in Mantine 9.3.1 (`ModalBase.d.ts:27,35`; `Modal.d.ts:24`). |
| C13 | **QuickBooks / Gusto.** Clearing a mapping is ignored (`QBOConfigClient.tsx:491-496`, `GustoConfigClient.tsx:336-341`). `deleteMapping` exists (`actions/integrations.ts:131-137`) with no UI. `saveMapping` (`:83-129`) does select-then-insert (it races the unique index at `schema.ts:557`) and returns nothing; the clients store `temp-` ids. Mappings are hidden until "Load data". `syncLogs` is frozen in `useState`. The Selects have no label. |
| C14 | **Audit trail.** The correction fill is `light-dark(warning-0, warning-1)` inline (`AuditTrailClient.tsx:293-301`), light in dark mode (#fee9c4). `globals.css:63-68` fixes only the `td` colour. Children fail contrast (dimmed 1.85, signal 2.75, icon 1.13). |
| C15 | **Reports.** `ReportsClient.tsx:77,90,103,117` use `window.open`. Route errors: 400; 401 / 403; 404 (PDF only, **only when the user doesn't exist**, `reports.ts:94`; an empty period still returns a PDF); 429 with `retryAfter` and `Retry-After` (10 per minute shared, `lib/rate-limit.ts:95-107`); 500 JSON. The PDF and CSV routes render outside their try, so a failure gives Next's non-JSON 500; xlsx is already inside its try. The PDF `Content-Disposition` uses the raw `fullName`. |
| C16 | **Users.** A role change saves straight away. `UsersClient.tsx:120-139` sends the role **with** name and email, then calls `setUserApprover` separately. The FLSA toast says "(salaried)" / "(hourly)" (`:231-232`); the same wording appears in `allowlists.ts:133`, `schema.ts:30` and `types/timesheet.ts:62`. Server (`actions/users.ts:77-190`): no self role change; the last admin can't be demoted; role and status can't change together; a role change bumps `sessionVersion`, so the user is signed out within 60 s (`auth.ts` `SESSION_CHECK_INTERVAL_MS`). Approval scope (`internal/approval-rules.ts`): a supervisor approves employees sharing an active CLIN (`:104-106`) and anyone whose designation names them, but only when the designee is a supervisor or admin (`effectiveDesignee :72-77`). Adding a second admin turns off sole-admin self-approval (`selfApprovalAvailable`). `ConfirmModal` has no error slot. |
| C17 | **Setup wizard.** Mantine 9.3.1 Stepper forces `stepCompleted` on steps before `active` (`Stepper.mjs:58,65-69`); per-step `completedIcon` and `color` are honoured (`:72-74`). Done steps *after* `active` render as inactive. The active step is computed once (`SetupWizardClient.tsx:176`). `getSetupStatus()` returns a raw `Promise<SetupStatus>`, not an ActionResult (`actions/setup.ts:10`). Access is "done" at 1 of N (`internal/setup.ts:68,72`), and so are the summary grid (`isStepComplete`, `~:285`) and the panel badge (`~:318-330`). `userRoleEnum` is admin, supervisor and employee only (`schema.ts:14`). Home reads `setup.steps` into its client payload (`internal/home.ts:69`), with ≤ 10 parallel queries there (T-I, `:49`). |

## 2. Invariants
- **DCAA:** no change to entries, revisions, reason codes, the period lock or append-only triggers. C5 never moves a charge code with hours or labor categories (the server stays authoritative).
- **Security:** every changed action keeps its guard **first** (`requireAdmin` / `requireAdminFresh` / `requireApprover`). There are no new `'use server'` exports of internals, and every id received is UUID-validated **after** the guard (so guard-first oracle tests keep passing).
- **Concurrency:** C7's decision runs under an advisory transaction lock. C13 saves are atomic upserts.
- **CSS:** no `light-dark()` in `.css` files, and no `-filled` colours as text.
- **Controls:** never `disabled` on a focusable control whose reason should be given: use `aria-disabled` plus a click guard. Mantine `Button loading` sets `disabled`, so don't use it on buttons a keyboard user may be focused on; use a `Loader` in `leftSection` plus `aria-disabled`.
- **One error location per action.** A confirm shows its own error inside the confirm dialog.
- **Correlated subqueries** write the outer column literally (UX-3 lesson).

## 3. Shared change: `ConfirmModal` error slot
Changes to `src/components/ui/ConfirmModal.tsx`; existing callers are unaffected:
1. **Error slot:** an optional `error?: ReactNode`. When set, render `<Alert role="alert" color="red" mb="sm">{error}</Alert>` above the buttons. Used by C2, C7, C8 and C16.
2. **While `loading`:**
   - the Modal gets `closeOnEscape={false}`, `closeOnClickOutside={false}` and `withCloseButton={false}`. Mantine closes every open modal on a window-level Esc, so an error that arrives after Esc would never be shown.
   - The confirm button **doesn't use Mantine `loading`** (it sets `disabled`): it gets `aria-disabled="true"`, a `Loader` in `leftSection`, and a click guard. Cancel is also `aria-disabled` while loading.
3. **Error location:** the actions behind a confirm call `runAction(…, { silent: true })` and put the error in `error`, never a toast as well. C8 today uses `errorTitle` (`WorkspaceSettingsClient.tsx:44`); change it to `silent`.
4. **Edit forms behind a confirm** (C2, C16) hide their own `formError` Badge while the confirm is open, so the error shows in one place.

## 4. Fixes

### C1 Contracts drawer (client only)
1. **State:** `clinsStatus: 'idle'|'loading'|'error'|'ready'`, `slinStatus: Record<clinId,'loading'|'error'>` and `const clinsReq = useRef(0)`. The ref is written only in handlers.
2. **`loadClins(contract)`** is a plain async function, not a transition:
   - `const id = ++clinsReq.current; setClins([]); setClinsStatus('loading');`
   - `try { const d = await getClinsByContract(contract.id); if (id === clinsReq.current) { setClins(d); setClinsStatus('ready'); } } catch { if (id === clinsReq.current) setClinsStatus('error'); }`

   `openClinsDrawer` resets the selection and SLIN state, then calls `loadClins`. Closing the drawer bumps `clinsReq.current`.
3. **Mutations:** every handler that writes `clins` or `slinsByClin` after an await captures `const id = clinsReq.current` before awaiting and **drops the result if `id !== clinsReq.current`**. That covers create, edit, status toggle, SLIN create and SLIN toggle.
4. **Render:**
   - loading: `<Group role="status"><Loader size="sm" aria-hidden /><Text>Loading CLINs…</Text></Group>`;
   - error: `<Alert role="alert" color="red" title="Couldn't load this contract's CLINs">` plus a **Retry** button (`loadClins(selectedContract)`);
   - "No CLINs yet" only when `ready`.
   - The add-CLIN button ("Add") is `aria-disabled` with the reason "Loading CLINs…" until `ready`, and `handleClinSubmit` starts with `if (clinsStatus !== 'ready') return;`.
5. **SLINs:** the same pattern per CLIN, with the token captured. Expanding is skipped while `slinStatus[k] === 'loading'`. A failure isn't cached. Show "Loading SLINs…" (`role="status"`) or "Couldn't load SLINs." with Retry.
6. Reads leave the shared transition, so they no longer spin every button. Mutations keep `isPending` (per-action busy state is UX-4b).

### C2 Indirect "Available to all employees" (R3)
- **Switch:**
  - label "Show on every timesheet";
  - description "When off, employees can't add this code or record new hours on it. Where hours are already recorded, the row stays in that period for corrections and notes."
- **Column** "On timesheets", via an `accessorFn` returning a word (so search finds it): "Yes", "Hidden", or "Inactive" when `!isActive`.
- **Confirm before hiding.** When editing turns the switch from on to off, `handleSubmit` opens a `ConfirmModal`:
  - tone `danger`;
  - title `Hide {code} from timesheets?`;
  - message "Employees won't be able to add {code} or record new hours on it. Rows that already have hours stay visible in their period for corrections and notes.";
  - confirm "Hide code";
  - `error={formError}`.

  The confirm calls `handleSubmit({ confirmed: true })`, which skips the check. It closes on success and stays open, showing the error, on failure. The edit Modal gets `closeOnEscape={!confirmOpen}`. **The form's own Save button is wired as `onClick={() => handleSubmit()}`**, never `onClick={handleSubmit}` (a MouseEvent would arrive as the argument; `IndirectCodesClient.tsx:338`).
- **`allowlists.ts:203`** becomes: "false if employees can't add the code or record new hours (rows with existing hours stay correctable)". Update any test that pins it.

### C3 Seed defaults
- **Server** `seedIndirectCodes`: keep the guard. If any row exists, return `{ created: 0 }` with no insert. Else `insert(defaults).onConflictDoNothing({ target: indirectChargeCodes.code }).returning({ id })` and return `{ created: rows.length }`. The result type is `ActionResult<{ created: number }>`.
- **Codes page:** the button ("Add standard codes") renders only when **`codes.length === 0`**, inside the empty state; it doesn't show for an empty search result.
  - created > 0: success toast "Added {n} standard indirect codes."
  - created 0: neutral toast "Your workspace already has indirect codes, so none were added."
- **Setup wizard:** the same two messages. For 0, add " Reactivate them, and turn on Show on every timesheet, on the Indirect codes page."

### C4 Labor categories (R4)
- `const [assignableLcats, setAssignableLcats] = useState(initial)`.
- After create, edit or status toggle: `const [all, assignable] = await Promise.all([getAllLaborCategories(), getAssignableLaborCategories()])`, set both, then clear `assignLcatId` if it's no longer in `assignable`. A refetch failure after a successful save shows the existing generic toast (accepted).
- **Server** `assignUserToLaborCategory`, after the guard:
  1. `validateUUID(laborCategoryId, 'Labor category')`.
  2. Load the LCAT with its CLIN and contract. If not found, throw `UserFacingError('That labor category no longer exists.')`.
  3. If the LCAT, its CLIN or its contract is inactive, throw `UserFacingError('This labor category can't be assigned because it, its CLIN or its contract is inactive.')`.

### C5 Charge codes edit
- **Server:** `listChargeCodes` adds `hasHours: sql<boolean>\`exists(select 1 from timesheet_entries te where te.charge_code_id = charge_codes.id)\``. The outer column is written **literally** (it renders qualified today because of the joins, but a future single-table refactor would bind it to `te.id`). T-C5c pins it.
- **Client** `openEdit(row)`:
  - `clinActive = contracts.some((c) => c.clins.some((cl) => cl.id === row.clinId))`;
  - `lockReason = row.hasHours ? 'hours' : (row.laborCategoryId || row.categoryChanges?.length) ? 'categories' : null`.
- **When `lockReason` is set,** show a read-only `TextInput` labelled "Contract and CLIN" (value `{contractNumber} — {contractName} · CLIN {clinNumber}`) instead of the Selects. Its description:
  - hours: "This code has recorded hours, so its CLIN can't change. Create a new charge code to use a different CLIN."
  - categories: "Remove this code's labor categories before moving it to another CLIN."
- **When `lockReason` is null and `!clinActive`:**
  - keep the editable Selects, adding the current pair as a selected option labelled `{contractNumber} · CLIN {clinNumber} (inactive)`;
  - description "This CLIN or its contract is inactive. Choose another CLIN to move the code, or leave it to edit the other fields."
  - Choosing a different contract clears the CLIN, as today. This keeps today's working "move off an inactive CLIN" path.
- **Save (edit):** include `clinId` only when it differs from `row.clinId`. A CLIN is required on create only.

### C6 Dashboard key
`<Fragment key={clin.clinId}>…</Fragment>`. Drop the inner key.

### C7 Pay schedule (R1)
1. **Pure `sameSchedule(a, b)`** in `src/lib/date-utils.ts`. Same `periodType`, then:
   - weekly: same `weekStartDay`;
   - biweekly: same `weekStartDay` and `diffDays(a.anchorDate, b.anchorDate) % 14 === 0`;
   - semimonthly and monthly: nothing more.

   A null or invalid `anchorDate` where one is required returns `false` (never throws).
2. **Server** `updatePayPeriodConfig(data)`, with new input fields `cancelPending?: boolean` and `expectedPendingId?: string | null`. Every replace is a delete plus insert, so the pending row's id changes on every save. That makes the id, not the date, the stale-page key.
   1. Guard (unchanged).
   2. **If `data.cancelPending === true`** (strict), skip `parseScheduleInput` and `anchorProblem` and go straight to the transaction, taking steps 3, 4 and 5 below.
   3. Otherwise run `parseScheduleInput` and `anchorProblem` as today.
   4. Open the transaction. **Its first statement is `select pg_advisory_xact_lock(hashtext('pay_period_config'))`** (the pattern in `import-window.ts:25`; no other user of this key). From here on, every read runs on `tx`: `configAt`, `pendingConfigChangeInternal` and `workspaceHasNoTimesheetData`. **Change `workspaceHasNoTimesheetData`'s parameter type to `Pick<ReadDb, 'select'>`**: its current `Awaited<ReturnType<typeof getDb>>` (`pay-period-config.ts:168`) requires `$client`, which a transaction doesn't have.
   5. **Stale check:** if `expectedPendingId !== undefined` and `(pendingConfigChangeInternal(tx, today)?.id ?? null) !== expectedPendingId`, throw `UserFacingError('The scheduled change was updated by someone else. Reload the page to see it.')`.
   6. **Cancel:** if `cancelPending`, delete the pending rows if any and return `{ effectiveFrom: null, cancelledPending: true }`. With nothing pending, return the same (idempotent).
   7. **No-op:** if `sameSchedule(candidate, current)`:
      - pending exists: cancel it, as in 6;
      - nothing pending: throw `UserFacingError('This is already your pay schedule. Change a setting before saving.')`.
   8. **Idempotent:** if pending exists, `sameSchedule(candidate, pending)` and `effectiveFrom === pending.effectiveFrom`, return `{ effectiveFrom: pending.effectiveFrom }` with no writes.
   9. Otherwise the existing immediate / scheduled logic, unchanged, on `tx`. **The scheduled path's insert adds `.returning({ id })`, and the result gains `pendingId: string`** (an optional field, present only on the scheduled path), so the client knows the new pending row's id without a reload.

   **Steps 5–8 run before the `effectiveFrom === null` branch and before `parseCalendarDate(effectiveFrom)`.** `cancelledPending?: true` is optional and returned only on cancel, so the existing `toEqual({ effectiveFrom: null })` assertions stay valid.
3. **Client state:**
   - `currentCfg: PeriodConfig` (from `initialConfig`);
   - `pendingCfg: { id: string; config: PeriodConfig; effectiveFrom: CalendarDate } | null`, derived from the page's existing `pendingChange` prop. `page.tsx:13-18` already passes the full guarded `ConfigHistoryRow` (id, type, anchor, week start, date), so no page change is needed.
   - The banner derives from `pendingCfg`.
   - The form starts from `pendingCfg?.config ?? currentCfg`.
4. **Dirty rule:**
   - `baseline = pendingCfg?.config ?? currentCfg`;
   - `configChanged = !sameSchedule(form, baseline)`;
   - `dateChanged = pendingCfg !== null && !configChanged && selectedEffectiveFrom !== pendingCfg.effectiveFrom`;
   - `dirty = configChanged || dateChanged`.
   - Effective dates are fetched when `!sameSchedule(form, currentCfg)`, so moving a pending change's date is possible.
   - **Effective-date initialisation:**
     - when `pendingCfg && sameSchedule(form, pendingCfg.config)`, the fetched options initialise the selection to `pendingCfg.effectiveFrom`, prepended to the options if it's missing; never IMMEDIATE or `dates[0]` in that case;
     - otherwise keep today's behaviour (`options.immediate ? IMMEDIATE : dates[0]`, `PayScheduleClient.tsx:73,78`).

     So a page with a pending change loads with Save `aria-disabled`.
   - **Form equals current while a change is pending** (`pendingCfg && sameSchedule(form, currentCfg)`): Save is `aria-disabled` with the visible reason "This matches your current schedule. To keep it, use Cancel scheduled change." 
   - **Save** is `aria-disabled` with the visible reason "Change the period type, anchor date or week start to schedule a change." while not dirty, and requires an effective date when scheduling.
5. **Actions** (the client always sends `expectedPendingId = pendingCfg?.id ?? null`; the save actions use `runAction(…, { silent: true })` with the error shown in the confirm):
   - **Save** opens a `ConfirmModal` (tone neutral, `error`, a `Loader` while saving, closes only on success). `{type}` is the human period type:

     | Case | Title | Message | Confirm |
     |---|---|---|---|
     | Scheduled | "Change the pay schedule?" | "Starting {MMM D, YYYY}, every employee's timesheets will use {type} pay periods. Current and past periods don't change." | "Schedule change" |
     | Immediate | "Change the pay schedule?" | "Every employee's timesheets will use {type} pay periods starting now. No timesheets have been entered yet." | "Change schedule" |

   - **The pending banner** gets a "Cancel scheduled change" button. It opens a `ConfirmModal`:
     - title "Cancel the scheduled change?";
     - message "Your current {type} schedule stays in effect.";
     - confirm "Cancel scheduled change", `cancelLabel="Keep scheduled change"`.

     It sends `{ ...currentCfg, effectiveFrom: null, cancelPending: true }`.
   - **On success:**

     | Result | State update | Toast |
     |---|---|---|
     | Scheduled | `pendingCfg = { id: result.pendingId, config: form, effectiveFrom }` | — |
     | Immediate | `currentCfg = form; pendingCfg = null` | — |
     | Cancel | `pendingCfg = null`, and the form resets to `currentCfg` | "Scheduled change cancelled." |

     State is initialised from props once; the page doesn't refresh after a save.

6. **In this pass:**
   - the weekly label `Weekly (7 days, ${DAY_NAMES[ws]} to ${DAY_NAMES[(ws + 6) % 7]})`;
   - real `label=` / `description=` on the Radio.Group ("Period type"), DatePickerInput ("Anchor date"), week-start Select ("Week start day") and effective-from Select ("Effective from").

### C8 Workspace timezone
- **Save opens a `ConfirmModal`** (tone neutral, `error`):
  - title "Change the workspace timezone?";
  - message "“Today” for every employee will follow {new} instead of {saved}. Late-entry and future-date rules, pay-period boundaries and timestamps change immediately.";
  - confirm "Change timezone".
  - The action runs on confirm only.
- `label="Timezone"` and `label="Workweek starts on"`. The workweek confirm is unchanged.

### C9 First run
1. **Welcome mode.** `ResetPasswordFields`: `const welcome = searchParams.get('welcome') === '1'` (strict). Welcome copy:

   | Piece | Copy |
   |---|---|
   | h1 | "Welcome to CadenzPoint" |
   | Intro | "Your workspace is ready. Set a password for {email} to sign in." |
   | Fields | "Password" / "Confirm password" |
   | Button | "Set password" |
   | Loading | "Checking your link…" |
   | Invalid | "This setup link is invalid or has expired. Use Forgot password to get a new one." (with a link to `/forgot-password`) |
   | Success | "Your password is set. Sign in to finish setting up your workspace." (button "Sign in") |

   Reset mode is unchanged except for sentence case on shared strings.
2. **Verify page and `htmlPage()`:**
   - `<main>` around the card, with one `<h1>`; the emoji gets `aria-hidden="true"`;
   - colours on the white card:

     | Element | Colour | Contrast |
     |---|---|---|
     | h1 | `#0c1b33` | 17.21:1 |
     | Body and note | `#46526e` | 7.80:1 |
     | Workspace name and button | `#3f55e6` (button text `#fff`) | 5.75:1 |
     | Button hover | `#3346c0` | — |
     | `:focus-visible` | `outline: 2px solid #4f6bff; outline-offset: 2px` | 4.30:1 (non-text, ≥ 3:1) |

### C10 Data import
- **Status cell** (both wizards): the badge plus each error as visible text (`c="red"`). Remove `title=`.
- **Summary:** `role="status"`: "{n} rows ready to import. {m} rows have errors. Fix them in your file and upload it again." (the second sentence only when m > 0).
- **Error list:** "Rows with errors ({m})" with items "Row {fileRow}: {errors.join('; ')}". Show at most 100, then "…and {k} more". Its description: "Row 1 is the first row after the header. Blank lines aren't counted."
- **`ParseResult.missingColumns: string[]`** (`src/lib/csv-parser.ts`): when non-empty, show a red `role="alert"` Alert: "This file is missing required columns: {list}. Download the template to see the expected headers."
- **Server row numbers:** when Import is clicked, **snapshot** `fileRows = parsed.rows.filter((r) => r.isValid).map((r) => r.rowIndex)`, then display server error `e` as `fileRows[e.row - 1] ?? e.row`, in both wizards and the employee result.

### C11 History import
- **Uploads:** Mantine `FileInput` with `label="Timesheet entries CSV"` / `label="Period status CSV"`, `accept=".csv"`, `placeholder="Choose a CSV file"`, `clearable`.
  - On a new selection, first clear rows, validation, summary and that file's stored filename, then parse.
  - On `null`, clear all of those.
  - Add an `error` callback to the period parse, which keeps the state cleared and shows "Couldn't read that file. Make sure it's a CSV."
- **Copy:**
  - "Timesheet history can be imported only during onboarding, before your workspace's first submitted timesheet. Employees, contracts, CLINs and labor categories can be imported any time from Data import."
  - Import order: "1. Add employees, contracts and CLINs (Data import) and any indirect codes (Indirect codes). 2. Import timesheet entries. 3. Import period statuses."
  - "Indirect codes" links to `/admin/indirect-codes`.

### C12 API keys
- The key Modal gets `closeOnEscape={false}`, `closeOnClickOutside={false}`, `withCloseButton={false}`, and the title "Copy your API key".
- `<CopyButton value={key}>` renders a `Button` labelled "Copy key" / "Copied".
- The single exit is "I've copied the key".

### C13 QuickBooks / Gusto
1. **`saveMapping`:** after the guard, `insert(...).onConflictDoUpdate({ target: [connectionId, entityType, bytimeEntityId], set: { externalEntityId, externalEntityName, bytimeEntityName, metadata, updatedAt } }).returning({ id })`. Return `{ id }`. The target is verified: `mapping_unique_idx` is a non-partial unique index on exactly these columns (`schema.ts:557`), and ON CONFLICT infers it. Keep every field the current update path sets (`integrations.ts:113`). The clients store the real id.
2. **`deleteMapping(mappingId)`:** after the guard, `validateUUID(mappingId, 'Mapping')`, then `delete … returning({ id })`. If nothing was deleted, throw `UserFacingError('That mapping no longer exists.')`.
3. **Clearing a mapped Select** (`onChange(null)`) calls `deleteMapping(id)`, removes the mapping from state, and toasts "Mapping removed. {name} is no longer matched." On "no longer exists", also remove it from state.
   - `allowDeselect={false}`;
   - `clearButtonProps={{ 'aria-label': \`Remove mapping for ${name}\` }}`;
   - `aria-label={\`QuickBooks match for ${name}\`}` (Gusto: "Gusto match for {name}");
   - a row's Select is `aria-disabled` and ignores changes while its save or delete is in flight.
4. **Before data loads,** a mapped row shows `externalEntityName ?? externalEntityId` plus the dimmed line "Load QuickBooks data to change" (or Gusto). After loading, a mapped id missing from the list is prepended as `{ value, label: \`${name} (not found in QuickBooks)\` }`.
5. **Sync history:** render the `syncLogs` prop directly, and call `useRouter().refresh()` after a sync resolves, whether it succeeded or failed. `router.refresh()` keeps client state, so local mappings persist.

### C14 Audit trail contrast
- The row's inline style becomes `backgroundColor: 'var(--audit-correction-bg)'`.
- **`globals.css`:**
  ```css
  :root { --audit-correction-bg: var(--mantine-color-warning-0); --audit-correction-edge: var(--mantine-color-warning-7); }
  :root[data-mantine-color-scheme='dark'] { --audit-correction-bg: #2a2416; --audit-correction-edge: var(--mantine-color-warning-6); }
  tr[data-correction='true'] > td:first-child { box-shadow: inset 3px 0 0 var(--audit-correction-edge); }
  ```
  The edge goes on the first cell, not the row, because a row shadow is unreliable in WebKit.
- **Delete** the dark `tr[data-correction='true'] td { color … }` rule and update its comment.
- Contrast:

  | Element | Light (#fff6e3) | Dark (#2a2416) |
  |---|---|---|
  | Body text | 19.54 | 9.40 |
  | Dimmed | 7.26 | 7.03 |
  | Signal | 5.35 | 4.71 |
  | Icon | 14.36 | 14.62 |
  | Edge | 4.61 | 7.18 |

### C15 Reports downloads (R5)
1. **`src/lib/download.ts`:** `downloadFile(url, fallbackName): Promise<{ ok: true } | { ok: false; error: string }>`.
   - `fetch(url, { credentials: 'same-origin' })`. A network error returns "Couldn't reach the server. Check your connection and try again."
   - On `!res.ok`, parse JSON only when the content type is JSON (never throw on the body), then map the status:

     | Status | Message |
     |---|---|
     | 400 | "Check the dates and try again." |
     | 401 | "Your session has expired. Sign in again." |
     | 403 | "You don't have access to this report." |
     | 404 | "That employee wasn't found." |
     | 429 | `Too many downloads. Try again in ${retryAfter ?? Retry-After ?? 60} seconds.` |
     | other | "The report couldn't be generated. Try again in a moment." |

   - On ok: `blob()`. The filename comes from `Content-Disposition`: `filename*=UTF-8''…` decoded inside try/catch (falling back on failure), then `filename="…"`, then the fallback.
   - Download: create `<a download>` with `URL.createObjectURL`, **append it to `document.body`, click, remove**, then `revokeObjectURL` after `setTimeout(…, 1000)`.
2. **ReportsClient:**
   - per card, a `downloading` flag: the button is `aria-disabled` with a `Loader` in `leftSection` (never `loading`), and a click while busy is ignored;
   - a per-card `<Alert color="red" role="alert">` under that card's buttons, cleared on the next attempt or an input change;
   - setState is guarded by a mounted ref set inside an effect: `useEffect(() => { m.current = true; return () => { m.current = false; }; }, [])`.
3. **Server:** in the PDF and CSV routes, move rendering and generation inside the existing try (xlsx already is), so failures return the JSON 500.
   - PDF filename: `base = \`timesheet-${fullName.trim().replace(/\s+/g, '-')}-${periodStart}.pdf\``.
   - Header: `attachment; filename="${ascii}"; filename*=UTF-8''${enc}`, where `ascii = base.replace(/[^A-Za-z0-9._-]/g, '_')` and `enc = encodeURIComponent(base).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())`.
   - CR/LF can't survive either form.

### C16 Users
- **Role change confirm.** `handleSubmit({ confirmed }: { confirmed?: boolean } = {})`, with the form's Save wired as `onClick={() => handleSubmit()}` (today `onClick={handleSubmit}`, `UsersClient.tsx:453`). When editing, `!confirmed` and `form.role !== editingUser.role`, set `roleConfirm = { from, to }` and return. The `ConfirmModal` (with `error={formError}`) calls `handleSubmit({ confirmed: true })`; it closes on success and stays open with the error on failure. The edit Modal gets `closeOnEscape={!roleConfirm}`. N is the full name, and every message ends with " They'll be signed out within a minute and must sign in again."

  | Change | Tone | Title | Message | Confirm |
  |---|---|---|---|---|
  | Employee → supervisor | neutral | "Make N a supervisor?" | "They can review and approve timesheets for employees who share a CLIN with them, and for supervisors or admins who have them set as their approver." | "Make supervisor" |
  | Any → admin | danger | "Make N an admin?" | "Admins have full access: every timesheet and cost figure, users, contracts, billing and workspace settings." Plus, when the acting admin is currently the sole admin: " You'll no longer be able to approve your own timesheets, because another admin can." | "Make admin" |
  | Admin → supervisor | neutral | "Change N from admin to supervisor?" | "They lose access to users, contracts, costs and settings, and keep approving timesheets in their review scope." | "Change role" |
  | Admin or supervisor → employee | neutral | "Change N to employee?" | "They can no longer review or approve timesheets. Admins, and any other supervisor who shares a CLIN with those employees, can still approve them." | "Change role" |

- **Partial save:** the role is saved with name and email, then the approver is set separately. If the approver call fails after the role saved, refetch the user list and `editingUser` before any retry, and show "The role was saved, but the approver couldn't be updated. Try saving again." (inside the confirm, via `error`).
- **FLSA toast:** "Marked exempt" / "Marked non-exempt", with "{N} is now FLSA exempt." / "{N} is now FLSA non-exempt."
- **Wording elsewhere:** `allowlists.ts:133` becomes "true for FLSA-exempt employees, who must still record all hours worked." Fix the two comments the same way.

### C17 Setup wizard (R2)
1. **`internal/setup.ts`:**
   - employee counts filter `inArray(users.role, EXPECTED_SUBMITTER_ROLES)` on active users. This is equivalent to today's `ne('admin')` and keeps the rule in one place.
   - The access step adds `allCovered: total > 0 && withAccess >= total`, `withAccess` and `total`.
   - **The `missing` list is NOT in `steps`.** It's a separate `accessGaps` field computed only by a new `getSetupAccessGaps()` read used by the Setup page (guarded `requireAdmin`), so Home's payload and query count don't change. It returns `{ missingCount, names }` (kept off `SetupStatus`, so `CountKey` doesn't widen): active expected submitters with no active assignment to a code passing `CHARGEABLE_CODE`, as a `NOT EXISTS` subquery with the outer `users.id` written literally, ordered by name, first 20 names.
   - `isComplete` is unchanged.
2. **Client:**
   - one helper `stepState(status, key): 'done' | 'partial' | 'todo'`, where access is `partial` when done but not `allCovered`;
   - it's used by the Stepper, the step panel's badge and alert, and the completion summary grid;
   - an exported pure `firstIncompleteStep(status)`.
   - `refreshStatus` uses **try/catch** (the reads aren't ActionResults): `const [u, gaps] = await Promise.all([getSetupStatus(), getSetupAccessGaps()])`, then `setStatus(u); setGaps(gaps); setActiveStep(firstIncompleteStep(u))`. On failure, the toast "Couldn't refresh setup status."
3. **Stepper:**

   | State | completedIcon | color | Description |
   |---|---|---|---|
   | done | check | `success` | "Done · {count} {label}" |
   | partial | the step icon | `warning` | "{withAccess} of {total} employees have a charge code" |
   | todo | the step icon | `gray` | "Not done · {description}" |

   Steps after `active` render as inactive regardless, so their state is carried by the description text; test it.
4. **Panel and summary:**
   - partial shows the badge "Partly done" (warning) and the alert "{total − withAccess} of {total} employees still need a charge code.";
   - the summary grid shows the warning icon and the same text, never a check.
5. **Completion screen:** when partial, "{k} employees have no direct charge code yet and will see only indirect and leave rows: {names}{ and {k − 20} more}." with a link "Assign charge codes" to `/admin/assignments`. **k and the names both come from the gaps result** (`missingCount`, `names`), refreshed together.
6. **No new steps.**

## 5. State tables

**C1 drawer.** `id` is the request token captured when the load started.

| State | Event | Next state | Side effect |
|---|---|---|---|
| any | open contract X | loading | clear CLINs and SLINs; token +1; fetch |
| loading | fetch ok, `id` = token | ready | set CLINs |
| loading | fetch ok, `id` ≠ token | unchanged | drop |
| loading | fetch fails, `id` = token | error | show the alert |
| error | Retry | loading | token +1 |
| any | close | idle | token +1 |
| ready | mutation resolves, `id` = token | ready | apply |
| ready | mutation resolves, `id` ≠ token | unchanged | drop |
| ready | expand CLIN K (not loading) | ready, K loading | fetch the SLINs |
| K loading | fails | K error | not cached |

**C7 client.**

| Form vs current / pending | Save | Banner button | Server path |
|---|---|---|---|
| = pending (or = current, none pending), same date | aria-disabled | (Cancel if pending) | — |
| = current, pending exists | aria-disabled ("…use Cancel scheduled change") | Cancel | — |
| = pending, different date | enabled | Cancel | re-schedule |
| ≠ baseline | enabled | (Cancel if pending) | schedule or immediate |
| (any) | — | Cancel → confirm | `cancelPending` |

**C7 server** (under the advisory lock):

| Input | Pending? | Result |
|---|---|---|
| `expectedPendingId` ≠ actual pending id | any | refused ("updated by someone else") |
| `cancelPending` | yes / no | pending deleted / no-op; `cancelledPending` |
| ≡ current | yes | pending deleted; `cancelledPending` |
| ≡ current | no | refused ("already your pay schedule") |
| ≡ pending, same date | yes | idempotent, no writes |
| else | any | existing logic |

## 6. Failure modes
- **C1 / C4 / C13 / C17, reads that throw:** every read here is wrapped (C1 try/catch; C4 in the existing try; C13 refresh is fire-and-forget; C17 try/catch). None reaches the error boundary.
- **C1, out-of-order results:** reads and mutations are token-checked.
- **C3, a racing seed:** `onConflictDoNothing` returns fewer created, never an error.
- **C7:**
  - **Concurrent admins:** the advisory lock serialises them, and all reads run on `tx`.
  - **A stale page:** `expectedPendingId` refuses (the id changes on every replace, so even a same-date replacement is detected).
  - **Cancel with no pending:** idempotent.
- **C13:**
  - **Concurrent saves:** the upsert can't hit the unique index.
  - **Delete races:** "no longer exists" and removed locally.
  - **Clear during a save:** blocked while in flight.
- **C15:**
  - **A non-JSON error body:** the generic message.
  - **Double click:** ignored.
  - **Unmount:** guarded.
  - **Rate limit:** the 429 copy.
  - **A bad `filename*`:** decode is try/caught.
- **C16, partial save:** the role saved but the approver failed. Refetch, show the explicit message, and a retry won't re-confirm a role that's already saved, because `editingUser` is refreshed.

## 7. Platform limits
Report files are unchanged in size. C5's `exists` subquery has no `timesheet_entries` index leading with `charge_code_id` (the existing ones lead with `user_id`), so it may scan. That's acceptable at current tenant sizes, and `exists` stops at the first match. It runs on both Charge codes and Assignments loads. **Don't add an index here**; record a follow-up if either page ever loads slowly.

## 8. Blast radius
| Area | Files |
|---|---|
| Shared | `components/ui/ConfirmModal.tsx` (the `error` prop) |
| Clients | Contracts, Indirect codes, Labor categories, Charge codes, Dashboard, Pay schedule and its page (full pending config), Workspace, Reset password form, Import, Migration, API keys, QuickBooks and Gusto config, Audit trail, Reports, Users, Setup wizard and its page (`getSetupAccessGaps`) |
| Server | `indirect-codes.ts`, `labor-categories.ts`, `charge-codes.ts` (affects `charge-codes/page.tsx` **and** `assignments/page.tsx`), `pay-period-config.ts`, `integrations.ts`, `internal/setup.ts`, `actions/setup.ts` (new guarded read), report routes (PDF, CSV), `signup/verify/route.ts`, `src/lib/csv-parser.ts` |
| New | `src/lib/download.ts`; `sameSchedule`; `--audit-correction-*` |
| Tests to update | `settings-pages.test.tsx` (effective-dates fetch timing; pending fixture); `period-lock-integrity.test.ts` (keeps `toEqual({ effectiveFrom: null })` passing; **`:286`** now hits "already your pay schedule" after `sundayWeekly` is applied, so use a different schedule, e.g. monthly, for that `/must start on a future date/` assertion); `gusto-auto-match.test.tsx` (`next/navigation` mock, `deleteMapping` mock, `saveMapping` → `{ id }`); `rate-schedule-ui.test.tsx` (add `getAssignableLaborCategories`); `setup-wizard.test.tsx` (fixture fields, done screen); `reset-password-page.test.tsx` (parameterised `useSearchParams`); tests pinning `allowlists.ts:133 / :203`; `server-action-guards` (add `getSetupAccessGaps` to `ADMIN_READ_ONLY_ALLOWLIST['setup.ts']`, `:177`; `guard-first-oracle` lists mutations only and doesn't change); `fresh-admin-writes` (non-UUID `deleteMapping` still passes, since validation follows the guard) |

## 9. Test matrix
Each test must fail without its fix.

| ID | File | Scenario |
|---|---|---|
| T-CM | `unit/confirm-modal.test.tsx` | The `error` prop renders `role=alert` inside the dialog; absent → nothing; while loading, Esc doesn't close, there's no ✕, and the confirm button has `aria-disabled` and never `disabled` |
| T-C1a | `unit/contracts-drawer-loading.test.tsx` | Opening B after A clears A's CLINs and shows `role=status` loading (B deferred) |
| T-C1b | same | A stale A response after B is ignored |
| T-C1c | same | A failed fetch shows `role=alert`, the page doesn't crash, and Retry loads |
| T-C1d | same | A failed SLIN fetch isn't cached |
| T-C1e | same | "Add" is aria-disabled while loading, doesn't spin, and a forced click does nothing |
| T-C1f | same | A CLIN created on A that resolves after switching to B doesn't appear in B's list |
| T-C2a | `unit/indirect-codes-row-actions.test.tsx` | The switch label and description; the column shows "Hidden" and "Inactive"; search for "Hidden" finds the row |
| T-C2b | same | Turning off confirms: Cancel → no update; Confirm → one update; a server error appears **inside the confirm dialog** |
| T-C2c | same | Turning on or leaving it unchanged → no confirm |
| T-C3a | `unit/seed-indirect.test.ts` | Existing rows → `{ created: 0 }` with no insert; empty → 9 |
| T-C3b | `unit/indirect-codes-row-actions.test.tsx` | Button absent when codes exist **and** absent for a search with no matches; created 0 → the "none were added" toast |
| T-C3c | `unit/setup-wizard.test.tsx` | Created 0 → no "9 … seeded" text |
| T-C3d | `integration/indirect-seed.test.ts` | Deterministic race: an open transaction inserts OH-001 uncommitted; the seed starts (sees empty, blocks on the unique index); commit → `{ created: 8 }` with no error. A second seed → 0 |
| T-C4a | `unit/labor-categories-assignable.test.tsx` | Reactivating adds the LCAT to the options; deactivating removes it and clears the selection |
| T-C4b | `integration/labor-categories.test.ts` | Assigning to an inactive LCAT, an LCAT with an inactive CLIN, or an inactive contract → refused; non-UUID → validation error; unknown id → "no longer exists" |
| T-C5a | `unit/charge-codes-row-actions.test.tsx` | hours → read-only with the hours reason; categories → the categories reason |
| T-C5b | same | Inactive CLIN with no hours → editable Selects with the "(inactive)" option preselected; moving to another CLIN sends the new `clinId`; renaming sends no `clinId` |
| T-C5c | `integration/cost-basis.test.ts` | `hasHours` true for a used code and false for an unused one while another code has entries (correlation) |
| T-C6 | `unit/dashboard-remaining.test.tsx` | Expanding logs no key warning |
| T-C7a | `unit/date-utils.test.ts` | `sameSchedule`: biweekly ±14 (incl. negative) equal, 7 not; semimonthly ignores the anchor; a null anchor → false |
| T-C7b | `unit/pay-schedule-client.test.tsx` | No pending: Save aria-disabled until something changes → confirm → the action only on Confirm. **A pending fixture loads with Save aria-disabled and the pending date selected.** With a pending change, a form equal to current → Save aria-disabled with the "use Cancel scheduled change" reason. Weekly label for a Sunday start; labelled fields |
| T-C7c | same | The banner's Cancel → confirm with "Keep scheduled change" → sends `cancelPending` → banner cleared, form reset. Changing only the pending date enables Save |
| T-C7d | `integration/period-lock-integrity.test.ts` | Identical save refused with no row; identical-while-pending cancels; `cancelPending` idempotent; identical-to-pending → no writes; a mismatched `expectedPendingId` → refused, **including a same-date replacement by another admin**; checks run before the null branch (a workspace with timesheets can still cancel) |
| T-C7e | same | Deterministic lock test: the test holds `pg_advisory_xact_lock(hashtext('pay_period_config'))` in its own transaction, fires two different saves, polls `pg_locks` (`locktype='advisory' and not granted`) until it sees 2 waiters (without the lock the saves finish instead, and the test fails), commits, then asserts exactly one pending row and one "updated by someone else" refusal |
| T-C8 | `unit/settings-pages.test.tsx` | Timezone confirms first; an error shows inside the confirm; both Selects labelled |
| T-C9a | `unit/reset-password-page.test.tsx` | `welcome=1` → welcome copy, never "Resetting password for"; `true` / `1x` → reset copy |
| T-C9b | `unit/signup-verify.test.ts` | Both pages have one `<main>` and one `<h1>`; no `#228be6` / `#9ca3af`; text colours ≥ 4.5:1 (the focus outline checked against 3:1) |
| T-C10 | `unit/import-row-errors.test.tsx` | Visible errors in both tabs; the `role=status` count; the missing-columns alert; a server error on the first valid row is shown as its file row; choosing a new file mid-import doesn't remap |
| T-C11 | `unit/migration-client.test.tsx` | Uploads are labelled focusable buttons reachable by Tab; no `label > input[hidden]`; no false copy; a new file clears the old rows and filename |
| T-C12 | `unit/api-keys-client.test.tsx` | Esc doesn't close; no ✕; "I've copied the key" closes |
| T-C13a | `unit/integration-mapping-ui.test.tsx` | The name shows before Load; clearing → `deleteMapping(realId)`; Sync → `router.refresh`; the Select is blocked during an in-flight save (QuickBooks and Gusto) |
| T-C13b | `integration/integrations.test.ts` | `saveMapping` returns the id on insert and update (same id); `deleteMapping` removes it; non-UUID → validation; twice → "no longer exists" |
| T-C14 | `unit/audit-correction-contrast.test.ts` | Uses `var(--audit-correction-bg)`; both schemes defined; no dark td colour rule; the edge on `td:first-child`; contrast pairs pass |
| T-C15a | `unit/download.test.ts` | Filename parsing (quoted, `filename*`, a malformed `%` falls back, missing); status mapping incl. 429 `retryAfter` and the header fallback; a non-JSON 500 → generic; a network error |
| T-C15b | `unit/reports-download.test.tsx` | Never calls `window.open`; per-card alert; the button never gets `disabled` while busy; a second click ignored; the anchor is appended to `document.body` |
| T-C15c | `integration/report-routes.test.ts` | A name `Zoë "Z" O'Brien` → `filename*` with `%27`, `%22`, `%C3%AB`; an ASCII fallback with no quotes or CR/LF; a render failure → JSON 500 |
| T-C16 | `unit/users-row-actions.test.tsx` | Each transition's text; Cancel → no update; Confirm → one update; a name-only edit → no confirm; a server refusal → the error **inside the confirm dialog**; an approver failure after the role saved → the partial-save message and a refreshed user; the FLSA toast has no "salaried" or "hourly" |
| T-C17a | `unit/setup-wizard.test.tsx` | A skipped step before the active one shows "Not done"; access at 2 of 3 → warning plus "2 of 3 employees…" in the Stepper, panel **and** summary grid (no check anywhere) |
| T-C17b | same | Refresh moves to the next incomplete step and refetches the gaps (after refresh, the names match the new status); a refresh failure → toast; the completion screen names the missing employees, plus "and N more" past 20 |
| T-C17c | `unit/setup-status.test.ts` + integration | `allCovered` only when every active employee and supervisor has a chargeable code; `getSetupAccessGaps` lists them (correlation pinned with another user's assignment present); Home's payload has no names |

## 10. Verification
- **Dev:** `npx tsc --noEmit && npm run lint && npm run test && npm run test:tz && npm run db:safety`.
- **Product owner:**
  1. The integration suite.
  2. The lead's break-it script.
  3. `npm run build && node scripts/check-build-trace.mjs && node scripts/check-css-output.mjs`.
  4. `npm run demo:local` twice.
- **Browser checks** (light and dark):
  1. Contracts: switch quickly between two contracts' CLINs; add a CLIN, then switch before it saves.
  2. Indirect codes: hiding asks first; "Add standard codes" appears only with no codes.
  3. Labor categories: a new category is assignable without reloading.
  4. Charge codes:
     - a code with hours shows its CLIN read-only;
     - a code on an inactive CLIN can still be moved.
  5. Pay schedule:
     - Save is unavailable until you change something;
     - a change asks first;
     - with a scheduled change, "Cancel scheduled change" works.
  6. Workspace: a timezone change asks first.
  7. First run, on a **throwaway local tenant** only: sign up, verify, and see "Welcome to CadenzPoint".
  8. Import: bad rows and a missing column show visible messages with correct row numbers.
  9. History import: Tab reaches the upload.
  10. API keys: Esc doesn't close the key dialog.
  11. QuickBooks / Gusto: only if connected locally.
  12. Audit trail in dark mode: correction rows are readable.
  13. Reports:
      - a download works;
      - the 11th download within a minute shows an inline "Too many downloads…" message, not a new tab.
  14. Users: a role change asks first, with accurate text.
  15. Setup: honest steps, and "2 of 3" when partial.

## 11. Pre-mortem record
**Round 1:** 0 HIGH, 11 MEDIUM, all applied in v2:

| Area | Finding | Fix in v2 |
|---|---|---|
| C7 | stale baseline / Save enabled with pending | explicit state, a Cancel button, the date-change path |
| C7 | not race-safe | advisory lock, all reads on `tx` |
| C7 | check order and cancel input | checks before the null branch; `cancelPending` |
| C17 | `runAction` on a raw read | try/catch |
| C17 | summary and panel still showed a check | `stepState` everywhere |
| C2 / C16 | confirm errors hidden behind the overlay | `ConfirmModal` `error` prop, `confirmed` re-entry |
| C2 | copy wrong about what hiding does | accurate copy |
| C1 | mutations landing in the wrong drawer | token-checked |
| C5 | the inactive lock removed a working path | editable with an "(inactive)" option |
| C16 | messages vs approval rules; the partial save | corrected copy, refetch and message |
| T-C3d | couldn't fail | deterministic race |

All LOWs were applied as well: line refs, the `csv-parser` path, snapshotted row maps, migration clearing, the upsert, Home payload isolation, the RFC 5987 extra characters, the anchor append, the mount-flag pattern, 404 copy, the edge on `td:first-child`, and the "Keep scheduled change" label.

**Round 2:** 0 HIGH, 5 MEDIUM, 9 LOW, all applied in v3:

| Area | Finding | Fix in v3 |
|---|---|---|
| C7 | Save enabled on load with pending | date initialised to the pending date |
| C7 | form = current while pending | aria-disabled with a reason |
| C7 | date-keyed stale check | `expectedPendingId` |
| T-C7e | nondeterministic | `pg_locks` waiter polling |
| C17 | stale names after refresh | gaps refetched together |

The LOWs: the `workspaceHasNoTimesheetData` type; the page already passes the pending row; cancel skips `parseScheduleInput` / `anchorProblem`; the `period-lock-integrity:286` update; `onClick={() => handleSubmit()}`; a single error location; `ConfirmModal` locked while loading with no `disabled`; the C13 `set` fields; the guard-table placement.

## 12. Hand-off rules and commit order
**Commit order:** one commit per line, each with its tests.
1. `ConfirmModal` error slot
2. C1 + C6
3. C2 + C3
4. C4
5. C5
6. C14
7. C15
8. C16
9. C7 + C8
10. C9
11. C10 + C11
12. C12
13. C13
14. C17

**Rules:**
- Follow `BLUEPRINT-STANDARD.md` §3: an impact analysis first; stop and ask if anything is unclear.
- Every §9 test must fail without its fix: revert-check each and report.
- Never use demo tenants for destructive or first-run checks. Don't push. Don't edit the Terms or Privacy pages.
- Report: commits; gates; revert checks; what wasn't run; gap decisions, with your reasons.
