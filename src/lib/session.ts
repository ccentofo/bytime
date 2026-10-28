import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getDbForAuth } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { reviewScope } from '@/server/internal/approval-rules';
import { safeNext } from '@/lib/safe-next';

export type SessionUser = {
  id: string;
  email: string;
  fullName: string;
  role: 'admin' | 'supervisor' | 'employee';
};

/**
 * R2-12: a typed error for every guard failure, so callers (guardErrorResponse, route
 * handlers) can branch on `instanceof AuthorizationError` + `.kind` instead of matching a
 * message-string prefix — which a change to any guard's wording could silently break.
 */
export class AuthorizationError extends Error {
  readonly kind: 'unauthenticated' | 'forbidden';

  constructor(kind: 'unauthenticated' | 'forbidden', message: string) {
    super(message);
    this.name = 'AuthorizationError';
    this.kind = kind;
  }
}

/**
 * Resolve the current session user, or null if no session exists.
 * Identity comes ONLY from here — never from a caller-supplied parameter.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  if (!session?.user) return null;

  // R2-1 defense in depth: the jwt callback already invalidates a session whose tenantSlug
  // doesn't match the request's tenant, but re-check here too in case that callback is ever
  // bypassed (e.g. a future NextAuth change, a cached token). No DB query needed.
  const tokenTenantSlug = (session.user as any).tenantSlug as string | undefined;
  try {
    const { getTenantSlug } = await import('@/lib/tenant/context');
    const requestSlug = await getTenantSlug();
    if (!tokenTenantSlug || tokenTenantSlug !== requestSlug) {
      return null;
    }
  } catch {
    // getTenantSlug() throws on a host / x-tenant-slug mismatch (tampering) — fail closed.
    return null;
  }

  return {
    id: session.user.id as string,
    email: session.user.email as string,
    fullName: (session.user as any).fullName as string,
    role: (session.user as any).role as 'admin' | 'supervisor' | 'employee',
  };
}

/** Any signed-in user. MFA (when enabled) is already enforced as part of sign-in. */
export async function requireSession(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    throw new AuthorizationError('unauthenticated', 'Unauthorized: No active session');
  }
  return user;
}

/** Admin only. Supervisors are NOT admins — use requireApprover() for admin-or-supervisor. */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireSession();
  if (user.role !== 'admin') {
    throw new AuthorizationError('forbidden', 'Forbidden: Admin role required');
  }
  return user;
}

/** Admin or supervisor — the "approver" roles that may review other employees' timesheets. */
export async function requireApprover(): Promise<SessionUser> {
  const user = await requireSession();
  if (user.role !== 'admin' && user.role !== 'supervisor') {
    throw new AuthorizationError('forbidden', 'Forbidden: Approver role required');
  }
  return user;
}

/**
 * R2-8: re-checks role and active status directly against the tenant DB, bypassing the JWT's
 * cached role (refreshed at most every 60s, and fails OPEN on DB error — see auth.ts's jwt
 * callback). Use this for sensitive, hard-to-undo actions where a demoted or deactivated admin
 * must be denied immediately. Fails CLOSED: any DB error here denies access (no catch).
 *
 * Uses getDbForAuth() (tolerates a suspended tenant), not the strict getDb() — some of this
 * guard's callers (billing.ts's startCheckout/openBillingPortal) must keep working for a
 * suspended tenant's admin so they can reach the billing wall and pay. A role/active check
 * reads only users.role/isActive, the same columns the login path already reads for a
 * suspended tenant — it is not a business-data query.
 */
async function withFreshRole(user: SessionUser, allowedRoles: SessionUser['role'][]): Promise<SessionUser> {
  const db = await getDbForAuth();
  const [row] = await db.select({ role: users.role, isActive: users.isActive }).from(users).where(eq(users.id, user.id));
  if (!row || !row.isActive || !allowedRoles.includes(row.role)) {
    throw new AuthorizationError('forbidden', 'Forbidden: Your access has changed — please sign in again.');
  }
  // Return the DB role, not the JWT's: callers branch on actor.role (admin self-approval,
  // all-employee scope), so an admin demoted to supervisor must be treated as a supervisor now.
  return { ...user, role: row.role };
}

/** Admin only, with a fresh DB check (see withFreshRole). Use for sensitive admin actions. */
export async function requireAdminFresh(): Promise<SessionUser> {
  return withFreshRole(await requireAdmin(), ['admin']);
}

/** Admin or supervisor, with a fresh DB check (see withFreshRole). Use for sensitive approver actions. */
export async function requireApproverFresh(): Promise<SessionUser> {
  return withFreshRole(await requireApprover(), ['admin', 'supervisor']);
}

/**
 * Employee ids the actor may see in approver contexts — the ONE review scope (feature-plan-certified-outputs.md C2,
 * CO-D18; src/server/internal/approval-rules.ts): 'all' for admins; for supervisors the users sharing an active CLIN,
 * the users who effectively designated them as approver, and themselves (R2-12: their own entries/reports are visible
 * too); empty for employees. Roles and designations come from the database, not the session token.
 */
export async function getEmployeeScope(actor: SessionUser): Promise<'all' | string[]> {
  if (actor.role !== 'admin' && actor.role !== 'supervisor') return [];
  return reviewScope(actor);
}

/**
 * Throws unless the actor is the employee themselves, or the employee is in the actor's review scope (above). Use in
 * front of any read/write that targets a specific employee's data.
 */
export async function assertCanAccessEmployee(actor: SessionUser, employeeId: string): Promise<void> {
  if (actor.id === employeeId) return;
  if (actor.role === 'admin' || actor.role === 'supervisor') {
    const scope = await reviewScope(actor);
    if (scope === 'all' || scope.includes(employeeId)) return;
  }
  throw new AuthorizationError('forbidden', 'Forbidden: You are not authorized to access this employee\'s data.');
}

/**
 * Send a signed-out visitor to sign-in, remembering where they were (feature-plan-ux-timesheet.md A4.8): the proxy sets
 * `x-cp-path` (pathname + search, overwriting any incoming value); safeNext keeps only allowlisted same-origin app paths;
 * the value is URL-encoded into `?next=`. Async (headers() is async in Next 16) and never returns — every caller writes
 * `return loginRedirect();` so TypeScript narrows and nothing falls through.
 */
export async function loginRedirect(): Promise<never> {
  const next = safeNext((await headers()).get('x-cp-path'));
  redirect(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
}

/**
 * Page-guard helper for Server Components. Redirects (never throws) since pages render HTML,
 * not JSON error responses. Use in place of inline `role !== 'admin'` checks in every admin page.
 */
export async function requirePageRole(required: 'admin' | 'approver'): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) return loginRedirect();
  if (required === 'admin' && user.role !== 'admin') redirect('/timesheet');
  if (required === 'approver' && user.role !== 'admin' && user.role !== 'supervisor') redirect('/timesheet');
  return user;
}
