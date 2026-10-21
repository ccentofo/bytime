import { pgTable, uuid, varchar, text, timestamp, pgEnum, unique } from 'drizzle-orm/pg-core';

export const tenantStatusEnum = pgEnum('tenant_status', [
  'provisioning', // DB being created/migrated/seeded
  'active',       // live and billable
  'suspended',    // access blocked (unpaid / admin action)
  'deleting',     // offboarding in progress
  'deleted',      // feature-plan-terms-compliance.md T7: tombstoned — db_url_encrypted nulled out
]);

export const tenants = pgTable('tenants', {
  id: uuid('id').defaultRandom().primaryKey(),
  slug: varchar('slug', { length: 63 }).notNull().unique(), // subdomain label
  name: varchar('name', { length: 200 }).notNull(),
  // Encrypted (AES-256-GCM via src/lib/encryption.ts) tenant Postgres connection string.
  // T7: nulled out by tenant:delete at tombstoning — a deleted tenant has no database left to
  // point at, and keeping a stale encrypted URL around serves no purpose once it's gone.
  dbUrlEncrypted: text('db_url_encrypted'),
  status: tenantStatusEnum('status').notNull().default('provisioning'),
  plan: varchar('plan', { length: 40 }).notNull().default('trial'),
  // Billing fields (populated by the billing blueprint; nullable for now).
  stripeCustomerId: varchar('stripe_customer_id', { length: 100 }),
  stripeSubscriptionId: varchar('stripe_subscription_id', { length: 100 }),
  subscriptionStatus: varchar('subscription_status', { length: 40 }),
  // feature-plan-terms-compliance.md T1 — lifecycle facts (all nullable; src/lib/tenant/lifecycle.ts
  // derives the access mode from these, never the other way around). Instants (timestamptz), never
  // CalendarDate strings — these are deadlines, not calendar days.
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  pastDueSince: timestamp('past_due_since', { withTimezone: true }),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  subscriptionEndedAt: timestamp('subscription_ended_at', { withTimezone: true }),
  deletionScheduledFor: timestamp('deletion_scheduled_for', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  // T7: the Neon project id, persisted at creation so deletion doesn't have to guess it.
  neonProjectId: varchar('neon_project_id', { length: 100 }),
  // T9 / R12: Terms acceptance, copied from the signups row at provisioning.
  termsVersion: varchar('terms_version', { length: 40 }),
  termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }),
  // T5: the Stripe event clock, so an out-of-order webhook delivery can't undo a newer one.
  lastStripeEventAt: timestamp('last_stripe_event_at', { withTimezone: true }),
  // D10 notice recipients: signupEmail is the fallback when there's no active admin; billingEmail
  // is kept current from Stripe (checkout.session.completed / customer.updated, T5).
  signupEmail: varchar('signup_email', { length: 255 }),
  billingEmail: varchar('billing_email', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * §3.3 / R14: proof of every lifecycle notice sent. Unique on (tenant_id, kind, scheduled_for) —
 * sendTenantNotice inserts this row FIRST; the unique constraint is what makes a cron retry (or a
 * second cron run the same day) a no-op instead of a duplicate email.
 */
export const tenantNotices = pgTable('tenant_notices', {
  id: uuid('id').defaultRandom().primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  kind: varchar('kind', { length: 60 }).notNull(),
  // The logical date/deadline this notice is FOR (e.g. the trial_ends_at instant, or the specific
  // reminder day) — not when it was actually sent. Part of the idempotency key.
  scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  recipients: text('recipients').array().notNull(),
  providerMessageId: varchar('provider_message_id', { length: 100 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique('tenant_notices_tenant_kind_scheduled_unique').on(table.tenantId, table.kind, table.scheduledFor),
]);

export const signups = pgTable('signups', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull(),
  companyName: varchar('company_name', { length: 200 }).notNull(),
  slug: varchar('slug', { length: 63 }).notNull(),
  verifyTokenHash: varchar('verify_token_hash', { length: 64 }).notNull(),
  // D8: the signer's browser IANA timezone (Intl.DateTimeFormat().resolvedOptions().timeZone),
  // captured at signup and written into the new tenant's workspace_settings at provisioning.
  // Nullable/additive: validated before use, falls back to workspace_settings' own column
  // default if missing or invalid.
  timezone: varchar('timezone', { length: 100 }),
  // T9 / R12: Terms acceptance, recorded at signup and copied to the tenant row at provisioning.
  termsVersion: varchar('terms_version', { length: 40 }),
  termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
