# Excel cost report: charge codes and Class (item 5): lead audit

> **Verdict: READY** (2026-11-13, at `064e582`). No HIGH or MEDIUM findings and no scope items. Five LOWs are recorded in §5; none needs a fix round.
>
> **Next:**
> 1. The product owner pushes the branch and opens the PR, and CI goes green.
> 2. The product owner runs the integration command, then `EXCEL-COST-REPORT-BROWSER-CHECKS.md` personally (it includes the build).
>
> **Audited:** branch `excel-cost-report`, commit `064e582` (one commit on `57844ec`). Blueprint `feature-plan-excel-cost-report.md` FINAL v3.1, plus the implementation details approved at the impact-analysis review (tracker handoff notes, 2026-11-13).

## 1. Scope check
The 14 changed files are exactly blueprint §10.1 plus the test files §11 names (`cost-report-charge-codes.test.ts`, `employee-summary-excel.test.ts`).
- **Product code:** the query, the Excel writer, the CSV route, two comment-only edits (`/api/v1/costs`, the server action), the note constant and the two approved sentences (Q2, Q3).
- **Untouched, byte for byte:** `generateEmployeeSummaryExcel`, Cost by pay period, Unpriced hours, the PDF and the `cost-report-xlsx` route.
- **Nothing outside the blast radius. Nothing for the product owner.**

## 2. Lead gates (2026-11-13, at `064e582`)
| Gate | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors in source or tests. The only 2 errors are in `.next/dev/types/validator.ts`, the stale dev-server file from 2026-11-11 (it still points at the `gusto-connect` / `qbo-connect` routes deleted in launch hardening). Not from this branch; the next `next dev` regenerates it. |
| `npm run lint` | 0 errors (39 warnings, none in a changed file). |
| `npm run test` | 227 files, 2,525 passed. |
| `npm run build` | Compiled successfully (run as checks step 0.3 in the rehearsal). |
| Integration | Auditor A ran every suite that calls the query, all passing: the new file 7/7, `costs-api` 7/7, `cost-basis` 16/16, `dated-rates` 13/13, `dated-rates-d3` 12/12, `calendar-dates-d9` 6/6, `report-routes` 5/5. The dev reports the full run: 730 passed, 5 skipped (2 files skipped only for want of `TEST_DATABASE_URL` / `TEST_DATABASE_URL_2`; no control-plane suite skipped). The product owner re-runs it at the merge gate. |

## 3. Break-it (`/tmp/ecr-lead-breakit/breakit-check-excel.mjs`, outside the repo)
I wrote 15 mutations of my own, chosen independently of the dev's 21. **13 caught, 2 survived** (§5 L1, L2). The tree was clean afterwards.

| # | Mutation | Result |
|---|---|---|
| L1 | Class join on the wrong key | caught (integration) |
| L2 | mapper `chargeCode` from `className` | caught (`costs-api`) |
| L3 | code and entry-id ORDER BY keys swapped | caught (T6) |
| L4 | same swap | caught (T17) |
| L5 | `contracts.id` dropped from ORDER BY | caught (T17) |
| L6 | Excel Class cell shows the code | caught |
| L7 | Excel cost column format dropped | caught |
| L8 | Excel Class header renamed | caught |
| L9 | Excel unpriced row padded to the old width | caught |
| L10 | one Class column width removed | **survived** (L1 in §5) |
| L11 | CSV Class column removed | caught |
| L12 | CSV note not escaped | caught |
| L13 | CSV byte-order mark doubled | caught (T16) |
| L14 | CSV header lowercase | caught |
| L15 | dialog `className` tag dropped (the second tag remains) | **survived** (L2 in §5) |

