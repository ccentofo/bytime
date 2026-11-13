# Large report responses: checks (product owner)

About 30 minutes, most of it two builds. You'll check five things:
- the cost CSV and three API calls return exactly what `main` returns;
- the Contract costs downloads still work in the browser;
- in a throwaway workspace with 26,000 cost rows, the Excel shows the new limit message and the CSV still downloads;
- then you clean up.

Do the checks in order. If anything differs, stop and tell Planning which step and what you saw.

> **Status:** DRAFT, 2026-11-13. Planning rehearsed the helper script and every helper step (`key`, `capture main`, `new`, `seed-dry`, `seed`, `big`, `delete`, `cleanup`) against `main` on 2026-11-13, each block copied verbatim into its own fresh interactive zsh. `compare` was rehearsed on two captures of `main` (after the dev's impact analysis showed two of the API routes don't fix row order). The steps that need the finished branch (`capture branch`, `compare`, the Excel message) are rehearsed against it before the merge gate.

**What you can't see locally.** Your machine doesn't enforce Vercel's 4.5 MB response limit, so these checks prove that the output is unchanged and that the cap works. The limit itself is checked on staging (PRODUCTION-DEPLOY step 12.13).

You need **two Terminal tabs**, called **A** and **B**, both in the repo, plus a browser. Copy each code block whole into the tab named in the step. Every command is one short line, except the helper script in 0.1, which you paste once.

## 0. Set up

### 0.1 Write the helper script (tab A)
This writes `/tmp/lrr-check.sh`, which the later steps call. Copy the whole block, from the first `cat` line to the closing `EOF`, and paste it once.

