# Reminder email capacity: checks (product owner)

About 25 minutes. This change has no screen of its own, so the checks run in the Terminal. A small local stand-in for Resend records every request the app makes. **Nothing is sent to Resend and no real email goes out.**

Do the checks in order. If anything differs, stop and tell Planning which step and what you saw.

> **Status:** rehearsed by the lead against the finished branch (`8f3262a`) on 2026-11-12. Every step passed as written below.

**Run on a weekday** (Monday–Friday, US Eastern time). The daily reminder skips weekends.

You need **three Terminal tabs**, called **A**, **B** and **C** below. All three are in the repo, on branch `reminder-capacity`.

## 0. Set up

### 0.1 Build (tab A)
```bash
npm run build
```
**Expect:** the build finishes with no errors.

### 0.2 Create a throwaway workspace with 150 employees (tab A)
A deleted workspace's name stays reserved, so every run uses a **new** name. Step 2 saves it in a small file, `/tmp/rc-check-name`, and every later command reads it from there, so it works in any tab or with the Run buttons. Each of those commands stops at once if the file is missing.

1. **Only if an earlier attempt left it behind:** remove the half-made database from that attempt. First check whether it exists:
   ```bash
   psql "postgresql://bytime:bytime_dev@localhost:5432/bytime" -Atc "SELECT datname FROM pg_database WHERE datname = 'bytime_rccheck'"
   ```
   If that prints `bytime_rccheck`, remove it (it holds only that attempt's admin user and isn't registered to any workspace):
   ```bash
   psql "postgresql://bytime:bytime_dev@localhost:5432/bytime" -c 'DROP DATABASE "bytime_rccheck"'
   ```
   **Expect:** `DROP DATABASE`. If the first command printed nothing, skip this.
2. Pick this run's workspace name and save it:
   ```bash
   echo "rc$(date +%m%d%H%M)" > /tmp/rc-check-name && cat /tmp/rc-check-name
   ```
   **Expect:** a name like `rc11131405`. That's `<name>` below. Run this step only once per run.
3. Create its database:
   ```bash
   N=$(cat /tmp/rc-check-name) && [ -n "$N" ] && psql "postgresql://bytime:bytime_dev@localhost:5432/bytime" -c "CREATE DATABASE \"bytime_$N\""
   ```
   **Expect:** `CREATE DATABASE`.
4. Register the workspace. This creates only an admin, `admin@<name>.test`:
   ```bash
   N=$(cat /tmp/rc-check-name) && [ -n "$N" ] && npm run seed:tenant -- "$N" "postgresql://bytime:bytime_dev@localhost:5432/bytime_$N"
   ```
   **Expect:** it ends with `✓ Tenant "<name>" is ACTIVE.`
5. Add 150 employees on a made-up domain, `rc-check.test`. Run it in a transaction you roll back first, to see the count without saving:
   ```bash
   N=$(cat /tmp/rc-check-name) && [ -n "$N" ] && psql "postgresql://bytime:bytime_dev@localhost:5432/bytime_$N" -c "BEGIN; INSERT INTO users (email, full_name, role) SELECT 'emp' || lpad(g::text, 3, '0') || '@rc-check.test', 'Check Employee ' || g, 'employee' FROM generate_series(1, 150) g; SELECT count(*) FROM users WHERE role = 'employee'; ROLLBACK;"
   ```
   **Expect:** `BEGIN`, `INSERT 0 150`, then `count` is `150`, then `ROLLBACK`.
6. Now save it:
   ```bash
   N=$(cat /tmp/rc-check-name) && [ -n "$N" ] && psql "postgresql://bytime:bytime_dev@localhost:5432/bytime_$N" -c "INSERT INTO users (email, full_name, role) SELECT 'emp' || lpad(g::text, 3, '0') || '@rc-check.test', 'Check Employee ' || g, 'employee' FROM generate_series(1, 150) g;"
   ```
   **Expect:** `INSERT 0 150`.

