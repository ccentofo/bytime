import { pgTable, uuid, varchar, text, timestamp, pgEnum } from 'drizzle-orm/pg-core';

export const tenantStatusEnum = pgEnum('tenant_status', [
  'provisioning', // DB being created/migrated/seeded
  'active',       // live and billable
  'suspended',    // access blocked (unpaid / admin action)
  'deleting',     // offboarding in progress
]);

export const tenants = pgTable('tenants', {
  id: uuid('id').defaultRandom().primaryKey(),
  slug: varchar('slug', { length: 63 }).notNull().unique(), // subdomain label
  name: varchar('name', { length: 200 }).notNull(),
  // Encrypted (AES-256-GCM via src/lib/encryption.ts) tenant Postgres connection string.
  dbUrlEncrypted: text('db_url_encrypted').notNull(),
  status: tenantStatusEnum('status').notNull().default('provisioning'),
  plan: varchar('plan', { length: 40 }).notNull().default('trial'),
  // Billing fields (populated by the billing blueprint; nullable for now).
  stripeCustomerId: varchar('stripe_customer_id', { length: 100 }),
  stripeSubscriptionId: varchar('stripe_subscription_id', { length: 100 }),
  subscriptionStatus: varchar('subscription_status', { length: 40 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