```bash
cat > /tmp/lrr-check.sh <<'EOF'
#!/bin/bash
# Helper for LARGE-REPORT-RESPONSES-BROWSER-CHECKS.md. Usage: bash /tmp/lrr-check.sh <step>
set -uo pipefail
[ -f package.json ] || { echo "STOP: run this from the repo folder." >&2; exit 1; }
PG=postgresql://bytime:bytime_dev@localhost:5432
ACME="$PG/tenant_acme"
NAME_FILE=/tmp/lrr-check-name
KEY_FILE=/tmp/lrr-key
TODAY=$(date +%F)
YEAR_AGO=$(date -v-365d +%F)
FIRST=$(date -v-2599d +%F)

name() {
  [ -s "$NAME_FILE" ] || { echo "STOP: no workspace yet. Run: bash /tmp/lrr-check.sh new" >&2; exit 1; }
  cat "$NAME_FILE"
}

# login <slug> <email>: signs in with curl, keeps the cookie in /tmp/lrr-cookies-<slug>.
login() {
  local host="$1.localhost" jar="/tmp/lrr-cookies-$1" csrf code
  rm -f "$jar"
  csrf=$(curl -sS -c "$jar" -b "$jar" --resolve "$host:3000:127.0.0.1" "http://$host:3000/api/auth/csrf" \
    | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["csrfToken"])') || { echo "STOP: is the app running in tab B?"; exit 1; }
  curl -sS -o /dev/null -c "$jar" -b "$jar" --resolve "$host:3000:127.0.0.1" \
    --data-urlencode "csrfToken=$csrf" --data-urlencode "email=$2" --data-urlencode "password=Password123!" \
    "http://$host:3000/api/auth/callback/credentials"
  code=$(curl -sS -b "$jar" --resolve "$host:3000:127.0.0.1" "http://$host:3000/api/auth/session")
  case "$code" in *"$2"*) ;; *) echo "STOP: sign-in as $2 failed"; exit 1;; esac
}

# get <slug> <path> <out>: GET as the signed-in user (or with the API key for /api/v1), prints "status bytes".
get() {
  local host="$1.localhost" auth=()
  case "$2" in /api/v1/*) auth=(-H "Authorization: Bearer $(cat "$KEY_FILE")");; esac
  curl -sS -o "$3" -w '%{http_code} %{size_download}' -b "/tmp/lrr-cookies-$1" ${auth[@]+"${auth[@]}"} \
    --resolve "$host:3000:127.0.0.1" "http://$host:3000$2"
}

SEED_SQL="WITH c AS (INSERT INTO contracts (contract_number, name, start_date)
    VALUES ('LRR-0001', 'Big Check Contract', DATE '$FIRST') RETURNING id),
  cl AS (INSERT INTO clins (contract_id, clin_number) SELECT id, '0001' FROM c RETURNING id),
  u AS (INSERT INTO users (email, full_name, role)
    SELECT 'emp' || lpad(g::text, 2, '0') || '@lrr-check.test', 'Check Employee ' || g, 'employee'
    FROM generate_series(1, 10) g RETURNING id)
  INSERT INTO timesheet_entries (user_id, clin_id, entry_date, hours)
  SELECT u.id, cl.id, DATE '$TODAY' - d, '8' FROM u, cl, generate_series(0, 2599) d;"

case "${1:-}" in
  key)
    KEY="byt_$(openssl rand -hex 16)"
    psql "$ACME" -q -v ON_ERROR_STOP=1 -c "DELETE FROM api_keys WHERE name = 'lrr check';" \
      -c "INSERT INTO api_keys (name, key_hash, key_prefix, created_by_user_id)
          SELECT 'lrr check', encode(sha256('$KEY'::bytea), 'hex'), left('$KEY', 8), id
          FROM users WHERE email = 'admin@cadenzpoint.dev';" || exit 1
    echo "$KEY" > "$KEY_FILE" && echo "Saved a test API key for acme."
    ;;
  capture)
    LABEL="${2:-}"; case "$LABEL" in main|branch) ;; *) echo "Usage: capture main|branch"; exit 1;; esac
    [ -s "$KEY_FILE" ] || { echo "STOP: run: bash /tmp/lrr-check.sh key"; exit 1; }
    login acme admin@cadenzpoint.dev
    echo "costs CSV:  $(get acme "/api/reports/cost-report-csv?startDate=2025-12-01&endDate=$TODAY" /tmp/lrr-$LABEL-costs.csv)"
    echo "v1 costs:   $(get acme "/api/v1/costs?startDate=$YEAR_AGO&endDate=$TODAY" /tmp/lrr-$LABEL-costs.json)"
    echo "v1 periods: $(get acme "/api/v1/periods" /tmp/lrr-$LABEL-periods.json)"
    echo "v1 approved: $(get acme "/api/v1/timesheets/approved?startDate=2025-12-01&endDate=$TODAY" /tmp/lrr-$LABEL-approved.json)"
    ;;
  compare)
    python3 -I - <<'PY'
import json, re
def norm(b): return re.sub(rb'"timestamp":"[^"]*"', b'"timestamp":""', b)
def rows(b):
    d = json.loads(b); d["meta"].pop("timestamp", None)
    return d["meta"], sorted(json.dumps(r, sort_keys=True) for r in d["data"])
for name in ["costs.csv", "costs.json", "periods.json", "approved.json"]:
    try:
        a = open(f"/tmp/lrr-main-{name}", "rb").read(); b = open(f"/tmp/lrr-branch-{name}", "rb").read()
    except FileNotFoundError as e:
        print(f"STOP: missing {e.filename}"); continue
    if name.endswith(".csv"): same, word = a == b, "IDENTICAL"
    elif name == "costs.json": same, word = norm(a) == norm(b), "IDENTICAL"
    else: same, word = rows(a) == rows(b), "SAME ROWS"
    print(f"{name}: {word if same else 'DIFFERENT'} ({len(b)} bytes)")
PY
    ;;
  new)
    echo "lrr$(date +%m%d%H%M)" > "$NAME_FILE"
    N=$(name); echo "Workspace name: $N"
    psql "$PG/bytime" -c "CREATE DATABASE \"bytime_$N\"" || exit 1
    npm run seed:tenant -- "$N" "$PG/bytime_$N"
    ;;
  seed-dry)
    N=$(name); printf 'BEGIN;\n%s\nSELECT count(*) AS entries FROM timesheet_entries;\nROLLBACK;\n' "$SEED_SQL" \
      | psql "$PG/bytime_$N" -v ON_ERROR_STOP=1
    ;;
  seed)
    N=$(name)
    n=$(psql "$PG/bytime_$N" -Atc "SELECT count(*) FROM timesheet_entries") || exit 1
    [ "$n" = "0" ] || { echo "Already seeded ($n entries). Nothing to do."; exit 0; }
    printf '%s\n' "$SEED_SQL" | psql "$PG/bytime_$N" -v ON_ERROR_STOP=1
    ;;
  big)
    N=$(name); login "$N" "admin@$N.test"
    echo "Excel (cost report): $(get "$N" "/api/reports/cost-report-xlsx?startDate=$FIRST&endDate=$TODAY" /tmp/lrr-big.xlsx)"
    python3 -I -c '
b = open("/tmp/lrr-big.xlsx", "rb").read()
import json
print("Excel message:", json.loads(b)["error"]) if b[:1] == b"{" else print("Excel: a spreadsheet file (no message)")'
    echo "CSV (cost report):   $(get "$N" "/api/reports/cost-report-csv?startDate=$FIRST&endDate=$TODAY" /tmp/lrr-big.csv)"
    python3 -I -c '
lines = [l for l in open("/tmp/lrr-big.csv", encoding="utf-8-sig").read().split("\n") if l]
print("CSV non-empty lines:", len(lines)); print("CSV last line:", lines[-1])'
    echo "Excel (hours summary): $(get "$N" "/api/reports/cost-report-xlsx?startDate=$FIRST&endDate=$TODAY&format=summary" /tmp/lrr-sum.xlsx)"
    ;;
  delete)
    N=$(name); npm run tenant:delete -- "$N" --yes --force-with-reason "local large-report-responses check" && rm -f "$NAME_FILE"
    ;;
  cleanup)
    psql "$ACME" -q -c "DELETE FROM api_keys WHERE name = 'lrr check';"
    rm -f "$KEY_FILE" /tmp/lrr-main-* /tmp/lrr-branch-* /tmp/lrr-big* /tmp/lrr-sum.xlsx /tmp/lrr-cookies-*
    echo "Removed the test key and the saved files."
    ;;
  *)
    echo "Usage: bash /tmp/lrr-check.sh key|capture main|capture branch|compare|new|seed-dry|seed|big|delete|cleanup"; exit 1
    ;;
esac
EOF
```

