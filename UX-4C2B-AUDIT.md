# UX-4c Part 2b audit: Integrations, Landing, Terms/Privacy text

> **Blueprint:** `feature-plan-ux-integrations-billing.md` v3.1. **Branch:** `ux-integrations-landing`, `239bbbe..2b6c131` (8 commits). **Dev's analysis:** `UX-INTEGRATIONS-LANDING-IMPACT-ANALYSIS.md` (G1–G12).
>
> **Lead:** CadenzPoint Planning, 2026-11-11.
>
> **Verdict: NOT READY. Fix round 1 is required.**
> - No HIGH findings.
> - 6 MEDIUM, 4 of them weak tests.
> - The scope items (§4) go to the product owner first.

## 1. Lead gates (run by the lead at `2b6c131`)
| Gate | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors |
| `npm run lint` | 0 errors, 39 warnings (none new) |
| `npm run test` | 220 files, 2,404 / 2,404 |
| Dev's reported runs, not re-run by the lead | `test:tz` 3 × 2,404; `db:safety` OK; integration 86 files / 704 tests, with 2 isolation files skipped (product-owner machine) |

## 2. Break-it (`breakit-check-ux4c2b.mjs`, uncommitted; local Postgres)
23 one-line mutations, each checked against its own test file. **22 failed as they should. One test is weak:**
- **B15:** `getSendPreview`'s not-yet-approved count. Inverting the filter (`ne(status,'approved')` → `eq`) still passes, because the fixture has exactly 1 approved and 1 submitted person.

The other 22 are covered:
- the person lock;
- `saveMapping` rejecting person types;
- match-by-email skipping already-matched people;
- QuickBooks-only matching;
- reconnect: deactivating other rows, reusing the oldest row, a null company id;
- the `provider=qbo` redirect;
- the send guard and its stale-log exception;
- the exclusive flag;
- period-start-only sends;
- the failed-record count;
- expired clearing after reconnect;
- the preview's and the hub's unmatched counts;
- `failureSummary`;
- the coverage rule;
- the load refusing a non-QuickBooks connection;
- the landing headline, the Terms §7 text, and the header Sign in link.

The tree was clean after the run.

## 3. Findings (two independent auditors plus the lead; every item verified in code by the lead)

### MEDIUM: fix round 1 (inside the approved blueprint)
| # | Finding | Evidence | Fix |
|---|---|---|---|
| F1 | **Legacy duplicate QuickBooks rows: the page and reconnect pick different rows.** `activeConnection` takes the **newest** active row, but reconnect revives the **oldest**. The old page used the oldest active row, and every old reconnect inserted a new row without deactivating the old one. Until the next connect, an affected workspace would see 0 matched and an empty History, and "Send hours" would skip everyone. If the admin re-matched and sent, the duplicate warning would miss periods already sent from the old row, creating **duplicate time entries in QuickBooks**. The blueprint's own I9 parenthetical said "newest": a lead error, corrected here. | `src/server/internal/integrations.ts:100` vs `:59`; `239bbbe:quickbooks/page.tsx:37` | `activeConnection` orders by `asc(createdAt), asc(id)`, the same rule as reconnect. `getSendPreview`'s coverage check reads logs from every connection row with the same provider and the same non-null `external_company_id`. Test: two active legacy rows → the hub, page and preview use the oldest, and a log on another row of the same company still triggers the duplicate warning. |
| F2 | **Saved matches show "(not found in QuickBooks)"** while lists load, and permanently when a list fails to load. The old `MappingSelect` had a "not loaded" mode; it was dropped. | `IntegrationConfigView.tsx:138` (`listData` → `[]`), `:403-409`; `MappingSelect.tsx:31-33` | Add the "not found" option only when that list is `ok: true`. Otherwise show the saved name as the current value. Test: lists pending, then failed → the saved match name shows without "(not found…)". |
| F3 | **Match by email can pick the wrong type with a partial load.** If employees fails and vendors loads, an email on both a W-2 employee and a vendor isn't seen as ambiguous, and the person is saved as a vendor (1099). That breaks I5. | `IntegrationConfigView.tsx:147-156` | No suggestions, and no "Match {n} people by email", unless **both** `lists.employees.ok` and `lists.vendors.ok`. Test: employees failed and vendors ok → no suggestion and no button. |
| F4 | **IN-14 doesn't prove the send lock.** Deleting the `integration-send:` lock line leaves 16/16 green, because the test database has one connection, so calls serialize anyway. (Lead-verified.) | `sync-engine.ts:198` | Use the IN-5 technique: a holder client takes the `integration-send:{conn}` lock, the test asserts `triggerQBOSync` waits (`pg_locks`), then releases it and expects one new log, or the refusal. |
| F5 | **B15: the not-yet-approved count test is weak.** | `integration/integrations.test.ts:280-292` | Add a second not-approved person (a `rejected` or `draft` row) and an approved person with no hours, then assert the exact counts. Inverting the filter must fail. |
| F6 | **Two more weak UI tests.** (a) IN-10 "See failures only when records exist": rendering on `recordsFailed` instead of `failedRecords` passes. (b) "Optimistic change": removing the optimistic update passes, since only the revert is tested. | `IntegrationConfigView.tsx:510`, `:166`; `unit/integration-mapping-ui.test.tsx` | (a) Add a failed log with `recordsFailed: 3, failedRecords: 0` and assert no button. (b) Hold `setPersonMapping` on a deferred promise and assert the new value shows before it resolves. |

