# Cloud export (3d): checks

> **Status: RUN by Planning on 2026-11-19 at `91f904e` (after a first rehearsal at `0ffa0a8`, whose helper fixes are folded in).** All as expected. Results go into `CLOUD-EXPORT-AUDIT.md`, and the product owner reviews those (2026-11-13 decision). Every bash block is rehearsed verbatim in a fresh zsh.

Everything here runs **locally, with no AWS, Vercel, Resend or GitHub**. A real delivery to S3, the 5-minute download through the Vercel OIDC role, the export email and the hourly sweep against the real bucket are proven later:
- by the founder's setup test (PRODUCTION-DEPLOY 13d: a delivery of the founder's own `rehearsal` workspace to the founder's own address);
- by the integration tests, which use fakes.

**Setup facts**
- **Local Postgres** is Homebrew 16 on `localhost:5432` (user `bytime`). The local control plane (`bytime_control`) must be migrated (step 0.1).
- **The deliveries are real task runs.** `deliver` runs the export task's own code (`runExport`) against the local control plane, with a stand-in bucket that keeps the ZIP in memory and is thrown away. The workspace is a throwaway one with made-up `example.invalid` users. No customer data is involved.
- **No email is sent:** nothing here runs the notice cron, and the alert email needs `OPS_ALERT_EMAIL`, which isn't set locally. The policy hold is applied through the admin plan itself, **never `tenant:admin suspend --yes`**: that command delivers the tenant's pending notices at once, which here would include the export emails.
- **The helpers write only marked rows:** one throwaway tenant (slug `excheck<digits>`) and its deliveries, holds, notices, audit events and alerts, plus one scratch database `bkt_t_*`. `clean` removes them all.
- **Run nothing else against the local control plane while these run.**

## 0. Set up
### 0.1 Migrate the local control plane
```bash
npm run db:migrate:cp
```
**Expect:** `migrations applied successfully!` (the `NOTICE … already exists, skipping` blocks before it are normal).

