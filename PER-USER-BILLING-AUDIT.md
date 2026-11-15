# Per-user billing (3a): audit

**Item:** build queue 3a. **Blueprint:** `feature-plan-per-user-billing.md` FINAL v3.7, accepted 2026-11-15 (Q1–Q11 as recommended), plus the approved details B1–B3 and I1–I9 (`LAUNCH-TRACKER.md`, "Impact analysis reviewed").

**Audited commit:** `9fc2ced` on `per-user-billing` (the dev's single commit after the lead's `1a0484a`).

## Verdict: **READY** at `77c103a` (after fix round 1)
Round 1 (`9fc2ced`) was NOT READY: no HIGH, 1 MEDIUM code gap and MEDIUM test gaps. Fix round 1 (FR1–FR9) is verified in §6. The checks pass (§7). No scope items for the product owner.

## Round 1 verdict (kept for the record): NOT READY, fix round 1 required
No HIGH findings. 1 MEDIUM code gap, plus MEDIUM test gaps (guarded behaviour that survives mutation), plus LOWs. None changes what the product does, so nothing goes to the product owner first. The fix round below goes to the dev directly, inside the approved blueprint.

## 1. Scope check
Every changed file is in the blueprint's blast radius (§10.1) or explained by an approved detail:
- `src/lib/billing/tenant-reads.ts` (D1): keeps `getDbForUrl` out of `src/server/internal`, as an existing invariant test requires. `seats.ts` and `billing-reads.ts` re-export from it.
- `src/server/internal/billing-reads.ts` (B1).
- `lifecycle-store.ts` `resolveAlertsOfKind` (I2).
- `run-cron.ts`: the "five crons" comment only.
- Two test-allowlist updates: the new `seats:` lock key; 0010 is now the newest migration.

The dev's deviations are all inside the design, and all are accepted:
- D9: two `seat-quantity-corrected` events when both causes apply.
- D10: `set-plan enterprise` on an Enterprise workspace re-audits rather than refusing.
- D11: a `seat-sync-manual` audit event.
- D12: Payment rows 5–6 with `renewsOn` null show `Active` with no small text.
- D13: `choosePayInvoice` step 2 picks the earliest **due date**. That's the clearer reading; the blueprint is amended to say so.
- U12's first case fails without the change only at type level (`NoticeKind`): accepted.

**No unapproved product behaviour.**

## 2. Lead gates (main tree at `9fc2ced`)
| Gate | Result |
|---|---|
| `npx tsc --noEmit` | ✅ exit 0 |
| `npm run lint` | ✅ 0 errors in the main tree. The run reported 202 errors, all inside the two auditor worktrees under `.claude/worktrees`, a known artefact. Re-run after their removal in §6. |
| `npm run test` | ✅ 243 files, 2,759 tests |
| `npm run test:tz` | ✅ 3 zones, 2,759 each |
| `npm run db:safety` | ✅ no backward-incompatible statements |
| Integration and build | The dev ran both on this machine: integration 93 files / 800 tests, and the build, both passed. The lead re-runs integration **alone** after the fix round (§6). Concurrent runs against the shared test database produced timing flakes. |

## 3. Independent auditors
Two auditors ran in their own worktrees: A on the server half, B on UI, tests and scope. Both found the code faithful to the blueprint, including:
- the §6.2 send_invoice pseudo-code (line for line);
- the hold-then-drop planner and window;
- `mark_seq`;
- the term race;
- alerts kept out of the seat transaction;
- the failure backoff;
- step 8;
- the webhook exclusivity rules;
- guard order;
- every customer-facing string, byte for byte, against §1 and the blueprint.

Mutation results: A caught 18 of 28, B caught 12 of 18. **Every miss was a test gap, not a code defect**, except FR1.

## 4. Findings
| # | Severity | Finding | Where |
|---|---|---|---|
| FR1 | MEDIUM | `seat-sync-schedule-attached` is raised mid-term with `raiseAlert` under the key `subId`. In the renewal window it's raised with `raiseAlertWithEmail` under the **same** key, and that only emails on open (`ops-alert-email.ts:24`). A schedule found mid-term (the usual case) therefore never gets the window email promised by §6.4 step 3 and F31. | `seat-sync.ts:359-366` |
| FR2 | MEDIUM | Test gaps: guarded behaviours that survive mutation (list below). | tests |
| FR3 | LOW | A step 8 re-mark overrides the main run's exponential backoff (now + 10 min). | `seat-sync.ts:580-587` vs `491-494` |
| FR4 | LOW | A failed `invoices.list` in step 8 throws out of the section without the 10-minute re-mark (§6.4 says to re-mark "on a failure"). | `seat-sync.ts:548` |
| FR5 | LOW | The Billing page's invoice lists pass `{ timeout: 5000 }` but keep the SDK's 2 retries: about 15 s per list, about 30 s with the uncollectible fallback. That contradicts §9's ~5 s. | `billing.ts:172,175` |
| FR6 | LOW | The checkout count has no time cap. | `billing.ts:53` |
| FR7 | LOW | A failed alert write in `checkPriceConfig` or the final `cron-incomplete` write aborts the whole cron run. | `seat-sync.ts:690,717` |
| FR8 | LOW | Corrections with no Stripe call (changed outside the sync) are reported as `in-sync` in the cron summary. The audit and digest are still right. | `seat-sync.ts` summary |
| FR9 | LOW | PRODUCTION-DEPLOY runbook step 6 says "confirm in `show` that the subscription has no schedule alert". `show` can't see schedules. | `PRODUCTION-DEPLOY.md` runbook |