### LOW: in fix round 1 (small, inside the blueprint)
| # | Finding | Fix |
|---|---|---|
| F7 | The hub card ignores the last send's status. A failed or still-running send reads "Last sent … · 0 sent, 0 failed" (`IntegrationsClient.tsx:50-58`). I1 asks for the "last send result in words". | For `failed` or `running` logs, use `syncResultText` (the §6 wording) after "Last sent {date} · ". Test both cases. |
| F8 | `triggerQBOSync` doesn't check the provider. A Gusto connection id runs Gusto's local-record path. | Refuse unless `provider === 'quickbooks_online'` and the connection is active. Test it. |
| F9 | G8 "Keep the employee match" has no test. | Click test: `setPersonMapping` is called with type `employee`. |
| F10 | "Didn't finish" uses a straight apostrophe while the rest of the copy uses ’. "Everyone is matched." shows when there are no people at all. | Use ’. With no people, show "No active people yet." Test both. |
| F11 | `getSyncLogs` takes an unvalidated `limit` and `connectionId`. | Validate the UUID; clamp `limit` to 1–100. |

### LOW: recorded, not fixed here
- **R1. Token refresh can race across requests.** A page load running during a send, or two tabs, can each rotate the refresh token. A refresh can also write tokens onto a row a reconnect just deactivated (`qbo-api.ts:136-176`). I3 fixed the race within one load only. Proposed fix: a per-connection token lock in `ensureValidToken`. **Logged as an engineering follow-up for the product owner to place** (recommended: the launch hardening blueprint as H6, or its own small item).
- **R2. The 15-minute stale rule assumes a function timeout.** Self-hosted (Docker) has none, and QuickBooks calls have no timeout. This follows the blueprint as written. Revisit if self-hosting is used.
- **R3. The preview's "not matched" count includes inactive people with approved hours,** who can't be matched (the People tab lists active people only). The text is still true: their hours are skipped.
- **R4. "Not approved yet" counts draft rows without hours.** Acceptable.
- **R5.** `getSyncLogs`, `getConnections` and `getMappings` call `getDb()` before `requireAdmin()`. That resolves the tenant but runs no query; it predates Part 2b and the guards test passes.

