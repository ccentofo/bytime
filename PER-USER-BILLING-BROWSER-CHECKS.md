# Per-user billing: checks

**Run by Planning** against the finished branch (the product owner's decision, 2026-11-13). Results go into `PER-USER-BILLING-AUDIT.md` with screenshots and outputs, and the product owner reviews those.

Everything here runs locally **without a Stripe key**. Steps that need Stripe test mode (checkout, quantity updates, ACH, invoices, renewals) run at the staging rehearsal: PRODUCTION-DEPLOY 12.8 and 12.8b, as rewritten by the blueprint §12.

> **Status: RUN by Planning on 2026-11-15 against `77c103a`** (results in `PER-USER-BILLING-AUDIT.md` §7). The rehearsal added the 60-second cache note, the window-width note, the exact Section I refusal texts and the `prune` step; the helper block was re-rehearsed verbatim after the edit.

**Setup facts**
- **The app:** start it with the preview tool's `app-dev` config (`npm run dev` on port 3000). Browser steps use the preview browser on `http://<workspace>.localhost:3000`.
- **The workspace:** every check uses a **throwaway workspace** with a fresh name saved in `/tmp/pub-check-name`. Each helper step reads that file; never a shell variable.
  - Its admin is `admin@<name>.test`, password `Password123!`.
  - Billing states are set by SQL on its control-plane row, through the helper.
- **The app caches workspace facts for 60 seconds.** The Billing page reads them fresh, but other pages (the read-only banner, the suspended wall, access) can show the previous state for up to a minute after a helper step. Wait one minute before checking those.
- **Window width:** use a browser window at least 768 px wide; the header's `Pricing` link and other `sm` items are hidden below that by design.
- **No Stripe key locally:** the Billing page can't read invoices, so `payUrl` is empty. Where a Pay button would show, expect the fallback text `Use Manage billing to pay.` The page must still render.

## 0. Set up

### 0.1 The helper
This writes `/tmp/pub-check.sh`, which the later steps call. Copy the whole block, from the `cat` line to the closing `EOF`, and paste it once.
```bash
cat > /tmp/pub-check.sh <<'EOF'
#!/bin/bash
# Helper for PER-USER-BILLING-BROWSER-CHECKS.md. Usage: bash /tmp/pub-check.sh <step>
set -uo pipefail
[ -f package.json ] || { echo "STOP: run this from the repo folder." >&2; exit 1; }
PG=postgresql://bytime:bytime_dev@localhost:5432
CP="$PG/bytime_control"
NAME_FILE=/tmp/pub-check-name
name() {
  [ -s "$NAME_FILE" ] || { echo "STOP: no workspace yet. Run: bash /tmp/pub-check.sh new" >&2; exit 1; }
  cat "$NAME_FILE"
}
cp_sql() { psql "$CP" -v ON_ERROR_STOP=1 -q -c "$1"; }
reset_facts() {
  cp_sql "UPDATE tenants SET status='active', plan='trial', plan_interval=NULL, subscription_status=NULL,
    stripe_subscription_id=NULL, stripe_customer_id=NULL, current_period_end=NULL, first_good_at=NULL,
    past_due_since=NULL, suspended_at=NULL, suspension_reason=NULL, subscription_ended_at=NULL,
    deletion_scheduled_for=NULL, collection_method=NULL, subscription_cancel_at_period_end=false,
    trial_ends_at=now() + interval '18 days', lifecycle_version=lifecycle_version+1 WHERE slug='$(name)';
    DELETE FROM tenant_seat_billing WHERE tenant_id=(SELECT id FROM tenants WHERE slug='$(name)');"
}
paid() {  # paid <interval>: a GOOD Standard subscription renewing in 20 days
  cp_sql "UPDATE tenants SET plan='standard', plan_interval='$1', subscription_status='active',
    stripe_customer_id='cus_check_$(name)', stripe_subscription_id='sub_check_$(name)',
    collection_method='charge_automatically', current_period_end=now() + interval '20 days',
    first_good_at=now() - interval '40 days', lifecycle_version=lifecycle_version+1 WHERE slug='$(name)';"
}
case "${1:-}" in
  new)
    echo "pub$(date +%m%d%H%M)" > "$NAME_FILE"
    N=$(name); echo "Workspace name: $N"
    psql "$PG/bytime" -c "CREATE DATABASE \"bytime_$N\"" || exit 1
    npm run seed:tenant -- "$N" "$PG/bytime_$N" && reset_facts && echo "Ready: http://$N.localhost:3000 (admin@$N.test)"
    ;;
  trial)     reset_facts; echo "state: trial, 18 days left" ;;
  monthly)   reset_facts; paid month; echo "state: Standard monthly, active" ;;
  annual)    reset_facts; paid year; echo "state: Standard annual, active" ;;
  ending)    reset_facts; paid month; cp_sql "UPDATE tenants SET subscription_cancel_at_period_end=true WHERE slug='$(name)';"; echo "state: active, cancels at period end" ;;
  held)      # held <q>: Stripe quantity held at q (Q1)
    reset_facts; paid month
    cp_sql "INSERT INTO tenant_seat_billing (tenant_id, stripe_subscription_id, stripe_quantity, billable_count, checked_at)
      SELECT id, stripe_subscription_id, ${2:?usage: held <quantity>}, 1, now() FROM tenants WHERE slug='$(name)';"
    echo "state: active, billed for $2" ;;
  overdue)   reset_facts; paid month; cp_sql "UPDATE tenants SET subscription_status='past_due', past_due_since=now() - interval '3 days' WHERE slug='$(name)';"; echo "state: payment overdue" ;;
  suspended) reset_facts; paid month; cp_sql "UPDATE tenants SET status='suspended', suspension_reason='nonpayment', suspended_at=now() - interval '1 day', subscription_status='past_due', past_due_since=now() - interval '16 days' WHERE slug='$(name)';"; echo "state: suspended for non-payment" ;;
  inv-open)  reset_facts; paid year; cp_sql "UPDATE tenants SET collection_method='send_invoice', subscription_status='past_due' WHERE slug='$(name)';"; echo "state: invoiced, past_due, nothing overdue" ;;
  ended)     reset_facts; paid month; cp_sql "UPDATE tenants SET subscription_status='canceled', subscription_ended_at=now() - interval '2 days', deletion_scheduled_for=now() + interval '88 days' WHERE slug='$(name)';"; echo "state: canceled" ;;
  users)     # users <n>: make the workspace have exactly n active users (adds inactive-free test users)
    N=$(name); want=${2:?usage: users <n>}
    have=$(psql "$PG/bytime_$N" -Atc "SELECT count(*) FROM users WHERE is_active") || exit 1
    add=$(( want - have )); [ "$add" -le 0 ] && { echo "already $have active"; exit 0; }
    psql "$PG/bytime_$N" -v ON_ERROR_STOP=1 -q -c "INSERT INTO users (email, full_name, role, is_active, flsa_exempt)
      SELECT 'u'||g||'@$N.test', 'User '||g, 'employee', true, false FROM generate_series($have + 1, $want) g;"
    echo "active users: $(psql "$PG/bytime_$N" -Atc "SELECT count(*) FROM users WHERE is_active")" ;;
  prune)     # deactivate every test user added by `users` or the drawer (direct SQL: no seat-sync mark)
    N=$(name); psql "$PG/bytime_$N" -v ON_ERROR_STOP=1 -q -c "UPDATE users SET is_active=false WHERE email LIKE 'u%@$N.test' OR email LIKE '%@pubcheck.test';"
    echo "active users: $(psql "$PG/bytime_$N" -Atc "SELECT count(*) FROM users WHERE is_active")" ;;
  seatrow)   psql "$CP" -c "SELECT sync_due_at IS NOT NULL AS due, mark_seq, stripe_quantity, failures FROM tenant_seat_billing WHERE tenant_id=(SELECT id FROM tenants WHERE slug='$(name)');" ;;
  cron)      curl -sS -H "Authorization: Bearer devsecret" http://localhost:3000/api/cron/seat-sync; echo ;;
  delete)    N=$(name); npm run tenant:delete -- "$N" --yes --force-with-reason "local per-user billing check" && rm -f "$NAME_FILE" ;;
  *) echo "Usage: bash /tmp/pub-check.sh new|trial|monthly|annual|ending|held <q>|overdue|suspended|inv-open|ended|users <n>|prune|seatrow|cron|delete"; exit 1 ;;
esac
EOF
```
Then run `bash /tmp/pub-check.sh`. **Expect:** the usage line.

### 0.2 Reset the demo and start the app
1. Run `npm run demo:local`. **Expect:** `✅ Local demo ready.` (this also applies the control-plane migration).
2. Start the preview server `app-dev` and wait until `http://acme.localhost:3000/login` loads.
3. Run `bash /tmp/pub-check.sh new`. **Expect:** `Ready: http://pub….localhost:3000 (admin@pub….test)`.
4. In the preview browser, sign in at that address as `admin@<name>.test` / `Password123!`.

## A. Landing Pricing
1. Open `http://localhost:3000/`.
2. **Expect** a header with `Features`, then `Pricing`.
3. Click `Pricing`. **Expect** the page to scroll to the heading `Pricing`, followed by three cards:
   - **Trial:** `Free for 30 days`, `Up to 10 users. No credit card required.`, and the button `Start free trial`;
   - **Standard:** `$10 / user / month`, `$50 minimum (covers up to 5 users)`, `$8.50 / user / month, billed annually`, `$510 minimum per year (covers up to 5 users)` and `Up to 100 users`;
   - **Enterprise:** `Contact us`, linking to `mailto:support@cadenzpoint.com?subject=CadenzPoint%20Enterprise`, and `More than 100 users, invoicing, or custom terms`.
4. **Expect:** no text containing "tax" anywhere in the Pricing section.

## B. Billing page: trial
1. Run `bash /tmp/pub-check.sh trial`, then open **Settings → Billing** (`/settings/billing`).
2. **Expect** three tiles:

| Tile | Big text | Small text |
|---|---|---|
| Plan | `Free trial` | `Ends <date 18 days out> · 18 days left` |
| Users | `1 of 10 used`, with a bar | `Active users count. Inactive users don't.` |
| Payment | `None yet` | `Choose a plan before your trial ends to keep editing.` |

3. **Expect** the heading `Choose a plan`, then three cards:
   - `Standard, monthly`, with the monthly strings and `Up to 100 users`. Its `Choose monthly` button is disabled and shows `Not available yet.` (no price env locally).
   - `Standard, annual`, the same, with `Choose annual`.
   - `Enterprise`, with a `Contact us` link to the mailto.
4. **Expect** the line below the cards: `You'll finish on Stripe's secure checkout page. Pay by card or US bank account, and enter a promotion code there if you have one.`
5. **Expect:** no raw status words (`past_due`, `active`) anywhere on the page.

## C. Billing page: Standard states
For each row, run the helper step, reload `/settings/billing` and compare the tiles.

| Step | Plan | Users | Payment |
|---|---|---|---|
| `monthly` | `Standard` / `Billed monthly` | `1 active user` / `You pay for each active user. The minimum covers 5. Up to 100 users.` | `Active` / `Renews <date 20 days out>` |
| `annual` | `Standard` / `Billed annually` | as above | as above |
| `ending` | `Standard` / `Billed monthly` | as above | `Active` / `Ends <date 20 days out>` |
| `held 9` | as monthly | `1 active user` / `Billed for 9 users until <date>. Removed users leave your bill at renewal.` | `Active` / `Renews <date>` |
| `held 4` | as monthly | the standard line, **not** "Billed for 4" (the held line applies only above 5) | as monthly |
| `overdue` | as monthly | as monthly | `Payment overdue` / `Pay the open invoice to avoid suspension.` / `Use Manage billing to pay.` |
| `inv-open` | `Standard` / `Billed annually` | as monthly | `Invoice open` / `Pay it by the due date on the invoice.` |
| `ended` | `Standard` / *(no small text)* | `1 active user` / *(no small text)* | `Canceled` / `Ended on <date 2 days ago>. Choose a plan to start again.` |

**Expect for every row except `ended`:** no `Choose a plan` cards, and the line `Use Manage billing to update your payment method, see invoices or cancel.` For `ended`, the cards show.

## D. BillingWall when suspended
1. Run `bash /tmp/pub-check.sh suspended`, **wait one minute** (the cache), then reload any page.
2. **Expect** the full-page wall: the h1 `Workspace suspended`, then the Billing header as an h2.
3. **Expect** the Payment tile: `Suspended` / `Pay the open invoice to restore access.` / `Use Manage billing to pay.`
4. **Expect:** the page renders (no error screen), and the heading order is h1, then h2 `Billing`.

## E. Users page seat line
1. Run `bash /tmp/pub-check.sh trial`, **wait one minute**, then open **People → Users** (`/admin/users`).
   - **Expect** the seat line `1 active · 9 of 10 seats free`.
   - Open **Add user**. **Expect** `Uses 1 of 9 free seats` in the drawer.
2. Run `bash /tmp/pub-check.sh monthly`, then reload.
   - **Expect** `1 active · up to 100`.
   - Open **Add user**. **Expect:** no "free seats" line.

## F. The 100-user cap
1. Run `bash /tmp/pub-check.sh monthly`, then `bash /tmp/pub-check.sh users 100`. **Expect:** `active users: 100`.
2. On **People → Users**, open **Add user**, fill Full name, Email, overtime status and a temporary password, and click **Add user**.
   - **Expect** the error, exactly: `Your plan covers up to 100 users. Contact us at support@cadenzpoint.com to add more.`
3. Run `bash /tmp/pub-check.sh trial` (the plan goes back to trial with 100 users).
   - Try to add one. **Expect** today's trial message, starting `Your Trial plan allows 10 active users`.

## G. Enterprise
1. Run `bash /tmp/pub-check.sh monthly`, then `npm run tenant:admin -- set-plan "$(cat /tmp/pub-check-name)" enterprise`.
   - **Expect:** a preview line (`Would: …`) and `Dry run — pass --yes to apply.`
2. Run `npm run tenant:admin -- set-plan "$(cat /tmp/pub-check-name)" enterprise --yes`. **Expect** an After block with `plan: enterprise`.
3. Reload Billing. **Expect** Plan `Enterprise` / `Custom terms`, and Users `100 active users` / `No user limit.`
4. Add user 101 on Admin → Users. **Expect:** success.
5. Run `npm run tenant:admin -- set-plan "$(cat /tmp/pub-check-name)" standard --yes`. **Expect** `plan: standard`.

## H. The seat-sync mark and cron
1. Run `bash /tmp/pub-check.sh prune` (**expect** `active users: 1`), then `bash /tmp/pub-check.sh trial`, then `bash /tmp/pub-check.sh seatrow`. **Expect** no rows.
2. Add a user on Admin → Users, then `bash /tmp/pub-check.sh seatrow`. **Expect** `due = t`, `mark_seq = 1`.
3. Deactivate that user, then `seatrow`. **Expect** `mark_seq = 2`.
4. Rename a different user, then `seatrow`. **Expect** `mark_seq` still `2`.
5. Run `bash /tmp/pub-check.sh cron`. **Expect** a JSON summary with this workspace counted as `not-applicable` (no subscription).
6. Run `seatrow` again. **Expect** `due = f`.

## I. Founder commands: Stripe-mode guard
1. Run `npm run tenant:admin -- ensure-customer "$(cat /tmp/pub-check-name)" --yes`.
   - **Expect** (no Stripe key locally): `✗ STRIPE_SECRET_KEY is missing or not a recognizable Stripe key …`; no customer is created.
   - Then `STRIPE_SECRET_KEY=sk_test_dummy npm run tenant:admin -- ensure-customer "$(cat /tmp/pub-check-name)" --yes`. **Expect** `✗ This command calls Stripe. Pass --stripe-mode live|test …`.
   - Then the same with `--stripe-mode live`. **Expect** `✗ --stripe-mode live doesn't match the key … refusing.`
2. Run `npm run tenant:admin -- show "$(cat /tmp/pub-check-name)"`.
   - **Expect** the lines `plan: … (month|year)`, `collection_method:`, `seat sync:` and `active users (live count):`.

## J. Clean up
1. Run `bash /tmp/pub-check.sh delete`. **Expect** the deletion to finish and `/tmp/pub-check-name` to be removed.
2. Run `rm -f /tmp/pub-check.sh`.

## What to record in the audit
For each section A–I: pass or fail, a screenshot of each Billing state (B, C rows, D), and the helper and command outputs. Steps needing Stripe are marked "staging (12.8/12.8b)", not "passed".
