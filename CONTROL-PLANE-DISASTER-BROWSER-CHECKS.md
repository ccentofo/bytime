# Control-plane disaster (3c-2): checks

> **Status: to be run by Planning** against the finished branch. Results go into `CONTROL-PLANE-DISASTER-AUDIT.md`, and the product owner reviews those (2026-11-13 decision). Every block is rehearsed verbatim in a fresh zsh.

Everything here runs **locally, with no AWS, Neon, Stripe or GitHub**. A control-plane rebuild, the reconcile against real Neon projects, the rehearsal, a real `--project-proven-gone` close and `stripe-resync` against Stripe are proven later:
- by the founder's rehearsal press (PRODUCTION-DEPLOY 13c);
- by the integration tests, which use fakes.

**Setup facts**
- **No app server:** the slug checks call the same function as the signup page's availability check (`checkSlugAvailableInternal`).
- **Local Postgres** is Homebrew 16 on `localhost:5432` (user `bytime`). The local control plane must be migrated (step 0.1).
- **Throwaway workspace:** a fresh name per run, saved in `/tmp/cp-check-name`.
- **The helpers write only marked rows:**
  - `ops_alerts` with dedup key `test-cpchk-proj`;
  - a `signups` row for the address `cpchkwindow` with email `cpchk@example.invalid`;
  - the throwaway workspace's `disaster_actions` rows.

  `clean` removes them all.
- **Run nothing else against the local control plane while these run.**

## 0. Set up
### 0.1 Migrate the local control plane
```bash
npm run db:migrate:cp
```
**Expect:** `migrations applied successfully!` (the `NOTICE … already exists, skipping` blocks before it are normal).

