# Reminder email capacity: checks (product owner)

About 25 minutes. This change has no screen of its own, so the checks run in the Terminal. A small local stand-in for Resend records every request the app makes. **Nothing is sent to Resend and no real email goes out.**

Do the checks in order. If anything differs, stop and tell Planning which step and what you saw.

> **Status:** rehearsed by the lead on 2026-11-13 against the finished branch. Every code block below was copied exactly as written (left margin included) and run in its own fresh zsh shell.

**Run on a weekday** (Monday–Friday, US Eastern time). The daily reminder skips weekends.

You need **three Terminal tabs**, called **A**, **B** and **C** below. All three are in the repo folder, on branch `reminder-capacity`.

**About copying.** Copy each grey block whole, including its first and last line, and paste it into the tab named in the step. The two long blocks (0.2 and 0.3) create small helper files; paste them in one go. Every other command is one short line.

**Already started on 2026-11-13?** If tab A has already registered workspace `rc11130756`, do 0.2 step 1 (it only writes the helper), skip step 2, and carry on at step 3.

## 0. Set up

### 0.1 Build (tab A)

```bash
npm run build
```

**Expect:** the build finishes with no errors.

### 0.2 Create a throwaway workspace with 150 employees (tab A)

A deleted workspace's name stays reserved, so every run makes a new one, named `rc` plus the month, day, hour and minute (for example `rc11131405`). A small helper script keeps the name in `/tmp/rc-check-name` and runs each command for you, printing what it does.

**Step 1.** Write the helper (paste the whole block):

```bash
cat > /tmp/rc-check.sh <<'EOF'
#!/bin/bash
# Reminder-capacity checks helper (throwaway). Run from the repo folder.
set -e
[ -f package.json ] || { echo "Run this from the repo folder." >&2; exit 1; }
PG=postgresql://bytime:bytime_dev@localhost:5432
NAME_FILE=/tmp/rc-check-name
name() {
  [ -s "$NAME_FILE" ] || { echo "No workspace yet: run 'bash /tmp/rc-check.sh new' first." >&2; exit 1; }
  cat "$NAME_FILE"
}
EMPLOYEES="INSERT INTO users (email, full_name, role)
  SELECT 'emp' || lpad(g::text, 3, '0') || '@rc-check.test', 'Check Employee ' || g, 'employee'
  FROM generate_series(1, 150) g;"
COUNT="SELECT count(*) FROM users WHERE role = 'employee';"
case "$1" in
  new)
    echo "rc$(date +%m%d%H%M)" > "$NAME_FILE"
    N=$(name); echo "Workspace name: $N"
    psql "$PG/bytime" -c "CREATE DATABASE \"bytime_$N\""
    npm run seed:tenant -- "$N" "$PG/bytime_$N" ;;
  preview)
    N=$(name); psql "$PG/bytime_$N" -c "BEGIN; $EMPLOYEES $COUNT ROLLBACK;" ;;
  save)
    N=$(name); psql "$PG/bytime_$N" -c "$EMPLOYEES" ;;
  run)
    SECRET=$(grep -h '^CRON_SECRET=' .env.local .env | head -1 | cut -d= -f2-)
    curl -s -H "Authorization: Bearer $SECRET" http://localhost:3000/api/cron/daily-reminder | python3 -m json.tool ;;
  delete-preview)
    N=$(name); npm run tenant:delete -- "$N" ;;
  delete)
    N=$(name); npm run tenant:delete -- "$N" --yes --force-with-reason "local reminder-capacity check"
    rm -f "$NAME_FILE" ;;
  *)
    echo "Usage: bash /tmp/rc-check.sh new|preview|save|run|delete-preview|delete" >&2; exit 1 ;;
esac
EOF
```

**Expect:** no output; you're back at the prompt.

**Step 2.** Create and register the workspace:

```bash
bash /tmp/rc-check.sh new
```

**Expect:** `Workspace name: rc…`, then `CREATE DATABASE`, and at the end `✓ Tenant "rc…" is ACTIVE.`

**Step 3.** Preview adding 150 employees on a made-up domain, `rc-check.test`. This runs in a transaction that is rolled back, so nothing is saved:

```bash
bash /tmp/rc-check.sh preview
```

**Expect:** `BEGIN`, `INSERT 0 150`, then `count` is `150`, then `ROLLBACK`.

**Step 4.** Save them:

```bash
bash /tmp/rc-check.sh save
```

**Expect:** `INSERT 0 150`.

### 0.3 Start the Resend stand-in (tab B)

**Step 1.** Write the stand-in (paste the whole block):

