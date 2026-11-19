# Cloud export link (3d): audit

**Item:** build queue 3d. **Blueprint:** `feature-plan-cloud-export.md` FINAL v3.0, accepted 2026-11-18 (Q1–Q4, A1, A2, A4), plus the approved details D1–D17 and P1–P3 (`LAUNCH-TRACKER.md`), and the lead's CI fix (key state for the export key only).

**Audited:** `17ac1c8..8658d89` on `cloud-export` (C1–C7, the CI fix `0d205ff`, test fixes `f5e3bee` and `8658d89`), then the lead's test asks `0ffa0a8` and fix round 1 `91f904e`. Auditors at `8658d89`.

## Verdict: **READY** at `91f904e` (after fix round 1)
Round 1 (`8658d89`) was NOT READY on one MEDIUM (§4). Fix round 1 (FR1–FR13) is verified in §6. The lead's gates, integration alone, break-it (10/10), the checks file (§7) and CI on `91f904e` all pass.

**Merge gate for the product owner:** push the lead's audit commit, check that CI stays green, then merge PR #40.

**Before the first real export (production, with the founder; not merge blockers):**
- **PRODUCTION-DEPLOY 13b:** the bootstrap still carries the fail-closed placeholders `PENDING_TEAM` / `PENDING_PROJECT`. Before deploying the updated bootstrap, the founder gives the Vercel team slug and project name, and a small follow-up commit replaces the placeholders (blueprint §12.1).
- **13d:** Vercel OIDC issuer mode **Team**; set `EXPORT_DOWNLOAD_ROLE_ARN` and `EXPORT_BUCKET` on Vercel production; the setup test (a delivery of the founder's own `rehearsal` workspace to the founder's own address, download, then `export-revoke`).
- **A3:** the Privacy page sentence(s) for export copies and legal holds are still with the business session (`LAUNCH-TRACKER.md`, 3d row).

No scope items for the product owner.

## Round 1 verdict (kept for the record): NOT READY, fix round 1 required
- **Severity:** no HIGH; 1 MEDIUM code defect (the token reaching Sentry through a request header), about 10 LOW code and doc items, and test gaps (3 MEDIUM, 9 LOW).
- **Nothing in the code** writes customer data to a local disk, deletes a delivery after its record may have committed, serves a hold copy, presigns on a GET, or lets the sweep email or delete a legal hold.
- **Fix round:** none of the findings changes what the product does, so it went to the dev directly, inside the blueprint (§5).

## 1. Scope check
Every one of the 89 changed files is explained by the blueprint's §10, D1–D17, P1–P3 or the dev report §6 (auditor B, whole diff):
- **Accepted additions:**
  - `src/lib/tenant/export-status.ts` (the digest findings in their own module; §6.7 named `ops-digest.ts`);
  - the `ExportKeyArn` stack output;
  - `ChecksumAlgorithm: 'SHA256'` and `ContentType: application/zip` on the upload;
  - the `isKeyArn` check of `EXPORT_KEY_ARN` in the audit;
  - `hold` applying deliver's `changed` re-read (§6.3, "applies to hold too");
  - the task's extra refusal and failure codes (now all in TENANT-DELETION's table).
