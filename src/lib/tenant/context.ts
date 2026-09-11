import 'server-only';
import { headers } from 'next/headers';
import { getTenantBySlug, type TenantRecord } from './registry';
import { tenantFromHost } from './host';

/**
 * Resolve the tenant slug for the current request.
 *
 * The HOST header (set by the platform per the domain the request actually arrived on) is
 * the source of truth. The proxy-injected `x-tenant-slug` is defense-in-depth: if present it
 * MUST agree with the host-derived slug, otherwise it is tampering or a proxy gap and we fail
 * closed. Deriving from host also means tenant resolution is correct even if the proxy did
 * not run for a given route.
 */
export async function getTenantSlug(): Promise<string> {
  const h = await headers();
  const fromHost = tenantFromHost(h.get('host')) ?? '';
  const injected = h.get('x-tenant-slug') ?? '';
  if (injected && injected !== fromHost) {
    throw new Error('Tenant context mismatch — possible header tampering.');
  }
  return fromHost;
}

/**
 * Resolve the ACTIVE tenant or throw (fail-closed). Serves only `status === 'active'`:
 * provisioning (still being set up), suspended (billing), and deleting (offboarding) are
 * all rejected — a half-built or non-paying workspace must never serve requests.
 */
export async function getTenantOrThrow(): Promise<TenantRecord> {
  const slug = await getTenantSlug();
  if (!slug) throw new Error('No tenant in request context.');
  const tenant = await getTenantBySlug(slug);
  if (!tenant) throw new Error(`Unknown workspace: ${slug}`);
  if (tenant.status !== 'active') {
    if (tenant.status === 'suspended') throw new Error('This workspace is suspended.');
    if (tenant.status === 'deleting') throw new Error('This workspace is being removed.');
    if (tenant.status === 'provisioning') throw new Error('This workspace is still being set up. Please try again shortly.');
    throw new Error('This workspace is not available.');
  }
  return tenant;
}

/**
 * Resolve the ACTIVE or SUSPENDED tenant — for the billing path only.
 * Suspended tenants must be able to reach billing so they can pay and reactivate.
 * Still rejects none/unknown/deleting/provisioning/mismatch.
 * DO NOT use this in data paths — only billing.ts should call this.
 */
export async function getTenantForBilling(): Promise<TenantRecord> {
  const slug = await getTenantSlug();
  if (!slug) throw new Error('No tenant in request context.');
  const tenant = await getTenantBySlug(slug);
  if (!tenant) throw new Error(`Unknown workspace: ${slug}`);
  if (tenant.status === 'active' || tenant.status === 'suspended') return tenant;
  if (tenant.status === 'deleting') throw new Error('This workspace is being removed.');
  if (tenant.status === 'provisioning') throw new Error('This workspace is still being set up.');
  throw new Error('This workspace is not available.');
}

/** Non-throwing tenant resolution for UI gating (e.g. rendering a clean "unavailable" screen). */
export type TenantState =
  | { kind: 'active'; tenant: TenantRecord }
  | { kind: 'none' }          // no tenant in context (apex / wrong host)
  | { kind: 'unknown' }       // slug not found in the registry
  | { kind: 'suspended' }
  | { kind: 'deleting' }
  | { kind: 'provisioning' }
  | { kind: 'mismatch' };     // injected header disagreed with host (possible tampering)

/**
 * Resolve the current tenant WITHOUT throwing, so callers (layouts) can render an
 * appropriate screen per state. Mirrors getTenantOrThrow's gating but returns a tagged union.
 */
export async function getTenantState(): Promise<TenantState> {
  let slug: string;
  try {
    slug = await getTenantSlug();
  } catch {
    return { kind: 'mismatch' };
  }
  if (!slug) return { kind: 'none' };
  const tenant = await getTenantBySlug(slug);
  if (!tenant) return { kind: 'unknown' };
  if (tenant.status === 'active') return { kind: 'active', tenant };
  if (tenant.status === 'suspended') return { kind: 'suspended' };
  if (tenant.status === 'deleting') return { kind: 'deleting' };
  if (tenant.status === 'provisioning') return { kind: 'provisioning' };
  return { kind: 'unknown' };
}
