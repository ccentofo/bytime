# CadenzPoint — UX, interaction and accessibility audit

**Date:** 2026-10-27 · **Branch:** `main` at `ff0a185` · **Author:** lead architect
**Method:** three read-only code reviews: information architecture, interaction/icons/copy, and WCAG 2.1 AA static audit. Plus 12 product-owner screenshots (admin, supervisor Sarah Wilson, employee Jane Smith; dark mode, ~1900×1160 window). The lead re-verified every HIGH finding in the source.
**Goal (product owner):** "looks gorgeous compared to the others and is so easy and intuitive to use", Section 508 conformant.
**Approved direction:** a short main menu for daily work, plus a separate Settings area for configure-once pages.

**Verdict:** the features are strong, but the wrapper works against them.
- **Navigation:** it mirrors the build history, not the user's day.
- **Patterns:** every table, form and confirmation was built its own way.
- **Timesheet:** the most-used screen is the least accessible, so 508 is a real rebuild of the timesheet grid, not polish.
- **Correctness:** the audit surfaced two product bugs and one unsafe pattern (§1).

---

## 0. What to keep
- **Shared building blocks** from the earlier consistency pass: `useAppTable` on all 10 tables, `PageHeader`, `ConfirmModal`, `lib/format.ts`, `lib/ui/status-colors.ts`, and a coherent palette (signal blue + ink navy).
- **Accessibility basics already in place:** `lang="en"`, header/nav/main landmarks inside the app, Mantine modals that trap and return focus, no `outline:none` anywhere, `aria-label` on almost every icon button, `role="alert"` on notifications.
- **Dark mode** that already looks good in screenshots.
- **Per-entry cost transparency:** "unpriced" hours and rates by date. Keep the information; present it more quietly (§3).

## 1. Product bugs found during the audit (fix inside the UX phases, not later)

| # | Finding | Evidence |
|---|---|---|
| B1 | **Setup Wizard can say "Setup Complete!" while employees have nothing to charge time to.** It counts CLIN assignments (`user_assignments`), but timesheet rows come only from charge-code assignments (`user_charge_codes`). It has no Charge Codes step, and its copy says "CLINs are the charge codes". Data Import's Assignments tab also creates CLIN assignments only. A first customer following the wizard gets blank timesheets. | `server/internal/setup.ts:37`; `server/actions/timesheet.ts:490`; `setup/SetupWizardClient.tsx:62,84,119`; `server/actions/import.ts:288-330` |
| B2 | **Destructive changes fire without confirmation:** user Active and FLSA Exempt switches in table cells, the indirect-code Active switch, CLIN/SLIN Deactivate. FLSA status changes overtime treatment, so a misclick changes pay. | `users/UsersClient.tsx:263,277`; `indirect-codes/IndirectCodesClient.tsx:209`; `contracts/ContractsClient.tsx:505,590` |
| B4 | **Every table's search box, column filters, row detail panels (Dashboard contract chevrons), alert banner and progress bar never open.** Mantine 9 renamed `Collapse`'s `in` prop to `expanded`. `mantine-react-table@2.0.0-beta.9` still passes `in`, so `expanded` is `undefined` (always collapsed), and React logs "Received `false` for a non-boolean attribute `in`". This is the dev "1 Issue" (V12). **Product owner confirmed 2026-10-27:** the search toggle flips but no search box appears; the Dashboard chevron toggles but shows nothing. The hidden panel is the per-contract CLIN budget breakdown (`dashboard/DashboardClient.tsx:193`), so no admin can see CLIN-level burn today. | `node_modules/mantine-react-table/dist/index.esm.mjs:458,2082,2468,2532,3362`; `@mantine/core` 9.3.1 `Collapse.d.ts:6`, `Collapse.mjs:41` |
| B5 | **Deactivating a SLIN has no effect on charging.** `updateSlin` stores `slins.status`, but nothing in `src/server` or `src/lib` reads it. The timesheet guard checks the charge code, CLIN and contract only. Employees can keep charging time to a "deactivated" SLIN, unlike a deactivated CLIN or indirect code. Found by the UX-1 pre-mortem. **Product owner decided 2026-10-27:** a deactivated SLIN blocks new time like a CLIN; existing hours stay correctable. Server fix ships in UX-2. | `server/actions/slins.ts:36-55`; `server/actions/timesheet.ts:257,305-311` |
| B3 | **A supervisor's approval list includes their own timesheets with an active "Review" button**, but the server refuses supervisor self-approval. The user sees an action they can't complete. | `server/actions/periods.ts:445` ("+ self"), `:342`; screenshot 11 |