- **`package.json`:** `@aws-sdk/client-s3` moves to runtime dependencies; `@aws-sdk/s3-request-presigner` and `@vercel/oidc-aws-credentials-provider` are added (the page's presign, §6.6); `tenant:export` is removed (§6.8).
- **No customer-facing change** beyond the blueprint: the Privacy page is untouched (A3 pending), and the in-app export route and README are unchanged (T18).

## 2. Lead gates
| Gate | `8658d89` | `91f904e` |
|---|---|---|
| `npx tsc --noEmit` | ✅ | ✅ |
| Lint | ✅ 0 errors (39 pre-existing warnings) | ✅ plain `npm run lint`, 0 errors (39 warnings) |
| `npm run db:safety` | ✅ | ✅ |
| `npx vitest run` | ✅ 268 files; 3,260 passed, 1 skipped | ✅ 270 files; 3,277 passed, 1 skipped |
| `npm run test:tz` | (dev) | ✅ |
| Integration, **run alone**, CI-equivalent environment (`.env`, `REQUIRE_CONTROL_PLANE_TESTS=1`, `TZ=America/New_York`, `TEST_DATABASE_URL`, pg 16 tools), finished 05:18 Eastern on 2026-11-19 | (dev: 1,170 passed) | ✅ 120 files passed, 1 skipped (`tenant-data-isolation`, as in CI); **1,173 passed, 0 failed**; no scratch databases left |
| CI | ❌ `10b24b2` (S13's duplicate drift, fixed by `0d205ff`); ❌ `0d205ff` (two test bugs, fixed by `f5e3bee`, `8658d89`, `0ffa0a8`) | ✅ **all four jobs**, push run 44503488943 and PR #40's run 44503497886 |

## 3. Independent auditors
Two auditors worked in their own worktrees at `8658d89`, unit tests only (the shared database was the dev's):
- **A:** the export task, the sweep, the stack, IAM and KMS, the button, the audit and the bundle;
- **B:** the notice, the download page and its action, Sentry, the digest, `export-revoke`, deletion, the F2 retirement, docs, and the whole-diff scope check.

**Both confirmed:**
- **The task:** every refusal before the first write; `IfNoneMatch: '*'`; SHA-256 while streaming; after BEGIN, a delete only on `changed` or on a server error returned before COMMIT was sent; a stop, deadline or lost acknowledgement mid-record → "outcome unknown", object kept; one closing SNS line, ids only; `--extra` needs `--reason` and the button.
- **The sweep:** row-driven; a control-plane read failure stops it before the orphan steps; delivery orphans deleted only after a day; `hold/` orphans alerted, never deleted; never emailed.
- **IAM and KMS:** `ExportKey` deny-only with role-side grants; SSE-KMS with a bucket key; lifecycle `delivery/` 8 days and no `hold/` rule; the download role `GetObject` on `delivery/*` only, production-only trust; `hold/` readable by the task only.
- **The button:** inputs from the event file, masked before anything prints, every check before any AWS call, the two address boxes must match.
- **The notice:** the export branch before the generic supersede; stored recipients only; one strict batch, one message per recipient, no bcc or support copy; a stable key and a stable order; the token nulled and the payload redacted in the same transaction on send and on supersede; D14/D15 as noted.
- **The page:** apex only; a GET never presigns; one expired text for every unusable state (no oracle); IP limit, then the token, then the per-delivery limit; a 5-minute attachment presign only through the OIDC role; the A1 policy-hold rule on GET and POST; no-referrer and noindex; P2's JavaScript-only form; `PUBLIC_ACTIONS` with its guard.
- **The F2 retirement:** the local export and its checks fully gone; the in-app export unchanged.

**Mutations:** A caught 61 of 71 (one blocked by the environment, two near-equivalent); B caught 29 of 38 (three equivalent, five integration-only). Every other miss is a test gap (§4).

## 4. Findings
| # | Severity | Finding | Where |
|---|---|---|---|
| FR1 | **MEDIUM** | **The download token can reach Sentry.** On the "Prepare download" POST, Next sends `Next-Router-State-Tree`, which holds the URL-encoded router tree with the bare token (no `/export/` prefix). Sentry 10.57 attaches request headers by default, and the scrub only rewrote `/export/<token>`. An action error (`onRequestError`) or the misconfigured alert's `captureMessage` in that request would send a live 7-day token to Sentry, which the founder can read (invariant 5). Reproduced by auditor B; confirmed by the lead in Sentry's code. | `src/lib/sentry-scrub.ts:8` |
| FR2 | LOW | A failed export freeze update is logged whole: a `DrizzleQueryError` carries `params`, meaning the link and the decrypted recipients, into function logs. | `notices.ts:369,459` |
| FR3 | LOW | `exportRevoke` reports the in-flight warning and audits `sendInFlight` from a read taken before the lock. | `admin-commands.ts:314,325` |
| FR4 | LOW | `NOTICE_LEASE_MINUTES` copies `LEASE_MINUTES` by hand. | `admin-commands.ts:290` |
| FR5 | LOW | The export/hold/release S3 client has no request timeouts (the sweep's has). | `main.ts` |
| FR6 | LOW | The hard exit and `finish()` could both publish, giving two closing lines. | `export.ts:331-339` |
| FR7 | LOW | An exit-2 parse failure of `export sweep` publishes, which breaks "the sweep is never emailed". | `main.ts` |
| FR8 | LOW (P1) | The placeholder Vercel slugs could be registered, so the trust wasn't truly fail-closed. | `bootstrap.yml`, `expected-policies.ts` |
| FR9 | LOW | Masks were registered unescaped; GitHub unescapes `%25` in workflow-command data. | `export-button.sh` |
| FR10 | MEDIUM (test gaps) | The `export` command missing from the outside-ECS refusal test (G1); the `ExportKey` deny principals not pinned (G2); the export task role's S3 actions not pinned (G3). | tests |
| FR11 | LOW (test gaps) | `s3ExportStore`'s `IfNoneMatch`/`leavePartsOnError` (G4); `bundleDefines()` against the journal (G5); `lifecycleDrift`'s `other` (G6); the action's real client IP (T-1); a tautological token-hash test (T-2); a missing role ARN alone (T-3); the form's states (T-4); the `getTenantSlug` fallback (T-5). | tests |
| FR12 | LOW (docs) | TENANT-DELETION's refusal list missed codes the founder will see. | `TENANT-DELETION.md:77` |
| FR13 | LOW (docs) | The digest said "All quiet" above the day-1 hold list. | `ops-digest.ts` |

**Accepted as is:** C4 (no SNS line for an env-check failure before `runExport`; not reachable with the shipped task definition); C7 (`hold` uses deliver's `changed` re-read, per §6.3); the `ExportKeyArn` output and the small upload and audit additions (§1).

## 5. Fix round 1 (sent to the dev, inside the blueprint)
- **FR1:** filter the values of `next-router-state-tree`, `next-url` and `referer` wherever headers appear (`request.headers`, `http.request.header.*`); and, as defence in depth, replace any standalone 43-character base64url run and the URL-encoded `/export/` form in every string and key. A unit test with the real encoded router tree; each layer revert-checked.
- **FR2:** log only the error's name and code for the export branch.
- **FR3:** re-read the plan inside the lock.
- **FR4:** import the constant.
- **FR5:** the sweep's per-request timeouts.
- **FR6:** a single closing-line guard.
- **FR7:** decide the sweep from the raw argument.
- **FR8:** placeholders no Vercel slug can hold.
- **FR9:** escape `%` before masking.
- **FR10–FR11:** one test per gap, each failing under its mutation.
- **FR12–FR13:** as listed.

Then every gate, integration for the touched files 5× and under a CPU hog, the full suite, a fix-round section in the dev report, commit by name.

## 6. Verification after fix round 1 (`91f904e`)
**Code read by the lead:**
- **FR1:** both layers in `sentry-scrub.ts`. The sensitive headers become `[Filtered]` (any case, `-` or `_`, including span attributes). Every string and key also has `/export/<43>`, `%2Fexport%2F<43>` and `%22<43>%22` replaced; the last catches the router tree's quoted form, which glues `22` onto both ends. Any standalone 43-character run is replaced too. No regex lookbehind, so older browsers can parse the client bundle.
- **FR5:** `requestTimeout` 60 s and `connectionTimeout` 10 s on the export client.
- **FR6:** one shared `closing` promise; whichever path comes first publishes, and the other awaits it.
- **FR7:** `parsed.mode !== 'sweep' && argv[1] !== 'sweep'`.
- **FR8:** `PENDING_TEAM` / `PENDING_PROJECT` in the template, `expected-policies.ts` and the docs, with the reason in the comment.
- **FR9:** `${value//%/%25}` before `::add-mask::`.
- **FR2–FR4, FR10–FR13:** done as specified (dev report §8).

**The dev's evidence:** 22 of 22 revert checks caught this round (37 before it); the 7 new integration files 94/94, 5× in a row and under a 12-core hog; the full suite 1,173 passed.

**Lead gates:** §2, the `91f904e` column, all green.

**Lead break-it** (`/tmp/3d-breakit/run.py`; one exact edit each, run the test, restore): **10 of 10 caught, tree clean.**
1. FR1: the router-state header no longer filtered;
2. A1: admins' links working under a policy hold;
3. the two extra address boxes no longer having to match;
4. the `export` command allowed outside ECS;
5. FR9: masks registered unescaped;
6. a stop mid-record deleting the object (integration);
7. the sweep deleting a legal hold's orphan object (integration);
8. the token kept after the email is sent (integration);
9. support bcc'd on every export email (integration);
10. the batch no longer strict (integration).

Case 4 first ran against `backup-main.test.ts` by mistake; it's caught by G1 in `export-parse.test.ts`.

## 7. Checks run by the lead (`CLOUD-EXPORT-BROWSER-CHECKS.md`, at `91f904e`, 2026-11-19)
**Method:** every bash block (48) was extracted verbatim, and each ran in a fresh zsh. The browser steps ran in the app's preview, with curl for the server-rendered states. Throwaway workspace `excheck86037870`. The helper and a few expectations were corrected during a first rehearsal at `0ffa0a8`; those corrections are in the file.

| Section | Result | Evidence |
|---|---|---|
| 0 Setup | ✅ | migrations applied; usage line; `Ready: excheck86037870 …`; bundle built |
| A Outside AWS | ✅ | `refused: outside ECS only \`--self-check\` and \`backup --dry-run\` against a local control plane may run` |
| B.1–B.10 Input refusals | ✅ | each refusal exactly as written; `aws calls: 0` every time |
| B.11 A running task | ✅ | `refused: an export task is already running …`; 1 call (`ecs list-tasks … --family cadenzpoint-backup-export`) |
| B.12 No `ExportModes` | ✅ | `refused: the Backup system deploy that adds the export task is pending approval …`; 2 calls, no `run-task` |
| B.13 Modes listed | ✅ | it passes the mode check; `refused: the backup stack has no TaskSubnets/TaskSecurityGroup outputs …`; no `run-task` |
| B.14 Masking first | ✅ | the four `::add-mask::` lines first, in order |
| C Deliveries | ✅ | `export delivered: … 3 recipient(s)` (×2) and `4 recipient(s)` with an extra address, all `extra_only: false`; the new delivery's row: token kept, notice pending, no payload yet |
| D.1 Headers | ✅ | `200`; `Referrer-Policy: no-referrer`; `X-Robots-Tag: noindex`. `Cache-Control` reads `no-cache, must-revalidate` because Next's dev server replaces it on every page (`base-server.js`); production gives `private, no-cache, no-store, …` for this `force-dynamic` page, plus the config's `no-store`. Noted in the file. |
| D.2 Workspace host | ✅ | `307`, `location: http://localhost:3000/export/<token>` |
| D.3 Valid link | ✅ | `Workspace export for Acme Export Test · 12 KB · works until November 26, 2026 at 6:00 AM EST`; **Prepare download**; `referrer` no-referrer and `robots` noindex, nofollow meta tags |
| D.4 No JavaScript | ✅ | `Turn on JavaScript to download` in the server render |
| D.5 GET isn't a download | ✅ | `downloads: 0` |
| D.6 Prepare without AWS | ✅ | the red alert "Downloads aren't available right now. Contact support@cadenzpoint.com."; the alert row `export-download-misconfigured`, detail `{"reason": "misconfigured", "deliveryId": …}` (ids only); still `downloads: 0` |
| D.7 Unknown and malformed | ✅ | the expired text for both |
| D.8 Expired | ✅ | the expired text, confirmed again after the hold was lifted |
| D.9 Policy hold | ✅ | `policy: status suspended, suspension policy …`; an extra-only delivery (`1 recipient(s)`, `extra_only: true`); `main` and `withextra` show the expired text, `extraonly` shows the details; after `unsuspend`, `main` and `withextra` show the details again |
| E Revoke | ✅ | `export-revoke takes a delivery id (uuid).`; `No export delivery has that id.`; the dry run (`Dry run — pass --yes to apply.`, nothing changed); `✓ Revoked …`; row `revoked: true, token kept: false, notice superseded: true`; the page shows the expired text; `That delivery is already revoked.` |
| F Hold and digest | ✅ | `export held: …`; `Exports in the last 7 days: 4 delivered, 0 downloads, 3 not yet emailed. Open legal holds: 1 (oldest 0 days)`; `export released: hold <same id>` |
| G Retired export | ✅ | `Missing script: "tenant:export"`; `No such file`; the in-app route still there |
| H Templates | ✅ | `cfn-lint: clean` |
| I Clean up | ✅ | `cleaned: excheck86037870`; 0 tenants, 0 orphan deliveries, 0 `bkt_` databases, 0 misconfigured alerts left |

**Not covered locally** (covered by the fakes-based integration tests, CI and the founder's 13d setup test):
- a real upload to the exports bucket;
- the presigned download through the Vercel OIDC role;
- the export email through Resend;
- the hourly sweep against the real bucket;
- the button against real ECS;
- the Docker runtime stage (CI ✅ on `91f904e`).