## 4. Scope items for the product owner (product-visible, not written in the blueprint)
| # | Item | Lead recommendation |
|---|---|---|
| S1 | **Landing labels not in `BUSINESS-DECISIONS.md` §2** (G5): final CTA heading "Ready to try it?" (kept from today); © line "© 2026 CadenzPoint" (was "— DCAA-Compliant Timekeeping…"); the product preview's sample content ("My timesheet · Oct 16 – 31", "Draft", "NAVAIR-0001", "Leave · Annual", hours) and its label "Product preview: a timesheet in CadenzPoint". | **Accept.** |
| S2 | **The Integrations page description** says "Send approved hours to your accounting and payroll systems." Nothing is sent to payroll systems (I10). | **Change** to "Send approved hours to QuickBooks Online, or download payroll files for your payroll system." |
| S3 | **The Gusto card** shows a green "Connected" badge next to "Sending hours straight to Gusto isn't available yet." | **Remove the badge** on the Gusto card, keeping "Manage connection" (G9) so Disconnect stays reachable. |
| S4 | **Hub wording** from the approved mockup (G6): card subtitles "Accounting", "Payroll", "ADP, Paychex, Gusto or generic"; the QuickBooks, Payroll file and API keys descriptions; badges "Connected" / "Needs reconnecting" / "Not connected"; "Open API keys"; hiding "0 people not matched" (G11); singular forms (G12). | **Accept.** |
| S5 | **QuickBooks page and send-modal wording** not spelled out in the blueprint: "Keep the employee match" (G8); "Suggested: {name} (same email)"; " · Employee" / " · Vendor" suffixes; "Loading QuickBooks data…"; the empty states; customer and service-item placeholders; History "How" labels (Manual / On approval / Retry); the Drawer title "Entries that failed"; the match toast; the modal title "Send hours to QuickBooks", "Approved hours from", the period labels, the unmatched line, "Checking this pay period…", "Couldn't check this pay period. You can still send it.", and "Send finished" toasts. | **Accept.** |
| S6 | **The Disconnect dialog promise:** "Matches and send history are kept, and reconnecting the same company brings them back." It's true per I9, and F1 makes it hold for legacy data too. | **Accept.** |
| S7 | `/settings/integrations/quickbooks?connectionId=…` is now ignored; the page always shows the active connection. | **Accept** (one active connection per provider, I9). |

