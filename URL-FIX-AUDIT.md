# url-fix (Neon connection-string parameters): audit

**Item:** url-fix (`LAUNCH-TRACKER.md`; product owner 2026-11-18: its own branch). **Defect:** Neon's console and create-project strings end with `?sslmode=require&channel_binding=require`. postgres.js forwards unknown URL keys to the server as startup settings, and Postgres rejects them (`42704 unrecognized configuration parameter "channel_binding"`, reproduced by the lead on local pg 16). The app and its scripts passed stored URLs straight through; only the backup image reduced them.

**Audited:** `a20a63f` (fix and tests) and `6a2a3d0` (dev report), on branch `claude/nifty-booth-7729d1` from `main` at `57d6729`.

## Verdict: **READY** at `6a2a3d0`
**Merge gate for the product owner:** CI must pass on the push.

## What changed (read by the lead)
- **`src/lib/db/pg-url.ts` `postgresJsUrl`:** keeps only `sslmode` (the backup image's `clientUrl` rule). A URL with nothing to strip comes back byte-for-byte; an empty or unparseable URL comes back unchanged.
- **Every postgres.js call site in `src/` and `scripts/`** outside `scripts/backup/` now goes through it: 9 app sites (including the workspace export, `workspace-export.ts:51`) and 14 script sites. **Both drizzle-kit configs** are wrapped too: drizzle-kit 0.31.10 falls back to postgres.js because `pg` isn't installed.
- **Unchanged:** `scripts/backup/**`, `Dockerfile.backup`, the CI workflows. No stored data or write paths change.

## Lead checks
| Check | Result |
|---|---|
| Independent search for unwrapped `postgres(` calls (src, scripts, drizzle configs; not tests or backup) | ✅ none; the only other hit is the Neon HTTP API (`disaster-status.ts`), not a database connection |
| `npx tsc --noEmit` | ✅ |
| `eslint . --ignore-pattern '.claude/**'` | ✅ 0 errors (39 pre-existing warnings) |
| `npx vitest run` | ✅ 260 files; 3,086 passed, 1 skipped |
| Integration, **run alone**, CI-equivalent environment (`.env`, `REQUIRE_CONTROL_PLANE_TESTS=1`, `TZ=America/New_York`, `TEST_DATABASE_URL`, pg 16 tools), 09:07 Eastern | ✅ 107 files passed, 1 skipped (`tenant-data-isolation`: needs `TEST_DATABASE_URL_2`, as in CI); **989 passed, 0 failed**; no scratch databases left |
| **Lead break-it** (one edit each, test, restore) | ✅ 3/3 caught: the allow-list widened to `channel_binding` (6 unit failures); the Neon admin client unwrapped (the static test); the workspace export unwrapped (the static test). Tree clean after |

**The dev's own evidence** (`URL-FIX-DEV-REPORT.md`):
- the new connection test passed 8/8; with seven sites unwrapped, all 7 cases fail with the exact `channel_binding` error;
- drizzle-kit migrated a scratch database (20/20) with a Neon-style URL, and failed with the wrap reverted. The scratch database was dropped.

**Accepted note:** the allow-list also drops keys postgres.js would read as its own options (`connect_timeout`, `target_session_attrs`). It's the same rule as the backup image, and no URL in the repo or from Neon uses them.

**Process slip** (the dev disclosed it): one revert-check restore briefly discarded real edits before the first commit. They were re-applied identically and verified, and the committed tree passed every check above.
