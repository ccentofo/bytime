# UX-1 foundations: lead audit of the implementation

**Audited:** branch `ux-foundations` at `e2d1915` (6 commits on `7dae17d`) against `feature-plan-ux-foundations.md` v3 FINAL. **Date:** 2026-10-27.
**Method:** the lead re-ran the gates, checked the server-untouched claim, and read the patch script and `RowActions`. Two independent auditors reviewed the work: theme, patch, structure, lint and tests; and tables and RowActions. Both mutation-tested in scratch copies and read every in-scope test. The lead re-verified the MEDIUM theme finding in Mantine's source.

**Verdict: NOT READY TO MERGE. No HIGH. Three MEDIUMs, all fixed in round 1 below.**

## 1. Gates and lead checks

| Check | Result |
|---|---|
| `tsc` | clean |
| `npm run lint` | 0 errors, 66 warnings (baseline 58; +9 exactly as §2 predicted, −1 from removed unused vars) |
| `npm run test` | 107 files, 1472 pass |
| Server untouched | `git diff main..ux-foundations -- src/server src/db drizzle src/lib scripts` shows only the new `scripts/patch-mantine-react-table.mjs` |
| Lockfile (hand-edited) | root specs match `package.json`; `npm ci --dry-run --offline` passes (auditor) |
| Patch script | idempotent; total-count rule; missing-dir check before version check; CLI guard; simulated unpatched dist files patch byte-identical to the installed ones |
| Dev's break-its | 74 mutations, 73 caught, 1 equivalent (LN-4, accepted). The auditors independently re-ran 20+ mutations, all caught. |
| Integration, build, browser checks | product owner, pending |

## 2. Rulings on the dev's deviations

All accepted:
- **Lockfile written by hand** (verified consistent).
- **axe helper moved into commit 3** (needed by T7/T8).
- **Staged allowlist** (49 → 39).
- **Theme default `closeButtonProps: { 'aria-label': 'Close' }`** on Modal and Drawer. A real axe finding; good catch.
- **AppHeader Sign out** moved to the `.danger` class.
- **Registry-driven icon swaps.**
- **Extra `aria-label`s** on the CLIN chevron and the copy button.
- **Heading-level fixes** in privacy, terms, setup, billing and the error boundaries.
- **Per-row `busy`.**

## 3. Fix round 1 (required before merge)

### M1 (MEDIUM, lead-verified; blueprint gap): dark-mode focus ring, focused input border and checked indicators below 3:1
- **Where:** `primaryShade.dark` is now 7 (`src/theme.ts`), which white button text needs. Mantine draws focus rings and the input focus border with `--mantine-primary-color-filled` (`node_modules/@mantine/core/styles.css:61,66,1448,1454`). Checked Checkbox/Radio/Switch fills and the Tabs indicator use the same variable.
- **Failure:** in dark mode, signal-7 `#3f55e6` measures **2.63:1** on dark-6 (cards, inputs) and **3.03:1** on dark-7. WCAG 1.4.11 needs 3:1 for focus indicators and state. It was about 3.7–4.2 before. Light mode is unaffected (5.75:1).
- **Why the tests missed it:** rule R checked signal-6 as "the focus ring". The ring doesn't use shade 6. This is the lead's blueprint error.
- **Fix:**
  1. In `src/app/globals.css`: `.mantine-focus-auto:focus-visible, .mantine-focus-always:focus { outline-color: light-dark(var(--mantine-color-signal-7), var(--mantine-color-signal-4)); }`.
  2. Input focus border: set the `--input-bd-focus` var to the same `light-dark(...)` value for Input, via `theme.components.Input` `vars`, or a globals rule on the input wrapper. Use whichever Mantine 9 supports cleanly, and say which.
  3. Dark-mode checked fills: Checkbox, Radio, Switch and the Tabs active indicator use signal-4 (`#6f84ff`) via the component `color` / CSS var. Check that the white check icon on signal-4 is ≥ 3:1.
  4. **T1:** replace the signal-6 ring pair with the **actual** ring color per scheme (signal-7 light, signal-4 dark) against white, ink-0, dark-7 and dark-6 (≥ 3). Add checked-indicator pairs.
- **Break-it:** remove the globals override → T1 must fail. The static part of T1 asserts the override exists in `globals.css`.

### M2 (MEDIUM): no test keeps "Manage CLINs and SLINs" usable in read-only mode
Removing `writes: false` (`ContractsClient.tsx:333`) leaves T11 green, and this was a round-1 HIGH.
**Fix:** a T11 case mounting in `'read_only'`, opening the menu, asserting the item has no `aria-disabled`, clicking it, and asserting the drawer opens.

