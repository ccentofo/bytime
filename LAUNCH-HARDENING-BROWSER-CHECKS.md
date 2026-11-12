# Launch hardening: browser checks (product owner)

About 30 minutes. Do them in order: later checks rely on data from earlier ones. Each step says what to click and what you should see. If anything differs, stop and tell Planning which step and what you saw.

## 0. Set up (Terminal, in the repo, on branch `launch-hardening`)
1. Build (this also clears the stale `.next` files behind the `tsc` noise):
   ```bash
   npm run build
   ```
2. Reset the local demo data (wipes and re-seeds the acme, globex and initech demo workspaces):
   ```bash
   npm run demo:local
   ```
3. Start the app and leave it running:
   ```bash
   AUTH_TRUST_HOST=true npm run start
   ```
4. In Chrome, open **http://acme.localhost:3000**.

**Accounts** (all use the password `Password123!`):

| Who | Email | Role |
|---|---|---|
| Admin User | `admin@cadenzpoint.dev` | admin (the only one, so they can approve their own timesheet) |
| Sarah Wilson | `sarah.wilson@cadenzpoint.dev` | supervisor |
| Jane Smith | `jane.smith@cadenzpoint.dev` | employee |

**To sign out:** click your name at the top right → **Sign out**.

---

## A. Notifications: nobody can turn off the daily reminder (H1)
1. Sign in as **Jane Smith** (employee). Click your name at the top right → **Notifications** (or go to `/profile/notifications`).
   **Expect:**
   - Under **Workflow Notifications**: two switches, **Timesheet Approved** and **Timesheet Returned for Corrections**.
   - Under **Reminder Notifications**: the sentence "Daily time entry reminders are always on. You’ll get one on weekdays when you haven’t entered time.", then one switch, **Period Submission Deadline Reminder**.
   - **No** "Daily Time Entry Reminder" switch.
2. Sign out. Sign in as **Sarah Wilson** (supervisor), then open **Notifications** again.
   **Expect:** three switches (Timesheet Submitted, Timesheet Approved, Timesheet Returned for Corrections), and **no "Reminder Notifications" section at all**.
3. Sign out. Sign in as **Admin User**, then open **Notifications**.
   **Expect:** the same as Sarah: three switches and no reminder section.

Stay signed in as Admin User.

## B. A new account's progress line counts from the day it was created (H4)
1. Go to **Users** (`/admin/users`) → **Add user**. Fill in:
   - Full name: `Pat Newhire`
   - Email: `pat.newhire@cadenzpoint.dev`
   - Role: **Supervisor**. Leave "CLINs they approve" empty.
   - Overtime status: **Exempt**
   - Approver: **Admin User**, if the field is shown
   - Temporary password: `Password123!`

   Click **Add user**.
2. Sign out. Sign in as `pat.newhire@cadenzpoint.dev` / `Password123!`. If it asks you to choose a new password, do so.
3. Click **Home** in the left menu (or go to `/home`). Look at the **Your timesheet** card.
   **Expect, on a weekday:** "0 hours entered. **0 of 1** workdays so far are filled in." Only today counts.
   **Before this fix** it read "0 of 9" on Nov 12: every weekday since Nov 1.
   **On a weekend:** just "0 hours entered.", with no second sentence.
4. Click **Timesheet** in the left menu. Read the grey line under the period heading.
   **Expect:** "0 hours entered · 0 of 1 workdays so far are filled in · Due Friday, Nov 13" (or "· Was due Nov 13" after that day). The key part is **0 of 1**, not 0 of 9.

Sign out.

## C. "Self-returned" on the employee screens (H2)
This needs a timesheet that the admin submits and then returns themself.

1. Sign in as **Admin User**. Give them a charge code:
   1. Go to **Assignments** (`/admin/assignments`). It opens on the **Charge code access** tab.
   2. Click **Give access**.
   3. Person: **Admin User**.
   4. Tick **any one** code.
   5. Click **Give access to 1 code**.
2. Go to **Timesheet**. Click the **‹** arrow ("Previous period") left of the period dates once. You should now see **Oct 16 – 31, 2026**, a past period still in draft.
3. Type `8` into the code's row for any two weekdays. Click **Save**.
   - A **Reason for Change** window opens, because the days are in the past.
   - Choose **Late entry**, type `browser check` in **Comments**, then click **Confirm Save**.
