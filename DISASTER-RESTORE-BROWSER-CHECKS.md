# Disaster restore button (3c): checks

> **Status: RUN by Planning on 2026-11-17 against `11667dd`:** every block rehearsed verbatim in a fresh zsh, all as expected (results in `DISASTER-RESTORE-AUDIT.md` §7). It's re-run after the fix round. Results go into `DISASTER-RESTORE-AUDIT.md`, with outputs. The product owner reviews those (the 2026-11-13 decision).

Everything here runs **locally, with no AWS, no Neon, no GitHub and no Docker**. The parts that need them come later with the founder: the button's first press, the rehearsal, the emails and the console steps (`PRODUCTION-DEPLOY.md` Phase 13c). CI's `backup-checks` job proves the image build after the push.

**Setup facts**
- **No app server is needed:** 3c adds no screens. Every check is a command.
- **Local Postgres** is Homebrew 16 on `localhost:5432` (user `bytime`). The local control plane `bytime_control` must be migrated to `0012` (step 0.1).
- **Throwaway workspace:** a fresh name per run, saved in `/tmp/dr-check-name`. Every helper step reads it.
- **The helpers write only marked rows:**
  - `disaster_actions` rows for the throwaway workspace;
  - alerts with dedup key `test-drchk-orphan` or the workspace's id;
  - the `rebuild-watch-check-failed` alert the sync raises without a Neon key.

  `clean` removes them all.
- **Run nothing else against the local control plane while these run.** An integration test's daily-check sync resolves open alerts there, and that spoils section E.

## 0. Set up

### 0.1 Migrate the local control plane
```bash
npm run db:migrate:cp
```
**Expect:** `migrations applied successfully!` (the `NOTICE … already exists, skipping` blocks before it are normal).