Then check it:

```bash
bash /tmp/lrr-check.sh
```

**Expect:** `Usage: bash /tmp/lrr-check.sh key|capture main|capture branch|compare|new|seed-dry|seed|big|delete|cleanup`

### 0.2 Reset the local demo (tab A)

```bash
npm run demo:local
```

**Expect:** the output includes `✅ Local demo ready.`

### 0.3 Add a test API key to the demo (tab A)

```bash
bash /tmp/lrr-check.sh key
```

**Expect:** `Saved a test API key for acme.` The cleanup removes it.

## M. Record what `main` returns

This uses the tag of the last merge, `stable-2026-11-13-excel-cost-report` (what `main` is on GitHub), not your local `main` branch, which may be behind.

### M.1 Switch to the last merge (tab A)

```bash
git switch --detach stable-2026-11-13-excel-cost-report
```

**Expect:** `HEAD is now at 1d44b35 Merge pull request #29 from ccentofo/excel-cost-report`.

### M.2 Build and start it (tab B)

```bash
npm run build && AUTH_TRUST_HOST=true npm run start
```

**Expect:** the build finishes with no errors, then `Ready` on port 3000. (`AUTH_TRUST_HOST=true` lets sign-in work on a local production server.)

### M.3 Capture (tab A)

```bash
bash /tmp/lrr-check.sh capture main
```

**Expect:** four lines, each starting `200` followed by a size in bytes, for example:

```text
costs CSV:  200 345470
v1 costs:   200 1071610
v1 periods: 200 60106
v1 approved: 200 616246
```

Your sizes can differ a little from Planning's. A line starting `STOP:` says what to do.

### M.4 Stop it and switch back
1. In tab B, press **Ctrl+C**.
2. In tab A:

```bash
git switch large-report-responses
```

**Expect:** `Switched to branch 'large-report-responses'`.

## A. The branch returns the same bytes

### A.1 Build and start the branch (tab B)

```bash
npm run build && AUTH_TRUST_HOST=true npm run start
```

**Expect:** no build errors, then `Ready`. Leave it running until G.

### A.2 Capture and compare (tab A)

```bash
bash /tmp/lrr-check.sh capture branch
```

**Expect:** four lines starting `200`, with the same sizes as in M.3.

```bash
bash /tmp/lrr-check.sh compare
```

**Expect:**

```text
costs.csv: IDENTICAL (… bytes)
costs.json: IDENTICAL (… bytes)
periods.json: SAME ROWS (… bytes)
approved.json: SAME ROWS (… bytes)
```

- The cost CSV and the cost API are compared byte for byte, with the API's `timestamp` value blanked (it's the time of each request).
- The periods and approved-timesheets APIs are compared row by row, in any order: those two queries don't fix the order of tied rows, so two runs of the same code can list them differently. Their exact bytes are checked by the automated tests.