## 2. Navigation and page structure
1. **The admin sidebar has 18 flat items and scrolls at a normal window height** (screenshot 2 shows a scrollbar). Daily and configure-once pages sit side by side, and the Setup Wizard is permanently the first admin item (`components/shell/AppNavbar.tsx:22-44`).
2. **There's no Home.** Everyone lands on My Timesheet (`server/session.ts:152`). "Needs attention" information is scattered: approval notices on three pages, unpriced hours on Labor Categories, and the workweek-not-set warning only in Settings.
3. **The same job is split across pages:**
   - **Assignments:** Assignments (charge-code access, supervisor scope), Labor Categories (user→LCAT), and the Users modal (designated approver).
   - **Data:** Data Import (master data), Data Migration (timesheet history), and Settings (workspace export). Migration's copy promises charge-code and indirect-code imports that don't exist (`MigrationClient.tsx:241,245`).
   - **Reports:** Reports, the Dashboard's Period Cost Report (a duplicate download), and the cost-basis reports at the bottom of Labor Categories.
   - **Charge codes:** Direct (Charge Codes) and Indirect (Indirect Codes) are two nav items for one concept: "what employees can charge".
4. **Payroll export**, a task done every pay period, is reachable only through an Integrations catalog card (`IntegrationsClient.tsx:189-199`). The nav highlights exact URLs only, so integration sub-pages highlight nothing (`AppNavbar.tsx:58`).
5. **Approvals isn't a to-do list.** It shows every period in every status, sorted by period. Drafts appear with disabled buttons, and there's no "waiting" count anywhere (screenshot 11).
6. **No guiding empty states.** Every table says "Nothing here yet.", the timesheet grid shows only headers, and forms present empty dropdowns with no hint why (e.g. New Charge Code before any contract exists).
7. **Page chrome is inconsistent.** 9 pages use a narrow container while the rest are full-width. Timesheet, Setup, Payroll export, QuickBooks and Gusto skip `PageHeader`. Nav labels don't match page titles ("Indirect Codes" vs "Indirect Charge Codes"; "Change Password" opens "My Profile").

**Proposed placement:** every route mapped into the approved structure.

| Main menu | Contains |
|---|---|
| **Home** (new) | Role-aware "needs attention" (§6) |
| **My Timesheet** | — |
| **Approvals** (count badge) | Waiting for me first; history behind a filter |
| **Contracts** ▸ | Overview (budget burn), Contracts & CLINs, Charge codes (Direct / Indirect tabs), Labor categories |
| **People** ▸ | Users, Assignments (charge codes · approval scope · labor categories) |
| **Reports** ▸ | Downloads, Payroll export, Audit trail |
| **Settings** (separate area, admin) | Workspace, Billing, Integrations, API keys, Import & migration (Bulk import · Timesheet history · Export) |
| User menu | Profile & security, Notifications (route moves out of `/admin`), Sign out |

The Setup Wizard leaves the nav and becomes a "Getting started" card on Home, shown until complete (and correct per B1). Old URLs redirect.

## 3. What the screenshots show
| # | Screen | Observation |
|---|---|---|
| V1 | Timesheet (employee) | **The grid, the reason the page exists, starts below the fold.** Four stat cards plus a five-row Recent Periods table push it down. Jane sees one row of her grid without scrolling. |
| V2 | Timesheet | **Period status is shown three times:** card, badge and Recent Periods row. **Three period navigators:** arrows, dropdown, "Current". The title "Semi-Monthly Timesheet" sits mid-page; there's no page header. |
| V3 | Timesheet | **Every empty cell shows "—"** (16 × rows of dashes). Blank cells with a subtle grid read far calmer. |
| V4 | Timesheet | **Row labels stack three lines** (name, code pill, type pill), making rows ~85px tall. Leave rows are all named "Leave"; the real difference (Annual / Holiday) is only in a pill. |
| V5 | Timesheet (admin) | **Amber "LATE" pills on 7 of 16 day headers** cause alarm fatigue, including for days before the user existed (known issue). The weekly-hours warning is small orange text at the far right. |
| V6 | Dashboard | **"1691 hours unpriced" appears twice in the stat cards and twice per table row.** "Based on priced cost" repeats under every figure. An info banner takes the top of the page. Put this in one clear notice plus a single column. |
| V7 | Charge Codes, Labor Categories, Audit Trail | **Rows are ~105px tall** because the Contract column wraps to 2–3 lines while other columns sit half empty (e.g. Location). Labor Categories repeats "Army IT Support (W911QX-23-D-0042)" on every row; group by contract instead. |
| V8 | All tables | **Toolbar icons (search, filter, columns) are about as large as the page title** and appear on every table without labels. Row actions are unlabeled icons: pencil/tag/ban here, edit/$/toggle there. |
| V9 | All | **Uppercase everywhere:** section labels, stat-card labels and every badge (DRAFT, ACTIVE, GOVERNMENT SERVICES, ONSITE, TELEWORK). Combined with the badge count per row, it reads loud. |
| V10 | Reports | Three cards with two different layouts (icon left vs icon above), half the page empty, and disabled buttons nearly invisible. |
| V11 | Approvals (supervisor) | Scope sentence with inline count pills and a stray " ."; drafts listed; own timesheets listed (B3). |
| V12 | All | **The Next.js dev indicator shows "1 Issue" on nearly every page.** A runtime warning or error is firing; needs investigating (product owner: click it and paste the message). |

