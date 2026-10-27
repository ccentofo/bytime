# UX-2 navigation, Home and fixes: lead audit of the implementation

**Audited:** branch `ux-navigation` at `d2af764` (5 commits on `153b098`) against `feature-plan-ux-navigation-home.md` v3 FINAL plus the lead's two pre-coding rulings. **Date:** 2026-10-27.
**Method:**
- Lead re-ran the gates and reviewed the server-side diff.
- Two independent auditors: server/data/security, and routes/shell/UI. They ran the unit suites with axe, read every integration test, and diffed the Settings split line by line against main.
- The product owner ran the integration suite and the lead's `breakit-check-ux2.mjs` (16 Postgres mutations, with a baseline run first).

**Verdict: NOT READY TO MERGE. No HIGH; 2 MEDIUM; fix round 1 below.**

## 1. Gates and runs

| Check | Result |
|---|---|
| `tsc` | clean (after deleting the stale gitignored `.next/dev/types`) |
| `npm run lint` | 0 errors / 65 warnings |
| `npm run test` | 123 files / 1553 pass |
| Integration (product owner) | **534 passed**, 5 skipped (2 files, normal). **All 7 new integration files pass on their first Postgres run.** |
| Postgres break-its (product owner) | **15 / 16 caught**. #9 (`AT TIME ZONE` removed) NOT CAUGHT; see M2. |
| Dev's unit break-its | 65 / 65 caught. Weak first attempts were redone and disclosed. |
| Security | No new `'use server'` exports. Every refactored action keeps its guard first, with no new client input. `/home` re-reads the role from fresh facts and redirects anyone not an active approver. Supervisors get no money and only `approvableScope` names. |
| DCAA | B5 refuses only new hours (`newCellRefusal` on cells with no prior revision). Corrections, revisions, reason codes and the lock are untouched. The save is still all-or-nothing (T17 mixed batch writes zero rows). `CHARGEABLE_CODE` is unchanged for codes without a SLIN. |
| Money | `clinCostTotals` equals the old Dashboard query exactly, with per-CLIN rounding, so Dashboard numbers don't change. `unpricedTotal` covers all contracts. |
| Build, demo ×2, browser checks, pre-deploy SLIN query | product owner, after fix round 1 |

## 2. Rulings recorded
1. **Before coding.** Scope sentence: n = people approvable via a shared CLIN who didn't designate the supervisor; k = people who designated them; n + k = Home's team size (`approvableScope`). Approvals drawer copy: "Closed to new hours (recorded hours shown)". Both implemented and tested.
2. **Dev additions, all accepted:**
   - a shared `approvableScope`;
   - a people count in the queue;
   - pure attention rules in `src/lib/home/attention.ts`;
   - the `userRole` prop name;
   - `withInitialFocusPlaceholder={false}` on the header menu (axe);
   - five internals extracted behind their guarded actions.
3. **Home's self-approval / designee item** respects the same per-notice dismissal as `ApprovalNotices` (fix L10).

## 3. Fix round 1 (required before merge)

### M1 (MEDIUM): collapsed-rail group icons show no label
`AppNavbar.tsx:130-144`: the Contracts, People and Reports triggers are `ActionIcon`s with only an `aria-label`, so hovering or tabbing shows nothing. That fails browser check 5; leaves have tooltips (`:97`).
- **Fix:** wrap each trigger inside `Menu.Target` in `<Tooltip label={group.label} position="right" events={{ hover: true, focus: true, touch: false }}>`, using Mantine's Menu-plus-Tooltip nesting.
- **Test:** extend T3 so each rail group trigger has a tooltip (focus shows the label); axe stays clean.

### M2 (MEDIUM): T8's timezone case can't fail where the database runs in the workspace's timezone
- **Evidence:** break-it #9 (`(created_at)::date` without `AT TIME ZONE`) passed. The "Last Day Hire" case (`2026-10-01T02:00:00Z`, 10 pm Sep 30 New York) uses `America/New_York`, which is also the product owner's local Postgres timezone, so the mutation is equivalent there. Neon runs in UTC, where the code matters.
- **Fix (test only):** use a workspace timezone that differs from both UTC and New York, e.g. `Pacific/Honolulu`, with a user created at `2026-10-01T05:00:00Z`. That's 7 pm Sep 30 in Honolulu but Oct 1 in UTC and New York. Assert the user is counted for the period ending Sep 30. Keep the existing cases.
- **Break-it:** re-run `node breakit-check-ux2.mjs 9`; it must be caught.

