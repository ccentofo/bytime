# UX-4c Part 2a (Setup checklist, Import): lead audit

**Audited:** branch `ux-setup-import`, commits `65cf179`…`0f5e502` (6) against `feature-plan-ux-setup-import.md` **v3 FINAL**. **Date:** 2026-11-11.

**Method:**
- Lead gates.
- **Lead break-its on local Postgres** (`breakit-check-ux4c2a.mjs`, 11 checks).
- Two independent auditors: server (commits 1, 3, 4) and UI / scope (commits 2, 5, 6). They ran 22 mutations; the tree was verified clean.

**Verdict: NOT READY TO MERGE. No HIGH or MEDIUM. Fix round 1 below, plus scope items for the product owner (§3).**
- **Every per-row query runs in its row's savepoint,** in all 7 setup types.
- **Dry runs and real imports run identical code;** dry runs send no emails, no Sentry events and no passwords.
- **The create actions are unchanged** except for the two intended checks.
- **P6 is placed and scoped correctly.**
- **`SetupStatus` stays lean** (8 parallel queries, no names).
- **The redirects and the stale-link scan are correct.**
- **The pipeline reducer matches the §5 state table.**

## 1. Results
| Check | Result |
|---|---|
| `tsc` / lint / unit (lead) | clean / 0 errors, 48 warnings / 217 files, 2357 pass |
| Integration (dev, local Postgres) | 688 passed, 0 failed |
| Break-its (lead, local Postgres) | **11/11 caught** |
| Auditor mutations | 15 of 22 caught. The survivors are L1–L5 and L10 below. |

**Dev gap decisions accepted:**
- the m / w definition;
- Home's workweek item (see §3, S3);
- blank Role / FLSA = error;
- the rate example;
- the skipped-rows sentence (see §3, S4);
- `?type=` on the server (with F2 below);
- Hours numbering;
- Timesheet status headers (with F3 below);
- the new messages;
- the converted-scope skip reason;
- the `RowStatus` test removal;
- one `setup-validators.ts` module;
- the five existing imports staying off the fresh-admin list.

## 2. Fix round 1 (inside the approved blueprint; sent to the dev)
### Server
- **L1, role check bypass:** `parseRole` (`import.ts:114-121`) reads a plain object, so `constructor` / `__proto__` pass the Role check. Use `Object.hasOwn(ROLES, key)` (or a `switch`). Test: a `constructor` role gives the Role message.
- **L2, test:** IM-5 adds rows with a blank Role and a blank FLSA, each expecting its message.
- **L3, test:** IM-7 adds an **inactive** labor category on the CLIN, expecting "isn't on CLIN" (`import.ts:450`).
- **L4, test:** IM-8 adds an **inactive** access row, expecting it to be re-activated (created, `isActive` true) (`import.ts:507`).
- **L5, test:** IM-3 mocks Sentry and runs a forced-error row with `dryRun: true`, expecting nothing captured (`import.ts:94`).
- **L6, test:** the setup counts test gives a CLIN only an **inactive** code, expecting `clinsWithoutCode` to count it (`setup.ts:78`).
- **L7, comment:** correct the `charge-codes.ts:32` comment. The validator is shared with `updateChargeCode` only for the code and name checks.

### UI
- **F1, stale pay-week pre-fill:** key the pay-schedule form on the saved workweek (`SetupChecklistClient.tsx:208`), so "Pay weeks start on" pre-fills from a workweek just saved in step 1.
- **F2, `replaceState`:** call `window.history.replaceState(null, '', url)` (`ImportClient.tsx:45`), per the Next.js docs. Passing `window.history.state` (with `__NA`) skips the router's URL sync.
- **F3, optional header:** Timesheet status's "Submitted At" header becomes optional (`import-types.ts:109`); the server already treats it as optional.
- **F4, error routing:** route only the anchor message to the date field (`SetupChecklistClient.tsx:226`; share it as a constant). Other server errors go to the form's Alert. Reword the anchor message to "The first period must start on a {day}." (server and client).
- **F6, tests:**
  - assert the access badge element itself ("{w} of {m}"), not the detail line;
  - assert the FLSA and pay-week labels differ;
  - assert the null window-status copy.

