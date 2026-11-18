# url-fix: dev report (Neon connection-string parameters)

- **Branch:** `claude/nifty-booth-7729d1` (worktree `nifty-booth-7729d1`), cut from `main` at `57d6729`.
- **Commits:** `a20a63f` (the fix and its tests), then this report. Nothing pushed.
- **Approved:** the impact analysis ([URL-FIX-IMPACT-ANALYSIS.md](URL-FIX-IMPACT-ANALYSIS.md)) was approved by Planning on 2026-11-18, with A9 included, K1/K2 wrapped and empty or unparseable URLs passed through.

## 1. What changed

- **New `src/lib/db/pg-url.ts` `postgresJsUrl(url)`.** It reduces the URL query to the `sslmode` allow-list (the backup image's `clientUrl` rule). It has no imports.
  - A URL that has only allow-listed keys, or no query at all, comes back as the same string.
  - An empty or unparseable URL also comes back unchanged, so the callers' existing error paths stay as they are (documented in the helper, with unit cases).
  - Otherwise the other keys are deleted and the URL is re-serialised. The credentials, host, port and database keep their encoding.
- **Wrapped as `postgres(postgresJsUrl(<same expression>), <same options>)`:** 23 call sites.
  - **App (9):**
    - `src/db/index.ts:33` (A1, `clientFor`; its pool map stays keyed by the stored string);
    - `src/db/control-plane/index.ts:12` (A2);
    - `src/db/control-plane/locked.ts:22` (A3);
    - `src/lib/tenant/migrate-tenant.ts:24,55` (A4, A5, outside `toDirectConnectionUrl`);
    - `src/lib/tenant/neon.ts:166,252,267` (A6–A8);
    - `src/lib/export/workspace-export.ts:52` (A9, outside `directUrl`).
  - **Scripts (14):**
    - `migrate-all.ts` (2), `migrate.ts`;
    - `seed-users.ts`, `seed-full.ts`, `seed-demo.ts`, `seed-tenant.ts`;
    - `backfill-neon-retention.ts`, `backfill-trial-dates.ts`, `backfill-neon-project-ids.ts`;
    - `check-approval-scope-window.ts` (2), `provision-customer-db.ts`, `register-tenant.ts`.
- **drizzle-kit:** `drizzle.config.ts` and `drizzle.control-plane.config.ts` now pass `url: postgresJsUrl(<same expression>)`.
  - drizzle-kit 0.31.10 picks `pg` first, but `pg` isn't installed, so it uses postgres.js (`bin.cjs:78945–78951`).
  - `npx drizzle-kit check` still loads both configs.
- **Not changed:**
  - stored data and write paths (`neon.ts` still stores Neon's URI as returned);
  - `scripts/backup/**`;
  - `Dockerfile.backup`: none of the touched files is in its COPY list, so the backup bundle is unchanged;
  - CI workflows;
  - `feature-plan-control-plane-disaster.md`.

## 2. Tests

| Test | Proves | Revert check |
|---|---|---|
| `src/__tests__/unit/pg-url.test.ts` (8) | See the list below | Helper made an identity function: **6 of 8 fail**. The two that still pass are the clean-URL and pass-through cases, which an identity function satisfies by design |
| `src/__tests__/unit/pg-url-callsites.test.ts` (3) | Every value import of `postgres` in `src/` and `scripts/` (outside `scripts/backup/` and `src/__tests__/`) calls it only as `<binding>(postgresJsUrl(`; both drizzle configs wrap `url`; at least 23 call sites found; scanner self-test (aliases, unsupported import forms, comments) | `check-approval-scope-window.ts:67` unwrapped: **fails**, naming `scripts/check-approval-scope-window.ts:68` (the line after the import). `drizzle.control-plane.config.ts` url unwrapped: **fails** |
| `src/__tests__/integration/pg-url-connect.test.ts` (8) | With `TEST_DATABASE_URL`/`CONTROL_PLANE_DATABASE_URL` + `?channel_binding=require&keepalives=1`, each succeeds: `getDbForUrl`, `migrateTenantDatabase`, `getPendingMigrationCount`, `databaseExists`, `openExportSnapshot`, `controlDb`, `withLockedPool`. One control case proves the raw URL is rejected with 42704 | A1, A2, A3, A4, A5, A7 and A9 unwrapped together: **all 7 cases fail**, each with `unrecognized configuration parameter "channel_binding"`. The control case still passes, as intended |

What the helper unit tests cover:
- strips `channel_binding`, `keepalives*`, `sslrootcert`, `options` and unknown keys, and keeps `sslmode`;
- Neon's exact string;
- repeated keys;
- encoded credentials (`%40 %2F %3A %25 %23 %3F %20`), checked through postgres.js's own option parsing;
- clean URLs come back as the same string;
- empty, unparseable and multi-host URLs pass through unchanged.

A6 (`createLocalDevDatabase`) and A8 (`dropDatabaseVerified`) create or drop databases. They're covered by the static test, not by an integration case (as agreed in the analysis).

## 3. Gates (on `a20a63f`)

| Command | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npm run lint` | exit 0: 0 errors, 39 warnings, all in files this change doesn't touch; `eslint` on the changed files is clean |
| `npm run test` | 260 files; 3086 passed, 1 skipped |
| `npm run test:tz` | UTC, Los Angeles and Auckland each 260 files, 3086 passed, 1 skipped; exit 0 |
| `npm run db:safety` | ✓ no backward-incompatible statements |
| `npm run build` | exit 0. The only warning is Next's workspace-root inference, which comes from the worktree's lockfiles and isn't from this change |
| Integration run 1, alone (the briefed env: main checkout's `.env`, `REQUIRE_CONTROL_PLANE_TESTS=1`, `TZ=America/New_York`), 08:22–08:25 ET | exit 0. 101 files passed, 7 skipped; **904 passed, 0 failed**, 88 skipped. The skips are env-gated: five backup/disaster suites need `BACKUP_PG_DUMP_BIN`/`BACKUP_PG_RESTORE_BIN`; `migrate-tenant.test.ts` needs `TEST_DATABASE_URL` set; `tenant-data-isolation` needs `TEST_DATABASE_URL_2` |
| Integration run 2, alone (run 1's env plus CI's `TEST_DATABASE_URL`=local `bytime_test`, `BACKUP_PG_DUMP_BIN`/`BACKUP_PG_RESTORE_BIN`=Homebrew pg 16, `REQUIRE_PG16_TOOLS=1`), 08:25–08:29 ET | exit 0. 107 files passed, 1 skipped; **989 passed, 0 failed**, 3 skipped (`tenant-data-isolation`: `TEST_DATABASE_URL_2`, which CI doesn't set either) |
| drizzle-kit manual check, on the scratch database `urlfix_scratch` | **With the fix**, `DATABASE_URL=…/urlfix_scratch?channel_binding=require npx drizzle-kit migrate`: exit 0, 20 of 20 migrations applied. **K1 reverted**, same URL: exit 1 (drizzle-kit swallows the error and prints nothing). **Control on the same database:** reverted config with a clean URL gives exit 0, and with `channel_binding` gives exit 1. With the fix restored, `channel_binding` gives exit 0. The scratch database was created and dropped three times, all on local Postgres; `pg_database` count after the last drop is 0 |

§3.7: no workflow `run:` block or Dockerfile changed, so there's nothing to replay.

## 4. Adversarial self-review

- **Coverage.** The static test is the guard against a new unwrapped client.
  - It refuses `import * as` / `require` / dynamic `import('postgres')` forms, so it can't be bypassed silently.
  - It does not cover clients built through `scripts/backup/lib/locks.ts` `defaultConnect`. Those go through `lockUrl` → `clientUrl`, which is already correct and outside this item.
- **Behaviour change.** For every URL without extra keys, postgres.js receives the identical string.
  - With extra keys, the only difference is that those keys are no longer sent as startup settings. Today any such key makes the connection fail, so nothing that works now changes.
  - One exception: a key that postgres.js reads as one of its own options (for example `connect_timeout`, `target_session_attrs`, `sslrootcert=system`) is now dropped too. No stored or configured URL in the repo uses one, and Neon's strings carry only `sslmode` and `channel_binding`. This is the same rule as the backup image.
- **Pooling.** `clientFor` keys its pool map by the stored string, unchanged. Two stored URLs that differ only in dropped keys would get two pools to the same database: harmless, and not a case that occurs.
- **Error paths.** The empty-URL guards (`clientFor`, control-plane `!url`) still run before the helper. Unparseable URLs reach postgres.js unchanged, so postgres.js throws exactly as before.
- **Not covered by a run:**
  - the seed, backfill and register scripts against a Neon-shaped URL (they need real data or remote databases). The static test proves they're wrapped.
  - production Neon itself. Only local pg 16 was used, per the rules.

## 5. Process notes

- **An early slip during the revert checks (restored before the commit).** I restored `scripts/check-approval-scope-window.ts` with `git checkout`, before anything was committed. That briefly discarded its real edits. I re-applied the identical wrap, re-ran the static test and tsc, and then committed.
  - Every later revert check was restored from the commit, and the tree was clean after each (`git status`).
- **Integration slot:** granted by Planning; held from 08:21 to about 08:32 ET; released with the scratch database dropped. The two after-19:00 date-boundary tests Planning flagged didn't arise, because the runs were in the morning.
- **Only local databases were touched:** `bytime_test`, `bytime_control` (`select 1` only, plus the suites' own scratch databases), and `urlfix_scratch`. Never acme, globex or initech, and nothing remote. No secrets were printed: only key names and host/database were read from `.env`.
- **One aborted revert attempt.** It changed nothing (a zsh word-splitting slip in the file list) and is not counted. The real check ran next.
