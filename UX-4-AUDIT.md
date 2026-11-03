# UX-4 page pass: findings and plan

**Date:** 2026-10-29 · **Branch:** `main` at `d120c0a` · **Author:** lead architect.

**Method:**
- Three independent read-only audits: contracts area; people, approvals and reports; settings, account and public pages.
- The lead verified every correctness and security claim marked ✔ in the source.
- Product-owner screenshots: pending.

**Scope:** every screen except the timesheet and Past timesheets (done in UX-3), and the Terms/Privacy wording (business-owned).

**Verdict:** UX-1 and UX-2 fixed the frame (nav, Home, row actions, confirmations, contrast), but each page is still built its own way. The audits also found **one security bug and about fifteen correctness bugs** that a polish pass would hide, so they come first.

---

## 1. Security (hotfix, before anything else)
| # | Finding | Fix |
|---|---|---|
| S1 ✔ | **2FA setup sends each user's TOTP secret to api.qrserver.com** in the QR image URL (`profile/MFASetup.tsx:87-89`). The CSP is report-only by default, so nothing blocks it. | `feature-plan-hotfix-mfa-qr.md`: render the QR code locally with the existing `qrcode` dependency, plus a static guard. |

## 2. Correctness and safety bugs (UX-4a, no mockups needed)
| # | Page | Bug |
|---|---|---|
| C1 ✔ | Contracts | The CLIN drawer shows the **previous contract's CLINs**, with live Deactivate buttons, until the fetch returns (`ContractsClient.tsx:150-158`). No loader or error handling. |
| C2 ✔ | Indirect codes | Turning off "Available to all employees" **removes the code from every timesheet**, with no confirmation. There is no per-employee indirect assignment, so the toggle is a hidden deactivate (`IndirectCodesClient.tsx:326`, `timesheet.ts:577`). |
| C3 ✔ | Indirect codes | "Seed defaults" reports success when it inserted nothing (`indirect-codes.ts:134-135`, client `:186`). |
| C4 ✔ | Labor categories | A new category can't be assigned until reload (`assignableLcats` is frozen in `useState`, `LaborCategoriesClient.tsx:172`). |
| C5 | Charge codes | Editing a code whose CLIN is inactive opens with Contract and CLIN blank. The admin can't rename it without re-picking a CLIN, which the server refuses once hours exist. |
| C6 ✔ | Overview | Missing fragment key in the CLIN panel (`DashboardClient.tsx:212`), the dev "1 Issue". |
| C7 | Pay schedule | Save is enabled with nothing changed, and creates a fake "scheduled change". There is no confirmation for a change that moves every employee's periods. |
| C8 | Workspace | A timezone change (which "affects every employee immediately") saves with no confirmation. |
| C9 ✔ | First run | Email verification sends `welcome=1`, but the reset page ignores it, so a brand-new admin sees "Set New Password / Resetting password for…". The verify page is hand-built HTML with no `<main>` and fails contrast (3.6:1 and 2.5:1). |
| C10 | Import | Row errors exist only in a `title` tooltip (keyboard, touch and screen readers can't reach them); the employee tab shows none. |
| C11 | Migration | The "Upload CSV" control can't be reached by keyboard (`<label>` around `<input hidden>`). The copy promises charge-code and indirect imports that don't exist. |
| C12 | API keys | Esc or ✕ closes the one-time key dialog, and the key is lost. |
| C13 | QuickBooks / Gusto | `clearable` mappings can't actually be cleared. Existing mappings are hidden until "Load data" is clicked. Sync history never refreshes. |
| C14 | Audit trail | Correction rows fail contrast in dark mode (a light amber fill under dark-mode text colours). |
| C15 | Reports | Downloads use `window.open`. A failure opens a tab of raw JSON, and there's no loading state. |
| C16 | Users | A role change (e.g. employee → admin) saves with no confirmation. The FLSA toast says "Exempt (salaried)", which is legally wrong. |
| C17 | Setup wizard | Steps get a check mark just for being before the active one (Mantine Stepper). "Charge code access" counts as done when 1 of 20 employees has a code. Pay schedule, workweek and timezone are never set. |
| C18 | Payroll export | Defaults to "this month", not the last completed pay period, and never says who is left out of the file (unapproved timesheets). |
| C19 | Contracts | You can't edit a CLIN's or SLIN's funded amount, number or description, and you can't close a contract, though the server supports all of it. Funding changes are routine. |

## 3. Shared patterns (UX-4b: build once, sweep every page)
1. **Status vocabulary and badges:**
   - one `StatusBadge` and the shared words and colours (`lib/timesheet/labels.ts`, `PERIOD_STATUS_COLOR`);
   - no raw lowercase values ("active", "trialing", "onsite", "push_timesheets");
   - "Returned", never "Rejected".
2. **Page shell:**
   - `PageHeader` with a description on every page (Setup, Payroll, QuickBooks and Gusto lack it);
   - one container width per area;
   - the h1 always matches its nav label (enforced by a test);
   - notices below the h1;
   - h2 sections (no h1→h4 jumps).
3. **Form kit:**
   - labels and required markers on every field;
   - inline field errors plus one `role="alert"` summary;
   - **never a silently disabled submit**: validate on click and say what's missing;
   - readable dates by default (`MMM D, YYYY`);
   - a `MoneyInput`;
   - help text as descriptions, not placeholders.
4. **Numbers:**
   - `formatCurrency` / `formatHours` in `lib/format.ts`, replacing about six local copies;
   - a `numericColumn()` table preset (right-aligned, tabular figures, optional totals row).
5. **Per-action busy state:** retire the single shared `isPending` that spins every button at once.
6. **Errors that persist:** red toasts stay until dismissed (today they close after 4 seconds), and there's one error location per action.
7. **Guiding empty states:** per table, with the next step ("Add a contract first"). Replaces "Nothing here yet."
8. **A download helper:** fetch with progress, show real error messages, and offer shared pay-period presets ("Last pay period", "This pay period", "Custom").
9. **Settings section pattern:**
   - label, help and field;
   - Save enabled only when something changed;
   - an announced "Saved";
   - a `ConfirmModal` that states the consequence for high-stakes changes.
10. **Auth card:** `main`, h1, fluid width (works at 320 px), labelled PIN and recovery fields, password rules shown up front, a "Use a different account" path. The verify page and the welcome state get the same treatment.
11. **Sentence case and verb dictionary across the app:** Add → Save; Deactivate / Reactivate; "Labor category" (not LCAT); "employee" for people who record time.

## 4. Page redesigns (UX-4c: mockups first, then blueprints)
Ranked by daily impact:

| Page | Redesign |
|---|---|
| **Approvals review** | Highlight late and corrected cells with their reason and comment; show the previous return comment; a weekday grid with daily and period totals (the UX-3 grid look); **one comment box** with "Approve" and "Return for corrections" (validated on Return); "Approve and open next"; a "Decided by / on" column. |
| **Payroll export** | Last completed pay period by default; "N people not in this file" with a link to Approvals; a collapsible FLSA note; a totals row; `PageHeader`. |
| **Contracts** (with Overview) | One **hierarchy table** (contract → CLIN → SLIN as expandable rows) showing funded, cost, remaining and burn in words; inline funding edits; close contract. Overview: one unpriced-hours notice plus one column, right-aligned money. Its period cost report moves to Reports. |
| **Reports** | One page for every download (the cost-basis reports move here from Labor categories), with pay-period presets, real errors, neutral button colours and no orphan card. |
| **Assignments** | Per-employee view ("what can Jane charge?") grouped by person, active-only pickers, and one filter UI. Labor-category assignment and the designated approver move here (one Assignments page, per UX-AUDIT §2.3). |
| **Charge codes** | Direct and Indirect as **tabs on one page**; grouped by contract; Labor category and Billable columns; "Auto-generate" previews before creating. |
| **Labor categories** | Grouped by contract → CLIN; assignment and reports moved out (above); the 320 px overflow fixed. |
| **Users** | FLSA status and approver on create; confirm role changes; a Locked status; form errors as an Alert. (Invite email: see Q3.) |
| **Audit trail** | Last 30 days shown by default; Comment visible; Hours right-aligned; CSV export; events as a table. |
| **Setup wizard** | Timezone, pay schedule and workweek steps first; honest completion. |
| **Import and migration** | One page, one pipeline: accessible file picker, preview, visible per-row errors with "Download errors", confirmation, results. **Adds charge codes, indirect codes and charge-code access** (without them, bulk onboarding still ends in blank timesheets). |
| **Integrations** | One template for QuickBooks and Gusto: labelled mapping selects, auto-loaded data, working unmap, an auto-sync toggle (the server action exists), confirmed syncs, refreshed history. Connected apps listed once. |
| **Billing** | Price, trial end and seat usage (see Q4). |

## 5. Decisions for the product owner (defaults shown)
| # | Question | Default |
|---|---|---|
| Q1 | Page merges: Charge codes Direct/Indirect tabs; one Assignments page; all reports under Reports; one Import and migration page. | Yes, all four. Old URLs redirect. |
| Q2 | Approvals wording | "Approve" / "Return for corrections"; status "Returned" everywhere. |
| Q3 | New users get an **invite email** to set their own password, instead of the admin typing one. | Later. It needs the Resend account (a business item still open). Until then, keep admin-set passwords. |
| Q4 | Billing page shows prices (business-owned pricing). | The business side supplies the plan prices; the page shows them plus trial end and seats. |
| Q5 | **Landing page:** remove the "Tech stack" panel (Next.js, Drizzle and Vitest shown to buyers), add a visible headline and a "Sign in" link, fix "employees only see CLINs they're assigned to". | Marketing copy is yours. Default: remove Tech stack, add Sign in, fix the CLIN claim; you write the headline. |

## 6. Sequence
1. **Hotfix:** MFA QR (S1). Now.
2. **UX-4a:** correctness and safety bugs C1–C19 (C18 and C19 can ride with their page redesigns). Small, no visual decisions.
3. **UX-4b:** the shared kit (§3), plus a sweep that applies it to every page. Mostly invisible plumbing with a visible consistency payoff.
4. **UX-4c:** page redesigns. **Mockups for the product owner first**, in two batches:
   - daily work: Approvals, Payroll, Contracts / Overview, Reports;
   - set-up pages: Assignments, Charge codes, Labor categories, Users, Audit trail, Setup, Import, Integrations, Billing, Landing.

## 7. Product owner decisions (2026-10-31)
- **Batch 1 mockups approved as is** (`ux-mockups/ux4-batch1.html`: Approvals, Payroll export, Contracts, Reports). The product owner will judge the behaviour once it's built.
- **Taken as the defaults** (the product owner approved the mockups that use them and raised no objection):
  - Q1: all four page merges;
  - Q2: "Approve" / "Return for corrections", with "Returned" everywhere;
  - **Overview merges into Contracts** (one page).
- **Still open, needed only for batch 2:**
  - Q3: invite emails (default later; needs Resend);
  - Q4: billing prices (business);
  - Q5: landing page copy.

**Revised sequence:**
1. MFA hotfix.
2. **UX-4a** bug fixes (C1–C17; C18 and C19 move to the Payroll and Contracts pages).
3. **UX-4b:** the shared kit plus the four batch-1 pages built on it, so the kit is proven on real screens.
4. **UX-4c:** batch 2 mockups, then build.

## 8. Product owner feedback (2026-11-03): Labor categories moves into UX-4b
The product owner found `/admin/labor-categories` crowded. It's three jobs on one page, it isn't clear you need to scroll, and the cost-basis report lists every unpriced entry (1,732 rows in the demo).

Mockups were added to `ux-mockups/ux4-batch1.html`:
- **Labor categories:** categories and rates only, grouped by contract (expandable), with a "People" count and one unpriced notice linking to the report.
- **Unpriced hours** (under Reports): entries grouped by cause × employee × code into "things to fix", each with total hours, a date range and a direct fix action, plus an Excel download with per-entry detail.

The labor-category assignment form moves to People → Assignments as a third tab. Since Reports already absorbs these reports in UX-4b, these pages join UX-4b's scope.
