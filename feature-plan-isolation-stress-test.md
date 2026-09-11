# Blueprint: Tenant Isolation Stress Test — Prove "a tenant only ever sees its own data"

> **Role for the executing developer: Security/platform engineer.** The deliverable is *evidence*, not
> just code: a repeatable test that lets us tell a DCAA buyer, with a straight face, that cross-tenant
> data exposure is impossible — including under concurrent load, the failure mode functional tests
> miss. Build it so it can run against local AND the live production demo on demand.

## 1. Overview & Threat Model

CadenzPoint uses **database-per-tenant** physical isolation — there are no `tenantId` columns; the
boundary IS the database. A request's tenant is derived from the **host header** per request
(`src/lib/tenant/context.ts`), then mapped to a per-tenant pooled DB client (`src/db/index.ts`).

Isolation could, in theory, break at these layers — this test targets each:

| Layer | Failure we must rule out | How this test rules it out |
|---|---|---|
| **Resolution under concurrency** | Under interleaved load, a request for tenant A resolves to B's DB (context bleed / shared mutable state) | Hammer all tenants concurrently; assert every response's physical DB == the requested tenant's DB, over thousands of requests |
| **Header spoofing** | A forged `x-tenant-slug` redirects a request to another tenant | Spoof matrix: every tenant forges every other; host must always win |
| **Apex / no-tenant** | A non-tenant host accidentally binds to some tenant | Apex request must bind to NO tenant |
| **Data layer** | One tenant's client can read another's rows | Already covered by `tenant-data-isolation.test.ts` (keep it; this blueprint complements it) |

The "context bleed under concurrency" case is the one a single-threaded test cannot catch and the one
this blueprint exists for. Because tenant identity comes from Next's request-scoped `headers()`, the
only faithful proof is **real concurrent HTTP traffic** against a running instance.

### The marker: `current_database()`
We don't need to seed unique data. Asking the tenant's own connection `SELECT current_database()`
returns the physical Postgres database name (`tenant_acme`, `tenant_globex`, …). If host→tenant→DB
resolution is correct, `acme.<domain>` MUST report `tenant_acme`. Any other value is a leak, full stop.

## 2. Technical Direction

Two artifacts:

1. **A guarded diagnostic endpoint** `GET /api/_diag/whoami` that resolves the tenant through the
   **exact same path data routes use** (`getTenantSlug()` + `getDb()`), runs `SELECT
   current_database()`, and returns `{ slug, database }` — **and nothing else** (no row data). It is
   **dormant by default**: if `DIAG_SECRET` is unset, or the request's `x-diag-secret` doesn't match,
   it returns **404** (so it never advertises its own existence). This makes the host→tenant→physical-DB
   binding observable and testable without exposing tenant data, and safe to leave deployed.

2. **A concurrency stress harness** `scripts/stress-isolation.ts` that fires large volumes of
   interleaved requests across all tenants at the endpoint and asserts perfect binding, runs a spoof
   matrix, and checks apex-safety. Parameterized by domain so it runs against `localhost` (after
   `npm run demo:local`) or `cadenzpoint.com`. Exits non-zero on any leak; prints a shareable summary.

Why an endpoint and not a pure test: `getDb()` depends on `headers()`, which only exists inside a real
request. The endpoint lets the harness exercise the genuine resolution code path under true concurrency.

## 3. File Topology

```
Files to CREATE:
├── src/app/api/_diag/whoami/route.ts     ← guarded diagnostic (slug + current_database, dormant by default)
└── scripts/stress-isolation.ts           ← concurrency harness + spoof matrix + apex check

Files to MODIFY:
├── package.json                          ← add "stress:isolation": "tsx scripts/stress-isolation.ts"
└── .env.example                          ← document DIAG_SECRET (off unless set)

Files NOT TOUCHED (guardrail — DO NOT MODIFY):
├── src/lib/tenant/context.ts             ← resolution logic is the thing under test; don't alter it
├── src/db/index.ts                       ← getDb()/pool cache under test; don't alter it
└── src/__tests__/integration/tenant-data-isolation.test.ts  ← keep as the data-layer proof
```

