# Database backups (3b): checks

> **Status: RUN by Planning on 2026-11-16 against `f910d1a`** (results in `DATABASE-BACKUPS-AUDIT.md`). Every block was rehearsed verbatim in a fresh zsh.

**Run by Planning** against the finished branch (the product owner's decision, 2026-11-13). Results go into `DATABASE-BACKUPS-AUDIT.md` with outputs and screenshots; the product owner reviews those.

Everything here runs **locally, with no AWS and no Docker**. The parts that need AWS (deploys, the real tasks, KMS, the alert emails, the "can't" checks) are proven later with the founder, in `PRODUCTION-DEPLOY.md` Phase 13b (blueprint §12). The image build (`Dockerfile.backup`) is proven by CI's `backup-checks` job after the push.

**Setup facts**
- **The app:** the preview tool's `app-dev` config (`npm run dev`, port 3000).
- **Local Postgres** is Homebrew 16 on `localhost:5432` (user `bytime`). The local control plane `bytime_control` must be migrated to `0011` (`npm run db:migrate:cp`).
- **Throwaway workspace:** a fresh name per run, saved in `/tmp/bk-check-name`; every helper step reads it.
- **The helpers write only marked rows:** `database_backups` rows with `run_id` starting `test-bkchk-`, and backup alerts raised in the last hour. `clean` removes them.

## 0. Set up

### 0.1 The helpers
This writes `/tmp/bk-sync.mts` and `/tmp/bk-check.sh`. Copy each block from the `cat` line to its closing `EOF` and paste it once.
```bash
cat > /tmp/bk-sync.mts <<'EOF'
// Helper for DATABASE-BACKUPS-BROWSER-CHECKS.md: run the backup alert sync or print the digest lines.
const mode = process.argv[2];
const tenantId = process.argv[3];
const status = await import(process.cwd() + '/src/lib/tenant/backup-status.ts');
if (mode === 'sync') {
  const r = await status.syncBackupAlerts(new Date(), { tenantIds: [tenantId], runIdPrefix: 'test-bkchk-' });
  console.log('sync:', JSON.stringify(r));
} else {
  const d = await status.backupDigest(new Date(), process.env);
  console.log('lines:', JSON.stringify(d.lines), 'news:', d.news);
}
process.exit(0);
EOF
```
```bash
cat > /tmp/bk-check.sh <<'EOF'
#!/bin/bash
# Helper for DATABASE-BACKUPS-BROWSER-CHECKS.md. Usage: bash /tmp/bk-check.sh <step>
set -uo pipefail
[ -f package.json ] || { echo "STOP: run this from the repo folder." >&2; exit 1; }
PG=postgresql://bytime:bytime_dev@localhost:5432
CP="$PG/bytime_control"
NAME_FILE=/tmp/bk-check-name
TSX="node --env-file=.env --env-file-if-exists=.env.local --conditions=react-server --import tsx"
name() { [ -s "$NAME_FILE" ] || { echo "STOP: no workspace yet. Run: bash /tmp/bk-check.sh new" >&2; exit 1; }; cat "$NAME_FILE"; }
tid() { psql "$CP" -Atc "SELECT id FROM tenants WHERE slug='$(name)'"; }
cp_sql() { psql "$CP" -v ON_ERROR_STOP=1 -q -c "$1"; }
alerts() { psql "$CP" -c "SELECT kind, scope, dedup_key, resolved_at IS NOT NULL AS resolved FROM ops_alerts
  WHERE (kind LIKE 'backup-%' OR kind LIKE 'restore-test-%') AND first_seen_at > now() - interval '1 hour' ORDER BY kind, scope;"; }
case "${1:-}" in
  new)
    echo "bk$(date +%m%d%H%M%S)" > "$NAME_FILE"; N=$(name); echo "Workspace name: $N"
    psql "$PG/bytime" -c "CREATE DATABASE \"bytime_$N\"" || exit 1
    npm run seed:tenant -- "$N" "$PG/bytime_$N" >/dev/null && echo "Ready: $N (tenant id $(tid))" ;;
  digest)  # digest <env assignments...>: print the digest's Backups lines with those settings
    shift; env "$@" $TSX /tmp/bk-sync.mts digest 2>&1 | grep -E '^lines:' ;;
  failing) # a failed backup for the workspace, and a control-plane backup 30 hours old
    T=$(tid); cp_sql "INSERT INTO database_backups (tenant_id, target, run_id, status, error, target_deadline_ms, started_at, finished_at) VALUES
      ('$T','tenant','test-bkchk-1','failed','stage=dump exit=1 label=connection-refused', 1800000, now()-interval '1 hour', now()-interval '1 hour'),
      (NULL,'control-plane','test-bkchk-0','ok',NULL, 1800000, now()-interval '30 hours', now()-interval '30 hours');" &&
    echo "fixtures: one failed workspace backup, control-plane ok 30 h ago" ;;
  healthy) # fresh ok backups for both
    T=$(tid); cp_sql "INSERT INTO database_backups (tenant_id, target, run_id, status, target_deadline_ms, started_at, finished_at) VALUES
      ('$T','tenant','test-bkchk-2','ok', 1800000, now()-interval '10 minutes', now()-interval '9 minutes'),
      (NULL,'control-plane','test-bkchk-2','ok', 1800000, now()-interval '8 minutes', now()-interval '7 minutes');" &&
    echo "fixtures: fresh ok backups" ;;
  sync)    BACKUPS_EXPECTED=1 $TSX /tmp/bk-sync.mts sync "$(tid)" 2>&1 | grep -E '^sync:'; alerts ;;
  syncoff) BACKUPS_EXPECTED=0 $TSX /tmp/bk-sync.mts sync "$(tid)" 2>&1 | grep -E '^sync:'; alerts ;;
  lockhold) # hold the backup run lock for 90 seconds in the background (as a running backup would)
    (psql "$PG/bytime_control" -q -c "SELECT pg_advisory_lock(728402201); SELECT pg_sleep(90);" >/dev/null 2>&1 &) ; sleep 2
    psql "$CP" -Atc "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND objid=728402201 AND granted" | sed 's/^/backup lock holders: /' ;;
  clean)
    cp_sql "DELETE FROM database_backups WHERE run_id LIKE 'test-bkchk-%';"
    cp_sql "DELETE FROM ops_alerts WHERE (kind LIKE 'backup-%' OR kind LIKE 'restore-test-%') AND first_seen_at > now() - interval '3 hours';"
    N=$(name); npm run tenant:delete -- "$N" --yes --force-with-reason "local backups check" >/dev/null && rm -f "$NAME_FILE" && echo "cleaned: $N" ;;
  *) echo "Usage: bash /tmp/bk-check.sh new|digest <VAR=val...>|failing|healthy|sync|syncoff|lockhold|clean"; exit 1 ;;
esac
EOF
```
Then run `bash /tmp/bk-check.sh`. **Expect:** the usage line.

### 0.2 Migrate and create the workspace
1. Run `npm run db:migrate:cp`. **Expect** it to finish without errors.
2. Run `bash /tmp/bk-check.sh new`. **Expect:** `Ready: bk… (tenant id …)`.

## A. The Privacy page
1. Start the preview server `app-dev`, then open `http://localhost:3000/privacy`.
2. Scroll to **3. Data Retention**.
3. **Expect** the sentence, exactly: `Backups expire automatically within 30 days of being made and are then permanently deleted by our storage provider.`
4. **Expect:** the old sentence `Deleted data may remain in backups for up to 30 days.` appears nowhere on the page.

## B. The backup command, locally
1. Run `npm run backup:bundle`, then `ls -la build/backup/backup.cjs`. **Expect** a file of about 3.5 MB.
2. Run `node build/backup/backup.cjs --self-check`. **Expect:** `fatal: pg_dump could not be run (check BACKUP_PG_DUMP_BIN)` (the image's default path doesn't exist on a Mac).
3. Run the self-check with the Mac's pg 16 tools:
```bash
BACKUP_PG_DUMP_BIN=/opt/homebrew/opt/postgresql@16/bin/pg_dump BACKUP_PG_RESTORE_BIN=/opt/homebrew/opt/postgresql@16/bin/pg_restore node build/backup/backup.cjs --self-check
```
**Expect:** `self-check ok: pg_dump (PostgreSQL) 16.… ; pg_restore (PostgreSQL) 16.…`
4. Run `node build/backup/backup.cjs audit`, then `node build/backup/backup.cjs backup`. **Expect** both: `refused: outside ECS only \`--self-check\` and \`backup --dry-run\` against a local control plane may run`.
5. A Neon control plane is refused outside ECS:
```bash
CONTROL_PLANE_DATABASE_URL=postgresql://u:p@ep-cool-123456.us-east-1.aws.neon.tech/neondb npm run backup:local -- backup --dry-run
```
**Expect** the same `refused: …` line.
6. The local dry run:
```bash
BACKUP_PG_DUMP_BIN=/opt/homebrew/opt/postgresql@16/bin/pg_dump npm run backup:local -- backup --dry-run
```
**Expect:** `dry run: N target(s)`, one line per local workspace (the throwaway one included) with `server 16.…`, and a last line `control-plane`. Nothing is dumped or uploaded.

## C. The digest's Backups lines
Run each step and compare.

| Step | Expect |
|---|---|
| `bash /tmp/bk-check.sh digest BACKUPS_EXPECTED=1` | `lines: ["N of M workspaces backed up in the last 26 h. Newest control-plane backup: none.","No restore test has completed yet."] news: false` |
| `bash /tmp/bk-check.sh digest BACKUPS_EXPECTED=0` | `lines: ["Backup monitoring is off on this deployment (BACKUPS_EXPECTED=0)."] news: false` |
| `bash /tmp/bk-check.sh digest BACKUPS_EXPECTED=0 APP_ROOT_DOMAIN=cadenzpoint.com` | the same line, `news: true` (counts on the production domain) |
| `bash /tmp/bk-check.sh digest NODE_ENV=production` | `lines: ["Backup monitoring is not configured (BACKUPS_EXPECTED)."] news: true` |
| `bash /tmp/bk-check.sh digest X=1` | `lines: [] news: false` (silent in local development) |

## D. Backup alerts: raised, resolved, and cleared when monitoring is off
1. Run `bash /tmp/bk-check.sh failing`, then `bash /tmp/bk-check.sh sync`.
   - **Expect** `sync: {"synced":true,"findings":2}` and two open alerts:
     - `backup-failed`, scoped to the workspace's id;
     - `backup-missed-run`, scoped `global`.
2. Run `bash /tmp/bk-check.sh healthy`, then `bash /tmp/bk-check.sh sync`.
   - **Expect** `findings: 0`, and both alerts `resolved = t`.
3. Reset and reopen: run `bash /tmp/bk-check.sh clean`, then `bash /tmp/bk-check.sh new`, then `bash /tmp/bk-check.sh failing`, then `bash /tmp/bk-check.sh sync` (two open alerts again).
4. Run `bash /tmp/bk-check.sh syncoff`.
   - **Expect** `sync: {"synced":false,"findings":0}`, and both alerts `resolved = t` (monitoring off resolves every backup alert).

## E. Migrations don't wait when nothing is pending
1. Run `bash /tmp/bk-check.sh lockhold`. **Expect:** `backup lock holders: 1` (a stand-in for a running backup, held for 90 seconds).
2. Within those 90 seconds, run `time npm run db:migrate:all`.
   - **Expect:** every database `up-to-date`, `✓ All databases migrated successfully.`, and a total time of a few seconds, not 90.
   - **Note:** if a local workspace has a pending migration, the run waits for the lock to clear first. That's the designed behaviour (blueprint §6.4).

## F. The CloudFormation templates
1. Run `~/.local/bin/cfn-lint ops/aws/bootstrap.yml ops/aws/backup-stack.yml`, then `echo $?`. **Expect:** no output from cfn-lint, then `0`. (Install once with `pipx install cfn-lint` if missing.)

## G. Clean up
1. Run `bash /tmp/bk-check.sh clean`. **Expect:** `cleaned: bk…`.
2. Run `rm -f /tmp/bk-check.sh /tmp/bk-sync.mts`.
3. Stop the preview server.

## What to record in the audit
For each section A–F: pass or fail, the command outputs, and the Privacy screenshot. AWS, Docker and CI steps are marked "later (Phase 13b / CI)", not "passed".