### 0.2 The helpers
These blocks write `/tmp/cp-sync.mts` and `/tmp/cp-check.sh`. Copy each block, from the `cat` line to its closing `EOF`, and paste it once.
```bash
cat > /tmp/cp-sync.mts <<'EOF'
// Helper for CONTROL-PLANE-DISASTER-BROWSER-CHECKS.md: the daily window-project check (no Neon key) or the slug check.
const mode = process.argv[2];
if (mode === 'sync') {
  const s = await import(process.cwd() + '/src/lib/tenant/disaster-status.ts');
  console.log('window check:', JSON.stringify(await s.syncWindowProjects(new Date(), { neon: null, env: { BACKUPS_EXPECTED: '1' } })));
} else {
  const s = await import(process.cwd() + '/src/server/internal/signup.ts');
  for (const slug of process.argv.slice(3)) console.log(`slug ${slug}:`, JSON.stringify(await s.checkSlugAvailableInternal(slug)));
}
process.exit(0);
EOF
```
```bash
cat > /tmp/cp-check.sh <<'EOF'
#!/bin/bash
# Helper for CONTROL-PLANE-DISASTER-BROWSER-CHECKS.md. Usage: bash /tmp/cp-check.sh <step>
set -uo pipefail
[ -f package.json ] || { echo "STOP: run this from the repo folder." >&2; exit 1; }
PG=postgresql://bytime:bytime_dev@localhost:5432
CP="$PG/bytime_control"
NAME_FILE=/tmp/cp-check-name
TSX="node --env-file=.env --env-file-if-exists=.env.local --conditions=react-server --import tsx"
name() { [ -s "$NAME_FILE" ] || { echo "STOP: no workspace yet. Run: bash /tmp/cp-check.sh new" >&2; exit 1; }; cat "$NAME_FILE"; }
tid() { psql "$CP" -Atc "SELECT id FROM tenants WHERE slug='$(name)'"; }
cp_sql() { psql "$CP" -v ON_ERROR_STOP=1 -q -c "$1"; }
rows() { psql "$CP" -c "SELECT run_id, kind, status FROM disaster_actions WHERE tenant_id='$(tid)' ORDER BY at, id;"; }
WSLUG=cpchkwindow
case "${1:-}" in
  new)
    echo "cp$(date +%m%d%H%M%S)" > "$NAME_FILE"; N=$(name); echo "Workspace name: $N"
    psql "$PG/bytime" -q -c "CREATE DATABASE \"bytime_$N\"" || exit 1
    npm run seed:tenant -- "$N" "$PG/bytime_$N" >/dev/null && echo "Ready: $N (tenant id $(tid))" ;;
  id)   psql "$CP" -Atc "SELECT 'tenant id: ' || id || ', status: ' || status FROM tenants WHERE slug='$(name)'" ;;
  button) # button <mode> <targets> <confirm> <modes|none>: the button script as GitHub runs it, with a stand-in aws
    mkdir -p /tmp/cp-stub; rm -f /tmp/cp-aws.log
    if [ "${5:?modes or none}" = none ]; then rm -f /tmp/cp-modes; else echo "$5" > /tmp/cp-modes; fi
    printf '#!/bin/bash\necho "$*" >> /tmp/cp-aws.log\ncase "$*" in\n *list-tasks*) echo 0 ;;\n *DisasterModes*) if [ -f /tmp/cp-modes ]; then cat /tmp/cp-modes; else echo None; fi ;;\n *) echo None ;;\nesac\n' > /tmp/cp-stub/aws
    chmod +x /tmp/cp-stub/aws
    jq -n --arg m "$2" --arg t "$3" --arg c "$4" '{inputs:{mode:$m,targets:$t,override:"none",confirm:$c}}' > /tmp/cp-event.json
    GITHUB_RUN_ID=1 GITHUB_RUN_ATTEMPT=1 GITHUB_EVENT_PATH=/tmp/cp-event.json PATH="/tmp/cp-stub:$PATH" \
      bash scripts/backup/disaster-button.sh | grep -v '^::add-mask::'
    echo "aws calls: $(cat /tmp/cp-aws.log 2>/dev/null | wc -l | tr -d ' ')"; sed 's/ --query.*//' /tmp/cp-aws.log 2>/dev/null ;;
  slugs) shift; $TSX /tmp/cp-sync.mts slugs "$@" 2>&1 | grep -E '^slug ' ;;
  window) # an open window-project alert for the address cpchkwindow, and a restored signup row for it
    cp_sql "INSERT INTO ops_alerts (scope, kind, dedup_key, detail, first_seen_at, last_seen_at) VALUES ('global', 'window-project', 'test-cpchk-proj',
      jsonb_build_object('projectId','test-cpchk-proj','name','cadenzpoint-$WSLUG','createdAt', now()::text,'slug','$WSLUG','type','signup'), now(), now());"
    cp_sql "INSERT INTO signups (email, company_name, slug, verify_token_hash, expires_at, created_at)
      VALUES ('cpchk@example.invalid', 'CP Check Co', '$WSLUG', repeat('0',64), now() + interval '1 day', now() - interval '1 hour');"
    echo "window alert and signup row for $WSLUG created" ;;
  adopt) # the throwaway workspace now references the window project (as if it became a workspace)
    cp_sql "UPDATE tenants SET neon_project_id='test-cpchk-proj' WHERE slug='$(name)';" && echo "workspace $(name) references test-cpchk-proj" ;;
  unadopt) cp_sql "UPDATE tenants SET neon_project_id=NULL WHERE slug='$(name)';" && echo "workspace $(name) references no project again" ;;
  sync) $TSX /tmp/cp-sync.mts sync 2>&1 | grep -E '^window check:'
    psql "$CP" -Atc "SELECT 'window alert resolved: ' || (resolved_at IS NOT NULL) FROM ops_alerts WHERE dedup_key='test-cpchk-proj' ORDER BY first_seen_at DESC LIMIT 1" ;;
  lose)  psql "$PG/bytime" -q -c "DROP DATABASE \"bytime_$(name)\" WITH (FORCE)" && echo "lost: database bytime_$(name) dropped" ;;
  back)  psql "$PG/bytime" -q -c "CREATE DATABASE \"bytime_$(name)\"" && echo "back: empty database bytime_$(name) created" ;;
  proof) cp_sql "INSERT INTO disaster_actions (run_id, tenant_id, kind, status, at) VALUES ('test-cpchk-proof', '$(tid)', 'proof', '${2:?status}', clock_timestamp());" && echo "proof row: $2" ;;
  migrate) shift; npm run --silent db:migrate:all -- --tenant "$(name)" "$@" 2>&1 | grep -E '[|]  |^✓|^✗|^Skipping|^Checking'
    echo "exit code: ${PIPESTATUS[0]}"; rows ;;
  clean)
    cp_sql "DELETE FROM ops_alerts WHERE dedup_key='test-cpchk-proj';"
    cp_sql "DELETE FROM signups WHERE slug='$WSLUG' AND email='cpchk@example.invalid';"
    cp_sql "DELETE FROM disaster_actions WHERE tenant_id='$(tid)';"
    cp_sql "UPDATE tenants SET neon_project_id=NULL WHERE slug='$(name)' AND neon_project_id='test-cpchk-proj';"
    N=$(name); npm run tenant:delete -- "$N" --yes --force-with-reason "local control-plane check" >/dev/null && rm -f "$NAME_FILE" && echo "cleaned: $N" ;;
  *) echo "Usage: bash /tmp/cp-check.sh new|id|button <mode> <targets> <confirm> <modes|none>|slugs <slug...>|window|adopt|unadopt|sync|lose|back|proof <status>|migrate [flags]|clean"; exit 1 ;;
esac
EOF
```
Then run:
```bash
bash /tmp/cp-check.sh
```
**Expect:** the usage line.

