# Shared rate limits (Upstash): checks

**Run by Planning** against the finished branch (product owner decision 2026-11-13). The results, with screenshots and outputs, go into `UPSTASH-RATE-LIMITING-AUDIT.md` §6; the product owner reviews those. Everything here runs locally in **memory mode**: no Upstash variables are set, so the shared limits use the in-process fallback, which counts the same way inside one server process. The real Upstash path is checked at staging, PRODUCTION-DEPLOY step 12.14.

> **Status:** RUN by Planning 2026-11-13 against `c3e3ad8` (results in the audit §6). The rehearsal fixed: the helper's failure code (`credentials`), failures on non-existent emails (no lockout interference), B's loopback buckets, D's proof via the token table, and F's own sign-in address.

**Setup facts**
- **The app:** started with the preview tool's `app-dev` config (`npm run dev` on port 3000). Browser steps use the preview browser on `http://acme.localhost:3000`; scripted steps use `/tmp/url-check.sh`.
- **Accounts** (the local demo, password `Password123!`): `sarah.wilson@cadenzpoint.dev` signs in successfully; failed sign-ins use unique non-existent emails, so no real account hits the per-email lockout.
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
  local out
  out=$(curl -sS "${R[@]}" -o /dev/null -w '%{http_code} %{redirect_url}' -c "$jar" -b "$jar" -H "X-Forwarded-For: $1" \
    --data-urlencode "csrfToken=$csrf" --data-urlencode "email=$2" --data-urlencode "password=$3" "$B/api/auth/callback/credentials")
  rm -f "$jar"
  # ok only for a redirect with no error and no csrf flag; anything else is shown as is
  python3 -I -c '
import sys, urllib.parse as u
status, _, loc = sys.argv[1].partition(" ")
if not loc: print("NO_REDIRECT", status); sys.exit()
q = u.parse_qs(u.urlparse(loc).query)
print(q["code"][0] if "code" in q else q["error"][0] if "error" in q else "CSRF" if "csrf" in q else "ok")' "$out"
}
case "${1:-}" in
  fail)   # fail <ip> <n>: n failed sign-ins, each for a different non-existent email (no real account gets locked)
    run=$RANDOM; for i in $(seq 1 "$3"); do echo "$i $(signin "$2" "nobody-$run-$i@example.com" wrong-password)"; done ;;
  good)   # good <ip> [n]: n correct sign-ins as sarah.wilson (no check below makes her fail)
    for i in $(seq 1 "${3:-1}"); do echo "$i $(signin "$2" sarah.wilson@cadenzpoint.dev 'Password123!')"; done ;;
  slug)   # slug <ip> <n>: n workspace-name availability checks
    for i in $(seq 1 "$3"); do echo "$i $(curl -sS "${R[@]}" -o /dev/null -w '%{http_code}' -H "X-Forwarded-For: $2" "$B/signup/check?slug=zz-check-$i")"; done ;;
  report) # report <n>: n cost CSV requests as the admin (memory limit, unchanged); signs in from its own address
    X=(-H "X-Forwarded-For: 203.0.113.40")
    jar=$(mktemp); csrf=$(curl -sS "${R[@]}" "${X[@]}" -c "$jar" -b "$jar" "$B/api/auth/csrf" | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["csrfToken"])')
    curl -sS "${R[@]}" "${X[@]}" -o /dev/null -c "$jar" -b "$jar" --data-urlencode "csrfToken=$csrf" --data-urlencode "email=admin@cadenzpoint.dev" --data-urlencode 'password=Password123!' "$B/api/auth/callback/credentials"
    curl -sS "${R[@]}" -b "$jar" "$B/api/auth/session" | grep -q admin@cadenzpoint.dev && echo "signed in as admin" || { echo "STOP: admin sign-in failed (lockout? run F first)"; rm -f "$jar"; exit 1; }
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
   **Expect:** 20 lines, each `credentials` (Auth.js's normal failed sign-in code).
2. `bash /tmp/url-check.sh good 203.0.113.10`
   **Expect:** `1 rate_limited`: the **right** password is refused once the address has 20 failures.
3. `bash /tmp/url-check.sh good 203.0.113.11`
   **Expect:** `1 ok`: a different address isn't affected.

## B. The message in the browser (Q2)
1. The preview browser sends no `x-forwarded-for`, and the local dev server supplies its loopback address (rehearsed 2026-11-13: the browser was **not** in the `unknown` bucket). Exhaust both loopback forms: `bash /tmp/url-check.sh fail ::1 20` and `bash /tmp/url-check.sh fail 127.0.0.1 20`.
2. In the preview browser (signed out: `/api/auth/signout` → **Sign out**), open `http://acme.localhost:3000/login`, fill **Email** `sarah.wilson@cadenzpoint.dev` and **Password** `Password123!`, click **Sign In**.
   **Expect** the error text, exactly: `Too many failed sign-in attempts from your network. Try again in 15 minutes.` Screenshot it.

## C. Successful sign-ins aren't counted (Q2 refunds)
1. `bash /tmp/url-check.sh good 203.0.113.12 25`
   **Expect:** 25 lines of `ok`.
2. `bash /tmp/url-check.sh fail 203.0.113.12 3` then `bash /tmp/url-check.sh good 203.0.113.12`
   **Expect:** three `credentials`, then `ok`.

## D. Password-reset requests are limited per IP, silently (Q3)
The forgot-password page has no "send again" button, so each request is a fresh page load. A request for an address that doesn't exist sends nothing, and locally no email provider is set. So the proof is the database: a reset token is written only when an email would be sent.
1. In the preview browser, open `http://acme.localhost:3000/forgot-password` and, one page load each, submit **Email** `reset1@example.com` … `reset10@example.com`, clicking **Send Reset Link**. (Scripted in the page: set the field value through the native input setter, dispatch `input`, click the submit button, wait for the confirmation.)
   **Expect** every time: "If an account exists with that email, we've sent a password reset link. Please check your inbox (and spam folder)."
2. An 11th request, for a real account: `sarah.wilson@cadenzpoint.dev`.
   **Expect:** the same text.
3. `psql -h localhost -d tenant_acme -Atc "select count(*) from password_reset_tokens where email='sarah.wilson@cadenzpoint.dev'"`
   **Expect:** `0`. The 11th request was refused silently.
4. **Control:** restart the preview server (memory mode forgets its counts), then make one request for `sarah.wilson@cadenzpoint.dev` and re-run the query.
   **Expect:** `1`. A request inside the limit does create the token.

## E. Workspace-name lookups keep their limit (Q4, now shared)
`bash /tmp/url-check.sh slug 203.0.113.20 31`
**Expect:** 30 lines of `200`, then `31 429`.

## F. Memory limits are unchanged (Q4)
`bash /tmp/url-check.sh report 11`
**Expect:** `signed in as admin`, ten `200` lines, then `11 429`, exactly as before this item.

## G. Clean up
1. Stop the preview server.
2. `npm run demo:local` → expect `✅ Local demo ready.`
3. `rm -f /tmp/url-check.sh`

## What gets recorded in the audit
For each of A–F: the commands' output, B's screenshot, and anything that differed.
