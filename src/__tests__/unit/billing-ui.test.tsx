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
 * feature-plan-launch-blockers.md P4 §8 / §9 "Billing": admin-only Billing nav; no client value import of
 * @/lib/billing/plans (static); sign-out on the three hold screens; post-checkout copy + one refresh after 5 s.
 * feature-plan-per-user-billing.md §6.10 / U6: every tile rule, the plan cards, the BillingWall pay button.
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
    interval: null,
    access: 'full',
    lifecycleExempt: false,
    subscriptionStatus: null,
    cancelAtPeriodEnd: false,
    trialEnd: 'Nov 24, 2026',
    renewsOn: null,
    endedOn: null,
    trialDaysLeft: 18,
    trialEnded: false,
    seats: { active: 7, limit: 10 },
    billedQuantity: null,
    billedQuantityApplies: false,
    overdue: false,
    collectionMethod: null,
    ended: false,
    trialDateKnown: true,
    payUrl: null,
    openInvoiceCount: 0,
    hasCustomer: false,
    canSubscribe: true,
    standardAvailable: { month: true, year: true },
    suspensionReason: null,
    ...overrides,
  };
}

/** The rendered page as plain text (tags stripped, entities decoded), for exact-string checks. */
function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}
const page = (o: Partial<TenantBillingInfo> = {}, headerOrder: 1 | 2 = 1) => render(<BillingClient billing={billingInfo(o)} headerOrder={headerOrder} />);
const pageText = (o: Partial<TenantBillingInfo> = {}) => textOf(page(o));
/** The Plan / Users / Payment tile: its label, big text and small text, in order. */
const tile = (txt: string, label: 'Plan' | 'Users' | 'Payment', big: string, small?: string) => {
  const re = new RegExp(`${label} ${escapeRe(big)}${small ? ` ${escapeRe(small)}` : ''}`);
  expect(txt, `${label} tile`).toMatch(re);
};
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