**Recorded, no change:** `updateChargeCode` doesn't run the new Location check. A bad Location on update still gets a database error, as before this blueprint. Follow-up candidate.

## 3. For the product owner (scope: changes not described in the blueprint or mockup)
| # | Change | Lead's recommendation |
|---|---|---|
| S3 | Home's separate "Payroll workweek isn't set" card is **removed entirely**. The setup checklist now covers the workweek, and a complete setup requires it. The only lost text is "Payroll export stays off until you set it." | Accept |
| S4 | The check summary adds "{n} rows will be skipped because they already exist." when rows are skipped | Accept |
| S9 | Setup visuals differ slightly from the mockup: a "Recommended" badge on unfinished recommended steps; the "Required" badge in amber; the complete notice in blue (no green notice style exists) | Accept |
| S10 / F5 | The time zone shows as "America/New_York", not "Eastern Time" (matches the Workspace page) | Accept as is, or ask for friendly names (small change) |
| F7 | The "Confirm your pay schedule first" notice on Hours still shows after hours are imported, when the pay schedule can no longer change immediately | Change its wording when hours already exist: "Hours are already imported, so the pay schedule can only change on a future date." |

## 4. Product owner runs (after fix round 1)
1. Integration, then `node breakit-check-ux4c2a.mjs` (the lead can run both).
2. `npm run build && node scripts/check-build-trace.mjs && node scripts/check-css-output.mjs`.
3. `npm run demo:local`.
4. **Browser:**
   - a **new throwaway workspace** from 0 of 6 to 6 of 6, using the inline settings and the template imports;
   - on acme, the settings steps show links;
   - a file with a bad row: the check lists it, "Download rows with problems", import the rest;
   - Hours shows the window status;
   - after "Create codes from CLINs…" on the checklist, keyboard focus lands sensibly.

## 5. Fix round 1 verification (`454feef`, `eae66ba`), 2026-11-11
**Lead gates:** `tsc` clean; lint 0 errors, 48 warnings; 217 files, 2362 pass. **Lead break-its re-run: 11/11.**

**Dev report:** integration 688 passed, 0 failed; 15/15 revert checks.

**Scope:** nothing outside §2, except `period-lock-integrity.test.ts`, which was updated to the new anchor wording.

**Note for the product owner:** the F4 wording ("The first period must start on a {day}.") also shows on the existing Settings → Pay schedule page (same server message).

**Gap decisions accepted:** the new `src/lib/pay-schedule-messages.ts` (client-safe), and the unreachable "week start day" fallback.

**Status:** waiting on the product owner's §3 decisions, then their build plus browser checks (§4).

## 6. S10 / F7 follow-up (`cc89b64`), 2026-11-11
- **Lead gates:** clean; 2366 pass. **Break-its: 11/11.** 6/6 revert checks (dev).
- **Lead error:** the S10 hand-off assumed friendly labels existed in `timezone-options.ts`; they didn't. The dev stopped and asked the product owner, who chose Intl's generic names ("Eastern Time"; some zones read oddly, e.g. UTC → "GMT+00:00"). The label is computed on the server, and the Workspace page is unchanged.
- **F7:** both branches tested. The link label "Open Pay schedule" is the dev's wording.

**Status: ready for the product owner's build plus browser checks (§4).** Test files are in `test-data/import-walkthrough/`.

## 7. Final (2026-11-11)
- **Alignment fix** `9b2d0a1` verified: the inline form inputs line up, confirmed by the product owner in the browser.
- **Product owner:** the time zone dropdown keeps raw IANA names.
- **The product owner's build plus browser checks passed:** fresh workspace imports with bad rows, settings steps, checklist to 6 of 6.

**Verdict: READY TO MERGE** (once CI is green on the PR).
