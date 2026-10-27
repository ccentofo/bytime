// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { MantineProvider } from '@mantine/core';
import type { TenantBillingInfo } from '@/server/actions/billing';
import { stripComments } from '../helpers/source-scanner';

/**
 * feature-plan-launch-blockers.md P4 §8 / §9 "Billing": admin-only Billing nav; Subscribe enabled from the server's
 * `purchasable` (not from client-side env); no client value import of @/lib/billing/plans (static); sign-out on the
 * three hold screens; post-checkout copy + one refresh after 5 s.
 */

const h = vi.hoisted(() => {
  const refresh = vi.fn();
  // Stable across renders, like Next's useRouter().
  return { refresh, router: { refresh, push: () => {} }, billing: null as unknown, search: '' };
});
vi.mock('next/navigation', () => ({
  usePathname: () => '/timesheet',
  useRouter: () => h.router,
  useSearchParams: () => new URLSearchParams(h.search),
}));
vi.mock('next-auth/react', () => ({ signOut: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));
vi.mock('@/server/actions/billing', () => ({
  startCheckout: vi.fn(),
  openBillingPortal: vi.fn(),
  getTenantBillingInfo: vi.fn(async () => h.billing),
}));

import { AppNavbar } from '@/components/shell/AppNavbar';
import { SETTINGS_NAV } from '@/components/shell/nav-config';
import { BillingClient } from '@/app/(app)/settings/billing/BillingClient';
import { BillingWall } from '@/app/(app)/BillingWall';
import { OnHoldScreen } from '@/app/(app)/OnHoldScreen';
import { PolicyHoldScreen } from '@/app/(app)/PolicyHoldScreen';

const render = (el: ReactElement) => renderToStaticMarkup(<MantineProvider>{el}</MantineProvider>);

function billingInfo(overrides: Partial<TenantBillingInfo> = {}): TenantBillingInfo {
  return {
    plan: 'trial',
    plans: [
      { key: 'trial', label: 'Trial', seatLimit: 10, purchasable: false },
      { key: 'starter', label: 'Starter', seatLimit: 25, purchasable: true },
      { key: 'pro', label: 'Pro', seatLimit: 100, purchasable: false },
      { key: 'enterprise', label: 'Enterprise', seatLimit: null, purchasable: true },
    ],
    subscriptionStatus: null,
    hasCustomer: false,
    canSubscribe: true,
    payUrl: null,
    suspensionReason: null,
    ...overrides,
  };
}

/** For each plan card (in order), whether its Subscribe button is disabled. */
function subscribeButtons(html: string): Array<{ plan: string; disabled: boolean }> {
  const out: Array<{ plan: string; disabled: boolean }> = [];
  for (const m of html.matchAll(/(Starter|Pro|Enterprise)<\/p>[\s\S]*?<button([^>]*)>[\s\S]*?(Subscribe|Current plan)/g)) {
    out.push({ plan: m[1], disabled: /\sdisabled(=|\s|$)/.test(m[2]) || /data-disabled="true"/.test(m[2]) });
  }
  return out;
}

describe('Billing nav (UX-2 §4.2: Billing lives in the Settings area)', () => {
  it('SETTINGS_NAV lists Billing → /settings/billing; the admin main menu reaches it through Settings', () => {
    expect(SETTINGS_NAV.find((l) => l.label === 'Billing')).toMatchObject({ href: '/settings/billing' });
    const admin = render(<AppNavbar userRole="admin" />);
    expect(admin).toMatch(/href="\/settings\/workspace"[\s\S]*?Settings/);
    expect(admin).not.toContain('/settings/billing'); // not in the main menu any more
  });

  it('supervisors and employees see neither Settings nor Billing', () => {
    for (const role of ['supervisor', 'employee']) {
      const out = render(<AppNavbar userRole={role} />);
      expect(out, role).not.toContain('/settings/');
    }
  });
});

describe('Subscribe availability comes from the server', () => {
  it('each plan\'s Subscribe follows its server-computed `purchasable` (no Stripe env in the client)', () => {
    // The unit environment has no STRIPE_PRICE_* vars — exactly like a browser bundle.
    expect(process.env.STRIPE_PRICE_STARTER).toBeUndefined();
    expect(subscribeButtons(render(<BillingClient billing={billingInfo()} />))).toEqual([
      { plan: 'Starter', disabled: false },
      { plan: 'Pro', disabled: true },
      { plan: 'Enterprise', disabled: false },
    ]);
  });

  it('nothing is subscribable while a subscription is running', () => {
    const html = render(<BillingClient billing={billingInfo({ canSubscribe: false, plan: 'starter', subscriptionStatus: 'active' })} />);
    expect(subscribeButtons(html).every((b) => b.disabled)).toBe(true);
  });
});

describe('no client value import of @/lib/billing/plans (static)', () => {
  const SRC = path.resolve(__dirname, '../..');
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) return name === '__tests__' ? [] : files(p);
      return /\.(ts|tsx)$/.test(name) ? [p] : [];
    });
  }

  /** The plans-module imports in `source` that bring in a VALUE (anything but `import type` / all-`type` specifiers). */
  function valueImportsOfPlans(source: string): string[] {
    const offenders: string[] = [];
    for (const m of source.matchAll(/import\s+([^;'"]*?)\s+from\s+['"]@\/lib\/billing\/plans['"]/g)) {
      const clause = m[1].trim();
      if (clause.startsWith('type ')) continue;
      const named = clause.match(/^\{([\s\S]*)\}$/);
      if (named && named[1].split(',').map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith('type '))) continue;
      offenders.push(m[0]);
    }
    for (const m of source.matchAll(/(?:import|require)\s*\(\s*['"]@\/lib\/billing\/plans['"]\s*\)/g)) offenders.push(m[0]);
    for (const m of source.matchAll(/export\s+[^;'"]*?\s+from\s+['"]@\/lib\/billing\/plans['"]/g)) {
      if (!/^export\s+type\s/.test(m[0])) offenders.push(m[0]);
    }
    return offenders;
  }

  const isClient = (source: string) => /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(source);

  it('no "use client" file value-imports the plans module', () => {
    const offenders = files(SRC)
      .map((f) => ({ f, src: readFileSync(f, 'utf8') }))
      .filter(({ src }) => isClient(src))
      .flatMap(({ f, src }) => valueImportsOfPlans(stripComments(src)).map((imp) => `${path.relative(SRC, f)}: ${imp}`));
    expect(offenders).toEqual([]);
  });

  it('fixture: the check flags a value import and allows type-only imports', () => {
    expect(valueImportsOfPlans(`import { PLANS, type PlanKey } from '@/lib/billing/plans';`)).toHaveLength(1);
    expect(valueImportsOfPlans(`import { PLANS } from "@/lib/billing/plans";`)).toHaveLength(1);
    expect(valueImportsOfPlans(`const p = await import('@/lib/billing/plans');`)).toHaveLength(1);
    expect(valueImportsOfPlans(`import type { PlanKey } from '@/lib/billing/plans';`)).toEqual([]);
    expect(valueImportsOfPlans(`import { type PlanKey } from '@/lib/billing/plans';`)).toEqual([]);
    expect(valueImportsOfPlans(`import { useState } from 'react';\nimport type { PlanKey } from '@/lib/billing/plans';`)).toEqual([]);
    expect(valueImportsOfPlans(`import { useState } from 'react';\nimport {\n  PLANS,\n} from '@/lib/billing/plans';`)).toHaveLength(1);
    expect(isClient(`'use client';\nimport x from 'y';`)).toBe(true);
    expect(isClient(`import x from 'y';`)).toBe(false);
  });
});

describe('sign-out on the hold screens', () => {
  const hasSignOut = (html: string) => /<button[^>]*>[\s\S]*?Sign out[\s\S]*?<\/button>/.test(html);

  it('OnHoldScreen', () => {
    expect(hasSignOut(render(<OnHoldScreen />))).toBe(true);
  });

  it('PolicyHoldScreen (with and without export)', () => {
    expect(hasSignOut(render(<PolicyHoldScreen canExport={false} />))).toBe(true);
    expect(hasSignOut(render(<PolicyHoldScreen canExport />))).toBe(true);
  });

  it('BillingWall', async () => {
    h.billing = billingInfo();
    expect(hasSignOut(render(await BillingWall()))).toBe(true);
  });
});

describe('back from Stripe Checkout', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false, media: query, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
      }),
    });
  });
  beforeEach(() => {
    vi.useFakeTimers();
    h.refresh.mockReset();
    h.search = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const mount = (status?: string) =>
    act(() => { root.render(<MantineProvider><BillingClient billing={billingInfo()} checkoutStatus={status} /></MantineProvider>); });

  it('says the subscription is being activated and refreshes exactly once after 5 s', () => {
    mount('success');
    expect(container.textContent).toContain('Thanks — your subscription is being activated');
    act(() => { vi.advanceTimersByTime(4999); });
    expect(h.refresh).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    mount('success'); // a re-render with the same props (as after the refresh) does not schedule another
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('no refresh without a successful checkout', () => {
    mount();
    mount('cancelled');
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('audit R3: the BillingWall (no checkoutStatus prop — layouts get no searchParams) reads ?status=success from the URL: "being activated" + one refresh', async () => {
    h.billing = billingInfo();
    h.search = '?status=success';
    const wall = await BillingWall();
    act(() => { root.render(<MantineProvider>{wall}</MantineProvider>); });
    expect(container.textContent).toContain('Workspace suspended');
    expect(container.textContent).toContain('Thanks — your subscription is being activated');
    act(() => { vi.advanceTimersByTime(5000); });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it('audit R3: ?status=cancelled on the wall shows the cancelled note and never refreshes', async () => {
    h.billing = billingInfo();
    h.search = '?status=cancelled';
    const wall = await BillingWall();
    act(() => { root.render(<MantineProvider>{wall}</MantineProvider>); });
    expect(container.textContent).toContain('Checkout was cancelled');
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(h.refresh).not.toHaveBeenCalled();
  });
});
