# Large report responses: stream the cost CSV and `/api/v1/costs`; cap the Excel download (build queue 5b)

> **Status:** **FINAL v3.1**, 2026-11-13, lead architect. **Pre-mortem CLEAN**: round 1 (0 HIGH, 8 MEDIUM) and round 2 (0 HIGH, 2 MEDIUM) were fixed, and a confirmation pass found only LOWs, now written in (§14). **Awaiting the product owner's answers to Q1–Q6** (§2) before the dev hand-off.
>
> **Branch:** `large-report-responses`, from `main` at `1d44b35` (after the Excel cost report, PR #29). This file and its checks file are committed there first. The §3 references were checked on `2631621` (only docs changed since `1d44b35`).
>
> **Source:**
> - `LAUNCH-TRACKER.md` build queue 5b, approved 2026-11-13.
> - `feature-plan-excel-cost-report.md` Q1, accepted 2026-11-13: "stream the CSV and the API response (streamed responses are exempt from the size limit) and decide a range or row cap for the Excel download."
>
> **Standard:** `BLUEPRINT-STANDARD.md`.

## 1. Goal and scope

**Goal.** The detailed cost report can be too big to send. Three problems:
- **CSV and API size.** Vercel refuses a buffered function response over 4.5 MB with a 413. The cost CSV crosses that at about 31,000 rows, roughly a year for 100 people. `/api/v1/costs` crosses it at about 9,400 rows, roughly a year for 30 people (the API allows 366 days).
- **Excel memory.** The Excel file stays small, but building it takes about 1 GB of memory at 50,000 rows. A function has 2 GB, shared by every request running on that instance at the same time.
- **No cap.** Neither the CSV nor the Excel download has a date-range cap.

This item makes the CSV and the API stream their bodies, and puts a row cap on the Excel download.

**In scope**
1. A small shared helper that streams prepared text in chunks (§6.1).
2. The cost CSV route streams its body. The bytes are identical to today's (§6.2).
3. `/api/v1/costs` streams its JSON. The bytes are identical to today's apart from the `timestamp` value (§6.3).
4. The detailed cost Excel refuses more than **25,000 rows** (Q1) with a 422 and a message (Q2), before building the workbook (§6.4).
5. Only if Q4 is yes: `/api/v1/periods` and `/api/v1/timesheets/approved` use the same streamed JSON (§6.5).

**Out of scope**
- **What the reports contain.** Columns, rows, order, totals, notes and the byte-order mark stay the same; only how the body is sent changes.
- **The API's 366-day cap.** Unchanged.
- **A CSV cap (Q3).** The CSV is the way out for big reports, and its memory is measured as safe (§9).
- **Streaming rows from the database** (a cursor or keyset batches). See §6.6 for why not.
- **Excel streaming** (ExcelJS `WorkbookWriter`). The approved scope is a cap.
- **The Hours summary Excel, Cost by pay period, Unpriced hours and the PDF.** All are aggregated or bounded (§10.2).
- **The other `/api/v1` routes**, apart from Q4.
- **The per-period query loop in `/api/v1/timesheets/approved`** (one entries query per approved period, `route.ts:58-66`). Noted only; it fits 300 s at a year for 100 people (about 2,600 periods).

## 2. Questions for the product owner

| # | Question | Lead's recommendation |
|---|---|---|
| Q1 | **The Excel row cap.** How many rows should the detailed cost Excel allow? Measured peak memory to build it with today's 13 columns: about 270 MB at 10,000 rows, 610 MB at 25,000, and 1,020 MB at 50,000 (§9). Two downloads at the same moment can share one 2 GB instance. | **25,000 rows.** Two at once stay near 1.2 GB. That's about a year for 70 people (the demo averages about 350 rows per person per year), or more than two years for 30. A cap by date range instead would block small workspaces' "Contract to date" while still letting a large workspace run out of memory. |
| Q2 | **The message when the Excel is over the cap.** It shows in place in the Contract costs row, like "No hours recorded…". Proposed: "More than 25,000 rows match. Choose a shorter date range, or download the CSV." | **This text.** It matches the Audit trail CSV's existing wording ("More than 50,000 entries match. Choose a shorter date range.") and points to the CSV, which has no cap. |
| Q3 | **Should the CSV get a cap too?** Measured: the cost query returned 931,000 rows in 10–20 s on a copy of the demo scaled to a million entries, and a 500,000-row CSV peaks at about **650 MB** for one request (§9). At the demo's 350 rows per person per year, 100 people for 10 years is about 350,000 rows. The rate limit doesn't stop requests running at the same time, so the worst realistic instance has one such CSV, one Excel at the cap and the baseline: about 1.4 GB of 2 GB. | **No cap.** It's the way out of the Excel cap, and even that worst case fits. It stays a watch item in §9, timed at the staging rehearsal. |
| Q4 | **Found outside this item: two more API routes that build their whole body at once.** `/api/v1/timesheets/approved` requires dates but has no range cap; it nests every latest-revision entry (about 250 bytes each), so it passes 4.5 MB at about 17,800 entries, roughly 6 months for 100 people. `/api/v1/periods` has no date cap; called with no dates, 100 people on biweekly periods pass 4.5 MB after about 4 years (about 2 on weekly). With the §6.1 helper, each fix is a one-line switch plus a check. Include them? | **Yes, both.** Same cause, same fix, and the API is the hardest place to discover it later (a client just gets a 413). If no, they go on the Deferred list as watch items. |
| Q5 | Should the Downloads page warn about the Excel cap before anyone hits it (for example a line under Contract costs)? | **No.** The message appears in place when it applies, as "No hours recorded…" does, and few workspaces will reach it. |
| Q6 | **The premise can only be proven on Vercel (found in pre-mortem round 1).** Next.js already sends every Route Handler body through its stream pipe, even a plain string (`node_modules/next/dist/server/send-response.js:61-62`). Vercel's docs say "streamed responses" are exempt from 4.5 MB but don't say whether a one-chunk body sent that way counts. So today's CSV and API **may** already be exempt, or may not; nothing local can tell. | **Build it now.** It's small, it's the documented way to stay exempt, and it changes no output. Staging step 12.13 first measures `main` before 5b (a 413 or not) and then this item. The lead reports the result either way. |

If Q4 is no, drop §6.5, T15, the Q4 row in §10.1, and the Q4 parts of §12 item 4 and T16. If Q1 or Q2 gets a different value or text, only `src/lib/reports/limits.ts` and T12/T13 change.

## 3. Verified current state (2026-11-13, `large-report-responses` at `2631621`)

### 3.1 The one query
- `getDetailedCostReportData(startDate, endDate, contractId?)` is in `src/server/internal/reports.ts:48-131`. It's internal, with no guard of its own; callers authorize first (comment at `:40-47`).
- It loads every row into memory at once: one Drizzle select over postgres-js (`src/db/index.ts:1-2`), then a `rows.map` into `CostReportEntry` objects (`:107-130`).
- **Callers:**
  - `getDetailedCostReport` (`src/server/actions/reports.ts:208-215`, `requireAdmin()`) is used by the CSV route and the detailed Excel route;
  - `/api/v1/costs` (`src/app/api/v1/costs/route.ts:40`) calls it directly;
  - tests: `cost-report-order-sql.test.ts`, `cost-report-charge-codes.test.ts`, `costs-api.test.ts`, `dated-rates.test.ts`, `dated-rates-d3.test.ts`.
- **Not changed by this item.**

### 3.2 The cost CSV route (`src/app/api/reports/cost-report-csv/route.ts`)
- Rate limit, then a 400 for bad dates (`:16-26`).
- Inside one `try` (`:29`), commented "Generation is inside the try too (C15): a failure returns the JSON 500" (`:28`):
  1. the query (`:31-35`);
  2. the 422 for no hours (`:37-39`);
  3. `generateCsv(data, [14 columns])` (`:41-56`);
  4. the unpriced total (`:58`) and the footer (`:60`);
  5. `return new NextResponse(BOM + csv + footer, { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': … } })` (`:62-67`).
- `catch` → `guardErrorResponse` (`:68-70`).
- **The whole body is one string**, so Vercel treats it as a buffered response.

### 3.3 `generateCsv` (`src/lib/reports/csv-generator.ts:7-19`)
- It joins `[header, ...rows]` with `'\n'`, with no trailing newline. Fields go through `escapeCsvField`.
- **Callers:**
  - the cost CSV route;
  - `src/app/(app)/settings/import/pipeline.ts` and `ImportParts.tsx` (error-file downloads in the browser);
  - tests: `csv-generator.test.ts`, `cost-report-csv.test.ts`, `report-routes.test.ts` (mocks it at `:27`), `fix-round-1-small.test.ts`, `fix-round-2.test.ts`, `payroll-flsa.test.ts`.
- `csvToBlob` (`:23-25`) is client-only.

### 3.4 The Excel route (`src/app/api/reports/cost-report-xlsx/route.ts`)
- `format=summary` (`:28-38`) uses `getEmployeeSummaryReport`: aggregated rows (employee × contract × CLIN), approver-scoped.
- Otherwise it runs the detailed cost report: the query (`:41-45`), the 422 for no hours (`:47-49`), then `generateCostReportExcel` (`:50`).
- Then `new NextResponse(new Uint8Array(buffer), …)` (`:56-61`).
- `generateCostReportExcel` (`src/lib/reports/cost-report-excel.ts:10-95`) builds the whole workbook in memory, then calls `writeBuffer()`.
- **No row or range cap.**

### 3.5 `/api/v1/costs` and the API helpers
- **Route** (`src/app/api/v1/costs/route.ts`):
  - `GET` → `handleApiRequest(request, () => getCostReport(request))` (`:11-13`);
  - 400s for missing or bad dates, end before start, more than 366 days and a bad `contractId` (`:21-36`);
  - the query (`:40-44`), the unpriced total (`:49`), then `return apiResponse(data, { total: data.length, unpricedHours })` (`:50`).
- **`handleApiRequest`** (`src/lib/api-auth.ts:143-157`) runs auth and the handler in one `try`. Any throw becomes `apiError('Internal server error', 500)`, logged and sent to Sentry.
- **`apiResponse`** (`:161-175`) returns `JSON.stringify({ data, meta: { timestamp: new Date().toISOString(), ...meta } })` with status 200 and `Content-Type: application/json`. That's one string, so it's buffered.
- **Other `apiResponse` callers:**
  - `contracts` (`:42`), bounded by the contract count;
  - `employees` (`:27`), bounded by the 100-user cap;
  - `timesheets` (`:83`), paginated, `pageSize` ≤ 500;
  - **`timesheets/approved`** (`src/app/api/v1/timesheets/approved/route.ts:25-27` requires dates with no range cap; `:114` `apiResponse(results, { total: results.length })`) (Q4);
  - **`periods` (`:67-72`), unbounded with no dates (Q4).** Its row is `{ id, userId, employeeName, employeeEmail, periodStart, status, submittedAt, reviewedAt, reviewedBy, approvalSource, approvedBy, selfApproved }`, about 400 bytes as JSON.

### 3.6 The browser side (`src/lib/download.ts`)
- `downloadFile` fetches the URL (`:90-95`).
  - A 422 shows the route's JSON `error` in place (`:97`, via `jsonErrorOf` `:44-52`).
  - Otherwise it calls `await res.blob()` (`:103-108`). If that rejects, the message is "Couldn't reach the server. Check your connection and try again." (`NETWORK_ERROR`, `:8`). Then `saveBlob`.
- **A streamed body needs no change here.** `blob()` reads the whole stream. **Locally**, if the connection breaks before the end, the stream errors, `blob()` rejects, and no file is saved (reviewer probe of Next's own pipe: `fetch` rejected with "terminated"). **Through Vercel's proxy this is unverified** (§8, §12 step 5).
- The Contract costs row (`src/app/(app)/admin/reports/ReportsClient.tsx:122-131`) builds `/api/reports/cost-report-{xlsx,csv}?startDate&endDate[&contractId]`. Presets include "Contract to date", which can span years.

### 3.7 The existing streaming precedent: the Audit trail CSV (`src/app/api/reports/audit-csv/route.ts`)
- Everything request-bound is resolved first. A count gives a 422 at 0 or over 50,000 rows (`:45-46`).
- Then `new ReadableStream({ pull, cancel }, { highWaterMark: 0 })` (`:51-72`):
  - each `pull` enqueues one 1,000-row keyset batch;
  - errors go to `Sentry.captureException` + `controller.error` (`:64-67`);
  - it sets `export const maxDuration = 300` (`:16`).
- It checks `request.signal.aborted` before each database batch (`:54`), and **closes** the stream if so. This item doesn't copy that check (§6.1, item 4).
- The workspace export (`src/app/api/export/workspace/route.ts:45-57`) also streams (a zip).

### 3.8 Tests that read these routes' source text
- `src/__tests__/unit/charge-code-cost-rules.test.ts:203-209` ("CSV footer and v1 meta carry the total (static)") matches:
  - `/Unpriced hours \(no applicable labor category; no cost\),\$\{unpriced\}/` (CSV, kept);
  - `/new NextResponse\(BOM \+ csv \+ footer,/` (CSV, **must change**);
  - `/return apiResponse\(data, \{ total: data\.length, unpricedHours \}\);/` (v1, **must change**).
- `src/__tests__/unit/cost-basis.test.ts:243-251` requires the CSV route's source to contain `CURRENT_RATES_NOTE` (kept).
- `src/__tests__/unit/report-routes.test.ts:27` mocks the whole `@/lib/reports/csv-generator` module with only `generateCsv`. Its "a CSV generation failure → JSON 500" test (`:67-72`) depends on that mock (§10.1).
- `src/__tests__/unit/cost-report-csv.test.ts` (T10/T11/T16 from the Excel item) reads `res.text()` and `res.arrayBuffer()`. Both work on a streamed body.

## 4. External behaviour (verified from source)

### 4.1 Vercel (vercel.com/docs, fetched 2026-11-13)
- **Size limit** (`/docs/functions/limitations`, "Request body size"): "The maximum payload size for the request body or the response body of a Vercel Function is **4.5 MB**. The response body limit doesn't apply to streamed responses." Over it: `413 FUNCTION_PAYLOAD_TOO_LARGE`.
- **Streaming** is on by default for every Node.js function (the changelog "Streaming now enabled by default for all Node.js Vercel Functions", linked from `/docs/functions/streaming-functions`).
- **Duration** (same page): "For request handlers, this includes time spent processing the request and sending the response, including streamed responses." The default and Hobby maximum is 300 s (Pro: 800 s). Past it: `504 FUNCTION_INVOCATION_TIMEOUT`.
- **Memory:** 2 GB / 1 vCPU by default (Hobby maximum 2 GB; Pro up to 4 GB).
- **Fluid compute** (`/docs/fluid-compute`): "enabled by default for new projects" since 2025-04-23. "Multiple invocations can share the same physical instance (a global state/process) concurrently." **So concurrent downloads share one instance's memory.**

### 4.2 Next.js 16.2.6 (installed)
- A Route Handler may return `new Response(readableStream)`. The installed doc `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` ("Streaming") shows a `ReadableStream` built with `pull`.
- **Piping** (`node_modules/next/dist/server/pipe-readable.js`):
  - `pipeToNodeResponse` (`:115-138`) calls `readable.pipeTo(writer, { signal })`, where the signal comes from `createAbortController(res)`;
  - the writer waits for `drain` when `res.write` returns false (`:80-87`), so **backpressure reaches `pull`**;
  - if the readable **errors**, `pipeTo` aborts the writer, which calls `res.destroy(err)` (`:99-102`). The connection is cut before the chunked terminator, so the client sees a failed body, not a short complete one;
  - on a **client disconnect**, the abort signal fires and `pipeTo` **cancels** the readable (`cancel()` runs, and `pull` is not called again).
- **The abort signal** (`createAbortController`, `node_modules/next/dist/server/web/spec-extension/adapters/next-request.js:45-55`) aborts only on `close` before `writableFinished`, that is, when the client went away.
- **Every Route Handler body already goes through this pipe**, a string body included: `sendResponse` calls `pipeToNodeResponse(response.body, …)` (`node_modules/next/dist/server/send-response.js:61-62`). So locally today's responses are already chunked with no `Content-Length`. **The only difference this item makes is the number of chunks:** one today, many after. Whether Vercel's 4.5 MB check depends on that is undocumented (Q6).
- Nothing else in the path reads the whole body. Next's ISR branch (`build/templates/app-route.js:307-324`) does, but these routes are dynamic. Sentry 10.57.0's `wrapRouteHandlerWithSentry` reads only `response.status`, and `src/proxy.ts` only rewrites request headers (pre-mortem round 1).
- `export const maxDuration = 300` is the route segment option (installed doc `…/02-route-segment-config/maxDuration.md`).

### 4.3 Web streams (Node 22, undici)
- **One chunk for a string body.** `new Response(string).body` reads as **one** chunk, even at 10 MB (lead probe 2026-11-13: 1 chunk for a 10,000,000-character string). A stream built with `pull` gives one chunk per `enqueue`. **That difference is what the tests use to prove streaming** (T3, T6, T10).
- **Lazy pulls.** With `highWaterMark: 0`, `pull` runs only when a reader asks; nothing is enqueued before the first read.
- `Response.text()` drops a leading UTF-8 byte-order mark, so byte-level checks read `arrayBuffer()` (lesson from the Excel item).

## 5. Invariants that must not break
1. **Authorization first.** The admin guard (`requireAdmin` via `getDetailedCostReport`) and the API key check (`handleApiRequest`) run, and their failures are answered, **before** any byte of the body.
2. **Every failure gets a status code, never a partial file.** The query, the 422 checks, the totals and the encoding of every line happen **before** the `Response` is built. So any error there is still the JSON 500 (CSV: `guardErrorResponse`; API: `handleApiRequest`), exactly as today. Once streaming starts, the only work left is slicing prepared strings and encoding them to bytes. If the transfer itself breaks (client gone, platform timeout), Next cuts the body off rather than ending it cleanly (§4.2), so locally `downloadFile` saves nothing. On Vercel this is verified at staging step 12.13, before production (§8).
3. **Same bytes.**
   - The CSV body equals today's `BOM + generateCsv(data, COLUMNS) + footer`, byte for byte.
   - The API body equals today's `JSON.stringify({ data, meta: { timestamp, ...meta } })`, byte for byte, for the same timestamp.
   - Status and headers are unchanged: CSV `Content-Type: text/csv` plus the same `Content-Disposition`; API `Content-Type: application/json`, status 200.
   - The transport is unchanged too. Next already sends every route body chunked with no `Content-Length` (§4.2); only the number of chunks changes.
4. **DCAA, tenancy and data rules are untouched.** Read-only routes, the same query, the same tenant client (`getDb` / the API's tenant resolution), and calendar dates as plain `YYYY-MM-DD` strings.
5. **The 422 order in the Excel route:** no hours first, then the cap. An empty range keeps "No hours recorded…".
6. **The cap applies only to the detailed cost Excel**, never to `format=summary`, the CSV or the API.

## 6. Design

### 6.1 The streaming helper (new `src/lib/http/stream-text.ts`)
```ts
/** Streams head + items.join(separator) + tail, `batch` items per chunk, pulled on demand. Server-only use. */
export function streamJoined(parts: {
  head: string;
  items: readonly string[];
  separator: string;
  tail: string;
  batch?: number; // default STREAM_BATCH = 1_000
}): ReadableStream<Uint8Array>
```
1. **Output** is exactly `head + items.join(separator) + tail`, encoded with one `TextEncoder`. Chunks:
   - the head;
   - then one chunk per `batch` items: for every batch after the first, the separator, then that batch's items joined by the separator;
   - then the tail.
   - A chunk is never empty: an empty head or tail is skipped. Zero items means head then tail.
2. **Pull-driven:** `new ReadableStream({ pull, cancel }, { highWaterMark: 0 })`. `start` is absent, and nothing is enqueued until a reader pulls.
   - **Rule: every `pull` call either enqueues exactly one non-empty chunk or calls `controller.close()`.** It loops past an empty head or tail within the same call.
   - A `pull` that returns having done neither would hang the reader until `maxDuration` (reviewer probe).
   - After the tail it calls `controller.close()`.
3. **Errors:** `pull` wraps its work in `try/catch`. On a throw it calls `Sentry.captureException(err)` then `controller.error(err)`, as the precedent does (§3.7). Nothing here is expected to throw: the strings are already built.
   - Next then also reports "failed to pipe response" through `onRequestError` → `Sentry.captureRequestError` (`pipe-readable.js:127-136`, `app-route.js:421-431`, `src/instrumentation.ts`). The duplicate Sentry event is expected and harmless.
4. **Cancel:** `cancel()` sets a `done` flag; `pull` returns at once if `done`. There's **no** `request.signal` check. The precedent checks the signal only to skip database batches, and this stream has none. Next cancels the readable on disconnect (§4.2). And closing on a spurious abort would end a body cleanly while it was short, which is the one outcome invariant 2 forbids.
5. **Exports:** `streamJoined` and `STREAM_BATCH`. No other module imports `@sentry/nextjs` for this.

**State table (one stream)**

| State | `pull` | `cancel()` | A throw inside `pull` |
|---|---|---|---|
| START (nothing sent) | enqueue the head → ITEMS(0); if the head is empty, continue **in the same call** as ITEMS(0) | → DONE (`pull` is never called again) | Sentry, `controller.error` → ERRORED |
| ITEMS(i), i < n | enqueue `(i > 0 ? separator : '') + items[i..i+batch).join(separator)` → ITEMS(i + batch) | → DONE | Sentry, `controller.error` → ERRORED |
| ITEMS(i), i ≥ n | enqueue the tail if not empty, then `controller.close()`, in the same call → DONE | → DONE | Sentry, `controller.error` → ERRORED |
| DONE | can't happen: streams don't call `pull` after close or cancel; if called anyway, the `done` flag returns at once | no-op | — |
| ERRORED | can't happen: an errored stream isn't pulled again | no-op | — |

### 6.2 The cost CSV (`src/lib/reports/csv-generator.ts` and the route)
1. **`csv-generator.ts`:**
   - add `export function csvLines<T extends object>(data: T[], columns): string[]`, which returns `[header, ...rows]`, built exactly as `generateCsv` builds them today;
   - `generateCsv` becomes `return csvLines(data, columns).join('\n');`.
   - So the two can't drift, and every existing `generateCsv` caller and test is unaffected.
2. **The route, inside the existing `try`:**
   - keep the query, the 422, the unpriced total and the footer exactly as they are;
   - replace `const csv = generateCsv(data, [...])` with `const lines = csvLines(data, [...])`, keeping the same 14-entry column array inline, same order and headers. **Don't export it from `route.ts`**: keep route files to the HTTP methods and segment options such as `maxDuration`, as every route in the repo does (Next's generated validator, `.next/types/validator.ts`, checks route exports structurally, so it wouldn't catch a stray export);
   - return:
     ```ts
     return new Response(streamJoined({ head: BOM, items: lines, separator: '\n', tail: footer }), {
       headers: {
         'Content-Type': 'text/csv',
         'Content-Disposition': `attachment; filename="cost-report-${startDate}-to-${endDate}.csv"`,
       },
     });
     ```
   - Headers are unchanged. `new Response` and `new NextResponse` are equivalent here; use `NextResponse` if the file's imports read better.
3. **Same bytes:** `BOM + lines.join('\n') + footer` equals today's `BOM + generateCsv(...) + footer`.
4. Add `export const maxDuration = 300;`, as the audit CSV route has. That's the platform default today; stating it keeps a future plan change from shortening it silently.
5. **Memory.** Once `lines` and the footer exist, nothing the stream holds refers to `data`, so the rows can be garbage-collected while the body streams. **Don't capture `data` in the stream.**

### 6.3 `/api/v1/costs` (`src/lib/api-auth.ts` and the route)
1. **`api-auth.ts`:** add next to `apiResponse`:
   ```ts
   /** apiResponse's exact bytes, streamed (feature-plan-large-report-responses.md §6.3): for row lists that can pass 4.5 MB. */
   export function apiStreamResponse(rows: readonly object[], meta?: Record<string, unknown>): Response {
     const items = rows.map((r) => JSON.stringify(r));
     const metaJson = JSON.stringify({ timestamp: new Date().toISOString(), ...meta });
     return new Response(streamJoined({ head: '{"data":[', items, separator: ',', tail: `],"meta":${metaJson}}` }), {
       status: 200,
       headers: { 'Content-Type': 'application/json' },
     });
   }
   ```
   - Every row is serialized **before** the `Response` exists, so a serialization failure (for example a `BigInt`) throws inside `handleApiRequest`'s `try` and becomes its JSON 500.
   - The `rows` parameter is typed `readonly object[]` so `JSON.stringify(r)` always returns a string; a plain object never stringifies to `undefined`.
   - Byte equality with `apiResponse`: `JSON.stringify` of an array is `'[' + elements.join(',') + ']'`, and each element stringifies the same inside or outside the array. The key order is `data` then `meta`, and inside `meta` it's `timestamp` then the spread, as today.
2. **The route:** `return apiResponse(data, { total: data.length, unpricedHours });` becomes `return apiStreamResponse(data, { total: data.length, unpricedHours });`. Add `export const maxDuration = 300;`. Nothing else changes.
3. `apiResponse` stays for the other routes.

### 6.4 The Excel cap (new `src/lib/reports/limits.ts` and the Excel route)
1. **`limits.ts`:**
   ```ts
   /** feature-plan-large-report-responses.md Q1/Q2: the detailed cost Excel's row cap (memory, §9) and its message. */
   export const EXCEL_COST_MAX_ROWS = 25_000;
   export const EXCEL_COST_TOO_MANY_ROWS = 'More than 25,000 rows match. Choose a shorter date range, or download the CSV.';
   ```
   The two must agree (T12 checks that the number in the text is the constant, formatted with `en-US` grouping).
2. **The route, detailed branch only,** right after the no-hours 422 (`:47-49`) and before `generateCostReportExcel`:
   ```ts
   if (data.length > EXCEL_COST_MAX_ROWS) {
     return NextResponse.json({ error: EXCEL_COST_TOO_MANY_ROWS }, { status: 422 });
   }
   ```
3. **Exactly 25,000 rows is allowed; 25,001 is refused.**
4. The rows are counted after the query, not with a separate `COUNT` first. Holding the rows costs about 0.6–0.9 KB each (§9), so 25,001 to 500,000 rows is roughly 20–430 MB before the refusal, against about 610 MB for the workbook at the cap. A separate count would run the expensive latest-revision and cost-basis query twice for every normal download.
5. **No client change.** `downloadFile` shows a 422's JSON `error` in place (`src/lib/download.ts:97`), in the Contract costs row's alert.
6. **No Excel-file change.** At 25,000 rows the `.xlsx` is about 1.2 MB, far under 4.5 MB, so the Excel response stays buffered.

### 6.5 `/api/v1/periods` and `/api/v1/timesheets/approved` (only if Q4 is yes)
- **`periods`:** `return apiResponse(rows.map(…), { total: rows.length });` (`src/app/api/v1/periods/route.ts:67-72`) becomes `apiStreamResponse(…)` with the same arguments.
- **`timesheets/approved`:** `return apiResponse(results, { total: results.length });` (`src/app/api/v1/timesheets/approved/route.ts:114`) becomes `apiStreamResponse(results, { total: results.length })`.

Both bodies are byte-identical for the same timestamp: their rows contain `Date` objects, which serialize through `toJSON` the same way inside or outside the array (reviewer probe). Add `export const maxDuration = 300;` to both. Nothing else.

### 6.6 Considered and rejected
- **Streaming rows from Postgres** (a postgres-js `.cursor()`, `DECLARE … CURSOR` in a transaction, or keyset batches). Rejected:
  - Tenant URLs use Neon's transaction-mode pooler (`PRODUCTION-DEPLOY.md:80` (c)), and a cursor's behaviour through it can't be tested locally.
  - Keyset batches over the report's 8-key order would run the latest-revision subquery and the cost-basis lateral once per batch over the remaining range, which makes the total work grow with the square of the row count.
  - And memory doesn't need it (§9).
- **Building the CSV lines inside the stream** (lazily). Rejected: an encoding failure would then happen after the 200 and headers. It would come back as a cut-off download, not the JSON 500 that C15 requires (`report-routes.test.ts:67-72`). The prepared lines cost about 0.17 KB per row (CSV) or 0.41 KB (JSON).
- **A date-range cap on Excel.** Rejected in Q1's recommendation (rows, not days, drive memory).

## 7. States
No persisted state, no state machine beyond the stream's own (§6.1 table). Route outcomes, in order:

| Route | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| Cost CSV | rate limit → 429 | bad dates → 400 | guard, query or line-building failure → JSON error via `guardErrorResponse` (403 / 500) | no hours → 422 | 200, streamed |
| Cost Excel (detailed) | rate limit → 429 | bad dates → 400 | guard, query or workbook failure → `guardErrorResponse` | no hours → 422, then **over 25,000 rows → 422 (cap)** | 200, buffered `.xlsx` |
| Cost Excel (summary) | 429 | 400 | `guardErrorResponse` | no direct hours → 422 | 200 (no cap) |
| `/api/v1/costs` | auth → the identical 401 / 403 / 429 (`handleApiRequest`) | validation → 400 | query or serialization failure → JSON 500 | — | 200, streamed |

## 8. Failure modes

| What happens | Result | Why it's acceptable or how it's handled |
|---|---|---|
| The query fails | JSON 500 (CSV: `guardErrorResponse`; API: `handleApiRequest`) | Before any byte (invariant 2) |
| Line encoding or JSON serialization fails | JSON 500 | Before any byte; `report-routes.test.ts:67-72` keeps proving it for the CSV |
| The client closes the tab mid-download | Next cancels the readable; `cancel()` sets `done`; no more pulls | Nothing was saved (`blob()` never resolved). Nothing to clean up: no database cursor or transaction is held |
| A slow client | Backpressure: Next waits for `drain` before the next write, so `pull` isn't called early (§4.2) | Memory stays the prepared lines plus one chunk in flight |
| The 300 s limit passes mid-stream (very slow link, very big file) | Vercel stops the function. **What the browser sees is unverified**: the 200 and headers are already sent, so it can't be a 504. | Locally the body is cut off, so `blob()` rejects and no file is saved. This exposure isn't new: Next already streams every route body (§4.2), so a slow client of today's routes has it too. **Staging step 12.13 tests it with a rate-limited download, judged by content and checked against Vercel's runtime logs.** If Vercel ends the body cleanly (a short file), the lead brings a fix to the product owner before production; the candidate is a `Content-Length` header, since the total length is known before the response. The completeness markers stay meanwhile: the CSV's last line is the Class note, and a cut-off JSON fails to parse. That fallback is itself unverified (the CDN replaces the length on compressed responses, and Vercel may judge "streamed" from headers), so it would need its own run of step 12.13. |
| An unexpected throw inside `pull` | Sentry, `controller.error`; Next destroys the response (§4.2) | A failed download, never a short file |
| Big downloads at once on one instance (Fluid, shared across workspaces) | Each holds its rows while building lines, then only its lines | About 650 MB per 500,000-row CSV at peak (§9). One such CSV, one Excel at the cap (610 MB) and the baseline (about 150 MB) come to about 1.4 GB of 2 GB. |
| Two Excel downloads at the cap at once | About 1.2 GB together | Q1's sizing |
| Over-cap Excel requested repeatedly | Each request runs the query, then gets a 422 | The report rate limit (10 a minute per IP, `src/lib/rate-limit.ts:120-124`, in-memory per instance) slows repeats but doesn't stop requests running at the same time. The memory per refused request is the rows only (§6.4 item 4). |
| The same request run twice | Same output (read-only) | — |
| An API client that needs `Content-Length` | No change: Next already sends chunked with no `Content-Length` (§4.2) | — |

## 9. Platform limits (measured 2026-11-13 by the lead, scripts in `/tmp/5b-probe/`, not committed)
- **Response size.** Today's thresholds come from the Excel item's measurements on the demo data (`feature-plan-excel-cost-report.md` §9: about 140–145 bytes per CSV row and 440–480 per API row): the CSV passes 4.5 MB at about 31,000 rows, the API at about 9,400. (The unit-test factories are about 83 bytes per CSV row unpadded and 353 per API row, which is why T7 pads and T10 uses 15,000 rows.) **After this item, both stream, so the 4.5 MB limit no longer applies.** The Excel at 25,000 rows is about 1.2 MB and stays buffered.
- **Query time** (the real cost query from `drizzle.mock().toSQL()`, on a throwaway copy of `tenant_acme` scaled to 1,010,040 entries, local Postgres 16). It returned **931,000 rows**: a `count(*)` wrapper took 10.0 s and `EXPLAIN ANALYZE` 19.6 s.
  - At the demo's 350 rows per person per year, 100 people for 10 years is 350,000 rows.
  - Neon will be slower than a local laptop, but the margin to 300 s is wide. **Watch item:** time the largest real report at the staging rehearsal (§12, step 5).
- **Memory: the CSV and API rows**:
  - a real postgres-js `.values()` fetch of the same query: 100,000 rows took 65 MB of heap (168 MB peak process memory); 500,000 rows took 307 MB of heap (428 MB peak);
  - on top of that, at 500,000 rows (round-1 reviewer probe): the mapped `CostReportEntry` objects +95 MB, CSV lines +121 MB, JSON items +207 MB.
  - **Peak per request at 500,000 rows: about 650 MB (CSV) or 730 MB (API).** The API's 366-day cap keeps it near 100,000 rows in practice (about 230 MB).
  - Then the rows are released while the body streams (§6.2 item 5).
- **Memory: the Excel workbook** (ExcelJS 4.4.0, `generateCostReportExcel`'s 13 columns and calls, synthetic rows):

  | Rows | Peak process memory | `.xlsx` size |
  |---|---|---|
  | 10,000 | about 270 MB | 0.47 MB |
  | 25,000 | about 610 MB | 1.17 MB |
  | 50,000 | about 1,020 MB | 2.34 MB |

  This matches the Excel item's 910 MB at 50,000 rows with 11 columns.
- **Duration:** a streamed response counts against `maxDuration` (300 s) for the whole transfer (§4.1).
- **Neon:** no change to connection use. One pooled query per request, as today; no long-held connection.

## 10. Blast radius

### 10.1 Changed
| File | Change |
|---|---|
| `src/lib/http/stream-text.ts` (new) | `streamJoined`, `STREAM_BATCH` (§6.1) |
| `src/lib/reports/csv-generator.ts` | `csvLines`; `generateCsv` delegates to it (§6.2 item 1) |
| `src/app/api/reports/cost-report-csv/route.ts` | `csvLines`, streamed body, `maxDuration` (§6.2) |
| `src/lib/api-auth.ts` | `apiStreamResponse` (§6.3) |
| `src/app/api/v1/costs/route.ts` | `apiStreamResponse`, `maxDuration` (§6.3) |
| `src/lib/reports/limits.ts` (new) | `EXCEL_COST_MAX_ROWS`, `EXCEL_COST_TOO_MANY_ROWS` (§6.4) |
| `src/app/api/reports/cost-report-xlsx/route.ts` | the cap check in the detailed branch (§6.4) |
| `src/app/api/v1/periods/route.ts`, `src/app/api/v1/timesheets/approved/route.ts` | (Q4 yes) `apiStreamResponse`, `maxDuration` (§6.5) |
| `src/__tests__/unit/charge-code-cost-rules.test.ts:206,208` | Replace the two source regexes, keep the footer regex. The CSV becomes `/streamJoined\(\{ head: BOM, items: lines, separator: '\\n', tail: footer \}\)/`; v1 becomes `/return apiStreamResponse\(data, \{ total: data\.length, unpricedHours \}\);/`. The byte-level tests T6 and T9 now carry the meaning. |
| `src/__tests__/unit/report-routes.test.ts:27` | The module mock must also export `csvLines`. Make it throw when `h.failCsv` is set, and return `['a,b']` otherwise. Keep `generateCsv` in the mock. Then the C15 test "a CSV generation failure → JSON 500" still proves invariant 2 against the new code. |
| New tests | §11 |

### 10.2 Checked, unchanged
- `getDetailedCostReportData` and `getDetailedCostReport` (§3.1).
- `generateCostReportExcel` and `generateEmployeeSummaryExcel`: the cap lives in the route.
- **The Hours summary Excel:** aggregated per employee × contract × CLIN, and approver-scoped.
- **Cost by pay period** (`period-cost-xlsx`): grouped by CLIN and day for at most 12 periods (`src/server/actions/reports.ts:403`).
- **Unpriced hours Excel:** already capped by `EXPORT_ENTRY_LIMIT` (`src/server/actions/labor-categories.ts:315`).
- **The PDF:** one employee-period.
- **The Audit trail CSV and the workspace export:** already streamed (§3.7).
- **`src/lib/download.ts` and `ReportsClient.tsx`:** no change (§3.6, §6.4 item 5).
- **API docs** in `src/app/(app)/settings/api-keys/ApiKeysClient.tsx`: the response contract is unchanged.
- **The other `generateCsv` callers** (import error files) are unaffected: `generateCsv`'s output is identical.
- **The `/api/v1` routes `contracts`, `employees` and `timesheets` (the paginated list):** bounded (§3.5).
- **Seeders, crons, scripts and migrations:** none involved. No schema change, so no `demo:local` re-seed is needed for the code.

### 10.3 For the lead, on this branch at audit time (not the dev)
- `PRODUCTION-DEPLOY.md` Phase 12: add step **12.13 Large downloads** (§12, step 5).
- `LAUNCH-TRACKER.md`.
- If Q4 is no: add `/api/v1/periods` and `/api/v1/timesheets/approved` to the Deferred list as watch items.

## 11. Required tests (each must fail without the change it proves)
Unit tests unless marked. Synthetic `CostReportEntry` rows come from one shared factory in each test file, for example with `employeeName: 'Emp ' + i` and `chargeCode: i % 5 ? 'CC-' + i : null`. The route tests mock as `cost-report-csv.test.ts` already does: `server-only`; `@/lib/session` with an `AuthorizationError` class; `checkReportRateLimit` returning `null`; and `getDetailedCostReport` in `@/server/actions/reports`. **Read bodies with a reader** (`res.body!.getReader()`, counting chunks) or with `arrayBuffer()` for bytes.

| # | Scenario | Where | Asserts | Fails without |
|---|---|---|---|---|
| T1 | Helper output equals the joined string | new `src/__tests__/unit/stream-text.test.ts` | For n ∈ {0, 1, 999, 1000, 1001, 2500} items, `batch` 1000, a head, separator `'\n'` and a tail: the decoded concatenation of all chunks `=== head + items.join('\n') + tail`. Also for separator `','`, and for an empty head and an empty tail. | §6.1 item 1 (revert check: drop the separator before later batches) |
| T2 | Chunking | same | For n = 2500: exactly 5 chunks (head, 3 batches, tail). For n = 0: 2 chunks. With an empty head and tail and n = 1: 1 chunk. With an empty head and tail and n = 0: 0 chunks, and the first `read()` resolves `done` (it doesn't hang; wrap it in a 1 s race). No chunk has `byteLength` 0. | §6.1 items 1–2 (revert check: enqueue everything in one chunk) |
| T3 | Pull-driven, nothing early | same | `items` is a `Proxy` over an array that counts numeric index reads. After building the stream and awaiting `setImmediate` there are 0 reads. After one `read()` (the head) there are still 0. After a second `read()` there are exactly 1000. | §6.1 item 2 (revert check: do the work in `start`, or set `highWaterMark` above 0) |
| T4 | Cancel stops pulls | same | After one batch, `await reader.cancel()`: the read count stays the same after another `setImmediate`, and no error is thrown. | guard: the streams spec already stops pulls after cancel, so no single edit makes this fail; it pins that the helper doesn't fight it |
| T5 | A throw errors the stream and reports it | same, with a factory mock of `@sentry/nextjs` as in `audit-export.test.ts:15` | The `items` proxy throws on index 1000: the second batch read rejects; `Sentry.captureException` was called once with that error. | §6.1 item 3 |
| T6 | CSV bytes, streamed | extend `cost-report-csv.test.ts` | With 2,500 rows (some `slinNumber`, `chargeCode` and `className` null, one code `=1+1`, one Class `R&D, "Labs"`): the bytes from `arrayBuffer()` equal `Buffer.from('\uFEFF' + generateCsv(rows, COLUMNS) + footer)`. `COLUMNS` is the test's **own** copy of the 14 `{ key, header }` pairs in today's order, an independent oracle. `footer` is written out in the test: `` `\nUnpriced hours (no applicable labor category; no cost),${unpriced}\n${CURRENT_RATES_NOTE}\n${escapeCsvField(CURRENT_CLASS_NOTE)}\n` ``. A second request read with a reader gives **more than 1 chunk**. `content-type` is `text/csv` and `content-disposition` is unchanged. | §6.2 (revert check for the chunk count: go back to `new NextResponse(BOM + lines.join('\n') + footer, …)`) |
| T7 | A CSV over 4.5 MB | same | 31,000 rows from a factory **padded so the body passes 4.5 MB**, for example `contractName: 'Contract ' + 'x'.repeat(80)`. The plain test factory is only about 83 bytes a row (2.57 MB at 31,000: round-1 reviewer), so the test computes and asserts the size rather than assuming it. Asserts: total bytes > 4,500,000; chunk count ≥ 32; the last non-empty line is `escapeCsvField(CURRENT_CLASS_NOTE)`; non-empty lines = 31,004 (header, rows, 3 footer lines). | §6.2 |
| T8 | CSV failure before streaming | `report-routes.test.ts` (the mock updated per §10.1) | The existing "a CSV generation failure → JSON 500" passes, with `csvLines` throwing: status 500, `{ error: 'Internal server error' }`. | §6.2 item 2 and invariant 2 (revert check: call `csvLines` lazily inside the stream, so the status becomes 200) |
| T9 | `apiStreamResponse` bytes | new `src/__tests__/unit/api-stream-response.test.ts`, with the module mocks of `v1-api-auth.test.ts:20-43` plus `vi.mock('server-only', () => ({}))`: `@/lib/api-auth` imports `@/lib/tenant/context`, which starts with `import 'server-only'` and throws under vitest | `vi.useFakeTimers({ toFake: ['Date'] })` then `vi.setSystemTime(…)`, as `email-send-batch.test.ts:60-61` does. For 0, 1 and 2,500 rows (with nulls, a quote, an emoji and `—` in names): the bytes equal those of `apiResponse(rows, meta)` at the same time; `JSON.parse` round-trips; status 200; `content-type` `application/json`. For 2,500 rows, more than 1 chunk. | §6.3 item 1 |
| T10 | `/api/v1/costs` streams over 4.5 MB | new `src/__tests__/unit/costs-api-stream.test.ts`. It uses the **real** `handleApiRequest` with the mocks of `src/__tests__/unit/v1-api-auth.test.ts:20-43` (`@/lib/tenant/context` → `{ kind: 'full', tenant }`, `@/db` → the fake key client returning a valid admin key row, `@sentry/nextjs`), plus `@/server/internal/reports` mocked to **15,000** synthetic rows (12,000 plain rows are only 4.24 MB: round-1 reviewer) and a unique `x-forwarded-for` per request. | Asserts: status 200, total bytes > 4,500,000, chunk count > 1, `JSON.parse(body).meta` equals `{ timestamp: expect.any(String), total: 15000, unpricedHours }`, and `data.length` is 15,000. | §6.3 item 2 (revert check: `apiResponse` gives 1 chunk) |
| T11 | `/api/v1/costs` query failure | same file and mocks | The mocked query rejects: status 500, `content-type` `application/json`, `{ error: 'Internal server error' }`, and Sentry captured the error. | invariant 2 (revert check: run the query inside the stream) |
| T12 | The cap constants | new `src/__tests__/unit/cost-excel-cap.test.ts` | `EXCEL_COST_MAX_ROWS === 25_000`; `EXCEL_COST_TOO_MANY_ROWS` is the Q2 text exactly and contains `EXCEL_COST_MAX_ROWS.toLocaleString('en-US')`. | §6.4 item 1 |
| T13 | The cap at the boundary | same file | `vi.mock('@/lib/reports/cost-report-excel')` with spies (so no real 25,000-row workbook is built). 25,000 rows → 200 and `generateCostReportExcel` called once. 25,001 rows → 422 with `{ error: EXCEL_COST_TOO_MANY_ROWS }`, `generateCostReportExcel` **not** called. All rows with 0 hours (25,001) → the no-hours 422, not the cap. | §6.4 items 2–3 and invariant 5 (revert checks: `>` → `>=` fails at 25,000; removing the check fails at 25,001; putting the cap before the no-hours check fails the 0-hours case) |
| T14 | The summary isn't capped | same file | `format=summary` with 25,001 summary rows (hours > 0) → 200 and `generateEmployeeSummaryExcel` called. | invariant 6 (revert check: apply the cap to the summary branch's data too) |
| T15 | (Q4 yes) `/api/v1/periods` and `/api/v1/timesheets/approved` stream | static on both route files | each contains `apiStreamResponse(` and not `apiResponse(` | §6.5. The behaviour is covered by T9. Their integration tests must still pass: `approver-rules.test.ts`, `calendar-dates-fixes.test.ts` and `migration-import.test.ts` call these routes. |
| T16 | Regressions | existing | `csv-generator.test.ts`, `cost-report-csv.test.ts` T10/T11/T16, `report-routes.test.ts`, `charge-code-cost-rules.test.ts` (with §10.1's two regexes), and the integration tests that call these routes (`costs-api.test.ts`, `cost-basis.test.ts:234`, `report-routes.test.ts:34-35,97-113` for the CSV and both Excel formats, and for Q4 `approver-rules.test.ts`, `calendar-dates-fixes.test.ts`, `migration-import.test.ts:84,470`) all pass unchanged; `response.json()` reads a stream. | (guard) |

**Revert checks.** For T1–T3, T5–T15, the dev names the one targeted edit that makes each test fail and confirms the failure. T4 and T16 are guards. T15's revert is a route going back to `apiResponse(`.

## 12. Verification
1. Dev and lead gates: `npx tsc --noEmit`, `npm run lint` (0 errors), `npm run test`, `npm run test:tz`, `npm run db:safety`.
2. Integration (product owner's machine, and the lead):
   ```bash
   REQUIRE_CONTROL_PLANE_TESTS=1 CONTROL_PLANE_DATABASE_URL="$(grep -h '^CONTROL_PLANE_DATABASE_URL=' .env.local .env 2>/dev/null | head -1 | cut -d= -f2-)" ENCRYPTION_KEY="$(grep -h '^ENCRYPTION_KEY=' .env.local .env 2>/dev/null | head -1 | cut -d= -f2-)" TZ=America/New_York npm run test:integration
   ```
   Check the skipped count (about 1 file is normal).
3. `npm run build` (Turbopack).
4. **Browser checks:** `LARGE-REPORT-RESPONSES-BROWSER-CHECKS.md` (step by step; the lead rehearses it against the finished branch before the merge gate). It covers:
   - the Contract costs CSV and Excel download and open as before;
   - the CSV's bytes match a capture taken from `main` for the same range (a helper script compares them);
   - `/api/v1/costs` with a key returns the same JSON as on `main` apart from `timestamp`;
   - in a throwaway workspace seeded with more than 25,000 cost rows: the Excel shows the Q2 message in place and the CSV downloads;
   - (Q4) `/api/v1/periods` returns as before.

   **Local servers don't enforce Vercel's 4.5 MB limit.** Next already sends every body chunked (§4.2), so local headers can't tell this branch from `main` either. The checks prove same output and the cap. The chunking is proven by the unit tests (T6, T7, T9, T10), and the limit only by staging (step 5).
5. **Staging rehearsal (PRODUCTION-DEPLOY Phase 12, new step 12.13).** The lead writes the exact commands and helper script and rehearses what can be rehearsed locally.
   - **Workspace:** a **new throwaway workspace**, signed up through the 12.4 flow (for example `stagebig` plus the date), in the `full` state per `npm run tenant:admin -- show <slug>`. Never `stagetest2` after 12.8b: suspended workspaces get 403 on data reads (`src/lib/api-auth.ts:129-134`). Never a workspace that later steps use either: `timesheet_entries` is append-only (`drizzle/0012_lame_edwin_jarvis.sql:22-32`).
   - **Seeding:** at least **40,000 cost rows inside one 366-day window**, using one `generate_series` INSERT into `timesheet_entries` (for example 20 users × 260 workdays × 8 charge codes; it fits the unique index `(user, code, date, revision)`, and the trigger blocks only UPDATE and DELETE). A fresh signup has only its admin and no contracts, so the step's SQL first creates the users, a contract, a CLIN and the charge codes. The cost query has no approval filter, so the rows show up without periods.
   - **Cleanup:** `npm run tenant:delete -- <slug> --yes --force-with-reason "5b staging rehearsal throwaway"` (an audited bypass of the deletion date; it drops the database, and the slug stays reserved).
   - **Requests:**
     - Identity encoding only: no `--compressed`, and no `accept-encoding` header copied from DevTools. Capture headers with `-D` and **assert there is no `content-encoding` header**. Vercel compresses `text/csv` and `application/json` when the client asks (`vercel.com/docs/how-vercel-cdn-works/compression`), and a compressed run makes the sizes meaningless. Browsers do get gzip or brotli, so this curl run is the worst case.
     - The CSV route needs the admin's session cookie, taken from the browser the way the checks file explains; the API needs a key.
   - **Baseline (Q6):** if the staging deploy workflow can deploy a ref, deploy the tag `stable-2026-11-13-excel-cost-report` first. Fetch the CSV for the window and `/api/v1/costs` for the same 366 days with `curl -sS -D <h> -o <f> -w '%{http_code} %{size_download}'`, and record each status (413 or 200). If the workflow can't deploy a tag, skip the baseline and say so.
   - **This item** (`main` with 5b):
     - both fetches return 200 with `size_download` > 4,500,000 and no `content-encoding`;
     - the CSV's last line is the Class note, and the JSON parses with `meta.total` equal to the seeded row count;
     - the Excel for the window shows the Q2 message;
     - record how long the CSV took (the §9 watch item).
   - **Cut-off behaviour (§8):**
     - From the CSV's measured full size S, pick a rate that leaves most of the body still owed at 300 s: `--limit-rate 4k` (about 1,700 s for 6.6 MB). Run it with `-D` and the same identity encoding.
     - Buffers between the function and the client (proxy, CDN, TCP, HTTP/2) can absorb megabytes, so the function may finish writing before 300 s even though curl is still downloading. So:
       - **Look in Vercel's runtime logs right after the run** (they're kept only briefly) **for whether the invocation actually timed out.** If it didn't (exit 0, all S bytes, the function done in under 300 s), the run is **not exercised**: rerun with a lower rate (`--limit-rate 1k`) or a bigger window. If it still isn't exercised, report it as inconclusive rather than passed.
       - **Judge by content, not by exit code:**
         - **pass:** a non-zero curl exit (with HTTP/2 a cut-off shows as exit 92 or 56, not 18), or exit 0 with exactly S bytes and the Class note as the last line;
         - **stop and bring it to the product owner before production:** exit 0 with anything other than exactly S bytes ending in the Class note (short, or with extra text such as an appended platform error).
     - If a `Content-Length` fallback is ever adopted (§8), it needs its own run of this whole step: whether Vercel still treats such a response as streamed is undocumented.
   - The lead reports every result to the product owner. That includes a baseline 200, which would mean today's routes were already exempt.

## 13. Hand-off rules (in addition to `BLUEPRINT-STANDARD.md` §3)
1. Write the impact analysis (`LARGE-REPORT-RESPONSES-IMPACT-ANALYSIS.md`, uncommitted) before coding, and stop for the lead's review.
2. Don't change the query, the CSV columns, the footer, the byte-order mark, the JSON shape or any header (invariant 3).
3. Everything that can fail runs before the `Response` is built. The stream only slices prepared strings (invariant 2, §6.6).
4. No `request.signal` check in the stream (§6.1 item 4). No database work inside the stream.
5. The cap's number and message come only from `src/lib/reports/limits.ts`.
6. Commit on `large-report-responses` only, staging files by name (Planning's uncommitted files share the tree). Never push.

## 14. Pre-mortem log
- **Round 1** (2026-11-13; two independent reviewers: runtime and platform path; outputs, tests and blast radius). **0 HIGH, 8 MEDIUM (one found by both), 10 LOW. All fixed in v2.**
  - MEDIUM, both: what a cut-off stream looks like through Vercel is unverified. §8 now says so, the exposure isn't new (Next already streams every body), and staging step 12.13 tests it with a fallback plan.
  - MEDIUM: Next already pipes every route body, so local `curl` headers can't tell the branch from `main`, and the 4.5 MB premise is provable only on Vercel. That became new Q6, §4.2 and §12.
  - MEDIUM: the staging check could pass without proving anything. It now requires a workspace in the `full` state, 40,000 rows in one 366-day window, sizes over 4.5 MB, and a baseline.
  - MEDIUM: memory per big CSV was understated (430 → about 650 MB), and the rate limit doesn't bound requests running at the same time. Q3, §8 and §9 are corrected.
  - MEDIUM: T7's and T10's factories were below 4.5 MB. Now padded, and 15,000 rows.
  - MEDIUM: `/api/v1/timesheets/approved` was missing (no range cap; passes 4.5 MB at about 17,800 entries). Added to Q4, §3.5, §6.5 and T15.
  - LOW: a stream rule against a `pull` that does nothing (it would hang), plus a T2 case; the expected duplicate Sentry event; the route-export reason corrected; T7's line count; T5/T9 mocking patterns; T14's revert check; line drift in §3; integration test names in T15/T16.
  - Checked and correct: Next's backpressure, cancel and error behaviour (probed through Next's own pipe); no body buffering by Sentry, `src/proxy.ts` or ISR for these routes; byte identity of both bodies, including `Date` rows; the §10.1 regexes; T2/T3 counts; the 422 path.
- **Round 2** (2026-11-13; two fresh reviewers, same split). **0 HIGH, 2 MEDIUM (one found by both), 9 LOW. All fixed in v3. Both said the code design and test matrix are sound.**
  - MEDIUM, both: the staging cut-off check judged by exit code alone. Buffers on Vercel's path can absorb the body, so exit 0 may mean a complete file and a 300 s path never exercised. It's now judged by content (size against the full fetch, the last line), checked against Vercel's runtime logs, with a "not exercised, rerun or report inconclusive" outcome.
  - MEDIUM: Vercel compresses CSV and JSON when the client asks, which would shrink `size_download`. Identity requests are now required, asserting no `content-encoding`.
  - LOW: HTTP/2 exit codes (92 or 56, not 18); the rate derived from the measured size; a fresh throwaway workspace with audited cleanup (append-only rows); the session cookie for curl; the `Content-Length` fallback needs its own staging run; T9's `server-only` mock; named integration tests (`report-routes`, `migration-import`); the api-auth 403 line (`:129-134`); one API threshold (later corrected to about 9,400 rows in the confirmation pass); T15 has a revert.
  - Checked and correct (by running prototypes and sizes): T2/T3/T7/T10 counts and sizes (5.29 MB and 5.30 MB); the one-chunk string body; T10/T11 with the real `handleApiRequest`; T13 builds no real workbook; the real Sentry loads under vitest; the §10.1 regexes; other static tests stay green; §6.5's rows; Q1–Q6 honest and consistent; seeding 40,000 rows on staging is feasible.
- **Confirmation pass** (2026-11-13, one fresh reviewer). **CLEAN: 0 HIGH, 0 MEDIUM, 6 LOW, all written into v3.1.** It confirmed every round-2 fix, the baseline tag and workflow, the seeding constraints, the code references and that the tables are intact. The LOWs:
  - the stop rule now covers any file that isn't exactly S bytes ending in the Class note;
  - check the runtime logs right after the run;
  - a fresh workspace needs its users, contract, CLIN and codes created first;
  - T4 → T6 in §10.1;
  - the size figures now cite the Excel item's measurements (31,000 CSV rows, 9,400 API rows);
  - the full "if Q4 is no" drop list.