**Already approved by the product owner:** `TERMS_VERSION = '2026-11-10-interim'` (only recorded at signup; it doesn't force anyone to re-accept), and Privacy "Last updated: November 2026".

## 5. Verified correct (highlights)
- **Landing copy:** character-by-character equal to `BUSINESS-DECISIONS.md` §2 plus the 2026-11-11 amendments.
  - Feature 6 uses the pre-approval text.
  - The disclaimer sits above the © line.
  - The "DCAA Compliant" badge is kept.
  - No Pricing, offline, auto-sync, "fault-tolerant" or Tech stack.
  - The demo block and metadata are unchanged.
  - Skip link, `main#main-content`, `scroll-margin-top`, and the preview has `role="img"` with a label.
- **Terms and Privacy:**
  - Terms §7 is exactly A1.
  - Privacy is exactly A2 (§1, §3, §4, §7), with §2, §5, §6 and §8 untouched.
  - The Privacy claims match the code: sessions last 24 hours (`auth.ts:291`), and no raw IP is stored. `login_attempts.ip_address` exists but no caller passes an IP. That's a note for the rate-limiting blueprint: drop or guard that column.
- **Security:**
  - every new exported action guards first;
  - identity comes from the session;
  - no token reaches the browser (`hasTokens` boolean only);
  - lock keys are consistent, taken first in the writing transaction, and no transaction holds two lock families;
  - removed fetch actions (G1) have no remaining callers.
- **Reconnect (I9, G7):**
  - the oldest row is reused by non-null company id;
  - other active rows are deactivated and their tokens cleared;
  - concurrent completes are serialized.
- **Engine:** errors carry `kind`, and `failureSummary` counts failures only. An exception after the guarded insert leaves the log `failed`. The dev's fix `7237a7e` is real: reverting it fails IN-10.
- **UI:**
  - the banner comes from server props and survives `replaceState`;
  - the StrictMode single load (IN-4 fails without the guard);
  - the People tab, the double-match warning, and the revert on error;
  - the send modal's period options and warnings, with no custom dates;
  - History matches the §6 table;
  - Gusto never says "sent" and has no Connect;
  - read-only workspaces use `WriteButton`;
  - no redirect is awaited inside a catch.

## 6. Next
1. **Fix round 1 (F1–F11)** goes to the dev now, inside the approved blueprint.
2. **S1–S7** go to the product owner. Accepted items need no code; S2 and S3, if accepted, join the fix round.
3. After the fixes: lead gates, break-it (add checks for F1, F4, F5), a verification section here, then the product owner's build plus browser checks (blueprint §11).

## 7. Fix round 1 verification (lead, 2026-11-11)
**Commits:** `cbeb628` (F1), `e7a74a5` (F2–F3), `20ce12d` (F7–F11), `8ea9ca5` (tests). Tip `8ea9ca5`. The dev reports no changes outside F1–F11, and the lead's diff review confirms it.

| Check | Result |
|---|---|
| Lead gates at `8ea9ca5` | `tsc` 0 errors; lint 0 errors (39 warnings, unchanged); unit 220 files, **2,411 / 2,411** |
| Dev's reported runs | `test:tz` 3 × 2,411; `db:safety` OK; integration 86 files / 708 tests (2 isolation files skipped, product-owner machine) |
| Break-it, extended to 27 checks | **27 / 27 fail as expected.** B15 (previously weak) now fails. New checks:<br>• **B24:** the page uses the oldest active row (F1);<br>• **B25:** coverage spans every row of the same company (F1);<br>• **B26:** the send lock is taken (F4);<br>• **B27:** `triggerQBOSync` accepts QuickBooks only (F8).<br>B6's anchor was narrowed, because F1 made two `orderBy` lines identical. The tree was clean after the run. |
| Dev's revert checks | 16 / 16 (F1a–F11b) |

**Diff review:** F1–F11 each match §3.
- F2 keeps the saved name, with its Employee or Vendor suffix, while a list is pending or has failed.
- F3 gates suggestions on both lists.
- F7 reuses the §6 wording.
- F8 refuses before any log is written.
- F11 clamps `limit` to 1–100.

**Verdict for the code: READY,** once the product owner rules on scope items **S1–S7**.
- If S2 and/or S3 are accepted as recommended, those two copy and badge changes go to the dev as a small addendum. The lead then re-runs the gates and the affected unit tests before the product owner's checks.
- If everything is accepted as built, nothing else changes.

**Then:** CI green on the PR, and the product owner's machine:
- integration with the isolation databases;
- `npm run build`;
- `npm run demo:local`;
- the blueprint §11 browser steps 1–4.

## 8. S2/S3 addendum verification (lead, 2026-11-11)
**Commit:** `2d029ee`, which touches `IntegrationsClient.tsx` and `integration-hub-ui.test.tsx` only.
- **S2:** the description is exactly the approved sentence.
- **S3:** the Gusto card has no badge; "Manage connection" stays.

**Lead checks:**
- gates: `tsc` 0, lint 0 errors (39 warnings, unchanged), unit **2,412 / 2,412**;
- lead revert check: restoring the old description fails the S2 test (1 failed / 10 passed);
- dev: both revert checks fail, `test:tz` 3 × 2,412.

**Verdict: READY.** The lead audit is complete. Merge gate: CI green on the PR, then the product owner's machine:
- integration with the isolation databases;
- `npm run build`;
- `npm run demo:local`;
- blueprint §11 browser steps 1–4.
