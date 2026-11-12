import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import TermsPage from '@/app/terms/page';
import PrivacyPage from '@/app/privacy/page';
import { TERMS_VERSION } from '@/lib/tenant/lifecycle-config';

/**
 * feature-plan-ux-integrations-billing.md §4 / LA-4: Terms §7 and the Privacy Policy carry BUSINESS-DECISIONS.md §3
 * (A1) and (A2) exactly (written out here; the business file isn't committed); the old offline / IndexedDB claims are
 * gone from both pages. Product owner 2026-11-11: Privacy "Last updated: November 2026" (Terms keeps its date) and
 * TERMS_VERSION 2026-11-10-interim.
 */

/** Rendered text with tags removed and whitespace collapsed (the source wraps lines). */
const text = (el: React.ReactElement) => renderToStaticMarkup(<MantineProvider>{el}</MantineProvider>)
  .replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').replace(/ ([.,:;)])/g, '$1').replace(/\( /g, '(');

const terms = text(<TermsPage />);
const privacy = text(<PrivacyPage />);

const A1 = 'We work to keep the Service available but do not guarantee uninterrupted access. We schedule planned maintenance outside U.S. business hours where possible. The Service requires an internet connection and does not support offline time entry. While you edit a timesheet, your unsaved changes are kept in your browser for that tab so a page reload doesn\'t lose them. They are not saved to the Service until you save them, and they are lost if you close the tab first.';

const A2 = [
  'Authentication data: hashed passwords and multi-factor authentication settings (secrets are stored encrypted).',
  'Security data: sign-in attempts (the email address used, the time, and whether it succeeded), used to block password guessing. To stop abuse, we keep a one-way, salted hash of the IP address used to sign up or sign in for up to 25 hours.',
  'Timesheet entries and their revision history are kept for as long as your organization subscribes. They are never overwritten or deleted during the subscription. When a free trial ends without a subscription, or a subscription ends, the workspace becomes read-only for 90 days so administrators can export their data. It is then permanently deleted, after at least 14 days\' email notice. Deleted data may remain in backups for up to 30 days. Signup records are deleted 7 days after signup if the email address is never verified, and otherwise 30 days after the workspace is set up or the signup is abandoned.',
  'We do not sell your personal information or share it for advertising. We share it only:',
  'With service providers that run the Service for us: Vercel (hosting), Neon (databases), Amazon Web Services (encrypted backups), Resend (email), Stripe (payments), Sentry (error monitoring), Upstash (abuse prevention), and Cloudflare (bot protection on the signup page). Our application data is stored in the United States.',
  'Within your organization: administrators and supervisors can see the time records their role permits.',
  'With integrations your organization chooses to connect, such as QuickBooks Online.',
  'When required by law, court order, or government audit.',
  '7. Cookies and Browser Storage',
  'CadenzPoint uses only the cookies and browser storage needed for the Service to work. We do not use advertising or analytics cookies.',
  'Sign-in cookies: HTTP-only cookies keep you signed in (for up to 24 hours) and protect against cross-site request forgery.',
  'Preferences: a cookie and your browser\'s local storage remember display choices, such as the menu layout, light or dark theme, your last-used payroll export format, and notices you\'ve dismissed. They contain no timesheet data.',
  'Unsaved timesheet edits: while you edit a timesheet, your unsaved changes are kept in your browser\'s session storage for that tab, so a page reload doesn\'t lose them. They stay on your device until you save, and your browser erases them when you close the tab.',
  'Signup protection: the signup page uses Cloudflare Turnstile, which processes your IP address and browser information to tell people from bots.',
];

describe('LA-4: Terms §7 and the Privacy Policy (A1, A2)', () => {
  it('Terms §7 is the A1 text; the Terms date is unchanged', () => {
    expect(terms).toContain(`7. Service Availability ${A1}`);
    expect(terms).toContain('Last updated: May 2026');
  });

  it('the Privacy Policy carries every A2 replacement; §2, §5, §6 and §8 stay; Last updated is November 2026', () => {
    for (const line of A2) expect(privacy, line).toContain(line);
    expect(privacy).toContain('Last updated: November 2026');
    expect(privacy).toContain('Account information:');
    expect(privacy).toContain('2. How We Use Your Information');
    expect(privacy).toContain('5. Security');
    expect(privacy).toContain('6. Your Rights');
    expect(privacy).toContain('8. Changes to This Policy');
  });

  it('no offline-support or IndexedDB claim remains on either page; the old bullets are gone', () => {
    for (const page of [terms, privacy]) {
      expect(page).not.toMatch(/offline support|IndexedDB|continue logging time/i);
    }
    expect(privacy).not.toMatch(/page access patterns|Cookies and Local Storage|retained indefinitely/);
  });

  it('TERMS_VERSION is the interim version', () => {
    expect(TERMS_VERSION).toBe('2026-11-10-interim');
  });
});