### 0.2 The helpers
These blocks write `/tmp/ex-world.mts` and `/tmp/ex-check.sh`. Copy each block, from the `cat` line to its closing `EOF`, and paste it once.
```bash
cat > /tmp/ex-world.mts <<'EOF'
// Helper for CLOUD-EXPORT-BROWSER-CHECKS.md: a throwaway workspace, real export-task runs with a stand-in bucket, the digest line.
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const root = process.cwd();
// This file lives in /tmp: the repo's packages are resolved from the repo folder.
const postgres = (await import(createRequire(root + '/package.json').resolve('postgres'))).default;
// The task's bundle replaces this constant at build time (bundle.mjs); run from source, it's set here from the same journal.
(globalThis as Record<string, unknown>).__TENANT_JOURNAL_LENGTH__ = JSON.parse(readFileSync(root + '/drizzle/meta/_journal.json', 'utf8')).entries.length;
const H = await import(root + '/src/__tests__/integration/export-harness.ts');
const { runExport } = await import(root + '/scripts/backup/export.ts');
const { decrypt } = await import(root + '/src/lib/encryption.ts');
const STATE = '/tmp/ex-check-state.json';
const cpUrl = process.env.CONTROL_PLANE_DATABASE_URL!;
const cp = postgres(cpUrl, { max: 1, onnotice: () => {} });
const state = () => { if (!existsSync(STATE)) { console.log('STOP: no workspace yet. Run: bash /tmp/ex-check.sh new'); process.exit(1); } return JSON.parse(readFileSync(STATE, 'utf8')); };
const run = async (args: Record<string, string | undefined>) => {
  const lines: string[] = [];
  const r = await runExport({ runId: `chk-${randomUUID().slice(0, 8)}`, ...args } as never, {
    controlPlaneUrl: cpUrl, store: new H.FakeExportBucket(), ecs: H.fakeEcs(), publish: async () => {}, log: (l: string) => lines.push(l),
  });
  if (r.exitCode !== 0) for (const l of lines) console.log(`exit-log: ${l}`); // the task's own log lines (ids and codes only)
  return r;
};
const [cmd, a1, a2] = process.argv.slice(2);
if (cmd === 'new') {
  if (existsSync(STATE)) { console.log('STOP: a workspace already exists. Run: bash /tmp/ex-check.sh clean'); process.exit(1); }
  const ws = await H.createWorkspaceDb({ admins: ['admin.one@example.invalid', 'admin.two@example.invalid'], timezone: 'America/New_York' });
  const slug = `excheck${Date.now().toString().slice(-8)}`;
  const t = await H.insertTenant(cp, { dbUrl: ws.url, slug, billingEmail: 'billing@example.invalid', signupEmail: 'signup@example.invalid' });
  await ws.sql.end({ timeout: 5 });
  writeFileSync(STATE, JSON.stringify({ tenantId: t.id, slug, wsName: ws.name }));
  console.log(`Ready: ${slug} (tenant id ${t.id})`);
} else if (cmd === 'deliver') {
  const s = state();
  const r = await run({ mode: 'deliver', workspaceId: s.tenantId, ...(a2 ? { extra: a2, reason: 'checks: verified by phone' } : {}) });
  console.log(`exit ${r.exitCode}: ${r.line}`);
  const m = /delivery ([0-9a-f-]{36})/.exec(r.line);
  if (m) {
    const [row] = await cp`SELECT token_encrypted, extra_only FROM export_deliveries WHERE id = ${m[1]}`;
    writeFileSync(`/tmp/ex-token-${a1}`, decrypt(row.token_encrypted));
    writeFileSync(`/tmp/ex-id-${a1}`, m[1]);
    console.log(`saved as "${a1}" (extra_only: ${row.extra_only})`);
  }
} else if (cmd === 'hold') {
  const s = state();
  const r = await run({ mode: 'hold', workspaceId: s.tenantId, reason: 'checks: litigation hold' });
  console.log(`exit ${r.exitCode}: ${r.line}`);
  const m = /hold ([0-9a-f-]{36})/.exec(r.line);
  if (m) writeFileSync('/tmp/ex-hold-id', m[1]);
} else if (cmd === 'release') {
  const r = await run({ mode: 'release', holdId: readFileSync('/tmp/ex-hold-id', 'utf8'), reason: 'checks: hold lifted' });
  console.log(`exit ${r.exitCode}: ${r.line}`);
} else if (cmd === 'policy' || cmd === 'unsuspend') {
  // The admin plan itself, never `tenant:admin suspend --yes`: that command delivers the tenant's pending notices at once,
  // which here would include the export emails.
  const s = state();
  const { applyAdminPlan, plans } = await import(root + '/src/lib/tenant/admin-commands.ts');
  await applyAdminPlan(s.tenantId, cmd === 'policy' ? plans.suspend('checks: policy breach') : plans.unsuspend(), 'checks');
  const [t] = await cp`SELECT status, suspension_reason, policy_export_allowed FROM tenants WHERE id = ${s.tenantId}`;
  console.log(`${cmd}: status ${t.status}, suspension ${t.suspension_reason ?? 'none'}, policy export allowed: ${t.policy_export_allowed}`);
} else if (cmd === 'digest') {
  const { exportDigest } = await import(root + '/src/lib/tenant/export-status.ts');
  console.log((await exportDigest(new Date())).line);
} else if (cmd === 'clean') {
  const s = state();
  // The global misconfiguration alert names a delivery id only: removed first, while the deliveries still exist.
  await cp`DELETE FROM ops_alerts WHERE kind = 'export-download-misconfigured' AND detail->>'deliveryId' IN (SELECT id::text FROM export_deliveries WHERE tenant_id = ${s.tenantId})`;
  for (const t of ['export_deliveries', 'export_holds', 'tenant_notices', 'tenant_audit_events', 'ops_alerts']) {
    await cp.unsafe(`DELETE FROM ${t} WHERE tenant_id = $1`, [s.tenantId]);
  }
  await cp`DELETE FROM tenants WHERE id = ${s.tenantId}`;
  const { dropScratchDb } = await import(root + '/src/__tests__/integration/backup-helpers.ts');
  await dropScratchDb(s.wsName);
  rmSync(STATE);
  console.log(`cleaned: ${s.slug}`);
}
await cp.end({ timeout: 5 });
process.exit(0);
EOF
```
```bash
cat > /tmp/ex-check.sh <<'EOF'
#!/bin/bash
# Helper for CLOUD-EXPORT-BROWSER-CHECKS.md. Usage: bash /tmp/ex-check.sh <step>
set -uo pipefail
[ -f package.json ] || { echo "STOP: run this from the repo folder." >&2; exit 1; }
CP=postgresql://bytime:bytime_dev@localhost:5432/bytime_control
TSX="node --env-file=.env --env-file-if-exists=.env.local --conditions=react-server --import tsx"
st() { [ -s /tmp/ex-check-state.json ] || { echo "STOP: no workspace yet. Run: bash /tmp/ex-check.sh new" >&2; exit 1; }; jq -r ".$1" /tmp/ex-check-state.json; }
case "${1:-}" in
  new|deliver|hold|release|digest|policy|unsuspend) $TSX /tmp/ex-world.mts "$@" 2>&1 | grep -E '^(Ready|exit|saved|STOP|Exports in|policy:|unsuspend:)' ;;
  url) echo "http://localhost:3000/export/$(cat /tmp/ex-token-${2:?label})" ;;
  row) psql "$CP" -Atc "SELECT 'revoked: ' || (d.revoked_at IS NOT NULL) || ', token kept: ' || (d.token_encrypted IS NOT NULL) || ', downloads: ' || d.download_count
         || ', notice superseded: ' || (n.superseded_at IS NOT NULL) || ', notice sent: ' || (n.sent_at IS NOT NULL)
         || ', notice payload: ' || CASE WHEN n.payload IS NULL THEN 'none yet' WHEN n.payload::text LIKE '%/export/' || '$(cat /tmp/ex-token-${2:?label})' || '%' THEN 'has the link' ELSE 'no link' END
       FROM export_deliveries d JOIN tenant_notices n ON n.id = d.notice_id WHERE d.id = '$(cat /tmp/ex-id-$2)'" ;;
  expire) psql "$CP" -q -c "UPDATE export_deliveries SET expires_at = now() - interval '1 minute' WHERE id = '$(cat /tmp/ex-id-${2:?label})'" && echo "expired: $2" ;;
  revoke) shift; npm run --silent tenant:admin -- export-revoke "$@" 2>&1 | grep -vE '^$|^>' ;;
  alerts) psql "$CP" -Atc "SELECT kind || ' | ' || coalesce(detail::text,'') || ' | resolved: ' || (resolved_at IS NOT NULL) FROM ops_alerts WHERE kind LIKE 'export%' AND detail->>'deliveryId' IN ($(for f in /tmp/ex-id-*; do printf "'%s'," "$(cat $f)"; done | sed 's/,$//')) ORDER BY first_seen_at" ;;
  button) # button <mode> <target> <extra> <extra again> <reason> <confirm> <running|none> <modes|none>: the button script as GitHub runs it, with a stand-in aws
    mkdir -p /tmp/ex-stub; rm -f /tmp/ex-aws.log
    if [ "${9:?modes or none}" = none ]; then rm -f /tmp/ex-modes; else echo "$9" > /tmp/ex-modes; fi
    if [ "$8" = running ]; then echo 1 > /tmp/ex-running; else echo 0 > /tmp/ex-running; fi
    printf '#!/bin/bash\necho "$*" >> /tmp/ex-aws.log\ncase "$*" in\n *list-tasks*) cat /tmp/ex-running ;;\n *ExportModes*) if [ -f /tmp/ex-modes ]; then cat /tmp/ex-modes; else echo None; fi ;;\n *) echo None ;;\nesac\n' > /tmp/ex-stub/aws
    chmod +x /tmp/ex-stub/aws
    jq -n --arg m "$2" --arg t "$3" --arg e "$4" --arg e2 "$5" --arg r "$6" --arg c "$7" \
      '{inputs:{mode:$m,target:$t,extra_recipient:$e,extra_recipient_again:$e2,reason:$r,confirm:$c}}' > /tmp/ex-event.json
    GITHUB_RUN_ID=1 GITHUB_RUN_ATTEMPT=1 GITHUB_EVENT_PATH=/tmp/ex-event.json PATH="/tmp/ex-stub:$PATH" \
      bash scripts/backup/export-button.sh | grep -v '^::add-mask::'
    echo "aws calls: $(cat /tmp/ex-aws.log 2>/dev/null | wc -l | tr -d ' ')"; sed 's/ --query.*//' /tmp/ex-aws.log 2>/dev/null ;;
  masks) # the full output (mask lines included) of a press with every input filled in, cut at the first AWS refusal
    jq -n '{inputs:{mode:"deliver",target:"22222222-2222-2222-2222-222222222222",extra_recipient:"counsel@law.example",extra_recipient_again:"counsel@law.example",reason:"verified by phone",confirm:"deliver"}}' > /tmp/ex-event.json
    mkdir -p /tmp/ex-stub; printf '#!/bin/bash\necho 1\n' > /tmp/ex-stub/aws; chmod +x /tmp/ex-stub/aws
    GITHUB_RUN_ID=1 GITHUB_RUN_ATTEMPT=1 GITHUB_EVENT_PATH=/tmp/ex-event.json PATH="/tmp/ex-stub:$PATH" bash scripts/backup/export-button.sh ;;
  clean) $TSX /tmp/ex-world.mts clean 2>&1 | grep -E '^(cleaned|STOP)'
    rm -f /tmp/ex-token-* /tmp/ex-id-* /tmp/ex-hold-id ;;
  *) echo "Usage: bash /tmp/ex-check.sh new|deliver <label> [extra]|hold|release|digest|url <label>|row <label>|expire <label>|policy|unsuspend|revoke <args>|alerts|button …|masks|clean"; exit 1 ;;
esac
EOF
```
Then run:
```bash
bash /tmp/ex-check.sh
```
**Expect:** the usage line.