## B. The Contract costs downloads still work in the browser
1. Open `http://acme.localhost:3000` and sign in as `admin@cadenzpoint.dev`, password `Password123!`.
2. Open **Downloads**: `http://acme.localhost:3000/admin/reports`.
3. In the **Contract costs** row, set **Contract** to `NAVAIR Systems Support (W58RGZ-21-C-0001)` and **Dates** to the option starting `Contract to date`.
4. Click **CSV** and open the downloaded `cost-report-….csv` in Excel or Numbers.

   **Expect:** the same file as before this change. The headers are `Employee`, `Contract`, `Contract Number`, `CLIN`, `SLIN`, `Charge Code`, `Class`, `LCAT Code`, `LCAT Title`, `Rate ($/hr)`, `Date`, `Hours`, `Cost ($)`, `Cost Basis`. The last line is `Class shows the current Class of each charge code, including on past dates.`
5. Click **Excel** and open the downloaded `cost-report-….xlsx`.

   **Expect:** it opens as before, with the `TOTALS` row and the two notes at the bottom.

## C. A workspace with 26,000 cost rows

### C.1 Create a throwaway workspace (tab A)
A deleted workspace's name stays reserved, so every run makes a new one, named `lrr` plus the month, day, hour and minute. The helper keeps the name in `/tmp/lrr-check-name`.

```bash
bash /tmp/lrr-check.sh new
```

**Expect:** `Workspace name: lrr…`, then `CREATE DATABASE`. Some database notices may print in between. It includes `✓ Tenant "lrr…" is ACTIVE.` and a `Login:` line.

### C.2 Add the cost rows (tab A)
This adds a contract (`Big Check Contract`, CLIN `0001`), 10 employees, and 8 hours a day for each of them for the last 2,600 days: 26,000 entries. First, a preview that rolls back:

```bash
bash /tmp/lrr-check.sh seed-dry
```

**Expect:** `BEGIN`, `INSERT 0 26000`, a count of `26000`, `ROLLBACK`.

```bash
bash /tmp/lrr-check.sh seed
```

**Expect:** `INSERT 0 26000`. Run twice, the second run says `Already seeded (26000 entries). Nothing to do.`

### C.3 See the workspace name (tab A)

```bash
cat /tmp/lrr-check-name
```

**Expect:** the name, for example `lrr11131405`. Use it below wherever `<name>` appears.

### C.4 The Excel shows the limit message (browser)
1. Open a **private window** (so the acme sign-in doesn't get in the way) and go to `http://<name>.localhost:3000`.
2. Sign in as `admin@<name>.test`, password `Password123!`.
3. Open **Downloads**: `http://<name>.localhost:3000/admin/reports`.
4. In the **Contract costs** row, set **Contract** to `Big Check Contract (LRR-0001)` and **Dates** to the option starting `Contract to date`.
5. Click **Excel**.

   **Expect:** no download. The row shows exactly: `More than 25,000 rows match. Choose a shorter date range, or download the CSV.`
6. Click **CSV**.

   **Expect:** `cost-report-….csv` downloads. Opened in Excel or Numbers, it has 26,000 data rows (each with LCAT Title `Unpriced` and Cost Basis `unpriced`) and the Class note as its last line.

### C.5 The same, by the helper (tab A)

```bash
bash /tmp/lrr-check.sh big
```

**Expect:**

```text
Excel (cost report): 422 …
Excel message: More than 25,000 rows match. Choose a shorter date range, or download the CSV.
CSV (cost report):   200 …
CSV non-empty lines: 26004
CSV last line: "Class shows the current Class of each charge code, including on past dates."
Excel (hours summary): 200 …
```

The last line shows the Hours summary Excel has no limit: it still downloads for the same 26,000 entries.

## G. Clean up
1. Close the private window. In tab B, stop the app with **Ctrl+C**.
2. Delete the throwaway workspace (tab A):

```bash
bash /tmp/lrr-check.sh delete
```

**Expect:** the report includes `database:` … `database dropped` and `FORCED:` … `local large-report-responses check`.

3. Remove the test key and saved files:

```bash
bash /tmp/lrr-check.sh cleanup
```

**Expect:** `Removed the test key and the saved files.`

4. Reset the demo:

```bash
npm run demo:local
```

**Expect:** the output includes `✅ Local demo ready.`

## What to report back
For each of M, A, B, C: **passed**, or the step number and what you saw instead.
