import { auth } from '@/auth';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AppShellWrapper } from './AppShellWrapper';
import { getTenantState } from '@/lib/tenant/context';
import { TenantUnavailable } from './TenantUnavailable';
import { BillingWall } from './BillingWall';
import { OnHoldScreen } from './OnHoldScreen';
import { PolicyHoldScreen } from './PolicyHoldScreen';
import { canExport } from '@/lib/tenant/lifecycle';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // (app) routes require a usable workspace. Resolve the tenant's access mode first (§3.1) and
  // render the appropriate screen per mode, rather than letting getDb() throw mid-render.
  const tenant = await getTenantState();

  // `closed`/`unknown`/`none`/`mismatch`/`provisioning`: a dead-end screen, no sign-in needed —
  // there is nothing behind it to sign in to.
  if (tenant.kind !== 'full' && tenant.kind !== 'read_only' && tenant.kind !== 'billing_only' && tenant.kind !== 'policy_hold') {
    return <TenantUnavailable reason={tenant.kind} />;
  }

  // billing_only (suspended for non-payment): a LOGGED-OUT visitor is sent to /login, never
  // shown the billing wall — there's no session to decide "admin or not" from, and showing
  // billing details to an unauthenticated visitor would leak that this workspace exists and is
  // suspended. §3.3/T3.
  const session = await auth();

  // policy_hold (F5): signed-in users — admins included — get the hold screen; no billing. Logged-out → /login
  // (same reasoning as billing_only: don't reveal the workspace's state to an anonymous visitor).
  if (tenant.kind === 'policy_hold') {
    if (!session?.user) {
      redirect('/login');
    }
    const role = (session.user as any).role ?? 'employee';
    return <PolicyHoldScreen canExport={role === 'admin' && canExport(tenant.tenant, new Date())} />;
  }

  if (tenant.kind === 'billing_only') {
    if (!session?.user) {
      redirect('/login');
    }
    const role = (session.user as any).role ?? 'employee';
    if (role === 'admin') {
      return <BillingWall />;
    }
    return <OnHoldScreen />;
  }

  // full / read_only below — both serve the normal app.
  if (!session?.user) {
    redirect('/login');
  }

  const user = {
    fullName: (session.user as any).fullName ?? session.user.name ?? '',
    email: session.user.email ?? '',
    role: (session.user as any).role ?? 'employee',
  };

  // The setup banner is gone (UX-2 L2): Home's "Finish setting up" item replaces it, so setup status is no longer
  // computed on every page.

  // Read the navbar-collapsed preference server-side so the first paint already has the correct
  // width — prevents the rail flashing open then collapsing on navigation. (Key must match
  // NAV_COLLAPSED_KEY in AppShellWrapper.)
  const cookieStore = await cookies();
  const navCollapsed = cookieStore.get('cadenzpoint-navbar-collapsed')?.value === 'true';

  const readOnlyReason = tenant.kind === 'read_only'
    ? (tenant.tenant.subscriptionEndedAt ? 'subscription_ended' as const : 'trial_ended' as const)
    : null;

  return (
    <AppShellWrapper
      user={user}
      waitingCount={null}
      initialCollapsed={navCollapsed}
      readOnlyReason={readOnlyReason}
      isDemo={tenant.tenant.lifecycleExempt}
    >
      {children}
    </AppShellWrapper>
  );
}
