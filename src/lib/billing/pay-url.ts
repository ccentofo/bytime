/**
 * Which invoice the Pay button opens (feature-plan-per-user-billing.md §6.7, §6.10). Pure, and NOT in the
 * `'use server'` actions file (which may only export async functions). Never simply `latest_invoice`, which can be a
 * newer proration invoice that isn't due yet. Order:
 *   1. the earliest-created open invoice with no due date (on a charge-automatically subscription that's every
 *      invoice; the earliest is the one driving the dunning);
 *   2. else the open invoice with the earliest due date on or before now (the one the grace counts from);
 *   3. else the earliest-created open invoice.
 */
export interface PayInvoiceCandidate {
  /** Epoch seconds (Stripe's `created`). */
  created: number;
  dueDate: Date | null;
  hostedUrl: string | null;
}

export function choosePayInvoice<T extends PayInvoiceCandidate>(invoices: readonly T[], now: Date): T | null {
  if (invoices.length === 0) return null;
  const byCreated = (a: T, b: T) => a.created - b.created;
  const noDue = invoices.filter((i) => i.dueDate === null).sort(byCreated);
  if (noDue.length > 0) return noDue[0];
  const overdue = invoices.filter((i) => i.dueDate !== null && i.dueDate.getTime() <= now.getTime())
    .sort((a, b) => (a.dueDate!.getTime() - b.dueDate!.getTime()) || byCreated(a, b));
  if (overdue.length > 0) return overdue[0];
  return [...invoices].sort(byCreated)[0];
}
