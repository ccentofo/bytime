# Database backups: questions for the business session

From: the lead architect (CadenzPoint Planning), via the founder. Date: 2026-11-16.

About: `BUSINESS-DECISIONS.md` §5, "Backups beyond Neon".

## Why this note
Engineering designed backups to the letter of §5. The founder reviewed the result and set three firm constraints:

1. **Nothing manual.** Backups, restore tests and clean-up must run on their own. A person should only ever press a button in a disaster.
2. **No customer data on the founder's own machines, ever.** That includes restore tests.
3. **It has to scale.** If CadenzPoint takes off with many customers, nothing may depend on the founder doing work per customer or per day.

Some §5 rules can't be met together with these constraints as written. The questions below ask you to adjust them. Each has a recommendation; the decision is yours.

## What stays the same (no change asked)
- A daily, automatic, encrypted copy of every customer database and the control plane.
- Stored in AWS S3, us-east-1, in an AWS account separate from Vercel and Neon.
- Backups stop when a workspace is deleted.
- The backup job can add backups but can't read or delete them.
- Monitoring in the daily digest. RPO 24 h; restore within 1 business day.
- DCAA note (§5 already says this): DCAA doesn't require vendor backups. The multi-year record retention it expects is the customer's obligation, met by the export. These backups protect against losing the Neon account.

## Question 1: Who holds the decryption key?
**§5 today:** encrypt with a public key; "the private key is never on the runner or in storage"; the founder keeps it in a password manager plus an offline copy.

**The problem:** with the key only in the founder's hands, no automated system can ever test-restore a backup. Every restore test and every disaster restore needs the founder to fetch the key and run something on their own machine, and the customer data then passes through that machine. Constraints 1 and 2 can't both be met.

**Options:**
- **A. AWS KMS** (AWS's managed key service). The key lives inside AWS's hardware security modules and can't be exported by anyone. Backups are encrypted with it. The backup job is allowed to *encrypt* only, and a separate, automated restore-test job is allowed to *decrypt*. Every use of the key is logged (CloudTrail). There's no key file for anyone to hold or lose. The cost is about $1 a month per key plus a tiny per-use fee.
- **B. Keep the founder-held key, but store a copy as a secret** for an automated restore-test job in GitHub. This works, but a key copy now sits in GitHub, and the founder still manages a key file.
- **C. Keep §5 as written.** Restore tests and disaster restores stay manual and touch the founder's machine. This conflicts with the founder's constraints.

**Engineering recommends A (KMS).** It removes key handling from the founder entirely, it's the standard approach for this, and access is controlled and audited in the same separate AWS account. The risk moves to "someone compromises the AWS backup account", which is mitigated by MFA, separate roles, and no long-lived passwords.

## Question 2: The "30 days" in Terms §9.3
**§5 and the Terms:** deleted customer data "may remain in our backups for up to 30 days". It's enforced by an S3 rule that deletes old backups automatically.

**The problem:** S3 makes an expired file *eligible* for deletion on time, but AWS removes it "days or even weeks later" and gives no deadline. To keep a hard 30-day promise, engineering planned a daily check plus the founder deleting late files by hand. That breaks constraint 1.

**Options:**
- **A. Keep 30 days in the Terms, set the automatic rule to 25 days,** and accept that AWS normally finishes within a day or two. A daily automated check alerts if anything is ever older than 29 days, as a safety net only; nobody deletes anything routinely.
- **B. Reword §9.3** so it allows for the provider's deletion process. For example: "Backups expire automatically 30 days after they are made and are then deleted by our storage provider." The rule then stays at 30 days.
- **C. An automated deletion job,** separate from the backup job, that deletes backups past 29 days itself. This needs a second set of AWS credentials allowed to delete backups, which §5 deliberately avoided.

**Engineering recommends A,** plus a legal look at B for the lawyer review (item 7). A is fully automatic, and the shorter rule doesn't hurt recovery: 25 daily backups are kept.

## Question 3: Restore tests ("drills")
**§5 today:** "Monthly: restore one randomly chosen tenant into a scratch database and compare row counts. Record the result in a runbook."

**With Question 1 answered A or B,** this can be fully automatic. A scheduled cloud job:
- restores a randomly chosen workspace **and** the control plane into a temporary Neon database in us-east-1 (the same provider and region where the live data already lives);
- checks every table's row count against what was recorded at backup time;
- deletes the temporary database;
- records the result automatically and alerts in the daily digest if it fails or doesn't run.

Nothing touches the founder's machines.

**Question:** how often? **Engineering recommends weekly.** Backups only live 25–30 days, so monthly is too slow to catch a problem before every copy is affected. Weekly costs a few cents of Neon time.

## Question 4: Disaster restore (the "within 1 business day" target)
If a customer's Neon database, or the whole Neon account, is lost, the founder shouldn't run scripts on their own machine. Engineering proposes a **one-button cloud workflow** (GitHub Actions, "Run workflow"). It rebuilds the lost workspace from its newest backup into a fresh Neon database, checks it, and switches the workspace over. A separate engineering item (3c) designs this.

**Question:** is a founder-pressed button (no data on any personal machine) acceptable, rather than fully automatic switch-over? **Engineering recommends the button.** Switching a customer's database automatically on a detected outage risks splitting their records if Neon recovers the original shortly after. A human decision is safer here.

A related point the founder's earlier decision covers (LB-D6, no tool to repoint a workspace's database) needs an exception for this button. 3c will bring that to the founder.

## Question 5: Build or buy?
Engineering has a complete design for building this, about 1–2 weeks of development including the automation above. Managed backup products exist, but engineering hasn't evaluated any for fit (Neon support, US-only storage, encryption, cost at scale, what defense buyers expect to see).

**Question:** should engineering evaluate managed options before building? **Engineering's view:** building is reasonable here. The design is small, the storage cost at launch is under $5/month, and it keeps all customer data in two providers already in use (Neon, AWS). A vendor would add another subprocessor holding customer data. Engineering will run the evaluation if you prefer.

## Scale note (for the founder's peace of mind)
The automated design grows with the customer count without manual work:
- **Backups:** each workspace is backed up independently, several at a time. When there are enough customers that one daily run takes too long, the job splits into parallel batches (a configuration change, not a redesign).
- **Monitoring:** alerts per workspace, all in the one daily digest.
- **Storage cost:** grows with data size at about $0.023 per GB per month.

## What engineering needs back
Answers to Questions 1–5 (or "as recommended"). Engineering then updates the backup blueprint (3b) and the disaster-tooling item (3c), reviews the changes, and brings them to the founder before any development starts.
