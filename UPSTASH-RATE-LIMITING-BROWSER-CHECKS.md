# Shared rate limits (Upstash): checks

**Run by Planning** against the finished branch (product owner decision 2026-11-13). The results, with screenshots and outputs, go into `UPSTASH-RATE-LIMITING-AUDIT.md` §6; the product owner reviews those. Everything here runs locally in **memory mode**: no Upstash variables are set, so the shared limits use the in-process fallback, which counts the same way inside one server process. The real Upstash path is checked at staging, PRODUCTION-DEPLOY step 12.14.

> **Status:** DRAFT, 2026-11-13. Rehearsed against the finished branch at audit time. Two details are confirmed then and noted inline: which IP the local server sees for browser requests, and how a local password-reset email shows in the server log.

**Setup facts**
- **The app:** started with the preview tool's `app-dev` config (`npm run dev` on port 3000). Browser steps use the preview browser on `http://acme.localhost:3000`; scripted steps use `/tmp/url-check.sh`.
- **Accounts** (the local demo, password `Password123!`): `admin@cadenzpoint.dev`, `jane.smith@cadenzpoint.dev`, `john.doe@cadenzpoint.dev`, `emily.davis@cadenzpoint.dev`, `robert.taylor@cadenzpoint.dev`.
- **The IP the app sees:** locally, a client-supplied `x-forwarded-for` reaches the app (only Vercel overwrites it), so the helper simulates distinct addresses with documentation IPs (`203.0.113.x`).

## 0. Set up

### 0.1 The helper
```bash
cat > /tmp/url-check.sh <<'EOF'
#!/bin/bash
# Helper for UPSTASH-RATE-LIMITING-BROWSER-CHECKS.md. Usage: bash /tmp/url-check.sh <step> [args]
set -uo pipefail
H=acme.localhost; B="http://$H:3000"; R=(--resolve "$H:3000:127.0.0.1")
# signin <ip> <email> <password>: one credentials sign-in; prints the outcome code (ok / rate_limited / CredentialsSignin / mfa_required …)
signin() {
  local jar; jar=$(mktemp); local csrf
  csrf=$(curl -sS "${R[@]}" -c "$jar" -b "$jar" -H "X-Forwarded-For: $1" "$B/api/auth/csrf" | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["csrfToken"])') || { echo "STOP: app not running"; exit 1; }
  local loc
  loc=$(curl -sS "${R[@]}" -o /dev/null -w '%{redirect_url}' -c "$jar" -b "$jar" -H "X-Forwarded-For: $1" \
    --data-urlencode "csrfToken=$csrf" --data-urlencode "email=$2" --data-urlencode "password=$3" "$B/api/auth/callback/credentials")
  rm -f "$jar"
  python3 -I -c 'import sys,urllib.parse as u; q=u.parse_qs(u.urlparse(sys.argv[1]).query); print(q.get("code",[q.get("error",["ok"])[0]])[0])' "$loc"
}
EMAILS=(admin jane.smith john.doe emily.davis robert.taylor)
case "${1:-}" in
  fail)   # fail <ip> <n>: n wrong-password sign-ins spread over 5 accounts (4 each max, under the per-email lockout)
    for i in $(seq 1 "$3"); do e="${EMAILS[$(( (i-1) % 5 ))]}@cadenzpoint.dev"; echo "$i $(signin "$2" "$e" wrong-password)"; done ;;
  good)   # good <ip> [n]: n correct sign-ins as jane.smith
    for i in $(seq 1 "${3:-1}"); do echo "$i $(signin "$2" jane.smith@cadenzpoint.dev 'Password123!')"; done ;;
  slug)   # slug <ip> <n>: n workspace-name availability checks
    for i in $(seq 1 "$3"); do echo "$i $(curl -sS "${R[@]}" -o /dev/null -w '%{http_code}' -H "X-Forwarded-For: $2" "$B/signup/check?slug=zz-check-$i")"; done ;;
  report) # report <n>: n cost CSV requests as the admin (memory limit, unchanged)
    jar=$(mktemp); csrf=$(curl -sS "${R[@]}" -c "$jar" -b "$jar" "$B/api/auth/csrf" | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["csrfToken"])')
    curl -sS "${R[@]}" -o /dev/null -c "$jar" -b "$jar" --data-urlencode "csrfToken=$csrf" --data-urlencode "email=admin@cadenzpoint.dev" --data-urlencode 'password=Password123!' "$B/api/auth/callback/credentials"
    for i in $(seq 1 "$2"); do echo "$i $(curl -sS "${R[@]}" -o /dev/null -w '%{http_code}' -b "$jar" "$B/api/reports/cost-report-csv?startDate=2026-10-01&endDate=2026-10-31")"; done; rm -f "$jar" ;;
  *) echo "Usage: bash /tmp/url-check.sh fail <ip> <n> | good <ip> [n] | slug <ip> <n> | report <n>"; exit 1 ;;
esac
EOF
```
Then `bash /tmp/url-check.sh`. **Expect:** the usage line.