4. Click **Submit**.
   - In the **Submit Timesheet for Approval** window, tick the certification box.
   - Click **Submit Timesheet**.
5. Go to **Approvals** (`/admin/approvals`). Under **Waiting for you**, click **Admin User**.
   - In the review panel, type `browser check` in the comment box.
   - Click **Return for corrections**.
6. Go to **Timesheet**, then click **‹** back to **Oct 16 – 31, 2026**.
   **Expect:** a grey **Self-returned** badge next to the heading. **Not** "Self-rejected".
7. Go to **Past timesheets** (`/timesheet/history`) and find the **Oct 16 – 31** row.
   **Expect:** **Self-returned** in its Status column.

Stay signed in as Admin User.

## D. Connect QuickBooks, with JavaScript on (H5)
Your `.env.local` has a real QuickBooks client ID, so Connect really goes to Intuit.

1. Go to **Integrations** (`/settings/integrations`). On the **QuickBooks Online** card, click **Connect QuickBooks**.
   **Expect:** you arrive on Intuit's sign-in page (`accounts.intuit.com`). **Don't sign in.** Press the browser's Back button.
2. In the address bar, open **http://acme.localhost:3000/api/integrations/qbo-connect**.
   **Expect:** a 404 "not found" page. The old link is gone.
3. Open **http://acme.localhost:3000/api/integrations/gusto-connect**.
   **Expect:** a 404 as well.

## E. ~~Connect QuickBooks, with JavaScript off~~: withdrawn (2026-11-12)
The product owner ran it: with JavaScript off, the Integrations page shows only the settings menu, and the page body never appears. CadenzPoint needs JavaScript. The settings pages finish loading in a step that runs in the browser (`settings/loading.tsx`, unchanged by this branch), so there's no Connect button to click. No-JavaScript use isn't supported, so this check had nothing to test.

The security setting it targeted (`form-action` allowing `*.intuit.com`) only matters for a click in the split second before the page finishes loading. That is covered by test T15 and by the lead's redirect check with the real client ID (every hop is on `*.intuit.com`).

## F. Reconnect buttons, with an expired connection (H5)
The demo has no QuickBooks connection, so you'll create a fake expired one. It has no tokens, which the app shows as "needs reconnecting".

1. In a **second** Terminal tab:
   ```bash
   psql "postgresql://bytime:bytime_dev@localhost:5432/tenant_acme" -c "INSERT INTO integration_connections (provider, display_name, connected_by, external_company_id) SELECT 'quickbooks_online', 'QuickBooks — test', id, 'test-realm' FROM users WHERE email='admin@cadenzpoint.dev';"
   ```
   It should print `INSERT 0 1`.
2. In the browser, reload `/settings/integrations`.
   **Expect:** the QuickBooks card shows **Reconnect** and **Open**.
3. Click **Reconnect**.
   **Expect:** Intuit's sign-in page. Don't sign in; press Back.
4. Click **Open** (this is the QuickBooks page), then click its **Reconnect** button.
   **Expect:** Intuit's sign-in page again. Press Back.
5. Remove the fake connection:
   ```bash
   psql "postgresql://bytime:bytime_dev@localhost:5432/tenant_acme" -c "DELETE FROM integration_connections WHERE external_company_id = 'test-realm';"
   ```
   It should print `DELETE 1`.

## G. "QuickBooks isn't set up" message (H5: the error message still appears)
1. In the first Terminal tab, stop the app (Ctrl+C), then restart it with QuickBooks switched off for this run only:
   ```bash
   QBO_CLIENT_ID= AUTH_TRUST_HOST=true npm run start
   ```
2. Sign in as **Admin User** if needed. Go to `/settings/integrations` and click **Connect QuickBooks**.
   **Expect:** you stay in CadenzPoint, and a banner says "QuickBooks isn’t set up for this server yet. Contact support."
3. Stop the app (Ctrl+C). Start it normally again if you want to keep using it:
   ```bash
   AUTH_TRUST_HOST=true npm run start
   ```

---

## When you're done
Tell Planning one of:
- "all checks passed", or
- the step letter and number that failed, and what you saw.

After a pass, and once CI is green on the PR, Planning gives you the merge and tag commands. The demo data you added (Pat Newhire, the admin's code and the returned timesheet) is wiped by the next `npm run demo:local`.