**FR2, the missed mutations to cover:**
- Server, auditor A:
  - M9: the step 8 `auto_advance: true` skip;
  - M10: `becameGood`'s revival clause;
  - M11: no `bank-payment-failed` for an ended tenant;
  - M13, M14: the stuck-invoice rules (stop forcing retries; daily only);
  - M17: the send_invoice DUNNING-filter exclusion in `toCancel`;
  - M18: the send_invoice "paid" branch of `cancelInOwnSection`;
  - M21: the correction's same-subscription condition;
  - M24: daily candidates require a syncable mirror;
  - M27: step 8 eligibility (LIVE, not GOOD);
  - M28: the renewal list's +5-minute lower bound.
- UI and tests, auditor B:
  - M3: Payment row 2 takes precedence over 2b, for an overdue invoiced `past_due` customer;
  - M4, M14, M15: the server-computed `TenantBillingInfo` fields (dates in the workspace time zone, `billedQuantityApplies`, `canSubscribe` when closed or policy-held);
  - M6: the interval validated after the tenant, closed and policy guards;
  - M11b: the `bank-payment-failed` email subject;
  - M13: the many-invoices line on rows 1, 2b and 3;
  - S45's renewal-list exclusion of ended tenants never exercised (a fixture with the period end 6 h away);
  - the Users page passing `displayPlan(plan)` (legacy `pro`).

## 5. Fix round 1 (sent to the dev, inside the blueprint)
1. **FR1:** inside the window, raise the emailed variant under `${subId}:${periodEnd}` (as `seat-sync-renewal-at-risk` does). Resolve both keys when cleared. Test: schedule seen mid-term, then an in-window run emails.
2. **FR2:** one targeted test per missed mutation above, each failing under that mutation.
3. **FR3:** the step 8 re-mark uses `GREATEST(next_attempt_at, now + 10 min)`, or skips the re-mark when the main outcome was `failed`.
4. **FR4:** catch a step 8 list failure and do the 10-minute re-mark in its own statement.
5. **FR5:** add `maxNetworkRetries: 0` to the Billing page's invoice lists; run them so the worst case stays about 5 s each (§9).
6. **FR6:** cap the checkout count at 3 s with the same race helper. On timeout, refuse with `UserFacingError('Couldn't count your users. Please try again.')`. Exact text approved by the lead: it's an error message within the design, not product copy.
7. **FR7:** catch and log alert-write failures at cron start and end.
8. **FR8:** count a correction with no call as `corrected` in the summary.
9. **FR9:** reword runbook step 6: "check in the Stripe Dashboard that the subscription has no schedule".

Then re-run every gate, write a fix-round section in the dev report, commit, and message the lead.

## 6. Verification after fix round 1 (`77c103a`)
**Scope.** Fix round 1 touched only `seat-sync.ts`, `billing.ts`, the tests and `PRODUCTION-DEPLOY.md`, all named in §5. No new behaviour beyond FR1–FR9. The one new string is the FR6 error text, approved by the lead.