### M3 (MEDIUM): "the confirm closes only on success" is tested for Users Deactivate only
- Mutation: calling `onDone` before the `result.ok` check in `IndirectCodesClient.tsx` (~`:165`) leaves T10 green.
- T11 never asserts the SLIN Confirm arguments.
- **Fix:**
  - Add `mockResolvedValueOnce({ ok: false, … })` → the dialog is still open and the confirm is enabled again, to T10, T11 (CLIN and SLIN) and the T9 FLSA case.
  - Assert SLIN Confirm calls `updateSlin('s1', { status: 'inactive' })` once.

### LOWs (cheap; same round)
- **L1** Put the menu-item reason in `<Text component="span" display="block" …>` (`RowActions.tsx:107`). A `<p>` inside a `<button>` is invalid HTML.
- **L2** Confirm titles flash blank ("Deactivate ?") while the modal animates closed, because the target state is cleared on close. Keep the last target until `onExitTransitionEnd`, or in a ref. Applies to Users `:327-345`, Indirect `:266-273` and Contracts `:614-632`.
- **L3** Search can't find the new Status/FLSA words (boolean accessors). Use `accessorFn: r => r.isActive ? 'Active' : 'Inactive'`, and the same for FLSA and Indirect Status.
- **L4** The icon ratchet regex misses deep, dynamic, `require` and side-effect imports (`icon-registry.test.ts:69`). Use `/(from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]@tabler\/icons-react(\/[^'"]*)?['"]/`.
- **L5** `busyRow` is a single value, so one row's finish can clear another row's loader (`UsersClient.tsx:183-186,236-240`). Use a per-row `Set`.
- **L6** The patch CLI guard silently skips when the path goes through a symlink. Use `realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)` (`scripts/patch-mantine-react-table.mjs:96`).
- **L7** The error-boundary h1 is passed as `Alert title`, so it renders inside a `<span>` (`(app)/error.tsx:26`, `admin/error.tsx:27`). Render a `Title order={1} size="h3"` above the Alert instead.
- **L8** `src/app/error.tsx` has no `<main>`. Add `component="main"` on its `Center`.
- **L9** T1b scanner: `stripComments` drops everything after `//` in a URL (`helpers/source-scanner.ts:17`); strip comments only outside string literals. Also accept single-quoted attributes.
- **L10** Tests:
  - T16 signup "Check your email" states: assert their Anchors render as `<button type="button">`.
  - Make T5's "no `in` warning" test do its own first render, so it isn't vacuous when run alone.
  - Assignments: assert column filters show and the action is hidden on inactive rows.
- **L11** `correction` and `edit` are both pencils in `icons.ts`. Use `IconPencilCog` (or `IconHistoryToggle`) for correction.

**Deferred (recorded, not this round):**
- PageHeader pages skipping h1 → h4/h5 (pre-existing skips; UX-4 page pass).
- Demo badge edge in dark mode (`AppHeader.tsx:41`); the header is redesigned in UX-2.

## 4. Fix round 1 verification (`d5bff0d`), 2026-10-27

- **Lead gates:** `tsc` clean; lint 0 errors / 66 warnings; 109 files / 1494 tests pass.
- **M1:**
  - The ring override uses `:root` specificity, so CSS load order doesn't matter.
  - The dark input border is a CSS rule, because Mantine 9's typed Input vars lack `--input-bd-focus` (accepted).
  - Checked indicators come from theme `vars`, and only when the caller passes no `color`.
  - SegmentedControl's outline got the same fix (good addition).
  - `light-dark()` resolves, because Mantine sets `:root { color-scheme: var(--mantine-color-scheme) }` (`styles.css:3`).
  - T1 now measures the declared colors, including the white mark on signal-4 at 3.27:1.
- **M2, M3 and L1–L11:** fixed as specified. The dev reports 32/32 break-its; L10-d was first survived, then fixed with the T5 visibility rule.
- **Lead break-it spot checks:**
  - removing the dark ring override fails T1 (2 tests);
  - removing `writes: false` on Manage CLINs fails T11 "read-only …".
- **Code audit: CLEAN.** Pending only the product owner's runs: `npm install`, `npm run build && node scripts/check-build-trace.mjs`, integration, fresh `.next` + `npm run dev`, and blueprint §10 browser checks plus the dark-mode focus check.
