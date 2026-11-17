# Founder accounts setup

**For:** the founder. **Written by:** CadenzPoint Planning, 2026-11-16. **Used by:** blueprint 3b (backups) and later 3c and 3d.

**Sources:** every menu path below was checked against the official help pages on 2026-11-16 (Google Workspace Admin Help, AWS documentation, GitHub Docs, Neon Docs, the Yubico store). Screens change. If a label differs slightly, look for the nearest match. Where the docs didn't confirm a label, the step says so.

## What this sets up, and why

| Account | What it's for | Cost | When |
|---|---|---|---|
| **Google Workspace** on `cadenzpoint.com` (you own it) | Business email: `support@`, `privacy@`, `legal@`, `dmarc@`, plus `infra@` for infrastructure accounts. Keeps your personal inbox out of it, and the accounts belong to the business. | ~$7–8/month (Business Starter, one user) | **Now** |
| **Two hardware security keys** | The login second factor for Google, AWS and GitHub. Phishing can't steal them. | $29–58 each, one-time | **Now** (order today) |
| **GitHub** (your existing `ccentofo` account) | Holds the code and the "Approve" button for backup deploys. | Free (the repo is public) | Harden now; set up the environment after 3b is built |
| **AWS** (a new account used **only** for backups) | Stores the encrypted backups and runs the backup jobs. | Under $10/month; free credits cover most of year one | **Now**, or any time before 3b is deployed |
| **Neon** (your existing account) | One extra project where the weekly restore tests run. | A few cents a week | When 3b is ready to deploy |

**You never download customer data in any of this.** After setup, you only:
- read the daily digest;
- approve a backup-system deploy when its code changes (rare);
- update one AWS setting if production's `ENCRYPTION_KEY` or control-plane database password ever changes (part of that change's checklist);
- press 3c's disaster button if Neon ever loses a database.

## Order of operations
1. **Today:** order two security keys (Part 1). Make sure your password manager is in place.
2. **Part 2:** Google Workspace. Takes about an hour, plus up to 72 hours of DNS waiting.
3. **Part 3:** harden GitHub, about 15 minutes, once the keys arrive.
4. **Part 4:** create the AWS account, about 45 minutes, once the keys arrive and `infra@` receives mail.
5. **Parts 5–6:** after 3b is built. I'll tell you when, and we do it together.

---

## Part 1. Security keys and your recovery kit