### 0.3 Start the Resend stand-in (tab B)
1. Write the stand-in to a temporary file:
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
       const items = (() => { try { const j = JSON.parse(body); return Array.isArray(j) ? j : [j]; } catch { return []; } })();
       const domains = [...new Set(items.map((e) => String([e.to].flat()[0] ?? '').split('@')[1]))].join(',');
       const repeat = seen.has(key) ? '  KEY SEEN BEFORE' : '';
       seen.add(key);
       console.log(`#${n} ${req.method} ${req.url} emails=${items.length} domain=${domains} validation=${req.headers['x-batch-validation'] ?? '-'} key=${key.slice(0, 20)}…${key.slice(-12)}${repeat}`);
       res.setHeader('content-type', 'application/json');
       if (mode === 'quota' && req.url === '/emails/batch') {
         res.statusCode = 429;
         return res.end(JSON.stringify({ statusCode: 429, name: 'daily_quota_exceeded', message: 'You have reached your daily email sending quota.' }));
       }
       if (req.url === '/emails/batch') return res.end(JSON.stringify({ data: items.map((_, i) => ({ id: `standin-${n}-${i}` })) }));
       return res.end(JSON.stringify({ id: `standin-${n}` }));
     });
   }).listen(4010, () => console.log(`Resend stand-in on :4010, mode=${mode}`));
   EOF
   ```
2. Start it:
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
1. In tab A, run the daily reminder:
   ```bash
   curl -s -H "Authorization: Bearer $(grep -h '^CRON_SECRET=' .env.local .env | head -1 | cut -d= -f2-)" http://localhost:3000/api/cron/daily-reminder | python3 -m json.tool
   ```
   **Expect** in the JSON:
   - `"message": "Daily reminders sent"`
   - `"incomplete": false`
   - `"stopReason": null`
   - `"failedSends": 0`
   - `"sent"` is at least `150`. Other local workspaces with non-demo addresses, such as `fresh`, add their own.
2. Look at tab B.
   **Expect** exactly **two** lines with `domain=rc-check.test`:
   - one with `emails=100`, one with `emails=50`;
   - both `POST /emails/batch`, both `validation=permissive`, each with a `key=rem:daily-reminder:…`;
   - neither says `KEY SEEN BEFORE`.

   Lines for other domains (for example `fresh.test`) are other local workspaces; that's fine. **No** line shows `domain=cadenzpoint.dev` or `domain=bytime.dev`: demo addresses are never mailed.
3. Note the **last 12 characters** of each of the two `rc-check.test` keys (after the `…`). They differ: the start of every key is the same for one workspace.

## B. Running it again reuses the same keys
In production, Resend would answer a repeated key without sending. The stand-in only shows that the keys repeat.
1. In tab A, run the same `curl` command as in A.1.
   **Expect:** the same JSON as A.1.
2. Look at tab B.
   **Expect:** two new `rc-check.test` lines (`emails=100`, `emails=50`), each ending in **`KEY SEEN BEFORE`**, with the same key endings you noted in A.3.

## C. When Resend's quota runs out, the run stops sending
1. In tab B, stop the stand-in with **Ctrl+C**, then start it in quota mode:
   ```bash
   MODE=quota node /tmp/resend-standin.mjs
   ```
   **Expect:** `Resend stand-in on :4010, mode=quota`.
2. In tab A, run the `curl` command from A.1 again.
   **Expect** in the JSON:
   - `"stopReason": "email-quota"`
   - `"incomplete": true`
   - `"sent": 0`
   - `"batches": 1`
   - `"failedSends"` equals the size of that one batch (for example `2` if the `fresh` workspace comes first).
   - `"resumes"` may list one workspace with `null`. That's expected: a quota stop keeps the workspace's starting position.
3. Look at tab B.
   **Expect:** exactly **one** new `POST /emails/batch` line since you restarted it. The run didn't try a second batch. (A `POST /emails` line may follow: that's the ops alert email. If `OPS_ALERT_EMAIL` isn't set, there's no such line.)
4. In tab C (the app's output), **expect** these two lines (the numbers and domain may differ). A third line starting `[ops alert] cron-incomplete:daily-reminder raised` may follow:
   - `Reminder batch failed (daily-reminder): daily_quota_exceeded [2 of 2; domains: fresh.test]`
   - `Cron daily-reminder stopped sending: email-quota`

## D. Clean up
1. In tab B, stop the stand-in (**Ctrl+C**) and start it in normal mode:
   ```bash
   node /tmp/resend-standin.mjs
   ```
2. In tab A, run the `curl` command from A.1 once more. A complete run clears the alert that check C opened.
   **Expect:** `"incomplete": false`, `"stopReason": null`.
3. Stop the app (tab C) and the stand-in (tab B) with **Ctrl+C**.
4. Delete the throwaway workspace. A dry run comes first:
   ```bash
   N=$(cat /tmp/rc-check-name) && [ -n "$N" ] && npm run tenant:delete -- "$N"
   ```
   **Expect:** `Tenant <name> (<name>), status=active`, `Database: local database "bytime_<name>"`, a "Not eligible" list (that's fine: the next command forces it), and `Dry run — pass --yes to apply.` Nothing is changed. Then apply it:
   ```bash
   N=$(cat /tmp/rc-check-name) && [ -n "$N" ] && npm run tenant:delete -- "$N" --yes --force-with-reason "local reminder-capacity check"
   ```
   **Expect:** `✓ Deletion complete.` and a receipt with `slug: <name>`, `status: deleted` and `database: database dropped`.
5. Remove the stand-in and the name file:
   ```bash
   rm /tmp/resend-standin.mjs /tmp/rc-check-name
   ```

## What to report back
For each of A–D: **passed**, or the step number and what you saw instead. For A.1 and C.2, paste the JSON.
