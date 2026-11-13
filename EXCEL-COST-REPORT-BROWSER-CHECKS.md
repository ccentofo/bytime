# Excel cost report: charge codes and Class: checks (product owner)

About 25 minutes. You download the cost report in Excel and CSV from the local demo, look at the two new columns, and call the API once.

Do the checks in order. If anything differs, stop and tell Planning which step and what you saw.

> **Status:** REHEARSED 2026-11-13 by Planning against `064e582`.
> - Every code block was copied verbatim into its own fresh interactive zsh, in order, from a reset demo through cleanup.
> - Each browser click was checked by fetching the URL that button calls (signed in as the admin) and reading the file it returns. Every label was taken from the code.
> - The rehearsal fixed two problems: sign-in needs `AUTH_TRUST_HOST=true` on the local production server, and a step that read the Downloads folder was dropped (macOS can block Terminal from that folder).

You need **two Terminal tabs**, called **A** and **B**, both in the repo on branch `excel-cost-report`, plus a browser. Excel or Numbers opens the downloaded files. Copy each code block whole into the tab named in the step. Every command is one line, except the helper script in 0.1, which you paste once.

## 0. Set up

### 0.1 Write the helper script (tab A)
This writes `/tmp/ecr-check.sh`, which the later steps call. Copy the whole block, from `cat` to the closing `ECR`, and paste it once.

```bash
cat > /tmp/ecr-check.sh <<'ECR'
#!/bin/bash
# Helper for EXCEL-COST-REPORT-BROWSER-CHECKS.md. Usage: bash /tmp/ecr-check.sh <step>
set -uo pipefail
DB="postgresql://bytime:bytime_dev@localhost:5432/tenant_acme"
KEY_FILE=/tmp/ecr-key
read -r -d '' INSERT_SQL <<'SQL'
INSERT INTO timesheet_entries (user_id, clin_id, entry_date, hours, revision_number, created_by)
SELECT u.id, cl.id, '2026-10-03', '2', 1, a.id
FROM users u, users a, clins cl JOIN contracts c ON c.id = cl.contract_id
WHERE u.email = 'jane.smith@cadenzpoint.dev' AND a.email = 'admin@cadenzpoint.dev'
  AND c.name = 'NAVAIR Systems Support' AND cl.clin_number = '0001';
SQL
COUNT_SQL="SELECT count(*) FROM timesheet_entries te JOIN users u ON u.id = te.user_id
  WHERE u.email = 'jane.smith@cadenzpoint.dev' AND te.entry_date = '2026-10-03'
  AND te.charge_code_id IS NULL AND te.clin_id IS NOT NULL;"

case "${1:-}" in
  insert-dry)
    printf 'BEGIN;\n%s\nROLLBACK;\n' "$INSERT_SQL" | psql "$DB" -v ON_ERROR_STOP=1
    ;;
  insert)
    n=$(psql "$DB" -Atc "$COUNT_SQL") || { echo "STOP: can't reach tenant_acme"; exit 1; }
    if [ "$n" != "0" ]; then echo "Already added ($n entry). Nothing to do."; exit 0; fi
    printf '%s\n' "$INSERT_SQL" | psql "$DB" -v ON_ERROR_STOP=1
    ;;
  api)
    if [ ! -s "$KEY_FILE" ]; then echo "STOP: no key saved. Click Copy key, then run: pbpaste > /tmp/ecr-key"; exit 1; fi
    KEY=$(tr -d '[:space:]' < "$KEY_FILE")
    case "$KEY" in byt_*) ;; *) echo "STOP: that isn't an API key (it starts byt_). Copy it again."; exit 1;; esac
    code=$(curl -sS -o /tmp/ecr-api.json -w '%{http_code}' --resolve acme.localhost:3000:127.0.0.1 \
      -H "Authorization: Bearer $KEY" \
      "http://acme.localhost:3000/api/v1/costs?startDate=2026-10-01&endDate=2026-10-05")
    if [ "$code" != "200" ]; then echo "STOP: HTTP $code"; cat /tmp/ecr-api.json; echo; exit 1; fi
    python3 -I -c '
import json
d = json.load(open("/tmp/ecr-api.json"))
rows = d["data"]
print(len(rows), "rows; every row has chargeCode and className:", all("chargeCode" in r and "className" in r for r in rows))
for r in rows:
    if r["employeeName"] == "Jane Smith":
        print(r["entryDate"], json.dumps(r["chargeCode"]), json.dumps(r["className"]))
'
    ;;
  cleanup)
    rm -f "$KEY_FILE" /tmp/ecr-api.json && echo "Removed the saved key."
    ;;
  *)
    echo "Usage: bash /tmp/ecr-check.sh insert-dry|insert|api|cleanup"; exit 1
    ;;
esac
ECR
```