### 0.3 A throwaway workspace and the task bundle
```bash
bash /tmp/ex-check.sh new
```
**Expect:** `Ready: excheck<digits> (tenant id <uuid>)`.
```bash
npm run backup:bundle
```
**Expect:** it ends without an error.

## A. The export task refuses to run outside AWS
```bash
node build/backup/backup.cjs export deliver --workspace 11111111-1111-1111-1111-111111111111
```
**Expect:** `refused: outside ECS only \`--self-check\` and \`backup --dry-run\` against a local control plane may run`.

## B. The Export workspace button
These run the button's script as GitHub does, with a stand-in `aws` that logs its calls. Arguments, in order: mode, target, extra address, the address again, reason, confirm, whether a task is running, the stack's `ExportModes` output. `""` means the box was left empty.

### B.1 A mode that isn't on the list
```bash
bash /tmp/ex-check.sh button restore 11111111-1111-1111-1111-111111111111 "" "" "" restore none none
```
**Expect:** `refused: mode must be deliver, hold or release`, then `aws calls: 0`.

### B.2 A wrong confirmation
```bash
bash /tmp/ex-check.sh button deliver 11111111-1111-1111-1111-111111111111 "" "" "" hold none none
```
**Expect:** `refused: confirm must be exactly: deliver`, then `aws calls: 0`.

