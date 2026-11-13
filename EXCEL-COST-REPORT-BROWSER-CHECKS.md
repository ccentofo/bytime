# Excel cost report: charge codes and Class: checks (product owner)

About 25 minutes. You download the cost report in Excel and CSV from the local demo, look at the two new columns, and call the API once.

Do the checks in order. If anything differs, stop and tell Planning which step and what you saw.

> **Status:** DRAFT (blueprint `feature-plan-excel-cost-report.md` accepted 2026-11-13, with Q1–Q5 as recommended; not yet built). The lead rehearses every step against the finished branch before the merge gate and updates this file. Until then, don't run it.

You need **two Terminal tabs**, called **A** and **B**, both in the repo on branch `excel-cost-report`, plus a browser. Excel or Numbers opens the downloaded files.

## 0. Set up

### 0.1 Reset the local demo (tab A)
```bash
npm run demo:local
```
**Expect:** it ends with `✅ Local demo ready.`

### 0.2 Build and start (tab B)
```bash
npm run build && npm run start
```
**Expect:** the build finishes with no errors, then `Ready` on port 3000. Leave it running.

### 0.3 Sign in
1. Open `http://acme.localhost:3000` in the browser.
2. Sign in as `admin@cadenzpoint.dev`, password `Password123!`.

**Demo data used below** (workspace "acme"):

| Charge code | Contract | CLIN | Class |
|---|---|---|---|
| `NAVAIR-0001-ONSITE` | NAVAIR Systems Support | 0001 | Government Services |
| `NAVAIR-0001-TELEWORK` | NAVAIR Systems Support | 0001 | Government Services |
| `NAVAIR-0002` | NAVAIR Systems Support | 0002 | Government Services |
| `DISA-0001` | DISA Cyber Operations | 0001 | Government Services |
| `DISA-0002` | DISA Cyber Operations | 0002 | R&D Programs |

`NAVAIR-0001-TELEWORK` and `DISA-0002` have no time entries in the demo, so they don't appear in the downloads.

## A. The Excel file has Charge Code and Class
1. Open **Downloads**: `http://acme.localhost:3000/admin/reports`.
2. In the **Contract costs** row, set **Contract** to `NAVAIR Systems Support (W58RGZ-21-C-0001)`.
3. Set **Dates** to the option starting `Contract to date`.
4. Click **Excel**. Open the downloaded `cost-report-….xlsx`.

**Expect:**
- The header row reads, left to right: `Employee`, `Contract`, `Contract #`, `CLIN`, `SLIN`, **`Charge Code`**, **`Class`**, `LCAT Code`, `LCAT Title`, `Rate ($/hr)`, `Date`, `Hours`, `Cost ($)`.
- Rows for CLIN `0001` show `NAVAIR-0001-ONSITE` under Charge Code. Rows for CLIN `0002` show `NAVAIR-0002`.
- Every row's Class is `Government Services`.
- Below the data: the `TOTALS` row (Hours and Cost under their columns), the `UNPRICED HOURS …` row, then two notes:
  - `Costs use the labor-category rate in effect on each day worked.`
  - `Class shows the current Class of each charge code, including on past dates.`
- `Rate ($/hr)` and `Cost ($)` show as dollars (for example `$125.00`), and `Hours` shows two decimals (for example `8.00`).

## B. The CSV has the same columns
1. Same row, same choices. Click **CSV** and open the downloaded `cost-report-….csv`.

**Expect:**
- The header row reads: `Employee`, `Contract`, `Contract Number`, `CLIN`, `SLIN`, **`Charge Code`**, **`Class`**, `LCAT Code`, `LCAT Title`, `Rate ($/hr)`, `Date`, `Hours`, `Cost ($)`, `Cost Basis`.
- Charge Code and Class match what you saw in A.
- *(Only if you said yes to Q5.)* Rows whose LCAT Title is `Unpriced` show `—` in LCAT Code, not `â€”`. The NAVAIR range has some.
- The last three lines are the unpriced-hours line, `Costs use the labor-category rate in effect on each day worked.` and `Class shows the current Class of each charge code, including on past dates.`

## C. Class shows the code's Class today, for past dates too
1. Open **Charge codes**: `http://acme.localhost:3000/admin/charge-codes`.
2. On the `DISA-0001` row, click **Edit**.
   **Expect:** a dialog titled `Edit charge code`; **Class (optional)** shows `Government Services`.
3. Change **Class (optional)** to `R&D Programs`. Click **Save**.
4. Back on **Downloads**, set **Contract** to `DISA Cyber Operations (HC1028-22-C-0015)` and **Dates** to the option starting `Contract to date`. Click **Excel** and open the file.

**Expect:** every `DISA-0001` row, including the oldest (`2025-12-01`), shows Class `R&D Programs`. Before your edit they showed `Government Services`; the note at the bottom explains this.

