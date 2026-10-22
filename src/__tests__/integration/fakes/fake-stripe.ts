/**
 * In-memory Stripe for the lifecycle integration tests. Implements only what src/lib/billing/* and the webhook
 * call, with Stripe's observable behaviors that matter to the state machine: `resource_missing` errors,
 * `has_more` pagination, expanded payment intents, and a deleted-customer mode.
 */

export function resourceMissing(what: string): Error {
  return Object.assign(new Error(`No such ${what}`), { type: 'StripeInvalidRequestError', code: 'resource_missing' });
}

export interface FakeSub {
  id: string;
  customer: string;
  status: string;
  created: number; // unix seconds
  ended_at: number | null;
  current_period_end: number | null;
  priceId: string | null;
  latestInvoice?: string | null;
}

export interface FakeInvoice {
  id: string;
  customer: string;
  subscription: string | null;
  status: 'open' | 'paid' | 'void' | 'uncollectible';
  piStatus?: string;          // payment_intent.status
  piNextAction?: string;      // payment_intent.next_action.type
  hosted_invoice_url?: string;
}

const unix = (d: Date) => Math.floor(d.getTime() / 1000);

export const stripeState = {
  customers: new Map<string, { deleted: boolean; email?: string | null }>(),
  subs: new Map<string, FakeSub>(),
  invoices: new Map<string, FakeInvoice>(),
  /** What a customer-scoped list returns for a deleted customer. */
  deletedCustomerLists: 'resource_missing' as 'resource_missing' | 'empty',
  /** Forced errors by operation name ('subscriptions.list', 'subscriptions.cancel', 'invoices.voidInvoice', …). */
  failures: new Map<string, Error>(),
  /** Artificial latency by operation name (ms). */
  delays: new Map<string, number>(),
  /** Hook run at the start of an operation (e.g. to change state mid-flight). */
  hooks: new Map<string, () => void>(),
  /** Latency AFTER the response is computed (the caller holds a stale read meanwhile). One-shot per entry. */
  postDelays: new Map<string, number>(),
  pageSize: 100,
  /** Invoices whose void/mark-uncollectible "succeeds" but leaves them open (exercises the pending-void gate). */
  stuckOpen: new Set<string>(),
  calls: [] as string[],
  seq: 0,
  createdCustomers: 0,
  reset() {
    this.customers.clear();
    this.subs.clear();
    this.invoices.clear();
    this.deletedCustomerLists = 'resource_missing';
    this.failures.clear();
    this.delays.clear();
    this.hooks.clear();
    this.postDelays.clear();
    this.stuckOpen.clear();
    this.pageSize = 100;
    this.calls = [];
    this.createdCustomers = 0;
  },
  addCustomer(id?: string): string {
    const cid = id ?? `cus_${++stripeState.seq}_${Math.random().toString(36).slice(2, 8)}`;
    stripeState.customers.set(cid, { deleted: false });
    return cid;
  },
  addSub(customer: string, status: string, o: Partial<Omit<FakeSub, 'created' | 'ended_at' | 'current_period_end'>> & { created?: Date; endedAt?: Date | null; periodEnd?: Date | null } = {}) {
    const id = o.id ?? `sub_${++this.seq}_${Math.random().toString(36).slice(2, 8)}`;
    this.subs.set(id, {
      id, customer, status,
      created: unix(o.created ?? new Date(Date.now() - 30 * 86400_000)),
      ended_at: o.endedAt ? unix(o.endedAt) : null,
      current_period_end: o.periodEnd === null ? null : unix(o.periodEnd ?? new Date(Date.now() + 15 * 86400_000)),
      priceId: o.priceId ?? null,
      latestInvoice: o.latestInvoice ?? null,
    });
    return id;
  },
  setSub(id: string, patch: Partial<FakeSub>) {
    const s = this.subs.get(id);
    if (!s) throw new Error(`fake: no sub ${id}`);
    Object.assign(s, patch);
  },
  addInvoice(customer: string, subscription: string | null, o: Partial<FakeInvoice> = {}) {
    const id = o.id ?? `in_${++this.seq}_${Math.random().toString(36).slice(2, 8)}`;
    this.invoices.set(id, { id, customer, subscription, status: 'open', ...o });
    return id;
  },
};

async function op(name: string): Promise<void> {
  stripeState.calls.push(name);
  stripeState.hooks.get(name)?.();
  const delay = stripeState.delays.get(name);
  if (delay) await new Promise((r) => setTimeout(r, delay));
  const failure = stripeState.failures.get(name);
  if (failure) throw failure;
}

async function postDelay(name: string): Promise<void> {
  const ms = stripeState.postDelays.get(name);
  if (ms) {
    stripeState.postDelays.delete(name);
    await new Promise((r) => setTimeout(r, ms));
  }
}

function toStripeSub(s: FakeSub) {
  return {
    id: s.id, object: 'subscription', customer: s.customer, status: s.status, created: s.created,
    ended_at: s.ended_at, current_period_end: s.current_period_end,
    items: { data: [{ price: { id: s.priceId } }] },
  };
}

function toStripeInvoice(i: FakeInvoice) {
  return {
    id: i.id, object: 'invoice', customer: i.customer, subscription: i.subscription, status: i.status,
    hosted_invoice_url: i.hosted_invoice_url ?? null,
    payment_intent: i.piStatus ? { id: `pi_${i.id}`, status: i.piStatus, next_action: i.piNextAction ? { type: i.piNextAction } : null } : null,
  };
}