Then check it:

```bash
bash /tmp/ecr-check.sh
```

**Expect:** `Usage: bash /tmp/ecr-check.sh insert-dry|insert|api|cleanup`

### 0.2 Reset the local demo (tab A)

```bash
npm run demo:local
```

**Expect:** it ends with `✅ Local demo ready.`

### 0.3 Build and start (tab B)

```bash
npm run build && AUTH_TRUST_HOST=true npm run start
```

**Expect:** the build finishes with no errors, then `Ready` on port 3000. Leave it running. (`AUTH_TRUST_HOST=true` lets sign-in work on a local production server.)

### 0.4 Sign in
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
- `Rate ($/hr)` and `Cost ($)` show as dollars (for example `$110.00`), and `Hours` shows two decimals (for example `2.00`).

## B. The CSV has the same columns
1. Same row, same choices. Click **CSV** and open the downloaded `cost-report-….csv`.

**Expect:**
- The header row reads: `Employee`, `Contract`, `Contract Number`, `CLIN`, `SLIN`, **`Charge Code`**, **`Class`**, `LCAT Code`, `LCAT Title`, `Rate ($/hr)`, `Date`, `Hours`, `Cost ($)`, `Cost Basis`.
- Charge Code and Class match what you saw in A.
- Rows whose LCAT Title is `Unpriced` show `—` in LCAT Code, not `â€”`. The NAVAIR range has some.
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
bash /tmp/ecr-check.sh insert-dry
```

**Expect:** `BEGIN`, `INSERT 0 1`, `ROLLBACK`.

2. Save it:

```bash
bash /tmp/ecr-check.sh insert
```

**Expect:** `INSERT 0 1`. (If you run it twice, the second run says `Already added (1 entry). Nothing to do.`)

3. On **Downloads**, set **Contract** to `NAVAIR Systems Support (W58RGZ-21-C-0001)`, **Dates** to the option starting `Contract to date`, click **Excel** and open the file.

**Expect:** a row for `Jane Smith`, CLIN `0001`, date `2026-10-03`, Hours `2.00`, with **Charge Code and Class both blank**. It still has a labor category and cost (Jane's labor category covers that CLIN). The other rows still show their codes.

4. Click **CSV** and open it.

**Expect:** the same row (Hours `2`), with two empty fields where Charge Code and Class go.

## E. The API returns chargeCode and className
1. Open **Settings › API keys**: `http://acme.localhost:3000/settings/api-keys`. Click **Create API Key**.
2. **Name:** `cost check`. **Permissions:** `Read Only`. Click **Generate Key**.
3. In the dialog titled `Copy your API key`:

   **Expect** this sentence below the others: "Each row also has `chargeCode` and `className` (null when the entry has no charge code or the code has no Class). `className` is the charge code's current Class."
4. Click **Copy key**. (It changes to `Copied`.)
5. In tab A, save the key from the clipboard:

```bash
pbpaste > /tmp/ecr-key
```

**Expect:** no output.

6. Back in the browser, click **I've copied the key**.
7. In tab A, call the API:

```bash
bash /tmp/ecr-check.sh api
```

**Expect** output like this. The row count can differ a little as the demo dates move; Planning's rehearsal showed 31.

```text
31 rows; every row has chargeCode and className: True
2026-10-01 "NAVAIR-0001-ONSITE" "Government Services"
2026-10-02 "NAVAIR-0001-ONSITE" "Government Services"
2026-10-03 null null
2026-10-05 "NAVAIR-0001-ONSITE" "Government Services"
2026-10-01 "NAVAIR-0002" "Government Services"
2026-10-02 "NAVAIR-0002" "Government Services"
2026-10-05 "NAVAIR-0002" "Government Services"
```

The line that matters is `2026-10-03 null null`. If you see a line starting `STOP:`, do what it says, then run the command again.

## F. Unchanged outputs
1. On **Downloads**, in the **Hours summary** row, click its **Excel** button and open the file.

   **Expect:** its headers are still `Employee`, `Contract`, `Contract #`, `CLIN`, `Total Hours`, `Total Cost ($)`, with no Charge Code or Class.
2. The **Contract costs** description reads "Hours and cost by contract, CLIN, charge code and labor category, using the rate in effect each day."

## G. Clean up
1. Stop the app in tab B with **Ctrl+C**.
2. In tab A, remove the saved key:

```bash
bash /tmp/ecr-check.sh cleanup
```

**Expect:** `Removed the saved key.`

3. Reset the demo, which removes the Class changes, the extra entry and the API key:

```bash
npm run demo:local
```

**Expect:** `✅ Local demo ready.`

## What to report back
For each of A–F: **passed**, or the step number and what you saw instead.
