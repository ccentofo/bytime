# CadenzPoint launch tracker

The single source of truth for **where we are**, kept by the lead architect (session "CadenzPoint Planning") and updated after every step. Any new session reads this first.
- Blueprints: `feature-plan-*.md`.
- Audit records: `*-AUDIT.md`.
- Business decisions: `BUSINESS-DECISIONS.md` (kept by the business session).

**Last updated:** 2026-11-15 (per-user billing merged, PR #32; backups next). Earlier on 2026-11-15: Upstash merged. Earlier on 2026-11-13: Excel cost report merged. Before that: 2026-11-11 (earlier entries dated 2026-11-12 were written on 2026-11-11; the dates are kept as recorded).

## How we work
- **Scope is the product owner's.** Nothing is added, removed or changed in what the product does without the product owner's yes. The lead decides software design inside approved scope and brings every assumption or open question to the product owner.
- **Tandem mode:** the lead sends approved work to "CadenzPoint Development" and audits the results. The product owner sees every blueprint and every audit verdict, and runs all pushes, PRs and merges plus the browser checks.
- **Sessions:** a fresh dev session per blueprint; fix rounds stay in it. **Since 2026-11-13 the lead starts each dev session itself** and talks to it directly (product owner's OK); the product owner archives old ones. The lead checkpoints this file and its memory before starting a fresh planning session, and tells the product owner exactly when and how.
- **Guardrails:**
  - the dev never pushes;
  - destructive operations run only against throwaway local tenants;
  - business decisions stay with the product owner and the business session;
  - messages between sessions don't carry the product owner's authority.

## Stability and rollback (product owner's rules, 2026-11-12)
- **Stable point before tandem mode:** tag `stable-pre-tandem-2026-11-12` = `main` at `ce4eb25` (approval scope + the table hotfix merged; all gates green). Roll back to it at any time (see "Rolling back" below). These rules arrive on `main` with Part 2a.
- **One new branch per work item** from the latest `main`. Never commit to `main`; the dev never pushes.
- **Merge gate.** All of these, in order, or no merge:
  1. the lead's audit verdict is READY (written in the item's `*-AUDIT.md`);
  2. CI is green on the PR;
  3. **the lead runs the checks** against the finished branch: real browser clicks with the preview tool (`.claude/launch.json` config `app-dev`), plus scripted file and API checks. The results go in the audit with evidence (screenshots, outputs). The product owner reviews those results and says it's stable (changed by the product owner, 2026-11-13; it was "the product owner runs the checks personally").

  The lead gives merge commands only after step 3.
- **Scope check in every audit:** the lead lists any file or behaviour change outside the blueprint's blast radius and brings it to the product owner before anything else.
- **A new stable tag after each merge** the product owner confirms: `stable-YYYY-MM-DD-<item>`. Every merge is a rollback point.
- **Rolling back** (code only; production isn't live yet, and local data resets with `npm run demo:local`):
  - to look: `git checkout stable-pre-tandem-2026-11-12`;
  - to restore `main`: open a revert PR of the unwanted merge commits (`git revert -m 1 <merge>`), never a force-push.

## Build queue (software)
| # | Item | Status |
|---|---|---|
| 1 | Hotfix: table column order leaks between pages (`feature-plan-hotfix-table-state.md`) | **merged** (PR #23) |
| 2 | UX-4c Part 2a: Setup checklist and Import (`feature-plan-ux-setup-import.md`) | **merged** (PR #24, `3babd0d`; audit `UX-4C2A-AUDIT.md` READY). Tag `stable-2026-11-11-ux-setup-import`. |
| 3 | UX-4c Part 2b: Integrations, Landing, Terms/Privacy text (`feature-plan-ux-integrations-billing.md` v3.1) | **merged** (PR #25, `8ecd8c6`, 2026-11-11; audit `UX-4C2B-AUDIT.md` READY; CI green; product owner's browser checks passed). Tag `stable-2026-11-11-ux-integrations-landing`. |
| 3b | **Database backups**: daily encrypted `pg_dump` of every tenant and the control plane to S3 us-east-1, lifecycle retention, write-only credentials, monitoring, restore into a scratch database, restore drill (`BUSINESS-DECISIONS.md` §5) | **MERGED 2026-11-17** (PR #33, `main` = `8af3b2c`). Tagged `stable-2026-11-17-database-backups` (on origin). Four CI fixes were needed after the push (cfn-lint invocation, `.npmrc` in the image, two network downloads replaced by a committed PGDG key); the lessons are now in `BLUEPRINT-STANDARD.md` §2, §3.7 and §4. Phase 13b (AWS) waits for the founder's accounts (`FOUNDER-ACCOUNTS-SETUP.md`). History: **FINAL v5.8, pre-mortem CLEAN (2026-11-16)**, `feature-plan-database-backups.md` on `database-backups`. A redesign to the revised §5: jobs run as scheduled ECS Fargate tasks in the backup AWS account (us-east-1), not on GitHub runners; KMS client-side encryption (the AWS Encryption SDK); weekly automated restore tests into a dedicated Neon project, with the 13-week rule; versioning off; immediate alerts on key or policy changes; daily permission probes. Rounds 1–2 and confirmation passes 1–5 fixed; pass 6 clean. **Accepted 2026-11-16 (Q1–Q4 as recommended).** Dev session started; **impact analysis reviewed, go-ahead given (2026-11-16, lead → dev directly).** Approved details, within the design (audit against the blueprint plus these):
  - G1: `build` gets `deployments: read`, and `changed.sh` walks up to 20 `aws-backups` deployments' statuses;
  - G2: the backup, restore-test and lock suites use their own scratch `bkt_*` control-plane and tenant databases, never `bytime_control`;
  - G3: `migrate-all` is split into a seamed `scripts/lib/migrate-all-run.ts`, CLI unchanged, and a pending-count error runs the handshake;
  - G4: plain regex groups;
  - G5: the extra SDK clients go in devDependencies (the builder must not omit dev dependencies);
  - G6: the key ARN comes from `GetAtt`;
  - G7: probe the newest key;
  - G8: `PRODUCTION-DEPLOY.md:885` drill clause removed;
  - G9.1–10 as proposed.

  Docker isn't in the dev sandbox: the lead or CI runs §13.3.
  - **Built (2026-11-16):** dev commits `5e2cba6..f910d1a`. **Audit round 1: NOT READY** (no HIGH; 2 MEDIUM: tuning parameters never reach a live stack, and the permission-drift alert detail carries the encrypted data key; about 9 LOWs and test gaps). Fix round 1 was sent to the dev (`DATABASE-BACKUPS-AUDIT.md` §5). **Audit READY at `dd1a77e` (2026-11-17)** after fix round 1: the lead's integration run alone passed (891, 0 failed), break-it caught 10/10, and the checks pass. Next: the product owner's merge gate. CI must pass, including the new `backup-checks` job (the first Docker image build). Phase 13b (AWS) waits for the founder's accounts. The lead's local checks pass (A–G, `e227b2c`). The Docker image build can't run on this machine: CI's `backup-checks` job proves it at the merge gate. Founder setup steps: `FOUNDER-ACCOUNTS-SETUP.md`. Open for the product owner: Q1 (deploy approval), Q2 (no staging backups), Q3 (the 25-hour IP-hash sentence, for the business session), Q4 (retire the monthly manual Neon drill). Scope split 2026-11-15: the disaster tooling moved to 3c. |
| 3c | **Disaster rebuild tooling**: rebuild a lost workspace database into a fresh Neon project and relink it; control-plane disaster runbook; re-tombstone workspaces deleted in a lost window (`BUSINESS-DECISIONS.md` §5 "restore within 1 business day") | **Blueprint in progress (2026-11-17)** on `disaster-restore-button` (from `main` at `8af3b2c`). Scope accepted 2026-11-17 (decisions log). Starting design: 3b v3.2 (commit `95d8bfe`) §6.10 and the brief below, adapted to the revised §5 (the button runs in AWS, nothing on the founder's machine).
| 3a | **Per-user billing** (new model, billing rules and Billing page, from `BUSINESS-DECISIONS.md` §1) | **merged** (PR #32, `c416049`, 2026-11-15; audit `PER-USER-BILLING-AUDIT.md` READY at `77c103a`; checks run by the lead). Tag `stable-2026-11-15-per-user-billing`. **Still to do:** the founder's Stripe setup (PRODUCTION-DEPLOY Phase 9, rewritten) and staging 12.8/12.8b, which prove the Stripe-only behaviour. |
| 4 | Launch hardening H1–H6 (`feature-plan-launch-hardening.md` FINAL v3.2) | **merged** (PR #26, `a80ad8b`, 2026-11-12; audit `LAUNCH-HARDENING-AUDIT.md` READY; CI green; product owner's browser checks passed, with the no-JavaScript check withdrawn). Tag `stable-2026-11-12-launch-hardening`. |
| 4b | **Reminder email capacity**: the cron senders use Resend batch send | **merged** (PR #27 at `af2ac7d`, PR #28 with the checks-file fixes; `main` = `9427fba`, 2026-11-13). Audit `REMINDER-CAPACITY-AUDIT.md` READY; CI green; the product owner's integration run and checks passed. Tag `stable-2026-11-13-reminder-capacity`. |
| 5 | Excel cost report: charge codes and Class | **merged** (PR #29, `1d44b35`, 2026-11-13; audit `EXCEL-COST-REPORT-AUDIT.md` READY, no HIGH or MEDIUM, 5 LOWs recorded; CI green; the product owner's checks passed). Tag `stable-2026-11-13-excel-cost-report`. |
| 5b | **Large report responses**: stream the cost CSV, `/api/v1/costs`, `/periods` and `/timesheets/approved`; 25,000-row cap on the detailed cost Excel (`feature-plan-large-report-responses.md` FINAL v3.1) | **merged** (PR #30, `02059b0`, 2026-11-13; audit `LARGE-REPORT-RESPONSES-AUDIT.md` READY; CI green; checks run by the lead in the rehearsal). The product owner tags `stable-2026-11-13-large-report-responses`. **Still to prove at staging step 12.13:** the 4.5 MB exemption on Vercel and the cut-off behaviour. |
| 6 | Distributed rate limiting (Upstash): shared sign-up and sign-in limits (`feature-plan-upstash-rate-limiting.md` FINAL v3.3) | **merged** (PR #31, `f958be9`, 2026-11-15; audit `UPSTASH-RATE-LIMITING-AUDIT.md` READY; checks run by the lead; CI green after a test-only fix for a date-dependent test). The product owner tags `stable-2026-11-15-upstash-rate-limiting`. **Founder step still open:** PRODUCTION-DEPLOY Phase 8b (two Upstash databases); until then the limits stay per-instance. Staging step 12.14 proves the real path. |
    - F1: trim the URL like the token;
    - F2: the pre-gate check also returns `null` for an email over 255 characters or a NUL in the email or password, with no consume (a T23 case);
    - F3: the §12 diff is against `02059b0`;
    - D1: the memory fallback keeps today's first-request window and doesn't count refused calls;
    - D2: refund failures never touch the circuit or `noteOutage`;
    - D3: signals are imported lazily and awaited inside `try`;
    - D4: one pure `buildUpstash(env)`, shared by the store and the cron's config check;
    - D5: the Q3 gate sits right after `if (!slug) return;`, before `getDbForAuth()`;
    - D6: the slug-lookup result keeps its shape (now a Promise);
    - D7: the `signup-ops` order assertion gains `resolve-rate-limit-signals`;
    - D8: existing tests keep the `ip:unknown` bucket, and new scenarios use distinct IPs;
    - D9: the test seam resolves per name, and T8 uses the real constructor. Branch `upstash-rate-limiting` from `02059b0`. |
| 7 | ~~UX-5 accessibility (Section 508) verification~~ | **not doing** (product owner, 2026-11-12) |
| 8 | Staging rehearsal (PRODUCTION-DEPLOY Phase 12), then production (Phase 13) | after the above. The approval-scope release is fix-forward only, with the window check. |

## Launch hardening follow-ups: done (PR #26, 2026-11-12)
- **Fixed:** daily reminders can't be switched off (H1); employee screens say "Self-returned" (H2); slow-CI flaky tests (H3); progress line counts from the account's creation day (H4; the old "Late" badge was already gone); connect is a POST-only server action (H5); one QuickBooks token refresh at a time (H6).
- **Closed on re-check:** the past-hours import respects the period lock (V1); C5 is a watch item on the Deferred list (V2).
- **Still deferred:** the clean-up migration for supervisors' membership rows not backed by a charge code (until approval scope has been live once).
- **Recorded LOWs** (`LAUNCH-HARDENING-AUDIT.md` §5): a non-JSON 200 from Intuit shows the generic error; no pending state on Connect; `fetchQBOClassesForMapping` has no `validateUUID` and no UI caller. Candidates for a later hardening pass; not scheduled.

## Decisions log (product owner)
| Date | Decision |
|---|---|
| 2026-11-06 | UX: polished, usable, professional; not overengineered. Batch 2 mockups approved. |
| 2026-11-06 | Audit trail Admin changes tab, admin two-step reset and audit CSV: in. QuickBooks auto-send switch: hidden. |
| 2026-11-10 | Charging never grants approval. Approval scope comes only from explicit, logged grants. Converted once with a review list. Promotion starts empty; demotion removes scope. |
| 2026-11-12 | Launch hardening follow-ups approved for direct lead ↔ dev work. |
| 2026-11-12 | Excel cost report charge codes and Class: approved. |
| 2026-11-12 | UX-5 accessibility verification: **no**. |
| 2026-11-12 | Deferred list stays out of launch; the product owner will pick items up later. |
| 2026-11-12 | Every session reads `LAUNCH-TRACKER.md` first (added to `AGENTS.md`). |
| 2026-11-11 | Part 2a scope: S3 (Home workweek card removed), S4 (skipped-rows line) and S9 (Setup visual tweaks) accepted; **S10: friendly time zone names**; **F7: change the Hours notice wording** once hours exist. |
| 2026-11-11 | S10: time zone labels use Intl's generic names ("Eastern Time"); Setup checklist only. |
| 2026-11-11 | The time zone dropdown keeps raw IANA names (only the Setup summary line is friendly). |
| 2026-11-11 | Part 2b split: Integrations + Landing now; Billing moves to a new per-user billing blueprint (added to the queue). |
| 2026-11-11 | Landing uses the business's exact strings (`BUSINESS-DECISIONS.md` §2); the lead flags any claim the code doesn't support. |
| 2026-11-11 | The dev may apply the business's Terms §7 / Privacy text (§3 A1, A2) to those two pages "for now". |
| 2026-11-11 | Landing copy: the lead's five accuracy fixes accepted (DB enforcement wording; "keep employees on track"; "return" not "reject"; "an audit trail you can filter by person, contract and reason"; "Submitted and approved timesheets lock"). |
| 2026-11-11 | Employees can't opt out of daily reminder emails. |
| 2026-11-11 | Certification recording: add **only if DCAA requires a stored artifact** (lead's assessment pending the product owner's read). |
| 2026-11-11 | Backups: their own blueprint (database backups per `BUSINESS-DECISIONS.md` §5). |
| 2026-11-11 | Launch hardening blueprint: **all 9 recommendations accepted**. Daily switch removed for everyone; employees see "Daily time entry reminders are always on. You'll get one on weekdays when you haven't entered time."; the deadline switch is shown to employees only; the "disable" sentence is removed from the daily email; the progress line counts from the account's creation day, while the submit warnings stay unchanged; C5 closed as a watch item; QuickBooks connect becomes a server action and the Gusto connect route is deleted; a reminder-capacity follow-up blueprint is added; H3 works from measured causes. |
| 2026-11-11 | **For the business session (the product owner forwards it):** two pieces of text say reminders can be turned off: `business/legal/privacy-policy.md` lines 74 and 163, and the live Privacy page line "Send email notifications (configurable in your preferences)". Both need rewording. |
| 2026-11-11 | Part 2b scope items (`UX-4C2B-AUDIT.md` §4) **all accepted**. S1 and S4–S7 stay as built (landing CTA, © line, preview, hub, QuickBooks page and modal wording, the Disconnect promise, `?connectionId` ignored). **S2:** the hub description becomes "Send approved hours to QuickBooks Online, or download payroll files for your payroll system." **S3:** no "Connected" badge on the Gusto card. |
| 2026-11-11 | **R1** (QuickBooks token refresh race across requests) goes into the launch hardening blueprint as **H6**. |
| 2026-11-12 | Rate limiting: **Upstash** (expected to stay in the free tier). Rate-limit keys must be **salted hashes that expire within 25 hours** (matches the Privacy Policy). Raw IPs are never stored. |
| 2026-11-12 | **Launch hardening L1:** keep the curly apostrophes in the notifications line ("You’ll", "haven’t"), matching the rest of the app. |
| 2026-11-12 | **4b reminder capacity:** Resend batch send applies to the two reminder crons only (`daily-reminder`, `submission-deadline`). Admin notice delivery (`deliverPendingNotices`) stays one email per send. |
| 2026-11-12 | **4b blueprint accepted** (`feature-plan-reminder-capacity.md` FINAL v3.1). **Q2:** no Resend account yet, so the live batch check moves to the staging rehearsal (Phase 12). **Q3:** no quota-reserve code; the Resend Free tier for now (the product owner revisits before customers beyond the design partner; lead's estimate: Free covers about one 30-person workspace's reminders a day). |
| 2026-11-12 | **Excel cost report E1–E4 (all lead recommendations accepted):** E1 the detailed cost report gets the columns in Excel and CSV, and `/api/v1/costs` gets additive `chargeCode` and `className` fields; the Hours summary and Cost by pay period are unchanged. E2 the columns are "Charge Code" and "Class" only. E3 Class is the charge code's Class today, with a one-line note in the file. E4 entries with no charge code (imported history, CLIN-only) get blank cells. |
| 2026-11-13 | **Upstash blueprint accepted** (`feature-plan-upstash-rate-limiting.md` FINAL v3.3), **Q1–Q5 all as recommended:** Q1 fall back to per-instance memory plus an ops alert; Q2 20 failed sign-ins per IP per 15 minutes across workspaces (counted first, refunded on success), message "Too many failed sign-in attempts from your network. Try again in 15 minutes."; Q3 10 reset requests per IP per hour, silent; Q4 the split (signup, workspace-name lookups and the two new limits on Upstash; reports, API, export and cron stay in memory); Q5 usage alerts at $5 and $10, no hard cap. |
| 2026-11-15 | **Per-user billing blueprint accepted** (`feature-plan-per-user-billing.md` FINAL v3.7), **Q1–Q11 all as recommended:** Q1 quantity held mid-term, dropped in the last day before renewal (re-adds free in-term); Q2 no self-serve monthly↔annual switching (founder switches at period end); Q3 Enterprise via `tenant:admin set-plan`, custom prices never touched; Q4 invoiced "Invoice overdue" email variant; Q5 quantity batched within 10 min (removals in the last ~15 min before renewal bill the next term); Q6 "Payment not received" admin email plus founder alert; Q7 the new on-screen strings; Q8 Users page "N active · up to 100" on Standard; Q9 FOUNDING annual applicability left to the business side (Stripe setting); Q10 overdue accounts aren't synced (billed from recovery); Q11 failed payments on invoiced subscriptions email admins. |
| 2026-11-15 | **Backups scope split** (lead's recommendation): 3b keeps backups, monitoring, restore into a scratch database, the drill and retention. The disaster rebuild tooling becomes item **3c**, with its own blueprint and review, still before the first paying customer. |
| 2026-11-16 | **Backups constraints:** nothing manual; no customer data on the founder's own machines (including restore tests); must scale with many customers. 3b is on hold. The lead's questions to the business session are in `BACKUPS-QUESTIONS-FOR-BUSINESS.md` (key holder: KMS recommended; the 30-day wording; weekly automated drills; a one-button disaster restore; build or buy). The founder forwards them. |
| 2026-11-17 | **3c scope accepted (Q1–Q5 as recommended):** Q1, the button has two modes, one workspace and control plane, and losing the whole Neon account is a runbook using both; Q2, after a control-plane rebuild the founder repoints Vercel, GitHub and AWS and pauses/resumes crons by hand from a checklist (no Vercel token in AWS); Q3, if the Neon account is lost, the founder creates a new Neon account and pastes its API key into AWS (a disaster-time duty); Q4, workspaces deleted after the last control-plane backup are re-marked deleted automatically from Neon's record, while workspaces created in that window are reconciled in Stripe by hand from a checklist; Q5, the founder emails affected customers from a runbook template. An original database that comes back stays untouched until the founder deletes it, and the digest reminds them. |
| 2026-11-17 | **3b merged** (PR #33). **Process change (approved by the product owner 2026-11-17, including the early CI push):** `BLUEPRINT-STANDARD.md` now requires every new or changed CI `run:` block to be run verbatim before the report, Dockerfiles to be built from an exact-COPY temp folder when Docker isn't available, no unpinned downloads in builds, and an early CI push by the product owner for items that touch CI or Dockerfiles. |
| 2026-11-16 | **Blueprint 3b FINAL v5.8 accepted, Q1–Q4 as recommended:** Q1, backup-system deploys need the founder's approval in GitHub (environment `aws-backups`); Q2, no staging backups (the rehearsal points the production stack at staging first); Q3, the business session is asked whether Privacy §1's "25 hours" IP-hash sentence needs a backups clause (it doesn't block the build); Q4, the monthly manual Neon drill in `RESTORE.md` is retired (the weekly automated restore test replaces it). Also accepted: `migrate-all` waits while a backup runs (a small scope addition from review). |
| 2026-11-16 | **Business answers on backups (`BUSINESS-DECISIONS.md` §5, revised):** KMS (30-day deletion window, alert on scheduled deletion or disabling); 25-day S3 rule with a 29-day alert, and Terms §9.3 / Privacy §7 reworded now; versioning off; weekly automated restore tests, `max(1, ceil(active/13))` workspaces per run plus the control plane, temporary databases always deleted; a founder-only disaster button (protected GitHub environment, hardware-key login), original database kept, backup time reported, LB-D6 exception limited to the button and logged; build, no vendor; **all jobs run in AWS us-east-1, not on GitHub runners**; F2 changes, so the founder never downloads customer data (a cloud job emails an expiring 7-day link; legal holds stay in the cloud). |
| 2026-11-13 | **Checks process changed:** the lead runs the browser checks itself (real clicks in the preview browser, plus scripts) and records the results with evidence. The product owner only reviews the results before saying "stable". The lead talks to the dev session directly, not through the product owner. Steps needing the product owner's accounts (Vercel, Neon, GitHub, Stripe, real inboxes) stay with the product owner. |
| 2026-11-13 | **5b blueprint accepted** (`feature-plan-large-report-responses.md` FINAL v3.1), **Q1–Q6 all as recommended:** Q1 Excel cap 25,000 rows; Q2 message "More than 25,000 rows match. Choose a shorter date range, or download the CSV."; Q3 no CSV cap (watch item); Q4 `/api/v1/periods` and `/api/v1/timesheets/approved` also stream; Q5 no warning on Downloads; Q6 build now, prove the 4.5 MB premise at staging step 12.13 (baseline then 5b). |
| 2026-11-13 | **Excel cost report blueprint accepted** (`feature-plan-excel-cost-report.md` FINAL v3.1), **Q1–Q5 all as recommended:** Q1 the existing 4.5 MB response limit and Excel memory stay out of it, with a new follow-up item right after it (stream the CSV and API; cap the Excel range or rows); Q2 the API key dialog gets the `chargeCode` / `className` sentence; Q3 the Downloads description mentions charge codes; Q4 note text "Class shows the current Class of each charge code, including on past dates."; Q5 the cost CSV starts with a UTF-8 byte-order mark. |

## Open questions for the product owner
1. Product questions (not blocking):
   - should a QuickBooks resend send only entries not already sent?
   - should a real Gusto connection be built?

## Deferred (out of launch; the product owner picks these up later)
- Back/Forward unsaved-draft protection (UX-3 Part C)
- Real offline editing
- A real Gusto connection
- QuickBooks per-entry de-duplication on resend
- QuickBooks auto-send on approval
- Invite emails (need Resend)
- Watch item (C5): add an index on `timesheet_entries(charge_code_id)` if Charge codes or Assignments load slowly with real data

## Business items (business session; outcomes land in `BUSINESS-DECISIONS.md`)
- Plan prices
- Landing copy
- Terms and Privacy §7 wording (also gates signup controls)
- Retention and backup policy
- Resend account (the product owner: Free tier for now; the live batch check runs at the staging rehearsal once the account exists; upgrade before reminders exceed ~100 emails/day)
- Lawyer review
- Security posture (NIST 800-171 / CMMC, SOC 2, CUI)
- Trademark
- Intuit production approval
- Payroll accountant review
- Vendor file layouts in staging

## Lead handoff notes (for a fresh "CadenzPoint Planning" session)
**In flight:**
- **Blueprint 3b in review (2026-11-15):** `feature-plan-database-backups.md` v4.
  - **Review history:**
    - rounds 1–2 (2 HIGH each), then confirmation passes 1–3 (8, 4 and 6 MEDIUM);
    - from v3 on, every MEDIUM was in the disaster tooling, hence the split;
    - the confirmation pass on v4 is **CLEAN** (FINAL v4.1);
    - **on hold 2026-11-16:** the product owner's constraints (nothing manual, no data on their machines, scale). Waiting on the business session's answers to `BACKUPS-QUESTIONS-FOR-BUSINESS.md`. Expect a redesign: KMS keys, automated cloud drills into temporary Neon databases, no laptop restores, a one-button cloud disaster workflow (3c).
  - **3c brief (open findings to design for):**
    - runbook B must disable Vercel cron jobs (rotating `CRON_SECRET` doesn't pause them);
    - a disaster deploy path, since `deploy-prod` migrates every tenant first;
    - a 404 isn't proof a project is gone (wrong key or org): add a positive control;
    - retombstone needs a tenant-id match, deletion-time checks, an undo story and stored receipts;
    - workspaces created in the lost window (orphaned Neon projects, Stripe);
    - a deployed-commit check without `gh` (compare the migration journal);
    - the watch's state model;
    - re-check that the old project is gone before linking;
    - orphan projects when the create response is lost;
    - reconcile coordination with customers;
    - notices sent in the lost window;
    - the catch-up doesn't re-dump the control plane (3b §16 item 18).
- **Per-user billing merged (2026-11-15):** PR #32, `main` = `c416049`, tag `stable-2026-11-15-per-user-billing` (on origin). The 3a dev session can be archived. **Next: blueprint 3b, database backups**, on branch `database-backups` (from `c416049`, holding this note). Scope is in `BUSINESS-DECISIONS.md` §5. Same process: research, two pre-mortem rounds plus confirmation passes, then the product owner, then a fresh dev session, audit, and checks run by the lead.
- **Blueprint 3a written (eighth Planning session, 2026-11-15):** `feature-plan-per-user-billing.md` **FINAL v3.7, pre-mortem CLEAN**, on `per-user-billing` (lead commits, not pushed).
  - **Review history:** round 1 (3 HIGH, 11 MEDIUM); round 2 (10 MEDIUM); then confirmation passes 1–6 (5, 1, 4, 2 HIGH + 1, 1, 1 MEDIUM); pass 7 clean. The log is in §15.
  - **Key design:**
    - quantity **held mid-term, dropped in the last 24 h before renewal** (stateless; no double charge on re-add; Q1);
    - batched every 10 min by a new `seat-sync` cron with a daily check;
    - **invoiced (send_invoice) grace follows the invoices' due dates**, not Stripe's status (explicit pseudo-code in §6.2);
    - founder commands `set-plan`, `ensure-customer` and `seat-sync` (Stripe-mode guard);
    - new notice `bank-payment-failed` (Terms §4.7);
    - Billing page tiles per the approved mockup; landing Pricing; Users seat line.
  - **Accepted by the product owner 2026-11-15, Q1–Q11 all as recommended** (decisions log).
  - **After acceptance:**
    1. write `PER-USER-BILLING-BROWSER-CHECKS.md`;
    2. start "CadenzPoint Development — Per-user billing" (fresh, `use_worktree: false`) with the §14 hand-off;
    3. review the impact analysis;
    4. audit;
    5. run the checks.
  - **Impact analysis reviewed; go-ahead given (2026-11-15, lead → dev directly).** Approved details, within the design (audit against the blueprint plus these):
    - **B1:** `billingTenantReads` lives in a new `src/server/internal/billing-reads.ts` (`'use server'` files export only async functions); `countActiveUsers(row)` stays in `seats.ts`.
    - **B2:** the webhook's per-subscription open-invoice list adds `expand: ['data.payment_intent']`, so "processing" is known on both paths.
    - **B3:** the loader is `loadOpenInvoices(customerDeleted)`. `reconcileInLock` calls it after `readCustomerSubscriptions` with that call's flag; the runner memoizes the first promise and reuses it after the reconcile (one list per section).
    - **I1:** `computeInvoiceOverdueSince` counts null-due invoices only once failed. `toCancel`, the DUNNING-filter exclusion and `cancelInOwnSection` use `isOverdue` directly; they run only for ended tenants, where null-due counts as failed.
    - **I2:** `reconcileInLock` resolves every open `subscription-status-drift` for the tenant in its `tx`.
    - **I3:** the snapshot fields are required, and the test helper is updated.
    - **I4:** the trial and unknown cap labels are kept as `seats.ts:22` resolves them.
    - **I5:** bulk import always reads the plan first (accepted).
    - **I6:** the tenant id comes from `getTenantOrThrow()` in the actions, plus a context mock in `update-user-role-and-active`.
    - **I7:** early `not-applicable` leaves `billable_count` unchanged.
    - **I8:** the extra fake capabilities (schedules, `attempt_count`, `auto_advance`, `schedule`, extra items, `trialing`, list by subscription, uncollectible lists) are within §10.1's intent.
    - **I9:** noted.
    - **N1:** add to staging 12.8b: check Neon's pooler doesn't cut a long `withSeatLock` section (idle-in-transaction).
    - **Permission:** the dev may run `npm run db:migrate:cp` on the local control plane (additive; rewrites local legacy plan values). Not `demo:local`.
  - **Then:** database backups (3b).
- **Checkpoint 2026-11-15 (end of the seventh Planning session).**
  - **Done this session:** 5b merged (PR #30) and Upstash merged (PR #31, `main` = `f958be9`).
  - **New working agreement (product owner, 2026-11-13):**
    - the lead starts each fresh dev session itself (`start_session`, user_asked, fresh, `use_worktree: false`, title "CadenzPoint Development — <item>") and talks to it directly;
    - the lead runs the checks file itself (preview config `app-dev` for real browser clicks; curl and scripts for content) and records the results with evidence in the audit;
    - the product owner reviews the results, pushes, opens the PR and merges.
  - **Next:** blueprint 3a, per-user billing, on branch `per-user-billing` (from `f958be9`, holding this checkpoint).
    - Scope comes from `BUSINESS-DECISIONS.md` §1: plans, Stripe tiered prices, the quantity sync plus a daily reconcile, prorations, the 100-user cap message, ACH, promotion codes, send-invoice subscriptions with grace, the Billing page redesign, and the landing Pricing section.
    - Same process: research, then two pre-mortem rounds plus confirmation passes until clean, then the product owner, then a fresh dev session, audit, checks run by the lead.
  - **Then:** database backups (`BUSINESS-DECISIONS.md` §5).
  - **Housekeeping:** the 5b and Upstash dev sessions can be archived.
- **4b merged (2026-11-13):** PRs #27 and #28, `main` = `9427fba`. The product owner tags `stable-2026-11-13-reminder-capacity`. The 4b dev session can be archived. Lesson: checks files use short commands, blocks at the left margin, rehearsed by copying each block verbatim into its own fresh shell.
- **Excel cost report hand-off:** branch `excel-cost-report` (from `9427fba`) has the blueprint and the checks draft committed. The product owner starts a fresh "CadenzPoint Development" session with the hand-off message (blueprint §13 plus `BLUEPRINT-STANDARD.md` §3: impact analysis first, then stop for the lead's review). The lead reviews the impact analysis, audits when the dev reports, and rehearses `EXCEL-COST-REPORT-BROWSER-CHECKS.md` against the finished branch (each block verbatim in its own shell) before the merge gate. **Before that rehearsal, rewrite the checks draft to the copy-paste standard** (its psql insert in D and the `curl … | python3 -c` in E are long one-liners with nested quotes: move them into a helper script written by a heredoc at the left margin).
- **Excel cost report merged (2026-11-13):** PR #29, `main` = `1d44b35`. The product owner tags `stable-2026-11-13-excel-cost-report`. The Excel dev session can be archived. PRODUCTION-DEPLOY Phase 15 row updated. Checks lessons (in the lead's memory): a local production server needs `AUTH_TRUST_HOST=true`; never read `~/Downloads` from a checks step.
- **Blueprint 5b written (seventh Planning session, 2026-11-13):** `feature-plan-large-report-responses.md` FINAL v3.1, pre-mortem CLEAN. Design: run the query and every check, then prepare all lines **before** the `Response`, and stream only prepared strings (`streamJoined`, 1,000 items per chunk, pull-driven). The output is byte-identical; the Excel gets a row cap with a 422. Key facts:
  - Next already pipes every route body (`send-response.js:61-62`), so whether today's routes hit 4.5 MB on Vercel is unproven (Q6). The staging step 12.13 baseline settles it.
  - The cut-off behaviour through Vercel's proxy is unverified; 12.13 tests it, judged by content and runtime logs.
  - Measured: about 610 MB of memory to build a 25,000-row Excel; about 650 MB per 500,000-row CSV; the query took 10–20 s for 931,000 rows locally.
  - **Accepted 2026-11-13 (Q1–Q6 as recommended).** `LARGE-REPORT-RESPONSES-BROWSER-CHECKS.md` is written: its helper steps were rehearsed against `main`, and the whole file gets rehearsed against the finished branch before the merge gate. PRODUCTION-DEPLOY **12.13** is written, its helper and seed SQL rehearsed locally.
  - **Impact analysis reviewed; go-ahead given (2026-11-13, lead → dev directly).** Approved details, within the design (audit against the blueprint plus these):
    - T5 asserts reads 1–2 resolve and read 3 rejects;
    - T9 keeps the `server-only` mock;
    - **no** `import 'server-only'` in `stream-text.ts` (it would break `v1-api-auth.test.ts`);
    - the CSV route returns `new Response(streamJoined(…))`, and `NextResponse` stays for the JSON 400/422;
    - the T13/T14 spies return a small `Buffer`;
    - **T15 goes in its own file, `src/__tests__/unit/api-stream-routes-static.test.ts`**;
    - big `timesheets/approved` chunks are noted, with no change;
    - tsc is reported for source files, with the two stale `.next/dev/types/validator.ts` lines (deleted H5 routes, the product owner's dev-server state) named separately.
  - **Checks file fix from the dev's item 8:** `/api/v1/periods` ties and `/api/v1/timesheets/approved` have no fixed order, so `compare` checks those two by rows ("SAME ROWS"), while the CSV and cost API stay byte for byte. Rehearsed on two captures of `main`, plus a negative test.
  - **Lesson:** message the dev session directly for hand-offs and reviews (product owner, 2026-11-13); the product owner sees verdicts and decisions, not relays.
  - **Audit READY (2026-11-13)** at `8265d27`.
    - **Break-it:** 14 of 15 caught; the miss is caught by the full suite.
    - **Auditors:** A was READY, proving byte identity with hostile inputs and Next's real pipe; B was clean on code and tests, with 20 of 20 reverts caught.
    - **Fix round 1:** two test-only LOWs (T11b BigInt → JSON 500; `maxDuration` pins).
    - **Planning's doc fixes:** the 12.13 seed now ends yesterday by UTC (MEDIUM M1); the checks wording; the baseline now uses the tag `stable-2026-11-13-excel-cost-report`, because local `main` was stale (`9427fba`).
    - **Integration:** 3 timing flakes under load, unrelated; 90/90 when re-run alone.
    - Removed four leftover auditor worktrees (they made `npm run lint` report 196 errors).
  - **Next:** the product owner's merge gate (push, PR, CI, checks), then merge and the tag `stable-YYYY-MM-DD-large-report-responses`. The dev session can be archived after the merge. Then Upstash, per-user billing, backups.
- **Excel cost report impact analysis reviewed; go-ahead given (2026-11-13).** Approved details (within the design, no product change), so audit against the blueprint plus these: T9/T10 (Excel half) in `charge-code-cost-rules.test.ts`, and T12/T14/T15 in its existing static "cost exports" describe; T13 adds exact `toEqual` on the 6 admin and 5 supervisor headers; the Q2 sentence's apostrophe is written `&apos;` (renders exactly); T8 uses `x-forwarded-for` `203.0.113.26`; T17 mocks `@/db` and `server-only` (lead probe: `drizzle.mock()` renders `leftJoinLateral` and aliased ORDER BY keys with no client); T5's revert check is the nominal `className: null` mapper edit; **T6 inserts both entries with explicit ids, `T6-BRAVO`'s sorting lower than `T6-ALPHA`'s** (entry ids are random UUIDs, so without this the tiebreaker revert check is a coin flip; with it, removing the code key fails deterministically). The dev stages files by name: Planning's uncommitted tracker and checks-file edits share the tree.
- **Excel cost report blueprint:** research done (fifth Planning session, 2026-11-12); E1–E4 decided (decisions log); blueprint FINAL v3.1 (pre-mortem CLEAN), accepted 2026-11-13 with Q1–Q5 as recommended (decisions log). The questions were: Q1 (existing 4.5 MB response limit and Excel memory: a separate streaming/cap item), Q2 (API dialog sentence), Q3 (Downloads description), Q4 (note text, plain ASCII), Q5 (UTF-8 BOM on the cost CSV, which already garbles "—"). Facts: one query (`getDetailedCostReportData`, `src/server/internal/reports.ts:37`) feeds the Excel, CSV and `/api/v1/costs`; it already returns one row per entry, so two codes on one CLIN show as two identical-looking rows today; Class lives on `charge_codes.class_id` (editable), not on entries; imports write `clin_id` only (`src/server/actions/migration.ts:118`); the PDF shows the charge code but not Class; the QuickBooks push never sends Class (`classRef` is never set; out of scope).
- **4b blueprint FINAL and accepted (2026-11-12)**; it goes to a fresh dev session on `reminder-capacity`. The lead then writes the Excel cost report, Upstash, per-user billing and backups blueprints. Each gets two pre-mortem rounds (plus a confirmation pass if round 2 finds a MEDIUM) and goes to the product owner before the dev.
- **4b implementation details Planning approved at the impact-analysis review (2026-11-12; within the design, no product change), so audit against the blueprint plus these:** B-test timings asserted relative to the first call, with a real-`setImmediate` poll instead of `vi.waitFor` (which advances fake timers); `recipientDomains` gets `unknown` when failures outnumber valid error indexes; `sent` capped at `messages.length`; timeout `errorName` = `send_timeout`; the email-stop summary puts "resumes mid-way" where the budget text does, with `cursor ?? '(start)'`; integration uses the `@/lib/date-utils` mock plus the real `configAt`; new-module revert checks are one named targeted mutation per row.
- **4b audit notes for the lead:** rehearse `REMINDER-CAPACITY-BROWSER-CHECKS.md` against the finished branch (it creates a throwaway `rccheck` workspace) before handing it to the product owner. The live Resend batch check (blueprint §12.1) runs at the staging rehearsal.
- **Note for the rate-limiting blueprint:** `login_attempts.ip_address` exists, but nothing writes to it. Drop the column or guard it so raw IPs stay unstored.

**4b research so far** (lead, 2026-11-11/12; re-verify line numbers before writing):
- **Senders:**
  - `daily-reminder` (weekdays 20:00 UTC) and `submission-deadline` (daily 20:00 UTC) both run `sweepTenants` (`src/lib/cron/tenant-sweep.ts`: 240 s budget, fair rotation, per-tenant resume after the last finished employee id, `cron-incomplete` ops alert).
  - Each awaits `createSendThrottle()` (`src/lib/email/rate.ts`, 500 ms = 2 sends/s per cron) before `deliverEmail` (`src/lib/email/send.ts`: one 429 retry after 2 s; success only with a message id).
  - The deadline cron still reads `notification_preferences.email_deadline_reminder` per employee.
- **Notice delivery is different:** `deliverPendingNotices` (`src/lib/tenant/notices.ts`, every 10 min) sends lifecycle and Terms notices to workspace admins, with a lease, a per-notice `sentAt` / `providerMessageId` record, and its own 500 ms throttle. Low volume.
  - **Decided (product owner, 2026-11-12):** batch only the two reminder crons; notices stay per-message.
- **Resend facts (installed `resend` 6.12.4 and resend.com docs, fetched 2026-11-11):**
  - `resend.batch.send(emails[], { idempotencyKey?, batchValidation?: 'strict' | 'permissive' })` posts to `/emails/batch`, up to 100 emails per call, with no attachments or `scheduledAt`. The SDK renders each `react` element to `html` first (`dist/index.mjs:220-245`).
  - The API body is `{ data: [{ id }] }` in input order, and the SDK wraps it, so the array is at `result.data.data` (corrected 2026-11-12 by pre-mortem round 1). With `permissive`, the body also has `errors: [{ index, message }]`. Default `strict` fails the whole batch on one invalid email.
  - Idempotency keys: unique per request, up to 256 characters, expire after 24 h.
  - The rate limit is 10 requests/s per team across all API keys, and a batch counts as one request. The daily and monthly email quotas count emails (the business item: the Resend plan).
  - Errors come back as `{ error }`, not thrown (as for single sends).

**Browser checks:** for every item, the lead writes a step-by-step `<ITEM>-BROWSER-CHECKS.md` (accounts, URLs, clicks, expected text, setup and cleanup commands). **Since 2026-11-13 the lead runs it** (preview browser config `app-dev` for real clicks: the preview can open `http://acme.localhost:3000` and sign in; curl and scripts for file and API content). The results and evidence go in the audit; the product owner reviews them. Never point the product owner at a blueprint section (product owner, 2026-11-12).

**Lead audit process (repeat for every item):**
1. **Lead gates:** `npx tsc --noEmit`, `npm run lint`, `npm run test`.
2. **A throwaway break-it script** (`breakit-check-<item>.mjs`, uncommitted). Each check applies one exact-text edit to product code, runs one integration file, expects a FAIL, then restores with `git checkout`. It supports `--dry-run`. Run it yourself: local Postgres is reachable, the sandbox is off.
3. **Two independent auditor sub-agents** (server half, UI and scope half). They run mutations, restore, and leave the tree clean. Don't run them alongside break-it.
4. **Write `<ITEM>-AUDIT.md`:**
   - fix round items go **inside** the approved blueprint, sent to the dev directly;
   - **scope items or anything that changes product behaviour → the product owner first**.
5. **After fixes:** re-run the gates and break-it, append a verification section, then the product owner's build plus browser checks.
6. **Merge commands only after the product owner says it's stable.** After merging, tag `stable-YYYY-MM-DD-<item>`.

**Next blueprints for the lead to write** (each goes to the product owner for review before the dev):
1. ~~Launch hardening follow-ups~~: merged (PR #26).
1b. ~~Reminder email capacity~~: merged (PRs #27, #28).
2. ~~Excel cost report~~: merged (PR #29, 2026-11-13).
2b. **Large report responses** (item 5b, from Excel Q1, accepted as "right after item 5"). **Blueprint FINAL v3.1, accepted 2026-11-13 (Q1–Q6 as recommended).** Facts so far: the cost CSV route and `/api/v1/costs` return whole bodies (Vercel 4.5 MB limit; streamed responses are exempt); the CSV and Excel downloads have no date-range cap; the API caps at 366 days; Excel peaked near 910 MB at 50,000 rows.
3. **Distributed rate limiting, Upstash:** keys must be salted hashes that expire ≤ 25 h; no raw IPs (`BUSINESS-DECISIONS.md` §4).
4. **Per-user billing** (`BUSINESS-DECISIONS.md` §1: plans, Stripe tiered prices, the quantity sync + daily reconcile, prorations, the 100-user cap message, ACH, promotion codes, send-invoice subscriptions + grace, the Billing page redesign). It also adds the landing Pricing section.
5. **Database backups** (`BUSINESS-DECISIONS.md` §5).

**Founder actions noted in `BUSINESS-DECISIONS.md`** (not engineering):
- Stripe products and price IDs;
- the AWS account, bucket and key pair;
- Resend;
- form the LLC;
- the lawyer review.

**Local test helpers:**
- throwaway workspaces via `npm run seed:tenant -- <slug> <db-url> admin@<slug>.test Admin 'Password123!'` after creating the DB with `psql`;
- import test files in `test-data/import-walkthrough/` (uncommitted).