**Code read by the lead:**
- FR1: the in-window email is keyed `${subId}:${periodEnd}`, and a clear resolves both keys.
- FR3: `GREATEST(next_attempt_at, now + 10 min)`.
- FR4: a failed list re-marks the tenant (a Stripe error doesn't abort the SQL transaction).
- FR5: `maxNetworkRetries: 0` on both lists.
- FR6: a 3 s cap through the `billingTenantReads` seam.
- FR7: both alert writes are caught.
- FR8: `outcome.corrected` is counted in the summary.
- FR9: the runbook is reworded.

**The dev's FR2 tests:** 27 of 27 targeted mutations caught; the round-0 set re-run, 20 of 20 still caught.

**Lead gates:**

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | ✅ exit 0 |
| `npm run lint` | ✅ 0 errors, 39 warnings (all pre-existing). Auditor worktrees removed. |
| `npm run test` | ✅ 2,761 passed |
| Integration, **run alone** with the control-plane env (the memory-noted command, so control-plane suites can't skip silently) | ✅ 93 files passed, 2 skipped (the isolation-DB suites, as before); 822 tests passed |

A first integration attempt without `CONTROL_PLANE_DATABASE_URL` in the environment failed in setup (95 files, "no tests"). It was re-run with the env and is green.

**Lead break-it** (`/tmp/pub-breakit/breakit-check-pub.mjs`, uncommitted; one exact-text edit per check, run its test file, expect FAIL, restore): **8 of 8 caught, tree clean.**
- D only in the window;
- year → `always_invoice`;
- the window ends 5 minutes early;
- the FR1 per-renewal key;
- the ended old-debt guard;
- unsuspend on a later anchor;
- the Standard cap message;
- ACH offered in Checkout.

The integration checks loaded the control-plane env, so a missing env can't be mistaken for a catch.

## 7. Checks run by the lead (`PER-USER-BILLING-BROWSER-CHECKS.md`, at `77c103a`, 2026-11-15)
**Method.** The helper block was extracted verbatim and run in a fresh `zsh -i`. `npm run demo:local` was run ("✅ Local demo ready"). The app ran under the preview tool's `app-dev` config, with real clicks and fills in the preview browser. The throwaway workspace was `pub11151414`.

| Section | Result | Evidence |
|---|---|---|
| 0 Setup | ✅ | helper usage line; demo ready; `Ready: http://pub11151414.localhost:3000` |
| A Landing Pricing | ✅ | header `Features, Pricing`; h2 `Pricing`, h3 `Trial/Standard/Enterprise`; all price, detail and users strings exact; mailto exact; no "tax"; screenshot after clicking `Pricing` (at 1280 px) |
| B Billing, trial | ✅ | tiles `Free trial / Ends Dec 3, 2026 · 18 days left`, `1 of 10 used / Active users count. Inactive users don't.`, `None yet / Choose a plan before your trial ends to keep editing.`; cards and footnote exact; both Choose buttons disabled with `Not available yet.`; headings h1 → h2 → h3; no raw status; screenshot |
| C Billing, Standard states | ✅ all 8 | `monthly`, `annual`, `ending` (`Ends Dec 5, 2026`), `held 9` (`Billed for 9 users until Dec 5, 2026. Removed users leave your bill at renewal.`), `held 4` (standard line, no held line), `overdue` (`Payment overdue … Use Manage billing to pay.`), `inv-open` (`Invoice open / Pay it by the due date on the invoice.`), `ended` (`Canceled / Ended on Nov 13, 2026. Choose a plan to start again.`, with cards shown); no cards in the other 7 |
| D BillingWall | ✅ | h1 `Workspace suspended`, h2 `Billing`; `Suspended / Pay the open invoice to restore access. / Use Manage billing to pay.`; no error; screenshot |
| E Users seat line | ✅ | trial `1 active · 9 of 10 seats free` + drawer `Uses 1 of 9 free seats`; Standard `1 active · up to 100`, no drawer line |
| F 100-user cap | ✅ | user 101 on Standard: `Your plan covers up to 100 users. Contact us at support@cadenzpoint.com to add more.` (screenshot); trial: `Your Trial plan allows 10 active users (you currently have 100). …` |
| G Enterprise | ✅ | dry run `Would: set the plan to ENTERPRISE …` / `Dry run — pass --yes to apply.`; `plan: enterprise`; Billing `Enterprise / Custom terms`, `100 active users / No user limit.`; user 101 added (101 active in the DB); `set-plan standard` → `plan: standard` |
| H Seat-sync mark and cron | ✅ | add → `due t, mark_seq 1`; deactivate → `mark_seq 2`; rename another user → still 2; cron JSON `counts: {"not-applicable":1}`; then `due f` |
| I Stripe-mode guard | ✅ | no key → refused; dummy test key without `--stripe-mode` → `Pass --stripe-mode live|test`; `--stripe-mode live` with a test key → `doesn't match … refusing`; `show` prints plan (interval), `collection_method`, the seat row, the live active count |
| J Clean up | ✅ | `tenant:delete` dropped the database; name file removed; helper removed |

**Checks-file fixes from the rehearsal** (folded into the file):
- a note that the app caches workspace facts for 60 s (wait before checking pages other than Billing);
- the window width needed for the header link;
- the exact Section I refusal texts;
- a new `prune` helper step, because Section H couldn't add a user after F's 100+ users (re-rehearsed verbatim).

**Not covered locally (staging 12.8/12.8b):** Checkout redirect, quantity updates in Stripe, ACH, invoices, renewals and the §4 test-mode checks.