### LOWs (cheap; same round)
- **L1** Home item 7 shows a raw ISO date (`src/lib/home/attention.ts:148`). Use `formatCalendarDate(..., 'MMM D, YYYY')`, and test it.
- **L2** Scope sentence when n = 0 and k > 0: drop the CLIN clause ("You review 1 person who designated you"). Add a test case.
- **L3** The drawer title says "Review — {name}" even from a View row. Use `canApprove ? 'Review' : 'View'`.
- **L4** Align headings with the nav labels: the migration page heading and title become "Timesheet history import", and the import page "Data import" (sentence case). Update `page-metadata` expectations.
- **L5** `HomeClient` has no page container (`HomeClient.tsx:25`). Match the other pages' wrapper (same `Container` / padding as the PageHeader pages) so spacing and max width are consistent.
- **L6** `getWaitingCount` builds an unused `oldestPeriodLabel`, which can cost an extra `configAt` query on every page. Add `opts.label` (default true), and have `getWaitingCount` pass false.
- **L7** `approvalQueue` ORDER BY: add `periodStart ASC` as a tiebreaker after `submitted_at ASC NULLS LAST`.
- **L8** `getEmployeeDashboardData` (`actions/employee-dashboard.ts:67-81`): run `currentPeriodSummary` and the recent-periods query in one `Promise.all` (restores the old single round trip).
- **L9** Tests:
  - T12: rows with distinct `periodStart` values, asserting Everything is newest-first after switching from Waiting.
  - T2: `activeHref('/a/b/c', [{ href: '/a' }, { href: '/a/b' }]) === '/a/b'`.
  - T3: assert the badge has `aria-hidden="true"`.
  - T9: rename the "just-demoted admin" case to say what it tests (DB role is supervisor), and add a static check that `home/page.tsx` passes only `user.id` to `getHomeData`.
- **L10** Home's self-approval / designee item respects `ApprovalNotices`' `localStorage` dismissal (same keys). Export the helpers from `ApprovalNotices`, and use the same "treat as dismissed until mounted" read, so nothing flashes or mismatches. Add a test.

**Notes (no change required):**
- T1's comment-stripping scanner can miss a `//` inside JSX text. A raw `git grep` finds no old paths, so a backstop is optional.
- T4's "first render doesn't toggle" assertion can't fail (closing a closed menu does nothing). The behaviour is harmless; the main assertion is solid.
- Home loads approval facts twice (layout + Home), about 3 extra small queries. Backlog.

## 4. Fix round 1 verification (`3911d57`), 2026-10-27

- **Lead gates:** `tsc` clean; lint 0 errors / 65 warnings; 124 files / 1563 tests pass. `breakit-check-ux2.mjs --dry-run`: all 16 edits still apply after the L6/L7 queue changes.
- **M1 deviation accepted.** The Tooltip wraps `Menu.Target`, not the reverse: Tooltip forwards unknown props to its floating box, so the audit's nesting would have moved `aria-haspopup` / `aria-expanded` off the button. The dev's break-it M1-b proves it; the lead confirmed the structure at `AppNavbar.tsx:133-148`.
- **M2:** a test-only Honolulu case (05:00Z counted, 11:00Z not). **Pending: the product owner runs `node breakit-check-ux2.mjs 9`.**
- **L1–L10** fixed as specified. Additions accepted: the "API keys" casing, and a page-metadata rule that Settings titles and headings equal their nav labels. The dev reports 20 / 20 unit break-its.
- **Code audit: CLEAN pending the product owner's runs:**
  - integration suite;
  - break-it #9;
  - `npm run build && node scripts/check-build-trace.mjs`;
  - `demo:local` ×2;
  - the §10 pre-deploy SLIN query (read-only, local DB);
  - the §10 browser checks.
