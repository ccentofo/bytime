# UX-4b Part 1 (kit + Contracts, Labor categories, Unpriced hours, Downloads): lead audit

**Audited:** branch `ux-kit-contracts` at `73babb3` (9 commits) against `feature-plan-ux-kit-contracts.md` **v3 FINAL**. **Date:** 2026-11-04.

**Method:**
- Lead gates.
- Two independent auditors:
  - kit plus Downloads (commits 1–5 and 9);
  - Contracts, Unpriced, Labor categories and Assignments (commits 6–8).

  Together they read every change, ran the suites and made 24 mutations (21 caught).
- **Product owner:** integration and `breakit-check-ux4b1.mjs` (9 Postgres checks).

**Verdict: NOT READY TO MERGE. No HIGH; 4 MEDIUM; fix round 1 below.** The kit and every page match the blueprint. The auditors re-derived every C-1 literal by hand and traced the integration expectations against the schema.

## 1. Results
| Check | Result |
|---|---|
| `tsc` / lint / unit (lead) | clean / 0 errors, 54 warnings / 186 files, 2092 pass |
| Auditor mutations | 21 of 24 caught (3 survivors are test gaps; see L2, L3, L5) |
| Break-its (product owner) | 8/9 caught; C-1 not caught (test gap, L14) |

**Dev gap decisions, all accepted:**
- `paginateExpandedRows` only when paginating: correct. Otherwise compact trees never expand (`getExpandedRowModel.js:20`).
- The searchable value is `searchText`.
- Busy group blocking within one button set (but see M4).
- Notice hours to 2 decimals.
- The next-rate line kept.
- The Unpriced Excel 422 only when there are no groups *and* no overlaps.
- The signed-timesheet inline message.
- Presets resolved at download.
- People = 0 as plain text.
- Removing the employee chip also drops `assignments`.
- The `labor-categories-assignable` rewrite.
- Assignments with 10 loads (cached settings).
- `getOverlappingAssignmentsReport` kept (see L9).

## 2. Fix round 1

### M1: a SLIN-scoped Unpriced view loses CLIN-level overlap pairs
- **Where:** `internal/cost-basis.ts:520-521` (`inScope`), used at `:550` and `:563`.
- **Problem:** with `slinId` set, `inScope` requires `p.slinId === f.slinId`, but CLIN-level pairs have `slinId = null`. A SLIN entry whose basis was decided at the CLIN level then gets no pairs. Following the SLIN row's Unpriced link from Contracts shows "Overlapping categories" with an empty `assignments=`; `totals.overlaps` is 0, and the Excel Overlaps sheet is empty.
- **Fix:** attach pairs to groups from **all** pairs (the level, user and location match is already exact). Apply `inScope` only to the unattached and out-of-view lists, and there a `slinId` filter also accepts `p.level === 'clin' && p.clinId === <that SLIN's CLIN>`.
- **Test:** the U-1 integration case also run with `{ slinId }`. The pair is attached, and `totals.overlaps ≥ 1`.

### M2: the Unpriced page hides its CLIN/SLIN scope
- **Where:** `UnpricedClient.tsx`, filter group.
- **Problem:** a link from a Contracts CLIN or SLIN row lands scoped, but only the contract shows, so the numbers read as the whole contract's.
- **Fix:** a removable chip, "CLIN {n}[ · SLIN {n}]". Removing it drops `clinId`/`slinId` from the URL.
- **Test:** the chip appears and its removal clears the scope.

### M3: typed dates got stricter app-wide, and invalid text is silently discarded
- **Where:** `date-utils.ts:157-172` (the theme default parser for every DateInput).
- **Problem:** "oct 1, 2026", "OCT 1, 2026", "Oct 01, 2026", "Oct 1 2026", "1/05/2026", "01/5/2026", "2026-1-5" and "Sept 1, 2026" all return null. Mantine then restores the old value on blur, with no message.
- **Fix:**
  - normalise before parsing: trim, collapse spaces, title-case a month word, and map "Sept" to "Sep";
  - accept `MMM D, YYYY`, `MMM DD, YYYY`, `MMM D YYYY`, `MMMM D, YYYY`, `YYYY-MM-DD`, `YYYY-M-D`, `M/D/YYYY`, `MM/DD/YYYY`, `M/DD/YYYY` and `MM/D/YYYY`, all strict;
  - partial input still returns null.
- **K-9 additions:** each of the listed inputs → the right `YYYY-MM-DD`; "Oct 1, 2" → null; "2026-02-30" → null.

