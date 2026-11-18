# url-fix: impact analysis (Neon connection-string parameters)

Branch `claude/nifty-booth-7729d1` (worktree `nifty-booth-7729d1`), cut from `main` at `57d6729`. No code written yet.
Tracker row: `url-fix` (decided 2026-11-18 by the product owner: its own branch from `main`).

## 1. External behaviour, confirmed from source

- **postgres.js 3.4.9** (`node_modules/postgres/src/index.js`):
  - `parseOptions` (line 437) turns every URL query pair into `query`. Line 443 renames `sslmode` to `ssl`.
  - Lines 446–461 list postgres.js's own option keys. Those keys (`ssl`, `sslnegotiation`, `connect_timeout`, `idle_timeout`, `max`, `prepare`, `target_session_attrs`, …) are read as client options.
  - Line 488: **every other key goes into `connection`**, which is sent to the server in the startup packet. So `channel_binding=require` (Neon), `keepalives*` (libpq) and `sslrootcert` become server settings, and Postgres rejects them (`42704`, reproduced by Planning on pg 16).
  - `parseUrl` (line 537) decodes the username and password with `decodeURIComponent`, after a WHATWG `new URL()`.
- **drizzle-kit 0.31.10** (`node_modules/drizzle-kit/bin.cjs`):
  - For `dialect: 'postgresql'` it picks the first installed driver: `pg` (line 78876), then `postgres` (78945), then `@vercel/postgres`, then `@neondatabase/serverless`.
  - `pg`, `@vercel/postgres` and `@neondatabase/serverless` are **not installed** (`node_modules/pg` etc. absent; package.json has only `postgres`). So drizzle-kit uses postgres.js.
  - It calls `postgres.default(credentials.url, { max: 1 })` (line 78951) with the URL untouched.
  - **Answer: both drizzle configs are affected** and need the same fix (§3).
- **The backup image's rule** (`scripts/backup/lib/pg-url.ts:14` `clientUrl`): it keeps only `sslmode` in the query. The app helper copies that rule. `scripts/backup/**` stays untouched.

## 2. Every postgres.js client outside `scripts/backup/` and tests

Found with `grep -rnE "postgres\(|from ['\"]postgres['\"]"` over `src/`, `scripts/`, `ops/` and the root `*.ts`/`*.mjs` files. Also checked:
- other drivers (none);
- `drizzle(<string>)` (none: every `drizzle(` call gets a client);
- aliased default imports of `postgres` (none).