## 4. Independent auditors (two, each in its own worktree)
**A: query, CSV, API. No HIGH or MEDIUM.**
- It ran the old and new query side by side on `tenant_acme` through a read-only connection, over three ranges (all dates, October 2026, November 2026; 2,442 / 222 / 90 rows).
- Row count, hours, cost, unpriced hours, every other field and the visible order were identical; every row carries both new keys.
- Exactly one byte-order mark on the 200 path and none on the error paths. The mark survives the browser download (`downloadFile` saves `res.blob()`).
- The API change is additive only, and guards, tenancy and read-only are unchanged.
- 11 mutations, all caught.

**B: Excel, copy, scope. No HIGH or MEDIUM.**
- It built a real workbook and checked every §6.2 item, including widths in the sheet XML (nothing misaligned).
- It rendered the dialog JSX with `react-dom/server`: the text equals the approved Q2 sentence character for character.
- Q3 and Q4 are exact.
- 24 mutations: 20 caught; 4 survived (§5 L1–L3, plus one with no visible effect).

## 5. LOW findings (recorded; no fix round)
| # | Finding | Why it's LOW |
|---|---|---|
| L1 | The Excel column widths (§6.2 item 7) aren't asserted; the old 11-width array passes T9. | Cosmetic. The current widths are correct (auditor B, sheet XML), and §11's T9 list doesn't name widths. |
| L2 | T14 checks the two `<Code>` tags, not the full Q2 sentence; a wording change passes. | The sentence is right today (rendered, auditor B) and checks step E.3 shows it. §11 asks only for the tags. |
| L3 | The Class note's italic grey font (§6.2 item 6) isn't asserted. | Cosmetic; correct today. |
| L4 | T16 checks "no mark" on the 422 path only; 400 and auth errors are covered by reading the code. | The mark is added only in the 200 `return`. |
| L5 | Blueprint wording: §10.1 says nothing else in `charge-code-cost-rules.test.ts` changes, while §11 puts T9/T10 there; T12/T14/T15 went there by the impact-analysis ruling. | A spec inconsistency, resolved at the review. |

If the product owner wants it, a one-line test hardening for L1–L3 can ride along with item 5b. Not scheduled.

## 6. Checks rehearsal (`EXCEL-COST-REPORT-BROWSER-CHECKS.md`)
- I rewrote the file to the copy-paste standard, with one helper script written by a quoted heredoc and short commands.
- I rehearsed it against `064e582`. Every bash block was extracted verbatim and run in its own fresh interactive zsh (`zsh -i -s`, so history expansion is live as in a tab), in order: helper, reset, build and start, the insert dry run, the insert (and a repeat run), saving the key, the API call, cleanup, reset.
- The browser clicks were checked by fetching the URLs the buttons call, signed in as the admin. The Class edits in C were applied with the equivalent SQL. Every label comes from the code.
- **Results:**
  - A: 13 headers; 735 `NAVAIR-0001-ONSITE` / 245 `NAVAIR-0002` rows, all "Government Services"; both notes; formats.
  - B: 14 headers; one mark; 245 Unpriced rows with `—`; three footer lines.
  - C: all 490 `DISA-0001` rows, oldest `2025-12-01`, show "R&D Programs", then blank.
  - D: the Jane Smith `2026-10-03` row with both cells blank, priced at SE-III.
  - E: 31 rows, `2026-10-03 null null`.
  - F: Hours summary headers unchanged.
  - G: the demo restored (Class back, the extra entry and the key gone).
- **The rehearsal caught two problems in my rewrite, both fixed:**
  - step 0.3 lacked `AUTH_TRUST_HOST=true`, so sign-in failed with `UntrustedHost`;
  - a step reading `~/Downloads` was dropped, because macOS blocks that folder from a shell without permission.
- **Not rehearsed by a person's clicks:** the visual look in Excel or Numbers, and the dialog and Downloads sentences on screen (both checked from the code and auditor B's render). These are the product owner's steps.

## 7. For the lead after the merge
- PRODUCTION-DEPLOY.md Phase 15: mark the Excel cost report row done, and change "PDF already does" to "the PDF shows the charge code" (blueprint §10.3).
- Tag `stable-YYYY-MM-DD-excel-cost-report`.