5. Back on **Charge codes**, click **Edit** on `DISA-0001` again, clear **Class (optional)** with its **×**, and click **Save**.
6. On **Downloads** (same choices as step 4), click **Excel** and open the file.

**Expect:** `DISA-0001` rows still show the code under Charge Code, and Class is **blank**.

## D. An entry with no charge code shows blank cells
This adds one 2-hour entry with no charge code for Jane Smith on Saturday, Oct 3, 2026, like an imported past entry. Time entries can't be deleted, so the cleanup re-seeds the demo.

1. In tab A, preview it in a transaction that rolls back:
   ```bash
   psql "postgresql://bytime:bytime_dev@localhost:5432/tenant_acme" -c "BEGIN; INSERT INTO timesheet_entries (user_id, clin_id, entry_date, hours, revision_number, created_by) SELECT u.id, cl.id, '2026-10-03', '2', 1, a.id FROM users u, users a, clins cl JOIN contracts c ON c.id = cl.contract_id WHERE u.email = 'jane.smith@cadenzpoint.dev' AND a.email = 'admin@cadenzpoint.dev' AND c.name = 'NAVAIR Systems Support' AND cl.clin_number = '0001'; ROLLBACK;"
   ```
   **Expect:** `BEGIN`, `INSERT 0 1`, `ROLLBACK`.
2. Save it (the same command without `BEGIN;` and `ROLLBACK;`):
   ```bash
   psql "postgresql://bytime:bytime_dev@localhost:5432/tenant_acme" -c "INSERT INTO timesheet_entries (user_id, clin_id, entry_date, hours, revision_number, created_by) SELECT u.id, cl.id, '2026-10-03', '2', 1, a.id FROM users u, users a, clins cl JOIN contracts c ON c.id = cl.contract_id WHERE u.email = 'jane.smith@cadenzpoint.dev' AND a.email = 'admin@cadenzpoint.dev' AND c.name = 'NAVAIR Systems Support' AND cl.clin_number = '0001';"
   ```
   **Expect:** `INSERT 0 1`.
3. On **Downloads**, set **Contract** to `NAVAIR Systems Support (W58RGZ-21-C-0001)`, **Dates** to the option starting `Contract to date`, click **Excel** and open the file.

**Expect:** a row for `Jane Smith`, CLIN `0001`, date `2026-10-03`, Hours `2.00`, with **Charge Code and Class both blank**. It still has a labor category and cost (Jane's labor category covers that CLIN). The other rows still show their codes.

4. Click **CSV** and open it.
   **Expect:** the same row (Hours `2`), with two empty fields where Charge Code and Class go.

## E. The API returns chargeCode and className
1. Open **Settings › API keys**: `http://acme.localhost:3000/settings/api-keys`. Click **Create API Key**.
2. **Name:** `cost check`. **Permissions:** `Read Only`. Click **Generate Key**.
3. In the dialog titled `Copy your API key`, click **Copy key**.
   *(Only if you said yes to Q2:)* **Expect** the sentence: "Each row also has `chargeCode` and `className` (null when the entry has no charge code or the code has no Class). `className` is the charge code's current Class."
4. Click **I've copied the key**.
5. In tab A, run this, pasting your key in place of `PASTE_KEY`:
   ```bash
   curl -s --resolve acme.localhost:3000:127.0.0.1 -H "Authorization: Bearer PASTE_KEY" "http://acme.localhost:3000/api/v1/costs?startDate=2026-10-01&endDate=2026-10-05" | python3 -c "import json,sys; d=json.load(sys.stdin); rows=d['data']; print(len(rows), 'rows'); [print(r['employeeName'], r['entryDate'], r['chargeCode'], r['className']) for r in rows if r['employeeName']=='Jane Smith']"
   ```
   **Expect:** a row count, then Jane Smith's rows for Oct 1–5, each with a charge code and a Class. Her `2026-10-03` row shows `None None` (that's `null` for both).

## F. Unchanged outputs
1. On **Downloads**, in the **Hours summary** row, click its Excel button and open the file.
   **Expect:** its headers are still `Employee`, `Contract`, `Contract #`, `CLIN`, `Total Hours`, `Total Cost ($)`, with no Charge Code or Class.
2. *(Only if you said yes to Q3:)* The **Contract costs** description reads "Hours and cost by contract, CLIN, charge code and labor category, using the rate in effect each day."

## G. Clean up
1. Stop the app in tab B with **Ctrl+C**.
2. Reset the demo, which removes the Class changes, the extra entry and the API key:
   ```bash
   npm run demo:local
   ```
   **Expect:** `✅ Local demo ready.`

## What to report back
For each of A–F: **passed**, or the step number and what you saw instead.