function customerListGuard(customer: string) {
  const c = stripeState.customers.get(customer);
  if (!c) throw resourceMissing(`customer: '${customer}'`);
  if (c.deleted && stripeState.deletedCustomerLists === 'resource_missing') throw resourceMissing(`customer: '${customer}'`);
}

export const fakeStripe = {
  subscriptions: {
    async list(params: { customer: string; status?: string; limit?: number }) {
      await op('subscriptions.list');
      customerListGuard(params.customer);
      // Like Stripe: without status:'all', canceled subscriptions are omitted.
      const data = [...stripeState.subs.values()]
        .filter((s) => s.customer === params.customer && (params.status === 'all' || s.status !== 'canceled'))
        .map(toStripeSub);
      await postDelay('subscriptions.list');
      return { object: 'list', data, has_more: false };
    },
    async retrieve(id: string, params?: { expand?: string[] }) {
      await op('subscriptions.retrieve');
      const s = stripeState.subs.get(id);
      if (!s) throw resourceMissing(`subscription: '${id}'`);
      const out: Record<string, unknown> = toStripeSub(s);
      if (params && typeof params === 'object' && 'expand' in params && params.expand?.includes('latest_invoice')) {
        const inv = s.latestInvoice ? stripeState.invoices.get(s.latestInvoice) : null;
        out.latest_invoice = inv ? toStripeInvoice(inv) : null;
      }
      return out;
    },
    async cancel(id: string) {
      await op('subscriptions.cancel');
      const s = stripeState.subs.get(id);
      if (!s) throw resourceMissing(`subscription: '${id}'`);
      if (s.status === 'canceled') throw Object.assign(new Error('This subscription has already been canceled.'), { code: 'subscription_canceled' });
      s.status = 'canceled';
      s.ended_at = unix(new Date());
      return toStripeSub(s);
    },
  },
  invoices: {
    async list(params: { customer: string; status?: string; limit?: number; starting_after?: string; expand?: string[] }) {
      await op('invoices.list');
      customerListGuard(params.customer);
      // Like Stripe: newest first (ids sort descending here), so the OLDEST open invoice is on the last page.
      const all = [...stripeState.invoices.values()]
        .filter((i) => i.customer === params.customer && (!params.status || i.status === params.status))
        .sort((a, b) => b.id.localeCompare(a.id));
      const start = params.starting_after ? all.findIndex((i) => i.id === params.starting_after) + 1 : 0;
      const size = Math.min(params.limit ?? 10, stripeState.pageSize);
      const page = all.slice(start, start + size);
      // Like Stripe: payment_intent is only an object when expanded; otherwise it's an id string.
      const expanded = params.expand?.includes('data.payment_intent') ?? false;
      const data = page.map((i) => {
        const inv = toStripeInvoice(i);
        return expanded ? inv : { ...inv, payment_intent: inv.payment_intent ? inv.payment_intent.id : null };
      });
      return { object: 'list', data, has_more: start + size < all.length };
    },
    async retrieve(id: string) {
      await op('invoices.retrieve');
      const i = stripeState.invoices.get(id);
      if (!i) throw resourceMissing(`invoice: '${id}'`);
      return toStripeInvoice(i);
    },
    async voidInvoice(id: string) {
      await op('invoices.voidInvoice');
      const i = stripeState.invoices.get(id);
      if (!i) throw resourceMissing(`invoice: '${id}'`);
      if (!stripeState.stuckOpen.has(id)) i.status = 'void';
      return toStripeInvoice(i);
    },
    async markUncollectible(id: string) {
      await op('invoices.markUncollectible');
      const i = stripeState.invoices.get(id);
      if (!i) throw resourceMissing(`invoice: '${id}'`);
      if (!stripeState.stuckOpen.has(id)) i.status = 'uncollectible';
      return toStripeInvoice(i);
    },
  },
  customers: {
    async retrieve(id: string) {
      await op('customers.retrieve');
      const c = stripeState.customers.get(id);
      if (!c) throw resourceMissing(`customer: '${id}'`);
      return c.deleted ? { id, object: 'customer', deleted: true } : { id, object: 'customer', email: c.email ?? null };
    },
    async create(_params: unknown, opts?: { idempotencyKey?: string }) {
      await op('customers.create');
      // Stripe idempotency: the same key returns the same customer.
      const key = opts?.idempotencyKey ?? `nokey-${Math.random()}`;
      const existing = idempotentCustomers.get(key);
      if (existing) return { id: existing, object: 'customer' };
      stripeState.createdCustomers++;
      const id = stripeState.addCustomer();
      idempotentCustomers.set(key, id);
      return { id, object: 'customer' };
    },
  },
  checkout: {
    sessions: {
      async create() {
        await op('checkout.sessions.create');
        return { id: 'cs_test', url: 'https://checkout.stripe.test/session' };
      },
    },
  },
  billingPortal: {
    sessions: {
      async create() {
        await op('billingPortal.sessions.create');
        return { id: 'bps_test', url: 'https://billing.stripe.test/portal' };
      },
    },
  },
  webhooks: {
    /** Signature verification is Stripe's; the tests pass the event JSON as the body. */
    constructEvent(raw: string, sig: string) {
      if (sig !== 'valid') throw new Error('bad signature');
      return JSON.parse(raw);
    },
  },
};

const idempotentCustomers = new Map<string, string>();

export const stripeModule = { stripe: fakeStripe };
