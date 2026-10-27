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
vi.mock('@/server/actions/signup', () => ({ startSignup: vi.fn(async () => ({ ok: true, data: { slug: 'acme' } })), resendSignupVerification: vi.fn() }));
vi.mock('@/components/auth/TurnstileWidget', () => ({ TurnstileWidget: () => null }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/server/actions/billing', () => ({ startCheckout: vi.fn(), openBillingPortal: vi.fn(), getTenantBillingInfo: vi.fn(async () => h.billing) }));

import { LoginForm } from '@/app/login/LoginForm';
import { ForgotPasswordForm } from '@/app/forgot-password/ForgotPasswordForm';
import { SignupForm } from '@/app/signup/SignupForm';
import { WorkspaceFinder } from '@/components/auth/WorkspaceFinder';
import { TenantUnavailable } from '@/app/(app)/TenantUnavailable';
import { OnHoldScreen } from '@/app/(app)/OnHoldScreen';
import { PolicyHoldScreen } from '@/app/(app)/PolicyHoldScreen';
import { BillingWall } from '@/app/(app)/BillingWall';
import AppError from '@/app/error';
import AppShellError from '@/app/(app)/error';
import AdminError from '@/app/(app)/admin/error';
import { act } from 'react';
import { installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';

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

  // UX-1 audit L10: both "Check your email" screens — their links are real buttons that don't submit anything.
  for (const [label, controls, linkText] of [['without Turnstile', null, 'try again'], ['with Turnstile (resend)', { turnstileSiteKey: 'k' }, 'Start over']] as const) {
    it(`Signup "Check your email" ${label}: one main, one h1, "${linkText}" is a <button type="button">`, async () => {
      (globalThis as { fetch?: unknown }).fetch = async () => ({ json: async () => ({ available: true }) });
      m = await mount(<SignupForm controls={controls} />);
      await act(async () => { m!.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
      await wait(20);
      expect(m.container.textContent).toContain('Check your email');
      expect(m.container.querySelectorAll('main')).toHaveLength(1);
      expect(m.container.querySelectorAll('h1')).toHaveLength(1);
      const link = [...m.container.querySelectorAll('button')].find((b) => b.textContent === linkText)!;
      expect(link).toBeDefined();
      expect(link.getAttribute('type')).toBe('button');
    });
  }

  // UX-1 audit L7 / L8: error boundaries — one h1, a real heading (not inside the Alert's <span> title); the root one is a <main>.
  it('error boundaries: one h1 each, never inside a span; the root boundary renders a <main>', async () => {
    const err = Object.assign(new Error('boom'), { digest: 'd' });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {}); // the boundaries log the error they show
    for (const [name, El] of [['app/error', AppError], ['(app)/error', AppShellError], ['admin/error', AdminError]] as const) {
      m = await mount(<El error={err} reset={() => {}} />);
      const h1s = [...m.container.querySelectorAll('h1')];
      expect(h1s, name).toHaveLength(1);
      expect(h1s[0].closest('span'), name).toBeNull();
      if (name === 'app/error') expect(m.container.querySelectorAll('main')).toHaveLength(1);
      unmount(m);
      m = undefined;
    }
    quiet.mockRestore();
  });
});
