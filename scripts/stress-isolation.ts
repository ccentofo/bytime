/**
 * Tenant isolation stress test. Proves, under heavy concurrency, that every request binds ONLY to
 * its own tenant's physical database — zero cross-tenant leakage — plus a header-spoof matrix and an
 * apex-safety check. Hits the guarded /api/_diag/whoami endpoint.
 *
 * Set DIAG_SECRET on the TARGET (Vercel env or local .env) AND pass it here (env or --secret).
 *
 * Local (after `npm run demo:local` + `npm run dev`; needs the /etc/hosts entries the bootstrap prints):
 *   DIAG_SECRET=xxx npx tsx scripts/stress-isolation.ts \
 *     --base localhost:3000 --scheme http --tenants acme,globex,initech --concurrency 50 --rounds 40
 *
 * Production demo:
 *   DIAG_SECRET=xxx npx tsx scripts/stress-isolation.ts \
 *     --base cadenzpoint.com --scheme https --tenants acme,globex,initech
 */
import 'dotenv/config';
import { tenantDatabaseName } from '../src/lib/tenant/db-name';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const APEX = arg('base', 'localhost:3000')!;
const SCHEME = arg('scheme', 'http')!;
const TENANTS = arg('tenants', 'acme,globex,initech')!.split(',').map((s) => s.trim()).filter(Boolean);
// Optional override for non-standard naming; by default use the app's own naming rule.
const DB_PREFIX = arg('db-prefix');
const CONCURRENCY = parseInt(arg('concurrency', '50')!, 10);
const ROUNDS = parseInt(arg('rounds', '40')!, 10);
const SECRET = process.env.DIAG_SECRET ?? arg('secret', '')!;

if (!SECRET) { console.error('✗ DIAG_SECRET required (env or --secret).'); process.exit(2); }

// Must match how tenants are actually named (src/lib/tenant/db-name.ts): tenant_<slug>, hyphens → underscores.
const expectedDb = (slug: string) => (DB_PREFIX ? `${DB_PREFIX}${slug}` : tenantDatabaseName(slug));
const whoami = (slug: string) => `${SCHEME}://${slug}.${APEX}/api/diag/whoami`;
const apexUrl = `${SCHEME}://${APEX}/api/diag/whoami`;

type DiagBody = { slug?: string; database?: string; error?: string };

async function probe(slug: string, extra: Record<string, string> = {}) {
  const res = await fetch(whoami(slug), { headers: { 'x-diag-secret': SECRET, ...extra } });
  let body: DiagBody | null = null;
  try { body = await res.json() as DiagBody; } catch { /* non-JSON */ }
  return { status: res.status, body };
}

async function main() {
  console.log(`\n🔒 Isolation stress test → ${SCHEME}://*.${APEX}`);
  console.log(`   tenants=${TENANTS.join(',')}  concurrency=${CONCURRENCY}  rounds=${ROUNDS}\n`);

  // Preflight: confirm the endpoint is enabled and the secret is right (else everything is 404).
  const pre = await probe(TENANTS[0]);
  if (pre.status === 404) {
    console.error('✗ /api/_diag/whoami returned 404 — DIAG_SECRET is unset on the target or does not match.');
    process.exit(2);
  }

  // ── Phase 1: concurrency purity ──────────────────────────────────────────
  const total = ROUNDS * CONCURRENCY;
  const workload: string[] = [];
  for (let i = 0; i < total; i++) workload.push(TENANTS[i % TENANTS.length]);
  for (let i = workload.length - 1; i > 0; i--) {            // shuffle for true interleaving
    const j = Math.floor(Math.random() * (i + 1));
    [workload[i], workload[j]] = [workload[j], workload[i]];
  }

  let ok = 0, nonOk = 0;
  const leaks: Array<{ requested: string; got: unknown }> = [];
  for (let off = 0; off < workload.length; off += CONCURRENCY) {
    const batch = workload.slice(off, off + CONCURRENCY);
    const results = await Promise.all(batch.map(async (slug) => ({ slug, ...(await probe(slug)) })));
    for (const r of results) {
      if (r.status !== 200) { nonOk++; leaks.push({ requested: r.slug, got: { status: r.status, ...r.body } }); continue; }
      if (r.body?.slug !== r.slug || r.body?.database !== expectedDb(r.slug)) {
        leaks.push({ requested: r.slug, got: r.body });
      } else ok++;
    }
  }
  console.log(`Phase 1 — concurrency purity: ${ok}/${total} correct, ${nonOk} non-200, ${leaks.length} mismatch(es)`);

  // ── Phase 2: header-spoof matrix (host must always win) ───────────────────
  const bypasses: Array<{ victimHost: string; forged: string; got: unknown }> = [];
  for (const victim of TENANTS) {
    for (const attacker of TENANTS) {
      if (attacker === victim) continue;
      const r = await probe(victim, { 'x-tenant-slug': attacker });
      // PASS if bound to victim (proxy overwrote the header) OR refused (mismatch guard). FAIL only if it served the attacker's DB.
      if (r.status === 200 && r.body?.database === expectedDb(attacker)) {
        bypasses.push({ victimHost: victim, forged: attacker, got: r.body });
      }
    }
  }
  console.log(`Phase 2 — spoof matrix: ${TENANTS.length * (TENANTS.length - 1)} attempts, ${bypasses.length} bypass(es)`);

  // ── Phase 3: apex must bind to NO tenant ─────────────────────────────────
  const apexRes = await fetch(apexUrl, { headers: { 'x-diag-secret': SECRET } });
  const apexBody = await apexRes.json().catch(() => null) as { database?: string } | null;
  const apexLeak = apexRes.status === 200 && !!apexBody?.database;
  console.log(`Phase 3 — apex safety: status ${apexRes.status}${apexLeak ? ' (LEAK: bound to ' + apexBody?.database + ')' : ' (bound to no tenant ✓)'}`);

  // ── Verdict ──────────────────────────────────────────────────────────────
  const failed = leaks.length > 0 || bypasses.length > 0 || apexLeak;
  console.log('\n' + '─'.repeat(60));
  if (!failed) {
    console.log(`✅ PASS — ${ok} authenticated bindings across ${TENANTS.length} tenants, 0 cross-tenant leaks.`);
    console.log(`   Spoof matrix clean. Apex bound to no tenant.`);
  } else {
    console.log('❌ FAIL — isolation breach detected:');
    if (leaks.length) console.log('  Phase 1 leaks/errors:', JSON.stringify(leaks.slice(0, 10), null, 2));
    if (bypasses.length) console.log('  Phase 2 spoof bypasses:', JSON.stringify(bypasses, null, 2));
    if (apexLeak) console.log('  Phase 3 apex leak:', apexBody);
  }
  console.log('─'.repeat(60) + '\n');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error('stress-isolation crashed:', err); process.exit(2); });
