import 'server-only';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Stripe = require('stripe').default ?? require('stripe');

// Lazily construct the Stripe client. Importing this module must NOT throw at build time —
// Next's page-data collection imports the webhook route (which imports this), and the build
// env has no STRIPE_SECRET_KEY. The key is only required at first actual use.
let _stripe: import('stripe').default | undefined;

function getStripe(): import('stripe').default {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set. See .env.example.');
  // apiVersion pinned to Stripe SDK v17's default. Verify after install with:
  //   node -e "const S = require('stripe'); console.log(S.LATEST_API_VERSION)"
  const client: import('stripe').default = new Stripe(key, { apiVersion: '2025-02-24.acacia' as any });
  _stripe = client;
  return client;
}

// Proxy preserves the `stripe.checkout.sessions.create(...)` call style at every call site
// while deferring construction (and the key check) to first property access.
export const stripe: import('stripe').default = new Proxy({} as import('stripe').default, {
  get(_target, prop) {
    return (getStripe() as any)[prop];
  },
});