### 0.3 A throwaway workspace and the backup command
```bash
bash /tmp/cp-check.sh new
```
**Expect:** `Ready: cp<digits> (tenant id <uuid>)`.
```bash
npm run backup:bundle
```

## A. The new modes refuse to run outside AWS
```bash
node build/backup/backup.cjs disaster control-plane --targets control-plane
```
**Expect:** `refused: outside ECS only \`--self-check\` and \`backup --dry-run\` against a local control plane may run`.

## B. The button
These run the button's script as GitHub does, with a stand-in `aws` that logs its calls. The stand-in reports no running task.

### B.1 Mode `control-plane` with a workspace id as the target
```bash
bash /tmp/cp-check.sh button control-plane 11111111-1111-1111-1111-111111111111 control-plane none
```
**Expect:** `refused: mode control-plane takes targets control-plane`, then `aws calls: 0`.

### B.2 A wrong confirmation
```bash
bash /tmp/cp-check.sh button control-plane control-plane workspace none
```
**Expect:** `refused: confirm must be exactly: control-plane`, then `aws calls: 0`.

### B.3 A press before the Backup system deploy is approved (the stack has no `DisasterModes`)
```bash
bash /tmp/cp-check.sh button control-plane control-plane control-plane none
```
**Expect:**
- `refused: the Backup system deploy that adds this mode is pending approval: approve it in GitHub, then press again`;
- `aws calls: 2` (`ecs list-tasks`, then one `describe-stacks`);
- no `run-task`.

### B.4 The same press once the stack lists the mode
```bash
bash /tmp/cp-check.sh button control-plane control-plane control-plane "workspace rehearse control-plane reconcile rehearse-control-plane"
```
**Expect:** the mode check passes. The next refusal is `refused: the backup stack has no TaskSubnets/TaskSecurityGroup outputs (approve the pending Backup system deploy)`. The stand-in has no network outputs, so no task is started.

## C. Reserved names and window addresses at signup
### C.1 System project names can't be workspace addresses
```bash
bash /tmp/cp-check.sh slugs control-prod restore-tests recoverable-canary r-deadbeef-x control-r20261118000000-1 rehearse-cp-20261118000000-1 control-room harbor
```
**Expect:**
- the first six → `{"available":false,"reason":"invalid"}`;
- `control-room` and `harbor` → `{"available":true}`.