/** U6 (feature-plan-per-user-billing.md §6.10): every tile rule, first match wins, with the exact strings. */
describe('U6: the Billing page tiles', () => {
  it('header, description and the three tile labels', () => {
    const txt = pageText();
    expect(txt).toContain('Billing');
    expect(txt).toContain('Your plan, users and payment details.');
    for (const l of ['Plan', 'Users', 'Payment']) expect(txt).toContain(l);
  });

  describe('Plan tile', () => {
    it('1. Enterprise → "Enterprise" / "Custom terms" (wins over everything)', () => {
      tile(pageText({ plan: 'enterprise', ended: true, interval: 'year' }), 'Plan', 'Enterprise', 'Custom terms');
    });
    it('2. Standard, ended → "Standard" with no small text', () => {
      const txt = pageText({ plan: 'standard', interval: 'month', ended: true, endedOn: 'Oct 1, 2026', subscriptionStatus: 'canceled' });
      expect(txt).toMatch(/Plan Standard Users/);
    });
    it('3. Standard: monthly / annually / no interval', () => {
      tile(pageText({ plan: 'standard', interval: 'month' }), 'Plan', 'Standard', 'Billed monthly');
      tile(pageText({ plan: 'standard', interval: 'year' }), 'Plan', 'Standard', 'Billed annually');
      expect(pageText({ plan: 'standard', interval: null })).toMatch(/Plan Standard Users/);
    });
    it('4. Trial with no trial date, or exempt (demo) → "Free trial" with no small text', () => {
      expect(pageText({ trialDateKnown: false, trialEnd: null, trialDaysLeft: null })).toMatch(/Plan Free trial Users/);
      expect(pageText({ lifecycleExempt: true })).toMatch(/Plan Free trial Users/);
    });
    it('5. Trial not ended → "Ends {date} · {n} days left", and "1 day left"', () => {
      tile(pageText(), 'Plan', 'Free trial', 'Ends Nov 24, 2026 · 18 days left');
      tile(pageText({ trialDaysLeft: 1 }), 'Plan', 'Free trial', 'Ends Nov 24, 2026 · 1 day left');
    });
    it('6. Trial ended → "Ended {date}"', () => {
      tile(pageText({ trialEnded: true, trialDaysLeft: -2 }), 'Plan', 'Free trial', 'Ended Nov 24, 2026');
    });
  });

  describe('Users tile', () => {
    it('1. seats null → "—" / "Couldn\'t load the user count."', () => {
      tile(pageText({ seats: null, plan: 'enterprise' }), 'Users', '—', "Couldn't load the user count.");
    });
    it('2. Enterprise → "{n} active users" / "No user limit." ("1 active user")', () => {
      tile(pageText({ plan: 'enterprise', seats: { active: 7, limit: null } }), 'Users', '7 active users', 'No user limit.');
      tile(pageText({ plan: 'enterprise', seats: { active: 1, limit: null } }), 'Users', '1 active user', 'No user limit.');
    });
    it('3. Standard, ended → "{n} active users" with no small text', () => {
      expect(pageText({ plan: 'standard', ended: true, seats: { active: 7, limit: 100 }, billedQuantity: 12, billedQuantityApplies: true, renewsOn: 'Dec 1, 2026' }))
        .toMatch(/Users 7 active users Payment/);
    });
    it('4. Standard, held above the flat tier → "Billed for {q} users until {date}…", with the cancel variant', () => {
      const held = { plan: 'standard' as const, seats: { active: 7, limit: 100 }, billedQuantity: 9, billedQuantityApplies: true, renewsOn: 'Dec 1, 2026', subscriptionStatus: 'active' };
      tile(pageText(held), 'Users', '7 active users', 'Billed for 9 users until Dec 1, 2026. Removed users leave your bill at renewal.');
      tile(pageText({ ...held, cancelAtPeriodEnd: true }), 'Users', '7 active users', 'Billed for 9 users until Dec 1, 2026, when your subscription ends.');
    });
    it('4 does not apply: renewsOn null, another subscription\'s quantity, or not above max(n, 5) → rule 5', () => {
      const rule5 = 'You pay for each active user. The minimum covers 5. Up to 100 users.';
      const base = { plan: 'standard' as const, seats: { active: 3, limit: 100 }, billedQuantity: 9, billedQuantityApplies: true, renewsOn: 'Dec 1, 2026' };
      tile(pageText({ ...base, renewsOn: null }), 'Users', '3 active users', rule5);
      tile(pageText({ ...base, billedQuantityApplies: false }), 'Users', '3 active users', rule5);
      tile(pageText({ ...base, billedQuantity: 5 }), 'Users', '3 active users', rule5); // held only inside the flat tier
      tile(pageText({ ...base, seats: { active: 9, limit: 100 } }), 'Users', '9 active users', rule5);
    });
    it('5. Standard → the per-user line', () => {
      tile(pageText({ plan: 'standard', seats: { active: 7, limit: 100 } }), 'Users', '7 active users', 'You pay for each active user. The minimum covers 5. Up to 100 users.');
    });
    it('6. Trial → "{n} of 10 used" with an aria-hidden progress bar', () => {
      const html = page();
      tile(textOf(html), 'Users', '7 of 10 used', "Active users count. Inactive users don't.");
      expect(html).toMatch(/aria-hidden="true"[^>]*class="[^"]*mantine-Progress-root|class="[^"]*mantine-Progress-root[^"]*"[^>]*aria-hidden="true"/);
    });
  });

  describe('Payment tile', () => {
    const PAY = 'https://invoice.stripe.test/pay';
    it('1. suspended for non-payment → "Suspended", Pay the invoice; without a link "Use Manage billing to pay."', () => {
      const html = page({ suspensionReason: 'nonpayment', overdue: true, payUrl: PAY, subscriptionStatus: 'past_due', hasCustomer: true, canSubscribe: false });
      tile(textOf(html), 'Payment', 'Suspended', 'Pay the open invoice to restore access.');
      expect(html).toMatch(new RegExp(`<a[^>]*href="${escapeRe(PAY)}"[^>]*>[\\s\\S]*?Pay the invoice`));
      expect(pageText({ suspensionReason: 'nonpayment', payUrl: null })).toContain('Use Manage billing to pay.');
    });
    it('2. pastDueSince set (also while Stripe says active) → "Payment overdue"', () => {
      const html = page({ overdue: true, subscriptionStatus: 'active', collectionMethod: 'send_invoice', payUrl: PAY });
      tile(textOf(html), 'Payment', 'Payment overdue', 'Pay the open invoice to avoid suspension.');
      expect(textOf(html)).toContain('Pay the invoice');
      expect(pageText({ overdue: true, subscriptionStatus: 'past_due', payUrl: null })).toContain('Use Manage billing to pay.');
    });
    it('2b. invoiced past_due that isn\'t overdue → "Invoice open"; not for charge-automatically or ended', () => {
      tile(pageText({ subscriptionStatus: 'past_due', collectionMethod: 'send_invoice', payUrl: PAY }), 'Payment', 'Invoice open', 'Pay it by the due date on the invoice.');
      expect(pageText({ subscriptionStatus: 'past_due', collectionMethod: 'send_invoice', payUrl: PAY })).toContain('Pay the invoice');
      expect(pageText({ subscriptionStatus: 'past_due', collectionMethod: 'charge_automatically' })).not.toContain('Invoice open');
      expect(pageText({ subscriptionStatus: 'past_due', collectionMethod: 'send_invoice', ended: true, endedOn: 'Oct 1, 2026' })).not.toContain('Invoice open');
    });
    it('3. incomplete → "Payment pending", with Finish paying when there is a link', () => {
      const small = 'Finish paying in Stripe, or wait for your bank payment to clear. If a bank payment failed, pay another way.';
      tile(pageText({ subscriptionStatus: 'incomplete', payUrl: PAY }), 'Payment', 'Payment pending', small);
      const link = /<a[^>]*href="https:\/\/invoice\.stripe\.test\/pay"[^>]*>[\s\S]*?Finish paying/;
      expect(page({ subscriptionStatus: 'incomplete', payUrl: PAY })).toMatch(link);
      expect(page({ subscriptionStatus: 'incomplete', payUrl: null })).not.toMatch(/<a[^>]*>[\s\S]*?Finish paying/);
    });
    it('rows 1–3 add the several-invoices line when more than one invoice is open (each row)', () => {
      const line = (n: number) => `You have ${n} open invoices. Manage billing lists them all.`;
      expect(pageText({ suspensionReason: 'nonpayment', overdue: true, payUrl: PAY, openInvoiceCount: 2 })).toContain(line(2)); // row 1
      expect(pageText({ overdue: true, payUrl: PAY, openInvoiceCount: 3 })).toContain(line(3));                                // row 2
      expect(pageText({ subscriptionStatus: 'past_due', collectionMethod: 'send_invoice', payUrl: PAY, openInvoiceCount: 4 })).toContain(line(4)); // row 2b
      expect(pageText({ subscriptionStatus: 'incomplete', payUrl: PAY, openInvoiceCount: 2 })).toContain(line(2));             // row 3
      expect(pageText({ overdue: true, payUrl: PAY, openInvoiceCount: 1 })).not.toContain('open invoices.');
      expect(pageText({ subscriptionStatus: 'active', renewsOn: 'Dec 1, 2026', payUrl: PAY, openInvoiceCount: 3 })).not.toContain('open invoices.'); // not rows 5–6
    });
    it('row 2 beats row 2b: overdue + past_due + send_invoice → "Payment overdue", not "Invoice open"', () => {
      const txt = pageText({ overdue: true, subscriptionStatus: 'past_due', collectionMethod: 'send_invoice', payUrl: PAY });
      tile(txt, 'Payment', 'Payment overdue', 'Pay the open invoice to avoid suspension.');
      expect(txt).not.toContain('Invoice open');
    });
    it('4. ended → "Canceled" / "Ended on {date}. Choose a plan to start again." (first sentence only when it can\'t subscribe)', () => {
      tile(pageText({ ended: true, endedOn: 'Oct 1, 2026', subscriptionStatus: 'active', plan: 'standard' }), 'Payment', 'Canceled', 'Ended on Oct 1, 2026. Choose a plan to start again.');
      const txt = pageText({ ended: true, endedOn: 'Oct 1, 2026', subscriptionStatus: 'active', canSubscribe: false, plan: 'standard' });
      tile(txt, 'Payment', 'Canceled', 'Ended on Oct 1, 2026.');
      expect(txt).not.toContain('Choose a plan to start again.');
    });
    it('5–6. active → "Active" / "Renews {date}" or "Ends {date}"; Pay the open invoice when one is open', () => {
      tile(pageText({ subscriptionStatus: 'active', renewsOn: 'Dec 1, 2026' }), 'Payment', 'Active', 'Renews Dec 1, 2026');
      tile(pageText({ subscriptionStatus: 'trialing', renewsOn: 'Dec 1, 2026', cancelAtPeriodEnd: true }), 'Payment', 'Active', 'Ends Dec 1, 2026');
      expect(pageText({ subscriptionStatus: 'active', renewsOn: 'Dec 1, 2026', payUrl: PAY, openInvoiceCount: 1 })).toContain('Pay the open invoice');
      expect(pageText({ subscriptionStatus: 'active', renewsOn: 'Dec 1, 2026', payUrl: null, openInvoiceCount: 0 })).not.toContain('Pay the');
    });
    it('7. paused → "Paused" / "Contact support@cadenzpoint.com."', () => {
      tile(pageText({ subscriptionStatus: 'paused' }), 'Payment', 'Paused', 'Contact support@cadenzpoint.com.');
    });
    it('8. nothing, exempt (demo) → "None yet" with no small text', () => {
      expect(pageText({ lifecycleExempt: true, trialDateKnown: false })).toMatch(/Payment None yet Choose a plan/);
    });
    it('9. nothing, trial running or no trial date → "Choose a plan before your trial ends to keep editing."', () => {
      tile(pageText(), 'Payment', 'None yet', 'Choose a plan before your trial ends to keep editing.');
      tile(pageText({ trialDateKnown: false, trialEnd: null }), 'Payment', 'None yet', 'Choose a plan before your trial ends to keep editing.');
      tile(pageText({ subscriptionStatus: 'incomplete_expired' }), 'Payment', 'None yet', 'Choose a plan before your trial ends to keep editing.');
    });
    it('10. nothing, trial ended → "Choose a plan to keep editing."', () => {
      tile(pageText({ trialEnded: true }), 'Payment', 'None yet', 'Choose a plan to keep editing.');
    });
  });

  it('statuses are never shown raw', () => {
    for (const status of ['active', 'past_due', 'unpaid', 'incomplete', 'incomplete_expired', 'paused', 'trialing', 'canceled']) {
      const txt = pageText({ subscriptionStatus: status, renewsOn: 'Dec 1, 2026' });
      expect(txt, status).not.toMatch(/past_due|incomplete_expired|\bunpaid\b|\btrialing\b|\bcanceled\b/);
    }
  });

  it('Manage billing under the tiles with a customer; the line beneath when it can\'t subscribe', () => {
    expect(pageText({ hasCustomer: false })).not.toContain('Manage billing');
    expect(pageText({ hasCustomer: true })).toContain('Manage billing');
    expect(pageText({ hasCustomer: true })).not.toContain('Use Manage billing to update your payment method, see invoices or cancel.');
    expect(pageText({ hasCustomer: true, canSubscribe: false, subscriptionStatus: 'active' })).toContain('Use Manage billing to update your payment method, see invoices or cancel.');
  });

  describe('plan cards', () => {
    it('when it can subscribe: "Choose a plan", three cards with the business strings, the Enterprise mailto, the footnote', () => {
      const html = page();
      const txt = textOf(html);
      expect(txt).toContain('Choose a plan');
      for (const t of ['Standard, monthly', 'Standard, annual', 'Enterprise']) expect(txt).toContain(t);
      for (const p of ['$10 / user / month', '$50 minimum (covers up to 5 users)', '$8.50 / user / month, billed annually',
        '$510 minimum per year (covers up to 5 users)', 'Contact us', 'More than 100 users, invoicing, or custom terms', 'Up to 100 users']) {
        expect(txt).toContain(p);
      }
      expect(txt).toContain('Choose monthly');
      expect(txt).toContain('Choose annual');
      expect(html).toMatch(/<a[^>]*href="mailto:support@cadenzpoint\.com\?subject=CadenzPoint%20Enterprise"[^>]*>[\s\S]*?Contact us/);
      expect(txt).toContain("You'll finish on Stripe's secure checkout page. Pay by card or US bank account, and enter a promotion code there if you have one.");
    });
    it('hidden when it can\'t subscribe (a running subscription, or closed)', () => {
      expect(pageText({ canSubscribe: false, subscriptionStatus: 'active' })).not.toContain('Choose a plan');
      expect(pageText({ canSubscribe: false, access: 'closed' })).not.toContain('Choose monthly');
    });
    it('a missing price disables that card\'s button with the visible "Not available yet."', () => {
      const html = page({ standardAvailable: { month: false, year: true } });
      const btn = (label: string) => html.match(new RegExp(`<button([^>]*)>(?:(?!</button>)[\\s\\S])*?${label}`))![1];
      expect(btn('Choose monthly')).toMatch(/disabled/);
      expect(btn('Choose annual')).not.toMatch(/disabled/);
      expect(textOf(html)).toContain('Not available yet.');
      expect(pageText()).not.toContain('Not available yet.');
    });
    it('heading levels: h1/h2/h3 on the page, h2/h3/h4 under BillingWall', () => {
      const one = page({}, 1);
      expect(one).toMatch(/<h1[^>]*>Billing<\/h1>/);
      expect(one).toMatch(/<h2[^>]*>Choose a plan<\/h2>/);
      expect(one).toMatch(/<h3[^>]*>Standard, monthly<\/h3>/);
      const two = page({}, 2);
      expect(two).toMatch(/<h2[^>]*>Billing<\/h2>/);
      expect(two).toMatch(/<h3[^>]*>Choose a plan<\/h3>/);
      expect(two).toMatch(/<h4[^>]*>Enterprise<\/h4>/);
    });
  });

  it('the S20 render half: BillingWall renders the pay button for a suspended billingInfo', async () => {
    h.billing = billingInfo({ suspensionReason: 'nonpayment', overdue: true, subscriptionStatus: 'past_due', payUrl: 'https://invoice.stripe.test/pay', hasCustomer: true, canSubscribe: false, plan: 'standard', seats: null });
    const html = render(await BillingWall());
    expect(html).toMatch(/<a[^>]*href="https:\/\/invoice\.stripe\.test\/pay"[^>]*>[\s\S]*?Pay the invoice/);
    expect(textOf(html)).toContain('Suspended');
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