### B.3 A target that isn't a workspace id
```bash
bash /tmp/ex-check.sh button deliver acme "" "" "" deliver none none
```
**Expect:** `refused: target must be a workspace id (uuid, lowercase)`, then `aws calls: 0`.

### B.4 The two extra address boxes don't match
```bash
bash /tmp/ex-check.sh button deliver 11111111-1111-1111-1111-111111111111 counsel@law.example counsel@law.exmaple "verified by phone" deliver none none
```
**Expect:** `refused: the two extra address inputs don't match`, then `aws calls: 0`.

### B.5 An extra address on a hold
```bash
bash /tmp/ex-check.sh button hold 11111111-1111-1111-1111-111111111111 counsel@law.example counsel@law.example "litigation" hold none none
```
**Expect:** `refused: an extra address is only for deliver`, then `aws calls: 0`.

### B.6 A hold without a reason
```bash
bash /tmp/ex-check.sh button hold 11111111-1111-1111-1111-111111111111 "" "" "" hold none none
```
**Expect:** `refused: a reason is required for hold`, then `aws calls: 0`.

### B.7 A delivery to an extra address without a reason
```bash
bash /tmp/ex-check.sh button deliver 11111111-1111-1111-1111-111111111111 counsel@law.example counsel@law.example "" deliver none none
```
**Expect:** `refused: a reason is required for deliver with an extra address`, then `aws calls: 0`.

