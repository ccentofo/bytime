# UX-4b Part 2 (Approvals review, Payroll export, demo seed): lead audit

**Audited:** branch `ux-approvals-payroll` at `124b3ad` (7 commits on `main` `7c816f3`) against `feature-plan-ux-approvals-payroll.md` **v3 FINAL**. **Date:** 2026-11-05.

**Method:**
- Lead gates.
- Two independent auditors:
  - Approvals (commits 1–4);
  - Payroll and seed (commits 5–7).

  They read every change and ran 35+ mutations; all were restored.
- **Product owner:** integration and `breakit-check-ux4b2.mjs` (8 Postgres checks).

**Verdict: NOT READY TO MERGE. No HIGH; 4 MEDIUM; fix round 1 below.**
- No path sends a decision with a `periodId`/`seen` pair other than the review on screen, or for an unseen timesheet (A10 verified, including the read token, `busy.any()` guards, the gate and the null-on-load/failure).
- For approved data, the exported payroll file (employees, days, exempt, `approvedOn`) is unchanged.

## 1. Results
| Check | Result |
|---|---|
| `tsc` / lint / unit (lead) | clean / 0 errors, 54 warnings / 197 files, 2177 pass |
| Auditor mutations | Approvals 16/19 caught; Payroll and seed caught all but 4 (see M3, L8, L11) |
| Break-its (product owner run, logs in `.breakit-logs-ux4b2/`) | **7/8 caught**; all four baselines pass. Check 7 (P-5 period length) **not caught**, which confirms M3 (a fixture gap, not a code bug). The run may have overlapped with auditor mutations; re-run after the fix round. |

**Dev gap decisions, all accepted:**
- workspace-day dates in `uiText`;
- Decided ordered by `reviewedAt` (imported rows may not match the "Decided on" column; recorded);
- Everything ordered by newest period;
- "Resubmitted after return";
- the old grid kept during Previous/Next (see M1);
- the fixed 3-row comment and the non-string message;
- the copy-sweep scope (the employee-side "Self-rejected" and the audit-trail event names are recorded as follow-ups);
- the person set and outside-expected rule;
- a stored draft is always listed;
- neighbour presets; ADP stays the default;
- the seed timestamps;
- the `NotIncluded` type moved to `lib/payroll/not-included.ts`;
- StrictMode in the deep-link test.

## 2. Fix round 1

### M1: while Next loads (or after it fails), the old grid is captioned as the new employee
- **Where:** `ApprovalsClient.tsx:541-549`, `:204-222`, `:409-411`.
- **Problem:** the kept grid shows timesheet A's hours and flags, while the caption, title, header hours and card counts describe B. After a failed read it stays that way. No decision is possible, but sighted and screen-reader users are told it's B's grid.
- **Fix:**
  - store `employeeName`, period label and hours **in `grid`**, and render the grid's caption from them;
  - while a read is in flight, the kept grid gets `aria-busy="true"`, reduced opacity on the table (not on focusable elements) and the visible line "Showing {previous employee} until this loads";
  - a failed read calls `setGrid(null)` and shows only the error with Retry;
  - the "Worth a look" and "Notes" counts are hidden until the review is ready.
- **Tests:**
  - during Next, the caption still names A and the busy line shows;
  - after a failure, no grid is shown;
  - the counts are hidden while loading.

### M2: focus drops to `<body>` after "open next" and after Retry
- **Where:** `ApprovalsClient.tsx:295`, `:424`, `:429-431`.
- **Problem:** the focused Approve/Return (or Retry) button unmounts when the card becomes "Loading…", and nothing announces the new timesheet.
- **Fix:**
  - the Drawer body has a heading `<h2 tabIndex={-1}>` (`{employee} · {period}`), focused **in `decide` before `loadReview(next)`** and in Retry before reloading;
  - a polite live region (inside the Drawer, empty at mount) announces "Opened {employee}, {i} of {n} waiting" once the next review is ready.
- **Tests:**
  - after approve with open-next, `document.activeElement` is that heading;
  - the live region text appears after the load;
  - Retry keeps focus inside the Drawer.

