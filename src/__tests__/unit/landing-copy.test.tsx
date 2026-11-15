import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';

/**
 * feature-plan-ux-integrations-billing.md L1 / LA-2: the landing strings are BUSINESS-DECISIONS.md §2's, verbatim, with
 * the product owner's accuracy amendments of 2026-11-11 (features 1, 2, 4, 5) and feature 6's pre-approval text. The
 * expected strings are written out here (the business file isn't committed). The "DCAA Compliant" badge stays.
 * feature-plan-per-user-billing.md §6.11 / U7: the Pricing section (BUSINESS-DECISIONS.md §1 strings, Q7 heading).
 */

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ redirect: () => { throw new Error('redirect'); } }));
vi.mock('@/lib/tenant/context', () => ({ getTenantSlug: async () => '' }));
vi.mock('@/lib/session', () => ({ getSessionUser: async () => null }));

import LandingPage from '@/app/page';
import * as copy from '@/lib/marketing/landing-copy';

const EXPECTED = {
  headline: 'DCAA-compliant timekeeping for government contractors',
  subhead: 'Daily time entry, a revision history that never overwrites, and certified, supervisor-approved timesheets, in a modern app your team will actually use.',
  featuresHeading: 'Built for DCAA compliance',
  features: [
    ['Nothing is overwritten', 'Every change creates a new revision with a reason, and the database itself blocks overwriting or deleting entries. Auditors see who changed what, when, and why.'],
    ['Daily time entry', 'Late entries are flagged and need a reason, future dates are blocked, and daily reminders keep employees on track.'],
    ['People see only their codes', 'Employees can charge only the charge codes assigned to them, enforced on the server.'],
    ['Signed and approved', 'Employees certify each timesheet when they submit it. Supervisors approve or return it. Submitted and approved timesheets lock.'],
    ['Reports auditors ask for', 'PDF timesheets, cost reports in CSV and Excel, and an audit trail you can filter by person, contract and reason.'],
    ['Works with your systems', 'Payroll files for Gusto, ADP and Paychex, and a REST API. QuickBooks Online integration coming soon.'],
  ],
  disclaimer: 'DCAA does not certify or endorse software. CadenzPoint is designed to support DCAA timekeeping requirements; compliance also depends on your organization\'s policies and how you use it.',
};

const unescape = (s: string) => s.replace(/&#x27;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
let out = '';
beforeEach(async () => {
  vi.stubEnv('NEXT_PUBLIC_DEMO_URL', '');
  out = unescape(renderToStaticMarkup(<MantineProvider>{await LandingPage()}</MantineProvider>));
});
afterEach(() => vi.unstubAllEnvs());

describe('LA-2: the landing copy is the business copy', () => {
  it('landing-copy.ts holds the exact strings', () => {
    expect(copy.LANDING_HEADLINE).toBe(EXPECTED.headline);
    expect(copy.LANDING_SUBHEAD).toBe(EXPECTED.subhead);
    expect(copy.LANDING_FEATURES_HEADING).toBe(EXPECTED.featuresHeading);
    expect(copy.LANDING_FEATURES.map((f) => [f.title, f.blurb])).toEqual(EXPECTED.features);
    expect(copy.LANDING_FOOTER_DISCLAIMER).toBe(EXPECTED.disclaimer);
  });

  it('the page renders them: the h1 headline, the subhead, the h2, six features, the footer disclaimer', () => {
    expect(out).toMatch(new RegExp(`<h1[^>]*>${EXPECTED.headline}</h1>`));
    expect(out).toContain(EXPECTED.subhead);
    expect(out).toMatch(new RegExp(`<h2[^>]*id="features-heading"[^>]*>${EXPECTED.featuresHeading}</h2>`));
    for (const [title, blurb] of EXPECTED.features) {
      expect(out).toMatch(new RegExp(`<h3[^>]*>${title}</h3>`));
      expect(out).toContain(blurb);
    }
    const footer = out.slice(out.indexOf('<footer'));
    expect(footer.indexOf(EXPECTED.disclaimer)).toBeGreaterThan(-1);
    expect(footer.indexOf(EXPECTED.disclaimer)).toBeLessThan(footer.indexOf('© 2026 CadenzPoint'));
  });

  it('the "DCAA Compliant" badge stays; the product preview is one labelled image', () => {
    expect(out).toContain('>DCAA Compliant<');
    expect(out).toMatch(/role="img" aria-label="Product preview: a timesheet in CadenzPoint"/);
  });
});

/** U7 (feature-plan-per-user-billing.md §6.11): the strings written out byte for byte (BUSINESS-DECISIONS.md §1, Q7). */
describe('U7: landing Pricing', () => {
  const PRICES = [
    'Free for 30 days', 'Up to 10 users. No credit card required.',
    '$10 / user / month', '$50 minimum (covers up to 5 users)',
    '$8.50 / user / month, billed annually', '$510 minimum per year (covers up to 5 users)',
    'Contact us', 'More than 100 users, invoicing, or custom terms',
    'Up to 100 users',
  ];
  const section = () => out.slice(out.indexOf('<section id="pricing"'), out.indexOf('</section>', out.indexOf('<section id="pricing"')));

  it('a Pricing section after Features, labelled by its h2, with every price, detail and the users line', () => {
    expect(out).toMatch(/<section id="pricing"[^>]*aria-labelledby="pricing-heading"/);
    expect(out).toMatch(/<h2[^>]*id="pricing-heading"[^>]*>Pricing<\/h2>/);
    expect(out.indexOf('id="pricing"')).toBeGreaterThan(out.indexOf('id="features"'));
    for (const p of PRICES) expect(section()).toContain(p);
  });

  it('three h3 card titles: Trial, Standard, Enterprise; Enterprise links to the mailto; Trial has Start free trial', () => {
    for (const t of ['Trial', 'Standard', 'Enterprise']) expect(section()).toMatch(new RegExp(`<h3[^>]*>${t}</h3>`));
    expect(section()).toMatch(/<a[^>]*href="mailto:support@cadenzpoint\.com\?subject=CadenzPoint%20Enterprise"[^>]*>Contact us<\/a>/);
    expect(section()).toMatch(/<a[^>]*href="\/signup"[^>]*>[\s\S]*Start free trial/);
  });

  it('no "tax" anywhere on the page', () => {
    expect(out).not.toMatch(/tax/i);
  });

  it('the header links Features, then Pricing (#pricing)', () => {
    const header = out.slice(out.indexOf('<header'), out.indexOf('</header>'));
    expect(header.indexOf('href="#features"')).toBeGreaterThan(-1);
    expect(header.indexOf('href="#pricing"')).toBeGreaterThan(header.indexOf('href="#features"'));
  });

  it('landing-copy holds the Q7 heading and card titles', () => {
    expect(copy.LANDING_PRICING_HEADING).toBe('Pricing');
    expect(copy.LANDING_PRICING_CARD_TITLES).toEqual({ trial: 'Trial', standard: 'Standard', enterprise: 'Enterprise' });
  });
});