### B.8 An extra address that isn't one email address
```bash
bash /tmp/ex-check.sh button deliver 11111111-1111-1111-1111-111111111111 "a@b.example,c@d.example" "a@b.example,c@d.example" "two people" deliver none none
```
**Expect:** `refused: the extra address must be one email address (at most 254 characters)`, then `aws calls: 0`.

### B.9 A reason over 200 characters
```bash
bash /tmp/ex-check.sh button hold 11111111-1111-1111-1111-111111111111 "" "" "$(printf 'x%.0s' {1..201})" hold none none
```
**Expect:** `refused: the reason must be at most 200 characters`, then `aws calls: 0`.

### B.10 An input with a line break (possible through the API, not the form)
```bash
bash /tmp/ex-check.sh button hold 11111111-1111-1111-1111-111111111111 "" "" "$(printf 'line one\nline two')" hold none none
```
**Expect:** `refused: inputs must be a single line`, then `aws calls: 0`. The reason's text isn't printed.

### B.11 A press while another export task is running
```bash
bash /tmp/ex-check.sh button deliver 11111111-1111-1111-1111-111111111111 "" "" "" deliver running "deliver hold release"
```
**Expect:**
- `refused: an export task is already running: wait for it, then press again`;
- `aws calls: 1` (`ecs list-tasks … --family cadenzpoint-backup-export --desired-status RUNNING`).

### B.12 A press before the Backup system deploy is approved (the stack has no `ExportModes`)
```bash
bash /tmp/ex-check.sh button deliver 11111111-1111-1111-1111-111111111111 "" "" "" deliver none none
```
**Expect:**
- `refused: the Backup system deploy that adds the export task is pending approval: approve it in GitHub, then press again`;
- `aws calls: 2` (`ecs list-tasks`, then one `describe-stacks`);
- no `run-task`.

### B.13 The same press once the stack lists the modes
```bash
bash /tmp/ex-check.sh button release 33333333-3333-3333-3333-333333333333 "" "" "hold lifted" release none "deliver hold release"
```
**Expect:** the mode check passes. The next refusal is `refused: the backup stack has no TaskSubnets/TaskSecurityGroup outputs (approve the pending Backup system deploy)`. The stand-in has no network outputs, so no task is started (no `run-task` line).

### B.14 Masking comes first
```bash
bash /tmp/ex-check.sh masks
```
**Expect:** the first four lines are, in this order:
- `::add-mask::22222222-2222-2222-2222-222222222222`
- `::add-mask::counsel@law.example`
- `::add-mask::counsel@law.example`
- `::add-mask::verified by phone`

Then `refused: an export task is already running: wait for it, then press again` (the stand-in answers 1). Nothing prints before the mask lines.

## C. Deliveries (the task's own code)
### C.1 A delivery to the workspace's admins and billing contact
```bash
bash /tmp/ex-check.sh deliver main
```
**Expect:**
- `exit 0: export delivered: workspace <tenant id>, delivery <uuid>, 3 recipient(s), expires <7 days from now, UTC>`;
- `saved as "main" (extra_only: false)`.

### C.2 Three more, for the page checks
```bash
bash /tmp/ex-check.sh deliver old
```
```bash
bash /tmp/ex-check.sh deliver withextra counsel@law.example
```
**Expect:**
- `old`: like C.1, with `extra_only: false`;
- `withextra`: `4 recipient(s)` and `extra_only: false` (the admins and billing are still on it).