## 4. Interaction patterns, icons, copy
1. **Row actions: five different activate/deactivate patterns** (ban icon, toggle icon used for both directions, refresh icon for reactivate, cell Switch, text button). Edit is `IconPencil` in one table and `IconEdit` in four. The actions column is fixed at 80px for every table (`table/mrtDefaults.ts:34`), which fits two icons, not three. Charge Codes is the only multi-icon group without `nowrap` (`charge-codes/ChargeCodesClient.tsx:254`). Disabled row icons don't say why.
2. **Icons carry several meanings each:**

   | Icon | Meanings |
   |---|---|
   | Tag | Charge Codes nav; labor-category action |
   | Refresh | Reactivate; retry; load data; syncing |
   | Ban | Deactivate; revoke key; end assignment |
   | Key | Change password; reset password; API key |
   | History | Audit nav; revision history; sync history; Active Users stat |
   | Clock | Timesheet; Total Entries; timezone |

   Some icons misrepresent the action: media "play" for Sync Now, a generic shapes icon for Labor Categories. Icon sizes span 10–48px with no scale.
3. **Buttons and color carry no consistent meaning.**
   - The PDF download is red, Excel green, and warning-orange is used for primary buttons.
   - `ConfirmModal` is always red, so "Reactivate" gets a red button.
   - Create labels mix New/Add/Create ("New Charge Code" → "Save"; "Add Labor Category" → "Create").
   - One shared `isPending` makes unrelated buttons spin together.
4. **Errors appear four ways:** Alert, red Badge, red Text, notification. Approvals shows errors twice. Forms mostly just disable the submit button with no message. Required markers are missing on required fields (labor-category Contract/CLIN, CLIN number).
5. **Inputs.** Money inputs are free text, and currency is formatted four ways (some without thousands separators). Dates show ISO `YYYY-MM-DD` in the rate modals and Mantine's format elsewhere. Reason entry has four different patterns.
6. **Copy.**
   - Deactivate/Remove/End/Revoke/Delete are used interchangeably; "Rejected" vs "Returned".
   - "LCAT" vs "Labor category"; "User" vs "employee".
   - Title Case mixed with sentence case; "Role: admin" in raw lowercase.
   - Setup copy contradicts the charge-code model (B1).

## 5. Accessibility (WCAG 2.1 AA / Section 508)

**An ACR published today would have to mark four criteria "Does Not Support":** 2.1.1 Keyboard, 4.1.2 Name/Role/Value, 2.4.2 Page Titled, 1.4.3 Contrast. The Chapter 3 functional criteria 302.1 (without vision) and 302.7 (limited manipulation) would also fail.

| # | Severity | Finding | Evidence |
|---|---|---|---|
| A1 | Blocker | **Hours can't be entered by keyboard.** The hour cell is a `<div onClick>` with no tab stop, role or key handler; the input mounts only after a mouse click. There are zero `onKeyDown` handlers in `src/`. | `timesheet/cells/HourCell.tsx:86-107` (lead-verified) |
| A2 | Blocker | The hour input has no accessible name; "—" has no text alternative. | `HourCell.tsx:118,18` |
| A3 | Blocker | **The note button appears only on mouse hover.** In dense mode it's a 4px dot, and dense mode is forced below 1024 CSS px, so at 150–200% zoom nobody can add a note. | `HourCell.tsx:81,156-181`; `BiWeeklyTable.tsx:20-24` |
| A4 | Blocker | `role="table"` with no `role="row"` breaks the ARIA structure, so screen readers can't navigate the grid. | `BiWeeklyTable.tsx:92-180` |
| A5 | Serious | **Contrast.** White on signal-6 `#4F6BFF` is **4.30:1** on every primary button (lead-verified; needs 4.5). White on success-6 is 3.30, warning text 1.99–2.83, dimmed text 3.32 (172 uses), light badges 2.3–3.8, input borders 1.49 (needs 3.0). | `theme.ts:7-29,43` |
| A6 | Serious | One `<title>` for every route; no page has an `h1` (PageHeader renders h2); no skip link; auth pages have no `<main>`. | `app/layout.tsx:24`; `ui/PageHeader.tsx:15` |
| A7 | Serious | `overflow-x:hidden` on html/body plus fixed-width auth cards clip content at 320px with no scrollbar. | `globals.css:6-10`; `LoginForm.tsx:120` |
| A8 | Serious | Placeholder-only or unassociated labels: period selector, settings fields, table Switches, MFA PinInput. | 15 locations in the a11y report |
| A9 | Serious | `<Anchor onClick>` with no href can't be reached by Tab, so keyboard users can't switch to MFA recovery codes or "Start over". | `LoginForm.tsx:205-210`; `SignupForm.tsx:97,237` |
| A10 | Serious | Status shown by color alone (dirty cells, late dot, imported dot, burn tier). Sync, period-change and slug status aren't announced. Error toasts auto-close after 4s. | `HourCell.tsx:93-116`; `SyncStatusIndicator.tsx:81-92` |
| A11 | Moderate | Collapsed-rail tooltips are hover-only; no `aria-current`; no `aria-expanded` on the burger; invisible cell focus; focus lost after the note modal closes; MRT exposes no `aria-sort`; Progress bars unnamed; reduced motion not respected. | a11y report §15 |