### 0.2 The helpers
These blocks write `/tmp/dr-sync.mts` and `/tmp/dr-check.sh`. Copy each block, from the `cat` line to its closing `EOF`, and paste it once.
```bash
cat > /tmp/dr-sync.mts <<'EOF'
// Helper for DISASTER-RESTORE-BROWSER-CHECKS.md: run the disaster alert sync (no Neon key) or print the digest line.
const mode = process.argv[2];
const s = await import(process.cwd() + '/src/lib/tenant/disaster-status.ts');
if (mode === 'sync') {
  const r = await s.syncDisasterAlerts(new Date(), { neon: null, env: { BACKUPS_EXPECTED: '1' } });
  console.log('sync:', JSON.stringify(r));
} else {
  console.log('digest:', JSON.stringify(await s.disasterDigestLines(new Date())));
}
process.exit(0);
EOF
```
```bash
cat > /tmp/dr-check.sh <<'EOF'
#!/bin/bash
# Helper for DISASTER-RESTORE-BROWSER-CHECKS.md. Usage: bash /tmp/dr-check.sh <step>
set -uo pipefail
[ -f package.json ] || { echo "STOP: run this from the repo folder." >&2; exit 1; }
PG=postgresql://bytime:bytime_dev@localhost:5432
CP="$PG/bytime_control"
NAME_FILE=/tmp/dr-check-name
TSX="node --env-file=.env --env-file-if-exists=.env.local --conditions=react-server --import tsx"
name() { [ -s "$NAME_FILE" ] || { echo "STOP: no workspace yet. Run: bash /tmp/dr-check.sh new" >&2; exit 1; }; cat "$NAME_FILE"; }
tid() { psql "$CP" -Atc "SELECT id FROM tenants WHERE slug='$(name)'"; }
cp_sql() { psql "$CP" -v ON_ERROR_STOP=1 -q -c "$1"; }
rows() { psql "$CP" -c "SELECT run_id, kind, status FROM disaster_actions WHERE tenant_id='$(tid)' ORDER BY at, id;"; }
alerts() { psql "$CP" -c "SELECT id, kind, dedup_key, resolved_at IS NOT NULL AS resolved FROM ops_alerts
  WHERE (kind LIKE 'rebuild-%' OR kind LIKE 'disaster-%' OR kind = 'workspace-needs-deploy')
  AND first_seen_at > now() - interval '1 hour' ORDER BY kind;"; }
case "${1:-}" in
  new)
    echo "dr$(date +%m%d%H%M%S)" > "$NAME_FILE"; N=$(name); echo "Workspace name: $N"
    psql "$PG/bytime" -q -c "CREATE DATABASE \"bytime_$N\"" || exit 1
    npm run seed:tenant -- "$N" "$PG/bytime_$N" >/dev/null && echo "Ready: $N (tenant id $(tid))" ;;
  id)    psql "$CP" -Atc "SELECT 'tenant id: ' || id || ', status: ' || status FROM tenants WHERE slug='$(name)'" ;;
  lose)  # the workspace's database disappears (as if its Neon project were deleted)
    psql "$PG/bytime" -q -c "DROP DATABASE \"bytime_$(name)\" WITH (FORCE)" && echo "lost: database bytime_$(name) dropped" ;;
  back)  # an (empty) database appears again at the workspace's address, so tenant:delete can reach its locked step
    psql "$PG/bytime" -q -c "CREATE DATABASE \"bytime_$(name)\"" && echo "back: empty database bytime_$(name) created" ;;
  proof) # proof <status>: a press recorded this about the original (e.g. gone)
    cp_sql "INSERT INTO disaster_actions (run_id, tenant_id, kind, status, at)
      VALUES ('test-drchk-proof', '$(tid)', 'proof', '${2:?status}', clock_timestamp());" && echo "proof row: ${2}"; rows ;;
  migrate) # migrate [--skip-lost] [--check]: the deploy's migrate step, for this workspace only
    shift; npm run --silent db:migrate:all -- --tenant "$(name)" "$@" 2>&1 | grep -E '[|]  |^✓|^✗|^Skipping|^Checking'
    echo "exit code: ${PIPESTATUS[0]}"; rows ;;
  rebuilt) # a rebuild switched the workspace 2 hours ago (no deploy since)
    cp_sql "INSERT INTO disaster_actions (run_id, tenant_id, kind, status, at)
      VALUES ('test-drchk-rebuild', '$(tid)', 'rebuild', 'linked', now() - interval '2 hours');" && echo "rebuild row: linked 2 h ago" ;;
  migrated) # a later deploy migrated it
    cp_sql "INSERT INTO disaster_actions (run_id, tenant_id, kind, status, at)
      VALUES ('test-drchk-migrated', '$(tid)', 'skip', 'migrated', clock_timestamp());" && echo "skip row: migrated now" ;;
  button) # button <id|text> <confirm>: run the button script as GitHub does, with a stand-in aws that logs its calls
    T="${2:?targets}"; [ "$T" = id ] && T=$(tid)
    mkdir -p /tmp/dr-stub; rm -f /tmp/dr-aws.log
    printf '#!/bin/bash\necho "$*" >> /tmp/dr-aws.log\ncase "$*" in *list-tasks*) echo 1 ;; esac\n' > /tmp/dr-stub/aws
    chmod +x /tmp/dr-stub/aws
    jq -n --arg t "$T" --arg c "${3:?confirm}" '{inputs:{mode:"workspace",targets:$t,override:"none",confirm:$c}}' > /tmp/dr-event.json
    GITHUB_RUN_ID=1 GITHUB_RUN_ATTEMPT=1 GITHUB_EVENT_PATH=/tmp/dr-event.json PATH="/tmp/dr-stub:$PATH" \
      bash scripts/backup/disaster-button.sh | grep -v '^::add-mask::' > /tmp/dr-button.out
    cat /tmp/dr-button.out
    echo "target shown in the visible log: $(grep -c -- "$T" /tmp/dr-button.out) time(s)"
    echo "aws calls: $(cat /tmp/dr-aws.log 2>/dev/null | wc -l | tr -d ' ')"; cat /tmp/dr-aws.log 2>/dev/null ;;
  sync)   $TSX /tmp/dr-sync.mts sync 2>&1 | grep -E '^sync:'; alerts ;;
  digest) $TSX /tmp/dr-sync.mts digest 2>&1 | grep -E '^digest:' ;;
  orphan) # an open "orphan project" alert naming this workspace (as the daily check raises)
    cp_sql "INSERT INTO ops_alerts (scope, kind, dedup_key, detail, first_seen_at, last_seen_at)
      VALUES ('global', 'rebuild-orphan-project', 'test-drchk-orphan',
      jsonb_build_object('tenantId', '$(tid)', 'todo', 'delete it in the Neon console'), now(), now());" && alerts ;;
  orphanid) psql "$CP" -Atc "SELECT id FROM ops_alerts WHERE dedup_key='test-drchk-orphan' AND resolved_at IS NULL" ;;
  clean)
    cp_sql "DELETE FROM ops_alerts WHERE dedup_key IN ('test-drchk-orphan', '$(tid)') OR (kind IN
      ('rebuild-watch-check-failed','workspace-needs-deploy') AND first_seen_at > now() - interval '3 hours');"
    cp_sql "DELETE FROM disaster_actions WHERE tenant_id='$(tid)';"
    N=$(name); npm run tenant:delete -- "$N" --yes --force-with-reason "local disaster check" >/dev/null && rm -f "$NAME_FILE" && echo "cleaned: $N" ;;
  *) echo "Usage: bash /tmp/dr-check.sh new|id|lose|back|proof <status>|migrate [flags]|rebuilt|migrated|button <id|text> <confirm>|sync|digest|orphan|orphanid|clean"; exit 1 ;;
esac
EOF
```
Then run:
```bash
bash /tmp/dr-check.sh
```
**Expect:** the usage line.