### C.3 The new delivery's records
```bash
bash /tmp/ex-check.sh row main
```
**Expect:** `revoked: false, token kept: true, downloads: 0, notice superseded: false, notice sent: false, notice payload: none yet` (the email's content is built when it's sent).

## D. The download page
Start the app in one terminal tab (`npm run dev`) and wait for `Ready`. The page lives on the apex, `http://localhost:3000`.

### D.1 The headers
```bash
curl -sI "$(bash /tmp/ex-check.sh url main)" | grep -iE '^(HTTP|cache-control|referrer-policy|x-robots-tag)'
```
**Expect:**
- `HTTP/1.1 200 OK`;
- `Cache-Control`: on the local dev server it reads `no-cache, must-revalidate`, because Next's dev server replaces every page's `Cache-Control` (`next/dist/server/base-server.js`, "In dev, we should not cache pages for any reason"). In production the page's `force-dynamic` gives `private, no-cache, no-store, max-age=0, must-revalidate`, and `next.config.ts` sets `no-store` for `/export/*`;
- `Referrer-Policy: no-referrer`;
- `X-Robots-Tag` contains `noindex`.

### D.2 A workspace address sends the visitor to the apex
```bash
curl -sI "$(bash /tmp/ex-check.sh url main | sed 's#//localhost#//acme.localhost#')" | grep -iE '^(HTTP|location)'
```
**Expect:** a `307` redirect, with `location:` the same `/export/<token>` address on `http://localhost:3000`.

### D.3 A valid link (in the browser)
1. Print the address:
   ```bash
   bash /tmp/ex-check.sh url main
   ```
2. Open it in the browser.

