// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import type { ReactElement } from 'react';

/**
 * feature-plan-ux-foundations.md §4.7 / T16 (UX-AUDIT A6, A9): each auth, public and full-page hold screen renders
 * exactly one <main> and one h1; BillingWall's h1 comes before the billing header's h2.
 */

const h = vi.hoisted(() => ({ billing: null as unknown }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-auth/react', () => ({ signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));
vi.mock('@/server/actions/login-attempts', () => ({ checkLockout: vi.fn() }));
vi.mock('@/server/actions/password-reset', () => ({ requestPasswordReset: vi.fn(), verifyResetToken: vi.fn(), resetPassword: vi.fn() }));
vi.mock('@/server/actions/workspace-finder', () => ({ goToWorkspace: vi.fn() }));
vi.mock('@/server/actions/signup', () => ({ startSignup: vi.fn(), resendSignupVerification: vi.fn() }));
vi.mock('@/server/actions/billing', () => ({ startCheckout: vi.fn(), openBillingPortal: vi.fn(), getTenantBillingInfo: vi.fn(async () => h.billing) }));

import { LoginForm } from '@/app/login/LoginForm';
import { ForgotPasswordForm } from '@/app/forgot-password/ForgotPasswordForm';
import { SignupForm } from '@/app/signup/SignupForm';
import { WorkspaceFinder } from '@/components/auth/WorkspaceFinder';
import { TenantUnavailable } from '@/app/(app)/TenantUnavailable';
import { OnHoldScreen } from '@/app/(app)/OnHoldScreen';
import { PolicyHoldScreen } from '@/app/(app)/PolicyHoldScreen';
import { BillingWall } from '@/app/(app)/BillingWall';
import { installDomStubs, mount, unmount, type Mounted } from '../helpers/dom';

h.billing = {
  plan: 'starter', plans: [{ key: 'starter', label: 'Starter', seatLimit: 25, purchasable: true }],
  subscriptionStatus: 'past_due', hasCustomer: true, canSubscribe: true, payUrl: null, suspensionReason: 'non_payment',
};

beforeAll(installDomStubs);
let m: Mounted | undefined;
afterEach(() => { unmount(m); m = undefined; });

async function expectOneMainOneH1(el: ReactElement) {
  m = await mount(el);
  expect(m.container.querySelectorAll('main')).toHaveLength(1);
  expect(m.container.querySelectorAll('h1')).toHaveLength(1);
  return m;
}

describe('auth and full-page screens: one <main>, one h1 (T16)', () => {
  const cases: Array<[string, () => ReactElement]> = [
    ['Login', () => <LoginForm />],
    ['Forgot password', () => <ForgotPasswordForm />],
    ['Signup', () => <SignupForm controls={null} />],
    ['WorkspaceFinder', () => <WorkspaceFinder target="/login" rootDomain="cadenzpoint.test" />],
    ['TenantUnavailable', () => <TenantUnavailable reason="unknown" />],
    ['OnHoldScreen', () => <OnHoldScreen />],
    ['PolicyHoldScreen', () => <PolicyHoldScreen canExport />],
  ];
  for (const [name, el] of cases) {
    it(name, async () => { await expectOneMainOneH1(el()); });
  }

  it('Login: the h1 is "Sign in" (visually hidden)', async () => {
    const mounted = await expectOneMainOneH1(<LoginForm />);
    expect(mounted.container.querySelector('h1')!.textContent).toBe('Sign in');
  });

  it('BillingWall: one main, one h1 ("Workspace suspended"), and the billing header h2 comes after it', async () => {
    const mounted = await expectOneMainOneH1(await BillingWall());
    const headings = [...mounted.container.querySelectorAll('h1, h2, h3, h4')].map((x) => `${x.tagName}:${x.textContent}`);
    expect(headings[0]).toBe('H1:Workspace suspended');
    expect(headings[1]).toBe('H2:Billing');
    expect(headings.slice(2).every((x) => x.startsWith('H3:'))).toBe(true);
  });
});