**Tooling:**
- **Lint.** `eslint-plugin-jsx-a11y` is already installed via `eslint-config-next`, but only 6 rules are on. Add the recommended rules as a rules-only block; re-registering the plugin breaks ESLint 9. Start as `warn`, plus `no-restricted-syntax` guards for Mantine (ActionIcon without `aria-label`, Anchor `onClick` without href, placeholder-only inputs).
- **Render tests.** Add axe-core checks to the jsdom render tests (contrast and region rules off in jsdom).
- **End to end.** Add a Playwright + `@axe-core/playwright` CI job scanning every route in light and dark mode (WCAG 2.1 AA + section508 tags), with a 320px reflow check.
- **Manual.** A per-release VoiceOver + NVDA script following DHS Trusted Tester.

## 6. What Home shows (data the app already computes)
- **Employee:** current period status, hours, days done vs expected, submit-by date, a rejection comment with a Fix button, and the last few periods (`getEmployeeDashboardData`).
- **Supervisor:** the employee view, plus "N timesheets waiting for you", their scope (with the zero-scope message), and recent late entries and corrections.
- **Admin:** everything above, plus:
  - "Getting started" until setup is truly complete (B1);
  - approval notices;
  - unpriced hours and overlapping assignments;
  - contracts over budget;
  - workweek not set (blocks payroll export);
  - pending pay-period change;
  - trial or read-only status.
- **Gap:** no query exists yet for "who hasn't entered or submitted time".

## 7. Decisions for the product owner

**Answered 2026-10-27:** the product owner approved all seven mockup screens (`ux-mockups/index.html`) and the color choices. UX-D1 to UX-D4 take the defaults below.

| # | Decision | Default |
|---|---|---|
| UX-D1 | Primary blue for filled buttons and text | `#3F55E6` (signal-7, 5.75:1); `#4F6BFF` kept for non-text accents. Shown side by side in the mockups. |
| UX-D2 | Text case | Sentence case everywhere; badges stop being uppercase. |
| UX-D3 | Where employees land | Their Home *is* the timesheet, with a one-line status strip above the grid. Admins and supervisors land on Home. |
| UX-D4 | Default theme | Follow the OS setting (light or dark), toggle kept. |

## 8. Proposed sequence
1. **Direction doc with mockups:** new sidebar and Settings area, Home per role, the timesheet layout, one table with the row-action menu, the color fix. The product owner approves before any blueprint.
2. **UX-1 Foundations.** Low risk; unblocks everything else.
   - Contrast-safe theme tokens;
   - icon registry plus a static test;
   - `RowActions` (one primary action + "⋯" menu with labels);
   - `ConfirmModal` tone, `StatCard`, `MoneyInput`, `ReasonFields`;
   - `formatCurrency` / `formatHours` / `formatPeriodRange`;
   - per-route titles, an h1 in `PageHeader`, a skip link;
   - a11y lint rules (warn) and an axe helper.
3. **UX-2 Navigation, Home, Settings area.**
   - Route moves with redirects;
   - Setup Wizard → Getting started card (fixes B1);
   - Approvals as a to-do list (fixes B3);
   - user menu cleanup.
4. **UX-3 Timesheet.**
   - Keyboard grid (A1–A4, APG grid pattern);
   - layout so the grid is above the fold, with one status display and one period navigator;
   - calmer cells and row labels;
   - accessible notes and status.
5. **UX-4 Page pass.**
   - Every admin page on the shared patterns: tables, forms, empty states, confirmations (fixes B2);
   - merges: Direct/Indirect tabs, one Assignments page, Reports consolidation, Import & migration;
   - copy pass.
6. **UX-5 Accessibility verification.** Playwright + axe in CI, manual screen-reader pass, rules switched from warn to error, ACR draft for the business side.

Each phase gets the usual audit, break-it checks and product-owner browser checks before merge. Rate limiting (Phase 15) still lands before production; deploy Phases 3–11 continue in parallel.
