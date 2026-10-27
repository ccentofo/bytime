# Blueprint UX-1: UX foundations (shared parts, contrast, table fix, page structure)

> **Role for the executing developer:** senior front-end / design-systems engineer.
> **Follows:** `BLUEPRINT-STANDARD.md`. **Source documents:** `UX-AUDIT.md` (findings cited as B#, A#, V#, §4.n) and the approved mockups in `ux-mockups/index.html`.
> **Status:** v3 (FINAL), 2026-10-27, lead architect. Pre-mortem rounds 1 and 2 fixed (§13). **Branch:** cut `ux-foundations` from an up-to-date `main`.

**What this phase delivers:**
- **Shared parts** that every later UX phase builds on:
  - contrast-safe theme;
  - one icon registry;
  - one row-action component;
  - confirm-modal tone;
  - table defaults.
- **The broken table controls, fixed** (B4).
- **Every table moved to the new row-action rule**, including confirmation for destructive switches (B2).
- **Real page titles, one h1 per page, a skip link and auth-page landmarks** (A6, A9).
- **Accessibility lint rules and automated axe checks** in the unit suite.

**Out of scope (later phases; do not start them):**

| Phase | Scope |
|---|---|
| UX-2 | Navigation, Home, Settings area, Approvals as a to-do list, Setup Wizard fix (B1, B3) |
| UX-3 | Timesheet layout and keyboard grid (A1–A4, A10, V1–V5) |
| UX-4 | Page pass, forms, copy and sentence-case labels, MoneyInput/StatCard/format helpers, page merges, reflow (A7) |
| UX-5 | Playwright + axe in CI, lint warnings → errors, ACR |

**This phase changes no server action, schema, query or business rule.**

---

## 0. Decisions

| # | Decision | Ruling |
|---|---|---|
| UX-D1 | Primary blue for filled buttons and text | `#3F55E6` (signal-7). `#4F6BFF` stays the accent for focus, today, meters and the logo dot (product owner, 2026-10-27). |
| UX-D2 | Text case | Sentence case. In UX-1 this applies to badges (theme) and every new string this phase writes. The app-wide copy pass is UX-4. |
| UX-D3 | Where employees land | Timesheet (UX-2; no work here). |
| UX-D4 | Theme | Follow the OS. **Already true** (`src/app/layout.tsx:41-42` `defaultColorScheme="auto"`); no work. |
| L1 (lead) | B4 fix method | An idempotent patch script, run on `postinstall`, `predev` and `prebuild`, with `mantine-react-table` pinned exactly. No new dependency. |
| L2 (lead) | Icon migration | A registry plus a **ratchet** test. UX-1 migrates only the files it already touches; the allowlist shrinks in later phases. |

## 1. Verified current state (file:line, `main` at `ff0a185`)

**Theme and colors**
- `src/theme.ts:43` sets `primaryShade: { light: 6, dark: 5 }`, with custom tuples `signal`, `ink`, `success`, `warning` and `dark` (`:7-39`). `red`, `gray` and `cyan` are Mantine defaults. `Badge` defaults to `variant: 'light'` (`:61`).
- Colors used in `src/`:

  | Prop | Uses |
  |---|---|
  | `c="dimmed"` | 172 |
  | `color="red"` | 44 |
  | `success` | 38 |
  | `warning` | 35 |
  | `signal` | 28 |
  | `gray` | 18 |
  | `ink` | 7 |
  | `grape` | 4 (`AuditTrailClient.tsx:189,274,560`, `AppHeader.tsx:40`) |

  `cyan` appears in `src/lib/ui/status-colors.ts` (`INDIRECT_CATEGORY_COLOR.irad`).
- **Contrast today** (computed): white on signal-6 is 4.30:1 on every primary button. White on success-6 is 3.30. Dimmed gray-6 on white is 3.32. Warning text is 2.0–2.8. Input borders (gray-4 on white) are 1.57. All need 4.5 (text) or 3.0 (control edges).

**Tables**
- `src/components/table/mrtDefaults.ts:25-49` holds `useAppTable` (deep merge of defaults, where functions and arrays in the override replace the base). The actions column is fixed at `size: 80` with `header: ''` (`:34`). There are no toolbar settings, so MRT defaults apply: global filter and column filters on, with toggle icons in the toolbar.
- `layout.tsx` is a **Server Component** (it exports `metadata`) that renders `MantineProvider` directly (`src/app/layout.tsx:42`). Mantine providers are `"use client"`, so **no function prop can be passed from layout**.
- Explicit shades that don't switch per scheme: `c="warning.7"` (`UnpricedNote.tsx:21-22`, `ChargeCodeCell.tsx:37`) and `c="signal.6"` (`ApprovalsClient.tsx:279`).
- 12 `useAppTable` calls in 10 files: ApiKeys, Approvals, Assignments ×2, AuditTrail, ChargeCodes, Contracts, Dashboard ×2, IndirectCodes, LaborCategories ×2, Users. Ten of them paste the same center-align `displayColumnDefOptions['mrt-row-actions']` block (e.g. `ChargeCodesClient.tsx:288`).
- **Row actions today** (UX-AUDIT §4.1):

  | Table | Current actions |
  |---|---|
  | Charge Codes `ChargeCodesClient.tsx:253-283` | 3 icons in a wrapping `<Group>`, so they wrap (V8) |
  | Users `UsersClient.tsx:258-285` | `Active` and `FLSA Exempt` are **cell Switches that write immediately with no confirmation** (B2), through `handleToggleActive` / `handleToggleFlsaExempt` (`:212-240`) |
  | Indirect codes `IndirectCodesClient.tsx:209` | Active Switch, no confirmation (B2) |
  | CLIN/SLIN drawer `ContractsClient.tsx:505,590` | Deactivate text buttons, no confirmation (B2) |
  | Labor categories `LaborCategoriesClient.tsx:433-470` | `IconToggleLeft` for both directions |

- **`ConfirmModal`** (`src/components/ui/ConfirmModal.tsx`): the confirm button is always `color="red"`, so "Reactivate" gets a red button (`ChargeCodesClient.tsx:373`).
- **`WriteButton` / `useCanWrite`** (`src/components/shell/WorkspaceMode.tsx:27-46`) is visibility only; the server write gate is the real control. Row ActionIcons use `disabled={!canWrite}` with no reason shown.
- **Credential actions intentionally ignore read-only mode:** `unlockUserAccount` (`src/server/actions/users.ts:56-61`, comment "an admin can unlock a user in any non-closed mode") and `adminResetPassword` (`src/server/actions/password.ts:106`).

**B4: table controls never open**
- `mantine-react-table@2.0.0-beta.9` (peer `@mantine/core ^7.9`) is installed against `@mantine/core 9.3.1`, silently, because `.npmrc` sets `legacy-peer-deps=true`.
- Mantine 9 renamed `Collapse`'s `in` to `expanded` (`node_modules/@mantine/core/lib/components/Collapse/Collapse.d.ts:6`). `Collapse.mjs:41` renders closed when `expanded` is falsy and spreads `in` onto the DOM div, which causes the React warning.
- MRT has 5 Collapse calls per dist file. Exact source text:

  | File | Line | Unpatched text |
  |---|---|---|
  | `index.esm.mjs` | 458, 2082, 2468 | `jsx(Collapse, { in: ` |
  | `index.esm.mjs` | 2532 | `jsxs(Collapse, { className: classes$9.collapse, in: ` |
  | `index.esm.mjs` | 3362 | `jsx(Collapse, { className: clsx(classes$4.collapse, isTopToolbar && classes$4['collapse-top']), in: ` |
  | `index.cjs` | 460, 2084, 2470 | `jsxRuntime.jsx(core.Collapse, { in: ` |
  | `index.cjs` | 2534 | `jsxRuntime.jsxs(core.Collapse, { className: classes$9.collapse, in: ` |
  | `index.cjs` | 3364 | `jsxRuntime.jsx(core.Collapse, { className: clsx(classes$4.collapse, isTopToolbar && classes$4['collapse-top']), in: ` |

  ` in: ` appears exactly 5 times per file, and `expanded:` 0 times.
- **App impact** (product owner confirmed 2026-10-27):
  - The global search never shows, on every table.
  - Column filters never show (Assignments configures checkbox filters, `AssignmentsClient.tsx:243,259,348,370`).
  - The Dashboard CLIN breakdown (`DashboardClient.tsx:192-193`) never opens.
  - Every table logs the warning.
- **Other MRT↔Mantine 9 mismatches don't affect the app:**
  - `useHover` ref only matters with `enableHeaderActionsHoverReveal`, which is unused.
  - `DateInput` string values only matter with `filterVariant: 'date'`, which is unused.
- **Install paths:**

  | Path | Behaviour |
  |---|---|
  | CI (`ci.yml:31,88,136`) | `npm ci`; postinstall runs |
  | Deploys (`deploy-prod.yml:26`, `deploy-staging.yml:31`) | `npm ci` (postinstall patches) and `vercel build` on the runner (`deploy-prod.yml:50`), then `vercel deploy --prebuilt` |
  | `Dockerfile:4-5` | `npm ci --ignore-scripts` (**postinstall does not run**), then `COPY . .` and `npm run build` (`:13`) |
  | `package.json` | No `postinstall`, `predev` or `prebuild`; `"mantine-react-table": "^2.0.0-beta.9"` (caret; lockfile pins beta.9 at `package-lock.json:9073`) |

  No patch tooling exists. `beta.9` is the newest 2.x release (registry dist-tags: latest 1.3.4, beta 2.0.0-beta.9).

**Page structure**
- **Titles.** `src/app/layout.tsx:24-27` sets one plain-string title for every route; no other file exports metadata. All 30 `page.tsx` files are server components **except `src/app/reset-password/page.tsx` (client)**. `app/error.tsx`, `app/global-error.tsx`, `(app)/error.tsx`, `admin/error.tsx` and `timesheet/error.tsx` are client error boundaries.
- **Headings.** `PageHeader` renders `Title order={2}` (`src/components/ui/PageHeader.tsx:11-24`), used by 18 files. Pages with their own top heading:

  | Page | Heading |
  |---|---|
  | Timesheet (`PayPeriodSelector.tsx:77`) | h3 |
  | Setup (`SetupWizardClient.tsx:188,249`) | h2 |
  | Payroll export `:139`, QuickBooks `:231`, Gusto `:242` | h2 |
  | Forgot password `:47`, SignupForm `:90,117,227`, reset-password `:93` | h2 |
  | WorkspaceFinder `:38` | h3 |
  | Login | no heading |
  | Landing `src/app/page.tsx:29-31` | no h1 |

  The only h1s are on privacy and terms.
- **Landmarks.** `AppShellWrapper.tsx:87-166` renders Mantine `AppShell` (header/nav/main elements). `AppShell.Main` (`:120`) has no `id`, and there is **no skip link**. Auth and public pages have **no `<main>`**: Login `:119`, ForgotPassword `:43`, WorkspaceFinder `:34` and TenantUnavailable `:38` use `<Center mih="100vh">`; landing, privacy and terms use `<Container>`; reset-password uses a `Center` (`page.tsx:163`).
- **`<Anchor onClick>` with no href** is unreachable by keyboard: `LoginForm.tsx:205-210`, `SignupForm.tsx:97,237`.

**Lint and tests**
- **ESLint.** `eslint.config.mjs` spreads `nextVitals` and `nextTs`. `eslint-config-next` registers `jsx-a11y` (`node_modules/eslint-config-next/dist/index.js:119`) with only 6 rules at `warn` (`:173-188`). CI runs `npm run lint` (`ci.yml:33-34`); the baseline is 0 errors and 58 warnings.
- **Unit tests.** vitest runs in a `node` environment. jsdom tests opt in per file with `// @vitest-environment jsdom` (10 files) and mount with `createRoot` + `act` + `MantineProvider`, stubbing `matchMedia` and `ResizeObserver` (pattern: `src/__tests__/unit/dashboard-remaining.test.tsx:3-45`). `@testing-library/dom` is **not installed** (`login-form.test.tsx:11`).
- **axe.** `axe-core 4.12.1` is present **only transitively** (via `eslint-plugin-jsx-a11y`); it isn't in `package.json`. Playwright is absent.
- **Icons.** 50 files import `@tabler/icons-react` directly.

## 2. Verified external facts

| Fact | Source |
|---|---|
| **Mantine 9.3.1 color derivation, light.** `--{c}-filled` = shade[primaryShade.light]. `--{c}-text` (the `c="x"` prop) = filled. `--{c}-light` = shade 1. `--{c}-light-color` = shade 9. `--{c}-outline` = filled. | `node_modules/@mantine/core/esm/core/MantineProvider/MantineCssVariables/get-css-color-variables.mjs:7-17` |
| **Mantine 9.3.1 color derivation, dark.** filled = shade[primaryShade.dark]. text = shade 4. light = `darken(shade9, .5)`. light-color = shade 0. outline = shade[max(primaryShade−4, 0)]. | same file, `:36-46` |
| **`primaryShade` applies to every color's filled/text variants,** not only `primaryColor`. | same file |
| **Global variables** (light / dark): dimmed = gray-6 / dark-2; error = red-6 / red-8; placeholder = gray-5 / dark-3; default-border = gray-4 / dark-4; anchor = primary[light shade] / primary-4. Overridable via `MantineProvider cssVariablesResolver`, typed `(theme) => { variables, light, dark }`. | `default-css-variables-resolver.mjs`; `MantineProvider.d.ts:30` |
| `theme.respectReducedMotion` exists. | `theme.types.d.ts:89` |
| `Collapse` prop is `expanded` (required); `keepMounted` defaults to true (React 19 Activity). | `Collapse.d.ts:6,18` |
| MRT beta.9 has the options `enableToolbarInternalActions`, `positionGlobalFilter`, `initialState.showGlobalFilter` / `showColumnFilters`, `mantineSearchTextInputProps`, and `mantineTableHeadCellProps` (object, or `({ column, table }) => props`). | `node_modules/mantine-react-table/dist/index.esm.d.mts:546,866` and grep |
| **Next 16:** `metadata` / `generateMetadata` only work in **Server Components**. `title.template` applies to **child** segments, not the defining segment. **`title.default` is required with a template.** `title.absolute` ignores templates. Error boundaries are client components: use React `<title>`. | `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/generate-metadata.md:110,120,221,243,285-293`; `error.md:165` |
| **ESLint 9.39.4.** Spreading `jsxA11y.flatConfigs.recommended` fails ("Cannot redefine plugin \"jsx-a11y\""). A config object with **only `rules`** (no `plugins`) taken from `jsxA11y.flatConfigs.recommended.rules` resolves all 34 rules. With recommended **as-is**, 9 places are flagged: `no-autofocus` ×7 (MFASetup 171/217, ForgotPassword 83, Login 191/200, reset-password 132, HourCell 137) and HourCell:87 ×2. | Lead-commissioned test run with `--print-config` and a temp config |

## 3. Invariants (must not break)
1. **No server, schema, query or business-logic change.** Confirmations are UI only; the same server action is called with the same arguments.
2. **Server write gate unchanged.** `useCanWrite` stays visibility only. Credential actions (Reset password, Unlock) stay available in read-only mode, matching the server (§1).
3. **Existing guards keep working.** You can't deactivate your own account (`UsersClient.tsx:262`); the last-active-admin server check is untouched.
4. **Every destructive action asks first:**
   - Deactivate user, charge code, indirect code, labor category, CLIN, SLIN or assignment;
   - Revoke or delete an API key;
   - change FLSA status (it changes overtime pay).

   Reactivation is not destructive and keeps whatever flow it has today, but no longer shows a red button.
5. **Status is never color alone:** every status shows a word.
6. **DCAA, tenancy, security:** untouched. No new data reaches the browser.
7. **Visual size stays the same** when a heading level changes (h2 → h1 keeps the current size via `size`).

## 4. Design

### 4.1 Theme: contrast-safe tokens (A5, V9, UX-D1)

Change `src/theme.ts`:
1. `primaryShade: { light: 7, dark: 7 }`.
2. Replace shades 7–9 (and signal-4) with these **starting values**. Every one was computed with Mantine's own `darken` / `lighten` to pass §4.1 rule R; the test in T1 is the acceptance.

   | Color | [7] | [8] | [9] | Other |
   |---|---|---|---|---|
   | signal | `#3f55e6` (unchanged) | `#3346c0` | `#283a9e` | [4] `#6f84ff` (was `#6b80ff`; dark text on cards 4.43 → 4.6) |
   | success | `#0e823a` | `#0c6f31` | `#0a5b29` | |
   | warning | `#9e6306` | `#865405` | `#6f4504` | |
   | red (new custom tuple; 0–6 = Mantine default) | `#c92a2a` | `#a82424` | `#8c1d1d` | (danger menu text needs 4.5 on the gray-1 hover: `#d13636` was 4.40) |
   | cyan (new custom tuple; 0–6 = Mantine default) | `#0d7b8c` | `#0b6977` | `#095662` | |
   | ink, gray | unchanged | | | |

3. **`cssVariablesResolver`**, exported from `src/theme.ts`. It **cannot** be passed from `layout.tsx` (Server Component). Create **`src/app/providers.tsx`** (`'use client'`) that renders `<MantineProvider defaultColorScheme="auto" theme={theme} cssVariablesResolver={cssVariablesResolver}>` plus `<Notifications position="top-right" autoClose={4000} />` and `{children}`. `layout.tsx` keeps `ColorSchemeScript` and renders `<Providers>{children}</Providers>`. Mantine already deep-merges the default resolver with yours (`get-merged-variables.mjs:5-8`), so return **only the overrides**: `{ variables: {}, light: {…}, dark: {…} }` (all three keys required by `ConvertCSSVariablesInput`). Write values as hex literals so T1 can read them.

   | Variable | Light | Dark |
   |---|---|---|
   | `--mantine-color-dimmed` | ink-6 `#46526e` (7.8:1) | dark-1 `#abafba` (6.9:1 on dark-6) |
   | `--mantine-color-error` | red-7 | red-4 `#ff8787` |
   | `--mantine-color-placeholder` | `#5f6b85` (5.35 / 5.03 / 4.81 on white / ink-0 / gray-1) | dark-1 `#abafba` (5.19 on dark-5) |
   | `--mantine-color-default-border` | `#858fa5` (3.25:1 on white, 3.06 on ink-0) | `#737a8e` (3.53 on dark-6, 4.06 on dark-7) |

4. `respectReducedMotion: true`.
5. **Badge sentence case:** `components.Badge` → `styles: { root: { textTransform: 'none', fontWeight: 600 } }` (keep `variant: 'light'`).
6. **Palette restriction:** the only colors allowed in `src/` are `signal`, `ink`, `gray`, `success`, `warning`, `red` and `cyan`.
   - Replace all 4 `grape` uses: `AuditTrailClient.tsx:189`, `:274` and `:560` → `signal`; `AppHeader.tsx:40` (Demo badge) → `ink`.
   - **No explicit shades in `c=` / `color=`.** They don't switch per scheme: the new warning[7] on dark-6 is 3.05:1. Change `UnpricedNote.tsx:21-22` and `ChargeCodeCell.tsx:37` to `c="warning"`, and `ApprovalsClient.tsx:279` to `c="signal"`.
   - T1b enforces both rules.
7. **Danger text color.**
   - **Menu items:** don't use `color="red"` on `Menu.Item`. Mantine hard-codes shade 6 for a bare theme color (`MenuItem.mjs:82`), which gives 3.28:1. Instead, a CSS-module class sets Mantine's **own variables**, which `MenuItem` only sets inline when a `color` prop is passed (`MenuItem.mjs:82-84`): `.danger { --menu-item-color: var(--mantine-color-red-text); --menu-item-hover: light-dark(var(--mantine-color-red-0), var(--mantine-color-dark-5)); }`. Setting `color` directly would tie on specificity with `.m_99ac2aa1` (`styles.css:4767`) and depend on load order. Result: red-7 `#c92a2a` on white 5.46 / red-0 5.10 / gray-1 4.91, and red-4 on dark-6 6.52 / dark-5 4.92.
   - **Single danger button** (§4.4 rule 3): `<Button variant="subtle" color="red">`. It uses `--red-light-color` (red-9 in light, red-0 in dark) with a red-2 hover, which passes. A class can't do this, because Button's hover rule has specificity (0,2,0) (`styles.css:3415-3417`).

**Rule R** (the contrast test, T1). For each palette color `c`:

| Mode | Pair | Minimum |
|---|---|---|
| Light | white text on `c[7]` (filled) | ≥ 4.5 |
| Light | `c[7]` text on `#ffffff` and on `#f7f8fb` (`c=` / outline / anchor) | ≥ 4.5 |
| Light | `c[9]` on `c[1]` (light badges) | ≥ 4.5 |
| Dark | white on `c[7]` | ≥ 4.5 |
| Dark | `c[4]` on `#181a20` (dark-7) and on `#23262f` (dark-6) | ≥ 4.5 |
| Dark | `c[0]` on `darken(c[9], .5)` | ≥ 4.5 |

Plus the resolver variables, against these background sets: **light** `#ffffff`, `#f7f8fb` (ink-0), `#f1f3f5` (gray-1, filled inputs and menu hover); **dark** `#181a20` (dark-7), `#23262f` (dark-6), `#343a48` (dark-5).
- dimmed, error and placeholder on every background in the set: ≥ 4.5;
- default-border **only** against light `#ffffff` and `#f7f8fb`, and dark `#181a20` and `#23262f`: ≥ 3.0. Inputs sit on these, and `#858fa5` on gray-1 is 2.92, which isn't an input background;
- danger text (§4.1.7): red-7 on white, red-0 and gray-1; red-4 on dark-6 and dark-5: ≥ 4.5;
- for `signal`: shade 6 against white and dark-7 (focus ring / accent): ≥ 3.0.

Implement the derivation in the test from the §2 source, with a comment citing `get-css-color-variables.mjs`, and use `darken` imported from `@mantine/core`. Call the resolver with `mergeMantineTheme(DEFAULT_THEME, theme)`: the bare theme leaves `theme.scale` undefined.

### 4.2 B4: patch `mantine-react-table` (L1)

Create **`scripts/patch-mantine-react-table.mjs`**:
- **Exports a pure function** `patchSource(text, kind)`, where `kind` is `'esm' | 'cjs'`:
  - **Unpatched:** the file's **total** count of ` in: ` is exactly 5, and it contains the 5 exact unpatched strings from §1, each exactly once (the three identical short ones count as 3 occurrences of one string), and contains **0** `expanded:`. It returns `{ text, changed: true }`, where `text` has ` in: ` → ` expanded: ` **inside those 5 strings only**.
  - **Already patched:** the 5 patched strings are present and **0** unpatched ones. It returns `{ text, changed: false }` with `text` unchanged (idempotent).
  - **Anything else:** it throws `Error('mantine-react-table patch: unexpected source (expected 5 Collapse `in:` props, found N). Re-check the MRT version and update scripts/patch-mantine-react-table.mjs.')`.
- **CLI, only when run directly.** Guard with `if (import.meta.url === pathToFileURL(process.argv[1]).href)`, so that importing `patchSource` in T3 can never touch `node_modules` or call `process.exit` inside the vitest worker.
  - First, if `node_modules/mantine-react-table` doesn't exist, print a notice and exit 0 (a `--omit=dev` install, or the script copied before deps).
  - Then read `node_modules/mantine-react-table/package.json`. If `version !== '2.0.0-beta.9'`, exit 1 with a message naming the version.
  - Patch `dist/index.esm.mjs` and `dist/index.cjs`, writing only when changed.
  - Print one line per file: `patched` or `already patched`.
- **`package.json`:**
  - `"mantine-react-table": "2.0.0-beta.9"` (exact). Use `npm install --save-exact mantine-react-table@2.0.0-beta.9`, so the lockfile's root spec matches.
  - Add `"postinstall"`, `"predev"`, `"prebuild"` and `"pretest"`, each `node scripts/patch-mantine-react-table.mjs`. `npm install <pkg>` does **not** run the root postinstall, so `pretest` and `predev` catch a re-extracted MRT. `npm run test:tz` has no pre-hook; CI is covered by `npm ci`'s postinstall, and locally T4's message says what to run.
  - `prebuild` covers the Dockerfile, which installs with `--ignore-scripts`.
  - If a `predev` / `prebuild` / `postinstall` already exists when you start, chain them with `&&` and say so in the report.
- **Comment block at the top:** why the patch exists (Mantine 9 rename; MRT supports `^7.9`), and the removal condition: "delete when MRT ships Mantine 9 support or MRT is replaced".

### 4.3 Icon registry (§4.2 of the audit, L2)

**`src/components/ui/icons.ts`** exports:
- **`Icons`**: one entry per *meaning*, mapping to a `@tabler/icons-react` component, using the registry in UX-AUDIT §4.2 / the interaction review. Minimum keys:
  - `create`, `edit`, `delete`, `deactivate`, `reactivate`, `moreActions`, `rates`, `laborCategory`, `history`;
  - `resetPassword`, `unlock`, `flsa`, `manageClins`, `revokeKey`, `endAssignment`;
  - `search`, `download`, `upload`, `view`, `copy`, `approve`, `reject`;
  - `statusError`, `statusWarning`, `statusInfo`, `statusSuccess`, `automate`, `sync`, `refresh`;
  - plus any icon used in the files UX-1 migrates.

  Required choices:

  | Key | Icon |
  |---|---|
  | `edit` | IconPencil |
  | `reactivate` | IconRestore |
  | `laborCategory` | IconBriefcase |
  | `rates` | IconCurrencyDollar |
  | `moreActions` | IconDots |
  | `endAssignment` | IconCalendarX |
  | `revokeKey` | IconKeyOff |
  | `resetPassword` | IconPassword |
  | `sync` | IconArrowsExchange |
  | `automate` | IconWand |

  Never IconTag for labor category, IconRefresh for reactivate, or IconToggleLeft.
- **`ICON_SIZE`** = `{ menu: 16, button: 16, nav: 18, stat: 20 }`.
- **`ICON_ALIASES`**: a set of key pairs that deliberately share an icon (e.g. `approve`/`statusSuccess` → IconCheck), each with a one-line reason.

**Ratchet test (T13):**
- Only `icons.ts` and the files in `ICON_IMPORT_ALLOWLIST` (an exported array in the test) may import `@tabler/icons-react`.
- The allowlist starts as **the 50 current files minus every file this phase migrates**, which is 39 files (`ConfirmModal` doesn't import tabler today). Files that §4.7 edits keep their tabler imports and **stay allowlisted**: LoginForm, SignupForm, ForgotPasswordForm, WorkspaceFinder, AppShellWrapper, PayPeriodSelector, `app/page.tsx` and the error boundaries. The reset-password split moves its allowlist entry from `reset-password/page.tsx` to `reset-password/ResetPasswordForm.tsx`, in the same commit.
- The test also fails if an allowlisted file **no longer** imports tabler, so the list can only shrink.
- Two registry keys may map to the same component only via `ICON_ALIASES`.

**UX-1 migrates (all their icons):** the 10 table files listed in §1, plus `ConfirmModal`, `RowActions` and `AppHeader` (the grape fix).

### 4.4 `RowActions` (V8, §4.1, B2)

**`src/components/ui/RowActions.tsx`** (client):
```ts
export type RowAction = {
  key: string;
  label: string;              // sentence case, verb first: "Edit", "Change labor category", "Deactivate…"
  icon: keyof typeof Icons;
  onSelect: () => void;
  tone?: 'default' | 'danger';
  writes?: boolean;           // default true: disabled when the workspace is read-only
  disabledReason?: string;    // e.g. "You can't deactivate your own account"
  hidden?: boolean;
  busy?: boolean;             // shows a loader and blocks clicks while this row's action runs (replaces today's disabled={isPending})
};
export function RowActions(props: { rowLabel: string; primary?: RowAction; items: RowAction[] }): React.ReactElement;   // not JSX.Element: TS2503 with @types/react 19.2
```

**Rendering rules** (each one is tested in T7):
1. **Primary.** `primary` (if any) renders as a visible quiet `Button` with its label: `variant="subtle"`, `size="compact-sm"`.
2. **Menu.** `items` render in a Mantine `Menu`. The trigger is an `ActionIcon` with `aria-label={`More actions for ${rowLabel}`}` and `Icons.moreActions`. Items show icon plus label.
   - **Danger items always render last,** whatever their input order. A `Menu.Divider` separates them **only if** there are non-danger items above, so there's no leading divider (e.g. API keys: Revoke, Delete).
   - They use the `.danger` class from §4.1.7 (it sets `--menu-item-color` / `--menu-item-hover`), **never** `color="red"`.
   - Pass `withInitialFocusPlaceholder={false}`, so opening by keyboard focuses the first item (Mantine defaults to a placeholder, `Menu.mjs:30`).
3. **Single action.** If there's no `primary` and exactly one visible item, render it as a single labelled quiet button with no menu: `variant="subtle"`, plus `color="red"` if danger (§4.1.7). If it's disabled by `disabledReason`, render `aria-disabled` with the reason as visible text beside it. Read-only follows rule 4b. Rows whose only action doesn't apply use `hidden` (§4.5), and render nothing.
4. **Disabled items** (read-only mode for `writes` items, or `disabledReason`):
   - Use **`aria-disabled="true"`, not `disabled`.** Mantine renders `disabled` as a native disabled button that arrow keys skip (`siblingSelector: [data-menu-item]:not([data-disabled])`), so keyboard and screen-reader users would never reach the reason, and a read-only Charge codes menu would have nothing focusable.
   - Give the item `closeMenuOnClick={false}` and an `onClick` that does nothing.
   - Style it with `opacity: .6` and `cursor: not-allowed`.
   - Render the reason **inside the item** as a second line (`<Text size="xs" c="dimmed">`): `disabledReason`, or **"Read-only workspace"** for write items in read-only mode. `Menu.Item` has no `description` prop in 9.3.1, so use children. The reason is then part of the item's accessible name.
   - Items with `writes: false` stay enabled in read-only mode.
4b. **Read-only primary and single buttons:** `aria-disabled="true"`, a click that does nothing, disabled styling, wrapped in `<Tooltip label={READ_ONLY_TOOLTIP}>` (`WorkspaceMode.tsx:15`). `aria-disabled` buttons still get hover and focus, so the tooltip works. Also set `aria-describedby`, pointing at a visually hidden span with the same text, so keyboard users hear it. Don't add visible text beside every row.
5. **Layout.** The wrapper is `Group gap={4} wrap="nowrap" justify="flex-end"`, so it never wraps and aligns right; `textAlign` doesn't move a flex group.
6. **Keyboard and focus:** rely on Mantine Menu (arrow keys, Esc, focus returns to the trigger). Lead-verified in 9.3.1: the trigger gets `aria-haspopup="menu"`, `aria-expanded` and `aria-controls` (`PopoverTarget.mjs:23-25`); items get `role="menuitem"`; the dropdown gets `role="menu"`; `returnFocus: true`.

**`useAppTable` defaults.** **Rename `src/components/table/mrtDefaults.ts` → `mrtDefaults.tsx`**, because the `Header` below is JSX. Imports are extensionless, so callers don't change.
- **Actions column:**
  - `displayColumnDefOptions['mrt-row-actions'] = { size: 132, header: 'Actions', Header: () => <VisuallyHidden>Actions</VisuallyHidden>, mantineTableHeadCellProps: { style: { textAlign: 'right' } }, mantineTableBodyCellProps: { style: { textAlign: 'right' } } }`.
  - Delete the 10 pasted center-align blocks.
  - The header must have an accessible name, not `''`.
- **Toolbar** (mockup "Charge codes table"):
  - `enableToolbarInternalActions: false` (no search, filter, column or density toggle icons);
  - `positionGlobalFilter: 'left'`;
  - `initialState: { showGlobalFilter: true }`;
  - `mantineSearchTextInputProps: { placeholder: 'Search', 'aria-label': 'Search this table', variant: 'default' }`. MRT hard-codes `variant: "filled"` (`index.esm.mjs:2532`), which has no visible border and a gray-1 fill.
  - `enableColumnFilters: false`.

  Tables that need column filters opt back in with `enableColumnFilters: true` and `initialState.showColumnFilters: true`. Assignments ×2 must (it already sets `enableColumnFilters: true`; add `showColumnFilters`).

  **AuditTrail keeps the column-visibility button.** It hides Comment and Entered By by default, and users re-enable them with that button (`AuditTrailClient.tsx:286-291`). Set `enableToolbarInternalActions: true` and `renderToolbarInternalActions: ({ table }) => <MRT_ShowHideColumnsButton table={table} />` (exported by MRT beta.9). Before turning internal actions off, check every other table for hidden-by-default columns.
- **Sort state:** `mantineTableHeadCellProps: ({ column }) => ({ 'aria-sort': column.getCanSort() ? (column.getIsSorted() === 'asc' ? 'ascending' : column.getIsSorted() === 'desc' ? 'descending' : 'none') : undefined })`. Trap T-A applies.

### 4.5 Table migration (the exact row-action spec)

| Table | Primary | Menu items (top → bottom) | Confirmation |
|---|---|---|---|
| Charge codes | Edit | Change labor category · **Deactivate…** (danger) or Reactivate… | Existing ConfirmModal flows. Reactivate fetches info first, then confirms; it uses `tone="neutral"`. |
| Contracts | Edit | Manage CLINs and SLINs (**`writes: false`**: read-only admins can open the drawer today, `ContractsClient.tsx:327-331`) | n/a |
| CLIN / SLIN drawer | — | Keep the current text buttons for this phase (layout is UX-4). **Add a ConfirmModal to Deactivate** (B2), confirm label "Deactivate"; Activate gets no confirm. | **CLIN:** "Deactivate CLIN {number}?" / "Employees can't charge new time to it. Existing hours stay on record." **SLIN:** "Deactivate SLIN {number}?" / "Marks it inactive. Existing hours stay on record." Nothing on the server reads `slins.status` today (lead-verified), so the SLIN copy must not promise a block (UX-AUDIT B5). The Drawer gets `closeOnEscape={!clinConfirm && !slinConfirm}`, so Esc closes only the confirm: each ModalBase listens on `window` (`use-modal.mjs:14-16`). |
| Charge-code assignments, supervisor assignments | — | single item "Deactivate…" (danger), **`hidden` when the row is inactive** (today the button is disabled, `AssignmentsClient.tsx:266,377`). Keep the verb "Deactivate": unassigning is a soft deactivation and the row stays listed as Inactive (`charge-codes.ts:228`, `assignments.ts:92`). Make the existing confirm's title, button and error title all say "Deactivate". | existing |
| Labor categories | Edit | Rates · **Deactivate…** or Reactivate | existing deactivate confirm; Reactivate none |
| Labor-category assignments | — | single → "End assignment…" opens the existing date modal (it's a form, keep it); **`hidden` when the assignment already has an end date** (`LaborCategoriesClient.tsx:516`) | existing |
| Indirect codes | Edit | **Deactivate…** or Reactivate. **Remove the Active Switch column**; add a Status column using `RECORD_STATUS_COLOR` from `src/lib/ui/status-colors.ts` with the words "Active" / "Inactive". | New ConfirmModal for Deactivate: "Deactivate {code}?" / "Employees can't charge new time to it. Existing hours stay on record." |
| Users | Edit | Reset password… (`writes: false`) · Unlock account (`writes: false`) · Mark as FLSA exempt… / Mark as non-exempt… · **Deactivate…** or Reactivate. **Remove both Switch columns**; add Status ("Active"/"Inactive") and FLSA ("Exempt"/"Non-exempt") text columns. On your own row, Deactivate is disabled with reason "You can't deactivate your own account". | **Deactivate:** "Deactivate {name}?" / "They're signed out and can't sign in. Timesheets waiting for their approval go to admins. Their timesheets and history stay on record." (`updateUser` bumps `sessionVersion` and re-routes approvals, `users.ts:130,173,186-191`.) **FLSA** (tone neutral): "Mark {name} as FLSA exempt?" or "…non-exempt?" / "Payroll export uses this to calculate overtime for every period, including past ones." (`payroll-data.ts:139` reads the current flag.) **Reactivate:** none. |
| API keys | — | Revoke… (danger, **`hidden` unless the key is active**, `ApiKeysClient.tsx:166`) · Delete… (danger) | existing |
| Approvals, Audit trail | unchanged (single text button / inline history). Audit trail keeps its column button (§4.4). | | |
| Dashboard | no row actions; its detail panel now opens (B4) | | |

Handlers keep calling the same server actions with the same arguments. A confirm closes **only** on success. On failure it stays open, the loading state clears, and `runAction`'s existing error notification shows. The confirm button is disabled while loading, so it can't be double-submitted.

### 4.6 `ConfirmModal` tone
Add `tone?: 'danger' | 'neutral'` (default `'danger'`, so existing callers don't change). Danger is `color="red"`: the filled button uses red-7, which passes per §4.1. Neutral is the primary color.

### 4.7 Page structure (A6, A9)
1. **Root title.** In `src/app/layout.tsx`: `metadata.title = { default: 'CadenzPoint', template: '%s – CadenzPoint' }` (keep `description`).
2. **Per-page titles.** Each server `page.tsx` (30 files; `signup/check` and `signup/verify` are route handlers, not pages) exports `export const metadata: Metadata = { title: '…' }`:

   | Route | Title | Route | Title |
   |---|---|---|---|
   | /timesheet | Timesheet | /admin/indirect-codes | Indirect charge codes |
   | /profile | Profile and security | /admin/import | Data import |
   | /admin/approvals | Approvals | /admin/migration | Data migration |
   | /admin/audit-trail | Audit trail | /admin/api-keys | API keys |
   | /admin/reports | Reports | /admin/integrations | Integrations |
   | /admin/setup | Setup | …/quickbooks | QuickBooks |
   | /admin/dashboard | Contract dashboard | …/gusto | Gusto |
   | /admin/contracts | Contracts and CLINs | …/payroll-export | Payroll export |
   | /admin/charge-codes | Charge codes | /admin/settings | Settings |
   | /admin/assignments | Assignments | /admin/billing | Billing |
   | /admin/labor-categories | Labor categories | /admin/notifications | Notifications |
   | /admin/users | Users | /login | Sign in |
   | /signup | Create your workspace | /forgot-password | Reset your password |
   | /reset-password | Set a new password | /privacy | Privacy policy |
   | /terms | Terms of service | / (landing) | `{ absolute: 'CadenzPoint – DCAA-compliant timekeeping' }` |

   - **`/reset-password`:** move the client code to `src/app/reset-password/ResetPasswordForm.tsx`. `page.tsx` becomes a server component that exports metadata and renders the form; keep the `useSearchParams` call inside its `Suspense` boundary and preserve every prop and hook. Update `reset-password-page.test.tsx` imports.
   - **Error boundaries:** render `<title>Something went wrong – CadenzPoint</title>` (React 19 hoists it; `global-error.tsx` renders its own `<html>`, which is fine).
3. **One h1 per page:**
   - **`PageHeader`:** add `order?: 1 | 2` (default 1) and render `Title order={order} size="h2"`, so it looks the same.
   - **Pages and full-page screens with their own top heading:** make it `order={1}` with its current visual size. That covers timesheet `PayPeriodSelector.tsx:77`, setup, payroll export, QuickBooks, Gusto, forgot password, every signup state, reset-password, WorkspaceFinder, **TenantUnavailable, OnHoldScreen, PolicyHoldScreen, `app/error.tsx`, `(app)/error.tsx`, `admin/error.tsx`, `timesheet/error.tsx`**.
   - **BillingWall** (`BillingWall.tsx:26,37`) keeps its "Workspace suspended" heading as the h1 and renders `BillingClient`'s header with `order={2}`.
   - **Login:** add `<VisuallyHidden component="h1">Sign in</VisuallyHidden>` **inside `LoginForm`**, not `login/page.tsx`. The auth gate can render WorkspaceFinder instead of the form, which has its own h1.
   - **Landing:** add `<VisuallyHidden component="h1">CadenzPoint: DCAA-compliant timekeeping for government contractors</VisuallyHidden>` before the hero. Make the "Demo credentials" heading (`page.tsx:56`) an h2, so the order is h1 → h2 → h2.
   - **Any lower headings** on those pages that now skip a level: fix them in the same file.
4. **Skip link.**
   - First element inside `AppShell`: `<a href="#main-content" className={classes.skip}>Skip to main content</a>`.
   - CSS: visually hidden until `:focus-visible`. Then a visible pill at the top left, signal-7 background, white text, **`z-index: 300`** (AppShell's header is 100).
   - `AppShell.Main` gets `id="main-content"` and `tabIndex={-1}`, plus `#main-content:focus { outline: none; }` **in `globals.css`**, so the programmatic focus target draws no ring. CSS modules hash ids, so it can't live in the module.
5. **Auth and public `<main>`.** Each of these renders exactly one `<main>`: Login, forgot password, WorkspaceFinder, TenantUnavailable, reset-password, signup, landing, privacy, terms, OnHoldScreen, PolicyHoldScreen and BillingWall.
   - Use `component="main"` on the outer Center/Container/Stack.
   - Lead-verified: none of these renders inside `AppShell.Main`. TenantUnavailable is only used by the (app) layout and the auth gate.
   - Check the `workspaceAuthGate` branches so none produces two.
6. **Anchor buttons.** `LoginForm.tsx:205-210` and `SignupForm.tsx:97,237`: `<Anchor component="button" type="button" …>`. `type="button"` is required, because the Login one sits inside a `<form>`.

### 4.8 Accessibility lint and axe
1. **ESLint.** Add `eslint-plugin-jsx-a11y` to devDependencies at the installed version (`--save-exact`, currently 6.10.2): the config imports it directly, so it can't stay transitive. Then add to `eslint.config.mjs`, after `nextVitals` / `nextTs`, a config object for `src/**/*.tsx`:
   - **`rules`:** from `jsxA11y.flatConfigs.recommended.rules`, **map severity only**:
     - `'off'` stays off (`control-has-associated-label`, `anchor-ambiguous-text` and `label-has-for` are off in recommended);
     - `'error'` → `'warn'`;
     - array entries whose first element is `'off'` stay as they are (e.g. `control-has-associated-label` is `['off', {…}]`); other array entries → `['warn', ...entry.slice(1)]`, which keeps their options.

     Keep Next's `alt-text` options. **No `plugins` key** (trap T-F).
   - **`settings: { 'jsx-a11y': { polymorphicPropName: 'component', components: { ActionIcon: 'button', UnstyledButton: 'button', CloseButton: 'button', Anchor: 'a' } } }`.** `polymorphicPropName` makes `<Anchor component="button">` count as a button (supported in 6.10.2, `getElementType.js:14`).
   - **`no-restricted-syntax` at `warn`** with these two selectors (lead-commissioned test confirmed they parse and behave in ESLint 9.39.4):
     - `JSXOpeningElement[name.name='ActionIcon']:not(:has(> JSXAttribute[name.name='aria-label'])):not(:has(> JSXSpreadAttribute))`, message "ActionIcon needs an aria-label";
     - `JSXOpeningElement[name.name='Anchor']:has(> JSXAttribute[name.name='onClick']):not(:has(> JSXAttribute[name.name=/^(href|component)$/]))`, message "Anchor with onClick needs href or component=\"button\"".

   `npm run lint` must still end with **0 errors**. The lead-commissioned run of this exact config gave 0 errors and 81 warnings (+23 over the 58 baseline); report your count.
2. **axe.** Add `axe-core` as a devDependency pinned to **4.12.1** (already hoisted and in the lockfile; `npm install --save-dev --save-exact axe-core@4.12.1`).
   - Create `src/__tests__/helpers/axe.ts` exporting `expectNoAxeViolations(root: Element)`:
     - runs `axe.run(root, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })`, because jsdom has no layout;
     - throws listing each violation's id, help text and node targets.
   - Calls must be awaited, one at a time (trap T-K).
   - **Pass `document.body` whenever a Menu or Modal is open**, because they render in a portal.

## 5. State table: row action → confirmation

| State | Event | Next state | Side effects |
|---|---|---|---|
| Idle | Click primary | Running (no-confirm action) or Confirm open | — |
| Idle | Open menu (click / Enter / Space on trigger) | Menu open | Focus moves to the first item (`withInitialFocusPlaceholder={false}`). Disabled items are `aria-disabled`, so they're focusable and announce their reason. |
| Menu open | Esc / click outside | Idle | Focus returns to trigger |
| Menu open | Select enabled item | Confirm open (destructive or FLSA) / Modal open (form actions: Edit, Rates, Change labor category, End assignment, Reset password) / Running (Unlock, Reactivate where no confirm today) | — |
| Menu open | Select an `aria-disabled` item | Menu open | Nothing; the menu stays open, and the reason is part of the item's name |
| Confirm open | Cancel / Esc / close | Idle | **No server call** |
| Confirm open | Confirm | Confirm loading | Server action called once; confirm button disabled |
| Confirm loading | Result ok | Idle | Modal closes; data refreshes as today; success notification as today |
| Confirm loading | Result not ok | Confirm open | Loading cleared; `runAction` error notification; row unchanged |
| Any | Workspace becomes read-only (next render) | same | Write items disabled with visible reason. A confirm already open still submits, and the server refuses with `read_only` (existing behaviour). |

## 6. Failure modes

| Case | Behaviour |
|---|---|
| MRT version drifts (lockfile change, `npm install` of a new beta) | Exact pin prevents it. If it still happens, the script exits 1 at `postinstall` / `prebuild` and CI and deploys fail loudly with the message; nothing ships with a half-patched table. |
| MRT dist text changes | `patchSource` throws (count ≠ 5). Same loud failure. |
| Script runs twice (postinstall, then prebuild) | Idempotent: "already patched", exit 0. |
| Docker `npm ci --ignore-scripts` | `prebuild` patches before `next build`. |
| Local dev with existing `node_modules` | `predev` patches on next `npm run dev`. Turbopack may cache the old module, so stop the server and delete `.next` once if search still doesn't appear (in the verification steps). |
| `node_modules/mantine-react-table` missing | Notice, exit 0. The build then fails on the import as it would today. |
| Server action fails inside a confirm | Modal stays open, error notification, row unchanged (§5). |
| Double click on Confirm | Button disabled while loading; one call. |
| Two different rows' menus | Independent; Mantine closes the first when the second opens. |
| axe-core concurrent runs | The helper is awaited per test; tests in one file don't call it in parallel. |
| Unknown palette color or explicit shade in a future change | T1b fails. |
| `npm install <pkg>` re-extracts MRT without running the root postinstall | `predev` and `pretest` re-patch. T4's failure message says "run `node scripts/patch-mantine-react-table.mjs`". |
| Function prop passed from the Server Component layout | Build fails at prerender. Avoided by `providers.tsx` (§4.1.3); T2 asserts layout doesn't pass `cssVariablesResolver`. |
| Escape in a confirm opened over the CLIN drawer | Only the confirm closes (`closeOnEscape` guard, §4.5); T11. |

## 7. Platform limits
- **No server, response-size or DB impact.**
- **Bundle:** Mantine `Menu` renders its dropdown in a portal only while open, so there's no per-row DOM cost when closed. Icons are named imports, which tree-shake.
- **Lint:** about +23 warnings (lead-commissioned run: 81 total, 0 errors). CI tolerates warnings; UX-5 makes them errors.

## 8. Blast radius

| Area | Files | Change |
|---|---|---|
| Theme | `src/theme.ts`, `src/app/layout.tsx`, `src/app/providers.tsx` (new, client) | tuples, shade, resolver, Badge, reduced motion, title template; provider moves into `providers.tsx` |
| Palette | `AuditTrailClient.tsx:189,274,560`, `AppHeader.tsx:40`, `UnpricedNote.tsx:21-22`, `ChargeCodeCell.tsx:37`, `ApprovalsClient.tsx:279` | grape → signal / ink; explicit shades → scheme-aware colors |
| MRT patch | `scripts/patch-mantine-react-table.mjs` (new), `package.json`, `package-lock.json` (pin + axe-core) | |
| Shared UI | `src/components/ui/{icons.ts, RowActions.tsx, RowActions.module.css}` (new), `ConfirmModal.tsx`, `PageHeader.tsx` (`order` prop), `src/components/table/mrtDefaults.ts` → **`.tsx`** | |
| Tables | the 10 client files in §1 | row actions, column blocks removed, icon imports via registry, Users/Indirect switches → status text + menu |
| Page structure | every `page.tsx` (metadata), `reset-password/{page.tsx, ResetPasswordForm.tsx}`, the 5 error boundaries, AppShellWrapper (+ CSS module), the auth/public pages and headings in §4.7, TenantUnavailable, OnHoldScreen, PolicyHoldScreen, BillingWall, **`BillingClient.tsx`** (accept a header `order` prop passed to PageHeader; its h4 headings become h3 when the header is h2, and h2 when it's h1) | |
| Lint and tests | `eslint.config.mjs`, `package.json` (`eslint-plugin-jsx-a11y`, `axe-core` exact devDeps), `src/__tests__/helpers/axe.ts` (new), new tests §9, updates to `reset-password-page.test.tsx`, `login-form.test.tsx`, **`rate-schedule-ui.test.tsx`** (it clicks `button[aria-label="Rates"]` five times, at `:111,183,203,223,262`; Rates moves into the menu, so the test must open the menu and query `document.body`) | |
| Existing tests | jsdom tests asserting on red confirm buttons, Switch roles in Users/Indirect, `Title order` / heading levels, or `in` on Collapse | update to the new behaviour and say which |
| Docs | `MIGRATIONS.md` / README if they list npm scripts; `UX-AUDIT.md` gets nothing (lead updates it) | |
| Not touched | `src/server/**`, `src/db/**`, `scripts/` (except the new patch script), crons, seeders, API routes | |

## 9. Required test matrix (each fails without its change; record a break-it for each)

| ID | Test (file) | Scenario | Break-it |
|---|---|---|---|
| T1 | `unit/theme-contrast.test.ts` | Rule R (§4.1) for every palette color, both schemes; the resolver variables against the named background sets; the danger-text pairs (§4.1.7). The resolver is called with `mergeMantineTheme(DEFAULT_THEME, theme)` | revert primaryShade to 6, or red[7] → `#d13636` (fails danger on gray-1) |
| T1b | same file | Static scan of every `color=` / `c=` string literal in `src/**/*.tsx`, plus every value in `src/lib/ui/status-colors.ts`. The base name must be in the palette, or be `dimmed`, `white`, `black` or `bright`. Values starting `var(` are allowed. A `.N` shade suffix is rejected | add `color="grape"`, or restore `c="warning.7"` |
| T2 | same file | `theme.components.Badge` sets `textTransform: 'none'`; `respectReducedMotion` true; `primaryShade` 7/7; static: `src/app/layout.tsx`, **with comments stripped**, doesn't contain `cssVariablesResolver` or `MantineProvider` (also reword the comment at `layout.tsx:38-40`, which mentions MantineProvider), and `providers.tsx` starts with `'use client'` | remove the Badge styles; move `MantineProvider` back into layout |
| T3 | `unit/mrt-collapse-patch.test.ts` | `patchSource`: unpatched fixture → 5 replacements, 0 ` in: ` left; patched fixture → unchanged; 4-match fixture → throws; text with extra `in:` → throws (esm and cjs fixtures) | make it replace all ` in: ` occurrences without counting |
| T4 | same file | Installed `node_modules/mantine-react-table/dist/index.{esm.mjs,cjs}` contain 0 unpatched and 5 patched strings; package version is 2.0.0-beta.9. The failure message says "run `node scripts/patch-mantine-react-table.mjs`" | revert one replacement in `node_modules` by hand |
| T5 | `unit/app-table.test.tsx` (jsdom) | **Panel text being in the DOM is not enough:** unpatched, the panel is present but hidden. Define `isRendered(el)`: no ancestor has `style.display === 'none'`, `aria-hidden="true"` or `inert`. Use **module-level** `columns` / `data` constants (inline ones hang `act`). Expand row 1, then `await act(async () => new Promise(r => setTimeout(r, 50)))`, because Collapse opens over animation frames. Assert `isRendered(panel)`, the global search input `isRendered` on first render, typing filters rows, and no `console.error` call whose **formatted** message (`util.format(...args)`; React passes `%s` arguments separately, `react-dom-client.development.js:3071`) matches `/non-boolean attribute .in./`. Attach the spy **before the file's first render**, since React warns once per attribute. To type into the search box, set the value with the native `HTMLInputElement` value setter, dispatch an `input` event, then wait ≥ 300 ms: MRT debounces 250 ms (`index.esm.mjs:2513`) | restore one `in:` in the dist |
| T6 | same file | `aria-sort` = `ascending` on a sorted column, `none` on sortable unsorted; actions header has accessible name "Actions"; no toolbar toggle ActionIcons render by default; the search input has a visible border variant (`default`); a table configured like AuditTrail renders the show/hide-columns button | remove the `mantineTableHeadCellProps` default; or drop AuditTrail's `renderToolbarInternalActions` |
| T7 | `unit/row-actions.test.tsx` (jsdom) | The 6 rendering rules (§4.4):
- primary visible with text;
- trigger `aria-label` "More actions for X";
- opening by keyboard focuses the first item;
- danger item last after the divider even if passed first, with the `.danger` class and **no** `--menu-item-color: var(--mantine-color-red-6)`;
- read-only: write items have `aria-disabled="true"` (not `disabled`), are reachable with ArrowDown, contain the reason text, and do nothing on click; `writes:false` items are enabled;
- single item → labelled button, no menu; `hidden` single item renders nothing; single danger button uses `variant="subtle" color="red"`;
- read-only primary and single buttons: `aria-disabled`, click does nothing, `aria-describedby` text equals `READ_ONLY_TOOLTIP`;
- no leading divider when every item is danger;
- `busy` blocks clicks and shows a loader;
- axe clean on `document.body`, with the menu open and closed. | put danger items in input order; or use `disabled` instead of `aria-disabled` |
| T8 | `unit/confirm-modal.test.tsx` (jsdom) | default tone → red confirm button; `tone="neutral"` → primary; confirm disabled while `loading`; axe clean on `document.body` | ignore `tone` |
| T9 | `unit/users-row-actions.test.tsx` (jsdom, server actions mocked) | no Switch in rows; Deactivate → confirm opens → Cancel → `updateUser` **not** called; Confirm → called once with `{ isActive: false }`; FLSA same with `{ flsaExempt: true }`; own row Deactivate disabled with reason; Reset password and Unlock enabled in read-only mode | call `updateUser` on select instead of on confirm |
| T10 | `unit/indirect-codes-row-actions.test.tsx` | Deactivate requires confirm; Cancel → no call | remove the confirm |
| T11 | `unit/contracts-clin-deactivate.test.tsx` | CLIN and SLIN Deactivate require confirm; Cancel → no call; SLIN body text has no "can't charge" claim; Esc with the confirm open closes the confirm and **leaves the drawer open** | remove the confirm; or drop the `closeOnEscape` guard |
| T12 | `unit/charge-codes-row-actions.test.tsx` | Edit visible; menu has "Change labor category"; Deactivate last; Reactivate confirm is not red | revert to the icon group |
| T13 | `unit/icon-registry.test.ts` | ratchet (§4.3: 39-file allowlist, including `reset-password/ResetPasswordForm.tsx` after the split) and alias rule | import a tabler icon in a migrated file; or add a duplicate mapping without an alias |
| T14 | `unit/page-metadata.test.ts` | static: root metadata has `title.default` + `title.template`; every `src/app/**/page.tsx` except landing exports `metadata` with a `title` string; no `'use client'` file exports `metadata`; landing uses `title.absolute` | delete one page's metadata |
| T15 | `unit/page-structure.test.tsx` (jsdom) | `PageHeader` renders an `h1`; `AppShellWrapper` source: first child of AppShell is the skip link to `#main-content`, and `AppShell.Main` has `id="main-content"` + `tabIndex={-1}` (static) | revert to `order={2}` |
| T16 | extend `login-form.test.tsx`, `reset-password-page.test.tsx`; add `unit/auth-landmarks.test.tsx` | Login, forgot, reset, signup, WorkspaceFinder, TenantUnavailable, OnHoldScreen, PolicyHoldScreen and BillingWall each render exactly one `main` and one `h1`; BillingWall's h1 comes before its h2. reset-password is asserted **after** its "verifying" state resolves (that state has no heading); the recovery-code switch renders as `<button type="button">` | revert `component="button"`; or render BillingClient's header as h1 |
| T17 | `unit/eslint-a11y-config.test.ts` | `new ESLint().calculateConfigForFile('src/app/page.tsx')` has `jsx-a11y/no-autofocus` and `jsx-a11y/label-has-associated-control` at warn (1), plus the `no-restricted-syntax` rule | drop the rules object |

Post-change, the dev re-runs every pre-existing jsdom test. Any test changed to match new behaviour is listed in the report with its reason.

## 10. Verification
```bash
npx tsc --noEmit && npm run lint && npm run test && npm run test:tz && node --import tsx scripts/check-migration-safety.ts
node scripts/patch-mantine-react-table.mjs   # prints "already patched" twice
```
**Product owner** (run each separately):
```bash
npm install
```
```bash
REQUIRE_CONTROL_PLANE_TESTS=1 CONTROL_PLANE_DATABASE_URL="$(grep -h '^CONTROL_PLANE_DATABASE_URL=' .env.local .env 2>/dev/null | head -1 | cut -d= -f2-)" ENCRYPTION_KEY="$(grep -h '^ENCRYPTION_KEY=' .env.local .env 2>/dev/null | head -1 | cut -d= -f2-)" TZ=America/New_York npm run test:integration
```
```bash
npm run build && node scripts/check-build-trace.mjs
```
Then stop any running dev server, `rm -rf .next`, and `npm run dev`.

**Manual browser checks** (`acme.localhost:3000`, light and dark):
1. **No Next.js "Issue" badge** on Dashboard, Charge codes or Users (the `in` warning is gone).
2. **Every table shows a search box** at top left. Typing filters rows. There are no search/filter/column icons.
3. **Dashboard:** the ▾ on a contract opens its CLIN breakdown.
4. **Charge codes:** each row shows "Edit" and "⋯", and nothing wraps. "⋯" lists Change labor category, then a divider, then Deactivate in red.
5. **Users:** no switches. "⋯" → Deactivate asks first, and Cancel changes nothing. Mark as FLSA exempt asks first. On your own row, Deactivate is disabled with the reason shown.
6. **Indirect codes and CLIN/SLIN drawer:** Deactivate asks first.
7. **Keyboard:** Tab from the address bar. The first stop is "Skip to main content", and Enter jumps past the menu. Tab to a "⋯", Enter opens it, arrows move, Esc closes and focus returns.
8. **Browser tab titles** read "Charge codes – CadenzPoint", etc.
9. **Colors:** primary buttons are the slightly darker blue; badges are no longer uppercase; secondary text is darker grey; input borders are visible.

## 11. Known traps
- **T-A** `useAppTable`'s deep merge **replaces functions**. If a table ever passes a table-level `mantineTableHeadCellProps`, the `aria-sort` default is lost; compose them instead. None do today.
- **T-B** A disabled `Menu.Item` fires no hover, so tooltips on it never show. Put the reason in visible text.
- **T-C** `metadata` exported from a `'use client'` file breaks the build. Split the reset-password page first.
- **T-D** `title.template` without `title.default` is invalid. A template doesn't apply to `page.tsx` in the same segment as the layout, hence landing's `absolute`.
- **T-E** `primaryShade` changes **every** color's filled and text variants (§2). Check each `variant="filled"` with `color="warning"` / `"red"` / `"success"` in the touched files.
- **T-F** Spreading `jsxA11y.flatConfigs.recommended` throws "Cannot redefine plugin". Use a rules-only object.
- **T-G** Postinstall doesn't run in the Dockerfile; `prebuild` covers it. Restart dev and clear `.next` once after the first patch.
- **T-H** Mantine `Menu` and `Modal` render in a portal, so render tests query `document.body`, not the container.
- **T-I** There's no `@testing-library/dom`. Use the existing `createRoot` + `act` pattern and plain DOM queries.
- **T-J** jsdom has no layout. axe must disable `color-contrast` and `region`. Contrast is proven by T1.
- **T-K** `axe.run` throws "Axe is already running" if two runs overlap. Await each run.
- **T-L** Don't change any server action's signature or call arguments; confirmations wrap the existing handler.
- **T-M** Never pass a function prop (resolver, render prop) from a Server Component to a Mantine component; do it in `providers.tsx`.
- **T-N** `Menu.Item color="red"` uses shade 6 regardless of `primaryShade` (`MenuItem.mjs:82`). Use the `.danger` class, which sets `--menu-item-color` / `--menu-item-hover` and not `color`. A class can't recolor a Button on hover (specificity 0,2,0), so single danger buttons use `variant="subtle" color="red"`.
- **T-O** `Menu.Item disabled` is skipped by the keyboard. Use `aria-disabled` (§4.4 rule 4).
- **T-P** One Esc closes every open ModalBase (window listeners). Guard parent Drawers with `closeOnEscape`.
- **T-Q** Explicit shades (`c="warning.7"`) don't switch per scheme; use the bare color name.
- **T-R** `mrtDefaults` must be `.tsx` once it contains JSX.

## 12. Dev-agent hand-off rules
Follow `BLUEPRINT-STANDARD.md` §3. Specifically:
1. **Before coding,** write the impact analysis: files, callers, and the Mantine Menu a11y attributes confirmed from source. **Stop and ask** if anything in §4.5 doesn't match the code (e.g. a confirm that doesn't exist where the table says "existing").
2. **One commit per section,** in this order:
   1. 4.2 (patch) + T3/T4/T5;
   2. 4.1 (theme) + T1/T2;
   3. 4.3/4.4/4.6 (shared parts) + T6–T8/T13;
   4. 4.5 (tables) + T9–T12;
   5. 4.7 + T14–T16;
   6. 4.8 + T17.
3. **Don't push.** Report the break-its, with each one's failing test name, every pre-existing test you changed and why, the new lint warning count, and anything you couldn't run.

## 13. Pre-mortem record

**Round 1 (2026-10-27).** Two independent reviewers (theme/patch/lint/tests; tables/page structure) raised 37 findings: 9 HIGH, 17 MEDIUM, the rest LOW. The lead verified every HIGH in the source, and all are fixed above:
- function prop across the server/client boundary → `providers.tsx`;
- red menu items hard-coded to shade 6 → `.danger` class and red[7] `#c92a2a`;
- T5 passing without the patch → visibility helper;
- dark-mode regression from explicit shades;
- AuditTrail losing its hidden columns;
- Contracts drawer becoming write-gated;
- false SLIN copy (→ UX-AUDIT B5);
- JSX in `mrtDefaults.ts`.

MEDIUM fixes:
- disabled items reachable by keyboard (`aria-disabled`);
- menu initial focus;
- Drawer Esc;
- the ratchet and the reset-password split;
- `rate-schedule-ui` test;
- accurate Users and FLSA copy;
- single-button hidden rules and the "Deactivate" verb;
- extra full-page screens and BillingWall heading order;
- `status-colors.ts`;
- search input variant and placeholder contrast;
- lint severity mapping, `polymorphicPropName` and corrected selectors;
- T1b `var()` and shade handling;
- axe on `document.body`;
- `pretest` hook and CLI guard.

**Round 2 (2026-10-27).** One fresh reviewer read v2 in full. Result: **0 HIGH**, 4 MEDIUM, 12 LOW. All fixed in v3.
- **MEDIUM:**
  - danger color via Mantine's own menu variables, and `subtle`/`red` for single buttons (a class loses on Button hover);
  - read-only rendering for primary and single buttons, plus the reason text;
  - T5 console spy on the formatted message, plus the search-typing mechanics;
  - explicit default-border pairs.
- **LOW:**
  - no leading divider;
  - `justify="flex-end"`;
  - T2 comment stripping;
  - skip-link focus rule in `globals.css`;
  - lint counts (+23);
  - `'off'`-array mapping;
  - total-count rule in `patchSource`;
  - CLI check order;
  - BillingClient in the blast radius;
  - `busy` field;
  - `test:tz` note;
  - factual nits.

Per the two-round limit, the blueprint is handed off; anything left is caught in the post-implementation audit.