### 0.3 A throwaway workspace
```bash
bash /tmp/dr-check.sh new
```
**Expect:** `Ready: dr<digits> (tenant id <uuid>)`.

## A. The restore command refuses to run outside AWS
```bash
npm run backup:bundle
```
```bash
node build/backup/backup.cjs disaster workspace --targets 11111111-1111-1111-1111-111111111111
```
**Expect:** `refused: outside ECS only \`--self-check\` and \`backup --dry-run\` against a local control plane may run`.

## B. The button checks its inputs, and never shows a workspace in the public log
These steps run the button's script as GitHub does. A stand-in `aws` logs every call instead of reaching AWS.

### B.1 A wrong confirmation
```bash
bash /tmp/dr-check.sh button id rehearse
```
**Expect:**
- `refused: confirm must be exactly: workspace`;
- `target shown in the visible log: 0 time(s)`;
- `aws calls: 0`.

### B.2 A workspace name instead of its id
```bash
bash /tmp/dr-check.sh button "$(cat /tmp/dr-check-name)" workspace
```
**Expect:**
- `refused: targets must be workspace ids (uuid, lowercase), comma-separated, up to 50, or all-lost`;
- `target shown in the visible log: 0 time(s)`;
- `aws calls: 0`.

### B.3 A valid press while a disaster task is already running
The stand-in reports one running task.
```bash
bash /tmp/dr-check.sh button id workspace
```
**Expect:**
- `refused: a disaster task is already running (RESTORE.md runbook A.11)`;
- `target shown in the visible log: 0 time(s)`;
- `aws calls: 1`, which is `ecs list-tasks … --family cadenzpoint-backup-disaster --desired-status RUNNING …`.

## C. The disaster deploy path (`--skip-lost`)
Each step runs the deploy's migrate command for the throwaway workspace only, then lists its disaster rows.

### C.1 A healthy workspace
```bash
bash /tmp/dr-check.sh migrate
```
**Expect:** the workspace `up-to-date`, `exit code: 0`, `(0 rows)`.

### C.2 The workspace's database is lost
```bash
bash /tmp/dr-check.sh lose
```
```bash
bash /tmp/dr-check.sh migrate
```
**Expect:** `FAILED: database "bytime_dr…" does not exist`, `exit code: 1` (a normal deploy stops, as today).

### C.3 `--skip-lost` without proof still fails
```bash
bash /tmp/dr-check.sh migrate --skip-lost
```
**Expect:** `Skipping workspaces the disaster button proved lost (--skip-lost).`, then the same `FAILED` row, `exit code: 1`, `(0 rows)`.

