import { auth } from '@/auth';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AppShellWrapper } from './AppShellWrapper';
import { getSetupStatusInternal } from '@/server/internal/setup';
import { getTenantState } from '@/lib/tenant/context';
import { TenantUnavailable } from './TenantUnavailable';
import { BillingWall } from './BillingWall';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // (app) routes require an ACTIVE workspace (a tenant subdomain). Resolve the tenant first
  // and render a clean screen for non-active states rather than letting getDb() throw.
  const tenant = await getTenantState();

  // Suspended tenants get the billing wall so admins can pay and reactivate.
  // All other non-active states get the dead-end unavailable screen.
  if (tenant.kind === 'suspended') {
    const session = await auth();
    const role = (session?.user as any)?.role ?? 'employee';
    return <BillingWall role={role} />;
  }

  if (tenant.kind !== 'active') {
    return <TenantUnavailable reason={tenant.kind} />;
  }

  const session = await auth();

  if (!session?.user) {
    redirect('/login');
  }

  const user = {
    fullName: (session.user as any).fullName ?? session.user.name ?? '',
    email: session.user.email ?? '',
    role: (session.user as any).role ?? 'employee',
  };

  // Only check setup status for admin users
  let setupComplete = true;
  if (user.role === 'admin') {
    try {
      const status = await getSetupStatusInternal();
      setupComplete = status.isComplete;
    } catch {
      // If setup status check fails, don't block the app
      setupComplete = true;
    }
  }

  // Read the navbar-collapsed preference server-side so the first paint already has the correct
  // width — prevents the rail flashing open then collapsing on navigation. (Key must match
  // NAV_COLLAPSED_KEY in AppShellWrapper.)
  const cookieStore = await cookies();
  const navCollapsed = cookieStore.get('cadenzpoint-navbar-collapsed')?.value === 'true';

  return (
    <AppShellWrapper user={user} setupComplete={setupComplete} initialCollapsed={navCollapsed}>
      {children}
    </AppShellWrapper>
  );
}
