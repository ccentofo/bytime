# CadenzPoint launch tracker

The single source of truth for **where we are**, kept by the lead architect (session "CadenzPoint Planning") and updated after every step. Any new session reads this first.
- Blueprints: `feature-plan-*.md`.
- Audit records: `*-AUDIT.md`.
- Business decisions: `BUSINESS-DECISIONS.md` (kept by the business session).

**Last updated:** 2026-11-12.

## How we work
- **Scope is the product owner's.** Nothing is added, removed or changed in what the product does without the product owner's yes. The lead decides software design inside approved scope and brings every assumption or open question to the product owner.
- **Tandem mode:** the lead sends approved work to "CadenzPoint Development" and audits the results. The product owner sees every blueprint and every audit verdict, and runs all pushes, PRs and merges plus the browser checks.
- **Sessions:** a fresh dev session per blueprint; fix rounds stay in it. The lead checkpoints this file and its memory before starting a fresh planning session, and tells the product owner exactly when and how.
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
  3. the product owner has run the build plus the browser checks **personally** and said it's stable.

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
| 2 | UX-4c Part 2a: Setup checklist and Import (`feature-plan-ux-setup-import.md`) | audited (`UX-4C2A-AUDIT.md`): no HIGH or MEDIUM; break-it 11/11. fix round 1 **verified** (gates, break-it 11/11). **READY TO MERGE** (product owner confirmed stable 2026-11-11). Merge after CI is green, then tag `stable-2026-11-11-ux-setup-import`. |
| 3 | UX-4c Part 2b: Integrations, Landing, Terms/Privacy text (`feature-plan-ux-integrations-billing.md` v3.1) | blueprint FINAL (billing moved out); **waiting on the landing-claim check** (lead → product owner), then the fresh dev session |
| 3b | **Database backups**: daily encrypted `pg_dump` of every tenant and the control plane to S3 us-east-1, 30-day lifecycle, write-only credentials, monitoring, restore drill (`BUSINESS-DECISIONS.md` §5) | **approved 2026-11-11** as its own blueprint; blueprint to write |
| 3a | **Per-user billing** (new model, billing rules and Billing page, from `BUSINESS-DECISIONS.md` §1) | **approved 2026-11-11**; blueprint to write |
| 4 | Launch hardening audit + follow-ups (below) | **approved 2026-11-12**; the lead runs it with the dev |
| 5 | Excel cost report: charge codes and Class | **approved 2026-11-12**; blueprint to write |
| 6 | Distributed rate limiting (Upstash) | **approved 2026-11-12**; blueprint to write (constraints in the decisions log) |
| 7 | ~~UX-5 accessibility (Section 508) verification~~ | **not doing** (product owner, 2026-11-12) |
| 8 | Staging rehearsal (PRODUCTION-DEPLOY Phase 12), then production (Phase 13) | after the above. The approval-scope release is fix-forward only, with the window check. |

## Launch hardening follow-ups (approved for the lead to run directly with the dev)
- **Daily reminders: employees can't opt out** (product owner 2026-11-11). Remove the opt-out for the daily reminder.
- Employee-side "Self-rejected" badge still uses old wording.
- Slow-CI flaky screen tests (lighten the heaviest).
- Clean-up migration: current supervisors' membership rows not backed by a charge code (deferred until approval scope has been live once).
- "Late" day badge shows for days before a person was created.
- **Re-verify against current code** (don't assume still open):
  - the past-hours import skipping the period lock;
  - the connect routes being triggerable from another site;
  - the UX-4 database index note (C5).

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
| 2026-11-12 | Rate limiting: **Upstash** (expected to stay in the free tier). Rate-limit keys must be **salted hashes that expire within 25 hours** (matches the Privacy Policy). Raw IPs are never stored. |

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

## Business items (business session; outcomes land in `BUSINESS-DECISIONS.md`)
- Plan prices
- Landing copy
- Terms and Privacy §7 wording (also gates signup controls)
- Retention and backup policy
- Resend account
- Lawyer review
- Security posture (NIST 800-171 / CMMC, SOC 2, CUI)
- Trademark
- Intuit production approval
- Payroll accountant review
- Vendor file layouts in staging