### C.4 A press proved it gone; the verify step stays read-only
```bash
bash /tmp/dr-check.sh proof gone
```
```bash
bash /tmp/dr-check.sh migrate --check --skip-lost
```
**Expect:**
- the row is labelled by the workspace's **id** (a uuid), not its name;
- the row reads `skipped: skipped (proven lost, awaiting rebuild)`;
- `exit code: 0`;
- still exactly one row (`test-drchk-proof | proof | gone`). `--check` writes nothing.

### C.5 The deploy's migrate step skips it and records the skip
```bash
bash /tmp/dr-check.sh migrate --skip-lost
```
**Expect:**
- the same uuid-labelled `skipped` row;
- `✓ All databases migrated successfully.` and `exit code: 0`;
- a second row `migrate-<time> | skip | skipped`.

### C.6 Without the flag, the deploy still stops
```bash
bash /tmp/dr-check.sh migrate
```
**Expect:** the `FAILED` row with the workspace's name, and `exit code: 1`.

## D. The daily disaster checks and the digest line
### D.1 A rebuilt workspace that no deploy has migrated yet
```bash
bash /tmp/dr-check.sh rebuilt
```
```bash
bash /tmp/dr-check.sh sync
```
**Expect:**
- `sync: {"synced":true,"findings":2}`;
- an open `workspace-needs-deploy` alert whose dedup key is the workspace id;
- an open `rebuild-watch-check-failed` alert. That's expected locally: there's no Neon key. In production it means `NEON_API_KEY`/`CONTROL_PLANE_PROJECT_ID` are missing.

### D.2 A deploy migrated it
```bash
bash /tmp/dr-check.sh migrated
```
```bash
bash /tmp/dr-check.sh sync
```
**Expect:** `findings":1`, and the `workspace-needs-deploy` row now shows `resolved` = `t`.

### D.3 The digest line
```bash
bash /tmp/dr-check.sh digest
```
**Expect:** `digest: ["Disaster runs in the last 7 days: none."]`.

## E. Guards on the founder's other commands
### E.1 `show` prints the workspace id (the button takes ids)
```bash
npm run --silent tenant:admin -- show "$(cat /tmp/dr-check-name)" | grep -E "id:|status:"
```
**Expect:** `id:` followed by the same uuid as in 0.3.

### E.2 A disaster alert can't be resolved by hand
```bash
bash /tmp/dr-check.sh orphan
```
```bash
npm run --silent tenant:admin -- resolve-alert "$(bash /tmp/dr-check.sh orphanid)" --note "check" --yes 2>&1 | tail -1
```
**Expect:** `✗ rebuild-orphan-project closes only when its condition clears (feature-plan-disaster-restore.md §6.8); it can't be resolved by hand.`

### E.3 `tenant:delete` refuses while a copy of the workspace may still exist in Neon
The workspace's database comes back (empty), so the delete can reach its locked step.
```bash
bash /tmp/dr-check.sh back
```
```bash
npm run --silent tenant:delete -- "$(cat /tmp/dr-check-name)" --yes --force-with-reason "local disaster check" 2>&1 | tail -1
```
**Expect:** `✗ A copy of this workspace's data may still exist in Neon (rebuild-orphan-project test-drchk-orphan): delete it in the Neon console first; the alert resolves on the next daily check.` The workspace is not deleted:
```bash
bash /tmp/dr-check.sh id
```
**Expect:** `tenant id: <the same uuid>, status: active`.

## F. The CloudFormation templates
```bash
cfn-lint ops/aws/*.yml && echo "cfn-lint: clean"
```
**Expect:** `cfn-lint: clean` and nothing else (cfn-lint 1.60.1).

## G. Clean up
```bash
bash /tmp/dr-check.sh clean
```
**Expect:** `cleaned: dr<digits>`.

## What to record in the audit
For each section: pass or fail, plus the output lines quoted above. Then confirm that no `bytime_dr*` database, `disaster_actions` row or `test-drchk-orphan` alert is left.
