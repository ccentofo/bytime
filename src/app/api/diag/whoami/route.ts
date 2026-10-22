import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { readSql } from '@/db';
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
    // Active-tenant raw read; fail-closed (throws on none/unknown/suspended/mismatch).
    const rows = await readSql<{ db: string }>(sql`SELECT current_database() AS db`);
    const database = rows[0]?.db ?? null;
    return NextResponse.json({ slug, database });
  } catch (err) {
    // 409 = resolution refused (apex/unknown/suspended/header-mismatch). Distinct from 404 (disabled).
    return NextResponse.json({ error: (err as Error).message }, { status: 409 });
  }
}
