# Per-user billing (3a): audit

**Item:** build queue 3a. **Blueprint:** `feature-plan-per-user-billing.md` FINAL v3.7, accepted 2026-11-15 (Q1–Q11 as recommended), plus the approved details B1–B3 and I1–I9 (`LAUNCH-TRACKER.md`, "Impact analysis reviewed").

**Audited commit:** `9fc2ced` on `per-user-billing` (the dev's single commit after the lead's `1a0484a`).

## Verdict (round 1): NOT READY — fix round 1 required
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

## 6. Verification after fix round 1
*(pending)*

## 7. Checks run by the lead
*(pending: `PER-USER-BILLING-BROWSER-CHECKS.md`, rehearsed and run against the fixed branch)*