### App (`src/`)
| # | Site | What it serves |
|---|---|---|
| A1 | `src/db/index.ts:32` `clientFor` | Every tenant client: `getDb`, `readSql`, `getDbForUrl`, `getDbForAuth`, `getDbForWrite`. Also scripts `tenant-admin`, `report-cost-basis-change`, and `provision.ts` seeding |
| A2 | `src/db/control-plane/index.ts:11` `getControlDb` | The request-path control-plane pool (`controlDb`) |
| A3 | `src/db/control-plane/locked.ts:21` `getLockedDb` | The locked lifecycle pool (`withLockedPool`, `withTenantLock`): webhooks, crons, `delete-tenant`, `tenant-export`, `tenant-admin` |
| A4 | `src/lib/tenant/migrate-tenant.ts:23` `migrateTenantDatabase` | Signup provisioning, `migrate-all` (tenants and control plane) |
| A5 | `src/lib/tenant/migrate-tenant.ts:54` `getPendingMigrationCount` | `migrate-all` |
| A6 | `src/lib/tenant/neon.ts:165` `createLocalDevDatabase` | Local or dev provisioning (loopback only) |
| A7 | `src/lib/tenant/neon.ts:251` `databaseExists` | `delete-tenant`, `migrate-all` confirmed-absent |
| A8 | `src/lib/tenant/neon.ts:266` `dropDatabaseVerified` | `delete-tenant` |
| A9 | **`src/lib/export/workspace-export.ts:51` `openExportSnapshot`** | **Not in the brief.** The workspace export (`tenant-export` script and the app's export path). Same defect |

### Scripts (`scripts/`, not `scripts/backup/`)
| # | Site |
|---|---|
| S1 | `scripts/migrate-all.ts:117` (tenant list), `:129` (disaster records client) |
| S2 | `scripts/migrate.ts:16` |
| S3 | `scripts/seed-users.ts:22` |
| S4 | `scripts/seed-full.ts:648` |
| S5 | `scripts/seed-demo.ts:66` |
| S6 | `scripts/seed-tenant.ts:70` |
| S7 | `scripts/backfill-neon-retention.ts:41` |
| S8 | `scripts/backfill-trial-dates.ts:47` |
| S9 | `scripts/backfill-neon-project-ids.ts:38` |
| S10 | `scripts/check-approval-scope-window.ts:50` (control plane), `:67` (each tenant) |
| S11 | `scripts/provision-customer-db.ts:23` |
| S12 | `scripts/register-tenant.ts:18` |

### drizzle-kit
| # | Site |
|---|---|
| K1 | `drizzle.config.ts:8` `dbCredentials.url` |
| K2 | `drizzle.control-plane.config.ts:8` `dbCredentials.url` |

### Covered indirectly (no edit needed)
- `scripts/delete-tenant.ts` → `src/lib/tenant/delete-tenant.ts`, which uses A3 and A7/A8.
- `tenant-admin`, `tenant-export`, `report-cost-basis-change` use A1/A3/A9.
- `provision-tenant` → `provision.ts`, which uses A1/A2/A3/A4/A6.
- `scripts/lib/migrate-all-run.ts` takes its locks and probes through `scripts/backup/lib/locks.ts` `lockUrl`, which already applies `clientUrl`.
- `scripts/lib/disaster-records.ts` is a type import only.
- Shell scripts (`setup-local-demo.sh`) use `psql` (libpq), which understands `channel_binding`.

### Backup image bundle: unaffected
`Dockerfile.backup` copies only:
- `encryption.ts`
- `direct-url.ts`
- `backup-locks.ts`
- `db-name.ts`
- `lifecycle-config.ts`

None of these files changes or gains an import. So the image's COPY list and bundle stay the same.

## 3. The change

1. **New `src/lib/db/pg-url.ts`** `postgresJsUrl(url: string): string`. It has no imports, so the drizzle-kit configs can load it through a relative path without `@/` or `server-only`. It works like this:
   - **Empty string, or anything `new URL()` can't parse:** returned unchanged. postgres.js then behaves exactly as today. Callers' own empty-URL guards (`clientFor`, control-plane `!url`) stay first and unchanged.
   - **Every query key already in the allow-list (`sslmode`), or no query:** the **input string is returned byte-for-byte**. Local, CI and test URLs, and the backup-shaped `?sslmode=require` URLs, are untouched. Credentials can't be re-encoded.
   - **Otherwise:** keys outside the allow-list are deleted and the URL is re-serialised (the same operation as `clientUrl`).
     - The userinfo, host, port and path are serialised by WHATWG `URL` exactly as postgres.js's own `parseUrl` already parses them.
     - An encoded password stays encoded, so postgres.js's `decodeURIComponent` yields the same password.
     - The unit tests prove this for `%40`, `%2F`, `%3A`, `%25`, `%23` and `%3F`.
2. **Wrap each site** in §2 (A1–A9, S1–S12) as `postgres(postgresJsUrl(<existing expression>), <options unchanged>)`:
   - A4, A5 and A9 wrap outside the existing `toDirectConnectionUrl`/`directUrl` call.
   - A1 keeps its pool map keyed by the original stored string (no behaviour change to pooling).
3. **K1/K2:** `url: postgresJsUrl(<existing expression>)`. The control-plane config's `?? ''` stays `''` (unchanged path).
4. **No change to stored data or write paths** (`neon.ts:96` keeps storing Neon's URI as returned). `scripts/backup/**` isn't touched.

Expected diff: the helper, about 25 one-line call-site edits, the 3 tests and the dev report. No product behaviour change.

## 4. Tests (each must fail without the fix; revert-checked before the report)

1. **Unit:** `src/__tests__/unit/pg-url.test.ts`.
   - Strips `channel_binding`, `keepalives`, `keepalives_idle`, `sslrootcert`, `options` and an unknown key; keeps `sslmode`.
   - Neon's exact shape `postgresql://u:p@ep-x-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require` gives `…/neondb?sslmode=require`.
   - Credentials, host, port and database survive exactly. Encoded passwords (`%40 %2F %3A %25 %23 %3F`) survive as-is, and **feeding the result to postgres.js's own option parsing** (`postgres(url).options`, no connection opened) gives the decoded password, user, host, port, database, `ssl` = `require`, and a `connection` object holding only `application_name`.
   - Already-clean URLs come back identical (`===`). An empty string and an unparseable string come back unchanged.
   - Revert check: make the helper an identity function, and these tests fail.
2. **Integration:** `src/__tests__/integration/pg-url-connect.test.ts`, on local Postgres.
   - Test URLs: `TEST_DATABASE_URL` / `CONTROL_PLANE_DATABASE_URL` + `?channel_binding=require&keepalives=1` (no `sslmode`: local pg has no TLS).
   - Each of these must succeed:
     - (a) `getDbForUrl(url)` runs `select 1` (A1);
     - (b) the control-plane `controlDb` (A2): env pointed at the parameterised URL, fresh module import, `select 1`, client ended, env restored;
     - (c) `withLockedPool` (A3), the same way;
     - (d) `migrateTenantDatabase(url)` on the test database. Its migrations are already applied, so this is a no-op under the advisory lock (A4);
     - (e) `getPendingMigrationCount(url)` returns 0 (A5);
     - (f) `databaseExists(url, <test db name>)` is true (A7);
     - (g) `openExportSnapshot(url)` opens and closes with rollback (A9).
   - (b) and (c) need `REQUIRE_CONTROL_PLANE_TESTS=1` and skip loudly otherwise, like the existing suites.
   - Revert check: unwrap A1, A2, A4 and A9 one at a time; each makes its case fail with `42704`.
   - A6 and A8 create or drop databases, so they get no integration case: the static test covers them. I can add a scratch-database case for A8 if you want it.
3. **Static:** `src/__tests__/unit/pg-url-callsites.test.ts`.
   - Walks `src/` and `scripts/`, skipping `scripts/backup/` and `src/__tests__/`.
   - For each file with a value import of `postgres`, it finds the local binding name and asserts that every call `<name>(` is written `<name>(postgresJsUrl(`.
   - It also asserts `drizzle.config.ts` and `drizzle.control-plane.config.ts` pass `url: postgresJsUrl(`.
   - It asserts it found the expected minimum number of call sites (≥ 25), so a broken scanner can't pass vacuously.
   - Revert check: unwrap one script site (S10) and one config (K2); the test fails, naming the file and line.
4. **drizzle-kit, one manual check** (not a committed test, because drizzle-kit is a CLI):
   - create a scratch local database `urlfix_scratch`;
   - run `DATABASE_URL='…/urlfix_scratch?channel_binding=require' npx drizzle-kit migrate`;
   - expect success with the fix and `42704` without it;
   - drop the scratch database.
   - It uses the shared local Postgres, so it runs inside the slot you give me for the integration run.

## 5. Gates and process

- **After the build:** `npx tsc --noEmit`, `npm run lint`, `npm run test`, `npm run test:tz`, `npm run db:safety`, `npm run build`.
- **Then I message you before the full integration run**, and run it alone with:
  - the main checkout's `.env` sourced, not printed;
  - `REQUIRE_CONTROL_PLANE_TESTS=1`;
  - `TZ=America/New_York`.
- **No CI workflow or Dockerfile changes**, so §3.7 has no `run:` block or image build to replay.
- **Databases:** never acme, globex or initech, and no remote database.

## 6. Questions for Planning

1. **A9** (`workspace-export.ts`) wasn't in the brief. I plan to include it: same defect, same one-line fix. OK?
2. **K1/K2:** wrapping the drizzle-kit config URLs as above. OK?
3. **Invalid or empty URLs pass through unchanged** rather than throwing as `clientUrl` does. This keeps today's error behaviour at every call site. OK?