### 1.1 Buy two keys
Any FIDO2 key works with Google, AWS and GitHub. Buy **two of the same model**: one you carry, and one kept somewhere safe away from your desk (a home safe, or a family member's house).

| Model (yubico.com) | Plugs into | Price |
|---|---|---|
| **Security Key C NFC by Yubico** | USB-C, and tap on a phone | $29 |
| Security Key NFC by Yubico | USB-A, and tap on a phone | $29 |
| YubiKey 5C NFC | USB-C, and tap on a phone (plus extra features you don't need) | $58 |
| YubiKey 5 NFC | USB-A, and tap on a phone | $58 |

**Recommended:** two **Security Key C NFC** ($58 total) if your Mac has USB-C. Buy from yubico.com or an authorized seller, never a marketplace reseller.

### 1.2 Your recovery kit
For each account below you'll save some recovery items: a password, backup codes, and recovery codes.
- Keep them in your **password manager**, one entry per account.
- Also print the backup codes and keep the printout with the spare key.

Losing every factor for the AWS root login, or for your Google super admin, is the one situation that's slow and painful to fix. The kit prevents it.

**Every time you add a security key anywhere in this guide, add both keys,** one after the other.

---

## Part 2. Google Workspace (`cadenzpoint.com`)

You sign in to two places:
- **Gmail** (`mail.google.com`), where you read and send mail;
- **the Admin console** (`admin.google.com`), where you manage the domain, addresses and security. Menu paths below start from the **Menu** (☰) at the top left of the Admin console.

### 2.1 Check the domain and Gmail are live
1. Open `admin.google.com` and sign in.
2. If you see a **Set up Admin Console** prompt at the top of the dashboard, the domain isn't verified yet. Follow it.
3. Go to **Menu → Account → Domains → Manage domains**. The **Status** column shows each domain's state. (The docs don't give the exact wording; look for "verified" and "Gmail activated".)
4. If you see **Activate Gmail** next to `cadenzpoint.com`, click it and follow the steps. You'll add the MX record below.

### 2.2 DNS records for Google mail
Add these at your DNS host (wherever `cadenzpoint.com`'s DNS is managed). They don't conflict with Resend's records, which live on Resend's own subdomain (`BUSINESS-DECISIONS.md` §6).

| Type | Name / Host | Value | Notes |
|---|---|---|---|
| MX | `@` (or blank) | `smtp.google.com` | Priority `1`. **Remove any other MX records** on `@`. Some DNS hosts want a trailing dot: `smtp.google.com.` |
| TXT | `@` | `v=spf1 include:_spf.google.com ~all` | Only **one** SPF record on `@`. If one exists, edit it rather than adding a second. |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@cadenzpoint.com` | Already in your business plan (§6 step 3). |

New MX records can take **up to 72 hours** to be recognized.

### 2.3 Turn on DKIM (signing your mail)
Wait **24–72 hours after Gmail is activated**; generating the key too early can error.
1. **Menu → Apps → Google Workspace → Gmail → Authenticate email**.
2. **Selected domain:** `cadenzpoint.com`. Click **Generate New Record**.
3. **DKIM key bit length:** `2048`. **Prefix selector:** leave `google`.
4. Add the TXT record it shows at your DNS host: host `google._domainkey`, value starting `v=DKIM1; k=rsa; p=…`.
5. After the DNS record is live (give it an hour), return to the same page and click **Start authentication**.
6. **Expect** the status at the top to read **"Authenticating email with DKIM"**.
7. To verify, send a message to a *different* Gmail address and look at the headers. Sending to yourself doesn't prove it.

### 2.4 Addresses: aliases on your one user
You have one paid user. Every other address is a free **alias** that lands in the same inbox. Each user can have up to 30, at no extra cost.

1. **Menu → Directory → Users**, click your user.
2. On the left under your name, click **Add Alternate Emails**.
3. Click **Alternate email**, type the part before the @, then **Save**. Add these:

| Alias | Used for |
|---|---|
| `support@` | customers (in the Terms and the app) |
| `privacy@` | privacy requests (Privacy Policy) |
| `legal@` | legal notices (Terms) |
| `dmarc@` | DMARC reports (machine mail; filter it, §2.7) |
| `infra@` | **the login email for AWS**, and where AWS, Neon and backup alerts go |

4. To check them later: same page, **Show all alternate emails**.

**Alias or group?** A Google Group is a separate address that several people can share. While you're solo, aliases are simpler. Move `support@` to a group when someone else joins.

**Why `infra@` and not a new Gmail:** the address belongs to the business, moves with it, and sits behind the same security key login. Don't forward `infra@` to a personal inbox: it receives AWS password resets.

### 2.5 Sending from `support@`
Replies to customers should come from `support@`, not your personal-name address. This isn't automatic.
1. In Gmail: **Settings (gear) → See all settings → Accounts** tab.
2. Under **Send mail as**, click **Add another email address**.
3. Enter `CadenzPoint Support` and `support@cadenzpoint.com`, then **Next Step**. Finish any verification it asks for (for your own alias it usually needs none; the docs don't say).
4. Optional: set "When replying to a message: Reply from the same address the message was sent to".

### 2.6 Lock the login with your security keys
**Your login (as a user):**
1. Open `myaccount.google.com` → **Security & sign-in** → under "How you sign in to Google", turn on **2-Step Verification** if it isn't on.
2. Add **both** security keys. The direct link is `myaccount.google.com/signinoptions/two-step-verification?flow=sk&opendialog=addsk`. Follow the prompts and touch each key. A new key can take up to **7 days** before Google offers it at sign-in.
3. **Backup codes:** same 2-Step Verification page → under "Backup codes" → **Get backup codes**. Print them (10 codes) and put them in your password manager and with the spare key.

**The admin rules (for the whole domain):**
1. **Menu → Security → Authentication → 2-step verification**.
2. Check **Allow users to turn on 2-Step Verification**.
3. **Only after both keys show at sign-in** (the 7-day note above): set **Enforcement** to **On**, and **Methods** to **Only security key** (this accepts passkeys too). Click **Save**.
   - Don't enforce before your keys work, or you can lock yourself out.

**Account recovery for you as super admin:**
1. **Menu → Security → Authentication → Account recovery → Super admin account recovery**.
2. Check **Allow super admins to recover their account**, then **Save**.
3. Add a recovery phone and a recovery email (a personal address is fine *for recovery only*) on your Google Account's security page.

**Optional, extra:** Google's Advanced Protection Program (**Menu → Security → Authentication → Advanced Protection Program**) adds the strictest protection. The docs don't confirm it on Business Starter, and enrolled users can't use backup codes. Not needed now.

### 2.7 Filters so alerts stand out
1. In Gmail's search box, click **Show search options**.
2. Create one filter per sender, with the action "Apply the label: **Ops**" and **Never send it to Spam**:
   - the daily CadenzPoint ops digest (your own Resend sender);
   - AWS (`no-reply@sns.amazonaws.com` for backup alerts; `aws-*@amazon.com` billing mail);
   - GitHub (`notifications@github.com`, deploy approvals);
   - Neon.

   These sender addresses are typical, not confirmed by the docs. After the first message from each arrives, open it, then **More (⋮) → Filter messages like these**.
3. For `dmarc@` reports: filter `to:dmarc@cadenzpoint.com` → label **DMARC**, **Skip the Inbox**.

---

## Part 3. GitHub (your existing account)

### 3.1 Security keys
GitHub needs an app-based 2FA first, then accepts keys.
1. Profile picture → **Settings** → under "Access", **Password and authentication**.
2. If 2FA isn't on, set it up with an authenticator app. At the end, **Download** the recovery codes and click **I have saved my recovery codes**.
3. Next to **Security keys**, click **Add** → **Register new security key**, name it ("Key 1"), touch the key. Repeat for Key 2.
   - Or add them as **passkeys** (same page, "Passkeys" → **Add a passkey**), which also replace your password at sign-in.
4. **Recovery codes:** next to "Recovery codes", **View** → **Download**. 16 codes; store them in the kit.

### 3.2 A heads-up about the repo being public
- `ccentofo/bytime` is public: anyone can read the code. No secrets are in it, and the backup design depends on that staying true.
- It also matters for the backups: GitHub's "needs your approval" rule only works on free plans for public repos.
- If you ever make the repo private, tell me first. The approval step would then need GitHub Enterprise, or a different design.
- **Never rename or delete your GitHub account or the `bytime` repo without telling me first.** AWS trusts deploys from exactly `ccentofo/bytime`. If that name were freed and someone else registered it, they could look like you to AWS.

### 3.3 Later (Part 6)
The `aws-backups` environment, five environment secrets and one switch variable. Not now.

---

## Part 4. AWS (a new account, used only for backups)

### 4.1 Before you start
- `infra@cadenzpoint.com` receives mail (Part 2 done).
- Both security keys are in hand.
- A payment card, plus a second card for the backup method.
- **Use the "advanced" sign-up.** AWS's newer sign-up creates an account with **no root user** and no console logins for admins. The backup design needs the classic kind.

### 4.2 Create the account
1. Open **`https://signin.aws.amazon.com/signup?request_type=register`**.
2. **Root user email:** `infra@cadenzpoint.com`. **AWS account name:** `CadenzPoint Backups`. Choose **Verify email address**, enter the emailed code, then **Verify**.
3. **Root password:** generate a long one in your password manager (8–128 characters). Save it there now. **Continue**.
4. **Choose your account plan:** pick **Paid**.
   - You still get the $100 sign-up credit, plus up to $100 more for trying services, and the credits pay your bills for 12 months.
   - The **Free** plan closes the account after 6 months unless you upgrade. That's not acceptable for backups.
   - If you pick Free by mistake, upgrade straight away (§4.4).
5. **Contact information:** choose a business account. Use your business details; a company phone if you have one, otherwise yours. Accept the Customer Agreement.
6. **Billing:** add your main card.
7. **Identity check:** country code and phone, **Send SMS**, enter the code, **Continue**.
8. **Support plan:** the free **Basic** support. (The exact label wasn't confirmed; pick the free option.)
9. **Complete sign up.** Activation usually takes minutes, occasionally up to 24 hours. You'll get an email at `infra@`.

### 4.3 Protect the root user (do this before anything else)
1. Sign in at `console.aws.amazon.com` as **Root user** with `infra@cadenzpoint.com`.
2. Top right, your account name → **Security credentials**.
3. Under **Multi-factor authentication (MFA)** → **Assign MFA device**.
4. **Device name:** `key-1`. Choose **Passkey or Security Key** → **Next** → touch the key → **Continue**.
5. Repeat with **Device name** `key-2` and the second key. (Root can have up to 8 devices, and names must differ.)
6. Check that the page lists two MFA devices.
7. Don't create root access keys. If the page shows any, delete them.

### 4.4 Billing safety
1. **Plan:** if you're on Free, go to **`https://console.aws.amazon.com/billing/home?#/freetier/upgrade`** → **Upgrade account**.
2. **Second card:** Billing and Cost Management → **Payment preferences** → **Add payment method** → enter the second card → **Add payment method**.
3. **Backup payment method:** **Payment preferences → Default payment preferences → Edit** → turn on **Backup payment method** → **Save changes**.
   - **Expect** a card marked "Backup payment method", status `Enabled`. A lapsed bill can suspend the account that holds every backup, so this matters.
4. **The budget alert** is created by the backup system's code (a $10/month budget emailing `infra@`). Nothing to do here.

### 4.5 Contacts and billing access
1. Account name → **Account** → **Alternate contacts** → **Edit**. Set Billing, Operations and Security to you at `infra@cadenzpoint.com` → **Update**.
2. Same **Account** page → **IAM User and Role Access to Billing Information** → **Edit** → check **Activate IAM Access** → **Update**.
   - **Expect** "IAM user/role access to billing information is activated." This lets your everyday admin login (next step) see bills, so you rarely need root.

### 4.6 Your everyday admin login (not root)
1. Search for **IAM** in the console → **Users** → **Create user**.
2. **User name:** `corey-admin`.
3. Check **Provide user access to the AWS Management Console** → **I want to create an IAM user**.
4. **Console password:** Custom, generated in your password manager. Uncheck "must create a new password at next sign-in" (you already generated a strong one). **Next**.
5. **Set permissions:** **Add user to group** → **Create group** → name `admins` → check **AdministratorAccess** → **Create user group** → select it → **Next** → **Create user**.
6. **Don't create access keys** for this user, now or later. Console only.
7. Open the user → **Security credentials** tab → **Assign MFA device** → **Passkey or Security Key** → `key-1` → touch it. Repeat for `key-2`.
8. **A sign-in address:** IAM → **Dashboard** → **AWS Account** → next to **Account Alias** → **Create** → `cadenzpoint-backups` → **Save changes**.
   - Your login page becomes `https://cadenzpoint-backups.signin.aws.amazon.com/console/`. Save it in the password manager entry for `corey-admin`.
9. **Sign out of root.** From now on, use `corey-admin`. Root is only for account recovery and a few billing settings.

### 4.7 Region
In the top-right region menu, choose **US East (N. Virginia) us-east-1** whenever you're in the console. Everything for CadenzPoint lives there.

### 4.8 What you can't do in this account, by design
Once the backup system is deployed, your admin login is **refused** if it tries to download, decrypt or re-encrypt a backup. Only the automated restore test, and 3c's disaster button, can. Nothing can reach your Mac by accident.

Stated honestly: an administrator can always get access on purpose, for example by changing a policy or running a task with a different command. That's a deliberate act behind your hardware key, and AWS's audit trail records it. Any change to the protections themselves (the key, the bucket rules, the audit trail, the alerts) **emails you immediately**, whoever makes it, and a daily check confirms they're still in place.

---

## Part 5. Neon: the restore-test project (when 3b is ready to deploy)
1. In the Neon console → **New Project**.
2. **Project name:** `cadenzpoint-restore-tests`.
3. **Region:** **AWS US East (N. Virginia)** (`aws-us-east-1`).
4. Expand **Postgres database** and set **Postgres version** to **16**. Neon now defaults to 18; the workspaces run 16, so this must match.
5. **Create project**.
6. **History window:** Project → **Settings** → **Postgres** (some screens call the area "Instant restore") → **History window** → set it to **0**, then **Save**.
   - Zero means a test database is really gone when it's dropped, and this project has nothing worth restoring.
7. **The connection string:** click **Connect**, turn **off** the **Connection pooling** toggle (the host must *not* contain `-pooler`), and copy the string. You'll paste it into AWS in Part 6. Don't save it anywhere else.

---

## Part 6. Turning the backup system on (after 3b is built; we do this together)
The final checklist will be `PRODUCTION-DEPLOY.md`, Phase "Backups (AWS)". The first runs use **staging**, as a rehearsal; production comes after they pass.

1. **GitHub environment first.** Until it's locked to `main` behind your approval, nothing should exist in AWS that GitHub can use.
   1. Repo → **Settings → Environments → New environment** → `aws-backups` → **Configure environment**.
   2. **Required reviewers:** add yourself. **Leave "Prevent self-review" unchecked**, or you could never approve your own deploys.
   3. Uncheck **Allow administrators to bypass configured protection rules**. **Save protection rules**.
   4. **Deployment branches → Selected branches and tags → Add deployment branch or tag rule** → Branch, `main` → **Add rule**.
   5. On the same environment page, under **Environment secrets**, click **Add secret**: name `BACKUP_ALERT_EMAIL`, value `infra@cadenzpoint.com`. (Secrets, not variables, because the repo is public and GitHub hides secrets in its logs.)
   6. **Check it:** run these two commands in Terminal and send me the output; I confirm the approval rule, the bypass setting and the branch rule:
      - `curl -s https://api.github.com/repos/ccentofo/bytime/environments/aws-backups`
      - `curl -s https://api.github.com/repos/ccentofo/bytime/environments/aws-backups/deployment-branch-policies`
2. **Create the bootstrap stack** (AWS, signed in as `corey-admin`, region us-east-1):
   1. **CloudFormation → Stacks → Create stack → With new resources (standard)**.
   2. **Choose an existing template → Upload a template file → Choose File** → `ops/aws/bootstrap.yml` from the repo → **Next**.
   3. **Stack name:** `cadenzpoint-backup-bootstrap` → **Next** → **Next**.
   4. Check the IAM acknowledgment ("I acknowledge that this template may create IAM resources", possibly mentioning custom names) → **Submit**.
   5. Wait for `CREATE_COMPLETE`. On the **Outputs** tab, copy the four values into **`aws-backups` environment secrets** (Settings → Environments → `aws-backups` → Environment secrets → Add secret): `AWS_DEPLOY_ROLE_ARN`, `AWS_CFN_EXEC_ROLE_ARN`, `AWS_BACKUP_REPOSITORY_URI`, `AWS_ARTIFACTS_BUCKET`.
3. **Make sure the app's latest database changes are live** on staging and production (`deploy-prod`, and staging's deploy), so the backup tables exist.
4. **Paste three values** in **Systems Manager → Parameter Store → Create parameter**, each **Tier: Standard**, **Type: SecureString**, KMS key left at the default (`alias/aws/ssm`). **Staging's values first:**
   - `/cadenzpoint/backup/control-plane-url`: **staging's** control-plane URL;
   - `/cadenzpoint/backup/encryption-key`: **staging's** `ENCRYPTION_KEY`;
   - `/cadenzpoint/backup/restore-test-url`: the Neon string from Part 5. Re-copy it now from Neon → **Connect** (pooling off), since your clipboard has moved on.

   Take the first two from your password manager, where PRODUCTION-DEPLOY Phase 4 keeps them. Vercel won't show sensitive values again.
5. **Switch it on and deploy:** in GitHub → **Settings → Secrets and variables → Actions → Variables → New repository variable**: `AWS_BACKUPS_ENABLED` = `true`. Then **Actions → Backup system deploy → Run workflow**. GitHub emails you; on the run, **Review deployments** → `aws-backups` → **Approve and deploy**.
6. **Confirm the alert email.** AWS sends "AWS Notification - Subscription Confirmation" to `infra@`; click **Confirm subscription** within 48 hours. If you miss it: AWS console → **SNS → Subscriptions** → the pending one → **Request confirmation**. (The daily digest will remind you if it's still unconfirmed.)
7. **First runs and the "can't" checks:** together with me, in the AWS console and AWS CloudShell (a terminal in your browser that runs inside AWS), so nothing runs on your Mac. A few checks deliberately trigger alert emails; that's expected and proves the alarms work.
8. **Switch to production:** between 15:00 and 17:00 UTC (10am–noon Eastern in winter, 11am–1pm in summer; no backup job runs then), edit the first two parameters to **production's** values. From the next scheduled run, production is backed up.
9. **Vercel:** once I confirm production's first backup and audit have run, add `BACKUPS_EXPECTED=1` to production (staging stays `0`), then redeploy.

## Part 7. After setup: what you'll see, and what you never do
**You'll see:**
- a "Backups" section in the daily digest, with the newest backup and the last restore test;
- alerts there if anything is wrong;
- an immediate AWS email if anyone tries to delete or disable the backup key, or changes the backup rules, the audit trail or the alerts (a backup-system deploy that changes them also emails; that's expected);
- a GitHub approval email when the backup code itself changes, which is rare. If that change came with a database update, run `deploy-prod` first, then approve.

**One event-driven exception:** if production's `ENCRYPTION_KEY` or the control-plane database password changes, update the matching AWS Parameter Store value the same day (the runbook for that change says so; the next backup alerts if it's missed).

**You never:**
- download a backup or a customer export;
- delete backups (they expire on their own at 25 days);
- run backup or restore commands on your Mac;
- use the AWS root login day to day.

## Part 8. Optional, and your call (business decisions, not needed for backups)
Your existing Vercel, Neon, Stripe and GitHub accounts may be on a personal email. Moving them to `infra@` (or another business alias) makes the business easier to hand over or incorporate later. Nothing in the backup design depends on it.

## Labels the docs didn't confirm
These steps are right in substance, but their exact on-screen wording wasn't in the official pages:
- Google's domain status wording;
- whether "Send mail as" asks to verify your own alias;
- the super-admin recovery default on Business Starter;
- Advanced Protection on Business Starter;
- Gmail filter action names;
- AWS's Basic support label, which card becomes the backup, the CloudFormation IAM checkbox text, the Parameter Store KMS label, and the SNS email subject;
- whether Neon's history window sits under "Postgres" or "Instant restore".
