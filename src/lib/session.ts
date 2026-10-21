import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { getSupervisedEmployeeIds } from '@/server/internal/supervisor-scope';

export type SessionUser = {
  id: string;
  email: string;
  fullName: string;
  role: 'admin' | 'supervisor' | 'employee';
};

/**
 * Resolve the current session user, or null if no session exists.
 * Identity comes ONLY from here — never from a caller-supplied parameter.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await auth();
  if (!session?.user) return null;

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
    throw new Error('Unauthorized: No active session');
  }
  return user;
}

/** Admin only. Supervisors are NOT admins — use requireApprover() for admin-or-supervisor. */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireSession();
  if (user.role !== 'admin') {
    throw new Error('Forbidden: Admin role required');
  }
  return user;
}

/** Admin or supervisor — the "approver" roles that may review other employees' timesheets. */
export async function requireApprover(): Promise<SessionUser> {
  const user = await requireSession();
  if (user.role !== 'admin' && user.role !== 'supervisor') {
    throw new Error('Forbidden: Approver role required');
  }
  return user;
}

/**
 * Employee ids the actor may see in approver contexts: 'all' for admins, scoped ids (employees
 * sharing an active CLIN assignment with the actor) for supervisors, empty for employees.
 */
export async function getEmployeeScope(actor: SessionUser): Promise<'all' | string[]> {
  if (actor.role === 'admin') return 'all';
  if (actor.role === 'supervisor') return getSupervisedEmployeeIds(actor.id, actor.role);
  return [];
}

/**
 * Throws unless the actor is the employee themselves, an admin, or a supervisor with the
 * employee in scope. Use in front of any read/write that targets a specific employee's data.
 */
export async function assertCanAccessEmployee(actor: SessionUser, employeeId: string): Promise<void> {
  if (actor.id === employeeId) return;
  if (actor.role === 'admin') return;
  if (actor.role === 'supervisor') {
    const scope = await getSupervisedEmployeeIds(actor.id, actor.role);
    if (scope === 'all' || scope.includes(employeeId)) return;
  }
  throw new Error('Forbidden: You are not authorized to access this employee\'s data.');
}

/**
 * Page-guard helper for Server Components. Redirects (never throws) since pages render HTML,
 * not JSON error responses. Use in place of inline `role !== 'admin'` checks in every admin page.
 */
export async function requirePageRole(required: 'admin' | 'approver'): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  if (required === 'admin' && user.role !== 'admin') redirect('/timesheet');
  if (required === 'approver' && user.role !== 'admin' && user.role !== 'supervisor') redirect('/timesheet');
  return user;
}
