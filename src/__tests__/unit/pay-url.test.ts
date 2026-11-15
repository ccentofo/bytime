import { describe, it, expect } from 'vitest';
import { choosePayInvoice } from '@/lib/billing/pay-url';

/** U13 (feature-plan-per-user-billing.md §6.7, §6.10): which invoice the Pay button opens. */
const NOW = new Date('2026-11-15T12:00:00Z');
const s = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const inv = (id: string, created: string, due: string | null) => ({ id, created: s(created), dueDate: due ? new Date(due) : null, hostedUrl: `https://pay/${id}` });

describe('U13: choosePayInvoice', () => {
  it('null when there are no invoices', () => {
    expect(choosePayInvoice([], NOW)).toBeNull();
  });

  it('1. the earliest-created open invoice with no due date comes first (two → the older), even over an overdue one', () => {
    const invoices = [
      inv('overdue', '2026-09-01', '2026-10-01'),
      inv('nodue-new', '2026-11-01', null),
      inv('nodue-old', '2026-10-15', null),
    ];
    expect(choosePayInvoice(invoices, NOW)?.id).toBe('nodue-old');
  });

  it('2. else the overdue invoice with the earliest due date (not latest_invoice, not the newest)', () => {
    const invoices = [
      inv('newer-not-due', '2026-11-10', '2026-12-10'),
      inv('overdue-late', '2026-10-01', '2026-11-12'),
      inv('overdue-early', '2026-10-05', '2026-11-01'),
    ];
    expect(choosePayInvoice(invoices, NOW)?.id).toBe('overdue-early');
  });

  it('a due date exactly now counts as overdue', () => {
    expect(choosePayInvoice([inv('later', '2026-11-01', '2026-12-01'), inv('now', '2026-11-02', NOW.toISOString())], NOW)?.id).toBe('now');
  });

  it('3. else the earliest-created open invoice', () => {
    expect(choosePayInvoice([inv('b', '2026-11-10', '2026-12-10'), inv('a', '2026-11-01', '2026-12-20')], NOW)?.id).toBe('a');
  });
});
