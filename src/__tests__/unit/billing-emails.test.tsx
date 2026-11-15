import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('server-only', () => ({}));

import { InvoiceOverdueEmail } from '@/lib/email/templates/invoice-overdue';
import { BankPaymentFailedEmail } from '@/lib/email/templates/bank-payment-failed';
import { statedSuspensionDate } from '@/lib/tenant/notices';
import { addDays } from '@/lib/tenant/lifecycle';

/** U9 (feature-plan-per-user-billing.md §6.7 Q4, §6.9 Q6): the two new notices' text, and the clamped stated date. */
const text = (el: React.ReactElement) => renderToStaticMarkup(el)
  .replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const appUrl = 'https://acme.cadenzpoint.test';

describe('U9: billing emails', () => {
  it('InvoiceOverdueEmail: the Q4 title, body and "Pay the invoice" button to Billing', () => {
    const html = renderToStaticMarkup(<InvoiceOverdueEmail tenantName="Acme" suspensionDateFormatted="December 3, 2026" appUrl={appUrl} />);
    const t = text(<InvoiceOverdueEmail tenantName="Acme" suspensionDateFormatted="December 3, 2026" appUrl={appUrl} />);
    expect(t).toContain('Invoice overdue for Acme');
    expect(t).toContain("The invoice for Acme is past due. Your workspace is still fully active. If payment isn't received, it will be suspended on or after December 3, 2026, after a further reminder.");
    expect(html).toMatch(/<strong>Acme<\/strong> is past due/);
    expect(html).toMatch(/<strong>December 3, 2026<\/strong>/);
    expect(html).toMatch(/href="https:\/\/acme\.cadenzpoint\.test\/settings\/billing"[^>]*>[\s\S]*?Pay the invoice/);
    expect(t).not.toContain("couldn't process");
  });

  it('BankPaymentFailedEmail: the Q6 title, body and "Go to Billing" button', () => {
    const html = renderToStaticMarkup(<BankPaymentFailedEmail tenantName="Acme" appUrl={appUrl} />);
    const t = text(<BankPaymentFailedEmail tenantName="Acme" appUrl={appUrl} />);
    expect(t).toContain('Payment not received for Acme');
    expect(t).toContain("The latest payment for Acme didn't go through. Please update your payment method in Billing, or contact support@cadenzpoint.com.");
    expect(html).toMatch(/<strong>Acme<\/strong> didn/);
    expect(html).toMatch(/href="https:\/\/acme\.cadenzpoint\.test\/settings\/billing"[^>]*>[\s\S]*?Go to Billing/);
  });

  it('the stated suspension date is max(P + 15 days, now + 3 days): a back-dated due date never states a past date', () => {
    const now = new Date('2026-11-15T12:00:00Z');
    expect(statedSuspensionDate(addDays(now, -20), now).getTime()).toBe(addDays(now, 3).getTime()); // P + 15 is in the past
    expect(statedSuspensionDate(addDays(now, -13), now).getTime()).toBe(addDays(now, 3).getTime()); // P + 15 = now + 2
    expect(statedSuspensionDate(now, now).getTime()).toBe(addDays(now, 15).getTime());              // a fresh failure
  });
});