## 4. Step-by-Step

> **⚠️ GUARDRAILS:**
> - The endpoint must be **fail-closed and dormant**: no `DIAG_SECRET` → 404. Wrong secret → 404.
>   It must NEVER return tenant row data — only the resolved slug + database name.
> - Resolve via the real `getTenantSlug()` + `getDb()`. Do NOT shortcut tenant resolution, or the
>   test stops proving the real path.
> - Don't weaken any isolation code to make the test pass. The test conforms to the app, never the reverse.
> - `npm run build` + `npm run lint` must pass.

**Step 1 — The diagnostic endpoint.** Create `src/app/api/_diag/whoami/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { getTenantSlug } from '@/lib/tenant/context';

// Always run fresh; never cache a tenant-bound response.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * ISOLATION DIAGNOSTIC — dormant unless DIAG_SECRET is set AND the caller presents it.
 * Returns ONLY the host-resolved tenant slug and the physical database name (via the normal
 * getDb() path). No row data. Used by scripts/stress-isolation.ts to prove host→tenant→DB binding.
 * Returns 404 when disabled or the secret is wrong (don't advertise existence).
 */
export async function GET(req: NextRequest) {
  const secret = process.env.DIAG_SECRET;
  const provided =
    req.headers.get('x-diag-secret') ??
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  try {
    const slug = await getTenantSlug();          // host-derived (source of truth); '' for apex
    const db = await getDb();                     // active-tenant client; fail-closed (throws on none/unknown/suspended/mismatch)
    const rows = await db.execute(sql`SELECT current_database() AS db`);
    // postgres-js execute() returns a row array (same pattern as the health route's controlDb.execute).
    const database = (rows as unknown as Array<{ db: string }>)[0]?.db ?? null;
    return NextResponse.json({ slug, database });
  } catch (err) {
    // 409 = resolution refused (apex/unknown/suspended/header-mismatch). Distinct from 404 (disabled).
    return NextResponse.json({ error: (err as Error).message }, { status: 409 });
  }
}
```
> Verify the `db.execute(...)` return shape against the installed drizzle/postgres-js (mirror the
> health route's usage). If the rows come back wrapped, adjust the accessor — the value you want is
> the string from `SELECT current_database()`.

**Step 2 — The stress harness.** Create `scripts/stress-isolation.ts`:
```ts
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

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const APEX = arg('base', 'localhost:3000')!;
const SCHEME = arg('scheme', 'http')!;
const TENANTS = arg('tenants', 'acme,globex,initech')!.split(',').map((s) => s.trim()).filter(Boolean);
const DB_PREFIX = arg('db-prefix', 'tenant_')!;
const CONCURRENCY = parseInt(arg('concurrency', '50')!, 10);
const ROUNDS = parseInt(arg('rounds', '40')!, 10);
const SECRET = process.env.DIAG_SECRET ?? arg('secret', '')!;

if (!SECRET) { console.error('✗ DIAG_SECRET required (env or --secret).'); process.exit(2); }

const expectedDb = (slug: string) => `${DB_PREFIX}${slug}`;
const whoami = (slug: string) => `${SCHEME}://${slug}.${APEX}/api/_diag/whoami`;
const apexUrl = `${SCHEME}://${APEX}/api/_diag/whoami`;

async function probe(slug: string, extra: Record<string, string> = {}) {
  const res = await fetch(whoami(slug), { headers: { 'x-diag-secret': SECRET, ...extra } });
  let body: { slug?: string; database?: string; error?: string } | null = null;
  try { body = await res.json() as typeof body; } catch { /* non-JSON */ }
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
```

**Step 3 — npm alias.** Add to `package.json` scripts:
```json
"stress:isolation": "tsx scripts/stress-isolation.ts",
```

**Step 4 — Document the env var.** In `.env.example`, under a new diagnostics section:
```bash
# --- Isolation diagnostics (OFF by default) -------------------------------
# When set, enables GET /api/_diag/whoami (returns only resolved slug + physical DB name) for the
# isolation stress test (scripts/stress-isolation.ts). Leave UNSET in normal production; set it only
# for a verification run, or keep a long random value and treat it as a secret. Never exposes row data.
DIAG_SECRET=
```

## 5. Verification

### 5a. Build & lint
```bash
npm run build && npm run lint    # zero errors, no NEW lint warnings
```

### 5b. Endpoint is dormant by default (security check)
```bash
# With DIAG_SECRET unset in the app env:
curl -s -o /dev/null -w "%{http_code}\n" http://acme.localhost:3000/api/_diag/whoami   # → 404
# With it set but wrong secret:
curl -s -o /dev/null -w "%{http_code}\n" -H "x-diag-secret: wrong" http://acme.localhost:3000/api/_diag/whoami  # → 404
```

### 5c. The stress run (the proof)
```bash
# 1) Stand up the populated local demo and run the app
npm run demo:local
DIAG_SECRET=devdiag npm run dev          # set DIAG_SECRET in the app env (.env) so the route is live

# 2) In another shell, hammer it
DIAG_SECRET=devdiag npm run stress:isolation -- --base localhost:3000 --scheme http \
  --tenants acme,globex,initech --concurrency 50 --rounds 40
```
Expected: `✅ PASS — ~2000 authenticated bindings across 3 tenants, 0 cross-tenant leaks. Spoof matrix
clean. Apex bound to no tenant.`

| Check | Expected |
|---|---|
| Phase 1 | every request's `database` == `tenant_<requested>`; 0 mismatches over rounds×concurrency requests |
| Phase 2 | forging `x-tenant-slug` never yields the attacker's DB (host wins via proxy overwrite or mismatch guard) |
| Phase 3 | apex (`localhost:3000`) returns non-200 / no `database` |
| Exit code | `0` on pass, `1` on any leak |

### 5d. Prove it against production too (after deploy)
Set `DIAG_SECRET` in Vercel (temporarily, or keep it as a long secret), redeploy, then:
```bash
DIAG_SECRET=<vercel value> npm run stress:isolation -- --base cadenzpoint.com --scheme https \
  --tenants acme,globex,initech --concurrency 30 --rounds 30
```
This is the artifact you can re-run on demand and screenshot for a security questionnaire.

### 5e. Turn it into a deliberate failure once (trust the test)
Temporarily point two tenants at the SAME database (register `globex` with `tenant_acme`'s URL via
the control plane), re-run, and confirm the harness **FAILS** Phase 1 (globex reports `tenant_acme`).
Revert. A test that can't fail proves nothing — verify it catches a real breach, then restore.

### 5f. Common errors to watch for
| Symptom | Cause | Fix |
|---|---|---|
| Everything 404, preflight aborts | `DIAG_SECRET` unset on the target or mismatched | set it in the app env (`.env`/Vercel) AND pass the same value to the script |
| `fetch failed` / ENOTFOUND on local | `*.localhost` not resolving for Node | add the `/etc/hosts` line the demo bootstrap prints (`127.0.0.1 acme.localhost …`) |
| Phase 1 non-200s but no mismatches | tenant not active / cold start | ensure tenants seeded active; warm the app; re-run |
| Phase 2 shows victim's DB (not attacker's) | that's a PASS — host won | no action; only attacker-DB responses are failures |
| TLS error against prod | wildcard cert not issued yet | finish the wildcard domain step in DEPLOY-DEMO.md |
| Want a harder run | raise `--concurrency`/`--rounds` | e.g. `--concurrency 100 --rounds 100` (~10k requests) |

## 6. What you can claim after this passes
Backed by three independent layers — physical DB-per-tenant (data-layer test), correct host→tenant→DB
binding under heavy concurrency with zero leaks (this harness, Phase 1), spoof-resistance (Phase 2),
and apex-safety (Phase 3) — you can state that a tenant can only ever access its own database, and you
can **re-run the proof against production on demand**. (Auth-layer cross-tenant rejection — per-host
session cookies, the header-mismatch guard — is covered by the smoke script's manual cookie check and
the `tenant-resolution` unit tests; cite those alongside.)
```
