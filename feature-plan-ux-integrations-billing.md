# Blueprint UX-4c Part 2b: Integrations, Landing, Terms/Privacy text (billing moved out in v3.1)

> **Status:** v3.1 FINAL, 2026-11-11, lead architect. Pre-mortem rounds 1 and 2 applied (§13).
>
> **v3.1 scope change (product owner, 2026-11-11):**
> - **Billing is removed from this blueprint.** It moves to the per-user billing blueprint, because the business changed the pricing model (`BUSINESS-DECISIONS.md` §1).
> - **Landing uses the business's exact copy** (`BUSINESS-DECISIONS.md` §2).
> - **The dev applies the business's Terms §7 and Privacy text** (`BUSINESS-DECISIONS.md` §3 A1, A2).
> - So this blueprint is now **Integrations + Landing + Terms/Privacy text**.
>
> **Branch:** `ux-integrations-billing`, from `main` (independent of `approval-scope` and Part 2a; built after them in sequence).
>
> **Approved design:** `ux-mockups/ux4-batch2b.html`, screens Integrations, Billing and Landing (`UX-4-AUDIT.md` §10). The QuickBooks "send on approval" switch is **hidden** (product-owner decision). Prices and the headline are business-owned (Q4, Q5).
>
> **Product-owner direction:** polished, usable, professional; not overengineered.

---

## 0. Lead rulings
| # | Ruling |
|---|---|
| I1 | **Integrations hub:** each connector appears once. Its card shows the connection state, company, last send result in words and unmatched people, plus one primary action. A banner shows the callback result. The **server page** reads `connected` / `provider` / `error` and passes them as props. The client keeps the banner in state initialised from those props, and an effect only calls `replaceState` to drop the params. (`replaceState` syncs `useSearchParams`, `next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md:345`, so a banner read from it would vanish.) |
| I2 | **One config template** (`IntegrationConfigView`) for QuickBooks: status line, matching tabs with counts, "Send hours now…", recent sends, "Reconnect" when expired, "Disconnect…". The auto-sync switch and the hub's Auto-sync badge (`IntegrationsClient.tsx:97`) are **not shown**; the unused `toggleAutoSync` import is removed. |
| I3 | **Provider data loads automatically** when the page opens, through **one** action, `loadQboMappingData(connectionId)` (`requireAdminFresh`). It calls `ensureValidToken` once, then runs the 4 queries with `Promise.allSettled` on the server and returns a result or error per list. Parallel token refreshes rotate the refresh token and the last write wins (`qbo-api.ts:158-176`), which could break the connection. The mount effect is guarded by a ref (StrictMode). It reloads on each visit (no cache). |
| I4 | **One match per person:** one select per person, with Employees (W-2), Vendors (1099) and "Not matched". `setPersonMapping` replaces the person's employee **and** vendor mapping in one transaction, under `pg_advisory_xact_lock(hashtext(connectionId || ':' || userId))` taken first, with `onConflictDoUpdate`. An existing double mapping shows the employee match with "Also matched to vendor {name}. Choose one." |
| I5 | **Match by email:** the client finds unmatched people whose email equals exactly one unmatched provider record, case-insensitive. A QBO email matching both an employee and a vendor counts as ambiguous and isn't suggested. It calls `matchPeopleByEmail`, which shares `setPersonMapping`'s validator and lock per user, de-duplicates `userId` and batches its reads. |
| I6 | **"Send hours now…" (QuickBooks)** picks one pay period: the last completed period (default), this period, or the two before. **No custom dates**: QBO sends whole approved periods whose start falls in the range (`sync-engine.ts:45-59`), so a custom range would mislead.
  - A warn line when people with approved hours in that period aren't matched.
  - **Duplicate warning:** a period counts as **covered** when a log has `records_pushed > 0`, status `success` or `partial`, and `period_start <= p.start <= period_end`. That matches how the engine picks periods (`sync-engine.ts:56-57`) and catches legacy three-month windows. The warning reads "Already sent on {date}. Sending again creates duplicate time entries in QuickBooks." QBO pushes are plain creates (`qbo-api.ts:497`).
    - A stale `running` log covering it warns "This period may have been partly sent on {date}."
  - **Concurrent sends:** `triggerQBOSync` refuses ("A send is already running. Try again in a few minutes.") when a `running` log under 15 minutes old exists for the connection. It's checked under `pg_advisory_xact_lock(hashtext('integration-send:'||connectionId))`.
  - **Late approvals:** `getSendPreview` also returns people in the period who aren't approved yet. The modal says "{n} people aren't approved yet. Their hours won't be sent, and sending this period again later resends everyone." Per-entry de-duplication is a recorded product-owner follow-up. |