### M4: every table row shares one busy group
- **Where:** `useBusy.ts:7,32`; `ContractsClient.tsx:322`, `LaborCategoriesClient.tsx:328`.
- **Problem:** `row:A` and `row:B` both fall in group `row`. While row A's action runs, row B's button does nothing, with no loader and no message.
- **Fix:** blocking is **same-key only** by default. A button set opts in with an explicit `group` option, e.g. `busy.props('costs:excel', { group: 'costs' })`. Rows never share a group.
- **Test:** two rows act concurrently (both loaders show), while Excel and CSV in one Downloads row still block each other.

### LOWs (same round)
- **L1, search state:** reset `searchExpanded` to `true` whenever the **query changes** (not only empty → non-empty), so newly matched ancestors show expanded (`mrtDefaults.tsx:229-232`).
- **L2, tests:**
  - search, Hide, clear, search again → expanded (the reset was untested);
  - a paginated tree (> 25 groups): expand works, and search shows matches with their children.
- **L3, C-3 test:** the mocked update returns a value **different** from the form (e.g. the old funding), and the UI shows the returned value. This catches merging the form.
- **L4, expand-button names:** CLIN toggles read "Show SLINs for CLIN {n} on {contract}" (CLIN numbers repeat across contracts).
- **L5, Unpriced Excel:** test that groups = 0 with overlaps > 0 returns 200 and includes the Overlaps sheet.
- **L6, search text:** CLIN and SLIN `searchText` include the "CLIN"/"SLIN" prefix shown in the cell.
- **L7, Cost by pay period:**
  - contracts sort by name, then number, then id;
  - skip rows whose hours, cost and unpriced are all 0.
- **L8, validation:**
  - `getUnpricedExportData` runs `parseUnpricedFilters` itself;
  - `resolvePeriodRange` custom wraps date parsing in `UserFacingError('Enter valid dates.')`;
  - the Unpriced Excel route accepts duplicated start keys by preferring `start`/`end` (no 400);
  - its scope label names the contract/CLIN/SLIN scope and one-sided ranges ("From Oct 1, 2026" / "Through Oct 31, 2026").
- **L9, dead code:**
  - remove `getOverlappingAssignmentsReport`, and point its test at the internal `overlappingAssignments`;
  - remove `UnpricedNote` and `PricedBasisNote` if they still have no importers (grep first).
- **L10, Unpriced UI:**
  - the empty state under filters reads "No unpriced hours in this view.";
  - the period select is derived from the URL, not initial state, so back/forward stays in sync.
- **L11, labels:** a single-day range reads "Nov 1, 2026", not "Nov 1 – 1, 2026".
- **L12, headings:** Downloads row titles are `h2`, not `h3` under the h1.
- **L13, focus rule:**
  - the Assign button in `LaborCategoryAssignmentsPanel` and `RateScheduleModal.tsx:159` use `useBusy` props plus aria-disabled with a reason, never `disabled` / `loading`;
  - validation runs on click with inline errors.

- **L14, break-it C-1 not caught** (product owner run, 2026-11-04): removing `LATEST_REVISION` from the per-SLIN query (`contracts-overview.ts:51`) passes, because every SLIN entry in the C-1 fixture has a single revision; the only revision-2 entry is on a code with no SLIN. **Fix:** a separate integration case in `contracts-overview.test.ts` (leave the C-1 fixture and its literals alone): a SLIN entry with revision 1 of 6.00 and revision 2 of 3.00. Expect the SLIN's hours to be 3.00, and its cost to use 3.00 hours. This must fail with the mutation.

**Recorded, no change:**
- pair attachment and "has hours" use each location's min–max date range, so a pair inside a gap between conflict entries may attach (rare, conservative);
- pairs belonging to groups past the 1,000 cut aren't listed (the truncation notice says to download Excel).

## 3. Product owner runs (after fix round 1)
1. Integration, then `node breakit-check-ux4b1.mjs` (expect 9/9 caught).
2. `npm run build && node scripts/check-build-trace.mjs && node scripts/check-css-output.mjs`.
3. `npm run demo:local` twice.
4. Browser: blueprint §11, plus:
   - type "oct 1, 2026" into a date field and it's accepted;
   - two Reactivate clicks on different rows both run;
   - from a SLIN row's Unpriced link, an overlap's Review link highlights rows, and the scope chip shows.

## 4. Fix round 1 verification (`8805aec`, `b8b444b`, `4f0456c`), 2026-11-05
**Lead gates:** `tsc` clean; lint 0 errors, 54 warnings; 188 files, 2118 pass. `breakit-check-ux4b1.mjs --dry-run`: all 9 edits apply. L14 adds a SLIN revision case to `contracts-overview.test.ts`, so break-it check 1 should now be caught.

**Product owner, before merging:** integration and `node breakit-check-ux4b1.mjs` (expect 9/9), build plus checks, and the §3 browser items.