```bash
cat > /tmp/resend-standin.mjs <<'EOF'
import http from 'node:http';
const mode = process.env.MODE ?? 'ok';
const seen = new Set();
let n = 0;
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    n += 1;
    const key = req.headers['idempotency-key'] ?? '(none)';
    let items = [];
    try { const j = JSON.parse(body); items = Array.isArray(j) ? j : [j]; } catch {}
    const domains = [...new Set(items.map((e) => String([e.to].flat()[0] ?? '').split('@')[1]))];
    const repeat = seen.has(key) ? '  KEY SEEN BEFORE' : '';
    seen.add(key);
    const v = req.headers['x-batch-validation'] ?? '-';
    const k = `${key.slice(0, 20)}…${key.slice(-12)}`;
    const line = `#${n} ${req.method} ${req.url} emails=${items.length} domain=${domains.join(',')}`;
    console.log(`${line} validation=${v} key=${k}${repeat}`);
    res.setHeader('content-type', 'application/json');
    if (mode === 'quota' && req.url === '/emails/batch') {
      res.statusCode = 429;
      const err = { statusCode: 429, name: 'daily_quota_exceeded', message: 'Daily quota reached.' };
      return res.end(JSON.stringify(err));
    }
    if (req.url === '/emails/batch') {
      return res.end(JSON.stringify({ data: items.map((_, i) => ({ id: `standin-${n}-${i}` })) }));
    }
    return res.end(JSON.stringify({ id: `standin-${n}` }));
  });
}).listen(4010, () => console.log(`Resend stand-in on :4010, mode=${mode}`));
EOF
```

**Expect:** no output; you're back at the prompt.

**Step 2.** Start it:

```bash
node /tmp/resend-standin.mjs
```

**Expect:** `Resend stand-in on :4010, mode=ok`. Leave it running.

### 0.4 Start the app pointed at the stand-in (tab C)

```bash
RESEND_API_KEY=re_standin RESEND_BASE_URL=http://localhost:4010 AUTH_TRUST_HOST=true npm run start
```

**Expect:** `Ready` on port 3000. Leave it running. These two settings override your `.env.local` key for this run only, so nothing reaches Resend.

## A. One run sends the 150 reminders in two batches

**Step 1.** In tab A, run the daily reminder:

```bash
bash /tmp/rc-check.sh run
```

**Expect** in the JSON:
- `"message": "Daily reminders sent"`
- `"incomplete": false`
- `"stopReason": null`
- `"failedSends": 0`
- `"sent"` is at least `150`. Other local workspaces with non-demo addresses, such as `fresh`, add their own.

**Step 2.** Look at tab B.

**Expect** exactly **two** lines with `domain=rc-check.test`:
- one with `emails=100`, one with `emails=50`;
- both `POST /emails/batch`, both `validation=permissive`, each with a `key=rem:daily-reminder:…`;
- neither says `KEY SEEN BEFORE`.

Lines for other domains (for example `fresh.test`) are other local workspaces; that's fine. **No** line shows `domain=cadenzpoint.dev` or `domain=bytime.dev`: demo addresses are never mailed.

**Step 3.** Note the **last 12 characters** of each of the two `rc-check.test` keys (after the `…`). They differ; the start of every key is the same for one workspace.

## B. Running it again reuses the same keys

In production, Resend would answer a repeated key without sending. The stand-in only shows that the keys repeat.

**Step 1.** In tab A, run `bash /tmp/rc-check.sh run` again.

**Expect:** the same JSON as A.1.

**Step 2.** Look at tab B.

**Expect:** two new `rc-check.test` lines (`emails=100`, `emails=50`), each ending in **`KEY SEEN BEFORE`**, with the same key endings you noted in A.3.

## C. When Resend's quota runs out, the run stops sending

**Step 1.** In tab B, stop the stand-in with **Ctrl+C**, then start it in quota mode:

```bash
MODE=quota node /tmp/resend-standin.mjs
```

**Expect:** `Resend stand-in on :4010, mode=quota`.

**Step 2.** In tab A, run `bash /tmp/rc-check.sh run` again.

**Expect** in the JSON:
- `"stopReason": "email-quota"`
- `"incomplete": true`
- `"sent": 0`
- `"batches": 1`
- `"failedSends"` equals the size of that one batch (for example `2` if the `fresh` workspace comes first).
- `"resumes"` may list one workspace with `null`. That's expected: a quota stop keeps the workspace's starting position.

**Step 3.** Look at tab B.

**Expect:** exactly **one** new `POST /emails/batch` line since you restarted it. The run didn't try a second batch. (A `POST /emails` line may follow: that's the ops alert email. If `OPS_ALERT_EMAIL` isn't set, there's no such line.)

**Step 4.** In tab C (the app's output), **expect** these two lines (the numbers and domain may differ). A third line starting `[ops alert] cron-incomplete:daily-reminder raised` may follow:
- `Reminder batch failed (daily-reminder): daily_quota_exceeded [2 of 2; domains: fresh.test]`
- `Cron daily-reminder stopped sending: email-quota`

## D. Clean up

**Step 1.** In tab B, stop the stand-in (**Ctrl+C**) and start it in normal mode:

```bash
node /tmp/resend-standin.mjs
```

**Step 2.** In tab A, run `bash /tmp/rc-check.sh run` once more. A complete run clears the alert that check C opened.

**Expect:** `"incomplete": false`, `"stopReason": null`.

**Step 3.** Stop the app (tab C) and the stand-in (tab B) with **Ctrl+C**.

**Step 4.** In tab A, preview deleting the throwaway workspace:

```bash
bash /tmp/rc-check.sh delete-preview
```

**Expect:** `Tenant rc… (rc…), status=active`, `Database: local database "bytime_rc…"`, a "Not eligible" list (that's fine: the next command forces it), and `Dry run — pass --yes to apply.` Nothing is changed.

**Step 5.** Delete it:

```bash
bash /tmp/rc-check.sh delete
```

**Expect:** `✓ Deletion complete.` and a receipt with `slug: rc…`, `status: deleted` and `database: database dropped`.

**Step 6.** Remove the helper files:

```bash
rm -f /tmp/resend-standin.mjs /tmp/rc-check.sh /tmp/rc-check-name
```

## What to report back
For each of A–D: **passed**, or the step number and what you saw instead. For A.1 and C.2, paste the JSON.
