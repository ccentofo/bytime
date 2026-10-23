import 'server-only';
import { headers } from 'next/headers';
import { getTenantBySlug, type TenantRecord } from './registry';
import { tenantFromHost } from './host';
import { canExport, getTenantAccess, type TenantAccessMode } from './lifecycle';

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

/** Thrown by getTenantForWrite() when the tenant's access mode isn't `full` (defined in @/lib/errors). */
import { WorkspaceReadOnlyError } from '@/lib/errors';
export { WorkspaceReadOnlyError };

async function resolveTenant(slug: string): Promise<TenantRecord> {
  if (!slug) throw new Error('No tenant in request context.');
  const tenant = await getTenantBySlug(slug);
  if (!tenant) throw new Error(`Unknown workspace: ${slug}`);
  return tenant;
}

/**
 * Resolve the tenant and throw unless its access mode is `full` or `read_only` (fail-closed).
 * §3.1/T3: reads are allowed in both modes — `billing_only` and `closed` are rejected here.
 */
export async function getTenantOrThrow(): Promise<TenantRecord> {
  const slug = await getTenantSlug();
  const tenant = await resolveTenant(slug);
  if (tenant.status === 'provisioning') {
    throw new Error('This workspace is still being set up. Please try again shortly.');
  }
  const mode = getTenantAccess(tenant, new Date());
  if (mode === 'full' || mode === 'read_only') return tenant;
  if (mode === 'billing_only') throw new Error('This workspace is suspended.');
  if (mode === 'policy_hold') throw new Error('This workspace is on hold. Contact support@cadenzpoint.com.');
  if (tenant.status === 'deleting' || tenant.status === 'deleted') {
    throw new Error('This workspace is being removed.');
  }
  throw new Error('This workspace is not available.');
}

/**
 * Resolve the tenant and throw unless its access mode is `full` — the write gate (§3.2).
 * `src/db/index.ts`'s `getDbForWrite()` is the only intended caller; every mutating server
 * action goes through that, not this function directly.
 */
export async function getTenantForWrite(): Promise<TenantRecord> {
  const slug = await getTenantSlug();
  const tenant = await resolveTenant(slug);
  if (tenant.status === 'provisioning') {
    throw new WorkspaceReadOnlyError('This workspace is still being set up. Please try again shortly.');
  }
  const mode = getTenantAccess(tenant, new Date());
  if (mode === 'full') return tenant;
  throw new WorkspaceReadOnlyError(
    mode === 'read_only'
      ? 'This workspace is read-only. Subscribe to make changes.'
      : mode === 'billing_only'
        ? 'This workspace is suspended. Update billing to restore access.'
        : mode === 'policy_hold'
          ? 'This workspace is on hold. Contact support@cadenzpoint.com.'
          : 'This workspace is not available.'
  );
}

/** Thrown by getTenantForExport when export isn't allowed in the workspace's current state (route → 403). */
export class ExportNotAllowedError extends Error {}

/**
 * Resolve the tenant for the T6 full-workspace export — `canExport`: every mode except `closed`, and a policy hold
 * only when the founder allowed export for that workspace (F5). D6/D8: read_only and billing_only may export.
 */
export async function getTenantForExport(): Promise<TenantRecord> {
  const slug = await getTenantSlug();
  const tenant = await resolveTenant(slug);
  if (tenant.status === 'provisioning') {
    throw new ExportNotAllowedError('This workspace is still being set up. Please try again shortly.');
  }
  const now = new Date();
  if (canExport(tenant, now)) return tenant;
  throw new ExportNotAllowedError(
    getTenantAccess(tenant, now) === 'policy_hold'
      ? 'This workspace is on hold. Contact support@cadenzpoint.com.'
      : 'This workspace is not available.'
  );
}

/**
 * Resolve the ACTIVE or SUSPENDED tenant — for the billing path only.
 * Suspended tenants must be able to reach billing so they can pay and reactivate.
 * Still rejects none/unknown/deleting/provisioning/deleted/mismatch.
 * DO NOT use this in data paths — only billing.ts should call this.
 */
export async function getTenantForBilling(): Promise<TenantRecord> {
  const slug = await getTenantSlug();
  if (!slug) throw new Error('No tenant in request context.');
  const tenant = await getTenantBySlug(slug);
  if (!tenant) throw new Error(`Unknown workspace: ${slug}`);
  // F5: a policy hold has no billing screen (paying doesn't lift it).
  if (tenant.status === 'suspended' && tenant.suspensionReason === 'policy') {
    throw new Error('This workspace is on hold. Contact support@cadenzpoint.com.');
  }
  if (tenant.status === 'active' || tenant.status === 'suspended') return tenant;
  if (tenant.status === 'deleting') throw new Error('This workspace is being removed.');
  if (tenant.status === 'provisioning') throw new Error('This workspace is still being set up.');
  throw new Error('This workspace is not available.');
}

/** Non-throwing tenant resolution for UI gating (e.g. rendering a clean "unavailable" screen). */
export type TenantState =
  | { kind: 'full'; tenant: TenantRecord }
  | { kind: 'read_only'; tenant: TenantRecord }
  | { kind: 'billing_only'; tenant: TenantRecord }
  | { kind: 'policy_hold'; tenant: TenantRecord }  // F5: suspended for a policy breach
  | { kind: 'closed' }        // deleting/deleted, or past the deletion window
  | { kind: 'provisioning' }  // still being set up — not a lifecycle mode, a pre-lifecycle state
  | { kind: 'none' }          // no tenant in context (apex / wrong host)
  | { kind: 'unknown' }       // slug not found in the registry
  | { kind: 'mismatch' };     // injected header disagreed with host (possible tampering)

/**
 * Resolve the current tenant WITHOUT throwing, so callers (layouts) can render an
 * appropriate screen per state. Mirrors getTenantOrThrow's gating but returns a tagged union
 * carrying the access MODE (§3.1) rather than the raw status — the layout routes on mode.
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
  if (tenant.status === 'provisioning') return { kind: 'provisioning' };

  const mode: TenantAccessMode = getTenantAccess(tenant, new Date());
  if (mode === 'closed') return { kind: 'closed' };
  return { kind: mode, tenant };
}
