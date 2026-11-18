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
  // feature-plan-per-user-billing.md §10.1: one item (id, quantity, price interval), the period start, the cancel
  // flag, the collection method, an attached schedule, and extra items (S31).
  itemId: string;
  quantity: number;
  interval: 'month' | 'year';
  current_period_start: number | null;
  cancel_at_period_end: boolean;
  collection_method: string;
  schedule: string | null;
  extraItems: Array<{ id: string; priceId: string; quantity: number }>;
}

export interface FakeInvoice {
  id: string;
  customer: string;
  subscription: string | null;
  status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
  piStatus?: string;          // payment_intent.status
  piNextAction?: string;      // payment_intent.next_action.type
  hosted_invoice_url?: string;
  // feature-plan-per-user-billing.md §10.1
  due_date?: number | null;
  billing_reason?: string | null;
  created?: number;
  metadata?: Record<string, string>;
  attempt_count?: number;
  auto_advance?: boolean;
}

export interface FakeSchedule {
  id: string;
  end_behavior: string;
  current_phase: { start_date: number; end_date: number } | null;
  phases: Array<{ start_date: number; end_date: number; items: Array<{ price: string; quantity?: number }> }>;
}

const unix = (d: Date) => Math.floor(d.getTime() / 1000);

export const stripeState = {
  customers: new Map<string, { deleted: boolean; email?: string | null; metadata?: Record<string, string> }>(),
  /** feature-plan-control-plane-disaster.md §6.10: Checkout Sessions for `checkout.sessions.list` (status, created). */
  sessions: [] as Array<{ id: string; status: 'complete' | 'expired' | 'open'; created: number; customer: string | null; metadata: Record<string, string> | null }>,
  /** Every checkout.sessions.list params object. */
  sessionListParams: [] as Array<Record<string, unknown>>,
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
  // feature-plan-per-user-billing.md §10.1 additions.
  schedules: new Map<string, FakeSchedule>(),
  /** Every subscriptions.update: id, params, options (idempotency key included). */
  updates: [] as Array<{ id: string; params: Record<string, unknown>; options: Record<string, unknown> | undefined }>,
  /** Every checkout.sessions.create params object. */
  checkoutParams: [] as Array<Record<string, unknown>>,
  /** Invoices sent with invoices.sendInvoice, in order. */
  sentInvoices: [] as string[],
  /** Operations that APPLY, then throw (a lost response). One-shot per entry. */
  failAfterApply: new Set<string>(),
  /** A promise an operation awaits before applying (the test resolves it). One-shot per entry. */
  blockers: new Map<string, Promise<void>>(),
  /** The next subscriptions.update moves the period forward one interval before responding (a renewal race). */
  renewOnNextUpdate: false,
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
    this.schedules.clear();
    this.updates = [];
    this.checkoutParams = [];
    this.sessions = [];
    this.sessionListParams = [];
    this.sentInvoices = [];
    this.failAfterApply.clear();
    this.blockers.clear();
    this.renewOnNextUpdate = false;
  },
  addCustomer(id?: string): string {
    const cid = id ?? `cus_${++stripeState.seq}_${Math.random().toString(36).slice(2, 8)}`;
    stripeState.customers.set(cid, { deleted: false });
    return cid;
  },
  addSub(customer: string, status: string, o: Partial<Omit<FakeSub, 'created' | 'ended_at' | 'current_period_end' | 'current_period_start'>> & { created?: Date; endedAt?: Date | null; periodEnd?: Date | null; periodStart?: Date | null } = {}) {
    const id = o.id ?? `sub_${++this.seq}_${Math.random().toString(36).slice(2, 8)}`;
    const periodEnd = o.periodEnd === null ? null : unix(o.periodEnd ?? new Date(Date.now() + 15 * 86400_000));
    const interval = o.interval ?? 'month';
    this.subs.set(id, {
      id, customer, status,
      created: unix(o.created ?? new Date(Date.now() - 30 * 86400_000)),
      ended_at: o.endedAt ? unix(o.endedAt) : null,
      current_period_end: periodEnd,
      priceId: o.priceId ?? null,
      latestInvoice: o.latestInvoice ?? null,
      itemId: o.itemId ?? `si_${id}`,
      quantity: o.quantity ?? 1,
      interval,
      current_period_start: o.periodStart === null ? null
        : o.periodStart ? unix(o.periodStart)
        : periodEnd !== null ? periodEnd - (interval === 'year' ? 365 : 30) * 86400 : null,
      cancel_at_period_end: o.cancel_at_period_end ?? false,
      collection_method: o.collection_method ?? 'charge_automatically',
      schedule: o.schedule ?? null,
      extraItems: o.extraItems ?? [],
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
  const blocker = stripeState.blockers.get(name);
  if (blocker) {
    stripeState.blockers.delete(name);
    await blocker;
  }
  const delay = stripeState.delays.get(name);
  if (delay) await new Promise((r) => setTimeout(r, delay));
  const failure = stripeState.failures.get(name);
  if (failure) throw failure;
}

/** After an operation applied: throw if it is marked fail-after-apply (one shot). The SDK's API error shape. */
function afterApply(name: string): void {
  if (stripeState.failAfterApply.delete(name)) {
    throw Object.assign(new Error(`fake: ${name} applied, then the response was lost`), { type: 'StripeAPIError', code: undefined });
  }
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
    ended_at: s.ended_at, current_period_end: s.current_period_end, current_period_start: s.current_period_start,
    cancel_at_period_end: s.cancel_at_period_end, collection_method: s.collection_method, schedule: s.schedule,
    items: { data: [
      { id: s.itemId, quantity: s.quantity, price: { id: s.priceId, recurring: { interval: s.interval } } },
      ...s.extraItems.map((x) => ({ id: x.id, quantity: x.quantity, price: { id: x.priceId, recurring: { interval: s.interval } } })),
    ] },
  };
}

function toStripeInvoice(i: FakeInvoice) {
  return {
    id: i.id, object: 'invoice', customer: i.customer, subscription: i.subscription, status: i.status,
    hosted_invoice_url: i.hosted_invoice_url ?? null,
    payment_intent: i.piStatus ? { id: `pi_${i.id}`, status: i.piStatus, next_action: i.piNextAction ? { type: i.piNextAction } : null } : null,
    due_date: i.due_date ?? null,
    billing_reason: i.billing_reason ?? null,
    created: i.created ?? 0,
    metadata: i.metadata ?? {},
    attempt_count: i.attempt_count ?? 0,
    auto_advance: i.auto_advance ?? false,
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
    /** feature-plan-per-user-billing.md §10.1: the quantity update (with failAfterApply, blockers, renewOnNextUpdate). */
    async update(id: string, params: { items?: Array<{ id?: string; quantity?: number }>; [k: string]: unknown }, options?: Record<string, unknown>) {
      await op('subscriptions.update');
      const s = stripeState.subs.get(id);
      if (!s) throw resourceMissing(`subscription: '${id}'`);
      if (s.status === 'canceled' || s.status === 'incomplete') {
        throw Object.assign(new Error(`fake: a ${s.status} subscription can't be updated`), { type: 'StripeInvalidRequestError', code: 'resource_invalid' });
      }
      stripeState.updates.push({ id, params: params as Record<string, unknown>, options });
      if (stripeState.renewOnNextUpdate) {
        stripeState.renewOnNextUpdate = false;
        const len = (s.interval === 'year' ? 365 : 30) * 86400;
        s.current_period_start = s.current_period_end;
        s.current_period_end = (s.current_period_end ?? unix(new Date())) + len;
      }
      for (const it of params.items ?? []) {
        if (it.id === s.itemId) { if (it.quantity !== undefined) s.quantity = it.quantity; }
        else s.extraItems.push({ id: `si_new_${++stripeState.seq}`, priceId: 'price_unknown', quantity: it.quantity ?? 1 });
      }
      afterApply('subscriptions.update');
      return toStripeSub(s);
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
    async list(params: { customer?: string; subscription?: string; status?: string; limit?: number; starting_after?: string; expand?: string[] }) {
      await op('invoices.list');
      if (params.customer !== undefined) customerListGuard(params.customer);
      // Like Stripe: newest first (by created, then ids descending), so the OLDEST open invoice is on the last page.
      const all = [...stripeState.invoices.values()]
        .filter((i) => (params.customer === undefined || i.customer === params.customer)
          && (params.subscription === undefined || i.subscription === params.subscription)
          && (!params.status || i.status === params.status))
        .sort((a, b) => ((b.created ?? 0) - (a.created ?? 0)) || b.id.localeCompare(a.id));
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
    async finalizeInvoice(id: string, params?: { auto_advance?: boolean }) {
      await op('invoices.finalizeInvoice');
      const i = stripeState.invoices.get(id);
      if (!i) throw resourceMissing(`invoice: '${id}'`);
      if (i.status === 'draft') i.status = 'open';
      if (params?.auto_advance !== undefined) i.auto_advance = params.auto_advance;
      afterApply('invoices.finalizeInvoice');
      return toStripeInvoice(i);
    },
    async sendInvoice(id: string) {
      await op('invoices.sendInvoice');
      const i = stripeState.invoices.get(id);
      if (!i) throw resourceMissing(`invoice: '${id}'`);
      stripeState.sentInvoices.push(id);
      afterApply('invoices.sendInvoice');
      return toStripeInvoice(i);
    },
    async update(id: string, params: { metadata?: Record<string, string> }) {
      await op('invoices.update');
      const i = stripeState.invoices.get(id);
      if (!i) throw resourceMissing(`invoice: '${id}'`);
      if (params.metadata) i.metadata = { ...(i.metadata ?? {}), ...params.metadata };
      afterApply('invoices.update');
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
      return c.deleted ? { id, object: 'customer', deleted: true } : { id, object: 'customer', email: c.email ?? null, metadata: c.metadata ?? {} };
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
      async create(params: Record<string, unknown>) {
        await op('checkout.sessions.create');
        stripeState.checkoutParams.push(params);
        return { id: 'cs_test', url: 'https://checkout.stripe.test/session' };
      },
      /** Newest first, `status` and `created.gte` filters, cursor pages (`starting_after`, `has_more`), as Stripe. */
      async list(params: { status?: string; created?: { gte?: number }; limit?: number; starting_after?: string } = {}) {
        await op('checkout.sessions.list');
        stripeState.sessionListParams.push(params as Record<string, unknown>);
        const all = [...stripeState.sessions].sort((a, b) => b.created - a.created || b.id.localeCompare(a.id))
          .filter((x) => (!params.status || x.status === params.status) && (params.created?.gte === undefined || x.created >= params.created.gte));
        const start = params.starting_after ? all.findIndex((x) => x.id === params.starting_after) + 1 : 0;
        const limit = Math.min(params.limit ?? 10, stripeState.pageSize);
        const page = all.slice(start, start + limit);
        return { object: 'list', data: page.map((x) => ({ object: 'checkout.session', ...x })), has_more: start + limit < all.length };
      },
    },
  },
  subscriptionSchedules: {
    async retrieve(id: string) {
      await op('subscriptionSchedules.retrieve');
      const sch = stripeState.schedules.get(id);
      if (!sch) throw resourceMissing(`subscription_schedule: '${id}'`);
      return { object: 'subscription_schedule', ...sch };
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