### 0.2 Reset the demo and start the app
1. `npm run demo:local` → expect `✅ Local demo ready.` in the output (it also applies the new migration).
2. Start the preview server `app-dev` and wait until `http://acme.localhost:3000/login` loads.

## A. Failed sign-ins are limited per IP (Q2)
1. `bash /tmp/url-check.sh fail 203.0.113.10 20`
   **Expect:** 20 lines, each `CredentialsSignin` (the normal wrong-password outcome).
2. `bash /tmp/url-check.sh good 203.0.113.10`
   **Expect:** `1 rate_limited`: the **right** password is refused once the address has 20 failures.
3. `bash /tmp/url-check.sh good 203.0.113.11`
   **Expect:** `1 ok`: a different address isn't affected.

## B. The message in the browser (Q2)
1. The preview browser sends no `x-forwarded-for`, so the app sees whatever the local server supplies: `x-real-ip` or nothing, giving the shared `ip:unknown` bucket. Which one is confirmed at rehearsal from one browser request. Exhaust that bucket: `bash /tmp/url-check.sh fail <that address, or the word unknown> 20`. (`unknown` works because a header value of `unknown` normalizes to the same `ip:unknown` bucket.)
2. In the preview browser, open `http://acme.localhost:3000/login`, fill **Email** `jane.smith@cadenzpoint.dev` and **Password** `Password123!`, click **Sign In**.
   **Expect** the error text, exactly: `Too many failed sign-in attempts from your network. Try again in 15 minutes.` Screenshot it.

## C. Successful sign-ins aren't counted (Q2 refunds)
1. `bash /tmp/url-check.sh good 203.0.113.12 25`
   **Expect:** 25 lines of `ok`.
2. `bash /tmp/url-check.sh fail 203.0.113.12 3` then `bash /tmp/url-check.sh good 203.0.113.12`
   **Expect:** three `CredentialsSignin`, then `ok`.

## D. Password-reset requests are limited per IP, silently (Q3)
In the preview browser, open `http://acme.localhost:3000/forgot-password` and submit it 11 times with 11 different addresses (`reset1@example.com` … `reset11@example.com`), each a fresh page load.
**Expect:** all 11 show the same generic confirmation text (taken from the page at rehearsal). The server log shows a send attempt for requests 1–10 only (the local log line for an email send is confirmed at rehearsal). Requests from the preview browser share one address, so run this after B's bucket has reset, or note which bucket it uses.

## E. Workspace-name lookups keep their limit (Q4, now shared)
`bash /tmp/url-check.sh slug 203.0.113.20 31`
**Expect:** 30 lines of `200`, then `31 429`.

## F. Memory limits are unchanged (Q4)
`bash /tmp/url-check.sh report 11`
**Expect:** ten `200` lines, then `11 429`, exactly as before this item.

## G. Clean up
1. Stop the preview server.
2. `npm run demo:local` → expect `✅ Local demo ready.`
3. `rm -f /tmp/url-check.sh`

## What gets recorded in the audit
For each of A–F: the commands' output, B's screenshot, and anything that differed.