| I7 | **Recent sends in words** (state table §6):
  - Result shows `errorSummary` whenever status is failed.
  - "· {n} skipped: people not matched" when skipped > 0.
  - "See {n} failures" only when failed **records** exist; a Drawer lists them with labels resolved on the server.
  - A `running` log older than 15 minutes shows "Didn't finish".
  - Skips are counted per time **entry** (`quickbooks-online.ts:122-127`), so the copy says "entries".
  - **Engine fix:** `SyncResult.errors` gains `kind: 'skipped' | 'failed'`, and `errorSummary` uses failed ones only. |
| I8 | **The complete route maps the provider** to `&provider=qbo|gusto` (the route's own value is `quickbooks_online`, `oauth-connect.test.ts:76`). |
| I9 | **Reconnect keeps matches.** `saveIntegrationConnection` (`internal/integrations.ts:27`) runs in one transaction under `pg_advisory_xact_lock(hashtext('integration-connection:'||provider))`.
  - **Match:** a row with the same provider and `external_company_id IS NOT NULL AND =` the new id. Legacy duplicates may exist (every reconnect inserted one), so it takes the **oldest** such row: the one the current UI mapped against.
    - When matched, update its tokens, `is_active = true`, `disconnected_at = null`, `connected_at = now()`, `external_company_name`, `display_name` and `connected_by`.
    - Otherwise insert.
  - **In both branches, deactivate every other active row for the provider.** One active connection per provider; the hub and page use that row (or the newest active, deterministically, if legacy data has several until the next connect).
  - A null company id never matches, so it inserts.
  - **"Reconnect" lives on the hub card** (the config page redirects when no active connection exists, `quickbooks/page.tsx:32-34`) and on the config page's status line when the token is expired. |
| I10 | **Gusto is honest.** The Gusto connector sends nothing to Gusto today; it only writes local records (`connectors/gusto.ts:142-147`).
  - **The hub's Gusto card has no Connect.** It reads "Sending hours straight to Gusto isn't available yet. Download a Gusto payroll file from Payroll export." with "Open Payroll export".
  - An **existing** Gusto connection's page shows only that note, "Open Payroll export", and Disconnect. Matching is **dropped**: nothing reads Gusto mappings (Payroll export uses none, `payroll-export.ts:18`), so it would be a control that does nothing. The card says the same.
  - Drop the Gusto branches from the mapping actions and tests, and the `fetchGustoEmployeesForMapping` load.
  - Correct the connector description (`gusto.ts:29`).
  - A test asserts no Gusto UI says "sent". |
| L1 | **Landing copy lives in one file**, `src/lib/marketing/landing-copy.ts`, with the strings **exactly** as in `BUSINESS-DECISIONS.md` §2 (headline, subhead, feature h2, six feature titles and blurbs, footer disclaimer).
  - Use feature 6's **pre-approval** text ("…QuickBooks Online integration coming soon."). The product owner says when to switch.
  - **Any wording that differs from §2 needs the product owner's approval.**
  - **Approved accuracy amendments (product owner, 2026-11-11)** override §2 for these blurbs:
    - **Feature 1:** "Every change creates a new revision with a reason, and the database itself blocks overwriting or deleting entries. Auditors see who changed what, when, and why."
    - **Feature 2:** "…daily reminders keep employees on track." (replaces "everyone")
    - **Feature 4 (full blurb):** "Employees certify each timesheet when they submit it. Supervisors approve or return it. Submitted and approved timesheets lock."
    - **Feature 5:** "PDF timesheets, cost reports in CSV and Excel, and an audit trail you can filter by person, contract and reason."
    - Everything else in §2 is verbatim.
  - **Keep the "DCAA Compliant" badge** (§2 "Unchanged"). |
| L2 | **Landing header:** logo, Sign in (`/login`, the apex "Find your workspace", `workspace-auth-gate.tsx:16-17`) and "Start free trial". From the `sm` breakpoint it also shows Features and Try the demo (when `NEXT_PUBLIC_DEMO_URL`). **No Pricing link or section in this blueprint:** prices arrive with per-user billing, so the landing page can't advertise per-user prices while Checkout still sells the old tiers. There's no burger menu. The Tech stack panel is removed. A static product preview (HTML/CSS, `role="img"` with a label) takes its place. The demo credentials block is unchanged. |

## 1. Verified current state
### 1.1 Integrations
- **`integrations.ts`:**
  - `getConnections` (:23, includes inactive rows, ordered by `createdAt`)
  - `disconnectIntegration` (:42)
  - `toggleAutoSync` (:58; nothing triggers auto sync)
  - `getMappings` (:75)
  - `saveMapping` (:85)
  - `deleteMapping` (:125)
  - `getSyncLogs` (:144)
  - `getSyncRecords` (:156; unused)
- **`qbo.ts`:** five fetch actions, each calling `ensureValidToken` (:21-176); `triggerQBOSync` (:150). **`gusto.ts`:** fetch (:18), `triggerGustoSync` (:51).
- **Gusto sends nothing:** `connectors/gusto.ts:142-147` only inserts sync records; its description (:29) claims it pushes.
- **Mappings** (`schema.ts:568-581`): unique (connection, entity_type, user). A person can hold both employee and vendor rows; sync prefers employee (`quickbooks-online.ts:133`).
- **Connections:** reconnecting always inserts (`internal/integrations.ts:27`, called from `complete/[provider]/route.ts:77`). The config page without `?connectionId` picks the oldest active (`quickbooks/page.tsx:37`).
- **Token refresh** rotates and the last write wins (`qbo-api.ts:158-176`). There's no pagination, timeout or retry.
- **Engine** (`sync-engine.ts`):
  - QBO: whole approved periods by start (:45-59);
  - Gusto refusals leave no log (:172-174);
  - status rules (:249-253);
  - `errorSummary` includes skips (:262-264);
  - an exception leaves the log failed with `errorSummary` (:280-300);
  - a function timeout can leave it `running`.
  - QBO pushes are plain creates (`qbo-api.ts:497`).
  - The record id is `${userId}-${clinOrIndirectId}-${date}`, fixed width (`quickbooks-online.ts:154`).
- **Callback params:** `connected=true` without provider (:87); errors `connection_failed`, `unknown_provider`, `connection_cancelled`, `qbo_config_missing`, `gusto_config_missing`. The route's provider value is `quickbooks_online`.
- **Periods:** `loadScheduleResolver` + `periodContaining` / neighbours; `lastCompletedPeriods` (internal).

### 1.3 Landing
- **`src/app/page.tsx`:** hidden h1 (:38), hero with "fault-tolerant" (:45), demo block (:67-91), features with the CLIN claim (:113), Tech stack (:145-156), footer.
- **Tests:**
  - `routing.test.tsx:82-100` ("Start Free Trial", demo negatives, no `href="/login"`);
  - `offline-removed.test.ts:47` (scans page.tsx only);
  - `icon-registry.test.ts:37`;
  - `page-metadata.test.ts:43`.
- **Styles:** the skip-link class is scoped in `AppShellWrapper.module.css`; the `globals.css` `main` rule.

### 1.4 Nav and metadata
`SETTINGS_NAV` Billing and Integrations; `page-metadata.test.ts:54-61` (`PageHeader` = label in those directories); pinned count (:35).

## 2. Invariants
1. **Guards first:** writes use `requireAdminFresh`; reads use `requireAdmin` (+ allowlist).
2. **Sync payloads are unchanged.** Stripe flows are unchanged.
3. **No tokens or Stripe secrets reach the browser.**
5. **The focus rule;** no `light-dark()` in `.css`.
6. **Landing copy:** no offline or auto-sync claims; no placeholder text; no claim that a feature works when it doesn't (I10).

## 3. Integrations
### 3.1 Hub
- **`getIntegrationHub()`** (`requireAdmin`, read-only allowlist), per provider:
  - the single active connection (I9), with company and connectedAt;
  - `expired`: no tokens, **or** the latest log failed with `connectionExpiredError('QuickBooks').message` (the constant, `provider-errors.ts:17`, never a literal) **and** that log started after the connection's `connected_at` (reset on reconnect, I9). So a successful reconnect clears it;
  - the latest log (when, pushed, failed, skipped, status, errorSummary);
  - `unmatchedPeople` (active users without a person mapping).
- **Banner (I1):**
  - `connected=true&provider=qbo` → success "QuickBooks Online is connected. Next, match your people, contracts and CLINs." + "Match now";
  - `connected=true` alone → "Connected.";
  - `connection_cancelled` → "Connecting was cancelled. Nothing changed.";
  - `connection_failed` → "Couldn't finish connecting. Try again; if it keeps happening, contact support.";
  - `qbo_config_missing` → "QuickBooks isn't set up for this server yet. Contact support.";
  - other → "Couldn't finish connecting.".
  - Errors use `role="alert"`; success uses `role="status"`.
- **Cards:**
  - **QuickBooks Online:** connected → company, "Connected", "Last sent {date} · {pushed} sent, {failed} failed · {n} people not matched" (or "Nothing sent yet"), "Open"; expired → "Reconnect"; not connected → "Connect QuickBooks".
  - **Gusto:** per I10.
  - **Payroll file** → Payroll export.
  - **API keys** ("{n} active keys").
  - Read-only workspaces: the existing `WriteButton`.
- **Cleanup:** remove the duplicate connections grid, capability badges and the Auto-sync badge.

### 3.2 Config template (QuickBooks; Gusto is reduced per I10)
- **Routes unchanged.** Without `?connectionId`, the page uses the single active connection (I9).
- **Header:** breadcrumb, h1, "Connected to {company} since {date}.", "Send hours now…", "Reconnect" (when expired), "Disconnect…".
- **Status line:** "QuickBooks data loaded {relative} · Refresh". While loading: `aria-busy`.
- **Load:** `loadQboMappingData` (I3). A failed list shows its message plus Retry in its tab. On the expired message, the status line offers "Reconnect".
- **People tab** ("People ({matched} of {total} matched)"):
  - Show: "Not matched first" / "Not matched only" / "All";
  - a table: person (name + email), QuickBooks match (select labelled "QuickBooks match for {name}"), Status;
  - "Suggested: …" (I5);
  - the double-mapping warning (I4);
  - optimistic change, reverted on error;
  - "Match {n} people by email" + "Only fills people who aren't matched yet.".
- **Contracts / CLINs tabs:** labelled `MappingSelect`, not-matched first, counts in the tab labels.
- **History tab:** columns When, Hours from, How, Sent, Failed, Skipped, Result (I7, §6). "See {n} failures" opens a Drawer. A new `getSyncFailures(syncLogId)` (`requireAdmin`, ≤ 500) returns failed records with server-resolved labels: parse the fixed-width id (36 + 1 + 36 + 1 + 10), join users and CLINs or indirect codes → "{person} · {code} · {date}"; unknown → the raw id.
- **Send modal (I6):**
  - the period select is built by the page loader (`loadScheduleResolver`: last completed, current, and the two before);
  - the unmatched warn line, counting people with approved hours in that period without a mapping (one server read, `getSendPreview(connectionId, periodStart)`);
  - the duplicate warning;
  - buttons Cancel / "Send hours". No people matched → "Match at least one person first.";
  - result toast using the §6 wording (warn when failed > 0 or nothing sent); refetch;
  - the late-approval line (I6).
  - errors show in an inline Alert.
- **Gusto page:** the note "Sending hours straight to Gusto isn't available yet. Download payroll files for Gusto from Payroll export.", "Open Payroll export" and Disconnect. Nothing else.

### 3.3 Server
- **`loadQboMappingData(connectionId)`:** `requireAdminFresh`; the connection is active; `ensureValidToken` **once**; `Promise.allSettled` over the 4 queries; returns `{ employees, vendors, customers, items }`, each `{ ok, data } | { ok: false, error }` (the safe message).
- **`setPersonMapping({ connectionId, userId, match })`:**
  - `requireAdminFresh`; UUIDs;
  - the connection is active and is QuickBooks (I10); the user is active;
  - in one transaction: advisory lock `hashtext('integration-mapping:'||connectionId||':'||userId)` (I4), delete the user's employee and vendor mappings, insert with `onConflictDoUpdate`.
- **`saveMapping`** (`integrations.ts:85`) now rejects entity types `employee` and `vendor` ("Use the People tab."), so nothing bypasses the I4 lock.
- **`matchPeopleByEmail({ connectionId, pairs })`:**
  - ≤ 500 pairs; the shared validator; de-duplicated users;
  - one transaction: take the per-user locks **one statement at a time, sorted by key** (not in a single `SELECT … ORDER BY`), one batched read of existing mappings, skip mapped users, one batched insert;
  - returns `{ matched, skipped }`.
- **`EntityMappingType`** adds `'vendor'`.
- **`saveIntegrationConnection`** per I9.
- **Complete route** maps the provider (I8).
- **Engine:** `SyncResult.errors[].kind`; `errorSummary` counts failed only. Update consumers and the workspace export (`allowlists.ts:398`) if it lists the field shape.
- **`getSendPreview`, `getSyncFailures`, `getIntegrationHub`:** reads on the allowlist. The new writes go on the fresh-admin-writes lists.
- **Gusto connect route:** stays, but the hub no longer links to it (I10). `triggerGustoSync` stays server-side (unused by the UI).

## 4. Landing (and the Terms and Privacy text)
- **Header** (L2): a skip link ("Skip to main content", its own focus-visible style) to `<main id="main-content" tabIndex={-1}>`. Sticky; `#features` gets `scroll-margin-top`.
- **Hero:** the "DCAA Compliant" badge (kept); h1 and subhead from `landing-copy.ts` (exact §2 strings); "Start free trial", "Try the demo" (env), "Already have a workspace? Sign in"; the product preview.
- **Demo block:** unchanged.
- **Features** (`id="features"`, h2 from §2): the six titles and blurbs from `BUSINESS-DECISIONS.md` §2, verbatim, as amended by any product-owner decision on the flagged claims recorded in `LAUNCH-TRACKER.md`.
- **Final CTA;** footer with the **§2 disclaimer** (small text, above the © line), then ©, Terms, Privacy, Sign in.
- **Terms and Privacy text** (product owner, 2026-11-11):
  - apply `BUSINESS-DECISIONS.md` §3 **(A1)** (replace Terms §7 in `src/app/terms/page.tsx`) and **(A2)** (the Privacy Policy changes in `src/app/privacy/page.tsx`) **exactly as written**;
  - change nothing else on those pages;
  - §3 **(B)** is the business side's, so don't apply it.
  - Test: the new §7 text is present, and the removed offline / IndexedDB claims are absent.
- **Remove** Tech stack.
- **Tests:**
  - `routing.test.tsx` uses case-insensitive regexes with the new labels ("Start free trial", "Try the demo"), plus a positive control with the env set;
  - its `/login` assertion becomes "the demo block contains no `/login` link" (the header and hero links are intended);
  - `offline-removed.test.ts` adds `landing-copy.ts` and the preview component to its scanned files;
  - `icon-registry` and `page-metadata` as applicable.

## 6. State tables
**Person mapping** per (connection, user): none ↔ employee ↔ vendor via choose. Legacy employee + vendor → the chosen one. Not matched → none. Match by email only from none. Every transition runs under the per-user advisory lock.

**Sync log (display):**

| Stored status | Condition | Result text |
|---|---|---|
| running | started < 15 min ago | "Sending…" |
| running | started ≥ 15 min ago | "Didn't finish" (warn) |
| success | pushed = 0, skipped = 0 | "Nothing to send: no approved hours in this period" |
| success | pushed = 0, skipped > 0 | "Nothing sent · {n} entries skipped: people not matched" |
| success | pushed > 0, skipped = 0 | "Sent" |
| success | pushed > 0, skipped > 0 | "Sent · {n} entries skipped: people not matched" |
| partial | | "Partly sent" + "See {n} failures" (if records exist) |
| failed | | "Failed: {errorSummary}" (+ "See {n} failures" if records exist) |

**Connection:**

| From | Event | To |
|---|---|---|
| none | connect | active |
| active | token refresh fails | active (UI: Reconnect) |
| active | disconnect | inactive (mappings kept) |
| inactive / active same company | reconnect | the same row active, tokens updated, mappings kept |
| active company A | connect company B | B active, A deactivated |
| A inactive, B active | reconnect A | A active (same row), B deactivated |

## 7. Failure modes
| Operation | Failure | Behaviour |
|---|---|---|
| Load | one list fails | that tab shows its error + Retry; the others work |
| Load | token expired | the expired message + Reconnect |
| Load | read-only workspace needing a refresh | the `read_only` message; edits blocked |
| Load | StrictMode double effect | the ref guard: one call |
| `setPersonMapping` | concurrent edits for one user | serialized by the advisory lock; never both mappings |
| Match by email | a user mapped meanwhile | skipped |
| Send | same period sent before | the duplicate warning (the admin decides) |
| Send | two sends at once (two admins or tabs) | the second is refused under the send lock while a `running` log under 15 minutes exists |
| Send | exception / timeout | log failed or running → History shows the reason or "Didn't finish" |
| Reconnect | | the same row; mappings kept; one active per provider |

## 8. Platform limits
- QBO lists are unpaginated (≤ 1,000 each); recorded.
- One token refresh per load.
- The failures Drawer: ≤ 500 rows.
- Sends are one pay period (bounded).

## 9. Blast radius
- **Integrations:**
  - `IntegrationsClient.tsx`, `QBOConfigClient.tsx` and `GustoConfigClient.tsx` → `IntegrationConfigView`, `MappingSelect.tsx`;
  - `integrations.ts`, `qbo.ts`, `gusto.ts`, `internal/integrations.ts`, `sync-engine.ts`, `types.ts`, `connectors/gusto.ts` (description), `complete/[provider]/route.ts`;
  - tests: `integration-mapping-ui`, `gusto-auto-match` (now the server action), `integration-mapping-actions`, `integration-sync-errors`, `integration-provider-errors`, `oauth-connect` (provider mapping, reconnect), `integrations` (integration), fresh-admin-writes, server-action-guards;
  - `allowlists.ts` if affected.
- **Landing:** `page.tsx`, `landing-copy.ts`, the preview component, `routing.test.tsx`, `offline-removed.test.ts` (scan list), `icon-registry.test.ts`, `page-metadata.test.ts`.
- **Terms and Privacy:** `src/app/terms/page.tsx`, `src/app/privacy/page.tsx` and any test asserting their old text.

## 10. Test matrix
Each row must fail without its change.

| # | Scenario | Kind |
|---|---|---|
| IN-1 | The banner for each param (`provider=qbo` from the route), rendered from **props while the mocked search params are empty**; still shown after `replaceState`; role per type | unit |
| IN-2 | The complete route redirects with `provider=qbo` for `quickbooks_online` | integration |
| IN-3 | Hub: each connector once; the last send in words; the unmatched count; no Auto-sync badge | unit |
| IN-4 | `loadQboMappingData` refreshes the token once; one failed list → per-list error; the effect runs once under StrictMode | unit |
| IN-5 | `setPersonMapping`: employee → vendor leaves only the vendor; a Gusto connection refused; inactive user or connection refused; **two parallel calls never leave both**; `saveMapping` rejects `employee` / `vendor` | integration |
| IN-6 | Legacy double mapping warning; choosing one removes the other | unit + integration |
| IN-7 | `matchPeopleByEmail`: mapped users skipped; duplicate user ids de-duplicated; a Gusto connection refused; inactive connection refused | integration |
| IN-8 | Suggestions: unique case-insensitive pairs only; a QBO email on both employee and vendor isn't suggested | unit |
| IN-9 | Send modal: period options; the unmatched and not-yet-approved counts; the duplicate warning for an exact log **and a legacy three-month log**, none for a 0-pushed log; the stale-running warning | unit |
| IN-14 | `triggerQBOSync` refuses while a `running` log under 15 minutes exists (under the lock) | integration |
| IN-15 | Hub: an expired log followed by a reconnect → no Reconnect shown | unit + integration |
| IN-10 | History per the §6 table, including "Nothing to send", "Nothing sent · entries skipped", "Didn't finish" and "Failed: {errorSummary}"; "See failures" only when records exist; labels resolved | unit + integration |
| IN-11 | Engine: an all-skipped run has no "records failed" text | unit |
| IN-12 | Reconnect same company: one active row, mappings kept; a different company deactivates the old one; A → B → A leaves only A active; a null company id inserts; legacy duplicates → the oldest updated | integration |
| IN-13 | The Gusto card has no Connect; an existing Gusto connection's page has no matching, Send or History; no Gusto UI says "sent"; the connector description is honest | unit |
| LA-1 | Header Sign in → `/login`; the demo block has no `/login`; no Tech stack; no "fault-tolerant" | unit |
| LA-2 | The landing strings equal `BUSINESS-DECISIONS.md` §2 (headline, subhead, h2, six features using the pre-approval feature 6 text, footer disclaimer); the "DCAA Compliant" badge is present; no Pricing section | unit |
| LA-4 | Terms §7 and the Privacy changes match §3 A1 / A2; no offline / IndexedDB claim remains on either page | unit |
| LA-3 | `offline-removed` scans the copy file and the preview | unit |

## 11. Verification
- **Dev:** `npx tsc --noEmit`, `npm run lint`, `npm run test`, `npm run test:tz`, `npm run db:safety`.
- **Product owner:** integration, build plus checks, `npm run demo:local`.
- **Browser:**
  1. Integrations hub with no connections; the Gusto card's honest text.
  2. With QBO sandbox credentials, if available: connect, banner, match people (including by email), send last pay period, send again (duplicate warning), History.
  3. Landing on desktop and mobile; Sign in reaches "Find your workspace"; the copy matches `BUSINESS-DECISIONS.md` §2; the footer disclaimer shows.
  4. Terms and Privacy pages show the new §7 / Privacy text.

## 12. Hand-off and commit order
- `BLUEPRINT-STANDARD.md` §3. Don't push.
- **Commits:**
  1. integrations server (load action, mapping actions, reconnect, engine, complete route, Gusto honesty);
  2. the hub;
  3. the QuickBooks config template and the Gusto page;
  4. landing + Terms/Privacy text;
  5. tests.

## 13. Pre-mortem record
**Round 1 (2026-11-10)**, two reviewers. 3 HIGH, 14 MEDIUM, all applied.
- **HIGH:**
  - Gusto sends nothing, so its UI is made honest (I10);
  - reconnect keeps matches with one active connection (I9);
  - the BillingWall can't break (positive access check, try/catch, fresh plan).
- **MEDIUM:**
  - the provider value mapping;
  - the banner from server props;
  - one token refresh per load;
  - the advisory lock + upsert for mappings;
  - the shared validator for match-by-email;
  - no custom dates, plus a duplicate-send warning;
  - History states and failure labels;
  - the workspace timezone read under the access check;
  - null status with a customer;
  - "paid through", not "renews";
  - the current-plan rule;
  - the vacuous billing test;
  - the routing test labels;
  - the offline guard scan list.
- **LOW, applied:**
  - IN-12 targets the badge;
  - error `kind`;
  - ambiguous email suggestions;
  - batched match;
  - the period source named;
  - no burger menu;
  - skip-link styles;
  - `priceLabel` via props;
  - the Pay button rule;
  - the tagline source;
  - exempt and ended trial copy.

**Round 2 (2026-11-10)**, one fresh reviewer. 0 HIGH, 6 MEDIUM, all applied:
- reconnect is atomic under a provider lock, matches non-null company ids (oldest legacy row) and deactivates others in both branches;
- Reconnect clears after reconnecting (logs compared with `connected_at`);
- honest History text for nothing-to-send and all-skipped runs (entries, not people);
- the duplicate guard is defined, covers legacy windows, and concurrent sends are refused under a lock;
- the late-approval warning (per-entry de-duplication recorded as a product-owner follow-up);
- Gusto matching dropped (nothing uses it).

**LOW, applied:**
- `saveMapping` rejects person types;
- IN-1 renders from props;
- lock-key prefixes and one-at-a-time ordering;
- the Reconnect location;
- the purchasable reason;
- the trial definition.

**Recorded for the product owner (not blocking):**
1. Should a resend send only entries not already sent (per-entry de-duplication)?
2. Should CadenzPoint build a real Gusto API integration?
