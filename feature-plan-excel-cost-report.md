# Excel cost report: charge codes and Class (build queue 5)

> **Status:** **FINAL v3.1**, 2026-11-12, lead architect. **Pre-mortem CLEAN for the blueprint** (rounds 1 and 2, plus a confirmation pass that found only LOWs in the blueprint and one MEDIUM in the checks file, fixed and lead-verified; §14). **Accepted by the product owner on 2026-11-13, with Q1–Q5 all as recommended** (§2). Ready for a fresh dev session.
>
> **Branch:** `excel-cost-report`, from `main` at `9427fba` (after 4b, PRs #27 and #28). This file and its checks file are committed there first. The §3 references were checked on `a80ad8b`; 4b changed none of those files.
>
> **Source:**
> - `LAUNCH-TRACKER.md` build queue 5, approved 2026-11-12; PRODUCTION-DEPLOY Phase 15 ("Excel cost report shows charge codes and Class").
> - Product owner, 2026-11-12, **E1–E4** (all accepted):
>   - **E1:** the detailed cost report gets the columns in Excel and CSV, and `/api/v1/costs` gets additive `chargeCode` and `className` fields. The Hours summary and Cost by pay period are unchanged.
>   - **E2:** the columns are "Charge Code" and "Class" only.
>   - **E3:** Class is the charge code's Class today, with a one-line note in the file.
>   - **E4:** entries with no charge code (imported history, CLIN-only) get blank cells.
>
> **Standard:** `BLUEPRINT-STANDARD.md`.

## 1. Goal and scope

**Goal.** The detailed cost report (Downloads › Contract costs, Excel and CSV, plus `/api/v1/costs`) shows each row's contract, CLIN and SLIN but not the charge code or its QuickBooks Class. Accountants reconcile against QuickBooks by Service Item (charge code) and Class, so they can't use the file as it stands. Worse, the report already has one row per time entry: when someone charges two codes on one CLIN on the same day (for example NAVAIR onsite and telework), the file shows two rows that look identical. This blueprint adds the two columns.

**In scope**
1. `getDetailedCostReportData` returns `chargeCode` and `className` on every row (§6.1).
2. The detailed Excel gets "Charge Code" and "Class" columns after SLIN, plus the Class note (§6.2).
3. The CSV gets the same two columns and the note line (§6.3).
4. `/api/v1/costs` carries the two fields automatically (it returns the query's rows as they are). No code change in the route (§6.4).
5. One shared constant for the note's text (§6.5).

**Out of scope**
- The Hours summary Excel and Cost by pay period (E1).
- The PDF timesheet (it already shows the charge code; it doesn't show Class, and nobody asked for it).
- The QuickBooks push. It never sends Class today (`classRef` is never set, `src/lib/integrations/connectors/quickbooks-online.ts:161`); recorded, not changed.
- Storing Class on time entries (E3: the report shows the Class the code has today).
- Response-size limits on the CSV and API (§9; that's question Q1).

## 2. Questions for the product owner

**Answered 2026-11-13: all five as recommended.** So §6.3 item 3, §6.6 and §6.7 are in scope, with T14–T16, and Q1 becomes build-queue item 5b. None of these changes the E1–E4 design.

| # | Question | Lead's recommendation |
|---|---|---|
| Q1 | **Existing size limit (found while checking platform limits, §9).** Vercel rejects a function response over 4.5 MB (413). `/api/v1/costs` passes that at about 10,700 rows today, and about 9,400 with the two new fields, which a 30-person workspace reaches in roughly a year (the API allows a 366-day range). The CSV passes it at about 40,000 rows today and about 31,000 rows with the two new columns, which is about a year for 100 people. Excel is compressed, so its file stays small, but building it in memory reaches Vercel's 2 GB function memory at roughly 100,000 rows (measured: about 910 MB at 50,000 rows). The Excel and CSV downloads have no date-range cap. | Keep it out of this blueprint. Add a small separate item, right after this one: stream the CSV and the API response (streamed responses are exempt from the size limit) and decide a range or row cap for the Excel download. Until then it's a watch item. |
| Q2 | Should the API key "Copy your API key" dialog, which already explains `costBasis` and `hourlyRate`, also explain the new fields? Proposed sentence: "Each row also has <Code>chargeCode</Code> and <Code>className</Code> (null when the entry has no charge code or the code has no Class). <Code>className</Code> is the charge code's current Class." | Yes. It's the one place the API fields are described. |
| Q3 | Should the Contract costs description on Downloads mention charge codes? Today: "Hours and cost by contract, CLIN and labor category, using the rate in effect each day." Proposed: "Hours and cost by contract, CLIN, charge code and labor category, using the rate in effect each day." | Yes. |
| Q4 | Is this the note text for E3 (in the Excel and the CSV)? "Class shows the current Class of each charge code, including on past dates." | Yes, this text. It has no apostrophe on purpose: the CSV is sent without a UTF-8 marker, so Excel shows a curly apostrophe as "â€™" (see Q5). |
| Q5 | **Existing display bug (found in pre-mortem round 1).** The cost report CSV is sent without a UTF-8 byte-order mark, so Excel opens it in the wrong encoding. The "—" that unpriced rows already show in the LCAT Code column appears as "â€”". The workspace export already adds the mark for this reason (`src/lib/export/workspace-export.ts:28,92`). Should the cost report CSV start with the same mark? | Yes. It's one invisible character at the start of the file, the same fix the workspace export uses, and only admins downloading from Downloads get this CSV. |

If Q2, Q3 or Q5 is "no", drop §6.6, §6.7 or §6.3 item 3, with its test (T14, T15 or T16) and, for Q5, the `BOM \+` regex edit. The rest is unaffected.

## 3. Verified current state (2026-11-12, `main` at `a80ad8b`; the files below are unchanged on `reminder-capacity` at `44c01e9`)

### 3.1 The one query
- `getDetailedCostReportData(startDate, endDate, contractId?)` in `src/server/internal/reports.ts:37-110`. Internal, with no guard of its own (comment at `:32-35`).
- It selects from `timesheet_entries` (`:77`), joined as follows:
  - **inner** joins to `users` (`:78`), `clins` on `timesheet_entries.clin_id` (`:79`) and `contracts` (`:80`);
  - a left join to `slins` (`:81`);
  - the cost-basis lateral and its labor category (`:83-84`, from `src/server/internal/cost-basis.ts:62-92`, alias `:95-96`).
- The latest-revision subquery (`:49-58`) uses the cell identity `COALESCE(charge_code_id, indirect_code_id, clin_id)`.
- No `GROUP BY`: **one output row per latest-revision entry**. Indirect entries have no `clin_id`, so the inner join drops them; this is the existing behaviour and is unchanged.
- Order: `contracts.name, clins.clin_number, users.full_name, timesheet_entries.entry_date` (`:86`). Two entries for one employee, CLIN and day (two charge codes) have no defined order between them today.
- `CostReportEntry` (`:8-27`) is exported and has 15 fields. The row mapper is at `:88-109`.

### 3.2 Its three consumers
| Consumer | File | Guard | How rows are written |
|---|---|---|---|
| Excel, detailed | `src/app/api/reports/cost-report-xlsx/route.ts:39-51` → `generateCostReportExcel` in `src/lib/reports/cost-report-excel.ts:10-92` | `getDetailedCostReport` → `requireAdmin()` (`src/server/actions/reports.ts:207-214`) | Explicit 11-value arrays (`:49-61`); title and subtitle merged `A1:K1` / `A2:K2` (`:23`, `:29`); totals row (`:67-72`), unpriced row (`:74-75`) and rates note (`:76`); 11 widths (`:79-82`); number formats on columns 8, 10 and 11 (`:85-87`). |
| CSV | `src/app/api/reports/cost-report-csv/route.ts:26-58` | Same action, `requireAdmin()` | `generateCsv(data, columns)` (`:36-49`, 12 columns); footer with the unpriced line and the rates note (`:51-52`). `generateCsv` writes `null`/`undefined` as `''` and escapes every field (`src/lib/reports/csv-generator.ts:14`, `src/lib/csv/escape.ts:9-17`: RFC 4180 plus the formula guard). |
| `GET /api/v1/costs` | `src/app/api/v1/costs/route.ts:40-49` | `handleApiRequest` (API key) | `apiResponse(data, { total, unpricedHours })`: **the rows as returned**, so any new field on `CostReportEntry` appears in the JSON. |

`/api/reports/cost-report-xlsx?format=summary` (the Hours summary) uses `getEmployeeSummaryReport` and `generateEmployeeSummaryExcel`, not this query (`route.ts:28-38`). It's out of scope and must not change.

### 3.3 Charge codes and Class
- `charge_codes` (`src/db/schema.ts:276-292`) has these columns:
  - `code` varchar(100), unique;
  - `class_id` → `cost_classes.id`, `ON DELETE SET NULL`, nullable;
  - `clin_id`, not null;
  - `is_active`.
- `cost_classes` (`:264-270`) has `name` varchar(255), unique, and `is_active`. Nothing in the app deletes a Class; only `src/db/clear-tenant-data.ts:28` does, when resetting a workspace.
- Admins can change a code's `code` text and its Class at any time, even after it's used (`src/server/actions/charge-codes.ts:146,151`). Its CLIN and SLIN can't change once used (comment `:156-158`, enforced `:162-169`). That's why entry `clin_id` still matches the code's CLIN.
- `timesheet_entries.charge_code_id` is nullable (`schema.ts:334`). It's null for:
  - indirect entries;
  - **imported past hours**: the import writes `clin_id` / `indirect_code_id` only (`src/server/actions/migration.ts:118-119,176-177`);
  - older CLIN-only entries.
- Class is not stored on entries.
- Local demo (`tenant_acme`, checked 2026-11-12):
  - 7 charge codes, every one with a Class ("Government Services" or "R&D Programs"; `DISA-0002` is "R&D Programs");
  - `NAVAIR-0001-ONSITE` and `NAVAIR-0001-TELEWORK` share NAVAIR CLIN 0001;
  - about 2,600 direct entries (it grows as the demo's dates move), all with a charge code, none imported (`NAVAIR-0001-TELEWORK` and `DISA-0002` have no entries), plus about 175 indirect entries (no charge code; excluded from this report); none whose CLIN or SLIN differs from its code's.

### 3.4 Other readers of these files and types
- Tests:
  - `src/__tests__/unit/charge-code-cost-rules.test.ts:174-207`: builds a `CostReportEntry` with a full object literal, and reads the unpriced row's hours at **index 9**;
  - `src/__tests__/unit/report-routes.test.ts`: mocks `getDetailedCostReport` with partial rows;
  - `src/__tests__/unit/cost-basis.test.ts:243-252`: a static check that `cost-report-excel.ts` and the CSV route contain `CURRENT_RATES_NOTE`;
  - `src/__tests__/integration/cost-basis.test.ts`, `dated-rates.test.ts`, `dated-rates-d3.test.ts`, `calendar-dates-d9.test.ts`, `report-routes.test.ts` and `costs-api.test.ts`: call the query or routes and use `toMatchObject` or specific fields, so an added field doesn't break them.
- Docs in the app: the "Copy your API key" dialog describes the cost API's fields (`src/app/(app)/settings/api-keys/ApiKeysClient.tsx:257-268`). The Contract costs row on Downloads describes the report (`src/app/(app)/admin/reports/ReportsClient.tsx:195-199`).
- No script, seeder or cron reads `CostReportEntry` or the two routes (`git grep`, 2026-11-12).

## 4. External behaviour (verified from source)

### 4.1 ExcelJS (installed 4.4.0)
- `Value.getType` (`node_modules/exceljs/lib/doc/cell.js:1062-1094`) types a JS `string` as `Cell.Types.String`. A formula needs an object with `formula`. So a charge code or Class name that starts with `=`, `+`, `-` or `@` is written as **text**, and Excel won't evaluate it. No extra guard is needed for Excel.
- `null` and `undefined` become empty cells. This blueprint still writes `''` for blanks, to match the existing `slinNumber ?? ''` (`cost-report-excel.ts:54`).
- `mergeCells('A1:M1')` merges the 13 columns, like the current `A1:K1`. `getColumn(n).numFmt` formats the whole column, including the header, the totals rows and the merged title (a merged range shares one style, so `A1` picks up a column format too). It has no visible effect on text, and it's the current behaviour.

### 4.2 CSV escaping (`src/lib/csv/escape.ts`)
`escapeCsvField` prefixes `'` to values starting with `= + @`, tab, CR, or `-` (unless the value is a plain number). It quotes values containing a comma, quote, LF or CR. `generateCsv` applies it to every header and value. The footer lines are written raw (`cost-report-csv/route.ts:52`), so the new note line goes through `escapeCsvField` (§6.3).

### 4.3 Drizzle
`alias(table, 'name')` from `drizzle-orm/pg-core` is already used in this module for `cost_lc` (`cost-basis.ts:3,95`). `leftJoin` makes the selected columns nullable in the result type. The cost-basis lateral refers to `charge_codes` only inside its own subquery, under the alias `dr_cc_start` (`src/server/internal/labor-rates.ts:77`). An outer join under a distinct alias can't clash with it.

### 4.4 Vercel
"The maximum payload size for the request body or the response body of a Vercel Function is 4.5 MB. The response body limit doesn't apply to streamed responses." Over it, Vercel returns 413 `FUNCTION_PAYLOAD_TOO_LARGE` (vercel.com/docs/functions/limitations, fetched 2026-11-12). Default duration 300 s.

## 5. Invariants that must not break
1. **Read-only.** No writes, no migrations, no change to `timesheet_entries` (append-only, DCAA). Revisions, reason codes and the period lock are untouched.
2. **Latest revision.** The revision subquery (`reports.ts:49-58`) is unchanged.
3. **Same rows.** The new joins are **LEFT** joins on primary keys, so the row set and every hours and cost figure are unchanged: the same count, the same totals, the same unpriced hours. An inner join would silently drop imported and CLIN-only entries from a cost report.
4. **CLIN from the entry.** Contract, CLIN and SLIN still come from the entry's denormalized `clin_id` / `slin_id`, never from the charge code.
5. **Guards unchanged.** Excel and CSV stay admin-only through `requireAdmin()`; the API stays API-key-only. The query stays guard-free and internal. No new route or action.
6. **Tenancy.** The query uses the workspace's `getDb()` as today.
7. **Additive API.** No existing field is removed, renamed or retyped. `chargeCode` and `className` are **always present** on each row: a string, or `null`.
8. **Out-of-scope outputs unchanged.** The Hours summary Excel, Cost by pay period, the Unpriced hours report, the PDF and the workspace export produce byte-identical structure.
9. **Formula safety.** CSV values and the note go through `escapeCsvField`; Excel cells are strings (§4.1).
10. **Calendar dates.** `entryDate` stays a `YYYY-MM-DD` string.

## 6. Design

### 6.1 The query (`src/server/internal/reports.ts`)
1. Imports: add `chargeCodes`, `costClasses` (from `@/db/schema`) and `alias` (from `drizzle-orm/pg-core`).
2. Module constants:
   ```ts
   const reportChargeCode = alias(chargeCodes, 'report_cc');
   const reportClass = alias(costClasses, 'report_class');
   ```
3. `CostReportEntry` gets two fields, placed after `slinNumber`, each with a comment citing this blueprint:
   ```ts
   /** feature-plan-excel-cost-report.md E2/E4: the entry's charge code, or null (imported history, CLIN-only). */
   chargeCode: string | null;
   /** E3: the charge code's Class today (not stored per entry); null with no charge code or no Class. */
   className: string | null;
   ```
4. Select: `chargeCode: reportChargeCode.code` and `className: reportClass.name`.
5. Joins, directly after the `slins` left join and before the lateral:
   ```ts
   .leftJoin(reportChargeCode, eq(timesheetEntries.chargeCodeId, reportChargeCode.id))
   .leftJoin(reportClass, eq(reportChargeCode.classId, reportClass.id))
   ```
   Both **must** be `leftJoin` (invariant 3).
6. Order becomes `contracts.name, contracts.id, clins.clinNumber, users.fullName, users.id, timesheetEntries.entryDate, reportChargeCode.code, timesheetEntries.id`. The two `id` keys after the names keep two contracts, or two employees, with the same name in separate groups instead of interleaved by date. The code orders two codes on one CLIN and day (Postgres puts nulls last ascending), and the entry id makes any remaining tie deterministic. For distinct names the visible order is unchanged.
7. Mapper: `chargeCode: row.chargeCode ?? null` and `className: row.className ?? null`.
8. No filter on `is_active` for either table: a deactivated code or Class still labels the hours it covered (the same rule as deactivated labor categories, `cost-basis.ts:20-21`).
9. Update the doc comment's "Each row = …" line (`:30`), and the matching line on the server action (`src/server/actions/reports.ts:205`), to say one row per latest-revision entry, labelled with its charge code and Class.

### 6.2 Excel (`src/lib/reports/cost-report-excel.ts`, `generateCostReportExcel` only)
1. Headers become 13 values:
   `'Employee', 'Contract', 'Contract #', 'CLIN', 'SLIN', 'Charge Code', 'Class', 'LCAT Code', 'LCAT Title', 'Rate ($/hr)', 'Date', 'Hours', 'Cost ($)'`.
2. Data rows: after `entry.slinNumber ?? ''`, insert `entry.chargeCode ?? ''` and `entry.className ?? ''`.
3. Title and subtitle merges: `A1:M1` and `A2:M2`.
4. Totals row: `'TOTALS'`, then **10** `''`, then hours, then cost (hours in column 12, cost in column 13).
5. Unpriced row: the label, then **10** `''`, then the unpriced hours, then `''` (hours in column 12).
6. After the existing rates-note row, add one row: `[CURRENT_CLASS_NOTE]`, with the same italic grey font as the rates note.
7. Widths: insert `{ width: 22 }, { width: 22 }` after the SLIN width (13 entries).
8. Number formats: `getColumn(10)` currency (rate), `getColumn(12)` `'#,##0.00'` (hours), `getColumn(13)` currency (cost). Remove the old 8, 10 and 11 assignments. Columns 8 ("LCAT Code") and 11 ("Date") are now text columns and must not keep a number format.
9. `generateEmployeeSummaryExcel` (same file) is **not touched**.

### 6.3 CSV (`src/app/api/reports/cost-report-csv/route.ts`)
1. After `{ key: 'slinNumber', header: 'SLIN' }`, insert `{ key: 'chargeCode', header: 'Charge Code' }` and `{ key: 'className', header: 'Class' }` (14 columns; Cost Basis stays last).
2. Footer: append the note as a third line, escaped:
   ```ts
   const footer = `\nUnpriced hours (no applicable labor category; no cost),${unpriced}\n${CURRENT_RATES_NOTE}\n${escapeCsvField(CURRENT_CLASS_NOTE)}\n`;
   ```
   (`escapeCsvField` from `@/lib/csv/escape`.) The note contains a comma, so this line comes out quoted (`"Class shows …, including on past dates."`); that's correct CSV. The existing static test regex on the unpriced line and on `new NextResponse(csv + footer,` still matches.
3. **(Only if Q5 is yes.)** The body starts with a UTF-8 byte-order mark, as the workspace export does: `new NextResponse(BOM + csv + footer, …)` with `const BOM = '\uFEFF';` (written as the escape, so it's visible in review). Update the static regex in `charge-code-cost-rules.test.ts:205` from `new NextResponse\(csv \+ footer,` to `new NextResponse\(BOM \+ csv \+ footer,`. The `Content-Type` stays `text/csv`.

### 6.4 `/api/v1/costs`
No code change: the rows carry the fields. The route's comment block (`:46-47`) gets one line noting E1 (additive `chargeCode` / `className`).

### 6.5 The note constant (`src/lib/cost-labels.ts`)
```ts
/** feature-plan-excel-cost-report.md E3 (Q4): Class isn't stored per entry, so the cost report shows each code's Class today. */
export const CURRENT_CLASS_NOTE = 'Class shows the current Class of each charge code, including on past dates.';
```
Plain ASCII on purpose (Q4): it must read correctly in a CSV opened by Excel, with or without the Q5 mark.

### 6.6 API key dialog (only if Q2 is yes) (`ApiKeysClient.tsx`)
After the dated-rates paragraph (`:265-268`), add one `<Text size="sm" c="dimmed">` paragraph with the Q2 sentence, using `<Code>` for the field names, and a `{/* feature-plan-excel-cost-report.md E1 */}` comment.

### 6.7 Downloads description (only if Q3 is yes) (`ReportsClient.tsx:198`)
Replace the sentence with the Q3 text. No other change to the row.

## 7. States
This change has no state: it's a read-only query plus three formatters. Each row has one of these label combinations, all covered by tests (§11):

| Entry | `chargeCode` | `className` | Excel/CSV cells |
|---|---|---|---|
| Charge code with a Class | code text | Class name | both filled |
| Charge code with no Class | code text | `null` | Class blank |
| Charge code whose Class is inactive | code text | Class name | both filled |
| Inactive charge code | code text | its Class or `null` | as above |
| No charge code (imported past hours, CLIN-only) | `null` | `null` | both blank |
| Indirect (leave, overhead) | n/a: not in this report (inner join on CLIN, unchanged) | | |

## 8. Failure modes
| Case | What happens | Why it's safe |
|---|---|---|
| A join written as inner instead of left | Imported and CLIN-only hours vanish from the cost report; totals drop | Caught by T3 and T4 (row count and totals with a CLIN-only entry). |
| A charge code row deleted | Can't happen in the app: the entry FK has no cascade and only workspace reset deletes codes. If it did, the left join gives `null`/blank. | Left join. |
| A Class deleted | `charge_codes.class_id` is set to null by the FK; the report shows blank Class | Left join; matches E3 (today's Class). |
| An admin changes a code's Class or code text, then re-downloads a past range | The new values show on past rows | That's E3, stated by the note in the file. T5 proves it. |
| A code or Class name starting with `=`, `+`, `-` or `@` | CSV: prefixed with `'`. Excel: stored as text. | §4.1, §4.2; T10. |
| A Class name with a comma or quote (`R&D, Programs`) | CSV quotes it | `escapeCsvField`; T10. |
| Two charge codes on one CLIN, one employee, one day | Two rows, now distinguishable, in code order | T6. |
| A concurrent edit of a code while the report runs | One statement, so it reads one consistent snapshot | Postgres statement-level snapshot. |
| A code that looks like a number or date (`0001`, `3-15`) | Excel may reformat it when opening the CSV, as it already does with CLIN `0001` today. The Excel file stores it as text, so it's unaffected. | Existing CSV behaviour; recorded, not changed. |
| A retried download | Same output; nothing is written | Read-only. |
| The response over 4.5 MB | Vercel returns 413; the Downloads page shows its generic error | Existing limit; this change adds about 30% to CSV size. Q1, §9. |

## 9. Platform limits
- **Query cost:** two left joins on primary keys (`charge_codes.id`, `cost_classes.id`), one per row. Negligible beside the existing per-row lateral.
- **Response size** (Vercel 4.5 MB, §4.4). Measured on the demo data (2026-11-12, `tenant_acme`, 2,469 rows):
  - an API JSON row averages about 375–420 bytes today, and about 440–480 with the two fields;
  - a CSV row averages about 110 bytes, and about 140–145 with them.

  (Lead's estimate and pre-mortem reviewer's measurement; the ranges give the same conclusions.)

  | Output | Rows that fit in 4.5 MB today | With this change |
  |---|---|---|
  | `/api/v1/costs` (JSON, up to 366 days) | ~10,700 | ~9,400 |
  | CSV (no range cap) | ~41,000 | ~31,000 |
  | Excel (zip-compressed) | well over 31,000 | well over 31,000 |

  The demo has about 350 rows per employee per year. So the API already passes the limit for a full year at about 30 people, and the CSV at about 90 people after this change (about 120 before). **This is an existing limit, not one this change creates; it's question Q1.** The blueprint doesn't change it.
- **Memory:** ExcelJS builds the workbook in memory, as today. Measured by the pre-mortem reviewer with the current 11 columns: about 910 MB at 50,000 rows, still climbing, so the default 2 GB is reached at roughly 100,000 rows. The two new columns add about 18% more cells. That's an existing limit too, folded into Q1.
- **Duration:** unchanged; far under 300 s.

## 10. Blast radius

### 10.1 Changed
| File | Change |
|---|---|
| `src/server/internal/reports.ts` | §6.1 |
| `src/lib/reports/cost-report-excel.ts` | §6.2 (`generateCostReportExcel` only) |
| `src/app/api/reports/cost-report-csv/route.ts` | §6.3 |
| `src/app/api/v1/costs/route.ts` | Comment only (§6.4) |
| `src/server/actions/reports.ts` | Doc comment only (§6.1 item 9) |
| `src/lib/cost-labels.ts` | `CURRENT_CLASS_NOTE` (§6.5) |
| `src/app/(app)/settings/api-keys/ApiKeysClient.tsx` | §6.6, only if Q2 is yes |
| `src/app/(app)/admin/reports/ReportsClient.tsx` | §6.7, only if Q3 is yes |
| `src/__tests__/unit/charge-code-cost-rules.test.ts` | The `entry()` factory gets `chargeCode: null, className: null`; the unpriced-row read moves from index 9 to **11**; if Q5 is yes, the `new NextResponse(` regex gains `BOM \+ ` (§6.3 item 3). Nothing else in it changes. |
| `src/__tests__/unit/cost-report-csv.test.ts` | **New:** T10 (CSV half), T11, T16 |
| `src/__tests__/integration/costs-api.test.ts` | T8 (its own `x-forwarded-for` address, as every test there uses) |
| `src/__tests__/unit/cost-report-order-sql.test.ts` | **New:** T17 |
| New and extended tests | §11 |

### 10.2 Checked, unchanged
- `src/app/api/reports/cost-report-xlsx/route.ts`: it passes the rows through to the formatter.
- `generateEmployeeSummaryExcel`, `getEmployeeSummaryReport`, `period-cost-excel.ts`, `unpriced-excel.ts`, `timesheet-pdf.tsx`, `timesheet-rows.ts`.
- The workspace export (`src/lib/export/allowlists.ts` already exports `charge_codes.class_id` and `cost_classes`).
- `cost-basis.ts` and `labor-rates.ts`; the static guard that only `cost-basis.ts` reads labor categories (the new joins read `charge_codes` / `cost_classes` only).
- Existing integration tests: they use `toMatchObject` or named fields, so an added field passes.
- Seeders, scripts and crons: no reader (§3.4).

### 10.3 For the lead after the merge, not the dev
- PRODUCTION-DEPLOY.md Phase 15: mark the Excel cost report row done, and correct "PDF already does" to "the PDF shows the charge code".
- If Q1 is yes: add the streaming item to the build queue.

## 11. Required tests (each must fail without the change it proves)
Integration tests go in a new file, `src/__tests__/integration/cost-report-charge-codes.test.ts`, with its own `vi.mock('@/db', …)` returning `getTestDb()` as `integration/cost-basis.test.ts:21` does (the integration setup doesn't mock `@/db`), using `createTestUser`, `createTestIndirectCode`, `createTestContract`, `createTestClin`, `createTestChargeCode(clinId, { classId })` and `createTestCostClass` (`src/__tests__/integration/helpers.ts:113-133`), with entries inserted as in `report-routes.test.ts:91-94`. Unit tests extend the files named, except the CSV tests: `report-routes.test.ts` mocks `@/lib/reports/csv-generator` for the whole file (`:27`), so T10's CSV half and T11 go in a **new** file, `src/__tests__/unit/cost-report-csv.test.ts`. It mocks `getDetailedCostReport` (`@/server/actions/reports`), `checkReportRateLimit` (to return `null`), and, exactly as `report-routes.test.ts:16,23` does, `server-only` and `@/lib/session` (with an `AuthorizationError` class): the route's `guardErrorResponse` pulls in `@/lib/session`, which pulls in a `server-only` module that throws under vitest. It keeps the real `generateCsv` and reads `await res.text()` (T11) or the raw bytes (T16).

| # | Scenario | Where | Asserts | Fails without |
|---|---|---|---|---|
| T1 | Code with a Class | integration, `getDetailedCostReportData` | the row has `chargeCode` = the code text and `className` = the Class name | §6.1 select and joins |
| T2 | Code with no Class | integration | `chargeCode` = code, `className` = `null` (strictly `null`, present as a key) | §6.1 Class left join (Drizzle already returns `null` for a missing join, so the mapper's `?? null` is a safety net, not a revert target) |
| T3 | CLIN-only entry (`charge_code_id` null, `source: 'migration'`, `importBatchId` null is fine) next to a coded entry, plus an indirect entry | integration | 2 rows (the indirect entry is absent, as today); the CLIN-only row has both fields `null`; its hours and cost match the existing values | left join on `report_cc` (mutate to `innerJoin` → 1 row) |
| T4 | Totals unchanged | integration, same data as T3, which must include at least one **priced** row (a labor category and assignment, as in `cost-basis.test.ts:80-82`) so the cost total isn't zero | Σ `totalHours`, Σ `totalCost` and Σ `unpricedHours` equal the values computed from the inserted entries | left joins (an inner join changes the sums) |
| T5 | E3: Class and code text changed after the entry | integration | change the code's `class_id` to a second Class and its `code` text, then re-run: the row shows the new Class name and the new code text | reading both from the code at query time |
| T6 | Two codes, one CLIN, one employee, one day | integration | codes `T6-ALPHA` and `T6-BRAVO` (letters only, so collation can't reorder them), `T6-BRAVO`'s entry inserted first: 2 rows, the same CLIN, `chargeCode` = `T6-ALPHA` then `T6-BRAVO` | §6.1 order tiebreaker. The revert check (remove the tiebreaker) relies on Postgres returning ties in insert order, which isn't guaranteed; if it passes by chance, say so in the report rather than forcing it. |
| T7 | Inactive code and inactive Class (set `is_active = false` with an UPDATE; `createTestCostClass` has no option for it) | integration | both still labelled | no `is_active` filter |
| T8 | `/api/v1/costs` | integration, extend `costs-api.test.ts` | for a coded row with a Class and a CLIN-only row: `'chargeCode' in row` and `'className' in row` for both; values as in T1/T3; `meta` equals `{ timestamp: expect.any(String), total, unpricedHours }` as before (`apiResponse` always adds `timestamp`, `src/lib/api-auth.ts:165-167`) | §6.1 (fields on the rows) |
| T9 | Excel layout | unit, extend `charge-code-cost-rules.test.ts` (it already loads the workbook) | the header row equals the 13 headers in §6.2 exactly; a data row has the code in column 6 and the Class in column 7; a `null` code gives `''`; TOTALS hours and cost in columns 12 and 13; UNPRICED hours in column 12; the row after the rates note equals `CURRENT_CLASS_NOTE`; `A1` is merged through `M1`; `getColumn(10/12/13).numFmt` are `'$#,##0.00'`, `'#,##0.00'`, `'$#,##0.00'`; `getColumn(8).numFmt` and `getColumn(11).numFmt` are unset | §6.2 (each item) |
| T10 | Formula and comma safety | unit: Excel via the workbook in `charge-code-cost-rules.test.ts`; CSV via the route in the new `cost-report-csv.test.ts` | code `=1+1` and Class `R&D, "Labs"`: CSV fields `'=1+1` and `"R&D, ""Labs"""`; the Excel cell `.type` is `ExcelJS.ValueType.String` and its `.value` is `'=1+1'` | §6.3 columns via `generateCsv`; Excel string cells |
| T11 | CSV layout | unit, new `cost-report-csv.test.ts` | the first line (after the Q5 mark, if any) equals the 14 headers in §6.3 exactly; a row with `chargeCode: null` has empty fields in positions 6 and 7; the last non-empty line equals `escapeCsvField(CURRENT_CLASS_NOTE)` (quoted, because the note has a comma) | §6.3 |
| T12 | The note text | unit, static | `CURRENT_CLASS_NOTE` equals the Q4 text exactly; `cost-report-excel.ts` and the CSV route both contain `CURRENT_CLASS_NOTE` | §6.5 |
| T13 | Hours summary unchanged | unit, `employee-summary-excel.test.ts` | its headers stay `['Employee','Contract','Contract #','CLIN','Total Hours','Total Cost ($)']` for an admin and without the last column for a supervisor (add the assertion if it's not already exact) | guards against editing the wrong function |
| T14 | (Q2 yes) API dialog | unit, static on `ApiKeysClient.tsx` | contains `<Code>chargeCode</Code>` and `<Code>className</Code>` | §6.6 |
| T15 | (Q3 yes) Downloads text | unit, static on `ReportsClient.tsx` | contains the Q3 sentence | §6.7 |
| T16 | (Q5 yes) Byte-order mark | unit, `cost-report-csv.test.ts` | read **bytes**, not text: `const b = Buffer.from(await res.arrayBuffer())`; `b.subarray(0, 3)` equals `EF BB BF` and `b.subarray(3, 11).toString()` is `'Employee'` (exactly one mark); for the 422 "no hours" response, `b[0] === 0x7B` (`{`). (`Response.text()` silently drops a leading mark, so a text check can't see it.) | §6.3 item 3 |
| T17 | Order keys | unit, new `src/__tests__/unit/cost-report-order-sql.test.ts`, using the pattern in `src/__tests__/unit/period-flags-sql.test.ts:10-26` (`drizzle.mock()` plus a Proxy that records the builder on `then`, `vi.mock('@/db', () => ({ getDb: async () => db }))`, `vi.mock('server-only')`), then `.toSQL()` | the rendered ORDER BY lists, with quoted identifiers, `"contracts"."name", "contracts"."id", "clins"."clin_number", "users"."full_name", "users"."id", "timesheet_entries"."entry_date", "report_cc"."code", "timesheet_entries"."id"` in that order | §6.1 item 6 (pins what T6's chance-based revert check can't) |

**Revert checks.** For each of T1–T12, T14–T17, the dev names the one targeted edit that makes the test fail (for example `leftJoin(reportChargeCode` → `innerJoin(reportChargeCode` for T3 and T4) and confirms the failure, as in 4b. T13 is a regression guard (nothing in this change makes it pass), so it has no revert check.

## 12. Verification
1. Dev and lead gates: `npx tsc --noEmit`, `npm run lint` (0 errors), `npm run test`, `npm run test:tz`, `npm run db:safety`.
2. Integration (product owner's machine, and the lead):
   ```bash
   REQUIRE_CONTROL_PLANE_TESTS=1 CONTROL_PLANE_DATABASE_URL="$(grep -h '^CONTROL_PLANE_DATABASE_URL=' .env.local .env 2>/dev/null | head -1 | cut -d= -f2-)" ENCRYPTION_KEY="$(grep -h '^ENCRYPTION_KEY=' .env.local .env 2>/dev/null | head -1 | cut -d= -f2-)" TZ=America/New_York npm run test:integration
   ```
   Check the skipped count (about 1 file is normal).
3. `npm run build` (Turbopack). No migration, so no `demo:local` re-seed is needed for the build; the browser checks re-seed at the start and end.
4. Browser checks: `EXCEL-COST-REPORT-BROWSER-CHECKS.md` (step by step; the lead rehearses it against the finished branch before the merge gate).

## 13. Hand-off rules (in addition to `BLUEPRINT-STANDARD.md` §3)
1. Write the impact analysis (`EXCEL-COST-REPORT-IMPACT-ANALYSIS.md`, uncommitted) before coding, and stop for the lead's review.
2. Don't touch `generateEmployeeSummaryExcel`, the Hours summary, Cost by pay period or the PDF.
3. Both new joins are `leftJoin`. No `is_active` filters.
4. Copy is exact: headers, the note, and the Q2/Q3 sentences only if the product owner said yes.
5. Commit on `excel-cost-report` only; never push.

## 14. Pre-mortem log
- **Round 1** (2026-11-12, two independent reviewers: data path; outputs, tests and blast radius). **1 HIGH, 4 MEDIUM (three found by both), 13 LOW. All fixed in v2.**
  - **HIGH:** the proposed note's curly apostrophe would show as "â€™" in every CSV opened in Excel, because the CSV has no UTF-8 byte-order mark. The note is now plain ASCII (Q4), and the missing mark, which already garbles the "—" on unpriced rows, is question Q5.
  - **MEDIUM:**
    - T10/T11 couldn't read a real CSV body, because `report-routes.test.ts` mocks the CSV generator. They now go in a new test file.
    - T11 expected the unquoted note, but the note has a comma. It now expects `escapeCsvField(CURRENT_CLASS_NOTE)`, and §6.3 says so.
    - T8 forgot `meta.timestamp`.
    - §9 missed Excel memory (about 100,000 rows to 2 GB). It's now in §9 and Q1.
  - **LOW, fixed:**
    - Q2's sentence covers a code with no Class.
    - Columns 8 and 11 lose number formats (T9).
    - §4.1 notes that the merged title shares the column format.
    - The order gains `timesheet_entries.id` as the last key.
    - T6 uses fixed letter codes and notes its revert check can pass by chance.
    - T5 covers a code rename.
    - T3 includes an indirect entry.
    - T7 says how to deactivate a Class.
    - T2's revert target is corrected.
    - T13 is exempt from revert checks.
    - §3 references are corrected, and the server action's stale comment is added.
    - §9 numbers are given as ranges.
    - §8 notes that Excel reformats number-like codes in a CSV.
  - **The checks draft** gained a blank-Class step (and E4's CLIN-only entry was already set up with a tested psql insert).
- **Round 2** (2026-11-12, two fresh reviewers, same split). **No HIGH. 2 MEDIUM (one found by both) and 10 LOW. All fixed in v3.**
  - **MEDIUM:**
    - T16 read the CSV with `res.text()`, which silently drops a leading byte-order mark, so the test would fail on correct code and could push the dev into shipping a double mark. T16 now reads raw bytes: exactly one `EF BB BF`, then `Employee`; the 422 body starts with `{`.
    - The new `cost-report-csv.test.ts` wouldn't load with only two mocks: the route's error helper pulls in a `server-only` module. It now also mocks `server-only` and `@/lib/session`, as `report-routes.test.ts` does.
  - **LOW, fixed:**
    - Q1's API row count (about 10,700 today, 9,400 after).
    - The integration file needs its own `@/db` mock, `createTestUser` and `createTestIndirectCode`; T8 uses its own `x-forwarded-for`.
    - T3/T4 include a priced row, so the cost total proves something.
    - The order keeps same-named employees and contracts grouped (`users.id`, `contracts.id` after the names), and new T17 pins the ORDER BY.
    - §3 numbers and references corrected (demo counts, indirect entries, the lateral's lines, `ReportsClient.tsx:198`).
    - The checks: dollars, and two decimals for hours, as the format check; a firm unpriced-row step for Q5; Jane's CLIN-only row is priced; the `Copy key` button named.
  - **Confirmed sound:**
    - the rendered SQL and row/hour totals are unchanged against the demo;
    - the Excel layout round-trips with ExcelJS 4.4.0;
    - the byte-order mark reaches the saved file (`downloadFile` uses `res.blob()`);
    - every checks label matches the code;
    - `curl --resolve` reaches the `acme` tenant;
    - nothing unlisted breaks.
- **Confirmation pass** (2026-11-12, one fresh reviewer, whole of v3). **The blueprint: no HIGH or MEDIUM.** The checks file: **1 MEDIUM**.
  - **MEDIUM (checks file):** step C, the only manual proof of E3, used `DISA-0002`, which has no time entries in the demo (nor does `NAVAIR-0001-TELEWORK`; `scripts/seed-full.ts` never writes them). Step C now changes and then clears `DISA-0001`'s Class (492 entries from 2025-12-01). The lead verified the counts against `tenant_acme` (`DISA-0001` 492, `DISA-0002` 0, `NAVAIR-0001-TELEWORK` 0), and step A no longer mentions TELEWORK.
  - **LOW, fixed in v3.1:**
    - T17 cites the `period-flags-sql.test.ts` `toSQL()` pattern, has its own file in §10.1, and expects quoted identifiers.
    - Checks D.3 shows Hours `2.00` in Excel (the CSV shows `2`).
    - §2 says which test and regex edit to drop for a "no".
  - **Confirmed sound:**
    - the new ORDER BY returns the same rows, hours and visible order on the demo, and no test depends on tie order;
    - the CSV test mocks are sufficient;
    - T16's byte check is right;
    - the ExcelJS round trip;
    - every file:line it checked;
    - both answers to Q2, Q3 and Q5 are covered consistently;
    - guards, tenancy and read-only are unchanged.