### M3: the P-5 guard can't catch period-length drift for misaligned rows
- **Where:** `payroll-p5-fixture.ts:27,31` and its unit companion.
- **Problem:** with Mo's row (Mar 3, null length), both "use the snapped period length" and "snap the start" leave his hours approved, so P-5 stays green under either regression.
- **Fix:** give Mo **8.00 h on Mar 2**.
  - The current code leaves that day unapproved, so the recorded payload stays at 24 h; either mutation pushes it to 32 h.
  - Re-record the P-5 expected payload **only if** it changes under the current code (it shouldn't).
  - Mirror this in the unit companion.
- **Verification:** break-it check 7 is then caught.

### M4: uncovered days next to a misaligned stored row vanish from "Not in this file"
- **Where:** `payroll-data.ts:251`.
- **Problem:** when a resolver period overlaps a stored row, all its uncovered in-range days are skipped, including days with hours and no row. This happens after an "apply immediately" schedule change, or with misaligned imported rows. The file is unaffected, but the person disappears from the warning list.
- **Fix:** for a skipped resolver period, if its uncovered in-range days have hours > 0, emit one row clipped to those days (`periodStart`/`periodEnd` = the first/last uncovered day; status `draft`; `periodId` null). Otherwise keep skipping.
- **Test:** a stored misaligned row plus hours on an uncovered day in the overlapping resolver period → listed as draft with those hours.

### LOWs (same round)
- **L1, stored length:** `p.periodNumDays != null && p.periodNumDays > 0 ? p.periodNumDays : getNumDaysInPeriod(...)` (`payroll-data.ts:152`), exactly as the old `existingPeriodLength` did.
- **L2, close focus:** `data-review-button={row.id}`, focusing the button of the row id that's now at the decided row's position (or the heading). No DOM-index lookup (`:228-229, 237, 289`).
- **L3, second click on close:** after a decision that closes the Drawer, clear `reviewData` immediately, so the card can't be clicked during the exit transition.
- **L4, ReviewGrid:**
  - the scroller gets `tabIndex={0} role="region" aria-label={caption}`;
  - day headers separate the day and date with a space (visually unchanged).
- **L5, orphan correction:** `previousHours === null` renders "—", not "0.00".
- **L6, deep-link toast:** a thrown read shows "Couldn't open that timesheet. Try again."; "isn't available to you" only when the id isn't in the rows.
- **L7, Payroll copy:**
  - "{n} people aren't fully in this file." when any row is partly included (else "aren't in this file");
  - Review links get `aria-label="Review {name}'s timesheet"`;
  - the "Not in this file" table gets `aria-label="People not in this file"`;
  - refused or failed previews link the reason to the download buttons with `aria-describedby`;
  - a polite live region announces "Preview updated for {range label}" when a new preview lands.
- **L8, tests:**
  - `reviewIdFrom` (invalid → ignored; array → first);
  - Previous/Next hidden for a deep-linked non-Waiting row;
  - a migration rev 1 with a reason plus an app rev 2 isn't "originally late" (`flagged-cells.ts:132`).
- **L9, preview range cap:** refuse ranges over 400 days with `UserFacingError('Choose a range of 400 days or less.')` (`payroll-export.ts:61`), in both the preview and the CSV actions.
- **L10, seed:** run the workspace timezone through `canonicalTimeZone` (`seed-full.ts:384`).
- **L11, seed tests:**
  - S-1 uses the period's real length (16-day periods), not `?? 15` (`seed-review-story.test.ts:79`);
  - assert Robert's correction is earlier than his resubmission;
  - a unit case pins the `t1 − 1 h` cap (a NOW where the machine's zone is ahead of the workspace's near midnight).

**Recorded, no change:**
- the two A10 layers are each individually removable without failing a test (defense in depth; both together are caught);
- admins or inactive users with a stored row but no entries in range aren't listed (rare);
- the Decided order vs imported dates;
- the employee-side "Self-rejected" and the audit-trail event names (follow-ups).

## 3. Product owner runs (after fix round 1)
1. Integration, then `node breakit-check-ux4b2.mjs` (expect 8/8 caught).
2. `npm run build && node scripts/check-build-trace.mjs && node scripts/check-css-output.mjs`.
3. `npm run demo:local` twice.
4. The browser checks in blueprint §11, plus:
   - after approving with "open next", keyboard focus is on the next timesheet's heading;
   - pressing Next shows "Showing {name} until this loads".

## 4. Fix round 1 verification (`c417f1a`…`d2bc6a2`, 7 commits), 2026-11-04
**Lead gates:** `tsc` clean; lint 0 errors, 54 warnings; 198 files, 2204 pass. The dev reports 66/66 revert checks.

**Read:** M1, M2, M4 and L1–L11 match §2. All dev gap decisions are accepted:
- the Drawer's own title is the focus target;
- the announcement also fires on Previous/Next;
- L2 uses the row at the decided row's position in the fresh list;
- L9 doesn't cap the Gusto sync.

M4's span can include a stored row's days when uncovered days fall on both sides of it. Only the uncovered hours are counted. Recorded, no change.

**M3 correction (lead error):** §2 M3 said either mutation would push Mo to 32 h. Only "snap the start" does. With the range ending Mar 15, the stored length (16 days from Mar 3) and the snapped length (15) both cover every in-range day, so a length-only change is invisible to this fixture.
- Break-it check 7 is repointed to "snap the start": `const start = resolver.periodContaining(...).start`. The Mar 2 hours catch it. The dry run passes for all 8 checks.
- Length-only drift gets a **unit case** (fix round 2, below), not a new P-5 person. A new person would force re-recording the payload on the pre-Part-2 code.

### Fix round 2 (one test)
**F2-1:** in `payroll-not-included.test.ts`, add an approved row from **Feb 3, 2026** with `periodNumDays: null`, 8.00 h on **Feb 16**, and range Feb 1–28.
- Its own length is 28 − 15 = 13 days (Feb 3–15). The snapped period's length is 15 (Feb 3–17).
- Expect Feb 16 **not** in `days`, and the person listed as draft Feb 16–28 with 8.00 h.
- It must fail with `const numDays = resolver.periodContaining(start).numDays;`.

**Product owner, before merging:** integration; `node breakit-check-ux4b2.mjs` (expect 8/8); build plus checks; `demo:local` twice; §3 browser items.

**Fix round 2 verification (`b74bcb8`):** one unit test, no product code; tree clean. The dev reports it fails with the length mutation, along with the partly-included and M4 cases; 198 files, 2205 pass. The dev's unit run overlapped the product owner's break-it run (check 8 briefly edited `seed-full.ts`). That can't affect the break-it result: break-it runs only integration files, and the dev changed only a unit test.

**Verdict (2026-11-06): READY TO MERGE.** The product owner reports integration, break-it, build plus checks, `demo:local` and the browser checks are all OK.