**Expect:**
- the CadenzPoint logo and the heading **Workspace export**;
- `Workspace export for Acme Export Test · <size> · works until <date> at <time> EST` (7 days from now, in the workspace's New York time);
- a **Prepare download** button.

Then check the page's head: `<meta name="referrer" content="no-referrer">` and `<meta name="robots" content="noindex, nofollow">`.

### D.4 Without JavaScript
Open the same address with JavaScript turned off (or `curl -s "$(bash /tmp/ex-check.sh url main)" | grep -o 'Turn on JavaScript to download'`).

**Expect:** the button reads **Turn on JavaScript to download** and is disabled.

### D.5 Opening the page doesn't count as a download
```bash
bash /tmp/ex-check.sh row main
```
**Expect:** `downloads: 0`, after D.1–D.4 opened it several times.

### D.6 Prepare download, with no AWS settings (the local case)
On the page from D.3, press **Prepare download**.

**Expect:**
- the red alert **Downloads aren't available right now. Contact support@cadenzpoint.com.**;
- the button stays, reading **Prepare download**.

Then:
```bash
bash /tmp/ex-check.sh alerts
```
**Expect:** one `export-download-misconfigured` alert row, with `reason` `misconfigured` and the `deliveryId` of `main`, and `resolved: false`. The detail holds ids only: no token, no address.

### D.7 A link that doesn't exist, and one that's malformed
Open `http://localhost:3000/export/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` (43 characters), then `http://localhost:3000/export/abc`.

**Expect:** both show **This link has expired. Ask support@cadenzpoint.com for a new one.**, with no button.

### D.8 An expired link
```bash
bash /tmp/ex-check.sh expire old
```
Open `bash /tmp/ex-check.sh url old` in the browser.

**Expect:** the same expired text, with no button.

### D.9 Under a later policy hold
```bash
bash /tmp/ex-check.sh policy
```
```bash
bash /tmp/ex-check.sh deliver extraonly verified@contact.example
```
**Expect:** `policy: status suspended, suspension policy, policy export allowed: false`; then `exit 0: export delivered: … 1 recipient(s) …` and `saved as "extraonly" (extra_only: true)`. While a policy hold is on, a delivery goes to the extra address only.

Open the `main`, `withextra` and `extraonly` addresses (`bash /tmp/ex-check.sh url <label>`).

**Expect:**
- `main` and `withextra` show the expired text, with no button (A1: admins' links stop working under a policy hold);
- `extraonly` shows the details and **Prepare download**.

```bash
bash /tmp/ex-check.sh unsuspend
```
**Expect:** `unsuspend: status active, suspension none, …`. Reload `main`. **Expect:** the details and **Prepare download** again.

## E. Revoking a link
### E.1 Refusals
```bash
bash /tmp/ex-check.sh revoke not-a-uuid
```
**Expect:** `export-revoke takes a delivery id (uuid).`, and nothing changed.
```bash
bash /tmp/ex-check.sh revoke 44444444-4444-4444-4444-444444444444
```
**Expect:** a refusal that names an unknown delivery, and nothing changed.

### E.2 The dry run
```bash
bash /tmp/ex-check.sh revoke "$(cat /tmp/ex-id-main)"
```
**Expect:**
- `Would REVOKE export delivery <id> of excheck<digits> (link valid until <ISO time>).`;
- `Its export email has not been sent yet: it will be superseded (never sent).`;
- a line saying nothing was changed without `--yes`.

```bash
bash /tmp/ex-check.sh row main
```
**Expect:** still `revoked: false, token kept: true`.

### E.3 The revoke
```bash
bash /tmp/ex-check.sh revoke "$(cat /tmp/ex-id-main)" --yes
```
**Expect:** `✓ Revoked. The hourly sweep erases the copy within the hour.`
```bash
bash /tmp/ex-check.sh row main
```
**Expect:** `revoked: true, token kept: false, downloads: 0, notice superseded: true, notice sent: false, notice payload: none yet`. The token is gone from the delivery, and the email will never be sent.

Reload the `main` page. **Expect:** the expired text, with no button.

### E.4 Revoking twice
```bash
bash /tmp/ex-check.sh revoke "$(cat /tmp/ex-id-main)" --yes
```
**Expect:** a refusal that says it's already revoked, and nothing changed.

## F. Legal holds and the digest
### F.1 A hold, then the digest line
```bash
bash /tmp/ex-check.sh hold
```
**Expect:** `exit 0: export held: workspace <tenant id>, hold <uuid>`.
```bash
bash /tmp/ex-check.sh digest
```
**Expect:** `Exports in the last 7 days: <n> delivered, <n> downloads, <k> not yet emailed. Open legal holds: <h> (oldest 0 days)`, with `<n>` at least 4 and `<h>` at least 1. The line carries no addresses or reasons.

### F.2 The release
```bash
bash /tmp/ex-check.sh release
```
**Expect:** `exit 0: export released: hold <the same uuid>`.

## G. The retired local export
```bash
npm run tenant:export 2>&1 | grep -o 'Missing script: "tenant:export"'; ls scripts/tenant-export.ts 2>&1 | grep -o 'No such file'; ls src/app/api/export/workspace/route.ts
```
**Expect:** `Missing script: "tenant:export"`, `No such file`, then `src/app/api/export/workspace/route.ts` (the in-app export is unchanged).

## H. Templates
```bash
cfn-lint ops/aws/*.yml && echo "cfn-lint: clean"
```
**Expect:** `cfn-lint: clean`.

## I. Clean up
Stop the app (Ctrl-C in its tab), then:
```bash
bash /tmp/ex-check.sh clean
```
**Expect:** `cleaned: excheck<digits>`.
```bash
psql postgresql://bytime:bytime_dev@localhost:5432/bytime_control -Atc "SELECT (SELECT count(*) FROM tenants WHERE slug LIKE 'excheck%') || ' tenants, ' || (SELECT count(*) FROM export_deliveries d LEFT JOIN tenants t ON t.id = d.tenant_id WHERE t.id IS NULL) || ' orphan deliveries'"; psql postgresql://bytime:bytime_dev@localhost:5432/postgres -Atc "SELECT count(*) || ' bkt_ databases' FROM pg_database WHERE datname LIKE 'bkt\_%'"
```
**Expect:** `0 tenants, 0 orphan deliveries`, then `0 bkt_ databases`.