### C.2 The window-signup lookup refuses without a window alert
```bash
npm run --silent tenant:admin -- window-signup cpchkwindow 2>&1 | tail -1
```
**Expect:** `✗ "cpchkwindow" is not a window signup (no open window-project alert names it).`

### C.3 A window project holds its address
```bash
bash /tmp/cp-check.sh window
```
```bash
bash /tmp/cp-check.sh slugs cpchkwindow
```
**Expect:** `window alert and signup row for cpchkwindow created`, then `slug cpchkwindow: {"available":false,"reason":"taken"}`.

### C.4 The window-signup lookup shows the restored signup
```bash
npm run --silent tenant:admin -- window-signup cpchkwindow 2>&1 | tail -2
```
**Expect:**
- `Window project test-cpchk-proj for "cpchkwindow", created …`;
- the line `"CP Check Co"  cpchk@example.invalid  created …  not verified`.

### C.5 The address is released once a workspace references the project
```bash
bash /tmp/cp-check.sh adopt
```
```bash
bash /tmp/cp-check.sh sync
```
```bash
bash /tmp/cp-check.sh slugs cpchkwindow
```
**Expect:**
- `window check: {"checked":1,"resolved":1}`;
- `window alert resolved: true`;
- `slug cpchkwindow: {"available":true}`.
```bash
bash /tmp/cp-check.sh unadopt
```

## D. `--project-proven-gone` refuses a workspace without its own Neon project
```bash
npm run --silent tenant:delete -- "$(cat /tmp/cp-check-name)" --project-proven-gone --yes 2>&1 | tail -1
```
```bash
bash /tmp/cp-check.sh id
```
**Expect:** `✗ --project-proven-gone is only for a workspace with its own Neon project; nothing was changed.`, then `status: active`.

## E. `stripe-resync` refuses without a Stripe key
```bash
npm run --silent tenant:admin -- stripe-resync --since 2026-11-18T00:00:00Z --stripe-mode test 2>&1 | tail -1
```
**Expect:** `✗ STRIPE_SECRET_KEY is missing or not a recognizable Stripe key (sk_live_, sk_test_, rk_live_, rk_test_).` That's the local case. The real resync is covered by T27's fakes.

## F. Deploys skip the new proof types
### F.1 `window-deleted`
```bash
bash /tmp/cp-check.sh lose
```
```bash
bash /tmp/cp-check.sh proof window-deleted
```
```bash
bash /tmp/cp-check.sh migrate --skip-lost
```
**Expect:**
- the row labelled by the workspace's uuid, reading `skipped: skipped (proven lost, awaiting rebuild)`;
- `exit code: 0`;
- a `skip | skipped` row.

### F.2 `chain-unconfirmed`
```bash
bash /tmp/cp-check.sh proof chain-unconfirmed
```
```bash
bash /tmp/cp-check.sh migrate --skip-lost
```
**Expect:** the same skip, `exit code: 0`, and a second `skip | skipped` row.

### F.3 Without the flag, the deploy still stops
```bash
bash /tmp/cp-check.sh migrate
```
**Expect:** `FAILED: database "bytime_cp…" does not exist` and `exit code: 1`.

## G. The templates
```bash
cfn-lint ops/aws/*.yml && echo "cfn-lint: clean"
```
**Expect:** `cfn-lint: clean`.

## H. Clean up
```bash
bash /tmp/cp-check.sh back
```
```bash
bash /tmp/cp-check.sh clean
```
**Expect:** `cleaned: cp<digits>`.

## What to record in the audit
For each section: pass or fail, plus the output lines quoted above. Then confirm that no `bytime_cp*` database, `test-cpchk-proj` alert or `cpchk@example.invalid` signup row is left.
